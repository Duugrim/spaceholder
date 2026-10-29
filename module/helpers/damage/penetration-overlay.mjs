/**
 * Penetration overlay — while a shot goes through the layers in its way, a semi-transparent card appears over
 * every token (or wall) it meets, in flight order: the target and the parts of its body that were hit, the
 * projectiles' lanes running side by side from the top of the card down to the parts they hit, the energy stream
 * filling as the bullets travel down them. One card per target, however many projectiles hit it. A few seconds later the card fades. It is the quick look; the penetration window
 * (`penetration-view-app.mjs`, the button of the shot in chat) is where it all is collected.
 *
 * The shooter's client shows it when the damage is resolved and sends the shot's track (the rays merged,
 * `penetration-shot.mjs`) to the other clients over the socket (the same channel as the shot trails, and under the
 * same "auto render" switch); a client can turn it off for itself in the settings. Foundry is only touched inside the methods, so the layout function runs in
 * plain Node (`node module/helpers/damage/penetration-overlay.test.mjs`).
 */

import { sanitizePenetrationTrack, trackStreams } from './penetration-track.mjs';
import { buildPenetrationView, streamWidth } from './penetration-view-model.mjs';
import { PenetrationPlayback, bindImageFallbacks } from './penetration-view-animation.mjs';

export const PENETRATION_OVERLAY_SOCKET_TYPE = 'spaceholder.penetrationOverlay';
export const PENETRATION_OVERLAY_SETTING_KEY = 'penetrationOverlay';
const SETTINGS_SCOPE = 'spaceholder';
const CARD_TEMPLATE = 'systems/spaceholder/templates/damage/penetration-overlay-card.hbs';
const CONTAINER_ID = 'spaceholder-penetration-overlay';

/** The card of the next target appears this long after the previous one: the projectile is on its way. */
const STAGGER_MS = 380;
/** … and this long when the next target is hit by a projectile of its own (a blast, the pellets of a volley). */
const PARALLEL_STAGGER_MS = 140;
/** The animation inside a card runs this much faster than in the window. */
const PLAYBACK_SPEED = 1.8;
/** A card stays this long after its animation, then fades for {@link FADE_MS}. */
const LINGER_MS = 4500;
const FADE_MS = 700;
/** Space between a card and what it is anchored to / the edge of the screen. */
const MARGIN_PX = 8;
const EDGE_PX = 6;

/* -------------------------------------------- */
/*  Layout (pure)                               */
/* -------------------------------------------- */

function overlapArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where to put a card of `size` next to an anchor on the screen: above it, else below, to the right, to the left
 * — the first place that is inside the screen and clear of the cards already there; when there is none, the one
 * with the least overlap.
 *
 * @param {Object} args
 * @param {{left: number, top: number, right: number, bottom: number}} args.anchor the token (or a point) on the screen
 * @param {{width: number, height: number}} args.size the card
 * @param {{width: number, height: number}} args.viewport
 * @param {Array<{left: number, top: number, right: number, bottom: number}>} [args.taken] cards already placed
 * @returns {{ left: number, top: number }}
 */
export function placeCard({ anchor, size, viewport, taken = [] }) {
  const { width: w, height: h } = size;
  const cx = (anchor.left + anchor.right) / 2;
  const cy = (anchor.top + anchor.bottom) / 2;
  const candidates = [
    { left: cx - w / 2, top: anchor.top - h - MARGIN_PX },
    { left: cx - w / 2, top: anchor.bottom + MARGIN_PX },
    { left: anchor.right + MARGIN_PX, top: cy - h / 2 },
    { left: anchor.left - w - MARGIN_PX, top: cy - h / 2 },
  ].map((c) => {
    const left = Math.max(EDGE_PX, Math.min(viewport.width - w - EDGE_PX, c.left));
    const top = Math.max(EDGE_PX, Math.min(viewport.height - h - EDGE_PX, c.top));
    const rect = { left, top, right: left + w, bottom: top + h };
    const moved = Math.abs(left - c.left) + Math.abs(top - c.top);
    const overlap = taken.reduce((sum, other) => sum + overlapArea(rect, other), 0) + overlapArea(rect, anchor) * 0.5;
    return { left, top, overlap, moved };
  });
  const free = candidates.find((c) => c.overlap === 0 && c.moved < 1);
  const best = free ?? candidates.reduce((a, b) => (b.overlap + b.moved * 20 < a.overlap + a.moved * 20 ? b : a));
  return { left: best.left, top: best.top };
}

/** What a card belongs to: the token it hangs over, else the place it is at (a newer card replaces the older one). */
export function overlayKey(group) {
  if (group?.tokenId) return `token:${group.tokenId}`;
  if (group?.at) return `at:${Math.round(group.at.x)},${Math.round(group.at.y)}`;
  return `group:${group?.key ?? ''}`;
}

/**
 * The track of a shot cut into cards: one per target (or per place, for a wall), in the order the shot reached them.
 * Each card is a track of its own — the blocks of the target (the parts of its body that were hit) and the streams
 * that meet them, numbered from the first of the card — so its lanes are the target's projectiles only and go down
 * to its parts. A block with no layers (nothing to show) has no card.
 * @param {object|null} track the penetration track of a shot (`mergeShot().track`)
 * @returns {Array<{ key: string, anchor: object, track: object }>} `anchor` the first block of the card: it says
 *   where the card hangs (`tokenId`, `at`)
 */
export function cardTracks(track) {
  const { streams, blockStreams } = trackStreams(track);
  const cards = new Map();
  (Array.isArray(track?.groups) ? track.groups : []).forEach((group, g) => {
    if (!group.stages?.length && !group.pending) return;
    const key = overlayKey({ ...group, key: `g${g}` });
    if (!cards.has(key)) cards.set(key, { key, blocks: [] });
    cards.get(key).blocks.push({ group, streams: blockStreams[g] ?? [] });
  });
  return [...cards.values()].map(({ key, blocks }) => {
    const order = [];
    const groups = blocks.map(({ group, streams: own }) => ({
      ...group,
      streams: own.map((k) => {
        const at = order.indexOf(k);
        return at >= 0 ? at : order.push(k) - 1;
      }),
    }));
    return { key, anchor: blocks[0].group, track: { ...track, streams: order.map((k) => streams[k]), groups } };
  });
}

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

/** Register the overlay setting (call from `init`). */
export function registerPenetrationOverlaySettings() {
  game.settings.register(SETTINGS_SCOPE, PENETRATION_OVERLAY_SETTING_KEY, {
    name: 'SPACEHOLDER.Settings.PenetrationOverlay.Name',
    hint: 'SPACEHOLDER.Settings.PenetrationOverlay.Hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true,
    onChange: (enabled) => {
      if (!enabled) game.spaceholder?.penetrationOverlay?.clear();
    },
  });
}

/* -------------------------------------------- */
/*  The overlay                                 */
/* -------------------------------------------- */

export class PenetrationOverlay {
  /** @type {HTMLElement|null} */
  #container = null;

  /** @type {Map<string, {key: string, el: HTMLElement, group: object, anchor: object|null, placed?: object, playback: PenetrationPlayback|null, timers: number[]}>} `group`: the first block of the card, it says where the card hangs */
  #cards = new Map();

  /** Timers of the cards still waiting for their turn to appear. */
  #queued = new Set();

  /** Bumped by `clear()`: a card whose spawn began before it is not put up. */
  #epoch = 0;

  #socketBound = false;

  #repositioning = false;

  /** Listen for the other clients' shots and keep the cards on their tokens while the map moves. */
  install() {
    if (this.#socketBound) return;
    this.#socketBound = true;
    try {
      game.socket.on(this.#socketName(), (message) => this.#onSocket(message));
    } catch (error) {
      console.error('SpaceHolder | PenetrationOverlay: socket unavailable', error);
    }
    Hooks.on('canvasPan', () => this.#scheduleReposition());
    Hooks.on('canvasTearDown', () => this.clear());
  }

  #socketName() {
    try {
      return `system.${game.system.id}`;
    } catch (_) {
      return 'system.spaceholder';
    }
  }

  get enabled() {
    try {
      return !!game.settings.get(SETTINGS_SCOPE, PENETRATION_OVERLAY_SETTING_KEY);
    } catch (_) {
      return true;
    }
  }

  /**
   * Show a shot, and send it to the other clients.
   * @param {object|null} track the penetration track of the shot (`mergeShot().track`; `null`: nothing to show)
   * @param {{ broadcast?: boolean }} [options] `broadcast`: the other clients see it too (the "auto render" switch)
   */
  showShot(track, { broadcast = false } = {}) {
    if (!track) return;
    void this.show(track);
    if (broadcast) this.#broadcast(track);
  }

  #broadcast(track) {
    try {
      game.socket.emit(this.#socketName(), { type: PENETRATION_OVERLAY_SOCKET_TYPE, track, sceneId: canvas?.scene?.id ?? null });
    } catch (error) {
      console.warn('SpaceHolder | PenetrationOverlay: could not send a track', error);
    }
  }

  #onSocket(message) {
    try {
      if (message?.type !== PENETRATION_OVERLAY_SOCKET_TYPE) return;
      if (message.sceneId && message.sceneId !== canvas?.scene?.id) return;
      const track = sanitizePenetrationTrack(message.track);
      if (track) void this.show(track);
    } catch (error) {
      console.error('SpaceHolder | PenetrationOverlay: failed to show a track from the socket', error);
    }
  }

  /**
   * Show one track: a card per target, one after another (a blast reaches them nearly at once).
   * @param {object} track penetration track
   */
  async show(track) {
    if (!this.enabled || !canvas?.ready || !track) return;
    let delay = 0;
    for (const card of cardTracks(track)) {
      const timer = setTimeout(() => {
        this.#queued.delete(timer);
        void this.#spawn(card);
      }, delay);
      this.#queued.add(timer);
      delay += card.anchor.parallel ? PARALLEL_STAGGER_MS : STAGGER_MS;
    }
  }

  /** Remove every card at once, and the ones still waiting to appear. */
  clear() {
    this.#epoch += 1;
    for (const timer of this.#queued) clearTimeout(timer);
    this.#queued.clear();
    for (const card of [...this.#cards.values()]) this.#remove(card);
  }

  #getContainer() {
    if (!this.#container?.isConnected) {
      this.#container = document.createElement('div');
      this.#container.id = CONTAINER_ID;
      this.#container.className = 'spaceholder-penetration-overlay';
      document.body.append(this.#container);
    }
    return this.#container;
  }

  async #spawn({ key, anchor: group, track }) {
    if (!this.enabled || !canvas?.ready) return;
    // A card that cannot be put anywhere on the scene (the token is gone, no place was recorded) is not shown.
    if (!this.#anchorOf(group)) return;
    const epoch = this.#epoch;

    const { groups, lanes } = buildPenetrationView(track);
    const cardStreamWidth = streamWidth(lanes, { base: 40, perLane: 10, max: 120 });
    const html = await foundry.applications.handlebars.renderTemplate(CARD_TEMPLATE, { groups, cardStreamWidth });
    // Cleared while the card was rendered (the scene went away): do not put it up.
    if (epoch !== this.#epoch) return;
    // Replace the target's card only now, with nothing awaited until the new one is stored: two spawns for
    // one token (auto fire) would otherwise both see no card and leave one on the page for good.
    const old = this.#cards.get(key);
    if (old) this.#remove(old);
    const el = document.createElement('div');
    el.className = 'spaceholder-penetration-overlay__card';
    el.innerHTML = html;
    const root = el.querySelector('.spaceholder-penetration');
    this.#getContainer().append(el);
    bindImageFallbacks(el);

    const card = { key, el, group, anchor: this.#anchorOf(group), playback: null, timers: [] };
    this.#cards.set(key, card);
    this.#place(card);
    requestAnimationFrame(() => el.classList.add('is-visible'));

    if (!root) return;
    card.playback = new PenetrationPlayback(root, { speed: PLAYBACK_SPEED, follow: false });
    const result = await card.playback.play();
    if (result === 'cancelled' || this.#cards.get(key) !== card) return;
    card.timers.push(setTimeout(() => this.#fade(card), LINGER_MS));
  }

  /** The place the card hangs over, in canvas coordinates: the token, or the point of the hit. */
  #anchorOf(group) {
    const token = group.tokenId ? canvas.tokens?.get?.(group.tokenId) : null;
    if (token?.bounds) {
      const { x, y, width, height } = token.bounds;
      return { x, y, width, height };
    }
    return group.at ? { x: group.at.x, y: group.at.y, width: 0, height: 0 } : null;
  }

  #place(card) {
    if (!card.anchor) return;
    const { x, y, width, height } = card.anchor;
    const topLeft = canvas.clientCoordinatesFromCanvas({ x, y });
    const bottomRight = canvas.clientCoordinatesFromCanvas({ x: x + width, y: y + height });
    const own = card.el.getBoundingClientRect();
    const taken = [...this.#cards.values()]
      .filter((other) => other !== card && other.placed)
      .map((other) => other.placed);
    const { left, top } = placeCard({
      anchor: { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y },
      size: { width: own.width, height: own.height },
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
      taken,
    });
    card.el.style.left = `${Math.round(left)}px`;
    card.el.style.top = `${Math.round(top)}px`;
    card.placed = { left, top, right: left + own.width, bottom: top + own.height };
  }

  /** The map moved: every card follows its token (once per frame). */
  #scheduleReposition() {
    if (this.#repositioning || !this.#cards.size) return;
    this.#repositioning = true;
    requestAnimationFrame(() => {
      this.#repositioning = false;
      for (const card of this.#cards.values()) {
        card.anchor = this.#anchorOf(card.group) ?? card.anchor;
        this.#place(card);
      }
    });
  }

  #fade(card) {
    card.el.classList.add('is-fading');
    card.timers.push(setTimeout(() => this.#remove(card), FADE_MS));
  }

  #remove(card) {
    card.playback?.cancel();
    for (const timer of card.timers) clearTimeout(timer);
    card.el.remove();
    if (this.#cards.get(card.key) === card) this.#cards.delete(card.key);
  }
}

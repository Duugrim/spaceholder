/**
 * Penetration view — a window that collects the math of one shot: everything the shot met — the walls, and for
 * every target the parts of the body that were hit — as blocks of rows (the layers the projectiles had to get
 * through) with an energy stream running down them, a lane in it for each projectile of a volley; an animation
 * of the pass, and a preview pane that says what happened to the projectiles at the layer you point at (or that
 * the animation is at), what is known of the hit and of the shot.
 *
 *   game.spaceholder.openPenetrationView(shotId)
 *
 * The data is the penetration tracks of the shot's rays (`penetration-track.mjs`, merged into one record by
 * `penetration-shot.mjs`) and the shot entry of the attack log they are in (`weapon/attack-log.mjs`: the hits, the
 * arc, the spread), both in the chat message that reports the attack, so any client can open it by the id of a
 * ray (`shot_…`). One window is one shot, whatever the number of its projectiles. The model is
 * `penetration-view-model.mjs`, the animation `penetration-view-animation.mjs` (shared with the cards over the
 * tokens, `penetration-overlay.mjs`).
 */

import { entryRayIds, entryRays, findTrackEntry } from './penetration-track.mjs';
import { buildShotView } from './penetration-view-model.mjs';
import { foundryLocalizer } from '../i18n-localizer.mjs';
import { PenetrationPlayback, bindImageFallbacks } from './penetration-view-animation.mjs';
import { readAttackLogs } from '../shot-trail.mjs';

const TEMPLATE = 'systems/spaceholder/templates/damage/penetration-view.hbs';
const ID_PREFIX = 'spaceholder-penetration-';

const i18n = foundryLocalizer();

function _safeId(id) {
  return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * The shot entry (and its attack log) a ray belongs to, from the chat log.
 * @param {string} shotId the id of a ray (`shot_…`)
 * @param {{ messageId?: string }} [options] the message to look in first
 * @returns {{ log: object, entry: object }|null}
 */
export function findPenetrationShot(shotId, { messageId = '' } = {}) {
  const wanted = String(shotId ?? '').trim();
  if (!wanted) return null;
  const messages = [];
  const first = messageId ? game.messages?.get?.(messageId) : null;
  if (first) messages.push(first);
  const all = Array.from(game.messages?.contents ?? []);
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i] !== first) messages.push(all[i]);
  }
  for (const message of messages) {
    const found = findTrackEntry(readAttackLogs(message), wanted);
    if (found) return found;
  }
  return null;
}

/**
 * The penetration track of a ray, from the chat log.
 * @param {string} shotId the id of the ray (`shot_…`)
 * @param {{ messageId?: string }} [options] the message to look in first
 * @returns {object|null} `null` when the shot is not in the chat or the ray met nothing worth a record
 */
export function findPenetrationTrack(shotId, options = {}) {
  const found = findPenetrationShot(shotId, options);
  return found ? entryRays(found.entry).find((ray) => ray.id === String(shotId).trim())?.track ?? null : null;
}

/**
 * Open the penetration view of a shot (or bring its window to the front and replay it).
 * @param {string} shotId the id of a ray of the shot (`shot_…`)
 * @param {{ messageId?: string, found?: { log: object, entry: object } }} [options] `found`: the shot in hand
 *   (skips the chat search)
 * @returns {PenetrationViewApp|null} `null` when the shot is not in the chat
 */
export function openPenetrationView(shotId, { messageId = '', found = null } = {}) {
  const shot = found ?? findPenetrationShot(shotId, { messageId });
  if (!shot) {
    ui.notifications?.warn?.(game.i18n?.format?.('SPACEHOLDER.PenetrationView.NotFound', { id: String(shotId ?? '') })
      ?? `No penetration record for shot ${shotId}`);
    return null;
  }
  const id = `${ID_PREFIX}${_safeId(entryRayIds(shot.entry)[0] ?? shotId)}`;
  const open = foundry.applications.instances?.get?.(id);
  if (open) {
    if (open.minimized) void open.maximize();
    open.bringToFront?.();
    void open.replay();
    return open;
  }
  const app = new PenetrationViewApp({ id, log: shot.log, entry: shot.entry });
  app.render(true);
  return app;
}

export class PenetrationViewApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: ['spaceholder', 'spaceholder-penetration-window'],
    tag: 'div',
    window: { title: 'SPACEHOLDER.PenetrationView.Projectile', icon: 'fa-solid fa-layer-group', resizable: true },
    position: { width: 820, height: 560 },
    actions: {
      replay: PenetrationViewApp.#onReplay,
      fold: PenetrationViewApp.#onFold,
      foldAll: PenetrationViewApp.#onFoldAll,
    },
  };

  // Not a `root` part: Foundry keeps only the children of a root template, and the root element here carries
  // the state of the animation (`is-animating`).
  static PARTS = {
    main: { template: TEMPLATE },
  };

  /** @type {object} */
  #log;

  /** @type {object} */
  #entry;

  /** @type {object} */
  #view;

  /** @type {PenetrationPlayback|null} */
  #playback = null;

  /** The row or group the user clicked: its preview stays when the pointer leaves. */
  #pinned = null;

  /**
   * @param {object} options ApplicationV2 options plus `log` (the attack log) and `entry` (the shot entry in it)
   */
  constructor({ log = null, entry, ...options } = {}) {
    super(options);
    this.#log = log;
    this.#entry = entry;
    const rays = entryRays(entry);
    const projectile = rays.find((candidate) => candidate.track)?.track.projectile || log?.weaponName || '';
    this.#view = buildShotView(entry, undefined, { projectile });
  }

  get title() {
    return this.#view.title;
  }

  /** @override */
  async _prepareContext() {
    return { view: this.#view, replayLabel: i18n.t('SPACEHOLDER.PenetrationView.Replay', 'Replay') };
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.#root;
    if (!root) return;
    bindImageFallbacks(root);
    this.#playback?.cancel();
    this.#playback = new PenetrationPlayback(root, {
      onStage: (index) => this.#preview(`s${index}`),
      onState: (playing) => this.#setPlaying(playing),
    });
    this.#bindPreview(root);
    this.#showDefault();
    if (options?.isFirstRender) requestAnimationFrame(() => void this.replay());
  }

  /** @override */
  async _onClose(options) {
    this.#playback?.cancel();
    return super._onClose(options);
  }

  static #onReplay() {
    if (this.#playback?.playing) this.skip();
    else void this.replay();
  }

  /** Fold or unfold the layers of one block. */
  static #onFold(event, target) {
    const key = target?.dataset?.group;
    const group = this.#view.groups.find((candidate) => candidate.key === key);
    if (!group?.foldable) return;
    this.#setFolded([group], !group.collapsed);
  }

  /** Fold every block to its head, or — when all are folded — unfold them. */
  static #onFoldAll() {
    const groups = this.#view.groups.filter((group) => group.foldable);
    this.#setFolded(groups, !groups.every((group) => group.collapsed));
  }

  /** @returns {HTMLElement|null} */
  get #root() {
    return this.element?.querySelector?.('.spaceholder-penetration') ?? null;
  }

  #setFolded(groups, collapsed) {
    const root = this.#root;
    if (!root) return;
    for (const group of groups) {
      group.collapsed = collapsed;
      root.querySelector(`[data-group="${group.key}"]`)?.classList.toggle('is-collapsed', collapsed);
    }
    const all = this.#view.groups.filter((group) => group.foldable);
    const folded = all.length > 0 && all.every((group) => group.collapsed);
    root.classList.toggle('is-folded', folded);
    const button = root.querySelector('.spaceholder-penetration__fold-all');
    if (button) {
      const label = folded ? button.dataset.unfold : button.dataset.fold;
      button.dataset.tooltip = label;
      button.setAttribute('aria-label', label);
      button.querySelector('i')?.classList.toggle('fa-angles-down', folded);
      button.querySelector('i')?.classList.toggle('fa-angles-up', !folded);
    }
    // The dashes of the layers that held a projectile follow the layers on and off the screen.
    if (this.#playback && !this.#playback.playing) this.#playback.settle();
  }

  /** Show the end state at once (stop an animation that is running). */
  skip() {
    this.#playback?.skip();
    this.#showDefault();
  }

  /** Play the pass: the bullets go layer by layer, the stream fills, a layer that holds a projectile stops it. */
  async replay() {
    if (!this.#playback) return;
    const result = await this.#playback.play();
    if (result !== 'cancelled') this.#showDefault();
  }

  /* -------------------------------------------- */
  /*  Preview pane                                */
  /* -------------------------------------------- */

  /** Hovering or clicking a row shows its details; leaving the rows shows the pinned one (or the default). */
  #bindPreview(root) {
    const stack = root.querySelector('.spaceholder-penetration__stack');
    const keyOf = (event) => event.target?.closest?.('[data-select]')?.dataset?.select ?? null;
    const peek = (event) => {
      const key = keyOf(event);
      if (key && !this.#playback?.playing) this.#preview(key);
    };
    stack?.addEventListener('pointerover', peek);
    stack?.addEventListener('focusin', peek);
    stack?.addEventListener('pointerleave', () => {
      if (!this.#playback?.playing) this.#showDefault();
    });
    stack?.addEventListener('click', (event) => {
      // The buttons in a row do their own thing.
      if (event.target?.closest?.('[data-action]')) return;
      const key = keyOf(event);
      if (!key) return;
      this.#pinned = this.#pinned === key ? null : key;
      this.#showDefault();
    });
  }

  /** The layer that held a projectile, else the last one — what the pass came to. */
  #defaultKey() {
    const open = this.#view.groups.filter((group) => !group.collapsed);
    const stages = open.flatMap((group) => group.stages);
    return stages.find((stage) => stage.stops)?.key ?? stages[stages.length - 1]?.key ?? this.#view.groups[0]?.key ?? null;
  }

  #showDefault() {
    this.#preview(this.#pinned ?? this.#defaultKey());
  }

  /** Show the details of a row or group in the preview pane and mark the row. */
  #preview(key) {
    const root = this.#root;
    if (!root) return;
    for (const detail of root.querySelectorAll('.spaceholder-penetration__detail')) detail.hidden = detail.dataset.detail !== key;
    for (const row of root.querySelectorAll('[data-select]')) {
      row.classList.toggle('is-selected', row.dataset.select === key);
      row.classList.toggle('is-pinned', row.dataset.select === this.#pinned);
    }
  }

  /** The replay button is a skip button while the animation runs. */
  #setPlaying(playing) {
    const button = this.element?.querySelector?.('.spaceholder-penetration__replay');
    if (!button) return;
    button.classList.toggle('is-playing', playing);
    // Skip while it plays, replay otherwise.
    const icon = button.querySelector('i');
    icon?.classList.toggle('fa-forward-fast', playing);
    icon?.classList.toggle('fa-rotate-right', !playing);
    const label = playing ? i18n.t('SPACEHOLDER.PenetrationView.Skip', 'Skip') : i18n.t('SPACEHOLDER.PenetrationView.Replay', 'Replay');
    button.dataset.tooltip = label;
    button.setAttribute('aria-label', label);
  }
}

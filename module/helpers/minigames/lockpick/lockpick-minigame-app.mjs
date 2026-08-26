/**
 * Lockpick minigame Application V2.
 */

import { createRng } from '../hack/rng.mjs';
import { playLockpickSlot, preloadLockpickSounds } from './lockpick-audio.mjs';
import {
  applyLockpickAction,
  liveCheck,
  liveRotate,
  replayLockpickSession,
  serializeLockpickAction,
} from './lockpick-generator.mjs';
import {
  cloneSession,
  findNextPinAfterUnlock,
  pickRotationDeg,
  sessionToView,
  switchPin,
  tryCheck,
} from './lockpick-session.mjs';

let _singleton = null;

const FRONT_SIZE = 280;
const CUT_W = 160;
const LEFT_PAD_X = 12;
const LEFT_PAD_Y = 10;
const HUD_H_EST = 38;
const HUD_GAP = 10;

function L(key, fallback = key) {
  const out = game?.i18n?.localize?.(key);
  return out && out !== key ? out : fallback;
}

/**
 * @returns {LockpickMinigameApp|null}
 */
export function getLockpickMinigameApp() {
  return _singleton;
}

/**
 * @param {import('./lockpick-session.mjs').LockpickSession} session
 * @param {object} [options]
 */
export function openLockpickMinigameApp(session, options = {}) {
  if (!session) {
    ui.notifications?.warn?.(L('SPACEHOLDER.LockpickMinigame.Messages.NoSession', 'No lockpick session.'));
    return null;
  }
  preloadLockpickSounds();
  if (_singleton) {
    _singleton.setSession(session, options);
    _singleton.render(true);
    _singleton.bringToFront?.();
    return _singleton;
  }
  _singleton = new LockpickMinigameApp(session, options);
  _singleton.render(true);
  return _singleton;
}

export class LockpickMinigameApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-lockpick-minigame',
    classes: ['spaceholder', 'lockpick-minigame'],
    tag: 'div',
    window: {
      title: 'SPACEHOLDER.LockpickMinigame.WindowTitle',
      resizable: false,
      icon: 'fa-solid fa-key',
    },
    position: { width: 480, height: 400 },
    actions: {},
  };

  static PARTS = {
    main: { root: true, template: 'systems/spaceholder/templates/minigames/lockpick-minigame-app.hbs' },
  };

  /**
   * @param {import('./lockpick-session.mjs').LockpickSession} session
   * @param {object} [options]
   */
  constructor(session, options = {}) {
    super();
    this._session = session;
    /** @type {import('./lockpick-session.mjs').LockpickSession[]} */
    this._history = [];
    /** @type {AbortController|null} */
    this._domAbort = null;
    /** @type {'local'|'play'|'observe'} */
    this._mode = 'local';
    this._runMessageId = null;
    this._runId = null;
    this._remoteRevision = 0;
    /** @type {object[]} */
    this._actionLog = [];
    this._pushing = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._pushTimer = null;
    /** @type {() => number} */
    this._rng = createRng(`${session.seed}:live`);
    this._applyRunOptions(options);
  }

  _applyRunOptions(options = {}) {
    const mode = options.mode;
    this._mode = mode === 'play' || mode === 'observe' ? mode : (options.runMessageId ? 'play' : 'local');
    this._runMessageId = options.runMessageId ?? this._runMessageId ?? null;
    this._runId = options.runId ?? this._runId ?? null;
    if (options.remoteRevision != null) this._remoteRevision = Math.max(0, Number(options.remoteRevision) || 0);
    if (Array.isArray(options.actionLog)) this._actionLog = options.actionLog.slice();
    if (this._session?.seed) this._rng = createRng(`${this._session.seed}:live:${this._actionLog.length}`);
  }

  setSession(session, options = {}) {
    this._session = session;
    this._history = [];
    this._actionLog = [];
    this._remoteRevision = 0;
    this._applyRunOptions(options);
  }

  applySyncedSession(session, meta = {}) {
    if (!session) return;
    this._session = session;
    if (meta.resetHistory) this._history = [];
    if (meta.remoteRevision != null) this._remoteRevision = Math.max(0, Number(meta.remoteRevision) || 0);
    if (Array.isArray(meta.actionLog)) this._actionLog = meta.actionLog.slice();
    this.render(false);
  }

  applyRemoteRun(run, messageId) {
    if (!run || this._pushing) return;
    if (this._runId && run.runId && this._runId !== run.runId) return;
    if (messageId) this._runMessageId = messageId;
    this._runId = run.runId || this._runId;
    if (run.revision <= this._remoteRevision) return;

    const prevLen = this._actionLog.length;
    const actions = Array.isArray(run.actions) ? run.actions : [];
    const added = actions.slice(prevLen);

    try {
      if (added.length) this._playRemoteActionSounds(run.params, actions.slice(0, prevLen), added);

      const { session } = replayLockpickSession(run.params, actions);
      this.applySyncedSession(session, {
        remoteRevision: run.revision,
        actionLog: actions,
        resetHistory: true,
      });
      if (run.status === 'won' || run.status === 'failed') {
        this._mode = this._isRunOwner() ? 'play' : 'observe';
      }
    } catch (err) {
      console.error('SpaceHolder | lockpick remote sync failed', err);
    }
  }

  /**
   * @param {object} params
   * @param {object[]} before
   * @param {object[]} added
   */
  _playRemoteActionSounds(params, before, added) {
    let session = replayLockpickSession(params, before).session;
    for (const action of added) {
      if (action?.type === 'rotate') {
        this._playSlot(action.playedHot ? 'segmentHot' : 'segmentCold');
        session = applyLockpickAction(session, action);
        continue;
      }
      if (action?.type === 'check') {
        const result = tryCheck(session, { jumpDelta: action.jumpDelta || 0 });
        session = result.session;
        if (result.success) this._playSlot('pinPassed');
        else if (result.resetPins.length) this._playSlot('pinReset');
        continue;
      }
      session = applyLockpickAction(session, action);
    }
  }

  _isRunOwner() {
    if (!this._runMessageId) return this._mode === 'local';
    try {
      const msg = game.messages?.get?.(this._runMessageId);
      const ownerId = msg?.flags?.spaceholder?.lockpickRun?.ownerUserId;
      return String(ownerId || '') === String(game.user?.id || '');
    } catch (_) {
      return this._mode === 'play';
    }
  }

  get _canInteract() {
    if (this._session?.won) return false;
    if (this._mode === 'observe') return false;
    return this._mode === 'local' || this._mode === 'play';
  }

  async close(options = {}) {
    this._domAbort?.abort();
    this._domAbort = null;
    if (this._pushTimer) {
      clearTimeout(this._pushTimer);
      this._pushTimer = null;
    }
    if (_singleton === this) _singleton = null;
    return super.close(options);
  }

  async _prepareContext() {
    const view = sessionToView(this._session);
    const bandKeys = {
      low: 'SPACEHOLDER.LockpickMinigame.Hud.ToleranceLow',
      mid: 'SPACEHOLDER.LockpickMinigame.Hud.ToleranceMid',
      high: 'SPACEHOLDER.LockpickMinigame.Hud.ToleranceHigh',
    };
    const pinsTopFirst = view.pinsTopFirst.map((p) => ({
      ...p,
      toleranceLabel: L(bandKeys[p.toleranceBand] || bandKeys.mid, p.toleranceBand),
    }));

    // Segment tick marks for ring (boundaries)
    const ticks = [];
    for (let i = 0; i < view.segmentCount; i += 1) {
      // Boundary at i*step - step/2 from top → CSS rotate from top
      const deg = i * view.segmentDegrees - view.segmentDegrees / 2;
      ticks.push({ i, deg });
    }

    return {
      ...view,
      pinsTopFirst,
      ticks,
      frontSize: FRONT_SIZE,
      cutW: CUT_W,
      isObserve: this._mode === 'observe',
      canInteract: this._canInteract,
      canUndo: this._canInteract && this._history.length > 0,
    };
  }

  _buildStats() {
    return {
      checkCount: this._session?.checkCount ?? 0,
      pinsUnlocked: this._session?.pins?.filter((p) => p.unlocked).length ?? 0,
      pinCount: this._session?.pinCount ?? 0,
    };
  }

  async _pushRunState(status = 'active') {
    if (!this._runMessageId || this._mode === 'local') return;
    const { pushLockpickRunState } = await import('./lockpick-chat.mjs');
    const actions = this._actionLog.map((a) => serializeLockpickAction(a));
    this._pushing = true;
    try {
      const next = await pushLockpickRunState(
        this._runMessageId,
        { actions, status, stats: this._buildStats() },
        {
          expectedRevision: this._remoteRevision,
          refreshContent: status !== 'active',
        }
      );
      if (next?.revision != null) this._remoteRevision = next.revision;
    } finally {
      this._pushing = false;
    }
  }

  _pushSnapshot() {
    this._history.push(cloneSession(this._session));
  }

  _playSlot(slot) {
    playLockpickSlot(slot, this._session.soundSlots, {
      mute: false,
      volumes: this._session.soundVolumes,
    });
  }

  _softUpdatePickUi() {
    const el = this.element;
    if (!el || !this._session) return;
    const pick = el.querySelector('.sh-lockpick-minigame__pick');
    if (pick) {
      pick.style.setProperty(
        '--sh-lp-pick',
        `${pickRotationDeg(this._session.pickSegment, this._session.segmentDegrees)}deg`
      );
    }
  }

  _schedulePush(status = 'active') {
    if (!this._runMessageId || this._mode === 'local') return;
    if (this._pushTimer) clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => {
      this._pushTimer = null;
      void this._pushRunState(status).catch((err) => {
        console.warn('SpaceHolder | lockpick sync failed', err);
        void this._resyncFromMessage();
      });
    }, 80);
  }

  /**
   * Rotate one segment — sync state + sound, no full re-render (wheel-friendly).
   * @param {number} delta
   */
  _commitRotate(delta) {
    if (!this._canInteract) return;
    this._pushSnapshot();
    // Cap rotate history so rapid scrolling does not balloon memory
    if (this._history.length > 80) this._history.splice(0, this._history.length - 80);
    const { session, playedHot } = liveRotate(this._session, delta, this._rng);
    this._session = session;
    this._actionLog.push(serializeLockpickAction({ type: 'rotate', delta, playedHot }));
    this._playSlot(playedHot ? 'segmentHot' : 'segmentCold');
    this._softUpdatePickUi();
    this._schedulePush('active');
  }

  async _commitSwitch(index) {
    if (!this._canInteract) return;
    if (index === this._session.activePinIndex) return;
    this._pushSnapshot();
    this._session = switchPin(this._session, index);
    this._actionLog.push(serializeLockpickAction({ type: 'switch', index }));
    await this.render(false);
    this._schedulePush('active');
  }

  async _commitCheck() {
    if (!this._canInteract) return;
    this._pushSnapshot();
    const result = liveCheck(this._session, this._rng);
    this._session = result.session;
    this._actionLog.push(serializeLockpickAction({ type: 'check', jumpDelta: result.jumpDelta }));

    if (result.success) {
      this._playSlot('pinPassed');
      if (!this._session.won) {
        const nextIdx = findNextPinAfterUnlock(this._session);
        if (nextIdx !== this._session.activePinIndex) {
          this._session = switchPin(this._session, nextIdx);
          this._actionLog.push(serializeLockpickAction({ type: 'switch', index: nextIdx }));
        }
      }
    } else if (result.resetPins.length) {
      this._playSlot('pinReset');
    }

    await this.render(false);

    const status = this._session.won ? 'won' : 'active';
    if (this._pushTimer) {
      clearTimeout(this._pushTimer);
      this._pushTimer = null;
    }
    try {
      await this._pushRunState(status);
    } catch (err) {
      console.warn('SpaceHolder | lockpick sync failed', err);
      void this._resyncFromMessage();
    }

    if (this._session.won) {
      ui.notifications?.info?.(L('SPACEHOLDER.LockpickMinigame.Messages.Won', 'Lock opened.'));
    }
  }

  async _undo() {
    if (!this._canInteract || !this._history.length) return;
    this._session = this._history.pop();
    this._actionLog.pop();
    await this.render(false);
    try {
      await this._pushRunState(this._session.won ? 'won' : 'active');
    } catch (err) {
      console.warn('SpaceHolder | lockpick undo sync failed', err);
      void this._resyncFromMessage();
    }
  }

  async _resyncFromMessage() {
    if (!this._runMessageId) return;
    try {
      const { getLockpickRun } = await import('./lockpick-chat.mjs');
      const msg = game.messages?.get?.(this._runMessageId);
      const run = getLockpickRun(msg);
      if (run) this.applyRemoteRun(run, msg.id);
    } catch (err) {
      console.warn('SpaceHolder | lockpick resync failed', err);
    }
  }

  _fitWindowToContent() {
    const el = this.element;
    if (!el) return;
    // Left column: pad + front; right column: cutaway flush to content edges.
    const innerW = LEFT_PAD_X * 2 + FRONT_SIZE + CUT_W;
    const innerH = LEFT_PAD_Y + HUD_H_EST + HUD_GAP + FRONT_SIZE + LEFT_PAD_Y;
    const header = el.querySelector('.window-header');
    const headerH = header?.offsetHeight ?? 36;
    const content = el.querySelector('.window-content');
    let frameX = 2;
    let frameY = 2;
    if (content) {
      const cs = getComputedStyle(content);
      frameX = (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0)
        + (Number.parseFloat(cs.borderLeftWidth) || 0) + (Number.parseFloat(cs.borderRightWidth) || 0);
      frameY = (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.paddingBottom) || 0)
        + (Number.parseFloat(cs.borderTopWidth) || 0) + (Number.parseFloat(cs.borderBottomWidth) || 0);
    }
    try {
      this.setPosition({
        width: Math.ceil(innerW + frameX),
        height: Math.ceil(innerH + headerH + frameY),
      });
    } catch (_) {
      /* ignore */
    }
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;
    if (!el) return;

    this._fitWindowToContent();
    preloadLockpickSounds();

    this._domAbort?.abort();
    this._domAbort = new AbortController();
    const { signal } = this._domAbort;

    el.querySelectorAll('[data-action="select-pin"]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (!this._canInteract) return;
        const idx = Number(btn.dataset.pinIndex);
        void this._commitSwitch(idx);
      }, { signal });
    });

    const undoBtn = el.querySelector('[data-action="undo"]');
    undoBtn?.addEventListener('click', (ev) => {
      ev.preventDefault();
      void this._undo();
    }, { signal });

    const front = el.querySelector('[data-action="front-view"]');
    if (front) {
      front.addEventListener('wheel', (ev) => {
        if (!this._canInteract) return;
        ev.preventDefault();
        ev.stopPropagation();
        // Normalize trackpad/mouse: one notch ≈ one segment
        const delta = ev.deltaY === 0 ? (ev.deltaX > 0 ? 1 : -1) : (ev.deltaY > 0 ? 1 : -1);
        this._commitRotate(delta);
      }, { signal, passive: false });

      front.addEventListener('click', (ev) => {
        if (!this._canInteract) return;
        if (ev.button !== 0) return;
        ev.preventDefault();
        void this._commitCheck();
      }, { signal });
    }
  }
}

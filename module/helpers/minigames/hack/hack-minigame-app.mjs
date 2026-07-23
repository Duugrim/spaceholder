/**
 * Hacking minigame Application V2.
 */

import { getAimZone, winEdgeRect } from './hack-aim-zones.mjs';
import { applyCapture, asBoardView, cloneSession, sessionToView } from './hack-board.mjs';
import {
  cellHasBonusMarkers,
  previewCaptureBonuses,
  previewCellBonusAreas,
} from './hack-bonuses.mjs';
import { cellKey, getCell, listPathsTo, listStartMoves } from './hack-moves.mjs';
import { isVisionFogOn, normalizeVisionMode } from './hack-vision.mjs';

const BONUS_PREVIEW_CLASSES = [
  'is-bonus-preview',
  'bonus-preview-purple',
  'bonus-preview-orange',
  'bonus-preview-green',
  'bonus-preview-blue',
  'bonus-preview-yellow',
  'is-bonus-preview-restore',
];

let _singleton = null;

export const HACK_CELL_SIZE = 44;
export const HACK_CELL_GAP = 4;
export const HACK_EDGE_WIDTH = 36;
/** @deprecated alias — same width as start/win strips */
export const HACK_WIN_EDGE_WIDTH = HACK_EDGE_WIDTH;
const BOARD_GAP = 8;
const CONTENT_PAD_X = 9;
const CONTENT_PAD_TOP = 14;
const CONTENT_PAD_BOTTOM = 9;
const HUD_TO_BOARD = 16;
const BOARD_TO_INFO = 16;
const INFO_TO_HINT = 12;
/** Fixed info panel height (matches SCSS) — avoids board jump when hover text changes. */
const CELL_INFO_HEIGHT = 92;

function L(key, fallback = key) {
  const out = game?.i18n?.localize?.(key);
  return out && out !== key ? out : fallback;
}

/**
 * @param {string} key
 * @param {Record<string, string|number>} data
 * @param {string} fallback
 */
function Lf(key, data, fallback = key) {
  const out = game?.i18n?.format?.(key, data);
  if (out && out !== key) return out;
  return fallback.replace(/\{(\w+)\}/g, (_, name) => String(data[name] ?? ''));
}

const BONUS_LABEL_KEYS = Object.freeze({
  purple: 'SPACEHOLDER.HackMinigame.CellInfo.BonusPurple',
  orange: 'SPACEHOLDER.HackMinigame.CellInfo.BonusOrange',
  green: 'SPACEHOLDER.HackMinigame.CellInfo.BonusGreen',
  blue: 'SPACEHOLDER.HackMinigame.CellInfo.BonusBlue',
  yellow: 'SPACEHOLDER.HackMinigame.CellInfo.BonusYellow',
});

const EDGE_DIR_KEYS = Object.freeze({
  n: 'SPACEHOLDER.HackMinigame.CellInfo.DirN',
  e: 'SPACEHOLDER.HackMinigame.CellInfo.DirE',
  s: 'SPACEHOLDER.HackMinigame.CellInfo.DirS',
  w: 'SPACEHOLDER.HackMinigame.CellInfo.DirW',
});

/**
 * @returns {HackMinigameApp|null}
 */
export function getHackMinigameApp() {
  return _singleton;
}

/**
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {object} [options]
 * @param {'local'|'play'|'observe'} [options.mode]
 * @param {string|null} [options.runMessageId]
 * @param {string|null} [options.runId]
 * @param {boolean} [options.participate]
 * @param {boolean} [options.antivirusTriggered]
 * @param {number} [options.remoteRevision]
 */
export function openHackMinigameApp(session, options = {}) {
  if (!session) {
    ui.notifications?.warn?.(L('SPACEHOLDER.HackMinigame.Messages.NoSession', 'No hack session.'));
    return null;
  }

  if (_singleton) {
    _singleton.setSession(session, options);
    _singleton.render(true);
    _singleton.bringToFront?.();
    return _singleton;
  }

  _singleton = new HackMinigameApp(session, options);
  _singleton.render(true);
  return _singleton;
}

/**
 * @param {number} cols
 * @param {number} rows
 */
export function computeBoardSize(cols, rows) {
  const gridW = cols * (HACK_CELL_SIZE + HACK_CELL_GAP) - HACK_CELL_GAP;
  const boardW = HACK_EDGE_WIDTH + BOARD_GAP + gridW + BOARD_GAP + HACK_EDGE_WIDTH;
  const boardH = rows * (HACK_CELL_SIZE + HACK_CELL_GAP) - HACK_CELL_GAP;
  return { boardW, boardH, gridW };
}

export class HackMinigameApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-hack-minigame',
    classes: ['spaceholder', 'hack-minigame'],
    tag: 'div',
    window: {
      title: 'SPACEHOLDER.HackMinigame.WindowTitle',
      resizable: false,
      icon: 'fa-solid fa-laptop-code',
      controls: [
        {
          icon: 'fa-solid fa-eye',
          label: 'SPACEHOLDER.HackMinigame.Header.RevealMap',
          action: 'revealMap',
        },
      ],
    },
    position: { width: 400, height: 300 },
    actions: {
      revealMap: HackMinigameApp.#onRevealMap,
    },
  };

  static PARTS = {
    main: { root: true, template: 'systems/spaceholder/templates/minigames/hack-minigame-app.hbs' },
  };

  /**
   * @param {import('./hack-board.mjs').HackSession} session
   * @param {object} [options]
   */
  constructor(session, options = {}) {
    super();
    this._session = session;
    /** @type {import('./hack-board.mjs').HackSession[]} */
    this._history = [];
    /** Debug X-ray overlay — shows fogged cell contents without setting revealed. */
    this._debugRevealMap = false;
    /** @type {{ toR: number|null, toC: number|null, toWin: boolean }|null} */
    this._hoverTarget = null;
    /** @type {import('./hack-moves.mjs').HackMove[]} */
    this._hoverPaths = [];
    this._activePathIndex = 0;
    /** @type {{ r: number, c: number }|null} aim-zone source cell */
    this._aimCell = null;
    /** @type {{ r: number, c: number }|null} cell whose bonus markers are being inspected */
    this._inspectBonusCell = null;
    /** @type {{ kind: 'cell', r: number, c: number } | { kind: 'win' } | { kind: 'start' } | null} */
    this._cursorCell = null;
    /** @type {AbortController|null} */
    this._domAbort = null;
    /** @type {'local'|'play'|'observe'} */
    this._mode = 'local';
    this._runMessageId = null;
    this._runId = null;
    this._participate = false;
    this._antivirusTriggered = false;
    this._remoteRevision = 0;
    /** @type {import('./hack-generator.mjs').HackLoggedMove[]} */
    this._moveLog = [];
    this._pushing = false;
    this._closingRun = false;
    this._applyRunOptions(options);
  }

  /**
   * @param {object} [options]
   */
  _applyRunOptions(options = {}) {
    const mode = options.mode;
    this._mode = mode === 'play' || mode === 'observe' ? mode : (options.runMessageId ? 'play' : 'local');
    this._runMessageId = options.runMessageId ?? this._runMessageId ?? null;
    this._runId = options.runId ?? this._runId ?? null;
    if (options.participate != null) this._participate = !!options.participate;
    else if (this._mode === 'play') this._participate = true;
    else if (this._mode === 'local') this._participate = true;
    if (options.antivirusTriggered != null) this._antivirusTriggered = !!options.antivirusTriggered;
    if (options.remoteRevision != null) this._remoteRevision = Math.max(0, Number(options.remoteRevision) || 0);
    if (Array.isArray(options.moveLog)) this._moveLog = options.moveLog.slice();
  }

  /**
   * @param {import('./hack-board.mjs').HackSession} session
   * @param {object} [options]
   */
  setSession(session, options = {}) {
    this._session = session;
    this._history = [];
    this._debugRevealMap = false;
    this._hoverTarget = null;
    this._hoverPaths = [];
    this._activePathIndex = 0;
    this._aimCell = null;
    this._inspectBonusCell = null;
    this._cursorCell = null;
    this._moveLog = [];
    this._antivirusTriggered = false;
    this._remoteRevision = 0;
    this._applyRunOptions(options);
  }

  /**
   * Soft board update for observers — keeps Reveal map / does not wipe UI chrome.
   * @param {import('./hack-board.mjs').HackSession} session
   * @param {object} [meta]
   */
  applySyncedSession(session, meta = {}) {
    if (!session) return;
    this._session = session;
    if (meta.antivirusTriggered != null) this._antivirusTriggered = !!meta.antivirusTriggered;
    if (meta.remoteRevision != null) this._remoteRevision = Math.max(0, Number(meta.remoteRevision) || 0);
    if (Array.isArray(meta.moveLog)) this._moveLog = meta.moveLog.slice();
    // History is local-only; remote sync replaces authoritative state.
    if (meta.resetHistory) this._history = [];
    this._clearHover();
    this.render(false);
  }

  /**
   * @param {object} run
   * @param {string} [messageId]
   */
  applyRemoteRun(run, messageId) {
    if (!run || this._pushing) return;
    if (this._runId && run.runId && this._runId !== run.runId) return;
    if (messageId) this._runMessageId = messageId;
    this._runId = run.runId || this._runId;
    // Skip echoes / older snapshots (own push updates revision before the hook).
    if (run.revision <= this._remoteRevision) return;
    void import('./hack-chat.mjs').then(({ replayHackSession }) => {
      const { session, stats } = replayHackSession(run.params, run.moves);
      this.applySyncedSession(session, {
        antivirusTriggered: stats.antivirusTriggered,
        remoteRevision: run.revision,
        moveLog: run.moves,
        resetHistory: true,
      });
      if (run.status === 'won' || run.status === 'failed') {
        this._mode = this._isRunOwner() ? 'play' : 'observe';
        this._participate = this._isRunOwner();
      }
    }).catch((err) => {
      console.error('SpaceHolder | hack remote sync failed', err);
    });
  }

  _isRunOwner() {
    if (!this._runMessageId) return this._mode === 'local';
    try {
      // Lazy: owner identity lives on the message flag
      const msg = game.messages?.get?.(this._runMessageId);
      const ownerId = msg?.flags?.spaceholder?.hackRun?.ownerUserId;
      return String(ownerId || '') === String(game.user?.id || '');
    } catch (_) {
      return this._mode === 'play';
    }
  }

  _canInteract() {
    if (this._session?.won) return false;
    if (this._mode === 'local' || this._mode === 'play') return true;
    return this._mode === 'observe' && this._participate;
  }

  /**
   * Toggle label / icon for the debug map-reveal header control.
   * @override
   */
  _getHeaderControls() {
    return super._getHeaderControls().map((control) => {
      if (control?.action !== 'revealMap') return control;
      return {
        ...control,
        icon: this._debugRevealMap ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye',
        label: this._debugRevealMap
          ? 'SPACEHOLDER.HackMinigame.Header.HideMapReveal'
          : 'SPACEHOLDER.HackMinigame.Header.RevealMap',
      };
    });
  }

  async close(options = {}) {
    if (!this._closingRun && this._runMessageId && this._isRunOwner() && !this._session?.won) {
      const status = game.messages?.get?.(this._runMessageId)?.flags?.spaceholder?.hackRun?.status;
      if (!status || status === 'active') {
        this._closingRun = true;
        try {
          await this._finalizeRun('failed');
        } catch (err) {
          console.error('SpaceHolder | hack abandon failed', err);
        }
      }
    }
    this._domAbort?.abort();
    this._domAbort = null;
    await super.close(options);
    if (_singleton === this) _singleton = null;
  }

  /**
   * Header menu (⋯): toggle semi-transparent debug overlay on fogged cells.
   * @this {HackMinigameApp}
   */
  static #onRevealMap() {
    this._toggleDebugRevealMap();
  }

  /**
   * @param {boolean} participate
   */
  async _setParticipate(participate) {
    this._participate = !!participate;
    if (this._participate && this._runMessageId) {
      try {
        const { joinHackRun } = await import('./hack-chat.mjs');
        await joinHackRun(this._runMessageId, String(game.user?.id || ''));
      } catch (err) {
        console.warn('SpaceHolder | hack join failed', err);
      }
    }
    this.render(false);
  }

  /**
   * Debug X-ray: show values/bonuses on fogged cells without clearing vision fog.
   */
  _toggleDebugRevealMap() {
    this._debugRevealMap = !this._debugRevealMap;
    this.render(false);
  }

  _geom() {
    const gridOriginX = HACK_EDGE_WIDTH + BOARD_GAP;
    return {
      cellSize: HACK_CELL_SIZE,
      cellGap: HACK_CELL_GAP,
      winEdgeWidth: HACK_EDGE_WIDTH,
      startEdgeWidth: HACK_EDGE_WIDTH,
      boardGap: BOARD_GAP,
      gridOriginX,
    };
  }

  _activeMove() {
    if (!this._hoverPaths.length) return null;
    const idx = this._activePathIndex;
    if (idx < 0 || idx >= this._hoverPaths.length) return null;
    return this._hoverPaths[idx];
  }

  _previewFromActive() {
    const move = this._activeMove();
    if (!move) {
      return { captureKeys: [], traversedKeys: [], sourceKeys: [], winPreview: false };
    }
    const captureKeys = [];
    if (!move.toWin && move.toR != null && move.toC != null) {
      captureKeys.push(cellKey(move.toR, move.toC));
    }
    const traversedKeys = (move.traversed ?? []).map((p) => cellKey(p.r, p.c));
    const sourceKeys = [];
    if (move.fromR != null && move.fromC != null) {
      sourceKeys.push(cellKey(move.fromR, move.fromC));
    }
    return {
      captureKeys,
      traversedKeys,
      sourceKeys,
      winPreview: !!move.toWin,
    };
  }

  _buildPathLines() {
    const session = this._session;
    if (!session || !this._hoverPaths.length) return [];

    const geom = this._geom();
    const cellPitch = HACK_CELL_SIZE + HACK_CELL_GAP;
    const ox = geom.gridOriginX;
    const centerOf = (r, c) => ({
      x: ox + c * cellPitch + HACK_CELL_SIZE / 2,
      y: r * cellPitch + HACK_CELL_SIZE / 2,
    });
    const startCenter = (toR) => ({
      x: HACK_EDGE_WIDTH / 2,
      y: (toR ?? Math.floor(session.rows / 2)) * cellPitch + HACK_CELL_SIZE / 2,
    });
    const winCenter = (fromR) => ({
      x: ox + session.cols * cellPitch - HACK_CELL_GAP + BOARD_GAP + HACK_EDGE_WIDTH / 2,
      y: (fromR ?? Math.floor(session.rows / 2)) * cellPitch + HACK_CELL_SIZE / 2,
    });

    return this._hoverPaths.map((move, idx) => {
      let x1;
      let y1;
      let x2;
      let y2;
      if (move.isStart) {
        const from = startCenter(move.toR);
        const to = centerOf(move.toR, move.toC);
        x1 = from.x;
        y1 = from.y;
        x2 = to.x;
        y2 = to.y;
      } else if (move.toWin) {
        const from = centerOf(move.fromR, move.fromC);
        const to = winCenter(move.fromR);
        x1 = from.x;
        y1 = from.y;
        x2 = to.x;
        y2 = to.y;
      } else {
        const from = centerOf(move.fromR, move.fromC);
        const to = centerOf(move.toR, move.toC);
        x1 = from.x;
        y1 = from.y;
        x2 = to.x;
        y2 = to.y;
      }
      return { x1, y1, x2, y2, active: idx === this._activePathIndex };
    });
  }

  async _prepareContext() {
    const view = sessionToView(this._session, null, { debugReveal: this._debugRevealMap });
    const flatCells = view.grid.flat();
    const { boardW, boardH } = computeBoardSize(view.cols, view.rows);
    const visionMode = normalizeVisionMode(this._session?.visionMode);
    const visionModeLabel = visionMode === 'available'
      ? L('SPACEHOLDER.HackMinigame.Hud.VisionAvailable', 'Available only')
      : L('SPACEHOLDER.HackMinigame.Hud.VisionNeighbors', 'Neighbors');
    const canInteract = this._canInteract();
    const showParticipate = this._mode === 'observe' && !!this._runMessageId;

    return {
      ...view,
      flatCells,
      pathLines: [],
      winPreview: false,
      winHover: false,
      multiPath: false,
      activePathLabel: '',
      canUndo: canInteract && this._history.length > 0,
      canInteract,
      showParticipate,
      participate: this._participate,
      isObserve: this._mode === 'observe',
      visionMode,
      visionModeLabel,
      boardW,
      boardH,
    };
  }

  _buildStats() {
    return {
      actionUsed: this._session?.actionUsed ?? 0,
      actionLimit: this._session?.actionLimit ?? 0,
      antivirusTriggered: !!this._antivirusTriggered || !!this._session?.antivirusActive,
    };
  }

  /**
   * @param {'active'|'won'|'failed'} status
   */
  async _pushRunState(status = 'active') {
    if (!this._runMessageId || this._mode === 'local') return;
    const { pushHackRunState, serializeHackMove } = await import('./hack-chat.mjs');
    // ensure moves are plain
    const moves = this._moveLog.map((m) => serializeHackMove(m, m.pathIndex));
    this._pushing = true;
    try {
      const next = await pushHackRunState(
        this._runMessageId,
        {
          moves,
          status,
          stats: this._buildStats(),
        },
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

  /**
   * @param {'won'|'failed'} status
   */
  async _finalizeRun(status) {
    if (!this._runMessageId) return;
    await this._pushRunState(status);
  }

  /**
   * Size the Application window to the board + HUD (no spare chrome space).
   */
  _fitWindowToContent() {
    const session = this._session;
    if (!session) return;
    const el = this.element;
    if (!el) return;

    const { boardW, boardH } = computeBoardSize(session.cols, session.rows);
    const hud = el.querySelector('.sh-hack-minigame__hud');
    const hint = el.querySelector('.sh-hack-minigame__hint');
    const hudH = hud?.offsetHeight ?? 28;
    const hintH = hint?.offsetHeight ?? 0;
    const hintGap = hintH > 0 ? INFO_TO_HINT : 0;

    const innerW = boardW + CONTENT_PAD_X * 2;
    const innerH = CONTENT_PAD_TOP + hudH + HUD_TO_BOARD + boardH + BOARD_TO_INFO + CELL_INFO_HEIGHT
      + hintGap + hintH + CONTENT_PAD_BOTTOM;

    const header = el.querySelector('.window-header');
    const headerH = header?.offsetHeight ?? 36;
    // Frame around .window-content (borders / padding)
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

    const width = Math.ceil(innerW + frameX);
    const height = Math.ceil(innerH + headerH + frameY);
    try {
      this.setPosition({ width, height });
    } catch (_) {
      // ignore
    }
  }

  /**
   * Soft-update hover preview / aim zone without destroying the board DOM.
   */
  _clearBonusPreviewPaint() {
    const el = this.element;
    if (!el) return;
    el.querySelectorAll('.sh-hack-minigame__cell').forEach((btn) => {
      btn.classList.remove(...BONUS_PREVIEW_CLASSES);
      const valEl = btn.querySelector('.sh-hack-minigame__cell-value');
      if (valEl && btn.dataset.baseValue != null) {
        valEl.textContent = btn.dataset.baseValue;
        delete btn.dataset.baseValue;
      }
    });
  }

  /**
   * Marker areas on the hovered cell always show; an active capture path overlays
   * live value previews for effects that path would actually fire.
   */
  _bonusPreviewState() {
    const session = this._session;
    if (!session?.bonusesEnabled) return { purple: false, cells: new Map(), live: false };

    /** @type {Map<string, object>} */
    const cells = new Map();
    let live = false;

    // Always paint edge/ring areas for the inspected marker cell.
    if (this._inspectBonusCell) {
      const areas = previewCellBonusAreas(
        session,
        this._inspectBonusCell.r,
        this._inspectBonusCell.c
      );
      for (const [key, info] of areas.cells) {
        cells.set(key, { ...info, valueChanged: false, statusChanged: false });
      }
    }

    const move = this._activeMove();
    if (move) {
      const fired = previewCaptureBonuses(session, move);
      if (fired.cells.size) live = true;
      for (const [key, info] of fired.cells) {
        cells.set(key, info);
      }
    }

    return { purple: false, cells, live };
  }

  /**
   * Draw effect areas above the aim zone so they stay visible.
   * @param {SVGElement} svg
   * @param {string} NS
   * @param {Map<string, { r: number, c: number, type: string }>} cells
   */
  _paintBonusZone(svg, NS, cells) {
    if (!cells?.size) return;
    const pitch = HACK_CELL_SIZE + HACK_CELL_GAP;
    const ox = this._geom().gridOriginX;
    const group = document.createElementNS(NS, 'g');
    group.setAttribute('class', 'sh-hack-minigame__bonus-zone');
    for (const info of cells.values()) {
      const node = document.createElementNS(NS, 'rect');
      node.setAttribute('x', String(ox + info.c * pitch));
      node.setAttribute('y', String(info.r * pitch));
      node.setAttribute('width', String(HACK_CELL_SIZE));
      node.setAttribute('height', String(HACK_CELL_SIZE));
      node.setAttribute('rx', '6');
      node.setAttribute('ry', '6');
      node.setAttribute('class', `sh-hack-minigame__bonus-shape bonus-${info.type}`);
      group.appendChild(node);
    }
    svg.appendChild(group);
  }

  _paintPreview() {
    const el = this.element;
    if (!el) return;

    const preview = this._previewFromActive();
    const capture = new Set(preview.captureKeys);
    const traversed = new Set(preview.traversedKeys);
    const source = new Set(preview.sourceKeys);
    const bonusPrev = this._bonusPreviewState();

    this._clearBonusPreviewPaint();

    el.querySelectorAll('.sh-hack-minigame__cell').forEach((btn) => {
      const key = btn.dataset.key;
      btn.classList.toggle('is-preview-capture', capture.has(key));
      btn.classList.toggle('is-preview-traversed', traversed.has(key));
      btn.classList.toggle('is-preview-source', source.has(key));
      const r = Number(btn.dataset.r);
      const c = Number(btn.dataset.c);
      const isAimSrc = !!this._aimCell && this._aimCell.r === r && this._aimCell.c === c;
      btn.classList.toggle('is-aim-source', isAimSrc);

      const bonus = bonusPrev.cells.get(key);
      if (!bonus) return;
      btn.classList.add('is-bonus-preview', `bonus-preview-${bonus.type}`);
      if (bonus.statusChanged && bonus.status === 'untouched') {
        btn.classList.add('is-bonus-preview-restore');
      }
      if (bonus.statusChanged && bonus.status === 'traversed') {
        btn.classList.add('is-preview-traversed');
      }
      const valEl = btn.querySelector('.sh-hack-minigame__cell-value');
      // Live capture path: show resulting values in effect color.
      if (valEl && bonusPrev.live && (bonus.valueChanged || bonus.statusChanged)) {
        if (btn.dataset.baseValue == null) btn.dataset.baseValue = valEl.textContent;
        valEl.textContent = String(bonus.value);
      }
    });

    // Rule 5: show source digit after −1 on the active path.
    const activeMove = this._activeMove();
    if (activeMove && !activeMove.isStart && !activeMove.toWin
      && activeMove.fromR != null && activeMove.fromC != null) {
      const srcBtn = el.querySelector(
        `.sh-hack-minigame__cell[data-r="${activeMove.fromR}"][data-c="${activeMove.fromC}"]`
      );
      const srcVal = srcBtn?.querySelector?.('.sh-hack-minigame__cell-value');
      if (srcVal) {
        const srcCell = getCell(asBoardView(this._session), activeMove.fromR, activeMove.fromC);
        const nextVal = Math.max(0, (Number(srcCell?.value) || 0) - 1);
        if (srcBtn.dataset.baseValue == null) srcBtn.dataset.baseValue = srcVal.textContent;
        srcVal.textContent = String(nextVal);
      }
    }

    const startBtn = el.querySelector('.sh-hack-minigame__start-edge');
    if (startBtn) {
      const startHover = this._cursorCell?.kind === 'start';
      startBtn.classList.toggle('is-hover', startHover);
      startBtn.classList.toggle('is-preview-capture', startHover && this._hoverPaths.some((m) => m.isStart));
    }

    const winBtn = el.querySelector('.sh-hack-minigame__win-edge');
    if (winBtn) {
      winBtn.classList.toggle('is-preview-capture', preview.winPreview);
      winBtn.classList.toggle('is-hover', !!this._hoverTarget?.toWin);
    }

    const svg = el.querySelector('.sh-hack-minigame__paths');
    if (svg) {
      const NS = 'http://www.w3.org/2000/svg';
      while (svg.firstChild) svg.removeChild(svg.firstChild);

      // Aim zone under path lines / bonus overlays
      this._paintAimZone(svg, NS);
      this._paintBonusZone(svg, NS, bonusPrev.cells);

      for (const line of this._buildPathLines()) {
        const node = document.createElementNS(NS, 'line');
        node.setAttribute('x1', String(line.x1));
        node.setAttribute('y1', String(line.y1));
        node.setAttribute('x2', String(line.x2));
        node.setAttribute('y2', String(line.y2));
        node.setAttribute('class', `sh-hack-minigame__path-line${line.active ? ' is-active' : ''}`);
        svg.appendChild(node);
      }
    }

    let footer = el.querySelector('.sh-hack-minigame__hint');
    const multiPath = this._hoverPaths.length > 1;
    if (multiPath) {
      const activeMove = this._activeMove();
      const src = activeMove?.isStart
        ? L('SPACEHOLDER.HackMinigame.Hud.StartSource', 'start')
        : String(activeMove?.sourceValue ?? '?');
      const label = `${this._activePathIndex + 1}/${this._hoverPaths.length} ← ${src}`;
      if (!footer) {
        footer = document.createElement('footer');
        footer.className = 'sh-hack-minigame__hint';
        el.querySelector('.sh-hack-minigame')?.appendChild(footer);
      }
      footer.innerHTML = `${foundry.utils.escapeHTML(L('SPACEHOLDER.HackMinigame.Hud.MultiPathHint', 'Scroll to choose path'))} <span class="sh-hack-minigame__path-index">${foundry.utils.escapeHTML(label)}</span>`;
    } else if (footer) {
      footer.remove();
    }

    this._paintCellInfo();
  }

  /**
   * Info panel under the board for the cell under the cursor.
   */
  _paintCellInfo() {
    const root = this.element?.querySelector?.('[data-cell-info]');
    if (!root) return;

    const cursor = this._cursorCell;
    if (!cursor) {
      root.innerHTML = `<div class="sh-hack-minigame__cell-info-empty">${foundry.utils.escapeHTML(
        L('SPACEHOLDER.HackMinigame.CellInfo.Empty', 'Hover a cell')
      )}</div>`;
      return;
    }

    if (cursor.kind === 'win') {
      root.innerHTML = `<div class="sh-hack-minigame__cell-info-head"><span class="sh-hack-minigame__cell-info-coord">${foundry.utils.escapeHTML(
        L('SPACEHOLDER.HackMinigame.CellInfo.WinEdge', 'System edge — capture to win')
      )}</span></div>`;
      return;
    }

    if (cursor.kind === 'start') {
      root.innerHTML = `<div class="sh-hack-minigame__cell-info-head"><span class="sh-hack-minigame__cell-info-coord">${foundry.utils.escapeHTML(
        L('SPACEHOLDER.HackMinigame.CellInfo.StartEdge', 'Entry edge — start from the left column')
      )}</span></div>`;
      return;
    }

    const cell = getCell(this._session, cursor.r, cursor.c);
    if (!cell) {
      root.innerHTML = `<div class="sh-hack-minigame__cell-info-empty">${foundry.utils.escapeHTML(
        L('SPACEHOLDER.HackMinigame.CellInfo.Empty', 'Hover a cell')
      )}</div>`;
      return;
    }

    const fogged = isVisionFogOn(this._session) && !cell.revealed;
    const debugPeek = fogged && this._debugRevealMap;
    const esc = (s) => foundry.utils.escapeHTML(String(s));
    const statusKey = {
      untouched: 'SPACEHOLDER.HackMinigame.CellInfo.StatusUntouched',
      captured: 'SPACEHOLDER.HackMinigame.CellInfo.StatusCaptured',
      traversed: 'SPACEHOLDER.HackMinigame.CellInfo.StatusTraversed',
    }[cell.status] ?? 'SPACEHOLDER.HackMinigame.CellInfo.StatusUntouched';
    const statusFallback = {
      untouched: 'Untouched',
      captured: 'Captured',
      traversed: 'Disabled',
    }[cell.status] ?? 'Untouched';

    const head = [
      `<span class="sh-hack-minigame__cell-info-coord">${esc(Lf(
        'SPACEHOLDER.HackMinigame.CellInfo.Coord',
        { row: cursor.r + 1, col: cursor.c + 1 },
        `Cell ${cursor.r + 1},${cursor.c + 1}`
      ))}</span>`,
      `<span>${esc(L(statusKey, statusFallback))}</span>`,
    ];

    if (fogged && !debugPeek) {
      head.push(`<span class="sh-hack-minigame__cell-info-value">${esc(L(
        'SPACEHOLDER.HackMinigame.CellInfo.Fogged',
        'Hidden'
      ))}</span>`);
      root.innerHTML = `<div class="sh-hack-minigame__cell-info-head">${head.join('')}</div>`;
      return;
    }

    if (debugPeek) {
      head.push(`<span class="sh-hack-minigame__cell-info-tag is-debug">${esc(L(
        'SPACEHOLDER.HackMinigame.CellInfo.Fogged',
        'Hidden'
      ))} · ${esc(L('SPACEHOLDER.HackMinigame.Hud.DebugReveal', 'Debug reveal'))}</span>`);
    }

    head.push(`<span class="sh-hack-minigame__cell-info-value${debugPeek ? ' is-debug-ghost' : ''}">${esc(Lf(
      'SPACEHOLDER.HackMinigame.CellInfo.Value',
      { value: cell.value },
      `Digit ${cell.value}`
    ))}</span>`);

    /** @type {string[]} */
    const tags = [];
    if (cell.scannable) {
      tags.push(`<span class="sh-hack-minigame__cell-info-tag is-scannable">${esc(L(
        'SPACEHOLDER.HackMinigame.CellInfo.Scannable',
        'Scannable'
      ))}</span>`);
    }
    if (cell.activeAntivirus) {
      tags.push(`<span class="sh-hack-minigame__cell-info-tag is-av">${esc(L(
        'SPACEHOLDER.HackMinigame.CellInfo.ActiveAv',
        'Active AV'
      ))}</span>`);
    }
    if (cell.antivirusSecondary) {
      tags.push(`<span class="sh-hack-minigame__cell-info-tag is-av-secondary">${esc(L(
        'SPACEHOLDER.HackMinigame.CellInfo.SecondaryAv',
        'Secondary AV'
      ))}</span>`);
    }

    const edges = cell.edgeBonuses ?? {};
    for (const dir of ['n', 'e', 's', 'w']) {
      const type = edges[dir];
      if (!type) continue;
      const dirLabel = L(EDGE_DIR_KEYS[dir], dir.toUpperCase());
      const typeLabel = L(BONUS_LABEL_KEYS[type] ?? '', type);
      tags.push(`<span class="sh-hack-minigame__cell-info-tag bonus-${esc(type)}">${esc(Lf(
        'SPACEHOLDER.HackMinigame.CellInfo.Edge',
        { dir: dirLabel, type: typeLabel },
        `${dirLabel}: ${typeLabel}`
      ))}</span>`);
    }

    const ring = cell.ringBonus;
    if (ring?.type && ring.rings) {
      const typeLabel = L(BONUS_LABEL_KEYS[ring.type] ?? '', ring.type);
      tags.push(`<span class="sh-hack-minigame__cell-info-tag bonus-${esc(ring.type)}">${esc(Lf(
        'SPACEHOLDER.HackMinigame.CellInfo.Ring',
        { rings: ring.rings, type: typeLabel },
        `Ring ×${ring.rings}: ${typeLabel}`
      ))}</span>`);
    }

    const digit = Math.max(0, Math.min(9, Number(cell.value) || 0));
    const help = L(
      `SPACEHOLDER.HackMinigame.CellInfo.Digits.${digit}`,
      ''
    );

    root.innerHTML = [
      `<div class="sh-hack-minigame__cell-info-head">${head.join('')}</div>`,
      tags.length ? `<div class="sh-hack-minigame__cell-info-tags">${tags.join('')}</div>` : '',
      help ? `<div class="sh-hack-minigame__cell-info-help">${esc(help)}</div>` : '',
    ].join('');
  }

  /**
   * @param {SVGElement} svg
   * @param {string} NS
   */
  _paintAimZone(svg, NS) {
    if (!this._aimCell || !this._session) return;
    const board = asBoardView(this._session);
    const { shapes, includesWinEdge } = getAimZone(
      board,
      this._aimCell.r,
      this._aimCell.c,
      this._geom()
    );

    const group = document.createElementNS(NS, 'g');
    group.setAttribute('class', 'sh-hack-minigame__aim-zone');

    for (const shape of shapes) {
      if (shape.type === 'rect') {
        const node = document.createElementNS(NS, 'rect');
        node.setAttribute('x', String(shape.x));
        node.setAttribute('y', String(shape.y));
        node.setAttribute('width', String(shape.w));
        node.setAttribute('height', String(shape.h));
        node.setAttribute(
          'class',
          shape.soft ? 'sh-hack-minigame__aim-shape is-soft' : 'sh-hack-minigame__aim-shape'
        );
        group.appendChild(node);
      } else if (shape.type === 'polygon') {
        const node = document.createElementNS(NS, 'polygon');
        node.setAttribute('points', shape.points);
        node.setAttribute('class', 'sh-hack-minigame__aim-shape');
        group.appendChild(node);
      } else if (shape.type === 'line') {
        const node = document.createElementNS(NS, 'line');
        node.setAttribute('x1', String(shape.x1));
        node.setAttribute('y1', String(shape.y1));
        node.setAttribute('x2', String(shape.x2));
        node.setAttribute('y2', String(shape.y2));
        node.setAttribute('class', 'sh-hack-minigame__aim-shape is-line');
        if (shape.width) node.setAttribute('stroke-width', String(shape.width));
        group.appendChild(node);
      }
    }

    if (includesWinEdge) {
      const edge = winEdgeRect(this._session.cols, this._session.rows, this._geom());
      const node = document.createElementNS(NS, 'rect');
      node.setAttribute('x', String(edge.x));
      node.setAttribute('y', String(edge.y));
      node.setAttribute('width', String(edge.w));
      node.setAttribute('height', String(edge.h));
      node.setAttribute('class', 'sh-hack-minigame__aim-shape is-win');
      group.appendChild(node);
    }

    svg.appendChild(group);
  }

  /**
   * Hover the left entry strip: preview all remaining left-edge start moves.
   */
  _hoverStartEdge() {
    if (this._session?.won) {
      this._clearHover();
      return;
    }
    this._cursorCell = { kind: 'start' };
    this._aimCell = null;
    this._inspectBonusCell = null;
    const board = asBoardView(this._session);
    this._hoverPaths = listStartMoves(board);
    this._activePathIndex = 0;
    this._hoverTarget = this._hoverPaths.length
      ? { toR: null, toC: null, toWin: false }
      : null;
  }

  /**
   * Hover a cell: path-preview if capturable, else aim-zone for that cell's digit.
   * @param {number} r
   * @param {number} c
   */
  _hoverCell(r, c) {
    if (this._session?.won) {
      this._clearHover();
      return;
    }

    this._cursorCell = { kind: 'cell', r, c };

    const board = asBoardView(this._session);
    const cell = getCell(board, r, c);
    const paths = listPathsTo(board, { toR: r, toC: c, toWin: false });
    const revealed = !isVisionFogOn(this._session) || !!cell?.revealed;

    // Aim zone only for revealed digits — fogged cells must not leak targets.
    this._aimCell = revealed && cell && cell.value > 0 ? { r, c } : null;
    const canInspectBonuses = revealed && cellHasBonusMarkers(cell);
    this._inspectBonusCell = canInspectBonuses ? { r, c } : null;

    if (paths.length > 0) {
      this._setHoverTarget({ toR: r, toC: c, toWin: false });
      return;
    }

    this._hoverTarget = null;
    this._hoverPaths = [];
    this._activePathIndex = 0;
  }

  /**
   * @param {{ toR?: number|null, toC?: number|null, toWin?: boolean }} target
   */
  _setHoverTarget(target) {
    if (this._session?.won) {
      this._hoverTarget = null;
      this._hoverPaths = [];
      this._activePathIndex = 0;
      this._aimCell = null;
      return;
    }

    const prev = this._hoverTarget;
    const same =
      prev &&
      (!!prev.toWin === !!target.toWin) &&
      prev.toR === (target.toR ?? null) &&
      prev.toC === (target.toC ?? null);

    this._hoverTarget = {
      toR: target.toWin ? null : (target.toR ?? null),
      toC: target.toWin ? null : (target.toC ?? null),
      toWin: !!target.toWin,
    };

    // Win-edge hover has no cell aim zone
    if (target.toWin) this._aimCell = null;

    const board = asBoardView(this._session);
    this._hoverPaths = listPathsTo(board, this._hoverTarget);

    if (!same) {
      this._activePathIndex = 0;
    } else if (this._activePathIndex >= this._hoverPaths.length) {
      this._activePathIndex = 0;
    }
  }

  _clearHover() {
    this._hoverTarget = null;
    this._hoverPaths = [];
    this._activePathIndex = 0;
    this._aimCell = null;
    this._inspectBonusCell = null;
    this._cursorCell = null;
  }

  _cyclePath(delta) {
    if (this._hoverPaths.length < 2) return false;
    const n = this._hoverPaths.length;
    this._activePathIndex = (((this._activePathIndex + delta) % n) + n) % n;
    return true;
  }

  _tryCapture() {
    if (this._session?.won) return;
    if (!this._canInteract()) return;

    if (!this._hoverPaths.length) return;

    const move = this._activeMove();
    if (!move) {
      ui.notifications?.warn?.(
        L('SPACEHOLDER.HackMinigame.Messages.PathNotSelected', 'Path not selected.')
      );
      return;
    }

    const pathIndex = this._activePathIndex;
    const result = applyCapture(this._session, { ...move, pathIndex });
    if (!result.ok) {
      ui.notifications?.warn?.(
        L('SPACEHOLDER.HackMinigame.Messages.InvalidMove', 'Invalid move.')
      );
      return;
    }

    this._history.push(cloneSession(this._session));
    this._session = result.session;
    if (result.activatedAntivirus) this._antivirusTriggered = true;
    this._moveLog.push({
      fromR: move.fromR ?? null,
      fromC: move.fromC ?? null,
      toR: move.toR ?? null,
      toC: move.toC ?? null,
      toWin: !!move.toWin,
      isStart: !!move.isStart,
      pathIndex,
    });
    this._clearHover();

    if (this._session.won) {
      ui.notifications?.info?.(L('SPACEHOLDER.HackMinigame.Messages.Won', 'System breached.'));
      void this._finalizeRun('won');
    } else if (this._runMessageId) {
      void this._pushRunState('active').catch((err) => {
        console.warn('SpaceHolder | hack push failed', err);
        ui.notifications?.warn?.(
          L('SPACEHOLDER.HackMinigame.Messages.SyncFailed', 'Failed to sync hack state.')
        );
        void this._resyncFromMessage();
      });
    }

    this.render(false);
  }

  _undo() {
    if (!this._canInteract()) return;
    if (!this._history.length) return;
    this._session = this._history.pop();
    this._moveLog.pop();
    this._antivirusTriggered = !!this._session?.antivirusActive;
    this._clearHover();
    if (this._runMessageId) {
      void this._pushRunState('active').catch((err) => {
        console.warn('SpaceHolder | hack undo sync failed', err);
        void this._resyncFromMessage();
      });
    }
    this.render(false);
  }

  async _resyncFromMessage() {
    if (!this._runMessageId) return;
    try {
      const { getHackRun } = await import('./hack-chat.mjs');
      const msg = game.messages?.get?.(this._runMessageId);
      const run = getHackRun(msg);
      if (!run) return;
      this._remoteRevision = Math.max(-1, run.revision - 1);
      this.applyRemoteRun(run, msg.id);
    } catch (err) {
      console.warn('SpaceHolder | hack resync failed', err);
    }
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;
    if (!el) return;

    this._domAbort?.abort();
    this._domAbort = new AbortController();
    const { signal } = this._domAbort;

    const boardW = context.boardW ?? 400;
    const boardH = context.boardH ?? 300;
    const shell = el.querySelector('.sh-hack-minigame');
    if (shell) shell.style.setProperty('--sh-hack-shell-w', `${boardW}px`);
    const wrap = el.querySelector('.sh-hack-minigame__board-wrap');
    if (wrap) {
      wrap.style.width = `${boardW}px`;
      wrap.style.height = `${boardH}px`;
      const svg = wrap.querySelector('.sh-hack-minigame__paths');
      if (svg) {
        svg.setAttribute('viewBox', `0 0 ${boardW} ${boardH}`);
        svg.setAttribute('width', String(boardW));
        svg.setAttribute('height', String(boardH));
      }
    }

    el.querySelectorAll('[data-action="cell"]').forEach((btn) => {
      const r = Number(btn.dataset.r);
      const c = Number(btn.dataset.c);

      btn.addEventListener('pointerenter', () => {
        this._hoverCell(r, c);
        this._paintPreview();
      }, { signal });

      btn.addEventListener('click', (event) => {
        event.preventDefault();
        if (!this._canInteract()) return;
        this._hoverCell(r, c);
        this._tryCapture();
      }, { signal });
    });

    const startBtn = el.querySelector('[data-action="start-edge"]');
    if (startBtn) {
      startBtn.addEventListener('pointerenter', () => {
        this._hoverStartEdge();
        this._paintPreview();
      }, { signal });
    }

    const undoBtn = el.querySelector('[data-action="undo"]');
    if (undoBtn) {
      undoBtn.addEventListener('click', (event) => {
        event.preventDefault();
        this._undo();
      }, { signal });
    }

    const winBtn = el.querySelector('[data-action="win-edge"]');
    if (winBtn) {
      winBtn.addEventListener('pointerenter', () => {
        this._cursorCell = { kind: 'win' };
        this._setHoverTarget({ toWin: true });
        this._paintPreview();
      }, { signal });
      winBtn.addEventListener('click', (event) => {
        event.preventDefault();
        if (!this._canInteract()) return;
        this._cursorCell = { kind: 'win' };
        this._setHoverTarget({ toWin: true });
        this._tryCapture();
      }, { signal });
    }

    const participateToggle = el.querySelector('[data-action="toggleParticipate"]');
    if (participateToggle) {
      participateToggle.addEventListener('change', () => {
        void this._setParticipate(!!participateToggle.checked);
      }, { signal });
    }

    if (wrap) {
      wrap.addEventListener('pointerleave', (event) => {
        if (wrap.contains(/** @type {Node} */ (event.relatedTarget))) return;
        this._clearHover();
        this._paintPreview();
      }, { signal });

      wrap.addEventListener('wheel', (event) => {
        if (this._hoverPaths.length < 2) return;
        event.preventDefault();
        const delta = event.deltaY > 0 ? 1 : -1;
        if (this._cyclePath(delta)) this._paintPreview();
      }, { passive: false, signal });
    }

    this._paintPreview();
    // Fit after layout; second frame catches font/header metrics
    requestAnimationFrame(() => {
      this._fitWindowToContent();
      requestAnimationFrame(() => this._fitWindowToContent());
    });
  }
}

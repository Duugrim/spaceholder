/**
 * Board state + capture application for the hacking minigame.
 */

import { activateAntivirus, maybeActivateAntivirus, tickAntivirus } from './hack-antivirus.mjs';
import { applyCaptureBonuses, clearPurpleWard } from './hack-bonuses.mjs';
import { cellKey, getCell, listPathsTo } from './hack-moves.mjs';
import { updateVision } from './hack-vision.mjs';

/** @typedef {import('./hack-moves.mjs').HackCell} HackCell */
/** @typedef {import('./hack-moves.mjs').HackMove} HackMove */
/** @typedef {import('./hack-bonuses.mjs').BonusType} BonusType */
/** @typedef {import('./hack-bonuses.mjs').EdgeDir} EdgeDir */

/**
 * @typedef {object} HackCellExt
 * @property {number} r
 * @property {number} c
 * @property {number} value
 * @property {'untouched'|'captured'|'traversed'} status
 * @property {boolean} [scannable]
 * @property {boolean} [activeAntivirus]
 * @property {boolean} [antivirusImmune] purple ward — AV cannot touch this cell
 * @property {boolean} [revealed] vision fog — sticky once true
 * @property {Partial<Record<EdgeDir, BonusType>>} [edgeBonuses]
 * @property {{ type: BonusType, rings: number }|null} [ringBonus]
 */

/**
 * @typedef {object} HackSession
 * @property {string} seed
 * @property {number} rows
 * @property {number} cols
 * @property {number} actionLimit
 * @property {number} actionUsed
 * @property {HackCellExt[][]} cells
 * @property {string[]} pathEdges
 * @property {boolean} won
 * @property {boolean} antivirusEnabled
 * @property {boolean} bonusesEnabled
 * @property {boolean} visionEnabled
 * @property {boolean} antivirusActive
 */

/**
 * @param {object} opts
 * @param {string} opts.seed
 * @param {number} opts.rows
 * @param {number} opts.cols
 * @param {number} opts.actionLimit
 * @param {number[][]} opts.values
 * @param {boolean} [opts.antivirusEnabled]
 * @param {boolean} [opts.bonusesEnabled]
 * @param {boolean} [opts.visionEnabled]
 * @param {Array<{ r: number, c: number, scannable?: boolean, edgeBonuses?: object, ringBonus?: object|null }>} [opts.overlays]
 * @returns {HackSession}
 */
export function createSession({
  seed,
  rows,
  cols,
  actionLimit,
  values,
  antivirusEnabled = false,
  bonusesEnabled = false,
  visionEnabled = false,
  overlays = [],
}) {
  /** @type {HackCellExt[][]} */
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const raw = values?.[r]?.[c];
      const value = Math.max(0, Math.min(9, Math.floor(Number(raw) || 0)));
      row.push({
        r,
        c,
        value,
        status: 'untouched',
        scannable: false,
        activeAntivirus: false,
        antivirusFatigue: false,
        antivirusImmune: false,
        revealed: false,
        edgeBonuses: {},
        ringBonus: null,
      });
    }
    cells.push(row);
  }

  for (const ov of overlays) {
    const cell = cells[ov.r]?.[ov.c];
    if (!cell) continue;
    if (ov.scannable) cell.scannable = true;
    if (ov.edgeBonuses) cell.edgeBonuses = { ...ov.edgeBonuses };
    if (ov.ringBonus) cell.ringBonus = { ...ov.ringBonus };
  }

  /** @type {HackSession} */
  const session = {
    seed: String(seed ?? ''),
    rows,
    cols,
    actionLimit: Math.max(0, Math.floor(Number(actionLimit) || 0)),
    actionUsed: 0,
    cells,
    pathEdges: [],
    won: false,
    antivirusEnabled: !!antivirusEnabled,
    bonusesEnabled: !!bonusesEnabled,
    visionEnabled: !!visionEnabled,
    antivirusActive: false,
  };
  updateVision(session);
  return session;
}

/**
 * @param {HackSession} session
 */
export function asBoardView(session) {
  return {
    rows: session.rows,
    cols: session.cols,
    cells: session.cells,
  };
}

/**
 * @param {HackSession} session
 * @param {HackMove} move
 * @returns {{ ok: true, session: HackSession } | { ok: false, reason: string }}
 */
export function applyCapture(session, move) {
  if (!session || session.won) return { ok: false, reason: 'finished' };
  if (!move) return { ok: false, reason: 'no-move' };

  const board = asBoardView(session);
  let valid = null;
  if (move.isStart) {
    valid = listPathsTo(board, { toR: move.toR, toC: move.toC, toWin: false })
      .find((m) => m.isStart);
  } else if (move.toWin) {
    valid = listPathsTo(board, { toWin: true })
      .find((m) => m.fromR === move.fromR && m.fromC === move.fromC && m.toWin);
  } else {
    valid = listPathsTo(board, { toR: move.toR, toC: move.toC, toWin: false })
      .find((m) => m.fromR === move.fromR && m.fromC === move.fromC && !m.isStart);
  }
  if (!valid) return { ok: false, reason: 'invalid' };

  /** @type {HackSession} */
  const next = cloneSession(session);
  /** @type {{ r: number, c: number }[]} */
  const touched = [];

  for (const p of valid.traversed ?? []) {
    const cell = getCell(next, p.r, p.c);
    if (!cell) continue;
    if (cell.status === 'captured') continue;
    cell.status = 'traversed';
    clearPurpleWard(cell);
    touched.push({ r: p.r, c: p.c });
  }

  if (valid.toWin) {
    next.won = true;
    next.pathEdges.push(`${cellKey(valid.fromR, valid.fromC)}>win`);
    const src = getCell(next, valid.fromR, valid.fromC);
    if (src) {
      if (valid.zeroSource) src.value = 0;
      else src.value = Math.max(0, src.value - 1);
    }
    // Win still trips AV; tick only if AV was already running (not the spawn turn)
    const activatedOnWin = maybeActivateAntivirus(next, touched);
    if (next.antivirusActive && !activatedOnWin) tickAntivirus(next);
    updateVision(next);
    return { ok: true, session: next };
  }

  const target = getCell(next, valid.toR, valid.toC);
  if (!target || target.status !== 'untouched') return { ok: false, reason: 'invalid-target' };

  const captureValue = Math.max(0, Number(valid.captureValue ?? target.value) || 0);
  target.status = 'captured';
  clearPurpleWard(target);
  next.actionUsed += captureValue;
  touched.push({ r: valid.toR, c: valid.toC });

  if (valid.isStart) {
    next.pathEdges.push(`start>${cellKey(valid.toR, valid.toC)}`);
  } else {
    const src = getCell(next, valid.fromR, valid.fromC);
    if (src) {
      if (valid.zeroSource) src.value = 0;
      else src.value = Math.max(0, src.value - 1);
    }
    next.pathEdges.push(`${cellKey(valid.fromR, valid.fromC)}>${cellKey(valid.toR, valid.toC)}`);
  }

  // Spawn turn: only place seeds. Later turns: one tick after the player move.
  const activatedNow = maybeActivateAntivirus(next, touched);
  if (next.antivirusActive && !activatedNow) tickAntivirus(next);

  // Bonuses after AV tick so value/status changes stick immediately this turn
  // (purple wards purge AV on affected cells and block future AV there).
  applyCaptureBonuses(next, valid);
  updateVision(next);

  return { ok: true, session: next };
}

/**
 * @param {HackSession} session
 * @returns {HackSession}
 */
export function cloneSession(session) {
  return {
    seed: session.seed,
    rows: session.rows,
    cols: session.cols,
    actionLimit: session.actionLimit,
    actionUsed: session.actionUsed,
    won: session.won,
    antivirusEnabled: !!session.antivirusEnabled,
    bonusesEnabled: !!session.bonusesEnabled,
    visionEnabled: !!session.visionEnabled,
    antivirusActive: !!session.antivirusActive,
    pathEdges: [...(session.pathEdges ?? [])],
    cells: session.cells.map((row) => row.map((cell) => ({
      ...cell,
      edgeBonuses: { ...(cell.edgeBonuses ?? {}) },
      ringBonus: cell.ringBonus ? { ...cell.ringBonus } : null,
      antivirusFatigue: !!cell.antivirusFatigue,
      antivirusImmune: !!cell.antivirusImmune,
      revealed: !!cell.revealed,
    }))),
  };
}

/**
 * @param {HackSession} session
 * @param {object} [preview]
 */
export function sessionToView(session, preview = null) {
  const limit = session.actionLimit;
  const used = session.actionUsed;
  const over = limit > 0 && used >= limit;
  const previewSet = {
    capture: new Set(preview?.captureKeys ?? []),
    traversed: new Set(preview?.traversedKeys ?? []),
    source: new Set(preview?.sourceKeys ?? []),
  };

  const visionOn = !!session.visionEnabled;

  const rows = session.cells.map((row) => row.map((cell) => {
    const key = cellKey(cell.r, cell.c);
    const revealed = !visionOn || !!cell.revealed;
    const edges = revealed ? (cell.edgeBonuses ?? {}) : {};
    const ring = revealed ? cell.ringBonus : null;
    return {
      r: cell.r,
      c: cell.c,
      key,
      value: revealed ? cell.value : '',
      status: cell.status,
      isCaptured: cell.status === 'captured',
      isTraversed: cell.status === 'traversed',
      isUntouched: cell.status === 'untouched',
      revealed,
      fogged: visionOn && !cell.revealed,
      scannable: revealed && !!cell.scannable,
      activeAntivirus: !!cell.activeAntivirus,
      // Ward styling only while untouched — never compete with captured/traversed.
      antivirusImmune: revealed && !!cell.antivirusImmune && cell.status === 'untouched',
      edgeN: edges.n ?? '',
      edgeE: edges.e ?? '',
      edgeS: edges.s ?? '',
      edgeW: edges.w ?? '',
      hasEdges: !!(edges.n || edges.e || edges.s || edges.w),
      ringType: ring?.type ?? '',
      ringRings: ring?.rings ?? 0,
      hasRing: !!ring?.type,
      previewCapture: previewSet.capture.has(key),
      previewTraversed: previewSet.traversed.has(key),
      previewSource: previewSet.source.has(key),
    };
  }));

  return {
    seed: session.seed,
    rows: session.rows,
    cols: session.cols,
    actionLimit: limit,
    actionUsed: used,
    actionOver: over,
    won: session.won,
    antivirusEnabled: !!session.antivirusEnabled,
    bonusesEnabled: !!session.bonusesEnabled,
    visionEnabled: visionOn,
    antivirusActive: !!session.antivirusActive,
    grid: rows,
  };
}

// Re-export for callers that activated AV externally
export { activateAntivirus };

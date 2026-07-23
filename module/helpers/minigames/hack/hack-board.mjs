/**
 * Board state + capture application for the hacking minigame.
 */

import { activateAntivirus, maybeActivateAntivirus, tickAntivirus } from './hack-antivirus.mjs';
import { applyCaptureBonuses, clearPurpleWard, listBonusTouchedCells, listPurpleTouchedKeys } from './hack-bonuses.mjs';
import { cellKey, getCell, listPathsTo } from './hack-moves.mjs';
import { updateVision, isVisionFogOn, normalizeVisionMode } from './hack-vision.mjs';

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
 * @property {boolean} [activeAntivirus] primary AV (moves left)
 * @property {boolean} [antivirusSecondary] secondary AV (moves right, dashed)
 * @property {boolean} [antivirusImmune] legacy — unused (purple no longer grants immunity)
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
 * @property {import('./hack-vision.mjs').HackVisionMode} visionMode
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
 * @param {import('./hack-vision.mjs').HackVisionMode|boolean} [opts.visionMode]
 * @param {boolean} [opts.visionEnabled] legacy alias — true→neighbors, false→off
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
  visionMode = undefined,
  visionEnabled = undefined,
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
        antivirusSecondary: false,
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
    visionMode: normalizeVisionMode(
      visionMode !== undefined ? visionMode : (visionEnabled !== undefined ? visionEnabled : 'available')
    ),
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
 * Candidate paths for a capture target (stable order from listPathsTo).
 * @param {HackSession} session
 * @param {{ toR?: number|null, toC?: number|null, toWin?: boolean }} target
 * @returns {HackMove[]}
 */
export function listCaptureCandidates(session, target) {
  const board = asBoardView(session);
  if (target?.toWin) return listPathsTo(board, { toWin: true });
  return listPathsTo(board, {
    toR: target?.toR,
    toC: target?.toC,
    toWin: false,
  });
}

/**
 * Resolve which path applyCapture should use.
 * Prefer explicit pathIndex (index into listCaptureCandidates); fall back to from/to match.
 * @param {HackSession} session
 * @param {HackMove & { pathIndex?: number }} move
 * @returns {HackMove|null}
 */
export function resolveCaptureMove(session, move) {
  if (!session || !move) return null;
  const paths = listCaptureCandidates(session, {
    toR: move.toR,
    toC: move.toC,
    toWin: !!move.toWin,
  });
  if (!paths.length) return null;

  const idx = Number(move.pathIndex);
  if (Number.isInteger(idx) && idx >= 0 && idx < paths.length) {
    return paths[idx];
  }

  if (move.isStart) {
    return paths.find((m) => m.isStart)
      ?? paths.find((m) => m.toR === move.toR && m.toC === move.toC)
      ?? null;
  }
  if (move.toWin) {
    return paths.find((m) => m.fromR === move.fromR && m.fromC === move.fromC && m.toWin)
      ?? paths[0]
      ?? null;
  }
  return paths.find((m) => m.fromR === move.fromR && m.fromC === move.fromC && !m.isStart)
    ?? paths[0]
    ?? null;
}

/**
 * @param {HackSession} session
 * @param {HackMove & { pathIndex?: number }} move
 * @returns {{ ok: true, session: HackSession, activatedAntivirus: boolean } | { ok: false, reason: string }}
 */
export function applyCapture(session, move) {
  if (!session || session.won) return { ok: false, reason: 'finished' };
  if (!move) return { ok: false, reason: 'no-move' };

  const valid = resolveCaptureMove(session, move);
  if (!valid) return { ok: false, reason: 'invalid' };
  const avWasActive = !!session.antivirusActive;

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
    return {
      ok: true,
      session: next,
      activatedAntivirus: !avWasActive && !!next.antivirusActive,
    };
  }

  const target = getCell(next, valid.toR, valid.toC);
  if (!target || target.status !== 'untouched') return { ok: false, reason: 'invalid-target' };
  if (target.activeAntivirus || target.antivirusSecondary) return { ok: false, reason: 'antivirus' };

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

  // Bonus areas count as AV trips even when the effect no-ops, except purple:
  // purple defuses scanners / purges AV and must not activate.
  const bonusTouched = listBonusTouchedCells(next, valid);
  const purpleKeys = listPurpleTouchedKeys(next, valid);
  /** @type {Map<string, { r: number, c: number }>} */
  const tripMap = new Map();
  for (const pos of touched) tripMap.set(cellKey(pos.r, pos.c), pos);
  for (const pos of bonusTouched) {
    const key = cellKey(pos.r, pos.c);
    if (purpleKeys.has(key)) continue;
    tripMap.set(key, pos);
  }

  // Spawn turn: occupy right column + scan. Later turns: move + scan.
  const activatedNow = maybeActivateAntivirus(next, [...tripMap.values()]);
  if (next.antivirusActive && !activatedNow) tickAntivirus(next);

  // Bonuses after AV tick (purple can purge agents spawned/moved this turn).
  applyCaptureBonuses(next, valid);
  updateVision(next);

  return {
    ok: true,
    session: next,
    activatedAntivirus: !avWasActive && !!next.antivirusActive,
  };
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
    visionMode: normalizeVisionMode(session.visionMode),
    antivirusActive: !!session.antivirusActive,
    pathEdges: [...(session.pathEdges ?? [])],
    cells: session.cells.map((row) => row.map((cell) => ({
      ...cell,
      edgeBonuses: { ...(cell.edgeBonuses ?? {}) },
      ringBonus: cell.ringBonus ? { ...cell.ringBonus } : null,
      antivirusFatigue: !!cell.antivirusFatigue,
      antivirusImmune: false,
      antivirusSecondary: !!cell.antivirusSecondary,
      revealed: !!cell.revealed,
    }))),
  };
}

/**
 * @param {HackSession} session
 * @param {object} [preview]
 * @param {{ debugReveal?: boolean }} [opts]
 */
export function sessionToView(session, preview = null, opts = {}) {
  const limit = session.actionLimit;
  const used = session.actionUsed;
  const over = limit > 0 && used >= limit;
  const previewSet = {
    capture: new Set(preview?.captureKeys ?? []),
    traversed: new Set(preview?.traversedKeys ?? []),
    source: new Set(preview?.sourceKeys ?? []),
  };

  const visionOn = isVisionFogOn(session);
  const visionMode = normalizeVisionMode(session.visionMode);
  const debugReveal = !!opts.debugReveal;

  const rows = session.cells.map((row) => row.map((cell) => {
    const key = cellKey(cell.r, cell.c);
    const revealed = !visionOn || !!cell.revealed;
    const fogged = visionOn && !cell.revealed;
    const debugGhost = debugReveal && fogged;
    const showContents = revealed || debugGhost;
    const edges = showContents ? (cell.edgeBonuses ?? {}) : {};
    const ring = showContents ? cell.ringBonus : null;
    return {
      r: cell.r,
      c: cell.c,
      key,
      value: showContents ? cell.value : '',
      status: cell.status,
      isCaptured: cell.status === 'captured',
      isTraversed: cell.status === 'traversed',
      isUntouched: cell.status === 'untouched',
      revealed,
      fogged,
      debugGhost,
      scannable: revealed && !!cell.scannable,
      debugScannable: debugGhost && !!cell.scannable,
      activeAntivirus: !!cell.activeAntivirus,
      antivirusSecondary: !!cell.antivirusSecondary,
      antivirusImmune: false,
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
    visionMode,
    debugRevealMap: debugReveal,
    antivirusActive: !!session.antivirusActive,
    grid: rows,
  };
}

// Re-export for callers that activated AV externally
export { activateAntivirus };

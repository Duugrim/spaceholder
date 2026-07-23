/**
 * Bonus effects for the hacking minigame.
 */

import { cellKey, getCell } from './hack-moves.mjs';

/** @typedef {'purple'|'orange'|'green'|'blue'|'yellow'} BonusType */
/** @typedef {'n'|'e'|'s'|'w'} EdgeDir */

export const BONUS_TYPES = Object.freeze(['purple', 'orange', 'green', 'blue', 'yellow']);
export const EDGE_DIRS = Object.freeze(['n', 'e', 's', 'w']);

/**
 * Which borders the path approaches (toward that side of the target).
 * Kept for UI/debug; capture applies all edge markers on the target.
 * @param {import('./hack-moves.mjs').HackMove} move
 * @returns {EdgeDir[]}
 */
export function approachEdges(move) {
  if (!move || move.toWin) return [];
  if (move.isStart) return ['w'];
  if (move.fromR == null || move.fromC == null || move.toR == null || move.toC == null) return [];
  const dr = move.toR - move.fromR;
  const dc = move.toC - move.fromC;
  /** @type {EdgeDir[]} */
  const edges = [];
  if (dr > 0) edges.push('s');
  if (dr < 0) edges.push('n');
  if (dc > 0) edges.push('e');
  if (dc < 0) edges.push('w');
  return edges;
}

/**
 * Purge antivirus from cells and defuse scanners. No permanent AV immunity.
 * Does not by itself activate antivirus (callers exclude purple cells from trip).
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {{ r: number, c: number }[]} cells
 */
export function applyPurpleWard(session, cells) {
  for (const pos of cells) {
    const cell = getCell(session, pos.r, pos.c);
    if (!cell) continue;
    cell.scannable = false;
    cell.activeAntivirus = false;
    cell.antivirusSecondary = false;
    cell.antivirusFatigue = false;
    cell.antivirusImmune = false;
  }
  if (!hasAnyAntivirus(session) && session.antivirusActive) {
    session.antivirusActive = false;
  }
}

/**
 * @param {import('./hack-board.mjs').HackSession} session
 */
function hasAnyAntivirus(session) {
  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      const cell = session.cells[r][c];
      if (cell.activeAntivirus || cell.antivirusSecondary) return true;
    }
  }
  return false;
}

/**
 * Legacy no-op: purple no longer grants sticky immunity.
 * @param {object} cell
 */
export function clearPurpleWard(cell) {
  if (cell) cell.antivirusImmune = false;
}

/**
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {number} cr
 * @param {number} cc
 * @param {number} rings
 * @param {boolean} [includeCenter]
 */
export function ringAreaCells(session, cr, cc, rings, includeCenter = true) {
  const radius = Math.max(1, Math.min(4, rings));
  /** @type {{ r: number, c: number }[]} */
  const out = [];
  for (let r = cr - radius; r <= cr + radius; r++) {
    for (let c = cc - radius; c <= cc + radius; c++) {
      if (r < 0 || c < 0 || r >= session.rows || c >= session.cols) continue;
      if (!includeCenter && r === cr && c === cc) continue;
      out.push({ r, c });
    }
  }
  return out;
}

/**
 * Edge bonus hits the ray along the cell's row (E/W) or column (N/S)
 * outward from that border — not the whole half-plane.
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {number} cr
 * @param {number} cc
 * @param {EdgeDir} edge
 */
export function edgeRayCells(session, cr, cc, edge) {
  /** @type {{ r: number, c: number }[]} */
  const out = [];
  if (edge === 'n') {
    for (let r = cr - 1; r >= 0; r--) out.push({ r, c: cc });
  } else if (edge === 's') {
    for (let r = cr + 1; r < session.rows; r++) out.push({ r, c: cc });
  } else if (edge === 'w') {
    for (let c = cc - 1; c >= 0; c--) out.push({ r: cr, c });
  } else if (edge === 'e') {
    for (let c = cc + 1; c < session.cols; c++) out.push({ r: cr, c });
  }
  return out;
}

/**
 * @param {object} cell
 * @returns {boolean}
 */
export function cellHasBonusMarkers(cell) {
  if (!cell) return false;
  if (cell.ringBonus?.type && cell.ringBonus?.rings) return true;
  const edges = cell.edgeBonuses ?? {};
  return !!(edges.n || edges.e || edges.s || edges.w);
}

/**
 * @typedef {object} BonusPulse
 * @property {BonusType} type
 * @property {{ r: number, c: number }[]} cells
 */

/**
 * @param {BonusType} type
 * @param {{ r: number, c: number }[]} cells
 * @returns {BonusPulse}
 */
function makePulse(type, cells) {
  return { type, cells };
}

/**
 * All marker areas on a cell (for hover inspection — not path-filtered).
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {number} r
 * @param {number} c
 * @returns {BonusPulse[]}
 */
export function listCellBonusMarkers(session, r, c) {
  /** @type {BonusPulse[]} */
  const pulses = [];
  if (!session?.bonusesEnabled) return pulses;
  const cell = getCell(session, r, c);
  if (!cell) return pulses;

  const edges = cell.edgeBonuses ?? {};
  for (const edge of EDGE_DIRS) {
    const type = edges[edge];
    if (!type) continue;
    pulses.push(makePulse(type, edgeRayCells(session, r, c, edge)));
  }

  const ring = cell.ringBonus;
  if (ring?.type && ring.rings) {
    // Ring ignores the bonus cell itself (the capture target).
    pulses.push(makePulse(ring.type, ringAreaCells(session, r, c, ring.rings, false)));
  }

  return pulses;
}

/**
 * Effects that would fire if this capture move is committed.
 * All edge markers on the target fire (each along its row/column ray).
 * Ring area ignores the captured cell.
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {import('./hack-moves.mjs').HackMove} move
 * @returns {BonusPulse[]}
 */
export function listBonusPulses(session, move) {
  if (!session?.bonusesEnabled || !move || move.toWin || move.toR == null || move.toC == null) {
    return [];
  }
  return listCellBonusMarkers(session, move.toR, move.toC);
}

/**
 * Simulate post-capture board slice for bonus preview (traversal + capture applied).
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {import('./hack-moves.mjs').HackMove} move
 */
function simulateMoveState(session, move) {
  /** @type {Map<string, { r: number, c: number, value: number, status: string }>} */
  const state = new Map();
  const read = (r, c) => {
    const key = cellKey(r, c);
    if (!state.has(key)) {
      const cell = getCell(session, r, c);
      state.set(key, {
        r,
        c,
        value: cell?.value ?? 0,
        status: cell?.status ?? 'untouched',
      });
    }
    return state.get(key);
  };

  for (const p of move.traversed ?? []) {
    const st = read(p.r, p.c);
    if (st.status !== 'captured') st.status = 'traversed';
  }
  if (!move.toWin && move.toR != null && move.toC != null) {
    const st = read(move.toR, move.toC);
    st.status = 'captured';
  }
  return { read };
}

/**
 * @typedef {object} BonusPreviewCell
 * @property {number} r
 * @property {number} c
 * @property {BonusType} type
 * @property {number} value
 * @property {string} status
 * @property {boolean} valueChanged
 * @property {boolean} statusChanged
 * @property {boolean} [active]
 */

/**
 * @param {BonusPulse[]} pulses
 * @param {(r: number, c: number) => { value: number, status: string }} read
 * @param {{ simulateEffects?: boolean }} [opts]
 */
function buildPreviewFromPulses(pulses, read, opts = {}) {
  /** @type {Map<string, BonusPreviewCell>} */
  const cells = new Map();
  const simulateEffects = opts.simulateEffects !== false;

  /** @type {Map<string, { value: number, status: string }>} */
  const beforeBonus = new Map();
  for (const pulse of pulses) {
    for (const pos of pulse.cells) {
      const key = cellKey(pos.r, pos.c);
      if (!beforeBonus.has(key)) {
        const st = read(pos.r, pos.c);
        beforeBonus.set(key, { value: st.value, status: st.status });
      }
    }
  }

  for (const pulse of pulses) {
    for (const pos of pulse.cells) {
      const st = read(pos.r, pos.c);
      const key = cellKey(pos.r, pos.c);
      const base = beforeBonus.get(key) ?? { value: st.value, status: st.status };

      if (simulateEffects) {
        if (pulse.type === 'orange' && st.status !== 'captured') {
          st.value = Math.max(0, (Number(st.value) || 0) - 1);
        } else if (pulse.type === 'green' && st.status !== 'captured') {
          st.value = Math.min(9, (Number(st.value) || 0) + 1);
        } else if (pulse.type === 'blue' && st.status === 'traversed') {
          st.status = 'untouched';
        } else if (pulse.type === 'yellow' && st.status === 'untouched') {
          st.status = 'traversed';
        }
      }

      cells.set(key, {
        r: pos.r,
        c: pos.c,
        type: pulse.type,
        value: st.value,
        status: st.status,
        valueChanged: st.value !== base.value,
        statusChanged: st.status !== base.status || pulse.type === 'purple',
        active: true,
      });
    }
  }

  return { purple: false, cells };
}

/**
 * Preview areas for markers on a hovered cell (no capture simulation).
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {number} r
 * @param {number} c
 */
export function previewCellBonusAreas(session, r, c) {
  const pulses = listCellBonusMarkers(session, r, c);
  if (!pulses.length) return { purple: false, cells: new Map() };
  const read = (rr, cc) => {
    const cell = getCell(session, rr, cc);
    return { value: cell?.value ?? 0, status: cell?.status ?? 'untouched' };
  };
  // Areas only — don't invent value deltas without a concrete capture path.
  return buildPreviewFromPulses(pulses, read, { simulateEffects: false });
}

/**
 * Preview final cell states after capture bonuses (no mutation).
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {import('./hack-moves.mjs').HackMove} move
 */
export function previewCaptureBonuses(session, move) {
  const pulses = listBonusPulses(session, move);
  if (!pulses.length) return { purple: false, cells: new Map() };
  const { read } = simulateMoveState(session, move);
  return buildPreviewFromPulses(pulses, (r, c) => read(r, c), { simulateEffects: true });
}

/**
 * All cells in bonus pulse areas for a capture (before markers are cleared).
 * Used for AV trip detection — a scannable cell is "touched" even if the
 * effect skips it or leaves value/status unchanged.
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {import('./hack-moves.mjs').HackMove} move
 * @returns {{ r: number, c: number }[]}
 */
export function listBonusTouchedCells(session, move) {
  /** @type {Map<string, { r: number, c: number }>} */
  const map = new Map();
  for (const pulse of listBonusPulses(session, move)) {
    for (const pos of pulse.cells) {
      map.set(cellKey(pos.r, pos.c), { r: pos.r, c: pos.c });
    }
  }
  return [...map.values()];
}

/**
 * Cells hit by purple pulses — these must not trip AV activation (scanners defused).
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {import('./hack-moves.mjs').HackMove} move
 * @returns {Set<string>}
 */
export function listPurpleTouchedKeys(session, move) {
  /** @type {Set<string>} */
  const keys = new Set();
  for (const pulse of listBonusPulses(session, move)) {
    if (pulse.type !== 'purple') continue;
    for (const pos of pulse.cells) keys.add(cellKey(pos.r, pos.c));
  }
  return keys;
}

/**
 * Apply bonuses on the freshly captured target cell (mutates session).
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {import('./hack-moves.mjs').HackMove} move
 */
export function applyCaptureBonuses(session, move) {
  const pulses = listBonusPulses(session, move);
  if (!pulses.length) return;

  for (const pulse of pulses) {
    if (pulse.type === 'purple') {
      applyPurpleWard(session, pulse.cells);
      continue;
    }
    for (const pos of pulse.cells) {
      const cell = getCell(session, pos.r, pos.c);
      if (!cell) continue;
      if (pulse.type === 'orange' && cell.status !== 'captured') {
        // −1 on untouched/traversed only — captured digits stay readable as path sources.
        cell.value = Math.max(0, (Number(cell.value) || 0) - 1);
      } else if (pulse.type === 'green' && cell.status !== 'captured') {
        cell.value = Math.min(9, (Number(cell.value) || 0) + 1);
      } else if (pulse.type === 'blue' && cell.status === 'traversed') {
        cell.status = 'untouched';
      } else if (pulse.type === 'yellow' && cell.status === 'untouched') {
        cell.status = 'traversed';
        clearPurpleWard(cell);
      }
    }
  }

  // Consumed on capture — clear markers so the UI shows the effect fired this turn.
  const target = getCell(session, move.toR, move.toC);
  if (target) {
    target.edgeBonuses = {};
    target.ringBonus = null;
  }
}

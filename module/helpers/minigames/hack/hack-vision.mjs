/**
 * Fog-of-war / vision for the hacking minigame.
 *
 * Modes:
 * - off: everything visible
 * - neighbors: reach-zone / captured cells reveal themselves and their 8-neighbors
 * - available: only captured + cells in geometric capture reach (no 8-neighbor bleed)
 *
 * Reach ignores capturable checks (disabled / AV / etc. still reveal if in zone).
 * Reveal is sticky once true. Digit 8 does not reveal its zone.
 */

import { getCell, hasCaptured, listReachCellsFrom, listStartReachCells } from './hack-moves.mjs';

/** @typedef {'off'|'neighbors'|'available'} HackVisionMode */

export const HACK_VISION_OFF = 'off';
export const HACK_VISION_NEIGHBORS = 'neighbors';
export const HACK_VISION_AVAILABLE = 'available';

export const HACK_VISION_MODES = Object.freeze([
  HACK_VISION_OFF,
  HACK_VISION_NEIGHBORS,
  HACK_VISION_AVAILABLE,
]);

/**
 * @param {unknown} raw
 * @returns {HackVisionMode}
 */
export function normalizeVisionMode(raw) {
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return HACK_VISION_NEIGHBORS;
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return HACK_VISION_OFF;
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === HACK_VISION_OFF || s === HACK_VISION_NEIGHBORS || s === HACK_VISION_AVAILABLE) return s;
  // Legacy / default: capturable cells only (no neighbor fog clear)
  return HACK_VISION_AVAILABLE;
}

/**
 * @param {import('./hack-board.mjs').HackSession|null|undefined} session
 * @returns {boolean}
 */
export function isVisionFogOn(session) {
  return !!session && normalizeVisionMode(session.visionMode) !== HACK_VISION_OFF;
}

/**
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {number} r
 * @param {number} c
 */
function markRevealed(session, r, c) {
  const cell = getCell(session, r, c);
  if (cell) cell.revealed = true;
}

/**
 * 8-neighborhood (around the cell).
 * @param {import('./hack-board.mjs').HackSession} session
 * @param {number} r
 * @param {number} c
 */
function markNeighbors(session, r, c) {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      markRevealed(session, r + dr, c + dc);
    }
  }
}

/**
 * Recompute sticky vision reveals for the current board state.
 * @param {import('./hack-board.mjs').HackSession} session
 */
export function updateVision(session) {
  if (!session) return;

  const mode = normalizeVisionMode(session.visionMode);
  session.visionMode = mode;

  if (mode === HACK_VISION_OFF) {
    for (let r = 0; r < session.rows; r++) {
      for (let c = 0; c < session.cols; c++) {
        session.cells[r][c].revealed = true;
      }
    }
    return;
  }

  const revealTargetNeighbors = mode === HACK_VISION_NEIGHBORS;

  // Session shape matches HackBoardView (rows/cols/cells).
  const board = session;

  // Captured cells are always visible.
  // Their 8-neighbors only in "neighbors" mode (legacy fog).
  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      if (session.cells[r][c].status !== 'captured') continue;
      markRevealed(session, r, c);
      if (revealTargetNeighbors) markNeighbors(session, r, c);
    }
  }

  // Left-edge start zone: entire column 0 (even if currently inactive).
  for (const pos of listStartReachCells(board)) {
    markRevealed(session, pos.r, pos.c);
    if (revealTargetNeighbors) markNeighbors(session, pos.r, pos.c);
  }

  if (!hasCaptured(board)) return;

  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      const cell = session.cells[r][c];
      if (cell.status !== 'captured') continue;
      // Digit 8 is a global backdoor — do not reveal every reach cell.
      if (cell.value === 8) continue;

      for (const pos of listReachCellsFrom(board, r, c)) {
        markRevealed(session, pos.r, pos.c);
        if (revealTargetNeighbors) markNeighbors(session, pos.r, pos.c);
      }
    }
  }
}

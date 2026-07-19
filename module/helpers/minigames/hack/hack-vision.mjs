/**
 * Fog-of-war / vision for the hacking minigame.
 *
 * When vision is enabled, digits and bonus markers stay hidden until a cell is
 * revealed. Reveal is sticky. Digit 5 never reveals its capture targets — only
 * cells around the 5 itself.
 */

import { getCell, hasCaptured, listMovesFrom, listStartMoves } from './hack-moves.mjs';

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

  if (!session.visionEnabled) {
    for (let r = 0; r < session.rows; r++) {
      for (let c = 0; c < session.cols; c++) {
        session.cells[r][c].revealed = true;
      }
    }
    return;
  }

  // Session shape matches HackBoardView (rows/cols/cells).
  const board = session;

  // Captured cells and their neighbors are always visible.
  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      if (session.cells[r][c].status !== 'captured') continue;
      markRevealed(session, r, c);
      markNeighbors(session, r, c);
    }
  }

  // Left-edge starts stay available throughout the game.
  for (const move of listStartMoves(board)) {
    if (move.toR == null || move.toC == null) continue;
    markRevealed(session, move.toR, move.toC);
    markNeighbors(session, move.toR, move.toC);
  }

  if (!hasCaptured(board)) return;

  for (let r = 0; r < session.rows; r++) {
    for (let c = 0; c < session.cols; c++) {
      const cell = session.cells[r][c];
      if (cell.status !== 'captured') continue;

      for (const move of listMovesFrom(board, r, c)) {
        if (move.toWin || move.toR == null || move.toC == null) continue;
        markRevealed(session, move.toR, move.toC);
        markNeighbors(session, move.toR, move.toC);
      }
    }
  }
}

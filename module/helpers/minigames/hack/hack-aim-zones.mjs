/**
 * Aim-zone overlays for hacking minigame digits.
 */

import { getCell, listMovesFrom } from './hack-moves.mjs';

/**
 * @typedef {object} AimRect
 * @property {'rect'} type
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {boolean} [soft]
 */

/**
 * @typedef {object} AimLine
 * @property {'line'} type
 * @property {number} x1
 * @property {number} y1
 * @property {number} x2
 * @property {number} y2
 * @property {number} [width]
 */

/** @typedef {AimRect|AimLine} AimShape */

/**
 * @param {number} cellSize
 * @param {number} cellGap
 * @param {number} r0
 * @param {number} c0
 * @param {number} r1 inclusive
 * @param {number} c1 inclusive
 * @returns {AimRect}
 */
function rectCells(cellSize, cellGap, r0, c0, r1, c1) {
  const pitch = cellSize + cellGap;
  const top = Math.min(r0, r1);
  const left = Math.min(c0, c1);
  const bottom = Math.max(r0, r1);
  const right = Math.max(c0, c1);
  return {
    type: 'rect',
    x: left * pitch,
    y: top * pitch,
    w: (right - left) * pitch + cellSize,
    h: (bottom - top) * pitch + cellSize,
  };
}

/**
 * Enumerate legal moves as if (r,c) were already captured (for aim preview).
 * @param {import('./hack-moves.mjs').HackBoardView} board
 * @param {number} r
 * @param {number} c
 */
function listAimMoves(board, r, c) {
  const cells = board.cells.map((row, ri) => row.map((cell, ci) => (
    ri === r && ci === c ? { ...cell, status: /** @type {const} */ ('captured') } : cell
  )));
  return listMovesFrom({ rows: board.rows, cols: board.cols, cells }, r, c);
}

/**
 * One frame per valid capture target (+ win-edge flag).
 * @param {import('./hack-moves.mjs').HackBoardView} board
 * @param {number} r
 * @param {number} c
 * @param {number} cellSize
 * @param {number} cellGap
 * @returns {{ shapes: AimShape[], includesWinEdge: boolean }}
 */
function framesFromMoves(board, r, c, cellSize, cellGap) {
  /** @type {AimShape[]} */
  const shapes = [];
  let includesWinEdge = false;
  for (const move of listAimMoves(board, r, c)) {
    if (move.toWin) {
      includesWinEdge = true;
      continue;
    }
    if (move.toR == null || move.toC == null) continue;
    shapes.push(rectCells(cellSize, cellGap, move.toR, move.toC, move.toR, move.toC));
  }
  return { shapes, includesWinEdge };
}

/**
 * Aim shapes for a cell at (r,c) with its current digit.
 * @param {import('./hack-moves.mjs').HackBoardView} board
 * @param {number} r
 * @param {number} c
 * @param {{ cellSize: number, cellGap: number, winEdgeWidth?: number, gridOriginX?: number, boardGap?: number }} geom
 * @returns {{ shapes: AimShape[], includesWinEdge: boolean }}
 */
export function getAimZone(board, r, c, geom) {
  const cell = getCell(board, r, c);
  if (!cell) return { shapes: [], includesWinEdge: false };

  const { cellSize, cellGap } = geom;
  const ox = geom.gridOriginX ?? 0;
  const value = Math.max(0, Math.min(9, Number(cell.value) || 0));
  const rows = board.rows;
  const cols = board.cols;

  /** @param {{ shapes: AimShape[], includesWinEdge: boolean }} result */
  const withOrigin = (result) => ({
    shapes: offsetShapes(result.shapes, ox),
    includesWinEdge: result.includesWinEdge,
  });

  switch (value) {
    case 0:
      return { shapes: [], includesWinEdge: false };

    case 1:
    case 2:
    case 3:
    case 4:
    case 6:
    case 9:
      return withOrigin(framesFromMoves(board, r, c, cellSize, cellGap));

    case 5: {
      /** @type {AimShape[]} */
      const shapes = [];
      let includesWinEdge = false;
      if (c + 1 < cols) {
        const right = Math.min(cols - 1, c + 2);
        shapes.push(rectCells(cellSize, cellGap, r, c + 1, r, right));
      }
      if (c >= cols - 2) includesWinEdge = true;
      return withOrigin({ shapes, includesWinEdge });
    }

    case 7: {
      // Full vertical column
      return withOrigin({
        shapes: [rectCells(cellSize, cellGap, 0, c, rows - 1, c)],
        includesWinEdge: false,
      });
    }

    case 8: {
      // Whole board except the last two columns
      const maxCol = cols - 3;
      if (maxCol < 0) return { shapes: [], includesWinEdge: false };
      return withOrigin({
        shapes: [rectCells(cellSize, cellGap, 0, 0, rows - 1, maxCol)],
        includesWinEdge: false,
      });
    }

    default:
      return { shapes: [], includesWinEdge: false };
  }
}

/**
 * @param {AimShape[]} shapes
 * @param {number} ox
 */
function offsetShapes(shapes, ox) {
  if (!ox) return shapes;
  return shapes.map((shape) => {
    if (shape.type === 'rect') return { ...shape, x: shape.x + ox };
    if (shape.type === 'line') return { ...shape, x1: shape.x1 + ox, x2: shape.x2 + ox };
    return shape;
  });
}

/**
 * Pixel rect of the win-edge strip (to the right of the grid).
 * @param {number} cols
 * @param {number} rows
 * @param {{ cellSize: number, cellGap: number, winEdgeWidth: number, gridOriginX?: number, boardGap?: number }} geom
 * @returns {AimRect}
 */
export function winEdgeRect(cols, rows, geom) {
  const { cellSize, cellGap, winEdgeWidth } = geom;
  const pitch = cellSize + cellGap;
  const gridW = cols * pitch - cellGap;
  const ox = geom.gridOriginX ?? 0;
  const gap = geom.boardGap ?? 8;
  return {
    type: 'rect',
    x: ox + gridW + gap,
    y: 0,
    w: winEdgeWidth,
    h: rows * pitch - cellGap,
  };
}

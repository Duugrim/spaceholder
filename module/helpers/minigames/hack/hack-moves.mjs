/**
 * Pure move enumeration for hacking minigame digits 0–9.
 */

/** @typedef {'untouched'|'captured'|'traversed'} CellStatus */

/**
 * @typedef {object} HackCell
 * @property {number} r
 * @property {number} c
 * @property {number} value
 * @property {CellStatus} status
 */

/**
 * @typedef {object} HackBoardView
 * @property {number} rows
 * @property {number} cols
 * @property {HackCell[][]} cells
 */

/**
 * @typedef {object} HackMove
 * @property {number|null} fromR
 * @property {number|null} fromC
 * @property {number|null} toR
 * @property {number|null} toC
 * @property {boolean} toWin
 * @property {boolean} isStart
 * @property {{ r: number, c: number }[]} traversed
 * @property {number} sourceValue
 * @property {number} [captureValue] value added to action counter
 */

export function cellKey(r, c) {
  return `${r},${c}`;
}

/**
 * @param {HackBoardView} board
 * @param {number} r
 * @param {number} c
 * @returns {HackCell|null}
 */
export function getCell(board, r, c) {
  if (r < 0 || c < 0 || r >= board.rows || c >= board.cols) return null;
  return board.cells[r]?.[c] ?? null;
}

function inBounds(board, r, c) {
  return r >= 0 && c >= 0 && r < board.rows && c < board.cols;
}

/**
 * Target is capturable only if untouched (or win edge).
 * @param {HackBoardView} board
 * @param {number} r
 * @param {number} c
 */
function isCapturable(board, r, c) {
  const cell = getCell(board, r, c);
  return !!cell && cell.status === 'untouched';
}

/**
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @param {number|null} toR
 * @param {number|null} toC
 * @param {boolean} toWin
 * @param {{ r: number, c: number }[]} traversed
 * @param {object} [extra]
 * @returns {HackMove|null}
 */
function makeMove(board, fromR, fromC, toR, toC, toWin, traversed, extra = {}) {
  if (toWin) {
    return {
      fromR,
      fromC,
      toR: null,
      toC: board.cols,
      toWin: true,
      isStart: false,
      traversed: traversed.filter((p) => inBounds(board, p.r, p.c)),
      sourceValue: getCell(board, fromR, fromC)?.value ?? 0,
      captureValue: 0,
      ...extra,
    };
  }
  if (!isCapturable(board, toR, toC)) return null;
  const target = getCell(board, toR, toC);
  return {
    fromR,
    fromC,
    toR,
    toC,
    toWin: false,
    isStart: false,
    traversed: traversed.filter((p) => inBounds(board, p.r, p.c) && !(p.r === toR && p.c === toC)),
    sourceValue: getCell(board, fromR, fromC)?.value ?? 0,
    captureValue: target?.value ?? 0,
    ...extra,
  };
}

/**
 * Forward one cell (digit 1), including win edge.
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
function movesDigit1(board, fromR, fromC) {
  return movesForwardOne(board, fromR, fromC);
}

/**
 * Diagonal forward one cell (digit 2): +1 col, ±1 row.
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
function movesDigit2(board, fromR, fromC) {
  const out = [];
  const toC = fromC + 1;
  if (toC === board.cols) {
    out.push(makeMove(board, fromR, fromC, null, null, true, []));
    return out;
  }
  for (const dRow of [-1, 1]) {
    const m = makeMove(board, fromR, fromC, fromR + dRow, toC, false, []);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Forward one, or vertical one cell (digit 3).
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
function movesDigit3(board, fromR, fromC) {
  const out = [...movesForwardOne(board, fromR, fromC)];
  for (const dR of [-1, 1]) {
    const m = makeMove(board, fromR, fromC, fromR + dR, fromC, false, []);
    if (m) out.push(m);
  }
  return out;
}

/**
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
function movesForwardOne(board, fromR, fromC) {
  const out = [];
  if (fromC + 1 === board.cols) {
    out.push(makeMove(board, fromR, fromC, null, null, true, []));
  } else {
    const m = makeMove(board, fromR, fromC, fromR, fromC + 1, false, []);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Vertical ray any distance; cells between become traversed.
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
function movesVerticalRay(board, fromR, fromC) {
  const out = [];
  for (const dir of [-1, 1]) {
    const traversed = [];
    for (let r = fromR + dir; r >= 0 && r < board.rows; r += dir) {
      const move = makeMove(board, fromR, fromC, r, fromC, false, [...traversed]);
      if (move) out.push(move);
      traversed.push({ r, c: fromC });
    }
  }
  return out;
}

/**
 * Horizontal right 1 or 2 (digit 5 / legacy digit 2), including win edge.
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
function movesHorizontalRight12(board, fromR, fromC) {
  const out = [];
  if (fromC + 1 === board.cols) {
    out.push(makeMove(board, fromR, fromC, null, null, true, []));
  } else {
    const m = makeMove(board, fromR, fromC, fromR, fromC + 1, false, []);
    if (m) out.push(m);
  }
  if (fromC + 2 === board.cols) {
    out.push(makeMove(board, fromR, fromC, null, null, true, [{ r: fromR, c: fromC + 1 }]));
  } else if (fromC + 2 < board.cols) {
    const m = makeMove(board, fromR, fromC, fromR, fromC + 2, false, [{ r: fromR, c: fromC + 1 }]);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Diagonal left unlimited (digit 6 / legacy digit 3).
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
function movesDiagonalLeftRay(board, fromR, fromC) {
  const out = [];
  for (const dRow of [-1, 1]) {
    const traversed = [];
    let r = fromR + dRow;
    let c = fromC - 1;
    while (r >= 0 && r < board.rows && c >= 0) {
      const move = makeMove(board, fromR, fromC, r, c, false, [...traversed]);
      if (move) out.push(move);
      traversed.push({ r, c });
      r += dRow;
      c -= 1;
    }
  }
  return out;
}

/**
 * Digit 4: +1 col, ±1 (diagonal) or ±2 (knight).
 * Diagonal: traversed = vertical neighbor in that direction.
 * Knight: traversed = vertical + diagonal cells.
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
function movesDigit4(board, fromR, fromC) {
  const out = [];
  const targets = [
    { dRow: -1, knight: false },
    { dRow: 1, knight: false },
    { dRow: -2, knight: true },
    { dRow: 2, knight: true },
  ];
  for (const { dRow, knight } of targets) {
    const toR = fromR + dRow;
    const toC = fromC + 1;
    const sign = dRow < 0 ? -1 : 1;
    /** @type {{ r: number, c: number }[]} */
    let traversed;
    if (!knight) {
      traversed = [{ r: fromR + sign, c: fromC }];
    } else {
      traversed = [
        { r: fromR + sign, c: fromC },
        { r: fromR + sign, c: fromC + 1 },
      ];
    }
    if (toC === board.cols) {
      out.push(makeMove(board, fromR, fromC, null, null, true, traversed));
    } else if (inBounds(board, toR, toC)) {
      const m = makeMove(board, fromR, fromC, toR, toC, false, traversed);
      if (m) out.push(m);
    }
  }
  return out;
}

/**
 * Digit 5: horizontal right 1 or 2 (legacy digit 2).
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
function movesDigit5(board, fromR, fromC) {
  return movesHorizontalRight12(board, fromR, fromC);
}

/**
 * Digit 6: diagonal left unlimited (legacy digit 3).
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
function movesDigit6(board, fromR, fromC) {
  return movesDiagonalLeftRay(board, fromR, fromC);
}

/**
 * Digit 7: vertical ray any distance (legacy digit 1).
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
function movesDigit7(board, fromR, fromC) {
  return movesVerticalRay(board, fromR, fromC);
}

/**
 * Chebyshev distance.
 * @param {number} r1
 * @param {number} c1
 * @param {number} r2
 * @param {number} c2
 */
export function chebyshev(r1, c1, r2, c2) {
  return Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2));
}

/** Fixed wipe half-extent for digit 8 → 3×3 around source and target. */
export const DIGIT8_WIPE_RADIUS = 1;

/**
 * Digit 8: any capturable cell except the last two columns and win edge.
 * Wipe is a fixed 3×3 around source and target (no distance scaling).
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
function movesDigit8(board, fromR, fromC) {
  const out = [];
  const maxCol = board.cols - 3; // exclude last two columns
  if (maxCol < 0) return out;
  for (let r = 0; r < board.rows; r++) {
    for (let c = 0; c <= maxCol; c++) {
      if (r === fromR && c === fromC) continue;
      if (!isCapturable(board, r, c)) continue;
      const traversed = collectWipeCells(board, fromR, fromC, r, c, DIGIT8_WIPE_RADIUS);
      const m = makeMove(board, fromR, fromC, r, c, false, traversed, {
        wipeRadius: DIGIT8_WIPE_RADIUS,
      });
      if (m) out.push(m);
    }
  }
  return out;
}

/**
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @param {number} toR
 * @param {number} toC
 * @param {number} radius
 * @returns {{ r: number, c: number }[]}
 */
export function collectWipeCells(board, fromR, fromC, toR, toC, radius) {
  /** @type {Map<string, { r: number, c: number }>} */
  const map = new Map();
  const addSquare = (cr, cc) => {
    for (let r = cr - radius; r <= cr + radius; r++) {
      for (let c = cc - radius; c <= cc + radius; c++) {
        if (!inBounds(board, r, c)) continue;
        if (r === toR && c === toC) continue; // target becomes captured
        if (r === fromR && c === fromC) continue; // source stays captured
        map.set(cellKey(r, c), { r, c });
      }
    }
  };
  addSquare(fromR, fromC);
  addSquare(toR, toC);
  return [...map.values()];
}

/**
 * Digit 9: any other 9, or vertical neighbor (legacy digit 6).
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
function movesDigit9(board, fromR, fromC) {
  const out = [];
  for (let r = 0; r < board.rows; r++) {
    for (let c = 0; c < board.cols; c++) {
      if (r === fromR && c === fromC) continue;
      const cell = getCell(board, r, c);
      if (!cell || cell.value !== 9) continue;
      const m = makeMove(board, fromR, fromC, r, c, false, []);
      if (m) out.push(m);
    }
  }
  for (const dR of [-1, 1]) {
    const m = makeMove(board, fromR, fromC, fromR + dR, fromC, false, []);
    if (m) out.push(m);
  }
  return out;
}

/**
 * All outgoing moves from a captured cell.
 * @param {HackBoardView} board
 * @param {number} fromR
 * @param {number} fromC
 * @returns {HackMove[]}
 */
export function listMovesFrom(board, fromR, fromC) {
  const cell = getCell(board, fromR, fromC);
  if (!cell || cell.status !== 'captured') return [];
  const value = Math.max(0, Math.min(9, Number(cell.value) || 0));
  switch (value) {
    case 0: return [];
    case 1: return movesDigit1(board, fromR, fromC);
    case 2: return movesDigit2(board, fromR, fromC);
    case 3: return movesDigit3(board, fromR, fromC);
    case 4: return movesDigit4(board, fromR, fromC);
    case 5: return movesDigit5(board, fromR, fromC);
    case 6: return movesDigit6(board, fromR, fromC);
    case 7: return movesDigit7(board, fromR, fromC);
    case 8: return movesDigit8(board, fromR, fromC);
    case 9: return movesDigit9(board, fromR, fromC);
    default: return [];
  }
}

/**
 * Start moves: capture any untouched cell in the leftmost column.
 * @param {HackBoardView} board
 * @returns {HackMove[]}
 */
export function listStartMoves(board) {
  const out = [];
  for (let r = 0; r < board.rows; r++) {
    if (!isCapturable(board, r, 0)) continue;
    const cell = getCell(board, r, 0);
    out.push({
      fromR: null,
      fromC: null,
      toR: r,
      toC: 0,
      toWin: false,
      isStart: true,
      traversed: [],
      sourceValue: 0,
      captureValue: cell?.value ?? 0,
    });
  }
  return out;
}

/**
 * Whether the board has any captured cells (post-start).
 * @param {HackBoardView} board
 */
export function hasCaptured(board) {
  for (let r = 0; r < board.rows; r++) {
    for (let c = 0; c < board.cols; c++) {
      if (board.cells[r][c].status === 'captured') return true;
    }
  }
  return false;
}

/**
 * All valid paths that can capture a given target (or win edge).
 * Sorted by source value descending (higher first).
 * Entry from the left edge stays available for every untouched cell in column 0.
 * @param {HackBoardView} board
 * @param {{ toR?: number|null, toC?: number|null, toWin?: boolean }} target
 * @returns {HackMove[]}
 */
export function listPathsTo(board, target) {
  const toWin = !!target.toWin;
  const toR = target.toR;
  const toC = target.toC;

  /** @type {HackMove[]} */
  const paths = [];

  // Left-edge entry: any number of starts into remaining untouched column-0 cells.
  if (!toWin) {
    for (const move of listStartMoves(board)) {
      if (move.toR === toR && move.toC === toC) paths.push(move);
    }
  }

  if (hasCaptured(board)) {
    for (let r = 0; r < board.rows; r++) {
      for (let c = 0; c < board.cols; c++) {
        if (board.cells[r][c].status !== 'captured') continue;
        for (const move of listMovesFrom(board, r, c)) {
          if (toWin) {
            if (move.toWin) paths.push(move);
          } else if (!move.toWin && move.toR === toR && move.toC === toC) {
            paths.push(move);
          }
        }
      }
    }
  }

  paths.sort((a, b) => {
    const dv = (b.sourceValue ?? 0) - (a.sourceValue ?? 0);
    if (dv !== 0) return dv;
    // Prefer digit-sourced paths over left-edge entry when values tie.
    if (!!a.isStart !== !!b.isStart) return a.isStart ? 1 : -1;
    const dr = (a.fromR ?? a.toR ?? 0) - (b.fromR ?? b.toR ?? 0);
    if (dr !== 0) return dr;
    return (a.fromC ?? a.toC ?? 0) - (b.fromC ?? b.toC ?? 0);
  });
  return paths;
}

/**
 * All moves currently available (left-edge starts + paths from captured cells).
 * @param {HackBoardView} board
 * @returns {HackMove[]}
 */
export function listAllMoves(board) {
  /** @type {HackMove[]} */
  const all = [...listStartMoves(board)];
  if (!hasCaptured(board)) return all;
  for (let r = 0; r < board.rows; r++) {
    for (let c = 0; c < board.cols; c++) {
      if (board.cells[r][c].status !== 'captured') continue;
      all.push(...listMovesFrom(board, r, c));
    }
  }
  return all;
}

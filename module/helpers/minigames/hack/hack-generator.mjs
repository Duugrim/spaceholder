/**
 * Seeded board generation for the hacking minigame.
 */

import { BONUS_TYPES, EDGE_DIRS } from './hack-bonuses.mjs';
import { applyCapture, createSession } from './hack-board.mjs';
import { createRng, rngInt, rngWeighted } from './rng.mjs';
import { HACK_VISION_AVAILABLE, normalizeVisionMode } from './hack-vision.mjs';

/**
 * Baseline weights at the right edge of the board.
 * No zeros. Higher digits rarer, but not vanishingly so.
 */
const DIGIT_WEIGHTS = Object.freeze([
  { value: 1, weight: 20 },
  { value: 2, weight: 22 },
  { value: 3, weight: 13 },
  { value: 4, weight: 15 },
  { value: 5, weight: 12 },
  { value: 6, weight: 11 },
  { value: 7, weight: 8 },
  { value: 8, weight: 5 },
  { value: 9, weight: 2 },
]);

export const DEFAULT_HACK_ROWS = 10;
export const DEFAULT_HACK_COLS = 14;
export const DEFAULT_HACK_ACTION_LIMIT = 40;

/**
 * @param {number} digit
 * @param {number} t
 * @returns {number}
 */
function digitColumnFactor(digit, t) {
  const x = Math.max(0, Math.min(1, t));
  switch (digit) {
    case 1:
    case 2:
      return 1 + (1 - x) * 0.35;
    case 3:
      return 0.22 + 0.78 * (x ** 0.45);
    case 4:
      return 0.35 + 0.65 * (x ** 0.4);
    case 5:
      return 0.08 + 0.92 * (x ** 0.75);
    case 6:
      return 0.05 + 0.95 * (x ** 0.9);
    case 7:
      return 0.04 + 0.96 * (x ** 1.25);
    case 8:
      return 0.02 + 0.98 * (x ** 2.2);
    case 9:
      return 0.01 + 0.99 * (x ** 2.8);
    default:
      return x;
  }
}

/**
 * @param {number} columnIndex
 * @param {number} cols
 */
function weightsForColumn(columnIndex, cols) {
  const t = cols <= 1 ? 1 : columnIndex / (cols - 1);
  return DIGIT_WEIGHTS.map(({ value, weight }) => ({
    value,
    weight: Math.max(0, weight * digitColumnFactor(value, t)),
  }));
}

/**
 * @param {() => number} rng
 * @param {number} rows
 * @param {number} cols
 * @returns {Array<{ r: number, c: number, scannable: true }>}
 */
function generateScannable(rng, rows, cols) {
  /** @type {Array<{ r: number, c: number, scannable: true }>} */
  const out = [];
  // One scannable per column except the two leftmost
  for (let c = 2; c < cols; c++) {
    out.push({ r: rngInt(rng, 0, rows - 1), c, scannable: true });
  }
  return out;
}

/**
 * @param {() => number} rng
 * @returns {import('./hack-bonuses.mjs').BonusType}
 */
function pickBonusType(rng) {
  return /** @type {import('./hack-bonuses.mjs').BonusType} */ (
    rngWeighted(rng, BONUS_TYPES.map((value) => ({ value, weight: 1 })))
  );
}

/** Independent chance per edge side (keeps overall density, avoids stacked mega-cells). */
const EDGE_BONUS_P = 0.055;
/** Independent chance per cell for a ring marker. */
const RING_BONUS_P = 0.07;

/**
 * Each edge and the ring are rolled independently so "has a bonus" no longer
 * clusters many markers onto the same cell.
 * @param {() => number} rng
 * @param {number} rows
 * @param {number} cols
 */
function generateBonuses(rng, rows, cols) {
  /** @type {Map<string, { r: number, c: number, edgeBonuses: object, ringBonus: object|null }>} */
  const map = new Map();

  const ensure = (r, c) => {
    const key = `${r},${c}`;
    if (!map.has(key)) map.set(key, { r, c, edgeBonuses: {}, ringBonus: null });
    return map.get(key);
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let entry = null;
      for (const edge of EDGE_DIRS) {
        if (rng() >= EDGE_BONUS_P) continue;
        if (!entry) entry = ensure(r, c);
        entry.edgeBonuses[edge] = pickBonusType(rng);
      }
      if (rng() < RING_BONUS_P) {
        if (!entry) entry = ensure(r, c);
        let rings = 1;
        if (rng() < 0.35) rings = 2;
        if (rings === 2 && rng() < 0.25) rings = 3;
        if (rings === 3 && rng() < 0.15) rings = 4;
        entry.ringBonus = { type: pickBonusType(rng), rings };
      }
    }
  }

  return [...map.values()];
}

/**
 * Digit 9 needs peers to be useful — guarantee a minimum count.
 * Prefers the right half of the board (where 9s naturally spawn).
 * @param {() => number} rng
 * @param {number[][]} values
 * @param {number} rows
 * @param {number} cols
 * @param {number} minimum
 */
function ensureMinimumNines(rng, values, rows, cols, minimum) {
  /** @type {{ r: number, c: number }[]} */
  const nines = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (values[r][c] === 9) nines.push({ r, c });
    }
  }
  let need = Math.max(0, minimum - nines.length);
  if (need <= 0) return;

  const mid = Math.floor(cols / 2);
  /** @type {{ r: number, c: number }[]} */
  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = mid; c < cols; c++) {
      if (values[r][c] !== 9) candidates.push({ r, c });
    }
  }
  // Fallback: whole board if the right half is somehow full of 9s already.
  if (candidates.length < need) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < mid; c++) {
        if (values[r][c] !== 9) candidates.push({ r, c });
      }
    }
  }

  while (need > 0 && candidates.length) {
    const idx = rngInt(rng, 0, candidates.length - 1);
    const pick = candidates.splice(idx, 1)[0];
    values[pick.r][pick.c] = 9;
    need -= 1;
  }
}

/**
 * @param {object} [opts]
 * @param {string|number} [opts.seed]
 * @param {number} [opts.rows]
 * @param {number} [opts.cols]
 * @param {number} [opts.actionLimit]
 * @param {boolean} [opts.antivirus]
 * @param {boolean} [opts.bonuses]
 * @param {import('./hack-vision.mjs').HackVisionMode|boolean} [opts.vision]
 * @param {import('./hack-vision.mjs').HackVisionMode|boolean} [opts.visionMode]
 * @returns {import('./hack-board.mjs').HackSession}
 */
export function generateHackSession(opts = {}) {
  const seed = String(opts.seed ?? Date.now());
  const rows = clampInt(opts.rows, 3, 16, DEFAULT_HACK_ROWS);
  const cols = clampInt(opts.cols, 3, 20, DEFAULT_HACK_COLS);
  const actionLimit = clampInt(opts.actionLimit, 1, 999, DEFAULT_HACK_ACTION_LIMIT);
  const antivirusEnabled = opts.antivirus !== false;
  const bonusesEnabled = opts.bonuses !== false;
  const visionMode = normalizeVisionMode(
    opts.visionMode !== undefined
      ? opts.visionMode
      : (opts.vision !== undefined ? opts.vision : HACK_VISION_AVAILABLE)
  );
  const rng = createRng(`${seed}|${rows}x${cols}|av${antivirusEnabled ? 1 : 0}|bn${bonusesEnabled ? 1 : 0}`);

  /** @type {number[][]} */
  const values = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push(rngWeighted(rng, weightsForColumn(c, cols)));
    }
    values.push(row);
  }

  // Digits that can reach the win edge from the last / penultimate column.
  let hasWinDigit = false;
  for (let r = 0; r < rows; r++) {
    const last = values[r][cols - 1];
    if (last === 1 || last === 2 || last === 3 || last === 4 || last === 5) hasWinDigit = true;
    if (cols >= 2 && values[r][cols - 2] === 5) hasWinDigit = true;
  }
  if (!hasWinDigit) {
    values[Math.floor(rows / 2)][cols - 1] = 1;
  }

  ensureMinimumNines(rng, values, rows, cols, 2);

  /** @type {Array<object>} */
  const overlays = [];
  if (antivirusEnabled) {
    overlays.push(...generateScannable(rng, rows, cols));
  }
  if (bonusesEnabled) {
    overlays.push(...generateBonuses(rng, rows, cols));
  }

  // Merge overlays on same cell
  /** @type {Map<string, object>} */
  const merged = new Map();
  for (const ov of overlays) {
    const key = `${ov.r},${ov.c}`;
    const prev = merged.get(key) ?? { r: ov.r, c: ov.c, edgeBonuses: {}, ringBonus: null, scannable: false };
    if (ov.scannable) prev.scannable = true;
    if (ov.edgeBonuses) prev.edgeBonuses = { ...prev.edgeBonuses, ...ov.edgeBonuses };
    if (ov.ringBonus) prev.ringBonus = ov.ringBonus;
    merged.set(key, prev);
  }

  return createSession({
    seed,
    rows,
    cols,
    actionLimit,
    values,
    antivirusEnabled,
    bonusesEnabled,
    visionMode,
    overlays: [...merged.values()],
  });
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * @returns {string}
 */
export function randomHackSeed() {
  const a = Math.floor(Math.random() * 1e9).toString(36);
  const b = Math.floor(Math.random() * 1e9).toString(36);
  return `${a}${b}`.slice(0, 12);
}

/**
 * @typedef {object} HackLoggedMove
 * @property {number|null} [fromR]
 * @property {number|null} [fromC]
 * @property {number|null} [toR]
 * @property {number|null} [toC]
 * @property {boolean} [toWin]
 * @property {boolean} [isStart]
 * @property {number} [pathIndex]
 */

/**
 * Rebuild a session from generation params + ordered move log.
 * @param {object} params
 * @param {HackLoggedMove[]} [moves]
 * @returns {{
 *   session: import('./hack-board.mjs').HackSession,
 *   stats: { actionUsed: number, actionLimit: number, antivirusTriggered: boolean },
 *   ok: boolean,
 *   failedAt: number
 * }}
 */
export function replayHackSession(params, moves = []) {
  let session = generateHackSession(params);
  let antivirusTriggered = false;
  const list = Array.isArray(moves) ? moves : [];
  let failedAt = -1;

  for (let i = 0; i < list.length; i += 1) {
    const logged = list[i] || {};
    const result = applyCapture(session, {
      fromR: logged.fromR ?? null,
      fromC: logged.fromC ?? null,
      toR: logged.toR ?? null,
      toC: logged.toC ?? null,
      toWin: !!logged.toWin,
      isStart: !!logged.isStart,
      pathIndex: Number.isInteger(Number(logged.pathIndex)) ? Number(logged.pathIndex) : undefined,
      traversed: [],
    });
    if (!result.ok) {
      failedAt = i;
      break;
    }
    session = result.session;
    if (result.activatedAntivirus) antivirusTriggered = true;
  }

  if (session.antivirusActive) antivirusTriggered = true;

  return {
    session,
    stats: {
      actionUsed: session.actionUsed,
      actionLimit: session.actionLimit,
      antivirusTriggered,
    },
    ok: failedAt < 0,
    failedAt,
  };
}

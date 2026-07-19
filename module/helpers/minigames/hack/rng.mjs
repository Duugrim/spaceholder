/**
 * Deterministic PRNG helpers for the hacking minigame.
 */

/**
 * Hash a string/number seed into a 32-bit unsigned int.
 * @param {string|number} seed
 * @returns {number}
 */
export function hashSeed(seed) {
  const str = String(seed ?? '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Mulberry32 PRNG. Returns a function that yields [0, 1).
 * @param {string|number} seed
 * @returns {() => number}
 */
export function createRng(seed) {
  let state = hashSeed(seed) || 1;
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {() => number} rng
 * @param {number} min inclusive
 * @param {number} max inclusive
 * @returns {number}
 */
export function rngInt(rng, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * Weighted pick from `{ value, weight }[]`.
 * @param {() => number} rng
 * @param {{ value: number, weight: number }[]} entries
 * @returns {number}
 */
export function rngWeighted(rng, entries) {
  let total = 0;
  for (const e of entries) total += Math.max(0, Number(e.weight) || 0);
  if (!(total > 0)) return entries[0]?.value ?? 0;
  let roll = rng() * total;
  for (const e of entries) {
    roll -= Math.max(0, Number(e.weight) || 0);
    if (roll < 0) return e.value;
  }
  return entries[entries.length - 1]?.value ?? 0;
}

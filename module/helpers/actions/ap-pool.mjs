/**
 * Action-point pool rules — pure functions, no Foundry globals (`node module/helpers/actions/ap-pool.test.mjs`).
 *
 * In combat the pool is a hard resource: an action costs AP the actor has, or it does not happen.
 * Out of combat nothing limits spending, so the same stored number is a counter of AP spent since the
 * last combat: `rawValue` may go below zero and `spent` may exceed `max`. Combat refills the pool
 * (`refreshApPool` at a turn start, `resetApPool` when the combat ends).
 */

/** What a spend does when the pool cannot cover it (in combat). */
export const AP_SHORTAGE = Object.freeze({
  /** Refuse the spend; nothing changes. The default. */
  BLOCK: 'block',
  /** Spend what is left and forgive the rest (a movement that has already happened). */
  CLAMP: 'clamp',
});

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Stored pool value → readout.
 * @param {{ rawValue: unknown, max: number }} args `rawValue` as stored (`undefined`/`null` = full pool)
 * @returns {{ value: number, max: number, rawValue: number, spent: number }}
 *   `value` — AP left (0..max); `spent` — AP spent since the pool was last full (may exceed `max`)
 */
export function readApPool({ rawValue, max } = {}) {
  const cap = Math.max(0, Math.floor(num(max, 0)));
  const raw = rawValue === undefined || rawValue === null ? cap : Math.floor(num(rawValue, cap));
  return {
    value: Math.max(0, Math.min(raw, cap)),
    max: cap,
    rawValue: raw,
    spent: Math.max(0, cap - raw),
  };
}

/**
 * Decide a spend.
 * @param {object} args
 * @param {boolean} args.inCombat whether the pool is a hard limit right now
 * @param {{ value: number, rawValue: number }} args.pool from {@link readApPool}
 * @param {number} args.cost whole AP
 * @param {string} [args.shortage] {@link AP_SHORTAGE}; only matters in combat
 * @returns {{ ok: true, next: number, spent: number } | { ok: false, error: 'notEnoughAp', need: number, have: number }}
 *   `next` — the value to store; `spent` — AP actually taken off (what personal time follows)
 */
export function planApSpend({ inCombat, pool, cost, shortage = AP_SHORTAGE.BLOCK } = {}) {
  const need = Math.max(0, Math.floor(num(cost, 0)));
  if (!inCombat) return { ok: true, next: pool.rawValue - need, spent: need };
  if (need <= pool.value) return { ok: true, next: pool.value - need, spent: need };
  if (shortage === AP_SHORTAGE.CLAMP) return { ok: true, next: 0, spent: pool.value };
  return { ok: false, error: 'notEnoughAp', need, have: pool.value };
}

/**
 * What a counter shows: AP left in combat, AP spent since the last combat otherwise.
 * @param {{ inCombat: boolean, pool: { value: number, max: number, spent: number } }} args
 * @returns {{ mode: 'pool'|'spent', value: number, max: number, empty: boolean }}
 */
export function apReadout({ inCombat, pool } = {}) {
  return inCombat
    ? { mode: 'pool', value: pool.value, max: pool.max, empty: pool.value <= 0 }
    : { mode: 'spent', value: pool.spent, max: pool.max, empty: false };
}

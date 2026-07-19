/**
 * Charge change formulas for ammo items (Weapon v3).
 *
 * Sign is separate from formula: first evaluate magnitude from formula
 * (flat ± percent of current), optionally clamp to ≥0, then apply sign.
 */

import { shStr, shNum } from './damage-profile.mjs';

const CHANGE_SIGNS = Object.freeze(['+', '-']);

/**
 * @param {unknown} raw
 * @param {{sign?: string, formula?: string}} [def]
 * @returns {{sign: '+'|'-', formula: string}}
 */
export function normalizeChargeChange(raw, def = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const sign = CHANGE_SIGNS.includes(src.sign) ? src.sign : (CHANGE_SIGNS.includes(def.sign) ? def.sign : '-');
  const formula = shStr(src.formula !== undefined ? src.formula : def.formula ?? '1');
  return { sign, formula: formula || '1' };
}

/**
 * Evaluate a magnitude formula against current charge.
 * Formula terms: `N` (flat) or `N%` (percent of current), joined by `+`/`-`.
 * Leading sign inside formula is allowed (e.g. `5%-1`).
 *
 * @param {string} formula
 * @param {number} current
 * @returns {number}
 */
export function evalChargeFormula(formula, current) {
  const src = String(formula ?? '').trim().replace(/\s+/g, '');
  if (!src) return 0;
  const cur = Math.max(0, Number(current) || 0);

  // Tokenize: optional leading ±, then number with optional %, repeated ± term
  const re = /([+-]?)(\d+(?:\.\d+)?)(%)?/g;
  let match;
  let total = 0;
  let first = true;
  let consumed = 0;
  while ((match = re.exec(src)) !== null) {
    if (match.index !== consumed) return 0; // garbage between tokens
    const op = match[1] || (first ? '+' : '+');
    const value = Number(match[2]);
    if (!Number.isFinite(value)) return 0;
    const term = match[3] === '%' ? (cur * value) / 100 : value;
    total = op === '-' ? total - term : total + term;
    first = false;
    consumed = match.index + match[0].length;
  }
  if (consumed !== src.length) return 0;
  return total;
}

/**
 * Round magnitude per allowFractional rules (before sign).
 * @param {number} magnitude
 * @param {boolean} allowFractional
 * @returns {number}
 */
export function roundChargeMagnitude(magnitude, allowFractional) {
  const m = Number(magnitude);
  if (!Number.isFinite(m)) return 0;
  if (allowFractional) {
    return Math.round(m * 100) / 100;
  }
  // Round |delta| up (ceil), preserve sign of magnitude for clamp step
  if (m === 0) return 0;
  const abs = Math.ceil(Math.abs(m));
  return m < 0 ? -abs : abs;
}

/**
 * Round stored charge current/max.
 * @param {number} value
 * @param {boolean} allowFractional
 * @returns {number}
 */
export function roundChargeValue(value, allowFractional) {
  const n = Math.max(0, Number(value) || 0);
  if (allowFractional) return Math.round(n * 100) / 100;
  return Math.ceil(n);
}

/**
 * Compute signed delta from charge config (per shot or scaled by seconds).
 *
 * @param {object} args
 * @param {object} args.charge normalized ammo.charge
 * @param {'perShot'|'perSecond'} [args.which]
 * @param {number} [args.current] override current (default charge.current)
 * @param {number} [args.ammoCost] multiplies |delta| after sign (default 1)
 * @param {number} [args.seconds] for perSecond: multiply magnitude by seconds before sign
 * @returns {{ok: boolean, magnitude: number, delta: number, reason?: string}}
 */
export function computeChargeDelta({
  charge,
  which = 'perShot',
  current = undefined,
  ammoCost = 1,
  seconds = 1,
} = {}) {
  if (!charge?.enabled) {
    return { ok: false, magnitude: 0, delta: 0, reason: 'chargeDisabled' };
  }
  const change = which === 'perSecond' ? charge.changePerSecond : charge.changePerShot;
  const cur = current !== undefined ? Math.max(0, Number(current) || 0) : Math.max(0, Number(charge.current) || 0);
  let magnitude = evalChargeFormula(change?.formula ?? '1', cur);
  if (which === 'perSecond') {
    const sec = Math.max(0, Number(seconds) || 0);
    magnitude *= sec;
  }
  magnitude = roundChargeMagnitude(magnitude, !!charge.allowFractional);
  if (charge.clampNonNegative && magnitude < 0) magnitude = 0;

  const cost = Math.max(1, Math.floor(Number(ammoCost) || 1));
  magnitude = roundChargeMagnitude(magnitude * cost, !!charge.allowFractional);

  const sign = change?.sign === '+' ? '+' : '-';
  const delta = sign === '-' ? -magnitude : magnitude;
  return { ok: true, magnitude, delta };
}

/**
 * Apply a precomputed delta to charge current.
 *
 * @param {object} charge mutated charge object
 * @param {number} delta
 * @param {{requireEnough?: boolean}} [opts]
 * @returns {{ok: boolean, applied: number, previous: number, current: number, overheated: boolean, reason?: string}}
 */
export function applyChargeDelta(charge, delta, opts = {}) {
  const allowFractional = !!charge?.allowFractional;
  const max = roundChargeValue(Math.max(0, Number(charge?.max) || 0), allowFractional);
  let current = roundChargeValue(Math.max(0, Number(charge?.current) || 0), allowFractional);
  const previous = current;
  const d = Number(delta) || 0;

  if (opts.requireEnough && d < 0 && current < Math.abs(d) - 1e-9) {
    return { ok: false, applied: 0, previous, current, overheated: false, reason: 'noAmmo' };
  }

  let next = current + d;
  if (next < 0) next = 0;
  if (max > 0 && next > max) next = max;
  next = roundChargeValue(next, allowFractional);

  const applied = next - previous;
  charge.current = next;
  charge.max = max;
  const overheated = d > 0 && max > 0 && next >= max;
  return { ok: true, applied, previous, current: next, overheated };
}

/**
 * Full per-shot (or tick) apply: compute + gate + mutate.
 *
 * @param {object} charge
 * @param {object} [opts]
 * @returns {{ok: boolean, applied: number, delta: number, overheated: boolean, reason?: string}}
 */
export function applyChargeChange(charge, opts = {}) {
  const computed = computeChargeDelta({ charge, ...opts });
  if (!computed.ok) return { ok: false, applied: 0, delta: 0, overheated: false, reason: computed.reason };
  if (!computed.delta) {
    return { ok: true, applied: 0, delta: 0, overheated: false };
  }
  const requireEnough = opts.requireEnough !== undefined
    ? !!opts.requireEnough
    : computed.delta < 0;
  const res = applyChargeDelta(charge, computed.delta, { requireEnough });
  return {
    ok: res.ok,
    applied: res.applied,
    delta: computed.delta,
    overheated: res.overheated,
    reason: res.reason,
  };
}

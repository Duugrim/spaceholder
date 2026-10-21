/**
 * Hitbox scale: the share of a token's body in which projectiles register a hit.
 * Stored on the actor as `system.hitboxScale`, an integer-style percent (100 = the token's size).
 * Usually ≤ 100 (evasion shrinks the hitbox) and only rarely above. Base characteristics
 * (DEX etc.) must not feed into it.
 */

export const HITBOX_SCALE_DEFAULT = 100;
export const HITBOX_SCALE_MIN = 1;
export const HITBOX_SCALE_MAX = 300;

/**
 * @param {unknown} raw stored percent
 * @returns {number} percent clamped to [HITBOX_SCALE_MIN, HITBOX_SCALE_MAX]; missing / invalid → 100
 */
export function normalizeHitboxScale(raw) {
  if (raw == null || raw === '') return HITBOX_SCALE_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return HITBOX_SCALE_DEFAULT;
  return Math.min(HITBOX_SCALE_MAX, Math.max(HITBOX_SCALE_MIN, n));
}

/**
 * Multiplier for a token's body radius.
 * @param {{ system?: { hitboxScale?: unknown } }|null|undefined} actor
 * @returns {number} e.g. 0.5 for a 50% hitbox; 1 when the actor has no parameter
 */
export function hitboxScaleFactor(actor) {
  return normalizeHitboxScale(actor?.system?.hitboxScale) / 100;
}

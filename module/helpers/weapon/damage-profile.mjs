/**
 * Canonical damage profile entries (weapon lines, ammo blocks, ammo items).
 * Energy is derived: E = damage × (armorPen/100)² × hardness
 */

const EPSILON = 1e-9;

export function shNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function shInt(v, def = 0, min = -Infinity) {
  const raw = Number(v);
  if (!Number.isFinite(raw)) return def;
  return Math.max(min, Math.floor(raw));
}

export function shStr(v, def = '') {
  return String(v ?? def).trim();
}

export function shPositiveHardness(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > EPSILON ? n : 1;
}

/** @returns {object} */
export function defaultDamageEntry() {
  return {
    damageType: '',
    damage: 0,
    armorPen: 100,
    hardness: 1,
    armorDamageFactor: 100,
    armorDamageReduction: 100,
    speed: 0,
    payloadId: '',
  };
}

/**
 * Normalize a stored list of damage entries. Incomplete entries (no type /
 * zero damage) are kept so the sheet can edit them; consumers filter via
 * {@link activeDamageEntries}.
 * @param {unknown} raw
 * @returns {object[]}
 */
export function normalizeDamageEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeDamageEntry);
}

/**
 * Entries that actually deal damage (used by the shot/damage pipeline).
 * @param {unknown} raw
 * @returns {object[]}
 */
export function activeDamageEntries(raw) {
  return normalizeDamageEntries(raw).filter((e) => e.damageType && e.damage > 0);
}

/**
 * @param {unknown} entry
 * @returns {object}
 */
export function normalizeDamageEntry(entry) {
  const d = defaultDamageEntry();
  if (!entry || typeof entry !== 'object') return { ...d };
  return {
    damageType: shStr(entry.damageType, d.damageType),
    damage: Math.max(0, shNum(entry.damage, d.damage)),
    armorPen: Math.max(0, shInt(entry.armorPen, d.armorPen, 0)),
    hardness: shPositiveHardness(entry.hardness ?? d.hardness),
    armorDamageFactor: Math.max(0, shInt(entry.armorDamageFactor, d.armorDamageFactor, 0)),
    armorDamageReduction: Math.max(0, shInt(entry.armorDamageReduction, d.armorDamageReduction, 0)),
    speed: Math.max(0, shNum(entry.speed, d.speed)),
    payloadId: shStr(entry.payloadId, d.payloadId),
  };
}

/**
 * @param {object} entry
 * @returns {number}
 */
export function computeProjectileEnergy(entry) {
  const e = normalizeDamageEntry(entry);
  const damage = Math.max(0, e.damage);
  const ap = Math.max(0, e.armorPen) / 100;
  const hardness = shPositiveHardness(e.hardness);
  return damage * ap * ap * hardness;
}

/**
 * Convert damage entries to legacy phased applications for shot-manager.
 * @param {object[]} entries
 * @returns {Array<{mode:string, items:object[]}>}
 */
export function damageEntriesToApplications(entries) {
  const list = activeDamageEntries(entries);
  if (!list.length) return [];
  return [{
    mode: 'sequential',
    items: list.map((e) => ({
      type: e.damageType,
      damage: e.damage,
      // Stored as integer percent (100 = ×1); the resolver expects multipliers.
      armorPen: e.armorPen / 100,
      armorDamageFactor: e.armorDamageFactor / 100,
      hardness: e.hardness,
      armorDamageReduction: e.armorDamageReduction,
      speed: e.speed,
      energy: computeProjectileEnergy(e),
    })),
  }];
}

/**
 * Build merged projectile object for aiming/shot pipeline.
 * @param {object[]} entries
 * @param {object} [extras]
 * @returns {object|null}
 */
export function buildProjectileFromDamageEntries(entries, extras = {}) {
  const list = activeDamageEntries(entries);
  if (!list.length) return null;
  const first = list[0];
  return {
    damage: first.damage,
    damageType: first.damageType,
    armorPen: first.armorPen / 100,
    armorDamageFactor: first.armorDamageFactor / 100,
    hardness: first.hardness,
    armorDamageReduction: first.armorDamageReduction,
    speed: first.speed,
    payloadId: first.payloadId || shStr(extras.payloadId),
    energy: computeProjectileEnergy(first),
    applications: damageEntriesToApplications(list),
    builderId: shStr(extras.builderId),
  };
}

/**
 * Residual damage after armor with configurable armorDamageReduction (%).
 *
 * Linear scale of the energy-loss fraction:
 *   damageRatio = 1 - (1 - energyAfter/energyBefore) × pct/100
 *
 * 100% → damage drops proportionally to energy (legacy behaviour);
 * 50%  → energy halved ⇒ damage loses only a quarter;
 * 0%   → armor never reduces damage (full damage if it reaches the body).
 *
 * @param {number} amount
 * @param {number} energyBefore
 * @param {number} eAR
 * @param {number} [armorDamageReductionPct]
 */
export function residualDamageWithReduction(amount, energyBefore, eAR, armorDamageReductionPct = 100) {
  const energy = Math.max(0, Number(energyBefore) || 0);
  if (energy <= EPSILON) return { energyAfter: 0, residual: 0, energyAbsorbed: 0 };
  const absorbed = Math.min(energy, Math.max(0, Number(eAR) || 0));
  const energyAfter = Math.max(0, energy - absorbed);
  const pct = Math.max(0, Math.min(100, Number(armorDamageReductionPct) || 0));
  const energyLossRatio = 1 - energyAfter / energy;
  const damageRatio = Math.max(0, 1 - energyLossRatio * (pct / 100));
  const residual = Math.max(0, Number(amount) || 0) * damageRatio;
  return { energyAfter, residual, energyAbsorbed: absorbed };
}

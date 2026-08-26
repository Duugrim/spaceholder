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
 * Distance falloff for ammo / projectiles.
 * At `halfDistance` scene units, damage and armorPen drop to 50% (exponential).
 * @returns {{ enabled: boolean, halfDistance: number }}
 */
export function defaultFalloff() {
  return { enabled: false, halfDistance: 0 };
}

/**
 * @param {unknown} raw
 * @returns {{ enabled: boolean, halfDistance: number }}
 */
export function normalizeFalloff(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: !!src.enabled,
    halfDistance: Math.max(0, shNum(src.halfDistance, 0)),
  };
}

/**
 * @param {number} distanceSceneUnits
 * @param {{ enabled?: boolean, halfDistance?: number }|null|undefined} falloff
 * @returns {number} multiplier in (0, 1]
 */
export function falloffMultiplier(distanceSceneUnits, falloff) {
  const f = normalizeFalloff(falloff);
  if (!f.enabled) return 1;
  const half = f.halfDistance;
  if (!(half > 0)) return 1;
  const d = Math.max(0, Number(distanceSceneUnits) || 0);
  return Math.pow(0.5, d / half);
}

/**
 * Scale phased applications by falloff (damage + armorPen; energy recomputed).
 * armorPen on applications is a multiplier (1 = 100%).
 * @param {Array<{mode:string, items:object[]}>} phases
 * @param {number} multiplier
 * @returns {Array<{mode:string, items:object[]}>}
 */
/**
 * Multi-ray fan (shotgun / laser scatter).
 * @returns {{ enabled: boolean, count: number, coneDegrees: number }}
 */
export function defaultMultishot() {
  return { enabled: false, count: 1, coneDegrees: 0 };
}

/**
 * @param {unknown} raw
 * @returns {{ enabled: boolean, count: number, coneDegrees: number }}
 */
export function normalizeMultishot(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: !!src.enabled,
    count: Math.max(1, Math.floor(shNum(src.count, 1))),
    coneDegrees: Math.max(0, shNum(src.coneDegrees, 0)),
  };
}

/**
 * Uniform angles across a cone centered on `baseDirection` (degrees).
 * @param {number} baseDirection
 * @param {number} count
 * @param {number} coneDegrees
 * @returns {number[]}
 */
export function uniformConeDirections(baseDirection, count, coneDegrees) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const base = Number(baseDirection) || 0;
  if (n === 1) return [base];
  const cone = Math.max(0, Number(coneDegrees) || 0);
  const half = cone / 2;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    out.push(base - half + t * cone);
  }
  return out;
}

/**
 * On-hit splash circle appended after a simple line (rockets).
 * @returns {{ enabled: boolean, radius: number, unit: string }}
 */
export function defaultOnHitSplash() {
  return { enabled: false, radius: 0, unit: 'grid' };
}

/**
 * @param {unknown} raw
 * @returns {{ enabled: boolean, radius: number, unit: string }}
 */
export function normalizeOnHitSplash(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const unit = String(src.unit ?? '').trim().toLowerCase() === 'measure' ? 'measure' : 'grid';
  return {
    enabled: !!src.enabled,
    radius: Math.max(0, shNum(src.radius, 0)),
    unit,
  };
}

export function applyFalloffToApplications(phases, multiplier) {
  const m = Math.max(0, Number(multiplier) || 0);
  if (!(Array.isArray(phases)) || Math.abs(m - 1) < EPSILON) return phases;
  return phases.map((phase) => ({
    ...phase,
    items: (Array.isArray(phase?.items) ? phase.items : []).map((it) => {
      const damage = Math.max(0, Number(it?.damage) || 0) * m;
      const armorPen = Math.max(0, Number(it?.armorPen) || 0) * m;
      const hardness = shPositiveHardness(it?.hardness);
      return {
        ...it,
        damage,
        armorPen,
        energy: damage * armorPen * armorPen * hardness,
      };
    }),
  }));
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
    falloff: normalizeFalloff(extras.falloff),
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

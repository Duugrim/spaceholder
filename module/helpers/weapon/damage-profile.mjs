/**
 * Canonical damage profile entries (weapon lines, ammo blocks, ammo items).
 * Energy is derived: E = damage × (armorPen/100)² × hardness
 */

import { damageRatioForEnergyRatio } from '../damage/damage-resolver.mjs';

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

/**
 * Effort of an average human (STR 100); used where the shooter is not known yet
 * (sheet energy preview).
 */
export const EFFORT_REFERENCE = 100;

/** @returns {object} */
export function defaultDamageEntry() {
  return {
    damageType: '',
    damage: 0,
    // Share of the attacker's effort (STR), percent: final damage = damage + effortShare/100 × STR.
    // 0 = fixed damage (ammunition); melee weapons and natural weapons use it.
    effortShare: 0,
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
 * At `halfDistance` scene units the projectile keeps half its energy (exponential); the damage follows the
 * energy, the armour penetration (the projectile's shape) stays. Apply it with
 * {@link applyEnergyScaleToApplications}`(phases, falloffMultiplier(d, falloff))`.
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
 * @returns {number} energy multiplier in (0, 1]
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
 * A volley (shotgun) still this tight at the target (scene units across the fan) makes one wound: one
 * body-part roll, and the pellets' damage adds up (`AimingManager._resolveVolleyImpacts`, the balance tool).
 */
export const VOLLEY_SHARED_SPREAD = 0.5;

/** A blast reaches this many body parts of every target it covers; its energy is split among them. */
export const BLAST_PART_COUNT = 3;

/**
 * Width across the fan of a volley at a distance (scene units).
 * @param {number} distance
 * @param {number} coneDegrees full angle of the fan
 * @returns {number}
 */
export function volleySpreadAt(distance, coneDegrees) {
  return 2 * Math.max(0, Number(distance) || 0) * Math.tan((Math.max(0, Number(coneDegrees) || 0) / 2) * (Math.PI / 180));
}

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
 * How an AoE segment (circle / cone / swingFan) turns a token's coverage into
 * an effect. AoE hits have no aiming luck and no centrality — only coverage.
 *
 * - `proportional` — effect scales with coverage (explosion: partial cover, partial damage)
 * - `any`          — full effect when coverage > 0 (healing aura)
 * - `center`       — full effect when the token center is inside and unobstructed
 * - `full`         — full effect only at 100% coverage
 */
export const AREA_COVERAGE_MODES = Object.freeze({
  PROPORTIONAL: 'proportional',
  ANY: 'any',
  CENTER: 'center',
  FULL: 'full',
});

const FULL_COVERAGE_EPSILON = 1e-9;

/**
 * @param {unknown} raw
 * @returns {string} AREA_COVERAGE_MODES value (default `proportional`)
 */
export function normalizeAreaCoverageMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return Object.values(AREA_COVERAGE_MODES).includes(v) ? v : AREA_COVERAGE_MODES.PROPORTIONAL;
}

/**
 * Whether AoE coverage sampling respects line of sight (walls and token cover).
 * Explosions are blocked by cover (default); a spell may ignore it (`lineOfSight: false`).
 * @param {unknown} raw segment `lineOfSight`
 * @returns {boolean}
 */
export function normalizeAreaLineOfSight(raw) {
  return raw !== false;
}

/**
 * Whether an AoE skips tokens the shot already struck directly (line / swing contact).
 * Default `false`: a rocket's direct target also takes the splash. Set `true` when the
 * direct target gets its own effect and the area is for everyone else (freeze the target,
 * slow those around it). Excluded tokens still act as cover for line of sight.
 * @param {unknown} raw segment `excludeDirectHit`
 * @returns {boolean}
 */
export function normalizeAreaExcludeDirectHit(raw) {
  return raw === true;
}

/**
 * Whether tokens the shot already struck directly stop shielding others from the AoE.
 * Independent of {@link normalizeAreaExcludeDirectHit}: the direct target may still be affected
 * by the area while no longer acting as cover (or the other way round). Default `false`: a
 * struck token still shields what stands behind it, within its (reduced) cover radius.
 * @param {unknown} raw segment `ignoreDirectHitCover`
 * @returns {boolean}
 */
export function normalizeAreaIgnoreDirectHitCover(raw) {
  return raw === true;
}

/**
 * Coverage (percent) at which a `proportional` AoE already gives its full effect. Below it the
 * effect scales as `coverage / coverageForFullEffect` (50 → 25% coverage gives half the effect).
 * Default 100: the effect equals the coverage. Has no effect on the other coverage modes.
 * @param {unknown} raw segment `coverageForFullEffect`
 * @returns {number} percent in [1, 100]
 */
export function normalizeCoverageForFullEffect(raw) {
  if (raw == null || raw === '') return 100;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(1, n));
}

/**
 * Decide whether an AoE touches a token and how strongly.
 * @param {unknown} modeRaw segment `coverageMode`
 * @param {{ coverage?: number, centerCovered?: boolean }} sample sampled coverage (0–1) and whether the
 *   token center is inside the area with a clear line of sight
 * @param {unknown} [coverageForFullEffectRaw] segment `coverageForFullEffect` (percent), see
 *   {@link normalizeCoverageForFullEffect}; only used by `proportional`
 * @returns {{ mode: string, applies: boolean, scale: number }} `scale` in [0, 1]
 */
export function resolveAreaCoverageEffect(modeRaw, { coverage = 0, centerCovered = false } = {}, coverageForFullEffectRaw) {
  const mode = normalizeAreaCoverageMode(modeRaw);
  const cov = Math.max(0, Math.min(1, shNum(coverage, 0)));
  const fullAt = normalizeCoverageForFullEffect(coverageForFullEffectRaw) / 100;
  let applies;
  switch (mode) {
    case AREA_COVERAGE_MODES.ANY:
      applies = cov > 0;
      break;
    case AREA_COVERAGE_MODES.CENTER:
      applies = !!centerCovered;
      break;
    case AREA_COVERAGE_MODES.FULL:
      applies = cov >= 1 - FULL_COVERAGE_EPSILON;
      break;
    default:
      applies = cov > 0;
  }
  const scale = !applies ? 0 : (mode === AREA_COVERAGE_MODES.PROPORTIONAL ? Math.min(1, cov / fullAt) : 1);
  return { mode, applies, scale };
}

/**
 * On-hit splash circle appended after a simple line (rockets).
 * `coverage` is the circle's `coverageMode`; `lineOfSight`, `excludeDirectHit`,
 * `ignoreDirectHitCover` and `coverageForFullEffect` map to the same-named segment options (see
 * {@link AREA_COVERAGE_MODES}, {@link normalizeAreaLineOfSight}, {@link normalizeAreaExcludeDirectHit},
 * {@link normalizeAreaIgnoreDirectHitCover}, {@link normalizeCoverageForFullEffect}).
 * @returns {{ enabled: boolean, radius: number, unit: string, coverage: string, lineOfSight: boolean, excludeDirectHit: boolean, ignoreDirectHitCover: boolean, coverageForFullEffect: number }}
 */
export function defaultOnHitSplash() {
  return {
    enabled: false,
    radius: 0,
    unit: 'grid',
    coverage: AREA_COVERAGE_MODES.PROPORTIONAL,
    lineOfSight: true,
    excludeDirectHit: false,
    ignoreDirectHitCover: false,
    coverageForFullEffect: 100,
  };
}

/**
 * @param {unknown} raw
 * @returns {{ enabled: boolean, radius: number, unit: string, coverage: string, lineOfSight: boolean, excludeDirectHit: boolean, ignoreDirectHitCover: boolean, coverageForFullEffect: number }}
 */
export function normalizeOnHitSplash(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const unit = String(src.unit ?? '').trim().toLowerCase() === 'measure' ? 'measure' : 'grid';
  return {
    enabled: !!src.enabled,
    radius: Math.max(0, shNum(src.radius, 0)),
    unit,
    coverage: normalizeAreaCoverageMode(src.coverage),
    lineOfSight: normalizeAreaLineOfSight(src.lineOfSight),
    excludeDirectHit: normalizeAreaExcludeDirectHit(src.excludeDirectHit),
    ignoreDirectHitCover: normalizeAreaIgnoreDirectHitCover(src.ignoreDirectHitCover),
    coverageForFullEffect: normalizeCoverageForFullEffect(src.coverageForFullEffect),
  };
}

/**
 * Scale the energy of phased applications — a glancing hit (`hit-quality.mjs`), the distance falloff
 * ({@link falloffMultiplier}), the share of a blast a target is exposed to, or any other blow that
 * reaches the target with part of the projectile's energy. The energy decides penetration;
 * the damage follows it by the armour-damage-reduction law ({@link damageRatioForEnergyRatio}), so
 * a target without armour takes less damage too. `armorPen`, `hardness` and the rest stay as
 * authored; a carried `energy` (after walls) is scaled, not recomputed.
 * @param {Array<{mode:string, items:object[]}>} phases
 * @param {number} multiplier energy multiplier, 0–1
 * @returns {Array<{mode:string, items:object[]}>} the same `phases` when the multiplier is ~1
 */
export function applyEnergyScaleToApplications(phases, multiplier) {
  const m = Math.max(0, Math.min(1, Number.isFinite(Number(multiplier)) ? Number(multiplier) : 1));
  if (!(Array.isArray(phases)) || Math.abs(m - 1) < EPSILON) return phases;
  return phases.map((phase) => ({
    ...phase,
    items: (Array.isArray(phase?.items) ? phase.items : []).map((it) => {
      const damage = Math.max(0, Number(it?.damage) || 0);
      const armorPen = Math.max(0, Number(it?.armorPen) || 0);
      const energy = Number.isFinite(Number(it?.energy)) && Number(it.energy) >= 0
        ? Number(it.energy)
        : damage * armorPen * armorPen * shPositiveHardness(it?.hardness);
      return {
        ...it,
        damage: damage * damageRatioForEnergyRatio(m, it?.armorDamageReduction),
        energy: energy * m,
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
  return normalizeDamageEntries(raw).filter((e) => e.damageType && (e.damage > 0 || e.effortShare > 0));
}

/**
 * Damage of one entry for an attacker with the given effort: damage + effortShare/100 × effort.
 * @param {object} entry
 * @param {number} [effort] attacker STR; defaults to {@link EFFORT_REFERENCE}
 * @returns {number}
 */
export function entryDamageAtEffort(entry, effort = EFFORT_REFERENCE) {
  const e = normalizeDamageEntry(entry);
  const eff = Math.max(0, shNum(effort, EFFORT_REFERENCE));
  return Math.max(0, e.damage + (e.effortShare / 100) * eff);
}

/**
 * Bake the attacker's effort into the entries: `damage` becomes the final value and
 * `effortShare` is cleared, so everything downstream (modifiers, energy, applications)
 * sees plain damage.
 * @param {object[]} entries
 * @param {number} effort attacker STR
 * @returns {object[]}
 */
export function resolveEntriesEffort(entries, effort) {
  const list = Array.isArray(entries) ? entries : [];
  return list.map((entry) => {
    const share = Math.max(0, shNum(entry?.effortShare, 0));
    if (!share) return entry;
    return { ...entry, damage: entryDamageAtEffort(entry, effort), effortShare: 0 };
  });
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
    effortShare: Math.max(0, shNum(entry.effortShare, d.effortShare)),
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
 * @param {number} [effort] attacker STR for entries with `effortShare` (default: an average human)
 * @returns {number}
 */
export function computeProjectileEnergy(entry, effort = EFFORT_REFERENCE) {
  const e = normalizeDamageEntry(entry);
  const damage = entryDamageAtEffort(e, effort);
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

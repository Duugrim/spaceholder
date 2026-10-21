/**
 * Hit quality — how well a projectile met the target's hitbox. Pure maths plus the world settings
 * that tune it; runs in plain Node (`node module/helpers/hit-quality.test.mjs`).
 *
 * Only the centrality of the hit matters here (`1 − distance to the hitbox centre / hitbox radius`,
 * see `ShotManager._isHitLine`); the aiming-arc zone is a separate thing (how confidently the shot
 * was taken) and does not enter.
 *
 * Going from the centre of the token outwards (all zones are fractions of the hitbox width):
 * - the **bullseye** (`critZone`) — a critical hit: full energy, plus the mode's crit effect;
 * - the **full zone** (`fullZone`) — full energy (×1);
 * - beyond it the energy multiplier falls evenly down to `edgeEnergy` at the edge of the hitbox.
 *   There are no bands: a small step across a zone border never turns a hit into a different kind
 *   of hit.
 *
 * The multiplier is applied to the projectile's *energy* (`damage-profile.mjs`
 * `applyEnergyScaleToApplications`), not to its damage: the damage follows the energy by the
 * usual armour-damage-reduction law. That is how a glancing hit is simulated — against armour the
 * lost energy decides penetration, which is what an angled plate does; a target without armour
 * simply takes the reduced damage.
 */

export const HIT_QUALITY_SETTING_KEYS = Object.freeze({
  fullZone: 'hitFullZone',
  critZone: 'hitCritZone',
  edgeEnergy: 'hitEdgeEnergy',
});

/** Defaults of the world settings, percent: the full zone ≈ a third of the token width. */
export const HIT_QUALITY_DEFAULTS = Object.freeze({
  fullZone: 30,
  critZone: 10,
  edgeEnergy: 10,
});

export const HIT_QUALITY_TIER = Object.freeze({
  CRIT: 'crit',
  FULL: 'full',
  GLANCING: 'glancing',
});

/**
 * What a critical hit does, set per fire mode (`mode.critEffect`): a single shot picks the body
 * part, an automatic burst does nothing special (yet). `DEFAULT` = decided by the fire mode, see
 * `weapon-model.mjs` `resolveModeCritEffect`.
 */
export const CRIT_EFFECTS = Object.freeze({
  DEFAULT: 'default',
  NONE: 'none',
  PICK_PART: 'pickPart',
});

export const CRIT_EFFECT_LIST = Object.freeze(Object.values(CRIT_EFFECTS));

/**
 * @param {unknown} raw
 * @returns {string} one of {@link CRIT_EFFECTS}; anything else means "by the fire mode"
 */
export function normalizeCritEffect(raw) {
  const value = String(raw ?? '').trim();
  return CRIT_EFFECT_LIST.includes(value) ? value : CRIT_EFFECTS.DEFAULT;
}

/** Slack so that a hit exactly on a zone border (`1 − 0.7` is not `0.3` in floats) stays inside the zone. */
const ZONE_EPSILON = 1e-9;

function _percent(value, fallback, min = 0, max = 100) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Settings (percent) → fractions, with the invariants the maths relies on: the bullseye lies inside
 * the full zone.
 * @param {{fullZone?: number, critZone?: number, edgeEnergy?: number}} [raw] percent
 * @returns {{fullZone: number, critZone: number, edgeEnergy: number}} fractions 0–1
 */
export function normalizeHitQualityConfig(raw = {}) {
  const fullZone = _percent(raw?.fullZone, HIT_QUALITY_DEFAULTS.fullZone) / 100;
  const critZone = Math.min(fullZone, _percent(raw?.critZone, HIT_QUALITY_DEFAULTS.critZone) / 100);
  const edgeEnergy = _percent(raw?.edgeEnergy, HIT_QUALITY_DEFAULTS.edgeEnergy) / 100;
  return { fullZone, critZone, edgeEnergy };
}

/**
 * Register the world settings (call from `init`).
 */
export function registerHitQualitySettings() {
  const entries = [
    ['fullZone', 'FullZone', 1, 100],
    ['critZone', 'CritZone', 0, 50],
    ['edgeEnergy', 'EdgeEnergy', 0, 100],
  ];
  for (const [field, name, min, max] of entries) {
    game.settings.register('spaceholder', HIT_QUALITY_SETTING_KEYS[field], {
      name: `SPACEHOLDER.Settings.HitQuality.${name}.Name`,
      hint: `SPACEHOLDER.Settings.HitQuality.${name}.Hint`,
      scope: 'world',
      config: true,
      type: Number,
      range: { min, max, step: 1 },
      default: HIT_QUALITY_DEFAULTS[field],
      restricted: true,
    });
  }
}

/**
 * Current world settings as a normalized config (defaults outside Foundry or when unset).
 * @returns {{fullZone: number, critZone: number, edgeEnergy: number}}
 */
export function getHitQualityConfig() {
  const raw = {};
  for (const [field, key] of Object.entries(HIT_QUALITY_SETTING_KEYS)) {
    try {
      raw[field] = game.settings.get('spaceholder', key);
    } catch (_) {
      raw[field] = undefined;
    }
  }
  return normalizeHitQualityConfig(raw);
}

/**
 * The quality of one hit.
 *
 * @param {number|null|undefined} centrality 1 = dead centre, 0 = the edge of the hitbox. Missing
 *   (a hit that has no geometry, e.g. a plain melee blow) counts as a full hit that is not a crit.
 * @param {{fullZone: number, critZone: number, edgeEnergy: number}} [config] normalized config
 * @returns {{
 *   centrality: (number|null),
 *   multiplier: number,
 *   tier: string,
 *   crit: boolean
 * }} `multiplier` is the factor for the projectile's energy (0–1)
 */
export function computeHitQuality(centrality, config = getHitQualityConfig()) {
  const c = Number(centrality);
  if (centrality === null || centrality === undefined || !Number.isFinite(c)) {
    return { centrality: null, multiplier: 1, tier: HIT_QUALITY_TIER.FULL, crit: false };
  }
  const centred = Math.max(0, Math.min(1, c));
  const offset = 1 - centred; // 0 = centre … 1 = edge, as a fraction of the hitbox radius
  const { fullZone, critZone, edgeEnergy } = config;
  const crit = critZone > 0 && offset <= critZone + ZONE_EPSILON;
  if (offset <= fullZone + ZONE_EPSILON) {
    return { centrality: centred, multiplier: 1, tier: crit ? HIT_QUALITY_TIER.CRIT : HIT_QUALITY_TIER.FULL, crit };
  }
  const progress = Math.min(1, (offset - fullZone) / (1 - fullZone));
  return {
    centrality: centred,
    multiplier: 1 - (1 - edgeEnergy) * progress,
    tier: HIT_QUALITY_TIER.GLANCING,
    crit: false,
  };
}

const TIER_I18N = Object.freeze({
  [HIT_QUALITY_TIER.CRIT]: 'SPACEHOLDER.HitQuality.Crit',
  [HIT_QUALITY_TIER.FULL]: 'SPACEHOLDER.HitQuality.Full',
  [HIT_QUALITY_TIER.GLANCING]: 'SPACEHOLDER.HitQuality.Glancing',
});

/**
 * @param {string} tier one of {@link HIT_QUALITY_TIER}
 * @returns {string} localized name of the tier (the tier id when the key is missing)
 */
export function localizeHitQualityTier(tier) {
  const key = TIER_I18N[tier];
  const loc = key ? game?.i18n?.localize?.(key) : '';
  return (loc && loc !== key) ? loc : String(tier ?? '');
}

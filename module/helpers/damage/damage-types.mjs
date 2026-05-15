/**
 * Damage type registry for the SpaceHolder damage/armor system.
 *
 * Each damage type carries:
 *  - id           : machine identifier ("ballistic", "thermal", ...)
 *  - label        : i18n key for UI
 *  - description  : i18n key for tooltip / hint
 *  - category     : grouping for UI ("mechanical" | "energetic" | "niche")
 *  - defaultConductance : array of `{ type, fraction }` describing how an
 *      "average" material conducts this damage type past the layer, **before**
 *      structural evaluation. Applied on every hit (held or penetrated).
 *      Empty by default — conductance is typically a material-specific trait.
 *  - defaultSelfInduction : array of `{ type, fraction }` describing how a
 *      *held* hit of this type is converted inside the layer itself
 *      (consuming its `integrity` via `wear[U]`). If the layer can't absorb
 *      all of it, the remainder overflows into the next layer.
 *  - defaultDegradation  : how this damage type interprets a damaged layer
 *      ("reduction" | "distribution" | "chance" | "bypass" | "bastion").
 *
 * Materials may override `conductance[T]`, `selfInduction[T]` and
 * `degradation[T]` per damage type. See
 * [rulebook/ARMOR_PENETRATION.md](rulebook/ARMOR_PENETRATION.md) §3, §5 for
 * the full specification.
 */

/**
 * Allowed degradation modes. Kept as a flat const map so resolvers can switch
 * over them without a string typo.
 */
export const DEGRADATION_MODES = Object.freeze({
  REDUCTION: 'reduction',
  DISTRIBUTION: 'distribution',
  CHANCE: 'chance',
  BYPASS: 'bypass',
  BASTION: 'bastion'
});

/**
 * The full damage-type registry. The order is also used for stable UI.
 */
export const DAMAGE_TYPES = Object.freeze({
  // ---- Mechanical (impulse transfer) -------------------------------------
  ballistic: {
    id: 'ballistic',
    label: 'SPACEHOLDER.DamageTypes.Ballistic.Label',
    description: 'SPACEHOLDER.DamageTypes.Ballistic.Description',
    category: 'mechanical',
    defaultConductance: [],
    defaultSelfInduction: [
      { type: 'concussive', fraction: 0.6 },
      { type: 'thermal', fraction: 0.1 }
    ],
    defaultDegradation: DEGRADATION_MODES.CHANCE
  },
  concussive: {
    id: 'concussive',
    label: 'SPACEHOLDER.DamageTypes.Concussive.Label',
    description: 'SPACEHOLDER.DamageTypes.Concussive.Description',
    category: 'mechanical',
    defaultConductance: [],
    defaultSelfInduction: [
      { type: 'thermal', fraction: 0.1 }
    ],
    defaultDegradation: DEGRADATION_MODES.REDUCTION
  },
  piercing: {
    id: 'piercing',
    label: 'SPACEHOLDER.DamageTypes.Piercing.Label',
    description: 'SPACEHOLDER.DamageTypes.Piercing.Description',
    category: 'mechanical',
    defaultConductance: [],
    defaultSelfInduction: [
      { type: 'concussive', fraction: 0.4 },
      { type: 'thermal', fraction: 0.1 }
    ],
    defaultDegradation: DEGRADATION_MODES.CHANCE
  },
  cutting: {
    id: 'cutting',
    label: 'SPACEHOLDER.DamageTypes.Cutting.Label',
    description: 'SPACEHOLDER.DamageTypes.Cutting.Description',
    category: 'mechanical',
    defaultConductance: [],
    defaultSelfInduction: [
      { type: 'concussive', fraction: 0.5 },
      { type: 'thermal', fraction: 0.05 }
    ],
    defaultDegradation: DEGRADATION_MODES.REDUCTION
  },

  // ---- Energetic ---------------------------------------------------------
  thermal: {
    id: 'thermal',
    label: 'SPACEHOLDER.DamageTypes.Thermal.Label',
    description: 'SPACEHOLDER.DamageTypes.Thermal.Description',
    category: 'energetic',
    defaultConductance: [],
    defaultSelfInduction: [],
    defaultDegradation: DEGRADATION_MODES.DISTRIBUTION
  },
  laser: {
    id: 'laser',
    label: 'SPACEHOLDER.DamageTypes.Laser.Label',
    description: 'SPACEHOLDER.DamageTypes.Laser.Description',
    category: 'energetic',
    defaultConductance: [],
    defaultSelfInduction: [
      { type: 'thermal', fraction: 0.7 },
      { type: 'concussive', fraction: 0.05 }
    ],
    defaultDegradation: DEGRADATION_MODES.REDUCTION
  },
  plasma: {
    id: 'plasma',
    label: 'SPACEHOLDER.DamageTypes.Plasma.Label',
    description: 'SPACEHOLDER.DamageTypes.Plasma.Description',
    category: 'energetic',
    defaultConductance: [],
    defaultSelfInduction: [
      { type: 'thermal', fraction: 0.5 },
      { type: 'concussive', fraction: 0.2 },
      { type: 'electric', fraction: 0.1 }
    ],
    defaultDegradation: DEGRADATION_MODES.DISTRIBUTION
  },
  electric: {
    id: 'electric',
    label: 'SPACEHOLDER.DamageTypes.Electric.Label',
    description: 'SPACEHOLDER.DamageTypes.Electric.Description',
    category: 'energetic',
    defaultConductance: [],
    defaultSelfInduction: [
      { type: 'thermal', fraction: 0.7 }
    ],
    defaultDegradation: DEGRADATION_MODES.REDUCTION
  },

  // ---- Niche -------------------------------------------------------------
  sonic: {
    id: 'sonic',
    label: 'SPACEHOLDER.DamageTypes.Sonic.Label',
    description: 'SPACEHOLDER.DamageTypes.Sonic.Description',
    category: 'niche',
    defaultConductance: [],
    defaultSelfInduction: [
      { type: 'concussive', fraction: 0.4 },
      { type: 'thermal', fraction: 0.2 }
    ],
    defaultDegradation: DEGRADATION_MODES.REDUCTION
  },
  radiation: {
    id: 'radiation',
    label: 'SPACEHOLDER.DamageTypes.Radiation.Label',
    description: 'SPACEHOLDER.DamageTypes.Radiation.Description',
    category: 'niche',
    defaultConductance: [],
    defaultSelfInduction: [
      { type: 'thermal', fraction: 0.05 }
    ],
    defaultDegradation: DEGRADATION_MODES.REDUCTION
  },
  chemical: {
    id: 'chemical',
    label: 'SPACEHOLDER.DamageTypes.Chemical.Label',
    description: 'SPACEHOLDER.DamageTypes.Chemical.Description',
    category: 'niche',
    defaultConductance: [],
    defaultSelfInduction: [
      { type: 'thermal', fraction: 0.2 }
    ],
    defaultDegradation: DEGRADATION_MODES.DISTRIBUTION
  }
});

/**
 * Stable list of damage-type ids (used for UI sorting and validation).
 */
export const DAMAGE_TYPE_IDS = Object.freeze(Object.keys(DAMAGE_TYPES));

/**
 * Default ordering of categories for UI.
 */
export const DAMAGE_TYPE_CATEGORIES = Object.freeze(['mechanical', 'energetic', 'niche']);

/**
 * Validate that an id is a known damage type.
 * @param {string} id
 * @returns {boolean}
 */
export function isDamageType(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DAMAGE_TYPES, id);
}

/**
 * Get a damage-type definition or `null` if unknown.
 * @param {string} id
 * @returns {Object|null}
 */
export function getDamageType(id) {
  if (!isDamageType(id)) return null;
  return DAMAGE_TYPES[id];
}

/**
 * Build a deep-cloned, mutable map of damage types ready to be exposed via
 * `CONFIG.SPACEHOLDER.damageTypes`. The clone protects the registry from
 * accidental runtime mutation (Foundry sometimes assigns localized labels in
 * place).
 * @returns {Object<string, Object>}
 */
export function buildDamageTypeConfig() {
  const out = {};
  for (const [id, def] of Object.entries(DAMAGE_TYPES)) {
    out[id] = {
      id,
      label: def.label,
      description: def.description,
      category: def.category,
      defaultConductance: def.defaultConductance.map((t) => ({ ...t })),
      defaultSelfInduction: def.defaultSelfInduction.map((t) => ({ ...t })),
      defaultDegradation: def.defaultDegradation
    };
  }
  return out;
}

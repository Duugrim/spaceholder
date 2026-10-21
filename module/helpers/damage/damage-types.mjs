/**
 * Damage type registry for the SpaceHolder damage/armor system.
 *
 * Each damage type carries:
 *  - id           : machine identifier ("ballistic", "thermal", ...)
 *  - label        : i18n key for UI
 *  - description  : i18n key for tooltip / hint
 *  - category     : grouping for UI ("mechanical" | "energetic" | "niche")
 *  - defaultConductance : array of `{ type, fraction }`: the share of the damage a layer
 *      *absorbs* (all of it when it holds, the absorbed part when it is penetrated) that it hands on
 *      to the layers behind as another type — the blunt shock behind armour. It never weakens the
 *      projectile itself. Empty by default — conductance is a material-specific trait.
 *  - defaultSelfInduction : array of `{ type, fraction }` describing how a
 *      *held* hit of this type is converted inside the layer itself
 *      (consuming its `integrity` via `wear[U]`). If the layer can't absorb
 *      all of it, the remainder overflows into the next layer.
 *  - defaultDegradation  : how this damage type interprets a damaged layer
 *      ("reduction" | "distribution" | "chance" | "bypass" | "bastion").
 *  - penetratesBody : the type can go through a body part, stop inside it or leave it (bullets,
 *      blades, beams). Other types stay on the part they hit and never exit (a blow, a burn).
 *  - bleed : how much a wound of this type bleeds (1 = a bullet wound; blades more, blows little,
 *      burns are cauterised). See `bleeding.mjs`.
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
      { type: 'concussive', fraction: 0.6 }
    ],
    defaultDegradation: DEGRADATION_MODES.CHANCE,
    penetratesBody: true,
    bleed: 1
  },
  concussive: {
    id: 'concussive',
    label: 'SPACEHOLDER.DamageTypes.Concussive.Label',
    description: 'SPACEHOLDER.DamageTypes.Concussive.Description',
    category: 'mechanical',
    defaultConductance: [],
    defaultSelfInduction: [],
    defaultDegradation: DEGRADATION_MODES.REDUCTION,
    penetratesBody: false,
    bleed: 0.15
  },
  piercing: {
    id: 'piercing',
    label: 'SPACEHOLDER.DamageTypes.Piercing.Label',
    description: 'SPACEHOLDER.DamageTypes.Piercing.Description',
    category: 'mechanical',
    defaultConductance: [],
    defaultSelfInduction: [
      { type: 'concussive', fraction: 0.4 }
    ],
    defaultDegradation: DEGRADATION_MODES.CHANCE,
    penetratesBody: true,
    bleed: 1.2
  },
  cutting: {
    id: 'cutting',
    label: 'SPACEHOLDER.DamageTypes.Cutting.Label',
    description: 'SPACEHOLDER.DamageTypes.Cutting.Description',
    category: 'mechanical',
    defaultConductance: [],
    defaultSelfInduction: [
      { type: 'concussive', fraction: 0.5 }
    ],
    defaultDegradation: DEGRADATION_MODES.REDUCTION,
    penetratesBody: true,
    bleed: 1.5
  },

  // ---- Energetic ---------------------------------------------------------
  thermal: {
    id: 'thermal',
    label: 'SPACEHOLDER.DamageTypes.Thermal.Label',
    description: 'SPACEHOLDER.DamageTypes.Thermal.Description',
    category: 'energetic',
    defaultConductance: [],
    defaultSelfInduction: [],
    defaultDegradation: DEGRADATION_MODES.DISTRIBUTION,
    penetratesBody: false,
    bleed: 0
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
    defaultDegradation: DEGRADATION_MODES.REDUCTION,
    penetratesBody: true,
    bleed: 0
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
    defaultDegradation: DEGRADATION_MODES.DISTRIBUTION,
    penetratesBody: true,
    bleed: 0
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
    defaultDegradation: DEGRADATION_MODES.REDUCTION,
    penetratesBody: false,
    bleed: 0
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
    defaultDegradation: DEGRADATION_MODES.REDUCTION,
    penetratesBody: false,
    bleed: 0.1
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
    defaultDegradation: DEGRADATION_MODES.REDUCTION,
    penetratesBody: false,
    bleed: 0
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
    defaultDegradation: DEGRADATION_MODES.DISTRIBUTION,
    penetratesBody: false,
    bleed: 0.3
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
 * @param {string} id damage-type id
 * @returns {boolean} the type can go through a body part (and leave it); false for blows, burns and
 *   everything unknown
 */
export function penetratesBody(id) {
  return getDamageType(id)?.penetratesBody === true;
}

/**
 * @param {string} id damage-type id
 * @returns {boolean} a mechanical type (bullet, blade, blow): its shock behind armour is the layer's
 *   conductance alone — a layer worn out by holding it does not dump the rest of the hit on the body
 */
export function isMechanical(id) {
  return getDamageType(id)?.category === 'mechanical';
}

/**
 * @param {string} id damage-type id
 * @returns {number} bleeding factor of a wound of this type (1 = a bullet wound), 0 for unknown types
 */
export function bleedFactor(id) {
  const n = Number(getDamageType(id)?.bleed);
  return Number.isFinite(n) && n > 0 ? n : 0;
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
      defaultDegradation: def.defaultDegradation,
      penetratesBody: def.penetratesBody === true,
      bleed: def.bleed ?? 0
    };
  }
  return out;
}

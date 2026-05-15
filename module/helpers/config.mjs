import { buildDamageTypeConfig, DEGRADATION_MODES, DAMAGE_TYPE_CATEGORIES } from './damage/damage-types.mjs';
import { INJURY_DESCRIPTORS } from './damage/injury-descriptors.mjs';
import { defaultDescriptor } from './damage/injury-description.mjs';

export const SPACEHOLDER = {};

/**
 * Damage-type registry. See module/helpers/damage/damage-types.mjs for the
 * authoritative source. The values here are deep-cloned so consumers may
 * safely mutate them (e.g. cache localized labels) without corrupting the
 * compile-time defaults.
 *
 * Materials override `transmission[T]` / `degradation[T]` per damage type;
 * see module/helpers/damage/materials-manager.mjs.
 * @type {Object<string, Object>}
 */
SPACEHOLDER.damageTypes = buildDamageTypeConfig();

/**
 * Available layer-degradation modes. Aligned with damage-resolver behaviour.
 * @type {Object<string, string>}
 */
SPACEHOLDER.degradationModes = { ...DEGRADATION_MODES };

/**
 * UI ordering for damage-type categories.
 * @type {string[]}
 */
SPACEHOLDER.damageTypeCategories = [...DAMAGE_TYPE_CATEGORIES];

/**
 * Registry of optional projectile builders. Each builder is a function
 *   `(ctx) => ApplicationsPackage`
 * where `ctx` includes `{ weapon, ammo, attacker, target, channel }` and the
 * returned package follows the structure defined in
 * `damage-resolver.normalizeApplications`.
 *
 * The resolver consults this registry only when an item declares
 * `projectile.builderId`; otherwise it uses the static `projectile.applications`.
 * @type {Object<string, Function>}
 */
SPACEHOLDER.applicationBuilders = {};

/**
 * Registry of injury descriptors keyed by damage-type id. Each entry is a
 * pure function `(ctx) => { segments, tooltipSegments }` that builds a
 * structured description of an injury for the actor sheet. `__default` is
 * the fallback used for unknown damage types and legacy data.
 * @type {Object<string, Function>}
 */
SPACEHOLDER.injuryDescriptors = {
  ...INJURY_DESCRIPTORS,
  __default: defaultDescriptor,
};

/**
 * The set of Ability Scores used within the system.
 * @type {Object}
 */
SPACEHOLDER.abilities = {
  end: 'SPACEHOLDER.Ability.End.long',
  str: 'SPACEHOLDER.Ability.Str.long',
  dex: 'SPACEHOLDER.Ability.Dex.long',
  cor: 'SPACEHOLDER.Ability.Cor.long',
  per: 'SPACEHOLDER.Ability.Per.long',
  int: 'SPACEHOLDER.Ability.Int.long',
  luc: 'SPACEHOLDER.Ability.Luc.long',
};

/**
 * ОД за фиксированный отрезок времени в бою (~1 с): за него считается «базовая» дистанция движения;
 * затем `system.speed` = этот отрезок / дистанция (ОД за 1 единицу дистанции для movement-manager).
 * @type {number}
 */
SPACEHOLDER.movementApTimeSlice = 10;

/**
 * Нижняя граница дистанции за отрезок (чтобы не делить на ноль при очень низкой подвижности).
 * @type {number}
 */
SPACEHOLDER.movementMinDistancePerSlice = 0.25;

/**
 * Конфигурация углов наводки персонажа и штрафов стандартного прицеливания.
 */
SPACEHOLDER.aimingArc = {
  segmentCount: 5,
  standardZoneCount: 4,
  defaultPurpleZoneDeg: 1,
  defaultTotalArcDeg: 90,
  defaultZoneWeights: [5, 15, 25, 30],
  defaultDeadZoneDeg: 0,
  defaultDeviationBaseDeg: 1,
  deviationMultipliers: [0, 0, 1, 2, 4],
  overlayThicknessPx: 44,
  overlayColors: [0x9b59ff, 0x46d36a, 0xf0d04a, 0xf39c3d, 0xe05252],
  overlayAlpha: 0.56,
};

SPACEHOLDER.abilityAbbreviations = {
  end: 'SPACEHOLDER.Ability.End.abbr',
  str: 'SPACEHOLDER.Ability.Str.abbr',
  dex: 'SPACEHOLDER.Ability.Dex.abbr',
  cor: 'SPACEHOLDER.Ability.Cor.abbr',
  per: 'SPACEHOLDER.Ability.Per.abbr',
  int: 'SPACEHOLDER.Ability.Int.abbr',
  luc: 'SPACEHOLDER.Ability.Luc.abbr',
};

/**
 * Конфигурация целей модификаторов персонажа от надетых предметов.
 * Используется листом предмета и логикой актора.
 */
SPACEHOLDER.characterModifierTargets = {
  abilities: [
    { id: 'abilities.end', path: 'abilities.end.value', label: 'SPACEHOLDER.Modifiers.AbilitiesLong.End' },
    { id: 'abilities.str', path: 'abilities.str.value', label: 'SPACEHOLDER.Modifiers.AbilitiesLong.Str' },
    { id: 'abilities.dex', path: 'abilities.dex.value', label: 'SPACEHOLDER.Modifiers.AbilitiesLong.Dex' },
    { id: 'abilities.cor', path: 'abilities.cor.value', label: 'SPACEHOLDER.Modifiers.AbilitiesLong.Cor' },
    { id: 'abilities.per', path: 'abilities.per.value', label: 'SPACEHOLDER.Modifiers.AbilitiesLong.Per' },
    { id: 'abilities.int', path: 'abilities.int.value', label: 'SPACEHOLDER.Modifiers.AbilitiesLong.Int' },
    { id: 'abilities.luc', path: 'abilities.luc.value', label: 'SPACEHOLDER.Modifiers.AbilitiesLong.Luc' }
  ],
  derived: [],
  params: []
};

/**
 * Canonical body-part IDs used by armor coverage and localization dictionary.
 * Keep in sync with SPACEHOLDER.BodyParts.* localization keys.
 */
SPACEHOLDER.bodyPartDictionary = [
  'head',
  'neck',
  'back',
  'chest',
  'abdomen',
  'groin',
  'leftShoulder',
  'rightShoulder',
  'leftArm',
  'rightArm',
  'leftHand',
  'rightHand',
  'leftThigh',
  'rightThigh',
  'leftShin',
  'rightShin',
  'leftFoot',
  'rightFoot',
  'cephalothorax',
  'abdomenSegment',
  'leftLeg',
  'rightLeg'
];

/**
 * Fallback anatomy for wearable coverage editor when item has no anatomy selected.
 */
SPACEHOLDER.wearableCoverageReferenceAnatomyId = 'humanoid';

/**
 * When `true`, each body part’s tissue stack (`bodyLayers` / defaults for
 * `part.id`) participates in {@link resolveBodyTraversal} together with
 * worn armour. When `false`, tissue layers are skipped — only armour items
 * resolve structurally; unarmoured hits apply straight to the part centre.
 * Temporary toggle: set back to `true` to restore full body-layer simulation.
 * @type {boolean}
 */
SPACEHOLDER.anatomyBodyLayersInDamage = false;


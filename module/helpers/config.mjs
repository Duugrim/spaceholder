export const SPACEHOLDER = {};

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
  maxHalfAngleDeg: 90,
  defaultZoneHalfDegrees: [1, 5, 15, 25, 30],
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


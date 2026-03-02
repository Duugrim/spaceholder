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


/**
 * Описатели травм для каждого типа урона.
 *
 * Каждый описатель — чистая функция `(ctx) → { segments, tooltipSegments }`.
 * `ctx` содержит `{ injury, part, partName, material, wound, source, actor,
 * typeDef }`. Описатели собирают массив «сегментов» для UI; реестр
 * подключается через `registerInjuryDescriptors`.
 *
 * Структура сегмента: `{ kind, text?, i18n?, tooltip?, uuid?, cssClass? }`.
 * `text` имеет приоритет над `i18n` при рендере.
 *
 * @module helpers/damage/injury-descriptors
 */

import { buildSourceSegments } from './injury-description.mjs';

/* ----------------------------------------------------------------------
 * Утилиты для описателей
 * ---------------------------------------------------------------------- */

function noun(key) {
  return { kind: 'damageType', i18n: `SPACEHOLDER.Injuries.DamageNouns.${key}` };
}

function prepIn() {
  return { kind: 'preposition', i18n: 'SPACEHOLDER.Injuries.Prep.In' };
}

function prepOn() {
  return { kind: 'preposition', i18n: 'SPACEHOLDER.Injuries.Prep.On' };
}

function bodyPart(ctx) {
  return { kind: 'bodyPart', text: ctx.partName, uuid: ctx.part?.uuid ?? null };
}

function bleedSeg(wound) {
  if (!wound?.bleed || wound.bleed === 'none') return null;
  return {
    kind: 'bleedState',
    i18n: `SPACEHOLDER.Injuries.BleedStates.${_cap(wound.bleed)}`,
  };
}

function stageSeg(wound) {
  if (!wound?.stage || wound.stage === 'none') return null;
  return {
    kind: 'woundState',
    i18n: `SPACEHOLDER.Injuries.WoundStates.${_cap(wound.stage)}`,
  };
}

function _cap(s) {
  if (!s) return '';
  const str = String(s);
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/* ----------------------------------------------------------------------
 * Описатели по типам
 * ---------------------------------------------------------------------- */

/**
 * Семейство открытых кровоточащих ран (ballistic/piercing/cutting).
 * Различаются только существительным («Пулевое ранение» / «Колотое» / «Порез»).
 */
function bleedingFamily(damageNounKey, verb = 'strike') {
  return (ctx) => {
    const { wound, source } = ctx;
    return {
      segments: [
        noun(damageNounKey),
        prepIn(),
        bodyPart(ctx),
        bleedSeg(wound),
        stageSeg(wound),
      ],
      tooltipSegments: buildSourceSegments(source, verb),
    };
  };
}

/**
 * Семейство ожогов с кауторизацией (laser/plasma/thermal/electric).
 */
function cauterizedFamily(damageNounKey, verb) {
  return (ctx) => {
    const { wound, source } = ctx;
    return {
      segments: [
        noun(damageNounKey),
        prepOn(),
        bodyPart(ctx),
        bleedSeg(wound), // cauterized
        stageSeg(wound),
      ],
      tooltipSegments: buildSourceSegments(source, verb),
    };
  };
}

function describeBallistic(ctx) { return bleedingFamily('Ballistic', 'fire')(ctx); }
function describePiercing(ctx) { return bleedingFamily('Piercing', 'strike')(ctx); }
function describeCutting(ctx) { return bleedingFamily('Cutting', 'strike')(ctx); }

function describeLaser(ctx) { return cauterizedFamily('Laser', 'fire')(ctx); }
function describePlasma(ctx) { return cauterizedFamily('Plasma', 'fire')(ctx); }
function describeThermal(ctx) { return cauterizedFamily('Thermal', 'burn')(ctx); }
function describeElectric(ctx) { return cauterizedFamily('Electric', 'strike')(ctx); }

function describeChemical(ctx) {
  const { wound, source } = ctx;
  return {
    segments: [
      noun('Chemical'),
      prepOn(),
      bodyPart(ctx),
      bleedSeg(wound), // corrosive
      stageSeg(wound),
    ],
    tooltipSegments: buildSourceSegments(source, 'expose'),
  };
}

function describeRadiation(ctx) {
  const { wound, source } = ctx;
  return {
    segments: [
      noun('Radiation'),
      prepOn(),
      bodyPart(ctx),
      stageSeg(wound),
    ],
    tooltipSegments: buildSourceSegments(source, 'expose'),
  };
}

function describeConcussive(ctx) {
  const { wound, source } = ctx;
  return {
    segments: [
      noun('Concussive'),
      prepIn(),
      bodyPart(ctx),
      stageSeg(wound),
    ],
    tooltipSegments: buildSourceSegments(source, 'strike'),
  };
}

function describeSonic(ctx) {
  const { wound, source } = ctx;
  return {
    segments: [
      noun('Sonic'),
      prepIn(),
      bodyPart(ctx),
      stageSeg(wound),
    ],
    tooltipSegments: buildSourceSegments(source, 'expose'),
  };
}

/**
 * Полный набор описателей. Ключ `__default` — фолбэк из
 * `injury-description.mjs`.
 */
export const INJURY_DESCRIPTORS = Object.freeze({
  ballistic: describeBallistic,
  piercing: describePiercing,
  cutting: describeCutting,
  concussive: describeConcussive,
  thermal: describeThermal,
  laser: describeLaser,
  plasma: describePlasma,
  electric: describeElectric,
  sonic: describeSonic,
  radiation: describeRadiation,
  chemical: describeChemical,
});

/**
 * Построитель структурированных описаний травм для UI.
 *
 * Травма хранится сухими данными (часть тела, тип урона, amount, status,
 * source). Для показа в листе актёра мы превращаем эти данные в массив
 * «сегментов» ({ kind, text|i18n, tooltip, uuid, cssClass }), которые
 * рендерятся единым Handlebars-partial. Подбор сегментов зависит от типа
 * урона — за это отвечают описатели (`injury-descriptors.mjs`),
 * регистрируемые через `registerInjuryDescriptors()` и доступные через
 * `CONFIG.SPACEHOLDER.injuryDescriptors`.
 *
 * @module helpers/damage/injury-description
 */

import { resolveBodyPartDisplayName } from '../../anatomy-manager.mjs';
import { getDamageType } from './damage-types.mjs';

/**
 * Зарегистрировать реестр описателей в `CONFIG.SPACEHOLDER.injuryDescriptors`.
 * Принимает карту `{ [damageTypeId]: descriptorFn }`. Ранее зарегистрированные
 * описатели перезаписываются только по совпадающим ключам.
 * @param {Object<string, Function>} map
 */
export function registerInjuryDescriptors(map) {
  const target = (CONFIG.SPACEHOLDER.injuryDescriptors ??= {});
  for (const [key, fn] of Object.entries(map ?? {})) {
    if (typeof fn === 'function') target[key] = fn;
  }
}

/**
 * Получить описатель для типа урона с фолбэком на default.
 * @param {string} type
 * @returns {Function}
 */
export function getInjuryDescriptor(type) {
  const reg = CONFIG.SPACEHOLDER?.injuryDescriptors ?? {};
  if (type && reg[type]) return reg[type];
  return reg.__default ?? defaultDescriptor;
}

/**
 * Буквенная стадия раны (как описание, не как механика).
 *
 * Прогресс = доля исцелённого amount относительно initialAmount. Для
 * кауторизованных типов (лазер/плазма/ожог) значение `bleed` принудительно
 * подменяется на `cauterized`. Для бионики — на `damage/repair` словарь.
 *
 * @param {Object} injury
 * @param {Object|null} damageTypeDef полный дескриптор из DAMAGE_TYPES
 * @param {string} material материал части тела (`biological` | `bionic` | ...)
 * @returns {{ bleed:string, stage:string, progress:number, material:string }}
 */
export function computeWoundState(injury, damageTypeDef, material = 'biological') {
  const amount = Math.max(0, Number(injury?.amount) || 0);
  const init = Math.max(amount, Number(injury?.initialAmount ?? amount) || amount);
  const progress = init > 0 ? Math.max(0, Math.min(1, 1 - amount / init)) : 1;

  if (material === 'bionic') {
    let stage;
    if (progress < 0.15) stage = 'damage';
    else if (progress < 0.5) stage = 'misaligned';
    else if (progress < 0.9) stage = 'patched';
    else stage = 'repaired';
    return { bleed: 'none', stage, progress, material };
  }

  const category = damageTypeDef?.category ?? null;
  const cauterizes = damageTypeDef?.id === 'laser' || damageTypeDef?.id === 'plasma' || damageTypeDef?.id === 'thermal' || damageTypeDef?.id === 'electric';
  const corrosive = damageTypeDef?.id === 'chemical';
  const noBleed = cauterizes || corrosive || damageTypeDef?.id === 'radiation' || damageTypeDef?.id === 'concussive' || damageTypeDef?.id === 'sonic';

  let bleed;
  let stage;
  if (progress < 0.15) {
    bleed = 'bleeding';
    stage = 'open';
  } else if (progress < 0.5) {
    bleed = 'clotting';
    stage = 'closing';
  } else if (progress < 0.9) {
    bleed = 'dry';
    stage = 'scarring';
  } else {
    bleed = 'healed';
    stage = 'faded';
  }

  if (injury?.status === 'treated' && bleed === 'bleeding') bleed = 'clotting';
  if (cauterizes) bleed = 'cauterized';
  else if (corrosive) bleed = 'corrosive';
  else if (noBleed) bleed = 'none';

  // Радиация исцеляется словарём-шелушением.
  if (damageTypeDef?.id === 'radiation') {
    if (progress < 0.15) stage = 'radFresh';
    else if (progress < 0.5) stage = 'radPeeling';
    else if (progress < 0.9) stage = 'radHealing';
    else stage = 'faded';
  }

  // Ушиб и звуковая — стадии ощущений, а не ткани.
  if (damageTypeDef?.id === 'concussive' || damageTypeDef?.id === 'sonic') {
    if (progress < 0.15) stage = 'aching';
    else if (progress < 0.5) stage = 'sore';
    else if (progress < 0.9) stage = 'dullAche';
    else stage = 'faded';
  }

  return { bleed, stage, progress, material, category };
}

/**
 * Собрать сегменты тултипа-источника из snapshot'а `source`.
 *
 * Паттерн: `{attacker} {verb} {weapon} {connector} {ammo}`. Любой кусок
 * может отсутствовать — соответствующий сегмент просто не попадёт в
 * массив. Если источник — legacy-строка, отдаём её как один сегмент.
 *
 * @param {Object} source
 * @param {string} [defaultVerb='strike'] fallback глагол
 * @returns {Array<Object>}
 */
export function buildSourceSegments(source, defaultVerb = 'strike') {
  const src = source && typeof source === 'object' ? source : {};
  if (!Object.keys(src).length) return [];

  if (src.legacyLabel && !src.attackerName && !src.weaponName && !src.ammoName && !src.attackerUuid) {
    return [{ kind: 'legacy', text: src.legacyLabel }];
  }

  const segments = [];
  if (src.attackerName || src.attackerUuid) {
    segments.push({
      kind: 'attacker',
      text: src.attackerName ?? src.attackerUuid,
      uuid: src.attackerUuid ?? null,
    });
  }

  const verbKey = src.verbKey || defaultVerb;
  segments.push({
    kind: 'verb',
    i18n: `SPACEHOLDER.Injuries.SourceVerbs.${_capitalize(verbKey)}`,
  });

  if (src.weaponName || src.weaponUuid) {
    segments.push({
      kind: 'weapon',
      text: src.weaponName ?? src.weaponUuid,
      uuid: src.weaponUuid ?? null,
    });
  }

  if (src.ammoName || src.ammoUuid) {
    segments.push({
      kind: 'connector',
      i18n: (src.weaponName || src.weaponUuid)
        ? 'SPACEHOLDER.Injuries.SourceConnectors.WithAmmo'
        : 'SPACEHOLDER.Injuries.SourceConnectors.Standalone',
    });
    segments.push({
      kind: 'ammo',
      text: src.ammoName ?? src.ammoUuid,
      uuid: src.ammoUuid ?? null,
    });
  }

  return segments;
}

/**
 * Высокоуровневая точка входа: собрать описание травмы.
 * @param {Object} args
 * @param {Object} args.injury
 * @param {Object|null} [args.part]
 * @param {string} [args.material]
 * @param {Object} [args.actor]
 * @returns {{ segments:Array, tooltipSegments:Array, type:string, status:string, material:string, wound:Object }}
 */
export function describeInjury({ injury, part, material = 'biological', actor } = {}) {
  if (!injury || typeof injury !== 'object') return { segments: [], tooltipSegments: [] };

  const typeDef = getDamageType(injury.type);
  const wound = computeWoundState(injury, typeDef, material);
  const partName = _resolvePartName(part, injury);

  const ctx = {
    injury,
    part,
    partName,
    material,
    wound,
    source: injury.source ?? {},
    actor,
    typeDef,
  };

  const descriptor = getInjuryDescriptor(injury.type);
  let out;
  try {
    out = descriptor(ctx) ?? {};
  } catch (e) {
    console.error('SpaceHolder | injury descriptor failed', e);
    out = defaultDescriptor(ctx);
  }

  const segments = Array.isArray(out.segments) ? out.segments.filter(Boolean) : [];
  const tooltipSegments = Array.isArray(out.tooltipSegments) ? out.tooltipSegments.filter(Boolean) : [];

  if (injury.status === 'treated') {
    segments.unshift({
      kind: 'statusPrefix',
      i18n: 'SPACEHOLDER.Injuries.StatusPrefix.Treated',
    });
  }

  return {
    segments,
    tooltipSegments,
    type: injury.type,
    status: injury.status ?? 'raw',
    material,
    wound,
    partName,
  };
}

/**
 * Фолбэк-описатель для неизвестных типов урона / старых травм.
 * @param {Object} ctx
 * @returns {Object}
 */
export function defaultDescriptor(ctx) {
  const { injury, partName, wound, source } = ctx;
  const segments = [];
  segments.push({ kind: 'damageType', i18n: 'SPACEHOLDER.Injuries.DamageNouns.Unknown' });
  if (partName) {
    segments.push({ kind: 'preposition', i18n: 'SPACEHOLDER.Injuries.Prep.In' });
    segments.push({ kind: 'bodyPart', text: partName });
  }
  if (wound?.bleed && wound.bleed !== 'none') {
    segments.push({ kind: 'bleedState', i18n: `SPACEHOLDER.Injuries.BleedStates.${_capitalize(wound.bleed)}` });
  }
  if (wound?.stage) {
    segments.push({ kind: 'woundState', i18n: `SPACEHOLDER.Injuries.WoundStates.${_capitalize(wound.stage)}` });
  }
  if (injury?.source?.legacyLabel && segments.length === 1) {
    segments.push({ kind: 'legacy', text: injury.source.legacyLabel });
  }
  return {
    segments,
    tooltipSegments: buildSourceSegments(source, 'strike'),
  };
}

function _resolvePartName(part, injury) {
  if (part?.displayName) return part.displayName;
  if (part?.name) return part.name;
  const typeId = part?.id ?? injury?.partId;
  if (typeId) return resolveBodyPartDisplayName(typeId, part?.name);
  return injury?.partId ?? '';
}

function _capitalize(s) {
  if (!s) return '';
  const str = String(s);
  return str.charAt(0).toUpperCase() + str.slice(1);
}

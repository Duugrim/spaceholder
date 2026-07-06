/**
 * Weapon data model v3 — «Оружие → Действие» refactor.
 *
 * Layered structure (see docs/МыслиNEW/Оружие-Действие.md):
 *   weapon.ergonomics — modifiers for the character aiming arcs + readying
 *   weapon.lines[]    — attack lines: per-line params, ammo blocks, fire modes
 *   weapon.state      — runtime state (active line/mode, readiness)
 *   weapon.ammo       — ammo item config (when itemTags.isAmmo)
 *
 * "Attack" = line × mode; the list of attacks is derived, not stored.
 *
 * Percent convention: integers, 100 = neutral, ≥ 0, no upper bound;
 * divide by 100 when used as a multiplier.
 *
 * Toggleable params are `{ enabled, value }` objects. `enabled: false`
 * skips the mechanic entirely (НЕ то же самое, что value = 0).
 */

import {
  shNum,
  shInt,
  shStr,
  normalizeDamageEntries,
  normalizeDamageEntry,
  activeDamageEntries,
  defaultDamageEntry,
  computeProjectileEnergy,
  damageEntriesToApplications,
  buildProjectileFromDamageEntries,
} from './damage-profile.mjs';
import { normalizeTrajectoryKind, normalizeSimpleLimit } from './trajectory.mjs';

export const SH_WEAPON_VERSION = 3;

/** 10 AP = 1 second (rate-of-fire conversion). */
export const AP_PER_SECOND = 10;

export const AMMO_BLOCK_TYPES = Object.freeze({
  INTERNAL_CHARGE: 'internalCharge',
  INTERNAL_MAGAZINE: 'internalMagazine',
  EXTERNAL_CHARGE: 'externalCharge',
  EXTERNAL_MAGAZINE: 'externalMagazine',
});

export const AMMO_BLOCK_TYPE_LIST = Object.freeze(Object.values(AMMO_BLOCK_TYPES));

/** Blocks that consume item documents (vs internal counters). */
export const ITEM_FED_BLOCK_TYPES = Object.freeze([
  AMMO_BLOCK_TYPES.INTERNAL_MAGAZINE,
  AMMO_BLOCK_TYPES.EXTERNAL_CHARGE,
  AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE,
]);

/** Blocks whose damage comes from the weapon-side damage sub-block. */
export const WEAPON_DAMAGE_BLOCK_TYPES = Object.freeze([
  AMMO_BLOCK_TYPES.INTERNAL_CHARGE,
  AMMO_BLOCK_TYPES.EXTERNAL_CHARGE,
]);

export const FIRE_MODES = Object.freeze({
  SINGLE: 'single',
  BURST: 'burst',
  AUTO: 'auto',
});

export const MOD_OPS = Object.freeze({
  ADD: 'add',
  MULT: 'mult',
  SET: 'set',
});

export const AMMO_SEARCH_MODES = Object.freeze({
  AUTO: 'auto',
  SEMI: 'semi',
  MANUAL: 'manual',
});

/**
 * Parameters a mode modifier can target. Used both by the sheet UI selector
 * and by {@link resolveEffectiveAttackParams}.
 * `kind`: 'plain' — plain number; 'toggleable' — {enabled, value}; 'damage' —
 * applied to every entry of the active damage sub-block.
 */
export const MODE_MODIFIER_PARAMS = Object.freeze([
  { id: 'line.aiming', kind: 'plain', labelKey: 'SPACEHOLDER.WeaponV3.Line.Aiming' },
  { id: 'line.trigger', kind: 'plain', labelKey: 'SPACEHOLDER.WeaponV3.Line.Trigger' },
  { id: 'line.energyMult', kind: 'toggleable', labelKey: 'SPACEHOLDER.WeaponV3.Line.EnergyMult' },
  { id: 'line.spread', kind: 'toggleable', labelKey: 'SPACEHOLDER.WeaponV3.Line.Spread' },
  { id: 'line.recoil', kind: 'toggleable', labelKey: 'SPACEHOLDER.WeaponV3.Line.Recoil' },
  { id: 'ergo.overall', kind: 'plain', labelKey: 'SPACEHOLDER.WeaponV3.Ergo.Overall' },
  { id: 'ergo.deadZone', kind: 'toggleable', labelKey: 'SPACEHOLDER.WeaponV3.Ergo.DeadZone' },
  { id: 'ergo.aimPenalty', kind: 'toggleable', labelKey: 'SPACEHOLDER.WeaponV3.Ergo.AimPenalty' },
  { id: 'ergo.critZoneBonus', kind: 'toggleable', labelKey: 'SPACEHOLDER.WeaponV3.Ergo.CritZoneBonus' },
  { id: 'ergo.critZoneSize', kind: 'toggleable', labelKey: 'SPACEHOLDER.WeaponV3.Ergo.CritZoneSize' },
  { id: 'ergo.readying', kind: 'toggleable', labelKey: 'SPACEHOLDER.WeaponV3.Ergo.Readying' },
  { id: 'damage.damage', kind: 'damage', labelKey: 'SPACEHOLDER.WeaponV3.Damage.Damage' },
  { id: 'damage.armorPen', kind: 'damage', labelKey: 'SPACEHOLDER.WeaponV3.Damage.ArmorPen' },
  { id: 'damage.hardness', kind: 'damage', labelKey: 'SPACEHOLDER.WeaponV3.Damage.Hardness' },
  { id: 'damage.armorDamageReduction', kind: 'damage', labelKey: 'SPACEHOLDER.WeaponV3.Damage.ArmorDamageReduction' },
]);

/* ================================================================== *
 *  Small helpers                                                      *
 * ================================================================== */

function _rid(prefix = 'w') {
  try {
    const id = foundry?.utils?.randomID?.();
    if (id) return id;
  } catch (_) { /* not in Foundry runtime */ }
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function _bool(v, def = false) {
  if (v === undefined || v === null) return def;
  return !!v;
}

/**
 * Normalize `{enabled, value}` toggleable param.
 * @param {unknown} raw
 * @param {{enabled?:boolean, value?:number, min?:number}} def
 */
function _toggleable(raw, def = {}) {
  const defEnabled = def.enabled ?? false;
  const defValue = def.value ?? 0;
  const min = def.min ?? 0;
  if (raw === undefined || raw === null) return { enabled: defEnabled, value: defValue };
  if (typeof raw === 'number') return { enabled: defEnabled, value: Math.max(min, shNum(raw, defValue)) };
  if (typeof raw !== 'object') return { enabled: defEnabled, value: defValue };
  return {
    enabled: _bool(raw.enabled, defEnabled),
    value: Math.max(min, shNum(raw.value, defValue)),
  };
}

/**
 * Parse a caliber/connector string `"Тип А, Тип Б"` into trimmed tokens.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseCompatTokens(raw) {
  return shStr(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * At least one token matches between two compat strings.
 * @param {unknown} a
 * @param {unknown} b
 */
export function compatMatches(a, b) {
  const ta = parseCompatTokens(a);
  const tb = new Set(parseCompatTokens(b));
  return ta.some((t) => tb.has(t));
}

/* ================================================================== *
 *  Defaults / factories                                               *
 * ================================================================== */

/** @returns {object} */
export function defaultErgonomics() {
  return {
    overall: 100,
    zones: { enabled: false, green: 100, yellow: 100, orange: 100, red: 100 },
    deadZone: { enabled: false, value: 100 },
    aimPenalty: { enabled: false, value: 100 },
    critZoneBonus: { enabled: false, value: 0 },
    critZoneSize: { enabled: false, value: 100 },
    readying: { enabled: true, value: 0 },
  };
}

/** @returns {object} */
export function createWeaponMode(seed = {}) {
  return normalizeWeaponMode({
    id: _rid('mode'),
    name: '',
    fireMode: FIRE_MODES.SINGLE,
    burstCount: 3,
    fireDelayAp: 5,
    enterCost: { enabled: false, value: 0 },
    exitCost: { enabled: false, value: 0 },
    modifiers: [],
    ...seed,
  });
}

/** @returns {object} */
export function createModeModifier(seed = {}) {
  return normalizeModeModifier({
    id: _rid('mod'),
    param: 'line.aiming',
    op: MOD_OPS.ADD,
    value: 0,
    enabled: true,
    disableParam: false,
    ...seed,
  });
}

/**
 * @param {string} type one of AMMO_BLOCK_TYPES
 * @returns {object}
 */
export function createAmmoBlock(type = AMMO_BLOCK_TYPES.INTERNAL_MAGAZINE, seed = {}) {
  return normalizeAmmoBlock({
    id: _rid('ammo'),
    type,
    capacity: 0,
    loadAmount: 1,
    chamberEnabled: false,
    autoFeed: false,
    caliber: '',
    connector: '',
    search: { hands: true, worn: true, inventory: true, containers: true, mode: AMMO_SEARCH_MODES.AUTO },
    apActions: {},
    damage: [],
    runtime: {},
    ...seed,
  });
}

/** @returns {object} */
export function createWeaponLine(seed = {}) {
  return normalizeWeaponLine({
    id: _rid('line'),
    name: '',
    trajectoryKind: 'simple',
    simpleLimit: { enabled: false, value: 0, unit: 'grid' },
    payloadId: '',
    aiming: 0,
    trigger: 0,
    energyMult: { enabled: false, value: 100 },
    spread: { enabled: false, value: 0 },
    recoil: { enabled: false, value: 0 },
    enterCost: { enabled: false, value: 0 },
    exitCost: { enabled: false, value: 0 },
    damage: [],
    ammoBlocks: [],
    modes: [createWeaponMode()],
    ...seed,
  });
}

export { defaultDamageEntry, normalizeDamageEntry, normalizeDamageEntries, activeDamageEntries, computeProjectileEnergy, damageEntriesToApplications, buildProjectileFromDamageEntries };

/* ================================================================== *
 *  Normalizers                                                        *
 * ================================================================== */

/**
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeErgonomics(raw) {
  const d = defaultErgonomics();
  if (!raw || typeof raw !== 'object') return d;
  const zonesRaw = raw.zones && typeof raw.zones === 'object' ? raw.zones : {};
  return {
    overall: Math.max(0, shInt(raw.overall, d.overall, 0)),
    zones: {
      enabled: _bool(zonesRaw.enabled, false),
      green: Math.max(0, shInt(zonesRaw.green, 100, 0)),
      yellow: Math.max(0, shInt(zonesRaw.yellow, 100, 0)),
      orange: Math.max(0, shInt(zonesRaw.orange, 100, 0)),
      red: Math.max(0, shInt(zonesRaw.red, 100, 0)),
    },
    deadZone: _toggleable(raw.deadZone, { enabled: false, value: 100 }),
    aimPenalty: _toggleable(raw.aimPenalty, { enabled: false, value: 100 }),
    critZoneBonus: _toggleable(raw.critZoneBonus, { enabled: false, value: 0 }),
    critZoneSize: _toggleable(raw.critZoneSize, { enabled: false, value: 100 }),
    readying: _toggleable(raw.readying, { enabled: true, value: 0 }),
  };
}

/**
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeModeModifier(raw) {
  if (!raw || typeof raw !== 'object') raw = {};
  const op = Object.values(MOD_OPS).includes(raw.op) ? raw.op : MOD_OPS.ADD;
  const known = MODE_MODIFIER_PARAMS.some((p) => p.id === raw.param);
  return {
    id: shStr(raw.id) || _rid('mod'),
    param: known ? raw.param : 'line.aiming',
    op,
    value: shNum(raw.value, 0),
    enabled: _bool(raw.enabled, true),
    disableParam: _bool(raw.disableParam, false),
  };
}

/**
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeWeaponMode(raw) {
  if (!raw || typeof raw !== 'object') raw = {};
  const fireMode = Object.values(FIRE_MODES).includes(raw.fireMode) ? raw.fireMode : FIRE_MODES.SINGLE;
  return {
    id: shStr(raw.id) || _rid('mode'),
    name: shStr(raw.name),
    fireMode,
    burstCount: Math.max(2, shInt(raw.burstCount, 3, 2)),
    fireDelayAp: Math.max(0, shNum(raw.fireDelayAp, 5)),
    enterCost: _toggleable(raw.enterCost, { enabled: false, value: 0 }),
    exitCost: _toggleable(raw.exitCost, { enabled: false, value: 0 }),
    modifiers: Array.isArray(raw.modifiers) ? raw.modifiers.map(normalizeModeModifier) : [],
  };
}

const AP_ACTION_KEYS = Object.freeze(['loadOne', 'loadX', 'reload', 'bolt', 'unload', 'empty']);

function _normalizeApActions(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of AP_ACTION_KEYS) {
    out[key] = _toggleable(src[key], { enabled: true, value: 0 });
  }
  return out;
}

function _normalizeAmmoSearch(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = Object.values(AMMO_SEARCH_MODES).includes(src.mode) ? src.mode : AMMO_SEARCH_MODES.AUTO;
  return {
    hands: _bool(src.hands, true),
    worn: _bool(src.worn, true),
    inventory: _bool(src.inventory, true),
    containers: _bool(src.containers, true),
    mode,
  };
}

function _normalizeBlockRuntime(raw, type) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {
    charge: Math.max(0, shInt(src.charge, 0, 0)),
    chamberCharge: _bool(src.chamberCharge, false),
    chamberItem: src.chamberItem && typeof src.chamberItem === 'object' ? src.chamberItem : null,
    contents: Array.isArray(src.contents) ? src.contents.filter((e) => e && typeof e === 'object') : [],
    magazine: src.magazine && typeof src.magazine === 'object' ? src.magazine : null,
  };
  if (type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    out.chamberItem = null;
    out.contents = [];
    out.magazine = null;
  } else {
    out.charge = 0;
    out.chamberCharge = false;
    if (type !== AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) out.magazine = null;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeAmmoBlock(raw) {
  if (!raw || typeof raw !== 'object') raw = {};
  const type = AMMO_BLOCK_TYPE_LIST.includes(raw.type) ? raw.type : AMMO_BLOCK_TYPES.INTERNAL_MAGAZINE;
  return {
    id: shStr(raw.id) || _rid('ammo'),
    type,
    capacity: Math.max(0, shInt(raw.capacity, 0, 0)),
    loadAmount: Math.max(0, shInt(raw.loadAmount, 1, 0)),
    chamberEnabled: _bool(raw.chamberEnabled, false),
    autoFeed: _bool(raw.autoFeed, false),
    caliber: shStr(raw.caliber),
    connector: shStr(raw.connector),
    search: _normalizeAmmoSearch(raw.search),
    apActions: _normalizeApActions(raw.apActions),
    damage: normalizeDamageEntries(raw.damage),
    runtime: _normalizeBlockRuntime(raw.runtime, type),
  };
}

/**
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeWeaponLine(raw) {
  if (!raw || typeof raw !== 'object') raw = {};
  const modes = Array.isArray(raw.modes) ? raw.modes.map(normalizeWeaponMode) : [];
  if (!modes.length) modes.push(createWeaponMode());
  return {
    id: shStr(raw.id) || _rid('line'),
    name: shStr(raw.name),
    trajectoryKind: normalizeTrajectoryKind(raw.trajectoryKind),
    simpleLimit: normalizeSimpleLimit(raw.simpleLimit),
    payloadId: shStr(raw.payloadId),
    aiming: Math.max(0, shNum(raw.aiming, 0)),
    trigger: Math.max(0, shNum(raw.trigger, 0)),
    energyMult: _toggleable(raw.energyMult, { enabled: false, value: 100 }),
    spread: _toggleable(raw.spread, { enabled: false, value: 0 }),
    recoil: _toggleable(raw.recoil, { enabled: false, value: 0 }),
    enterCost: _toggleable(raw.enterCost, { enabled: false, value: 0 }),
    exitCost: _toggleable(raw.exitCost, { enabled: false, value: 0 }),
    damage: normalizeDamageEntries(raw.damage),
    ammoBlocks: Array.isArray(raw.ammoBlocks) ? raw.ammoBlocks.map(normalizeAmmoBlock) : [],
    modes,
  };
}

function _normalizeWeaponState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    activeLineId: shStr(src.activeLineId),
    activeModeId: shStr(src.activeModeId),
    ready: _bool(src.ready, false),
  };
}

/**
 * Ammo item config (`weapon.ammo`, relevant when itemTags.isAmmo).
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeAmmoConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const chargeRaw = src.charge && typeof src.charge === 'object' ? src.charge : {};
  return {
    damage: normalizeDamageEntries(src.damage),
    caliber: shStr(src.caliber),
    connector: {
      enabled: _bool(src.connector?.enabled, false),
      value: shStr(src.connector?.value),
    },
    charge: {
      enabled: _bool(chargeRaw.enabled, false),
      max: Math.max(0, shInt(chargeRaw.max, 0, 0)),
      current: Math.max(0, shInt(chargeRaw.current, 0, 0)),
    },
    /** Magazine container round capacity (when connector.enabled). */
    capacity: Math.max(0, shInt(src.capacity, 0, 0)),
    consume: _bool(src.consume, true),
  };
}

/**
 * Normalize `system.weapon` (v3). Anything that is not v3 (legacy v1/v2
 * shapes) is discarded — per refactor decision, old data is not migrated.
 *
 * @param {unknown} raw
 * @param {object} [itemTags]
 * @returns {object}
 */
export function normalizeWeaponV3(raw, itemTags = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const isV3 = Math.floor(Number(src.version) || 0) >= SH_WEAPON_VERSION;
  const base = isV3 ? src : {};
  const lines = Array.isArray(base.lines) ? base.lines.map(normalizeWeaponLine) : [];
  const isWeapon = !!(itemTags?.isWeapon || itemTags?.isMelee || itemTags?.isRanged || itemTags?.isThrown);
  if (isWeapon && !lines.length) lines.push(createWeaponLine());
  return {
    version: SH_WEAPON_VERSION,
    ergonomics: normalizeErgonomics(base.ergonomics),
    lines,
    state: _normalizeWeaponState(base.state),
    ammo: normalizeAmmoConfig(base.ammo),
  };
}

/* ================================================================== *
 *  Derived data: attacks, effective params                            *
 * ================================================================== */

/**
 * @param {object} weapon normalized v3 weapon
 * @returns {Array<{lineId:string, modeId:string, line:object, mode:object}>}
 */
export function listWeaponAttacks(weapon) {
  const out = [];
  for (const line of weapon?.lines ?? []) {
    for (const mode of line.modes ?? []) {
      out.push({ lineId: line.id, modeId: mode.id, line, mode });
    }
  }
  return out;
}

/**
 * @param {object} weapon
 * @param {string} lineId
 * @returns {object|null}
 */
export function getWeaponLine(weapon, lineId) {
  return (weapon?.lines ?? []).find((l) => l.id === lineId) ?? null;
}

/**
 * @param {object} weapon
 * @param {string} lineId
 * @param {string} modeId
 * @returns {{line:object|null, mode:object|null}}
 */
export function getWeaponLineMode(weapon, lineId, modeId) {
  const line = getWeaponLine(weapon, lineId);
  const mode = line ? (line.modes ?? []).find((m) => m.id === modeId) ?? null : null;
  return { line, mode };
}

function _applyModToValue(value, mod) {
  switch (mod.op) {
    case MOD_OPS.MULT: return value * (mod.value / 100);
    case MOD_OPS.SET: return mod.value;
    case MOD_OPS.ADD:
    default:
      return value + mod.value;
  }
}

function _applyModToToggleable(target, mod) {
  if (mod.disableParam) {
    target.enabled = false;
    return;
  }
  // A modifier on a toggleable param can also enable it (e.g. set spread on
  // a line that has spread disabled).
  target.enabled = true;
  target.value = Math.max(0, _applyModToValue(target.value, mod));
}

/**
 * Resolve the effective attack parameters for `line × mode`: line params and
 * ergonomics with the mode's modifiers applied. Damage modifiers are returned
 * separately (they apply to whichever damage sub-block ends up active).
 *
 * @param {object} weapon normalized v3 weapon
 * @param {string} lineId
 * @param {string} modeId
 * @returns {{
 *   line: object, mode: object, ergonomics: object,
 *   damageMods: Array<object>,
 * }|null}
 */
export function resolveEffectiveAttackParams(weapon, lineId, modeId) {
  const { line, mode } = getWeaponLineMode(weapon, lineId, modeId);
  if (!line || !mode) return null;

  // Deep-ish copies of the parts that modifiers may touch.
  const effLine = {
    ...line,
    energyMult: { ...line.energyMult },
    spread: { ...line.spread },
    recoil: { ...line.recoil },
    enterCost: { ...line.enterCost },
    exitCost: { ...line.exitCost },
  };
  const ergo = normalizeErgonomics(weapon.ergonomics);
  const effErgo = {
    ...ergo,
    zones: { ...ergo.zones },
    deadZone: { ...ergo.deadZone },
    aimPenalty: { ...ergo.aimPenalty },
    critZoneBonus: { ...ergo.critZoneBonus },
    critZoneSize: { ...ergo.critZoneSize },
    readying: { ...ergo.readying },
  };
  const damageMods = [];

  for (const mod of mode.modifiers ?? []) {
    if (!mod.enabled) continue;
    switch (mod.param) {
      case 'line.aiming': effLine.aiming = Math.max(0, _applyModToValue(effLine.aiming, mod)); break;
      case 'line.trigger': effLine.trigger = Math.max(0, _applyModToValue(effLine.trigger, mod)); break;
      case 'line.energyMult': _applyModToToggleable(effLine.energyMult, mod); break;
      case 'line.spread': _applyModToToggleable(effLine.spread, mod); break;
      case 'line.recoil': _applyModToToggleable(effLine.recoil, mod); break;
      case 'ergo.overall': effErgo.overall = Math.max(0, _applyModToValue(effErgo.overall, mod)); break;
      case 'ergo.deadZone': _applyModToToggleable(effErgo.deadZone, mod); break;
      case 'ergo.aimPenalty': _applyModToToggleable(effErgo.aimPenalty, mod); break;
      case 'ergo.critZoneBonus': _applyModToToggleable(effErgo.critZoneBonus, mod); break;
      case 'ergo.critZoneSize': _applyModToToggleable(effErgo.critZoneSize, mod); break;
      case 'ergo.readying': _applyModToToggleable(effErgo.readying, mod); break;
      case 'damage.damage':
      case 'damage.armorPen':
      case 'damage.hardness':
      case 'damage.armorDamageReduction':
        damageMods.push(mod);
        break;
      default: break;
    }
  }

  return { line: effLine, mode, ergonomics: effErgo, damageMods };
}

/**
 * Apply collected damage modifiers + line energy multiplier to damage entries.
 * @param {object[]} entries normalized damage entries
 * @param {object[]} damageMods modifiers with `param: 'damage.*'`
 * @param {{enabled:boolean,value:number}} [energyMult] line energy multiplier
 * @returns {object[]}
 */
export function applyDamageModifiers(entries, damageMods = [], energyMult = null) {
  const out = normalizeDamageEntries(entries).map((e) => ({ ...e }));
  for (const mod of damageMods) {
    const field = String(mod.param || '').split('.')[1];
    if (!field) continue;
    for (const entry of out) {
      if (mod.disableParam) continue; // damage fields are not toggleable
      entry[field] = Math.max(0, _applyModToValue(Number(entry[field]) || 0, mod));
    }
  }
  if (energyMult?.enabled) {
    const k = Math.max(0, Number(energyMult.value) || 0) / 100;
    for (const entry of out) {
      // Энергия и урон умножаются на множитель энергии («длина ствола»).
      // Энергия выводится из damage/armorPen/hardness, поэтому масштабируем
      // damage (урон) и запоминаем явный множитель энергии для пайплайна.
      entry.damage = entry.damage * k;
      entry.energyMultApplied = k;
    }
  }
  return out;
}

/* ================================================================== *
 *  Ergonomics → aiming arcs                                           *
 * ================================================================== */

/**
 * Apply weapon ergonomics to the character's base aiming arc parameters.
 *
 * Rules (per ТЗ + clarifications):
 *  - «Общая» scales the TOTAL standard arc size (before the dead zone,
 *    which keeps priority).
 *  - Zone multipliers re-weight the zones while the total size stays
 *    fixed at `base × overall`.
 *  - Crit (purple) zone: flat bonus first, then the size multiplier.
 *  - Dead zone: multiplier on the character's dead zone.
 *  - «Помеха прицеливания» multiplies the deviation penalty.
 *
 * @param {object} base
 * @param {number} base.purpleZoneDeg
 * @param {number} base.totalArcDeg
 * @param {number[]} base.weights standard zone weights (green..red)
 * @param {number} base.deadZoneDeg
 * @param {object|null} ergo normalized ergonomics (possibly mode-modified)
 * @returns {{purpleZoneDeg:number, totalArcDeg:number, weights:number[], deadZoneDeg:number, aimPenaltyMult:number}}
 */
export function applyErgonomicsToArcs(base, ergo) {
  const out = {
    purpleZoneDeg: Math.max(0, Number(base?.purpleZoneDeg) || 0),
    totalArcDeg: Math.max(0, Number(base?.totalArcDeg) || 0),
    weights: (Array.isArray(base?.weights) ? base.weights : []).map((w) => Math.max(0, Number(w) || 0)),
    deadZoneDeg: Math.max(0, Number(base?.deadZoneDeg) || 0),
    aimPenaltyMult: 1,
  };
  if (!ergo || typeof ergo !== 'object') return out;
  const e = normalizeErgonomics(ergo);

  out.totalArcDeg *= e.overall / 100;

  if (e.zones.enabled && out.weights.length >= 4) {
    out.weights = [
      out.weights[0] * (e.zones.green / 100),
      out.weights[1] * (e.zones.yellow / 100),
      out.weights[2] * (e.zones.orange / 100),
      ...out.weights.slice(3).map((w) => w * (e.zones.red / 100)),
    ];
  }

  let purple = out.purpleZoneDeg;
  if (e.critZoneBonus.enabled) purple += e.critZoneBonus.value;
  if (e.critZoneSize.enabled) purple *= e.critZoneSize.value / 100;
  out.purpleZoneDeg = Math.max(0, purple);

  if (e.deadZone.enabled) out.deadZoneDeg *= e.deadZone.value / 100;
  if (e.aimPenalty.enabled) out.aimPenaltyMult = Math.max(0, e.aimPenalty.value / 100);

  return out;
}

/* ================================================================== *
 *  Display helpers                                                    *
 * ================================================================== */

/**
 * Effective reserve capacity `N` for an ammo block.
 * External magazines prefer attached magazine item capacity, then block fallback.
 * @param {object} block normalized ammo block
 * @returns {number}
 */
export function resolveBlockCapacity(block) {
  if (!block) return 0;
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    const mag = block.runtime?.magazine;
    if (mag) {
      const fromMag = Math.max(0, Number(normalizeAmmoConfig(mag.system?.weapon?.ammo).capacity) || 0);
      if (fromMag > 0) return fromMag;
    }
    return Math.max(0, Number(block.capacity) || 0);
  }
  return Math.max(0, Number(block.capacity) || 0);
}

/**
 * Ammo counter for a block: `[камера]+резерв/N` or `резерв/N`.
 * @param {object} block normalized ammo block
 * @returns {string}
 */
export function formatAmmoCounter(block) {
  if (!block) return '';
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE && !block.runtime?.magazine) {
    return game?.i18n?.localize?.('SPACEHOLDER.WeaponV3.Ammo.NoMagazineAttached') ?? '—';
  }
  const n = resolveBlockCapacity(block);
  let reserve = 0;
  let chamber = 0;
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    reserve = Math.max(0, Number(block.runtime?.charge) || 0);
    chamber = block.runtime?.chamberCharge ? 1 : 0;
  } else if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    const mag = block.runtime?.magazine;
    reserve = Array.isArray(mag?.system?.storage?.contents)
      ? mag.system.storage.contents.reduce((sum, e) => sum + Math.max(0, Number(e?.system?.quantity) || 0), 0)
      : 0;
    chamber = block.runtime?.chamberItem ? 1 : 0;
  } else {
    reserve = (block.runtime?.contents ?? []).reduce((sum, e) => sum + Math.max(0, Number(e?.system?.quantity) || 0), 0);
    chamber = block.runtime?.chamberItem ? 1 : 0;
  }
  if (block.chamberEnabled) return `${chamber}+${reserve}/${n}`;
  return `${reserve}/${n}`;
}

/**
 * Rounds-per-minute display for a fire delay in AP (10 AP = 1 s).
 * @param {number} fireDelayAp
 * @returns {number}
 */
export function fireDelayToRpm(fireDelayAp) {
  const delay = Math.max(0, Number(fireDelayAp) || 0);
  if (delay <= 0) return Infinity;
  const secondsPerShot = delay / AP_PER_SECOND;
  return Math.round(60 / secondsPerShot);
}

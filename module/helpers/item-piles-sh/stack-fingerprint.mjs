import { ITEM_PILES_SH } from './constants.mjs';

/**
 * Deterministic stack-identity fingerprint for Item data (plain object or document shape).
 * Excludes quantity/held/equipped and pile-only flags under `flags.spaceholder.itemPilesSh`.
 *
 * @param {object} itemLike
 * @returns {string} hex hash
 */
export function computeItemStackFingerprint(itemLike) {
  const identity = buildStackIdentity(itemLike);
  return hashString(stableStringify(identity));
}

/**
 * @param {Actor|null|undefined} actor
 * @returns {boolean}
 */
export function isPileLootActor(actor) {
  if (!actor || actor.documentName !== 'Actor') return false;
  if (actor.type !== ITEM_PILES_SH.PILE_DEFAULT_ACTOR_TYPE) return false;
  try {
    const viaGet = actor.getFlag?.(ITEM_PILES_SH.FLAG_SCOPE, ITEM_PILES_SH.FLAG_ROOT);
    if (viaGet?.isPile) return true;
    return !!actor.flags?.[ITEM_PILES_SH.FLAG_SCOPE]?.[ITEM_PILES_SH.FLAG_ROOT]?.isPile;
  } catch (_) {
    return false;
  }
}

/**
 * @param {object} item
 * @returns {string|null}
 */
export function getCachedStackFingerprint(item) {
  if (!item?.getFlag) return null;
  try {
    const root = item.getFlag(ITEM_PILES_SH.FLAG_SCOPE, ITEM_PILES_SH.FLAG_ROOT);
    const fp = root?.[ITEM_PILES_SH.STACK_FINGERPRINT_KEY];
    return typeof fp === 'string' && fp.length ? fp : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} itemLike
 * @returns {object}
 */
export function buildStackIdentity(itemLike) {
  const src = foundry.utils.deepClone(itemLike ?? {});

  const system = src.system && typeof src.system === 'object' ? foundry.utils.deepClone(src.system) : {};
  delete system.quantity;
  delete system.held;
  delete system.equipped;

  const flagsIn = src.flags && typeof src.flags === 'object' ? foundry.utils.deepClone(src.flags) : {};
  const scope = flagsIn[ITEM_PILES_SH.FLAG_SCOPE];
  if (scope && typeof scope === 'object') {
    const nextScope = { ...scope };
    delete nextScope[ITEM_PILES_SH.FLAG_ROOT];
    if (Object.keys(nextScope).length) flagsIn[ITEM_PILES_SH.FLAG_SCOPE] = nextScope;
    else delete flagsIn[ITEM_PILES_SH.FLAG_SCOPE];
  }
  if (flagsIn.core && typeof flagsIn.core === 'object') {
    const core = { ...flagsIn.core };
    delete core.sourceId;
    if (Object.keys(core).length) flagsIn.core = core;
    else delete flagsIn.core;
  }
  if (!Object.keys(flagsIn).length) {
    // leave undefined — omit from identity
  }

  const effectsRaw = Array.isArray(src.effects) ? src.effects : [];
  const effects = stableSortedEffects(effectsRaw);

  const out = {
    type: src.type,
    name: src.name,
    img: src.img,
    system: stableSortKeysDeep(system),
    effects,
  };
  if (Object.keys(flagsIn).length) {
    out.flags = stableSortKeysDeep(flagsIn);
  }
  return out;
}

/**
 * @param {object[]} effects
 * @returns {object[]}
 */
function stableSortedEffects(effects) {
  const normalized = effects.map((e) => stableSortKeysDeep(e && typeof e === 'object' ? e : {}));
  normalized.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  return normalized;
}

/**
 * @param {object|null|undefined} obj
 * @returns {object|unknown}
 */
function stableSortKeysDeep(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((x) => stableSortKeysDeep(x));
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = stableSortKeysDeep(obj[key]);
  }
  return out;
}

/**
 * @param {object} obj
 * @returns {string}
 */
function stableStringify(obj) {
  return JSON.stringify(obj);
}

/**
 * FNV-1a 32-bit — fast, deterministic.
 * @param {string} str
 * @returns {string}
 */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Merge pending create/update data and compute fingerprint for hooks.
 * @param {object} item
 * @param {object} data
 * @returns {string}
 */
export function computeFingerprintForPendingItem(item, data) {
  const base = item?.toObject ? item.toObject(false) : {};
  const merged = foundry.utils.mergeObject(foundry.utils.deepClone(base), data ?? {}, { inplace: false });
  return computeItemStackFingerprint(merged);
}

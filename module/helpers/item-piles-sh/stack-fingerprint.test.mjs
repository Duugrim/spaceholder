/**
 * Smoke tests for pile detection and the cached stack fingerprint of pile items. Runs in plain Node with
 * stubbed Foundry globals. Execute with:
 *   node module/helpers/item-piles-sh/stack-fingerprint.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

let failed = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// Minimal Foundry utils (dotted paths, deep merge, clone)
// ---------------------------------------------------------------------------------------------------

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
function setProperty(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return true;
}
function getProperty(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function mergeObject(original, other) {
  const out = clone(original) ?? {};
  for (const [k, v] of Object.entries(other ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = mergeObject(out[k], v);
    else out[k] = clone(v);
  }
  return out;
}

const hooks = new Map();
globalThis.Hooks = {
  on: (name, fn) => {
    if (!hooks.has(name)) hooks.set(name, []);
    hooks.get(name).push(fn);
  },
  off() {},
  callAll() {},
};
globalThis.game = { user: { id: 'p1', isGM: false }, users: {} };
globalThis.CONST = {};
globalThis.foundry = { utils: { deepClone: clone, mergeObject, getProperty, setProperty, randomID: () => 'rnd' } };

const { ITEM_PILES_SH } = await import('./constants.mjs');
const { computeItemStackFingerprint, hasPileFlag, isPileLootActor, getCachedStackFingerprint } = await import('./stack-fingerprint.mjs');
const { ItemPilesShPrivateApi } = await import('./private-api.mjs');

const SCOPE = ITEM_PILES_SH.FLAG_SCOPE;
const ROOT = ITEM_PILES_SH.FLAG_ROOT;

function withFlags(flags) {
  return {
    flags,
    getFlag: (scope, key) => flags?.[scope]?.[key],
  };
}
const pileFlags = { [SCOPE]: { [ROOT]: { isPile: true } } };

function makeActor({ type = 'loot', actorFlags = {}, tokenFlags = null } = {}) {
  const actor = { documentName: 'Actor', type, ...withFlags(actorFlags), token: tokenFlags ? withFlags(tokenFlags) : null };
  return actor;
}

// ---------------------------------------------------------------------------------------------------
// Pile detection
// ---------------------------------------------------------------------------------------------------

assert('the marker on the token makes the actor a pile (how piles are really created)', isPileLootActor(makeActor({ tokenFlags: pileFlags })));
assert('the marker on the actor still counts', isPileLootActor(makeActor({ actorFlags: pileFlags })));
assert('the shared template actor (no token, no marker) is not a pile', !isPileLootActor(makeActor()));
assert('a token without the marker is not a pile either (a chest)', !isPileLootActor(makeActor({ tokenFlags: {} })));
assert('only loot actors are piles', !isPileLootActor(makeActor({ type: 'character', tokenFlags: pileFlags })));
assert('not an actor, not a pile', !isPileLootActor(null) && !isPileLootActor({ documentName: 'Item' }));
assert('hasPileFlag reads both flag accessors and survives junk', hasPileFlag(withFlags(pileFlags)) && hasPileFlag({ flags: pileFlags }) && !hasPileFlag(null) && !hasPileFlag({}));

// ---------------------------------------------------------------------------------------------------
// Fingerprint identity
// ---------------------------------------------------------------------------------------------------

const base = { type: 'item', name: 'Rope', img: 'rope.svg', system: { quantity: 3, held: true, equipped: false, weight: 1 }, effects: [], flags: {} };
{
  const fp = computeItemStackFingerprint(base);
  assert('quantity / held / equipped are not part of the identity', fp === computeItemStackFingerprint({ ...base, system: { ...base.system, quantity: 9, held: false, equipped: true } }));
  assert('pile bookkeeping flags are not part of the identity', fp === computeItemStackFingerprint({ ...base, flags: { [SCOPE]: { [ROOT]: { droppedAt: 1, stackFingerprint: 'abc' } } } }));
  assert('the name is part of the identity', fp !== computeItemStackFingerprint({ ...base, name: 'Better rope' }));
}

// ---------------------------------------------------------------------------------------------------
// Cache upkeep on updates (preUpdateItem)
// ---------------------------------------------------------------------------------------------------

ItemPilesShPrivateApi.initialize();
const preUpdate = hooks.get('preUpdateItem')?.[0];
const preCreate = hooks.get('preCreateItem')?.[0];
assert('the fingerprint hooks are registered', typeof preUpdate === 'function' && typeof preCreate === 'function');

function makePileItem(data, actor) {
  const item = { parent: actor, ...withFlags(data.flags ?? {}), toObject: () => clone(data) };
  return item;
}
const FP_PATH = `flags.${SCOPE}.${ROOT}.${ITEM_PILES_SH.STACK_FINGERPRINT_KEY}`;

{
  const pile = makeActor({ tokenFlags: pileFlags });
  const fp = computeItemStackFingerprint(base);
  const item = makePileItem({ ...base, flags: { [SCOPE]: { [ROOT]: { stackFingerprint: fp } } } }, pile);

  const rename = { name: 'Better rope' };
  preUpdate(item, rename, {}, 'u');
  assert('renaming a pile item refreshes its cached fingerprint (a stale one would merge the wrong drops)', getProperty(rename, FP_PATH) === computeItemStackFingerprint({ ...base, name: 'Better rope' }), rename);

  const take = { system: { quantity: 1 } };
  preUpdate(item, take, {}, 'u');
  assert('taking some of a stack leaves the cache alone', getProperty(take, FP_PATH) === undefined, take);
  assert('getCachedStackFingerprint reads what the stack holds', getCachedStackFingerprint(item) === fp);
}
{
  const pile = makeActor({ tokenFlags: pileFlags });
  const fp = computeItemStackFingerprint(base);
  const marked = `${fp}${ITEM_PILES_SH.STACK_FRESH_MARK}rnd`;
  const item = makePileItem({ ...base, flags: { [SCOPE]: { [ROOT]: { stackFingerprint: marked } } } }, pile);

  const take = { system: { quantity: 1 } };
  preUpdate(item, take, {}, 'u');
  assert('a never-merge stack keeps its mark when only the quantity changes', getProperty(take, FP_PATH) === undefined, take);

  const rename = { name: 'Better rope' };
  preUpdate(item, rename, {}, 'u');
  assert('…and keeps it when the identity changes (new hash, same mark)', getProperty(rename, FP_PATH) === `${computeItemStackFingerprint({ ...base, name: 'Better rope' })}${ITEM_PILES_SH.STACK_FRESH_MARK}rnd`, rename);
}
{
  const chest = makeActor({ tokenFlags: {} });
  const item = makePileItem({ ...base, flags: {} }, chest);
  const rename = { name: 'Better rope' };
  preUpdate(item, rename, {}, 'u');
  assert('items outside piles are not touched', getProperty(rename, FP_PATH) === undefined, rename);
}
{
  const pile = makeActor({ tokenFlags: pileFlags });
  const item = makePileItem({ ...base, flags: {} }, pile);
  const data = { ...clone(base) };
  preCreate(item, data, {}, 'u');
  assert('an item created in a pile without a cached fingerprint gets one', getProperty(data, FP_PATH) === computeItemStackFingerprint(base), data);
  const given = { ...clone(base), flags: { [SCOPE]: { [ROOT]: { stackFingerprint: 'given' } } } };
  preCreate(item, given, {}, 'u');
  assert('…and one that came with it is kept', getProperty(given, FP_PATH) === 'given', given);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll stack-fingerprint tests passed');

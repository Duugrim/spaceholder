const STORAGE_DEFAULTS = Object.freeze({
  version: 1,
  enabled: true,
  slots: Object.freeze({
    attachedContainerId: '',
    chamberItemId: '',
  }),
  contents: Object.freeze([]),
});

const RANGED_FEED_SOURCES = Object.freeze({
  ATTACHED_CONTAINER: 'attachedContainer',
  CHAMBER: 'chamber',
  WORN_CONTAINERS: 'wornContainers',
  ACTOR_INVENTORY: 'actorInventory',
  SELF: 'self',
});

function _clone(value) {
  try {
    return foundry.utils.deepClone(value);
  } catch (_) {
    return JSON.parse(JSON.stringify(value ?? null));
  }
}

function _id() {
  try {
    const id = foundry.utils.randomID?.();
    if (id) return id;
  } catch (_) { /* ignore */ }
  try {
    const id = globalThis.randomID?.();
    if (id) return id;
  } catch (_) { /* ignore */ }
  return `nested_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function _str(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function _int(value, fallback = 0, min = 0) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function _tags(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => _str(v)).filter(Boolean);
}

function _quantityOf(itemLike) {
  return _int(itemLike?.system?.quantity, 0, 0);
}

function _setQuantity(itemLike, quantity) {
  if (!itemLike.system || typeof itemLike.system !== 'object') itemLike.system = {};
  itemLike.system.quantity = _int(quantity, 0, 0);
}

function _isItemDocument(doc) {
  return doc?.documentName === 'Item' || doc instanceof Item;
}

function _isEmbeddedActorItem(doc) {
  return _isItemDocument(doc) && doc?.isEmbedded === true && doc?.parent?.documentName === 'Actor';
}

function _isAmmoLike(itemLike) {
  return itemLike?.type === 'item' && !!itemLike?.system?.itemTags?.isAmmo;
}

function _resourceTags(ammoLike) {
  const res = ammoLike?.system?.weapon?.ammo?.resource ?? {};
  return new Set([
    _str(res.caliberTag),
    ..._tags(res.compatibilityTags),
  ].filter(Boolean));
}

function _nameOf(itemLike) {
  return _str(itemLike?.name, game?.i18n?.localize?.('SPACEHOLDER.Inventory.NewItem') ?? 'Item') || 'Item';
}

/**
 * Normalize serialized nested storage on any item-like object.
 *
 * Storage is intentionally plain data: every contained entry is a compact Item
 * snapshot with its own `system.storage`, so weapon -> magazine -> ammo works
 * without relying on Foundry embedded Items under Item documents.
 *
 * @param {object|null|undefined} raw
 * @returns {{version:number, enabled:boolean, slots:{attachedContainerId:string,chamberItemId:string}, contents:Array<object>}}
 */
export function normalizeNestedStorage(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const slots = src.slots && typeof src.slots === 'object' ? src.slots : {};
  const contents = Array.isArray(src.contents) ? src.contents : [];
  return {
    version: 1,
    enabled: src.enabled !== false,
    slots: {
      attachedContainerId: _str(slots.attachedContainerId),
      chamberItemId: _str(slots.chamberItemId),
    },
    contents: contents.map(normalizeNestedItemRecord).filter(Boolean),
  };
}

/**
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
export function normalizeNestedItemRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const system = raw.system && typeof raw.system === 'object' ? _clone(raw.system) : {};
  system.quantity = _int(system.quantity, 1, 0);
  system.storage = normalizeNestedStorage(system.storage);
  return {
    id: _str(raw.id) || _id(),
    type: _str(raw.type, 'item') || 'item',
    name: _nameOf(raw),
    img: _str(raw.img),
    system,
    flags: raw.flags && typeof raw.flags === 'object' ? _clone(raw.flags) : {},
    effects: Array.isArray(raw.effects) ? _clone(raw.effects) : [],
    sourceUuid: _str(raw.sourceUuid ?? raw.uuid),
  };
}

/**
 * @param {Item|object} itemLike
 * @returns {object}
 */
export function snapshotItemForNestedStorage(itemLike) {
  const obj = itemLike?.toObject ? itemLike.toObject(false) : _clone(itemLike ?? {});
  return normalizeNestedItemRecord({
    id: _id(),
    type: obj.type ?? 'item',
    name: obj.name ?? itemLike?.name,
    img: obj.img ?? itemLike?.img,
    system: obj.system ?? itemLike?.system ?? {},
    flags: obj.flags ?? itemLike?.flags ?? {},
    effects: obj.effects ?? [],
    sourceUuid: itemLike?.uuid ?? obj.uuid ?? '',
  });
}

/**
 * @param {Item|object|null|undefined} itemLike
 * @returns {object}
 */
export function getNestedStorage(itemLike) {
  return normalizeNestedStorage(itemLike?.system?.storage);
}

/**
 * @param {object} storage
 * @returns {Array<object>}
 */
export function flattenNestedContents(storage) {
  const out = [];
  const visit = (entry, path) => {
    if (!entry) return;
    const nextPath = [...path, entry.id];
    out.push({ item: entry, path: nextPath });
    const nested = normalizeNestedStorage(entry.system?.storage);
    for (const child of nested.contents) visit(child, nextPath);
  };
  for (const entry of normalizeNestedStorage(storage).contents) visit(entry, []);
  return out;
}

function _findDirectIndex(storage, id) {
  const wanted = _str(id);
  if (!wanted) return -1;
  return storage.contents.findIndex((entry) => _str(entry?.id) === wanted);
}

function _findByPath(storage, path) {
  const ids = Array.isArray(path) ? path.map(_str).filter(Boolean) : [];
  if (!ids.length) return null;
  let currentStorage = storage;
  let item = null;
  for (const id of ids) {
    const idx = _findDirectIndex(currentStorage, id);
    if (idx < 0) return null;
    item = currentStorage.contents[idx];
    currentStorage = normalizeNestedStorage(item.system?.storage);
    item.system.storage = currentStorage;
  }
  return item;
}

function _removeByPath(storage, path, quantity) {
  const ids = Array.isArray(path) ? path.map(_str).filter(Boolean) : [];
  if (!ids.length) return { item: null, removed: 0 };
  const [head, ...rest] = ids;
  const idx = _findDirectIndex(storage, head);
  if (idx < 0) return { item: null, removed: 0 };
  const entry = storage.contents[idx];
  if (rest.length) {
    entry.system.storage = normalizeNestedStorage(entry.system?.storage);
    return _removeByPath(entry.system.storage, rest, quantity);
  }
  const currentQty = _quantityOf(entry);
  const requested = _int(quantity, currentQty || 1, 1);
  const removed = Math.min(currentQty || requested, requested);
  const snapshot = _clone(entry);
  _setQuantity(snapshot, removed);
  if (currentQty > removed) {
    _setQuantity(entry, currentQty - removed);
  } else {
    storage.contents.splice(idx, 1);
  }
  return { item: snapshot, removed };
}

function _consumeFromPath(storage, path, quantity) {
  const ids = Array.isArray(path) ? path.map(_str).filter(Boolean) : [];
  if (!ids.length) return { ok: false, consumed: 0, item: null };
  const item = _findByPath(storage, ids);
  if (!item) return { ok: false, consumed: 0, item: null };
  const qty = _quantityOf(item);
  const requested = _int(quantity, 1, 1);
  if (qty < requested) return { ok: false, consumed: 0, item };
  const before = _clone(item);
  const removed = _removeByPath(storage, ids, requested);
  return { ok: !!removed.item, consumed: removed.removed, item: before };
}

function _appendOrStack(storage, itemRecord) {
  const next = normalizeNestedItemRecord(itemRecord);
  if (!next) return null;
  storage.contents.push(next);
  return next;
}

async function _updateItemStorage(item, storage) {
  if (!_isItemDocument(item) || typeof item.update !== 'function') return false;
  await item.update({ 'system.storage': normalizeNestedStorage(storage) });
  return true;
}

/**
 * Move/copy an Item document or item-like snapshot into another Item's nested
 * storage. Embedded actor items are decremented/deleted by default.
 *
 * @param {object} args
 * @param {Item} args.containerItem
 * @param {Item|object} args.item
 * @param {number} [args.quantity]
 * @param {boolean} [args.consumeSource]
 * @param {string[]} [args.parentPath]
 * @returns {Promise<object|null>}
 */
export async function addItemToNestedStorage({ containerItem, item, quantity = 1, consumeSource = true, parentPath = [] } = {}) {
  if (!_isItemDocument(containerItem) || !item) return null;
  const qty = _int(quantity, 1, 1);
  const sourceQty = _quantityOf(item) || qty;
  if (consumeSource && sourceQty < qty) return null;

  const storage = getNestedStorage(containerItem);
  let targetStorage = storage;
  const parentIds = Array.isArray(parentPath) ? parentPath.map(_str).filter(Boolean) : [];
  if (parentIds.length) {
    const parent = _findByPath(storage, parentIds);
    if (!parent) return null;
    parent.system.storage = normalizeNestedStorage(parent.system?.storage);
    targetStorage = parent.system.storage;
  }
  const snapshot = snapshotItemForNestedStorage(item);
  _setQuantity(snapshot, qty);
  const inserted = _appendOrStack(targetStorage, snapshot);
  if (!inserted) return null;

  await _updateItemStorage(containerItem, storage);

  if (consumeSource && _isEmbeddedActorItem(item)) {
    const nextQty = sourceQty - qty;
    if (nextQty > 0) await item.update({ 'system.quantity': nextQty });
    else await item.delete();
  }
  return inserted;
}

/**
 * Extract a top-level nested entry back to the owning actor inventory.
 *
 * @param {object} args
 * @param {Item} args.containerItem
 * @param {string[]} args.path
 * @param {number} [args.quantity]
 * @returns {Promise<Item|null>}
 */
export async function extractNestedItemToActor({ containerItem, path, quantity = 1 } = {}) {
  if (!_isItemDocument(containerItem)) return null;
  const actor = containerItem.actor ?? containerItem.parent;
  if (!actor || actor.documentName !== 'Actor' || typeof actor.createEmbeddedDocuments !== 'function') return null;
  const storage = getNestedStorage(containerItem);
  const removed = _removeByPath(storage, path, quantity);
  if (!removed.item) return null;
  await _updateItemStorage(containerItem, storage);
  const createData = _clone(removed.item);
  delete createData.id;
  delete createData.sourceUuid;
  const created = await actor.createEmbeddedDocuments('Item', [createData]);
  return created?.[0] ?? null;
}

/**
 * @param {Item} item
 * @param {object} storage
 * @returns {Promise<boolean>}
 */
export async function persistNestedStorage(item, storage) {
  return _updateItemStorage(item, storage);
}

/**
 * @param {object} ammoLike
 * @param {object} usage
 * @returns {boolean}
 */
export function isAmmoCompatibleWithUsage(ammoLike, usage = {}) {
  if (!_isAmmoLike(ammoLike)) return false;
  if (_quantityOf(ammoLike) <= 0) return false;
  const filters = _tags(usage?.feedFilterTags);
  if (!filters.length) return true;
  const ammoTags = _resourceTags(ammoLike);
  return filters.every((tag) => ammoTags.has(tag));
}

function _findNestedAmmoInStorage(storage, usage, { rootId = '' } = {}) {
  const flat = flattenNestedContents(storage);
  for (const row of flat) {
    if (rootId && row.path[0] !== rootId) continue;
    if (isAmmoCompatibleWithUsage(row.item, usage)) return { kind: 'nested', path: row.path, item: row.item };
  }
  return null;
}

function _actorItems(actor) {
  return Array.from(actor?.items ?? []);
}

function _findActorAmmo(actor, usage) {
  for (const item of _actorItems(actor)) {
    if (isAmmoCompatibleWithUsage(item, usage)) return { kind: 'actorItem', item };
  }
  return null;
}

function _findWornContainerAmmo(actor, usage) {
  for (const item of _actorItems(actor)) {
    if (item?.type !== 'item') continue;
    if (!(item.system?.equipped || item.system?.held)) continue;
    const storage = getNestedStorage(item);
    const found = _findNestedAmmoInStorage(storage, usage);
    if (found) return { ...found, ownerItem: item, ownerStorage: storage };
  }
  return null;
}

function _findPrimaryNestedAmmo(weaponItem, usage, source) {
  const storage = getNestedStorage(weaponItem);
  if (source === RANGED_FEED_SOURCES.CHAMBER) {
    const chamberId = _str(usage?.chamberCurrentId || storage.slots.chamberItemId);
    if (!chamberId) return null;
    const flat = flattenNestedContents(storage);
    const found = flat.find((row) =>
      row.path[row.path.length - 1] === chamberId &&
      isAmmoCompatibleWithUsage(row.item, usage)
    );
    if (found) return { kind: 'nested', path: found.path, item: found.item, ownerItem: weaponItem, ownerStorage: storage };
    return null;
  }
  if (source === RANGED_FEED_SOURCES.ATTACHED_CONTAINER) {
    const rootId = _str(usage?.attachedContainerId || storage.slots.attachedContainerId);
    const found = _findNestedAmmoInStorage(storage, usage, { rootId });
    if (found) return { ...found, ownerItem: weaponItem, ownerStorage: storage };
    if (!rootId) {
      const any = _findNestedAmmoInStorage(storage, usage);
      if (any) return { ...any, ownerItem: weaponItem, ownerStorage: storage };
    }
  }
  if (source === RANGED_FEED_SOURCES.SELF) {
    const found = _findNestedAmmoInStorage(storage, usage);
    if (found) return { ...found, ownerItem: weaponItem, ownerStorage: storage };
  }
  return null;
}

function _findAmmoSource({ actor, weaponItem, usage, source }) {
  const feedSource = _str(source, RANGED_FEED_SOURCES.ATTACHED_CONTAINER) || RANGED_FEED_SOURCES.ATTACHED_CONTAINER;
  if (feedSource === RANGED_FEED_SOURCES.ACTOR_INVENTORY) return _findActorAmmo(actor, usage);
  if (feedSource === RANGED_FEED_SOURCES.WORN_CONTAINERS) return _findWornContainerAmmo(actor, usage);
  return _findPrimaryNestedAmmo(weaponItem, usage, feedSource);
}

async function _consumeSource(source, quantity) {
  const qty = _int(quantity, 1, 1);
  if (!source) return { ok: false, item: null };
  if (source.kind === 'actorItem') {
    const item = source.item;
    const currentQty = _quantityOf(item);
    if (currentQty < qty) return { ok: false, item };
    const before = snapshotItemForNestedStorage(item);
    if (currentQty > qty) await item.update({ 'system.quantity': currentQty - qty });
    else await item.delete();
    return { ok: true, item: before, consumed: qty };
  }
  if (source.kind === 'nested') {
    const storage = source.ownerStorage ?? getNestedStorage(source.ownerItem);
    const consumed = _consumeFromPath(storage, source.path, qty);
    if (!consumed.ok) return { ok: false, item: source.item };
    await persistNestedStorage(source.ownerItem, storage);
    return { ok: true, item: consumed.item, consumed: consumed.consumed };
  }
  return { ok: false, item: null };
}

async function _setWeaponChamberItem(weaponItem, ammoSnapshot = null) {
  const storage = getNestedStorage(weaponItem);
  const nextId = ammoSnapshot ? _id() : '';
  if (ammoSnapshot) {
    const chamberItem = normalizeNestedItemRecord({ ..._clone(ammoSnapshot), id: nextId });
    _setQuantity(chamberItem, 1);
    storage.contents.push(chamberItem);
  }
  storage.slots.chamberItemId = nextId;
  await weaponItem.update({
    'system.storage': storage,
    'system.weapon.ranged.usage.chamberCurrentId': nextId,
  });
}

async function _feedNextIntoChamber({ actor, weaponItem, usage, feedSource }) {
  if (feedSource === RANGED_FEED_SOURCES.CHAMBER) {
    await _setWeaponChamberItem(weaponItem, null);
    return false;
  }
  let nextSource = _findAmmoSource({ actor, weaponItem, usage, source: feedSource });
  if (!nextSource && usage.takeFromActorInventory) nextSource = _findActorAmmo(actor, usage);
  if (!nextSource) {
    await _setWeaponChamberItem(weaponItem, null);
    return false;
  }
  const consumed = await _consumeSource(nextSource, 1);
  if (!consumed.ok) {
    await _setWeaponChamberItem(weaponItem, null);
    return false;
  }
  await _setWeaponChamberItem(weaponItem, consumed.item);
  return true;
}

function _mergeProjectile(weaponProjectile, ammoProjectile) {
  const base = weaponProjectile && typeof weaponProjectile === 'object' ? _clone(weaponProjectile) : {};
  const ammo = ammoProjectile && typeof ammoProjectile === 'object' ? ammoProjectile : {};
  const out = { ...base };
  const copyIfMeaningful = (key, predicate) => {
    const value = ammo[key];
    if (predicate(value)) out[key] = _clone(value);
  };
  copyIfMeaningful('damage', (v) => Number(v) > 0);
  copyIfMeaningful('damageType', (v) => _str(v).length > 0);
  copyIfMeaningful('armorPen', (v) => Number.isFinite(Number(v)) && Number(v) > 0);
  copyIfMeaningful('armorDamageFactor', (v) => Number.isFinite(Number(v)) && Number(v) > 0);
  copyIfMeaningful('hardness', (v) => Number.isFinite(Number(v)) && Number(v) > 0);
  copyIfMeaningful('projectilesPerUse', (v) => Number.isFinite(Number(v)) && Number(v) > 0);
  copyIfMeaningful('payloadId', (v) => _str(v).length > 0);
  copyIfMeaningful('applications', (v) => Array.isArray(v) && v.length > 0);
  copyIfMeaningful('builderId', (v) => _str(v).length > 0);
  return out;
}

/**
 * Resolve and consume ammunition for one ranged weapon shot.
 *
 * The weapon controls where the resolver searches via
 * `system.weapon.ranged.usage.feedSource`. Missing ammo blocks the shot unless
 * `takeFromActorInventory` is enabled, in which case actor inventory is the
 * final fallback.
 *
 * @param {object} args
 * @param {Actor|null} args.actor
 * @param {Item} args.weaponItem
 * @returns {Promise<{ok:boolean, reason?:string, projectile?:object, ammoItem?:object, builderContext?:object}>}
 */
export async function resolveAndConsumeRangedAmmoForShot({ actor, weaponItem } = {}) {
  if (!_isItemDocument(weaponItem)) return { ok: false, reason: 'noWeapon' };
  const ranged = weaponItem.system?.weapon?.ranged ?? {};
  const usage = ranged.usage ?? {};
  const consumePerUse = Math.max(1, _int(usage.consumePerUse, 1, 1));
  const feedSource = _str(usage.ammoUseMode || usage.feedSource, RANGED_FEED_SOURCES.ATTACHED_CONTAINER) || RANGED_FEED_SOURCES.ATTACHED_CONTAINER;
  const chamberEnabled = !!ranged.features?.chamberEnabled;

  let firedFromChamber = false;
  let source = chamberEnabled
    ? _findAmmoSource({ actor, weaponItem, usage, source: RANGED_FEED_SOURCES.CHAMBER })
    : null;
  if (source) firedFromChamber = true;
  if (!source) source = _findAmmoSource({ actor, weaponItem, usage, source: feedSource });
  if (!source && usage.takeFromActorInventory) source = _findActorAmmo(actor, usage);
  if (!source) return { ok: false, reason: 'noAmmo' };

  const consumed = await _consumeSource(source, consumePerUse);
  if (!consumed.ok) return { ok: false, reason: 'notEnoughAmmo' };
  let chamberFed = false;
  if (chamberEnabled && firedFromChamber) {
    chamberFed = await _feedNextIntoChamber({ actor, weaponItem, usage, feedSource });
  }

  const ammoItem = consumed.item;
  const projectile = _mergeProjectile(ranged.projectile, ammoItem?.system?.weapon?.ammo?.projectile);
  return {
    ok: true,
    projectile,
    ammoItem,
    builderContext: {
      shooterActorUuid: actor?.uuid ?? null,
      weaponItemUuid: weaponItem.uuid,
      weaponName: weaponItem.name,
      ammoItemUuid: ammoItem?.sourceUuid || ammoItem?.uuid || null,
      ammoName: ammoItem?.name ?? null,
      ammoNestedId: ammoItem?.id ?? null,
      feedSource,
      consumed: consumePerUse,
      firedFromChamber,
      chamberFed,
    },
  };
}

export const NESTED_STORAGE_FEED_SOURCES = RANGED_FEED_SOURCES;

const STORAGE_DEFAULTS = Object.freeze({
  version: 1,
  enabled: true,
  slots: Object.freeze({
    attachedContainerId: '',
    chamberItemId: '',
  }),
  contents: Object.freeze([]),
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
 * Remove a nested storage entry without extracting it back to the actor.
 *
 * @param {object} args
 * @param {Item} args.containerItem
 * @param {string[]} args.path
 * @returns {Promise<boolean>}
 */
export async function deleteNestedItemFromStorage({ containerItem, path } = {}) {
  if (!_isItemDocument(containerItem)) return false;
  const storage = getNestedStorage(containerItem);
  const removed = _removeByPath(storage, path, Number.MAX_SAFE_INTEGER);
  if (!removed.item) return false;
  await _updateItemStorage(containerItem, storage);
  return true;
}

/**
 * @param {Item} item
 * @param {object} storage
 * @returns {Promise<boolean>}
 */
export async function persistNestedStorage(item, storage) {
  return _updateItemStorage(item, storage);
}


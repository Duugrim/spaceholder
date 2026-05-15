import { ITEM_PILES_SH, getPileFlagPath } from './constants.mjs';
import { executeItemPilesShAsGm } from './socket-adapter.mjs';
import { getUserFactionUuids, normalizeUuid } from '../user-factions.mjs';
import {
  getActorItemIdsInContainer,
  orderedContainerDescendants,
  normalizeItemContainerFields,
  remapActorContainerContentsEntries,
  releaseDirectContainerChildrenToRoot,
} from '../item-container.mjs';
import {
  computeFingerprintForPendingItem,
  computeItemStackFingerprint,
  getCachedStackFingerprint,
  isPileLootActor,
} from './stack-fingerprint.mjs';

let _initialized = false;
let _pileTechFolderId = null;
let _genericPileActorId = null;

function _safeNumber(raw, fallback = 0) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function _resolveQuantity(dropData, itemDoc) {
  const fromData = _safeNumber(dropData?.quantity, NaN);
  if (Number.isFinite(fromData) && fromData > 0) return Math.floor(fromData);

  const fromSystem = _safeNumber(itemDoc?.system?.quantity, NaN);
  if (Number.isFinite(fromSystem) && fromSystem > 0) return Math.floor(fromSystem);

  return 1;
}

function _isPileTokenAtPoint(tokenDoc, x, y, gridSize) {
  if (!tokenDoc) return false;
  const tx = _safeNumber(tokenDoc.x, NaN);
  const ty = _safeNumber(tokenDoc.y, NaN);
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return false;

  const width = Math.max(1, _safeNumber(tokenDoc.width, 1)) * gridSize;
  const height = Math.max(1, _safeNumber(tokenDoc.height, 1)) * gridSize;

  const insideBounds = x >= tx && x <= tx + width && y >= ty && y <= ty + height;
  if (insideBounds) return true;

  const cx = tx + width / 2;
  const cy = ty + height / 2;
  const dist = Math.hypot(x - cx, y - cy);
  return dist <= Math.max(gridSize * ITEM_PILES_SH.PILE_MERGE_DISTANCE_MULTIPLIER, 10);
}

function _isPileToken(tokenDoc) {
  try {
    return !!(
      tokenDoc?.getFlag?.(ITEM_PILES_SH.FLAG_SCOPE, ITEM_PILES_SH.FLAG_ROOT)?.isPile ||
      tokenDoc?.flags?.[ITEM_PILES_SH.FLAG_SCOPE]?.[ITEM_PILES_SH.FLAG_ROOT]?.isPile ||
      tokenDoc?.actor?.getFlag?.(ITEM_PILES_SH.FLAG_SCOPE, ITEM_PILES_SH.FLAG_ROOT)?.isPile ||
      tokenDoc?.actor?.flags?.[ITEM_PILES_SH.FLAG_SCOPE]?.[ITEM_PILES_SH.FLAG_ROOT]?.isPile
    );
  } catch (_) {
    return false;
  }
}

function _normalizeUuid(raw) {
  return normalizeUuid(raw);
}

function _getRequesterUser(requesterUserId) {
  const id = String(requesterUserId || '').trim();
  if (!id) return game.user ?? null;
  return game.users?.get?.(id) ?? null;
}

function _ensureOwnerPermission(doc, requester) {
  if (!doc) return false;
  if (!requester) return false;
  if (requester.isGM) return true;
  return !!doc.testUserPermission?.(requester, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
}

function _getRequesterOwnedCharacterActors(requester) {
  if (!requester) return [];
  const out = [];
  if (requester.character?.type === 'character') out.push(requester.character);
  const actors = Array.from(game.actors?.values?.() ?? game.actors?.contents ?? []);
  for (const a of actors) {
    if (!a || a.type !== 'character') continue;
    if (out.some((x) => x.id === a.id)) continue;
    if (_ensureOwnerPermission(a, requester)) out.push(a);
  }
  return out;
}

function _hasLootKey(requester, lootActor) {
  const keyId = String(lootActor?.system?.keyId ?? '').trim();
  if (!keyId) return true;
  const keyNeedle = keyId.toLowerCase();
  const chars = _getRequesterOwnedCharacterActors(requester);
  for (const actor of chars) {
    for (const item of actor.items ?? []) {
      const id = String(item?.id ?? '').trim().toLowerCase();
      const uuid = String(item?.uuid ?? '').trim().toLowerCase();
      const name = String(item?.name ?? '').trim().toLowerCase();
      if (id === keyNeedle || uuid === keyNeedle || name === keyNeedle) return true;
    }
  }
  return false;
}

function _canAccessLootActor(requester, lootActor, { write = false } = {}) {
  if (!requester || !lootActor) return false;
  if (requester.isGM) return true;

  const mode = String(lootActor?.system?.visibilityMode ?? 'owner').trim();
  const requesterFactions = new Set(getUserFactionUuids(requester).map((u) => String(u).trim()).filter(Boolean));
  const actorFaction = String(lootActor?.system?.gFaction ?? '').trim();

  const ownerAccess = _ensureOwnerPermission(lootActor, requester);
  const factionAccess = mode === 'faction' && actorFaction && requesterFactions.has(actorFaction);
  const publicAccess = mode === 'all';
  const baseAccess = ownerAccess || factionAccess || publicAccess;
  if (!baseAccess) return false;
  if (!write) return true;

  const isLocked = !!lootActor?.system?.isLocked;
  if (!isLocked) return true;
  return _hasLootKey(requester, lootActor);
}

async function _resolveEmbeddedItemByUuid(uuid) {
  const normalized = _normalizeUuid(uuid);
  if (!normalized) return null;
  let doc = null;
  try {
    doc = await fromUuid(normalized);
  } catch (_) {
    doc = null;
  }
  if (!doc || doc.documentName !== 'Item') return null;
  if (doc?.isEmbedded !== true || doc?.parent?.documentName !== 'Actor') return null;
  return doc;
}

async function _resolveLootActorByUuid(uuid) {
  const normalized = _normalizeUuid(uuid);
  if (!normalized) return null;
  let doc = null;
  try {
    doc = await fromUuid(normalized);
  } catch (_) {
    doc = null;
  }
  if (!doc || doc.documentName !== 'Actor') return null;
  if (doc.type !== ITEM_PILES_SH.PILE_DEFAULT_ACTOR_TYPE) return null;
  const asTokenLike = doc?.isToken ? (doc?.token ?? null) : null;
  if (!_isPileToken(asTokenLike ?? { actor: doc, flags: doc.flags })) return null;
  return doc;
}

async function _resolveActorByUuid(uuid) {
  const normalized = _normalizeUuid(uuid);
  if (!normalized) return null;
  let doc = null;
  try {
    doc = await fromUuid(normalized);
  } catch (_) {
    doc = null;
  }
  if (!doc || doc.documentName !== 'Actor') return null;
  return doc;
}

function _euclideanCellsBetween(sourceTokenDoc, targetTokenDoc) {
  const gridSize = Math.max(1, _safeNumber(canvas?.grid?.size, 100));
  const sx = _safeNumber(sourceTokenDoc?.x, 0);
  const sy = _safeNumber(sourceTokenDoc?.y, 0);
  const tx = _safeNumber(targetTokenDoc?.x, 0);
  const ty = _safeNumber(targetTokenDoc?.y, 0);
  const dx = tx - sx;
  const dy = ty - sy;
  return Math.hypot(dx, dy) / gridSize;
}

function _safeInteger(raw, fallback = 0) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function _ownerAllPlayersOwnership() {
  const OWNER = Number(CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3);
  return { default: OWNER };
}

function _gmHiddenFolderOwnership() {
  const NONE = Number(CONST?.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0);
  return { default: NONE };
}

function _isPileTechFolder(folder) {
  if (!folder) return false;
  if (folder.type !== 'Actor') return false;
  const flag = folder.getFlag?.(ITEM_PILES_SH.FLAG_SCOPE, ITEM_PILES_SH.FLAG_ROOT);
  if (flag?.techFolder || flag?.droppedFolder) return true;
  if (String(folder.name || '').trim().toLowerCase() === 'dropped') return true;
  return String(folder.name || '').trim().toLowerCase() === String(ITEM_PILES_SH.PILE_TECH_FOLDER_NAME || '').trim().toLowerCase();
}

async function _ensurePileTechFolderAsGm() {
  if (!game.user?.isGM) return null;
  if (_pileTechFolderId) {
    const cached = game.folders?.get?.(_pileTechFolderId) ?? null;
    if (cached && _isPileTechFolder(cached)) return cached;
    _pileTechFolderId = null;
  }

  const folders = Array.from(game.folders?.contents ?? []).filter((f) => _isPileTechFolder(f));
  if (folders.length) {
    const existing = folders[0];
    _pileTechFolderId = existing.id;
    const patch = {};
    const own = foundry.utils.deepClone(existing.ownership ?? {});
    const desired = _gmHiddenFolderOwnership();
    if (String(existing.name || '') !== String(ITEM_PILES_SH.PILE_TECH_FOLDER_NAME || '')) patch.name = ITEM_PILES_SH.PILE_TECH_FOLDER_NAME;
    if (String(own.default ?? '') !== String(desired.default)) patch.ownership = desired;
    const flag = existing.getFlag?.(ITEM_PILES_SH.FLAG_SCOPE, ITEM_PILES_SH.FLAG_ROOT) ?? {};
    if (!flag?.techFolder) patch[`flags.${ITEM_PILES_SH.FLAG_SCOPE}.${ITEM_PILES_SH.FLAG_ROOT}.techFolder`] = true;
    if (Object.keys(patch).length) await existing.update(patch, { diff: false });
    return existing;
  }

  const created = await Folder.create({
    name: ITEM_PILES_SH.PILE_TECH_FOLDER_NAME,
    type: 'Actor',
    sorting: 'a',
    color: '#555555',
    ownership: _gmHiddenFolderOwnership(),
    flags: {
      [ITEM_PILES_SH.FLAG_SCOPE]: {
        [ITEM_PILES_SH.FLAG_ROOT]: { techFolder: true },
      },
    },
  }, { render: false });
  _pileTechFolderId = created?.id ?? null;
  return created ?? null;
}

async function _ensureGenericPileActorAsGm() {
  if (!game.user?.isGM) return null;
  if (_genericPileActorId) {
    const cached = game.actors?.get?.(_genericPileActorId) ?? null;
    if (cached && cached.type === ITEM_PILES_SH.PILE_DEFAULT_ACTOR_TYPE) return cached;
    _genericPileActorId = null;
  }

  const techFolder = await _ensurePileTechFolderAsGm();
  const actors = Array.from(game.actors?.contents ?? []);
  const existing = actors.find((a) => {
    if (!a || a.type !== ITEM_PILES_SH.PILE_DEFAULT_ACTOR_TYPE) return false;
    const flag = a.getFlag?.(ITEM_PILES_SH.FLAG_SCOPE, ITEM_PILES_SH.FLAG_ROOT);
    if (flag?.genericTemplate) return true;
    return String(a.name || '').trim().toLowerCase() === String(ITEM_PILES_SH.PILE_GENERIC_ACTOR_NAME).trim().toLowerCase();
  });

  if (existing) {
    _genericPileActorId = existing.id;
    const patch = {};
    if (String(existing.folder?.id || '') !== String(techFolder?.id || '')) patch.folder = techFolder?.id ?? null;
    const own = foundry.utils.deepClone(existing.ownership ?? {});
    const desired = _ownerAllPlayersOwnership();
    if (String(own.default ?? '') !== String(desired.default)) patch.ownership = desired;
    const flag = existing.getFlag?.(ITEM_PILES_SH.FLAG_SCOPE, ITEM_PILES_SH.FLAG_ROOT) ?? {};
    if (!flag?.genericTemplate) patch[`flags.${ITEM_PILES_SH.FLAG_SCOPE}.${ITEM_PILES_SH.FLAG_ROOT}.genericTemplate`] = true;
    if (Object.keys(patch).length) await existing.update(patch, { diff: false });
    return existing;
  }

  const created = await Actor.create({
    name: ITEM_PILES_SH.PILE_GENERIC_ACTOR_NAME,
    type: ITEM_PILES_SH.PILE_DEFAULT_ACTOR_TYPE,
    img: ITEM_PILES_SH.PILE_DEFAULT_TOKEN_TEXTURE,
    folder: techFolder?.id ?? null,
    ownership: _ownerAllPlayersOwnership(),
    flags: {
      [ITEM_PILES_SH.FLAG_SCOPE]: {
        [ITEM_PILES_SH.FLAG_ROOT]: {
          genericTemplate: true,
          moduleId: ITEM_PILES_SH.MODULE_ID,
        },
      },
    },
    prototypeToken: {
      name: ITEM_PILES_SH.PILE_DEFAULT_NAME,
      texture: { src: ITEM_PILES_SH.PILE_DEFAULT_TOKEN_TEXTURE },
      actorLink: false,
      disposition: 0,
      displayName: CONST.TOKEN_DISPLAY_MODES.OWNER_HOVER,
      displayBars: CONST.TOKEN_DISPLAY_MODES.NONE,
      flags: {
        [ITEM_PILES_SH.FLAG_SCOPE]: {
          [ITEM_PILES_SH.FLAG_ROOT]: {
            isPile: true,
          },
        },
      },
    },
  }, { renderSheet: false });

  _genericPileActorId = created?.id ?? null;
  return created ?? null;
}

function _normalizeItemDataForPile(itemData, quantity) {
  const normalized = foundry.utils.deepClone(itemData ?? {});
  delete normalized._id;
  normalized.system = normalized.system ?? {};
  normalized.system.held = false;
  normalized.system.equipped = false;
  normalized.system.quantity = Math.max(1, _safeNumber(quantity, 1));
  normalized.flags = normalized.flags ?? {};
  normalized.flags[ITEM_PILES_SH.FLAG_SCOPE] = normalized.flags[ITEM_PILES_SH.FLAG_SCOPE] ?? {};
  normalized.flags[ITEM_PILES_SH.FLAG_SCOPE][ITEM_PILES_SH.FLAG_ROOT] = {
    droppedAt: Date.now(),
  };
  return normalized;
}

function _findExistingItemByFingerprint(actor, incomingFp) {
  if (!actor || !incomingFp) return null;
  for (const it of actor.items ?? []) {
    const cached = getCachedStackFingerprint(it);
    if (cached === incomingFp) return it;
    try {
      const lazy = computeItemStackFingerprint(it.toObject(false));
      if (lazy === incomingFp) return it;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

function _registerItemStackFingerprintHooks() {
  Hooks.on('preCreateItem', (item, data, _options, _userId) => {
    try {
      if (!isPileLootActor(item.parent)) return;
      const fpPath = `flags.${ITEM_PILES_SH.FLAG_SCOPE}.${ITEM_PILES_SH.FLAG_ROOT}.${ITEM_PILES_SH.STACK_FINGERPRINT_KEY}`;
      const existing = foundry.utils.getProperty(data, fpPath);
      if (typeof existing === 'string' && existing.length) return;
      const fp = computeFingerprintForPendingItem(item, data);
      foundry.utils.setProperty(data, fpPath, fp);
    } catch (error) {
      console.error('SpaceHolder | item-piles-sh stackFingerprint preCreateItem', error);
    }
  });

  Hooks.on('preUpdateItem', (item, changes, _options, _userId) => {
    try {
      if (!isPileLootActor(item.parent)) return;
      if (!changes || typeof changes !== 'object') return;
      const merged = foundry.utils.mergeObject(item.toObject(false), changes, { inplace: false });
      const fp = computeItemStackFingerprint(merged);
      const cur = getCachedStackFingerprint(item);
      if (fp === cur) return;
      foundry.utils.setProperty(
        changes,
        `flags.${ITEM_PILES_SH.FLAG_SCOPE}.${ITEM_PILES_SH.FLAG_ROOT}.${ITEM_PILES_SH.STACK_FINGERPRINT_KEY}`,
        fp,
      );
    } catch (error) {
      console.error('SpaceHolder | item-piles-sh stackFingerprint preUpdateItem', error);
    }
  });
}

/**
 * @param {Actor} actor
 * @param {object} itemData
 * @param {number} quantity
 * @param {{ allowStackMerge?: boolean }} [opts]
 * @returns {Promise<Item|null>} created/merged Item on `actor`, or null
 */
async function _addItemToPileActor(actor, itemData, quantity, { allowStackMerge = true } = {}) {
  const normalized = _normalizeItemDataForPile(itemData, quantity);
  const incomingFp = computeItemStackFingerprint(normalized);
  const fpPath = `flags.${ITEM_PILES_SH.FLAG_SCOPE}.${ITEM_PILES_SH.FLAG_ROOT}.${ITEM_PILES_SH.STACK_FINGERPRINT_KEY}`;
  const fpValue = allowStackMerge
    ? incomingFp
    : `${incomingFp}|fresh:${foundry.utils.randomID()}`;
  foundry.utils.setProperty(normalized, fpPath, fpValue);

  if (!allowStackMerge) {
    const [created] = await actor.createEmbeddedDocuments('Item', [normalized]);
    return actor.items?.get?.(created?.id) ?? created ?? null;
  }

  const existing = _findExistingItemByFingerprint(actor, incomingFp);
  if (!existing) {
    const [created] = await actor.createEmbeddedDocuments('Item', [normalized]);
    return actor.items?.get?.(created?.id) ?? created ?? null;
  }
  const current = Math.max(0, _safeNumber(existing.system?.quantity, 1));
  const next = current + Math.max(1, _safeNumber(quantity, 1));
  await existing.update({ 'system.quantity': next });
  return existing;
}

/**
 * After the container host was recreated on `toActor` as `newHostItem`, clone all embedded
 * descendants from `fromActor`, remap ids in `system.container.contents`, then remove
 * descendants from the source actor. Does not delete `oldHostItem`.
 * @param {Actor} fromActor
 * @param {Actor} toActor
 * @param {Item} oldHostItem
 * @param {Item} newHostItem
 */
async function _migrateEmbeddedContainerSubtreeToActor(fromActor, toActor, oldHostItem, newHostItem) {
  const oldRootId = oldHostItem.id;
  const idMap = new Map([[oldRootId, newHostItem.id]]);
  const descendants = orderedContainerDescendants(fromActor, oldRootId);

  const snapshots = [];
  snapshots.push({
    oldId: oldRootId,
    contents: [...normalizeItemContainerFields(oldHostItem.system).container.contents],
  });
  for (const d of descendants) {
    if (!d.system?.itemTags?.isContainer) continue;
    snapshots.push({
      oldId: d.id,
      contents: [...normalizeItemContainerFields(d.system).container.contents],
    });
  }

  for (const doc of descendants) {
    const oldId = doc.id;
    const parentOld = String(doc.system?.containerHostId ?? '').trim();
    const newParentId = idMap.get(parentOld);
    if (!newParentId) continue;

    const qty = Math.max(1, _safeInteger(doc.system?.quantity, 1));
    const obj = doc.toObject(false);
    delete obj._id;
    obj.system = obj.system ?? {};
    obj.system.containerHostId = newParentId;
    if (obj.system.itemTags?.isContainer) {
      obj.system.container = { contents: [] };
    }
    const normalized = _normalizeItemDataForPile(obj, qty);
    const subFp = computeItemStackFingerprint(normalized);
    foundry.utils.setProperty(
      normalized,
      `flags.${ITEM_PILES_SH.FLAG_SCOPE}.${ITEM_PILES_SH.FLAG_ROOT}.${ITEM_PILES_SH.STACK_FINGERPRINT_KEY}`,
      `${subFp}|subtree:${foundry.utils.randomID()}`,
    );
    const [created] = await toActor.createEmbeddedDocuments('Item', [normalized]);
    const newId = created?.id;
    if (!newId) continue;
    idMap.set(oldId, newId);
  }

  const updates = [];
  for (const snap of snapshots) {
    const newHostId = idMap.get(snap.oldId);
    if (!newHostId) continue;
    const newContents = remapActorContainerContentsEntries(snap.contents, idMap);
    updates.push({ _id: newHostId, 'system.container': { contents: newContents } });
  }
  if (updates.length) {
    await toActor.updateEmbeddedDocuments('Item', updates, { render: false });
  }

  if (descendants.length) {
    await fromActor.deleteEmbeddedDocuments(
      'Item',
      descendants.map((d) => d.id),
      { render: false },
    );
  }
}

/**
 * Move an embedded Item from its owning actor onto `toActor` (pile or PC), including
 * container subtree when the whole stack is consumed.
 * @param {Item} fromItem
 * @param {Actor} toActor
 * @param {number} transferQty
 */
async function _transferEmbeddedItemToPileActor(fromItem, toActor, transferQty) {
  const fromActor = fromItem.parent;
  if (!fromActor || fromActor.documentName !== 'Actor') return;

  const sourceQty = Math.max(0, _safeInteger(fromItem.system?.quantity, 1));
  const qty = Math.max(1, Math.min(_safeInteger(transferQty, 1), sourceQty || 1));
  if (sourceQty <= 0) return;

  const next = sourceQty - qty;
  const descendants =
    fromItem.type === 'item' && fromItem.system?.itemTags?.isContainer
      ? orderedContainerDescendants(fromActor, fromItem.id)
      : [];
  const isFullHostTransfer = next <= 0 && descendants.length > 0;

  let hostPayload = fromItem.toObject(false);
  if (isFullHostTransfer) {
    hostPayload.system = hostPayload.system ?? {};
    hostPayload.system.container = { contents: [] };
  }

  const newHost = await _addItemToPileActor(toActor, hostPayload, qty, {
    allowStackMerge: !isFullHostTransfer,
  });

  if (isFullHostTransfer && newHost) {
    await _migrateEmbeddedContainerSubtreeToActor(fromActor, toActor, fromItem, newHost);
  }

  if (next <= 0) await fromItem.delete();
  else await fromItem.update({ 'system.quantity': next });
}

async function _addItemToPileToken(tokenDoc, itemData, quantity) {
  const actor = tokenDoc?.actor ?? null;
  if (!actor) throw new Error('pile token actor is unavailable');
  return _addItemToPileActor(actor, itemData, quantity);
}

async function _consumeSourceItem(dropData, quantity) {
  const uuid = String(dropData?.uuid || '').trim();
  if (!uuid) return;
  let source = null;
  try {
    source = await fromUuid(uuid);
  } catch (_) {
    source = null;
  }
  if (!source || source.documentName !== 'Item') return;
  if (source?.isEmbedded !== true || source?.parent?.documentName !== 'Actor') return;

  const current = Math.max(0, _safeNumber(source.system?.quantity, 1));
  const dropQty = Math.max(1, _safeNumber(quantity, 1));
  const next = current - dropQty;
  if (next <= 0) {
    if (source.type === 'item' && source.system?.itemTags?.isContainer) {
      await releaseDirectContainerChildrenToRoot(source.parent, source.id);
    }
    await source.delete();
    return;
  }
  await source.update({ 'system.quantity': next });
}

async function _findPileTokenOnScene(scene, x, y) {
  const gridSize = Math.max(10, _safeNumber(canvas?.grid?.size, 100));
  const docs = Array.isArray(scene?.tokens?.contents) ? scene.tokens.contents : [];
  for (const doc of docs) {
    if (!_isPileToken(doc)) continue;
    if (_isPileTokenAtPoint(doc, x, y, gridSize)) return doc;
  }
  return null;
}

async function _createPileTokenAsGm(scene, { x, y, textureSrc } = {}) {
  const genericActor = await _ensureGenericPileActorAsGm();
  if (!genericActor) throw new Error('generic pile actor is not available');

  const [created] = await scene.createEmbeddedDocuments('Token', [{
    name: ITEM_PILES_SH.PILE_DEFAULT_NAME,
    actorId: genericActor.id,
    actorLink: false,
    x: _safeNumber(x, 0),
    y: _safeNumber(y, 0),
    texture: { src: String(textureSrc || ITEM_PILES_SH.PILE_DEFAULT_TOKEN_TEXTURE).trim() || ITEM_PILES_SH.PILE_DEFAULT_TOKEN_TEXTURE },
    flags: {
      [ITEM_PILES_SH.FLAG_SCOPE]: {
        tokenpointer: {
          mode: 0,
        },
        [ITEM_PILES_SH.FLAG_ROOT]: {
          isPile: true,
          moduleId: ITEM_PILES_SH.MODULE_ID,
          autoGenerated: true,
        },
      },
    },
  }]);

  const tokenDoc = scene.tokens?.get?.(created?.id) ?? created ?? null;
  if (!tokenDoc) throw new Error('failed to create pile token');
  return tokenDoc;
}

async function _dropItemAsGm({ dropData, sceneId }) {
  const data = dropData ?? {};
  if (data.type !== 'Item') return { handled: false };
  const scene = game.scenes.get(sceneId);
  if (!scene) throw new Error('scene not found');

  const x = _safeNumber(data.x, NaN);
  const y = _safeNumber(data.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('drop point is invalid');

  const itemDoc = await (Item.implementation?.fromDropData?.(data) ?? Item.fromDropData(data));
  if (!itemDoc) throw new Error('item document is not available from drop data');
  const quantity = _resolveQuantity(data, itemDoc);
  const itemData = itemDoc.toObject();

  let embeddedSource = null;
  const dropUuid = String(data?.uuid || '').trim();
  if (dropUuid) {
    try {
      const doc = await fromUuid(dropUuid);
      if (
        doc?.documentName === 'Item' &&
        doc.isEmbedded === true &&
        doc.parent?.documentName === 'Actor'
      ) {
        embeddedSource = doc;
      }
    } catch (_) {
      embeddedSource = null;
    }
  }

  const pileToken = await _findPileTokenOnScene(scene, x, y);
  if (pileToken?.actor) {
    if (embeddedSource) {
      await _transferEmbeddedItemToPileActor(embeddedSource, pileToken.actor, quantity);
    } else {
      await _addItemToPileToken(pileToken, itemData, quantity);
      await _consumeSourceItem(data, quantity);
    }
    return {
      handled: true,
      mode: 'merge',
      tokenId: pileToken.id,
      actorId: pileToken.actor.id,
    };
  }

  const pileTokenDoc = await _createPileTokenAsGm(scene, { x, y, textureSrc: itemData?.img });
  if (embeddedSource) {
    await _transferEmbeddedItemToPileActor(embeddedSource, pileTokenDoc.actor, quantity);
  } else {
    await _addItemToPileToken(pileTokenDoc, itemData, quantity);
    await _consumeSourceItem(data, quantity);
  }
  return {
    handled: true,
    mode: 'create',
    tokenId: pileTokenDoc?.id ?? null,
    actorId: pileTokenDoc?.actor?.id ?? null,
  };
}

async function _transferItemAsGm(payload = {}, { requesterUserId } = {}) {
  const requester = _getRequesterUser(requesterUserId);
  if (!requester) throw new Error('requester user not found');

  const fromItem = await _resolveEmbeddedItemByUuid(payload?.fromItemUuid);
  if (!fromItem) throw new Error('source item not found');
  const toActor = await _resolveActorByUuid(payload?.toActorUuid);
  if (!toActor) throw new Error('target actor not found');

  const fromActor = fromItem.parent;
  if (fromActor?.type === ITEM_PILES_SH.PILE_DEFAULT_ACTOR_TYPE) {
    if (!_canAccessLootActor(requester, fromActor, { write: true })) {
      throw new Error('permission denied: cannot access source pile');
    }
  } else if (!_ensureOwnerPermission(fromActor, requester)) {
    throw new Error('permission denied: source owner required');
  }

  if (toActor?.type === ITEM_PILES_SH.PILE_DEFAULT_ACTOR_TYPE) {
    if (!_canAccessLootActor(requester, toActor, { write: true })) {
      throw new Error('permission denied: cannot access target pile');
    }
  } else if (!_ensureOwnerPermission(toActor, requester)) {
    throw new Error('permission denied: target owner required');
  }

  if (payload?.sourceTokenUuid && payload?.pileTokenUuid) {
    let sourceToken = null;
    let pileToken = null;
    try { sourceToken = await fromUuid(_normalizeUuid(payload.sourceTokenUuid)); } catch (_) { sourceToken = null; }
    try { pileToken = await fromUuid(_normalizeUuid(payload.pileTokenUuid)); } catch (_) { pileToken = null; }
    const maxDist = Math.max(0, _safeNumber(toActor?.system?.interactionDistance, 2));
    if (sourceToken?.documentName === 'Token' && pileToken?.documentName === 'Token' && maxDist > 0) {
      const dist = _euclideanCellsBetween(sourceToken, pileToken);
      if (dist > maxDist) throw new Error('interaction distance exceeded');
    }
  }

  const requested = _safeInteger(payload?.quantity, 1);
  const sourceQty = Math.max(0, _safeInteger(fromItem.system?.quantity, 1));
  const transferQty = Math.max(1, Math.min(requested, sourceQty || 1));
  if (sourceQty <= 0) throw new Error('source item quantity is empty');

  await _transferEmbeddedItemToPileActor(fromItem, toActor, transferQty);

  return {
    ok: true,
    transferred: transferQty,
    fromItemUuid: fromItem.uuid,
    toActorUuid: toActor.uuid,
  };
}

async function _transferAllAsGm(payload = {}, { requesterUserId } = {}) {
  const requester = _getRequesterUser(requesterUserId);
  if (!requester) throw new Error('requester user not found');

  const fromActorUuid = _normalizeUuid(payload?.fromActorUuid);
  const toActor = await _resolveActorByUuid(payload?.toActorUuid);
  if (!fromActorUuid || !toActor) throw new Error('invalid transfer-all payload');

  let fromActor = null;
  try {
    fromActor = await fromUuid(fromActorUuid);
  } catch (_) {
    fromActor = null;
  }
  if (!fromActor || fromActor.documentName !== 'Actor') throw new Error('source actor not found');

  if (fromActor?.type === ITEM_PILES_SH.PILE_DEFAULT_ACTOR_TYPE) {
    if (!_canAccessLootActor(requester, fromActor, { write: true })) {
      throw new Error('permission denied: cannot access source pile');
    }
  } else if (!_ensureOwnerPermission(fromActor, requester)) {
    throw new Error('permission denied: source owner required');
  }

  if (toActor?.type === ITEM_PILES_SH.PILE_DEFAULT_ACTOR_TYPE) {
    if (!_canAccessLootActor(requester, toActor, { write: true })) {
      throw new Error('permission denied: cannot access target pile');
    }
  } else if (!_ensureOwnerPermission(toActor, requester)) {
    throw new Error('permission denied: target owner required');
  }

  if (payload?.sourceTokenUuid && payload?.pileTokenUuid) {
    let sourceToken = null;
    let pileToken = null;
    try { sourceToken = await fromUuid(_normalizeUuid(payload.sourceTokenUuid)); } catch (_) { sourceToken = null; }
    try { pileToken = await fromUuid(_normalizeUuid(payload.pileTokenUuid)); } catch (_) { pileToken = null; }
    const maxDist = Math.max(0, _safeNumber(
      fromActor?.type === ITEM_PILES_SH.PILE_DEFAULT_ACTOR_TYPE
        ? fromActor?.system?.interactionDistance
        : toActor?.system?.interactionDistance,
      2
    ));
    if (sourceToken?.documentName === 'Token' && pileToken?.documentName === 'Token' && maxDist > 0) {
      const dist = _euclideanCellsBetween(sourceToken, pileToken);
      if (dist > maxDist) throw new Error('interaction distance exceeded');
    }
  }

  const itemDocs = Array.from(fromActor.items ?? []).filter((it) => {
    if (it?.type !== 'item') return false;
    return !String(it.system?.containerHostId ?? '').trim();
  });
  let moved = 0;
  for (const it of itemDocs) {
    const qty = Math.max(1, _safeInteger(it.system?.quantity, 1));
    await _transferEmbeddedItemToPileActor(it, toActor, qty);
    moved += 1;
  }
  return {
    ok: true,
    movedItems: moved,
    fromActorUuid: fromActor.uuid,
    toActorUuid: toActor.uuid,
  };
}

async function _splitItemAsGm(payload = {}, { requesterUserId } = {}) {
  const requester = _getRequesterUser(requesterUserId);
  if (!requester) throw new Error('requester user not found');

  const fromItem = await _resolveEmbeddedItemByUuid(payload?.fromItemUuid);
  if (!fromItem) throw new Error('source item not found');
  const toActor = await _resolveActorByUuid(payload?.toActorUuid);
  if (!toActor) throw new Error('target actor not found');

  const fromActor = fromItem.parent;
  if (fromActor?.type === ITEM_PILES_SH.PILE_DEFAULT_ACTOR_TYPE) {
    if (!_canAccessLootActor(requester, fromActor, { write: true })) {
      throw new Error('permission denied: cannot access source pile');
    }
  } else if (!_ensureOwnerPermission(fromActor, requester)) {
    throw new Error('permission denied: source owner required');
  }

  if (toActor?.type === ITEM_PILES_SH.PILE_DEFAULT_ACTOR_TYPE) {
    if (!_canAccessLootActor(requester, toActor, { write: true })) {
      throw new Error('permission denied: cannot access target pile');
    }
  } else if (!_ensureOwnerPermission(toActor, requester)) {
    throw new Error('permission denied: target owner required');
  }

  const sourceQty = Math.max(0, _safeInteger(fromItem.system?.quantity, 1));
  if (sourceQty < 2) throw new Error('item cannot be split');
  if (
    fromItem.type === 'item' &&
    fromItem.system?.itemTags?.isContainer &&
    getActorItemIdsInContainer(fromActor, fromItem.id).size > 0
  ) {
    throw new Error('cannot split a non-empty container');
  }
  const splitQty = Math.max(1, Math.min(_safeInteger(payload?.quantity, Math.floor(sourceQty / 2)), sourceQty - 1));
  await _addItemToPileActor(toActor, fromItem.toObject(), splitQty);
  await fromItem.update({ 'system.quantity': sourceQty - splitQty });

  return {
    ok: true,
    split: splitQty,
    remain: sourceQty - splitQty,
    fromItemUuid: fromItem.uuid,
    toActorUuid: toActor.uuid,
  };
}

async function _openPileAsGm(payload = {}, { requesterUserId } = {}) {
  const requester = _getRequesterUser(requesterUserId);
  if (!requester) throw new Error('requester user not found');
  const actor = await _resolveLootActorByUuid(payload?.actorUuid);
  if (!actor) throw new Error('pile actor not found');
  if (!_canAccessLootActor(requester, actor, { write: false })) {
    throw new Error('permission denied: cannot access pile');
  }

  const pileTokenUuid = _normalizeUuid(payload?.pileTokenUuid);
  const sourceTokenUuid = _normalizeUuid(payload?.sourceTokenUuid);
  if (pileTokenUuid && sourceTokenUuid) {
    let sourceToken = null;
    let pileToken = null;
    try { sourceToken = await fromUuid(sourceTokenUuid); } catch (_) { sourceToken = null; }
    try { pileToken = await fromUuid(pileTokenUuid); } catch (_) { pileToken = null; }
    const maxDist = Math.max(0, _safeNumber(actor?.system?.interactionDistance, 2));
    if (sourceToken?.documentName === 'Token' && pileToken?.documentName === 'Token' && maxDist > 0) {
      const dist = _euclideanCellsBetween(sourceToken, pileToken);
      if (dist > maxDist) throw new Error('interaction distance exceeded');
    }
  }

  if (!!actor.system?.isLocked && !_hasLootKey(requester, actor) && !requester.isGM && !_ensureOwnerPermission(actor, requester)) {
    throw new Error('pile is locked and key is missing');
  }
  return {
    ok: true,
    actorUuid: actor.uuid,
    actorId: actor.id,
    locked: !!actor.system?.isLocked,
  };
}

async function _createPileAsGm({ sceneId, x, y, items = [] } = {}) {
  const scene = game.scenes.get(String(sceneId || canvas?.scene?.id || '').trim());
  if (!scene) throw new Error('scene not found');
  const pileTokenDoc = await _createPileTokenAsGm(scene, { x, y, textureSrc: ITEM_PILES_SH.PILE_DEFAULT_TOKEN_TEXTURE });

  const docs = Array.isArray(items) ? items : [];
  for (const raw of docs) {
    await _addItemToPileToken(pileTokenDoc, raw, _safeNumber(raw?.system?.quantity, 1));
  }
  return { tokenId: pileTokenDoc?.id ?? null, actorId: pileTokenDoc?.actor?.id ?? null };
}

async function _onDropCanvasData(_canvas, data) {
  if (!data || data.type !== 'Item') return;
  const sceneId = String(canvas?.scene?.id || '').trim();
  if (!sceneId) return;
  try {
    await executeItemPilesShAsGm(ITEM_PILES_SH.SOCKET_ACTION_DROP_ITEM, {
      dropData: data,
      sceneId,
    });
    return false;
  } catch (error) {
    console.error('SpaceHolder | item-piles-sh failed to process canvas drop', error);
    ui.notifications?.error?.(game.i18n.localize('SPACEHOLDER.ItemPilesSh.DropFailed'));
    return;
  }
}

export const ItemPilesShPrivateApi = {
  initialize() {
    if (_initialized) return;
    _initialized = true;
    _registerItemStackFingerprintHooks();
    Hooks.on('dropCanvasData', _onDropCanvasData);
    if (game.user?.isGM) {
      // Pre-create technical folder + generic pile actor once per world session.
      setTimeout(() => {
        _ensurePileTechFolderAsGm().catch(() => {});
        _ensureGenericPileActorAsGm().catch(() => {});
      }, 0);
    }
  },
  async dropData(payload = {}) {
    return _dropItemAsGm(payload);
  },
  async createPile(payload = {}) {
    return _createPileAsGm(payload);
  },
  async canOpenPile(payload = {}, meta = {}) {
    return _openPileAsGm(payload, meta);
  },
  async transferItem(payload = {}, meta = {}) {
    return _transferItemAsGm(payload, meta);
  },
  async transferAll(payload = {}, meta = {}) {
    return _transferAllAsGm(payload, meta);
  },
  async splitItem(payload = {}, meta = {}) {
    return _splitItemAsGm(payload, meta);
  },
  async openPile(payload = {}, meta = {}) {
    return _openPileAsGm(payload, meta);
  },
  isPileToken(tokenDoc) {
    return _isPileToken(tokenDoc);
  },
  pileFlagPath: getPileFlagPath(),
};

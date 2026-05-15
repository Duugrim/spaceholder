/**
 * Item-as-container: embedded Items on Actor use `containerHostId` + ordered
 * `system.container.contents` entries (`actorItem`). World/sidebar containers
 * store `worldUuid` links only; recursive move clones to Actor and deletes world docs.
 */

/** @typedef {{ kind: typeof ENTRY_ACTOR_ITEM, itemId: string }} ActorItemEntry */
/** @typedef {{ kind: typeof ENTRY_WORLD_UUID, uuid: string }} WorldUuidEntry */
/** @typedef {ActorItemEntry|WorldUuidEntry} ContainerContentEntry */

export const ENTRY_ACTOR_ITEM = 'actorItem';
export const ENTRY_WORLD_UUID = 'worldUuid';

/**
 * @param {unknown} el
 * @returns {ContainerContentEntry|null}
 */
export function parseContainerContentEntry(el) {
  if (el == null) return null;
  if (typeof el === 'string') {
    const id = String(el).trim();
    return id ? { kind: ENTRY_ACTOR_ITEM, itemId: id } : null;
  }
  if (typeof el !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (el);
  const k = String(o.kind ?? '').trim();
  if (k === ENTRY_WORLD_UUID || (!k && o.uuid && !o.itemId)) {
    const u = String(o.uuid ?? '').trim();
    return u ? { kind: ENTRY_WORLD_UUID, uuid: u } : null;
  }
  if (k === ENTRY_ACTOR_ITEM || o.itemId) {
    const id = String(o.itemId ?? '').trim();
    return id ? { kind: ENTRY_ACTOR_ITEM, itemId: id } : null;
  }
  return null;
}

/**
 * @param {unknown} rawContents
 * @returns {ContainerContentEntry[]}
 */
export function normalizeContainerContentsArray(rawContents) {
  if (!Array.isArray(rawContents)) return [];
  const out = [];
  for (const el of rawContents) {
    const p = parseContainerContentEntry(el);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Persisted row shape for Foundry `system.container.contents` (migrateData / DB).
 * @param {unknown} rawContents
 * @returns {ContainerContentEntry[]}
 */
export function migratePersistedContainerContents(rawContents) {
  return normalizeContainerContentsArray(rawContents);
}

/**
 * @param {ContainerContentEntry[]} entries
 * @returns {string[]}
 */
export function actorItemIdsFromEntries(entries) {
  const out = [];
  for (const e of entries) {
    if (e.kind === ENTRY_ACTOR_ITEM) out.push(e.itemId);
  }
  return out;
}

/**
 * @param {ContainerContentEntry[]} entries
 * @param {string} itemId
 * @returns {boolean}
 */
export function entriesContainActorItem(entries, itemId) {
  const id = String(itemId ?? '').trim();
  if (!id) return false;
  return entries.some((e) => e.kind === ENTRY_ACTOR_ITEM && e.itemId === id);
}

/**
 * @param {ContainerContentEntry[]} a
 * @param {ContainerContentEntry[]} b
 * @returns {boolean}
 */
export function containerContentsEqual(a, b) {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    const x = aa[i];
    const y = bb[i];
    if (x.kind !== y.kind) return false;
    if (x.kind === ENTRY_ACTOR_ITEM && y.kind === ENTRY_ACTOR_ITEM) {
      if (x.itemId !== y.itemId) return false;
    } else if (x.kind === ENTRY_WORLD_UUID && y.kind === ENTRY_WORLD_UUID) {
      if (x.uuid !== y.uuid) return false;
    } else return false;
  }
  return true;
}

/**
 * @param {object|null|undefined} system
 * @returns {{ containerHostId: string, container: { contents: ContainerContentEntry[] } }}
 */
export function normalizeItemContainerFields(system) {
  const hostId = String(system?.containerHostId ?? '').trim();
  const raw = system?.container && typeof system.container === 'object' ? system.container : {};
  const contents = normalizeContainerContentsArray(raw.contents);
  return {
    containerHostId: hostId,
    container: { contents },
  };
}

/**
 * @param {Actor|null|undefined} actor
 * @param {string} itemIdMoving - _id of item being placed into a container
 * @param {string} targetContainerId - _id of container item
 * @returns {boolean} true if placement would create a cycle or self-parent
 */
export function wouldCreateItemContainerCycle(actor, itemIdMoving, targetContainerId) {
  const move = String(itemIdMoving ?? '').trim();
  const target = String(targetContainerId ?? '').trim();
  if (!move || !target) return false;
  if (move === target) return true;
  let cur = target;
  const seen = new Set();
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    if (cur === move) return true;
    const doc = actor?.items?.get?.(cur);
    const pid = String(doc?.system?.containerHostId ?? '').trim();
    if (!pid) break;
    cur = pid;
  }
  return false;
}

/**
 * Ids of items on actor that declare this container as host.
 * @param {Actor|null|undefined} actor
 * @param {string} containerItemId
 * @returns {Set<string>}
 */
export function getActorItemIdsInContainer(actor, containerItemId) {
  const id = String(containerItemId ?? '').trim();
  const out = new Set();
  if (!actor?.items || !id) return out;
  for (const it of actor.items) {
    if (it.type !== 'item') continue;
    const hid = String(it.system?.containerHostId ?? '').trim();
    if (hid === id) out.add(it.id);
  }
  return out;
}

/**
 * Direct child item ids for a container host: `system.container.contents` order, then any
 * remaining children on the actor (same rules as the item-container tab).
 *
 * @param {Actor|null|undefined} actor
 * @param {string} hostId
 * @returns {string[]}
 */
export function getOrderedDirectChildItemIds(actor, hostId) {
  const hid = String(hostId ?? '').trim();
  if (!actor?.items || !hid) return [];
  const host = actor.items.get(hid);
  const norm = host ? normalizeItemContainerFields(host.system) : { container: { contents: [] } };
  const actual = getActorItemIdsInContainer(actor, hid);

  const orderedIds = [];
  for (const entry of norm.container.contents) {
    if (entry.kind !== ENTRY_ACTOR_ITEM) continue;
    const id = String(entry.itemId ?? '').trim();
    if (actual.has(id)) orderedIds.push(id);
  }
  for (const id of actual) {
    if (!orderedIds.includes(id)) orderedIds.push(id);
  }
  return orderedIds;
}

/**
 * Depth-first: each direct child in `contents` order, then unlisted children, then nested
 * containers recursively. Excludes the root host item itself.
 * @param {Actor|null|undefined} actor
 * @param {string} rootHostId
 * @returns {Item[]}
 */
export function orderedContainerDescendants(actor, rootHostId) {
  const root = String(rootHostId ?? '').trim();
  const out = [];
  if (!actor?.items || !root) return out;

  /**
   * @param {string} hostId
   */
  function walk(hostId) {
    for (const id of getOrderedDirectChildItemIds(actor, hostId)) {
      const child = actor.items.get(id);
      if (!child || child.type !== 'item') continue;
      out.push(child);
      if (child.system?.itemTags?.isContainer) walk(child.id);
    }
  }

  walk(root);
  return out;
}

/**
 * Clear `containerHostId` for direct children of a host (e.g. before the host Item is deleted).
 * Nested containers keep their own subtree intact.
 * @param {Actor|null|undefined} actor
 * @param {string} hostItemId
 * @returns {Promise<boolean>} true if any update was applied
 */
export async function releaseDirectContainerChildrenToRoot(actor, hostItemId) {
  const hid = String(hostItemId ?? '').trim();
  if (!actor?.items || !hid) return false;
  const children = [];
  for (const it of actor.items) {
    if (it.type !== 'item') continue;
    if (String(it.system?.containerHostId ?? '').trim() !== hid) continue;
    children.push(it);
  }
  if (!children.length) return false;
  const updates = children.map((it) => ({ _id: it.id, 'system.containerHostId': '' }));
  await actor.updateEmbeddedDocuments('Item', updates, { render: false });
  rerenderOpenContainerRelatedSheets(actor, children);
  return true;
}

/**
 * After `updateEmbeddedDocuments(..., { render: false })` / item.update({ render: false }),
 * Foundry does not refresh open sheets. Re-run render for the owning actor sheet and any
 * open item sheets involved (container host, moved child, previous host).
 *
 * @param {Actor|null|undefined} actor
 * @param {Array<Item|undefined|null>} [relatedItems]
 */
export function rerenderOpenContainerRelatedSheets(actor, relatedItems = []) {
  if (actor) {
    try {
      actor.sheet?.render?.(false);
    } catch (_) {
      /* ignore */
    }
  }
  const seen = new Set();
  for (const it of relatedItems) {
    if (!it?.id || seen.has(it.id)) continue;
    seen.add(it.id);
    try {
      it.sheet?.render?.(false);
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * Reconcile `system.container.contents` with live children; fix orphans.
 * @param {Actor} actor
 * @param {Item} containerItem
 * @returns {{ contents: ContainerContentEntry[], updates: object[] }} updates for embedded documents
 */
export function reconcileContainerContents(actor, containerItem) {
  const cid = String(containerItem?.id ?? '').trim();
  if (!cid || !actor?.items) return { contents: [], updates: [] };

  const { container } = normalizeItemContainerFields(containerItem.system);
  const actual = getActorItemIdsInContainer(actor, cid);

  const ordered = [];
  const used = new Set();
  for (const entry of container.contents) {
    if (entry.kind !== ENTRY_ACTOR_ITEM) continue;
    const id = String(entry.itemId ?? '').trim();
    if (!id || !actual.has(id) || used.has(id)) continue;
    ordered.push({ kind: ENTRY_ACTOR_ITEM, itemId: id });
    used.add(id);
  }
  for (const id of actual) {
    if (!used.has(id)) ordered.push({ kind: ENTRY_ACTOR_ITEM, itemId: id });
  }

  const updates = [];
  for (const id of actual) {
    const child = actor.items.get(id);
    if (!child) continue;
    const cur = String(child.system?.containerHostId ?? '').trim();
    if (cur !== cid) {
      updates.push({ _id: id, 'system.containerHostId': cid });
    }
  }

  return { contents: ordered, updates };
}

/**
 * Persist reconciled contents + fix child `containerHostId` if drifted.
 * @param {Actor} actor
 * @param {Item} containerItem
 * @returns {Promise<boolean>} true if any DB write occurred
 */
export async function refreshContainerState(actor, containerItem) {
  const { contents, updates } = reconcileContainerContents(actor, containerItem);
  const cur = normalizeItemContainerFields(containerItem.system);
  const sameOrder = containerContentsEqual(cur.container.contents, contents);
  const docs = [];
  if (!sameOrder) {
    docs.push({ _id: containerItem.id, 'system.container': { contents } });
  }
  docs.push(...updates);
  if (!docs.length) return false;
  await actor.updateEmbeddedDocuments('Item', docs, { render: false });
  rerenderOpenContainerRelatedSheets(actor, [containerItem]);
  return true;
}

/**
 * @param {Actor} actor
 * @param {Item} containerItem
 * @param {string} childItemId
 * @returns {Promise<boolean>}
 */
export async function moveActorItemIntoContainer(actor, containerItem, childItemId) {
  const hostId = String(containerItem?.id ?? '').trim();
  const childId = String(childItemId ?? '').trim();
  if (!actor || !hostId || !childId) return false;
  if (childId === hostId) return false;

  const child = actor.items.get(childId);
  const host = actor.items.get(hostId);
  if (!child || !host || child.type !== 'item' || host.type !== 'item') return false;
  if (!host.system?.itemTags?.isContainer) return false;
  if (wouldCreateItemContainerCycle(actor, childId, hostId)) return false;

  const prevHostId = String(child.system?.containerHostId ?? '').trim();
  const updates = [];

  if (prevHostId && prevHostId !== hostId) {
    const prevHost = actor.items.get(prevHostId);
    if (prevHost?.type === 'item') {
      const prevNorm = normalizeItemContainerFields(prevHost.system);
      prevNorm.container.contents = prevNorm.container.contents.filter(
        (e) => !(e.kind === ENTRY_ACTOR_ITEM && e.itemId === childId),
      );
      updates.push({ _id: prevHostId, 'system.container': prevNorm.container });
    }
  }

  const nextHost = normalizeItemContainerFields(host.system);
  if (!entriesContainActorItem(nextHost.container.contents, childId)) {
    nextHost.container.contents.push({ kind: ENTRY_ACTOR_ITEM, itemId: childId });
  }
  updates.push({ _id: childId, 'system.containerHostId': hostId });
  updates.push({ _id: hostId, 'system.container': nextHost.container });

  await actor.updateEmbeddedDocuments('Item', updates, { render: false });
  const prevHostDoc = prevHostId && prevHostId !== hostId ? actor.items.get(prevHostId) : null;
  rerenderOpenContainerRelatedSheets(actor, [host, child, prevHostDoc].filter(Boolean));
  return true;
}

/**
 * Remove child from container (root inventory).
 * @param {Actor} actor
 * @param {Item} containerItem
 * @param {string} childItemId
 * @returns {Promise<boolean>}
 */
export async function removeActorItemFromContainer(actor, containerItem, childItemId) {
  const hostId = String(containerItem?.id ?? '').trim();
  const childId = String(childItemId ?? '').trim();
  if (!actor || !hostId || !childId) return false;

  const host = actor.items.get(hostId);
  const child = actor.items.get(childId);
  if (!host || !child) return false;

  const nextHost = normalizeItemContainerFields(host.system);
  nextHost.container.contents = nextHost.container.contents.filter(
    (e) => !(e.kind === ENTRY_ACTOR_ITEM && e.itemId === childId),
  );

  const patchChild =
    String(child.system?.containerHostId ?? '').trim() === hostId
      ? { _id: childId, 'system.containerHostId': '' }
      : null;

  const docs = [{ _id: hostId, 'system.container': nextHost.container }];
  if (patchChild) docs.push(patchChild);

  await actor.updateEmbeddedDocuments('Item', docs, { render: false });
  rerenderOpenContainerRelatedSheets(actor, [host, child]);
  return true;
}

/**
 * Reorder `contents` only (children already in container).
 * @param {Actor} actor
 * @param {Item} containerItem
 * @param {string[]} orderedChildIds
 * @returns {Promise<void>}
 */
export async function setContainerContentsOrder(actor, containerItem, orderedChildIds) {
  const hostId = String(containerItem?.id ?? '').trim();
  if (!actor || !hostId) return;
  const actual = getActorItemIdsInContainer(actor, hostId);
  const nextIds = Array.isArray(orderedChildIds)
    ? orderedChildIds.map((id) => String(id ?? '').trim()).filter((id) => actual.has(id))
    : [];
  for (const id of actual) {
    if (!nextIds.includes(id)) nextIds.push(id);
  }
  const contents = nextIds.map((itemId) => ({ kind: ENTRY_ACTOR_ITEM, itemId }));
  await containerItem.update({ 'system.container': { contents } }, { render: false });
  const owner = containerItem.actor ?? null;
  if (owner?.documentName === 'Actor') {
    rerenderOpenContainerRelatedSheets(owner, [containerItem]);
  } else {
    try {
      containerItem.sheet?.render?.(false);
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * @param {Item} hostItem
 * @param {string} itemUuid
 * @returns {Promise<boolean>}
 */
export async function addWorldUuidToContainer(hostItem, itemUuid) {
  const u = String(itemUuid ?? '').trim();
  if (!hostItem || !u) return false;
  const norm = normalizeItemContainerFields(hostItem.system);
  if (norm.container.contents.some((e) => e.kind === ENTRY_WORLD_UUID && e.uuid === u)) return true;
  norm.container.contents.push({ kind: ENTRY_WORLD_UUID, uuid: u });
  await hostItem.update({ 'system.container': norm.container }, { render: false });
  rerenderOpenContainerRelatedSheets(null, [hostItem]);
  return true;
}

/**
 * @param {Item} hostItem
 * @param {string} itemUuid
 * @returns {Promise<boolean>} true if removed
 */
export async function removeWorldUuidFromContainer(hostItem, itemUuid) {
  const u = String(itemUuid ?? '').trim();
  if (!hostItem || !u) return false;
  const norm = normalizeItemContainerFields(hostItem.system);
  const next = norm.container.contents.filter((e) => !(e.kind === ENTRY_WORLD_UUID && e.uuid === u));
  if (next.length === norm.container.contents.length) return false;
  await hostItem.update({ 'system.container': { contents: next } }, { render: false });
  rerenderOpenContainerRelatedSheets(null, [hostItem]);
  return true;
}

/**
 * Remove first matching world UUID entry (move semantics).
 * @param {Item} hostItem
 * @param {string} itemUuid
 * @returns {Promise<boolean>}
 */
export async function removeFirstWorldUuidEntry(hostItem, itemUuid) {
  const u = String(itemUuid ?? '').trim();
  if (!hostItem || !u) return false;
  const norm = normalizeItemContainerFields(hostItem.system);
  const idx = norm.container.contents.findIndex((e) => e.kind === ENTRY_WORLD_UUID && e.uuid === u);
  if (idx < 0) return false;
  norm.container.contents.splice(idx, 1);
  await hostItem.update({ 'system.container': norm.container }, { render: false });
  return true;
}

/**
 * @param {Item} hostItem
 * @returns {Promise<number>} count removed
 */
export async function pruneBrokenWorldUuidLinks(hostItem) {
  const norm = normalizeItemContainerFields(hostItem.system);
  const kept = [];
  let removed = 0;
  for (const e of norm.container.contents) {
    if (e.kind !== ENTRY_WORLD_UUID) {
      kept.push(e);
      continue;
    }
    let doc = null;
    try {
      doc = await fromUuid(e.uuid);
    } catch (_) {
      doc = null;
    }
    if (doc && doc.documentName === 'Item') kept.push(e);
    else removed++;
  }
  if (!removed) return 0;
  await hostItem.update({ 'system.container': { contents: kept } }, { render: false });
  rerenderOpenContainerRelatedSheets(null, [hostItem]);
  return removed;
}

/**
 * @param {Item} hostItem
 * @param {string[]} orderedUuids
 * @returns {Promise<void>}
 */
export async function setWorldContainerContentsOrder(hostItem, orderedUuids) {
  const norm = normalizeItemContainerFields(hostItem.system);
  const actual = new Set(
    norm.container.contents.filter((e) => e.kind === ENTRY_WORLD_UUID).map((e) => e.uuid),
  );
  const next = [];
  for (const raw of orderedUuids || []) {
    const u = String(raw ?? '').trim();
    if (u && actual.has(u)) next.push({ kind: ENTRY_WORLD_UUID, uuid: u });
  }
  for (const u of actual) {
    if (!next.some((e) => e.uuid === u)) next.push({ kind: ENTRY_WORLD_UUID, uuid: u });
  }
  await hostItem.update({ 'system.container': { contents: next } }, { render: false });
  rerenderOpenContainerRelatedSheets(null, [hostItem]);
}

/**
 * Remap container.contents entries when cloning embedded container subtree (actor → actor).
 * @param {ContainerContentEntry[]} contents
 * @param {Map<string, string>} idMap old embedded id → new id
 * @returns {ContainerContentEntry[]}
 */
export function remapActorContainerContentsEntries(contents, idMap) {
  const out = [];
  for (const e of contents || []) {
    if (e.kind === ENTRY_WORLD_UUID) {
      out.push({ kind: ENTRY_WORLD_UUID, uuid: e.uuid });
      continue;
    }
    if (e.kind === ENTRY_ACTOR_ITEM) {
      const nid = idMap.get(String(e.itemId ?? '').trim());
      if (nid) out.push({ kind: ENTRY_ACTOR_ITEM, itemId: nid });
    }
  }
  return out;
}

/**
 * World/sidebar Items (not embedded on an actor) may list children as `worldUuid` rows or as
 * legacy `actorItem` rows (plain strings migrated to `{ kind, itemId }` where itemId is the
 * directory Item id). Resolve to a document for recursive clone/delete.
 * @param {ContainerContentEntry} e
 * @returns {Promise<Item|null>}
 */
async function resolveWorldSideContainerChildItem(e) {
  if (!e) return null;
  if (e.kind === ENTRY_WORLD_UUID) {
    const u = String(e.uuid ?? '').trim();
    if (!u) return null;
    try {
      const doc = await fromUuid(u);
      return doc?.documentName === 'Item' ? doc : null;
    } catch (_) {
      return null;
    }
  }
  if (e.kind !== ENTRY_ACTOR_ITEM) return null;
  const raw = String(e.itemId ?? '').trim();
  if (!raw) return null;
  if (typeof game !== 'undefined' && game.items?.get) {
    const hit = game.items.get(raw);
    if (hit?.documentName === 'Item') {
      if (hit.isEmbedded || hit.parent?.documentName === 'Actor') return null;
      return hit;
    }
  }
  try {
    const doc = await fromUuid(raw);
    if (doc?.documentName === 'Item' && !doc.isEmbedded && doc.parent?.documentName !== 'Actor') {
      return doc;
    }
  } catch (_) {
    /* ignore */
  }
  if (!raw.includes('.')) {
    try {
      const doc = await fromUuid(`Item.${raw}`);
      if (doc?.documentName === 'Item' && !doc.isEmbedded && doc.parent?.documentName !== 'Actor') {
        return doc;
      }
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

/**
 * @param {Item} it
 * @returns {boolean}
 */
function isWorldDirectoryOrPackItemForMove(it) {
  if (!it || it.documentName !== 'Item') return false;
  if (it.isEmbedded) return false;
  if (it.parent?.documentName === 'Actor') return false;
  return true;
}

/**
 * Clone a world/compendium Item subtree onto an actor (embedded). Reuses world-link resolution.
 * @param {Actor} actor
 * @param {Item} worldItem
 * @param {string} parentActorContainerId
 * @param {Set<string>} visited world item uuids (cycle guard)
 * @returns {Promise<string>} new embedded item id
 */
async function cloneWorldContainerSubtreeOntoActor(actor, worldItem, parentActorContainerId, visited) {
  const uq = String(worldItem.uuid ?? '').trim();
  if (!uq || visited.has(uq)) throw new Error('SpaceHolder | container clone cycle');
  visited.add(uq);

  const obj = worldItem.toObject(false);
  delete obj._id;
  obj.system = obj.system ?? {};
  obj.system.containerHostId = parentActorContainerId ? String(parentActorContainerId).trim() : '';
  const isContainer = !!obj.system?.itemTags?.isContainer;
  if (isContainer) {
    obj.system.container = { contents: [] };
  }

  const [created] = await actor.createEmbeddedDocuments('Item', [obj]);
  const newId = created?.id;
  if (!newId) throw new Error('SpaceHolder | container clone create failed');

  if (isContainer) {
    const wNorm = normalizeItemContainerFields(worldItem.system);
    const childEntries = [];
    for (const e of wNorm.container.contents) {
      const child = await resolveWorldSideContainerChildItem(e);
      if (!child || !isWorldDirectoryOrPackItemForMove(child)) continue;
      const cid = await cloneWorldContainerSubtreeOntoActor(actor, child, newId, visited);
      childEntries.push({ kind: ENTRY_ACTOR_ITEM, itemId: cid });
    }
    if (childEntries.length) {
      await created.update({ 'system.container': { contents: childEntries } }, { render: false });
    }
  }
  return newId;
}

/**
 * Actor sheet drop: clone a world/compendium container (with linked contents) onto the actor.
 * Does not delete or unlink world documents.
 * @param {Actor} actor
 * @param {Item} worldRootItem
 * @returns {Promise<Item|null>}
 */
export async function importWorldContainerTreeToActor(actor, worldRootItem) {
  if (!actor?.isOwner || !worldRootItem || worldRootItem.documentName !== 'Item') return null;
  if (worldRootItem.type !== 'item' || !worldRootItem.system?.itemTags?.isContainer) return null;
  if (worldRootItem.isEmbedded || worldRootItem.parent?.documentName === 'Actor') return null;
  const norm = normalizeItemContainerFields(worldRootItem.system);
  if (!norm.container.contents.length) return null;
  const visited = new Set();
  try {
    const id = await cloneWorldContainerSubtreeOntoActor(actor, worldRootItem, '', visited);
    const doc = actor.items.get(id);
    rerenderOpenContainerRelatedSheets(actor, [doc].filter(Boolean));
    return doc ?? null;
  } catch (e) {
    console.error('SpaceHolder | importWorldContainerTreeToActor failed', e);
    return null;
  }
}

/**
 * @param {Item} hostItem
 * @param {Item} rootItem
 * @param {string} entryUuid drag/entry uuid string (may match rootItem.uuid)
 * @returns {Promise<boolean>}
 */
async function removeFirstHostEntryForMovedRoot(hostItem, rootItem, entryUuid) {
  const rid = String(rootItem?.id ?? '').trim();
  const ru = String(rootItem?.uuid ?? '').trim();
  const eu = String(entryUuid ?? '').trim();
  if (!hostItem || !rid) return false;
  const norm = normalizeItemContainerFields(hostItem.system);
  const idx = norm.container.contents.findIndex((e) => {
    if (e.kind === ENTRY_WORLD_UUID) {
      const u = String(e.uuid ?? '').trim();
      return u && (u === eu || u === ru);
    }
    if (e.kind === ENTRY_ACTOR_ITEM) return e.itemId === rid;
    return false;
  });
  if (idx < 0) return false;
  norm.container.contents.splice(idx, 1);
  await hostItem.update({ 'system.container': norm.container }, { render: false });
  return true;
}

/**
 * Recursive move: world container link → actor inventory; clones subtree; deletes world Items.
 * @param {Actor} actor
 * @param {Item} worldHostItem container Item (world / non-embedded)
 * @param {string} entryUuid uuid of root Item to move
 * @returns {Promise<boolean>}
 */
export async function moveWorldContainerEntryToActor(actor, worldHostItem, entryUuid) {
  const rootUuid = String(entryUuid ?? '').trim();
  if (!actor?.isOwner || !worldHostItem || !rootUuid) return false;

  let rootDoc = null;
  try {
    rootDoc = await fromUuid(rootUuid);
  } catch (_) {
    rootDoc = null;
  }
  if (!rootDoc || rootDoc.documentName !== 'Item') return false;

  const hostNorm = normalizeItemContainerFields(worldHostItem.system);
  const ru = String(rootDoc.uuid ?? '').trim();
  const linked = hostNorm.container.contents.some((e) => {
    if (e.kind === ENTRY_WORLD_UUID) {
      const u = String(e.uuid ?? '').trim();
      return u && (u === rootUuid || u === ru);
    }
    if (e.kind === ENTRY_ACTOR_ITEM) return e.itemId === rootDoc.id;
    return false;
  });
  if (!linked) return false;

  const visited = new Set();

  try {
    await cloneWorldContainerSubtreeOntoActor(actor, rootDoc, '', visited);
  } catch (e) {
    console.error('SpaceHolder | moveWorldContainerEntryToActor clone failed', e);
    return false;
  }

  const okUnlink = await removeFirstHostEntryForMovedRoot(worldHostItem, rootDoc, rootUuid);
  if (!okUnlink) {
    // best-effort: subtree already on actor; avoid orphan world docs — still try delete root subtree
  }

  /** @param {Item} wi */
  async function deleteWorldDeep(wi) {
    const wn = normalizeItemContainerFields(wi.system);
    for (const e of wn.container.contents) {
      const ch = await resolveWorldSideContainerChildItem(e);
      if (ch && isWorldDirectoryOrPackItemForMove(ch)) await deleteWorldDeep(ch);
    }
    try {
      await wi.delete();
    } catch (_) {
      /* ignore */
    }
  }

  await deleteWorldDeep(rootDoc);

  rerenderOpenContainerRelatedSheets(actor, [worldHostItem]);
  return true;
}

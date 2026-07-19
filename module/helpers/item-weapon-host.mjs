/**
 * Parent Actor Items under a weapon without requiring `itemTags.isContainer`.
 * Children use `system.containerHostId = weapon.id`; FIFO order lives in
 * ammo-block `runtime.contentItemIds` / `attachedItemId` / `chamberItemId`.
 */

import {
  ENTRY_ACTOR_ITEM,
  getActorItemIdsInContainer,
  normalizeItemContainerFields,
  wouldCreateItemContainerCycle,
  rerenderOpenContainerRelatedSheets,
  moveActorItemIntoContainer,
  removeActorItemFromContainer,
} from './item-container.mjs';

/**
 * @param {Actor|null|undefined} actor
 * @param {Item|null|undefined} hostItem
 * @param {string} childItemId
 * @param {{ held?: boolean, equipped?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function parentActorItemToWeaponHost(actor, hostItem, childItemId, opts = {}) {
  const hostId = String(hostItem?.id ?? '').trim();
  const childId = String(childItemId ?? '').trim();
  if (!actor || !hostId || !childId || childId === hostId) return false;

  const child = actor.items.get(childId);
  const host = actor.items.get(hostId);
  if (!child || !host || child.type !== 'item' || host.type !== 'item') return false;
  if (wouldCreateItemContainerCycle(actor, childId, hostId)) return false;

  const prevHostId = String(child.system?.containerHostId ?? '').trim();
  const updates = [];

  if (prevHostId && prevHostId !== hostId) {
    const prevHost = actor.items.get(prevHostId);
    if (prevHost?.type === 'item' && prevHost.system?.itemTags?.isContainer) {
      const prevNorm = normalizeItemContainerFields(prevHost.system);
      prevNorm.container.contents = prevNorm.container.contents.filter(
        (e) => !(e.kind === ENTRY_ACTOR_ITEM && e.itemId === childId),
      );
      updates.push({ _id: prevHostId, 'system.container': prevNorm.container });
    }
  }

  const childPatch = {
    _id: childId,
    'system.containerHostId': hostId,
    'system.held': opts.held === true,
    'system.equipped': opts.equipped === true,
  };
  updates.push(childPatch);

  // If the weapon itself is marked as a container, keep contents list in sync.
  if (host.system?.itemTags?.isContainer) {
    const nextHost = normalizeItemContainerFields(host.system);
    if (!nextHost.container.contents.some((e) => e.kind === ENTRY_ACTOR_ITEM && e.itemId === childId)) {
      nextHost.container.contents.push({ kind: ENTRY_ACTOR_ITEM, itemId: childId });
    }
    updates.push({ _id: hostId, 'system.container': nextHost.container });
  }

  await actor.updateEmbeddedDocuments('Item', updates, { render: false });
  const prevHostDoc = prevHostId && prevHostId !== hostId ? actor.items.get(prevHostId) : null;
  rerenderOpenContainerRelatedSheets(actor, [host, child, prevHostDoc].filter(Boolean));
  return true;
}

/**
 * Clear weapon/container host and return item to actor root inventory.
 * @param {Actor|null|undefined} actor
 * @param {string} childItemId
 * @param {{ held?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function unparentActorItemFromHost(actor, childItemId, opts = {}) {
  const childId = String(childItemId ?? '').trim();
  if (!actor || !childId) return false;
  const child = actor.items.get(childId);
  if (!child) return false;

  const hostId = String(child.system?.containerHostId ?? '').trim();
  if (hostId) {
    const host = actor.items.get(hostId);
    if (host?.system?.itemTags?.isContainer) {
      await removeActorItemFromContainer(actor, host, childId);
    }
  }

  await child.update({
    'system.containerHostId': '',
    'system.held': opts.held !== false,
    'system.equipped': false,
  }, { render: false });
  rerenderOpenContainerRelatedSheets(actor, [child, hostId ? actor.items.get(hostId) : null].filter(Boolean));
  return true;
}

/**
 * Move (or split) `qty` from a source stack into a magazine container (live children).
 * @param {Actor} actor
 * @param {Item} magazineItem
 * @param {Item} sourceItem
 * @param {number} qty
 * @returns {Promise<{ok: boolean, moved: number, item?: Item, reason?: string}>}
 */
export async function moveQtyIntoMagazineContainer(actor, magazineItem, sourceItem, qty) {
  if (!actor || !magazineItem || !sourceItem) return { ok: false, moved: 0, reason: 'missing' };
  if (!magazineItem.system?.itemTags?.isContainer) {
    return { ok: false, moved: 0, reason: 'notContainer' };
  }
  const want = Math.max(0, Math.floor(Number(qty) || 0));
  const have = Math.max(0, Math.floor(Number(sourceItem.system?.quantity) || 0));
  const take = Math.min(want, have);
  if (take <= 0) return { ok: false, moved: 0, reason: 'empty' };

  let movedItem = sourceItem;
  if (have > take) {
    const data = sourceItem.toObject();
    delete data._id;
    data.system = data.system ?? {};
    data.system.quantity = take;
    data.system.held = false;
    data.system.equipped = false;
    data.system.containerHostId = '';
    await sourceItem.update({ 'system.quantity': have - take }, { render: false });
    const created = await actor.createEmbeddedDocuments('Item', [data], { render: false });
    movedItem = created?.[0];
    if (!movedItem) return { ok: false, moved: 0, reason: 'createFailed' };
  }

  const ok = await moveActorItemIntoContainer(actor, magazineItem, movedItem.id);
  if (!ok) return { ok: false, moved: 0, reason: 'capacity' };
  return { ok: true, moved: take, item: movedItem };
}

/**
 * Move (or split) `qty` under a weapon host and return the hosted Item.
 * @param {Actor} actor
 * @param {Item} weaponItem
 * @param {Item} sourceItem
 * @param {number} qty
 * @returns {Promise<{ok: boolean, moved: number, item?: Item, reason?: string}>}
 */
export async function moveQtyOntoWeaponHost(actor, weaponItem, sourceItem, qty) {
  if (!actor || !weaponItem || !sourceItem) return { ok: false, moved: 0, reason: 'missing' };
  const want = Math.max(0, Math.floor(Number(qty) || 0));
  const have = Math.max(0, Math.floor(Number(sourceItem.system?.quantity) || 0));
  const take = Math.min(want, have);
  if (take <= 0) return { ok: false, moved: 0, reason: 'empty' };

  let movedItem = sourceItem;
  if (have > take) {
    const data = sourceItem.toObject();
    delete data._id;
    data.system = data.system ?? {};
    data.system.quantity = take;
    data.system.held = false;
    data.system.equipped = false;
    data.system.containerHostId = '';
    await sourceItem.update({ 'system.quantity': have - take }, { render: false });
    const created = await actor.createEmbeddedDocuments('Item', [data], { render: false });
    movedItem = created?.[0];
    if (!movedItem) return { ok: false, moved: 0, reason: 'createFailed' };
  }

  const ok = await parentActorItemToWeaponHost(actor, weaponItem, movedItem.id, { held: false });
  if (!ok) return { ok: false, moved: 0, reason: 'hostFailed' };
  return { ok: true, moved: take, item: actor.items.get(movedItem.id) ?? movedItem };
}

/**
 * Take one unit from a live stack under a host (split if qty>1). Leaves remainder.
 * @param {Actor} actor
 * @param {Item} stackItem
 * @param {Item} newHostItem host for the taken unit (weapon or mag)
 * @returns {Promise<Item|null>}
 */
export async function takeOneUnitToHost(actor, stackItem, newHostItem) {
  if (!actor || !stackItem || !newHostItem) return null;
  const have = Math.max(0, Math.floor(Number(stackItem.system?.quantity) || 0));
  if (have <= 0) return null;

  if (have === 1) {
    if (String(stackItem.system?.containerHostId ?? '') !== String(newHostItem.id)) {
      const hostIsContainer = !!newHostItem.system?.itemTags?.isContainer;
      if (hostIsContainer) await moveActorItemIntoContainer(actor, newHostItem, stackItem.id);
      else await parentActorItemToWeaponHost(actor, newHostItem, stackItem.id, { held: false });
    }
    return actor.items.get(stackItem.id) ?? stackItem;
  }

  const data = stackItem.toObject();
  delete data._id;
  data.system = data.system ?? {};
  data.system.quantity = 1;
  data.system.held = false;
  data.system.equipped = false;
  data.system.containerHostId = '';
  await stackItem.update({ 'system.quantity': have - 1 }, { render: false });
  const created = await actor.createEmbeddedDocuments('Item', [data], { render: false });
  const unit = created?.[0];
  if (!unit) return null;
  const hostIsContainer = !!newHostItem.system?.itemTags?.isContainer;
  if (hostIsContainer) await moveActorItemIntoContainer(actor, newHostItem, unit.id);
  else await parentActorItemToWeaponHost(actor, newHostItem, unit.id, { held: false });
  return actor.items.get(unit.id) ?? unit;
}

/**
 * Item ids parented to host (by containerHostId).
 * @param {Actor|null|undefined} actor
 * @param {string} hostItemId
 * @returns {string[]}
 */
export function listHostedItemIds(actor, hostItemId) {
  return Array.from(getActorItemIdsInContainer(actor, hostItemId));
}

/**
 * Release all items parented to a weapon (e.g. before weapon delete).
 * @param {Actor} actor
 * @param {string} weaponItemId
 * @returns {Promise<void>}
 */
export async function releaseWeaponHostedChildrenToRoot(actor, weaponItemId) {
  const ids = listHostedItemIds(actor, weaponItemId);
  for (const id of ids) {
    await unparentActorItemFromHost(actor, id, { held: true });
  }
}

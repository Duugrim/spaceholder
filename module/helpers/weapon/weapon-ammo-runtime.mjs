/**
 * Weapon v3 ammo runtime — live Actor Items per ammo block.
 *
 * Each ammo block owns runtime ids inside
 * `weapon.lines[i].ammoBlocks[j].runtime`:
 *   - charge, chamberCharge          (INTERNAL_CHARGE)
 *   - attachedItemId                 (EXTERNAL_MAGAZINE live mag Item id)
 *   - chamberItemId                  (live chamber Item id)
 *   - contentItemIds[]               (FIFO live Item ids on the weapon host)
 *   - legacy magazine / chamberItem / contents snapshots (migrated lazily)
 *
 * Magazines use `itemTags.isContainer` + `system.container.contents`.
 * Rounds / batteries under a weapon use `containerHostId = weapon.id`
 * (see item-weapon-host.mjs); FIFO order is tracked in contentItemIds /
 * chamberItemId / attachedItemId.
 */

import {
  AMMO_BLOCK_TYPES,
  AMMO_SEARCH_MODES,
  normalizeWeaponV3,
  normalizeAmmoConfig,
  activeDamageEntries,
  compatMatches,
  getWeaponLine,
  resolveBlockCapacity,
} from './weapon-model.mjs';
import {
  applyChargeChange,
  computeChargeDelta,
  normalizeChargeChange,
} from './charge-change.mjs';
import {
  snapshotItemForNestedStorage,
  normalizeNestedStorage,
  extractNestedItemToActor,
} from '../item-nested-storage.mjs';
import {
  parentActorItemToWeaponHost,
  unparentActorItemFromHost,
  moveQtyIntoMagazineContainer,
  moveQtyOntoWeaponHost,
  takeOneUnitToHost,
} from '../item-weapon-host.mjs';
import {
  getOrderedDirectChildItemIds,
  moveActorItemIntoContainer,
  removeActorItemFromContainer,
  normalizeItemContainerFields,
} from '../item-container.mjs';

function _t(key, data = undefined) {
  try {
    const i18n = game?.i18n;
    if (!i18n) return key;
    return data ? i18n.format(key, data) : i18n.localize(key);
  } catch (_) {
    return key;
  }
}

function _clone(value) {
  try {
    return foundry.utils.deepClone(value);
  } catch (_) {
    return JSON.parse(JSON.stringify(value ?? null));
  }
}

function _qty(itemLike) {
  const n = Math.floor(Number(itemLike?.system?.quantity));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function _isAmmoItem(itemLike) {
  return itemLike?.type === 'item' && !!itemLike?.system?.itemTags?.isAmmo;
}

function _ammoConfigOf(itemLike) {
  return normalizeAmmoConfig(itemLike?.system?.weapon?.ammo);
}

function _isMagazineContainer(itemLike) {
  return _isAmmoItem(itemLike) && _ammoConfigOf(itemLike).connector.enabled;
}

function _itemPlainObject(item) {
  if (!item) return null;
  try {
    return item.toObject ? item.toObject(false) : _clone(item);
  } catch (_) {
    return _clone(item);
  }
}

function _ensureRuntime(block) {
  if (!block) return null;
  if (!block.runtime || typeof block.runtime !== 'object') {
    block.runtime = {
      charge: 0,
      chamberCharge: false,
      attachedItemId: '',
      chamberItemId: '',
      contentItemIds: [],
      chamberItem: null,
      contents: [],
      magazine: null,
    };
  }
  if (!Array.isArray(block.runtime.contentItemIds)) block.runtime.contentItemIds = [];
  if (typeof block.runtime.attachedItemId !== 'string') block.runtime.attachedItemId = '';
  if (typeof block.runtime.chamberItemId !== 'string') block.runtime.chamberItemId = '';
  return block.runtime;
}

/**
 * Best-effort: find the weapon Item that owns this ammo block id.
 * @param {Actor|null|undefined} actor
 * @param {object|null|undefined} block
 * @returns {Item|null}
 */
function _findWeaponItemForBlock(actor, block) {
  const blockId = String(block?.id ?? '').trim();
  if (!actor?.items || !blockId) return null;
  for (const it of actor.items) {
    if (it?.type !== 'item' || !it.system?.itemTags?.isWeapon) continue;
    const weapon = getWeaponData(it);
    for (const line of weapon.lines ?? []) {
      if ((line.ammoBlocks ?? []).some((b) => b?.id === blockId)) return it;
    }
  }
  return null;
}

function _resolveWeaponItem(actor, weaponItem, block) {
  return weaponItem || _findWeaponItemForBlock(actor, block) || null;
}

/* ================================================================== *
 *  Weapon data access                                                 *
 * ================================================================== */

/**
 * Read normalized weapon data from an Item document.
 * @param {Item} weaponItem
 */
export function getWeaponData(weaponItem) {
  return normalizeWeaponV3(weaponItem?.system?.weapon, weaponItem?.system?.itemTags);
}

/**
 * Persist a (mutated) weapon object back to the item.
 * @param {Item} weaponItem
 * @param {object} weapon
 */
export async function persistWeaponData(weaponItem, weapon) {
  await weaponItem.update({ 'system.weapon': weapon });
}

/**
 * @param {object} weapon
 * @param {string} lineId
 * @param {string} blockId
 * @returns {object|null}
 */
export function getAmmoBlock(weapon, lineId, blockId) {
  const line = getWeaponLine(weapon, lineId);
  return (line?.ammoBlocks ?? []).find((b) => b.id === blockId) ?? null;
}

/**
 * Remove an item id from all weapon block runtimes on the actor (after drag-out).
 * Persists affected weapons.
 * @param {Actor} actor
 * @param {string} itemId
 * @returns {Promise<boolean>}
 */
export async function clearItemFromAllWeaponRuntimes(actor, itemId) {
  const id = String(itemId ?? '').trim();
  if (!actor?.items || !id) return false;
  let any = false;
  for (const weaponItem of actor.items) {
    if (weaponItem.type !== 'item') continue;
    const tags = weaponItem.system?.itemTags ?? {};
    if (!(tags.isWeapon || tags.isMelee || tags.isRanged || tags.isThrown)) continue;
    const weapon = getWeaponData(weaponItem);
    let changed = false;
    for (const line of weapon.lines ?? []) {
      for (const block of line.ammoBlocks ?? []) {
        const rt = _ensureRuntime(block);
        if (String(rt.attachedItemId ?? '') === id) {
          rt.attachedItemId = '';
          changed = true;
        }
        if (String(rt.chamberItemId ?? '') === id) {
          rt.chamberItemId = '';
          changed = true;
        }
        if (Array.isArray(rt.contentItemIds) && rt.contentItemIds.includes(id)) {
          rt.contentItemIds = rt.contentItemIds.filter((x) => String(x) !== id);
          changed = true;
        }
      }
    }
    if (changed) {
      await persistWeaponData(weaponItem, weapon);
      any = true;
    }
  }
  return any;
}

/* ================================================================== *
 *  Live resolve helpers                                               *
 * ================================================================== */

/**
 * @param {Actor|null|undefined} actor
 * @param {object|null|undefined} block
 * @returns {Item|null}
 */
export function getAttachedMagazineItem(actor, block) {
  const id = String(block?.runtime?.attachedItemId ?? '').trim();
  if (!id || !actor?.items) return null;
  return actor.items.get(id) ?? null;
}

/**
 * @param {Actor|null|undefined} actor
 * @param {object|null|undefined} block
 * @returns {Item[]}
 */
export function getBlockContentItems(actor, block) {
  const ids = Array.isArray(block?.runtime?.contentItemIds) ? block.runtime.contentItemIds : [];
  if (!actor?.items || !ids.length) return [];
  const out = [];
  for (const raw of ids) {
    const id = String(raw ?? '').trim();
    if (!id) continue;
    const it = actor.items.get(id);
    if (it) out.push(it);
  }
  return out;
}

/**
 * @param {Actor|null|undefined} actor
 * @param {object|null|undefined} block
 * @returns {Item|null}
 */
export function getChamberItem(actor, block) {
  const id = String(block?.runtime?.chamberItemId ?? '').trim();
  if (!id || !actor?.items) return null;
  return actor.items.get(id) ?? null;
}

/** @param {object|null|undefined} block */
export function hasAttachedMagazine(block) {
  return !!(String(block?.runtime?.attachedItemId ?? '').trim() || block?.runtime?.magazine);
}

/** Number of rounds currently in the block reserve (without chamber). */
export function blockReserveCount(block, actor = null) {
  if (!block) return 0;
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    return Math.max(0, Number(block.runtime?.charge) || 0);
  }
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    const mag = actor ? getAttachedMagazineItem(actor, block) : null;
    if (mag && actor) {
      return getOrderedDirectChildItemIds(actor, mag.id).reduce((sum, id) => {
        const child = actor.items.get(id);
        return sum + _qty(child);
      }, 0);
    }
    const legacy = block.runtime?.magazine;
    const contents = Array.isArray(legacy?.system?.storage?.contents)
      ? legacy.system.storage.contents
      : [];
    return contents.reduce((sum, e) => sum + _qty(e), 0);
  }
  if (actor && Array.isArray(block.runtime?.contentItemIds) && block.runtime.contentItemIds.length) {
    return getBlockContentItems(actor, block).reduce((sum, it) => sum + _qty(it), 0);
  }
  return (block.runtime?.contents ?? []).reduce((sum, e) => sum + _qty(e), 0);
}

/** Whether the chamber currently holds a round/charge. */
export function blockChamberLoaded(block, actor = null) {
  if (!block?.chamberEnabled) return false;
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) return !!block.runtime?.chamberCharge;
  if (actor && String(block.runtime?.chamberItemId ?? '').trim()) {
    if (getChamberItem(actor, block)) return true;
  }
  if (String(block.runtime?.chamberItemId ?? '').trim()) return true;
  return !!(block.runtime?.chamberItem || block.runtime?.chamberCharge);
}

/**
 * Load limit rule: `reserve + chamber < N + (chamber enabled ? 1 : 0)`.
 * @param {object} block
 * @param {Actor|null} [actor]
 */
export function blockCanLoadMore(block, actor = null) {
  const reserve = blockReserveCount(block, actor);
  const chamber = blockChamberLoaded(block, actor) ? 1 : 0;
  const cap = resolveBlockCapacity(block, actor) + (block?.chamberEnabled ? 1 : 0);
  return reserve + chamber < cap;
}

/** Free reserve slots (chamber excluded; chamber surplus allowed). */
export function blockReserveFreeSlots(block, actor = null) {
  const reserve = blockReserveCount(block, actor);
  return Math.max(0, resolveBlockCapacity(block, actor) - reserve);
}

/**
 * Block readiness for one shot: chamber round when chamber enabled,
 * otherwise non-empty reserve. `N = 0` + chamber off → on-the-fly search
 * (reported as ready; the actual search happens at consumption).
 * @param {object} block
 * @param {Actor|null} [actor]
 * @returns {{ready: boolean, reason: string}}
 */
export function blockShotReadiness(block, actor = null) {
  if (!block) return { ready: false, reason: 'noBlock' };
  if (block.chamberEnabled) {
    return blockChamberLoaded(block, actor)
      ? { ready: true, reason: '' }
      : { ready: false, reason: blockReserveCount(block, actor) > 0 ? 'needBolt' : 'needReload' };
  }
  if (block.capacity <= 0 && block.type === AMMO_BLOCK_TYPES.INTERNAL_MAGAZINE) {
    return { ready: true, reason: 'onTheFly' };
  }
  return blockReserveCount(block, actor) > 0
    ? { ready: true, reason: '' }
    : { ready: false, reason: 'needReload' };
}

function _hasCompatibleAmmo(actor, block) {
  return findAmmoCandidates(actor, { caliber: block.caliber, search: block.search }).length > 0;
}

function _hasCompatibleMagazine(actor, block) {
  return findAmmoCandidates(actor, {
    search: block.search,
    predicate: (it) => _isCompatibleMagazine(it, block.connector),
  }).length > 0;
}

/** @returns {boolean} */
export function canLoadOne(actor, block) {
  if (!block?.apActions?.loadOne?.enabled) return false;
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) return false;
  if (blockReserveFreeSlots(block, actor) <= 0) return false;
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) return blockCanLoadMore(block, actor);
  return _hasCompatibleAmmo(actor, block);
}

/** @returns {boolean} */
export function canLoadX(actor, block) {
  if (!block?.apActions?.loadX?.enabled) return false;
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) return false;
  const x = Math.max(0, Number(block.loadAmount) || 0);
  if (x <= 0) return false;
  if (blockReserveFreeSlots(block, actor) <= 0) return false;
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) return blockCanLoadMore(block, actor);
  return _hasCompatibleAmmo(actor, block);
}

/** @returns {boolean} */
export function canReloadBlock(actor, block) {
  if (!block?.apActions?.reload?.enabled) return false;
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    return _hasCompatibleMagazine(actor, block);
  }
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    return blockReserveCount(block, actor) < resolveBlockCapacity(block, actor);
  }
  if (blockReserveFreeSlots(block, actor) <= 0) return false;
  return _hasCompatibleAmmo(actor, block);
}

/** @returns {boolean} */
export function canBoltBlock(block, actor = null) {
  if (!block?.apActions?.bolt?.enabled || !block.chamberEnabled) return false;
  if (blockChamberLoaded(block, actor)) return true;
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    return (block.runtime?.charge ?? 0) > 0;
  }
  return blockReserveCount(block, actor) > 0;
}

/** @returns {boolean} */
export function canUnloadBlock(block, actor = null) {
  if (!block?.apActions?.unload?.enabled) return false;
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) return false;
  return blockReserveCount(block, actor) > 0;
}

/** @returns {boolean} */
export function canEmptyBlock(block, actor = null) {
  if (!block?.apActions?.empty?.enabled) return false;
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    return hasAttachedMagazine(block) || blockChamberLoaded(block, actor);
  }
  return blockReserveCount(block, actor) > 0 || blockChamberLoaded(block, actor);
}

/** @returns {boolean} */
export function canAttachMagazine(actor, block) {
  if (block?.type !== AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) return false;
  if (hasAttachedMagazine(block)) return false;
  return _hasCompatibleMagazine(actor, block);
}

/** @returns {boolean} */
export function canDetachMagazine(block) {
  return block?.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE && hasAttachedMagazine(block);
}

async function _maybeBoltAfterReload({ actor, weaponItem, block }) {
  if (!block?.chamberEnabled || blockChamberLoaded(block, actor)) return { ok: true };
  return operateBolt({ actor, weaponItem, block });
}

/* ================================================================== *
 *  Actor inventory search                                             *
 * ================================================================== */

const SEARCH_GROUP_ORDER = Object.freeze(['hands', 'worn', 'inventory', 'containers']);

function _isCompatibleAmmo(itemLike, caliber) {
  if (!_isAmmoItem(itemLike)) return false;
  if (_qty(itemLike) <= 0) return false;
  const cfg = _ammoConfigOf(itemLike);
  if (cfg.connector.enabled) return false; // magazines are not loose rounds
  return compatMatches(caliber, cfg.caliber);
}

function _isCompatibleMagazine(itemLike, connector) {
  if (!_isMagazineContainer(itemLike)) return false;
  return compatMatches(connector, _ammoConfigOf(itemLike).connector.value);
}

function _hostIsWeapon(actor, hostId) {
  const id = String(hostId ?? '').trim();
  if (!id || !actor?.items) return false;
  const host = actor.items.get(id);
  return !!(host?.system?.itemTags?.isWeapon);
}

/**
 * Search the actor inventory for compatible ammo items, grouped by priority:
 * held → worn containers → loose inventory → containers in inventory.
 *
 * Items parented under a weapon-tagged host are excluded (already loaded).
 *
 * @param {Actor} actor
 * @param {object} args
 * @param {string} args.caliber weapon block caliber string
 * @param {object} [args.search] block search config (group checkboxes)
 * @param {(item: Item) => boolean} [args.predicate] custom compatibility test
 * @returns {Array<{group: string, item: Item}>} flat, priority-ordered
 */
export function findAmmoCandidates(actor, { caliber = '', search = null, predicate = null } = {}) {
  const items = Array.from(actor?.items ?? []);
  const test = predicate ?? ((it) => _isCompatibleAmmo(it, caliber));
  const enabled = (g) => (search ? !!search[g] : true);

  const wornContainerIds = new Set(
    items
      .filter((it) => it.type === 'item' && it.system?.itemTags?.isContainer && it.system?.equipped)
      .map((it) => it.id)
  );

  const groups = { hands: [], worn: [], inventory: [], containers: [] };
  for (const it of items) {
    if (!test(it)) continue;
    const hostId = String(it.system?.containerHostId ?? '').trim();
    if (hostId && _hostIsWeapon(actor, hostId)) continue;
    if (it.system?.held) groups.hands.push(it);
    else if (hostId && wornContainerIds.has(hostId)) groups.worn.push(it);
    else if (!hostId) groups.inventory.push(it);
    else groups.containers.push(it);
  }

  const out = [];
  for (const g of SEARCH_GROUP_ORDER) {
    if (!enabled(g)) continue;
    for (const item of groups[g]) out.push({ group: g, item });
  }
  return out;
}

/**
 * Fill / contents preview for ammo or magazine items (context menus, inventory).
 * @param {Item|object|null|undefined} itemLike
 * @returns {{current: number, max: number, percent: number, loadedLabel: string, isMagazine: boolean, isEmpty: boolean}}
 */
export function getAmmoItemChargePreview(itemLike) {
  const empty = { current: 0, max: 0, percent: 0, loadedLabel: '', isMagazine: false, isEmpty: true };
  if (!itemLike) return empty;
  const ammo = _ammoConfigOf(itemLike);
  if (ammo.connector.enabled) {
    let contents = [];
    const actor = itemLike.actor ?? itemLike.parent;
    if (actor?.documentName === 'Actor' && itemLike.id) {
      contents = getOrderedDirectChildItemIds(actor, itemLike.id)
        .map((id) => actor.items.get(id))
        .filter(Boolean);
    } else {
      contents = Array.isArray(itemLike?.system?.storage?.contents)
        ? itemLike.system.storage.contents
        : normalizeNestedStorage(itemLike?.system?.storage).contents;
    }
    const current = contents.reduce((sum, e) => sum + _qty(e), 0);
    const max = Math.max(0, Number(ammo.capacity) || 0);
    const names = [];
    const seen = new Set();
    for (const entry of contents) {
      const name = String(entry?.name ?? '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    const loadedLabel = names.length ? names.join(', ') : '';
    const percent = max > 0 ? Math.min(1, Math.max(0, current / max)) : 0;
    return {
      current,
      max,
      percent,
      loadedLabel,
      isMagazine: true,
      isEmpty: current <= 0,
    };
  }
  if (ammo.charge.enabled && ammo.charge.max > 0) {
    const current = Math.max(0, Number(ammo.charge.current) || 0);
    const max = Math.max(0, Number(ammo.charge.max) || 0);
    return {
      current,
      max,
      percent: max > 0 ? Math.min(1, Math.max(0, current / max)) : 0,
      loadedLabel: '',
      isMagazine: false,
      isEmpty: current <= 0,
    };
  }
  const qty = _qty(itemLike);
  return {
    current: qty,
    max: 0,
    percent: 0,
    loadedLabel: '',
    isMagazine: false,
    isEmpty: qty <= 0,
  };
}

/**
 * Weapons (and ammo blocks) on the actor that can accept this ammo/magazine item.
 * @param {Actor} actor
 * @param {Item} ammoItem
 * @returns {Array<{weaponItem: Item, line: object, block: object, mode: 'magazine'|'ammo'}>}
 */
export function findCompatibleWeaponLoadTargets(actor, ammoItem) {
  const out = [];
  if (!actor || !_isAmmoItem(ammoItem)) return out;
  const isMag = _isMagazineContainer(ammoItem);
  const items = Array.from(actor.items ?? []);
  for (const weaponItem of items) {
    if (weaponItem?.type !== 'item' || !weaponItem.system?.itemTags?.isWeapon) continue;
    const weapon = getWeaponData(weaponItem);
    for (const line of weapon.lines ?? []) {
      for (const block of line.ammoBlocks ?? []) {
        if (!block) continue;
        if (isMag) {
          if (block.type !== AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) continue;
          if (hasAttachedMagazine(block)) continue;
          if (!_isCompatibleMagazine(ammoItem, block.connector)) continue;
          out.push({ weaponItem, line, block, mode: 'magazine' });
          continue;
        }
        if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE && !hasAttachedMagazine(block)) continue;
        if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) continue;
        if (blockReserveFreeSlots(block, actor) <= 0) continue;
        if (!_isCompatibleAmmo(ammoItem, block.caliber)) continue;
        out.push({ weaponItem, line, block, mode: 'ammo' });
      }
    }
  }
  return out;
}

/**
 * Magazine items on the actor that can accept this loose round
 * (including magazines already attached to a weapon).
 * @param {Actor} actor
 * @param {Item} ammoItem
 * @returns {Array<{magazineItem: Item, free: number}>}
 */
export function findCompatibleMagazineLoadTargets(actor, ammoItem) {
  const out = [];
  if (!actor || !_isAmmoItem(ammoItem) || _isMagazineContainer(ammoItem)) return out;
  const ammoCfg = _ammoConfigOf(ammoItem);
  if (ammoCfg.connector.enabled) return out;
  for (const mag of actor.items ?? []) {
    if (!_isMagazineContainer(mag)) continue;
    const magCfg = _ammoConfigOf(mag);
    if (!compatMatches(magCfg.caliber, ammoCfg.caliber)) continue;
    const preview = getAmmoItemChargePreview(mag);
    const free = Math.max(0, (preview.max || 0) - (preview.current || 0));
    if (free <= 0) continue;
    out.push({ magazineItem: mag, free });
  }
  return out;
}

/**
 * Inventory candidates that can charge a specific weapon ammo block.
 * @param {Actor} actor
 * @param {object} block
 * @returns {Array<{group: string, item: Item, mode: 'magazine'|'ammo'}>}
 */
export function findChargeCandidatesForBlock(actor, block) {
  if (!block) return [];
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    if (hasAttachedMagazine(block)) return [];
    return findAmmoCandidates(actor, {
      search: block.search,
      predicate: (it) => _isCompatibleMagazine(it, block.connector),
    }).map((c) => ({ ...c, mode: 'magazine' }));
  }
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) return [];
  if (blockReserveFreeSlots(block, actor) <= 0) return [];
  return findAmmoCandidates(actor, {
    caliber: block.caliber,
    search: block.search,
  }).map((c) => ({ ...c, mode: 'ammo' }));
}

/**
 * Pick the ammo source according to the block search mode.
 *  - auto:   first candidate by priority.
 *  - semi:   auto when the top-priority group has a single option, else dialog.
 *  - manual: always dialog (even with one or zero candidates).
 *
 * @returns {Promise<Item|null>}
 */
export async function pickAmmoCandidate(actor, { caliber = '', search = null, predicate = null, title = '' } = {}) {
  const mode = search?.mode ?? AMMO_SEARCH_MODES.AUTO;
  const candidates = findAmmoCandidates(actor, { caliber, search, predicate });

  if (mode === AMMO_SEARCH_MODES.AUTO) return candidates[0]?.item ?? null;

  if (mode === AMMO_SEARCH_MODES.SEMI) {
    if (!candidates.length) return null;
    const topGroup = candidates[0].group;
    const sameGroup = candidates.filter((c) => c.group === topGroup);
    if (sameGroup.length === 1) return sameGroup[0].item;
  }

  return _showAmmoPickDialog(candidates, title);
}

async function _showAmmoPickDialog(candidates, title = '') {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return candidates[0]?.item ?? null;
  if (!candidates.length) {
    ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.Ammo.NoCandidates'));
    return null;
  }
  const groupLabel = (g) => _t(`SPACEHOLDER.WeaponV3.Ammo.Group.${g}`);
  const options = candidates
    .map((c, i) => `<option value="${i}">${foundry.utils.escapeHTML(c.item.name)} ×${_qty(c.item)} (${groupLabel(c.group)})</option>`)
    .join('');
  const content = `
    <div class="form-group">
      <label>${_t('SPACEHOLDER.WeaponV3.Ammo.PickPrompt')}</label>
      <select name="sh-ammo-pick" style="width:100%">${options}</select>
    </div>`;
  let pickedIdx = null;
  await DialogV2.wait({
    classes: ['spaceholder'],
    window: { title: title || _t('SPACEHOLDER.WeaponV3.Ammo.PickTitle'), icon: 'fa-solid fa-box-open' },
    position: { width: 380 },
    content,
    buttons: [
      {
        action: 'ok',
        label: _t('SPACEHOLDER.Actions.Save'),
        icon: 'fa-solid fa-check',
        default: true,
        callback: (ev) => {
          const root = ev?.currentTarget?.closest?.('.window-content') ?? document;
          const sel = root.querySelector('[name="sh-ammo-pick"]');
          pickedIdx = Number(sel?.value);
        },
      },
      { action: 'cancel', label: _t('SPACEHOLDER.Actions.Cancel'), icon: 'fa-solid fa-times' },
    ],
  });
  if (!Number.isFinite(pickedIdx)) return null;
  return candidates[pickedIdx]?.item ?? null;
}

/**
 * Return a snapshot back to the actor inventory (migrate / legacy give).
 * @param {Actor} actor
 * @param {object} snapshot
 * @param {{held?: boolean, containerHostId?: string}} [opts]
 */
async function _giveSnapshotToActor(actor, snapshot, { held = true, containerHostId = '' } = {}) {
  if (!actor || !snapshot) return null;
  const data = _clone(snapshot);
  delete data.id;
  delete data._id;
  delete data.sourceUuid;
  data.system = data.system ?? {};
  data.system.held = held;
  data.system.equipped = false;
  data.system.containerHostId = String(containerHostId ?? '').trim();
  const created = await actor.createEmbeddedDocuments('Item', [data], { render: false });
  return created?.[0] ?? null;
}

async function _ejectChamberItem(actor, chamberItem) {
  if (!actor || !chamberItem) return;
  await unparentActorItemFromHost(actor, chamberItem.id, { held: false });
  ui.notifications?.info?.(_t('SPACEHOLDER.WeaponV3.Ammo.RoundEjected', { name: chamberItem.name ?? '' }));
}

/* ================================================================== *
 *  Lazy migrate: legacy snapshots → live Actor Items                  *
 * ================================================================== */

/**
 * Migrate legacy magazine / contents / chamberItem snapshots on a block
 * into live Actor Items parented to the weapon. Mutates `block.runtime`.
 *
 * @param {Actor} actor
 * @param {Item} weaponItem
 * @param {object} block
 * @returns {Promise<boolean>} true if any migration write happened
 */
export async function ensureLiveBlockRuntime(actor, weaponItem, block) {
  if (!actor || !weaponItem || !block) return false;
  const rt = _ensureRuntime(block);
  let changed = false;

  // Legacy magazine snapshot → attached live mag.
  if (
    block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE
    && !String(rt.attachedItemId ?? '').trim()
    && rt.magazine
    && typeof rt.magazine === 'object'
  ) {
    const mag = await _giveSnapshotToActor(actor, rt.magazine, { held: false });
    if (mag) {
      await _prepareMagazineAsContainer(mag);
      await _migrateMagazineNestedStorageToLive(actor, mag);
      await parentActorItemToWeaponHost(actor, weaponItem, mag.id, { held: false });
      rt.attachedItemId = mag.id;
      rt.magazine = null;
      changed = true;
    }
  }

  // Legacy contents[] → contentItemIds.
  if (
    Array.isArray(rt.contents)
    && rt.contents.length
    && (!Array.isArray(rt.contentItemIds) || rt.contentItemIds.length === 0)
  ) {
    if (!Array.isArray(rt.contentItemIds)) rt.contentItemIds = [];
    for (const snap of rt.contents) {
      if (!snap || typeof snap !== 'object') continue;
      const created = await _giveSnapshotToActor(actor, snap, { held: false });
      if (!created) continue;
      await parentActorItemToWeaponHost(actor, weaponItem, created.id, { held: false });
      rt.contentItemIds.push(created.id);
      changed = true;
    }
    rt.contents = [];
  }

  // Legacy chamberItem → chamberItemId.
  if (
    !String(rt.chamberItemId ?? '').trim()
    && rt.chamberItem
    && typeof rt.chamberItem === 'object'
  ) {
    const created = await _giveSnapshotToActor(actor, rt.chamberItem, { held: false });
    if (created) {
      await parentActorItemToWeaponHost(actor, weaponItem, created.id, { held: false });
      rt.chamberItemId = created.id;
      rt.chamberItem = null;
      changed = true;
    }
  }

  return changed;
}

async function _prepareMagazineAsContainer(mag) {
  if (!mag) return;
  const patch = {};
  if (!mag.system?.itemTags?.isContainer) {
    patch['system.itemTags.isContainer'] = true;
  }
  const ammo = _ammoConfigOf(mag);
  const cap = Math.max(0, Number(ammo.capacity) || 0);
  if (cap > 0) {
    const norm = normalizeItemContainerFields(mag.system);
    if (norm.container.limits.maxItems !== cap) {
      patch['system.container.limits.maxItems'] = cap;
    }
  }
  if (Object.keys(patch).length) await mag.update(patch, { render: false });
}

/**
 * Move nested-storage contents of a magazine into live container children.
 * @param {Actor} actor
 * @param {Item} mag
 */
async function _migrateMagazineNestedStorageToLive(actor, mag) {
  if (!actor || !mag) return;
  let storage = normalizeNestedStorage(mag.system?.storage);
  while (storage.contents.length) {
    const entry = storage.contents[0];
    const path = [entry.id];
    const created = await extractNestedItemToActor({
      containerItem: mag,
      path,
      quantity: _qty(entry) || 1,
    });
    if (!created) {
      // Avoid infinite loop if extract fails: drop the head snapshot.
      storage = normalizeNestedStorage(mag.system?.storage);
      if (storage.contents[0]?.id === entry.id) {
        storage.contents.shift();
        await mag.update({ 'system.storage': storage }, { render: false });
      } else {
        break;
      }
      continue;
    }
    await moveActorItemIntoContainer(actor, mag, created.id);
    storage = normalizeNestedStorage(mag.system?.storage);
  }
  // Ensure empty nested storage after migration.
  const cleared = normalizeNestedStorage(mag.system?.storage);
  if (cleared.contents.length) {
    cleared.contents = [];
    await mag.update({ 'system.storage': cleared }, { render: false });
  }
}

async function _ensureLiveIfPossible(actor, weaponItem, block) {
  const w = _resolveWeaponItem(actor, weaponItem, block);
  if (actor && w && block) await ensureLiveBlockRuntime(actor, w, block);
  return w;
}

/* ================================================================== *
 *  Reserve FIFO (live)                                                *
 * ================================================================== */

/**
 * Take one live unit from block reserve onto the weapon host as chamber.
 * @returns {Promise<Item|null>}
 */
async function _takeOneFromReserveToChamber(actor, weaponItem, block) {
  if (!actor || !weaponItem || !block) return null;
  const rt = _ensureRuntime(block);

  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    const mag = getAttachedMagazineItem(actor, block);
    if (!mag) return null;
    const childIds = getOrderedDirectChildItemIds(actor, mag.id);
    if (!childIds.length) return null;
    const stack = actor.items.get(childIds[0]);
    if (!stack) return null;
    return takeOneUnitToHost(actor, stack, weaponItem);
  }

  if (!Array.isArray(rt.contentItemIds)) rt.contentItemIds = [];
  // Drop missing ids.
  rt.contentItemIds = rt.contentItemIds.filter((id) => !!actor.items.get(String(id ?? '').trim()));
  if (!rt.contentItemIds.length) return null;
  const headId = rt.contentItemIds[0];
  const stack = actor.items.get(headId);
  if (!stack) {
    rt.contentItemIds.shift();
    return _takeOneFromReserveToChamber(actor, weaponItem, block);
  }
  const unit = await takeOneUnitToHost(actor, stack, weaponItem);
  if (!unit) return null;
  // Whole stack moved → remove from FIFO; split leaves remainder at head.
  if (unit.id === headId) rt.contentItemIds.shift();
  else if (!actor.items.get(headId) || _qty(actor.items.get(headId)) <= 0) {
    rt.contentItemIds.shift();
  }
  return unit;
}

/**
 * Unparent all reserve items for a block back to actor root (held).
 * @returns {Promise<number>} unloaded quantity
 */
async function _unloadReserveToRoot(actor, block) {
  if (!actor || !block) return 0;
  const rt = _ensureRuntime(block);
  let unloaded = 0;

  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    const mag = getAttachedMagazineItem(actor, block);
    if (!mag) return 0;
    const childIds = [...getOrderedDirectChildItemIds(actor, mag.id)];
    for (const id of childIds) {
      const child = actor.items.get(id);
      if (!child) continue;
      unloaded += _qty(child);
      await unparentActorItemFromHost(actor, id, { held: true });
    }
    return unloaded;
  }

  const ids = [...(rt.contentItemIds ?? [])];
  for (const id of ids) {
    const it = actor.items.get(String(id ?? '').trim());
    if (!it) continue;
    unloaded += _qty(it);
    await unparentActorItemFromHost(actor, it.id, { held: true });
  }
  rt.contentItemIds = [];
  rt.contents = [];
  return unloaded;
}

/* ================================================================== *
 *  Block operations (mutate weapon object; caller persists)           *
 * ================================================================== */

/**
 * «Затвор»: empty chamber → move one round from reserve into the chamber;
 * loaded chamber → eject (item drops / internal charge is lost).
 *
 * @param {object} args
 * @param {Actor|null} args.actor
 * @param {Item|null} [args.weaponItem]
 * @param {object} args.block normalized ammo block (mutated)
 * @returns {Promise<{ok: boolean, reason?: string, changed: boolean}>}
 */
export async function operateBolt({ actor, weaponItem = null, block }) {
  if (!block?.chamberEnabled) return { ok: false, reason: 'noChamber', changed: false };
  const w = await _ensureLiveIfPossible(actor, weaponItem, block);

  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    if (block.runtime.chamberCharge) {
      block.runtime.chamberCharge = false; // заряд теряется
      return { ok: true, changed: true };
    }
    if (block.runtime.charge <= 0) return { ok: false, reason: 'reserveEmpty', changed: false };
    block.runtime.charge -= 1;
    block.runtime.chamberCharge = true;
    return { ok: true, changed: true };
  }

  const rt = _ensureRuntime(block);
  const chamber = getChamberItem(actor, block);
  if (chamber || String(rt.chamberItemId ?? '').trim()) {
    if (chamber) await _ejectChamberItem(actor, chamber);
    rt.chamberItemId = '';
    rt.chamberItem = null;
    return { ok: true, changed: true };
  }

  if (!w) return { ok: false, reason: 'noWeapon', changed: false };
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE && !getAttachedMagazineItem(actor, block)) {
    return { ok: false, reason: 'noMagazine', changed: false };
  }
  const unit = await _takeOneFromReserveToChamber(actor, w, block);
  if (!unit) return { ok: false, reason: 'reserveEmpty', changed: false };
  rt.chamberItemId = unit.id;
  rt.chamberItem = null;
  return { ok: true, changed: true };
}

/**
 * Feed the chamber from the reserve without ejecting (used by auto-feed
 * after a shot, and after reload when the chamber is empty).
 *
 * @param {object} args
 * @param {Actor|null} [args.actor]
 * @param {Item|null} [args.weaponItem]
 * @param {object} args.block
 * @returns {Promise<boolean>} true when a round was chambered
 */
export async function feedChamber({ actor = null, weaponItem = null, block }) {
  if (!block?.chamberEnabled || blockChamberLoaded(block, actor)) return false;
  const w = await _ensureLiveIfPossible(actor, weaponItem, block);

  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    if (block.runtime.charge <= 0) return false;
    block.runtime.charge -= 1;
    block.runtime.chamberCharge = true;
    return true;
  }

  if (!actor || !w) return false;
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE && !getAttachedMagazineItem(actor, block)) {
    return false;
  }
  const unit = await _takeOneFromReserveToChamber(actor, w, block);
  if (!unit) return false;
  const rt = _ensureRuntime(block);
  rt.chamberItemId = unit.id;
  rt.chamberItem = null;
  return true;
}

/**
 * Load up to `count` rounds into the block reserve from the actor inventory
 * (item-fed blocks) or as plain charges (internal charge).
 *
 * @param {object} args
 * @param {Actor|null} args.actor
 * @param {Item|null} [args.weaponItem]
 * @param {object} args.block (mutated)
 * @param {number} args.count rounds to add; Infinity → fill to capacity
 * @param {Item|null} [args.ammoItem] explicit inventory source (skips pick dialog)
 * @returns {Promise<{ok: boolean, loaded: number, reason?: string}>}
 */
export async function loadBlock({ actor, weaponItem = null, block, count = 1, ammoItem = null }) {
  if (!block) return { ok: false, loaded: 0, reason: 'noBlock' };
  const w = await _ensureLiveIfPossible(actor, weaponItem, block);
  const free = blockReserveFreeSlots(block, actor);
  const want = Math.min(free, Math.max(0, Math.floor(Number(count) === Infinity ? free : count)));
  if (want <= 0) return { ok: false, loaded: 0, reason: 'full' };

  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    block.runtime.charge += want;
    return { ok: true, loaded: want };
  }

  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    const mag = getAttachedMagazineItem(actor, block);
    if (!mag) return { ok: false, loaded: 0, reason: 'noMagazine' };
    return _loadIntoMagazine({ actor, block, mag, want, ammoItem });
  }

  if (!w) return { ok: false, loaded: 0, reason: 'noWeapon' };
  return _loadOntoWeaponHost({ actor, weaponItem: w, block, want, ammoItem });
}

async function _loadIntoMagazine({ actor, block, mag, want, ammoItem }) {
  let loaded = 0;
  let source = ammoItem;
  while (loaded < want) {
    if (!source) {
      source = await pickAmmoCandidate(actor, {
        caliber: block.caliber,
        search: block.search,
        title: _t('SPACEHOLDER.WeaponV3.Ammo.PickTitle'),
      });
    }
    if (!source) break;
    if (!_isCompatibleAmmo(source, block.caliber)) {
      if (ammoItem) return { ok: false, loaded: 0, reason: 'incompatible' };
      source = null;
      continue;
    }
    const batch = Math.min(want - loaded, _qty(source));
    if (batch <= 0) break;
    const res = await moveQtyIntoMagazineContainer(actor, mag, source, batch);
    if (!res.ok) break;
    loaded += res.moved;
    if (ammoItem) break;
    source = null;
  }
  if (loaded <= 0) return { ok: false, loaded: 0, reason: 'noAmmoFound' };
  return { ok: true, loaded };
}

async function _loadOntoWeaponHost({ actor, weaponItem, block, want, ammoItem }) {
  const rt = _ensureRuntime(block);
  let loaded = 0;
  let source = ammoItem;
  while (loaded < want) {
    if (!source) {
      source = await pickAmmoCandidate(actor, {
        caliber: block.caliber,
        search: block.search,
        title: _t('SPACEHOLDER.WeaponV3.Ammo.PickTitle'),
      });
    }
    if (!source) break;
    if (!_isCompatibleAmmo(source, block.caliber)) {
      if (ammoItem) return { ok: false, loaded: 0, reason: 'incompatible' };
      source = null;
      continue;
    }
    const batch = Math.min(want - loaded, _qty(source));
    if (batch <= 0) break;
    const res = await moveQtyOntoWeaponHost(actor, weaponItem, source, batch);
    if (!res.ok || !res.item) break;
    const id = res.item.id;
    if (!rt.contentItemIds.includes(id)) rt.contentItemIds.push(id);
    loaded += res.moved;
    if (ammoItem) break;
    source = null;
  }
  if (loaded <= 0) return { ok: false, loaded: 0, reason: 'noAmmoFound' };
  return { ok: true, loaded };
}

/**
 * «Разрядить»: move the whole reserve back to the actor inventory (held);
 * chamber untouched. Internal charge → reserve to 0.
 * @returns {Promise<{ok: boolean, unloaded: number}>}
 */
export async function unloadBlock({ actor, weaponItem = null, block }) {
  if (!block) return { ok: false, unloaded: 0 };
  await _ensureLiveIfPossible(actor, weaponItem, block);

  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    const had = block.runtime.charge;
    block.runtime.charge = 0;
    return { ok: true, unloaded: had };
  }

  const unloaded = await _unloadReserveToRoot(actor, block);
  return { ok: true, unloaded };
}

/**
 * «Опустошить»: составное действие — снять магазин / разрядить резерв,
 * затем затвор для очистки патронника (если включён).
 * @returns {Promise<{ok: boolean, unloaded: number}>}
 */
export async function emptyBlock({ actor, weaponItem = null, block }) {
  if (!block) return { ok: false, unloaded: 0 };
  const w = await _ensureLiveIfPossible(actor, weaponItem, block);
  let unloaded = 0;
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    if (hasAttachedMagazine(block)) {
      unloaded += blockReserveCount(block, actor);
      const det = await detachMagazine({ actor, weaponItem: w, block });
      if (!det.ok) return { ok: false, unloaded: 0 };
    }
  } else {
    const res = await unloadBlock({ actor, weaponItem: w, block });
    if (!res.ok) return res;
    unloaded = res.unloaded;
  }
  if (block.chamberEnabled && blockChamberLoaded(block, actor)) {
    const bolt = await operateBolt({ actor, weaponItem: w, block });
    if (bolt.ok) unloaded += 1;
  }
  return { ok: true, unloaded };
}

/**
 * Attach a magazine container item to an external-magazine block.
 * @param {object} args
 * @param {Actor|null} args.actor
 * @param {Item|null} [args.weaponItem]
 * @param {object} args.block (mutated)
 * @param {Item} [args.magazineItem] explicit item; otherwise searched/picked
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function attachMagazine({ actor, weaponItem = null, block, magazineItem = null }) {
  if (block?.type !== AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) return { ok: false, reason: 'wrongBlockType' };
  const w = await _ensureLiveIfPossible(actor, weaponItem, block);
  if (hasAttachedMagazine(block)) return { ok: false, reason: 'alreadyAttached' };
  if (!w) return { ok: false, reason: 'noWeapon' };

  let source = magazineItem;
  if (!source) {
    source = await pickAmmoCandidate(actor, {
      search: block.search,
      predicate: (it) => _isCompatibleMagazine(it, block.connector),
      title: _t('SPACEHOLDER.WeaponV3.Ammo.PickMagazineTitle'),
    });
  }
  if (!source) return { ok: false, reason: 'noMagazineFound' };
  if (!_isCompatibleMagazine(source, block.connector)) return { ok: false, reason: 'incompatible' };

  await _prepareMagazineAsContainer(source);
  await _migrateMagazineNestedStorageToLive(actor, source);
  const ok = await parentActorItemToWeaponHost(actor, w, source.id, { held: false });
  if (!ok) return { ok: false, reason: 'hostFailed' };

  const rt = _ensureRuntime(block);
  rt.attachedItemId = source.id;
  rt.magazine = null;
  return { ok: true };
}

/**
 * Detach the magazine container back to the actor inventory.
 * @param {object} args
 * @param {Actor|null} args.actor
 * @param {Item|null} [args.weaponItem]
 * @param {object} args.block
 * @param {boolean} [args.held=true]
 * @returns {Promise<{ok: boolean}>}
 */
export async function detachMagazine({ actor, weaponItem = null, block, held = true }) {
  if (block?.type !== AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) return { ok: false };
  await _ensureLiveIfPossible(actor, weaponItem, block);
  const rt = _ensureRuntime(block);
  const mag = getAttachedMagazineItem(actor, block);
  if (!mag && !rt.magazine) return { ok: false };

  if (mag) {
    await unparentActorItemFromHost(actor, mag.id, { held });
  } else if (rt.magazine) {
    await _giveSnapshotToActor(actor, rt.magazine, { held });
  }
  rt.attachedItemId = '';
  rt.magazine = null;
  return { ok: true };
}

/**
 * «Перезарядить» — составное действие.
 * Внешний магазин: снять (если есть) → установить новый → затвор при пустом патроннике.
 * Прочие типы: дозарядить резерв → затвор при пустом патроннике.
 * Операции с магазином не трогают патронник.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function reloadBlock({ actor, weaponItem = null, block }) {
  if (!block) return { ok: false, reason: 'noBlock' };
  const w = await _ensureLiveIfPossible(actor, weaponItem, block);

  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    if (hasAttachedMagazine(block)) {
      const detachedMagIsEmpty = blockReserveCount(block, actor) <= 0;
      const det = await detachMagazine({ actor, weaponItem: w, block, held: !detachedMagIsEmpty });
      if (!det.ok) return { ok: false, reason: 'detachFailed' };
    }
    const att = await attachMagazine({ actor, weaponItem: w, block });
    if (!att.ok) return att;
    return _maybeBoltAfterReload({ actor, weaponItem: w, block });
  }
  const load = await loadBlock({ actor, weaponItem: w, block, count: Infinity });
  if (!load.ok) return load;
  return _maybeBoltAfterReload({ actor, weaponItem: w, block });
}

/* ================================================================== *
 *  Shot consumption                                                   *
 * ================================================================== */

/**
 * Apply charge changePerShot to a live battery Item and persist.
 *
 * @param {Item} item
 * @param {{ammoCost?: number}} [opts]
 * @returns {Promise<{ok: boolean, battery: object|null, spent: number, overheated: boolean, scaleDamageFromSpent: boolean}>}
 */
async function _spendBatteryOnLiveItem(item, opts = {}) {
  if (!item) {
    return { ok: false, battery: null, spent: 0, overheated: false, scaleDamageFromSpent: false };
  }
  const ammoCost = Math.max(1, Math.floor(Number(opts.ammoCost) || 1));
  const cfg = _ammoConfigOf(item);
  if (!cfg.charge.enabled) {
    return {
      ok: true,
      battery: _itemPlainObject(item),
      spent: 1,
      overheated: false,
      scaleDamageFromSpent: false,
    };
  }

  const charge = {
    ...cfg.charge,
    ...(item.system?.weapon?.ammo?.charge ?? {}),
    enabled: true,
    changePerShot: normalizeChargeChange(
      item.system?.weapon?.ammo?.charge?.changePerShot ?? cfg.charge.changePerShot,
      { sign: '-', formula: '1' },
    ),
    changePerSecond: normalizeChargeChange(
      item.system?.weapon?.ammo?.charge?.changePerSecond ?? cfg.charge.changePerSecond,
      { sign: '+', formula: '0' },
    ),
  };

  const preview = computeChargeDelta({ charge, which: 'perShot', ammoCost });
  if (charge.current <= 0 && preview.delta < 0) {
    const have = _qty(item);
    if (have > 1) {
      await item.update({
        'system.quantity': have - 1,
        'system.weapon.ammo.charge.current': charge.max,
      }, { render: false });
      const fresh = actorItemFresh(item);
      return _spendBatteryOnLiveItem(fresh, opts);
    }
    if (cfg.consume) {
      await item.delete();
      return {
        ok: false,
        battery: null,
        spent: 0,
        overheated: false,
        scaleDamageFromSpent: false,
      };
    }
    return { ok: false, battery: null, spent: 0, overheated: false, scaleDamageFromSpent: false };
  }

  const res = applyChargeChange(charge, { which: 'perShot', ammoCost });
  if (!res.ok) {
    return { ok: false, battery: null, spent: 0, overheated: false, scaleDamageFromSpent: false };
  }
  await item.update({ 'system.weapon.ammo.charge': charge }, { render: false });
  return {
    ok: true,
    battery: _itemPlainObject(item),
    spent: Math.abs(res.applied),
    overheated: !!res.overheated,
    scaleDamageFromSpent: !!charge.scaleDamageFromSpent,
  };
}

function actorItemFresh(item) {
  const actor = item?.actor ?? item?.parent;
  if (actor?.items && item?.id) return actor.items.get(item.id) ?? item;
  return item;
}

/**
 * Spend from FIFO head of live content items (EXTERNAL_CHARGE reserve).
 * @param {Actor} actor
 * @param {object} block
 * @param {{ammoCost?: number}} [opts]
 */
async function _spendBatteryFromContentFifo(actor, block, opts = {}) {
  const rt = _ensureRuntime(block);
  rt.contentItemIds = (rt.contentItemIds ?? []).filter((id) => !!actor.items.get(String(id ?? '').trim()));
  while (rt.contentItemIds.length) {
    const headId = rt.contentItemIds[0];
    const head = actor.items.get(headId);
    if (!head) {
      rt.contentItemIds.shift();
      continue;
    }
    const cfg = _ammoConfigOf(head);
    if (!cfg.charge.enabled) {
      const round = await _consumeOneRoundFromStack(actor, block, head, rt.contentItemIds);
      return {
        ok: !!round,
        battery: round,
        spent: round ? 1 : 0,
        overheated: false,
        scaleDamageFromSpent: false,
      };
    }
    const spent = await _spendBatteryOnLiveItem(head, opts);
    if (!spent.ok && !actor.items.get(headId)) {
      // Head deleted (consumed empty) — advance FIFO.
      rt.contentItemIds = rt.contentItemIds.filter((id) => id !== headId);
      continue;
    }
    if (!spent.ok) return spent;
    return spent;
  }
  return { ok: false, battery: null, spent: 0, overheated: false, scaleDamageFromSpent: false };
}

/**
 * Consume one round unit from a live stack; returns plain object for damage.
 * Updates contentItemIds when the stack is removed.
 * @param {Actor} actor
 * @param {object} block
 * @param {Item} stack
 * @param {string[]} [fifoIds]
 * @returns {Promise<object|null>}
 */
async function _consumeOneRoundFromStack(actor, block, stack, fifoIds = null) {
  if (!stack) return null;
  const have = _qty(stack);
  if (have <= 0) return null;
  const plain = _itemPlainObject(stack);
  plain.system = plain.system ?? {};
  plain.system.quantity = 1;

  if (have > 1) {
    await stack.update({ 'system.quantity': have - 1 }, { render: false });
    return plain;
  }

  const id = stack.id;
  const hostId = String(stack.system?.containerHostId ?? '').trim();
  if (hostId) {
    const host = actor.items.get(hostId);
    if (host?.system?.itemTags?.isContainer) {
      await removeActorItemFromContainer(actor, host, id);
    }
  }
  await stack.delete();
  if (Array.isArray(fifoIds)) {
    const idx = fifoIds.indexOf(id);
    if (idx >= 0) fifoIds.splice(idx, 1);
  }
  const rt = block ? _ensureRuntime(block) : null;
  if (rt && Array.isArray(rt.contentItemIds)) {
    rt.contentItemIds = rt.contentItemIds.filter((x) => x !== id);
  }
  return plain;
}

function _snapshotBlockRuntime(block) {
  return _clone(block?.runtime ?? {});
}

function _restoreBlockRuntime(block, runtime) {
  if (block && runtime) block.runtime = _clone(runtime);
}

/**
 * Snapshot live item qty + charge for line-level rollback.
 * @param {Actor} actor
 * @param {object[]} blocks
 */
function _collectInvolvedItemSnapshots(actor, blocks) {
  /** @type {Map<string, {id: string, quantity: number, chargeCurrent: number|null, data: object}>} */
  const map = new Map();
  const add = (it) => {
    if (!it?.id || map.has(it.id)) return;
    const cfg = _ammoConfigOf(it);
    map.set(it.id, {
      id: it.id,
      quantity: _qty(it),
      chargeCurrent: cfg.charge?.enabled ? Math.max(0, Number(cfg.charge.current) || 0) : null,
      data: _itemPlainObject(it),
    });
  };
  for (const block of blocks) {
    const mag = getAttachedMagazineItem(actor, block);
    if (mag) {
      add(mag);
      for (const id of getOrderedDirectChildItemIds(actor, mag.id)) add(actor.items.get(id));
    }
    for (const it of getBlockContentItems(actor, block)) add(it);
    add(getChamberItem(actor, block));
  }
  return map;
}

/**
 * @param {Actor} actor
 * @param {Map<string, {id: string, quantity: number, chargeCurrent: number|null, data: object}>} snapshots
 * @param {Set<string>} createdIds items created during consume (splits) — delete on rollback
 */
async function _restoreInvolvedItems(actor, snapshots, createdIds = new Set()) {
  if (!actor) return;

  for (const id of createdIds) {
    const it = actor.items.get(id);
    if (it && !snapshots.has(id)) {
      try {
        await it.delete();
      } catch (_) {
        /* ignore */
      }
    }
  }

  const updates = [];
  const toCreate = [];
  for (const snap of snapshots.values()) {
    const it = actor.items.get(snap.id);
    if (it) {
      const patch = { _id: snap.id, 'system.quantity': snap.quantity };
      if (snap.chargeCurrent != null) {
        patch['system.weapon.ammo.charge.current'] = snap.chargeCurrent;
      }
      updates.push(patch);
    } else if (snap.data) {
      const data = _clone(snap.data);
      data._id = snap.id;
      toCreate.push(data);
    }
  }
  if (updates.length) {
    await actor.updateEmbeddedDocuments('Item', updates, { render: false });
  }
  if (toCreate.length) {
    try {
      await actor.createEmbeddedDocuments('Item', toCreate, { keepId: true, render: false });
    } catch (e) {
      console.warn('SpaceHolder | ammo rollback recreate failed', e);
      for (const data of toCreate) {
        try {
          delete data._id;
          await actor.createEmbeddedDocuments('Item', [data], { render: false });
        } catch (_) {
          /* ignore */
        }
      }
    }
  }
}

async function _preflightBlockShot(actor, block) {
  const readiness = blockShotReadiness(block, actor);
  if (!readiness.ready) return readiness;
  if (
    block.type === AMMO_BLOCK_TYPES.INTERNAL_MAGAZINE
    && block.capacity <= 0
    && !block.chamberEnabled
  ) {
    if (!_hasCompatibleAmmo(actor, block)) return { ready: false, reason: 'noAmmo' };
  }
  return { ready: true, reason: '' };
}

/**
 * Line-level shot preflight including on-the-fly ammo search.
 * @param {Actor|null} actor
 * @param {object} weapon
 * @param {string} lineId
 * @returns {Promise<{ready: boolean, reason?: string, blockId?: string}>}
 */
export async function preflightLineShotReadiness(actor, weapon, lineId) {
  const line = getWeaponLine(weapon, lineId);
  if (!line) return { ready: false, reason: 'noLine' };
  for (const block of line.ammoBlocks ?? []) {
    const r = await _preflightBlockShot(actor, block);
    if (!r.ready) return { ...r, blockId: block.id };
  }
  return { ready: true, reason: '' };
}

/**
 * Consume one shot from a single block. Mutates live Items + block runtime.
 *
 * @param {object} args
 * @param {Actor|null} args.actor
 * @param {Item|null} [args.weaponItem]
 * @param {object} args.block (mutated)
 * @param {number} [args.ammoCost=1]
 * @returns {Promise<{
 *   ok: boolean, reason?: string, round?: object|null, needsBolt?: boolean,
 *   spent?: number, overheated?: boolean, scaleDamageFromSpent?: boolean,
 *   createdItemIds?: string[],
 * }>}
 */
export async function consumeShotFromBlock({ actor, weaponItem = null, block, ammoCost = 1 }) {
  if (!block) return { ok: false, reason: 'noBlock' };
  const w = await _ensureLiveIfPossible(actor, weaponItem, block);
  const cost = Math.max(1, Math.floor(Number(ammoCost) || 1));
  const createdItemIds = [];

  // --- Internal charge -------------------------------------------------
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    if (block.chamberEnabled) {
      if (!block.runtime.chamberCharge) {
        return { ok: false, reason: block.runtime.charge > 0 ? 'needBolt' : 'noAmmo' };
      }
      block.runtime.chamberCharge = false;
      let needsBolt = false;
      if (block.autoFeed) needsBolt = !(await feedChamber({ actor, weaponItem: w, block }));
      else needsBolt = true;
      return { ok: true, round: null, needsBolt, spent: cost, createdItemIds };
    }
    if (block.runtime.charge < cost) return { ok: false, reason: 'noAmmo' };
    block.runtime.charge -= cost;
    return { ok: true, round: null, needsBolt: false, spent: cost, createdItemIds };
  }

  // --- External charge (battery) ---------------------------------------
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_CHARGE) {
    if (block.chamberEnabled) {
      const chamber = getChamberItem(actor, block);
      if (!chamber) {
        return { ok: false, reason: blockReserveCount(block, actor) > 0 ? 'needBolt' : 'noAmmo' };
      }
      const spent = await _spendBatteryOnLiveItem(chamber, { ammoCost: cost });
      if (!spent.ok) {
        if (!actor.items.get(chamber.id)) {
          _ensureRuntime(block).chamberItemId = '';
        }
        return { ok: false, reason: 'noAmmo', createdItemIds };
      }
      // Battery stays chambered; no bolt required between shots.
      return {
        ok: true,
        round: spent.battery,
        needsBolt: false,
        spent: spent.spent,
        overheated: spent.overheated,
        scaleDamageFromSpent: spent.scaleDamageFromSpent,
        createdItemIds,
      };
    }
    const spent = await _spendBatteryFromContentFifo(actor, block, { ammoCost: cost });
    if (!spent.ok) return { ok: false, reason: 'noAmmo', createdItemIds };
    return {
      ok: true,
      round: spent.battery,
      needsBolt: false,
      spent: spent.spent,
      overheated: spent.overheated,
      scaleDamageFromSpent: spent.scaleDamageFromSpent,
      createdItemIds,
    };
  }

  // --- Magazine types (internal / external) ----------------------------
  const rt = _ensureRuntime(block);
  if (block.chamberEnabled) {
    const chamber = getChamberItem(actor, block);
    if (!chamber) {
      return { ok: false, reason: blockReserveCount(block, actor) > 0 ? 'needBolt' : 'noAmmo' };
    }
    const round = await _consumeOneRoundFromStack(actor, block, chamber, null);
    rt.chamberItemId = '';
    rt.chamberItem = null;
    let needsBolt = false;
    if (block.autoFeed) needsBolt = !(await feedChamber({ actor, weaponItem: w, block }));
    else needsBolt = true;
    return { ok: true, round, needsBolt, createdItemIds };
  }

  // No chamber: take from reserve FIFO / magazine children / on-the-fly.
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_MAGAZINE && block.capacity <= 0) {
    const source = await pickAmmoCandidate(actor, {
      caliber: block.caliber,
      search: block.search,
      title: _t('SPACEHOLDER.WeaponV3.Ammo.PickTitle'),
    });
    if (!source) return { ok: false, reason: 'noAmmo', createdItemIds };
    const round = await _consumeOneRoundFromStack(actor, block, source, null);
    if (!round) return { ok: false, reason: 'noAmmo', createdItemIds };
    return { ok: true, round, needsBolt: false, createdItemIds };
  }

  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    const mag = getAttachedMagazineItem(actor, block);
    if (!mag) return { ok: false, reason: 'noMagazine', createdItemIds };
    const childIds = getOrderedDirectChildItemIds(actor, mag.id);
    if (!childIds.length) return { ok: false, reason: 'noAmmo', createdItemIds };
    const stack = actor.items.get(childIds[0]);
    const round = await _consumeOneRoundFromStack(actor, block, stack, null);
    if (!round) return { ok: false, reason: 'noAmmo', createdItemIds };
    return { ok: true, round, needsBolt: false, createdItemIds };
  }

  // internalMagazine / externalCharge without chamber already handled;
  // remaining: contentItemIds FIFO.
  rt.contentItemIds = (rt.contentItemIds ?? []).filter((id) => !!actor.items.get(String(id ?? '').trim()));
  if (!rt.contentItemIds.length) return { ok: false, reason: 'noAmmo', createdItemIds };
  const stack = actor.items.get(rt.contentItemIds[0]);
  const round = await _consumeOneRoundFromStack(actor, block, stack, rt.contentItemIds);
  if (!round) return { ok: false, reason: 'noAmmo', createdItemIds };
  return { ok: true, round, needsBolt: false, createdItemIds };
}

function _postOverheatChat(round, actor) {
  if (!round) return;
  const cfg = normalizeAmmoConfig(round.system?.weapon?.ammo);
  if (!cfg.charge?.overheatNotify) return;
  const name = String(round.name ?? cfg.caliber ?? 'ammo');
  const msg = _t('SPACEHOLDER.WeaponV3.Ammo.Overheat', { name });
  try {
    ChatMessage.create?.({
      speaker: actor ? ChatMessage.getSpeaker?.({ actor }) : {},
      content: `<p>${msg}</p>`,
      whisper: [],
    });
  } catch (e) {
    console.warn('SpaceHolder | overheat chat failed', e);
  }
}

/**
 * Consume one shot across ALL ammo blocks of a line («каждый блок
 * расходуется независимо; для выстрела должны быть доступны все»).
 *
 * Does NOT persist weapon data — mutates `weapon` + live Items;
 * the caller decides when to save the weapon document.
 *
 * @param {object} args
 * @param {Actor|null} args.actor
 * @param {object} args.weapon normalized weapon (mutated)
 * @param {Item|null} [args.weaponItem]
 * @param {string} args.lineId
 * @param {string} [args.modeId] active mode (for ammoCost)
 * @returns {Promise<{
 *   ok: boolean, reason?: string, blockId?: string,
 *   rounds: Array<{blockId: string, round: object|null, spent?: number}>,
 *   needsBolt: boolean,
 *   damageEntries: object[], payloadId: string,
 * }>}
 */
export async function consumeShotFromLine({ actor, weapon, weaponItem = null, lineId, modeId = '' }) {
  const line = getWeaponLine(weapon, lineId);
  if (!line) return { ok: false, reason: 'noLine', rounds: [], needsBolt: false, damageEntries: [], payloadId: '' };

  const mode = (line.modes ?? []).find((m) => m.id === modeId)
    ?? (line.modes ?? [])[0]
    ?? null;
  const ammoCost = Math.max(1, Math.floor(Number(mode?.ammoCost) || 1));

  const blocks = line.ammoBlocks ?? [];
  const w = weaponItem
    || (blocks[0] ? _findWeaponItemForBlock(actor, blocks[0]) : null)
    || null;

  for (const block of blocks) {
    if (actor && w) await ensureLiveBlockRuntime(actor, w, block);
    const readiness = await _preflightBlockShot(actor, block);
    if (!readiness.ready) {
      return { ok: false, reason: readiness.reason, blockId: block.id, rounds: [], needsBolt: false, damageEntries: [], payloadId: '' };
    }
  }

  const runtimeSnapshots = blocks.map((b) => _snapshotBlockRuntime(b));
  const itemSnapshots = actor ? _collectInvolvedItemSnapshots(actor, blocks) : new Map();
  const createdIds = new Set();

  const rounds = [];
  let needsBolt = false;
  let scaledSpent = null;
  for (const block of blocks) {
    const beforeIds = new Set(Array.from(actor?.items ?? []).map((it) => it.id));
    const res = await consumeShotFromBlock({ actor, weaponItem: w, block, ammoCost });
    if (actor) {
      for (const it of actor.items) {
        if (!beforeIds.has(it.id)) createdIds.add(it.id);
      }
    }
    if (Array.isArray(res.createdItemIds)) {
      for (const id of res.createdItemIds) createdIds.add(id);
    }
    if (!res.ok) {
      for (let i = 0; i < blocks.length; i++) {
        _restoreBlockRuntime(blocks[i], runtimeSnapshots[i]);
      }
      await _restoreInvolvedItems(actor, itemSnapshots, createdIds);
      return { ok: false, reason: res.reason, blockId: block.id, rounds, needsBolt: false, damageEntries: [], payloadId: '' };
    }
    rounds.push({
      blockId: block.id,
      round: res.round ?? null,
      spent: res.spent ?? 0,
    });
    needsBolt = needsBolt || !!res.needsBolt;
    if (res.overheated) _postOverheatChat(res.round, actor);
    if (res.scaleDamageFromSpent && scaledSpent == null && (res.spent ?? 0) > 0) {
      scaledSpent = res.spent;
    }
  }

  // Active damage source: first block (by order) that yields damage —
  // either the consumed round's own damage or the block damage sub-block.
  let damageEntries = [];
  let payloadId = String(line.payloadId ?? '').trim();
  let damageFromMagazineRound = false;
  for (const block of blocks) {
    const consumedRound = rounds.find((r) => r.blockId === block.id)?.round ?? null;
    if (consumedRound) {
      const ammoCfg = normalizeAmmoConfig(consumedRound.system?.weapon?.ammo);
      const fromRound = activeDamageEntries(ammoCfg.damage);
      const isChargeBlock = block.type === AMMO_BLOCK_TYPES.EXTERNAL_CHARGE
        || block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE;
      if (!isChargeBlock && fromRound.length) {
        damageEntries = fromRound;
        damageFromMagazineRound = true;
        const roundPayload = fromRound.find((e) => e.payloadId)?.payloadId ?? '';
        if (roundPayload) payloadId = roundPayload;
        break;
      }
    }
    const fromBlock = activeDamageEntries(block.damage);
    if (fromBlock.length) {
      damageEntries = fromBlock;
      break;
    }
  }
  // No blocks at all (or none provided damage) → weapon-side line damage.
  if (!damageEntries.length) damageEntries = activeDamageEntries(line.damage);

  // LASS-style: damage equals charge spent — only when shot damage is not from a magazine round.
  if (!damageFromMagazineRound && scaledSpent != null && scaledSpent > 0) {
    if (damageEntries.length) {
      damageEntries = damageEntries.map((e) => ({ ...e, damage: scaledSpent }));
    } else {
      damageEntries = [{
        enabled: true,
        damageType: 'energy',
        damage: scaledSpent,
        armorPen: 100,
        hardness: 1,
        armorDamageFactor: 100,
        armorDamageReduction: 100,
        speed: 0,
        payloadId: '',
      }];
    }
  }

  return { ok: true, rounds, needsBolt, damageEntries, payloadId };
}

/**
 * Line-level readiness summary used by the attack chain builder.
 * @param {object} weapon
 * @param {string} lineId
 * @param {Actor|null} [actor]
 * @returns {{ready: boolean, blocks: Array<{blockId:string, ready:boolean, reason:string}>}}
 */
export function lineShotReadiness(weapon, lineId, actor = null) {
  const line = getWeaponLine(weapon, lineId);
  const blocks = (line?.ammoBlocks ?? []).map((b) => {
    const r = blockShotReadiness(b, actor);
    return { blockId: b.id, ready: r.ready, reason: r.reason };
  });
  return { ready: blocks.every((b) => b.ready), blocks };
}

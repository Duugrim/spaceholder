/**
 * Weapon v3 ammo runtime — per-block pseudo-inventories (FIFO), chamber,
 * bolt, reload actions and shot consumption.
 *
 * Each ammo block of a weapon line owns its runtime state inside
 * `weapon.lines[i].ammoBlocks[j].runtime`:
 *   - internalCharge:   { charge, chamberCharge }
 *   - internalMagazine: { contents: [snapshot…], chamberItem }
 *   - externalCharge:   { contents: [battery snapshots…], chamberItem }
 *   - externalMagazine: { magazine: containerSnapshot, chamberItem }
 *
 * Item snapshots reuse the nested-storage record shape
 * (`snapshotItemForNestedStorage`), so magazine containers keep their own
 * FIFO inside `snapshot.system.storage.contents`.
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
  snapshotItemForNestedStorage,
  normalizeNestedStorage,
} from '../item-nested-storage.mjs';

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

/** Number of rounds currently in the block reserve (without chamber). */
export function blockReserveCount(block) {
  if (!block) return 0;
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) return Math.max(0, Number(block.runtime?.charge) || 0);
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    const mag = block.runtime?.magazine;
    const contents = Array.isArray(mag?.system?.storage?.contents) ? mag.system.storage.contents : [];
    return contents.reduce((sum, e) => sum + _qty(e), 0);
  }
  return (block.runtime?.contents ?? []).reduce((sum, e) => sum + _qty(e), 0);
}

/** Whether the chamber currently holds a round/charge. */
export function blockChamberLoaded(block) {
  if (!block?.chamberEnabled) return false;
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) return !!block.runtime?.chamberCharge;
  return !!block.runtime?.chamberItem;
}

/**
 * Load limit rule: `reserve + chamber < N + (chamber enabled ? 1 : 0)`.
 * @param {object} block
 */
export function blockCanLoadMore(block) {
  const reserve = blockReserveCount(block);
  const chamber = blockChamberLoaded(block) ? 1 : 0;
  const cap = resolveBlockCapacity(block) + (block?.chamberEnabled ? 1 : 0);
  return reserve + chamber < cap;
}

/** Free reserve slots (chamber excluded; chamber surplus allowed). */
export function blockReserveFreeSlots(block) {
  const reserve = blockReserveCount(block);
  return Math.max(0, resolveBlockCapacity(block) - reserve);
}

/**
 * Block readiness for one shot: chamber round when chamber enabled,
 * otherwise non-empty reserve. `N = 0` + chamber off → on-the-fly search
 * (reported as ready; the actual search happens at consumption).
 * @param {object} block
 * @returns {{ready: boolean, reason: string}}
 */
export function blockShotReadiness(block) {
  if (!block) return { ready: false, reason: 'noBlock' };
  if (block.chamberEnabled) {
    return blockChamberLoaded(block)
      ? { ready: true, reason: '' }
      : { ready: false, reason: blockReserveCount(block) > 0 ? 'needBolt' : 'needReload' };
  }
  if (block.capacity <= 0 && block.type === AMMO_BLOCK_TYPES.INTERNAL_MAGAZINE) {
    return { ready: true, reason: 'onTheFly' };
  }
  return blockReserveCount(block) > 0
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
  if (blockReserveFreeSlots(block) <= 0) return false;
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) return blockCanLoadMore(block);
  return _hasCompatibleAmmo(actor, block);
}

/** @returns {boolean} */
export function canLoadX(actor, block) {
  if (!block?.apActions?.loadX?.enabled) return false;
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) return false;
  const x = Math.max(0, Number(block.loadAmount) || 0);
  if (x <= 0) return false;
  if (blockReserveFreeSlots(block) <= 0) return false;
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) return blockCanLoadMore(block);
  return _hasCompatibleAmmo(actor, block);
}

/** @returns {boolean} */
export function canReloadBlock(actor, block) {
  if (!block?.apActions?.reload?.enabled) return false;
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    return _hasCompatibleMagazine(actor, block);
  }
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    return blockReserveCount(block) < resolveBlockCapacity(block);
  }
  if (blockReserveFreeSlots(block) <= 0) return false;
  return _hasCompatibleAmmo(actor, block);
}

/** @returns {boolean} */
export function canBoltBlock(block) {
  if (!block?.apActions?.bolt?.enabled || !block.chamberEnabled) return false;
  if (blockChamberLoaded(block)) return true;
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    return (block.runtime?.charge ?? 0) > 0;
  }
  return blockReserveCount(block) > 0;
}

/** @returns {boolean} */
export function canUnloadBlock(block) {
  if (!block?.apActions?.unload?.enabled) return false;
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) return false;
  return blockReserveCount(block) > 0;
}

/** @returns {boolean} */
export function canEmptyBlock(block) {
  if (!block?.apActions?.empty?.enabled) return false;
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    return !!block.runtime?.magazine || blockChamberLoaded(block);
  }
  return blockReserveCount(block) > 0 || blockChamberLoaded(block);
}

/** @returns {boolean} */
export function canAttachMagazine(actor, block) {
  if (block?.type !== AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) return false;
  if (block.runtime?.magazine) return false;
  return _hasCompatibleMagazine(actor, block);
}

/** @returns {boolean} */
export function canDetachMagazine(block) {
  return block?.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE && !!block.runtime?.magazine;
}

async function _maybeBoltAfterReload({ actor, block }) {
  if (!block?.chamberEnabled || blockChamberLoaded(block)) return { ok: true };
  return operateBolt({ actor, block });
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

/**
 * Search the actor inventory for compatible ammo items, grouped by priority:
 * held → worn containers → loose inventory → containers in inventory.
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
 * Take `count` units from an actor item into a snapshot (decrement/delete).
 * @param {Item} item
 * @param {number} count
 * @returns {Promise<object|null>} snapshot with quantity = taken
 */
async function _takeFromActorItem(item, count = 1) {
  const have = _qty(item);
  const take = Math.min(have, Math.max(1, Math.floor(count)));
  if (take <= 0) return null;
  const snapshot = snapshotItemForNestedStorage(item);
  snapshot.system.quantity = take;
  if (have > take) await item.update({ 'system.quantity': have - take });
  else await item.delete();
  return snapshot;
}

/**
 * Return a snapshot back to the actor inventory as a held item (used by
 * unload/empty: «разрядка кладёт патроны в инвентарь как удерживаемые»).
 * @param {Actor} actor
 * @param {object} snapshot
 * @param {{held?: boolean}} [opts]
 */
async function _giveSnapshotToActor(actor, snapshot, { held = true } = {}) {
  if (!actor || !snapshot) return null;
  const data = _clone(snapshot);
  delete data.id;
  delete data.sourceUuid;
  data.system = data.system ?? {};
  data.system.held = held;
  data.system.equipped = false;
  data.system.containerHostId = '';
  const created = await actor.createEmbeddedDocuments('Item', [data]);
  return created?.[0] ?? null;
}

/**
 * Eject a chambered round. Per ТЗ the round drops to the ground for
 * magazine-fed blocks; MVP returns it to the actor inventory (not held)
 * and reports it in chat/notification. Internal charge is simply lost.
 * @param {Actor} actor
 * @param {object} snapshot
 */
async function _ejectRoundToGround(actor, snapshot) {
  if (!actor || !snapshot) return;
  await _giveSnapshotToActor(actor, snapshot, { held: false });
  ui.notifications?.info?.(_t('SPACEHOLDER.WeaponV3.Ammo.RoundEjected', { name: snapshot.name ?? '' }));
}

/* ================================================================== *
 *  FIFO helpers on snapshots                                          *
 * ================================================================== */

/** Pop one unit from the head of a FIFO snapshot list. Mutates the list. */
function _fifoTakeOne(contents) {
  if (!Array.isArray(contents) || !contents.length) return null;
  const head = contents[0];
  const have = _qty(head);
  const taken = _clone(head);
  taken.system.quantity = 1;
  if (have > 1) head.system.quantity = have - 1;
  else contents.shift();
  return taken;
}

/** Push a snapshot onto the FIFO tail, stacking with the last entry when identical. */
function _fifoPush(contents, snapshot, maxReserve = Infinity) {
  if (!Array.isArray(contents) || !snapshot) return false;
  const cap = Math.max(0, Math.floor(Number(maxReserve) || 0));
  if (Number.isFinite(cap) && cap > 0) {
    const current = contents.reduce((sum, e) => sum + _qty(e), 0);
    const add = _qty(snapshot);
    if (current + add > cap) return false;
  }
  const last = contents[contents.length - 1];
  if (
    last &&
    last.name === snapshot.name &&
    last.sourceUuid === snapshot.sourceUuid &&
    JSON.stringify(last.system?.weapon?.ammo ?? null) === JSON.stringify(snapshot.system?.weapon?.ammo ?? null)
  ) {
    last.system.quantity = _qty(last) + _qty(snapshot);
    return true;
  }
  contents.push(snapshot);
  return true;
}

function _blockFifo(block) {
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    const mag = block.runtime?.magazine;
    if (!mag) return null;
    mag.system = mag.system ?? {};
    mag.system.storage = normalizeNestedStorage(mag.system.storage);
    return mag.system.storage.contents;
  }
  if (!Array.isArray(block.runtime.contents)) block.runtime.contents = [];
  return block.runtime.contents;
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
 * @param {object} args.block normalized ammo block (mutated)
 * @returns {Promise<{ok: boolean, reason?: string, changed: boolean}>}
 */
export async function operateBolt({ actor, block }) {
  if (!block?.chamberEnabled) return { ok: false, reason: 'noChamber', changed: false };

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

  if (block.runtime.chamberItem) {
    const ejected = block.runtime.chamberItem;
    block.runtime.chamberItem = null;
    await _ejectRoundToGround(actor, ejected);
    return { ok: true, changed: true };
  }
  const fifo = _blockFifo(block);
  if (!fifo) return { ok: false, reason: 'noMagazine', changed: false };
  const taken = _fifoTakeOne(fifo);
  if (!taken) return { ok: false, reason: 'reserveEmpty', changed: false };
  block.runtime.chamberItem = taken;
  return { ok: true, changed: true };
}

/**
 * Feed the chamber from the reserve without ejecting (used by auto-feed
 * after a shot, and after reload when the chamber is empty).
 * @param {object} block
 * @returns {boolean} true when a round was chambered
 */
export function feedChamber(block) {
  if (!block?.chamberEnabled || blockChamberLoaded(block)) return false;
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    if (block.runtime.charge <= 0) return false;
    block.runtime.charge -= 1;
    block.runtime.chamberCharge = true;
    return true;
  }
  const fifo = _blockFifo(block);
  if (!fifo) return false;
  const taken = _fifoTakeOne(fifo);
  if (!taken) return false;
  block.runtime.chamberItem = taken;
  return true;
}

/**
 * Load up to `count` rounds into the block reserve from the actor inventory
 * (item-fed blocks) or as plain charges (internal charge).
 *
 * @param {object} args
 * @param {Actor|null} args.actor
 * @param {object} args.block (mutated)
 * @param {number} args.count rounds to add; Infinity → fill to capacity
 * @returns {Promise<{ok: boolean, loaded: number, reason?: string}>}
 */
export async function loadBlock({ actor, block, count = 1 }) {
  if (!block) return { ok: false, loaded: 0, reason: 'noBlock' };
  const free = blockReserveFreeSlots(block);
  const want = Math.min(free, Math.max(0, Math.floor(Number(count) === Infinity ? free : count)));
  if (want <= 0) return { ok: false, loaded: 0, reason: 'full' };

  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    block.runtime.charge += want;
    return { ok: true, loaded: want };
  }

  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE && !block.runtime.magazine) {
    return { ok: false, loaded: 0, reason: 'noMagazine' };
  }

  const fifo = _blockFifo(block);
  if (!fifo) return { ok: false, loaded: 0, reason: 'noMagazine' };

  let loaded = 0;
  while (loaded < want) {
    const source = await pickAmmoCandidate(actor, {
      caliber: block.caliber,
      search: block.search,
      title: _t('SPACEHOLDER.WeaponV3.Ammo.PickTitle'),
    });
    if (!source) break;
    const batch = Math.min(want - loaded, _qty(source));
    const snapshot = await _takeFromActorItem(source, batch);
    if (!snapshot) break;
    const cap = resolveBlockCapacity(block);
    if (!_fifoPush(fifo, snapshot, cap)) break;
    loaded += _qty(snapshot);
  }
  if (loaded <= 0) return { ok: false, loaded: 0, reason: 'noAmmoFound' };
  return { ok: true, loaded };
}

/**
 * «Разрядить»: move the whole reserve back to the actor inventory (held);
 * chamber untouched. Internal charge → reserve to 0.
 * @returns {Promise<{ok: boolean, unloaded: number}>}
 */
export async function unloadBlock({ actor, block }) {
  if (!block) return { ok: false, unloaded: 0 };
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    const had = block.runtime.charge;
    block.runtime.charge = 0;
    return { ok: true, unloaded: had };
  }
  const fifo = _blockFifo(block);
  if (!fifo) return { ok: false, unloaded: 0 };
  let unloaded = 0;
  for (const snapshot of fifo.splice(0, fifo.length)) {
    unloaded += _qty(snapshot);
    await _giveSnapshotToActor(actor, snapshot, { held: true });
  }
  return { ok: true, unloaded };
}

/**
 * «Опустошить»: составное действие — снять магазин / разрядить резерв,
 * затем затвор для очистки патронника (если включён).
 * @returns {Promise<{ok: boolean, unloaded: number}>}
 */
export async function emptyBlock({ actor, block }) {
  if (!block) return { ok: false, unloaded: 0 };
  let unloaded = 0;
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    if (block.runtime?.magazine) {
      unloaded += blockReserveCount(block);
      const det = await detachMagazine({ actor, block });
      if (!det.ok) return { ok: false, unloaded: 0 };
    }
  } else {
    const res = await unloadBlock({ actor, block });
    if (!res.ok) return res;
    unloaded = res.unloaded;
  }
  if (block.chamberEnabled && blockChamberLoaded(block)) {
    const bolt = await operateBolt({ actor, block });
    if (bolt.ok) unloaded += 1;
  }
  return { ok: true, unloaded };
}

/**
 * Attach a magazine container item to an external-magazine block.
 * @param {object} args
 * @param {Actor|null} args.actor
 * @param {object} args.block (mutated)
 * @param {Item} [args.magazineItem] explicit item; otherwise searched/picked
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function attachMagazine({ actor, block, magazineItem = null }) {
  if (block?.type !== AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) return { ok: false, reason: 'wrongBlockType' };
  if (block.runtime.magazine) return { ok: false, reason: 'alreadyAttached' };
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
  const snapshot = await _takeFromActorItem(source, 1);
  if (!snapshot) return { ok: false, reason: 'noMagazineFound' };
  block.runtime.magazine = snapshot;
  return { ok: true };
}

/**
 * Detach the magazine container back to the actor inventory.
 * @param {object} args
 * @param {Actor|null} args.actor
 * @param {object} args.block
 * @param {boolean} [args.held=true]
 * @returns {Promise<{ok: boolean}>}
 */
export async function detachMagazine({ actor, block, held = true }) {
  if (block?.type !== AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE || !block.runtime.magazine) return { ok: false };
  await _giveSnapshotToActor(actor, block.runtime.magazine, { held });
  block.runtime.magazine = null;
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
export async function reloadBlock({ actor, block }) {
  if (!block) return { ok: false, reason: 'noBlock' };
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    if (block.runtime?.magazine) {
      const detachedMagIsEmpty = blockReserveCount(block) <= 0;
      const det = await detachMagazine({ actor, block, held: !detachedMagIsEmpty });
      if (!det.ok) return { ok: false, reason: 'detachFailed' };
    }
    const att = await attachMagazine({ actor, block });
    if (!att.ok) return att;
    return _maybeBoltAfterReload({ actor, block });
  }
  const load = await loadBlock({ actor, block, count: Infinity });
  if (!load.ok) return load;
  return _maybeBoltAfterReload({ actor, block });
}

/* ================================================================== *
 *  Shot consumption                                                   *
 * ================================================================== */

/**
 * Spend the battery charge of a battery snapshot per «Заряд» rules:
 * decrement `charge.current`; at zero, spend 1 quantity (and drop the item
 * from the FIFO when quantity hits zero and «Трата» is on), the next item
 * starts with a full charge.
 *
 * @param {object[]} fifo battery FIFO (mutated)
 * @returns {{ok: boolean, battery: object|null}}
 */
function _spendBatteryCharge(fifo) {
  while (fifo.length) {
    const head = fifo[0];
    const cfg = _ammoConfigOf(head);
    if (!cfg.charge.enabled) {
      // Battery without charge mechanics → behaves like a plain consumable.
      const taken = _fifoTakeOne(fifo);
      return { ok: !!taken, battery: taken };
    }
    head.system.weapon = head.system.weapon ?? {};
    head.system.weapon.ammo = head.system.weapon.ammo ?? {};
    const charge = head.system.weapon.ammo.charge ?? { enabled: true, max: cfg.charge.max, current: cfg.charge.current };
    let current = Math.max(0, Math.floor(Number(charge.current) || 0));
    if (current <= 0) {
      // Empty battery unit: consume 1 quantity, refill next unit.
      const have = _qty(head);
      if (have > 1) {
        head.system.quantity = have - 1;
        head.system.weapon.ammo.charge = { ...charge, current: cfg.charge.max };
        continue;
      }
      if (cfg.consume) fifo.shift();
      else {
        // Keep the empty container in place but it cannot fire.
        return { ok: false, battery: null };
      }
      continue;
    }
    current -= 1;
    head.system.weapon.ammo.charge = { ...charge, current };
    if (current <= 0 && _qty(head) <= 1 && cfg.consume) {
      // Last unit just emptied: it will be dropped on the next spend attempt;
      // keep it for now so the UI can show 0 charge.
    }
    return { ok: true, battery: _clone(head) };
  }
  return { ok: false, battery: null };
}

/**
 * Spend one charge unit from a single battery snapshot (chamber-held).
 * @param {object} snapshot mutated battery snapshot
 * @returns {{ok: boolean, battery: object|null}}
 */
function _spendBatteryFromSnapshot(snapshot) {
  if (!snapshot) return { ok: false, battery: null };
  const cfg = _ammoConfigOf(snapshot);
  if (!cfg.charge.enabled) {
    return { ok: true, battery: _clone(snapshot) };
  }
  snapshot.system = snapshot.system ?? {};
  snapshot.system.weapon = snapshot.system.weapon ?? {};
  snapshot.system.weapon.ammo = snapshot.system.weapon.ammo ?? {};
  const charge = snapshot.system.weapon.ammo.charge ?? {
    enabled: true,
    max: cfg.charge.max,
    current: cfg.charge.current,
  };
  let current = Math.max(0, Math.floor(Number(charge.current) || 0));
  if (current <= 0) return { ok: false, battery: null };
  current -= 1;
  snapshot.system.weapon.ammo.charge = { ...charge, current };
  return { ok: true, battery: _clone(snapshot) };
}

function _snapshotBlockRuntime(block) {
  return _clone(block?.runtime ?? {});
}

function _restoreBlockRuntime(block, runtime) {
  if (block && runtime) block.runtime = _clone(runtime);
}

async function _preflightBlockShot(actor, block) {
  const readiness = blockShotReadiness(block);
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
 * Consume one shot from a single block. Mutates the block runtime.
 *
 * @param {object} args
 * @param {Actor|null} args.actor
 * @param {object} args.block (mutated)
 * @returns {Promise<{ok: boolean, reason?: string, round?: object|null, needsBolt?: boolean}>}
 *   `round` — the consumed item snapshot (magazine types) or null.
 *   `needsBolt` — chamber emptied and auto-feed missing/failed.
 */
export async function consumeShotFromBlock({ actor, block }) {
  if (!block) return { ok: false, reason: 'noBlock' };

  // --- Internal charge -------------------------------------------------
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    if (block.chamberEnabled) {
      if (!block.runtime.chamberCharge) {
        return { ok: false, reason: block.runtime.charge > 0 ? 'needBolt' : 'noAmmo' };
      }
      block.runtime.chamberCharge = false;
      let needsBolt = false;
      if (block.autoFeed) needsBolt = !feedChamber(block);
      else needsBolt = true;
      return { ok: true, round: null, needsBolt };
    }
    if (block.runtime.charge <= 0) return { ok: false, reason: 'noAmmo' };
    block.runtime.charge -= 1;
    return { ok: true, round: null, needsBolt: false };
  }

  // --- External charge (battery) ---------------------------------------
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_CHARGE) {
    if (block.chamberEnabled) {
      if (!block.runtime.chamberItem) {
        return { ok: false, reason: blockReserveCount(block) > 0 ? 'needBolt' : 'noAmmo' };
      }
      const spent = _spendBatteryFromSnapshot(block.runtime.chamberItem);
      if (!spent.ok) {
        block.runtime.chamberItem = null;
        return { ok: false, reason: 'noAmmo' };
      }
      let needsBolt = false;
      if (block.autoFeed) needsBolt = !feedChamber(block);
      else needsBolt = true;
      return { ok: true, round: spent.battery, needsBolt };
    }
    const fifo = _blockFifo(block);
    if (!fifo || !fifo.length) return { ok: false, reason: 'noAmmo' };
    const spent = _spendBatteryCharge(fifo);
    if (!spent.ok) return { ok: false, reason: 'noAmmo' };
    return { ok: true, round: spent.battery, needsBolt: false };
  }

  // --- Magazine types (internal / external) ----------------------------
  if (block.chamberEnabled) {
    if (!block.runtime.chamberItem) {
      return { ok: false, reason: blockReserveCount(block) > 0 ? 'needBolt' : 'noAmmo' };
    }
    const round = block.runtime.chamberItem;
    block.runtime.chamberItem = null;
    let needsBolt = false;
    if (block.autoFeed) needsBolt = !feedChamber(block);
    else needsBolt = true;
    return { ok: true, round, needsBolt };
  }

  // No chamber: take from the FIFO head directly.
  const fifo = _blockFifo(block);
  if (block.type === AMMO_BLOCK_TYPES.INTERNAL_MAGAZINE && block.capacity <= 0) {
    // «Лук»: round is searched and consumed on the fly.
    const source = await pickAmmoCandidate(actor, {
      caliber: block.caliber,
      search: block.search,
      title: _t('SPACEHOLDER.WeaponV3.Ammo.PickTitle'),
    });
    if (!source) return { ok: false, reason: 'noAmmo' };
    const snapshot = await _takeFromActorItem(source, 1);
    if (!snapshot) return { ok: false, reason: 'noAmmo' };
    return { ok: true, round: snapshot, needsBolt: false };
  }
  if (!fifo) return { ok: false, reason: block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE ? 'noMagazine' : 'noAmmo' };
  const round = _fifoTakeOne(fifo);
  if (!round) return { ok: false, reason: 'noAmmo' };
  return { ok: true, round, needsBolt: false };
}

/**
 * Consume one shot across ALL ammo blocks of a line («каждый блок
 * расходуется независимо; для выстрела должны быть доступны все»).
 *
 * Does NOT persist — mutates `weapon`; the caller decides when to save.
 *
 * @param {object} args
 * @param {Actor|null} args.actor
 * @param {object} args.weapon normalized weapon (mutated)
 * @param {string} args.lineId
 * @returns {Promise<{
 *   ok: boolean, reason?: string, blockId?: string,
 *   rounds: Array<{blockId: string, round: object|null}>,
 *   needsBolt: boolean,
 *   damageEntries: object[], payloadId: string,
 * }>}
 */
export async function consumeShotFromLine({ actor, weapon, lineId }) {
  const line = getWeaponLine(weapon, lineId);
  if (!line) return { ok: false, reason: 'noLine', rounds: [], needsBolt: false, damageEntries: [], payloadId: '' };

  const blocks = line.ammoBlocks ?? [];

  for (const block of blocks) {
    const readiness = await _preflightBlockShot(actor, block);
    if (!readiness.ready) {
      return { ok: false, reason: readiness.reason, blockId: block.id, rounds: [], needsBolt: false, damageEntries: [], payloadId: '' };
    }
  }

  const runtimeSnapshots = blocks.map((b) => _snapshotBlockRuntime(b));

  const rounds = [];
  let needsBolt = false;
  for (const block of blocks) {
    const res = await consumeShotFromBlock({ actor, block });
    if (!res.ok) {
      for (let i = 0; i < blocks.length; i++) {
        _restoreBlockRuntime(blocks[i], runtimeSnapshots[i]);
      }
      return { ok: false, reason: res.reason, blockId: block.id, rounds, needsBolt: false, damageEntries: [], payloadId: '' };
    }
    rounds.push({ blockId: block.id, round: res.round ?? null });
    needsBolt = needsBolt || !!res.needsBolt;
  }

  // Active damage source: first block (by order) that yields damage —
  // either the consumed round's own damage or the block damage sub-block.
  let damageEntries = [];
  let payloadId = String(line.payloadId ?? '').trim();
  for (const block of blocks) {
    const consumedRound = rounds.find((r) => r.blockId === block.id)?.round ?? null;
    if (consumedRound) {
      const ammoCfg = normalizeAmmoConfig(consumedRound.system?.weapon?.ammo);
      const fromRound = activeDamageEntries(ammoCfg.damage);
      const isChargeBlock = block.type === AMMO_BLOCK_TYPES.EXTERNAL_CHARGE;
      if (!isChargeBlock && fromRound.length) {
        damageEntries = fromRound;
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

  return { ok: true, rounds, needsBolt, damageEntries, payloadId };
}

/**
 * Line-level readiness summary used by the attack chain builder.
 * @param {object} weapon
 * @param {string} lineId
 * @returns {{ready: boolean, blocks: Array<{blockId:string, ready:boolean, reason:string}>}}
 */
export function lineShotReadiness(weapon, lineId) {
  const line = getWeaponLine(weapon, lineId);
  const blocks = (line?.ammoBlocks ?? []).map((b) => {
    const r = blockShotReadiness(b);
    return { blockId: b.id, ready: r.ready, reason: r.reason };
  });
  return { ready: blocks.every((b) => b.ready), blocks };
}

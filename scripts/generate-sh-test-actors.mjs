/**
 * Build actor JSON sources for the `sh-test-actors` compendium (Test4 weapon rigs).
 *
 * Reads humanoid anatomy from `data/anatomy/humanoid.json` and embeds Test4 weapons,
 * ammo and magazines from `pack-src/sh-test-items/SH_Test4_*`.
 *
 * Actors:
 *  - Стрелок          — full arsenal
 *  - Тест: бастард    — bastard sword held
 *  - Тест: M-1d       — rifle + mag + ammo (not attached)
 *  - Тест: M-1d (готов) — mag chambered, readied
 *  - Тест: LASS       — laser + battery + heat sink installed
 *  - Тест: лук        — bow + arrows
 *  - Тест: жезл       — wand + crystal installed
 *  - Тест: SIMP-13    — plasma internal charge
 *  - Тест: патронташ  — bandolier equipped + ammo inside
 *  - Мишень           — single-part target dummy
 *
 * Usage:
 *   npm run generate:sh-test-actors
 *   npm run pack:sh-test-actors   (Foundry closed)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const anatomyDir = path.join(root, 'data', 'anatomy');
const itemSrcDir = path.join(root, 'pack-src', 'sh-test-items');
const outDir = path.join(root, 'pack-src', 'sh-test-actors');

const SYSTEM_VERSION = readSystemVersion();
const CORE_VERSION = '13.350';
const CREATED_TIME = 1781100000000;

const TARGET_ID = 'shtesttarget0000';

/** Test4 items in pack-src (basename without .json). */
const T4 = {
  sword: 'SH_Test4_Bastard_Sword_shtest4sword00',
  simp: 'SH_Test4_SIMP13_shtest4simp1300',
  wand: 'SH_Test4_Wind_Wand_shtest4wand000',
  crystal: 'SH_Test4_Crystal_shtest4crystal0',
  lass: 'SH_Test4_LASS_shtest4lass000',
  battery: 'SH_Test4_Battery_shtest4batt000',
  fusion: 'SH_Test4_Fusion_Batt_shtest4fusion0',
  heat: 'SH_Test4_Heat_Sink_shtest4heat000',
  m1d: 'SH_Test4_M1d_shtest4m1d0000',
  magM1d: 'SH_Test4_Mag_M1d_shtest4magm1d0',
  ammo545: 'SH_Test4_Ammo_545_shtest4ammo545',
  bow: 'SH_Test4_Bow_shtest4bow0000',
  arrow: 'SH_Test4_Arrow_shtest4arrow00',
  arrowExpl: 'SH_Test4_Arrow_Expl_shtest4arrexp',
  arrowPoison: 'SH_Test4_Arrow_Poison_shtest4arrpoi',
  arrowSmoke: 'SH_Test4_Arrow_Smoke_shtest4arrsmk',
  grenade: 'SH_Test4_Grenade_shtest4grenade',
  reil: 'SH_Test4_Reil_Guffin_shtest4reil000',
  railSlug: 'SH_Test4_Rail_Slug_shtest4railslg',
  magRail: 'SH_Test4_Mag_Rail_shtest4magrail',
  lube: 'SH_Test4_Lubricant_shtest4lube000',
  barrel: 'SH_Test4_Barrel_shtest4barrel0',
  bandolier: 'SH_Test4_Bandolier_shtest4bandol',
};

// ---------- Anatomy normalization (mirrors AnatomyManager) -------------------

function stableUuid(actorId, slotRef) {
  return `${actorId}-bp-${slotRef.replace('#', '-')}`;
}

function coerceCoord(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function sanitizeExposure(raw) {
  const dirs = ['front', 'right', 'back', 'left'];
  const out = {};
  for (const d of dirs) {
    const n = Number(raw?.[d]);
    out[d] = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  }
  return out;
}

function dedupeRelations(rels) {
  const seen = new Set();
  const out = [];
  for (const r of rels) {
    if (!r || !r.kind || !r.target) continue;
    const key = `${r.kind}|${r.target}|${r.direction ?? ''}|${r.chance ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function buildActorBodyParts(rawBodyParts, actorId) {
  const out = {};
  const idCounters = new Map();
  const rawKeyToSlotRef = {};

  for (const [rawKey, rawPart] of Object.entries(rawBodyParts)) {
    if (!rawPart || typeof rawPart !== 'object') continue;
    const typeId = String(rawPart.id ?? rawKey ?? '').trim();
    if (!typeId) continue;

    const next = (idCounters.get(typeId) || 0) + 1;
    idCounters.set(typeId, next);

    const slotRef = `${typeId}#${next}`;
    rawKeyToSlotRef[rawKey] = slotRef;

    const part = {
      id: typeId,
      name: rawPart.name ?? typeId,
      slotRef,
      uuid: stableUuid(actorId, slotRef),
      weight: Number(rawPart.weight ?? 0),
      maxHp: Number(rawPart.maxHp ?? 0),
      x: coerceCoord(rawPart.x),
      y: coerceCoord(rawPart.y),
      status: rawPart.status ?? 'healthy',
      internal: Boolean(rawPart.internal ?? false),
      tags: Array.isArray(rawPart.tags) ? [...rawPart.tags] : [],
      organs: [],
      exposure: sanitizeExposure(rawPart.exposure),
      relations: Array.isArray(rawPart.relations) ? rawPart.relations.map((r) => ({ ...r })) : [],
    };

    out[slotRef] = part;
  }

  for (const part of Object.values(out)) {
    const remapped = part.relations
      .map((r) => {
        const target = rawKeyToSlotRef[r.target] ?? r.target;
        if (!out[target]) return null;
        return { ...r, target };
      })
      .filter(Boolean);

    let parentSeen = false;
    const cleaned = [];
    for (let i = remapped.length - 1; i >= 0; i -= 1) {
      const r = remapped[i];
      if (r.kind === 'parent') {
        if (parentSeen) continue;
        parentSeen = true;
      }
      cleaned.unshift(r);
    }
    part.relations = dedupeRelations(cleaned);
    part.links = part.relations.filter((r) => r.kind === 'adjacent').map((r) => r.target);
  }

  return out;
}

// ---------- Helpers ---------------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function readSystemVersion() {
  try {
    const sys = readJson(path.join(root, 'system.json'));
    return String(sys?.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function loadItemSrc(basename) {
  return readJson(path.join(itemSrcDir, `${basename}.json`));
}

function makeStats(extraTime = 0) {
  return {
    compendiumSource: null,
    duplicateSource: null,
    exportSource: null,
    coreVersion: CORE_VERSION,
    systemId: 'spaceholder',
    systemVersion: SYSTEM_VERSION,
    createdTime: CREATED_TIME + extraTime,
    modifiedTime: CREATED_TIME + extraTime,
    lastModifiedBy: null,
  };
}

function makePrototypeToken({ name, src, disposition }) {
  return {
    name,
    displayName: 30,
    actorLink: false,
    appendNumber: false,
    prependAdjective: false,
    width: 1,
    height: 1,
    texture: {
      src,
      anchorX: 0.5,
      anchorY: 0.5,
      offsetX: 0,
      offsetY: 0,
      fit: 'contain',
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      tint: '#ffffff',
      alphaThreshold: 0.75,
    },
    hexagonalShape: 0,
    lockRotation: false,
    rotation: 0,
    alpha: 1,
    disposition,
    displayBars: 0,
    bar1: { attribute: null },
    bar2: { attribute: null },
    light: {
      negative: false,
      priority: 0,
      alpha: 0.5,
      angle: 360,
      bright: 0,
      color: null,
      coloration: 1,
      dim: 0,
      attenuation: 0.5,
      luminosity: 0.5,
      saturation: 0,
      contrast: 0,
      shadows: 0,
      animation: { type: null, speed: 5, intensity: 5, reverse: false },
    },
    sight: {
      enabled: false,
      range: 0,
      angle: 360,
      visionMode: 'basic',
      color: null,
      attenuation: 0.1,
      brightness: 0,
      saturation: 0,
      contrast: 0,
    },
    detectionModes: [],
    occludable: { radius: 0 },
    ring: {
      enabled: false,
      colors: { ring: null, background: null },
      effects: 1,
      subject: { scale: 1, texture: null },
    },
    movementAction: null,
    flags: {},
    randomImg: false,
  };
}

function makeBaseAbilities() {
  return {
    end: { value: 10 },
    str: { value: 10 },
    dex: { value: 10 },
    cor: { value: 10 },
    per: { value: 10 },
    int: { value: 10 },
    luc: { value: 10 },
  };
}

function makeCharacterSystem({ anatomyId, anatomyName, bodyParts, anatomyGrid, biography }) {
  return {
    anatomy: { type: anatomyId, id: anatomyId, name: anatomyName, bodyParts: {} },
    health: { injuries: [], bodyParts, anatomyGrid },
    biography,
    attributes: { level: { value: 1 } },
    actionPoints: { value: 100 },
    speed: 1,
    gFaction: '',
    actions: [],
    aimingArc: { zoneHalfDegrees: [1, 5, 15, 25, 30], deviationBaseDeg: 1 },
    abilities: makeBaseAbilities(),
  };
}

/** Deterministic 16-char embedded item id unique per actor + source item. */
function embeddedItemId(actorId, srcId, slot) {
  const raw = `e${actorId.slice(-5)}${srcId.slice(-8)}${String(slot).padStart(2, '0')}`;
  return raw.slice(0, 16);
}

/**
 * Nested-storage / FIFO ammo record — legacy helper (prefer live embedded items).
 * @param {object} ammoSrc compendium ammo JSON
 * @param {number} quantity
 * @param {string} recordId
 */
function nestedAmmoRecord(ammoSrc, quantity, recordId) {
  const system = JSON.parse(JSON.stringify(ammoSrc.system));
  system.quantity = quantity;
  return {
    id: recordId,
    type: 'item',
    name: ammoSrc.name,
    img: ammoSrc.img,
    system,
    flags: {},
    sourceUuid: '',
  };
}

/**
 * @typedef {object} LoadoutEntry
 * @property {string} srcKey key in T4
 * @property {boolean} [held]
 * @property {boolean} [equipped]
 * @property {number} [quantity]
 * @property {object} [weaponState] patch for system.weapon.state
 * @property {Array<{blockId: string, runtime: object, lineId?: string}>} [blockPatches]
 * @property {number} [parentSlot] index of host entry in the same loadout
 * @property {string} [attachBlockId] ammo block id on parent weapon
 * @property {'magazine'|'chamber'|'content'} [attachRole]
 */

/**
 * @param {string} actorId
 * @param {LoadoutEntry[]} loadout
 * @returns {object[]}
 */
function buildEmbeddedItems(actorId, loadout) {
  const items = [];
  let sort = 100000;
  for (let i = 0; i < loadout.length; i += 1) {
    const entry = loadout[i];
    const basename = T4[entry.srcKey];
    if (!basename) throw new Error(`Unknown T4 key: ${entry.srcKey}`);
    const src = loadItemSrc(basename);
    const embeddedId = embeddedItemId(actorId, src._id, i);

    const item = JSON.parse(JSON.stringify(src));
    item._id = embeddedId;
    item._key = `!actors.items!${actorId}.${embeddedId}`;
    item.folder = null;
    item.sort = sort;
    item.ownership = { default: 0 };
    item.flags = item.flags ?? {};
    item._stats = makeStats(i);
    item.system.containerHostId = '';

    if (entry.quantity != null) {
      item.system.quantity = entry.quantity;
    }
    if (entry.held) {
      item.system.held = true;
      item.system.equipped = false;
    }
    if (entry.equipped) {
      item.system.equipped = true;
      item.system.held = false;
    }

    // Magazines: ensure live container limits from capacity.
    const ammo = item.system?.weapon?.ammo;
    if (item.system?.itemTags?.isAmmo && ammo?.connector?.enabled && item.system?.itemTags?.isContainer) {
      const cap = Math.max(0, Number(ammo.capacity) || 0);
      item.system.container = item.system.container ?? { contents: [], limits: { maxItems: 0, maxWeight: 0 } };
      item.system.container.contents = Array.isArray(item.system.container.contents)
        ? item.system.container.contents
        : [];
      item.system.container.limits = item.system.container.limits ?? { maxItems: 0, maxWeight: 0 };
      if (cap > 0) item.system.container.limits.maxItems = cap;
      item.system.storage = { enabled: false, version: 1, slots: {}, contents: [] };
    }

    const weapon = item.system?.weapon;
    if (weapon && entry.weaponState) {
      weapon.state = { ...(weapon.state ?? {}), ...entry.weaponState };
    }
    if (weapon && Array.isArray(entry.blockPatches)) {
      for (const patch of entry.blockPatches) {
        const line = patch.lineId
          ? weapon.lines?.find((l) => l.id === patch.lineId)
          : weapon.lines?.[0];
        const block = line?.ammoBlocks?.find((b) => b.id === patch.blockId);
        if (block) {
          block.runtime = { ...(block.runtime ?? {}), ...patch.runtime };
        }
      }
    }

    items.push(item);
    sort += 10000;
  }

  // Second pass: live parent links + weapon runtime ids.
  for (let i = 0; i < loadout.length; i += 1) {
    const entry = loadout[i];
    if (entry.parentSlot == null) continue;
    const child = items[i];
    const host = items[entry.parentSlot];
    if (!child || !host) continue;
    child.system.containerHostId = host._id;
    child.system.held = false;
    child.system.equipped = false;

    if (host.system?.itemTags?.isContainer) {
      host.system.container = host.system.container ?? { contents: [], limits: { maxItems: 0, maxWeight: 0 } };
      host.system.container.contents = Array.isArray(host.system.container.contents)
        ? host.system.container.contents
        : [];
      if (!host.system.container.contents.some((e) => e?.itemId === child._id || e === child._id)) {
        host.system.container.contents.push({ kind: 'actorItem', itemId: child._id });
      }
    }

    if (entry.attachBlockId && host.system?.weapon) {
      const line = host.system.weapon.lines?.[0];
      const block = line?.ammoBlocks?.find((b) => b.id === entry.attachBlockId);
      if (block) {
        block.runtime = block.runtime ?? {};
        block.runtime.attachedItemId = block.runtime.attachedItemId ?? '';
        block.runtime.chamberItemId = block.runtime.chamberItemId ?? '';
        block.runtime.contentItemIds = Array.isArray(block.runtime.contentItemIds)
          ? block.runtime.contentItemIds
          : [];
        block.runtime.magazine = null;
        block.runtime.chamberItem = null;
        block.runtime.contents = [];
        if (entry.attachRole === 'magazine') {
          block.runtime.attachedItemId = child._id;
        } else if (entry.attachRole === 'chamber') {
          block.runtime.chamberItemId = child._id;
        } else if (entry.attachRole === 'content') {
          if (!block.runtime.contentItemIds.includes(child._id)) {
            block.runtime.contentItemIds.push(child._id);
          }
        }
      }
    }
  }

  return items;
}

function buildHumanoidActor({
  id,
  name,
  file,
  sort,
  img,
  tokenImg,
  disposition,
  biography,
  loadout,
  timeOffset = 0,
}) {
  const humanoid = readJson(path.join(anatomyDir, 'humanoid.json'));
  const bodyParts = buildActorBodyParts(humanoid.bodyParts, id);
  const anatomyGrid = humanoid.grid && typeof humanoid.grid.width === 'number'
    ? { width: humanoid.grid.width, height: humanoid.grid.height }
    : { width: 9, height: 10 };

  return {
    doc: {
      name,
      type: 'character',
      _id: id,
      img,
      system: makeCharacterSystem({
        anatomyId: 'humanoid',
        anatomyName: 'Humanoid',
        bodyParts,
        anatomyGrid,
        biography,
      }),
      prototypeToken: makePrototypeToken({ name, src: tokenImg ?? img, disposition }),
      items: buildEmbeddedItems(id, loadout),
      effects: [],
      folder: null,
      sort,
      ownership: { default: 0 },
      flags: {},
      _stats: makeStats(timeOffset),
      _key: `!actors!${id}`,
    },
    file,
  };
}

// ---------- Loadout presets ------------------------------------------------

function fullArsenalLoadout() {
  return [
    { srcKey: 'sword' },
    { srcKey: 'simp' },
    { srcKey: 'wand' },
    { srcKey: 'lass' },
    { srcKey: 'm1d' },
    { srcKey: 'bow' },
    { srcKey: 'grenade' },
    { srcKey: 'reil' },
    { srcKey: 'crystal', quantity: 2 },
    { srcKey: 'battery', quantity: 2 },
    { srcKey: 'fusion', quantity: 1 },
    { srcKey: 'heat', quantity: 1 },
    { srcKey: 'magM1d' },
    { srcKey: 'ammo545', quantity: 60 },
    { srcKey: 'arrow', quantity: 12 },
    { srcKey: 'arrowExpl', quantity: 4 },
    { srcKey: 'arrowPoison', quantity: 4 },
    { srcKey: 'arrowSmoke', quantity: 4 },
    { srcKey: 'railSlug', quantity: 10 },
    { srcKey: 'magRail' },
    { srcKey: 'lube' },
    { srcKey: 'barrel' },
    { srcKey: 'bandolier' },
  ];
}

function m1dReadyLoadout() {
  // 0 weapon, 1 mag (on weapon), 2 rounds in mag, 3 chamber round on weapon, 4 spare ammo
  return [
    {
      srcKey: 'm1d',
      held: true,
      weaponState: { ready: true, activeLineId: 'lineM1dMain00000', activeModeId: 'modeM1dSingle000' },
    },
    {
      srcKey: 'magM1d',
      parentSlot: 0,
      attachBlockId: 'blockM1dMag00000',
      attachRole: 'magazine',
    },
    {
      srcKey: 'ammo545',
      quantity: 29,
      parentSlot: 1,
    },
    {
      srcKey: 'ammo545',
      quantity: 1,
      parentSlot: 0,
      attachBlockId: 'blockM1dMag00000',
      attachRole: 'chamber',
    },
    { srcKey: 'ammo545', quantity: 30 },
  ];
}

function lassLoadout() {
  // 0 LASS, 1 battery on batt block, 2 heat on heat block, 3 spare fusion
  return [
    {
      srcKey: 'lass',
      held: true,
      weaponState: { ready: true, activeLineId: 'lineLassMain0000', activeModeId: 'modeLassSingle00' },
    },
    {
      srcKey: 'battery',
      quantity: 1,
      parentSlot: 0,
      attachBlockId: 'blockLassBatt000',
      attachRole: 'content',
    },
    {
      srcKey: 'heat',
      quantity: 1,
      parentSlot: 0,
      attachBlockId: 'blockLassHeat000',
      attachRole: 'content',
    },
    { srcKey: 'fusion', quantity: 1 },
  ];
}

function wandLoadout() {
  return [
    {
      srcKey: 'wand',
      held: true,
      weaponState: { ready: true, activeLineId: 'lineWandMain0000', activeModeId: 'modeWandCut00000' },
    },
    {
      srcKey: 'crystal',
      quantity: 1,
      parentSlot: 0,
      attachBlockId: 'blockWandCrystal',
      attachRole: 'content',
    },
    { srcKey: 'crystal', quantity: 1 },
  ];
}

// ---------- Actor definitions ---------------------------------------------

function buildAllActors() {
  const actors = [];

  actors.push(buildHumanoidActor({
    id: 'shtestshooter000',
    name: 'Стрелок',
    file: 'SH_Shooter_shtestshooter000.json',
    sort: 100000,
    img: 'systems/spaceholder/assets/icons/action.svg/bowman.svg',
    biography: '<p>Полный набор Test4 оружия и боеприпасов. Ничего не в руках — проверка цепочки атаки с нуля.</p>',
    disposition: 1,
    loadout: fullArsenalLoadout(),
    timeOffset: 0,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtest4melee0000',
    name: 'Тест: бастард',
    file: 'SH_Test4_Melee_shtest4melee00.json',
    sort: 110000,
    img: 'systems/spaceholder/assets/icons/weapon.svg/sword.svg',
    biography: '<p>Меч-бастард в руках, боеготовность. Две линии хвата × две атаки.</p>',
    disposition: 1,
    loadout: [{
      srcKey: 'sword',
      held: true,
      weaponState: { ready: true, activeLineId: 'line1h0000000000', activeModeId: 'mode1hSlash00000' },
    }],
    timeOffset: 1,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtest4m1d000000',
    name: 'Тест: M-1d',
    file: 'SH_Test4_M1dActor_shtest4m1dact.json',
    sort: 120000,
    img: 'systems/spaceholder/assets/icons/weapon.svg/assault-rifle.svg',
    biography: '<p>M-1d в руках, магазин и патроны 5.45 в инвентаре (магазин не установлен). Зарядить патроны в магазин → поставить магазин на винтовку.</p>',
    disposition: 1,
    loadout: [
      { srcKey: 'm1d', held: true },
      { srcKey: 'magM1d' },
      { srcKey: 'ammo545', quantity: 30 },
    ],
    timeOffset: 2,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtest4m1drdy000',
    name: 'Тест: M-1d (готов)',
    file: 'SH_Test4_M1dReady_shtest4m1drdy.json',
    sort: 130000,
    img: 'systems/spaceholder/assets/icons/weapon.svg/assault-rifle.svg',
    biography: '<p>M-1d готов: магазин установлен, 29 патронов в магазине + 1 в патроннике, запас патронов в инвентаре.</p>',
    disposition: 1,
    loadout: m1dReadyLoadout(),
    timeOffset: 3,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtest4lass00000',
    name: 'Тест: LASS',
    file: 'SH_Test4_LASSActor_shtest4lassac.json',
    sort: 140000,
    img: 'systems/spaceholder/assets/icons/weapon.svg/laser-gun.svg',
    biography: '<p>LASS с батареей (−5%, урон=spent) и теплообменником. Запас: термояд. батарея.</p>',
    disposition: 1,
    loadout: lassLoadout(),
    timeOffset: 4,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtest4bow000000',
    name: 'Тест: лук',
    file: 'SH_Test4_BowActor_shtest4bowact.json',
    sort: 150000,
    img: 'systems/spaceholder/assets/icons/weapon.svg/bow-arrow.svg',
    biography: '<p>Лук + обычные и спец-стрелы (заглушки) в инвентаре.</p>',
    disposition: 1,
    loadout: [
      { srcKey: 'bow', held: true, weaponState: { ready: true } },
      { srcKey: 'arrow', quantity: 8 },
      { srcKey: 'arrowExpl', quantity: 2 },
      { srcKey: 'arrowPoison', quantity: 2 },
      { srcKey: 'arrowSmoke', quantity: 2 },
    ],
    timeOffset: 5,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtest4wand00000',
    name: 'Тест: жезл',
    file: 'SH_Test4_WandActor_shtest4wandac.json',
    sort: 160000,
    img: 'icons/svg/daze.svg',
    biography: '<p>Жезл ветров с кристаллом (ammoCost 2/5). AoE — заглушка.</p>',
    disposition: 1,
    loadout: wandLoadout(),
    timeOffset: 6,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtest4simp00000',
    name: 'Тест: SIMP-13',
    file: 'SH_Test4_SIMPActor_shtest4simpact.json',
    sort: 170000,
    img: 'systems/spaceholder/assets/icons/weapon.svg/laser-gun.svg',
    biography: '<p>Плазменный пистолет с внутренним зарядом (без патронника).</p>',
    disposition: 1,
    loadout: [{
      srcKey: 'simp',
      held: true,
      weaponState: { ready: true, activeLineId: 'lineSimpMain0000', activeModeId: 'modeSimpSingle00' },
    }],
    timeOffset: 7,
  }));

  // Bandolier: equip container + put ammo inside via containerHostId
  {
    const actorId = 'shtest4bandol000';
    const built = buildHumanoidActor({
      id: actorId,
      name: 'Тест: патронташ',
      file: 'SH_Test4_BandolierActor_shtest4bandac.json',
      sort: 180000,
      img: 'icons/svg/item-bag.svg',
      biography: '<p>Патронташ надет, патроны 5.45 внутри (worn search). Лук в руках + стрелы.</p>',
      disposition: 1,
      loadout: [
        { srcKey: 'bandolier', equipped: true },
        { srcKey: 'ammo545', quantity: 30 },
        { srcKey: 'bow', held: true, weaponState: { ready: true } },
        { srcKey: 'arrow', quantity: 6 },
      ],
      timeOffset: 8,
    });
    const band = built.doc.items.find((it) => it.system?.itemTags?.isContainer && it.system?.itemTags?.isArmor);
    const ammo = built.doc.items.find((it) => it.name?.includes('5.45'));
    if (band && ammo) {
      ammo.system.containerHostId = band._id;
      band.system.container = band.system.container ?? { limits: { maxItems: 40, maxWeight: 5 }, contents: [] };
      band.system.container.contents = [{ kind: 'actorItem', itemId: ammo._id }];
    }
    actors.push(built);
  }

  return actors;
}

function buildTargetActor() {
  const rawBodyParts = {
    chest: {
      id: 'chest',
      name: 'Chest',
      weight: 1000,
      maxHp: 200,
      x: 0,
      y: 0,
      status: 'healthy',
      internal: false,
      tags: ['core', 'vital', 'armor_chest'],
      relations: [],
      exposure: { front: 100, right: 100, back: 100, left: 100 },
    },
  };

  const bodyParts = buildActorBodyParts(rawBodyParts, TARGET_ID);

  return {
    doc: {
      name: 'Мишень',
      type: 'character',
      _id: TARGET_ID,
      img: 'icons/svg/target.svg',
      system: makeCharacterSystem({
        anatomyId: 'target-chest',
        anatomyName: 'Target Chest',
        bodyParts,
        anatomyGrid: { width: 1, height: 1 },
        biography: '<p>Тестовая мишень: одна часть тела <code>chest</code>, много HP. Для проверки попаданий и урона v3.</p>',
      }),
      prototypeToken: makePrototypeToken({
        name: 'Мишень',
        src: 'icons/svg/target.svg',
        disposition: 0,
      }),
      items: [],
      effects: [],
      folder: null,
      sort: 200000,
      ownership: { default: 0 },
      flags: {},
      _stats: makeStats(99),
      _key: `!actors!${TARGET_ID}`,
    },
    file: 'SH_Target_shtesttarget0000.json',
  };
}

// ---------- Main ------------------------------------------------------------

function main() {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const built = [...buildAllActors(), buildTargetActor()];
  const written = [];

  for (const { doc, file } of built) {
    const outPath = path.join(outDir, file);
    writeJson(outPath, doc);
    written.push({ file, name: doc.name, items: doc.items?.length ?? 0 });
  }

  // Remove stale actor JSON not regenerated (e.g. old single-shooter variants).
  const keep = new Set(built.map((b) => b.file));
  for (const name of fs.readdirSync(outDir)) {
    if (!name.endsWith('.json') || name.startsWith('_Folder')) continue;
    if (!keep.has(name)) {
      fs.unlinkSync(path.join(outDir, name));
      console.log(`Removed stale: ${name}`);
    }
  }

  for (const row of written) {
    console.log(`Wrote ${row.file} — ${row.name} (${row.items} items)`);
  }
}

main();

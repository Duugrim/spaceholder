/**
 * Build actor JSON sources for the `sh-test-actors` compendium (weapon v3 test rigs).
 *
 * Reads humanoid anatomy from `data/anatomy/humanoid.json` and embeds v3 weapons,
 * ammo and magazines from `pack-src/sh-test-items/SH_WV3_*`.
 *
 * Actors:
 *  - Стрелок v3       — full arsenal (drag-and-pick any weapon/ammo scenario)
 *  - Тест: ближний бой — sword held, readied
 *  - Тест: пистолет   — pistol held, mag + loose ammo in inventory (attack chain)
 *  - Тест: пистолет (готов) — pistol held, mag chambered, readied (instant aim)
 *  - Тест: болтовка   — bolt rifle held, internal mag loaded, empty chamber (bolt step)
 *  - Тест: автомат    — auto rifle held, mag attached + chambered, readied (burst/auto)
 *  - Тест: лазер      — laser held, batteries in block + spare in inventory
 *  - Тест: лук        — bow held, arrows in inventory (on-the-fly search)
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

/** v3 test items in pack-src (basename without .json). */
const WV3 = {
  sword: 'SH_WV3_Sword_shwv3sword000000',
  pistol: 'SH_WV3_Pistol_shwv3pistol00000',
  boltRifle: 'SH_WV3_Bolt_Rifle_shwv3boltrifle00',
  autoRifle: 'SH_WV3_Auto_Rifle_shwv3autorifle00',
  laser: 'SH_WV3_Laser_shwv3laser000000',
  bow: 'SH_WV3_Bow_shwv3bow00000000',
  ammo9x19: 'SH_WV3_Ammo_9x19_shwv3ammo9x19000',
  ammo762: 'SH_WV3_Ammo_762x54_shwv3ammo762x540',
  ammo545: 'SH_WV3_Ammo_545x39_shwv3ammo545x390',
  ammoArrow: 'SH_WV3_Ammo_Arrow_shwv3ammoarrow00',
  ammoBattery: 'SH_WV3_Ammo_Battery_shwv3ammobattery',
  magPistol: 'SH_WV3_Mag_Pistol_shwv3magpistol00',
  magRifle: 'SH_WV3_Mag_Rifle_shwv3magrifle000',
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
 * Nested-storage / FIFO ammo record (matches weapon-ammo-runtime snapshots).
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

/** Magazine snapshot for external-magazine block runtime. */
function magazineRuntimeSnapshot(magSrc, snapId) {
  return {
    id: snapId,
    type: 'item',
    name: magSrc.name,
    img: magSrc.img,
    system: JSON.parse(JSON.stringify(magSrc.system)),
    flags: {},
    sourceUuid: '',
  };
}

/**
 * @typedef {object} LoadoutEntry
 * @property {string} srcKey key in WV3
 * @property {boolean} [held]
 * @property {number} [quantity]
 * @property {object} [weaponState] patch for system.weapon.state
 * @property {Array<{blockId: string, runtime: object}>} [blockPatches]
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
    const basename = WV3[entry.srcKey];
    if (!basename) throw new Error(`Unknown WV3 key: ${entry.srcKey}`);
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

    if (entry.quantity != null) {
      item.system.quantity = entry.quantity;
    }
    if (entry.held) {
      item.system.held = true;
      item.system.equipped = false;
      item.system.containerHostId = '';
    }

    const weapon = item.system?.weapon;
    if (weapon && entry.weaponState) {
      weapon.state = { ...(weapon.state ?? {}), ...entry.weaponState };
    }
    if (weapon && Array.isArray(entry.blockPatches)) {
      for (const patch of entry.blockPatches) {
        const line = weapon.lines?.[0];
        const block = line?.ammoBlocks?.find((b) => b.id === patch.blockId);
        if (block) {
          block.runtime = { ...(block.runtime ?? {}), ...patch.runtime };
        }
      }
    }

    items.push(item);
    sort += 10000;
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
    { srcKey: 'pistol' },
    { srcKey: 'boltRifle' },
    { srcKey: 'autoRifle' },
    { srcKey: 'laser' },
    { srcKey: 'bow' },
    { srcKey: 'magPistol' },
    { srcKey: 'magRifle' },
    { srcKey: 'ammo9x19', quantity: 50 },
    { srcKey: 'ammo762', quantity: 20 },
    { srcKey: 'ammo545', quantity: 60 },
    { srcKey: 'ammoArrow', quantity: 12 },
    { srcKey: 'ammoBattery', quantity: 3 },
  ];
}

function pistolReadyLoadout() {
  const ammoSrc = loadItemSrc(WV3.ammo9x19);
  const magSrc = loadItemSrc(WV3.magPistol);
  const chamberRound = nestedAmmoRecord(ammoSrc, 1, 'chambpistol9x19');
  const magSnap = magazineRuntimeSnapshot(magSrc, 'snapmagpistol00');

  return [
    {
      srcKey: 'pistol',
      held: true,
      weaponState: { ready: true, activeLineId: 'linePistolMain00', activeModeId: 'modePistolSingle' },
      blockPatches: [{
        blockId: 'blkPistolMag0000',
        runtime: { magazine: magSnap, chamberItem: chamberRound },
      }],
    },
  ];
}

function boltRifleLoadout() {
  const ammoSrc = loadItemSrc(WV3.ammo762);
  const rounds = Array.from({ length: 5 }, (_, i) =>
    nestedAmmoRecord(ammoSrc, 1, `bolt762r${i}`),
  );

  return [
    {
      srcKey: 'boltRifle',
      held: true,
      weaponState: { ready: false },
      blockPatches: [{
        blockId: 'blkBoltMag000000',
        runtime: { contents: rounds, chamberItem: null },
      }],
    },
    { srcKey: 'ammo762', quantity: 10 },
  ];
}

function autoRifleReadyLoadout() {
  const ammoSrc = loadItemSrc(WV3.ammo545);
  const magSrc = loadItemSrc(WV3.magRifle);
  const chamberRound = nestedAmmoRecord(ammoSrc, 1, 'chambauto545x39');
  const magSnap = magazineRuntimeSnapshot(magSrc, 'snapmagrifle000');

  return [
    {
      srcKey: 'autoRifle',
      held: true,
      weaponState: {
        ready: true,
        activeLineId: 'lineAutoMain0000',
        activeModeId: 'modeAutoBurst000',
      },
      blockPatches: [{
        blockId: 'blkAutoMag000000',
        runtime: { magazine: magSnap, chamberItem: chamberRound },
      }],
    },
  ];
}

function laserLoadout() {
  const batterySrc = loadItemSrc(WV3.ammoBattery);
  const installed = nestedAmmoRecord(batterySrc, 1, 'lasbatinstalled0');
  installed.system.weapon.ammo.charge = { enabled: true, max: 20, current: 20 };

  return [
    {
      srcKey: 'laser',
      held: true,
      weaponState: { ready: true, activeLineId: 'lineLaserMain000', activeModeId: 'modeLaserStd0000' },
      blockPatches: [{
        blockId: 'blkLaserBat00000',
        runtime: { contents: [installed] },
      }],
    },
    { srcKey: 'ammoBattery', quantity: 2 },
  ];
}

// ---------- Actor definitions ---------------------------------------------

function buildAllActors() {
  const actors = [];

  actors.push(buildHumanoidActor({
    id: 'shtestshooter000',
    name: 'Стрелок v3',
    file: 'SH_Shooter_shtestshooter000.json',
    sort: 100000,
    img: 'systems/spaceholder/assets/icons/action.svg/bowman.svg',
    biography: '<p>Полный набор оружия v3, магазинов и боеприпасов в инвентаре. Ничего не в руках — удобно проверять цепочку атаки «взять → перезарядить → прицелиться» с нуля.</p>',
    disposition: 1,
    loadout: fullArsenalLoadout(),
    timeOffset: 0,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtestwv3melee00',
    name: 'Тест: ближний бой',
    file: 'SH_WV3_Melee_shtestwv3melee00.json',
    sort: 110000,
    img: 'systems/spaceholder/assets/icons/weapon.svg/gladius.svg',
    biography: '<p>Меч в руках, боеготовность включена. Проверка линии без блоков патронов и саб-блока урона на оружии.</p>',
    disposition: 1,
    loadout: [{
      srcKey: 'sword',
      held: true,
      weaponState: { ready: true, activeLineId: 'lineSwordMain000', activeModeId: 'modeSwordStd0000' },
    }],
    timeOffset: 1,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtestwv3pist00',
    name: 'Тест: пистолет',
    file: 'SH_WV3_Pistol_shtestwv3pist00.json',
    sort: 120000,
    img: 'systems/spaceholder/assets/icons/weapon.svg/luger.svg',
    biography: '<p>Пистолет в руках, магазин и патроны 9×19 в инвентаре (магазин не установлен). Проверка цепочки: установить магазин → затвор → изготовка → прицел.</p>',
    disposition: 1,
    loadout: [
      { srcKey: 'pistol', held: true },
      { srcKey: 'magPistol' },
      { srcKey: 'ammo9x19', quantity: 24 },
    ],
    timeOffset: 2,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtestwv3pistrdy',
    name: 'Тест: пистолет (готов)',
    file: 'SH_WV3_PistolReady_shtestwv3pistrdy.json',
    sort: 130000,
    img: 'systems/spaceholder/assets/icons/weapon.svg/luger.svg',
    biography: '<p>Пистолет в руках, магазин установлен, патрон в патроннике, боеготовность. Минимальная цепочка до прицеливания — сразу стрелять.</p>',
    disposition: 1,
    loadout: pistolReadyLoadout(),
    timeOffset: 3,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtestwv3bolt000',
    name: 'Тест: болтовка',
    file: 'SH_WV3_Bolt_shtestwv3bolt000.json',
    sort: 140000,
    img: 'systems/spaceholder/assets/icons/weapon.svg/lee-enfield.svg',
    biography: '<p>Болтовая винтовка в руках, 5 патронов в резерве, патронник пуст. Проверка ручного затвора и одиночного выстрела.</p>',
    disposition: 1,
    loadout: boltRifleLoadout(),
    timeOffset: 4,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtestwv3auto000',
    name: 'Тест: автомат',
    file: 'SH_WV3_Auto_shtestwv3auto000.json',
    sort: 150000,
    img: 'systems/spaceholder/assets/icons/weapon.svg/steyr-aug.svg',
    biography: '<p>Автомат в руках, магазин установлен и заряжен, режим «Очередь ×3», боеготовность. Проверка очереди и автоогня.</p>',
    disposition: 1,
    loadout: autoRifleReadyLoadout(),
    timeOffset: 5,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtestwv3laser00',
    name: 'Тест: лазер',
    file: 'SH_WV3_Laser_shtestwv3laser00.json',
    sort: 160000,
    img: 'systems/spaceholder/assets/icons/weapon.svg/laser-gun.svg',
    biography: '<p>Лазер в руках, батарея в блоке внешнего заряда + запасные батареи в инвентаре. Проверка расхода заряда и режима «Импульс».</p>',
    disposition: 1,
    loadout: laserLoadout(),
    timeOffset: 6,
  }));

  actors.push(buildHumanoidActor({
    id: 'shtestwv3bow0000',
    name: 'Тест: лук',
    file: 'SH_WV3_Bow_shtestwv3bow0000.json',
    sort: 170000,
    img: 'systems/spaceholder/assets/icons/weapon.svg/bow-arrow.svg',
    biography: '<p>Лук в руках, стрелы в инвентаре. Проверка поиска боеприпаса «на лету» (ёмкость 0, без патронника).</p>',
    disposition: 1,
    loadout: [
      { srcKey: 'bow', held: true, weaponState: { ready: true } },
      { srcKey: 'ammoArrow', quantity: 8 },
    ],
    timeOffset: 7,
  }));

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

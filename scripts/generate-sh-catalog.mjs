/**
 * Generate the SpaceHolder gameplay catalog into pack-src/sh-test-items.
 * Wipes existing JSON in that folder, then writes materials / wearables /
 * ammunition / weapons per docs/Kanban/Новое оружие.md (Phase 1–2).
 *
 * Usage: node scripts/generate-sh-catalog.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'pack-src', 'sh-test-items');

const SYSTEM_VERSION = readSystemVersion();
const CORE_VERSION = '13.350';
const CREATED_TIME = 1782900000000;
const ICON = (rel) => `systems/spaceholder/assets/icons/${rel}`;

function readSystemVersion() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'system.json'), 'utf8'));
    return String(j.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function id(seed) {
  return (`shc${crypto.createHash('md5').update(seed).digest('hex')}`).slice(0, 16);
}

function stats() {
  return {
    compendiumSource: null,
    duplicateSource: null,
    exportSource: null,
    coreVersion: CORE_VERSION,
    systemId: 'spaceholder',
    systemVersion: SYSTEM_VERSION,
    createdTime: CREATED_TIME,
    modifiedTime: CREATED_TIME,
    lastModifiedBy: null,
  };
}

function defaultActions() {
  return {
    equip: { showInCombat: false, showInQuickbar: true },
    unequip: { showInCombat: false, showInQuickbar: true },
    hold: { showInCombat: false, showInQuickbar: true },
    stow: { showInCombat: false, showInQuickbar: true },
    drop: { showInCombat: false, showInQuickbar: false },
    wear: { showInCombat: false, showInQuickbar: false },
    show: { showInCombat: false, showInQuickbar: false },
  };
}

function emptyErgo(readying = 6) {
  return {
    overall: 100,
    zones: { enabled: false, green: 100, yellow: 100, orange: 100, red: 100 },
    deadZone: { enabled: false, value: 100 },
    aimPenalty: { enabled: false, value: 100 },
    critZoneBonus: { enabled: false, value: 0 },
    critZoneSize: { enabled: false, value: 100 },
    readying: { enabled: true, value: readying },
  };
}

function chargeOff() {
  return {
    enabled: false, max: 0, current: 0, allowFractional: false,
    clampNonNegative: true, scaleDamageFromSpent: false, overheatNotify: false,
    changePerShot: { sign: '-', formula: '1' },
    changePerSecond: { sign: '+', formula: '0' },
  };
}

function dmg(type, damage, armorPen, extras = {}) {
  return {
    enabled: true,
    damageType: type,
    damage,
    armorPen,
    hardness: extras.hardness ?? 1,
    armorDamageFactor: 100,
    armorDamageReduction: 100,
    speed: 0,
    payloadId: '',
  };
}

function falloff(halfDistance) {
  if (!(halfDistance > 0)) return { enabled: false, halfDistance: 0 };
  return { enabled: true, halfDistance };
}

function searchAuto() {
  return { hands: true, worn: true, inventory: true, containers: true, mode: 'auto' };
}

function apMag() {
  return {
    loadOne: { enabled: true, value: 5 },
    loadX: { enabled: true, value: 10 },
    reload: { enabled: true, value: 30 },
    bolt: { enabled: true, value: 5 },
    unload: { enabled: true, value: 5 },
    empty: { enabled: true, value: 10 },
  };
}

function apCharge(reload = 20) {
  return {
    loadOne: { enabled: true, value: 5 },
    loadX: { enabled: true, value: 10 },
    reload: { enabled: true, value: reload },
    bolt: { enabled: false, value: 0 },
    unload: { enabled: true, value: 5 },
    empty: { enabled: true, value: 10 },
  };
}

function runtimeEmpty() {
  return {
    charge: 0, chamberCharge: false, attachedItemId: '', chamberItemId: '',
    contentItemIds: [], chamberItem: null, contents: [], magazine: null,
  };
}

function mode(idSeed, name, fireMode, opts = {}) {
  return {
    id: id(idSeed),
    name,
    fireMode,
    burstCount: opts.burstCount ?? 3,
    fireDelayAp: opts.fireDelayAp ?? (fireMode === 'auto' ? 4 : 5),
    ammoCost: opts.ammoCost ?? 1,
    enterCost: { enabled: !!opts.enterCost, value: opts.enterCost || 0 },
    exitCost: { enabled: !!opts.exitCost, value: opts.exitCost || 0 },
    modifiers: opts.modifiers ?? [],
    multishot: opts.multishot ?? { enabled: false, count: 1, coneDegrees: 0 },
  };
}

function writeItem(fileBase, doc) {
  const file = path.join(outDir, `${fileBase}.json`);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

/** @type {Map<string, string>} pathJoined -> folderId */
const FOLDER_IDS = new Map();
let folderSortCounter = 0;

/**
 * Ensure nested Foundry folders exist. Returns leaf folder id.
 * @param {string[]} segments e.g. ['Оружие','Огнестрельное','Пистолеты']
 * @param {string} [color]
 */
function ensureFolder(segments, color = '#888888') {
  const parts = segments.filter(Boolean);
  let parent = null;
  let pathKey = '';
  for (const name of parts) {
    pathKey = pathKey ? `${pathKey}/${name}` : name;
    if (FOLDER_IDS.has(pathKey)) {
      parent = FOLDER_IDS.get(pathKey);
      continue;
    }
    const folderId = id(`folder:${pathKey}`);
    folderSortCounter += 1000;
    writeItem(`_Folder_${pathKey.replace(/[^\wа-яА-ЯёЁ]+/gi, '_')}_${folderId}`, {
      name,
      type: 'Item',
      _id: folderId,
      sorting: 'a',
      folder: parent,
      description: '',
      color,
      sort: folderSortCounter,
      flags: {},
      _stats: stats(),
      _key: `!folders!${folderId}`,
    });
    FOLDER_IDS.set(pathKey, folderId);
    parent = folderId;
  }
  return parent;
}

// ---------- Materials ----------
const MATERIALS = [
  {
    slug: 'cloth-light', name: 'Лёгкая ткань', category: 'fabric', hardness: 0.5,
    integrityPerThickness: 2, breachCapacityPerThickness: 0, weightPerThickness: 0.2,
    img: 'clothing.svg/clothes.svg',
    resistance: { ballistic: 10, concussive: 10, piercing: 5, cutting: 20, thermal: 20, laser: 10, plasma: 5, electric: 5, sonic: 0, radiation: 0, chemical: 5 },
    wear: { ballistic: 300, concussive: 100, piercing: 300, cutting: 300, thermal: 500, laser: 500, plasma: 500, electric: 5, sonic: 10, radiation: 0, chemical: 300 },
    conductance: { ballistic: [{ type: 'concussive', fraction: 0.2 }] },
  },
  {
    slug: 'cloth-heavy', name: 'Плотная ткань', category: 'fabric', hardness: 2,
    integrityPerThickness: 8, breachCapacityPerThickness: 0, weightPerThickness: 0.5,
    img: 'clothing.svg/clothes.svg',
    resistance: { ballistic: 20, concussive: 25, piercing: 15, cutting: 40, thermal: 30, laser: 15, plasma: 10, electric: 10, sonic: 10, radiation: 0, chemical: 15 },
    wear: { ballistic: 200, concussive: 80, piercing: 200, cutting: 150, thermal: 300, laser: 400, plasma: 450, electric: 5, sonic: 10, radiation: 0, chemical: 200 },
    conductance: { ballistic: [{ type: 'concussive', fraction: 0.25 }] },
  },
  {
    slug: 'leather', name: 'Кожа', category: 'fabric', hardness: 3,
    integrityPerThickness: 12, breachCapacityPerThickness: 0, weightPerThickness: 0.9,
    img: 'armor.svg/leather-armor.svg',
    resistance: { ballistic: 25, concussive: 35, piercing: 30, cutting: 55, thermal: 35, laser: 20, plasma: 15, electric: 15, sonic: 15, radiation: 0, chemical: 25 },
    wear: { ballistic: 120, concussive: 50, piercing: 100, cutting: 80, thermal: 200, laser: 250, plasma: 300, electric: 5, sonic: 10, radiation: 0, chemical: 120 },
    conductance: { ballistic: [{ type: 'concussive', fraction: 0.3 }] },
  },
  {
    slug: 'polymer', name: 'Полимер', category: 'composite', hardness: 4,
    integrityPerThickness: 15, breachCapacityPerThickness: 0, weightPerThickness: 1.1,
    img: 'armor.svg/kevlar.svg',
    resistance: { ballistic: 35, concussive: 40, piercing: 40, cutting: 45, thermal: 40, laser: 35, plasma: 30, electric: 40, sonic: 20, radiation: 5, chemical: 50 },
    wear: { ballistic: 90, concussive: 40, piercing: 80, cutting: 70, thermal: 120, laser: 150, plasma: 200, electric: 10, sonic: 10, radiation: 0, chemical: 40 },
    conductance: {},
  },
  {
    slug: 'foam', name: 'Импакт-пена', category: 'fabric', hardness: 6,
    integrityPerThickness: 10, breachCapacityPerThickness: 0, weightPerThickness: 0.4,
    img: 'armor.svg/kevlar.svg',
    resistance: { ballistic: 30, concussive: 90, piercing: 20, cutting: 25, thermal: 40, laser: 25, plasma: 20, electric: 5, sonic: 50, radiation: 0, chemical: 20 },
    wear: { ballistic: 80, concussive: 20, piercing: 100, cutting: 100, thermal: 150, laser: 200, plasma: 250, electric: 0, sonic: 5, radiation: 0, chemical: 100 },
    conductance: { ballistic: [{ type: 'concussive', fraction: 0.1 }] },
  },
  {
    slug: 'kevlar', name: 'Кевлар', category: 'fabric', hardness: 20,
    integrityPerThickness: 30, breachCapacityPerThickness: 30, weightPerThickness: 1.4,
    img: 'armor.svg/kevlar.svg',
    resistance: { ballistic: 100, concussive: 55, piercing: 35, cutting: 70, thermal: 25, laser: 25, plasma: 30, electric: 10, sonic: 40, radiation: 5, chemical: 20 },
    wear: { ballistic: 30, concussive: 15, piercing: 50, cutting: 50, thermal: 100, laser: 90, plasma: 140, electric: 0, sonic: 5, radiation: 0, chemical: 150 },
    conductance: { ballistic: [{ type: 'concussive', fraction: 0.5 }], piercing: [{ type: 'concussive', fraction: 0.3 }] },
  },
  {
    slug: 'steel-plate', name: 'Стальная пластина', category: 'metal', hardness: 10,
    integrityPerThickness: 50, breachCapacityPerThickness: 0, weightPerThickness: 7.85,
    img: 'armor.svg/metal-scales.svg',
    resistance: { ballistic: 100, concussive: 90, piercing: 90, cutting: 120, thermal: 45, laser: 35, plasma: 55, electric: 20, sonic: 90, radiation: 60, chemical: 25 },
    wear: { ballistic: 40, concussive: 30, piercing: 40, cutting: 20, thermal: 50, laser: 55, plasma: 160, electric: 5, sonic: 5, radiation: 0, chemical: 100 },
    conductance: { electric: [{ type: 'electric', fraction: 0.9 }] },
  },
  {
    slug: 'ceramic-plate', name: 'Керамическая плита', category: 'composite', hardness: 22,
    integrityPerThickness: 25, breachCapacityPerThickness: 20, weightPerThickness: 3.2,
    img: 'armor.svg/kevlar.svg',
    resistance: { ballistic: 120, concussive: 40, piercing: 100, cutting: 80, thermal: 50, laser: 45, plasma: 40, electric: 15, sonic: 30, radiation: 10, chemical: 30 },
    wear: { ballistic: 80, concussive: 120, piercing: 70, cutting: 60, thermal: 80, laser: 70, plasma: 180, electric: 5, sonic: 20, radiation: 0, chemical: 80 },
    conductance: { ballistic: [{ type: 'concussive', fraction: 0.35 }] },
  },
  {
    slug: 'combat-composite', name: 'Боевой композит', category: 'composite', hardness: 12,
    integrityPerThickness: 60, breachCapacityPerThickness: 0, weightPerThickness: 4.5,
    img: 'armor.svg/kevlar.svg',
    resistance: { ballistic: 110, concussive: 80, piercing: 95, cutting: 100, thermal: 55, laser: 50, plasma: 45, electric: 25, sonic: 60, radiation: 20, chemical: 40 },
    wear: { ballistic: 35, concussive: 25, piercing: 35, cutting: 30, thermal: 60, laser: 50, plasma: 130, electric: 5, sonic: 5, radiation: 0, chemical: 80 },
    conductance: {},
  },
  {
    slug: 'ablative', name: 'Аблятивное покрытие', category: 'ablative', hardness: 12,
    integrityPerThickness: 20, breachCapacityPerThickness: 0, weightPerThickness: 1.8,
    img: 'armor.svg/kevlar.svg',
    resistance: { ballistic: 20, concussive: 30, piercing: 25, cutting: 30, thermal: 90, laser: 120, plasma: 80, electric: 20, sonic: 20, radiation: 15, chemical: 40 },
    wear: { ballistic: 150, concussive: 80, piercing: 120, cutting: 100, thermal: 40, laser: 30, plasma: 50, electric: 10, sonic: 10, radiation: 0, chemical: 60 },
    conductance: { laser: [{ type: 'thermal', fraction: 0.4 }] },
  },
  {
    slug: 'tank-composite', name: 'Танковый композит', category: 'composite', hardness: 25,
    integrityPerThickness: 100, breachCapacityPerThickness: 0, weightPerThickness: 12,
    img: 'armor.svg/metal-scales.svg',
    resistance: { ballistic: 140, concussive: 110, piercing: 130, cutting: 140, thermal: 70, laser: 55, plasma: 50, electric: 30, sonic: 100, radiation: 80, chemical: 50 },
    wear: { ballistic: 20, concussive: 15, piercing: 20, cutting: 15, thermal: 40, laser: 45, plasma: 120, electric: 5, sonic: 5, radiation: 0, chemical: 60 },
    conductance: {},
  },
  {
    slug: 'skin', name: 'Кожа (ткань тела)', category: 'biological', hardness: 1,
    integrityPerThickness: 5, breachCapacityPerThickness: 0, weightPerThickness: 1,
    img: 'clothing.svg/clothes.svg',
    resistance: { ballistic: 15, concussive: 40, piercing: 20, cutting: 25, thermal: 40, laser: 30, plasma: 25, electric: 30, sonic: 40, radiation: 10, chemical: 30 },
    wear: { ballistic: 100, concussive: 40, piercing: 100, cutting: 120, thermal: 80, laser: 90, plasma: 120, electric: 20, sonic: 10, radiation: 5, chemical: 100 },
    conductance: {},
  },
  {
    slug: 'muscle', name: 'Мышцы', category: 'biological', hardness: 2,
    integrityPerThickness: 8, breachCapacityPerThickness: 0, weightPerThickness: 1.1,
    img: 'clothing.svg/clothes.svg',
    resistance: { ballistic: 25, concussive: 50, piercing: 30, cutting: 35, thermal: 45, laser: 35, plasma: 30, electric: 35, sonic: 45, radiation: 10, chemical: 35 },
    wear: { ballistic: 80, concussive: 30, piercing: 80, cutting: 90, thermal: 70, laser: 80, plasma: 100, electric: 15, sonic: 10, radiation: 5, chemical: 80 },
    conductance: {},
  },
  {
    slug: 'bone', name: 'Кость', category: 'biological', hardness: 8,
    integrityPerThickness: 20, breachCapacityPerThickness: 0, weightPerThickness: 1.8,
    img: 'armor.svg/metal-scales.svg',
    resistance: { ballistic: 60, concussive: 70, piercing: 55, cutting: 50, thermal: 50, laser: 40, plasma: 35, electric: 20, sonic: 60, radiation: 15, chemical: 40 },
    wear: { ballistic: 40, concussive: 25, piercing: 45, cutting: 50, thermal: 50, laser: 60, plasma: 80, electric: 5, sonic: 10, radiation: 0, chemical: 50 },
    conductance: {},
  },
];

// ---------- Calibers ----------
/** @type {Record<string, {label:string, dmg:number, ap:number, half:number, type?:string}>} */
const CAL = {
  '9mm': { label: '9×19', dmg: 100, ap: 25, half: 45 },
  '5.7': { label: '5.7×28', dmg: 95, ap: 55, half: 55 },
  '44mag': { label: '.44 Mag', dmg: 125, ap: 30, half: 30 },
  '12ga-slug': { label: '12к пуля', dmg: 140, ap: 40, half: 25 },
  '12ga-buck': {
    label: '12к дробь', dmg: 35, ap: 15, half: 12, type: 'ballistic',
    multishot: { enabled: true, count: 6, coneDegrees: 20 },
  },
  '7.62x39': { label: '7.62×39', dmg: 130, ap: 50, half: 80 },
  '5.56': { label: '5.56×45', dmg: 115, ap: 60, half: 90 },
  '7.62x54r': { label: '7.62×54R', dmg: 160, ap: 70, half: 120 },
  '338': { label: '.338', dmg: 200, ap: 85, half: 140 },
  '50bmg': { label: '.50 BMG', dmg: 280, ap: 110, half: 200 },
  'plasma-cell': { label: 'Плазменная ячейка', dmg: 160, ap: 5, half: 18, type: 'plasma' },
  'rocket-heat': {
    label: 'Ракета HEAT', dmg: 220, ap: 100, half: 0, type: 'ballistic',
    splash: { enabled: true, radius: 1, unit: 'grid' }, noMag: true,
  },
  'rocket-he': {
    label: 'Ракета HE', dmg: 160, ap: 25, half: 0, type: 'concussive',
    splash: { enabled: true, radius: 3, unit: 'grid' }, noMag: true,
  },
};

const MAG_CAPS = {
  '9mm': 15, '5.7': 20, '7.62x39': 30, '5.56': 30, '7.62x54r': 10, '338': 5, '50bmg': 5,
  '12ga-slug': 8, '12ga-buck': 8, 'plasma-cell': 20,
};

// ---------- Build ----------
function wipeOutDir() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(outDir)) {
    if (name.endsWith('.json')) fs.unlinkSync(path.join(outDir, name));
  }
}

function materialFolder(category) {
  const map = {
    fabric: 'Ткани',
    metal: 'Металлы',
    composite: 'Композиты',
    ablative: 'Аблятив',
    biological: 'Биологические',
  };
  return ensureFolder(['Материалы', map[category] || 'Прочее'], '#6b7280');
}

function emitMaterials() {
  MATERIALS.forEach((m, i) => {
    const mid = id(`mat:${m.slug}`);
    writeItem(`SH_Material_${m.slug}_${mid}`, {
      name: m.name,
      type: 'material',
      _id: mid,
      img: ICON(m.img),
      system: {
        description: `<p>${m.name} (${m.slug})</p>`,
        materialId: m.slug,
        category: m.category,
        hardness: m.hardness,
        integrityPerThickness: m.integrityPerThickness,
        breachCapacityPerThickness: m.breachCapacityPerThickness ?? 0,
        weightPerThickness: m.weightPerThickness,
        resistance: m.resistance,
        wear: m.wear,
        conductance: m.conductance || {},
        selfInduction: {},
        degradation: {},
      },
      effects: [],
      folder: materialFolder(m.category),
      sort: (i + 1) * 10000,
      ownership: { default: 0 },
      flags: {},
      _stats: stats(),
      _key: `!items!${mid}`,
    });
  });
}

function layersFor(slots, layers) {
  return slots.map((slotRef) => ({ slotRef, layers: layers.map((l) => ({ ...l })) }));
}

function emitWearable({ key, name, img, weight, parts, desc, sort, folderPath }) {
  const wid = id(`wear:${key}`);
  writeItem(`SH_Wear_${key}_${wid}`, {
    name,
    type: 'item',
    _id: wid,
    img: ICON(img),
    system: {
      description: `<p>${desc || name}</p>`,
      implantReplaceOrgan: null,
      actions: [],
      quantity: 1,
      weight,
      formula: '',
      equipped: false,
      held: false,
      anatomyId: 'humanoid',
      coveredParts: parts,
      defaultActions: defaultActions(),
      modifiers: { abilities: [], derived: [], params: [] },
      itemTags: { isArmor: true, isActions: false, isModifiers: false },
    },
    effects: [],
    folder: ensureFolder(folderPath, '#78716c'),
    sort,
    ownership: { default: 0 },
    flags: {},
    _stats: stats(),
    _key: `!items!${wid}`,
  });
  return wid;
}

function emitWearables() {
  const torso = ['chest', 'abdomen', 'back'];
  const legs = ['leftThigh', 'rightThigh', 'leftShin', 'rightShin'];
  const arms = ['leftArm', 'rightArm'];
  const clothes = ['Броня', 'Одежда', 'Комплекты'];
  const vests = ['Броня', 'Жилеты'];
  const helms = ['Броня', 'Шлемы'];

  emitWearable({
    key: 'casual', name: 'Повседневная одежда', img: 'clothing.svg/t-shirt.svg', weight: 1.2, sort: 10000,
    folderPath: clothes, desc: 'Футболка + штаны (комплект).',
    parts: layersFor([...torso, ...legs], [{ material: 'cloth-light', thickness: 1 }]),
  });
  emitWearable({
    key: 'work', name: 'Рабочая одежда', img: 'clothing.svg/lab-coat.svg', weight: 2.0, sort: 20000,
    folderPath: clothes, desc: 'Плотный рабочий комплект.',
    parts: layersFor([...torso, ...legs, ...arms], [{ material: 'cloth-heavy', thickness: 1 }]),
  });
  emitWearable({
    key: 'street', name: 'Уличный комплект', img: 'clothing.svg/trousers.svg', weight: 2.4, sort: 30000,
    folderPath: clothes, desc: 'Куртка + джинсы.',
    parts: [
      ...layersFor(torso, [{ material: 'cloth-heavy', thickness: 2 }]),
      ...layersFor(legs, [{ material: 'cloth-heavy', thickness: 1 }]),
    ],
  });
  emitWearable({
    key: 'winter', name: 'Зимний комплект', img: 'clothing.svg/trousers.svg', weight: 3.5, sort: 40000,
    folderPath: clothes, desc: 'Утеплённая одежда (пена гасит удар, не пули).',
    parts: layersFor([...torso, ...legs, ...arms], [
      { material: 'cloth-heavy', thickness: 2 },
      { material: 'foam', thickness: 2 },
    ]),
  });
  emitWearable({
    key: 'coverall', name: 'Комбинезон', img: 'clothing.svg/clothes.svg', weight: 2.2, sort: 50000,
    folderPath: clothes, desc: 'Лёгкое равномерное покрытие корпуса и ног.',
    parts: layersFor([...torso, ...legs, ...arms], [{ material: 'cloth-heavy', thickness: 1 }]),
  });
  emitWearable({
    key: 'leather-jacket', name: 'Кожаный комплект', img: 'armor.svg/leather-armor.svg', weight: 2.8, sort: 60000,
    folderPath: clothes, desc: 'Кожаная куртка + штаны.',
    parts: [
      ...layersFor(torso, [{ material: 'leather', thickness: 2 }]),
      ...layersFor(legs, [{ material: 'leather', thickness: 1 }]),
    ],
  });

  emitWearable({
    key: 'vest-light', name: 'Бронежилет (лёгкий)', img: 'armor.svg/kevlar-vest.svg', weight: 3, sort: 110000,
    folderPath: vests, desc: 'Мягкий кевлар на торс.',
    parts: layersFor(torso, [{ material: 'kevlar', thickness: 1 }]),
  });
  emitWearable({
    key: 'vest-mid', name: 'Бронежилет (средний)', img: 'armor.svg/kevlar-vest.svg', weight: 7, sort: 120000,
    folderPath: vests, desc: 'Сталь + кевлар.',
    parts: layersFor(torso, [
      { material: 'steel-plate', thickness: 3 },
      { material: 'kevlar', thickness: 1 },
    ]),
  });
  emitWearable({
    key: 'vest-heavy', name: 'Бронежилет (тяжёлый)', img: 'armor.svg/kevlar-vest.svg', weight: 12, sort: 130000,
    folderPath: vests, desc: 'Сталь + кевлар + пена.',
    parts: layersFor(torso, [
      { material: 'steel-plate', thickness: 5 },
      { material: 'kevlar', thickness: 1 },
      { material: 'foam', thickness: 4 },
    ]),
  });
  emitWearable({
    key: 'vest-ceramic', name: 'Бронежилет (керамика)', img: 'armor.svg/kevlar-vest.svg', weight: 9, sort: 140000,
    folderPath: vests, desc: 'Керамические плиты + кевлар.',
    parts: layersFor(torso, [
      { material: 'ceramic-plate', thickness: 4 },
      { material: 'kevlar', thickness: 2 },
    ]),
  });
  emitWearable({
    key: 'combat-armor', name: 'Боевая броня (торс)', img: 'armor.svg/kevlar-vest.svg', weight: 14, sort: 150000,
    folderPath: vests, desc: 'Композит на торс; шлем отдельно.',
    parts: layersFor(torso, [{ material: 'combat-composite', thickness: 6 }]),
  });

  emitWearable({
    key: 'helm-light', name: 'Шлем (лёгкий)', img: 'hat.svg/visored-helm.svg', weight: 1.2, sort: 210000,
    folderPath: helms, desc: 'Полимер + кевлар.',
    parts: layersFor(['head'], [
      { material: 'polymer', thickness: 2 },
      { material: 'kevlar', thickness: 1 },
    ]),
  });
  emitWearable({
    key: 'helm-mid', name: 'Шлем (средний)', img: 'hat.svg/visored-helm.svg', weight: 2.0, sort: 220000,
    folderPath: helms, desc: 'Сталь + кевлар.',
    parts: layersFor(['head'], [
      { material: 'steel-plate', thickness: 2 },
      { material: 'kevlar', thickness: 1 },
    ]),
  });
  emitWearable({
    key: 'helm-heavy', name: 'Шлем (тяжёлый)', img: 'hat.svg/visored-helm.svg', weight: 3.2, sort: 230000,
    folderPath: helms, desc: 'Композит + аблятив.',
    parts: layersFor(['head'], [
      { material: 'combat-composite', thickness: 3 },
      { material: 'ablative', thickness: 2 },
    ]),
  });
}

/** @type {Record<string, {round:string, mag?:string, magS?:string}>} */
const AMMO_IDS = {};

function emitAmmoItem({ key, name, img, quantity, weight, folder, sort, ammo, tags = {} }) {
  const aid = id(`ammo:${key}`);
  writeItem(`SH_Ammo_${key}_${aid}`, {
    name,
    type: 'item',
    _id: aid,
    img: ICON(img),
    system: {
      description: `<p>${name}</p>`,
      implantReplaceOrgan: null,
      actions: [],
      quantity,
      weight,
      formula: '',
      equipped: false,
      held: false,
      anatomyId: '',
      coveredParts: [],
      defaultActions: defaultActions(),
      modifiers: { abilities: [], derived: [], params: [] },
      itemTags: {
        isArmor: false, isActions: false, isModifiers: false,
        isWeapon: false, isAmmo: true, isContainer: !!tags.isContainer,
      },
      weapon: {
        version: 3,
        ergonomics: emptyErgo(0),
        lines: [],
        state: { activeLineId: '', activeModeId: '', ready: false },
        ammo,
      },
      storage: { enabled: false, version: 1, slots: {}, contents: [] },
      container: tags.isContainer
        ? { contents: [], limits: { maxItems: ammo.capacity || 0, maxWeight: 0 } }
        : { contents: [], limits: { maxItems: 0, maxWeight: 0 } },
    },
    effects: [],
    folder,
    sort,
    ownership: { default: 0 },
    flags: {},
    _stats: stats(),
    _key: `!items!${aid}`,
  });
  return aid;
}

function emitCaliberKit(calKey, sortBase) {
  const c = CAL[calKey];
  const dtype = c.type || 'ballistic';
  const isRocket = calKey.startsWith('rocket-');
  const isPlasma = calKey.startsWith('plasma');
  const calFolderLabel = c.label;
  const roundFolder = isRocket
    ? ensureFolder(['Боеприпасы', 'Ракеты'], '#a16207')
    : isPlasma
      ? ensureFolder(['Боеприпасы', 'Плазма', 'Ячейки'], '#a16207')
      : ensureFolder(['Боеприпасы', 'Патроны', calFolderLabel], '#a16207');

  const ms = c.multishot || { enabled: false, count: 1, coneDegrees: 0 };
  const splash = c.splash || { enabled: false, radius: 0, unit: 'grid' };

  const roundId = emitAmmoItem({
    key: `${calKey}_round`,
    name: isRocket ? c.label : `Патрон ${c.label}`,
    img: isRocket ? 'weapon.svg/missile-pod.svg' : 'weapon.svg/bullets.svg',
    quantity: isRocket ? 6 : 60,
    weight: isRocket ? 2.5 : 0.02,
    folder: roundFolder,
    sort: sortBase,
    ammo: {
      damage: [dmg(dtype, c.dmg, c.ap)],
      caliber: isRocket ? 'rocket' : calKey,
      connector: { enabled: false, value: '' },
      charge: chargeOff(),
      capacity: 0,
      consume: true,
      falloff: falloff(c.half),
      multishot: ms,
      onHitSplash: splash,
    },
  });

  const out = { round: roundId };
  const cap = MAG_CAPS[calKey];
  if (cap && !c.noMag) {
    const connector = `${calKey}-mag`;
    const magFolder = isPlasma
      ? ensureFolder(['Боеприпасы', 'Плазма', 'Ячейки'], '#a16207')
      : ensureFolder(['Боеприпасы', 'Магазины', calFolderLabel], '#a16207');
    const magSFolder = isPlasma
      ? ensureFolder(['Боеприпасы', 'Плазма', 'Ячейки-S'], '#a16207')
      : ensureFolder(['Боеприпасы', 'Магазины-S', calFolderLabel], '#a16207');
    out.mag = emitAmmoItem({
      key: `${calKey}_mag`,
      name: isPlasma ? `Ячейка ${c.label}` : `Магазин ${c.label}`,
      img: 'weapon.svg/ammo-box.svg',
      quantity: 1,
      weight: 0.4,
      folder: magFolder,
      sort: sortBase + 100,
      tags: { isContainer: true },
      ammo: {
        damage: [],
        caliber: calKey,
        connector: { enabled: true, value: connector },
        charge: chargeOff(),
        capacity: cap,
        consume: false,
        falloff: { enabled: false, halfDistance: 0 },
        multishot: { enabled: false, count: 1, coneDegrees: 0 },
        onHitSplash: { enabled: false, radius: 0, unit: 'grid' },
      },
    });
    out.magS = emitAmmoItem({
      key: `${calKey}_mag_s`,
      name: isPlasma ? `Ячейка ${c.label}-S` : `Магазин ${c.label}-S`,
      img: 'weapon.svg/ammo-box.svg',
      quantity: 1,
      weight: 0.4,
      folder: magSFolder,
      sort: sortBase + 200,
      ammo: {
        damage: [dmg(dtype, c.dmg, c.ap)],
        caliber: `${calKey}-s`,
        connector: { enabled: false, value: '' },
        charge: {
          enabled: true, max: cap, current: cap, allowFractional: false,
          clampNonNegative: true, scaleDamageFromSpent: false, overheatNotify: false,
          changePerShot: { sign: '-', formula: '1' },
          changePerSecond: { sign: '+', formula: '0' },
        },
        capacity: 0,
        consume: false,
        falloff: falloff(c.half),
        multishot: ms,
        onHitSplash: splash,
      },
    });
  }
  AMMO_IDS[calKey] = out;
}

const HEAT = {};

function emitHeatSinks() {
  const sizes = [
    { key: 'xs', name: 'Теплообменник XS', max: 20, perShot: 5, cool: 1, sort: 900000 },
    { key: 's', name: 'Теплообменник S', max: 40, perShot: 4, cool: 1, sort: 910000 },
    { key: 'm', name: 'Теплообменник M', max: 80, perShot: 4, cool: 1.5, sort: 920000 },
    { key: 'l', name: 'Теплообменник L', max: 140, perShot: 5, cool: 2, sort: 930000 },
    { key: 'xl', name: 'Теплообменник XL', max: 240, perShot: 6, cool: 3, sort: 940000 },
  ];
  const folder = ensureFolder(['Боеприпасы', 'Теплообменники'], '#a16207');
  for (const s of sizes) {
    HEAT[s.key] = emitAmmoItem({
      key: `heat_${s.key}`,
      name: s.name,
      img: 'energy.svg/energise.svg',
      quantity: 1,
      weight: 0.5,
      folder,
      sort: s.sort,
      ammo: {
        damage: [],
        caliber: `laser-heat-${s.key}`,
        connector: { enabled: false, value: '' },
        charge: {
          enabled: true, max: s.max, current: 0, allowFractional: true,
          clampNonNegative: true, scaleDamageFromSpent: false, overheatNotify: true,
          changePerShot: { sign: '+', formula: String(s.perShot) },
          changePerSecond: { sign: '-', formula: String(s.cool) },
        },
        capacity: 0,
        consume: false,
        falloff: { enabled: false, halfDistance: 0 },
        multishot: { enabled: false, count: 1, coneDegrees: 0 },
        onHitSplash: { enabled: false, radius: 0, unit: 'grid' },
      },
    });
  }
}

function emitAmmo() {
  const keys = Object.keys(CAL);
  keys.forEach((k, i) => emitCaliberKit(k, (i + 1) * 1000));
  // Plasma cells also under Боеприпасы/Плазма via mag folders already; add alias folder items stay in Magazines
  ensureFolder(['Боеприпасы', 'Плазма'], '#a16207');
  emitHeatSinks();
}

function weaponDoc({ key, name, img, weight, ergoOverall, readying, lines, sort, desc, folderPath }) {
  const wid = id(`wpn:${key}`);
  const activeLine = lines[0];
  const activeMode = activeLine.modes[0];
  writeItem(`SH_Wpn_${key}_${wid}`, {
    name,
    type: 'item',
    _id: wid,
    img: ICON(img),
    system: {
      description: `<p>${desc || name}</p>`,
      implantReplaceOrgan: null,
      actions: [],
      quantity: 1,
      weight,
      formula: '',
      equipped: false,
      held: false,
      anatomyId: '',
      coveredParts: [],
      defaultActions: defaultActions(),
      modifiers: { abilities: [], derived: [], params: [] },
      itemTags: {
        isArmor: false, isActions: false, isModifiers: false,
        isWeapon: true, isAmmo: false, isContainer: false,
      },
      weapon: {
        version: 3,
        ergonomics: {
          ...emptyErgo(readying),
          overall: ergoOverall,
        },
        lines,
        state: {
          activeLineId: activeLine.id,
          activeModeId: activeMode.id,
          ready: false,
        },
        ammo: {
          damage: [],
          caliber: '',
          connector: { enabled: false, value: '' },
          charge: chargeOff(),
          capacity: 0,
          consume: true,
          falloff: { enabled: false, halfDistance: 0 },
          multishot: { enabled: false, count: 1, coneDegrees: 0 },
          onHitSplash: { enabled: false, radius: 0, unit: 'grid' },
        },
      },
    },
    effects: [],
    folder: ensureFolder(folderPath || ['Оружие'], '#b91c1c'),
    sort,
    ownership: { default: 0 },
    flags: {},
    _stats: stats(),
    _key: `!items!${wid}`,
  });
  return wid;
}

function lineBase(idSeed, name, opts = {}) {
  return {
    id: id(idSeed),
    name,
    trajectoryKind: opts.trajectoryKind || 'simple',
    simpleLimit: { enabled: !!opts.limit, value: opts.limit || 0, unit: 'grid' },
    payloadId: opts.payloadId || '',
    aiming: opts.aiming ?? 18,
    trigger: opts.trigger ?? 3,
    energyMult: { enabled: !!opts.energyMult, value: opts.energyMult || 100 },
    spread: { enabled: opts.spread != null && opts.spread !== false, value: opts.spread || 0 },
    recoil: { enabled: opts.recoil != null && opts.recoil !== false, value: opts.recoil || 0 },
    enterCost: { enabled: !!opts.enterCost, value: opts.enterCost || 0 },
    exitCost: { enabled: !!opts.exitCost, value: opts.exitCost || 0 },
    damage: opts.damage || [],
    ammoBlocks: opts.ammoBlocks || [],
    modes: opts.modes || [],
    multishot: opts.multishot || { enabled: false, count: 1, coneDegrees: 0 },
  };
}

function blockExternalCharge(idSeed, caliber, reloadAp = 20) {
  return {
    id: id(idSeed),
    type: 'externalCharge',
    capacity: 1,
    loadAmount: 1,
    chamberEnabled: false,
    autoFeed: false,
    caliber,
    connector: '',
    search: searchAuto(),
    apActions: apCharge(reloadAp),
    damage: [],
    runtime: runtimeEmpty(),
  };
}

function blockExternalMag(idSeed, caliber, capacity) {
  return {
    id: id(idSeed),
    type: 'externalMagazine',
    capacity,
    loadAmount: 1,
    chamberEnabled: true,
    autoFeed: true,
    caliber,
    connector: `${caliber}-mag`,
    search: searchAuto(),
    apActions: apMag(),
    damage: [],
    runtime: runtimeEmpty(),
  };
}

function blockInternalMag(idSeed, caliber, capacity) {
  return {
    id: id(idSeed),
    type: 'internalMagazine',
    capacity,
    loadAmount: 1,
    chamberEnabled: true,
    autoFeed: true,
    caliber,
    connector: '',
    search: searchAuto(),
    apActions: apMag(),
    damage: [],
    runtime: runtimeEmpty(),
  };
}

function kineticS({ key, name, img, cal, ergo, weight, sort, modes, folderPath, extras = {} }) {
  const c = CAL[cal];
  const energyMult = extras.energyMult;
  const chargeCaliber = extras.chargeCaliber || `${cal}-s`;
  const fireModes = modes.map((m) => mode(`${key}:${m}`, m === 'auto' ? 'Авто' : 'Одиночный', m, {
    fireDelayAp: m === 'auto' ? (extras.autoDelay ?? 4) : 5,
    enterCost: extras.modeEnter?.[m],
    exitCost: extras.modeExit?.[m],
  }));
  return weaponDoc({
    key, name, img, weight, ergoOverall: ergo, readying: extras.readying ?? 6, sort, folderPath,
    desc: extras.desc || `${name}. Калибр ${c.label}, магазин -S.`,
    lines: [lineBase(`${key}:line`, 'Ствол', {
      aiming: extras.aiming ?? 16,
      trigger: extras.trigger ?? 3,
      spread: extras.spread ?? 2,
      recoil: extras.recoil ?? 3,
      energyMult,
      multishot: extras.multishot,
      ammoBlocks: [blockExternalCharge(`${key}:block`, chargeCaliber)],
      modes: fireModes,
    })],
  });
}

function emitWeapons() {
  let sort = 10000;
  const fp = (...parts) => ['Оружие', ...parts];

  // Pistols
  kineticS({
    key: 'glock', name: 'Глок', img: 'weapon.svg/pistol-gun.svg', cal: '9mm', ergo: 135, weight: 0.9, sort,
    folderPath: fp('Огнестрельное', 'Пистолеты'), modes: ['single'],
    extras: { readying: 3, aiming: 10, spread: 3, recoil: 4, desc: 'Простой пистолет. Хедшот ~100.' },
  });
  sort += 10000;
  kineticS({
    key: 'fiveSeven', name: 'Five-seveN', img: 'weapon.svg/pistol-gun.svg', cal: '5.7', ergo: 130, weight: 0.85, sort,
    folderPath: fp('Огнестрельное', 'Пистолеты'), modes: ['single'],
    extras: { readying: 3, aiming: 10, spread: 2, recoil: 3 },
  });
  sort += 10000;
  weaponDoc({
    key: 'revolver44', name: 'Револьвер .44', img: 'weapon.svg/revolver.svg', weight: 1.2, ergoOverall: 125, readying: 4, sort,
    folderPath: fp('Огнестрельное', 'Пистолеты'),
    desc: 'Тяжёлый револьвер. Зарядка по патрону.',
    lines: [lineBase('revolver44:line', 'Ствол', {
      aiming: 12, spread: 4, recoil: 6,
      ammoBlocks: [blockInternalMag('revolver44:block', '44mag', 6)],
      modes: [mode('revolver44:single', 'Одиночный', 'single')],
    })],
  });
  sort += 10000;

  // SMGs
  kineticS({
    key: 'uzi', name: 'УЗИ', img: 'weapon.svg/autogun.svg', cal: '9mm', ergo: 125, weight: 3.2, sort,
    folderPath: fp('Огнестрельное', 'ПП'), modes: ['single', 'auto'],
    extras: { energyMult: 108, spread: 5, recoil: 6, autoDelay: 3 },
  });
  sort += 10000;
  kineticS({
    key: 'mp5', name: 'MP5', img: 'weapon.svg/autogun.svg', cal: '9mm', ergo: 115, weight: 3.0, sort,
    folderPath: fp('Огнестрельное', 'ПП'), modes: ['single', 'auto'],
    extras: { energyMult: 110, spread: 2, recoil: 3 },
  });
  sort += 10000;
  kineticS({
    key: 'p90', name: 'P90', img: 'weapon.svg/autogun.svg', cal: '5.7', ergo: 110, weight: 2.8, sort,
    folderPath: fp('Огнестрельное', 'ПП'), modes: ['single', 'auto'],
    extras: { energyMult: 112, spread: 2, recoil: 3 },
  });
  sort += 10000;

  // Shotguns — default buck (multishot on ammo); line.coneDegrees widens the fan per barrel
  for (const cfg of [
    { key: 'sawed', name: 'Обрез', img: 'weapon.svg/sawed-off-shotgun.svg', ergo: 130, cap: 2, spread: 3, recoil: 10, weight: 2.5, cone: 35 },
    { key: 'double', name: 'Двустволка', img: 'weapon.svg/shotgun.svg', ergo: 105, cap: 2, spread: 2, recoil: 7, weight: 3.2, cone: 18 },
    { key: 'pump', name: 'Помповый дробовик', img: 'weapon.svg/shotgun.svg', ergo: 100, cap: 6, spread: 2, recoil: 7, weight: 3.6, cone: 22 },
  ]) {
    weaponDoc({
      key: cfg.key, name: cfg.name, img: cfg.img, weight: cfg.weight, ergoOverall: cfg.ergo, readying: 6, sort,
      folderPath: fp('Огнестрельное', 'Дробовики'),
      desc: `${cfg.name}. По умолчанию 12к дробь (мультиснаряд); пуля — отдельный патрон.`,
      lines: [lineBase(`${cfg.key}:line`, 'Ствол', {
        aiming: 14, spread: cfg.spread, recoil: cfg.recoil,
        multishot: { enabled: false, count: 1, coneDegrees: cfg.cone },
        ammoBlocks: [blockInternalMag(`${cfg.key}:block`, '12ga-buck, 12ga-slug', cfg.cap)],
        modes: [mode(`${cfg.key}:single`, 'Одиночный', 'single', { fireDelayAp: 6 })],
      })],
    });
    sort += 10000;
  }
  kineticS({
    key: 'saiga', name: 'Сайга', img: 'weapon.svg/shotgun.svg', cal: '12ga-buck', ergo: 95, weight: 3.8, sort,
    folderPath: fp('Огнестрельное', 'Дробовики'), modes: ['single', 'auto'],
    extras: {
      spread: 2, recoil: 8, autoDelay: 5,
      multishot: { enabled: false, count: 1, coneDegrees: 20 },
      chargeCaliber: '12ga-buck-s, 12ga-slug-s',
      desc: 'Сайга. По умолчанию дробь -S; пуля -S совместима.',
    },
  });
  sort += 10000;
  kineticS({
    key: 'shotgunMg', name: 'Дробопулемёт', img: 'weapon.svg/chaingun.svg', cal: '12ga-buck', ergo: 70, weight: 8, sort,
    folderPath: fp('Огнестрельное', 'Дробовики'), modes: ['auto'],
    extras: {
      spread: 3, recoil: 12, autoDelay: 4, readying: 10,
      multishot: { enabled: false, count: 1, coneDegrees: 24 },
      chargeCaliber: '12ga-buck-s, 12ga-slug-s',
    },
  });
  sort += 10000;

  // Rifles
  weaponDoc({
    key: 'mosin', name: 'Мосин', img: 'weapon.svg/rifle.svg', weight: 4.2, ergoOverall: 105, readying: 7, sort,
    folderPath: fp('Огнестрельное', 'Винтовки'),
    desc: 'Винтовка под 7.62×54R.',
    lines: [lineBase('mosin:line', 'Ствол', {
      aiming: 22, spread: 1, recoil: 6,
      ammoBlocks: [blockInternalMag('mosin:block', '7.62x54r', 5)],
      modes: [mode('mosin:single', 'Одиночный', 'single', { fireDelayAp: 8 })],
    })],
  });
  sort += 10000;
  kineticS({
    key: 'carbine', name: 'Карабин', img: 'weapon.svg/rifle.svg', cal: '7.62x54r', ergo: 102, weight: 4.0, sort,
    folderPath: fp('Огнестрельное', 'Винтовки'), modes: ['single'],
    extras: { aiming: 24, spread: 1, recoil: 5, desc: 'Полуавто карабин под 7.62×54R.' },
  });
  sort += 10000;
  kineticS({
    key: 'ak', name: 'АК', img: 'weapon.svg/rifle.svg', cal: '7.62x39', ergo: 100, weight: 3.8, sort,
    folderPath: fp('Огнестрельное', 'Винтовки'), modes: ['single', 'auto'],
    extras: { aiming: 20, spread: 2, recoil: 4, desc: 'Якорь баланса. Штурмовая винтовка.' },
  });
  sort += 10000;
  kineticS({
    key: 'ar', name: 'AR', img: 'weapon.svg/rifle.svg', cal: '5.56', ergo: 103, weight: 3.4, sort,
    folderPath: fp('Огнестрельное', 'Винтовки'), modes: ['single', 'auto'],
    extras: { aiming: 22, spread: 1, recoil: 3 },
  });
  sort += 10000;

  // Snipers / MGs
  weaponDoc({
    key: 'bolt762', name: 'Болтовка', img: 'weapon.svg/rifle.svg', weight: 5.5, ergoOverall: 85, readying: 10, sort,
    folderPath: fp('Огнестрельное', 'Снайперское'),
    desc: 'Снайперская болтовая 7.62×54R.',
    lines: [lineBase('bolt762:line', 'Ствол', {
      aiming: 30, spread: 0, recoil: 8,
      ammoBlocks: [blockInternalMag('bolt762:block', '7.62x54r', 5)],
      modes: [mode('bolt762:single', 'Одиночный', 'single', { fireDelayAp: 12 })],
    })],
  });
  sort += 10000;
  kineticS({
    key: 'dmrA', name: 'DMR 7.62', img: 'weapon.svg/rifle.svg', cal: '7.62x54r', ergo: 88, weight: 5.0, sort,
    folderPath: fp('Огнестрельное', 'Снайперское'), modes: ['single'],
    extras: { aiming: 28, spread: 1, recoil: 6 },
  });
  sort += 10000;
  kineticS({
    key: 'dmrB', name: 'DMR .338', img: 'weapon.svg/rifle.svg', cal: '338', ergo: 80, weight: 6.2, sort,
    folderPath: fp('Огнестрельное', 'Снайперское'), modes: ['single'],
    extras: { aiming: 30, spread: 1, recoil: 8, readying: 10 },
  });
  sort += 10000;
  kineticS({
    key: 'barrett', name: 'Barrett .50', img: 'weapon.svg/rifle.svg', cal: '50bmg', ergo: 60, weight: 14, sort,
    folderPath: fp('Огнестрельное', 'Снайперское'), modes: ['single'],
    extras: { aiming: 32, spread: 1, recoil: 14, readying: 14 },
  });
  sort += 10000;
  kineticS({
    key: 'rpk', name: 'Ручной пулемёт', img: 'weapon.svg/minigun.svg', cal: '7.62x39', ergo: 75, weight: 8.5, sort,
    folderPath: fp('Огнестрельное', 'Пулемёты'), modes: ['auto'],
    extras: { aiming: 18, spread: 3, recoil: 6, autoDelay: 3, readying: 10 },
  });
  sort += 10000;

  weaponDoc({
    key: 'browning', name: 'Browning .50', img: 'weapon.svg/anti-aircraft-gun.svg', weight: 38, ergoOverall: 40, readying: 16, sort,
    folderPath: fp('Огнестрельное', 'Пулемёты'),
    desc: 'Стационарный пулемёт .50. Походный / стационарный режимы.',
    lines: [lineBase('browning:line', 'Ствол', {
      aiming: 20, spread: 3, recoil: 10,
      ammoBlocks: [blockExternalCharge('browning:block', '50bmg-s', 40)],
      modes: [
        mode('browning:march', 'Походный', 'auto', {
          fireDelayAp: 5, enterCost: 5, exitCost: 5,
          modifiers: [
            { id: id('browning:mod:ergo'), param: 'ergo.overall', op: 'set', value: 25, enabled: true, disableParam: false },
            { id: id('browning:mod:recoil'), param: 'line.recoil', op: 'set', value: 20, enabled: true, disableParam: false },
          ],
        }),
        mode('browning:deploy', 'Стационарный', 'auto', {
          fireDelayAp: 3, enterCost: 40, exitCost: 20,
          modifiers: [
            { id: id('browning:mod:spread'), param: 'line.spread', op: 'set', value: 1, enabled: true, disableParam: false },
          ],
        }),
      ],
    })],
  });
  sort += 10000;

  // Rocket launcher
  weaponDoc({
    key: 'rocketLauncher', name: 'Ракетница', img: 'weapon.svg/missile-pod.svg', weight: 7.5, ergoOverall: 70, readying: 12, sort,
    folderPath: fp('Тяжёлое', 'Ракетницы'),
    desc: 'Прямая траектория + splash с ракеты (HEAT / HE).',
    lines: [lineBase('rocketLauncher:line', 'Пусковая', {
      aiming: 16, spread: 2, recoil: 8,
      ammoBlocks: [blockInternalMag('rocketLauncher:block', 'rocket', 1)],
      modes: [mode('rocketLauncher:single', 'Одиночный', 'single', { fireDelayAp: 10 })],
    })],
  });
  sort += 10000;

  // Laser
  const lasers = [
    { key: 'stunner', name: 'Станнер', heat: 'xs', dmg: 50, ap: 35, ergo: 145, weight: 0.7, modes: ['single'], aiming: 8, spread: 1, folder: fp('Лазерное', 'Пистолеты') },
    { key: 'lasPistol', name: 'Лазерный пистолет', heat: 's', dmg: 110, ap: 40, ergo: 135, weight: 0.9, modes: ['single'], aiming: 10, spread: 1, folder: fp('Лазерное', 'Пистолеты') },
    { key: 'lasHeavyPistol', name: 'Лазерный тяжёлый пистолет', heat: 's', dmg: 135, ap: 40, ergo: 125, weight: 1.3, modes: ['single'], aiming: 12, spread: 2, folder: fp('Лазерное', 'Пистолеты') },
    { key: 'lasSmg', name: 'Лазерный ПП', heat: 'm', dmg: 115, ap: 42, ergo: 115, weight: 2.8, modes: ['single', 'auto'], aiming: 14, spread: 2, folder: fp('Лазерное', 'ПП') },
    { key: 'lasRifle', name: 'Лазерная штурмовая', heat: 'l', dmg: 140, ap: 45, ergo: 100, weight: 3.6, modes: ['single', 'auto'], aiming: 20, spread: 1, folder: fp('Лазерное', 'Винтовки') },
    { key: 'lasSniper', name: 'Лазерная снайперская', heat: 'l', dmg: 180, ap: 50, ergo: 85, weight: 5.5, modes: ['single'], aiming: 30, spread: 0, folder: fp('Лазерное', 'Винтовки') },
    { key: 'lasGatling', name: 'Лазерный гатлинг', heat: 'xl', dmg: 120, ap: 45, ergo: 65, weight: 12, modes: ['auto'], aiming: 16, spread: 2, folder: fp('Лазерное', 'Тяжёлое') },
  ];
  for (const L of lasers) {
    weaponDoc({
      key: L.key, name: L.name, img: 'weapon.svg/laser-gun.svg', weight: L.weight, ergoOverall: L.ergo, readying: 5, sort,
      folderPath: L.folder,
      desc: L.desc || `${L.name}. Боеприпас — теплообменник (без батареи).`,
      lines: [lineBase(`${L.key}:line`, 'Излучатель', {
        aiming: L.aiming, spread: L.spread, recoil: 0,
        damage: [dmg('laser', L.dmg, L.ap)],
        ammoBlocks: [blockExternalCharge(`${L.key}:heat`, `laser-heat-${L.heat}`, 15)],
        modes: L.modes.map((m) => mode(`${L.key}:${m}`, m === 'auto' ? 'Авто' : 'Одиночный', m)),
      })],
    });
    sort += 10000;
  }

  // Laser shotgun: scatter (even fan) + charged single
  weaponDoc({
    key: 'lasShot', name: 'Лазерный дробовик', img: 'weapon.svg/laser-gun.svg', weight: 3.5, ergoOverall: 100, readying: 5, sort,
    folderPath: fp('Лазерное', 'Дробовики'),
    desc: 'Режимы: Рассеиватель (5 лучей, ровный веер) и Заряд (один луч).',
    lines: [lineBase('lasShot:line', 'Излучатель', {
      aiming: 14, spread: 0, recoil: 0,
      damage: [dmg('laser', 150, 40)],
      ammoBlocks: [blockExternalCharge('lasShot:heat', 'laser-heat-m', 15)],
      modes: [
        mode('lasShot:scatter', 'Рассеиватель', 'single', {
          fireDelayAp: 6,
          multishot: { enabled: true, count: 5, coneDegrees: 28 },
        }),
        mode('lasShot:charge', 'Заряд', 'single', {
          fireDelayAp: 8,
          multishot: { enabled: false, count: 1, coneDegrees: 0 },
        }),
      ],
    })],
  });
  sort += 10000;

  // Plasma
  const plasmas = [
    { key: 'plaPistol', name: 'Плазменный пистолет', dmg: 150, ergo: 120, weight: 1.1, modes: ['single'], aiming: 12, folder: fp('Плазменное', 'Пистолеты') },
    { key: 'plaRifle', name: 'Плазменная штурмовая', dmg: 190, ergo: 95, weight: 4.0, modes: ['single', 'auto'], aiming: 18, folder: fp('Плазменное', 'Винтовки') },
    { key: 'plaSniper', name: 'Плазменная снайперская', dmg: 260, ergo: 80, weight: 6.0, modes: ['single'], aiming: 28, folder: fp('Плазменное', 'Винтовки') },
    { key: 'plaAt', name: 'Плазменное ПТ', dmg: 450, ergo: 55, weight: 10, modes: ['single'], aiming: 16, half: 22, folder: fp('Плазменное', 'Тяжёлое') },
  ];
  for (const P of plasmas) {
    weaponDoc({
      key: P.key, name: P.name, img: 'weapon.svg/ray-gun.svg', weight: P.weight, ergoOverall: P.ergo, readying: 7, sort,
      folderPath: P.folder,
      desc: `${P.name}. Низкое бронепробитие, высокий урон, сильное падение с дистанции.`,
      lines: [lineBase(`${P.key}:line`, 'Ускоритель', {
        aiming: P.aiming, spread: 2, recoil: 2,
        energyMult: Math.round((P.dmg / CAL['plasma-cell'].dmg) * 100),
        ammoBlocks: [blockExternalCharge(`${P.key}:cell`, 'plasma-cell-s')],
        modes: P.modes.map((m) => mode(`${P.key}:${m}`, m === 'auto' ? 'Авто' : 'Одиночный', m)),
      })],
    });
    sort += 10000;
  }

  // Melee — poke = simple; cut = new swing payloads
  weaponDoc({
    key: 'knife', name: 'Нож', img: 'weapon.svg/dripping-knife.svg', weight: 0.3, ergoOverall: 140, readying: 2, sort,
    folderPath: fp('Ближний бой', 'Ножи'),
    desc: 'Колющий — короткая линия; режущий — swing ~90° с обрезом конуса.',
    lines: [
      lineBase('knife:poke', 'Колющий', {
        limit: 1, aiming: 6, spread: 0, damage: [dmg('piercing', 90, 35)],
        modes: [mode('knife:poke:m', 'Укол', 'single', { fireDelayAp: 3 })],
      }),
      lineBase('knife:cut', 'Режущий', {
        trajectoryKind: 'complex', payloadId: 'melee_knife_cut',
        aiming: 6, spread: 0, damage: [dmg('cutting', 55, 20)],
        modes: [mode('knife:cut:m', 'Рез', 'single', { fireDelayAp: 3 })],
      }),
    ],
  });
  sort += 10000;
  weaponDoc({
    key: 'sword', name: 'Меч', img: 'weapon.svg/winged-sword.svg', weight: 1.8, ergoOverall: 100, readying: 5, sort,
    folderPath: fp('Ближний бой', 'Мечи'),
    desc: 'Режущий удар (swing, stop on first).',
    lines: [lineBase('sword:cut', 'Рез', {
      trajectoryKind: 'complex', payloadId: 'melee_sword_cut',
      aiming: 10, damage: [dmg('cutting', 90, 30)],
      modes: [mode('sword:cut:m', 'Удар', 'single', { fireDelayAp: 5 })],
    })],
  });
  sort += 10000;
  weaponDoc({
    key: 'spear', name: 'Копьё', img: 'weapon.svg/barbed-spear.svg', weight: 2.2, ergoOverall: 95, readying: 6, sort,
    folderPath: fp('Ближний бой', 'Копья'),
    desc: 'Тычок на дистанции / короткий рез (swing).',
    lines: [
      lineBase('spear:poke', 'Тычок', {
        limit: 2, aiming: 12, damage: [dmg('piercing', 110, 40)],
        modes: [mode('spear:poke:m', 'Тычок', 'single', { fireDelayAp: 5 })],
      }),
      lineBase('spear:cut', 'Рез', {
        trajectoryKind: 'complex', payloadId: 'melee_spear_cut',
        aiming: 10, damage: [dmg('cutting', 60, 25)],
        modes: [mode('spear:cut:m', 'Рез', 'single', { fireDelayAp: 5 })],
      }),
    ],
  });
}

function main() {
  console.log(`Generating catalog → ${outDir}`);
  wipeOutDir();
  emitMaterials();
  emitWearables();
  emitAmmo();
  emitWeapons();
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.json'));
  console.log(`done: ${files.length} files`);
  console.log('ammo keys:', Object.keys(AMMO_IDS).join(', '));
}

main();

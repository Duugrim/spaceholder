/**
 * One-shot generator: SH_Test4 weapon/ammo pack-src items for «Новые предметы».
 * Run: node scripts/generate-sh-test4-items.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'pack-src', 'sh-test-items');

const STATS = {
  compendiumSource: null,
  duplicateSource: null,
  exportSource: null,
  coreVersion: '13.350',
  systemId: 'spaceholder',
  systemVersion: '0.180',
  createdTime: 1782000000000,
  modifiedTime: 1782000000000,
  lastModifiedBy: null,
};

const FOLDER_WEAPONS = 'shtest4fldwpn000';
const FOLDER_AMMO = 'shtest4fldammo00';

function defaultActions() {
  return {
    equip: { showInCombat: false, showInQuickbar: true },
    unequip: { showInCombat: false, showInQuickbar: true },
    hold: { showInCombat: true, showInQuickbar: true },
    stow: { showInCombat: false, showInQuickbar: true },
    drop: { showInCombat: false, showInQuickbar: false },
    wear: { showInCombat: false, showInQuickbar: false },
    show: { showInCombat: false, showInQuickbar: false },
  };
}

function emptyErgo(readying = 5) {
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

function dmg(damageType, damage, armorPen = 50, hardness = 1) {
  return [{
    enabled: true,
    damageType,
    damage,
    armorPen,
    hardness,
    armorDamageFactor: 100,
    armorDamageReduction: 100,
    speed: 0,
    payloadId: '',
  }];
}

function apActions(overrides = {}) {
  const base = {
    loadOne: { enabled: true, value: 5 },
    loadX: { enabled: true, value: 10 },
    reload: { enabled: true, value: 20 },
    bolt: { enabled: true, value: 5 },
    unload: { enabled: true, value: 5 },
    empty: { enabled: true, value: 10 },
  };
  return { ...base, ...overrides };
}

function search() {
  return { hands: true, worn: true, inventory: true, containers: true, mode: 'auto' };
}

function mode(id, name, extra = {}) {
  return {
    id,
    name,
    fireMode: 'single',
    burstCount: 3,
    fireDelayAp: 5,
    ammoCost: 1,
    enterCost: { enabled: false, value: 0 },
    exitCost: { enabled: false, value: 0 },
    modifiers: [],
    ...extra,
  };
}

function chargeCfg({
  enabled = true,
  max = 0,
  current = 0,
  allowFractional = false,
  clampNonNegative = true,
  scaleDamageFromSpent = false,
  overheatNotify = false,
  shotSign = '-',
  shotFormula = '1',
  secSign = '+',
  secFormula = '0',
} = {}) {
  return {
    enabled,
    max,
    current,
    allowFractional,
    clampNonNegative,
    scaleDamageFromSpent,
    overheatNotify,
    changePerShot: { sign: shotSign, formula: shotFormula },
    changePerSecond: { sign: secSign, formula: secFormula },
  };
}

function baseItem({
  id,
  name,
  img,
  description,
  folder,
  sort,
  weight = 1,
  quantity = 1,
  tags = {},
  weapon = null,
  extraSystem = {},
}) {
  return {
    name,
    type: 'item',
    _id: id,
    img,
    system: {
      description,
      implantReplaceOrgan: null,
      actions: [],
      quantity,
      weight,
      formula: 'd20 + @dex.mod + ceil(@lvl / 2)',
      equipped: false,
      held: false,
      anatomyId: null,
      coveredParts: [],
      defaultActions: defaultActions(),
      modifiers: { abilities: [], derived: [], params: [] },
      itemTags: {
        isArmor: false,
        isActions: false,
        isModifiers: false,
        isWeapon: false,
        isAmmo: false,
        isContainer: false,
        ...tags,
      },
      ...(weapon ? { weapon } : {}),
      ...extraSystem,
    },
    effects: [],
    folder,
    sort,
    ownership: { default: 0 },
    flags: {},
    _stats: { ...STATS },
    _key: `!items!${id}`,
  };
}

function emptyAmmoWeapon(ammo) {
  return {
    version: 3,
    ergonomics: emptyErgo(0),
    lines: [],
    state: { activeLineId: '', activeModeId: '', ready: false },
    ammo,
  };
}

function write(doc) {
  const file = path.join(OUT, `SH_Test4_${doc._id}.json`.replace('SH_Test4_shtest4', 'SH_Test4_').replace(/^SH_Test4_SH_Test4_/, 'SH_Test4_'));
  // Prefer readable names from a map
}

const files = [];

function add(filename, doc) {
  files.push({ filename, doc });
}

// Folders
add('_Folder_Weapons_shtest4fldwpn000.json', {
  name: 'Weapons',
  type: 'Item',
  _id: FOLDER_WEAPONS,
  sorting: 'a',
  folder: null,
  description: 'Test4 weapons (Новые предметы)',
  color: '#3d6b8a',
  sort: 260000,
  flags: {},
  _stats: { ...STATS },
  _key: `!folders!${FOLDER_WEAPONS}`,
});

add('_Folder_Ammunition_shtest4fldammo00.json', {
  name: 'Ammunition',
  type: 'Item',
  _id: FOLDER_AMMO,
  sorting: 'a',
  folder: null,
  description: 'Test4 ammo',
  color: '#8a6b3d',
  sort: 270000,
  flags: {},
  _stats: { ...STATS },
  _key: `!folders!${FOLDER_AMMO}`,
});

// --- Bastard sword ---
add('SH_Test4_Bastard_Sword_shtest4sword00.json', baseItem({
  id: 'shtest4sword0000',
  name: 'Меч-бастард (тест)',
  img: 'systems/spaceholder/assets/icons/weapon.svg/sword.svg',
  description: '<p>Две линии хвата × две атаки. Одноручный: меньше дальность/урон/бронепробитие.</p>',
  folder: FOLDER_WEAPONS,
  sort: 100000,
  weight: 2.2,
  tags: { isWeapon: true },
  weapon: {
    version: 3,
    ergonomics: emptyErgo(4),
    lines: [
      {
        id: 'line1h0000000000',
        name: 'Одноручный хват',
        trajectoryKind: 'simple',
        simpleLimit: { enabled: true, value: 1, unit: 'grid' },
        payloadId: '',
        aiming: 8,
        trigger: 2,
        energyMult: { enabled: false, value: 100 },
        spread: { enabled: false, value: 0 },
        recoil: { enabled: false, value: 0 },
        enterCost: { enabled: false, value: 0 },
        exitCost: { enabled: false, value: 0 },
        damage: [],
        ammoBlocks: [],
        modes: [
          mode('mode1hSlash00000', 'Размашистый удар', {
            modifiers: [],
          }),
          mode('mode1hThrust0000', 'Колющий'),
        ],
      },
      {
        id: 'line2h0000000000',
        name: 'Двуручный хват',
        trajectoryKind: 'simple',
        simpleLimit: { enabled: true, value: 2, unit: 'grid' },
        payloadId: '',
        aiming: 10,
        trigger: 3,
        energyMult: { enabled: false, value: 100 },
        spread: { enabled: false, value: 0 },
        recoil: { enabled: false, value: 0 },
        enterCost: { enabled: false, value: 0 },
        exitCost: { enabled: false, value: 0 },
        damage: [],
        ammoBlocks: [],
        modes: [
          mode('mode2hSlash00000', 'Размашистый удар'),
          mode('mode2hThrust0000', 'Колющий'),
        ],
      },
    ],
    state: { activeLineId: 'line1h0000000000', activeModeId: 'mode1hSlash00000', ready: false },
    ammo: emptyAmmoWeapon({
      damage: [],
      caliber: '',
      connector: { enabled: false, value: '' },
      charge: chargeCfg({ enabled: false }),
      capacity: 0,
      consume: true,
    }).ammo,
  },
}));

// Fix bastard sword damage on modes via line damage — set per-line
{
  const sword = files[files.length - 1].doc;
  sword.system.weapon.lines[0].damage = dmg('melee', 18, 20);
  sword.system.weapon.lines[0].modes[0].modifiers = [
    { id: 'mod1hslash', param: 'damage.damage', op: 'mult', value: 100, enabled: true, disableParam: false },
  ];
  // thrusting: less damage feel via lower armor pen on second mode — use modifier
  sword.system.weapon.lines[0].modes[1].modifiers = [
    { id: 'mod1hthrust', param: 'damage.armorPen', op: 'add', value: 10, enabled: true, disableParam: false },
  ];
  sword.system.weapon.lines[1].damage = dmg('melee', 28, 45);
  sword.system.weapon.lines[1].modes[0].modifiers = [];
  sword.system.weapon.lines[1].modes[1].modifiers = [
    { id: 'mod2hthrust', param: 'damage.armorPen', op: 'add', value: 15, enabled: true, disableParam: false },
  ];
}

// --- SIMP-13 ---
add('SH_Test4_SIMP13_shtest4simp1300.json', baseItem({
  id: 'shtest4simp13000',
  name: 'Пистолет SIMP-13 (тест)',
  img: 'systems/spaceholder/assets/icons/weapon.svg/laser-gun.svg',
  description: '<p>Плазменный пистолет с внутренним зарядом. Патронника нет; перезарядка — действие (без поиска магазина).</p>',
  folder: FOLDER_WEAPONS,
  sort: 110000,
  weight: 1.1,
  tags: { isWeapon: true },
  weapon: {
    version: 3,
    ergonomics: emptyErgo(3),
    lines: [{
      id: 'lineSimpMain0000',
      name: 'Излучатель',
      trajectoryKind: 'simple',
      simpleLimit: { enabled: false, value: 0, unit: 'grid' },
      payloadId: '',
      aiming: 18,
      trigger: 3,
      energyMult: { enabled: false, value: 100 },
      spread: { enabled: true, value: 2 },
      recoil: { enabled: false, value: 0 },
      enterCost: { enabled: false, value: 0 },
      exitCost: { enabled: false, value: 0 },
      damage: [],
      ammoBlocks: [{
        id: 'blockSimpCharge0',
        type: 'internalCharge',
        capacity: 20,
        loadAmount: 20,
        chamberEnabled: false,
        autoFeed: false,
        caliber: '',
        connector: '',
        search: search(),
        apActions: apActions({
          reload: { enabled: true, value: 25 },
          loadOne: { enabled: false, value: 0 },
          loadX: { enabled: false, value: 0 },
          bolt: { enabled: false, value: 0 },
        }),
        damage: dmg('energy', 22, 40),
        runtime: { charge: 20, chamberCharge: false, chamberItem: null, contents: [], magazine: null },
      }],
      modes: [mode('modeSimpSingle00', 'Одиночный')],
    }],
    state: { activeLineId: 'lineSimpMain0000', activeModeId: 'modeSimpSingle00', ready: false },
    ammo: emptyAmmoWeapon({
      damage: [], caliber: '', connector: { enabled: false, value: '' },
      charge: chargeCfg({ enabled: false }), capacity: 0, consume: true,
    }).ammo,
  },
}));

// --- Wand + crystal ---
add('SH_Test4_Crystal_shtest4crystal0.json', baseItem({
  id: 'shtest4crystal00',
  name: 'Магический кристалл (тест)',
  img: 'icons/svg/angel.svg',
  description: '<p>Кристалл для жезла ветров. Заряд тратится режимами (ammoCost).</p>',
  folder: FOLDER_AMMO,
  sort: 100000,
  weight: 0.2,
  quantity: 2,
  tags: { isAmmo: true },
  weapon: emptyAmmoWeapon({
    damage: [],
    caliber: 'жезл-кристалл',
    connector: { enabled: false, value: '' },
    charge: chargeCfg({
      enabled: true, max: 20, current: 20,
      shotSign: '-', shotFormula: '1',
      clampNonNegative: true,
    }),
    capacity: 0,
    consume: true,
  }),
}));

add('SH_Test4_Wind_Wand_shtest4wand000.json', baseItem({
  id: 'shtest4wand00000',
  name: 'Жезл ветров (тест)',
  img: 'icons/svg/daze.svg',
  description: '<p>Одна линия, кристалл. Ураганный ветер (ammoCost 5) — AoE-заглушка; Режущий ветер (ammoCost 2) — длинное AoE-заглушка. Механика траекторий не готова.</p>',
  folder: FOLDER_WEAPONS,
  sort: 120000,
  weight: 0.8,
  tags: { isWeapon: true },
  weapon: {
    version: 3,
    ergonomics: emptyErgo(5),
    lines: [{
      id: 'lineWandMain0000',
      name: 'Поток',
      trajectoryKind: 'simple',
      simpleLimit: { enabled: false, value: 0, unit: 'grid' },
      payloadId: '',
      aiming: 15,
      trigger: 4,
      energyMult: { enabled: false, value: 100 },
      spread: { enabled: false, value: 0 },
      recoil: { enabled: false, value: 0 },
      enterCost: { enabled: false, value: 0 },
      exitCost: { enabled: false, value: 0 },
      damage: [],
      ammoBlocks: [{
        id: 'blockWandCrystal',
        type: 'externalCharge',
        capacity: 1,
        loadAmount: 1,
        chamberEnabled: false,
        autoFeed: false,
        caliber: 'жезл-кристалл',
        connector: '',
        search: search(),
        apActions: apActions({ reload: { enabled: true, value: 15 }, bolt: { enabled: false, value: 0 } }),
        damage: dmg('energy', 15, 10),
        runtime: {
          charge: 0,
          chamberCharge: false,
          attachedItemId: '',
          chamberItemId: '',
          contentItemIds: [],
          chamberItem: null,
          contents: [],
          magazine: null,
        },
      }],
      modes: [
        mode('modeWandGale0000', 'Ураганный ветер', { ammoCost: 5 }),
        mode('modeWandCut00000', 'Режущий ветер', { ammoCost: 2 }),
      ],
    }],
    state: { activeLineId: 'lineWandMain0000', activeModeId: 'modeWandGale0000', ready: false },
    ammo: emptyAmmoWeapon({
      damage: [], caliber: '', connector: { enabled: false, value: '' },
      charge: chargeCfg({ enabled: false }), capacity: 0, consume: true,
    }).ammo,
  },
}));

// --- LASS batteries / heat / weapon ---
add('SH_Test4_Battery_shtest4batt000.json', baseItem({
  id: 'shtest4batt00000',
  name: 'Батарея LASS (тест)',
  img: 'icons/svg/lightning.svg',
  description: '<p>Обычная батарея LASS: max 1000, −5% за выстрел, урон = потраченный заряд, дробный заряд.</p>',
  folder: FOLDER_AMMO,
  sort: 110000,
  weight: 0.5,
  quantity: 2,
  tags: { isAmmo: true },
  weapon: emptyAmmoWeapon({
    damage: [],
    caliber: 'lass-батарея',
    connector: { enabled: false, value: '' },
    charge: chargeCfg({
      enabled: true, max: 1000, current: 1000,
      allowFractional: true, clampNonNegative: true,
      scaleDamageFromSpent: true,
      shotSign: '-', shotFormula: '5%',
    }),
    capacity: 0,
    consume: true,
  }),
}));

add('SH_Test4_Fusion_Batt_shtest4fusion0.json', baseItem({
  id: 'shtest4fusion000',
  name: 'Термояд. батарея LASS (тест)',
  img: 'icons/svg/explosion.svg',
  description: '<p>Как обычная LASS-батарея (−5%, урон=spent), плюс самозаряд +10/с личного времени.</p>',
  folder: FOLDER_AMMO,
  sort: 120000,
  weight: 0.6,
  quantity: 1,
  tags: { isAmmo: true },
  weapon: emptyAmmoWeapon({
    damage: [],
    caliber: 'lass-батарея',
    connector: { enabled: false, value: '' },
    charge: chargeCfg({
      enabled: true, max: 1000, current: 1000,
      allowFractional: true, clampNonNegative: true,
      scaleDamageFromSpent: true,
      shotSign: '-', shotFormula: '5%',
      secSign: '+', secFormula: '10',
    }),
    capacity: 0,
    consume: true,
  }),
}));

add('SH_Test4_Heat_Sink_shtest4heat000.json', baseItem({
  id: 'shtest4heat00000',
  name: 'Теплообменник LASS (тест)',
  img: 'icons/svg/fire.svg',
  description: '<p>+5 тепла за выстрел, max 100, остывание −1/с. При полном — сообщение в чат. Выстрел не блокируется.</p>',
  folder: FOLDER_AMMO,
  sort: 130000,
  weight: 0.3,
  quantity: 1,
  tags: { isAmmo: true },
  weapon: emptyAmmoWeapon({
    damage: [],
    caliber: 'lass-тепло',
    connector: { enabled: false, value: '' },
    charge: chargeCfg({
      enabled: true, max: 100, current: 0,
      allowFractional: false, clampNonNegative: true,
      overheatNotify: true,
      shotSign: '+', shotFormula: '5',
      secSign: '-', secFormula: '1',
    }),
    capacity: 0,
    consume: false,
  }),
}));

add('SH_Test4_LASS_shtest4lass000.json', baseItem({
  id: 'shtest4lass00000',
  name: 'Лазган LASS (тест)',
  img: 'systems/spaceholder/assets/icons/weapon.svg/laser-gun.svg',
  description: '<p>Два блока externalCharge: батарея (lass-батарея) и теплообменник (lass-тепло).</p>',
  folder: FOLDER_WEAPONS,
  sort: 130000,
  weight: 3.5,
  tags: { isWeapon: true },
  weapon: {
    version: 3,
    ergonomics: emptyErgo(5),
    lines: [{
      id: 'lineLassMain0000',
      name: 'Луч',
      trajectoryKind: 'simple',
      simpleLimit: { enabled: false, value: 0, unit: 'grid' },
      payloadId: '',
      aiming: 20,
      trigger: 3,
      energyMult: { enabled: false, value: 100 },
      spread: { enabled: true, value: 1 },
      recoil: { enabled: false, value: 0 },
      enterCost: { enabled: false, value: 0 },
      exitCost: { enabled: false, value: 0 },
      damage: dmg('energy', 1, 80),
      ammoBlocks: [
        {
          id: 'blockLassBatt000',
          type: 'externalCharge',
          capacity: 1,
          loadAmount: 1,
          chamberEnabled: false,
          autoFeed: false,
          caliber: 'lass-батарея',
          connector: '',
          search: search(),
          apActions: apActions({ reload: { enabled: true, value: 20 }, bolt: { enabled: false, value: 0 } }),
          damage: [],
          runtime: {
          charge: 0,
          chamberCharge: false,
          attachedItemId: '',
          chamberItemId: '',
          contentItemIds: [],
          chamberItem: null,
          contents: [],
          magazine: null,
        },
        },
        {
          id: 'blockLassHeat000',
          type: 'externalCharge',
          capacity: 1,
          loadAmount: 1,
          chamberEnabled: false,
          autoFeed: false,
          caliber: 'lass-тепло',
          connector: '',
          search: search(),
          apActions: apActions({ reload: { enabled: true, value: 10 }, bolt: { enabled: false, value: 0 } }),
          damage: [],
          runtime: {
          charge: 0,
          chamberCharge: false,
          attachedItemId: '',
          chamberItemId: '',
          contentItemIds: [],
          chamberItem: null,
          contents: [],
          magazine: null,
        },
        },
      ],
      modes: [mode('modeLassSingle00', 'Импульс')],
    }],
    state: { activeLineId: 'lineLassMain0000', activeModeId: 'modeLassSingle00', ready: false },
    ammo: emptyAmmoWeapon({
      damage: [], caliber: '', connector: { enabled: false, value: '' },
      charge: chargeCfg({ enabled: false }), capacity: 0, consume: true,
    }).ammo,
  },
}));

// --- M-1d ---
add('SH_Test4_Ammo_545_shtest4ammo545.json', baseItem({
  id: 'shtest4ammo54500',
  name: 'Патрон 5.45 (тест)',
  img: 'icons/svg/bones.svg',
  description: '<p>Патрон для M-1d / магазина.</p>',
  folder: FOLDER_AMMO,
  sort: 140000,
  weight: 0.01,
  quantity: 60,
  tags: { isAmmo: true },
  weapon: emptyAmmoWeapon({
    damage: dmg('ballistic', 28, 45),
    caliber: '5.45',
    connector: { enabled: false, value: '' },
    charge: chargeCfg({ enabled: false }),
    capacity: 0,
    consume: true,
  }),
}));

add('SH_Test4_Mag_M1d_shtest4magm1d0.json', baseItem({
  id: 'shtest4magm1d000',
  name: 'Магазин M-1d (тест)',
  img: 'icons/svg/item-bag.svg',
  description: '<p>Внешний магазин на 30 патронов 5.45, разъём m-1d.</p>',
  folder: FOLDER_AMMO,
  sort: 150000,
  weight: 0.4,
  quantity: 1,
  tags: { isAmmo: true, isContainer: true },
  weapon: emptyAmmoWeapon({
    damage: [],
    caliber: '5.45',
    connector: { enabled: true, value: 'm-1d' },
    charge: chargeCfg({ enabled: false }),
    capacity: 30,
    consume: false,
  }),
  extraSystem: {
    storage: { enabled: false, version: 1, slots: {}, contents: [] },
    container: { contents: [], limits: { maxItems: 30, maxWeight: 0 } },
  },
}));

add('SH_Test4_M1d_shtest4m1d0000.json', baseItem({
  id: 'shtest4m1d000000',
  name: 'Винтовка M-1d (тест)',
  img: 'systems/spaceholder/assets/icons/weapon.svg/assault-rifle.svg',
  description: '<p>Внешний магазин + патронник, автоподача. Калибр 5.45, разъём m-1d.</p>',
  folder: FOLDER_WEAPONS,
  sort: 140000,
  weight: 3.2,
  tags: { isWeapon: true },
  weapon: {
    version: 3,
    ergonomics: emptyErgo(6),
    lines: [{
      id: 'lineM1dMain00000',
      name: 'Ствол',
      trajectoryKind: 'simple',
      simpleLimit: { enabled: false, value: 0, unit: 'grid' },
      payloadId: '',
      aiming: 22,
      trigger: 3,
      energyMult: { enabled: false, value: 100 },
      spread: { enabled: true, value: 2 },
      recoil: { enabled: true, value: 3 },
      enterCost: { enabled: false, value: 0 },
      exitCost: { enabled: false, value: 0 },
      damage: [],
      ammoBlocks: [{
        id: 'blockM1dMag00000',
        type: 'externalMagazine',
        capacity: 30,
        loadAmount: 1,
        chamberEnabled: true,
        autoFeed: true,
        caliber: '5.45',
        connector: 'm-1d',
        search: search(),
        apActions: apActions({ reload: { enabled: true, value: 30 }, bolt: { enabled: true, value: 5 } }),
        damage: [],
        runtime: {
          charge: 0,
          chamberCharge: false,
          attachedItemId: '',
          chamberItemId: '',
          contentItemIds: [],
          chamberItem: null,
          contents: [],
          magazine: null,
        },
      }],
      modes: [
        mode('modeM1dSingle000', 'Одиночный'),
        mode('modeM1dAuto00000', 'Авто', { fireMode: 'auto', fireDelayAp: 4 }),
      ],
    }],
    state: { activeLineId: 'lineM1dMain00000', activeModeId: 'modeM1dSingle000', ready: false },
    ammo: emptyAmmoWeapon({
      damage: [], caliber: '', connector: { enabled: false, value: '' },
      charge: chargeCfg({ enabled: false }), capacity: 0, consume: true,
    }).ammo,
  },
}));

// --- Bow + arrows ---
function arrow(id, filename, name, desc, damageEntries) {
  add(filename, baseItem({
    id,
    name,
    img: 'icons/svg/target.svg',
    description: desc,
    folder: FOLDER_AMMO,
    sort: 160000,
    weight: 0.05,
    quantity: 12,
    tags: { isAmmo: true },
    weapon: emptyAmmoWeapon({
      damage: damageEntries,
      caliber: 'стрела',
      connector: { enabled: false, value: '' },
      charge: chargeCfg({ enabled: false }),
      capacity: 0,
      consume: true,
    }),
  }));
}

arrow('shtest4arrow0000', 'SH_Test4_Arrow_shtest4arrow00.json', 'Обычная стрела (тест)',
  '<p>Обычная стрела для лука.</p>', dmg('ballistic', 20, 15));
arrow('shtest4arrowexpl', 'SH_Test4_Arrow_Expl_shtest4arrexp.json', 'Взрывная стрела (тест)',
  '<p>ЗАГЛУШКА: AoE в точке попадания — механика не готова. Пока обычный урон.</p>', dmg('explosive', 25, 10));
arrow('shtest4arrowpois', 'SH_Test4_Arrow_Poison_shtest4arrpoi.json', 'Ядовитая стрела (тест)',
  '<p>ЗАГЛУШКА: статус Отравление — механика не готова. Пока обычный урон.</p>', dmg('ballistic', 16, 10));
arrow('shtest4arrowsmok', 'SH_Test4_Arrow_Smoke_shtest4arrsmk.json', 'Дымовая стрела (тест)',
  '<p>ЗАГЛУШКА: дым, блокирующий обзор — механика не готова. Пока слабый урон.</p>', dmg('ballistic', 5, 0));

add('SH_Test4_Bow_shtest4bow0000.json', baseItem({
  id: 'shtest4bow000000',
  name: 'Лук (тест)',
  img: 'systems/spaceholder/assets/icons/weapon.svg/bow.svg',
  description: '<p>Стрельба из инвентаря (internalMagazine capacity 0), калибр «стрела».</p>',
  folder: FOLDER_WEAPONS,
  sort: 150000,
  weight: 1.5,
  tags: { isWeapon: true },
  weapon: {
    version: 3,
    ergonomics: emptyErgo(8),
    lines: [{
      id: 'lineBowMain00000',
      name: 'Тетива',
      trajectoryKind: 'simple',
      simpleLimit: { enabled: false, value: 0, unit: 'grid' },
      payloadId: '',
      aiming: 25,
      trigger: 5,
      energyMult: { enabled: true, value: 100 },
      spread: { enabled: true, value: 3 },
      recoil: { enabled: false, value: 0 },
      enterCost: { enabled: false, value: 0 },
      exitCost: { enabled: false, value: 0 },
      damage: [],
      ammoBlocks: [{
        id: 'blockBowAmmo0000',
        type: 'internalMagazine',
        capacity: 0,
        loadAmount: 1,
        chamberEnabled: false,
        autoFeed: false,
        caliber: 'стрела',
        connector: '',
        search: search(),
        apActions: apActions({
          reload: { enabled: false, value: 0 },
          bolt: { enabled: false, value: 0 },
          loadOne: { enabled: false, value: 0 },
        }),
        damage: [],
        runtime: {
          charge: 0,
          chamberCharge: false,
          attachedItemId: '',
          chamberItemId: '',
          contentItemIds: [],
          chamberItem: null,
          contents: [],
          magazine: null,
        },
      }],
      modes: [mode('modeBowSingle000', 'Выстрел')],
    }],
    state: { activeLineId: 'lineBowMain00000', activeModeId: 'modeBowSingle000', ready: false },
    ammo: emptyAmmoWeapon({
      damage: [], caliber: '', connector: { enabled: false, value: '' },
      charge: chargeCfg({ enabled: false }), capacity: 0, consume: true,
    }).ammo,
  },
}));

// --- Grenade ---
add('SH_Test4_Grenade_shtest4grenade.json', baseItem({
  id: 'shtest4grenade00',
  name: 'Граната (тест)',
  img: 'icons/svg/bomb.svg',
  description: '<p>Метательное оружие-заглушка: атака = взрывной урон по линии. Метание траектории не трогаем.</p>',
  folder: FOLDER_WEAPONS,
  sort: 160000,
  weight: 0.5,
  tags: { isWeapon: true },
  weapon: {
    version: 3,
    ergonomics: emptyErgo(2),
    lines: [{
      id: 'lineGrenadeMain0',
      name: 'Взрыв',
      trajectoryKind: 'simple',
      simpleLimit: { enabled: true, value: 3, unit: 'grid' },
      payloadId: '',
      aiming: 12,
      trigger: 2,
      energyMult: { enabled: false, value: 100 },
      spread: { enabled: true, value: 5 },
      recoil: { enabled: false, value: 0 },
      enterCost: { enabled: false, value: 0 },
      exitCost: { enabled: false, value: 0 },
      damage: dmg('explosive', 40, 30),
      ammoBlocks: [],
      modes: [mode('modeGrenadeThrow', 'Метать')],
    }],
    state: { activeLineId: 'lineGrenadeMain0', activeModeId: 'modeGrenadeThrow', ready: false },
    ammo: emptyAmmoWeapon({
      damage: [], caliber: '', connector: { enabled: false, value: '' },
      charge: chargeCfg({ enabled: false }), capacity: 0, consume: true,
    }).ammo,
  },
}));

// --- Reil-guffin ---
add('SH_Test4_Rail_Slug_shtest4railslg.json', baseItem({
  id: 'shtest4railslug0',
  name: 'Снаряд рельсотрона (тест)',
  img: 'icons/svg/sword.svg',
  description: '<p>Снаряд для Reil-guffin, магазин на 5.</p>',
  folder: FOLDER_AMMO,
  sort: 170000,
  weight: 0.1,
  quantity: 10,
  tags: { isAmmo: true },
  weapon: emptyAmmoWeapon({
    damage: dmg('ballistic', 55, 90, 2),
    caliber: 'рельс-снаряд',
    connector: { enabled: false, value: '' },
    charge: chargeCfg({ enabled: false }),
    capacity: 0,
    consume: true,
  }),
}));

add('SH_Test4_Mag_Rail_shtest4magrail.json', baseItem({
  id: 'shtest4magrail00',
  name: 'Магазин рельсотрона (тест)',
  img: 'icons/svg/item-bag.svg',
  description: '<p>Магазин на 5 снарядов, разъём reil-slug.</p>',
  folder: FOLDER_AMMO,
  sort: 180000,
  weight: 0.5,
  tags: { isAmmo: true, isContainer: true },
  weapon: emptyAmmoWeapon({
    damage: [],
    caliber: 'рельс-снаряд',
    connector: { enabled: true, value: 'reil-slug' },
    charge: chargeCfg({ enabled: false }),
    capacity: 5,
    consume: false,
  }),
  extraSystem: {
    storage: { enabled: false, version: 1, slots: {}, contents: [] },
    container: { contents: [], limits: { maxItems: 5, maxWeight: 0 } },
  },
}));

add('SH_Test4_Lubricant_shtest4lube000.json', baseItem({
  id: 'shtest4lube00000',
  name: 'Ёмкость со смазкой (тест)',
  img: 'icons/svg/water.svg',
  description: '<p>Смазка для Reil-guffin: −1 заряд за выстрел.</p>',
  folder: FOLDER_AMMO,
  sort: 190000,
  weight: 0.4,
  quantity: 1,
  tags: { isAmmo: true },
  weapon: emptyAmmoWeapon({
    damage: [],
    caliber: 'reil-смазка',
    connector: { enabled: false, value: '' },
    charge: chargeCfg({
      enabled: true, max: 50, current: 50,
      shotSign: '-', shotFormula: '1',
    }),
    capacity: 0,
    consume: true,
  }),
}));

add('SH_Test4_Barrel_shtest4barrel0.json', baseItem({
  id: 'shtest4barrel000',
  name: 'Сменный ствол (тест)',
  img: 'icons/svg/upgrade.svg',
  description: '<p>Состояние ствола (износ): −1 за выстрел, max 100.</p>',
  folder: FOLDER_AMMO,
  sort: 200000,
  weight: 1.2,
  quantity: 1,
  tags: { isAmmo: true },
  weapon: emptyAmmoWeapon({
    damage: [],
    caliber: 'reil-ствол',
    connector: { enabled: false, value: '' },
    charge: chargeCfg({
      enabled: true, max: 100, current: 100,
      shotSign: '-', shotFormula: '1',
    }),
    capacity: 0,
    consume: false,
  }),
}));

add('SH_Test4_Reil_Guffin_shtest4reil000.json', baseItem({
  id: 'shtest4reil00000',
  name: 'Reil-guffin (тест)',
  img: 'systems/spaceholder/assets/icons/weapon.svg/railgun.svg',
  description: '<p>Линия 1: снаряды (mag) + батарея LASS + смазка + ствол. Линия 2: штык.</p>',
  folder: FOLDER_WEAPONS,
  sort: 170000,
  weight: 8,
  tags: { isWeapon: true },
  weapon: {
    version: 3,
    ergonomics: emptyErgo(10),
    lines: [
      {
        id: 'lineReilRail0000',
        name: 'Рельсотрон',
        trajectoryKind: 'simple',
        simpleLimit: { enabled: false, value: 0, unit: 'grid' },
        payloadId: '',
        aiming: 30,
        trigger: 5,
        energyMult: { enabled: true, value: 120 },
        spread: { enabled: true, value: 1 },
        recoil: { enabled: true, value: 8 },
        enterCost: { enabled: false, value: 0 },
        exitCost: { enabled: false, value: 0 },
        damage: [],
        ammoBlocks: [
          {
            id: 'blockReilSlug000',
            type: 'externalMagazine',
            capacity: 5,
            loadAmount: 1,
            chamberEnabled: true,
            autoFeed: true,
            caliber: 'рельс-снаряд',
            connector: 'reil-slug',
            search: search(),
            apActions: apActions({ reload: { enabled: true, value: 40 } }),
            damage: [],
            runtime: {
          charge: 0,
          chamberCharge: false,
          attachedItemId: '',
          chamberItemId: '',
          contentItemIds: [],
          chamberItem: null,
          contents: [],
          magazine: null,
        },
          },
          {
            id: 'blockReilBatt000',
            type: 'externalCharge',
            capacity: 1,
            loadAmount: 1,
            chamberEnabled: false,
            autoFeed: false,
            caliber: 'lass-батарея',
            connector: '',
            search: search(),
            apActions: apActions({ reload: { enabled: true, value: 20 }, bolt: { enabled: false, value: 0 } }),
            damage: [],
            runtime: {
          charge: 0,
          chamberCharge: false,
          attachedItemId: '',
          chamberItemId: '',
          contentItemIds: [],
          chamberItem: null,
          contents: [],
          magazine: null,
        },
          },
          {
            id: 'blockReilLube000',
            type: 'externalCharge',
            capacity: 1,
            loadAmount: 1,
            chamberEnabled: false,
            autoFeed: false,
            caliber: 'reil-смазка',
            connector: '',
            search: search(),
            apActions: apActions({ reload: { enabled: true, value: 15 }, bolt: { enabled: false, value: 0 } }),
            damage: [],
            runtime: {
          charge: 0,
          chamberCharge: false,
          attachedItemId: '',
          chamberItemId: '',
          contentItemIds: [],
          chamberItem: null,
          contents: [],
          magazine: null,
        },
          },
          {
            id: 'blockReilBarrel0',
            type: 'externalCharge',
            capacity: 1,
            loadAmount: 1,
            chamberEnabled: false,
            autoFeed: false,
            caliber: 'reil-ствол',
            connector: '',
            search: search(),
            apActions: apActions({ reload: { enabled: true, value: 50 }, bolt: { enabled: false, value: 0 } }),
            damage: [],
            runtime: {
          charge: 0,
          chamberCharge: false,
          attachedItemId: '',
          chamberItemId: '',
          contentItemIds: [],
          chamberItem: null,
          contents: [],
          magazine: null,
        },
          },
        ],
        modes: [mode('modeReilShot0000', 'Выстрел')],
      },
      {
        id: 'lineReilBayonet0',
        name: 'Штык',
        trajectoryKind: 'simple',
        simpleLimit: { enabled: true, value: 1, unit: 'grid' },
        payloadId: '',
        aiming: 6,
        trigger: 2,
        energyMult: { enabled: false, value: 100 },
        spread: { enabled: false, value: 0 },
        recoil: { enabled: false, value: 0 },
        enterCost: { enabled: false, value: 0 },
        exitCost: { enabled: false, value: 0 },
        damage: dmg('melee', 20, 25),
        ammoBlocks: [],
        modes: [mode('modeReilStab0000', 'Укол')],
      },
    ],
    state: { activeLineId: 'lineReilRail0000', activeModeId: 'modeReilShot0000', ready: false },
    ammo: emptyAmmoWeapon({
      damage: [], caliber: '', connector: { enabled: false, value: '' },
      charge: chargeCfg({ enabled: false }), capacity: 0, consume: true,
    }).ammo,
  },
}));

// --- Bandolier ---
add('SH_Test4_Bandolier_shtest4bandol.json', baseItem({
  id: 'shtest4bandolier',
  name: 'Патронташ (тест)',
  img: 'icons/svg/item-bag.svg',
  description: '<p>Надеваемый контейнер для проверки поиска патронов в worn.</p>',
  folder: 'shtestfldwear000',
  sort: 900000,
  weight: 0.8,
  tags: { isArmor: true, isContainer: true },
  extraSystem: {
    anatomyId: null,
    coveredParts: [],
    container: {
      limits: { maxItems: 40, maxWeight: 5 },
      contents: [],
    },
  },
}));

// Write all
for (const { filename, doc } of files) {
  const p = path.join(OUT, filename);
  fs.writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log('wrote', filename);
}
console.log('Done:', files.length, 'files');

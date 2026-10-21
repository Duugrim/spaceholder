/**
 * Build the test scenes compendium `sh-test-scenes` (an Adventure pack: one import brings the scene, its
 * actors, factions, test journal and folders, ids kept, so the scene's tokens find their actors).
 *
 * Scenes:
 *  - «Перестрелка в баре» — a bar with rooms and walls of real materials (brick, drywall, wooden doors, glass,
 *    a wooden counter), three sides ready to fight: heroes (poorly armed), bandits (leather and some heavy
 *    armour), police (combat armour, assault squad). A journal page lists what the scene tests.
 *
 * Output:
 *  - assets/scenes/bar-shootout.svg — a very simple vector backdrop
 *  - pack-src/sh-test-scenes/SH_Adventure_bar-shootout_<id>.json + pack-src/sh-test-scenes/bar-shootout/**
 *    (embedded documents as files, the Foundry CLI's expanded Adventure format)
 *
 * Usage:
 *   npm run generate:sh-test-scenes     (after pack-src/sh-test-items and data/anatomy are current)
 *   npm run pack:sh-test-scenes         (Foundry closed)
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, SCENE_CORE_VERSION, buildCharacter, makePrototypeToken, makeStats, stableId, writeJson,
} from './lib/sh-actor-builder.mjs';

const OUT_DIR = path.join(ROOT, 'pack-src', 'sh-test-scenes');
const ASSET_DIR = path.join(ROOT, 'assets', 'scenes');
const CREATED_TIME = 1782902000000;

const GRID = 100; // px per cell; the system grid is 1 m
const LEVEL_ID = 'defaultLevel0000'; // BaseScene.metadata.defaultLevelId
const SENSE = { NONE: 0, LIMITED: 10, NORMAL: 20 };
const DOOR = { NONE: 0, DOOR: 1 };
const DISPOSITION = { HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 };

const sceneStats = (extra = 0) => makeStats(CREATED_TIME, extra, SCENE_CORE_VERSION);

/* ================================================================== *
 *  «Перестрелка в баре»                                               *
 * ================================================================== */

const BAR = {
  slug: 'bar-shootout',
  name: 'Перестрелка в баре',
  width: 32,
  height: 22,
  background: 'systems/spaceholder/assets/scenes/bar-shootout.svg',
};

/** Wall materials (`flags.spaceholder.wall`), thickness in mm. */
const WALL = {
  brick: { material: 'brick', kind: 'thin', thickness: 250 },
  drywall: { material: 'drywall', kind: 'thin', thickness: 25 },
  door: { material: 'wood', kind: 'thin', thickness: 40 },
  heavyDoor: { material: 'wood', kind: 'thin', thickness: 60 },
  glass: { material: 'glass', kind: 'thin', thickness: 6 },
  counter: { material: 'wood', kind: 'thin', thickness: 60 },
};

/**
 * Wall segments in cells: `[x1, y1, x2, y2, kind]`. Kinds: a wall, a door (closed), a window (see-through)
 * and the counter (see-through, waist-high: blocks moving and shots, not sight).
 */
const BAR_WALLS = [
  // exterior, brick
  [2, 2, 26, 2, 'brick'],
  [2, 2, 2, 6, 'brick'], [2, 6, 2, 9, 'window'], [2, 9, 2, 16, 'brick'],
  [26, 2, 26, 9, 'brick'], [26, 9, 26, 10, 'heavyDoor'], [26, 10, 26, 16, 'brick'],
  [2, 16, 3, 16, 'brick'], [3, 16, 7, 16, 'window'], [7, 16, 9, 16, 'brick'],
  [9, 16, 10, 16, 'door'], [10, 16, 11, 16, 'door'],
  [11, 16, 13, 16, 'brick'], [13, 16, 17, 16, 'window'], [17, 16, 26, 16, 'brick'],
  // hall | back rooms, drywall with doors
  [18, 2, 18, 4, 'drywall'], [18, 4, 18, 5, 'door'], [18, 5, 18, 12, 'drywall'], [18, 12, 18, 13, 'door'], [18, 13, 18, 16, 'drywall'],
  // kitchen | storage
  [18, 7, 22, 7, 'drywall'], [22, 7, 23, 7, 'door'], [23, 7, 26, 7, 'drywall'],
  // storage | corridor and toilet
  [18, 11, 19, 11, 'drywall'], [19, 11, 20, 11, 'door'], [20, 11, 26, 11, 'drywall'],
  // corridor | toilet
  [22, 11, 22, 13, 'drywall'], [22, 13, 22, 14, 'door'], [22, 14, 22, 16, 'drywall'],
  // bar counter
  [4, 5, 13, 5, 'counter'], [13, 3, 13, 5, 'counter'],
];

function wallDoc([x1, y1, x2, y2, kind], index) {
  const see = kind === 'window' || kind === 'counter';
  const isDoor = kind === 'door' || kind === 'heavyDoor';
  const flag = { window: WALL.glass, counter: WALL.counter }[kind] ?? WALL[kind];
  return {
    _id: stableId(`${BAR.slug}:wall:${index}`),
    c: [x1 * GRID, y1 * GRID, x2 * GRID, y2 * GRID],
    levels: [],
    light: see ? SENSE.NONE : SENSE.NORMAL,
    move: SENSE.NORMAL,
    sight: see ? SENSE.NONE : SENSE.NORMAL,
    sound: kind === 'counter' ? SENSE.NONE : (see ? SENSE.LIMITED : SENSE.NORMAL),
    dir: 0,
    door: isDoor ? DOOR.DOOR : DOOR.NONE,
    ds: 0,
    threshold: { light: null, sight: null, sound: null, attenuation: false },
    flags: { spaceholder: { wall: { ...flag } } },
  };
}

/* ---- sides ------------------------------------------------------- */

const SIDES = {
  heroes: { name: 'Герои', color: '#3fae5a', disposition: DISPOSITION.FRIENDLY },
  bandits: { name: 'Бандиты', color: '#c23b3b', disposition: DISPOSITION.HOSTILE },
  police: { name: 'Полиция', color: '#3b6fc2', disposition: DISPOSITION.NEUTRAL },
};

const POLICE_KIT = [
  { prefix: 'SH_Wear_coverall_', equipped: true },
  { prefix: 'SH_Wear_combat-armor_', equipped: true },
  { prefix: 'SH_Wear_helm-heavy_', equipped: true },
];

/** Fighters: side, name, cell (token top-left), loadout (indices for `attachTo` count from 0). */
const FIGHTERS = [
  // heroes — badly equipped: mostly no armour, a medium vest at most
  { key: 'hero-glock', side: 'heroes', name: 'Герой (Глок)', cell: [4, 9], bio: 'Глок, без брони.', loadout: [
    { prefix: 'SH_Wpn_glock_', held: true },
    { prefix: 'SH_Ammo_9mm_mag_s_', attachTo: 0 },
    { prefix: 'SH_Ammo_9mm_mag_s_', quantity: 2 },
    { prefix: 'SH_Wear_casual_', equipped: true },
  ] },
  { key: 'hero-shotgun', side: 'heroes', name: 'Герой (дробовик)', cell: [8, 9], bio: 'Помповый дробовик (дробь, есть пули), средний жилет.', loadout: [
    { prefix: 'SH_Wpn_pump_', held: true },
    { prefix: 'SH_Ammo_12ga-buck_round_', quantity: 6, attachTo: 0 },
    { prefix: 'SH_Ammo_12ga-buck_round_', quantity: 1, attachTo: 0, chamber: true },
    { prefix: 'SH_Ammo_12ga-buck_round_', quantity: 12 },
    { prefix: 'SH_Ammo_12ga-slug_round_', quantity: 6 },
    { prefix: 'SH_Wear_street_', equipped: true },
    { prefix: 'SH_Wear_vest-mid_', equipped: true },
  ] },
  { key: 'hero-revolver', side: 'heroes', name: 'Герой (револьвер)', cell: [5, 12], bio: 'Револьвер .44, лёгкий жилет.', loadout: [
    { prefix: 'SH_Wpn_revolver44_', held: true },
    { prefix: 'SH_Ammo_44mag_round_', quantity: 6, attachTo: 0 },
    { prefix: 'SH_Ammo_44mag_round_', quantity: 1, attachTo: 0, chamber: true },
    { prefix: 'SH_Ammo_44mag_round_', quantity: 18 },
    { prefix: 'SH_Wear_work_', equipped: true },
    { prefix: 'SH_Wear_vest-light_', equipped: true },
  ] },
  { key: 'hero-knife', side: 'heroes', name: 'Герой (нож)', cell: [11, 12], bio: 'Нож в руке, Глок на поясе, без брони.', loadout: [
    { prefix: 'SH_Wpn_knife_', held: true },
    { prefix: 'SH_Wpn_glock_' },
    { prefix: 'SH_Ammo_9mm_mag_s_', attachTo: 1 },
    { prefix: 'SH_Wear_casual_', equipped: true },
  ] },
  // bandits — everyone in leather at least, some in heavy armour
  { key: 'bandit-boss', side: 'bandits', name: 'Главарь (АК)', cell: [7, 3], bio: 'АК, кожанка, тяжёлый жилет, средняя каска. Стоит за стойкой.', loadout: [
    { prefix: 'SH_Wpn_ak_', held: true },
    { prefix: 'SH_Ammo_7.62x39_mag_s_', attachTo: 0 },
    { prefix: 'SH_Ammo_7.62x39_mag_s_', quantity: 2 },
    { prefix: 'SH_Wear_leather-jacket_', equipped: true },
    { prefix: 'SH_Wear_vest-heavy_', equipped: true },
    { prefix: 'SH_Wear_helm-mid_', equipped: true },
  ] },
  { key: 'bandit-uzi', side: 'bandits', name: 'Бандит (УЗИ)', cell: [14, 5], bio: 'УЗИ, кожанка.', loadout: [
    { prefix: 'SH_Wpn_uzi_', held: true },
    { prefix: 'SH_Ammo_9mm_mag_s_', attachTo: 0 },
    { prefix: 'SH_Ammo_9mm_mag_s_', quantity: 2 },
    { prefix: 'SH_Wear_leather-jacket_', equipped: true },
  ] },
  { key: 'bandit-sawed', side: 'bandits', name: 'Бандит (обрез)', cell: [16, 12], bio: 'Обрез (дробь), кожанка. У двери в коридор.', loadout: [
    { prefix: 'SH_Wpn_sawed_', held: true },
    { prefix: 'SH_Ammo_12ga-buck_round_', quantity: 2, attachTo: 0 },
    { prefix: 'SH_Ammo_12ga-buck_round_', quantity: 1, attachTo: 0, chamber: true },
    { prefix: 'SH_Ammo_12ga-buck_round_', quantity: 10 },
    { prefix: 'SH_Wear_leather-jacket_', equipped: true },
  ] },
  { key: 'bandit-thug', side: 'bandits', name: 'Громила (булава)', cell: [11, 6], abilities: { str: 130, end: 120 }, bio: 'Булава, Глок на поясе, кожанка, тяжёлый жилет. СИЛ 130, ВЫН 120.', loadout: [
    { prefix: 'SH_Wpn_mace_', held: true },
    { prefix: 'SH_Wpn_glock_' },
    { prefix: 'SH_Ammo_9mm_mag_s_', attachTo: 1 },
    { prefix: 'SH_Wear_leather-jacket_', equipped: true },
    { prefix: 'SH_Wear_vest-heavy_', equipped: true },
  ] },
  { key: 'bandit-ap', side: 'bandits', name: 'Бандит (Глок ББ)', cell: [21, 4], bio: 'Глок с бронебойными патронами, кожанка, лёгкий жилет. На кухне — стреляет через гипсокартон.', loadout: [
    { prefix: 'SH_Wpn_glock_', held: true },
    { prefix: 'SH_Ammo_9mm-ap_mag_s_', attachTo: 0 },
    { prefix: 'SH_Ammo_9mm-ap_mag_s_', quantity: 1 },
    { prefix: 'SH_Wear_leather-jacket_', equipped: true },
    { prefix: 'SH_Wear_vest-light_', equipped: true },
  ] },
  // police — combat armour, assault squad
  { key: 'police-lead', side: 'police', name: 'Командир (AR)', cell: [5, 20], bio: 'AR, Глок, боевая броня, тяжёлый шлем.', loadout: [
    { prefix: 'SH_Wpn_ar_', held: true },
    { prefix: 'SH_Ammo_5.56_mag_s_', attachTo: 0 },
    { prefix: 'SH_Ammo_5.56_mag_s_', quantity: 3 },
    { prefix: 'SH_Wpn_glock_' },
    { prefix: 'SH_Ammo_9mm_mag_s_', attachTo: 3 },
    ...POLICE_KIT,
  ] },
  ...[[1, [7, 20]], [2, [12, 20]], [3, [27, 10]]].map(([n, cell]) => ({
    key: `police-ar-${n}`, side: 'police', name: `Штурмовик ${n} (AR)`, cell, bio: 'AR, боевая броня, тяжёлый шлем.', loadout: [
      { prefix: 'SH_Wpn_ar_', held: true },
      { prefix: 'SH_Ammo_5.56_mag_s_', attachTo: 0 },
      { prefix: 'SH_Ammo_5.56_mag_s_', quantity: 3 },
      ...POLICE_KIT,
    ],
  })),
  { key: 'police-saiga', side: 'police', name: 'Штурмовик 4 (Сайга)', cell: [14, 20], bio: 'Сайга (пули, есть магазины дроби), боевая броня, тяжёлый шлем.', loadout: [
    { prefix: 'SH_Wpn_saiga_', held: true },
    { prefix: 'SH_Ammo_12ga-slug_mag_s_', attachTo: 0 },
    { prefix: 'SH_Ammo_12ga-buck_mag_s_', quantity: 2 },
    ...POLICE_KIT,
  ] },
  { key: 'police-p90', side: 'police', name: 'Штурмовик 5 (P90)', cell: [27, 8], bio: 'P90, боевая броня, тяжёлый шлем. У заднего выхода.', loadout: [
    { prefix: 'SH_Wpn_p90_', held: true },
    { prefix: 'SH_Ammo_5.7_mag_s_', attachTo: 0 },
    { prefix: 'SH_Ammo_5.7_mag_s_', quantity: 2 },
    ...POLICE_KIT,
  ] },
];

/* ---- backdrop ---------------------------------------------------- */

/** A very simple vector backdrop: ground, floors, furniture, walls drawn under the scene's real walls. */
function barBackdropSvg() {
  const W = BAR.width * GRID;
  const H = BAR.height * GRID;
  const px = (c) => c * GRID;
  const out = [];
  const rect = (x, y, w, h, fill, extra = '') => out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`);
  const line = (x1, y1, x2, y2, stroke, width, extra = '') => out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}" ${extra}/>`);
  const circle = (cx, cy, r, fill, extra = '') => out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${extra}/>`);
  const text = (x, y, s, size, fill, extra = '') => out.push(`<text x="${x}" y="${y}" font-family="Verdana, sans-serif" font-size="${size}" font-weight="bold" fill="${fill}" text-anchor="middle" ${extra}>${s}</text>`);

  // ground: back lot, alley, sidewalk, road
  rect(0, 0, W, H, '#55524c');
  rect(0, px(16), W, px(1.5), '#9a958c');
  rect(0, px(17.5), W, H - px(17.5), '#3b3f45');
  for (let x = 100; x < W; x += 400) line(x, px(19.9), x + 220, px(19.9), '#d8d2a8', 12);
  line(0, px(17.5), W, px(17.5), '#6d6a64', 10);
  rect(px(26), 0, px(6), px(17.5), '#4b4843');

  // floors
  rect(px(2), px(2), px(16), px(14), '#8a6a48');
  for (let y = px(2) + 50; y < px(16); y += 50) line(px(2), y, px(18), y, '#7b5d3e', 3);
  const tiles = (x0, y0, w, h, a, b) => {
    for (let x = x0; x < x0 + w; x += 50) for (let y = y0; y < y0 + h; y += 50) rect(x, y, 50, 50, ((x + y) / 50) % 2 ? a : b);
  };
  tiles(px(18), px(2), px(8), px(5), '#cfcac0', '#b9b3a6'); // kitchen
  rect(px(18), px(7), px(8), px(4), '#8d8b86'); // storage
  rect(px(18), px(11), px(4), px(5), '#7d6a55'); // corridor
  tiles(px(22), px(11), px(4), px(5), '#b9c4c9', '#a7b3b9'); // toilet

  // bar: shelves with bottles, counter, stools
  rect(px(2.2), px(2.1), px(10.6), 45, '#5a3d28');
  const bottles = ['#4f8f4a', '#a9472f', '#d9b45a', '#6f8fbf', '#8e5aa8'];
  for (let i = 0; i < 26; i += 1) circle(px(2.5) + i * 38, px(2.1) + 22, 11, bottles[i % bottles.length]);
  rect(px(4), px(4.55), px(9), 45, '#4e3220');
  rect(px(12.55), px(3), 45, px(2), '#4e3220');
  rect(px(4), px(4.55), px(9), 10, '#6b4a33');
  for (let i = 0; i < 8; i += 1) circle(px(4.6) + i * 110, px(5.45), 22, '#2e2e2e');

  // tables with chairs
  const table = (cx, cy) => {
    for (const [dx, dy] of [[-62, 0], [62, 0], [0, -62], [0, 62]]) rect(cx + dx - 16, cy + dy - 16, 32, 32, '#3d2b1f');
    circle(cx, cy, 40, '#6b4a33', 'stroke="#4e3220" stroke-width="6"');
  };
  table(550, 950); table(900, 800); table(1200, 1150); table(600, 1400); table(1500, 1350);
  // pool table
  rect(1400, 760, 260, 150, '#4e3220');
  rect(1415, 775, 230, 120, '#2f6b3a');
  for (const [x, y] of [[1415, 775], [1645, 775], [1415, 895], [1645, 895], [1530, 775], [1530, 895]]) circle(x, y, 9, '#111');

  // kitchen: steel counters, stove; storage: crates; toilet: stalls and sinks
  rect(px(18.1), px(2.1), px(7.8), 60, '#9aa0a6');
  rect(px(25.3), px(2.1), 60, px(4.8), '#9aa0a6');
  rect(px(20), px(2.1), 160, 60, '#333');
  for (const dx of [40, 120]) circle(px(20) + dx, px(2.1) + 30, 18, '#555', 'stroke="#222" stroke-width="4"');
  rect(px(20.5), px(4.6), 200, 90, '#9aa0a6');
  const crate = (x, y, s) => {
    rect(x, y, s, s, '#9c7a4c', 'stroke="#6e5332" stroke-width="5"');
    line(x, y, x + s, y + s, '#6e5332', 4); line(x + s, y, x, y + s, '#6e5332', 4);
  };
  crate(px(23.5), px(7.3), 80); crate(px(24.4), px(7.3), 80); crate(px(23.9), px(8.2), 80); crate(px(18.3), px(9.6), 90);
  rect(px(25.4), px(7.2), 50, px(3.5), '#6e6a60');
  for (let i = 0; i < 2; i += 1) rect(px(22.2) + i * 190, px(14.4), 170, 150, 'none', 'stroke="#6f7c82" stroke-width="6"');
  for (let i = 0; i < 2; i += 1) out.push(`<ellipse cx="${px(22.6) + i * 120}" cy="${px(11.35)}" rx="35" ry="22" fill="#f2f2f2" stroke="#999" stroke-width="3"/>`);

  // alley: dumpsters
  rect(2850, 300, 220, 140, '#3e6b4a', 'stroke="#2c4b34" stroke-width="6"');
  rect(2850, 1300, 220, 140, '#3e6b4a', 'stroke="#2c4b34" stroke-width="6"');

  // street: police cars and a civilian car
  const car = (x, y, body, bar) => {
    rect(x, y, 440, 180, body, 'rx="30" stroke="#222" stroke-width="6"');
    rect(x + 120, y + 25, 190, 130, '#2a3540', 'rx="14"');
    if (bar) { rect(x + 190, y + 40, 25, 100, '#2f5fd6'); rect(x + 215, y + 40, 25, 100, '#d63a2f'); }
  };
  car(350, 1800, '#e8e8e8', true);
  car(1150, 1800, '#e8e8e8', true);
  car(2050, 1980, '#7a2f2f', false);

  // walls (drawn; the scene's walls do the work)
  const wallStroke = { brick: ['#2a2420', 26], drywall: ['#4a403a', 12], door: ['#7a4e28', 14], heavyDoor: ['#5a3a1c', 18], window: ['#9fd3e6', 12], counter: null };
  for (const [x1, y1, x2, y2, kind] of BAR_WALLS) {
    const style = wallStroke[kind];
    if (style) line(px(x1), px(y1), px(x2), px(y2), style[0], style[1], 'stroke-linecap="square"');
  }

  // labels
  text(px(10), px(15.6) + 120, 'БАР', 90, '#ff5fa2', 'opacity="0.9"');
  text(px(22), px(6.3), 'КУХНЯ', 48, '#000', 'opacity="0.25"');
  text(px(21), px(10.4), 'СКЛАД', 48, '#000', 'opacity="0.3"');
  text(px(24), px(13.2), 'WC', 48, '#000', 'opacity="0.25"');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${out.join('\n')}\n</svg>\n`;
}

/* ---- documents --------------------------------------------------- */

function folderDoc(key, name, type, parent = null, color = null, sort = 0) {
  return {
    _id: stableId(`${BAR.slug}:folder:${key}`),
    name, type, folder: parent, description: '', sorting: 'm', sort, color, flags: {}, _stats: sceneStats(),
  };
}

function factionDoc(sideKey, folder, sort) {
  const side = SIDES[sideKey];
  const id = stableId(`${BAR.slug}:faction:${sideKey}`);
  return {
    _id: id,
    name: side.name,
    type: 'faction',
    img: 'icons/svg/combat.svg',
    system: {
      abilities: Object.fromEntries(['end', 'str', 'agi', 'cor', 'per', 'int', 'luc'].map((k) => [k, { value: 100 }])),
      fLink: '', fColor: side.color, ppModifier: 1, ppSpends: [],
      biography: `<p>Сторона сцены «${BAR.name}».</p>`,
    },
    prototypeToken: makePrototypeToken({ name: side.name, src: 'icons/svg/combat.svg', disposition: side.disposition }),
    items: [], effects: [], folder, sort, ownership: { default: 0 }, flags: {}, _stats: makeStats(CREATED_TIME),
  };
}

const CHECKLIST_HTML = [
  '<h2>Что проверить</h2>',
  '<ul>',
  '<li><strong>Базовое групповое боестолкновение</strong>: попадание в цель, пробитие брони, создание травм, кровотечение.</li>',
  '<li>Подручные предметы как оружие — когда будет готова такая система.</li>',
  '<li>Подручные предметы как укрытие — когда будет готова такая система.</li>',
  '<li><strong>Пробитие стен.</strong></li>',
  '<li>Разрушение стен — когда будет готова такая система.</li>',
  '</ul>',
  '<h2>Стороны</h2>',
  '<ul>',
  '<li><strong>Герои</strong> (зелёные): плохо экипированы — Глок, дробовик, револьвер .44, нож; брони почти нет, максимум средний жилет.</li>',
  '<li><strong>Бандиты</strong> (красные): все в кожанках, главарь и громила в тяжёлых жилетах; АК, УЗИ, обрез, булава, Глок с бронебойными.</li>',
  '<li><strong>Полиция</strong> (синие): штурмовой отряд в боевой броне и тяжёлых шлемах; AR, Сайга, P90. Четверо на улице за машинами, двое у заднего выхода.</li>',
  '</ul>',
  '<h2>Стены</h2>',
  '<ul>',
  '<li>Внешние — кирпич 250 мм: стрелковое оружие не пробивает.</li>',
  '<li>Внутренние — гипсокартон 25 мм; двери — дерево 40 мм, задняя дверь — 60 мм; окна — стекло 6 мм; стойка — дерево 60 мм (видно сквозь, но пуля встречает дерево).</li>',
  '<li>Пробитие: бандит с Глоком ББ на кухне стреляет в зал сквозь гипсокартон; полиция стреляет в окна и сквозь входную дверь; винтовка пробивает стойку, Глок — нет.</li>',
  '</ul>',
].join('');

function buildBarAdventure() {
  const actorRoot = folderDoc('actors', BAR.name, 'Actor', null, '#6e8fb3', 0);
  const sideFolders = Object.fromEntries(Object.entries(SIDES).map(([key, side], i) => [key, folderDoc(`actors:${key}`, side.name, 'Actor', actorRoot._id, side.color, (i + 1) * 1000)]));
  const factionFolder = folderDoc('actors:factions', 'Фракции', 'Actor', actorRoot._id, null, 9000);
  const sceneFolder = folderDoc('scenes', 'Тестовые сцены', 'Scene', null, '#6e8fb3', 0);
  const journalFolder = folderDoc('journal', 'Тестовые сцены', 'JournalEntry', null, '#6e8fb3', 0);

  const factions = Object.keys(SIDES).map((key, i) => factionDoc(key, factionFolder._id, (i + 1) * 1000));
  const factionUuid = Object.fromEntries(Object.keys(SIDES).map((key, i) => [key, `Actor.${factions[i]._id}`]));

  const fighters = FIGHTERS.map((f, i) => {
    const side = SIDES[f.side];
    return {
      spec: f,
      actor: buildCharacter({
        id: stableId(`${BAR.slug}:actor:${f.key}`),
        name: f.name,
        loadout: f.loadout,
        biography: `<p>${side.name}. ${f.bio}</p>`,
        disposition: side.disposition,
        tint: side.color,
        gFaction: factionUuid[f.side],
        abilities: f.abilities,
        folder: sideFolders[f.side]._id,
        sort: (i + 1) * 1000,
        createdTime: CREATED_TIME,
        withKeys: false,
      }),
    };
  });

  const journalId = stableId(`${BAR.slug}:journal`);
  const pageId = stableId(`${BAR.slug}:journal:checklist`);
  const journal = {
    _id: journalId,
    name: `${BAR.name}: что проверить`,
    pages: [{
      _id: pageId,
      name: 'Что проверить',
      type: 'text',
      title: { show: true, level: 1 },
      text: { content: CHECKLIST_HTML, format: 1 },
      src: null,
      system: {},
      sort: 100000,
      ownership: { default: -1 },
      flags: {},
      _stats: sceneStats(),
    }],
    categories: [],
    folder: journalFolder._id,
    sort: 0,
    ownership: { default: 2 },
    flags: {},
    _stats: sceneStats(),
  };

  const tokens = fighters.map(({ spec, actor }, i) => ({
    _id: stableId(`${BAR.slug}:token:${spec.key}`),
    name: actor.name,
    actorId: actor._id,
    actorLink: false,
    x: spec.cell[0] * GRID,
    y: spec.cell[1] * GRID,
    elevation: 0,
    width: 1,
    height: 1,
    level: LEVEL_ID,
    sort: i,
    disposition: actor.prototypeToken.disposition,
    displayName: 30,
    texture: { ...actor.prototypeToken.texture },
    rotation: 0,
    hidden: false,
    flags: {},
  }));

  const scene = {
    _id: stableId(`${BAR.slug}:scene`),
    name: BAR.name,
    active: false,
    navigation: true,
    navOrder: 0,
    navName: '',
    thumb: null,
    width: BAR.width * GRID,
    height: BAR.height * GRID,
    padding: 0,
    shiftX: 0,
    shiftY: 0,
    initialLevel: LEVEL_ID,
    grid: { type: 1, size: GRID, style: 'solidLines', thickness: 1, color: '#000000', alpha: 0.12, distance: 1, units: 'm' },
    tokenVision: false,
    fog: { mode: 0 },
    environment: { darknessLevel: 0, globalLight: { enabled: true } },
    levels: [{
      _id: LEVEL_ID,
      name: 'Первый этаж',
      elevation: { bottom: null, top: null },
      background: { color: '#55524c', src: BAR.background, tint: '#ffffff', alphaThreshold: 0.75 },
      foreground: { src: null, tint: '#ffffff', alphaThreshold: 0.75 },
      fog: { src: null, tint: '#ffffff' },
      textures: { anchorX: 0.5, anchorY: 0.5, offsetX: 0, offsetY: 0, fit: 'fill', scaleX: 1, scaleY: 1, rotation: 0 },
      visibility: { levels: [] },
      sort: 0,
      flags: {},
    }],
    walls: BAR_WALLS.map(wallDoc),
    tokens,
    notes: [{
      _id: stableId(`${BAR.slug}:note:checklist`),
      entryId: journalId,
      pageId,
      x: 150,
      y: 1680,
      elevation: 0,
      levels: [],
      texture: { src: 'icons/svg/book.svg', anchorX: 0.5, anchorY: 0.5, fit: 'contain', tint: '#ffffff' },
      iconSize: 48,
      text: 'Что проверить',
      fontSize: 28,
      textColor: '#ffffff',
      flags: {},
    }],
    drawings: [], lights: [], sounds: [], regions: [], tiles: [],
    journal: journalId,
    journalEntryPage: pageId,
    weather: '',
    folder: sceneFolder._id,
    sort: 0,
    ownership: { default: 0 },
    flags: {},
    _stats: sceneStats(),
  };

  const adventureId = stableId(`${BAR.slug}:adventure`);
  const adventure = {
    _id: adventureId,
    name: BAR.name,
    img: BAR.background,
    caption: 'Тестовая сцена: групповой бой трёх сторон в баре.',
    description: `<p>Бар с комнатами и стенами из настоящих материалов, три стороны готовы к бою: герои, бандиты, полиция. Импорт создаёт сцену, бойцов, фракции и журнал «что проверить».</p>${CHECKLIST_HTML}`,
    folder: null,
    sort: 0,
    flags: {},
    _stats: sceneStats(),
    _key: `!adventures!${adventureId}`,
  };
  const docs = {
    folders: [actorRoot, ...Object.values(sideFolders), factionFolder, sceneFolder, journalFolder],
    actors: [...factions, ...fighters.map((f) => f.actor)],
    scenes: [scene],
    journal: [journal],
  };
  return { adventure, docs };
}

/* ---- write -------------------------------------------------------- */

function safeName(s) {
  return String(s).replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
}

function wipe(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function writeAdventure({ adventure, docs }, slug) {
  const ADVENTURE_COLLECTIONS = ['actors', 'cards', 'combats', 'folders', 'items', 'journal', 'playlists', 'scenes', 'tables', 'macros'];
  for (const collection of ADVENTURE_COLLECTIONS) {
    adventure[collection] = (docs[collection] ?? []).map((doc) => {
      const rel = `${slug}/${collection}/${safeName(doc.name)}_${doc._id}.json`;
      writeJson(path.join(OUT_DIR, rel), doc);
      return rel;
    });
  }
  writeJson(path.join(OUT_DIR, `SH_Adventure_${slug}_${adventure._id}.json`), adventure);
}

function main() {
  console.log('generating test scenes…');
  wipe(OUT_DIR);
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASSET_DIR, `${BAR.slug}.svg`), barBackdropSvg(), 'utf8');
  const bar = buildBarAdventure();
  writeAdventure(bar, BAR.slug);
  console.log(`done: ${BAR.name} — actors ${bar.docs.actors.length}, walls ${bar.docs.scenes[0].walls.length}, tokens ${bar.docs.scenes[0].tokens.length}`);
}

main();

/**
 * Build actor JSON for `sh-test-actors` from anatomy + current catalog items.
 *
 * Actors:
 *  - Стрелок — humanoid with starter kit (Glock, AK, laser, armor, ammo)
 *  - Мишень  — single-part target dummy
 *
 * Usage:
 *   npm run generate:sh-catalog      (items first)
 *   npm run generate:sh-test-actors
 *   npm run pack:sh-test-actors      (Foundry closed)
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
const CREATED_TIME = 1782901000000;

const SHOOTER_ID = 'shcactshooter000';
const TARGET_ID = 'shcacttarget0000';

// ---------- Anatomy (mirrors AnatomyManager) --------------------------------

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

    out[slotRef] = {
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
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function readSystemVersion() {
  try {
    return String(readJson(path.join(root, 'system.json'))?.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
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

/** Find first pack-src item whose filename starts with prefix. */
function findItemFile(prefix) {
  const files = fs.readdirSync(itemSrcDir).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
  if (!files.length) throw new Error(`No catalog item matching ${prefix}*`);
  files.sort();
  return path.join(itemSrcDir, files[0]);
}

function loadCatalogItem(prefix) {
  return readJson(findItemFile(prefix));
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
      negative: false, priority: 0, alpha: 0.5, angle: 360, bright: 0, color: null,
      coloration: 1, dim: 0, attenuation: 0.5, luminosity: 0.5, saturation: 0, contrast: 0, shadows: 0,
      animation: { type: null, speed: 5, intensity: 5, reverse: false },
    },
    sight: {
      enabled: false, range: 0, angle: 360, visionMode: 'basic', color: null,
      attenuation: 0.1, brightness: 0, saturation: 0, contrast: 0,
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
    abilities: {
      end: { value: 10 }, str: { value: 10 }, dex: { value: 10 }, cor: { value: 10 },
      per: { value: 10 }, int: { value: 10 }, luc: { value: 10 },
    },
  };
}

function embeddedItemId(actorId, srcId, slot) {
  const raw = `e${actorId.slice(-5)}${srcId.slice(-8)}${String(slot).padStart(2, '0')}`;
  return raw.slice(0, 16);
}

/**
 * @param {string} actorId
 * @param {Array<{prefix:string, held?:boolean, equipped?:boolean, quantity?:number, attachTo?:number, attachBlockIndex?:number}>} loadout
 */
function buildEmbeddedItems(actorId, loadout) {
  const items = [];
  let sort = 100000;
  for (let i = 0; i < loadout.length; i += 1) {
    const entry = loadout[i];
    const src = loadCatalogItem(entry.prefix);
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
    if (entry.quantity != null) item.system.quantity = entry.quantity;
    if (entry.held) {
      item.system.held = true;
      item.system.equipped = false;
    }
    if (entry.equipped) {
      item.system.equipped = true;
      item.system.held = false;
    }
    items.push(item);
    sort += 10000;
  }

  for (let i = 0; i < loadout.length; i += 1) {
    const entry = loadout[i];
    if (entry.attachTo == null) continue;
    const child = items[i];
    const host = items[entry.attachTo];
    if (!child || !host) continue;
    child.system.containerHostId = host._id;
    child.system.held = false;
    child.system.equipped = false;
    const line = host.system?.weapon?.lines?.[0];
    const blockIdx = entry.attachBlockIndex ?? 0;
    const block = line?.ammoBlocks?.[blockIdx];
    if (block) {
      block.runtime = block.runtime ?? {};
      block.runtime.attachedItemId = child._id;
    }
  }

  return items;
}

function wipeActors() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(outDir)) {
    if (name.endsWith('.json')) fs.unlinkSync(path.join(outDir, name));
  }
}

function buildShooter() {
  const humanoid = readJson(path.join(anatomyDir, 'humanoid.json'));
  const bodyParts = buildActorBodyParts(humanoid.bodyParts, SHOOTER_ID);
  const anatomyGrid = humanoid.grid && typeof humanoid.grid.width === 'number'
    ? { width: humanoid.grid.width, height: humanoid.grid.height }
    : { width: 9, height: 10 };

  // 0 AK (held) + 1 mag-S attached; spare kit in inventory
  const loadout = [
    { prefix: 'SH_Wpn_ak_', held: true },
    { prefix: 'SH_Ammo_7.62x39_mag_s_', attachTo: 0, attachBlockIndex: 0 },
    { prefix: 'SH_Wpn_glock_' },
    { prefix: 'SH_Ammo_9mm_mag_s_', quantity: 2 },
    { prefix: 'SH_Ammo_9mm_round_', quantity: 60 },
    { prefix: 'SH_Ammo_7.62x39_mag_s_', quantity: 2 },
    { prefix: 'SH_Wpn_lasPistol_' },
    { prefix: 'SH_Ammo_heat_s_', quantity: 1 },
    { prefix: 'SH_Wpn_knife_' },
    { prefix: 'SH_Wear_casual_', equipped: true },
    { prefix: 'SH_Wear_vest-light_', equipped: true },
    { prefix: 'SH_Wear_helm-light_', equipped: true },
  ];

  return {
    name: 'Стрелок',
    type: 'character',
    _id: SHOOTER_ID,
    img: 'icons/svg/mystery-man.svg',
    system: makeCharacterSystem({
      anatomyId: 'humanoid',
      anatomyName: 'Humanoid',
      bodyParts,
      anatomyGrid,
      biography: '<p>Стартовый стрелок каталога: АК в руках, Глок, лазерный пистолет, нож, лёгкая защита.</p>',
    }),
    prototypeToken: makePrototypeToken({
      name: 'Стрелок',
      src: 'icons/svg/mystery-man.svg',
      disposition: 1,
    }),
    items: buildEmbeddedItems(SHOOTER_ID, loadout),
    effects: [],
    folder: null,
    sort: 100000,
    ownership: { default: 0 },
    flags: {},
    _stats: makeStats(0),
    _key: `!actors!${SHOOTER_ID}`,
  };
}

function buildTarget() {
  const slotRef = 'chest#1';
  const bodyParts = {
    [slotRef]: {
      id: 'chest',
      name: 'Мишень',
      slotRef,
      uuid: stableUuid(TARGET_ID, slotRef),
      weight: 100,
      maxHp: 500,
      x: 4,
      y: 4,
      status: 'healthy',
      internal: false,
      tags: ['core'],
      organs: [],
      exposure: { front: 100, right: 100, back: 100, left: 100 },
      relations: [],
      links: [],
    },
  };

  return {
    name: 'Мишень',
    type: 'character',
    _id: TARGET_ID,
    img: 'icons/svg/target.svg',
    system: makeCharacterSystem({
      anatomyId: 'target',
      anatomyName: 'Target Dummy',
      bodyParts,
      anatomyGrid: { width: 9, height: 10 },
      biography: '<p>Одночастная мишень для проверки стрельбы и брони.</p>',
    }),
    prototypeToken: makePrototypeToken({
      name: 'Мишень',
      src: 'icons/svg/target.svg',
      disposition: -1,
    }),
    items: [],
    effects: [],
    folder: null,
    sort: 200000,
    ownership: { default: 0 },
    flags: {},
    _stats: makeStats(1),
    _key: `!actors!${TARGET_ID}`,
  };
}

function main() {
  console.log('generating actors…');
  wipeActors();
  const shooter = buildShooter();
  const target = buildTarget();
  writeJson(path.join(outDir, `SH_Shooter_${SHOOTER_ID}.json`), shooter);
  writeJson(path.join(outDir, `SH_Target_${TARGET_ID}.json`), target);
  console.log(`done: shooter items=${shooter.items.length}, target items=0`);
}

main();

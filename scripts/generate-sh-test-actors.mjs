/**
 * Build deterministic actor JSON sources for the `sh-test-actors` compendium.
 *
 * Reads the canonical humanoid anatomy from `data/anatomy/humanoid.json` and
 * normalizes it the same way `module/anatomy-manager.mjs` does at runtime
 * (slotRef = `${typeId}#${index}`, deterministic uuids, relations remapped).
 *
 * Two actors are generated:
 *  - "Стрелок" (Shooter): character with humanoid anatomy and one stack of
 *    every existing test ammo type embedded in inventory.
 *  - "Мишень" (Target):   character with custom inline anatomy that has a
 *    single body part `chest` (so humanoid chest armor can be equipped).
 *
 * Outputs go to `pack-src/sh-test-actors/`. Files are then compiled to
 * LevelDB by `scripts/compile-sh-test-actors.mjs` (`npm run pack:sh-test-actors`).
 *
 * Usage:
 *   node scripts/generate-sh-test-actors.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const anatomyDir = path.join(root, 'data', 'anatomy');
const ammoSrcDir = path.join(root, 'pack-src', 'sh-test-items');
const outDir = path.join(root, 'pack-src', 'sh-test-actors');

const SYSTEM_VERSION = readSystemVersion();
const CORE_VERSION = '13.350';
const CREATED_TIME = 1776279800100;

const SHOOTER_ID = 'shtestshooter000';
const TARGET_ID = 'shtesttarget0000';

// Source ammo files in sh-test-items (will be embedded into Shooter as items).
const SHOOTER_AMMO_FILES = [
  // Legacy test ammo (English names) — kept while DAMAGE_RESOLVER_TEST_EXAMPLES §1–9 reference them.
  'SH_Test_Ammo_9mm_Ball_shtestammo9mm000.json',
  'SH_Test_Ammo_AP_Rifle_shtestammoap0000.json',
  'SH_Test_Ammo_Buckshot_shtestammobuck00.json',
  'SH_Test_Ammo_HEAT_shtestammoheat00.json',
  'SH_Test_Ammo_Plasma_shtestammoplasma.json',
  // New-spectrum ammo (see DAMAGE_RESOLVER_TEST_ITEMS.md §7).
  'SH_Test_Ammo_Pistol_Ball_shtestammopistbl0.json',
  'SH_Test_Ammo_Pistol_AP_shtestammopistap0.json',
  'SH_Test_Ammo_Rifle_Ball_shtestammorifle00.json',
  'SH_Test_Ammo_Rifle_AP_shtestammorifap00.json',
  'SH_Test_Ammo_Sniper_Ball_shtestammosnipe00.json',
  'SH_Test_Ammo_Sniper_AP_shtestammosnipap0.json'
];

// ---------- Anatomy normalization (mirrors AnatomyManager) -------------------

/** Stable uuid for an embedded body-part instance — keeps git diffs clean. */
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
      relations: Array.isArray(rawPart.relations) ? rawPart.relations.map((r) => ({ ...r })) : []
    };

    out[slotRef] = part;
  }

  // Remap relation targets from raw keys to slotRefs and derive `links`.
  for (const part of Object.values(out)) {
    const remapped = part.relations
      .map((r) => {
        const target = rawKeyToSlotRef[r.target] ?? r.target;
        if (!out[target]) return null;
        return { ...r, target };
      })
      .filter(Boolean);

    // Single-parent enforcement (last wins).
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
    part.links = part.relations
      .filter((r) => r.kind === 'adjacent')
      .map((r) => r.target);
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
    lastModifiedBy: null
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
      alphaThreshold: 0.75
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
      animation: { type: null, speed: 5, intensity: 5, reverse: false }
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
      contrast: 0
    },
    detectionModes: [],
    occludable: { radius: 0 },
    ring: {
      enabled: false,
      colors: { ring: null, background: null },
      effects: 1,
      subject: { scale: 1, texture: null }
    },
    movementAction: null,
    flags: {},
    randomImg: false
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
    luc: { value: 10 }
  };
}

function makeCharacterSystem({ anatomyId, anatomyName, bodyParts, anatomyGrid, biography }) {
  return {
    anatomy: {
      type: anatomyId,
      id: anatomyId,
      name: anatomyName,
      bodyParts: {}
    },
    health: {
      injuries: [],
      bodyParts,
      anatomyGrid
    },
    biography,
    attributes: { level: { value: 1 } },
    actionPoints: { value: 100 },
    speed: 1,
    gFaction: '',
    actions: [],
    aimingArc: {
      zoneHalfDegrees: [1, 5, 15, 25, 30],
      deviationBaseDeg: 1
    },
    abilities: makeBaseAbilities()
  };
}

// ---------- Embedded items (Shooter ammo) -----------------------------------

/**
 * Promote an existing test-ammo source JSON into an embedded item document
 * for the Shooter. Reuses the original item's `system` payload as-is, gives
 * it a fresh, deterministic `_id` so it does not clash with the standalone
 * pack entry, and rewrites `_key` for the actors compendium.
 */
function buildEmbeddedAmmoItem({ srcJson, embeddedId, sort }) {
  const item = JSON.parse(JSON.stringify(srcJson));
  item._id = embeddedId;
  item._key = `!actors.items!${SHOOTER_ID}.${embeddedId}`;
  item.folder = null;
  item.sort = sort;
  item.ownership = { default: 0 };
  item.flags = item.flags ?? {};
  item._stats = {
    ...makeStats(0),
    compendiumSource: null,
    duplicateSource: null
  };
  return item;
}

function loadShooterEmbeddedItems() {
  const items = [];
  let sort = 100000;
  for (const file of SHOOTER_AMMO_FILES) {
    const srcJson = readJson(path.join(ammoSrcDir, file));
    // Stable embedded ids: prefix original with "e" and trim if too long.
    const baseId = String(srcJson._id ?? '').trim();
    if (!baseId) continue;
    const embeddedId = ('e' + baseId).slice(0, 16);
    items.push(buildEmbeddedAmmoItem({ srcJson, embeddedId, sort }));
    sort += 10000;
  }
  return items;
}

// ---------- Actor builders --------------------------------------------------

function buildShooterActor() {
  const humanoid = readJson(path.join(anatomyDir, 'humanoid.json'));
  const bodyParts = buildActorBodyParts(humanoid.bodyParts, SHOOTER_ID);
  const anatomyGrid = humanoid.grid && typeof humanoid.grid.width === 'number'
    ? { width: humanoid.grid.width, height: humanoid.grid.height }
    : { width: 9, height: 10 };

  const items = loadShooterEmbeddedItems();

  return {
    name: 'Стрелок',
    type: 'character',
    _id: SHOOTER_ID,
    img: 'systems/spaceholder/assets/icons/action.svg/bowman.svg',
    system: makeCharacterSystem({
      anatomyId: 'humanoid',
      anatomyName: 'Humanoid',
      bodyParts,
      anatomyGrid,
      biography: '<p>Тестовый стрелок: гуманоидная анатомия, в инвентаре по пачке всех существующих тестовых патронов. Используется для проверки боевых пайплайнов (payload/applications/etc.) до появления настоящего оружия.</p>'
    }),
    prototypeToken: makePrototypeToken({
      name: 'Стрелок',
      src: 'systems/spaceholder/assets/icons/action.svg/bowman.svg',
      disposition: 1
    }),
    items,
    effects: [],
    folder: null,
    sort: 100000,
    ownership: { default: 0 },
    flags: {},
    _stats: makeStats(0),
    _key: `!actors!${SHOOTER_ID}`
  };
}

function buildTargetActor() {
  // Custom inline anatomy: single body part `chest` (so humanoid chest armor
  // resolves through `findActorSlotsForCanonicalPart` by `part.id === "chest"`).
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
      exposure: { front: 100, right: 100, back: 100, left: 100 }
    }
  };

  const bodyParts = buildActorBodyParts(rawBodyParts, TARGET_ID);

  return {
    name: 'Мишень',
    type: 'character',
    _id: TARGET_ID,
    img: 'icons/svg/target.svg',
    system: makeCharacterSystem({
      anatomyId: 'target-chest',
      anatomyName: 'Target Chest',
      bodyParts,
      anatomyGrid: { width: 1, height: 1 },
      biography: '<p>Тестовая мишень для проверки стрельбы. Кастомная анатомия с единственной частью тела <code>chest</code> и большим запасом HP. Принимает гуманоидную броню грудного слота (армор резолвится по <code>part.id === "chest"</code>).</p>'
    }),
    prototypeToken: makePrototypeToken({
      name: 'Мишень',
      src: 'icons/svg/target.svg',
      disposition: 0
    }),
    items: [],
    effects: [],
    folder: null,
    sort: 200000,
    ownership: { default: 0 },
    flags: {},
    _stats: makeStats(1),
    _key: `!actors!${TARGET_ID}`
  };
}

// ---------- Main ------------------------------------------------------------

function main() {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const shooter = buildShooterActor();
  const target = buildTargetActor();

  const shooterFile = path.join(outDir, `SH_Shooter_${SHOOTER_ID}.json`);
  const targetFile = path.join(outDir, `SH_Target_${TARGET_ID}.json`);

  writeJson(shooterFile, shooter);
  writeJson(targetFile, target);

  console.log(`Wrote ${path.relative(root, shooterFile)} (${shooter.items.length} embedded items)`);
  console.log(`Wrote ${path.relative(root, targetFile)} (${target.items.length} embedded items)`);
}

main();

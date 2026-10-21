/**
 * Shared builders for generated compendium actors (`generate-sh-test-actors.mjs`, `generate-sh-test-scenes.mjs`):
 * anatomy → actor body parts (mirrors `AnatomyManager`), catalog loadouts from `pack-src/sh-test-items`
 * (held / worn / loaded into a weapon), prototype tokens and the character system data.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..');
export const ANATOMY_DIR = path.join(ROOT, 'data', 'anatomy');
export const ITEM_SRC_DIR = path.join(ROOT, 'pack-src', 'sh-test-items');

export const SYSTEM_VERSION = readSystemVersion();
/** Core version stamped on actors and items (the catalog's; Foundry migrates them on import). */
export const CORE_VERSION = '13.350';
/** Scenes and adventures are written in the v14 shape (scene levels). */
export const SCENE_CORE_VERSION = '14.360';

/** Stable 16-character document id from a seed (`shc` + md5). */
export function stableId(seed) {
  return (`shc${crypto.createHash('md5').update(seed).digest('hex')}`).slice(0, 16);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function readSystemVersion() {
  try {
    return String(readJson(path.join(ROOT, 'system.json'))?.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/** `_stats` of a generated document; `createdTime` keeps generated output stable between runs. */
export function makeStats(createdTime, extra = 0, coreVersion = CORE_VERSION) {
  return {
    compendiumSource: null,
    duplicateSource: null,
    exportSource: null,
    coreVersion,
    systemId: 'spaceholder',
    systemVersion: SYSTEM_VERSION,
    createdTime: createdTime + extra,
    modifiedTime: createdTime + extra,
    lastModifiedBy: null,
  };
}

// ---------- Anatomy (mirrors AnatomyManager) --------------------------------

function stableUuid(actorId, slotRef) {
  return `${actorId}-bp-${slotRef.replace('#', '-')}`;
}

function coerceCoord(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
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

/**
 * Preset body parts → actor body parts keyed by slotRef (`head#1`), relations remapped to slotRefs.
 * @param {Record<string, object>} rawBodyParts preset `bodyParts`
 * @param {string} actorId
 */
export function buildActorBodyParts(rawBodyParts, actorId) {
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
      maxHp: Number(rawPart.maxHp ?? 0),
      x: coerceCoord(rawPart.x),
      y: coerceCoord(rawPart.y),
      tags: Array.isArray(rawPart.tags) ? [...rawPart.tags] : [],
      material: String(rawPart.material ?? '').trim() || 'skin',
      ...(rawPart.tissue && typeof rawPart.tissue === 'object' ? { tissue: { ...rawPart.tissue } } : {}),
      ...(rawPart.structure && typeof rawPart.structure === 'object' ? { structure: { ...rawPart.structure } } : {}),
      faces: Array.isArray(rawPart.faces) && rawPart.faces.length ? [...rawPart.faces] : ['front'],
      heightFrac: Number.isFinite(Number(rawPart.heightFrac)) ? Number(rawPart.heightFrac) : 0.5,
      inners: Array.isArray(rawPart.inners) ? rawPart.inners.map((o) => ({ ...o, tags: [...(o.tags ?? [])] })) : [],
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

  return { bodyParts: out, rawKeyToSlotRef };
}

/** Preset groups with part keys turned into slotRefs (like `remapGroupParts`). */
export function remapGroups(groups, rawKeyToSlotRef) {
  return (Array.isArray(groups) ? groups : []).map((g) => ({
    id: g.id,
    type: g.type,
    name: g.name ?? g.id,
    parts: (g.parts ?? []).map((p) => rawKeyToSlotRef[p] ?? p),
  }));
}

// ---------- Catalog items ----------------------------------------------------

/** Find the first pack-src item whose filename starts with prefix. */
function findItemFile(prefix) {
  const files = fs.readdirSync(ITEM_SRC_DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
  if (!files.length) throw new Error(`No catalog item matching ${prefix}*`);
  files.sort();
  return path.join(ITEM_SRC_DIR, files[0]);
}

export function loadCatalogItem(prefix) {
  return readJson(findItemFile(prefix));
}

function embeddedItemId(actorId, srcId, slot) {
  const raw = `e${actorId.slice(-5)}${srcId.slice(-8)}${String(slot).padStart(2, '0')}`;
  return raw.slice(0, 16);
}

/**
 * @typedef {Object} LoadoutEntry
 * @property {string} prefix pack-src file name prefix (`SH_Wpn_glock_`)
 * @property {boolean} [held] in hand
 * @property {boolean} [equipped] worn
 * @property {number} [quantity]
 * @property {number} [attachTo] index of the weapon this ammo is loaded into
 * @property {number} [attachBlockIndex] ammo block of the weapon's first line (default 0)
 * @property {boolean} [chamber] goes into the chamber instead of the magazine
 */

/**
 * Embedded items of an actor from catalog entries. Ammo with `attachTo` is loaded into that weapon: a
 * magazine is attached (`attachedItemId`), loose rounds go into an internal magazine (`contentItemIds`) or the
 * chamber (`chamberItemId`); all of them are hosted by the weapon (`containerHostId`).
 * @param {string} actorId
 * @param {LoadoutEntry[]} loadout
 * @param {{ createdTime: number, withKeys?: boolean }} options `withKeys` adds compendium `_key`s (an actor pack;
 *   documents inside an Adventure have none)
 */
export function buildEmbeddedItems(actorId, loadout, { createdTime, withKeys = true }) {
  const items = [];
  let sort = 100000;
  for (let i = 0; i < loadout.length; i += 1) {
    const entry = loadout[i];
    const src = loadCatalogItem(entry.prefix);
    const embeddedId = embeddedItemId(actorId, src._id, i);
    const item = JSON.parse(JSON.stringify(src));
    item._id = embeddedId;
    if (withKeys) item._key = `!actors.items!${actorId}.${embeddedId}`;
    else delete item._key;
    item.folder = null;
    item.sort = sort;
    item.ownership = { default: 0 };
    item.flags = item.flags ?? {};
    item._stats = makeStats(createdTime, i);
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
    const block = line?.ammoBlocks?.[entry.attachBlockIndex ?? 0];
    if (!block) continue;
    block.runtime = block.runtime ?? {};
    if (entry.chamber) block.runtime.chamberItemId = child._id;
    else if (block.type === 'internalMagazine') block.runtime.contentItemIds = [...(block.runtime.contentItemIds ?? []), child._id];
    else block.runtime.attachedItemId = child._id;
  }

  return items;
}

// ---------- Actor parts -------------------------------------------------------

/**
 * @param {{ name: string, src: string, disposition: number, tint?: string }} args
 */
export function makePrototypeToken({ name, src, disposition, tint = '#ffffff' }) {
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
      tint,
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

export function makeCharacterSystem({
  anatomyId, anatomyName, bodyParts, anatomyGrid, biography, groups = [], rootRef = '', heightM, speedMps,
  gFaction = '', abilities = {},
}) {
  return {
    anatomy: { type: anatomyId, id: anatomyId, name: anatomyName, bodyParts: {}, groups, rootRef, hitGroupOverride: '' },
    ...(heightM ? { heightM } : {}),
    ...(speedMps ? { speedMps } : {}),
    health: { injuries: [], bodyParts, anatomyGrid },
    biography,
    attributes: { level: { value: 1 } },
    actionPoints: { value: 100 },
    speed: 1,
    gFaction,
    actions: [],
    aimingArc: { zoneHalfDegrees: [1, 5, 15, 25, 30], deviationBaseDeg: 1 },
    abilities: Object.fromEntries(['end', 'str', 'agi', 'cor', 'per', 'int', 'luc']
      .map((k) => [k, { value: Number(abilities[k] ?? 100) }])),
  };
}

/**
 * A ready character on an anatomy preset with a catalog loadout.
 * @param {Object} args
 * @param {string} args.id actor id
 * @param {string} args.name
 * @param {string} [args.anatomyId] preset in `data/anatomy` (default `humanoid`)
 * @param {LoadoutEntry[]} args.loadout
 * @param {string} args.biography HTML
 * @param {string} [args.img]
 * @param {number} [args.disposition] token disposition (1 friendly, 0 neutral, -1 hostile)
 * @param {string} [args.tint] token tint
 * @param {string} [args.gFaction] faction actor UUID
 * @param {Record<string, number>} [args.abilities] overrides of the 100-scale abilities
 * @param {string|null} [args.folder]
 * @param {number} [args.sort]
 * @param {number} args.createdTime
 * @param {boolean} [args.withKeys] compendium `_key`s (actor pack) or none (inside an Adventure)
 */
export function buildCharacter({
  id, name, anatomyId = 'humanoid', loadout, biography, img = 'icons/svg/mystery-man.svg', disposition = 1,
  tint, gFaction = '', abilities = {}, folder = null, sort = 100000, createdTime, withKeys = true,
}) {
  const preset = readJson(path.join(ANATOMY_DIR, `${anatomyId}.json`));
  const { bodyParts, rawKeyToSlotRef } = buildActorBodyParts(preset.bodyParts, id);
  const anatomyGrid = preset.grid && typeof preset.grid.width === 'number'
    ? { width: preset.grid.width, height: preset.grid.height }
    : { width: 9, height: 9 };
  const actor = {
    name,
    type: 'character',
    _id: id,
    img,
    system: makeCharacterSystem({
      anatomyId,
      anatomyName: preset.name ?? anatomyId,
      bodyParts,
      anatomyGrid,
      groups: remapGroups(preset.groups, rawKeyToSlotRef),
      rootRef: rawKeyToSlotRef[preset.root] ?? '',
      heightM: preset.heightM,
      speedMps: preset.speedMps,
      biography,
      gFaction,
      abilities,
    }),
    prototypeToken: makePrototypeToken({ name, src: img, disposition, tint }),
    items: buildEmbeddedItems(id, loadout, { createdTime, withKeys }),
    effects: [],
    folder,
    sort,
    ownership: { default: 0 },
    flags: {},
    _stats: makeStats(createdTime),
  };
  if (withKeys) actor._key = `!actors!${id}`;
  return actor;
}

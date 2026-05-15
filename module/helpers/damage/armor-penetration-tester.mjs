/**
 * Armor penetration tester helpers.
 *
 * This module keeps the tester's data collection and v3 formula projections
 * separate from the AppV2 class so the math remains easy to smoke-test.
 */

import {
  effectiveArmorRating,
  normalizeApplications,
  projectileEnergy,
  residualDamageAfterArmor,
} from './damage-resolver.mjs';
import { resolveBodyTraversal } from './body-traversal-resolver.mjs';
import { DAMAGE_TYPE_IDS } from './damage-types.mjs';
import { ensureLayerDefaults } from './materials-manager.mjs';

const EPSILON = 1e-9;
const DEFAULT_MATERIAL_ID = 'steel-plate';
/** Matches `packs[].name` in `system.json` (built-in test Item compendium). */
const SH_TEST_ITEMS_PACK_NAME = 'sh-test-items';
const ITEM_PACK_FIELDS = [
  'type',
  'img',
  'system.itemTags',
  'system.weapon',
  'system.coveredParts',
  'system.anatomyId',
];

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positive(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > EPSILON ? n : fallback;
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function clone(value) {
  if (typeof foundry !== 'undefined' && foundry.utils?.deepClone) {
    return foundry.utils.deepClone(value);
  }
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(value ?? null));
}

function docSystem(doc) {
  return doc?.system ?? doc?._source?.system ?? {};
}

function docUuid(doc) {
  return cleanString(doc?.uuid) || cleanString(doc?._source?.uuid);
}

function docImg(doc) {
  return cleanString(doc?.img ?? doc?._source?.img);
}

function docName(doc) {
  return cleanString(doc?.name ?? doc?._source?.name) || cleanString(doc?.id ?? doc?._id);
}

function docId(doc) {
  return cleanString(doc?.id ?? doc?._id);
}

function localize(key, fallback = '') {
  if (!key) return fallback;
  if (typeof game === 'undefined') return fallback;
  const out = game?.i18n?.localize?.(key);
  return out && out !== key ? out : fallback;
}

/**
 * Spreads `projectile.armorPen` onto normalized application items that have no
 * positive per-line value. Compendium data often sets AP only on the parent
 * projectile while `normalizeApplications` zeroes missing fields.
 * @param {Object} projectile
 * @param {Array<Object>} phases
 * @returns {Array<Object>}
 */
export function enrichPhasesWithProjectileDefaults(projectile, phases) {
  if (!phases?.length) return phases;
  const pAp = num(projectile?.armorPen, 0);
  if (!(pAp > 0)) return phases;
  return phases.map((phase) => ({
    ...phase,
    items: (phase.items ?? []).map((item) => {
      if (num(item?.armorPen, 0) > 0) return item;
      return { ...item, armorPen: pAp };
    }),
  }));
}

function normalizeProjectileApplications(projectile, ctx = {}) {
  if (!projectile || typeof projectile !== 'object') return [];

  const builderId = cleanString(projectile.builderId);
  if (builderId && typeof CONFIG !== 'undefined') {
    const builder = CONFIG?.SPACEHOLDER?.applicationBuilders?.[builderId];
    if (typeof builder === 'function') {
      try {
        const built = builder({ ...ctx, projectile });
        const phases = normalizeApplications(built);
        if (phases.length) return enrichPhasesWithProjectileDefaults(projectile, phases);
      } catch (error) {
        console.error(`SpaceHolder | Armor tester application builder "${builderId}" failed:`, error);
      }
    }
  }

  const explicit = normalizeApplications(projectile.applications);
  if (explicit.length) return enrichPhasesWithProjectileDefaults(projectile, explicit);

  const type = cleanString(projectile.damageType);
  const damage = num(projectile.damage, 0);
  if (!type || damage <= 0) return [];

  return enrichPhasesWithProjectileDefaults(projectile, normalizeApplications([{
    type,
    damage,
    armorPen: num(projectile.armorPen, 0),
    armorDamageFactor: positive(projectile.armorDamageFactor, 1),
    hardness: positive(projectile.hardness, 1),
  }]));
}

function flattenApplications(applications) {
  const phases = normalizeApplications(applications);
  const items = [];
  for (const phase of phases) {
    for (const item of phase.items ?? []) items.push({ ...item });
  }
  return items;
}

function primaryApplication(applications) {
  const items = flattenApplications(applications);
  if (!items.length) return null;
  return items.reduce((best, item) => {
    const eBest = projectileEnergy(best.damage, best);
    const eItem = projectileEnergy(item.damage, item);
    return eItem > eBest ? item : best;
  }, items[0]);
}

function materialLabel(material, materialId) {
  const localized = localize(material?.nameLocalized, '');
  return localized || cleanString(material?.name) || cleanString(materialId);
}

function projectileSourceFromItem(item, { sourceKind = 'world', pack = null } = {}) {
  if (!item || item.type !== 'item') return null;
  const system = docSystem(item);
  if (!system?.itemTags?.isAmmo) return null;

  const projectile = clone(system?.weapon?.ammo?.projectile ?? {});
  const applications = normalizeProjectileApplications(projectile, { item });
  if (!applications.length) return null;

  const app = primaryApplication(applications);
  const resource = system?.weapon?.ammo?.resource ?? {};
  const compatibilityTags = Array.isArray(resource.compatibilityTags)
    ? resource.compatibilityTags.map(cleanString).filter(Boolean)
    : [];
  const caliberTag = cleanString(resource.caliberTag);
  const damageTypes = Array.from(new Set(flattenApplications(applications).map((i) => i.type))).sort();
  const totalDamage = flattenApplications(applications).reduce((sum, i) => sum + num(i.damage, 0), 0);
  const maxEnergy = Math.max(0, ...flattenApplications(applications).map((i) => projectileEnergy(i.damage, i)));
  const uuid = docUuid(item);
  const id = uuid || `${sourceKind}:${pack?.collection ?? 'world'}:${docId(item) || docName(item)}`;

  return {
    id,
    uuid,
    itemId: docId(item),
    name: docName(item),
    img: docImg(item),
    sourceKind,
    packCollection: pack?.collection ?? '',
    projectile,
    applications,
    primary: app,
    damageTypes,
    totalDamage,
    maxEnergy,
    caliberTag,
    compatibilityTags,
    resourceType: cleanString(resource.resourceType),
  };
}

function armorSourceFromItem(item, { sourceKind = 'world', pack = null } = {}) {
  if (!item || item.type !== 'item') return null;
  const system = docSystem(item);
  if (!system?.itemTags?.isArmor) return null;

  const coveredParts = Array.isArray(system.coveredParts) ? clone(system.coveredParts) : [];
  const layerCount = coveredParts.reduce((sum, part) => sum + (Array.isArray(part?.layers) ? part.layers.length : 0), 0);
  const uuid = docUuid(item);
  const id = uuid || `${sourceKind}:${pack?.collection ?? 'world'}:${docId(item) || docName(item)}`;
  return {
    id,
    uuid,
    itemId: docId(item),
    name: docName(item),
    img: docImg(item),
    sourceKind,
    packCollection: pack?.collection ?? '',
    anatomyId: cleanString(system.anatomyId),
    coveredParts,
    layerCount,
  };
}

/**
 * Unique `slotRef` values from armor `coveredParts` with at least one layer
 * with positive thickness. Order matches first occurrence in the item.
 * @param {{ coveredParts?: Array<{ slotRef?: string, partId?: string, layers?: Array }> } | null} armor
 * @returns {string[]}
 */
export function listArmorCoveredSlotRefs(armor) {
  if (!armor || typeof armor !== 'object') return [];
  const parts = Array.isArray(armor.coveredParts) ? armor.coveredParts : [];
  const seen = new Set();
  const ordered = [];
  for (const entry of parts) {
    const slot = cleanString(entry?.slotRef ?? entry?.partId);
    if (!slot || seen.has(slot)) continue;
    const layers = Array.isArray(entry?.layers) ? entry.layers : [];
    const has = layers.some((l) => num(l?.thickness, 0) > 0);
    if (has) {
      seen.add(slot);
      ordered.push(slot);
    }
  }
  return ordered;
}

const MINIMAL_PART_EXPOSURE = Object.freeze({
  front: 1,
  back: 1,
  left: 1,
  right: 1,
  top: 1,
  bottom: 1,
});

/**
 * Minimum `anatomy` shape for {@link resolveBodyTraversal} when previewing
 * a single hit slot (no full preset or actor). One body part, full
 * exposure, no `behind` transfers.
 * @param {string} slotRef
 * @returns {{ bodyParts: Record<string, { id: string, name: string, exposure: Object, relations: [] }> }}
 */
export function minimalAnatomyForArmorSlot(slotRef) {
  const id = cleanString(slotRef);
  if (!id) return { bodyParts: {} };
  return {
    bodyParts: {
      [id]: {
        id,
        name: id,
        exposure: { ...MINIMAL_PART_EXPOSURE },
        relations: [],
      },
    },
  };
}

function isShTestItemsPack(pack) {
  return cleanString(pack?.metadata?.name) === SH_TEST_ITEMS_PACK_NAME;
}

async function collectPackDocuments(predicate, { packFilter = null } = {}) {
  const packs = typeof game !== 'undefined' ? game?.packs ?? null : null;
  if (!packs) return [];

  const docs = [];
  for (const pack of packs) {
    if (packFilter && !packFilter(pack)) continue;
    if (pack?.metadata?.type !== 'Item') continue;
    if (pack?.metadata?.system && pack.metadata.system !== 'spaceholder') continue;

    let index;
    try {
      index = await pack.getIndex({ fields: ITEM_PACK_FIELDS });
    } catch (error) {
      console.warn(`SpaceHolder | Armor tester failed to index pack ${pack?.collection}:`, error);
      continue;
    }

    const ids = [];
    for (const entry of index) {
      try {
        if (predicate(entry)) ids.push(entry._id);
      } catch (_) {
        // Ignore malformed index rows.
      }
    }

    for (const id of ids) {
      try {
        const doc = await pack.getDocument(id);
        if (doc) docs.push({ doc, pack });
      } catch (error) {
        console.warn(`SpaceHolder | Armor tester failed to load ${pack?.collection}.${id}:`, error);
      }
    }
  }
  return docs;
}

function sortByName(list) {
  const lang = typeof game !== 'undefined' ? game?.i18n?.lang || 'en' : 'en';
  return list.slice().sort((a, b) => {
    const aLabel = cleanString(a.name ?? a.label ?? a.id);
    const bLabel = cleanString(b.name ?? b.label ?? b.id);
    return aLabel.localeCompare(bLabel, lang);
  });
}

/**
 * @returns {Array<{id:string,label:string,sourceUuid:string|null,data:Object}>}
 */
export function collectMaterialChoices(manager = (typeof game !== 'undefined' ? game?.spaceholder?.materialsManager : null)) {
  const ids = manager?.listMaterialIds?.() ?? [];
  const out = ids.map((id) => {
    const data = manager.getMaterial(id);
    return {
      id,
      label: materialLabel(data, id),
      sourceUuid: manager.getSourceUuid?.(id) ?? null,
      data,
    };
  });
  return sortByName(out);
}

/**
 * @returns {string}
 */
export function chooseDefaultMaterialId(materials) {
  const ids = new Set((materials ?? []).map((m) => m.id));
  if (ids.has(DEFAULT_MATERIAL_ID)) return DEFAULT_MATERIAL_ID;
  return (materials ?? [])[0]?.id ?? '';
}

/**
 * @param {Object} [options]
 * @param {boolean} [options.includePacks]
 * @param {boolean} [options.includeWorld]
 * @param {'all'|'compendium'|'world'} [options.sourceFilter] When `compendium`, only `sh-test-items` pack; `world` omits compendia.
 * @returns {Promise<Array<Object>>}
 */
export async function collectProjectileSources({ includePacks = true, includeWorld = true, sourceFilter = 'all' } = {}) {
  let usePacks = includePacks;
  let useWorld = includeWorld;
  let packFilter = null;
  if (sourceFilter === 'compendium') {
    usePacks = true;
    useWorld = false;
    packFilter = isShTestItemsPack;
  } else if (sourceFilter === 'world') {
    usePacks = false;
    useWorld = true;
  }

  const sources = [];
  if (usePacks) {
    const entries = await collectPackDocuments(
      (entry) => entry?.type === 'item' && entry?.system?.itemTags?.isAmmo,
      { packFilter }
    );
    for (const { doc, pack } of entries) {
      const src = projectileSourceFromItem(doc, { sourceKind: 'pack', pack });
      if (src) sources.push(src);
    }
  }
  if (useWorld) {
    const items = typeof game !== 'undefined' ? game?.items?.contents ?? [] : [];
    for (const item of items) {
      const src = projectileSourceFromItem(item, { sourceKind: 'world' });
      if (src) sources.push(src);
    }
  }

  const unique = new Map();
  for (const src of sources) unique.set(src.id, src);
  return sortByName(Array.from(unique.values()));
}

/**
 * @param {Object} [options] Same as {@link collectProjectileSources}.
 * @returns {Promise<Array<Object>>}
 */
export async function collectArmorSources({ includePacks = true, includeWorld = true, sourceFilter = 'all' } = {}) {
  let usePacks = includePacks;
  let useWorld = includeWorld;
  let packFilter = null;
  if (sourceFilter === 'compendium') {
    usePacks = true;
    useWorld = false;
    packFilter = isShTestItemsPack;
  } else if (sourceFilter === 'world') {
    usePacks = false;
    useWorld = true;
  }

  const sources = [];
  if (usePacks) {
    const entries = await collectPackDocuments(
      (entry) => entry?.type === 'item' && entry?.system?.itemTags?.isArmor,
      { packFilter }
    );
    for (const { doc, pack } of entries) {
      const src = armorSourceFromItem(doc, { sourceKind: 'pack', pack });
      if (src) sources.push(src);
    }
  }
  if (useWorld) {
    const items = typeof game !== 'undefined' ? game?.items?.contents ?? [] : [];
    for (const item of items) {
      const src = armorSourceFromItem(item, { sourceKind: 'world' });
      if (src) sources.push(src);
    }
  }

  const unique = new Map();
  for (const src of sources) unique.set(src.id, src);
  return sortByName(Array.from(unique.values()));
}

/**
 * @param {unknown} applications
 * @param {Object} material
 * @returns {Object}
 */
export function calculateStopThickness(applications, material) {
  const items = flattenApplications(applications);
  if (!items.length) return { thickness: 0, limiting: null, rows: [] };

  const rows = items.map((item) => {
    const energy = projectileEnergy(item.damage, item);
    const materialHardness = positive(material?.hardness, 1);
    const resistancePercent = Math.max(0, num(material?.resistance?.[item.type], 0));
    const denominator = materialHardness * (resistancePercent / 100);
    const thickness = energy <= EPSILON
      ? 0
      : denominator > EPSILON
        ? Math.sqrt(energy / denominator)
        : Infinity;
    return { ...item, energy, materialHardness, resistancePercent, thickness };
  });

  const limiting = rows.reduce((best, row) => {
    if (!best) return row;
    return row.thickness > best.thickness ? row : best;
  }, null);

  return {
    thickness: limiting?.thickness ?? 0,
    limiting,
    rows,
  };
}

/**
 * @param {unknown} applications
 * @param {Object} material
 * @param {number} thickness
 * @returns {Object}
 */
export function calculateThicknessCheck(applications, material, thickness) {
  const t = Math.max(0, num(thickness, 0));
  const layer = { material: material?.materialId ?? '', thickness: t };
  const rows = flattenApplications(applications).map((item) => {
    const energy = projectileEnergy(item.damage, item);
    const armor = effectiveArmorRating(layer, material, item.type);
    const residual = residualDamageAfterArmor(item.damage, energy, armor.eARBase);
    const penetrates = energy > armor.eARBase + EPSILON;
    return {
      ...item,
      energy,
      eAR: armor.eARBase,
      residualDamage: residual.residual,
      residualEnergy: residual.energyAfter,
      penetrates,
    };
  });

  return {
    thickness: t,
    penetrates: rows.some((row) => row.penetrates),
    stopped: rows.length > 0 && rows.every((row) => !row.penetrates),
    rows,
  };
}

/**
 * @param {Object} armor
 * @param {Object} anatomy
 * @param {string} slotRef
 * @param {(id:string)=>Object} resolveMaterial
 * @returns {Object<string, Array<{itemId:string, coverageIdx:number, layers:Array}>>}
 */
export function buildArmorBySlotForPreview(armor, anatomy, slotRef, resolveMaterial) {
  const partId = cleanString(slotRef);
  if (!armor || !partId) return {};
  const bodyParts = anatomy?.bodyParts && typeof anatomy.bodyParts === 'object' ? anatomy.bodyParts : {};
  if (Object.keys(bodyParts).length && !bodyParts[partId]) return {};

  const out = {};
  const coveredParts = Array.isArray(armor.coveredParts) ? armor.coveredParts : [];
  for (let i = 0; i < coveredParts.length; i += 1) {
    const entry = coveredParts[i];
    const entrySlot = cleanString(entry?.slotRef ?? entry?.partId);
    if (!entrySlot) continue;
    if (Object.keys(bodyParts).length && !bodyParts[entrySlot]) continue;
    const layers = (Array.isArray(entry?.layers) ? entry.layers : [])
      .map((layer) => ensureLayerDefaults(layer, resolveMaterial?.(layer?.material) ?? { materialId: layer?.material }))
      .filter((layer) => layer.thickness > 0);
    if (layers.length) {
      if (!out[entrySlot]) out[entrySlot] = [];
      out[entrySlot].push({
        itemId: armor.itemId || armor.id || 'preview-armor',
        coverageIdx: i,
        layers,
      });
    }
  }
  return out;
}

/**
 * @param {Object} args
 * @returns {Object|null}
 */
export function previewArmorTraversal({
  projectile,
  armor,
  anatomy,
  slotRef,
  hitDirection = 'front',
  resolveMaterial,
  random,
} = {}) {
  if (!projectile || !armor || !anatomy || !slotRef) return null;
  const applications = projectile.applications ?? normalizeProjectileApplications(projectile.projectile ?? projectile);
  const armorBySlot = buildArmorBySlotForPreview(armor, anatomy, slotRef, resolveMaterial);
  return resolveBodyTraversal({
    anatomy,
    startSlotRef: slotRef,
    hitDirection,
    applications,
    armorBySlot,
    resolveMaterial,
    random: random ?? (() => 0.999999),
  });
}

export function damageTypeOptions() {
  return DAMAGE_TYPE_IDS.map((id) => {
    const label = localize(`SPACEHOLDER.DamageTypes.${id[0].toUpperCase()}${id.slice(1)}.Label`, id);
    return { id, label };
  });
}

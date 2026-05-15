/**
 * Materials manager.
 *
 * Materials are stored as Foundry items of type `material`. The manager:
 *  - indexes all `material` items found in the world + system compendium
 *    packs by their `system.materialId` slug;
 *  - exposes pure helpers that take a `materialId` and return a fully
 *    normalized material data object usable by the damage resolver.
 *
 * The canonical catalog ships in the system compendium (see
 * `pack-src/sh-test-items/SH_Material_*.json`); there is no code-defined
 * fallback. Callers that reference a slug not present in any pack or in
 * the world get a synthetic empty material (zero resistance / zero wear)
 * so the resolver never crashes on stale references.
 *
 * Layers (on wearable items) reference materials by slug:
 *   `system.layers[i].material = "steel-plate"`
 *
 * The damage resolver consumes plain material data objects (see
 * {@link normalizeMaterial}); it does **not** require Foundry being loaded,
 * which keeps it unit-testable. Node smoke tests feed it an explicit
 * fixture catalog from `__fixtures__/test-materials.mjs`.
 */

import { DAMAGE_TYPE_IDS, DEGRADATION_MODES, getDamageType, isDamageType } from './damage-types.mjs';

/* ------------------------------------------------------------------ *
 *  Pure normalization helpers                                         *
 * ------------------------------------------------------------------ */

function _coerceNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _coerceMaterialHardness(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const values = Object.values(raw)
      .map((v) => _coerceNumber(v, 0))
      .filter((v) => Number.isFinite(v) && v > 0);
    return values.length ? Math.max(...values) : 1;
  }
  const n = _coerceNumber(raw, 1);
  return Number.isFinite(n) && n > 0 ? Math.max(1e-9, n) : 1;
}

function _coerceFractionList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let total = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const type = String(entry.type ?? '').trim();
    if (!isDamageType(type)) continue;
    const fraction = Math.max(0, _coerceNumber(entry.fraction, 0));
    if (fraction <= 0) continue;
    if (total + fraction > 1) {
      const allowed = Math.max(0, 1 - total);
      if (allowed <= 0) break;
      out.push({ type, fraction: allowed });
      total = 1;
      break;
    }
    out.push({ type, fraction });
    total += fraction;
  }
  return out;
}

function _coerceDegradationMode(raw) {
  if (typeof raw !== 'string') return null;
  const lower = raw.toLowerCase().trim();
  for (const value of Object.values(DEGRADATION_MODES)) {
    if (value === lower) return value;
  }
  return null;
}

/**
 * Normalize a partial material payload into a fully populated material
 * object the damage resolver can consume directly. Missing per-type rows
 * fall back to:
 *  - `resistance` / `wear` → 0
 *  - `hardness` → scalar default `1` (legacy per-type objects fall back to
 *    their highest positive value)
 *  - `conductance` → the damage type's default conductance (usually empty)
 *  - `selfInduction` → the damage type's default self-induction
 *  - `degradation` → the damage type's default degradation mode
 *
 * `conductance[T]` and `selfInduction[T]` are lists of `{type, fraction}`;
 * each list's total fraction is clipped to `≤ 1` by {@link _coerceFractionList}.
 *
 * @param {Object} src - raw material data (from an item's `system` payload
 *   or a test fixture).
 * @returns {Object} normalized material data
 */
export function normalizeMaterial(src) {
  const safe = (src && typeof src === 'object') ? src : {};
  const integrityPerThickness = Math.max(0, _coerceNumber(safe.integrityPerThickness, 0));
  const breachRaw = _coerceNumber(safe.breachCapacityPerThickness, 0);
  const breachCapacityPerThickness = breachRaw > 0 ? breachRaw : integrityPerThickness;

  const resistance = {};
  const wear = {};
  const conductance = {};
  const selfInduction = {};
  const degradation = {};

  const srcResistance = (safe.resistance && typeof safe.resistance === 'object') ? safe.resistance : {};
  const srcWear = (safe.wear && typeof safe.wear === 'object') ? safe.wear : {};
  const srcConductance = (safe.conductance && typeof safe.conductance === 'object') ? safe.conductance : {};
  const srcSelfInduction = (safe.selfInduction && typeof safe.selfInduction === 'object') ? safe.selfInduction : {};
  const srcDegradation = (safe.degradation && typeof safe.degradation === 'object') ? safe.degradation : {};
  const defaultDegradation = _coerceDegradationMode(srcDegradation.default);
  const hardness = _coerceMaterialHardness(safe.hardness);

  for (const id of DAMAGE_TYPE_IDS) {
    const def = getDamageType(id);
    resistance[id] = Math.max(0, _coerceNumber(srcResistance[id], 0));
    wear[id] = Math.max(0, _coerceNumber(srcWear[id], 0));

    if (Object.prototype.hasOwnProperty.call(srcConductance, id)) {
      conductance[id] = _coerceFractionList(srcConductance[id]);
    } else {
      conductance[id] = def ? def.defaultConductance.map((e) => ({ ...e })) : [];
    }

    if (Object.prototype.hasOwnProperty.call(srcSelfInduction, id)) {
      selfInduction[id] = _coerceFractionList(srcSelfInduction[id]);
    } else {
      selfInduction[id] = def ? def.defaultSelfInduction.map((e) => ({ ...e })) : [];
    }

    const ownMode = _coerceDegradationMode(srcDegradation[id]);
    if (ownMode) degradation[id] = ownMode;
    else if (defaultDegradation) degradation[id] = defaultDegradation;
    else degradation[id] = def?.defaultDegradation ?? DEGRADATION_MODES.REDUCTION;
  }

  return {
    materialId: String(safe.materialId ?? '').trim(),
    name: String(safe.name ?? safe.materialId ?? '').trim(),
    nameLocalized: typeof safe.nameLocalized === 'string' ? safe.nameLocalized : '',
    description: typeof safe.description === 'string' ? safe.description : '',
    descriptionLocalized: typeof safe.descriptionLocalized === 'string' ? safe.descriptionLocalized : '',
    category: typeof safe.category === 'string' ? safe.category : 'metal',
    integrityPerThickness,
    breachCapacityPerThickness,
    weightPerThickness: Math.max(0, _coerceNumber(safe.weightPerThickness, 0)),
    resistance,
    wear,
    hardness,
    conductance,
    selfInduction,
    degradation
  };
}

/**
 * Build a layer state object from a `(materialId, thickness)` pair plus
 * any pre-existing values to preserve (e.g. when re-loading a saved
 * actor). Pure: requires the material data object to be supplied.
 *
 * @param {{
 *   material: string,
 *   thickness: number,
 *   integrity?: number,
 *   integrityMax?: number,
 *   breachLoss?: number,
 *   breachCapacity?: number
 * }} layer
 * @param {Object} materialData - normalized material data
 * @returns {Object} layer with all derived fields filled in
 */
export function ensureLayerDefaults(layer, materialData) {
  const thickness = Math.max(0, _coerceNumber(layer?.thickness, 1));
  const md = normalizeMaterial(materialData);
  const integrityMax = Math.max(0, _coerceNumber(layer?.integrityMax, md.integrityPerThickness * thickness));
  const integrity = Math.max(0, Math.min(integrityMax, _coerceNumber(layer?.integrity, integrityMax)));
  const breachCapacity = Math.max(0, _coerceNumber(layer?.breachCapacity, md.breachCapacityPerThickness * thickness));
  const breachLoss = Math.max(0, Math.min(breachCapacity, _coerceNumber(layer?.breachLoss, 0)));
  const out = {
    material: String(layer?.material ?? md.materialId ?? '').trim(),
    thickness,
    integrity,
    integrityMax,
    breachLoss,
    breachCapacity
  };
  // Preserve any caller-supplied `key` so consumers can correlate resolver
  // output back to the original layer source (e.g. the owning item id).
  if (layer && typeof layer === 'object' && layer.key !== undefined && layer.key !== null) {
    out.key = layer.key;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  MaterialsManager (Foundry-aware indexer)                           *
 * ------------------------------------------------------------------ */

export class MaterialsManager {
  constructor() {
    /** @type {Map<string, Object>} normalized data by materialId */
    this._cache = new Map();
    /** @type {Map<string, string>} materialId -> source uuid (item) */
    this._sources = new Map();
    this._initialized = false;
  }

  /**
   * Build the index from system compendium packs + world Items. Safe to
   * call multiple times; subsequent calls re-scan and refresh. Packs are
   * indexed first so that world items can override pack entries with the
   * same slug (a GM may want to hot-patch a material in a specific world
   * without touching the system pack).
   */
  async initialize() {
    this._cache.clear();
    this._sources.clear();

    if (typeof game !== 'undefined') {
      try { await this._indexCompendiumItems(); } catch (e) { console.error('SpaceHolder | MaterialsManager: pack index failed', e); }
      try { this._indexWorldItems(); } catch (e) { console.error('SpaceHolder | MaterialsManager: world index failed', e); }
    }

    this._initialized = true;
  }

  _registerItem(item, sourceLabel) {
    if (!item || item.type !== 'material') return;
    const sys = item.system ?? {};
    const slug = String(sys.materialId ?? '').trim();
    if (!slug) return;
    this._cache.set(slug, normalizeMaterial({
      ...sys,
      materialId: slug,
      name: item.name || sys.name || slug
    }));
    this._sources.set(slug, item.uuid ?? `${sourceLabel}:${item.id}`);
  }

  _indexWorldItems() {
    const items = game?.items?.contents ?? [];
    for (const item of items) this._registerItem(item, 'world');
  }

  async _indexCompendiumItems() {
    const packs = game?.packs ?? null;
    if (!packs) return;
    for (const pack of packs) {
      if (pack?.metadata?.type !== 'Item') continue;
      if (pack?.metadata?.system && pack.metadata.system !== 'spaceholder') continue;
      let docs;
      try {
        const index = await pack.getIndex({ fields: ['type', 'system.materialId'] });
        const ids = [];
        for (const e of index) {
          if (e.type === 'material') ids.push(e._id);
        }
        if (!ids.length) continue;
        docs = await Promise.all(ids.map((id) => pack.getDocument(id)));
      } catch (e) {
        console.warn(`SpaceHolder | MaterialsManager: failed to index pack ${pack?.collection}`, e);
        continue;
      }
      for (const doc of docs) this._registerItem(doc, `pack:${pack.collection}`);
    }
  }

  /**
   * Get normalized material data by slug. Returns a synthetic empty
   * material (zero resistance/wear, empty conductance) for unknown slugs
   * so the resolver never crashes on bad references.
   * @param {string} materialId
   * @returns {Object}
   */
  getMaterial(materialId) {
    const slug = String(materialId ?? '').trim();
    if (!slug) return normalizeMaterial({ materialId: '' });
    if (this._cache.has(slug)) return this._cache.get(slug);
    return normalizeMaterial({ materialId: slug });
  }

  /**
   * @returns {string[]} sorted list of every material slug currently known
   *   to the manager (world + pack items).
   */
  listMaterialIds() {
    return Array.from(this._cache.keys()).sort();
  }

  /**
   * @param {string} materialId
   * @returns {string|null} uuid of the source Item, or null if the slug is
   *   not known to the manager.
   */
  getSourceUuid(materialId) {
    return this._sources.get(String(materialId ?? '').trim()) ?? null;
  }
}

export const materialsManager = new MaterialsManager();

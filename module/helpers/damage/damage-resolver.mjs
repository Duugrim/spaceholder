/**
 * Damage resolver — pure functions that take a layer stack plus a phased
 * application package and return:
 *   - the damage that reaches the body (per damage type),
 *   - the updated layer states (integrity / breachLoss),
 *   - a structured trace useful for chat reporting and tests.
 *
 * The resolver does **not** import Foundry — it depends only on the damage
 * type registry + materials manager helpers in this folder. That keeps it
 * unit-testable.
 *
 * See `docs/damage-types-armor-conversion` plan, §1, §3, §6, §7.
 */

import { DAMAGE_TYPE_IDS, DEGRADATION_MODES, isDamageType } from './damage-types.mjs';
import { ensureLayerDefaults, normalizeMaterial } from './materials-manager.mjs';

const EPSILON = 1e-9;

/* ================================================================== *
 *  Public types (informal JSDoc)                                      *
 * ================================================================== *

 * @typedef {Object} DamageInstance
 * @property {string} type   - damage-type id
 * @property {number} amount - magnitude (float)

 * @typedef {Object} ApplicationItem
 * @property {string} type
 * @property {number} damage
 * @property {number} [armorPen]            - penetration factor in the v3 energy formula
 * @property {number} [armorDamageFactor]   - multiplier applied to wear[T]
 * @property {number} [hardness]            - projectile hardness in the v3 energy formula

 * @typedef {Object} ApplicationPhase
 * @property {'sequential'|'parallel'} mode
 * @property {ApplicationItem[]} items

 * @typedef {Object} LayerState
 * @property {string} material     - materialId slug
 * @property {number} thickness
 * @property {number} integrity
 * @property {number} integrityMax
 * @property {number} breachLoss
 * @property {number} breachCapacity

 * @typedef {Object} ResolverContext
 * @property {(materialId: string) => Object} resolveMaterial
 * @property {() => number} [random] - injectable RNG, returns [0, 1)
 */

/* ================================================================== *
 *  Helpers                                                            *
 * ================================================================== */

function _isPositive(n) { return Number.isFinite(n) && n > EPSILON; }

/** @param {unknown} h */
function _positiveProjectileHardness(h) {
  const n = Number(h);
  return Number.isFinite(n) && n > EPSILON ? n : 1;
}

/**
 * @param {unknown} ap
 * @returns {number}
 */
function _nonNegativeArmorPen(ap) {
  const n = Number(ap);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * v3 armour rating before degradation. `resistance[type]` is an integer
 * percentage: 100 means the material uses its full scalar hardness against
 * this damage type.
 *
 * @param {LayerState} layer
 * @param {Object} material
 * @param {string} type
 * @returns {{ ar: number, eARBase: number, materialHardness: number, resistancePercent: number }}
 */
export function effectiveArmorRating(layer, material, type) {
  const thickness = Math.max(0, Number(layer?.thickness ?? 0) || 0);
  const materialHardness = _positiveProjectileHardness(material?.hardness ?? 1);
  const resistancePercent = Math.max(0, Number(material?.resistance?.[type] ?? 0) || 0);
  const ar = materialHardness * thickness * thickness;
  const eARBase = ar * resistancePercent / 100;
  return { ar, eARBase, materialHardness, resistancePercent };
}

/**
 * v3 projectile energy for one structural hit.
 * @param {number} amount
 * @param {{ armorPen?: number, hardness?: number }} mods
 * @returns {number}
 */
export function projectileEnergy(amount, mods) {
  const damage = Math.max(0, Number(amount) || 0);
  const armorPen = _nonNegativeArmorPen(mods?.armorPen);
  const hardness = _positiveProjectileHardness(mods?.hardness);
  return damage * armorPen * armorPen * hardness;
}

/**
 * Convert absorbed energy back into the same damage scale as the incoming hit.
 * @param {number} amount
 * @param {number} energyBefore
 * @param {number} eAR
 * @returns {{ energyAfter: number, residual: number }}
 */
export function residualDamageAfterArmor(amount, energyBefore, eAR) {
  const energy = Math.max(0, Number(energyBefore) || 0);
  if (energy <= EPSILON) return { energyAfter: 0, residual: 0 };
  const energyAfter = Math.max(0, energy - Math.max(0, Number(eAR) || 0));
  const residual = Math.max(0, Number(amount) || 0) * (energyAfter / energy);
  return { energyAfter, residual };
}

function _wearCoefficient(material, type) {
  return Math.max(0, Number(material?.wear?.[type] ?? 0) || 0) / 100;
}

/**
 * Normalize a raw projectile.applications value into the canonical phased
 * format `[{ mode, items }, ...]`. Accepts:
 *  - legacy single damage/damageType pair (`{ type, damage }` synthesised
 *    by callers); this function is forgiving about input shape.
 *  - flat array of items (treated as one sequential phase).
 *  - already-phased array (passed through).
 *
 * Empty or invalid items are filtered out. Damage types unknown to
 * `CONFIG.SPACEHOLDER.damageTypes` are skipped so a typo cannot crash the
 * resolver.
 *
 * @param {unknown} raw
 * @returns {ApplicationPhase[]}
 */
export function normalizeApplications(raw) {
  if (raw == null) return [];

  const sanitizeItem = (item) => {
    if (!item || typeof item !== 'object') return null;
    const type = String(item.type ?? '').trim();
    if (!isDamageType(type)) return null;
    const damage = Number(item.damage ?? 0);
    if (!Number.isFinite(damage) || damage <= 0) return null;
    const armorPen = Number(item.armorPen ?? 0);
    const armorDamageFactor = Number(item.armorDamageFactor ?? 1);
    const hardnessRaw = Number(item.hardness ?? 1);
    return {
      type,
      damage,
      armorPen: Number.isFinite(armorPen) && armorPen > 0 ? armorPen : 0,
      armorDamageFactor: Number.isFinite(armorDamageFactor) && armorDamageFactor > 0 ? armorDamageFactor : 1,
      hardness: Number.isFinite(hardnessRaw) && hardnessRaw > EPSILON ? hardnessRaw : 1
    };
  };

  const sanitizePhase = (phase) => {
    if (!phase || typeof phase !== 'object' || !Array.isArray(phase.items)) return null;
    const mode = phase.mode === 'parallel' ? 'parallel' : 'sequential';
    const items = phase.items.map(sanitizeItem).filter(Boolean);
    if (!items.length) return null;
    return { mode, items };
  };

  if (!Array.isArray(raw)) {
    const single = sanitizeItem(raw);
    return single ? [{ mode: 'sequential', items: [single] }] : [];
  }

  const looksPhased = raw.length && raw.every((entry) => entry && typeof entry === 'object' && Array.isArray(entry.items));
  if (looksPhased) {
    return raw.map(sanitizePhase).filter(Boolean);
  }

  const items = raw.map(sanitizeItem).filter(Boolean);
  return items.length ? [{ mode: 'sequential', items }] : [];
}

/**
 * Clone a layer stack. Used so the resolver never mutates caller arrays.
 */
function cloneLayers(layers) {
  return layers.map((l) => ({ ...l }));
}

/**
 * Get cached normalized material for a layer, lazily resolving via context.
 */
function getMaterialFor(ctx, materialId, cache) {
  if (cache.has(materialId)) return cache.get(materialId);
  const raw = ctx.resolveMaterial?.(materialId);
  const md = normalizeMaterial(raw && typeof raw === 'object' ? raw : { materialId });
  cache.set(materialId, md);
  return md;
}

/* ================================================================== *
 *  Per-layer interaction                                              *
 * ================================================================== */

/**
 * Decide whether a damaged layer is effectively present for this hit and,
 * if so, what effective armour rating to use. Implements the five
 * degradation modes.
 *
 * @returns {{
 *   active: boolean,             // false → layer is bypassed entirely
 *   mode: string,                // active mode for trace
 *   eAR: number,                 // effective armour rating after degradation
 *   distributionBypassFraction: number, // for Distribution mode (0..1)
 *   distributionInsideFraction: number  // for Distribution mode (0..1)
 * }}
 */
function evaluateLayerForHit(layer, eARBase, mode, random) {
  const max = Math.max(EPSILON, layer.integrityMax);
  const s = Math.max(0, Math.min(1, layer.integrity / max));

  switch (mode) {
    case DEGRADATION_MODES.REDUCTION:
      return { active: true, mode, eAR: Math.max(0, eARBase * s), distributionBypassFraction: 0, distributionInsideFraction: 1 };

    case DEGRADATION_MODES.DISTRIBUTION:
      return { active: true, mode, eAR: Math.max(0, eARBase), distributionBypassFraction: 1 - s, distributionInsideFraction: s };

    case DEGRADATION_MODES.CHANCE: {
      const cap = Math.max(EPSILON, layer.breachCapacity);
      const breachRatio = Math.max(0, Math.min(1, layer.breachLoss / cap));
      const roll = random();
      const skip = roll < breachRatio;
      return { active: !skip, mode, eAR: Math.max(0, eARBase), distributionBypassFraction: 0, distributionInsideFraction: 1 };
    }

    case DEGRADATION_MODES.BYPASS:
      return { active: s >= 1 - EPSILON, mode, eAR: Math.max(0, eARBase), distributionBypassFraction: 0, distributionInsideFraction: 1 };

    case DEGRADATION_MODES.BASTION:
      return { active: s > EPSILON, mode, eAR: Math.max(0, eARBase), distributionBypassFraction: 0, distributionInsideFraction: 1 };

    default:
      return { active: true, mode, eAR: Math.max(0, eARBase), distributionBypassFraction: 0, distributionInsideFraction: 1 };
  }
}

/**
 * Apply `(type, amount)` to a layer at index `layerIdx` in the live stack
 * starting from `startIdx`. Recursively walks the rest of the stack.
 *
 * - Wear / breachLoss are mutated on the live `layers` array.
 * - Layers whose `integrity` has dropped to `0` (at or below `EPSILON`)
 *   are kept in the stack but treated as transparent: subsequent hits
 *   skip them entirely (`continue` at the top of the loop). Physically
 *   keeping them preserves their `{material, thickness, integrityMax,
 *   breachCapacity}` metadata so repair/restoration code can bring them
 *   back later (see `docs/code/reference` — armour is repairable, not
 *   destructible).
 * - Returns `{ deepestLayerReached, bodyHits: DamageInstance[] }`.
 *
 * `deepestLayerReached` is the index of the layer the application was last
 * present on (could be == layers.length, meaning it reached the body).
 *
 * @param {string} type
 * @param {number} amount
 * @param {LayerState[]} layers - mutable
 * @param {number} startIdx
 * @param {{ armorPen: number, armorDamageFactor: number, hardness: number }} mods
 * @param {ResolverContext} ctx
 * @param {Map<string, Object>} matCache
 * @param {Object[]} trace        - mutable: per-event log
 * @param {boolean} [isPrimary]   - true for primary application (controls
 *   whether the resulting position influences package position)
 * @returns {{ deepestLayerReached: number, bodyHits: DamageInstance[] }}
 */
function applyHitOnStack(type, amount, layers, startIdx, mods, ctx, matCache, trace, isPrimary = true) {
  const bodyHits = [];
  let cursor = startIdx;
  let currentType = type;
  let currentAmount = amount;
  let deepest = startIdx;

  while (cursor < layers.length) {
    const layer = layers[cursor];
    if (!layer || layer.integrity <= EPSILON) {
      cursor += 1;
      continue;
    }

    const material = getMaterialFor(ctx, layer.material, matCache);

    // ---- Step 1. Conductance (always, before structural check). --------
    // Split off `conductance[T]` fractions as fresh hits on the next layer
    // in whatever types the material conducts to. The remainder engages the
    // structure with the original type `T`.
    const conductance = material.conductance?.[currentType] ?? [];
    let conductedFraction = 0;
    const conductedItems = [];
    for (const entry of conductance) {
      const f = Math.max(0, Number(entry?.fraction ?? 0));
      if (f <= 0) continue;
      if (!isDamageType(entry?.type)) continue;
      const take = Math.min(f, Math.max(0, 1 - conductedFraction));
      if (take <= 0) break;
      const chunk = currentAmount * take;
      if (!_isPositive(chunk)) continue;
      conductedItems.push({ type: entry.type, amount: chunk });
      conductedFraction += take;
    }
    const xStruct = currentAmount * Math.max(0, 1 - conductedFraction);

    if (conductedItems.length) {
      trace.push({
        kind: 'conduct', layerIndex: cursor, material: layer.material,
        fromType: currentType, items: conductedItems.map((c) => ({ ...c })),
        remaining: xStruct
      });
      for (const inst of conductedItems) {
        const sub = applyHitOnStack(inst.type, inst.amount, layers, cursor + 1, mods, ctx, matCache, trace, false);
        bodyHits.push(...sub.bodyHits);
        deepest = Math.max(deepest, sub.deepestLayerReached);
      }
    }

    deepest = Math.max(deepest, cursor);

    // If conductance ate the entire hit, nothing to do structurally.
    if (!_isPositive(xStruct)) {
      return { deepestLayerReached: deepest, bodyHits };
    }

    // ---- Step 2. Structural evaluation on X_struct. --------------------
    const mode = material.degradation[currentType] ?? DEGRADATION_MODES.REDUCTION;
    const armour = effectiveArmorRating(layer, material, currentType);
    const evalRes = evaluateLayerForHit(layer, armour.eARBase, mode, ctx.random);

    if (!evalRes.active) {
      trace.push({ kind: 'bypass', layerIndex: cursor, material: layer.material, type: currentType, amount: xStruct, mode });
      currentAmount = xStruct;
      cursor += 1;
      continue;
    }

    // Distribution mode: the "outside" fraction of the structural portion
    // skips this layer as the same type; the "inside" fraction is processed
    // normally below.
    let structAmount = xStruct;
    if (mode === DEGRADATION_MODES.DISTRIBUTION && evalRes.distributionBypassFraction > EPSILON) {
      const outsideAmt = xStruct * evalRes.distributionBypassFraction;
      const insideAmt = xStruct * evalRes.distributionInsideFraction;
      if (_isPositive(outsideAmt)) {
        const tail = applyHitOnStack(currentType, outsideAmt, layers, cursor + 1, mods, ctx, matCache, trace, false);
        bodyHits.push(...tail.bodyHits);
        deepest = Math.max(deepest, tail.deepestLayerReached);
      }
      structAmount = insideAmt;
      if (!_isPositive(structAmount)) {
        // Entire structural portion slipped through via distribution; the
        // layer's integrity is not affected by the bypassed amount.
        return { deepestLayerReached: deepest, bodyHits };
      }
    }

    const eAR = evalRes.eAR;
    const Hp = _positiveProjectileHardness(mods.hardness);
    const armorPen = _nonNegativeArmorPen(mods.armorPen);
    const energyBefore = projectileEnergy(structAmount, mods);
    const energyResult = eAR <= EPSILON
      ? { energyAfter: energyBefore, residual: structAmount }
      : residualDamageAfterArmor(structAmount, energyBefore, eAR);
    const { energyAfter, residual } = energyResult;
    const energyAbsorbed = eAR <= EPSILON ? 0 : Math.min(energyBefore, eAR);

    const adf = Math.max(0, mods.armorDamageFactor || 1);
    const wearCoeffT = _wearCoefficient(material, currentType) * adf;
    const wearDeltaT = wearCoeffT * structAmount;
    layer.integrity = Math.max(0, layer.integrity - wearDeltaT);

    if (eAR <= EPSILON || energyBefore > eAR + EPSILON) {
      // Penetrated: residual continues with same type, breachLoss grows.
      layer.breachLoss = Math.min(layer.breachCapacity, layer.breachLoss + wearDeltaT);

      trace.push({
        kind: 'penetrate', layerIndex: cursor, material: layer.material, type: currentType,
        incoming: structAmount, ar: armour.ar, eARBase: armour.eARBase, eAR,
        energyBefore, energyAfter, energyAbsorbed, residual, wear: wearDeltaT,
        armorPen, hardnessProj: Hp, hardnessMat: armour.materialHardness,
        resistancePercent: armour.resistancePercent,
        breachAfter: layer.breachLoss, integrityAfter: layer.integrity, mode
      });

      currentAmount = residual;
      cursor += 1;
      continue;
    }

    // ---- Step 3. Held → record event, then apply selfInduction. --------
    trace.push({
      kind: 'hold', layerIndex: cursor, material: layer.material, type: currentType,
      incoming: structAmount, ar: armour.ar, eARBase: armour.eARBase, eAR,
      energyBefore, energyAfter, energyAbsorbed, wear: wearDeltaT,
      armorPen, hardnessProj: Hp, hardnessMat: armour.materialHardness,
      resistancePercent: armour.resistancePercent,
      integrityAfter: layer.integrity, mode
    });

    const overflow = _applySelfInduction({
      layer, material, fromType: currentType, xStruct: structAmount,
      armorDamageFactor: adf, cursor, trace
    });

    for (const inst of overflow) {
      const sub = applyHitOnStack(inst.type, inst.amount, layers, cursor + 1, mods, ctx, matCache, trace, false);
      bodyHits.push(...sub.bodyHits);
      deepest = Math.max(deepest, sub.deepestLayerReached);
    }

    // Held applications stop at this layer for the primary type.
    return { deepestLayerReached: cursor, bodyHits };
  }

  if (_isPositive(currentAmount)) {
    bodyHits.push({
      type: currentType,
      amount: currentAmount,
      armorPen: Math.max(0, mods.armorPen || 0),
      armorDamageFactor: Math.max(0, mods.armorDamageFactor || 1),
      hardness: _positiveProjectileHardness(mods.hardness)
    });
    trace.push({ kind: 'body', type: currentType, amount: currentAmount });
  }
  return { deepestLayerReached: layers.length, bodyHits };
}

/**
 * Apply the `selfInduction[T]` table of the given material against the
 * layer itself. Each entry `{U, f}` consumes `d_i = wear[U] · adf · X · f`
 * of the layer's remaining integrity; if the total demand exceeds the
 * remaining integrity, the layer is destroyed and the unabsorbed portion
 * overflows into fresh hits on the next layer.
 *
 * @param {Object} args
 * @param {Object} args.layer
 * @param {Object} args.material
 * @param {string} args.fromType
 * @param {number} args.xStruct   - structural amount that was held
 * @param {number} args.armorDamageFactor
 * @param {number} args.cursor    - current layer index (for trace)
 * @param {Object[]} args.trace   - mutable trace array
 * @returns {{type: string, amount: number}[]} overflow hits to spawn on
 *   the next layer
 */
function _applySelfInduction({ layer, material, fromType, xStruct, armorDamageFactor, cursor, trace }) {
  const entries = material.selfInduction?.[fromType] ?? [];
  if (!entries.length || !_isPositive(xStruct)) return [];

  const demands = [];
  let totalDemand = 0;
  for (const entry of entries) {
    const f = Math.max(0, Number(entry?.fraction ?? 0));
    if (f <= 0) continue;
    if (!isDamageType(entry?.type)) continue;
    const wearU = _wearCoefficient(material, entry.type);
    const d = Math.max(0, wearU * armorDamageFactor * xStruct * f);
    demands.push({ type: entry.type, fraction: f, demand: d, chunk: xStruct * f });
    totalDemand += d;
  }

  if (!demands.length) return [];

  const iRem = Math.max(0, layer.integrity);
  let absorbed = 0;
  let overflowFactor = 0;
  if (totalDemand <= iRem + EPSILON) {
    absorbed = totalDemand;
    overflowFactor = 0;
    layer.integrity = Math.max(0, iRem - totalDemand);
  } else {
    const p = totalDemand > EPSILON ? iRem / totalDemand : 0;
    absorbed = iRem;
    overflowFactor = 1 - p;
    layer.integrity = 0;
  }

  const overflowHits = [];
  const traceEntries = [];
  for (const d of demands) {
    const absorbedHere = d.demand * (totalDemand > EPSILON ? (absorbed / totalDemand) : 0);
    const overflowAmt = d.chunk * overflowFactor;
    traceEntries.push({
      type: d.type,
      requested: d.chunk,
      absorbed: absorbedHere,
      overflow: overflowAmt
    });
    if (_isPositive(overflowAmt)) {
      overflowHits.push({ type: d.type, amount: overflowAmt });
    }
  }

  trace.push({
    kind: 'self-induce', layerIndex: cursor, material: layer.material,
    fromType, entries: traceEntries, integrityAfter: layer.integrity
  });

  return overflowHits;
}

/* ================================================================== *
 *  Entry point                                                        *
 * ================================================================== */

/**
 * Resolve a damage package against an armour stack.
 *
 * @param {{
 *   layers: LayerState[],
 *   applications: unknown,
 *   resolveMaterial?: (id: string) => Object,
 *   random?: () => number
 * }} input
 *
 * @returns {{
 *   bodyDamage: DamageInstance[],
 *   bodyHits: Array<{ type: string, amount: number, armorPen: number, armorDamageFactor: number, hardness: number }>,
 *   layers: LayerState[],
 *   trace: Object[]
 * }} `bodyDamage` is a merged list of `(type, amount)` reaching the body —
 *    convenient for chat and injury rolls. `bodyHits` is the per-item
 *    breakdown that additionally carries each shard's `armorPen` and
 *    `armorDamageFactor`, so callers can feed the output back into another
 *    armour/body stack (e.g. through-and-through traversal). `layers` is
 *    the updated stack in the same order/length as the input — worn-out
 *    layers (`integrity` clamped to `0`) are kept so callers can repair
 *    them later instead of physically losing them.
 */
export function resolveDamagePackage(input) {
  const layers = cloneLayers(Array.isArray(input?.layers) ? input.layers : [])
    .map((l) => {
      // Make sure each layer has all fields populated.
      const md = input?.resolveMaterial?.(l.material);
      return ensureLayerDefaults(l, md ?? { materialId: l.material });
    });

  const phases = normalizeApplications(input?.applications);
  const ctx = {
    resolveMaterial: typeof input?.resolveMaterial === 'function'
      ? input.resolveMaterial
      : () => ({ materialId: '' }),
    random: typeof input?.random === 'function' ? input.random : Math.random
  };
  const matCache = new Map();
  const trace = [];
  const bodyDamage = [];
  let position = 0;

  for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx += 1) {
    const phase = phases[phaseIdx];
    let phaseDeepest = position;

    if (phase.mode === 'parallel') {
      // Each item starts from the same `position`. Layer state mutations
      // accumulate; worn-out layers (integrity 0) are kept in place and
      // treated as transparent by `applyHitOnStack`, so subsequent hits
      // simply skip them.
      for (const item of phase.items) {
        const startIdx = Math.min(position, layers.length);
        const mods = {
          armorPen: item.armorPen ?? 0,
          armorDamageFactor: item.armorDamageFactor ?? 1,
          hardness: _positiveProjectileHardness(item.hardness)
        };
        const result = applyHitOnStack(item.type, item.damage, layers, startIdx, mods, ctx, matCache, trace, true);
        bodyDamage.push(...result.bodyHits);
        phaseDeepest = Math.max(phaseDeepest, result.deepestLayerReached);
      }
    } else {
      // Sequential: items run one after another, each inheriting the
      // latest `position`. Worn-out layers (integrity 0) stay in the
      // stack and are skipped by `applyHitOnStack` so indexing remains
      // stable across the whole package.
      let cursor = position;
      for (const item of phase.items) {
        const startIdx = Math.min(cursor, layers.length);
        const mods = {
          armorPen: item.armorPen ?? 0,
          armorDamageFactor: item.armorDamageFactor ?? 1,
          hardness: _positiveProjectileHardness(item.hardness)
        };
        const result = applyHitOnStack(item.type, item.damage, layers, startIdx, mods, ctx, matCache, trace, true);
        bodyDamage.push(...result.bodyHits);
        cursor = result.deepestLayerReached;
      }
      phaseDeepest = cursor;
    }

    position = phaseDeepest;
  }

  return {
    bodyDamage: mergeDamageInstances(bodyDamage),
    bodyHits: bodyDamage.slice(),
    layers,
    trace
  };
}

/**
 * Combine body-damage instances with the same type into a single entry,
 * preserving the order of first occurrence.
 * @param {DamageInstance[]} hits
 * @returns {DamageInstance[]}
 */
export function mergeDamageInstances(hits) {
  const map = new Map();
  const order = [];
  for (const h of hits) {
    if (!h || !isDamageType(h.type)) continue;
    if (!Number.isFinite(h.amount) || h.amount <= EPSILON) continue;
    if (map.has(h.type)) {
      map.set(h.type, map.get(h.type) + h.amount);
    } else {
      map.set(h.type, h.amount);
      order.push(h.type);
    }
  }
  return order.map((t) => ({ type: t, amount: map.get(t) }));
}

/**
 * Produce a chat-friendly string from `bodyDamage`.
 * @param {DamageInstance[]} body
 * @returns {string}
 */
export function summarizeBodyDamage(body) {
  if (!Array.isArray(body) || !body.length) return '0';
  return body.map((d) => `${Math.round(d.amount * 100) / 100} ${d.type}`).join(', ');
}

// Re-export the constants module consumers commonly need together.
export { DAMAGE_TYPE_IDS };

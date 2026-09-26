/**
 * Body-traversal resolver — walks a projectile/application package through
 * one or more anatomy body parts, delegating per-part layer resolution to
 * {@link resolveDamagePackage}. Orchestrates:
 *
 *  1. **Entry** — incoming-face armour, then the part's catalog `material`.
 *  2. **Centre accumulation** — damage reaching the centre is recorded as
 *     `bodyDamageBySlot[slotRef]`.
 *  3. **Transfer vs. exit** — if the part has a `relations.behind` with
 *     matching `direction`, we roll against `chance` and either transfer
 *     to the next part as an internal entry, or exit through the opposite
 *     face (armour on that face, if the part actually has it).
 *
 * Tissue is a single catalog material on the part. Legacy `bodyLayers`
 * stacks are still honoured when tests pass them without a material slug.
 *
 * The resolver is pure — it does not import Foundry. See
 * [docs/code/reference/ANATOMY_SYSTEM.md].
 */

import {
  resolveDamagePackage,
  mergeDamageInstances,
  normalizeApplications
} from './damage-resolver.mjs';
import { ensureLayerDefaults } from './materials-manager.mjs';
import { sanitizeBodyLayers } from './body-layers-defaults.mjs';
import { isDamageType } from './damage-types.mjs';
import {
  resolveIncomingFace,
  resolveOppositeFace,
  sanitizePartMaterial,
} from '../anatomy-groups.mjs';

/**
 * Tissue stack for a part: catalog `material` as a single layer, or legacy
 * `bodyLayers` when tests still pass an explicit stack and no material slug.
 * @param {object} part
 * @returns {Array<{material:string, thickness:number}>}
 */
function partTissueLayers(part) {
  const mat = String(part?.material ?? '').trim();
  if (mat && mat !== 'biological' && mat !== 'bionic' && mat !== 'flesh' && mat !== 'cybernetic') {
    return [{ material: sanitizePartMaterial(mat), thickness: 1 }];
  }
  const sanitized = sanitizeBodyLayers(part?.bodyLayers);
  return Array.isArray(sanitized) ? sanitized : [];
}

function sourcesForFace(raw, face) {
  const list = Array.isArray(raw) ? raw : [];
  const wanted = String(face ?? '').trim();
  if (!wanted) return list;
  return list.filter((src) => {
    const f = String(src?.face ?? '').trim();
    if (!f) return true;
    return f === wanted;
  });
}

function cloneArmorSources(raw) {
  return (Array.isArray(raw) ? raw : []).map((src) => ({
    itemId: String(src?.itemId ?? ''),
    coverageIdx: Number(src?.coverageIdx ?? 0) || 0,
    face: String(src?.face ?? ''),
    layers: Array.isArray(src?.layers) ? src.layers.map((l) => ({ ...l })) : []
  }));
}

function applyArmorScale(sources, armorScale) {
  const s = Number(armorScale);
  const scale = Number.isFinite(s) && s > 0 ? s : 1;
  if (scale === 1) return sources;
  const thickMul = Math.sqrt(scale);
  return sources.map((src) => ({
    ...src,
    layers: src.layers.map((l) => {
      const t = Number(l.thickness);
      if (!Number.isFinite(t) || t <= 0) return { ...l };
      return { ...l, thickness: t * thickMul };
    })
  }));
}

const DIRECTIONS = Object.freeze(['front', 'back', 'left', 'right', 'top', 'bottom']);

const OPPOSITE_DIRECTION = Object.freeze({
  front: 'back',
  back: 'front',
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top'
});

function normalizeDirection(raw) {
  const v = String(raw ?? 'front').toLowerCase().trim();
  return DIRECTIONS.includes(v) ? v : 'front';
}

/* ================================================================== *
 *  Body-hits / applications conversion                                *
 * ================================================================== */

/**
 * Convert resolver `bodyHits` (`{type, amount, armorPen, armorDamageFactor, hardness}`)
 * into an `applications` package. Uses a single `parallel` phase so every
 * shard starts from the outer layer of the next stack independently.
 */
function bodyHitsToApplications(hits) {
  if (!Array.isArray(hits) || !hits.length) return [];
  const items = [];
  for (const h of hits) {
    if (!h || !isDamageType(h.type)) continue;
    const amount = Number(h.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const armorPen = Math.max(0, Number(h.armorPen ?? 0));
    const adfRaw = Number(h.armorDamageFactor ?? 1);
    const armorDamageFactor = Number.isFinite(adfRaw) && adfRaw > 0 ? adfRaw : 1;
    const hRaw = Number(h.hardness ?? 1);
    const hardness = Number.isFinite(hRaw) && hRaw > 1e-9 ? hRaw : 1;
    items.push({ type: h.type, damage: amount, armorPen, armorDamageFactor, hardness });
  }
  return items.length ? [{ mode: 'parallel', items }] : [];
}

/**
 * Convert an incoming `applications` value into the `bodyHits` shape used
 * at the part centre. Preserves `armorPen` / `armorDamageFactor` from
 * every item so subsequent stacks still see them.
 */
function applicationsToBodyHits(apps) {
  const phases = normalizeApplications(apps);
  const out = [];
  for (const phase of phases) {
    for (const item of phase.items) {
      const hRaw = Number(item.hardness ?? 1);
      const hardness = Number.isFinite(hRaw) && hRaw > 1e-9 ? hRaw : 1;
      out.push({
        type: item.type,
        amount: item.damage,
        armorPen: Math.max(0, Number(item.armorPen ?? 0)),
        armorDamageFactor: Math.max(0, Number(item.armorDamageFactor ?? 1)) || 1,
        hardness
      });
    }
  }
  return out;
}

/* ================================================================== *
 *  Flat stack construction / reconstitution                            *
 * ================================================================== */

/**
 * Build a flat layer stack (armour + body layers) annotated with keys
 * that identify each layer's provenance:
 *
 *   `armor:<itemId>:<coverageIdx>:<layerIdx>`
 *   `body:<slotRef>:<passId>:<layerIdx>`
 *
 * `passId` is either `'entry'` or `'exit'` so entry- and exit-side body
 * layers never collide inside the same resolver call.
 *
 * Order `'fwd'` concatenates armour first (outer → inner) then body
 * layers (outer → centre). Order `'rev'` reverses both: body layers
 * (centre → outer) then armour (inner → outer).
 *
 * @param {Object} args
 * @param {Array<{itemId:string, coverageIdx:number, layers:Array}>} args.sources
 * @param {Array<{material:string, thickness:number}>} args.bodyLayers
 * @param {'fwd'|'rev'} args.order
 * @param {string} args.slotRef
 * @param {'entry'|'exit'} args.passId
 * @param {(id:string)=>Object} args.resolveMaterial
 * @returns {Array<Object>} flat list of layer states
 */
function buildFlatStack({ sources, bodyLayers, order, slotRef, passId, resolveMaterial }) {
  const mat = typeof resolveMaterial === 'function' ? resolveMaterial : () => ({ materialId: '' });
  const flat = [];

  const pushArmor = (src) => {
    for (let i = 0; i < src.layers.length; i += 1) {
      const layer = src.layers[i];
      if (!layer || typeof layer !== 'object') continue;
      const md = mat(layer.material);
      flat.push(ensureLayerDefaults(
        { ...layer, key: `armor:${src.itemId}:${src.coverageIdx}:${i}` },
        md ?? { materialId: layer.material }
      ));
    }
  };
  const pushArmorRev = (src) => {
    for (let i = src.layers.length - 1; i >= 0; i -= 1) {
      const layer = src.layers[i];
      if (!layer || typeof layer !== 'object') continue;
      const md = mat(layer.material);
      flat.push(ensureLayerDefaults(
        { ...layer, key: `armor:${src.itemId}:${src.coverageIdx}:${i}` },
        md ?? { materialId: layer.material }
      ));
    }
  };
  const pushBody = (forward) => {
    const range = forward
      ? bodyLayers.map((_, i) => i)
      : bodyLayers.map((_, i) => bodyLayers.length - 1 - i);
    for (const i of range) {
      const layer = bodyLayers[i];
      if (!layer || typeof layer !== 'object') continue;
      const md = mat(layer.material);
      flat.push(ensureLayerDefaults(
        { ...layer, key: `body:${slotRef}:${passId}:${i}` },
        md ?? { materialId: layer.material }
      ));
    }
  };

  if (order === 'fwd') {
    for (const src of sources) pushArmor(src);
    pushBody(true);
  } else {
    pushBody(false);
    for (let s = sources.length - 1; s >= 0; s -= 1) pushArmorRev(sources[s]);
  }
  return flat;
}

/**
 * Reassemble armour sources from the resolver's survivors. Body-layer
 * entries are dropped (they are virtual). Missing buckets become empty
 * layer arrays so persistence code can still detect layer destruction.
 *
 * @param {Array<{itemId:string, coverageIdx:number, layers:Array}>} originalSources
 * @param {Array<Object>} resolvedLayers
 * @returns {Array<{itemId:string, coverageIdx:number, layers:Array}>}
 */
function reconstituteArmor(originalSources, resolvedLayers) {
  const bucket = new Map();
  for (const layer of resolvedLayers) {
    const key = String(layer?.key ?? '');
    if (!key.startsWith('armor:')) continue;
    const parts = key.split(':');
    if (parts.length < 4) continue;
    const itemId = parts[1];
    const coverageIdxStr = parts[2];
    const bucketKey = `${itemId}:${coverageIdxStr}`;
    if (!bucket.has(bucketKey)) bucket.set(bucketKey, []);
    bucket.get(bucketKey).push({
      material: layer.material,
      thickness: layer.thickness,
      integrity: layer.integrity,
      integrityMax: layer.integrityMax,
      breachLoss: layer.breachLoss,
      breachCapacity: layer.breachCapacity
    });
  }
  return originalSources.map((src) => ({
    itemId: src.itemId,
    coverageIdx: src.coverageIdx,
    face: src.face ?? '',
    layers: bucket.get(`${src.itemId}:${src.coverageIdx}`) ?? []
  }));
}

/* ================================================================== *
 *  Behind-relation weighted pick                                       *
 * ================================================================== */

/**
 * Given a set of `behind` relations whose `direction` matches the current
 * hit direction, return the target slotRef the projectile transfers to —
 * or `null` if it stops at the centre. Each relation carries a `chance`
 * percentage (0..100); probabilities are clipped and their sum capped at
 * 1.0. A single RNG draw decides whether the projectile transfers and, if
 * so, which specific relation it follows.
 *
 * @param {Array<{target:string, chance:number}>} behindRels
 * @param {() => number} rng
 * @returns {string|null}
 */
function pickBehindTransfer(behindRels, rng) {
  if (!behindRels.length) return null;
  const chances = behindRels.map((r) => Math.max(0, Math.min(1, Number(r?.chance ?? 0) / 100)));
  const total = Math.min(1, chances.reduce((a, b) => a + b, 0));
  if (total <= 0) return null;
  const roll = rng();
  if (roll >= total) return null;
  let accum = 0;
  for (let i = 0; i < behindRels.length; i += 1) {
    accum += chances[i];
    if (roll < accum) return String(behindRels[i].target ?? '');
  }
  return String(behindRels[behindRels.length - 1].target ?? '');
}

/* ================================================================== *
 *  Public entry point                                                  *
 * ================================================================== */

/**
 * @typedef {Object} TraversalPathEntry
 * @property {string} slotRef
 * @property {'external'|'internal'} entryKind
 * @property {string} incomingDirection
 * @property {{fwd:number, back:number}} exposure
 * @property {string|null} transferredTo
 * @property {boolean} exited - true when the projectile left via the back
 *   side (exposure[opposite(D)] > 0 with no behind transfer)
 */

/**
 * Resolve a projectile/application package against a chain of anatomy
 * body parts. Follows `relations.behind` transitions one step at a time
 * and stops when either the residual dissipates or every reachable part
 * has been visited.
 *
 * @param {Object} args
 * @param {{ bodyParts: Object<string, Object> }} args.anatomy - anatomy
 *   with normalized `bodyParts` (keyed by slotRef). Each part must carry
 *   `exposure`, `relations`, and — ideally — `bodyLayers`; missing body
 *   layers are filled from {@link getDefaultBodyLayersForType}.
 * @param {string} args.startSlotRef - slotRef of the initially hit part
 * @param {string} [args.hitDirection='front']
 * @param {unknown} args.applications - same shape as
 *   {@link resolveDamagePackage}'s `applications`
 * @param {Object<string, Array<{itemId:string, coverageIdx:number, layers:Array}>>} [args.armorBySlot={}]
 *   per-slot armour stacks (outer-most first)
 * @param {(id:string)=>Object} [args.resolveMaterial]
 * @param {()=>number} [args.random]
 *
 * @returns {{
 *   bodyDamageBySlot: Object<string, Array<{type:string, amount:number}>>,
 *   armorUpdatesBySlot: Object<string, Array<{itemId:string, coverageIdx:number, layers:Array}>>,
 *   path: TraversalPathEntry[],
 *   trace: Array<Object>
 * }}
 */
export function resolveBodyTraversal({
  anatomy,
  startSlotRef,
  hitDirection = 'front',
  applications,
  armorBySlot = {},
  armorScale = 1,
  resolveMaterial,
  random
} = {}) {
  const bodyParts = anatomy?.bodyParts && typeof anatomy.bodyParts === 'object' ? anatomy.bodyParts : {};
  const direction = normalizeDirection(hitDirection);
  const rng = typeof random === 'function' ? random : Math.random;
  const mat = typeof resolveMaterial === 'function' ? resolveMaterial : () => ({ materialId: '' });

  const bodyDamageBySlot = {};
  const armorUpdatesBySlot = {};
  const path = [];
  const trace = [];
  const processed = new Set();

  const queue = [{
    slotRef: String(startSlotRef ?? '').trim(),
    entryKind: 'external',
    applications,
    incomingDirection: direction
  }];

  while (queue.length) {
    const node = queue.shift();
    const slotRef = node.slotRef;
    if (!slotRef || processed.has(slotRef)) continue;
    processed.add(slotRef);

    const part = bodyParts[slotRef];
    if (!part) continue;

    const D = node.incomingDirection;
    const incomingFace = resolveIncomingFace(part, D);
    const oppositeFace = resolveOppositeFace(part, incomingFace);

    const rawArmorSrcs = cloneArmorSources(armorBySlot?.[slotRef]);
    let currentArmorSrcs = applyArmorScale(rawArmorSrcs, armorScale);
    const entryArmor = sourcesForFace(currentArmorSrcs, incomingFace);
    const tissue = partTissueLayers(part);

    // ---- 1. Entry: incoming-face armour → part material ----------------
    let centerHits;
    const wantsEntryStack = node.entryKind === 'external'
      && (entryArmor.length > 0 || tissue.length > 0);
    if (wantsEntryStack) {
      const flat = buildFlatStack({
        sources: entryArmor,
        bodyLayers: tissue,
        order: 'fwd',
        slotRef,
        passId: 'entry',
        resolveMaterial: mat
      });
      const res = resolveDamagePackage({
        layers: flat,
        applications: node.applications,
        resolveMaterial: mat,
        random: rng
      });
      centerHits = res.bodyHits.slice();
      currentArmorSrcs = reconstituteArmor(currentArmorSrcs, res.layers);
      for (const entry of res.trace) trace.push({ ...entry, slotRef, phase: 'entry' });
    } else {
      centerHits = applicationsToBodyHits(node.applications);
    }

    // ---- 2. Accumulate centre damage on this part ----------------------
    if (centerHits.length) {
      const existing = bodyDamageBySlot[slotRef] ?? [];
      bodyDamageBySlot[slotRef] = mergeDamageInstances([
        ...existing,
        ...centerHits.map((h) => ({ type: h.type, amount: h.amount }))
      ]);
    }

    // ---- 3. Decide transfer vs exit ------------------------------------
    const relations = Array.isArray(part.relations) ? part.relations : [];
    const behindRels = relations.filter(
      (r) => r && r.kind === 'behind' && normalizeDirection(r.direction) === D
    );
    let transferredTo = null;
    if (centerHits.length && behindRels.length) {
      const target = pickBehindTransfer(behindRels, rng);
      if (target && !processed.has(target) && bodyParts[target]) {
        queue.push({
          slotRef: target,
          entryKind: 'internal',
          applications: bodyHitsToApplications(centerHits),
          incomingDirection: D
        });
        transferredTo = target;
      }
    }

    // ---- 4. Exit via opposite-face armour (if not transferred) ---------
    let exited = false;
    const exitArmor = oppositeFace ? sourcesForFace(currentArmorSrcs, oppositeFace) : [];
    if (!transferredTo && centerHits.length && oppositeFace) {
      if (exitArmor.length > 0) {
        const flat = buildFlatStack({
          sources: exitArmor,
          bodyLayers: [],
          order: 'rev',
          slotRef,
          passId: 'exit',
          resolveMaterial: mat
        });
        const res = resolveDamagePackage({
          layers: flat,
          applications: bodyHitsToApplications(centerHits),
          resolveMaterial: mat,
          random: rng
        });
        currentArmorSrcs = reconstituteArmor(currentArmorSrcs, res.layers);
        for (const entry of res.trace) trace.push({ ...entry, slotRef, phase: 'exit' });
      }
      exited = true;
    }

    armorUpdatesBySlot[slotRef] = currentArmorSrcs;
    path.push({
      slotRef,
      entryKind: node.entryKind,
      incomingDirection: D,
      incomingFace,
      oppositeFace,
      transferredTo,
      exited
    });
  }

  return {
    bodyDamageBySlot,
    armorUpdatesBySlot,
    path,
    trace
  };
}

/* ================================================================== *
 *  Lower-level helpers exported for tests                              *
 * ================================================================== */

export const __internals__ = Object.freeze({
  normalizeDirection,
  OPPOSITE_DIRECTION,
  bodyHitsToApplications,
  applicationsToBodyHits,
  buildFlatStack,
  reconstituteArmor,
  pickBehindTransfer
});

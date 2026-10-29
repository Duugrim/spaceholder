/**
 * Body-traversal resolver — walks a projectile/application package through the hit body part (and on
 * through `relations.behind`, when a preset defines it), delegating armour to
 * {@link resolveDamagePackage}. Per part:
 *
 *  1. **Armour** on the incoming face (layers with `coverage` < 100 may be missed: the hit lands in a gap).
 *  2. **Tissue** (`partTissue`): the part takes what it *absorbs*. A penetrating projectile crosses the
 *     shell (the part's own `material`, e.g. the skull; a weaker one stays in it), then the inside
 *     absorbs `depthFlat + depthShare × energy`. The part's damage is the share of the projectile's damage
 *     that matches the absorbed energy (damage follows energy), plus `cavity` × the energy absorbed inside
 *     (the temporary cavity of a high-energy round); whatever is left leaves the body.
 *     Blows, burns and the shock armour hands on stay on the part entirely.
 *  3. **Exit**: the residual goes through armour on the opposite face and leaves the body
 *     (`exitApplications`, for a target behind) — or into the part behind (`relations.behind`).
 *  4. **Organs**: each organ is rolled separately; a bigger cavity (more energy absorbed) hits more of
 *     them. A penetrating projectile reaches organs only with energy past `organDepth`; a blow reaches them
 *     only above the concussion threshold. An organ takes `organShare` of the part's damage.
 *  5. **Blow to the parent**: `bluntToParent` of the blow goes on to the parent part (a helmet hit to the
 *     neck).
 *
 * The resolver is pure — it does not import Foundry. See [docs/code/reference/ANATOMY_SYSTEM.md].
 */

import {
  resolveDamagePackage,
  mergeDamageInstances,
  normalizeApplications,
  effectiveArmorRating,
  damageRatioForEnergyRatio,
  projectileEnergy,
} from './damage-resolver.mjs';
import { ensureLayerDefaults, normalizeMaterial } from './materials-manager.mjs';
import { isDamageType, penetratesBody } from './damage-types.mjs';
import {
  partTissue,
  resolveIncomingFace,
  resolveOppositeFace,
} from '../anatomy-groups.mjs';

const EPS = 1e-9;

/**
 * Body-wide constants of the wound model (the balance tool may override them):
 * - `organCavityEnergy` — energy scale of the organ roll: a part that absorbed this much energy hits each
 *   organ as if its share were doubled;
 * - `organShare` — share of the part's damage an organ in the wound takes;
 * - `concussionThreshold` — a blow (damage scale) must exceed this to hurt organs; the excess counts.
 */
export const DEFAULT_BODY_MODEL = Object.freeze({
  organCavityEnergy: 4,
  organShare: 0.5,
  concussionThreshold: 60,
});

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

/** Coverage of an armour layer, percent (a plate with gaps covers less than 100). */
function layerCoverage(layer) {
  const n = Number(layer?.coverage);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 100;
}

/* ================================================================== *
 *  Body-hits / applications conversion                                *
 * ================================================================== */

/**
 * Convert resolver `bodyHits` into an `applications` package: one `parallel` phase so every shard
 * starts from the outer layer of the next stack independently. The carried energy and the
 * armour-damage-reduction stay with the shard.
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
    const hardness = Number.isFinite(hRaw) && hRaw > EPS ? hRaw : 1;
    const item = { type: h.type, damage: amount, armorPen, armorDamageFactor, hardness };
    if (Number.isInteger(h.tag)) item.tag = h.tag;
    if (Number.isFinite(h.energy) && h.energy >= 0) item.energy = h.energy;
    if (Number.isFinite(h.armorDamageReduction)) item.armorDamageReduction = h.armorDamageReduction;
    if (h.transferred) item.transferred = true;
    items.push(item);
  }
  return items.length ? [{ mode: 'parallel', items }] : [];
}

/** Incoming `applications` in the `bodyHits` shape (an internal entry has no armour stack). */
function applicationsToBodyHits(apps) {
  const out = [];
  for (const phase of normalizeApplications(apps)) {
    for (const item of phase.items) {
      out.push({
        type: item.type,
        amount: item.damage,
        armorPen: item.armorPen,
        armorDamageFactor: item.armorDamageFactor,
        hardness: item.hardness,
        ...(Number.isInteger(item.tag) ? { tag: item.tag } : {}),
        ...(Number.isFinite(item.energy) ? { energy: item.energy } : {}),
        ...(Number.isFinite(item.armorDamageReduction) ? { armorDamageReduction: item.armorDamageReduction } : {}),
        ...(item.transferred ? { transferred: true } : {})
      });
    }
  }
  return out;
}

/* ================================================================== *
 *  Armour stack construction / reconstitution                          *
 * ================================================================== */

/**
 * Flat armour stack of the given sources, keyed `armor:<itemId>:<coverageIdx>:<layerIdx>`. A layer with
 * `coverage` < 100 is missed when the roll falls into its gap (the hit lands where the plate is not).
 * `'fwd'` = outer → inner (entry), `'rev'` = inner → outer (exit).
 * @returns {{ flat: object[], gaps: string[] }}
 */
function buildArmorStack({ sources, order, resolveMaterial, chance }) {
  const mat = typeof resolveMaterial === 'function' ? resolveMaterial : () => ({ materialId: '' });
  const flat = [];
  const gaps = [];
  const gapLayers = [];
  const list = order === 'rev' ? [...sources].reverse() : sources;
  for (const src of list) {
    const idx = src.layers.map((_, i) => i);
    if (order === 'rev') idx.reverse();
    for (const i of idx) {
      const layer = src.layers[i];
      if (!layer || typeof layer !== 'object') continue;
      const key = `armor:${src.itemId}:${src.coverageIdx}:${i}`;
      const coverage = layerCoverage(layer);
      if (coverage < 100 && chance({ kind: 'gap', id: key, chance: 1 - coverage / 100 })) {
        gaps.push(key);
        // `before`: the number of layers in front of the gap, to put it in its place in the trace.
        gapLayers.push({ layerKey: key, material: layer.material, thickness: Math.max(0, Number(layer.thickness) || 0), coverage, before: flat.length });
        continue;
      }
      const md = mat(layer.material);
      flat.push(ensureLayerDefaults({ ...layer, key }, md ?? { materialId: layer.material }));
    }
  }
  return { flat, gaps, gapLayers };
}

/** Trace events for the armour layers an incoming/outgoing pass missed through a coverage gap. */
function gapTrace(stack, slotRef, phase) {
  return stack.gapLayers.map((gap) => ({ kind: 'gap', slotRef, phase, ...gap }));
}

/**
 * Write the resolver's layer states back into the armour sources. Layers the pass did not touch (another
 * face, a gap in the coverage) keep their state.
 */
function reconstituteArmor(originalSources, resolvedLayers) {
  const byKey = new Map();
  for (const layer of resolvedLayers ?? []) {
    const key = String(layer?.key ?? '');
    if (key.startsWith('armor:')) byKey.set(key, layer);
  }
  return originalSources.map((src) => ({
    itemId: src.itemId,
    coverageIdx: src.coverageIdx,
    face: src.face ?? '',
    layers: src.layers.map((layer, i) => {
      const res = byKey.get(`armor:${src.itemId}:${src.coverageIdx}:${i}`);
      if (!res) return { ...layer };
      return {
        ...layer,
        material: res.material,
        thickness: res.thickness,
        integrity: res.integrity,
        integrityMax: res.integrityMax,
        breachLoss: res.breachLoss,
        breachCapacity: res.breachCapacity
      };
    })
  }));
}

/** Energy the armour layers absorbed from the projectile itself (penetrated or held). */
function absorbedByArmor(trace) {
  let sum = 0;
  for (const t of trace ?? []) {
    if ((t.kind === 'penetrate' || t.kind === 'hold') && Number.isFinite(t.energyAbsorbed)) sum += t.energyAbsorbed;
  }
  return sum;
}

/* ================================================================== *
 *  Behind-relation weighted pick                                       *
 * ================================================================== */

/**
 * Given the `behind` relations matching the hit direction, return the slot the projectile goes on into —
 * or `null`. Each relation carries a `chance` percentage; one roll decides.
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
 *  Tissue                                                              *
 * ================================================================== */

/**
 * A penetrating projectile through the part's tissue.
 * @param {object} hit body hit (`amount`, `energy`, `armorPen`, `hardness`, `armorDamageReduction`)
 * @param {{ shellR: number, tissue: object }} ctx `shellR` — energy the shell holds (0 for an internal entry)
 * @returns {{ deposit: number, absorbed: number, reached: boolean, inShell: boolean, exit: object|null,
 *   energyBefore: number, energyAfter: number }}
 */
function passTissue(hit, { shellR, tissue }) {
  const D = Math.max(0, Number(hit.amount) || 0);
  const E = Number.isFinite(hit.energy) ? Math.max(0, hit.energy) : projectileEnergy(D, hit);
  const adr = hit.armorDamageReduction;
  const stays = (inShell) => ({ deposit: D, absorbed: E, reached: false, inShell, exit: null, energyBefore: E, energyAfter: 0 });
  if (E <= EPS) return stays(false);
  if (shellR > EPS && E <= shellR + EPS) return stays(true);
  const E1 = shellR > EPS ? E - shellR : E;
  const D1 = shellR > EPS ? D * damageRatioForEnergyRatio(E1 / E, adr) : D;
  const reached = E1 > tissue.organDepth + EPS;
  const take = Math.min(E1, tissue.depthFlat + tissue.depthShare * E1);
  const E2 = Math.max(0, E1 - take);
  const D2 = E2 > EPS ? D1 * damageRatioForEnergyRatio(E2 / E1, adr) : 0;
  // The temporary cavity: energy absorbed inside tears more than the projectile's share of damage.
  const cavity = Math.max(0, Number(tissue.cavity) || 0) * (E1 - E2);
  return {
    deposit: D - D2 + cavity,
    absorbed: E - E2,
    reached,
    inShell: false,
    exit: D2 > EPS ? { ...hit, amount: D2, energy: E2 } : null,
    energyBefore: E,
    energyAfter: E2,
  };
}

/**
 * Organs a wound hits: each organ separately, its share boosted by the cavity
 * (`1 − (1 − share)^(1 + energy / organCavityEnergy)`).
 * @returns {Array<object>} the organs hit
 */
function rollOrgans(inners, cavityEnergy, model, chance) {
  const out = [];
  const scale = Math.max(EPS, Number(model.organCavityEnergy) || DEFAULT_BODY_MODEL.organCavityEnergy);
  const power = 1 + Math.max(0, cavityEnergy) / scale;
  for (const inner of Array.isArray(inners) ? inners : []) {
    const share = Math.max(0, Math.min(1, (Number(inner?.occupancyPct) || 0) / 100));
    if (share <= 0) continue;
    if (chance({ kind: 'organ', id: String(inner?.id ?? ''), chance: 1 - Math.pow(1 - share, power) })) out.push(inner);
  }
  return out;
}

/* ================================================================== *
 *  Public entry point                                                  *
 * ================================================================== */

/**
 * @typedef {Object} TraversalPathEntry
 * @property {string} slotRef
 * @property {'external'|'internal'} entryKind
 * @property {string} incomingDirection
 * @property {string|null} transferredTo
 * @property {boolean} exited - the projectile left the body through this part
 */

/**
 * @typedef {Object} PartWound what one part took from the package
 * @property {number} deposit damage of penetrating projectiles the part absorbed
 * @property {number} blunt blows: the shock armour handed on and concussive damage
 * @property {number} surface other damage that stays on the part (burns, chemicals…)
 * @property {number} cavityEnergy energy the part (and the armour right in front of it) absorbed
 * @property {boolean} reachedOrgans a penetrating projectile got past `organDepth`
 * @property {boolean} inShell a penetrating projectile stopped in the shell
 * @property {boolean} exited the projectile left the body here
 * @property {string[]} gaps armour layers missed through a coverage gap
 */

/**
 * Resolve a projectile/application package against the hit body part (and the parts behind it).
 *
 * @param {Object} args
 * @param {{ bodyParts: Object<string, Object> }} args.anatomy - normalized `bodyParts` keyed by slotRef;
 *   parts carry `material`, `tissue`, `inners`, `faces`, `relations`
 * @param {string} args.startSlotRef - slotRef of the hit part
 * @param {string} [args.hitDirection='front']
 * @param {unknown} args.applications - same shape as {@link resolveDamagePackage}'s `applications`
 * @param {Object<string, Array<{itemId:string, coverageIdx:number, face?:string, layers:Array}>>} [args.armorBySlot={}]
 *   per-slot armour sources (outer-most first)
 * @param {(id:string)=>Object} [args.resolveMaterial]
 * @param {()=>number} [args.random]
 * @param {Partial<typeof DEFAULT_BODY_MODEL>} [args.bodyModel]
 * @param {(event: {kind: 'gap'|'organ', id: string, chance: number}) => boolean} [args.decide] where the hit lands:
 *   called for every location roll (an armour gap, an organ) with the chance of the event; returns whether it
 *   happens. Without it the rolls use `random`. The balance tool walks every branch with it.
 *
 * @returns {{
 *   bodyDamageBySlot: Object<string, Array<{type:string, amount:number}>>,
 *   innerHitsBySlot: Object<string, Array<{innerId:string, amount:number, type:string}>>,
 *   woundsBySlot: Object<string, PartWound>,
 *   armorUpdatesBySlot: Object<string, Array<{itemId:string, coverageIdx:number, layers:Array}>>,
 *   exitApplications: Array<{mode:string, items:object[]}>,
 *   path: TraversalPathEntry[],
 *   trace: Array<Object>
 * }} `exitApplications` — what left the body (empty when everything stayed in it)
 */
export function resolveBodyTraversal({
  anatomy,
  startSlotRef,
  hitDirection = 'front',
  applications,
  armorBySlot = {},
  resolveMaterial,
  random,
  bodyModel,
  decide
} = {}) {
  const bodyParts = anatomy?.bodyParts && typeof anatomy.bodyParts === 'object' ? anatomy.bodyParts : {};
  const direction = normalizeDirection(hitDirection);
  const rng = typeof random === 'function' ? random : Math.random;
  const mat = typeof resolveMaterial === 'function' ? resolveMaterial : () => ({ materialId: '' });
  const model = { ...DEFAULT_BODY_MODEL, ...(bodyModel ?? {}) };
  /** A location roll: does an event with this chance happen. */
  const chance = typeof decide === 'function'
    ? (event) => decide(event) === true
    : (event) => rng() < event.chance;

  const damageBySlot = {};
  const innerHitsBySlot = {};
  const woundsBySlot = {};
  const armorUpdatesBySlot = {};
  const exitHits = [];
  const path = [];
  const trace = [];
  const processed = new Set();

  const addDamage = (slotRef, hits) => {
    const list = hits.filter((h) => h && h.amount > EPS);
    if (!list.length) return;
    damageBySlot[slotRef] = mergeDamageInstances([...(damageBySlot[slotRef] ?? []), ...list]);
  };

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
    const tissue = partTissue(part);
    const external = node.entryKind === 'external';

    let currentArmorSrcs = cloneArmorSources(armorBySlot?.[slotRef]);
    const gaps = [];

    // ---- 1. Armour on the incoming face --------------------------------
    let hits;
    let armorAbsorbed = 0;
    if (external) {
      const stack = buildArmorStack({ sources: sourcesForFace(currentArmorSrcs, incomingFace), order: 'fwd', resolveMaterial: mat, chance });
      gaps.push(...stack.gaps);
      trace.push(...gapTrace(stack, slotRef, 'entry'));
      if (stack.flat.length) {
        const res = resolveDamagePackage({ layers: stack.flat, applications: node.applications, resolveMaterial: mat, random: rng });
        hits = res.bodyHits.slice();
        armorAbsorbed = absorbedByArmor(res.trace);
        currentArmorSrcs = reconstituteArmor(currentArmorSrcs, res.layers);
        for (const entry of res.trace) trace.push({ ...entry, slotRef, phase: 'entry' });
      } else {
        hits = applicationsToBodyHits(node.applications);
      }
    } else {
      hits = applicationsToBodyHits(node.applications);
    }

    // ---- 2. Tissue -------------------------------------------------------
    const shellMaterial = normalizeMaterial(mat(tissue.material) ?? { materialId: tissue.material });
    const deposits = [];
    const exits = [];
    let deposit = 0;
    let reachingDeposit = 0;
    let blunt = 0;
    let surface = 0;
    let bodyAbsorbed = 0;
    let reachedOrgans = false;
    let inShell = false;
    let dominant = null;
    for (const hit of hits) {
      const amount = Math.max(0, Number(hit.amount) || 0);
      if (amount <= EPS) continue;
      if (hit.transferred || !penetratesBody(hit.type)) {
        if (hit.type === 'concussive') blunt += amount;
        else surface += amount;
        if (!hit.transferred) bodyAbsorbed += Number.isFinite(hit.energy) ? hit.energy : projectileEnergy(amount, hit);
        deposits.push({ type: hit.type, amount });
        continue;
      }
      const shellR = external
        ? effectiveArmorRating({ thickness: tissue.shellThickness }, shellMaterial, hit.type).eARBase
        : 0;
      const pass = passTissue(hit, { shellR, tissue });
      deposit += pass.deposit;
      bodyAbsorbed += pass.absorbed;
      if (pass.reached) {
        reachedOrgans = true;
        reachingDeposit += pass.deposit;
      }
      inShell ||= pass.inShell;
      deposits.push({ type: hit.type, amount: pass.deposit });
      if (!dominant || pass.deposit > dominant.amount) dominant = { type: hit.type, amount: pass.deposit };
      if (pass.exit) exits.push(pass.exit);
      trace.push({
        kind: 'tissue', slotRef, phase: 'tissue', type: hit.type, shell: shellR,
        material: tissue.material, shellThickness: tissue.shellThickness, damage: amount,
        ...(Number.isInteger(hit.tag) ? { tag: hit.tag } : {}),
        energyBefore: pass.energyBefore, energyAfter: pass.energyAfter, deposit: pass.deposit,
        reached: pass.reached, inShell: pass.inShell, exit: pass.exit?.amount ?? 0
      });
    }

    // ---- 3. Exit: the part behind, or out through the opposite face -----
    let transferredTo = null;
    let exited = false;
    if (exits.length) {
      const behindRels = (Array.isArray(part.relations) ? part.relations : []).filter(
        (r) => r && r.kind === 'behind' && normalizeDirection(r.direction) === D
      );
      const target = behindRels.length ? pickBehindTransfer(behindRels, rng) : null;
      if (target && !processed.has(target) && bodyParts[target] && !bodyParts[target].lost) {
        queue.push({ slotRef: target, entryKind: 'internal', applications: bodyHitsToApplications(exits), incomingDirection: D });
        transferredTo = target;
      } else {
        let leaving = exits;
        if (oppositeFace) {
          const stack = buildArmorStack({ sources: sourcesForFace(currentArmorSrcs, oppositeFace), order: 'rev', resolveMaterial: mat, chance });
          gaps.push(...stack.gaps);
          trace.push(...gapTrace(stack, slotRef, 'exit'));
          if (stack.flat.length) {
            const res = resolveDamagePackage({ layers: stack.flat, applications: bodyHitsToApplications(exits), resolveMaterial: mat, random: rng });
            currentArmorSrcs = reconstituteArmor(currentArmorSrcs, res.layers);
            for (const entry of res.trace) trace.push({ ...entry, slotRef, phase: 'exit' });
            leaving = res.bodyHits.filter((h) => !h.transferred);
            // A plate on the far side that slows the projectile pushes back into the same part.
            for (const h of res.bodyHits.filter((x) => x.transferred)) {
              if (h.type === 'concussive') blunt += h.amount;
              else surface += h.amount;
              deposits.push({ type: h.type, amount: h.amount });
            }
          }
        }
        if (leaving.length) {
          exitHits.push(...leaving);
          exited = true;
        }
      }
    }

    addDamage(slotRef, deposits);

    // ---- 4. Organs -------------------------------------------------------
    const concussion = Math.max(0, blunt - Math.max(0, Number(model.concussionThreshold) || 0));
    if ((reachedOrgans && reachingDeposit > EPS) || concussion > EPS) {
      const cavityEnergy = bodyAbsorbed + armorAbsorbed;
      const share = Math.max(0, Number(model.organShare) || 0);
      const amount = share * ((reachedOrgans ? reachingDeposit : 0) + concussion);
      const type = reachedOrgans && reachingDeposit >= concussion && dominant ? dominant.type : 'concussive';
      if (amount > EPS) {
        const organs = rollOrgans(part.inners, cavityEnergy, model, chance);
        if (organs.length) innerHitsBySlot[slotRef] = organs.map((o) => ({ innerId: String(o.id ?? ''), amount, type }));
      }
    }

    // ---- 5. Blow to the parent ------------------------------------------
    if (blunt > EPS && tissue.bluntToParent > 0) {
      const parentRef = (Array.isArray(part.relations) ? part.relations : []).find((r) => r?.kind === 'parent')?.target;
      const parent = parentRef ? bodyParts[parentRef] : null;
      if (parent && !parent.lost) addDamage(parentRef, [{ type: 'concussive', amount: blunt * tissue.bluntToParent }]);
    }

    woundsBySlot[slotRef] = {
      deposit,
      blunt,
      surface,
      cavityEnergy: bodyAbsorbed + armorAbsorbed,
      reachedOrgans,
      inShell,
      exited,
      gaps,
    };
    armorUpdatesBySlot[slotRef] = currentArmorSrcs;
    path.push({ slotRef, entryKind: node.entryKind, incomingDirection: D, incomingFace, oppositeFace, transferredTo, exited });
  }

  return {
    bodyDamageBySlot: damageBySlot,
    innerHitsBySlot,
    woundsBySlot,
    armorUpdatesBySlot,
    exitApplications: bodyHitsToApplications(exitHits),
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
  buildArmorStack,
  reconstituteArmor,
  pickBehindTransfer,
  passTissue,
  rollOrgans
});

/**
 * Wall penetration — runs a projectile through the wall spans of one shot segment with the same
 * v3 energy rules as armour (`resolveDamagePackage`).
 *
 * `planWallPasses` pre-resolves every wall of a segment: spans are built from the crossings
 * (`wall-spans.mjs`), then passed one by one in flight order. The projectile that leaves a span
 * (`applications` with the energy it has left) enters the next one, and finally reaches the
 * tokens behind the walls (`carryAt`). The first span that stops the projectile — or an
 * unconfigured wall, which keeps the legacy "walls stop everything" behaviour — ends the plan.
 *
 * Pure (no Foundry globals); materials are injected through `resolveMaterial`.
 */

import { normalizeApplications, resolveDamagePackage } from '../damage/damage-resolver.mjs';
import { applyEnergyScaleToApplications } from '../weapon/damage-profile.mjs';
import { MIN_SIN_THETA, buildWallSpans, findSpanAt } from './wall-spans.mjs';

const EPS = 1e-6;

/**
 * A material counts as a wall material when it has structure; the empty fallback
 * (`integrityPerThickness: 0`) is transparent to the resolver, so such a wall must stay a blocker.
 * @param {Object|null|undefined} material
 * @returns {boolean}
 */
export function isUsableWallMaterial(material) {
  return !!material && Number(material.integrityPerThickness) > 0;
}

/** Total damage of a phased applications package (diagnostics / chat). */
export function totalApplicationsDamage(applications) {
  let sum = 0;
  for (const phase of normalizeApplications(applications)) {
    for (const item of phase.items) sum += item.damage;
  }
  return sum;
}

function toCarryItem(hit) {
  const item = {
    type: hit.type,
    damage: hit.amount,
    armorPen: hit.armorPen,
    armorDamageFactor: hit.armorDamageFactor,
    hardness: hit.hardness,
    energy: hit.energy,
  };
  if (Number.isFinite(hit.armorDamageReduction)) item.armorDamageReduction = hit.armorDamageReduction;
  return item;
}

/**
 * Pass a projectile through one span of wall material.
 *
 * Every application item is resolved on its own against the span (one layer, `thickness` taken
 * from the span's real path length), and only the shards of the item's own damage type leave the
 * wall — conduction and self-induction shards belong to the wall, not to the flight.
 *
 * @param {Object} args
 * @param {{material: string, thickness: number}} args.span
 * @param {unknown} args.applications phased applications package
 * @param {(id: string) => Object} args.resolveMaterial
 * @param {() => number} [args.random]
 * @returns {{ penetrated: boolean, applications: Array<{mode: string, items: object[]}>, layers: object[], trace: object[] }}
 */
export function passSpan({ span, applications, resolveMaterial, random }) {
  let layers = [{ material: span.material, thickness: span.thickness }];
  const carried = [];
  const trace = [];
  for (const phase of normalizeApplications(applications)) {
    for (const item of phase.items) {
      const res = resolveDamagePackage({
        layers,
        applications: [{ mode: 'sequential', items: [item] }],
        resolveMaterial,
        random,
      });
      layers = res.layers;
      trace.push(...res.trace);
      for (const hit of res.bodyHits) {
        if (hit.transferred || hit.type !== item.type || !(hit.amount > EPS)) continue;
        carried.push(toCarryItem(hit));
      }
    }
  }
  return {
    penetrated: carried.length > 0,
    applications: carried.length ? [{ mode: 'parallel', items: carried }] : [],
    layers,
    trace,
  };
}

/**
 * @typedef {Object} WallPassEvent
 * @property {string} material
 * @property {string} kind span kind (`thin` / `solid`)
 * @property {number} thickness material thickness units the projectile had to cross
 * @property {number} entryDistance distance of the wall face from the segment start
 * @property {{x:number,y:number}} entryPoint
 * @property {{x:number,y:number}|null} exitPoint null when the projectile did not get through
 * @property {boolean} penetrated
 * @property {string} [reason] `stopped` | `unbounded` | `opaque` when not penetrated
 * @property {number} damageBefore total damage entering the wall
 * @property {number} damageAfter total damage leaving it
 * @property {object[]} [trace] the resolver's trace of the pass (`penetrate` / `hold` events with the energy
 *   before and after) — what the penetration view shows (`damage/penetration-track.mjs`)
 */

/**
 * Resolve all walls of one straight segment.
 *
 * @param {Object} args
 * @param {Array<Object>} args.crossings wall crossings, each `{ collision, t, a, b, dir, kind, material, thickness }`
 *   (see `WallCrossing` in wall-spans.mjs); `collision` is the original collision record
 * @param {{x:number,y:number}} args.rayStart
 * @param {{x:number,y:number}} args.rayEnd
 * @param {unknown} args.applications the projectile entering the segment
 * @param {(id: string) => Object} args.resolveMaterial
 * @param {number} args.pxPerThickness ray units per material thickness unit
 * @param {() => number} [args.random]
 * @param {number} [args.minSin]
 * @param {(point: {x:number,y:number}) => number} [args.energyAt] distance falloff: share of its muzzle energy
 *   the projectile still has at a point. With it every wall meets the projectile weakened by the distance it
 *   flew, and `carryAt` includes the falloff up to the asked distance.
 * @param {number} [args.energyLevel=1] the falloff the incoming `applications` already carry (1 = straight from
 *   the muzzle; a carry from an earlier segment has the level its plan's `levelAt` gave)
 * @returns {{
 *   passes: Array<{ span: object, applicationsAfter: object[], trace: object[] }>,
 *   block: null | { kind: string, collision: object, span?: object },
 *   events: WallPassEvent[],
 *   applications: object[]|null,
 *   stepFor: (collision: object) => ({ blocks: boolean, blockCollision?: object }|null),
 *   carryAt: (distance: number) => (object[]|null)
 * }}
 */
export function planWallPasses({
  crossings,
  rayStart,
  rayEnd,
  applications,
  resolveMaterial,
  pxPerThickness,
  random,
  minSin = MIN_SIN_THETA,
  energyAt = null,
  energyLevel = 1,
} = {}) {
  const sorted = (Array.isArray(crossings) ? crossings : [])
    .filter((c) => c && Number.isFinite(c.t))
    .sort((p, q) => p.t - q.t);
  const material = (slug) => (slug ? resolveMaterial?.(slug) : null);
  const usable = [];
  const opaque = [];
  for (const crossing of sorted) {
    (isUsableWallMaterial(material(crossing.material)) ? usable : opaque).push(crossing);
  }
  const firstOpaque = opaque[0] ?? null;

  const spans = buildWallSpans(usable, {
    rayStart,
    rayEnd,
    pxPerThickness,
    minSin,
    materialRank: (slug) => Number(material(slug)?.hardness) || 0,
  });

  const rayLen = Math.hypot(rayEnd.x - rayStart.x, rayEnd.y - rayStart.y) || 1;
  const pointAt = (t) => ({
    x: rayStart.x + ((rayEnd.x - rayStart.x) / rayLen) * t,
    y: rayStart.y + ((rayEnd.y - rayStart.y) / rayLen) * t,
  });

  const kAt = (t) => (typeof energyAt === 'function'
    ? Math.max(0, Number(energyAt(pointAt(Math.max(0, Math.min(t, rayLen))))) || 0)
    : 1);
  /** Bring a package from falloff level `fromK` to the level at `toT`. */
  const flyTo = (apps, fromK, toT) => (fromK > EPS ? applyEnergyScaleToApplications(apps, kAt(toT) / fromK) : apps);

  const passes = [];
  const events = [];
  let block = null;
  let current = normalizeApplications(applications);
  let currentK = Number.isFinite(Number(energyLevel)) && Number(energyLevel) > 0 ? Number(energyLevel) : 1;

  for (const span of spans) {
    if (firstOpaque && firstOpaque.t <= span.entry + EPS) break; // an unconfigured wall comes first
    current = flyTo(current, currentK, span.entry);
    currentK = kAt(span.entry);
    const damageBefore = totalApplicationsDamage(current);
    const event = {
      material: span.material,
      kind: span.kind,
      thickness: span.thickness,
      entryDistance: span.entry,
      entryPoint: pointAt(span.entry),
      exitPoint: null,
      penetrated: false,
      damageBefore,
      damageAfter: 0,
    };
    if (span.unbounded) {
      events.push({ ...event, reason: 'unbounded' });
      block = { kind: 'unbounded', span, collision: stopCollision(span, pointAt) };
      break;
    }
    const res = passSpan({ span, applications: current, resolveMaterial, random });
    if (!res.penetrated) {
      events.push({ ...event, reason: 'stopped', trace: res.trace });
      block = { kind: 'stopped', span, collision: stopCollision(span, pointAt) };
      break;
    }
    current = res.applications;
    passes.push({ span, applicationsAfter: res.applications, trace: res.trace, level: currentK });
    events.push({
      ...event,
      exitPoint: pointAt(Math.min(span.end, rayLen)),
      penetrated: true,
      damageAfter: totalApplicationsDamage(res.applications),
      trace: res.trace,
    });
  }

  if (!block && firstOpaque) {
    block = { kind: 'opaque', collision: firstOpaque.collision };
    events.push({
      material: firstOpaque.material || '',
      kind: firstOpaque.kind || 'thin',
      thickness: 0,
      entryDistance: firstOpaque.t,
      entryPoint: firstOpaque.collision?.point ?? pointAt(firstOpaque.t),
      exitPoint: null,
      penetrated: false,
      reason: 'opaque',
      damageBefore: totalApplicationsDamage(current),
      damageAfter: 0,
    });
  }

  const byCollision = new Map();
  for (const crossing of sorted) {
    if (crossing.collision) byCollision.set(crossing.collision, crossing);
  }
  const passedSpans = new Set(passes.map((p) => p.span));

  return {
    passes,
    block,
    events,
    applications: passes.length ? passes[passes.length - 1].applicationsAfter : null,

    stepFor(collision) {
      const crossing = byCollision.get(collision);
      if (!crossing) return null;
      if (block?.kind === 'opaque' && crossing.collision === block.collision) {
        return { blocks: true, blockCollision: crossing.collision };
      }
      const span = findSpanAt(spans, crossing.t);
      if (!span) return { blocks: true, blockCollision: crossing.collision }; // unconfigured wall
      if (passedSpans.has(span)) return { blocks: false };
      return { blocks: true, blockCollision: block?.span === span ? block.collision : crossing.collision };
    },

    carryAt(distance) {
      let last = null;
      for (const pass of passes) {
        if (pass.span.entry <= distance + EPS) last = pass;
      }
      if (!last) return null;
      return flyTo(last.applicationsAfter, last.level, distance);
    },

    /** Falloff level of a carry taken at `distance` (feed it back as `energyLevel` for the next segment). */
    levelAt(distance) {
      return kAt(distance);
    },
  };
}

/** The collision record that ends a shot at the face of a span that stopped it. */
function stopCollision(span, pointAt) {
  const first = span.crossings.slice().sort((p, q) => p.t - q.t)[0];
  const base = first?.collision ?? { type: 'wall', details: {} };
  return {
    ...base,
    point: pointAt(span.entry),
    distance: span.entry,
    details: { ...(base.details ?? {}), wallStop: { material: span.material, thickness: span.thickness } },
  };
}

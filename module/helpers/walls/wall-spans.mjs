/**
 * Wall spans — turn the wall crossings along one straight ray into spans of solid material.
 *
 * Foundry walls are infinitely thin lines; a shot that crosses them needs a thickness to be
 * penetrated. Instead of charging every crossing separately, the crossings are first converted
 * into material *spans* (start/end along the ray) and only then handed to the penetration
 * resolver. That is what makes corners and thick walls come out right:
 *
 * - `thin` wall (membrane): a slab of the wall's nominal thickness centred on the crossing,
 *   `half = T / (2·sinθ)` along the ray. Two thin walls meeting at a corner (or a ray through a
 *   shared vertex) give overlapping slabs, which are merged — the shared material counts once.
 * - `solid` wall (boundary of a solid mass: a thick wall drawn as two lines, a cave, a building
 *   outline): `dir` points to the OPEN side. A crossing from the open side enters the solid, a
 *   crossing from the other side leaves it. The span is the real path length between the two, so
 *   clipping the corner of a mass is automatically thinner than a straight shot.
 *
 * Pure geometry, no Foundry globals — runs in plain Node (see `wall-spans.test.mjs`).
 * All distances along the ray are in the same unit as the points (scene pixels in the game).
 */

/** @enum {string} */
export const WALL_KIND = Object.freeze({
  THIN: 'thin',
  SOLID: 'solid',
});

/** Mirrors `CONST.EDGE_DIRECTIONS`. */
export const WALL_SIDE = Object.freeze({
  BOTH: 0,
  LEFT: 1,
  RIGHT: 2,
});

/**
 * Grazing clamp: a ray almost parallel to a thin wall would otherwise get an enormous path
 * through it. `sinθ` never goes below this, so the path is at most `1 / MIN_SIN_THETA` × thickness.
 */
export const MIN_SIN_THETA = 0.2;

const EPS = 1e-6;

/**
 * Which side of the wall `a→b` the point lies on. Mirrors `Edge#orientPoint` of Foundry
 * (`foundry.utils.orient2dFast`: negative → LEFT), so the result is comparable with `wall.dir`.
 *
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {{x:number,y:number}} p
 * @returns {number} a {@link WALL_SIDE} value
 */
export function orientWallSide(a, b, p) {
  const o = (a.y - p.y) * (b.x - p.x) - (a.x - p.x) * (b.y - p.y);
  if (o === 0) return WALL_SIDE.BOTH;
  return o < 0 ? WALL_SIDE.LEFT : WALL_SIDE.RIGHT;
}

function oppositeSide(side) {
  if (side === WALL_SIDE.LEFT) return WALL_SIDE.RIGHT;
  if (side === WALL_SIDE.RIGHT) return WALL_SIDE.LEFT;
  return WALL_SIDE.BOTH;
}

/**
 * @typedef {Object} WallCrossing
 * @property {number} t distance of the crossing from the ray start
 * @property {{x:number,y:number}} a wall endpoint
 * @property {{x:number,y:number}} b wall endpoint
 * @property {string} [kind] {@link WALL_KIND} (default `thin`)
 * @property {string} material material slug
 * @property {number} [thickness] `thin`: wall thickness; `solid`: fallback depth when the ray never
 *   leaves the mass (0 = unbounded) — in material thickness units
 * @property {number} [dir] Foundry wall direction; for `solid` walls the OPEN side
 * @property {*} [ref] opaque handle, passed through untouched
 */

/**
 * @typedef {Object} WallSpan
 * @property {number} start distance along the ray where the material begins (may be < 0 when the
 *   ray starts inside a slab)
 * @property {number} end distance where it ends (`Infinity` when unbounded)
 * @property {number} entry `max(start, 0)` — where the projectile meets the material
 * @property {number} length path length through the material (ray units)
 * @property {number} thickness `length` in material thickness units (`Infinity` when unbounded)
 * @property {string} material
 * @property {string} kind {@link WALL_KIND}
 * @property {boolean} unbounded `solid` span whose far face was never found and that has no
 *   fallback depth: nothing can get through
 * @property {boolean} startedInside the ray starts inside a solid mass
 * @property {WallCrossing[]} crossings the crossings that built this span
 */

/**
 * Build the material spans along a ray.
 *
 * @param {WallCrossing[]} crossings crossings of the ray with walls of known material (any order)
 * @param {Object} ray
 * @param {{x:number,y:number}} ray.rayStart
 * @param {{x:number,y:number}} ray.rayEnd
 * @param {number} ray.pxPerThickness ray units per one material thickness unit
 * @param {number} [ray.minSin] grazing clamp, default {@link MIN_SIN_THETA}
 * @param {(material: string) => number} [ray.materialRank] who keeps an overlap between two
 *   different materials (higher wins; ties → the earlier span)
 * @returns {WallSpan[]} sorted by `start`, non-overlapping
 */
export function buildWallSpans(crossings, { rayStart, rayEnd, pxPerThickness, minSin = MIN_SIN_THETA, materialRank } = {}) {
  if (!Array.isArray(crossings) || !crossings.length || !rayStart || !rayEnd) return [];
  const rayDx = rayEnd.x - rayStart.x;
  const rayDy = rayEnd.y - rayStart.y;
  const rayLen = Math.hypot(rayDx, rayDy);
  if (rayLen < EPS) return [];
  const dx = rayDx / rayLen;
  const dy = rayDy / rayLen;
  const scale = Number.isFinite(pxPerThickness) && pxPerThickness > 0 ? pxPerThickness : 1;
  const rank = typeof materialRank === 'function' ? materialRank : () => 0;

  const prepared = crossings
    .filter((c) => c && c.a && c.b && Number.isFinite(c.t))
    .map((c) => {
      const wx = c.b.x - c.a.x;
      const wy = c.b.y - c.a.y;
      const wLen = Math.hypot(wx, wy);
      const rawSin = wLen < EPS ? 1 : Math.abs(dx * wy - dy * wx) / wLen;
      let startSide = orientWallSide(c.a, c.b, rayStart);
      if (startSide === WALL_SIDE.BOTH) startSide = oppositeSide(orientWallSide(c.a, c.b, rayEnd));
      return { c, sin: Math.max(rawSin, minSin), startSide };
    })
    .sort((p, q) => p.c.t - q.c.t);

  const intervals = [];

  // Thin walls: a slab centred on the crossing.
  for (const { c, sin } of prepared) {
    if (c.kind === WALL_KIND.SOLID && Number(c.dir) !== WALL_SIDE.BOTH) continue;
    const thickness = Math.max(0, Number(c.thickness) || 0);
    const half = (thickness * scale) / sin / 2;
    if (half < EPS) continue;
    intervals.push({
      start: c.t - half,
      end: c.t + half,
      material: c.material,
      kind: WALL_KIND.THIN,
      unbounded: false,
      startedInside: false,
      crossings: [c],
    });
  }

  // Solid walls: pair enter/exit crossings along the ray.
  let depth = 0;
  let open = null;
  let seenSolid = false;
  for (const { c, startSide } of prepared) {
    if (c.kind !== WALL_KIND.SOLID || Number(c.dir) === WALL_SIDE.BOTH) continue;
    const enters = startSide === Number(c.dir);
    if (enters) {
      if (depth === 0) {
        open = {
          start: c.t,
          end: c.t,
          material: c.material,
          kind: WALL_KIND.SOLID,
          unbounded: false,
          startedInside: false,
          crossings: [c],
        };
      } else {
        open.crossings.push(c);
      }
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      open.crossings.push(c);
      if (depth === 0) {
        open.end = c.t;
        intervals.push(open);
        open = null;
      }
    } else if (!seenSolid) {
      // First solid crossing is an exit: the ray starts inside the mass.
      intervals.push({
        start: 0,
        end: c.t,
        material: c.material,
        kind: WALL_KIND.SOLID,
        unbounded: false,
        startedInside: true,
        crossings: [c],
      });
    }
    seenSolid = true;
  }
  if (open) {
    // The ray never leaves the mass: use the fallback depth of the entering wall, if it has one.
    const depthUnits = Math.max(0, Number(open.crossings[0].thickness) || 0);
    if (depthUnits > 0) {
      open.end = open.start + depthUnits * scale;
    } else {
      open.end = Infinity;
      open.unbounded = true;
    }
    intervals.push(open);
  }

  return mergeIntervals(intervals, rank, scale);
}

/**
 * Union overlapping intervals. Same material: one span. Different materials: the higher-ranked
 * one keeps the overlap and the other is clipped (or dropped, its crossings handed to the winner,
 * when nothing of it remains).
 */
function mergeIntervals(intervals, rank, scale) {
  const sorted = intervals
    .map((iv) => ({ ...iv, crossings: iv.crossings.slice() }))
    .sort((p, q) => (p.start - q.start) || (p.end - q.end));
  const out = [];
  for (const incoming of sorted) {
    const last = out[out.length - 1];
    if (!last || incoming.start >= last.end - EPS) {
      out.push(incoming);
      continue;
    }
    if (last.material === incoming.material) {
      last.end = Math.max(last.end, incoming.end);
      last.unbounded = last.unbounded || incoming.unbounded;
      last.startedInside = last.startedInside || incoming.startedInside;
      if (incoming.kind === WALL_KIND.SOLID) last.kind = WALL_KIND.SOLID;
      last.crossings.push(...incoming.crossings);
      continue;
    }
    if (rank(last.material) >= rank(incoming.material)) {
      if (incoming.end > last.end + EPS) {
        out.push({ ...incoming, start: last.end });
      } else {
        last.crossings.push(...incoming.crossings);
      }
      continue;
    }
    // The incoming material wins the overlap.
    const tail = incoming.end < last.end - EPS
      ? { ...last, start: incoming.end, crossings: last.crossings.slice() }
      : null;
    if (incoming.start - last.start > EPS) {
      last.end = incoming.start;
    } else {
      incoming.crossings.push(...last.crossings);
      out.pop();
    }
    out.push(incoming);
    if (tail) out.push(tail);
  }
  return out.map((iv) => finishSpan(iv, scale));
}

function finishSpan(iv, scale) {
  const length = iv.unbounded ? Infinity : Math.max(0, iv.end - iv.start);
  return {
    start: iv.start,
    end: iv.end,
    entry: Math.max(iv.start, 0),
    length,
    thickness: Number.isFinite(length) ? length / scale : Infinity,
    material: iv.material,
    kind: iv.kind,
    unbounded: iv.unbounded,
    startedInside: iv.startedInside,
    crossings: iv.crossings,
  };
}

/**
 * The span that contains a distance along the ray (inclusive, with a small tolerance).
 * @param {WallSpan[]} spans
 * @param {number} t
 * @returns {WallSpan|null}
 */
export function findSpanAt(spans, t) {
  for (const span of spans) {
    if (t >= span.start - EPS && t <= span.end + EPS) return span;
  }
  return null;
}

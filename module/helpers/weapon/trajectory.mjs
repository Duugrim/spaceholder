/**
 * Weapon line trajectory: simple straight line vs complex payload library entry.
 *
 * Payload segment `length` uses measurement units (grid.distance scale):
 *   pixelDistance = length * (grid.size / grid.distance)
 * One grid cell = grid.distance measurement units.
 */

import { shNum, normalizeOnHitSplash } from './damage-profile.mjs';

export const TRAJECTORY_KINDS = Object.freeze({
  SIMPLE: 'simple',
  COMPLEX: 'complex',
});

export const TRAJECTORY_LENGTH_UNITS = Object.freeze({
  GRID: 'grid',
  MEASURE: 'measure',
});

/** @param {unknown} raw */
export function normalizeTrajectoryKind(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === TRAJECTORY_KINDS.COMPLEX ? TRAJECTORY_KINDS.COMPLEX : TRAJECTORY_KINDS.SIMPLE;
}

/** @param {unknown} raw */
export function normalizeSimpleLimit(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const unitRaw = String(src.unit ?? '').trim().toLowerCase();
  return {
    enabled: !!src.enabled,
    value: Math.max(0, shNum(src.value, 0)),
    unit: unitRaw === TRAJECTORY_LENGTH_UNITS.MEASURE
      ? TRAJECTORY_LENGTH_UNITS.MEASURE
      : TRAJECTORY_LENGTH_UNITS.GRID,
  };
}

/**
 * Length of an unlimited simple line: the canvas width + height (padding included), which reaches
 * the far edge from anywhere on it.
 * @param {object|null|undefined} scene
 * @returns {number} segment.length in measurement units
 */
export function resolveDefaultSceneSegmentLength(scene) {
  const w = Math.max(0, Number(scene?.dimensions?.width ?? scene?.width) || 0);
  const h = Math.max(0, Number(scene?.dimensions?.height ?? scene?.height) || 0);
  const gridSize = Math.max(1, Number(scene?.grid?.size) || 100);
  const distancePerCell = Math.max(0.0001, Number(scene?.grid?.distance) || 1);
  // px → grid cells → measurement units (a segment's px length is `length * size / distance`).
  return ((w + h) / gridSize) * distancePerCell;
}

/**
 * @param {object|null|undefined} simpleLimit normalized simpleLimit
 * @param {object|null|undefined} scene
 * @returns {number} segment.length in measurement units
 */
export function resolveSimpleSegmentLength(simpleLimit, scene) {
  const limit = normalizeSimpleLimit(simpleLimit);
  if (!limit.enabled) return resolveDefaultSceneSegmentLength(scene);

  const distancePerCell = Math.max(0.0001, Number(scene?.grid?.distance) || 1);
  if (limit.unit === TRAJECTORY_LENGTH_UNITS.MEASURE) return limit.value;
  return limit.value * distancePerCell;
}

/**
 * @param {object} line normalized weapon line
 * @param {Token|object|null} tokenLike token or { scene }
 * @returns {object} payload object for ShotManager
 */
export function buildSimpleLinePayload(line, tokenLike) {
  const scene = tokenLike?.scene ?? canvas?.scene ?? null;
  const length = resolveSimpleSegmentLength(line?.simpleLimit, scene);
  return {
    id: 'weapon_simple_line',
    name: 'Simple line',
    type: 'linear',
    trajectory: {
      segments: [{
        type: 'line',
        direction: 0,
        length,
        collision: {
          walls: true,
          tokens: { owner: true, ally: true, other: true },
        },
        onHit: 'stop',
      }],
    },
  };
}

/**
 * Resolve runtime payload for a weapon line.
 * @param {object} line normalized weapon line
 * @param {Token|object|null} tokenLike
 * @param {(id: string) => Promise<object|null>|object|null} getPayloadById
 * @returns {Promise<object>}
 */
export async function resolveWeaponLinePayload(line, tokenLike, getPayloadById) {
  const kind = normalizeTrajectoryKind(line?.trajectoryKind);
  if (kind === TRAJECTORY_KINDS.SIMPLE) {
    return buildSimpleLinePayload(line, tokenLike);
  }

  const payloadId = String(line?.payloadId ?? '').trim();
  if (payloadId && typeof getPayloadById === 'function') {
    const found = await getPayloadById(payloadId);
    if (found) {
      try {
        return foundry.utils.deepClone(found);
      } catch (_) {
        return structuredClone(found);
      }
    }
  }

  return buildSimpleLinePayload(line, tokenLike);
}

/**
 * @param {object} line normalized weapon line
 * @param {(key: string) => string} L i18n helper
 * @returns {string}
 */
/**
 * Clone a payload and ensure a trailing splash circle after the primary line.
 * Line onHit becomes `need` so the circle only runs on a hit (rocket pattern).
 *
 * @param {object} payload
 * @param {object} splashRaw normalizeOnHitSplash input
 * @param {object|null|undefined} scene
 * @returns {object}
 */
export function applyOnHitSplashToPayload(payload, splashRaw, scene = null) {
  const splash = normalizeOnHitSplash(splashRaw);
  if (!splash.enabled || !(splash.radius > 0) || !payload?.trajectory?.segments?.length) {
    return payload;
  }

  let clone;
  try {
    clone = foundry.utils.deepClone(payload);
  } catch (_) {
    clone = JSON.parse(JSON.stringify(payload));
  }

  const segments = Array.isArray(clone.trajectory?.segments) ? clone.trajectory.segments : [];
  const distancePerCell = Math.max(0.0001, Number(scene?.grid?.distance) || 1);
  const radiusMeasure = splash.unit === 'measure'
    ? splash.radius
    : splash.radius * distancePerCell;

  // Circle segment `range` is in grid cells (see _processCircleSegment: range * defSize).
  const radiusGrid = splash.unit === 'measure'
    ? splash.radius / distancePerCell
    : splash.radius;

  for (const seg of segments) {
    if (seg?.type === 'line' && (seg.onHit === 'stop' || !seg.onHit)) {
      seg.onHit = 'need';
    }
  }

  segments.push({
    type: 'circle',
    direction: 0,
    range: Math.max(0.01, radiusGrid),
    coverageMode: splash.coverage,
    lineOfSight: splash.lineOfSight,
    excludeDirectHit: splash.excludeDirectHit,
    ignoreDirectHitCover: splash.ignoreDirectHitCover,
    coverageForFullEffect: splash.coverageForFullEffect,
    collision: {
      walls: true,
      tokens: { owner: true, ally: true, other: true },
    },
    onHit: 'stop',
    // An explosion (not an area swing): it reaches several body parts of every target it covers.
    blast: true,
    _splashMeasure: radiusMeasure,
  });
  clone.trajectory.segments = segments;
  return clone;
}

/**
 * How a `swing` (edge sweep) turns contact into a hit. The sweep itself always stops at the
 * first wall or token it touches; the mode decides who is damaged and with what centrality.
 *
 * - `simple` — the first token on the path takes the blow; no centrality, no coverage
 * - `side`   — like `simple`, but centrality is measured on the line through the contact point
 *              perpendicular to the sweeping edge (a square blow reads as precise)
 * - `area`   — the sweep stops, but standard AoE coverage is computed over the whole swing area
 *              (everyone in it can be hit; see `coverageMode`, `coverageForFullEffect`)
 * - `deep`   — like `side`, but the sweep continues past the first token (until another wall or
 *              token stops it) and centrality comes from the swing position closest to its center
 */
export const SWING_HIT_MODES = Object.freeze({
  SIMPLE: 'simple',
  SIDE: 'side',
  AREA: 'area',
  DEEP: 'deep',
});

/**
 * @param {unknown} raw segment `hitMode`
 * @returns {string} SWING_HIT_MODES value (default `side`)
 */
export function normalizeSwingHitMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return Object.values(SWING_HIT_MODES).includes(v) ? v : SWING_HIT_MODES.SIDE;
}

function _clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Aim within this many degrees of the facing direction counts as dead center: the swing side is random. */
export const SWING_CENTER_DEAD_ZONE_DEG = 0.5;

/**
 * Side a swing sweeps toward: `right` is a left → right blow, `left` right → left (from the
 * swinger's point of view). A payload may fix it (`left` / `right`); otherwise (`auto`, the default)
 * the blow sweeps toward the center of the aiming arcs — aim left of the facing direction and the
 * edge travels left → right, aim right of it and it travels right → left; dead center is a coin flip.
 *
 * Canvas angles grow clockwise on screen, so an aim offset below the facing direction is the
 * swinger's left.
 *
 * @param {unknown} sideRaw segment `side`
 * @param {number} aimDeg aim direction (degrees)
 * @param {number} facingDeg facing direction of the swinger — the center of the aiming arcs (degrees)
 * @param {() => number} [random] source of [0, 1) for the dead-center coin flip
 * @returns {'left'|'right'}
 */
export function resolveSwingSide(sideRaw, aimDeg, facingDeg, random = Math.random) {
  const side = String(sideRaw ?? '').trim().toLowerCase();
  if (side === 'left' || side === 'right') return side;
  const offset = _wrap180(Number(aimDeg) - Number(facingDeg));
  if (!Number.isFinite(offset)) return 'right';
  if (offset < -SWING_CENTER_DEAD_ZONE_DEG) return 'right';
  if (offset > SWING_CENTER_DEAD_ZONE_DEG) return 'left';
  return random() < 0.5 ? 'left' : 'right';
}

/**
 * How far (px) a blast that goes off on a wall is pulled back off it. A wall is an infinitely thin
 * line, so a blast origin exactly on it is shadowed by that very wall: line of sight from there to
 * everything on the open side counts as blocked.
 */
export const WALL_BLAST_STANDOFF_PX = 2;

/**
 * The blast origin for a projectile that stopped on a wall: `point` moved `distance` px back toward
 * `from` (where the projectile started), at most half way.
 *
 * @param {{x: number, y: number}} point where the projectile met the wall
 * @param {{x: number, y: number}} from where the projectile started
 * @param {number} [distance] px
 * @returns {{x: number, y: number}}
 */
export function backOffFromWall(point, from, distance = WALL_BLAST_STANDOFF_PX) {
  const dx = from.x - point.x;
  const dy = from.y - point.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 1e-9)) return { x: point.x, y: point.y };
  const step = Math.min(Math.max(0, Number(distance) || 0), length / 2);
  return { x: point.x + (dx / length) * step, y: point.y + (dy / length) * step };
}

/**
 * `side` centrality. The sweeping edge first touches a round hitbox nearly tangentially, so
 * its own distance to the center says little about the blow. Instead take the line through the
 * contact point perpendicular to the edge (the direction the blow travels there): a tangent
 * contact puts the center on that line (centrality 1); contact at the reach limit or inside a
 * chord puts the center off it.
 *
 * @param {object} args
 * @param {number} args.edgeAngleDeg angle of the sweeping edge at the contact (degrees)
 * @param {{x: number, y: number}} args.contact contact point on the hitbox
 * @param {{x: number, y: number}} args.center token center
 * @param {number} args.radius hitbox radius (px)
 * @returns {number} centrality in [0, 1]
 */
export function swingSideCentrality({ edgeAngleDeg, contact, center, radius }) {
  const r = Number(radius);
  if (!(r > 0)) return 0;
  const rad = (Number(edgeAngleDeg) * Math.PI) / 180;
  const along = (center.x - contact.x) * Math.cos(rad) + (center.y - contact.y) * Math.sin(rad);
  return _clamp01(1 - Math.abs(along) / r);
}

function _wrap180(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * `deep` pass: the position of the sweeping edge (between the two angles, either order) that
 * comes closest to `center`, and that closest distance.
 *
 * @param {object} args
 * @param {{x: number, y: number}} args.origin swing origin
 * @param {{x: number, y: number}} args.center token center
 * @param {number} args.innerPx inner radius of the edge (cut)
 * @param {number} args.outerPx outer radius of the edge (reach)
 * @param {number} args.fromDeg sweep angle the window opens at (degrees)
 * @param {number} args.toDeg sweep angle the window closes at (degrees)
 * @returns {{ distance: number, point: {x: number, y: number}, deg: number }}
 */
export function swingDeepestPass({ origin, center, innerPx, outerPx, fromDeg, toDeg }) {
  const lo = Math.min(fromDeg, toDeg);
  const hi = Math.max(fromDeg, toDeg);
  const mid = (lo + hi) / 2;
  const toCenterDeg = (Math.atan2(center.y - origin.y, center.x - origin.x) * 180) / Math.PI;
  const deg = Math.max(lo, Math.min(hi, mid + _wrap180(toCenterDeg - mid)));
  const rad = (deg * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const along = (center.x - origin.x) * ux + (center.y - origin.y) * uy;
  const t = Math.max(innerPx, Math.min(outerPx, along));
  const point = { x: origin.x + ux * t, y: origin.y + uy * t };
  return { distance: Math.hypot(center.x - point.x, center.y - point.y), point, deg };
}

/**
 * Centrality from a closest-pass distance.
 * @param {number} distance px
 * @param {number} radius hitbox radius (px)
 * @returns {number} in [0, 1]
 */
export function centralityFromDistance(distance, radius) {
  const r = Number(radius);
  if (!(r > 0)) return 0;
  return _clamp01(1 - Math.max(0, Number(distance) || 0) / r);
}

/**
 * Build a short-range swing payload (new edge-sweep segment).
 * Lengths in grid cells; cut is inner radius in grid cells.
 */
export function buildSwingPayload({
  id = 'weapon_swing',
  name = 'Swing',
  range = 1,
  cut = 0,
  angle = 90,
  side = 'auto',
  hitMode = SWING_HIT_MODES.SIDE,
  onHit = 'stop',
} = {}) {
  return {
    id,
    name,
    type: 'complex',
    trajectory: {
      segments: [{
        type: 'swing',
        direction: 0,
        range,
        cut,
        angle,
        side,
        hitMode: normalizeSwingHitMode(hitMode),
        collision: {
          walls: true,
          tokens: { owner: true, ally: true, other: true },
        },
        onHit,
      }],
    },
  };
}

export function formatTrajectorySummary(line, L) {
  const kind = normalizeTrajectoryKind(line?.trajectoryKind);
  if (kind === TRAJECTORY_KINDS.COMPLEX) {
    const id = String(line?.payloadId ?? '').trim();
    return id || L('SPACEHOLDER.WeaponV3.Trajectory.NoPayload');
  }

  const limit = normalizeSimpleLimit(line?.simpleLimit);
  if (!limit.enabled) return L('SPACEHOLDER.WeaponV3.Trajectory.SceneLength');

  const unitLabel = limit.unit === TRAJECTORY_LENGTH_UNITS.MEASURE
    ? L('SPACEHOLDER.WeaponV3.Trajectory.UnitMeasureShort')
    : L('SPACEHOLDER.WeaponV3.Trajectory.UnitGridShort');
  return `${limit.value} ${unitLabel}`;
}

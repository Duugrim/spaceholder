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
 * @param {object|null|undefined} scene
 * @returns {number} segment.length in measurement units
 */
export function resolveDefaultSceneSegmentLength(scene) {
  const w = Math.max(0, Number(scene?.width) || 0);
  const h = Math.max(0, Number(scene?.height) || 0);
  const distancePerCell = Math.max(0.0001, Number(scene?.grid?.distance) || 1);
  return (w + h) * distancePerCell;
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
    collision: {
      walls: true,
      tokens: { owner: true, ally: true, other: true },
    },
    onHit: 'stop',
    _splashMeasure: radiusMeasure,
  });
  clone.trajectory.segments = segments;
  return clone;
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
  side = 'right',
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

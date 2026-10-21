/**
 * Wall data — the Foundry-facing side of wall penetration: reads the per-wall shot data
 * (`flags.spaceholder.wall`), decides which walls block shots at all, converts a wall collision
 * of the shot manager into a crossing for `wall-spans.mjs`, and turns scene distance into millimetres.
 *
 * Flag shape: `flags.spaceholder.wall = { material: string, kind: 'thin'|'solid', thickness: number }`
 * - no material → the wall stops every shot (legacy behaviour);
 * - `thin`: a partition of its own `thickness` (millimetres, the unit armour uses);
 * - `solid`: one face of a solid mass (thick wall, cave, building). The wall's Foundry
 *   `dir` is the OPEN side; `thickness` is only the fallback depth when no far face is found.
 *
 * Everything reading Foundry globals is guarded so the module also loads in plain Node.
 */

import { WALL_KIND, WALL_SIDE } from './wall-spans.mjs';

export const WALL_FLAG_SCOPE = 'spaceholder';
export const WALL_FLAG_KEY = 'wall';

/** Millimetres per scene distance unit when the scene's unit cannot be recognised: the metre. */
export const DEFAULT_MM_PER_SCENE_UNIT = 1000;

/**
 * Millimetres in each unit a scene's grid may be measured in, by the names Foundry users type
 * (English and Russian, singular and plural, with or without the dot).
 */
const MM_PER_UNIT = new Map();
for (const [mm, names] of [
  [1, ['mm', 'мм', 'millimeter', 'millimeters', 'millimetre', 'millimetres', 'миллиметр', 'миллиметры', 'миллиметров']],
  [10, ['cm', 'см', 'centimeter', 'centimeters', 'centimetre', 'centimetres', 'сантиметр', 'сантиметры', 'сантиметров']],
  [25.4, ['in', 'inch', 'inches', '"', 'дюйм', 'дюймы', 'дюймов']],
  [304.8, ['ft', 'foot', 'feet', "'", 'фут', 'футы', 'футов']],
  [914.4, ['yd', 'yard', 'yards', 'ярд', 'ярды', 'ярдов']],
  [1000, ['m', 'м', 'meter', 'meters', 'metre', 'metres', 'метр', 'метры', 'метров']],
  [1_000_000, ['km', 'км', 'kilometer', 'kilometers', 'kilometre', 'kilometres', 'километр', 'километры', 'километров']],
  [1_609_344, ['mi', 'mile', 'miles', 'миля', 'мили', 'миль']],
]) {
  for (const name of names) MM_PER_UNIT.set(name, mm);
}

/**
 * Millimetres in one scene distance unit, read from the unit written in the scene's grid settings
 * («Measurement → Distance units»: m, km, ft, yd, mi…, English or Russian). An empty or unknown unit is
 * taken as metres.
 *
 * @param {unknown} unitsRaw `scene.grid.units`
 * @returns {number} > 0
 */
export function millimetresPerSceneUnit(unitsRaw) {
  const key = String(unitsRaw ?? '').trim().toLowerCase().replace(/\.+$/, '');
  return MM_PER_UNIT.get(key) ?? DEFAULT_MM_PER_SCENE_UNIT;
}

/**
 * Normalize the raw flag value.
 * @param {unknown} raw `flags.spaceholder.wall`
 * @param {number} [dir] the wall's Foundry direction (`WALL_SIDE`); a `solid` wall without one is thin
 * @returns {{ material: string, kind: string, thickness: number }}
 */
export function normalizeWallShotData(raw, dir = WALL_SIDE.BOTH) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const material = String(src.material ?? '').trim();
  const thickness = Number(src.thickness);
  const wantsSolid = String(src.kind ?? '').trim() === WALL_KIND.SOLID;
  return {
    material,
    kind: wantsSolid && Number(dir) !== WALL_SIDE.BOTH ? WALL_KIND.SOLID : WALL_KIND.THIN,
    thickness: Number.isFinite(thickness) && thickness > 0 ? thickness : 0,
  };
}

/**
 * @param {WallDocument|object} wallDoc
 * @returns {{ material: string, kind: string, thickness: number }}
 */
export function readWallShotData(wallDoc) {
  const raw = wallDoc?.flags?.[WALL_FLAG_SCOPE]?.[WALL_FLAG_KEY]
    ?? wallDoc?.getFlag?.(WALL_FLAG_SCOPE, WALL_FLAG_KEY);
  return normalizeWallShotData(raw, Number(wallDoc?.dir) || WALL_SIDE.BOTH);
}

/**
 * Whether a wall takes part in shot collisions at all: it must block movement and, being a door,
 * must not stand open. (Open doors used to stop shots — they do not any more.)
 * @param {WallDocument|object} wallDoc
 * @returns {boolean}
 */
export function isShotBlockingWall(wallDoc) {
  if (!wallDoc?.move) return false;
  const doorType = Number(wallDoc.door) || 0;
  const open = typeof CONST !== 'undefined' ? CONST.WALL_DOOR_STATES?.OPEN : 1;
  if (doorType > 0 && Number(wallDoc.ds) === open) return false;
  return true;
}

/**
 * Convert a wall collision of the shot manager into a crossing for `planWallPasses`.
 * @param {{ type: string, object?: any, point?: object, distance?: number }} collision
 * @returns {object|null} null when the collision has no usable wall geometry
 */
export function wallCrossingFromCollision(collision) {
  if (collision?.type !== 'wall') return null;
  const doc = collision.object?.document;
  const c = doc?.c;
  if (!Array.isArray(c) || c.length < 4) return null;
  const data = readWallShotData(doc);
  return {
    collision,
    t: Number(collision.distance) || 0,
    a: { x: c[0], y: c[1] },
    b: { x: c[2], y: c[3] },
    dir: Number(doc.dir) || WALL_SIDE.BOTH,
    kind: data.kind,
    material: data.material,
    thickness: data.thickness,
  };
}

/**
 * Scene pixels per millimetre of wall thickness on the current scene: one grid cell is
 * `grid.distance` units (`grid.units`, e.g. 2 m) and `grid.size` pixels, so a wall drawn on the map
 * converts to millimetres by the scene's own scale. Gridless scenes work the same (Foundry measures in
 * pixels either way).
 * @returns {number} > 0
 */
export function getPxPerThicknessUnit() {
  let pxPerSceneUnit = 100;
  let mmPerSceneUnit = DEFAULT_MM_PER_SCENE_UNIT;
  try {
    const size = Number(canvas?.grid?.size);
    const distance = Number(canvas?.grid?.distance);
    if (size > 0 && distance > 0) pxPerSceneUnit = size / distance;
    mmPerSceneUnit = millimetresPerSceneUnit(canvas?.grid?.units ?? canvas?.scene?.grid?.units);
  } catch (_) { /* ignore */ }
  return pxPerSceneUnit / mmPerSceneUnit;
}

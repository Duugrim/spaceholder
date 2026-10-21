/**
 * Smoke tests for the swing (edge sweep) hit models: mode normalization, the `side` perpendicular
 * centrality and the `deep` closest-pass geometry, the swing side chosen from the aim, the blast
 * standoff from a wall and the default shot length.
 * Runs in plain Node (no Foundry globals required). Execute with:
 *   node module/helpers/weapon/swing.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if
 * any assertion fails.
 */

import {
  SWING_HIT_MODES,
  WALL_BLAST_STANDOFF_PX,
  backOffFromWall,
  buildSwingPayload,
  centralityFromDistance,
  normalizeSwingHitMode,
  resolveDefaultSceneSegmentLength,
  resolveSwingSide,
  swingDeepestPass,
  swingSideCentrality,
} from './trajectory.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const O = { x: 0, y: 0 };

// --- normalizeSwingHitMode --------------------------------------------------
assert('known modes pass through',
  ['simple', 'side', 'area', 'deep'].every((m) => normalizeSwingHitMode(m) === m));
assert('case / whitespace tolerant', normalizeSwingHitMode('  DEEP ') === 'deep');
assert('unknown / missing → side (the previous logic)',
  normalizeSwingHitMode('x') === SWING_HIT_MODES.SIDE && normalizeSwingHitMode(undefined) === SWING_HIT_MODES.SIDE);
assert('buildSwingPayload carries a normalized hitMode',
  buildSwingPayload({ hitMode: 'AREA' }).trajectory.segments[0].hitMode === 'area'
  && buildSwingPayload().trajectory.segments[0].hitMode === 'side');

// --- swingSideCentrality ----------------------------------------------------
{
  // Target 120px ahead, radius 50. The edge first touches it tangentially at angle −asin(50/120);
  // the contact point is then the tangent point, and the perpendicular through it passes the center.
  const R = 50;
  const center = { x: 120, y: 0 };
  const a = -Math.asin(R / 120);
  const t = Math.sqrt(120 * 120 - R * R);
  const contact = { x: t * Math.cos(a), y: t * Math.sin(a) };
  const edgeAngleDeg = (a * 180) / Math.PI;
  assert('tangent contact → precise (centrality 1)',
    near(swingSideCentrality({ edgeAngleDeg, contact, center, radius: R }), 1), swingSideCentrality({ edgeAngleDeg, contact, center, radius: R }));
}
{
  // Edge through the center (angle 0), contact at the near rim: the perpendicular is 50px behind the center.
  const c = swingSideCentrality({ edgeAngleDeg: 0, contact: { x: 70, y: 0 }, center: { x: 120, y: 0 }, radius: 50 });
  assert('chord contact through the center → centrality 0', near(c, 0), c);
}
{
  // Contact exactly at the center's own position along the edge.
  const c = swingSideCentrality({ edgeAngleDeg: 0, contact: { x: 120, y: 7 }, center: { x: 120, y: 0 }, radius: 50 });
  assert('contact level with the center → centrality 1', near(c, 1), c);
}
{
  // Reach limit: contact is the outer endpoint, center is 40px further along the edge.
  const c = swingSideCentrality({ edgeAngleDeg: 0, contact: { x: 200, y: 0 }, center: { x: 240, y: 0 }, radius: 50 });
  assert('contact at the reach limit → partial centrality (1 − 40/50)', near(c, 0.2), c);
}
assert('zero radius → 0', swingSideCentrality({ edgeAngleDeg: 0, contact: O, center: O, radius: 0 }) === 0);
assert('result is clamped to [0, 1]',
  swingSideCentrality({ edgeAngleDeg: 0, contact: { x: 0, y: 0 }, center: { x: 500, y: 0 }, radius: 50 }) === 0);

// --- swingDeepestPass / centralityFromDistance -------------------------------
{
  const p = swingDeepestPass({ origin: O, center: { x: 120, y: 0 }, innerPx: 0, outerPx: 200, fromDeg: -45, toDeg: 45 });
  assert('window covers the center: distance 0 at the center angle', near(p.distance, 0) && near(p.deg, 0), p);
}
{
  // Window ends before reaching the center angle: the closest pass is the window end.
  const p = swingDeepestPass({ origin: O, center: { x: 147.7, y: 26 }, innerPx: 0, outerPx: 200, fromDeg: -9.5, toDeg: 0 });
  assert('window ends early: closest pass is the window end', near(p.deg, 0) && near(p.distance, 26, 0.01), p);
  assert('…and its centrality follows', near(centralityFromDistance(p.distance, 50), 0.48, 0.001), centralityFromDistance(p.distance, 50));
}
{
  const p = swingDeepestPass({ origin: O, center: { x: 240, y: 0 }, innerPx: 0, outerPx: 200, fromDeg: -45, toDeg: 45 });
  assert('center beyond the reach: closest point is the outer end', near(p.distance, 40) && near(p.point.x, 200), p);
}
{
  const p = swingDeepestPass({ origin: O, center: { x: 20, y: 0 }, innerPx: 50, outerPx: 200, fromDeg: -45, toDeg: 45 });
  assert('center inside the cut radius: closest point is the inner end', near(p.distance, 30) && near(p.point.x, 50), p);
}
{
  const a = swingDeepestPass({ origin: O, center: { x: 120, y: 80 }, innerPx: 0, outerPx: 200, fromDeg: -45, toDeg: 45 });
  const b = swingDeepestPass({ origin: O, center: { x: 120, y: 80 }, innerPx: 0, outerPx: 200, fromDeg: 45, toDeg: -45 });
  assert('window order (left/right swing) does not matter', near(a.distance, b.distance) && near(a.deg, b.deg), { a, b });
}
{
  // Facing 180° (window wraps around ±180): the center straight behind is inside the window.
  const p = swingDeepestPass({ origin: O, center: { x: -120, y: 0 }, innerPx: 0, outerPx: 200, fromDeg: 135, toDeg: 225 });
  assert('angle wrap-around is handled (facing 180°)', near(p.distance, 0, 1e-6), p);
}
assert('centralityFromDistance: 0 → 1, radius → 0, beyond → 0, bad radius → 0',
  near(centralityFromDistance(0, 50), 1) && near(centralityFromDistance(50, 50), 0)
  && near(centralityFromDistance(80, 50), 0) && centralityFromDistance(10, 0) === 0);

// --- resolveSwingSide: sweep toward the center of the aiming arcs -----------
// Canvas angles grow clockwise; facing 90 deg is "down" the screen.
assert('payload side left / right wins over the aim',
  resolveSwingSide('left', 60, 90) === 'left' && resolveSwingSide(' RIGHT ', 120, 90) === 'right');
assert('aim left of facing (smaller angle) -> left-to-right blow',
  resolveSwingSide('auto', 70, 90) === 'right' && resolveSwingSide(undefined, 85, 90) === 'right');
assert('aim right of facing (larger angle) -> right-to-left blow',
  resolveSwingSide('auto', 110, 90) === 'left' && resolveSwingSide('', 95, 90) === 'left');
assert('wrap-around: facing 175, aim -170 (= 190) is 15 deg clockwise -> right-to-left',
  resolveSwingSide('auto', -170, 175) === 'left' && resolveSwingSide('auto', 160, 175) === 'right');
assert('dead center is a coin flip',
  resolveSwingSide('auto', 90, 90, () => 0.2) === 'left' && resolveSwingSide('auto', 90.2, 90, () => 0.9) === 'right');
assert('bad angles fall back to the old default (right)', resolveSwingSide('auto', NaN, 90) === 'right');
assert('buildSwingPayload defaults to the aim-driven side',
  buildSwingPayload().trajectory.segments[0].side === 'auto');

// --- backOffFromWall: a blast must start off the wall -----------------------
{
  const back = backOffFromWall({ x: 100, y: 0 }, { x: 0, y: 0 });
  assert('pulled back toward the start by the standoff',
    near(back.x, 100 - WALL_BLAST_STANDOFF_PX) && near(back.y, 0), back);
}
{
  const back = backOffFromWall({ x: 30, y: 40 }, { x: 0, y: 0 }, 5);
  assert('works along any direction (3-4-5)', near(back.x, 27) && near(back.y, 36), back);
}
{
  const back = backOffFromWall({ x: 1, y: 0 }, { x: 0, y: 0 });
  assert('never goes past half the distance to the start', near(back.x, 0.5), back);
}
{
  const same = backOffFromWall({ x: 5, y: 5 }, { x: 5, y: 5 });
  assert('start on the wall: unchanged', near(same.x, 5) && near(same.y, 5), same);
}

// --- resolveDefaultSceneSegmentLength: width + height, in measurement units --
{
  // 4000x3000 px, 100 px cells of 5 ft: 70 cells -> 350 ft, which is 7000 px at 20 px/ft.
  const scene = { dimensions: { width: 4000, height: 3000 }, grid: { size: 100, distance: 5 } };
  const length = resolveDefaultSceneSegmentLength(scene);
  const px = length * (scene.grid.size / scene.grid.distance);
  assert('unlimited line is as long as canvas width + height in px (not 100x that)',
    near(length, 350) && near(px, 7000), { length, px });
}
{
  const scene = { width: 2000, height: 1000, grid: { size: 50, distance: 1 } };
  assert('falls back to scene width / height without dimensions',
    near(resolveDefaultSceneSegmentLength(scene), 60), resolveDefaultSceneSegmentLength(scene));
}

if (failed) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll swing tests passed');

/**
 * Smoke tests for wall data: the unit a scene is measured in → millimetres, and the pixels per
 * millimetre that follow from the scene's grid. Runs in plain Node. Execute with:
 *   node module/helpers/walls/wall-data.test.mjs
 */

import { DEFAULT_MM_PER_SCENE_UNIT, getPxPerThicknessUnit, millimetresPerSceneUnit } from './wall-data.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

assert('metres: m / М / metres / метры',
  ['m', 'M', 'м', 'М', ' meters ', 'Metres', 'метр', 'метры'].every((u) => millimetresPerSceneUnit(u) === 1000));
assert('kilometres: km / км / километры',
  ['km', 'КМ', 'км', 'kilometers', 'километры'].every((u) => millimetresPerSceneUnit(u) === 1_000_000));
assert('centimetres and millimetres',
  millimetresPerSceneUnit('cm') === 10 && millimetresPerSceneUnit('см') === 10
  && millimetresPerSceneUnit('mm') === 1 && millimetresPerSceneUnit('мм') === 1);
assert('feet / yards / miles / inches',
  near(millimetresPerSceneUnit('ft'), 304.8) && near(millimetresPerSceneUnit('Feet'), 304.8)
  && near(millimetresPerSceneUnit('yd'), 914.4) && near(millimetresPerSceneUnit('mi'), 1_609_344)
  && near(millimetresPerSceneUnit('in'), 25.4) && near(millimetresPerSceneUnit('фут'), 304.8));
assert('a trailing dot is ignored (ft.)', near(millimetresPerSceneUnit('ft.'), 304.8) && millimetresPerSceneUnit('m.') === 1000);
assert('empty / unknown unit → metres',
  millimetresPerSceneUnit('') === DEFAULT_MM_PER_SCENE_UNIT && millimetresPerSceneUnit(undefined) === 1000
  && millimetresPerSceneUnit('парсек') === 1000);

function withGrid(grid, fn) {
  globalThis.canvas = { grid };
  try { return fn(); } finally { delete globalThis.canvas; }
}

// 100 px = 1 m (the default scene): 1 mm = 0.1 px, a 1 m wall is 1000 mm.
assert('100 px per 1 m → 0.1 px per mm',
  near(withGrid({ size: 100, distance: 1, units: 'm' }, getPxPerThicknessUnit), 0.1));
// 100 px = 2 m: the same pixels are twice the length → each mm is half as many pixels.
assert('100 px per 2 m → 0.05 px per mm',
  near(withGrid({ size: 100, distance: 2, units: 'm' }, getPxPerThicknessUnit), 0.05));
// 100 px = 5 ft = 1524 mm.
assert('100 px per 5 ft → 100/1524 px per mm',
  near(withGrid({ size: 100, distance: 5, units: 'ft' }, getPxPerThicknessUnit), 100 / 1524));
// 100 px = 1 km: a wall 100 px long is 1 km = 1e6 mm.
assert('100 px per 1 km → 1e-4 px per mm',
  near(withGrid({ size: 100, distance: 1, units: 'км' }, getPxPerThicknessUnit), 1e-4));
assert('a 93 px wall at 100 px = 1 m reads as 930 mm',
  near(93 / withGrid({ size: 100, distance: 1, units: 'm' }, getPxPerThicknessUnit), 930));
assert('no canvas: falls back to 100 px = 1 m', near(getPxPerThicknessUnit(), 0.1));

if (failed) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll wall-data tests passed');

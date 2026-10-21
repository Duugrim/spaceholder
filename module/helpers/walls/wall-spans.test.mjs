/**
 * Smoke tests for wall spans (slab / solid-mass spans, corners, merging).
 * Runs in plain Node (no Foundry globals required). Execute with:
 *   node module/helpers/walls/wall-spans.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 * 1 ray unit = 1 material thickness unit (`pxPerThickness: 1`) unless a case says otherwise.
 */

import { WALL_KIND, WALL_SIDE, buildWallSpans, orientWallSide } from './wall-spans.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const P = (x, y) => ({ x, y });
const SQRT2 = Math.SQRT2;

/** Wall a→b crossing the ray at distance `t`. */
const thin = (t, a, b, extra = {}) => ({ t, a, b, kind: WALL_KIND.THIN, material: 'concrete', thickness: 20, dir: 0, ...extra });
const solid = (t, a, b, dir, extra = {}) => ({ t, a, b, kind: WALL_KIND.SOLID, material: 'rock', thickness: 0, dir, ...extra });

const RAY_X = { rayStart: P(0, 0), rayEnd: P(1000, 0), pxPerThickness: 1 };
const perpendicular = (t, extra) => thin(t, P(t, -50), P(t, 50), extra);

// --- orientation mirrors Foundry (negative orient2d → LEFT) --------------------------------------
assert('orientWallSide: ray start left of a vertical wall (a→b pointing +y)',
  orientWallSide(P(100, -50), P(100, 50), P(0, 0)) === WALL_SIDE.LEFT);
assert('orientWallSide: other side', orientWallSide(P(100, -50), P(100, 50), P(200, 0)) === WALL_SIDE.RIGHT);
assert('orientWallSide: collinear → BOTH', orientWallSide(P(0, 0), P(10, 0), P(5, 0)) === WALL_SIDE.BOTH);

// --- thin walls ------------------------------------------------------------------------------------
{
  const spans = buildWallSpans([perpendicular(100)], RAY_X);
  assert('thin, perpendicular: one slab of the wall thickness centred on the crossing',
    spans.length === 1 && near(spans[0].start, 90) && near(spans[0].end, 110)
    && near(spans[0].length, 20) && near(spans[0].thickness, 20) && near(spans[0].entry, 90),
    spans);
}
{
  // Wall at 30° to the ray: sinθ = 0.5 → the path through the slab doubles.
  const a = P(100 - 50 * Math.cos(Math.PI / 6), -50 * Math.sin(Math.PI / 6));
  const b = P(100 + 50 * Math.cos(Math.PI / 6), 50 * Math.sin(Math.PI / 6));
  const spans = buildWallSpans([thin(100, a, b)], RAY_X);
  assert('thin, oblique (30°): path through the wall is T / sinθ', spans.length === 1 && near(spans[0].length, 40), spans[0]?.length);
}
{
  // Nearly parallel wall (sinθ ≈ 0.05) is clamped to 0.2 → at most 5× the thickness.
  const spans = buildWallSpans([thin(100, P(0, 0.05 * 10), P(200, 0), {})], RAY_X);
  assert('thin, grazing: path is clamped (≤ 5× thickness)', spans.length === 1 && near(spans[0].length, 100), spans[0]?.length);
}
{
  const spans = buildWallSpans([perpendicular(100, { thickness: 0 }), perpendicular(200, { material: 'wood' })], RAY_X);
  assert('thin with zero thickness makes no span', spans.length === 1 && spans[0].material === 'wood', spans.map((s) => s.material));
}
{
  const spans = buildWallSpans([perpendicular(300), perpendicular(100)], RAY_X);
  assert('far apart walls stay separate and sorted', spans.length === 2 && spans[0].entry < spans[1].entry, spans.map((s) => s.entry));
}

// --- corners -----------------------------------------------------------------------------------------
{
  // L-corner at (100, 90): wall A vertical x=100, wall B horizontal y=90. The ray at 45° passes
  // just beside the corner point (90,90) → (100,100): it crosses B first, then A.
  const ray = { rayStart: P(0, 0), rayEnd: P(300, 300), pxPerThickness: 1 };
  const wallB = thin(90 * SQRT2, P(0, 90), P(200, 90));
  const wallA = thin(100 * SQRT2, P(100, -100), P(100, 100));
  const spans = buildWallSpans([wallA, wallB], ray);
  const sum = 2 * (20 / (Math.SQRT1_2));
  assert('L-corner: the two slabs overlap and merge into one span',
    spans.length === 1, spans.length);
  assert('L-corner: merged thickness is less than charging both walls',
    spans[0].length < sum - 1e-6 && spans[0].length > 20 / Math.SQRT1_2, { len: spans[0].length, sum });
  assert('L-corner: both walls belong to the span', spans[0].crossings.length === 2);
}
{
  // Ray through a shared vertex: both segments are hit at the very same distance.
  const spans = buildWallSpans([
    thin(100, P(100, -50), P(100, 0)),
    thin(100, P(100, 0), P(100, 50)),
  ], RAY_X);
  assert('shared vertex: the duplicate hit is counted once', spans.length === 1 && near(spans[0].length, 20), spans[0]?.length);
}

// --- merge of different materials ------------------------------------------------------------------
{
  const rank = (m) => ({ concrete: 5, wood: 2 }[m] ?? 0);
  const stronger = buildWallSpans([
    perpendicular(100, { material: 'concrete' }),
    perpendicular(110, { material: 'wood' }),
  ], { ...RAY_X, materialRank: rank });
  assert('overlap: the stronger material keeps it (concrete first)',
    stronger.length === 2 && stronger[0].material === 'concrete' && near(stronger[0].end, 110)
    && stronger[1].material === 'wood' && near(stronger[1].start, 110) && near(stronger[1].end, 120),
    stronger.map((s) => [s.material, s.start, s.end]));
  const weakerFirst = buildWallSpans([
    perpendicular(100, { material: 'wood' }),
    perpendicular(110, { material: 'concrete' }),
  ], { ...RAY_X, materialRank: rank });
  assert('overlap: the stronger material keeps it (wood first, clipped)',
    weakerFirst.length === 2 && weakerFirst[0].material === 'wood' && near(weakerFirst[0].end, 100)
    && weakerFirst[1].material === 'concrete' && near(weakerFirst[1].start, 100) && near(weakerFirst[1].end, 120),
    weakerFirst.map((s) => [s.material, s.start, s.end]));
}

// --- solid masses ----------------------------------------------------------------------------------
{
  // Thick wall drawn as two lines: x=100 (open side: left of the wall → LEFT) and x=300 (open side
  // is x>300 → RIGHT for the same a→b direction).
  const west = solid(100, P(100, -50), P(100, 50), WALL_SIDE.LEFT);
  const east = solid(300, P(300, -50), P(300, 50), WALL_SIDE.RIGHT);
  const spans = buildWallSpans([east, west], RAY_X);
  assert('solid pair: one span, thickness = real distance between the faces',
    spans.length === 1 && near(spans[0].start, 100) && near(spans[0].end, 300) && near(spans[0].thickness, 200)
    && spans[0].kind === WALL_KIND.SOLID && !spans[0].unbounded && !spans[0].startedInside, spans[0]);
}
{
  // Mass x∈[100,300], y∈[0,200]; open side outside. Ray y = x − 250 clips the north-east corner:
  // in through the north face at (250,0), out through the east face at (300,50).
  const ray = { rayStart: P(0, -250), rayEnd: P(500, 250), pxPerThickness: 1 };
  const north = solid(250 * SQRT2, P(100, 0), P(300, 0), WALL_SIDE.RIGHT);
  const eastFace = solid(300 * SQRT2, P(300, 0), P(300, 200), WALL_SIDE.RIGHT);
  const spans = buildWallSpans([north, eastFace], ray);
  assert('solid corner clip: the span is the short chord, not the full thickness of the mass',
    spans.length === 1 && near(spans[0].length, 50 * SQRT2, 1e-6), spans[0]?.length);
}
{
  // Ray starting inside the mass leaves through the east face.
  const ray = { rayStart: P(150, 50), rayEnd: P(1000, 50), pxPerThickness: 1 };
  const eastFace = solid(150, P(300, 0), P(300, 200), WALL_SIDE.RIGHT);
  const spans = buildWallSpans([eastFace], ray);
  assert('solid: ray that starts inside the mass → span from the ray start to the exit face',
    spans.length === 1 && spans[0].startedInside && near(spans[0].start, 0) && near(spans[0].end, 150), spans[0]);
}
{
  const west = solid(100, P(100, -50), P(100, 50), WALL_SIDE.LEFT, { thickness: 80 });
  const spans = buildWallSpans([west], RAY_X);
  assert('solid: no far face → fallback depth of the entering wall',
    spans.length === 1 && near(spans[0].length, 80) && !spans[0].unbounded, spans[0]);
}
{
  const west = solid(100, P(100, -50), P(100, 50), WALL_SIDE.LEFT, { thickness: 0 });
  const spans = buildWallSpans([west], RAY_X);
  assert('solid: no far face and no fallback depth → unbounded (impenetrable)',
    spans.length === 1 && spans[0].unbounded && spans[0].thickness === Infinity, spans[0]);
}
{
  const bothSides = solid(100, P(100, -50), P(100, 50), WALL_SIDE.BOTH, { thickness: 10 });
  const spans = buildWallSpans([bothSides], RAY_X);
  assert('solid without a direction behaves like a thin wall', spans.length === 1 && spans[0].kind === WALL_KIND.THIN && near(spans[0].length, 10), spans[0]);
}
{
  // A solid mass and a thin wall (a door in it) overlapping: same ray, mass x∈[100,300], door slab at 200.
  const west = solid(100, P(100, -50), P(100, 50), WALL_SIDE.LEFT, { material: 'rock' });
  const east = solid(300, P(300, -50), P(300, 50), WALL_SIDE.RIGHT, { material: 'rock' });
  const door = perpendicular(200, { material: 'rock', thickness: 10 });
  const spans = buildWallSpans([west, east, door], RAY_X);
  assert('thin wall inside a solid mass of the same material is absorbed', spans.length === 1 && near(spans[0].length, 200), spans.map((s) => s.length));
}

// --- degenerate input ------------------------------------------------------------------------------
assert('no crossings → no spans', buildWallSpans([], RAY_X).length === 0);
assert('zero-length ray → no spans', buildWallSpans([perpendicular(0)], { rayStart: P(0, 0), rayEnd: P(0, 0), pxPerThickness: 1 }).length === 0);

if (failed) {
  console.error(`\n${failed} wall-spans test(s) failed`);
  process.exit(1);
}
console.log('\nAll wall-spans tests passed');

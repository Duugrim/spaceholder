/**
 * Smoke tests for wall penetration (projectile carried through wall spans with the v3 armour rules).
 * Runs in plain Node (no Foundry globals required). Execute with:
 *   node module/helpers/walls/wall-penetration.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 *
 * Reference numbers (steel-plate fixture: hardness 10, ballistic resistance 100):
 *   projectile  damage 10, armorPen ×2, hardness 1  → E = 10·2²·1 = 40
 *   1 unit of steel: eAR = 10·1² = 10 → penetrates, Eafter = 30, residual damage = 10·30/40 = 7.5
 *   2 units of steel: eAR = 40 → E is not above it → held
 */

import { TEST_MATERIAL_FIXTURES } from '../damage/__fixtures__/test-materials.mjs';
import { walkProjectileCollisions } from '../hit-luck.mjs';
import { WALL_KIND, WALL_SIDE } from './wall-spans.mjs';
import { wallCrossingFromCollision } from './wall-data.mjs';
import { isUsableWallMaterial, passSpan, planWallPasses, totalApplicationsDamage } from './wall-penetration.mjs';

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

const resolveMaterial = (id) => TEST_MATERIAL_FIXTURES[id] ?? null;
const RAY = { rayStart: P(0, 0), rayEnd: P(1000, 0), pxPerThickness: 1 };

const bullet = (over = {}) => [{
  mode: 'sequential',
  items: [{ type: 'ballistic', damage: 10, armorPen: 2, armorDamageFactor: 1, hardness: 1, ...over }],
}];

let collisionSeq = 0;
function crossing(t, extra = {}) {
  const collision = { type: 'wall', object: { id: `w${collisionSeq += 1}` }, point: P(t, 0), distance: t, details: {} };
  return {
    collision,
    t,
    a: P(t, -50),
    b: P(t, 50),
    dir: WALL_SIDE.BOTH,
    kind: WALL_KIND.THIN,
    material: 'steel-plate',
    thickness: 1,
    ...extra,
  };
}

const plan = (crossings, applications = bullet(), extra = {}) => planWallPasses({
  crossings, applications, resolveMaterial, ...RAY, ...extra,
});

// --- helpers -----------------------------------------------------------------------------------------
assert('usable wall material needs structure', isUsableWallMaterial(TEST_MATERIAL_FIXTURES['steel-plate'])
  && !isUsableWallMaterial({ materialId: 'unknown', integrityPerThickness: 0 }) && !isUsableWallMaterial(null));
assert('totalApplicationsDamage sums every item', near(totalApplicationsDamage(bullet()), 10));

// --- passSpan ----------------------------------------------------------------------------------------
{
  const r = passSpan({ span: { material: 'steel-plate', thickness: 1 }, applications: bullet(), resolveMaterial });
  const item = r.applications[0]?.items?.[0];
  assert('passSpan: penetrates 1 unit of steel with the expected residual and energy',
    r.penetrated && near(item.damage, 7.5) && near(item.energy, 30) && item.type === 'ballistic', item);
}
{
  const r = passSpan({ span: { material: 'steel-plate', thickness: 2 }, applications: bullet(), resolveMaterial });
  assert('passSpan: 2 units of steel hold the same bullet', !r.penetrated && r.applications.length === 0);
}
{
  const r = passSpan({ span: { material: 'steel-plate', thickness: 1 }, applications: bullet({ armorPen: 0.5 }), resolveMaterial });
  assert('passSpan: weak bullet is stopped', !r.penetrated);
}
{
  const r = passSpan({
    span: { material: 'steel-plate', thickness: 1 },
    applications: bullet({ armorDamageReduction: 50 }),
    resolveMaterial,
  });
  const item = r.applications[0]?.items?.[0];
  assert('passSpan: armorDamageReduction is carried on', r.penetrated && item.armorDamageReduction === 50, item);
}
{
  // A held layer may spill other types (self-induction); only the projectile's own type flies on.
  const r = passSpan({
    span: { material: 'steel-plate', thickness: 1 },
    applications: [{ mode: 'sequential', items: [
      { type: 'ballistic', damage: 10, armorPen: 2, hardness: 1 },
      { type: 'thermal', damage: 5, armorPen: 0.1, hardness: 1 },
    ] }],
    resolveMaterial,
  });
  const types = r.applications[0]?.items?.map((i) => i.type) ?? [];
  assert('passSpan: items are resolved independently, only same-type shards leave the wall',
    types.includes('ballistic') && !types.includes('concussive'), types);
}

// --- planWallPasses ----------------------------------------------------------------------------------
{
  const w = crossing(100);
  const p = plan([w]);
  assert('plan: one thin steel wall is passed, energy carried on', !p.block && p.passes.length === 1
    && near(p.applications[0].items[0].energy, 30), p.block);
  assert('plan: stepFor a passed wall → does not block', p.stepFor(w.collision)?.blocks === false);
  assert('plan: carryAt before the wall → nothing, behind it → reduced projectile',
    p.carryAt(50) === null && near(p.carryAt(150)[0].items[0].damage, 7.5));
  assert('plan: event describes the pass', p.events.length === 1 && p.events[0].penetrated
    && near(p.events[0].damageBefore, 10) && near(p.events[0].damageAfter, 7.5));
}
{
  const a = crossing(100);
  const b = crossing(300);
  const p = plan([b, a]);
  const items = p.applications[0].items;
  assert('plan: two walls in a row drain the energy (40 → 30 → 20), input order does not matter',
    p.passes.length === 2 && near(items[0].energy, 20) && near(items[0].damage, 5), items);
}
{
  const a = crossing(100, { thickness: 2 });
  const b = crossing(300);
  const p = plan([a, b]);
  assert('plan: a wall that holds ends the plan, the one behind it is never reached',
    p.block?.kind === 'stopped' && p.passes.length === 0, p.block?.kind);
  assert('plan: block collision sits at the face of the stopping wall',
    near(p.block.collision.point.x, 99) && p.block.collision.type === 'wall', p.block.collision.point); // slab [99, 101]
  assert('plan: stepFor both walls → blocks, same stop point',
    p.stepFor(a.collision)?.blocks === true && p.stepFor(a.collision).blockCollision === p.block.collision);
  assert('plan: stopped event explains why', p.events[0].reason === 'stopped' && !p.events[0].penetrated);
}
{
  const a = crossing(100, { material: 'no-such-material' });
  const p = plan([a]);
  assert('plan: unknown material keeps the legacy block (opaque)', p.block?.kind === 'opaque'
    && p.block.collision === a.collision && p.stepFor(a.collision).blocks === true, p.block?.kind);
}
{
  const a = crossing(100, { material: '' });
  const p = plan([a]);
  assert('plan: wall without a material is opaque', p.block?.kind === 'opaque');
}
{
  const a = crossing(100);
  const b = crossing(200, { material: 'no-such-material' });
  const p = plan([a, b]);
  assert('plan: passes a configured wall, then is stopped by an unconfigured one',
    p.passes.length === 1 && p.block?.kind === 'opaque' && p.block.collision === b.collision, p.block?.kind);
  assert('plan: tokens between the two walls get the reduced projectile', near(p.carryAt(150)[0].items[0].damage, 7.5));
}
{
  const a = crossing(100, { material: 'no-such-material' });
  const b = crossing(200);
  const p = plan([a, b]);
  assert('plan: an unconfigured wall in front blocks before the configured one behind it',
    p.block?.kind === 'opaque' && p.passes.length === 0 && p.stepFor(a.collision).blocks, p.block?.kind);
}
{
  const west = crossing(100, { kind: WALL_KIND.SOLID, dir: WALL_SIDE.LEFT, material: 'steel-plate', thickness: 0 });
  const east = crossing(101, { kind: WALL_KIND.SOLID, dir: WALL_SIDE.RIGHT, material: 'steel-plate', thickness: 0 });
  const p = plan([west, east]);
  assert('plan: solid pair is one span (1 unit thick) and both faces are passed together',
    p.passes.length === 1 && near(p.passes[0].span.thickness, 1) && p.stepFor(west.collision).blocks === false
    && p.stepFor(east.collision).blocks === false, p.passes.map((x) => x.span.thickness));
}
{
  const west = crossing(100, { kind: WALL_KIND.SOLID, dir: WALL_SIDE.LEFT, material: 'steel-plate', thickness: 0 });
  const p = plan([west]);
  assert('plan: solid wall with no far face and no depth is impenetrable', p.block?.kind === 'unbounded'
    && p.stepFor(west.collision).blocks === true && p.events[0].reason === 'unbounded', p.block?.kind);
}
{
  const p = plan([]);
  assert('plan: no walls → nothing to do', !p.block && p.passes.length === 0 && p.applications === null && p.carryAt(500) === null);
}
{
  const w = crossing(100);
  const p = plan([w], []);
  assert('plan: a projectile without damage does not get through', p.block?.kind === 'stopped', p.block?.kind);
}
{
  // The input applications are never mutated.
  const apps = bullet();
  const snapshot = JSON.stringify(apps);
  plan([crossing(100)], apps);
  assert('plan: input applications are left untouched', JSON.stringify(apps) === snapshot);
}

// --- pipeline: wall documents → crossings → plan → collision walk (what _processLineSegment does) ---------
{
  const wallCollision = (c, dir, flag, distance) => ({
    type: 'wall',
    object: { document: { c, dir, move: 20, door: 0, flags: flag ? { spaceholder: { wall: flag } } : {} } },
    point: P(c[0], 0),
    distance,
    details: {},
  });
  const tokenCollision = (id, distance, centrality = 0.9) => ({
    type: 'token', object: { id }, point: P(distance, 0), distance, details: { centrality },
  });
  const luck = () => ({ passedTokens: new Set(), passedThrough: [] });
  const run = (collisions, onHit = 'stop') => {
    const crossings = collisions.map((c) => wallCrossingFromCollision(c)).filter(Boolean);
    const wallPlan = planWallPasses({
      crossings, applications: bullet(), resolveMaterial, ...RAY,
    });
    return { reached: walkProjectileCollisions(collisions, onHit, luck(), wallPlan), wallPlan };
  };

  {
    const wall = wallCollision([100, -50, 100, 50], WALL_SIDE.BOTH, { material: 'steel-plate', kind: 'thin', thickness: 1 }, 100);
    const { reached } = run([wall, tokenCollision('A', 300)]);
    assert('pipeline: a shot goes through a configured wall and hits the token behind with reduced damage',
      reached.length === 1 && reached[0].object.id === 'A' && near(reached[0].details.carry[0].items[0].damage, 7.5), reached);
  }
  {
    const wall = wallCollision([100, -50, 100, 50], WALL_SIDE.BOTH, { material: 'steel-plate', kind: 'thin', thickness: 3 }, 100);
    const { reached } = run([wall, tokenCollision('A', 300)]);
    assert('pipeline: a wall too thick for the projectile stops the shot, the token behind is untouched',
      reached.length === 1 && reached[0].type === 'wall', reached.map((r) => r.type));
  }
  {
    const wall = wallCollision([100, -50, 100, 50], WALL_SIDE.BOTH, null, 100);
    const { reached } = run([wall, tokenCollision('A', 300)]);
    assert('pipeline: a wall nobody configured keeps stopping every shot', reached.length === 1 && reached[0] === wall);
  }
  {
    // Thick wall drawn as two lines: x=100 open to the left, x=101 open to the right (1 unit of steel).
    const west = wallCollision([100, -50, 100, 50], WALL_SIDE.LEFT, { material: 'steel-plate', kind: 'solid', thickness: 0 }, 100);
    const east = wallCollision([101, -50, 101, 50], WALL_SIDE.RIGHT, { material: 'steel-plate', kind: 'solid', thickness: 0 }, 101);
    const { reached, wallPlan } = run([west, east, tokenCollision('A', 300)]);
    assert('pipeline: a solid wall drawn as two lines is one span of the real thickness',
      reached.length === 1 && reached[0].object.id === 'A' && wallPlan.passes.length === 1
      && near(wallPlan.passes[0].span.thickness, 1), reached.map((r) => r.type));
  }
  {
    const west = wallCollision([100, -50, 100, 50], WALL_SIDE.LEFT, { material: 'steel-plate', kind: 'solid', thickness: 0 }, 100);
    const east = wallCollision([103, -50, 103, 50], WALL_SIDE.RIGHT, { material: 'steel-plate', kind: 'solid', thickness: 0 }, 103);
    const { reached } = run([west, east, tokenCollision('A', 300)]);
    assert('pipeline: the same solid wall, 3 units thick, stops the shot at its face',
      reached.length === 1 && reached[0].type === 'wall' && near(reached[0].point.x, 100), reached[0]?.point);
  }
  {
    // A solid wall with no direction is treated as thin (its fallback thickness is then its thickness).
    const wall = wallCollision([100, -50, 100, 50], WALL_SIDE.BOTH, { material: 'steel-plate', kind: 'solid', thickness: 1 }, 100);
    const { reached } = run([wall, tokenCollision('A', 300)]);
    assert('pipeline: a solid wall without a direction counts as thin', reached.length === 1 && reached[0].object.id === 'A');
  }
}

// --- walls in front of a token (the penetration view puts them in front of it) -----------------------------
{
  const walk = (collisions, wallPlan, onHit = 'stop') => walkProjectileCollisions(collisions, onHit, { passedTokens: new Set(), passedThrough: [] }, wallPlan);
  const tokenAt = (id, distance) => ({ type: 'token', object: { id }, point: P(distance, 0), distance, details: {} });
  const a = crossing(100);
  const b = crossing(300);
  const A = tokenAt('A', 200);
  const B = tokenAt('B', 500);
  const p = plan([a, b]);

  const [first] = walk([a.collision, A, b.collision, B], p);
  assert('walls before a token: only the walls between the shooter and the token', first.object.id === 'A'
    && first.details.wallsBefore?.length === 1 && first.details.wallsBefore[0] === p.events[0], first.details);

  const reached = walk([a.collision, A, b.collision, B], p, 'next');
  assert('walls before a token: each wall goes to the first token behind it (piercing shot)',
    reached.length === 2 && reached[0].details.wallsBefore.length === 1 && reached[1].details.wallsBefore.length === 1
    && reached[1].details.wallsBefore[0] === p.events[1], reached.map((r) => r.details.wallsBefore?.length));

  const [bare] = walk([tokenAt('A2', 50)], plan([a]));
  assert('walls before a token: none when no wall lies in front of it', bare.details.wallsBefore === undefined, bare.details);
  const [noPlan] = walk([tokenAt('A3', 50)], null);
  assert('walls before a token: without a plan there is nothing to attach', noPlan.details.wallsBefore === undefined);
}

if (failed) {
  console.error(`\n${failed} wall-penetration test(s) failed`);
  process.exit(1);
}
console.log('\nAll wall-penetration tests passed');

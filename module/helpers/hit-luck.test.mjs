/**
 * Smoke tests for hit-luck: zones and the projectile collision walk (wall plan, the `judgeToken` hook
 * that lets a projectile fly past a token). Runs in plain Node (no Foundry globals required). Execute with:
 *   node module/helpers/hit-luck.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

import {
  HIT_LUCK_ZONE_ORDER,
  MIN_CARRY_DAMAGE,
  clockToHitFace,
  followProjectileThroughBodies,
  normalizeLuckZone,
  walkProjectileCollisions,
} from './hit-luck.mjs';
import { applyEnergyScaleToApplications } from './weapon/damage-profile.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

// --- zones / clock ---------------------------------------------------------------------------------
assert('zones: the known ones pass, anything else is green',
  HIT_LUCK_ZONE_ORDER.every((z) => normalizeLuckZone(z) === z) && normalizeLuckZone('blue') === 'green' && normalizeLuckZone(undefined) === 'green');
assert('clock → face: 12 and the hours round it are front, 3–9 via 6 is back',
  clockToHitFace(12) === 'front' && clockToHitFace(2) === 'front' && clockToHitFace(10) === 'front'
  && clockToHitFace(6) === 'back' && clockToHitFace(4) === 'back' && clockToHitFace(8) === 'back' && clockToHitFace('x') === 'front');

// --- walkProjectileCollisions ------------------------------------------------
const state = () => ({ passedTokens: new Set(), passedThrough: [] });
// Real tokens are stable placeable objects; the walk remembers fly-pasts by object identity.
const tokenObjects = new Map();
const tokenObject = (id) => {
  if (!tokenObjects.has(id)) tokenObjects.set(id, { id });
  return tokenObjects.get(id);
};
const token = (id, centrality) => ({ type: 'token', object: tokenObject(id), point: { x: 0, y: 0 }, details: { centrality } });
const wall = () => ({ type: 'wall', object: { id: 'wall' }, point: { x: 0, y: 0 }, details: {} });
const ids = (list) => list.map((c) => c.object.id).join(',');
const passedIds = (st) => st.passedThrough.map((p) => p.object.id).join(',');
// A judge that lets the projectile fly past the tokens listed.
const flyPast = (...names) => ({ judgeToken: (c) => ({ pass: names.includes(c.object.id) }) });

{
  const st = state();
  const out = walkProjectileCollisions([token('A', 0.5), token('B', 0.9)], 'stop', st);
  assert('stop: first token ends the walk, nothing is flown past', ids(out) === 'A' && st.passedThrough.length === 0);
}
{
  const st = state();
  const out = walkProjectileCollisions([token('A', 0.5), token('B', 0.9)], 'need', st);
  assert('need: only the first token (rocket)', ids(out) === 'A');
}
{
  const st = state();
  const out = walkProjectileCollisions([token('A', 0.5), token('B', 0.9), wall(), token('C', 0.9)], 'next', st);
  assert('next: pierces tokens up to and including the wall, nothing behind it', ids(out) === 'A,B,wall', ids(out));
}
{
  const st = state();
  const out = walkProjectileCollisions([token('A', 0.5), token('B', 0.9)], 'stop', st, null, flyPast('A'));
  assert('judge: a token flown past is skipped, the next one is hit', ids(out) === 'B' && passedIds(st) === 'A', { out: ids(out), passed: passedIds(st) });
}
{
  const st = state();
  const out = walkProjectileCollisions([token('A', 0.5), token('B', 0.5)], 'stop', st, null, flyPast('A', 'B'));
  assert('judge: flying past everything → no hit', out.length === 0 && passedIds(st) === 'A,B');
}
{
  const st = state();
  const out = walkProjectileCollisions([token('A', 0.5), token('B', 0.5), token('C', 0.9), wall(), token('D', 0.9)], 'next', st, null, flyPast('A'));
  assert('judge + next: pierces the real hits up to the wall', ids(out) === 'B,C,wall' && passedIds(st) === 'A', { out: ids(out), passed: passedIds(st) });
}
{
  const st = state();
  const out = walkProjectileCollisions([token('A', 0.5), wall(), token('B', 0.9)], 'stop', st, null, flyPast('A'));
  assert('judge: a wall stops the walk (fly-past does not skip it)', ids(out) === 'wall' && passedIds(st) === 'A');
}
{
  const st = state();
  const out = walkProjectileCollisions([token('A', 0.5)], 'stop', st, null, {
    judgeToken: () => ({ details: { verdict: 'hit' } }),
  });
  assert('judge: details of a hit are merged into the collision', out[0].details.verdict === 'hit' && out[0].details.centrality === 0.5, out[0].details);
}
{
  const st = state();
  walkProjectileCollisions([token('A', 0.5)], 'stop', st, null, {
    judgeToken: () => ({ pass: true, details: { why: 'high' } }),
  });
  assert('judge: details of a fly-past go to the pass record', st.passedThrough[0].details.why === 'high' && st.passedThrough[0].details.centrality === 0.5, st.passedThrough);
}
{
  const st = state();
  walkProjectileCollisions([token('A', 0.5)], 'stop', st, null, flyPast('A'));
  const again = walkProjectileCollisions([token('A', 0.9), token('B', 0.9)], 'stop', st);
  assert('a token flown past is ignored for the rest of the shot (even without the judge)', ids(again) === 'B');
}
{
  const st = state();
  const input = [token('A', 0.5), token('B', 0.9)];
  const copy = input.map((c) => ({ ...c }));
  walkProjectileCollisions(input, 'stop', st);
  assert('the input list is not reordered or shortened', input.length === 2 && input[0].object.id === copy[0].object.id && input[1].object.id === copy[1].object.id);
}
assert('empty input → empty result', walkProjectileCollisions([], 'stop', state()).length === 0);

// --- wall plan (penetrable walls) ------------------------------------------------------------------
// A plan is whatever `planWallPasses` returns: per wall collision "blocks or not", and the projectile
// that is left at a given distance.
const at = (collision, distance) => ({ ...collision, distance });
const CARRY = [{ mode: 'parallel', items: [{ type: 'ballistic', damage: 7.5 }] }];
const planOf = (stepByObjectId, carryFrom = Infinity) => ({
  stepFor: (c) => stepByObjectId[c.object.id] ?? null,
  carryAt: (d) => (d >= carryFrom ? CARRY : null),
});
{
  const st = state();
  const w = at(wall(), 50);
  const out = walkProjectileCollisions([w, at(token('A', 0.9), 100)], 'stop', st, planOf({ wall: { blocks: false } }, 50));
  assert('plan: a passed wall does not end the walk, the token behind it is hit', ids(out) === 'A', ids(out));
  assert('plan: the token behind a passed wall carries the reduced projectile', out[0].details.carry === CARRY, out[0].details);
}
{
  const st = state();
  const w = at(wall(), 50);
  const out = walkProjectileCollisions([at(token('A', 0.9), 20), w], 'next', st, planOf({ wall: { blocks: false } }, 50));
  assert('plan: a token in front of the wall gets no carry', ids(out) === 'A' && !('carry' in out[0].details), out[0].details);
}
{
  const st = state();
  const stop = { type: 'wall', object: { id: 'stop' }, point: { x: 9, y: 9 }, distance: 49, details: {} };
  const out = walkProjectileCollisions([at(wall(), 50), at(token('A', 0.9), 100)], 'stop', st,
    planOf({ wall: { blocks: true, blockCollision: stop } }));
  assert('plan: a wall that holds ends the walk at the plan\'s stop collision', out.length === 1 && out[0] === stop);
}
{
  const st = state();
  const out = walkProjectileCollisions([at(wall(), 50), at(token('A', 0.9), 100)], 'stop', st, planOf({}));
  assert('plan: a wall the plan knows nothing about keeps the legacy block', ids(out) === 'wall');
}
{
  const st = state();
  const out = walkProjectileCollisions(
    [at(token('A', 0.9), 20), at(wall(), 50), at(token('B', 0.9), 100), at(token('C', 0.9), 150)],
    'next', st, planOf({ wall: { blocks: false } }, 50));
  assert('plan + next: pierces tokens on both sides of a passed wall',
    ids(out) === 'A,B,C' && !('carry' in out[0].details) && out[1].details.carry === CARRY && out[2].details.carry === CARRY,
    ids(out));
}
{
  const st = state();
  const out = walkProjectileCollisions([at(wall(), 50), at(token('A', 0.9), 100)], 'stop', st, null);
  assert('no plan: legacy behaviour is unchanged (wall stops the walk)', ids(out) === 'wall');
}

// --- followProjectileThroughBodies (a bullet that left a body flies on) ----------------------------------
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const bullet = (damage, energy = damage * 4) => [{
  mode: 'parallel',
  items: [{ type: 'ballistic', damage, armorPen: 2, hardness: 1, energy }],
}];
const energyOf = (apps) => apps?.[0]?.items?.[0]?.energy;
const damageOf = (apps) => apps?.[0]?.items?.[0]?.damage;

/**
 * Run the chain over `collisions`. `stays` lists the bodies the bullet does not leave; every other body it
 * leaves with `exitShare` of the energy that reached it. Returns the walk result and what each body got.
 */
async function follow(collisions, {
  exit = bullet(10),
  level = 1,
  levels = {},
  stays = [],
  exitShare = 0.5,
  planWalls = () => null,
  judgeToken = null,
  st = state(),
} = {}) {
  const received = [];
  const result = await followProjectileThroughBodies({
    collisions,
    exit,
    level,
    passState: st,
    judgeToken,
    planWalls,
    levelAt: (c) => levels[c.object?.id] ?? level,
    scale: applyEnergyScaleToApplications,
    deliver: async (collision, carry) => {
      received.push({ id: collision.object.id, carry });
      if (stays.includes(collision.object.id)) return [];
      return applyEnergyScaleToApplications(carry, exitShare);
    },
  });
  return { result, received, st };
}
const receivedIds = (received) => received.map((x) => x.id).join(',');

{
  const { result, received } = await follow([at(token('B', 0.9), 100), at(token('C', 0.9), 200)]);
  assert('chain: the bullet that left the first body reaches the next, then leaves that one too',
    receivedIds(received) === 'B,C' && ids(result.hits) === 'B,C', receivedIds(received));
  assert('chain: the first token behind gets what left the first body as it is (no falloff)',
    near(energyOf(received[0].carry), 40) && near(damageOf(received[0].carry), 10), received[0].carry);
  assert('chain: the third token gets what left the second one',
    near(energyOf(received[1].carry), 40 * 0.5) && damageOf(received[1].carry) < 10, received[1].carry);
  assert('chain: when the last body is left and nothing is behind, the bullet flies to the end of the segment',
    result.end.reason === 'range', result.end);
}
{
  const { result, received } = await follow([at(token('B', 0.9), 100), at(token('C', 0.9), 200)], { stays: ['B'] });
  assert('chain: ends at the body the bullet does not leave — nothing behind it is reached',
    receivedIds(received) === 'B' && ids(result.hits) === 'B' && result.end.reason === 'spent',
    { hits: ids(result.hits), end: result.end });
}
{
  const { result, received } = await follow([at(token('B', 0.9), 100)], { exit: bullet(MIN_CARRY_DAMAGE / 2) });
  assert('chain: a bullet below what an injury can store is spent — no delivery, no hits',
    received.length === 0 && result.hits.length === 0 && result.end.reason === 'spent');
}
{
  const { result, received } = await follow([at(token('B', 0.9), 100)], { exit: [] });
  assert('chain: nothing left the body → nothing happens', received.length === 0 && result.end.reason === 'spent');
}
{
  const { result, received } = await follow([]);
  assert('chain: nothing behind the body → no hits, the bullet reaches the end of the segment',
    received.length === 0 && result.hits.length === 0 && result.end.reason === 'range');
}
{
  const { received } = await follow([at(token('B', 0.9), 100), at(token('C', 0.9), 200)], {
    level: 0.8,
    levels: { B: 0.4, C: 0.1 },
    exitShare: 1,
  });
  assert('chain: the falloff is the ratio of the levels (0.4 / 0.8 = half the energy reaches B)',
    near(energyOf(received[0].carry), 40 * 0.5), received[0].carry);
  assert('chain: the next hop starts from the level of the body the bullet left (0.1 / 0.4)',
    near(energyOf(received[1].carry), 40 * 0.5 * 0.25), received[1].carry);
}
{
  // The first body behind flies past (confidence does not beat its resistance); the second is hit.
  const { result, received, st } = await follow([at(token('B', 0.9), 100), at(token('C', 0.9), 200)], {
    judgeToken: (c) => ({ pass: c.object.id === 'B', details: { why: 'resisted' } }),
  });
  assert('chain: a token the bullet flies past is recorded as passed and skipped',
    receivedIds(received) === 'C' && ids(result.hits) === 'C' && passedIds(st) === 'B'
    && st.passedThrough[0].details.why === 'resisted',
    { received: receivedIds(received), passed: passedIds(st) });
}
{
  // A wall that holds the bullet: the tokens behind it are never reached, only the walls met are recorded.
  const stopWall = { ...at(wall(), 150), point: { x: 150, y: 0 } };
  const events = [
    { entryDistance: 150, penetrated: false, reason: 'stopped' },
    { entryDistance: 400, penetrated: false, reason: 'stopped' },
  ];
  const { result, received } = await follow([at(token('B', 0.9), 100), stopWall, at(token('C', 0.9), 200)], {
    planWalls: () => ({
      events,
      stepFor: (c) => (c === stopWall ? { blocks: true, blockCollision: stopWall } : null),
      carryAt: () => null,
    }),
  });
  assert('chain: a wall that holds ends the flight; the token behind it is not reached',
    receivedIds(received) === 'B' && result.hits.at(-1) === stopWall && result.end.reason === 'wall',
    { hits: ids(result.hits), end: result.end });
  assert('chain: only the walls the bullet met are recorded',
    result.wallEvents.length === 1 && result.wallEvents[0].entryDistance === 150, result.wallEvents);
}
{
  // A wall that is passed: the plan is built for the bullet that is left (not the muzzle projectile) and
  // the token behind gets the plan's carry as it is.
  const w = at(wall(), 150);
  const seen = [];
  const walled = bullet(4, 12);
  const { result, received } = await follow([w, at(token('B', 0.9), 200)], {
    exit: bullet(10),
    level: 0.7,
    levels: { B: 0.35 },
    planWalls: (collisions, applications, level) => {
      const walls = collisions.filter((c) => c.type === 'wall').length;
      seen.push({ walls, applications, level });
      if (!walls) return null; // behind the token reached there are no walls left to plan
      return {
        events: [{ entryDistance: 150, penetrated: true }],
        stepFor: (c) => (c === w ? { blocks: false } : null),
        carryAt: (d) => (d >= 150 ? walled : null),
      };
    },
  });
  assert('chain: the walls behind the body are run with the projectile that is left of it, at its falloff level',
    seen.length >= 1 && seen[0].walls === 1 && damageOf(seen[0].applications) === 10 && seen[0].level === 0.7, seen);
  assert('chain: the token behind a passed wall gets the carry of the plan (falloff already in it)',
    received.length === 1 && received[0].carry === walled && result.wallEvents.length === 1, received);
}
{
  // Each hop plans the walls of what is behind the previous body only.
  const seen = [];
  await follow([at(token('B', 0.9), 100), at(wall(), 150), at(token('C', 0.9), 200)], {
    planWalls: (collisions) => {
      seen.push(collisions.map((c) => c.object.id).join(','));
      return null;
    },
    exitShare: 1,
  });
  assert('chain: each hop plans only what is behind the previous body', seen.length >= 1 && seen[0] === 'B,wall,C', seen);
}

if (failed) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll hit-luck tests passed');

/**
 * Integration smoke test: how `AimingManager#_resolveHitImpacts` turns the geometry's centrality into
 * the energy that reaches the target and into the crit effect (hit-quality.mjs), and how a volley and a
 * blast become wounds (`_resolveVolleyImpacts`). Runs in plain Node with
 * stubbed Foundry globals and a stub target actor that records what it was asked to apply. Execute with:
 *   node module/helpers/aiming-hit-quality.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

class Stub {
  static get documentName() { return 'Stub'; }
}
globalThis.Item = Stub;
globalThis.Actor = Stub;
globalThis.Hooks = { on() {}, once() {}, call() {}, callAll() {} };
globalThis.foundry = {
  utils: {
    escapeHTML: (s) => String(s),
    randomID: () => Math.random().toString(36).slice(2, 10),
    mergeObject: (a, b) => ({ ...a, ...b }),
    deepClone: (o) => JSON.parse(JSON.stringify(o)),
  },
  applications: { api: { ApplicationV2: Stub, HandlebarsApplicationMixin: (c) => c }, sheets: { ItemSheetV2: Stub, ActorSheetV2: Stub } },
};
globalThis.game = {
  i18n: { localize: (k) => k, format: (k) => k },
  settings: { get() { throw new Error('no settings in this test'); } },
  spaceholder: {},
};
globalThis.CONFIG = { SPACEHOLDER: {} };
globalThis.canvas = {};
globalThis.PIXI = {};

const { AimingManager } = await import('./aiming-manager.mjs');
const { ShotManager } = await import('./shot-manager.mjs');
const { CRIT_EFFECTS } = await import('./hit-quality.mjs');

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* -------------------------------------------- */
/*  Fixtures                                    */
/* -------------------------------------------- */

const shotManager = new ShotManager();
game.spaceholder.shotManager = shotManager;

const manager = new AimingManager();
manager.currentToken = { name: 'Ann', actor: { uuid: 'Actor.ann', name: 'Ann' } };

const PROJECTILE = {
  damage: 10,
  damageType: 'ballistic',
  armorPen: 2,
  hardness: 1,
  applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2, hardness: 1, energy: 40 }] }],
};

/** A target that records the damage packages it is asked to apply. */
function makeTarget({ override = '' } = {}) {
  const calls = [];
  const bodyParts = {
    head: { id: 'head', displayName: 'Head', maxHp: 10 },
    torso: { id: 'torso', displayName: 'Torso', maxHp: 40 },
    arm: { id: 'arm', displayName: 'Arm', maxHp: 20 },
  };
  return {
    calls,
    isOwner: true,
    uuid: 'Actor.orc',
    name: 'Orc',
    system: {
      health: { bodyParts },
      anatomy: {
        hitGroupOverride: override,
        groups: [
          { id: 'g-head', type: 'critical', name: 'Head group', parts: ['head'] },
          { id: 'g-body', type: 'movement', name: 'Body group', parts: ['torso', 'arm'] },
        ],
      },
    },
    async applyDamagePackage(args) {
      calls.push(args);
      return { slotRef: args.partId, bodyDamage: [{ type: 'ballistic', amount: 5 }] };
    },
  };
}

let shotCounter = 0;
/** Register a shot with the given token hits and resolve it. */
async function resolve(hits, { critEffect, projectile = PROJECTILE } = {}) {
  const uid = `test_shot_${shotCounter += 1}`;
  const shot = shotManager.shotSystem.registerShot(uid);
  shot.actualHits = hits;
  const impacts = await manager._resolveHitImpacts(uid, { projectile, critEffect });
  return impacts;
}

const lineHit = (target, details) => ({
  type: 'token',
  object: { actor: target, name: target.name, document: { uuid: 'Token.orc' } },
  details: { clock: 12, ...details },
});

/* -------------------------------------------- */
/*  Cases                                       */
/* -------------------------------------------- */

{
  const target = makeTarget();
  const [impact] = await resolve([lineHit(target, { centrality: 0.8 })], { critEffect: CRIT_EFFECTS.PICK_PART });
  assert('full zone: no energy lost, the projectile is passed on as it is',
    impact.quality === 'full' && impact.energyScale === 1 && impact.crit === false
    && target.calls.length === 1 && target.calls[0].projectile === PROJECTILE && !('applications' in target.calls[0]),
    { impact, call: Object.keys(target.calls[0] ?? {}) });
  assert('no armorScale any more', !('armorScale' in target.calls[0]));
}
{
  const target = makeTarget({ override: 'g-head' });
  const [impact] = await resolve([lineHit(target, { centrality: 0.98 })], { critEffect: CRIT_EFFECTS.PICK_PART });
  assert('bullseye with a part-picking mode: the marked group is hit',
    impact.crit === true && impact.quality === 'crit' && impact.pickedGroup === 'Head group' && target.calls[0].partId === 'head', { impact, partId: target.calls[0]?.partId });
  assert('a crit keeps full energy', impact.energyScale === 1 && target.calls[0].projectile === PROJECTILE);
}
{
  const target = makeTarget({ override: 'g-head' });
  const [impact] = await resolve([lineHit(target, { centrality: 0.98 })], { critEffect: CRIT_EFFECTS.NONE });
  assert('bullseye in a mode with no crit effect (automatic fire): still a crit, but nothing is picked',
    impact.crit === true && !('pickedGroup' in impact), impact);
}
{
  let pickedHead = 0;
  for (let i = 0; i < 40; i += 1) {
    const target = makeTarget({ override: 'g-head' });
    await resolve([lineHit(target, { centrality: 0.8 })], { critEffect: CRIT_EFFECTS.PICK_PART });
    if (target.calls[0].partId === 'head') pickedHead += 1;
  }
  assert('a hit outside the bullseye never takes the marked group by itself (random group: head not every time)',
    pickedHead < 40, pickedHead);
}
{
  const target = makeTarget({ override: 'g-head' });
  const [impact] = await resolve([lineHit(target, { centrality: 0.98 })]);
  assert('without a crit effect given (debug shot) nothing is picked', !('pickedGroup' in impact), impact);
}
{
  const target = makeTarget();
  // fullZone 30% / edge 10% by default: centrality 0.35 is 65% of the way from the full zone to the edge
  const [impact] = await resolve([lineHit(target, { centrality: 0.35 })], { critEffect: CRIT_EFFECTS.PICK_PART });
  const item = target.calls[0].applications?.[0]?.items?.[0];
  assert('glancing hit: the energy is cut, the damage follows it (armorDamageReduction defaults to 100%)',
    impact.quality === 'glancing' && near(impact.energyScale, 0.55) && !!item
    && near(item.energy, 40 * 0.55) && near(item.damage, 10 * 0.55) && !('projectile' in target.calls[0]),
    { impact, item });
  assert('glancing hit keeps armorPen and hardness as authored', item && item.armorPen === 2 && item.hardness === 1);
}
{
  const target = makeTarget();
  const [impact] = await resolve([lineHit(target, { centrality: 0 })]);
  assert('the very edge: only the edge energy is left', near(impact.energyScale, 0.1), impact);
}
{
  const target = makeTarget();
  const carry = [{ mode: 'parallel', items: [{ type: 'ballistic', damage: 6, armorPen: 2, energy: 20 }] }];
  const [impact] = await resolve([lineHit(target, { centrality: 0.35, carry })]);
  const item = target.calls[0].applications?.[0]?.items?.[0];
  assert('after walls: the carried projectile is the one that gets cut',
    near(impact.energyScale, 0.55) && item && near(item.energy, 20 * 0.55) && near(item.damage, 6 * 0.55), { impact, item });
}
{
  const target = makeTarget();
  const carry = [{ mode: 'parallel', items: [{ type: 'ballistic', damage: 6, armorPen: 2, energy: 20 }] }];
  await resolve([lineHit(target, { centrality: 0.9, carry })]);
  assert('after walls, full hit: the carried projectile as it is', target.calls[0].applications === carry);
}
{
  const target = makeTarget();
  const [impact] = await resolve([lineHit(target, {})]);
  assert('a blow with no centrality (plain melee): full energy, no crit, no centrality in the log',
    impact.energyScale === 1 && impact.crit === false && impact.centrality === undefined && impact.quality === 'full', impact);
}
{
  const target = makeTarget();
  const [impact] = await resolve([{
    type: 'token',
    object: { actor: target, name: 'Orc', document: { uuid: 'Token.orc' } },
    details: { area: true, clock: 3, coverage: 0.5, coverageMode: 'proportional', effectScale: 0.5 },
  }]);
  const item = target.calls[0].applications?.[0]?.items?.[0];
  assert('AoE hit: no quality, the damage is thinned by coverage only',
    impact.outcome === 'area' && !('energyScale' in impact) && item && near(item.damage, 5), { impact, item });
}
{
  const impacts = await resolve([lineHit(makeTarget(), { centrality: 0.7 })], { projectile: { applications: [] } });
  assert('a projectile with no damage spec is only recorded, nothing is applied',
    impacts.length === 1 && impacts[0].quality === 'full');
}

/* -------------------------------------------- */
/*  Volleys and blasts                          */
/* -------------------------------------------- */

globalThis.canvas = { grid: { size: 100, distance: 1 } };
/** Register one shot per ray (origin at 0,0) with the given hits. */
function volley(hitsPerRay) {
  return hitsPerRay.map((hits) => {
    const uid = `test_shot_${shotCounter += 1}`;
    const shot = shotManager.shotSystem.registerShot(uid);
    shot.origin = { x: 0, y: 0 };
    shot.actualHits = hits;
    return uid;
  });
}
const pellet = (target, tokenObject, x) => ({ ...lineHit(target, { centrality: 0.9 }), object: tokenObject, point: { x, y: 0 } });
{
  // 6 pellets, 20° fan, 50 px = 0.5 m away: the fan is ~0.18 m wide — one wound.
  const target = makeTarget();
  const tokenObject = { actor: target, name: 'Orc', document: { uuid: 'Token.orc' } };
  const uids = volley(Array.from({ length: 6 }, () => [pellet(target, tokenObject, 50)]));
  const impacts = await manager._resolveVolleyImpacts(uids, { projectile: PROJECTILE }, { coneDegrees: 20 });
  const call = target.calls[0];
  assert('tight volley: the pellets make one wound (one damage package)', target.calls.length === 1, target.calls.length);
  assert('tight volley: all six pellets go in as one parallel phase', call?.applications?.[0]?.mode === 'parallel' && call.applications[0].items.length === 6, call?.applications);
  assert('tight volley: the other pellets are logged as the same wound',
    impacts.slice(1).every((list) => list[0]?.joined === true && list[0].partName === impacts[0][0].partName), impacts.map((l) => l[0]));
}
{
  // The same fan 10 m away is ~3.5 m wide: every pellet is its own wound.
  const target = makeTarget();
  const tokenObject = { actor: target, name: 'Orc', document: { uuid: 'Token.orc' } };
  const uids = volley(Array.from({ length: 3 }, () => [pellet(target, tokenObject, 1000)]));
  await manager._resolveVolleyImpacts(uids, { projectile: PROJECTILE }, { coneDegrees: 20 });
  assert('wide volley: each pellet is a wound of its own', target.calls.length === 3, target.calls.length);
}
{
  // A blast reaches three different parts, its energy split among them.
  const target = makeTarget();
  const [uid] = volley([[{
    type: 'token',
    object: { actor: target, name: 'Orc', document: { uuid: 'Token.orc' } },
    details: { area: true, blast: true, clock: 12, coverage: 1, coverageMode: 'any', effectScale: 1 },
  }]]);
  const [[impact]] = await manager._resolveVolleyImpacts([uid], { projectile: PROJECTILE });
  const parts = target.calls.map((c) => c.partId);
  const item = target.calls[0]?.applications?.[0]?.items?.[0];
  assert('blast: three different body parts are hit', parts.length === 3 && new Set(parts).size === 3, parts);
  assert('blast: each part gets a third of the energy', item && near(item.energy, 40 / 3) && near(item.damage, 10 / 3), item);
  assert('blast: the log names every part and sums the damage', impact.partName.split(', ').length === 3 && near(impact.damage[0].amount, 15), impact);
}

/* -------------------------------------------- */
/*  A bullet that leaves a body flies on        */
/* -------------------------------------------- */

const fs = await import('node:fs');
const { resolveBodyTraversal } = await import('./damage/body-traversal-resolver.mjs');
const { normalizeApplications } = await import('./damage/damage-resolver.mjs');
const { TEST_MATERIAL_FIXTURES } = await import('./damage/__fixtures__/test-materials.mjs');
const { createAttackLog } = await import('./weapon/attack-log.mjs');
const humanoid = JSON.parse(fs.readFileSync(new URL('../../data/anatomy/humanoid.json', import.meta.url), 'utf8'));

const bulletOf = (damage, armorPen) => {
  const items = [{ type: 'ballistic', damage, armorPen, hardness: 1, armorDamageFactor: 1, energy: damage * armorPen * armorPen }];
  return { damage, damageType: 'ballistic', armorPen, hardness: 1, applications: [{ mode: 'sequential', items }] };
};
/** Relative strengths only: a pistol round and a heavy rifle round (test values, not the compendium's). */
const NINE = bulletOf(100, 0.25);
const BMG = bulletOf(280, 1.1);
const energyOf = (apps) => normalizeApplications(apps).flatMap((p) => p.items).reduce((s, i) => s + (i.energy ?? 0), 0);
const resolveTest = (id) => TEST_MATERIAL_FIXTURES[id] ?? null;

/** What the real traversal lets out of `part` of a humanoid for `applications`. */
function exitOf(part, applications) {
  const bodyParts = JSON.parse(JSON.stringify(humanoid.bodyParts));
  return resolveBodyTraversal({
    anatomy: { bodyParts }, startSlotRef: part, hitDirection: 'front', applications,
    resolveMaterial: resolveTest, random: () => 0.5,
  }).exitApplications;
}

/** A target with a real humanoid body, hit in `part` only: its damage goes through the real traversal. */
function makeBody(name, part = 'upperTorso') {
  const calls = [];
  const bodyParts = JSON.parse(JSON.stringify(humanoid.bodyParts));
  return {
    calls,
    isOwner: true,
    uuid: `Actor.${name}`,
    name,
    system: {
      health: { bodyParts },
      anatomy: { hitGroupOverride: '', groups: [{ id: 'g', type: 'critical', name: 'Group', parts: [part] }] },
    },
    async applyDamagePackage(args) {
      calls.push(args);
      const applications = args.applications ?? normalizeApplications(args.projectile.applications);
      const out = resolveBodyTraversal({
        anatomy: { bodyParts }, startSlotRef: args.partId, hitDirection: args.hitDirection ?? 'front', applications,
        resolveMaterial: resolveTest, random: () => 0.5,
      });
      return { slotRef: args.partId, bodyDamage: out.bodyDamageBySlot[args.partId] ?? [], exitApplications: out.exitApplications };
    },
  };
}

const tokenAt = (target, x) => ({
  type: 'token',
  object: { actor: target, name: target.name, document: { uuid: `Token.${target.name}` } },
  point: { x, y: 0 },
  distance: x,
  details: { centrality: 0.8, clock: 12 },
});
const wallAt = (x, id = 'wall') => ({ type: 'wall', object: { id }, point: { x, y: 0 }, distance: x, details: {} });

const RANGE_END = { x: 2000, y: 0 };
/** Register the ray of one shot as the shot manager leaves it: the first token hit, the rest in the tail. */
function ray(collisions, projectile) {
  const uid = `test_shot_${shotCounter += 1}`;
  const shot = shotManager.shotSystem.registerShot(uid);
  shot.origin = { x: 0, y: 0 };
  shot.falloff = { enabled: false, halfDistance: 0 };
  shot.penetration = { applications: projectile.applications, energyLevel: 1 };
  shot.record = { v: 1, id: uid, t: 1.7e12, sceneId: 'scene', paths: [{ type: 'line', start: { x: 0, y: 0 }, end: collisions[0].point }] };
  shot.actualHits = [collisions[0]];
  shotManager._keepTail(shot, collisions[0], collisions, { x: 0, y: 0 }, RANGE_END);
  return { uid, shot };
}

{
  const a = makeBody('A');
  const b = makeBody('B');
  const { uid, shot } = ray([tokenAt(a, 100), tokenAt(b, 150)], NINE);
  const [impacts] = await manager._resolveVolleyImpacts([uid], { projectile: NINE });
  assert('9x19 through an unarmoured torso: it stays in the body, the token right behind is not touched',
    a.calls.length === 1 && b.calls.length === 0 && impacts.length === 1 && !impacts[0].exit && !shot.extension,
    { a: a.calls.length, b: b.calls.length, impacts });
}
{
  const a = makeBody('A');
  const b = makeBody('B');
  const { uid, shot } = ray([tokenAt(a, 100), tokenAt(b, 150)], BMG);
  const left = exitOf('upperTorso', BMG.applications);
  const [impacts] = await manager._resolveVolleyImpacts([uid], { projectile: BMG });
  assert('.50 BMG through the torso: the token behind is hit with what left the first body',
    b.calls.length === 1 && Math.abs(energyOf(b.calls[0].applications) - energyOf(left)) < 1e-9 && energyOf(left) > 0,
    { b: b.calls.length, got: energyOf(b.calls[0]?.applications), left: energyOf(left) });
  assert('the heavy round reaches the token behind with more than the pistol round (nothing)',
    energyOf(b.calls[0]?.applications) > 0 && energyOf(left) > energyOf(exitOf('upperTorso', NINE.applications)));
  assert('log: the second hit follows the first in the ray\'s impacts, marked as through the first target',
    impacts.length === 2 && impacts[1].name === 'B' && impacts[1].through === 'A' && !impacts[0].through, impacts);
  assert('log: the target the bullet left carries the damage that went on',
    near(impacts[0].exit, left.flatMap((p) => p.items).reduce((s, i) => s + i.damage, 0)) && impacts[1].partName, impacts);
  assert('log: the second target\'s hit is a full impact record (quality, damage)',
    impacts[1].quality === 'full' && Array.isArray(impacts[1].damage), impacts[1]);
  assert('the ray records the token it went through as a hit', shot.actualHits.length === 2 && shot.actualHits[1].object.name === 'B');

  const out = shot.extension;
  assert('trail: the rest of the trail is a record of its own, stamped as the shot',
    out && out.id === `${uid}.x` && out.t === shot.record.t && out.sceneId === 'scene', out);
  const secondLeft = exitOf('upperTorso', b.calls[0].applications);
  const path = out?.paths ?? [];
  assert('trail: it starts where the bullet left the first target and reaches the second',
    path[0]?.start.x === 100 && path[0]?.end.x === 150 && out.hits[0]?.point.x === 150, path);
  assert('trail: the bullet flies on to the end of the segment only if it left the second body too',
    secondLeft.length ? path.at(-1)?.end.x === RANGE_END.x : path.length === 1, { path, left: secondLeft });

  const rays = [manager._collectRay(uid, impacts, { autoRender: true })];
  const session = { log: createAttackLog() };
  const entry = manager._logShot(session, rays);
  assert('attack log: both records of the ray are kept, in order',
    entry.records.length === 2 && entry.records[0].id === uid && entry.records[1].id === `${uid}.x`, entry.records.map((r) => r.id));
  const quiet = manager._collectRay(uid, impacts, { autoRender: false });
  assert('without «auto render» the continuation is stored quiet too', quiet.record.quiet === true && quiet.extension.quiet === true);
}
{
  // Three in a line: the heavy round goes through a torso into a thin limb, and out of it too.
  const a = makeBody('A');
  const b = makeBody('B', 'leftArm');
  const c = makeBody('C');
  const { uid, shot } = ray([tokenAt(a, 100), tokenAt(b, 150), tokenAt(c, 200)], BMG);
  const first = exitOf('upperTorso', BMG.applications);
  const second = exitOf('leftArm', first);
  const [impacts] = await manager._resolveVolleyImpacts([uid], { projectile: BMG });
  assert('the next target is fed the previous target\'s exit, in flight order',
    b.calls.length === 1 && near(energyOf(b.calls[0].applications), energyOf(first))
    && (second.length ? c.calls.length === 1 && near(energyOf(c.calls[0].applications), energyOf(second)) : c.calls.length === 0),
    { b: b.calls.length, c: c.calls.length });
  assert('the impacts of the ray follow the flight', impacts.map((i) => i.name).join(',') === (second.length ? 'A,B,C' : 'A,B'), impacts.map((i) => i.name));
  assert('each target is marked as through the one before it',
    impacts[1].through === 'A' && (impacts[2] ? impacts[2].through === 'B' : true));
  void shot;
}
{
  // A glancing hit on the second target cuts what reaches it; its energy goes into the same law as any hit.
  const a = makeBody('A');
  const b = makeBody('B');
  const second = tokenAt(b, 150);
  second.details.centrality = 0.35; // 55% energy (see the glancing case above)
  const { uid } = ray([tokenAt(a, 100), second], BMG);
  const left = exitOf('upperTorso', BMG.applications);
  const [impacts] = await manager._resolveVolleyImpacts([uid], { projectile: BMG });
  assert('the hit quality of the second target scales what the first one let out',
    impacts[1]?.quality === 'glancing' && near(energyOf(b.calls[0]?.applications), energyOf(left) * 0.55), {
      q: impacts[1]?.quality, got: energyOf(b.calls[0]?.applications), left: energyOf(left),
    });
}
{
  // Walls behind the first body are run with the bullet that is left of it, and the token behind a wall that
  // is passed gets what the wall let through.
  const a = makeBody('A');
  const b = makeBody('B');
  const w = wallAt(120);
  const halved = [{ mode: 'parallel', items: [{ type: 'ballistic', damage: 50, armorPen: 1.1, hardness: 1, energy: 60 }] }];
  const { uid, shot } = ray([tokenAt(a, 100), w, tokenAt(b, 150)], BMG);
  const left = exitOf('upperTorso', BMG.applications);
  const original = shotManager._planWallPasses;
  const planned = [];
  shotManager._planWallPasses = (s, start, end, collisions, onHit, projectile) => {
    const walls = collisions.filter((c) => c.type === 'wall').length;
    planned.push({ onHit, projectile, walls });
    if (!walls) return null;
    return {
      events: [{ material: '', entryDistance: 120, entryPoint: { x: 120, y: 0 }, exitPoint: { x: 122, y: 0 }, penetrated: true }],
      stepFor: (c) => (c === w ? { blocks: false } : null),
      carryAt: (d) => (d >= 120 ? halved : null),
      levelAt: () => 1,
    };
  };
  try {
    await manager._resolveVolleyImpacts([uid], { projectile: BMG });
  } finally {
    shotManager._planWallPasses = original;
  }
  const forWall = planned.find((p) => p.walls > 0);
  assert('walls behind the first body are planned for the bullet that is left of it, as a straight-ahead (stop) walk',
    forWall && forWall.onHit === 'stop' && near(energyOf(forWall.projectile.applications), energyOf(left)) && forWall.projectile.energyLevel === 1,
    planned);
  assert('the token behind a passed wall gets what the wall let through', b.calls.length === 1 && b.calls[0].applications === halved);
  assert('the wall is recorded in the shot and in the rest of the trail',
    shot.wallPasses.length === 1 && shot.extension?.wallPasses?.length === 1, { walls: shot.wallPasses.length, ext: shot.extension?.wallPasses });
  assert('the wall is left of the first hit in the ray: the first hit alone is not duplicated in the record',
    shot.record.paths.length === 1 && shot.extension.paths[0].start.x === 100);
}
{
  // A wall that holds the bullet ends its flight: nothing behind it is reached, the trail ends at the wall.
  const a = makeBody('A');
  const b = makeBody('B');
  const w = wallAt(120);
  const { uid, shot } = ray([tokenAt(a, 100), w, tokenAt(b, 150)], BMG);
  const original = shotManager._planWallPasses;
  shotManager._planWallPasses = (s, start, end, collisions) => (collisions.some((c) => c.type === 'wall') ? {
    events: [{ material: '', entryDistance: 120, entryPoint: { x: 120, y: 0 }, exitPoint: null, penetrated: false, reason: 'stopped' }],
    stepFor: () => ({ blocks: true, blockCollision: w }),
    carryAt: () => null,
    levelAt: () => 1,
  } : null);
  try {
    const [impacts] = await manager._resolveVolleyImpacts([uid], { projectile: BMG });
    assert('a wall that holds the bullet: the token behind it is not hit, the first one still logs the exit',
      b.calls.length === 0 && impacts.length === 1 && impacts[0].exit > 0, { b: b.calls.length, impacts });
    assert('a wall that holds the bullet: the rest of the trail ends at the wall',
      shot.extension?.paths.length === 1 && shot.extension.paths[0].end.x === 120 && shot.extension.hits[0].type === 'wall', shot.extension);
  } finally {
    shotManager._planWallPasses = original;
  }
}
{
  // A token the shot's confidence does not beat flies past in the tail too: logged as a pass, the next one is hit.
  const a = makeBody('A');
  const b = makeBody('B');
  const c = makeBody('C');
  const { uid, shot } = ray([tokenAt(a, 100), tokenAt(b, 150), tokenAt(c, 200)], BMG);
  shot.judgeToken = (collision) => ({ pass: collision.object.name === 'B', details: { confidence: 2, resistance: 3 } });
  const first = exitOf('upperTorso', BMG.applications);
  const [impacts] = await manager._resolveVolleyImpacts([uid], { projectile: BMG });
  assert('the bullet flies past a token it cannot hit and goes on to the next',
    b.calls.length === 0 && c.calls.length === 1 && near(energyOf(c.calls[0].applications), energyOf(first))
    && shot.passedThrough.map((p) => p.object.name).join(',') === 'B', { b: b.calls.length, c: c.calls.length });
  assert('the pass is logged by the ray (the same «flies past» line as for the first target)',
    manager._collectRay(uid, impacts, { autoRender: true }).passes.length === 1);
}
{
  // The damage of the first target is unknown yet (it waits for the GM): nothing goes on.
  const a = makeBody('A');
  a.isOwner = false;
  const b = makeBody('B');
  game.spaceholder.gmActions = { request: async () => ({ status: 'queued', id: 'q1' }) };
  try {
    const { uid, shot } = ray([tokenAt(a, 100), tokenAt(b, 150)], BMG);
    const [impacts] = await manager._resolveVolleyImpacts([uid], { projectile: BMG });
    assert('damage that waits for the GM: the bullet is not played on', b.calls.length === 0 && impacts.length === 1 && !shot.extension, impacts);
  } finally {
    delete game.spaceholder.gmActions;
  }
}
{
  // The GM applied it for a player: what left the body comes back with the result.
  const a = makeBody('A');
  a.isOwner = false;
  const b = makeBody('B');
  const left = exitOf('upperTorso', BMG.applications);
  game.spaceholder.gmActions = {
    request: async () => ({ status: 'done', id: 'd1', result: { slotRef: 'upperTorso', bodyDamage: [], exitApplications: left } }),
  };
  try {
    const { uid } = ray([tokenAt(a, 100), tokenAt(b, 150)], BMG);
    const [impacts] = await manager._resolveVolleyImpacts([uid], { projectile: BMG });
    assert('damage applied by the GM: the bullet goes on with the exit it handed back',
      b.calls.length === 1 && near(energyOf(b.calls[0].applications), energyOf(left)) && impacts.length === 2, impacts);
  } finally {
    delete game.spaceholder.gmActions;
  }
}
{
  // What is left is below what an injury can store: it is no bullet any more.
  const a = makeBody('A');
  const b = makeBody('B');
  const crumb = [{ mode: 'parallel', items: [{ type: 'ballistic', damage: 0.001, armorPen: 0.1, hardness: 1, energy: 0.0001 }] }];
  a.applyDamagePackage = async (args) => {
    a.calls.push(args);
    return { slotRef: args.partId, bodyDamage: [], exitApplications: crumb };
  };
  const { uid, shot } = ray([tokenAt(a, 100), tokenAt(b, 150)], BMG);
  const [impacts] = await manager._resolveVolleyImpacts([uid], { projectile: BMG });
  assert('a leftover below what an injury can store: no exit mark, nothing behind is touched',
    impacts.length === 1 && impacts[0].exit === undefined && b.calls.length === 0 && !shot.extension, impacts);
}
{
  // A ray without a tail (a shot that fell on the first token only, an AoE) keeps the old behaviour.
  const a = makeBody('A');
  const b = makeBody('B');
  const uid = `test_shot_${shotCounter += 1}`;
  const shot = shotManager.shotSystem.registerShot(uid);
  shot.origin = { x: 0, y: 0 };
  shot.actualHits = [tokenAt(a, 100)];
  const [impacts] = await manager._resolveVolleyImpacts([uid], { projectile: BMG });
  assert('no tail: one hit, nothing goes on', a.calls.length === 1 && b.calls.length === 0 && impacts.length === 1 && impacts[0].exit === undefined);
}
{
  // A volley wound (pellets that make one wound) does not go on: it is a package of several rays.
  const a = makeBody('A');
  const b = makeBody('B');
  const rays = [0, 1, 2].map(() => ray([{ ...tokenAt(a, 50), object: tokenAt(a, 50).object }, tokenAt(b, 150)], BMG));
  const shared = rays[0].shot.actualHits[0].object;
  rays.forEach((r) => { r.shot.actualHits[0].object = shared; });
  await manager._resolveVolleyImpacts(rays.map((r) => r.uid), { projectile: BMG }, { coneDegrees: 20 });
  assert('pellets that make one wound do not go on to the token behind', a.calls.length === 1 && b.calls.length === 0, { a: a.calls.length, b: b.calls.length });
}

{
  // The geometry: a `stop` line still ends at the first token, but keeps the rest of the segment as a tail.
  const a = makeBody('A');
  const b = makeBody('B');
  const hits = [tokenAt(a, 100), tokenAt(b, 150), wallAt(180)];
  const segment = { type: 'line', direction: 0, length: 20, onHit: 'stop', collision: { walls: true, tokens: true } };
  const run = (shotSetup) => {
    const uid = `test_shot_${shotCounter += 1}`;
    const shot = shotManager.shotSystem.registerShot(uid);
    shot.origin = { x: 0, y: 0 };
    shotSetup?.(shot);
    const originals = { isHit: shotManager.isHit, ignore: shotManager._shouldIgnoreByDisposition };
    shotManager.isHit = () => hits.map((h) => ({ ...h }));
    shotManager._shouldIgnoreByDisposition = () => false;
    try {
      const result = shotManager.shotSegment(segment, { lastPos: { x: 0, y: 0 }, direction: 0, defSize: 100, whitelist: [], shot, shooterToken: null });
      return { shot, result };
    } finally {
      Object.assign(shotManager, { isHit: originals.isHit, _shouldIgnoreByDisposition: originals.ignore });
    }
  };
  const withBullet = (shot) => { shot.penetration = { applications: BMG.applications, energyLevel: 1 }; };

  const { shot, result } = run(withBullet);
  assert('geometry: the ray still ends at the first token', result.shouldContinue === false && result.endPos.x === 100
    && shot.shotResult.shotPaths.length === 1 && shot.shotResult.shotPaths[0].end.x === 100 && shot.actualHits.length === 1);
  assert('geometry: what is behind it (token, wall) is kept in flight order, with the end of the segment',
    shot.tail?.anchor === shot.actualHits[0] && shot.tail.collisions.map((c) => c.type).join(',') === 'token,wall'
    && shot.tail.collisions[0].distance === 150 && shot.tail.end.x === 2000 && shot.tail.start.x === 0, shot.tail);

  const plain = run().shot;
  assert('geometry: a shot with no projectile keeps no tail (nothing could fly on)', plain.tail === null);
}

if (failed) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll aiming-hit-quality tests passed');

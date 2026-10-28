/**
 * Smoke tests for the penetration shot (all the rays of a trigger pull as one record). Runs in plain Node
 * (no Foundry globals) against the real resolvers:
 *   node module/helpers/damage/penetration-shot.test.mjs
 *
 * The tracks are built the way AimingManager builds them (`assembleRayTrack` over real wall plans and body
 * traversals), so a change to the format that the merge depends on shows up here.
 *
 * Reference numbers (fixtures): bullet damage 10, armorPen 2, hardness 1 → energy 40;
 *   1 unit of steel-plate: eAR 10 → passes (energy 30).
 */

import { resolveBodyTraversal } from './body-traversal-resolver.mjs';
import { ensureLayerDefaults } from './materials-manager.mjs';
import { TEST_MATERIAL_FIXTURES } from './__fixtures__/test-materials.mjs';
import { planWallPasses } from '../walls/wall-penetration.mjs';
import { WALL_KIND, WALL_SIDE } from '../walls/wall-spans.mjs';
import { assembleRayTrack, entryRays, sanitizePenetrationTrack } from './penetration-track.mjs';
import { mergeShot } from './penetration-shot.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const P = (x, y) => ({ x, y });
/** JSON with the keys in order, so two objects with the same content compare equal. */
const canon = (value) => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));
const resolveMaterial = (id) => ({ shell: { materialId: 'shell', hardness: 1, integrityPerThickness: 5, resistance: { ballistic: 50 } } })[id]
  ?? TEST_MATERIAL_FIXTURES[id] ?? null;
const materialName = (slug) => ({ 'steel-plate': 'Steel plate', kevlar: 'Kevlar' }[slug] ?? slug);
const makeLayer = (material, thickness, extra = {}) => ensureLayerDefaults({ material, thickness, ...extra }, resolveMaterial(material));

const TISSUE = { shellThickness: 1, depthFlat: 2, depthShare: 0.5, organDepth: 3 };
const part = (id) => ({ id, material: 'shell', tissue: TISSUE, faces: ['front'], inners: [], relations: [] });
const names = (target, slot = 'chest') => ({
  target,
  partName: (s) => ({ chest: 'Chest', head: 'Head', arm: 'Arm' }[s] ?? s),
  materialName,
  sourceName: (key) => (String(key).startsWith('armor:vest') ? 'Tactical vest' : ''),
});

const pellet = (energy, extra = {}) => ({ type: 'ballistic', damage: 10, armorPen: 2, hardness: 1, energy, ...extra });

function traverse(items, { slot = 'chest', layers = [], mode = 'sequential' } = {}) {
  return resolveBodyTraversal({
    anatomy: { bodyParts: { chest: part('chest'), head: part('head'), arm: part('arm') } },
    startSlotRef: slot,
    applications: [{ mode, items }],
    armorBySlot: layers.length ? { [slot]: [{ itemId: 'vest', coverageIdx: 0, layers }] } : {},
    resolveMaterial,
    random: () => 0.5,
  });
}

let collisionSeq = 0;
function wallEvents(t, thickness = 1) {
  const crossing = {
    collision: { type: 'wall', object: { id: `w${collisionSeq += 1}` }, point: P(t, 0), distance: t, details: {} },
    t, a: P(t, -50), b: P(t, 50), dir: WALL_SIDE.BOTH, kind: WALL_KIND.THIN, material: 'steel-plate', thickness,
  };
  return planWallPasses({
    crossings: [crossing], applications: [{ mode: 'sequential', items: [pellet(40)] }], resolveMaterial,
    rayStart: P(0, 0), rayEnd: P(1000, 0), pxPerThickness: 1,
  }).events;
}

/** A ray's track with one body hit. */
function bodyRay(id, target, { items = [pellet(40)], slot = 'chest', layers = [], lanes, mode, walls, tokenId, parallel, hitIndex = 0, scale } = {}) {
  return assembleRayTrack({
    shotId: id,
    projectile: '12 gauge',
    energy: 40,
    hits: [{
      title: target, index: hitIndex, img: `img/${target}.webp`, tokenId: tokenId ?? target.toLowerCase(), walls: walls ?? [],
      lanes, parallel, scale,
      bodies: [{ result: traverse(items, { slot, layers, mode }), names: names(target) }],
    }],
    names: { materialName },
  });
}

const impactOf = (shotId, name, extra = {}) => ({ outcome: 'hit', shotId, name, tokenUuid: `Scene.s.Token.${name.toLowerCase()}`, partName: 'Chest', ...extra });
const vest = () => [makeLayer('steel-plate', 1)];

/* -------------------------------------------- */
/*  One ray: its own track                       */
/* -------------------------------------------- */

{
  const track = bodyRay('shot_one', 'Bandit', { layers: vest() });
  const merged = mergeShot({ rays: [{ id: 'shot_one', track }], impacts: [impactOf('shot_one', 'Bandit')] });
  const { hit: _hit, ...first } = track.groups[0];
  const group = merged.track.groups[0];
  assert('one ray: the group is the ray\'s own (but for the hit index, which the block replaces with its impacts)',
    merged.track.groups.length === 1 && canon({ ...group, parallel: undefined, streams: undefined }) === canon({ ...first, parallel: undefined }),
    { group, first });
  assert('one ray: no lanes, no lane labels', group.lanes === undefined && group.rays === undefined
    && group.stages.every((s) => s.items.every((i) => i.lane === undefined)));
  assert('one ray: the hit of the ray is the hit of the block', merged.impacts[0].length === 1 && merged.impacts[0][0].shotId === 'shot_one');
  assert('one ray: the projectile, the energy and the id of the track are the ray\'s',
    merged.track.shotId === 'shot_one' && merged.track.projectile === '12 gauge' && merged.track.energy === 40, merged.track);
  assert('one ray: nothing to show → no track', mergeShot({ rays: [{ id: 'r', track: null }], impacts: [] }).track === null
    && mergeShot({}).track === null && mergeShot({ entry: null }).rays.length === 0);
}

/* -------------------------------------------- */
/*  A wound of several pellets (the leader's group has lanes)  */
/* -------------------------------------------- */

{
  // Three pellets in one wound against a steel plate: pellets 0 and 1 are strong enough, 2 is held by the plate.
  const items = [pellet(40, { tag: 0 }), pellet(40, { tag: 1 }), pellet(10, { tag: 2, armorPen: 0.4 })];
  const leader = bodyRay('shot_p0', 'Bandit', { items, mode: 'parallel', layers: vest(), lanes: ['shot_p0', 'shot_p1', 'shot_p2'] });
  const joined = (id) => assembleRayTrack({ shotId: id, projectile: '12 gauge', energy: 40, hits: [{ title: 'Bandit', index: 0, walls: [], bodies: [] }], names: { materialName } });
  const impacts = [
    impactOf('shot_p0', 'Bandit'),
    impactOf('shot_p1', 'Bandit', { joined: true }),
    impactOf('shot_p2', 'Bandit', { joined: true }),
  ];
  assert('wound: the leader\'s group is the wound of three pellets', leader.groups[0].lanes === 3 && leader.groups[0].rays.join() === 'shot_p0,shot_p1,shot_p2', leader.groups[0]);

  const merged = mergeShot({
    rays: [{ id: 'shot_p0', track: leader }, { id: 'shot_p1', track: joined('shot_p1') }, { id: 'shot_p2', track: joined('shot_p2') }],
    impacts,
  });
  const [block] = merged.track.groups;
  assert('wound: one block for the wound, with a lane for each pellet', merged.track.groups.length === 1 && block.lanes === 3
    && block.rays.join() === 'shot_p0,shot_p1,shot_p2' && block.title === 'Bandit' && block.subtitle === 'Chest', merged.track.groups);
  const armour = block.stages.find((s) => s.kind === 'armor');
  assert('wound: the layers are common to the lanes, the items say which pellet each is',
    armour.items.map((i) => `${i.lane}:${i.verdict}`).sort().join() === '0:pass,1:pass,2:hold', armour.items);
  assert('wound: the layer\'s verdict is that someone got through', armour.verdict === 'pass', armour.verdict);
  const tissue = block.stages.find((s) => s.kind === 'tissue');
  assert('wound: the pellet that was held does not reach the tissue', tissue.items.every((i) => i.lane !== 2) && tissue.items.length >= 2, tissue.items);
  assert('wound: the pellets of a wound start together (no carry from the block before)', block.parallel === true);
  assert('wound: the hits of the pellets are the hits of the block, the leader first', merged.impacts[0].length === 3
    && merged.impacts[0].map((i) => i.shotId).join() === 'shot_p0,shot_p1,shot_p2', merged.impacts[0].map((i) => i.shotId));
  assert('wound: all the rays are named', merged.rays.join() === 'shot_p0,shot_p1,shot_p2');
  const copy = sanitizePenetrationTrack(JSON.parse(JSON.stringify(merged.track)));
  assert('wound: the merged track is a track the sanitizer keeps whole', canon(copy.groups[0]) === canon(block), copy?.groups?.[0]);
}

/* -------------------------------------------- */
/*  Pellets that spread: each its own ray, met in the same place */
/* -------------------------------------------- */

{
  const a = bodyRay('shot_a', 'Bandit', { layers: vest() });
  const b = bodyRay('shot_b', 'Bandit', { layers: vest() });
  const c = bodyRay('shot_c', 'Bandit', { slot: 'head' });
  const d = bodyRay('shot_d', 'Bob');
  const merged = mergeShot({
    rays: [{ id: 'shot_a', track: a }, { id: 'shot_b', track: b }, { id: 'shot_c', track: c }, { id: 'shot_d', track: d }],
    impacts: ['shot_a', 'shot_b', 'shot_c'].map((id) => impactOf(id, 'Bandit')).concat(impactOf('shot_d', 'Bob')),
  });
  const titles = merged.track.groups.map((g) => `${g.title}/${g.subtitle}/${g.lanes ?? 1}`);
  assert('spread: pellets in the same part of the same target are one block, the others have their own',
    titles.join() === 'Bandit/Chest/2,Bandit/Head/1,Bob/Chest/1', titles);
  const chest = merged.track.groups[0];
  assert('spread: its lanes are the rays that met it, in the order of the shot', chest.rays.join() === 'shot_a,shot_b', chest.rays);
  assert('spread: every ray\'s item is in the layer it passed, labelled with its lane',
    chest.stages.find((s) => s.kind === 'armor').items.map((i) => i.lane).join() === '0,1');
  assert('spread: the armour piece stays one layer (matched by what it is, not by the ray)',
    chest.stages.filter((s) => s.kind === 'armor').length === 1 && chest.stages[0].source === 'Tactical vest', chest.stages.map((s) => `${s.kind}:${s.source}`));
  assert('spread: a block of one ray has no lanes', merged.track.groups[1].lanes === undefined && merged.track.groups[2].lanes === undefined);
  assert('spread: the hits follow their blocks', merged.impacts.map((list) => list.map((i) => i.shotId).join('+')).join() === 'shot_a+shot_b,shot_c,shot_d',
    merged.impacts.map((list) => list.map((i) => i.shotId)));
  const only = mergeShot({ rays: [{ id: 'shot_a', track: a }, { id: 'shot_d', track: d }], impacts: [impactOf('shot_a', 'Bandit'), impactOf('shot_d', 'Bob')], rayIds: ['shot_d'] });
  assert('spread: a shot can be narrowed to some of its rays', only.track.groups.length === 1 && only.track.groups[0].title === 'Bob');
}

/* -------------------------------------------- */
/*  Walls the rays have in common                */
/* -------------------------------------------- */

{
  const events = wallEvents(100);
  const a = bodyRay('shot_a', 'Bandit', { walls: events });
  const b = bodyRay('shot_b', 'Bob', { walls: wallEvents(120) });
  const merged = mergeShot({
    rays: [{ id: 'shot_a', track: a }, { id: 'shot_b', track: b }],
    impacts: [impactOf('shot_a', 'Bandit'), impactOf('shot_b', 'Bob')],
  });
  const kinds = merged.track.groups.map((g) => `${g.kind}:${g.title ?? ''}:${g.lanes ?? 1}`);
  assert('walls: the wall two rays went through is one block of two lanes; the bodies behind it stay apart',
    kinds.join() === 'wall::2,body:Bandit:1,body:Bob:1', kinds);
  const wall = merged.track.groups[0];
  assert('walls: its items are told apart by lane', wall.stages[0].items.map((i) => i.lane).join() === '0,1', wall.stages[0].items);
  assert('walls: a wall has no hit', merged.impacts[0].length === 0);
  assert('walls: the walls are before the bodies, the bodies after their walls', merged.track.groups.findIndex((g) => g.title === 'Bandit') > 0);
}
{
  // The same wall met twice by one ray (two alike in a row) are two blocks.
  const doubled = assembleRayTrack({
    shotId: 'shot_w', energy: 40,
    hits: [{ title: 'X', index: 0, walls: wallEvents(100), bodies: [] }, { title: 'Y', index: 1, walls: wallEvents(300), bodies: [] }],
    walls: [], names: { materialName },
  });
  const merged = mergeShot({ rays: [{ id: 'shot_w', track: doubled }], impacts: [impactOf('shot_w', 'X'), impactOf('shot_w', 'Y')] });
  assert('walls: two alike walls on one ray stay two blocks', merged.track.groups.filter((g) => g.kind === 'wall').length === 2, merged.track.groups.map((g) => g.kind));
}

/* -------------------------------------------- */
/*  A blast: every target on its own             */
/* -------------------------------------------- */

{
  const blast = assembleRayTrack({
    shotId: 'shot_blast', energy: 40,
    hits: [
      { title: 'Bandit', index: 0, parallel: true, scale: 0.5, tokenId: 'b1', walls: [], bodies: [{ result: traverse([pellet(20)], { layers: vest() }), names: names('Bandit') }, { result: traverse([pellet(20)], { slot: 'arm' }), names: names('Bandit') }] },
      { title: 'Bob', index: 1, parallel: true, scale: 1, tokenId: 'b2', walls: [], bodies: [{ result: traverse([pellet(40)]), names: names('Bob') }] },
    ],
    names: { materialName },
  });
  const merged = mergeShot({
    rays: [{ id: 'shot_blast', track: blast }],
    impacts: [impactOf('shot_blast', 'Bandit', { outcome: 'area' }), impactOf('shot_blast', 'Bob', { outcome: 'area' })],
  });
  assert('blast: a block for every part of every target', merged.track.groups.map((g) => `${g.title}/${g.subtitle}`).join() === 'Bandit/Chest,Bandit/Arm,Bob/Chest',
    merged.track.groups.map((g) => `${g.title}/${g.subtitle}`));
  assert('blast: none continues the one before it', merged.track.groups.every((g) => g.parallel === true));
  assert('blast: each target keeps the share of the blast that reached it', merged.track.groups[0].scale === 0.5 && merged.track.groups[2].scale === undefined);
  assert('blast: the hit of a target is on its first part and on the other parts of the same hit',
    merged.impacts[0][0].name === 'Bandit' && merged.impacts[1][0].name === 'Bandit' && merged.impacts[2][0].name === 'Bob');
}

/* -------------------------------------------- */
/*  A hit with no layers, and a hit that missed  */
/* -------------------------------------------- */

{
  const withBody = bodyRay('shot_x', 'Bob', { hitIndex: 1 });
  const merged = mergeShot({
    rays: [{ id: 'shot_x', track: withBody }],
    impacts: [
      impactOf('shot_x', 'Ghost', { partName: '' }),                  // 0: no damage applied → no group
      impactOf('shot_x', 'Bob'),                                       // 1: the group's
      { outcome: 'miss', shotId: 'shot_x', name: 'Nobody' },           // 2: a projectile that flew past
    ],
  });
  assert('bare: a hit nothing is recorded for is a block of its own, before the later hit it stands before',
    merged.track.groups.map((g) => `${g.title}${g.bare ? '*' : ''}`).join() === 'Ghost*,Bob', merged.track.groups.map((g) => g.title));
  assert('bare: it has no layers and carries its hit', merged.track.groups[0].stages.length === 0 && merged.impacts[0][0].name === 'Ghost');
  assert('bare: a miss is no block', !merged.track.groups.some((g) => g.title === 'Nobody'));
  const noTrack = mergeShot({ rays: [{ id: 'r', track: null }], impacts: [impactOf('r', 'Ghost', { partName: '' })] });
  assert('bare: a shot of hits only (no damage anywhere) still has a track to list them in', noTrack.track?.groups.length === 1 && noTrack.track.groups[0].bare === true, noTrack.track);
  const copy = sanitizePenetrationTrack(JSON.parse(JSON.stringify(merged.track)));
  assert('bare: the sanitizer (what other clients keep of it) leaves only the blocks with layers', copy.groups.map((g) => g.title).join() === 'Bob', copy.groups);
}

/* -------------------------------------------- */
/*  The parts of a target stand together         */
/* -------------------------------------------- */

{
  // Pellets 0 and 2 hit the same target (different parts), pellet 1 another one between them.
  const rays = [
    { id: 'shot_0', track: bodyRay('shot_0', 'Bandit') },
    { id: 'shot_1', track: bodyRay('shot_1', 'Guard') },
    { id: 'shot_2', track: bodyRay('shot_2', 'Bandit', { slot: 'arm' }) },
  ];
  const merged = mergeShot({ rays, impacts: [impactOf('shot_0', 'Bandit'), impactOf('shot_1', 'Guard'), impactOf('shot_2', 'Bandit', { partName: 'Arm' })] });
  assert('target: the blocks of a target stand together on the list, in the order the targets first appear',
    merged.track.groups.map((g) => `${g.title}/${g.subtitle}`).join() === 'Bandit/Chest,Bandit/Arm,Guard/Chest', merged.track.groups.map((g) => `${g.title}/${g.subtitle}`));
  assert('target: the streams are numbered along the list, so a target\'s lanes are side by side',
    merged.track.streams.join() === 'shot_0,shot_2,shot_1' && merged.track.groups.map((g) => g.streams.join()).join('|') === '0|1|2', [merged.track.streams, merged.track.groups.map((g) => g.streams)]);
  assert('target: the hits follow their blocks', merged.impacts.map((list) => list.map((i) => i.shotId).join()).join('|') === 'shot_0|shot_2|shot_1', merged.impacts.map((list) => list.map((i) => i.shotId)));
  const walls = mergeShot({
    rays: [{ id: 'shot_a', track: bodyRay('shot_a', 'Bandit', { walls: wallEvents(100) }) }, { id: 'shot_b', track: bodyRay('shot_b', 'Bandit', { walls: wallEvents(300), slot: 'head' }) }],
    impacts: [impactOf('shot_a', 'Bandit'), impactOf('shot_b', 'Bandit', { partName: 'Head' })],
  });
  assert('target: walls are not parts of a target: each stays a thing of its own, before the target it stands in front of',
    walls.track.groups.map((g) => g.kind).join() === 'wall,body,body', walls.track.groups.map((g) => g.kind));
}

/* -------------------------------------------- */
/*  Streams: the lanes of the whole shot         */
/* -------------------------------------------- */

{
  const one = mergeShot({ rays: [{ id: 'shot_one', track: bodyRay('shot_one', 'Bandit', { layers: vest(), walls: wallEvents(100) }) }], impacts: [impactOf('shot_one', 'Bandit')] });
  const lanesOfBlocks = (merged) => merged.track.groups.map((g) => g.streams.join()).join('|');
  assert('streams: one ray is one stream, whatever it meets', one.track.streams.join() === 'shot_one' && lanesOfBlocks(one) === '0|0', [one.track.streams, lanesOfBlocks(one)]);

  // Three pellets in one wound, the next ray into another target.
  const items = [pellet(40, { tag: 0 }), pellet(40, { tag: 1 }), pellet(40, { tag: 2 })];
  const leader = bodyRay('shot_p0', 'Bandit', { items, mode: 'parallel', layers: vest(), lanes: ['shot_p0', 'shot_p1', 'shot_p2'] });
  const joined = (id) => assembleRayTrack({ shotId: id, energy: 40, hits: [{ title: 'Bandit', index: 0, walls: [], bodies: [] }], names: { materialName } });
  const merged = mergeShot({
    rays: [{ id: 'shot_p0', track: leader }, { id: 'shot_p1', track: joined('shot_p1') }, { id: 'shot_p2', track: joined('shot_p2') }, { id: 'shot_p3', track: bodyRay('shot_p3', 'Bob') }],
    impacts: [impactOf('shot_p0', 'Bandit'), impactOf('shot_p1', 'Bandit', { joined: true }), impactOf('shot_p2', 'Bandit', { joined: true }), impactOf('shot_p3', 'Bob')],
  });
  assert('streams: the pellets of a wound are streams side by side, the numbering follows the list', merged.track.streams.join() === 'shot_p0,shot_p1,shot_p2,shot_p3'
    && lanesOfBlocks(merged) === '0,1,2|3', [merged.track.streams, lanesOfBlocks(merged)]);
}
{
  // The wall two rays went through is a block of both streams; the bodies behind it follow in the order of the rays.
  const a = bodyRay('shot_a', 'Bandit', { walls: wallEvents(100) });
  const b = bodyRay('shot_b', 'Bob', { walls: wallEvents(120) });
  const merged = mergeShot({ rays: [{ id: 'shot_a', track: a }, { id: 'shot_b', track: b }], impacts: [impactOf('shot_a', 'Bandit'), impactOf('shot_b', 'Bob')] });
  assert('streams: a shared block is met by the streams of all the rays that went through it', merged.track.groups.map((g) => g.streams.join()).join('|') === '0,1|0|1', merged.track.groups.map((g) => g.streams));
}
{
  // A blast reaches every target at once: a stream for each target, however few rays there are.
  const blast = assembleRayTrack({
    shotId: 'shot_blast', energy: 40,
    hits: [
      { title: 'Bandit', index: 0, parallel: true, tokenId: 'a', bodies: [{ result: traverse([pellet(20)]), names: names('Bandit') }] },
      { title: 'Bob', index: 1, parallel: true, tokenId: 'b', bodies: [{ result: traverse([pellet(20)]), names: names('Bob') }] },
    ],
    names: { materialName },
  });
  const merged = mergeShot({ rays: [{ id: 'shot_blast', track: blast }], impacts: [impactOf('shot_blast', 'Bandit', { outcome: 'area' }), impactOf('shot_blast', 'Bob', { outcome: 'area' })] });
  assert('streams: the targets of a blast are streams of their own', merged.track.streams.join() === 'shot_blast#0,shot_blast#1'
    && merged.track.groups.map((g) => g.streams.join()).join('|') === '0|1', [merged.track.streams, merged.track.groups.map((g) => g.streams)]);
  assert('streams: nothing to show, no track', mergeShot({}).track === null);
  const copy = sanitizePenetrationTrack(JSON.parse(JSON.stringify(merged.track)));
  assert('streams: the sanitizer keeps the streams of the track and of its groups (what another client lays the lanes out from)',
    copy.streams.join() === 'shot_blast#0,shot_blast#1' && copy.groups.map((g) => g.streams.join()).join('|') === '0|1', copy);
}

/* -------------------------------------------- */
/*  From the log entry                           */
/* -------------------------------------------- */

{
  const a = bodyRay('shot_a', 'Bandit');
  const b = bodyRay('shot_b', 'Bandit');
  const entry = {
    n: 1,
    ids: ['shot_a', 'shot_b', 'shot_c'],
    tracks: [JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))],
    impacts: [impactOf('shot_a', 'Bandit'), impactOf('shot_b', 'Bandit'), { outcome: 'miss', shotId: 'shot_c' }],
  };
  const merged = mergeShot({ entry });
  assert('entry: the rays and hits are read from the log entry (a ray with no track is a ray all the same)',
    merged.rays.join() === 'shot_a,shot_b,shot_c' && merged.track.groups.length === 1 && merged.track.groups[0].lanes === 2, merged);
  assert('entry: a ray of the entry is a ray of the stored shot', entryRays(entry).length === 3);
}

/* -------------------------------------------- */
/*  Limits                                       */
/* -------------------------------------------- */

{
  const rays = Array.from({ length: 24 }, (_, i) => ({ id: `shot_${i}`, track: bodyRay(`shot_${i}`, 'Bandit') }));
  const merged = mergeShot({ rays, impacts: rays.map((r) => impactOf(r.id, 'Bandit')) });
  assert('limits: a block keeps no more lanes than a track can hold', merged.track.groups[0].lanes === 16
    && merged.track.groups[0].stages.every((s) => s.items.every((i) => i.lane < 16)), merged.track.groups[0].lanes);
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll penetration shot assertions passed.');

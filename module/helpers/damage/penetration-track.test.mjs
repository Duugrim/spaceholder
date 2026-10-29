/**
 * Smoke tests for the penetration track. Runs in plain Node (no Foundry globals) against the real resolvers:
 *   node module/helpers/damage/penetration-track.test.mjs
 *
 * The track is built from what `resolveDamagePackage`, `planWallPasses` and `resolveBodyTraversal` really
 * write, so a change to their traces that the view depends on shows up here.
 *
 * Reference numbers (fixtures): bullet damage 10, armorPen 2, hardness 1 → energy 40;
 *   1 unit of steel-plate: eAR 10 → passes, energy 30, damage 7.5.
 */

import { resolveDamagePackage } from './damage-resolver.mjs';
import { resolveBodyTraversal } from './body-traversal-resolver.mjs';
import { ensureLayerDefaults } from './materials-manager.mjs';
import { TEST_MATERIAL_FIXTURES } from './__fixtures__/test-materials.mjs';
import { planWallPasses } from '../walls/wall-penetration.mjs';
import { WALL_KIND, WALL_SIDE } from '../walls/wall-spans.mjs';
import {
  MAX_LANES,
  MAX_TRACKS_PER_LOG,
  applicationsEnergy,
  bodyGroups,
  buildPenetrationTrack,
  assembleRayTrack,
  collectPenetrationTracks,
  energyPercent,
  entryRays,
  findTrackEntry,
  layerStages,
  primaryItem,
  sanitizePenetrationTrack,
  wallStages,
} from './penetration-track.mjs';

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

const CUSTOM = {
  shell: { materialId: 'shell', hardness: 1, integrityPerThickness: 5, resistance: { ballistic: 50 } },
};
const resolveMaterial = (id) => CUSTOM[id] ?? TEST_MATERIAL_FIXTURES[id] ?? null;
const materialName = (slug) => ({ 'steel-plate': 'Steel plate', kevlar: 'Kevlar' }[slug] ?? slug);

const bullet = (over = {}) => [{
  mode: 'sequential',
  items: [{ type: 'ballistic', damage: 10, armorPen: 2, armorDamageFactor: 1, hardness: 1, ...over }],
}];

const makeLayer = (material, thickness, extra = {}) =>
  ensureLayerDefaults({ material, thickness, ...extra }, resolveMaterial(material));

/* -------------------------------------------- */
/*  Energy                                      */
/* -------------------------------------------- */

assert('applicationsEnergy: damage × armorPen² × hardness', near(applicationsEnergy(bullet()), 40));
assert('applicationsEnergy: a precomputed energy wins', near(applicationsEnergy(bullet({ energy: 12 })), 12));
assert('applicationsEnergy: the biggest item of the package',
  near(applicationsEnergy([{ mode: 'parallel', items: [
    { type: 'ballistic', damage: 10, armorPen: 2, hardness: 1 },
    { type: 'thermal', damage: 100, armorPen: 0.1, hardness: 1 },
  ] }]), 40));
assert('applicationsEnergy: nothing to carry → null', applicationsEnergy([]) === null && applicationsEnergy(null) === null);
assert('energyPercent: share of the reference, whole percent',
  energyPercent(46, 50) === 92 && energyPercent(6, 50) === 12 && energyPercent(1, 0) === null && energyPercent('x', 50) === null);

/* -------------------------------------------- */
/*  Layers of a plain stack                     */
/* -------------------------------------------- */

{
  const layers = [makeLayer('steel-plate', 1, { key: 'armor:vest:0:0' }), makeLayer('steel-plate', 2, { key: 'armor:vest:0:1' })];
  const res = resolveDamagePackage({ layers, applications: bullet(), resolveMaterial });
  const stages = layerStages(res.trace, { materialName, sourceName: (key) => (key === 'armor:vest:0:0' ? 'Tactical vest' : '') });

  assert('layerStages: one stage per layer the projectile reached, in order', stages.length === 2
    && stages[0].verdict === 'pass' && stages[1].verdict === 'hold', stages.map((s) => s.verdict));
  const first = stages[0];
  assert('layerStages: a passed layer carries the energy before and after and the damage before and after',
    near(first.items[0].eIn, 40) && near(first.items[0].eOut, 30) && near(first.items[0].dIn, 10) && near(first.items[0].dOut, 7.5),
    first.items);
  assert('layerStages: the layer is named, with its thickness, armour piece and resistance',
    first.name === 'Steel plate' && first.thickness === 1 && first.source === 'Tactical vest' && near(first.resist, 10) && first.kind === 'armor',
    first);
  const second = stages[1];
  assert('layerStages: a layer that holds lets nothing through',
    near(second.items[0].eIn, 30) && second.items[0].eOut === 0 && second.items[0].dOut === 0 && second.resist > 30 && second.thickness === 2,
    second);
  assert('layerStages: wear is kept as a note', first.notes.wear > 0 && first.notes.integrity !== undefined, first.notes);
}

{
  // Two damage types at one layer make one stage with two items; the primary one is the most energetic.
  const res = resolveDamagePackage({
    layers: [makeLayer('steel-plate', 1)],
    applications: [{ mode: 'parallel', items: [
      { type: 'thermal', damage: 5, armorPen: 1, hardness: 1 },
      { type: 'ballistic', damage: 10, armorPen: 2, hardness: 1 },
    ] }],
    resolveMaterial,
  });
  const [stage] = layerStages(res.trace, { materialName });
  assert('layerStages: items of one layer share a stage', res.trace.filter((e) => e.kind === 'penetrate' || e.kind === 'hold').length >= 2
    && stage.items.length >= 2 && layerStages(res.trace).length === 1, stage?.items);
  assert('primaryItem: the item with the most energy entering', primaryItem(stage)?.type === 'ballistic', primaryItem(stage));
}

{
  // A degraded layer that is bypassed shows as a skipped stage.
  const layer = makeLayer('kevlar', 1, { integrity: 0.4 });
  const mat = { ...resolveMaterial('kevlar'), degradation: { ballistic: 'bypass' } };
  const res = resolveDamagePackage({ layers: [layer], applications: bullet(), resolveMaterial: (id) => (id === 'kevlar' ? mat : resolveMaterial(id)) });
  const bypass = res.trace.find((e) => e.kind === 'bypass');
  if (bypass) {
    const [stage] = layerStages(res.trace, { materialName });
    assert('layerStages: a bypassed layer is skipped, not passed', stage.verdict === 'skip' && stage.skip === 'degraded', stage);
  } else {
    assert('layerStages: bypass fixture produced a bypass event', false, res.trace.map((e) => e.kind));
  }
}

{
  // Conducted shock stays a note of the layer.
  const mat = { ...resolveMaterial('steel-plate'), conductance: { ballistic: [{ type: 'concussive', fraction: 0.5 }] } };
  const res = resolveDamagePackage({ layers: [makeLayer('steel-plate', 2)], applications: bullet(), resolveMaterial: () => mat });
  const [stage] = layerStages(res.trace, { materialName });
  assert('layerStages: conduction is a note of the layer that handed it on',
    stage.notes.conduct?.[0]?.type === 'concussive' && stage.notes.conduct[0].amount > 0, stage.notes);
}

/* -------------------------------------------- */
/*  Walls                                       */
/* -------------------------------------------- */

let collisionSeq = 0;
function crossing(t, extra = {}) {
  const collision = { type: 'wall', object: { id: `w${collisionSeq += 1}` }, point: P(t, 0), distance: t, details: {} };
  return {
    collision, t, a: P(t, -50), b: P(t, 50), dir: WALL_SIDE.BOTH, kind: WALL_KIND.THIN, material: 'steel-plate', thickness: 1, ...extra,
  };
}
const planFor = (crossings, applications = bullet()) => planWallPasses({
  crossings, applications, resolveMaterial, rayStart: P(0, 0), rayEnd: P(1000, 0), pxPerThickness: 1,
});

{
  const plan = planFor([crossing(100), crossing(300)]);
  const stages = wallStages(plan.events, { materialName });
  assert('wallStages: every wall passed is a stage, energy draining 40 → 30 → 20', stages.length === 2
    && stages.every((s) => s.kind === 'wall' && s.verdict === 'pass')
    && near(stages[0].items[0].eIn, 40) && near(stages[0].items[0].eOut, 30)
    && near(stages[1].items[0].eIn, 30) && near(stages[1].items[0].eOut, 20), stages);
  assert('wallStages: the wall is named with its thickness', stages[0].name === 'Steel plate' && stages[0].thickness === 1, stages[0]);
}
{
  const plan = planFor([crossing(100, { thickness: 2 })]);
  const [stage] = wallStages(plan.events, { materialName });
  assert('wallStages: the wall that stopped the projectile holds it', stage.verdict === 'hold' && stage.items[0].eOut === 0
    && near(stage.items[0].eIn, 40), stage);
}
{
  const plan = planFor([crossing(100, { material: 'no-such-material' })]);
  const [stage] = wallStages(plan.events, { materialName });
  assert('wallStages: a wall without material data stops the shot outright, with the reason',
    stage.verdict === 'hold' && stage.notes.reason === 'opaque', stage);
}

/* -------------------------------------------- */
/*  A body                                      */
/* -------------------------------------------- */

const TISSUE = { shellThickness: 1, depthFlat: 2, depthShare: 0.5, organDepth: 3 };
const part = (id, over = {}) => ({ id, material: 'shell', tissue: TISSUE, faces: ['front'], inners: [], relations: [], ...over });
const partNames = { target: 'Bandit', partName: (slot) => ({ chest: 'Chest', head: 'Head' }[slot] ?? slot), materialName, innerName: (_slot, id) => `organ ${id}` };

function traverse({ layers = [], applications, inners = [], decide } = {}) {
  return resolveBodyTraversal({
    anatomy: { bodyParts: { chest: part('chest', { inners }) } },
    startSlotRef: 'chest',
    applications,
    armorBySlot: layers.length ? { chest: [{ itemId: 'vest', coverageIdx: 0, layers }] } : {},
    resolveMaterial,
    random: () => 0.5,
    decide,
  });
}

{
  const applications = [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2, hardness: 1, energy: 40 }] }];
  const out = traverse({ layers: [makeLayer('steel-plate', 1, { coverage: 100 })], applications });
  const groups = bodyGroups(out, partNames);
  assert('bodyGroups: one group for the hit part, titled with the target and the part', groups.length === 1
    && groups[0].kind === 'body' && groups[0].title === 'Bandit' && groups[0].subtitle === 'Chest', groups);
  const kinds = groups[0].stages.map((s) => `${s.kind}:${s.verdict}`);
  assert('bodyGroups: the armour in front comes first, then the tissue', kinds[0] === 'armor:pass' && kinds[kinds.length - 1].startsWith('tissue'), kinds);
  const armour = groups[0].stages[0];
  const tissue = groups[0].stages.find((s) => s.kind === 'tissue');
  assert('bodyGroups: the tissue takes the energy the armour let through',
    near(armour.items[0].eOut, 30) && near(tissue.items[0].eIn, 30) && tissue.items[0].eOut < 30 && tissue.notes.deposit > 0, { armour, tissue });
  assert('bodyGroups: the tissue stage is named after the part', tissue.name === 'Chest', tissue.name);
}
{
  // Tissue that keeps the projectile: nothing leaves.
  const stay = { mode: 'sequential', items: [{ type: 'ballistic', damage: 2, armorPen: 1, hardness: 1, energy: 1 }] };
  const out = traverse({ applications: [stay] });
  const [group] = bodyGroups(out, partNames);
  const tissue = group.stages.find((s) => s.kind === 'tissue');
  assert('bodyGroups: a projectile that stays in the tissue holds', tissue.verdict === 'hold' && tissue.items[0].dOut === 0, tissue);
}
{
  // Organs reached are a note of the tissue.
  const applications = [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 30, armorPen: 3, hardness: 1, energy: 270 }] }];
  const out = traverse({ applications, inners: [{ id: 'lung', occupancyPct: 100 }], decide: () => true });
  const [group] = bodyGroups(out, partNames);
  const tissue = group.stages.find((s) => s.kind === 'tissue');
  assert('bodyGroups: the organs hit are named on the tissue', tissue.notes.organs?.[0] === 'organ lung', tissue.notes);
}
{
  // A layer missed through a coverage gap is a skipped stage in its place.
  const layers = [makeLayer('kevlar', 1, { coverage: 100 }), makeLayer('steel-plate', 1, { coverage: 50 })];
  const applications = [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2, hardness: 1, energy: 40 }] }];
  const out = traverse({ layers, applications, decide: ({ kind }) => kind === 'gap' });
  const [group] = bodyGroups(out, partNames);
  const gap = group.stages.find((s) => s.skip === 'gap');
  assert('bodyGroups: a coverage gap is a skipped layer, after the one in front of it',
    gap && gap.verdict === 'skip' && gap.name === 'Steel plate' && group.stages.indexOf(gap) > 0 && gap.notes.coverage === 50, group.stages);
}
{
  // Two parts (the projectile goes on into the part behind): one group each, in visit order.
  const bodyParts = {
    chest: part('chest', { relations: [{ kind: 'behind', target: 'spine', direction: 'front', chance: 100 }] }),
    spine: part('spine', { material: 'shell' }),
  };
  const out = resolveBodyTraversal({
    anatomy: { bodyParts }, startSlotRef: 'chest', resolveMaterial, random: () => 0,
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 40, armorPen: 3, hardness: 1, energy: 360 }] }],
  });
  const groups = bodyGroups(out, { ...partNames, partName: (slot) => slot });
  assert('bodyGroups: the part behind is a group of its own', groups.map((g) => g.subtitle).join() === 'chest,spine', groups.map((g) => g.subtitle));
}

/* -------------------------------------------- */
/*  The track                                   */
/* -------------------------------------------- */

{
  const plan = planFor([crossing(100)]);
  const applications = [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2, hardness: 1, energy: 25 }] }];
  const out = traverse({ layers: [makeLayer('steel-plate', 1)], applications });
  const track = buildPenetrationTrack({
    shotId: 'shot_abc',
    projectile: '9x19',
    energy: 40,
    groups: [
      { kind: 'wall', title: '', stages: wallStages(plan.events, { materialName }) },
      ...bodyGroups(out, partNames),
    ],
  });
  assert('track: carries the shot id, projectile and the muzzle energy', track.shotId === 'shot_abc' && track.projectile === '9x19' && track.energy === 40 && track.v === 1, track);
  assert('track: groups in flight order — wall first, then the body', track.groups[0].kind === 'wall' && track.groups[1].kind === 'body', track.groups.map((g) => g.kind));
  const bodyFirst = track.groups[1].stages[0];
  assert('track: energy lost between the wall and the body (distance, a glancing hit) is marked on the layer',
    near(bodyFirst.lostBefore, 5), bodyFirst);
}
{
  const track = buildPenetrationTrack({
    shotId: 'shot_x',
    groups: [{ kind: 'wall', stages: wallStages(planFor([crossing(100)]).events, { materialName }) }],
  });
  assert('track: without a muzzle energy the reference is what entered the first layer', track.energy === 40, track.energy);
}
assert('track: nothing on the way → no track', buildPenetrationTrack({ shotId: 'shot_x', groups: [] }) === null
  && buildPenetrationTrack({ shotId: '', groups: [{ kind: 'wall', stages: [] }] }) === null);
{
  const track = buildPenetrationTrack({ shotId: 'shot_p', groups: [{ kind: 'body', title: 'Bandit', pending: true, stages: [] }] });
  assert('track: a body whose damage awaits the GM stays on the track as pending', track?.groups[0]?.pending === true, track);
}

/* -------------------------------------------- */
/*  A ray                                       */
/* -------------------------------------------- */

{
  // A wall, then Bandit (armour + tissue), then — the bullet left him — a wall behind, which stopped it.
  const first = planFor([crossing(100)]);
  const behind = planFor([crossing(600, { thickness: 3 })], [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 6, armorPen: 2, hardness: 1, energy: 20 }] }]);
  const applications = [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 7.5, armorPen: 2, hardness: 1, energy: 30 }] }];
  const out = traverse({ layers: [makeLayer('steel-plate', 1)], applications });
  const track = assembleRayTrack({
    shotId: 'shot_ray',
    projectile: '9x19',
    energy: 40,
    hits: [{ title: 'Bandit', walls: first.events, scale: 0.6, quality: 'glancing', bodies: [{ result: out, names: partNames }] }],
    walls: [...first.events, ...behind.events],
    names: { materialName },
  });
  assert('assembleRayTrack: wall in front, the body, then the wall that stopped the bullet', track.groups.map((g) => g.kind).join() === 'wall,body,wall',
    track.groups.map((g) => g.kind));
  assert('assembleRayTrack: a wall met on the way to a token is not listed twice',
    track.groups[0].stages.length === 1 && track.groups[2].stages.length === 1 && track.groups[2].stages[0].verdict === 'hold', track.groups.map((g) => g.stages.length));
  assert('assembleRayTrack: how much of the energy reached the body is on its first group',
    track.groups[1].scale === 0.6 && track.groups[1].quality === 'glancing' && track.groups[1].title === 'Bandit', track.groups[1]);
}
{
  const out = assembleRayTrack({ shotId: 'shot_pending', hits: [{ title: 'Bandit', pending: true, walls: [], bodies: [] }] });
  assert('assembleRayTrack: a hit whose damage awaits the GM is a pending body', out?.groups?.[0]?.pending === true && out.groups[0].title === 'Bandit', out);
  assert('assembleRayTrack: a ray that met nothing has no track', assembleRayTrack({ shotId: 'shot_none', hits: [{ title: 'x', walls: [], bodies: [] }], walls: [] }) === null);
  const blast = assembleRayTrack({
    shotId: 'shot_blast', hits: [{ title: 'Bandit', walls: [], bodies: [
      { result: traverse({ layers: [makeLayer('steel-plate', 1)], applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2, hardness: 1, energy: 40 }] }] }), names: partNames },
      { result: traverse({ applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2, hardness: 1, energy: 40 }] }] }), names: partNames },
    ] }],
  });
  assert('assembleRayTrack: a blast that hit two parts gives a group for each', blast.groups.length === 2 && blast.groups.every((g) => g.title === 'Bandit'), blast.groups.length);
}

/* -------------------------------------------- */
/*  Untrusted data                              */
/* -------------------------------------------- */

{
  const plan = planFor([crossing(100)]);
  const track = buildPenetrationTrack({ shotId: 'shot_rt', projectile: 'P', energy: 40, groups: [{ kind: 'wall', stages: wallStages(plan.events, { materialName }) }] });
  const copy = sanitizePenetrationTrack(JSON.parse(JSON.stringify(track)));
  assert('sanitize: a stored track survives a JSON round trip unchanged', JSON.stringify(copy) === JSON.stringify(track), copy);
}
assert('sanitize: rejects other versions and junk',
  sanitizePenetrationTrack(null) === null && sanitizePenetrationTrack({ v: 2, shotId: 'a', groups: [] }) === null
  && sanitizePenetrationTrack({ v: 1, shotId: '', groups: [] }) === null && sanitizePenetrationTrack({ v: 1, shotId: 'a', groups: 'x' }) === null);
{
  const dirty = sanitizePenetrationTrack({
    v: 1,
    shotId: 'shot_dirty',
    projectile: 'x'.repeat(500),
    energy: 'oops',
    groups: [{
      kind: 'body',
      title: 'T',
      stages: [
        { kind: 'nonsense', items: [] },
        { kind: 'armor', verdict: 'bogus', name: 'N', thickness: -4, items: [{ type: 'a', verdict: 'pass', eIn: 'NaN', eOut: 3 }, null], notes: { wear: 'x', organs: ['liver', 5] } },
      ],
    }],
  });
  const stage = dirty?.groups?.[0]?.stages?.[0];
  assert('sanitize: unknown layers are dropped, text is capped, numbers are checked',
    dirty && dirty.groups[0].stages.length === 1 && dirty.projectile.length <= 120 && dirty.energy === undefined
    && stage.thickness === undefined && stage.items.length === 1 && stage.items[0].eIn === null, dirty);
  assert('sanitize: a verdict that is not one of ours is read from the items', stage.verdict === 'pass', stage.verdict);
}
{
  const many = Array.from({ length: 40 }, () => ({ kind: 'armor', verdict: 'pass', name: 'L', items: [{ type: 'a', verdict: 'pass', eIn: 1, eOut: 1 }] }));
  const track = sanitizePenetrationTrack({ v: 1, shotId: 'shot_big', groups: [{ kind: 'body', stages: many }] });
  assert('sanitize: a long track is capped', track.groups[0].stages.length === 24, track.groups[0].stages.length);
}

/* -------------------------------------------- */
/*  Attack log                                  */
/* -------------------------------------------- */

{
  const track = buildPenetrationTrack({ shotId: 'shot_log', groups: [{ kind: 'wall', stages: wallStages(planFor([crossing(100)]).events, { materialName }) }] });
  const log = { shots: [{ n: 1, tracks: [track, { v: 9 }] }, { n: 2 }, { n: 3, tracks: 'x' }] };
  const found = collectPenetrationTracks(log);
  assert('collectPenetrationTracks: every valid track of the log', found.length === 1 && found[0].shotId === 'shot_log', found);
  assert('collectPenetrationTracks: a log without tracks gives none', collectPenetrationTracks({}).length === 0 && collectPenetrationTracks(null).length === 0);
}
assert('MAX_TRACKS_PER_LOG is a sane cap', MAX_TRACKS_PER_LOG >= 20 && MAX_TRACKS_PER_LOG <= 200);

/* -------------------------------------------- */
/*  Targets: picture, hit, place; rays of a shot */
/* -------------------------------------------- */

{
  const plan = planFor([crossing(100)]);
  const out = traverse({ layers: [makeLayer('steel-plate', 1)], applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2, hardness: 1, energy: 40 }] }] });
  const track = assembleRayTrack({
    shotId: 'shot_where',
    energy: 40,
    hits: [{ title: 'Bandit', index: 0, img: 'tokens/bandit.webp', tokenId: 'tok1', at: { x: 410.04, y: 99.96 }, walls: plan.events, bodies: [{ result: out, names: partNames }] }],
    walls: plan.events,
    names: { materialName },
  });
  const [wall, body] = track.groups;
  assert('assembleRayTrack: a body group carries the hit index, the picture, the token and the place of the hit',
    body.hit === 0 && body.img === 'tokens/bandit.webp' && body.tokenId === 'tok1' && body.at.x === 410 && body.at.y === 100, body);
  assert('assembleRayTrack: a wall group is placed at where the projectile entered the wall', wall.at.x === plan.events[0].entryPoint.x && wall.hit === undefined, wall.at);
  const copy = sanitizePenetrationTrack(JSON.parse(JSON.stringify(track)));
  assert('sanitize: the picture, the hit, the token and the place survive', JSON.stringify(copy) === JSON.stringify(track), copy.groups[1]);
  const dirty = sanitizePenetrationTrack({
    v: 1, shotId: 'x',
    groups: [{ kind: 'body', hit: -1, img: 'javascript:alert(1)', at: { x: 'a', y: 2 }, stages: [{ kind: 'armor', verdict: 'pass', name: 'N', items: [{ type: 'a', verdict: 'pass', eIn: 1, eOut: 1 }] }] }],
  });
  assert('sanitize: a script URL is not a picture, a bad hit index or place is dropped', dirty.groups[0].img === undefined && dirty.groups[0].hit === undefined && dirty.groups[0].at === undefined, dirty.groups[0]);
}
{
  const t = (id) => ({ v: 1, shotId: id, groups: [{ kind: 'wall', stages: [{ kind: 'wall', verdict: 'hold', name: 'W', items: [] }] }] });
  const entry = { n: 1, ids: ['ray_a', 'ray_b'], tracks: [t('ray_b')], records: [{ id: 'ray_a' }, { id: 'ray_a.x' }] };
  const rays = entryRays(entry);
  assert('entryRays: the rays of a shot in order, a track only where the ray has one', rays.map((r) => r.id).join() === 'ray_a,ray_b' && !rays[0].track && rays[1].track.shotId === 'ray_b', rays);
  const old = entryRays({ tracks: [t('r1')], records: [{ id: 'r1' }, { id: 'r2' }, { id: 'r2.x' }] });
  assert('entryRays: without ids they are read from the tracks and the trail records (the continuation of a trail is the same ray)', old.map((r) => r.id).join() === 'r1,r2', old);
  assert('entryRays: nothing for junk', entryRays(null).length === 0 && entryRays({ ids: 5 }).length === 0);
  const logs = [{ shots: [{ n: 1, ids: ['x1'] }] }, { shots: [entry, { n: 2, ids: ['ray_z'] }] }];
  const found = findTrackEntry(logs, 'ray_b');
  assert('findTrackEntry: the entry (and its log) a ray belongs to', found?.entry === entry && found.log === logs[1], found);
  assert('findTrackEntry: a ray that is nowhere, junk', findTrackEntry(logs, 'nope') === null && findTrackEntry(null, 'a') === null && findTrackEntry(logs, '') === null);
}

/* -------------------------------------------- */
/*  Lanes: the pellets of a wound                */
/* -------------------------------------------- */

{
  // Three pellets in one wound (a parallel phase, items tagged by pellet) against a steel plate; the third is too weak.
  const items = [
    { type: 'ballistic', damage: 10, armorPen: 2, hardness: 1, energy: 40, tag: 0 },
    { type: 'ballistic', damage: 10, armorPen: 2, hardness: 1, energy: 40, tag: 1 },
    { type: 'ballistic', damage: 10, armorPen: 0.4, hardness: 1, energy: 10, tag: 2 },
  ];
  const out = traverse({ layers: [makeLayer('steel-plate', 1)], applications: [{ mode: 'parallel', items }] });
  const track = assembleRayTrack({
    shotId: 'p0', energy: 40,
    hits: [{ title: 'Bandit', index: 0, lanes: ['p0', 'p1', 'p2'], parallel: true, bodies: [{ result: out, names: partNames }] }],
  });
  const [group] = track.groups;
  assert('lanes: the group of a wound of several pellets says how many and which rays, and that it does not continue another group',
    group.lanes === 3 && group.rays.join() === 'p0,p1,p2' && group.parallel === true, group);
  const armour = group.stages.find((s) => s.kind === 'armor');
  assert('lanes: the items of a layer say which pellet they are (0 and 1 pass, 2 is held)',
    armour.items.map((i) => `${i.lane}:${i.verdict}`).sort().join() === '0:pass,1:pass,2:hold', armour.items);
  const tissue = group.stages.find((s) => s.kind === 'tissue');
  assert('lanes: the tissue is reached by the pellets that got through', tissue.items.every((i) => [0, 1].includes(i.lane)) && tissue.items.length >= 2, tissue.items);
  const copy = sanitizePenetrationTrack(JSON.parse(JSON.stringify(track)));
  assert('lanes: the sanitizer keeps lanes, rays, parallel and the lane of each item', JSON.stringify(copy.groups[0].rays) === JSON.stringify(group.rays) && copy.groups[0].lanes === 3
    && copy.groups[0].parallel === true && copy.groups[0].stages[0].items.every((i) => Number.isInteger(i.lane)), copy.groups[0]);

  const single = assembleRayTrack({ shotId: 'solo', energy: 40, hits: [{ title: 'Bandit', index: 0, lanes: ['solo'], bodies: [{ result: out, names: partNames }] }] });
  assert('lanes: one pellet is no lanes', single.groups[0].lanes === undefined && single.groups[0].rays === undefined);
}
{
  const stage = { kind: 'armor', verdict: 'pass', name: 'N', items: [{ type: 'a', verdict: 'pass', eIn: 1, eOut: 1, lane: 3 }, { type: 'a', verdict: 'pass', eIn: 1, eOut: 1, lane: 99 }, { type: 'a', verdict: 'pass', eIn: 1, eOut: 1, lane: -1 }, { type: 'a', verdict: 'pass', eIn: 1, eOut: 1, lane: 'x' }] };
  const dirty = sanitizePenetrationTrack({ v: 1, shotId: 's', groups: [{ kind: 'body', lanes: 99, rays: Array.from({ length: 30 }, (_, i) => `r${i}`), stages: [stage] }] });
  const group = dirty.groups[0];
  assert('lanes: a lane out of range or not a number is dropped, the lane count and the rays are capped', group.lanes === MAX_LANES && group.rays.length === MAX_LANES
    && JSON.stringify(group.stages[0].items.map((i) => i.lane)) === JSON.stringify([3, undefined, undefined, undefined]), group);
  const one = sanitizePenetrationTrack({ v: 1, shotId: 's', groups: [{ kind: 'body', lanes: 1, rays: ['a'], stages: [stage] }] });
  assert('lanes: a count of one (or junk) is no lanes, and the rays go with it', one.groups[0].lanes === undefined && one.groups[0].rays === undefined);
}
{
  // The flight loss between a wall and the body behind it is told only where there is one stream to follow.
  const wall = planFor([crossing(100)]);
  const out = traverse({ applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2, hardness: 1, energy: 25 }] }] });
  const serial = assembleRayTrack({ shotId: 'a', energy: 40, hits: [{ title: 'B', index: 0, walls: wall.events, bodies: [{ result: out, names: partNames }] }], names: { materialName } });
  const lanes = assembleRayTrack({ shotId: 'b', energy: 40, hits: [{ title: 'B', index: 0, walls: wall.events, lanes: ['b', 'c'], bodies: [{ result: out, names: partNames }] }], names: { materialName } });
  assert('lanes: the loss before a layer is counted for a body that follows a wall, not for a wound of several projectiles',
    serial.groups[1].stages[0].lostBefore > 0 && lanes.groups[1].stages[0].lostBefore === undefined, [serial.groups[1].stages[0].lostBefore, lanes.groups[1].stages[0].lostBefore]);
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll penetration-track tests passed');

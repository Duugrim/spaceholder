/**
 * Smoke tests for `resolveBodyTraversal`. Runs in plain Node (no Foundry globals):
 *   node module/helpers/damage/body-traversal-resolver.test.mjs
 *
 * 1. **Armour regression**: a part whose tissue keeps everything (no shell, `depthShare` 1) takes exactly
 *    what the armour stack lets through — the traversal agrees with a direct `resolveDamagePackage` call.
 * 2. **Tissue**: the part takes what it absorbs; the damage follows the energy; the rest leaves the body.
 * 3. **Organs**: reach by `organDepth`, chance boosted by the cavity, share of the deposit, concussion.
 * 4. **Exit**: through armour on the far side, into the part behind (no double counting).
 * 5. **Armour coverage** gaps and the armour state of untouched faces.
 * 6. **Blow to the parent part.**
 */

import { resolveDamagePackage } from './damage-resolver.mjs';
import { resolveBodyTraversal, DEFAULT_BODY_MODEL } from './body-traversal-resolver.mjs';
import { ensureLayerDefaults } from './materials-manager.mjs';
import { TEST_MATERIAL_FIXTURES } from './__fixtures__/test-materials.mjs';
import { DEGRADATION_MODES } from './damage-types.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const total = (hits) => (hits ?? []).reduce((s, h) => s + h.amount, 0);
const byType = (hits, type) => (hits ?? []).filter((h) => h.type === type).reduce((s, h) => s + h.amount, 0);

/** Test-only materials next to the shared fixtures. */
const CUSTOM = {
  // Tissue shell: holds 0.5 energy at thickness 1 against everything.
  shell: { materialId: 'shell', hardness: 1, integrityPerThickness: 5, resistance: { ballistic: 50, piercing: 50, cutting: 50, concussive: 50 } },
  // A plate that hands on 40% of what it absorbs as a blow.
  plate: {
    materialId: 'plate', hardness: 10, integrityPerThickness: 50,
    resistance: { ballistic: 100 }, wear: { ballistic: 0 },
    conductance: { ballistic: [{ type: 'concussive', fraction: 0.4 }] },
    selfInduction: { ballistic: [] },
    degradation: { ballistic: DEGRADATION_MODES.REDUCTION },
  },
  // Padding: transparent to projectiles, softens blows.
  pad: { materialId: 'pad', hardness: 1, integrityPerThickness: 10, resistance: {}, damping: { concussive: 0.1 } },
};
const resolveMaterial = (id) => CUSTOM[id] ?? TEST_MATERIAL_FIXTURES[id] ?? null;
const rng = (v) => () => v;

const makeLayer = (materialId, thickness, overrides = {}) =>
  ensureLayerDefaults({ material: materialId, thickness, ...overrides }, resolveMaterial(materialId));

/** One-shot ballistic package with an explicit energy. */
const shot = (damage, energy, extra = {}) => [{ mode: 'sequential', items: [{ type: 'ballistic', damage, armorPen: 0.5, energy, ...extra }] }];

const TISSUE = { shellThickness: 1, depthFlat: 2, depthShare: 0.5, organDepth: 3 };

function part(id, { tissue = TISSUE, faces = ['front'], inners = [], relations = [], material = 'shell' } = {}) {
  return { id, material, tissue, faces, inners, relations };
}

/* ================================================================== *
 *  1. Armour regression                                                *
 * ================================================================== */

const KEEP_ALL = { shellThickness: 0, depthFlat: 0, depthShare: 1, organDepth: 0 };

function runRegression(label, { layers, applications }) {
  const direct = resolveDamagePackage({ layers: layers.map((l) => ({ ...l })), applications, resolveMaterial, random: rng(0.5) });
  const traversal = resolveBodyTraversal({
    anatomy: { bodyParts: { body: part('body', { tissue: KEEP_ALL }) } },
    startSlotRef: 'body',
    applications,
    armorBySlot: { body: [{ itemId: 'item', coverageIdx: 0, layers: layers.map((l) => ({ ...l })) }] },
    resolveMaterial,
    random: rng(0.5),
  });
  const sort = (list) => [...(list ?? [])].sort((a, b) => a.type.localeCompare(b.type)).map((h) => `${h.type}:${h.amount.toFixed(6)}`);
  assert(`${label}: the part takes what the armour let through`,
    JSON.stringify(sort(direct.bodyDamage)) === JSON.stringify(sort(traversal.bodyDamageBySlot.body)),
    `direct=${JSON.stringify(sort(direct.bodyDamage))} traversal=${JSON.stringify(sort(traversal.bodyDamageBySlot.body))}`);
  const strip = (list) => list.map(({ key, ...rest }) => rest);
  assert(`${label}: armour states agree`,
    JSON.stringify(strip(direct.layers)) === JSON.stringify(strip(traversal.armorUpdatesBySlot.body[0].layers)),
    `direct=${JSON.stringify(strip(direct.layers))} traversal=${JSON.stringify(traversal.armorUpdatesBySlot.body[0].layers)}`);
}

runRegression('R1 ballistic vs 1mm steel', { layers: [makeLayer('steel-plate', 1)], applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 200 }] }] });
runRegression('R2 concussive vs kevlar', { layers: [makeLayer('kevlar', 1)], applications: [{ mode: 'sequential', items: [{ type: 'concussive', damage: 10 }] }] });
runRegression('R3 ballistic vs kevlar + foam', { layers: [makeLayer('kevlar', 1), makeLayer('foam', 1)], applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 20 }] }] });
runRegression('R4 piercing armorPen vs kevlar', { layers: [makeLayer('kevlar', 1)], applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 25, armorPen: 5 }] }] });
runRegression('R5 two phases vs steel', {
  layers: [makeLayer('steel-plate', 1)],
  applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 100 }] }, { mode: 'sequential', items: [{ type: 'thermal', damage: 30 }] }],
});
runRegression('R6 parallel volley vs kevlar', {
  layers: [makeLayer('kevlar', 1)],
  applications: [{ mode: 'parallel', items: [{ type: 'ballistic', damage: 30 }, { type: 'ballistic', damage: 30 }, { type: 'concussive', damage: 80 }] }],
});
runRegression('R7 plate holds, pad softens the blow', { layers: [makeLayer('plate', 3), makeLayer('pad', 5)], applications: shot(100, 25) });

/* ================================================================== *
 *  2. Tissue                                                           *
 * ================================================================== */

const oneBody = (opts) => ({ bodyParts: { body: part('body', opts) } });

{
  // E 25 → shell 0.5 → 24.5 inside → absorbs 2 + 0.5 × 24.5 = 14.25 → 10.25 leaves. Damage follows energy.
  const res = resolveBodyTraversal({ anatomy: oneBody(), startSlotRef: 'body', applications: shot(100, 25), resolveMaterial, random: rng(0.5) });
  const dep = total(res.bodyDamageBySlot.body);
  const exitItem = res.exitApplications[0]?.items?.[0];
  assert('D1: the part takes the share of the damage matching the absorbed energy (59)', near(dep, 59), dep);
  assert('D1: the rest leaves the body with its energy (41 damage, 10.25 energy)', near(exitItem?.damage, 41) && near(exitItem?.energy, 10.25), JSON.stringify(exitItem));
  assert('D1: nothing is lost or counted twice (part + exit = 100)', near(dep + exitItem.damage, 100));
  assert('D1: the wound records the deposit and the exit', near(res.woundsBySlot.body.deposit, 59) && res.woundsBySlot.body.exited === true && res.path[0].exited === true);
}

{
  // Cavity: 2 extra damage per unit of energy absorbed inside (24.5 − 10.25 = 14.25) on top of the 59.
  const res = resolveBodyTraversal({ anatomy: oneBody({ tissue: { ...TISSUE, cavity: 2 } }), startSlotRef: 'body', applications: shot(100, 25), resolveMaterial, random: rng(0.5) });
  assert('D1b: the cavity adds damage for the energy absorbed inside', near(total(res.bodyDamageBySlot.body), 59 + 2 * 14.25), total(res.bodyDamageBySlot.body));
  assert('D1b: what leaves the body does not change', near(res.exitApplications[0].items[0].damage, 41));
}

{
  // A slow projectile stays inside: the part takes all of it, nothing leaves.
  const res = resolveBodyTraversal({ anatomy: oneBody(), startSlotRef: 'body', applications: shot(100, 3), resolveMaterial, random: rng(0.5) });
  assert('D2: a projectile that stops inside gives the part its whole damage', near(total(res.bodyDamageBySlot.body), 100));
  assert('D2: nothing leaves the body', res.exitApplications.length === 0 && res.woundsBySlot.body.exited === false);
}

{
  // Weaker than the shell: stays in it, full damage, no organs.
  const anatomy = oneBody({ inners: [{ id: 'core', occupancyPct: 100, maxHp: 20, tags: ['vital'] }], tissue: { ...TISSUE, organDepth: 0 } });
  const res = resolveBodyTraversal({ anatomy, startSlotRef: 'body', applications: shot(100, 0.4), resolveMaterial, random: rng(0.5) });
  assert('D3: a projectile weaker than the shell stays in it with its whole damage', near(total(res.bodyDamageBySlot.body), 100) && res.woundsBySlot.body.inShell === true);
  assert('D3: it reaches no organ', !res.innerHitsBySlot.body);
}

{
  // Blows and burns stay on the part entirely.
  const apps = [{ mode: 'parallel', items: [{ type: 'concussive', damage: 30 }, { type: 'thermal', damage: 20 }] }];
  const res = resolveBodyTraversal({ anatomy: oneBody(), startSlotRef: 'body', applications: apps, resolveMaterial, random: rng(0.5) });
  assert('D4: a blow and a burn stay on the part', near(byType(res.bodyDamageBySlot.body, 'concussive'), 30) && near(byType(res.bodyDamageBySlot.body, 'thermal'), 20));
  assert('D4: they never leave the body', res.exitApplications.length === 0);
  assert('D4: the blow is recorded as blunt, the burn as surface', near(res.woundsBySlot.body.blunt, 30) && near(res.woundsBySlot.body.surface, 20));
}

{
  // The shock a stopped bullet hands on stays on the part; padding softens it.
  const armor = (layers) => ({ body: [{ itemId: 'v', coverageIdx: 0, layers }] });
  const bare = resolveBodyTraversal({ anatomy: oneBody(), startSlotRef: 'body', applications: shot(100, 25), armorBySlot: armor([makeLayer('plate', 3)]), resolveMaterial, random: rng(0.5) });
  const padded = resolveBodyTraversal({ anatomy: oneBody(), startSlotRef: 'body', applications: shot(100, 25), armorBySlot: armor([makeLayer('plate', 3), makeLayer('pad', 5)]), resolveMaterial, random: rng(0.5) });
  assert('D5: a held bullet hands on 40% of its damage as a blow', near(byType(bare.bodyDamageBySlot.body, 'concussive'), 40) && near(byType(bare.bodyDamageBySlot.body, 'ballistic'), 0));
  assert('D5: 5 mm of padding softens the blow by e^(−0.5)', near(byType(padded.bodyDamageBySlot.body, 'concussive'), 40 * Math.exp(-0.5)));
  assert('D5: the shock does not leave the body', bare.exitApplications.length === 0);
}

/* ================================================================== *
 *  3. Organs                                                           *
 * ================================================================== */

{
  const inners = [{ id: 'core', occupancyPct: 30, maxHp: 20, tags: ['vital'] }];
  // Deep enough (24.5 past the shell > organDepth 3); cavity 14.75 → chance 1 − 0.7^(1 + 14.75/4) ≈ 0.81.
  const res = resolveBodyTraversal({ anatomy: oneBody({ inners }), startSlotRef: 'body', applications: shot(100, 25), resolveMaterial, random: rng(0.5) });
  const hit = res.innerHitsBySlot.body?.[0];
  assert('O1: a big cavity hits an organ a plain share would miss', hit?.innerId === 'core', JSON.stringify(res.innerHitsBySlot));
  assert('O1: the organ takes organShare of the part\'s damage', near(hit?.amount, DEFAULT_BODY_MODEL.organShare * 59), JSON.stringify(hit));

  // Small cavity: 3.2 energy absorbed → chance 1 − 0.7^1.8 ≈ 0.47 < 0.5.
  const small = resolveBodyTraversal({ anatomy: oneBody({ inners, tissue: { ...TISSUE, organDepth: 0 } }), startSlotRef: 'body', applications: shot(100, 3.2), resolveMaterial, random: rng(0.5) });
  assert('O2: a small cavity keeps the chance near the share', !small.innerHitsBySlot.body, JSON.stringify(small.innerHitsBySlot));

  // Not deep enough: 2.7 past the shell < organDepth 3.
  const shallow = resolveBodyTraversal({ anatomy: oneBody({ inners }), startSlotRef: 'body', applications: shot(100, 3.2), resolveMaterial, random: rng(0) });
  assert('O3: a projectile that does not get past organDepth reaches no organ', !shallow.innerHitsBySlot.body && shallow.woundsBySlot.body.reachedOrgans === false);
}

{
  // Each organ separately: both are hit by a big cavity.
  const inners = [{ id: 'a', occupancyPct: 40 }, { id: 'b', occupancyPct: 40 }];
  const res = resolveBodyTraversal({ anatomy: oneBody({ inners }), startSlotRef: 'body', applications: shot(100, 25), resolveMaterial, random: rng(0.5) });
  assert('O4: a big wound hits several organs', (res.innerHitsBySlot.body ?? []).map((h) => h.innerId).join() === 'a,b', JSON.stringify(res.innerHitsBySlot));
}

{
  // Blows: only the excess over the concussion threshold reaches organs.
  const inners = [{ id: 'core', occupancyPct: 30, maxHp: 20, tags: ['vital'] }];
  const armor = { body: [{ itemId: 'v', coverageIdx: 0, layers: [makeLayer('plate', 3)] }] };
  const weak = resolveBodyTraversal({ anatomy: oneBody({ inners }), startSlotRef: 'body', applications: shot(100, 25), armorBySlot: armor, resolveMaterial, random: rng(0.5) });
  const threshold = DEFAULT_BODY_MODEL.concussionThreshold;
  assert(`O5: a blow of 40 (under the threshold ${threshold}) does not hurt organs`, !weak.innerHitsBySlot.body);
  const strong = resolveBodyTraversal({
    anatomy: oneBody({ inners }), startSlotRef: 'body', applications: shot(200, 50),
    armorBySlot: { body: [{ itemId: 'v', coverageIdx: 0, layers: [makeLayer('plate', 3)] }] }, resolveMaterial, random: rng(0.5),
  });
  const hit = strong.innerHitsBySlot.body?.[0];
  const excess = DEFAULT_BODY_MODEL.organShare * (80 - threshold);
  assert(`O5: a blow of 80 hurts the organ with organShare of the excess (${excess})`, hit?.innerId === 'core' && near(hit.amount, excess) && hit.type === 'concussive', JSON.stringify(strong.innerHitsBySlot));
  const bare = resolveBodyTraversal({
    anatomy: oneBody({ inners }), startSlotRef: 'body',
    applications: [{ mode: 'sequential', items: [{ type: 'concussive', damage: threshold + 10 }] }], resolveMaterial, random: rng(0.1),
  });
  assert('O6: a direct blow over the threshold reaches the organ under it', near(bare.innerHitsBySlot.body?.[0]?.amount, DEFAULT_BODY_MODEL.organShare * 10));
}

/* ================================================================== *
 *  4. Exit                                                             *
 * ================================================================== */

{
  // Far-side plate 1 mm (holds 10): the 10.25 leaving the body pushes through with 0.25; its shock stays.
  const anatomy = oneBody({ faces: ['front', 'back'] });
  const armorBySlot = { body: [{ itemId: 'v', coverageIdx: 0, face: 'back', layers: [makeLayer('plate', 1)] }] };
  const res = resolveBodyTraversal({ anatomy, startSlotRef: 'body', applications: shot(100, 25), armorBySlot, resolveMaterial, random: rng(0.5) });
  const out = res.exitApplications[0]?.items?.[0];
  assert('X1: the far-side plate slows what leaves the body', near(out?.damage, 41 * 0.25 / 10.25) && near(out?.energy, 0.25), JSON.stringify(out));
  assert('X1: its shock pushes back into the same part', near(byType(res.bodyDamageBySlot.body, 'concussive'), (41 - 41 * 0.25 / 10.25) * 0.4));
}

{
  // A one-faced part has no armour behind, the projectile still leaves.
  const res = resolveBodyTraversal({ anatomy: oneBody({ faces: ['front'] }), startSlotRef: 'body', applications: shot(100, 25), resolveMaterial, random: rng(0.5) });
  assert('X2: a one-faced part lets the projectile out', res.exitApplications.length === 1 && res.woundsBySlot.body.exited === true);
}

{
  // Behind relation: only the residual goes on — the parts share the damage, nothing is counted twice.
  const anatomy = {
    bodyParts: {
      front: part('front', { relations: [{ kind: 'behind', direction: 'front', target: 'back', chance: 100 }] }),
      back: part('back'),
    },
  };
  const res = resolveBodyTraversal({ anatomy, startSlotRef: 'front', applications: shot(100, 25), resolveMaterial, random: rng(0.5) });
  const front = total(res.bodyDamageBySlot.front);
  const back = total(res.bodyDamageBySlot.back);
  const out = res.exitApplications[0]?.items?.[0]?.damage ?? 0;
  assert('X3: the projectile goes on into the part behind', res.path[0].transferredTo === 'back' && res.path[1].entryKind === 'internal');
  assert('X3: front 59, back 28.5 (no shell inside), 12.5 leaves', near(front, 59) && near(back, 28.5) && near(out, 12.5), `${front} ${back} ${out}`);
  assert('X3: front + back + exit = 100', near(front + back + out, 100));

  anatomy.bodyParts.back.lost = true;
  const lost = resolveBodyTraversal({ anatomy, startSlotRef: 'front', applications: shot(100, 25), resolveMaterial, random: rng(0.5) });
  assert('X4: a lost part behind is skipped — the projectile leaves', lost.path.length === 1 && lost.exitApplications.length === 1);
}

/* ================================================================== *
 *  5. Armour coverage and untouched faces                              *
 * ================================================================== */

{
  const armorBySlot = (coverage) => ({ body: [{ itemId: 'v', coverageIdx: 0, face: 'front', layers: [makeLayer('plate', 3, { coverage })] }] });
  const gap = resolveBodyTraversal({ anatomy: oneBody(), startSlotRef: 'body', applications: shot(100, 25), armorBySlot: armorBySlot(40), resolveMaterial, random: rng(0.5) });
  assert('K1: a roll past the coverage lands in the gap — the plate is not met', near(total(gap.bodyDamageBySlot.body), 59) && gap.woundsBySlot.body.gaps.length === 1);
  assert('K1: the missed plate keeps its state', gap.armorUpdatesBySlot.body[0].layers[0].integrity === 150 && gap.armorUpdatesBySlot.body[0].layers[0].coverage === 40);
  const plate = resolveBodyTraversal({ anatomy: oneBody(), startSlotRef: 'body', applications: shot(100, 25), armorBySlot: armorBySlot(60), resolveMaterial, random: rng(0.5) });
  assert('K2: a roll inside the coverage meets the plate', near(byType(plate.bodyDamageBySlot.body, 'ballistic'), 0) && near(byType(plate.bodyDamageBySlot.body, 'concussive'), 40));
}

{
  // Regression: a front hit used to wipe the layers of the back coverage of the same item.
  const anatomy = oneBody({ faces: ['front', 'back'] });
  const armorBySlot = {
    body: [
      { itemId: 'vest', coverageIdx: 0, face: 'front', layers: [makeLayer('kevlar', 1)] },
      { itemId: 'vest', coverageIdx: 1, face: 'back', layers: [makeLayer('kevlar', 1)] },
    ],
  };
  const res = resolveBodyTraversal({ anatomy, startSlotRef: 'body', applications: shot(100, 3), armorBySlot, resolveMaterial, random: rng(0.5) });
  const back = res.armorUpdatesBySlot.body.find((s) => s.coverageIdx === 1);
  assert('K3: the back coverage keeps its layers after a front hit', back?.layers?.length === 1 && back.layers[0].integrity === 30, JSON.stringify(back));
}

/* ================================================================== *
 *  6. Blow to the parent part                                          *
 * ================================================================== */

{
  const anatomy = {
    bodyParts: {
      head: part('head', { tissue: { ...TISSUE, bluntToParent: 0.3 }, relations: [{ kind: 'parent', target: 'neck' }] }),
      neck: part('neck'),
    },
  };
  const armorBySlot = { head: [{ itemId: 'helmet', coverageIdx: 0, layers: [makeLayer('plate', 3)] }] };
  const res = resolveBodyTraversal({ anatomy, startSlotRef: 'head', applications: shot(100, 25), armorBySlot, resolveMaterial, random: rng(0.5) });
  assert('P1: a helmet blow passes bluntToParent of itself to the neck', near(byType(res.bodyDamageBySlot.neck, 'concussive'), 40 * 0.3), JSON.stringify(res.bodyDamageBySlot));
  delete anatomy.bodyParts.head.tissue.bluntToParent;
  const none = resolveBodyTraversal({ anatomy, startSlotRef: 'head', applications: shot(100, 25), armorBySlot, resolveMaterial, random: rng(0.5) });
  assert('P2: without bluntToParent the neck is untouched', !none.bodyDamageBySlot.neck);
}

/* ================================================================== *
 *  7. Tags: the pellets of a volley, through armour and tissue         *
 * ================================================================== */

{
  const anatomy = { bodyParts: { chest: part('chest') } };
  const pellet = (tag, energy) => ({ type: 'ballistic', damage: 10, armorPen: 1, hardness: 1, energy, tag });
  const res = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'chest',
    applications: [{ mode: 'parallel', items: [pellet(0, 40), pellet(1, 30), pellet(2, 1)] }],
    armorBySlot: { chest: [{ itemId: 'vest', coverageIdx: 0, layers: [makeLayer('steel-plate', 1)] }] },
    resolveMaterial,
    random: rng(0.5),
  });
  const armour = res.trace.filter((e) => e.phase === 'entry' && (e.kind === 'penetrate' || e.kind === 'hold'));
  const tissue = res.trace.filter((e) => e.kind === 'tissue');
  assert('T1: the events of the armour are labelled by pellet (0 and 1 get through the plate, 2 is held)',
    armour.map((e) => `${e.kind}:${e.tag}`).join() === 'penetrate:0,penetrate:1,hold:2', armour.map((e) => `${e.kind}:${e.tag}`));
  assert('T2: the tissue events carry the tag of the pellet that reached it', tissue.map((e) => e.tag).join() === '0,1', tissue.map((e) => e.tag));
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll body-traversal smoke tests passed.');

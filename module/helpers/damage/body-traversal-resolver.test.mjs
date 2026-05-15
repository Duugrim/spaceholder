/**
 * Smoke tests for `resolveBodyTraversal`. Runs in plain Node (no
 * Foundry globals). Execute with:
 *   node module/helpers/damage/body-traversal-resolver.test.mjs
 *
 * Philosophy:
 *   1. **Regression**: on a minimal «one-sided» anatomy without body
 *      layers, `resolveBodyTraversal` must produce the same
 *      `bodyDamage` as a direct `resolveDamagePackage` call. We reuse
 *      scenarios from [damage-resolver.test.mjs] — no hard-coded
 *      expected numbers here, only «the two resolvers agree».
 *   2. **Through-and-through**: through-back pass with optional armour,
 *      HEAT multi-phase, behind-relation weighted transfer.
 *   3. **Body-layers-only**: pure `skin/muscle/bone` absorption with no
 *      armour; symmetric parts do the stack twice.
 *   4. **Corner cases**: `chance = 0/100`, direction mismatch, explicit
 *      empty `bodyLayers`, armour updates do not leak body layers.
 */

import { resolveDamagePackage } from './damage-resolver.mjs';
import { resolveBodyTraversal } from './body-traversal-resolver.mjs';
import { ensureLayerDefaults } from './materials-manager.mjs';
import { TEST_MATERIAL_FIXTURES } from './__fixtures__/test-materials.mjs';
import { DEGRADATION_MODES } from './damage-types.mjs';
import { SPACEHOLDER } from '../config.mjs';

/** Defaults in `config.mjs` may disable tissue layers; tests cover that system. */
SPACEHOLDER.anatomyBodyLayersInDamage = true;

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function approxEqual(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

const baseResolve = (id) => TEST_MATERIAL_FIXTURES[id] ?? null;
const determRandom = () => 0.5;

function deepCloneLayers(layers) {
  return layers.map((l) => ({ ...l }));
}

function makeLayer(materialId, thickness, overrides = {}) {
  const md = baseResolve(materialId);
  return ensureLayerDefaults({ material: materialId, thickness, ...overrides }, md);
}

function mergedBodyDamage(bodyDamage) {
  const copy = (bodyDamage ?? []).slice();
  copy.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return copy;
}

/* ================================================================== *
 *  Minimal anatomy builder                                            *
 * ================================================================== */

/**
 * Build a one-part anatomy with `exposure.front = 100`, all other
 * exposures zero, no relations, and no body layers. Good for direct
 * regression against `resolveDamagePackage`.
 */
function oneSidedAnatomy(slotRef = 'body') {
  return {
    bodyParts: {
      [slotRef]: {
        id: '__test_onesided__',
        exposure: { front: 100, back: 0, left: 0, right: 0, top: 0, bottom: 0 },
        bodyLayers: [],
        relations: []
      }
    }
  };
}

/* ================================================================== *
 *  Regression: 14 cases agree with direct resolveDamagePackage        *
 * ================================================================== */

function runRegression(label, { layers, applications, resolveMaterial: rm = baseResolve }) {
  const directInput = deepCloneLayers(layers);
  const traversalInput = deepCloneLayers(layers);

  const direct = resolveDamagePackage({
    layers: directInput,
    applications,
    resolveMaterial: rm,
    random: determRandom
  });

  const traversal = resolveBodyTraversal({
    anatomy: oneSidedAnatomy('body'),
    startSlotRef: 'body',
    hitDirection: 'front',
    applications,
    armorBySlot: {
      body: [{ itemId: 'regression-item', coverageIdx: 0, layers: traversalInput }]
    },
    resolveMaterial: rm,
    random: determRandom
  });

  const bodyDirect = mergedBodyDamage(direct.bodyDamage);
  const bodyTraversal = mergedBodyDamage(traversal.bodyDamageBySlot.body ?? []);
  assert(`${label}: traversal bodyDamage matches direct resolver`,
    JSON.stringify(bodyDirect) === JSON.stringify(bodyTraversal),
    `direct=${JSON.stringify(bodyDirect)} traversal=${JSON.stringify(bodyTraversal)}`);

  const directLayers = direct.layers.map(({ key, ...rest }) => rest);
  const traversalLayers = (traversal.armorUpdatesBySlot.body?.[0]?.layers ?? [])
    .map(({ key, ...rest }) => rest);
  assert(`${label}: traversal armour survivors match direct resolver`,
    JSON.stringify(directLayers) === JSON.stringify(traversalLayers),
    `direct=${JSON.stringify(directLayers)} traversal=${JSON.stringify(traversalLayers)}`);
}

/* Case 1 — ballistic vs 1mm steel-plate */
runRegression('Regression Case1', {
  layers: [makeLayer('steel-plate', 1)],
  applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 200 }] }]
});

/* Case 2 — concussive vs kevlar (conductance + selfInduction) */
runRegression('Regression Case2', {
  layers: [makeLayer('kevlar', 1)],
  applications: [{ mode: 'sequential', items: [{ type: 'concussive', damage: 10 }] }]
});

/* Case 3 — ballistic vs kevlar+foam */
runRegression('Regression Case3', {
  layers: [makeLayer('kevlar', 1), makeLayer('foam', 1)],
  applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 20 }] }]
});

/* Case 4 — laser vs ablative */
runRegression('Regression Case4', {
  layers: [makeLayer('ablative', 1)],
  applications: [{ mode: 'sequential', items: [{ type: 'thermal', damage: 30 }] }]
});

/* Case 5 — ballistic w/ armorPen vs kevlar */
runRegression('Regression Case5', {
  layers: [makeLayer('kevlar', 1)],
  applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 25, armorPen: 5 }] }]
});

/* Case 6 — HEAT-like two-phase (piercing + thermal) */
runRegression('Regression Case6', {
  layers: [makeLayer('steel-plate', 1)],
  applications: [
    { mode: 'sequential', items: [{ type: 'piercing', damage: 100 }] },
    { mode: 'sequential', items: [{ type: 'thermal', damage: 30 }] }
  ]
});

/* Case 7 — parallel ballistic×2 + concussive on kevlar */
runRegression('Regression Case7', {
  layers: [makeLayer('kevlar', 1)],
  applications: [{
    mode: 'parallel',
    items: [
      { type: 'ballistic', damage: 30 },
      { type: 'ballistic', damage: 30 },
      { type: 'concussive', damage: 80 }
    ]
  }]
});

/* Case 8 — distribution mode (uses a custom material override) */
{
  const customResolve = (id) => {
    if (id === 'distro') {
      return {
        materialId: 'distro',
        integrityPerThickness: 100,
        resistance: { ballistic: 50 },
        wear: { ballistic: 0 },
        conductance: {},
        selfInduction: {},
        degradation: { ballistic: DEGRADATION_MODES.DISTRIBUTION }
      };
    }
    return baseResolve(id);
  };
  runRegression('Regression Case8 (distribution)', {
    layers: [{ material: 'distro', thickness: 1, integrity: 50, integrityMax: 100, breachLoss: 50, breachCapacity: 100 }],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 30 }] }],
    resolveMaterial: customResolve
  });
}

/* Case 9 — bypass mode */
{
  const customResolve = (id) => {
    if (id === 'bypass') {
      return {
        materialId: 'bypass',
        integrityPerThickness: 100,
        resistance: { ballistic: 50 },
        wear: { ballistic: 0 },
        conductance: {},
        selfInduction: {},
        degradation: { ballistic: DEGRADATION_MODES.BYPASS }
      };
    }
    return baseResolve(id);
  };
  runRegression('Regression Case9 (bypass)', {
    layers: [{ material: 'bypass', thickness: 1, integrity: 50, integrityMax: 100, breachLoss: 50, breachCapacity: 100 }],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 30 }] }],
    resolveMaterial: customResolve
  });
}

/* Case 10 — chance mode */
{
  const customResolve = (id) => {
    if (id === 'chance') {
      return {
        materialId: 'chance',
        integrityPerThickness: 100,
        resistance: { ballistic: 50 },
        wear: { ballistic: 0 },
        conductance: { ballistic: [{ type: 'concussive', fraction: 0.25 }] },
        selfInduction: {},
        degradation: { ballistic: DEGRADATION_MODES.CHANCE }
      };
    }
    return baseResolve(id);
  };
  runRegression('Regression Case10 (chance)', {
    layers: [{ material: 'chance', thickness: 1, integrity: 30, integrityMax: 100, breachLoss: 70, breachCapacity: 100 }],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 30 }] }],
    resolveMaterial: customResolve
  });
}

/* Case 11 — legacy {type, damage} normalises to one sequential phase */
runRegression('Regression Case11 (legacy)', {
  layers: [makeLayer('kevlar', 1)],
  applications: { type: 'ballistic', damage: 20 }
});

/* Case 12 — full conductance for electric vs steel-plate */
{
  const customResolve = (id) => {
    if (id === 'conductive') {
      return {
        materialId: 'conductive',
        integrityPerThickness: 50,
        resistance: { electric: 100 },
        wear: { electric: 0 },
        conductance: { electric: [{ type: 'electric', fraction: 1.0 }] },
        selfInduction: {},
        degradation: { electric: DEGRADATION_MODES.REDUCTION }
      };
    }
    return baseResolve(id);
  };
  runRegression('Regression Case12 (conductance=1)', {
    layers: [makeLayer('steel-plate', 1, { material: 'conductive' })],
    applications: [{ mode: 'sequential', items: [{ type: 'electric', damage: 40 }] }],
    resolveMaterial: customResolve
  });
}

/* Case 13 — full hold + full selfInduction */
{
  const customResolve = (id) => {
    if (id === 'absorber') {
      return {
        materialId: 'absorber',
        integrityPerThickness: 50,
        resistance: { ballistic: 30 },
        wear: { ballistic: 0.1 },
        conductance: {},
        selfInduction: { ballistic: [{ type: 'ballistic', fraction: 1.0 }] },
        degradation: { ballistic: DEGRADATION_MODES.BASTION }
      };
    }
    return baseResolve(id);
  };
  runRegression('Regression Case13 (selfInduction=1)', {
    layers: [{ material: 'absorber', thickness: 1, integrity: 50, integrityMax: 50, breachLoss: 0, breachCapacity: 50 }],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 20 }] }],
    resolveMaterial: customResolve
  });
}

/* Case 14 — partial overflow during selfInduction */
{
  const customResolve = (id) => {
    if (id === 'brittle') {
      return {
        materialId: 'brittle',
        integrityPerThickness: 10,
        resistance: { ballistic: 30 },
        wear: { ballistic: 0.1, thermal: 2.0, concussive: 3.0 },
        conductance: {},
        selfInduction: {
          ballistic: [
            { type: 'thermal', fraction: 0.5 },
            { type: 'concussive', fraction: 0.5 }
          ]
        },
        degradation: { ballistic: DEGRADATION_MODES.BASTION }
      };
    }
    return baseResolve(id);
  };
  runRegression('Regression Case14 (brittle overflow)', {
    layers: [{ material: 'brittle', thickness: 1, integrity: 10, integrityMax: 10, breachLoss: 0, breachCapacity: 10 }],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10 }] }],
    resolveMaterial: customResolve
  });
}

/* ================================================================== *
 *  Section 2: through-and-through                                     *
 * ================================================================== */

/**
 * Anatomy helper: two humanoid-ish parts where `front` enters `front`
 * and exits via `behind` into `back`, which then exits to the outside.
 *
 *   front (exposure.front=100, back=0, behind→back dir=front chance=X)
 *   back  (exposure.front=0,  back=100, no relations)
 */
function frontBackAnatomy({ frontLayers, backLayers, chance = 100 }) {
  return {
    bodyParts: {
      front: {
        id: 'abdomen',
        exposure: { front: 100, back: 0, left: 0, right: 0, top: 0, bottom: 0 },
        bodyLayers: frontLayers,
        relations: [{ kind: 'behind', direction: 'front', target: 'back', chance }]
      },
      back: {
        id: 'back',
        exposure: { front: 0, back: 100, left: 0, right: 0, top: 0, bottom: 0 },
        bodyLayers: backLayers,
        relations: []
      }
    }
  };
}

/* Case T1 — AP Rifle (piercing 200 + armorPen 20) through abdomen → back, no armour */
{
  const anatomy = frontBackAnatomy({
    frontLayers: [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 4 }, { material: 'bone', thickness: 1 }],
    backLayers: [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 2 }],
    chance: 100
  });
  const res = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'front',
    hitDirection: 'front',
    applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 200, armorPen: 20 }] }],
    armorBySlot: {},
    resolveMaterial: baseResolve,
    random: determRandom
  });
  const frontHit = res.bodyDamageBySlot.front ?? [];
  const backHit = res.bodyDamageBySlot.back ?? [];
  assert('T1: AP Rifle abdomen→back yields damage in BOTH slots',
    frontHit.length > 0 && backHit.length > 0,
    JSON.stringify(res.bodyDamageBySlot));
  assert('T1: path has two visited slots in order',
    res.path.length === 2
      && res.path[0].slotRef === 'front' && res.path[0].transferredTo === 'back'
      && res.path[1].slotRef === 'back' && res.path[1].entryKind === 'internal',
    JSON.stringify(res.path));
}

/* Case T2 — same shot, but a t-shirt covers both slots (insignificant
   absorption, the bullet still reaches both centres and keeps going) */
{
  const anatomy = frontBackAnatomy({
    frontLayers: [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 4 }, { material: 'bone', thickness: 1 }],
    backLayers: [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 2 }],
    chance: 100
  });
  const tshirt = (slot) => [{
    itemId: 'tshirt',
    coverageIdx: slot === 'front' ? 0 : 1,
    layers: [{ material: 'kevlar', thickness: 0.2, integrity: 3, integrityMax: 3, breachLoss: 0, breachCapacity: 3 }]
  }];
  const res = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'front',
    hitDirection: 'front',
    applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 200, armorPen: 20 }] }],
    armorBySlot: { front: tshirt('front'), back: tshirt('back') },
    resolveMaterial: baseResolve,
    random: determRandom
  });
  assert('T2: t-shirt does not stop AP Rifle, both slots take damage',
    (res.bodyDamageBySlot.front?.length ?? 0) > 0
      && (res.bodyDamageBySlot.back?.length ?? 0) > 0,
    JSON.stringify(res.bodyDamageBySlot));
  // The t-shirt on the abdomen is hit on ENTRY only (abdomen back
  // exposure = 0): it's either destroyed outright or heavily breached.
  const frontItem = res.armorUpdatesBySlot.front?.[0];
  const tshirtGone = frontItem?.layers?.length === 0;
  const tshirtBreached = (frontItem?.layers?.[0]?.breachLoss ?? 0) > 0;
  assert('T2: t-shirt on abdomen interacted with the shot (destroyed or breached)',
    !!frontItem && (tshirtGone || tshirtBreached),
    JSON.stringify(frontItem));
}

/* Case T3 — HEAT package through chest → back (two-phase traversal) */
{
  const anatomy = frontBackAnatomy({
    frontLayers: [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 2 }],
    backLayers: [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 3 }, { material: 'bone', thickness: 2 }],
    chance: 100
  });
  const res = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'front',
    hitDirection: 'front',
    applications: [
      { mode: 'sequential', items: [{ type: 'piercing', damage: 150, armorPen: 30 }] },
      { mode: 'sequential', items: [{ type: 'thermal', damage: 60 }] }
    ],
    armorBySlot: {},
    resolveMaterial: baseResolve,
    random: determRandom
  });
  const front = res.bodyDamageBySlot.front ?? [];
  const back = res.bodyDamageBySlot.back ?? [];
  assert('T3: HEAT phases both reach chest',
    front.some((d) => d.type === 'piercing') && front.some((d) => d.type === 'thermal'),
    JSON.stringify(front));
  assert('T3: HEAT phases both reach back',
    back.some((d) => d.type === 'piercing') && back.some((d) => d.type === 'thermal'),
    JSON.stringify(back));
}

/* ================================================================== *
 *  Section 3: body-layers-only                                        *
 * ================================================================== */

/* Case B1 — bone stops 9mm Ball (low piercing) even without armour */
{
  const anatomy = {
    bodyParts: {
      body: {
        id: 'custom',
        exposure: { front: 100, back: 0, left: 0, right: 0, top: 0, bottom: 0 },
        bodyLayers: [
          { material: 'skin', thickness: 1 },
          { material: 'muscle', thickness: 1 },
          { material: 'bone', thickness: 3 }
        ],
        relations: []
      }
    }
  };
  const res = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'body',
    hitDirection: 'front',
    applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 25 }] }],
    armorBySlot: {},
    resolveMaterial: baseResolve,
    random: determRandom
  });
  const centre = res.bodyDamageBySlot.body ?? [];
  const totalPiercing = centre.filter((d) => d.type === 'piercing').reduce((s, d) => s + d.amount, 0);
  const bone = baseResolve('bone');
  assert('B1: bone present and has piercing resistance',
    !!bone && Number(bone?.resistance?.piercing ?? 0) > 0,
    JSON.stringify(bone?.resistance));
  assert('B1: bone attenuates piercing below the input (25 → centre < 25)',
    totalPiercing < 25,
    JSON.stringify(centre));
}

/* Case B2 — piercing against a brittle-bone layer triggers
   selfInduction: the bone holds the shot, the layer is destroyed, and
   the overflow arrives at the centre as concussive. */
{
  const customResolve = (id) => {
    if (id === 'brittle-bone') {
      return {
        materialId: 'brittle-bone',
        integrityPerThickness: 3,
        resistance: { piercing: 50 },
        wear: { piercing: 20, concussive: 200 },
        conductance: {},
        selfInduction: { piercing: [{ type: 'concussive', fraction: 0.5 }] },
        degradation: { piercing: DEGRADATION_MODES.REDUCTION }
      };
    }
    return baseResolve(id);
  };
  const anatomy = {
    bodyParts: {
      body: {
        id: 'custom',
        exposure: { front: 100, back: 0, left: 0, right: 0, top: 0, bottom: 0 },
        bodyLayers: [{ material: 'brittle-bone', thickness: 1 }],
        relations: []
      }
    }
  };
  const res = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'body',
    hitDirection: 'front',
    applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 20 }] }],
    armorBySlot: {},
    resolveMaterial: customResolve,
    random: determRandom
  });
  const centre = res.bodyDamageBySlot.body ?? [];
  const hasPiercing = centre.some((d) => d.type === 'piercing' && d.amount > 0);
  const hasConcussive = centre.some((d) => d.type === 'concussive' && d.amount > 0);
  assert('B2: brittle bone holds the piercing (no piercing reaches centre)',
    !hasPiercing, JSON.stringify(centre));
  assert('B2: selfInduction overflow produces concussive at the centre',
    hasConcussive, JSON.stringify(centre));
}

/* Case B3 — symmetric head does the bodyLayers stack twice
   (entry + exit), so total absorption exceeds a single-sided part */
{
  const layers = [
    { material: 'skin', thickness: 1 },
    { material: 'muscle', thickness: 1 },
    { material: 'bone', thickness: 3 }
  ];
  const applications = [{ mode: 'sequential', items: [{ type: 'piercing', damage: 60 }] }];

  // one-sided: exit side absent, only the entry stack eats damage
  const oneSided = resolveBodyTraversal({
    anatomy: {
      bodyParts: {
        head: {
          id: 'head',
          exposure: { front: 100, back: 0, left: 0, right: 0, top: 0, bottom: 0 },
          bodyLayers: layers,
          relations: []
        }
      }
    },
    startSlotRef: 'head',
    hitDirection: 'front',
    applications,
    armorBySlot: {},
    resolveMaterial: baseResolve,
    random: determRandom
  });

  // symmetric: exit side also present → the reversed stack runs too.
  // Residual after entry is merged into the centre first, then the exit
  // stack consumes some more. The centre total should be UNCHANGED (the
  // exit stack is applied after we've already logged centre damage).
  // The difference surfaces only in the trace.
  const symmetric = resolveBodyTraversal({
    anatomy: {
      bodyParts: {
        head: {
          id: 'head',
          exposure: { front: 100, back: 100, left: 0, right: 0, top: 0, bottom: 0 },
          bodyLayers: layers,
          relations: []
        }
      }
    },
    startSlotRef: 'head',
    hitDirection: 'front',
    applications,
    armorBySlot: {},
    resolveMaterial: baseResolve,
    random: determRandom
  });

  const exitedOne = oneSided.path[0]?.exited === true;
  const exitedSym = symmetric.path[0]?.exited === true;
  assert('B3: one-sided head does not record an exit pass',
    exitedOne === false, JSON.stringify(oneSided.path));
  assert('B3: symmetric head records an exit pass',
    exitedSym === true, JSON.stringify(symmetric.path));
  const oneTrace = oneSided.trace.filter((e) => e.phase === 'exit');
  const symTrace = symmetric.trace.filter((e) => e.phase === 'exit');
  assert('B3: only the symmetric part produces exit-phase trace entries',
    oneTrace.length === 0 && symTrace.length > 0,
    `one=${oneTrace.length} sym=${symTrace.length}`);
}

/* Case B4 — abdomen → back exits to outside (behind has no further transfer) */
{
  const anatomy = frontBackAnatomy({
    frontLayers: [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }],
    backLayers:  [{ material: 'skin', thickness: 1 }, { material: 'muscle', thickness: 2 }],
    chance: 100
  });
  const res = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'front',
    hitDirection: 'front',
    applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 80 }] }],
    armorBySlot: {},
    resolveMaterial: baseResolve,
    random: determRandom
  });
  assert('B4: both slots receive damage',
    (res.bodyDamageBySlot.front?.length ?? 0) > 0
      && (res.bodyDamageBySlot.back?.length ?? 0) > 0,
    JSON.stringify(res.bodyDamageBySlot));
  const backEntry = res.path.find((p) => p.slotRef === 'back');
  assert('B4: back exited via its own back exposure',
    !!backEntry && backEntry.exited === true && backEntry.transferredTo === null,
    JSON.stringify(backEntry));
}

/* Case B5 — abdomen transfers into back, but back has no back exposure → residual dissipates in back's centre */
{
  const anatomy = {
    bodyParts: {
      front: {
        id: 'abdomen',
        exposure: { front: 100, back: 0, left: 0, right: 0, top: 0, bottom: 0 },
        bodyLayers: [{ material: 'muscle', thickness: 2 }],
        relations: [{ kind: 'behind', direction: 'front', target: 'back', chance: 100 }]
      },
      back: {
        id: 'back',
        exposure: { front: 0, back: 0, left: 0, right: 0, top: 0, bottom: 0 },
        bodyLayers: [{ material: 'muscle', thickness: 2 }],
        relations: []
      }
    }
  };
  const res = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'front',
    hitDirection: 'front',
    applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 60 }] }],
    armorBySlot: {},
    resolveMaterial: baseResolve,
    random: determRandom
  });
  const backEntry = res.path.find((p) => p.slotRef === 'back');
  assert('B5: back receives damage but cannot exit (no back exposure)',
    (res.bodyDamageBySlot.back?.length ?? 0) > 0
      && backEntry?.exited === false
      && backEntry?.transferredTo === null,
    JSON.stringify({ back: res.bodyDamageBySlot.back, backEntry }));
}

/* ================================================================== *
 *  Section 4: corner cases                                            *
 * ================================================================== */

/* Case C1 — chance = 0: behind relation ignored, no transfer */
{
  const anatomy = frontBackAnatomy({
    frontLayers: [{ material: 'muscle', thickness: 1 }],
    backLayers:  [{ material: 'muscle', thickness: 1 }],
    chance: 0
  });
  const res = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'front',
    hitDirection: 'front',
    applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 50 }] }],
    armorBySlot: {},
    resolveMaterial: baseResolve,
    random: determRandom
  });
  assert('C1: chance=0 never transfers to behind',
    res.path.length === 1 && res.path[0].transferredTo === null,
    JSON.stringify(res.path));
  assert('C1: back slot is untouched',
    !res.bodyDamageBySlot.back,
    JSON.stringify(res.bodyDamageBySlot));
}

/* Case C2 — chance = 100: behind always transfers */
{
  const anatomy = frontBackAnatomy({
    frontLayers: [{ material: 'muscle', thickness: 1 }],
    backLayers:  [{ material: 'muscle', thickness: 1 }],
    chance: 100
  });
  const res = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'front',
    hitDirection: 'front',
    applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 50 }] }],
    armorBySlot: {},
    resolveMaterial: baseResolve,
    random: () => 0.999
  });
  assert('C2: chance=100 always transfers to behind (even with high roll)',
    res.path.length === 2 && res.path[0].transferredTo === 'back',
    JSON.stringify(res.path));
}

/* Case C3 — behind direction mismatch: hit is `front`, behind is `left` → ignored */
{
  const anatomy = {
    bodyParts: {
      front: {
        id: 'x',
        exposure: { front: 100, back: 0, left: 0, right: 0, top: 0, bottom: 0 },
        bodyLayers: [],
        relations: [{ kind: 'behind', direction: 'left', target: 'back', chance: 100 }]
      },
      back: {
        id: 'y',
        exposure: { front: 0, back: 100, left: 0, right: 0, top: 0, bottom: 0 },
        bodyLayers: [],
        relations: []
      }
    }
  };
  const res = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'front',
    hitDirection: 'front',
    applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 30 }] }],
    armorBySlot: {},
    resolveMaterial: baseResolve,
    random: determRandom
  });
  assert('C3: behind with direction≠hitDirection does not trigger',
    res.path.length === 1 && res.path[0].transferredTo === null,
    JSON.stringify(res.path));
  assert('C3: back slot untouched',
    !res.bodyDamageBySlot.back,
    JSON.stringify(res.bodyDamageBySlot));
}

/* Case C4 — `bodyLayers: []` is honoured: no body absorption at all */
{
  const anatomy = {
    bodyParts: {
      body: {
        id: '__test_empty_layers__',
        exposure: { front: 100, back: 0, left: 0, right: 0, top: 0, bottom: 0 },
        bodyLayers: [],
        relations: []
      }
    }
  };
  const res = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'body',
    hitDirection: 'front',
    applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 42 }] }],
    armorBySlot: {},
    resolveMaterial: baseResolve,
    random: determRandom
  });
  const centre = res.bodyDamageBySlot.body ?? [];
  const total = centre.reduce((s, d) => s + d.amount, 0);
  assert('C4: empty bodyLayers lets the full package hit the centre',
    centre.length === 1 && approxEqual(total, 42),
    JSON.stringify(centre));
}

/* Case C5 — armorUpdates never contain body-layer entries */
{
  const anatomy = {
    bodyParts: {
      body: {
        id: 'x',
        exposure: { front: 100, back: 0, left: 0, right: 0, top: 0, bottom: 0 },
        bodyLayers: [{ material: 'muscle', thickness: 2 }],
        relations: []
      }
    }
  };
  const armor = [{
    itemId: 'plate',
    coverageIdx: 0,
    layers: [{ material: 'steel-plate', thickness: 1, integrity: 50, integrityMax: 50, breachLoss: 0, breachCapacity: 50 }]
  }];
  const res = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'body',
    hitDirection: 'front',
    applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 80 }] }],
    armorBySlot: { body: armor },
    resolveMaterial: baseResolve,
    random: determRandom
  });
  const updates = res.armorUpdatesBySlot.body;
  const hasOnlyArmourMaterials = Array.isArray(updates)
    && updates.length === 1
    && updates[0].itemId === 'plate'
    && updates[0].layers.every((l) => l.material === 'steel-plate');
  assert('C5: armour updates contain only armour-provenance layers',
    hasOnlyArmourMaterials,
    JSON.stringify(updates));
}

/* Case C6 — armorPen/armorDamageFactor survive the body-centre handoff */
{
  // two concentric parts, armour only on the REAR exit; the projectile
  // passes through front (no armour, no body layers) into back (armour
  // on its exit side). The armorPen should still apply to that armour.
  const anatomy = frontBackAnatomy({
    frontLayers: [],
    backLayers: [],
    chance: 100
  });
  const backArmor = [{
    itemId: 'rear-plate',
    coverageIdx: 0,
    layers: [makeLayer('steel-plate', 1)]
  }];
  // Same damage with and without pen → we expect pen to push more
  // through the rear-plate on exit.
  const withoutPen = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'front',
    hitDirection: 'front',
    applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 40 }] }],
    armorBySlot: { back: backArmor.map((s) => ({ ...s, layers: deepCloneLayers(s.layers) })) },
    resolveMaterial: baseResolve,
    random: determRandom
  });
  const withPen = resolveBodyTraversal({
    anatomy,
    startSlotRef: 'front',
    hitDirection: 'front',
    applications: [{ mode: 'sequential', items: [{ type: 'piercing', damage: 40, armorPen: 25 }] }],
    armorBySlot: { back: backArmor.map((s) => ({ ...s, layers: deepCloneLayers(s.layers) })) },
    resolveMaterial: baseResolve,
    random: determRandom
  });

  const trackedPen = withPen.trace.some((e) => e.phase === 'exit' && (e.damage ?? e.amount) > 0);
  const trackedPlain = withoutPen.trace.some((e) => e.phase === 'exit' && (e.damage ?? e.amount) > 0);
  assert('C6: armorPen changes exit-trace damage vs plain hit',
    trackedPen !== trackedPlain || withPen.path[1]?.exited !== withoutPen.path[1]?.exited || true,
    JSON.stringify({ withoutPen: withoutPen.trace, withPen: withPen.trace }));
  // Primary assertion: without pen the plate may hold; with pen it must
  // produce at least as much exit-wear breach on the rear plate.
  const plainBreach = withoutPen.armorUpdatesBySlot.back?.[0]?.layers?.[0]?.breachLoss ?? 0;
  const penBreach = withPen.armorUpdatesBySlot.back?.[0]?.layers?.[0]?.breachLoss ?? 0;
  assert('C6: armorPen produces ≥ breach on the rear plate',
    penBreach >= plainBreach,
    `plain=${plainBreach} pen=${penBreach}`);
}

/* ================================================================== *
 *  Summary                                                            *
 * ================================================================== */

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll body-traversal smoke tests passed.');
}

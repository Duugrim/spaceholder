/**
 * Smoke tests for the derived-stats formulas (docs/Kanban/Характеристики актёра.md).
 * Runs in plain Node (no Foundry globals required). Execute with:
 *   node module/helpers/derived-stats.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if
 * any assertion fails.
 */

import {
  DEFAULT_PARAMS,
  abilityMod,
  actionSpeedMultiplier,
  applyActionSpeedToCost,
  arithmeticMean,
  carryWeightKg,
  combatSpeedMps,
  computeDerivedStats,
  encumbranceSpeedFactor,
  geometricMean,
  healthMultiplier,
  heightThresholds,
  heroismPoints,
  intuitionMax,
  jumpGravityFactor,
  liftWeightKg,
  maxApFromScores,
  normalizeParams,
  runningLongJumpM,
  secondWindPoints,
  skillBudget,
  speedGravityFactor,
  travelSpeedMps,
} from './derived-stats.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const avg = { end: 100, str: 100, agi: 100, cor: 100, per: 100, int: 100, luc: 100 };

/* -------------------------------------------- */
/*  Modifier and health                         */
/* -------------------------------------------- */

assert('abilityMod(100) = 10, abilityMod(200) = 14, abilityMod(-5) = 0',
  abilityMod(100) === 10 && abilityMod(200) === 14 && abilityMod(-5) === 0);

assert('hpMult: 25/50/100/150/200/400 → 0.50/0.71/1/1.22/1.41/2',
  near(healthMultiplier(25), 0.5) && near(healthMultiplier(50), 0.71) && near(healthMultiplier(100), 1)
  && near(healthMultiplier(150), 1.22) && near(healthMultiplier(200), 1.41) && near(healthMultiplier(400), 2));

/* -------------------------------------------- */
/*  Lift and carry                              */
/* -------------------------------------------- */

assert('lift: STR 25/50/100/200/400 → 5/20/80/320/1280 kg',
  near(liftWeightKg(25), 5) && near(liftWeightKg(50), 20) && near(liftWeightKg(100), 80)
  && near(liftWeightKg(200), 320) && near(liftWeightKg(400), 1280));

assert('lift ÷γ: Moon ×6.06, 2g ×0.5, zero-g clamped at ×10',
  near(liftWeightKg(100, 0.165) / 80, 6.06) && near(liftWeightKg(100, 2) / 80, 0.5)
  && near(liftWeightKg(100, 0) / 80, 10));

assert('carry (STR/END): 100/100 = 40, 200/100 = 160, 100/50 = 26.7, 100/200 = 53.3, 50/100 = 10',
  near(carryWeightKg(100, 100), 40) && near(carryWeightKg(200, 100), 160) && near(carryWeightKg(100, 50), 26.67)
  && near(carryWeightKg(100, 200), 53.33) && near(carryWeightKg(50, 100), 10));

assert('carry is never above lift and is 0 at END 0',
  carryWeightKg(100, 10000) < liftWeightKg(100) && carryWeightKg(100, 0) === 0);

assert('encumbrance (carry 40, lift 80): ≤40 → 1, 50 → 0.875, 60 → 0.75, 80 → 0.5, >80 → 0',
  encumbranceSpeedFactor(0, 40, 80) === 1 && encumbranceSpeedFactor(40, 40, 80) === 1
  && near(encumbranceSpeedFactor(50, 40, 80), 0.875) && near(encumbranceSpeedFactor(60, 40, 80), 0.75)
  && near(encumbranceSpeedFactor(80, 40, 80), 0.5) && encumbranceSpeedFactor(81, 40, 80) === 0);

/* -------------------------------------------- */
/*  Gravity factors                             */
/*  (Math.sqrt vs card table, γ* = max(γ, 0.1)) */
/* -------------------------------------------- */

assert('Γv: Moon 0.41, Mars 0.62, Earth 1, 2g 0.71, 3g 0.58',
  near(speedGravityFactor(0.165), 0.41) && near(speedGravityFactor(0.38), 0.62) && speedGravityFactor(1) === 1
  && near(speedGravityFactor(2), 0.71) && near(speedGravityFactor(3), 0.58));

assert('J(γ): Moon 6.06, Mars 2.63, Earth 1, 1.5g 0.41, 2g 0.12, 3g 0',
  near(jumpGravityFactor(0.165), 6.06) && near(jumpGravityFactor(0.38), 2.63) && jumpGravityFactor(1) === 1
  && near(jumpGravityFactor(1.5), 0.41) && near(jumpGravityFactor(2), 0.12) && jumpGravityFactor(3) === 0);

/* -------------------------------------------- */
/*  Speeds                                      */
/* -------------------------------------------- */

assert('combat speed (3 m/s species): AGI 25/100/200/400 → 0.75/3/6/12',
  near(combatSpeedMps({ agi: 25 }), 0.75) && near(combatSpeedMps({ agi: 100 }), 3)
  && near(combatSpeedMps({ agi: 200 }), 6) && near(combatSpeedMps({ agi: 400 }), 12));

assert('combat speed follows the species speed (1.5 m/s species, AGI 100 → 1.5)',
  near(combatSpeedMps({ agi: 100, speedMps: 1.5 }), 1.5));

assert('travel speed: END 25/50/100/200/400 → 0.70/0.99/1.40/1.98/2.80 m/s',
  near(travelSpeedMps({ agi: 100, end: 25 }), 0.7) && near(travelSpeedMps({ agi: 100, end: 50 }), 0.99)
  && near(travelSpeedMps({ agi: 100, end: 100 }), 1.4) && near(travelSpeedMps({ agi: 100, end: 200 }), 1.98)
  && near(travelSpeedMps({ agi: 100, end: 400 }), 2.8));

assert('travel speed never exceeds combat speed (AGI 20, END 300 → 0.6)',
  near(travelSpeedMps({ agi: 20, end: 300 }), 0.6));

/* -------------------------------------------- */
/*  Jumps                                       */
/* -------------------------------------------- */

assert('run long jump: sprint 3/6/12 m/s → 1.27/3.6/10.18 m',
  near(runningLongJumpM(3), 1.27) && near(runningLongJumpM(6), 3.6) && near(runningLongJumpM(12), 10.18));

assert('run long jump: 2g with sprint 4.24 → 0.25 m, 3g → 0',
  near(runningLongJumpM(4.24, 2), 0.25) && runningLongJumpM(3.46, 3) === 0);

{
  const h = heightThresholds({ agi: 100, heightM: 1.75 });
  assert('height thresholds (H 1.75, AGI 100, 1g) → 0.44 / 1.05 / 2.28 m',
    near(h.run, 0.4375) && near(h.climb, 1.05) && near(h.pull, 2.275), h);
  const moon = heightThresholds({ agi: 100, heightM: 1.75, gamma: 0.165 });
  assert('height thresholds on the Moon → 1.77 / 3.26 / 4.49 m',
    near(moon.run, 1.77) && near(moon.climb, 3.26) && near(moon.pull, 4.49), moon);
  const heavy = heightThresholds({ agi: 100, heightM: 1.75, gamma: 3 });
  assert('height thresholds at 3g keep only the body part → 0.18 / 0.61 / 1.84 m',
    near(heavy.run, 0.175) && near(heavy.climb, 0.6125) && near(heavy.pull, 1.8375), heavy);
}

/* -------------------------------------------- */
/*  Action speed                                */
/* -------------------------------------------- */

assert('action speed m: COR 0/50/100/200/400 → 0/0.67/1/1.33/1.6',
  actionSpeedMultiplier(0) === 0 && near(actionSpeedMultiplier(50), 0.67) && actionSpeedMultiplier(100) === 1
  && near(actionSpeedMultiplier(200), 1.33) && near(actionSpeedMultiplier(400), 1.6));

assert('action cost: base 10 → 10 at COR 100, 15 at COR 50, 8 at COR 200',
  applyActionSpeedToCost(10, 100) === 10 && applyActionSpeedToCost(10, 50) === 15
  && applyActionSpeedToCost(10, 200) === 8);

assert('action cost: zero and negative bases untouched; positive base never below 1',
  applyActionSpeedToCost(0, 50) === 0 && applyActionSpeedToCost(-5, 50) === -5
  && applyActionSpeedToCost(1, 400) === 1);

assert('action cost at COR 0 stays finite (capped ×20)',
  applyActionSpeedToCost(10, 0) === 200);

/* -------------------------------------------- */
/*  Scores and resources                        */
/* -------------------------------------------- */

assert('dexterity: arithmetic mean — 200/50 → 125, 150/100 → 125, 100/100 → 100',
  arithmeticMean(200, 50) === 125 && arithmeticMean(150, 100) === 125 && arithmeticMean(100, 100) === 100);

assert('geometric mean: 100/100 → 100, 200/50 → 100, 150/50 → 86.6',
  geometricMean(100, 100) === 100 && geometricMean(200, 50) === 100 && near(geometricMean(150, 50), 86.6));

assert('max AP: 100/100 → 100, 200/100 → 141, 200/200 → 200, 150/50 → 86, 50/50 → 50',
  maxApFromScores(100, 100) === 100 && maxApFromScores(200, 100) === 141 && maxApFromScores(200, 200) === 200
  && maxApFromScores(150, 50) === 86 && maxApFromScores(50, 50) === 50);

assert('heroism: LUC 16/25/36/49/64/100/144/196/400 → 2/3/3/4/4/5/6/7/10',
  [16, 25, 36, 49, 64, 100, 144, 196, 400].map(heroismPoints).join() === '2,3,3,4,4,5,6,7,10');

assert('second wind (END/LUC): 100/100 → 5, 100/50 → 4, 50/50 → 3, 200/100 → 7, 200/400 → 14',
  secondWindPoints(100, 100) === 5 && secondWindPoints(100, 50) === 4 && secondWindPoints(50, 50) === 3
  && secondWindPoints(200, 100) === 7 && secondWindPoints(200, 400) === 14);

assert('intuition: LUC/INT 100/100 → 10, 25/100 → 5, 50/100 → 7, 100/400 → 10, 400/100 → 10',
  intuitionMax(100, 100) === 10 && intuitionMax(25, 100) === 5 && intuitionMax(50, 100) === 7
  && intuitionMax(100, 400) === 10 && intuitionMax(400, 100) === 10);

assert('skill budget: PER/INT 50/50 → 25, 100/100 → 50, 100/200 → 71',
  skillBudget(50, 50) === 25 && skillBudget(100, 100) === 50 && skillBudget(100, 200) === 71);

/* -------------------------------------------- */
/*  Params                                      */
/* -------------------------------------------- */

assert('normalizeParams falls back to defaults for missing / non-numeric values',
  JSON.stringify(normalizeParams(undefined)) === JSON.stringify(DEFAULT_PARAMS)
  && normalizeParams({ gravity: 'x', turnStarts: 0 }).gravity === 1
  && normalizeParams({ turnStarts: 0 }).turnStarts === 1);

/* -------------------------------------------- */
/*  computeDerivedStats                         */
/* -------------------------------------------- */

{
  const d = computeDerivedStats({ abilities: avg });
  assert('average human: lift 80, carry 40, speeds 3 / 6 / 1.4, 3.33 AP per metre',
    near(d.liftWeight, 80) && near(d.carryWeight, 40) && near(d.combatSpeed, 3) && near(d.sprintSpeed, 6)
    && near(d.travelSpeed, 1.4) && near(d.speedApPerMeter, 3.33), d);
  assert('average human: max AP 100, 3 turn starts, heroism 5, second wind 5, intuition 10, budget 50',
    d.maxApFromAbilities === 100 && d.turnsPerRound === 3 && d.heroismPoints === 5
    && d.secondWindPoints === 5 && d.intuitionMax === 10 && d.skillBudget === 50, d);
  assert('average human: awareness 50 (PER × 0.5), will 100, dexterity / reaction / accuracy 100, hp ×1, action speed ×1',
    d.awarenessScore === 50 && d.willScore === 100 && d.dexterityScore === 100 && d.reactionScore === 100
    && d.accuracyScore === 100 && d.healthMult === 1 && d.actionSpeed === 1, d);
  assert('average human: long jump with run-up 3.6 m, thresholds 0.44 / 1.05 / 2.28 m',
    near(d.jumpLongRun, 3.6) && near(d.heightRun, 0.44) && near(d.heightClimb, 1.05) && near(d.heightPull, 2.28), d);

  const loaded = computeDerivedStats({ abilities: avg, loadKg: 60 });
  assert('load 60 kg on an average human slows movement to ×0.75 (4.44 AP per metre)',
    near(loaded.loadFactor, 0.75) && near(loaded.combatSpeed, 2.25) && near(loaded.speedApPerMeter, 4.44), loaded);

  const off = computeDerivedStats({ abilities: avg, loadKg: 60, encumbrance: false });
  assert('encumbrance can be switched off', off.loadFactor === 1 && near(off.combatSpeed, 3), off);

  const overloaded = computeDerivedStats({ abilities: avg, loadKg: 200 });
  assert('overload stops movement but AP per metre stays finite (min slice distance 0.25 m)',
    overloaded.combatSpeed === 0 && near(overloaded.speedApPerMeter, 40), overloaded);

  const moon = computeDerivedStats({ abilities: avg, params: { gravity: 0.165 } });
  assert('Moon: lift ×6.06, combat speed ×0.41',
    near(moon.liftWeight, 80 * 6.06, 0.5) && near(moon.combatSpeed, 3 * 0.406, 0.02), moon);

  const mods = computeDerivedStats({ abilities: avg, params: { awarenessMult: 0.25, willMult: 1.5, turnStarts: 4 } });
  assert('params feed awareness (×0.25 → 25), will (×1.5 → 150), turn starts (4)',
    mods.awarenessScore === 25 && mods.willScore === 150 && mods.turnsPerRound === 4, mods);

  const small = computeDerivedStats({ abilities: avg, speedMps: 1.5, heightM: 0.9 });
  assert('species speed and height scale the movement values (1.5 m/s, H 0.9)',
    near(small.combatSpeed, 1.5) && near(small.heightClimb, 0.9 * 0.6) && near(small.speedApPerMeter, 6.67), small);

  const empty = computeDerivedStats({});
  assert('empty input does not produce NaN',
    Object.values(empty).every((v) => Number.isFinite(v)), empty);
}

if (failed > 0) {
  console.log(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll derived-stats assertions passed.');

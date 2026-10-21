/**
 * Smoke tests for the body state and the outcome scale. Plain Node:
 *   node module/helpers/body-state.test.mjs
 */

import { applyBodyState, classifyOutcome, saturatedDamage, WOUND_OUTCOME_IDS } from './body-state.mjs';

let failed = 0;
function assert(label, cond, detail) {
  if (cond) console.log(`PASS  ${label}`);
  else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

/** A small humanoid: head (root, brain) ← neck ← torso (heart, lungs) ← arm. */
function body() {
  return {
    head: { name: 'Head', maxHp: 80, tissue: { bleed: 6 }, relations: [], inners: [{ id: 'brain', occupancyPct: 50, maxHp: 40, bleed: 0, tags: ['vital'] }] },
    neck: { name: 'Neck', maxHp: 100, tissue: { bleed: 30 }, relations: [{ kind: 'parent', target: 'head' }], inners: [] },
    torso: {
      name: 'Torso', maxHp: 160, tissue: { bleed: 10 }, relations: [{ kind: 'parent', target: 'neck' }],
      inners: [{ id: 'heart', occupancyPct: 15, maxHp: 60, bleed: 40, tags: ['vital'] }, { id: 'lungs', occupancyPct: 40, maxHp: 60, bleed: 15, tags: [] }],
    },
    arm: { name: 'Arm', maxHp: 120, tissue: { bleed: 5 }, relations: [{ kind: 'parent', target: 'torso' }], inners: [] },
  };
}

/** Outcome of one hit: wounds → state → class. */
function outcome(hitSlot, wounds, options = {}) {
  const parts = body();
  const state = applyBodyState(parts, wounds, { rootRef: 'head', ...options });
  const damageBySlot = {};
  for (const w of wounds) damageBySlot[w.slotRef] = (damageBySlot[w.slotRef] ?? 0) + w.amount;
  const organHits = wounds.flatMap((w) => (w.inners ?? []).map((o) => ({ slot: w.slotRef, id: o.id })));
  return { parts, state, out: classifyOutcome({ bodyParts: parts, ...state }, { hitSlot, damageBySlot, organHits }) };
}

const wound = (slotRef, amount, type = 'ballistic', inners) => ({ slotRef, amount, initialAmount: amount, type, ...(inners ? { inners } : {}) });

// --- body state ------------------------------------------------------------------------------------------
{
  const { parts, state } = outcome('arm', [wound('arm', 30.6)]);
  assert('HP: whole units of damage come off', parts.arm.currentHp === 90 && parts.arm.healthPercentage === 75, parts.arm);
  assert('nothing lost, nobody dead or dying', !parts.arm.lost && !state.death.dead && !state.death.dying);
}
{
  const { parts } = outcome('torso', [wound('torso', 200)]);
  assert('a part at 0 HP is lost with what hangs below it', parts.torso.lost && parts.arm.lost && parts.arm.lostVia === 'torso' && !parts.torso.lostVia);
  assert('its organs are lost with it', parts.torso.inners.every((o) => o.status === 'lost'));
}
{
  const { parts } = outcome('arm', [wound('arm', 30)], { hpScale: 1.5 });
  assert('END scales the HP of parts and organs', parts.arm.effectiveMaxHp === 180 && parts.head.inners[0].effectiveMaxHp === 60);
}

// --- the outcome scale -----------------------------------------------------------------------------------
{
  assert('ids run from the mildest to the worst', WOUND_OUTCOME_IDS.join() === 'stopped,graze,light,severe,mortal,destroyed,death');
  assert('nothing reached the body → stopped', outcome('torso', []).out.id === 'stopped');
  assert('under 1 HP → still stopped', outcome('torso', [wound('torso', 0.6)]).out.id === 'stopped');
  assert('a few HP (under 5% of the part) → graze', outcome('torso', [wound('torso', 4)]).out.id === 'graze');
  assert('5–30% → light', outcome('torso', [wound('torso', 20)]).out.id === 'light');
  assert('30% or more → severe', outcome('torso', [wound('torso', 60)]).out.id === 'severe');
  assert('the worst wound counts, not the hit part only (a blow passed to the neck)',
    outcome('head', [wound('head', 10, 'concussive'), wound('neck', 40, 'concussive')]).out.id === 'severe');
  assert('a hit organ that is not vital → severe at least',
    outcome('torso', [wound('torso', 10, 'ballistic', [{ id: 'lungs', amount: 5 }])]).out.id === 'severe');
}
{
  const brain = outcome('head', [wound('head', 40, 'ballistic', [{ id: 'brain', amount: 20 }])]);
  assert('a damaged brain → mortal (dying)', brain.out.id === 'mortal' && brain.state.death.dying, brain.out);
  const dead = outcome('head', [wound('head', 60, 'ballistic', [{ id: 'brain', amount: 45 }])]);
  assert('a destroyed brain → death', dead.out.id === 'death' && dead.out.fatal === false, dead.out);
  const neck = outcome('neck', [wound('neck', 80)]);
  assert('a neck wound bleeding out in minutes → mortal', neck.out.id === 'mortal' && neck.state.bleeding.mortal, neck.state.bleeding);
}
{
  const head = outcome('head', [wound('head', 90)]);
  assert('the head lost → destroyed, and fatal', head.out.id === 'destroyed' && head.out.fatal === true, head.out);
  const arm = outcome('arm', [wound('arm', 130)]);
  assert('an arm lost → destroyed, not fatal by itself', arm.out.id === 'destroyed' && arm.out.fatal === false, arm.out);
  assert('the reasons are listed', head.out.why.length > 0 && head.out.why[0].includes('Head'));
}

// --- structure: saturation and reserve -------------------------------------------------------------------
{
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
  assert('no saturation — the plain sum', saturatedDamage(150, 50, 0) === 150);
  assert('up to the biggest wound everything counts', saturatedDamage(50, 50, 2) === 50);
  const two = saturatedDamage(100, 50, 2);
  const three = saturatedDamage(150, 50, 2);
  assert('the second equal hit counts less than the first, the third less than the second',
    two - 50 < 50 && three - two < two - 50, { two, three });
  assert('equal hits never go past saturation × the hit', saturatedDamage(50 * 1000, 50, 2) < 100 + 1e-9);
  assert('saturation 1 — only the biggest wound counts', saturatedDamage(300, 50, 1) === 50);
  assert('order does not matter (sum and the biggest only)', near(saturatedDamage(170, 120, 2), saturatedDamage(50 + 120, 120, 2)));
}
{
  // A torso that saturates at 2× and is destroyed only at −50%: a part of 100 HP.
  const torso = (wounds) => {
    const parts = {
      torso: { name: 'Torso', maxHp: 100, structure: { saturation: 2, reserve: 0.5 }, relations: [], inners: [] },
      arm: { name: 'Arm', maxHp: 50, relations: [{ kind: 'parent', target: 'torso' }], inners: [] },
    };
    applyBodyState(parts, wounds.map((amount) => wound('torso', amount)), { rootRef: null });
    return parts;
  };
  const pistol = torso(Array(10).fill(53));
  assert('ten pistol hits: the torso is disabled, not destroyed', pistol.torso.disabled && !pistol.torso.lost && pistol.torso.currentHp < 0 && pistol.torso.currentHp > -50, pistol.torso);
  assert('a disabled part does not take what hangs below it', !pistol.arm.lost);
  const cuts = torso(Array(1000).fill(0.5));
  assert('a thousand tiny cuts barely scratch it', cuts.torso.currentHp >= 99, cuts.torso.currentHp);
  const rifle = torso([86, 86, 86]);
  assert('three hits of 86% destroy it, with what hangs below', rifle.torso.lost && rifle.arm.lost && rifle.arm.lostVia === 'torso');
  const big = torso([172]);
  assert('one hit of 172% destroys it at once', big.torso.lost);
  const plainParts = { p: { maxHp: 100, relations: [], inners: [] } };
  applyBodyState(plainParts, [wound('p', 100)], { rootRef: null });
  assert('without a structure 0 HP is still lost', plainParts.p.lost && !plainParts.p.disabled, plainParts.p);
}
{
  const parts = { torso: { name: 'Torso', maxHp: 100, structure: { saturation: 2, reserve: 0.5 }, tissue: { bleed: 10 }, relations: [], inners: [] } };
  const wounds = Array(4).fill(0).map(() => wound('torso', 53));
  const state = applyBodyState(parts, wounds, { rootRef: null });
  const out = classifyOutcome({ bodyParts: parts, ...state }, { hitSlot: 'torso', damageBySlot: { torso: 212 } });
  assert('the outcome reads the HP the body shows (saturated), and says the part does not work',
    out.why[0].includes(`${100 - parts.torso.currentHp}% HP`) && out.why[0].includes('не работает'), out.why);
  assert('bleeding still takes the raw wounds', state.bleeding.rate > 0.53 * 10 * 4 - 1e-6, state.bleeding);
}

if (failed) {
  console.log(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll body-state checks passed');

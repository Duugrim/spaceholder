/**
 * Smoke tests for the static bleeding model. Plain Node:
 *   node module/helpers/damage/bleeding.test.mjs
 */

import { BLOOD_POOL, LOST_PART_BLEED, MORTAL_BLEED_MINUTES, computeBleeding, woundStageFactor } from './bleeding.mjs';

let failed = 0;
function assert(label, cond, detail) {
  if (cond) console.log(`PASS  ${label}`);
  else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

const parts = {
  torso: { maxHp: 100, tissue: { bleed: 10 }, inners: [{ id: 'heart', maxHp: 20, bleed: 40 }] },
  neck: { maxHp: 50, tissue: { bleed: 30 } },
  arm: { maxHp: 80, tissue: { bleed: 5 } },
};

// Stage: open wound bleeds fully, closing or treated a quarter, scarring nothing.
assert('an open wound bleeds fully', woundStageFactor({ amount: 10, initialAmount: 10 }) === 1);
assert('a treated open wound bleeds a quarter', woundStageFactor({ amount: 10, initialAmount: 10, status: 'treated' }) === 0.25);
assert('a closing wound bleeds a quarter', woundStageFactor({ amount: 7, initialAmount: 10 }) === 0.25);
assert('a scarring wound does not bleed', woundStageFactor({ amount: 3, initialAmount: 10 }) === 0);
assert('a bionic part does not bleed', woundStageFactor({ amount: 10, initialAmount: 10 }, 'bionic') === 0);

// A bullet wound of half the torso: 0.5 × 10 × 1 = 5 %/min → 20 minutes.
{
  const res = computeBleeding({ bodyParts: parts, wounds: [{ slotRef: 'torso', amount: 50, initialAmount: 50, type: 'ballistic' }] });
  assert('a wound bleeds by its share of the part × part bleed × type', near(res.rate, 5), res);
  assert('time to death = blood pool / rate', near(res.minutesToDeath, BLOOD_POOL / 5));
  assert('20 minutes is not mortal yet', res.mortal === false && MORTAL_BLEED_MINUTES < 20);
}

// Types: a cut bleeds 1.5×, a blow 0.15×, a burn not at all.
{
  const one = (type) => computeBleeding({ bodyParts: parts, wounds: [{ slotRef: 'arm', amount: 40, initialAmount: 40, type }] }).rate;
  assert('a cut bleeds more than a bullet', near(one('cutting'), 1.5 * one('ballistic')));
  assert('a blow bleeds little', near(one('concussive'), 0.15 * one('ballistic')));
  assert('a burn does not bleed', one('thermal') === 0);
}

// An organ adds its own bleeding: heart 10/20 × 40 = 20 %/min.
{
  const res = computeBleeding({
    bodyParts: parts,
    wounds: [{ slotRef: 'torso', amount: 20, initialAmount: 20, type: 'ballistic', inners: [{ id: 'heart', amount: 10 }] }],
  });
  assert('a heart hit bleeds out within minutes', near(res.rate, 0.2 * 10 + 20) && res.mortal === true, res);
}

// A neck wound bleeds fast: 45/50 × 30 = 27 %/min → under 4 minutes.
{
  const res = computeBleeding({ bodyParts: parts, wounds: [{ slotRef: 'neck', amount: 45, initialAmount: 45, type: 'ballistic' }] });
  assert('a neck wound is mortal by bleeding', res.mortal === true && res.minutesToDeath < 4, res);
}

// A lost part bleeds as a stump; parts lost with their parent do not add again.
{
  const lostParts = {
    arm: { maxHp: 80, tissue: { bleed: 5 }, lost: true, lostVia: null },
    hand: { maxHp: 40, tissue: { bleed: 3 }, lost: true, lostVia: 'arm' },
  };
  const res = computeBleeding({ bodyParts: lostParts, wounds: [] });
  assert('a stump bleeds part bleed × LOST_PART_BLEED, once', near(res.rate, 5 * LOST_PART_BLEED) && !res.bySlot.hand, res);
  const torn = computeBleeding({ bodyParts: { thigh: { maxHp: 180, tissue: { bleed: 6 }, lost: true, lostVia: null, inners: [{ id: 'artery', bleed: 80 }] } }, wounds: [] });
  assert('a part torn off bleeds from the organs it held too (a thigh — the artery)', near(torn.rate, 6 * LOST_PART_BLEED + 80) && torn.mortal, torn);
}

// Nothing bleeds → no death by bleeding.
{
  const res = computeBleeding({ bodyParts: parts, wounds: [] });
  assert('no wounds — infinite time, not mortal', res.minutesToDeath === Infinity && res.mortal === false);
}

if (failed) {
  console.log(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll bleeding checks passed');

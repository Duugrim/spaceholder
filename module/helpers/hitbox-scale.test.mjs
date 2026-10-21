/**
 * Smoke tests for the hitbox scale parameter (`system.hitboxScale`, percent).
 * Runs in plain Node (no Foundry globals required). Execute with:
 *   node module/helpers/hitbox-scale.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if
 * any assertion fails.
 */

import {
  HITBOX_SCALE_DEFAULT,
  HITBOX_SCALE_MAX,
  HITBOX_SCALE_MIN,
  hitboxScaleFactor,
  normalizeHitboxScale,
} from './hitbox-scale.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const near = (a, b) => Math.abs(a - b) < 1e-9;

// --- normalizeHitboxScale ---------------------------------------------------
assert('default is 100%', HITBOX_SCALE_DEFAULT === 100);
assert('missing → 100', normalizeHitboxScale(undefined) === 100 && normalizeHitboxScale(null) === 100 && normalizeHitboxScale('') === 100);
assert('invalid → 100', normalizeHitboxScale('abc') === 100 && normalizeHitboxScale(NaN) === 100 && normalizeHitboxScale({}) === 100);
assert('plain values pass through', normalizeHitboxScale(60) === 60 && normalizeHitboxScale('75') === 75 && normalizeHitboxScale(100) === 100);
assert('fractions are kept (not rounded)', near(normalizeHitboxScale(62.5), 62.5));
assert('clamped to the minimum', normalizeHitboxScale(0) === HITBOX_SCALE_MIN && normalizeHitboxScale(-40) === HITBOX_SCALE_MIN);
assert('clamped to the maximum', normalizeHitboxScale(5000) === HITBOX_SCALE_MAX);
assert('above 100 is allowed (rare)', normalizeHitboxScale(150) === 150);

// --- hitboxScaleFactor ------------------------------------------------------
assert('factor: 100% → 1', near(hitboxScaleFactor({ system: { hitboxScale: 100 } }), 1));
assert('factor: 50% → 0.5', near(hitboxScaleFactor({ system: { hitboxScale: 50 } }), 0.5));
assert('factor: 150% → 1.5', near(hitboxScaleFactor({ system: { hitboxScale: 150 } }), 1.5));
assert('factor: no actor → 1', near(hitboxScaleFactor(null), 1) && near(hitboxScaleFactor(undefined), 1));
assert('factor: actor without the parameter → 1', near(hitboxScaleFactor({ system: {} }), 1));
assert('factor: other actor types / old data → 1', near(hitboxScaleFactor({ system: { abilities: { dex: { value: 30 } } } }), 1));
assert('factor: base characteristics are ignored',
  near(hitboxScaleFactor({ system: { hitboxScale: 80, abilities: { dex: { value: 1 }, end: { value: 99 } } } }), 0.8));

if (failed) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll hitbox-scale tests passed');

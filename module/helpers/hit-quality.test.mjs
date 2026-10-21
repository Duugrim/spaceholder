/**
 * Smoke tests for hit-quality: the zones of the hitbox, the even fall of the energy multiplier, the
 * settings normalization and the crit-effect values. Runs in plain Node (no Foundry globals
 * required). Execute with:
 *   node module/helpers/hit-quality.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

import {
  CRIT_EFFECTS,
  HIT_QUALITY_DEFAULTS,
  HIT_QUALITY_TIER,
  computeHitQuality,
  getHitQualityConfig,
  normalizeCritEffect,
  normalizeHitQualityConfig,
} from './hit-quality.mjs';
import { createWeaponMode, normalizeWeaponMode, resolveModeCritEffect } from './weapon/weapon-model.mjs';

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

// --- config -------------------------------------------------------------------------------------
{
  const cfg = normalizeHitQualityConfig();
  assert('defaults: full zone 30%, bullseye 10%, edge 10% (percent → fractions)',
    near(cfg.fullZone, 0.3) && near(cfg.critZone, 0.1) && near(cfg.edgeEnergy, 0.1), cfg);
  assert('defaults match the exported constants',
    HIT_QUALITY_DEFAULTS.fullZone === 30 && HIT_QUALITY_DEFAULTS.critZone === 10 && HIT_QUALITY_DEFAULTS.edgeEnergy === 10);
  assert('without Foundry the config falls back to the defaults', near(getHitQualityConfig().fullZone, 0.3));
  const wide = normalizeHitQualityConfig({ fullZone: 20, critZone: 60, edgeEnergy: 250 });
  assert('the bullseye cannot be wider than the full zone, the edge multiplier is clamped',
    near(wide.critZone, 0.2) && near(wide.edgeEnergy, 1), wide);
  const junk = normalizeHitQualityConfig({ fullZone: 'abc', critZone: null, edgeEnergy: -5 });
  assert('junk falls back to defaults, negative clamps to 0', near(junk.fullZone, 0.3) && near(junk.critZone, 0.1) && junk.edgeEnergy === 0, junk);
}

// --- zones --------------------------------------------------------------------------------------
const CFG = normalizeHitQualityConfig({ fullZone: 30, critZone: 10, edgeEnergy: 10 });
const q = (c) => computeHitQuality(c, CFG);

assert('dead centre → bullseye: crit, full energy',
  q(1).tier === HIT_QUALITY_TIER.CRIT && q(1).crit === true && q(1).multiplier === 1, q(1));
assert('on the bullseye border (10% of the radius off) → still crit', q(0.9).crit === true && q(0.9).multiplier === 1, q(0.9));
assert('just outside the bullseye → full, not crit', q(0.89).tier === HIT_QUALITY_TIER.FULL && q(0.89).crit === false && q(0.89).multiplier === 1, q(0.89));
assert('on the full-zone border (30% off) → full energy', q(0.7).tier === HIT_QUALITY_TIER.FULL && q(0.7).multiplier === 1, q(0.7));
assert('just outside the full zone → glancing, but only barely less than ×1',
  q(0.69).tier === HIT_QUALITY_TIER.GLANCING && q(0.69).multiplier < 1 && q(0.69).multiplier > 0.98, q(0.69));
assert('the edge of the hitbox → the edge multiplier', near(q(0).multiplier, 0.1) && q(0).tier === HIT_QUALITY_TIER.GLANCING, q(0));
assert('halfway between the full zone and the edge → halfway between ×1 and the edge multiplier',
  near(q(0.35).multiplier, 0.55), q(0.35));

// the fall is even: equal steps of centrality give equal steps of the multiplier
{
  const a = q(0.6).multiplier;
  const b = q(0.5).multiplier;
  const c = q(0.4).multiplier;
  assert('the fall is linear (uniform), no steps', near(a - b, b - c, 1e-12), { a, b, c });
}
{
  let monotone = true;
  let prev = Infinity;
  let maxStep = 0;
  for (let i = 100; i >= 0; i -= 1) {
    const m = q(i / 100).multiplier;
    if (m > prev + 1e-12) monotone = false;
    if (Number.isFinite(prev)) maxStep = Math.max(maxStep, prev - m);
    prev = m;
  }
  assert('the multiplier never rises towards the edge and never jumps (no hit/miss threshold)',
    monotone && maxStep < 0.02, { monotone, maxStep });
}

// --- degenerate input ------------------------------------------------------------------------------
assert('no centrality (nothing to measure) → full hit, never a crit',
  computeHitQuality(undefined, CFG).tier === HIT_QUALITY_TIER.FULL && computeHitQuality(null, CFG).crit === false
  && computeHitQuality(NaN, CFG).multiplier === 1 && computeHitQuality('x', CFG).centrality === null);
assert('centrality is clamped to 0…1', q(5).crit === true && q(5).multiplier === 1 && near(q(-3).multiplier, 0.1));
{
  const noCrit = computeHitQuality(1, normalizeHitQualityConfig({ fullZone: 30, critZone: 0, edgeEnergy: 10 }));
  assert('a bullseye of size 0 never crits', noCrit.crit === false && noCrit.tier === HIT_QUALITY_TIER.FULL, noCrit);
  const wholeToken = computeHitQuality(0, normalizeHitQualityConfig({ fullZone: 100, critZone: 10, edgeEnergy: 10 }));
  assert('a full zone as wide as the token has no glancing hits', wholeToken.multiplier === 1 && wholeToken.tier === HIT_QUALITY_TIER.FULL, wholeToken);
  const noFloor = computeHitQuality(0, normalizeHitQualityConfig({ fullZone: 30, critZone: 10, edgeEnergy: 0 }));
  assert('edge multiplier 0: a tangent hit carries no energy', noFloor.multiplier === 0, noFloor);
}

// --- crit effects ----------------------------------------------------------------------------------------
assert('crit effect: known values pass', normalizeCritEffect('pickPart') === CRIT_EFFECTS.PICK_PART && normalizeCritEffect('none') === CRIT_EFFECTS.NONE);
assert('crit effect: unknown / empty means "by the fire mode"',
  normalizeCritEffect('') === CRIT_EFFECTS.DEFAULT && normalizeCritEffect(undefined) === CRIT_EFFECTS.DEFAULT && normalizeCritEffect('boom') === CRIT_EFFECTS.DEFAULT);

// by fire mode: a single shot picks the part, a burst / automatic fire does nothing (yet)
{
  const byMode = (fireMode, critEffect) => resolveModeCritEffect(createWeaponMode({ fireMode, critEffect }));
  assert('crit effect by fire mode: single → pick the part, burst and auto → nothing',
    byMode('single') === CRIT_EFFECTS.PICK_PART && byMode('burst') === CRIT_EFFECTS.NONE && byMode('auto') === CRIT_EFFECTS.NONE);
  assert('an explicit crit effect beats the fire mode',
    byMode('auto', 'pickPart') === CRIT_EFFECTS.PICK_PART && byMode('single', 'none') === CRIT_EFFECTS.NONE);
  assert('a mode saved without the field resolves by its fire mode',
    resolveModeCritEffect(normalizeWeaponMode({ fireMode: 'auto' })) === CRIT_EFFECTS.NONE
    && resolveModeCritEffect(normalizeWeaponMode({ fireMode: 'single' })) === CRIT_EFFECTS.PICK_PART);
  assert('the mode keeps "by fire mode" as its stored value until it is set', normalizeWeaponMode({}).critEffect === CRIT_EFFECTS.DEFAULT);
}

if (failed) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll hit-quality tests passed');

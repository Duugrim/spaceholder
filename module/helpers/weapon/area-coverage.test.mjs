/**
 * Smoke tests for AoE coverage modes (circle / cone / swingFan segments).
 * Runs in plain Node (no Foundry globals required). Execute with:
 *   node module/helpers/weapon/area-coverage.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if
 * any assertion fails.
 */

import {
  AREA_COVERAGE_MODES,
  applyEnergyScaleToApplications,
  falloffMultiplier,
  normalizeAreaCoverageMode,
  normalizeAreaExcludeDirectHit,
  normalizeAreaIgnoreDirectHitCover,
  normalizeAreaLineOfSight,
  normalizeCoverageForFullEffect,
  normalizeOnHitSplash,
  resolveAreaCoverageEffect,
} from './damage-profile.mjs';
import { applyOnHitSplashToPayload } from './trajectory.mjs';

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

// --- normalizeAreaCoverageMode ---------------------------------------------
assert('normalize: known ids pass through',
  ['proportional', 'any', 'center', 'full'].every((m) => normalizeAreaCoverageMode(m) === m));
assert('normalize: case / whitespace tolerant', normalizeAreaCoverageMode('  CENTER ') === 'center');
assert('normalize: unknown → proportional', normalizeAreaCoverageMode('bogus') === AREA_COVERAGE_MODES.PROPORTIONAL);
assert('normalize: undefined → proportional', normalizeAreaCoverageMode(undefined) === AREA_COVERAGE_MODES.PROPORTIONAL);

// --- proportional -----------------------------------------------------------
{
  const r = resolveAreaCoverageEffect('proportional', { coverage: 0.4, centerCovered: false });
  assert('proportional: scale = coverage', r.applies && near(r.scale, 0.4), r);
  assert('proportional: zero coverage → not applied', !resolveAreaCoverageEffect('proportional', { coverage: 0 }).applies);
  const full = resolveAreaCoverageEffect('proportional', { coverage: 1, centerCovered: true });
  assert('proportional: full coverage → scale 1', full.applies && near(full.scale, 1), full);
}

// --- any --------------------------------------------------------------------
{
  const r = resolveAreaCoverageEffect('any', { coverage: 0.02, centerCovered: false });
  assert('any: tiny coverage → full effect', r.applies && near(r.scale, 1), r);
  assert('any: zero coverage → not applied', !resolveAreaCoverageEffect('any', { coverage: 0 }).applies);
}

// --- center -----------------------------------------------------------------
{
  const inside = resolveAreaCoverageEffect('center', { coverage: 0.2, centerCovered: true });
  assert('center: center inside → full effect', inside.applies && near(inside.scale, 1), inside);
  const outside = resolveAreaCoverageEffect('center', { coverage: 0.9, centerCovered: false });
  assert('center: center outside → no effect even at 90% coverage', !outside.applies && outside.scale === 0, outside);
}

// --- full -------------------------------------------------------------------
{
  const whole = resolveAreaCoverageEffect('full', { coverage: 64 / 64, centerCovered: true });
  assert('full: 100% → full effect', whole.applies && near(whole.scale, 1), whole);
  const almost = resolveAreaCoverageEffect('full', { coverage: 63 / 64, centerCovered: true });
  assert('full: 63/64 → no effect', !almost.applies && almost.scale === 0, almost);
}

// --- misc -------------------------------------------------------------------
{
  const unknown = resolveAreaCoverageEffect('nope', { coverage: 0.5 });
  assert('unknown mode behaves as proportional', unknown.mode === 'proportional' && near(unknown.scale, 0.5), unknown);
  const over = resolveAreaCoverageEffect('proportional', { coverage: 1.5 });
  assert('coverage is clamped to 1', near(over.scale, 1), over);
  const noArgs = resolveAreaCoverageEffect(undefined);
  assert('no sample → not applied', !noArgs.applies, noArgs);
}

// --- coverageForFullEffect --------------------------------------------------
assert('fullEffect: default (undefined) → 100', normalizeCoverageForFullEffect(undefined) === 100 && normalizeCoverageForFullEffect('') === 100 && normalizeCoverageForFullEffect(null) === 100);
assert('fullEffect: invalid → 100', normalizeCoverageForFullEffect('abc') === 100 && normalizeCoverageForFullEffect(NaN) === 100);
assert('fullEffect: clamped to [1, 100]', normalizeCoverageForFullEffect(0) === 1 && normalizeCoverageForFullEffect(-5) === 1 && normalizeCoverageForFullEffect(250) === 100);
assert('fullEffect: plain values pass through', normalizeCoverageForFullEffect(50) === 50 && normalizeCoverageForFullEffect('25') === 25);
{
  const half = resolveAreaCoverageEffect('proportional', { coverage: 0.25 }, 50);
  assert('fullEffect 50: coverage 25% → half the effect', half.applies && near(half.scale, 0.5), half);
  const capped = resolveAreaCoverageEffect('proportional', { coverage: 0.6 }, 50);
  assert('fullEffect 50: coverage 60% → capped at the full effect', near(capped.scale, 1), capped);
  const exact = resolveAreaCoverageEffect('proportional', { coverage: 0.5 }, 50);
  assert('fullEffect 50: coverage 50% → exactly the full effect', near(exact.scale, 1), exact);
  const dflt = resolveAreaCoverageEffect('proportional', { coverage: 0.4 });
  assert('fullEffect unset: scale = coverage (unchanged behaviour)', near(dflt.scale, 0.4), dflt);
  const none = resolveAreaCoverageEffect('proportional', { coverage: 0 }, 50);
  assert('fullEffect: zero coverage still not applied', !none.applies && none.scale === 0, none);
  const anyMode = resolveAreaCoverageEffect('any', { coverage: 0.1 }, 50);
  assert('fullEffect does not touch the non-proportional modes', near(anyMode.scale, 1), anyMode);
  assert('splash carries coverageForFullEffect',
    normalizeOnHitSplash({ coverageForFullEffect: 40 }).coverageForFullEffect === 40
    && normalizeOnHitSplash({}).coverageForFullEffect === 100);
  const base = { id: 'p', trajectory: { segments: [{ type: 'line', length: 10, onHit: 'stop' }] } };
  const out = applyOnHitSplashToPayload(base, { enabled: true, radius: 2, coverageForFullEffect: 40 }, { grid: { distance: 1 } });
  assert('splash circle gets coverageForFullEffect', out.trajectory.segments.find((s) => s.type === 'circle')?.coverageForFullEffect === 40);
}

// --- line of sight ----------------------------------------------------------
assert('los: default (undefined) → on', normalizeAreaLineOfSight(undefined) === true);
assert('los: true → on', normalizeAreaLineOfSight(true) === true);
assert('los: false → off', normalizeAreaLineOfSight(false) === false);
assert('los: only an explicit false turns it off', normalizeAreaLineOfSight(0) === true && normalizeAreaLineOfSight(null) === true);

// --- exclude direct hit -----------------------------------------------------
assert('excludeDirectHit: default (undefined) → off', normalizeAreaExcludeDirectHit(undefined) === false);
assert('excludeDirectHit: true → on', normalizeAreaExcludeDirectHit(true) === true);
assert('excludeDirectHit: only an explicit true turns it on',
  normalizeAreaExcludeDirectHit('true') === false && normalizeAreaExcludeDirectHit(1) === false);

// --- ignore direct-hit cover ------------------------------------------------
assert('ignoreDirectHitCover: default (undefined) → off', normalizeAreaIgnoreDirectHitCover(undefined) === false);
assert('ignoreDirectHitCover: true → on', normalizeAreaIgnoreDirectHitCover(true) === true);
assert('ignoreDirectHitCover: only an explicit true turns it on',
  normalizeAreaIgnoreDirectHitCover('true') === false && normalizeAreaIgnoreDirectHitCover(1) === false);
assert('ignoreDirectHitCover is independent of excludeDirectHit',
  normalizeAreaExcludeDirectHit(true) === true && normalizeAreaIgnoreDirectHitCover(undefined) === false);

// --- on-hit splash carries the mode ----------------------------------------
{
  assert('splash: default ignoreDirectHitCover is off', normalizeOnHitSplash({ enabled: true, radius: 2 }).ignoreDirectHitCover === false);
  assert('splash: ignoreDirectHitCover true kept', normalizeOnHitSplash({ ignoreDirectHitCover: true }).ignoreDirectHitCover === true);
  {
    const base = { id: 'p', trajectory: { segments: [{ type: 'line', length: 10, onHit: 'stop' }] } };
    const out = applyOnHitSplashToPayload(base, { enabled: true, radius: 2, ignoreDirectHitCover: true }, { grid: { distance: 1 } });
    const circle = out.trajectory.segments.find((s) => s.type === 'circle');
    assert('splash circle gets ignoreDirectHitCover', circle?.ignoreDirectHitCover === true, circle);
    const line = out.trajectory.segments.find((s) => s.type === 'line');
    assert('splash turns the primary line into `need`', line?.onHit === 'need', line);
  }
  assert('splash: default excludeDirectHit is off', normalizeOnHitSplash({ enabled: true, radius: 2 }).excludeDirectHit === false);
  assert('splash: excludeDirectHit true kept', normalizeOnHitSplash({ excludeDirectHit: true }).excludeDirectHit === true);
  {
    const base = { id: 'p', trajectory: { segments: [{ type: 'line', length: 10, onHit: 'stop' }] } };
    const out = applyOnHitSplashToPayload(base, { enabled: true, radius: 2, excludeDirectHit: true }, { grid: { distance: 1 } });
    const circle = out.trajectory.segments.find((s) => s.type === 'circle');
    assert('splash circle gets excludeDirectHit', circle?.excludeDirectHit === true, circle);
  }
  assert('splash: default coverage is proportional', normalizeOnHitSplash({ enabled: true, radius: 2 }).coverage === 'proportional');
  assert('splash: coverage kept', normalizeOnHitSplash({ enabled: true, radius: 2, coverage: 'full' }).coverage === 'full');
  assert('splash: bad coverage → proportional', normalizeOnHitSplash({ coverage: 'x' }).coverage === 'proportional');
  assert('splash: default lineOfSight is on', normalizeOnHitSplash({ enabled: true, radius: 2 }).lineOfSight === true);
  assert('splash: lineOfSight false kept', normalizeOnHitSplash({ lineOfSight: false }).lineOfSight === false);

  const base = { id: 'p', trajectory: { segments: [{ type: 'line', length: 10, onHit: 'stop' }] } };
  const withSplash = applyOnHitSplashToPayload(base, { enabled: true, radius: 2, coverage: 'any', lineOfSight: false }, { grid: { distance: 1 } });
  const circle = withSplash.trajectory.segments.find((s) => s.type === 'circle');
  assert('splash circle gets coverageMode', circle?.coverageMode === 'any', circle);
  assert('splash circle gets lineOfSight', circle?.lineOfSight === false, circle);
  assert('splash: source payload not mutated', base.trajectory.segments.length === 1 && base.trajectory.segments[0].onHit === 'stop');
}

// --- distance falloff: energy halves at halfDistance, damage follows, armorPen stays ---------
{
  const phases = [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 100, armorPen: 2, hardness: 3, energy: 1200 }] }];
  const k = falloffMultiplier(40, { enabled: true, halfDistance: 40 });
  assert('falloff multiplier at halfDistance is 0.5', near(k, 0.5), k);
  const at = applyEnergyScaleToApplications(phases, k)[0].items[0];
  assert('falloff: energy halved, damage follows, armorPen kept',
    near(at.energy, 600) && near(at.damage, 50) && near(at.armorPen, 2), at);
  assert('falloff off → multiplier 1', falloffMultiplier(500, { enabled: false, halfDistance: 40 }) === 1);
  assert('multiplier 1 returns phases untouched', applyEnergyScaleToApplications(phases, 1) === phases);
  assert('source phases not mutated', phases[0].items[0].damage === 100 && phases[0].items[0].energy === 1200);
}

if (failed) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll area-coverage tests passed');

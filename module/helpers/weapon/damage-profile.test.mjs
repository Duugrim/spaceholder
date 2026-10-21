/**
 * Smoke tests for damage entries with `effortShare` (melee damage from the wielder's STR).
 * Runs in plain Node (no Foundry globals required). Execute with:
 *   node module/helpers/weapon/damage-profile.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if
 * any assertion fails.
 */

import {
  EFFORT_REFERENCE,
  activeDamageEntries,
  buildProjectileFromDamageEntries,
  computeProjectileEnergy,
  entryDamageAtEffort,
  normalizeDamageEntry,
  resolveEntriesEffort,
} from './damage-profile.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sword = { damageType: 'cutting', damage: 0, effortShare: 90, armorPen: 30 };
const bullet = { damageType: 'ballistic', damage: 100, armorPen: 200 };

assert('effortShare is normalized: default 0, never negative',
  normalizeDamageEntry({ damageType: 'x', damage: 5 }).effortShare === 0
  && normalizeDamageEntry({ damageType: 'x', effortShare: -4 }).effortShare === 0
  && normalizeDamageEntry(sword).effortShare === 90);

assert('a pure-effort entry (damage 0, share > 0) is active; an empty one is not',
  activeDamageEntries([sword, bullet, { damageType: 'x' }, { damage: 5 }]).length === 2);

assert('damage at effort: sword 90% → 90 at STR 100, 45 at STR 50, 180 at STR 200',
  near(entryDamageAtEffort(sword, 100), 90) && near(entryDamageAtEffort(sword, 50), 45)
  && near(entryDamageAtEffort(sword, 200), 180));

assert('fixed damage ignores the effort (bullet stays 100)',
  entryDamageAtEffort(bullet, 40) === 100 && entryDamageAtEffort(bullet, 400) === 100);

assert('flat damage and share add up (20 + 50% of STR 100 = 70)',
  near(entryDamageAtEffort({ damageType: 'x', damage: 20, effortShare: 50 }, 100), 70));

{
  const [r] = resolveEntriesEffort([sword], 200);
  assert('resolveEntriesEffort bakes the effort in and clears the share',
    near(r.damage, 180) && r.effortShare === 0 && r.armorPen === 30);
  const same = { damageType: 'x', damage: 7 };
  assert('entries without a share are returned untouched', resolveEntriesEffort([same], 500)[0] === same);
}

assert('energy preview uses the reference effort (STR 100)',
  near(computeProjectileEnergy(sword), 90 * 0.3 * 0.3) && near(computeProjectileEnergy(sword, 200), 180 * 0.3 * 0.3)
  && EFFORT_REFERENCE === 100);

{
  const projectile = buildProjectileFromDamageEntries(resolveEntriesEffort([sword], 150), {});
  assert('the projectile carries the resolved damage (STR 150 → 135)',
    projectile && near(projectile.damage, 135) && near(projectile.applications[0].items[0].damage, 135), projectile);
}

if (failed > 0) {
  console.log(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll damage-profile assertions passed.');

/**
 * Smoke tests for the pure converters of the ability-scale migration.
 * Runs in plain Node (no Foundry globals required). Execute with:
 *   node module/helpers/ability-scale-migration.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if
 * any assertion fails.
 */

import {
  convertEffectChanges,
  convertLegacyAbilities,
  convertModifierList,
} from './ability-scale-migration.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const legacy = {
  end: { value: 10 }, str: { value: 12 }, dex: { value: 14 }, cor: { value: 8 },
  per: { value: 10 }, int: { value: 11 }, luc: { value: 5 },
};

{
  const r = convertLegacyAbilities(legacy);
  assert('legacy abilities ×10 and dex → agi',
    r && r.abilities.agi.value === 140 && r.abilities.str.value === 120 && r.abilities.luc.value === 50
    && !('dex' in r.abilities), r);
  assert('legacy values are kept for the backup flag', r.legacy.dex.value === 14 && r.legacy !== legacy);
}

assert('already migrated abilities (no dex key) are left alone',
  convertLegacyAbilities({ end: { value: 100 }, agi: { value: 100 } }) === null
  && convertLegacyAbilities(undefined) === null && convertLegacyAbilities(null) === null);

assert('non-numeric legacy value becomes 0 instead of NaN',
  convertLegacyAbilities({ dex: { value: 'x' }, str: { value: 10 } }).abilities.agi.value === 0);

{
  const r = convertModifierList([
    { targetId: 'abilities.dex', value: 2, mode: 'add' },
    { targetId: 'abilities.str', value: -1, mode: 'add' },
    { targetId: 'abilities.cor', value: 0, mode: 'add' },
  ]);
  assert('modifier list: dex → agi and values ×10, zero stays zero',
    r.changed && r.list[0].targetId === 'abilities.agi' && r.list[0].value === 20
    && r.list[1].value === -10 && r.list[2].value === 0, r);
  assert('empty modifier list is not changed',
    convertModifierList([]).changed === false && convertModifierList(undefined).changed === false);
}

{
  const r = convertEffectChanges([
    { key: 'system.abilities.dex.value', mode: 2, value: '3' },
    { key: 'system.abilities.str.value', mode: 1, value: '1.5' },
    { key: 'system.abilities.end.value', mode: 5, value: '12' },
    { key: 'system.hitboxScale', mode: 2, value: '5' },
  ]);
  assert('effect changes: ADD scaled and renamed, MULTIPLY keeps its value, other keys untouched',
    r.changed && r.changes[0].key === 'system.abilities.agi.value' && r.changes[0].value === '30'
    && r.changes[1].value === '1.5' && r.changes[2].value === '120'
    && r.changes[3].key === 'system.hitboxScale' && r.changes[3].value === '5', r);
  assert('effect changes without abilities are not changed',
    convertEffectChanges([{ key: 'system.hitboxScale', mode: 2, value: '1' }]).changed === false);
}

if (failed > 0) {
  console.log(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll migration assertions passed.');

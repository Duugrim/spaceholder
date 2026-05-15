import {
  calculateStopThickness,
  calculateThicknessCheck,
  enrichPhasesWithProjectileDefaults,
  listArmorCoveredSlotRefs,
  minimalAnatomyForArmorSlot,
} from './armor-penetration-tester.mjs';
import { TEST_MATERIAL_FIXTURES } from './__fixtures__/test-materials.mjs';

let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS  ${label}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
}

function approxEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

const steel = TEST_MATERIAL_FIXTURES['steel-plate'];

const apRound = [{
  mode: 'sequential',
  items: [{
    type: 'ballistic',
    damage: 10,
    armorPen: 2,
    armorDamageFactor: 1,
    hardness: 1,
  }],
}];

const stop = calculateStopThickness(apRound, steel);
assert(
  'stop thickness uses v3 E <= hardness * thickness^2 * resistance',
  approxEqual(stop.thickness, 2),
  `got ${stop.thickness}`
);

const held = calculateThicknessCheck(apRound, steel, 2);
assert('check mode marks exact threshold as stopped', held.stopped === true && held.penetrates === false, JSON.stringify(held));
assert('check mode leaves no residual at threshold', approxEqual(held.rows[0].residualDamage, 0), JSON.stringify(held.rows[0]));

const penetrated = calculateThicknessCheck(apRound, steel, 1);
assert('check mode marks thinner plate as penetrated', penetrated.penetrates === true && penetrated.stopped === false, JSON.stringify(penetrated));
assert('check mode reports residual damage', approxEqual(penetrated.rows[0].residualDamage, 7.5), JSON.stringify(penetrated.rows[0]));

const flatApps = [{
  type: 'piercing',
  damage: 9,
  armorPen: 3,
  armorDamageFactor: 1,
  hardness: 1,
}];
const flatStop = calculateStopThickness(flatApps, steel);
assert('flat application lists are accepted', approxEqual(flatStop.thickness, 3), `got ${flatStop.thickness}`);

const mixed = [{
  mode: 'parallel',
  items: [
    { type: 'ballistic', damage: 5, armorPen: 2, hardness: 1 },
    { type: 'thermal', damage: 5, armorPen: 2, hardness: 1 },
  ],
}];
const mixedStop = calculateStopThickness(mixed, steel);
assert('multi-application stop thickness is limited by hardest item', approxEqual(mixedStop.thickness, Math.sqrt(20 / 4.5)), `got ${mixedStop.thickness}`);

const phasesMissingLineAp = [{
  mode: 'sequential',
  items: [{ type: 'ballistic', damage: 5, armorPen: 0, armorDamageFactor: 1, hardness: 1 }],
}];
const enriched = enrichPhasesWithProjectileDefaults({ armorPen: 1 }, phasesMissingLineAp);
assert('enrich spreads parent armorPen to lines without AP', (enriched[0].items[0].armorPen ?? 0) === 1, JSON.stringify(enriched[0].items[0]));
const notOverwritten = enrichPhasesWithProjectileDefaults(
  { armorPen: 99 },
  [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 1, armorPen: 2, armorDamageFactor: 1, hardness: 1 }] }],
);
assert('enrich keeps explicit per-line armorPen', (notOverwritten[0].items[0].armorPen ?? 0) === 2, JSON.stringify(notOverwritten[0].items[0]));

const listed = listArmorCoveredSlotRefs({
  coveredParts: [
    { slotRef: 'chest', layers: [{ material: 'x', thickness: 1 }] },
    { slotRef: 'head', layers: [{ material: 'x', thickness: 0 }] },
  ],
});
assert('listArmorCoveredSlotRefs skips empty thickness', listed.length === 1 && listed[0] === 'chest', JSON.stringify(listed));
const mini = minimalAnatomyForArmorSlot('chest');
assert('minimalAnatomyForArmorSlot is single slot', Object.keys(mini.bodyParts).length === 1 && Boolean(mini.bodyParts.chest), JSON.stringify(mini));

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll armor penetration tester smoke tests passed.');
}

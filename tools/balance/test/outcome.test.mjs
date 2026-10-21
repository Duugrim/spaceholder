/**
 * Smoke tests for case outcomes (`lib/outcome.mjs`). Plain Node, no Foundry:
 *   node tools/balance/test/outcome.test.mjs
 *
 * Items are hand-written here and materials come from the resolver's test fixtures, so tuning pack values or
 * anatomy numbers cannot break the assertions: they check structure (branches, families, verdicts), not
 * balance numbers.
 */

import { TEST_MATERIAL_FIXTURES } from '../../../module/helpers/damage/__fixtures__/test-materials.mjs';
import { caseMembers, enumerateBranches, evaluateCase, shotOutcome, verdict, checkCases } from '../lib/outcome.mjs';
import { simulate } from '../lib/engine.mjs';

let failed = 0;
function assert(label, cond, detail) {
  if (cond) console.log(`PASS  ${label}`);
  else { failed += 1; console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`); }
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

/* ---- database fixture ------------------------------------------- */

const materials = Object.entries(TEST_MATERIAL_FIXTURES).map(([slug, values]) => ({ id: `material.${slug}`, kind: 'material', name: values.name, values }));
const round = (id, group, caliber, damage, armorPen, extra = {}) => ({
  id, kind: 'ammo', name: id, group,
  values: { caliber, damage: [{ enabled: true, damageType: 'ballistic', damage, effortShare: 0, armorPen, hardness: 1, armorDamageFactor: 100, armorDamageReduction: 100 }], falloff: { enabled: false, halfDistance: 0 }, ...extra },
});
const gun = (id, group, calibers, energyMult = 100) => ({
  id, kind: 'weapon', name: id, group,
  values: { family: 'Огнестрельное', lines: [{ id: 'l1', name: 'Ствол', calibers, damage: [], energyMult: { enabled: energyMult !== 100, value: energyMult } }] },
});
const items = [
  ...materials,
  round('ammo.9mm', '9mm', '9mm', 100, 25),
  round('ammo.9mm-ap', '9mm', '9mm-ap', 100, 35),
  round('ammo.50', '50bmg', '50bmg', 280, 110),
  round('ammo.buck', 'buck', 'buck', 35, 15, { multishot: { enabled: true, count: 6, coneDegrees: 20 } }),
  round('ammo.he', 'he', 'he', 160, 25, { onHitSplash: { enabled: true, radius: 3, unit: 'grid' } }),
  gun('weapon.pistol-a', 'Пистолеты', ['9mm']),
  gun('weapon.pistol-b', 'Пистолеты', ['9mm, 9mm-ap'], 120),
  gun('weapon.smg', 'ПП', ['9mm']),
  {
    id: 'weapon.knife', kind: 'weapon', name: 'Нож', group: 'Ножи',
    values: { family: 'Ближний бой', lines: [
      { id: 'stab', name: 'Колющий', damage: [{ enabled: true, damageType: 'piercing', damage: 0, effortShare: 90, armorPen: 35, hardness: 1 }] },
      { id: 'cut', name: 'Режущий', damage: [{ enabled: true, damageType: 'cutting', damage: 0, effortShare: 55, armorPen: 20, hardness: 1 }] },
    ] },
  },
];
const dictionaries = {
  weaponTypes: [{ id: 'pistols', label: 'Пистолеты' }, { id: 'smg', label: 'ПП' }, { id: 'melee', label: 'Ближний бой' }],
  parts: [{ id: 'head', slot: 'head' }, { id: 'upperTorso', slot: 'upperTorso' }, { id: 'arm', slot: 'leftArm' }],
};
const row = (extra = {}) => ({ id: 'r', armor: { kind: 'none' }, face: 'front', distance: 0, worst: null, best: null, ...extra });

/* ---- branches --------------------------------------------------- */

{
  const leaves = enumerateBranches((decide) => [decide({ kind: 'organ', id: 'a', chance: 0.3 }), decide({ kind: 'organ', id: 'b', chance: 0.6 })]);
  const total = leaves.reduce((s, l) => s + l.p, 0);
  const both = leaves.find((l) => l.value[0] && l.value[1]);
  assert('two independent rolls → four branches', leaves.length === 4, leaves.length);
  assert('branch probabilities sum to 1', near(total, 1), total);
  assert('a branch has the product of its choices', near(both.p, 0.18), both.p);
}
{
  // The second roll exists only when the first happened (a deeper wound reaches another organ).
  const leaves = enumerateBranches((decide) => (decide({ chance: 0.5 }) ? decide({ chance: 0.25 }) : null));
  assert('a roll that depends on an earlier one → three branches', leaves.length === 3 && near(leaves.reduce((s, l) => s + l.p, 0), 1));
}
{
  const leaves = enumerateBranches((decide) => decide({ chance: 1 }));
  assert('a sure event has a single branch', leaves.length === 1 && leaves[0].value === true);
}

/* ---- verdict ---------------------------------------------------- */

{
  const o = (id, fatal = false) => ({ id, fatal });
  assert('verdict: both ends agree → match', verdict('mortal', 'severe', o('mortal'), o('severe')) === 'match');
  assert('verdict: a single expected outcome', verdict('light', null, o('light'), o('light')) === 'match');
  assert('verdict: inside the range, one end agrees → near', verdict('light', 'graze', o('light'), o('light')) === 'near');
  assert('verdict: worse than agreed → miss', verdict('severe', null, o('mortal'), o('severe')) === 'miss');
  assert('verdict: no agreed outcome → none', verdict(null, null, o('light'), o('light')) === 'none');
  assert('verdict: a fatal destroyed part counts as death', verdict('death', null, o('destroyed', true), o('destroyed', true)) === 'match');
  assert('verdict: a destroyed arm is not death', verdict('death', null, o('destroyed'), o('destroyed')) === 'miss');
}

/* ---- weapon family ---------------------------------------------- */

{
  const family = caseMembers({ weaponType: 'pistols', ammoItem: 'ammo.9mm' }, row(), items, dictionaries);
  const labels = family.map((m) => m.label);
  assert('family: every pistol that takes the caliber group, each round of the group',
    labels.length === 3 && labels.includes('weapon.pistol-a · ammo.9mm') && labels.includes('weapon.pistol-b · ammo.9mm') && labels.includes('weapon.pistol-b · ammo.9mm-ap'), labels.join(' | '));
  assert('family: an SMG is not a pistol', !labels.some((l) => l.includes('smg')));
  const single = caseMembers({ weaponType: 'pistols', ammoItem: 'ammo.9mm', weaponItem: 'weapon.smg' }, row(), items, dictionaries);
  assert('a case with a weapon from the base uses that weapon only', single.length === 1 && single[0].source.weaponId === 'weapon.smg');
  const off = caseMembers({ weaponType: 'pistols', ammoItem: 'ammo.9mm', family: false }, row(), items, dictionaries);
  assert('family off: the round alone', off.length === 1 && !off[0].source.weaponId);
  const melee = caseMembers({ weaponType: 'melee', weaponItem: 'weapon.knife' }, row({ lineId: 'cut', effort: 300 }), items, dictionaries);
  assert('a melee case: the row picks the blow and the strength', melee.length === 1 && melee[0].source.kind === 'weapon' && melee[0].source.lineId === 'cut' && melee[0].source.effort === 300, JSON.stringify(melee));
  const anyBlow = caseMembers({ weaponType: 'melee', weaponItem: 'weapon.knife' }, row(), items, dictionaries);
  assert('a melee row without a blow tries every blow of the weapon', anyBlow.length === 2 && anyBlow.every((m) => m.source.effort === 100));
  assert('no round and no weapon → nothing to shoot', caseMembers({ weaponType: 'pistols' }, row(), items, dictionaries).length === 0);
}

/* ---- a case ----------------------------------------------------- */

{
  const res = evaluateCase({ weaponType: 'pistols', ammoItem: 'ammo.9mm', part: 'head' }, row({ worst: 'mortal', best: 'severe' }), { items, dictionaries });
  assert('a case is evaluated over the family', res.ok && res.members.length === 3, JSON.stringify(res).slice(0, 300));
  assert('the worst is at least as bad as the best', res.worst.severity >= res.best.severity);
  assert('each weapon\'s outcomes add up to 1', res.members.every((m) => near(Object.values(m.dist).reduce((s, p) => s + p, 0), 1, 1e-6)));
  assert('a verdict is given', ['match', 'near', 'miss'].includes(res.status), res.status);
  assert('a case on a part without a slot is skipped', evaluateCase({ ammoItem: 'ammo.9mm', part: 'tail' }, row(), { items, dictionaries }).ok === false);
}

/* ---- pellets, blast, second target ------------------------------ */

{
  const member = { label: 'buck', source: { kind: 'ammo', itemId: 'ammo.buck' } };
  const contact = shotOutcome({ member, row: row(), partId: 'upperTorso', items, decide: () => false });
  assert('a volley in contact lands as one wound', contact.pellets === 6 && contact.note.includes('одной раной'), contact.note);
  const far = shotOutcome({ member, row: row({ distance: 10 }), partId: 'upperTorso', items, decide: () => false });
  assert('a wide volley puts only some pellets into the part, as separate wounds', far.pellets >= 1 && far.pellets < 6 && far.note.includes('отдельными ранами'), far.note);
  assert('pellets in one wound do more to the part than a spread volley', contact.hitDamage > far.hitDamage, `${contact.hitDamage} vs ${far.hitDamage}`);
}
{
  const member = { label: 'he', source: { kind: 'ammo', itemId: 'ammo.he' } };
  const res = shotOutcome({ member, row: row(), partId: 'upperTorso', items, decide: () => false });
  assert('a blast reaches the hit part and its neighbours', res.note.includes('взрыв: 3 части') && Object.keys(res.damageBySlot).length >= 3, `${res.note} ${JSON.stringify(res.damageBySlot)}`);
}
{
  const weak = shotOutcome({ member: { source: { kind: 'ammo', itemId: 'ammo.9mm' } }, row: row({ target: 'behind' }), partId: 'upperTorso', items, decide: () => false });
  const strong = shotOutcome({ member: { source: { kind: 'ammo', itemId: 'ammo.50' } }, row: row({ target: 'behind' }), partId: 'upperTorso', items, decide: () => false });
  assert('second target: a bullet that stays in the first one does not reach it', weak.note === 'застряла в первой цели' && weak.outcome.id === 'stopped', `${weak.note} ${weak.outcome.id}`);
  assert('second target: a bullet that leaves the first one hurts it, weaker than the first target', strong.note === 'вышла из первой цели' && strong.hitDamage > 0, `${strong.note} ${strong.hitDamage}`);
}

/* ---- batch and calculator --------------------------------------- */

{
  const groups = [{ id: 'g', weaponType: 'pistols', ammoItem: 'ammo.9mm', part: 'head' }, { id: 'g2', weaponType: 'pistols', part: 'head' }];
  const rows = [{ ...row({ id: 'a' }), groupId: 'g' }, { ...row({ id: 'b' }), groupId: 'g2' }];
  const res = checkCases({ groups, rows, dictionaries, items });
  assert('checkCases: a row with a round is evaluated, one without is skipped', res[0].ok && res[1].ok === false && res[1].error === 'skip');
}
{
  const res = simulate({ source: { kind: 'ammo', itemId: 'ammo.9mm' }, elements: [{ type: 'target', distance: 0, partId: 'leftArm', armor: { kind: 'none' }, shots: 4 }] }, items);
  const sev = res.target.shots.map((s) => s.outcome.severity);
  assert('calculator: every hit of a series is judged, and the state never gets better', sev.length === 4 && sev.every((v, i) => i === 0 || v >= sev[i - 1]), sev.join(' '));
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll balance outcome tests passed');

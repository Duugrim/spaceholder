/**
 * Smoke tests for the balance tool's shot simulator. Plain Node, no Foundry:
 *   node tools/balance/test/engine.test.mjs
 *
 * Inputs are built here from the resolver's test material fixtures and a hand-written 9x19 round, never
 * from the compendium, so tuning pack values cannot break the assertions. The checks are agreement tests
 * against the game's own functions plus a few arithmetic anchors.
 */

import { TEST_MATERIAL_FIXTURES } from '../../../module/helpers/damage/__fixtures__/test-materials.mjs';
import { resolveBodyTraversal } from '../../../module/helpers/damage/body-traversal-resolver.mjs';
import { applyEnergyScaleToApplications } from '../../../module/helpers/weapon/damage-profile.mjs';
import {
  buildProjectile, createMaterialResolver, hitDirectionOf, loadAnatomy, requestForCase, scaleByFalloff, simulate, snapshot,
} from '../lib/engine.mjs';

let failed = 0;
function assert(label, cond, detail) {
  if (cond) console.log(`PASS  ${label}`);
  else { failed += 1; console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`); }
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/* ---- database fixture ------------------------------------------- */

const materials = Object.entries(TEST_MATERIAL_FIXTURES).map(([slug, values]) => ({
  id: `material.${slug}`, kind: 'material', name: values.name, status: 'draft', base: values, values,
}));
// A thin, weak wall material: a 9x19 round goes through 15 mm of it.
const drywall = {
  materialId: 'drywall', name: 'Drywall', category: 'structure', hardness: 0.02, integrityPerThickness: 2, breachCapacityPerThickness: 0,
  weightPerThickness: 0.1, resistance: { ballistic: 100, concussive: 100 }, wear: { ballistic: 100 }, conductance: {}, selfInduction: {}, degradation: {},
};
const ammo9 = {
  caliber: '9mm',
  damage: [{ enabled: true, damageType: 'ballistic', damage: 100, effortShare: 0, armorPen: 25, hardness: 1, armorDamageFactor: 100, armorDamageReduction: 100, speed: 0, payloadId: '' }],
  falloff: { enabled: true, halfDistance: 45 },
};
const items = [
  ...materials,
  { id: 'material.drywall', kind: 'material', name: 'Drywall', status: 'draft', base: drywall, values: drywall },
  { id: 'ammo.9mm', kind: 'ammo', name: '9x19', status: 'draft', base: ammo9, values: ammo9 },
  {
    id: 'weapon.smg', kind: 'weapon', name: 'SMG', status: 'draft',
    base: { family: 'smg', lines: [{ id: 'l1', name: 'Barrel', energyMult: { enabled: true, value: 110 }, damage: [], calibers: ['9mm'] }] },
    values: { family: 'smg', lines: [{ id: 'l1', name: 'Barrel', energyMult: { enabled: true, value: 110 }, damage: [], calibers: ['9mm'] }] },
  },
  { id: 'preset.helm', kind: 'preset', name: 'Helm', status: 'draft', base: null, values: { use: 'armor', layers: [{ material: 'steel-plate', thickness: 2 }, { material: 'kevlar', thickness: 1 }] } },
];

const shot = (elements, extra = {}) => simulate({ source: { kind: 'ammo', itemId: 'ammo.9mm' }, elements, ...extra }, items);
const target = (partId, distance = 0, extra = {}) => ({ type: 'target', distance, partId, armor: { kind: 'none' }, ...extra });

/* ---- projectile ------------------------------------------------- */

{
  const p = buildProjectile({ kind: 'ammo', itemId: 'ammo.9mm' }, items);
  assert('9x19 projectile energy = 100 x 0.25^2', near(snapshot(p.applications)[0].energy, 6.25));
  const w = buildProjectile({ kind: 'ammo', itemId: 'ammo.9mm', weaponId: 'weapon.smg' }, items);
  assert('weapon energy multiplier scales damage and energy by 1.1', near(snapshot(w.applications)[0].damage, 110) && near(snapshot(w.applications)[0].energy, 6.875));
}

/* ---- falloff ---------------------------------------------------- */

{
  const p = buildProjectile({ kind: 'ammo', itemId: 'ammo.9mm' }, items);
  const a = scaleByFalloff(p.applications, 0.5)[0].items[0];
  const b = applyEnergyScaleToApplications(p.applications, 0.5)[0].items[0];
  assert('scaleByFalloff is the live energy scale', near(a.damage, b.damage) && near(a.armorPen, b.armorPen) && near(a.energy, b.energy));
  const res = shot([target('head', 45)]);
  const step = res.steps.find((s) => s.kind === 'target');
  assert('half-distance halves the energy; the damage follows, the penetration stays',
    near(step.in[0].damage, 50) && near(step.in[0].energy, 6.25 / 2, 1e-6) && near(step.in[0].armorPen, 25), JSON.stringify(step.in[0]));
  const off = shot([target('head', 45)], { falloff: false });
  assert('falloff off keeps the muzzle values', near(off.steps.find((s) => s.kind === 'target').in[0].damage, 100));
}

/* ---- target ----------------------------------------------------- */

{
  const anatomy = loadAnatomy('humanoid');
  const resolveMaterial = createMaterialResolver(items);
  const p = buildProjectile({ kind: 'ammo', itemId: 'ammo.9mm' }, items);
  const direct = resolveBodyTraversal({
    anatomy, startSlotRef: 'upperTorso', hitDirection: 'front', applications: p.applications, armorBySlot: {}, resolveMaterial, random: () => 0.5,
  });
  const expected = direct.bodyDamageBySlot.upperTorso.reduce((s, h) => s + h.amount, 0);
  const res = shot([target('upperTorso')]);
  assert('simulate agrees with a direct resolveBodyTraversal call', near(res.target.shots[0].entry.total, expected, 1e-9), `${res.target.shots[0].entry.total} vs ${expected}`);
  assert('target reports HP and ratio from the anatomy', res.target.shots[0].entry.maxHp === anatomy.bodyParts.upperTorso.maxHp && near(res.target.shots[0].entry.ratio, expected / anatomy.bodyParts.upperTorso.maxHp));
  assert('the shot reports the wound and what left the body', res.target.shots[0].wound && Array.isArray(res.target.shots[0].exit) && Array.isArray(res.target.shots[0].organs));
  const override = shot([target('upperTorso', 0, { partHp: 200 })]);
  assert('partHp overrides the anatomy HP', override.target.shots[0].entry.maxHp === 200);
  const names = simulate({ source: { kind: 'ammo', itemId: 'ammo.9mm' }, elements: [target('head')], partNames: { head: 'Голова' } }, items);
  assert('partNames relabel the hit part', names.target.partName === 'Голова');
}

/* ---- sides ------------------------------------------------------ */

{
  assert('case sides map to resolver directions', hitDirectionOf('front') === 'front' && hitDirectionOf('back') === 'back' && hitDirectionOf('side') === 'left' && hitDirectionOf(undefined) === 'front');
  const front = shot([target('head')]).target.shots[0].entry.total;
  const side = shot([target('head', 0, { hitDirection: 'side' })]);
  assert('a side hit on a part without side faces falls back to the front face', near(side.target.shots[0].entry.total, front, 1e-9));
  assert('the side hit is labelled in the step', side.steps.find((s) => s.kind === 'target').label.includes('сбоку'));
  const vestBack = { kind: 'layers', layers: [{ material: 'steel-plate', thickness: 3 }] };
  const bareBack = shot([target('upperTorso', 0, { hitDirection: 'back' })]).target.shots[0].entry.total;
  const armoredBack = shot([target('upperTorso', 0, { hitDirection: 'back', armor: vestBack })]).target.shots[0].entry.total;
  assert('armour applies to the face that is hit (back)', armoredBack < bareBack);
}

/* ---- armour ----------------------------------------------------- */

{
  const bare = shot([target('head')]).target.shots[0].entry.total;
  const helmed = shot([target('head', 0, { armor: { kind: 'preset', presetId: 'preset.helm' } })]).target.shots[0].entry.total;
  const layered = shot([target('head', 0, { armor: { kind: 'layers', layers: [{ material: 'steel-plate', thickness: 2 }, { material: 'kevlar', thickness: 1 }] } })]).target.shots[0].entry.total;
  assert('armour reduces the damage that reaches the part', helmed < bare);
  assert('a preset and the same layers give the same result', near(helmed, layered, 1e-9));
  const none = shot([target('head', 0, { armor: { kind: 'layers', layers: [{ material: 'steel-plate', thickness: 1000 }] } })]).target.shots[0].entry.total;
  assert('a metre of steel stops a 9x19 round', none === 0);
}

/* ---- series ----------------------------------------------------- */

{
  const series = shot([target('head', 0, { armor: { kind: 'layers', layers: [{ material: 'kevlar', thickness: 1 }] }, shots: 6 })]).target.shots;
  const damages = series.map((s) => s.entry.total);
  assert('a series reports one entry per hit', series.length === 6);
  assert('armour wears: damage never drops over a series', damages.every((d, i) => i === 0 || d >= damages[i - 1] - 1e-9), damages.join(' '));
  assert('worn layers are reported', series[0].armorLayers.length > 0 && series.at(-1).armorLayers[0].integrity <= series[0].armorLayers[0].integrity);
}

/* ---- walls ------------------------------------------------------ */

{
  const thin = shot([{ type: 'wall', distance: 2, material: 'drywall', thickness: 15 }, target('upperTorso', 6)]);
  const wall = thin.steps.find((s) => s.kind === 'wall');
  assert('a thin weak wall is penetrated', wall.penetrated === true && thin.target !== null);
  assert('a wall takes energy away', wall.out[0].energy < wall.in[0].energy);
  const bare = shot([target('upperTorso', 6)]).target.shots[0].entry.total;
  assert('a target behind a wall takes less than a bare one', thin.target.shots[0].entry.total < bare);
  const thick = shot([{ type: 'wall', distance: 2, material: 'steel-plate', thickness: 1000 }, target('upperTorso', 6)]);
  assert('a thick steel wall stops the shot before the target', thick.target === null && thick.steps.some((s) => s.kind === 'stopped'));
  const unknown = shot([{ type: 'wall', distance: 2, material: 'unobtainium', thickness: 5 }, target('head', 3)]);
  assert('an unknown wall material warns', unknown.warnings.length === 1);
  const sorted = shot([target('head', 9), { type: 'wall', distance: 2, material: 'drywall', thickness: 15 }]);
  assert('elements are ordered by distance, not by input order', sorted.steps.map((s) => s.kind).join() === 'start,wall,target');
}

/* ---- errors and cases ------------------------------------------ */

{
  let message = '';
  try { simulate({ source: { kind: 'ammo', itemId: 'ammo.none' }, elements: [] }, items); } catch (e) { message = e.message; }
  assert('an unknown ammo id is reported', message.includes('ammo.none'));
  const group = { ammoItem: 'ammo.9mm', part: 'head', weaponItem: '' };
  const parts = [{ id: 'head', slot: 'head', hp: null }];
  const req = requestForCase(group, { distance: 12, face: 'front', armor: { kind: 'none' } }, parts);
  assert('a case row becomes a target request at its distance', req.elements[0].distance === 12 && req.elements[0].partId === 'head');
  assert('a case side reaches the target element', requestForCase(group, { distance: 0, face: 'side', armor: { kind: 'none' } }, parts).elements[0].hitDirection === 'side');
  assert('a case without a linked ammo cannot be simulated', requestForCase({ ...group, ammoItem: '' }, { distance: 0 }, parts) === null);
  assert('a case on an unknown part cannot be simulated', requestForCase({ ...group, part: 'tail' }, { distance: 0 }, parts) === null);
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll balance engine tests passed');

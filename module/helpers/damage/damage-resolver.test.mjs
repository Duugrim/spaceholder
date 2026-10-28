/**
 * Smoke / regression tests for the v3 damage resolver. Runs in plain Node
 * (no Foundry globals required). Execute with:
 *   node module/helpers/damage/damage-resolver.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if
 * any assertion fails.
 *
 * v3 penetration formula:
 *   AR      = materialHardness * thickness^2
 *   eAR     = AR * resistance[type] / 100          (effective after degradation)
 *   E       = damage * armorPen^2 * hardnessProj   (projectile energy)
 *   penetrates when E > eAR
 *   residual = damage * (E - eAR) / E
 *
 * Wear convention: fixture `wear[T]` values are integer percentages; the
 * resolver divides by 100 at runtime (wearCoeff = wear[T] / 100).
 */

import { resolveDamagePackage, normalizeApplications, damageRatioForEnergyRatio } from './damage-resolver.mjs';
import { applyEnergyScaleToApplications } from '../weapon/damage-profile.mjs';
import { ensureLayerDefaults } from './materials-manager.mjs';
import { TEST_MATERIAL_FIXTURES } from './__fixtures__/test-materials.mjs';
import { DEGRADATION_MODES } from './damage-types.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function approxEqual(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

const resolveMaterial = (id) => TEST_MATERIAL_FIXTURES[id] ?? null;
const determRandom = () => 0.5;

function makeLayer(materialId, thickness, overrides = {}) {
  const md = resolveMaterial(materialId);
  return ensureLayerDefaults({ material: materialId, thickness, ...overrides }, md);
}

function bodyAmount(bodyDamage, type) {
  const hit = bodyDamage.find((d) => d.type === type);
  return hit ? hit.amount : 0;
}

function integrityLoss(result, idx) {
  const l = result.layers[idx];
  if (!l) return null;
  return l.integrityMax - l.integrity;
}

/* ================================================================== *
 *  Block A: v3 formula core                                           *
 *  Validates the AR / E interaction independent of older mechanics.   *
 * ================================================================== */

/* ------------------------------------------------------------------ *
 *  Case 1: armorPen=0 → E=0, always held regardless of damage        *
 *                                                                     *
 *  1mm steel-plate, ballistic 200, armorPen not given (defaults to 0).*
 *  E = 200 * 0 * 1 = 0.  eAR = 10*1*1.0 = 10.  0 ≤ 10 → held.       *
 *  (Old linear model: 200 > R*t=30 → penetrate. v3 breaks that link.)*
 *                                                                     *
 *  wear = 40%*200 = 80 > max(50) → integrity = 0.                    *
 *  selfInduction.ballistic on hold: the plate breaks, but a mechanical *
 *  hit does not overflow onto the body (its shock is conductance,    *
 *  and steel conducts no ballistic): nothing reaches the body.       *
 * ------------------------------------------------------------------ */
{
  const layers = [makeLayer('steel-plate', 1)];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 200 }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case1: armorPen=0 → E=0, ballistic 200 held by 1mm steel',
    bodyAmount(result.bodyDamage, 'ballistic') === 0,
    JSON.stringify(result.bodyDamage));
  assert('Case1: a mechanical hit that breaks the plate does not overflow onto the body',
    result.bodyDamage.length === 0,
    JSON.stringify(result.bodyDamage));
  assert('Case1: steel integrity worn to 0',
    approxEqual(result.layers[0].integrity, 0),
    JSON.stringify(result.layers));
}

/* ------------------------------------------------------------------ *
 *  Case 2: basic v3 penetration (armorPen=1, damage > eAR)           *
 *                                                                     *
 *  1mm steel-plate, ballistic 15, armorPen=1, hardness=1.            *
 *  eAR = 10*1*100% = 10.  E = 15*1*1 = 15 > 10 → penetrates.        *
 *  residual = 15*(15-10)/15 = 5.                                     *
 *  wear = 40%*15 = 6 → integrity 50→44.  breachLoss = 6.             *
 * ------------------------------------------------------------------ */
{
  const layers = [makeLayer('steel-plate', 1)];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 15, armorPen: 1 }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case2: ballistic 15 AP1 penetrates 1mm steel',
    result.bodyDamage.length === 1 && result.bodyDamage[0].type === 'ballistic' && approxEqual(result.bodyDamage[0].amount, 5),
    JSON.stringify(result.bodyDamage));
  assert('Case2: steel integrity 50→44 after penetration wear',
    approxEqual(result.layers[0].integrity, 44),
    JSON.stringify(result.layers));
  assert('Case2: breachLoss = 6 after penetration',
    approxEqual(result.layers[0].breachLoss, 6),
    JSON.stringify(result.layers));
}

/* ------------------------------------------------------------------ *
 *  Case 3: quadratic thickness scaling                                *
 *                                                                     *
 *  Same projectile (AP1 damage 15) that penetrates 1mm now fails      *
 *  against 2mm because eAR scales as t^2:                            *
 *  1mm: eAR=10, 2mm: eAR=10*4=40.  E=15 ≤ 40 → held.               *
 *                                                                     *
 *  wear = 40%*15 = 6 → integrity 100→94.                             *
 *  selfInduction.ballistic: d_thermal=50%*15*0.2=1.5, d_conc=30%*15  *
 *  *0.3=1.35 → D=2.85 → integrity 91.15.                            *
 * ------------------------------------------------------------------ */
{
  const layers = [makeLayer('steel-plate', 2)];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 15, armorPen: 1 }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case3: same projectile held by 2mm steel (eAR 4× larger)',
    result.bodyDamage.length === 0,
    JSON.stringify(result.bodyDamage));
  assert('Case3: 2mm steel integrity 100→91.15 after wear+selfInduction',
    approxEqual(result.layers[0].integrity, 91.15),
    JSON.stringify(result.layers));
}

/* ------------------------------------------------------------------ *
 *  Case 4: projectile hardness amplifies energy                       *
 *                                                                     *
 *  hardness=2 doubles E: E = 8*1^2*2 = 16 > eAR 10 → penetrates.    *
 *  Without hardness (=1): E = 8 ≤ 10 → held.                        *
 *  residual = 8*(16-10)/16 = 3.                                      *
 *  wear = 40%*8 = 3.2 → integrity 46.8.                              *
 * ------------------------------------------------------------------ */
{
  const layers = [makeLayer('steel-plate', 1)];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 8, armorPen: 1, hardness: 2 }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case4: projectile hardness=2 makes damage=8 penetrate (residual 3)',
    result.bodyDamage.length === 1 && approxEqual(result.bodyDamage[0].amount, 3),
    JSON.stringify(result.bodyDamage));
  assert('Case4: steel integrity 50→46.8',
    approxEqual(result.layers[0].integrity, 46.8),
    JSON.stringify(result.layers));
}

/* ================================================================== *
 *  Block B: conductance and selfInduction                             *
 *  These mechanics are unchanged in v3; only formula interaction      *
 *  differs (lower armorPen scale needed to reach penetration).        *
 * ================================================================== */

/* ------------------------------------------------------------------ *
 *  Case 5: a held bullet hands on a share of what the layer absorbed  *
 *                                                                     *
 *  1mm kevlar, conductance.ballistic=[{concussive,0.5}].             *
 *  eAR = 20*1*100% = 20.  E = 20*1*1 = 20 ≤ 20 → held: the layer     *
 *  absorbs all 20 → 10 concussive goes on.                           *
 *  wear = 30%*20 = 6 → 24; selfInduction thermal 0.05: 100%*20*0.05  *
 *  = 1 → integrity 23.                                               *
 * ------------------------------------------------------------------ */
{
  const layers = [makeLayer('kevlar', 1)];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 20, armorPen: 1 }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case5: a held bullet — only the handed-on blow (half of the absorbed 20) reaches the body',
    bodyAmount(result.bodyDamage, 'ballistic') === 0 && approxEqual(bodyAmount(result.bodyDamage, 'concussive'), 10),
    JSON.stringify(result.bodyDamage));
  assert('Case5: kevlar integrity 30→23 (wear on the whole hit + selfInduction)',
    approxEqual(result.layers[0].integrity, 23),
    JSON.stringify(result.layers));
  assert('Case5: no breachLoss on hold',
    approxEqual(result.layers[0].breachLoss, 0));
}

/* ------------------------------------------------------------------ *
 *  Case 6: penetration — the blow comes from the absorbed part only   *
 *                                                                     *
 *  1mm kevlar.  eAR=20.  E = 20*4*1 = 80 > 20 → penetrates.          *
 *  residual = 20*(80-20)/80 = 15 ballistic (the bullet is not        *
 *  weakened by the conduction); absorbed 5 → 2.5 concussive.         *
 *  wear = 30%*20 = 6 → integrity 24.  breachLoss = 6.                *
 * ------------------------------------------------------------------ */
{
  const layers = [makeLayer('kevlar', 1)];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 20, armorPen: 2 }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case6: the absorbed 5 is handed on as a blow of 2.5',
    approxEqual(bodyAmount(result.bodyDamage, 'concussive'), 2.5),
    JSON.stringify(result.bodyDamage));
  assert('Case6: the bullet keeps the damage of its energy (15)',
    approxEqual(bodyAmount(result.bodyDamage, 'ballistic'), 15),
    JSON.stringify(result.bodyDamage));
  assert('Case6: kevlar integrity 30→24 on penetration',
    approxEqual(result.layers[0].integrity, 24),
    JSON.stringify(result.layers));
  assert('Case6: breachLoss = 6',
    approxEqual(result.layers[0].breachLoss, 6),
    JSON.stringify(result.layers));
}

/* ------------------------------------------------------------------ *
 *  Case 7: kevlar holds, the blow goes through the layer behind       *
 *                                                                     *
 *  [kevlar 1mm, foam 1mm].  ballistic 10, armorPen=1: E 10 ≤ 20 →     *
 *  held by kevlar, 5 concussive handed on. A handed-on blow is not a  *
 *  projectile: the fixture foam has no damping, so it passes as is    *
 *  and the foam is not worn.                                          *
 *  Kevlar: wear 30%*10 = 3 → 27; selfInduction thermal 0.5 → 26.5.   *
 * ------------------------------------------------------------------ */
{
  const layers = [makeLayer('kevlar', 1), makeLayer('foam', 1)];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 1 }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case7: only the blow (5) reaches the body, flagged as handed on',
    result.bodyDamage.length === 1 && approxEqual(bodyAmount(result.bodyDamage, 'concussive'), 5)
      && result.bodyHits.every((h) => h.transferred === true),
    JSON.stringify(result.bodyHits));
  assert('Case7: kevlar integrity 30→26.5 after wear + selfInduction',
    approxEqual(result.layers[0].integrity, 26.5),
    JSON.stringify(result.layers));
  assert('Case7: the foam is not worn by a handed-on blow',
    approxEqual(result.layers[1].integrity, 10),
    JSON.stringify(result.layers));
}

/* ------------------------------------------------------------------ *
 *  Case 8: ablative absorbs laser (REDUCTION, worn to 0)             *
 *                                                                     *
 *  1mm ablative. laser 30, armorPen=0.                               *
 *  REDUCTION, s=1, eAR = 12*1*350% = 42.  E=0 → held.               *
 *  wear = 500%*30 = 150 > integrityMax 20 → integrity = 0.           *
 *  selfInduction.laser = [] (explicit) → no overflow.                *
 * ------------------------------------------------------------------ */
{
  const layers = [makeLayer('ablative', 1)];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'laser', damage: 30 }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case8: laser 30 fully absorbed by ablative',
    result.bodyDamage.length === 0,
    JSON.stringify(result.bodyDamage));
  assert('Case8: ablative worn to 0 by laser (kept in stack)',
    approxEqual(result.layers[0].integrity, 0),
    JSON.stringify(result.layers));
}

/* ================================================================== *
 *  Block C: degradation modes                                         *
 * ================================================================== */

/* ------------------------------------------------------------------ *
 *  Case 9: normalizeApplications accepts legacy shape                 *
 * ------------------------------------------------------------------ */
{
  const phases = normalizeApplications({ type: 'thermal', damage: 5 });
  assert('Case9: legacy {type,damage} normalises to one sequential phase',
    phases.length === 1 && phases[0].mode === 'sequential' && phases[0].items.length === 1
      && phases[0].items[0].type === 'thermal',
    JSON.stringify(phases));
}

/* ------------------------------------------------------------------ *
 *  Case 10: DISTRIBUTION mode splits hit by integrity ratio          *
 *                                                                     *
 *  Custom material 'distmat': hardness=1, resistance.electric=10(%),  *
 *  wear.electric=10(%).  integrity=50, integrityMax=100 → s=0.5.     *
 *  DISTRIBUTION: bypass=0.5 of xStruct(20)=10 → body.               *
 *  Inside: 10 electric, E=0 → held; wear=10%*10=1 → integrity 49.   *
 * ------------------------------------------------------------------ */
{
  const customResolve = (id) => {
    if (id === 'distmat') {
      return {
        materialId: 'distmat',
        hardness: 1,
        integrityPerThickness: 100,
        resistance: { electric: 10 },
        wear: { electric: 10 },
        conductance: { electric: [] },
        selfInduction: { electric: [] },
        degradation: { electric: DEGRADATION_MODES.DISTRIBUTION }
      };
    }
    return resolveMaterial(id);
  };
  const layers = [{ material: 'distmat', thickness: 1, integrity: 50, integrityMax: 100, breachLoss: 0, breachCapacity: 100 }];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'electric', damage: 20 }] }],
    resolveMaterial: customResolve,
    random: determRandom
  });
  assert('Case10: distribution sends 50% (10 electric) past layer to body',
    approxEqual(bodyAmount(result.bodyDamage, 'electric'), 10),
    JSON.stringify(result.bodyDamage));
  assert('Case10: layer integrity 50→49 from inside structural wear',
    approxEqual(result.layers[0].integrity, 49),
    JSON.stringify(result.layers));
}

/* ------------------------------------------------------------------ *
 *  Case 11: BYPASS mode → active only at 100% integrity              *
 *                                                                     *
 *  Custom 'glass' at integrity=99/100 (s=0.99 < 1).  BYPASS → not   *
 *  active → the full 5 ballistic passes through.                     *
 * ------------------------------------------------------------------ */
{
  const customResolve = (id) => {
    if (id === 'glass') {
      return {
        materialId: 'glass',
        hardness: 1,
        integrityPerThickness: 100,
        resistance: { ballistic: 100 },
        wear: { ballistic: 100 },
        conductance: { ballistic: [] },
        selfInduction: { ballistic: [] },
        degradation: { ballistic: DEGRADATION_MODES.BYPASS }
      };
    }
    return resolveMaterial(id);
  };
  const layers = [{ material: 'glass', thickness: 1, integrity: 99, integrityMax: 100, breachLoss: 0, breachCapacity: 100 }];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 5 }] }],
    resolveMaterial: customResolve,
    random: determRandom
  });
  assert('Case11: bypass mode lets the full hit through when integrity < 100%',
    approxEqual(bodyAmount(result.bodyDamage, 'ballistic'), 5),
    JSON.stringify(result.bodyDamage));
}

/* ------------------------------------------------------------------ *
 *  Case 12: CHANCE mode → guaranteed bypass when breachLoss = cap    *
 *                                                                     *
 *  Kevlar 1mm with breachLoss=30 (=breachCapacity).                  *
 *  CHANCE: breachRatio=1, roll=0.99 < 1 → the hit lands in a breach: *
 *  the layer is skipped, absorbs nothing, hands nothing on.          *
 * ------------------------------------------------------------------ */
{
  const layer = makeLayer('kevlar', 1, { breachLoss: 30 });
  const result = resolveDamagePackage({
    layers: [layer],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 25, armorPen: 1 }] }],
    resolveMaterial,
    random: () => 0.99
  });
  assert('Case12: chance bypass at full breach → the whole 25 ballistic reaches body',
    approxEqual(bodyAmount(result.bodyDamage, 'ballistic'), 25),
    JSON.stringify(result.bodyDamage));
  assert('Case12: a skipped layer hands nothing on',
    approxEqual(bodyAmount(result.bodyDamage, 'concussive'), 0),
    JSON.stringify(result.bodyDamage));
}

/* ------------------------------------------------------------------ *
 *  Case 13: full conductance (the material passes on all it absorbs)  *
 *                                                                     *
 *  Custom 'wire' holds electric (E 0) and hands on 100% of what it    *
 *  absorbed as electric. It still wears from the hit:                 *
 *  wear[electric] 100% × 40 → integrity 100 → 60.                     *
 * ------------------------------------------------------------------ */
{
  const customResolve = (id) => {
    if (id === 'wire') {
      return {
        materialId: 'wire',
        hardness: 1,
        integrityPerThickness: 100,
        resistance: { electric: 999 },
        wear: { electric: 100 },
        conductance: { electric: [{ type: 'electric', fraction: 1.0 }] },
        selfInduction: { electric: [] },
        degradation: { electric: DEGRADATION_MODES.REDUCTION }
      };
    }
    return resolveMaterial(id);
  };
  const layers = [{ material: 'wire', thickness: 1, integrity: 100, integrityMax: 100, breachLoss: 0, breachCapacity: 100 }];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'electric', damage: 40 }] }],
    resolveMaterial: customResolve,
    random: determRandom
  });
  assert('Case13: full conductance delivers 40 electric to body',
    approxEqual(bodyAmount(result.bodyDamage, 'electric'), 40),
    JSON.stringify(result.bodyDamage));
  assert('Case13: the wire still wears from the hit (100 → 60)',
    approxEqual(result.layers[0].integrity, 60),
    JSON.stringify(result.layers));
}

/* ------------------------------------------------------------------ *
 *  Case 14: selfInduction partial overflow (beam through a weak layer)*
 *                                                                     *
 *  Custom 'brittle': hardness=1, R.laser=30%, wear.laser=10%.        *
 *  wear.thermal=200%, wear.concussive=300%.                          *
 *  selfInduction.laser=[{thermal,0.5},{concussive,0.5}], BASTION.    *
 *  integrity=10, damage=10, armorPen=0 → held.                       *
 *  struct wear=10%*10=1 → integrity=9.  iRem=9.                     *
 *  d_thermal=200%*10*0.5=10, d_conc=300%*10*0.5=15. D=25 > 9.       *
 *  overflowFactor = 1 - 9/25 = 0.64 → 3.2 of each → body (a beam     *
 *  burns through; a mechanical hit would not overflow, see Case 1).  *
 * ------------------------------------------------------------------ */
{
  const customResolve = (id) => {
    if (id === 'brittle') {
      return {
        materialId: 'brittle',
        hardness: 1,
        integrityPerThickness: 10,
        resistance: { laser: 30 },
        wear: { laser: 10, thermal: 200, concussive: 300 },
        conductance: {},
        selfInduction: {
          laser: [
            { type: 'thermal', fraction: 0.5 },
            { type: 'concussive', fraction: 0.5 }
          ]
        },
        degradation: { laser: DEGRADATION_MODES.BASTION }
      };
    }
    return resolveMaterial(id);
  };
  const layers = [{ material: 'brittle', thickness: 1, integrity: 10, integrityMax: 10, breachLoss: 0, breachCapacity: 10 }];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'laser', damage: 10 }] }],
    resolveMaterial: customResolve,
    random: determRandom
  });
  assert('Case14: a beam overflows thermal 3.2 to body',
    approxEqual(bodyAmount(result.bodyDamage, 'thermal'), 3.2),
    JSON.stringify(result.bodyDamage));
  assert('Case14: a beam overflows concussive 3.2 to body',
    approxEqual(bodyAmount(result.bodyDamage, 'concussive'), 3.2),
    JSON.stringify(result.bodyDamage));
  assert('Case14: brittle layer worn to 0 after overflow',
    approxEqual(result.layers[0].integrity, 0),
    JSON.stringify(result.layers));
}

/* ================================================================== *
 *  Block D: multi-phase and parallel                                   *
 * ================================================================== */

/* ------------------------------------------------------------------ *
 *  Case 15: parallel phase — two ballistic hits share a layer         *
 *                                                                     *
 *  [kevlar 1mm].  Parallel: [ballistic 20 AP2, ballistic 20 AP2].    *
 *  Each: E 80 > 20 → residual 15, absorbed 5 → 2.5 concussive.       *
 *  Hit1: wear 6, integrity 30→24, breachLoss 0→6.                    *
 *  Hit2: breachRatio=6/30=0.2, roll=0.5≥0.2 → active.               *
 *       wear 6, integrity 24→18, breachLoss 6→12.                    *
 *  Body: ballistic 30 + concussive 5.                                 *
 * ------------------------------------------------------------------ */
{
  const layers = [makeLayer('kevlar', 1)];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'parallel', items: [
      { type: 'ballistic', damage: 20, armorPen: 2 },
      { type: 'ballistic', damage: 20, armorPen: 2 }
    ] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case15: parallel ×2 ballistic residuals reach body (30 total)',
    approxEqual(bodyAmount(result.bodyDamage, 'ballistic'), 30),
    JSON.stringify(result.bodyDamage));
  assert('Case15: parallel handed-on blows reach body (5 total)',
    approxEqual(bodyAmount(result.bodyDamage, 'concussive'), 5),
    JSON.stringify(result.bodyDamage));
  assert('Case15: kevlar integrity 30→18 after two pens',
    approxEqual(result.layers[0].integrity, 18),
    JSON.stringify(result.layers));
  assert('Case15: breachLoss = 12 after two pens',
    approxEqual(result.layers[0].breachLoss, 12),
    JSON.stringify(result.layers));
}

/* ------------------------------------------------------------------ *
 *  Case 16: sequential phase traversal (HEAT-like penetrator)        *
 *                                                                     *
 *  [steel-plate 1mm, foam 1mm].                                       *
 *  Phase A: ballistic 15, armorPen=1.                                 *
 *    Steel: eAR=10, E=15>10 → pen, residual=5.  wear=6→integrity 44. *
 *    Foam (CHANCE, active): eAR=6*1*25%=1.5, E=5>1.5 → pen,         *
 *      residual=5*(5-1.5)/5=3.5.  wear=50%*5=2.5→integrity 7.5.      *
 *    3.5 ballistic → body. position advances to layers.length.        *
 *  Phase B: thermal 10 → starts past all layers → body directly.     *
 *                                                                     *
 *  Body: 3.5 ballistic + 10 thermal.                                  *
 * ------------------------------------------------------------------ */
{
  const layers = [makeLayer('steel-plate', 1), makeLayer('foam', 1)];
  const result = resolveDamagePackage({
    layers,
    applications: [
      { mode: 'sequential', items: [{ type: 'ballistic', damage: 15, armorPen: 1 }] },
      { mode: 'sequential', items: [{ type: 'thermal', damage: 10 }] }
    ],
    resolveMaterial,
    random: determRandom
  });
  assert('Case16: HEAT phase A — ballistic 3.5 reaches body through steel+foam',
    approxEqual(bodyAmount(result.bodyDamage, 'ballistic'), 3.5),
    JSON.stringify(result.bodyDamage));
  assert('Case16: HEAT phase B — thermal 10 inherits past-armor position → body',
    approxEqual(bodyAmount(result.bodyDamage, 'thermal'), 10),
    JSON.stringify(result.bodyDamage));
  assert('Case16: steel worn to integrity 44',
    approxEqual(integrityLoss(result, 0), 6),
    JSON.stringify(result.layers));
  assert('Case16: foam worn to integrity 7.5',
    approxEqual(result.layers[1].integrity, 7.5),
    JSON.stringify(result.layers));
}

/* ------------------------------------------------------------------ *
 *  Case 17: bodyHits carry the energy and the damage reduction so a   *
 *  shard can be fed into another stack (wall penetration).            *
 *                                                                     *
 *  Steel t=1, ballistic 10, armorPen 2: E = 40, eAR = 10 → Eafter 30. *
 * ------------------------------------------------------------------ */
{
  const result = resolveDamagePackage({
    layers: [makeLayer('steel-plate', 1)],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2, armorDamageReduction: 50 }] }],
    resolveMaterial,
    random: determRandom
  });
  const hit = result.bodyHits.find((h) => h.type === 'ballistic');
  assert('Case17: bodyHit carries the energy left after the layer',
    !!hit && approxEqual(hit.energy, 30),
    JSON.stringify(result.bodyHits));
  assert('Case17: bodyHit carries armorDamageReduction',
    !!hit && hit.armorDamageReduction === 50,
    JSON.stringify(result.bodyHits));
}
{
  const result = resolveDamagePackage({
    layers: [],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2 }] }],
    resolveMaterial,
    random: determRandom
  });
  const hit = result.bodyHits.find((h) => h.type === 'ballistic');
  assert('Case17: no layers → full energy, no armorDamageReduction key',
    !!hit && approxEqual(hit.energy, 40) && !('armorDamageReduction' in hit),
    JSON.stringify(result.bodyHits));
}

/* ------------------------------------------------------------------ *
 *  Case 18: a glancing hit — the energy is scaled before the armour   *
 *  (hit-quality.mjs), the damage follows by the same reduction law.   *
 *                                                                     *
 *  Steel t=1, ballistic 10, armorPen 2: E = 40, eAR = 10.             *
 * ------------------------------------------------------------------ */
{
  const shot = [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2 }] }];
  const resolveWith = (layers, m) => resolveDamagePackage({
    layers,
    applications: applyEnergyScaleToApplications(shot, m),
    resolveMaterial,
    random: determRandom
  });

  assert('Case18: damage ratio — pct 100 follows the energy, 50 halves the loss, 0 ignores it',
    approxEqual(damageRatioForEnergyRatio(0.4, 100), 0.4) && approxEqual(damageRatioForEnergyRatio(0.4, 50), 0.7)
    && approxEqual(damageRatioForEnergyRatio(0.4, 0), 1) && approxEqual(damageRatioForEnergyRatio(1, 100), 1));
  assert('Case18: multiplier 1 returns the package untouched', applyEnergyScaleToApplications(shot, 1) === shot);

  const bare = resolveWith([], 0.5);
  assert('Case18: no armour — the glancing hit simply does less damage (10 → 5)',
    approxEqual(bodyAmount(bare.bodyDamage, 'ballistic'), 5), JSON.stringify(bare.bodyDamage));

  const full = resolveWith([makeLayer('steel-plate', 1)], 1);
  const half = resolveWith([makeLayer('steel-plate', 1)], 0.5);
  assert('Case18: armour — the same shot at half energy gets through with far less (7.5 → 2.5)',
    approxEqual(bodyAmount(full.bodyDamage, 'ballistic'), 7.5) && approxEqual(bodyAmount(half.bodyDamage, 'ballistic'), 2.5),
    JSON.stringify({ full: full.bodyDamage, half: half.bodyDamage }));

  const stopped = resolveWith([makeLayer('steel-plate', 1)], 0.25);
  assert('Case18: armour — at a quarter of the energy (E = 10 = eAR) the plate holds',
    bodyAmount(stopped.bodyDamage, 'ballistic') === 0, JSON.stringify(stopped.bodyDamage));

  const carried = applyEnergyScaleToApplications(
    [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2, energy: 30 }] }], 0.5)[0].items[0];
  assert('Case18: a carried energy (after walls) is scaled, not recomputed', approxEqual(carried.energy, 15) && approxEqual(carried.damage, 5), JSON.stringify(carried));

  const soft = applyEnergyScaleToApplications(
    [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2, armorDamageReduction: 0 }] }], 0.5)[0].items[0];
  assert('Case18: armorDamageReduction 0 — the lost energy costs no damage, only penetration',
    approxEqual(soft.damage, 10) && approxEqual(soft.energy, 20), JSON.stringify(soft));
}

/* ------------------------------------------------------------------ *
 *  Case 19: shock handed on by armour is flagged `transferred`        *
 *  (kevlar conducts ballistic → concussive; that is not the bullet).  *
 * ------------------------------------------------------------------ */
{
  const held = resolveDamagePackage({
    layers: [makeLayer('kevlar', 1)],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 20, armorPen: 1 }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case19: a stopped projectile hands on only flagged shock',
    held.bodyHits.length > 0 && held.bodyHits.every((h) => h.transferred === true), JSON.stringify(held.bodyHits));

  const through = resolveDamagePackage({
    layers: [makeLayer('kevlar', 1)],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 20, armorPen: 2 }] }],
    resolveMaterial,
    random: determRandom
  });
  const shock = through.bodyHits.find((h) => h.type === 'concussive');
  const bullet = through.bodyHits.find((h) => h.type === 'ballistic');
  assert('Case19: on penetration the conducted share is flagged, the residual projectile is not',
    shock?.transferred === true && bullet && bullet.transferred === undefined, JSON.stringify(through.bodyHits));

  const bare = resolveDamagePackage({
    layers: [],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 20, armorPen: 1 }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case19: no armour — nothing is flagged', bare.bodyHits.every((h) => h.transferred === undefined), JSON.stringify(bare.bodyHits));

  const norm = normalizeApplications([{ type: 'concussive', damage: 3, transferred: true }])[0].items[0];
  assert('Case19: normalizeApplications keeps the flag', norm.transferred === true, JSON.stringify(norm));

  const carried = resolveDamagePackage({
    layers: [],
    applications: [{ mode: 'sequential', items: [{ type: 'concussive', damage: 3, transferred: true }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case19: a flagged hit stays flagged through another stack',
    carried.bodyHits.length === 1 && carried.bodyHits[0].transferred === true, JSON.stringify(carried.bodyHits));
}

/* ------------------------------------------------------------------ *
 *  Case 20: padding softens a handed-on blow                          *
 *                                                                     *
 *  [kevlar 1mm, pad 4mm with damping.concussive 0.25]: kevlar holds  *
 *  ballistic 20 (E 20) → 10 concussive → × e^(−0.25×4) through pad.  *
 * ------------------------------------------------------------------ */
{
  const customResolve = (id) => (id === 'pad'
    ? { materialId: 'pad', hardness: 1, integrityPerThickness: 10, resistance: {}, damping: { concussive: 0.25 } }
    : resolveMaterial(id));
  const result = resolveDamagePackage({
    layers: [makeLayer('kevlar', 1), { material: 'pad', thickness: 4, integrity: 40, integrityMax: 40, breachLoss: 0, breachCapacity: 40 }],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 20, armorPen: 1 }] }],
    resolveMaterial: customResolve,
    random: determRandom
  });
  assert('Case20: padding softens the blow by e^(−damping × thickness)',
    approxEqual(bodyAmount(result.bodyDamage, 'concussive'), 10 * Math.exp(-1)),
    JSON.stringify(result.bodyDamage));
  assert('Case20: the softening is in the trace',
    result.trace.some((t) => t.kind === 'damp' && approxEqual(t.before, 10)));
}

/* ------------------------------------------------------------------ *
 *  Case 21: distribution tail carries its share of the energy         *
 *                                                                     *
 *  Distribution layer at 50% integrity: half the hit skips it as the  *
 *  same type with half the energy (not the whole package energy).     *
 * ------------------------------------------------------------------ */
{
  const customResolve = (id) => (id === 'distro'
    ? { materialId: 'distro', hardness: 1, integrityPerThickness: 100, resistance: { ballistic: 50 }, wear: { ballistic: 0 }, degradation: { ballistic: DEGRADATION_MODES.DISTRIBUTION } }
    : resolveMaterial(id));
  const result = resolveDamagePackage({
    layers: [{ material: 'distro', thickness: 1, integrity: 50, integrityMax: 100, breachLoss: 0, breachCapacity: 100 }],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 30, energy: 40 }] }],
    resolveMaterial: customResolve,
    random: determRandom
  });
  const energies = result.bodyHits.map((h) => h.energy).sort((x, y) => x - y);
  assert('Case21: the bypassing half keeps half the energy (20); the inside half loses eAR 0.5 (19.5)',
    energies.length === 2 && approxEqual(energies[0], 19.5) && approxEqual(energies[1], 20),
    JSON.stringify(result.bodyHits));
}

/* ================================================================== *
 *  Tags: whose events are these (the pellets of a volley)             *
 * ================================================================== */

{
  // Three pellets in a parallel phase against 1 unit of steel: pellet 0 and 1 are strong enough, pellet 2 is held.
  const layers = [makeLayer('steel-plate', 1)];
  const pellet = (tag, armorPen) => ({ type: 'ballistic', damage: 10, armorPen, armorDamageFactor: 1, hardness: 1, tag });
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'parallel', items: [pellet(0, 2), pellet(1, 2), pellet(2, 0.5)] }],
    resolveMaterial,
  });
  const events = result.trace.filter((e) => e.kind === 'penetrate' || e.kind === 'hold');
  assert('Tag: the events of an item carry its tag, in the order the items ran',
    events.map((e) => `${e.kind}:${e.tag}`).join() === 'penetrate:0,penetrate:1,hold:2', events.map((e) => `${e.kind}:${e.tag}`));
  assert('Tag: the body hits of an item carry it too (the held pellet has none)',
    result.bodyHits.map((h) => h.tag).join() === '0,1', result.bodyHits);
  const plain = resolveDamagePackage({ layers: [makeLayer('steel-plate', 1)], applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 2, hardness: 1 }] }], resolveMaterial });
  assert('Tag: an item without a tag leaves events and hits without one', plain.trace.every((e) => !('tag' in e)) && plain.bodyHits.every((h) => !('tag' in h)));
  const kept = normalizeApplications([{ mode: 'parallel', items: [pellet(3, 2), { ...pellet(0, 2), tag: 'x' }, { ...pellet(0, 2), tag: undefined }] }]);
  assert('Tag: normalizeApplications keeps an integer tag and drops anything else', kept[0].items.map((i) => i.tag).join() === '3,,', kept[0].items.map((i) => i.tag));
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll resolver smoke tests passed.');
}

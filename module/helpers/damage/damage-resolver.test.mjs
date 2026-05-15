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

import { resolveDamagePackage, normalizeApplications } from './damage-resolver.mjs';
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
 *  selfInduction.ballistic on hold: [{thermal,0.2},{concussive,0.3}]  *
 *  iRem = 0 → full overflow: thermal 40 + concussive 60 → body.       *
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
  assert('Case1: selfInduction overflow reaches body when integrity exhausted (thermal 40)',
    approxEqual(bodyAmount(result.bodyDamage, 'thermal'), 40),
    JSON.stringify(result.bodyDamage));
  assert('Case1: selfInduction overflow reaches body when integrity exhausted (concussive 60)',
    approxEqual(bodyAmount(result.bodyDamage, 'concussive'), 60),
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
 *  Case 5: conductance before structural hold (kevlar, armorPen=1)   *
 *                                                                     *
 *  1mm kevlar. conductance.ballistic=[{concussive,0.5}].             *
 *  xStruct=10 ballistic, 10 concussive forwarded to body.            *
 *  eAR = 20*1*100% = 20.  E = 10*1*1 = 10 ≤ 20 → held.              *
 *  (CHANCE mode, breachRatio=0/30=0 → active since roll≥0.)          *
 *  wear = 30%*10 = 3 → integrity 30→27.                              *
 *  selfInduction.ballistic=[{thermal,0.05}]:                         *
 *    d_thermal = 100%*10*0.05 = 0.5 → absorbed; integrity 26.5.      *
 * ------------------------------------------------------------------ */
{
  const layers = [makeLayer('kevlar', 1)];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 20, armorPen: 1 }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case5: only conducted concussive reaches body (ballistic held by kevlar)',
    bodyAmount(result.bodyDamage, 'ballistic') === 0 && approxEqual(bodyAmount(result.bodyDamage, 'concussive'), 10),
    JSON.stringify(result.bodyDamage));
  assert('Case5: kevlar integrity 30→26.5 (struct wear + selfInduction thermal)',
    approxEqual(result.layers[0].integrity, 26.5),
    JSON.stringify(result.layers));
  assert('Case5: no breachLoss on hold',
    approxEqual(result.layers[0].breachLoss, 0));
}

/* ------------------------------------------------------------------ *
 *  Case 6: conductance + penetration (kevlar, armorPen=2)            *
 *                                                                     *
 *  1mm kevlar. xStruct=10, 10 concussive → body.                     *
 *  eAR=20.  E = 10*4*1 = 40 > 20 → penetrates.                      *
 *  residual = 10*(40-20)/40 = 5 ballistic → body.                    *
 *  wear = 30%*10 = 3 → integrity 27.  breachLoss = 3.                *
 * ------------------------------------------------------------------ */
{
  const layers = [makeLayer('kevlar', 1)];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 20, armorPen: 2 }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case6: concussive 10 conducted to body on penetration',
    approxEqual(bodyAmount(result.bodyDamage, 'concussive'), 10),
    JSON.stringify(result.bodyDamage));
  assert('Case6: ballistic residual 5 reaches body',
    approxEqual(bodyAmount(result.bodyDamage, 'ballistic'), 5),
    JSON.stringify(result.bodyDamage));
  assert('Case6: kevlar integrity 30→27 on penetration',
    approxEqual(result.layers[0].integrity, 27),
    JSON.stringify(result.layers));
  assert('Case6: breachLoss = 3',
    approxEqual(result.layers[0].breachLoss, 3),
    JSON.stringify(result.layers));
}

/* ------------------------------------------------------------------ *
 *  Case 7: multi-layer (kevlar + foam) fully absorbs ballistic        *
 *                                                                     *
 *  [kevlar 1mm, foam 1mm].  ballistic 10, armorPen=1.                *
 *  Kevlar conducts 5 concussive → foam; xStruct=5 ballistic vs kevlar.*
 *                                                                     *
 *  Foam receives 5 concussive (REDUCTION, eAR=6*1*300%=18):          *
 *    E=5 ≤ 18 → held.  wear=30%*5=1.5 → foam 10→8.5.               *
 *    selfInduction.concussive=[{thermal,0.1}]:                       *
 *    d_thermal=100%*5*0.1=0.5 → absorbed → foam integrity 8.0.       *
 *                                                                     *
 *  Kevlar structural (5 ballistic, CHANCE, active):                  *
 *    eAR=20, E=5 ≤ 20 → held.  wear=30%*5=1.5 → kevlar 30→28.5.    *
 *    selfInduction.ballistic=[{thermal,0.05}]:                       *
 *    d_thermal=100%*5*0.05=0.25 → absorbed → kevlar integrity 28.25. *
 * ------------------------------------------------------------------ */
{
  const layers = [makeLayer('kevlar', 1), makeLayer('foam', 1)];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10, armorPen: 1 }] }],
    resolveMaterial,
    random: determRandom
  });
  assert('Case7: kevlar+foam fully absorb ballistic 10',
    result.bodyDamage.length === 0,
    JSON.stringify(result.bodyDamage));
  assert('Case7: kevlar integrity 30→28.25 after struct wear + selfInduction',
    approxEqual(result.layers[0].integrity, 28.25),
    JSON.stringify(result.layers));
  assert('Case7: foam integrity 10→8.0 after conducted concussive absorption',
    approxEqual(result.layers[1].integrity, 8.0),
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
 *  Conductance 0.5 runs first → 12.5 concussive → body.              *
 *  CHANCE: breachRatio=1, roll=0.99 < 1 → skip → full 12.5 ballistic *
 *  bypasses through to body.                                          *
 * ------------------------------------------------------------------ */
{
  const layer = makeLayer('kevlar', 1, { breachLoss: 30 });
  const result = resolveDamagePackage({
    layers: [layer],
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 25, armorPen: 1 }] }],
    resolveMaterial,
    random: () => 0.99
  });
  assert('Case12: chance bypass at full breach → structural ballistic 12.5 reaches body',
    approxEqual(bodyAmount(result.bodyDamage, 'ballistic'), 12.5),
    JSON.stringify(result.bodyDamage));
  assert('Case12: conductance still delivers concussive 12.5 before bypass',
    approxEqual(bodyAmount(result.bodyDamage, 'concussive'), 12.5),
    JSON.stringify(result.bodyDamage));
}

/* ------------------------------------------------------------------ *
 *  Case 13: full conductance (material is transparent to the type)   *
 *                                                                     *
 *  Custom 'wire' conducts 100% of electric to body. xStruct = 0, so  *
 *  no structural evaluation, no wear, no selfInduction.              *
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
  assert('Case13: wire integrity untouched (conductance causes no wear)',
    approxEqual(result.layers[0].integrity, 100),
    JSON.stringify(result.layers));
}

/* ------------------------------------------------------------------ *
 *  Case 14: selfInduction partial overflow (low-integrity layer)     *
 *                                                                     *
 *  Custom 'brittle': hardness=1, R.ballistic=30%, wear.ballistic=10%.*
 *  wear.thermal=200%, wear.concussive=300%.                          *
 *  selfInduction.ballistic=[{thermal,0.5},{concussive,0.5}], BASTION.*
 *  integrity=10, damage=10, armorPen=0.                              *
 *                                                                     *
 *  eAR=1*1*30%=0.3, E=0 → held.                                     *
 *  struct wear=10%*10=1 → integrity=9.  iRem=9.                     *
 *  d_thermal=200%*10*0.5=10, d_conc=300%*10*0.5=15. D=25 > 9.       *
 *  overflowFactor = 1 - 9/25 = 0.64.                                 *
 *  chunk=5 per entry → overflow 5*0.64=3.2 for each → body.         *
 * ------------------------------------------------------------------ */
{
  const customResolve = (id) => {
    if (id === 'brittle') {
      return {
        materialId: 'brittle',
        hardness: 1,
        integrityPerThickness: 10,
        resistance: { ballistic: 30 },
        wear: { ballistic: 10, thermal: 200, concussive: 300 },
        conductance: {},
        selfInduction: {
          ballistic: [
            { type: 'thermal', fraction: 0.5 },
            { type: 'concussive', fraction: 0.5 }
          ]
        },
        degradation: { ballistic: DEGRADATION_MODES.BASTION }
      };
    }
    return resolveMaterial(id);
  };
  const layers = [{ material: 'brittle', thickness: 1, integrity: 10, integrityMax: 10, breachLoss: 0, breachCapacity: 10 }];
  const result = resolveDamagePackage({
    layers,
    applications: [{ mode: 'sequential', items: [{ type: 'ballistic', damage: 10 }] }],
    resolveMaterial: customResolve,
    random: determRandom
  });
  assert('Case14: partial selfInduction overflow sends thermal 3.2 to body',
    approxEqual(bodyAmount(result.bodyDamage, 'thermal'), 3.2),
    JSON.stringify(result.bodyDamage));
  assert('Case14: partial selfInduction overflow sends concussive 3.2 to body',
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
 *  Each hit: conductance 0.5 → 10 conc to body; xStruct=10.          *
 *  eAR=20 (CHANCE, full base).  E=10*4*1=40 > 20 → pen, residual=5.  *
 *  Hit1: wear=3, integrity 30→27, breachLoss 0→3.                    *
 *  Hit2: breachRatio=3/30=0.1, roll=0.5≥0.1 → active.               *
 *       wear=3, integrity 27→24, breachLoss 3→6.  residual=5 again.  *
 *  Body: ballistic 10 + concussive 20.                                *
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
  assert('Case15: parallel ×2 ballistic residuals reach body (10 total)',
    approxEqual(bodyAmount(result.bodyDamage, 'ballistic'), 10),
    JSON.stringify(result.bodyDamage));
  assert('Case15: parallel conducted concussive reaches body (20 total)',
    approxEqual(bodyAmount(result.bodyDamage, 'concussive'), 20),
    JSON.stringify(result.bodyDamage));
  assert('Case15: kevlar integrity 30→24 after two pens',
    approxEqual(result.layers[0].integrity, 24),
    JSON.stringify(result.layers));
  assert('Case15: breachLoss = 6 after two pens',
    approxEqual(result.layers[0].breachLoss, 6),
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

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll resolver smoke tests passed.');
}

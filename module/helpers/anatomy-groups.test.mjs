/**
 * Smoke tests for anatomy-groups: organs (data + derived state), lost parts in hit picking and
 * group ability, and the organs shipped in the presets. Plain Node, no Foundry globals:
 *   node module/helpers/anatomy-groups.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

import { readFileSync } from 'node:fs';
import {
  INNER_STATUS,
  availableHitGroups,
  computeDeathState,
  computeInnerState,
  getGroupAbility,
  groupSlotRefs,
  isPartAlive,
  isVitalInner,
  partTissue,
  partStructure,
  sanitizeInners,
  DEFAULT_PART_TISSUE,
  DEFAULT_INNER_BLEED,
} from './anatomy-groups.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

// --- organ data --------------------------------------------------------------------------------------
{
  const inners = sanitizeInners([
    { id: 'brain', name: 'Brain', material: 'skin', occupancyPct: 50, maxHp: 10, tags: ['vital', 'vital', ' '] },
    { id: 'eyes', occupancyPct: 70, statuses: ['x'] },
    { id: 'ears', occupancyPct: 10 },
  ]);
  assert('sanitizeInners: own HP and unique non-empty tags are kept',
    inners[0].maxHp === 10 && inners[0].tags.length === 1 && inners[0].tags[0] === 'vital', inners[0]);
  assert('sanitizeInners: shares are capped at 100 in total, the rest is dropped',
    inners.length === 2 && inners[1].occupancyPct === 50, inners);
  assert('sanitizeInners: no stored statuses; HP defaults to 0, tags to none',
    !('statuses' in inners[1]) && inners[1].maxHp === 0 && Array.isArray(inners[1].tags) && inners[1].tags.length === 0, inners[1]);
  assert('isVitalInner: by the vital tag', isVitalInner(inners[0]) && !isVitalInner(inners[1]));
}

// --- organ state -------------------------------------------------------------------------------------
{
  const brain = { maxHp: 10 };
  const fresh = computeInnerState(brain);
  assert('computeInnerState: untouched organ is ok at full HP',
    fresh.status === INNER_STATUS.OK && fresh.currentHp === 10 && fresh.effectiveMaxHp === 10, fresh);
  const hurt = computeInnerState(brain, { damageAmount: 450 });
  assert('computeInnerState: damage is in the x100 scale of injuries (450 → 4 HP, rounded down)',
    hurt.currentHp === 6 && hurt.status === INNER_STATUS.DAMAGED, hurt);
  const dead = computeInnerState(brain, { damageAmount: 1000 });
  assert('computeInnerState: all HP gone → destroyed', dead.currentHp === 0 && dead.status === INNER_STATUS.DESTROYED, dead);
  assert('computeInnerState: more damage than HP does not go below 0', computeInnerState(brain, { damageAmount: 99999 }).currentHp === 0);
  const scaled = computeInnerState(brain, { hpScale: 1.5 });
  assert('computeInnerState: the END multiplier scales the organ like a part', scaled.effectiveMaxHp === 15 && scaled.currentHp === 15, scaled);
  const lost = computeInnerState(brain, { lost: true });
  assert('computeInnerState: an organ of a lost part is lost, at 0 HP',
    lost.lost === true && lost.currentHp === 0 && lost.status === INNER_STATUS.LOST, lost);
  const noHp = computeInnerState({ maxHp: 0 }, { damageAmount: 5000 });
  assert('computeInnerState: an organ without HP is never damaged', noHp.status === INNER_STATUS.OK && noHp.effectiveMaxHp === 0, noHp);
}

// --- lost parts: hit picking and group ability -------------------------------------------------------
{
  const part = (id, maxHp, currentHp, lost = false) => ({ id, maxHp, currentHp, lost });
  const bodyParts = {
    'arm#1': part('arm', 30, 0, true),
    'hand#1': part('hand', 15, 0, true),
    'leg#1': part('leg', 35, 35),
    'leg#2': part('leg', 35, 10),
    'ghost#1': part('ghost', 0, 0),
  };
  const actor = {
    system: {
      health: { bodyParts },
      anatomy: {
        groups: [
          { id: 'arms', type: 'manipulation', name: 'Arms', parts: ['arm#1', 'hand#1'] },
          { id: 'legs', type: 'movement', name: 'Legs', parts: ['leg#1', 'leg#2'] },
        ],
      },
    },
  };
  assert('isPartAlive: needs HP to lose and not lost',
    isPartAlive(bodyParts['leg#1']) && !isPartAlive(bodyParts['arm#1']) && !isPartAlive(bodyParts['ghost#1']));
  assert('groupSlotRefs: by default lists every member, lost or not',
    groupSlotRefs(bodyParts, actor.system.anatomy.groups[0]).join() === 'arm#1,hand#1');
  assert('groupSlotRefs: aliveOnly leaves lost parts out',
    groupSlotRefs(bodyParts, actor.system.anatomy.groups[0], { aliveOnly: true }).length === 0
    && groupSlotRefs(bodyParts, actor.system.anatomy.groups[1], { aliveOnly: true }).join() === 'leg#1,leg#2');
  assert('availableHitGroups: a group whose parts are all lost cannot be hit',
    availableHitGroups(actor).map((g) => g.id).join() === 'legs');
  assert('getGroupAbility: lost parts count as 0 HP', getGroupAbility(actor, 'arms') === 0);
  assert('getGroupAbility: current / max over the members',
    Math.abs(getGroupAbility(actor, 'legs') - 45 / 70) < 1e-9, getGroupAbility(actor, 'legs'));
}

// --- tissue ------------------------------------------------------------------------------------------
{
  const t = partTissue({ material: 'bone', tissue: { depthShare: 0.8, bleed: 12 } });
  assert('partTissue: given fields are kept, the rest defaults',
    t.material === 'bone' && t.depthShare === 0.8 && t.bleed === 12
      && t.depthFlat === DEFAULT_PART_TISSUE.depthFlat && t.organDepth === DEFAULT_PART_TISSUE.organDepth, t);
  assert('partTissue: a part without tissue gets the defaults and a material', partTissue({}).shellThickness === DEFAULT_PART_TISSUE.shellThickness && partTissue({}).material === 'skin');
  assert('partStructure: no structure — no saturation, no reserve', partStructure({}).saturation === 0 && partStructure({}).reserve === 0);
  assert('partStructure: values are kept; a saturation below 1 means none',
    partStructure({ structure: { saturation: 2, reserve: 0.5 } }).saturation === 2 && partStructure({ structure: { saturation: 0.5 } }).saturation === 0);
  assert('partTissue: shares are clamped to 1', partTissue({ tissue: { depthShare: 3, bluntToParent: 2 } }).depthShare === 1);
  const inners = sanitizeInners([{ id: 'heart', occupancyPct: 15, maxHp: 15, bleed: 40 }, { id: 'kidney', occupancyPct: 5, maxHp: 10 }]);
  assert('sanitizeInners: organ bleed is kept, missing → default', inners[0].bleed === 40 && inners[1].bleed === DEFAULT_INNER_BLEED, inners);
}

// --- death -------------------------------------------------------------------------------------------
{
  const inner = (id, status, vital = false) => ({ id, status, tags: vital ? ['vital'] : [] });
  const body = (overrides = {}) => ({
    head: { lost: false, inners: [inner('brain', 'ok', true), inner('eyes', 'ok')] },
    torso: { lost: false, inners: [inner('heart', 'ok', true), inner('lungs', 'ok')] },
    hand: { lost: false, inners: [] },
    ...overrides,
  });
  assert('computeDeathState: a healthy body lives', computeDeathState(body(), 'head').dead === false);
  const noRoot = computeDeathState(body({ head: { lost: true, inners: [inner('brain', 'lost', true)] } }), 'head');
  assert('computeDeathState: a lost root is death, and the root is the reason',
    noRoot.dead && noRoot.reason === 'root' && noRoot.slotRef === 'head', noRoot);
  const brain = computeDeathState(body({ head: { lost: false, inners: [inner('brain', 'destroyed', true)] } }), 'head');
  assert('computeDeathState: a destroyed vital organ is death, naming the organ',
    brain.dead && brain.reason === 'organ' && brain.slotRef === 'head' && brain.innerId === 'brain', brain);
  const heartLost = computeDeathState(body({ torso: { lost: true, inners: [inner('heart', 'lost', true)] } }), 'head');
  assert('computeDeathState: a vital organ lost with its part is death too', heartLost.dead && heartLost.innerId === 'heart', heartLost);
  assert('computeDeathState: a destroyed organ that is not vital is not death',
    !computeDeathState(body({ head: { lost: false, inners: [inner('eyes', 'destroyed')] } }), 'head').dead);
  const wound = (id, lost, vital = true) => ({ id, status: 'damaged', tags: vital ? ['vital'] : [], effectiveMaxHp: 40, currentHp: 40 - lost });
  const graze = computeDeathState(body({ head: { lost: false, inners: [wound('brain', 5)] } }), 'head');
  assert('computeDeathState: a vital organ grazed (under a quarter of its HP) is not dying', !graze.dead && !graze.dying, graze);
  const fragile = computeDeathState(body({ head: { lost: false, inners: [{ ...wound('brain', 5), mortalShare: 0.1 }] } }), 'head');
  assert('computeDeathState: an organ with a lower mortalShare (the brain) is dying from less', fragile.dying, fragile);
  assert('sanitizeInners: mortalShare is kept when given', sanitizeInners([{ id: 'brain', occupancyPct: 50, maxHp: 40, mortalShare: 0.1 }])[0].mortalShare === 0.1);
  const damaged = computeDeathState(body({ head: { lost: false, inners: [wound('brain', 12)] } }), 'head');
  assert('computeDeathState: a damaged vital organ is not death — the body is dying',
    !damaged.dead && damaged.dying && damaged.reason === 'organ' && damaged.innerId === 'brain', damaged);
  assert('computeDeathState: a damaged organ that is not vital is not dying',
    !computeDeathState(body({ head: { lost: false, inners: [inner('eyes', 'damaged')] } }), 'head').dying);
  const bleeding = computeDeathState(body(), 'head', { bleeding: { mortal: true, minutesToDeath: 6 } });
  assert('computeDeathState: bleeding out within minutes is dying',
    !bleeding.dead && bleeding.dying && bleeding.reason === 'bleeding' && bleeding.minutesToDeath === 6, bleeding);
  assert('computeDeathState: slow bleeding is not dying',
    !computeDeathState(body(), 'head', { bleeding: { mortal: false, minutesToDeath: 40 } }).dying);
  const both = computeDeathState(body({ head: { lost: false, inners: [inner('brain', 'destroyed', true)] } }), 'head', { bleeding: { mortal: true } });
  assert('computeDeathState: death wins over dying', both.dead && !both.dying);
  assert('computeDeathState: losing a limb is not death',
    !computeDeathState(body({ hand: { lost: true, inners: [] } }), 'head').dead);
  assert('computeDeathState: no parts, no death', !computeDeathState({}, '').dead && !computeDeathState(undefined, undefined).dead);
}

// --- organs shipped in the presets -------------------------------------------------------------------
for (const id of ['humanoid', 'quadruped', 'arachnid']) {
  const preset = JSON.parse(readFileSync(new URL(`../../data/anatomy/${id}.json`, import.meta.url), 'utf8'));
  const withOrgans = Object.entries(preset.bodyParts).filter(([, p]) => (p.inners ?? []).length);
  const sums = withOrgans.map(([, p]) => p.inners.reduce((s, o) => s + o.occupancyPct, 0));
  assert(`preset ${id}: organ shares per part stay within 100`, sums.every((s) => s <= 100), sums);
  const allInners = withOrgans.flatMap(([, p]) => p.inners);
  assert(`preset ${id}: every organ has HP and a tag list, no stored statuses`,
    allInners.every((o) => o.maxHp > 0 && Array.isArray(o.tags) && !('statuses' in o)), allInners);
  assert(`preset ${id}: a vital organ exists (the brain)`,
    allInners.some((o) => o.id === 'brain' && isVitalInner(o)));
}
{
  const humanoid = JSON.parse(readFileSync(new URL('../../data/anatomy/humanoid.json', import.meta.url), 'utf8'));
  const vital = Object.values(humanoid.bodyParts).flatMap((p) => p.inners ?? []).filter(isVitalInner).map((o) => o.id).sort();
  assert('preset humanoid: the brain and the heart are vital, nothing else', vital.join() === 'brain,heart', vital);
}

if (failed) {
  console.log(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll anatomy-groups checks passed');

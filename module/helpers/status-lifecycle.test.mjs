/**
 * Tests for the statuses the system hangs and takes off by itself, on stand-ins for actors and effects.
 * Plain Node, no Foundry globals:
 *   node module/helpers/status-lifecycle.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

import { SPACEHOLDER_STATUS_EFFECTS } from './status-effects.mjs';
import {
  activeStatusIds,
  blockersOfNewEffect,
  dropBlockedStatuses,
  endStatuses,
  endStatusesInCombat,
  handleCombatAction,
  handleTokenUpdate,
  hangStatus,
  isTokenInCombat,
} from './status-lifecycle.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const freshRegistry = () => ({
  ...Object.fromEntries(SPACEHOLDER_STATUS_EFFECTS.map((s) => [s.id, structuredClone(s)])),
  dead: { id: 'dead', name: 'EFFECT.StatusDead' },
  unconscious: { id: 'unconscious', name: 'EFFECT.StatusUnconscious' },
});

let nextId = 0;
const effect = (statuses, { active = true, endOn } = {}) => ({
  id: `fx${++nextId}`,
  statuses: new Set(statuses),
  active,
  getFlag: (scope, key) => (scope === 'spaceholder' && key === 'endOn' ? endOn : undefined),
});

/** An actor that keeps its effects in a list and records what was done to them. */
function actor({ type = 'character', has = [], delayMs = 0 } = {}) {
  const a = {
    type,
    uuid: `Actor.${++nextId}`,
    effects: has.map((s) => (typeof s === 'string' ? effect([s]) : s)),
    log: [],
    async toggleStatusEffect(id, { active }) {
      a.log.push(`toggle:${id}:${active}`);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (active) a.effects.push(effect([id]));
      else a.effects = a.effects.filter((e) => !e.statuses.has(id));
    },
    async deleteEmbeddedDocuments(name, ids) {
      a.log.push(`delete:${ids.length}`);
      a.effects = a.effects.filter((e) => !ids.includes(e.id));
    },
  };
  return a;
}

const names = (a) => a.effects.flatMap((e) => [...e.statuses]).sort().join();
const registry = freshRegistry();

// ---------------------------------------------------------------------------------------------
// Hanging a status
// ---------------------------------------------------------------------------------------------

{
  const a = actor();
  assert('hang: an actor without the status gets it', (await hangStatus(a, 'combatReady', registry)) === 'added' && names(a) === 'combatReady');
  assert('hang: already there — nothing is done', (await hangStatus(a, 'combatReady', registry)) === 'present' && a.log.length === 1);
}
for (const blocker of ['dead', 'unconscious']) {
  const a = actor({ has: [blocker] });
  assert(`hang: ${blocker} forbids combat readiness`, (await hangStatus(a, 'combatReady', registry)) === 'blocked' && names(a) === blocker && a.log.length === 0);
  a.effects = [];
  assert(`hang: without ${blocker} it can be hung again`, (await hangStatus(a, 'combatReady', registry)) === 'added');
}
{
  const a = actor({ has: [effect(['dead'], { active: false })] });
  assert('hang: a disabled blocker does not forbid', (await hangStatus(a, 'combatReady', registry)) === 'added');
}
{
  const a = actor({ type: 'loot' });
  assert('hang: an actor type the status is not for is skipped', (await hangStatus(a, 'combatReady', registry)) === 'skipped' && a.log.length === 0);
  assert('hang: an unknown status', (await hangStatus(actor(), 'nope', registry)) === 'unknown');
  assert('hang: no actor', (await hangStatus(null, 'combatReady', registry)) === 'unknown');
}
{
  const a = actor({ delayMs: 5 });
  const [first, second] = await Promise.all([hangStatus(a, 'moving', registry), hangStatus(a, 'moving', registry)]);
  assert('hang: two calls at once hang it once', [first, second].sort().join() === 'added,pending' && names(a) === 'moving', { first, second });
}
{
  const reg = freshRegistry();
  reg.combatReady.blockedBy.push('stun');
  const a = actor({ has: ['stun'] });
  assert('hang: a blocker added to the list is honoured', (await hangStatus(a, 'combatReady', reg)) === 'blocked');
}

// ---------------------------------------------------------------------------------------------
// A blocker appears: what it forbids comes off
// ---------------------------------------------------------------------------------------------

{
  const a = actor({ has: ['combatReady', 'moving', 'unconscious'] });
  assert('drop: unconscious takes combat readiness off and leaves the rest',
    (await dropBlockedStatuses(a, registry)) === 1 && names(a) === 'moving,unconscious', names(a));
  assert('drop: nothing more to do the second time', (await dropBlockedStatuses(a, registry)) === 0);
}
{
  const a = actor({ has: ['combatReady', 'dead'] });
  await dropBlockedStatuses(a, registry);
  assert('drop: dead too', names(a) === 'dead');
  const healthy = actor({ has: ['combatReady', 'moving'] });
  assert('drop: a healthy actor keeps everything', (await dropBlockedStatuses(healthy, registry)) === 0 && names(healthy) === 'combatReady,moving');
}
{
  const a = actor({ has: ['combatReady', effect(['unconscious'], { active: false })] });
  assert('drop: a disabled blocker takes nothing off', (await dropBlockedStatuses(a, registry)) === 0);
}

// The veto before an effect is created
{
  const parent = { documentName: 'Actor', effects: [effect(['unconscious'])], type: 'character' };
  const pending = { parent, statuses: new Set(['combatReady']) };
  assert('veto: combat readiness cannot be put on an unconscious actor', blockersOfNewEffect(pending, registry).join() === 'unconscious');
  assert('veto: another status can', blockersOfNewEffect({ parent, statuses: new Set(['cover']) }, registry).length === 0);
  assert('veto: an effect of an item is not judged', blockersOfNewEffect({ parent: { documentName: 'Item' }, statuses: new Set(['combatReady']) }, registry).length === 0);
  assert('active ids: read from the effects, disabled ones left out',
    [...activeStatusIds(actor({ has: ['cover', effect(['hidden'], { active: false })] }))].join() === 'cover');
}

// ---------------------------------------------------------------------------------------------
// Events that take statuses off
// ---------------------------------------------------------------------------------------------

{
  const a = actor({ has: ['combatReady', 'moving', 'cover', 'hidden'] });
  assert('end: a move takes cover and hiding off, not the rest', (await endStatuses(a, 'move', registry)) === 2 && names(a) === 'combatReady,moving');
  assert('end: a new round takes «moving» off', (await endStatuses(a, 'roundStart', registry)) === 1 && names(a) === 'combatReady');
  assert('end: the end of the combat takes combat readiness off', (await endStatuses(a, 'combatEnd', registry)) === 1 && names(a) === '');
  assert('end: an action takes «moving» off',
    (await endStatuses(actor({ has: ['moving', 'cover', 'combatReady'] }), 'action', registry)) === 1);
  assert('end: nothing to take off — no call', (await endStatuses(a, 'move', registry)) === 0 && a.log.at(-1) === 'delete:1');
}
{
  const a = actor({ has: [effect(['moving']), effect([], { endOn: ['turn'] })] });
  assert('end: an effect with its own endOn comes off on that event', (await endStatuses(a, 'turn', registry)) === 1 && names(a) === 'moving');
}
{
  const combat = {
    started: true,
    combatants: { contents: [{ tokenId: 'T1', actor: actor({ has: ['combatReady', 'moving'] }) }, { tokenId: 'T2', actor: actor({ has: ['combatReady'] }) }] },
  };
  await endStatusesInCombat(combat, 'combatEnd', registry);
  assert('end: the end of the combat clears everyone in it', combat.combatants.contents.every((c) => names(c.actor) === ''));
}

{
  const a = actor({ has: ['moving', 'cover', 'combatReady'] });
  assert('action: it takes «moving» off and leaves cover and readiness', (await handleCombatAction({ actor: a }, registry)) === 1 && names(a) === 'combatReady,cover', names(a));
  assert('action: no actor, nothing happens', (await handleCombatAction({}, registry)) === 0 && (await handleCombatAction(undefined, registry)) === 0);
}

// ---------------------------------------------------------------------------------------------
// A token update
// ---------------------------------------------------------------------------------------------

const token = (id, a) => ({ id, actor: a });
const combatWith = (...tokenIds) => ({ started: true, combatants: { contents: tokenIds.map((tokenId) => ({ tokenId })) } });

assert('combat: a token of the running combat', isTokenInCombat({ id: 'T1' }, combatWith('T1', 'T2')) === true);
assert('combat: another token, a combat that has not started, no combat',
  isTokenInCombat({ id: 'T3' }, combatWith('T1')) === false
  && isTokenInCombat({ id: 'T1' }, { ...combatWith('T1'), started: false }) === false
  && isTokenInCombat({ id: 'T1' }, null) === false);
{
  const a = actor({ has: ['cover'] });
  const events = await handleTokenUpdate(token('T1', a), { x: 100 }, {}, { combat: combatWith('T1'), registry });
  assert('move in combat: the actor leaves cover and is moving', events.join() === 'move' && names(a) === 'moving', names(a));
  await handleTokenUpdate(token('T1', a), { y: 200 }, {}, { combat: combatWith('T1'), registry });
  assert('move in combat: a second step does not hang «moving» twice', names(a) === 'moving');
}
{
  const a = actor({ has: ['hidden'] });
  await handleTokenUpdate(token('T1', a), { x: 100 }, {}, { combat: null, registry });
  assert('move out of combat: leaves cover but is not «moving»', names(a) === '');
}
{
  const a = actor({ has: ['cover'] });
  await handleTokenUpdate(token('T9', a), { x: 100 }, {}, { combat: combatWith('T1'), registry });
  assert('move of a token that is not in the combat: no «moving»', names(a) === '');
}
{
  const a = actor({ has: ['cover'] });
  await handleTokenUpdate(token('T1', a), { rotation: 90 }, {}, { combat: combatWith('T1'), registry });
  assert('turning in place: cover stays, nothing is hung', names(a) === 'cover' && a.log.length === 0);
}
{
  const a = actor();
  await handleTokenUpdate(token('T1', a), { x: 5 }, { isUndo: true }, { combat: combatWith('T1'), registry });
  assert('undoing a move does not make the actor «moving»', names(a) === '');
}
{
  const a = actor({ has: ['cover'] });
  const events = await handleTokenUpdate(token('T1', a), { name: 'Bob' }, {}, { combat: combatWith('T1'), registry });
  assert('an update that is neither a move nor a turn changes nothing', events.length === 0 && names(a) === 'cover');
  assert('a token without an actor is ignored', (await handleTokenUpdate({ id: 'T1', actor: null }, { x: 1 }, {}, { combat: null, registry })).join() === 'move');
}

if (failed) {
  console.log(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll status-lifecycle checks passed');

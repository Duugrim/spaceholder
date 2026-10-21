/**
 * Smoke tests for who writes the action journal. A journal message belongs to the user who posted it and the
 * round pointer is a flag on the anchor actor, so a player who is not the author (a reaction on somebody else's
 * turn, an undo on a GM-posted message) must hand the write to the GM. Runs in plain Node with stubbed Foundry
 * globals. Execute with:
 *   node module/helpers/actions/action-chat-journal.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

import { readFileSync } from 'node:fs';

const lang = JSON.parse(readFileSync(new URL('../../../lang/en.json', import.meta.url), 'utf8'));
const lookup = (key) => key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), lang);

let failed = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// Fake world
// ---------------------------------------------------------------------------------------------------

const ME = { id: 'userP', isGM: false };
const GM = { id: 'userGM', isGM: true };

/** @type {Array<{type: string, payload: any}>} */
let gmRequests = [];
let created = [];
let deleted = [];
let flagWrites = [];
let nextId = 1;

function makeActor(uuid, { owned }) {
  return {
    documentName: 'Actor',
    type: 'character',
    uuid,
    id: uuid.split('.').pop(),
    isOwner: owned,
    testUserPermission: () => owned,
    getFlag: () => undefined,
    setFlag: async (...args) => {
      flagWrites.push(args);
    },
  };
}

const actors = new Map();
const messages = new Map();

function makeMessage(id, authorId, lines, round = 1) {
  const msg = {
    id,
    author: { id: authorId },
    flags: { spaceholder: { actionJournal: { schema: 2, round, lines } } },
    content: '',
    toObject: () => ({ author: authorId, speaker: {}, flags: JSON.parse(JSON.stringify(msg.flags)), content: msg.content }),
    delete: async () => {
      deleted.push(id);
    },
  };
  messages.set(id, msg);
  return msg;
}

function setUser(user) {
  globalThis.game.user = user;
}

globalThis.foundry = {
  utils: {
    randomID: () => `id${nextId++}`,
    escapeHTML: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    duplicate: (o) => JSON.parse(JSON.stringify(o)),
  },
};
globalThis.CONST = { CHAT_MESSAGE_STYLES: { OTHER: 0 } };
globalThis.game = {
  user: ME,
  i18n: {
    localize: (key) => lookup(key) ?? key,
    format: (key, data) => {
      const template = lookup(key);
      if (typeof template !== 'string') return key;
      return template.replace(/\{(\w+)\}/g, (_, name) => String(data?.[name] ?? ''));
    },
  },
  messages: { get: (id) => messages.get(id) },
  combats: { get: () => null },
  spaceholder: {
    gmActions: {
      request: async (type, payload) => {
        gmRequests.push({ type, payload: JSON.parse(JSON.stringify(payload)) });
        return { status: 'done', id: 'req1', result: { messageId: 'msgFresh' } };
      },
    },
  },
};
globalThis.ChatMessage = {
  create: async (data) => {
    created.push(data);
    const id = `msgNew${created.length}`;
    return makeMessage(id, data.author, data.flags?.spaceholder?.actionJournal?.lines ?? []);
  },
  getSpeaker: () => ({}),
};
globalThis.fromUuid = async (uuid) => actors.get(uuid) ?? null;

const journal = await import('./action-chat-journal.mjs');

function reset() {
  gmRequests = [];
  created = [];
  deleted = [];
  flagWrites = [];
  messages.clear();
  actors.clear();
}

const line = (actorUuid) => ({
  id: 'line1', kind: 'action', label: 'Do', apCost: 5, undone: false, undoable: true, actorUuid, actorName: 'X',
});

// ---------------------------------------------------------------------------------------------------
// Undo / replace: who may re-post a journal message
// ---------------------------------------------------------------------------------------------------

{
  reset();
  setUser(ME);
  actors.set('Actor.anchor', makeActor('Actor.anchor', { owned: true }));
  const msg = makeMessage('m1', GM.id, [line('Actor.anchor')]);
  await journal.markJournalLineUndoneInMessage(msg, 'line1');
  assert('a player who did not post the message asks the GM to replace it', gmRequests.length === 1 && gmRequests[0].type === journal.JOURNAL_GM_ACTIONS.REPLACE_MESSAGE, gmRequests);
  assert('…and writes nothing itself (no create, no delete)', created.length === 0 && deleted.length === 0);
  assert('the request carries the new lines, not HTML', gmRequests[0].payload.journalFlags?.lines?.[0]?.undone === true && !('content' in gmRequests[0].payload), gmRequests[0]?.payload);
  assert('the request is plain JSON (it travels over the socket and sits in a user flag)', JSON.stringify(gmRequests[0].payload) === JSON.stringify(JSON.parse(JSON.stringify(gmRequests[0].payload))));
}
{
  reset();
  setUser(ME);
  actors.set('Actor.anchor', makeActor('Actor.anchor', { owned: true }));
  const msg = makeMessage('m2', ME.id, [line('Actor.anchor')]);
  await journal.markJournalLineUndoneInMessage(msg, 'line1');
  assert('the author who owns the anchor actor re-posts its own message', gmRequests.length === 0 && created.length === 1 && deleted.includes('m2'), { gmRequests, created: created.length, deleted });
  assert('the re-posted message keeps the author', created[0]?.author === ME.id);
}
{
  reset();
  setUser(ME);
  actors.set('Actor.other', makeActor('Actor.other', { owned: false }));
  const msg = makeMessage('m3', ME.id, [line('Actor.other')]);
  await journal.markJournalLineUndoneInMessage(msg, 'line1');
  assert('an author who does not own the anchor actor cannot move its round pointer: the GM does it', gmRequests.length === 1 && created.length === 0, { gmRequests: gmRequests.length, created: created.length });
}
{
  reset();
  setUser(GM);
  actors.set('Actor.anchor', makeActor('Actor.anchor', { owned: true }));
  const msg = makeMessage('m4', ME.id, [line('Actor.anchor')]);
  await journal.markJournalLineUndoneInMessage(msg, 'line1');
  assert('the GM re-posts any journal message', gmRequests.length === 0 && created.length === 1 && deleted.includes('m4'));
  assert('…keeping the original author, not the GM', created[0]?.author === ME.id, created[0]?.author);
}
{
  reset();
  const noGm = globalThis.game.spaceholder.gmActions;
  globalThis.game.spaceholder.gmActions = null;
  setUser(ME);
  actors.set('Actor.anchor', makeActor('Actor.anchor', { owned: true }));
  const msg = makeMessage('m5', GM.id, [line('Actor.anchor')]);
  let threw = false;
  try {
    await journal.markJournalLineUndoneInMessage(msg, 'line1');
  } catch (_) {
    threw = true;
  }
  assert('without GM actions the write is skipped quietly (journal is cosmetic)', !threw && created.length === 0);
  globalThis.game.spaceholder.gmActions = noGm;
}

// ---------------------------------------------------------------------------------------------------
// GM side
// ---------------------------------------------------------------------------------------------------

{
  reset();
  setUser(GM);
  actors.set('Actor.anchor', makeActor('Actor.anchor', { owned: true }));
  const msg = makeMessage('m6', ME.id, [line('Actor.anchor')]);
  const payloadLines = [{ ...line('Actor.anchor'), undone: true }];
  const res = await journal.applyJournalReplaceMessageAsGm({
    messageId: 'm6',
    journalFlags: { schema: 2, round: 3, lines: payloadLines },
    anchorActorUuid: 'Actor.anchor',
  });
  assert('GM handler re-posts the message with HTML it builds itself', created.length === 1 && String(created[0].content).includes('spaceholder-action-journal'), created[0]?.content);
  assert('…the new lines and round are the requested ones', created[0]?.flags?.spaceholder?.actionJournal?.round === 3 && created[0]?.flags?.spaceholder?.actionJournal?.lines?.[0]?.undone === true);
  assert('…and the result names the fresh message', typeof res.messageId === 'string' && res.messageId.startsWith('msgNew'), res);
  let missing = null;
  try {
    await journal.applyJournalReplaceMessageAsGm({ messageId: 'nope', journalFlags: { lines: [] } });
  } catch (e) {
    missing = e;
  }
  assert('GM handler refuses a message that is gone', !!missing);
  void msg;
}
{
  const uuids = journal.collectJournalActorUuids({
    lines: [
      { actorUuid: 'A' },
      { kind: 'moveGroup', segments: [{ actorUuid: 'B', reactions: [{ actorUuid: 'C' }] }, { actorUuid: 'B' }] },
      { actorUuid: 'A', reactions: [{ actorUuid: 'D' }] },
    ],
  });
  assert('actors a journal refers to: lines, segments and nested reactions, once each', JSON.stringify([...uuids].sort()) === JSON.stringify(['A', 'B', 'C', 'D']), uuids);
  assert('an empty or missing journal refers to nobody', journal.collectJournalActorUuids({}).length === 0 && journal.collectJournalActorUuids(null).length === 0);
}

// ---------------------------------------------------------------------------------------------------
// Append: a reaction on somebody else's turn
// ---------------------------------------------------------------------------------------------------

function fakeCombat(id = 'combat1') {
  const combatants = new Map();
  return {
    id,
    started: true,
    round: 1,
    combatants: { get: (cid) => combatants.get(cid) ?? null, set: (cid, c) => combatants.set(cid, c) },
  };
}

{
  reset();
  setUser(ME);
  const mine = makeActor('Actor.mine', { owned: true });
  const theirs = makeActor('Actor.theirs', { owned: false });
  const combat = fakeCombat();
  const myCombatant = { id: 'cMine', actor: mine };
  const theirCombatant = { id: 'cTheirs', actor: theirs };
  combat.combatants.set('cMine', myCombatant);
  combat.combatants.set('cTheirs', theirCombatant);
  await journal.appendCombatActionJournalLine({
    actor: mine,
    combat,
    combatant: myCombatant,
    anchorActor: theirs,
    anchorCombatant: theirCombatant,
    label: 'Step back',
    apCost: 4,
    kind: 'move',
    isReaction: true,
    actorName: 'Mine',
    transactionId: 'tx1',
    combatEventId: 'ev1',
    movementId: 'mv1',
    tokenUuid: 'Scene.s.Token.t',
  });
  assert('a reaction on somebody else\'s turn is handed to the GM instead of being dropped', gmRequests.length === 1 && gmRequests[0].type === journal.JOURNAL_GM_ACTIONS.APPEND_LINE, gmRequests);
  const p = gmRequests[0]?.payload ?? {};
  assert('…with documents as uuids / ids', p.actorUuid === 'Actor.mine' && p.anchorActorUuid === 'Actor.theirs' && p.combatId === 'combat1' && p.combatantId === 'cMine' && p.anchorCombatantId === 'cTheirs', p);
  assert('…and the line itself', p.label === 'Step back' && p.kind === 'move' && p.isReaction === true && p.apCost === 4 && p.transactionId === 'tx1' && p.movementId === 'mv1', p);
  assert('…the player writes no message of its own', created.length === 0 && deleted.length === 0);

  // GM side of the same request: documents resolve and the line is written (as the GM, who owns everything).
  setUser(GM);
  actors.set('Actor.mine', mine);
  actors.set('Actor.theirs', makeActor('Actor.theirs', { owned: true }));
  globalThis.game.combats = { get: (cid) => (cid === 'combat1' ? combat : null) };
  gmRequests = [];
  const ok = await journal.applyJournalAppendLineAsGm(p);
  const finalMsg = created[created.length - 1];
  const written = finalMsg?.flags?.spaceholder?.actionJournal?.lines ?? [];
  assert('GM handler writes the line: the anchor journal is created, then re-posted with the line', ok?.ok === true && created.length === 2, { ok, created: created.length });
  assert('…the journal is the anchor one (turn start line of the anchor, then the reaction)', written.some((l) => l.actorUuid === 'Actor.theirs' && l.kind === 'system') && JSON.stringify(written).includes('Step back'), written);
  assert('…and the GM does not hand it on again', gmRequests.length === 0);
  let broken = null;
  try {
    await journal.applyJournalAppendLineAsGm({ ...p, combatId: 'gone' });
  } catch (e) {
    broken = e;
  }
  assert('GM handler refuses a line whose combat is gone', !!broken);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll action-chat-journal tests passed');

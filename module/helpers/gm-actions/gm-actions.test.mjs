/**
 * Tests for the GM action manager: queue entry helpers and the request / queue state machine,
 * run against a fake world (several clients on one socket bus, user flags, chat messages).
 * Runs in plain Node (no Foundry globals required). Execute with:
 *   node module/helpers/gm-actions/gm-actions.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

import {
  GM_ACTION_STATUS,
  createQueueEntry,
  groupEntriesByCategory,
  makeEntryId,
  orderEntries,
  planDecision,
  sanitizeEntry,
  summarizeChatStatuses,
} from './gm-actions-core.mjs';
import { GmActionManager, GmActionNoAckError } from './gm-action-manager.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// Pure core
// ============================================================================
{
  const id = makeEntryId(1700000000000, 'user.1!', 3);
  assert('entry id has no dots and is sortable', !id.includes('.') && id.endsWith('-3'), id);

  const e = createQueueEntry({ type: 'damage.apply', payload: { a: 1 }, category: 'damage', label: 'L', requesterId: 'p1', requesterName: 'Pat', now: 5, seq: 1 });
  assert('createQueueEntry fills the shape', e.type === 'damage.apply' && e.category === 'damage' && e.requesterId === 'p1' && e.createdAt === 5 && e.chatMessageId === null, e);
  assert('createQueueEntry deep-copies the payload', (() => { const p = { a: { b: 1 } }; const x = createQueueEntry({ type: 't', payload: p, requesterId: 'p', now: 1, seq: 1 }); p.a.b = 2; return x.payload.a.b === 1; })());
  assert('createQueueEntry without a category → misc', createQueueEntry({ type: 't', payload: {}, requesterId: 'p', now: 1, seq: 1 }).category === 'misc');
  assert('createQueueEntry requires a type', (() => { try { createQueueEntry({ payload: {}, requesterId: 'p', now: 1, seq: 1 }); return false; } catch { return true; } })());
  assert('createQueueEntry rejects non-serializable payloads', (() => { const c = {}; c.self = c; try { createQueueEntry({ type: 't', payload: c, requesterId: 'p', now: 1, seq: 1 }); return false; } catch { return true; } })());

  assert('sanitizeEntry drops junk', sanitizeEntry(null) === null && sanitizeEntry({}) === null && sanitizeEntry({ id: 'x' }) === null);
  assert('sanitizeEntry keeps a valid entry', sanitizeEntry({ id: 'x', type: 't', payload: { a: 1 } })?.payload.a === 1);

  const mk = (id, category, createdAt) => ({ id, type: 't', category, label: '', payload: {}, requesterId: 'p', requesterName: '', chatMessageId: null, createdAt });
  const list = [mk('c', 'map', 30), mk('a', 'damage', 10), mk('b', 'damage', 20), mk('d', 'map', 5)];
  assert('orderEntries is chronological', orderEntries(list).map((x) => x.id).join('') === 'dabc');
  const groups = groupEntriesByCategory(list);
  assert('groups ordered by earliest entry, entries chronological',
    groups.map((g) => `${g.category}:${g.entries.map((x) => x.id).join('')}`).join(' ') === 'map:dc damage:ab', groups);
  const plan = planDecision(list, ['a', 'c']);
  assert('planDecision splits apply / cancel chronologically',
    plan.apply.map((x) => x.id).join('') === 'ac' && plan.cancel.map((x) => x.id).join('') === 'db', plan);
  assert('planDecision with null selection applies everything', planDecision(list, null).apply.length === 4 && planDecision(list, null).cancel.length === 0);
  const counts = summarizeChatStatuses({ a: 'pending', b: 'pending', c: 'cancelled', d: 'failed', e: 'weird' });
  assert('summarizeChatStatuses counts', counts.pending === 2 && counts.cancelled === 1 && counts.failed === 1, counts);
}

// ============================================================================
// Fake world
// ============================================================================
function createWorld({ users }) {
  const world = {
    users,                       // { id: { name, isGM } }
    activeGM: null,              // id or null
    queues: {},                  // userId → { entryId: entry }
    messages: {},                // messageId → { flags: { entryId: status }, content }
    clients: {},
    log: [],
    msgSeq: 0,
    failPut: false,
    failChatUpdate: false,
    delayTo: {},                 // recipient id → ms before a socket message reaches that client
  };
  for (const id of Object.keys(users)) world.queues[id] = {};

  world.addClient = (userId) => {
    const user = users[userId];
    const env = {
      userId,
      isGM: !!user.isGM,
      activeGMId: () => world.activeGM,
      getUser: (id) => (users[id] ? { id, name: users[id].name, isGM: !!users[id].isGM } : null),
      emit: (message) => {
        for (const [otherId, other] of Object.entries(world.clients)) {
          if (otherId === userId || !other.online) continue;
          setTimeout(() => { other.manager.handleMessage(JSON.parse(JSON.stringify(message))); }, world.delayTo[otherId] || 0);
        }
        return true;
      },
      listQueues: () => Object.entries(world.queues).map(([uid, map]) => ({ userId: uid, entries: Object.values(map) })),
      putQueueEntry: async (uid, entry) => {
        if (world.failPut) throw new Error('flag write refused');
        world.queues[uid][entry.id] = JSON.parse(JSON.stringify(entry));
      },
      removeQueueEntry: async (uid, entryId) => { delete world.queues[uid][entryId]; },
      setChatStatus: async (messageId, entryId, status) => {
        const msg = world.messages[messageId];
        if (!msg || world.failChatUpdate) return false;
        if (status == null) delete msg.flags[entryId]; else msg.flags[entryId] = status;
        return true;
      },
      createPendingChat: async (entry) => {
        const id = `msg${++world.msgSeq}`;
        world.messages[id] = { content: entry.label, flags: { [entry.id]: 'pending' } };
        return id;
      },
      now: (() => { let t = 1000; return () => (t += 10); })(),
    };
    const manager = new GmActionManager(env);
    const calls = [];
    manager.register('damage.apply', {
      category: 'damage',
      handler: async (payload, ctx) => { calls.push({ payload, requesterId: ctx.requesterId }); return { ok: true, echo: payload.n ?? null }; },
    });
    world.clients[userId] = { manager, env, calls, online: true };
    return world.clients[userId];
  };
  world.gmGoesOnline = (gmId) => { world.activeGM = gmId; world.clients[gmId].online = true; };
  world.gmGoesOffline = (gmId) => { world.activeGM = null; world.clients[gmId].online = false; };
  return world;
}

const users = { gm: { name: 'GM', isGM: true }, gm2: { name: 'GM2', isGM: true }, p1: { name: 'Pat', isGM: false }, p2: { name: 'Sam', isGM: false } };

// ---- 1. GM executes locally -------------------------------------------------
{
  const w = createWorld({ users }); const gm = w.addClient('gm'); w.addClient('p1');
  w.activeGM = 'gm';
  const r = await gm.manager.request('damage.apply', { n: 1 });
  assert('GM request runs locally and returns the result', r.status === 'done' && r.result.echo === 1 && gm.calls.length === 1, r);
  assert('GM request leaves no queue or chat marks', Object.keys(w.queues.gm).length === 0 && Object.keys(w.messages).length === 0);
}

// ---- 2. live: player → active GM ---------------------------------------------
{
  const w = createWorld({ users }); const gm = w.addClient('gm'); const p1 = w.addClient('p1');
  w.activeGM = 'gm';
  const r = await p1.manager.request('damage.apply', { n: 7 }, { label: 'hit', chatMessageId: 'whatever' });
  assert('live request is executed by the GM client and answered', r.status === 'done' && r.result.echo === 7 && gm.calls.length === 1 && p1.calls.length === 0, r);
  assert('the handler sees the requester id', gm.calls[0].requesterId === 'p1', gm.calls);
  assert('live request is not queued and not marked in chat', Object.keys(w.queues.p1).length === 0 && Object.keys(w.messages).length === 0);
}

// ---- 3. no GM online → queued + chat mark ------------------------------------
let queuedWorld;
{
  const w = createWorld({ users }); const gm = w.addClient('gm'); const p1 = w.addClient('p1');
  w.gmGoesOffline('gm');
  w.messages.diag1 = { content: 'shot', flags: {} };
  const r = await p1.manager.request('damage.apply', { n: 1 }, { label: 'Pat → Orc (torso)', chatMessageId: 'diag1' });
  assert('request without a GM is queued', r.status === 'queued' && Object.keys(w.queues.p1).length === 1 && gm.calls.length === 0 && p1.calls.length === 0, r);
  assert('the existing chat message is marked pending', w.messages.diag1.flags[r.id] === 'pending', w.messages.diag1);
  const stored = Object.values(w.queues.p1)[0];
  assert('the queued entry carries who / what / category', stored.requesterId === 'p1' && stored.requesterName === 'Pat' && stored.category === 'damage' && stored.label === 'Pat → Orc (torso)' && stored.chatMessageId === 'diag1', stored);
  queuedWorld = { w, gm, p1 };
}

// ---- 4. queued without a message → a dedicated one is created ----------------
{
  const w = createWorld({ users }); w.addClient('gm'); const p1 = w.addClient('p1'); w.gmGoesOffline('gm');
  const r = await p1.manager.request('damage.apply', { n: 1 }, { label: 'orphan' });
  const entry = Object.values(w.queues.p1)[0];
  assert('without a chat message a dedicated pending one is created', entry.chatMessageId && w.messages[entry.chatMessageId]?.flags[r.id] === 'pending', entry);
}
{
  const w = createWorld({ users }); w.addClient('gm'); const p1 = w.addClient('p1'); w.gmGoesOffline('gm');
  w.messages.locked = { content: 'x', flags: {} };
  w.failChatUpdate = true;
  const r = await p1.manager.request('damage.apply', { n: 1 }, { label: 'x', chatMessageId: 'locked' });
  const entry = Object.values(w.queues.p1)[0];
  assert('if the message cannot be updated a dedicated one is used instead', r.status === 'queued' && entry.chatMessageId !== 'locked' && w.messages[entry.chatMessageId]?.flags[r.id] === 'pending', entry);
}

// ---- 5. the GM logs in: apply everything -------------------------------------
{
  const { w, gm } = queuedWorld;
  w.gmGoesOnline('gm');
  const backlog = gm.manager.listQueue();
  assert('the GM sees the backlog', backlog.length === 1 && backlog[0].requesterName === 'Pat', backlog);
  const id = backlog[0].id;
  const res = await gm.manager.processQueue();
  assert('processQueue applied it', res.applied === 1 && res.cancelled === 0 && res.failed === 0 && gm.calls.length === 1 && gm.calls[0].payload.n === 1, res);
  assert('the entry left the queue and the chat mark is cleared', Object.keys(w.queues.p1).length === 0 && !(id in w.messages.diag1.flags), { q: w.queues.p1, f: w.messages.diag1.flags });
}

// ---- 6. selection: unselected are cancelled, order is chronological -----------
{
  const w = createWorld({ users }); const gm = w.addClient('gm'); const p1 = w.addClient('p1'); const p2 = w.addClient('p2');
  w.gmGoesOffline('gm');
  w.messages.m1 = { flags: {} }; w.messages.m2 = { flags: {} }; w.messages.m3 = { flags: {} };
  const a = await p1.manager.request('damage.apply', { n: 'first' }, { label: 'a', chatMessageId: 'm1' });
  const b = await p2.manager.request('damage.apply', { n: 'second' }, { label: 'b', chatMessageId: 'm2' });
  const c = await p1.manager.request('damage.apply', { n: 'third' }, { label: 'c', chatMessageId: 'm3' });
  w.gmGoesOnline('gm');
  const res = await gm.manager.processQueue({ selectedIds: [c.id, a.id] });
  assert('selected are applied, the rest cancelled', res.applied === 2 && res.cancelled === 1 && res.failed === 0, res);
  assert('applied in creation order across players', gm.calls.map((x) => x.payload.n).join(',') === 'first,third', gm.calls);
  assert('the cancelled action is marked cancelled in chat and its handler never ran',
    w.messages.m2.flags[b.id] === GM_ACTION_STATUS.CANCELLED && !gm.calls.some((x) => x.payload.n === 'second'), w.messages.m2);
  assert('applied ones clear their marks, queues are empty', !(a.id in w.messages.m1.flags) && !(c.id in w.messages.m3.flags) && Object.keys(w.queues.p1).length + Object.keys(w.queues.p2).length === 0);
}

// ---- 7. failures: marked failed, at-most-once ---------------------------------
{
  const w = createWorld({ users }); const gm = w.addClient('gm'); const p1 = w.addClient('p1'); w.gmGoesOffline('gm');
  gm.manager.register('boom', { category: 'misc', handler: async () => { throw new Error('kaboom'); } });
  p1.manager.register('boom', { category: 'misc', handler: async () => {} });
  w.messages.m1 = { flags: {} };
  const r = await p1.manager.request('boom', {}, { label: 'x', chatMessageId: 'm1' });
  w.gmGoesOnline('gm');
  const quiet = console.error; console.error = () => {};
  const res = await gm.manager.processQueue();
  console.error = quiet;
  assert('a failing handler is reported as failed', res.failed === 1 && res.applied === 0, res);
  assert('failed entries are marked in chat and removed (no second run)', w.messages.m1.flags[r.id] === GM_ACTION_STATUS.FAILED && Object.keys(w.queues.p1).length === 0);
}

// ---- 8. validation ------------------------------------------------------------
{
  const w = createWorld({ users }); const gm = w.addClient('gm'); const p1 = w.addClient('p1');
  const rule = ({ requester }) => (requester?.id === 'p1' ? true : 'only Pat may do this');
  for (const c of [gm, p1, w.addClient('p2')]) c.manager.register('guarded', { category: 'misc', handler: async () => ({ done: true }), validate: rule });
  w.activeGM = 'gm';
  const ok = await p1.manager.request('guarded', {});
  assert('validate allows a legitimate live request', ok.status === 'done' && ok.result.done === true, ok);
  const p2 = w.clients.p2;
  let err = null;
  try { await p2.manager.request('guarded', {}); } catch (e) { err = e; }
  assert('validate rejects a live request with the reason', err && /only Pat/.test(err.message), err?.message);
  // queued path
  w.gmGoesOffline('gm');
  w.messages.m = { flags: {} };
  const q = await p2.manager.request('guarded', {}, { chatMessageId: 'm' });
  w.gmGoesOnline('gm');
  const quiet = console.error; console.error = () => {};
  const res = await gm.manager.processQueue();
  console.error = quiet;
  assert('a queued action that fails validation is marked failed', res.failed === 1 && w.messages.m.flags[q.id] === GM_ACTION_STATUS.FAILED, { res, f: w.messages.m.flags });
}

// ---- 9. GM "online" but silent → falls back to the queue ----------------------
{
  const w = createWorld({ users }); const gm = w.addClient('gm'); const p1 = w.addClient('p1');
  w.activeGM = 'gm'; gm.online = false;     // nobody answers
  w.messages.m = { flags: {} };
  const t0 = Date.now();
  const r = await p1.manager.request('damage.apply', { n: 1 }, { label: 'x', chatMessageId: 'm', ackTimeoutMs: 30 });
  assert('no acknowledgement within the timeout → queued', r.status === 'queued' && Date.now() - t0 < 1000 && Object.keys(w.queues.p1).length === 1 && w.messages.m.flags[r.id] === 'pending', r);
}

// ---- 10. acknowledged but no result → error, NOT queued ------------------------
{
  const w = createWorld({ users }); const gm = w.addClient('gm'); const p1 = w.addClient('p1');
  for (const c of [gm, p1]) c.manager.register('slow', { category: 'misc', handler: () => new Promise(() => {}) });
  w.activeGM = 'gm';
  let err = null;
  try { await p1.manager.request('slow', {}, { resultTimeoutMs: 40 }); } catch (e) { err = e; }
  assert('acknowledged action without a result times out as an error', err && !(err instanceof GmActionNoAckError) && /did not report/.test(err.message), err?.message);
  assert('…and is not queued (it may already have run)', Object.keys(w.queues.p1).length === 0);
}

// ---- 11. only the designated GM answers ----------------------------------------
{
  const w = createWorld({ users }); const gm = w.addClient('gm'); const gm2 = w.addClient('gm2'); const p1 = w.addClient('p1');
  w.activeGM = 'gm2';
  const r = await p1.manager.request('damage.apply', { n: 3 });
  assert('with two GMs only the designated one executes', r.status === 'done' && gm2.calls.length === 1 && gm.calls.length === 0, { gm: gm.calls.length, gm2: gm2.calls.length });
}

// ---- 12. a duplicate request is executed once ----------------------------------
{
  const w = createWorld({ users }); const gm = w.addClient('gm'); w.addClient('p1');
  w.activeGM = 'gm';
  const entry = createQueueEntry({ type: 'damage.apply', payload: { n: 1 }, requesterId: 'p1', now: 5, seq: 1 });
  const msg = { type: 'spaceholder.gmActions', op: 'request', userId: 'p1', entry };
  await Promise.all([gm.manager.handleMessage(msg), gm.manager.handleMessage(msg)]);
  assert('the same request id runs once', gm.calls.length === 1, gm.calls.length);
}

// ---- 13. unknown type, wrong addressee -------------------------------------------
{
  const w = createWorld({ users }); const p1 = w.addClient('p1');
  let err = null;
  try { await p1.manager.request('nope', {}); } catch (e) { err = e; }
  assert('an unregistered type throws', err && /unknown action type/.test(err.message), err?.message);
}
{
  const w = createWorld({ users }); const gm = w.addClient('gm');
  w.activeGM = 'gm';
  const msg = createQueueEntry({ type: 'damage.apply', payload: {}, requesterId: 'p1', now: 5, seq: 1 });
  gm.manager.env.emit = () => true;
  await gm.manager.handleMessage({ type: 'spaceholder.gmActions', op: 'response', userId: 'someone-else', requestId: msg.id, ok: true });
  assert('responses addressed to other users are ignored', true);
}

// ---- 14. queue write fails: the chat mark is rolled back ----------------------------
{
  const w = createWorld({ users }); w.addClient('gm'); const p1 = w.addClient('p1'); w.gmGoesOffline('gm');
  w.messages.m = { flags: {} };
  w.failPut = true;
  let err = null;
  try { await p1.manager.request('damage.apply', {}, { chatMessageId: 'm' }); } catch (e) { err = e; }
  assert('a failed queue write throws and leaves no pending mark', err && Object.keys(w.messages.m.flags).length === 0, { err: err?.message, flags: w.messages.m.flags });
}

// ---- 15. live processing skips the login backlog ----------------------------------------
{
  const w = createWorld({ users }); const gm = w.addClient('gm'); const p1 = w.addClient('p1'); w.gmGoesOffline('gm');
  const backlog = await p1.manager.request('damage.apply', { n: 'backlog' }, { label: 'old' });
  w.gmGoesOnline('gm');
  gm.manager.deferEntries(gm.manager.listQueue().map((e) => e.id));
  // an entry that shows up later while the GM is online (queued by a client that lost the GM for a moment)
  w.activeGM = null;
  const late = await p1.manager.request('damage.apply', { n: 'late' }, { label: 'new' });
  w.activeGM = 'gm';
  const res = await gm.manager.processLive();
  assert('processLive applies only entries that arrived after login', res.applied === 1 && gm.calls.map((c) => c.payload.n).join() === 'late', { res, calls: gm.calls });
  assert('the login backlog stays queued for the GM\'s decision', backlog.id in w.queues.p1 && !(late.id in w.queues.p1), Object.keys(w.queues.p1));
}

// ---- 17. a busy GM answers late: the action must run once, with no leftovers -------------------
// (the requester gives up waiting for the acknowledgement and queues the action; the GM then runs
// the delayed live request anyway)
{
  // 17a. the delayed request reaches the GM AFTER the requester already queued the action
  const w = createWorld({ users }); const gm = w.addClient('gm'); const p1 = w.addClient('p1');
  w.activeGM = 'gm'; w.delayTo.gm = 90;
  w.messages.m = { flags: {} };
  const r = await p1.manager.request('damage.apply', { n: 'late' }, { label: 'x', chatMessageId: 'm', ackTimeoutMs: 20 });
  assert('17a: the requester queued it after the missed acknowledgement', r.status === 'queued' && r.id in w.queues.p1 && w.messages.m.flags[r.id] === 'pending');
  await sleep(180);
  assert('17a: the GM ran the late live request exactly once', gm.calls.length === 1 && gm.calls[0].payload.n === 'late', gm.calls.length);
  assert('17a: its queued copy is gone and the "awaits GM" note is cleared', !(r.id in w.queues.p1) && !(r.id in w.messages.m.flags), { q: w.queues.p1, f: w.messages.m.flags });
}
{
  // 17b. the GM ran it BEFORE the queued copy existed (its acknowledgement was just slow to arrive)
  const w = createWorld({ users }); const gm = w.addClient('gm'); const p1 = w.addClient('p1');
  w.activeGM = 'gm'; w.delayTo.p1 = 120;          // GM → player messages are slow
  w.messages.m = { flags: {} };
  const r = await p1.manager.request('damage.apply', { n: 'early' }, { label: 'x', chatMessageId: 'm', ackTimeoutMs: 30 });
  assert('17b: the GM already ran it while the requester queued a copy', r.status === 'queued' && gm.calls.length === 1 && r.id in w.queues.p1 && w.messages.m.flags[r.id] === 'pending');
  const res = await gm.manager.processLive();     // what the updateUser hook triggers
  assert('17b: processLive only cleans the copy up (no second run)', gm.calls.length === 1 && res.applied === 1 && res.failed === 0, { calls: gm.calls.length, res });
  assert('17b: queue empty and note cleared', !(r.id in w.queues.p1) && !(r.id in w.messages.m.flags));
}
{
  // 17c. the GM would "apply" the leftover copy from the login window: still no second run
  const w = createWorld({ users }); const gm = w.addClient('gm'); const p1 = w.addClient('p1');
  w.activeGM = 'gm'; w.delayTo.p1 = 120;
  w.messages.m = { flags: {} };
  const r = await p1.manager.request('damage.apply', { n: 'once' }, { label: 'x', chatMessageId: 'm', ackTimeoutMs: 30 });
  const res = await gm.manager.processQueue({ selectedIds: [r.id] });
  assert('17c: applying an already-run entry does not run it again', gm.calls.length === 1 && res.applied === 1, { calls: gm.calls.length, res });
  assert('17c: …and it is cleaned up', !(r.id in w.queues.p1) && !(r.id in w.messages.m.flags));
}
{
  // 17d. cancelling an entry that already ran live cannot undo it: it is cleaned up, not marked cancelled
  const w = createWorld({ users }); const gm = w.addClient('gm'); const p1 = w.addClient('p1');
  w.activeGM = 'gm'; w.delayTo.p1 = 120;
  w.messages.m = { flags: {} };
  const r = await p1.manager.request('damage.apply', { n: 'ran' }, { label: 'x', chatMessageId: 'm', ackTimeoutMs: 30 });
  const res = await gm.manager.processQueue({ selectedIds: [] });
  assert('17d: an already-run entry is not reported as cancelled', res.cancelled === 0 && res.applied === 1 && gm.calls.length === 1, res);
  assert('17d: and no "cancelled" note is left', !(r.id in w.queues.p1) && w.messages.m.flags[r.id] === undefined, w.messages.m.flags);
}
{
  // 17e. the late live run fails: the leftover copy ends as "failed", not silently cleared
  const w = createWorld({ users }); const gm = w.addClient('gm'); const p1 = w.addClient('p1');
  for (const c of [gm, p1]) c.manager.register('boom', { category: 'misc', handler: async () => { throw new Error('kaboom'); } });
  w.activeGM = 'gm'; w.delayTo.gm = 90;
  w.messages.m = { flags: {} };
  const r = await p1.manager.request('boom', {}, { label: 'x', chatMessageId: 'm', ackTimeoutMs: 20 });
  await sleep(180);
  assert('17e: a failed late run marks the leftover as failed and removes it', !(r.id in w.queues.p1) && w.messages.m.flags[r.id] === GM_ACTION_STATUS.FAILED, { q: w.queues.p1, f: w.messages.m.flags });
}

// ---- 16. non-GMs cannot process the queue -----------------------------------------------
{
  const w = createWorld({ users }); const p1 = w.addClient('p1');
  let err = null;
  try { await p1.manager.processQueue(); } catch (e) { err = e; }
  assert('processQueue is GM-only', err && /only a GM/.test(err.message), err?.message);
}

if (failed) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll gm-actions tests passed');

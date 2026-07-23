/**
 * Chat cards + socket sync for the hacking minigame (invite / run / observe / co-op).
 */

import { generateHackSession, replayHackSession } from './hack-generator.mjs';
import { openHackMinigameApp, getHackMinigameApp } from './hack-minigame-app.mjs';

const MODULE_NS = 'spaceholder';
const FLAG_INVITE = 'hackInvite';
const FLAG_RUN = 'hackRun';
const SCHEMA = 1;
const SOCKET_TYPE = 'spaceholder.hack';
const SOCKET_OP_REQUEST = 'request';
const SOCKET_OP_RESPONSE = 'response';

const ACTION_SET_RUN = 'setRun';
const ACTION_JOIN = 'join';

let _hooksInstalled = false;
let _socketInstalled = false;
let _seq = 0;
/** @type {Map<string, { resolve: Function, reject: Function, timeoutId: any }>} */
const _pending = new Map();

function L(key, fallback = key) {
  const out = game?.i18n?.localize?.(key);
  return out && out !== key ? out : fallback;
}

function Lf(key, data, fallback = key) {
  const out = game?.i18n?.format?.(key, data);
  if (out && out !== key) return out;
  return String(fallback).replace(/\{(\w+)\}/g, (_, name) => String(data?.[name] ?? ''));
}

function _esc(s) {
  return foundry.utils.escapeHTML(String(s ?? ''));
}

function _randomId() {
  try {
    return foundry.utils.randomID();
  } catch (_) {
    return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

function _socketName() {
  try {
    return `system.${game.system.id}`;
  } catch (_) {
    return `system.${MODULE_NS}`;
  }
}

function _dup(obj) {
  try {
    return foundry.utils.duplicate(obj);
  } catch (_) {
    return typeof structuredClone === 'function'
      ? structuredClone(obj)
      : JSON.parse(JSON.stringify(obj));
  }
}

/**
 * @param {object} raw
 * @returns {object|null}
 */
export function normalizeHackParams(raw = {}) {
  const seed = String(raw.seed ?? '').trim();
  if (!seed) return null;
  const rows = Math.max(3, Math.min(16, Math.floor(Number(raw.rows) || 10)));
  const cols = Math.max(3, Math.min(20, Math.floor(Number(raw.cols) || 14)));
  const actionLimit = Math.max(1, Math.min(999, Math.floor(Number(raw.actionLimit) || 40)));
  return {
    seed,
    rows,
    cols,
    actionLimit,
    antivirus: raw.antivirus !== false && raw.antivirus !== 0,
    bonuses: raw.bonuses !== false && raw.bonuses !== 0,
    visionMode: String(raw.visionMode || 'available'),
  };
}

/**
 * @param {import('./hack-moves.mjs').HackMove} move
 * @param {number} pathIndex
 */
export function serializeHackMove(move, pathIndex = 0) {
  return {
    fromR: move?.fromR ?? null,
    fromC: move?.fromC ?? null,
    toR: move?.toR ?? null,
    toC: move?.toC ?? null,
    toWin: !!move?.toWin,
    isStart: !!move?.isStart,
    pathIndex: Math.max(0, Math.floor(Number(pathIndex) || 0)),
  };
}

/**
 * Resolve speaker: controlled token → user character → user alias.
 */
export function resolveHackSpeaker() {
  const controlled = canvas?.tokens?.controlled || [];
  for (let i = controlled.length - 1; i >= 0; i -= 1) {
    const token = controlled[i];
    if (!token?.actor) continue;
    if (game.user?.isGM || token.actor.testUserPermission?.(game.user, 'OWNER')) {
      try {
        return ChatMessage.getSpeaker({ token: token.document ?? token });
      } catch (_) {
        return ChatMessage.getSpeaker({ actor: token.actor });
      }
    }
  }

  const character = game.user?.character;
  if (character) {
    const tokens = character.getActiveTokens?.(true, true) || [];
    const token = tokens[0];
    if (token) {
      try {
        return ChatMessage.getSpeaker({ token: token.document ?? token });
      } catch (_) {
        /* fall through */
      }
    }
    return ChatMessage.getSpeaker({ actor: character });
  }

  return ChatMessage.getSpeaker({ alias: game.user?.name || 'Hack' });
}

/**
 * @param {ChatMessage} message
 * @returns {object|null}
 */
export function getHackInvite(message) {
  const raw = message?.flags?.[MODULE_NS]?.[FLAG_INVITE];
  if (!raw || typeof raw !== 'object') return null;
  const params = normalizeHackParams(raw);
  if (!params) return null;
  return {
    schema: Number(raw.schema) || SCHEMA,
    inviteId: String(raw.inviteId || ''),
    ...params,
  };
}

/**
 * @param {ChatMessage} message
 * @returns {object|null}
 */
export function getHackRun(message) {
  const raw = message?.flags?.[MODULE_NS]?.[FLAG_RUN];
  if (!raw || typeof raw !== 'object') return null;
  const params = normalizeHackParams(raw.params || raw);
  if (!params) return null;
  return {
    schema: Number(raw.schema) || SCHEMA,
    runId: String(raw.runId || ''),
    inviteId: String(raw.inviteId || ''),
    ownerUserId: String(raw.ownerUserId || ''),
    participantIds: Array.isArray(raw.participantIds)
      ? raw.participantIds.map((id) => String(id))
      : [],
    status: ['active', 'won', 'failed'].includes(raw.status) ? raw.status : 'active',
    revision: Math.max(0, Math.floor(Number(raw.revision) || 0)),
    moves: Array.isArray(raw.moves) ? raw.moves.map((m) => serializeHackMove(m, m?.pathIndex)) : [],
    params,
    stats: {
      actionUsed: Math.max(0, Math.floor(Number(raw.stats?.actionUsed) || 0)),
      actionLimit: Math.max(0, Math.floor(Number(raw.stats?.actionLimit) || params.actionLimit)),
      antivirusTriggered: !!raw.stats?.antivirusTriggered,
    },
  };
}

function _buildInviteHtml(invite) {
  const title = L('SPACEHOLDER.HackMinigame.Chat.InviteTitle', 'Minigame created:');
  const label = L('SPACEHOLDER.HackMinigame.Chat.HackLabel', 'Hack');
  const btn = L('SPACEHOLDER.HackMinigame.Chat.HackButton', 'Hack');
  return `<div class="spaceholder-hack-chat" data-spaceholder-hack-chat="1" data-hack-kind="invite">
  <div class="spaceholder-hack-chat__row">
    <span class="spaceholder-hack-chat__text">${_esc(title)}</span>
    <span class="spaceholder-hack-chat__label">
      <i class="fa-solid fa-laptop-code" aria-hidden="true"></i>
      ${_esc(label)}
    </span>
  </div>
  <div class="spaceholder-hack-chat__actions">
    <button type="button" class="spaceholder-hack-chat__btn" data-action="sh-hack-start" data-invite-id="${_esc(invite.inviteId)}">
      <i class="fa-solid fa-terminal" aria-hidden="true"></i>
      <span>${_esc(btn)}</span>
    </button>
  </div>
</div>`;
}

function _buildRunHtml(run) {
  const started = L('SPACEHOLDER.HackMinigame.Chat.Started', 'Started hack');
  const observe = L('SPACEHOLDER.HackMinigame.Chat.ObserveButton', 'Observe');
  const won = L('SPACEHOLDER.HackMinigame.Chat.ResultWon', 'Hack succeeded');
  const failed = L('SPACEHOLDER.HackMinigame.Chat.ResultFailed', 'Hack failed');
  const actions = Lf(
    'SPACEHOLDER.HackMinigame.Chat.ActionsStat',
    { used: run.stats.actionUsed, limit: run.stats.actionLimit },
    'Actions: {used} / {limit}'
  );
  const av = run.stats.antivirusTriggered
    ? L('SPACEHOLDER.HackMinigame.Chat.AntivirusYes', 'Antivirus activated')
    : L('SPACEHOLDER.HackMinigame.Chat.AntivirusNo', 'Antivirus not activated');

  let body = `<div class="spaceholder-hack-chat__row">
    <span class="spaceholder-hack-chat__text">${_esc(started)}</span>
  </div>`;

  if (run.status === 'won') {
    body = `<div class="spaceholder-hack-chat__row">
      <span class="spaceholder-hack-chat__text is-won"><i class="fa-solid fa-flag-checkered" aria-hidden="true"></i> ${_esc(won)}</span>
    </div>
    <div class="spaceholder-hack-chat__stats">${_esc(actions)} · ${_esc(av)}</div>`;
  } else if (run.status === 'failed') {
    body = `<div class="spaceholder-hack-chat__row">
      <span class="spaceholder-hack-chat__text is-failed"><i class="fa-solid fa-xmark" aria-hidden="true"></i> ${_esc(failed)}</span>
    </div>
    <div class="spaceholder-hack-chat__stats">${_esc(actions)} · ${_esc(av)}</div>`;
  } else {
    body += `<div class="spaceholder-hack-chat__actions">
      <button type="button" class="spaceholder-hack-chat__btn" data-action="sh-hack-observe" data-run-id="${_esc(run.runId)}">
        <i class="fa-solid fa-eye" aria-hidden="true"></i>
        <span>${_esc(observe)}</span>
      </button>
    </div>`;
  }

  return `<div class="spaceholder-hack-chat" data-spaceholder-hack-chat="1" data-hack-kind="run" data-run-id="${_esc(run.runId)}">
  ${body}
</div>`;
}

/**
 * Post invite card from generate-dialog params.
 * @param {object} params
 */
export async function postHackInviteToChat(params) {
  const normalized = normalizeHackParams(params);
  if (!normalized) {
    ui.notifications?.warn?.(L('SPACEHOLDER.HackMinigame.Messages.NoSession', 'No hack session.'));
    return null;
  }
  const inviteId = _randomId();
  const invite = { schema: SCHEMA, inviteId, ...normalized };
  const content = _buildInviteHtml(invite);
  return ChatMessage.create({
    speaker: resolveHackSpeaker(),
    content,
    flags: {
      [MODULE_NS]: {
        [FLAG_INVITE]: invite,
      },
    },
  });
}

/**
 * @param {ChatMessage} inviteMessage
 */
export async function startHackRunFromInvite(inviteMessage) {
  const invite = getHackInvite(inviteMessage);
  if (!invite) {
    ui.notifications?.warn?.(L('SPACEHOLDER.HackMinigame.Messages.NoSession', 'No hack session.'));
    return null;
  }

  const params = normalizeHackParams(invite);
  const runId = _randomId();
  const ownerUserId = String(game.user?.id || '');
  const run = {
    schema: SCHEMA,
    runId,
    inviteId: invite.inviteId,
    ownerUserId,
    participantIds: [ownerUserId],
    status: 'active',
    revision: 0,
    moves: [],
    params,
    stats: {
      actionUsed: 0,
      actionLimit: params.actionLimit,
      antivirusTriggered: false,
    },
  };

  const message = await ChatMessage.create({
    speaker: resolveHackSpeaker(),
    content: _buildRunHtml(run),
    flags: {
      [MODULE_NS]: {
        [FLAG_RUN]: run,
      },
    },
  });

  const { session, stats } = replayHackSession(params, []);
  openHackMinigameApp(session, {
    mode: 'play',
    runMessageId: message.id,
    runId,
    participate: true,
    antivirusTriggered: stats.antivirusTriggered,
    remoteRevision: 0,
    moveLog: [],
  });
  return message;
}

/**
 * @param {ChatMessage} runMessage
 * @param {{ participate?: boolean }} [opts]
 */
export function openHackRunObserver(runMessage, opts = {}) {
  const run = getHackRun(runMessage);
  if (!run) {
    ui.notifications?.warn?.(L('SPACEHOLDER.HackMinigame.Messages.NoSession', 'No hack session.'));
    return null;
  }
  const { session, stats } = replayHackSession(run.params, run.moves);
  const isOwner = String(game.user?.id || '') === run.ownerUserId;
  const participate = isOwner ? true : !!opts.participate;
  return openHackMinigameApp(session, {
    mode: isOwner ? 'play' : 'observe',
    runMessageId: runMessage.id,
    runId: run.runId,
    participate,
    antivirusTriggered: stats.antivirusTriggered,
    remoteRevision: run.revision,
    moveLog: run.moves,
  });
}

/**
 * @param {ChatMessage} message
 * @returns {boolean}
 */
function _canWriteRunMessage(message) {
  const run = getHackRun(message);
  if (!run) return false;
  if (game.user?.isGM) return true;
  if (String(game.user?.id || '') === run.ownerUserId) return true;
  // Message author can usually update their own chat message
  const authorId = typeof message.author === 'string' ? message.author : message.author?.id;
  return String(authorId || '') === String(game.user?.id || '');
}

/**
 * @param {string} ownerUserId
 */
function _ownerIsActive(ownerUserId) {
  const user = game.users?.get?.(ownerUserId);
  return !!user?.active;
}

/**
 * Whether this client should apply a socket write for the run.
 * @param {object} run
 */
function _shouldHandleSocketWrite(run) {
  const me = String(game.user?.id || '');
  if (me && me === run.ownerUserId) return true;
  if (game.user?.isGM && !_ownerIsActive(run.ownerUserId)) return true;
  return false;
}

/**
 * Apply a full run snapshot onto the ChatMessage (local write).
 * @param {ChatMessage} message
 * @param {object} nextRun
 * @param {{ refreshContent?: boolean }} [opts]
 */
export async function writeHackRunLocal(message, nextRun, opts = {}) {
  if (!message?.id || !nextRun) return null;
  const update = {
    [`flags.${MODULE_NS}.${FLAG_RUN}`]: nextRun,
  };
  if (opts.refreshContent !== false) {
    update.content = _buildRunHtml(nextRun);
  }
  await message.update(update);
  return message;
}

/**
 * Build next run state from current + patch.
 * @param {object} run
 * @param {object} patch
 */
export function mergeHackRun(run, patch = {}) {
  const moves = Array.isArray(patch.moves) ? patch.moves.map((m) => serializeHackMove(m, m?.pathIndex)) : run.moves;
  const status = patch.status || run.status;
  const stats = {
    actionUsed: patch.stats?.actionUsed ?? run.stats.actionUsed,
    actionLimit: patch.stats?.actionLimit ?? run.stats.actionLimit,
    antivirusTriggered: !!(patch.stats?.antivirusTriggered ?? run.stats.antivirusTriggered),
  };
  const participantIds = Array.isArray(patch.participantIds)
    ? [...new Set(patch.participantIds.map((id) => String(id)))]
    : run.participantIds;
  const nextRevision = patch.forceRevision != null
    ? Math.max(0, Math.floor(Number(patch.forceRevision)))
    : run.revision + 1;

  return {
    ...run,
    moves,
    status,
    stats,
    participantIds,
    revision: nextRevision,
  };
}

/**
 * Push run state: local write if allowed, else socket to owner/GM.
 * @param {string} messageId
 * @param {object} patch
 * @param {{ expectedRevision?: number, refreshContent?: boolean }} [opts]
 */
export async function pushHackRunState(messageId, patch, opts = {}) {
  const message = game.messages?.get?.(messageId);
  if (!message) throw new Error('hack run message missing');
  const run = getHackRun(message);
  if (!run) throw new Error('hack run flag missing');

  if (opts.expectedRevision != null && run.revision !== opts.expectedRevision) {
    throw new Error('stale revision');
  }

  const next = mergeHackRun(run, patch);

  if (_canWriteRunMessage(message)) {
    await writeHackRunLocal(message, next, { refreshContent: opts.refreshContent ?? next.status !== 'active' });
    return next;
  }

  return requestHackSocket(ACTION_SET_RUN, {
    messageId,
    expectedRevision: run.revision,
    run: next,
    refreshContent: opts.refreshContent ?? next.status !== 'active',
  });
}

/**
 * @param {string} messageId
 * @param {string} userId
 */
export async function joinHackRun(messageId, userId) {
  const message = game.messages?.get?.(messageId);
  if (!message) throw new Error('hack run message missing');
  const run = getHackRun(message);
  if (!run) throw new Error('hack run flag missing');
  if (run.participantIds.includes(userId)) return run;

  // Keep revision unchanged — join is metadata only, must not reset boards.
  const next = {
    ...run,
    participantIds: [...new Set([...run.participantIds, String(userId)])],
  };

  if (_canWriteRunMessage(message)) {
    await writeHackRunLocal(message, next, { refreshContent: false });
    return next;
  }

  return requestHackSocket(ACTION_JOIN, { messageId, userId });
}

function _emit(message) {
  try {
    game.socket.emit(_socketName(), message);
    return true;
  } catch (error) {
    console.error('SpaceHolder | hack socket emit failed', error);
    return false;
  }
}

function _nextRequestId() {
  _seq += 1;
  return `${Date.now()}-${game.user?.id || 'user'}-${_seq}`;
}

function _reply(msg, ok, payload = null, error = '') {
  const userId = String(msg?.userId || '').trim();
  const requestId = String(msg?.requestId || '').trim();
  if (!userId || !requestId) return;
  _emit({
    type: SOCKET_TYPE,
    op: SOCKET_OP_RESPONSE,
    requestId,
    userId,
    ok: !!ok,
    payload,
    error: String(error || ''),
  });
}

/**
 * @param {string} action
 * @param {object} payload
 * @param {{ timeoutMs?: number }} [opts]
 */
export function requestHackSocket(action, payload = {}, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const requestId = _nextRequestId();
    const timeoutId = setTimeout(() => {
      _pending.delete(requestId);
      reject(new Error('hack socket timeout'));
    }, timeoutMs);
    _pending.set(requestId, { resolve, reject, timeoutId });
    const ok = _emit({
      type: SOCKET_TYPE,
      op: SOCKET_OP_REQUEST,
      action,
      requestId,
      userId: String(game.user?.id || ''),
      payload,
    });
    if (!ok) {
      clearTimeout(timeoutId);
      _pending.delete(requestId);
      reject(new Error('hack socket emit failed'));
    }
  });
}

async function _handleSocketRequest(msg) {
  const action = String(msg?.action || '').trim();
  const payload = msg?.payload || {};
  const message = game.messages?.get?.(payload.messageId);
  if (!message) {
    _reply(msg, false, null, 'message missing');
    return;
  }
  const run = getHackRun(message);
  if (!run) {
    _reply(msg, false, null, 'run missing');
    return;
  }
  if (!_shouldHandleSocketWrite(run)) return;

  try {
    if (action === ACTION_SET_RUN) {
      if (payload.expectedRevision != null && run.revision !== payload.expectedRevision) {
        _reply(msg, false, null, 'stale revision');
        return;
      }
      const next = payload.run || mergeHackRun(run, payload);
      // Keep monotonic revision relative to current
      next.revision = Math.max(run.revision + 1, Number(next.revision) || 0);
      await writeHackRunLocal(message, next, { refreshContent: !!payload.refreshContent || next.status !== 'active' });
      _reply(msg, true, next);
      return;
    }
    if (action === ACTION_JOIN) {
      const userId = String(payload.userId || msg.userId || '');
      if (!userId) {
        _reply(msg, false, null, 'missing user');
        return;
      }
      if (run.participantIds.includes(userId)) {
        _reply(msg, true, run);
        return;
      }
      const next = {
        ...run,
        participantIds: [...new Set([...run.participantIds, userId])],
      };
      await writeHackRunLocal(message, next, { refreshContent: false });
      _reply(msg, true, next);
      return;
    }
    _reply(msg, false, null, `unknown action: ${action}`);
  } catch (error) {
    console.error('SpaceHolder | hack socket action failed', error);
    _reply(msg, false, null, error?.message || String(error));
  }
}

function _handleSocketResponse(msg) {
  const requestId = String(msg?.requestId || '').trim();
  const userId = String(msg?.userId || '').trim();
  if (!requestId || userId !== String(game.user?.id || '')) return;
  const pending = _pending.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  _pending.delete(requestId);
  if (msg?.ok) pending.resolve(msg.payload);
  else pending.reject(new Error(String(msg?.error || 'hack socket failed')));
}

export function installHackSocket() {
  if (_socketInstalled) return;
  _socketInstalled = true;
  if (!game?.socket?.on) {
    console.warn('SpaceHolder | hack: game.socket unavailable');
    return;
  }
  game.socket.on(_socketName(), async (msg) => {
    try {
      if (!msg || msg.type !== SOCKET_TYPE) return;
      if (msg.op === SOCKET_OP_RESPONSE) {
        _handleSocketResponse(msg);
        return;
      }
      if (msg.op === SOCKET_OP_REQUEST) {
        await _handleSocketRequest(msg);
      }
    } catch (error) {
      console.error('SpaceHolder | hack socket crashed', error);
    }
  });
}

function _getChatMessageForControl(el) {
  const root = el?.closest?.('.chat-message[data-message-id]');
  const id = root?.dataset?.messageId || el?.closest?.('[data-message-id]')?.dataset?.messageId;
  return id ? game.messages?.get?.(id) : null;
}

async function _onHackStartClick(btn) {
  const message = _getChatMessageForControl(btn);
  if (!message) return;
  await startHackRunFromInvite(message);
}

async function _onHackObserveClick(btn) {
  const message = _getChatMessageForControl(btn);
  if (!message) return;
  openHackRunObserver(message);
}

function _installDelegatedClicks() {
  if (typeof document === 'undefined') return;
  document.addEventListener(
    'click',
    (ev) => {
      const t = ev.target;
      if (!t?.closest) return;
      const start = t.closest('[data-action="sh-hack-start"]');
      if (start?.closest?.('[data-spaceholder-hack-chat="1"]')) {
        ev.preventDefault();
        ev.stopPropagation();
        void _onHackStartClick(start);
        return;
      }
      const observe = t.closest('[data-action="sh-hack-observe"]');
      if (observe?.closest?.('[data-spaceholder-hack-chat="1"]')) {
        ev.preventDefault();
        ev.stopPropagation();
        void _onHackObserveClick(observe);
      }
    },
    true
  );
}

/**
 * Sync open app when a run message updates.
 * @param {ChatMessage} message
 */
function _syncOpenAppFromMessage(message) {
  const run = getHackRun(message);
  if (!run) return;
  const app = getHackMinigameApp?.();
  if (!app || app._runId !== run.runId) return;
  app.applyRemoteRun?.(run, message.id);
}

export function installHackChatHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;
  _installDelegatedClicks();
  installHackSocket();

  Hooks.on('updateChatMessage', (message) => {
    try {
      if (message?.flags?.[MODULE_NS]?.[FLAG_RUN]) _syncOpenAppFromMessage(message);
    } catch (error) {
      console.error('SpaceHolder | hack chat update hook failed', error);
    }
  });

  Hooks.on('deleteChatMessage', (message) => {
    try {
      const run = getHackRun(message);
      if (!run) return;
      const app = getHackMinigameApp?.();
      if (app && app._runId === run.runId) {
        app._runMessageId = null;
        app._runId = null;
      }
    } catch (_) {
      /* ignore */
    }
  });
}

// Avoid circular init issues: re-export generate for dialog convenience
export { generateHackSession, replayHackSession };

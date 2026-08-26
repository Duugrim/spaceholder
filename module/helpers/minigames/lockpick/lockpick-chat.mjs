/**
 * Chat cards + socket sync for the lockpick minigame (invite / run / observe).
 */

import {
  generateLockpickSession,
  normalizeLockpickParams,
  replayLockpickSession,
  serializeLockpickAction,
} from './lockpick-generator.mjs';
import { openLockpickMinigameApp, getLockpickMinigameApp } from './lockpick-minigame-app.mjs';

const MODULE_NS = 'spaceholder';
const FLAG_INVITE = 'lockpickInvite';
const FLAG_RUN = 'lockpickRun';
const SCHEMA = 1;
const SOCKET_TYPE = 'spaceholder.lockpick';
const SOCKET_OP_REQUEST = 'request';
const SOCKET_OP_RESPONSE = 'response';
const ACTION_SET_RUN = 'setRun';

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

/**
 * Resolve speaker: controlled token → user character → user alias.
 */
export function resolveLockpickSpeaker() {
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
  return ChatMessage.getSpeaker({ alias: game.user?.name || 'Lockpick' });
}

/**
 * @param {ChatMessage} message
 */
export function getLockpickInvite(message) {
  const raw = message?.flags?.[MODULE_NS]?.[FLAG_INVITE];
  if (!raw || typeof raw !== 'object') return null;
  const params = normalizeLockpickParams(raw);
  if (!params) return null;
  return {
    schema: Number(raw.schema) || SCHEMA,
    inviteId: String(raw.inviteId || ''),
    ...params,
  };
}

/**
 * @param {ChatMessage} message
 */
export function getLockpickRun(message) {
  const raw = message?.flags?.[MODULE_NS]?.[FLAG_RUN];
  if (!raw || typeof raw !== 'object') return null;
  const params = normalizeLockpickParams(raw.params || raw);
  if (!params) return null;
  return {
    schema: Number(raw.schema) || SCHEMA,
    runId: String(raw.runId || ''),
    inviteId: String(raw.inviteId || ''),
    ownerUserId: String(raw.ownerUserId || ''),
    status: ['active', 'won', 'failed'].includes(raw.status) ? raw.status : 'active',
    revision: Math.max(0, Math.floor(Number(raw.revision) || 0)),
    actions: Array.isArray(raw.actions)
      ? raw.actions.map((a) => serializeLockpickAction(a))
      : [],
    params,
    stats: {
      checkCount: Math.max(0, Math.floor(Number(raw.stats?.checkCount) || 0)),
      pinsUnlocked: Math.max(0, Math.floor(Number(raw.stats?.pinsUnlocked) || 0)),
      pinCount: Math.max(0, Math.floor(Number(raw.stats?.pinCount) || params.pinCount)),
    },
  };
}

function _buildInviteHtml(invite) {
  const title = L('SPACEHOLDER.LockpickMinigame.Chat.InviteTitle', 'Minigame created:');
  const label = L('SPACEHOLDER.LockpickMinigame.Chat.LockpickLabel', 'Lockpick');
  const btn = L('SPACEHOLDER.LockpickMinigame.Chat.StartButton', 'Pick lock');
  return `<div class="spaceholder-lockpick-chat" data-spaceholder-lockpick-chat="1" data-lockpick-kind="invite">
  <div class="spaceholder-lockpick-chat__row">
    <span class="spaceholder-lockpick-chat__text">${_esc(title)}</span>
    <span class="spaceholder-lockpick-chat__label">
      <i class="fa-solid fa-key" aria-hidden="true"></i>
      ${_esc(label)}
    </span>
  </div>
  <div class="spaceholder-lockpick-chat__actions">
    <button type="button" class="spaceholder-lockpick-chat__btn" data-action="sh-lockpick-start" data-invite-id="${_esc(invite.inviteId)}">
      <i class="fa-solid fa-unlock" aria-hidden="true"></i>
      <span>${_esc(btn)}</span>
    </button>
  </div>
</div>`;
}

function _buildRunHtml(run) {
  const started = L('SPACEHOLDER.LockpickMinigame.Chat.Started', 'Started lockpick');
  const observe = L('SPACEHOLDER.LockpickMinigame.Chat.ObserveButton', 'Observe');
  const won = L('SPACEHOLDER.LockpickMinigame.Chat.ResultWon', 'Lock opened');
  const failed = L('SPACEHOLDER.LockpickMinigame.Chat.ResultFailed', 'Lockpick failed');
  const pins = Lf(
    'SPACEHOLDER.LockpickMinigame.Chat.PinsStat',
    { unlocked: run.stats.pinsUnlocked, total: run.stats.pinCount },
    'Pins: {unlocked} / {total}'
  );
  const checks = Lf(
    'SPACEHOLDER.LockpickMinigame.Chat.ChecksStat',
    { count: run.stats.checkCount },
    'Checks: {count}'
  );

  let body = `<div class="spaceholder-lockpick-chat__row">
    <span class="spaceholder-lockpick-chat__text">${_esc(started)}</span>
  </div>`;

  if (run.status === 'won') {
    body = `<div class="spaceholder-lockpick-chat__row">
      <span class="spaceholder-lockpick-chat__text is-won"><i class="fa-solid fa-flag-checkered" aria-hidden="true"></i> ${_esc(won)}</span>
    </div>
    <div class="spaceholder-lockpick-chat__stats">${_esc(pins)} · ${_esc(checks)}</div>`;
  } else if (run.status === 'failed') {
    body = `<div class="spaceholder-lockpick-chat__row">
      <span class="spaceholder-lockpick-chat__text is-failed"><i class="fa-solid fa-xmark" aria-hidden="true"></i> ${_esc(failed)}</span>
    </div>
    <div class="spaceholder-lockpick-chat__stats">${_esc(pins)} · ${_esc(checks)}</div>`;
  } else {
    body += `<div class="spaceholder-lockpick-chat__actions">
      <button type="button" class="spaceholder-lockpick-chat__btn" data-action="sh-lockpick-observe" data-run-id="${_esc(run.runId)}">
        <i class="fa-solid fa-eye" aria-hidden="true"></i>
        <span>${_esc(observe)}</span>
      </button>
    </div>`;
  }

  return `<div class="spaceholder-lockpick-chat" data-spaceholder-lockpick-chat="1" data-lockpick-kind="run" data-run-id="${_esc(run.runId)}">
  ${body}
</div>`;
}

/**
 * @param {object} params
 */
export async function postLockpickInviteToChat(params) {
  const normalized = normalizeLockpickParams(params);
  if (!normalized) {
    ui.notifications?.warn?.(L('SPACEHOLDER.LockpickMinigame.Messages.NoSession', 'No lockpick session.'));
    return null;
  }
  const inviteId = _randomId();
  const invite = { schema: SCHEMA, inviteId, ...normalized };
  return ChatMessage.create({
    speaker: resolveLockpickSpeaker(),
    content: _buildInviteHtml(invite),
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
export async function startLockpickRunFromInvite(inviteMessage) {
  const invite = getLockpickInvite(inviteMessage);
  if (!invite) {
    ui.notifications?.warn?.(L('SPACEHOLDER.LockpickMinigame.Messages.NoSession', 'No lockpick session.'));
    return null;
  }

  const params = normalizeLockpickParams(invite);
  const runId = _randomId();
  const ownerUserId = String(game.user?.id || '');
  const run = {
    schema: SCHEMA,
    runId,
    inviteId: invite.inviteId,
    ownerUserId,
    status: 'active',
    revision: 0,
    actions: [],
    params,
    stats: {
      checkCount: 0,
      pinsUnlocked: 0,
      pinCount: params.pinCount,
    },
  };

  const message = await ChatMessage.create({
    speaker: resolveLockpickSpeaker(),
    content: _buildRunHtml(run),
    flags: {
      [MODULE_NS]: {
        [FLAG_RUN]: run,
      },
    },
  });

  const { session } = replayLockpickSession(params, []);
  openLockpickMinigameApp(session, {
    mode: 'play',
    runMessageId: message.id,
    runId,
    remoteRevision: 0,
    actionLog: [],
  });
  return message;
}

/**
 * @param {ChatMessage} runMessage
 */
export function openLockpickRunObserver(runMessage) {
  const run = getLockpickRun(runMessage);
  if (!run) {
    ui.notifications?.warn?.(L('SPACEHOLDER.LockpickMinigame.Messages.NoSession', 'No lockpick session.'));
    return null;
  }
  const { session } = replayLockpickSession(run.params, run.actions);
  const isOwner = String(game.user?.id || '') === run.ownerUserId;
  return openLockpickMinigameApp(session, {
    mode: isOwner ? 'play' : 'observe',
    runMessageId: runMessage.id,
    runId: run.runId,
    remoteRevision: run.revision,
    actionLog: run.actions,
  });
}

function _canWriteRunMessage(message) {
  const run = getLockpickRun(message);
  if (!run) return false;
  if (game.user?.isGM) return true;
  if (String(game.user?.id || '') === run.ownerUserId) return true;
  const authorId = typeof message.author === 'string' ? message.author : message.author?.id;
  return String(authorId || '') === String(game.user?.id || '');
}

function _ownerIsActive(ownerUserId) {
  const user = game.users?.get?.(ownerUserId);
  return !!user?.active;
}

function _shouldHandleSocketWrite(run) {
  const me = String(game.user?.id || '');
  if (me && me === run.ownerUserId) return true;
  if (game.user?.isGM && !_ownerIsActive(run.ownerUserId)) return true;
  return false;
}

/**
 * @param {ChatMessage} message
 * @param {object} nextRun
 * @param {{ refreshContent?: boolean }} [opts]
 */
export async function writeLockpickRunLocal(message, nextRun, opts = {}) {
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
 * @param {object} run
 * @param {object} patch
 */
export function mergeLockpickRun(run, patch = {}) {
  const actions = Array.isArray(patch.actions)
    ? patch.actions.map((a) => serializeLockpickAction(a))
    : run.actions;
  const status = patch.status || run.status;
  const stats = {
    checkCount: patch.stats?.checkCount ?? run.stats.checkCount,
    pinsUnlocked: patch.stats?.pinsUnlocked ?? run.stats.pinsUnlocked,
    pinCount: patch.stats?.pinCount ?? run.stats.pinCount,
  };
  const nextRevision = patch.forceRevision != null
    ? Math.max(0, Math.floor(Number(patch.forceRevision)))
    : run.revision + 1;

  return {
    ...run,
    actions,
    status,
    stats,
    revision: nextRevision,
  };
}

/**
 * @param {string} messageId
 * @param {object} patch
 * @param {{ expectedRevision?: number, refreshContent?: boolean }} [opts]
 */
export async function pushLockpickRunState(messageId, patch, opts = {}) {
  const message = game.messages?.get?.(messageId);
  if (!message) throw new Error('lockpick run message missing');
  const run = getLockpickRun(message);
  if (!run) throw new Error('lockpick run flag missing');

  if (opts.expectedRevision != null && run.revision !== opts.expectedRevision) {
    throw new Error('stale revision');
  }

  const next = mergeLockpickRun(run, patch);

  if (_canWriteRunMessage(message)) {
    await writeLockpickRunLocal(message, next, {
      refreshContent: opts.refreshContent ?? next.status !== 'active',
    });
    return next;
  }

  return requestLockpickSocket(ACTION_SET_RUN, {
    messageId,
    expectedRevision: run.revision,
    run: next,
    refreshContent: opts.refreshContent ?? next.status !== 'active',
  });
}

function _emit(message) {
  try {
    game.socket.emit(_socketName(), message);
    return true;
  } catch (error) {
    console.error('SpaceHolder | lockpick socket emit failed', error);
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
export function requestLockpickSocket(action, payload = {}, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const requestId = _nextRequestId();
    const timeoutId = setTimeout(() => {
      _pending.delete(requestId);
      reject(new Error('lockpick socket timeout'));
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
      reject(new Error('lockpick socket emit failed'));
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
  const run = getLockpickRun(message);
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
      const next = payload.run || mergeLockpickRun(run, payload);
      next.revision = Math.max(run.revision + 1, Number(next.revision) || 0);
      await writeLockpickRunLocal(message, next, {
        refreshContent: !!payload.refreshContent || next.status !== 'active',
      });
      _reply(msg, true, next);
      return;
    }
    _reply(msg, false, null, 'unknown action');
  } catch (error) {
    console.error('SpaceHolder | lockpick socket action failed', error);
    _reply(msg, false, null, String(error?.message || error));
  }
}

function _handleSocketResponse(msg) {
  const requestId = String(msg?.requestId || '');
  if (String(msg?.userId || '') !== String(game.user?.id || '')) return;
  const pending = _pending.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  _pending.delete(requestId);
  if (msg?.ok) pending.resolve(msg.payload);
  else pending.reject(new Error(String(msg?.error || 'lockpick socket failed')));
}

export function installLockpickSocket() {
  if (_socketInstalled) return;
  _socketInstalled = true;
  if (!game?.socket?.on) {
    console.warn('SpaceHolder | lockpick: game.socket unavailable');
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
      console.error('SpaceHolder | lockpick socket crashed', error);
    }
  });
}

function _getChatMessageForControl(el) {
  const root = el?.closest?.('.chat-message[data-message-id]');
  const id = root?.dataset?.messageId || el?.closest?.('[data-message-id]')?.dataset?.messageId;
  return id ? game.messages?.get?.(id) : null;
}

async function _onLockpickStartClick(btn) {
  const message = _getChatMessageForControl(btn);
  if (!message) return;
  await startLockpickRunFromInvite(message);
}

async function _onLockpickObserveClick(btn) {
  const message = _getChatMessageForControl(btn);
  if (!message) return;
  openLockpickRunObserver(message);
}

function _installDelegatedClicks() {
  if (typeof document === 'undefined') return;
  document.addEventListener(
    'click',
    (ev) => {
      const t = ev.target;
      if (!t?.closest) return;
      const start = t.closest('[data-action="sh-lockpick-start"]');
      if (start?.closest?.('[data-spaceholder-lockpick-chat="1"]')) {
        ev.preventDefault();
        ev.stopPropagation();
        void _onLockpickStartClick(start);
        return;
      }
      const observe = t.closest('[data-action="sh-lockpick-observe"]');
      if (observe?.closest?.('[data-spaceholder-lockpick-chat="1"]')) {
        ev.preventDefault();
        ev.stopPropagation();
        void _onLockpickObserveClick(observe);
      }
    },
    true
  );
}

function _syncOpenAppFromMessage(message) {
  const run = getLockpickRun(message);
  if (!run) return;
  const app = getLockpickMinigameApp?.();
  if (!app || app._runId !== run.runId) return;
  app.applyRemoteRun?.(run, message.id);
}

export function installLockpickChatHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;
  _installDelegatedClicks();
  installLockpickSocket();

  Hooks.on('updateChatMessage', (message) => {
    try {
      if (message?.flags?.[MODULE_NS]?.[FLAG_RUN]) _syncOpenAppFromMessage(message);
    } catch (error) {
      console.error('SpaceHolder | lockpick chat update hook failed', error);
    }
  });

  Hooks.on('deleteChatMessage', (message) => {
    try {
      const run = getLockpickRun(message);
      if (!run) return;
      const app = getLockpickMinigameApp?.();
      if (app && app._runId === run.runId) {
        app._runMessageId = null;
        app._runId = null;
      }
    } catch (_) {
      /* ignore */
    }
  });
}

export { generateLockpickSession, replayLockpickSession };

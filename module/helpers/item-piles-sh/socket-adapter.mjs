import { ITEM_PILES_SH, getSystemSocketName } from './constants.mjs';

let _installed = false;
let _seq = 0;
const _handlers = new Map();
const _pending = new Map();

function _nextRequestId() {
  _seq += 1;
  return `${Date.now()}-${game.user?.id || 'user'}-${_seq}`;
}

function _emit(message) {
  try {
    game.socket.emit(getSystemSocketName(), message);
    return true;
  } catch (error) {
    console.error('SpaceHolder | item-piles-sh socket emit failed', error);
    return false;
  }
}

function _reply(msg, ok, payload = null, error = '') {
  const userId = String(msg?.userId || '').trim();
  const requestId = String(msg?.requestId || '').trim();
  if (!userId || !requestId) return;
  _emit({
    type: ITEM_PILES_SH.SOCKET_TYPE,
    op: ITEM_PILES_SH.SOCKET_OP_RESPONSE,
    requestId,
    userId,
    ok: !!ok,
    payload,
    error: String(error || ''),
  });
}

async function _handleRequestAsGm(msg) {
  const action = String(msg?.action || '').trim();
  if (!action) {
    _reply(msg, false, null, 'missing action');
    return;
  }
  const handler = _handlers.get(action);
  if (typeof handler !== 'function') {
    _reply(msg, false, null, `unknown action: ${action}`);
    return;
  }
  try {
    const payload = await handler(msg?.payload ?? {}, {
      requesterUserId: String(msg?.userId || '').trim(),
      requestId: String(msg?.requestId || '').trim(),
      rawMessage: msg,
      fromSocket: true,
    });
    _reply(msg, true, payload);
  } catch (error) {
    console.error(`SpaceHolder | item-piles-sh socket action failed: ${action}`, error);
    _reply(msg, false, null, error?.message || String(error));
  }
}

function _handleResponse(msg) {
  const requestId = String(msg?.requestId || '').trim();
  const userId = String(msg?.userId || '').trim();
  if (!requestId || !userId) return;
  if (userId !== String(game.user?.id || '').trim()) return;
  const pending = _pending.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  _pending.delete(requestId);
  if (msg?.ok) pending.resolve(msg?.payload);
  else pending.reject(new Error(String(msg?.error || 'item-piles-sh socket request failed')));
}

export function installItemPilesShSocketAdapter() {
  if (_installed) return;
  _installed = true;
  if (!game?.socket?.on) {
    console.warn('SpaceHolder | item-piles-sh: game.socket unavailable');
    return;
  }

  game.socket.on(getSystemSocketName(), async (msg) => {
    try {
      if (!msg || msg.type !== ITEM_PILES_SH.SOCKET_TYPE) return;
      if (msg.op === ITEM_PILES_SH.SOCKET_OP_RESPONSE) {
        _handleResponse(msg);
        return;
      }
      if (msg.op === ITEM_PILES_SH.SOCKET_OP_REQUEST) {
        if (!game.user?.isGM) return;
        await _handleRequestAsGm(msg);
      }
    } catch (error) {
      console.error('SpaceHolder | item-piles-sh socket adapter crashed', error);
    }
  });
}

export function registerItemPilesShSocketAction(action, handler) {
  const key = String(action || '').trim();
  if (!key) return;
  if (typeof handler !== 'function') return;
  _handlers.set(key, handler);
}

export async function executeItemPilesShAsGm(action, payload = {}, { timeoutMs = 8000 } = {}) {
  const key = String(action || '').trim();
  if (!key) throw new Error('item-piles-sh action is required');

  if (game.user?.isGM) {
    const handler = _handlers.get(key);
    if (typeof handler !== 'function') throw new Error(`item-piles-sh unknown action: ${key}`);
    return handler(payload, {
      requesterUserId: String(game.user?.id || '').trim(),
      requestId: '',
      rawMessage: null,
      fromSocket: false,
    });
  }

  const requestId = _nextRequestId();
  const message = {
    type: ITEM_PILES_SH.SOCKET_TYPE,
    op: ITEM_PILES_SH.SOCKET_OP_REQUEST,
    action: key,
    requestId,
    userId: game.user?.id,
    payload,
  };

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      _pending.delete(requestId);
      reject(new Error(`item-piles-sh request timed out: ${key}`));
    }, Math.max(1000, Number(timeoutMs) || 8000));

    _pending.set(requestId, { resolve, reject, timeoutId });
    const ok = _emit(message);
    if (!ok) {
      clearTimeout(timeoutId);
      _pending.delete(requestId);
      reject(new Error(`item-piles-sh socket emit failed: ${key}`));
    }
  });
}

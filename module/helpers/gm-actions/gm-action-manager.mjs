/**
 * GM action manager — one path for everything a player's client needs done with GM permissions.
 *
 * - A client calls `request(type, payload, opts)`. A GM executes it locally; a player sends it to
 *   the designated (active) GM over the socket and waits for the result.
 * - If no GM is online (or none acknowledges within `ackTimeoutMs`), the action is parked in the
 *   requester's own User flags (`flags.spaceholder.gmQueue`). The GM is offered the whole queue on
 *   login ("Player actions while you were away"); entries the GM leaves unselected are cancelled.
 * - Every parked action marks a chat message ("awaits GM"); the GM clears the mark when the action
 *   is applied or replaces it with "cancelled" / "failed".
 * - Execution is at-most-once: a queue entry is removed *before* its handler runs.
 *
 * All Foundry access goes through an injected `env`, so the state machine is testable in Node.
 *
 * Socket messages are not authenticated by Foundry (the claimed `userId` can be spoofed), so
 * per-type `validate` hooks guard against mistakes, not against a hostile client.
 *
 * @typedef {object} GmActionEnv
 * @property {string} userId current user id
 * @property {boolean} isGM whether the current user has the GM role
 * @property {() => (string|null)} activeGMId designated active GM (null when none is online)
 * @property {(id: string) => ({id: string, name: string, isGM: boolean}|null)} getUser
 * @property {(message: object) => boolean} emit send a socket message to the other clients
 * @property {() => Array<{userId: string, entries: object[]}>} listQueues every user's parked entries
 * @property {(userId: string, entry: object) => Promise<void>} putQueueEntry write an entry to a user's queue
 * @property {(userId: string, entryId: string) => Promise<void>} removeQueueEntry
 * @property {(messageId: string, entryId: string, status: (string|null)) => Promise<boolean>} setChatStatus
 *   set (or, with null, clear) an action's status on a chat message; false when it could not be done
 * @property {(entry: object) => Promise<(string|null)>} createPendingChat create a dedicated chat message
 *   carrying the pending status; returns its id
 * @property {() => number} now
 */

import {
  GM_ACTION_DEFAULT_CATEGORY,
  GM_ACTION_STATUS,
  createQueueEntry,
  orderEntries,
  planDecision,
  sanitizeEntry,
} from './gm-actions-core.mjs';

/** `type` of every socket message of this manager (the channel itself is shared with other features). */
export const GM_ACTION_SOCKET_TYPE = 'spaceholder.gmActions';

const OP_REQUEST = 'request';
const OP_ACK = 'ack';
const OP_RESPONSE = 'response';

/** No GM acknowledged a live request: the caller falls back to the queue. */
export class GmActionNoAckError extends Error {
  constructor(message = 'no GM acknowledged the action') {
    super(message);
    this.name = 'GmActionNoAckError';
  }
}

/** A `validate` hook refused the action. */
export class GmActionRejectedError extends Error {
  constructor(message = 'rejected') {
    super(message);
    this.name = 'GmActionRejectedError';
  }
}

export class GmActionManager {
  /** @param {GmActionEnv} env */
  constructor(env) {
    this.env = env;
    /** @type {Map<string, {category: string, handler: Function, validate?: Function}>} */
    this._defs = new Map();
    /** live requests this client is waiting on: entryId → { onAck, onResponse } */
    this._pending = new Map();
    /**
     * entry id → 'running' | 'done' | 'failed' for everything this GM client already started (at-most-once).
     * A queued copy of an action that was also run live (the GM answered too late for the requester's
     * timeout) is recognised by its id and only cleaned up, never run twice.
     */
    this._handled = new Map();
    /** queue entries present when the GM logged in and not yet decided on; live processing skips them */
    this._deferred = new Set();
    this._seq = 0;
    this._chain = Promise.resolve();
  }

  /**
   * Register an action type (on every client: requesters need the category, the GM the handler).
   * @param {string} type
   * @param {object} def
   * @param {string} [def.category] group in the GM queue window
   * @param {(payload: object, ctx: {entry: object, requesterId: string, requester: object|null}) => Promise<any>|any} def.handler
   *   runs on the GM client; its (small, JSON-serializable) result goes back to a live requester
   * @param {(ctx: {entry: object, payload: object, requester: object|null}) => Promise<(true|string)>|(true|string)} [def.validate]
   *   return `true` to allow, or a reason string to reject
   */
  register(type, def) {
    const key = String(type ?? '').trim();
    if (!key) throw new Error('gm-actions: action type is required');
    if (!def || typeof def.handler !== 'function') throw new Error(`gm-actions: handler is required for ${key}`);
    this._defs.set(key, {
      category: String(def.category ?? '').trim() || GM_ACTION_DEFAULT_CATEGORY,
      handler: def.handler,
      validate: typeof def.validate === 'function' ? def.validate : undefined,
    });
  }

  /** @param {string} type */
  has(type) {
    return this._defs.has(String(type ?? '').trim());
  }

  /**
   * Ask for something to be done with GM permissions.
   *
   * @param {string} type registered action type
   * @param {object} payload JSON-serializable
   * @param {object} [opts]
   * @param {string} [opts.label] human description (chat note and GM queue window)
   * @param {string|null} [opts.chatMessageId] chat message to mark while the action waits
   * @param {number} [opts.ackTimeoutMs=3000] how long to wait for a GM to acknowledge before queueing
   * @param {number} [opts.resultTimeoutMs=30000] how long to wait for the result once acknowledged
   * @returns {Promise<{status: 'done', id: string, result: any} | {status: 'queued', id: string}>}
   *   rejects when the action ran and failed, was rejected, or could not even be queued
   */
  async request(type, payload, { label = '', chatMessageId = null, ackTimeoutMs = 3000, resultTimeoutMs = 30000 } = {}) {
    const env = this.env;
    const def = this._defs.get(String(type ?? '').trim());
    if (!def) throw new Error(`gm-actions: unknown action type: ${type}`);

    const entry = createQueueEntry({
      type,
      payload,
      category: def.category,
      label,
      requesterId: env.userId,
      requesterName: env.getUser(env.userId)?.name ?? '',
      chatMessageId,
      now: env.now(),
      seq: ++this._seq,
    });

    if (env.isGM) {
      const result = await this._run(entry, { requesterId: env.userId, skipValidation: true });
      return { status: 'done', id: entry.id, result };
    }

    if (env.activeGMId()) {
      try {
        const result = await this._sendLive(entry, { ackTimeoutMs, resultTimeoutMs });
        return { status: 'done', id: entry.id, result };
      } catch (error) {
        if (!(error instanceof GmActionNoAckError)) throw error;
        // The GM went away or stalled before taking it: fall through to the queue.
      }
    }

    await this._enqueue(entry);
    return { status: 'queued', id: entry.id };
  }

  // ===== requester side =====

  /** Park an action in the requester's own queue and mark a chat message. */
  async _enqueue(entry) {
    const env = this.env;
    let messageId = entry.chatMessageId;
    const marked = messageId ? await env.setChatStatus(messageId, entry.id, GM_ACTION_STATUS.PENDING) : false;
    if (!marked) messageId = await env.createPendingChat(entry);
    entry.chatMessageId = messageId ?? null;
    try {
      await env.putQueueEntry(env.userId, entry);
    } catch (error) {
      if (messageId) await env.setChatStatus(messageId, entry.id, null).catch(() => {});
      throw error;
    }
  }

  /** Send a live request and wait for acknowledgement, then for the result. */
  _sendLive(entry, { ackTimeoutMs, resultTimeoutMs }) {
    const env = this.env;
    return new Promise((resolve, reject) => {
      let ackTimer = null;
      let resultTimer = null;
      let acked = false;
      const finish = (fn, value) => {
        clearTimeout(ackTimer);
        clearTimeout(resultTimer);
        this._pending.delete(entry.id);
        fn(value);
      };

      ackTimer = setTimeout(() => finish(reject, new GmActionNoAckError()), Math.max(1, Number(ackTimeoutMs) || 3000));
      this._pending.set(entry.id, {
        onAck: () => {
          if (acked) return;
          acked = true;
          clearTimeout(ackTimer);
          resultTimer = setTimeout(
            () => finish(reject, new Error(`gm-actions: the GM acknowledged ${entry.type} but did not report a result in time`)),
            Math.max(1, Number(resultTimeoutMs) || 30000),
          );
        },
        onResponse: (msg) => {
          if (msg?.ok) finish(resolve, msg.result ?? null);
          else finish(reject, new Error(String(msg?.error || 'GM action failed')));
        },
      });

      const sent = env.emit({
        type: GM_ACTION_SOCKET_TYPE,
        op: OP_REQUEST,
        userId: env.userId,
        entry,
      });
      if (!sent) finish(reject, new GmActionNoAckError('socket emit failed'));
    });
  }

  // ===== socket =====

  /**
   * Entry point for every socket message of this manager.
   * @param {object} msg
   */
  async handleMessage(msg) {
    if (!msg || msg.type !== GM_ACTION_SOCKET_TYPE) return;
    if (msg.op === OP_ACK || msg.op === OP_RESPONSE) {
      if (String(msg.userId ?? '') !== String(this.env.userId ?? '')) return; // addressed to someone else
      const pending = this._pending.get(String(msg.requestId ?? ''));
      if (!pending) return;
      if (msg.op === OP_ACK) pending.onAck();
      else pending.onResponse(msg);
      return;
    }
    if (msg.op === OP_REQUEST) await this._handleRequest(msg);
  }

  /** GM side: take a live request. Only the designated GM answers. */
  async _handleRequest(msg) {
    const env = this.env;
    if (!env.isGM || env.userId !== env.activeGMId()) return;
    const requesterId = String(msg.userId ?? '').trim();
    const entry = sanitizeEntry(msg.entry);
    if (!entry || !requesterId) return;
    if (this._handled.has(entry.id)) return;
    this._handled.set(entry.id, 'running');
    entry.requesterId = requesterId;

    env.emit({ type: GM_ACTION_SOCKET_TYPE, op: OP_ACK, userId: requesterId, requestId: entry.id });
    try {
      const result = await this._run(entry, { requesterId });
      this._handled.set(entry.id, 'done');
      await this._cleanQueuedCopy(entry.id, null);
      env.emit({
        type: GM_ACTION_SOCKET_TYPE,
        op: OP_RESPONSE,
        userId: requesterId,
        requestId: entry.id,
        ok: true,
        result: result === undefined ? null : JSON.parse(JSON.stringify(result)),
      });
    } catch (error) {
      this._handled.set(entry.id, 'failed');
      await this._cleanQueuedCopy(entry.id, GM_ACTION_STATUS.FAILED);
      env.emit({
        type: GM_ACTION_SOCKET_TYPE,
        op: OP_RESPONSE,
        userId: requesterId,
        requestId: entry.id,
        ok: false,
        error: error?.message || String(error),
      });
    }
  }

  // ===== execution =====

  /**
   * Validate and run an entry's handler (GM client).
   * @param {object} entry
   * @param {{requesterId: string, skipValidation?: boolean}} ctx
   */
  async _run(entry, { requesterId, skipValidation = false }) {
    const def = this._defs.get(entry.type);
    if (!def) throw new Error(`gm-actions: unknown action type: ${entry.type}`);
    const requester = this.env.getUser(requesterId);
    if (!skipValidation && def.validate) {
      const verdict = await def.validate({ entry, payload: entry.payload, requester });
      if (verdict !== true) throw new GmActionRejectedError(typeof verdict === 'string' && verdict ? verdict : 'rejected');
    }
    return def.handler(entry.payload, { entry, requesterId, requester });
  }

  // ===== the queue (GM side) =====

  /** Every parked entry across all users, chronologically. @returns {object[]} */
  listQueue() {
    const out = [];
    for (const { userId, entries } of this.env.listQueues()) {
      for (const raw of entries ?? []) {
        const entry = sanitizeEntry(raw);
        if (!entry) continue;
        entry.requesterId = entry.requesterId || userId;
        out.push(entry);
      }
    }
    return orderEntries(out);
  }

  /**
   * Remember the entries present at login: live processing leaves them for the GM's decision.
   * @param {Iterable<string>} ids
   */
  deferEntries(ids) {
    for (const id of ids) this._deferred.add(id);
  }

  /**
   * Apply the selected queue entries (chronologically) and cancel the rest.
   * @param {{selectedIds?: (Iterable<string>|null)}} [opts] `null`/omitted applies everything
   * @returns {Promise<{applied: number, cancelled: number, failed: number}>}
   */
  processQueue({ selectedIds = null } = {}) {
    return this._serial(async () => {
      this._requireGM();
      const { apply, cancel } = planDecision(this.listQueue(), selectedIds);
      return this._decide(apply, cancel);
    });
  }

  /**
   * Apply queue entries that appeared while this GM was already online (not the login backlog).
   * @returns {Promise<{applied: number, cancelled: number, failed: number}>}
   */
  processLive() {
    return this._serial(async () => {
      const env = this.env;
      if (!env.isGM || env.userId !== env.activeGMId()) return { applied: 0, cancelled: 0, failed: 0 };
      const fresh = this.listQueue().filter((e) => !this._deferred.has(e.id));
      return this._decide(fresh, []);
    });
  }

  async _decide(apply, cancel) {
    const result = { applied: 0, cancelled: 0, failed: 0 };
    for (const entry of apply) {
      if (this._handled.has(entry.id)) {
        await this._cleanHandled(entry, result);
        continue;
      }
      this._handled.set(entry.id, 'running');
      this._deferred.delete(entry.id);
      // At-most-once: take the entry out of the queue before running it.
      await this._settle(entry, undefined);
      try {
        await this._run(entry, { requesterId: entry.requesterId });
        this._handled.set(entry.id, 'done');
        await this._chat(entry, null);
        result.applied += 1;
      } catch (error) {
        console.error(`SpaceHolder | GM action ${entry.type} failed`, error);
        this._handled.set(entry.id, 'failed');
        await this._chat(entry, GM_ACTION_STATUS.FAILED);
        result.failed += 1;
      }
    }
    for (const entry of cancel) {
      if (this._handled.has(entry.id)) {
        // It already ran live, so there is nothing left to cancel: only clean up.
        await this._cleanHandled(entry, result);
        continue;
      }
      this._handled.set(entry.id, 'cancelled');
      this._deferred.delete(entry.id);
      await this._settle(entry, GM_ACTION_STATUS.CANCELLED);
      result.cancelled += 1;
    }
    return result;
  }

  /**
   * A queue entry whose action this GM client already ran (live): remove the leftover and set the
   * chat note to what actually happened. An action still running is left for its own cleanup.
   * @returns {Promise<boolean>} whether the entry was cleaned up
   */
  async _cleanHandled(entry, result) {
    const outcome = this._handled.get(entry.id);
    if (outcome === 'running') return false;
    this._deferred.delete(entry.id);
    const failed = outcome === 'failed';
    await this._settle(entry, failed ? GM_ACTION_STATUS.FAILED : null);
    if (failed) result.failed += 1;
    else result.applied += 1;
    return true;
  }

  /** Clean up the queued copy of an action that has just run live (if the requester already queued it). */
  async _cleanQueuedCopy(entryId, chatStatus) {
    const queued = this.listQueue().find((e) => e.id === entryId);
    if (queued) await this._settle(queued, chatStatus);
  }

  /** Remove an entry from its owner's queue and (when a status is given) update its chat note. */
  async _settle(entry, chatStatus) {
    try {
      await this.env.removeQueueEntry(entry.requesterId, entry.id);
    } catch (error) {
      console.error('SpaceHolder | GM action: could not remove a queue entry', error);
    }
    if (chatStatus !== undefined) await this._chat(entry, chatStatus);
  }

  async _chat(entry, status) {
    if (!entry.chatMessageId) return;
    try {
      await this.env.setChatStatus(entry.chatMessageId, entry.id, status);
    } catch (error) {
      console.error('SpaceHolder | GM action: could not update a chat note', error);
    }
  }

  _requireGM() {
    if (!this.env.isGM) throw new Error('gm-actions: only a GM can process the queue');
  }

  /** Run queue operations one after another. */
  _serial(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }
}

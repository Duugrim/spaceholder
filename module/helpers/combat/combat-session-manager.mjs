import { getEffectiveActionCost } from "../actions/action-service.mjs";
import { getStoredActionPoints, refreshApPool } from "../actions/transaction-ledger.mjs";
import { ensureCombatActionJournalMessage } from "../actions/action-chat-journal.mjs";

const MODULE_NS = "spaceholder";
const SOCKET_TYPE = `${MODULE_NS}.combatLog`;
const FLAG_STATE = "combatState";
const FLAG_TABLES = "combatTables";
const DISPOSITION_SIDE_MAP = {
  [CONST?.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1]: "disp:friendly",
  [CONST?.TOKEN_DISPOSITIONS?.NEUTRAL ?? 0]: "disp:neutral",
  [CONST?.TOKEN_DISPOSITIONS?.HOSTILE ?? -1]: "disp:hostile",
  [CONST?.TOKEN_DISPOSITIONS?.SECRET ?? -2]: "disp:secret",
};

function _socketName() {
  try {
    return `system.${game.system.id}`;
  } catch (_) {
    return `system.${MODULE_NS}`;
  }
}

function _num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _randomId() {
  try {
    return foundry.utils.randomID();
  } catch (_) {
    return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

function _nowIso() {
  return new Date().toISOString();
}

async function _resolveTokenDocFromCombatant(combatant) {
  const token = combatant?.token ?? null;
  if (token) return token;
  const tokenUuid = String(combatant?.tokenUuid ?? "").trim();
  if (!tokenUuid) return null;
  try {
    const doc = await fromUuid(tokenUuid);
    return doc?.documentName === "Token" ? doc : null;
  } catch (_) {
    return null;
  }
}

function _clone(obj) {
  try {
    return foundry.utils.deepClone(obj);
  } catch (_) {
    return JSON.parse(JSON.stringify(obj));
  }
}

export class CombatSessionManager {
  constructor() {
    this._socketInstalled = false;
    this._hooksInstalled = false;
    this._reqSeq = 0;
    this._pending = new Map();
    this._outbox = [];
    this._manualUndoMarker = null;
    this._outboxTimer = null;
    this._uiSelectedCombatantByCombat = new Map();
    this._registeredContextHooks = [];
    this._bound = {
      onCombatStart: this._onCombatStart.bind(this),
      onUpdateCombat: this._onUpdateCombat.bind(this),
      onDeleteCombat: this._onDeleteCombat.bind(this),
      onRenderCombatTracker: this._onRenderCombatTracker.bind(this),
      onGetCombatTrackerEntryContext: this._onGetCombatTrackerEntryContext.bind(this),
      onSocketMessage: this._onSocketMessage.bind(this),
      onHistoryUndo: this._onHistoryUndo.bind(this),
      onHistoryRedo: this._onHistoryRedo.bind(this),
      onUndoOperation: this._onHistoryUndo.bind(this),
      onRedoOperation: this._onHistoryRedo.bind(this),
      onBeforeUnload: this._onBeforeUnload.bind(this),
    };
  }

  install() {
    if (this._hooksInstalled) return;
    Hooks.on("combatStart", this._bound.onCombatStart);
    Hooks.on("updateCombat", this._bound.onUpdateCombat);
    Hooks.on("deleteCombat", this._bound.onDeleteCombat);
    Hooks.on("renderCombatTracker", this._bound.onRenderCombatTracker);
    this._registerCombatContextHooks();
    Hooks.on("historyUndo", this._bound.onHistoryUndo);
    Hooks.on("historyRedo", this._bound.onHistoryRedo);
    Hooks.on("undoOperation", this._bound.onUndoOperation);
    Hooks.on("redoOperation", this._bound.onRedoOperation);
    window.addEventListener("beforeunload", this._bound.onBeforeUnload);
    this._installSocket();
    this._hooksInstalled = true;
    this._loadOutbox();
  }

  destroy() {
    if (!this._hooksInstalled) return;
    Hooks.off("combatStart", this._bound.onCombatStart);
    Hooks.off("updateCombat", this._bound.onUpdateCombat);
    Hooks.off("deleteCombat", this._bound.onDeleteCombat);
    Hooks.off("renderCombatTracker", this._bound.onRenderCombatTracker);
    for (const h of this._registeredContextHooks) Hooks.off(h, this._bound.onGetCombatTrackerEntryContext);
    this._registeredContextHooks = [];
    Hooks.off("historyUndo", this._bound.onHistoryUndo);
    Hooks.off("historyRedo", this._bound.onHistoryRedo);
    Hooks.off("undoOperation", this._bound.onUndoOperation);
    Hooks.off("redoOperation", this._bound.onRedoOperation);
    window.removeEventListener("beforeunload", this._bound.onBeforeUnload);
    this._hooksInstalled = false;
  }

  _installSocket() {
    if (this._socketInstalled) return;
    if (!game?.socket?.on) return;
    game.socket.on(_socketName(), this._bound.onSocketMessage);
    this._socketInstalled = true;
  }

  _outboxKey() {
    return `${MODULE_NS}.combat.outbox.${game.world?.id || "world"}.${game.user?.id || "user"}`;
  }

  _loadOutbox() {
    try {
      const raw = localStorage.getItem(this._outboxKey());
      const data = JSON.parse(raw || "[]");
      this._outbox = Array.isArray(data) ? data : [];
    } catch (_) {
      this._outbox = [];
    }
    this._scheduleOutboxFlush(500);
  }

  _saveOutbox() {
    try {
      localStorage.setItem(this._outboxKey(), JSON.stringify(this._outbox));
    } catch (_) {
      // ignore quota errors
    }
  }

  _scheduleOutboxFlush(delayMs = 1000) {
    if (this._outboxTimer) clearTimeout(this._outboxTimer);
    this._outboxTimer = setTimeout(() => {
      this._outboxTimer = null;
      this._flushOutbox().catch(() => {});
    }, Math.max(100, Number(delayMs) || 1000));
  }

  async _flushOutbox() {
    if (!this._outbox.length) return;
    if (game.user?.isGM) {
      for (const item of this._outbox) {
        if (item?.acked) continue;
        await this._appendEventAsGM(item.payload);
        item.acked = true;
      }
      this._outbox = this._outbox.filter((x) => !x?.acked);
      this._saveOutbox();
      return;
    }
    for (const item of this._outbox) {
      if (!item || item.acked) continue;
      try {
        await this._requestViaSocket("appendEvent", item.payload, { timeoutMs: 6000 });
        item.acked = true;
      } catch (_) {
        // Keep pending; retry later
      }
    }
    this._outbox = this._outbox.filter((x) => !x?.acked);
    this._saveOutbox();
    if (this._outbox.length) this._scheduleOutboxFlush(2000);
  }

  _makeRequestId() {
    this._reqSeq += 1;
    return `${Date.now()}-${game.user?.id || "user"}-${this._reqSeq}`;
  }

  _sendSocket(message) {
    try {
      game.socket.emit(_socketName(), message);
      return true;
    } catch (_) {
      return false;
    }
  }

  _requestViaSocket(action, payload, { timeoutMs = 8000 } = {}) {
    const requestId = this._makeRequestId();
    const msg = {
      type: SOCKET_TYPE,
      op: "request",
      action,
      requestId,
      userId: game.user?.id,
      payload,
    };
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this._pending.delete(requestId);
        reject(new Error(`Combat socket timeout: ${action}`));
      }, Math.max(1000, Number(timeoutMs) || 8000));

      this._pending.set(requestId, { resolve, reject, timeoutId });
      const ok = this._sendSocket(msg);
      if (!ok) {
        clearTimeout(timeoutId);
        this._pending.delete(requestId);
        reject(new Error(`Combat socket emit failed: ${action}`));
      }
    });
  }

  _onSocketMessage(msg) {
    if (!msg || msg.type !== SOCKET_TYPE) return;
    if (msg.op === "response") {
      const requestId = String(msg.requestId || "").trim();
      const userId = String(msg.userId || "").trim();
      if (!requestId || userId !== String(game.user?.id || "").trim()) return;
      const pending = this._pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timeoutId);
      this._pending.delete(requestId);
      if (msg.ok) pending.resolve(msg.payload);
      else pending.reject(new Error(String(msg.error || "Combat request failed")));
      return;
    }
    if (msg.op === "request" && game.user?.isGM) {
      this._handleSocketRequestAsGM(msg).catch(() => {});
    }
  }

  async _handleSocketRequestAsGM(msg) {
    const action = String(msg.action || "").trim();
    const requestId = String(msg.requestId || "").trim();
    const userId = String(msg.userId || "").trim();
    const reply = (ok, payload = null, error = null) => {
      this._sendSocket({
        type: SOCKET_TYPE,
        op: "response",
        action,
        requestId,
        userId,
        ok: !!ok,
        payload,
        error: error ? String(error) : null,
      });
    };
    try {
      if (!requestId || !userId) return;
      if (action === "appendEvent") {
        const payload = _clone(msg.payload || {});
        payload.meta = payload.meta || {};
        payload.meta.byUserId = userId;
        const saved = await this._appendEventAsGM(payload);
        reply(true, saved);
        return;
      }
      if (action === "setSide") {
        const { combatId, combatantId, sideId } = msg.payload || {};
        await this.setCombatantSide({ combatId, combatantId, sideId, viaSocket: true });
        reply(true, { ok: true });
        return;
      }
      if (action === "endTurn") {
        const { combatId, overrideSideId } = msg.payload || {};
        const data = await this.endTurn({ combatId, overrideSideId, viaSocket: true });
        reply(true, data);
        return;
      }
      if (action === "pickTurn") {
        const { combatId, combatantId } = msg.payload || {};
        const data = await this._pickTurnAsRequestingUser(combatId, combatantId, userId);
        if (data?.ok) reply(true, data);
        else reply(false, null, data?.error || "pickTurn failed");
        return;
      }
      if (action === "undoLastAction") {
        const { combatId, combatantId } = msg.payload || {};
        const data = await this.undoLastAction({ combatId, combatantId, viaSocket: true });
        reply(true, data);
        return;
      }
      if (action === "ledgerCommit") {
        const { commitTransactionAsGMSocket } = await import("../actions/transaction-ledger.mjs");
        const data = await commitTransactionAsGMSocket(msg.payload || {}, userId);
        if (data?.ok) reply(true, data);
        else reply(false, null, data?.error || "ledgerCommit failed");
        return;
      }
      if (action === "ledgerUndo") {
        const { undoTransactionAsGMSocket } = await import("../actions/transaction-ledger.mjs");
        const data = await undoTransactionAsGMSocket(msg.payload || {}, userId);
        if (data?.ok) reply(true, data);
        else reply(false, null, data?.error || "ledgerUndo failed");
        return;
      }
      if (action === "journalUndo") {
        const data = await this._applyJournalUndoAsGM(msg.payload || {}, userId);
        if (data?.ok) reply(true, data);
        else reply(false, null, data?.error || "journalUndo failed");
        return;
      }
      if (action === "journalUndoPreview") {
        const data = await this._computeJournalUndoPreviewAsGM(msg.payload || {}, userId);
        if (data?.ok) reply(true, data);
        else reply(false, null, data?.error || "journalUndoPreview failed");
        return;
      }
      reply(false, null, `Unknown combat action: ${action}`);
    } catch (err) {
      console.error("SpaceHolder | Combat GM socket handler failed", err);
      reply(false, null, err?.message || err);
    }
  }

  async _appendEventAsGM(payload) {
    const combatId = String(payload?.combatId || game.combat?.id || "").trim();
    if (!combatId) throw new Error("Missing combatId for appendEvent");
    const combat = game.combats?.get(combatId) || null;
    if (!combat) {
      throw new Error("Combat not found");
    }

    const eventId = String(payload?.eventId || _randomId());
    const event = {
      schema: 1,
      eventId,
      combatId,
      type: String(payload?.type || "action"),
      meta: {
        createdAt: _nowIso(),
        byUserId: String(payload?.meta?.byUserId || game.user?.id || ""),
      },
      actor: payload?.actor || null,
      combatant: payload?.combatant || null,
      context: payload?.context || {},
      data: payload?.data || {},
      effects: Array.isArray(payload?.effects) ? payload.effects : [],
      inverse: Array.isArray(payload?.inverse) ? payload.inverse : [],
    };

    await this._applyEventToRuntime(combat, event);
    return { ok: true, eventId };
  }

  _dispositionToSide(disposition) {
    const key = _num(disposition, 0);
    return DISPOSITION_SIDE_MAP[key] || "disp:neutral";
  }

  _defaultSideForCombatant(combatant) {
    const actorSide = String(combatant?.actor?.system?.gFaction || "").trim();
    if (actorSide) return actorSide;
    const tokenDisposition = combatant?.token?.disposition ?? combatant?.token?.document?.disposition;
    const resolved = this._dispositionToSide(tokenDisposition);
    return resolved;
  }

  /** @param {string} sideId */
  _sideOrderRank(sideId) {
    const s = String(sideId || "");
    if (s === "disp:friendly") return 0;
    if (s === "disp:neutral") return 1;
    if (s === "disp:hostile") return 2;
    if (s === "disp:secret") return 3;
    return 4;
  }

  /** @param {string} a @param {string} b */
  _compareSideOrder(a, b) {
    const ra = this._sideOrderRank(a);
    const rb = this._sideOrderRank(b);
    if (ra !== rb) return ra - rb;
    return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
  }

  /** @param {Iterable<string>} sideIds */
  _sortSideIds(sideIds) {
    return Array.from(sideIds).sort((x, y) => this._compareSideOrder(x, y));
  }

  _sortedUniqueSideIds(combat) {
    const set = new Set();
    for (const c of combat?.combatants?.contents || []) {
      const side = String(c.getFlag(MODULE_NS, "combatSide") || this._defaultSideForCombatant(c));
      set.add(side);
    }
    return this._sortSideIds(set);
  }

  async _sideHasRemainingStarters(combat, state, sideId) {
    const want = String(sideId || "");
    for (const c of combat?.combatants?.contents || []) {
      if ((await this._getCombatantSide(c)) !== want) continue;
      const maxStarts = this._getMaxTurnStarts(c.actor);
      const started = this._getStartedTurnsForCombatant(state, c.id);
      if (started < maxStarts) return true;
    }
    return false;
  }

  async _firstSideWithRemainingStarters(combat, state) {
    const sorted = this._sortedUniqueSideIds(combat);
    for (const sid of sorted) {
      if (await this._sideHasRemainingStarters(combat, state, sid)) return sid;
    }
    return sorted[0] || "disp:friendly";
  }

  async _eligibleCombatantIdsForSide(combat, state, sideId) {
    const want = String(sideId || "");
    const out = [];
    for (const c of combat?.combatants?.contents || []) {
      if ((await this._getCombatantSide(c)) !== want) continue;
      const maxStarts = this._getMaxTurnStarts(c.actor);
      const started = this._getStartedTurnsForCombatant(state, c.id);
      if (started < maxStarts) out.push(c.id);
    }
    return out;
  }

  /** Official turn start only (increments startedTurns, sets activeTurn). Mutates `state`; does not persist. */
  async _applyOfficialTurnStart(combat, state, combatantId, sourceType = "pick") {
    if (state.activeTurn?.combatantId === combatantId) return state;
    if (!state.startedTurnsByCombatant || typeof state.startedTurnsByCombatant !== "object") {
      state.startedTurnsByCombatant = {};
    }
    state.startedTurnsByCombatant[combatantId] = this._getStartedTurnsForCombatant(state, combatantId) + 1;
    state.activeTurn = {
      combatantId,
      startedAt: _nowIso(),
      round: Math.max(1, _num(state.round, 1)),
      sourceType,
    };
    if (!Array.isArray(state.actedCombatantIds)) state.actedCombatantIds = [];
    if (!state.actedCombatantIds.includes(combatantId)) state.actedCombatantIds.push(combatantId);
    const combatant = combat.combatants?.get(combatantId) || null;
    state.currentSide = combatant ? await this._getCombatantSide(combatant) : state.currentSide;
    return state;
  }

  /** After currentSide is set: always enter turn-pick mode when any eligible combatant (including exactly one). */
  async _applyTurnPickForCurrentSide(combat, state) {
    const sideId = String(state.currentSide || "");
    const eligible = await this._eligibleCombatantIdsForSide(combat, state, sideId);
    state.turnPick = null;
    if (eligible.length >= 1) {
      state.turnPick = { active: true, sideId, eligibleCombatantIds: eligible };
    }
    return state;
  }

  async _ensureCombatState(combat) {
    if (!combat) return null;
    let state = combat.getFlag(MODULE_NS, FLAG_STATE) || null;
    if (state?.schema === 1) {
      let changed = false;
      let bootstrapPick = false;
      if (!Array.isArray(state.actedCombatantIds)) {
        state.actedCombatantIds = [];
        changed = true;
      }
      if (!state.startedTurnsByCombatant || typeof state.startedTurnsByCombatant !== "object") {
        state.startedTurnsByCombatant = {};
        changed = true;
      }
      if (!Array.isArray(state.sides)) {
        state.sides = [];
        changed = true;
      }
      if (state.turnPick === undefined) {
        state.turnPick = null;
        changed = true;
        bootstrapPick = true;
      }
      if (state.round === undefined || state.round === null) {
        state.round = Math.max(1, _num(combat.round, 1));
        changed = true;
      }
      if (bootstrapPick && game.user?.isGM && combat.started && !state.activeTurn) {
        await this._applyTurnPickForCurrentSide(combat, state);
        changed = true;
      }
      if (changed && game.user?.isGM) await combat.setFlag(MODULE_NS, FLAG_STATE, state);
      return state;
    }
    const combatants = combat.combatants?.contents || [];
    const sides = {};
    for (const c of combatants) {
      const side = String(c.getFlag(MODULE_NS, "combatSide") || this._defaultSideForCombatant(c));
      sides[side] = sides[side] || { id: side, label: side };
    }
    const sortedSideKeys = this._sortSideIds(Object.keys(sides));
    state = {
      schema: 1,
      createdAt: _nowIso(),
      currentSide: sortedSideKeys[0] || "disp:friendly",
      lastSide: null,
      round: Math.max(1, _num(combat.round, 1)),
      actedCombatantIds: [],
      startedTurnsByCombatant: {},
      activeTurn: null,
      turnPick: null,
      selectedCombatantId: combatants[0]?.id || null,
      sides: Object.values(sides),
    };
    if (game.user?.isGM) {
      await this._applyTurnPickForCurrentSide(combat, state);
      await combat.setFlag(MODULE_NS, FLAG_STATE, state);
      await combat.setFlag(MODULE_NS, FLAG_TABLES, {});
    }
    return state;
  }

  async _onCombatStart(combat) {
    try {
      if (!combat) return;
      if (game.user?.isGM) {
        await this._ensureCombatState(combat);
      }
      this._scheduleOutboxFlush(250);
    } catch (e) {
      console.error("SpaceHolder | Combat start handler failed", e);
    }
  }

  async _onUpdateCombat(combat, changes) {
    try {
      if (!combat?.started) return;
      await this._ensureCombatState(combat);
      // Logical round lives in `flags.spaceholder.combatState.round` only; we do not flush on core `Combat.round`.
    } catch (e) {
      console.error("SpaceHolder | Combat update handler failed", e);
    }
  }

  async _onDeleteCombat(combat) {
    try {
      if (!combat) return;
      this._scheduleOutboxFlush(0);
    } catch (e) {
      console.error("SpaceHolder | Combat delete handler failed", e);
    }
  }

  _onBeforeUnload() {
    this._saveOutbox();
  }

  /**
   * Reset per-round turn counters and emit `round.start`. Logical round is in `combatState.round`, not `Combat.round`.
   * @param {{ bumpLogicalRound?: boolean }} [opts]
   */
  async _flushRoundBoundary(combat, { bumpLogicalRound = false } = {}) {
    const state = (await this._ensureCombatState(combat)) || {};
    if (bumpLogicalRound) {
      state.round = Math.max(1, _num(state.round, 1)) + 1;
    }
    state.actedCombatantIds = [];
    state.startedTurnsByCombatant = {};
    state.activeTurn = null;
    state.turnPick = null;
    // First side in fixed order that still has remaining turn starts (after reset, all sides qualify).
    state.currentSide = await this._firstSideWithRemainingStarters(combat, state);
    await this._applyTurnPickForCurrentSide(combat, state);
    if (game.user?.isGM) {
      await combat.setFlag(MODULE_NS, FLAG_STATE, state);
      // Foundry can merge nested flag objects so `{}` does not drop old keys; force-clear like pre-refactor flush.
      const base = `flags.${MODULE_NS}.${FLAG_STATE}`;
      await combat.update({
        [`${base}.-=startedTurnsByCombatant`]: null,
        [`${base}.startedTurnsByCombatant`]: {},
      });
    }
    const payload = {
      combatId: combat.id,
      type: "round.start",
      context: { round: state.round },
      data: {},
      effects: [],
      inverse: [],
    };
    if (game.user?.isGM) {
      await this._appendEventAsGM(payload);
    } else {
      this._queueOutboxPayload(payload);
    }
  }

  _queueOutboxPayload(payload) {
    const item = {
      localId: _randomId(),
      payload,
      queuedAt: Date.now(),
      acked: false,
    };
    this._outbox.push(item);
    this._saveOutbox();
    this._scheduleOutboxFlush(100);
  }

  async appendEvent(payload) {
    if (game.user?.isGM) return this._appendEventAsGM(payload);
    this._queueOutboxPayload(payload);
    try {
      const ack = await this._requestViaSocket("appendEvent", payload, { timeoutMs: 6000 });
      this._outbox = this._outbox.filter((x) => x.payload?.eventId !== payload?.eventId);
      this._saveOutbox();
      return ack;
    } catch (_) {
      return { ok: false, queued: true };
    }
  }

  /**
   * Non-GM: relay AP / ledger commit to GM. GM: apply locally.
   * @param {object} payload - { transactionId?, operations, meta }
   */
  async requestLedgerCommitFromClient(payload) {
    if (game.user?.isGM) {
      const { commitTransactionAsGMSocket } = await import("../actions/transaction-ledger.mjs");
      return commitTransactionAsGMSocket(payload, game.user.id);
    }
    return this._requestViaSocket("ledgerCommit", payload, { timeoutMs: 8000 });
  }

  /** Ledger undo: GM local, or socket (GM validates owner). */
  async requestLedgerUndoFromClient(payload) {
    if (game.user?.isGM) {
      const { undoTransactionAsGMSocket } = await import("../actions/transaction-ledger.mjs");
      return undoTransactionAsGMSocket(payload, game.user.id);
    }
    return this._requestViaSocket("ledgerUndo", payload, { timeoutMs: 8000 });
  }

  /**
   * Chat journal line undo: movement (revertRecordedMovement) + optional AP ledger + combat table row.
   */
  async requestJournalUndoFromClient(payload) {
    if (game.user?.isGM) {
      return this._applyJournalUndoAsGM(payload, game.user.id);
    }
    return this._requestViaSocket("journalUndo", payload, { timeoutMs: 12000 });
  }

  async requestJournalUndoPreviewFromClient(payload) {
    if (game.user?.isGM) {
      return this._computeJournalUndoPreviewAsGM(payload, game.user.id);
    }
    return this._requestViaSocket("journalUndoPreview", payload, { timeoutMs: 12000 });
  }

  /**
   * Logical round from `flags.spaceholder.combatState.round` (not core Combat.round).
   * @param {Combat} combat
   */
  async getLogicalRound(combat) {
    const state = (await this._ensureCombatState(combat)) || {};
    return Math.max(1, _num(state.round, 1));
  }

  /**
   * @param {object} payload
   * @param {string} userId
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async _applyJournalUndoAsGM(payload, userId) {
    const requester = game.users?.get(String(userId || "")) || null;
    if (!requester) return { ok: false, error: "Unknown user" };

    const combatId = String(payload?.combatId || "").trim();
    const actorUuid = String(payload?.actorUuid || "").trim();
    const combat = combatId ? game.combats?.get(combatId) : null;
    if (!combat?.started) return { ok: false, error: "No active combat" };

    let actor = null;
    try {
      actor = await fromUuid(actorUuid);
    } catch (_) {
      actor = null;
    }
    if (!actor || actor.documentName !== "Actor") return { ok: false, error: "Invalid actor" };

    const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!requester.isGM && !actor.testUserPermission(requester, ownerLevel)) {
      return { ok: false, error: "Owner permission required" };
    }

    const movementId = String(payload?.movementId || "").trim();
    const tokenUuid = String(payload?.tokenUuid || "").trim();
    const transactionId = String(payload?.transactionId || "").trim();
    const combatEventId = String(payload?.combatEventId || "").trim();

    const hasMove = !!(movementId && tokenUuid);
    const hasTx = !!transactionId;
    const hasEvt = !!combatEventId;
    if (!hasMove && !hasTx && !hasEvt) return { ok: false, error: "Nothing to undo" };

    if (!hasEvt) return { ok: false, error: "Missing target event" };
    return this._undoActionByEventIdAsGM({
      combat,
      targetEventId: combatEventId,
      transactionId: hasTx ? transactionId : null,
      movementId: hasMove ? movementId : null,
      tokenUuid: hasMove ? tokenUuid : null,
      source: "chatJournal",
      skipMovementRevert: false,
    });
  }

  _collectUndoImpactFromTables(combat, targetEventId, { tokenUuid = null } = {}) {
    if (!combat || !targetEventId) return { affectedCount: 0, cascadeMoveEventIds: [] };
    const tables = _clone(combat.getFlag(MODULE_NS, FLAG_TABLES) || {});
    const hit = this._findActionWithContext(combat, targetEventId);
    if (!hit?.combatantId) return { affectedCount: 0, cascadeMoveEventIds: [] };
    const list = Array.isArray(tables?.[hit.combatantId]) ? tables[hit.combatantId].slice() : [];
    list.sort((a, b) => {
      const ra = _num(a?.round, 0);
      const rb = _num(b?.round, 0);
      if (ra !== rb) return ra - rb;
      const sa = _num(a?.turnStartIndex, 0);
      const sb = _num(b?.turnStartIndex, 0);
      if (sa !== sb) return sa - sb;
      return String(a?.openedAt || "").localeCompare(String(b?.openedAt || ""));
    });
    const all = [];
    for (const table of list) {
      const actions = Array.isArray(table?.actions) ? table.actions : [];
      for (const a of actions) {
        if (!a || a.ignored || a.replacedBy) continue;
        all.push(a);
      }
    }
    const idx = all.findIndex((a) => String(a?.id) === String(targetEventId));
    if (idx < 0) return { affectedCount: 0, cascadeMoveEventIds: [] };
    const impacted = all.slice(idx + 1);
    const wantedToken = String(tokenUuid || hit?.action?.payload?.tokenUuid || "").trim();
    const cascadeMoveEventIds = impacted
      .filter((a) => String(a?.type) === "move")
      .filter((a) => {
        if (!wantedToken) return true;
        return String(a?.payload?.tokenUuid || "").trim() === wantedToken;
      })
      .map((a) => String(a?.id || ""))
      .filter(Boolean);
    return {
      affectedCount: impacted.length,
      cascadeMoveEventIds,
    };
  }

  async _computeJournalUndoPreviewAsGM(payload, userId) {
    const requester = game.users?.get(String(userId || "")) || null;
    if (!requester) return { ok: false, error: "Unknown user" };
    const combatId = String(payload?.combatId || "").trim();
    const targetEventId = String(payload?.targetEventId || "").trim();
    const combat = combatId ? game.combats?.get(combatId) : null;
    if (!combat?.started || !targetEventId) return { ok: false, error: "Missing combat or target" };

    const hit = this._findActionWithContext(combat, targetEventId);
    if (!hit?.action) return { ok: false, error: "Action not found" };
    const actorId = String(hit?.action?.payload?.actorId || hit?.action?.payload?.actor?.id || "").trim();
    const actor = actorId ? game.actors?.get(actorId) : (combat.combatants?.get(hit.combatantId)?.actor || null);
    const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (actor && !requester.isGM && !actor.testUserPermission(requester, ownerLevel)) {
      return { ok: false, error: "Owner permission required" };
    }

    const impact = this._collectUndoImpactFromTables(combat, targetEventId, {
      tokenUuid: payload?.tokenUuid || null,
    });
    return {
      ok: true,
      targetEventId,
      affectedCount: Math.max(0, _num(impact.affectedCount, 0)),
      cascadeMoveEventIds: Array.isArray(impact.cascadeMoveEventIds) ? impact.cascadeMoveEventIds : [],
    };
  }

  async setCombatantSide({ combatId, combatantId, sideId, viaSocket = false } = {}) {
    const combat = game.combats?.get(combatId || game.combat?.id) || null;
    if (!combat || !combatantId || !sideId) return false;
    if (!game.user?.isGM && !viaSocket) {
      await this._requestViaSocket("setSide", { combatId: combat.id, combatantId, sideId });
      return true;
    }
    const combatant = combat.combatants?.get(combatantId) || null;
    if (!combatant) return false;
    await combatant.setFlag(MODULE_NS, "combatSide", String(sideId));
    const state = (await this._ensureCombatState(combat)) || {};
    const sides = Array.isArray(state.sides) ? state.sides.slice() : [];
    if (!sides.some((s) => s?.id === sideId)) sides.push({ id: String(sideId), label: String(sideId) });
    state.sides = sides;
    if (game.user?.isGM) await combat.setFlag(MODULE_NS, FLAG_STATE, state);
    await this.appendEvent({
      eventId: _randomId(),
      combatId: combat.id,
      type: "combat.sideChanged",
      combatant: { id: combatant.id },
      data: { sideId: String(sideId) },
      effects: [{ kind: "combatantFlag", combatantId: combatant.id, key: "combatSide", value: String(sideId) }],
      inverse: [],
    });
    return true;
  }

  async _getCombatantSide(combatant) {
    const explicit = String(combatant?.getFlag(MODULE_NS, "combatSide") || "").trim();
    if (explicit) return explicit;
    return this._defaultSideForCombatant(combatant);
  }

  async _nextSideId(combat, state, overrideSideId = null) {
    if (overrideSideId) return String(overrideSideId);
    const sorted = this._sortedUniqueSideIds(combat);
    if (!sorted.length) return state.currentSide || "disp:friendly";
    const current = String(state.currentSide || sorted[0]);
    let idx = sorted.indexOf(current);
    if (idx < 0) idx = 0;
    for (let step = 1; step <= sorted.length; step++) {
      const j = (idx + step) % sorted.length;
      const cand = sorted[j];
      if (await this._sideHasRemainingStarters(combat, state, cand)) return cand;
    }
    return sorted[(idx + 1) % sorted.length];
  }

  async endTurn({ combatId, overrideSideId = null, viaSocket = false } = {}) {
    const combat = game.combats?.get(combatId || game.combat?.id) || null;
    if (!combat) return { ok: false };
    if (!game.user?.isGM && !viaSocket) {
      return this._requestViaSocket("endTurn", { combatId: combat.id, overrideSideId });
    }
    const state = (await this._ensureCombatState(combat)) || {};
    const prevCombatantId = state.activeTurn?.combatantId || null;
    const roundExhausted =
      (combat.combatants?.contents || []).length > 0 && !this._hasRemainingTurns(combat, state);
    state.lastSide = state.currentSide || null;
    state.currentSide = await this._nextSideId(combat, state, overrideSideId);
    state.activeTurn = null;
    state.turnPick = null;

    const nextSideForEvent = state.currentSide;

    await this.appendEvent({
      eventId: _randomId(),
      combatId: combat.id,
      type: "turn.end",
      combatant: { id: prevCombatantId },
      context: { nextSide: nextSideForEvent },
      data: { overrideSideId: overrideSideId || null },
      effects: [],
      inverse: [],
    });

    if (roundExhausted) {
      if (game.user?.isGM) {
        await this._flushRoundBoundary(combat, { bumpLogicalRound: true });
        try {
          await combat.update({ turn: 0 });
        } catch (_) {
          // optional: core may reject if unchanged
        }
      }
      const stateAfter = (await this._ensureCombatState(combat)) || {};
      ui.combat?.render?.(false);
      Hooks.callAll("spaceholder.combatTurnPickMode", combat, {
        sideId: stateAfter.currentSide,
        turnPick: stateAfter.turnPick,
      });
      return { ok: true, nextSide: stateAfter.currentSide, advancedRound: true };
    }

    await this._applyTurnPickForCurrentSide(combat, state);
    if (game.user?.isGM) await combat.setFlag(MODULE_NS, FLAG_STATE, state);
    ui.combat?.render?.(false);
    Hooks.callAll("spaceholder.combatTurnPickMode", combat, { sideId: state.currentSide, turnPick: state.turnPick });
    return { ok: true, nextSide: state.currentSide };
  }

  /**
   * Resolve turn pick: GM may pick any eligible combatant on the active side; players only their owned token.
   * @param {{ combatId?: string, combatantId?: string, viaSocket?: boolean }} opts
   */
  async pickTurn({ combatId, combatantId, viaSocket = false } = {}) {
    const combat = game.combats?.get(combatId || game.combat?.id) || null;
    if (!combat || !combatantId) return { ok: false, error: "Missing combat or combatant" };
    if (!game.user?.isGM && !viaSocket) {
      try {
        return await this._requestViaSocket("pickTurn", { combatId: combat.id, combatantId });
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    }
    return this._pickTurnAsRequestingUser(combat.id, combatantId, game.user?.id);
  }

  async _pickTurnAsRequestingUser(combatId, combatantId, requesterUserId) {
    const combat = game.combats?.get(combatId) || null;
    if (!combat || !combatantId) return { ok: false, error: "Missing combat or combatant" };
    const requester = game.users?.get(String(requesterUserId || "")) || null;
    if (!requester) return { ok: false, error: "Unknown user" };

    const state = (await this._ensureCombatState(combat)) || {};
    const tp = state.turnPick;
    if (!tp?.active || !Array.isArray(tp.eligibleCombatantIds) || !tp.eligibleCombatantIds.includes(combatantId)) {
      return { ok: false, error: "No active turn pick for that combatant" };
    }
    const combatant = combat.combatants?.get(combatantId) || null;
    if (!combatant) return { ok: false, error: "Combatant not found" };
    const side = await this._getCombatantSide(combatant);
    if (side !== String(state.currentSide || "")) return { ok: false, error: "Wrong side" };

    const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!requester.isGM) {
      const tokenDoc = combatant.token?.document || combatant.token;
      if (!tokenDoc?.testUserPermission?.(requester, ownerLevel)) {
        return { ok: false, error: "Owner permission required" };
      }
    }

    state.turnPick = null;
    await this._applyOfficialTurnStart(combat, state, combatantId, "pick");
    if (game.user?.isGM) await combat.setFlag(MODULE_NS, FLAG_STATE, state);
    const picked = combat.combatants?.get(combatantId) || null;
    if (picked?.actor?.type === "character" && game.user?.isGM) {
      try {
        await refreshApPool(picked.actor, {
          combatId: combat.id,
          combatantId,
          source: { type: "officialTurnPick" },
        });
        await ensureCombatActionJournalMessage({
          actor: picked.actor,
          combat,
          combatant: picked,
          withStartLine: true,
        });
      } catch (e) {
        console.error("SpaceHolder | refreshApPool on turn pick failed", e);
      }
    }
    ui.combat?.render?.(false);
    Hooks.callAll("spaceholder.combatTurnPicked", combat, { combatantId });
    Hooks.callAll("spaceholder.combatTurnPickMode", combat, { sideId: state.currentSide, turnPick: state.turnPick });
    return { ok: true };
  }

  getCombatSideColor(sideId) {
    return this._getSideColor(sideId);
  }

  getTurnSegmentsForCombatant(combat, combatantId) {
    const combatant = combat?.combatants?.get?.(combatantId) || null;
    if (!combatant) return { maxStarts: 1, started: 0, remaining: 1 };
    const st = combat?.getFlag?.(MODULE_NS, FLAG_STATE) || {};
    const maxStarts = this._getMaxTurnStarts(combatant.actor);
    const started = this._getStartedTurnsForCombatant(st, combatantId);
    const remaining = Math.max(0, maxStarts - started);
    return { maxStarts, started, remaining };
  }

  _sumTableSpent(table) {
    const actions = Array.isArray(table?.actions) ? table.actions : [];
    let total = 0;
    for (const a of actions) {
      if (!a || a.ignored || a.replacedBy) continue;
      total += _num(a.apCost, 0);
    }
    return total;
  }

  async _pushActionToTable(combat, event) {
    const combatantId = String(event?.combatant?.id || "").trim();
    if (!combatantId) return;
    const state = (await this._ensureCombatState(combat)) || {};
    const round = Math.max(1, _num(event?.context?.round, state.round || 1));
    const rawTsi = event?.context?.turnStartIndex;
    const turnStartIndex =
      rawTsi !== undefined && rawTsi !== null
        ? Math.max(0, Math.floor(_num(rawTsi, 0)))
        : Math.max(1, this._getStartedTurnsForCombatant(state, combatantId) || 1);
    const tableId = `${combatantId}:round:${round}:start:${turnStartIndex}`;
    const allTables = _clone(combat.getFlag(MODULE_NS, FLAG_TABLES) || {});
    allTables[combatantId] = Array.isArray(allTables[combatantId]) ? allTables[combatantId] : [];
    let table = allTables[combatantId].find((t) => String(t?.id) === tableId);
    if (!table) {
      table = { id: tableId, combatantId, round, turnStartIndex, openedAt: _nowIso(), actions: [] };
      allTables[combatantId].push(table);
    }
    table.actions.push({
      id: event.eventId,
      type: event.type,
      apCost: _num(event?.data?.apCost, 0),
      baseApCost: _num(event?.data?.baseApCost, _num(event?.data?.apCost, 0)),
      forced: !!event?.data?.forced,
      ignored: false,
      movementId: event?.data?.movementId || null,
      createdAt: _nowIso(),
      payload: event?.data || {},
    });
    table.spent = this._sumTableSpent(table);
    if (game.user?.isGM) await combat.setFlag(MODULE_NS, FLAG_TABLES, allTables);
    ui.combat?.render?.(false);
  }

  async _applyEventToRuntime(combat, event) {
    if (!combat || !event) return;
    if (event.type === "action" || event.type === "move") {
      await this._pushActionToTable(combat, event);
      return;
    }
    if (event.type === "move.forced") {
      await this._markActionForced(combat, event?.data?.targetEventId);
      return;
    }
    if (event.type === "move.forced.clear") {
      await this._unmarkActionForced(combat, event?.data?.targetEventId);
      return;
    }
    if (event.type === "action.undo") {
      await this._markActionIgnored(combat, event?.data?.targetEventId);
    }
  }

  _findActionByEventId(combat, targetEventId) {
    if (!combat || !targetEventId) return null;
    const tables = combat.getFlag(MODULE_NS, FLAG_TABLES) || {};
    for (const combatantId of Object.keys(tables)) {
      for (const table of tables[combatantId] || []) {
        const action = (table.actions || []).find((a) => String(a.id) === String(targetEventId));
        if (action) return action;
      }
    }
    return null;
  }

  async _markActionForced(combat, targetEventId) {
    if (!targetEventId) return;
    const allTables = _clone(combat.getFlag(MODULE_NS, FLAG_TABLES) || {});
    for (const combatantId of Object.keys(allTables)) {
      for (const table of allTables[combatantId] || []) {
        const action = (table.actions || []).find((a) => String(a.id) === String(targetEventId));
        if (!action) continue;
        action.forced = true;
        action.apCost = 0;
        table.spent = this._sumTableSpent(table);
      }
    }
    if (game.user?.isGM) await combat.setFlag(MODULE_NS, FLAG_TABLES, allTables);
    ui.combat?.render?.(false);
  }

  async _unmarkActionForced(combat, targetEventId) {
    if (!targetEventId) return;
    const allTables = _clone(combat.getFlag(MODULE_NS, FLAG_TABLES) || {});
    for (const combatantId of Object.keys(allTables)) {
      for (const table of allTables[combatantId] || []) {
        const action = (table.actions || []).find((a) => String(a.id) === String(targetEventId));
        if (!action) continue;
        if (String(action.type || "") !== "move") continue;
        action.forced = false;
        const rawBase = _num(action.baseApCost, _num(action.payload?.baseApCost, 0));
        const combatant = combat.combatants?.get(combatantId) || null;
        const actor = combatant?.actor || null;
        action.apCost = actor
          ? getEffectiveActionCost(actor, rawBase)
          : Math.max(0, Math.floor(_num(rawBase, 0)));
        table.spent = this._sumTableSpent(table);
      }
    }
    if (game.user?.isGM) await combat.setFlag(MODULE_NS, FLAG_TABLES, allTables);
    ui.combat?.render?.(false);
  }

  async _markActionIgnored(combat, targetEventId) {
    if (!targetEventId) return;
    const allTables = _clone(combat.getFlag(MODULE_NS, FLAG_TABLES) || {});
    for (const combatantId of Object.keys(allTables)) {
      for (const table of allTables[combatantId] || []) {
        const action = (table.actions || []).find((a) => String(a.id) === String(targetEventId));
        if (!action) continue;
        action.ignored = true;
        table.spent = this._sumTableSpent(table);
      }
    }
    if (game.user?.isGM) await combat.setFlag(MODULE_NS, FLAG_TABLES, allTables);
  }

  async getCombatantCurrentTable(combat, combatantId) {
    if (!combat || !combatantId) return null;
    const state = (await this._ensureCombatState(combat)) || {};
    return this._resolveDisplayTableForCombatant(combat, state, combatantId);
  }

  async getCombatantSpentThisRound(combat, combatantId) {
    const table = await this.getCombatantCurrentTable(combat, combatantId);
    return _num(table?.spent, 0);
  }

  async logAction({ combat, actor, combatant, type = "action", baseApCost = 0, apCost = 0, data = {}, effects = [], inverse = [] } = {}) {
    if (!combat || !combatant) return { ok: false };
    const state = (await this._ensureCombatState(combat)) || {};
    const inOfficial = state.activeTurn?.combatantId === combatant.id;
    const turnStartIndex = inOfficial
      ? Math.max(1, this._getStartedTurnsForCombatant(state, combatant.id))
      : 0;
    const payload = {
      eventId: _randomId(),
      combatId: combat.id,
      type,
      actor: { id: actor?.id || null, uuid: actor?.uuid || null },
      combatant: { id: combatant.id, tokenUuid: combatant.token?.uuid || combatant.tokenUuid || null },
      context: {
        round: Math.max(1, _num(state.round, 1)),
        side: state.currentSide || null,
        turnStartIndex,
      },
      data: { ...data, baseApCost, apCost, offTurn: !inOfficial },
      effects,
      inverse,
    };
    return this.appendEvent(payload);
  }

  async logMovement({
    combat,
    actor,
    combatant,
    tokenDoc,
    movementId,
    distance = 0,
    apCost = 0,
    baseApCost = 0,
    from = null,
    to = null,
    transactionId = null,
    isReaction = false,
    anchorCombatantId = null,
    reactionOfEventId = null,
  } = {}) {
    const effects = [];
    const inverse = [];
    if (tokenDoc?.uuid && from && to) {
      effects.push({
        kind: "tokenMove",
        tokenUuid: tokenDoc.uuid,
        from,
        to,
      });
      inverse.push({
        kind: "tokenMove",
        tokenUuid: tokenDoc.uuid,
        from: to,
        to: from,
      });
    }
    return this.logAction({
      combat,
      actor,
      combatant,
      type: "move",
      baseApCost,
      apCost,
      data: {
        movementId,
        distance,
        forced: false,
        tokenUuid: tokenDoc?.uuid || null,
        from,
        to,
        transactionId,
        isReaction: !!isReaction,
        anchorCombatantId: anchorCombatantId ? String(anchorCombatantId) : null,
        reactionOfEventId: reactionOfEventId ? String(reactionOfEventId) : null,
      },
      effects,
      inverse,
    });
  }

  async markMovementForced({ combatId, targetEventId } = {}) {
    const combat = game.combats?.get(combatId || game.combat?.id) || null;
    if (!combat || !targetEventId) return false;
    await this.appendEvent({
      eventId: _randomId(),
      combatId: combat.id,
      type: "move.forced",
      data: { targetEventId },
      effects: [],
      inverse: [],
    });
    return true;
  }

  /**
   * Toggle forced-movement flag for a table row (minus = mark forced, plus = clear).
   */
  async toggleMovementForced({ combatId, targetEventId } = {}) {
    const combat = game.combats?.get(combatId || game.combat?.id) || null;
    if (!combat || !targetEventId) return false;
    const action = this._findActionByEventId(combat, targetEventId);
    if (!action || String(action.type || "") !== "move" || action.ignored || action.replacedBy) return false;
    if (action.forced) {
      await this.appendEvent({
        eventId: _randomId(),
        combatId: combat.id,
        type: "move.forced.clear",
        data: { targetEventId },
        effects: [],
        inverse: [],
      });
    } else {
      await this.markMovementForced({ combatId: combat.id, targetEventId });
    }
    return true;
  }

  _findActionWithContext(combat, targetEventId) {
    if (!combat || !targetEventId) return null;
    const tables = _clone(combat.getFlag(MODULE_NS, FLAG_TABLES) || {});
    for (const combatantId of Object.keys(tables)) {
      for (const table of tables[combatantId] || []) {
        const idx = (table.actions || []).findIndex((a) => String(a?.id) === String(targetEventId));
        if (idx < 0) continue;
        const action = table.actions[idx];
        return { action, table, combatantId, index: idx };
      }
    }
    return null;
  }

  async _undoActionByEventIdAsGM({
    combat,
    targetEventId,
    transactionId = null,
    movementId = null,
    tokenUuid = null,
    source = "combat",
    skipMovementRevert = false,
  } = {}) {
    if (!combat?.started || !targetEventId) return { ok: false, error: "Missing target" };
    const hit = this._findActionWithContext(combat, targetEventId);
    if (!hit?.action || hit.action.ignored || hit.action.replacedBy) {
      return { ok: false, error: "Action not found" };
    }
    const action = hit.action;
    const payload = action?.payload && typeof action.payload === "object" ? action.payload : {};
    const txId = String(transactionId || payload.transactionId || "").trim();
    const moveId = String(movementId || action.movementId || payload.movementId || "").trim();
    const tokUuid = String(tokenUuid || payload.tokenUuid || "").trim();

    if (!skipMovementRevert && String(action.type || "") === "move" && moveId && tokUuid) {
      let tokenDoc = null;
      try {
        tokenDoc = await fromUuid(tokUuid);
      } catch (_) {
        tokenDoc = null;
      }
      if (tokenDoc?.documentName === "Token" && typeof tokenDoc.revertRecordedMovement === "function") {
        await tokenDoc.revertRecordedMovement(moveId);
      }
    }

    if (txId) {
      const { undoTransaction } = await import("../actions/transaction-ledger.mjs");
      const r = await undoTransaction({ transactionId: txId, combat });
      if (!r.ok && String(r?.error || "") !== "Already undone") {
        return r;
      }
    }

    await this.appendEvent({
      eventId: _randomId(),
      combatId: combat.id,
      type: "action.undo",
      data: {
        targetEventId: String(targetEventId),
        source: String(source || "combat"),
        transactionId: txId || null,
        movementId: moveId || null,
        tokenUuid: tokUuid || null,
      },
      effects: [],
      inverse: [],
    });
    return { ok: true, targetEventId: String(targetEventId) };
  }

  async undoLastAction({ combatId, combatantId, viaSocket = false } = {}) {
    const combat = game.combats?.get(combatId || game.combat?.id) || null;
    if (!combat) return { ok: false };
    if (!game.user?.isGM && !viaSocket) {
      return this._requestViaSocket("undoLastAction", { combatId: combat.id, combatantId });
    }

    const tables = _clone(combat.getFlag(MODULE_NS, FLAG_TABLES) || {});
    const ids = combatantId ? [combatantId] : Object.keys(tables);
    let target = null;
    for (const cid of ids) {
      const list = Array.isArray(tables[cid]) ? tables[cid] : [];
      for (let i = list.length - 1; i >= 0; i--) {
        const actions = Array.isArray(list[i]?.actions) ? list[i].actions : [];
        for (let j = actions.length - 1; j >= 0; j--) {
          const action = actions[j];
          if (!action || action.ignored || action.replacedBy) continue;
          target = action;
          break;
        }
        if (target) break;
      }
      if (target) break;
    }
    if (!target) return { ok: false };
    return this._undoActionByEventIdAsGM({
      combat,
      targetEventId: target.id,
      source: "undoLastAction",
    });
  }

  async _onHistoryUndo() {
    try {
      const combat = game?.combat?.started ? game.combat : null;
      if (!combat) return;
      if (this._manualUndoMarker && (Date.now() - _num(this._manualUndoMarker.at, 0) < 2000)) {
        const marker = this._manualUndoMarker;
        this._manualUndoMarker = null;
        if (marker?.targetEventId) {
          await this.appendEvent({
            eventId: _randomId(),
            combatId: combat.id,
            type: 'action.undo',
            data: { targetEventId: marker.targetEventId, source: 'historyUndo-manual' },
            effects: [],
            inverse: [],
          });
          return;
        }
      }
      const controlled = canvas?.tokens?.controlled?.[0]?.document ?? null;
      const tokenUuid = controlled?.uuid || null;
      const tables = _clone(combat.getFlag(MODULE_NS, FLAG_TABLES) || {});
      let targetEventId = null;
      for (const combatantId of Object.keys(tables)) {
        const list = Array.isArray(tables[combatantId]) ? tables[combatantId] : [];
        for (let i = list.length - 1; i >= 0; i--) {
          const actions = Array.isArray(list[i]?.actions) ? list[i].actions : [];
          for (let j = actions.length - 1; j >= 0; j--) {
            const a = actions[j];
            if (!a || a.ignored || a.replacedBy) continue;
            if (a.type !== 'move') continue;
            if (tokenUuid && String(a?.payload?.tokenUuid || '') !== String(tokenUuid)) continue;
            targetEventId = String(a.id);
            break;
          }
          if (targetEventId) break;
        }
        if (targetEventId) break;
      }
      if (!targetEventId) return;
      await this._undoActionByEventIdAsGM({
        combat,
        targetEventId,
        source: "historyUndo",
        skipMovementRevert: true,
      });
    } catch (e) {
      console.error('SpaceHolder | historyUndo sync failed', e);
    }
  }

  async _onHistoryRedo() {
    // Reserved hook for future re-apply mapping.
  }

  async _invokeCoreUndoForMovement(tokenUuid = null) {
    const hasCanvasHistoryUndo = typeof canvas?.history?.undo === 'function';
    const hasCanvasUndoHistory = typeof canvas?.undoHistory === 'function';
    const hasSceneUndoHistory = typeof canvas?.scene?.undoHistory === 'function';
    const hasKeyboardUndoBinding = !!game?.keybindings?.bindings?.get?.("core.undo");
    if (hasCanvasHistoryUndo) {
      await canvas.history.undo();
      return true;
    }
    if (hasCanvasUndoHistory) {
      await canvas.undoHistory();
      return true;
    }
    if (hasSceneUndoHistory) {
      await canvas.scene.undoHistory();
      return true;
    }
    return false;
  }

  async syncUndoFromTokenUpdate({ combatId, tokenUuid, movementId = null } = {}) {
    try {
      const combat = game.combats?.get(combatId || game.combat?.id) || null;
      if (!combat || !tokenUuid) return false;
      const tables = _clone(combat.getFlag(MODULE_NS, FLAG_TABLES) || {});
      let targetEventId = null;
      for (const combatantId of Object.keys(tables)) {
        const list = Array.isArray(tables[combatantId]) ? tables[combatantId] : [];
        for (let i = list.length - 1; i >= 0; i--) {
          const actions = Array.isArray(list[i]?.actions) ? list[i].actions : [];
          for (let j = actions.length - 1; j >= 0; j--) {
            const a = actions[j];
            if (!a || a.ignored || a.replacedBy) continue;
            if (a.type !== "move") continue;
            if (String(a?.payload?.tokenUuid || "") !== String(tokenUuid)) continue;
            targetEventId = String(a.id || "");
            break;
          }
          if (targetEventId) break;
        }
        if (targetEventId) break;
      }
      if (!targetEventId) return false;
      await this._undoActionByEventIdAsGM({
        combat,
        targetEventId,
        tokenUuid,
        movementId: movementId || null,
        source: "token-update-undo",
        skipMovementRevert: true,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  _formatSideLabel(sideId) {
    const raw = String(sideId || "");
    if (raw.startsWith("disp:")) {
      const key = raw.slice(5);
      return game.i18n?.localize?.(`SPACEHOLDER.Combat.Side.${key}`) || key;
    }
    const parts = raw.split(".");
    if (parts[0] === "Actor" && parts[1] && parts.length === 2) {
      const actor = game?.actors?.get?.(parts[1]) || null;
      if (actor?.type === "faction" && actor?.name) return actor.name;
    }
    return raw;
  }

  _getSideColor(sideId) {
    const raw = String(sideId || "");
    if (raw === "disp:friendly") return "#53cf7a";
    if (raw === "disp:neutral") return "#c7b15d";
    if (raw === "disp:hostile") return "#d46262";
    if (raw === "disp:secret") return "#8c7bd6";

    const parts = raw.split(".");
    if (parts[0] === "Actor" && parts[1] && parts.length === 2) {
      const actor = game?.actors?.get?.(parts[1]) || null;
      const c = String(actor?.system?.fColor || "").trim();
      if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
    }

    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) - hash) + raw.charCodeAt(i);
      hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue} 55% 55%)`;
  }

  async _onRenderCombatTracker(app, html) {
    try {
      const combat = app?.viewed || game.combat || null;
      const host = html?.querySelector ? html : (html?.[0] ?? null);
      if (!combat?.started || !host) return;
      const state = (await this._ensureCombatState(combat)) || {};
      this._hideInitiativeControls(host);
      this._injectCombatControls(host, combat.id);
      await this._groupCombatantsIntoSideFolders(host, combat, state);
      await this._decorateCombatantRows(host, combat, state);
      this._injectActionTable(host, combat, state);
      this._syncCombatTrackerCoreActiveRow(host, state);
    } catch (e) {
      console.error("SpaceHolder | renderCombatTracker panel failed", e);
    }
  }

  _onGetCombatTrackerEntryContext(_html, options) {
    if (!Array.isArray(options)) return;
    const readCombatantId = (li) => {
      const el = li?.jquery ? li[0] : li;
      const fromDataset = String(el?.dataset?.combatantId || "").trim();
      if (fromDataset) return fromDataset;
      const fromAttr = String(li?.attr?.("data-combatant-id") || "").trim();
      return fromAttr;
    };
    const title = game.i18n?.localize?.("SPACEHOLDER.Combat.ChangeSide") || "Change side";
    options.push({
      name: title,
      icon: '<i class="fa-solid fa-people-arrows"></i>',
      condition: (li) => {
        const cId = readCombatantId(li);
        return !!cId;
      },
      callback: async (li) => {
        const combatantId = readCombatantId(li);
        if (!combatantId) return;
        const combatId = String(game.combat?.id || "").trim();
        if (!combatId) return;
        await this.openChangeSideDialog({ combatId, combatantId });
      },
    });
  }

  _registerCombatContextHooks() {
    const candidates = [
      "getCombatTrackerEntryContext",
      "getCombatTrackerEntryContextOptions",
      "getCombatTrackerContextOptions",
      "getCombatantEntryContext",
      "getCombatantEntryContextOptions",
    ];
    this._registeredContextHooks = [];
    for (const hookName of candidates) {
      const fn = (...args) => {
        const options = args.find((a) => Array.isArray(a));
        const htmlLike = args.find((a) => a && !Array.isArray(a));
        return this._onGetCombatTrackerEntryContext(htmlLike, options);
      };
      Hooks.on(hookName, fn);
      this._registeredContextHooks.push(hookName);
    }
  }

  /**
   * Core CombatTracker marks `li.combatant.active` from `combat.turn` (initiative index).
   * We use popcorn + `flags.spaceholder.combatState.activeTurn`, and often set `turn: 0`, so the first
   * row stays falsely "active". Reconcile highlight to match our active combatant only.
   */
  _syncCombatTrackerCoreActiveRow(host, state) {
    const activeId = String(state?.activeTurn?.combatantId || "").trim();
    const rows = host.querySelectorAll("li.combatant[data-combatant-id]");
    for (const row of rows) {
      const id = String(row.dataset.combatantId || "").trim();
      const isActive = !!activeId && id === activeId;
      row.classList.toggle("active", isActive);
      if (isActive) row.setAttribute("aria-current", "step");
      else row.removeAttribute("aria-current");
    }
  }

  _getUiSelectedCombatantId(combatId) {
    return String(this._uiSelectedCombatantByCombat.get(String(combatId || "")) || "").trim() || null;
  }

  _setUiSelectedCombatantId(combatId, combatantId) {
    const cid = String(combatId || "").trim();
    const bid = String(combatantId || "").trim();
    if (!cid) return;
    if (!bid) this._uiSelectedCombatantByCombat.delete(cid);
    else this._uiSelectedCombatantByCombat.set(cid, bid);
  }

  _injectActionTable(host, combat, state) {
    const list = host.querySelector('ol.combat-tracker[data-application-part="tracker"]') || host.querySelector("ol.combat-tracker");
    if (!list) return;

    // Bind selection handlers (per-client, no GM flag writes).
    const rows = list.querySelectorAll('li.combatant[data-combatant-id]');
    for (const row of rows) {
      if (row.dataset.shSelectBound === "1") continue;
      row.dataset.shSelectBound = "1";
      row.addEventListener("click", (ev) => {
        // Avoid hijacking core controls and custom buttons.
        const target = ev.target;
        if (target?.closest?.("button,a,.combatant-control,.inline-control")) return;
        const id = String(row.dataset.combatantId || "").trim();
        if (!id) return;
        this._setUiSelectedCombatantId(combat.id, id);
        ui.combat?.render?.(false);
      });
    }

    host.querySelector(".spaceholder-action-table-host")?.remove();
    list.querySelector(":scope > li.spaceholder-action-table-row")?.remove();
    const box = document.createElement("div");
    box.className = "spaceholder-action-table-host";
    box.dataset.combatId = combat.id;

    const selectedId =
      this._getUiSelectedCombatantId(combat.id) ||
      String(state?.activeTurn?.combatantId || "").trim() ||
      String(combat.combatant?.id || combat.current?.combatantId || "").trim() ||
      String(combat.combatants?.contents?.[0]?.id || "").trim() ||
      null;

    box.innerHTML = this._renderActionTableHtml({ combat, state, combatantId: selectedId });
    list.insertAdjacentElement("afterend", box);

    box.querySelectorAll('[data-action="sh-combat-toggle-forced"]').forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const targetEventId = String(btn.dataset.eventId || "").trim();
        if (!targetEventId) return;
        await this.toggleMovementForced({ combatId: combat.id, targetEventId });
      });
    });
  }

  _renderActionTableHtml({ combat, state, combatantId } = {}) {
    const actionTableFallback = game.i18n?.localize?.("SPACEHOLDER.Combat.ActionTable") || "Action table";
    const none = game.i18n?.localize?.("SPACEHOLDER.Combat.NoActions") || "No actions";
    const rowMoveLabel = game.i18n?.localize?.("SPACEHOLDER.Combat.RowMove") || "Move";
    const rowActionLabel = game.i18n?.localize?.("SPACEHOLDER.Combat.RowAction") || "Action";
    const forceTitleOff = game.i18n?.localize?.("SPACEHOLDER.Combat.ForceMoveToggleOn") || "Forced movement — does not spend AP";
    const forceTitleOn = game.i18n?.localize?.("SPACEHOLDER.Combat.ForceMoveToggleOff") || "Cancel forced — restore AP cost";
    const round = this._displayRound(combat, state);

    const combatant = combatantId ? combat?.combatants?.get?.(combatantId) : null;
    const name = String(combatant?.name || "").trim();
    const headerTitle = combatantId && combatant ? (name || actionTableFallback) : actionTableFallback;
    const titleIcon = combatantId && combatant ? "fa-user" : "fa-clipboard-list";
    const table = combatantId ? this._resolveDisplayTableForCombatant(combat, state, combatantId) : null;

    const actions = Array.isArray(table?.actions) ? table.actions : [];
    const visible = actions.filter((a) => a && !a.ignored && !a.replacedBy);

    const maxAp = this._computeMaxAp(combatant?.actor);
    const spent = _num(table?.spent, this._sumTableSpent(table));
    const remain = maxAp - spent;

    const header = `
      <div class="spaceholder-action-table__header">
        <div class="spaceholder-action-table__title-wrap">
          <i class="fa-solid ${titleIcon} spaceholder-action-table__title-icon" aria-hidden="true"></i>
          <span class="spaceholder-action-table__title">${foundry.utils.escapeHTML(headerTitle)}</span>
        </div>
        <div class="spaceholder-action-table__meta">
          <span class="spaceholder-badge">R${round}</span>
          <span class="spaceholder-badge ap">AP ${remain}/${maxAp}</span>
        </div>
      </div>
    `;

    const wrap = (bodyHtml) => `<div class="spaceholder-action-table">${header}<div class="spaceholder-action-table__body">${bodyHtml}</div></div>`;

    if (!combatantId || !combatant) {
      return wrap(`<div class="spaceholder-action-table__empty"><i class="fa-solid fa-clipboard-list" aria-hidden="true"></i><span>${foundry.utils.escapeHTML(none)}</span></div>`);
    }

    if (!visible.length) {
      return wrap(`<div class="spaceholder-action-table__empty"><i class="fa-solid fa-clipboard-list" aria-hidden="true"></i><span>${foundry.utils.escapeHTML(none)}</span></div>`);
    }

    const rows = visible.map((a) => {
      const type = String(a.type || "action");
      const isMove = type === "move";
      const ap = _num(a.apCost, 0);
      const base = _num(a.baseApCost, ap);
      const pl = a.payload && typeof a.payload === "object" ? a.payload : {};
      const actionName = String(pl.label ?? "").trim();
      const label = isMove ? rowMoveLabel : (actionName || rowActionLabel);
      const rowMod = isMove ? "move" : "action";
      const kindIcon = isMove ? "fa-shoe-prints" : "fa-bolt";
      const forced = !!a.forced;
      const forcedRowClass = isMove && forced ? " spaceholder-action-table__row--forced" : "";
      const toggleTitle = foundry.utils.escapeHTML(forced ? forceTitleOn : forceTitleOff);
      const toggleBtn = isMove
        ? `<button type="button" class="spaceholder-action-table__force-toggle${forced ? " is-forced" : ""}" data-action="sh-combat-toggle-forced" data-event-id="${foundry.utils.escapeHTML(String(a.id))}" title="${toggleTitle}" aria-pressed="${forced ? "true" : "false"}"><i class="fa-solid ${forced ? "fa-plus" : "fa-minus"}" aria-hidden="true"></i></button>`
        : "";

      return `
        <li class="spaceholder-action-table__row spaceholder-action-table__row--${rowMod}${forcedRowClass}">
          <span class="spaceholder-action-table__kind">
            <i class="fa-solid ${kindIcon} spaceholder-action-table__kind-icon" aria-hidden="true"></i>
            <span class="spaceholder-action-table__kind-text">${foundry.utils.escapeHTML(label)}</span>
          </span>
          <span class="spaceholder-action-table__cost" title="base ${base}"><span class="spaceholder-action-table__ap-chip">${ap}</span></span>
          <span class="spaceholder-action-table__tools">${toggleBtn}</span>
        </li>
      `;
    }).join("");

    return wrap(`<ol class="spaceholder-action-table__rows">${rows}</ol>`);
  }

  _hideInitiativeControls(host) {
    const selectors = [
      '[data-action="rollInitiative"]',
      '[data-control="rollInitiative"]',
      '.combatant-control.roll',
      '.inline-control[data-action="rollInitiative"]',
      '.inline-control[data-action="rollAll"]',
      '.inline-control[data-action="resetAll"]',
      '.inline-control[data-action="nextTurn"]',
      '.inline-control[data-action="previousTurn"]',
      '[data-action="nextRound"]',
      '[data-action="previousRound"]',
      '[data-control="nextRound"]',
      '[data-control="previousRound"]',
      '.token-initiative',
      '.initiative',
    ];
    for (const selector of selectors) {
      host.querySelectorAll(selector).forEach((el) => el.remove());
    }
  }

  _injectCombatControls(host, combatId) {
    const controls = host.querySelector(".combat-controls");
    if (!controls) return;
    controls.querySelector(".spaceholder-combat-controls")?.remove();
    const box = document.createElement("div");
    box.className = "spaceholder-combat-controls";
    box.innerHTML = `
      <button type="button" class="inline-control" data-action="sh-combat-end-turn">${game.i18n?.localize?.("SPACEHOLDER.Combat.EndTurn") || "End Turn"}</button>
    `;
    const firstCtrl = controls.firstElementChild;
    if (firstCtrl) controls.insertBefore(box, firstCtrl);
    else controls.appendChild(box);
    box.querySelector('[data-action="sh-combat-end-turn"]')?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await this.endTurn({ combatId });
    });
  }

  async _groupCombatantsIntoSideFolders(host, combat, state) {
    const list = host.querySelector("ol.combat-tracker");
    if (!list) return;
    const rows = Array.from(list.querySelectorAll(':scope > li.combatant[data-combatant-id]'));
    if (!rows.length) return;
    const buckets = new Map();
    for (const row of rows) {
      const combatantId = String(row.dataset.combatantId || "").trim();
      const combatant = combat.combatants?.get(combatantId) || null;
      const sideId = combatant ? await this._getCombatantSide(combatant) : "disp:neutral";
      if (!buckets.has(sideId)) buckets.set(sideId, []);
      buckets.get(sideId).push(row);
    }
    list.innerHTML = "";
    let draggingCombatantId = null;
    const activeCombatantId = String(state?.activeTurn?.combatantId || "").trim();
    const activeCombatant = activeCombatantId ? combat.combatants?.get(activeCombatantId) : null;
    let activeSideId = activeCombatant ? await this._getCombatantSide(activeCombatant) : null;
    if (!activeSideId && state?.turnPick?.active) {
      activeSideId = String(state.currentSide || "").trim() || null;
    }
    const nextSideId = activeSideId
      ? await this._nextSideId(combat, state, null)
      : String(state?.currentSide || "").trim() || null;
    const orderedSides = this._sortSideIds(buckets.keys());
    for (const sideId of orderedSides) {
      const sideRows = buckets.get(sideId) || [];
      const header = document.createElement("li");
      header.className = "spaceholder-side-folder";
      header.dataset.sideId = sideId;
      const sideLabel = this._formatSideLabel(sideId);
      const sideColor = this._getSideColor(sideId);
      let maxStartsSum = 0;
      let startedSum = 0;
      let activeInSide = false;
      for (const row of sideRows) {
        const cid = String(row.dataset.combatantId || "").trim();
        const c = combat.combatants?.get(cid) || null;
        if (!c) continue;
        maxStartsSum += this._getMaxTurnStarts(c.actor);
        startedSum += this._getStartedTurnsForCombatant(state, cid);
        if (String(state?.activeTurn?.combatantId || "") === cid) activeInSide = true;
      }
      header.style.setProperty("--spaceholder-side-color", sideColor);
      const sideStatus = sideId === activeSideId
        ? (game.i18n?.localize?.("SPACEHOLDER.Combat.SideNow") || "Ходит сейчас")
        : (sideId === nextSideId
          ? (game.i18n?.localize?.("SPACEHOLDER.Combat.SideNext") || "Следующая")
          : "");
      const sideStatusHtml = sideStatus
        ? `<span class="spaceholder-side-folder__status">${foundry.utils.escapeHTML(sideStatus)}</span>`
        : "";
      header.innerHTML = `
        <div class="spaceholder-side-folder__title" title="${foundry.utils.escapeHTML(sideLabel)}">${foundry.utils.escapeHTML(sideLabel)}</div>
        <div class="spaceholder-side-folder__tokens" aria-hidden="true">${this._renderTurnTokens({ maxStarts: maxStartsSum || 1, started: startedSum, active: activeInSide })}</div>
        ${sideStatusHtml}
      `;
      header.addEventListener("dragover", (ev) => ev.preventDefault());
      header.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        const cid = draggingCombatantId || String(ev.dataTransfer?.getData("text/plain") || "").trim();
        if (!cid) return;
        await this.setCombatantSide({ combatId: combat.id, combatantId: cid, sideId });
      });
      list.appendChild(header);
      for (const row of sideRows) {
        row.dataset.sideId = sideId;
        row.style.setProperty("--spaceholder-side-color", sideColor);
        row.classList.add("spaceholder-combatant-row");
        row.draggable = true;
        row.addEventListener("dragstart", (ev) => {
          draggingCombatantId = String(row.dataset.combatantId || "").trim() || null;
          ev.dataTransfer?.setData("text/plain", draggingCombatantId || "");
        });
        list.appendChild(row);
      }
    }
  }

  _computeMaxAp(actor) {
    const dex = _num(actor?.system?.abilities?.dex?.value, 0);
    const intel = _num(actor?.system?.abilities?.int?.value, 0);
    return Math.max(0, Math.floor(dex * intel));
  }

  _getMaxTurnStarts(actor) {
    const raw = _num(actor?.system?.turnStarts, 1);
    return Math.max(1, Math.floor(raw));
  }

  _getStartedTurnsForCombatant(state, combatantId) {
    return Math.max(0, _num(state?.startedTurnsByCombatant?.[combatantId], 0));
  }

  /** Display round = logical round in `combatState` (core `Combat.round` is not advanced for SpaceHolder rounds). */
  _displayRound(_combat, state) {
    return Math.max(1, _num(state?.round, 1));
  }

  /**
   * Table used for AP in UI. Official turn: pool refreshes on pick (`started` increments). Until then, do not use
   * an empty current-round table (would look like full AP). Off-turn spend in the current round uses `start:0`.
   */
  _resolveDisplayTableForCombatant(combat, state, combatantId) {
    const displayRound = this._displayRound(combat, state);
    const tables = combat.getFlag(MODULE_NS, FLAG_TABLES) || {};
    const list = Array.isArray(tables?.[combatantId]) ? tables[combatantId] : [];
    const started = this._getStartedTurnsForCombatant(state, combatantId);

    const sortByStart = (a, b) => _num(a?.turnStartIndex, 0) - _num(b?.turnStartIndex, 0);

    if (started >= 1) {
      const candidates = list
        .filter((t) => _num(t?.round, 0) === displayRound)
        .slice()
        .sort(sortByStart);
      return candidates.findLast?.((t) => _num(t?.turnStartIndex, 0) === started) || null;
    }

    const curZero = list
      .filter((t) => _num(t?.round, 0) === displayRound && _num(t?.turnStartIndex, 0) === 0)
      .slice()
      .sort(sortByStart);
    const zLast = curZero.length ? curZero[curZero.length - 1] : null;
    const zSpent = zLast ? _num(zLast.spent, this._sumTableSpent(zLast)) : 0;
    const zActs = Array.isArray(zLast?.actions) ? zLast.actions.length : 0;
    if (zLast && (zSpent > 0 || zActs > 0)) return zLast;

    const prevRound = displayRound - 1;
    if (prevRound < 1) return null;

    const prevOfficial = list
      .filter((t) => _num(t?.round, 0) === prevRound && _num(t?.turnStartIndex, 0) >= 1)
      .slice()
      .sort(sortByStart);
    if (prevOfficial.length) return prevOfficial[prevOfficial.length - 1];

    const prevAny = list.filter((t) => _num(t?.round, 0) === prevRound).slice().sort(sortByStart);
    return prevAny.length ? prevAny[prevAny.length - 1] : null;
  }

  _hasRemainingTurns(combat, state) {
    const list = combat?.combatants?.contents || [];
    for (const c of list) {
      const maxStarts = this._getMaxTurnStarts(c.actor);
      const started = this._getStartedTurnsForCombatant(state, c.id);
      if (started < maxStarts) return true;
    }
    return false;
  }

  _renderTurnTokens({ maxStarts = 1, started = 0, active = false } = {}) {
    const max = Math.max(1, Math.floor(maxStarts));
    const used = Math.max(0, Math.min(max, Math.floor(started)));
    const remaining = Math.max(0, max - used);
    const parts = [];
    for (let i = 0; i < remaining; i++) {
      parts.push(`<span class="spaceholder-turn-token available" aria-hidden="true"></span>`);
    }
    if (active) {
      parts.push(`<span class="spaceholder-turn-token active" aria-hidden="true"></span>`);
    }
    return parts.join("");
  }

  async _decorateCombatantRows(host, combat, state) {
    const rows = host.querySelectorAll("li.combatant[data-combatant-id]");
    for (const row of rows) {
      row.querySelector(".spaceholder-combatant-indicators")?.remove();
      row.querySelector(".spaceholder-combatant-apline")?.remove();
      const combatantId = String(row.dataset.combatantId || "").trim();
      if (!combatantId) continue;
      const combatant = combat.combatants?.get(combatantId) || null;
      if (!combatant) continue;
      const sideId = String(row.dataset.sideId || await this._getCombatantSide(combatant));
      const sideColor = this._getSideColor(sideId);
      row.style.setProperty("--spaceholder-side-color", sideColor);
      const { value: remain, max: maxAp } = getStoredActionPoints(combatant.actor);
      const maxStarts = this._getMaxTurnStarts(combatant.actor);
      const started = this._getStartedTurnsForCombatant(state, combatantId);
      const active = String(state?.activeTurn?.combatantId || "") === combatantId;

      const tokenName = row.querySelector(".token-name") || row.querySelector("h4")?.parentElement || row;
      const apLine = document.createElement("div");
      apLine.className = "spaceholder-combatant-apline";
      apLine.innerHTML = `
        <span class="spaceholder-badge ap">AP ${remain}/${maxAp}</span>
      `;
      tokenName.appendChild(apLine);

      const indicators = document.createElement("div");
      indicators.className = "spaceholder-combatant-indicators";
      indicators.innerHTML = `
        <span class="spaceholder-turn-tokens" aria-hidden="true">${this._renderTurnTokens({ maxStarts, started, active })}</span>
      `;
      const right = row.querySelector(".combatant-controls") || row;
      right.appendChild(indicators);
    }
  }

  _injectCombatantRowButtons(html, combatId) {
    void html;
    void combatId;
    // Row buttons were intentionally removed to keep combat tracker clean.
  }

  _findLatestMovementEventId(combatId, combatantId) {
    const combat = game.combats?.get(combatId) || null;
    if (!combat || !combatantId) return null;
    const tables = combat.getFlag(MODULE_NS, FLAG_TABLES) || {};
    const list = Array.isArray(tables?.[combatantId]) ? tables[combatantId] : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const actions = Array.isArray(list[i]?.actions) ? list[i].actions : [];
      for (let j = actions.length - 1; j >= 0; j--) {
        const action = actions[j];
        if (!action || action.ignored || action.replacedBy) continue;
        if (action.type !== "move") continue;
        return String(action.id || "");
      }
    }
    return null;
  }

  async openChangeSideDialog({ combatId, combatantId } = {}) {
    const combat = game.combats?.get(combatId || game.combat?.id) || null;
    if (!combat || !combatantId) return;
    const combatant = combat.combatants?.get(combatantId) || null;
    if (!combatant) return;
    const state = (await this._ensureCombatState(combat)) || {};
    const fallbackSides = ["disp:friendly", "disp:neutral", "disp:hostile", "disp:secret"];
    const sideIds = this._sortSideIds(
      new Set([...(state.sides || []).map((s) => s.id), ...fallbackSides, await this._getCombatantSide(combatant)])
    );
    const options = sideIds
      .map((id) => `<option value="${id}">${foundry.utils.escapeHTML(this._formatSideLabel(id))}</option>`)
      .join("");
    const content = `<div class="spaceholder-combat-change-side">
      <div class="form-group">
        <label>${game.i18n?.localize?.("SPACEHOLDER.Combat.NewSide") || "New side"}</label>
        <select id="spaceholder-combat-side">${options}</select>
      </div>
      <div class="form-group">
        <label>${game.i18n?.localize?.("SPACEHOLDER.Combat.OrNewSide") || "Or new custom side id"}</label>
        <input type="text" id="spaceholder-combat-side-new" placeholder="Actor.xxxxx or custom-side"/>
      </div>
    </div>`;
    await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n?.localize?.("SPACEHOLDER.Combat.ChangeSide") || "Change side" },
      content,
      buttons: [
        {
          action: "apply",
          label: game.i18n?.localize?.("SPACEHOLDER.Actions.Apply") || "Apply",
          default: true,
          callback: async (event) => {
            const root = event.currentTarget;
            const selected = String(root.querySelector("#spaceholder-combat-side")?.value || "").trim();
            const custom = String(root.querySelector("#spaceholder-combat-side-new")?.value || "").trim();
            const nextSide = custom || selected;
            if (!nextSide) return;
            await this.setCombatantSide({ combatId: combat.id, combatantId, sideId: nextSide });
          },
        },
        { action: "cancel", label: game.i18n?.localize?.("SPACEHOLDER.Actions.Cancel") || "Cancel" },
      ],
    });
  }
}


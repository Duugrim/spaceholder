/**
 * Transaction ledger: authoritative `system.actionPoints` + append-only undo log.
 *
 * Storage:
 * - In combat (`game.combat.started`): `flags.spaceholder.transactionLedger` on Combat (GM writes; players relay via socket).
 * - Out of combat: same flag name on the primary Actor (owner writes).
 *
 * Transaction record shape:
 * `{ id, schema, createdAt, undoneAt?, undoneBy?, kind, combatId?, combatantId?, source, operations: [{ documentUuid, path, before, after }] }`
 *
 * Undo: GM may undo combat ledger entries; actor owner may undo own actor ledger (local). Socket `ledgerUndo` is GM-initiator only.
 */

const MODULE_NS = "spaceholder";
const FLAG_LEDGER = "transactionLedger";
const FLAG_SYNCED = "apLedgerSyncedV1";
const MAX_LEDGER_ENTRIES = 200;

const AP_VALUE = "system.actionPoints.value";
const AP_MAX = "system.actionPoints.max";

function _num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _clone(obj) {
  try {
    return foundry.utils.deepClone(obj);
  } catch (_) {
    return JSON.parse(JSON.stringify(obj));
  }
}

function _randomId() {
  try {
    return foundry.utils.randomID();
  } catch (_) {
    return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/**
 * Max AP from abilities (same rule as legacy action-service).
 * @param {Actor} actor
 */
export function getMaxApFromAbilities(actor) {
  const dex = _num(actor?.system?.abilities?.dex?.value, 0);
  const int = _num(actor?.system?.abilities?.int?.value, 0);
  return Math.max(0, Math.floor(dex * int));
}

/**
 * Read a value from an Actor using a flat system path like `system.actionPoints.value`.
 * @param {Actor} actor
 * @param {string} path
 */
export function getDocumentPathValue(actor, path) {
  const p = String(path || "").trim();
  if (!p.startsWith("system.")) return undefined;
  const sub = p.slice(7);
  return foundry.utils.getProperty(actor.system, sub);
}

/**
 * @param {string} path
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function _flatUpdate(path, value) {
  return { [path]: value };
}

/**
 * @returns {{ combat: Combat|null, useCombatLedger: boolean }}
 */
function _resolveLedgerTarget(meta = {}) {
  const combatId = String(meta.combatId || "").trim();
  const combat =
    (combatId ? game.combats?.get(combatId) : null) ||
    (game?.combat?.started ? game.combat : null);
  const useCombatLedger = !!(combat && combat.started);
  return { combat: useCombatLedger ? combat : null, useCombatLedger };
}

async function _readLedgerFromCombat(combat) {
  const raw = combat?.getFlag?.(MODULE_NS, FLAG_LEDGER);
  return Array.isArray(raw) ? _clone(raw) : [];
}

async function _writeLedgerToCombat(combat, entries) {
  if (!game.user?.isGM) return;
  await combat.setFlag(MODULE_NS, FLAG_LEDGER, entries);
}

function _readLedgerFromActor(actor) {
  const raw = actor.getFlag?.(MODULE_NS, FLAG_LEDGER);
  return Array.isArray(raw) ? _clone(raw) : [];
}

async function _writeLedgerToActor(actor, entries) {
  if (!actor?.setFlag) return;
  await actor.setFlag(MODULE_NS, FLAG_LEDGER, entries);
}

function _pruneLedger(arr) {
  while (arr.length > MAX_LEDGER_ENTRIES) arr.shift();
}

/**
 * @param {object} tx
 * @param {{ combat: Combat|null, useCombatLedger: boolean, primaryActor: Actor|null }} target
 */
async function _appendLedgerEntry(tx, target) {
  if (target.useCombatLedger && target.combat) {
    if (!game.user?.isGM) {
      throw new Error("GM required to record combat transaction");
    }
    const list = await _readLedgerFromCombat(target.combat);
    list.push(tx);
    _pruneLedger(list);
    await _writeLedgerToCombat(target.combat, list);
    return;
  }
  const actor = target.primaryActor;
  if (!actor) throw new Error("No ledger target");
  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  if (!game.user?.isGM && !actor.testUserPermission(game.user, ownerLevel)) {
    throw new Error("No permission to update actor ledger");
  }
  const list = _readLedgerFromActor(actor);
  list.push(tx);
  _pruneLedger(list);
  await _writeLedgerToActor(actor, list);
}

/**
 * Legacy spent AP (tables + action log) for one-time migration.
 * @param {Actor} actor
 */
async function _legacySpentTotal(actor) {
  let spent = 0;
  const combat = game?.combat?.started ? game.combat : null;
  const list = combat?.combatants?.contents || [];
  const combatant =
    list.find((c) => String(c.actorId ?? c.actor?.id ?? "") === String(actor.id)) || null;
  if (combat && combatant && game.spaceholder?.combatSessionManager?.getCombatantSpentThisRound) {
    spent = await game.spaceholder.combatSessionManager.getCombatantSpentThisRound(combat, combatant.id);
    return _num(spent, 0);
  }
  const { getActorActionLog } = await import("./action-log.mjs");
  const log = getActorActionLog(actor);
  for (const e of log) {
    if (!e || e.ignored || e.replacedBy) continue;
    spent += _num(e.apCost, 0);
  }
  return spent;
}

/**
 * One-time sync from legacy derived AP to stored fields.
 * @param {Actor} actor
 */
export async function ensureCharacterApSynced(actor) {
  if (!actor || actor.type !== "character") return;
  if (actor.getFlag?.(MODULE_NS, FLAG_SYNCED)) return;
  const max = getMaxApFromAbilities(actor);
  const spent = await _legacySpentTotal(actor);
  const value = Math.max(0, Math.floor(max - spent));
  await actor.update({
    "system.actionPoints.max": max,
    "system.actionPoints.value": value,
  });
  await actor.setFlag(MODULE_NS, FLAG_SYNCED, true);
}

/**
 * Recompute `system.actionPoints.max` from abilities; clamp value down if needed.
 * @param {Actor} actor
 */
export async function recomputeApMaxForActor(actor) {
  if (!actor || actor.type !== "character") return;
  const max = getMaxApFromAbilities(actor);
  const curVal = _num(actor.system?.actionPoints?.value, max);
  const nextVal = Math.min(Math.max(0, Math.floor(curVal)), max);
  await actor.update({
    "system.actionPoints.max": max,
    "system.actionPoints.value": nextVal,
  });
}

/**
 * Stored AP for UI (after sync).
 * @param {Actor} actor
 * @returns {{ value: number, max: number, base: number, spent: number }}
 */
export function getStoredActionPoints(actor) {
  const max = getMaxApFromAbilities(actor);
  const storedMax = _num(actor?.system?.actionPoints?.max, NaN);
  const effectiveMax = Number.isFinite(storedMax) && storedMax > 0 ? Math.floor(storedMax) : max;
  const valueRaw = actor?.system?.actionPoints?.value;
  const value =
    valueRaw === undefined || valueRaw === null
      ? effectiveMax
      : Math.max(0, Math.min(Math.floor(_num(valueRaw, effectiveMax)), effectiveMax));
  const spent = Math.max(0, effectiveMax - value);
  return { value, max: effectiveMax, base: effectiveMax, spent };
}

/**
 * Apply document updates and append ledger (local GM or owner path).
 *
 * @param {object} opts
 * @param {Array<{ documentUuid: string, path: string, after: unknown }>} opts.operations
 * @param {object} opts.meta
 * @param {string} [opts.meta.kind]
 * @param {string|null} [opts.meta.combatId]
 * @param {string|null} [opts.meta.combatantId]
 * @param {object} [opts.meta.source]
 * @returns {Promise<{ ok: boolean, transactionId?: string, error?: string }>}
 */
export async function commitTransaction({ operations = [], meta = {} } = {}) {
  try {
    if (!Array.isArray(operations) || !operations.length) {
      return { ok: false, error: "No operations" };
    }

    const ledgerTarget = _resolveLedgerTarget(meta);
    if (ledgerTarget.useCombatLedger && ledgerTarget.combat && !game.user?.isGM) {
      const mgr = game.spaceholder?.combatSessionManager;
      if (typeof mgr?.requestLedgerCommitFromClient !== "function") {
        return { ok: false, error: "Combat ledger relay unavailable" };
      }
      const ops = operations
        .map((o) => ({
          documentUuid: String(o?.documentUuid || "").trim(),
          path: String(o?.path || "").trim(),
          after: o.after,
        }))
        .filter((o) => o.documentUuid && o.path.startsWith("system."));
      if (!ops.length) return { ok: false, error: "No valid operations" };
      const transactionId = _randomId();
      return mgr.requestLedgerCommitFromClient({
        transactionId,
        operations: ops,
        meta: { ...meta, combatId: ledgerTarget.combat.id },
      });
    }

    const byUuid = new Map();
    for (const op of operations) {
      const uuid = String(op?.documentUuid || "").trim();
      const path = String(op?.path || "").trim();
      if (!uuid || !path.startsWith("system.")) continue;
      if (!byUuid.has(uuid)) byUuid.set(uuid, {});
      byUuid.get(uuid)[path] = op.after;
    }

    const fullOps = [];
    for (const [documentUuid, flat] of byUuid) {
      let doc = null;
      try {
        doc = await fromUuid(documentUuid);
      } catch (_) {
        doc = null;
      }
      if (!doc || doc.documentName !== "Actor") {
        return { ok: false, error: `Actor not found: ${documentUuid}` };
      }
      const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
      if (!game.user?.isGM && !doc.testUserPermission(game.user, ownerLevel)) {
        return { ok: false, error: "No permission" };
      }

      for (const [path, after] of Object.entries(flat)) {
        const before = getDocumentPathValue(doc, path);
        fullOps.push({ documentUuid, path, before, after });
      }
    }

    if (!fullOps.length) return { ok: false, error: "No valid operations" };

    const byDocUpdates = new Map();
    for (const op of fullOps) {
      if (!byDocUpdates.has(op.documentUuid)) byDocUpdates.set(op.documentUuid, {});
      Object.assign(byDocUpdates.get(op.documentUuid), _flatUpdate(op.path, op.after));
    }

    for (const [documentUuid, update] of byDocUpdates) {
      const doc = await fromUuid(documentUuid);
      if (!doc) return { ok: false, error: "Actor missing" };
      await doc.update(update);
    }

    const transactionId = _randomId();
    const tx = {
      id: transactionId,
      schema: 1,
      createdAt: Date.now(),
      undoneAt: null,
      undoneBy: null,
      kind: String(meta.kind || "composite"),
      combatId: meta.combatId ?? null,
      combatantId: meta.combatantId ?? null,
      source: meta.source && typeof meta.source === "object" ? meta.source : {},
      operations: fullOps,
    };

    const primaryUuid = fullOps[0]?.documentUuid;
    let primaryActor = null;
    try {
      const d = await fromUuid(primaryUuid);
      primaryActor = d?.documentName === "Actor" ? d : null;
    } catch (_) {
      primaryActor = null;
    }

    const target = { ..._resolveLedgerTarget(meta), primaryActor };
    await _appendLedgerEntry(tx, target);

    return { ok: true, transactionId };
  } catch (e) {
    console.error("SpaceHolder | commitTransaction failed", e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * GM socket entry: apply commit with server-side before snapshots (trust server state).
 * @param {object} payload
 * @param {string} requesterUserId
 */
export async function commitTransactionAsGMSocket(payload, requesterUserId) {
  if (!game.user?.isGM) return { ok: false, error: "GM only" };
  const operationsIn = Array.isArray(payload?.operations) ? payload.operations : [];
  const meta = payload?.meta || {};
  const requester = game.users?.get(String(requesterUserId || "")) || null;
  if (!requester) return { ok: false, error: "Unknown user" };

  const built = [];
  for (const op of operationsIn) {
    const documentUuid = String(op?.documentUuid || "").trim();
    const path = String(op?.path || "").trim();
    if (!documentUuid || !path.startsWith("system.")) continue;
    let doc = null;
    try {
      doc = await fromUuid(documentUuid);
    } catch (_) {
      doc = null;
    }
    if (!doc || doc.documentName !== "Actor") return { ok: false, error: "Invalid actor" };
    const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!requester.isGM && !doc.testUserPermission(requester, ownerLevel)) {
      return { ok: false, error: "Owner required" };
    }
    const after = op.after;
    const before = getDocumentPathValue(doc, path);
    built.push({ documentUuid, path, before, after });
  }

  if (!built.length) return { ok: false, error: "No operations" };

  const byDocUpdates = new Map();
  for (const op of built) {
    if (!byDocUpdates.has(op.documentUuid)) byDocUpdates.set(op.documentUuid, {});
    Object.assign(byDocUpdates.get(op.documentUuid), _flatUpdate(op.path, op.after));
  }
  for (const [documentUuid, update] of byDocUpdates) {
    const doc = await fromUuid(documentUuid);
    if (!doc) return { ok: false, error: "Actor missing" };
    await doc.update(update);
  }

  const transactionId = String(payload?.transactionId || "").trim() || _randomId();
  const tx = {
    id: transactionId,
    schema: 1,
    createdAt: Date.now(),
    undoneAt: null,
    undoneBy: null,
    kind: String(meta.kind || "composite"),
    combatId: meta.combatId ?? null,
    combatantId: meta.combatantId ?? null,
    source: { ...(typeof meta.source === "object" ? meta.source : {}), byUserId: requesterUserId },
    operations: built,
  };

  const combatId = String(meta.combatId || game.combat?.id || "").trim();
  const combat = combatId ? game.combats?.get(combatId) : null;
  if (!combat || !combat.started) return { ok: false, error: "Combat not active" };

  const list = await _readLedgerFromCombat(combat);
  list.push(tx);
  _pruneLedger(list);
  await _writeLedgerToCombat(combat, list);

  return { ok: true, transactionId };
}

/**
 * Undo a transaction by id.
 * @param {{ transactionId: string, combat?: Combat|null, actor?: Actor|null }} opts
 */
export async function undoTransaction({ transactionId, combat = null, actor = null } = {}) {
  const id = String(transactionId || "").trim();
  if (!id) return { ok: false, error: "Missing id" };

  let list = [];
  let writeCombat = null;
  let writeActor = null;

  if (combat) {
    list = await _readLedgerFromCombat(combat);
    writeCombat = combat;
  } else if (actor) {
    list = _readLedgerFromActor(actor);
    writeActor = actor;
  } else {
    return { ok: false, error: "Need combat or actor" };
  }

  const idx = list.findIndex((t) => String(t?.id) === id);
  if (idx < 0) return { ok: false, error: "Transaction not found" };
  const tx = list[idx];
  if (tx.undoneAt) return { ok: false, error: "Already undone" };

  const ops = [...(tx.operations || [])].reverse();
  const byDoc = new Map();
  for (const op of ops) {
    const uuid = String(op.documentUuid || "").trim();
    const path = String(op.path || "").trim();
    if (!byDoc.has(uuid)) byDoc.set(uuid, {});
    Object.assign(byDoc.get(uuid), _flatUpdate(path, op.before));
  }

  for (const [documentUuid, update] of byDoc) {
    const doc = await fromUuid(documentUuid);
    if (!doc) return { ok: false, error: "Actor missing for undo" };
    const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!game.user?.isGM && !doc.testUserPermission(game.user, ownerLevel)) {
      return { ok: false, error: "No permission to undo" };
    }
    await doc.update(update);
  }

  tx.undoneAt = Date.now();
  tx.undoneBy = game.user?.id || null;
  list[idx] = tx;

  if (writeCombat && game.user?.isGM) await _writeLedgerToCombat(writeCombat, list);
  else if (writeActor) await _writeLedgerToActor(writeActor, list);

  return { ok: true };
}

/**
 * Spend AP (subtract, clamp at 0).
 * @param {Actor} actor
 * @param {number} cost
 * @param {object} [meta]
 */
export async function spendAp(actor, cost, meta = {}) {
  await ensureCharacterApSynced(actor);
  const c = Math.max(0, Math.floor(_num(cost, 0)));
  if (!actor || actor.type !== "character") return { ok: false, error: "Not a character" };
  if (c === 0) return { ok: true, transactionId: null };

  const { value, max } = getStoredActionPoints(actor);
  const next = Math.max(0, value - c);
  const combat = game?.combat?.started ? game.combat : null;
  return commitTransaction({
    operations: [{ documentUuid: actor.uuid, path: AP_VALUE, after: next }],
    meta: {
      ...meta,
      kind: "apSpend",
      combatId: meta.combatId ?? combat?.id ?? null,
    },
  });
}

/**
 * Refresh AP pool to full (official turn start).
 * @param {Actor} actor
 * @param {object} [meta]
 */
export async function refreshApPool(actor, meta = {}) {
  await ensureCharacterApSynced(actor);
  if (!actor || actor.type !== "character") return { ok: false, error: "Not a character" };
  const max = getMaxApFromAbilities(actor);
  const combat = game?.combat?.started ? game.combat : null;
  return commitTransaction({
    operations: [
      { documentUuid: actor.uuid, path: AP_MAX, after: max },
      { documentUuid: actor.uuid, path: AP_VALUE, after: max },
    ],
    meta: {
      ...meta,
      kind: "apRefresh",
      combatId: meta.combatId ?? combat?.id ?? null,
    },
  });
}

/**
 * GM undo handler for socket.
 */
export async function undoTransactionAsGMSocket(payload, requesterUserId) {
  if (!game.user?.isGM) return { ok: false, error: "GM only" };
  const transactionId = String(payload?.transactionId || "").trim();
  const combatId = String(payload?.combatId || "").trim();
  const actorUuid = String(payload?.actorUuid || "").trim();
  const combat = combatId ? game.combats?.get(combatId) : null;
  const actor = actorUuid ? await fromUuid(actorUuid) : null;
  const requester = game.users?.get(String(requesterUserId || "")) || null;
  if (!requester) return { ok: false, error: "Unknown user" };

  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

  if (combat) {
    if (!requester.isGM) {
      const list = await _readLedgerFromCombat(combat);
      const tx = list.find((t) => String(t?.id) === transactionId);
      if (!tx) return { ok: false, error: "Transaction not found" };
      for (const op of tx.operations || []) {
        let doc = null;
        try {
          doc = await fromUuid(String(op.documentUuid || ""));
        } catch (_) {
          doc = null;
        }
        if (!doc || doc.documentName !== "Actor") return { ok: false, error: "Invalid operation target" };
        if (!doc.testUserPermission(requester, ownerLevel)) {
          return { ok: false, error: "Owner permission required" };
        }
      }
    }
    return undoTransaction({ transactionId, combat });
  }

  if (actor?.documentName === "Actor") {
    if (!requester.isGM && !actor.testUserPermission(requester, ownerLevel)) {
      return { ok: false, error: "Owner permission required" };
    }
    return undoTransaction({ transactionId, actor });
  }

  return { ok: false, error: "Need combatId or actorUuid" };
}

export function installTransactionLedgerHooks() {
  if (typeof Hooks === "undefined") return;
  Hooks.on("updateActor", (doc, change) => {
    try {
      if (!doc || doc.type !== "character") return;
      const dexTouched = foundry.utils.getProperty(change, "system.abilities.dex") !== undefined;
      const intTouched = foundry.utils.getProperty(change, "system.abilities.int") !== undefined;
      if (!dexTouched && !intTouched) return;
      recomputeApMaxForActor(doc).catch(() => {});
    } catch (_) {
      /* ignore */
    }
  });
}

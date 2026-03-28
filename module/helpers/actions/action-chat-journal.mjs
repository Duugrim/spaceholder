/**
 * Per-character chat journal for one logical combat round: one message, lines appended, per-line undo.
 */

const MODULE_NS = "spaceholder";
const FLAG_ROUND_CHAT = "roundActionChat";
const FLAG_JOURNAL = "actionJournal";

function _randomId() {
  try {
    return foundry.utils.randomID();
  } catch (_) {
    return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

function _esc(s) {
  return foundry.utils.escapeHTML(String(s ?? ""));
}

/** @param {Combat} combat */
async function _logicalRound(combat) {
  const mgr = game.spaceholder?.combatSessionManager;
  if (combat && typeof mgr?.getLogicalRound === "function") {
    return mgr.getLogicalRound(combat);
  }
  return Math.max(1, Number(combat?.round) || 1);
}

/**
 * @param {Array<object>} lines
 * @param {number} round
 * @param {string} title
 */
export function buildActionJournalHtml(lines, round, title) {
  const undoLabel = game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.Undo") || "Undo";
  const undoneLabel = game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.Undone") || "Undone";
  const rows = (Array.isArray(lines) ? lines : []).map((line) => {
    const label = _esc(line.label || "");
    const ap = Number(line.apCost) > 0 ? ` (−${_esc(line.apCost)} AP)` : "";
    const undone = !!line.undone;
    const rowClass = undone ? " spaceholder-action-journal__row--undone" : "";
    const btn = undone
      ? `<span class="spaceholder-action-journal__undone">${_esc(undoneLabel)}</span>`
      : `<button type="button" class="spaceholder-action-journal__undo" data-action="sh-journal-undo"
          data-line-id="${_esc(line.id)}"
          data-line-kind="${_esc(line.kind)}"
          data-combat-id="${_esc(line.combatId)}"
          data-actor-uuid="${_esc(line.actorUuid)}"
          data-transaction-id="${_esc(line.transactionId || "")}"
          data-combat-event-id="${_esc(line.combatEventId || "")}"
          data-movement-id="${_esc(line.movementId || "")}"
          data-token-uuid="${_esc(line.tokenUuid || "")}"
        >${_esc(undoLabel)}</button>`;
    return `<li class="spaceholder-action-journal__row${rowClass}"><span class="spaceholder-action-journal__text">${label}${ap}</span> ${btn}</li>`;
  });
  const t = _esc(title);
  return `<div class="spaceholder-action-journal" data-spaceholder-action-journal="1">
    <div class="spaceholder-action-journal__title">${t}</div>
    <ol class="spaceholder-action-journal__list">${rows.join("")}</ol>
  </div>`;
}

/**
 * Append one line to the actor's journal message for the current logical combat round.
 * @param {object} opts
 * @param {Actor} opts.actor
 * @param {Combat} opts.combat
 * @param {Combatant} opts.combatant
 * @param {string} opts.label
 * @param {number} [opts.apCost]
 * @param {'action'|'move'} opts.kind
 * @param {string|null} [opts.transactionId]
 * @param {string|null} [opts.combatEventId]
 * @param {string|null} [opts.movementId]
 * @param {string|null} [opts.tokenUuid]
 */
export async function appendCombatActionJournalLine({
  actor,
  combat,
  combatant,
  label,
  apCost = 0,
  kind = "action",
  transactionId = null,
  combatEventId = null,
  movementId = null,
  tokenUuid = null,
} = {}) {
  try {
    if (!actor || actor.type !== "character" || !combat?.started || !combatant) return;
    const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!actor.testUserPermission?.(game.user, ownerLevel)) return;

    const round = await _logicalRound(combat);
    const title =
      (game.i18n?.format?.("SPACEHOLDER.ActionChatJournal.Title", { round: String(round) }) ||
        `Round ${round}`);

    const lineId = String(transactionId || combatEventId || _randomId());
    const newLine = {
      id: lineId,
      label: String(label || "").trim() || "—",
      apCost: Math.max(0, Number(apCost) || 0),
      kind: kind === "move" ? "move" : "action",
      undone: false,
      transactionId: transactionId ? String(transactionId) : null,
      combatEventId: combatEventId ? String(combatEventId) : null,
      movementId: movementId ? String(movementId) : null,
      tokenUuid: tokenUuid ? String(tokenUuid) : null,
      combatId: String(combat.id),
      actorUuid: String(actor.uuid),
    };

    const ctx = actor.getFlag?.(MODULE_NS, FLAG_ROUND_CHAT) || {};
    let messageId = ctx.round === round ? String(ctx.messageId || "").trim() : "";
    let msg = messageId ? game.messages?.get?.(messageId) : null;
    if (!msg || !msg.id) {
      const lines = [newLine];
      const content = buildActionJournalHtml(lines, round, title);
      msg = await ChatMessage.create({
        user: game.user.id,
        speaker: ChatMessage.getSpeaker({ actor }),
        content,
        flags: {
          [MODULE_NS]: {
            [FLAG_JOURNAL]: { schema: 1, round, lines },
          },
        },
      });
      if (msg?.id) await actor.setFlag(MODULE_NS, FLAG_ROUND_CHAT, { round, messageId: msg.id });
      return;
    }

    const prev = msg.flags?.[MODULE_NS]?.[FLAG_JOURNAL] || {};
    const lines = Array.isArray(prev.lines) ? prev.lines.slice() : [];
    lines.push(newLine);
    const content = buildActionJournalHtml(lines, round, title);
    const sh = { ...(msg.flags?.[MODULE_NS] || {}) };
    sh[FLAG_JOURNAL] = { schema: 1, round, lines };
    await msg.update({ content, flags: { [MODULE_NS]: sh } });
  } catch (e) {
    console.error("SpaceHolder | appendCombatActionJournalLine failed", e);
  }
}

/**
 * @param {ChatMessage} message
 * @param {string} lineId
 * @param {{ cascadeSubsequentMoves?: boolean }} [opts] - If the undone line is a move, also mark later move lines undone (same token chain).
 */
export async function markJournalLineUndoneInMessage(message, lineId, opts = {}) {
  if (!message?.id) return;
  const fj = message.flags?.[MODULE_NS]?.[FLAG_JOURNAL];
  const lines = Array.isArray(fj?.lines) ? fj.lines.map((l) => ({ ...l })) : [];
  const idx = lines.findIndex((l) => String(l?.id) === String(lineId));
  if (idx < 0) return;
  const target = lines[idx];
  lines[idx] = { ...target, undone: true };

  const cascade = !!opts.cascadeSubsequentMoves && String(target?.kind) === "move";
  if (cascade) {
    const tokenKey = String(target?.tokenUuid || "").trim();
    for (let j = idx + 1; j < lines.length; j++) {
      if (String(lines[j]?.kind) !== "move" || lines[j].undone) continue;
      if (tokenKey && String(lines[j]?.tokenUuid || "").trim() !== tokenKey) continue;
      lines[j] = { ...lines[j], undone: true };
    }
  }

  const round = Math.max(1, Number(fj?.round) || 1);
  const title =
    game.i18n?.format?.("SPACEHOLDER.ActionChatJournal.Title", { round: String(round) }) ||
    `Round ${round}`;
  const content = buildActionJournalHtml(lines, round, title);
  const sh = { ...(message.flags?.[MODULE_NS] || {}) };
  sh[FLAG_JOURNAL] = { ...fj, schema: 1, round, lines };
  await message.update({ content, flags: { [MODULE_NS]: sh } });
}

function _bindJournalUndoButtons(message, html) {
  const root = html?.jquery ? html[0] : html;
  if (!root?.querySelectorAll) return;
  const buttons = root.querySelectorAll('[data-action="sh-journal-undo"]');
  if (!buttons.length) return;
  buttons.forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const lineId = btn.getAttribute("data-line-id") || "";
      const lineKind = btn.getAttribute("data-line-kind") || "";
      const combatId = btn.getAttribute("data-combat-id") || "";
      const actorUuid = btn.getAttribute("data-actor-uuid") || "";
      const transactionId = btn.getAttribute("data-transaction-id") || "";
      const combatEventId = btn.getAttribute("data-combat-event-id") || "";
      const movementId = btn.getAttribute("data-movement-id") || "";
      const tokenUuid = btn.getAttribute("data-token-uuid") || "";
      const mgr = game.spaceholder?.combatSessionManager;
      if (!mgr?.requestJournalUndoFromClient) return;
      let res = null;
      try {
        res = await mgr.requestJournalUndoFromClient({
          messageId: message.id,
          lineId,
          combatId,
          actorUuid,
          transactionId: transactionId || null,
          combatEventId: combatEventId || null,
          movementId: movementId || null,
          tokenUuid: tokenUuid || null,
        });
      } catch (err) {
        ui.notifications?.warn?.(String(err?.message || err));
        return;
      }
      if (!res?.ok) {
        ui.notifications?.warn?.(res?.error || game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.UndoFailed"));
        return;
      }
      const fresh = game.messages.get(message.id);
      if (fresh) {
        try {
          await markJournalLineUndoneInMessage(fresh, lineId, {
            cascadeSubsequentMoves: lineKind === "move",
          });
        } catch (e) {
          console.warn("SpaceHolder | journal message update failed", e);
        }
      }
    });
  });
}

export function installActionChatJournalHooks() {
  if (typeof Hooks === "undefined") return;
  Hooks.on("renderChatMessage", (message, html) => {
    try {
      if (!message?.flags?.[MODULE_NS]?.[FLAG_JOURNAL]) return;
      _bindJournalUndoButtons(message, html);
    } catch (_) {
      /* ignore */
    }
  });
}

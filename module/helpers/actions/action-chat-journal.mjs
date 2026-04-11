/**
 * Per-character chat journal for one logical combat round: one message, lines appended, per-line undo.
 * Consecutive main-turn moves collapse into one `moveGroup` row (expandable); reactions nest under the group / segment.
 */

const MODULE_NS = "spaceholder";
const FLAG_ROUND_CHAT = "roundActionChat";
const FLAG_JOURNAL = "actionJournal";
/** Bumped when journal line shape changes (move groups, nested reactions). */
const JOURNAL_SCHEMA = 2;

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

function _dup(obj) {
  try {
    return foundry.utils.duplicate(obj);
  } catch (_) {
    return typeof structuredClone === "function" ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
  }
}

function _chatMessageCreatePayloadFromExisting(message, { content, moduleFlags } = {}) {
  const raw = typeof message?.toObject === "function" ? message.toObject() : {};
  const flags = _dup(raw?.flags || message?.flags || {});
  const sh = { ...(flags?.[MODULE_NS] || {}) };
  if (moduleFlags && typeof moduleFlags === "object") {
    Object.assign(sh, moduleFlags);
  }
  flags[MODULE_NS] = sh;
  const msgAuthor = message?.author;
  const msgAuthorId = typeof msgAuthor === "string" ? msgAuthor : msgAuthor?.id ?? null;
  const authorId = raw?.author ?? raw?.user ?? msgAuthorId ?? game.user?.id ?? null;
  return {
    author: authorId,
    speaker: _dup(raw?.speaker || message?.speaker || {}),
    style: raw?.style ?? message?.style ?? CONST.CHAT_MESSAGE_STYLES?.OTHER,
    content: String(content ?? raw?.content ?? message?.content ?? ""),
    whisper: Array.isArray(raw?.whisper) ? raw.whisper.slice() : [],
    blind: !!(raw?.blind ?? message?.blind),
    emote: !!(raw?.emote ?? message?.emote),
    flavor: String(raw?.flavor ?? message?.flavor ?? ""),
    rolls: Array.isArray(raw?.rolls) ? _dup(raw.rolls) : [],
    flags,
  };
}

function _extractActorUuidFromJournalLines(lines) {
  const list = Array.isArray(lines) ? lines : [];
  for (const line of list) {
    const top = String(line?.actorUuid || "").trim();
    if (top) return top;
    if (line?.kind !== "moveGroup") continue;
    for (const seg of line?.segments || []) {
      const segActor = String(seg?.actorUuid || "").trim();
      if (segActor) return segActor;
      for (const reaction of seg?.reactions || []) {
        const reactionActor = String(reaction?.actorUuid || "").trim();
        if (reactionActor) return reactionActor;
      }
    }
  }
  return "";
}

async function _syncRoundChatMessagePointer(message, explicitActor = null) {
  if (!message?.id) return;
  const fj = message.flags?.[MODULE_NS]?.[FLAG_JOURNAL];
  const round = Math.max(1, Number(fj?.round) || 1);
  let actor = explicitActor && explicitActor.documentName === "Actor" ? explicitActor : null;
  if (!actor) {
    const actorUuid = _extractActorUuidFromJournalLines(fj?.lines);
    if (!actorUuid) return;
    try {
      actor = await fromUuid(actorUuid);
    } catch (_) {
      actor = null;
    }
  }
  if (!actor || actor.documentName !== "Actor") return;
  await actor.setFlag(MODULE_NS, FLAG_ROUND_CHAT, { round, messageId: message.id });
}

async function _replaceJournalMessage(message, { content, journalFlags, anchorActor = null } = {}) {
  if (!message?.id) return message ?? null;
  const createData = _chatMessageCreatePayloadFromExisting(message, {
    content,
    moduleFlags: {
      [FLAG_JOURNAL]: journalFlags,
    },
  });
  const fresh = await ChatMessage.create(createData);
  if (!fresh?.id) return message;
  try {
    await _syncRoundChatMessagePointer(fresh, anchorActor);
  } catch (err) {
    console.warn("SpaceHolder | failed to sync round chat message pointer", err);
  }
  try {
    _removeChatMessageDomNow(message.id);
    await message.delete();
  } catch (err) {
    console.warn("SpaceHolder | failed to delete replaced journal message", err);
  }
  return fresh;
}

function _removeChatMessageDomNow(messageId) {
  const id = String(messageId || "").trim();
  if (!id || typeof document === "undefined") return;
  const rows = document.querySelectorAll(".chat-message[data-message-id]");
  for (const row of rows) {
    const rowId = String(row?.getAttribute?.("data-message-id") || row?.dataset?.messageId || "").trim();
    if (rowId !== id) continue;
    row.style.transition = "none";
    row.style.animation = "none";
    row.remove();
  }
}

function _lineIconClass(line) {
  if (line?.icon) return String(line.icon);
  const kind = String(line?.kind || "action");
  if (kind === "move") return "fa-solid fa-shoe-prints";
  if (kind === "system") return "fa-solid fa-flag-checkered";
  return "fa-solid fa-bolt";
}

function _lineToneClass(line) {
  const kind = String(line?.kind || "action");
  if (kind === "move" || kind === "moveGroup") return "spaceholder-action-journal__row--move";
  if (kind === "system") return "spaceholder-action-journal__row--system";
  return "spaceholder-action-journal__row--action";
}

function _safeCssId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Token / actor portrait for reaction rows (sync, for chat HTML). */
function _reactionTokenThumbUrl(tokenUuid) {
  const u = String(tokenUuid || "").trim();
  if (!u) return "";
  try {
    const sync = foundry?.utils?.fromUuidSync;
    if (typeof sync !== "function") return "";
    const doc = sync(u);
    if (!doc) return "";
    const tx = doc.texture;
    const txSrc = typeof tx === "string" ? tx : tx?.src;
    if (typeof txSrc === "string" && txSrc) return txSrc;
    const actor = doc.actor ?? doc;
    const img = actor?.img ?? actor?.prototypeToken?.texture?.src;
    if (typeof img === "string" && img) return img;
  } catch (_) {
    /* ignore */
  }
  return "";
}

function _reactionRowTitle(line, reactionLabel) {
  const name = String(line?.actorName || "").trim();
  const label = String(line?.label || "").trim();
  const bits = [];
  if (name) bits.push(name);
  bits.push(reactionLabel);
  if (label) bits.push(label);
  return bits.join(" — ");
}

/**
 * @param {object} line - top-level journal line (move)
 * @param {boolean} preserveReactions
 */
function _segmentFromJournalLine(line, preserveReactions = false) {
  const reactions =
    preserveReactions && Array.isArray(line?.reactions) ? _dup(line.reactions) : [];
  return {
    id: line.id,
    label: line.label,
    description: String(line.description || "").trim(),
    apCost: Math.max(0, Number(line.apCost) || 0),
    undone: !!line.undone,
    undoable: line.undoable !== false,
    transactionId: line.transactionId ?? null,
    combatEventId: line.combatEventId ?? null,
    movementId: line.movementId ?? null,
    tokenUuid: line.tokenUuid ?? null,
    combatId: line.combatId ?? null,
    actorUuid: line.actorUuid ?? null,
    actorName: String(line.actorName || "").trim(),
    icon: line.icon ? String(line.icon) : null,
    reactions,
  };
}

function _sealLastMoveGroup(lines) {
  const last = lines[lines.length - 1];
  if (last?.kind === "moveGroup") {
    lines[lines.length - 1] = { ...last, sealed: true };
  }
}

/**
 * @param {object[]} lines
 * @param {object} newLine - full journal line (kind move, !isReaction)
 */
function _appendOrMergeMainMove(lines, newLine) {
  const seg = _segmentFromJournalLine(newLine, false);
  const last = lines[lines.length - 1];
  if (last?.kind === "moveGroup" && !last.sealed) {
    const segments = [...(last.segments || []), seg];
    lines[lines.length - 1] = { ...last, segments };
    return;
  }
  if (last?.kind === "move" && !last.isReaction) {
    lines[lines.length - 1] = {
      id: _randomId(),
      kind: "moveGroup",
      sealed: false,
      groupUiExpanded: false,
      segments: [_segmentFromJournalLine(last, false), seg],
    };
    return;
  }
  lines.push({
    id: _randomId(),
    kind: "moveGroup",
    sealed: false,
    groupUiExpanded: false,
    segments: [seg],
  });
}

/**
 * @param {object[]} lines
 * @param {object} reactionLine - full journal line (isReaction)
 */
function _appendReactionToLines(lines, reactionLine) {
  const last = lines[lines.length - 1];
  if (last?.kind === "moveGroup" && Array.isArray(last.segments) && last.segments.length) {
    const g = _dup(last);
    const segments = [...(g.segments || [])];
    const li = segments.length - 1;
    const lastSeg = { ...segments[li] };
    lastSeg.reactions = Array.isArray(lastSeg.reactions) ? lastSeg.reactions.slice() : [];
    lastSeg.reactions.push(reactionLine);
    segments[li] = lastSeg;
    g.segments = segments;
    lines[lines.length - 1] = g;
    return;
  }
  if (last?.kind === "move" && !last.isReaction) {
    const seg = _segmentFromJournalLine(last, false);
    seg.reactions = [reactionLine];
    lines[lines.length - 1] = {
      id: _randomId(),
      kind: "moveGroup",
      sealed: false,
      groupUiExpanded: false,
      segments: [seg],
    };
    return;
  }
  lines.push(reactionLine);
}

function _markMoveGroupFullyUndone(group) {
  const segments = (group.segments || []).map((s) => ({
    ...s,
    undone: true,
    reactions: (s.reactions || []).map((r) => ({ ...r, undone: true })),
  }));
  return { ...group, segments };
}

/**
 * @param {object[]} lines
 * @param {string} lineId
 * @returns {{ type: 'group', index: number, line: object } | { type: 'top', index: number, line: object } | { type: 'segment', groupIndex: number, segIndex: number } | { type: 'reaction', groupIndex: number, segIndex: number, reactIndex: number } | null}
 */
function _findLineLocation(lines, lineId) {
  const id = String(lineId || "");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (String(l?.id) === id) {
      if (l.kind === "moveGroup") return { type: "group", index: i, line: l };
      return { type: "top", index: i, line: l };
    }
  }
  for (let gi = 0; gi < lines.length; gi++) {
    const g = lines[gi];
    if (g?.kind !== "moveGroup") continue;
    const segs = g.segments || [];
    for (let si = 0; si < segs.length; si++) {
      if (String(segs[si]?.id) === id) return { type: "segment", groupIndex: gi, segIndex: si };
      const reacts = segs[si].reactions || [];
      for (let ri = 0; ri < reacts.length; ri++) {
        if (String(reacts[ri]?.id) === id) return { type: "reaction", groupIndex: gi, segIndex: si, reactIndex: ri };
      }
    }
  }
  return null;
}

/** @param {ParentNode} root */
function _queryDescPanelByTargetId(root, targetId) {
  const id = String(targetId || "").trim();
  if (!id || !root?.querySelector) return null;
  try {
    if (typeof CSS !== "undefined" && CSS.escape) {
      return root.querySelector(`#${CSS.escape(id)}`);
    }
  } catch (_) {
    /* fall through */
  }
  return root.querySelector(`#${_safeCssId(id)}`);
}

/** @param {unknown} html - HTMLElement (or legacy jQuery wrapper) */
function _resolveActionJournalRoot(html) {
  const wrap = html?.jquery ? html[0] : html;
  if (!wrap?.querySelector) return null;
  const inner = wrap.querySelector?.('[data-spaceholder-action-journal="1"]');
  if (inner) return inner;
  return wrap.getAttribute?.("data-spaceholder-action-journal") === "1" ? wrap : null;
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
 * @param {object} line
 * @param {object} opts
 * @param {boolean} [opts.nested]
 * @param {string} [opts.undoScope]
 */
function _renderUndoButton(line, opts = {}) {
  const nested = !!opts.nested;
  const undoScope = opts.undoScope ? String(opts.undoScope) : "";
  const undoLabel = game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.Undo") || "Undo";
  const undoneLabel = game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.Undone") || "Undone";
  const undoable = line.undoable !== false && String(line.kind) !== "system";
  const undone = !!line.undone;
  if (!undoable) return "";
  if (undone) return `<span class="spaceholder-action-journal__undone">${_esc(undoneLabel)}</span>`;
  const scopeAttr = undoScope ? ` data-undo-scope="${_esc(undoScope)}"` : "";
  const nestedAttr = nested ? ` data-nested="1"` : "";
  return `<button type="button" class="spaceholder-action-journal__undo" data-action="sh-journal-undo"
          data-line-id="${_esc(line.id)}"
          data-line-kind="${_esc(line.kind)}"
          data-combat-id="${_esc(line.combatId)}"
          data-actor-uuid="${_esc(line.actorUuid)}"
          data-transaction-id="${_esc(line.transactionId || "")}"
          data-combat-event-id="${_esc(line.combatEventId || "")}"
          data-movement-id="${_esc(line.movementId || "")}"
          data-token-uuid="${_esc(line.tokenUuid || "")}"
          title="${_esc(undoLabel)}"${scopeAttr}${nestedAttr}
        ><i class="fa-solid fa-rotate-left" aria-hidden="true"></i></button>`;
}

/**
 * @param {object} line
 * @param {{ reactionLabel: string, detailsLabel: string, nested?: boolean }} ctx
 */
function _renderStandardRowHtml(line, ctx) {
  const label = _esc(line.label || "");
  const description = String(line.description || "").trim();
  const ap = Number(line.apCost) > 0 ? ` (−${_esc(line.apCost)} AP)` : "";
  const undone = !!line.undone;
  const isReaction = !!line.isReaction;
  const rowClass = `${_lineToneClass(line)}${undone ? " spaceholder-action-journal__row--undone" : ""}${isReaction ? " spaceholder-action-journal__row--reaction" : ""}${ctx.nested ? " spaceholder-action-journal__row--nested" : ""}`;
  const descId = `sh-jline-desc-${_safeCssId(line.id || _randomId())}`;
  const detailToggle = description
    ? `<button type="button" class="spaceholder-action-journal__toggle" data-action="sh-journal-toggle" data-target="${descId}" aria-expanded="false" title="${_esc(ctx.detailsLabel)}"><i class="fa-solid fa-align-left" aria-hidden="true"></i></button>`
    : "";
  const details = description
    ? `<div class="spaceholder-action-journal__desc" id="${descId}" data-collapsed="1">${_esc(description)}</div>`
    : "";
  const btn = _renderUndoButton(line, { nested: !!ctx.nested });
  const a11yTitle = _esc(_reactionRowTitle(line, ctx.reactionLabel));
  const thumb = isReaction ? _reactionTokenThumbUrl(line.tokenUuid) : "";
  const gutter = isReaction
    ? `<span class="spaceholder-action-journal__reaction-gutter" aria-hidden="true">${
        thumb
          ? `<img class="spaceholder-action-journal__reaction-token" src="${_esc(thumb)}" alt="" />`
          : `<span class="spaceholder-action-journal__reaction-token-fallback"><i class="fa-solid fa-user" aria-hidden="true"></i></span>`
      }</span>`
    : "";
  const liAttrs = `class="spaceholder-action-journal__row ${rowClass}" data-line-id="${_esc(line.id || "")}" data-event-id="${_esc(line.combatEventId || "")}"${isReaction ? ` title="${a11yTitle}"` : ""}`;
  return `<li ${liAttrs}>
      ${gutter}
      <span class="spaceholder-action-journal__main">
        <span class="spaceholder-action-journal__kind"><i class="${_lineIconClass(line)}" aria-hidden="true"></i></span>
        <span class="spaceholder-action-journal__text">${label}${ap}</span>
      </span>
      <span class="spaceholder-action-journal__tools">${detailToggle}${btn}</span>
      ${details}
    </li>`;
}

/**
 * @param {object} group
 * @param {{ reactionLabel: string, detailsLabel: string, expandLabel: string, collapseLabel: string }} ctx
 */
function _renderMoveGroupHtml(group, ctx) {
  const segs = Array.isArray(group.segments) ? group.segments : [];
  const first = segs[0];
  const expanded = !!group.groupUiExpanded;
  const moveWord = game.i18n?.localize?.("SPACEHOLDER.Combat.RowMove") || "Move";
  let apSum = 0;
  for (const s of segs) apSum += Math.max(0, Number(s?.apCost) || 0);
  const apStr = apSum > 0 ? ` (−${_esc(apSum)} AP)` : "";
  const summary =
    segs.length > 1
      ? game.i18n?.format?.("SPACEHOLDER.ActionChatJournal.MoveGroupSummary", {
          count: String(segs.length),
        }) || `${moveWord} ×${segs.length}`
      : moveWord;
  const groupUndone = segs.length > 0 && segs.every((s) => s.undone);
  const firstUndoable = first && first.undoable !== false && !first.undone;
  const rowClass = `spaceholder-action-journal__row spaceholder-action-journal__row--move spaceholder-action-journal__movegroup${groupUndone ? " spaceholder-action-journal__row--undone" : ""}`;
  const expandTitle = expanded ? ctx.collapseLabel : ctx.expandLabel;
  const chevron = expanded ? "fa-solid fa-chevron-down" : "fa-solid fa-chevron-right";
  const groupUndoLine = first
    ? {
        ...first,
        id: group.id,
        kind: "move",
        label: summary,
        apCost: apSum,
        description: "",
        undone: groupUndone,
        undoable: firstUndoable,
      }
    : null;
  const groupUndoBtn =
    groupUndoLine && !groupUndone
      ? _renderUndoButton(
          {
            ...groupUndoLine,
            id: group.id,
            combatEventId: first.combatEventId,
            movementId: first.movementId,
            tokenUuid: first.tokenUuid,
            transactionId: first.transactionId,
            combatId: first.combatId,
            actorUuid: first.actorUuid,
            kind: "move",
            undone: false,
            undoable: firstUndoable,
          },
          { undoScope: "group" }
        )
      : groupUndone
      ? `<span class="spaceholder-action-journal__undone">${_esc(game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.Undone") || "Undone")}</span>`
      : "";

  const flatReacts = [];
  for (const s of segs) {
    for (const r of s.reactions || []) flatReacts.push(r);
  }

  const collapsedReactHtml =
    !expanded && flatReacts.length
      ? `<ul class="spaceholder-action-journal__movegroup-react-flat">${flatReacts
          .map((r) => _renderStandardRowHtml({ ...r, kind: r.kind || "action" }, { ...ctx, nested: true }))
          .join("")}</ul>`
      : "";

  const segmentRows = expanded
    ? segs
        .map((seg) => {
          const line = {
            id: seg.id,
            kind: "move",
            label: String(seg.label || moveWord),
            description: seg.description,
            apCost: seg.apCost,
            undone: seg.undone,
            undoable: seg.undoable,
            isReaction: false,
            actorName: seg.actorName,
            icon: seg.icon,
            transactionId: seg.transactionId,
            combatEventId: seg.combatEventId,
            movementId: seg.movementId,
            tokenUuid: seg.tokenUuid,
            combatId: seg.combatId,
            actorUuid: seg.actorUuid,
          };
          const descId = `sh-jline-desc-${_safeCssId(seg.id || _randomId())}`;
          const description = String(seg.description || "").trim();
          const detailToggle = description
            ? `<button type="button" class="spaceholder-action-journal__toggle" data-action="sh-journal-toggle" data-target="${descId}" aria-expanded="false" title="${_esc(ctx.detailsLabel)}"><i class="fa-solid fa-align-left" aria-hidden="true"></i></button>`
            : "";
          const details = description
            ? `<div class="spaceholder-action-journal__desc" id="${descId}" data-collapsed="1">${_esc(description)}</div>`
            : "";
          const reacts = (seg.reactions || [])
            .map((r) => {
              const lr = { ...r, kind: r.kind || "action" };
              return _renderStandardRowHtml(lr, { ...ctx, nested: true });
            })
            .join("");
          const ap = Number(seg.apCost) > 0 ? ` (−${_esc(seg.apCost)} AP)` : "";
          const undone = !!seg.undone;
          const rowClassS = `spaceholder-action-journal__row spaceholder-action-journal__row--move spaceholder-action-journal__row--move-segment${undone ? " spaceholder-action-journal__row--undone" : ""} spaceholder-action-journal__row--nested`;
          return `<li class="${rowClassS}" data-line-id="${_esc(seg.id || "")}" data-event-id="${_esc(seg.combatEventId || "")}">
            <span class="spaceholder-action-journal__main">
              <span class="spaceholder-action-journal__kind"><i class="fa-solid fa-shoe-prints" aria-hidden="true"></i></span>
              <span class="spaceholder-action-journal__text">${_esc(seg.label || moveWord)}${ap}</span>
            </span>
            <span class="spaceholder-action-journal__tools">${detailToggle}${_renderUndoButton(line, { nested: true })}</span>
            ${details}
            ${reacts ? `<ul class="spaceholder-action-journal__sublist">${reacts}</ul>` : ""}
          </li>`;
        })
        .join("")
    : "";

  const firstEvt = first?.combatEventId || "";

  return `<li class="${rowClass}" data-line-id="${_esc(group.id || "")}" data-event-id="${_esc(firstEvt)}">
    <span class="spaceholder-action-journal__main">
      <span class="spaceholder-action-journal__kind"><i class="fa-solid fa-shoe-prints" aria-hidden="true"></i></span>
      <span class="spaceholder-action-journal__text">${_esc(summary)}${apStr}</span>
    </span>
    <span class="spaceholder-action-journal__tools">
      <button type="button" class="spaceholder-action-journal__toggle spaceholder-action-journal__toggle--chevron" data-action="sh-journal-toggle-move-group"
        data-group-id="${_esc(group.id)}"
        aria-expanded="${expanded ? "true" : "false"}"
        title="${_esc(expandTitle)}"><i class="${chevron}" aria-hidden="true"></i></button>
      ${groupUndoBtn}
    </span>
    <div class="spaceholder-action-journal__movegroup-body">
      ${collapsedReactHtml}
      ${expanded ? `<ol class="spaceholder-action-journal__movegroup-segments">${segmentRows}</ol>` : ""}
    </div>
  </li>`;
}

/**
 * @param {Array<object>} lines
 * @param {number} round
 * @param {string} title
 */
export function buildActionJournalHtml(lines, round, title) {
  const reactionLabel = game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.ReactionBadge") || "Reaction";
  const detailsLabel = game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.ShowDetails") || "Details";
  const expandLabel =
    game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.ExpandMoveGroup") || "Show each move";
  const collapseLabel =
    game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.CollapseMoveGroup") || "Collapse moves";
  const ctx = { reactionLabel, detailsLabel, expandLabel, collapseLabel };
  const rows = (Array.isArray(lines) ? lines : []).map((line) => {
    if (line?.kind === "moveGroup") return _renderMoveGroupHtml(line, ctx);
    return _renderStandardRowHtml(line, ctx);
  });
  const t = _esc(title);
  return `<div class="spaceholder-action-journal" data-spaceholder-action-journal="1">
    <div class="spaceholder-action-journal__title">${t}</div>
    <ol class="spaceholder-action-journal__list">${rows.join("")}</ol>
  </div>`;
}

function _buildStartTurnLine({ actor, combat, combatant }) {
  const label = game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.StartTurn") || "Started turn";
  const description = game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.StartTurnHint") || "";
  return {
    id: `turn-start:${String(combat?.id || "")}:${String(combatant?.id || "")}:${Date.now()}`,
    label,
    description,
    apCost: 0,
    kind: "system",
    undone: false,
    undoable: false,
    isReaction: false,
    transactionId: null,
    combatEventId: null,
    movementId: null,
    tokenUuid: null,
    combatId: String(combat?.id || ""),
    actorUuid: String(actor?.uuid || ""),
    actorName: "",
  };
}

export async function ensureCombatActionJournalMessage({
  actor,
  combat,
  combatant,
  withStartLine = false,
} = {}) {
  if (!actor || actor.type !== "character" || !combat?.started || !combatant) return null;
  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  if (!actor.testUserPermission?.(game.user, ownerLevel)) return null;
  const round = await _logicalRound(combat);
  const title =
    (game.i18n?.format?.("SPACEHOLDER.ActionChatJournal.Title", { round: String(round) }) ||
      `Round ${round}`);
  const ctx = actor.getFlag?.(MODULE_NS, FLAG_ROUND_CHAT) || {};
  const messageId = ctx.round === round ? String(ctx.messageId || "").trim() : "";
  const existing = messageId ? game.messages?.get?.(messageId) : null;
  if (existing?.id) return existing;
  const lines = withStartLine ? [_buildStartTurnLine({ actor, combat, combatant })] : [];
  const content = buildActionJournalHtml(lines, round, title);
  const msg = await ChatMessage.create({
    author: game.user.id,
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    flags: {
      [MODULE_NS]: {
        [FLAG_JOURNAL]: { schema: JOURNAL_SCHEMA, round, lines },
      },
    },
  });
  if (msg?.id) await actor.setFlag(MODULE_NS, FLAG_ROUND_CHAT, { round, messageId: msg.id });
  return msg || null;
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
  anchorActor = null,
  anchorCombatant = null,
  label,
  description = "",
  apCost = 0,
  kind = "action",
  isReaction = false,
  actorName = "",
  icon = null,
  undoable = true,
  transactionId = null,
  combatEventId = null,
  movementId = null,
  tokenUuid = null,
} = {}) {
  try {
    if (!actor || actor.type !== "character" || !combat?.started || !combatant) return;
    const anchorA = anchorActor?.type === "character" ? anchorActor : actor;
    const anchorC = anchorCombatant || combatant;
    const round = await _logicalRound(combat);
    const title =
      (game.i18n?.format?.("SPACEHOLDER.ActionChatJournal.Title", { round: String(round) }) ||
        `Round ${round}`);

    const lineId = String(transactionId || combatEventId || _randomId());
    const newLine = {
      id: lineId,
      label: String(label || "").trim() || "—",
      description: String(description || "").trim(),
      apCost: Math.max(0, Number(apCost) || 0),
      kind: kind === "move" ? "move" : kind === "system" ? "system" : "action",
      undone: false,
      undoable: undoable !== false,
      isReaction: !!isReaction,
      icon: icon ? String(icon) : null,
      transactionId: transactionId ? String(transactionId) : null,
      combatEventId: combatEventId ? String(combatEventId) : null,
      movementId: movementId ? String(movementId) : null,
      tokenUuid: tokenUuid ? String(tokenUuid) : null,
      combatId: String(combat.id),
      actorUuid: String(actor.uuid),
      actorName: String(actorName || "").trim(),
    };
    const msg = await ensureCombatActionJournalMessage({
      actor: anchorA,
      combat,
      combatant: anchorC,
      withStartLine: true,
    });
    if (!msg?.id) return;

    const prev = msg.flags?.[MODULE_NS]?.[FLAG_JOURNAL] || {};
    const lines = Array.isArray(prev.lines) ? _dup(prev.lines) : [];

    if (newLine.isReaction) {
      _appendReactionToLines(lines, newLine);
    } else if (newLine.kind === "move") {
      _appendOrMergeMainMove(lines, newLine);
    } else {
      if (newLine.kind === "action") _sealLastMoveGroup(lines);
      lines.push(newLine);
    }

    const content = buildActionJournalHtml(lines, round, title);
    const sh = { ...(msg.flags?.[MODULE_NS] || {}) };
    sh[FLAG_JOURNAL] = { ...prev, schema: JOURNAL_SCHEMA, round, lines };
    await _replaceJournalMessage(msg, {
      content,
      journalFlags: sh[FLAG_JOURNAL],
      anchorActor: anchorA,
    });
  } catch (e) {
    console.error("SpaceHolder | appendCombatActionJournalLine failed", e);
  }
}

/**
 * @param {ChatMessage} message
 * @param {string} groupId
 */
async function _toggleMoveGroupExpandedInMessage(message, groupId) {
  if (!message?.id) return;
  const fj = message.flags?.[MODULE_NS]?.[FLAG_JOURNAL];
  const lines = Array.isArray(fj?.lines) ? _dup(fj.lines) : [];
  const idx = lines.findIndex((l) => l?.kind === "moveGroup" && String(l?.id) === String(groupId));
  if (idx < 0) return;
  const g = lines[idx];
  lines[idx] = { ...g, groupUiExpanded: !g.groupUiExpanded };
  const round = Math.max(1, Number(fj?.round) || 1);
  const title =
    game.i18n?.format?.("SPACEHOLDER.ActionChatJournal.Title", { round: String(round) }) ||
    `Round ${round}`;
  const content = buildActionJournalHtml(lines, round, title);
  const sh = { ...(message.flags?.[MODULE_NS] || {}) };
  sh[FLAG_JOURNAL] = { ...fj, schema: JOURNAL_SCHEMA, round, lines };
  await _replaceJournalMessage(message, {
    content,
    journalFlags: sh[FLAG_JOURNAL],
  });
}

/**
 * @param {ChatMessage} message
 * @param {string} lineId
 * @param {{ cascadeSubsequentMoves?: boolean, undoWholeMoveGroup?: boolean }} [opts]
 */
export async function markJournalLineUndoneInMessage(message, lineId, opts = {}) {
  if (!message?.id) return;
  const fj = message.flags?.[MODULE_NS]?.[FLAG_JOURNAL];
  const lines = Array.isArray(fj?.lines) ? _dup(fj.lines) : [];
  const loc = _findLineLocation(lines, lineId);
  if (!loc) return;

  const undoWholeMoveGroup = !!opts.undoWholeMoveGroup;
  const cascadeSubsequentMoves = !!opts.cascadeSubsequentMoves;

  if (undoWholeMoveGroup && loc.type === "group") {
    lines[loc.index] = _markMoveGroupFullyUndone(loc.line);
  } else if (loc.type === "top") {
    const target = loc.line;
    if (target?.undoable === false) return;
    if (target.kind === "moveGroup") return;
    lines[loc.index] = { ...target, undone: true };
    if (cascadeSubsequentMoves && String(target.kind) === "move") {
      const tokenKey = String(target?.tokenUuid || "").trim();
      for (let j = loc.index + 1; j < lines.length; j++) {
        if (String(lines[j]?.kind) !== "move" || lines[j].undone) continue;
        if (tokenKey && String(lines[j]?.tokenUuid || "").trim() !== tokenKey) continue;
        lines[j] = { ...lines[j], undone: true };
      }
    }
  } else if (loc.type === "segment") {
    const g = _dup(lines[loc.groupIndex]);
    const segs = [...(g.segments || [])];
    const seg = segs[loc.segIndex];
    if (seg?.undoable === false) return;
    segs[loc.segIndex] = { ...seg, undone: true };
    g.segments = segs;
    lines[loc.groupIndex] = g;
  } else if (loc.type === "reaction") {
    const g = _dup(lines[loc.groupIndex]);
    const segs = [...(g.segments || [])];
    const seg = { ...segs[loc.segIndex] };
    const reacts = [...(seg.reactions || [])];
    const r = reacts[loc.reactIndex];
    if (r?.undoable === false) return;
    reacts[loc.reactIndex] = { ...r, undone: true };
    seg.reactions = reacts;
    segs[loc.segIndex] = seg;
    g.segments = segs;
    lines[loc.groupIndex] = g;
  }

  const round = Math.max(1, Number(fj?.round) || 1);
  const title =
    game.i18n?.format?.("SPACEHOLDER.ActionChatJournal.Title", { round: String(round) }) ||
    `Round ${round}`;
  const content = buildActionJournalHtml(lines, round, title);
  const sh = { ...(message.flags?.[MODULE_NS] || {}) };
  sh[FLAG_JOURNAL] = { ...fj, schema: JOURNAL_SCHEMA, round, lines };
  await _replaceJournalMessage(message, {
    content,
    journalFlags: sh[FLAG_JOURNAL],
  });
}

function _removeCascadePreview(root) {
  root?.querySelectorAll?.(".spaceholder-action-journal__row--cascade-preview")
    ?.forEach?.((el) => el.classList.remove("spaceholder-action-journal__row--cascade-preview"));
  document.querySelectorAll(".spaceholder-action-journal__row--cascade-preview")
    ?.forEach?.((el) => el.classList.remove("spaceholder-action-journal__row--cascade-preview"));
}

function _ensureCollapsedDescriptionState(root) {
  root?.querySelectorAll?.(".spaceholder-action-journal__desc")
    ?.forEach?.((panel) => {
      panel.setAttribute("data-collapsed", "1");
      panel.removeAttribute("hidden");
      panel.style.removeProperty("display");
    });
  root?.querySelectorAll?.('[data-action="sh-journal-toggle"]')
    ?.forEach?.((btn) => btn.setAttribute("aria-expanded", "false"));
}

function _applyCascadePreviewByEventIds(eventIds = []) {
  const ids = Array.isArray(eventIds) ? eventIds : [];
  for (const id of ids) {
    const raw = String(id || "");
    const safe = typeof CSS !== "undefined" && CSS?.escape ? CSS.escape(raw) : raw;
    if (!safe) continue;
    document.querySelectorAll(`[data-event-id="${safe}"]`)
      .forEach((el) => el.classList.add("spaceholder-action-journal__row--cascade-preview"));
  }
}

/** Resolve ChatMessage for a journal control (works when render hooks did not bind per-node listeners). */
function _getChatMessageForJournalControl(el) {
  const row = el?.closest?.(".chat-message");
  if (!row) return null;
  const raw = row.getAttribute?.("data-message-id") ?? row.dataset?.messageId ?? "";
  const id = String(raw).trim();
  if (!id || !game?.messages?.get) return null;
  const msg = game.messages.get(id);
  return msg?.flags?.[MODULE_NS]?.[FLAG_JOURNAL] ? msg : null;
}

function _applyJournalToggleClick(btn) {
  const journalRoot = btn.closest?.('[data-spaceholder-action-journal="1"]');
  const root = journalRoot || btn;
  const row = btn.closest(".spaceholder-action-journal__row");
  const targetId = String(btn.getAttribute("data-target") || "");
  const panel =
    row?.querySelector(".spaceholder-action-journal__desc") ||
    (targetId ? _queryDescPanelByTargetId(root, targetId) : null);
  if (!panel) return;
  const isCollapsed = panel.getAttribute("data-collapsed") !== "0";
  const nextExpanded = isCollapsed;
  panel.setAttribute("data-collapsed", nextExpanded ? "0" : "1");
  panel.removeAttribute("hidden");
  panel.style.removeProperty("display");
  btn.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
}

async function _applyJournalUndoClick(btn, message) {
  const journalRoot = btn.closest?.('[data-spaceholder-action-journal="1"]');
  _removeCascadePreview(journalRoot);
  const lineId = btn.getAttribute("data-line-id") || "";
  const lineKind = btn.getAttribute("data-line-kind") || "";
  const combatId = btn.getAttribute("data-combat-id") || "";
  const combatEventId = btn.getAttribute("data-combat-event-id") || "";
  const tokenUuid = btn.getAttribute("data-token-uuid") || "";
  const undoScope = btn.getAttribute("data-undo-scope") || "";
  const nested = btn.getAttribute("data-nested") === "1";
  const previewMgr = game.spaceholder?.combatSessionManager;
  let affectedCount = 0;
  if (previewMgr?.requestJournalUndoPreviewFromClient && combatId && combatEventId) {
    try {
      const preview = await previewMgr.requestJournalUndoPreviewFromClient({
        combatId,
        targetEventId: combatEventId,
        lineKind,
        tokenUuid: tokenUuid || null,
      });
      affectedCount = Math.max(0, Number(preview?.affectedCount) || 0);
    } catch (_) {
      affectedCount = 0;
    }
  }
  if (affectedCount > 1) {
    const title = game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.ConfirmBulkUndoTitle") || "Confirm undo";
    const body =
      game.i18n?.format?.("SPACEHOLDER.ActionChatJournal.ConfirmBulkUndoBody", { count: String(affectedCount) }) ||
      `This undo will affect ${affectedCount} subsequent actions. Continue?`;
    const okLabel = game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.ConfirmUndo") || "Undo";
    const cancelLabel = game.i18n?.localize?.("SPACEHOLDER.Actions.Cancel") || "Cancel";
    const accepted = await foundry.applications.api.DialogV2.wait({
      window: { title },
      content: `<p>${_esc(body)}</p>`,
      buttons: [
        { action: "yes", label: okLabel, default: true },
        { action: "no", label: cancelLabel },
      ],
    });
    if (accepted !== "yes") return;
  }
  const actorUuid = btn.getAttribute("data-actor-uuid") || "";
  const transactionId = btn.getAttribute("data-transaction-id") || "";
  const movementId = btn.getAttribute("data-movement-id") || "";
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
      const isGroupUndo = undoScope === "group";
      await markJournalLineUndoneInMessage(fresh, lineId, {
        cascadeSubsequentMoves: !isGroupUndo && !nested && lineKind === "move",
        undoWholeMoveGroup: isGroupUndo,
      });
    } catch (e) {
      console.warn("SpaceHolder | journal message update failed", e);
    }
  }
}

let _delegatedJournalUiInstalled = false;
let _undoPreviewHoverBtn = null;

function _installDelegatedJournalUiOnce() {
  if (_delegatedJournalUiInstalled || typeof document === "undefined") return;
  _delegatedJournalUiInstalled = true;

  document.addEventListener(
    "click",
    (ev) => {
      const t = ev.target;
      if (!t?.closest) return;
      const toggle = t.closest('[data-action="sh-journal-toggle"]');
      if (toggle?.closest?.('[data-spaceholder-action-journal="1"]')) {
        ev.preventDefault();
        ev.stopPropagation();
        _applyJournalToggleClick(toggle);
        return;
      }
      const expand = t.closest('[data-action="sh-journal-toggle-move-group"]');
      if (expand?.closest?.('[data-spaceholder-action-journal="1"]')) {
        const message = _getChatMessageForJournalControl(expand);
        if (!message) return;
        ev.preventDefault();
        ev.stopPropagation();
        const gid = expand.getAttribute("data-group-id") || "";
        void _toggleMoveGroupExpandedInMessage(message, gid);
        return;
      }
      const undo = t.closest('[data-action="sh-journal-undo"]');
      if (!undo?.closest?.('[data-spaceholder-action-journal="1"]')) return;
      const message = _getChatMessageForJournalControl(undo);
      if (!message) return;
      ev.preventDefault();
      ev.stopPropagation();
      void _applyJournalUndoClick(undo, message);
    },
    true
  );

  document.addEventListener(
    "mouseover",
    (ev) => {
      const btn = ev.target?.closest?.('[data-action="sh-journal-undo"]');
      if (!btn || !btn.closest?.('[data-spaceholder-action-journal="1"]')) return;
      if (_undoPreviewHoverBtn === btn) return;
      _undoPreviewHoverBtn = btn;
      const root = btn.closest('[data-spaceholder-action-journal="1"]');
      _removeCascadePreview(root);
      const lineKind = btn.getAttribute("data-line-kind") || "";
      const combatId = btn.getAttribute("data-combat-id") || "";
      const combatEventId = btn.getAttribute("data-combat-event-id") || "";
      const tokenUuid = btn.getAttribute("data-token-uuid") || "";
      const mgr = game.spaceholder?.combatSessionManager;
      if (!mgr?.requestJournalUndoPreviewFromClient || !combatId || !combatEventId) return;
      void (async () => {
        try {
          const preview = await mgr.requestJournalUndoPreviewFromClient({
            combatId,
            targetEventId: combatEventId,
            lineKind,
            tokenUuid: tokenUuid || null,
          });
          if (!preview?.ok) return;
          _applyCascadePreviewByEventIds(preview.cascadeMoveEventIds || []);
        } catch (_) {
          /* ignore */
        }
      })();
    },
    true
  );

  document.addEventListener(
    "mouseout",
    (ev) => {
      const btn = ev.target?.closest?.('[data-action="sh-journal-undo"]');
      if (!btn) return;
      const rel = ev.relatedTarget;
      if (rel && btn.contains(rel)) return;
      if (_undoPreviewHoverBtn === btn) _undoPreviewHoverBtn = null;
      _removeCascadePreview(btn.closest('[data-spaceholder-action-journal="1"]'));
    },
    true
  );
}

/**
 * Sync DOM state when Foundry re-renders a journal message (collapse details, aria).
 * Clicks use document-level delegation so messages already in the log on load still work.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
function _bindJournalUndoButtons(message, html) {
  const root = html?.jquery ? html[0] : html;
  if (!root?.querySelectorAll) return;
  _ensureCollapsedDescriptionState(root);
}

export function installActionChatJournalHooks() {
  if (typeof Hooks === "undefined") return;
  _installDelegatedJournalUiOnce();
  const onRender = (message, html) => {
    try {
      if (!message?.flags?.[MODULE_NS]?.[FLAG_JOURNAL]) return;
      const journalRoot = _resolveActionJournalRoot(html);
      if (!journalRoot) return;
      _bindJournalUndoButtons(message, journalRoot);
    } catch (_) {
      /* ignore */
    }
  };
  Hooks.on("renderChatMessageHTML", onRender);
}

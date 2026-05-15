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
  const oldId = message.id;
  const createData = _chatMessageCreatePayloadFromExisting(message, {
    content,
    moduleFlags: {
      [FLAG_JOURNAL]: journalFlags,
    },
  });
  const fresh = await ChatMessage.create(createData);
  if (!fresh?.id) return message;

  // Снимаем старую DOM-строку синхронно сразу после резолва create, не вставляя
  // между ними await — иначе браузер успевает нарисовать кадр, в котором уже виден
  // новый чат-узел, но ещё не убран старый.
  _removeChatMessageDomNow(oldId);

  // Пойнтер на актёре и удаление старого документа — в фоне: для визуальной
  // последовательности «новое в DOM → старое из DOM» они не нужны.
  _syncRoundChatMessagePointer(fresh, anchorActor).catch((err) => {
    console.warn("SpaceHolder | failed to sync round chat message pointer", err);
  });
  message.delete().catch((err) => {
    console.warn("SpaceHolder | failed to delete replaced journal message", err);
  });

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
    distance: Math.max(0, Number(line.distance) || 0),
    units: String(line.units || ""),
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

/**
 * Flatten ordered move references across lines for cascading-deletion lookup.
 * @param {object[]} lines
 * @returns {Array<{type:'top-move'|'segment'|'reaction-move', i:number, si?:number, ri?:number, tokenUuid:string}>}
 */
function _flattenMoveRefs(lines) {
  const refs = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (l.kind === "moveGroup") {
      const segs = Array.isArray(l.segments) ? l.segments : [];
      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        refs.push({ type: "segment", i, si, tokenUuid: String(seg?.tokenUuid || "") });
        const reacts = Array.isArray(seg?.reactions) ? seg.reactions : [];
        for (let ri = 0; ri < reacts.length; ri++) {
          const r = reacts[ri];
          if (String(r?.kind) === "move") {
            refs.push({
              type: "reaction-move",
              i,
              si,
              ri,
              tokenUuid: String(r?.tokenUuid || ""),
            });
          }
        }
      }
    } else if (l.kind === "move") {
      refs.push({ type: "top-move", i, tokenUuid: String(l?.tokenUuid || "") });
    }
  }
  return refs;
}

/**
 * Determine which move refs would be deleted by an undo at `loc`.
 * Shared by actual deletion and preview/hover so both stay in lockstep.
 * @param {object[]} lines
 * @param {object} loc - location returned by _findLineLocation
 * @returns {{ refs: ReturnType<typeof _flattenMoveRefs>, refsToDelete: Set<number> }}
 */
function _selectMoveDeletionsAt(lines, loc) {
  const refs = _flattenMoveRefs(lines);
  let tokenKey = "";
  let groupOnlyIdx = null;
  let startRefIdx = -1;

  if (loc.type === "group") {
    groupOnlyIdx = loc.index;
    const firstSeg = loc.line?.segments?.[0];
    tokenKey = String(firstSeg?.tokenUuid || "");
    startRefIdx = refs.findIndex((r) => r.i === loc.index);
  } else if (loc.type === "top") {
    tokenKey = String(loc.line?.tokenUuid || "");
    startRefIdx = refs.findIndex((r) => r.type === "top-move" && r.i === loc.index);
  } else if (loc.type === "segment") {
    const seg = lines[loc.groupIndex]?.segments?.[loc.segIndex];
    tokenKey = String(seg?.tokenUuid || "");
    startRefIdx = refs.findIndex(
      (r) => r.type === "segment" && r.i === loc.groupIndex && r.si === loc.segIndex
    );
  } else if (loc.type === "reaction") {
    const r = lines[loc.groupIndex]?.segments?.[loc.segIndex]?.reactions?.[loc.reactIndex];
    tokenKey = String(r?.tokenUuid || "");
    startRefIdx = refs.findIndex(
      (rr) =>
        rr.type === "reaction-move" &&
        rr.i === loc.groupIndex &&
        rr.si === loc.segIndex &&
        rr.ri === loc.reactIndex
    );
  }

  const refsToDelete = new Set();
  if (startRefIdx < 0 && groupOnlyIdx === null) return { refs, refsToDelete };

  for (let k = 0; k < refs.length; k++) {
    const r = refs[k];
    const matchToken = !!tokenKey && r.tokenUuid === tokenKey;
    const inGroup = groupOnlyIdx !== null && r.i === groupOnlyIdx;
    const passesStart = startRefIdx >= 0 && k >= startRefIdx;
    if (inGroup || (passesStart && matchToken)) refsToDelete.add(k);
  }
  return { refs, refsToDelete };
}

/**
 * Identify what the user "directly" targeted, so cascade preview can subtract it
 * from the deletion set when reporting the surprise count.
 * @returns {(ref: object) => boolean}
 */
function _isUserClickedRef(loc) {
  return (r) => {
    if (loc.type === "top") return r.type === "top-move" && r.i === loc.index;
    if (loc.type === "segment")
      return r.type === "segment" && r.i === loc.groupIndex && r.si === loc.segIndex;
    if (loc.type === "reaction")
      return (
        r.type === "reaction-move" &&
        r.i === loc.groupIndex &&
        r.si === loc.segIndex &&
        r.ri === loc.reactIndex
      );
    return false;
  };
}

/**
 * Compute cascade preview directly from a journal message — matches what
 * `_deleteMovesCascading` will actually drop. This avoids mismatches with
 * combat-table queries (cross-combatant reactions, ghost rows already marked
 * `ignored` on the GM side, etc.).
 * @param {ChatMessage} message
 * @param {string} lineId
 * @param {string} undoScope - "group" or ""
 * @returns {{ totalDeletes: number, cascadeAfter: number, cascadeEventIds: string[], cascadeLineIds: string[] }}
 */
function _computeJournalCascadePreview(message, lineId, undoScope) {
  const empty = { totalDeletes: 0, cascadeAfter: 0, cascadeEventIds: [], cascadeLineIds: [] };
  if (!message?.id) return empty;
  const fj = message.flags?.[MODULE_NS]?.[FLAG_JOURNAL];
  const lines = Array.isArray(fj?.lines) ? fj.lines : [];
  const loc = _findLineLocation(lines, lineId);
  if (!loc) return empty;

  const undoWholeMoveGroup = undoScope === "group";
  let targetKind = "";
  if (loc.type === "top") targetKind = String(loc.line?.kind || "");
  else if (loc.type === "group") targetKind = "moveGroup";
  else if (loc.type === "segment") targetKind = "move";
  else if (loc.type === "reaction") {
    const r = lines[loc.groupIndex]?.segments?.[loc.segIndex]?.reactions?.[loc.reactIndex];
    targetKind = String(r?.kind || "");
  }
  const isMoveDelete =
    (loc.type === "group" && undoWholeMoveGroup) ||
    loc.type === "segment" ||
    (loc.type === "top" && targetKind === "move") ||
    (loc.type === "reaction" && targetKind === "move");
  if (!isMoveDelete) return empty;

  const { refs, refsToDelete } = _selectMoveDeletionsAt(lines, loc);
  if (!refsToDelete.size) return empty;

  const isClicked = _isUserClickedRef(loc);
  const cascadeEventIds = [];
  const cascadeLineIds = [];
  let cascadeAfter = 0;

  for (const k of refsToDelete) {
    const r = refs[k];
    // For group-undo the "target" is the whole group, so in-group deletions are expected.
    if (undoWholeMoveGroup && loc.type === "group" && r.i === loc.index) continue;
    if (!undoWholeMoveGroup && isClicked(r)) continue;
    cascadeAfter += 1;
    let evt = "";
    let id = "";
    if (r.type === "top-move") {
      const l = lines[r.i] || {};
      evt = String(l.combatEventId || "");
      id = String(l.id || "");
    } else if (r.type === "segment") {
      const seg = lines[r.i]?.segments?.[r.si] || {};
      evt = String(seg.combatEventId || "");
      id = String(seg.id || "");
    } else if (r.type === "reaction-move") {
      const re = lines[r.i]?.segments?.[r.si]?.reactions?.[r.ri] || {};
      evt = String(re.combatEventId || "");
      id = String(re.id || "");
    }
    if (evt) cascadeEventIds.push(evt);
    if (id) cascadeLineIds.push(id);
  }
  return {
    totalDeletes: refsToDelete.size,
    cascadeAfter,
    cascadeEventIds,
    cascadeLineIds,
  };
}

/**
 * Delete a movement (and cascade subsequent same-token movements). Strict storage on the
 * combat-log side already drops cascaded movements, so the journal must mirror that.
 * @param {object[]} lines
 * @param {object} loc - location returned by _findLineLocation
 * @returns {object[]} new lines array
 */
function _deleteMovesCascading(lines, loc) {
  const { refs, refsToDelete } = _selectMoveDeletionsAt(lines, loc);
  if (!refsToDelete.size) return lines;

  const removeTopIdxs = new Set();
  const removeSegByGroup = new Map();
  const removeReactByGroupSeg = new Map();

  for (const k of refsToDelete) {
    const r = refs[k];
    if (r.type === "top-move") {
      removeTopIdxs.add(r.i);
    } else if (r.type === "segment") {
      if (!removeSegByGroup.has(r.i)) removeSegByGroup.set(r.i, new Set());
      removeSegByGroup.get(r.i).add(r.si);
    } else if (r.type === "reaction-move") {
      const key = `${r.i}:${r.si}`;
      if (!removeReactByGroupSeg.has(key)) removeReactByGroupSeg.set(key, new Set());
      removeReactByGroupSeg.get(key).add(r.ri);
    }
  }

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l?.kind === "moveGroup") {
      const segDel = removeSegByGroup.get(i) || new Set();
      const newSegs = [];
      const segs = Array.isArray(l.segments) ? l.segments : [];
      for (let si = 0; si < segs.length; si++) {
        if (segDel.has(si)) continue;
        const seg = segs[si];
        const reactDel = removeReactByGroupSeg.get(`${i}:${si}`) || new Set();
        if (reactDel.size) {
          const newReacts = (seg.reactions || []).filter((_, ri) => !reactDel.has(ri));
          newSegs.push({ ...seg, reactions: newReacts });
        } else {
          newSegs.push(seg);
        }
      }
      if (newSegs.length === 0) continue;
      out.push({ ...l, segments: newSegs });
    } else {
      if (removeTopIdxs.has(i)) continue;
      out.push(l);
    }
  }
  return out;
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

function _renderApChipHtml(apCost) {
  const ap = Math.max(0, Number(apCost) || 0);
  if (ap <= 0) return `<span class="spaceholder-action-journal__cost"></span>`;
  return `<span class="spaceholder-action-journal__cost"><span class="spaceholder-action-journal__ap-chip">${_esc(ap)}</span></span>`;
}

/**
 * @param {object} line
 * @param {{ reactionLabel: string, detailsLabel: string, nested?: boolean }} ctx
 */
function _renderStandardRowHtml(line, ctx) {
  const label = _esc(line.label || "");
  const description = String(line.description || "").trim();
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
        <span class="spaceholder-action-journal__text">${label}</span>
      </span>
      ${_renderApChipHtml(line.apCost)}
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
  let apSum = 0;
  let distSum = 0;
  for (const s of segs) {
    apSum += Math.max(0, Number(s?.apCost) || 0);
    distSum += Math.max(0, Number(s?.distance) || 0);
  }
  const groupUnits = String(
    segs.find((s) => s?.units)?.units || canvas?.scene?.grid?.units || ""
  ).trim();
  const distText = groupUnits ? `${distSum.toFixed(1)} ${groupUnits}` : distSum.toFixed(1);
  const summary = segs.length > 1 ? `×${segs.length} · ${distText}` : distText;
  const groupUndone = segs.length > 0 && segs.every((s) => s.undone);
  const firstUndoable = first && first.undoable !== false && !first.undone;
  const rowClass = `spaceholder-action-journal__row spaceholder-action-journal__row--move spaceholder-action-journal__row--movegroup spaceholder-action-journal__movegroup${groupUndone ? " spaceholder-action-journal__row--undone" : ""}`;
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
          const segDist = Math.max(0, Number(seg.distance) || 0);
          const segUnits = String(seg.units || groupUnits || "").trim();
          const segLabel = String(
            seg.label || (segUnits ? `${segDist.toFixed(1)} ${segUnits}` : segDist.toFixed(1))
          );
          const line = {
            id: seg.id,
            kind: "move",
            label: segLabel,
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
          const undone = !!seg.undone;
          const rowClassS = `spaceholder-action-journal__row spaceholder-action-journal__row--move spaceholder-action-journal__row--move-segment${undone ? " spaceholder-action-journal__row--undone" : ""} spaceholder-action-journal__row--nested`;
          return `<li class="${rowClassS}" data-line-id="${_esc(seg.id || "")}" data-event-id="${_esc(seg.combatEventId || "")}">
            <span class="spaceholder-action-journal__main">
              <span class="spaceholder-action-journal__kind"><i class="fa-solid fa-shoe-prints" aria-hidden="true"></i></span>
              <span class="spaceholder-action-journal__text">${_esc(segLabel)}</span>
            </span>
            ${_renderApChipHtml(seg.apCost)}
            <span class="spaceholder-action-journal__tools">${detailToggle}${_renderUndoButton(line, { nested: true })}</span>
            ${details}
            ${reacts ? `<ul class="spaceholder-action-journal__sublist">${reacts}</ul>` : ""}
          </li>`;
        })
        .join("")
    : "";

  const firstEvt = first?.combatEventId || "";
  const chevronBtn = segs.length > 1
    ? `<button type="button" class="spaceholder-action-journal__toggle spaceholder-action-journal__toggle--chevron" data-action="sh-journal-toggle-move-group"
        data-group-id="${_esc(group.id)}"
        aria-expanded="${expanded ? "true" : "false"}"
        title="${_esc(expandTitle)}"><i class="${chevron}" aria-hidden="true"></i></button>`
    : "";

  return `<li class="${rowClass}" data-line-id="${_esc(group.id || "")}" data-event-id="${_esc(firstEvt)}">
    <span class="spaceholder-action-journal__main">
      <span class="spaceholder-action-journal__kind"><i class="fa-solid fa-shoe-prints" aria-hidden="true"></i></span>
      <span class="spaceholder-action-journal__text">${_esc(summary)}</span>
    </span>
    ${_renderApChipHtml(apSum)}
    <span class="spaceholder-action-journal__tools">
      ${chevronBtn}
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
  distance = 0,
  units = "",
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
      distance: Math.max(0, Number(distance) || 0),
      units: String(units || ""),
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
 * Apply a journal undo for the given line:
 *   - Movements are DELETED (not marked "undone") and cascade-delete every later
 *     movement of the same token. Combat-log storage already drops cascaded moves
 *     on undo, so the journal must mirror that or rows turn into ghost references.
 *   - Whole-moveGroup undo deletes the entire group plus same-token cascade after it.
 *   - Non-move actions/reactions keep the legacy "undone" mark.
 * @param {ChatMessage} message
 * @param {string} lineId
 * @param {{ undoWholeMoveGroup?: boolean }} [opts]
 */
export async function markJournalLineUndoneInMessage(message, lineId, opts = {}) {
  if (!message?.id) return;
  const fj = message.flags?.[MODULE_NS]?.[FLAG_JOURNAL];
  let lines = Array.isArray(fj?.lines) ? _dup(fj.lines) : [];
  const loc = _findLineLocation(lines, lineId);
  if (!loc) return;

  const undoWholeMoveGroup = !!opts.undoWholeMoveGroup;

  let targetKind = "";
  if (loc.type === "top") targetKind = String(loc.line?.kind || "");
  else if (loc.type === "group") targetKind = "moveGroup";
  else if (loc.type === "segment") targetKind = "move";
  else if (loc.type === "reaction") {
    const r = lines[loc.groupIndex]?.segments?.[loc.segIndex]?.reactions?.[loc.reactIndex];
    targetKind = String(r?.kind || "");
  }

  const isMoveDelete =
    (loc.type === "group" && undoWholeMoveGroup) ||
    loc.type === "segment" ||
    (loc.type === "top" && targetKind === "move") ||
    (loc.type === "reaction" && targetKind === "move");

  if (isMoveDelete) {
    lines = _deleteMovesCascading(lines, loc);
  } else if (loc.type === "top") {
    const target = loc.line;
    if (target?.undoable === false) return;
    if (target.kind === "moveGroup") return;
    lines[loc.index] = { ...target, undone: true };
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
  } else {
    return;
  }

  const round = Math.max(1, Number(fj?.round) || 1);
  const title =
    game.i18n?.format?.("SPACEHOLDER.ActionChatJournal.Title", { round: String(round) }) ||
    `Round ${round}`;
  const content = buildActionJournalHtml(lines, round, title);
  const sh = { ...(message.flags?.[MODULE_NS] || {}) };
  sh[FLAG_JOURNAL] = { ...fj, schema: JOURNAL_SCHEMA, round, lines };

  // Resolve anchor before lines were emptied so the actor pointer can follow the
  // replacement message id even when deletion wiped every line referencing the actor.
  let anchorActor = null;
  const anchorUuid = _extractActorUuidFromJournalLines(fj?.lines);
  if (anchorUuid) {
    try {
      const doc = await fromUuid(anchorUuid);
      if (doc?.documentName === "Actor") anchorActor = doc;
    } catch (_) {
      anchorActor = null;
    }
  }

  await _replaceJournalMessage(message, {
    content,
    journalFlags: sh[FLAG_JOURNAL],
    anchorActor,
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
  const combatId = btn.getAttribute("data-combat-id") || "";
  const combatEventId = btn.getAttribute("data-combat-event-id") || "";
  const tokenUuid = btn.getAttribute("data-token-uuid") || "";
  const undoScope = btn.getAttribute("data-undo-scope") || "";
  // Cascade preview computed locally from this very journal message — mirrors
  // _deleteMovesCascading exactly, so reactions and cross-segment cascades are
  // counted, while phantom rows already removed never re-appear in the count.
  const preview = _computeJournalCascadePreview(message, lineId, undoScope);
  if (preview.cascadeAfter >= 1) {
    const title =
      game.i18n?.localize?.("SPACEHOLDER.ActionChatJournal.ConfirmBulkUndoTitle") || "Confirm undo";
    const body =
      game.i18n?.format?.("SPACEHOLDER.ActionChatJournal.ConfirmBulkUndoBody", {
        count: String(preview.cascadeAfter),
      }) ||
      `This undo will also drop ${preview.cascadeAfter} subsequent movement(s). Continue?`;
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
      await markJournalLineUndoneInMessage(fresh, lineId, {
        undoWholeMoveGroup: undoScope === "group",
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
      const lineId = btn.getAttribute("data-line-id") || "";
      const undoScope = btn.getAttribute("data-undo-scope") || "";
      const message = _getChatMessageForJournalControl(btn);
      if (!message || !lineId) return;
      const preview = _computeJournalCascadePreview(message, lineId, undoScope);
      if (preview.cascadeAfter > 0) _applyCascadePreviewByEventIds(preview.cascadeEventIds);
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

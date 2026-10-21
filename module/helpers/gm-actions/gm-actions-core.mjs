/**
 * GM actions — pure core (no Foundry globals): queue entry shape, ordering, grouping by
 * category and the apply/cancel decision. The manager, UI and Foundry glue build on this.
 *
 * A "GM action" is anything a player's client needs done with GM permissions (e.g. damage to a
 * token the player does not own). It is unrelated to human GM approval workflows.
 */

/** Flag scope used on User and ChatMessage documents. */
export const GM_ACTION_SCOPE = 'spaceholder';
/** User flag: `{ [entryId]: entry }` — the requester's own queue of actions waiting for a GM. */
export const GM_QUEUE_FLAG = 'gmQueue';
/** ChatMessage flag: `{ [entryId]: status }` — drives the "awaits GM / cancelled / failed" note. */
export const GM_CHAT_FLAG = 'gmActions';

export const GM_ACTION_STATUS = Object.freeze({
  PENDING: 'pending',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

export const GM_ACTION_DEFAULT_CATEGORY = 'misc';

/**
 * Entry id: sortable by time, no dots (it is used inside dotted update paths).
 * @param {number} now ms timestamp
 * @param {string} userId
 * @param {number} seq per-client counter
 * @returns {string}
 */
export function makeEntryId(now, userId, seq) {
  const uid = String(userId ?? 'user').replace(/[^A-Za-z0-9_-]/g, '');
  return `${Math.max(0, Math.floor(Number(now) || 0)).toString(36)}-${uid}-${Math.max(0, Math.floor(Number(seq) || 0))}`;
}

/**
 * @param {object} args
 * @param {string} args.type registered action type
 * @param {unknown} args.payload JSON-serializable payload (deep-copied through JSON)
 * @param {string} [args.category]
 * @param {string} [args.label] human description shown in chat and in the GM queue window
 * @param {string} args.requesterId
 * @param {string} [args.requesterName]
 * @param {string|null} [args.chatMessageId] message to annotate while the action waits
 * @param {number} args.now
 * @param {number} args.seq
 * @returns {object} queue entry
 */
export function createQueueEntry({
  type,
  payload,
  category,
  label = '',
  requesterId,
  requesterName = '',
  chatMessageId = null,
  now,
  seq,
}) {
  const t = String(type ?? '').trim();
  if (!t) throw new Error('gm-actions: action type is required');
  return {
    id: makeEntryId(now, requesterId, seq),
    type: t,
    category: String(category ?? '').trim() || GM_ACTION_DEFAULT_CATEGORY,
    label: String(label ?? ''),
    payload: payload === undefined ? {} : JSON.parse(JSON.stringify(payload)),
    requesterId: String(requesterId ?? ''),
    requesterName: String(requesterName ?? ''),
    chatMessageId: chatMessageId ? String(chatMessageId) : null,
    createdAt: Math.floor(Number(now) || 0),
  };
}

/**
 * Validate an entry that arrived over the socket or was read from a flag.
 * @param {unknown} raw
 * @returns {object|null} normalized entry or null when unusable
 */
export function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  const type = String(raw.type ?? '').trim();
  if (!id || !type) return null;
  return {
    id,
    type,
    category: String(raw.category ?? '').trim() || GM_ACTION_DEFAULT_CATEGORY,
    label: String(raw.label ?? ''),
    payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {},
    requesterId: String(raw.requesterId ?? '').trim(),
    requesterName: String(raw.requesterName ?? ''),
    chatMessageId: raw.chatMessageId ? String(raw.chatMessageId) : null,
    createdAt: Math.floor(Number(raw.createdAt) || 0),
  };
}

/**
 * Chronological copy (ties broken by id) — also the order actions are applied in.
 * @param {object[]} entries
 * @returns {object[]}
 */
export function orderEntries(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort((a, b) =>
    (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id)));
}

/**
 * Group entries by category for the GM window. Groups are ordered by their earliest entry, entries
 * inside a group chronologically.
 * @param {object[]} entries
 * @returns {Array<{category: string, entries: object[]}>}
 */
export function groupEntriesByCategory(entries) {
  const groups = new Map();
  for (const entry of orderEntries(entries)) {
    const key = entry.category || GM_ACTION_DEFAULT_CATEGORY;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()].map(([category, list]) => ({ category, entries: list }));
}

/**
 * Split the queue into what to apply and what to cancel from the GM's selection.
 * @param {object[]} entries
 * @param {Iterable<string>|null} selectedIds ids to apply; `null` applies everything
 * @returns {{ apply: object[], cancel: object[] }} both in chronological order
 */
export function planDecision(entries, selectedIds) {
  const ordered = orderEntries(entries);
  if (selectedIds == null) return { apply: ordered, cancel: [] };
  const selected = new Set(selectedIds);
  return {
    apply: ordered.filter((e) => selected.has(e.id)),
    cancel: ordered.filter((e) => !selected.has(e.id)),
  };
}

/**
 * Count the statuses of a chat message's `gmActions` flag.
 * @param {Record<string, string>|null|undefined} map
 * @returns {{ pending: number, cancelled: number, failed: number }}
 */
export function summarizeChatStatuses(map) {
  const out = { pending: 0, cancelled: 0, failed: 0 };
  if (!map || typeof map !== 'object') return out;
  for (const status of Object.values(map)) {
    if (status === GM_ACTION_STATUS.PENDING) out.pending += 1;
    else if (status === GM_ACTION_STATUS.CANCELLED) out.cancelled += 1;
    else if (status === GM_ACTION_STATUS.FAILED) out.failed += 1;
  }
  return out;
}

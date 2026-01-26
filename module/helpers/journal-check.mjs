// Journal Check helper for SpaceHolder system (Foundry v13)
// Adds multi-state workflow flags to JournalEntry and JournalEntryPage.

const MODULE_NS = 'spaceholder';
const FLAG_ROOT = 'journalCheck';
const TIMELINE_FLAG_ROOT = 'timeline';

function _getTimelineFlagObj(doc) {
  try {
    return doc?.getFlag?.(MODULE_NS, TIMELINE_FLAG_ROOT) ?? doc?.flags?.[MODULE_NS]?.[TIMELINE_FLAG_ROOT] ?? {};
  } catch (_) {
    return {};
  }
}

function _isTimelineContainer(entry) {
  const f = _getTimelineFlagObj(entry);
  return !!f?.isContainer;
}

function _isTimelinePage(page) {
  const f = _getTimelineFlagObj(page);
  if (f?.isEntry) return true;
  return _isTimelineContainer(page?.parent);
}

const SETTING_SHOW_ICONS = 'journalcheck.showIcons';
const SETTING_GM_SKIP = 'journalcheck.gmSkipProposed';

// Approval history (world)
const SETTING_APPROVAL_HISTORY = 'journalcheck.approvalHistory';
const APPROVAL_HISTORY_LIMIT = 200;

const STATUS = {
  DRAFT: 'draft',
  PROPOSED: 'proposed',
  APPROVED: 'approved',
};

const STATUS_ORDER = {
  [STATUS.DRAFT]: 0,
  [STATUS.PROPOSED]: 1,
  [STATUS.APPROVED]: 2,
};

let _hooksInstalled = false;

function _isValidStatus(s) {
  return s === STATUS.DRAFT || s === STATUS.PROPOSED || s === STATUS.APPROVED;
}

function _normalizeStatus(raw) {
  const s = String(raw ?? '').trim();
  return _isValidStatus(s) ? s : STATUS.DRAFT;
}

function _getFlagObj(doc) {
  return doc?.getFlag?.(MODULE_NS, FLAG_ROOT) ?? {};
}

function _getRawStatus(doc) {
  return _getFlagObj(doc)?.status;
}

export function getStatus(doc) {
  if (!doc) return STATUS.DRAFT;
  return _normalizeStatus(_getRawStatus(doc));
}

export function computeEntryStatusFromPages(entry) {
  const pages = entry?.pages?.contents ?? [];
  if (!pages.length) return getStatus(entry);

  let weakest = STATUS.APPROVED;
  let weakestOrder = STATUS_ORDER[weakest];

  for (const p of pages) {
    const s = _normalizeStatus(_getRawStatus(p));
    const order = STATUS_ORDER[s] ?? 0;
    if (order < weakestOrder) {
      weakest = s;
      weakestOrder = order;
      if (weakestOrder === 0) break;
    }
  }

  return weakest;
}

function _isOurUpdate(options) {
  return !!options?.spaceholderJournalCheck;
}

function _isUserGM(userId) {
  const u = game?.users?.get?.(userId);
  return !!u?.isGM;
}

function _currentUserIsActor(userId) {
  return !!userId && (userId === game?.user?.id);
}

function _getSetting(key, fallback) {
  try {
    return game.settings.get(MODULE_NS, key);
  } catch (_) {
    return fallback;
  }
}

function _randomId() {
  try {
    return foundry.utils.randomID?.();
  } catch (_) {
    // ignore
  }
  try {
    return globalThis.randomID?.();
  } catch (_) {
    // ignore
  }
  try {
    return globalThis.crypto?.randomUUID?.();
  } catch (_) {
    // ignore
  }
  return String(Date.now());
}

function _escapeHtml(raw) {
  const s = String(raw ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function _getApprovalHistoryRaw() {
  const raw = _getSetting(SETTING_APPROVAL_HISTORY, []);
  return Array.isArray(raw) ? raw : [];
}

export function getApprovalHistory({ limit = APPROVAL_HISTORY_LIMIT } = {}) {
  const raw = _getApprovalHistoryRaw();
  const lim = Math.max(0, Number(limit) || 0);
  if (!lim) return raw;
  return raw.slice(0, lim);
}

async function _appendApprovalHistoryBatch(batch) {
  const raw = _getApprovalHistoryRaw();
  const next = [batch, ...raw].slice(0, APPROVAL_HISTORY_LIMIT);
  await game.settings.set(MODULE_NS, SETTING_APPROVAL_HISTORY, next);
}

function _getAllPlayersOwnershipLevel(doc, { _depth = 0, _seen = null } = {}) {
  try {
    if (!doc) return 0;

    const depth = Number(_depth) || 0;
    if (depth > 10) return 0;

    const seen = _seen instanceof Set ? _seen : new Set();
    if (seen.has(doc)) return 0;
    seen.add(doc);

    const own = doc?.ownership ?? doc?.data?.ownership ?? null;
    const v = (own && typeof own === 'object') ? (own.default ?? own['default']) : null;
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;

    const INHERIT = (() => {
      try {
        return CONST.DOCUMENT_OWNERSHIP_LEVELS.INHERIT;
      } catch (_) {
        return -1;
      }
    })();

    // JournalEntryPage defaults to INHERIT, meaning it inherits permissions from its parent JournalEntry.
    if (n === INHERIT) {
      if (doc.parent) return _getAllPlayersOwnershipLevel(doc.parent, { _depth: depth + 1, _seen: seen });
      return 0;
    }

    return n;
  } catch (_) {
    return 0;
  }
}

function _canAllPlayersObserve(doc) {
  const lvl = _getAllPlayersOwnershipLevel(doc);
  try {
    return lvl >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
  } catch (_) {
    return lvl >= 2;
  }
}

function _buildApprovalTreeForAllPlayers(items) {
  const entries = new Map();
  const hiddenEntryIds = new Set();

  const ensureEntry = (entry) => {
    if (!entry?.id) return null;
    if (!entries.has(entry.id)) {
      entries.set(entry.id, { entry, pages: [], hasLeafEntry: false });
    }
    return entries.get(entry.id);
  };

  for (const it of (Array.isArray(items) ? items : [])) {
    const type = String(it?.type ?? '');
    const entryId = String(it?.entryId ?? '').trim();
    if (!entryId) continue;

    const entry = game.journal?.get?.(entryId) ?? null;
    if (!entry) continue;

    if (!_canAllPlayersObserve(entry)) {
      hiddenEntryIds.add(entryId);
      continue;
    }

    const bucket = ensureEntry(entry);
    if (!bucket) continue;

    if (type === 'entry') {
      bucket.hasLeafEntry = true;
      continue;
    }

    if (type === 'page') {
      const pageId = String(it?.pageId ?? '').trim();
      if (!pageId) continue;

      const page = entry.pages?.get?.(pageId) ?? null;
      const canSeePage = page ? _canAllPlayersObserve(page) : false;

      const rawName = String(page?.name ?? '').trim();
      const name = canSeePage ? (rawName || '(без названия)') : 'Неизвестно';

      bucket.pages.push({
        pageId,
        name,
      });
    }
  }

  const out = [];
  for (const v of entries.values()) {
    if (!v) continue;
    if (!v.hasLeafEntry && (!v.pages || !v.pages.length)) continue;

    out.push({
      entry: v.entry,
      name: String(v.entry?.name ?? '').trim(),
      pages: v.pages ?? [],
      hasLeafEntry: !!v.hasLeafEntry,
    });
  }

  return { tree: out, unknownEntriesCount: hiddenEntryIds.size };
}

function _renderApprovalChatHtml(tree, { title = 'Подтверждены журналы:', unknownEntriesCount = 0 } = {}) {
  const hasTree = Array.isArray(tree) && tree.length;
  const unknown = Math.max(0, Number(unknownEntriesCount) || 0);

  if (!hasTree && !unknown) return '';

  const lines = [];
  lines.push(`<div class="spaceholder-journal-update-chat">`);
  lines.push(`<div class="sh-jul-chat__title">${_escapeHtml(title)}</div>`);

  if (hasTree) {
    lines.push(`<ul class="sh-jul-chat__list">`);

    for (const node of tree) {
      const entryName = _escapeHtml(node?.name ?? '');
      lines.push(`<li class="sh-jul-chat__entry">${entryName}`);

      const pages = Array.isArray(node?.pages) ? node.pages : [];
      if (pages.length) {
        lines.push('<ul class="sh-jul-chat__pages">');
        for (const p of pages) {
          lines.push(`<li class="sh-jul-chat__page">${_escapeHtml(p?.name ?? '')}</li>`);
        }
        lines.push('</ul>');
      }

      lines.push('</li>');
    }

    lines.push('</ul>');
  }

  if (unknown) {
    lines.push(`<div class="sh-jul-chat__unknown">И ещё ${unknown} неизвестных журналов</div>`);
  }

  lines.push('</div>');

  return lines.join('');
}

async function _sendApprovalChatMessages(items) {
  const speaker = (() => {
    try { return ChatMessage.getSpeaker({ alias: 'Журналы' }); } catch (_) {}
    try { return ChatMessage.getSpeaker(); } catch (_) {}
    return {};
  })();

  const { tree, unknownEntriesCount } = _buildApprovalTreeForAllPlayers(items);
  const content = _renderApprovalChatHtml(tree, { unknownEntriesCount });
  if (!content) return;

  try {
    await ChatMessage.create({ content, speaker });
  } catch (e) {
    console.error('SpaceHolder | JournalCheck: failed to create approval chat message', e);
  }
}

export async function approveJournalItems(
  { entryIds = [], pageRefs = [] } = {},
  { source = 'bulk' } = {}
) {
  if (!game?.user?.isGM) return false;

  const now = Date.now();
  const gmId = game.user.id ?? null;

  const uniqueEntryIds = [...new Set((Array.isArray(entryIds) ? entryIds : []).map((x) => String(x ?? '').trim()).filter(Boolean))];
  const uniquePageRefs = [];
  {
    const seen = new Set();
    for (const r of (Array.isArray(pageRefs) ? pageRefs : [])) {
      const entryId = String(r?.entryId ?? '').trim();
      const pageId = String(r?.pageId ?? '').trim();
      if (!entryId || !pageId) continue;
      const k = `${entryId}:${pageId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniquePageRefs.push({ entryId, pageId });
    }
  }

  const fullEntryApprovals = []; // JournalEntry (approve all pages)
  const leafEntryApprovals = []; // JournalEntry (single-page)
  const pagesToApprove = new Map(); // key -> JournalEntryPage

  const coveredEntries = new Set();

  // Resolve entries
  for (const entryId of uniqueEntryIds) {
    const entry = game.journal?.get?.(entryId) ?? null;
    if (!entry) continue;
    if (!_canUserUpdate(entry)) continue;

    const pages = entry?.pages?.contents ?? [];
    if (pages.length > 1) {
      coveredEntries.add(entryId);
      fullEntryApprovals.push(entry);
    } else {
      leafEntryApprovals.push(entry);
    }
  }

  // Resolve pages (ignore those covered by full-entry approvals)
  for (const ref of uniquePageRefs) {
    if (coveredEntries.has(ref.entryId)) continue;

    const entry = game.journal?.get?.(ref.entryId) ?? null;
    if (!entry) continue;

    const page = entry.pages?.get?.(ref.pageId) ?? null;
    if (!page) continue;
    if (!_canUserUpdate(page)) continue;

    pagesToApprove.set(`${entry.id}:${page.id}`, page);
  }

  // Build log items (only those that will end up approved and are meaningful to log)
  const loggedItems = [];

  // Full entries -> log pages
  for (const entry of fullEntryApprovals) {
    const pages = entry?.pages?.contents ?? [];
    for (const p of pages) {
      if (getStatus(p) === STATUS.APPROVED) continue;
      loggedItems.push({ type: 'page', entryId: entry.id, pageId: p.id });
    }
  }

  // Leaf entries -> log entry
  for (const entry of leafEntryApprovals) {
    if (computeEntryStatusFromPages(entry) === STATUS.APPROVED) continue;
    loggedItems.push({ type: 'entry', entryId: entry.id });
  }

  // Individual pages -> log page
  for (const page of pagesToApprove.values()) {
    if (getStatus(page) === STATUS.APPROVED) continue;
    loggedItems.push({ type: 'page', entryId: page.parent?.id ?? '', pageId: page.id });
  }

  if (!loggedItems.length) return false;

  // Apply updates
  for (const entry of fullEntryApprovals) {
    await setEntryStatus(entry, STATUS.APPROVED, { reason: `approve-${source}`, applyToPages: true });
  }

  for (const entry of leafEntryApprovals) {
    await setEntryStatus(entry, STATUS.APPROVED, { reason: `approve-${source}`, applyToPages: true });
  }

  for (const page of pagesToApprove.values()) {
    await setPageStatus(page, STATUS.APPROVED, { reason: `approve-${source}`, syncParent: true });
  }

  // Persist history (newest first)
  const batch = {
    id: _randomId(),
    at: now,
    gmId,
    source: String(source ?? 'bulk'),
    items: loggedItems,
  };

  try {
    await _appendApprovalHistoryBatch(batch);
  } catch (e) {
    console.error('SpaceHolder | JournalCheck: failed to append approval history', e);
  }

  // Chat notifications
  await _sendApprovalChatMessages(loggedItems);

  return true;
}

function _rerenderJournalUI() {
  try { ui.journal?.render(true); } catch (_) {}

  try {
    const inst = foundry?.applications?.instances;
    if (inst && typeof inst.values === 'function') {
      for (const app of inst.values()) {
        if (app?.constructor?.name === 'JournalEntrySheet') app.render(false);
      }
    }
  } catch (_) {}
}

export function registerJournalCheckSettings() {
  // Local toggle for showing status icons.
  game.settings.register(MODULE_NS, SETTING_SHOW_ICONS, {
    name: 'Journal Check: Show status icons',
    hint: 'Show status icons in Journal directory and multi-page TOC',
    scope: 'client',
    config: false,
    default: true,
    type: Boolean,
    onChange: () => _rerenderJournalUI(),
  });

  // GM-only behavior toggle (stored per-client).
  game.settings.register(MODULE_NS, SETTING_GM_SKIP, {
    name: 'Journal Check: GM skip proposed',
    hint: 'If enabled, GM can toggle Draft <-> Approved',
    scope: 'client',
    config: false,
    default: false,
    type: Boolean,
    onChange: () => _rerenderJournalUI(),
  });

  // World approval history (for Update Log)
  game.settings.register(MODULE_NS, SETTING_APPROVAL_HISTORY, {
    name: 'Journal Check: Approval history',
    hint: 'Stores last approval actions for the Update Log window',
    scope: 'world',
    config: false,
    restricted: true,
    default: [],
    type: Array,
    onChange: () => {
      try { Hooks.callAll('spaceholderJournalApprovalHistoryUpdated'); } catch (_) {}
    },
  });
}

export async function setEntryStatus(entry, newStatus, { reason = null, applyToPages = true } = {}) {
  if (!entry) return;

  const status = _normalizeStatus(newStatus);
  const oldStatus = computeEntryStatusFromPages(entry);

  const now = Date.now();
  const changedBy = game?.user?.id ?? null;

  // Update entry flag
  const entryUpdate = {
    [`flags.${MODULE_NS}.${FLAG_ROOT}.status`]: status,
    [`flags.${MODULE_NS}.${FLAG_ROOT}.changedAt`]: now,
    [`flags.${MODULE_NS}.${FLAG_ROOT}.changedBy`]: changedBy,
  };
  if (reason) entryUpdate[`flags.${MODULE_NS}.${FLAG_ROOT}.reason`] = String(reason);

  // Optionally cascade to pages first.
  // This avoids a state where the entry status changes, but embedded pages fail to update.
  if (applyToPages) {
    const pages = entry?.pages?.contents ?? [];
    if (pages.length) {
      const updates = pages.map((p) => {
        const u = {
          _id: p.id,
          [`flags.${MODULE_NS}.${FLAG_ROOT}.status`]: status,
          [`flags.${MODULE_NS}.${FLAG_ROOT}.changedAt`]: now,
          [`flags.${MODULE_NS}.${FLAG_ROOT}.changedBy`]: changedBy,
        };
        if (reason) u[`flags.${MODULE_NS}.${FLAG_ROOT}.reason`] = String(reason);
        return u;
      });

      await entry.updateEmbeddedDocuments('JournalEntryPage', updates, { spaceholderJournalCheck: true });
    }
  }

  await entry.update(entryUpdate, { spaceholderJournalCheck: true });

  Hooks.callAll('spaceholderJournalStatusChanged', entry, {
    oldStatus,
    newStatus: status,
    reason,
    userId: changedBy,
  });
}

export async function setPageStatus(page, newStatus, { reason = null, syncParent = true } = {}) {
  if (!page) return;

  const status = _normalizeStatus(newStatus);
  const oldStatus = getStatus(page);

  const now = Date.now();
  const changedBy = game?.user?.id ?? null;

  const pageUpdate = {
    [`flags.${MODULE_NS}.${FLAG_ROOT}.status`]: status,
    [`flags.${MODULE_NS}.${FLAG_ROOT}.changedAt`]: now,
    [`flags.${MODULE_NS}.${FLAG_ROOT}.changedBy`]: changedBy,
  };
  if (reason) pageUpdate[`flags.${MODULE_NS}.${FLAG_ROOT}.reason`] = String(reason);

  await page.update(pageUpdate, { spaceholderJournalCheck: true });

  Hooks.callAll('spaceholderJournalPageStatusChanged', page, {
    oldStatus,
    newStatus: status,
    reason,
    userId: changedBy,
  });

  if (syncParent) {
    const entry = page.parent;
    if (entry) await syncEntryStatusFromPages(entry, { reason: 'syncFromPage' });
  }
}

export async function syncEntryStatusFromPages(entry, { reason = null } = {}) {
  if (!entry) return;

  const computed = computeEntryStatusFromPages(entry);
  const current = getStatus(entry);
  if (current === computed) return;

  const now = Date.now();
  const changedBy = game?.user?.id ?? null;

  const update = {
    [`flags.${MODULE_NS}.${FLAG_ROOT}.status`]: computed,
    [`flags.${MODULE_NS}.${FLAG_ROOT}.changedAt`]: now,
    [`flags.${MODULE_NS}.${FLAG_ROOT}.changedBy`]: changedBy,
  };
  if (reason) update[`flags.${MODULE_NS}.${FLAG_ROOT}.reason`] = String(reason);

  await entry.update(update, { spaceholderJournalCheck: true });

  Hooks.callAll('spaceholderJournalStatusChanged', entry, {
    oldStatus: current,
    newStatus: computed,
    reason,
    userId: changedBy,
  });
}

function _statusIconDef(status) {
  switch (status) {
    case STATUS.APPROVED:
      return { icon: 'fa-solid fa-check', label: 'Одобрено' };
    case STATUS.PROPOSED:
      return { icon: 'fa-solid fa-lightbulb', label: 'Предложено' };
    case STATUS.DRAFT:
    default:
      return { icon: 'fa-solid fa-pen', label: 'Черновик' };
  }
}

function _makeStatusEl(status, { interactive = false } = {}) {
  const def = _statusIconDef(status);

  const wrap = document.createElement('span');
  wrap.classList.add('spaceholder-journalcheck-status', `sh-jc-status--${status}`);
  wrap.dataset.status = status;
  wrap.title = def.label;

  const icon = document.createElement('i');
  def.icon.split(' ').forEach((c) => icon.classList.add(c));
  icon.setAttribute('aria-hidden', 'true');
  wrap.appendChild(icon);

  if (interactive) {
    wrap.classList.add('is-interactive');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('aria-label', def.label);
  }

  return wrap;
}

function _canUserObserve(doc, user) {
  try {
    return !!doc?.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER);
  } catch (_) {
    return true;
  }
}

function _computeEntryPageStatusStats(entry, { user = null } = {}) {
  const u = user ?? game?.user ?? null;
  const pages = entry?.pages?.contents ?? [];

  const counts = {
    [STATUS.DRAFT]: 0,
    [STATUS.PROPOSED]: 0,
    [STATUS.APPROVED]: 0,
  };

  let hidden = 0;
  let total = 0;

  for (const p of pages) {
    if (!p) continue;
    total += 1;

    if (u && !_canUserObserve(p, u)) {
      hidden += 1;
      continue;
    }

    const s = getStatus(p);
    counts[s] = (counts[s] ?? 0) + 1;
  }

  return {
    total,
    hidden,
    visible: Math.max(0, total - hidden),
    counts,
  };
}

function _multiPageStatusTitle(stats) {
  const d = Number(stats?.counts?.[STATUS.DRAFT]) || 0;
  const p = Number(stats?.counts?.[STATUS.PROPOSED]) || 0;
  const a = Number(stats?.counts?.[STATUS.APPROVED]) || 0;
  const hidden = Number(stats?.hidden) || 0;

  const parts = [
    `Черновик ${d}`,
    `Предложено ${p}`,
    `Одобрено ${a}`,
  ];

  if (hidden > 0) parts.push(`Скрыто ${hidden}`);

  return `Страницы: ${parts.join(' • ')}`;
}

function _makeEntryMultiPageStatusEl(entry) {
  const stats = _computeEntryPageStatusStats(entry);

  const wrap = document.createElement('span');
  wrap.classList.add('spaceholder-journalcheck-status', 'sh-jc-status--multi');
  wrap.title = _multiPageStatusTitle(stats);

  const bar = document.createElement('span');
  bar.classList.add('sh-jc-statusbar');

  const addSeg = (cls, count) => {
    const n = Number(count) || 0;
    if (n <= 0) return;
    const seg = document.createElement('span');
    seg.classList.add('sh-jc-statusbar__seg', cls);
    seg.style.flex = `${n} 0 0`;
    bar.appendChild(seg);
  };

  addSeg('sh-jc-statusbar__seg--draft', stats.counts[STATUS.DRAFT]);
  addSeg('sh-jc-statusbar__seg--proposed', stats.counts[STATUS.PROPOSED]);
  addSeg('sh-jc-statusbar__seg--approved', stats.counts[STATUS.APPROVED]);
  addSeg('sh-jc-statusbar__seg--hidden', stats.hidden);

  // Fallback (should not happen, but keep stable UI)
  if (!bar.childElementCount) {
    addSeg('sh-jc-statusbar__seg--hidden', 1);
  }

  wrap.appendChild(bar);
  return wrap;
}

function _entryNextStatusOnIconClick(entry) {
  const cur = computeEntryStatusFromPages(entry);
  const isGM = !!game.user?.isGM;
  const skip = isGM && !!_getSetting(SETTING_GM_SKIP, false);

  if (skip) {
    if (cur === STATUS.DRAFT) return STATUS.APPROVED;
    if (cur === STATUS.APPROVED) return STATUS.DRAFT;
    // proposed -> approved (skip)
    return STATUS.APPROVED;
  }

  if (isGM) {
    if (cur === STATUS.DRAFT) return STATUS.PROPOSED;
    if (cur === STATUS.PROPOSED) return STATUS.APPROVED;
    if (cur === STATUS.APPROVED) return STATUS.PROPOSED;
    return STATUS.PROPOSED;
  }

  // Player
  if (cur === STATUS.DRAFT) return STATUS.PROPOSED;
  if (cur === STATUS.PROPOSED) return STATUS.DRAFT;
  return null;
}

function _pageNextStatusOnClick(page) {
  const cur = getStatus(page);
  const isGM = !!game.user?.isGM;
  const skip = isGM && !!_getSetting(SETTING_GM_SKIP, false);

  if (skip) {
    if (cur === STATUS.DRAFT) return STATUS.APPROVED;
    if (cur === STATUS.APPROVED) return STATUS.DRAFT;
    return STATUS.APPROVED;
  }

  if (isGM) {
    if (cur === STATUS.DRAFT) return STATUS.PROPOSED;
    if (cur === STATUS.PROPOSED) return STATUS.APPROVED;
    if (cur === STATUS.APPROVED) return STATUS.PROPOSED;
    return STATUS.PROPOSED;
  }

  if (cur === STATUS.DRAFT) return STATUS.PROPOSED;
  if (cur === STATUS.PROPOSED) return STATUS.DRAFT;
  return null;
}

function _canUserUpdate(doc) {
  try {
    return !!doc?.canUserModify?.(game.user, 'update');
  } catch (_) {
    return false;
  }
}

function _injectHeaderButtons(root) {
  const header = root.querySelector('.directory-header') || root.querySelector('header') || root;

  let actions = header.querySelector('.header-actions')
    || header.querySelector('.action-buttons')
    || header.querySelector('.header-controls');

  if (!actions) {
    const createBtn = header.querySelector(
      '[data-action="createEntry"], [data-action="create-entry"], [data-action="createFolder"], [data-action="create-folder"], .create-entry, .create-folder'
    );
    actions = createBtn?.parentElement ?? null;
  }

  if (!actions) return;

  // Toggle status icons (client)
  if (!actions.querySelector('.spaceholder-journalcheck-toggle-icons')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.classList.add('spaceholder-journalcheck-toggle-icons');
    btn.title = 'Показать/скрыть статусы';
    actions.appendChild(btn);
  }

  // Toggle GM skip (client, GM only)
  if (game.user?.isGM && !actions.querySelector('.spaceholder-journalcheck-toggle-gm-skip')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.classList.add('spaceholder-journalcheck-toggle-gm-skip');
    btn.title = 'GM: draft ↔ approved';
    actions.appendChild(btn);
  }

  // Open Update Log window
  if (!actions.querySelector('.spaceholder-journalcheck-open-update-log')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.classList.add('spaceholder-journalcheck-open-update-log');
    btn.title = 'Лог обновлений';
    actions.appendChild(btn);
  }

  // Refresh button contents + handlers
  const showBtn = actions.querySelector('.spaceholder-journalcheck-toggle-icons');
  if (showBtn) {
    const show = !!_getSetting(SETTING_SHOW_ICONS, true);
    showBtn.innerHTML = show
      ? '<i class="fa-solid fa-eye"></i>'
      : '<i class="fa-solid fa-eye-slash"></i>';

    showBtn.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const cur = !!_getSetting(SETTING_SHOW_ICONS, true);
      await game.settings.set(MODULE_NS, SETTING_SHOW_ICONS, !cur);
    };
  }

  const skipBtn = actions.querySelector('.spaceholder-journalcheck-toggle-gm-skip');
  if (skipBtn) {
    const enabled = !!_getSetting(SETTING_GM_SKIP, false);
    skipBtn.classList.toggle('is-active', enabled);
    skipBtn.innerHTML = enabled
      ? '<i class="fa-solid fa-forward-fast"></i>'
      : '<i class="fa-solid fa-forward"></i>';

    skipBtn.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const cur = !!_getSetting(SETTING_GM_SKIP, false);
      await game.settings.set(MODULE_NS, SETTING_GM_SKIP, !cur);
    };
  }

  const logBtn = actions.querySelector('.spaceholder-journalcheck-open-update-log');
  if (logBtn) {
    logBtn.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i>';
    logBtn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        const tab = game.user?.isGM ? 'proposed' : 'approved';
        game.spaceholder?.openJournalUpdateLogApp?.({ tab });
      } catch (_) {
        // ignore
      }
    };
  }
}

function _createEntryStatusIcon(entry) {
  const pages = entry?.pages?.contents ?? [];

  // Multi-page journals: show ratio, but do not allow status toggling by clicking the icon.
  if (pages.length > 1) {
    return _makeEntryMultiPageStatusEl(entry);
  }

  const curStatus = computeEntryStatusFromPages(entry);
  const el = _makeStatusEl(curStatus, { interactive: true });

  el.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();

    if (!_canUserUpdate(entry)) return;

    const current = computeEntryStatusFromPages(entry);
    const next = _entryNextStatusOnIconClick(entry);
    if (!next) return;

    // Permission gating: players cannot change approval states.
    if (!game.user.isGM) {
      if (current === STATUS.APPROVED) return;
      if (next === STATUS.APPROVED) return;
    }

    // Skip transitions only when enabled.
    const skip = !!(game.user.isGM && _getSetting(SETTING_GM_SKIP, false));
    if (!skip) {
      // Without skip, do not allow approved -> draft directly.
      if (current === STATUS.APPROVED && next === STATUS.DRAFT) return;
      // Without skip, do not allow draft -> approved directly.
      if (current === STATUS.DRAFT && next === STATUS.APPROVED) return;
    }

    if (next === STATUS.APPROVED) {
      await approveJournalItems({ entryIds: [entry.id] }, { source: 'icon' });
      return;
    }

    await setEntryStatus(entry, next, { reason: 'icon', applyToPages: true });
  });

  // Keyboard activation
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    el.click();
  });

  return el;
}

function _refreshEntryIconInDirectory(entry) {
  const show = !!_getSetting(SETTING_SHOW_ICONS, true);
  const entryId = entry?.id;
  if (!entryId) return;
  if (_isTimelineContainer(entry)) return;

  const roots = new Set();
  const uiRoot = ui?.journal?.element;
  if (uiRoot) roots.add(uiRoot);

  const domRoot = document.querySelector('#sidebar #journal')
    || document.querySelector('.sidebar-tab[data-tab="journal"]');
  if (domRoot) roots.add(domRoot);

  for (const root of roots) {
    const items = root.querySelectorAll(`.directory-item[data-entry-id="${entryId}"]`);
    if (!items?.length) continue;

    for (const li of items) {
      const anchor = li.querySelector('a.entry-name');
      if (!anchor) continue;

      anchor.querySelectorAll('.spaceholder-journalcheck-status').forEach((el) => el.remove());
      if (!show) continue;

      anchor.prepend(_createEntryStatusIcon(entry));
    }
  }
}

function _renderDirectoryEntryIcons(root) {
  const show = !!_getSetting(SETTING_SHOW_ICONS, true);

  for (const li of root.querySelectorAll('.directory-item[data-entry-id]')) {
    const entryId = li.dataset.entryId;
    const entry = game.journal?.get?.(entryId) ?? null;
    if (!entry) continue;
    if (_isTimelineContainer(entry)) continue;

    const anchor = li.querySelector('a.entry-name');
    if (!anchor) continue;

    // Clean previous
    anchor.querySelectorAll('.spaceholder-journalcheck-status').forEach((el) => el.remove());

    if (!show) continue;

    anchor.prepend(_createEntryStatusIcon(entry));
  }
}

function _renderJournalSheetPageIcons(app, root) {
  const show = !!_getSetting(SETTING_SHOW_ICONS, true);
  if (!show) return;

  const entry = app?.entry;
  if (!entry || _isTimelineContainer(entry)) return;

  const pages = entry?.pages?.contents ?? [];
  if (pages.length <= 1) return;

  for (const li of root.querySelectorAll('.toc [data-page-id]')) {
    const pageId = li.dataset.pageId;
    const page = entry?.pages?.get?.(pageId) ?? null;
    if (!page) continue;

    const heading = li.querySelector('.page-heading') || li;

    heading.querySelectorAll('.spaceholder-journalcheck-status').forEach((el) => el.remove());

    const status = getStatus(page);
    const el = _makeStatusEl(status, { interactive: false });

    // Place between index and title
    const index = heading.querySelector('.page-index');
    if (index?.parentElement === heading) {
      index.insertAdjacentElement('afterend', el);
    } else {
      heading.prepend(el);
    }
  }
}

function _addEntryContextOptions(app, options) {
  try {
    if (app?.constructor?.name !== 'JournalDirectory') return;
    if (!Array.isArray(options)) return;

    const getEntry = (li) => {
      const id = li?.closest?.('[data-entry-id]')?.dataset?.entryId;
      const entry = id ? (game.journal?.get?.(id) ?? null) : null;
      if (!entry) return null;
      if (_isTimelineContainer(entry)) return null;
      return entry;
    };

    const isGM = !!game.user?.isGM;
    const skip = !!(isGM && _getSetting(SETTING_GM_SKIP, false));

    const make = ({ name, icon, condition, callback }) => ({ name, icon, condition, callback });

    options.push(
      make({
        name: 'Закончить черновик',
        icon: '<i class="fa-solid fa-lightbulb"></i>',
        condition: (li) => {
          const entry = getEntry(li);
          if (!entry || !_canUserUpdate(entry)) return false;
          return computeEntryStatusFromPages(entry) === STATUS.DRAFT;
        },
        callback: (li) => {
          const entry = getEntry(li);
          if (!entry) return;
          return setEntryStatus(entry, STATUS.PROPOSED, { reason: 'ctx', applyToPages: true });
        },
      }),
      make({
        name: 'Вернуть в черновик',
        icon: '<i class="fa-solid fa-pen"></i>',
        condition: (li) => {
          const entry = getEntry(li);
          if (!entry || !_canUserUpdate(entry)) return false;
          const s = computeEntryStatusFromPages(entry);
          if (s === STATUS.PROPOSED) return true;
          return skip && isGM && (s === STATUS.APPROVED);
        },
        callback: (li) => {
          const entry = getEntry(li);
          if (!entry) return;
          return setEntryStatus(entry, STATUS.DRAFT, { reason: 'ctx', applyToPages: true });
        },
      }),
      make({
        name: 'Одобрить',
        icon: '<i class="fa-solid fa-check"></i>',
        condition: (li) => {
          if (!isGM) return false;
          const entry = getEntry(li);
          if (!entry || !_canUserUpdate(entry)) return false;
          const s = computeEntryStatusFromPages(entry);
          return s === STATUS.PROPOSED || (skip && s === STATUS.DRAFT);
        },
        callback: (li) => {
          const entry = getEntry(li);
          if (!entry) return;
          return approveJournalItems({ entryIds: [entry.id] }, { source: 'ctx' });
        },
      }),
      make({
        name: 'Снять одобрение',
        icon: '<i class="fa-solid fa-rotate-left"></i>',
        condition: (li) => {
          if (!isGM) return false;
          const entry = getEntry(li);
          if (!entry || !_canUserUpdate(entry)) return false;
          const s = computeEntryStatusFromPages(entry);
          return s === STATUS.APPROVED;
        },
        callback: (li) => {
          const entry = getEntry(li);
          if (!entry) return;
          return setEntryStatus(entry, STATUS.PROPOSED, { reason: 'ctx', applyToPages: true });
        },
      }),
    );
  } catch (e) {
    console.error('SpaceHolder | JournalCheck: failed to extend JournalEntry context menu', e);
  }
}

function _addPageContextOptions(app, options) {
  try {
    if (app?.constructor?.name !== 'JournalEntrySheet') return;
    if (!Array.isArray(options)) return;

    const entry = app.entry;
    if (!entry) return;
    if (_isTimelineContainer(entry)) return;

    const getPage = (li) => {
      const id = li?.dataset?.pageId;
      const page = id ? (entry.pages?.get?.(id) ?? null) : null;
      if (!page) return null;
      if (_isTimelinePage(page)) return null;
      return page;
    };

    const isGM = !!game.user?.isGM;
    const skip = !!(isGM && _getSetting(SETTING_GM_SKIP, false));

    const make = ({ name, icon, condition, callback }) => ({ name, icon, condition, callback });

    options.push(
      make({
        name: 'Страница: Закончить черновик',
        icon: '<i class="fa-solid fa-lightbulb"></i>',
        condition: (li) => {
          const page = getPage(li);
          if (!page || !_canUserUpdate(page)) return false;
          return getStatus(page) === STATUS.DRAFT;
        },
        callback: (li) => {
          const page = getPage(li);
          if (!page) return;
          return setPageStatus(page, STATUS.PROPOSED, { reason: 'ctx', syncParent: true });
        },
      }),
      make({
        name: 'Страница: Вернуть в черновик',
        icon: '<i class="fa-solid fa-pen"></i>',
        condition: (li) => {
          const page = getPage(li);
          if (!page || !_canUserUpdate(page)) return false;
          const s = getStatus(page);
          if (s === STATUS.PROPOSED) return true;
          return skip && isGM && (s === STATUS.APPROVED);
        },
        callback: (li) => {
          const page = getPage(li);
          if (!page) return;
          return setPageStatus(page, STATUS.DRAFT, { reason: 'ctx', syncParent: true });
        },
      }),
      make({
        name: 'Страница: Одобрить',
        icon: '<i class="fa-solid fa-check"></i>',
        condition: (li) => {
          if (!isGM) return false;
          const page = getPage(li);
          if (!page || !_canUserUpdate(page)) return false;
          const s = getStatus(page);
          return s === STATUS.PROPOSED || (skip && s === STATUS.DRAFT);
        },
        callback: (li) => {
          const page = getPage(li);
          if (!page) return;
          return approveJournalItems({ pageRefs: [{ entryId: entry.id, pageId: page.id }] }, { source: 'ctx' });
        },
      }),
      make({
        name: 'Страница: Снять одобрение',
        icon: '<i class="fa-solid fa-rotate-left"></i>',
        condition: (li) => {
          if (!isGM) return false;
          const page = getPage(li);
          if (!page || !_canUserUpdate(page)) return false;
          return getStatus(page) === STATUS.APPROVED;
        },
        callback: (li) => {
          const page = getPage(li);
          if (!page) return;
          return setPageStatus(page, STATUS.PROPOSED, { reason: 'ctx', syncParent: true });
        },
      }),

      // Bulk actions
      make({
        name: 'Журнал: Одобрить весь журнал',
        icon: '<i class="fa-solid fa-check-double"></i>',
        condition: () => {
          if (!isGM) return false;
          return _canUserUpdate(entry);
        },
        callback: () => approveJournalItems({ entryIds: [entry.id] }, { source: 'ctx-bulk' }),
      }),
      make({
        name: 'Журнал: Предложить весь журнал',
        icon: '<i class="fa-solid fa-lightbulb"></i>',
        condition: () => _canUserUpdate(entry),
        callback: () => setEntryStatus(entry, STATUS.PROPOSED, { reason: 'ctx-bulk', applyToPages: true }),
      }),
      make({
        name: 'Журнал: В черновик весь журнал',
        icon: '<i class="fa-solid fa-pen"></i>',
        condition: () => _canUserUpdate(entry),
        callback: () => setEntryStatus(entry, STATUS.DRAFT, { reason: 'ctx-bulk', applyToPages: true }),
      }),
    );
  } catch (e) {
    console.error('SpaceHolder | JournalCheck: failed to extend JournalEntryPage context menu', e);
  }
}

export function installJournalCheckHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  Hooks.on('renderJournalDirectory', (app, html /*, context, options */) => {
    try {
      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!root) return;
      _injectHeaderButtons(root);
      _renderDirectoryEntryIcons(root);
    } catch (e) {
      console.error('SpaceHolder | JournalCheck: renderJournalDirectory failed', e);
    }
  });

  Hooks.on('getJournalEntryContextOptions', (app, options) => {
    _addEntryContextOptions(app, options);
  });

  Hooks.on('renderJournalEntrySheet', (app, html /*, context, options */) => {
    try {
      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!root) return;
      _renderJournalSheetPageIcons(app, root);
    } catch (e) {
      console.error('SpaceHolder | JournalCheck: renderJournalEntrySheet failed', e);
    }
  });

  Hooks.on('getJournalEntryPageContextOptions', (app, options) => {
    _addPageContextOptions(app, options);
  });

  // Defaults for new entries/pages
  Hooks.on('preCreateJournalEntry', (entry, data, options, userId) => {
    try {
      if (_isOurUpdate(options)) return;
      if (!_currentUserIsActor(userId)) return;
      foundry.utils.setProperty(data, `flags.${MODULE_NS}.${FLAG_ROOT}.status`, STATUS.DRAFT);
    } catch (e) {
      console.error('SpaceHolder | JournalCheck: preCreateJournalEntry failed', e);
    }
  });

  Hooks.on('preCreateJournalEntryPage', (page, data, options, userId) => {
    try {
      if (_isOurUpdate(options)) return;
      if (!_currentUserIsActor(userId)) return;
      foundry.utils.setProperty(data, `flags.${MODULE_NS}.${FLAG_ROOT}.status`, STATUS.DRAFT);
    } catch (e) {
      console.error('SpaceHolder | JournalCheck: preCreateJournalEntryPage failed', e);
    }
  });

  // Keep Journal Directory icons in sync even when the directory does not re-render on flag updates.
  Hooks.on('updateJournalEntry', (entry /*, changed, options, userId */) => {
    try {
      if (_isTimelineContainer(entry)) return;
      _refreshEntryIconInDirectory(entry);
    } catch (e) {
      console.error('SpaceHolder | JournalCheck: failed to refresh directory icon on update', e);
    }
  });

  // Page updates may change multi-page ratio without changing the computed entry status.
  Hooks.on('updateJournalEntryPage', (page /*, changed, options, userId */) => {
    try {
      const entry = page?.parent;
      if (!entry) return;
      if (_isTimelineContainer(entry)) return;
      _refreshEntryIconInDirectory(entry);
    } catch (e) {
      console.error('SpaceHolder | JournalCheck: failed to refresh directory icon on page update', e);
    }
  });

  // Auto-dirty on updates (only act on the originating client)
  Hooks.on('updateJournalEntry', async (entry, changed, options, userId) => {
    try {
      if (_isTimelineContainer(entry)) return;
      if (_isOurUpdate(options)) return;
      if (!_currentUserIsActor(userId)) return;
      if (_isUserGM(userId)) return;

      const status = computeEntryStatusFromPages(entry);
      if (status !== STATUS.APPROVED) return;

      await setEntryStatus(entry, STATUS.PROPOSED, { reason: 'autoDirtyEntry', applyToPages: true });
    } catch (e) {
      console.error('SpaceHolder | JournalCheck: updateJournalEntry failed', e);
    }
  });

  Hooks.on('updateJournalEntryPage', async (page, changed, options, userId) => {
    try {
      if (_isTimelinePage(page)) return;
      if (_isOurUpdate(options)) return;
      if (!_currentUserIsActor(userId)) return;
      if (_isUserGM(userId)) return;

      const status = getStatus(page);
      if (status !== STATUS.APPROVED) return;

      await setPageStatus(page, STATUS.PROPOSED, { reason: 'autoDirtyPage', syncParent: true });
    } catch (e) {
      console.error('SpaceHolder | JournalCheck: updateJournalEntryPage failed', e);
    }
  });

  // Sync entry status when pages are added/removed
  const parseCreateDeleteArgs = (args) => {
    // Possible signatures:
    // - (doc, options, userId)
    // - (doc, data, options, userId)
    const last = args?.length ? args[args.length - 1] : null;
    const userId = (typeof last === 'string') ? last : null;
    const options = userId && args.length >= 2 ? args[args.length - 2] : null;
    return { options, userId };
  };

  Hooks.on('createJournalEntryPage', async (page, ...args) => {
    try {
      if (_isTimelinePage(page)) return;
      const { options, userId } = parseCreateDeleteArgs(args);
      if (_isOurUpdate(options)) return;
      if (!_currentUserIsActor(userId)) return;

      const entry = page?.parent;
      if (!entry) return;
      await syncEntryStatusFromPages(entry, { reason: 'pageCreated' });
    } catch (e) {
      console.error('SpaceHolder | JournalCheck: createJournalEntryPage failed', e);
    }
  });

  Hooks.on('deleteJournalEntryPage', async (page, ...args) => {
    try {
      if (_isTimelinePage(page)) return;
      const { options, userId } = parseCreateDeleteArgs(args);
      if (_isOurUpdate(options)) return;
      if (!_currentUserIsActor(userId)) return;

      const entry = page?.parent;
      if (!entry) return;
      await syncEntryStatusFromPages(entry, { reason: 'pageDeleted' });
    } catch (e) {
      console.error('SpaceHolder | JournalCheck: deleteJournalEntryPage failed', e);
    }
  });
}

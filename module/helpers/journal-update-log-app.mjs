// Journal Update Log (Foundry v13, ApplicationV2)
// - GM: Proposed tab (bulk approve)
// - Everyone: Approved history tab (last 200 approval batches, filtered by permissions)

import {
  approveJournalItems,
  computeEntryStatusFromPages,
  getApprovalHistory,
  getStatus,
} from './journal-check.mjs';

const MODULE_NS = 'spaceholder';
const FLAG_ROOT = 'journalCheck';
const TIMELINE_FLAG_ROOT = 'timeline';
const TIMELINE_V2_FLAG_ROOT = 'timelineV2';

function _getTimelineFlagObj(doc, flagRoot) {
  try {
    return doc?.getFlag?.(MODULE_NS, flagRoot) ?? doc?.flags?.[MODULE_NS]?.[flagRoot] ?? {};
  } catch (_) {
    return {};
  }
}

function _isTimelineContainer(entry) {
  const v1 = _getTimelineFlagObj(entry, TIMELINE_FLAG_ROOT);
  if (v1?.isContainer) return true;

  const v2 = _getTimelineFlagObj(entry, TIMELINE_V2_FLAG_ROOT);
  return !!v2?.isContainer;
}

const STATUS = {
  DRAFT: 'draft',
  PROPOSED: 'proposed',
  APPROVED: 'approved',
};

let _singleton = null;
let _hooksInstalled = false;

function _formatDateTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  try { return new Date(n).toLocaleString(); } catch (_) { return ''; }
}

function _getWorkflowFlags(doc) {
  try {
    return doc?.getFlag?.(MODULE_NS, FLAG_ROOT) ?? doc?.flags?.[MODULE_NS]?.[FLAG_ROOT] ?? {};
  } catch (_) {
    return {};
  }
}

function _resolveUserName(userId) {
  const id = String(userId ?? '').trim();
  if (!id) return '';
  return String(game?.users?.get?.(id)?.name ?? '').trim();
}

function _metaLine({ by = null, at = null } = {}) {
  const user = _resolveUserName(by);
  const when = _formatDateTime(at);
  const parts = [user, when].filter(Boolean);
  return parts.join(' • ');
}

function _canObserve(doc, user) {
  try {
    return !!doc?.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER);
  } catch (_) {
    return false;
  }
}

async function _openJournalUuid(rawUuid) {
  const uuid = String(rawUuid ?? '').trim();
  if (!uuid) return false;

  let doc = null;
  try {
    doc = await fromUuid(uuid);
  } catch (_) {
    doc = null;
  }

  if (!doc) return false;

  // Best effort: JournalEntryPage opens the parent entry; try to hint pageId if supported.
  if (doc.documentName === 'JournalEntryPage' && doc.parent?.sheet?.render) {
    try {
      doc.parent.sheet.render(true, { pageId: doc.id });
    } catch (_) {
      doc.parent.sheet.render(true);
    }
    return true;
  }

  if (doc.sheet?.render) {
    doc.sheet.render(true);
    return true;
  }

  return false;
}

function _installHooksOnce() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  const rerender = () => {
    try {
      if (_singleton) _singleton.render(false);
    } catch (_) {
      // ignore
    }
  };

  Hooks.on('updateJournalEntry', rerender);
  Hooks.on('updateJournalEntryPage', rerender);
  Hooks.on('spaceholderJournalApprovalHistoryUpdated', rerender);
}

export function openJournalUpdateLogApp({ tab = null } = {}) {
  _installHooksOnce();

  if (_singleton) {
    try {
      if (tab) _singleton.setActiveTab(tab);
      _singleton.render(true);
      _singleton.bringToTop?.();
    } catch (_) {
      // ignore
    }
    return _singleton;
  }

  _singleton = new JournalUpdateLogApp({ initialTab: tab });
  _singleton.render(true);
  return _singleton;
}

export class JournalUpdateLogApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-journal-update-log',
    classes: ['spaceholder', 'journal-update-log'],
    tag: 'div',
    window: { title: 'Лог обновлений', resizable: true },
    position: { width: 760, height: 760 },
  };

  static PARTS = {
    main: { root: true, template: 'systems/spaceholder/templates/journal/update-log.hbs' },
  };

  constructor({ initialTab = null } = {}) {
    super();
    this._activeTab = String(initialTab ?? '').trim() || null;
    this._selectedKeys = new Set();
  }

  setActiveTab(tab) {
    const isGM = !!game?.user?.isGM;
    const t = String(tab ?? '').trim();
    if (!isGM) {
      this._activeTab = 'approved';
      return;
    }
    if (t === 'proposed' || t === 'approved') this._activeTab = t;
  }

  async close(options = {}) {
    await super.close(options);
    if (_singleton === this) _singleton = null;
  }

  _collectProposed() {
    const out = [];
    const entries = Array.isArray(game?.journal?.contents) ? game.journal.contents : [];

    for (const entry of entries) {
      if (!entry?.id) continue;
      if (_isTimelineContainer(entry)) continue;

      const pages = entry?.pages?.contents ?? [];

      // Multi-page: list proposed pages.
      if (pages.length > 1) {
        const proposedPages = [];
        let sortAt = 0;

        for (const p of pages) {
          if (!p?.id) continue;
          if (getStatus(p) !== STATUS.PROPOSED) continue;

          const fp = _getWorkflowFlags(p);
          const meta = _metaLine({ by: fp.changedBy, at: fp.changedAt });
          const at = Number(fp.changedAt) || 0;
          if (at > sortAt) sortAt = at;

          proposedPages.push({
            key: `page:${entry.id}:${p.id}`,
            entryId: entry.id,
            pageId: p.id,
            name: String(p.name ?? '').trim() || '(без названия)',
            uuid: p.uuid ?? null,
            meta,
          });
        }

        if (!proposedPages.length) continue;

        out.push({
          entryId: entry.id,
          name: String(entry.name ?? '').trim() || '(без названия)',
          uuid: entry.uuid ?? null,
          pages: proposedPages,
          meta: '',
          sortAt,
        });

        continue;
      }

      // Single-page: treat as entry.
      const status = computeEntryStatusFromPages(entry);
      if (status !== STATUS.PROPOSED) continue;

      const fe = _getWorkflowFlags(entry);
      const meta = _metaLine({ by: fe.changedBy, at: fe.changedAt });

      out.push({
        entryId: entry.id,
        name: String(entry.name ?? '').trim() || '(без названия)',
        uuid: entry.uuid ?? null,
        pages: [],
        key: `entry:${entry.id}`,
        meta,
        sortAt: Number(fe.changedAt) || 0,
      });
    }

    out.sort((a, b) => {
      const da = Number(a?.sortAt) || 0;
      const db = Number(b?.sortAt) || 0;
      if (da !== db) return db - da;
      return String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'ru');
    });

    return out;
  }

  _collectApprovedHistoryForUser(user) {
    const isGM = !!user?.isGM;
    const batches = getApprovalHistory({ limit: 200 });
    const out = [];

    for (const b of (Array.isArray(batches) ? batches : [])) {
      const items = Array.isArray(b?.items) ? b.items : [];

      // Group by entryId, preserve insertion order.
      const entryMap = new Map();
      const ensure = (entry) => {
        if (!entry?.id) return null;
        if (!entryMap.has(entry.id)) {
          entryMap.set(entry.id, { entry, pages: [], hasLeafEntry: false });
        }
        return entryMap.get(entry.id);
      };

      for (const it of items) {
        const type = String(it?.type ?? '');
        const entryId = String(it?.entryId ?? '').trim();
        if (!entryId) continue;

        const entry = game.journal?.get?.(entryId) ?? null;
        if (!entry) continue;
        if (_isTimelineContainer(entry)) continue;

        if (!isGM && !_canObserve(entry, user)) continue;

        const bucket = ensure(entry);
        if (!bucket) continue;

        if (type === 'entry') {
          bucket.hasLeafEntry = true;
          continue;
        }

        if (type === 'page') {
          const pageId = String(it?.pageId ?? '').trim();
          if (!pageId) continue;

          const page = entry.pages?.get?.(pageId) ?? null;
          const canSeePage = isGM ? true : (page ? _canObserve(page, user) : false);

          const rawName = String(page?.name ?? '').trim();
          const name = canSeePage
            ? (page ? (rawName || '(без названия)') : '(удалено)')
            : 'Неизвестно';

          bucket.pages.push({
            name,
            uuid: (canSeePage && page) ? (page.uuid ?? null) : null,
          });
        }
      }

      const entries = [];
      for (const v of entryMap.values()) {
        if (!v) continue;
        if (!v.hasLeafEntry && (!v.pages || !v.pages.length)) continue;

        entries.push({
          entryId: v.entry.id,
          name: String(v.entry.name ?? '').trim() || '(без названия)',
          uuid: v.entry.uuid ?? null,
          pages: v.pages ?? [],
        });
      }

      if (!entries.length) continue;

      const gmName = _resolveUserName(b?.gmId) || 'GM';
      const atText = _formatDateTime(b?.at) || '';

      out.push({
        id: String(b?.id ?? ''),
        at: Number(b?.at) || 0,
        atText,
        gmName,
        entries,
      });
    }

    return out;
  }

  async _prepareContext(_options) {
    const isGM = !!game?.user?.isGM;

    // Default tab
    if (!this._activeTab) {
      this._activeTab = isGM ? 'proposed' : 'approved';
    }

    // Enforce tab access for players
    const activeTab = isGM ? this._activeTab : 'approved';

    const proposed = isGM ? this._collectProposed() : [];
    const approvedBatches = this._collectApprovedHistoryForUser(game.user);

    const selected = {};
    for (const k of this._selectedKeys.values()) {
      selected[String(k)] = true;
    }

    return {
      isGM,
      activeTab,
      proposed,
      approvedBatches,
      selected,
      hasSelection: this._selectedKeys.size > 0,
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    const el = this.element;
    if (!el) return;

    // Tabs
    el.querySelectorAll('[data-action="tab"]').forEach((a) => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const tab = ev.currentTarget?.dataset?.tab;
        this.setActiveTab(tab);
        this.render(false);
      });
    });

    // Open links
    el.querySelectorAll('[data-action="open"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const uuid = ev.currentTarget?.dataset?.uuid;
        await _openJournalUuid(uuid);
      });
    });

    // Selection
    const syncApproveBtn = () => {
      const btn = el.querySelector('[data-action="approve-selected"]');
      if (btn) btn.disabled = this._selectedKeys.size <= 0;
    };

    el.querySelectorAll('input[type="checkbox"][data-key]').forEach((cb) => {
      cb.addEventListener('change', (ev) => {
        const input = ev.currentTarget;
        const key = String(input?.dataset?.key ?? '').trim();
        if (!key) return;
        if (input.checked) this._selectedKeys.add(key);
        else this._selectedKeys.delete(key);
        syncApproveBtn();
      });
    });

    // Group toggle: selects all page checkboxes in this entry block
    el.querySelectorAll('input[type="checkbox"][data-group-entry-id]').forEach((cb) => {
      cb.addEventListener('change', (ev) => {
        const input = ev.currentTarget;
        const entryId = String(input?.dataset?.groupEntryId ?? '').trim();
        if (!entryId) return;

        const entryRoot = input.closest(`[data-entry-id="${entryId}"]`);
        if (!entryRoot) return;

        const checked = !!input.checked;
        entryRoot.querySelectorAll('input[type="checkbox"][data-key]').forEach((child) => {
          const key = String(child?.dataset?.key ?? '').trim();
          if (!key) return;
          child.checked = checked;
          if (checked) this._selectedKeys.add(key);
          else this._selectedKeys.delete(key);
        });

        syncApproveBtn();
      });
    });

    // Approve
    el.querySelectorAll('[data-action="approve-selected"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        if (!game?.user?.isGM) return;

        const entryIds = [];
        const pageRefs = [];

        for (const key of this._selectedKeys.values()) {
          const k = String(key);
          if (k.startsWith('entry:')) {
            const entryId = k.slice('entry:'.length).trim();
            if (entryId) entryIds.push(entryId);
            continue;
          }
          if (k.startsWith('page:')) {
            const parts = k.split(':');
            const entryId = String(parts?.[1] ?? '').trim();
            const pageId = String(parts?.[2] ?? '').trim();
            if (entryId && pageId) pageRefs.push({ entryId, pageId });
          }
        }

        if (!entryIds.length && !pageRefs.length) return;

        await approveJournalItems({ entryIds, pageRefs }, { source: 'bulk' });

        this._selectedKeys.clear();
        this.render(true);
      });
    });

    syncApproveBtn();
  }
}

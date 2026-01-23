// Journal Check helper for SpaceHolder system (Foundry v13)
// Adds multi-state workflow flags to JournalEntry and JournalEntryPage.

const MODULE_NS = 'spaceholder';
const FLAG_ROOT = 'journalCheck';

const SETTING_SHOW_ICONS = 'journalcheck.showIcons';
const SETTING_GM_SKIP = 'journalcheck.gmSkipProposed';

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
}

function _createEntryStatusIcon(entry) {
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
      return id ? (game.journal?.get?.(id) ?? null) : null;
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
          return setEntryStatus(entry, STATUS.APPROVED, { reason: 'ctx', applyToPages: true });
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

    const getPage = (li) => {
      const id = li?.dataset?.pageId;
      return id ? (entry.pages?.get?.(id) ?? null) : null;
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
          return setPageStatus(page, STATUS.APPROVED, { reason: 'ctx', syncParent: true });
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
        callback: () => setEntryStatus(entry, STATUS.APPROVED, { reason: 'ctx-bulk', applyToPages: true }),
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
      _refreshEntryIconInDirectory(entry);
    } catch (e) {
      console.error('SpaceHolder | JournalCheck: failed to refresh directory icon on update', e);
    }
  });

  // Auto-dirty on updates (only act on the originating client)
  Hooks.on('updateJournalEntry', async (entry, changed, options, userId) => {
    try {
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

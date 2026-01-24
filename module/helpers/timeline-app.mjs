import {
  TIMELINE_CONTAINER_KIND,
  TIMELINE_ORIGIN,
  canUserOwnContainer,
  createTimelineEntry,
  deleteTimelineEntryPage,
  ensureTimelineInfrastructureForCurrentUser,
  getTimelineContainer,
  getTimelineContainerKind,
  getTimelineEntryData,
  getUserFactionUuidsSafe,
  installTimelineHooks,
  isTimelineEntryPage,
  listTimelineContainers,
  listTimelinePagesInContainer,
  moveTimelineEntryBetweenContainers,
  resolveTimelinePage,
  setTimelineEntryHidden,
  swapTimelineEntryIds,
  updateTimelineEntryPage,
} from './timeline.mjs';

const TEMPLATE_APP = 'systems/spaceholder/templates/timeline/timeline-app.hbs';
const TEMPLATE_EDITOR = 'systems/spaceholder/templates/timeline/timeline-entry-editor.hbs';

let _singleton = null;
let _hooksInstalled = false;

function _isGM() {
  return !!game?.user?.isGM;
}

async function _confirmDialog({ title, content, yesLabel, yesIcon, noLabel, noIcon }) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (DialogV2?.confirm) {
    try {
      return await new Promise((resolve) => {
        let settled = false;
        const settle = (v) => {
          if (settled) return;
          settled = true;
          resolve(!!v);
        };

        const maybePromise = DialogV2.confirm({
          window: { title, icon: yesIcon || 'fa-solid fa-question' },
          content,
          yes: {
            label: yesLabel ?? 'Да',
            icon: yesIcon ?? 'fa-solid fa-check',
            callback: () => {
              settle(true);
              return true;
            },
          },
          no: {
            label: noLabel ?? 'Нет',
            icon: noIcon ?? 'fa-solid fa-times',
            callback: () => {
              settle(false);
              return false;
            },
          },
        });

        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then((r) => settle(r)).catch(() => settle(false));
        }
      });
    } catch (_) {
      // fallback
    }
  }

  const DialogImpl = globalThis.Dialog;
  if (typeof DialogImpl?.confirm === 'function') {
    return await DialogImpl.confirm({
      title,
      content,
      yes: () => true,
      no: () => false,
      defaultYes: false,
    });
  }

  return globalThis.confirm?.(title) ?? false;
}

async function _onTimelineEntryEditorSubmit(event, form, formData) {
  // Foundry calls this with `this` bound to the application instance.
  return this?._onSubmit?.(event, form, formData);
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

  Hooks.on('createJournalEntryPage', (page) => {
    try {
      if (!isTimelineEntryPage(page)) return;
      rerender();
    } catch (_) {
      // ignore
    }
  });
  Hooks.on('updateJournalEntryPage', (page) => {
    try {
      if (!isTimelineEntryPage(page)) return;
      rerender();
    } catch (_) {
      // ignore
    }
  });
  Hooks.on('deleteJournalEntryPage', (page) => {
    try {
      if (!isTimelineEntryPage(page)) return;
      rerender();
    } catch (_) {
      // ignore
    }
  });
}

export function openTimelineApp() {
  _installHooksOnce();

  if (_singleton) {
    _singleton.render(true);
    _singleton.bringToTop?.();
    return _singleton;
  }

  _singleton = new TimelineApp();
  _singleton.render(true);

  // Ensure infra in background and re-render when ready
  ensureTimelineInfrastructureForCurrentUser()
    .then(() => {
      try {
        if (_singleton) {
          _singleton._loading = false;
          _singleton.render(false);
        }
      } catch (_) {
        // ignore
      }
    })
    .catch(() => {
      try {
        if (_singleton) {
          _singleton._loading = false;
          _singleton.render(false);
        }
      } catch (_) {
        // ignore
      }
    });

  return _singleton;
}

class TimelineApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-timeline',
    classes: ['spaceholder', 'timeline'],
    tag: 'div',
    window: { title: 'Таймлайн', resizable: true },
    position: { width: 860, height: 780 },
  };

  static PARTS = {
    main: { root: true, template: TEMPLATE_APP },
  };

  constructor() {
    super();

    installTimelineHooks();

    this._loading = true;
    this._showHidden = false;
    this._expanded = new Set();

    const myFactions = getUserFactionUuidsSafe(game.user);

    if (_isGM()) {
      this._view = 'gm';
      this._activeFactionUuid = myFactions?.[0] ?? '';
    } else {
      // По ТЗ: игрок с 1 фракцией попадает сразу в чат; с несколькими — выбирает.
      if (myFactions.length >= 1) {
        this._view = 'faction';
        this._activeFactionUuid = myFactions[0];
      } else {
        this._view = 'public';
        this._activeFactionUuid = '';
      }
    }

    this._onRootClick = this._onRootClick.bind(this);
    this._onRootChange = this._onRootChange.bind(this);
  }

  async close(options = {}) {
    await super.close(options);
    if (_singleton === this) _singleton = null;
  }

  _setView(next) {
    const v = String(next || '').trim();
    const isGM = _isGM();

    if (v === 'gm') {
      if (!isGM) return;
      this._view = 'gm';
      return;
    }

    if (v === 'public' || v === 'faction') {
      this._view = v;
      return;
    }
  }

  _getFactionChoicesForUi() {
    const isGM = _isGM();

    const uuids = isGM
      ? Array.from(game?.actors?.values?.() ?? game?.actors?.contents ?? [])
        .filter((a) => a?.type === 'faction')
        .map((a) => a.uuid)
      : getUserFactionUuidsSafe(game.user);

    const seen = new Set();
    const out = [];

    for (const raw of uuids) {
      const uuid = String(raw || '').trim();
      if (!uuid || seen.has(uuid)) continue;
      seen.add(uuid);

      let doc = null;
      // Fast-path for world actors
      try {
        const parts = uuid.split('.');
        if (parts[0] === 'Actor' && parts[1] && parts.length === 2) {
          doc = game?.actors?.get?.(parts[1]) ?? null;
        }
      } catch (_) {
        doc = null;
      }

      const name = String(doc?.name ?? uuid);
      const color = String(doc?.system?.fColor ?? '').trim();

      out.push({ uuid, name, color });
    }

    out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru', { sensitivity: 'base' }));
    return out;
  }

  _collectContainersForView() {
    const view = String(this._view || 'public');

    const containers = [];

    const world = getTimelineContainer({ kind: TIMELINE_CONTAINER_KIND.WORLD_PUBLIC });

    const allFactionPublic = listTimelineContainers({ kind: TIMELINE_CONTAINER_KIND.FACTION_PUBLIC });

    if (view === 'gm') {
      // All containers
      const all = listTimelineContainers();
      for (const e of all) containers.push(e);
      return containers;
    }

    if (view === 'faction') {
      const fu = String(this._activeFactionUuid || '').trim();
      const priv = fu ? getTimelineContainer({ kind: TIMELINE_CONTAINER_KIND.FACTION_PRIVATE, factionUuid: fu }) : null;
      if (priv) containers.push(priv);
      if (world) containers.push(world);
      for (const e of allFactionPublic) containers.push(e);
      return containers;
    }

    // public
    if (world) containers.push(world);
    for (const e of allFactionPublic) containers.push(e);

    // Include private entries of my factions
    const my = getUserFactionUuidsSafe(game.user);
    for (const fu of my) {
      const priv = getTimelineContainer({ kind: TIMELINE_CONTAINER_KIND.FACTION_PRIVATE, factionUuid: fu });
      if (priv) containers.push(priv);
    }

    return containers;
  }

  _collectEntryDocsForView() {
    const containers = this._collectContainersForView();

    const seen = new Set();
    const out = [];

    for (const entry of containers) {
      if (!entry?.id) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);

      for (const page of listTimelinePagesInContainer(entry)) {
        out.push({ entry, page });
      }
    }

    return out;
  }

  async _prepareContext(_options) {
    const isGM = _isGM();

    // Determine if we should still show loading
    const loading = !!this._loading;

    const factions = this._getFactionChoicesForUi();

    // Ensure active faction is valid when needed
    if (this._view === 'faction') {
      const exists = factions.some((f) => f.uuid === this._activeFactionUuid);
      if (!exists) {
        this._activeFactionUuid = factions?.[0]?.uuid ?? '';
      }
    }

    const views = [];
    if (isGM) views.push({ id: 'gm', label: 'ГМ', active: this._view === 'gm' });
    views.push({ id: 'public', label: 'Публичный', active: this._view === 'public' });
    views.push({ id: 'faction', label: 'Фракция', active: this._view === 'faction' });

    const showFactionSelect = this._view === 'faction' && factions.length > 0;
    const showHiddenToggle = (this._view === 'public' || this._view === 'gm');

    const canCreate = isGM || getUserFactionUuidsSafe(game.user).length > 0;

    const raw = this._collectEntryDocsForView();

    // Build entries list
    const entries = [];

    for (const { entry, page } of raw) {
      if (!page?.id) continue;

      const containerKind = getTimelineContainerKind(entry);
      if (!containerKind) continue;

      const t = getTimelineEntryData(page);

      // Filter hidden only for aggregated views
      if ((this._view === 'public' || this._view === 'gm') && !this._showHidden) {
        if (t.isHidden) continue;
      }

      const isExpanded = this._expanded.has(page.uuid);

      const canEdit = isGM || ((t.origin === TIMELINE_ORIGIN.FACTION) && canUserOwnContainer(entry, game.user));
      const isGlobal = (containerKind === TIMELINE_CONTAINER_KIND.WORLD_PUBLIC) || (containerKind === TIMELINE_CONTAINER_KIND.FACTION_PUBLIC);

      const canToggleGlobal = ((t.origin === TIMELINE_ORIGIN.FACTION) && canEdit) || ((t.origin === TIMELINE_ORIGIN.WORLD) && isGM);
      const canToggleHidden = canEdit;

      const canReorder = canEdit && (isGM || (t.origin === TIMELINE_ORIGIN.FACTION));

      let enrichedContent = '';
      if (isExpanded) {
        try {
          const rawHtml = String(page?.text?.content ?? '');
          enrichedContent = await foundry.applications.ux.TextEditor.implementation.enrichHTML(rawHtml, {
            async: true,
            secrets: canEdit,
            relativeTo: entry,
          });
        } catch (_) {
          enrichedContent = '';
        }
      }

      // Accent color for faction-origin entries
      let accentColor = '';
      if (t.origin === TIMELINE_ORIGIN.FACTION) {
        try {
          const fu = String(t.factionUuid || '').trim();
          const parts = fu.split('.');
          const actor = (parts[0] === 'Actor' && parts[1] && parts.length === 2)
            ? (game?.actors?.get?.(parts[1]) ?? null)
            : null;
          const c = String(actor?.system?.fColor ?? '').trim();
          if (c) accentColor = c;
        } catch (_) {
          accentColor = '';
        }
      }

      const globalUiClass = isGlobal ? (t.isHidden ? 'is-muted' : 'is-active') : '';

      entries.push({
        uuid: page.uuid,
        pageId: page.id,
        entryId: entry.id,
        containerKind,
        year: t.year,
        id: t.id,
        title: String(page.name ?? '').trim() || '(без названия)',
        origin: t.origin,
        factionUuid: t.factionUuid,
        accentColor,
        isGlobal,
        globalUiClass,
        isHidden: !!t.isHidden,
        canEdit,
        canReorder,
        canToggleGlobal,
        canToggleHidden,
        isExpanded,
        enrichedContent,
      });
    }

    entries.sort((a, b) => {
      const ya = Number(a.year) || 1;
      const yb = Number(b.year) || 1;
      if (ya !== yb) return ya - yb;

      const ia = Number(a.id) || 0;
      const ib = Number(b.id) || 0;
      if (ia !== ib) return ia - ib;

      return String(a.title).localeCompare(String(b.title), 'ru');
    });

    return {
      isGM,
      loading,
      views,
      factions,
      activeFactionUuid: this._activeFactionUuid,
      showFactionSelect,
      showHiddenToggle,
      showHidden: this._showHidden,
      canCreate,
      entries,
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    const el = this.element;
    if (!el) return;

    if (el.dataset?.shTimelineHandlers !== 'true') {
      el.dataset.shTimelineHandlers = 'true';
      el.addEventListener('click', this._onRootClick);
      el.addEventListener('change', this._onRootChange);
    }

    // Ensure Foundry activates content-link/inline-roll listeners (and editor helpers, if present).
    try {
      foundry.applications.ux.TextEditor.activateListeners(el);
    } catch (_) {
      // ignore
    }

    // Some Foundry builds expose activateEditors separately.
    try {
      if (typeof foundry.applications.ux.TextEditor.activateEditors === 'function') {
        foundry.applications.ux.TextEditor.activateEditors(el);
      }
    } catch (_) {
      // ignore
    }
  }

  async _onRootChange(event) {
    const target = event.target;

    const select = target?.closest?.('select[data-action="select-faction"]');
    if (select) {
      const uuid = String(select.value || '').trim();
      this._activeFactionUuid = uuid;
      this.render(false);
      return;
    }

    const originSelect = target?.closest?.('select[data-action="origin-change"]');
    if (originSelect) {
      // Editor handles this; ignore here.
      return;
    }
  }

  async _onRootClick(event) {
    const a = event.target?.closest?.('[data-action]');
    if (!a) return;

    const action = String(a.dataset.action || '').trim();

    if (action === 'set-view') {
      event.preventDefault();
      this._setView(a.dataset.view);
      this.render(false);
      return;
    }

    if (action === 'toggle-show-hidden') {
      event.preventDefault();
      this._showHidden = !this._showHidden;
      this.render(false);
      return;
    }

    if (action === 'toggle-expand') {
      event.preventDefault();
      const uuid = String(a.dataset.uuid || '').trim();
      if (!uuid) return;
      if (this._expanded.has(uuid)) this._expanded.delete(uuid);
      else this._expanded.add(uuid);
      this.render(false);
      return;
    }

    if (action === 'create-entry') {
      event.preventDefault();
      await this._openCreateEditor();
      return;
    }

    if (action === 'edit-entry') {
      event.preventDefault();
      const uuid = String(a.dataset.uuid || '').trim();
      if (!uuid) return;
      await this._openEditEditor(uuid);
      return;
    }

    if (action === 'toggle-hidden') {
      event.preventDefault();
      const uuid = String(a.dataset.uuid || '').trim();
      if (!uuid) return;
      await this._toggleHidden(uuid);
      return;
    }

    if (action === 'toggle-global') {
      event.preventDefault();
      const uuid = String(a.dataset.uuid || '').trim();
      if (!uuid) return;
      await this._toggleGlobal(uuid);
      return;
    }

    if (action === 'move-up' || action === 'move-down') {
      event.preventDefault();
      const uuid = String(a.dataset.uuid || '').trim();
      if (!uuid) return;
      const dir = action === 'move-up' ? -1 : 1;
      await this._moveEntry(uuid, dir);
      return;
    }

    if (action === 'delete-entry') {
      event.preventDefault();
      const uuid = String(a.dataset.uuid || '').trim();
      if (!uuid) return;
      await this._deleteEntry(uuid);
    }
  }

  _suggestYearFromCurrentView() {
    try {
      const items = this._collectEntryDocsForView();
      // Sort by year/id
      const list = items
        .map(({ page }) => ({ page, t: getTimelineEntryData(page) }))
        .sort((a, b) => {
          if (a.t.year !== b.t.year) return a.t.year - b.t.year;
          return a.t.id - b.t.id;
        });

      const last = list[list.length - 1];
      return last?.t?.year ?? 1;
    } catch (_) {
      return 1;
    }
  }

  async _openCreateEditor() {
    const isGM = _isGM();

    const factions = this._getFactionChoicesForUi();

    let origin = TIMELINE_ORIGIN.FACTION;
    if (isGM) {
      origin = (this._view === 'faction' && String(this._activeFactionUuid || '').trim())
        ? TIMELINE_ORIGIN.FACTION
        : TIMELINE_ORIGIN.WORLD;
    }

    let factionUuid = String(this._activeFactionUuid || '').trim();
    if (!factionUuid) factionUuid = factions?.[0]?.uuid ?? '';

    const suggestedYear = this._suggestYearFromCurrentView();

    // When GM creates from aggregated views, default to "global".
    const defaultGlobal = isGM && (this._view === 'gm' || this._view === 'public');

    const app = new TimelineEntryEditorApp({
      mode: 'create',
      origin,
      factionUuid,
      isGlobal: defaultGlobal,
      year: suggestedYear,
      factions,
      allowOriginSelect: isGM,
    });

    app.render(true);
  }

  async _openEditEditor(pageUuid) {
    const page = await resolveTimelinePage(pageUuid);
    if (!page) {
      ui.notifications?.warn?.('Запись не найдена');
      return;
    }

    const entry = page.parent;
    const t = getTimelineEntryData(page);

    const canEdit = _isGM() || ((t.origin === TIMELINE_ORIGIN.FACTION) && canUserOwnContainer(entry, game.user));
    if (!canEdit) {
      ui.notifications?.warn?.('Нет прав на редактирование');
      return;
    }

    const containerKind = getTimelineContainerKind(entry);
    const isGlobal = (containerKind === TIMELINE_CONTAINER_KIND.WORLD_PUBLIC) || (containerKind === TIMELINE_CONTAINER_KIND.FACTION_PUBLIC);

    const factions = this._getFactionChoicesForUi();

    const app = new TimelineEntryEditorApp({
      mode: 'edit',
      pageUuid: page.uuid,
      origin: t.origin,
      factionUuid: t.factionUuid,
      isGlobal,
      year: t.year,
      title: String(page.name ?? ''),
      content: String(page?.text?.content ?? ''),
      factions,
      allowOriginSelect: false,
    });

    app.render(true);
  }

  async _toggleHidden(pageUuid) {
    const page = await resolveTimelinePage(pageUuid);
    if (!page) return;

    const entry = page.parent;
    const t = getTimelineEntryData(page);

    if (!_isGM()) {
      if (t.origin !== TIMELINE_ORIGIN.FACTION) return;
      if (!canUserOwnContainer(entry, game.user)) {
        ui.notifications?.warn?.('Нет прав');
        return;
      }
    }

    await setTimelineEntryHidden(page, !t.isHidden);
    this.render(false);
  }

  async _toggleGlobal(pageUuid) {
    const page = await resolveTimelinePage(pageUuid);
    if (!page) return;

    const entry = page.parent;

    const t = getTimelineEntryData(page);

    // Players can only toggle global on faction-origin entries they own.
    if (!_isGM()) {
      if (t.origin !== TIMELINE_ORIGIN.FACTION) return;
      if (!canUserOwnContainer(entry, game.user)) {
        ui.notifications?.warn?.('Нет прав');
        return;
      }
    }

    const kind = getTimelineContainerKind(entry);

    const toKind = (kind === TIMELINE_CONTAINER_KIND.FACTION_PUBLIC)
      ? TIMELINE_CONTAINER_KIND.FACTION_PRIVATE
      : TIMELINE_CONTAINER_KIND.FACTION_PUBLIC;

    const wasExpanded = this._expanded.has(page.uuid);

    try {
      const newPage = await moveTimelineEntryBetweenContainers(page, { toKind, factionUuid: t.factionUuid });
      this._expanded.delete(page.uuid);
      if (wasExpanded && newPage?.uuid) this._expanded.add(newPage.uuid);
    } catch (e) {
      console.error('SpaceHolder | Timeline: failed to toggle global', e);
      ui.notifications?.error?.('Не удалось перенести запись');
    }

    this.render(false);
  }

  async _moveEntry(pageUuid, dir) {
    const page = await resolveTimelinePage(pageUuid);
    if (!page) return;

    const entry = page.parent;
    if (!canUserOwnContainer(entry, game.user)) {
      ui.notifications?.warn?.('Нет прав');
      return;
    }

    const t = getTimelineEntryData(page);

    // For players: reorder within the same faction only.
    if (!_isGM()) {
      if (t.origin !== TIMELINE_ORIGIN.FACTION) return;
      if (!t.factionUuid) return;

      const priv = getTimelineContainer({ kind: TIMELINE_CONTAINER_KIND.FACTION_PRIVATE, factionUuid: t.factionUuid });
      const pub = getTimelineContainer({ kind: TIMELINE_CONTAINER_KIND.FACTION_PUBLIC, factionUuid: t.factionUuid });

      const pages = [
        ...(priv ? listTimelinePagesInContainer(priv) : []),
        ...(pub ? listTimelinePagesInContainer(pub) : []),
      ].filter((p) => {
        const tp = getTimelineEntryData(p);
        return tp.year === t.year;
      });

      pages.sort((a, b) => {
        const ia = getTimelineEntryData(a).id;
        const ib = getTimelineEntryData(b).id;
        return ia - ib;
      });

      const idx = pages.findIndex((p) => p.uuid === page.uuid);
      if (idx < 0) return;

      const neighbor = pages[idx + dir];
      if (!neighbor) return;

      await swapTimelineEntryIds(page, neighbor);
      this.render(false);
      return;
    }

    // GM: reorder within the current view (nearest visible in the same year)
    const list = this._collectEntryDocsForView()
      .map(({ page: p }) => p)
      .filter((p) => {
        const tp = getTimelineEntryData(p);
        if (tp.year !== t.year) return false;
        if ((this._view === 'public' || this._view === 'gm') && !this._showHidden) {
          if (tp.isHidden) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ta = getTimelineEntryData(a);
        const tb = getTimelineEntryData(b);
        if (ta.year !== tb.year) return ta.year - tb.year;
        return ta.id - tb.id;
      });

    const idx = list.findIndex((p) => p.uuid === page.uuid);
    if (idx < 0) return;

    const neighbor = list[idx + dir];
    if (!neighbor) return;

    await swapTimelineEntryIds(page, neighbor);
    this.render(false);
  }

  async _deleteEntry(pageUuid) {
    const page = await resolveTimelinePage(pageUuid);
    if (!page) return;

    const entry = page.parent;
    const t = getTimelineEntryData(page);

    if (!_isGM()) {
      if (t.origin !== TIMELINE_ORIGIN.FACTION) return;
      if (!canUserOwnContainer(entry, game.user)) {
        ui.notifications?.warn?.('Нет прав');
        return;
      }
    }

    const ok = await _confirmDialog({
      title: 'Удалить запись',
      content: '<p><b>Удалить запись таймлайна?</b></p><p>Действие необратимо.</p>',
      yesLabel: 'Удалить',
      yesIcon: 'fa-solid fa-trash',
      noLabel: 'Отмена',
      noIcon: 'fa-solid fa-times',
    });

    if (!ok) return;

    await deleteTimelineEntryPage(page);
    this._expanded.delete(page.uuid);
    this.render(false);
  }
}

class TimelineEntryEditorApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-timeline-entry-editor',
    classes: ['spaceholder', 'timeline-entry-editor', 'sh-tle'],
    tag: 'form',
    window: { title: 'Запись таймлайна', resizable: true },
    position: { width: 820, height: 760 },
    form: {
      handler: _onTimelineEntryEditorSubmit,
      submitOnChange: false,
      closeOnSubmit: false,
    },
  };

  static PARTS = {
    main: { root: true, template: TEMPLATE_EDITOR },
  };

  constructor({
    mode,
    pageUuid = null,
    origin,
    factionUuid = '',
    isGlobal = false,
    year = 1,
    title = '',
    content = '',
    factions = [],
    allowOriginSelect = false,
  } = {}) {
    super();

    this._mode = String(mode || 'create');
    this._pageUuid = pageUuid;

    this._origin = String(origin || '').trim() || TIMELINE_ORIGIN.FACTION;
    this._factionUuid = String(factionUuid || '').trim();
    this._isGlobal = !!isGlobal;

    this._year = Number.parseInt(year, 10);
    if (!Number.isFinite(this._year) || this._year <= 0) this._year = 1;

    this._yearFallback = this._year;

    this._title = String(title || '');
    this._content = String(content || '');

    this._factions = Array.isArray(factions) ? factions : [];
    this._allowOriginSelect = !!allowOriginSelect;

    this._onClick = this._onClick.bind(this);
    this._onChange = this._onChange.bind(this);
  }

  async _prepareContext(_options) {
    let enrichedContent = '';
    try {
      enrichedContent = await foundry.applications.ux.TextEditor.implementation.enrichHTML(this._content, {
        async: true,
        secrets: true,
      });
    } catch (_) {
      enrichedContent = '';
    }

    const isCreate = this._mode === 'create';
    const isGM = _isGM();

    const origin = this._origin; // fixed for edit

    const showOriginSelect = isCreate && isGM && this._allowOriginSelect;

    const showFactionSelect = (() => {
      // For create: show selection when there are multiple factions (or when current value is missing).
      if (!isCreate) return false;
      const isFactionLike = (origin === TIMELINE_ORIGIN.FACTION) || (origin === TIMELINE_ORIGIN.WORLD);
      if (!isFactionLike) return false;
      if ((this._factions?.length ?? 0) > 1) return true;
      return !String(this._factionUuid || '').trim();
    })();

    const showGlobalToggle = (origin === TIMELINE_ORIGIN.FACTION) || (origin === TIMELINE_ORIGIN.WORLD);

    return {
      year: this._year,
      title: this._title,
      origin,
      factionUuid: this._factionUuid,
      isGlobal: this._isGlobal,
      factions: this._factions,
      showOriginSelect,
      showFactionSelect,
      showGlobalToggle,
      // For <prose-mirror>: raw value + enriched preview content.
      documentUuid: this._pageUuid,
      content: this._content,
      enrichedContent,
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    const el = this.element;
    if (!el) return;

    // Root is a <form>
    try {
      el.setAttribute('autocomplete', 'off');
    } catch (_) {
      // ignore
    }

    if (el.dataset?.shTimelineEditorHandlers !== 'true') {
      el.dataset.shTimelineEditorHandlers = 'true';
      el.addEventListener('click', this._onClick);
      el.addEventListener('change', this._onChange);

      // Year: prevent empty (restore fallback)
      const yearInput = el.querySelector('input[data-field="timelineYear"]');
      if (yearInput) {
        const syncFallback = () => {
          const raw = String(yearInput.value ?? '').trim();
          const n = Number.parseInt(raw, 10);
          if (raw && Number.isFinite(n) && n > 0) {
            this._yearFallback = n;
          }
        };

        yearInput.addEventListener('change', syncFallback);
        yearInput.addEventListener('blur', () => {
          const raw = String(yearInput.value ?? '').trim();
          const n = Number.parseInt(raw, 10);

          if (!raw || !Number.isFinite(n) || n <= 0) {
            yearInput.value = String(this._yearFallback || 1);
          } else {
            this._yearFallback = n;
          }
        });
      }
    }
  }

  async _onClick(ev) {
    const btn = ev.target?.closest?.('button[data-action]');
    if (!btn) return;

    const action = String(btn.dataset.action || '').trim();

    if (action === 'cancel') {
      ev.preventDefault();
      await this.close();
    }
  }

  async _onChange(ev) {
    const sel = ev.target?.closest?.('select[name="origin"]');
    if (sel) {
      const v = String(sel.value || '').trim();
      this._origin = (v === TIMELINE_ORIGIN.WORLD) ? TIMELINE_ORIGIN.WORLD : TIMELINE_ORIGIN.FACTION;
      this.render(false);
      return;
    }

    const factionSel = ev.target?.closest?.('select[name="factionUuid"]');
    if (factionSel) {
      this._factionUuid = String(factionSel.value || '').trim();
      return;
    }

    const globalCb = ev.target?.closest?.('input[type="checkbox"][name="isGlobal"]');
    if (globalCb) {
      this._isGlobal = !!globalCb.checked;
      return;
    }
  }

  async _onSubmit(_event, _form, formData) {
    const data = formData.object;

    const title = String(data.title || '').trim();
    if (!title) {
      ui.notifications?.warn?.('Название обязательно');
      return;
    }

    // Year
    const yearRaw = String(data.year ?? '').trim();
    let year = Number.parseInt(yearRaw, 10);
    if (!Number.isFinite(year) || year <= 0) year = Number(this._yearFallback) || 1;

    const content = String(data.content ?? this._content ?? '');

    // Determine origin / faction / global
    const isGM = _isGM();

    let origin = this._origin;
    let factionUuid = this._factionUuid;
    let isGlobal = this._isGlobal;

    if (this._mode === 'create') {
      if (isGM && this._allowOriginSelect) {
        const o = String(data.origin || '').trim();
        origin = (o === TIMELINE_ORIGIN.WORLD) ? TIMELINE_ORIGIN.WORLD : TIMELINE_ORIGIN.FACTION;
      } else {
        origin = TIMELINE_ORIGIN.FACTION;
      }

      // pick faction + global from form
      factionUuid = String(data.factionUuid || factionUuid || '').trim();
      isGlobal = !!data.isGlobal;

      if ((origin === TIMELINE_ORIGIN.FACTION || origin === TIMELINE_ORIGIN.WORLD) && !factionUuid) {
        ui.notifications?.warn?.('Не выбрана фракция');
        return;
      }

      // World-origin entries can only be created by GM
      if (origin === TIMELINE_ORIGIN.WORLD && !isGM) {
        ui.notifications?.warn?.('Только ГМ может писать от имени мира');
        return;
      }

      try {
        await createTimelineEntry({
          origin,
          factionUuid,
          isGlobal,
          year,
          title,
          content,
        });
        await this.close();
      } catch (e) {
        console.error('SpaceHolder | Timeline: create failed', e);
        ui.notifications?.error?.('Не удалось создать запись');
      }

      return;
    }

    // Edit
    const page = await resolveTimelinePage(this._pageUuid);
    if (!page) {
      ui.notifications?.warn?.('Запись не найдена');
      await this.close();
      return;
    }

    const entry = page.parent;
    if (!canUserOwnContainer(entry, game.user)) {
      ui.notifications?.warn?.('Нет прав');
      await this.close();
      return;
    }

    const t = getTimelineEntryData(page);
    origin = t.origin;
    factionUuid = t.factionUuid;

    // Apply updates (year/title/content)
    try {
      await updateTimelineEntryPage(page, { year, title, content });
    } catch (e) {
      console.error('SpaceHolder | Timeline: update failed', e);
      ui.notifications?.error?.('Не удалось сохранить запись');
      return;
    }

    // Handle global toggle for faction/world entries
    if (origin === TIMELINE_ORIGIN.FACTION || origin === TIMELINE_ORIGIN.WORLD) {
      if (origin === TIMELINE_ORIGIN.WORLD && !isGM) return;

      const desiredGlobal = !!data.isGlobal;
      const kind = getTimelineContainerKind(page.parent);
      const curGlobal = (kind === TIMELINE_CONTAINER_KIND.FACTION_PUBLIC);

      if (desiredGlobal !== curGlobal) {
        const toKind = desiredGlobal ? TIMELINE_CONTAINER_KIND.FACTION_PUBLIC : TIMELINE_CONTAINER_KIND.FACTION_PRIVATE;
        try {
          await moveTimelineEntryBetweenContainers(page, { toKind, factionUuid });
        } catch (e) {
          console.error('SpaceHolder | Timeline: move failed', e);
          ui.notifications?.error?.('Не удалось перенести запись');
          return;
        }
      }
    }

    await this.close();
  }
}

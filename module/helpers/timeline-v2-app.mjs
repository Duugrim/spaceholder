import {
  createTimelineV2Event,
  ensureTimelineV2InfrastructureForCurrentUser,
  getAvailableFactionChoices,
  getTimelineV2ActiveFactionsSetting,
  getTimelineV2ActiveFactionUuids,
  getTimelineV2HideUnknown,
  getTimelineV2PageData,
  getTimelineV2Zoom,
  setTimelineV2Zoom,
  installTimelineV2Hooks,
  isTimelineV2Page,
  listTimelineV2IndexPages,
  resolveTimelineV2Page,
  resolveTimelineV2DetailFromIndex,
  setTimelineV2ActiveFactionsSetting,
  setTimelineV2HideUnknown,
  updateTimelineV2EventDate,
  deleteTimelineV2Event,
} from './timeline-v2.mjs';

const TEMPLATE_APP = 'systems/spaceholder/templates/timeline-v2/timeline-v2-app.hbs';
const TEMPLATE_EDITOR = 'systems/spaceholder/templates/timeline-v2/timeline-v2-event-editor.hbs';

const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 12 * DAYS_PER_MONTH; // 360

const CANVAS_PAD_PX = 40;
const BASE_PX_PER_YEAR = 84;

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

// Marker/pill layout (pixels)
const EVENT_OFFSET_PX = 44;
const EVENT_MIN_DY_PX = 32;

function _dateToSerial({ year, month, day }) {
  const y = Number(year) || 0;
  const m = Number(month) || 1;
  const d = Number(day) || 1;
  return (y * DAYS_PER_YEAR) + ((m - 1) * DAYS_PER_MONTH) + (d - 1);
}

function _serialToDate(serial) {
  const s = Number(serial) || 0;

  const year = Math.floor(s / DAYS_PER_YEAR);
  const dayOfYear = ((s % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;

  const month = Math.floor(dayOfYear / DAYS_PER_MONTH) + 1;
  const day = (dayOfYear % DAYS_PER_MONTH) + 1;

  return { year, month, day };
}

function _getTextEditorImpl() {
  return foundry?.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
}

async function _enrichHtml(content, { relativeTo = null } = {}) {
  const impl = _getTextEditorImpl();
  if (!impl?.enrichHTML) return String(content ?? '');

  return await impl.enrichHTML(String(content ?? ''), {
    async: true,
    secrets: _isGM(),
    relativeTo,
  });
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

class TimelineV2EventEditorApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-timeline-v2-event-editor',
    classes: ['spaceholder', 'timeline-v2-event-editor', 'sh-tl2e-app'],
    tag: 'form',
    window: { title: 'Событие (Timeline V2)', resizable: true },
    position: { width: 760, height: 760 },
    form: {
      handler: _onTimelineV2EditorSubmit,
      submitOnChange: false,
      closeOnSubmit: false,
    },
  };

  static PARTS = {
    main: { root: true, template: TEMPLATE_EDITOR },
  };

  constructor({
    mode = 'create',
    indexUuid = '',
    onSaved = null,

    factions = [],
    allowNoFaction = false,
    factionUuid = '',
    isGlobal = false,
    year = 0,
    month = 1,
    day = 1,
    title = '',
    content = '',
  } = {}) {
    super();

    this._mode = (String(mode || 'create') === 'edit') ? 'edit' : 'create';
    this._indexUuid = String(indexUuid || '').trim();
    this._onSaved = (typeof onSaved === 'function') ? onSaved : null;

    this._factions = Array.isArray(factions) ? factions : [];
    this._allowNoFaction = !!allowNoFaction;

    this._factionUuid = String(factionUuid || '').trim();

    this._isGlobal = !!isGlobal;
    if (!this._factionUuid && this._allowNoFaction) this._isGlobal = true;

    this._year = Number.parseInt(year, 10);
    if (!Number.isFinite(this._year)) this._year = 0;

    this._month = Number.parseInt(month, 10);
    if (!Number.isFinite(this._month) || this._month < 1 || this._month > 12) this._month = 1;

    this._day = Number.parseInt(day, 10);
    if (!Number.isFinite(this._day) || this._day < 1 || this._day > 30) this._day = 1;

    this._title = String(title || '');
    this._content = String(content || '');

    this._onClick = this._onClick.bind(this);
    this._onChange = this._onChange.bind(this);
  }

  async _prepareContext(_options) {
    const monthChoices = Array.from({ length: 12 }, (_, i) => i + 1);
    const dayChoices = Array.from({ length: 30 }, (_, i) => i + 1);

    const isEdit = this._mode === 'edit';

    const showFactionSelect = !isEdit && (this._allowNoFaction || (this._factions.length > 0));
    const showGlobalToggle = !isEdit && !!this._factionUuid;

    return {
      year: this._year,
      month: this._month,
      day: this._day,
      title: this._title,
      content: this._content,
      factions: this._factions,
      allowNoFaction: this._allowNoFaction,
      factionUuid: this._factionUuid,
      isGlobal: this._isGlobal,
      showFactionSelect,
      showGlobalToggle,
      monthChoices,
      dayChoices,
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    const el = this.element;
    if (!el) return;

    if (el.dataset?.shTl2eHandlers !== 'true') {
      el.dataset.shTl2eHandlers = 'true';
      el.addEventListener('click', this._onClick);
      el.addEventListener('change', this._onChange);
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
    const factionSel = ev.target?.closest?.('select[name="factionUuid"][data-action="faction-change"]');
    if (factionSel) {
      this._factionUuid = String(factionSel.value || '').trim();
      if (!this._factionUuid && this._allowNoFaction) this._isGlobal = true;
      this.render(false);
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

    const year = Number.parseInt(String(data.year ?? '').trim(), 10);
    const month = Number.parseInt(String(data.month ?? '').trim(), 10);
    const day = Number.parseInt(String(data.day ?? '').trim(), 10);

    const content = String(data.content ?? '');

    // ===== Edit =====
    if (this._mode === 'edit') {
      const indexUuid = String(this._indexUuid || '').trim();
      if (!indexUuid) {
        ui.notifications?.error?.('Не удалось сохранить событие');
        return;
      }

      const indexPage = await resolveTimelineV2Page(indexUuid);
      if (!indexPage) {
        ui.notifications?.warn?.('Событие не найдено');
        return;
      }

      const t = getTimelineV2PageData(indexPage);
      if (!t?.isIndex) {
        ui.notifications?.warn?.('Событие не найдено');
        return;
      }

      let detailPage = null;
      try {
        detailPage = await resolveTimelineV2DetailFromIndex(indexPage);
      } catch (_) {
        detailPage = null;
      }

      if (!detailPage) {
        ui.notifications?.warn?.('Событие не найдено');
        return;
      }

      const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
      const canEdit = _isGM() || detailPage.testUserPermission?.(game.user, OWN);
      if (!canEdit) {
        ui.notifications?.warn?.('Нет прав на редактирование');
        return;
      }

      try {
        await detailPage.update({
          name: title,
          text: { content },
        }, { diff: false, spaceholderJournalCheck: true });

        const y = Number.isFinite(year) ? year : t.year;
        const m = Number.isFinite(month) ? month : t.month;
        const d = Number.isFinite(day) ? day : t.day;

        if (t.year !== y || t.month !== m || t.day !== d) {
          await updateTimelineV2EventDate({
            indexUuid: indexPage.uuid,
            year: y,
            month: m,
            day: d,
          });
        }

        if (this._onSaved) {
          await this._onSaved({ indexUuid: indexPage.uuid, detailUuid: detailPage.uuid });
        }

        await this.close();
      } catch (e) {
        console.error('SpaceHolder | TimelineV2: update failed', e);
        ui.notifications?.error?.('Не удалось сохранить событие');
      }

      return;
    }

    // ===== Create =====
    const factionUuid = String(data.factionUuid ?? this._factionUuid ?? '').trim();

    // World events are always global.
    const isGlobal = factionUuid ? !!data.isGlobal : true;

    try {
      await createTimelineV2Event({
        year,
        month,
        day,
        factionUuid,
        isGlobal,
        title,
        content,
      });

      await this.close();
    } catch (e) {
      console.error('SpaceHolder | TimelineV2: create failed', e);
      ui.notifications?.error?.('Не удалось создать событие');
    }
  }
}

function _formatDate({ year, month, day }) {
  const y = Number(year) || 0;
  const m = String(Number(month) || 1).padStart(2, '0');
  const d = String(Number(day) || 1).padStart(2, '0');
  return `${y}.${m}.${d}`;
}

function _pickTickStep(rangeYears) {
  const r = Math.abs(Number(rangeYears) || 0);
  if (r <= 30) return 1;
  if (r <= 60) return 2;
  if (r <= 120) return 5;
  if (r <= 240) return 10;
  if (r <= 600) return 25;
  return 50;
}

let _singleton = null;
let _hooksInstalled = false;

function _isGM() {
  return !!game?.user?.isGM;
}

function _installHooksOnce() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  const rerender = () => {
    try {
      if (_singleton?._renderPreserveScroll) _singleton._renderPreserveScroll();
      else if (_singleton) _singleton.render(false);
    } catch (_) {
      // ignore
    }
  };

  Hooks.on('createJournalEntryPage', (page) => {
    try {
      if (!isTimelineV2Page(page)) return;
      rerender();
    } catch (_) {
      // ignore
    }
  });
  Hooks.on('updateJournalEntryPage', (page) => {
    try {
      if (!isTimelineV2Page(page)) return;

      // If the currently opened details pane is bound to this page, refresh its content.
      // This keeps the right pane in sync when editing via the Journal UI.
      if (
        _singleton?._drawerOpen
        && _singleton?._drawerIndexUuid
        && (page.uuid === _singleton._drawerIndexUuid || page.uuid === _singleton._drawerDetailUuid)
      ) {
        _singleton._openDetailsDrawer(_singleton._drawerIndexUuid).catch(() => rerender());
        return;
      }

      rerender();
    } catch (_) {
      // ignore
    }
  });
  Hooks.on('deleteJournalEntryPage', (page) => {
    try {
      if (!isTimelineV2Page(page)) return;

      if (
        _singleton?._drawerOpen
        && _singleton?._drawerIndexUuid
        && (page.uuid === _singleton._drawerIndexUuid || page.uuid === _singleton._drawerDetailUuid)
      ) {
        _singleton._selectedEventUuid = '';
        _singleton._closeDetailsDrawer();
      }

      rerender();
    } catch (_) {
      // ignore
    }
  });
}

async function _onTimelineV2EditorSubmit(event, form, formData) {
  // Foundry calls this with `this` bound to the application instance.
  return this?._onSubmit?.(event, form, formData);
}

export function openTimelineV2App() {
  _installHooksOnce();

  if (_singleton) {
    _singleton.render(true);
    _singleton.bringToTop?.();
    return _singleton;
  }

  _singleton = new TimelineV2App();
  _singleton.render(true);

  // Ensure infra in background and re-render when ready
  ensureTimelineV2InfrastructureForCurrentUser()
    .then(() => {
      try {
        if (_singleton) {
          _singleton._loading = false;
          if (_singleton._renderPreserveScroll) _singleton._renderPreserveScroll();
          else _singleton.render(false);
        }
      } catch (_) {
        // ignore
      }
    })
    .catch(() => {
      try {
        if (_singleton) {
          _singleton._loading = false;
          if (_singleton._renderPreserveScroll) _singleton._renderPreserveScroll();
          else _singleton.render(false);
        }
      } catch (_) {
        // ignore
      }
    });

  return _singleton;
}

class TimelineV2App extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-timeline-v2',
    classes: ['spaceholder', 'timeline-v2'],
    tag: 'div',
    window: { title: 'Timeline V2', resizable: true },
    position: { width: 1400, height: 820 },
  };

  static PARTS = {
    main: { root: true, template: TEMPLATE_APP },
  };

  constructor() {
    super();

    installTimelineV2Hooks();

    this._loading = true;

    this._factionMenuOpen = false;
    this._didInitialScroll = false;

    this._restoreScrollTop = null;
    this._restoreScrollClearT = null;

    // Serial-based scroll restore (used for zoom to keep same date in view)
    this._restoreSerial = null;
    this._restoreSerialRel = 0.5;

    // Stage 3/4 UI state
    this._selectedEventUuid = '';
    this._drawerOpen = false;
    this._drawerTitle = '';
    this._drawerDateText = '';
    this._drawerContentHtml = '';
    this._drawerIndexUuid = '';
    this._drawerDetailUuid = '';
    this._drawerCanEdit = false;

    // Drag state
    this._serialMeta = null;
    this._drag = null;

    this._layoutRaf = null;

    this._onRootClick = this._onRootClick.bind(this);
    this._onRootChange = this._onRootChange.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onViewportScroll = this._onViewportScroll.bind(this);
  }

  async close(options = {}) {
    await super.close(options);
    if (_singleton === this) _singleton = null;
  }

  async _openCreateEditor() {
    const isGM = _isGM();
    const factions = this._getFactionChoicesForUi();

    const active = getTimelineV2ActiveFactionUuids();

    const pickDefaultFaction = () => {
      for (const u of active) {
        if (factions.some((f) => f.uuid === u)) return u;
      }
      return factions?.[0]?.uuid ?? '';
    };

    const defaultFactionUuid = isGM ? (pickDefaultFaction() || '') : pickDefaultFaction();

    const app = new TimelineV2EventEditorApp({
      factions,
      allowNoFaction: isGM,
      factionUuid: defaultFactionUuid,
      isGlobal: false,
      year: 0,
      month: 1,
      day: 1,
      title: '',
      content: '',
    });

    app.render(true);
  }

  async _openEditEditor(indexUuid) {
    const indexPage = await resolveTimelineV2Page(indexUuid);
    if (!indexPage) {
      ui.notifications?.warn?.('Событие не найдено');
      return;
    }

    const t = getTimelineV2PageData(indexPage);
    if (!t?.isIndex) {
      ui.notifications?.warn?.('Событие не найдено');
      return;
    }

    let detail = null;
    try {
      detail = await resolveTimelineV2DetailFromIndex(indexPage);
    } catch (_) {
      detail = null;
    }

    if (!detail) {
      ui.notifications?.warn?.('Событие не найдено');
      return;
    }

    const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    const canEdit = _isGM() || detail.testUserPermission?.(game.user, OWN);
    if (!canEdit) {
      ui.notifications?.warn?.('Нет прав на редактирование');
      return;
    }

    const app = new TimelineV2EventEditorApp({
      mode: 'edit',
      indexUuid: indexPage.uuid,
      year: t.year,
      month: t.month,
      day: t.day,
      title: String(detail?.name ?? ''),
      content: String(detail?.text?.content ?? ''),
      onSaved: async () => {
        try {
          await this._openDetailsDrawer(indexPage.uuid);
        } catch (_) {
          // ignore
        }
      },
    });

    app.render(true);
  }

  _getFactionChoicesForUi() {
    const isGM = _isGM();
    // GM: all factions always available
    // Player: only own factions
    const list = getAvailableFactionChoices({ includeAllWorldFactions: isGM });
    return list;
  }

  _captureViewportScrollTop() {
    try {
      const vp = this.element?.querySelector?.('[data-field="timelineViewport"]');
      if (!vp) return null;
      const v = Number(vp.scrollTop);
      return Number.isFinite(v) ? v : null;
    } catch (_) {
      return null;
    }
  }

  _captureViewportAnchorSerial(rel = 0.5) {
    try {
      const vp = this.element?.querySelector?.('[data-field="timelineViewport"]');
      const meta = this._serialMeta;
      if (!vp || !meta) return null;

      if (!Number.isFinite(meta.pxPerDay) || !Number.isFinite(meta.maxBoundSerial) || !Number.isFinite(meta.padPx)) {
        return null;
      }

      const r = Number(rel);
      const safeRel = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5;

      const anchorPx = Number(vp.scrollTop) + (vp.clientHeight * safeRel);
      const serial = Math.round(meta.maxBoundSerial - ((anchorPx - meta.padPx) / meta.pxPerDay));
      return Number.isFinite(serial) ? serial : null;
    } catch (_) {
      return null;
    }
  }

  _renderPreserveScroll() {
    // Preserve the first known-good scrollTop until it gets applied in _onRender.
    // This prevents cases where rerenders triggered by document updates capture an already-reset scrollTop.
    if (!Number.isFinite(this._restoreScrollTop)) {
      const v = this._captureViewportScrollTop();
      if (Number.isFinite(v)) this._restoreScrollTop = v;
    }

    this.render(false);
  }

  _scheduleFloatingLayout() {
    if (this._layoutRaf) return;

    this._layoutRaf = requestAnimationFrame(() => {
      this._layoutRaf = null;
      this._layoutFloatingEvents();
    });
  }

  _onViewportScroll() {
    // Avoid fighting with drag positioning.
    if (this._drag) return;
    this._scheduleFloatingLayout();
  }

  _layoutFloatingEvents() {
    // Avoid fighting with drag positioning.
    if (this._drag) return;

    const root = this.element;
    if (!root) return;

    const viewport = root.querySelector('[data-field="timelineViewport"]');
    const canvas = root.querySelector('[data-field="timelineCanvas"]');
    if (!viewport || !canvas) return;

    const vpTop = Number(viewport.scrollTop) || 0;
    const vpBottom = vpTop + (Number(viewport.clientHeight) || 0);

    // If viewport isn't measurable yet, skip.
    if (!(vpBottom > vpTop)) return;

    const minDy = EVENT_MIN_DY_PX;

    // Keep floating pills inside viewport as much as possible.
    const pad = Math.round(minDy * 0.5);
    const minY = vpTop + pad;
    const maxY = vpBottom - pad;

    const nodes = Array.from(canvas.querySelectorAll('.sh-tl2__event'));

    const sides = {
      left: [],
      right: [],
    };

    for (const el of nodes) {
      const anchorTop = Number.parseFloat(String(el.dataset.anchorTop || ''));
      if (!Number.isFinite(anchorTop)) continue;

      // Only render if the exact date point is currently visible.
      const visible = anchorTop >= vpTop && anchorTop <= vpBottom;
      if (!visible) {
        el.style.display = 'none';
        continue;
      }

      el.style.display = '';

      const side = el.classList.contains('is-left') ? 'left' : 'right';
      sides[side].push({ el, anchorTop });
    }

    const layoutSide = (items) => {
      if (!items.length) return;

      items.sort((a, b) => {
        if (a.anchorTop !== b.anchorTop) return a.anchorTop - b.anchorTop;
        return String(a.el.dataset.uuid || '').localeCompare(String(b.el.dataset.uuid || ''));
      });

      const anchors = items.map((it) => it.anchorTop);
      const y = anchors.slice();

      // Forward pass: prevent overlaps.
      for (let i = 1; i < y.length; i += 1) {
        const minNext = y[i - 1] + minDy;
        if (y[i] < minNext) y[i] = minNext;
      }

      // Backward pass: pull back up where possible to stay closer to anchors.
      for (let i = y.length - 2; i >= 0; i -= 1) {
        const maxPrev = y[i + 1] - minDy;
        if (y[i] > maxPrev) y[i] = maxPrev;
      }

      // Shift block into viewport if possible.
      if (Number.isFinite(minY) && Number.isFinite(maxY) && maxY > minY) {
        const lowerShift = minY - y[0];
        const upperShift = maxY - y[y.length - 1];

        let shift = 0;
        if (lowerShift <= upperShift) {
          // Keep shift at 0 if possible.
          shift = Math.min(upperShift, Math.max(lowerShift, 0));
        } else {
          // Cannot fit: center the block.
          shift = ((minY + maxY) * 0.5) - ((y[0] + y[y.length - 1]) * 0.5);
        }

        if (Number.isFinite(shift) && shift !== 0) {
          for (let i = 0; i < y.length; i += 1) y[i] += shift;
        }
      }

      for (let i = 0; i < items.length; i += 1) {
        const { el, anchorTop } = items[i];
        const floatTop = y[i];

        // Move event anchor to the floating position.
        el.style.top = `${Math.round(floatTop)}px`;

        // Wire from icon edge to the exact date point.
        const dy = anchorTop - floatTop;
        const side = el.classList.contains('is-left') ? 'left' : 'right';
        const dx = (side === 'left') ? -EVENT_OFFSET_PX : EVENT_OFFSET_PX;

        const vx = dx;
        const vy = -dy;

        const len = Math.sqrt((vx * vx) + (vy * vy));
        const angle = Math.atan2(vy, vx) * (180 / Math.PI);

        el.style.setProperty('--sh-wire-startY', `${Math.round(dy)}px`);
        el.style.setProperty('--sh-wire-length', `${Math.round(len)}px`);
        el.style.setProperty('--sh-wire-angle', `${angle}deg`);
      }
    };

    layoutSide(sides.left);
    layoutSide(sides.right);
  }

  async _openDetailsDrawer(indexUuid) {
    const indexPage = await resolveTimelineV2Page(indexUuid);
    if (!indexPage) return;

    const t = getTimelineV2PageData(indexPage);
    if (!t?.isIndex) return;

    const dateText = _formatDate(t);

    const OBS = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
    const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

    let detail = null;
    try {
      detail = await resolveTimelineV2DetailFromIndex(indexPage);
    } catch (_) {
      detail = null;
    }

    const canSeeDetail = !!detail && (_isGM() || detail.testUserPermission?.(game.user, OBS));
    const canEditDetail = !!detail && (_isGM() || detail.testUserPermission?.(game.user, OWN));

    const unknownText = game.i18n?.localize?.('SPACEHOLDER.Journal.Placeholders.Unknown') ?? 'Unknown';
    const untitledText = game.i18n?.localize?.('SPACEHOLDER.Journal.Placeholders.Untitled') ?? '(untitled)';

    this._selectedEventUuid = indexPage.uuid;
    this._drawerOpen = true;
    this._drawerDateText = dateText;
    this._drawerIndexUuid = indexPage.uuid;
    this._drawerDetailUuid = canSeeDetail ? (detail?.uuid ?? '') : '';
    this._drawerCanEdit = canSeeDetail && canEditDetail;

    if (!canSeeDetail) {
      this._drawerTitle = unknownText;
      this._drawerContentHtml = `<p><em>${unknownText}</em></p>`;
      this._renderPreserveScroll();
      return;
    }

    this._drawerTitle = String(detail?.name ?? '').trim() || untitledText;

    const rawHtml = String(detail?.text?.content ?? '');
    let enriched = '';
    try {
      enriched = await _enrichHtml(rawHtml, { relativeTo: detail });
    } catch (e) {
      console.warn('SpaceHolder | TimelineV2: enrichHTML failed', e);
      enriched = rawHtml;
    }

    this._drawerContentHtml = enriched;
    this._renderPreserveScroll();
  }

  _closeDetailsDrawer() {
    this._drawerOpen = false;
    this._drawerTitle = '';
    this._drawerDateText = '';
    this._drawerContentHtml = '';
    this._drawerIndexUuid = '';
    this._drawerDetailUuid = '';
    this._drawerCanEdit = false;
  }

  async _prepareContext(_options) {
    const isGM = _isGM();
    const loading = !!this._loading;

    const hideUnknown = getTimelineV2HideUnknown();
    const zoom = getTimelineV2Zoom();

    const minZoom = ZOOM_STEPS[0] ?? 1;
    const maxZoom = ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 1;

    const canZoomIn = zoom < (maxZoom - 1e-6);
    const canZoomOut = zoom > (minZoom + 1e-6);

    const factions = this._getFactionChoicesForUi();

    const activeCfg = getTimelineV2ActiveFactionsSetting();
    const activeFactionUuids = getTimelineV2ActiveFactionUuids();
    const activeSet = new Set(activeFactionUuids);

    const factionsUi = factions.map((f) => ({
      ...f,
      active: activeSet.has(f.uuid),
    }));

    const selectedUuid = String(this._selectedEventUuid || '').trim();

    // Menu shown if player has multiple factions; GM always.
    const showFactionMenu = isGM || (factionsUi.length > 1);

    const canCreate = isGM || (factionsUi.length > 0);

    // ===== Timeline layout (stage 2) =====
    const pxPerYear = BASE_PX_PER_YEAR * zoom;
    const pxPerDay = pxPerYear / DAYS_PER_YEAR;

    const indexPages = loading ? [] : listTimelineV2IndexPages();

    // Build raw events first (date/side/unknown), then compute range.
    const rawEvents = [];

    const OBS = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
    const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

    for (const page of indexPages) {
      const t = getTimelineV2PageData(page);
      if (!t?.isIndex) continue;

      // Resolve details to decide unknown + tooltip.
      let detail = null;
      try {
        detail = await resolveTimelineV2DetailFromIndex(page);
      } catch (_) {
        detail = null;
      }

      const canSeeDetail = !!detail && (isGM || detail.testUserPermission?.(game.user, OBS));
      const canDrag = !!detail && (isGM || detail.testUserPermission?.(game.user, OWN));
      const isUnknown = !canSeeDetail;

      if (hideUnknown && isUnknown) continue;

      const dateText = _formatDate(t);

      const sideClass = (!t.factionUuid || activeSet.has(t.factionUuid)) ? 'is-right' : 'is-left';

      // Resolve faction color (best-effort). Faction actors are expected to be visible in this system.
      let color = '';
      try {
        const fu = String(t.factionUuid || '').trim();
        if (fu) {
          const parts = fu.split('.');
          const actor = (parts[0] === 'Actor' && parts[1] && parts.length === 2)
            ? (game?.actors?.get?.(parts[1]) ?? null)
            : null;
          color = String(actor?.system?.fColor ?? '').trim();
        }
      } catch (_) {
        color = '';
      }

      const unknownText = game.i18n?.localize?.('SPACEHOLDER.Journal.Placeholders.Unknown') ?? 'Unknown';
      const untitledText = game.i18n?.localize?.('SPACEHOLDER.Journal.Placeholders.Untitled') ?? '(untitled)';

      const titleText = isUnknown
        ? ''
        : (String(detail?.name ?? '').trim() || untitledText);

      const tooltip = (() => {
        if (isUnknown) return `${dateText} · ${unknownText}`;
        return titleText ? `${dateText} · ${titleText}` : dateText;
      })();

      rawEvents.push({
        uuid: page.uuid,
        serial: _dateToSerial(t),
        year: t.year,
        month: t.month,
        day: t.day,
        factionUuid: t.factionUuid,
        sideClass,
        isUnknown,
        isSelected: selectedUuid === page.uuid,
        canDrag,
        dateText,
        titleText,
        color,
        tooltip,
      });
    }

    const hasEvents = rawEvents.length > 0;

    // Range in years
    let minYear = -10;
    let maxYear = 10;

    if (hasEvents) {
      const serials = rawEvents.map((e) => e.serial);
      const minSerial = Math.min(...serials);
      const maxSerial = Math.max(...serials);

      minYear = Math.floor(minSerial / DAYS_PER_YEAR);
      maxYear = Math.floor(maxSerial / DAYS_PER_YEAR);

      // Ensure year 0 is always in view
      minYear = Math.min(minYear, 0);
      maxYear = Math.max(maxYear, 0);

      // Padding
      minYear -= 2;
      maxYear += 2;
    }

    const rangeYears = maxYear - minYear;
    const tickStep = _pickTickStep(rangeYears);

    const minBoundSerial = minYear * DAYS_PER_YEAR;
    const maxBoundSerial = (maxYear + 1) * DAYS_PER_YEAR;

    // Used for drag inverse mapping.
    this._serialMeta = {
      minBoundSerial,
      maxBoundSerial,
      pxPerDay,
      padPx: CANVAS_PAD_PX,
    };

    const serialToTopPx = (serial) => Math.round(((maxBoundSerial - serial) * pxPerDay) + CANVAS_PAD_PX);

    const year0TopPx = serialToTopPx(0);

    const ticks = [];
    for (let y = minYear; y <= maxYear; y += tickStep) {
      ticks.push({
        year: y,
        topPx: serialToTopPx(y * DAYS_PER_YEAR),
      });
    }

    // Ensure year 0 tick exists
    if (!ticks.some((t) => t.year === 0)) {
      ticks.push({ year: 0, topPx: year0TopPx });
      ticks.sort((a, b) => a.topPx - b.topPx);
    }

    const events = rawEvents
      .map((e) => ({
        ...e,
        topPx: serialToTopPx(e.serial),
      }))
      .sort((a, b) => {
        // Visually: upper (larger year) first -> smaller top
        if (a.topPx !== b.topPx) return a.topPx - b.topPx;
        return String(a.uuid).localeCompare(String(b.uuid));
      });

    const canvasHeightPx = Math.max(
      520,
      Math.round(((maxBoundSerial - minBoundSerial) * pxPerDay) + (CANVAS_PAD_PX * 2)),
    );

    return {
      isGM,
      loading,
      hideUnknown,
      zoom,
      canZoomIn,
      canZoomOut,
      showFactionMenu,
      factionMenuOpen: !!this._factionMenuOpen,
      activeMode: activeCfg.mode,
      activeFactionUuids,
      factions: factionsUi,
      canCreate,

      // Stage 3/4
      drawerOpen: !!this._drawerOpen,
      drawerTitle: String(this._drawerTitle || ''),
      drawerDateText: String(this._drawerDateText || ''),
      drawerContentHtml: String(this._drawerContentHtml || ''),
      drawerIndexUuid: String(this._drawerIndexUuid || ''),
      drawerDetailUuid: String(this._drawerDetailUuid || ''),
      drawerCanOpen: !!this._drawerDetailUuid,
      drawerCanEdit: !!this._drawerCanEdit,

      hasEvents,
      ticks,
      events,
      canvasHeightPx,
      year0TopPx,
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    const el = this.element;
    if (!el) return;

    if (el.dataset?.shTimelineV2Handlers !== 'true') {
      el.dataset.shTimelineV2Handlers = 'true';
      el.addEventListener('click', this._onRootClick);
      el.addEventListener('change', this._onRootChange);
      el.addEventListener('pointerdown', this._onPointerDown);
    }

    // Ensure Foundry activates content-link/inline-roll listeners (and editor helpers, if present).
    try {
      foundry.applications.ux.TextEditor.activateListeners(el);
    } catch (_) {
      // ignore
    }

    try {
      if (typeof foundry.applications.ux.TextEditor.activateEditors === 'function') {
        foundry.applications.ux.TextEditor.activateEditors(el);
      }
    } catch (_) {
      // ignore
    }

    const viewport = el.querySelector('[data-field="timelineViewport"]');

    // Floating layout depends on viewport scroll; install scroll handler once per viewport instance.
    if (viewport && viewport.dataset?.shTl2ViewportHandlers !== 'true') {
      viewport.dataset.shTl2ViewportHandlers = 'true';
      viewport.addEventListener('scroll', this._onViewportScroll, { passive: true });
    }

    // Preserve scroll on rerender.
    if (viewport && (Number.isFinite(this._restoreSerial) || Number.isFinite(this._restoreScrollTop))) {
      let v = null;

      if (Number.isFinite(this._restoreSerial)) {
        const meta = this._serialMeta;
        if (meta && Number.isFinite(meta.pxPerDay) && Number.isFinite(meta.maxBoundSerial) && Number.isFinite(meta.padPx)) {
          const r = Number(this._restoreSerialRel);
          const safeRel = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5;

          const topPx = Math.round(((meta.maxBoundSerial - this._restoreSerial) * meta.pxPerDay) + meta.padPx);
          const anchorPx = viewport.clientHeight * safeRel;

          v = Math.max(0, Math.round(topPx - anchorPx));
        }
      }

      if (!Number.isFinite(v) && Number.isFinite(this._restoreScrollTop)) {
        v = this._restoreScrollTop;
      }

      if (Number.isFinite(v)) {
        try {
          viewport.scrollTop = v;
        } catch (_) {
          // ignore
        }

        // Some internal behaviors (focus restoration, layout, etc.) may adjust scroll after render.
        // Re-apply on the next frame as well.
        requestAnimationFrame(() => {
          try {
            viewport.scrollTop = v;
          } catch (_) {
            // ignore
          }
        });

        // Also re-apply shortly after, because multiple Journal updates can trigger multiple renders,
        // and early renders sometimes happen before scrollHeight settles.
        setTimeout(() => {
          try {
            viewport.scrollTop = v;
          } catch (_) {
            // ignore
          }
        }, 0);

        // We've now established a user scroll position; don't auto-scroll to year 0 later.
        this._didInitialScroll = true;

        // IMPORTANT: do NOT clear immediately. Multiple successive rerenders may happen, and we don't want
        // later rerenders to capture scrollTop=0.
        if (this._restoreScrollClearT) clearTimeout(this._restoreScrollClearT);
        this._restoreScrollClearT = setTimeout(() => {
          this._restoreScrollTop = null;
          this._restoreSerial = null;
          this._restoreScrollClearT = null;
        }, 300);
      }
    }

    // Initial scroll towards year 0 (once, after loading)
    if (!this._loading && !this._didInitialScroll) {
      const canvas = el.querySelector('[data-field="timelineCanvas"]');
      const y0Raw = Number(canvas?.dataset?.year0Top);

      if (viewport && Number.isFinite(y0Raw)) {
        const target = Math.max(0, Math.round(y0Raw - (viewport.clientHeight * 0.75)));
        try {
          viewport.scrollTop = target;
          this._didInitialScroll = true;
        } catch (_) {
          // ignore
        }
      }
    }

    this._scheduleFloatingLayout();
  }

  async _onRootChange(event) {
    const target = event.target;

    const cb = target?.closest?.('input[type="checkbox"][data-action="toggle-active-faction"]');
    if (cb) {
      const uuid = String(cb.dataset.uuid || '').trim();
      if (!uuid) return;

      const current = getTimelineV2ActiveFactionUuids();
      const set = new Set(current);

      if (cb.checked) set.add(uuid);
      else set.delete(uuid);

      await setTimelineV2ActiveFactionsSetting({
        mode: 'custom',
        uuids: Array.from(set),
      });

      this._renderPreserveScroll();
      return;
    }
  }

  async _onRootClick(event) {
    const a = event.target?.closest?.('[data-action]');
    if (!a) return;

    const action = String(a.dataset.action || '').trim();

    if (action === 'toggle-hide-unknown') {
      event.preventDefault();
      await setTimelineV2HideUnknown(!getTimelineV2HideUnknown());
      this._renderPreserveScroll();
      return;
    }

    if (action === 'zoom-in' || action === 'zoom-out') {
      event.preventDefault();

      // Keep the same date around the viewport center when changing zoom.
      const anchorRel = 0.5;
      const serial = this._captureViewportAnchorSerial(anchorRel);
      if (Number.isFinite(serial)) {
        this._restoreSerial = serial;
        this._restoreSerialRel = anchorRel;
      }

      const cur = getTimelineV2Zoom();

      let next = cur;
      if (action === 'zoom-in') {
        next = ZOOM_STEPS.find((s) => s > (cur + 1e-6)) ?? (ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? cur);
      } else {
        for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
          const s = ZOOM_STEPS[i];
          if (s < (cur - 1e-6)) {
            next = s;
            break;
          }
          next = ZOOM_STEPS[0] ?? cur;
        }
      }

      await setTimelineV2Zoom(next);
      this.render(false);
      return;
    }

    if (action === 'toggle-faction-menu') {
      event.preventDefault();
      this._factionMenuOpen = !this._factionMenuOpen;
      this._renderPreserveScroll();
      return;
    }

    if (action === 'set-active-factions-auto') {
      event.preventDefault();
      await setTimelineV2ActiveFactionsSetting({ mode: 'auto', uuids: [] });
      this._renderPreserveScroll();
      return;
    }

    if (action === 'create-event') {
      event.preventDefault();
      await this._openCreateEditor();
      return;
    }

    if (action === 'select-event') {
      event.preventDefault();

      // Ignore unknown markers (no expandable content).
      if (a.classList.contains('is-unknown')) return;

      const uuid = String(a.dataset.uuid || '').trim();
      if (!uuid) return;

      this._selectedEventUuid = uuid;
      this._renderPreserveScroll();
      return;
    }

    if (action === 'open-details') {
      event.preventDefault();

      const uuid = String(a.dataset.uuid || '').trim();
      if (!uuid) return;

      await this._openDetailsDrawer(uuid);
      return;
    }

    if (action === 'open-journal') {
      event.preventDefault();

      const uuid = String(a.dataset.uuid || '').trim();
      if (!uuid) return;

      const page = await resolveTimelineV2Page(uuid);
      if (page?.parent?.sheet?.render) {
        page.parent.sheet.render(true);
      }

      return;
    }

    if (action === 'edit-event') {
      event.preventDefault();

      const uuid = String(a.dataset.uuid || '').trim();
      if (!uuid) return;

      await this._openEditEditor(uuid);
      return;
    }

    if (action === 'delete-event') {
      event.preventDefault();

      const uuid = String(a.dataset.uuid || '').trim();
      if (!uuid) return;

      const ok = await _confirmDialog({
        title: 'Удалить событие',
        content: '<p><b>Удалить событие?</b></p><p>Действие необратимо.</p>',
        yesLabel: game.i18n?.localize?.('SPACEHOLDER.TimelineV2.Buttons.Delete') ?? 'Удалить',
        yesIcon: 'fa-solid fa-trash',
        noLabel: game.i18n?.localize?.('SPACEHOLDER.TimelineV2.Buttons.Cancel') ?? 'Отмена',
        noIcon: 'fa-solid fa-times',
      });

      if (!ok) return;

      const v = this._captureViewportScrollTop();
      if (Number.isFinite(v)) this._restoreScrollTop = v;

      try {
        await deleteTimelineV2Event({ indexUuid: uuid });
      } catch (e) {
        console.error('SpaceHolder | TimelineV2: delete failed', e);
        ui.notifications?.error?.('Не удалось удалить событие');
        return;
      }

      if (this._selectedEventUuid === uuid) this._selectedEventUuid = '';
      this._closeDetailsDrawer();
      this._renderPreserveScroll();
      return;
    }

    if (action === 'close-details') {
      event.preventDefault();
      this._closeDetailsDrawer();
      this._renderPreserveScroll();
      return;
    }
  }

  async _onPointerDown(event) {
    const btn = event.target?.closest?.('button[data-action="drag-event"]');
    if (!btn) return;

    const eventEl = btn.closest('.sh-tl2__event');
    const canvasEl = this.element?.querySelector?.('[data-field="timelineCanvas"]');
    if (!eventEl || !canvasEl) return;

    const uuid = String(btn.dataset.uuid || eventEl.dataset.uuid || '').trim();
    if (!uuid) return;

    const viewport = this.element?.querySelector?.('[data-field="timelineViewport"]');
    const lockedScrollTop = viewport ? Number(viewport.scrollTop) : null;

    // Preserve current scrollTop so the post-update rerenders can restore it.
    if (Number.isFinite(lockedScrollTop)) this._restoreScrollTop = lockedScrollTop;

    event.preventDefault();
    event.stopPropagation();

    // When floating layout is enabled, markers are not at the exact date position.
    // For dragging, snap to the real (anchor) position first.
    const anchorTopPx = Number.parseFloat(String(eventEl.dataset.anchorTop || ''));
    const fallbackTopPx = Number.parseFloat(String(eventEl.style.top || '0').replace('px', ''));
    const startTopPx = Number.isFinite(anchorTopPx)
      ? anchorTopPx
      : (Number.isFinite(fallbackTopPx) ? fallbackTopPx : 0);

    try {
      eventEl.style.top = `${startTopPx}px`;

      const side = eventEl.classList.contains('is-left') ? 'left' : 'right';
      const dx = (side === 'left') ? -EVENT_OFFSET_PX : EVENT_OFFSET_PX;
      const angle = (dx < 0) ? 180 : 0;

      eventEl.style.setProperty('--sh-wire-startY', '0px');
      eventEl.style.setProperty('--sh-wire-length', `${Math.abs(dx)}px`);
      eventEl.style.setProperty('--sh-wire-angle', `${angle}deg`);
    } catch (_) {
      // ignore
    }

    this._drag = {
      pointerId: event.pointerId,
      uuid,
      eventEl,
      startClientY: event.clientY,
      startTopPx,
      lockedScrollTop: Number.isFinite(lockedScrollTop) ? lockedScrollTop : null,
    };

    try {
      eventEl.classList.add('is-dragging');
      btn.setPointerCapture?.(event.pointerId);
    } catch (_) {
      // ignore
    }


    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
  }

  async _onPointerMove(event) {
    if (!this._drag) return;
    if (event.pointerId !== this._drag.pointerId) return;

    event.preventDefault();

    const delta = event.clientY - this._drag.startClientY;
    const nextTop = this._drag.startTopPx + delta;

    try {
      this._drag.eventEl.style.top = `${nextTop}px`;
    } catch (_) {
      // ignore
    }
  }

  async _onPointerUp(event) {
    if (!this._drag) return;
    if (event.pointerId !== this._drag.pointerId) return;

    event.preventDefault();

    const drag = this._drag;
    const { uuid, eventEl, lockedScrollTop } = drag;

    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);

    // Keep scroll restore value during the document update + rerenders.
    if (Number.isFinite(lockedScrollTop)) this._restoreScrollTop = lockedScrollTop;

    try {
      eventEl.classList.remove('is-dragging');
    } catch (_) {
      // ignore
    }

    const meta = this._serialMeta;
    if (!meta || !Number.isFinite(meta.pxPerDay) || !Number.isFinite(meta.maxBoundSerial) || !Number.isFinite(meta.padPx)) {
      this._renderPreserveScroll();

      // Cleanup drag state shortly after.
      setTimeout(() => {
        if (this._drag === drag) {
          this._drag = null;
          this._scheduleFloatingLayout();
        }
      }, 250);

      return;
    }

    const topPx = Number.parseFloat(String(eventEl.style.top || '0').replace('px', ''));
    const serial = Math.round(meta.maxBoundSerial - ((topPx - meta.padPx) / meta.pxPerDay));

    const next = _serialToDate(serial);

    try {
      await updateTimelineV2EventDate({
        indexUuid: uuid,
        year: next.year,
        month: next.month,
        day: next.day,
      });
    } catch (e) {
      console.error('SpaceHolder | TimelineV2: drag update failed', e);
      ui.notifications?.error?.('Не удалось переместить событие');
    }

    this._renderPreserveScroll();

    // Cleanup drag state shortly after updates/rerenders settle.
    setTimeout(() => {
      if (this._drag === drag) {
        this._drag = null;
        this._scheduleFloatingLayout();
      }
    }, 250);
  }
}

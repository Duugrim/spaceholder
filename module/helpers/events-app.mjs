import {
  EVENT_RESPONSE_MODE,
  EVENT_STATUS,
  EVENT_TYPE,
  createEventTemplate,
  createFactionEvent,
  createFactionEventFromTemplate,
  deleteEventPage,
  ensureEventsInfrastructureForCurrentUser,
  getAvailableFactionChoices,
  getEventPageData,
  listEventTemplates,
  listFactionEventPages,
  resolveEventPage,
  resolveFactionEventOutcome,
  setFactionEventFinished,
  submitFactionEventResponse,
  updateFactionEventDetails,
  updateEventTemplate,
  validateResponseByMode,
} from './events.mjs';

const TEMPLATE_APP = 'systems/spaceholder/templates/events/events-app.hbs';
const TEMPLATE_EDITOR = 'systems/spaceholder/templates/events/event-editor.hbs';
const TEMPLATE_RESPONSE_EDITOR = 'systems/spaceholder/templates/events/response-editor.hbs';
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 12 * DAYS_PER_MONTH;

let _singleton = null;
let _hooksInstalled = false;

function _isGM() {
  return !!game?.user?.isGM;
}

function _localize(key, fallback = '') {
  return game?.i18n?.localize?.(key) || fallback || key;
}

function _getTextEditorImpl() {
  return foundry?.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
}

async function _enrichHtml(content, { relativeTo = null, preserveLineBreaks = false } = {}) {
  const editor = _getTextEditorImpl();
  const src = String(content ?? '');
  const prepared = preserveLineBreaks ? src.replace(/\r?\n/g, '<br/>') : src;
  if (typeof editor?.enrichHTML !== 'function') {
    return foundry?.utils?.escapeHTML?.(prepared) || prepared;
  }
  return await editor.enrichHTML(prepared, {
    async: true,
    secrets: _isGM(),
    relativeTo,
  });
}

function _parseYear(raw, fallback = 0) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) ? n : (Number(fallback) || 0);
}

function _clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return Number(fallback);
  return Math.min(max, Math.max(min, n));
}

async function _promptTextDialog({ title, label, value = '' } = {}) {
  const inputId = `sh-events-text-${Math.random().toString(36).slice(2, 10)}`;
  const content = `
    <div class="form-group">
      <label for="${inputId}">${foundry.utils.escapeHTML(String(label || ''))}</label>
      <div class="form-fields">
        <textarea id="${inputId}" rows="8">${foundry.utils.escapeHTML(String(value || ''))}</textarea>
      </div>
    </div>
  `;

  const applyLabel = _localize('SPACEHOLDER.Actions.Apply', 'Apply');
  const cancelLabel = _localize('SPACEHOLDER.Actions.Cancel', 'Cancel');
  const DialogV2 = foundry?.applications?.api?.DialogV2;

  if (DialogV2?.wait) {
    const result = await DialogV2.wait({
      window: { title: String(title || '') },
      content,
      buttons: [
        {
          action: 'apply',
          default: true,
          label: applyLabel,
          icon: 'fa-solid fa-check',
          callback: () => {
            const input = document.getElementById(inputId);
            return String(input?.value ?? '');
          },
        },
        {
          action: 'cancel',
          label: cancelLabel,
          icon: 'fa-solid fa-xmark',
          callback: () => null,
        },
      ],
    });
    return result === undefined ? null : result;
  }

  const DialogImpl = globalThis.Dialog;
  if (DialogImpl) {
    return await new Promise((resolve) => {
      const dialog = new DialogImpl({
        title: String(title || ''),
        content,
        buttons: {
          apply: {
            label: applyLabel,
            callback: () => {
              const input = document.getElementById(inputId);
              resolve(String(input?.value ?? ''));
            },
          },
          cancel: {
            label: cancelLabel,
            callback: () => resolve(null),
          },
        },
        default: 'apply',
        close: () => resolve(null),
      });
      dialog.render(true);
    });
  }

  return null;
}

async function _pickWorldDate({ year, month, day } = {}) {
  const y0 = _parseYear(year, 0);
  const m0 = _clampInt(month, 1, 12, 1);
  const d0 = _clampInt(day, 1, 30, 1);

  const title = game?.i18n?.localize?.('SPACEHOLDER.Events.Buttons.PickDate') || 'Pick date';
  const applyLabel = game?.i18n?.localize?.('SPACEHOLDER.Actions.Apply') || 'Apply';
  const cancelLabel = game?.i18n?.localize?.('SPACEHOLDER.Actions.Cancel') || 'Cancel';

  const uid = Math.random().toString(36).slice(2, 10);
  const rootId = `spaceholder-events-date-picker-${uid}`;
  const dayOfYear0 = ((m0 - 1) * DAYS_PER_MONTH) + (d0 - 1);
  const content = `
    <div id="${rootId}" class="sh-tl2dp" autocomplete="off">
      <div class="sh-tl2dp__wheel" data-field="wheel">
        <div class="sh-tl2dp__pointer" data-field="pointer"></div>
        <div class="sh-tl2dp__center"></div>
      </div>
      <div class="sh-tl2dp__readout" data-field="readout"></div>
      <div class="sh-tl2dp__year">
        <input type="number" name="year" value="${y0}" step="1" inputmode="numeric" />
      </div>
      <input type="hidden" name="dayOfYear" value="${dayOfYear0}" />
    </div>
  `;

  const installInteractions = (rootEl) => {
    const wheelEl = rootEl?.querySelector?.('[data-field="wheel"]');
    const readoutEl = rootEl?.querySelector?.('[data-field="readout"]');
    const yearInput = rootEl?.querySelector?.('input[name="year"]');
    const dayOfYearInput = rootEl?.querySelector?.('input[name="dayOfYear"]');
    if (!wheelEl || !readoutEl || !yearInput || !dayOfYearInput) return null;

    const pad2 = (v) => String(Number(v) || 0).padStart(2, '0');
    const state = {
      dragging: false,
      dayOfYear: _clampInt(dayOfYearInput.value, 0, DAYS_PER_YEAR - 1, dayOfYear0),
    };

    const syncReadout = () => {
      const y = _parseYear(yearInput.value, y0);
      const m = Math.floor(state.dayOfYear / DAYS_PER_MONTH) + 1;
      const d = (state.dayOfYear % DAYS_PER_MONTH) + 1;
      readoutEl.textContent = `${pad2(d)}.${pad2(m)}.${y}`;
    };

    const setDayOfYear = (next) => {
      const raw = Number(next);
      const mod = ((raw % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
      state.dayOfYear = Number.isFinite(mod) ? mod : 0;
      dayOfYearInput.value = String(state.dayOfYear);
      rootEl.style.setProperty('--sh-tl2dp-angle', `${state.dayOfYear}deg`);
      syncReadout();
    };

    const dayOfYearFromEvent = (ev) => {
      const rect = wheelEl.getBoundingClientRect();
      const cx = rect.left + (rect.width / 2);
      const cy = rect.top + (rect.height / 2);
      const dx = Number(ev.clientX) - cx;
      const dy = Number(ev.clientY) - cy;
      const r2 = (dx * dx) + (dy * dy);
      if (!(r2 > 16)) return null;
      const angleRad = Math.atan2(dy, dx);
      const degFromRight = ((angleRad * 180 / Math.PI) + 360) % 360;
      const degFromTop = (degFromRight + 90) % 360;
      const doy = Math.floor(degFromTop + 0.5) % DAYS_PER_YEAR;
      return Number.isFinite(doy) ? doy : null;
    };

    const onPointerDown = (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      state.dragging = true;
      try { wheelEl.setPointerCapture?.(ev.pointerId); } catch (_) { /* ignore */ }
      const doy = dayOfYearFromEvent(ev);
      if (doy !== null) setDayOfYear(doy);
    };
    const onPointerMove = (ev) => {
      if (!state.dragging) return;
      const doy = dayOfYearFromEvent(ev);
      if (doy !== null) setDayOfYear(doy);
    };
    const onPointerUp = (ev) => {
      if (!state.dragging) return;
      state.dragging = false;
      try { wheelEl.releasePointerCapture?.(ev.pointerId); } catch (_) { /* ignore */ }
    };
    const onWheel = (ev) => {
      ev.preventDefault();
      const dir = (Number(ev.deltaY) || 0) > 0 ? 1 : -1;
      setDayOfYear(state.dayOfYear + dir);
    };
    const onYearChange = () => syncReadout();

    wheelEl.addEventListener('pointerdown', onPointerDown);
    wheelEl.addEventListener('pointermove', onPointerMove);
    wheelEl.addEventListener('pointerup', onPointerUp);
    wheelEl.addEventListener('pointercancel', onPointerUp);
    wheelEl.addEventListener('wheel', onWheel, { passive: false });
    yearInput.addEventListener('change', onYearChange);
    yearInput.addEventListener('input', onYearChange);
    setDayOfYear(state.dayOfYear);

    return () => {
      try {
        wheelEl.removeEventListener('pointerdown', onPointerDown);
        wheelEl.removeEventListener('pointermove', onPointerMove);
        wheelEl.removeEventListener('pointerup', onPointerUp);
        wheelEl.removeEventListener('pointercancel', onPointerUp);
        wheelEl.removeEventListener('wheel', onWheel);
        yearInput.removeEventListener('change', onYearChange);
        yearInput.removeEventListener('input', onYearChange);
      } catch (_) {
        // ignore
      }
    };
  };

  const ensureInstalled = () => {
    let tries = 0;
    let cleanup = null;
    const tick = () => {
      tries += 1;
      const rootEl = document.getElementById(rootId);
      if (rootEl) {
        cleanup = installInteractions(rootEl);
        return;
      }
      if (tries < 30) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => cleanup?.();
  };

  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (DialogV2?.wait) {
    return await new Promise((resolve) => {
      let settled = false;
      let cleanup = null;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        try { cleanup?.(); } catch (_) { /* ignore */ }
        resolve(value);
      };
      cleanup = ensureInstalled();
      const maybe = DialogV2.wait({
        window: { title, icon: 'fa-solid fa-calendar-days' },
        position: { width: 380 },
        content,
        buttons: [
          {
            action: 'apply',
            default: true,
            label: applyLabel,
            icon: 'fa-solid fa-check',
            callback: () => {
              const root = document.getElementById(rootId);
              const yRaw = root?.querySelector?.('input[name="year"]')?.value;
              const doyRaw = root?.querySelector?.('input[name="dayOfYear"]')?.value;
              const y = _parseYear(yRaw, y0);
              const dayOfYear = _clampInt(doyRaw, 0, DAYS_PER_YEAR - 1, dayOfYear0);
              const m = Math.floor(dayOfYear / DAYS_PER_MONTH) + 1;
              const d = (dayOfYear % DAYS_PER_MONTH) + 1;
              settle({ year: y, month: m, day: d });
              return true;
            },
          },
          {
            action: 'cancel',
            label: cancelLabel,
            icon: 'fa-solid fa-xmark',
            callback: () => {
              settle(null);
              return true;
            },
          },
        ],
      });
      if (maybe?.then) maybe.then(() => settle(null)).catch(() => settle(null));
    });
  }
  return null;
}

async function _confirmDialog({ title, content, yesLabel, noLabel }) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (DialogV2?.confirm) {
    try {
      return await DialogV2.confirm({
        window: { title },
        content,
        yes: { label: yesLabel || _localize('SPACEHOLDER.Actions.Yes', _localize('SPACEHOLDER.Timeline.Buttons.Yes', 'Yes')) },
        no: { label: noLabel || _localize('SPACEHOLDER.Actions.No', _localize('SPACEHOLDER.Timeline.Buttons.No', 'No')) },
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

function _statusOrder(status) {
  if (status === EVENT_STATUS.CREATED) return 0;
  if (status === EVENT_STATUS.ANSWERED) return 1;
  if (status === EVENT_STATUS.RESOLVED) return 2;
  if (status === EVENT_STATUS.FINISHED) return 3;
  return 99;
}

function _statusCss(status) {
  if (status === EVENT_STATUS.CREATED) return 'is-created';
  if (status === EVENT_STATUS.ANSWERED) return 'is-answered';
  if (status === EVENT_STATUS.RESOLVED) return 'is-resolved';
  if (status === EVENT_STATUS.FINISHED) return 'is-finished';
  return '';
}

function _responseModeLabel(mode) {
  const key = String(mode || '').trim();
  if (key === EVENT_RESPONSE_MODE.CHOICE_ONLY) return _localize('SPACEHOLDER.Events.ResponseMode.ChoiceOnly', key);
  if (key === EVENT_RESPONSE_MODE.TEXT_ONLY) return _localize('SPACEHOLDER.Events.ResponseMode.TextOnly', key);
  if (key === EVENT_RESPONSE_MODE.BOTH) return _localize('SPACEHOLDER.Events.ResponseMode.Both', key);
  return _localize('SPACEHOLDER.Events.ResponseMode.Either', key || EVENT_RESPONSE_MODE.EITHER);
}

function _statusIcon(status) {
  if (status === EVENT_STATUS.ANSWERED) return 'fa-solid fa-reply';
  if (status === EVENT_STATUS.RESOLVED) return 'fa-solid fa-wand-magic-sparkles';
  if (status === EVENT_STATUS.FINISHED) return 'fa-solid fa-check-double';
  return 'fa-regular fa-circle';
}

function _sortEvents(events, mode) {
  const list = Array.isArray(events) ? [...events] : [];
  if (mode === 'date-asc') {
    list.sort((a, b) => _eventDateSerial(a.eventDate) - _eventDateSerial(b.eventDate));
    return list;
  }
  if (mode === 'status') {
    list.sort((a, b) => {
      const s = _statusOrder(a.status) - _statusOrder(b.status);
      if (s !== 0) return s;
      return String(a.title).localeCompare(String(b.title), 'ru', { sensitivity: 'base' });
    });
    return list;
  }
  if (mode === 'title') {
    list.sort((a, b) => String(a.title).localeCompare(String(b.title), 'ru', { sensitivity: 'base' }));
    return list;
  }
  list.sort((a, b) => _eventDateSerial(b.eventDate) - _eventDateSerial(a.eventDate));
  return list;
}

function _eventDateToTimelineDate(raw) {
  const s = String(raw || '').trim();
  const mYmd = s.match(/^(-?\d{1,6})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (mYmd) {
    return {
      year: Number.parseInt(mYmd[1], 10),
      month: Math.min(12, Math.max(1, Number.parseInt(mYmd[2], 10) || 1)),
      day: Math.min(30, Math.max(1, Number.parseInt(mYmd[3], 10) || 1)),
    };
  }
  const mDmy = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](-?\d{1,6})$/);
  if (mDmy) {
    return {
      year: Number.parseInt(mDmy[3], 10),
      month: Math.min(12, Math.max(1, Number.parseInt(mDmy[2], 10) || 1)),
      day: Math.min(30, Math.max(1, Number.parseInt(mDmy[1], 10) || 1)),
    };
  }
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: Math.min(12, Math.max(1, now.getMonth() + 1)),
    day: Math.min(30, Math.max(1, now.getDate())),
  };
}

function _eventDateSerial(raw) {
  const date = _eventDateToTimelineDate(raw);
  return (Number(date.year) * 360) + ((Number(date.month) - 1) * 30) + (Number(date.day) - 1);
}

function _formatEventDateDisplay(raw) {
  const parsed = _eventDateToTimelineDate(raw);
  const dd = String(parsed.day).padStart(2, '0');
  const mm = String(parsed.month).padStart(2, '0');
  return `${dd}.${mm}.${parsed.year}`;
}

function _buildTimelinePrefillFromEvent(data) {
  const date = _eventDateToTimelineDate(data?.eventDate);
  const contentParts = [
    `<h3>${foundry.utils.escapeHTML(String(data?.title || ''))}</h3>`,
    `<p>${foundry.utils.escapeHTML(String(data?.description || ''))}</p>`,
  ];

  if (String(data?.selectedOptionLabel || '').trim()) {
    contentParts.push(`<p><b>${_localize('SPACEHOLDER.Events.Fields.SelectedOption', 'Selected option')}:</b> ${foundry.utils.escapeHTML(String(data.selectedOptionLabel))}</p>`);
  }
  if (String(data?.freeText || '').trim()) {
    contentParts.push(`<p><b>${_localize('SPACEHOLDER.Events.Fields.FreeText', 'Free response')}:</b> ${foundry.utils.escapeHTML(String(data.freeText))}</p>`);
  }
  if (String(data?.outcome || '').trim()) {
    contentParts.push(`<hr/><h4>${_localize('SPACEHOLDER.Events.Fields.Outcome', 'Outcome')}</h4><p>${foundry.utils.escapeHTML(String(data.outcome))}</p>`);
  }

  return {
    factionUuid: String(data?.targetFactionUuid || ''),
    year: date.year,
    month: date.month,
    day: date.day,
    title: String(data?.title || ''),
    iconPath: String(data?.iconPath || ''),
    content: contentParts.join('\n'),
  };
}

function _extractDropUuid(ev) {
  try {
    const raw = ev?.dataTransfer?.getData?.('text/plain') || ev?.dataTransfer?.getData?.('application/json');
    if (!raw) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      parsed = null;
    }
    if (!parsed) {
      const plainUuid = String(raw || '').trim();
      if (!plainUuid) return null;
      if (/^(Actor|Item|JournalEntry|JournalEntryPage|Scene|TokenDocument)\./.test(plainUuid)) {
        return { uuid: plainUuid, label: '' };
      }
      return null;
    }
    const uuid = String(
      parsed?.uuid
      || parsed?.documentUuid
      || parsed?.actorUuid
      || parsed?.journalEntryUuid
      || ''
    ).trim();
    if (!uuid) return null;
    return {
      uuid,
      label: String(parsed?.name || parsed?.text || '').trim(),
    };
  } catch (_) {
    return null;
  }
}

function _insertAtCursor(input, text) {
  const value = String(input?.value || '');
  const start = Number.isInteger(input?.selectionStart) ? input.selectionStart : value.length;
  const end = Number.isInteger(input?.selectionEnd) ? input.selectionEnd : value.length;
  const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
  input.value = next;
  const pos = start + text.length;
  try {
    input.setSelectionRange(pos, pos);
  } catch (_) {
    // ignore
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function _bindUuidDrops(root) {
  const nodes = root?.querySelectorAll?.('textarea[data-accept-drop-uuid], input[data-accept-drop-uuid]');
  if (!nodes?.length) return;

  for (const el of nodes) {
    if (el.dataset.shDropBound === 'true') continue;
    el.dataset.shDropBound = 'true';

    el.addEventListener('dragover', (ev) => {
      const drop = _extractDropUuid(ev);
      if (!drop) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    });

    el.addEventListener('drop', (ev) => {
      const drop = _extractDropUuid(ev);
      if (!drop) return;
      ev.preventDefault();
      const label = drop.label ? `{${drop.label.replace(/[{}]/g, '')}}` : '';
      _insertAtCursor(el, `@UUID[${drop.uuid}]${label}`);
    });
  }
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

  Hooks.on('createJournalEntryPage', rerender);
  Hooks.on('updateJournalEntryPage', rerender);
  Hooks.on('deleteJournalEntryPage', rerender);
}

export function openEventsApp() {
  _installHooksOnce();
  if (_singleton) {
    _singleton.render(true);
    _singleton.bringToTop?.();
    return _singleton;
  }
  _singleton = new EventsApp();
  _singleton.render(true);
  ensureEventsInfrastructureForCurrentUser()
    .finally(() => {
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

class EventsApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-events',
    classes: ['spaceholder', 'events-app'],
    tag: 'div',
    window: { title: 'Events', resizable: true },
    position: { width: 980, height: 780 },
  };

  static PARTS = {
    main: { root: true, template: TEMPLATE_APP },
  };

  constructor() {
    super();
    this._loading = true;
    this._tab = _isGM() ? 'drafts' : 'events';
    this._statusFilter = 'all';
    this._sortMode = 'date-desc';
    this._factionFilter = '';
    this._selectedEventUuid = '';
    this._templateTargetFaction = new Map();
    this._onRootClick = this._onRootClick.bind(this);
    this._onRootChange = this._onRootChange.bind(this);
  }

  async close(options = {}) {
    await super.close(options);
    if (_singleton === this) _singleton = null;
  }

  async _prepareContext() {
    const isGM = _isGM();
    const factions = getAvailableFactionChoices({ forUser: game.user, includeAllForGm: true });

    const statusOptions = [
      { value: 'all', label: _localize('SPACEHOLDER.Events.Filters.AllStatuses', 'All statuses'), selected: this._statusFilter === 'all' },
      { value: EVENT_STATUS.CREATED, label: _localize('SPACEHOLDER.Events.Status.Created', 'Created'), selected: this._statusFilter === EVENT_STATUS.CREATED },
      { value: EVENT_STATUS.ANSWERED, label: _localize('SPACEHOLDER.Events.Status.Answered', 'Answered'), selected: this._statusFilter === EVENT_STATUS.ANSWERED },
      { value: EVENT_STATUS.RESOLVED, label: _localize('SPACEHOLDER.Events.Status.Resolved', 'Resolved'), selected: this._statusFilter === EVENT_STATUS.RESOLVED },
      { value: EVENT_STATUS.FINISHED, label: _localize('SPACEHOLDER.Events.Status.Finished', 'Finished'), selected: this._statusFilter === EVENT_STATUS.FINISHED },
    ];
    const sortOptions = [
      { value: 'date-desc', label: _localize('SPACEHOLDER.Events.Sort.DateDesc', 'Date desc'), selected: this._sortMode === 'date-desc' },
      { value: 'date-asc', label: _localize('SPACEHOLDER.Events.Sort.DateAsc', 'Date asc'), selected: this._sortMode === 'date-asc' },
      { value: 'status', label: _localize('SPACEHOLDER.Events.Sort.Status', 'Status'), selected: this._sortMode === 'status' },
      { value: 'title', label: _localize('SPACEHOLDER.Events.Sort.Title', 'Title'), selected: this._sortMode === 'title' },
    ];

    const templates = [];
    if (isGM) {
      for (const page of listEventTemplates()) {
        const data = getEventPageData(page);
        if (!this._templateTargetFaction.get(page.uuid) && factions[0]?.uuid) {
          this._templateTargetFaction.set(page.uuid, factions[0].uuid);
        }
        templates.push({
          uuid: page.uuid,
          title: data.title,
          eventDate: data.eventDate,
          eventDateText: _formatEventDateDisplay(data.eventDate),
          responseMode: data.responseMode,
          responseModeLabel: _responseModeLabel(data.responseMode),
          optionsCount: data.options.length,
          statusClass: _statusCss(data.status),
          targetFactionUuid: this._templateTargetFaction.get(page.uuid) || '',
        });
      }
    }

    let pages = [];
    if (isGM) {
      pages = this._factionFilter ? listFactionEventPages({ factionUuid: this._factionFilter }) : listFactionEventPages();
    } else {
      const myFactions = getAvailableFactionChoices({ forUser: game.user, includeAllForGm: false }).map((f) => f.uuid);
      const selected = String(this._factionFilter || '').trim();
      const visible = selected ? myFactions.filter((f) => f === selected) : myFactions;
      for (const factionUuid of visible) pages.push(...listFactionEventPages({ factionUuid }));
    }

    let events = pages.map((page) => {
      const data = getEventPageData(page);
      const faction = factions.find((f) => f.uuid === data.targetFactionUuid);
      const hasOutcome = !!String(data.outcome || '').trim();
      const canResolve = isGM;
      const canTimeline = isGM && (data.status === EVENT_STATUS.RESOLVED || data.status === EVENT_STATUS.FINISHED);
      const canFinish = hasOutcome;
      return {
        uuid: page.uuid,
        title: data.title,
        description: data.description,
        eventDate: data.eventDate,
        eventDateText: _formatEventDateDisplay(data.eventDate),
        status: data.status,
        statusLabel: _localize(`SPACEHOLDER.Events.Status.${data.status.charAt(0).toUpperCase()}${data.status.slice(1)}`, data.status),
        statusClass: _statusCss(data.status),
        responseMode: data.responseMode,
        selectedOptionIndex: data.selectedOptionIndex,
        selectedOptionLabel: Number.isInteger(data.selectedOptionIndex) ? (data.options[data.selectedOptionIndex]?.label || '') : '',
        freeText: data.freeText,
        outcome: data.outcome,
        isFinished: !!data.isFinished,
        canResolve,
        canTimeline,
        canFinish,
        timelineEntryUuid: data.timelineEntryUuid,
        targetFactionUuid: data.targetFactionUuid,
        targetFactionName: faction?.name || data.targetFactionUuid,
        statusIcon: _statusIcon(data.status),
        iconPath: String(data.iconPath || ''),
      };
    });

    if (this._statusFilter !== 'all') {
      events = events.filter((e) => e.status === this._statusFilter);
    }
    events = _sortEvents(events, this._sortMode);

    const eventUuids = new Set(events.map((e) => e.uuid));
    if (!events.length) this._selectedEventUuid = '';
    if (events.length && (!this._selectedEventUuid || !eventUuids.has(this._selectedEventUuid))) {
      this._selectedEventUuid = events[0].uuid;
    }
    for (const event of events) {
      event.isSelected = event.uuid === this._selectedEventUuid;
    }

    let selectedEvent = null;
    if (this._selectedEventUuid) {
      const selectedPage = pages.find((p) => p?.uuid === this._selectedEventUuid) || null;
      selectedEvent = events.find((e) => e.uuid === this._selectedEventUuid) || null;
      if (selectedEvent && selectedPage) {
        const selectedData = getEventPageData(selectedPage);
        const selectedOptionLabel = Number.isInteger(selectedData.selectedOptionIndex)
          ? (selectedData.options[selectedData.selectedOptionIndex]?.label || '')
          : '';
        selectedEvent = {
          ...selectedEvent,
          selectedOptionLabel,
          hasFreeText: !!String(selectedData.freeText || '').trim(),
          hasOutcome: !!String(selectedData.outcome || '').trim(),
          showMarkFinished: selectedEvent.canFinish && !selectedEvent.isFinished,
          descriptionHtml: await _enrichHtml(selectedData.description || '', { relativeTo: selectedPage, preserveLineBreaks: true }),
          freeTextHtml: await _enrichHtml(selectedData.freeText || '', { relativeTo: selectedPage, preserveLineBreaks: true }),
          outcomeHtml: await _enrichHtml(selectedData.outcome || '', { relativeTo: selectedPage }),
        };
      }
    }

    return {
      loading: this._loading,
      isGM,
      tabDrafts: this._tab === 'drafts',
      tabEvents: this._tab === 'events',
      factions,
      factionFilter: this._factionFilter,
      statusOptions,
      sortOptions,
      templates,
      events,
      selectedEvent,
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;
    if (!el) return;
    if (el.dataset.shEventsHandlers !== 'true') {
      el.dataset.shEventsHandlers = 'true';
      el.addEventListener('click', this._onRootClick);
      el.addEventListener('change', this._onRootChange);
    }
  }

  async _onRootChange(event) {
    const target = event.target;
    const statusSelect = target?.closest?.('select[data-action="status-filter"]');
    if (statusSelect) {
      this._statusFilter = String(statusSelect.value || 'all');
      this.render(false);
      return;
    }
    const sortSelect = target?.closest?.('select[data-action="sort-mode"]');
    if (sortSelect) {
      this._sortMode = String(sortSelect.value || 'date-desc');
      this.render(false);
      return;
    }
    const factionSelect = target?.closest?.('select[data-action="faction-filter"]');
    if (factionSelect) {
      this._factionFilter = String(factionSelect.value || '');
      this.render(false);
      return;
    }
    const templateFactionSelect = target?.closest?.('select[data-action="template-target-faction"]');
    if (templateFactionSelect) {
      const templateUuid = String(templateFactionSelect.dataset.uuid || '');
      if (templateUuid) {
        this._templateTargetFaction.set(templateUuid, String(templateFactionSelect.value || ''));
      }
    }
  }

  async _onRootClick(event) {
    const btn = event.target?.closest?.('[data-action]');
    if (!btn) return;
    const action = String(btn.dataset.action || '');

    if (action === 'set-tab') {
      event.preventDefault();
      this._tab = String(btn.dataset.tab || 'events');
      this.render(false);
      return;
    }

    if (action === 'create-template') {
      event.preventDefault();
      new EventEditorApp({ mode: 'create-template' }).render(true);
      return;
    }

    if (action === 'create-event') {
      event.preventDefault();
      new EventEditorApp({ mode: 'create-event', targetFactionUuid: this._factionFilter || '' }).render(true);
      return;
    }

    if (action === 'edit-template' || action === 'edit-event') {
      event.preventDefault();
      const page = await resolveEventPage(String(btn.dataset.uuid || ''));
      if (!page) return;
      new EventEditorApp({ mode: 'edit', page }).render(true);
      return;
    }

    if (action === 'delete-page') {
      event.preventDefault();
      const page = await resolveEventPage(String(btn.dataset.uuid || ''));
      if (!page) return;
      const ok = await _confirmDialog({
        title: _localize('SPACEHOLDER.Events.Confirm.DeleteTitle', 'Delete event?'),
        content: `<p>${_localize('SPACEHOLDER.Events.Confirm.DeleteContent', 'This action cannot be undone.')}</p>`,
      });
      if (!ok) return;
      await deleteEventPage(page);
      this.render(false);
      return;
    }

    if (action === 'send-template') {
      event.preventDefault();
      const page = await resolveEventPage(String(btn.dataset.uuid || ''));
      if (!page) return;
      const targetFactionUuid = this._templateTargetFaction.get(page.uuid) || '';
      if (!targetFactionUuid) {
        ui.notifications?.warn?.(_localize('SPACEHOLDER.Events.Errors.FactionRequired', 'Faction is required'));
        return;
      }
      try {
        await createFactionEventFromTemplate(page, { targetFactionUuid });
        ui.notifications?.info?.(_localize('SPACEHOLDER.Events.Notifications.Sent', 'Event sent'));
      } catch (e) {
        ui.notifications?.error?.(String(e?.message || e));
      }
      this._tab = 'events';
      this.render(false);
      return;
    }

    if (action === 'respond') {
      event.preventDefault();
      const page = await resolveEventPage(String(btn.dataset.uuid || ''));
      if (!page) return;
      new EventResponseEditorApp({ page }).render(true);
      return;
    }

    if (action === 'select-event') {
      event.preventDefault();
      this._selectedEventUuid = String(btn.dataset.uuid || '').trim();
      this.render(false);
      return;
    }

    if (action === 'resolve-outcome') {
      event.preventDefault();
      const page = await resolveEventPage(String(btn.dataset.uuid || ''));
      if (!page) return;
      const cur = getEventPageData(page);
      const outcome = await _promptTextDialog({
        title: _localize('SPACEHOLDER.Events.Buttons.Resolve', 'Resolve'),
        label: _localize('SPACEHOLDER.Events.Fields.Outcome', 'Outcome'),
        value: cur.outcome || '',
      });
      if (outcome === null) return;
      try {
        await resolveFactionEventOutcome(page, { outcome, outcomeMode: 'manual' });
      } catch (e) {
        ui.notifications?.error?.(String(e?.message || e));
      }
      this.render(false);
      return;
    }

    if (action === 'quick-timeline') {
      event.preventDefault();
      const page = await resolveEventPage(String(btn.dataset.uuid || ''));
      if (!page) return;
      try {
        const data = getEventPageData(page);
        const prefill = _buildTimelinePrefillFromEvent({
          ...data,
          selectedOptionLabel: Number.isInteger(data.selectedOptionIndex) ? (data.options[data.selectedOptionIndex]?.label || '') : '',
        });
        const openEditor = game?.spaceholder?.openTimelineV2CreateEventEditor;
        if (typeof openEditor !== 'function') {
          ui.notifications?.error?.('Timeline V2 create editor is unavailable');
          return;
        }
        openEditor(prefill);
      } catch (e) {
        ui.notifications?.error?.(String(e?.message || e));
      }
      this.render(false);
      return;
    }

    if (action === 'mark-finished') {
      event.preventDefault();
      const page = await resolveEventPage(String(btn.dataset.uuid || ''));
      if (!page) return;
      try {
        await setFactionEventFinished(page, true);
      } catch (e) {
        ui.notifications?.error?.(String(e?.message || e));
      }
      this.render(false);
    }
  }
}

async function _onEventEditorSubmit(event, form, formData) {
  return this?._onSubmit?.(event, form, formData);
}

class EventEditorApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-event-editor',
    classes: ['spaceholder', 'event-editor'],
    tag: 'form',
    window: { title: 'Event', resizable: true },
    position: { width: 860, height: 780 },
    form: {
      handler: _onEventEditorSubmit,
      submitOnChange: false,
      closeOnSubmit: false,
    },
  };

  static PARTS = {
    main: { root: true, template: TEMPLATE_EDITOR },
  };

  constructor({ mode, page = null, targetFactionUuid = '' } = {}) {
    super();
    this._mode = String(mode || 'create-template');
    this._page = page;
    this._factions = getAvailableFactionChoices({ forUser: game.user, includeAllForGm: true });
    const cur = page ? getEventPageData(page) : null;
    this._targetFactionUuid = cur?.targetFactionUuid || targetFactionUuid || this._factions[0]?.uuid || '';
    this._title = cur?.title || '';
    this._description = cur?.description || '';
    this._eventDate = cur?.eventDate || '';
    this._status = cur?.status || EVENT_STATUS.CREATED;
    this._responseMode = cur?.responseMode || EVENT_RESPONSE_MODE.EITHER;
    const options = cur?.options || [];
    this._optionsRaw = options.map((o) => `${o.label}${o.optionOutcome ? ` | ${o.optionOutcome}` : ''}`).join('\n');
    this._onClick = this._onClick.bind(this);
    this._onChange = this._onChange.bind(this);
  }

  async _prepareContext() {
    const parsed = _eventDateToTimelineDate(this._eventDate);
    return {
      mode: this._mode,
      isEdit: this._mode === 'edit',
      title: this._title,
      description: this._description,
      eventDate: this._eventDate,
      dateDay: parsed.day,
      dateMonth: parsed.month,
      dateYear: parsed.year,
      editorStatusClass: _statusCss(this._status),
      editorStatusLabel: _localize(`SPACEHOLDER.Events.Status.${this._status.charAt(0).toUpperCase()}${this._status.slice(1)}`, this._status),
      editorStatusIcon: _statusIcon(this._status),
      responseMode: this._responseMode,
      optionsRaw: this._optionsRaw,
      targetFactionUuid: this._targetFactionUuid,
      factions: this._factions,
      modeOptions: Object.values(EVENT_RESPONSE_MODE).map((v) => ({ value: v, selected: v === this._responseMode, label: _responseModeLabel(v) })),
    };
  }

  _parseOptions(raw) {
    const lines = String(raw || '').split(/\r?\n/);
    const out = [];
    for (const lineRaw of lines) {
      const line = String(lineRaw || '').trim();
      if (!line) continue;
      const [labelRaw, outcomeRaw] = line.split('|');
      const label = String(labelRaw || '').trim();
      if (!label) continue;
      const optionOutcome = String(outcomeRaw || '').trim();
      out.push({
        label,
        ...(optionOutcome ? { optionOutcome } : {}),
      });
    }
    return out;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;
    if (!el) return;
    if (el.dataset.shEventEditorHandlers !== 'true') {
      el.dataset.shEventEditorHandlers = 'true';
      el.addEventListener('click', this._onClick);
      el.addEventListener('change', this._onChange);
    }
    _bindUuidDrops(el);
  }

  _syncDraftFromForm() {
    const root = this.element;
    if (!root) return;

    const titleEl = root.querySelector('input[name="title"]');
    if (titleEl) this._title = String(titleEl.value || '');
    const descEl = root.querySelector('textarea[name="description"]');
    if (descEl) this._description = String(descEl.value || '');
    const optionsEl = root.querySelector('textarea[name="optionsRaw"]');
    if (optionsEl) this._optionsRaw = String(optionsEl.value || '');
    const modeEl = root.querySelector('select[name="responseMode"]');
    if (modeEl) this._responseMode = String(modeEl.value || EVENT_RESPONSE_MODE.EITHER);
    const factionEl = root.querySelector('select[name="targetFactionUuid"]');
    if (factionEl) this._targetFactionUuid = String(factionEl.value || '');
    const dateYearEl = root.querySelector('input[name="dateYear"]');
    const dateMonthEl = root.querySelector('input[name="dateMonth"]');
    const dateDayEl = root.querySelector('input[name="dateDay"]');
    if (dateYearEl || dateMonthEl || dateDayEl) {
      const y = _parseYear(dateYearEl?.value, 0);
      const m = _clampInt(dateMonthEl?.value, 1, 12, 1);
      const d = _clampInt(dateDayEl?.value, 1, 30, 1);
      this._eventDate = `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
    } else {
      const eventDateEl = root.querySelector('input[name="eventDate"]');
      if (eventDateEl) this._eventDate = String(eventDateEl.value || '');
    }
  }

  async _openDatePicker() {
    this._syncDraftFromForm();
    const date = _eventDateToTimelineDate(this._eventDate);
    const picked = await _pickWorldDate({ year: date.year, month: date.month, day: date.day });
    if (!picked) return;
    const month = String(picked.month).padStart(2, '0');
    const day = String(picked.day).padStart(2, '0');
    this._eventDate = `${day}.${month}.${picked.year}`;
    this.render(false);
  }

  async _onClick(event) {
    const btn = event.target?.closest?.('button[data-action]');
    if (!btn) return;
    const action = String(btn.dataset.action || '');
    if (action === 'cancel') {
      event.preventDefault();
      await this.close();
      return;
    }
    if (action === 'pick-date') {
      event.preventDefault();
      await this._openDatePicker();
      return;
    }
  }

  async _onChange(_event) {
    this._syncDraftFromForm();
  }

  async _onSubmit(_event, _form, formData) {
    const data = formData.object;
    let eventDate = String(data.eventDate || '').trim();
    if (data.dateYear !== undefined || data.dateMonth !== undefined || data.dateDay !== undefined) {
      const y = _parseYear(data.dateYear, 0);
      const m = _clampInt(data.dateMonth, 1, 12, 1);
      const d = _clampInt(data.dateDay, 1, 30, 1);
      eventDate = `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
    }
    const payload = {
      title: String(data.title || '').trim(),
      description: String(data.description || ''),
      eventDate,
      responseMode: String(data.responseMode || EVENT_RESPONSE_MODE.EITHER),
      options: this._parseOptions(data.optionsRaw),
    };
    if (!payload.title) {
      ui.notifications?.warn?.(_localize('SPACEHOLDER.Events.Errors.TitleRequired', 'Title is required'));
      return;
    }

    try {
      if (this._mode === 'create-template') {
        await createEventTemplate(payload);
      } else if (this._mode === 'create-event') {
        await createFactionEvent({
          ...payload,
          targetFactionUuid: String(data.targetFactionUuid || '').trim(),
        });
      } else if (this._mode === 'edit') {
        const cur = getEventPageData(this._page);
        if (cur.eventType === EVENT_TYPE.DRAFT_TEMPLATE) {
          await updateEventTemplate(this._page, payload);
        } else {
          await updateFactionEventDetails(this._page, payload);
        }
      }
      await this.close();
    } catch (e) {
      ui.notifications?.error?.(String(e?.message || e));
    }
  }
}

async function _onEventResponseSubmit(event, form, formData) {
  return this?._onSubmit?.(event, form, formData);
}

class EventResponseEditorApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-event-response-editor',
    classes: ['spaceholder', 'event-response-editor'],
    tag: 'form',
    window: { title: 'Event response', resizable: true },
    position: { width: 860, height: 720 },
    form: {
      handler: _onEventResponseSubmit,
      submitOnChange: false,
      closeOnSubmit: false,
    },
  };

  static PARTS = {
    main: { root: true, template: TEMPLATE_RESPONSE_EDITOR },
  };

  constructor({ page } = {}) {
    super();
    this._page = page;
    this._data = getEventPageData(page);
    this._onClick = this._onClick.bind(this);
  }

  async _prepareContext() {
    const hasSelectedOption = Number.isInteger(this._data.selectedOptionIndex) && this._data.selectedOptionIndex >= 0;
    return {
      title: this._data.title,
      description: await _enrichHtml(this._data.description || '', { relativeTo: this._page, preserveLineBreaks: true }),
      responseMode: this._data.responseMode,
      selectedOptionIndex: this._data.selectedOptionIndex,
      hasSelectedOption,
      freeText: this._data.freeText,
      options: this._data.options.map((o, idx) => ({ idx, label: o.label, selected: idx === this._data.selectedOptionIndex })),
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;
    if (!el) return;
    if (el.dataset.shEventResponseEditorHandlers !== 'true') {
      el.dataset.shEventResponseEditorHandlers = 'true';
      el.addEventListener('click', this._onClick);
    }
    _bindUuidDrops(el);
  }

  async _onClick(event) {
    const btn = event.target?.closest?.('button[data-action]');
    if (!btn) return;
    if (String(btn.dataset.action || '') === 'cancel') {
      event.preventDefault();
      await this.close();
    }
  }

  async _onSubmit(_event, _form, formData) {
    const data = formData.object;
    const selectedOptionIndex = data.selectedOptionIndex === '' || data.selectedOptionIndex === undefined
      ? null
      : Number.parseInt(data.selectedOptionIndex, 10);
    const freeText = String(data.freeText || '');
    if (!validateResponseByMode({
      responseMode: this._data.responseMode,
      selectedOptionIndex,
      freeText,
    })) {
      ui.notifications?.warn?.(_localize('SPACEHOLDER.Events.Errors.ResponseInvalid', 'Response does not match configured mode'));
      return;
    }

    try {
      await submitFactionEventResponse(this._page, { selectedOptionIndex, freeText });
      await this.close();
    } catch (e) {
      ui.notifications?.error?.(String(e?.message || e));
    }
  }
}

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
  toggleTimelineV2EventPinned,
  getTimelineV2PinnedEventUuids,
  updateTimelineV2EventDate,
  updateTimelineV2EventMeta,
  deleteTimelineV2Event,
  TIMELINE_V2_ORIGIN,
} from './timeline-v2.mjs';

import { pickIcon } from './icon-picker/icon-picker.mjs';
import { enrichHTMLWithFactionIcons } from './faction-display.mjs';

const TEMPLATE_APP = 'systems/spaceholder/templates/timeline-v2/timeline-v2-app.hbs';
const TEMPLATE_EDITOR = 'systems/spaceholder/templates/timeline-v2/timeline-v2-event-editor.hbs';

const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 12 * DAYS_PER_MONTH; // 360

function _snapSerialToMonthStart(serial) {
  const s = Number(serial) || 0;
  // Month granularity: day 1 of the month.
  return Math.floor(s / DAYS_PER_MONTH) * DAYS_PER_MONTH;
}

const CANVAS_PAD_PX = 40;
const BASE_PX_PER_YEAR = 84;

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];

// Marker/pill layout (pixels)
const EVENT_OFFSET_PX = 44;

// Floating layout (pixels)
const EVENT_BASE_ICON_PX = 24;
const EVENT_ICON_GROWTH = 1.0; // max +100%

// Dynamic bumping between events
const EVENT_BUMP_PADDING_PX = 10;
const EVENT_BUMP_MIN_DY_PX = 34;

// Month ticks are only shown when sufficiently zoomed in
const MONTH_TICK_MIN_PX = 10;

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
  return await enrichHTMLWithFactionIcons(String(content ?? ''), {
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

function _parseYear(raw, fallback = 0) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) ? n : (Number(fallback) || 0);
}

function _clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return Number(fallback);
  return Math.min(max, Math.max(min, n));
}

async function _pickTimelineV2Date({ year, month, day } = {}) {
  const y0 = _parseYear(year, 0);
  const m0 = _clampInt(month, 1, 12, 1);
  const d0 = _clampInt(day, 1, 30, 1);

  const title = game?.i18n?.localize?.('SPACEHOLDER.TimelineV2.Buttons.PickDate') || 'Pick date';
  const applyLabel = game?.i18n?.localize?.('SPACEHOLDER.Actions.Apply') || 'Apply';
  const cancelLabel = game?.i18n?.localize?.('SPACEHOLDER.Actions.Cancel') || 'Cancel';

  const uid = Math.random().toString(36).slice(2, 10);
  const rootId = `spaceholder-tl2-date-picker-${uid}`;

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

      const angleRad = Math.atan2(dy, dx); // 0 at right
      const degFromRight = ((angleRad * 180 / Math.PI) + 360) % 360;
      const degFromTop = (degFromRight + 90) % 360; // 0 at top, clockwise

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

      const dy = Number(ev.deltaY) || 0;
      if (!dy) return;

      const dir = dy > 0 ? 1 : -1;
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

    // Initial sync
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

  const ensureInstalled = (settleFn) => {
    let tries = 0;
    let cleanup = null;

    const tick = () => {
      tries++;
      const rootEl = document.getElementById(rootId);
      if (rootEl) {
        cleanup = installInteractions(rootEl) || null;
        return;
      }
      if (tries < 30) requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);

    return () => {
      try {
        if (cleanup) cleanup();
      } catch (_) {
        // ignore
      }
    };
  };

  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (DialogV2?.wait) {
    try {
      return await new Promise((resolve) => {
        let settled = false;
        let cleanup = null;

        const settle = (v) => {
          if (settled) return;
          settled = true;
          try { cleanup?.(); } catch (_) { /* ignore */ }
          resolve(v);
        };

        cleanup = ensureInstalled(settle);

        const maybePromise = DialogV2.wait({
          window: { title, icon: 'fa-solid fa-calendar-days' },
          position: { width: 380 },
          content,
          buttons: [
            {
              action: 'apply',
              label: applyLabel,
              icon: 'fa-solid fa-check',
              default: true,
              callback: () => {
                try {
                  const root = document.getElementById(rootId);
                  const yRaw = root?.querySelector?.('input[name="year"]')?.value;
                  const doyRaw = root?.querySelector?.('input[name="dayOfYear"]')?.value;

                  const y = _parseYear(yRaw, y0);
                  const dayOfYear = _clampInt(doyRaw, 0, DAYS_PER_YEAR - 1, dayOfYear0);

                  const m = Math.floor(dayOfYear / DAYS_PER_MONTH) + 1;
                  const d = (dayOfYear % DAYS_PER_MONTH) + 1;

                  settle({ year: y, month: m, day: d });
                } catch (_) {
                  settle({ year: y0, month: m0, day: d0 });
                }
                return true;
              },
            },
            {
              action: 'cancel',
              label: cancelLabel,
              icon: 'fa-solid fa-times',
              callback: () => {
                settle(null);
                return true;
              },
            },
          ],
        });

        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(() => settle(null)).catch(() => settle(null));
        }
      });
    } catch (_) {
      // ignore and fallback
    }
  }

  // Fallback: Dialog (v1)
  try {
    const DialogImpl = globalThis.Dialog;
    if (DialogImpl) {
      return await new Promise((resolve) => {
        let settled = false;
        let cleanup = null;

        const settle = (v) => {
          if (settled) return;
          settled = true;
          try { cleanup?.(); } catch (_) { /* ignore */ }
          resolve(v);
        };

        const dialog = new DialogImpl({
          title,
          content,
          buttons: {
            apply: {
              label: applyLabel,
              callback: () => {
                try {
                  const root = document.getElementById(rootId);
                  const yRaw = root?.querySelector?.('input[name="year"]')?.value;
                  const doyRaw = root?.querySelector?.('input[name="dayOfYear"]')?.value;

                  const y = _parseYear(yRaw, y0);
                  const dayOfYear = _clampInt(doyRaw, 0, DAYS_PER_YEAR - 1, dayOfYear0);

                  const m = Math.floor(dayOfYear / DAYS_PER_MONTH) + 1;
                  const d = (dayOfYear % DAYS_PER_MONTH) + 1;

                  settle({ year: y, month: m, day: d });
                } catch (_) {
                  settle({ year: y0, month: m0, day: d0 });
                }
              },
            },
            cancel: {
              label: cancelLabel,
              callback: () => settle(null),
            },
          },
          default: 'apply',
          close: () => settle(null),
        });

        cleanup = ensureInstalled(settle);
        dialog.render(true);
      });
    }
  } catch (_) {
    // ignore
  }

  return null;
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
    origin = TIMELINE_V2_ORIGIN.FACTION,
    isGlobal = false,
    iconPath = '',
    hasDuration = false,
    durationDays = 0,
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

    this._origin = (String(origin || '').trim() === TIMELINE_V2_ORIGIN.WORLD)
      ? TIMELINE_V2_ORIGIN.WORLD
      : TIMELINE_V2_ORIGIN.FACTION;

    // World events (no faction) always have world origin.
    if (!this._factionUuid) this._origin = TIMELINE_V2_ORIGIN.WORLD;

    this._isGlobal = !!isGlobal;
    if (!this._factionUuid && this._allowNoFaction) this._isGlobal = true;

    this._iconPath = String(iconPath || '').trim();

    this._hasDuration = !!hasDuration;

    this._durationDays = Number.parseInt(String(durationDays ?? '').trim(), 10);
    if (!Number.isFinite(this._durationDays) || this._durationDays < 1) this._durationDays = 1;
    if (!this._hasDuration) this._durationDays = 0;

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
    const showOriginSelect = !isEdit;
    const showGlobalToggle = !isEdit && !!this._factionUuid;

    const startSerial = _dateToSerial({ year: this._year, month: this._month, day: this._day });

    const endDate = (this._hasDuration && (Number(this._durationDays) > 0))
      ? _serialToDate(startSerial + Number(this._durationDays))
      : null;

    const endYear = endDate ? endDate.year : 0;
    const endMonth = endDate ? endDate.month : 1;
    const endDay = endDate ? endDate.day : 1;

    return {
      isEdit,

      year: this._year,
      month: this._month,
      day: this._day,
      title: this._title,
      content: this._content,

      factions: this._factions,
      allowNoFaction: this._allowNoFaction,
      factionUuid: this._factionUuid,
      origin: this._origin,
      isGlobal: this._isGlobal,

      iconPath: this._iconPath,

      hasDuration: !!this._hasDuration,
      durationDays: Number(this._durationDays) || 0,
      endYear,
      endMonth,
      endDay,

      showFactionSelect,
      showOriginSelect,
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

  _syncDraftFromForm() {
    const root = this.element;
    if (!root) return;

    const year = Number.parseInt(String(root.querySelector('input[name="year"]')?.value ?? '').trim(), 10);
    if (Number.isFinite(year)) this._year = year;

    const month = Number.parseInt(String(root.querySelector('input[name="month"]')?.value ?? '').trim(), 10);
    if (Number.isFinite(month)) this._month = Math.min(12, Math.max(1, month));

    const day = Number.parseInt(String(root.querySelector('input[name="day"]')?.value ?? '').trim(), 10);
    if (Number.isFinite(day)) this._day = Math.min(30, Math.max(1, day));

    const titleEl = root.querySelector('input[name="title"]');
    if (typeof titleEl?.value === 'string') this._title = titleEl.value;

    const contentEl = root.querySelector('textarea[name="content"]');
    if (typeof contentEl?.value === 'string') this._content = contentEl.value;

    const globalCb = root.querySelector('input[type="checkbox"][name="isGlobal"]');
    if (globalCb) this._isGlobal = !!globalCb.checked;

    const originSel = root.querySelector('select[name="origin"]');
    if (originSel) {
      const v = String(originSel.value || '').trim();
      this._origin = (v === TIMELINE_V2_ORIGIN.WORLD) ? TIMELINE_V2_ORIGIN.WORLD : TIMELINE_V2_ORIGIN.FACTION;
      if (!this._factionUuid) this._origin = TIMELINE_V2_ORIGIN.WORLD;
    }

    const iconInput = root.querySelector('input[type="hidden"][name="iconPath"]');
    if (iconInput && typeof iconInput.value === 'string') {
      this._iconPath = String(iconInput.value || '').trim();
    }

    const hasDurationCb = root.querySelector('input[type="checkbox"][name="hasDuration"]');
    if (hasDurationCb) {
      this._hasDuration = !!hasDurationCb.checked;
    }

    const durationInput = root.querySelector('input[name="durationDays"]');
    if (durationInput) {
      const n = Number.parseInt(String(durationInput.value ?? '').trim(), 10);
      if (Number.isFinite(n) && n > 0) this._durationDays = n;
    }

    if (!this._hasDuration) this._durationDays = 0;
    else if (!Number.isFinite(this._durationDays) || this._durationDays < 1) this._durationDays = 1;
  }

  async _openDatePicker() {
    const root = this.element;
    if (!root) return;

    const yearInput = root.querySelector('input[name="year"]');
    const monthInput = root.querySelector('input[name="month"]');
    const dayInput = root.querySelector('input[name="day"]');

    const year = _parseYear(yearInput?.value, this._year);
    const month = _clampInt(monthInput?.value, 1, 12, this._month);
    const day = _clampInt(dayInput?.value, 1, 30, this._day);

    const picked = await _pickTimelineV2Date({ year, month, day });
    if (!picked) return;

    if (yearInput) yearInput.value = String(picked.year);
    if (monthInput) monthInput.value = String(picked.month);
    if (dayInput) dayInput.value = String(picked.day);

    this._year = picked.year;
    this._month = picked.month;
    this._day = picked.day;

    // Keep end-date display in sync.
    this.render(false);
  }

  async _openEndDatePicker() {
    const root = this.element;
    if (!root) return;

    this._syncDraftFromForm();

    const startSerial = _dateToSerial({ year: this._year, month: this._month, day: this._day });
    const curDuration = (this._hasDuration && (Number(this._durationDays) > 0)) ? Number(this._durationDays) : 1;

    const endDate0 = _serialToDate(startSerial + curDuration);

    const picked = await _pickTimelineV2Date(endDate0);
    if (!picked) return;

    const endSerial = _dateToSerial(picked);
    const dd = endSerial - startSerial;

    if (!(dd > 0)) {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.TimelineV2.Errors.EndDateInvalid') || 'Некорректная дата конца');
      return;
    }

    this._hasDuration = true;
    this._durationDays = dd;

    const cb = root.querySelector('input[type="checkbox"][name="hasDuration"]');
    if (cb) cb.checked = true;

    const durationInput = root.querySelector('input[name="durationDays"]');
    if (durationInput) durationInput.value = String(dd);

    this.render(false);
  }

  async _openIconPicker() {
    const defaultColor = '#ffffff';

    const title = game.i18n?.localize?.('SPACEHOLDER.TimelineV2.Buttons.PickIcon')
      || game.i18n?.localize?.('SPACEHOLDER.IconPicker.Title')
      || 'Pick icon';

    const factionColor = (() => {
      const fu = String(this._factionUuid || '').trim();
      if (!fu) return null;
      const f = (Array.isArray(this._factions) ? this._factions : []).find((x) => String(x?.uuid || '').trim() === fu);
      const c = String(f?.color ?? '').trim();
      return c || null;
    })();

    const initialPath = String(this._iconPath || '').trim() || null;

    const picked = await pickIcon({ defaultColor, title, factionColor, initialPath });
    if (!picked) return;

    this._iconPath = String(picked || '').trim();
    this.render(false);
  }

  async _onClick(ev) {
    const btn = ev.target?.closest?.('button[data-action]');
    if (!btn) return;

    const action = String(btn.dataset.action || '').trim();
    if (action === 'cancel') {
      ev.preventDefault();
      await this.close();
      return;
    }

    if (action === 'pick-date') {
      ev.preventDefault();
      await this._openDatePicker();
      return;
    }

    if (action === 'pick-end-date') {
      ev.preventDefault();
      await this._openEndDatePicker();
      return;
    }

    if (action === 'pick-icon') {
      ev.preventDefault();
      await this._openIconPicker();
      return;
    }

    if (action === 'clear-icon') {
      ev.preventDefault();
      this._iconPath = '';
      this.render(false);
    }
  }

  async _onChange(ev) {
    const factionSel = ev.target?.closest?.('select[name="factionUuid"][data-action="faction-change"]');
    if (factionSel) {
      this._syncDraftFromForm();
      this._factionUuid = String(factionSel.value || '').trim();

      if (!this._factionUuid) {
        this._origin = TIMELINE_V2_ORIGIN.WORLD;
        if (this._allowNoFaction) this._isGlobal = true;
      }

      this.render(false);
      return;
    }

    const originSel = ev.target?.closest?.('select[name="origin"]');
    if (originSel) {
      const v = String(originSel.value || '').trim();
      this._origin = (v === TIMELINE_V2_ORIGIN.WORLD) ? TIMELINE_V2_ORIGIN.WORLD : TIMELINE_V2_ORIGIN.FACTION;
      if (!this._factionUuid) this._origin = TIMELINE_V2_ORIGIN.WORLD;
      this.render(false);
      return;
    }

    const globalCb = ev.target?.closest?.('input[type="checkbox"][name="isGlobal"]');
    if (globalCb) {
      this._isGlobal = !!globalCb.checked;
      return;
    }

    const durationCb = ev.target?.closest?.('input[type="checkbox"][name="hasDuration"]');
    if (durationCb) {
      this._hasDuration = !!durationCb.checked;
      if (!this._hasDuration) this._durationDays = 0;
      else if (!Number.isFinite(this._durationDays) || this._durationDays < 1) this._durationDays = 1;
      this.render(false);
      return;
    }

    const durationInput = ev.target?.closest?.('input[name="durationDays"]');
    if (durationInput) {
      const n = Number.parseInt(String(durationInput.value ?? '').trim(), 10);
      if (Number.isFinite(n) && n > 0) {
        this._hasDuration = true;
        this._durationDays = n;
        this.render(false);
      }
      return;
    }

    const endDateInput = ev.target?.closest?.('input[name="endYear"], input[name="endMonth"], input[name="endDay"]');
    if (endDateInput) {
      const root = this.element;
      if (!root) return;

      this._syncDraftFromForm();

      const endYear = _parseYear(root.querySelector('input[name="endYear"]')?.value, this._year);
      const endMonth = _clampInt(root.querySelector('input[name="endMonth"]')?.value, 1, 12, this._month);
      const endDay = _clampInt(root.querySelector('input[name="endDay"]')?.value, 1, 30, this._day);

      const startSerial = _dateToSerial({ year: this._year, month: this._month, day: this._day });
      const endSerial = _dateToSerial({ year: endYear, month: endMonth, day: endDay });
      const dd = endSerial - startSerial;

      if (!(dd > 0)) {
        ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.TimelineV2.Errors.EndDateInvalid') || 'Некорректная дата конца');
        this.render(false);
        return;
      }

      this._hasDuration = true;
      this._durationDays = dd;

      const cb = root.querySelector('input[type="checkbox"][name="hasDuration"]');
      if (cb) cb.checked = true;

      const durationInput = root.querySelector('input[name="durationDays"]');
      if (durationInput) durationInput.value = String(dd);

      this.render(false);
      return;
    }

    const dateInput = ev.target?.closest?.('input[name="year"], input[name="month"], input[name="day"]');
    if (dateInput) {
      this._syncDraftFromForm();
      if (this._hasDuration) this.render(false);
    }
  }

  async _onSubmit(_event, _form, formData) {
    const data = formData.object;

    const title = String(data.title || '').trim();
    if (!title) {
      ui.notifications?.warn?.('Название обязательно');
      return;
    }

    const year = _parseYear(data.year, this._year);
    const month = _clampInt(data.month, 1, 12, this._month);
    const day = _clampInt(data.day, 1, 30, this._day);

    const origin = (String(data.origin ?? this._origin ?? '').trim() === TIMELINE_V2_ORIGIN.WORLD)
      ? TIMELINE_V2_ORIGIN.WORLD
      : TIMELINE_V2_ORIGIN.FACTION;

    const iconPath = String(data.iconPath ?? this._iconPath ?? '').trim();

    const hasDuration = !!data.hasDuration;

    let durationDays = 0;
    if (hasDuration) {
      const ddFromDuration = _clampInt(data.durationDays, 1, 1000000, (Number(this._durationDays) || 1));

      const endYear = _parseYear(data.endYear, year);
      const endMonth = _clampInt(data.endMonth, 1, 12, month);
      const endDay = _clampInt(data.endDay, 1, 30, day);

      const startSerial = _dateToSerial({ year, month, day });
      const endSerial = _dateToSerial({ year: endYear, month: endMonth, day: endDay });
      const ddFromEnd = endSerial - startSerial;

      const prev = Number(this._durationDays) || ddFromDuration;

      const endValid = Number.isFinite(ddFromEnd) && ddFromEnd > 0;
      const durValid = Number.isFinite(ddFromDuration) && ddFromDuration > 0;

      let chosen = ddFromDuration;
      if (endValid && durValid) {
        // Prefer the value which differs from the previous draft (covers "changed field but didn't blur").
        if (ddFromEnd !== prev && ddFromDuration === prev) chosen = ddFromEnd;
        else if (ddFromDuration !== prev && ddFromEnd === prev) chosen = ddFromDuration;
        else chosen = ddFromDuration;
      } else if (endValid) chosen = ddFromEnd;
      else if (durValid) chosen = ddFromDuration;
      else chosen = 0;

      if (!(chosen > 0)) {
        ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.TimelineV2.Errors.EndDateInvalid') || 'Некорректная дата конца');
        return;
      }

      durationDays = chosen;
    }

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

        const y = year;
        const m = month;
        const d = day;

        if (t.year !== y || t.month !== m || t.day !== d) {
          await updateTimelineV2EventDate({
            indexUuid: indexPage.uuid,
            year: y,
            month: m,
            day: d,
          });
        }

        const curIconPath = String(t.iconPath ?? '').trim();
        const curHasDuration = !!t.hasDuration;
        const curDurationDays = Number(t.durationDays) || 0;

        const nextHasDuration = !!hasDuration;
        const nextDurationDays = nextHasDuration ? durationDays : 0;

        const metaChanged = (
          curIconPath !== String(iconPath || '').trim()
          || curHasDuration !== nextHasDuration
          || curDurationDays !== nextDurationDays
        );

        if (metaChanged) {
          await updateTimelineV2EventMeta({
            indexUuid: indexPage.uuid,
            iconPath,
            hasDuration: nextHasDuration,
            durationDays: nextDurationDays,
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

    if (origin === TIMELINE_V2_ORIGIN.FACTION && !factionUuid) {
      ui.notifications?.warn?.('Фракция обязательна');
      return;
    }

    // World-only events are GM-only.
    if (origin === TIMELINE_V2_ORIGIN.WORLD && !factionUuid && !_isGM()) {
      ui.notifications?.warn?.('Фракция обязательна');
      return;
    }

    // World events are always global.
    const isGlobal = factionUuid ? !!data.isGlobal : true;

    try {
      await createTimelineV2Event({
        year,
        month,
        day,
        factionUuid,
        origin,
        iconPath,
        hasDuration,
        durationDays,
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
  return `${d}.${m}.${y}`;
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
    this._onRootContextMenu = this._onRootContextMenu.bind(this);
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
      origin: defaultFactionUuid ? TIMELINE_V2_ORIGIN.FACTION : TIMELINE_V2_ORIGIN.WORLD,
      isGlobal: false,
      iconPath: '',
      hasDuration: false,
      durationDays: 0,
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
      origin: t.origin,
      iconPath: t.iconPath,
      hasDuration: t.hasDuration,
      durationDays: t.durationDays,
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

    const vpH = vpBottom - vpTop;
    const vpCenter = vpTop + (vpH * 0.5);

    const half = vpH * 0.5;
    const close01FromY = (y) => {
      const dist = Math.abs((Number(y) || 0) - vpCenter);
      return (half > 0) ? (1 - Math.min(1, dist / half)) : 0;
    };

    const nodes = Array.from(canvas.querySelectorAll('.sh-tl2__event'));

    const sides = {
      left: [],
      right: [],
    };

    for (const el of nodes) {
      const startTop = Number.parseFloat(String(el.dataset.anchorTop || ''));
      if (!Number.isFinite(startTop)) continue;

      const rangeLen = Number.parseFloat(String(el.dataset.rangeLen || ''));
      const isRange = Number.isFinite(rangeLen) && rangeLen > 0;

      // Point events: only render if the exact date point is visible.
      // Range events: render if any part of the range intersects the viewport.
      const visible = isRange
        ? (startTop >= vpTop && (startTop - rangeLen) <= vpBottom)
        : (startTop >= vpTop && startTop <= vpBottom);

      if (!visible) {
        el.style.display = 'none';
        continue;
      }

      el.style.display = '';

      // Range pills should slide along their duration and "stick" closer to the viewport center.
      // Keep range marker itself bound to the true start point.
      let anchorTop = startTop;
      if (isRange) {
        const endTop = startTop - rangeLen;
        const attachTop = Math.min(startTop, Math.max(endTop, vpCenter));
        anchorTop = Number.isFinite(attachTop) ? attachTop : startTop;
      }

      const side = el.classList.contains('is-left') ? 'left' : 'right';
      sides[side].push({
        el,
        startTop,
        anchorTop,
        isRange,
        rangeLen: (isRange ? rangeLen : 0),
      });
    }

    const layoutSide = (items) => {
      if (!items.length) return;

      items.sort((a, b) => {
        if (a.anchorTop !== b.anchorTop) return a.anchorTop - b.anchorTop;
        return String(a.el.dataset.uuid || '').localeCompare(String(b.el.dataset.uuid || ''));
      });

      const anchors = items.map((it) => it.anchorTop);
      const y = anchors.slice();

      const isDiamond = (el) => (
        el.classList.contains('is-origin-world')
        && el.classList.contains('has-faction')
        && !el.classList.contains('is-range')
      );

      // Estimate pill sizes at anchor points to compute dynamic bumping.
      const metrics = items.map((it) => {
        const close01 = close01FromY(it.anchorTop);
        const diamondBoost = isDiamond(it.el) ? 1.4 : 1;

        const iconBase = EVENT_BASE_ICON_PX * diamondBoost;
        const iconSize = iconBase * (1 + (EVENT_ICON_GROWTH * close01));

        // Approximate vertical height for collision prevention.
        const minControl = 26; // drag handle button height
        const itemH = Math.max(iconSize, minControl) + 4; // pill vertical padding

        return { itemH };
      });

      const spacing = (a, b) => {
        const ha = metrics[a]?.itemH ?? EVENT_BASE_ICON_PX;
        const hb = metrics[b]?.itemH ?? EVENT_BASE_ICON_PX;
        const raw = ((ha + hb) * 0.5) + EVENT_BUMP_PADDING_PX;
        return Math.max(EVENT_BUMP_MIN_DY_PX, raw);
      };

      // Forward pass: prevent overlaps.
      for (let i = 1; i < y.length; i += 1) {
        const minNext = y[i - 1] + spacing(i - 1, i);
        if (y[i] < minNext) y[i] = minNext;
      }

      // Backward pass: pull back up where possible to stay closer to anchors.
      for (let i = y.length - 2; i >= 0; i -= 1) {
        const maxPrev = y[i + 1] - spacing(i, i + 1);
        if (y[i] > maxPrev) y[i] = maxPrev;
      }

      // Keep floating pills inside viewport as much as possible.
      const maxHalfH = metrics.reduce((acc, m) => {
        const v = (Number(m?.itemH) || 0) * 0.5;
        return Math.max(acc, v);
      }, 0);

      const pad = Math.round(Math.min(48, Math.max(28, maxHalfH + 8)));
      const minY = vpTop + pad;
      const maxY = vpBottom - pad;

      // Clamp overflow at viewport edges.
      // This avoids a uniform shift (which makes all wires tilt with the same angle).
      if (Number.isFinite(minY) && Number.isFinite(maxY) && maxY > minY) {
        const clampTop = () => {
          if (y[0] >= minY) return;
          y[0] = minY;
          for (let i = 1; i < y.length; i += 1) {
            const minNext = y[i - 1] + spacing(i - 1, i);
            if (y[i] < minNext) y[i] = minNext;
          }
        };

        const clampBottom = () => {
          const last = y.length - 1;
          if (y[last] <= maxY) return;
          y[last] = maxY;
          for (let i = last - 1; i >= 0; i -= 1) {
            const maxPrev = y[i + 1] - spacing(i, i + 1);
            if (y[i] > maxPrev) y[i] = maxPrev;
          }
        };

        clampTop();
        clampBottom();
        // If we clamped bottom, the top may be pushed out again (viewport too small). Try once more.
        clampTop();
      }

      for (let i = 0; i < items.length; i += 1) {
        const { el, startTop, anchorTop, isRange, rangeLen } = items[i];
        const floatTop = y[i];

        // Move event anchor to the floating position.
        el.style.top = `${Math.round(floatTop)}px`;

        const startDy = startTop - floatTop;
        const wireDy = anchorTop - floatTop;

        // Dynamic icon size: bigger near viewport center (0..1 closeness).
        const close01 = close01FromY(floatTop);
        const diamondBoost = isDiamond(el) ? 1.4 : 1;

        const iconBase = EVENT_BASE_ICON_PX * diamondBoost;
        const iconSize = iconBase * (1 + (EVENT_ICON_GROWTH * close01));

        // Icon-picker bakes an SVG; render it at full marker size (avoid 0.75 downscale).
        // Default (font-awesome) placeholder uses CSS font-size and doesn't rely on --sh-icon-img-size.
        const hasCustomIcon = el.classList.contains('has-custom-icon');
        const imgScale = hasCustomIcon ? 1.0 : 0.75;
        const imgSize = iconSize * imgScale;

        el.style.setProperty('--sh-icon-size', `${Math.round(iconSize)}px`);
        el.style.setProperty('--sh-icon-img-size', `${Math.round(imgSize)}px`);

        // Growth should be symmetric: move pill offset so the icon expands towards the line too.
        const offset = EVENT_OFFSET_PX + ((iconBase - iconSize) * 0.5);
        el.style.setProperty('--sh-event-offset', `${Math.round(offset)}px`);
        el.style.setProperty('--sh-event-offsetSigned', `${Math.round(-offset)}px`);

        // Wire from icon edge to the chosen anchor point.
        const side = el.classList.contains('is-left') ? 'left' : 'right';
        const dx = (side === 'left') ? -offset : offset;

        const vx = dx;
        const vy = -wireDy;

        const len = Math.sqrt((vx * vx) + (vy * vy));
        const angle = Math.atan2(vy, vx) * (180 / Math.PI);

        el.style.setProperty('--sh-range-startY', `${Math.round(startDy)}px`);
        el.style.setProperty('--sh-wire-startY', `${Math.round(wireDy)}px`);
        el.style.setProperty('--sh-wire-length', `${Math.round(len)}px`);
        el.style.setProperty('--sh-wire-angle', `${angle}deg`);
      }
    };

    layoutSide(sides.left);
    layoutSide(sides.right);

    // Year labels: always visible and scale towards viewport center.
    try {
      const yearTicks = Array.from(canvas.querySelectorAll('.sh-tl2__tick.is-year'));
      for (const tickEl of yearTicks) {
        const topPx = Number.parseFloat(String(tickEl.style.top || '0').replace('px', ''));
        if (!Number.isFinite(topPx)) continue;

        const close01 = close01FromY(topPx);
        const scale = 0.9 + (0.9 * close01);
        const opacity = 0.28 + (0.72 * close01);

        tickEl.style.setProperty('--sh-year-scale', String(scale));
        tickEl.style.setProperty('--sh-year-opacity', String(opacity));
      }
    } catch (_) {
      // ignore
    }
  }

  async _openDetailsDrawer(indexUuid) {
    const indexPage = await resolveTimelineV2Page(indexUuid);
    if (!indexPage) return;

    const t = getTimelineV2PageData(indexPage);
    if (!t?.isIndex) return;

    let dateText = _formatDate(t);

    if (t.hasDuration && (Number(t.durationDays) > 0)) {
      const endDate = _serialToDate(_dateToSerial(t) + Number(t.durationDays));
      dateText = `${dateText} → ${_formatDate(endDate)}`;
    }

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

    const pinnedSet = new Set(getTimelineV2PinnedEventUuids());

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

      const startSerial = _dateToSerial(t);

      const durationDays = Number(t.durationDays) || 0;
      const isRange = !!t.hasDuration && durationDays > 0;

      const endSerial = isRange ? (startSerial + durationDays) : null;

      const startDateText = _formatDate(t);
      const endDateText = isRange ? _formatDate(_serialToDate(endSerial)) : '';
      const dateText = isRange ? `${startDateText} → ${endDateText}` : startDateText;

      const origin = (String(t.origin || '').trim() === TIMELINE_V2_ORIGIN.WORLD)
        ? TIMELINE_V2_ORIGIN.WORLD
        : TIMELINE_V2_ORIGIN.FACTION;

      const originClass = (origin === TIMELINE_V2_ORIGIN.WORLD) ? 'is-origin-world' : 'is-origin-faction';

      // "World" origin always renders on the world side.
      const sideClass = (origin === TIMELINE_V2_ORIGIN.WORLD || !t.factionUuid || activeSet.has(t.factionUuid))
        ? 'is-right'
        : 'is-left';

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
        serial: startSerial,
        endSerial,
        durationDays: isRange ? durationDays : 0,
        origin,
        originClass,
        iconPath: String(t.iconPath || '').trim(),
        isPinned: pinnedSet.has(page.uuid),
        hasFaction: !!t.factionUuid,

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
      // Include range end dates too, otherwise long events can extend beyond the scrollable canvas.
      let minSerial = Number.POSITIVE_INFINITY;
      let maxSerial = Number.NEGATIVE_INFINITY;

      for (const e of rawEvents) {
        const s0 = Number(e.serial);
        if (Number.isFinite(s0)) {
          if (s0 < minSerial) minSerial = s0;
          if (s0 > maxSerial) maxSerial = s0;
        }

        const s1 = Number(e.endSerial);
        if (Number.isFinite(s1)) {
          if (s1 < minSerial) minSerial = s1;
          if (s1 > maxSerial) maxSerial = s1;
        }
      }

      if (Number.isFinite(minSerial) && Number.isFinite(maxSerial)) {
        minYear = Math.floor(minSerial / DAYS_PER_YEAR);
        maxYear = Math.floor(maxSerial / DAYS_PER_YEAR);

        // Ensure year 0 is always in view
        minYear = Math.min(minYear, 0);
        maxYear = Math.max(maxYear, 0);

        // Padding
        minYear -= 2;
        maxYear += 2;
      }
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

    const pxPerMonth = pxPerDay * DAYS_PER_MONTH;

    const monthCount = (maxYear - minYear + 1) * 12;
    const showMonthTicks = (pxPerMonth >= MONTH_TICK_MIN_PX) && (monthCount <= 6000);

    const yearTicks = [];
    for (let y = minYear; y <= maxYear; y += tickStep) {
      yearTicks.push({
        kind: 'year',
        isYear: true,
        year: y,
        topPx: serialToTopPx(y * DAYS_PER_YEAR),
      });
    }

    // Ensure year 0 tick exists
    if (!yearTicks.some((t) => t.year === 0)) {
      yearTicks.push({ kind: 'year', isYear: true, year: 0, topPx: year0TopPx });
    }

    const monthTicks = [];
    if (showMonthTicks) {
      const yearTickSet = new Set(yearTicks.map((t) => Number(t.year)));

      for (let y = minYear; y <= maxYear; y += 1) {
        for (let m = 1; m <= 12; m += 1) {
          // Month ticks at the start of a year are redundant when a year tick exists.
          if (m === 1 && yearTickSet.has(y)) continue;

          const serial = (y * DAYS_PER_YEAR) + ((m - 1) * DAYS_PER_MONTH);
          monthTicks.push({
            kind: 'month',
            isMonth: true,
            year: y,
            month: m,
            topPx: serialToTopPx(serial),
          });
        }
      }
    }

    const ticks = [...yearTicks, ...monthTicks].sort((a, b) => {
      if (a.topPx !== b.topPx) return a.topPx - b.topPx;
      if (a.isYear && !b.isYear) return -1;
      if (!a.isYear && b.isYear) return 1;
      return 0;
    });

    const events = rawEvents
      .map((e) => {
        const topPx = serialToTopPx(e.serial);

        const endTopPx = Number.isFinite(e.endSerial)
          ? serialToTopPx(e.endSerial)
          : null;

        const rangeLenPx = (Number.isFinite(endTopPx))
          ? Math.max(0, topPx - endTopPx)
          : 0;

        return {
          ...e,
          topPx,
          endTopPx,
          rangeLenPx,
          isRange: rangeLenPx > 0,
        };
      })
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
      el.addEventListener('contextmenu', this._onRootContextMenu);
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

  async _onRootContextMenu(event) {
    const btn = event.target?.closest?.('.sh-tl2__eventIconBtn');
    if (!btn) return;

    const uuid = String(btn.dataset.uuid || '').trim();
    if (!uuid) return;

    event.preventDefault();
    event.stopPropagation();

    await toggleTimelineV2EventPinned(uuid);
    this._renderPreserveScroll();
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

    if (action === 'toggle-pin') {
      // Legacy: pin/unpin moved to RMB (contextmenu) on the icon.
      event.preventDefault();
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
      this._selectedEventUuid = '';
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
    // Preserve the original anchor offset; during drag we snap the landing point to months.
    const startAnchorTopPx = Number.parseFloat(String(eventEl.dataset.anchorTop || ''));
    const currentTopPx = Number.parseFloat(String(eventEl.style.top || '0').replace('px', ''));

    const startTopPx = Number.isFinite(currentTopPx)
      ? currentTopPx
      : (Number.isFinite(startAnchorTopPx) ? startAnchorTopPx : 0);

    const startOffsetPx = Number.isFinite(startAnchorTopPx)
      ? (startAnchorTopPx - startTopPx)
      : 0;

    const side = eventEl.classList.contains('is-left') ? 'left' : 'right';

    let offset = EVENT_OFFSET_PX;
    try {
      const raw = globalThis.getComputedStyle?.(eventEl)?.getPropertyValue?.('--sh-event-offset');
      const n = Number.parseFloat(String(raw ?? '').replace('px', '').trim());
      if (Number.isFinite(n) && n > 0) offset = n;
    } catch (_) {
      // ignore
    }

    const dx = (side === 'left') ? -offset : offset;

    this._drag = {
      pointerId: event.pointerId,
      uuid,
      eventEl,
      startClientY: event.clientY,
      startTopPx,
      startOffsetPx,
      lockedScrollTop: Number.isFinite(lockedScrollTop) ? lockedScrollTop : null,
      dx,
      snappedSerial: null,
    };

    try {
      // Keep the event where it currently is (range pills may be anchored mid-segment).
      eventEl.style.top = `${startTopPx}px`;

      const meta = this._serialMeta;
      if (meta && Number.isFinite(meta.pxPerDay) && Number.isFinite(meta.maxBoundSerial) && Number.isFinite(meta.padPx)) {
        const rawStartTopPx = startTopPx + startOffsetPx;
        const rawSerial = Math.round(meta.maxBoundSerial - ((rawStartTopPx - meta.padPx) / meta.pxPerDay));
        const snappedSerial = _snapSerialToMonthStart(rawSerial);
        const snappedStartTopPx = ((meta.maxBoundSerial - snappedSerial) * meta.pxPerDay) + meta.padPx;

        const wireDy = snappedStartTopPx - startTopPx;
        const vx = dx;
        const vy = -wireDy;
        const len = Math.sqrt((vx * vx) + (vy * vy));
        const angle = Math.atan2(vy, vx) * (180 / Math.PI);

        this._drag.snappedSerial = snappedSerial;

        // Keep range marker aligned to the snapped start point while dragging.
        eventEl.style.setProperty('--sh-range-startY', `${Math.round(wireDy)}px`);

        // Wire points to the snapped landing point.
        eventEl.style.setProperty('--sh-wire-startY', `${Math.round(wireDy)}px`);
        eventEl.style.setProperty('--sh-wire-length', `${Math.round(len)}px`);
        eventEl.style.setProperty('--sh-wire-angle', `${angle}deg`);
      }
    } catch (_) {
      // ignore
    }

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

    const drag = this._drag;
    const delta = event.clientY - drag.startClientY;
    const nextTop = drag.startTopPx + delta;

    try {
      drag.eventEl.style.top = `${nextTop}px`;
    } catch (_) {
      // ignore
    }

    const meta = this._serialMeta;
    if (!meta || !Number.isFinite(meta.pxPerDay) || !Number.isFinite(meta.maxBoundSerial) || !Number.isFinite(meta.padPx)) return;

    const rawStartTopPx = nextTop + (Number(drag.startOffsetPx) || 0);
    const rawSerial = Math.round(meta.maxBoundSerial - ((rawStartTopPx - meta.padPx) / meta.pxPerDay));
    const snappedSerial = _snapSerialToMonthStart(rawSerial);
    const snappedStartTopPx = ((meta.maxBoundSerial - snappedSerial) * meta.pxPerDay) + meta.padPx;

    const wireDy = snappedStartTopPx - nextTop;

    try {
      const dx = Number(drag.dx) || 0;
      const vx = dx;
      const vy = -wireDy;
      const len = Math.sqrt((vx * vx) + (vy * vy));
      const angle = Math.atan2(vy, vx) * (180 / Math.PI);

      drag.snappedSerial = snappedSerial;

      drag.eventEl.style.setProperty('--sh-range-startY', `${Math.round(wireDy)}px`);
      drag.eventEl.style.setProperty('--sh-wire-startY', `${Math.round(wireDy)}px`);
      drag.eventEl.style.setProperty('--sh-wire-length', `${Math.round(len)}px`);
      drag.eventEl.style.setProperty('--sh-wire-angle', `${angle}deg`);
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

    const rawStartTopPx = topPx + (Number(drag.startOffsetPx) || 0);
    const rawSerial = Math.round(meta.maxBoundSerial - ((rawStartTopPx - meta.padPx) / meta.pxPerDay));

    const snappedSerial = Number.isFinite(drag.snappedSerial)
      ? Number(drag.snappedSerial)
      : _snapSerialToMonthStart(rawSerial);

    const next = _serialToDate(snappedSerial);

    try {
      await updateTimelineV2EventDate({
        indexUuid: uuid,
        year: next.year,
        month: next.month,
        day: 1,
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

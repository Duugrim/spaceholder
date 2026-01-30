// Progression Points App (Foundry v13, ApplicationV2)

import {
  computePlayerPointsBreakdown,
  isProgressionEnabled,
  getUserManualAdjustments,
  setUserManualAdjustments,
  makeNewManualEntry,
} from './progression-points.mjs';

let _singleton = null;

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

export function openProgressionPointsApp({ userId = null } = {}) {
  if (!isProgressionEnabled()) {
    ui.notifications?.info?.('Очки прогрессии отключены в настройках системы');
    return null;
  }

  if (_singleton) {
    try {
      if (userId) _singleton.setTargetUserId(userId);
      _singleton.render(true);
      _singleton.bringToTop?.();
    } catch (_) {
      // ignore
    }
    return _singleton;
  }

  _singleton = new ProgressionPointsApp({ userId });
  _singleton.render(true);
  return _singleton;
}

export class ProgressionPointsApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-progression-points',
    classes: ['spaceholder', 'progression-points'],
    tag: 'div',
    window: { title: 'Очки прогрессии', resizable: true },
    position: { width: 720, height: 720 },
  };

  static PARTS = {
    main: { root: true, template: 'systems/spaceholder/templates/progression/progression-points-app.hbs' },
  };

  constructor({ userId = null } = {}) {
    super();
    this._targetUserId = String(userId ?? '').trim() || null;
  }

  setTargetUserId(userId) {
    const id = String(userId ?? '').trim();
    this._targetUserId = id || null;
  }

  _resolveTargetUser() {
    const isGM = !!game.user?.isGM;
    const self = game.user;

    if (!isGM) return self;

    const id = String(this._targetUserId ?? '').trim();
    if (!id) return self;

    return game.users?.get?.(id) ?? self;
  }

  async close(options = {}) {
    await super.close(options);
    if (_singleton === this) _singleton = null;
  }

  async _prepareContext() {
    const isGM = !!game.user?.isGM;
    const user = this._resolveTargetUser();

    const breakdown = computePlayerPointsBreakdown(user);

    const journalLines = breakdown.journalLines
      .slice()
      .sort((a, b) => String(a.entryName ?? '').localeCompare(String(b.entryName ?? ''), 'ru'));

    const manual = getUserManualAdjustments(user);

    const userChoices = Array.from(game?.users?.values?.() ?? game?.users?.contents ?? [])
      .filter((u) => u?.id)
      .map((u) => ({ id: u.id, name: String(u.name ?? '').trim() || u.id }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));

    return {
      isGM,
      targetUserId: user.id,
      userChoices,
      userName: String(user?.name ?? '').trim() || '—',

      journalLines,
      manual,

      journalPoints: breakdown.journalPoints,
      manualPoints: breakdown.manualPoints,
      totalPlayerPoints: breakdown.totalPlayerPoints,
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    const el = this.element;
    if (!el) return;

    el.querySelectorAll('[data-action="open-journal"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        await _openJournalUuid(btn.dataset.uuid);
      });
    });

    const rerender = () => {
      try { this.render(false); } catch (_) {}
    };

    // GM: user select
    el.querySelectorAll('[data-action="pp-select-user"]').forEach((sel) => {
      sel.addEventListener('change', (ev) => {
        const id = String(sel.value ?? '').trim();
        this.setTargetUserId(id || null);
        rerender();
      });
    });

    const targetUser = this._resolveTargetUser();

    // Manual adjustments
    el.querySelectorAll('[data-action="pp-manual-add"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const next = [...getUserManualAdjustments(targetUser), makeNewManualEntry()];
        await setUserManualAdjustments(targetUser, next);
        rerender();
      });
    });

    el.querySelectorAll('[data-action="pp-manual-remove"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const id = String(btn.dataset.id ?? '').trim();
        if (!id) return;
        const cur = getUserManualAdjustments(targetUser);
        const next = cur.filter((r) => String(r.id) !== id);
        await setUserManualAdjustments(targetUser, next);
        rerender();
      });
    });

    const bindManualInput = (input) => {
      input.addEventListener('change', async (ev) => {
        const id = String(input.dataset.id ?? '').trim();
        if (!id) return;

        const cur = getUserManualAdjustments(targetUser);

        const next = cur.map((r) => {
          if (String(r.id) !== id) return r;
          const copy = { ...r };
          if (input.dataset.field === 'name') copy.name = String(input.value ?? '').trim();
          if (input.dataset.field === 'points') copy.points = Number(input.value) || 0;
          return copy;
        });

        await setUserManualAdjustments(targetUser, next);
        rerender();
      });
    };

    el.querySelectorAll('[data-action="pp-manual-edit"]').forEach((input) => bindManualInput(input));
  }
}

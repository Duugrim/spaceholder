import {
  ensureUserActiveFaction,
  getAllowedFactionUuidsForUser,
  getEffectiveFactionUuidForUser,
  getWorldFactionActors,
  normalizeUuid,
  setUserActiveFactionUuid,
} from './user-factions.mjs';

import {
  computeFactionMaxPoints,
  computeFactionSpentPoints,
  isProgressionEnabled,
} from './progression-points.mjs';

const UI_ID = 'spaceholder-hotbar-faction-ui';
const TEMPLATE_PATH = 'systems/spaceholder/templates/hud/hotbar-faction-ui.hbs';

let _hooksInstalled = false;
let _uiInstance = null;

function _t(key) {
  return game?.i18n?.localize ? game.i18n.localize(key) : String(key);
}

function _isActiveFactionChanged(changes) {
  try {
    const flags = changes?.flags;
    const sh = flags?.spaceholder;
    const changedViaFlagsObject = !!(sh && typeof sh === 'object' && Object.prototype.hasOwnProperty.call(sh, 'activeFaction'));
    const changedViaFlatKey = Object.keys(changes ?? {}).some((k) => k === 'flags.spaceholder.activeFaction' || k.startsWith('flags.spaceholder.activeFaction'));
    return changedViaFlagsObject || changedViaFlatKey;
  } catch (_) {
    return false;
  }
}

function _areFactionsChanged(changes) {
  try {
    const flags = changes?.flags;
    const sh = flags?.spaceholder;
    const changedViaFlagsObject = !!(sh && typeof sh === 'object' && Object.prototype.hasOwnProperty.call(sh, 'factions'));
    const changedViaFlatKey = Object.keys(changes ?? {}).some((k) => k === 'flags.spaceholder.factions' || k.startsWith('flags.spaceholder.factions'));
    return changedViaFlagsObject || changedViaFlatKey;
  } catch (_) {
    return false;
  }
}

function _formatPoints(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(1);
}

async function _resolveActorByUuid(rawUuid) {
  const uuid = normalizeUuid(rawUuid);
  if (!uuid) return null;

  // Fast path for world actors
  const parts = uuid.split('.');
  if (parts[0] === 'Actor' && parts[1] && parts.length === 2) {
    return game?.actors?.get?.(parts[1]) ?? null;
  }

  try {
    return await fromUuid(uuid);
  } catch (_) {
    return null;
  }
}

class HotbarFactionUI {
  constructor() {
    this.open = false;
    this._renderSeq = 0;
    this._scheduled = null;

    this._onDocPointerDown = this._onDocPointerDown.bind(this);
    this._onRootClick = this._onRootClick.bind(this);
  }

  get element() {
    return document.getElementById(UI_ID);
  }

  _setOpen(root, value) {
    this.open = !!value;
    if (!root) return;
    root.dataset.open = this.open ? 'true' : 'false';

    const flyout = root.querySelector('.sh-hotbar-faction__flyout');
    if (flyout) flyout.setAttribute('aria-hidden', this.open ? 'false' : 'true');

    // Outside click close
    try {
      document.removeEventListener('pointerdown', this._onDocPointerDown, true);
    } catch (_) {}

    if (this.open) {
      try {
        document.addEventListener('pointerdown', this._onDocPointerDown, true);
      } catch (_) {}
    }
  }

  _onDocPointerDown(ev) {
    const root = this.element;
    if (!root) return;
    if (!this.open) return;

    // If click is outside, close.
    const inside = ev?.target && root.contains(ev.target);
    if (!inside) this._setOpen(root, false);
  }

  _applySlotSize(root, hotbarEl) {
    if (!root || !hotbarEl) return;

    const macro = hotbarEl.querySelector('.macro')
      || hotbarEl.querySelector('li.macro')
      || hotbarEl.querySelector('.macro-slot')
      || null;

    if (!macro?.getBoundingClientRect) return;

    const r = macro.getBoundingClientRect();
    const size = Math.round(Math.max(0, r.height || r.width || 0));
    if (!size) return;

    root.style.setProperty('--sh-hotbar-slot', `${size}px`);
  }

  async _buildContext() {
    const user = game?.user;
    if (!user) return null;

    const isGM = !!user.isGM;

    // Determine available factions
    const allowedUuids = getAllowedFactionUuidsForUser(user);

    if (isGM) {
      // For GM we show the selector only if there is at least one faction in the world.
      if (!allowedUuids.length) return null;
    } else {
      // Player: no factions -> no UI.
      if (!allowedUuids.length) return null;
    }

    const effectiveUuid = getEffectiveFactionUuidForUser(user);

    const noFactionLabel = _t('SPACEHOLDER.HotbarFaction.NoFaction');

    let active = { uuid: '', name: '', img: '' };
    if (effectiveUuid) {
      const doc = await _resolveActorByUuid(effectiveUuid);
      if (doc?.documentName === 'Actor' && doc?.type === 'faction') {
        active = {
          uuid: doc.uuid,
          name: String(doc.name ?? '').trim() || doc.uuid,
          img: String(doc.img ?? '').trim(),
        };
      }
    }

    // Choices list
    const choices = [];
    if (isGM) {
      // GM can always clear selection by choosing "none".
      for (const a of getWorldFactionActors()) {
        if (!a?.uuid) continue;
        if (active.uuid && a.uuid === active.uuid) continue;
        choices.push({ uuid: a.uuid, name: String(a.name ?? '').trim() || a.uuid, img: String(a.img ?? '').trim() });
      }
    } else {
      // Player: only own factions
      for (const u of allowedUuids) {
        const uuid = normalizeUuid(u);
        if (!uuid) continue;
        if (active.uuid && uuid === active.uuid) continue;
        const doc = await _resolveActorByUuid(uuid);
        if (doc?.documentName === 'Actor' && doc?.type === 'faction') {
          choices.push({ uuid: doc.uuid, name: String(doc.name ?? '').trim() || doc.uuid, img: String(doc.img ?? '').trim() });
        } else {
          choices.push({ uuid, name: uuid, img: '' });
        }
      }
    }

    const canToggle = isGM ? true : (choices.length > 0);
    const showNoFaction = isGM;

    const toggleLabel = active.uuid
      ? active.name
      : (isGM ? noFactionLabel : _t('SPACEHOLDER.HotbarFaction.Faction'));

    // PP display
    let ppText = '';
    let ppTooltip = '';

    if (isProgressionEnabled() && active.uuid) {
      const factionActor = await _resolveActorByUuid(active.uuid);
      if (factionActor?.documentName === 'Actor' && factionActor?.type === 'faction') {
        const max = computeFactionMaxPoints(factionActor);
        const spent = computeFactionSpentPoints(factionActor);
        const spentTotal = Number(spent?.spentTotal) || 0;

        ppText = `${_formatPoints(spentTotal)}/${_formatPoints(max)}`;
        ppTooltip = _t('SPACEHOLDER.HotbarFaction.PP');
      }
    }

    return {
      active,
      choices,
      canToggle,
      showNoFaction,
      noFactionLabel,
      toggleLabel,
      ppText,
      ppTooltip,
    };
  }

  async render({ hotbarApp = null } = {}) {
    const hotbarEl = (hotbarApp?.element instanceof HTMLElement)
      ? hotbarApp.element
      : (hotbarApp?.element?.[0] ?? document.getElementById('hotbar'));

    if (!hotbarEl) return;

    // IMPORTANT: insert INSIDE #hotbar. In Foundry core, #ui-bottom often has pointer-events: none;
    // only known UI elements (like #hotbar) re-enable pointer events. If we inject as a sibling,
    // the UI can become unclickable.
    const actionBar = hotbarEl.querySelector('#action-bar');
    const host = actionBar?.parentElement || hotbarEl;

    const seq = ++this._renderSeq;

    const ctx = await this._buildContext();

    // If no UI needed, remove existing.
    if (!ctx) {
      this.destroy();
      return;
    }

    // stale async guard
    if (seq !== this._renderSeq) return;

    const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, ctx);
    const wrap = document.createElement('div');
    wrap.innerHTML = String(html || '').trim();
    const nextEl = wrap.firstElementChild;
    if (!nextEl) return;

    // Ensure correct placement: inside hotbar, before action-bar (so it's next to it).
    const existing = this.element;
    if (existing) {
      try { existing.removeEventListener('click', this._onRootClick); } catch (_) {}
      try { existing.remove(); } catch (_) {}
    }

    if (actionBar && actionBar.parentElement) {
      actionBar.parentElement.insertBefore(nextEl, actionBar);
    } else {
      host.insertBefore(nextEl, host.firstChild);
    }

    nextEl.addEventListener('click', this._onRootClick);

    // Keep open state between re-renders.
    this._setOpen(nextEl, this.open);

    // Apply slot size for consistent visuals.
    this._applySlotSize(nextEl, hotbarEl);
  }

  destroy() {
    const el = this.element;
    if (!el) return;

    this._setOpen(el, false);

    try { el.removeEventListener('click', this._onRootClick); } catch (_) {}
    el.remove();
  }

  scheduleRender({ hotbarApp = null } = {}) {
    if (this._scheduled) {
      try { clearTimeout(this._scheduled); } catch (_) {}
      this._scheduled = null;
    }

    this._scheduled = setTimeout(() => {
      this._scheduled = null;
      this.render({ hotbarApp }).catch(() => {});
    }, 250);
  }

  async _onRootClick(ev) {
    const root = this.element;
    if (!root) return;

    const btn = ev.target?.closest?.('button[data-action]');
    if (!btn) return;

    const action = String(btn.dataset.action || '').trim();

    if (action === 'toggle') {
      ev.preventDefault();
      if (btn.disabled) return;
      this._setOpen(root, !this.open);
      return;
    }

    if (action === 'choose') {
      ev.preventDefault();

      const user = game?.user;
      if (!user) return;

      const uuid = String(btn.dataset.uuid ?? '').trim();

      // Players: allow only own factions. GM: allow any, plus empty (none).
      if (!user.isGM) {
        const allowed = getAllowedFactionUuidsForUser(user);
        const normalized = normalizeUuid(uuid);
        if (!normalized || !allowed.includes(normalized)) return;
        await setUserActiveFactionUuid(user, normalized);
      } else {
        // GM: empty means "none".
        if (!uuid) {
          await setUserActiveFactionUuid(user, '');
        } else {
          const allowed = getAllowedFactionUuidsForUser(user);
          const normalized = normalizeUuid(uuid);
          if (!normalized || !allowed.includes(normalized)) return;
          await setUserActiveFactionUuid(user, normalized);
        }
      }

      this._setOpen(root, false);
      this.scheduleRender();
    }
  }
}

export function installHotbarFactionUiHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  if (!_uiInstance) _uiInstance = new HotbarFactionUI();

  Hooks.once('ready', async () => {
    try {
      // Ensure players have an active faction stored (first available).
      await ensureUserActiveFaction(game?.user);
      _uiInstance.scheduleRender({ hotbarApp: ui?.hotbar });
    } catch (_) {
      // ignore
    }
  });

  Hooks.on('renderHotbar', async (app, _html /*, data */) => {
    try {
      await _uiInstance.render({ hotbarApp: app });
    } catch (_) {
      // ignore
    }
  });

  // Update when user factions / active faction change.
  Hooks.on('updateUser', async (user, changes) => {
    try {
      if (user?.id !== game?.user?.id) return;

      if (_areFactionsChanged(changes)) {
        await ensureUserActiveFaction(user);
      }

      if (!_areFactionsChanged(changes) && !_isActiveFactionChanged(changes)) return;

      _uiInstance.scheduleRender({ hotbarApp: ui?.hotbar });
    } catch (_) {
      // ignore
    }
  });

  // PP depends on journal pages (author/points/status) and on faction/globalobject actors.
  Hooks.on('updateActor', (actor) => {
    try {
      const t = String(actor?.type || '');
      if (t !== 'faction' && t !== 'globalobject') return;
      _uiInstance.scheduleRender({ hotbarApp: ui?.hotbar });
    } catch (_) {
      // ignore
    }
  });

  Hooks.on('updateJournalEntryPage', () => {
    try {
      if (!isProgressionEnabled()) return;
      _uiInstance.scheduleRender({ hotbarApp: ui?.hotbar });
    } catch (_) {
      // ignore
    }
  });

  // Global Objects spend points depend on tokens existing on Global Map scenes.
  const tokenBump = () => {
    try {
      if (!isProgressionEnabled()) return;
      _uiInstance.scheduleRender({ hotbarApp: ui?.hotbar });
    } catch (_) {
      // ignore
    }
  };

  Hooks.on('createToken', tokenBump);
  Hooks.on('updateToken', tokenBump);
  Hooks.on('deleteToken', tokenBump);
}

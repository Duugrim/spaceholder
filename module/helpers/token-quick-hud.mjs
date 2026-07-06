import { collectActorActions, executeActorAction, getActorActionPoints, openItemInteractMenu } from './actions/action-service.mjs';
import { getWeaponData, lineShotReadiness } from './weapon/weapon-ammo-runtime.mjs';
import { formatAmmoCounter } from './weapon/weapon-model.mjs';

const UI_ID = 'spaceholder-token-quick-hud';
const TEMPLATE_PATH = 'systems/spaceholder/templates/hud/token-quick-hud.hbs';
const ANCHOR_GAP_PX = 6;
const SEGMENT_EXPAND_MAX_VH = 0.5;

let _hooksInstalled = false;
let _uiInstance = null;

/** @type {{ sceneId: string, tokenId: string }} */
let _gmLastTokenRef = { sceneId: '', tokenId: '' };

function _t(key, data = undefined) {
  try {
    const i18n = game?.i18n;
    if (!i18n) return key;
    return data ? i18n.format(key, data) : i18n.localize(key);
  } catch (_) {
    return key;
  }
}

/**
 * @param {Token} token
 * @param {User} user
 * @returns {boolean}
 */
function _userOwnsToken(token, user) {
  if (!token || !user) return false;
  if (user.isGM) return true;

  const actor = token.actor;
  if (actor?.isOwner) return true;

  try {
    const level = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    return token.document?.testUserPermission?.(user, level) ?? false;
  } catch (_) {
    return false;
  }
}

/**
 * @param {Token} token
 */
function _rememberGmToken(token) {
  const user = game?.user;
  if (!user?.isGM || !token?.document) return;

  _gmLastTokenRef = {
    sceneId: String(token.document.parent?.id ?? canvas?.scene?.id ?? ''),
    tokenId: String(token.document.id ?? ''),
  };
}

/**
 * @returns {Token|null}
 */
function _resolveGmLastToken() {
  const { sceneId, tokenId } = _gmLastTokenRef;
  if (!sceneId || !tokenId) return null;
  if (String(canvas?.scene?.id ?? '') !== sceneId) return null;

  const doc = canvas?.scene?.tokens?.get?.(tokenId) ?? null;
  const token = doc?.object ?? null;
  return token?.actor ? token : null;
}

/**
 * @returns {Token|null}
 */
function _findCharacterFallbackToken(user) {
  const character = user?.character;
  if (!character) return null;

  const active = character.getActiveTokens?.(true, true) || [];
  const token = active[0] ?? null;
  if (token?.actor && _userOwnsToken(token, user)) return token;
  return null;
}

/**
 * @returns {{ token: Token, tokenDoc: TokenDocument, source: 'selected'|'fallback'|'lastSelected' }|null}
 */
function _resolveHudToken() {
  const user = game?.user;
  if (!user || !canvas?.ready) return null;

  const controlled = canvas.tokens?.controlled || [];
  for (let i = controlled.length - 1; i >= 0; i -= 1) {
    const token = controlled[i];
    if (!token?.actor) continue;
    if (_userOwnsToken(token, user)) {
      _rememberGmToken(token);
      return {
        token,
        tokenDoc: token.document,
        source: 'selected',
      };
    }
  }

  const characterToken = _findCharacterFallbackToken(user);
  if (characterToken) {
    return {
      token: characterToken,
      tokenDoc: characterToken.document,
      source: 'fallback',
    };
  }

  if (user.isGM) {
    const lastToken = _resolveGmLastToken();
    if (lastToken) {
      return {
        token: lastToken,
        tokenDoc: lastToken.document,
        source: 'lastSelected',
      };
    }
  }

  return null;
}

function _normalizeFavoriteActionIds(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => String(id ?? '').trim()).filter(Boolean);
}

function _formatApText(actor) {
  const ap = getActorActionPoints(actor);
  const current = Math.max(0, Number(ap?.value) || 0);
  const max = Math.max(0, Number(ap?.max) || 0);
  return max > 0 ? `${current}/${max}` : String(current);
}

/**
 * @param {ActionDescriptor} action
 * @param {import('./actions/action-service.mjs').ActionContext} ctx
 */
function _enrichActionForHud(action, ctx, isFavorite = false) {
  let enabled = true;
  let disabledReason = null;
  try {
    enabled = action.enabled ? action.enabled(ctx) : true;
    if (!enabled && action.disabledReason) {
      disabledReason = String(action.disabledReason(ctx) ?? '').trim() || null;
    }
  } catch (_) {
    enabled = false;
  }

  const label = String(action.label ?? '').trim();
  const tooltip = disabledReason || label;

  return {
    id: String(action.id ?? '').trim(),
    label,
    icon: String(action.icon ?? 'fa-solid fa-bolt').trim(),
    apCost: Math.max(0, Number(action.apCost) || 0),
    enabled,
    tooltip,
    isFavorite: !!isFavorite,
  };
}

function _buildHudActions(actions, favoriteIdList, ctx) {
  const favoriteSet = new Set(favoriteIdList);
  const actionById = new Map(
    (actions ?? []).map((a) => [String(a?.id ?? '').trim(), a])
  );
  const result = [];

  for (const id of favoriteIdList) {
    const action = actionById.get(id);
    if (action) result.push(_enrichActionForHud(action, ctx, true));
  }

  for (const action of actions ?? []) {
    const id = String(action?.id ?? '').trim();
    if (!id || favoriteSet.has(id)) continue;
    result.push(_enrichActionForHud(action, ctx, false));
  }

  return result;
}

/**
 * @param {Actor} actor
 */
function _collectHeldItems(actor) {
  const items = [];
  const actorItems = actor?.items ? Array.from(actor.items) : [];

  for (const item of actorItems) {
    if (item?.type !== 'item' || !item.system?.held) continue;

    const name = String(item.name ?? '').trim() || item.uuid;
    const img = String(item.img ?? '').trim();
    const isWeapon = !!item.system?.itemTags?.isWeapon;

    if (isWeapon) {
      const weapon = getWeaponData(item);
      const lines = Array.isArray(weapon.lines) ? weapon.lines : [];
      const activeLineId = weapon.state?.activeLineId || lines[0]?.id;
      const line = lines.find((l) => l.id === activeLineId) ?? lines[0];
      const readiness = line ? lineShotReadiness(weapon, line.id) : { ready: false };
      const counters = (line?.ammoBlocks ?? []).map((b) => formatAmmoCounter(b)).filter(Boolean);
      const counter = counters.join(' · ');
      const lineName = String(line?.name ?? '').trim();
      const detailParts = [];
      if (lineName) detailParts.push(lineName);
      if (counter) detailParts.push(counter);

      items.push({
        itemId: String(item.id ?? '').trim(),
        itemUuid: String(item.uuid ?? '').trim(),
        name,
        img,
        icon: 'fa-solid fa-gun',
        isWeapon: true,
        ready: !!readiness?.ready,
        detail: detailParts.join(' · '),
        tooltip: [name, lineName, counter].filter(Boolean).join(' — '),
      });
      continue;
    }

    items.push({
      itemId: String(item.id ?? '').trim(),
      itemUuid: String(item.uuid ?? '').trim(),
      name,
      img,
      icon: 'fa-solid fa-hand',
      isWeapon: false,
      ready: true,
      detail: '',
      tooltip: name,
    });
  }

  return items;
}

function _actionBelongsToItem(action, itemUuid) {
  const uuid = String(itemUuid ?? '').trim();
  if (!uuid) return true;
  return String(action?.id ?? '').startsWith(`item.${uuid}.`);
}

function _emptyContext() {
  return {
    isEmpty: true,
    actorName: _t('SPACEHOLDER.TokenQuickHud.NoToken'),
    tokenImg: '',
    showAp: false,
    apText: '',
    apTooltip: _t('SPACEHOLDER.ActionsSystem.UI.CurrentAP'),
    displayActions: [],
    hasActions: false,
    heldItems: [],
    hasHeldItems: false,
    noActionsLabel: _t('SPACEHOLDER.ActionsSystem.UI.NoActions'),
    noHeldLabel: _t('SPACEHOLDER.TokenQuickHud.NoHeldItems'),
    heldLabel: _t('SPACEHOLDER.TokenQuickHud.HeldItems'),
    expandLabel: _t('SPACEHOLDER.TokenQuickHud.ExpandSegment'),
    collapseLabel: _t('SPACEHOLDER.TokenQuickHud.CollapseSegment'),
    ariaLabel: _t('SPACEHOLDER.TokenQuickHud.AriaLabelEmpty'),
  };
}

class TokenQuickHud {
  constructor() {
    this._renderSeq = 0;
    this._scheduled = null;
    /** @type {Set<string>} */
    this._expandedSegments = new Set();
    this._segmentObservers = [];
    this._blockHeightObserver = null;
    /** @type {string|null} */
    this._selectedHeldItemId = null;
    /** @type {string|null} */
    this._lastActorId = null;
    this._onRootClick = this._onRootClick.bind(this);
    this._onRootContextMenu = this._onRootContextMenu.bind(this);
    this._onWindowResize = this._onWindowResize.bind(this);
  }

  get element() {
    return document.getElementById(UI_ID);
  }

  async _buildContext() {
    const resolved = _resolveHudToken();
    if (!resolved?.token?.actor) return _emptyContext();

    const { token, tokenDoc } = resolved;
    const actor = token.actor;
    const user = game?.user;
    const editable = !!actor?.isOwner || !!user?.isGM;

    const { context, actions } = collectActorActions(actor, { tokenDoc, editable });
    const favoriteIdList = _normalizeFavoriteActionIds(actor.getFlag?.('spaceholder', 'favoriteActionIds'));
    const heldItems = _collectHeldItems(actor);

    const actorId = String(actor.id ?? '').trim();
    if (this._lastActorId !== actorId) {
      this._selectedHeldItemId = null;
      this._lastActorId = actorId;
    }

    const heldById = new Map(heldItems.map((h) => [h.itemId, h]));
    if (this._selectedHeldItemId && !heldById.has(this._selectedHeldItemId)) {
      this._selectedHeldItemId = null;
    }

    const selectedUuid = this._selectedHeldItemId
      ? heldById.get(this._selectedHeldItemId)?.itemUuid ?? null
      : null;

    const filteredActions = selectedUuid
      ? actions.filter((a) => _actionBelongsToItem(a, selectedUuid))
      : actions;

    const displayActions = _buildHudActions(filteredActions, favoriteIdList, context);
    const displayHeldItems = heldItems.map((h) => ({
      ...h,
      isSelected: h.itemId === this._selectedHeldItemId,
    }));

    const tokenImg = String(tokenDoc?.texture?.src ?? actor.img ?? '').trim();
    const actorName = String(actor.name ?? tokenDoc?.name ?? '').trim();

    return {
      isEmpty: false,
      actorName,
      tokenImg,
      showAp: true,
      apText: _formatApText(actor),
      apTooltip: _t('SPACEHOLDER.ActionsSystem.UI.CurrentAP'),
      displayActions,
      hasActions: displayActions.length > 0,
      heldItems: displayHeldItems,
      hasHeldItems: displayHeldItems.length > 0,
      noActionsLabel: _t('SPACEHOLDER.ActionsSystem.UI.NoActions'),
      noHeldLabel: _t('SPACEHOLDER.TokenQuickHud.NoHeldItems'),
      heldLabel: _t('SPACEHOLDER.TokenQuickHud.HeldItems'),
      expandLabel: _t('SPACEHOLDER.TokenQuickHud.ExpandSegment'),
      collapseLabel: _t('SPACEHOLDER.TokenQuickHud.CollapseSegment'),
      ariaLabel: _t('SPACEHOLDER.TokenQuickHud.AriaLabel', { name: actorName }),
    };
  }

  _disconnectSegmentObservers() {
    for (const obs of this._segmentObservers) {
      try { obs.disconnect(); } catch (_) {}
    }
    this._segmentObservers = [];
    if (this._blockHeightObserver) {
      try { this._blockHeightObserver.disconnect(); } catch (_) {}
      this._blockHeightObserver = null;
    }
  }

  /**
   * @param {HTMLElement} root
   */
  _syncBlockHeights(root) {
    const stats = root.querySelector('.sh-token-quick-hud__stats-block');
    if (!stats) return;

    const height = Math.max(Math.round(stats.getBoundingClientRect().height), 0);
    if (height > 0) {
      root.style.setProperty('--sh-token-quick-hud-block-h', `${height}px`);
    } else {
      root.style.removeProperty('--sh-token-quick-hud-block-h');
    }
  }

  /**
   * @param {HTMLElement} root
   */
  _bindBlockHeightSync(root) {
    const stats = root.querySelector('.sh-token-quick-hud__stats-block');
    if (!stats) return;

    const sync = () => {
      this._syncBlockHeights(root);
      for (const block of root.querySelectorAll('[data-segment]')) {
        const body = block.querySelector('.sh-token-quick-hud__block-body');
        const toggle = block.querySelector('[data-action="toggle-segment"]');
        if (body && toggle) this._syncSegmentOverflow(block, body, toggle);
      }
    };

    requestAnimationFrame(sync);

    if (typeof ResizeObserver === 'function') {
      const obs = new ResizeObserver(() => sync());
      obs.observe(stats);
      this._blockHeightObserver = obs;
    }
  }

  /**
   * @param {HTMLElement} root
   */
  _bindSegments(root) {
    this._disconnectSegmentObservers();

    const blocks = root.querySelectorAll('[data-segment]');
    for (const block of blocks) {
      const key = String(block.dataset.segment ?? '').trim();
      if (!key) continue;

      if (this._expandedSegments.has(key)) {
        block.classList.add('is-expanded');
      } else {
        block.classList.remove('is-expanded');
      }

      const body = block.querySelector('.sh-token-quick-hud__block-body');
      const toggle = block.querySelector('[data-action="toggle-segment"]');
      if (!body || !toggle) continue;

      const sync = () => this._syncSegmentOverflow(block, body, toggle);
      requestAnimationFrame(sync);

      if (typeof ResizeObserver === 'function') {
        const obs = new ResizeObserver(() => sync());
        obs.observe(body);
        this._segmentObservers.push(obs);
      }
    }

    this._bindBlockHeightSync(root);
  }

  /**
   * @param {HTMLElement} block
   * @param {HTMLElement} body
   * @param {HTMLButtonElement} toggle
   */
  _syncSegmentOverflow(block, body, toggle) {
    const expanded = block.classList.contains('is-expanded');
    const expandCap = Math.floor(window.innerHeight * SEGMENT_EXPAND_MAX_VH);

    if (expanded) {
      body.style.maxHeight = 'none';
      const fullHeight = body.scrollHeight;
      const target = Math.min(fullHeight, expandCap);
      body.style.maxHeight = `${target}px`;
      toggle.hidden = false;
      toggle.dataset.tooltip = _t('SPACEHOLDER.TokenQuickHud.CollapseSegment');
      toggle.setAttribute('aria-label', _t('SPACEHOLDER.TokenQuickHud.CollapseSegment'));
      toggle.setAttribute('aria-expanded', 'true');
      return;
    }

    body.style.maxHeight = '';
    const overflow = body.scrollHeight > body.clientHeight + 1;
    toggle.hidden = !overflow;
    toggle.dataset.tooltip = _t('SPACEHOLDER.TokenQuickHud.ExpandSegment');
    toggle.setAttribute('aria-label', _t('SPACEHOLDER.TokenQuickHud.ExpandSegment'));
    toggle.setAttribute('aria-expanded', 'false');
  }

  /**
   * @param {HTMLElement|null} hotbarEl
   * @param {HTMLElement} panelEl
   */
  _syncAnchorPosition(hotbarEl, panelEl) {
    if (!panelEl) return;

    const hotbar = hotbarEl instanceof HTMLElement
      ? hotbarEl
      : document.getElementById('hotbar');

    panelEl.style.width = '';
    panelEl.style.maxWidth = '';

    if (!hotbar?.getBoundingClientRect) {
      panelEl.style.left = '50%';
      panelEl.style.bottom = '72px';
      panelEl.style.transform = 'translateX(-50%)';
      return;
    }

    const rect = hotbar.getBoundingClientRect();
    const centerX = rect.left + (rect.width / 2);
    const bottom = Math.max(0, window.innerHeight - rect.top + ANCHOR_GAP_PX);

    panelEl.style.left = `${centerX}px`;
    panelEl.style.bottom = `${bottom}px`;
    panelEl.style.transform = 'translateX(-50%)';
  }

  _onWindowResize() {
    const el = this.element;
    if (!el) return;
    this._syncAnchorPosition(document.getElementById('hotbar'), el);
    this._bindSegments(el);
  }

  async render({ hotbarApp = null } = {}) {
    const hotbarEl = (hotbarApp?.element instanceof HTMLElement)
      ? hotbarApp.element
      : (hotbarApp?.element?.[0] ?? document.getElementById('hotbar'));

    const seq = ++this._renderSeq;
    const ctx = await this._buildContext();

    if (seq !== this._renderSeq) return;

    const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, ctx);
    const wrap = document.createElement('div');
    wrap.innerHTML = String(html || '').trim();
    const nextEl = wrap.firstElementChild;
    if (!nextEl) return;

    this._disconnectSegmentObservers();

    const existing = this.element;
    if (existing) {
      try { existing.removeEventListener('click', this._onRootClick); } catch (_) {}
      try { existing.remove(); } catch (_) {}
    }

    document.body.appendChild(nextEl);
    nextEl.addEventListener('click', this._onRootClick);
    nextEl.addEventListener('contextmenu', this._onRootContextMenu);
    this._syncAnchorPosition(hotbarEl, nextEl);
    this._bindSegments(nextEl);
  }

  destroy() {
    const el = this.element;
    if (!el) return;
    this._disconnectSegmentObservers();
    try { el.removeEventListener('click', this._onRootClick); } catch (_) {}
    try { el.removeEventListener('contextmenu', this._onRootContextMenu); } catch (_) {}
    el.remove();
  }

  async _onRootContextMenu(ev) {
    const heldItemEl = ev.target?.closest?.('[data-action="select-held-item"]');
    if (!heldItemEl) return;
    ev.preventDefault();

    const resolved = _resolveHudToken();
    if (!resolved?.token?.actor) return;
    const { tokenDoc } = resolved;
    const actor = resolved.token.actor;
    const editable = !!actor?.isOwner || !!game.user?.isGM;
    const itemUuid = String(heldItemEl.dataset.itemUuid ?? '').trim();
    if (!itemUuid) return;

    let item = null;
    try {
      item = await fromUuid(itemUuid);
    } catch (_) {
      item = actor.items?.get?.(heldItemEl.dataset.itemId) ?? null;
    }
    if (!item) return;

    try {
      await openItemInteractMenu(actor, item, {
        tokenDoc,
        editable,
        event: ev,
        anchorElement: heldItemEl,
      });
      this.scheduleRender({ hotbarApp: ui?.hotbar });
    } catch (e) {
      console.error('SpaceHolder | token quick HUD item interact failed', e);
    }
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
    const toggleBtn = ev.target?.closest?.('button[data-action="toggle-segment"]');
    if (toggleBtn) {
      ev.preventDefault();
      const segment = toggleBtn.closest('[data-segment]');
      const key = String(segment?.dataset?.segment ?? '').trim();
      if (!segment || !key) return;

      if (segment.classList.contains('is-expanded')) {
        segment.classList.remove('is-expanded');
        this._expandedSegments.delete(key);
      } else {
        segment.classList.add('is-expanded');
        this._expandedSegments.add(key);
      }

      const body = segment.querySelector('.sh-token-quick-hud__block-body');
      if (body) this._syncSegmentOverflow(segment, body, toggleBtn);
      return;
    }

    const heldItemEl = ev.target?.closest?.('[data-action="select-held-item"]');
    if (heldItemEl) {
      ev.preventDefault();
      const itemId = String(heldItemEl.dataset.itemId ?? '').trim();
      if (!itemId) return;

      if (this._selectedHeldItemId === itemId) {
        this._selectedHeldItemId = null;
      } else {
        this._selectedHeldItemId = itemId;
      }

      this.scheduleRender({ hotbarApp: ui?.hotbar });
      return;
    }

    const btn = ev.target?.closest?.('button[data-action="run-action"]');
    if (!btn || btn.disabled) return;

    ev.preventDefault();

    const actionId = String(btn.dataset.actionId ?? '').trim();
    if (!actionId) return;

    const resolved = _resolveHudToken();
    if (!resolved?.token?.actor) return;

    const { tokenDoc } = resolved;
    const actor = resolved.token.actor;
    const editable = !!actor?.isOwner || !!game.user?.isGM;

    const { actions } = collectActorActions(actor, { tokenDoc, editable });
    const action = actions.find((a) => String(a?.id ?? '') === actionId);
    if (!action) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.ActionsSystem.Errors.ActionNotFound'));
      return;
    }

    try {
      await executeActorAction(actor, action, {
        tokenDoc,
        editable,
        event: ev,
        anchorElement: btn,
      });
      this.scheduleRender({ hotbarApp: ui?.hotbar });
    } catch (e) {
      console.error('SpaceHolder | token quick HUD action failed', e);
    }
  }
}

function _scheduleFromHotbar() {
  try {
    _uiInstance?.scheduleRender?.({ hotbarApp: ui?.hotbar });
  } catch (_) {
    // ignore
  }
}

/**
 * Install hooks for the token quick HUD above the hotbar.
 */
export function installTokenQuickHudHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  if (!_uiInstance) _uiInstance = new TokenQuickHud();

  window.addEventListener('resize', () => _uiInstance._onWindowResize());

  Hooks.once('ready', () => {
    _scheduleFromHotbar();
  });

  Hooks.on('renderHotbar', async (app) => {
    try {
      await _uiInstance.render({ hotbarApp: app });
    } catch (_) {
      // ignore
    }
  });

  Hooks.on('controlToken', (token, controlled) => {
    try {
      if (controlled && token?.actor && game?.user?.isGM) {
        _rememberGmToken(token);
      }
    } catch (_) {
      // ignore
    }
    _scheduleFromHotbar();
  });

  Hooks.on('canvasReady', _scheduleFromHotbar);
  Hooks.on('createToken', _scheduleFromHotbar);

  Hooks.on('updateToken', (doc) => {
    try {
      if (doc?.parent?.id !== canvas?.scene?.id) return;
      _scheduleFromHotbar();
    } catch (_) {
      // ignore
    }
  });

  Hooks.on('deleteToken', (doc) => {
    try {
      if (doc?.parent?.id !== canvas?.scene?.id) return;
      if (
        String(_gmLastTokenRef.sceneId) === String(doc?.parent?.id ?? '')
        && String(_gmLastTokenRef.tokenId) === String(doc?.id ?? '')
      ) {
        _gmLastTokenRef = { sceneId: '', tokenId: '' };
      }
      _scheduleFromHotbar();
    } catch (_) {
      // ignore
    }
  });

  Hooks.on('updateActor', (actor) => {
    try {
      const resolved = _resolveHudToken();
      if (!resolved?.token?.actor) return;
      if (String(actor?.id ?? '') !== String(resolved.token.actor.id ?? '')) return;
      _scheduleFromHotbar();
    } catch (_) {
      // ignore
    }
  });

  Hooks.on('updateItem', (item, changes) => {
    try {
      if (!changes?.system) return;
      const resolved = _resolveHudToken();
      const actor = resolved?.token?.actor;
      if (!actor || !item?.isEmbedded || item.parent?.id !== actor.id) return;
      _scheduleFromHotbar();
    } catch (_) {
      // ignore
    }
  });

  Hooks.on('updateUser', (user, changes) => {
    try {
      if (user?.id !== game?.user?.id) return;
      if (!changes || !('character' in changes)) return;
      _scheduleFromHotbar();
    } catch (_) {
      // ignore
    }
  });
}

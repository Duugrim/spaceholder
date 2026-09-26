import {
  ACTION_DRAG_TYPE,
  collectActorActions,
  executeActorAction,
  getActorActionPoints,
  getFavoriteActionIds,
  openItemInteractMenu,
  toggleFavoriteAction,
} from './actions/action-service.mjs';
import { getWeaponData, lineShotReadiness, syncExternalChargeHostedRuntime } from './weapon/weapon-ammo-runtime.mjs';
import { buildAmmoDisplay, listWeaponAttacks, resolveActiveWeaponAttack } from './weapon/weapon-model.mjs';
import { previewItemAttack, previewModeSwitchAp, switchWeaponMode } from './weapon/attack-chain.mjs';
import { openSimpleContextMenu } from './simple-context-menu.mjs';

const UI_ID = 'spaceholder-token-quick-hud';
const TEMPLATE_PATH = 'systems/spaceholder/templates/hud/token-quick-hud.hbs';
const ANCHOR_GAP_PX = 6;
const VIEWPORT_MARGIN_PX = 12;
const EFFECT_ICON_LIMIT = 6;
const SELECTION_FLAG = 'quickHudSelectedItemIds';
export const HIDE_HELD_ACTIONS_SETTING = 'tokenQuickHud.hideActionsOfHeldItems';

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

/**
 * @param {Actor|null|undefined} actor
 * @returns {boolean} whether the HUD currently shows this actor
 */
function _isHudActor(actor) {
  if (!actor) return false;
  const resolved = _resolveHudToken();
  const hudActor = resolved?.token?.actor;
  return !!hudActor && String(hudActor.id ?? '') === String(actor.id ?? '');
}

function _getApDisplay(actor) {
  const ap = getActorActionPoints(actor);
  const current = Math.max(0, Number(ap?.value) || 0);
  const max = Math.max(0, Number(ap?.max) || 0);
  return {
    text: max > 0 ? `${current}/${max}` : String(current),
    empty: current <= 0,
  };
}

function _actionBelongsToItem(action, itemUuid) {
  const uuid = String(itemUuid ?? '').trim();
  if (!uuid) return false;
  return String(action?.id ?? '').startsWith(`item.${uuid}.`);
}

/**
 * Partition by a set of item UUIDs so a later multi-weapon fire path can pass
 * more than one selected UUID without rewriting HUD filters.
 * @param {object} action
 * @param {Iterable<string>|Set<string>|string[]|null} itemUuids
 */
function _actionBelongsToAnyItem(action, itemUuids) {
  const ids = itemUuids instanceof Set ? itemUuids : new Set(itemUuids ?? []);
  for (const uuid of ids) {
    if (_actionBelongsToItem(action, uuid)) return true;
  }
  return false;
}

function _getCompactActionLabel(action, selectedHeldUuids = null) {
  const label = String(action?.label ?? '').trim();
  const sourceItemName = String(action?.sourceItemName ?? '').trim();
  if (!label || !sourceItemName || !_actionBelongsToAnyItem(action, selectedHeldUuids)) {
    return label;
  }

  const sourcePrefix = `${sourceItemName}:`;
  if (!label.startsWith(sourcePrefix)) return label;
  return label.slice(sourcePrefix.length).trim() || label;
}

/**
 * @param {Actor} actor
 * @returns {string[]} HUD-selected item ids (flag, selection order)
 */
function _getSelectedItemIds(actor) {
  const raw = actor?.getFlag?.('spaceholder', SELECTION_FLAG);
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => String(id ?? '').trim()).filter(Boolean);
}

export function getHideActionsOfHeldItems() {
  try {
    return game.settings.get('spaceholder', HIDE_HELD_ACTIONS_SETTING) !== false;
  } catch (_) {
    return true;
  }
}

export function registerTokenQuickHudSettings() {
  game.settings.register('spaceholder', HIDE_HELD_ACTIONS_SETTING, {
    name: 'SPACEHOLDER.TokenQuickHud.Settings.HideActionsOfHeldItems.Name',
    hint: 'SPACEHOLDER.TokenQuickHud.Settings.HideActionsOfHeldItems.Hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true,
    requiresReload: false,
    onChange: () => _scheduleFromHotbar(),
  });
}

/**
 * @param {ActionDescriptor} action
 * @param {import('./actions/action-service.mjs').ActionContext} ctx
 * @param {{ isFavorite?: boolean, selectedHeldUuids?: Set<string>|null, dragImg?: string }} [opts]
 */
function _enrichActionForHud(action, ctx, { isFavorite = false, selectedHeldUuids = null, dragImg = '' } = {}) {
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
    compactLabel: _getCompactActionLabel(action, selectedHeldUuids),
    icon: String(action.icon ?? 'fa-solid fa-bolt').trim(),
    apCost: Math.max(0, Number(action.apCost) || 0),
    enabled,
    tooltip,
    isFavorite: !!isFavorite,
    dragImg,
  };
}

/**
 * Favorites first (in favorite order), then the rest in collect order.
 * @param {ActionDescriptor[]} actions
 * @param {string[]} favoriteIdList
 * @param {object} ctx
 * @param {{ selectedHeldUuids?: Set<string>|null, dragImgFor?: (action: object) => string }} [opts]
 */
function _buildHudActions(actions, favoriteIdList, ctx, { selectedHeldUuids = null, dragImgFor = () => '' } = {}) {
  const favoriteSet = new Set(favoriteIdList);
  const actionById = new Map(
    (actions ?? []).map((a) => [String(a?.id ?? '').trim(), a])
  );
  const result = [];
  const enrich = (action, isFavorite) => _enrichActionForHud(action, ctx, {
    isFavorite,
    selectedHeldUuids,
    dragImg: dragImgFor(action),
  });

  for (const id of favoriteIdList) {
    const action = actionById.get(id);
    if (action) result.push(enrich(action, true));
  }

  for (const action of actions ?? []) {
    const id = String(action?.id ?? '').trim();
    if (!id || favoriteSet.has(id)) continue;
    result.push(enrich(action, false));
  }

  return result;
}

/**
 * HUD card for a held item or a quick-access item not in hands.
 * @param {Actor} actor
 * @param {Item} item
 * @param {{ isStowed: boolean }} opts
 */
function _buildItemCard(actor, item, { isStowed }) {
  const name = String(item.name ?? '').trim() || item.uuid;
  const isWeapon = !!item.system?.itemTags?.isWeapon;
  const card = {
    itemId: String(item.id ?? '').trim(),
    itemUuid: String(item.uuid ?? '').trim(),
    name,
    img: String(item.img ?? '').trim(),
    icon: isWeapon ? 'fa-solid fa-gun' : 'fa-solid fa-hand',
    isWeapon,
    canAttack: !!item.canAttack,
    isStowed,
    ready: true,
    modeLabel: '',
    ammo: [],
    tooltip: name,
    notReadyLabel: _t('SPACEHOLDER.TokenQuickHud.NotReady'),
  };

  if (isWeapon) {
    const weapon = getWeaponData(item);
    const attack = resolveActiveWeaponAttack(weapon);
    const line = attack.line;
    for (const block of line?.ammoBlocks ?? []) {
      syncExternalChargeHostedRuntime(actor, item, block);
    }
    const readiness = line ? lineShotReadiness(weapon, line.id, actor) : { ready: false };
    const ammo = (line?.ammoBlocks ?? [])
      .map((b) => buildAmmoDisplay(b, actor))
      .filter((d) => d.text)
      .map((d) => ({
        ...d,
        isBar: d.style === 'bar',
        isPips: d.style === 'pips',
      }));
    const lineName = String(line?.name ?? '').trim();
    const modeName = String(attack.mode?.name ?? '').trim();
    const modeParts = [];
    if (attack.hasMultipleLines && lineName) modeParts.push(lineName);
    if (attack.hasMultipleModes && modeName) modeParts.push(modeName);

    card.ready = !!readiness?.ready;
    card.modeLabel = modeParts.join(' · ');
    card.ammo = ammo;
    card.tooltip = [name, lineName, modeName, ammo.map((d) => d.text).join(' · ')].filter(Boolean).join(' — ');
  }

  if (isStowed) card.tooltip = `${card.tooltip} — ${_t('SPACEHOLDER.TokenQuickHud.StowedHint')}`;
  return card;
}

/**
 * Held items first, then attack-capable quick-access items not in hands.
 * @param {Actor} actor
 */
function _collectItemCards(actor) {
  const held = [];
  const stowed = [];
  const actorItems = actor?.items ? Array.from(actor.items) : [];

  for (const item of actorItems) {
    if (item?.type !== 'item') continue;
    if (item.system?.held) {
      held.push(_buildItemCard(actor, item, { isStowed: false }));
    } else if (item.system?.quickAccess && item.canAttack) {
      stowed.push(_buildItemCard(actor, item, { isStowed: true }));
    }
  }

  return { held, stowed };
}

/**
 * Line/mode selector groups for a weapon with more than one attack.
 * @param {Item} item
 */
function _buildModeSelector(item) {
  const weapon = getWeaponData(item);
  if (listWeaponAttacks(weapon).length < 2) return [];
  const active = resolveActiveWeaponAttack(weapon);
  const lines = (weapon.lines ?? []).filter((l) => (l.modes ?? []).length);
  const multiLine = lines.length > 1;
  const apShort = _t('SPACEHOLDER.WeaponV3.Chain.ApShort');

  return lines.map((line) => ({
    lineName: String(line.name || _t('SPACEHOLDER.WeaponV3.Line.Default')),
    showLineName: multiLine,
    modes: (line.modes ?? []).map((mode) => {
      const isActive = line.id === active.lineId && mode.id === active.modeId;
      const name = String(mode.name || _t('SPACEHOLDER.WeaponV3.Mode.Default'));
      const cost = isActive ? 0 : previewModeSwitchAp(item, line.id, mode.id);
      return {
        lineId: line.id,
        modeId: mode.id,
        name,
        isActive,
        tooltip: cost > 0 ? `${name} (${cost} ${apShort})` : name,
      };
    }),
  }));
}

/**
 * «Attack» button state for the selected attack-capable items.
 * @param {Actor} actor
 * @param {object[]} cards all HUD item cards
 * @param {object[]} selectedCards
 */
function _buildAttackContext(actor, cards, selectedCards) {
  const show = cards.some((c) => c.canAttack);
  const attackCards = selectedCards.filter((c) => c.canAttack);
  const base = {
    show,
    enabled: false,
    itemId: '',
    subtitle: '',
    apText: '',
    tooltip: '',
  };
  if (!show) return base;

  if (attackCards.length !== 1) {
    const key = attackCards.length
      ? 'SPACEHOLDER.TokenQuickHud.AttackMultiUnsupported'
      : 'SPACEHOLDER.TokenQuickHud.AttackNeedsSelection';
    return { ...base, subtitle: _t(key), tooltip: _t(key) };
  }

  const card = attackCards[0];
  const item = actor.items.get(card.itemId);
  const preview = previewItemAttack({ actor, item });
  const weapon = getWeaponData(item);
  const modeText = (weapon.lines ?? []).length > 1
    ? `${preview.lineName} / ${preview.modeName}`
    : preview.modeName;
  const subtitle = [card.name, modeText].filter(Boolean).join(' · ');
  if (!preview.ok) {
    const reason = _t(`SPACEHOLDER.WeaponV3.Chain.Blocked.${preview.reason ?? 'unknown'}`);
    return { ...base, itemId: card.itemId, subtitle, tooltip: reason };
  }

  const apText = `~${preview.totalAp}`;
  return {
    ...base,
    enabled: true,
    itemId: card.itemId,
    subtitle,
    apText,
    tooltip: _t('SPACEHOLDER.TokenQuickHud.AttackTooltip', {
      item: subtitle,
      ap: `${apText} ${_t('SPACEHOLDER.WeaponV3.Chain.ApShort')}`,
    }),
  };
}

/**
 * Active temporary effects (status icons) of the actor.
 * @param {Actor} actor
 */
function _collectEffectIcons(actor) {
  let effects = [];
  try {
    effects = Array.from(actor?.temporaryEffects ?? []);
  } catch (_) {
    effects = [];
  }
  const icons = effects
    .filter((e) => e && !e.disabled && !e.isSuppressed)
    .map((e) => ({ img: String(e.img ?? '').trim(), name: String(e.name ?? '').trim() }))
    .filter((e) => e.img);
  return {
    effects: icons.slice(0, EFFECT_ICON_LIMIT),
    effectsOverflow: Math.max(0, icons.length - EFFECT_ICON_LIMIT),
    effectsOverflowTooltip: icons.slice(EFFECT_ICON_LIMIT).map((e) => e.name).join(', '),
  };
}

function _emptyContext() {
  return {
    isEmpty: true,
    isExpanded: false,
    actorName: _t('SPACEHOLDER.TokenQuickHud.NoToken'),
    tokenImg: '',
    showAp: false,
    apText: '',
    apTooltip: _t('SPACEHOLDER.ActionsSystem.UI.CurrentAP'),
    ariaLabel: _t('SPACEHOLDER.TokenQuickHud.AriaLabelEmpty'),
  };
}

/**
 * @param {Element|null} el
 * @returns {{ action: string, actionId: string, itemId: string, modeId: string, scope: string }}
 */
function _focusKeyOf(el) {
  return {
    action: String(el?.dataset?.action ?? ''),
    actionId: String(el?.dataset?.actionId ?? ''),
    itemId: String(el?.dataset?.itemId ?? ''),
    modeId: String(el?.dataset?.modeId ?? ''),
    scope: String(el?.dataset?.focusScope ?? ''),
  };
}

class TokenQuickHud {
  constructor() {
    this._renderSeq = 0;
    this._scheduled = null;
    this._isExpanded = false;
    this._anchorResizeObserver = null;
    this._onRootClick = this._onRootClick.bind(this);
    this._onRootContextMenu = this._onRootContextMenu.bind(this);
    this._onRootKeydown = this._onRootKeydown.bind(this);
    this._onRootDragStart = this._onRootDragStart.bind(this);
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
    const favoriteIdList = getFavoriteActionIds(actor);
    const { held, stowed } = _collectItemCards(actor);
    const cards = [...held, ...stowed];
    const cardById = new Map(cards.map((c) => [c.itemId, c]));

    const selectedIds = _getSelectedItemIds(actor).filter((id) => cardById.has(id));
    const selectedSet = new Set(selectedIds);
    for (const card of cards) card.isSelected = selectedSet.has(card.itemId);
    const selectedCards = selectedIds.map((id) => cardById.get(id));

    const actorImg = String(actor.img ?? '').trim();
    const itemImgByUuid = new Map(
      Array.from(actor.items ?? []).map((i) => [String(i.uuid ?? ''), String(i.img ?? '').trim()])
    );
    const dragImgFor = (action) => {
      const id = String(action?.id ?? '');
      if (action?.source === 'item') {
        for (const [uuid, img] of itemImgByUuid) {
          if (img && id.startsWith(`item.${uuid}.`)) return img;
        }
      }
      return actorImg;
    };

    const quickbarActions = actions.filter((a) => a?.showInQuickbar !== false);
    const cardUuids = new Set(cards.map((c) => c.itemUuid).filter(Boolean));
    const generalSource = getHideActionsOfHeldItems()
      ? quickbarActions.filter((a) => !_actionBelongsToAnyItem(a, cardUuids))
      : quickbarActions;
    const generalActions = _buildHudActions(generalSource, favoriteIdList, context, { dragImgFor });

    const selectedGroups = selectedCards.map((card) => {
      const item = actor.items.get(card.itemId);
      const uuids = new Set([card.itemUuid]);
      const itemActions = _buildHudActions(
        quickbarActions.filter((a) => _actionBelongsToAnyItem(a, uuids)),
        favoriteIdList,
        context,
        { selectedHeldUuids: uuids, dragImgFor },
      );
      const modeLines = card.canAttack && item ? _buildModeSelector(item) : [];
      return {
        itemId: card.itemId,
        name: card.name,
        img: card.img,
        icon: card.icon,
        deselectLabel: _t('SPACEHOLDER.TokenQuickHud.DeselectItem', { name: card.name }),
        modeLines,
        hasModeSelector: modeLines.length > 0,
        actions: itemActions,
      };
    });

    const tokenImg = String(tokenDoc?.texture?.src ?? actor.img ?? '').trim();
    const actorName = String(actor.name ?? tokenDoc?.name ?? '').trim();
    const ap = _getApDisplay(actor);
    if (!generalActions.length) this._isExpanded = false;

    return {
      isEmpty: false,
      isExpanded: this._isExpanded,
      actorName,
      tokenImg,
      showAp: true,
      apText: ap.text,
      apEmpty: ap.empty,
      apTooltip: _t('SPACEHOLDER.ActionsSystem.UI.CurrentAP'),
      ..._collectEffectIcons(actor),
      canConfigureToken: !!tokenDoc?.isOwner,
      attack: _buildAttackContext(actor, cards, selectedCards),
      generalActions,
      hasActions: generalActions.length > 0,
      actionCount: generalActions.length,
      heldCards: held,
      stowedCards: stowed,
      hasCards: cards.length > 0,
      hasStowedCards: stowed.length > 0,
      selectedGroups,
      hasSelection: selectedGroups.length > 0,
      noActionsLabel: _t('SPACEHOLDER.ActionsSystem.UI.NoActions'),
      heldLabel: _t('SPACEHOLDER.TokenQuickHud.HeldItems'),
      selectedLabel: _t('SPACEHOLDER.TokenQuickHud.SelectedItems'),
      quickActionsLabel: _t('SPACEHOLDER.TokenQuickHud.QuickActions'),
      expandLabel: _t('SPACEHOLDER.TokenQuickHud.ExpandActions'),
      collapseLabel: _t('SPACEHOLDER.TokenQuickHud.CollapseActions'),
      viewPortraitLabel: _t('SPACEHOLDER.TokenQuickHud.ViewPortrait'),
      panToTokenLabel: _t('SPACEHOLDER.TokenQuickHud.PanToToken'),
      openSheetLabel: _t('SPACEHOLDER.TokenQuickHud.OpenSheet'),
      openTokenConfigLabel: _t('SPACEHOLDER.TokenQuickHud.OpenTokenConfig'),
      attackLabel: _t('SPACEHOLDER.TokenQuickHud.Attack'),
      ariaLabel: _t('SPACEHOLDER.TokenQuickHud.AriaLabel', { name: actorName }),
    };
  }

  _cancelScheduledRender() {
    if (!this._scheduled) return;
    try { clearTimeout(this._scheduled); } catch (_) {}
    this._scheduled = null;
  }

  _disconnectAnchorObserver() {
    if (!this._anchorResizeObserver) return;
    try { this._anchorResizeObserver.disconnect(); } catch (_) {}
    this._anchorResizeObserver = null;
  }

  /**
   * @param {HTMLElement|null} hotbarEl
   * @param {HTMLElement} panelEl
   */
  _bindAnchorObserver(hotbarEl, panelEl) {
    this._disconnectAnchorObserver();
    if (typeof ResizeObserver !== 'function' || !panelEl) return;

    const hotbar = hotbarEl instanceof HTMLElement
      ? hotbarEl
      : document.getElementById('hotbar');
    const actionBar = hotbar?.querySelector?.('#action-bar') ?? document.getElementById('action-bar');
    const preview = panelEl.querySelector('.sh-token-quick-hud__preview');

    const observer = new ResizeObserver(() => {
      if (!panelEl.isConnected) return;
      this._syncAnchorPosition(hotbar, panelEl);
      this._syncActionOverflow(panelEl);
    });

    if (hotbar instanceof HTMLElement) observer.observe(hotbar);
    if (actionBar instanceof HTMLElement && actionBar !== hotbar) observer.observe(actionBar);
    if (preview instanceof HTMLElement) observer.observe(preview);
    this._anchorResizeObserver = observer;
  }

  /**
   * @param {HTMLElement|null} root
   * @returns {ReturnType<typeof _focusKeyOf>|null}
   */
  _captureFocusKey(root) {
    const active = document.activeElement;
    if (!(root instanceof HTMLElement) || !(active instanceof HTMLElement) || !root.contains(active)) {
      return null;
    }

    const control = active.closest('[data-action]');
    if (!(control instanceof HTMLElement) || !root.contains(control)) return null;
    return _focusKeyOf(control);
  }

  /**
   * @param {HTMLElement} root
   * @param {Partial<ReturnType<typeof _focusKeyOf>>|null} key
   */
  _restoreFocus(root, key) {
    if (!key?.action || !(root instanceof HTMLElement)) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement
      && active !== document.body
      && !root.contains(active)
    ) {
      return;
    }

    const controls = Array.from(root.querySelectorAll('[data-action]'));
    const matches = (control, includeScope) => (
      control instanceof HTMLElement
      && !control.matches(':disabled')
      && !control.closest('[inert]')
      && String(control.dataset.action ?? '') === String(key.action ?? '')
      && (!key.actionId || String(control.dataset.actionId ?? '') === String(key.actionId))
      && (!key.itemId || String(control.dataset.itemId ?? '') === String(key.itemId))
      && (!key.modeId || String(control.dataset.modeId ?? '') === String(key.modeId))
      && (!includeScope || !key.scope || String(control.dataset.focusScope ?? '') === String(key.scope))
    );

    const target = controls.find((control) => matches(control, true))
      ?? controls.find((control) => matches(control, false))
      ?? root.querySelector('[data-action="select-held-item"]');

    if (target instanceof HTMLElement) {
      try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
    }
  }

  /**
   * Mark general action chips that do not fit the preview rows as clipped
   * (inert) and show the overflow count on the drawer toggle.
   * @param {HTMLElement} root
   */
  _syncActionOverflow(root) {
    const list = root?.querySelector?.('.sh-token-quick-hud__preview');
    const toggle = root?.querySelector?.('[data-action="toggle-drawer"]');
    if (!(list instanceof HTMLElement)) return;

    const chips = Array.from(list.querySelectorAll(':scope > .sh-action-chip'));
    const listTop = list.getBoundingClientRect().top;
    const visibleBottom = list.clientHeight + 1;
    let clipped = 0;
    for (const chip of chips) {
      const isClipped = chip.getBoundingClientRect().bottom - listTop > visibleBottom;
      chip.classList.toggle('is-clipped', isClipped);
      chip.toggleAttribute('inert', isClipped);
      if (isClipped) clipped += 1;
    }

    if (!(toggle instanceof HTMLElement)) return;
    const count = toggle.querySelector('.sh-token-quick-hud__overflow-count');
    if (count) count.textContent = clipped > 0 ? `+${clipped}` : '';
    const canExpand = clipped > 0 || this._isExpanded;
    toggle.hidden = !canExpand;
  }

  /**
   * @param {HTMLElement} root
   * @param {boolean} expanded
   * @param {{ focusToggle?: boolean }} [options]
   */
  _setDrawerExpanded(root, expanded, { focusToggle = false } = {}) {
    if (!(root instanceof HTMLElement)) return;

    const drawer = root.querySelector('.sh-token-quick-hud__drawer');
    const toggle = root.querySelector('[data-action="toggle-drawer"]');
    this._isExpanded = !!expanded && drawer instanceof HTMLElement && toggle instanceof HTMLElement;
    root.dataset.expanded = this._isExpanded ? 'true' : 'false';

    if (drawer instanceof HTMLElement) {
      drawer.setAttribute('aria-hidden', this._isExpanded ? 'false' : 'true');
      drawer.toggleAttribute('inert', !this._isExpanded);
      drawer.toggleAttribute('hidden', !this._isExpanded);
    }

    if (toggle instanceof HTMLElement) {
      const label = _t(this._isExpanded
        ? 'SPACEHOLDER.TokenQuickHud.CollapseActions'
        : 'SPACEHOLDER.TokenQuickHud.ExpandActions');
      toggle.setAttribute('aria-expanded', this._isExpanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', label);
      toggle.dataset.tooltip = label;
      if (focusToggle) {
        try { toggle.focus({ preventScroll: true }); } catch (_) { toggle.focus(); }
      }
    }
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
    const actionBar = hotbar?.querySelector?.('#action-bar') ?? document.getElementById('action-bar');
    const anchor = actionBar instanceof HTMLElement ? actionBar : hotbar;

    if (!hotbar?.getBoundingClientRect || !anchor?.getBoundingClientRect) {
      panelEl.style.left = '50%';
      panelEl.style.bottom = '72px';
      panelEl.style.transform = 'translateX(-50%)';
      return;
    }

    const hotbarRect = hotbar.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    if (!panelEl.classList.contains('is-empty') && anchorRect.width > 0) {
      panelEl.style.setProperty('--sh-token-quick-hud-anchor-width', `${Math.round(anchorRect.width)}px`);
    } else {
      panelEl.style.removeProperty('--sh-token-quick-hud-anchor-width');
    }
    const panelWidth = Math.max(0, panelEl.getBoundingClientRect().width);
    const idealCenterX = anchorRect.left + (anchorRect.width / 2);
    const minCenterX = VIEWPORT_MARGIN_PX + (panelWidth / 2);
    const maxCenterX = window.innerWidth - VIEWPORT_MARGIN_PX - (panelWidth / 2);
    const centerX = minCenterX <= maxCenterX
      ? Math.min(Math.max(idealCenterX, minCenterX), maxCenterX)
      : window.innerWidth / 2;
    const bottom = Math.max(0, window.innerHeight - hotbarRect.top + ANCHOR_GAP_PX);

    panelEl.style.left = `${centerX}px`;
    panelEl.style.bottom = `${bottom}px`;
    panelEl.style.transform = 'translateX(-50%)';
  }

  _onWindowResize() {
    const el = this.element;
    if (!el) return;
    this._syncAnchorPosition(document.getElementById('hotbar'), el);
    this._syncActionOverflow(el);
  }

  _detachRootListeners(el) {
    if (!el) return;
    try { el.removeEventListener('click', this._onRootClick); } catch (_) {}
    try { el.removeEventListener('contextmenu', this._onRootContextMenu); } catch (_) {}
    try { el.removeEventListener('keydown', this._onRootKeydown); } catch (_) {}
    try { el.removeEventListener('dragstart', this._onRootDragStart); } catch (_) {}
  }

  async render({ hotbarApp = null, focusKey = null } = {}) {
    const hotbarEl = (hotbarApp?.element instanceof HTMLElement)
      ? hotbarApp.element
      : (hotbarApp?.element?.[0] ?? document.getElementById('hotbar'));
    const initialExisting = this.element;
    const restoreFocusKey = focusKey ?? this._captureFocusKey(initialExisting);

    const seq = ++this._renderSeq;
    const ctx = await this._buildContext();

    if (seq !== this._renderSeq) return;

    const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, ctx);
    if (seq !== this._renderSeq) return;

    const wrap = document.createElement('div');
    wrap.innerHTML = String(html || '').trim();
    const nextEl = wrap.firstElementChild;
    if (!nextEl) return;

    this._disconnectAnchorObserver();

    const existing = this.element;
    if (existing) {
      this._detachRootListeners(existing);
      try { existing.replaceWith(nextEl); } catch (_) {
        try { existing.remove(); } catch (_) {}
        document.body.appendChild(nextEl);
      }
    } else {
      document.body.appendChild(nextEl);
    }

    nextEl.addEventListener('click', this._onRootClick);
    nextEl.addEventListener('contextmenu', this._onRootContextMenu);
    nextEl.addEventListener('keydown', this._onRootKeydown);
    nextEl.addEventListener('dragstart', this._onRootDragStart);
    this._setDrawerExpanded(nextEl, this._isExpanded);
    this._syncAnchorPosition(hotbarEl, nextEl);
    this._syncActionOverflow(nextEl);
    this._bindAnchorObserver(hotbarEl, nextEl);

    requestAnimationFrame(() => {
      if (!nextEl.isConnected) return;
      this._syncAnchorPosition(hotbarEl, nextEl);
      this._syncActionOverflow(nextEl);
      this._restoreFocus(nextEl, restoreFocusKey);
    });
  }

  destroy() {
    this._cancelScheduledRender();
    this._disconnectAnchorObserver();
    const el = this.element;
    if (!el) return;
    this._detachRootListeners(el);
    el.remove();
  }

  /**
   * @returns {{ token: Token, tokenDoc: TokenDocument, actor: Actor, editable: boolean }|null}
   */
  _resolveActorContext() {
    const resolved = _resolveHudToken();
    const actor = resolved?.token?.actor;
    if (!actor) return null;
    return {
      token: resolved.token,
      tokenDoc: resolved.tokenDoc,
      actor,
      editable: !!actor.isOwner || !!game.user?.isGM,
    };
  }

  async _openHeldItemMenu(heldItemEl, ev, anchorElement = heldItemEl) {
    if (!(heldItemEl instanceof HTMLElement)) return;
    const resolved = this._resolveActorContext();
    if (!resolved) return;

    const { tokenDoc, actor, editable } = resolved;
    const itemUuid = String(heldItemEl.dataset.itemUuid ?? '').trim();
    const itemId = String(heldItemEl.dataset.itemId ?? '').trim();
    if (!itemUuid) return;

    let item = null;
    try {
      item = await fromUuid(itemUuid);
    } catch (_) {}
    if (!item) item = actor.items?.get?.(itemId) ?? null;
    if (!item) return;

    try {
      // Keyboard «menu» key has no pointer coordinates — anchor to the card.
      const menuEvent = (!ev?.clientX && !ev?.clientY) ? null : ev;
      await openItemInteractMenu(actor, item, {
        tokenDoc,
        editable,
        event: menuEvent,
        anchorElement,
      });
      await this._renderImmediately({
        action: 'select-held-item',
        itemId,
        scope: 'held',
      });
    } catch (e) {
      console.error('SpaceHolder | token quick HUD item interact failed', e);
    }
  }

  /**
   * RMB on an action chip: favorites toggle.
   * @param {HTMLElement} btn run-action button
   * @param {MouseEvent} ev
   */
  _openActionMenu(btn, ev) {
    const resolved = this._resolveActorContext();
    if (!resolved?.editable) return;
    const { actor } = resolved;
    const actionId = String(btn.dataset.actionId ?? '').trim();
    if (!actionId) return;

    const isFavorite = getFavoriteActionIds(actor).includes(actionId);
    const focusKey = _focusKeyOf(btn);
    openSimpleContextMenu(ev, {
      title: String(btn.getAttribute('aria-label') ?? '').trim(),
      anchorElement: btn,
      items: [{
        id: 'favorite',
        label: _t(isFavorite ? 'SPACEHOLDER.ActionsSystem.UI.FavoriteRemove' : 'SPACEHOLDER.ActionsSystem.UI.FavoriteAdd'),
        icon: isFavorite ? 'fa-regular fa-star' : 'fa-solid fa-star',
        run: async () => {
          await toggleFavoriteAction(actor, actionId);
          await this._renderImmediately(focusKey);
        },
      }],
    });
  }

  async _onRootContextMenu(ev) {
    const actionBtn = ev.target?.closest?.('button[data-action="run-action"]');
    if (actionBtn) {
      ev.preventDefault();
      this._openActionMenu(actionBtn, ev);
      return;
    }

    const heldItemEl = ev.target?.closest?.('[data-held-item]');
    if (!heldItemEl) return;
    ev.preventDefault();
    await this._openHeldItemMenu(heldItemEl, ev, heldItemEl);
  }

  _onRootKeydown(ev) {
    if (ev.key !== 'Escape' || !this._isExpanded) return;
    const root = ev.currentTarget;
    if (!(root instanceof HTMLElement)) return;
    ev.preventDefault();
    ev.stopPropagation();
    this._setDrawerExpanded(root, false, { focusToggle: true });
  }

  /**
   * Action chips drag onto the macro hotbar (see `createActorActionMacro`).
   * @param {DragEvent} ev
   */
  _onRootDragStart(ev) {
    const chip = ev.target?.closest?.('.sh-action-chip[data-drag-action-id]');
    if (!chip || !ev.dataTransfer) return;
    const resolved = this._resolveActorContext();
    if (!resolved) return;

    const data = {
      type: ACTION_DRAG_TYPE,
      actorUuid: resolved.actor.uuid,
      actionId: String(chip.dataset.dragActionId ?? ''),
      label: String(chip.dataset.dragLabel ?? ''),
      img: String(chip.dataset.dragImg ?? ''),
    };
    ev.dataTransfer.setData('text/plain', JSON.stringify(data));
    ev.dataTransfer.effectAllowed = 'copy';
  }

  async _renderImmediately(focusKey = null) {
    this._cancelScheduledRender();
    await this.render({ hotbarApp: ui?.hotbar, focusKey });
  }

  scheduleRender({ hotbarApp = null } = {}) {
    this._cancelScheduledRender();

    this._scheduled = setTimeout(() => {
      this._scheduled = null;
      this.render({ hotbarApp }).catch(() => {});
    }, 250);
  }

  /**
   * Toggle an item in the HUD selection (actor flag).
   * @param {Actor} actor
   * @param {string} itemId
   * @param {boolean|null} [force] true = add, false = remove, null = toggle
   */
  async _setItemSelected(actor, itemId, force = null) {
    const current = _getSelectedItemIds(actor).filter((id) => actor.items?.has?.(id));
    const has = current.includes(itemId);
    const select = force === null ? !has : !!force;
    if (select === has) return;
    const next = select ? [...current, itemId] : current.filter((id) => id !== itemId);
    await actor.setFlag('spaceholder', SELECTION_FLAG, next);
  }

  async _onIdentityAction(action, resolved) {
    const { token, tokenDoc, actor } = resolved;
    switch (action) {
      case 'view-portrait': {
        const src = String(actor.img ?? '').trim() || String(tokenDoc?.texture?.src ?? '').trim();
        if (!src) return;
        const Popout = foundry.applications?.apps?.ImagePopout;
        if (Popout) {
          new Popout({ src, uuid: actor.uuid, window: { title: actor.name } }).render({ force: true });
        } else {
          new ImagePopout(src, { title: actor.name, uuid: actor.uuid }).render(true);
        }
        return;
      }
      case 'pan-to-token': {
        const center = token?.center;
        if (center) await canvas.animatePan({ x: center.x, y: center.y });
        return;
      }
      case 'open-sheet':
        actor.sheet?.render(true);
        return;
      case 'open-token-config':
        tokenDoc?.sheet?.render(true);
        return;
      default:
    }
  }

  async _onRootClick(ev) {
    const root = ev.currentTarget;
    if (!(root instanceof HTMLElement)) return;

    const control = ev.target?.closest?.('button[data-action]');
    if (!control || !root.contains(control) || control.disabled) return;
    if (control.getAttribute('aria-disabled') === 'true') return;
    const action = String(control.dataset.action ?? '');

    if (action === 'toggle-drawer') {
      ev.preventDefault();
      this._setDrawerExpanded(root, !this._isExpanded);
      this._syncActionOverflow(root);
      return;
    }

    const resolved = this._resolveActorContext();
    if (!resolved) return;
    const { actor, tokenDoc, editable } = resolved;
    const itemId = String(control.dataset.itemId ?? '').trim();

    try {
      switch (action) {
        case 'view-portrait':
        case 'pan-to-token':
        case 'open-sheet':
        case 'open-token-config':
          ev.preventDefault();
          await this._onIdentityAction(action, resolved);
          return;

        case 'select-held-item':
        case 'deselect-item': {
          ev.preventDefault();
          if (!itemId || !editable) return;
          await this._setItemSelected(actor, itemId, action === 'deselect-item' ? false : null);
          await this._renderImmediately({ action: 'select-held-item', itemId, scope: 'held' });
          return;
        }

        case 'switch-mode': {
          ev.preventDefault();
          const item = actor.items.get(itemId);
          if (!item || !editable) return;
          await switchWeaponMode({
            actor,
            weaponItem: item,
            lineId: String(control.dataset.lineId ?? ''),
            modeId: String(control.dataset.modeId ?? ''),
          });
          await this._renderImmediately(_focusKeyOf(control));
          return;
        }

        case 'attack': {
          ev.preventDefault();
          const item = actor.items.get(itemId);
          if (!item?.canAttack) return;
          await item.attack({ token: resolved.token });
          await this._renderImmediately({ action: 'attack', scope: 'dock' });
          return;
        }

        case 'run-action': {
          ev.preventDefault();
          const actionId = String(control.dataset.actionId ?? '').trim();
          if (!actionId) return;
          const { actions } = collectActorActions(actor, { tokenDoc, editable });
          const found = actions.find((a) => String(a?.id ?? '') === actionId);
          if (!found) {
            ui.notifications?.warn?.(_t('SPACEHOLDER.ActionsSystem.Errors.ActionNotFound'));
            return;
          }
          await executeActorAction(actor, found, {
            tokenDoc,
            editable,
            event: ev,
            anchorElement: control,
          });
          await this._renderImmediately(_focusKeyOf(control));
          return;
        }

        default:
      }
    } catch (e) {
      console.error(`SpaceHolder | token quick HUD "${action}" failed`, e);
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
 * Schedule a render when the document belongs to the HUD actor.
 * @param {Actor|null|undefined} actor
 */
function _scheduleForActor(actor) {
  try {
    if (_isHudActor(actor)) _scheduleFromHotbar();
  } catch (_) {
    // ignore
  }
}

/**
 * Owning actor of an embedded Item or of an ActiveEffect (on actor or item).
 * @param {foundry.abstract.Document} doc
 * @returns {Actor|null}
 */
function _owningActor(doc) {
  let parent = doc?.parent ?? null;
  while (parent && !(parent instanceof Actor)) parent = parent.parent ?? null;
  return parent;
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

  Hooks.on('updateActor', (actor) => _scheduleForActor(actor));

  // Embedded items: pickup/drop create/delete, any change (name, img, system, flags).
  for (const hook of ['createItem', 'updateItem', 'deleteItem']) {
    Hooks.on(hook, (item) => _scheduleForActor(_owningActor(item)));
  }

  // Status/effect icons.
  for (const hook of ['createActiveEffect', 'updateActiveEffect', 'deleteActiveEffect']) {
    Hooks.on(hook, (effect) => _scheduleForActor(_owningActor(effect)));
  }

  // `showInCombat` filtering depends on whether a combat is running.
  Hooks.on('updateCombat', _scheduleFromHotbar);
  Hooks.on('deleteCombat', _scheduleFromHotbar);

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

import {
  onManageActiveEffect,
  prepareActiveEffectCategories,
} from '../helpers/effects.mjs';
import { enrichHTMLWithFactionIcons } from '../helpers/faction-display.mjs';
import { anatomyManager } from '../anatomy-manager.mjs';
import { pickIcon } from '../helpers/icon-picker/icon-picker.mjs';
import { migrateItemWeaponData } from '../documents/item.mjs';
import { materialsManager } from '../helpers/damage/materials-manager.mjs';
import {
  addItemToNestedStorage,
  deleteNestedItemFromStorage,
  extractNestedItemToActor,
  getNestedStorage,
  normalizeNestedStorage,
} from '../helpers/item-nested-storage.mjs';
import {
  AMMO_BLOCK_TYPES,
  AMMO_BLOCK_TYPE_LIST,
  AMMO_SEARCH_MODES,
  FIRE_MODES,
  MOD_OPS,
  MODE_MODIFIER_PARAMS,
  WEAPON_DAMAGE_BLOCK_TYPES,
  createAmmoBlock,
  createModeModifier,
  createWeaponLine,
  createWeaponMode,
  defaultDamageEntry,
  compatMatches,
  computeProjectileEnergy,
  fireDelayToRpm,
  formatAmmoCounter,
  normalizeAmmoConfig,
} from '../helpers/weapon/weapon-model.mjs';
import {
  TRAJECTORY_KINDS,
  TRAJECTORY_LENGTH_UNITS,
  formatTrajectorySummary,
  normalizeTrajectoryKind,
} from '../helpers/weapon/trajectory.mjs';
import {
  ENTRY_ACTOR_ITEM,
  ENTRY_WORLD_UUID,
  addWorldUuidToContainer,
  checkActorContainerCapacity,
  moveActorItemIntoContainer,
  normalizeItemContainerFields,
  pruneBrokenWorldUuidLinks,
  refreshContainerState,
  removeActorItemFromContainer,
  removeWorldUuidFromContainer,
  rerenderOpenContainerRelatedSheets,
  setContainerContentsOrder,
  setWorldContainerContentsOrder,
  wouldCreateItemContainerCycle,
} from '../helpers/item-container.mjs';

/**
 * Build a short human-readable summary of armor layers for a coverage entry.
 * Example: "3mm Steel Plate, 5mm Kevlar Weave".
 *
 * @param {Array<Object>|undefined} layers
 * @returns {string}
 */
function formatCoverageLayersSummary(layers) {
  if (!Array.isArray(layers) || !layers.length) return '';
  return layers.map((layer) => {
    const thickness = Number(layer?.thickness);
    const slug = String(layer?.material ?? '').trim();
    if (!slug || !Number.isFinite(thickness) || thickness <= 0) return '';
    const md = materialsManager?.getMaterial?.(slug);
    const localized = md?.nameLocalized ? game.i18n?.localize?.(md.nameLocalized) : '';
    const name = (localized && localized !== md?.nameLocalized) ? localized : (md?.name || slug);
    const t = Math.round(thickness * 100) / 100;
    return `${t}mm ${name}`;
  }).filter(Boolean).join(', ');
}
/**
 * Вкладки оружия на листе предмета правят только `system.weapon` (авторинг данных).
 * Подсистемы стрельбы / боя / `action-service` на этом этапе эти поля не используют.
 */

const ITEM_SHEET_TAB_META = Object.freeze({
  description: { icon: 'fas fa-file-lines', labelKey: 'SPACEHOLDER.Tabs.Description' },
  attributes: { icon: 'fas fa-sliders', labelKey: 'SPACEHOLDER.Tabs.Attributes' },
  actions: { icon: 'fas fa-bolt', labelKey: 'SPACEHOLDER.ActionsSystem.UI.ActionsTab' },
  effects: { icon: 'fas fa-wand-magic-sparkles', labelKey: 'SPACEHOLDER.Tabs.Effects' },
  tags: { icon: 'fas fa-tags', labelKey: 'SPACEHOLDER.Tabs.Tags' },
  modifiers: { icon: 'fas fa-dumbbell', labelKey: 'SPACEHOLDER.Tabs.Modifiers' },
  weapon: { icon: 'fas fa-crosshairs', labelKey: 'SPACEHOLDER.WeaponV3.Tab' },
  ammo: { icon: 'fas fa-bullseye', labelKey: 'SPACEHOLDER.Tabs.Ammo' },
  container: { icon: 'fas fa-box-open', labelKey: 'SPACEHOLDER.ItemContainer.Tab' },
});

/**
 * @param {string[]} tabIds
 * @param {Record<string, { icon: string, labelKey: string }>} [overrides]
 */
function buildItemSheetPrimaryTabs(tabIds, overrides = {}) {
  const out = [];
  for (const id of tabIds) {
    const row = overrides[id] || ITEM_SHEET_TAB_META[id];
    if (row) out.push({ id, icon: row.icon, labelKey: row.labelKey });
  }
  return Object.freeze(out);
}

const WEAPON_V3_DIALOG_EDIT_TEMPLATES = Object.freeze({
  ergonomics: 'systems/spaceholder/templates/item/parts/item-weapon-v3-edit-ergonomics.hbs',
  line: 'systems/spaceholder/templates/item/parts/item-weapon-v3-edit-line.hbs',
  blocks: 'systems/spaceholder/templates/item/parts/item-weapon-v3-edit-blocks.hbs',
  modes: 'systems/spaceholder/templates/item/parts/item-weapon-v3-edit-modes.hbs',
});

const WEAPON_V3_DIALOG_TITLE_KEYS = Object.freeze({
  ergonomics: 'SPACEHOLDER.WeaponV3.Dialog.ErgonomicsTitle',
  line: 'SPACEHOLDER.WeaponV3.Dialog.LineTitle',
  blocks: 'SPACEHOLDER.WeaponV3.Dialog.BlocksTitle',
  modes: 'SPACEHOLDER.WeaponV3.Dialog.ModesTitle',
});

/** @param {boolean} v @returns {string} */
function _wv3FmtBool(v) {
  return v
    ? game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.Yes') ?? 'Yes'
    : game.i18n?.localize?.('SPACEHOLDER.ItemWeapon.No') ?? 'No';
}

/** @param {*} v @returns {string} */
function _wv3FmtText(v) {
  const s = String(v ?? '').trim();
  return s.length ? s : '—';
}

/** @param {*} v @returns {string} */
function _wv3FmtNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

/** @param {*} v @returns {string} */
function _wv3FmtPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${_wv3FmtNumber(n)}%`;
}

/**
 * @param {{ enabled?: boolean, value?: number }} [tog]
 * @param {string} [suffix]
 * @returns {string}
 */
function _wv3FmtToggleable(tog, suffix = '') {
  if (!tog?.enabled) return _wv3FmtBool(false);
  const n = _wv3FmtNumber(tog.value);
  return suffix ? `${n}${suffix}` : n;
}

/**
 * @param {object} [z]
 * @returns {string}
 */
function _wv3FmtZones(z) {
  if (!z?.enabled) return _wv3FmtBool(false);
  return `G${_wv3FmtNumber(z.green)} Y${_wv3FmtNumber(z.yellow)} O${_wv3FmtNumber(z.orange)} R${_wv3FmtNumber(z.red)}`;
}

/**
 * @param {{ rows?: Array<{ damageType?: string, damage?: number, energy?: number }> }} [dmgCtx]
 * @returns {string}
 */
function _wv3FmtDamageSummary(dmgCtx) {
  if (!dmgCtx?.rows?.length) return '';
  return dmgCtx.rows
    .map((r) => `${_wv3FmtText(r.damageType)}: ${_wv3FmtNumber(r.damage)} (⚡${_wv3FmtNumber(r.energy)})`)
    .join('; ');
}

const ITEM_TYPE_LABEL_KEYS = Object.freeze({
  item: 'SPACEHOLDER.ItemTypes.Item',
  feature: 'SPACEHOLDER.ItemTypes.Feature',
  spell: 'SPACEHOLDER.ItemTypes.Spell',
  material: 'SPACEHOLDER.ItemTypes.Material',
});

const ITEM_TYPE_ICON_CLASS = Object.freeze({
  item: 'fa-solid fa-box',
  feature: 'fa-solid fa-star',
  spell: 'fa-solid fa-wand-magic-sparkles',
  material: 'fa-solid fa-cubes-stacked',
});

const MATERIAL_CATEGORY_OPTIONS = Object.freeze([
  { id: 'metal', labelKey: 'SPACEHOLDER.Materials.Categories.Metal' },
  { id: 'fabric', labelKey: 'SPACEHOLDER.Materials.Categories.Fabric' },
  { id: 'ceramic', labelKey: 'SPACEHOLDER.Materials.Categories.Ceramic' },
  { id: 'composite', labelKey: 'SPACEHOLDER.Materials.Categories.Composite' },
  { id: 'ablative', labelKey: 'SPACEHOLDER.Materials.Categories.Ablative' },
  { id: 'exotic', labelKey: 'SPACEHOLDER.Materials.Categories.Exotic' },
]);

const ITEM_ACTION_MODE_LABEL_KEYS = Object.freeze({
  chat: 'SPACEHOLDER.ActionsSystem.UI.ModeChat',
  itemRoll: 'SPACEHOLDER.ActionsSystem.UI.ModeItemRoll',
  macro: 'SPACEHOLDER.ActionsSystem.UI.ModeMacro',
  aimShot: 'SPACEHOLDER.ActionsSystem.UI.ModeAimShot',
});

// Base V2 Item Sheet with Handlebars rendering
export class SpaceHolderBaseItemSheet extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.sheets.ItemSheet
) {
  static DEFAULT_OPTIONS = {
    classes: ['spaceholder', 'sheet', 'item'],
    position: { width: 520, height: 480 },
    window: {
      resizable: true,
      contentClasses: ['standard-form'],
    },
    form: {
      submitOnChange: true,
    },
  };

  // Native tabs configuration (Application V2)
  static TABS = {
    primary: {
      tabs: [
        { id: 'description' },
        { id: 'attributes' },
        { id: 'actions' },
        { id: 'effects' }
      ],
      initial: 'description'
    }
  };

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    const tabId = this._activeTabPrimary ?? this.tabGroups?.primary ?? 'description';
    try { this.changeTab(tabId, 'primary', { updatePosition: false }); } catch (e) { /* ignore */ }
  }

  /** Сохраняем активную вкладку при переключении (как в листе персонажа). */
  changeTab(tab, group, options = {}) {
    if (group === 'primary') this._activeTabPrimary = tab;
    return super.changeTab(tab, group, options);
  }

  /** @inheritDoc */
  _configureRenderOptions(options) {
    super._configureRenderOptions(options);
    options.tab = { primary: this._activeTabPrimary ?? this.tabGroups?.primary ?? 'description' };
  }

  /**
   * Текущее имя из поля формы (ещё не ушедшее в документ до submit) — нужно при programmatic update + render.
   * В ItemSheet V2 поле часто внутри `this.form`, а не всего `this.element`.
   * @param {HTMLFormElement|HTMLElement|null} [formOverride] — форма из `_prepareSubmitData`
   * @returns {string|null}
   */
  _getPendingNameFromForm(formOverride = null) {
    const roots = [];
    const add = (r) => {
      if (r instanceof HTMLElement && !roots.includes(r)) roots.push(r);
    };
    add(formOverride);
    add(this.form);
    add(this.element?.querySelector?.('form'));
    add(this.element);

    for (const root of roots) {
      const input = root?.querySelector?.('input[name="name"]');
      if (!input) continue;
      const v = String(input.value ?? '').trim();
      if (v.length) return v;
    }
    return null;
  }

  /**
   * Количество из поля шапки (ещё не ушедшее в документ) — для частичного submit и programmatic update.
   * @param {HTMLFormElement|HTMLElement|null} [formOverride]
   * @returns {number|null} целое ≥ 0 или null, если поля нет / пусто / не число
   */
  _getPendingQuantityFromForm(formOverride = null) {
    const roots = [];
    const add = (r) => {
      if (r instanceof HTMLElement && !roots.includes(r)) roots.push(r);
    };
    add(formOverride);
    add(this.form);
    add(this.element?.querySelector?.('form'));
    add(this.element);

    for (const root of roots) {
      const input = root?.querySelector?.('input[name="system.quantity"]');
      if (!input) continue;
      const s = String(input.value ?? '').trim();
      if (s === '') return null;
      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.floor(n));
    }
    return null;
  }

  /**
   * Собрать валидное имя до вызова super: внутри `super._prepareSubmitData` Foundry валидирует diff
   * до возврата — постобработка после super не успевает исправить `name: undefined`.
   */
  _resolveSubmitName(form, formData) {
    let pending = this._getPendingNameFromForm(form);
    if (!pending && formData && typeof formData.get === 'function') {
      const raw = formData.get('name');
      const s = raw != null ? String(raw).trim() : '';
      if (s) pending = s;
    }
    let resolved = pending;
    if (!resolved) {
      resolved = String(this.item?.name ?? this.document?.name ?? '').trim() || null;
    }
    if (!resolved) {
      resolved = game.i18n?.localize?.('SPACEHOLDER.Inventory.NewItem') ?? 'New item';
    }
    return String(resolved);
  }

  /**
   * Валидное количество до merge в diff: DOM / FormData, иначе значение с документа.
   * @param {HTMLFormElement|null} form
   * @param {FormData} formData
   * @returns {number}
   */
  _resolveSubmitQuantity(form, formData) {
    const docRaw = Number(this.item?.system?.quantity);
    const docFallback = Number.isFinite(docRaw) ? Math.max(0, Math.floor(docRaw)) : 1;

    let pending = this._getPendingQuantityFromForm(form);
    if (pending === null && formData && typeof formData.get === 'function') {
      const raw = formData.get('system.quantity');
      if (raw != null && String(raw).trim() !== '') {
        const n = Number(String(raw).trim());
        if (Number.isFinite(n)) pending = Math.max(0, Math.floor(n));
      }
    }
    return pending !== null ? pending : docFallback;
  }

  /**
   * При submitOnChange ядро иногда передаёт в update только изменённые поля; без `name` падает валидация DataModel.
   * Непустое имя из DOM / FormData имеет приоритет (частичный submit не должен затирать ввод в шапке).
   * @inheritDoc
   */
  async _prepareSubmitData(event, form, formData) {
    const resolvedName = this._resolveSubmitName(form, formData);

    if (form instanceof HTMLFormElement) {
      const nameInput = form.querySelector('input[name="name"]');
      if (nameInput && !String(nameInput.value ?? '').trim()) {
        nameInput.value = resolvedName;
      }
    }
    try {
      if (formData && typeof formData.set === 'function') {
        const cur = formData.get('name');
        if (cur === undefined || cur === null || String(cur).trim() === '') {
          formData.set('name', resolvedName);
        }
      }
    } catch (_) {
      /* ignore */
    }

    const data = await Promise.resolve(super._prepareSubmitData(event, form, formData));
    if (!data || typeof data !== 'object') return data;

    const n = data.name;
    if (n === undefined || n === null || String(n).trim() === '') {
      data.name = resolvedName;
    } else {
      data.name = String(n).trim();
    }

    if (this.item?.type === 'item') {
      const resolvedQty = this._resolveSubmitQuantity(form, formData);
      data['system.quantity'] = resolvedQty;
      if (data.system && typeof data.system === 'object' && !Array.isArray(data.system)) {
        data.system.quantity = resolvedQty;
      }
    }

    return data;
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    // Как у актёра (`context.actor = this.actor`): в шаблоне `{{item.name}}` и `item.uuid`
    // должны идти от живого документа — базовый контекст V2 иногда даёт plain object без имени.
    context.item = this.item;
    context.editable = this.isEditable;

    const itemData = this.document.toObject(false);

    // Enrich description info for display
    context.enrichedDescription = await enrichHTMLWithFactionIcons(this.item.system.description, {
      secrets: this.document.isOwner,
      async: true,
      rollData: this.item.getRollData(),
      relativeTo: this.item,
    });

    context.system = itemData.system;
    context.flags = itemData.flags;

    const defIcon = Item?.DEFAULT_ICON ?? '';
    const rawImg = this.item?.img ?? '';
    context.itemImgSrc = String(rawImg ?? '').trim() ? rawImg : defIcon;

    const itemType = String(this.item?.type ?? 'item');
    context.itemHeaderAccent = this._resolveItemHeaderAccentHex(itemType);
    const typeLabelKey = ITEM_TYPE_LABEL_KEYS[itemType] || ITEM_TYPE_LABEL_KEYS.item;
    context.itemTypeLabel = game.i18n?.localize?.(typeLabelKey) ?? itemType;
    context.itemTypeIconClass = ITEM_TYPE_ICON_CLASS[itemType] || ITEM_TYPE_ICON_CLASS.item;
    context.itemHeaderInlineQuantity = false;

    context.config = CONFIG.SPACEHOLDER;

    context.effects = prepareActiveEffectCategories(this.item.effects);

    // Defaults for older items
    context.system.actions = this._normalizeItemActions(context.system.actions);
    context.actionPayloadOptions = await this._getActionPayloadOptions();
    if (this.item.type === 'item') {
      context.system.defaultActions = context.system.defaultActions || {};
      context.system.defaultActions.equip = context.system.defaultActions.equip || { showInCombat: false, showInQuickbar: true };
      context.system.defaultActions.unequip = context.system.defaultActions.unequip || { showInCombat: false, showInQuickbar: true };
      context.system.defaultActions.hold = context.system.defaultActions.hold || { showInCombat: false, showInQuickbar: true };
      context.system.defaultActions.stow = context.system.defaultActions.stow || { showInCombat: false, showInQuickbar: true };
      context.system.defaultActions.drop = context.system.defaultActions.drop || { showInCombat: false, showInQuickbar: false };
      context.system.defaultActions.wear = context.system.defaultActions.wear || { showInCombat: false, showInQuickbar: false };
      context.system.defaultActions.show = context.system.defaultActions.show || { showInCombat: false, showInQuickbar: false };
    }

    const primaryTabDefs = this.constructor.TABS?.primary?.tabs ?? [];
    const primaryTabIds = primaryTabDefs.map((t) => t.id).filter(Boolean);
    context.sheetPrimaryTabs = buildItemSheetPrimaryTabs(primaryTabIds);

    return context;
  }

  async _getActionPayloadOptions() {
    try {
      let manager = game.spaceholder?.aimingManager ?? null;
      if (!manager) {
        const mod = await import('../helpers/aiming-manager.mjs');
        const Ctor = mod?.AimingManager;
        if (typeof Ctor === 'function') manager = new Ctor();
        if (manager && game.spaceholder) game.spaceholder.aimingManager = manager;
      }
      const payloads = await manager?.getPayloadLibrary?.();
      if (!Array.isArray(payloads)) return [];
      return payloads
        .map((p) => ({
          id: String(p?.id ?? '').trim(),
          name: String(p?.name ?? p?.id ?? '').trim(),
        }))
        .filter((p) => p.id);
    } catch (_) {
      return [];
    }
  }

  _newActionId() {
    try { return foundry.utils.randomID?.(); } catch (_) { /* ignore */ }
    try { return globalThis.randomID?.(); } catch (_) { /* ignore */ }
    try { return globalThis.crypto?.randomUUID?.(); } catch (_) { /* ignore */ }
    return String(Date.now());
  }

  _normalizeItemAction(action = {}, { keepId = true } = {}) {
    const modeRaw = String(action?.mode ?? 'chat').trim();
    const mode = Object.prototype.hasOwnProperty.call(ITEM_ACTION_MODE_LABEL_KEYS, modeRaw) ? modeRaw : 'chat';
    const normalized = {
      id: keepId ? String(action?.id ?? '').trim() : '',
      name: String(action?.name ?? '').trim(),
      apCost: Math.max(0, Math.floor(Number(action?.apCost) || 0)),
      mode,
      macro: String(action?.macro ?? ''),
      aimingType: String(action?.aimingType ?? 'simple').trim() || 'simple',
      payloadId: String(action?.payloadId ?? '').trim(),
      damage: Math.max(0, Number(action?.damage) || 0),
      requiresHolding: !!action?.requiresHolding,
      showInCombat: action?.showInCombat !== false,
      showInQuickbar: action?.showInQuickbar !== false,
      modeLabelKey: ITEM_ACTION_MODE_LABEL_KEYS[mode] || ITEM_ACTION_MODE_LABEL_KEYS.chat,
    };
    if (!keepId) normalized.id = '';
    return normalized;
  }

  _normalizeItemActions(actions) {
    const list = Array.isArray(actions) ? actions : [];
    return list.map((a) => this._normalizeItemAction(a, { keepId: true }));
  }

  _readActionDialogForm(root, baseAction = null) {
    const read = (selector) => root?.querySelector?.(selector);
    const actionId = String(baseAction?.id ?? '').trim() || this._newActionId();
    const next = this._normalizeItemAction({
      id: actionId,
      name: read('[name="name"]')?.value ?? '',
      apCost: read('[name="apCost"]')?.value ?? 0,
      mode: read('[name="mode"]')?.value ?? 'chat',
      macro: read('[name="macro"]')?.value ?? '',
      payloadId: read('[name="payloadId"]')?.value ?? '',
      aimingType: read('[name="aimingType"]')?.value ?? 'simple',
      damage: read('[name="damage"]')?.value ?? 0,
      requiresHolding: !!read('[name="requiresHolding"]')?.checked,
      showInCombat: !!read('[name="showInCombat"]')?.checked,
      showInQuickbar: !!read('[name="showInQuickbar"]')?.checked,
    }, { keepId: true });

    if (!next.name) {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.NameRequired') ?? 'Action name is required');
      return null;
    }
    return next;
  }

  _bindActionDialogModeVisibility(dialogUid) {
    const root = document.querySelector(`[data-sh-item-action-dialog="${dialogUid}"]`);
    if (!root) return false;
    if (root.dataset.spaceholderModeBound) return true;
    root.dataset.spaceholderModeBound = '1';

    const modeSelect = root.querySelector('[data-sh-mode-select]');
    if (!(modeSelect instanceof HTMLSelectElement)) return true;
    const refresh = () => {
      const mode = String(modeSelect.value ?? 'chat').trim() || 'chat';
      root.querySelectorAll('[data-sh-mode-block]').forEach((block) => {
        const blockMode = String(block.getAttribute('data-sh-mode-block') ?? '').trim();
        block.hidden = !!blockMode && blockMode !== mode;
      });
    };
    modeSelect.addEventListener('change', refresh);
    refresh();
    return true;
  }

  async _openItemActionDialog({ title, action = null } = {}) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2?.wait) {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.FreeAction.DialogUnavailable') ?? 'Dialog is unavailable');
      return null;
    }

    const dialogUid = this._newActionId();
    const draftAction = this._normalizeItemAction(action, { keepId: true });
    const content = await foundry.applications.handlebars.renderTemplate('systems/spaceholder/templates/item/parts/item-action-dialog.hbs', {
      dialogUid,
      action: draftAction,
      modeOptions: Object.entries(ITEM_ACTION_MODE_LABEL_KEYS).map(([id, labelKey]) => ({ id, labelKey })),
      payloadOptions: Array.isArray(this._context?.actionPayloadOptions) ? this._context.actionPayloadOptions : [],
    });

    let outcome = null;
    const bindTimer = globalThis.setInterval?.(() => {
      if (this._bindActionDialogModeVisibility(dialogUid)) {
        globalThis.clearInterval?.(bindTimer);
      }
    }, 40);
    globalThis.setTimeout?.(() => globalThis.clearInterval?.(bindTimer), 2500);

    const titleText = title || game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.EditAction') || 'Edit action';
    await DialogV2.wait({
      classes: ['spaceholder'],
      window: { title: titleText, icon: 'fa-solid fa-bolt' },
      position: { width: 520 },
      content,
      buttons: [
        {
          action: 'save',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Save') ?? 'Save',
          icon: 'fa-solid fa-check',
          default: true,
          callback: (dlgEvent) => {
            const root =
              dlgEvent?.currentTarget?.form ||
              dlgEvent?.target?.form ||
              dlgEvent?.currentTarget?.closest?.('form') ||
              dlgEvent?.target?.closest?.('form') ||
              dlgEvent?.currentTarget;
            outcome = this._readActionDialogForm(root, draftAction);
          },
        },
        {
          action: 'cancel',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Cancel') ?? 'Cancel',
          icon: 'fa-solid fa-times',
        },
      ],
    });

    return outcome;
  }

  async _setItemActions(nextActions) {
    const patch = { 'system.actions': this._normalizeItemActions(nextActions) };
    const pending = this._getPendingNameFromForm();
    if (pending && pending !== String(this.item.name ?? '').trim()) patch.name = pending;
    const pendingQty = this._getPendingQuantityFromForm();
    if (pendingQty !== null) {
      const cur = Math.max(0, Math.floor(Number(this.item.system?.quantity ?? 1)));
      if (pendingQty !== cur) patch['system.quantity'] = pendingQty;
    }
    await this.item.update(patch);
  }

  /**
   * Клик по портрету предмета: FilePicker / просмотр (как SpaceHolderBaseActorSheet).
   * @private
   */
  async _onProfileImageClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const imgEl = event.currentTarget;
    const field = imgEl?.dataset?.edit || 'img';

    if (!this.isEditable) {
      const src = foundry.utils.getProperty(this.document, field) ?? this.document?.img;
      if (src && typeof ImagePopout === 'function') {
        new ImagePopout(src, { title: this.document?.name ?? 'Image' }).render(true);
      }
      return;
    }

    const Picker = globalThis.FilePicker;
    if (typeof Picker !== 'function') {
      ui.notifications?.warn?.('FilePicker недоступен');
      return;
    }

    const current = foundry.utils.getProperty(this.document, field) ?? this.document?.img ?? '';
    const fp = new Picker({
      type: 'image',
      current,
      callback: async (path) => {
        await this.document.update({ [field]: path });
      },
    });

    fp.render(true);
  }

  /**
   * Иконка из библиотеки SVG (только поле `img` предмета).
   * @private
   */
  async _onItemIconPickClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isEditable) return;

    const initialPath = String(this.item?.img ?? '').trim() || null;
    const title = game.i18n?.localize?.('SPACEHOLDER.IconPicker.Title') ?? null;
    const path = await pickIcon({ initialPath, defaultColor: '#ffffff', title: title || undefined });
    if (!path) return;

    try {
      await this.item.update({ img: path });
    } catch (e) {
      console.error('SpaceHolder | item icon pick update failed', e);
    }
    try {
      this.render(false);
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Акцент шапки предмета по типу документа (детерминированный оттенок).
   * @param {string} itemType
   * @returns {string}
   * @protected
   */
  _resolveItemHeaderAccentHex(itemType) {
    const hue = this._hashStringToHue(String(itemType ?? 'item'));
    const hex = this._hslToHex(hue, 52, 44);
    return `#${hex.toString(16).padStart(6, '0')}`;
  }

  /** @private */
  _hashStringToHue(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) % 360;
  }

  /** @private */
  _hslToHex(h, s, l) {
    const sat = (s ?? 0) / 100;
    const lig = (l ?? 0) / 100;
    const c = (1 - Math.abs(2 * lig - 1)) * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = lig - c / 2;

    let r = 0; let g = 0; let b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }

    const to255 = (v) => Math.max(0, Math.min(255, Math.round((v + m) * 255)));
    const rr = to255(r);
    const gg = to255(g);
    const bb = to255(b);
    return (rr << 16) + (gg << 8) + bb;
  }

  /**
   * У `<prose-mirror toggled>` превью строится из `enrichedDescription` при рендере.
   * В App V2 после `save` поле формы не всегда успевает попасть в документ до `_prepareContext`;
   * синхронизируем `system.description` из `el.value` и перерисовываем лист.
   */
  _bindDescriptionProseMirrorRefresh() {
    const el = this.element?.querySelector?.('prose-mirror[name="system.description"]');
    if (!el || el.dataset.spaceholderDescSaveBound === '1') return;
    el.dataset.spaceholderDescSaveBound = '1';

    el.addEventListener('save', async () => {
      let raw = '';
      try {
        const v = el.value;
        raw = typeof v === 'string' ? v : (v != null ? String(v) : '');
      } catch (_) {
        raw = '';
      }
      try {
        await this.item.update({ 'system.description': raw });
      } catch (e) {
        console.error('SpaceHolder | item description sync failed:', e);
        return;
      }
      await this.render(false);
    });
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);

    // Портрет: в ItemSheetV2 data-edit="img" не всегда обрабатывается — как на листе актёра
    const profileHandler = (this._onProfileImageClickBound ??= this._onProfileImageClick.bind(this));
    this.element?.querySelectorAll('img.profile-img[data-edit], img.profile-img').forEach((img) => {
      img.addEventListener('click', profileHandler);
    });

    const iconPickHandler = this._onItemIconPickClickBound ??= this._onItemIconPickClick.bind(this);
    this.element?.querySelectorAll('[data-action="sh-icon-pick"]').forEach((btn) => {
      btn.addEventListener('click', iconPickHandler);
    });

    // Повторно применяем активную вкладку после каждого рендера (как в листе персонажа)
    const desiredTab = this._activeTabPrimary ?? this.tabGroups?.primary ?? 'description';
    try { this.changeTab(desiredTab, 'primary', { updatePosition: false, force: true }); } catch (e) { /* ignore */ }

    this._bindDescriptionProseMirrorRefresh();

    if (!this.isEditable) return;

    // Имя: надёжно пишем в документ на blur/change (submitOnChange + this.form не всегда совпадают с this.element)
    this.element.querySelectorAll('input[name="name"]').forEach((input) => {
      if (input.dataset.spaceholderNameBound) return;
      input.dataset.spaceholderNameBound = '1';
      const syncName = async () => {
        const v = String(input.value ?? '').trim();
        if (!v) return;
        const cur = String(this.item.name ?? '').trim();
        if (v === cur) return;
        try {
          await this.item.update({ name: v });
        } catch (e) {
          console.error('SpaceHolder | item name sync failed:', e);
        }
      };
      input.addEventListener('change', () => {
        syncName();
      });
      input.addEventListener('blur', () => {
        syncName();
      });
    });

    this.element.querySelectorAll('input[name="system.quantity"]').forEach((input) => {
      if (input.dataset.spaceholderQtyBound) return;
      input.dataset.spaceholderQtyBound = '1';
      const syncQty = async () => {
        const s = String(input.value ?? '').trim();
        if (s === '') return;
        const n = Math.max(0, Math.floor(Number(s)));
        if (!Number.isFinite(n)) return;
        const cur = Math.max(0, Math.floor(Number(this.item.system?.quantity ?? 1)));
        if (n === cur) return;
        try {
          await this.item.update({ 'system.quantity': n });
        } catch (e) {
          console.error('SpaceHolder | item quantity sync failed:', e);
        }
      };
      input.addEventListener('change', syncQty);
      input.addEventListener('blur', syncQty);
    });

    // Active Effect management
    this.element.querySelectorAll('.effect-control').forEach(btn =>
      btn.addEventListener('click', (ev) => onManageActiveEffect(ev, this.item))
    );

    // Custom actions editor (item.system.actions): compact list + modal edit
    const el = this.element;
    const getActions = () => this._normalizeItemActions(this.item?.system?.actions);

    el.querySelectorAll('[data-action="sh-item-custom-action-add"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const created = await this._openItemActionDialog({
          title: game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.AddAction') ?? 'Add action',
          action: {
            id: this._newActionId(),
            name: '',
            apCost: 0,
            mode: 'chat',
            macro: '',
            aimingType: 'simple',
            payloadId: '',
            damage: 0,
            requiresHolding: false,
            showInCombat: true,
            showInQuickbar: true,
          },
        });
        if (!created) return;
        await this._setItemActions([...getActions(), created]);
      });
    });

    el.querySelectorAll('[data-action="sh-item-custom-action-edit-open"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const id = String(btn.dataset.id ?? '').trim();
        if (!id) return;
        const source = getActions().find((a) => String(a?.id ?? '') === id);
        if (!source) return;
        const edited = await this._openItemActionDialog({
          title: game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.EditAction') ?? 'Edit action',
          action: source,
        });
        if (!edited) return;
        const next = getActions().map((a) => (String(a?.id ?? '') === id ? edited : a));
        await this._setItemActions(next);
      });
    });

    el.querySelectorAll('[data-action="sh-item-custom-action-duplicate"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const id = String(btn.dataset.id ?? '').trim();
        if (!id) return;
        const source = getActions().find((a) => String(a?.id ?? '') === id);
        if (!source) return;
        const duplicateSuffix = game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.DuplicateSuffix') ?? 'Copy';
        const cloned = await this._openItemActionDialog({
          title: game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.DuplicateAction') ?? 'Duplicate action',
          action: {
            ...source,
            id: this._newActionId(),
            name: source.name ? `${source.name} (${duplicateSuffix})` : '',
          },
        });
        if (!cloned) return;
        await this._setItemActions([...getActions(), cloned]);
      });
    });

    el.querySelectorAll('[data-action="sh-item-custom-action-remove"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const id = String(btn.dataset.id ?? '').trim();
        if (!id) return;
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          classes: ['spaceholder'],
          window: {
            title: game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.DeleteActionTitle') ?? 'Delete action',
            icon: 'fa-solid fa-trash',
          },
          content: `<p>${game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.DeleteActionConfirm') ?? 'Delete this action?'}</p>`,
          yes: { label: game.i18n?.localize?.('SPACEHOLDER.Actions.Delete') ?? 'Delete', icon: 'fa-solid fa-trash' },
          no: { label: game.i18n?.localize?.('SPACEHOLDER.Actions.Cancel') ?? 'Cancel', icon: 'fa-solid fa-times' },
        });
        if (!confirmed) return;
        const next = getActions().filter((a) => String(a?.id ?? '') !== id);
        await this._setItemActions(next);
      });
    });
  }
}

// Item sheets per type (Application V2)
export class SpaceHolderItemSheet_Feature extends SpaceHolderBaseItemSheet {
  static PARTS = { body: { root: true, template: 'systems/spaceholder/templates/item/item-feature-sheet.hbs' } };
}
export class SpaceHolderItemSheet_Spell extends SpaceHolderBaseItemSheet {
  static PARTS = { body: { root: true, template: 'systems/spaceholder/templates/item/item-spell-sheet.hbs' } };
}
export class SpaceHolderItemSheet_Generic extends SpaceHolderBaseItemSheet {
  static PARTS = { body: { root: true, template: 'systems/spaceholder/templates/item/item-sheet.hbs' } };
}

/**
 * Material item sheet — describes per-damage-type resistance, wear,
 * transmission and degradation overrides plus base metadata used by the
 * damage resolver.
 */
export class SpaceHolderItemSheet_Material extends SpaceHolderBaseItemSheet {
  static PARTS = { body: { root: true, template: 'systems/spaceholder/templates/item/item-material-sheet.hbs' } };

  static DEFAULT_OPTIONS = {
    position: { width: 720, height: 760 },
    window: { resizable: true },
  };

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const sys = context.system || {};
    const damageTypes = CONFIG?.SPACEHOLDER?.damageTypes ?? {};
    const degradationModes = CONFIG?.SPACEHOLDER?.degradationModes ?? {};

    const conductance = (sys.conductance && typeof sys.conductance === 'object') ? sys.conductance : {};
    const selfInduction = (sys.selfInduction && typeof sys.selfInduction === 'object') ? sys.selfInduction : {};
    const degradation = (sys.degradation && typeof sys.degradation === 'object') ? sys.degradation : {};
    const resistance = (sys.resistance && typeof sys.resistance === 'object') ? sys.resistance : {};
    const wear = (sys.wear && typeof sys.wear === 'object') ? sys.wear : {};

    const asJsonString = (raw) => {
      if (Array.isArray(raw)) {
        try { return JSON.stringify(raw); } catch (_) { return ''; }
      }
      return typeof raw === 'string' ? raw : '';
    };

    context.materialDamageRows = Object.values(damageTypes).map((dt) => ({
      id: dt.id,
      labelKey: dt.label,
      descriptionKey: dt.description,
      category: dt.category,
      resistance: Number(resistance[dt.id] ?? 0),
      wear: Number(wear[dt.id] ?? 0),
      conductanceJson: asJsonString(conductance[dt.id]),
      selfInductionJson: asJsonString(selfInduction[dt.id]),
      degradation: typeof degradation[dt.id] === 'string' ? degradation[dt.id] : '',
    }));

    context.degradationOptions = Object.entries(degradationModes).map(([_key, value]) => ({
      id: value,
      labelKey: `SPACEHOLDER.Degradation.${value.charAt(0).toUpperCase()}${value.slice(1)}`,
    }));

    const currentCategory = String(sys.category ?? 'metal');
    context.materialCategoryOptions = MATERIAL_CATEGORY_OPTIONS.map((opt) => ({
      ...opt,
      selected: opt.id === currentCategory,
    }));

    return context;
  }

  /**
   * Allow per-damage-type conductance / self-induction rows to be authored
   * as JSON strings in text inputs. Convert them back to arrays before
   * persisting; invalid JSON keeps the previous value to avoid wiping user
   * data on a typo.
   * @inheritDoc
   */
  _prepareSubmitData(event, form, formData) {
    const data = super._prepareSubmitData(event, form, formData);
    const hardness = data?.system?.hardness;
    if (hardness && typeof hardness === 'object') {
      const values = Object.values(hardness)
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0);
      data.system.hardness = values.length ? Math.max(...values) : 1;
    }
    const normalizeFractionGroup = (group, prevGroup) => {
      if (!group || typeof group !== 'object') return;
      for (const [key, raw] of Object.entries(group)) {
        if (Array.isArray(raw)) continue;
        const text = String(raw ?? '').trim();
        if (!text) {
          group[key] = [];
          continue;
        }
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) group[key] = parsed;
          else group[key] = Array.isArray(prevGroup?.[key]) ? prevGroup[key] : [];
        } catch (_) {
          group[key] = Array.isArray(prevGroup?.[key]) ? prevGroup[key] : [];
        }
      }
    };
    normalizeFractionGroup(data?.system?.conductance, this.document?.system?.conductance);
    normalizeFractionGroup(data?.system?.selfInduction, this.document?.system?.selfInduction);

    const degGroup = data?.system?.degradation;
    if (degGroup && typeof degGroup === 'object') {
      for (const [key, raw] of Object.entries(degGroup)) {
        const value = String(raw ?? '').trim();
        if (!value) delete degGroup[key];
      }
    }
    return data;
  }
}

/**
 * Item sheet (gear: anatomy coverage, equip, modifiers, optional roll formula).
 */
export class SpaceHolderItemSheet_Item extends SpaceHolderBaseItemSheet {
  static PARTS = { body: { root: true, template: 'systems/spaceholder/templates/item/item-wearable-sheet.hbs' } };

  static DEFAULT_OPTIONS = {
    // Шапка + полоса вкладок + баннер + строка управления + фиксированный ряд 420px (покрытие)
    position: { width: 720, height: 860 },
    window: { resizable: true },
  };

  // Вкладки: описание → оружие / боеприпас (по тегам) → прочее → настройки последние.
  static TABS = {
    primary: {
      tabs: [
        { id: 'description' },
        { id: 'weapon' },
        { id: 'ammo' },
        { id: 'attributes' },
        { id: 'actions' },
        { id: 'modifiers' },
        { id: 'container' },
        { id: 'tags' },
      ],
      initial: 'description',
    },
  };

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const system = context.system || {};

    // itemTags: булевы флаги групп механик (см. template.json / migrateData)
    const rawTags = system.itemTags && typeof system.itemTags === 'object' ? system.itemTags : {};
    system.itemTags = {
      isArmor: !!rawTags.isArmor,
      isActions: !!rawTags.isActions,
      isModifiers: !!rawTags.isModifiers,
      isWeapon: !!(rawTags.isWeapon || rawTags.isMelee || rawTags.isRanged || rawTags.isThrown),
      isAmmo: !!rawTags.isAmmo,
      isContainer: !!rawTags.isContainer,
    };
    context.hasArmorTag = system.itemTags.isArmor;
    context.hasActionsTag = system.itemTags.isActions;
    context.hasModifiersTag = system.itemTags.isModifiers;
    context.hasWeaponTag = system.itemTags.isWeapon;
    context.hasAmmoTag = system.itemTags.isAmmo;
    context.hasContainerTag = system.itemTags.isContainer;

    const allowedTabs = new Set(['description', 'tags']);
    if (system.itemTags.isArmor) allowedTabs.add('attributes');
    if (system.itemTags.isActions) allowedTabs.add('actions');
    if (system.itemTags.isModifiers) allowedTabs.add('modifiers');
    if (context.hasWeaponTag) allowedTabs.add('weapon');
    if (system.itemTags.isAmmo) allowedTabs.add('ammo');
    if (system.itemTags.isContainer) allowedTabs.add('container');
    const currentTab = this._activeTabPrimary ?? this.tabGroups?.primary ?? 'description';
    if (!allowedTabs.has(currentTab)) {
      this._activeTabPrimary = 'tags';
    }

    const selectedAnatomyId = String(system.anatomyId ?? '').trim() || null;
    context.selectedAnatomyId = selectedAnatomyId;
    const fallbackAnatomyId = String(CONFIG?.SPACEHOLDER?.wearableCoverageReferenceAnatomyId ?? '').trim() || null;
    let editorAnatomyId = selectedAnatomyId || fallbackAnatomyId;
    if (!editorAnatomyId) {
      const availableIds = Object.keys(anatomyManager.getAvailableAnatomies() ?? {});
      if (availableIds.length) editorAnatomyId = availableIds[0];
    }

    // Название анатомии + список частей для выбранного эталона предмета
    context.anatomyDisplayName = null;
    context.bodyPartsForGroup = [];

    const coveredParts = Array.isArray(system.coveredParts) ? system.coveredParts : [];

    if (editorAnatomyId) {
      try {
        let anatomyData = null;
        const registryInfo = anatomyManager.getAnatomyInfo(editorAnatomyId);
        if (registryInfo) {
          anatomyData = await anatomyManager.loadAnatomy(editorAnatomyId);
          if (selectedAnatomyId) {
            context.anatomyDisplayName = anatomyManager.getAnatomyDisplayName(selectedAnatomyId);
          }
        } else {
          await anatomyManager.loadWorldPresets();
          const worldPresets = anatomyManager.getWorldPresets();
          const preset = worldPresets.find((p) => p.id === editorAnatomyId);
          if (preset) {
            anatomyData = preset;
            if (selectedAnatomyId) {
              context.anatomyDisplayName = preset.name || preset.id;
            }
          }
        }

        const parts = anatomyData?.bodyParts ?? {};
        if (Object.keys(parts).length) {
          context.anatomyDataForEditor = {
            bodyParts: parts,
            grid: anatomyData.grid ?? {}
          };

          // Построим детерминированный список экземпляров для UI
          const byTypeId = new Map();
          for (const [slotRef, part] of Object.entries(parts)) {
            const typeId = String(part.id ?? slotRef ?? "").trim();
            if (!typeId) continue;
            const arr = byTypeId.get(typeId) || [];
            arr.push({ slotRef, part });
            byTypeId.set(typeId, arr);
          }

          const entries = [];
          for (const [typeId, arr] of byTypeId.entries()) {
            arr.sort((a, b) => {
              const ax = a.part.x ?? 0;
              const bx = b.part.x ?? 0;
              if (ax !== bx) return ax - bx;
              const ay = a.part.y ?? 0;
              const by = b.part.y ?? 0;
              if (ay !== by) return ay - by;
              return a.slotRef.localeCompare(b.slotRef);
            });
            arr.forEach((entry, index) => {
              const baseName = entry.part.displayName || entry.part.name || typeId;
              const duplicateIndex = arr.length > 1 ? index + 1 : null;
              const displayName = duplicateIndex ? `${baseName} (${duplicateIndex})` : baseName;
              entries.push({
                id: entry.slotRef,
                name: displayName
              });
            });
          }

          context.bodyPartsForGroup = entries.sort((a, b) => a.name.localeCompare(b.name, game.i18n?.lang || 'en'));
        }
      } catch (e) {
        console.error('SpaceHolder | Failed to prepare wearable body parts list:', e);
      }
    }

    if (!context.anatomyDisplayName) {
      context.anatomyDisplayName = game.i18n?.localize?.('SPACEHOLDER.Wearable.NoAnatomySelected') ?? '—';
    }

    // Режим редактирования покрытия (флаг на документе)
    context.wearableCoverageEditMode = !!this.document?.flags?.spaceholder?.wearableCoverageEditMode;

    // Список покрытых частей — из coveredParts; имена берём из анатомии, если есть
    const partsForNames = context.anatomyDataForEditor?.bodyParts ?? {};
    const countByTypeId = {};
    for (const p of Object.values(partsForNames)) {
      const typeId = String(p?.id ?? "").trim();
      if (!typeId) continue;
      countByTypeId[typeId] = (countByTypeId[typeId] || 0) + 1;
    }
    const localizePartName = (partId, fallback) => {
      const key = `SPACEHOLDER.BodyParts.${partId}`;
      const localized = game.i18n?.localize?.(key);
      if (localized && localized !== key) return localized;
      return fallback;
    };

    context.coveredList = coveredParts
      .map((entry) => {
        const slotRef = String(entry.slotRef ?? entry.partId ?? "").trim();
        if (!slotRef) return null;
        const part = partsForNames[slotRef];
        const canonicalId = String(part?.id ?? slotRef).trim() || slotRef;
        const baseNameRaw = part?.displayName || part?.name || canonicalId || slotRef;
        const baseName = localizePartName(canonicalId, baseNameRaw);
        const typeId = String(part?.id ?? "").trim();
        const hasDup = !!typeId && (countByTypeId[typeId] || 0) > 1;
        const m = String(slotRef).match(/#(\d+)$/);
        const dupIndex = hasDup && m ? Number(m[1]) : null;
        const uiName = dupIndex ? `${baseName} (${dupIndex})` : baseName;
        const layers = Array.isArray(entry?.layers) ? entry.layers : [];
        return {
          partId: slotRef,
          partName: uiName,
          layerCount: layers.length,
          layersSummary: formatCoverageLayersSummary(layers)
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.partName.localeCompare(b.partName, game.i18n?.lang || 'en'));

    // Targets для модификаторов (используется на вкладке Modifiers)
    const cfgTargets = CONFIG.SPACEHOLDER?.characterModifierTargets || {};
    context.modifierTargets = {
      abilities: Array.isArray(cfgTargets.abilities) ? cfgTargets.abilities : [],
      derived: Array.isArray(cfgTargets.derived) ? cfgTargets.derived : [],
      params: Array.isArray(cfgTargets.params) ? cfgTargets.params : []
    };

    // Гарантируем наличие массивов модификаторов в системе предмета
    system.modifiers = system.modifiers || {};
    system.modifiers.abilities = Array.isArray(system.modifiers.abilities) ? system.modifiers.abilities : [];
    system.modifiers.derived = Array.isArray(system.modifiers.derived) ? system.modifiers.derived : [];
    system.modifiers.params = Array.isArray(system.modifiers.params) ? system.modifiers.params : [];

    // Layers are now per-coveredPart; the dialog opened via the
    // "wearable-coverage-layers" button handles material selection.

    // Вкладки оружия/боеприпаса v3: нормализованные данные + контекст для шаблона.
    system.storage = normalizeNestedStorage(system.storage);
    system.weapon = migrateItemWeaponData(system.weapon, system.itemTags);
    if (context.hasWeaponTag) {
      context.weaponV3 = this._buildWeaponV3Context(system.weapon);
      context.weaponV3.payloadOptions = await this._getActionPayloadOptions();
    }
    if (context.hasAmmoTag) context.ammoV3 = this._buildAmmoV3Context(system.weapon.ammo);

    const icFields = normalizeItemContainerFields(system);
    system.containerHostId = icFields.containerHostId;
    system.container = icFields.container;

    context.system = system;

    if (context.hasContainerTag) {
      const actor = this.item.parent?.documentName === 'Actor' ? this.item.parent : null;
      context.containerOnActor = !!actor;
      context.containerWorldMode = !actor;
      context.containerReadOnly = !this.isEditable;
      // Magazines (ammo+container) use live actor-container children, same as bandoliers.
      // Nested storage is legacy; migrate when the item sits on an actor.
      context.containerUsesNestedStorage = false;
      if (actor && context.hasAmmoTag && system.itemTags.isContainer) {
        const ammo = normalizeAmmoConfig(system.weapon?.ammo);
        if (ammo.connector?.enabled) {
          const cap = Math.max(0, Number(ammo.capacity) || 0);
          if (cap > 0 && icFields.container.limits.maxItems !== cap) {
            try {
              await this.item.update({ 'system.container.limits.maxItems': cap }, { render: false });
              icFields.container.limits.maxItems = cap;
            } catch (_) { /* ignore */ }
          }
          const storage = normalizeNestedStorage(system.storage);
          if (storage.contents.length) {
            try {
              const { extractNestedItemToActor } = await import('../helpers/item-nested-storage.mjs');
              const { moveActorItemIntoContainer } = await import('../helpers/item-container.mjs');
              while (normalizeNestedStorage(this.item.system?.storage).contents.length) {
                const head = normalizeNestedStorage(this.item.system.storage).contents[0];
                const created = await extractNestedItemToActor({
                  containerItem: this.item,
                  path: [head.id],
                  quantity: Math.max(1, Number(head?.system?.quantity) || 1),
                });
                if (!created) break;
                await moveActorItemIntoContainer(actor, this.item, created.id);
              }
            } catch (e) {
              console.warn('SpaceHolder | magazine nested→container migrate failed', e);
            }
          }
        }
      }
      {
        const panel = await this._buildContainerPanelContext(actor);
        context.containerGear = panel.containerGear;
        context.containerTotalWeight = panel.containerTotalWeight;
        context.containerTotalItems = panel.containerTotalItems;
        context.containerLimitMaxItems = icFields.container.limits.maxItems;
        context.containerLimitMaxWeight = icFields.container.limits.maxWeight;
        context.containerLimitItemsEnabled = icFields.container.limits.maxItems > 0;
        context.containerLimitWeightEnabled = icFields.container.limits.maxWeight > 0;
        context.containerLimitItemsSourceAmmo = !!(context.hasAmmoTag && system.itemTags.isContainer
          && normalizeAmmoConfig(system.weapon?.ammo).connector?.enabled);
      }
      context.containerItemsFillPercent = context.containerLimitItemsEnabled
        ? Math.min(100, Math.max(0, Math.round((Number(context.containerTotalItems) / context.containerLimitMaxItems) * 100)))
        : 0;
      context.containerWeightFillPercent = context.containerLimitWeightEnabled
        ? Math.min(100, Math.max(0, Math.round((Number(context.containerTotalWeight) / context.containerLimitMaxWeight) * 100)))
        : 0;
      context.containerItemsOverLimit = context.containerLimitItemsEnabled
        && Number(context.containerTotalItems) > Number(context.containerLimitMaxItems);
      context.containerWeightOverLimit = context.containerLimitWeightEnabled
        && Number(context.containerTotalWeight) > Number(context.containerLimitMaxWeight);
    }

    const wearableTabIds = ['description'];
    if (context.hasWeaponTag) wearableTabIds.push('weapon');
    if (context.hasAmmoTag) wearableTabIds.push('ammo');
    if (context.hasArmorTag) wearableTabIds.push('attributes');
    if (context.hasActionsTag) wearableTabIds.push('actions');
    if (context.hasModifiersTag) wearableTabIds.push('modifiers');
    if (context.hasContainerTag) wearableTabIds.push('container');
    wearableTabIds.push('tags');
    context.sheetPrimaryTabs = buildItemSheetPrimaryTabs(wearableTabIds, {
      attributes: { icon: 'fas fa-shield-halved', labelKey: 'SPACEHOLDER.Tabs.Coverage' },
      tags: { icon: 'fas fa-gear', labelKey: 'SPACEHOLDER.Tabs.Settings' },
    });
    context.itemHeaderInlineQuantity = true;

    return context;
  }

  /**
   * @param {Actor|null} actor
   * @returns {Promise<{ containerGear: object[], containerTotalWeight: number, containerTotalItems: number }>}
   */
  async _buildContainerPanelContext(actor) {
    const empty = { containerGear: [], containerTotalWeight: 0, containerTotalItems: 0 };
    if (actor?.items) return this._buildActorContainerPanelContext(actor);
    return this._buildWorldContainerPanelContext();
  }

  /**
   * @param {object} system
   * @returns {{ containerStorageRows: object[], containerTotalWeight: number, containerTotalItems: number, containerLimitMaxItems: number, containerLimitMaxWeight: number }}
   */
  _buildNestedStorageContainerPanelContext(system) {
    const storage = normalizeNestedStorage(system?.storage);
    const ammo = normalizeAmmoConfig(system?.weapon?.ammo);
    const limits = normalizeItemContainerFields(system).container.limits;
    const kg = game.i18n?.localize?.('SPACEHOLDER.Units.Kg') ?? 'kg';
    const rows = [];

    const usageOf = (itemLike) => {
      const quantity = Math.max(0, Math.floor(Number(itemLike?.system?.quantity) || 0));
      const unitWeight = Math.max(0, Number(itemLike?.system?.weight) || 0);
      const totalWeight = Math.round(quantity * unitWeight * 100) / 100;
      const name = String(itemLike?.name ?? '').trim() || (game.i18n?.localize?.('SPACEHOLDER.Inventory.NewItem') ?? 'Item');
      return {
        quantity,
        unitWeight,
        totalWeight,
        displayName: `${name} x ${quantity}, ${totalWeight} ${kg}`,
      };
    };

    const visit = (entry, path, depth) => {
      if (!entry) return;
      const nested = getNestedStorage(entry);
      const meta = usageOf(entry);
      rows.push({
        id: entry.id,
        path: path.join('/'),
        depth,
        name: entry.name,
        displayName: meta.displayName,
        quantity: meta.quantity,
        unitWeight: meta.unitWeight,
        totalWeight: meta.totalWeight,
        img: entry.img || Item.DEFAULT_ICON,
        system: entry.system ?? {},
        hasChildren: nested.contents.length > 0,
      });
      for (const child of nested.contents) visit(child, [...path, child.id], depth + 1);
    };

    let totalItems = 0;
    let totalWeight = 0;
    for (const entry of storage.contents) {
      const meta = usageOf(entry);
      totalItems += meta.quantity;
      totalWeight += meta.totalWeight;
      visit(entry, [entry.id], 0);
    }

    return {
      containerStorageRows: rows,
      containerTotalWeight: Math.round(totalWeight * 100) / 100,
      containerTotalItems: totalItems,
      containerLimitMaxItems: Math.max(0, Math.floor(Number(ammo.capacity) || 0)),
      containerLimitMaxWeight: limits.maxWeight,
    };
  }

  /**
   * @param {Actor} actor
   * @returns {{ containerGear: object[], containerTotalWeight: number, containerTotalItems: number }}
   */
  _buildActorContainerPanelContext(actor) {
    const empty = { containerGear: [], containerTotalWeight: 0, containerTotalItems: 0 };
    if (!actor?.items) return empty;
    const hostId = String(this.item?.id ?? '').trim();
    if (!hostId) return empty;
    const { container } = normalizeItemContainerFields(this.item.system);
    const byId = new Map();
    for (const it of actor.items) byId.set(it.id, it);
    const rows = [];
    const seen = new Set();
    const pushRow = (it) => {
      if (!it || it.type !== 'item' || it.id === hostId) return;
      if (String(it.system?.containerHostId ?? '').trim() !== hostId) return;
      rows.push({
        entryKind: 'actor',
        _id: it.id,
        name: it.name,
        img: it.img || Item.DEFAULT_ICON,
        system: {
          description: it.system?.description,
          quantity: it.system?.quantity,
          weight: it.system?.weight,
        },
      });
      seen.add(it.id);
    };
    for (const entry of container.contents) {
      if (entry.kind !== ENTRY_ACTOR_ITEM) continue;
      pushRow(byId.get(entry.itemId));
    }
    for (const it of actor.items) {
      if (!seen.has(it.id)) pushRow(it);
    }
    let tw = 0;
    let ti = 0;
    for (const r of rows) {
      const q = Number(r.system?.quantity) || 0;
      const w = Number(r.system?.weight) || 0;
      ti += q;
      tw += w * q;
    }
    return {
      containerGear: rows,
      containerTotalWeight: Math.round(tw * 100) / 100,
      containerTotalItems: ti,
    };
  }

  /**
   * @returns {Promise<{ containerGear: object[], containerTotalWeight: number, containerTotalItems: number }>}
   */
  async _buildWorldContainerPanelContext() {
    const L = (k) => game.i18n?.localize?.(k) ?? k;
    const { container } = normalizeItemContainerFields(this.item.system);
    const rows = [];
    let tw = 0;
    let ti = 0;
    for (const entry of container.contents) {
      if (entry.kind !== ENTRY_WORLD_UUID) continue;
      let doc = null;
      try {
        doc = await fromUuid(entry.uuid);
      } catch (_) {
        doc = null;
      }
      if (!doc || doc.documentName !== 'Item') {
        rows.push({
          entryKind: 'world',
          worldUuid: entry.uuid,
          broken: true,
          name: L('SPACEHOLDER.ItemContainer.BrokenLink'),
          img: Item.DEFAULT_ICON,
          system: { description: '', quantity: 0, weight: 0 },
        });
        continue;
      }
      const q = Number(doc.system?.quantity) || 0;
      const w = Number(doc.system?.weight) || 0;
      ti += q;
      tw += w * q;
      rows.push({
        entryKind: 'world',
        worldUuid: entry.uuid,
        broken: false,
        name: doc.name,
        img: doc.img || Item.DEFAULT_ICON,
        system: {
          description: doc.system?.description,
          quantity: doc.system?.quantity,
          weight: doc.system?.weight,
        },
      });
    }
    return {
      containerGear: rows,
      containerTotalWeight: Math.round(tw * 100) / 100,
      containerTotalItems: ti,
    };
  }

  /**
   * @returns {object}
   */
  _getWeaponData() {
    return foundry.utils.duplicate(this.item?.system?.weapon ?? {});
  }

  /**
   * @param {object} nextWeapon
   */
  async _setWeaponData(nextWeapon) {
    const merged = migrateItemWeaponData(nextWeapon, this.item.system.itemTags);
    const patch = { 'system.weapon': merged };
    const pending = this._getPendingNameFromForm();
    if (pending && pending !== String(this.item.name ?? '').trim()) {
      patch.name = pending;
    }
    const pendingQty = this._getPendingQuantityFromForm();
    if (pendingQty !== null) {
      const cur = Math.max(0, Math.floor(Number(this.item.system?.quantity ?? 1)));
      if (pendingQty !== cur) patch['system.quantity'] = pendingQty;
    }
    await this.item.update(patch);
  }

  /* ------------------------------------------------------------------ *
   *  Weapon v3: контекст вкладки «Оружие»                                *
   * ------------------------------------------------------------------ */

  /**
   * Контекст редактора саб-блока урона.
   * @param {object[]} entries normalized damage entries
   * @param {string} basePath dot-path внутри weapon (например `lines.0.damage`)
   */
  _damageEntriesV3Context(entries, basePath) {
    const list = Array.isArray(entries) ? entries : [];
    return {
      basePath,
      rows: list.map((entry, i) => ({
        ...entry,
        index: i,
        path: `${basePath}.${i}`,
        energy: Math.round(computeProjectileEnergy(entry) * 100) / 100,
      })),
    };
  }

  /**
   * @param {object} ergo
   * @param {(key: string) => string} L
   */
  _buildWeaponV3ErgoRows(ergo, L) {
    return [
      { label: L('SPACEHOLDER.WeaponV3.Ergo.Overall'), display: _wv3FmtPct(ergo?.overall) },
      { label: L('SPACEHOLDER.WeaponV3.Ergo.Zones'), display: _wv3FmtZones(ergo?.zones) },
      { label: L('SPACEHOLDER.WeaponV3.Ergo.DeadZone'), display: _wv3FmtToggleable(ergo?.deadZone, '%') },
      { label: L('SPACEHOLDER.WeaponV3.Ergo.AimPenalty'), display: _wv3FmtToggleable(ergo?.aimPenalty, '%') },
      { label: L('SPACEHOLDER.WeaponV3.Ergo.CritZoneBonus'), display: _wv3FmtToggleable(ergo?.critZoneBonus) },
      { label: L('SPACEHOLDER.WeaponV3.Ergo.CritZoneSize'), display: _wv3FmtToggleable(ergo?.critZoneSize, '%') },
      { label: L('SPACEHOLDER.WeaponV3.Ergo.Readying'), display: _wv3FmtToggleable(ergo?.readying) },
    ];
  }

  /**
   * @param {object} line
   * @param {(key: string) => string} L
   */
  _buildWeaponV3LineParamRows(line, L) {
    const kind = normalizeTrajectoryKind(line.trajectoryKind);
    const rows = [
      { label: L('SPACEHOLDER.WeaponV3.Line.Aiming'), display: _wv3FmtNumber(line.aiming) },
      { label: L('SPACEHOLDER.WeaponV3.Line.Trigger'), display: _wv3FmtNumber(line.trigger) },
      {
        label: L('SPACEHOLDER.WeaponV3.Trajectory.Kind'),
        display: kind === TRAJECTORY_KINDS.COMPLEX
          ? L('SPACEHOLDER.WeaponV3.Trajectory.KindComplex')
          : L('SPACEHOLDER.WeaponV3.Trajectory.KindSimple'),
      },
    ];
    if (kind === TRAJECTORY_KINDS.COMPLEX) {
      rows.push({
        label: L('SPACEHOLDER.WeaponV3.Line.PayloadId'),
        display: _wv3FmtText(line.payloadId),
        text: true,
      });
    } else {
      rows.push({
        label: L('SPACEHOLDER.WeaponV3.Trajectory.Length'),
        display: formatTrajectorySummary(line, L),
        text: true,
      });
    }
    rows.push(
      { label: L('SPACEHOLDER.WeaponV3.Line.EnergyMult'), display: _wv3FmtToggleable(line.energyMult, '%') },
      { label: L('SPACEHOLDER.WeaponV3.Line.Spread'), display: _wv3FmtToggleable(line.spread) },
      { label: L('SPACEHOLDER.WeaponV3.Line.Recoil'), display: _wv3FmtToggleable(line.recoil) },
      { label: L('SPACEHOLDER.WeaponV3.Line.EnterCost'), display: _wv3FmtToggleable(line.enterCost) },
      { label: L('SPACEHOLDER.WeaponV3.Line.ExitCost'), display: _wv3FmtToggleable(line.exitCost) },
    );
    return rows;
  }

  /**
   * @param {object} block
   * @param {(key: string) => string} L
   */
  _buildWeaponV3BlockDisplayRows(block, L) {
    const rows = [];
    rows.push({
      label: L('SPACEHOLDER.WeaponV3.Block.Capacity'),
      display: _wv3FmtNumber(block.capacity),
    });
    if (block.isItemFed && !block.isExternalMagazine) {
      rows.push({
        label: L('SPACEHOLDER.WeaponV3.Block.LoadAmount'),
        display: _wv3FmtNumber(block.loadAmount),
      });
    }
    rows.push({ label: L('SPACEHOLDER.WeaponV3.Block.Chamber'), display: _wv3FmtBool(!!block.chamberEnabled) });
    if (block.chamberEnabled) {
      rows.push({ label: L('SPACEHOLDER.WeaponV3.Block.AutoFeed'), display: _wv3FmtBool(!!block.autoFeed) });
    }
    if (block.isItemFed) {
      rows.push({ label: L('SPACEHOLDER.WeaponV3.Block.Caliber'), display: _wv3FmtText(block.caliber), text: true });
      const groups = [];
      if (block.search?.hands) groups.push(L('SPACEHOLDER.WeaponV3.Ammo.Group.hands'));
      if (block.search?.worn) groups.push(L('SPACEHOLDER.WeaponV3.Ammo.Group.worn'));
      if (block.search?.inventory) groups.push(L('SPACEHOLDER.WeaponV3.Ammo.Group.inventory'));
      if (block.search?.containers) groups.push(L('SPACEHOLDER.WeaponV3.Ammo.Group.containers'));
      const mode = L(`SPACEHOLDER.WeaponV3.Block.SearchModes.${block.search?.mode ?? 'auto'}`);
      rows.push({
        label: L('SPACEHOLDER.WeaponV3.Block.Search'),
        display: groups.length ? `${groups.join(', ')} · ${mode}` : mode,
        text: true,
      });
    }
    if (block.isExternalMagazine) {
      rows.push({ label: L('SPACEHOLDER.WeaponV3.Block.Connector'), display: _wv3FmtText(block.connector), text: true });
      if (block.magazineName) {
        rows.push({ label: L('SPACEHOLDER.WeaponV3.Ammo.PickMagazineTitle'), display: block.magazineName, text: true });
      }
    }
    if (block.isInternalCharge) {
      rows.push({ label: L('SPACEHOLDER.WeaponV3.Block.Charge'), display: _wv3FmtNumber(block.runtime?.charge) });
    }
    for (const ap of block.apRows ?? []) {
      if (ap.enabled) rows.push({ label: ap.label, display: _wv3FmtNumber(ap.value) });
    }
    return rows;
  }

  /**
   * @param {object} mode
   * @param {(key: string) => string} L
   */
  _buildWeaponV3ModeDisplayRows(mode, L) {
    const rows = [
      {
        label: L('SPACEHOLDER.WeaponV3.Mode.Title'),
        display: L(`SPACEHOLDER.WeaponV3.Mode.FireModes.${mode.fireMode}`),
      },
    ];
    if (mode.isBurst) {
      rows.push({ label: L('SPACEHOLDER.WeaponV3.Mode.BurstCount'), display: _wv3FmtNumber(mode.burstCount) });
    }
    if (!mode.isSingle) {
      rows.push({
        label: L('SPACEHOLDER.WeaponV3.Mode.Rpm'),
        display: String(mode.rpmDisplay ?? '—'),
      });
    }
    rows.push(
      { label: L('SPACEHOLDER.WeaponV3.Mode.EnterCost'), display: _wv3FmtToggleable(mode.enterCost) },
      { label: L('SPACEHOLDER.WeaponV3.Mode.ExitCost'), display: _wv3FmtToggleable(mode.exitCost) },
    );
    const modCount = Array.isArray(mode.modifiers) ? mode.modifiers.filter((m) => m?.enabled).length : 0;
    rows.push({
      label: L('SPACEHOLDER.WeaponV3.Mode.Modifiers'),
      display: modCount ? String(modCount) : _wv3FmtBool(false),
    });
    return rows;
  }

  /**
   * Контекст вкладки «Оружие» (v3): эргономика, линии, блоки, режимы.
   * Вкладка — статичное отображение; input'ы только в диалогах редактирования.
   * @param {object} weapon normalized v3 weapon
   */
  _buildWeaponV3Context(weapon) {
    const L = (k) => game.i18n?.localize?.(k) ?? k;
    const blockTypeOptions = AMMO_BLOCK_TYPE_LIST.map((t) => ({
      value: t,
      label: L(`SPACEHOLDER.WeaponV3.Block.Types.${t}`),
    }));
    const fireModeOptions = Object.values(FIRE_MODES).map((m) => ({
      value: m,
      label: L(`SPACEHOLDER.WeaponV3.Mode.FireModes.${m}`),
    }));
    const searchModeOptions = Object.values(AMMO_SEARCH_MODES).map((m) => ({
      value: m,
      label: L(`SPACEHOLDER.WeaponV3.Block.SearchModes.${m}`),
    }));
    const modOpOptions = Object.values(MOD_OPS).map((op) => ({
      value: op,
      label: L(`SPACEHOLDER.WeaponV3.Mode.ModOps.${op}`),
    }));
    const modParamOptions = MODE_MODIFIER_PARAMS.map((p) => ({
      value: p.id,
      label: L(p.labelKey),
    }));

    const lines = (weapon.lines ?? []).map((line, li) => {
      const lp = `lines.${li}`;
      const ammoBlocks = (line.ammoBlocks ?? []).map((block, bi) => {
        const bp = `${lp}.ammoBlocks.${bi}`;
        const isInternalCharge = block.type === AMMO_BLOCK_TYPES.INTERNAL_CHARGE;
        const isExternalMagazine = block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE;
        const isItemFed = !isInternalCharge;
        return {
          ...block,
          index: bi,
          path: bp,
          typeLabel: L(`SPACEHOLDER.WeaponV3.Block.Types.${block.type}`),
          counter: formatAmmoCounter(block, this.item?.parent?.documentName === 'Actor' ? this.item.parent : null),
          isInternalCharge,
          isExternalMagazine,
          isItemFed,
          hasWeaponDamage: WEAPON_DAMAGE_BLOCK_TYPES.includes(block.type),
          damageCtx: WEAPON_DAMAGE_BLOCK_TYPES.includes(block.type)
            ? this._damageEntriesV3Context(block.damage, `${bp}.damage`)
            : null,
          apRows: Object.entries(block.apActions ?? {}).map(([key, ap]) => ({
            key,
            label: L(`SPACEHOLDER.WeaponV3.Block.Ap.${key}`),
            enabled: !!ap?.enabled,
            value: Number(ap?.value) || 0,
            path: `${bp}.apActions.${key}`,
          })),
          magazineName: block.runtime?.magazine?.name ?? '',
        };
      });
      const modes = (line.modes ?? []).map((mode, mi) => {
        const mp = `${lp}.modes.${mi}`;
        const rpm = fireDelayToRpm(mode.fireDelayAp);
        return {
          ...mode,
          index: mi,
          path: mp,
          isSingle: mode.fireMode === FIRE_MODES.SINGLE,
          isBurst: mode.fireMode === FIRE_MODES.BURST,
          isAuto: mode.fireMode === FIRE_MODES.AUTO,
          rpmDisplay: Number.isFinite(rpm) ? rpm : '∞',
          modifiers: (mode.modifiers ?? []).map((mod, xi) => ({
            ...mod,
            index: xi,
            path: `${mp}.modifiers.${xi}`,
          })),
        };
      });
      const showLineDamage = ammoBlocks.length === 0;
      const damageCtx = this._damageEntriesV3Context(line.damage, `${lp}.damage`);
      const displayName = String(line.name ?? '').trim() || L('SPACEHOLDER.WeaponV3.Line.Default');
      const trajectoryKind = normalizeTrajectoryKind(line.trajectoryKind);
      return {
        ...line,
        index: li,
        path: lp,
        trajectoryKind,
        isSimpleTrajectory: trajectoryKind === TRAJECTORY_KINDS.SIMPLE,
        isComplexTrajectory: trajectoryKind === TRAJECTORY_KINDS.COMPLEX,
        simpleLimitEnabled: !!line.simpleLimit?.enabled,
        ammoBlocks,
        modes,
        showLineDamage,
        damageCtx,
        displayName,
        paramRows: this._buildWeaponV3LineParamRows(line, L),
        damageSummary: showLineDamage ? _wv3FmtDamageSummary(damageCtx) : '',
        blockSummaries: ammoBlocks.map((block) => ({
          title: `${block.typeLabel} [${block.counter}]`,
          rows: this._buildWeaponV3BlockDisplayRows(block, L),
          damageSummary: block.hasWeaponDamage ? _wv3FmtDamageSummary(block.damageCtx) : '',
        })),
        modeSummaries: modes.map((mode) => ({
          title: String(mode.name ?? '').trim() || L('SPACEHOLDER.WeaponV3.Mode.Default'),
          rows: this._buildWeaponV3ModeDisplayRows(mode, L),
        })),
      };
    });

    return {
      ergonomics: weapon.ergonomics,
      ergoRows: this._buildWeaponV3ErgoRows(weapon.ergonomics, L),
      lines,
      state: weapon.state,
      blockTypeOptions,
      fireModeOptions,
      searchModeOptions,
      modOpOptions,
      modParamOptions,
      trajectoryKindOptions: [
        { value: TRAJECTORY_KINDS.SIMPLE, label: L('SPACEHOLDER.WeaponV3.Trajectory.KindSimple') },
        { value: TRAJECTORY_KINDS.COMPLEX, label: L('SPACEHOLDER.WeaponV3.Trajectory.KindComplex') },
      ],
      trajectoryUnitOptions: [
        { value: TRAJECTORY_LENGTH_UNITS.GRID, label: L('SPACEHOLDER.WeaponV3.Trajectory.UnitGrid') },
        { value: TRAJECTORY_LENGTH_UNITS.MEASURE, label: L('SPACEHOLDER.WeaponV3.Trajectory.UnitMeasure') },
      ],
      payloadOptions: [],
    };
  }

  /**
   * Контекст вкладки «Боеприпас» (v3): weapon.ammo.
   * @param {object} ammo normalized ammo config
   */
  _buildAmmoV3Context(ammo) {
    return {
      ...ammo,
      damageCtx: this._damageEntriesV3Context(ammo.damage, 'ammo.damage'),
    };
  }

  /* ------------------------------------------------------------------ *
   *  Weapon v3: обработчики вкладок «Оружие» / «Боеприпас»               *
   * ------------------------------------------------------------------ */

  /**
   * Прочитать значение input'а с data-wpath согласно data-wdtype.
   * @param {HTMLElement} el
   */
  _readWeaponV3Input(el) {
    const dtype = String(el.dataset.wdtype ?? 'String');
    if (el.type === 'checkbox') return !!el.checked;
    const raw = String(el.value ?? '').trim();
    if (dtype === 'Number') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    }
    if (dtype === 'Int') {
      const n = Math.floor(Number(raw));
      return Number.isFinite(n) ? n : 0;
    }
    if (dtype === 'Boolean') return raw === 'true' || raw === '1';
    return raw;
  }

  /**
   * Прочитать все `data-wpath` из корня формы в объект weapon.
   * @param {HTMLElement|null|undefined} root
   * @param {object} target
   */
  _applyWeaponV3FormFromRoot(root, target) {
    if (!root || !target) return;
    for (const input of root.querySelectorAll('[data-wpath]')) {
      foundry.utils.setProperty(target, String(input.dataset.wpath), this._readWeaponV3Input(input));
    }
  }

  /**
   * Структурные операции v3 (`data-waction`) над черновиком weapon.
   * @param {string} action
   * @param {DOMStringMap} ds
   * @param {object} w
   * @param {ParentNode|null|undefined} [scopeRoot]
   * @returns {boolean} true если данные изменены
   */
  _mutateWeaponV3Draft(action, ds, w, scopeRoot = null) {
    const lines = Array.isArray(w.lines) ? w.lines : (w.lines = []);
    const lineAt = () => lines[Number(ds.line)];
    const scope = scopeRoot ?? this.element;
    switch (action) {
      case 'line-add':
        lines.push(createWeaponLine());
        return true;
      case 'line-remove': {
        if (lines.length <= 1) {
          ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.WeaponV3.Line.LastLine') ?? 'A weapon needs at least one line');
          return false;
        }
        lines.splice(Number(ds.line), 1);
        return true;
      }
      case 'mode-add': {
        const line = lineAt();
        if (!line) return false;
        line.modes = Array.isArray(line.modes) ? line.modes : [];
        line.modes.push(createWeaponMode());
        return true;
      }
      case 'mode-remove': {
        const line = lineAt();
        if (!line || !Array.isArray(line.modes)) return false;
        if (line.modes.length <= 1) {
          ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.WeaponV3.Mode.LastMode') ?? 'A line needs at least one mode');
          return false;
        }
        line.modes.splice(Number(ds.mode), 1);
        return true;
      }
      case 'toggle-change-sign': {
        const path = String(ds.signPath ?? '').trim();
        if (!path) return false;
        const cur = foundry.utils.getProperty(w, path);
        foundry.utils.setProperty(w, path, cur === '+' ? '-' : '+');
        return true;
      }
      case 'block-add': {
        const line = lineAt();
        if (!line) return false;
        const sel = scope?.querySelector?.(`select[data-wblock-type-for="${ds.line}"]`);
        const type = String(sel?.value ?? AMMO_BLOCK_TYPES.INTERNAL_MAGAZINE);
        line.ammoBlocks = Array.isArray(line.ammoBlocks) ? line.ammoBlocks : [];
        line.ammoBlocks.push(createAmmoBlock(type));
        return true;
      }
      case 'block-remove': {
        const line = lineAt();
        if (!line || !Array.isArray(line.ammoBlocks)) return false;
        line.ammoBlocks.splice(Number(ds.block), 1);
        return true;
      }
      case 'mod-add': {
        const line = lineAt();
        const mode = line?.modes?.[Number(ds.mode)];
        if (!mode) return false;
        mode.modifiers = Array.isArray(mode.modifiers) ? mode.modifiers : [];
        mode.modifiers.push(createModeModifier());
        return true;
      }
      case 'mod-remove': {
        const line = lineAt();
        const mode = line?.modes?.[Number(ds.mode)];
        if (!mode || !Array.isArray(mode.modifiers)) return false;
        mode.modifiers.splice(Number(ds.mod), 1);
        return true;
      }
      case 'dmg-add': {
        const basePath = String(ds.dmgPath ?? '');
        if (!basePath) return false;
        const list = foundry.utils.getProperty(w, basePath);
        const arr = Array.isArray(list) ? list : [];
        arr.push(defaultDamageEntry());
        foundry.utils.setProperty(w, basePath, arr);
        return true;
      }
      case 'dmg-remove': {
        const basePath = String(ds.dmgPath ?? '');
        const list = foundry.utils.getProperty(w, basePath);
        if (!basePath || !Array.isArray(list)) return false;
        list.splice(Number(ds.index), 1);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Структурные операции вкладок v3 (`data-waction`) с немедленным сохранением.
   * @param {string} action
   * @param {DOMStringMap} ds dataset кнопки
   */
  async _handleWeaponV3Action(action, ds) {
    const w = this._getWeaponData();
    const root = this.element?.querySelector?.('[data-sh-weapon-v3-root]');
    if (root) this._applyWeaponV3FormFromRoot(root, w);
    if (!this._mutateWeaponV3Draft(action, ds, w)) return;
    await this._setWeaponData(w);
  }

  /**
   * @param {'ergonomics'|'line'|'blocks'|'modes'} kind
   * @param {object} draft
   * @param {number|null} lineIndex
   */
  async _renderWeaponV3DialogBody(kind, draft, lineIndex = null) {
    const editTpl = WEAPON_V3_DIALOG_EDIT_TEMPLATES[kind];
    if (!editTpl) return '';
    const w = this._buildWeaponV3Context(draft);
    if (kind === 'line') {
      w.payloadOptions = this._context?.weaponV3?.payloadOptions?.length
        ? this._context.weaponV3.payloadOptions
        : await this._getActionPayloadOptions();
    }
    const ctx = { w, editable: true };
    if (kind !== 'ergonomics') {
      const li = Number(lineIndex);
      ctx.line = w.lines?.[li];
      if (!ctx.line) return '';
    }
    return foundry.applications.handlebars.renderTemplate(editTpl, ctx);
  }

  /**
   * @param {HTMLElement} dialogRoot
   * @param {{ kind: string, draft: object, lineIndex: number|null, dialogUid: string }} opts
   */
  _bindWeaponV3DialogListeners(dialogRoot, opts) {
    if (!dialogRoot || dialogRoot.dataset.shWeaponV3DialogBound === '1') return;
    dialogRoot.dataset.shWeaponV3DialogBound = '1';

    const rerender = async () => {
      const body = await this._renderWeaponV3DialogBody(opts.kind, opts.draft, opts.lineIndex);
      const mount = dialogRoot.querySelector('[data-sh-weapon-v3-dialog-body]');
      if (mount) mount.innerHTML = body;
    };

    dialogRoot.addEventListener('change', async (ev) => {
      const el = ev.target?.closest?.('[data-wpath]');
      if (!el || !dialogRoot.contains(el)) return;
      const path = String(el.dataset.wpath ?? '');
      if (
        path.endsWith('.trajectoryKind')
        || path.endsWith('.simpleLimit.enabled')
      ) {
        this._applyWeaponV3FormFromRoot(dialogRoot, opts.draft);
        await rerender();
      }
    });

    dialogRoot.addEventListener('click', async (ev) => {
      const btn = ev.target?.closest?.('[data-waction]');
      if (!btn || !dialogRoot.contains(btn)) return;
      ev.preventDefault();
      ev.stopPropagation();
      this._applyWeaponV3FormFromRoot(dialogRoot, opts.draft);
      if (!this._mutateWeaponV3Draft(String(btn.dataset.waction), btn.dataset, opts.draft, dialogRoot)) return;
      await rerender();
    });
  }

  /**
   * @param {'ergonomics'|'line'|'blocks'|'modes'} kind
   * @param {number|null} [lineIndex]
   */
  async _openWeaponV3Dialog(kind, lineIndex = null) {
    const editTpl = WEAPON_V3_DIALOG_EDIT_TEMPLATES[kind];
    if (!editTpl) return;
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2?.wait) {
      ui.notifications?.warn?.(
        game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.FreeAction.DialogUnavailable') ?? 'Dialog is unavailable'
      );
      return;
    }

    const draft = this._getWeaponData();
    if (kind !== 'ergonomics') {
      const li = Number(lineIndex);
      if (!Number.isInteger(li) || !draft.lines?.[li]) return;
    }

    const dialogUid = this._newActionId();
    const body = await this._renderWeaponV3DialogBody(kind, draft, lineIndex);
    const content = await foundry.applications.handlebars.renderTemplate(
      'systems/spaceholder/templates/item/parts/item-weapon-v3-dialog.hbs',
      { dialogUid, body }
    );

    const dialogOpts = { kind, draft, lineIndex, dialogUid };
    const bindTimer = globalThis.setInterval?.(() => {
      const root =
        typeof document !== 'undefined'
          ? document.querySelector(`[data-sh-weapon-v3-dialog="${dialogUid}"]`)
          : null;
      if (root) {
        this._bindWeaponV3DialogListeners(root, dialogOpts);
        globalThis.clearInterval?.(bindTimer);
      }
    }, 40);
    globalThis.setTimeout?.(() => globalThis.clearInterval?.(bindTimer), 2500);

    const titleKey = WEAPON_V3_DIALOG_TITLE_KEYS[kind];
    await DialogV2.wait({
      classes: ['spaceholder'],
      window: {
        title: game.i18n?.localize?.(titleKey) ?? 'Weapon',
        icon: 'fa-solid fa-pen-to-square',
      },
      position: { width: kind === 'ergonomics' ? 480 : 560 },
      content,
      buttons: [
        {
          action: 'save',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Save') ?? 'Save',
          icon: 'fa-solid fa-check',
          default: true,
          callback: async (dlgEvent) => {
            const root =
              dlgEvent?.currentTarget?.form ||
              dlgEvent?.target?.form ||
              dlgEvent?.currentTarget?.closest?.('form') ||
              dlgEvent?.target?.closest?.('form') ||
              dlgEvent?.currentTarget?.closest?.('.window-content') ||
              (typeof document !== 'undefined'
                ? document.querySelector(`[data-sh-weapon-v3-dialog="${dialogUid}"]`)
                : null);
            this._applyWeaponV3FormFromRoot(root, draft);
            await this._setWeaponData(draft);
          },
        },
        {
          action: 'cancel',
          label: game.i18n?.localize?.('SPACEHOLDER.Actions.Cancel') ?? 'Cancel',
          icon: 'fa-solid fa-times',
        },
      ],
    });
  }

  /**
   * Делегированные обработчики вкладки «Оружие» (v3).
   * Вкладка read-only: структурные кнопки + открытие диалогов редактирования.
   */
  _bindWeaponV3Listeners() {
    const el = this.element;
    if (!el || !this.isEditable) return;
    for (const root of el.querySelectorAll('[data-sh-weapon-v3-root]')) {
      if (root.dataset.shWeaponV3Bound === '1') continue;
      root.dataset.shWeaponV3Bound = '1';

      root.addEventListener('click', async (ev) => {
        const dlgBtn = ev.target?.closest?.('[data-wdialog]');
        if (dlgBtn && root.contains(dlgBtn)) {
          ev.preventDefault();
          ev.stopPropagation();
          const kind = String(dlgBtn.dataset.wdialog ?? '');
          const lineRaw = dlgBtn.dataset.line;
          const lineIndex = lineRaw === undefined || lineRaw === '' ? null : Number(lineRaw);
          await this._openWeaponV3Dialog(kind, lineIndex);
          return;
        }

        const btn = ev.target?.closest?.('[data-waction]');
        if (!btn || !root.contains(btn)) return;
        ev.preventDefault();
        ev.stopPropagation();
        await this._handleWeaponV3Action(String(btn.dataset.waction), btn.dataset);
      });
    }
  }

  /**
   * Hybrid Ammo+Container items use plain nested-storage snapshots on the
   * Container tab, while normal containers keep the actor embedded-item model.
   * @returns {boolean}
   */
  _usesNestedStorageContainer() {
    const tags = this.item?.system?.itemTags ?? {};
    return !!(tags.isAmmo && tags.isContainer);
  }

  /**
   * @param {unknown} raw
   * @returns {string[]}
   */
  _nestedStoragePath(raw) {
    return String(raw ?? '').split('/').map((p) => p.trim()).filter(Boolean);
  }

  /**
   * @param {Item|object|null|undefined} itemLike
   * @returns {boolean}
   */
  _isLooseAmmoForNestedContainer(itemLike) {
    const tags = itemLike?.system?.itemTags ?? {};
    if (!tags.isAmmo) return false;
    const ammo = normalizeAmmoConfig(itemLike?.system?.weapon?.ammo);
    return !ammo.connector.enabled;
  }

  /**
   * @param {Item|object|null|undefined} itemLike
   * @returns {boolean}
   */
  _isAmmoCompatibleWithNestedContainer(itemLike) {
    if (!this._isLooseAmmoForNestedContainer(itemLike)) return false;
    const magAmmo = normalizeAmmoConfig(this.item?.system?.weapon?.ammo);
    const roundAmmo = normalizeAmmoConfig(itemLike?.system?.weapon?.ammo);
    const magCaliber = String(magAmmo.caliber ?? '').trim();
    const roundCaliber = String(roundAmmo.caliber ?? '').trim();
    if (!magCaliber || !roundCaliber) return true;
    return compatMatches(magCaliber, roundCaliber);
  }

  /**
   * @param {Item|object} source
   * @returns {{ ok: boolean, quantity: number, reason: ''|'maxItems'|'maxWeight' }}
   */
  _resolveNestedStorageAddQuantity(source) {
    const sourceQty = Math.max(1, Math.floor(Number(source?.system?.quantity) || 1));
    let quantity = sourceQty;
    const panel = this._buildNestedStorageContainerPanelContext(this.item?.system ?? {});
    const maxItems = panel.containerLimitMaxItems;
    if (maxItems > 0) {
      const byItems = maxItems - panel.containerTotalItems;
      if (byItems <= 0) return { ok: false, quantity: 0, reason: 'maxItems' };
      quantity = Math.min(quantity, byItems);
    }
    const maxWeight = panel.containerLimitMaxWeight;
    if (maxWeight > 0) {
      const unitWeight = Math.max(0, Number(source?.system?.weight) || 0);
      if (unitWeight > 0) {
        const byWeight = Math.floor((maxWeight - panel.containerTotalWeight) / unitWeight);
        if (byWeight <= 0) return { ok: false, quantity: 0, reason: 'maxWeight' };
        quantity = Math.min(quantity, byWeight);
      } else if (panel.containerTotalWeight > maxWeight) {
        return { ok: false, quantity: 0, reason: 'maxWeight' };
      }
    }
    return { ok: quantity > 0, quantity: Math.max(0, quantity), reason: quantity > 0 ? '' : 'maxItems' };
  }

  /**
   * Dialog editor for container limits. Hybrid Ammo+Container items keep their
   * item-count limit in the Ammo tab (`ammo.capacity`), so this dialog only
   * edits the shared weight limit for them.
   */
  async _openItemContainerLimitsDialog() {
    if (!this.isEditable || !this.item?.system?.itemTags?.isContainer) return;
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2?.wait) return;

    const L = (k) => game.i18n?.localize?.(k) ?? k;
    const escape = foundry.utils?.escapeHTML ?? ((s) => String(s ?? ''));
    const usesNested = this._usesNestedStorageContainer();
    const { container } = normalizeItemContainerFields(this.item.system);
    const ammo = normalizeAmmoConfig(this.item.system?.weapon?.ammo);
    const maxItems = usesNested
      ? Math.max(0, Math.floor(Number(ammo.capacity) || 0))
      : container.limits.maxItems;
    const maxWeight = container.limits.maxWeight;

    const itemLimitBody = usesNested
      ? `<div class="form-fields"><span class="spaceholder-item-container-limit-source">${escape(L('SPACEHOLDER.ItemContainer.LimitItemsFromAmmoCapacity'))}: ${maxItems || escape(L('SPACEHOLDER.ItemContainer.Unlimited'))}</span></div>`
      : `<div class="form-fields"><input id="sh-container-limit-items" type="number" min="0" step="1" value="${maxItems}" /></div>`;

    await DialogV2.wait({
      classes: ['spaceholder'],
      window: {
        title: L('SPACEHOLDER.ItemContainer.LimitsDialogTitle'),
        icon: 'fa-solid fa-box-open',
      },
      position: { width: 420 },
      content: `
        <div class="spaceholder-item-container-limits-dialog">
          <div class="form-group">
            <label for="sh-container-limit-items">${escape(L('SPACEHOLDER.ItemContainer.LimitItems'))}</label>
            ${itemLimitBody}
          </div>
          <div class="form-group">
            <label for="sh-container-limit-weight">${escape(L('SPACEHOLDER.ItemContainer.LimitWeight'))}</label>
            <div class="form-fields">
              <input id="sh-container-limit-weight" type="number" min="0" step="0.01" value="${maxWeight}" />
            </div>
          </div>
          <p class="hint">${escape(L('SPACEHOLDER.ItemContainer.LimitZeroUnlimited'))}</p>
        </div>
      `,
      buttons: [
        {
          action: 'save',
          label: L('SPACEHOLDER.Actions.Save'),
          icon: 'fa-solid fa-check',
          default: true,
          callback: async (dlgEvent) => {
            const root =
              dlgEvent?.currentTarget?.form ||
              dlgEvent?.target?.form ||
              dlgEvent?.currentTarget?.closest?.('form') ||
              dlgEvent?.target?.closest?.('form') ||
              dlgEvent?.currentTarget;
            const rawWeight = root?.querySelector?.('#sh-container-limit-weight')?.value ?? maxWeight;
            const weightNumber = Number(rawWeight);
            const nextLimits = {
              ...container.limits,
              maxWeight: Number.isFinite(weightNumber) ? Math.max(0, weightNumber) : 0,
            };
            if (!usesNested) {
              const rawItems = root?.querySelector?.('#sh-container-limit-items')?.value ?? maxItems;
              const itemNumber = Math.floor(Number(rawItems));
              nextLimits.maxItems = Number.isFinite(itemNumber) ? Math.max(0, itemNumber) : 0;
            }
            const patch = {
              'system.container': {
                ...container,
                limits: nextLimits,
              },
            };
            const pending = this._getPendingNameFromForm();
            if (pending && pending !== String(this.item.name ?? '').trim()) {
              patch.name = pending;
            }
            const pendingQty = this._getPendingQuantityFromForm();
            if (pendingQty !== null) {
              const cur = Math.max(0, Math.floor(Number(this.item.system?.quantity ?? 1)));
              if (pendingQty !== cur) patch['system.quantity'] = pendingQty;
            }
            await this.item.update(patch);
            this._activeTabPrimary = 'container';
          },
        },
        {
          action: 'cancel',
          label: L('SPACEHOLDER.Actions.Cancel'),
          icon: 'fa-solid fa-times',
        },
      ],
    });
    await this.render(false);
  }

  /**
   * Вкладка «Контейнер» для магазина: DnD, извлечение, удаление.
   */
  _bindNestedStorageContainerListeners() {
    const el = this.element;
    if (!el) return;
    const readOnly = !this.isEditable;
    const L = (k) => game.i18n?.localize?.(k) ?? k;

    el.querySelectorAll('[data-action="sh-item-container-limits-edit"]').forEach((btn) => {
      if (btn.dataset.shContainerLimitsBound === '1') return;
      btn.dataset.shContainerLimitsBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly) return;
        await this._openItemContainerLimitsDialog();
      });
    });

    const zone = el.querySelector('[data-sh-item-storage-drop]');
    if (zone && !readOnly && zone.dataset.shItemStorageZoneBound !== '1') {
      zone.dataset.shItemStorageZoneBound = '1';
      zone.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        try {
          ev.dataTransfer.dropEffect = 'copy';
        } catch (_) { /* ignore */ }
      });
      zone.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        await this._onNestedStorageExternalDrop(ev);
      });
    }

    el.querySelectorAll('[data-action="sh-item-storage-extract"]').forEach((btn) => {
      if (btn.dataset.shItemStorageBtnBound === '1') return;
      btn.dataset.shItemStorageBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly) return;
        const path = this._nestedStoragePath(ev.currentTarget?.dataset?.nestedPath);
        if (!path.length) return;
        const created = await extractNestedItemToActor({ containerItem: this.item, path, quantity: Number.MAX_SAFE_INTEGER });
        if (!created) {
          ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.NestedExtractFailed'));
          return;
        }
        this._activeTabPrimary = 'container';
        await this.render(false);
      });
    });

    el.querySelectorAll('[data-action="sh-item-storage-delete"]').forEach((btn) => {
      if (btn.dataset.shItemStorageBtnBound === '1') return;
      btn.dataset.shItemStorageBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly) return;
        const path = this._nestedStoragePath(ev.currentTarget?.dataset?.nestedPath);
        if (!path.length) return;
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          classes: ['spaceholder'],
          window: {
            title: L('SPACEHOLDER.Inventory.DeleteItem'),
            icon: 'fa-solid fa-trash',
          },
          content: `<p>${foundry.utils.escapeHTML(L('SPACEHOLDER.ItemContainer.NestedDeleteConfirm'))}</p>`,
          yes: { label: L('SPACEHOLDER.Actions.Delete'), icon: 'fa-solid fa-trash' },
          no: { label: L('SPACEHOLDER.Actions.Cancel'), icon: 'fa-solid fa-times' },
        });
        if (!confirmed) return;
        const ok = await deleteNestedItemFromStorage({ containerItem: this.item, path });
        if (!ok) return;
        this._activeTabPrimary = 'container';
        await this.render(false);
      });
    });
  }

  /**
   * @param {DragEvent} ev
   */
  async _onNestedStorageExternalDrop(ev) {
    if (!this.isEditable) return;
    const L = (k) => game.i18n?.localize?.(k) ?? k;
    let data = null;
    try {
      const raw = ev.dataTransfer?.getData?.('text/plain') ?? '';
      data = raw ? JSON.parse(raw) : null;
    } catch (_) {
      return;
    }
    if (!data || data.type !== 'Item' || !data.uuid) return;
    let doc = null;
    try {
      doc = await fromUuid(data.uuid);
    } catch (_) {
      doc = null;
    }
    if (!doc || doc.documentName !== 'Item') {
      ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.DropNotAnItem'));
      return;
    }
    if (doc.uuid === this.item.uuid) {
      ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.CycleWarning'));
      return;
    }
    const actor = this.item.parent?.documentName === 'Actor' ? this.item.parent : null;
    const sourceActor = doc.parent?.documentName === 'Actor' ? doc.parent : null;
    if (sourceActor && actor && sourceActor.id !== actor.id) {
      ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.DropWrongActor'));
      return;
    }
    if (!this._isAmmoCompatibleWithNestedContainer(doc)) {
      ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.IncompatibleAmmo'));
      return;
    }
    const qty = this._resolveNestedStorageAddQuantity(doc);
    if (!qty.ok) {
      ui.notifications?.warn?.(
        qty.reason === 'maxWeight'
          ? L('SPACEHOLDER.ItemContainer.MaxWeightExceeded')
          : L('SPACEHOLDER.ItemContainer.MagazineFull')
      );
      return;
    }
    const inserted = await addItemToNestedStorage({
      containerItem: this.item,
      item: doc,
      quantity: qty.quantity,
      consumeSource: !!sourceActor,
    });
    if (!inserted) {
      ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.NestedAddFailed'));
      return;
    }
    this._activeTabPrimary = 'container';
    await this.render(false);
  }

  /**
   * Вкладка «Контейнер»: DnD, создание, извлечение, синхронизация.
   */
  _bindItemContainerListeners() {
    if (!this.item?.system?.itemTags?.isContainer) return;
    if (this._usesNestedStorageContainer()) {
      this._bindNestedStorageContainerListeners();
      return;
    }
    const el = this.element;
    if (!el) return;

    const actor = this.item.parent?.documentName === 'Actor' ? this.item.parent : null;
    const readOnly = !this.isEditable;
    const actorMode = !!actor;

    const L = (k) => game.i18n?.localize?.(k) ?? k;

    el.querySelectorAll('[data-action="sh-item-container-limits-edit"]').forEach((btn) => {
      if (btn.dataset.shContainerLimitsBound === '1') return;
      btn.dataset.shContainerLimitsBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly) return;
        await this._openItemContainerLimitsDialog();
      });
    });

    const zone = el.querySelector('[data-sh-item-container-drop]');
    if (zone && !readOnly && zone.dataset.shContainerZoneBound !== '1') {
      zone.dataset.shContainerZoneBound = '1';
      zone.addEventListener('dragover', (ev) => {
        if (ev.target?.closest?.('.item-container-item-card')) return;
        ev.preventDefault();
        try {
          ev.dataTransfer.dropEffect = 'copy';
        } catch (_) { /* ignore */ }
      });
      zone.addEventListener('drop', async (ev) => {
        if (ev.target?.closest?.('.item-container-item-card')) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (actorMode) await this._onItemContainerExternalDrop(ev);
        else await this._onItemContainerWorldDrop(ev);
      });
    }

    el.querySelectorAll('[data-action="sh-item-container-create"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly) return;
        const a = this.item.parent?.documentName === 'Actor' ? this.item.parent : null;
        if (!a) {
          ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.OnlyOnActor'));
          return;
        }
        const capacity = checkActorContainerCapacity(a, this.item, [{ system: { quantity: 1, weight: 0 } }]);
        if (!capacity.ok) {
          ui.notifications?.warn?.(
            capacity.reason === 'maxWeight'
              ? L('SPACEHOLDER.ItemContainer.MaxWeightExceeded')
              : L('SPACEHOLDER.ItemContainer.MaxItemsExceeded')
          );
          return;
        }
        const defaultName = L('SPACEHOLDER.Inventory.NewItem');
        const created = await Item.create(
          { name: defaultName, type: 'item', img: Item.DEFAULT_ICON, system: {} },
          { parent: a }
        );
        if (!created) return;
        const ok = await moveActorItemIntoContainer(a, this.item, created.id);
        if (!ok) {
          ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.MoveFailed'));
          try {
            await created.delete();
          } catch (_) { /* ignore */ }
          return;
        }
        await this.render(false);
      });
    });

    el.querySelectorAll('[data-action="sh-item-container-refresh"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly) return;
        if (actorMode) {
          if (!actor) return;
          const changed = await refreshContainerState(actor, this.item);
          if (changed) ui.notifications?.info?.(L('SPACEHOLDER.ItemContainer.Refreshed'));
        } else {
          const n = await pruneBrokenWorldUuidLinks(this.item);
          if (n) ui.notifications?.info?.(game.i18n.format('SPACEHOLDER.ItemContainer.WorldPruned', { n }));
        }
        await this.render(false);
      });
    });

    el.querySelectorAll('[data-action="sh-item-container-extract"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly || !actor) return;
        const id = String(ev.currentTarget?.dataset?.itemId ?? '').trim();
        if (!id) return;
        await removeActorItemFromContainer(actor, this.item, id);
        await this.render(false);
      });
    });

    el.querySelectorAll('[data-action="sh-item-container-delete"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly || !actor) return;
        const id = String(ev.currentTarget?.dataset?.itemId ?? '').trim();
        if (!id) return;
        const child = actor.items.get(id);
        if (!child) return;
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          classes: ['spaceholder'],
          window: {
            title: L('SPACEHOLDER.Inventory.DeleteItem'),
            icon: 'fa-solid fa-trash',
          },
          content: `<p>${foundry.utils.escapeHTML(L('SPACEHOLDER.ItemContainer.DeleteConfirm'))}</p>`,
          yes: { label: L('SPACEHOLDER.Actions.Delete'), icon: 'fa-solid fa-trash' },
          no: { label: L('SPACEHOLDER.Actions.Cancel'), icon: 'fa-solid fa-times' },
        });
        if (!confirmed) return;
        try {
          await child.delete();
        } catch (e) {
          console.error('SpaceHolder | container child delete failed:', e);
          return;
        }
        await this._syncItemContainerContentsAfterDelete(actor, id);
        await this.render(false);
      });
    });

    el.querySelectorAll('[data-action="sh-item-container-unlink"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (readOnly || actorMode) return;
        const u = String(ev.currentTarget?.dataset?.worldUuid ?? '').trim();
        if (!u) return;
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          classes: ['spaceholder'],
          window: {
            title: L('SPACEHOLDER.ItemContainer.Unlink'),
            icon: 'fa-solid fa-unlink',
          },
          content: `<p>${foundry.utils.escapeHTML(L('SPACEHOLDER.ItemContainer.UnlinkConfirm'))}</p>`,
          yes: { label: L('SPACEHOLDER.ItemContainer.Unlink'), icon: 'fa-solid fa-unlink' },
          no: { label: L('SPACEHOLDER.Actions.Cancel'), icon: 'fa-solid fa-times' },
        });
        if (!confirmed) return;
        await removeWorldUuidFromContainer(this.item, u);
        await this.render(false);
      });
    });

    el.querySelectorAll('[data-action="sh-item-container-edit"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const id = String(ev.currentTarget?.dataset?.itemId ?? '').trim();
        if (!id || !actor) return;
        const doc = actor.items.get(id);
        doc?.sheet?.render(true);
      });
    });

    el.querySelectorAll('[data-action="sh-item-container-edit-world"]').forEach((btn) => {
      if (btn.dataset.shContainerBtnBound === '1') return;
      btn.dataset.shContainerBtnBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const u = String(ev.currentTarget?.dataset?.worldUuid ?? '').trim();
        if (!u) return;
        let doc = null;
        try {
          doc = await fromUuid(u);
        } catch (_) {
          doc = null;
        }
        doc?.sheet?.render(true);
      });
    });

    if (!readOnly) {
      el.querySelectorAll('.item-container-item-card').forEach((card) => {
        if (card.dataset.shContainerCardBound === '1') return;
        card.dataset.shContainerCardBound = '1';
        card.setAttribute('draggable', 'true');
        card.addEventListener('dragstart', (ev) => this._onItemContainerDragStart(ev));
        card.addEventListener('dragover', (ev) => {
          ev.preventDefault();
          try {
            ev.dataTransfer.dropEffect = 'move';
          } catch (_) { /* ignore */ }
        });
        card.addEventListener('drop', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          await this._onItemContainerReorderDrop(ev);
        });
      });
    }
  }

  /**
   * @param {Actor} actor
   * @param {string} childId
   */
  async _syncItemContainerContentsAfterDelete(actor, childId) {
    const hid = String(this.item?.id ?? '').trim();
    const cid = String(childId ?? '').trim();
    if (!actor || !hid || !cid) return;
    const host = actor.items.get(hid);
    if (!host) return;
    const cur = normalizeItemContainerFields(host.system);
    const nextContents = cur.container.contents.filter(
      (e) => !(e.kind === ENTRY_ACTOR_ITEM && e.itemId === cid),
    );
    await host.update({ 'system.container': { ...cur.container, contents: nextContents } }, { render: false });
    rerenderOpenContainerRelatedSheets(actor, [host]);
  }

  /**
   * @param {DragEvent} ev
   */
  _onItemContainerDragStart(ev) {
    const kind = String(ev.currentTarget?.dataset?.entryKind ?? '').trim();
    this._itemContainerDragRef = null;
    if (kind === 'world') {
      const worldUuid = String(ev.currentTarget?.dataset?.worldUuid ?? '').trim();
      if (worldUuid && this.item?.uuid) {
        this._itemContainerDragRef = { kind: 'world', worldUuid };
        const dragData = {
          type: 'Item',
          uuid: worldUuid,
          spaceholder: {
            action: 'worldContainerMove',
            containerHostUuid: this.item.uuid,
            entryUuid: worldUuid,
          },
        };
        try {
          ev.dataTransfer?.setData?.('text/plain', JSON.stringify(dragData));
        } catch (_) { /* ignore */ }
      }
      return;
    }
    const id = String(ev.currentTarget?.dataset?.itemId ?? '').trim();
    if (id) this._itemContainerDragRef = { kind: 'actor', itemId: id };
    const actor = this.item.parent?.documentName === 'Actor' ? this.item.parent : null;
    if (!actor || !id) return;
    const doc = actor.items.get(id);
    if (doc) {
      const dragData = doc.toDragData ? doc.toDragData() : { type: 'Item', uuid: doc.uuid };
      if (!dragData.uuid) dragData.uuid = doc.uuid;
      try {
        ev.dataTransfer?.setData?.('text/plain', JSON.stringify(dragData));
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * @param {DragEvent} ev
   */
  async _onItemContainerReorderDrop(ev) {
    const actor = this.item.parent?.documentName === 'Actor' ? this.item.parent : null;
    const dragRef = this._itemContainerDragRef;
    this._itemContainerDragRef = null;
    const card = ev.currentTarget?.closest?.('.item-container-item-card');
    const rowKind = String(card?.dataset?.entryKind ?? dragRef?.kind ?? '').trim();

    if (rowKind === 'world') {
      const dragUuid = String(dragRef?.worldUuid ?? '').trim();
      const targetUuid = String(card?.dataset?.worldUuid ?? '').trim();
      if (!this.isEditable || !dragUuid || !targetUuid || dragUuid === targetUuid) return;
      const list = [...this.element.querySelectorAll('.item-container-item-card[data-entry-kind="world"]')]
        .map((c) => String(c.dataset?.worldUuid ?? '').trim())
        .filter(Boolean);
      const from = list.indexOf(dragUuid);
      const to = list.indexOf(targetUuid);
      if (from < 0 || to < 0) return;
      const next = list.slice();
      const [removed] = next.splice(from, 1);
      next.splice(to, 0, removed);
      await setWorldContainerContentsOrder(this.item, next);
      await this.render(false);
      return;
    }

    const dragId = String(dragRef?.itemId ?? '').trim();
    const targetId = String(card?.dataset?.itemId ?? '').trim();
    if (!this.isEditable || !actor || !dragId || !targetId || dragId === targetId) return;
    const list = [...this.element.querySelectorAll('.item-container-item-card[data-entry-kind="actor"]')]
      .map((c) => String(c.dataset?.itemId ?? '').trim())
      .filter(Boolean);
    const from = list.indexOf(dragId);
    const to = list.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = list.slice();
    const [removed] = next.splice(from, 1);
    next.splice(to, 0, removed);
    await setContainerContentsOrder(actor, this.item, next);
    await this.render(false);
  }

  /**
   * @param {DragEvent} ev
   */
  async _onItemContainerWorldDrop(ev) {
    if (!this.isEditable) return;
    const L = (k) => game.i18n?.localize?.(k) ?? k;
    let data = null;
    try {
      const raw = ev.dataTransfer?.getData?.('text/plain') ?? '';
      data = raw ? JSON.parse(raw) : null;
    } catch (_) {
      return;
    }
    if (!data || data.type !== 'Item' || !data.uuid) return;
    let doc = null;
    try {
      doc = await fromUuid(data.uuid);
    } catch (_) {
      doc = null;
    }
    if (!doc || doc.documentName !== 'Item') {
      ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.DropNotAnItem'));
      return;
    }
    if (doc.uuid === this.item.uuid) {
      ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.CycleWarning'));
      return;
    }
    const parentActor = doc.parent?.documentName === 'Actor' ? doc.parent : null;
    if (parentActor) {
      ui.notifications?.warn?.(
        L('SPACEHOLDER.ItemContainer.DropEmbeddedNotAllowed'),
      );
      return;
    }
    const panel = await this._buildWorldContainerPanelContext();
    const limits = normalizeItemContainerFields(this.item.system).container.limits;
    const q = Math.max(0, Math.floor(Number(doc.system?.quantity) || 0));
    const w = Math.max(0, Number(doc.system?.weight) || 0);
    if (limits.maxItems > 0 && panel.containerTotalItems + q > limits.maxItems) {
      ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.MaxItemsExceeded'));
      return;
    }
    if (limits.maxWeight > 0 && panel.containerTotalWeight + (q * w) > limits.maxWeight) {
      ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.MaxWeightExceeded'));
      return;
    }
    const ok = await addWorldUuidToContainer(this.item, doc.uuid);
    if (!ok) {
      ui.notifications?.warn?.(L('SPACEHOLDER.ItemContainer.MoveFailed'));
      return;
    }
    await this.render(false);
  }

  /**
   * @param {DragEvent} ev
   */
  async _onItemContainerExternalDrop(ev) {
    const actor = this.item.parent?.documentName === 'Actor' ? this.item.parent : null;
    if (!this.isEditable || !actor) return;
    let data = null;
    try {
      const raw = ev.dataTransfer?.getData?.('text/plain') ?? '';
      data = raw ? JSON.parse(raw) : null;
    } catch (_) {
      return;
    }
    if (!data || data.type !== 'Item' || !data.uuid) return;
    let doc = null;
    try {
      doc = await fromUuid(data.uuid);
    } catch (_) {
      doc = null;
    }
    if (!doc || doc.documentName !== 'Item') {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ItemContainer.DropNotAnItem') ?? 'Not an item.');
      return;
    }
    if (doc.parent?.id !== actor.id) {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ItemContainer.DropWrongActor') ?? 'Item must belong to the same actor.');
      return;
    }
    if (doc.id === this.item.id) return;
    if (wouldCreateItemContainerCycle(actor, doc.id, this.item.id)) {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ItemContainer.CycleWarning') ?? 'Cannot nest that way.');
      return;
    }
    const capacity = checkActorContainerCapacity(actor, this.item, [doc]);
    if (!capacity.ok) {
      ui.notifications?.warn?.(
        capacity.reason === 'maxWeight'
          ? (game.i18n?.localize?.('SPACEHOLDER.ItemContainer.MaxWeightExceeded') ?? 'Container weight limit exceeded.')
          : (game.i18n?.localize?.('SPACEHOLDER.ItemContainer.MaxItemsExceeded') ?? 'Container item limit exceeded.')
      );
      return;
    }
    const ok = await moveActorItemIntoContainer(actor, this.item, doc.id);
    if (!ok) {
      ui.notifications?.warn?.(game.i18n?.localize?.('SPACEHOLDER.ItemContainer.MoveFailed') ?? 'Could not place item.');
      return;
    }
    await this.render(false);
  }

  /**
   * Поля без привязки к FormData (теги — `data-sh-item-tag`; анатомия/покрытие — диалог и PIXI-редактор):
   * при submitOnChange вложенный `system` приходит без них → DataModel подставляет дефолты и затирает данные.
   * Подмешиваем снимок с документа, как для `itemTags`.
   * @param {object} [data]
   */
  _preserveWearableGearSubmitFields(data) {
    if (!data || typeof data !== 'object') return;

    const hasNestedSystem =
      data.system && typeof data.system === 'object' && !Array.isArray(data.system);
    const hasFlatSystem = Object.keys(data).some(
      (k) => typeof k === 'string' && k.startsWith('system.')
    );
    if (!hasNestedSystem && !hasFlatSystem) return;

    const itemSys = this.item?.system ?? {};
    const src = itemSys.itemTags;
    const tagSnap = {
      isArmor: !!(src && src.isArmor),
      isActions: !!(src && src.isActions),
      isModifiers: !!(src && src.isModifiers),
      isWeapon: !!(src && src.isWeapon),
      isAmmo: !!(src && src.isAmmo),
      isContainer: !!(src && src.isContainer),
    };

    const icPreserve = normalizeItemContainerFields(itemSys);

    const anatomyId = itemSys.anatomyId ?? null;
    const coveredParts = Array.isArray(itemSys.coveredParts)
      ? foundry.utils.duplicate(itemSys.coveredParts)
      : [];

    const weaponSnap =
      itemSys.weapon && typeof itemSys.weapon === 'object'
        ? foundry.utils.duplicate(itemSys.weapon)
        : null;
    const storageSnap = normalizeNestedStorage(itemSys.storage);
    const containerSnap = foundry.utils.duplicate(icPreserve.container);

    const readSubmittedContainerLimit = (key) => {
      const flatKey = `system.container.limits.${key}`;
      if (Object.prototype.hasOwnProperty.call(data, flatKey)) return data[flatKey];
      if (hasNestedSystem) {
        const nested = data.system?.container?.limits;
        if (nested && Object.prototype.hasOwnProperty.call(nested, key)) return nested[key];
      }
      return undefined;
    };
    const submittedMaxItems = readSubmittedContainerLimit('maxItems');
    const submittedMaxWeight = readSubmittedContainerLimit('maxWeight');
    if (submittedMaxItems !== undefined) {
      const n = Math.floor(Number(submittedMaxItems));
      containerSnap.limits.maxItems = Number.isFinite(n) ? Math.max(0, n) : 0;
    }
    if (submittedMaxWeight !== undefined) {
      const n = Number(submittedMaxWeight);
      containerSnap.limits.maxWeight = Number.isFinite(n) ? Math.max(0, n) : 0;
    }

    if (hasNestedSystem) {
      data.system.itemTags = { ...tagSnap };
      data.system.anatomyId = anatomyId;
      data.system.coveredParts = coveredParts;
      data.system.storage = storageSnap;
      data.system.containerHostId = icPreserve.containerHostId;
      data.system.container = foundry.utils.duplicate(containerSnap);
      if (weaponSnap && !Object.prototype.hasOwnProperty.call(data.system, 'weapon')) {
        data.system.weapon = weaponSnap;
      }
    }
    data['system.itemTags'] = { ...tagSnap };
    data['system.anatomyId'] = anatomyId;
    data['system.coveredParts'] = coveredParts;
    data['system.storage'] = storageSnap;
    data['system.containerHostId'] = icPreserve.containerHostId;
    data['system.container'] = foundry.utils.duplicate(containerSnap);
  }

  /**
   * @inheritDoc
   */
  async _prepareSubmitData(event, form, formData) {
    const data = await super._prepareSubmitData(event, form, formData);
    this._preserveWearableGearSubmitFields(data);
    return data;
  }

  /**
   * Теги правятся локально; одна кнопка «Применить» пишет `system.itemTags` и перерисовывает вкладки.
   * @inheritDoc
   */
  async _onRender(context, options) {
    await super._onRender(context, options);

    this._bindWeaponV3Listeners();
    this._bindItemContainerListeners();

    if (!this.isEditable) return;

    // Tag checkboxes have no `name` and are committed only by the "Apply" button.
    // In v14, letting their `change` event reach the form (submitOnChange) produces an
    // empty diff which then crashes Foundry's `cleanData` on a near-empty change object.
    // Stop the change/input/click events so the form does not auto-submit on toggle.
    const tagCheckboxes = this.element?.querySelectorAll?.('input[type="checkbox"][data-sh-item-tag]') ?? [];
    for (const cb of tagCheckboxes) {
      if (cb.dataset.spaceholderTagBound === '1') continue;
      cb.dataset.spaceholderTagBound = '1';
      const swallow = (ev) => {
        ev.stopImmediatePropagation();
      };
      cb.addEventListener('change', swallow);
      cb.addEventListener('input', swallow);
    }

    const btn = this.element?.querySelector?.('[data-action="sh-item-tags-apply"]');
    if (btn && !btn.dataset.spaceholderTagsApplyBound) {
      btn.dataset.spaceholderTagsApplyBound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const root = this.element;
        const readTag = (key) => {
          const input = root.querySelector(`input[type="checkbox"][data-sh-item-tag="${key}"]`);
          return !!input?.checked;
        };
        const itemTags = {
          isArmor: readTag('isArmor'),
          isActions: readTag('isActions'),
          isModifiers: readTag('isModifiers'),
          isWeapon: readTag('isWeapon'),
          isAmmo: readTag('isAmmo'),
          isContainer: readTag('isContainer'),
        };
        const patch = { 'system.itemTags': itemTags };
        const pending = this._getPendingNameFromForm();
        if (pending && pending !== String(this.item.name ?? '').trim()) {
          patch.name = pending;
        }
        const pendingQty = this._getPendingQuantityFromForm();
        if (pendingQty !== null) {
          const cur = Math.max(0, Math.floor(Number(this.item.system?.quantity ?? 1)));
          if (pendingQty !== cur) patch['system.quantity'] = pendingQty;
        }
        this._wearableApplyingItemTags = true;
        try {
          await this.item.update(patch);
        } catch (e) {
          console.error('SpaceHolder | itemTags apply failed:', e);
          return;
        } finally {
          this._wearableApplyingItemTags = false;
        }
        this._activeTabPrimary = 'tags';
        await this.render(false);
      });
    }
  }

}

/**
 * Submit формы (submitOnChange) иногда присылает вложенный `change.system` с `itemTags: все false`, хотя в документе
 * теги включены; чекбоксы тегов не в FormData. Пока лист выставляет `_wearableApplyingItemTags` (кнопка «Применить» тегов),
 * восстановление не делаем — иначе сброс тегов через «Применить» откатывается.
 * @param {Item} item
 * @param {object} change
 * @returns {boolean}
 */
function fixSpuriousWearableItemTagsWipe(item, change) {
  if (item?.type !== 'item' || !change) return false;
  if (item.sheet?._wearableApplyingItemTags) return false;
  const cur = item.system?.itemTags;
  const curAny = cur && (
    cur.isArmor ||
    cur.isActions ||
    cur.isModifiers ||
    cur.isWeapon ||
    cur.isAmmo ||
    cur.isContainer
  );
  if (!curAny) return false;

  if (change.system && typeof change.system === 'object' && !Array.isArray(change.system)) {
    const inc = change.system.itemTags;
    if (!inc || typeof inc !== 'object') return false;
    const incAllFalse =
      !inc.isArmor &&
      !inc.isActions &&
      !inc.isModifiers &&
      !inc.isWeapon &&
      !inc.isAmmo &&
      !inc.isContainer;
    if (!incAllFalse) return false;
    const sysKeys = Object.keys(change.system);
    const onlyItemTags = sysKeys.length === 1 && sysKeys[0] === 'itemTags';
    if (onlyItemTags) return false;
    change.system.itemTags = foundry.utils.duplicate(cur);
    return true;
  }

  const flatIt = change['system.itemTags'];
  if (flatIt && typeof flatIt === 'object') {
    const incAllFalse =
      !flatIt.isArmor &&
      !flatIt.isActions &&
      !flatIt.isModifiers &&
      !flatIt.isWeapon &&
      !flatIt.isAmmo &&
      !flatIt.isContainer;
    if (!incAllFalse) return false;
    const flatSys = Object.keys(change).filter(
      (k) => typeof k === 'string' && k.startsWith('system.') && k !== 'system.itemTags'
    );
    if (flatSys.length === 0) return false;
    change['system.itemTags'] = foundry.utils.duplicate(cur);
    return true;
  }

  return false;
}

/**
 * Те же «полные» diff по system, что и для тегов: в форме нет anatomyId/coveredParts, в change приходит null/[].
 * Явные апдейты только из диалога/редактора покрытия не трогаем.
 * @param {Item} item
 * @param {object} change
 * @returns {boolean}
 */
function fixSpuriousWearableCoverageWipe(item, change) {
  if (item?.type !== 'item' || !change) return false;

  const doc = item.system ?? {};
  const docAidRaw = doc.anatomyId;
  const docAidStr = docAidRaw != null ? String(docAidRaw).trim() : '';
  const docHasAnatomy = docAidStr.length > 0;
  const docParts = Array.isArray(doc.coveredParts) ? doc.coveredParts : [];
  const docHasParts = docParts.length > 0;
  if (!docHasAnatomy && !docHasParts) return false;

  const isCoverageOnlyKeys = (keys) => {
    if (!keys.length) return false;
    const allowed = new Set(['anatomyId', 'coveredParts']);
    return keys.every((k) => allowed.has(k));
  };

  let fixed = false;

  if (change.system && typeof change.system === 'object' && !Array.isArray(change.system)) {
    const inc = change.system;
    const keys = Object.keys(inc);
    if (keys.length === 0) return false;
    if (keys.length <= 3 && isCoverageOnlyKeys(keys)) return false;

    const incAidRaw = inc.anatomyId;
    const incAidStr = incAidRaw != null ? String(incAidRaw).trim() : '';
    const wipesAnatomy = Object.prototype.hasOwnProperty.call(inc, 'anatomyId') && !incAidStr;
    const incCp = inc.coveredParts;
    const wipesParts =
      Object.prototype.hasOwnProperty.call(inc, 'coveredParts') &&
      Array.isArray(incCp) &&
      incCp.length === 0 &&
      docHasParts;

    if (wipesAnatomy && docHasAnatomy) {
      change.system.anatomyId = docAidRaw;
      fixed = true;
    }
    if (wipesParts && docHasParts) {
      change.system.coveredParts = foundry.utils.duplicate(docParts);
      fixed = true;
    }
    return fixed;
  }

  const flatSys = Object.keys(change).filter((k) => typeof k === 'string' && k.startsWith('system.'));
  if (!flatSys.length) return false;
  const coverageFlat = new Set(['system.anatomyId', 'system.coveredParts']);
  const nonCoverageFlat = flatSys.filter((k) => !coverageFlat.has(k));
  if (nonCoverageFlat.length === 0) return false;

  const flatAid = change['system.anatomyId'];
  const wipesFlatAnatomy =
    Object.prototype.hasOwnProperty.call(change, 'system.anatomyId') &&
    (flatAid == null || String(flatAid).trim() === '');
  const flatCp = change['system.coveredParts'];
  const wipesFlatParts =
    Object.prototype.hasOwnProperty.call(change, 'system.coveredParts') &&
    Array.isArray(flatCp) &&
    flatCp.length === 0 &&
    docHasParts;

  if (wipesFlatAnatomy && docHasAnatomy) {
    change['system.anatomyId'] = docAidRaw;
    fixed = true;
  }
  if (wipesFlatParts && docHasParts) {
    change['system.coveredParts'] = foundry.utils.duplicate(docParts);
    fixed = true;
  }
  return fixed;
}

if (!globalThis.__spaceholderWearableItemPreUpdate) {
  globalThis.__spaceholderWearableItemPreUpdate = true;
  Hooks.on('preUpdateItem', (item, change, _options, _userId) => {
    if (item?.type !== 'item') return;
    fixSpuriousWearableItemTagsWipe(item, change);
    fixSpuriousWearableCoverageWipe(item, change);
  });
}

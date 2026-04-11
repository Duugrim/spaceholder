import {
  onManageActiveEffect,
  prepareActiveEffectCategories,
} from '../helpers/effects.mjs';
import { enrichHTMLWithFactionIcons } from '../helpers/faction-display.mjs';
import { anatomyManager } from '../anatomy-manager.mjs';
import { pickIcon } from '../helpers/icon-picker/icon-picker.mjs';

const ITEM_SHEET_TAB_META = Object.freeze({
  description: { icon: 'fas fa-file-lines', labelKey: 'SPACEHOLDER.Tabs.Description' },
  attributes: { icon: 'fas fa-sliders', labelKey: 'SPACEHOLDER.Tabs.Attributes' },
  actions: { icon: 'fas fa-bolt', labelKey: 'SPACEHOLDER.ActionsSystem.UI.ActionsTab' },
  effects: { icon: 'fas fa-wand-magic-sparkles', labelKey: 'SPACEHOLDER.Tabs.Effects' },
  tags: { icon: 'fas fa-tags', labelKey: 'SPACEHOLDER.Tabs.Tags' },
  modifiers: { icon: 'fas fa-dumbbell', labelKey: 'SPACEHOLDER.Tabs.Modifiers' },
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

const ITEM_TYPE_LABEL_KEYS = Object.freeze({
  item: 'SPACEHOLDER.ItemTypes.Item',
  feature: 'SPACEHOLDER.ItemTypes.Feature',
  spell: 'SPACEHOLDER.ItemTypes.Spell',
});

const ITEM_TYPE_ICON_CLASS = Object.freeze({
  item: 'fa-solid fa-box',
  feature: 'fa-solid fa-star',
  spell: 'fa-solid fa-wand-magic-sparkles',
});

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
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS ?? {}, {
    classes: ['spaceholder', 'sheet', 'item'],
    position: { width: 520, height: 480 },
    window: {
      resizable: true,
      contentClasses: ['standard-form'],
    },
    form: {
      submitOnChange: true,
    },
  }, { inplace: false });

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
    const content = await renderTemplate('systems/spaceholder/templates/item/parts/item-action-dialog.hbs', {
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
      window: { title: titleText, icon: 'fa-solid fa-bolt', classes: ['spaceholder'] },
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
          window: {
            title: game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.UI.DeleteActionTitle') ?? 'Delete action',
            icon: 'fa-solid fa-trash',
            classes: ['spaceholder'],
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
 * Item sheet (gear: anatomy coverage, equip, modifiers, optional roll formula).
 */
export class SpaceHolderItemSheet_Item extends SpaceHolderBaseItemSheet {
  static PARTS = { body: { root: true, template: 'systems/spaceholder/templates/item/item-wearable-sheet.hbs' } };

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS ?? {}, {
    // Шапка + полоса вкладок + баннер + строка управления + фиксированный ряд 420px (покрытие)
    position: { width: 720, height: 860 },
    window: Object.assign({}, super.DEFAULT_OPTIONS?.window, { resizable: true }),
  });

  // Вкладки: описание, теги; остальные — по system.itemTags.
  static TABS = {
    primary: {
      tabs: [
        { id: 'description' },
        { id: 'tags' },
        { id: 'attributes' },
        { id: 'actions' },
        { id: 'modifiers' },
      ],
      initial: 'description'
    }
  };

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const system = context.system || {};

    // itemTags: булевы флаги групп механик (см. template.json / migrateData)
    if (!system.itemTags || typeof system.itemTags !== 'object') {
      system.itemTags = { isArmor: false, isActions: false, isModifiers: false };
    } else {
      system.itemTags = {
        isArmor: !!system.itemTags.isArmor,
        isActions: !!system.itemTags.isActions,
        isModifiers: !!system.itemTags.isModifiers,
      };
    }
    context.hasArmorTag = system.itemTags.isArmor;
    context.hasActionsTag = system.itemTags.isActions;
    context.hasModifiersTag = system.itemTags.isModifiers;

    const allowedTabs = new Set(['description', 'tags']);
    if (system.itemTags.isArmor) allowedTabs.add('attributes');
    if (system.itemTags.isActions) allowedTabs.add('actions');
    if (system.itemTags.isModifiers) allowedTabs.add('modifiers');
    const currentTab = this._activeTabPrimary ?? this.tabGroups?.primary ?? 'description';
    if (!allowedTabs.has(currentTab)) {
      this._activeTabPrimary = 'tags';
    }

    let selectedAnatomyId = String(system.anatomyId ?? '').trim() || null;
    if (!selectedAnatomyId && system.anatomyGroup) {
      selectedAnatomyId = anatomyManager.getRepresentativeAnatomyForGroup(system.anatomyGroup);
    }
    context.selectedAnatomyId = selectedAnatomyId;

    // Название анатомии и теги групп для отображения «Для {anatomy}» + теги
    context.anatomyDisplayName = null;
    context.anatomyGroupTags = system.anatomyGroup ? [system.anatomyGroup] : [];
    context.bodyPartsForGroup = [];

    const coveredParts = Array.isArray(system.coveredParts) ? system.coveredParts : [];
    const valueBySlotRef = Object.fromEntries(
      coveredParts.map((c) => {
        const ref = String(c.slotRef ?? c.partId ?? "").trim();
        if (!ref) return null;
        return [ref, Number(c?.value) || 0];
      }).filter(Boolean)
    );

    if (selectedAnatomyId) {
      try {
        let anatomyData = null;
        const registryInfo = anatomyManager.getAnatomyInfo(selectedAnatomyId);
        if (registryInfo) {
          anatomyData = await anatomyManager.loadAnatomy(selectedAnatomyId);
          context.anatomyDisplayName = anatomyManager.getAnatomyDisplayName(selectedAnatomyId);
        } else {
          await anatomyManager.loadWorldPresets();
          const worldPresets = anatomyManager.getWorldPresets();
          const preset = worldPresets.find((p) => p.id === selectedAnatomyId);
          if (preset) {
            anatomyData = preset;
            context.anatomyDisplayName = preset.name || preset.id;
          }
        }

        const groupId = anatomyManager.getAnatomyGroupId(selectedAnatomyId);
        if (groupId) context.anatomyGroupTags = [groupId];
        else if (system.anatomyGroup) context.anatomyGroupTags = [system.anatomyGroup];

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
                name: displayName,
                armorValue: valueBySlotRef[entry.slotRef] ?? 0
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
    context.coveredList = coveredParts
      .map((entry) => {
        const slotRef = String(entry.slotRef ?? entry.partId ?? "").trim();
        if (!slotRef) return null;
        const part = partsForNames[slotRef];
        const baseName = part?.displayName || part?.name || part?.id || slotRef;
        const typeId = String(part?.id ?? "").trim();
        const hasDup = !!typeId && (countByTypeId[typeId] || 0) > 1;
        const m = String(slotRef).match(/#(\d+)$/);
        const dupIndex = hasDup && m ? Number(m[1]) : null;
        const uiName = dupIndex ? `${baseName} (${dupIndex})` : baseName;
        return {
          partId: slotRef,
          partName: uiName,
          armorValue: Number(entry?.value) || 0
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
    context.system = system;

    const wearableTabIds = ['description', 'tags'];
    if (context.hasArmorTag) wearableTabIds.push('attributes');
    if (context.hasActionsTag) wearableTabIds.push('actions');
    if (context.hasModifiersTag) wearableTabIds.push('modifiers');
    context.sheetPrimaryTabs = buildItemSheetPrimaryTabs(wearableTabIds, {
      attributes: { icon: 'fas fa-shield-halved', labelKey: 'SPACEHOLDER.Tabs.Coverage' },
      tags: { icon: 'fas fa-gear', labelKey: 'SPACEHOLDER.Tabs.Settings' },
    });

    context.itemHeaderInlineQuantity = true;

    return context;
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
    };

    const anatomyId = itemSys.anatomyId ?? null;
    const anatomyGroup = itemSys.anatomyGroup ?? null;
    const coveredParts = Array.isArray(itemSys.coveredParts)
      ? foundry.utils.duplicate(itemSys.coveredParts)
      : [];

    if (hasNestedSystem) {
      data.system.itemTags = { ...tagSnap };
      data.system.anatomyId = anatomyId;
      data.system.anatomyGroup = anatomyGroup;
      data.system.coveredParts = coveredParts;
    }
    data['system.itemTags'] = { ...tagSnap };
    data['system.anatomyId'] = anatomyId;
    data['system.anatomyGroup'] = anatomyGroup;
    data['system.coveredParts'] = coveredParts;
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

    if (!this.isEditable) return;

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
        };
        const patch = { 'system.itemTags': itemTags };
        const pending = this._getPendingNameFromForm();
        if (pending && pending !== String(this.item.name ?? '').trim()) {
          patch.name = pending;
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
  const curAny = cur && (cur.isArmor || cur.isActions || cur.isModifiers);
  if (!curAny) return false;

  if (change.system && typeof change.system === 'object' && !Array.isArray(change.system)) {
    const inc = change.system.itemTags;
    if (!inc || typeof inc !== 'object') return false;
    const incAllFalse = !inc.isArmor && !inc.isActions && !inc.isModifiers;
    if (!incAllFalse) return false;
    const sysKeys = Object.keys(change.system);
    const onlyItemTags = sysKeys.length === 1 && sysKeys[0] === 'itemTags';
    if (onlyItemTags) return false;
    change.system.itemTags = foundry.utils.duplicate(cur);
    return true;
  }

  const flatIt = change['system.itemTags'];
  if (flatIt && typeof flatIt === 'object') {
    const incAllFalse = !flatIt.isArmor && !flatIt.isActions && !flatIt.isModifiers;
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
 * Те же «полные» diff по system, что и для тегов: в форме нет анатомии/coveredParts, в change приходит null/[].
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
    const allowed = new Set(['anatomyId', 'anatomyGroup', 'coveredParts']);
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
      change.system.anatomyGroup = doc.anatomyGroup ?? null;
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
  const coverageFlat = new Set(['system.anatomyId', 'system.anatomyGroup', 'system.coveredParts']);
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
    change['system.anatomyGroup'] = doc.anatomyGroup ?? null;
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

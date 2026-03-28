import {
  onManageActiveEffect,
  prepareActiveEffectCategories,
} from '../helpers/effects.mjs';
import { enrichHTMLWithFactionIcons } from '../helpers/faction-display.mjs';
import { anatomyManager } from '../anatomy-manager.mjs';

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

    context.config = CONFIG.SPACEHOLDER;

    context.effects = prepareActiveEffectCategories(this.item.effects);

    // Defaults for older items
    context.system.actions = Array.isArray(context.system.actions) ? context.system.actions : [];
    if (this.item.type === 'item') {
      context.system.defaultActions = context.system.defaultActions || {};
      context.system.defaultActions.equip = context.system.defaultActions.equip || { showInCombat: false, showInQuickbar: true };
      context.system.defaultActions.unequip = context.system.defaultActions.unequip || { showInCombat: false, showInQuickbar: true };
    }

    const primaryTabDefs = this.constructor.TABS?.primary?.tabs ?? [];
    const primaryTabIds = primaryTabDefs.map((t) => t.id).filter(Boolean);
    context.sheetPrimaryTabs = buildItemSheetPrimaryTabs(primaryTabIds);

    return context;
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

  /* -------------------------------------------- */

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);

    // Портрет: в ItemSheetV2 data-edit="img" не всегда обрабатывается — как на листе актёра
    const profileHandler = (this._onProfileImageClickBound ??= this._onProfileImageClick.bind(this));
    this.element?.querySelectorAll('img.profile-img[data-edit], img.profile-img').forEach((img) => {
      img.addEventListener('click', profileHandler);
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

    // Custom actions editor (item.system.actions)
    const el = this.element;
    const randomId = () => {
      try { return foundry.utils.randomID?.(); } catch (_) {}
      try { return globalThis.randomID?.(); } catch (_) {}
      try { return globalThis.crypto?.randomUUID?.(); } catch (_) {}
      return String(Date.now());
    };

    const getActions = () => {
      const raw = this.item?.system?.actions;
      return Array.isArray(raw) ? raw : [];
    };

    const setActions = async (next) => {
      const patch = { 'system.actions': Array.isArray(next) ? next : [] };
      const pending = this._getPendingNameFromForm();
      if (pending && pending !== String(this.item.name ?? '').trim()) {
        patch.name = pending;
      }
      await this.item.update(patch);
      this.render(false);
    };

    el.querySelectorAll('[data-action="sh-item-custom-action-add"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const next = [...getActions(), { id: randomId(), name: '', apCost: 0, mode: 'chat', macro: '', showInCombat: true, showInQuickbar: true }];
        await setActions(next);
      });
    });

    el.querySelectorAll('[data-action="sh-item-custom-action-remove"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const id = String(btn.dataset.id ?? '').trim();
        if (!id) return;
        const next = getActions().filter((a) => String(a?.id ?? '') !== id);
        await setActions(next);
      });
    });

    el.querySelectorAll('[data-action="sh-item-custom-action-edit"]').forEach((input) => {
      input.addEventListener('change', async (ev) => {
        const id = String(input.dataset.id ?? '').trim();
        const field = String(input.dataset.field ?? '').trim();
        if (!id || !field) return;

        const next = getActions().map((a) => {
          if (String(a?.id ?? '') !== id) return a;
          const copy = { ...(a || {}), id };
          if (field === 'name') copy.name = String(input.value ?? '').trim();
          if (field === 'apCost') copy.apCost = Number(input.value) || 0;
          if (field === 'mode') copy.mode = String(input.value ?? '').trim() || 'chat';
          if (field === 'macro') copy.macro = String(input.value ?? '');
          if (field === 'showInCombat') copy.showInCombat = !!input.checked;
          if (field === 'showInQuickbar') copy.showInQuickbar = !!input.checked;
          return copy;
        });

        await setActions(next);
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
    position: { width: 720, height: 560 },
    window: { resizable: true }
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
    });

    return context;
  }

  /** @inheritDoc — привязка кнопки и полей защиты выполняется через хук renderItemSheet в spaceholder.mjs */
  async _onRender(context, options) {
    await super._onRender(context, options);

    if (!this.isEditable) return;

    const el = this.element;
    const tagRe = /^system\.itemTags\.(isArmor|isActions|isModifiers)$/;
    el.querySelectorAll('input[type="checkbox"][name^="system.itemTags."]').forEach((input) => {
      const name = String(input.getAttribute('name') ?? '');
      const m = name.match(tagRe);
      if (!m) return;
      const field = m[1];
      input.addEventListener('change', async () => {
        const next = !!input.checked;
        const patch = { [`system.itemTags.${field}`]: next };
        const pending = this._getPendingNameFromForm();
        if (pending && pending !== String(this.item.name ?? '').trim()) {
          patch.name = pending;
        }
        try {
          await this.item.update(patch);
        } catch (e) {
          console.error('SpaceHolder | itemTags update failed:', e);
          input.checked = !next;
          return;
        }
        this._activeTabPrimary = 'tags';
        await this.render(false);
      });
    });
  }

}

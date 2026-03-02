import {
  onManageActiveEffect,
  prepareActiveEffectCategories,
} from '../helpers/effects.mjs';
import { enrichHTMLWithFactionIcons } from '../helpers/faction-display.mjs';
import { anatomyManager } from '../anatomy-manager.mjs';

// Base V2 Item Sheet with Handlebars rendering
export class SpaceHolderBaseItemSheet extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.sheets.ItemSheet
) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS ?? {}, {
    classes: ['spaceholder', 'sheet', 'item'],
    position: { width: 520, height: 480 }
  });

  // Native tabs configuration (Application V2)
  static TABS = {
    primary: {
      tabs: [
        { id: 'description' },
        { id: 'attributes' },
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

  /* -------------------------------------------- */

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

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

    context.config = CONFIG.SPACEHOLDER;

    context.effects = prepareActiveEffectCategories(this.item.effects);

    return context;
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);

    // Повторно применяем активную вкладку после каждого рендера (как в листе персонажа)
    const desiredTab = this._activeTabPrimary ?? this.tabGroups?.primary ?? 'description';
    try { this.changeTab(desiredTab, 'primary', { updatePosition: false, force: true }); } catch (e) { /* ignore */ }

    if (!this.isEditable) return;

    // Active Effect management
    this.element.querySelectorAll('.effect-control').forEach(btn =>
      btn.addEventListener('click', (ev) => onManageActiveEffect(ev, this.item))
    );
  }
}

// Item sheets per type (Application V2)
export class SpaceHolderItemSheet_Item extends SpaceHolderBaseItemSheet {
  static PARTS = { body: { root: true, template: 'systems/spaceholder/templates/item/item-item-sheet.hbs' } };
}
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
 * Wearable item sheet (armor/clothing by anatomy).
 */
export class SpaceHolderItemSheet_Wearable extends SpaceHolderBaseItemSheet {
  static PARTS = { body: { root: true, template: 'systems/spaceholder/templates/item/item-wearable-sheet.hbs' } };

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS ?? {}, {
    position: { width: 720, height: 560 },
    window: { resizable: true }
  });

  // Добавляем вкладку модификаторов к базовому набору.
  static TABS = {
    primary: {
      tabs: [
        { id: 'description' },
        { id: 'attributes' },
        { id: 'modifiers' },
        { id: 'effects' }
      ],
      initial: 'description'
    }
  };

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const system = context.system || {};

    let selectedAnatomyId = String(system.anatomyId ?? '').trim() || null;
    if (!selectedAnatomyId && system.anatomyGroup) {
      selectedAnatomyId = anatomyManager.getRepresentativeAnatomyForGroup(system.anatomyGroup);
    }
    context.selectedAnatomyId = selectedAnatomyId;

    // Название анатомии и теги групп для отображения «Для {anatomy}» + теги
    context.anatomyDisplayName = null;
    context.anatomyGroupTags = system.anatomyGroup ? [system.anatomyGroup] : [];
    context.bodyPartsForGroup = [];

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

        if (anatomyData?.bodyParts) {
          const armorByPart = system.armorByPart || {};
          const parts = anatomyData.bodyParts;
          context.bodyPartsForGroup = Object.values(parts)
            .map((p) => {
              const id = p.id || '';
              const armorEntry = armorByPart[id] || {};
              return {
                id,
                name: p.name || id,
                armorValue: Number.isFinite(Number(armorEntry.value)) ? Number(armorEntry.value) : 0
              };
            })
            .sort((a, b) => a.name.localeCompare(b.name, game.i18n?.lang || 'en'));
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

    // Данные анатомии для визуализатора (левая колонка)
    context.anatomyDataForEditor = null;
    context.coveredList = [];
    if (selectedAnatomyId) {
      try {
        let anatomyData = null;
        const registryInfo = anatomyManager.getAnatomyInfo(selectedAnatomyId);
        if (registryInfo) anatomyData = await anatomyManager.loadAnatomy(selectedAnatomyId);
        else {
          await anatomyManager.loadWorldPresets();
          const preset = anatomyManager.getWorldPresets().find((p) => p.id === selectedAnatomyId);
          if (preset) anatomyData = preset;
        }
        if (anatomyData?.bodyParts) {
          context.anatomyDataForEditor = {
            bodyParts: anatomyData.bodyParts,
            grid: anatomyData.grid ?? {}
          };
          const armorByPart = system.armorByPart || {};
          const parts = anatomyData.bodyParts;
          context.coveredList = Object.keys(armorByPart)
            .filter((id) => parts[id])
            .map((id) => ({
              partId: id,
              partName: parts[id].name || id,
              armorValue: Number.isFinite(Number(armorByPart[id]?.value)) ? Number(armorByPart[id].value) : 0
            }))
            .sort((a, b) => a.partName.localeCompare(b.partName, game.i18n?.lang || 'en'));
        }
      } catch (e) {
        console.error('SpaceHolder | Failed to prepare wearable coverage data:', e);
      }
    }

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

    return context;
  }

  /** @inheritDoc — привязка кнопки и полей защиты выполняется через хук renderItemSheet в spaceholder.mjs */
  async _onRender(context, options) {
    await super._onRender(context, options);
  }

  /**
   * Собрать armorByPart из полей формы и сохранить в документ.
   * Вызывается из хука renderItemSheet и при blur/change полей защиты.
   * @param {HTMLFormElement} form
   * @private
   */
  async _submitWearableArmorFromForm(form) {
    const armorUpdates = {};
    form.querySelectorAll('input[name^="system.armorByPart."][name$=".value"]').forEach((input) => {
      const name = input.getAttribute('name') || '';
      const m = name.match(/^system\.armorByPart\.([^.]+)\.value$/);
      if (m) {
        const partId = m[1];
        const value = Number(input.value);
        armorUpdates[`system.armorByPart.${partId}.value`] = Number.isFinite(value) ? value : 0;
      }
    });
    if (Object.keys(armorUpdates).length) {
      await this.document.update(armorUpdates);
    }
  }
}

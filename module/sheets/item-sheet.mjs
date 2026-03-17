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

    // Defaults for older items
    context.system.actions = Array.isArray(context.system.actions) ? context.system.actions : [];
    if (this.item.type === 'wearable') {
      context.system.defaultActions = context.system.defaultActions || {};
      context.system.defaultActions.equip = context.system.defaultActions.equip || { showInCombat: false, showInQuickbar: true };
      context.system.defaultActions.unequip = context.system.defaultActions.unequip || { showInCombat: false, showInQuickbar: true };
    }

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
      await this.item.update({ 'system.actions': Array.isArray(next) ? next : [] });
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
        { id: 'actions' },
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

    return context;
  }

  /** @inheritDoc — привязка кнопки и полей защиты выполняется через хук renderItemSheet в spaceholder.mjs */
  async _onRender(context, options) {
    await super._onRender(context, options);
  }

}

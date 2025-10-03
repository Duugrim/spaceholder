import {
  onManageActiveEffect,
  prepareActiveEffectCategories,
} from '../helpers/effects.mjs';
import { anatomyManager } from '../anatomy-manager.mjs';

// Base V2 Actor Sheet with Handlebars rendering
export class SpaceHolderBaseActorSheet extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.sheets.ActorSheet
) {
  // Default options for both character and npc
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS ?? {}, {
    classes: ['spaceholder', 'sheet', 'actor'],
    position: { width: 800, height: 'auto' },
    window: {
      resizable: true,
      contentClasses: ['standard-form']
    }
  });


  /* -------------------------------------------- */

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    // Use a safe clone of the actor data for further operations.
    const actorData = this.document.toObject(false);

    // Add the actor's data to context for easier access, as well as flags.
    context.system = actorData.system;
    context.flags = actorData.flags;

    // Обновляем данные здоровья в контексте со свежими данными из this.actor.system
    if (context.system?.health) {
      context.system.health.totalHealth = this.actor.system.health?.totalHealth || context.system.health.totalHealth;
    }

    // Adding a pointer to CONFIG.SPACEHOLDER
    context.config = CONFIG.SPACEHOLDER;

    // Provide actor reference for templates (compat layer with v1 templates)
    context.actor = this.actor;
    context.editable = this.isEditable;

    // Prepare data per type
    if (actorData.type === 'character') {
      this._prepareItems(context);
      this._prepareCharacterData(context);
      await this._prepareAnatomyData(context);
    } else if (actorData.type === 'npc') {
      this._prepareItems(context);
    }

    // Всегда обновляем данные здоровья при каждой перерисовке
    this._prepareHealthData(context);

    // Enrich biography info for display
    context.enrichedBiography = await foundry.applications.ux.TextEditor.implementation.enrichHTML(this.actor.system.biography, {
      secrets: this.document.isOwner,
      async: true,
      rollData: this.actor.getRollData(),
      relativeTo: this.actor,
    });

    // Prepare active effects
    context.effects = prepareActiveEffectCategories(this.actor.allApplicableEffects());

    return context;
  }

  /**
   * Character-specific context modifications
   *
   * @param {object} context The context object to mutate
   */
  _prepareCharacterData(context) {
    // This is where you can enrich character-specific editor fields
    // or setup anything else that's specific to this type
    
    // Prepare health data for UI
    this._prepareHealthData(context);
  }

  /**
   * Prepare anatomy data for UI
   * @param {object} context The context object to mutate
   */
  async _prepareAnatomyData(context) {
    // Get available anatomies
    const availableAnatomies = anatomyManager.getAvailableAnatomies();
    
    // Create choices array for dialog dropdown
    context.anatomyChoices = {};
    for (let [id, anatomy] of Object.entries(availableAnatomies)) {
      context.anatomyChoices[id] = anatomyManager.getAnatomyDisplayName(id);
    }
    
    // Current anatomy type from the actual actor data  
    context.currentAnatomyType = this.actor.system.anatomy?.type;
    context.anatomyDisplayName = context.currentAnatomyType ? 
      anatomyManager.getAnatomyDisplayName(context.currentAnatomyType) : null;
  }

  /**
   * Prepare health data for the health tab UI
   * @param {object} context The context object to mutate
   */
  _prepareHealthData(context) {
    // Принудительно обновляем актера для получения свежих данных
    const freshActorData = this.actor.system;
    const bodyParts = freshActorData.health?.bodyParts;
    
    const count = bodyParts ? Object.keys(bodyParts).length : 0;
    console.log('[DEBUG] _prepareHealthData: preparing health data...', {
      totalHealth: freshActorData.health?.totalHealth,
      bodyPartsCount: count
    });
    // Флаг наличия анатомии для UI-тоггла
    context.hasAnatomy = count > 0;
    
    if (!bodyParts) {
      context.hierarchicalBodyParts = [];
      context.injuredParts = null;
      return;
    }

    // Mark injured parts and prepare hierarchical structure
    const injuredParts = {};
    
    for (let [partId, part] of Object.entries(bodyParts)) {
      // Mark as injured if not at full health
      part.isInjured = part.currentHp < part.maxHp;
      
      // Add to injured parts if damaged
      if (part.isInjured) {
        injuredParts[partId] = part;
      }
    }
    
    // Add injured parts to context (for backward compatibility)
    context.injuredParts = Object.keys(injuredParts).length > 0 ? injuredParts : null;
    
    // Build hierarchical structure for all body parts using fresh data
    context.hierarchicalBodyParts = this._buildHierarchicalBodyParts(bodyParts);
    
    // Update fresh data for physical capacities, blood, and pain in context
    if (context.system.health) {
      context.system.health.blood = freshActorData.health?.blood || context.system.health.blood;
      context.system.health.pain = freshActorData.health?.pain || context.system.health.pain;
    }
    
    if (context.system.physicalCapacities) {
      context.system.physicalCapacities = freshActorData.physicalCapacities || context.system.physicalCapacities;
    }
    
    console.log(`[DEBUG] Prepared ${context.hierarchicalBodyParts.length} body parts for display`);
  }
  
  /**
   * Build hierarchical structure of body parts for ASCII tree display
   * @param {object} bodyParts - All body parts
   * @returns {Array} Flat array with tree structure info
   */
  _buildHierarchicalBodyParts(bodyParts) {
    if (!bodyParts) return [];
    
    const result = [];
    
    // Find root parts
    const rootParts = [];
    for (let [partId, part] of Object.entries(bodyParts)) {
      if (!part.parent) {
        rootParts.push({ ...part, id: partId });
      }
    }
    
    // Recursive function to build tree lines
    const buildTreeLines = (parentId, prefix = '', isLast = true) => {
      const children = [];
      for (let [partId, part] of Object.entries(bodyParts)) {
        if (part.parent === parentId) {
          children.push({ ...part, id: partId });
        }
      }
      
      // Sort children by coverage (descending)
      children.sort((a, b) => b.coverage - a.coverage);
      
      children.forEach((child, index) => {
        const isLastChild = index === children.length - 1;
        const currentPrefix = prefix + (isLastChild ? '└─ ' : '├─ ');
        const nextPrefix = prefix + (isLastChild ? '   ' : '│  ');
        
        result.push({
          ...child,
          treePrefix: currentPrefix,
          hasChildren: this._hasChildren(child.id, bodyParts)
        });
        
        // Recursively add children
        buildTreeLines(child.id, nextPrefix, isLastChild);
      });
    };
    
    // Add root parts and their children
    rootParts.forEach((rootPart, index) => {
      result.push({
        ...rootPart,
        treePrefix: '',
        hasChildren: this._hasChildren(rootPart.id, bodyParts)
      });
      
      buildTreeLines(rootPart.id, '', true);
    });
    
    return result;
  }
  
  /**
   * Check if a body part has children
   * @param {string} partId - Body part ID
   * @param {object} bodyParts - All body parts
   * @returns {boolean}
   */
  _hasChildren(partId, bodyParts) {
    for (let part of Object.values(bodyParts)) {
      if (part.parent === partId) {
        return true;
      }
    }
    return false;
  }

  /**
   * Organize and classify Items for Actor sheets.
   *
   * @param {object} context The context object to mutate
   */
  _prepareItems(context) {
    // Initialize containers.
    const gear = [];
    const features = [];
    const spells = {
      0: [],
      1: [],
      2: [],
      3: [],
      4: [],
      5: [],
      6: [],
      7: [],
      8: [],
      9: [],
    };

    // Get items from the actor (v2: context.items не предоставляется базовым классом)
    const items = this.actor.items;
    // Сохраняем для шаблонов, если где-то используются
    context.items = Array.from(items);

    // Iterate through items, allocating to containers
    for (let i of items) {
      i.img = i.img || Item.DEFAULT_ICON;
      // Append to gear.
      if (i.type === 'item') {
        gear.push(i);
      }
      // Append to features.
      else if (i.type === 'feature') {
        features.push(i);
      }
      // Append to spells.
      else if (i.type === 'spell') {
        if (i.system.spellLevel != undefined) {
          spells[i.system.spellLevel].push(i);
        }
      }
    }

    // Assign and return
    context.gear = gear;
    context.features = features;
    context.spells = spells;
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;

    // Re-apply active tab on every render to ensure section classes are correct
    const hasAnyParts = !!(this.actor.system?.health?.bodyParts && Object.keys(this.actor.system.health.bodyParts).length);
    const desiredTab = this._activeTabPrimary ?? this.tabGroups?.primary ?? (hasAnyParts ? 'stats' : 'health');
    try { this.changeTab(desiredTab, 'primary', { updatePosition: false, force: true }); } catch (e) { /* ignore */ }

    // Tabs: use native ApplicationV2 changeTab via [data-action=\"tab\"] in templates.

    // Render the item sheet for viewing/editing prior to the editable check.
    el.querySelectorAll('.item-edit').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        const li = ev.currentTarget.closest('.item');
        const item = this.actor.items.get(li.dataset.itemId);
        item?.sheet?.render(true);
      });
    });

    // Everything below here is only needed if the sheet is editable
    if (!this.isEditable) return;

    // Add Inventory Item
    el.querySelectorAll('.item-create').forEach(btn => {
      btn.addEventListener('click', this._onItemCreate.bind(this));
    });

    // Delete Inventory Item
    el.querySelectorAll('.item-delete').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        const li = ev.currentTarget.closest('.item');
        const item = this.actor.items.get(li.dataset.itemId);
        item?.delete();
        this.render(false);
      });
    });

    // Active Effect management
    el.querySelectorAll('.effect-control').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        const row = ev.currentTarget.closest('li');
        const document = row.dataset.parentId === this.actor.id ? this.actor : this.actor.items.get(row.dataset.parentId);
        onManageActiveEffect(ev, document);
      });
    });

    // Rollable abilities.
    el.querySelectorAll('.rollable').forEach(btn => btn.addEventListener('click', this._onRoll.bind(this)));

    // Anatomy toggle button (choose/delete)
    el.querySelectorAll('.anatomy-toggle-btn').forEach(btn => btn.addEventListener('click', this._onAnatomyToggleClick.bind(this)));

    // Health debug toggle
    el.querySelectorAll('input[name="flags.spaceholder.healthDebug"]').forEach(inp => inp.addEventListener('change', this._onHealthDebugToggle.bind(this)));

    // Drag events for macros.
    if (this.actor.isOwner) {
      const handler = (ev) => this._onDragStart(ev);
      el.querySelectorAll('li.item').forEach((li) => {
        if (li.classList.contains('inventory-header')) return;
        li.setAttribute('draggable', 'true');
        li.addEventListener('dragstart', handler, false);
      });
    }
  }

  /**
   * Handle health debug mode toggle
   * @param {Event} event   The originating change event
   */
  _onHealthDebugToggle(event) {
    event.preventDefault();
    const element = event.currentTarget;
    const value = element.checked;
    
    // Update the flag
    this.actor.update({
      'flags.spaceholder.healthDebug': value
    });
  }

  /**
   * Handle creating a new Owned Item for the actor using initial data defined in the HTML dataset
   * @param {Event} event   The originating click event
   * @private
   */
  async _onItemCreate(event) {
    event.preventDefault();
    const header = event.currentTarget;
    // Get the type of item to create.
    const type = header.dataset.type;
    // Grab any data associated with this control.
    const data = duplicate(header.dataset);
    // Initialize a default name.
    const name = `New ${type.capitalize()}`;
    // Prepare the item object.
    const itemData = {
      name: name,
      type: type,
      system: data,
    };
    // Remove the type from the dataset since it's in the itemData.type prop.
    delete itemData.system['type'];

    // Finally, create the item!
    return await Item.create(itemData, { parent: this.actor });
  }

  /**
   * Handle anatomy change button click
   * @param {Event} event   The originating click event
   * @private
   */
  async _onChangeAnatomyClick(event) {
    event.preventDefault();
    
    const availableAnatomies = anatomyManager.getAvailableAnatomies();
    const currentType = this.actor.system.anatomy?.type;
    
    // Build options for the select
    let optionsHTML = '';
    for (let [id, anatomy] of Object.entries(availableAnatomies)) {
      const selected = id === currentType ? 'selected' : '';
      const displayName = anatomyManager.getAnatomyDisplayName(id);
      optionsHTML += `<option value="${id}" ${selected}>${displayName}</option>`;
    }
    
    const dialogContent = `
      <div class="anatomy-change-dialog">
        <p><strong>Выберите новый тип анатомии:</strong></p>
        <div class="form-group">
          <select id="anatomy-select" style="width: 100%; padding: 8px; margin: 10px 0; height: 40px; font-size: 14px;">
            ${optionsHTML}
          </select>
        </div>
        ${currentType ? 
          '<p class="warning"><i class="fas fa-exclamation-triangle"></i> <strong>Warning:</strong> This will replace all current body parts and reset health values.</p>' : 
          '<p class="info"><i class="fas fa-info-circle"></i> This will initialize the anatomy system for this character.</p>'
        }
      </div>
    `;
    
    // Show dialog
    await foundry.applications.api.DialogV2.wait({
      window: { title: currentType ? 'Change Anatomy Type' : 'Select Anatomy Type', icon: 'fa-solid fa-user' },
      position: { width: 400 },
      content: dialogContent,
      buttons: [
        {
          action: 'change',
          label: currentType ? 'Change' : 'Select',
          icon: 'fa-solid fa-check',
          default: true,
          callback: async (event) => {
            const selectedType = event.currentTarget.querySelector('#anatomy-select')?.value;
            if (selectedType && selectedType !== currentType) {
              await this._performAnatomyChange(selectedType);
            }
          }
        },
        { action: 'cancel', label: 'Cancel', icon: 'fa-solid fa-times' }
      ]
    });
  }
  
  /**
   * Perform the anatomy change with proper cleanup
   * @param {string} newAnatomyType - New anatomy type ID
   * @private
   */
  async _performAnatomyChange(newAnatomyType) {
    try {
      // changeAnatomyType теперь сам делает полную очистку
      const success = await this.actor.changeAnatomyType(newAnatomyType);
      
      if (success) {
        ui.notifications.info(`Анатомия изменена на ${anatomyManager.getAnatomyDisplayName(newAnatomyType)}`);
        // Сохраняем активной вкладку "health" и принудительно перерисовываем
        this._activeTabPrimary = 'health';
        this.render({ force: true, tab: { primary: 'health' } });
      } else {
        ui.notifications.error('Не удалось изменить тип анатомии');
      }
    } catch (error) {
      console.error('Ошибка при смене анатомии:', error);
      ui.notifications.error('Произошла ошибка при смене анатомии');
    }
  }
  
  /**
   * Handle anatomy toggle click: choose new anatomy if none, otherwise delete existing
   * @param {Event} event
   * @private
   */
  async _onAnatomyToggleClick(event) {
    event.preventDefault();
    const hasAnatomy = !!(this.actor.system.health?.bodyParts && Object.keys(this.actor.system.health.bodyParts).length);
    if (hasAnatomy) {
      // Delegate to reset handler
      return this._onResetAnatomyClick(event);
    }
    // Otherwise open selection dialog
    return this._onChangeAnatomyClick(event);
  }
  
  /**
   * Handle anatomy reset button click (full cleanup with confirmation)
   * @param {Event} event   The originating click event
   * @private
   */
  async _onResetAnatomyClick(event) {
    event.preventDefault();

    const hasAnyParts = !!(this.actor.system.anatomy?.bodyParts && Object.keys(this.actor.system.anatomy.bodyParts).length)
      || !!(this.actor.system.health?.bodyParts && Object.keys(this.actor.system.health.bodyParts).length);

    const content = `
      <div>
        <p><strong>Вы уверены, что хотите полностью очистить анатомию?</strong></p>
        <p>Будут удалены все части тела и сброшено общее здоровье. ${this.actor.system.anatomy?.type ? `Текущий тип анатомии: <em>${anatomyManager.getAnatomyDisplayName(this.actor.system.anatomy.type)}</em>.` : ''}</p>
      </div>
    `;

    await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Сброс анатомии', icon: 'fa-solid fa-trash' },
      content,
      yes: {
        label: 'Сбросить',
        icon: 'fa-solid fa-trash',
        callback: async () => {
          try {
            if (typeof this.actor.resetAnatomy === 'function') {
              await this.actor.resetAnatomy(true);
            } else {
              const currentParts = this.actor.system.health?.bodyParts || {};
              const delUpdate = { 'system.anatomy.type': null, 'system.health.totalHealth': { current: 0, max: 0, percentage: 100 } };
              for (const id of Object.keys(currentParts)) {
                delUpdate[`system.health.bodyParts.-=${id}`] = null;
              }
              await this.actor.update(delUpdate);
              await this.actor.prepareData();
            }
            ui.notifications.info('Анатомия очищена');
            this.render(true);
          } catch (e) {
            console.error('Ошибка при сбросе анатомии:', e);
            ui.notifications.error('Не удалось очистить анатомию');
          }
        }
      },
      no: { label: 'Отмена', icon: 'fa-solid fa-times' }
    });
  }

  /**
   * Handle clickable rolls.
   * @param {Event} event   The originating click event
   * @private
   */
  _onRoll(event) {
    event.preventDefault();
    const element = event.currentTarget;
    const dataset = element.dataset;

    // Handle item rolls.
    if (dataset.rollType) {
      if (dataset.rollType == 'item') {
        const itemId = element.closest('.item').dataset.itemId;
        const item = this.actor.items.get(itemId);
        if (item) return item.roll();
      }
    }

    // Handle rolls that supply the formula directly.
    if (dataset.roll) {
      let label = dataset.label ? `[ability] ${dataset.label}` : '';
      let roll = new Roll(dataset.roll, this.actor.getRollData());
      roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        flavor: label,
        rollMode: game.settings.get('core', 'rollMode'),
      });
      return roll;
    }
  }
}

// Character-specific sheet (Application V2)
export class SpaceHolderCharacterSheet extends SpaceHolderBaseActorSheet {
  // Native tabs for character sheet: stats (Характеристики) and health (Здоровье)
  static TABS = {
    primary: {
      tabs: [ { id: 'stats' }, { id: 'health' } ],
      initial: 'stats'
    }
  };
  static PARTS = {
    body: { root: true, template: 'systems/spaceholder/templates/actor/actor-character-sheet.hbs' }
  };

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    const hasAnyParts = !!(this.actor.system?.health?.bodyParts && Object.keys(this.actor.system.health.bodyParts).length);
    const tabId = this._activeTabPrimary ?? (hasAnyParts ? 'stats' : 'health');
    try { this.changeTab(tabId, 'primary', { updatePosition: true }); } catch (e) { /* ignore */ }
  }

  // Persist active tab whenever it changes
  changeTab(tab, group, options={}) {
    if (group === 'primary') this._activeTabPrimary = tab;
    return super.changeTab(tab, group, options);
  }

  /** @inheritDoc */
  _configureRenderOptions(options) {
    super._configureRenderOptions(options);
    const hasAnyParts = !!(this.actor.system?.health?.bodyParts && Object.keys(this.actor.system.health.bodyParts).length);
    const selected = this._activeTabPrimary ?? (hasAnyParts ? 'stats' : 'health');
    options.tab = { primary: selected };
  }
}

// NPC-specific sheet (Application V2)
export class SpaceHolderNPCSheet extends SpaceHolderBaseActorSheet {
  static PARTS = {
    body: { root: true, template: 'systems/spaceholder/templates/actor/actor-npc-sheet.hbs' }
  };
}

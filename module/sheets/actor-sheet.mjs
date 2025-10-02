import {
  onManageActiveEffect,
  prepareActiveEffectCategories,
} from '../helpers/effects.mjs';
import { anatomyManager } from '../anatomy-manager.mjs';

/**
 * Extend the basic ActorSheet with some very simple modifications
 * @extends {ActorSheet}
 */
export class SpaceHolderActorSheet extends ActorSheet {
  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ['spaceholder', 'sheet', 'actor'],
      width: 600,
      height: 600,
      tabs: [
        {
          navSelector: '.sheet-tabs',
          contentSelector: '.sheet-body',
          initial: 'features',
        },
      ],
    });
  }

  /** @override */
  get template() {
    return `systems/spaceholder/templates/actor/actor-${this.actor.type}-sheet.hbs`;
  }

  /* -------------------------------------------- */

  /** @override */
  async getData() {
    // Retrieve the data structure from the base sheet. You can inspect or log
    // the context variable to see the structure, but some key properties for
    // sheets are the actor object, the data object, whether or not it's
    // editable, the items array, and the effects array.
    const context = super.getData();

    // Use a safe clone of the actor data for further operations.
    const actorData = this.document.toObject(false);

    // Add the actor's data to context.data for easier access, as well as flags.
    context.system = actorData.system;
    context.flags = actorData.flags;
    
    // Обновляем данные здоровья в контексте со свежими данными из this.actor.system
    if (context.system.health) {
      context.system.health.totalHealth = this.actor.system.health?.totalHealth || context.system.health.totalHealth;
    }

    // Adding a pointer to CONFIG.SPACEHOLDER
    context.config = CONFIG.SPACEHOLDER;

    // Prepare character data and items.
    if (actorData.type == 'character') {
      this._prepareItems(context);
      this._prepareCharacterData(context);
      // Prepare anatomy data
      await this._prepareAnatomyData(context);
    }

    // Prepare NPC data and items.
    if (actorData.type == 'npc') {
      this._prepareItems(context);
    }
    
    // Всегда обновляем данные здоровья при каждой перерисовке
    this._prepareHealthData(context);

    // Enrich biography info for display
    // Enrichment turns text like `[[/r 1d20]]` into buttons
    context.enrichedBiography = await TextEditor.enrichHTML(
      this.actor.system.biography,
      {
        // Whether to show secret blocks in the finished html
        secrets: this.document.isOwner,
        // Necessary in v11, can be removed in v12
        async: true,
        // Data to fill in for inline rolls
        rollData: this.actor.getRollData(),
        // Relative UUID resolution
        relativeTo: this.actor,
      }
    );

    // Prepare active effects
    context.effects = prepareActiveEffectCategories(
      // A generator that returns all effects stored on the actor
      // as well as any items
      this.actor.allApplicableEffects()
    );

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
    const bodyParts = freshActorData.anatomy?.bodyParts || freshActorData.health?.bodyParts;
    
    console.log('[DEBUG] _prepareHealthData: preparing health data...', {
      totalHealth: freshActorData.health?.totalHealth,
      bodyPartsCount: bodyParts ? Object.keys(bodyParts).length : 0
    });
    
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

    // Iterate through items, allocating to containers
    for (let i of context.items) {
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

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    // Render the item sheet for viewing/editing prior to the editable check.
    html.on('click', '.item-edit', (ev) => {
      const li = $(ev.currentTarget).parents('.item');
      const item = this.actor.items.get(li.data('itemId'));
      item.sheet.render(true);
    });

    // -------------------------------------------------------------
    // Everything below here is only needed if the sheet is editable
    if (!this.isEditable) return;

    // Add Inventory Item
    html.on('click', '.item-create', this._onItemCreate.bind(this));

    // Delete Inventory Item
    html.on('click', '.item-delete', (ev) => {
      const li = $(ev.currentTarget).parents('.item');
      const item = this.actor.items.get(li.data('itemId'));
      item.delete();
      li.slideUp(200, () => this.render(false));
    });

    // Active Effect management
    html.on('click', '.effect-control', (ev) => {
      const row = ev.currentTarget.closest('li');
      const document =
        row.dataset.parentId === this.actor.id
          ? this.actor
          : this.actor.items.get(row.dataset.parentId);
      onManageActiveEffect(ev, document);
    });

    // Rollable abilities.
    html.on('click', '.rollable', this._onRoll.bind(this));
    
    // Change anatomy button
    html.on('click', '.change-anatomy-btn', this._onChangeAnatomyClick.bind(this));

    // Health debug toggle
    html.on('change', 'input[name="flags.spaceholder.healthDebug"]', this._onHealthDebugToggle.bind(this));

    // Drag events for macros.
    if (this.actor.isOwner) {
      let handler = (ev) => this._onDragStart(ev);
      html.find('li.item').each((i, li) => {
        if (li.classList.contains('inventory-header')) return;
        li.setAttribute('draggable', true);
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
    new Dialog({
      title: currentType ? "Change Anatomy Type" : "Select Anatomy Type",
      content: dialogContent,
      buttons: {
        change: {
          icon: '<i class="fas fa-check"></i>',
          label: currentType ? "Change" : "Select",
          callback: async (html) => {
            const selectedType = html.find('#anatomy-select').val();
            if (selectedType && selectedType !== currentType) {
              await this._performAnatomyChange(selectedType);
            }
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel"
        }
      },
      default: "change",
      render: (html) => {
        // Focus the select element
        html.find('#anatomy-select').focus();
      }
    }, {
      width: 400
    }).render(true);
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
        // Принудительная полная перерисовка
        this.render(true);
      } else {
        ui.notifications.error('Не удалось изменить тип анатомии');
      }
    } catch (error) {
      console.error('Ошибка при смене анатомии:', error);
      ui.notifications.error('Произошла ошибка при смене анатомии');
    }
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

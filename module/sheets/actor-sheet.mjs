import {
  onManageActiveEffect,
  prepareActiveEffectCategories,
} from '../helpers/effects.mjs';
import { anatomyManager } from '../anatomy-manager.mjs';
import { promptPickAndApplyIconToActorOrToken } from '../helpers/icon-picker/icon-apply.mjs';

// Base V2 Actor Sheet with Handlebars rendering
export class SpaceHolderBaseActorSheet extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.sheets.ActorSheetV2
) {
  /** @override */
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS ?? {}, {
    classes: ['spaceholder', 'sheet', 'actor'],
    position: { width: 640, height: 'auto' },
    window: {
      resizable: true,
      contentClasses: ['standard-form']
    },
    form: {
      submitOnChange: true
    }
  }, { inplace: false });

  /** @override */
  get title() {
    // Хотим, чтобы в заголовке окна всегда было только имя (без префикса типа)
    return this.document?.name ?? super.title;
  }
  
  /**
   * Попытаться определить TokenDocument, из которого открыт лист.
   * В Foundry v13 контекст токена может храниться не только в this.document.token.
   * @protected
   */
  _getTokenDocumentFromContext() {
    // 1) Synthetic actor обычно имеет document.token
    const direct = this.document?.token;
    if (direct?.documentName === 'Token') return direct;

    // 2) Некоторые варианты передают токен через options
    const opt = this.options?.token;
    if (opt?.documentName === 'Token') return opt;
    if (opt?.document?.documentName === 'Token') return opt.document;

    // 3) Fallback: извлечь из id приложения (обычно включает Scene-...-Token-...)
    const id = String(this.id ?? this.element?.id ?? '');
    const m = id.match(/Scene-([^-]+)-Token-([^-]+)-Actor-/);
    if (m) {
      const sceneId = m[1];
      const tokenId = m[2];
      const scene = game?.scenes?.get?.(sceneId) ?? null;
      const tokenDoc = scene?.tokens?.get?.(tokenId) ?? null;
      if (tokenDoc?.documentName === 'Token') return tokenDoc;
    }

    return null;
  }

  /**
   * Переопределяем _getHeaderControls:
   * - удаляем дубликаты
   * - убираем Token-контрол, если реального контекста токена нет (иначе Foundry падает на null.sheet)
   * @override
   */
  _getHeaderControls() {
    const controls = super._getHeaderControls();

    const tokenDoc = this._getTokenDocumentFromContext();
    const hasTokenContext = Boolean(tokenDoc);
    const hasPrototype = Boolean(this.document?.prototypeToken);

    const seen = new Set();
    return controls.filter((control) => {
      const key = control.label || control.icon || control.action;
      if (seen.has(key)) return false;
      seen.add(key);

      // Если контекста токена нет, но и prototypeToken тоже отсутствует,
      // не показываем конфигурацию токена.
      if (!hasTokenContext && !hasPrototype) {
        if (control.action === 'token') return false;
      }

      // Если контекста токена нет — убираем token action (Foundry пытается открыть null.sheet)
      if (!hasTokenContext && control.action === 'token') return false;

      return true;
    });
  }


  /* -------------------------------------------- */

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    // Use a safe clone of the actor data for further operations.
    const actorData = this.document.toObject(false);

    // Add the actor's data to context for easier access, as well as flags.
    context.system = actorData.system;
    context.flags = actorData.flags;

    // Обновляем данные здоровья (totalHealth удалён из системы)

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
    // Готовим данные для вкладки «Травмы»
    this._prepareInjuriesData(context);

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
    // Принудительно обновляем актёра для получения свежих данных
    const freshActorData = this.actor.system;
    const bodyParts = freshActorData.health?.bodyParts;
    const injuries = Array.isArray(freshActorData.health?.injuries) ? freshActorData.health.injuries : [];
    
    const count = bodyParts ? Object.keys(bodyParts).length : 0;

    // Флаг наличия анатомии для UI-тоггла
    context.hasAnatomy = count > 0;
    
    if (!bodyParts) {
      context.hierarchicalBodyParts = [];
      context.injuredParts = null;
      return;
    }

    // Предрасчёт суммы урона по частям (amount хранится в масштабе x100)
    const sumDamageByPart = {};
    for (const inj of injuries) {
      if (!inj?.partId || typeof inj.amount !== 'number') continue;
      sumDamageByPart[inj.partId] = (sumDamageByPart[inj.partId] || 0) + Math.max(0, inj.amount|0);
    }

    // Mark injured parts and prepare hierarchical structure
    const injuredParts = {};
    const currentHpMap = {};
    for (let [partId, part] of Object.entries(bodyParts)) {
      const sumAmt = sumDamageByPart[partId] || 0;
      const dmgUnits = Math.floor(sumAmt / 100); // x100 -> единицы HP
      const currentHpDerived = Math.max(0, part.maxHp - dmgUnits);
      currentHpMap[partId] = currentHpDerived;
      const isInjured = currentHpDerived < part.maxHp;
      if (isInjured) {
        injuredParts[partId] = { ...part, currentHp: currentHpDerived };
      }
    }
    
    // Add injured parts to context (for backward compatibility)
    context.injuredParts = Object.keys(injuredParts).length > 0 ? injuredParts : null;
    
    // Build hierarchical structure for all body parts using fresh data (подставляем currentHp из карты)
    context.hierarchicalBodyParts = this._buildHierarchicalBodyParts(bodyParts, currentHpMap);
    
  }
  
  /**
   * Build hierarchical structure of body parts for ASCII tree display
   * @param {object} bodyParts - All body parts
   * @returns {Array} Flat array with tree structure info
   */
  _buildHierarchicalBodyParts(bodyParts, currentHpMap = {}) {
    if (!bodyParts) return [];
    
    const result = [];
    
    // Find root parts
    const rootParts = [];
    for (let [partId, part] of Object.entries(bodyParts)) {
      if (!part.parent) {
        const currentHp = currentHpMap[partId] ?? part.maxHp;
        rootParts.push({ ...part, id: partId, currentHp });
      }
    }
    
    // Recursive function to build tree lines
    const buildTreeLines = (parentId, prefix = '', isLast = true) => {
      const children = [];
      for (let [partId, part] of Object.entries(bodyParts)) {
        if (part.parent === parentId) {
          const currentHp = currentHpMap[partId] ?? part.maxHp;
          children.push({ ...part, id: partId, currentHp });
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
          hasChildren: this._hasChildren(child.id, bodyParts),
          isInjured: (child.currentHp ?? child.maxHp) < child.maxHp
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
        hasChildren: this._hasChildren(rootPart.id, bodyParts),
        isInjured: (rootPart.currentHp ?? rootPart.maxHp) < rootPart.maxHp
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

    // Calculate inventory totals
    let totalWeight = 0;
    let totalItems = 0;
    
    for (let item of gear) {
      const quantity = item.system.quantity || 0;
      const weight = item.system.weight || 0;
      totalItems += quantity;
      totalWeight += weight * quantity;
    }
    
    // Assign and return
    context.gear = gear;
    context.features = features;
    context.spells = spells;
    context.totalWeight = Math.round(totalWeight * 100) / 100; // Round to 2 decimal places
    context.totalItems = totalItems;
  }

  /**
   * Update inventory totals in the DOM without full re-render
   */
  _updateInventoryTotals() {
    const gear = this.actor.items.filter(i => i.type === 'item');
    let totalWeight = 0;
    let totalItems = 0;
    
    for (let item of gear) {
      const quantity = item.system.quantity || 0;
      const weight = item.system.weight || 0;
      totalItems += quantity;
      totalWeight += weight * quantity;
    }
    
    totalWeight = Math.round(totalWeight * 100) / 100; // Round to 2 decimal places
    
    // Update DOM elements
    const weightEl = this.element.querySelector('.stat-value');
    const itemsEl = this.element.querySelector('.inventory-stat .stat-value');

    const kg = game?.i18n?.localize?.('SPACEHOLDER.Units.Kg') ?? 'kg';
    const itemTotalWeightLabel = game?.i18n?.localize?.('SPACEHOLDER.Inventory.ItemTotalWeight') ?? 'Total weight:';

    if (weightEl && weightEl.closest('.inventory-stat').querySelector('i.fa-weight-hanging')) {
      weightEl.textContent = `${totalWeight} ${kg}`;
    }
    if (itemsEl && itemsEl.closest('.inventory-stat').querySelector('i.fa-boxes')) {
      itemsEl.textContent = totalItems;
    }

    // Update total weight displays in individual rows
    this.element.querySelectorAll('.inventory-item-card').forEach(row => {
      const itemId = row.dataset.itemId;
      const item = this.actor.items.get(itemId);
      if (item && item.type === 'item') {
        const weightSpan = row.querySelector('.item-weight');
        if (weightSpan && item.system.weight) {
          const totalItemWeight = (item.system.weight * item.system.quantity) || 0;
          weightSpan.textContent = `${itemTotalWeightLabel} ${Math.round(totalItemWeight * 100) / 100} ${kg}`;
        }
      }
    });
  }

  /* -------------------------------------------- */

  /** Подготовка данных для вкладки «Травмы» */
  _prepareInjuriesData(context) {
    const system = this.actor.system;
    const injuries = Array.isArray(system.health?.injuries) ? system.health.injuries : [];
    const bodyParts = system.health?.bodyParts || {};

    // Опции для выпадающего списка частей
    context.bodyPartSelectOptions = Object.entries(bodyParts).map(([id, part]) => ({ id, name: part.name }));

    // Представление травм для UI
    context.injuriesList = injuries.map(inj => {
      const part = bodyParts[inj.partId];
      return {
        ...this.actor.formatInjuryForDisplay?.(inj) ?? inj,
        id: inj.id,
        partName: part?.name || inj.partId,
        amountDisplay: (Math.floor((inj.amount ?? 0)) / 100).toFixed(2), // amount хранится x100
        createdAtText: inj.createdAt ? new Date(inj.createdAt).toLocaleString() : ''
      };
    });
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;

    // Profile image: open avatar file picker on click
    // (в ActorSheetV2 data-edit="img" не всегда обрабатывается автоматически)
    const profileHandler = this._onProfileImageClickBound ??= this._onProfileImageClick.bind(this);
    el?.querySelectorAll('img.profile-img[data-edit], img.profile-img').forEach((img) => {
      img.addEventListener('click', profileHandler);
    });

    // Icon picker button (curated SVG library)
    const iconPickHandler = this._onIconPickClickBound ??= this._onIconPickClick.bind(this);
    el?.querySelectorAll('[data-action="sh-icon-pick"]').forEach((btn) => {
      btn.addEventListener('click', iconPickHandler);
    });

    // Re-apply active tab on every render to ensure section classes are correct
    const hasAnyParts = !!(this.actor.system?.health?.bodyParts && Object.keys(this.actor.system.health.bodyParts).length);
    const desiredTab = this._activeTabPrimary ?? this.tabGroups?.primary ?? (hasAnyParts ? 'stats' : 'health');
    try { this.changeTab(desiredTab, 'primary', { updatePosition: false, force: true }); } catch (e) { /* ignore */ }

    // Tabs: use native ApplicationV2 changeTab via [data-action=\"tab\"] in templates.

    // Render the item sheet for viewing/editing prior to the editable check.
    el.querySelectorAll('.item-edit').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        const card = ev.currentTarget.closest('.inventory-item-card');
        const itemId = card?.dataset?.itemId || btn.dataset?.itemId;
        const item = this.actor.items.get(itemId);
        item?.sheet?.render(true);
      });
    });

    // Everything below here is only needed if the sheet is editable
    if (!this.isEditable) return;

    // Injuries: add listeners
    el.querySelectorAll('[data-action="injury-open-create"]').forEach(btn => btn.addEventListener('click', this._onInjuryCreateOpen.bind(this)));
    el.querySelectorAll('[data-action="injury-delete"]').forEach(btn => btn.addEventListener('click', this._onInjuryDelete.bind(this)));
    el.querySelectorAll('[data-action="injury-edit"]').forEach(btn => btn.addEventListener('click', this._onInjuryEdit.bind(this)));

    // Add Inventory Item
    el.querySelectorAll('.item-create-btn').forEach(btn => {
      btn.addEventListener('click', this._onItemCreate.bind(this));
    });

    // Delete Inventory Item
    el.querySelectorAll('.item-delete').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        const card = ev.currentTarget.closest('.inventory-item-card');
        const itemId = card?.dataset?.itemId || btn.dataset?.itemId;
        const item = this.actor.items.get(itemId);
        item?.delete();
        this.render(false);
      });
    });

    // Note: Quantity editing is now handled through the item sheet since we removed inline editing
    // This keeps the interface cleaner and follows the new design pattern

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

  /** Открыть диалог создания травмы */
  async _onInjuryCreateOpen(event) {
    event.preventDefault();

    const bodyParts = this.actor.system.health?.bodyParts || {};

    const L = (key) => game.i18n.localize(key);
    const title = L('SPACEHOLDER.Injuries.Add');
    const labelPart = L('SPACEHOLDER.Injuries.Fields.Part');
    const labelDamage = L('SPACEHOLDER.Injuries.Fields.Damage');
    const labelType = L('SPACEHOLDER.Injuries.Fields.Type');
    const labelStatus = L('SPACEHOLDER.Injuries.Fields.Status');
    const labelSource = L('SPACEHOLDER.Injuries.Fields.Source');
    const optional = L('SPACEHOLDER.Common.Optional');

    const optionsHTML = Object.entries(bodyParts).map(([id, p]) => `<option value="${id}">${p.name}</option>`).join('');
    const content = `
      <div class="injury-create-dialog">
        <div class="form-group"><label>${labelPart}</label>
          <select id="inj-part" style="width:100%; height:32px;">${optionsHTML}</select>
        </div>
        <div class="form-group"><label>${labelDamage}</label><input id="inj-amount" type="number" step="0.01" min="0" placeholder="0.00"/></div>
        <div class="form-group"><label>${labelType}</label><input id="inj-type" type="text" placeholder="${optional}"/></div>
        <div class="form-group"><label>${labelStatus}</label><input id="inj-status" type="text" placeholder="${optional}"/></div>
        <div class="form-group"><label>${labelSource}</label><input id="inj-source" type="text" placeholder="${optional}"/></div>
      </div>`;

    await foundry.applications.api.DialogV2.wait({
      window: { title, icon: 'fa-solid fa-plus' },
      position: { width: 420 },
      content,
      buttons: [
        {
          action: 'create', label: L('SPACEHOLDER.Actions.Add'), icon: 'fa-solid fa-check', default: true,
          callback: async (dlgEvent) => {
            const root = dlgEvent.currentTarget;
            const partId = root.querySelector('#inj-part')?.value;
            const amountStr = root.querySelector('#inj-amount')?.value ?? '0';
            const type = root.querySelector('#inj-type')?.value ?? '';
            const status = root.querySelector('#inj-status')?.value ?? '';
            const source = root.querySelector('#inj-source')?.value ?? '';
            const parsed = Number.parseFloat(String(amountStr).replace(',', '.'));
            if (!partId || Number.isNaN(parsed)) {
              ui.notifications.warn(L('SPACEHOLDER.Injuries.Errors.InvalidInput'));
              return;
            }
            const amount = Math.max(0, Math.floor(parsed * 100));
            await this.actor.addInjury({ partId, amount, type, status, source });
            this.render(false);
          }
        },
        { action: 'cancel', label: L('SPACEHOLDER.Actions.Cancel'), icon: 'fa-solid fa-times' }
      ]
    });
  }

  /** Удалить травму */
  async _onInjuryDelete(event) {
    event.preventDefault();
    const btn = event.currentTarget;
    const id = btn?.dataset?.injuryId;
    if (!id) return;
    await this.actor.removeInjury(id);
    this.render(false);
  }

  /** Редактировать травму */
  async _onInjuryEdit(event) {
    event.preventDefault();
    const btn = event.currentTarget;
    const id = btn?.dataset?.injuryId;
    if (!id) return;

    const existing = (this.actor.system.health?.injuries || []).find(i => i.id === id);
    if (!existing) return;

    const partName = this.actor.system.health?.bodyParts?.[existing.partId]?.name || existing.partId;

    const L = (key) => game.i18n.localize(key);
    const title = L('SPACEHOLDER.Injuries.EditTitle');
    const heading = game.i18n.format('SPACEHOLDER.Injuries.EditTitleWithPart', { part: partName });
    const labelDamage = L('SPACEHOLDER.Injuries.Fields.Damage');
    const labelType = L('SPACEHOLDER.Injuries.Fields.Type');
    const labelStatus = L('SPACEHOLDER.Injuries.Fields.Status');
    const labelSource = L('SPACEHOLDER.Injuries.Fields.Source');

    const content = `
      <div class="injury-edit-dialog">
        <p><strong>${heading}</strong></p>
        <div class="form-group"><label>${labelDamage}</label><input id="inj-amount" type="number" step="0.01" value="${(existing.amount||0)/100}"/></div>
        <div class="form-group"><label>${labelType}</label><input id="inj-type" type="text" value="${existing.type||''}"/></div>
        <div class="form-group"><label>${labelStatus}</label><input id="inj-status" type="text" value="${existing.status||''}"/></div>
        <div class="form-group"><label>${labelSource}</label><input id="inj-source" type="text" value="${existing.source||''}"/></div>
      </div>
    `;

    await foundry.applications.api.DialogV2.wait({
      window: { title, icon: 'fa-solid fa-bandage' },
      position: { width: 400 },
      content,
      buttons: [
        {
          action: 'save',
          label: L('SPACEHOLDER.Actions.Save'),
          icon: 'fa-solid fa-check',
          default: true,
          callback: async (dlgEvent) => {
            const root = dlgEvent.currentTarget;
            const amountStr = root.querySelector('#inj-amount')?.value ?? '0';
            const type = root.querySelector('#inj-type')?.value ?? '';
            const status = root.querySelector('#inj-status')?.value ?? '';
            const source = root.querySelector('#inj-source')?.value ?? '';
            const parsed = Number.parseFloat(String(amountStr).replace(',', '.'));
            if (!Number.isNaN(parsed)) {
              const amount = Math.max(0, Math.floor(parsed * 100));
              await this.actor.updateInjury(id, { amount, type, status, source });
              this.render(false);
            }
          }
        },
        { action: 'cancel', label: L('SPACEHOLDER.Actions.Cancel'), icon: 'fa-solid fa-times' }
      ]
    });
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
              const delUpdate = { 'system.anatomy.type': null };
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
   * Открыть выбор иконки из библиотеки и применить к actor/token/both.
   * @private
   */
  async _onIconPickClick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (!this.isEditable) return;

    const actor = this.document;
    const tokenDoc = this._getTokenDocumentFromContext?.() ?? null;

    const picked = await promptPickAndApplyIconToActorOrToken({
      actor,
      tokenDoc,
      defaultColor: '#ffffff',
    });

    if (picked) {
      try { this.render(false); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Клик по портрету: открыть FilePicker для смены аватара
   * @private
   */
  async _onProfileImageClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const imgEl = event.currentTarget;
    const field = imgEl?.dataset?.edit || 'img';

    // Если лист не редактируемый — просто показываем попап изображения
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
      tabs: [ { id: 'stats' }, { id: 'health' }, { id: 'injuries' } ],
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

// Global Object sheet (Application V2)
export class SpaceHolderGlobalObjectSheet extends SpaceHolderBaseActorSheet {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS ?? {}, {
    position: { width: 560, height: 'auto' },
  }, { inplace: false });

  static PARTS = {
    body: { root: true, template: 'systems/spaceholder/templates/actor/actor-globalobject-sheet.hbs' },
  };

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    // Убедимся, что поля существуют (на случай старых актёров)
    context.system = context.system || {};
    context.system.gLink ??= '';
    context.system.gFaction ??= '';
    context.system.gActors ??= [];
    if (!Array.isArray(context.system.gActors)) context.system.gActors = [];

    // Flags (на случай старых актёров)
    context.flags = context.flags || {};
    context.flags.spaceholder = context.flags.spaceholder || {};

    // Имена для отображения (как content-link в тексте Foundry)
    context.gLinkName = await this._resolveJournalName(context.system.gLink);
    context.gFactionName = await this._resolveJournalName(context.system.gFaction);

    // Контейнер актёров (UUID -> данные для шаблона)
    context.gActorsResolved = [];
    for (const raw of context.system.gActors) {
      const uuid = String(raw ?? '').trim();
      if (!uuid) continue;

      let doc = null;
      try {
        doc = await fromUuid(uuid);
      } catch (e) {
        doc = null;
      }

      if (doc?.documentName === 'Actor') {
        const a = doc;
        context.gActorsResolved.push({
          uuid,
          name: a?.name || uuid,
          img: a?.img || 'icons/svg/mystery-man.svg',
          type: a?.type || '',
          typeLabel: this._getActorTypeLabel(a?.type),
        });
      } else {
        context.gActorsResolved.push({
          uuid,
          name: `${uuid} (не найдено)`,
          img: 'icons/svg/mystery-man.svg',
          type: '',
          typeLabel: '—',
        });
      }
    }

    // Цвет фракции для подсветки интерфейса
    context.factionColor = this._getFactionColorCss(context.system);

    // Привязка данных актёра (actorLink)
    // - если лист открыт через токен: показываем состояние TokenDocument.actorLink, но НЕ даём менять
    // - если лист открыт как обычный актёр: меняем prototypeToken.actorLink
    const tokenDoc = this._getTokenDocumentFromContext?.() ?? null;
    const idStr = String(this.id ?? '');
    const isTokenContext = Boolean(tokenDoc) || idStr.includes('-Token-');

    const protoToken = this.document?.prototypeToken ?? this.actor?.prototypeToken ?? null;
    context.tokenActorLink = Boolean((tokenDoc?.actorLink) ?? protoToken?.actorLink);
    context.canToggleActorLink = Boolean(this.isEditable) && !isTokenContext;

    // Token: quick controls (name + sight)
    const sightSource = tokenDoc?.sight ?? protoToken?.sight ?? {};
    const sightRange = Number(sightSource?.range ?? 0);
    const sightEnabled = (sightSource?.enabled !== undefined && sightSource?.enabled !== null)
      ? Boolean(sightSource.enabled)
      : (Number.isFinite(sightRange) ? sightRange > 0 : false);

    context.tokenSightEnabled = Boolean(sightEnabled);
    context.tokenSightRange = Number.isFinite(sightRange) ? sightRange : 0;

    // Actor-context: how many linked tokens on the active scene would be synced
    let linkedTokensOnCanvasCount = 0;
    if (!isTokenContext) {
      try {
        const scene = canvas?.scene;
        const tokens = (scene?.tokens?.contents || Array.from(scene?.tokens || []));
        linkedTokensOnCanvasCount = tokens.filter((td) => {
          if (!td?.actorLink) return false;
          const a = td?.actor;
          return (a?.id && a.id === this.actor.id) || (td?.actorId && td.actorId === this.actor.id);
        }).length;
      } catch (e) {
        linkedTokensOnCanvasCount = 0;
      }
    }

    context.linkedTokensOnCanvasCount = linkedTokensOnCanvasCount;
    context.canEditTokenControls = Boolean(this.isEditable) && (!isTokenContext || Boolean(tokenDoc));
    context.tokenTargetHint = isTokenContext
      ? 'Меняет токен на сцене'
      : (linkedTokensOnCanvasCount > 0
        ? `Меняет prototypeToken и linked-токены на активной сцене (${linkedTokensOnCanvasCount})`
        : 'Меняет prototypeToken');

    return context;
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);

    const el = this.element;
    if (!el) return;

    // Контейнер актёров: открыть (доступно и в read-only)
    el.querySelectorAll('[data-action="gactor-open"]').forEach((btn) => {
      btn.addEventListener('click', this._onGActorOpen.bind(this));
    });

    // Всё ниже — только когда лист редактируемый
    if (!this.isEditable) return;

    // Token: quick controls
    el.querySelectorAll('[data-action="token-set-name"]').forEach((btn) => {
      btn.addEventListener('click', this._onTokenSetName.bind(this));
    });
    el.querySelectorAll('[data-action="token-sight-enabled"]').forEach((input) => {
      input.addEventListener('change', this._onTokenSightEnabledChange.bind(this));
    });
    el.querySelectorAll('[data-action="token-sight-range"]').forEach((input) => {
      input.addEventListener('change', this._onTokenSightRangeChange.bind(this));
    });

    // Контейнер актёров: drag&drop + достать + убрать
    el.querySelectorAll('[data-action="gactors-drop"]').forEach((panel) => {
      panel.addEventListener('dragover', (ev) => ev.preventDefault());
      panel.addEventListener('drop', this._onGActorsDrop.bind(this));
    });
    el.querySelectorAll('[data-action="gactor-take"]').forEach((btn) => {
      btn.addEventListener('click', this._onGActorTakeOut.bind(this));
    });
    el.querySelectorAll('[data-action="gactor-remove"]').forEach((btn) => {
      btn.addEventListener('click', this._onGActorRemove.bind(this));
    });

    // Drag & drop UUID в текстовые поля
    el.querySelectorAll('[data-action="uuid-drop"]').forEach((input) => {
      input.addEventListener('dragover', (ev) => ev.preventDefault());
      input.addEventListener('drop', this._onUuidDrop.bind(this));
    });

    // Открытие Journal по UUID
    el.querySelectorAll('[data-action="uuid-open"]').forEach((a) => {
      a.addEventListener('click', this._onUuidOpen.bind(this));
    });

    // Привязка данных актёра (actorLink)
    el.querySelectorAll('[data-action="token-actorlink-toggle"]').forEach((btn) => {
      btn.addEventListener('click', this._onTokenActorLinkToggle.bind(this));
    });

    // Очистка UUID поля
    el.querySelectorAll('[data-action="uuid-clear"]').forEach((btn) => {
      btn.addEventListener('click', this._onUuidClear.bind(this));
    });
  }

  /**
   * Token: получить linked TokenDocuments этого актора на активной сцене.
   * Синхронизируем ТОЛЬКО linked-токены (actorLink === true), unlinked не трогаем.
   * @private
   */
  _getLinkedTokenDocsOnActiveScene() {
    const scene = canvas?.scene;
    if (!scene) return [];

    const tokens = (scene.tokens?.contents || Array.from(scene.tokens || []));
    return tokens.filter((td) => {
      if (!td?.actorLink) return false;
      const a = td?.actor;
      return (a?.id && a.id === this.actor.id) || (td?.actorId && td.actorId === this.actor.id);
    });
  }

  /** @private */
  async _syncLinkedTokensOnActiveScene(updateData) {
    const scene = canvas?.scene;
    if (!scene) return;

    const tokens = this._getLinkedTokenDocsOnActiveScene();
    if (!tokens.length) return;

    const updates = tokens.map((td) => ({ _id: td.id, ...updateData }));
    try {
      await scene.updateEmbeddedDocuments('Token', updates);
    } catch (e) {
      console.error('SpaceHolder | GlobalObject: failed to sync linked tokens', e);
      ui.notifications.warn('Не удалось синхронизировать linked-токены на активной сцене');
    }
  }

  /**
   * Token: задать имя токену = текущему имени актора.
   * - token-context: меняем TokenDocument.
   * - actor-context: меняем prototypeToken + синхронизируем linked-токены на активной сцене.
   * @private
   */
  async _onTokenSetName(event) {
    event.preventDefault();
    event.stopPropagation();

    const actorName = String(this.actor?.name ?? '').trim();
    if (!actorName) return;

    const tokenDoc = this._getTokenDocumentFromContext?.() ?? null;
    const idStr = String(this.id ?? '');
    const isTokenContext = Boolean(tokenDoc) || idStr.includes('-Token-');

    if (isTokenContext) {
      if (!tokenDoc) {
        ui.notifications.warn('Не удалось определить токен из контекста листа');
        return;
      }
      try {
        await tokenDoc.update({ name: actorName });
      } catch (e) {
        console.error('SpaceHolder | GlobalObject: failed to update token name', e);
        ui.notifications.error('Не удалось обновить имя токена');
      }
      return;
    }

    // actor-context
    try {
      await this.actor.update({ 'prototypeToken.name': actorName });
    } catch (e) {
      console.error('SpaceHolder | GlobalObject: failed to update prototype token name', e);
      ui.notifications.error('Не удалось обновить prototype token');
      return;
    }

    await this._syncLinkedTokensOnActiveScene({ name: actorName });
  }

  /** @private */
  async _onTokenSightEnabledChange(event) {
    event.preventDefault();
    event.stopPropagation();

    const enabled = Boolean(event.currentTarget?.checked);

    const tokenDoc = this._getTokenDocumentFromContext?.() ?? null;
    const idStr = String(this.id ?? '');
    const isTokenContext = Boolean(tokenDoc) || idStr.includes('-Token-');

    if (isTokenContext) {
      if (!tokenDoc) {
        ui.notifications.warn('Не удалось определить токен из контекста листа');
        return;
      }
      try {
        await tokenDoc.update({ 'sight.enabled': enabled });
      } catch (e) {
        console.error('SpaceHolder | GlobalObject: failed to update token sight.enabled', e);
        ui.notifications.error('Не удалось обновить зрение токена');
      }
      return;
    }

    // actor-context
    try {
      await this.actor.update({ 'prototypeToken.sight.enabled': enabled });
    } catch (e) {
      console.error('SpaceHolder | GlobalObject: failed to update prototype sight.enabled', e);
      ui.notifications.error('Не удалось обновить prototype token');
      return;
    }

    await this._syncLinkedTokensOnActiveScene({ 'sight.enabled': enabled });
  }

  /** @private */
  async _onTokenSightRangeChange(event) {
    event.preventDefault();
    event.stopPropagation();

    const raw = String(event.currentTarget?.value ?? '').trim();
    const parsed = Number.parseFloat(raw.replace(',', '.'));
    const range = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;

    const tokenDoc = this._getTokenDocumentFromContext?.() ?? null;
    const idStr = String(this.id ?? '');
    const isTokenContext = Boolean(tokenDoc) || idStr.includes('-Token-');

    if (isTokenContext) {
      if (!tokenDoc) {
        ui.notifications.warn('Не удалось определить токен из контекста листа');
        return;
      }
      try {
        await tokenDoc.update({ 'sight.range': range });
      } catch (e) {
        console.error('SpaceHolder | GlobalObject: failed to update token sight.range', e);
        ui.notifications.error('Не удалось обновить зрение токена');
      }
      return;
    }

    // actor-context
    try {
      await this.actor.update({ 'prototypeToken.sight.range': range });
    } catch (e) {
      console.error('SpaceHolder | GlobalObject: failed to update prototype sight.range', e);
      ui.notifications.error('Не удалось обновить prototype token');
      return;
    }

    await this._syncLinkedTokensOnActiveScene({ 'sight.range': range });
  }

  /**
   * Нормализовать ввод UUID: поддержка @UUID[...]
   * @private
   */
  _normalizeUuid(raw) {
    const str = String(raw ?? '').trim();
    if (!str) return '';
    const match = str.match(/@UUID\[(.+?)\]/);
    return (match?.[1] ?? str).trim();
  }

  /**
   * Получить имя журнала для отображения (если UUID валиден)
   * @private
   */
  async _resolveJournalName(rawUuid) {
    const uuid = this._normalizeUuid(rawUuid);
    if (!uuid) return '';

    let doc = null;
    try {
      doc = await fromUuid(uuid);
    } catch (e) {
      doc = null;
    }

    return doc?.name || uuid;
  }

  /**
   * Получить CSS-цвет для подсветки (из InfluenceManager, либо детерминированный fallback)
   * @private
   */
  _getFactionColorCss(system) {
    const key = String(system?.gFaction ?? '').trim();
    if (!key) return '';

    const im = game?.spaceholder?.influenceManager;
    const n = im?.getColorForSide?.(key);
    if (typeof n === 'number') return `#${n.toString(16).padStart(6, '0')}`;

    // Fallback: hash -> hue -> hex
    const hue = this._hashStringToHue(key);
    const hex = this._hslToHex(hue, 65, 50);
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

    let r = 0, g = 0, b = 0;
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

  /** @private */
  _getActorTypeLabel(type) {
    const t = String(type ?? '').trim();
    switch (t) {
      case 'character': return 'Персонаж';
      case 'npc': return 'NPC';
      case 'globalobject': return 'Глоб. объект';
      case 'faction': return 'Фракция';
      default: return t || '—';
    }
  }

  /**
   * Контейнер актёров: drop Actor UUID в system.gActors
   * @private
   */
  async _onGActorsDrop(event) {
    event.preventDefault();

    const uuid = this._extractUuidFromDropEvent(event);
    if (!uuid) {
      ui.notifications.warn('Не удалось извлечь UUID из перетаскивания');
      return;
    }

    let doc = null;
    try {
      doc = await fromUuid(uuid);
    } catch (e) {
      doc = null;
    }

    if (!doc || doc.documentName !== 'Actor') {
      ui.notifications.warn('Ожидался Actor');
      return;
    }

    const actorUuid = doc.uuid ?? uuid;

    const current = Array.isArray(this.actor.system?.gActors)
      ? foundry.utils.deepClone(this.actor.system.gActors)
      : [];

    if (current.includes(actorUuid)) return;

    current.push(actorUuid);
    await this.actor.update({ 'system.gActors': current });
    this.render(false);
  }

  /**
   * Контейнер актёров: открыть добавленного актора
   * @private
   */
  async _onGActorOpen(event) {
    event.preventDefault();
    event.stopPropagation();

    const uuid = this._normalizeUuid(event.currentTarget?.dataset?.uuid);
    if (!uuid) return;

    let doc = null;
    try {
      doc = await fromUuid(uuid);
    } catch (e) {
      doc = null;
    }

    if (!doc) {
      ui.notifications.warn('Документ по UUID не найден');
      return;
    }

    if (doc.documentName !== 'Actor') {
      ui.notifications.warn('Ожидался Actor');
      return;
    }

    doc.sheet?.render?.(true);
  }

  /**
   * Контейнер актёров: достать актёра на сцену и удалить из system.gActors
   * @private
   */
  async _onGActorTakeOut(event) {
    event.preventDefault();
    event.stopPropagation();

    const uuid = this._normalizeUuid(event.currentTarget?.dataset?.uuid);
    if (!uuid) return;

    // 1) Резолвим актёра
    let doc = null;
    try {
      doc = await fromUuid(uuid);
    } catch (e) {
      doc = null;
    }

    if (!doc) {
      ui.notifications.warn('Документ по UUID не найден');
      return;
    }

    if (doc.documentName !== 'Actor') {
      ui.notifications.warn('Ожидался Actor');
      return;
    }

    const actorToSpawn = doc;

    // 2) Сцена + якорный токен Global Object (чтобы понять, куда ставить)
    const scene = canvas?.scene;
    if (!scene) {
      ui.notifications.warn('Нет активной сцены');
      return;
    }

    let anchorTokenDoc = this._getTokenDocumentFromContext?.() ?? null;
    if (anchorTokenDoc?.parent?.id !== scene.id) anchorTokenDoc = null;

    // Если лист открыт НЕ от токена — попробуем найти токен этого Global Object на активной сцене.
    if (!anchorTokenDoc) {
      const candidates = (scene.tokens?.contents || Array.from(scene.tokens || [])).filter((td) => {
        const a = td?.actor;
        return (a?.id && a.id === this.actor.id) || (td?.actorId && td.actorId === this.actor.id);
      });

      if (candidates.length === 1) {
        anchorTokenDoc = candidates[0];
      } else if (candidates.length > 1) {
        ui.notifications.warn('На сцене несколько токенов этого Global Object — открой лист от нужного токена');
        return;
      }
    }

    if (!anchorTokenDoc) {
      ui.notifications.warn('Не найден токен Global Object на активной сцене');
      return;
    }

    // 3) Координаты спавна: рядом с токеном Global Object
    const gridSize = Number(canvas?.grid?.size ?? 100) || 100;
    const anchorX = Number(anchorTokenDoc.x ?? 0) || 0;
    const anchorY = Number(anchorTokenDoc.y ?? 0) || 0;
    const anchorW = Math.max(1, Number(anchorTokenDoc.width ?? 1) || 1);

    let x = anchorX + (anchorW * gridSize);
    let y = anchorY;

    if (canvas?.grid?.getSnappedPosition) {
      const snapped = canvas.grid.getSnappedPosition(x, y, 1);
      if (snapped && typeof snapped.x === 'number' && typeof snapped.y === 'number') {
        x = snapped.x;
        y = snapped.y;
      }
    }

    // 4) Подготовим данные токена по дефолту актора
    let tokenData = null;
    try {
      if (typeof actorToSpawn.getTokenDocument === 'function') {
        const td = await actorToSpawn.getTokenDocument({ x, y });
        tokenData = td?.toObject?.() ?? td;
      } else if (typeof actorToSpawn.getTokenData === 'function') {
        tokenData = foundry.utils.deepClone(actorToSpawn.getTokenData());
        tokenData.x = x;
        tokenData.y = y;
      } else {
        tokenData = { actorId: actorToSpawn.id, x, y, name: actorToSpawn.name };
      }
    } catch (e) {
      console.error('SpaceHolder | GlobalObject: failed to prepare token data', e);
      ui.notifications.error('Не удалось подготовить токен');
      return;
    }

    // 5) Создаём токен на сцене
    try {
      await scene.createEmbeddedDocuments('Token', [tokenData]);
    } catch (e) {
      console.error('SpaceHolder | GlobalObject: failed to create token', e);
      ui.notifications.error('Не удалось создать токен');
      return;
    }

    // 6) Убираем UUID из контейнера (только если токен успешно создан)
    const current = Array.isArray(this.actor.system?.gActors)
      ? foundry.utils.deepClone(this.actor.system.gActors)
      : [];

    const next = current.filter((u) => this._normalizeUuid(u) !== uuid);
    await this.actor.update({ 'system.gActors': next });
    this.render(false);
  }

  /**
   * Контейнер актёров: убрать UUID из system.gActors
   * @private
   */
  async _onGActorRemove(event) {
    event.preventDefault();

    const uuid = this._normalizeUuid(event.currentTarget?.dataset?.uuid);
    if (!uuid) return;

    const current = Array.isArray(this.actor.system?.gActors)
      ? foundry.utils.deepClone(this.actor.system.gActors)
      : [];

    const next = current.filter((u) => String(u) !== uuid);
    await this.actor.update({ 'system.gActors': next });
    this.render(false);
  }

  /**
   * Привязка данных актёра (actorLink): переключить.
   * Если лист открыт через токен — меняем сам TokenDocument.
   * Иначе меняем prototypeToken актёра.
   * @private
   */
  async _onTokenActorLinkToggle(event) {
    event.preventDefault();
    event.stopPropagation();

    // Важно: по запросу — НЕ даём переключать actorLink, когда лист открыт через токен.
    // Это переключение меняет тип документа (linked <-> synthetic) и может ломать дальнейшие действия
    // в заголовке (например, открытие Token Config).
    const tokenDoc = this._getTokenDocumentFromContext?.() ?? null;
    const idStr = String(this.id ?? '');
    const isTokenContext = Boolean(tokenDoc) || idStr.includes('-Token-');
    if (isTokenContext) return;

    // Это настройки prototype token.
    const current = Boolean(this.actor?.prototypeToken?.actorLink);
    const next = !current;
    await this.actor.update({ 'prototypeToken.actorLink': next });

    this.render(false);
  }

  /**
   * Очистить UUID поле
   * @private
   */
  async _onUuidClear(event) {
    event.preventDefault();

    const field = event.currentTarget?.dataset?.field;
    if (!field) return;

    await this.actor.update({ [field]: '' });
    this.render(false);
  }

  /**
   * Попытаться извлечь UUID из drag&drop данных
   * @private
   */
  _extractUuidFromDropEvent(event) {
    const dt = event?.dataTransfer;
    if (!dt) return '';

    const rawCandidates = [
      dt.getData('application/json'),
      dt.getData('text/plain'),
    ].filter(Boolean);

    for (const raw of rawCandidates) {
      // Обычно Foundry кладёт JSON в text/plain
      try {
        const data = JSON.parse(raw);
        const uuid = data?.uuid || data?.data?.uuid;
        if (uuid) return this._normalizeUuid(uuid);
      } catch (e) {
        // Не JSON — возможно это уже UUID-строка
        const uuid = this._normalizeUuid(raw);
        if (uuid) return uuid;
      }
    }

    return '';
  }

  /**
   * Handle drop: сохранить UUID в указанное поле (data-field="system.xxx")
   * @private
   */
  async _onUuidDrop(event) {
    event.preventDefault();

    const input = event.currentTarget;
    const field = input?.dataset?.field;
    if (!field) return;

    const uuid = this._extractUuidFromDropEvent(event);
    if (!uuid) {
      ui.notifications.warn('Не удалось извлечь UUID из перетаскивания');
      return;
    }

    let doc = null;
    try {
      doc = await fromUuid(uuid);
    } catch (e) {
      doc = null;
    }

    if (!doc) {
      ui.notifications.warn('Документ по UUID не найден');
      return;
    }

    // system.gFaction: ожидаем Actor типа "faction"
    if (field === 'system.gFaction') {
      if (doc.documentName !== 'Actor') {
        ui.notifications.warn('Ожидался Actor (Faction)');
        return;
      }

      if (doc.type !== 'faction') {
        ui.notifications.warn('Ожидался Actor типа "faction"');
        return;
      }

      const uuidToStore = doc.uuid ?? uuid;
      await this.actor.update({ [field]: uuidToStore });
      input.value = uuidToStore;
      this.render(false);
      return;
    }

    // Остальные поля: ожидаем JournalEntry/JournalEntryPage
    const docName = doc.documentName;
    if (!['JournalEntry', 'JournalEntryPage'].includes(docName)) {
      ui.notifications.warn('Ожидался Journal (JournalEntry/JournalEntryPage)');
      return;
    }

    // Для JournalEntryPage стараемся хранить UUID родительского JournalEntry
    let uuidToStore = uuid;
    if (docName === 'JournalEntryPage' && doc.parent?.uuid) {
      uuidToStore = doc.parent.uuid;
    }

    await this.actor.update({ [field]: uuidToStore });
    input.value = uuidToStore;
    this.render(false);
  }

  /**
   * Открыть документ по UUID
   * @private
   */
  async _onUuidOpen(event) {
    event.preventDefault();
    event.stopPropagation();

    const uuid = this._normalizeUuid(event.currentTarget?.dataset?.uuid);
    if (!uuid) return;

    let doc = null;
    try {
      doc = await fromUuid(uuid);
    } catch (e) {
      doc = null;
    }

    if (!doc) {
      ui.notifications.warn('Документ по UUID не найден');
      return;
    }

    // Для JournalEntryPage обычно открываем родительский JournalEntry
    if (doc.documentName === 'JournalEntryPage' && doc.parent?.sheet?.render) {
      doc.parent.sheet.render(true);
      return;
    }

    if (doc.sheet?.render) {
      doc.sheet.render(true);
      return;
    }

    ui.notifications.warn('Не удалось открыть документ: нет sheet');
  }
}

// Faction sheet (Application V2)
export class SpaceHolderFactionSheet extends SpaceHolderBaseActorSheet {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS ?? {}, {
    position: { width: 520, height: 'auto' },
  }, { inplace: false });

  static PARTS = {
    body: { root: true, template: 'systems/spaceholder/templates/actor/actor-faction-sheet.hbs' },
  };

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    // Убедимся, что поля существуют (на случай старых актёров)
    context.system = context.system || {};
    context.system.fLink ??= '';
    context.system.fColor ??= '#666666';

    // Имя для отображения (как content-link)
    context.fLinkName = await this._resolveDocName(context.system.fLink);

    return context;
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);

    const el = this.element;
    if (!el) return;

    // Открытие документа по UUID (доступно и в read-only)
    el.querySelectorAll('[data-action="uuid-open"]').forEach((a) => {
      a.addEventListener('click', this._onUuidOpen.bind(this));
    });

    // Всё ниже — только когда лист редактируемый
    if (!this.isEditable) return;

    // Перетаскивание UUID в текстовые поля
    el.querySelectorAll('[data-action="uuid-drop"]').forEach((input) => {
      input.addEventListener('dragover', (ev) => ev.preventDefault());
      input.addEventListener('drop', this._onUuidDrop.bind(this));
    });

    // Очистка UUID поля
    el.querySelectorAll('[data-action="uuid-clear"]').forEach((btn) => {
      btn.addEventListener('click', this._onUuidClear.bind(this));
    });
  }

  /** @private */
  _normalizeUuid(raw) {
    const str = String(raw ?? '').trim();
    if (!str) return '';
    const match = str.match(/@UUID\[(.+?)\]/);
    return (match?.[1] ?? str).trim();
  }

  /**
   * Попытаться извлечь UUID из drag&drop данных
   * @private
   */
  _extractUuidFromDropEvent(event) {
    const dt = event?.dataTransfer;
    if (!dt) return '';

    const rawCandidates = [
      dt.getData('application/json'),
      dt.getData('text/plain'),
    ].filter(Boolean);

    for (const raw of rawCandidates) {
      try {
        const data = JSON.parse(raw);
        const uuid = data?.uuid || data?.data?.uuid;
        if (uuid) return this._normalizeUuid(uuid);
      } catch (e) {
        const uuid = this._normalizeUuid(raw);
        if (uuid) return uuid;
      }
    }

    return '';
  }

  /** @private */
  async _resolveDocName(rawUuid) {
    const uuid = this._normalizeUuid(rawUuid);
    if (!uuid) return '';

    let doc = null;
    try {
      doc = await fromUuid(uuid);
    } catch (e) {
      doc = null;
    }

    return doc?.name || uuid;
  }

  /**
   * Очистить UUID поле
   * @private
   */
  async _onUuidClear(event) {
    event.preventDefault();

    const field = event.currentTarget?.dataset?.field;
    if (!field) return;

    await this.actor.update({ [field]: '' });
    this.render(false);
  }

  /**
   * Handle drop: сохранить UUID в указанное поле (data-field="system.xxx")
   * @private
   */
  async _onUuidDrop(event) {
    event.preventDefault();

    const input = event.currentTarget;
    const field = input?.dataset?.field;
    if (!field) return;

    const uuid = this._extractUuidFromDropEvent(event);
    if (!uuid) {
      ui.notifications.warn('Не удалось извлечь UUID из перетаскивания');
      return;
    }

    // Валидация: ожидаем JournalEntry/JournalEntryPage
    let doc = null;
    try {
      doc = await fromUuid(uuid);
    } catch (e) {
      doc = null;
    }

    if (!doc) {
      ui.notifications.warn('Документ по UUID не найден');
      return;
    }

    const docName = doc.documentName;
    if (!['JournalEntry', 'JournalEntryPage'].includes(docName)) {
      ui.notifications.warn('Ожидался Journal (JournalEntry/JournalEntryPage)');
      return;
    }

    // Для JournalEntryPage стараемся хранить UUID родительского JournalEntry
    let uuidToStore = uuid;
    if (docName === 'JournalEntryPage' && doc.parent?.uuid) {
      uuidToStore = doc.parent.uuid;
    }

    await this.actor.update({ [field]: uuidToStore });
    input.value = uuidToStore;
    this.render(false);
  }

  /**
   * Открыть документ по UUID
   * @private
   */
  async _onUuidOpen(event) {
    event.preventDefault();
    event.stopPropagation();

    const uuid = this._normalizeUuid(event.currentTarget?.dataset?.uuid);
    if (!uuid) return;

    let doc = null;
    try {
      doc = await fromUuid(uuid);
    } catch (e) {
      doc = null;
    }

    if (!doc) {
      ui.notifications.warn('Документ по UUID не найден');
      return;
    }

    // Для JournalEntryPage обычно открываем родительский JournalEntry
    if (doc.documentName === 'JournalEntryPage' && doc.parent?.sheet?.render) {
      doc.parent.sheet.render(true);
      return;
    }

    if (doc.sheet?.render) {
      doc.sheet.render(true);
      return;
    }

    ui.notifications.warn('Не удалось открыть документ: нет sheet');
  }
}

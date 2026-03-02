import { anatomyManager } from '../anatomy-manager.mjs';

/**
 * Extend the base Actor document by defining a custom roll data structure which is ideal for the Simple system.
 * @extends {Actor}
 */
export class SpaceHolderActor extends Actor {
  /** @override */
  prepareData() {
    // Prepare data for the actor. Calling the super version of this executes
    // the following, in order: data reset (to clear active effects),
    // prepareBaseData(), prepareEmbeddedDocuments() (including active effects),
    // prepareDerivedData().
    super.prepareData();
  }

  /** @override */
  prepareBaseData() {
    // Data modifications in this step occur before processing embedded
    // documents or derived data.
  }

  /**
   * @override
   * Augment the actor source data with additional dynamic data. Typically,
   * you'll want to handle most of your calculated/derived data in this step.
   * Data calculated in this step should generally not exist in template.json
   * (such as ability modifiers rather than ability scores) and should be
   * available both inside and outside of character sheets (such as if an actor
   * is queried and has a roll executed directly from it).
   */
  prepareDerivedData() {
    const actorData = this;
    const systemData = actorData.system;
    const flags = actorData.flags.spaceholder || {};

    // Make separate methods for each Actor type (character, npc, etc.) to keep
    // things organized.
    this._prepareCharacterData(actorData);
    this._prepareNpcData(actorData);
  }

  /**
   * Prepare Character type specific data
   */
  _prepareCharacterData(actorData) {
    if (actorData.type !== 'character') return;

    // Make modifications to data here. For example:
    const systemData = actorData.system;

    // Loop through ability scores, and add their modifiers to our sheet output.
    for (let [key, ability] of Object.entries(systemData.abilities)) {
      // Calculate the modifier using d20 rules.
      ability.mod = Math.floor((ability.value - 10) / 2);
    }

    // Process body parts health system (always based on health)
    this._prepareBodyParts(systemData);
    
  }

  /**
   * Prepare body parts health system
   */
  _prepareBodyParts(systemData) {
    // Основной источник состояния — травмы.
    const bodyParts = systemData.health?.bodyParts || {};
    const injuries = systemData.health?.injuries || [];

    if (!bodyParts || Object.keys(bodyParts).length === 0) {
      return;
    }

    // Предварительно собираем сумму урона по частям (amount хранится в масштабе x100)
    const sumDamageByPart = {};
    for (const inj of injuries) {
      if (!inj?.partId || typeof inj.amount !== 'number') continue;
      sumDamageByPart[inj.partId] = (sumDamageByPart[inj.partId] || 0) + Math.max(0, inj.amount | 0);
    }

    // Обновляем производные поля частей тела (граф связей по links; попадания — в shot-manager)
    for (const [partId, bodyPart] of Object.entries(bodyParts)) {
      bodyPart.linkedPartIds = Array.isArray(bodyPart.links) ? [...bodyPart.links] : [];

      // Вычисляем текущее здоровье из травм: current = maxHp - floor(sum(amount)/100)
      const sumAmt = sumDamageByPart[partId] || 0;
      const dmgUnits = Math.floor(sumAmt / 100); // Масштаб: x100 => целые единицы HP
      const currentHpDerived = Math.max(0, bodyPart.maxHp - dmgUnits);

      // Процент здоровья и статус — производные
      bodyPart.healthPercentage = bodyPart.maxHp > 0 ? Math.floor((currentHpDerived * 100) / bodyPart.maxHp) : 100;
      if (!bodyPart.status || bodyPart.status === 'healthy') {
        bodyPart.status = this._getBodyPartStatus({ healthPercentage: bodyPart.healthPercentage });
      }
    }
  }

  /**
   * Добавить травму
   * amount хранится как целое число в масштабе x100 (например, 125 = 1.25 урона)
   */
  async addInjury({ partId, amount, type = 'unknown', status = 'raw', source = '' } = {}) {
    const bodyParts = this.system.health?.bodyParts || {};
    if (!partId || !bodyParts[partId]) return false;

    // Гарантируем целое и неотрицательное значение
    const amt = Math.max(0, (amount ?? 0) | 0);
    const injury = {
      id: foundry.utils.randomID?.() || randomID?.() || crypto.randomUUID?.() || String(Date.now()),
      partId,
      amount: amt, // x100
      type,
      status,
      source,
      createdAt: Date.now()
    };

    const injuries = Array.isArray(this.system.health?.injuries) ? foundry.utils.deepClone(this.system.health.injuries) : [];
    injuries.push(injury);
    await this.update({ 'system.health.injuries': injuries });
    return true;
  }

  /** Обновить травму по id */
  async updateInjury(injuryId, patch = {}) {
    if (!injuryId) return false;
    const injuries = Array.isArray(this.system.health?.injuries) ? foundry.utils.deepClone(this.system.health.injuries) : [];
    const idx = injuries.findIndex(i => i.id === injuryId);
    if (idx === -1) return false;

    // Масштаб amount сохраняем x100, если передан
    if (patch.hasOwnProperty('amount')) {
      patch.amount = Math.max(0, (patch.amount ?? 0) | 0);
    }

    injuries[idx] = { ...injuries[idx], ...patch };
    await this.update({ 'system.health.injuries': injuries });
    return true;
  }

  /** Удалить травму по id */
  async removeInjury(injuryId) {
    if (!injuryId) return false;
    const injuries = Array.isArray(this.system.health?.injuries) ? this.system.health.injuries : [];
    const filtered = injuries.filter(i => i.id !== injuryId);
    if (filtered.length === injuries.length) return false;
    await this.update({ 'system.health.injuries': filtered });
    return true;
  }

  /** Получить травмы по части тела */
  getInjuriesByPart(partId) {
    const injuries = Array.isArray(this.system.health?.injuries) ? this.system.health.injuries : [];
    return injuries.filter(i => i.partId === partId);
  }

  /** Текущее здоровье части тела (derived, без сохранения) */
  getCurrentHpForPart(partId) {
    const bodyPart = this.system.health?.bodyParts?.[partId];
    if (!bodyPart) return 0;
    const injuries = this.getInjuriesByPart(partId);
    const sumAmt = injuries.reduce((acc, i) => acc + (i.amount|0), 0);
    const dmgUnits = Math.floor(sumAmt / 100);
    return Math.max(0, bodyPart.maxHp - dmgUnits);
  }

  /** Заглушка форматирования травмы для UI */
  formatInjuryForDisplay(injury) {
    return injury; // позже заменим на человекочитаемое описание
  }

  /**
   * Get status description for body part
   */
  _getBodyPartStatus(bodyPart) {
    const percentage = bodyPart.healthPercentage;
    
    if (percentage === 0) return "destroyed";
    if (percentage < 25) return "badly_injured";
    if (percentage < 50) return "injured";
    if (percentage < 75) return "bruised";
    return "healthy";
  }





  /**
   * Stub: resolve hit location. Actual hit resolution will be implemented in shot-manager.
   * @param {string} targetPartId - ID of the target body part
   * @param {number} [_roll] - Unused; for future use
   * @returns {string} targetPartId
   */
  chanceHit(targetPartId, _roll = null) {
    const bodyParts = this.system.health?.bodyParts;
    if (!bodyParts || !bodyParts[targetPartId]) return targetPartId;
    return targetPartId;
  }

  /**
   * Stub: return first body part ID for legacy callers. Hit resolution will be in shot-manager.
   * @returns {string|null} First body part ID or null
   */
  getRootBodyPart() {
    const bodyParts = this.system.health?.bodyParts;
    if (!bodyParts || !Object.keys(bodyParts).length) return null;
    const sorted = Object.entries(bodyParts).sort((a, b) => (b[1].weight ?? 0) - (a[1].weight ?? 0));
    return sorted[0][0];
  }

  /**
   * Perform a hit against this actor (applies damage to given or first part).
   * @param {number} damage - Amount of damage to deal
   * @param {string|null} targetPart - Optional specific target part (defaults to first by weight)
   * @returns {Object|null} Hit result with final target and damage dealt
   */
  async performHit(damage, targetPart = null) {
    const partId = targetPart || this.getRootBodyPart();
    if (!partId) {
      console.warn("No valid body parts found for hit");
      return null;
    }
    const success = await this.applyBodyPartDamage(partId, damage);
    const bodyParts = this.system.health?.bodyParts;
    return {
      targetPart: partId,
      damage,
      success,
      bodyPart: bodyParts?.[partId]
    };
  }

  /**
   * Apply damage to a specific body part
   * @param {string} partId - Body part ID
   * @param {number} damage - Damage amount
   * @param {string} damageType - Type of damage (for different pain/bleeding calculations)
   * @returns {boolean} Success
   */
  async applyBodyPartDamage(partId, damage, damageType = 'blunt') {
    const bodyParts = this.system.health?.bodyParts;
    const bodyPart = bodyParts?.[partId];
    if (!bodyPart) return false;

    // Конвертируем урон в масштаб x100 для избежания ошибок float.
    // Пример: damage=1.25 => amount=125
    const amount = Math.max(0, Math.floor((damage ?? 0) * 100));

    await this.addInjury({
      partId,
      amount,
      type: damageType || 'blunt',
      status: 'raw',
      source: 'direct'
    });

    return true;
  }

  /**
   * Change anatomy type for this actor
   * @param {string} newAnatomyType - New anatomy type ID
   * @returns {boolean} Success
   */
  async changeAnatomyType(newAnatomyType) {
    // Для обратной совместимости: перенаправляем на setAnatomy
    return this.setAnatomy(newAnatomyType);
  }

  /**
   * Установить анатомию актёру (основной API)
   * @param {string} anatomyId 
   */
  async setAnatomy(anatomyId) {
    try {
      const anatomy = await anatomyManager.createActorAnatomy(anatomyId);
      const displayName = anatomyManager.getAnatomyDisplayName(anatomyId);
      
      // Удаляем существующие части точечно (без слияния)
      const currentParts = this.system.health?.bodyParts || {};
      const delUpdate = {};
      for (const id of Object.keys(currentParts)) {
        delUpdate[`system.health.bodyParts.-=${id}`] = null;
      }
      if (Object.keys(delUpdate).length) {
        await this.update(delUpdate);
      }
      
      // Устанавливаем сведения об анатомии, сетку (если есть в шаблоне) и новые части
      const update = {
        'system.anatomy.id': anatomyId,
        'system.anatomy.name': displayName,
        'system.anatomy.type': anatomyId,
        'system.health.bodyParts': anatomy.bodyParts
      };
      if (anatomy.grid && typeof anatomy.grid.width === 'number' && typeof anatomy.grid.height === 'number') {
        update['system.health.anatomyGrid'] = { width: anatomy.grid.width, height: anatomy.grid.height };
      }
      await this.update(update);
      
      // Пересчёт данных
      await this.prepareData();
      
      console.log(`Set anatomy '${anatomyId}' for actor ${this.name}`);
      return true;
    } catch (error) {
      console.error(`Failed to set anatomy for actor ${this.name}:`, error);
      return false;
    }
  }

  /**
   * Полный сброс анатомии (очистка всех частей тела и здоровья)
   * @param {boolean} clearType - также очистить system.anatomy.type
   * @returns {Promise<boolean>}
   */
  async resetAnatomy(clearType = true) {
    try {
      // Точечное удаление всех текущих частей
      const currentParts = this.system.health?.bodyParts || {};
      const delUpdate = {};
      for (const id of Object.keys(currentParts)) {
        delUpdate[`system.health.bodyParts.-=${id}`] = null;
      }
      if (clearType) {
        delUpdate['system.anatomy.id'] = null;
        delUpdate['system.anatomy.name'] = null;
        delUpdate['system.anatomy.type'] = null;
      }
      await this.update(delUpdate);

      await this.prepareData();
      console.log(`Anatomy reset for actor ${this.name}${clearType ? ' (type cleared)' : ''}`);
      return true;
    } catch (error) {
      console.error(`Failed to reset anatomy for actor ${this.name}:`, error);
      return false;
    }
  }

  /**
   * Alias для совместимости
   */
  async clearAnatomy(clearType = true) {
    return this.resetAnatomy(clearType);
  }

  /**
   * Prepare NPC type specific data.
   */
  _prepareNpcData(actorData) {
    if (actorData.type !== 'npc') return;

    // Make modifications to data here. For example:
    const systemData = actorData.system;
    systemData.xp = systemData.cr * systemData.cr * 100;
  }

  /**
   * Override getRollData() that's supplied to rolls.
   */
  getRollData() {
    // Starts off by populating the roll data with a shallow copy of `this.system`
    const data = { ...this.system };

    // Prepare character roll data.
    this._getCharacterRollData(data);
    this._getNpcRollData(data);

    return data;
  }

  /**
   * Prepare character roll data.
   */
  _getCharacterRollData(data) {
    if (this.type !== 'character') return;

    // Copy the ability scores to the top level, so that rolls can use
    // formulas like `@str.mod + 4`.
    if (data.abilities) {
      for (let [k, v] of Object.entries(data.abilities)) {
        data[k] = foundry.utils.deepClone(v);
      }
    }

    // Add level for easier access, or fall back to 0.
    if (data.attributes.level) {
      data.lvl = data.attributes.level.value ?? 0;
    }
  }

  /**
   * Prepare NPC roll data.
   */
  _getNpcRollData(data) {
    if (this.type !== 'npc') return;

    // Process additional NPC data here.
  }
}
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
  async prepareDerivedData() {
    const actorData = this;
    const systemData = actorData.system;
    const flags = actorData.flags.spaceholder || {};

    // Make separate methods for each Actor type (character, npc, etc.) to keep
    // things organized.
    await this._prepareCharacterData(actorData);
    this._prepareNpcData(actorData);
  }

  /**
   * Prepare Character type specific data
   */
  async _prepareCharacterData(actorData) {
    if (actorData.type !== 'character') return;

    // Make modifications to data here. For example:
    const systemData = actorData.system;

    // Loop through ability scores, and add their modifiers to our sheet output.
    for (let [key, ability] of Object.entries(systemData.abilities)) {
      // Calculate the modifier using d20 rules.
      ability.mod = Math.floor((ability.value - 10) / 2);
    }

    // Process body parts health system
    if (systemData.anatomy) {
      await this._prepareBodyParts(systemData);
    }
  }

  /**
   * Prepare body parts health system
   */
  async _prepareBodyParts(systemData) {
    // Check if anatomy type is set
    const anatomyType = systemData.anatomy?.type;
    
    // If no anatomy type is set, skip body parts processing
    if (!anatomyType) {
      systemData.health.totalHealth = {
        current: 0,
        max: 0,
        percentage: 100
      };
      return;
    }
    
    // Проверяем, нужно ли загрузить новую анатомию
    const needsNewAnatomy = !systemData.anatomy.bodyParts || 
                          Object.keys(systemData.anatomy.bodyParts).length === 0 ||
                          await this._doesAnatomyMismatch(systemData.anatomy.bodyParts, anatomyType);
    
    if (needsNewAnatomy) {
      try {
        console.log(`Loading new anatomy '${anatomyType}' for actor ${this.name} (${Object.keys(systemData.anatomy.bodyParts || {}).length} -> expected 15)`);
        const anatomy = await anatomyManager.createActorAnatomy(anatomyType);
        // Просто заменяем данные в systemData, не вызывая update
        systemData.anatomy.bodyParts = anatomy.bodyParts;
        systemData.health.bodyParts = anatomy.bodyParts;
        console.log(`Anatomy loaded: ${Object.keys(anatomy.bodyParts).length} parts`);
      } catch (error) {
        console.error(`Failed to load anatomy '${anatomyType}' for actor ${this.name}:`, error);
        return;
      }
    }
    
    const bodyParts = systemData.anatomy.bodyParts;
    
    // Build hierarchy - find children for each body part
    for (let [partId, bodyPart] of Object.entries(bodyParts)) {
      bodyPart.children = this._getChildrenParts(partId, bodyParts);
      bodyPart.healthPercentage = Math.floor((bodyPart.currentHp / bodyPart.maxHp) * 100);
      // Update status based on current health if not manually set
      if (!bodyPart.status || bodyPart.status === 'healthy') {
        bodyPart.status = this._getBodyPartStatus(bodyPart);
      }
    }
    
    // Calculate total health
    let totalCurrentHp = 0;
    let totalMaxHp = 0;
    
    for (let bodyPart of Object.values(bodyParts)) {
      totalCurrentHp += bodyPart.currentHp;
      totalMaxHp += bodyPart.maxHp;
    }
    
    systemData.health.totalHealth = {
      current: totalCurrentHp,
      max: totalMaxHp,
      percentage: Math.floor((totalCurrentHp / totalMaxHp) * 100)
    };
    
    // Copy bodyParts reference to health for backward compatibility
    systemData.health.bodyParts = bodyParts;
  }

  /**
   * Проверяет, не соответствуют ли части тела требуемому типу анатомии
   * @param {Object} bodyParts - Текущие части тела
   * @param {string} anatomyType - Требуемый тип анатомии
   * @returns {boolean} true, если анатомия не соответствует
   */
  async _doesAnatomyMismatch(bodyParts, anatomyType) {
    try {
      // Получаем эталонную анатомию
      const referenceAnatomy = await anatomyManager.createActorAnatomy(anatomyType);
      const referencePartIds = new Set(Object.keys(referenceAnatomy.bodyParts));
      const currentPartIds = new Set(Object.keys(bodyParts));
      
      // Если количество частей разное, то явное несоответствие
      if (referencePartIds.size !== currentPartIds.size) {
        console.log(`Anatomy mismatch: expected ${referencePartIds.size} parts, got ${currentPartIds.size}`);
        return true;
      }
      
      // Проверяем, что все ID эталонных частей присутствуют
      for (const partId of referencePartIds) {
        if (!currentPartIds.has(partId)) {
          console.log(`Anatomy mismatch: missing part '${partId}'`);
          return true;
        }
      }
      
      return false;
    } catch (error) {
      console.error('Error checking anatomy mismatch:', error);
      // В случае ошибки считаем, что нужна перезагрузка
      return true;
    }
  }
  
  /**
   * Get all children parts for a given parent part
   */
  _getChildrenParts(parentId, bodyParts) {
    const children = [];
    for (let [partId, bodyPart] of Object.entries(bodyParts)) {
      if (bodyPart.parent === parentId) {
        children.push({
          id: partId,
          coverage: bodyPart.coverage,
          name: bodyPart.name
        });
      }
    }
    // Sort by coverage descending for better hit distribution
    return children.sort((a, b) => b.coverage - a.coverage);
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
   * Recursive function to determine hit location
   * @param {string} targetPartId - ID of the current target body part
   * @param {number} roll - Random number from 0 to 9999 (for deterministic results)
   * @returns {string} Final hit location ID
   */
  chanceHit(targetPartId, roll = null) {
    const bodyParts = this.system.anatomy?.bodyParts || this.system.health?.bodyParts;
    if (!bodyParts || !bodyParts[targetPartId]) return targetPartId;

    const targetPart = bodyParts[targetPartId];
    const children = targetPart.children || [];
    
    // If no children, we hit this part
    if (children.length === 0) {
      return targetPartId;
    }

    // Generate roll if not provided
    if (roll === null) {
      roll = Math.floor(Math.random() * 10000);
    }

    // Calculate cumulative coverage for children
    let cumulativeCoverage = 0;
    for (let child of children) {
      cumulativeCoverage += child.coverage;
      
      // If roll falls within this child's coverage, recurse into it
      if (roll < cumulativeCoverage) {
        // Generate new roll for the child (scaled to 0-9999 range)
        const childRoll = Math.floor(Math.random() * 10000);
        return this.chanceHit(child.id, childRoll);
      }
    }

    // If roll doesn't hit any child, we hit the parent part
    return targetPartId;
  }

  /**
   * Get the root body part (usually torso)
   * @returns {string} Root body part ID
   */
  getRootBodyPart() {
    const bodyParts = this.system.anatomy?.bodyParts || this.system.health?.bodyParts;
    if (!bodyParts) return null;

    // Find part with no parent
    for (let [partId, bodyPart] of Object.entries(bodyParts)) {
      if (!bodyPart.parent) {
        return partId;
      }
    }
    return null;
  }

  /**
   * Perform a hit against this actor
   * @param {number} damage - Amount of damage to deal
   * @param {string} targetPart - Optional specific target part (defaults to root)
   * @returns {Object} Hit result with final target and damage dealt
   */
  async performHit(damage, targetPart = null) {
    // Get root part if no specific target
    if (!targetPart) {
      targetPart = this.getRootBodyPart();
    }
    
    if (!targetPart) {
      console.warn("No valid body parts found for hit");
      return null;
    }

    // Determine final hit location
    const finalTarget = this.chanceHit(targetPart);
    
    // Apply damage
    const result = await this.applyBodyPartDamage(finalTarget, damage);
    
    const bodyParts = this.system.anatomy?.bodyParts || this.system.health?.bodyParts;
    return {
      targetPart: finalTarget,
      damage: damage,
      success: result,
      bodyPart: bodyParts[finalTarget]
    };
  }

  /**
   * Apply damage to a specific body part
   * @param {string} partId - Body part ID
   * @param {number} damage - Damage amount
   * @returns {boolean} Success
   */
  async applyBodyPartDamage(partId, damage) {
    const bodyParts = this.system.anatomy?.bodyParts || this.system.health?.bodyParts;
    const bodyPart = bodyParts?.[partId];
    if (!bodyPart) return false;

    const newHp = Math.max(0, bodyPart.currentHp - damage);
    
    // Определяем пути обновления
    const updatePaths = {};
    
    // Обновляем HP части тела
    if (this.system.anatomy?.bodyParts) {
      updatePaths[`system.anatomy.bodyParts.${partId}.currentHp`] = newHp;
      updatePaths[`system.health.bodyParts.${partId}.currentHp`] = newHp;
    } else {
      updatePaths[`system.health.bodyParts.${partId}.currentHp`] = newHp;
    }
    
    // Пересчитываем общее здоровье
    let totalCurrentHp = 0;
    let totalMaxHp = 0;
    
    for (let [id, part] of Object.entries(bodyParts)) {
      const currentHp = id === partId ? newHp : part.currentHp;
      totalCurrentHp += currentHp;
      totalMaxHp += part.maxHp;
    }
    
    updatePaths['system.health.totalHealth'] = {
      current: totalCurrentHp,
      max: totalMaxHp,
      percentage: totalMaxHp > 0 ? Math.floor((totalCurrentHp / totalMaxHp) * 100) : 100
    };
    
    await this.update(updatePaths);
    
    // Принудительная перерисовка листа персонажа
    if (this.sheet?.rendered) {
      this.sheet.render(false); // false = не принудительно, только обновить данные
    }
    
    return true;
  }

  /**
   * Change anatomy type for this actor
   * @param {string} newAnatomyType - New anatomy type ID
   * @returns {boolean} Success
   */
  async changeAnatomyType(newAnatomyType) {
    try {
      const anatomy = await anatomyManager.createActorAnatomy(newAnatomyType);
      
      // Подсчитываем общее здоровье новой анатомии
      let totalCurrentHp = 0;
      let totalMaxHp = 0;
      
      for (let bodyPart of Object.values(anatomy.bodyParts)) {
        totalCurrentHp += bodyPart.currentHp;
        totalMaxHp += bodyPart.maxHp;
      }
      
      const totalHealth = {
        current: totalCurrentHp,
        max: totalMaxHp,
        percentage: totalMaxHp > 0 ? Math.floor((totalCurrentHp / totalMaxHp) * 100) : 100
      };
      
      // Полная очистка всех данных анатомии и здоровья
      await this.update({
        'system.anatomy.type': newAnatomyType,
        'system.anatomy.bodyParts': anatomy.bodyParts,
        'system.health.bodyParts': anatomy.bodyParts,
        'system.health.totalHealth': totalHealth,
        // Принудительно очищаем возможные остатки в _source
        '_source.system.anatomy.bodyParts': anatomy.bodyParts,
        '_source.system.health.bodyParts': anatomy.bodyParts
      });
      
      // Принудительно запускаем пересчет данных
      await this.prepareData();
      
      console.log(`Changed anatomy type to '${newAnatomyType}' for actor ${this.name}`);
      console.log(`Total health: ${totalHealth.current}/${totalHealth.max} (${totalHealth.percentage}%)`);
      return true;
    } catch (error) {
      console.error(`Failed to change anatomy type for actor ${this.name}:`, error);
      return false;
    }
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
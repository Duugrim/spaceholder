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
    
    // Calculate physical capacities based on body part damage and pain
    this._preparePhysicalCapacities(systemData);
  }

  /**
   * Prepare body parts health system
   */
  _prepareBodyParts(systemData) {
    // health.bodyParts — единственный источник
    const bodyParts = systemData.health?.bodyParts || {};

    // Если контейнер пуст — выставляем totalHealth по умолчанию и выходим
    if (!bodyParts || Object.keys(bodyParts).length === 0) {
      systemData.health.totalHealth = {
        current: 0,
        max: 0,
        percentage: 100
      };
      return;
    }

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
      percentage: totalMaxHp > 0 ? Math.floor((totalCurrentHp / totalMaxHp) * 100) : 100
    };
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
   * Prepare physical capacities based on body part damage and pain
   * Note: Using integers scaled by 100 to avoid floating point precision issues
   * (e.g., 10000 = 100%, 5000 = 50%)
   */
  _preparePhysicalCapacities(systemData) {
    const bodyParts = systemData.health?.bodyParts || {};
    const pain = systemData.health?.pain || { current: 0 };
    const blood = systemData.health?.blood || { current: 100, max: 100 };
    
    // Initialize if not present
    if (!systemData.physicalCapacities) {
      systemData.physicalCapacities = {
        consciousness: { base: 100, current: 100, percentage: 100 },
        sight: { base: 100, current: 100, percentage: 100 },
        hearing: { base: 100, current: 100, percentage: 100 },
        manipulation: { base: 100, current: 100, percentage: 100 },
        movement: { base: 100, current: 100, percentage: 100 },
        breathing: { base: 100, current: 100, percentage: 100 },
        bloodPumping: { base: 100, current: 100, percentage: 100 },
        bloodFiltration: { base: 100, current: 100, percentage: 100 },
        metabolism: { base: 100, current: 100, percentage: 100 },
        talking: { base: 100, current: 100, percentage: 100 }
      };
    }

    // Calculate capacity modifiers (scaled by 10000 for precision)
    const capacityModifiers = this._calculateCapacityModifiers(bodyParts, pain, blood);
    
    // Apply modifiers to each capacity
    for (let [capacityId, capacity] of Object.entries(systemData.physicalCapacities)) {
      const modifier = capacityModifiers[capacityId] || 10000; // 10000 = 100%
      capacity.current = Math.max(0, Math.min(100, Math.floor((capacity.base * modifier) / 10000)));
      capacity.percentage = Math.round(capacity.current);
    }
    
    // Update pain shock status
    systemData.health.pain.shock = pain.current > 80;
  }

  /**
   * Calculate capacity modifiers based on body part damage, pain, and blood loss
   * Returns modifiers scaled by 10000 (10000 = 100%, 5000 = 50%, etc.)
   * This avoids floating point precision issues
   */
  _calculateCapacityModifiers(bodyParts, pain, blood) {
    const modifiers = {
      consciousness: 10000,
      sight: 10000,
      hearing: 10000,
      manipulation: 10000,
      movement: 10000,
      breathing: 10000,
      bloodPumping: 10000,
      bloodFiltration: 10000,
      metabolism: 10000,
      talking: 10000
    };

    // Pain modifiers (affects consciousness primarily)
    // pain.current is 0-100, convert to 0-10000 scale
    const painScaled = pain.current * 100; // 0-10000
    if (painScaled > 1000) { // > 10% pain
      // Pain penalty: 100% pain = 20% capacity (minimum), linear scaling
      const painPenalty = Math.max(2000, 10000 - (painScaled * 8000) / 10000); // 20% minimum
      modifiers.consciousness = Math.floor((modifiers.consciousness * painPenalty) / 10000);
      modifiers.manipulation = Math.floor((modifiers.manipulation * Math.max(3000, painPenalty + 2000)) / 10000);
      modifiers.movement = Math.floor((modifiers.movement * Math.max(3000, painPenalty + 2000)) / 10000);
    }

    // Blood loss modifiers (affects consciousness and physical performance)
    const bloodPercentage = Math.floor((blood.current * 10000) / blood.max); // 0-10000
    if (bloodPercentage < 8000) { // < 80% blood
      const bloodPenalty = Math.max(1000, bloodPercentage); // 10% minimum
      modifiers.consciousness = Math.floor((modifiers.consciousness * bloodPenalty) / 10000);
      modifiers.movement = Math.floor((modifiers.movement * Math.max(2000, bloodPenalty + 3000)) / 10000);
      modifiers.manipulation = Math.floor((modifiers.manipulation * Math.max(4000, bloodPenalty + 4000)) / 10000);
    }

    // Body part specific modifiers
    for (let [partId, part] of Object.entries(bodyParts)) {
      const healthPercentage = Math.floor((part.currentHp * 10000) / part.maxHp); // 0-10000
      const partModifier = Math.max(1000, healthPercentage); // 10% minimum
      
      // Apply modifiers based on body part tags
      if (part.tags && part.tags.includes('brain')) {
        modifiers.consciousness = Math.floor((modifiers.consciousness * partModifier) / 10000);
        modifiers.sight = Math.floor((modifiers.sight * partModifier) / 10000);
        modifiers.hearing = Math.floor((modifiers.hearing * partModifier) / 10000);
        modifiers.talking = Math.floor((modifiers.talking * partModifier) / 10000);
      }
      
      if (part.tags && part.tags.includes('sensory')) {
        if (part.name.toLowerCase().includes('eye')) {
          modifiers.sight = Math.floor((modifiers.sight * partModifier) / 10000);
        }
        if (part.name.toLowerCase().includes('ear')) {
          modifiers.hearing = Math.floor((modifiers.hearing * partModifier) / 10000);
        }
      }
      
      if (part.tags && part.tags.includes('manipulator')) {
        // Manipulators get slightly better minimum (30% vs 10%)
        const manipulatorMod = Math.max(3000, partModifier + 3000);
        modifiers.manipulation = Math.floor((modifiers.manipulation * manipulatorMod) / 10000);
      }
      
      if (part.tags && part.tags.includes('locomotion')) {
        // Locomotion parts get better minimum (20% vs 10%)
        const locomotionMod = Math.max(2000, partModifier + 2000);
        modifiers.movement = Math.floor((modifiers.movement * locomotionMod) / 10000);
      }
      
      if (part.tags && part.tags.includes('vital')) {
        if (part.name.toLowerCase().includes('lung') || part.name.toLowerCase().includes('chest')) {
          modifiers.breathing = Math.floor((modifiers.breathing * partModifier) / 10000);
        }
        if (part.name.toLowerCase().includes('heart')) {
          modifiers.bloodPumping = Math.floor((modifiers.bloodPumping * partModifier) / 10000);
        }
        if (part.name.toLowerCase().includes('kidney') || part.name.toLowerCase().includes('liver')) {
          modifiers.bloodFiltration = Math.floor((modifiers.bloodFiltration * partModifier) / 10000);
          modifiers.metabolism = Math.floor((modifiers.metabolism * partModifier) / 10000);
        }
      }
    }

    return modifiers;
  }

  /**
   * Calculate pain from damage to a body part
   * Uses integer math (scaled by 100) to avoid floating point issues
   * @param {Object} bodyPart - The damaged body part
   * @param {number} damage - Actual damage dealt
   * @param {string} damageType - Type of damage
   * @returns {number} Pain value (0-100)
   */
  _calculatePainFromDamage(bodyPart, damage, damageType) {
    if (damage <= 0) return 0;
    
    // Base pain calculation: damage relative to part's max HP
    // Scale: 1000 = 10 pain points for full HP loss
    let basePain = Math.floor((damage * 1000) / bodyPart.maxHp);
    
    // Damage type modifiers (scaled by 100)
    let damageTypeMultiplier = 100; // 100 = 1.0x
    switch (damageType) {
      case 'cut':
      case 'slash':
        damageTypeMultiplier = 120; // 1.2x pain
        break;
      case 'pierce':
      case 'stab':
        damageTypeMultiplier = 110; // 1.1x pain
        break;
      case 'burn':
        damageTypeMultiplier = 150; // 1.5x pain
        break;
      case 'blunt':
      default:
        damageTypeMultiplier = 100; // 1.0x pain
        break;
    }
    
    // Body part specific modifiers
    let bodyPartMultiplier = 100; // 100 = 1.0x
    if (bodyPart.tags) {
      if (bodyPart.tags.includes('brain')) {
        bodyPartMultiplier = 200; // 2.0x pain for brain damage
      } else if (bodyPart.tags.includes('vital')) {
        bodyPartMultiplier = 130; // 1.3x pain for vital organs
      } else if (bodyPart.tags.includes('extremity')) {
        bodyPartMultiplier = 80; // 0.8x pain for extremities
      }
    }
    
    // Apply all modifiers (using integer math)
    const finalPain = Math.floor((basePain * damageTypeMultiplier * bodyPartMultiplier) / 10000);
    
    return Math.min(100, Math.max(0, finalPain));
  }

  /**
   * Calculate bleeding from damage to a body part
   * @param {Object} bodyPart - The damaged body part
   * @param {number} damage - Actual damage dealt
   * @param {string} damageType - Type of damage
   * @returns {number} Bleeding rate (units per turn or time period)
   */
  _calculateBleedingFromDamage(bodyPart, damage, damageType) {
    if (damage <= 0) return 0;
    
    // Only some damage types cause bleeding
    let bleedingMultiplier = 0; // No bleeding by default
    switch (damageType) {
      case 'cut':
      case 'slash':
        bleedingMultiplier = 150; // 1.5x bleeding
        break;
      case 'pierce':
      case 'stab':
        bleedingMultiplier = 120; // 1.2x bleeding
        break;
      case 'bullet':
      case 'projectile':
        bleedingMultiplier = 100; // 1.0x bleeding
        break;
      case 'blunt':
      case 'burn':
      default:
        bleedingMultiplier = 20; // Minimal bleeding (20 = 0.2x)
        break;
    }
    
    if (bleedingMultiplier === 0) return 0;
    
    // Base bleeding calculation: damage relative to part's max HP
    // Scale: bleeding rate proportional to damage severity
    let baseBleeding = Math.floor((damage * 100) / bodyPart.maxHp);
    
    // Body part specific modifiers
    let bodyPartMultiplier = 100; // 100 = 1.0x
    if (bodyPart.tags) {
      if (bodyPart.tags.includes('vital')) {
        bodyPartMultiplier = 150; // 1.5x bleeding for vital organs
      } else if (bodyPart.tags.includes('extremity')) {
        bodyPartMultiplier = 80; // 0.8x bleeding for extremities
      }
    }
    
    // Apply all modifiers (using integer math)
    const finalBleeding = Math.floor((baseBleeding * bleedingMultiplier * bodyPartMultiplier) / 10000);
    
    return Math.max(0, finalBleeding);
  }

  /**
   * Recursive function to determine hit location
   * @param {string} targetPartId - ID of the current target body part
   * @param {number} roll - Random number from 0 to 9999 (for deterministic results)
   * @returns {string} Final hit location ID
   */
  chanceHit(targetPartId, roll = null) {
    const bodyParts = this.system.health?.bodyParts;
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
    const bodyParts = this.system.health?.bodyParts;
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
    
    const bodyParts = this.system.health?.bodyParts;
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
   * @param {string} damageType - Type of damage (for different pain/bleeding calculations)
   * @returns {boolean} Success
   */
  async applyBodyPartDamage(partId, damage, damageType = 'blunt') {
    const bodyParts = this.system.health?.bodyParts;
    const bodyPart = bodyParts?.[partId];
    if (!bodyPart) return false;

    const oldHp = bodyPart.currentHp;
    const newHp = Math.max(0, oldHp - damage);
    const actualDamage = oldHp - newHp;
    
    // Определяем пути обновления
    const updatePaths = {};
    
    // Обновляем HP части тела
    updatePaths[`system.health.bodyParts.${partId}.currentHp`] = newHp;
    
    // Рассчитываем боль от урона (используем целые числа, умноженные на 100)
    const painFromDamage = this._calculatePainFromDamage(bodyPart, actualDamage, damageType);
    const currentPain = this.system.health?.pain?.current || 0;
    const newPain = Math.min(100, currentPain + painFromDamage);
    updatePaths['system.health.pain.current'] = newPain;
    
    // Рассчитываем кровотечение от урона
    const bleedingFromDamage = this._calculateBleedingFromDamage(bodyPart, actualDamage, damageType);
    const currentBleeding = this.system.health?.blood?.bleeding || 0;
    updatePaths['system.health.blood.bleeding'] = currentBleeding + bleedingFromDamage;
    
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
      percentage: totalMaxHp > 0 ? Math.floor((totalCurrentHp * 100) / totalMaxHp) : 100
    };
    
    // Обновляем процент крови (остается тем же, если нет кровопотери)
    const bloodCurrent = this.system.health?.blood?.current || 100;
    const bloodMax = this.system.health?.blood?.max || 100;
    updatePaths['system.health.blood.percentage'] = Math.floor((bloodCurrent * 100) / bloodMax);
    
    await this.update(updatePaths);
    
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
      
      // Подсчитываем общее здоровье новой анатомии
      let totalCurrentHp = 0;
      let totalMaxHp = 0;
      
      for (let bodyPart of Object.values(anatomy.bodyParts)) {
        totalCurrentHp += (bodyPart.currentHp ?? bodyPart.maxHp);
        totalMaxHp += bodyPart.maxHp;
      }
      
      const totalHealth = {
        current: totalCurrentHp,
        max: totalMaxHp,
        percentage: totalMaxHp > 0 ? Math.floor((totalCurrentHp / totalMaxHp) * 100) : 100
      };
      
      // Удаляем существующие части точечно (без слияния)
      const currentParts = this.system.health?.bodyParts || {};
      const delUpdate = {};
      for (const id of Object.keys(currentParts)) {
        delUpdate[`system.health.bodyParts.-=${id}`] = null;
      }
      if (Object.keys(delUpdate).length) {
        await this.update(delUpdate);
      }
      
      // Устанавливаем тип и новые части
      await this.update({
        'system.anatomy.type': anatomyId,
        'system.health.bodyParts': anatomy.bodyParts,
        'system.health.totalHealth': totalHealth
      });
      
      // Пересчёт данных
      await this.prepareData();
      
      console.log(`Set anatomy '${anatomyId}' for actor ${this.name}`);
      console.log(`Total health: ${totalHealth.current}/${totalHealth.max} (${totalHealth.percentage}%)`);
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
      if (clearType) delUpdate['system.anatomy.type'] = null;
      delUpdate['system.health.totalHealth'] = { current: 0, max: 0, percentage: 100 };
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
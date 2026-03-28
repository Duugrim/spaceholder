/**
 * Extend the basic Item with some very simple modifications.
 * @extends {Item}
 */
export class SpaceHolderItem extends Item {
  /**
   * Merge legacy `wearable` into `item` and backfill unified `item.system` fields.
   * @param {object} source
   * @param {object} [migrationData]
   * @returns {object}
   */
  static migrateData(source, migrationData) {
    if (source.type === 'wearable') source.type = 'item';

    if (source.type === 'item' && source.system && typeof source.system === 'object') {
      const s = source.system;
      if (s.equipped === undefined) s.equipped = false;
      if (s.anatomyId === undefined) s.anatomyId = null;
      if (s.anatomyGroup === undefined) s.anatomyGroup = null;
      if (!Array.isArray(s.coveredParts)) s.coveredParts = [];
      if (!s.defaultActions || typeof s.defaultActions !== 'object') {
        s.defaultActions = {
          equip: { showInCombat: false, showInQuickbar: true },
          unequip: { showInCombat: false, showInQuickbar: true },
        };
      } else {
        s.defaultActions.equip = s.defaultActions.equip || { showInCombat: false, showInQuickbar: true };
        s.defaultActions.unequip = s.defaultActions.unequip || { showInCombat: false, showInQuickbar: true };
      }
      if (!s.modifiers || typeof s.modifiers !== 'object') {
        s.modifiers = { abilities: [], derived: [], params: [] };
      } else {
        s.modifiers.abilities = Array.isArray(s.modifiers.abilities) ? s.modifiers.abilities : [];
        s.modifiers.derived = Array.isArray(s.modifiers.derived) ? s.modifiers.derived : [];
        s.modifiers.params = Array.isArray(s.modifiers.params) ? s.modifiers.params : [];
      }
      if (s.formula === undefined) {
        s.formula = 'd20 + @str.mod + ceil(@lvl / 2)';
      }
      if (!s.itemTags || typeof s.itemTags !== 'object') {
        s.itemTags = { isArmor: false, isActions: false, isModifiers: false };
      } else {
        s.itemTags.isArmor = !!s.itemTags.isArmor;
        s.itemTags.isActions = !!s.itemTags.isActions;
        s.itemTags.isModifiers = !!s.itemTags.isModifiers;
      }
    }

    return super.migrateData(source, migrationData);
  }

  /**
   * Augment the basic Item data model with additional dynamic data.
   */
  prepareData() {
    // As with the actor class, items are documents that can have their data
    // preparation methods overridden (such as prepareBaseData()).
    super.prepareData();
  }

  /**
   * Prepare a data object which defines the data schema used by dice roll commands against this Item
   * @override
   */
  getRollData() {
    // Starts off by populating the roll data with a shallow copy of `this.system`
    const rollData = { ...this.system };

    // Quit early if there's no parent actor
    if (!this.actor) return rollData;

    // If present, add the actor's roll data
    rollData.actor = this.actor.getRollData();

    return rollData;
  }

  /**
   * Handle clickable rolls.
   * @param {Event} event   The originating click event
   * @private
   */
  async roll() {
    const item = this;

    // Initialize chat data.
    const speaker = ChatMessage.getSpeaker({ actor: this.actor });
    const rollMode = game.settings.get('core', 'rollMode');
    const label = `[${item.type}] ${item.name}`;

    // If there's no roll data, send a chat message.
    if (!this.system.formula) {
      ChatMessage.create({
        speaker: speaker,
        rollMode: rollMode,
        flavor: label,
        content: item.system.description ?? '',
      });
    }
    // Otherwise, create a roll and send a chat message from it.
    else {
      // Retrieve roll data.
      const rollData = this.getRollData();

      // Invoke the roll and submit it to chat.
      const roll = new Roll(rollData.formula, rollData);
      // If you need to store the value first, uncomment the next line.
      // const result = await roll.evaluate();
      roll.toMessage({
        speaker: speaker,
        rollMode: rollMode,
        flavor: label,
      });
      return roll;
    }
  }
}

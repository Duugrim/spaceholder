// Import document classes.
import { SpaceHolderActor } from './documents/actor.mjs';
import { SpaceHolderItem } from './documents/item.mjs';
// Import sheet classes (Application V2)
import { SpaceHolderCharacterSheet, SpaceHolderNPCSheet } from './sheets/actor-sheet.mjs';
import { SpaceHolderItemSheet_Item, SpaceHolderItemSheet_Feature, SpaceHolderItemSheet_Spell, SpaceHolderItemSheet_Generic } from './sheets/item-sheet.mjs';
// Import helper/utility classes and constants.
import { preloadHandlebarsTemplates } from './helpers/templates.mjs';
import { SPACEHOLDER } from './helpers/config.mjs';
// Import anatomy manager
import { anatomyManager } from './anatomy-manager.mjs';
// Token pointer integration
import { TokenPointer, registerTokenPointerSettings, installTokenPointerHooks, installTokenPointerTabs } from './helpers/token-pointer.mjs';
import { registerTokenRotatorSettings, installTokenRotator } from './helpers/token-rotator.mjs';
import { registerSpaceholderSettingsMenus } from './helpers/settings-menus.mjs';
// Aiming system integration
import { AimingSystem, registerAimingSystemSettings, installAimingSystemHooks } from './helpers/aiming-system.mjs';
import { injectAimingStyles } from './helpers/ray-renderer.mjs';
// Draw manager for shot visualization
import { DrawManager } from './helpers/draw-manager.mjs';
import './helpers/test-aiming-system.mjs'; // Для отладки
import './helpers/aiming-demo-macros.mjs'; // Демо макросы
import './helpers/test-draw-manager.mjs'; // Тесты draw-manager
import './helpers/aiming-socket-manager.mjs'; // Socket менеджер для мультиплеерной синхронизации
// Token Controls integration
import { registerTokenControlButtons, installTokenControlsHooks } from './helpers/token-controls.mjs';

/* -------------------------------------------- */
/*  Init Hook                                   */
/* -------------------------------------------- */

Hooks.once('init', function () {
  // Register SpaceHolder settings and menus early
  registerTokenPointerSettings();
  registerTokenRotatorSettings();
  registerAimingSystemSettings();
  registerTokenControlButtons();
  registerSpaceholderSettingsMenus();
  installTokenPointerTabs();

  // Add utility classes to the global game object so that they're more easily
  // accessible in global contexts.
  game.spaceholder = {
    SpaceHolderActor,
    SpaceHolderItem,
    rollItemMacro,
    anatomyManager,
  };

  // Initialize Token Pointer and expose
  game.spaceholder.tokenpointer = new TokenPointer();
  
  // Initialize Aiming System
  game.spaceholder.aimingSystem = new AimingSystem();
  
  // Initialize Draw Manager
  game.spaceholder.drawManager = new DrawManager();

  // Install Token Pointer hooks
  installTokenPointerHooks();
  // Install Token Rotator keybindings and hooks
  installTokenRotator();
  // Install Aiming System hooks
  installAimingSystemHooks();
  // Install Token Controls hooks
  installTokenControlsHooks();

  // Add custom constants for configuration.
  CONFIG.SPACEHOLDER = SPACEHOLDER;

  /**
   * Set an initiative formula for the system
   * @type {String}
   */
  CONFIG.Combat.initiative = {
    formula: '1d20 + @abilities.dex.mod',
    decimals: 2,
  };

  // Define custom Document classes
  CONFIG.Actor.documentClass = SpaceHolderActor;
  CONFIG.Item.documentClass = SpaceHolderItem;

  // Active Effects are never copied to the Actor,
  // but will still apply to the Actor from within the Item
  // if the transfer property on the Active Effect is true.
  CONFIG.ActiveEffect.legacyTransferral = false;

  // Register sheet application classes (Application V2)
  // Unregister core v2 sheets
  foundry.documents.collections.Actors.unregisterSheet('core', foundry.applications.sheets.ActorSheet);
  foundry.documents.collections.Items.unregisterSheet('core', foundry.applications.sheets.ItemSheet);

  // Register Actor sheets by type
  foundry.documents.collections.Actors.registerSheet('spaceholder', SpaceHolderCharacterSheet, {
    types: ['character'],
    makeDefault: true,
    label: 'SPACEHOLDER.SheetLabels.Actor',
  });
  foundry.documents.collections.Actors.registerSheet('spaceholder', SpaceHolderNPCSheet, {
    types: ['npc'],
    makeDefault: true,
    label: 'SPACEHOLDER.SheetLabels.Actor',
  });

  // Register Item sheets by type (fallback generic)
  foundry.documents.collections.Items.registerSheet('spaceholder', SpaceHolderItemSheet_Item, {
    types: ['item'],
    makeDefault: true,
    label: 'SPACEHOLDER.SheetLabels.Item',
  });
  foundry.documents.collections.Items.registerSheet('spaceholder', SpaceHolderItemSheet_Feature, {
    types: ['feature'],
    makeDefault: true,
    label: 'SPACEHOLDER.SheetLabels.Item',
  });
  foundry.documents.collections.Items.registerSheet('spaceholder', SpaceHolderItemSheet_Spell, {
    types: ['spell'],
    makeDefault: true,
    label: 'SPACEHOLDER.SheetLabels.Item',
  });
  // Generic fallback for any other item types
  foundry.documents.collections.Items.registerSheet('spaceholder', SpaceHolderItemSheet_Generic, {
    makeDefault: false,
    label: 'SPACEHOLDER.SheetLabels.Item',
  });

  // Preload Handlebars templates.
  return preloadHandlebarsTemplates();
});

/* -------------------------------------------- */
/*  Handlebars Helpers                          */
/* -------------------------------------------- */

// If you need to add Handlebars helpers, here is a useful example:
Handlebars.registerHelper('toLowerCase', function (str) {
  return str.toLowerCase();
});

// Helper for multiplying numbers (for indentation)
Handlebars.registerHelper('multiply', function (a, b) {
  return a * b;
});

// Helper for joining arrays
Handlebars.registerHelper('join', function (array, separator) {
  if (Array.isArray(array)) {
    return array.join(separator);
  }
  return '';
});

// Helper for numeric comparisons
Handlebars.registerHelper('lt', function (a, b) {
  return a < b;
});

Handlebars.registerHelper('gt', function (a, b) {
  return a > b;
});

Handlebars.registerHelper('eq', function (a, b) {
  return a === b;
});

/* -------------------------------------------- */
/*  Ready Hook                                  */
/* -------------------------------------------- */

Hooks.once('ready', async function () {
  // Initialize anatomy manager
  try {
    await anatomyManager.initialize();
    console.log('SpaceHolder | Anatomy system initialized successfully');
  } catch (error) {
    console.error('SpaceHolder | Failed to initialize anatomy system:', error);
    ui.notifications.error('Failed to initialize anatomy system. Check console for details.');
  }
  
  // Initialize aiming system
  try {
    game.spaceholder.aimingSystem.initialize();
    injectAimingStyles();
    console.log('SpaceHolder | Aiming system initialized successfully');
  } catch (error) {
    console.error('SpaceHolder | Failed to initialize aiming system:', error);
    ui.notifications.error('Failed to initialize aiming system. Check console for details.');
  }
  
  // Initialize draw manager
  try {
    game.spaceholder.drawManager.initialize();
    console.log('SpaceHolder | Draw manager initialized successfully');
  } catch (error) {
    console.error('SpaceHolder | Failed to initialize draw manager:', error);
    ui.notifications.error('Failed to initialize draw manager. Check console for details.');
  }
  
  // Wait to register hotbar drop hook on ready so that modules could register earlier if they want to
  Hooks.on('hotbarDrop', (bar, data, slot) => createItemMacro(data, slot));
});

/* -------------------------------------------- */
/*  Hotbar Macros                               */
/* -------------------------------------------- */

/**
 * Create a Macro from an Item drop.
 * Get an existing item macro if one exists, otherwise create a new one.
 * @param {Object} data     The dropped data
 * @param {number} slot     The hotbar slot to use
 * @returns {Promise}
 */
async function createItemMacro(data, slot) {
  // First, determine if this is a valid owned item.
  if (data.type !== 'Item') return;
  if (!data.uuid.includes('Actor.') && !data.uuid.includes('Token.')) {
    return ui.notifications.warn(
      'You can only create macro buttons for owned Items'
    );
  }
  // If it is, retrieve it based on the uuid.
  const item = await Item.fromDropData(data);

  // Create the macro command using the uuid.
  const command = `game.spaceholder.rollItemMacro("${data.uuid}");`;
  let macro = game.macros.find(
    (m) => m.name === item.name && m.command === command
  );
  if (!macro) {
    macro = await Macro.create({
      name: item.name,
      type: 'script',
      img: item.img,
      command: command,
      flags: { 'spaceholder.itemMacro': true },
    });
  }
  game.user.assignHotbarMacro(macro, slot);
  return false;
}

/**
 * Create a Macro from an Item drop.
 * Get an existing item macro if one exists, otherwise create a new one.
 * @param {string} itemUuid
 */
function rollItemMacro(itemUuid) {
  // Reconstruct the drop data so that we can load the item.
  const dropData = {
    type: 'Item',
    uuid: itemUuid,
  };
  // Load the item from the uuid.
  Item.fromDropData(dropData).then((item) => {
    // Determine if the item loaded and if it's an owned item.
    if (!item || !item.parent) {
      const itemName = item?.name ?? itemUuid;
      return ui.notifications.warn(
        `Could not find item ${itemName}. You may need to delete and recreate this macro.`
      );
    }

    // Trigger the item roll
    item.roll();
  });
}

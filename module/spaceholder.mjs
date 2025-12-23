// Import document classes.
import { SpaceHolderActor } from './documents/actor.mjs';
import { SpaceHolderItem } from './documents/item.mjs';
// Import sheet classes (Application V2)
import { SpaceHolderCharacterSheet, SpaceHolderNPCSheet, SpaceHolderGlobalObjectSheet } from './sheets/actor-sheet.mjs';
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
// User -> Factions (Journal UUID) mapping
import { installUserFactionsHooks, getUsersForToken as getUsersForTokenByFaction, getUsersForFaction as getUsersForFactionByUuid, getUserFactionUuids as getUserFactionUuidsForUser, normalizeUuid as normalizeUuidValue } from './helpers/user-factions.mjs';
// Aiming system integration - OLD SYSTEM DISABLED 2025-10-28
// import { AimingSystem, registerAimingSystemSettings, installAimingSystemHooks } from './helpers/old-aiming-system.mjs';
// import { injectAimingStyles } from './helpers/old-ray-renderer.mjs';
// Draw manager for shot visualization
import { DrawManager } from './helpers/draw-manager.mjs';
// Shot manager for shot calculation
import { ShotManager } from './helpers/shot-manager.mjs';
// Influence manager for global objects influence zones
import { InfluenceManager } from './helpers/influence-manager.mjs';
// Height map manager and renderer
// DEPRECATED: Old height/biome map system - disabled pending replacement
// import { HeightMapManager } from './helpers/heightmap-manager.mjs';
// import { HeightMapRenderer } from './helpers/heightmap-renderer.mjs';
// import { HeightMapEditor } from './helpers/heightmap-editor.mjs';
// import { registerHeightMapSceneConfig, installHeightMapSceneConfigHooks } from './helpers/heightmap-scene-config.mjs';
// import { BiomeManager } from './helpers/biome-manager.mjs';
// import { BiomeRenderer } from './helpers/biome-renderer.mjs';
// import { BiomeEditor } from './helpers/biome-editor.mjs';
// import { TerrainFieldManager } from './helpers/terrain-field-manager.mjs';
// import { registerTerrainControls } from './helpers/terrain-controls.mjs';

// NEW: Global map system (replacement for height/biome maps)
import { GlobalMapProcessing } from './helpers/global-map/global-map-processing.mjs';
import { GlobalMapRenderer } from './helpers/global-map/global-map-renderer.mjs';
import { GlobalMapTools } from './helpers/global-map/global-map-tools.mjs';
import { registerGlobalMapUI } from './helpers/global-map/global-map-ui.mjs';
// import './helpers/old-test-aiming-system.mjs'; // Для отладки - DISABLED
// import './helpers/old-aiming-demo-macros.mjs'; // Демо макросы - DISABLED
// import './helpers/test-draw-manager.mjs'; // Тесты draw-manager
// import './helpers/old-aiming-socket-manager.mjs'; // Socket менеджер - DISABLED
// Token Controls integration
import { registerTokenControlButtons, installTokenControlsHooks } from './helpers/token-controls.mjs';
// Token visibility (advanced)
import { installTokenVisibilityHooks } from './helpers/token-visibility.mjs';

/* -------------------------------------------- */
/*  Init Hook                                   */
/* -------------------------------------------- */

Hooks.once('init', function () {
  // Register SpaceHolder settings and menus early
  registerTokenPointerSettings();
  registerTokenRotatorSettings();
  // registerAimingSystemSettings(); // OLD SYSTEM DISABLED
  registerTokenControlButtons();
  registerSpaceholderSettingsMenus();
  installTokenPointerTabs();
  
  // DEPRECATED: Old height map scene configuration - disabled
  // registerHeightMapSceneConfig();
  // installHeightMapSceneConfigHooks();

  // Add utility classes to the global game object so that they're more easily
  // accessible in global contexts.
  game.spaceholder = {
    SpaceHolderActor,
    SpaceHolderItem,
    rollItemMacro,
    anatomyManager,
    // Helper functions for influence zones
    showInfluence: (debug = false) => game.spaceholder.influenceManager?.enable({ debug }),
    hideInfluence: () => game.spaceholder.influenceManager?.disable(),
    toggleInfluence: (debug = false) => game.spaceholder.influenceManager?.toggle({ debug }),
    // User -> Factions helpers
    getUserFactionUuids: (user) => getUserFactionUuidsForUser(user),
    getUsersForFaction: (factionUuid) => getUsersForFactionByUuid(factionUuid),
    getUsersForToken: (tokenLike) => getUsersForTokenByFaction(tokenLike),
    normalizeUuid: (raw) => normalizeUuidValue(raw),
    // Global map helpers (new system)
    // TODO: Add new global map helpers when ready
    
    // DEPRECATED: Old height/biome map helpers - no longer used
    // (kept structure for reference during migration)
  };

  // Initialize Token Pointer and expose
  game.spaceholder.tokenpointer = new TokenPointer();
  
  // Initialize Aiming System - OLD SYSTEM DISABLED
  // game.spaceholder.aimingSystem = new AimingSystem();
  
  // Initialize Draw Manager
  game.spaceholder.drawManager = new DrawManager();
  
  // Initialize Shot Manager
  game.spaceholder.shotManager = new ShotManager();
  
  // Initialize Influence Manager
  game.spaceholder.influenceManager = new InfluenceManager();
  
  // DEPRECATED: Old map systems - disabled
  // game.spaceholder.heightMapManager = new HeightMapManager();
  // game.spaceholder.biomeManager = new BiomeManager();
  // game.spaceholder.terrainFieldManager = new TerrainFieldManager();
  console.log('SpaceHolder | Old height/biome map systems DISABLED. Migration in progress.');
  
  // NEW: Global map system
  game.spaceholder.globalMapProcessing = new GlobalMapProcessing();
  game.spaceholder.globalMapRenderer = new GlobalMapRenderer();
  game.spaceholder.globalMapTools = new GlobalMapTools(game.spaceholder.globalMapRenderer, game.spaceholder.globalMapProcessing);
  
  // Initialize asynchronously (load configs)
  (async () => {
    await game.spaceholder.globalMapProcessing.initialize();
    await game.spaceholder.globalMapRenderer.initialize();
    console.log('SpaceHolder | Global map system initialized');
  })();
  
  // Register global map UI controls
  Hooks.on('getSceneControlButtons', (controls) => {
    registerGlobalMapUI(controls, game.spaceholder);
  });
  // Install Token Pointer hooks
  installTokenPointerHooks();
  // Install Token Rotator keybindings and hooks
  installTokenRotator();
  // Install User -> Factions hooks (UserConfig injection)
  installUserFactionsHooks();
  // Install Token visibility hooks
  installTokenVisibilityHooks();
  // Install Aiming System hooks - OLD SYSTEM DISABLED
  // installAimingSystemHooks();
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
  foundry.documents.collections.Actors.registerSheet('spaceholder', SpaceHolderGlobalObjectSheet, {
    types: ['globalobject'],
    makeDefault: true,
    label: 'SPACEHOLDER.SheetLabels.GlobalObject',
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
  
  // Initialize aiming system - OLD SYSTEM DISABLED
  // try {
  //   game.spaceholder.aimingSystem.initialize();
  //   injectAimingStyles();
  //   console.log('SpaceHolder | Aiming system initialized successfully');
  // } catch (error) {
  //   console.error('SpaceHolder | Failed to initialize aiming system:', error);
  //   ui.notifications.error('Failed to initialize aiming system. Check console for details.');
  // }
  
  // Initialize draw manager
  try {
    game.spaceholder.drawManager.initialize();
    console.log('SpaceHolder | Draw manager initialized successfully');
  } catch (error) {
    console.error('SpaceHolder | Failed to initialize draw manager:', error);
    ui.notifications.error('Failed to initialize draw manager. Check console for details.');
  }
  
  // Initialize shot manager
  try {
    console.log('SpaceHolder | Shot manager initialized successfully');
  } catch (error) {
    console.error('SpaceHolder | Failed to initialize shot manager:', error);
    ui.notifications.error('Failed to initialize shot manager. Check console for details.');
  }
  
  // Initialize influence manager
  try {
    game.spaceholder.influenceManager.initialize();
    console.log('SpaceHolder | Influence manager initialized successfully');
  } catch (error) {
    console.error('SpaceHolder | Failed to initialize influence manager:', error);
    ui.notifications.error('Failed to initialize influence manager. Check console for details.');
  }
  
  // DEPRECATED: Old height map systems - no longer initialized
  // game.spaceholder.heightMapManager, heightMapRenderer, etc are disabled
  
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

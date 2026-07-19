// Import document classes.
import { SpaceHolderActor } from './documents/actor.mjs';
import { SpaceHolderItem } from './documents/item.mjs';
// Import sheet classes (Application V2)
import { SpaceHolderCharacterSheet, SpaceHolderNPCSheet, SpaceHolderLootSheet, SpaceHolderGlobalObjectSheet, SpaceHolderFactionSheet } from './sheets/actor-sheet.mjs';
import { SpaceHolderItemSheet_Item, SpaceHolderItemSheet_Feature, SpaceHolderItemSheet_Spell, SpaceHolderItemSheet_Generic, SpaceHolderItemSheet_Material } from './sheets/item-sheet.mjs';
// Import helper/utility classes and constants.
import { preloadHandlebarsTemplates } from './helpers/templates.mjs';
import { SPACEHOLDER } from './helpers/config.mjs';
// Import anatomy manager
import { anatomyManager } from './anatomy-manager.mjs';
// Damage / armour system
import { materialsManager, ensureLayerDefaults } from './helpers/damage/materials-manager.mjs';
import { openArmorPenetrationTesterApp } from './helpers/damage/armor-penetration-tester-app.mjs';
import { WearableCoverageEditor } from './helpers/wearable-coverage-editor.mjs';
// Token pointer integration
import { TokenPointer, registerTokenPointerSettings, installTokenPointerHooks, installTokenPointerTabs } from './helpers/token-pointer.mjs';
import { registerTokenRotatorSettings, installTokenRotator } from './helpers/token-rotator.mjs';
import { registerSpaceholderSettingsMenus } from './helpers/settings-menus.mjs';
// Icon library + picker
import { registerIconLibrarySettings, getIconIndexCacheInfo as getIconLibraryCacheInfo, getIconIndex as getIconLibraryIndex } from './helpers/icon-library/icon-library.mjs';
import {
  registerIconLibraryMigrationSettings,
  migrateIconLibraryGeneratedSvgsRemoveNonScalingStroke,
  migrateIconLibraryGeneratedSvgsInsetBackgroundStroke,
} from './helpers/icon-library/icon-migrations.mjs';
import { pickIcon } from './helpers/icon-picker/icon-picker.mjs';
import { applyIconPathToActorOrToken, pickAndApplyIconToActorOrToken, promptPickAndApplyIconToActorOrToken } from './helpers/icon-picker/icon-apply.mjs';
// User -> Factions mapping (used by timeline and other faction-aware features)
import { installUserFactionsHooks, getUsersForToken as getUsersForTokenByFaction, getUsersForFaction as getUsersForFactionByUuid, getUserFactionUuids as getUserFactionUuidsForUser, normalizeUuid as normalizeUuidValue } from './helpers/user-factions.mjs';
// Journal Directory helpers
import { installJournalDirectoryHooks } from './helpers/journal-directory.mjs';
// Journal Check (workflow statuses)
import { registerJournalCheckSettings, installJournalCheckHooks } from './helpers/journal-check.mjs';
// Progression Points (PP)
import { registerProgressionPointsSettings, installProgressionPointsHooks } from './helpers/progression-points.mjs';
import { openProgressionPointsApp } from './helpers/progression-points-app.mjs';
// Journal Update Log window
import { openJournalUpdateLogApp } from './helpers/journal-update-log-app.mjs';
// Timeline V2
import { registerTimelineV2Settings, installTimelineV2SocketHandlers, installTimelineV2Hooks } from './helpers/timeline-v2.mjs';
import { openTimelineV2App, openTimelineV2CreateEventEditor } from './helpers/timeline-v2-app.mjs';
// Events
import { installEventsSocketHandlers, installEventsHooks } from './helpers/events.mjs';
import { openEventsApp } from './helpers/events-app.mjs';
// Aiming system integration - OLD SYSTEM DISABLED 2025-10-28
// import { AimingSystem, registerAimingSystemSettings, installAimingSystemHooks } from './helpers/old-aiming-system.mjs';
// import { injectAimingStyles } from './helpers/old-ray-renderer.mjs';
import { AimingManager } from './helpers/aiming-manager.mjs';
// Draw manager for shot visualization
import { DrawManager } from './helpers/draw-manager.mjs';
// Shot manager for shot calculation
import { ShotManager } from './helpers/shot-manager.mjs';
// Influence manager for global objects influence zones
import { InfluenceManager } from './helpers/influence-manager.mjs';

// NEW: Global map system (replacement for height/biome maps)
import { GlobalMapProcessing } from './helpers/global-map/global-map-processing.mjs';
import { GlobalMapRenderer } from './helpers/global-map/global-map-renderer.mjs';
import { GlobalMapTools } from './helpers/global-map/global-map-tools.mjs';
import { registerGlobalMapUI } from './helpers/global-map/global-map-ui.mjs';
import { installGlobalMapSceneConfigHooks } from './helpers/global-map/global-map-scene-config.mjs';
import { installGlobalMapEdgeUiHooks } from './helpers/global-map/global-map-edge-ui.mjs';
import { installGlobalMapFactionVision } from './helpers/global-map/global-map-faction-vision.mjs';
// Hotbar: faction selector + PP indicator
import { installHotbarFactionUiHooks } from './helpers/hotbar-faction-ui.mjs';
import { installTokenQuickHudHooks } from './helpers/token-quick-hud.mjs';
// import './helpers/old-aiming-socket-manager.mjs'; // Socket менеджер - DISABLED
// Token Controls integration
import { registerTokenControlButtons, installTokenControlsHooks } from './helpers/token-controls.mjs';
import { installAimingArcOverlayHooks } from './helpers/aiming-arc-overlay.mjs';
// Actions system (MVP)
import { collectActorActions, executeActorAction } from './helpers/actions/action-service.mjs';
import {
  spendAp,
  undoTransaction,
  getStoredActionPoints,
  ensureCharacterApSynced,
  installTransactionLedgerHooks,
} from './helpers/actions/transaction-ledger.mjs';
import {
  apToSeconds,
  secondsToAp,
  advancePersonalTime,
  getPersonalTimeTotal,
  openSkipPersonalTimeDialog,
  REFERENCE_TURN_SECONDS,
} from './helpers/actions/personal-time.mjs';
import { registerChargePersonalTimeHooks } from './helpers/weapon/charge-personal-time.mjs';
import { installActionChatJournalHooks } from './helpers/actions/action-chat-journal.mjs';
import { MovementManager } from './helpers/actions/movement-manager.mjs';
import { CombatSessionManager } from './helpers/combat/combat-session-manager.mjs';
import { installTurnPickOverlay } from './helpers/combat/turn-pick-overlay.mjs';
import { registerItemPilesShSettings, initializeItemPilesSh } from './helpers/item-piles-sh/index.mjs';
import { ITEM_PILES_SH } from './helpers/item-piles-sh/constants.mjs';
import { registerSpaceholderActiveEffectModels } from './helpers/register-active-effect-models.mjs';
import {
  addItemToNestedStorage,
  extractNestedItemToActor,
  getNestedStorage,
  normalizeNestedStorage,
} from './helpers/item-nested-storage.mjs';
import { registerHealthAnatomyViewerSettings } from './helpers/health-anatomy-viewer-settings.mjs';

/* -------------------------------------------- */
/*  Init Hook                                   */
/* -------------------------------------------- */

Hooks.once('init', function () {
  registerSpaceholderActiveEffectModels();

  // Register SpaceHolder settings and menus early
  registerIconLibrarySettings();
  registerIconLibraryMigrationSettings();
  registerTokenPointerSettings();
  registerTokenRotatorSettings();
  registerTokenControlButtons();
  registerSpaceholderSettingsMenus();
  registerJournalCheckSettings();
  registerProgressionPointsSettings();
  registerTimelineV2Settings();
  registerItemPilesShSettings();
  registerHealthAnatomyViewerSettings();
  installTokenPointerTabs();
  // Legacy world anatomy keys: used only for one-time migration into world folder files
  // World anatomies live in: worlds/<worldId>/spaceholder/anatomy/*.json (FilePicker upload/browse)
  game.settings.register("spaceholder", "worldAnatomyEntries", {
    scope: "world",
    config: false,
    default: { entries: [] }
  });
  game.settings.register("spaceholder", "anatomyPresets", {
    scope: "world",
    config: false,
    default: { presets: [] }
  });
  // Add utility classes to the global game object so that they're more easily
  // accessible in global contexts.
  game.spaceholder = {
    SpaceHolderActor,
    SpaceHolderItem,
    rollItemMacro,
    anatomyManager,
    materialsManager,
    openArmorPenetrationTester: openArmorPenetrationTesterApp,
    openJournalUpdateLogApp,
    openProgressionPointsApp,
    openTimelineV2App,
    openTimelineV2CreateEventEditor,
    openEventsApp,
    // Icon library / picker
    pickIcon,
    applyIconPathToActorOrToken,
    pickAndApplyIconToActorOrToken,
    promptPickAndApplyIconToActorOrToken,
    migrateIconLibraryGeneratedSvgsRemoveNonScalingStroke: (opts = {}) => migrateIconLibraryGeneratedSvgsRemoveNonScalingStroke(opts),
    migrateIconLibraryGeneratedSvgsInsetBackgroundStroke: (opts = {}) => migrateIconLibraryGeneratedSvgsInsetBackgroundStroke(opts),
    getIconLibraryIndex: (opts = {}) => getIconLibraryIndex(opts),
    getIconLibraryCacheInfo: () => getIconLibraryCacheInfo(),
    // Helper functions for influence zones
    showInfluence: (debug = false) => game.spaceholder.influenceManager?.enable({ debug }),
    hideInfluence: () => game.spaceholder.influenceManager?.disable(),
    toggleInfluence: (debug = false) => game.spaceholder.influenceManager?.toggle({ debug }),
    // User -> Factions helpers
    getUserFactionUuids: (user) => getUserFactionUuidsForUser(user),
    getUsersForFaction: (factionUuid) => getUsersForFactionByUuid(factionUuid),
    getUsersForToken: (tokenLike) => getUsersForTokenByFaction(tokenLike),
    normalizeUuid: (raw) => normalizeUuidValue(raw),
    // Actions system (MVP)
    collectActorActions: (actor, ctx = {}) => collectActorActions(actor, ctx),
    executeActorAction: (actor, action, ctx = {}) => executeActorAction(actor, action, ctx),
    spendAp: (actor, cost, meta = {}) => spendAp(actor, cost, meta),
    undoTransaction: (opts = {}) => undoTransaction(opts),
    getStoredActionPoints: (actor) => getStoredActionPoints(actor),
    apToSeconds: (actor, ap) => apToSeconds(actor, ap),
    secondsToAp: (actor, seconds) => secondsToAp(actor, seconds),
    advancePersonalTime: (actor, seconds, meta = {}) => advancePersonalTime(actor, seconds, meta),
    getPersonalTimeTotal: (actor) => getPersonalTimeTotal(actor),
    openSkipPersonalTimeDialog: () => openSkipPersonalTimeDialog(),
    openHackMinigame: () => import('./helpers/minigames/hack/hack-generate-dialog.mjs')
      .then(({ openHackGenerateDialog }) => openHackGenerateDialog()),
    REFERENCE_TURN_SECONDS,
    ensureCharacterApSynced: (actor) => ensureCharacterApSynced(actor),
    nestedItemStorage: {
      addItemToNestedStorage,
      extractNestedItemToActor,
      getNestedStorage,
      normalizeNestedStorage,
    },
    setCombatantSide: (args = {}) => game.spaceholder.combatSessionManager?.setCombatantSide?.(args),
    endCombatTurn: (args = {}) => game.spaceholder.combatSessionManager?.endTurn?.(args),
    pickCombatTurn: (args = {}) => game.spaceholder.combatSessionManager?.pickTurn?.(args),
    undoCombatAction: (args = {}) => game.spaceholder.combatSessionManager?.undoLastAction?.(args),
    // Global map helpers (new system)
    // TODO: Add new global map helpers when ready
    
    // DEPRECATED: Old height/biome map helpers - no longer used
    // (kept structure for reference during migration)
    // item-piles-sh API is attached in ready hook after bootstrap.
  };

  // Initialize Token Pointer and expose
  game.spaceholder.tokenpointer = new TokenPointer();

  // Initialize Movement Manager (actions MVP)
  game.spaceholder.movementManager = new MovementManager();
  // Hooks are installed lazily on start(), but we keep explicit install available
  try { game.spaceholder.movementManager.installHooks(); } catch (_) {}
  game.spaceholder.combatSessionManager = new CombatSessionManager();
  try { game.spaceholder.combatSessionManager.install(); } catch (_) {}
  try { installTurnPickOverlay(); } catch (_) {}
  
  // Initialize Aiming System - OLD SYSTEM DISABLED
  // game.spaceholder.aimingSystem = new AimingSystem();
  
  // Initialize Draw Manager
  game.spaceholder.drawManager = new DrawManager();
  
  // Initialize Shot Manager
  game.spaceholder.shotManager = new ShotManager();

  // Initialize Aiming Manager singleton for actions + token controls
  game.spaceholder.aimingManager = new AimingManager();
  
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
  // Scene config hooks for global map flag
  installGlobalMapSceneConfigHooks();
  // Edge UI (fixed panel) for global map scenes
  installGlobalMapEdgeUiHooks();
  // Global Map: vision sources by faction instead of OBSERVER
  installGlobalMapFactionVision();
  // Install Token Pointer hooks
  installTokenPointerHooks();
  // Install Token Rotator keybindings and hooks
  installTokenRotator();
  // Install User -> Factions hooks (UserConfig UI)
  installUserFactionsHooks();
  // Hotbar: faction selector + PP indicator
  installHotbarFactionUiHooks();
  installTokenQuickHudHooks();
  // Install Journal Directory hooks (Clear Journals button)
  installJournalDirectoryHooks();
  // Install Journal Check hooks (statuses + UI)
  installJournalCheckHooks();
  // Install Progression Points hooks (PP)
  installProgressionPointsHooks();
  // Timeline V2: socket + hooks
  installTimelineV2SocketHandlers();
  installTimelineV2Hooks();
  // Events: socket + hooks
  installEventsSocketHandlers();
  installEventsHooks();
  // Install Aiming System hooks - OLD SYSTEM DISABLED
  // installAimingSystemHooks();
  // Install Token Controls hooks
  installTokenControlsHooks();
  installAimingArcOverlayHooks();

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
  foundry.documents.collections.Actors.registerSheet('spaceholder', SpaceHolderLootSheet, {
    types: ['loot'],
    makeDefault: true,
    label: 'SPACEHOLDER.SheetLabels.Loot',
  });
  foundry.documents.collections.Actors.registerSheet('spaceholder', SpaceHolderGlobalObjectSheet, {
    types: ['globalobject'],
    makeDefault: true,
    label: 'SPACEHOLDER.SheetLabels.GlobalObject',
  });
  foundry.documents.collections.Actors.registerSheet('spaceholder', SpaceHolderFactionSheet, {
    types: ['faction'],
    makeDefault: true,
    label: 'SPACEHOLDER.SheetLabels.Faction',
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
  foundry.documents.collections.Items.registerSheet('spaceholder', SpaceHolderItemSheet_Material, {
    types: ['material'],
    makeDefault: true,
    label: 'SPACEHOLDER.SheetLabels.Item',
  });
  // Generic fallback for any other item types
  foundry.documents.collections.Items.registerSheet('spaceholder', SpaceHolderItemSheet_Generic, {
    makeDefault: false,
    label: 'SPACEHOLDER.SheetLabels.Item',
  });

  // Предмет (gear): привязка кнопок и визуализатора покрытия через renderItemSheetV2
  Hooks.on('renderItemSheetV2', async (app, element, context, options) => {
    const doc = app.document;
    if (!doc || doc.type !== 'item') return;
    if (!(element instanceof HTMLElement)) return;
    if (!doc.system?.itemTags?.isArmor) return;

    const btn = element.querySelector('[data-action="wearable-select-anatomy"]');
    if (btn && !btn.dataset.spaceholderBound) {
      btn.dataset.spaceholderBound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openWearableAnatomyDialog(doc);
      });
    }

    // После перерисовки листа Wearable возвращаем пользователя на вкладку «Покрытие»
    const renderAndStayOnCoverage = async () => {
      await app.render();
      try {
        app.changeTab?.('attributes', 'primary', { updatePosition: false });
      } catch (_) { /* ignore */ }
    };

    // Кнопка режима редактирования покрытия
    const editModeBtn = element.querySelector('[data-action="wearable-coverage-edit-mode"]');
    if (editModeBtn && !editModeBtn.dataset.spaceholderBound) {
      editModeBtn.dataset.spaceholderBound = '1';
      editModeBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const next = !doc.flags?.spaceholder?.wearableCoverageEditMode;
        await doc.update({ 'flags.spaceholder.wearableCoverageEditMode': next });
        await renderAndStayOnCoverage();
      });
    }

    // Визуализатор: в режиме редактирования — все части + голубая пометка выбранных; без редактирования — только выбранные части
    const editorContainer = element.querySelector('[data-wearable-coverage-editor="container"]');
    if (editorContainer) {
      const anatomyData = await loadWearableReferenceAnatomy(doc.system?.anatomyId);
      if (anatomyData?.bodyParts) {
        const coveredParts = Array.isArray(doc.system?.coveredParts) ? doc.system.coveredParts : [];
        const armorByPart = Object.fromEntries(
          coveredParts.map((c) => {
            const slotRef = String(c.slotRef ?? c.partId ?? "").trim();
            if (!slotRef) return null;
            return [slotRef, {}];
          }).filter(Boolean)
        );
        const showOnlyCovered = !doc.flags?.spaceholder?.wearableCoverageEditMode;
        const editor = new WearableCoverageEditor(editorContainer, {
          anatomyData: { bodyParts: anatomyData.bodyParts, grid: anatomyData.grid ?? {} },
          armorByPart,
          showOnlyCovered,
          onChange: showOnlyCovered ? undefined : async (next) => {
            // Preserve any existing per-part data (e.g. layers) when toggling coverage.
            const prev = Array.isArray(doc.system?.coveredParts) ? doc.system.coveredParts : [];
            const prevBySlot = new Map();
            for (const c of prev) {
              const ref = String(c?.slotRef ?? c?.partId ?? '').trim();
              if (ref) prevBySlot.set(ref, c);
            }
            const nextCoveredParts = Object.keys(next).map((slotRef) => {
              const existing = prevBySlot.get(slotRef);
              if (existing) return { ...existing, slotRef };
              return { slotRef, layers: [] };
            });
            const keepAnatomyId = doc.system?.anatomyId ?? null;
            // Item DataModel: обновление только coveredParts может сбросить anatomyId — явно сохраняем.
            await doc.update({
              'system.coveredParts': nextCoveredParts,
              'system.anatomyId': keepAnatomyId,
            });
            await renderAndStayOnCoverage();
          }
        });
        editor.render();
      }
    }

    // Правая колонка: редактирование и удаление покрытия
    if (app.isEditable) {
      element.querySelectorAll('[data-action="wearable-coverage-layers"]').forEach((el) => {
        if (el.dataset.spaceholderBound) return;
        el.dataset.spaceholderBound = '1';
        el.addEventListener('click', (e) => {
          e.preventDefault();
          const slotRef = e.currentTarget.dataset?.partId;
          const partName = e.currentTarget.dataset?.partName || slotRef;
          if (!slotRef) return;
          openWearableLayersDialog(doc, slotRef, partName).then(() => renderAndStayOnCoverage());
        });
      });

      element.querySelectorAll('[data-action="wearable-coverage-remove"]').forEach((el) => {
        if (el.dataset.spaceholderBound) return;
        el.dataset.spaceholderBound = '1';
        el.addEventListener('click', async (e) => {
          e.preventDefault();
          const slotRef = e.currentTarget.dataset?.partId;
          if (!slotRef) return;

          const prev = Array.isArray(doc.system?.coveredParts) ? doc.system.coveredParts : [];
          const nextCoveredParts = prev.filter((c) => {
            const ref = String(c.slotRef ?? c.partId ?? "").trim();
            return ref && ref !== slotRef;
          });
          if (nextCoveredParts.length === prev.length) return;

          const keepAid = doc.system?.anatomyId ?? null;
          await doc.update({
            'system.coveredParts': nextCoveredParts,
            'system.anatomyId': keepAid,
          });
          await renderAndStayOnCoverage();
        });
      });
    }
  });

  // Делегирование клика: кнопка «Выбрать анатомию» работает даже если хук renderItemSheetV2 не сработал
  document.body.addEventListener('click', async (e) => {
    const btn = e.target.closest?.('[data-action="wearable-select-anatomy"]');
    if (!btn?.dataset?.itemUuid) return;
    e.preventDefault();
    e.stopPropagation();
    const doc = await fromUuid(btn.dataset.itemUuid);
    if (doc?.type === 'item' && doc.system?.itemTags?.isArmor) openWearableAnatomyDialog(doc);
  });

  // Preload Handlebars templates.
  return preloadHandlebarsTemplates();
});

Hooks.on('preCreateActor', (_actor, data) => {
  try {
    const type = String(data?.type ?? '').trim();
    if (type !== 'loot') return;

    const fallbackImg = ITEM_PILES_SH.PILE_DEFAULT_TOKEN_TEXTURE;
    const actorImg = String(data?.img ?? '').trim();
    if (!actorImg || actorImg === 'icons/svg/mystery-man.svg') {
      foundry.utils.setProperty(data, 'img', fallbackImg);
    }

    const tokenImg = String(foundry.utils.getProperty(data, 'prototypeToken.texture.src') ?? '').trim();
    if (!tokenImg) {
      foundry.utils.setProperty(data, 'prototypeToken.texture.src', fallbackImg);
    }
  } catch (e) {
    console.error('SpaceHolder | Failed to apply default loot icon', e);
  }
});

/**
 * Открыть диалог выбора эталонной анатомии для Wearable (системные + мировые).
 * Сохраняет только anatomyId; механика брони не привязана к анатомии актёра.
 * @param {Item} item - документ предмета типа item (gear)
 */
const SH_WEARABLE_ANATOMY_REOPEN_GUARD_MS = 450;

async function openWearableAnatomyDialog(item) {
  if (!item || item.type !== 'item') return;
  if (!item.system?.itemTags?.isArmor) return;
  const lastApply = globalThis.__shWearableAnatomyJustAppliedAt;
  if (typeof lastApply === 'number' && Date.now() - lastApply < SH_WEARABLE_ANATOMY_REOPEN_GUARD_MS) {
    return;
  }
  await anatomyManager.loadWorldPresets();
  const availableAnatomies = anatomyManager.getAvailableAnatomies();
  const worldPresets = anatomyManager.getWorldPresets();
  const currentId = String(item.system?.anatomyId ?? '').trim() || '';

  const L = (key) => game.i18n.localize(key);
  const labelSelect = L('SPACEHOLDER.Wearable.Anatomy');
  const labelSystem = L('SPACEHOLDER.Health.Anatomy.SystemGroup');
  const labelWorld = L('SPACEHOLDER.Health.Anatomy.WorldGroup');

  const systemOptions = Object.entries(availableAnatomies)
    .map(([id]) => {
      const name = anatomyManager.getAnatomyDisplayName(id);
      const safeVal = String(id).replace(/"/g, '&quot;');
      const safeName = (name || id).replace(/</g, '&lt;');
      const sel = id === currentId ? ' selected' : '';
      return `<option value="${safeVal}"${sel}>${safeName}</option>`;
    })
    .join('');

  const worldOptions = worldPresets
    .map((p) => {
      const id = p.id || '';
      const name = (p.name || id).replace(/</g, '&lt;');
      const safeVal = id.replace(/"/g, '&quot;');
      const sel = id === currentId ? ' selected' : '';
      return `<option value="world:${safeVal}"${sel}>${name}</option>`;
    })
    .join('');

  const worldGroupHtml = worldOptions
    ? `<optgroup label="${labelWorld.replace(/"/g, '&quot;')}">${worldOptions}</optgroup>`
    : '';

  const content = `
    <div class="wearable-anatomy-dialog">
      <div class="form-group">
        <label>${labelSelect.replace(/</g, '&lt;')}</label>
        <select id="wearable-anatomy-select" style="width:100%; height:32px;">
          <option value="">${L('SPACEHOLDER.Wearable.NoAnatomySelected').replace(/</g, '&lt;')}</option>
          <optgroup label="${labelSystem.replace(/"/g, '&quot;')}">
            ${systemOptions}
          </optgroup>
          ${worldGroupHtml}
        </select>
      </div>
    </div>
  `;

  const buttons = [
    {
      action: 'apply',
      label: L('SPACEHOLDER.Health.Anatomy.Apply'),
      icon: 'fa-solid fa-check',
      default: true,
      callback: async (dlgEvent) => {
        const root = dlgEvent.currentTarget;
        const raw = (root.querySelector('#wearable-anatomy-select')?.value ?? '').trim();
        let anatomyId = null;
        if (raw && raw.startsWith('world:')) {
          anatomyId = raw.slice(6);
        } else if (raw) {
          anatomyId = raw;
        }
        await item.update({
          'system.anatomyId': anatomyId
        });
        globalThis.__shWearableAnatomyJustAppliedAt = Date.now();
        await item.sheet?.render?.();
        try {
          item.sheet?.changeTab?.('attributes', 'primary', { updatePosition: false });
        } catch (_) { /* ignore */ }
      }
    },
    { action: 'cancel', label: L('SPACEHOLDER.Actions.Cancel'), icon: 'fa-solid fa-times' }
  ];

  await foundry.applications.api.DialogV2.wait({
    classes: ['spaceholder'],
    window: { title: L('SPACEHOLDER.Wearable.SelectAnatomy'), icon: 'fa-solid fa-list' },
    position: { width: 400 },
    content,
    buttons
  });
}

/**
 * Диалог редактирования слоёв брони для конкретной покрытой части тела.
 * Слои хранятся в `system.coveredParts[i].layers`.
 *
 * @param {Item} item
 * @param {string} partRef - slotRef части тела
 * @param {string} [partName]
 */
async function openWearableLayersDialog(item, partRef, partName) {
  if (!item || item.type !== 'item' || !partRef) return;
  if (!item.system?.itemTags?.isArmor) return;
  const coveredParts = Array.isArray(item.system?.coveredParts) ? item.system.coveredParts : [];
  const idx = coveredParts.findIndex((c) => {
    const ref = String(c?.slotRef ?? c?.partId ?? '').trim();
    return ref && ref === partRef;
  });
  if (idx < 0) return;

  const L = (key) => game.i18n.localize(key);
  const fmt = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    return String(Math.round(v * 100) / 100);
  };

  // working copy of layers; mutated only on save
  let workLayers = (Array.isArray(coveredParts[idx]?.layers) ? coveredParts[idx].layers : [])
    .map((l) => ensureLayerDefaults(l, materialsManager.getMaterial(l?.material)));

  const knownIds = new Set(materialsManager.listMaterialIds());
  for (const l of workLayers) {
    const id = String(l?.material ?? '').trim();
    if (id) knownIds.add(id);
  }
  const materialOptions = Array.from(knownIds).sort().map((id) => {
    const md = materialsManager.getMaterial(id);
    const localized = md.nameLocalized ? game.i18n?.localize?.(md.nameLocalized) : '';
    const label = (localized && localized !== md.nameLocalized) ? localized : (md.name || id);
    return { id, label };
  });
  if (!materialOptions.length) materialOptions.push({ id: '', label: '—' });

  const renderRows = () => {
    if (!workLayers.length) {
      return `<p class="hint"><em>${L('SPACEHOLDER.Wearable.Layers.Empty')}</em></p>`;
    }
    const rows = workLayers.map((layer, i) => {
      const opts = materialOptions
        .map((o) => `<option value="${o.id}" ${o.id === layer.material ? 'selected' : ''}>${foundry.utils.escapeHTML(o.label)}</option>`)
        .join('');
      return `
        <tr data-layer-index="${i}">
          <td>${i + 1}</td>
          <td><select data-layer-field="material" data-layer-index="${i}">${opts}</select></td>
          <td><input type="number" step="any" min="0" data-layer-field="thickness" data-layer-index="${i}" value="${fmt(layer.thickness)}" style="width:5em;"/></td>
          <td>
            <input type="number" step="any" min="0" data-layer-field="integrity" data-layer-index="${i}" value="${fmt(layer.integrity)}" style="width:5em;"/>
            <span class="sh-wearable-layer-max">/ ${fmt(layer.integrityMax)}</span>
          </td>
          <td>
            <input type="number" step="any" min="0" data-layer-field="breachLoss" data-layer-index="${i}" value="${fmt(layer.breachLoss)}" style="width:5em;"/>
            <span class="sh-wearable-layer-max">/ ${fmt(layer.breachCapacity)}</span>
          </td>
          <td><button type="button" class="icon-btn" data-action="sh-wearable-layer-remove" data-layer-index="${i}" title="${L('SPACEHOLDER.Actions.Delete')}"><i class="fas fa-trash"></i></button></td>
        </tr>`;
    }).join('');
    return `
      <table class="sh-wearable-layers-table">
        <thead><tr>
          <th>#</th>
          <th>${L('SPACEHOLDER.Wearable.Layers.Material')}</th>
          <th>${L('SPACEHOLDER.Wearable.Layers.Thickness')}</th>
          <th>${L('SPACEHOLDER.Wearable.Layers.Integrity')}</th>
          <th>${L('SPACEHOLDER.Wearable.Layers.BreachLoss')}</th>
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  };

  const dialogUid = `wlay-${foundry.utils.randomID(8)}`;

  const buildContent = () => `
    <div class="sh-wearable-layers" data-sh-wearable-layers-dialog="${dialogUid}" data-part-id="${foundry.utils.escapeHTML(partRef)}">
      <p><strong>${foundry.utils.escapeHTML(partName || partRef)}</strong></p>
      <div class="sh-wearable-layers-header" style="margin-bottom: 6px;">
        <button type="button" class="icon-btn" data-action="sh-wearable-layer-add" title="${L('SPACEHOLDER.Wearable.Layers.Add')}">
          <i class="fas fa-plus"></i> ${L('SPACEHOLDER.Wearable.Layers.Add')}
        </button>
      </div>
      <div data-layers-list>${renderRows()}</div>
    </div>`;

  const findRoot = () => (typeof document !== 'undefined'
    ? document.querySelector(`[data-sh-wearable-layers-dialog="${dialogUid}"]`)
    : null);

  const refresh = (root) => {
    const list = root?.querySelector('[data-layers-list]');
    if (!list) return;
    list.innerHTML = renderRows();
    bindRowControls(root);
  };

  const captureRowEdits = (root) => {
    if (!root) return;
    root.querySelectorAll('[data-layer-field]').forEach((el) => {
      const i = Number(el.dataset.layerIndex);
      if (!Number.isFinite(i) || !workLayers[i]) return;
      const field = el.dataset.layerField;
      if (field === 'material') {
        workLayers[i].material = String(el.value || '').trim();
      } else {
        const v = Number(el.value);
        workLayers[i][field] = Number.isFinite(v) && v >= 0 ? v : 0;
      }
    });
  };

  const bindRowControls = (root) => {
    if (!root) return;
    root.querySelectorAll('[data-action="sh-wearable-layer-remove"]').forEach((btn) => {
      if (btn.dataset.shBound) return;
      btn.dataset.shBound = '1';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        captureRowEdits(root);
        const i = Number(ev.currentTarget.dataset.layerIndex);
        if (!Number.isFinite(i)) return;
        workLayers.splice(i, 1);
        refresh(root);
      });
    });
    root.querySelectorAll('select[data-layer-field="material"]').forEach((sel) => {
      if (sel.dataset.shBound) return;
      sel.dataset.shBound = '1';
      sel.addEventListener('change', (ev) => {
        const i = Number(ev.currentTarget.dataset.layerIndex);
        if (!Number.isFinite(i) || !workLayers[i]) return;
        workLayers[i].material = String(ev.currentTarget.value || '').trim();
        const md = materialsManager.getMaterial(workLayers[i].material);
        workLayers[i] = ensureLayerDefaults({
          material: workLayers[i].material,
          thickness: workLayers[i].thickness
        }, md);
        refresh(root);
      });
    });
  };

  const bindAdd = (root) => {
    if (!root) return false;
    const addBtn = root.querySelector('[data-action="sh-wearable-layer-add"]');
    if (!addBtn || addBtn.dataset.shBound) return !!addBtn;
    addBtn.dataset.shBound = '1';
    addBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      captureRowEdits(root);
      const defaultMaterialId = materialsManager.listMaterialIds()[0] ?? '';
      const md = materialsManager.getMaterial(defaultMaterialId);
      workLayers.push(ensureLayerDefaults({ material: defaultMaterialId, thickness: 1 }, md));
      refresh(root);
    });
    return true;
  };

  // poll for the dialog DOM, then bind
  const bindTimer = globalThis.setInterval?.(() => {
    const root = findRoot();
    if (root && bindAdd(root)) {
      bindRowControls(root);
      globalThis.clearInterval?.(bindTimer);
    }
  }, 40);
  globalThis.setTimeout?.(() => globalThis.clearInterval?.(bindTimer), 2500);

  await foundry.applications.api.DialogV2.wait({
    classes: ['spaceholder'],
    window: { title: L('SPACEHOLDER.Wearable.Layers.Title'), icon: 'fa-solid fa-layer-group' },
    position: { width: 600 },
    content: buildContent(),
    buttons: [
      {
        action: 'save',
        label: L('SPACEHOLDER.Actions.Save'),
        icon: 'fa-solid fa-check',
        default: true,
        callback: async () => {
          const root = findRoot();
          captureRowEdits(root);
          const prev = Array.isArray(item.system?.coveredParts) ? item.system.coveredParts : [];
          const nextCoveredParts = foundry.utils.deepClone(prev);
          if (!nextCoveredParts[idx]) return;
          nextCoveredParts[idx].layers = workLayers.map((l) => ({
            material: l.material,
            thickness: l.thickness,
            integrity: l.integrity,
            integrityMax: l.integrityMax,
            breachLoss: l.breachLoss,
            breachCapacity: l.breachCapacity
          }));
          const keepAid = item.system?.anatomyId ?? null;
          await item.update({
            'system.coveredParts': nextCoveredParts,
            'system.anatomyId': keepAid
          });
        }
      },
      { action: 'cancel', label: L('SPACEHOLDER.Actions.Cancel'), icon: 'fa-solid fa-times' }
    ]
  });
  globalThis.clearInterval?.(bindTimer);
}

async function loadWearableReferenceAnatomy(preferredAnatomyId) {
  const requestedId = String(preferredAnatomyId ?? '').trim();
  const fallbackId = String(CONFIG?.SPACEHOLDER?.wearableCoverageReferenceAnatomyId ?? '').trim();
  const availableIds = Object.keys(anatomyManager.getAvailableAnatomies?.() ?? {});
  const candidateIds = [];
  if (requestedId) candidateIds.push(requestedId);
  if (fallbackId && !candidateIds.includes(fallbackId)) candidateIds.push(fallbackId);
  if (!candidateIds.length && availableIds.length) candidateIds.push(availableIds[0]);

  await anatomyManager.loadWorldPresets();
  for (const anatomyId of candidateIds) {
    if (!anatomyId) continue;
    try {
      if (anatomyManager.getAnatomyInfo(anatomyId)) {
        return await anatomyManager.loadAnatomy(anatomyId);
      }
      const preset = anatomyManager.getWorldPresets().find((p) => p.id === anatomyId);
      if (preset) return preset;
    } catch (_) { /* ignore */ }
  }
  return null;
}

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
  try {
    registerChargePersonalTimeHooks();
  } catch (e) {
    console.error('SpaceHolder | charge personal-time hooks failed', e);
  }

  // Migrate existing baked icons to match current SVG bake behavior.
  // (GM-only; best-effort; runs once per world)
  try {
    if (game?.user?.isGM) {
      setTimeout(() => {
        (async () => {
          try { await migrateIconLibraryGeneratedSvgsRemoveNonScalingStroke(); } catch (_) { /* ignore */ }
          try { await migrateIconLibraryGeneratedSvgsInsetBackgroundStroke(); } catch (_) { /* ignore */ }
        })();
      }, 0);
    }
  } catch (_) {
    // ignore
  }

  // Initialize anatomy manager
  try {
    await anatomyManager.initialize();
    console.log('SpaceHolder | Anatomy system initialized successfully');
  } catch (error) {
    console.error('SpaceHolder | Failed to initialize anatomy system:', error);
    ui.notifications.error('Failed to initialize anatomy system. Check console for details.');
  }

  // Initialize materials manager (compendium packs + world items)
  try {
    await materialsManager.initialize();
    const count = materialsManager.listMaterialIds().length;
    console.log(`SpaceHolder | Materials manager initialized (${count} entries).`);
    if (!count) {
      console.warn('SpaceHolder | Materials manager: no `material` items found in packs or world. '
        + 'Wearable layers and body tissue stacks will resolve to empty materials. '
        + 'Make sure the system compendium `sh-test-items` is installed.');
    }
  } catch (error) {
    console.error('SpaceHolder | Failed to initialize materials manager:', error);
  }
  const _scheduleMaterialsRefresh = (() => {
    let pending = false;
    return () => {
      if (pending) return;
      pending = true;
      setTimeout(async () => {
        pending = false;
        try { await materialsManager.initialize(); } catch (e) { console.error(e); }
      }, 100);
    };
  })();
  for (const event of ['createItem', 'updateItem', 'deleteItem']) {
    Hooks.on(event, (doc) => {
      if (doc?.type === 'material') _scheduleMaterialsRefresh();
    });
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
  // item-piles-sh: primary item drop-on-canvas path for SpaceHolder
  initializeItemPilesSh();

  installTransactionLedgerHooks();
  installActionChatJournalHooks();
  (async () => {
    for (const a of game.actors ?? []) {
      if (a?.type !== "character") continue;
      try {
        await ensureCharacterApSynced(a);
      } catch (_) {
        /* ignore */
      }
    }
  })();
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

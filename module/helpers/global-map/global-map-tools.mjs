import { GlobalMapBiomeEditorApp } from './global-map-biome-editor-app.mjs';

const _t = (key) => {
  try {
    return game?.i18n?.localize?.(key) ?? key;
  } catch (e) {
    return key;
  }
};

const _f = (key, data = {}) => {
  try {
    return game?.i18n?.format?.(key, data) ?? key;
  } catch (e) {
    return key;
  }
};

/**
 * Global Map Tools
 * Editing and manipulation tools for unified grid
 * Handles user interactions like brush editing, flattening, smoothing
 */
export class GlobalMapTools {
  constructor(renderer, processing) {
    this.renderer = renderer;
    this.processing = processing;
    this.isActive = false;
    this.currentTool = 'set-biome'; // 'set-biome', 'raise', 'lower', 'smooth', 'roughen', 'flatten', 'river-draw', 'river-edit', 'region-draw', 'region-edit'

    // UI selection (per tab). We use buttons instead of selects, so keep explicit state.
    this._selectedHeightsTool = 'raise';
    this._selectedBiomesTool = 'set-biome';
    this._selectedRiversTool = 'river-draw';
    this._selectedRegionsTool = 'region-draw';

    this.brushRadius = 100;
    this.brushStrength = 0.5;
    this.singleCellMode = false; // If true, brush affects only one cell
    this.savedSingleCellMode = false; // Save state when switching to rivers tool
    this.targetHeight = 50;

    // ===== Vector Rivers (new system) =====
    // Stored separately in scene flags: scene.flags.spaceholder.globalMapRivers
    this.vectorRivers = null; // {version:1, settings:{labelMode,snapToEndpoints}, rivers:[...]}
    this.vectorRiversDirty = false;
    this.selectedRiverId = null;
    this.selectedRiverPointIndex = null;
    this.riverDefaultPointWidth = 24;
    this.riverHandles = null; // PIXI.Graphics overlay for point handles
    this._riverDrag = null; // {riverId, pointIndex}

    // ===== Vector Regions (new system) =====
    // Stored separately in scene flags: scene.flags.spaceholder.globalMapRegions
    this.vectorRegions = null; // {version:1, settings:{labelMode,clickAction,clickModifier}, regions:[...]}
    this.vectorRegionsDirty = false;
    this.selectedRegionId = null;
    this.selectedRegionPointIndex = null;
    this.regionHandles = null; // PIXI.Graphics overlay for point handles
    this._regionDrag = null; // {regionId, pointIndex}

    // Default style for newly created regions
    this.regionDefaultFillColor = 0x2E7DFF;
    this.regionDefaultFillAlpha = 0.18;
    this.regionDefaultStrokeColor = 0x2E7DFF;
    this.regionDefaultStrokeAlpha = 0.9;
    this.regionDefaultStrokeWidth = 3;

    // Biome tools settings (biomes are explicit IDs ordered by renderRank)
    this.setBiomeId = this.processing?.biomeResolver?.getDefaultBiomeId?.() ?? 17;
    
    this.globalSmoothStrength = 1.0; // Strength for global smooth (0.1-1.0)
    
    // Brush filters - for Height tools (raise, lower, etc.)
    this.heightFilterEnabled = false; // Enable filtering in height tools
    this.heightFilterMin = 0; // Filter: min height (0-100)
    this.heightFilterMax = 100; // Filter: max height (0-100)
    this.heightFilterByBiomeEnabled = false; // Filter height tools by specific biomes
    this.heightFilterBiomeIds = new Set(); // Biome IDs to affect when editing heights
    
    // Brush filters - for Biome tools (set-biome)
    this.biomeFilterEnabled = false; // Enable filtering in biome tools
    this.biomeFilterHeightMin = 0; // Filter: min height (0-100)
    this.biomeFilterHeightMax = 100; // Filter: max height (0-100)
    this.biomeFilterByBiomeEnabled = false; // Filter biome tools by specific biomes
    this.biomeFilterExcludedIds = new Set(); // Biome IDs to exclude when editing biomes
    
    // Replace tool settings
    this.replaceSourceBiomeIds = new Set(); // Source biomes for replacement (multiple)
    this.replaceTargetBiomeId = null; // Target biome for replacement
    
    // Brush state
    this.isBrushActive = false; // Whether brush is currently active and ready to paint
    
    // Mouse state
    this.isMouseDown = false;
    this.lastPosition = null;
    this.tempOverlay = null; // Temporary delta layer for current stroke
    this.affectedCells = null; // Track which cells were affected by current stroke

    // UI elements
    this.brushCursor = null;
    this.brushPreview = null;
    this.overlayPreview = null; // Overlay showing affected cells
    this.cellHighlight = null; // Highlight for single cell mode
    this.inspectLabel = null;

    // Cell inspector
    this.isCellInspectorActive = false;
    this.cellInspectorHandler = null;

    // ===== Event lifecycle (important to avoid handler accumulation) =====
    this._stageListenersActive = false;
    this._stageForListeners = null; // canvas.stage instance we installed listeners on
    this._onStagePointerDown = null;
    this._onStagePointerMove = null;
    this._onStagePointerUp = null;

    // Namespace for document-level UI handlers (drag)
    this._uiDocNamespace = '.globalMapToolsUI';

    // ===== Undo/Redo (grid edits) =====
    this._undoStack = []; // stack of snapshots
    this._redoStack = []; // stack of snapshots
    this._undoMax = 20;
    this._strokeHasChanges = false;

    // Scene/canvas lifecycle
    this._activeSceneId = null;
    this._canvasHookInstalled = false;
    this._onCanvasReadyHook = null;

    // ===== Brush interaction shield =====
    // When brush is active, we must prevent TokenLayer interactions (drag/select) to avoid accidental token moves.
    // Edge-UI can enable edit mode without switching scene controls, so we do it here.
    this._controlsBeforeBrush = null; // {control:string|null, tool:string|null}
    this._tokenLayerStateBeforeBrush = null; // {eventMode?:any, interactiveChildren?:any, interactive?:any}

    // Install canvas hooks once
    this._installCanvasHooks();
  }

  /**
   * Activate editing tools
   */
  activate() {
    if (this.isActive) return;

    console.log('GlobalMapTools | Activating...');
    this.isActive = true;

    // New editing session: reset undo/redo history
    this._undoStack = [];
    this._redoStack = [];

    // Remember which scene we started editing on (scene changes should cancel editing)
    this._activeSceneId = canvas?.scene?.id || null;

    // Show renderer if not visible
    if (!this.renderer.isVisible) {
      this.renderer.show();
    }

    // Set up event listeners
    this.setupEventListeners();

    // Create UI elements
    this.createBrushCursor();
    this.createOverlayPreview();
    this.showToolsUI();

    console.log('GlobalMapTools | ✓ Activated');
  }

  /**
   * Deactivate editing tools
   */
  async deactivate() {
    if (!this.isActive) return;

    console.log('GlobalMapTools | Deactivating...');

    // Mark inactive first so any late events are ignored
    this.isActive = false;

    // IMPORTANT: Remove stage listeners to avoid handler accumulation across activate/deactivate cycles
    this._removeStageEventListeners();

    // Stop brush and cancel any in-progress stroke (discard by default)
    if (this.isBrushActive) {
      this.deactivateBrush();
    }

    this.isMouseDown = false;
    this.lastPosition = null;
    this.tempOverlay = null;
    this.affectedCells = null;
    this._strokeHasChanges = false;

    this.clearOverlayPreview();
    this.clearCellHighlight();

    // Release undo/redo memory on exit
    this._undoStack = [];
    this._redoStack = [];
    this._activeSceneId = null;

    // Destroy UI elements
    this.destroyBrushCursor();
    this.destroyOverlayPreview();

    // River editor overlay
    this._riverDrag = null;
    if (this.riverHandles) {
      try {
        this.riverHandles.destroy();
      } catch (e) {
        // ignore
      }
      this.riverHandles = null;
    }

    // Region editor overlay
    this._regionDrag = null;
    if (this.regionHandles) {
      try {
        this.regionHandles.destroy();
      } catch (e) {
        // ignore
      }
      this.regionHandles = null;
    }

    this.hideToolsUI();

    console.log('GlobalMapTools | ✓ Deactivated');
  }

  // ==========================
  // Brush interaction shield
  // ==========================

  _getSceneControlsState() {
    try {
      const sc = ui?.controls;
      if (!sc) return null;

      const controlName = sc?.control?.name ?? sc?.activeControl ?? sc?._control ?? sc?._activeControl ?? null;
      const toolName = sc?.control?.activeTool ?? sc?.activeTool ?? sc?.tool ?? sc?._tool ?? null;

      return {
        control: controlName ? String(controlName) : null,
        tool: toolName ? String(toolName) : null,
      };
    } catch (e) {
      return null;
    }
  }

  _activateSceneControls(control, tool = null) {
    const sc = ui?.controls;
    if (!sc || typeof sc.activate !== 'function') return false;

    try {
      sc.activate({ control, tool });
      return true;
    } catch (e) {
      return false;
    }
  }

  _enterBrushInteractionShield() {
    // Remember current scene controls so we can restore them after brush mode.
    if (!this._controlsBeforeBrush) {
      this._controlsBeforeBrush = this._getSceneControlsState() || { control: 'tokens', tool: 'select' };
    }

    // Try to activate our "stub" tool (so Tokens layer won't capture pointer actions).
    // If it fails, we still fall back to explicit TokenLayer shielding below.
    this._activateSceneControls('globalmap', 'inspect-map');

    // Explicitly disable TokenLayer interactions while brush is active.
    const tokenLayer = canvas?.tokens;
    if (!tokenLayer) return;

    if (!this._tokenLayerStateBeforeBrush) {
      const snap = {};
      try {
        if ('eventMode' in tokenLayer) snap.eventMode = tokenLayer.eventMode;
      } catch (e) {
        // ignore
      }
      try {
        if ('interactiveChildren' in tokenLayer) snap.interactiveChildren = tokenLayer.interactiveChildren;
      } catch (e) {
        // ignore
      }
      try {
        if ('interactive' in tokenLayer) snap.interactive = tokenLayer.interactive;
      } catch (e) {
        // ignore
      }

      this._tokenLayerStateBeforeBrush = snap;
    }

    try {
      if ('interactiveChildren' in tokenLayer) tokenLayer.interactiveChildren = false;
    } catch (e) {
      // ignore
    }
    try {
      if ('interactive' in tokenLayer) tokenLayer.interactive = false;
    } catch (e) {
      // ignore
    }
    try {
      if ('eventMode' in tokenLayer) tokenLayer.eventMode = 'none';
    } catch (e) {
      // ignore
    }
  }

  _exitBrushInteractionShield() {
    // Restore previous controls first (may reactivate TokenLayer).
    const prev = this._controlsBeforeBrush;
    this._controlsBeforeBrush = null;

    if (prev?.control) {
      const ok = this._activateSceneControls(prev.control, prev.tool ?? null);
      if (!ok && (prev.control === 'tokens' || prev.control === 'token')) {
        this._activateSceneControls('tokens', 'select');
      }
    }

    // Restore TokenLayer interactivity.
    const snap = this._tokenLayerStateBeforeBrush;
    this._tokenLayerStateBeforeBrush = null;

    const tokenLayer = canvas?.tokens;
    if (!tokenLayer || !snap || typeof snap !== 'object') return;

    try {
      if ('interactiveChildren' in snap && 'interactiveChildren' in tokenLayer) tokenLayer.interactiveChildren = snap.interactiveChildren;
    } catch (e) {
      // ignore
    }
    try {
      if ('interactive' in snap && 'interactive' in tokenLayer) tokenLayer.interactive = snap.interactive;
    } catch (e) {
      // ignore
    }
    try {
      if ('eventMode' in snap && 'eventMode' in tokenLayer) tokenLayer.eventMode = snap.eventMode;
    } catch (e) {
      // ignore
    }
  }

  /**
   * Activate brush for painting
   */
  activateBrush() {
    if (this.isBrushActive) return;
    
    // Sync currentTool with selected tool from active tab
    if ($('#brush-tab').is(':visible')) {
      // Heights tab is active
      const selectedTool = this._selectedHeightsTool || 'raise';
      this.setTool(selectedTool);
      // Read single cell mode from checkbox
      this.singleCellMode = $('#single-cell-mode').prop('checked');
    } else if ($('#biomes-tab').is(':visible')) {
      // Biomes tab is active
      const selectedTool = this._selectedBiomesTool || 'set-biome';
      this.setTool(selectedTool);
      // Read single cell mode from checkbox
      this.singleCellMode = $('#biome-single-cell-mode').prop('checked');
    } else if ($('#regions-tab').is(':visible')) {
      // Regions tab is active (vector regions editor)
      const selectedTool = this._selectedRegionsTool || 'region-draw';
      this.setTool(selectedTool);

      // Region editor doesn't use grid-cell highlighting/cursor
      this.singleCellMode = false;

      // Ensure we have regions data in memory
      this._ensureVectorRegionsInitialized();

      // Ensure handle overlay exists
      this._ensureRegionHandles();
    } else if ($('#rivers-tab').is(':visible')) {
      // Rivers tab is active (vector rivers editor)
      const selectedTool = this._selectedRiversTool || 'river-draw';
      this.setTool(selectedTool);

      // River editor doesn't use grid-cell highlighting/cursor
      this.singleCellMode = false;

      // Ensure we have rivers data in memory
      this._ensureVectorRiversInitialized();

      // Ensure handle overlay exists
      this._ensureRiverHandles();
    }
    
    // Create cell highlight after setting mode
    if (this.singleCellMode) {
      this.createCellHighlight();
    }
    
    this.isBrushActive = true;

    // While brush is active, prevent TokenLayer interactions (drag/select) and switch to stub tool.
    this._enterBrushInteractionShield();

    this.updateBrushUI();
    console.log(`GlobalMapTools | Brush activated: ${this.currentTool} (singleCell: ${this.singleCellMode})`);
  }
  
  /**
   * Deactivate brush
   */
  deactivateBrush() {
    if (!this.isBrushActive) return;

    // Stop any active stroke/drag immediately (discard overlay by default)
    this.isMouseDown = false;
    this.lastPosition = null;
    this.tempOverlay = null;
    this.affectedCells = null;
    this._strokeHasChanges = false;

    this.isBrushActive = false;
    this._riverDrag = null;
    this._regionDrag = null;

    // Restore scene controls + TokenLayer interactivity after brush mode.
    this._exitBrushInteractionShield();

    this.clearOverlayPreview();
    this.clearCellHighlight();

    if (this.riverHandles) {
      try {
        this.riverHandles.clear();
        this.riverHandles.visible = false;
      } catch (e) {
        this.riverHandles = null;
      }
    }

    if (this.regionHandles) {
      try {
        this.regionHandles.clear();
        this.regionHandles.visible = false;
      } catch (e) {
        this.regionHandles = null;
      }
    }

    this.updateBrushUI();
    console.log('GlobalMapTools | Brush deactivated');
  }
  
  /**
   * Set current tool
   */
  setTool(tool) {
    const validTools = [
      'raise', 'lower', 'smooth', 'roughen', 'flatten',
      'set-biome',
      'river-draw', 'river-edit',
      'region-draw', 'region-edit'
    ];
    if (validTools.includes(tool)) {
      this.currentTool = tool;
      this.updateBrushCursorGraphics();
      // Clear overlay preview when switching tools
      this.clearOverlayPreview();
      console.log(`GlobalMapTools | Tool changed to: ${tool}`);
    }
  }

  /**
   * Set brush parameters
   */
  setBrushParams(radius = null, strength = null, targetHeight = null, targetTemperature = null, targetMoisture = null) {
    if (radius !== null) this.brushRadius = radius;
    if (strength !== null) this.brushStrength = strength;
    if (targetHeight !== null) this.targetHeight = targetHeight;
    if (targetTemperature !== null) this.targetTemperature = Math.max(1, Math.min(5, targetTemperature));
    if (targetMoisture !== null) this.targetMoisture = Math.max(1, Math.min(6, targetMoisture));
    this.updateBrushCursorGraphics();
  }

  // ==========================
  // Vector Rivers editor
  // ==========================

  _isRiverTool() {
    return this.currentTool === 'river-draw' || this.currentTool === 'river-edit';
  }

  _isRegionTool() {
    return this.currentTool === 'region-draw' || this.currentTool === 'region-edit';
  }

  _escapeHtml(text) {
    const s = String(text ?? '');
    try {
      if (foundry?.utils?.escapeHTML) return foundry.utils.escapeHTML(s);
    } catch (e) {
      // ignore
    }
    return s
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('\"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  _intToCssHex(colorInt) {
    const v = Number(colorInt);
    if (!Number.isFinite(v)) return '#000000';
    return `#${(v & 0xFFFFFF).toString(16).padStart(6, '0')}`;
  }

  _cssHexToInt(value, fallback = 0) {
    const s0 = String(value ?? '').trim();
    if (!s0) return fallback;

    let s = s0;
    if (s.startsWith('#')) s = s.slice(1);
    if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);
    s = s.replace(/[^0-9a-fA-F]/g, '');

    if (s.length === 3) {
      s = s.split('').map(ch => ch + ch).join('');
    }
    if (s.length !== 6) return fallback;

    const n = parseInt(s, 16);
    if (!Number.isFinite(n)) return fallback;
    return n & 0xFFFFFF;
  }

  _normalizeUuid(raw) {
    const str = String(raw ?? '').trim();
    if (!str) return '';
    const match = str.match(/@UUID\[(.+?)\]/);
    return (match?.[1] ?? str).trim();
  }

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

  async _openJournalUuid(rawUuid) {
    const uuid = this._normalizeUuid(rawUuid);
    if (!uuid) return false;

    let doc = null;
    try {
      doc = await fromUuid(uuid);
    } catch (e) {
      doc = null;
    }

    if (!doc) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.DocNotFoundByUuid'));
      return false;
    }

    if (doc.documentName === 'JournalEntryPage' && doc.parent?.sheet?.render) {
      doc.parent.sheet.render(true);
      return true;
    }

    if (doc.documentName === 'JournalEntry' && doc.sheet?.render) {
      doc.sheet.render(true);
      return true;
    }

    ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.ExpectedJournalDoc'));
    return false;
  }

  /**
   * Confirm wrapper for Foundry v13:
   * - prefer DialogV2.confirm
   * - fallback to Dialog.confirm
   * @private
   */
  async _confirmDialog({ title, content, yesLabel, yesIcon, noLabel, noIcon } = {}) {
    const safeTitle = String(title ?? '');
    const safeContent = String(content ?? '');

    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (DialogV2?.confirm) {
      try {
        return await new Promise((resolve) => {
          let settled = false;
          const settle = (v) => {
            if (settled) return;
            settled = true;
            resolve(!!v);
          };

          const maybePromise = DialogV2.confirm({
            window: { title: safeTitle, icon: yesIcon || 'fa-solid fa-question' },
            content: safeContent,
            yes: {
              label: yesLabel ?? _t('DIALOG.Yes'),
              icon: yesIcon ?? 'fa-solid fa-check',
              callback: () => {
                settle(true);
                return true;
              },
            },
            no: {
              label: noLabel ?? _t('DIALOG.No'),
              icon: noIcon ?? 'fa-solid fa-times',
              callback: () => {
                settle(false);
                return false;
              },
            },
          });

          // On some versions confirm() may also resolve a Promise<boolean>
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then((r) => settle(r)).catch(() => settle(false));
          }
        });
      } catch (e) {
        // ignore and fallback
      }
    }

    const DialogImpl = globalThis.Dialog;
    if (typeof DialogImpl?.confirm === 'function') {
      try {
        return await DialogImpl.confirm({
          title: safeTitle,
          content: safeContent,
          yes: () => true,
          no: () => false,
          defaultYes: false,
        });
      } catch (e) {
        // ignore
      }
    }

    // Last resort: native confirm (no HTML content)
    return globalThis.confirm?.(safeTitle) ?? false;
  }

  /**
   * Prompt wrapper for Foundry v13:
   * - prefer DialogV2.wait
   * - fallback to Dialog
   * @private
   */
  async _promptDialog({ title, label, initialValue = '', okLabel, okIcon, cancelLabel, cancelIcon } = {}) {
    const safeTitle = String(title ?? '');
    const safeLabel = String(label ?? '');
    const safeValueRaw = String(initialValue ?? '');
    const safeValue = this._escapeHtml(safeValueRaw);

    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (DialogV2?.wait) {
      try {
        return await new Promise((resolve) => {
          let settled = false;
          const settle = (v) => {
            if (settled) return;
            settled = true;
            resolve(typeof v === 'string' ? v : null);
          };

          const inputId = 'spaceholder-globalmap-tools-prompt-input';
          const content = `<form><div class="form-group"><label>${this._escapeHtml(safeLabel)}</label><input type="text" id="${inputId}" name="value" value="${safeValue}"/></div></form>`;

          const maybePromise = DialogV2.wait({
            window: { title: safeTitle, icon: okIcon || 'fa-solid fa-pen-to-square' },
            position: { width: 420 },
            content,
            buttons: [
              {
                action: 'ok',
                label: okLabel ?? _t('SPACEHOLDER.Actions.Apply'),
                icon: okIcon ?? 'fa-solid fa-check',
                default: true,
                callback: (event) => {
                  try {
                    const root = event?.currentTarget;
                    const input = root?.querySelector?.(`#${inputId}`) ?? document.getElementById(inputId);
                    const v = input?.value;
                    settle(typeof v === 'string' ? v : '');
                  } catch (e) {
                    settle(safeValueRaw);
                  }
                },
              },
              {
                action: 'cancel',
                label: cancelLabel ?? _t('SPACEHOLDER.Actions.Cancel'),
                icon: cancelIcon ?? 'fa-solid fa-times',
                callback: () => settle(null),
              },
            ],
          });

          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then(() => { if (!settled) settle(null); }).catch(() => { if (!settled) settle(null); });
          }
        });
      } catch (e) {
        // ignore and fallback
      }
    }

    // Fallback: Dialog (v1)
    try {
      const DialogImpl = globalThis.Dialog;
      if (DialogImpl) {
        return await new Promise((resolve) => {
          new DialogImpl({
            title: safeTitle,
            content: `<form><div class="form-group"><label>${this._escapeHtml(safeLabel)}</label><input type="text" name="value" value="${safeValue}"/></div></form>`,
            buttons: {
              ok: {
                label: okLabel ?? _t('SPACEHOLDER.Actions.Apply'),
                callback: (html) => {
                  const v = html.find('input[name="value"]').val();
                  resolve(typeof v === 'string' ? v : String(v ?? ''));
                },
              },
              cancel: {
                label: cancelLabel ?? _t('SPACEHOLDER.Actions.Cancel'),
                callback: () => resolve(null),
              },
            },
            default: 'ok',
            close: () => resolve(null),
          }).render(true);
        });
      }
    } catch (e) {
      // ignore
    }

    const v = globalThis.prompt?.(safeTitle, safeValueRaw);
    return typeof v === 'string' ? v : null;
  }

  _applyVectorRiversToRenderer() {
    if (!this.renderer?.setVectorRiversData) return;

    this.renderer.setVectorRiversData(this.vectorRivers);

    // renderer normalizes and may replace object references
    this.vectorRivers = this.renderer.vectorRiversData;
  }

  _ensureVectorRiversInitialized() {
    if (this.vectorRivers) return this.vectorRivers;

    const scene = canvas?.scene;
    let raw = null;
    try {
      raw = scene?.getFlag?.('spaceholder', 'globalMapRivers');
    } catch (e) {
      raw = null;
    }

    // Default structure (in case renderer is not available)
    this.vectorRivers = {
      version: 1,
      settings: {
        labelMode: 'hover',
        snapToEndpoints: true,
      },
      rivers: [],
    };

    // Prefer renderer's normalization (single source of truth)
    if (this.renderer?.setVectorRiversData) {
      this.renderer.setVectorRiversData(raw);
      this.vectorRivers = this.renderer.vectorRiversData;
    } else if (raw && typeof raw === 'object') {
      this.vectorRivers = raw;
    }

    if (!this.vectorRivers || typeof this.vectorRivers !== 'object') {
      this.vectorRivers = {
        version: 1,
        settings: {
          labelMode: 'hover',
          snapToEndpoints: true,
        },
        rivers: [],
      };
    }

    if (!this.vectorRivers.settings || typeof this.vectorRivers.settings !== 'object') {
      this.vectorRivers.settings = { labelMode: 'hover', snapToEndpoints: true };
    }

    if (!['off', 'hover', 'always'].includes(this.vectorRivers.settings.labelMode)) {
      this.vectorRivers.settings.labelMode = 'hover';
    }

    if (this.vectorRivers.settings.snapToEndpoints === undefined) {
      this.vectorRivers.settings.snapToEndpoints = true;
    }
    this.vectorRivers.settings.snapToEndpoints = !!this.vectorRivers.settings.snapToEndpoints;

    if (!Array.isArray(this.vectorRivers.rivers)) {
      this.vectorRivers.rivers = [];
    }

    // Default selection
    if (!this.selectedRiverId && this.vectorRivers.rivers.length) {
      this.selectedRiverId = String(this.vectorRivers.rivers[0].id);
    }

    return this.vectorRivers;
  }

  _ensureRiverHandles() {
    const desiredParent = canvas?.interface || canvas?.stage;

    if (this.riverHandles) {
      // River handles can get destroyed or detached when the canvas/interface is rebuilt.
      // Try to reattach and ensure it's still usable; if that fails, recreate.
      try {
        if (desiredParent && this.riverHandles.parent !== desiredParent) {
          this.riverHandles.parent?.removeChild?.(this.riverHandles);
          desiredParent.addChild(this.riverHandles);
        }

        // Ensure it's still usable (Graphics can become a dead ref after destroy)
        this.riverHandles.clear();
        return;
      } catch (e) {
        try {
          this.riverHandles.destroy();
        } catch (err) {
          // ignore
        }
        this.riverHandles = null;
      }
    }

    this.riverHandles = new PIXI.Graphics();
    this.riverHandles.name = 'globalMapRiverHandles';
    this.riverHandles.visible = false;

    // Put handles on interface layer so they don't get baked into exports
    if (desiredParent) {
      desiredParent.addChild(this.riverHandles);
    }
  }

  _renderRiverHandles() {
    this._ensureRiverHandles();
    if (!this.riverHandles) return;

    try {
      this.riverHandles.clear();
    } catch (e) {
      // Recreate handles if they were destroyed by a canvas rebuild
      this.riverHandles = null;
      this._ensureRiverHandles();
      if (!this.riverHandles) return;
      this.riverHandles.clear();
    }

    const shouldShow = this.isBrushActive && this._isRiverTool();
    this.riverHandles.visible = shouldShow;
    if (!shouldShow) return;

    this._ensureVectorRiversInitialized();

    const rivers = Array.isArray(this.vectorRivers?.rivers) ? this.vectorRivers.rivers : [];
    for (const river of rivers) {
      const pts = Array.isArray(river?.points) ? river.points : [];
      const isSelectedRiver = river?.id === this.selectedRiverId;

      // Draw polyline
      if (pts.length >= 2) {
        this.riverHandles.lineStyle(2, isSelectedRiver ? 0xffffff : 0xaaaaaa, isSelectedRiver ? 0.7 : 0.4);
        this.riverHandles.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          this.riverHandles.lineTo(pts[i].x, pts[i].y);
        }
      }

      // Draw points
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!p) continue;

        const isSelectedPoint = isSelectedRiver && i === this.selectedRiverPointIndex;
        const isEndpoint = i === 0 || i === pts.length - 1;

        const radius = isSelectedPoint ? 7 : (isEndpoint ? 6 : 4);
        const color = isSelectedPoint ? 0xffff00 : (isSelectedRiver ? 0xffffff : 0x888888);
        const alpha = isSelectedRiver ? 0.95 : 0.6;

        this.riverHandles.lineStyle(2, 0x000000, alpha);
        this.riverHandles.beginFill(color, alpha);
        this.riverHandles.drawCircle(p.x, p.y, radius);
        this.riverHandles.endFill();
      }
    }
  }

  _refreshRiversUI() {
    if (!$('#global-map-tools-ui').length) return;

    this._ensureVectorRiversInitialized();

    const rivers = Array.isArray(this.vectorRivers?.rivers) ? this.vectorRivers.rivers : [];
    const select = $('#global-map-river-select');

    // Preserve selection when possible
    const existing = String(this.selectedRiverId || '');
    select.empty();

    if (rivers.length === 0) {
      select.append($('<option></option>').attr('value', '').text(_t('SPACEHOLDER.GlobalMap.Tools.Rivers.None')));
      this.selectedRiverId = null;
    } else {
      for (const r of rivers) {
        const id = String(r.id);
        const name = String(r.name || id);
        select.append($('<option></option>').attr('value', id).text(name));
      }

      if (existing && rivers.some(r => String(r.id) === existing)) {
        select.val(existing);
        this.selectedRiverId = existing;
      } else {
        this.selectedRiverId = String(rivers[0].id);
        select.val(this.selectedRiverId);
      }
    }

    // Settings controls
    $('#river-label-mode').val(this.vectorRivers.settings?.labelMode || 'hover');
    $('#river-snap-endpoints').prop('checked', !!this.vectorRivers.settings?.snapToEndpoints);

    // Selected point width
    const river = this._getSelectedRiver();
    const point = (river && this.selectedRiverPointIndex !== null && this.selectedRiverPointIndex !== undefined)
      ? river.points?.[this.selectedRiverPointIndex]
      : null;

    if (point) {
      const w = Math.max(1, Number(point.width) || 1);
      $('#river-point-width').prop('disabled', false).val(String(Math.round(w)));
      $('#river-point-width-value').text(String(Math.round(w)));
    } else {
      $('#river-point-width').prop('disabled', true);
      $('#river-point-width-value').text('-');
    }

    // Buttons enabled/disabled
    const hasRiver = !!river;
    $('#river-delete').prop('disabled', !hasRiver);
    $('#river-rename').prop('disabled', !hasRiver);

    // Save indicator
    {
      const saveLabel = _t('SPACEHOLDER.GlobalMap.Tools.Rivers.Save');
      $('#river-save').text(this.vectorRiversDirty ? `${saveLabel}*` : saveLabel);
    }
  }

  _onRiversTabShown() {
    this._ensureVectorRiversInitialized();
    this._applyVectorRiversToRenderer();
    this._refreshRiversUI();
    this._renderRiverHandles();
  }

  _getSelectedRiver() {
    this._ensureVectorRiversInitialized();

    const rivers = Array.isArray(this.vectorRivers?.rivers) ? this.vectorRivers.rivers : [];
    if (!this.selectedRiverId) return null;

    return rivers.find(r => String(r.id) === String(this.selectedRiverId)) || null;
  }

  _makeRiverId() {
    try {
      if (foundry?.utils?.randomID) return foundry.utils.randomID();
    } catch (e) {
      // ignore
    }
    return `river_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  async createNewRiver() {
    this._ensureVectorRiversInitialized();

    const id = this._makeRiverId();
    const n = (this.vectorRivers.rivers?.length || 0) + 1;
    const river = { id, name: _f('SPACEHOLDER.GlobalMap.Tools.Rivers.DefaultName', { n }), points: [] };

    this.vectorRivers.rivers.push(river);
    this.selectedRiverId = id;
    this.selectedRiverPointIndex = null;
    this.vectorRiversDirty = true;

    this._applyVectorRiversToRenderer();
  }

  async deleteSelectedRiver() {
    const river = this._getSelectedRiver();
    if (!river) return;

    const ok = await this._confirmDialog({
      title: _t('SPACEHOLDER.GlobalMap.Tools.Rivers.Confirm.DeleteTitle'),
      content: _f('SPACEHOLDER.GlobalMap.Tools.Rivers.Confirm.DeleteContent', {
        name: this._escapeHtml(river.name),
      }),
      yesLabel: _t('SPACEHOLDER.Actions.Delete'),
      yesIcon: 'fa-solid fa-trash',
      noLabel: _t('SPACEHOLDER.Actions.Cancel'),
      noIcon: 'fa-solid fa-times',
    });
    if (!ok) return;

    this._ensureVectorRiversInitialized();
    const rivers = this.vectorRivers.rivers;
    const idx = rivers.findIndex(r => String(r.id) === String(river.id));
    if (idx >= 0) {
      rivers.splice(idx, 1);
    }

    // Update selection
    if (rivers.length === 0) {
      this.selectedRiverId = null;
      this.selectedRiverPointIndex = null;
    } else {
      const next = rivers[Math.min(idx, rivers.length - 1)];
      this.selectedRiverId = String(next.id);
      this.selectedRiverPointIndex = null;
    }

    this.vectorRiversDirty = true;
    this._applyVectorRiversToRenderer();
  }

  async renameSelectedRiver() {
    const river = this._getSelectedRiver();
    if (!river) return;

    const currentName = String(river.name || '');
    const newNameRaw = await this._promptDialog({
      title: _t('SPACEHOLDER.GlobalMap.Tools.Rivers.Prompt.RenameTitle'),
      label: _t('SPACEHOLDER.Placeholder.Name'),
      initialValue: currentName,
    });

    if (typeof newNameRaw !== 'string') return;
    const newName = newNameRaw.trim();
    if (!newName) return;

    river.name = newName;
    this.vectorRiversDirty = true;
    this._applyVectorRiversToRenderer();
  }

  async saveVectorRivers() {
    this._ensureVectorRiversInitialized();

    const scene = canvas?.scene;
    if (!scene?.setFlag) return;

    try {
      await scene.setFlag('spaceholder', 'globalMapRivers', this.vectorRivers);
      this.vectorRiversDirty = false;
      ui.notifications?.info?.(_t('SPACEHOLDER.GlobalMap.Tools.Notifications.RiversSaved'));
      console.log('GlobalMapTools | ✓ Rivers saved to scene');
    } catch (error) {
      console.error('GlobalMapTools | Failed to save rivers:', error);
      ui.notifications?.error?.(_f('SPACEHOLDER.GlobalMap.Tools.Errors.SaveRiversFailed', { message: error.message }));
    }
  }

  _findNearestRiverPoint(x, y, maxDist = 12) {
    this._ensureVectorRiversInitialized();

    const rivers = Array.isArray(this.vectorRivers?.rivers) ? this.vectorRivers.rivers : [];
    const maxDistSq = maxDist * maxDist;

    // Prefer selected river if any
    const ordered = [];
    const sel = this._getSelectedRiver();
    if (sel) ordered.push(sel);
    for (const r of rivers) {
      if (sel && String(r.id) === String(sel.id)) continue;
      ordered.push(r);
    }

    let best = null;
    let bestDistSq = maxDistSq;

    for (const river of ordered) {
      const pts = Array.isArray(river?.points) ? river.points : [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!p) continue;
        const dx = p.x - x;
        const dy = p.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestDistSq) {
          bestDistSq = d2;
          best = { riverId: String(river.id), pointIndex: i, distSq: d2 };
        }
      }
    }

    return best;
  }

  _closestPointOnSegment(x, y, ax, ay, bx, by) {
    const abx = bx - ax;
    const aby = by - ay;
    const apx = x - ax;
    const apy = y - ay;

    const abLenSq = abx * abx + aby * aby;
    if (abLenSq <= 1e-6) {
      const dx = x - ax;
      const dy = y - ay;
      return { t: 0, x: ax, y: ay, distSq: dx * dx + dy * dy };
    }

    let t = (apx * abx + apy * aby) / abLenSq;
    t = Math.max(0, Math.min(1, t));

    const cx = ax + abx * t;
    const cy = ay + aby * t;

    const dx = x - cx;
    const dy = y - cy;

    return { t, x: cx, y: cy, distSq: dx * dx + dy * dy };
  }

  _findNearestRiverSegment(x, y, maxDist = 20) {
    this._ensureVectorRiversInitialized();

    const rivers = Array.isArray(this.vectorRivers?.rivers) ? this.vectorRivers.rivers : [];
    const maxDistSq = maxDist * maxDist;

    // Prefer selected river first
    const ordered = [];
    const sel = this._getSelectedRiver();
    if (sel) ordered.push(sel);
    for (const r of rivers) {
      if (sel && String(r.id) === String(sel.id)) continue;
      ordered.push(r);
    }

    let best = null;
    let bestDistSq = maxDistSq;

    for (const river of ordered) {
      const pts = Array.isArray(river?.points) ? river.points : [];
      if (pts.length < 2) continue;

      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        if (!p0 || !p1) continue;

        const hit = this._closestPointOnSegment(x, y, p0.x, p0.y, p1.x, p1.y);
        if (hit.distSq <= bestDistSq) {
          bestDistSq = hit.distSq;
          best = {
            riverId: String(river.id),
            segmentIndex: i,
            t: hit.t,
            x: hit.x,
            y: hit.y,
            distSq: hit.distSq,
          };
        }
      }
    }

    return best;
  }

  _findNearestEndpoint(x, y, maxDist = 18, exclude = null) {
    this._ensureVectorRiversInitialized();

    const rivers = Array.isArray(this.vectorRivers?.rivers) ? this.vectorRivers.rivers : [];
    const maxDistSq = maxDist * maxDist;

    let best = null;
    let bestDistSq = maxDistSq;

    for (const river of rivers) {
      const pts = Array.isArray(river?.points) ? river.points : [];
      if (pts.length === 0) continue;

      const endpoints = [
        { pointIndex: 0, p: pts[0] },
        { pointIndex: pts.length - 1, p: pts[pts.length - 1] },
      ];

      for (const ep of endpoints) {
        const p = ep.p;
        if (!p) continue;

        if (exclude && String(exclude.riverId) === String(river.id) && exclude.pointIndex === ep.pointIndex) {
          continue;
        }

        const dx = p.x - x;
        const dy = p.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestDistSq) {
          bestDistSq = d2;
          best = { riverId: String(river.id), pointIndex: ep.pointIndex, x: p.x, y: p.y, distSq: d2 };
        }
      }
    }

    return best;
  }

  _maybeSnapToEndpoint(x, y, exclude = null) {
    const enabled = !!this.vectorRivers?.settings?.snapToEndpoints;
    if (!enabled) return { x, y, snapped: false };

    const hit = this._findNearestEndpoint(x, y, 18, exclude);
    if (!hit) return { x, y, snapped: false };

    return { x: hit.x, y: hit.y, snapped: true, target: hit };
  }

  _deleteRiverPoint(riverId, pointIndex) {
    this._ensureVectorRiversInitialized();

    const river = this.vectorRivers.rivers.find(r => String(r.id) === String(riverId));
    if (!river) return false;

    const pts = Array.isArray(river.points) ? river.points : [];
    if (pointIndex < 0 || pointIndex >= pts.length) return false;

    pts.splice(pointIndex, 1);

    // Update selection indices if needed
    if (String(this.selectedRiverId) === String(riverId)) {
      if (this.selectedRiverPointIndex === pointIndex) {
        this.selectedRiverPointIndex = null;
      } else if (this.selectedRiverPointIndex !== null && this.selectedRiverPointIndex > pointIndex) {
        this.selectedRiverPointIndex -= 1;
      }
    }

    river.points = pts;
    return true;
  }

  _onRiverPointerDown(x, y, event) {
    this._ensureVectorRiversInitialized();
    this._ensureRiverHandles();

    const oe = event?.data?.originalEvent || {};
    const alt = !!oe.altKey;
    const ctrl = !!oe.ctrlKey || !!oe.metaKey;

    if (this.currentTool === 'river-draw') {
      if (!this.selectedRiverId) {
        // Create one automatically for convenience
        const id = this._makeRiverId();
        const n = (this.vectorRivers.rivers?.length || 0) + 1;
        this.vectorRivers.rivers.push({ id, name: _f('SPACEHOLDER.GlobalMap.Tools.Rivers.DefaultName', { n }), points: [] });
        this.selectedRiverId = id;
      }

      const river = this._getSelectedRiver();
      if (!river) return;

      const snap = this._maybeSnapToEndpoint(x, y, null);
      const p = { x: snap.x, y: snap.y, width: this.riverDefaultPointWidth };

      if (!Array.isArray(river.points)) river.points = [];
      river.points.push(p);

      this.selectedRiverPointIndex = river.points.length - 1;
      this.vectorRiversDirty = true;

      this._applyVectorRiversToRenderer();
      this._renderRiverHandles();
      this._refreshRiversUI();
      return;
    }

    // Edit mode
    if (this.currentTool !== 'river-edit') return;

    if (ctrl) {
      const hit = this._findNearestRiverPoint(x, y, 14);
      if (hit) {
        this.selectedRiverId = hit.riverId;
        this.selectedRiverPointIndex = hit.pointIndex;

        if (this._deleteRiverPoint(hit.riverId, hit.pointIndex)) {
          this.vectorRiversDirty = true;
          this._applyVectorRiversToRenderer();
        }

        this._renderRiverHandles();
        this._refreshRiversUI();
      }
      return;
    }

    if (alt) {
      const seg = this._findNearestRiverSegment(x, y, 22);
      if (seg) {
        this.selectedRiverId = seg.riverId;
        const river = this._getSelectedRiver();
        if (!river || !Array.isArray(river.points) || river.points.length < 2) return;

        const i = seg.segmentIndex;
        const p0 = river.points[i];
        const p1 = river.points[i + 1];

        const w0 = Number(p0?.width) || this.riverDefaultPointWidth;
        const w1 = Number(p1?.width) || w0;
        const w = w0 + (w1 - w0) * seg.t;

        const insertIndex = i + 1;
        river.points.splice(insertIndex, 0, { x: seg.x, y: seg.y, width: w });

        this.selectedRiverPointIndex = insertIndex;
        this._riverDrag = { riverId: seg.riverId, pointIndex: insertIndex };

        this.vectorRiversDirty = true;
        this._applyVectorRiversToRenderer();
        this._renderRiverHandles();
        this._refreshRiversUI();
      }
      return;
    }

    // Select/drag point
    const hitPoint = this._findNearestRiverPoint(x, y, 14);
    if (hitPoint) {
      this.selectedRiverId = hitPoint.riverId;
      this.selectedRiverPointIndex = hitPoint.pointIndex;
      this._riverDrag = { riverId: hitPoint.riverId, pointIndex: hitPoint.pointIndex };

      this._renderRiverHandles();
      this._refreshRiversUI();
      return;
    }

    // Select river by clicking near segment
    const hitSeg = this._findNearestRiverSegment(x, y, 22);
    if (hitSeg) {
      this.selectedRiverId = hitSeg.riverId;
      this.selectedRiverPointIndex = null;
      this._riverDrag = null;

      this._renderRiverHandles();
      this._refreshRiversUI();
      return;
    }

    // Clicked empty space
    this.selectedRiverPointIndex = null;
    this._riverDrag = null;
    this._renderRiverHandles();
    this._refreshRiversUI();
  }

  _onRiverPointerMove(x, y, _event) {
    if (!this._riverDrag) return;

    this._ensureVectorRiversInitialized();

    const river = this.vectorRivers.rivers.find(r => String(r.id) === String(this._riverDrag.riverId));
    if (!river || !Array.isArray(river.points)) {
      this._riverDrag = null;
      return;
    }

    const idx = this._riverDrag.pointIndex;
    const p = river.points[idx];
    if (!p) {
      this._riverDrag = null;
      return;
    }

    let nx = x;
    let ny = y;

    // Snap endpoints only (makes connecting rivers easier and avoids weird mid-point snapping)
    const isEndpoint = idx === 0 || idx === river.points.length - 1;
    if (isEndpoint) {
      const snap = this._maybeSnapToEndpoint(nx, ny, { riverId: river.id, pointIndex: idx });
      nx = snap.x;
      ny = snap.y;
    }

    p.x = nx;
    p.y = ny;

    this.vectorRiversDirty = true;

    this._applyVectorRiversToRenderer();
    this._renderRiverHandles();
  }

  _onRiverPointerUp(_event) {
    this._riverDrag = null;
  }

  // ==========================
  // Vector Regions editor
  // ==========================

  _applyVectorRegionsToRenderer() {
    if (!this.renderer?.setVectorRegionsData) return;

    this.renderer.setVectorRegionsData(this.vectorRegions);

    // renderer normalizes and may replace object references
    this.vectorRegions = this.renderer.vectorRegionsData;
  }

  _ensureVectorRegionsInitialized() {
    if (this.vectorRegions) return this.vectorRegions;

    const scene = canvas?.scene;
    let raw = null;
    try {
      raw = scene?.getFlag?.('spaceholder', 'globalMapRegions');
    } catch (e) {
      raw = null;
    }

    // Default structure (in case renderer is not available)
    this.vectorRegions = {
      version: 1,
      settings: {
        labelMode: 'hover',
        clickAction: 'none',
        clickModifier: 'none',
        smoothIterations: 4,
        renderMode: 'full',
      },
      regions: [],
    };

    // Prefer renderer's normalization (single source of truth)
    if (this.renderer?.setVectorRegionsData) {
      this.renderer.setVectorRegionsData(raw);
      this.vectorRegions = this.renderer.vectorRegionsData;
    } else if (raw && typeof raw === 'object') {
      this.vectorRegions = raw;
    }

    if (!this.vectorRegions || typeof this.vectorRegions !== 'object') {
      this.vectorRegions = {
        version: 1,
        settings: { labelMode: 'hover', clickAction: 'none', clickModifier: 'none', smoothIterations: 4, renderMode: 'full' },
        regions: [],
      };
    }

    if (!this.vectorRegions.settings || typeof this.vectorRegions.settings !== 'object') {
      this.vectorRegions.settings = { labelMode: 'hover', clickAction: 'none', clickModifier: 'none', smoothIterations: 4, renderMode: 'full' };
    }

    if (!['off', 'hover', 'always'].includes(this.vectorRegions.settings.labelMode)) {
      this.vectorRegions.settings.labelMode = 'hover';
    }

    // clickAction/clickModifier (open journal by click) is deprecated/disabled.
    if (this.vectorRegions.settings.clickAction !== 'none') {
      this.vectorRegions.settings.clickAction = 'none';
    }

    if (!['none', 'ctrl', 'alt', 'shift'].includes(this.vectorRegions.settings.clickModifier)) {
      this.vectorRegions.settings.clickModifier = 'none';
    }

    const smoothIterationsRaw = Number.parseInt(this.vectorRegions.settings.smoothIterations, 10);
    this.vectorRegions.settings.smoothIterations = Number.isFinite(smoothIterationsRaw)
      ? Math.max(0, Math.min(4, smoothIterationsRaw))
      : 4;

    if (!Array.isArray(this.vectorRegions.regions)) {
      this.vectorRegions.regions = [];
    }

    // Default selection
    if (!this.selectedRegionId && this.vectorRegions.regions.length) {
      this.selectedRegionId = String(this.vectorRegions.regions[0].id);
    }

    return this.vectorRegions;
  }

  _ensureRegionHandles() {
    const desiredParent = canvas?.interface || canvas?.stage;

    if (this.regionHandles) {
      // Region handles can get destroyed or detached when the canvas/interface is rebuilt.
      // Try to reattach and ensure it's still usable; if that fails, recreate.
      try {
        if (desiredParent && this.regionHandles.parent !== desiredParent) {
          this.regionHandles.parent?.removeChild?.(this.regionHandles);
          desiredParent.addChild(this.regionHandles);
        }

        // Ensure it's still usable (Graphics can become a dead ref after destroy)
        this.regionHandles.clear();
        return;
      } catch (e) {
        try {
          this.regionHandles.destroy();
        } catch (err) {
          // ignore
        }
        this.regionHandles = null;
      }
    }

    this.regionHandles = new PIXI.Graphics();
    this.regionHandles.name = 'globalMapRegionHandles';
    this.regionHandles.visible = false;

    // Put handles on interface layer so they don't get baked into exports
    if (desiredParent) {
      desiredParent.addChild(this.regionHandles);
    }
  }

  _renderRegionHandles() {
    this._ensureRegionHandles();
    if (!this.regionHandles) return;

    try {
      this.regionHandles.clear();
    } catch (e) {
      // Recreate handles if they were destroyed by a canvas rebuild
      this.regionHandles = null;
      this._ensureRegionHandles();
      if (!this.regionHandles) return;
      this.regionHandles.clear();
    }

    const shouldShow = this.isBrushActive && this._isRegionTool();
    this.regionHandles.visible = shouldShow;
    if (!shouldShow) return;

    this._ensureVectorRegionsInitialized();

    const regions = Array.isArray(this.vectorRegions?.regions) ? this.vectorRegions.regions : [];
    for (const region of regions) {
      const pts = Array.isArray(region?.points) ? region.points : [];
      const isSelectedRegion = region?.id === this.selectedRegionId;

      // Draw outline / polyline
      if (pts.length >= 2) {
        this.regionHandles.lineStyle(2, isSelectedRegion ? 0xffffff : 0xaaaaaa, isSelectedRegion ? 0.7 : 0.35);
        this.regionHandles.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          this.regionHandles.lineTo(pts[i].x, pts[i].y);
        }
        if (region?.closed && pts.length >= 3) {
          this.regionHandles.lineTo(pts[0].x, pts[0].y);
        }
      }

      // Draw points
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!p) continue;

        const isSelectedPoint = isSelectedRegion && i === this.selectedRegionPointIndex;

        const radius = isSelectedPoint ? 7 : 5;
        const color = isSelectedPoint ? 0xffff00 : (isSelectedRegion ? 0xffffff : 0x888888);
        const alpha = isSelectedRegion ? 0.95 : 0.6;

        this.regionHandles.lineStyle(2, 0x000000, alpha);
        this.regionHandles.beginFill(color, alpha);
        this.regionHandles.drawCircle(p.x, p.y, radius);
        this.regionHandles.endFill();
      }
    }
  }

  _refreshRegionsUI() {
    if (!$('#global-map-tools-ui').length) return;

    this._ensureVectorRegionsInitialized();

    const regions = Array.isArray(this.vectorRegions?.regions) ? this.vectorRegions.regions : [];
    const select = $('#global-map-region-select');

    // Preserve selection when possible
    const existing = String(this.selectedRegionId || '');
    select.empty();

    if (regions.length === 0) {
      select.append($('<option></option>').attr('value', '').text(_t('SPACEHOLDER.GlobalMap.Tools.Regions.None')));
      this.selectedRegionId = null;
    } else {
      for (const r of regions) {
        const id = String(r.id);
        const name = String(r.name || id);
        select.append($('<option></option>').attr('value', id).text(name));
      }

      if (existing && regions.some(r => String(r.id) === existing)) {
        select.val(existing);
        this.selectedRegionId = existing;
      } else {
        this.selectedRegionId = String(regions[0].id);
        select.val(this.selectedRegionId);
      }
    }

    // Settings controls
    $('#region-label-mode').val(this.vectorRegions.settings?.labelMode || 'hover');
    $('#region-smooth-iterations').val(String(this.vectorRegions.settings?.smoothIterations ?? 1));

    const region = this._getSelectedRegion();
    const hasRegion = !!region;

    // Buttons enabled/disabled
    $('#region-delete').prop('disabled', !hasRegion);
    $('#region-rename').prop('disabled', !hasRegion);
    $('#region-finish').prop('disabled', !hasRegion);

    // Style + journal fields
    const setDisabled = (sel, disabled) => {
      try { $(sel).prop('disabled', disabled); } catch (e) { /* ignore */ }
    };

    if (!hasRegion) {
      setDisabled('#region-fill-color', true);
      setDisabled('#region-fill-alpha', true);
      setDisabled('#region-stroke-color', true);
      setDisabled('#region-stroke-alpha', true);
      setDisabled('#region-stroke-width', true);
      setDisabled('#region-journal-uuid', true);
      setDisabled('#region-journal-open', true);
      setDisabled('#region-journal-clear', true);

      $('#region-fill-alpha-value').text('-');
      $('#region-stroke-alpha-value').text('-');
      $('#region-stroke-width-value').text('-');
      $('#region-journal-uuid').val('');
    } else {
      setDisabled('#region-fill-color', false);
      setDisabled('#region-fill-alpha', false);
      setDisabled('#region-stroke-color', false);
      setDisabled('#region-stroke-alpha', false);
      setDisabled('#region-stroke-width', false);
      setDisabled('#region-journal-uuid', false);

      const fillAlpha = Math.max(0, Math.min(1, Number(region.fillAlpha) || 0));
      const strokeAlpha = Math.max(0, Math.min(1, Number(region.strokeAlpha) || 0));
      const strokeWidth = Math.max(0.1, Number(region.strokeWidth) || 1);

      $('#region-fill-color').val(this._intToCssHex(region.fillColor));
      $('#region-fill-alpha').val(String(fillAlpha));
      $('#region-fill-alpha-value').text(fillAlpha.toFixed(2));

      $('#region-stroke-color').val(this._intToCssHex(region.strokeColor));
      $('#region-stroke-alpha').val(String(strokeAlpha));
      $('#region-stroke-alpha-value').text(strokeAlpha.toFixed(2));

      $('#region-stroke-width').val(String(Math.round(strokeWidth)));
      $('#region-stroke-width-value').text(String(Math.round(strokeWidth)));

      const uuid = String(region.journalUuid || '').trim();
      $('#region-journal-uuid').val(uuid);
      setDisabled('#region-journal-open', !uuid);
      setDisabled('#region-journal-clear', !uuid);
    }

    // Save indicator
    {
      const saveLabel = _t('SPACEHOLDER.GlobalMap.Tools.Regions.Save');
      $('#region-save').text(this.vectorRegionsDirty ? `${saveLabel}*` : saveLabel);
    }
  }

  _onRegionsTabShown() {
    this._ensureVectorRegionsInitialized();
    this._applyVectorRegionsToRenderer();
    this._refreshRegionsUI();
    this._renderRegionHandles();
  }

  _getSelectedRegion() {
    this._ensureVectorRegionsInitialized();

    const regions = Array.isArray(this.vectorRegions?.regions) ? this.vectorRegions.regions : [];
    if (!this.selectedRegionId) return null;

    return regions.find(r => String(r.id) === String(this.selectedRegionId)) || null;
  }

  _makeRegionId() {
    try {
      if (foundry?.utils?.randomID) return foundry.utils.randomID();
    } catch (e) {
      // ignore
    }
    return `region_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  _createRegionDefaultStyle() {
    return {
      fillColor: this.regionDefaultFillColor,
      fillAlpha: this.regionDefaultFillAlpha,
      strokeColor: this.regionDefaultStrokeColor,
      strokeAlpha: this.regionDefaultStrokeAlpha,
      strokeWidth: this.regionDefaultStrokeWidth,
    };
  }

  async createNewRegion() {
    this._ensureVectorRegionsInitialized();

    const id = this._makeRegionId();
    const n = (this.vectorRegions.regions?.length || 0) + 1;

    const style = this._createRegionDefaultStyle();

    const region = {
      id,
      name: _f('SPACEHOLDER.GlobalMap.Tools.Regions.DefaultName', { n }),
      points: [],
      closed: false,
      ...style,
      journalUuid: '',
    };

    this.vectorRegions.regions.push(region);
    this.selectedRegionId = id;
    this.selectedRegionPointIndex = null;
    this.vectorRegionsDirty = true;

    this._applyVectorRegionsToRenderer();
  }

  async deleteSelectedRegion() {
    const region = this._getSelectedRegion();
    if (!region) return;

    const ok = await this._confirmDialog({
      title: _t('SPACEHOLDER.GlobalMap.Tools.Regions.Confirm.DeleteTitle'),
      content: _f('SPACEHOLDER.GlobalMap.Tools.Regions.Confirm.DeleteContent', {
        name: this._escapeHtml(region.name),
      }),
      yesLabel: _t('SPACEHOLDER.Actions.Delete'),
      yesIcon: 'fa-solid fa-trash',
      noLabel: _t('SPACEHOLDER.Actions.Cancel'),
      noIcon: 'fa-solid fa-times',
    });
    if (!ok) return;

    this._ensureVectorRegionsInitialized();
    const regions = this.vectorRegions.regions;
    const idx = regions.findIndex(r => String(r.id) === String(region.id));
    if (idx >= 0) {
      regions.splice(idx, 1);
    }

    // Update selection
    if (regions.length === 0) {
      this.selectedRegionId = null;
      this.selectedRegionPointIndex = null;
    } else {
      const next = regions[Math.min(idx, regions.length - 1)];
      this.selectedRegionId = String(next.id);
      this.selectedRegionPointIndex = null;
    }

    this.vectorRegionsDirty = true;
    this._applyVectorRegionsToRenderer();
  }

  async renameSelectedRegion() {
    const region = this._getSelectedRegion();
    if (!region) return;

    const currentName = String(region.name || '');
    const newNameRaw = await this._promptDialog({
      title: _t('SPACEHOLDER.GlobalMap.Tools.Regions.Prompt.RenameTitle'),
      label: _t('SPACEHOLDER.Placeholder.Name'),
      initialValue: currentName,
    });

    if (typeof newNameRaw !== 'string') return;
    const newName = newNameRaw.trim();
    if (!newName) return;

    region.name = newName;
    this.vectorRegionsDirty = true;
    this._applyVectorRegionsToRenderer();
  }

  async finishSelectedRegion() {
    const region = this._getSelectedRegion();
    if (!region) return;

    const pts = Array.isArray(region.points) ? region.points : [];
    if (pts.length < 3) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Tools.Errors.RegionNeedsAtLeast3Points'));
      return;
    }

    region.closed = true;
    this.vectorRegionsDirty = true;

    // Convenience: switch to Edit
    this._selectedRegionsTool = 'region-edit';
    this.setTool('region-edit');
    this.selectedRegionPointIndex = null;

    this._applyVectorRegionsToRenderer();
  }

  async saveVectorRegions() {
    this._ensureVectorRegionsInitialized();

    const scene = canvas?.scene;
    if (!scene?.setFlag) return;

    try {
      await scene.setFlag('spaceholder', 'globalMapRegions', this.vectorRegions);
      this.vectorRegionsDirty = false;
      ui.notifications?.info?.(_t('SPACEHOLDER.GlobalMap.Tools.Notifications.RegionsSaved'));
      console.log('GlobalMapTools | ✓ Regions saved to scene');
    } catch (error) {
      console.error('GlobalMapTools | Failed to save regions:', error);
      ui.notifications?.error?.(_f('SPACEHOLDER.GlobalMap.Tools.Errors.SaveRegionsFailed', { message: error.message }));
    }
  }

  _findNearestRegionPoint(x, y, maxDist = 14) {
    this._ensureVectorRegionsInitialized();

    const regions = Array.isArray(this.vectorRegions?.regions) ? this.vectorRegions.regions : [];
    const maxDistSq = maxDist * maxDist;

    // Prefer selected region if any
    const ordered = [];
    const sel = this._getSelectedRegion();
    if (sel) ordered.push(sel);
    for (const r of regions) {
      if (sel && String(r.id) === String(sel.id)) continue;
      ordered.push(r);
    }

    let best = null;
    let bestDistSq = maxDistSq;

    for (const region of ordered) {
      const pts = Array.isArray(region?.points) ? region.points : [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!p) continue;
        const dx = p.x - x;
        const dy = p.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestDistSq) {
          bestDistSq = d2;
          best = { regionId: String(region.id), pointIndex: i, distSq: d2 };
        }
      }
    }

    return best;
  }

  _findNearestRegionSegment(x, y, maxDist = 22) {
    this._ensureVectorRegionsInitialized();

    const regions = Array.isArray(this.vectorRegions?.regions) ? this.vectorRegions.regions : [];
    const maxDistSq = maxDist * maxDist;

    // Prefer selected region first
    const ordered = [];
    const sel = this._getSelectedRegion();
    if (sel) ordered.push(sel);
    for (const r of regions) {
      if (sel && String(r.id) === String(sel.id)) continue;
      ordered.push(r);
    }

    let best = null;
    let bestDistSq = maxDistSq;

    for (const region of ordered) {
      const pts = Array.isArray(region?.points) ? region.points : [];
      if (pts.length < 2) continue;

      const segCount = region?.closed && pts.length >= 3 ? pts.length : (pts.length - 1);
      for (let i = 0; i < segCount; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % pts.length];
        if (!p0 || !p1) continue;

        const hit = this._closestPointOnSegment(x, y, p0.x, p0.y, p1.x, p1.y);
        if (hit.distSq <= bestDistSq) {
          bestDistSq = hit.distSq;
          best = {
            regionId: String(region.id),
            segmentIndex: i,
            t: hit.t,
            x: hit.x,
            y: hit.y,
            distSq: hit.distSq,
          };
        }
      }
    }

    return best;
  }

  _deleteRegionPoint(regionId, pointIndex) {
    this._ensureVectorRegionsInitialized();

    const region = this.vectorRegions.regions.find(r => String(r.id) === String(regionId));
    if (!region) return false;

    const pts = Array.isArray(region.points) ? region.points : [];
    if (pointIndex < 0 || pointIndex >= pts.length) return false;

    pts.splice(pointIndex, 1);

    // If region becomes invalid for polygon, open it
    if (region.closed && pts.length < 3) {
      region.closed = false;
    }

    // Update selection indices if needed
    if (String(this.selectedRegionId) === String(regionId)) {
      if (this.selectedRegionPointIndex === pointIndex) {
        this.selectedRegionPointIndex = null;
      } else if (this.selectedRegionPointIndex !== null && this.selectedRegionPointIndex > pointIndex) {
        this.selectedRegionPointIndex -= 1;
      }
    }

    region.points = pts;
    return true;
  }

  _onRegionPointerDown(x, y, event) {
    this._ensureVectorRegionsInitialized();
    this._ensureRegionHandles();

    const oe = event?.data?.originalEvent || {};
    const alt = !!oe.altKey;
    const ctrl = !!oe.ctrlKey || !!oe.metaKey;

    if (this.currentTool === 'region-draw') {
      if (!this.selectedRegionId) {
        // Create one automatically for convenience
        const id = this._makeRegionId();
        const n = (this.vectorRegions.regions?.length || 0) + 1;
        const style = this._createRegionDefaultStyle();
        this.vectorRegions.regions.push({
          id,
          name: _f('SPACEHOLDER.GlobalMap.Tools.Regions.DefaultName', { n }),
          points: [],
          closed: false,
          ...style,
          journalUuid: '',
        });
        this.selectedRegionId = id;
      }

      const region = this._getSelectedRegion();
      if (!region) return;

      if (region.closed) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Tools.Errors.RegionAlreadyClosed'));
        return;
      }

      if (!Array.isArray(region.points)) region.points = [];
      region.points.push({ x, y });

      this.selectedRegionPointIndex = region.points.length - 1;
      this.vectorRegionsDirty = true;

      this._applyVectorRegionsToRenderer();
      this._renderRegionHandles();
      this._refreshRegionsUI();
      return;
    }

    // Edit mode
    if (this.currentTool !== 'region-edit') return;

    if (ctrl) {
      const hit = this._findNearestRegionPoint(x, y, 14);
      if (hit) {
        this.selectedRegionId = hit.regionId;
        this.selectedRegionPointIndex = hit.pointIndex;

        if (this._deleteRegionPoint(hit.regionId, hit.pointIndex)) {
          this.vectorRegionsDirty = true;
          this._applyVectorRegionsToRenderer();
        }

        this._renderRegionHandles();
        this._refreshRegionsUI();
      }
      return;
    }

    if (alt) {
      const seg = this._findNearestRegionSegment(x, y, 22);
      if (seg) {
        this.selectedRegionId = seg.regionId;
        const region = this._getSelectedRegion();
        if (!region || !Array.isArray(region.points) || region.points.length < 2) return;

        const insertIndex = seg.segmentIndex + 1;
        region.points.splice(insertIndex, 0, { x: seg.x, y: seg.y });

        this.selectedRegionPointIndex = insertIndex;
        this._regionDrag = { regionId: seg.regionId, pointIndex: insertIndex };

        this.vectorRegionsDirty = true;
        this._applyVectorRegionsToRenderer();
        this._renderRegionHandles();
        this._refreshRegionsUI();
      }
      return;
    }

    // Select/drag point
    const hitPoint = this._findNearestRegionPoint(x, y, 14);
    if (hitPoint) {
      this.selectedRegionId = hitPoint.regionId;
      this.selectedRegionPointIndex = hitPoint.pointIndex;
      this._regionDrag = { regionId: hitPoint.regionId, pointIndex: hitPoint.pointIndex };

      this._renderRegionHandles();
      this._refreshRegionsUI();
      return;
    }

    // Select region by clicking near segment
    const hitSeg = this._findNearestRegionSegment(x, y, 22);
    if (hitSeg) {
      this.selectedRegionId = hitSeg.regionId;
      this.selectedRegionPointIndex = null;
      this._regionDrag = null;

      this._renderRegionHandles();
      this._refreshRegionsUI();
      return;
    }

    // Clicked empty space
    this.selectedRegionPointIndex = null;
    this._regionDrag = null;
    this._renderRegionHandles();
    this._refreshRegionsUI();
  }

  _onRegionPointerMove(x, y, _event) {
    if (!this._regionDrag) return;

    this._ensureVectorRegionsInitialized();

    const region = this.vectorRegions.regions.find(r => String(r.id) === String(this._regionDrag.regionId));
    if (!region || !Array.isArray(region.points)) {
      this._regionDrag = null;
      return;
    }

    const idx = this._regionDrag.pointIndex;
    const p = region.points[idx];
    if (!p) {
      this._regionDrag = null;
      return;
    }

    p.x = x;
    p.y = y;

    this.vectorRegionsDirty = true;

    this._applyVectorRegionsToRenderer();
    this._renderRegionHandles();
  }

  _onRegionPointerUp(_event) {
    this._regionDrag = null;
  }

  /**
   * Set up canvas event listeners
   */
  setupEventListeners() {
    this._installStageEventListeners();
  }

  /**
   * Install PIXI stage listeners.
   * IMPORTANT: We must be able to remove them to avoid handler accumulation after multiple activate/deactivate cycles.
   * @private
   */
  _installStageEventListeners() {
    const stage = canvas?.stage;
    if (!stage) return;
    if (this._stageListenersActive) return;

    this._stageForListeners = stage;

    this._onStagePointerDown = (event) => {
      if (!this.isActive || !this.isBrushActive) return;

      // Allow right-click panning
      if (event?.data?.button === 2) return;
      if (event?.data?.button !== 0) return;

      event.stopPropagation();

      const pos = event.data.getLocalPosition(stage);

      // Flatten pipette hotkey: Alt+Click picks target height from the clicked cell (no painting)
      const oe = event?.data?.originalEvent || {};
      const alt = !!oe.altKey;
      if (!this._isRiverTool() && this.currentTool === 'flatten' && alt) {
        if (this._pickFlattenTargetHeightAt(pos.x, pos.y)) {
          this._syncFlattenUI();
        }
        return;
      }

      this.isMouseDown = true;
      this.lastPosition = pos;

      // Vector regions editor
      if (this._isRegionTool()) {
        this._onRegionPointerDown(pos.x, pos.y, event);
        return;
      }

      // Vector rivers editor
      if (this._isRiverTool()) {
        this._onRiverPointerDown(pos.x, pos.y, event);
        return;
      }

      if (!this.renderer.currentGrid?.heights?.length) return;

      // Start temporary overlay for this stroke
      const gridSize = this.renderer.currentGrid.heights.length;
      this.tempOverlay = new Float32Array(gridSize);
      this.affectedCells = new Set();
      this._strokeHasChanges = false;

      this.applyBrushStroke(pos.x, pos.y);
      this.updateOverlayPreview();
    };

    this._onStagePointerMove = (event) => {
      if (!this.isActive) return;

      const pos = event.data.getLocalPosition(stage);

      // Vector regions editor (dragging)
      if (this.isBrushActive && this._isRegionTool()) {
        this._onRegionPointerMove(pos.x, pos.y, event);
        return;
      }

      // Vector rivers editor (dragging)
      if (this.isBrushActive && this._isRiverTool()) {
        this._onRiverPointerMove(pos.x, pos.y, event);
        return;
      }

      // Update cursor and cell highlight only when brush is active
      if (this.isBrushActive) {
        this.updateBrushCursorPosition(pos.x, pos.y);
        if (this.singleCellMode) {
          this.updateCellHighlight(pos.x, pos.y);
        }
      }

      if (!this.isBrushActive || !this.isMouseDown) return;

      // Throttle to 10px
      if (this.lastPosition) {
        const dx = pos.x - this.lastPosition.x;
        const dy = pos.y - this.lastPosition.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 10) {
          this.applyBrushStroke(pos.x, pos.y);
          this.updateOverlayPreview();
          this.lastPosition = pos;
        }
      }
    };

    this._onStagePointerUp = (event) => {
      if (!this.isActive || !this.isBrushActive) return;

      const wasMouseDown = this.isMouseDown;
      this.isMouseDown = false;
      this.lastPosition = null;

      // Vector regions editor
      if (this._isRegionTool()) {
        this._onRegionPointerUp(event);
        return;
      }

      // Vector rivers editor
      if (this._isRiverTool()) {
        this._onRiverPointerUp(event);
        return;
      }

      if (!wasMouseDown) return;

      // Commit overlay to grid
      if (this.tempOverlay) {
        this.commitOverlay();
        this.tempOverlay = null;
        this.affectedCells = null;
        this.clearOverlayPreview();
      }
    };

    stage.on('pointerdown', this._onStagePointerDown);
    stage.on('pointermove', this._onStagePointerMove);
    stage.on('pointerup', this._onStagePointerUp);

    // Important: prevent stuck drag/stroke state if pointer leaves canvas or gets cancelled
    stage.on('pointerupoutside', this._onStagePointerUp);
    stage.on('pointercancel', this._onStagePointerUp);

    this._stageListenersActive = true;
  }

  /**
   * Remove PIXI stage listeners.
   * @private
   */
  _removeStageEventListeners() {
    const stage = this._stageForListeners || canvas?.stage;

    if (!stage) {
      this._stageListenersActive = false;
      this._stageForListeners = null;
      return;
    }
    if (!this._stageListenersActive) {
      this._stageForListeners = null;
      return;
    }

    try {
      if (this._onStagePointerDown) stage.off('pointerdown', this._onStagePointerDown);
      if (this._onStagePointerMove) stage.off('pointermove', this._onStagePointerMove);
      if (this._onStagePointerUp) {
        stage.off('pointerup', this._onStagePointerUp);
        stage.off('pointerupoutside', this._onStagePointerUp);
        stage.off('pointercancel', this._onStagePointerUp);
      }
    } catch (e) {
      // ignore
    }

    this._onStagePointerDown = null;
    this._onStagePointerMove = null;
    this._onStagePointerUp = null;
    this._stageListenersActive = false;
    this._stageForListeners = null;
  }

  // ==========================
  // Scene / canvas lifecycle
  // ==========================

  _installCanvasHooks() {
    if (this._canvasHookInstalled) return;

    try {
      if (!globalThis.Hooks?.on) return;

      this._onCanvasReadyHook = () => {
        // Defer to allow renderer (and other hooks) to rebuild containers first.
        setTimeout(() => {
          try {
            this._handleCanvasReady();
          } catch (e) {
            // ignore
          }
        }, 0);
      };

      Hooks.on('canvasReady', this._onCanvasReadyHook);
      this._canvasHookInstalled = true;
    } catch (e) {
      // ignore
    }
  }

  async _handleCanvasReady() {
    if (!this.isActive) return;

    const newSceneId = canvas?.scene?.id || null;

    // Cancel any in-progress stroke/drag on canvas rebuild
    this.isMouseDown = false;
    this.lastPosition = null;
    this.tempOverlay = null;
    this.affectedCells = null;
    this._strokeHasChanges = false;
    this._riverDrag = null;
    this._regionDrag = null;

    // If the scene changed while tools were active, exit edit mode to avoid editing the wrong scene.
    if (this._activeSceneId !== newSceneId) {
      try {
        ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Tools.Warnings.EditorDisabledSceneChanged'));
      } catch (e) {
        // ignore
      }

      await this.deactivate();
      return;
    }

    // Same-scene canvas refresh: rebind stage listeners (canvas.stage can be recreated) and reattach overlays.
    this._removeStageEventListeners();
    this._installStageEventListeners();

    // UI may still be open; ensure helper graphics are attached to the new canvas layers/containers.
    this.createBrushCursor();
    this.createOverlayPreview();
    if (this.singleCellMode) {
      this.createCellHighlight();
    }

    // River handles live on interface/stage; ensure they are reattached if river tool is active
    if (this._isRiverTool()) {
      this._ensureRiverHandles();
      this._renderRiverHandles();
    }

    // Region handles live on interface/stage; ensure they are reattached if region tool is active
    if (this._isRegionTool()) {
      this._ensureRegionHandles();
      this._renderRegionHandles();
    }

    this.updateBrushCursorGraphics();

    // Canvas refresh can recreate TokenLayer and re-enable interactions; re-apply shield if brush is still active.
    if (this.isBrushActive) {
      this._enterBrushInteractionShield();
    }

    this.updateBrushUI();
    this._updateUndoRedoUI();
  }

  // ==========================
  // Undo / Redo (grid edits)
  // ==========================

  _captureGridSnapshot() {
    const grid = this.renderer?.currentGrid;
    if (!grid?.heights?.length) return null;

    return {
      heights: new Float32Array(grid.heights),
      biomes: grid.biomes ? new Uint8Array(grid.biomes) : null,
      rivers: grid.rivers ? new Uint8Array(grid.rivers) : null,
      rows: grid.rows,
      cols: grid.cols,
    };
  }

  _applyGridSnapshot(snapshot) {
    if (!snapshot) return false;
    const grid = this.renderer?.currentGrid;
    if (!grid) return false;

    // Heights
    if (!grid.heights || grid.heights.length !== snapshot.heights.length) {
      grid.heights = new Float32Array(snapshot.heights.length);
    }
    grid.heights.set(snapshot.heights);

    // Biomes
    if (snapshot.biomes) {
      if (!grid.biomes || grid.biomes.length !== snapshot.biomes.length) {
        grid.biomes = new Uint8Array(snapshot.biomes.length);
      }
      grid.biomes.set(snapshot.biomes);
    }

    // Rivers (legacy cell-mask rivers)
    if (snapshot.rivers) {
      if (!grid.rivers || grid.rivers.length !== snapshot.rivers.length) {
        grid.rivers = new Uint8Array(snapshot.rivers.length);
      }
      grid.rivers.set(snapshot.rivers);
    }

    return true;
  }

  _pushUndoSnapshot(label = '') {
    const snap = this._captureGridSnapshot();
    if (!snap) return false;

    this._undoStack.push({ label: String(label || ''), snapshot: snap, ts: Date.now() });

    // Trim oldest
    if (this._undoStack.length > this._undoMax) {
      this._undoStack.splice(0, this._undoStack.length - this._undoMax);
    }

    // New edit invalidates redo
    this._redoStack = [];

    this._updateUndoRedoUI();
    return true;
  }

  _canUndo() {
    return Array.isArray(this._undoStack) && this._undoStack.length > 0;
  }

  _canRedo() {
    return Array.isArray(this._redoStack) && this._redoStack.length > 0;
  }

  _updateUndoRedoUI() {
    const canUndo = this._canUndo();
    const canRedo = this._canRedo();

    // Floating tools UI
    if ($('#global-map-tools-ui').length) {
      const undoBtn = $('#global-map-undo');
      const redoBtn = $('#global-map-redo');

      if (undoBtn.length) {
        undoBtn.prop('disabled', !canUndo);
        undoBtn.css('opacity', canUndo ? '1' : '0.5');
      }
      if (redoBtn.length) {
        redoBtn.prop('disabled', !canRedo);
        redoBtn.css('opacity', canRedo ? '1' : '0.5');
      }
    }

    // Edge UI (left flyout)
    try {
      const edgeRoot = document.getElementById('spaceholder-globalmap-edge-ui');
      if (edgeRoot) {
        const undoBtn = edgeRoot.querySelector('button[data-action="global-map-undo"]');
        const redoBtn = edgeRoot.querySelector('button[data-action="global-map-redo"]');

        if (undoBtn) {
          undoBtn.disabled = !canUndo;
        }
        if (redoBtn) {
          redoBtn.disabled = !canRedo;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  _rerenderAfterEdit() {
    if (!this.renderer?.currentGrid || !this.renderer?.currentMetadata) return;

    // Re-render map
    this.renderer.render(
      this.renderer.currentGrid,
      this.renderer.currentMetadata,
      { mode: 'heights' }
    );

    // Ensure overlays remain attached even if renderer recreated containers
    this.createOverlayPreview();
    if (this.singleCellMode) {
      this.createCellHighlight();
    }

    this._updateUndoRedoUI();
  }

  undo() {
    if (!this._canUndo()) return false;
    if (this.isMouseDown) return false;
    if (!this.renderer?.currentGrid) return false;

    const entry = this._undoStack.pop();
    if (!entry?.snapshot) {
      this._updateUndoRedoUI();
      return false;
    }

    const current = this._captureGridSnapshot();
    if (current) {
      this._redoStack.push({ label: entry.label, snapshot: current, ts: Date.now() });
    }

    const ok = this._applyGridSnapshot(entry.snapshot);
    if (ok) {
      this._rerenderAfterEdit();
    } else {
      this._updateUndoRedoUI();
    }

    return ok;
  }

  redo() {
    if (!this._canRedo()) return false;
    if (this.isMouseDown) return false;
    if (!this.renderer?.currentGrid) return false;

    const entry = this._redoStack.pop();
    if (!entry?.snapshot) {
      this._updateUndoRedoUI();
      return false;
    }

    const current = this._captureGridSnapshot();
    if (current) {
      this._undoStack.push({ label: entry.label, snapshot: current, ts: Date.now() });

      // Trim oldest
      if (this._undoStack.length > this._undoMax) {
        this._undoStack.splice(0, this._undoStack.length - this._undoMax);
      }
    }

    const ok = this._applyGridSnapshot(entry.snapshot);
    if (ok) {
      this._rerenderAfterEdit();
    } else {
      this._updateUndoRedoUI();
    }

    return ok;
  }

  /**
   * Apply brush stroke to temporary overlay
   */
  applyBrushStroke(worldX, worldY) {
    if (!this.renderer.currentGrid || !this.tempOverlay) return;

    const grid = this.renderer.currentGrid;
    const metadata = this.renderer.currentMetadata;
    const { heights, biomes, moisture, temperature, rows, cols } = grid;
    const { cellSize, bounds } = metadata;

    // Convert world coords to grid coords
    const gridCol = (worldX - bounds.minX) / cellSize;
    const gridRow = (worldY - bounds.minY) / cellSize;

    // Calculate affected cells
    let minRow, maxRow, minCol, maxCol;
    
    if (this.singleCellMode) {
      // Single cell mode: affect only the cell under cursor
      const targetRow = Math.floor(gridRow);
      const targetCol = Math.floor(gridCol);
      minRow = Math.max(0, targetRow);
      maxRow = Math.min(rows - 1, targetRow);
      minCol = Math.max(0, targetCol);
      maxCol = Math.min(cols - 1, targetCol);
    } else {
      // Normal brush mode: affect cells in radius
      const gridRadius = this.brushRadius / cellSize;
      minRow = Math.max(0, Math.floor(gridRow - gridRadius));
      maxRow = Math.min(rows - 1, Math.ceil(gridRow + gridRadius));
      minCol = Math.max(0, Math.floor(gridCol - gridRadius));
      maxCol = Math.min(cols - 1, Math.ceil(gridCol + gridRadius));
    }

    const delta = 5; // Base height change per stroke

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        // Check if cell is within brush area
        let inBrush = false;
        let effectiveStrength = this.brushStrength;
        
        if (this.singleCellMode) {
          // Single cell mode: always affect the cell
          inBrush = true;
          effectiveStrength = 1.0; // Full strength for single cell
        } else {
          // Normal brush mode: check distance and calculate falloff
          const dx = col - gridCol;
          const dy = row - gridRow;
          const distSq = dx * dx + dy * dy;
          const gridRadius = this.brushRadius / cellSize;
          const radiusSq = gridRadius * gridRadius;
          
          if (distSq <= radiusSq) {
            inBrush = true;
            const falloff = 1 - Math.sqrt(distSq / radiusSq);
            effectiveStrength = falloff * this.brushStrength;
          }
        }

        if (inBrush) {
          const idx = row * cols + col;

          // Check filters before applying brush
          if (!this._isCellPassesFilter(idx, heights, biomes, temperature, moisture)) {
            continue; // Skip this cell if it doesn't pass filter
          }

          // We have at least one affected cell in this stroke
          this._strokeHasChanges = true;

          // Track affected cells for tools that process in commit
          if (this.currentTool === 'smooth' || this.currentTool === 'roughen' ||
              this.currentTool === 'set-biome') {
            this.affectedCells.add(idx);
          }

          switch (this.currentTool) {
            case 'raise':
              this.tempOverlay[idx] += delta * effectiveStrength;
              break;
            case 'lower':
              this.tempOverlay[idx] -= delta * effectiveStrength;
              break;
            case 'flatten':
              const currentHeight = heights[idx] + this.tempOverlay[idx];
              this.tempOverlay[idx] += (this.targetHeight - currentHeight) * effectiveStrength;
              break;
            case 'smooth':
            case 'roughen':
            case 'set-biome':
              // Mark cells, changes applied in commit
              break;
            default:
              break;
          }
        }
      }
    }
  }

  /**
   * Commit temporary overlay to grid
   */
  commitOverlay() {
    if (!this.renderer.currentGrid || !this.tempOverlay) return;

    // Skip no-op strokes (e.g. everything filtered out)
    if (!this._strokeHasChanges) {
      console.log('GlobalMapTools | No changes to apply (stroke was empty)');
      return;
    }

    // Capture undo snapshot BEFORE modifying the grid
    this._pushUndoSnapshot(`brush:${this.currentTool}`);

    const { heights, biomes, moisture, temperature, rows, cols } = this.renderer.currentGrid;
    let { rivers } = this.renderer.currentGrid;

    // Initialize rivers array if it doesn't exist (for old saved maps)
    if (!rivers) {
      console.log('GlobalMapTools | Initializing rivers array for existing map');
      rivers = new Uint8Array(heights.length);
      this.renderer.currentGrid.rivers = rivers;
    }

    // Apply smooth/roughen if needed
    if (this.currentTool === 'smooth' && this.affectedCells.size > 0) {
      this._applySmoothOverlay(heights, rows, cols);
    } else if (this.currentTool === 'roughen' && this.affectedCells.size > 0) {
      this._applyRoughenOverlay(heights, rows, cols);
    }

    // Apply biome changes
    if (this.currentTool === 'set-biome' && this.affectedCells.size > 0) {
      // Set biome to selected ID
      if (biomes) {
        for (const idx of this.affectedCells) {
          biomes[idx] = this.setBiomeId;
        }
      }
    }

    // Apply overlay to heights
    for (let i = 0; i < heights.length; i++) {
      if (Math.abs(this.tempOverlay[i]) > 0.001) {
        const next = heights[i] + this.tempOverlay[i];
        heights[i] = Math.max(0, Math.min(100, next));
      }
    }

    // Re-render
    this.renderer.render(
      this.renderer.currentGrid,
      this.renderer.currentMetadata,
      { mode: 'heights' }
    );

    // Recreate overlays after render (they get destroyed during render)
    this.createOverlayPreview();
    if (this.singleCellMode) {
      this.createCellHighlight();
    }

    console.log('GlobalMapTools | Changes applied');
  }

  /**
   * Create overlay preview graphics
   */
  createOverlayPreview() {
    if (this.overlayPreview) {
      try {
        this.overlayPreview.destroy();
      } catch (e) {
        // Already destroyed
      }
    }
    this.overlayPreview = new PIXI.Graphics();
    this.overlayPreview.name = 'global-map-overlay-preview';
    if (this.renderer.container) {
      this.renderer.container.addChild(this.overlayPreview);
    } else {
      console.warn('GlobalMapTools | Renderer container not available for overlay');
    }
  }

  /**
   * Update overlay preview visualization
   */
  updateOverlayPreview() {
    if (!this.tempOverlay || !this.renderer.currentGrid) return;

    if (!this.overlayPreview || !this.overlayPreview.parent) {
      this.createOverlayPreview();
      if (!this.overlayPreview) return;
    }

    try {
      this.overlayPreview.clear();
    } catch (e) {
      // If overlay graphics were destroyed by a canvas rebuild, recreate them
      this.createOverlayPreview();
      if (!this.overlayPreview) return;
      this.overlayPreview.clear();
    }

    const { heights, rows, cols } = this.renderer.currentGrid;
    const { bounds, cellSize } = this.renderer.currentMetadata;
    const previewOverlay = new Float32Array(this.tempOverlay); // Copy current overlay

    // For smooth/roughen, calculate preview of what will happen
    if ((this.currentTool === 'smooth' || this.currentTool === 'roughen') && this.affectedCells.size > 0) {
      if (this.currentTool === 'smooth') {
        const smoothAmount = this.brushStrength * 0.5;
        const tempHeights = new Float32Array(heights);

        for (const idx of this.affectedCells) {
          const row = Math.floor(idx / cols);
          const col = idx % cols;
          let sum = heights[idx];
          let count = 1;

          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nRow = row + dr;
              const nCol = col + dc;
              if (nRow >= 0 && nRow < rows && nCol >= 0 && nCol < cols) {
                const nIdx = nRow * cols + nCol;
                sum += tempHeights[nIdx];
                count++;
              }
            }
          }
          const avg = sum / count;
          const delta = (avg - heights[idx]) * smoothAmount;
          previewOverlay[idx] = delta;
        }
      } else if (this.currentTool === 'roughen') {
        const roughenAmount = this.brushStrength * 0.3;
        const tempHeights = new Float32Array(heights);

        for (const idx of this.affectedCells) {
          const row = Math.floor(idx / cols);
          const col = idx % cols;
          let sum = 0;
          let count = 0;

          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nRow = row + dr;
              const nCol = col + dc;
              if (nRow >= 0 && nRow < rows && nCol >= 0 && nCol < cols) {
                const nIdx = nRow * cols + nCol;
                sum += tempHeights[nIdx];
                count++;
              }
            }
          }
          if (count > 0) {
            const avg = sum / count;
            const delta = (heights[idx] - avg) * roughenAmount;
            previewOverlay[idx] = delta;
          }
        }
      }
    }

    // For biome tools, show change for affected cells
    if (this.affectedCells.size > 0) {
      if (this.currentTool === 'set-biome') {
        // Show fixed indicator
        for (const idx of this.affectedCells) {
          previewOverlay[idx] = 1;
        }
      }
    }

    // Determine colors based on tool
    let positiveColor = 0x00ff00; // default
    let negativeColor = 0xff0000;
    switch (this.currentTool) {
      case 'raise':
        positiveColor = 0x00ff00; // Green for raised
        negativeColor = 0xff0000; // Red for lowered (shouldn't happen)
        break;
      case 'lower':
        positiveColor = 0xff0000; // Red for lowered (inverted)
        negativeColor = 0x00ff00;
        break;
      case 'smooth':
      case 'flatten':
        positiveColor = 0xffff00; // Yellow for modified
        negativeColor = 0xffff00;
        break;
      case 'roughen':
        positiveColor = 0xff9900; // Orange for roughened
        negativeColor = 0xff9900;
        break;
      case 'set-biome':
        positiveColor = 0x66ffaa; // Teal for set biome
        negativeColor = 0x66ffaa;
        break;
    }

    // Draw affected cells
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        let delta = previewOverlay[idx];
        
        if (Math.abs(delta) > 0.05) {
          // IMPORTANT: our unified grid is treated as samples at cell *centers*.
          // To visualize a cell as a rect around that sample, we shift by half a cell.
          const x = bounds.minX + col * cellSize - cellSize / 2;
          const y = bounds.minY + row * cellSize - cellSize / 2;
          const color = delta > 0 ? positiveColor : negativeColor;
          // Smooth and Roughen get higher alpha for visibility
          let alpha;
          if (this.currentTool === 'smooth' || this.currentTool === 'roughen') {
            alpha = Math.min(0.55, Math.abs(delta) / 5); // Brighter for smooth/roughen
          } else if (this.currentTool === 'set-biome') {
            alpha = 0.6; // Fixed alpha for biome tools
          } else {
            alpha = Math.min(0.35, Math.abs(delta) / 10);
          }
          this.overlayPreview.beginFill(color, alpha);
          this.overlayPreview.drawRect(x, y, cellSize, cellSize);
          this.overlayPreview.endFill();
        }
      }
    }
  }

  /**
   * Clear overlay preview
   */
  clearOverlayPreview() {
    if (this.overlayPreview) {
      try {
        this.overlayPreview.clear();
      } catch (e) {
        // ignore
      }
    }
  }

  /**
   * Destroy overlay preview
   */
  destroyOverlayPreview() {
    if (this.overlayPreview) {
      try {
        this.overlayPreview.destroy();
      } catch (e) {
        // ignore
      }
      this.overlayPreview = null;
    }
  }

  /**
   * Apply smoothing to affected cells
   * @private
   */
  _applySmoothOverlay(heights, rows, cols) {
    const smoothAmount = this.brushStrength * 0.5; // Smoothing factor
    const tempHeights = new Float32Array(heights); // Copy for sampling

    for (const idx of this.affectedCells) {
      const row = Math.floor(idx / cols);
      const col = idx % cols;

      // Average with neighbors (3x3 neighborhood)
      let sum = heights[idx];
      let count = 1;

      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue; // Skip center

          const nRow = row + dr;
          const nCol = col + dc;

          if (nRow >= 0 && nRow < rows && nCol >= 0 && nCol < cols) {
            const nIdx = nRow * cols + nCol;
            sum += tempHeights[nIdx];
            count++;
          }
        }
      }

      const avg = sum / count;
      const delta = (avg - heights[idx]) * smoothAmount;
      this.tempOverlay[idx] += delta;
    }
  }

  /**
   * Apply roughening to affected cells (opposite of smooth)
   * Adds random perturbation to create natural variation
   * @private
   */
  _applyRoughenOverlay(heights, rows, cols) {
    const roughenAmount = this.brushStrength * 0.3; // Reduced to avoid extreme spikes
    const randomAmount = this.brushStrength * 0.4; // Random perturbation
    const tempHeights = new Float32Array(heights); // Copy for sampling

    for (const idx of this.affectedCells) {
      const row = Math.floor(idx / cols);
      const col = idx % cols;

      // Calculate average of neighbors
      let sum = 0;
      let count = 0;

      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue; // Skip center

          const nRow = row + dr;
          const nCol = col + dc;

          if (nRow >= 0 && nRow < rows && nCol >= 0 && nCol < cols) {
            const nIdx = nRow * cols + nCol;
            sum += tempHeights[nIdx];
            count++;
          }
        }
      }

      if (count > 0) {
        const avg = sum / count;
        // Increase difference from average (roughen) + random noise
        const deterministicDelta = (heights[idx] - avg) * roughenAmount;
        // Random value between -1 and 1
        const randomNoise = (Math.random() * 2 - 1) * randomAmount;
        this.tempOverlay[idx] += deterministicDelta + randomNoise;
      }
    }
  }

  /**
   * Save grid changes to scene
   */
  async saveGridChanges() {
    const scene = canvas.scene;
    if (!scene) return;

    try {
      // Save grid to scene flags
      const gridSnapshot = {
        version: 4,
        heights: Array.from(this.renderer.currentGrid.heights),
        biomes: Array.from(this.renderer.currentGrid.biomes || new Uint8Array(this.renderer.currentGrid.heights.length)),
        rivers: Array.from(this.renderer.currentGrid.rivers || new Uint8Array(this.renderer.currentGrid.heights.length)),
        rows: this.renderer.currentGrid.rows,
        cols: this.renderer.currentGrid.cols,
        metadata: this.renderer.currentMetadata,
        timestamp: new Date().toISOString(),
      };

      await scene.setFlag('spaceholder', 'globalMapGrid', gridSnapshot);
      console.log('GlobalMapTools | ✓ Grid saved to scene');
      ui.notifications.info(_t('SPACEHOLDER.GlobalMap.Notifications.MapSaved'));
    } catch (error) {
      console.error('GlobalMapTools | Failed to save:', error);
      ui.notifications.error(_f('SPACEHOLDER.GlobalMap.Errors.SaveGridFailed', { message: error.message }));
    }
  }

  /**
   * Create brush cursor visualization
   */
  createBrushCursor() {
    if (this.brushCursor) {
      try {
        this.brushCursor.destroy();
      } catch (e) {
        // ignore
      }
    }

    this.brushCursor = new PIXI.Graphics();
    this.brushCursor.name = 'globalMapBrushCursor';

    const parent = canvas?.interface || canvas?.stage;
    if (parent) {
      parent.addChild(this.brushCursor);
    }

    this.updateBrushCursorGraphics();
  }
  
  /**
   * Create or update cell highlight for single cell mode
   */
  createCellHighlight() {
    if (this.cellHighlight) {
      try {
        this.cellHighlight.destroy();
      } catch (e) {
        // Already destroyed
      }
    }
    this.cellHighlight = new PIXI.Graphics();
    this.cellHighlight.name = 'global-map-cell-highlight';
    if (this.renderer.container) {
      this.renderer.container.addChild(this.cellHighlight);
    }
  }
  
  /**
   * Update cell highlight position in single cell mode
   */
  updateCellHighlight(worldX, worldY) {
    if (!this.cellHighlight || !this.cellHighlight.parent || !this.renderer.currentGrid) {
      this.createCellHighlight();
      if (!this.cellHighlight) return;
    }
    
    const { cellSize, bounds } = this.renderer.currentMetadata;
    const { rows, cols } = this.renderer.currentGrid;
    
    // Convert world coords to grid coords
    const gridCol = (worldX - bounds.minX) / cellSize;
    const gridRow = (worldY - bounds.minY) / cellSize;
    
    const targetRow = Math.floor(gridRow);
    const targetCol = Math.floor(gridCol);
    
    // Check bounds
    if (targetRow < 0 || targetRow >= rows || targetCol < 0 || targetCol >= cols) {
      try {
        this.cellHighlight.clear();
      } catch (e) {
        this.cellHighlight = null;
      }
      return;
    }
    
    // Draw cell highlight
    try {
      this.cellHighlight.clear();
    } catch (e) {
      this.cellHighlight = null;
      return;
    }
    
    // Get color based on current tool
    let color = 0xffffff;
    switch (this.currentTool) {
      case 'raise': color = 0x00ff00; break;
      case 'lower': color = 0xff0000; break;
      case 'smooth': color = 0xffff00; break;
      case 'roughen': color = 0xff9900; break;
      case 'flatten': color = 0x00ffff; break;
      case 'set-biome': color = 0x66ffaa; break;
    }
    
    // Draw cell with tool color
    // IMPORTANT: our unified grid is treated as samples at cell *centers*.
    // The visual rect is centered on the sample point ⇒ shift by half a cell.
    const x = bounds.minX + targetCol * cellSize - cellSize / 2;
    const y = bounds.minY + targetRow * cellSize - cellSize / 2;
    
    this.cellHighlight.beginFill(color, 0.4);
    this.cellHighlight.drawRect(x, y, cellSize, cellSize);
    this.cellHighlight.endFill();
    
    // Draw outline
    this.cellHighlight.lineStyle(2, color, 0.9);
    this.cellHighlight.drawRect(x, y, cellSize, cellSize);
  }
  
  /**
   * Clear cell highlight
   */
  clearCellHighlight() {
    if (this.cellHighlight) {
      try {
        this.cellHighlight.clear();
      } catch (e) {
        // ignore
      }
    }
  }

  /**
   * Update brush cursor position
   */
  updateBrushCursorPosition(x, y) {
    if (!this.brushCursor) return;
    try {
      this.brushCursor.position.set(x, y);
    } catch (e) {
      // Cursor can get destroyed during canvas rebuild
      this.brushCursor = null;
    }
  }

  /**
   * Update brush cursor graphics
   */
  updateBrushCursorGraphics() {
    if (!this.brushCursor) return;

    try {
      // River/Region editors don't use the brush cursor
      if (this._isRiverTool() || this._isRegionTool()) {
        this.brushCursor.clear();
        return;
      }

      this.brushCursor.clear();

      let color = 0xffffff;
      let alpha = 0.3;

      switch (this.currentTool) {
        case 'raise':
          color = 0x00ff00; // Green
          break;
        case 'lower':
          color = 0xff0000; // Red
          break;
        case 'smooth':
          color = 0xffff00; // Yellow
          break;
        case 'roughen':
          color = 0xff9900; // Orange
          break;
        case 'flatten':
          color = 0x00ffff; // Cyan
          break;
        case 'set-biome':
          color = 0x66ffaa; // Teal for set biome
          break;
      }

      if (this.singleCellMode) {
        // In single cell mode, don't draw cursor (cell highlight handles it)
        // Just keep cursor invisible
      } else {
        // Draw filled circle
        this.brushCursor.beginFill(color, alpha * this.brushStrength);
        this.brushCursor.drawCircle(0, 0, this.brushRadius);
        this.brushCursor.endFill();

        // Draw outline
        this.brushCursor.lineStyle(2, color, 0.7);
        this.brushCursor.drawCircle(0, 0, this.brushRadius);
      }
    } catch (e) {
      // Cursor graphics can be destroyed during canvas rebuild
      this.brushCursor = null;
    }
  }

  /**
   * Update brush UI state (enable/disable controls based on brush active state)
   */
  updateBrushUI() {
    if (!$('#global-map-tools-ui').length) return;
    
    const isActive = this.isBrushActive;
    
    // Update button text and style
    const buttonText = isActive
      ? _t('SPACEHOLDER.GlobalMap.Tools.Brush.Deactivate')
      : _t('SPACEHOLDER.GlobalMap.Tools.Brush.Activate');
    const buttonColor = isActive ? '#cc0000' : '#00aa00';
    $('#brush-toggle').text(buttonText).css('background', buttonColor);
    $('#biome-brush-toggle').text(buttonText).css('background', buttonColor);
    $('#river-brush-toggle').text(buttonText).css('background', buttonColor);
    $('#region-brush-toggle').text(buttonText).css('background', buttonColor);
    
    // Disable/enable tool selection buttons (tool/mode)
    const toolButtons = $('#global-map-height-tool-buttons button, #global-map-biome-tool-buttons button, #global-map-river-mode-buttons button, #global-map-region-mode-buttons button');
    if (toolButtons.length) {
      toolButtons.prop('disabled', isActive);
      toolButtons.css('opacity', isActive ? '0.6' : '1');
      toolButtons.css('cursor', isActive ? 'not-allowed' : 'pointer');
    }
    
    // Disable/enable tab switching
    if (isActive) {
      $('#tab-brush').css('pointer-events', 'none').css('opacity', '0.5');
      $('#tab-biomes').css('pointer-events', 'none').css('opacity', '0.5');
      $('#tab-rivers').css('pointer-events', 'none').css('opacity', '0.5');
      $('#tab-regions').css('pointer-events', 'none').css('opacity', '0.5');
      $('#tab-global').css('pointer-events', 'none').css('opacity', '0.5');
    } else {
      $('#tab-brush').css('pointer-events', 'auto').css('opacity', '1');
      $('#tab-biomes').css('pointer-events', 'auto').css('opacity', '1');
      $('#tab-rivers').css('pointer-events', 'auto').css('opacity', '1');
      $('#tab-regions').css('pointer-events', 'auto').css('opacity', '1');
      $('#tab-global').css('pointer-events', 'auto').css('opacity', '1');
    }
    
    // Update cursor visibility
    if (this.brushCursor) {
      this.brushCursor.visible = isActive && !this.singleCellMode && !this._isRiverTool() && !this._isRegionTool();
    }

    // River editor handles overlay
    if (this.riverHandles || (isActive && this._isRiverTool())) {
      if (isActive && this._isRiverTool()) {
        this._renderRiverHandles();
      } else if (this.riverHandles) {
        try {
          this.riverHandles.clear();
          this.riverHandles.visible = false;
        } catch (e) {
          this.riverHandles = null;
        }
      }
    }

    // Region editor handles overlay
    if (this.regionHandles || (isActive && this._isRegionTool())) {
      if (isActive && this._isRegionTool()) {
        this._renderRegionHandles();
      } else if (this.regionHandles) {
        try {
          this.regionHandles.clear();
          this.regionHandles.visible = false;
        } catch (e) {
          this.regionHandles = null;
        }
      }
    }
    
    // Update cell highlight visibility
    if (this.cellHighlight) {
      this.cellHighlight.visible = isActive && this.singleCellMode;
      if (!isActive || !this.singleCellMode) {
        this.clearCellHighlight();
      }
    }
  }
  
  /**
   * Destroy brush cursor
   */
  destroyBrushCursor() {
    if (this.brushCursor) {
      try {
        this.brushCursor.destroy();
      } catch (e) {
        // ignore
      }
      this.brushCursor = null;
    }
    if (this.cellHighlight) {
      try {
        this.cellHighlight.destroy();
      } catch (e) {
        // ignore
      }
      this.cellHighlight = null;
    }
  }

  /**
   * Show tools UI panel
   */
  showToolsUI() {
    // Remove existing UI
    this.hideToolsUI();

    const t = (key) => _t(key);
    const f = (key, data) => _f(key, data);

    const html = `
      <div id="global-map-tools-ui" style="
        position: fixed;
        top: 100px;
        right: 20px;
        background: rgba(0, 0, 0, 0.85);
        color: white;
        padding: 15px;
        border-radius: 5px;
        min-width: 250px;
        z-index: 1000;
        font-family: var(--font-sans);
        cursor: move;
      ">
        <div id="global-map-tools-titlebar" style="
          cursor: move;
          user-select: none;
          margin: -15px -15px 10px -15px;
          padding: 8px 15px;
          background: rgba(0, 0, 0, 0.5);
          border-bottom: 1px solid #444;
          border-radius: 5px 5px 0 0;
        ">
          <h3 style="margin: 0; display: inline-block; flex: 1;">${t('SPACEHOLDER.GlobalMap.Tools.Title')}</h3>
        </div>

        <div style="display: flex; gap: 5px; margin-bottom: 10px;">
          <button id="tab-brush" data-tab="brush" style="flex: 1; padding: 8px; background: #0066cc; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
            ${t('SPACEHOLDER.GlobalMap.Edge.Settings.Heights')}
          </button>
          <button id="tab-biomes" data-tab="biomes" style="flex: 1; padding: 8px; background: #333; border: none; color: white; border-radius: 3px; cursor: pointer;">
            ${t('SPACEHOLDER.GlobalMap.Edge.Settings.Biomes')}
          </button>
          <button id="tab-rivers" data-tab="rivers" style="flex: 1; padding: 8px; background: #333; border: none; color: white; border-radius: 3px; cursor: pointer;">
            ${t('SPACEHOLDER.GlobalMap.Edge.Settings.RiverLabelsShort')}
          </button>
          <button id="tab-regions" data-tab="regions" style="flex: 1; padding: 8px; background: #333; border: none; color: white; border-radius: 3px; cursor: pointer;">
            ${t('SPACEHOLDER.GlobalMap.Edge.Settings.Regions')}
          </button>
          <button id="tab-global" data-tab="global" style="flex: 1; padding: 8px; background: #333; border: none; color: white; border-radius: 3px; cursor: pointer;">
            ${t('SPACEHOLDER.GlobalMap.Tools.Tabs.Global')}
          </button>
        </div>

        <div id="brush-tab" style="display: block;">
          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.ToolLabel')}:</label>
            <div id="global-map-height-tool-buttons" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px;">
              <button type="button" data-tool="raise" style="padding: 6px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">${t('SPACEHOLDER.GlobalMap.Tools.Heights.RaiseTerrain')}</button>
              <button type="button" data-tool="lower" style="padding: 6px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">${t('SPACEHOLDER.GlobalMap.Tools.Heights.LowerTerrain')}</button>
              <button type="button" data-tool="smooth" style="padding: 6px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">${t('SPACEHOLDER.GlobalMap.Tools.Heights.Smooth')}</button>
              <button type="button" data-tool="roughen" style="padding: 6px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">${t('SPACEHOLDER.GlobalMap.Tools.Heights.Roughen')}</button>
              <button type="button" data-tool="flatten" style="grid-column: 1 / -1; padding: 6px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">${t('SPACEHOLDER.GlobalMap.Tools.Heights.Flatten')}</button>
            </div>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
              <input type="checkbox" id="single-cell-mode" style="margin: 0;">
              <span>${t('SPACEHOLDER.GlobalMap.Tools.Brush.SingleCellMode')}</span>
            </label>
            <div id="radius-container">
              <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Radius')}: <span id="radius-value">${this.brushRadius}</span>px</label>
              <input type="range" id="global-map-radius" min="25" max="500" step="5" value="${this.brushRadius}" style="width: 100%;">
            </div>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Strength')}: <span id="strength-value">${this.brushStrength.toFixed(1)}</span></label>
            <input type="range" id="global-map-strength" min="0.1" max="1.0" step="0.1" value="${this.brushStrength}" style="width: 100%;">
          </div>

          <!-- Height contour opacity (test) -->
          <div style="margin-bottom: 10px; padding: 8px; background: rgba(100, 100, 150, 0.15); border-radius: 3px;">
            <label style="display: block; margin-bottom: 5px; font-weight: bold; font-size: 12px;">${t('SPACEHOLDER.GlobalMap.Tools.Heights.ContourOpacity')}: <span id="height-contour-alpha-value">${(Number.isFinite(this.renderer?.heightContourAlpha) ? this.renderer.heightContourAlpha : 0.8).toFixed(2)}</span></label>
            <input type="range" id="height-contour-alpha" min="0" max="1" step="0.05" value="${Number.isFinite(this.renderer?.heightContourAlpha) ? this.renderer.heightContourAlpha : 0.8}" style="width: 100%;">
            <div style="font-size: 10px; color: #aaa; text-align: center;">${t('SPACEHOLDER.GlobalMap.Tools.Heights.ContourOpacityHint')}</div>
          </div>

          <!-- Flatten target height (only for Flatten tool) -->
          <div id="flatten-target-container" style="margin-bottom: 10px; display: none; padding: 8px; background: rgba(100, 100, 150, 0.15); border-radius: 3px;">
            <label style="display: block; margin-bottom: 5px; font-weight: bold; font-size: 12px;">${t('SPACEHOLDER.GlobalMap.Tools.Heights.TargetHeight')}: <span id="flatten-target-value">${Math.round(this.targetHeight)}</span>%</label>
            <input type="range" id="flatten-target-height" min="0" max="100" step="1" value="${Math.round(this.targetHeight)}" style="width: 100%;">
            <div style="font-size: 10px; color: #aaa; text-align: center; margin-top: 4px;">${t('SPACEHOLDER.GlobalMap.Tools.Heights.FlattenPipetteHint')}</div>
          </div>
          
          <!-- Height Filter -->
          <div style="margin-bottom: 10px; padding: 8px; background: rgba(100, 150, 100, 0.15); border-radius: 3px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <input type="checkbox" id="height-filter-enabled" style="margin: 0;">
              <span style="font-weight: bold; font-size: 12px;">${t('SPACEHOLDER.GlobalMap.Tools.Filters.FilterByHeight')}</span>
            </label>
            <div style="display: none;" id="height-filter-controls">
              <div style="margin-bottom: 6px;">
                <label style="display: block; margin-bottom: 2px; font-size: 10px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Min')}: <span id="height-filter-min-value">0</span>%</label>
                <input type="range" id="height-filter-min" min="0" max="100" step="1" value="0" style="width: 100%;" disabled>
              </div>
              <div style="margin-bottom: 6px;">
                <label style="display: block; margin-bottom: 2px; font-size: 10px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Max')}: <span id="height-filter-max-value">100</span>%</label>
                <input type="range" id="height-filter-max" min="0" max="100" step="1" value="100" style="width: 100%;" disabled>
              </div>
              <div style="font-size: 10px; color: #aaa; text-align: center;">
                ${t('SPACEHOLDER.GlobalMap.Tools.Common.Range')}: <span id="height-filter-display">0-100</span>%
              </div>
            </div>
          </div>
          
          <!-- Biome Filter for Height Tools -->
          <div style="margin-bottom: 10px; padding: 8px; background: rgba(100, 150, 100, 0.15); border-radius: 3px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <input type="checkbox" id="height-tool-biome-filter-enabled" style="margin: 0;">
              <span style="font-weight: bold; font-size: 12px;">${t('SPACEHOLDER.GlobalMap.Tools.Filters.FilterByBiome')}</span>
            </label>
            <div style="display: none;" id="height-tool-biome-filter-controls">
              <div id="height-filter-biome-matrix" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; margin-bottom: 5px;"></div>
              <div style="font-size: 9px; color: #aaa; text-align: center;">
                ${t('SPACEHOLDER.GlobalMap.Tools.Heights.BiomeFilterHint')}
              </div>
            </div>
          </div>
          
          <button id="brush-toggle" style="width: 100%; padding: 10px; margin-top: 10px; background: #00aa00; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
            ${t('SPACEHOLDER.GlobalMap.Tools.Brush.Activate')}
          </button>
        </div>

        <div id="biomes-tab" style="display: none;">
          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.ToolLabel')}:</label>
            <div id="global-map-biome-tool-buttons" style="display: flex; gap: 4px;">
              <button type="button" data-tool="set-biome" style="flex: 1; padding: 6px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">${t('SPACEHOLDER.GlobalMap.Tools.Biomes.SetBiome')}</button>
            </div>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
              <input type="checkbox" id="biome-single-cell-mode" style="margin: 0;">
              <span>${t('SPACEHOLDER.GlobalMap.Tools.Brush.SingleCellMode')}</span>
            </label>
            <div id="biome-radius-container">
              <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Radius')}: <span id="biome-radius-value">${this.brushRadius}</span>px</label>
              <input type="range" id="global-map-biome-radius" min="25" max="500" step="5" value="${this.brushRadius}" style="width: 100%;">
            </div>
          </div>

          <!-- Set Biome Controls -->
          <div id="set-biome-controls" style="margin-bottom: 10px;">
            <div style="margin-bottom: 8px;">
              <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Edge.Inspector.Biome')}:</label>
              <select id="set-biome-select" style="width: 100%; padding: 5px;"></select>
            </div>
            
            <!-- Biome Palette -->
            <div style="margin-top: 10px;">
              <label style="display: block; margin-bottom: 5px; font-size: 11px;">${t('SPACEHOLDER.GlobalMap.Tools.Biomes.PaletteLabel')}:</label>
              <div id="biome-preset-matrix" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; margin-bottom: 5px;"></div>
              <div style="font-size: 9px; color: #aaa; text-align: center;">
                ${t('SPACEHOLDER.GlobalMap.Tools.Biomes.PaletteHint')}
              </div>
            </div>
          </div>
          
          <!-- Height Filter for Biome Tools -->
          <div style="margin-bottom: 10px; padding: 8px; background: rgba(100, 100, 150, 0.15); border-radius: 3px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <input type="checkbox" id="biome-tool-height-filter-enabled" style="margin: 0;">
              <span style="font-weight: bold; font-size: 12px;">${t('SPACEHOLDER.GlobalMap.Tools.Filters.FilterByHeight')}</span>
            </label>
            <div style="display: none;" id="biome-tool-height-filter-controls">
              <div style="margin-bottom: 6px;">
                <label style="display: block; margin-bottom: 2px; font-size: 10px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Min')}: <span id="biome-tool-height-min-value">0</span>%</label>
                <input type="range" id="biome-tool-height-min" min="0" max="100" step="1" value="0" style="width: 100%;" disabled>
              </div>
              <div style="margin-bottom: 6px;">
                <label style="display: block; margin-bottom: 2px; font-size: 10px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Max')}: <span id="biome-tool-height-max-value">100</span>%</label>
                <input type="range" id="biome-tool-height-max" min="0" max="100" step="1" value="100" style="width: 100%;" disabled>
              </div>
              <div style="font-size: 10px; color: #aaa; text-align: center;">
                ${t('SPACEHOLDER.GlobalMap.Tools.Common.Range')}: <span id="biome-tool-height-display">0-100</span>%
              </div>
            </div>
          </div>
          
          <!-- Biome Filter for Biome Tools -->
          <div style="margin-bottom: 10px; padding: 8px; background: rgba(100, 100, 150, 0.15); border-radius: 3px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <input type="checkbox" id="biome-tool-biome-filter-enabled" style="margin: 0;">
              <span style="font-weight: bold; font-size: 12px;">${t('SPACEHOLDER.GlobalMap.Tools.Filters.FilterByBiome')}</span>
            </label>
            <div style="display: none;" id="biome-tool-biome-filter-controls">
              <div id="biome-filter-biome-matrix" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; margin-bottom: 5px;"></div>
              <div style="font-size: 9px; color: #aaa; text-align: center;">
                ${t('SPACEHOLDER.GlobalMap.Tools.Biomes.BiomeFilterExcludeHint')}
              </div>
            </div>
          </div>

          <button id="open-biome-editor" style="width: 100%; padding: 10px; margin-top: 8px; background: #4466cc; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
            ${t('SPACEHOLDER.GlobalMap.Tools.Biomes.OpenEditor')}
          </button>
          <div style="font-size: 10px; color: #aaa; text-align: center; margin-top: 4px;">
            ${t('SPACEHOLDER.GlobalMap.Tools.Biomes.OverridesFileNote')} <b>worlds/.../global-maps/biome-overrides.json</b>
          </div>
          
          <button id="biome-brush-toggle" style="width: 100%; padding: 10px; margin-top: 10px; background: #00aa00; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
            ${t('SPACEHOLDER.GlobalMap.Tools.Brush.Activate')}
          </button>
        </div>

        <div id="rivers-tab" style="display: none;">
          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Rivers.RiverLabel')}:</label>
            <select id="global-map-river-select" style="width: 100%; padding: 5px;"></select>
          </div>

          <div style="display: flex; gap: 5px; margin-bottom: 10px;">
            <button id="river-new" style="flex: 1; padding: 8px; background: #0066cc; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">${t('SPACEHOLDER.Actions.New')}</button>
            <button id="river-rename" style="flex: 1; padding: 8px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Rename')}</button>
            <button id="river-delete" style="flex: 1; padding: 8px; background: #883333; border: none; color: white; border-radius: 3px; cursor: pointer;">${t('SPACEHOLDER.Actions.Delete')}</button>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.ModeLabel')}:</label>
            <div id="global-map-river-mode-buttons" style="display: flex; gap: 4px;">
              <button type="button" data-tool="river-draw" style="flex: 1; padding: 6px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">${t('SPACEHOLDER.GlobalMap.Tools.Rivers.Modes.DrawPoints')}</button>
              <button type="button" data-tool="river-edit" style="flex: 1; padding: 6px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">${t('SPACEHOLDER.Actions.Edit')}</button>
            </div>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
              <input type="checkbox" id="river-snap-endpoints" style="margin: 0;" checked>
              <span>${t('SPACEHOLDER.GlobalMap.Tools.Rivers.SnapToEndpoints')}</span>
            </label>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Rivers.DefaultPointWidth')}: <span id="river-default-width-value">${this.riverDefaultPointWidth}</span>px</label>
            <input type="range" id="river-default-width" min="1" max="200" step="1" value="${this.riverDefaultPointWidth}" style="width: 100%;">
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Rivers.SelectedPointWidth')}: <span id="river-point-width-value">-</span>px</label>
            <input type="range" id="river-point-width" min="1" max="200" step="1" value="${this.riverDefaultPointWidth}" style="width: 100%;" disabled>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Labels')}:</label>
            <select id="river-label-mode" style="width: 100%; padding: 5px;">
              <option value="hover" selected>${t('SPACEHOLDER.GlobalMap.Edge.Modes.Common.HoverShort')}</option>
              <option value="always">${t('SPACEHOLDER.GlobalMap.Edge.Modes.Common.Always')}</option>
              <option value="off">${t('SPACEHOLDER.GlobalMap.Edge.Modes.Common.Off')}</option>
            </select>
          </div>

          <div style="display: flex; gap: 5px; margin-bottom: 10px;">
            <button id="river-finish" style="flex: 1; padding: 8px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Finish')}</button>
            <button id="river-save" style="flex: 1; padding: 8px; background: #00aa00; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">${t('SPACEHOLDER.GlobalMap.Tools.Rivers.Save')}</button>
          </div>

          <div style="font-size: 10px; color: #aaa; line-height: 1.3; margin-bottom: 10px;">
            <div>${t('SPACEHOLDER.GlobalMap.Tools.Rivers.Help.Draw')}</div>
            <div>${t('SPACEHOLDER.GlobalMap.Tools.Rivers.Help.Edit')}</div>
          </div>

          <button id="river-brush-toggle" style="width: 100%; padding: 10px; margin-top: 10px; background: #00aa00; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
            ${t('SPACEHOLDER.GlobalMap.Tools.Brush.Activate')}
          </button>
        </div>

        <div id="regions-tab" style="display: none;">
          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Regions.RegionLabel')}:</label>
            <select id="global-map-region-select" style="width: 100%; padding: 5px;"></select>
          </div>

          <div style="display: flex; gap: 5px; margin-bottom: 10px;">
            <button id="region-new" style="flex: 1; padding: 8px; background: #0066cc; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">${t('SPACEHOLDER.Actions.New')}</button>
            <button id="region-rename" style="flex: 1; padding: 8px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Rename')}</button>
            <button id="region-delete" style="flex: 1; padding: 8px; background: #883333; border: none; color: white; border-radius: 3px; cursor: pointer;">${t('SPACEHOLDER.Actions.Delete')}</button>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.ModeLabel')}:</label>
            <div id="global-map-region-mode-buttons" style="display: flex; gap: 4px;">
              <button type="button" data-tool="region-draw" style="flex: 1; padding: 6px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">${t('SPACEHOLDER.GlobalMap.Tools.Regions.Modes.DrawPoints')}</button>
              <button type="button" data-tool="region-edit" style="flex: 1; padding: 6px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">${t('SPACEHOLDER.Actions.Edit')}</button>
            </div>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Labels')}:</label>
            <select id="region-label-mode" style="width: 100%; padding: 5px;">
              <option value="hover" selected>${t('SPACEHOLDER.GlobalMap.Edge.Modes.Common.HoverShort')}</option>
              <option value="always">${t('SPACEHOLDER.GlobalMap.Edge.Modes.Common.Always')}</option>
              <option value="off">${t('SPACEHOLDER.GlobalMap.Edge.Modes.Common.Off')}</option>
            </select>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Tools.Regions.Smoothing.Label')}:</label>
            <select id="region-smooth-iterations" style="width: 100%; padding: 5px;">
              <option value="0">${t('SPACEHOLDER.GlobalMap.Tools.Regions.Smoothing.Options.OffExact')}</option>
              <option value="1" selected>${t('SPACEHOLDER.GlobalMap.Tools.Regions.Smoothing.Options.Low')}</option>
              <option value="2">${t('SPACEHOLDER.GlobalMap.Tools.Regions.Smoothing.Options.Medium')}</option>
              <option value="3">${t('SPACEHOLDER.GlobalMap.Tools.Regions.Smoothing.Options.High')}</option>
              <option value="4">${t('SPACEHOLDER.GlobalMap.Tools.Regions.Smoothing.Options.VeryHigh')}</option>
            </select>
            <div style="font-size: 10px; color: #aaa; margin-top: 4px;">${t('SPACEHOLDER.GlobalMap.Tools.Regions.Smoothing.Note')}</div>
          </div>

          <div style="margin-bottom: 10px; padding: 8px; background: rgba(100, 100, 150, 0.15); border-radius: 3px;">
            <label style="display: block; margin-bottom: 6px; font-weight: bold; font-size: 12px;">${t('SPACEHOLDER.GlobalMap.Tools.Regions.Style.Fill')}</label>
            <div style="display: flex; gap: 6px; align-items: center; margin-bottom: 6px;">
              <input type="color" id="region-fill-color" value="#2e7dff" style="width: 44px; height: 28px; padding: 0; border: none; background: transparent;">
              <div style="flex: 1; font-size: 10px; color: #aaa;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Alpha')}: <span id="region-fill-alpha-value">${this.regionDefaultFillAlpha.toFixed(2)}</span></div>
            </div>
            <input type="range" id="region-fill-alpha" min="0" max="1" step="0.05" value="${this.regionDefaultFillAlpha}" style="width: 100%;">
          </div>

          <div style="margin-bottom: 10px; padding: 8px; background: rgba(100, 100, 150, 0.15); border-radius: 3px;">
            <label style="display: block; margin-bottom: 6px; font-weight: bold; font-size: 12px;">${t('SPACEHOLDER.GlobalMap.Tools.Regions.Style.Stroke')}</label>
            <div style="display: flex; gap: 6px; align-items: center; margin-bottom: 6px;">
              <input type="color" id="region-stroke-color" value="#2e7dff" style="width: 44px; height: 28px; padding: 0; border: none; background: transparent;">
              <div style="flex: 1; font-size: 10px; color: #aaa;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Alpha')}: <span id="region-stroke-alpha-value">${this.regionDefaultStrokeAlpha.toFixed(2)}</span></div>
            </div>
            <input type="range" id="region-stroke-alpha" min="0" max="1" step="0.05" value="${this.regionDefaultStrokeAlpha}" style="width: 100%; margin-bottom: 8px;">
            <div style="font-size: 10px; color: #aaa; margin-bottom: 4px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Width')}: <span id="region-stroke-width-value">${Math.round(this.regionDefaultStrokeWidth)}</span>px</div>
            <input type="range" id="region-stroke-width" min="1" max="40" step="1" value="${Math.round(this.regionDefaultStrokeWidth)}" style="width: 100%;">
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">${t('SPACEHOLDER.GlobalMap.Common.JournalUuid')} ${t('SPACEHOLDER.Common.Optional')}:</label>
            <input type="text" id="region-journal-uuid" placeholder="${t('SPACEHOLDER.GlobalMap.Tools.Regions.JournalUuidPlaceholder')}" style="width: 100%; padding: 5px;">
            <div style="display: flex; gap: 5px; margin-top: 6px;">
              <button id="region-journal-open" style="flex: 1; padding: 8px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Open')}</button>
              <button id="region-journal-clear" style="flex: 1; padding: 8px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer;">${t('SPACEHOLDER.Actions.Clear')}</button>
            </div>
          </div>

          <div style="display: flex; gap: 5px; margin-bottom: 10px;">
            <button id="region-finish" style="flex: 1; padding: 8px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Finish')}</button>
            <button id="region-save" style="flex: 1; padding: 8px; background: #00aa00; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">${t('SPACEHOLDER.GlobalMap.Tools.Regions.Save')}</button>
          </div>

          <div style="font-size: 10px; color: #aaa; line-height: 1.3; margin-bottom: 10px;">
            <div>${t('SPACEHOLDER.GlobalMap.Tools.Regions.Help.Draw')}</div>
            <div>${t('SPACEHOLDER.GlobalMap.Tools.Regions.Help.Edit')}</div>
          </div>

          <button id="region-brush-toggle" style="width: 100%; padding: 10px; margin-top: 10px; background: #00aa00; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
            ${t('SPACEHOLDER.GlobalMap.Tools.Brush.Activate')}
          </button>
        </div>

        <div id="global-tab" style="display: none;">
          <!-- Smooth Operations -->
          <div style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #555;">
            <label style="display: block; margin-bottom: 5px; font-weight: bold; color: #ffff00;">${t('SPACEHOLDER.GlobalMap.Tools.Global.Smoothing')}:</label>
            <div style="margin-bottom: 10px;">
              <label style="display: block; margin-bottom: 5px; font-size: 12px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Strength')}: <span id="global-smooth-strength-value">${this.globalSmoothStrength.toFixed(1)}</span></label>
              <input type="range" id="global-smooth-strength" min="0.1" max="1.0" step="0.1" value="${this.globalSmoothStrength}" style="width: 100%;">
            </div>
            <button id="global-smooth-btn" style="width: 100%; padding: 8px; margin-bottom: 5px; background: #ffff00; color: black; border: none; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 12px;">
              ${t('SPACEHOLDER.GlobalMap.Tools.Global.Smooth1')}
            </button>
            <button id="global-smooth-3-btn" style="width: 100%; padding: 8px; background: #ffdd00; color: black; border: none; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 12px;">
              ${t('SPACEHOLDER.GlobalMap.Tools.Global.Smooth3')}
            </button>
          </div>

          <!-- Unified Replace Tool -->
          <div style="margin-bottom: 15px; padding: 10px; background: rgba(150, 150, 100, 0.1); border-radius: 3px;">
            <label style="display: block; margin-bottom: 8px; font-weight: bold; color: #ffff99; font-size: 13px;">${t('SPACEHOLDER.GlobalMap.Tools.Replace.Title')}:</label>
            
            <!-- Filters Section -->
            <div style="margin-bottom: 12px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 3px;">
              <label style="display: block; margin-bottom: 6px; font-weight: bold; color: #ccccff; font-size: 11px;">${t('SPACEHOLDER.GlobalMap.Tools.Replace.Filters.Title')}:</label>
              
              <!-- Height Filter -->
              <div style="margin-bottom: 8px;">
                <label style="display: flex; align-items: center; gap: 6px; font-size: 10px;">
                  <input type="checkbox" id="replace-use-height" style="margin: 0;">
                  <span>${t('SPACEHOLDER.GlobalMap.Tools.Replace.Filters.HeightRange')}:</span>
                </label>
                <div style="margin-left: 20px; margin-top: 4px;">
                  <label style="display: block; margin-bottom: 2px; font-size: 9px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Min')}: <span id="replace-height-min-value">0</span>%</label>
                  <input type="range" id="replace-height-min" min="0" max="100" step="1" value="0" style="width: 100%; margin-bottom: 4px;" disabled>
                  <label style="display: block; margin-bottom: 2px; font-size: 9px;">${t('SPACEHOLDER.GlobalMap.Tools.Common.Max')}: <span id="replace-height-max-value">100</span>%</label>
                  <input type="range" id="replace-height-max" min="0" max="100" step="1" value="100" style="width: 100%;" disabled>
                </div>
              </div>
              
              <!-- Biome Filter -->
              <div style="margin-bottom: 8px;">
                <label style="display: flex; align-items: center; gap: 6px; font-size: 10px;">
                  <input type="checkbox" id="replace-use-biome" style="margin: 0;">
                  <span>${t('SPACEHOLDER.GlobalMap.Tools.Replace.Filters.SourceBiome')}:</span>
                </label>
                <div id="replace-source-biome-matrix" style="display: none; display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; margin-top: 4px; opacity: 0.6;"></div>
              </div>
            </div>
            
            <!-- Actions Section -->
            <div style="margin-bottom: 12px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 3px;">
              <label style="display: block; margin-bottom: 6px; font-weight: bold; color: #ccffcc; font-size: 11px;">${t('SPACEHOLDER.GlobalMap.Tools.Replace.Actions.Title')}:</label>
              
              <!-- Set Height Action -->
              <div style="margin-bottom: 8px;">
                <label style="display: flex; align-items: center; gap: 6px; font-size: 10px;">
                  <input type="checkbox" id="replace-set-height" style="margin: 0;">
                  <span>${t('SPACEHOLDER.GlobalMap.Tools.Replace.Actions.SetHeight')}:</span>
                  <input type="range" id="replace-set-height-val" min="0" max="100" step="1" value="50" style="flex: 1;" disabled>
                  <span id="replace-set-height-display" style="font-size: 9px; color: #aaa; min-width: 25px;">50</span>
                </label>
              </div>
              
              <!-- Set Biome Action -->
              <div style="margin-bottom: 0;">
                <label style="display: flex; align-items: center; gap: 6px; font-size: 10px;">
                  <input type="checkbox" id="replace-set-biome" style="margin: 0;">
                  <span>${t('SPACEHOLDER.GlobalMap.Tools.Replace.Actions.SetBiome')}:</span>
                </label>
                <div id="replace-target-biome-matrix" style="display: none; display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; margin-top: 4px; opacity: 0.6;"></div>
              </div>
            </div>
            
            <!-- Preview and Action -->
            <div style="margin-bottom: 8px; padding: 6px; background: rgba(0,0,0,0.2); border-radius: 3px; font-size: 10px; color: #aaa;">
              ${t('SPACEHOLDER.GlobalMap.Tools.Replace.Preview.Matches')}: <span id="replace-preview-count">0</span> ${t('SPACEHOLDER.GlobalMap.Tools.Replace.Preview.Cells')}
            </div>
            
            <button id="replace-apply-btn" style="width: 100%; padding: 6px; margin-bottom: 4px; background: #88dd88; color: black; border: none; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">
              ${t('SPACEHOLDER.GlobalMap.Tools.Replace.Replace')}
            </button>
            <button id="replace-flatten-btn" style="width: 100%; padding: 6px; background: #ffaa44; color: black; border: none; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">
              ${t('SPACEHOLDER.GlobalMap.Tools.Replace.FlattenAll')}
            </button>
          </div>
        </div>

        <div style="display: flex; gap: 5px; margin-top: 5px;">
          <button id="global-map-undo" style="flex: 1; padding: 8px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">${t('SPACEHOLDER.Actions.Undo')}</button>
          <button id="global-map-redo" style="flex: 1; padding: 8px; background: #444; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">${t('SPACEHOLDER.Actions.Redo')}</button>
        </div>

        <button id="global-map-exit" style="width: 100%; padding: 8px; margin-top: 5px; background: #888; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
          ${t('SPACEHOLDER.GlobalMap.Tools.Common.Exit')}
        </button>
      </div>
    `;

    $('body').append(html);

    // ===== DRAGGABLE UI =====
    // Make the tools UI draggable
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    const toolsUI = $('#global-map-tools-ui');
    const titlebar = $('#global-map-tools-titlebar');
    
    titlebar.on('mousedown', (e) => {
      if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
        isDragging = true;
        const rect = toolsUI[0].getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        titlebar.css('background', 'rgba(0, 100, 200, 0.5)');
        e.preventDefault();
      }
    });
    
    // IMPORTANT: use a namespace and remove previous handlers to avoid accumulation after reopening the UI
    const docNs = this._uiDocNamespace || '.globalMapToolsUI';
    $(document).off(`mousemove${docNs}`).off(`mouseup${docNs}`);

    $(document).on(`mousemove${docNs}`, (e) => {
      if (isDragging) {
        toolsUI.css({
          'right': 'auto',
          'left': (e.clientX - dragOffsetX) + 'px',
          'top': (e.clientY - dragOffsetY) + 'px'
        });
      }
    });
    
    $(document).on(`mouseup${docNs}`, () => {
      if (isDragging) {
        isDragging = false;
        titlebar.css('background', 'rgba(0, 0, 0, 0.5)');
      }
    });

    // Generate biome palette (used in Set Biome)
    const generateBiomeMatrix = () => {
      const select = $('#set-biome-select');
      const matrix = $('#biome-preset-matrix');
      
      const biomes = this.processing.biomeResolver.listBiomes();
      select.empty();
      matrix.empty();
      
      for (const b of biomes) {
        select.append(
          $('<option></option>')
            .attr('value', b.id)
            .text(f('SPACEHOLDER.GlobalMap.Tools.Biomes.SelectOption', { name: b.name, id: b.id }))
        );
      }

      // Ensure current selection exists
      if (!biomes.some(b => b.id === this.setBiomeId)) {
        this.setBiomeId = this.processing.biomeResolver.getDefaultBiomeId();
      }
      select.val(this.setBiomeId);

      for (const b of biomes) {
        const biomeId = b.id;
        const color = this.processing.biomeResolver.getBiomeColor(biomeId);
        const colorHex = '#' + color.toString(16).padStart(6, '0');
        const pattern = this.processing.biomeResolver.getBiomePattern(biomeId);
        const isSelected = biomeId === this.setBiomeId;

        const cellStyles = {
          'aspect-ratio': '1',
          'cursor': 'pointer',
          'border': isSelected ? '2px solid #ffffff' : '1px solid rgba(0,0,0,0.3)',
          'border-radius': '2px',
          'box-shadow': isSelected ? '0 0 0 2px rgba(255,255,255,0.3) inset' : 'none',
          'position': 'relative'
        };

        // Add pattern or solid background (simple CSS preview)
        if (pattern) {
          const patternColor = this._getPatternColor(pattern, color);
          if (patternColor) {
            cellStyles['background'] = `repeating-linear-gradient(
              45deg,
              ${colorHex},
              ${colorHex} 8px,
              ${patternColor} 8px,
              ${patternColor} 16px
            )`;
          } else {
            cellStyles['background-color'] = colorHex;
          }
        } else {
          cellStyles['background-color'] = colorHex;
        }

        const cell = $('<div></div>').css(cellStyles).attr({
          'data-biome-id': biomeId,
          'title': f('SPACEHOLDER.GlobalMap.Tools.Biomes.CellTitle', { name: b.name, id: biomeId, rank: b.renderRank })
        });

        cell.on('click', () => {
          this.setBiomeId = biomeId;
          $('#set-biome-select').val(String(biomeId));

          // Update selection highlight
          $('#biome-preset-matrix').children().css('border', '1px solid rgba(0,0,0,0.3)').css('box-shadow', 'none');
          cell.css('border', '2px solid #ffffff').css('box-shadow', '0 0 0 2px rgba(255,255,255,0.3) inset');
        });

        matrix.append(cell);
      }
    };

    // Expose for external refresh (biome editor)
    this._generateBiomeMatrix = generateBiomeMatrix;

    // Generate biome selection matrix for Height tools filter (allowed biomes)
    this._generateHeightFilterBiomeMatrix = () => {
      const matrix = $('#height-filter-biome-matrix');
      matrix.empty();

      const biomes = this.processing.biomeResolver.listBiomes();
      for (const b of biomes) {
        const biomeId = b.id;
        const color = this.processing.biomeResolver.getBiomeColor(biomeId);
        const colorHex = '#' + color.toString(16).padStart(6, '0');
        const pattern = this.processing.biomeResolver.getBiomePattern(biomeId);
        const selected = this.heightFilterBiomeIds.has(biomeId);

        const cellStyles = {
          'aspect-ratio': '1',
          'cursor': 'pointer',
          'border': selected ? '2px solid #ffffff' : '1px solid rgba(0,0,0,0.3)',
          'border-radius': '2px',
          'box-shadow': selected ? '0 0 0 2px rgba(255,255,255,0.3) inset' : 'none',
          'position': 'relative',
          'min-width': '50px',
          'min-height': '50px'
        };

        // Add pattern or solid background
        if (pattern) {
          const patternColor = this._getPatternColor(pattern, color);
          if (patternColor) {
            cellStyles['background'] = `repeating-linear-gradient(
              45deg,
              ${colorHex},
              ${colorHex} 10px,
              ${patternColor} 10px,
              ${patternColor} 20px
            )`;
          } else {
            cellStyles['background-color'] = colorHex;
          }
        } else {
          cellStyles['background-color'] = colorHex;
        }

        const cell = $('<div></div>').css(cellStyles).attr({
          'data-biome-id': biomeId,
          'title': f('SPACEHOLDER.GlobalMap.Tools.Biomes.CellTitle', { name: b.name, id: biomeId, rank: b.renderRank })
        });

        cell.on('click', () => {
          if (this.heightFilterBiomeIds.has(biomeId)) {
            this.heightFilterBiomeIds.delete(biomeId);
          } else {
            this.heightFilterBiomeIds.add(biomeId);
          }
          const isSel = this.heightFilterBiomeIds.has(biomeId);
          cell.css('border', isSel ? '2px solid #ffffff' : '1px solid rgba(0,0,0,0.3)');
          cell.css('box-shadow', isSel ? '0 0 0 2px rgba(255,255,255,0.3) inset' : 'none');
        });

        matrix.append(cell);
      }
    };

    // Generate biome selection matrix for Biome tools filter (excluded biomes)
    this._generateBiomeToolBiomeFilterMatrix = () => {
      const matrix = $('#biome-filter-biome-matrix');
      matrix.empty();

      const biomes = this.processing.biomeResolver.listBiomes();
      for (const b of biomes) {
        const biomeId = b.id;
        const color = this.processing.biomeResolver.getBiomeColor(biomeId);
        const colorHex = '#' + color.toString(16).padStart(6, '0');
        const pattern = this.processing.biomeResolver.getBiomePattern(biomeId);
        const excluded = this.biomeFilterExcludedIds.has(biomeId);

        const cellStyles = {
          'aspect-ratio': '1',
          'cursor': 'pointer',
          'border': excluded ? '2px solid #ff6666' : '1px solid rgba(0,0,0,0.3)',
          'border-radius': '2px',
          'position': 'relative',
          'min-width': '50px',
          'min-height': '50px'
        };

        // Add pattern or solid background
        if (pattern) {
          const patternColor = this._getPatternColor(pattern, color);
          if (patternColor) {
            cellStyles['background'] = `repeating-linear-gradient(
              45deg,
              ${colorHex},
              ${colorHex} 10px,
              ${patternColor} 10px,
              ${patternColor} 20px
            )`;
          } else {
            cellStyles['background-color'] = colorHex;
          }
        } else {
          cellStyles['background-color'] = colorHex;
        }

        const cell = $('<div></div>').css(cellStyles).attr({
          'data-biome-id': biomeId,
          'title': f('SPACEHOLDER.GlobalMap.Tools.Biomes.CellTitle', { name: b.name, id: biomeId, rank: b.renderRank })
        });

        // Add small X overlay when excluded
        if (excluded) {
          const overlay = $('<div></div>').css({
            'position': 'absolute','inset':'0','display':'flex','align-items':'center','justify-content':'center','color':'#ffdddd','font-weight':'bold','text-shadow':'0 0 2px #000','font-size':'14px','background':'rgba(0,0,0,0.3)'
          }).text('×');
          cell.append(overlay);
        }

        cell.on('click', () => {
          if (this.biomeFilterExcludedIds.has(biomeId)) {
            this.biomeFilterExcludedIds.delete(biomeId);
          } else {
            this.biomeFilterExcludedIds.add(biomeId);
          }
          // Regenerate to refresh overlays/styles
          this._generateBiomeToolBiomeFilterMatrix();
        });

        matrix.append(cell);
      }
    };

    // Generate replace source biome selection matrix
    this._generateReplaceSourceBiomeMatrix = () => {
      const matrix = $('#replace-source-biome-matrix');
      matrix.empty();
      const selectedBiomes = this.replaceSourceBiomeIds;

      const biomes = this.processing.biomeResolver.listBiomes();
      for (const b of biomes) {
        const biomeId = b.id;
        const color = this.processing.biomeResolver.getBiomeColor(biomeId);
        const colorHex = '#' + color.toString(16).padStart(6, '0');
        const pattern = this.processing.biomeResolver.getBiomePattern(biomeId);
        const isSelected = selectedBiomes.has(biomeId);

        const cellStyles = {
          'aspect-ratio': '1',
          'cursor': 'pointer',
          'border': isSelected ? '2px solid #ffff00' : '1px solid rgba(0,0,0,0.3)',
          'border-radius': '2px',
          'position': 'relative',
          'min-width': '40px',
          'min-height': '40px'
        };

        // Add pattern or solid background
        if (pattern) {
          const patternColor = this._getPatternColor(pattern, color);
          if (patternColor) {
            cellStyles['background'] = `repeating-linear-gradient(
              45deg,
              ${colorHex},
              ${colorHex} 10px,
              ${patternColor} 10px,
              ${patternColor} 20px
            )`;
          } else {
            cellStyles['background-color'] = colorHex;
          }
        } else {
          cellStyles['background-color'] = colorHex;
        }

        const cell = $('<div></div>').css(cellStyles).attr({
          'data-biome-id': biomeId,
          'title': f('SPACEHOLDER.GlobalMap.Tools.Biomes.CellTitle', { name: b.name, id: biomeId, rank: b.renderRank })
        });

        cell.on('click', () => {
          if (this.replaceSourceBiomeIds.has(biomeId)) {
            this.replaceSourceBiomeIds.delete(biomeId);
          } else {
            this.replaceSourceBiomeIds.add(biomeId);
          }
          this._generateReplaceSourceBiomeMatrix();
          this.updateReplacePreview();
        });

        matrix.append(cell);
      }
    };

    // Generate replace target biome selection matrix
    this._generateReplaceTargetBiomeMatrix = () => {
      const matrix = $('#replace-target-biome-matrix');
      matrix.empty();
      const selectedBiome = this.replaceTargetBiomeId;

      const biomes = this.processing.biomeResolver.listBiomes();
      for (const b of biomes) {
        const biomeId = b.id;
        const color = this.processing.biomeResolver.getBiomeColor(biomeId);
        const colorHex = '#' + color.toString(16).padStart(6, '0');
        const pattern = this.processing.biomeResolver.getBiomePattern(biomeId);
        const isSelected = selectedBiome === biomeId;

        const cellStyles = {
          'aspect-ratio': '1',
          'cursor': 'pointer',
          'border': isSelected ? '2px solid #00ff00' : '1px solid rgba(0,0,0,0.3)',
          'border-radius': '2px',
          'position': 'relative',
          'min-width': '40px',
          'min-height': '40px'
        };

        // Add pattern or solid background
        if (pattern) {
          const patternColor = this._getPatternColor(pattern, color);
          if (patternColor) {
            cellStyles['background'] = `repeating-linear-gradient(
              45deg,
              ${colorHex},
              ${colorHex} 10px,
              ${patternColor} 10px,
              ${patternColor} 20px
            )`;
          } else {
            cellStyles['background-color'] = colorHex;
          }
        } else {
          cellStyles['background-color'] = colorHex;
        }

        const cell = $('<div></div>').css(cellStyles).attr({
          'data-biome-id': biomeId,
          'title': f('SPACEHOLDER.GlobalMap.Tools.Biomes.CellTitle', { name: b.name, id: biomeId, rank: b.renderRank })
        });

        cell.on('click', () => {
          this.replaceTargetBiomeId = biomeId;
          this._generateReplaceTargetBiomeMatrix();
        });

        matrix.append(cell);
      }
    };

    // Update UI visibility based on tool (biomes tab)
    const updateBiomeToolUI = (_tool) => {
      // Only one biome tool remains.
      this._selectedBiomesTool = 'set-biome';

      $('#set-biome-controls').show();

      // Generate palette/select if not already generated
      if ($('#biome-preset-matrix').children().length === 0 || $('#set-biome-select').children().length === 0) {
        generateBiomeMatrix();
      }
    };

    // Event listeners for Heights tab
    const updateHeightToolUI = (tool) => {
      const isFlatten = tool === 'flatten';
      $('#flatten-target-container').toggle(isFlatten);
      if (isFlatten) {
        this._syncFlattenUI();
      }
    };

    // Tool selection buttons (replacing legacy selects)
    const toolActiveBg = {
      'raise': '#006622',
      'lower': '#662222',
      'smooth': '#665500',
      'roughen': '#663300',
      'flatten': '#004c4c',
      'set-biome': '#004c3a',
      'river-draw': '#003a66',
      'river-edit': '#003a66',
      'region-draw': '#004466',
      'region-edit': '#004466',
    };

    const syncToolButtonGroup = (containerSelector, activeTool) => {
      const buttons = $(`${containerSelector} button[data-tool]`);
      if (!buttons.length) return;

      const active = String(activeTool || '');
      buttons.each((_i, el) => {
        const b = $(el);
        const t = String(b.data('tool') || '');
        const isActiveBtn = t === active;
        const bg = isActiveBtn ? (toolActiveBg[t] || '#0066cc') : '#444';

        b.css('background', bg);
        b.css('box-shadow', isActiveBtn ? '0 0 0 1px rgba(255,255,255,0.22) inset' : 'none');
        b.css('opacity', isActiveBtn ? '1' : '0.85');
      });
    };

    const syncAllToolButtons = () => {
      // Visual-only sync; does not call setTool().
      syncToolButtonGroup('#global-map-height-tool-buttons', this._selectedHeightsTool);
      syncToolButtonGroup('#global-map-biome-tool-buttons', this._selectedBiomesTool);
      syncToolButtonGroup('#global-map-river-mode-buttons', this._selectedRiversTool);
      syncToolButtonGroup('#global-map-region-mode-buttons', this._selectedRegionsTool);
    };

    // Heights: tool buttons
    $('#global-map-height-tool-buttons button[data-tool]').on('click', (e) => {
      if (this.isBrushActive) return;

      const tool = String($(e.currentTarget).data('tool') || 'raise');
      this._selectedHeightsTool = tool;
      syncAllToolButtons();

      this.setTool(tool);
      updateHeightToolUI(tool);
    });

    // Biomes: tool buttons
    $('#global-map-biome-tool-buttons button[data-tool]').on('click', (e) => {
      if (this.isBrushActive) return;

      const tool = String($(e.currentTarget).data('tool') || 'set-biome');
      this._selectedBiomesTool = tool;
      syncAllToolButtons();

      this.setTool(tool);
      updateBiomeToolUI(tool);
    });

    // Rivers: mode buttons
    $('#global-map-river-mode-buttons button[data-tool]').on('click', (e) => {
      if (this.isBrushActive) return;

      const tool = String($(e.currentTarget).data('tool') || 'river-draw');
      this._selectedRiversTool = tool;
      syncAllToolButtons();

      this.setTool(tool);
      this.selectedRiverPointIndex = null;
      this._renderRiverHandles();
      this._refreshRiversUI();
    });

    // Regions: mode buttons
    $('#global-map-region-mode-buttons button[data-tool]').on('click', (e) => {
      if (this.isBrushActive) return;

      const tool = String($(e.currentTarget).data('tool') || 'region-draw');
      this._selectedRegionsTool = tool;
      syncAllToolButtons();

      this.setTool(tool);
      this.selectedRegionPointIndex = null;
      this._renderRegionHandles();
      this._refreshRegionsUI();
    });

    $('#flatten-target-height').on('input', (e) => {
      const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      this.targetHeight = v;
      this._syncFlattenUI();
    });

    $('#single-cell-mode').on('change', (e) => {
      this.singleCellMode = e.target.checked;
      // Sync both checkboxes
      $('#biome-single-cell-mode').prop('checked', this.singleCellMode);
      // Show/hide radius controls
      if (this.singleCellMode) {
        $('#radius-container').hide();
        $('#biome-radius-container').hide();
        // Create cell highlight if brush is active
        if (this.isBrushActive) {
          this.createCellHighlight();
        }
      } else {
        $('#radius-container').show();
        $('#biome-radius-container').show();
        // Clear cell highlight
        this.clearCellHighlight();
      }
      this.updateBrushCursorGraphics();
      this.updateBrushUI();
    });

    $('#global-map-radius').on('input', (e) => {
      this.brushRadius = parseInt(e.target.value);
      $('#radius-value').text(this.brushRadius);
      $('#biome-radius-value').text(this.brushRadius);
      this.updateBrushCursorGraphics();
    });

    $('#global-map-strength').on('input', (e) => {
      this.brushStrength = parseFloat(e.target.value);
      $('#strength-value').text(this.brushStrength.toFixed(1));
      $('#biome-strength-value').text(this.brushStrength.toFixed(1));
      this.updateBrushCursorGraphics();
    });

    // Height contour opacity (debug/test)
    $('#height-contour-alpha').on('input', (e) => {
      const v = Math.max(0, Math.min(1, Number(e.target.value)));
      if (!Number.isFinite(v)) return;

      $('#height-contour-alpha-value').text(v.toFixed(2));

      if (this.renderer?.setHeightContourAlpha) {
        this.renderer.setHeightContourAlpha(v);
      } else if (this.renderer) {
        // Fallback for older renderer versions
        this.renderer.heightContourAlpha = v;
        if (this.renderer.currentGrid && this.renderer.currentMetadata) {
          this.renderer.render(this.renderer.currentGrid, this.renderer.currentMetadata);
        }
      }
    });

    $('#biome-single-cell-mode').on('change', (e) => {
      this.singleCellMode = e.target.checked;
      // Sync both checkboxes
      $('#single-cell-mode').prop('checked', this.singleCellMode);
      // Show/hide radius controls
      if (this.singleCellMode) {
        $('#radius-container').hide();
        $('#biome-radius-container').hide();
        // Create cell highlight if brush is active
        if (this.isBrushActive) {
          this.createCellHighlight();
        }
      } else {
        $('#radius-container').show();
        $('#biome-radius-container').show();
        // Clear cell highlight
        this.clearCellHighlight();
      }
      this.updateBrushCursorGraphics();
      this.updateBrushUI();
    });

    $('#global-map-biome-radius').on('input', (e) => {
      this.brushRadius = parseInt(e.target.value);
      $('#radius-value').text(this.brushRadius);
      $('#biome-radius-value').text(this.brushRadius);
      this.updateBrushCursorGraphics();
    });

    // Set Biome controls
    $('#set-biome-select').on('change', (e) => {
      this.setBiomeId = parseInt(e.target.value);

      // Update palette selection highlight
      const matrix = $('#biome-preset-matrix');
      matrix.children().css('border', '1px solid rgba(0,0,0,0.3)').css('box-shadow', 'none');
      matrix.find(`[data-biome-id="${this.setBiomeId}"]`).css('border', '2px solid #ffffff').css('box-shadow', '0 0 0 2px rgba(255,255,255,0.3) inset');
    });

    // Open biome editor (separate window)
    $('#open-biome-editor').on('click', async () => {
      try {
        const app = new GlobalMapBiomeEditorApp({
          biomeResolver: this.processing?.biomeResolver,
        });
        app.render(true);
      } catch (e) {
        console.error('GlobalMapTools | Failed to open biome editor:', e);
        ui.notifications?.error?.(_f('SPACEHOLDER.GlobalMap.Tools.Errors.OpenBiomeEditorFailed', { message: e.message }));
      }
    });

    // Brush activation/deactivation
    $('#brush-toggle').on('click', () => {
      if (this.isBrushActive) {
        this.deactivateBrush();
      } else {
        this.activateBrush();
      }
    });
    
    $('#biome-brush-toggle').on('click', () => {
      if (this.isBrushActive) {
        this.deactivateBrush();
      } else {
        this.activateBrush();
      }
    });

    // ===== HEIGHTS TAB FILTERS =====
    // Height Range Filter for height tools
    $('#height-filter-enabled').on('change', (e) => {
      this.heightFilterEnabled = e.target.checked;
      $('#height-filter-controls').toggle(this.heightFilterEnabled);
      $('#height-filter-min').prop('disabled', !this.heightFilterEnabled);
      $('#height-filter-max').prop('disabled', !this.heightFilterEnabled);
    });
    
    $('#height-filter-min').on('input', (e) => {
      const minVal = parseInt(e.target.value);
      $('#height-filter-min-value').text(minVal);
      const maxVal = parseInt($('#height-filter-max').val());
      if (minVal > maxVal) {
        $('#height-filter-max').val(minVal);
        $('#height-filter-max-value').text(minVal);
      }
      this.heightFilterMin = minVal;
      const max = parseInt($('#height-filter-max').val());
      $('#height-filter-display').text(`${minVal}-${max}`);
    });
    
    $('#height-filter-max').on('input', (e) => {
      const maxVal = parseInt(e.target.value);
      $('#height-filter-max-value').text(maxVal);
      const minVal = parseInt($('#height-filter-min').val());
      if (maxVal < minVal) {
        $('#height-filter-min').val(maxVal);
        $('#height-filter-min-value').text(maxVal);
      }
      this.heightFilterMax = maxVal;
      const min = parseInt($('#height-filter-min').val());
      $('#height-filter-display').text(`${min}-${maxVal}`);
    });

    // Biome Filter for height tools (only affect selected biomes)
    $('#height-tool-biome-filter-enabled').on('change', (e) => {
      this.heightFilterByBiomeEnabled = e.target.checked;
      $('#height-tool-biome-filter-controls').toggle(this.heightFilterByBiomeEnabled);
      
      if (this.heightFilterByBiomeEnabled) {
        const matrix = $('#height-filter-biome-matrix');
        if (matrix.children().length === 0) {
          this._generateHeightFilterBiomeMatrix();
        }
      }
    });

    // ===== BIOMES TAB FILTERS =====
    // Height Range Filter for biome tools
    $('#biome-tool-height-filter-enabled').on('change', (e) => {
      this.biomeFilterEnabled = e.target.checked;
      $('#biome-tool-height-filter-controls').toggle(this.biomeFilterEnabled);
      $('#biome-tool-height-min').prop('disabled', !this.biomeFilterEnabled);
      $('#biome-tool-height-max').prop('disabled', !this.biomeFilterEnabled);
    });
    
    $('#biome-tool-height-min').on('input', (e) => {
      const minVal = parseInt(e.target.value);
      $('#biome-tool-height-min-value').text(minVal);
      const maxVal = parseInt($('#biome-tool-height-max').val());
      if (minVal > maxVal) {
        $('#biome-tool-height-max').val(minVal);
        $('#biome-tool-height-max-value').text(minVal);
      }
      this.biomeFilterHeightMin = minVal;
      const max = parseInt($('#biome-tool-height-max').val());
      $('#biome-tool-height-display').text(`${minVal}-${max}`);
    });
    
    $('#biome-tool-height-max').on('input', (e) => {
      const maxVal = parseInt(e.target.value);
      $('#biome-tool-height-max-value').text(maxVal);
      const minVal = parseInt($('#biome-tool-height-min').val());
      if (maxVal < minVal) {
        $('#biome-tool-height-min').val(maxVal);
        $('#biome-tool-height-min-value').text(maxVal);
      }
      this.biomeFilterHeightMax = maxVal;
      const min = parseInt($('#biome-tool-height-min').val());
      $('#biome-tool-height-display').text(`${min}-${maxVal}`);
    });

    // Biome Filter for biome tools (exclude certain biomes)
    $('#biome-tool-biome-filter-enabled').on('change', (e) => {
      this.biomeFilterByBiomeEnabled = e.target.checked;
      $('#biome-tool-biome-filter-controls').toggle(this.biomeFilterByBiomeEnabled);
      
      if (this.biomeFilterByBiomeEnabled) {
        const matrix = $('#biome-filter-biome-matrix');
        if (matrix.children().length === 0) {
          this._generateBiomeToolBiomeFilterMatrix();
        }
      }
    });
    
    $('#biome-tool-biome-filter-select').on('change', (e) => {
      const selectedValues = $(e.target).val();
      this.biomeFilterExcludedIds.clear();
      if (selectedValues) {
        selectedValues.forEach(val => this.biomeFilterExcludedIds.add(parseInt(val)));
      }
    });

    // Tabs switching
    const activateTab = (tab) => {
      // Hide all tabs
      $('#brush-tab').hide();
      $('#biomes-tab').hide();
      $('#rivers-tab').hide();
      $('#regions-tab').hide();
      $('#global-tab').hide();
      
      // Reset all tab buttons
      $('#tab-brush').css('background', '#333').css('font-weight', 'normal');
      $('#tab-biomes').css('background', '#333').css('font-weight', 'normal');
      $('#tab-rivers').css('background', '#333').css('font-weight', 'normal');
      $('#tab-regions').css('background', '#333').css('font-weight', 'normal');
      $('#tab-global').css('background', '#333').css('font-weight', 'normal');
      
      // Show selected tab and highlight button
      if (tab === 'brush') {
        $('#brush-tab').show();
        $('#tab-brush').css('background', '#0066cc').css('font-weight', 'bold');
        syncAllToolButtons();
        updateHeightToolUI(this._selectedHeightsTool);
      } else if (tab === 'biomes') {
        $('#biomes-tab').show();
        $('#tab-biomes').css('background', '#0066cc').css('font-weight', 'bold');
        syncAllToolButtons();
        updateBiomeToolUI(this._selectedBiomesTool);
      } else if (tab === 'rivers') {
        $('#rivers-tab').show();
        $('#tab-rivers').css('background', '#0066cc').css('font-weight', 'bold');
        syncAllToolButtons();
        this._onRiversTabShown();
      } else if (tab === 'regions') {
        $('#regions-tab').show();
        $('#tab-regions').css('background', '#0066cc').css('font-weight', 'bold');
        syncAllToolButtons();
        this._onRegionsTabShown();
      } else if (tab === 'global') {
        $('#global-tab').show();
        $('#tab-global').css('background', '#0066cc').css('font-weight', 'bold');
      }
    };
    $('#tab-brush').on('click', () => activateTab('brush'));
    $('#tab-biomes').on('click', () => activateTab('biomes'));
    $('#tab-rivers').on('click', () => activateTab('rivers'));
    $('#tab-regions').on('click', () => activateTab('regions'));
    $('#tab-global').on('click', () => activateTab('global'));

    // ===== RIVERS TAB (vector rivers) =====

    $('#global-map-river-select').on('change', (e) => {
      this.selectedRiverId = String(e.target.value || '');
      this.selectedRiverPointIndex = null;
      this._renderRiverHandles();
      this._refreshRiversUI();
    });

    $('#river-new').on('click', async () => {
      await this.createNewRiver();
      this._renderRiverHandles();
      this._refreshRiversUI();
    });

    $('#river-delete').on('click', async () => {
      await this.deleteSelectedRiver();
      this._renderRiverHandles();
      this._refreshRiversUI();
    });

    $('#river-rename').on('click', async () => {
      await this.renameSelectedRiver();
      this._refreshRiversUI();
    });

    $('#river-snap-endpoints').on('change', (e) => {
      this._ensureVectorRiversInitialized();
      this.vectorRivers.settings.snapToEndpoints = !!e.target.checked;
      this.vectorRiversDirty = true;
    });

    $('#river-default-width').on('input', (e) => {
      const v = Math.max(1, Number(e.target.value) || 1);
      this.riverDefaultPointWidth = v;
      $('#river-default-width-value').text(String(v));
    });

    $('#river-point-width').on('input', (e) => {
      const v = Math.max(1, Number(e.target.value) || 1);
      const river = this._getSelectedRiver();
      if (!river) return;
      if (this.selectedRiverPointIndex === null || this.selectedRiverPointIndex === undefined) return;

      const p = river.points?.[this.selectedRiverPointIndex];
      if (!p) return;
      p.width = v;
      $('#river-point-width-value').text(String(v));
      this.vectorRiversDirty = true;

      this._applyVectorRiversToRenderer();
      this._renderRiverHandles();
    });

    $('#river-label-mode').on('change', (e) => {
      this._ensureVectorRiversInitialized();
      const mode = String(e.target.value || 'hover');
      this.vectorRivers.settings.labelMode = mode;
      this.vectorRiversDirty = true;
      this._applyVectorRiversToRenderer();
    });

    $('#river-finish').on('click', () => {
      // Convenience: switch from Draw to Edit (even while brush is active)
      this._selectedRiversTool = 'river-edit';
      syncAllToolButtons();

      this.setTool('river-edit');
      this.selectedRiverPointIndex = null;
      this._renderRiverHandles();
      this._refreshRiversUI();
    });

    $('#river-save').on('click', async () => {
      await this.saveVectorRivers();
      this._refreshRiversUI();
    });

    $('#river-brush-toggle').on('click', () => {
      if (this.isBrushActive) {
        this.deactivateBrush();
      } else {
        this.activateBrush();
      }
    });

    // ===== REGIONS TAB (vector regions) =====

    $('#global-map-region-select').on('change', (e) => {
      this.selectedRegionId = String(e.target.value || '');
      this.selectedRegionPointIndex = null;
      this._renderRegionHandles();
      this._refreshRegionsUI();
    });

    $('#region-new').on('click', async () => {
      await this.createNewRegion();
      this._renderRegionHandles();
      this._refreshRegionsUI();
    });

    $('#region-delete').on('click', async () => {
      await this.deleteSelectedRegion();
      this._renderRegionHandles();
      this._refreshRegionsUI();
    });

    $('#region-rename').on('click', async () => {
      await this.renameSelectedRegion();
      this._refreshRegionsUI();
    });

    $('#region-label-mode').on('change', (e) => {
      this._ensureVectorRegionsInitialized();
      const mode = String(e.target.value || 'hover');
      this.vectorRegions.settings.labelMode = mode;
      this.vectorRegionsDirty = true;
      this._applyVectorRegionsToRenderer();
      this._refreshRegionsUI();
    });

    $('#region-smooth-iterations').on('change', (e) => {
      this._ensureVectorRegionsInitialized();
      const vRaw = Number.parseInt(e.target.value, 10);
      const v = Number.isFinite(vRaw) ? Math.max(0, Math.min(4, vRaw)) : 1;
      this.vectorRegions.settings.smoothIterations = v;
      this.vectorRegionsDirty = true;
      this._applyVectorRegionsToRenderer();
      this._refreshRegionsUI();
    });

    // Style controls (per-region)
    $('#region-fill-color').on('input', (e) => {
      const region = this._getSelectedRegion();
      if (!region) return;
      region.fillColor = this._cssHexToInt(e.target.value, region.fillColor ?? this.regionDefaultFillColor);
      this.vectorRegionsDirty = true;
      this._applyVectorRegionsToRenderer();
    });

    $('#region-fill-alpha').on('input', (e) => {
      const region = this._getSelectedRegion();
      if (!region) return;
      const v = Math.max(0, Math.min(1, Number(e.target.value)));
      if (!Number.isFinite(v)) return;
      region.fillAlpha = v;
      $('#region-fill-alpha-value').text(v.toFixed(2));
      this.vectorRegionsDirty = true;
      this._applyVectorRegionsToRenderer();
    });

    $('#region-stroke-color').on('input', (e) => {
      const region = this._getSelectedRegion();
      if (!region) return;
      region.strokeColor = this._cssHexToInt(e.target.value, region.strokeColor ?? this.regionDefaultStrokeColor);
      this.vectorRegionsDirty = true;
      this._applyVectorRegionsToRenderer();
    });

    $('#region-stroke-alpha').on('input', (e) => {
      const region = this._getSelectedRegion();
      if (!region) return;
      const v = Math.max(0, Math.min(1, Number(e.target.value)));
      if (!Number.isFinite(v)) return;
      region.strokeAlpha = v;
      $('#region-stroke-alpha-value').text(v.toFixed(2));
      this.vectorRegionsDirty = true;
      this._applyVectorRegionsToRenderer();
    });

    $('#region-stroke-width').on('input', (e) => {
      const region = this._getSelectedRegion();
      if (!region) return;
      const v = Math.max(1, Number(e.target.value) || 1);
      region.strokeWidth = v;
      $('#region-stroke-width-value').text(String(Math.round(v)));
      this.vectorRegionsDirty = true;
      this._applyVectorRegionsToRenderer();
      this._renderRegionHandles();
    });

    // Journal UUID
    const journalInput = $('#region-journal-uuid');
    journalInput.on('change', () => {
      const region = this._getSelectedRegion();
      if (!region) return;
      const uuid = String(journalInput.val() || '').trim();
      region.journalUuid = uuid;
      this.vectorRegionsDirty = true;
      this._applyVectorRegionsToRenderer();
      this._refreshRegionsUI();
    });

    journalInput.on('dragover', (ev) => {
      ev.preventDefault();
    });

    journalInput.on('drop', async (ev) => {
      ev.preventDefault();

      const region = this._getSelectedRegion();
      if (!region) return;

      const uuid = this._extractUuidFromDropEvent(ev.originalEvent);
      if (!uuid) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.DropUuidNotFound'));
        return;
      }

      // Validate: JournalEntry/JournalEntryPage
      let doc = null;
      try {
        doc = await fromUuid(uuid);
      } catch (e) {
        doc = null;
      }

      if (!doc) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.DocNotFoundByUuid'));
        return;
      }

      if (!['JournalEntry', 'JournalEntryPage'].includes(doc.documentName)) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.ExpectedJournalDoc'));
        return;
      }

      region.journalUuid = uuid;
      journalInput.val(uuid);
      this.vectorRegionsDirty = true;
      this._applyVectorRegionsToRenderer();
      this._refreshRegionsUI();
    });

    $('#region-journal-open').on('click', async () => {
      const region = this._getSelectedRegion();
      if (!region) return;
      await this._openJournalUuid(region.journalUuid);
    });

    $('#region-journal-clear').on('click', () => {
      const region = this._getSelectedRegion();
      if (!region) return;
      region.journalUuid = '';
      journalInput.val('');
      this.vectorRegionsDirty = true;
      this._applyVectorRegionsToRenderer();
      this._refreshRegionsUI();
    });

    $('#region-finish').on('click', async () => {
      await this.finishSelectedRegion();
      syncAllToolButtons();
      this._renderRegionHandles();
      this._refreshRegionsUI();
    });

    $('#region-save').on('click', async () => {
      await this.saveVectorRegions();
      this._refreshRegionsUI();
    });

    $('#region-brush-toggle').on('click', () => {
      if (this.isBrushActive) {
        this.deactivateBrush();
      } else {
        this.activateBrush();
      }
    });

    // Global operations
    $('#global-smooth-strength').on('input', (e) => {
      this.globalSmoothStrength = parseFloat(e.target.value);
      $('#global-smooth-strength-value').text(this.globalSmoothStrength.toFixed(1));
    });

    $('#global-smooth-btn').on('click', async () => {
      $('#global-smooth-btn').prop('disabled', true);
      try { this.globalSmooth(1); } finally { $('#global-smooth-btn').prop('disabled', false); }
    });
    $('#global-smooth-3-btn').on('click', async () => {
      $('#global-smooth-3-btn').prop('disabled', true);
      try { this.globalSmooth(3); } finally { $('#global-smooth-3-btn').prop('disabled', false); }
    });

    // ===== UNIFIED REPLACE TOOL =====
    // Update preview when filters or actions change
    this.updateReplacePreview = () => {
      const useBiome = $('#replace-use-biome').prop('checked');
      const useHeight = $('#replace-use-height').prop('checked');
      
      if (!useBiome && !useHeight) {
        $('#replace-preview-count').text('0');
        return;
      }
      
      const criteria = {
        heightMin: useHeight ? parseInt($('#replace-height-min').val()) : null,
        heightMax: useHeight ? parseInt($('#replace-height-max').val()) : null,
        biomeIds: useBiome ? this.replaceSourceBiomeIds : null
      };
      
      const count = this.getAffectedCellsCount(criteria);
      $('#replace-preview-count').text(count);
    };
    
    // Filter toggles
    $('#replace-use-height').on('change', (e) => {
      $('#replace-height-min').prop('disabled', !e.target.checked);
      $('#replace-height-max').prop('disabled', !e.target.checked);
      this.updateReplacePreview();
    });
    
    $('#replace-use-biome').on('change', (e) => {
      const isChecked = e.target.checked;
      const matrix = $('#replace-source-biome-matrix');
      if (isChecked) {
        if (matrix.children().length === 0) {
          this._generateReplaceSourceBiomeMatrix();
        }
        matrix.show();
      } else {
        matrix.hide();
      }
      this.updateReplacePreview();
    });
    
    // Height filter sliders
    $('#replace-height-min').on('input', (e) => {
      const minVal = parseInt(e.target.value);
      $('#replace-height-min-value').text(minVal);
      const maxVal = parseInt($('#replace-height-max').val());
      if (minVal > maxVal) {
        $('#replace-height-max').val(minVal);
        $('#replace-height-max-value').text(minVal);
      }
      this.updateReplacePreview();
    });
    
    $('#replace-height-max').on('input', (e) => {
      const maxVal = parseInt(e.target.value);
      $('#replace-height-max-value').text(maxVal);
      const minVal = parseInt($('#replace-height-min').val());
      if (maxVal < minVal) {
        $('#replace-height-min').val(maxVal);
        $('#replace-height-min-value').text(maxVal);
      }
      this.updateReplacePreview();
    });
    
    // Action toggles
    $('#replace-set-height').on('change', (e) => {
      $('#replace-set-height-val').prop('disabled', !e.target.checked);
    });
    
    $('#replace-set-biome').on('change', (e) => {
      const isChecked = e.target.checked;
      const matrix = $('#replace-target-biome-matrix');
      if (isChecked) {
        if (matrix.children().length === 0) {
          this._generateReplaceTargetBiomeMatrix();
        }
        matrix.show();
      } else {
        matrix.hide();
      }
    });
    
    // Set height slider
    $('#replace-set-height-val').on('input', (e) => {
      $('#replace-set-height-display').text(e.target.value);
    });
    
    // Main Replace button
    $('#replace-apply-btn').on('click', () => {
      const useBiome = $('#replace-use-biome').prop('checked');
      const useHeight = $('#replace-use-height').prop('checked');
      const setHeight = $('#replace-set-height').prop('checked');
      const setBiome = $('#replace-set-biome').prop('checked');
      
      if (!useBiome && !useHeight) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Tools.Replace.Errors.SelectAtLeastOneFilter'));
        return;
      }
      
      if (!setHeight && !setBiome) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Tools.Replace.Errors.SelectAtLeastOneAction'));
        return;
      }
      
      const criteria = {
        heightMin: useHeight ? parseInt($('#replace-height-min').val()) : null,
        heightMax: useHeight ? parseInt($('#replace-height-max').val()) : null,
        sourceBiomeIds: useBiome ? this.replaceSourceBiomeIds : null,
        targetHeight: setHeight ? parseInt($('#replace-set-height-val').val()) : null
      };
      
      if (setBiome) {
        if (!this.replaceTargetBiomeId) {
          ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Tools.Replace.Errors.SelectTargetBiome'));
          return;
        }
        criteria.targetBiomeId = this.replaceTargetBiomeId;
      }
      
      this.applyReplaceByCombinedFilter(criteria);
    });
    
    // Flatten All button
    $('#replace-flatten-btn').on('click', async () => {
      const targetHeightRaw = parseInt($('#replace-set-height-val').val());
      const targetHeight = Number.isFinite(targetHeightRaw) ? targetHeightRaw : 0;

      const ok = await this._confirmDialog({
        title: _t('SPACEHOLDER.GlobalMap.Tools.Replace.Confirm.FlattenAllTitle'),
        content: _f('SPACEHOLDER.GlobalMap.Tools.Replace.Confirm.FlattenAllContent', { height: targetHeight }),
        yesLabel: _t('SPACEHOLDER.GlobalMap.Tools.Replace.FlattenAll'),
        yesIcon: 'fa-solid fa-arrows-to-circle',
        noLabel: _t('SPACEHOLDER.Actions.Cancel'),
        noIcon: 'fa-solid fa-times',
      });

      if (!ok) return;
      this.applyFlattenMap(targetHeight);
    });

    // Undo / Redo
    $('#global-map-undo').on('click', () => {
      this.undo();
    });
    $('#global-map-redo').on('click', () => {
      this.redo();
    });

    $('#global-map-exit').on('click', async () => {
      await this.deactivate();
    });
    
    // Initialize UI state
    syncAllToolButtons();
    updateHeightToolUI(this._selectedHeightsTool || 'raise');
    this._syncFlattenUI();
    this.updateBrushUI();
    this._updateUndoRedoUI();
  }

  /**
   * Sync Flatten target height controls (if UI is open).
   * @private
   */
  _syncFlattenUI() {
    if (!$('#global-map-tools-ui').length) return;

    const v = Math.round(Math.max(0, Math.min(100, Number(this.targetHeight) || 0)));
    this.targetHeight = v;

    const input = $('#flatten-target-height');
    if (input.length) {
      input.val(String(v));
    }
    $('#flatten-target-value').text(String(v));
  }

  /**
   * Pick target height for Flatten from the grid cell under the cursor.
   * Used by the Alt+Click "pipette".
   * @private
   * @returns {boolean} true if a height was picked
   */
  _pickFlattenTargetHeightAt(worldX, worldY) {
    if (!this.renderer?.currentGrid || !this.renderer?.currentMetadata) return false;

    const { heights, rows, cols } = this.renderer.currentGrid;
    const { cellSize, bounds } = this.renderer.currentMetadata;

    const gridCol = Math.floor((worldX - bounds.minX) / cellSize);
    const gridRow = Math.floor((worldY - bounds.minY) / cellSize);

    if (gridRow < 0 || gridRow >= rows || gridCol < 0 || gridCol >= cols) {
      return false;
    }

    const idx = gridRow * cols + gridCol;
    const h = heights?.[idx];
    if (!Number.isFinite(h)) return false;

    this.targetHeight = Math.round(Math.max(0, Math.min(100, h)));
    return true;
  }

  /**
   * Get pattern color or darken base color
   * @private
   * @param {Object} pattern - Pattern config from biome
   * @param {number} baseColor - RGB color as hex
   * @returns {string} RGB color string for pattern overlay
   */
  _getPatternColor(pattern, baseColor) {
    if (!pattern) return null;
    
    if (pattern.patternColor) {
      // Use explicit pattern color from config
      const colorStr = pattern.patternColor;
      if (colorStr.startsWith('#')) {
        return colorStr;
      }
      // Parse hex string like "284828"
      const color = parseInt(colorStr, 16);
      const r = (color >> 16) & 0xFF;
      const g = (color >> 8) & 0xFF;
      const b = color & 0xFF;
      return `rgb(${r},${g},${b})`;
    }
    
    // Darken base color
    const darkenFactor = pattern.darkenFactor || 0.3;
    const r = Math.floor(((baseColor >> 16) & 0xFF) * (1 - darkenFactor));
    const g = Math.floor(((baseColor >> 8) & 0xFF) * (1 - darkenFactor));
    const b = Math.floor((baseColor & 0xFF) * (1 - darkenFactor));
    return `rgb(${r},${g},${b})`;
  }

  /**
   * Check if cell passes current filters based on current tool
   * @private
   * @param {number} idx - Cell index in grid
   * @param {Float32Array} heights - Heights array
   * @param {Uint8Array} temperature - Temperature array
   * @param {Uint8Array} moisture - Moisture array
   * @returns {boolean} True if cell should be affected by brush
   */
  _isCellPassesFilter(idx, heights, biomes, temperature = null, moisture = null) {
    const h = heights[idx];

    // Prefer explicit biome IDs; fall back to legacy moisture/temperature
    const cellBiomeId = (biomes && biomes.length)
      ? biomes[idx]
      : this.processing.biomeResolver.getBiomeId(moisture ? moisture[idx] : 0, temperature ? temperature[idx] : 0);

    // Height-based tools: raise, lower, smooth, roughen, flatten
    const isHeightTool = ['raise', 'lower', 'smooth', 'roughen', 'flatten'].includes(this.currentTool);
    
    if (isHeightTool) {
      // Filter by height range
      if (this.heightFilterEnabled) {
        if (h < this.heightFilterMin || h > this.heightFilterMax) {
          return false; // Cell height is outside filter range
        }
      }
      
      // Filter by specific biomes (only affect selected biomes)
      if (this.heightFilterByBiomeEnabled && this.heightFilterBiomeIds.size > 0) {
        if (!this.heightFilterBiomeIds.has(cellBiomeId)) {
          return false; // Cell biome is not in the allowed list
        }
      }
    }
    // Biome-based tools: set-biome
    else if (this.currentTool === 'set-biome') {
      // Filter by height range
      if (this.biomeFilterEnabled) {
        if (h < this.biomeFilterHeightMin || h > this.biomeFilterHeightMax) {
          return false; // Cell height is outside filter range
        }
      }
      
      // Filter by specific biomes (exclude certain biomes)
      if (this.biomeFilterByBiomeEnabled && this.biomeFilterExcludedIds.size > 0) {
        if (this.biomeFilterExcludedIds.has(cellBiomeId)) {
          return false; // Cell biome is in excluded list
        }
      }
    }

    return true; // Cell passes all filters
  }

  /**
   * Refresh biome-related UI lists (palette + filter matrices) if the tools UI is open.
   * Useful after updating biome overrides.
   */
  refreshBiomeLists() {
    if (!$('#global-map-tools-ui').length) return;

    try { this._generateBiomeMatrix?.(); } catch (e) { /* ignore */ }
    try { this._generateHeightFilterBiomeMatrix?.(); } catch (e) { /* ignore */ }
    try { this._generateBiomeToolBiomeFilterMatrix?.(); } catch (e) { /* ignore */ }
    try { this._generateReplaceSourceBiomeMatrix?.(); } catch (e) { /* ignore */ }
    try { this._generateReplaceTargetBiomeMatrix?.(); } catch (e) { /* ignore */ }
  }

  /**
   * Hide tools UI panel
   */
  hideToolsUI() {
    // Remove document-level handlers that can outlive the UI element
    const docNs = this._uiDocNamespace || '.globalMapToolsUI';
    try {
      $(document).off(`mousemove${docNs}`).off(`mouseup${docNs}`);
    } catch (e) {
      // ignore
    }

    $('#global-map-tools-ui').remove();
  }

  /**
   * Update combined preview count
   * @private
   */
  updateCombinedPreview() {
    const useBiome = $('#combined-use-biome').prop('checked');
    const useHeight = $('#combined-use-height').prop('checked');
    
    if (!useBiome && !useHeight) {
      $('#combined-count').text('0');
      return;
    }
    
    const criteria = {
      heightMin: useHeight ? parseInt($('#combined-height-min').val()) : null,
      heightMax: useHeight ? parseInt($('#combined-height-max').val()) : null,
      biomeId: useBiome ? parseInt($('#combined-biome').val()) : null
    };
    
    const count = this.getAffectedCellsCount(criteria);
    $('#combined-count').text(count);
  }

  /**
   * Count cells matching criteria for preview
   * @param {Object} criteria - Filter criteria {heightMin, heightMax, biomeId/biomeIds}
   * @returns {number} Count of matching cells
   */
  getAffectedCellsCount(criteria) {
    if (!this.renderer.currentGrid) return 0;

    const { heights, biomes, moisture, temperature } = this.renderer.currentGrid;
    let count = 0;

    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];

      let matches = true;

      // Check height range
      if (criteria.heightMin !== null && h < criteria.heightMin) matches = false;
      if (criteria.heightMax !== null && h > criteria.heightMax) matches = false;

      const cellBiomeId = (biomes && biomes.length)
        ? biomes[i]
        : this.processing.biomeResolver.getBiomeId(moisture ? moisture[i] : 0, temperature ? temperature[i] : 0);

      // Check biome (single or multiple)
      if (criteria.biomeId !== null && criteria.biomeId !== undefined) {
        if (cellBiomeId !== criteria.biomeId) matches = false;
      } else if (criteria.biomeIds !== null && criteria.biomeIds !== undefined && criteria.biomeIds.size > 0) {
        if (!criteria.biomeIds.has(cellBiomeId)) matches = false;
      }

      if (matches) count++;
    }

    return count;
  }

  /**
   * Replace all cells matching height criteria
   * @param {number} heightMin - Minimum height to match
   * @param {number} heightMax - Maximum height to match
   * @param {number} replacementHeight - Height to replace with
   * @returns {number} Number of cells modified
   */
  applyReplaceByHeight(heightMin, heightMax, replacementHeight) {
    if (!this.renderer.currentGrid) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.NoLoadedMap'));
      return 0;
    }

    this._pushUndoSnapshot('replace:height');

    const { heights } = this.renderer.currentGrid;
    let count = 0;

    for (let i = 0; i < heights.length; i++) {
      if (heights[i] >= heightMin && heights[i] <= heightMax) {
        heights[i] = Math.max(0, Math.min(100, replacementHeight));
        count++;
      }
    }

    // Re-render
    this.renderer.render(
      this.renderer.currentGrid,
      this.renderer.currentMetadata,
      { mode: 'heights' }
    );

    console.log(`GlobalMapTools | ✓ Replaced ${count} cells by height`);
    ui.notifications?.info?.(_f('SPACEHOLDER.GlobalMap.Tools.Replace.Notifications.ReplacedByHeight', {
      count,
      min: Number(heightMin).toFixed(1),
      max: Number(heightMax).toFixed(1),
      to: Number(replacementHeight).toFixed(1),
    }));
    return count;
  }

  /**
   * Replace all cells with specific biome
   * @param {number} sourceBiomeId - Biome ID to replace
   * @param {number} targetBiomeId - Biome ID to set
   * @returns {number} Number of cells modified
   */
  applyReplaceByBiome(sourceBiomeId, targetBiomeId) {
    if (!this.renderer.currentGrid) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.NoLoadedMap'));
      return 0;
    }

    const { biomes, moisture, temperature } = this.renderer.currentGrid;
    if (!biomes) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Tools.Replace.Errors.NoBiomesArrayAvailable'));
      return 0;
    }

    this._pushUndoSnapshot('replace:biome');

    let count = 0;

    for (let i = 0; i < biomes.length; i++) {
      const cellBiomeId = biomes[i] ?? this.processing.biomeResolver.getBiomeId(moisture ? moisture[i] : 0, temperature ? temperature[i] : 0);
      if (cellBiomeId === sourceBiomeId) {
        biomes[i] = targetBiomeId;
        count++;
      }
    }

    // Re-render
    this.renderer.render(
      this.renderer.currentGrid,
      this.renderer.currentMetadata,
      { mode: 'heights' }
    );

    console.log(`GlobalMapTools | ✓ Replaced ${count} cells by biome`);
    ui.notifications?.info?.(_f('SPACEHOLDER.GlobalMap.Tools.Replace.Notifications.ReplacedByBiome', { count }));
    return count;
  }

  /**
   * Apply combined filter replacement (height AND/OR biome)
   * @param {Object} criteria - {heightMin, heightMax, sourceBiomeId/sourceBiomeIds, targetBiomeId, targetHeight}
   * @returns {number} Number of cells modified
   */
  applyReplaceByCombinedFilter(criteria) {
    if (!this.renderer.currentGrid) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.NoLoadedMap'));
      return 0;
    }

    this._pushUndoSnapshot('replace:combined');

    const { heights, biomes, moisture, temperature } = this.renderer.currentGrid;
    let count = 0;

    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];

      let matches = true;

      // Check height range (if specified)
      if (criteria.heightMin !== null && criteria.heightMin !== undefined) {
        if (h < criteria.heightMin) matches = false;
      }
      if (criteria.heightMax !== null && criteria.heightMax !== undefined) {
        if (h > criteria.heightMax) matches = false;
      }

      const cellBiomeId = (biomes && biomes.length)
        ? biomes[i]
        : this.processing.biomeResolver.getBiomeId(moisture ? moisture[i] : 0, temperature ? temperature[i] : 0);

      // Check biome (single or multiple)
      if (matches && criteria.sourceBiomeId !== null && criteria.sourceBiomeId !== undefined) {
        if (cellBiomeId !== criteria.sourceBiomeId) matches = false;
      } else if (matches && criteria.sourceBiomeIds !== null && criteria.sourceBiomeIds !== undefined && criteria.sourceBiomeIds.size > 0) {
        if (!criteria.sourceBiomeIds.has(cellBiomeId)) matches = false;
      }

      if (matches) {
        // Apply replacements
        if (criteria.targetHeight !== null && criteria.targetHeight !== undefined) {
          heights[i] = Math.max(0, Math.min(100, criteria.targetHeight));
        }
        if (criteria.targetBiomeId !== null && criteria.targetBiomeId !== undefined && biomes) {
          biomes[i] = criteria.targetBiomeId;
        }
        count++;
      }
    }

    // Re-render
    this.renderer.render(
      this.renderer.currentGrid,
      this.renderer.currentMetadata,
      { mode: 'heights' }
    );

    console.log(`GlobalMapTools | ✓ Applied combined filter replacement to ${count} cells`);
    ui.notifications?.info?.(_f('SPACEHOLDER.GlobalMap.Tools.Replace.Notifications.ReplacedByCombined', { count }));
    return count;
  }

  /**
   * Flatten entire map to single height
   * @param {number} targetHeight - Height to set all cells to
   * @returns {number} Always returns total number of cells
   */
  applyFlattenMap(targetHeight) {
    if (!this.renderer.currentGrid) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.NoLoadedMap'));
      return 0;
    }

    this._pushUndoSnapshot('flattenAll');

    const { heights } = this.renderer.currentGrid;
    const count = heights.length;

    for (let i = 0; i < heights.length; i++) {
      heights[i] = Math.max(0, Math.min(100, targetHeight));
    }

    // Re-render
    this.renderer.render(
      this.renderer.currentGrid,
      this.renderer.currentMetadata,
      { mode: 'heights' }
    );

    console.log(`GlobalMapTools | ✓ Flattened entire map to height ${targetHeight}`);
    ui.notifications?.info?.(_f('SPACEHOLDER.GlobalMap.Tools.Replace.Notifications.MapFlattened', {
      count,
      height: Number(targetHeight).toFixed(1),
    }));
    return count;
  }

  /**
   * Apply global smooth to entire grid
   * @param {number} iterations - Number of smoothing passes
   */
  globalSmooth(iterations = 1) {
    if (!this.renderer.currentGrid) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.NoLoadedMap'));
      return;
    }

    this._pushUndoSnapshot(`globalSmooth:${iterations}`);

    console.log(`GlobalMapTools | Applying global smooth (${iterations} iterations, strength: ${this.globalSmoothStrength})...`);
    const { heights, rows, cols } = this.renderer.currentGrid;

    for (let iter = 0; iter < iterations; iter++) {
      const tempHeights = new Float32Array(heights);

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const idx = row * cols + col;

          // Average with neighbors (3x3 neighborhood)
          let sum = heights[idx];
          let count = 1;

          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;

              const nRow = row + dr;
              const nCol = col + dc;

              if (nRow >= 0 && nRow < rows && nCol >= 0 && nCol < cols) {
                const nIdx = nRow * cols + nCol;
                sum += tempHeights[nIdx];
                count++;
              }
            }
          }

          const avg = sum / count;
          const delta = (avg - heights[idx]) * this.globalSmoothStrength;
          heights[idx] = Math.max(0, Math.min(100, heights[idx] + delta));
        }
      }
    }

    // Re-render
    this.renderer.render(
      this.renderer.currentGrid,
      this.renderer.currentMetadata,
      { mode: 'heights' }
    );

    console.log(`GlobalMapTools | ✓ Global smooth applied (${iterations} iterations, strength: ${this.globalSmoothStrength})`);
    ui.notifications?.info?.(_f('SPACEHOLDER.GlobalMap.Tools.Notifications.GlobalSmoothed', {
      passes: Number(iterations),
      strength: Number(this.globalSmoothStrength).toFixed(1),
    }));
  }

  /**
   * Activate cell inspector mode
   */
  activateCellInspector() {
    if (this.isCellInspectorActive) return;

    console.log('GlobalMapTools | Activating cell inspector...');
    this.isCellInspectorActive = true;

    // Show renderer if not visible
    if (!this.renderer.isVisible) {
      this.renderer.show();
    }

    // Create click handler
    this.cellInspectorHandler = (event) => {
      if (!this.isCellInspectorActive) return;
      if (event.data.button !== 0) return; // Only left click

      const pos = event.data.getLocalPosition(canvas.stage);
      this.inspectCellAtPosition(pos.x, pos.y);
    };

    // Attach to canvas
    if (canvas.stage) {
      canvas.stage.on('pointerdown', this.cellInspectorHandler);
    }

    console.log('GlobalMapTools | ✓ Cell inspector activated');
  }

  /**
   * Deactivate cell inspector mode
   */
  deactivateCellInspector() {
    if (!this.isCellInspectorActive) return;

    console.log('GlobalMapTools | Deactivating cell inspector...');
    this.isCellInspectorActive = false;

    // Remove event handler
    if (canvas.stage && this.cellInspectorHandler) {
      canvas.stage.off('pointerdown', this.cellInspectorHandler);
      this.cellInspectorHandler = null;
    }

    console.log('GlobalMapTools | ✓ Cell inspector deactivated');
  }

  /**
   * Inspect cell at world position and log data to console
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   */
  inspectCellAtPosition(worldX, worldY) {
    if (!this.renderer.currentGrid || !this.renderer.currentMetadata) {
      console.warn('GlobalMapTools | No grid loaded for inspection');
      return;
    }

    const grid = this.renderer.currentGrid;
    const metadata = this.renderer.currentMetadata;
    const { heights, biomes, moisture, temperature, rows, cols } = grid;
    const { cellSize, bounds } = metadata;

    // Convert world coords to grid coords
    const gridCol = Math.floor((worldX - bounds.minX) / cellSize);
    const gridRow = Math.floor((worldY - bounds.minY) / cellSize);

    // Check bounds
    if (gridRow < 0 || gridRow >= rows || gridCol < 0 || gridCol >= cols) {
      console.log('GlobalMapTools | Click outside grid bounds');
      return;
    }

    const idx = gridRow * cols + gridCol;

    // Gather cell data
    const height = heights[idx];
    const moist = moisture ? moisture[idx] : null;
    const temp = temperature ? temperature[idx] : null;

    // Resolve biome ID (prefer explicit biomes array; fallback to legacy moisture/temperature)
    const resolver = this.processing?.biomeResolver;
    const biomeId = (biomes && biomes.length)
      ? biomes[idx]
      : (resolver ? resolver.getBiomeId(moist ?? 0, temp ?? 0) : 0);

    const biomeName = resolver
      ? resolver.getBiomeName(biomeId)
      : _f('SPACEHOLDER.GlobalMap.Biomes.DefaultNameFallback', { id: biomeId });
    const biomeColor = resolver ? resolver.getBiomeColor(biomeId) : 0x888888;
    const biomeRank = resolver ? resolver.getBiomeRank(biomeId) : 0;

    // Format color as hex string
    const colorHex = '#' + ('000000' + biomeColor.toString(16)).slice(-6).toUpperCase();

    // Log to console with color styling
    console.log(
      `%c${biomeName}%c (id=${biomeId}, rank=${biomeRank}, h=${height.toFixed(1)}, t=${temp ?? '?'}, m=${moist ?? '?'})`,
      `background-color: ${colorHex}; color: ${this._getContrastColor(biomeColor)}; padding: 2px 6px; border-radius: 3px; font-weight: bold;`,
      `color: inherit; padding: 2px 0;`
    );
  }

  /**
   * Get contrasting text color (black or white) for given background color
   * @private
   * @param {number} rgbColor - RGB color as 24-bit integer
   * @returns {string} '#000000' or '#FFFFFF'
   */
  _getContrastColor(rgbColor) {
    // Extract RGB components
    const r = (rgbColor >> 16) & 0xFF;
    const g = (rgbColor >> 8) & 0xFF;
    const b = rgbColor & 0xFF;
    
    // Calculate relative luminance (WCAG formula)
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    
    // Return black for bright colors, white for dark colors
    return luminance > 0.5 ? '#000000' : '#FFFFFF';
  }
}

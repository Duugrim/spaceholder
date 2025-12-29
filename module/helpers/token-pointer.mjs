// Token Pointer helper for SpaceHolder system
// Implements a UI direction indicator (arrow/line) that rotates with movement
// Does not rotate the token by default. Optionally mirrors horizontally on left/right movement.

export class TokenPointer {
  constructor() {
    // Defaults (used as fallback for tokens without flags)
    this.color = this._getColorSetting(); // CSS string
    this.distance = game.settings.get('spaceholder', 'tokenpointer.distance'); // 1.0..2.0
    this.scale = game.settings.get('spaceholder', 'tokenpointer.scale'); // 0.5..2.0
    this.mode = game.settings.get('spaceholder', 'tokenpointer.mode'); // 0 OFF, 1 HOVER, 2 ALWAYS
    this.combatOnly = game.settings.get('spaceholder', 'tokenpointer.combatOnly');
    this.hideOnDead = game.settings.get('spaceholder', 'tokenpointer.hideOnDead');
    this.lockToGrid = game.settings.get('spaceholder', 'tokenpointer.lockToGrid');
    this.flipHorizontal = game.settings.get('spaceholder', 'tokenpointer.flipHorizontal');
    this.pointerType = game.settings.get('spaceholder', 'tokenpointer.pointerType'); // 'arrow' | 'line'
    this.underToken = !!game.settings.get('spaceholder', 'tokenpointer.underToken');

    this.combatRunning = this.isCombatRunning();

    // Renderer registry for future extensibility
    this.renderers = new Map();
    this._registerBuiltInRenderers();
  }

  _getColorSetting() {
    const v = game.settings.get('spaceholder', 'tokenpointer.color');
    return v?.css ?? '#000000';
  }

  _registerBuiltInRenderers() {
    // 'arrow' shape: positioned at token edge (distance = 1.25 equivalent when user sets distance = 0)
    this.renderers.set('arrow', (graphics) => {
      const edgeOffset = 62.5; // 50px (token radius) + 12.5px (1.25 * 10px base)
      graphics.moveTo(edgeOffset, 0).lineTo(edgeOffset, -10).lineTo(edgeOffset + 10, 0).lineTo(edgeOffset, 10).lineTo(edgeOffset, 0).closePath();
    });
    // 'line' shape: positioned at token edge (distance = 1.25 equivalent when user sets distance = 0)
    this.renderers.set('line', (graphics) => {
      const edgeOffset = 62.5; // 50px (token radius) + 12.5px (1.25 * 10px base)
      graphics.moveTo(edgeOffset - 10, 0).lineTo(edgeOffset, 0).closePath();
    });
    // 'marker' shape: circle (D=12, R=6) with front quarter replaced by a rotated square tip (side=6)
    // The removed quarter is from -45° to +45°. We draw the remaining 270° arc and close via a diamond tip.
    this.renderers.set('marker', (graphics) => {
      const r = 6;
      const s = 6; // square side
      const toRad = Math.PI / 180;
      const step = 10;

      // Arc from +45° to +315° (i.e., skipping the front quarter [-45°, +45°])
      const startDeg = 45;
      const endDeg = 315;

      const pointAt = (deg) => ({ x: r * Math.cos(deg * toRad), y: r * Math.sin(deg * toRad) });
      const pStart = pointAt(startDeg); // at +45°
      graphics.moveTo(pStart.x, pStart.y);

      for (let a = startDeg + step; a <= endDeg; a += step) {
        const p = pointAt(a);
        graphics.lineTo(p.x, p.y);
      }

      // Tip of the rotated square (diamond). Place the back diagonal on the removed chord x = r/√2,
      // which makes the square side s=6 match the chord length (6√2) across flats.
      const c = r / Math.SQRT2;               // chord x-position and half-vertical span
      const tipX = c + s / Math.SQRT2;        // diamond right vertex x
      const tipY = 0;

      // The arc loop ended at endDeg=315° (i.e., -45°), now draw to tip and back to start to form the nose
      graphics.lineTo(tipX, tipY);
      graphics.lineTo(pStart.x, pStart.y);
      graphics.closePath();
    });

    // 'markerV2' shape: circle with diameter = token width, centered at origin
    // Circle center is at (0,0), directional tip points right (0°)
    this.renderers.set('markerV2', (graphics) => {
      const r = 50; // radius = 50px for 100px grid (diameter = token width)
      const tipLength = 20; // length of directional tip
      const toRad = Math.PI / 180;
      const step = 10;

      // Draw circle arc from +45° to +315° (skip front quarter for directional tip)
      const startDeg = 45;
      const endDeg = 315;

      const pointAt = (deg) => ({ x: r * Math.cos(deg * toRad), y: r * Math.sin(deg * toRad) });
      const pStart = pointAt(startDeg);
      graphics.moveTo(pStart.x, pStart.y);

      // Draw the arc
      for (let a = startDeg + step; a <= endDeg; a += step) {
        const p = pointAt(a);
        graphics.lineTo(p.x, p.y);
      }
      
      // Add directional tip pointing right
      const tipX = r + tipLength; // tip extends beyond circle
      graphics.lineTo(tipX, 0); // tip point
      graphics.lineTo(pStart.x, pStart.y); // back to start
      graphics.closePath();
    });
  }

  registerRenderer(key, drawerFn) {
    this.renderers.set(key, drawerFn);
  }

  isCombatRunning() {
    try {
      if (!game?.combats || typeof game.combats.some !== 'function') return false;
      return game.combats.some((c) => c.started);
    } catch (_) {
      return false;
    }
  }

  drawAllVisible() {
    if (!canvas?.tokens?.placeables) return;
    for (const token of canvas.tokens.placeables) this.drawForToken(token);
  }

  drawForToken(token) {
    try {
      if (!token?.document) return;
      if (token.document.isSecret) return;

      const defeatedId = CONFIG.specialStatusEffects?.DEFEATED;
      const isDefeated = token.actor?.effects?.some((e) => e.statuses?.has?.(defeatedId));

      // Resolve per-token options from flags with fallback to defaults
      const fp = token.document.getFlag('spaceholder', 'tokenpointer') ?? {};
      const color = fp.color ?? this.color;
      const distanceFactor = Number(fp.distance ?? this.distance);
      const scaleFactor = Number(fp.scale ?? this.scale) || 1.0;

      // Default mode: for Global Object tokens we hide the pointer unless explicitly enabled
      const actorType = token.actor?.type ?? token.document?.actor?.type ?? null;
      const hasMode = fp.mode !== undefined && fp.mode !== null;
      const defaultMode = actorType === 'globalobject' ? 0 : this.mode;
      const mode = Number(hasMode ? fp.mode : defaultMode);

      const pointerType = fp.pointerType ?? this.pointerType;
      const underToken = !!(fp.underToken ?? this.underToken ?? false);

      // Global gating still applies for combatOnly/hideOnDead
      if ((this.combatOnly && !this.combatRunning) || (this.hideOnDead && isDefeated)) {
        if (token.tokenPointerIndicator && !token.tokenPointerIndicator?._destroyed) {
          token.tokenPointerIndicator.graphics.visible = false;
        }
        return;
      }

      // Get direction
      const direction = token.document.getFlag('spaceholder', 'tokenpointerDirection') ?? 90;

      // Distance and scale
      const maxSize = Math.max(token.w, token.h);
      const distance = (maxSize / 2) * distanceFactor;

      // Scale pointer proportionally with grid size to match token scaling
      // When grid is smaller (50px) -> pointer should be smaller (scale < 1.0)
      // When grid is larger (150px) -> pointer should be larger (scale > 1.0)
      const gridSize = canvas.grid?.size || 100;
      const baseGridSize = 100; // reference grid size (100px)
      const tokenScale = Math.abs(token.document.texture.scaleX) + Math.abs(token.document.texture.scaleY);
      // Scale proportionally with grid size to match token appearance
      const scale = (gridSize / baseGridSize) * scaleFactor;

      const width = token.w;
      const height = token.h;
      let container = token.tokenPointerIndicator;

      // Ensure container exists
      if (!container || container._destroyed) {
        container = new PIXI.Container({ name: 'tokenPointerIndicator', width, height });
        container.x = width / 2;
        container.y = height / 2;

        const graphics = new PIXI.Graphics();
        const hexColor = Number(`0x${(color ?? '#000000').substring(1, 7)}`);
        if (pointerType === 'markerV2') {
          // Solid fill without stroke for Marker V2
          graphics.beginFill(hexColor, 0.5);
        } else {
          graphics.beginFill(hexColor, 0.5).lineStyle(2, hexColor, 1).moveTo(0, 0);
        }

        // Draw pointer by type
        const drawer = this.renderers.get(pointerType) || this.renderers.get('markerV2');
        drawer(graphics);
        graphics.endFill();
        // No pivot needed for MarkerV2 - it's already centered at origin

        container.addChild(graphics);
        container.graphics = graphics;
        token.tokenPointerIndicator = container;
        if (underToken && typeof token.addChildAt === 'function') token.addChildAt(container, 0);
        else token.addChild(container);
      } else {
        // Ensure pointer layer order according to underToken flag
        if (token.children && typeof token.setChildIndex === 'function') {
          if (underToken) {
            if (token.children[0] !== container) token.setChildIndex(container, 0);
          } else {
            const topIndex = Math.max(0, token.children.length - 1);
            if (token.children[topIndex] !== container) token.setChildIndex(container, topIndex);
          }
        }
        // Update color/type if changed
        const hexColor = Number(`0x${(color ?? '#000000').substring(1, 7)}`);
        container.graphics.clear();
        if (pointerType === 'markerV2') {
          // Solid fill without stroke for Marker V2
          container.graphics.beginFill(hexColor, 0.5);
        } else {
          container.graphics.beginFill(hexColor, 0.5).lineStyle(2, hexColor, 1).moveTo(0, 0);
        }
        const drawer = this.renderers.get(pointerType) || this.renderers.get('markerV2');
        drawer(container.graphics);
        container.graphics.endFill();
        // No pivot needed for MarkerV2 - it's already centered at origin
      }

      // Update pose
      container.angle = direction;
      container.x = width / 2;
      container.y = height / 2;
      container.graphics.x = distance;
      container.graphics.scale.set(scale, scale);

      // Visibility by mode
      if (mode === 0) container.graphics.visible = false; // OFF
      else if (mode === 1) container.graphics.visible = !!token.hover; // HOVER
      else container.graphics.visible = true; // ALWAYS
    } catch (error) {
      console.error(`TokenPointer | Error drawing indicator for ${token?.name} (${token?.id})`, error);
    }
  }
}

// Helpers
function getGridType() {
  // 0: square, 1: hex rows, 2: hex columns (as in About Face)
  return Math.floor(canvas.grid.type / 2);
}

function quantizeDirectionToGrid(direction) {
  // direction in degrees (may be negative)
  const sets = [
    [45, 90, 135, 180, 225, 270, 315, 360], // Square
    [0, 60, 120, 180, 240, 300, 360], // Hex Rows
    [30, 90, 150, 210, 270, 330, 390], // Hex Columns
  ];
  const gridType = getGridType();
  const facings = sets[gridType];
  if (!facings) return direction;
  let normalized = ((direction % 360) + 360) % 360;
  // Find nearest facing
  let nearest = facings[0];
  let minDiff = Math.abs(facings[0] - normalized);
  for (let i = 1; i < facings.length; i++) {
    const d = Math.abs(facings[i] - normalized);
    if (d < minDiff) { nearest = facings[i]; minDiff = d; }
  }
  // Return nearest; convert to [-180, 180]
  let snapped = nearest;
  if (snapped > 180) snapped -= 360;
  return snapped;
}

export function registerTokenPointerSettings() {
  // Color
  game.settings.register('spaceholder', 'tokenpointer.color', {
    name: 'Token Pointer Color',
    hint: 'Color of the pointer indicator',
    scope: 'world',
    config: false,
    type: new foundry.data.fields.ColorField({ nullable: false, initial: '#000000' }),
    onChange: (v) => {
      const inst = game.spaceholder?.tokenpointer;
      if (!inst) return;
      inst.color = v?.css ?? '#000000';
      // Recreate shapes for all tokens to apply new color
      if (canvas) inst.drawAllVisible();
    },
  });

  // Distance factor (float)
  game.settings.register('spaceholder', 'tokenpointer.distance', {
    name: 'Token Pointer Distance',
    hint: 'Relative distance of pointer from token center',
    scope: 'world',
    config: false,
    default: 0.0,
    type: Number,
    onChange: (v) => {
      const inst = game.spaceholder?.tokenpointer;
      if (!inst) return;
      inst.distance = Number(v);
      if (canvas) inst.drawAllVisible();
    },
  });

  // Scale factor (float)
  game.settings.register('spaceholder', 'tokenpointer.scale', {
    name: 'Token Pointer Scale',
    hint: 'Relative size of the pointer',
    scope: 'world',
    config: false,
    default: 1.0,
    type: Number,
    onChange: (v) => {
      const inst = game.spaceholder?.tokenpointer;
      if (!inst) return;
      inst.scale = Number(v);
      if (canvas) inst.drawAllVisible();
    },
  });

  // Mode: 0 OFF, 1 HOVER, 2 ALWAYS
  game.settings.register('spaceholder', 'tokenpointer.mode', {
    name: 'Token Pointer Mode',
    hint: 'Show pointer Off / on Hover / Always',
    scope: 'world',
    config: false,
    default: 2,
    type: Number,
    choices: { 0: 'Off', 1: 'Hover', 2: 'Always' },
    onChange: (v) => {
      const inst = game.spaceholder?.tokenpointer;
      if (!inst) return;
      inst.mode = Number(v);
      if (canvas) inst.drawAllVisible();
    },
  });

  // Combat-only
  game.settings.register('spaceholder', 'tokenpointer.combatOnly', {
    name: 'Token Pointer: Only in Combat',
    hint: 'Show pointer only while combat is running',
    scope: 'world',
    config: false,
    default: false,
    type: Boolean,
    onChange: (v) => {
      const inst = game.spaceholder?.tokenpointer;
      if (!inst) return;
      inst.combatOnly = !!v;
      inst.combatRunning = inst.isCombatRunning();
      if (canvas) inst.drawAllVisible();
    },
  });

  // Hide on defeated
  game.settings.register('spaceholder', 'tokenpointer.hideOnDead', {
    name: 'Token Pointer: Hide on Defeated',
    hint: 'Hide pointer for defeated tokens',
    scope: 'world',
    config: false,
    default: true,
    type: Boolean,
    onChange: (v) => {
      const inst = game.spaceholder?.tokenpointer;
      if (!inst) return;
      inst.hideOnDead = !!v;
      if (canvas) inst.drawAllVisible();
    },
  });

  // Lock to grid facings
  game.settings.register('spaceholder', 'tokenpointer.lockToGrid', {
    name: 'Token Pointer: Lock to Grid Facings',
    hint: 'Snap pointer angle to grid facings',
    scope: 'world',
    config: false,

    default: false,
    type: Boolean,
  });

  // Flip Horizontally on left/right movement
  game.settings.register('spaceholder', 'tokenpointer.flipHorizontal', {
    name: 'Token Pointer: Flip Token Horizontally',
    hint: 'Mirror token horizontally based on horizontal movement',
    scope: 'world',
    config: false,
    default: false,
    type: Boolean,
    onChange: (v) => {
      const inst = game.spaceholder?.tokenpointer;
      if (!inst) return;
      inst.flipHorizontal = !!v;
    },
  });

  // Render under token (layer order)
  game.settings.register('spaceholder', 'tokenpointer.underToken', {
    name: 'Token Pointer: Render Under Token',
    hint: 'If enabled, the pointer is drawn beneath the token sprite',
    scope: 'world',
    config: false,
    default: true,
    type: Boolean,
    onChange: (v) => {
      const inst = game.spaceholder?.tokenpointer;
      if (!inst) return;
      inst.underToken = !!v;
      try {
        if (canvas?.tokens?.placeables) {
          for (const t of canvas.tokens.placeables) {
            const c = t.tokenPointerIndicator;
            if (c && typeof t.setChildIndex === 'function') {
              t.setChildIndex(c, v ? 0 : Math.max(0, t.children.length - 1));
            }
          }
        }
      } catch(_) {}
    },
  });

  // Pointer type (renderer key)
  game.settings.register('spaceholder', 'tokenpointer.pointerType', {
    name: 'Token Pointer: Type',
    hint: 'Pointer drawing style',
    scope: 'world',
    config: false,
    default: 'markerV2',
    type: String,
    choices: { arrow: 'Arrow', line: 'Line', marker: 'Marker', markerV2: 'Marker V2' },
    onChange: (v) => {
      const inst = game.spaceholder?.tokenpointer;
      if (!inst) return;
      inst.pointerType = String(v);
      if (canvas) inst.drawAllVisible();
    },
  });
}

export function installTokenPointerTabs() {
  try {
    const cls1 = foundry.applications.sheets.TokenConfig;
    const cls2 = foundry.applications.sheets.PrototypeTokenConfig;
    const tabDef = { id: 'spaceholderPointer', label: 'Token Pointer', icon: 'fas fa-location-arrow fa-fw' };
    if (cls1?.TABS?.sheet?.tabs && !cls1.TABS.sheet.tabs.find(t => t.id === 'spaceholderPointer')) {
      cls1.TABS.sheet.tabs.push(tabDef);
    }
    if (cls2?.TABS?.sheet?.tabs && !cls2.TABS.sheet.tabs.find(t => t.id === 'spaceholderPointer')) {
      cls2.TABS.sheet.tabs.push(tabDef);
    }
  } catch (e) {
    console.error('TokenPointer | Failed to register TokenConfig tabs', e);
  }
}

export function installTokenPointerHooks() {
  // Canvas lifecycle
  Hooks.on('canvasInit', () => {
    const inst = game.spaceholder?.tokenpointer;
    if (inst) inst.combatRunning = inst.isCombatRunning();
  });

  Hooks.on('canvasReady', () => {
    const inst = game.spaceholder?.tokenpointer;
    if (!inst) return;
    canvas.scene?.tokens?.forEach((td) => td.object && inst.drawForToken(td.object));
    
    // Установка обработчиков клавиш для Shift+WASD
    _setupPointerKeyHandlers();
  });

  // Combat changes
  const updateCombat = () => {
    const inst = game.spaceholder?.tokenpointer;
    if (!inst || !inst.combatOnly) return;
    inst.combatRunning = inst.isCombatRunning();
    canvas.tokens?.placeables?.forEach((t) => inst.drawForToken(t));
  };
  Hooks.on('combatStart', () => { const inst = game.spaceholder?.tokenpointer; if (!inst || !inst.combatOnly) return; inst.combatRunning = true; inst.drawAllVisible(); });
  Hooks.on('updateCombat', updateCombat);
  Hooks.on('deleteCombat', updateCombat);

  // Token lifecycle
  Hooks.on('createToken', (td) => { const inst = game.spaceholder?.tokenpointer; if (td.object && inst) inst.drawForToken(td.object); });
  Hooks.on('updateToken', (td) => { const inst = game.spaceholder?.tokenpointer; if (td.object && inst) inst.drawForToken(td.object); });
  Hooks.on('refreshToken', (token, opts) => { const inst = game.spaceholder?.tokenpointer; if (inst) inst.drawForToken(token); });
  Hooks.on('deleteToken', (td) => { _clearPointerHistory(td.id); }); // Очистка истории при удалении токена

  // Hover / selection highlighting
  Hooks.on('hoverToken', (token, hovered) => { const inst = game.spaceholder?.tokenpointer; if (inst) inst.drawForToken(token); });
  Hooks.on('highlightObjects', (highlighted) => { const inst = game.spaceholder?.tokenpointer; if (!inst) return; canvas.scene?.tokens?.forEach((td) => td.object && inst.drawForToken(td.object)); });
  
  // Отслеживание undo/redo операций
  // Пробуем различные способы отслеживания
  if (typeof Hooks.on === 'function') {
    // Основные хуки для undo/redo
    Hooks.on('historyUndo', _markUndoOperationStart);
    Hooks.on('historyRedo', _markUndoOperationStart);
    Hooks.on('undoOperation', _markUndoOperationStart);
    Hooks.on('redoOperation', _markUndoOperationStart);
    
    // Хуки завершения операций
    Hooks.on('historyUndoComplete', _markUndoOperationEnd);
    Hooks.on('historyRedoComplete', _markUndoOperationEnd);
    Hooks.on('undoOperationComplete', _markUndoOperationEnd);
    Hooks.on('redoOperationComplete', _markUndoOperationEnd);
    
    console.log('TokenPointer | Registered undo/redo hooks');
  }

  // Inject per-token settings UI into Token Config and Prototype Token Config
  const renderHandler = async (_app, formEl, data /*, options */) => {
    try {
      const root = formEl;
      if (!root) return;

      // Determine tab group from nav
      const nav = root.querySelector('nav.sheet-tabs') || root.querySelector('nav.tabs');
      const group = nav?.dataset?.group || 'sheet';

      // Build context from data and token flags
      const doc = data?.document ?? data?.source;
      const fp = doc?.flags?.spaceholder?.tokenpointer ?? {};
      const tab = data?.tabs?.spaceholderPointer ?? { active: false };

      const actorType = doc?.actor?.type ?? doc?.parent?.type ?? null;
      const hasMode = fp?.mode !== undefined && fp?.mode !== null;
      const fallbackMode = actorType === 'globalobject' ? 0 : (game.spaceholder?.tokenpointer?.mode ?? 2);

      const ctx = {
        tab,
        group,
        pointerType: fp.pointerType ?? game.spaceholder?.tokenpointer?.pointerType ?? 'markerV2',
        color: fp.color ?? game.spaceholder?.tokenpointer?.color ?? '#000000',
        distance: Number(fp.distance ?? game.spaceholder?.tokenpointer?.distance ?? 1.4),
        scale: Number(fp.scale ?? game.spaceholder?.tokenpointer?.scale ?? 1.0),
        mode: Number(hasMode ? fp.mode : fallbackMode),
        lockToGrid: !!(fp.lockToGrid ?? game.spaceholder?.tokenpointer?.lockToGrid ?? false),
        underToken: !!(fp.underToken ?? game.spaceholder?.tokenpointer?.underToken ?? false),
        disableAutoRotation: !!(fp.disableAutoRotation ?? true),
      };

      // Render panel HTML
      const tpl = await foundry.applications.handlebars.renderTemplate('systems/spaceholder/templates/token-pointer-config.hbs', ctx);
      const wrap = document.createElement('div');
      wrap.innerHTML = tpl;
      const newPanel = wrap.firstElementChild;
      if (!newPanel) return;

      // Find existing panels of same group to place after
      const existingTabs = Array.from(root.querySelectorAll(`.tab[data-group="${group}"]`));
      if (existingTabs.length) {
        const last = existingTabs[existingTabs.length - 1];
        const existingOur = root.querySelector(`.tab[data-group="${group}"][data-tab="spaceholderPointer"]`);
        if (existingOur) existingOur.replaceWith(newPanel);
        else last.insertAdjacentElement('afterend', newPanel);
      } else {
        // Fallback to window-content
        const winContent = root.querySelector('.window-content') || root;
        const existingOur = winContent.querySelector(`.tab[data-tab="spaceholderPointer"]`);
        if (existingOur) existingOur.replaceWith(newPanel);
        else winContent.appendChild(newPanel);
      }

      // Live preview handlers inside the panel (if a token object exists)
      const token = doc?.object;
      if (token) {
        const tp = game.spaceholder?.tokenpointer;
        const getInputs = () => ({
          colorInput: root.querySelector('input[name="flags.spaceholder.tokenpointer.color"]'),
          distanceInput: root.querySelector('input[name="flags.spaceholder.tokenpointer.distance"]'),
          scaleInput: root.querySelector('input[name="flags.spaceholder.tokenpointer.scale"]'),
          modeSelect: root.querySelector('select[name="flags.spaceholder.tokenpointer.mode"]'),
          typeSelect: root.querySelector('select[name="flags.spaceholder.tokenpointer.pointerType"]'),
          lockCheck: root.querySelector('input[name="flags.spaceholder.tokenpointer.lockToGrid"]'),
          underCheck: root.querySelector('input[name="flags.spaceholder.tokenpointer.underToken"]'),
        });
        const applyPreview = () => {
          try {
            const { colorInput, distanceInput, scaleInput, modeSelect, typeSelect, underCheck } = getInputs();
            const color = colorInput?.value || fp.color || tp?.color || '#000000';
            const distance = Number(distanceInput?.value ?? fp.distance ?? tp?.distance ?? 1.4);
            const scale = Number(scaleInput?.value ?? fp.scale ?? tp?.scale ?? 1.0);
            const mode = Number(modeSelect?.value ?? fp.mode ?? tp?.mode ?? 2);
            const type = typeSelect?.value ?? fp.pointerType ?? tp?.pointerType ?? 'markerV2';
            const under = !!(underCheck?.checked ?? fp.underToken ?? tp?.underToken ?? false);

            // Update pointer graphics directly without persisting flags
            if (!token.tokenPointerIndicator || token.tokenPointerIndicator._destroyed) tp?.drawForToken(token);
            const g = token.tokenPointerIndicator?.graphics;
            if (g) {
              const hexColor = Number(`0x${(color ?? '#000000').substring(1, 7)}`);
              g.clear().beginFill(hexColor, 0.5).lineStyle(2, hexColor, 1).moveTo(0, 0);
              const drawer = tp?.renderers?.get(type) || tp?.renderers?.get('markerV2');
              drawer?.(g);
              g.endFill();
              // Recompute layout
              const maxSize = Math.max(token.w, token.h);
              g.x = (maxSize / 2) * distance;
              // Scale pointer proportionally with grid size to match token scaling
              const gridSize = canvas.grid?.size || 100;
              const baseGridSize = 100; // reference grid size (100px)
              // Scale proportionally with grid size to match token appearance
              const normalizedScale = (gridSize / baseGridSize) * scale;
              g.scale.set(normalizedScale, normalizedScale);
              // Visibility by mode
              g.visible = mode === 2 ? true : mode === 1 ? !!token.hover : false;
            }
            // Layer order preview
            const c = token.tokenPointerIndicator;
            if (c && typeof token.setChildIndex === 'function') {
              token.setChildIndex(c, under ? 0 : Math.max(0, token.children.length - 1));
            }
          } catch(err) {
            console.error('TokenPointer | preview apply failed', err);
          }
        };

        const { colorInput, distanceInput, scaleInput, modeSelect, typeSelect, lockCheck, underCheck } = getInputs();
        colorInput?.addEventListener('input', applyPreview);
        colorInput?.addEventListener('change', applyPreview);
        distanceInput?.addEventListener('change', applyPreview);
        scaleInput?.addEventListener('change', applyPreview);
        modeSelect?.addEventListener('change', applyPreview);
        typeSelect?.addEventListener('change', applyPreview);
        lockCheck?.addEventListener('change', () => {/* no-op for preview */});
        underCheck?.addEventListener('change', applyPreview);

        // Initial preview to keep indicator visible when config opens
        applyPreview();
      }
    } catch (e) {
      console.error('TokenPointer | renderTokenConfig injection failed', e);
    }
  };
  Hooks.on('renderTokenConfig', renderHandler);
  Hooks.on('renderPrototypeTokenConfig', renderHandler);
  Hooks.on('closeTokenConfig', (app) => { try { const td = app?.document; if (td?.object) game.spaceholder?.tokenpointer?.drawForToken(td.object); } catch(_){} });

  // Pre-update: prevent automatic token rotation if disabled
  Hooks.on('preUpdateToken', (tokenDocument, updates, options, userId) => {
    // Check if automatic rotation should be disabled for this token
    const fp = tokenDocument.getFlag('spaceholder', 'tokenpointer') ?? {};
    const disableAutoRotation = !!(fp.disableAutoRotation ?? true);
    
    // Only block automatic rotation (when position changes), not manual rotation
    const hasPositionChange = updates.x !== undefined || updates.y !== undefined;
    const hasRotationChange = updates.rotation !== undefined;
    
    // If auto-rotation is disabled, rotation change happens WITH position change, and not from our system
    if (disableAutoRotation && hasRotationChange && hasPositionChange && !options.spaceholderPointer) {
      // Remove rotation from updates to prevent automatic rotation by core Foundry
      delete updates.rotation;
      console.log(`TokenPointer | Prevented automatic rotation for token ${tokenDocument.name}`);
    }
    // Manual rotation (Ctrl+wheel) without position change is allowed
  });
  
  // Pre-update: compute direction and optional horizontal flip  
  Hooks.on('preUpdateToken', (tokenDocument, updates, options, userId) => {
    try {
      // Отладочная информация о контексте операции (только для undo/redo)
      if ((updates.x !== undefined || updates.y !== undefined) && _isUndoRedoOperation(options)) {
        console.log('TokenPointer | Undo/Redo context detected:', {
          isUndo: options?.isUndo,
          isRedo: options?.isRedo,
          operation: options?.operation,
          source: options?.source
        });
      }
      const hasXY = updates.x !== undefined || updates.y !== undefined;
      const noPosChange = !hasXY || ((updates.x ?? tokenDocument.x) === tokenDocument.x && (updates.y ?? tokenDocument.y) === tokenDocument.y);
      const hasRotation = updates.rotation !== undefined;
      const noRotChange = !hasRotation || tokenDocument.rotation === updates.rotation;
      
      // Если нет изменений позиции и поворота - ничего не делаем
      if (noPosChange && noRotChange) return;

      // Если есть только поворот токена (Ctrl+колёсико), НЕ обновляем направление указателя
      // Указатель должен сохранять своё направление в мировых координатах
      if (hasRotation && noPosChange) {
        console.log('TokenPointer | Token rotation detected, preserving pointer direction');
        return; // Не обновляем tokenpointerDirection при чистом повороте токена
      }
      
      // Проверка на undo операцию с использованием контекста
      if (hasXY && !hasRotation && _isUndoRedoOperation(options)) {
        const newX = updates.x ?? tokenDocument.x;
        const newY = updates.y ?? tokenDocument.y;
        const savedDirection = _findPointerStateForPosition(tokenDocument.id, newX, newY);
        
        if (savedDirection !== null) {
          console.log(`TokenPointer | Undo operation confirmed: restoring pointer direction ${savedDirection}° for position (${newX},${newY})`);
          foundry.utils.setProperty(updates, 'flags.spaceholder.tokenpointerDirection', savedDirection);
          return;
        } else {
          console.log(`TokenPointer | Undo operation detected but no saved state found for position (${newX},${newY})`);
        }
      }

      let tokenDirection;
      
      // Проверяем, зажата ли клавиша Shift во время движения
      // Используем тот же API, что и в Token Rotator
      const { SHIFT } = foundry.helpers.interaction.KeyboardManager.MODIFIER_KEYS;
      const isShiftHeld = game.keyboard?.isModifierActive(SHIFT);
      
      // Отладочный вывод для Shift (только когда зажат)
      if (hasXY && isShiftHeld) {
        console.log(`TokenPointer | Shift+drag detected: preserving pointer direction`);
      }
      
      // Только при движении токена пересчитываем направление указателя
      if (hasXY && !hasRotation) {
        const prev = { x: tokenDocument.x, y: tokenDocument.y };
        const next = { x: updates.x ?? tokenDocument.x, y: updates.y ?? tokenDocument.y };
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;

        if (dx !== 0 || dy !== 0) {
          // Если зажат Shift при перетаскивании, не меняем направление указателя
          if (isShiftHeld) {
            return; // Сохраняем текущее направление указателя
          }
          tokenDirection = (Math.atan2(dy, dx) * 180) / Math.PI;
          const fp = tokenDocument.getFlag('spaceholder', 'tokenpointer') ?? {};
          const lockToGrid = !!fp.lockToGrid || (!!game.spaceholder?.tokenpointer?.lockToGrid && !!canvas.grid?.type);
          if (lockToGrid) tokenDirection = quantizeDirectionToGrid(tokenDirection);

          // Optional horizontal flip (global setting)
          const inst = game.spaceholder?.tokenpointer;
          if (inst?.flipHorizontal && dx !== 0) {
            const source = tokenDocument.toObject();
            const scaleX = tokenDocument.texture?.scaleX ?? source.texture?.scaleX ?? 1;
            if ((dx > 0 && scaleX < 0) || (dx < 0 && scaleX > 0)) {
              updates['texture.scaleX'] = (source.texture?.scaleX ?? 1) * -1;
            }
          }
          
          foundry.utils.setProperty(updates, 'flags.spaceholder.tokenpointerDirection', tokenDirection);
          
          // Сохраняем состояние перед обновлением
          const currentDirection = tokenDocument.getFlag('spaceholder', 'tokenpointerDirection') ?? 90;
          _savePointerState(tokenDocument.id, tokenDocument.x, tokenDocument.y, currentDirection);
        }
      }
      
      // Если есть и движение, и поворот одновременно
      if (hasXY && hasRotation) {
        // Если зажат Shift при перетаскивании, не меняем направление указателя
        if (isShiftHeld) {
          return; // Сохраняем текущее направление указателя
        }
        
        // В этом случае используем направление движения, игнорируя поворот токена
        const prev = { x: tokenDocument.x, y: tokenDocument.y };
        const next = { x: updates.x ?? tokenDocument.x, y: updates.y ?? tokenDocument.y };
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;

        if (dx !== 0 || dy !== 0) {
          tokenDirection = (Math.atan2(dy, dx) * 180) / Math.PI;
          const fp = tokenDocument.getFlag('spaceholder', 'tokenpointer') ?? {};
          const lockToGrid = !!fp.lockToGrid || (!!game.spaceholder?.tokenpointer?.lockToGrid && !!canvas.grid?.type);
          if (lockToGrid) tokenDirection = quantizeDirectionToGrid(tokenDirection);
          
          foundry.utils.setProperty(updates, 'flags.spaceholder.tokenpointerDirection', tokenDirection);
          
          // Сохраняем состояние перед обновлением
          const currentDirection = tokenDocument.getFlag('spaceholder', 'tokenpointerDirection') ?? 90;
          _savePointerState(tokenDocument.id, tokenDocument.x, tokenDocument.y, currentDirection);
        }
      }
    } catch (error) {
      console.error('TokenPointer | preUpdateToken error', error);
    }
  });
}

// Переменные для обработки Shift+WASD
let pointerRotationActive = false;
let pointerRotationDirection = null;
const POINTER_ROTATION_SPEED = 15; // градусы за шаг

// Система сохранения состояния указателя для undo
const pointerStateHistory = new Map(); // tokenId -> Array of {position: {x, y}, direction: number, timestamp: number}
const MAX_HISTORY_SIZE = 50; // максимальное количество сохраненных состояний для каждого токена

// Система отслеживания undo операций
let isUndoOperationActive = false;
let undoOperationTimeStamp = 0;
const UNDO_DETECTION_WINDOW = 100; // мс - окно для определения undo

/**
 * Сохраняет текущее состояние указателя в историю
 * @param {String} tokenId - ID токена
 * @param {Number} x - координата X токена
 * @param {Number} y - координата Y токена
 * @param {Number} direction - направление указателя
 */
function _savePointerState(tokenId, x, y, direction) {
  if (!pointerStateHistory.has(tokenId)) {
    pointerStateHistory.set(tokenId, []);
  }
  
  const history = pointerStateHistory.get(tokenId);
  const state = {
    position: { x, y },
    direction,
    timestamp: Date.now()
  };
  
  // Добавляем новое состояние в начало
  history.unshift(state);
  
  // Ограничиваем размер истории
  if (history.length > MAX_HISTORY_SIZE) {
    history.splice(MAX_HISTORY_SIZE);
  }
  
  // Логируем только в режиме отладки
  // console.log(`TokenPointer | Saved state for ${tokenId}: pos(${x},${y}), direction=${direction}°`);
}

/**
 * Получает предыдущее состояние указателя для заданной позиции токена
 * @param {String} tokenId - ID токена
 * @param {Number} x - целевая координата X
 * @param {Number} y - целевая координата Y
 * @returns {Number|null} - направление указателя или null
 */
function _findPointerStateForPosition(tokenId, x, y) {
  if (!pointerStateHistory.has(tokenId)) {
    return null;
  }
  
  const history = pointerStateHistory.get(tokenId);
  const tolerance = 5; // допустимое отклонение в пикселях
  
  // Ищем состояние с позицией, соответствующей целевой
  for (const state of history) {
    const dx = Math.abs(state.position.x - x);
    const dy = Math.abs(state.position.y - y);
    if (dx <= tolerance && dy <= tolerance) {
      console.log(`TokenPointer | Found matching state for ${tokenId}: pos(${state.position.x},${state.position.y}), direction=${state.direction}°`);
      return state.direction;
    }
  }
  
  return null;
}

/**
 * Очищает историю для токена (например, при удалении токена)
 * @param {String} tokenId - ID токена
 */
function _clearPointerHistory(tokenId) {
  pointerStateHistory.delete(tokenId);
  console.log(`TokenPointer | Cleared history for ${tokenId}`);
}

/**
 * Определяет, является ли операция undo/redo
 * @param {Object} options - опции обновления
 * @returns {Boolean} - true если это undo/redo операция
 */
function _isUndoRedoOperation(options) {
  // Метод 1: Проверка прямых флагов в опциях
  if (options?.isUndo === true || options?.undo === true || options?.isRedo === true || options?.redo === true) {
    return true;
  }
  
  // Метод 2: Проверка источника операции
  const source = options?.source || options?.operation;
  if (source === 'undo' || source === 'redo' || source === 'history') {
    return true;
  }
  
  // Метод 3: Проверка флага глобального состояния
  if (isUndoOperationActive && (Date.now() - undoOperationTimeStamp) < UNDO_DETECTION_WINDOW) {
    return true;
  }
  
  return false;
}

/**
 * Отмечает начало undo операции
 */
function _markUndoOperationStart() {
  isUndoOperationActive = true;
  undoOperationTimeStamp = Date.now();
  console.log('TokenPointer | Undo operation started');
}

/**
 * Отмечает завершение undo операции
 */
function _markUndoOperationEnd() {
  // Откладываем сброс флага, чтобы дать время всем обновлениям
  setTimeout(() => {
    isUndoOperationActive = false;
    console.log('TokenPointer | Undo operation ended');
  }, UNDO_DETECTION_WINDOW);
}

/**
 * Установка обработчиков клавиш для поворота указателя
 */
function _setupPointerKeyHandlers() {
  // Обработчик нажатий клавиш
  document.addEventListener('keydown', (event) => {
    // Проверяем что нажат Shift
    if (!event.shiftKey) return;
    
    // Получаем выбранные токены
    const controlled = canvas.tokens?.controlled;
    if (!controlled || controlled.length === 0) return;
    
    let direction = null;
    switch (event.code) {
      case 'KeyW': // Вверх
        direction = -90; // Вверх в мировых координатах
        break;
      case 'KeyS': // Вниз  
        direction = 90;
        break;
      case 'KeyA': // Влево
        direction = 180;
        break;
      case 'KeyD': // Вправо
        direction = 0;
        break;
      default:
        return; // Не наша клавиша
    }
    
    // Предотвращаем стандартную обработку клавиши
    event.preventDefault();
    event.stopPropagation();
    
    console.log(`TokenPointer | Shift+${event.code} pressed, rotating pointer to ${direction}°`);
    
    // Поворачиваем указатель для каждого выбранного токена
    const updates = [];
    for (const token of controlled) {
      const currentDirection = token.document.getFlag('spaceholder', 'tokenpointerDirection') ?? 90;
      let newDirection;
      
      if (event.ctrlKey) {
        // Ctrl+Shift+WASD - плавный поворот на POINTER_ROTATION_SPEED градусов
        newDirection = currentDirection + (direction === 0 ? POINTER_ROTATION_SPEED : 
                                        direction === 90 ? POINTER_ROTATION_SPEED :
                                        direction === 180 ? -POINTER_ROTATION_SPEED : 
                                        -POINTER_ROTATION_SPEED);
      } else {
        // Просто Shift+WASD - мгновенный поворот в направление
        newDirection = direction;
      }
      
      // Нормализуем угол [-180, 180]
      newDirection = ((newDirection % 360) + 360) % 360;
      if (newDirection > 180) newDirection -= 360;
      
      updates.push({
        _id: token.id,
        'flags.spaceholder.tokenpointerDirection': newDirection
      });
    }
    
    // Применяем обновления
    if (updates.length > 0) {
      canvas.scene.updateEmbeddedDocuments('Token', updates, { animate: false });
    }
  }, true); // Используем capture фазу для перехвата событий раньше Foundry
}

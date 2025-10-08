// Token Pointer helper for SpaceHolder system
// Implements a UI direction indicator (arrow/line) that rotates with movement
// Does not rotate the token by default. Optionally mirrors horizontally on left/right movement.

export class TokenPointer {
  constructor() {
    // Settings snapshot
    this.color = this._getColorSetting(); // CSS string
    this.distance = game.settings.get('spaceholder', 'tokenpointer.distance'); // 1.0..2.0
    this.scale = game.settings.get('spaceholder', 'tokenpointer.scale'); // 0.5..2.0
    this.mode = game.settings.get('spaceholder', 'tokenpointer.mode'); // 0 OFF, 1 HOVER, 2 ALWAYS
    this.combatOnly = game.settings.get('spaceholder', 'tokenpointer.combatOnly');
    this.hideOnDead = game.settings.get('spaceholder', 'tokenpointer.hideOnDead');
    this.lockToGrid = game.settings.get('spaceholder', 'tokenpointer.lockToGrid');
    this.flipHorizontal = game.settings.get('spaceholder', 'tokenpointer.flipHorizontal');
    this.pointerType = game.settings.get('spaceholder', 'tokenpointer.pointerType'); // 'arrow' | 'line'

    // At init time game.combats may be undefined; set false and update later on canvas hooks
    this.combatRunning = false;

    // Renderer registry for future extensibility
    this.renderers = new Map();
    this._registerBuiltInRenderers();
  }

  _getColorSetting() {
    const v = game.settings.get('spaceholder', 'tokenpointer.color');
    return v?.css ?? '#000000';
  }

  _registerBuiltInRenderers() {
    // 'arrow' shape as in About Face
    this.renderers.set('arrow', (graphics) => {
      graphics.moveTo(0, 0).lineTo(0, -10).lineTo(10, 0).lineTo(0, 10).lineTo(0, 0).closePath();
    });
    // 'line' shape (simple line)
    this.renderers.set('line', (graphics) => {
      graphics.moveTo(0, 0).lineTo(-10, 0).closePath();
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
      const distance = (maxSize / 2) * (Number(this.distance) || 1.0);

      const tokenSize = Math.max(token.document.width, token.document.height);
      const tokenScale = Math.abs(token.document.texture.scaleX) + Math.abs(token.document.texture.scaleY);
      const scale = ((tokenSize * tokenScale) / 2) * (Number(this.scale) || 1.0);

      const width = token.w;
      const height = token.h;
      let container = token.tokenPointerIndicator;

      // Ensure container exists
      if (!container || container._destroyed) {
        container = new PIXI.Container({ name: 'tokenPointerIndicator', width, height });
        container.x = width / 2;
        container.y = height / 2;

        const graphics = new PIXI.Graphics();
        const hexColor = Number(`0x${(this.color ?? '#000000').substring(1, 7)}`);
        graphics.beginFill(hexColor, 0.5).lineStyle(2, hexColor, 1).moveTo(0, 0);

        // Draw pointer by type
        const drawer = this.renderers.get(this.pointerType) || this.renderers.get('arrow');
        drawer(graphics);
        graphics.endFill();

        container.addChild(graphics);
        container.graphics = graphics;
        token.tokenPointerIndicator = container;
        token.addChild(container);
      }

      // Update pose
      container.angle = direction;
      container.x = width / 2;
      container.y = height / 2;
      container.graphics.x = distance;
      container.graphics.scale.set(scale, scale);

      // Visibility by mode
      if (this.mode === 0) container.graphics.visible = false; // OFF
      else if (this.mode === 1) container.graphics.visible = !!token.hover; // HOVER
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
    default: 1.4,
    type: Number,
    range: { min: 1.0, max: 1.4, step: 0.05 },
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
    range: { min: 0.5, max: 2.0, step: 0.05 },
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
    config: true,
    default: false,
    type: Boolean,
    onChange: (v) => {
      const inst = game.spaceholder?.tokenpointer;
      if (!inst) return;
      inst.flipHorizontal = !!v;
    },
  });

  // Pointer type (renderer key)
  game.settings.register('spaceholder', 'tokenpointer.pointerType', {
    name: 'Token Pointer: Type',
    hint: 'Pointer drawing style',
    scope: 'world',
    config: false,
    default: 'arrow',
    type: String,
    choices: { arrow: 'Arrow', line: 'Line' },
    onChange: (v) => {
      const inst = game.spaceholder?.tokenpointer;
      if (!inst) return;
      inst.pointerType = String(v);
      if (canvas) inst.drawAllVisible();
    },
  });
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
  Hooks.on('refreshToken', (token, opts) => { const inst = game.spaceholder?.tokenpointer; if (inst && opts?.redrawEffects) inst.drawForToken(token); });

  // Hover / selection highlighting
  Hooks.on('hoverToken', (token, hovered) => { const inst = game.spaceholder?.tokenpointer; if (inst) inst.drawForToken(token); });
  Hooks.on('highlightObjects', (highlighted) => { const inst = game.spaceholder?.tokenpointer; if (!inst) return; canvas.scene?.tokens?.forEach((td) => td.object && inst.drawForToken(td.object)); });

  // Pre-update: compute direction and optional horizontal flip
  Hooks.on('preUpdateToken', (tokenDocument, updates) => {
    try {
      const hasXY = updates.x !== undefined || updates.y !== undefined;
      const noPosChange = !hasXY || ((updates.x ?? tokenDocument.x) === tokenDocument.x && (updates.y ?? tokenDocument.y) === tokenDocument.y);
      const noRotChange = updates.rotation === undefined || tokenDocument.rotation === updates.rotation;
      if (noPosChange && noRotChange) return;

      let tokenDirection = (updates.rotation ?? tokenDocument.rotation) + 90;

      if (hasXY && updates.rotation === undefined) {
        const prev = { x: tokenDocument.x, y: tokenDocument.y };
        const next = { x: updates.x ?? tokenDocument.x, y: updates.y ?? tokenDocument.y };
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;

        if (dx !== 0 || dy !== 0) {
          tokenDirection = (Math.atan2(dy, dx) * 180) / Math.PI;
          const inst = game.spaceholder?.tokenpointer;
          if (inst?.lockToGrid && canvas.grid?.type) {
            tokenDirection = quantizeDirectionToGrid(tokenDirection);
          }

          // Optional horizontal flip
          if (inst?.flipHorizontal && dx !== 0) {
            const source = tokenDocument.toObject();
            const scaleX = tokenDocument.texture?.scaleX ?? source.texture?.scaleX ?? 1;
            if ((dx > 0 && scaleX < 0) || (dx < 0 && scaleX > 0)) {
              updates['texture.scaleX'] = (source.texture?.scaleX ?? 1) * -1;
            }
          }
        }
      }

      foundry.utils.setProperty(updates, 'flags.spaceholder.tokenpointerDirection', tokenDirection);
    } catch (error) {
      console.error('TokenPointer | preUpdateToken error', error);
    }
  });
}

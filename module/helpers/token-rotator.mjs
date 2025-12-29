// Token Rotator helper for SpaceHolder system
// Implements rotation of tokens by holding a hotkey and moving the cursor (inspired by Alternative Rotation)

const MODULE_NS = 'spaceholder';
const PREF = 'tokenrotator';
const TAU = Math.PI * 2;
const RAD_TO_DEG = 360 / TAU;
const DEG_TO_RAD = TAU / 360;

let vfx = null;
let rotatingTokens = [];
let lastRotateTime = performance.now();
let snapHeld = false;

function getSetting(key) {
  return game.settings.get(MODULE_NS, `${PREF}.${key}`);
}

function getMousePos() {
  return canvas.mousePosition;
}

function ensureVfx() {
  if (vfx === null || vfx._geometry === null) {
    vfx = canvas.controls.addChild(new PIXI.Graphics());
    console.log('SpaceHolder | TokenRotator: created PIXI graphics');
  }
  return vfx;
}

function isRotating() {
  return rotatingTokens.length > 0;
}

function snapEnabled() {
  const snapByDefault = getSetting('altSnapByDefault');
  return snapHeld ? !snapByDefault : snapByDefault;
}

function drawArrowSingle() {
  const tok = rotatingTokens[0];
  const from = tok.center;
  const to = getMousePos();
  const width = 5;
  const color = 0xFF9829;
  const alpha = 0.8;
  const alphaMain = snapEnabled() ? 0.3 : 0.8;
  const circleR = 10;
  const arrowCornerLen = 30;
  const arrowCornerAng = 150 * DEG_TO_RAD;
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const arrowStart = { x: from.x + Math.cos(ang) * (circleR - width / 2 - 2), y: from.y + Math.sin(ang) * (circleR - width / 2 - 2) };
  const c1 = { x: to.x + Math.cos(ang + arrowCornerAng) * arrowCornerLen, y: to.y + Math.sin(ang + arrowCornerAng) * arrowCornerLen };
  const c2 = { x: to.x + Math.cos(ang - arrowCornerAng) * arrowCornerLen, y: to.y + Math.sin(ang - arrowCornerAng) * arrowCornerLen };
  ensureVfx().clear().lineStyle(width, color, alpha).drawCircle(from.x, from.y, circleR).lineStyle(width, color, alphaMain).drawPolygon(arrowStart.x, arrowStart.y, to.x, to.y).drawPolygon(to.x, to.y, c1.x, c1.y, to.x, to.y, c2.x, c2.y);

  if (snapEnabled()) {
    const snapped = rotationTowardsCursor(tok, to) * DEG_TO_RAD + TAU / 4;
    const len2 = 200;
    const to2 = { x: from.x + Math.cos(snapped) * len2, y: from.y + Math.sin(snapped) * len2 };
    const start2 = { x: from.x + Math.cos(snapped) * (circleR - width / 2 - 2), y: from.y + Math.sin(snapped) * (circleR - width / 2 - 2) };
    const c21 = { x: to2.x + Math.cos(snapped + arrowCornerAng) * arrowCornerLen, y: to2.y + Math.sin(snapped + arrowCornerAng) * arrowCornerLen };
    const c22 = { x: to2.x + Math.cos(snapped - arrowCornerAng) * arrowCornerLen, y: to2.y + Math.sin(snapped - arrowCornerAng) * arrowCornerLen };
    ensureVfx().lineStyle(5, color, alpha).drawPolygon(start2.x, start2.y, to2.x, to2.y).drawPolygon(to2.x, to2.y, c21.x, c21.y, to2.x, to2.y, c22.x, c22.y);
  }
}

function rotationTowardsCursor(tok, cursor) {
  const obj = tok.center;
  // Right = 0°, Up = -90°, Down = +90°, Left = 180° (PIXI / our pointer baseline)
  const target = Math.atan2(cursor.y - obj.y, cursor.x - obj.x);
  const degrees = target * RAD_TO_DEG;
  let dBig;
  switch (canvas.grid.type) {
    case CONST.GRID_TYPES.HEXODDR:
    case CONST.GRID_TYPES.HEXEVENR:
    case CONST.GRID_TYPES.HEXODDQ:
    case CONST.GRID_TYPES.HEXEVENQ:
      dBig = 60; break;
    case CONST.GRID_TYPES.SQUARE:
      dBig = 45; break;
    case CONST.GRID_TYPES.GRIDLESS:
      dBig = 15; break;
    default:
      console.warn(`SpaceHolder | TokenRotator: unknown grid type ${canvas.grid.type}, using 45`);
      dBig = 45; break;
  }
  const dSmall = getSetting('smoothRotation') ? 0.1 : 5;
  const snap = snapEnabled() ? dBig : dSmall;
  // Snap around our baseline (right = 0) without additional offsets
  return Math.round(degrees / snap) * snap;
}

function updateRotations() {
  const now = performance.now();
  const fastPreview = getSetting('fastPreview');
  const skipDueToFreq = (now - lastRotateTime) < 1000 / getSetting('rotationUpdateFrequency');
  const cursor = getMousePos();
  drawArrowSingle();

  const updates = [];
  for (const tok of rotatingTokens) {
    const target = rotationTowardsCursor(tok, cursor);

    if (fastPreview) {
      // Preview: draw pointer if needed and rotate its container locally
      const tp = game.spaceholder?.tokenpointer;
      if (tp) tp.drawForToken(tok);
      if (tok.tokenPointerIndicator) {
        tok.tokenPointerIndicator.angle = target;
        // ensure visibility if mode allows it
        if (tok.tokenPointerIndicator) {
          const fp = tok.document.getFlag('spaceholder', 'tokenpointer') ?? {};
          const actorType = tok.actor?.type ?? tok.document?.actor?.type ?? null;
          const hasMode = fp.mode !== undefined && fp.mode !== null;
          const fallbackMode = actorType === 'globalobject' ? 0 : (tp?.mode ?? 2);
          const mode = Number(hasMode ? fp.mode : fallbackMode);
          if (mode === 0) tok.tokenPointerIndicator.graphics.visible = false;
          else if (mode === 1) tok.tokenPointerIndicator.graphics.visible = !!tok.hover;
          else tok.tokenPointerIndicator.graphics.visible = true;
        }
      }
      continue;
    }

    // Non-preview: persist direction in token flags; TokenPointer will redraw via updateToken hook
    updates.push({ _id: tok.id, [`flags.${MODULE_NS}.tokenpointerDirection`]: target });
  }

  if (skipDueToFreq) return;
  if (updates.length > 0 && !fastPreview) {
    lastRotateTime = performance.now();
    canvas.scene.updateEmbeddedDocuments('Token', updates, { animate: false });
  }
}

function onMouseMove() {
  if (isRotating()) updateRotations();
}

function completeRotation() {
  ensureVfx().clear();
  const cursor = getMousePos();
  const updates = rotatingTokens.map(tok => {
    const angle = rotationTowardsCursor(tok, cursor);
    return { _id: tok.id, [`flags.${MODULE_NS}.tokenpointerDirection`]: angle };
  });
  if (updates.length > 0) {
    canvas.scene.updateEmbeddedDocuments('Token', updates, { animate: false });
  }
  // Force redraw pointers after commit
  const tp = game.spaceholder?.tokenpointer;
  if (tp) {
    for (const tok of rotatingTokens) tp.drawForToken(tok);
  }
  rotatingTokens = [];
}

function onRotateDown() {
  const { CONTROL } = foundry.helpers.interaction.KeyboardManager.MODIFIER_KEYS;
  const binding = game.keybindings.get(MODULE_NS, `${PREF}.rotate`)[0];
  if (binding?.key === 'KeyO' && game.keyboard.isModifierActive(CONTROL)) return; // avoid Ctrl+O edge cases
  const controlled = canvas.tokens.controlled;
  if (!controlled?.length) return;
  rotatingTokens = controlled;
  updateRotations();
}

function onRotateUp() {
  if (isRotating()) completeRotation();
}

function onSnapDown() {
  snapHeld = true;
  if (rotatingTokens.length === 1) drawArrowSingle();
}

function onSnapUp() {
  snapHeld = false;
  if (rotatingTokens.length === 1) drawArrowSingle();
}

export function registerTokenRotatorSettings() {
  // Client settings, hidden from main list (handled via submenu form)
  game.settings.register(MODULE_NS, `${PREF}.altSnapByDefault`, {
    name: 'TokenRotator: Snap by Default', scope: 'client', config: false, default: false, type: Boolean,
  });
  game.settings.register(MODULE_NS, `${PREF}.smoothRotation`, {
    name: 'TokenRotator: Smooth Rotation', scope: 'client', config: false, default: false, type: Boolean,
  });
  game.settings.register(MODULE_NS, `${PREF}.fastPreview`, {
    name: 'TokenRotator: Fast Preview', scope: 'client', config: false, default: true, type: Boolean,
  });
  game.settings.register(MODULE_NS, `${PREF}.rotationUpdateFrequency`, {
    name: 'TokenRotator: Update Frequency', scope: 'client', config: false, default: 60, type: Number,
  });
}

export function installTokenRotator() {
  Hooks.once('setup', () => {
    const { SHIFT, ALT, CONTROL } = foundry.helpers.interaction.KeyboardManager.MODIFIER_KEYS;
    game.keybindings.register(MODULE_NS, `${PREF}.rotate`, {
      name: 'TokenRotator: Rotate', hint: 'Hold to rotate tokens towards cursor',
      editable: [{ key: 'KeyO' }], reservedModifiers: [SHIFT, ALT, CONTROL], onDown: onRotateDown, onUp: onRotateUp,
    });
    game.keybindings.register(MODULE_NS, `${PREF}.snap`, {
      name: 'TokenRotator: Snap', hint: 'Hold to snap rotation to grid directions',
      editable: [{ key: 'ShiftLeft' }, { key: 'ShiftRight' }], onDown: onSnapDown, onUp: onSnapUp,
    });
  });

  Hooks.once('canvasInit', () => { ensureVfx(); });
  Hooks.on('canvasReady', () => { canvas.stage.on('mousemove', onMouseMove); });
}

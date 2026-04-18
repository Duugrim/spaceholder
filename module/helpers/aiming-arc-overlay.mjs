const MODULE_NS = 'spaceholder';
const OVERLAY_KEY = 'aimingArcOverlay';
let _installed = false;
const _forcedTokenKeys = new Set();

function _tokenKey(token) {
  return String(token?.document?.uuid ?? token?.document?.id ?? token?.id ?? '');
}

function _degToRad(v) {
  return (Number(v) * Math.PI) / 180;
}

function _normalizeHalfZones(actor) {
  const cfg = CONFIG?.SPACEHOLDER?.aimingArc ?? {};
  const segmentCount = Math.max(1, Number(cfg.segmentCount) || 5);
  const maxHalf = Math.max(1, Number(cfg.maxHalfAngleDeg) || 90);
  const defaults = Array.isArray(cfg.defaultZoneHalfDegrees) ? cfg.defaultZoneHalfDegrees : [1, 5, 15, 25, 30];
  const src = actor?.system?.aimingArc?.zoneHalfDegrees;
  const raw = Array.isArray(src) ? src : defaults;
  const zones = [];
  let remaining = maxHalf;
  for (let i = 0; i < segmentCount; i += 1) {
    const n = Number(raw[i] ?? defaults[i] ?? 0);
    const safe = Number.isFinite(n) ? Math.max(0, n) : 0;
    const clipped = Math.min(remaining, safe);
    zones.push(clipped);
    remaining = Math.max(0, remaining - clipped);
  }
  return zones;
}

function _isEnabled() {
  try {
    return !!game.settings.get(MODULE_NS, 'aimingArc.showOnHover');
  } catch (_) {
    return false;
  }
}

function _ensureOverlay(token) {
  if (!token) return null;
  let container = token[OVERLAY_KEY];
  if (!container || container._destroyed) {
    container = new PIXI.Container({ name: OVERLAY_KEY });
    const graphics = new PIXI.Graphics();
    container.addChild(graphics);
    container.graphics = graphics;
    token.addChild(container);
    token[OVERLAY_KEY] = container;
  }
  return container;
}

function _destroyOverlay(token) {
  const container = token?.[OVERLAY_KEY];
  if (container && !container._destroyed) container.destroy({ children: true });
  if (token) token[OVERLAY_KEY] = null;
}

function _drawSide(graphics, startDeg, zones, radiusInner, radiusOuter, colors, alpha, sign = 1) {
  let cursor = startDeg;
  const anticlockwise = sign < 0;
  for (let i = 0; i < zones.length; i += 1) {
    const zoneHalf = Number(zones[i] ?? 0);
    if (!zoneHalf || zoneHalf <= 0) continue;
    const next = cursor + (zoneHalf * sign);
    const color = Number(colors[i] ?? 0xffffff);
    const innerStart = _degToRad(cursor);
    const innerEnd = _degToRad(next);
    graphics.beginFill(color, alpha);
    graphics.moveTo(Math.cos(innerStart) * radiusInner, Math.sin(innerStart) * radiusInner);
    graphics.arc(0, 0, radiusInner, innerStart, innerEnd, anticlockwise);
    graphics.lineTo(Math.cos(innerEnd) * radiusOuter, Math.sin(innerEnd) * radiusOuter);
    graphics.arc(0, 0, radiusOuter, innerEnd, innerStart, !anticlockwise);
    graphics.closePath();
    graphics.endFill();
    cursor = next;
  }
}

function _renderOverlay(token) {
  const container = _ensureOverlay(token);
  if (!container?.graphics) return;
  const g = container.graphics;
  g.clear();

  const cfg = CONFIG?.SPACEHOLDER?.aimingArc ?? {};
  const colors = Array.isArray(cfg.overlayColors) ? cfg.overlayColors : [0x9b59ff, 0x46d36a, 0xf0d04a, 0xf39c3d, 0xe05252];
  const alpha = Math.min(1, Math.max(0, Number(cfg.overlayAlpha) || 0.36));
  const thickness = Math.max(8, Number(cfg.overlayThicknessPx) || 44);
  const direction = Number(token.document?.getFlag(MODULE_NS, 'tokenpointerDirection') ?? 90);
  const zones = _normalizeHalfZones(token.actor);

  const radiusInner = Math.max(token.w, token.h);
  const radiusOuter = radiusInner + thickness;

  container.x = token.w / 2;
  container.y = token.h / 2;
  container.angle = direction;
  container.visible = true;

  // Local forward axis is +X. Draw both shoulders up/down around it.
  _drawSide(g, 0, zones, radiusInner, radiusOuter, colors, alpha, 1);
  _drawSide(g, 0, zones, radiusInner, radiusOuter, colors, alpha, -1);
}

export function clearAimingArcOverlays() {
  const tokens = canvas?.tokens?.placeables ?? [];
  for (const token of tokens) _destroyOverlay(token);
}

export function drawAimingArcOverlayForToken(token, hovered = token?.hover) {
  if (!token) return;
  const forced = _forcedTokenKeys.has(_tokenKey(token));
  const shouldShow = _isEnabled()
    && (!!hovered || forced)
    && !!token.actor
    && (token.actor.type === 'character' || token.actor.type === 'npc');
  const shouldShowForced = forced
    && !!token.actor
    && (token.actor.type === 'character' || token.actor.type === 'npc');
  if (!shouldShow && !shouldShowForced) {
    _destroyOverlay(token);
    return;
  }
  _renderOverlay(token);
}

export function setForcedAimingArcOverlay(token, forced) {
  const key = _tokenKey(token);
  if (!key) return;
  if (forced) _forcedTokenKeys.add(key);
  else _forcedTokenKeys.delete(key);
  drawAimingArcOverlayForToken(token, token?.hover);
}

export function refreshHoveredAimingArcOverlays() {
  const tokens = canvas?.tokens?.placeables ?? [];
  for (const token of tokens) drawAimingArcOverlayForToken(token, token.hover);
}

export function installAimingArcOverlayHooks() {
  if (_installed) return;
  _installed = true;

  Hooks.on('canvasReady', () => {
    refreshHoveredAimingArcOverlays();
  });

  Hooks.on('hoverToken', (token, hovered) => {
    drawAimingArcOverlayForToken(token, hovered);
  });

  Hooks.on('refreshToken', (token) => {
    drawAimingArcOverlayForToken(token, token?.hover);
  });

  Hooks.on('updateToken', (tokenDoc) => {
    if (tokenDoc?.object) drawAimingArcOverlayForToken(tokenDoc.object, tokenDoc.object.hover);
  });

  Hooks.on('deleteToken', (tokenDoc) => {
    if (tokenDoc?.object) {
      _forcedTokenKeys.delete(_tokenKey(tokenDoc.object));
      _destroyOverlay(tokenDoc.object);
    }
  });
}

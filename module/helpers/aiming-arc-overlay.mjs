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
  const standardZoneCount = Math.max(1, Number(cfg.standardZoneCount) || 4);
  const defaults = Array.isArray(cfg.defaultZoneWeights) ? cfg.defaultZoneWeights : [5, 15, 25, 30];
  const aimingArc = actor?.system?.aimingArc ?? {};
  const legacyZones = Array.isArray(aimingArc.zoneHalfDegrees) ? aimingArc.zoneHalfDegrees : [];
  const rawWeights = Array.isArray(aimingArc.zoneWeights) ? aimingArc.zoneWeights : [];
  const purpleRaw = Number(aimingArc.purpleZoneDeg);
  const defaultPurple = Math.max(0, Number(cfg.defaultPurpleZoneDeg) || 1);
  const legacyPurple = Number(legacyZones[0]);
  const purpleZoneDeg = Number.isFinite(purpleRaw)
    ? Math.max(0, purpleRaw)
    : (Number.isFinite(legacyPurple) ? Math.max(0, legacyPurple) : defaultPurple);
  const totalRaw = Number(aimingArc.totalArcDeg);
  const defaultTotalArc = Math.max(0, Number(cfg.defaultTotalArcDeg) || 90);
  const legacyTotalArc = legacyZones.slice(1).reduce((sum, val) => sum + Math.max(0, Number(val) || 0), 0);
  const totalArcDeg = Number.isFinite(totalRaw)
    ? Math.max(0, totalRaw)
    : (legacyTotalArc > 0 ? legacyTotalArc : defaultTotalArc);
  const deadRaw = Number(aimingArc.deadZoneDeg);
  const defaultDeadZone = Math.max(0, Number(cfg.defaultDeadZoneDeg) || 0);
  const deadZoneDeg = Number.isFinite(deadRaw) ? Math.max(0, deadRaw) : defaultDeadZone;
  const visiblePerSideDeg = Math.max(0, 180 - deadZoneDeg);
  const standardZones = [];
  const weights = [];
  let weightSum = 0;
  const weightOffset = rawWeights.length >= standardZoneCount + 1 ? 1 : 0;
  for (let i = 0; i < standardZoneCount; i += 1) {
    const n = Number(rawWeights[i + weightOffset] ?? legacyZones[i + 1] ?? defaults[i] ?? 0);
    const safe = Number.isFinite(n) ? Math.max(0, n) : 0;
    weights.push(safe);
    weightSum += safe;
  }
  for (let i = 0; i < standardZoneCount; i += 1) {
    const zoneDeg = weightSum > 0 ? (totalArcDeg * weights[i]) / weightSum : 0;
    standardZones.push(Math.max(0, Number(zoneDeg) || 0));
  }
  const zones = [purpleZoneDeg, ...standardZones];
  return { zones, visiblePerSideDeg };
}

function _isEnabled() {
  try {
    return !!game.settings.get(MODULE_NS, 'aimingArc.showOnHover');
  } catch (_) {
    return false;
  }
}

function _isTokenInCombat(token) {
  try {
    if (token?.inCombat) return true;
    const tokenId = token?.id ?? token?.document?.id ?? null;
    if (!tokenId) return false;
    const combats = game?.combats;
    if (!combats || typeof combats[Symbol.iterator] !== 'function') return false;
    for (const combat of combats) {
      const combatants = combat?.combatants;
      if (!combatants) continue;
      for (const cm of combatants) {
        if (cm?.tokenId === tokenId) return true;
      }
    }
    return false;
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

function _drawSide(graphics, startDeg, zones, radiusInner, radiusOuter, colors, alpha, sideLimitDeg, sign = 1) {
  let cursor = startDeg;
  const anticlockwise = sign < 0;
  let remainingLimit = Math.max(0, Number(sideLimitDeg) || 0);
  if (remainingLimit <= 0) return;
  for (let i = 0; i < zones.length; i += 1) {
    const zoneHalf = Number(zones[i] ?? 0);
    if (!zoneHalf || zoneHalf <= 0) continue;
    const visibleZone = Math.min(zoneHalf, remainingLimit);
    if (visibleZone <= 0) break;
    const next = cursor + (visibleZone * sign);
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
    remainingLimit -= visibleZone;
    if (remainingLimit <= 0) break;
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
  const { zones, visiblePerSideDeg } = _normalizeHalfZones(token.actor);

  const radiusInner = Math.max(token.w, token.h);
  const radiusOuter = radiusInner + thickness;

  container.x = token.w / 2;
  container.y = token.h / 2;
  container.angle = direction;
  container.visible = true;

  // Local forward axis is +X. Draw both shoulders up/down around it.
  _drawSide(g, 0, zones, radiusInner, radiusOuter, colors, alpha, visiblePerSideDeg, 1);
  _drawSide(g, 0, zones, radiusInner, radiusOuter, colors, alpha, visiblePerSideDeg, -1);
}

export function clearAimingArcOverlays() {
  const tokens = canvas?.tokens?.placeables ?? [];
  for (const token of tokens) _destroyOverlay(token);
}

export function drawAimingArcOverlayForToken(token, hovered = token?.hover) {
  if (!token) return;
  const isCharacter = !!token.actor
    && (token.actor.type === 'character' || token.actor.type === 'npc');
  if (!isCharacter) {
    _destroyOverlay(token);
    return;
  }

  const forced = _forcedTokenKeys.has(_tokenKey(token));
  const enabled = _isEnabled();
  const controlled = !!token.controlled;

  let shouldShow = forced;
  if (enabled) {
    if (hovered) shouldShow = true;
    if (controlled) shouldShow = true;
  } else if (controlled && _isTokenInCombat(token)) {
    shouldShow = true;
  }

  if (!shouldShow) {
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

export function refreshAimingArcOverlays() {
  const tokens = canvas?.tokens?.placeables ?? [];
  for (const token of tokens) drawAimingArcOverlayForToken(token, token.hover);
}

export const refreshHoveredAimingArcOverlays = refreshAimingArcOverlays;

export function installAimingArcOverlayHooks() {
  if (_installed) return;
  _installed = true;

  Hooks.on('canvasReady', () => {
    refreshAimingArcOverlays();
  });

  Hooks.on('hoverToken', (token, hovered) => {
    drawAimingArcOverlayForToken(token, hovered);
  });

  Hooks.on('controlToken', (token) => {
    drawAimingArcOverlayForToken(token, token?.hover);
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

  // Combat membership affects whether selected tokens show their arc when the
  // setting is off, so refresh overlays whenever combatants change.
  const combatHooks = ['createCombatant', 'deleteCombatant', 'updateCombatant', 'createCombat', 'deleteCombat', 'updateCombat'];
  for (const hookName of combatHooks) {
    Hooks.on(hookName, () => refreshAimingArcOverlays());
  }
}

/**
 * PIXI overlay on tokens during `combatState.turnPick`: segmented ring, slow rotation, click → pickTurn.
 * On pick resolve (`turnPick` cleared + `activeTurn` set): picked token’s ring scales up and fades; others fade out.
 * Only tokens on the scene currently viewed on this client (`canvas.scene`).
 */

const MODULE_NS = "spaceholder";

function _num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function combatManager() {
  return game?.spaceholder?.combatSessionManager ?? null;
}

function findCombatantForToken(token) {
  const combat = game.combat;
  if (!combat?.started || !token?.document) return null;
  const sceneId = token.document.parent?.id;
  if (!sceneId) return null;
  for (const c of combat.combatants.contents) {
    const td = c.token;
    if (!td || td.parent?.id !== sceneId) continue;
    if (td.id === token.document.id) return c;
  }
  return null;
}

function parseSideColor(css) {
  const s = String(css || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return Number.parseInt(s.slice(1), 16);
  return 0x8c8cf0;
}

function canUserPickCombatant(combatant) {
  if (game.user?.isGM) return true;
  const tokenDoc = combatant?.token?.document || combatant?.token;
  const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return !!tokenDoc?.testUserPermission?.(game.user, owner);
}

const PICK_FADE_MS = 300;
const PICK_EXPAND_MS = 420;

function stopTurnPickRotationTicker(container) {
  if (container?._shTicker && canvas?.app?.ticker) {
    canvas.app.ticker.remove(container._shTicker);
    container._shTicker = null;
  }
}

function stopPickResolveTicker(container) {
  if (container?._shResolveTicker && canvas?.app?.ticker) {
    canvas.app.ticker.remove(container._shResolveTicker);
    container._shResolveTicker = null;
  }
}

function removeOverlay(token) {
  const c = token.spaceholderTurnPickOverlay;
  if (!c) return;
  try {
    stopPickResolveTicker(c);
    stopTurnPickRotationTicker(c);
    c._shPickResolvePhase = null;
    c._shTurnPickVisualKey = null;
    c.destroy?.({ children: true });
  } catch (_) {
    // ignore
  }
  token.spaceholderTurnPickOverlay = null;
}

/** Non-picked eligibles: fade out the same segmented ring (sync via `updateCombat` on all clients). */
function beginPickResolveFade(token) {
  const container = token.spaceholderTurnPickOverlay;
  if (!container || container.destroyed || !canvas?.app?.ticker) return;
  if (container._shPickResolvePhase) return;
  container._shPickResolvePhase = "fade";
  stopTurnPickRotationTicker(container);
  stopPickResolveTicker(container);
  container.eventMode = "none";
  container.cursor = "default";
  container.removeAllListeners?.("pointerdown");
  container.alpha = 1;
  let elapsed = 0;
  container._shResolveTicker = () => {
    if (container.destroyed) {
      stopPickResolveTicker(container);
      return;
    }
    elapsed += canvas.app.ticker.deltaMS;
    const u = Math.min(1, elapsed / PICK_FADE_MS);
    container.alpha = 1 - u;
    if (u >= 1) {
      stopPickResolveTicker(container);
      container._shPickResolvePhase = null;
      removeOverlay(token);
    }
  };
  canvas.app.ticker.add(container._shResolveTicker);
}

/** Picked token: same ring scales up and fades (no need to keep rotation phase). */
function beginPickResolveExpand(token) {
  const container = token.spaceholderTurnPickOverlay;
  if (!container || container.destroyed || !canvas?.app?.ticker) return;
  if (container._shPickResolvePhase) return;
  container._shPickResolvePhase = "expand";
  stopTurnPickRotationTicker(container);
  stopPickResolveTicker(container);
  container.eventMode = "none";
  container.cursor = "default";
  container.removeAllListeners?.("pointerdown");
  container.scale.set(1, 1);
  container.alpha = 1;
  const scaleEnd = 1.38;
  let elapsed = 0;
  container._shResolveTicker = () => {
    if (container.destroyed) {
      stopPickResolveTicker(container);
      return;
    }
    elapsed += canvas.app.ticker.deltaMS;
    const u = Math.min(1, elapsed / PICK_EXPAND_MS);
    const s = 1 + (scaleEnd - 1) * u;
    container.scale.set(s, s);
    container.alpha = 1 - 0.92 * u;
    if (u >= 1) {
      stopPickResolveTicker(container);
      container._shPickResolvePhase = null;
      removeOverlay(token);
    }
  };
  canvas.app.ticker.add(container._shResolveTicker);
}

function drawRingSegments(g, outerR, innerR, segments, color, gap = 0.07) {
  g.clear();
  const n = Math.max(1, Math.floor(segments));
  const lw = Math.max(3, outerR - innerR);
  const mid = (outerR + innerR) / 2;
  if (typeof g.lineStyle === "function") {
    g.lineStyle(lw, color, 0.9);
  } else if (typeof g.setStrokeStyle === "function") {
    g.setStrokeStyle({ width: lw, color, alpha: 0.9 });
  }
  for (let i = 0; i < n; i++) {
    const a0 = (Math.PI * 2 * i) / n + gap;
    const a1 = (Math.PI * 2 * (i + 1)) / n - gap;
    g.moveTo(mid * Math.cos(a0), mid * Math.sin(a0));
    g.arc(0, 0, mid, a0, a1, false);
  }
}

/** Avoid full rebuild on every `refreshToken` (hover/highlight): keeps rotation + ticker smooth. */
function _turnPickOverlayVisualKey(combat, combatant, token, {
  sideId,
  color,
  segments,
  outerR,
  innerR,
  pickOk,
} = {}) {
  return [
    combat?.id,
    combatant?.id,
    sideId,
    color,
    segments,
    outerR.toFixed(2),
    innerR.toFixed(2),
    pickOk ? 1 : 0,
    Math.round(_num(token?.w, 0)),
    Math.round(_num(token?.h, 0)),
  ].join("|");
}

function ensureOverlay(token, combat, combatant) {
  const mgr = combatManager();
  if (!mgr || !canvas?.grid?.size || typeof token?.addChild !== "function") return;

  const st = combat.getFlag(MODULE_NS, "combatState") || {};
  const tp = st.turnPick;
  const inEligiblePick =
    tp?.active && Array.isArray(tp.eligibleCombatantIds) && tp.eligibleCombatantIds.includes(combatant.id);

  if (!inEligiblePick) {
    const ov = token.spaceholderTurnPickOverlay;
    if (ov && !ov.destroyed && ov._shPickResolvePhase) {
      return;
    }
    if (
      ov &&
      !ov.destroyed &&
      !tp?.active &&
      st.activeTurn?.combatantId &&
      canvas.scene?.id === token.document.parent?.id
    ) {
      const pickedId = st.activeTurn.combatantId;
      if (String(combatant.id) === String(pickedId)) beginPickResolveExpand(token);
      else beginPickResolveFade(token);
      return;
    }
    removeOverlay(token);
    return;
  }
  if (canvas.scene?.id !== token.document.parent?.id) {
    removeOverlay(token);
    return;
  }

  let containerPre = token.spaceholderTurnPickOverlay;
  if (containerPre && !containerPre.destroyed && containerPre._shPickResolvePhase) {
    stopPickResolveTicker(containerPre);
    containerPre._shPickResolvePhase = null;
    containerPre.alpha = 1;
    containerPre.scale.set(1, 1);
  }

  const sideId = String(st.currentSide || "");
  const color = parseSideColor(mgr.getCombatSideColor(sideId));
  const { remaining } = mgr.getTurnSegmentsForCombatant(combat, combatant.id);
  const segments = Math.max(1, remaining);

  const gridPx = canvas.grid.size;
  const gu = Math.max(_num(token.document.width, 1), _num(token.document.height, 1)) + 0.5;
  const outerR = (gu * gridPx) / 2;
  const innerR = outerR * 0.72;
  const pickOk = canUserPickCombatant(combatant);

  const visualKey = _turnPickOverlayVisualKey(combat, combatant, token, {
    sideId,
    color,
    segments,
    outerR,
    innerR,
    pickOk,
  });

  let container = token.spaceholderTurnPickOverlay;
  if (container && !container.destroyed && container._shTurnPickVisualKey === visualKey && container.parent === token) {
    container.x = token.w / 2;
    container.y = token.h / 2;
    if (container.cursor !== (pickOk ? "pointer" : "default")) {
      container.cursor = pickOk ? "pointer" : "default";
    }
    return;
  }

  if (!container || container.destroyed) {
    container = new PIXI.Container();
    container.name = "spaceholderTurnPickOverlay";
    token.spaceholderTurnPickOverlay = container;
    token.addChild(container);
  }

  if (container._shTicker && canvas?.app?.ticker) {
    canvas.app.ticker.remove(container._shTicker);
    container._shTicker = null;
  }

  if (container.parent && container.parent !== token) {
    try {
      container.parent.removeChild(container);
    } catch (_) {
      // ignore
    }
  }
  if (!container.parent) {
    token.addChild(container);
  }

  container.x = token.w / 2;
  container.y = token.h / 2;
  container.rotation = 0;

  container.removeChildren();
  const g = new PIXI.Graphics();
  g.name = "ring";
  drawRingSegments(g, outerR, innerR, segments, color);
  container.addChild(g);

  container._shTurnPickVisualKey = visualKey;

  container.eventMode = "static";
  container.cursor = pickOk ? "pointer" : "default";
  const r = outerR;
  container.hitArea = new PIXI.Rectangle(-r, -r, r * 2, r * 2);

  container.removeAllListeners?.("pointerdown");
  if (pickOk) {
    container.on("pointerdown", (ev) => {
      try {
        ev.stopPropagation?.();
      } catch (_) {
        // ignore
      }
      mgr.pickTurn({ combatId: combat.id, combatantId: combatant.id });
    });
  }

  if (canvas?.app?.ticker) {
    container._shTicker = () => {
      container.rotation += (Math.PI / 2) * (canvas.app.ticker.deltaMS / 1000);
    };
    canvas.app.ticker.add(container._shTicker);
  }
}

function refreshTokenOverlay(token) {
  if (!canvas?.ready) return;
  if (!game.combat?.started) {
    removeOverlay(token);
    return;
  }
  const c = findCombatantForToken(token);
  if (!c) {
    removeOverlay(token);
    return;
  }
  ensureOverlay(token, game.combat, c);
}

function clearAllOverlays() {
  if (!canvas?.tokens?.placeables) return;
  for (const t of canvas.tokens.placeables) removeOverlay(t);
}

function onCanvasReady() {
  if (!canvas?.tokens?.placeables) return;
  for (const t of canvas.tokens.placeables) refreshTokenOverlay(t);
}

function onRefreshToken(token) {
  refreshTokenOverlay(token);
}

function onUpdateToken(doc) {
  const t = canvas.tokens?.get(doc?.id);
  if (t) refreshTokenOverlay(t);
}

function onUpdateCombat(combat) {
  if (!canvas?.tokens?.placeables) return;
  if (game.combat?.id && combat?.id === game.combat.id && combat.started === false) {
    clearAllOverlays();
    return;
  }
  if (combat?.id === game.combat?.id) {
    for (const t of canvas.tokens.placeables) refreshTokenOverlay(t);
  }
}

function onDeleteCombat() {
  clearAllOverlays();
}

function onTurnPickMode(combat) {
  if (!canvas?.tokens?.placeables || !combat) return;
  if (game.combat?.id && combat.id !== game.combat.id) return;
  for (const t of canvas.tokens.placeables) refreshTokenOverlay(t);
}

/**
 * Install hooks once (call from `init` after `game.spaceholder` exists).
 */
export function installTurnPickOverlay() {
  if (installTurnPickOverlay._ok) return;
  installTurnPickOverlay._ok = true;
  Hooks.on("canvasReady", onCanvasReady);
  Hooks.on("refreshToken", onRefreshToken);
  Hooks.on("updateToken", onUpdateToken);
  Hooks.on("updateCombat", onUpdateCombat);
  Hooks.on("deleteCombat", onDeleteCombat);
  Hooks.on("spaceholder.combatTurnPickMode", onTurnPickMode);
}

const MODULE_NS = 'spaceholder';

import { getEffectiveFactionUuidForUser, getTokenFactionUuids } from '../user-factions.mjs';

let _installed = false;
let _originalIsVisionSource = null;

function isGlobalMapScene(scene) {
  return !!(
    scene?.getFlag?.(MODULE_NS, 'isGlobalMap')
    ?? scene?.flags?.[MODULE_NS]?.isGlobalMap
  );
}

function arraysIntersect(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return false;
  const setB = new Set(b);
  return a.some((x) => setB.has(x));
}

function refreshFactionVision() {
  try {
    const scene = canvas?.scene;
    if (!scene || !isGlobalMapScene(scene)) return;
    if (!canvas?.visibility?.tokenVision) return;

    // Re-evaluate token vision sources.
    const tokens = canvas?.tokens?.placeables ?? [];
    for (const t of tokens) {
      try {
        t?.initializeVisionSource?.();
      } catch (e) {
        // ignore
      }
    }

    // Force a refresh of perception now that the active vision sources set may have changed.
    try {
      canvas?.perception?.update?.({
        initializeVisionModes: true,
        refreshVision: true,
        refreshLighting: true,
      });
    } catch (e) {
      // ignore
    }
  } catch (e) {
    console.error('SpaceHolder | GlobalMapFactionVision: refresh failed', e);
  }
}

function patchIsVisionSource() {
  if (_originalIsVisionSource) return;

  const proto = globalThis?.Token?.prototype;
  const original = proto?._isVisionSource;
  if (typeof original !== 'function') {
    console.warn('SpaceHolder | GlobalMapFactionVision: Token.prototype._isVisionSource not found');
    return;
  }

  _originalIsVisionSource = original;

  proto._isVisionSource = function spaceholder_isVisionSourcePatched() {
    // Delegate for non-global-map scenes.
    const scene = this?.scene ?? this?.document?.parent ?? canvas?.scene;
    if (!isGlobalMapScene(scene)) {
      return _originalIsVisionSource.call(this);
    }

    // GM can optionally "view as faction" by selecting an active faction.
    // When no active faction is selected ("Нет фракции"), keep full GM vision.
    const effectiveFaction = getEffectiveFactionUuidForUser(game.user);
    if (game.user?.isGM && !effectiveFaction) {
      return _originalIsVisionSource.call(this);
    }

    // Keep Foundry's early exits / invariants.
    if (!canvas?.visibility?.tokenVision || !this?.hasSight) return false;
    if (this?.document?.hidden) return false;

    // Preserve the standard behavior: controlled tokens with sight always contribute;
    // when any controlled token with sight exists, ONLY controlled tokens contribute.
    if (this?.controlled) return true;
    const anyControlledWithSight = this?.layer?.controlled?.some((t) => !t?.document?.hidden && t?.hasSight);
    if (anyControlledWithSight) return false;

    // Fallback (no controlled tokens with sight): use faction matching.
    const userFactions = effectiveFaction ? [effectiveFaction] : [];
    if (!userFactions.length) return false;

    const tokenFactions = getTokenFactionUuids(this);
    if (!tokenFactions.length) return false;

    return arraysIntersect(userFactions, tokenFactions);
  };
}

function installHooks() {
  // Re-evaluate when the canvas is ready.
  Hooks.on('canvasReady', () => refreshFactionVision());

  // Re-evaluate when toggling isGlobalMap on the active scene.
  Hooks.on('updateScene', (scene, changes) => {
    try {
      const activeScene = canvas?.scene;
      if (!activeScene || scene?.id !== activeScene.id) return;

      // Detect changes to flags.spaceholder.isGlobalMap
      const flags = changes?.flags;
      const sh = flags?.[MODULE_NS];
      const changedViaFlagsObject = !!(sh && typeof sh === 'object' && Object.prototype.hasOwnProperty.call(sh, 'isGlobalMap'));
      const changedViaFlatKey = Object.keys(changes ?? {}).some((k) => k === `flags.${MODULE_NS}.isGlobalMap` || k.startsWith(`flags.${MODULE_NS}.isGlobalMap`));

      if (!(changedViaFlagsObject || changedViaFlatKey)) return;
      refreshFactionVision();
    } catch (e) {
      console.error('SpaceHolder | GlobalMapFactionVision: updateScene hook failed', e);
    }
  });

  // Re-evaluate when the current user's factions change.
  Hooks.on('updateUser', (user, changes) => {
    try {
      if (user?.id !== game.user?.id) return;

      const flags = changes?.flags;
      const sh = flags?.[MODULE_NS];
      const changedViaFlagsObject = !!(
        sh && typeof sh === 'object'
        && (Object.prototype.hasOwnProperty.call(sh, 'factions') || Object.prototype.hasOwnProperty.call(sh, 'activeFaction'))
      );
      const changedViaFlatKey = Object.keys(changes ?? {}).some((k) => (
        k === `flags.${MODULE_NS}.factions` || k.startsWith(`flags.${MODULE_NS}.factions`)
        || k === `flags.${MODULE_NS}.activeFaction` || k.startsWith(`flags.${MODULE_NS}.activeFaction`)
      ));

      if (!(changedViaFlagsObject || changedViaFlatKey)) return;
      refreshFactionVision();
    } catch (e) {
      console.error('SpaceHolder | GlobalMapFactionVision: updateUser hook failed', e);
    }
  });
}

export function installGlobalMapFactionVision() {
  if (_installed) return;
  _installed = true;

  patchIsVisionSource();
  installHooks();
}

// Export for manual debugging from console, if needed.
export const __debug = {
  refreshFactionVision,
  isGlobalMapScene,
};

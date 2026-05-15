/**
 * World setting (GM only): optional 3D anatomy on the Health tab.
 * When disabled, the system does not load Three.js / anatomy-editor-3d from the actor sheet.
 * @see registerHealthAnatomyViewerSettings
 */

export const HEALTH_ANATOMY_3D_KEY = "healthAnatomy3dEnabled";

/**
 * @returns {boolean}
 */
export function getHealthAnatomy3dEnabled() {
  try {
    return Boolean(game?.settings?.get?.("spaceholder", HEALTH_ANATOMY_3D_KEY));
  } catch (_) {
    return false;
  }
}

export function registerHealthAnatomyViewerSettings() {
  const L = (k) =>
    typeof game !== "undefined" && game.i18n?.localize ? game.i18n.localize(k) : k;

  game.settings.register("spaceholder", HEALTH_ANATOMY_3D_KEY, {
    name: L("SPACEHOLDER.Settings.HealthAnatomy3d.Name"),
    hint: L("SPACEHOLDER.Settings.HealthAnatomy3d.Hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    restricted: true,
    requiresReload: true,
  });
}

/**
 * Height Map Scene Configuration Extension
 * NOTE: Height map file picker has been removed from scene configuration.
 * Use the "Create Overlay Map" button in the Height Map Editor toolbar instead.
 */

/**
 * Register hooks for scene configuration
 * @deprecated - Height map field removed from scene config
 */
export function registerHeightMapSceneConfig() {
  // No longer adds height map field to scene configuration
  // Kept for backward compatibility
}

/**
 * Install hooks for height map scene configuration
 */
export function installHeightMapSceneConfigHooks() {
  // Hook when scene is updated - just log the change
  Hooks.on('updateScene', async (scene, changes, options, userId) => {
    if (changes.flags?.spaceholder?.heightMapPath !== undefined) {
      console.log(`HeightMapSceneConfig | Height map path updated for scene: ${scene.name}`);
      console.log(`HeightMapSceneConfig | New path: ${changes.flags.spaceholder.heightMapPath}`);
      console.log(`HeightMapSceneConfig | Use game.spaceholder.processHeightMap() to process the height map`);
    }
  });
}

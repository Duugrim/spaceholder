/**
 * Height Map Scene Configuration Extension
 * Adds height map file picker to scene configuration
 */

/**
 * Register hooks for scene configuration
 */
export function registerHeightMapSceneConfig() {
  // Hook to add height map field to scene configuration
  Hooks.on('renderSceneConfig', (app, html, data) => {
    addHeightMapField(app, html, data);
  });
}

/**
 * Add height map file picker field to scene configuration
 * @param {SceneConfig} app - The scene config application
 * @param {HTMLElement} html - The HTML content
 * @param {Object} data - The render data
 */
function addHeightMapField(app, html, data) {
  // Get current height map path from scene flags
  const scene = app.document || app.object;
  if (!scene) {
    console.warn('HeightMapSceneConfig | No scene document available');
    return;
  }
  
  const heightMapPath = scene.getFlag('spaceholder', 'heightMapPath') || '';
  
  // Create the form group element
  const formGroup = document.createElement('div');
  formGroup.className = 'form-group';
  formGroup.innerHTML = `
    <label>Height Map File (JSON)</label>
    <div class="form-fields">
      <button type="button" class="file-picker" data-type="json" data-target="flags.spaceholder.heightMapPath" title="Browse Files" tabindex="-1">
        <i class="fas fa-file-import fa-fw"></i>
      </button>
      <input class="image" type="text" name="flags.spaceholder.heightMapPath" placeholder="Path to height map JSON file" value="${heightMapPath}" data-dtype="String">
    </div>
    <p class="notes">Select a height map JSON file from Azgaar's Fantasy Map Generator (PackCells or Minimal export recommended)</p>
  `;
  
  // Find the form footer (buttons) and insert before it
  const formFooter = html.querySelector('footer.sheet-footer, .form-footer, button[type="submit"]')?.closest('footer, .form-footer') 
    || html.querySelector('button[type="submit"]')?.parentElement;
  
  if (formFooter) {
    formFooter.insertAdjacentElement('beforebegin', formGroup);
  } else {
    // Fallback: append to form body if footer not found
    const formBody = html.querySelector('form');
    if (formBody) {
      formBody.appendChild(formGroup);
    } else {
      console.warn('HeightMapSceneConfig | Could not find suitable location to insert height map field');
      return;
    }
  }
  
  // Activate file picker for the new field
  const filePicker = formGroup.querySelector('button.file-picker');
  const inputField = formGroup.querySelector('input[name="flags.spaceholder.heightMapPath"]');
  
  filePicker.addEventListener('click', function() {
    const current = inputField.value;
    const fp = new foundry.applications.apps.FilePicker({
      type: "json",
      current: current,
      callback: (path) => {
        inputField.value = path;
      }
    });
    fp.browse();
  });
  
  console.log('HeightMapSceneConfig | Height map field added to scene configuration');
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

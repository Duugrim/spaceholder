/**
 * ⚠️ УСТАРЕВШИЙ КОД - НЕ ИСПОЛЬЗОВАТЬ ⚠️
 * 
 * Этот модуль является УСТАРЕВШИМ и больше НЕ используется в системе.
 * Код сохранён только для справки и примеров старой реализации.
 * 
 * ❌ НЕ дорабатывайте этот код
 * ❌ НЕ используйте его в новых функциях
 * ✅ Используйте только как справочный материал
 * 
 * @deprecated Используйте новые модули terrain вместо legacy terrain controls
 * 
 * Terrain Controls
 * Unified control tab for both heightmap and biome management
 */

/**
 * Show unified import dialog for terrain data (heights and/or biomes)
 */
async function showTerrainImportDialog() {
  const content = `
    <form>
      <div class="form-group">
        <label>Файл карты (JSON)</label>
        <div class="form-fields" style="display: flex; gap: 5px;">
          <button type="button" class="file-picker" data-type="json" title="Выбрать файл" style="flex-shrink: 0;">
            <i class="fas fa-file-import fa-fw"></i>
          </button>
          <input class="terrain-map-path" type="text" name="filePath" placeholder="Путь к JSON файлу из Azgaar's FMG" value="" style="flex-grow: 1;">
        </div>
        <p class="notes" style="margin-top: 5px; font-size: 12px;">
          Выберите JSON файл из Azgaar's Fantasy Map Generator (PackCells или GridCells).
        </p>
      </div>
      
      <div class="form-group">
        <label>Что импортировать:</label>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
          <label style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" name="importHeights" checked style="margin: 0;">
            <span><i class="fas fa-mountain" style="margin-right: 4px;"></i> Карта высот</span>
          </label>
          <label style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" name="importBiomes" checked style="margin: 0;">
            <span><i class="fas fa-leaf" style="margin-right: 4px;"></i> Карта биомов</span>
          </label>
        </div>
      </div>
      
      <div class="form-group">
        <label>
          <input type="checkbox" name="createFlat" style="margin-right: 8px;">
          Создать ровную карту высот (без файла, высота = 20)
        </label>
        <p class="notes" style="margin-top: 5px; font-size: 12px;">
          Игнорирует файл и создаёт плоскую карту высот для сцены.
        </p>
      </div>
    </form>
  `;
  
  return new Promise((resolve) => {
    const dialog = new Dialog({
      title: 'Импорт данных местности',
      content: content,
      buttons: {
        import: {
          icon: '<i class="fas fa-check"></i>',
          label: 'Импортировать',
          callback: async (html) => {
            const filePath = html.find('input[name="filePath"]').val()?.trim() || '';
            const importHeights = html.find('input[name="importHeights"]').is(':checked');
            const importBiomes = html.find('input[name="importBiomes"]').is(':checked');
            const createFlat = html.find('input[name="createFlat"]').is(':checked');
            
            console.log('TerrainControls | Import options:', { filePath, importHeights, importBiomes, createFlat });
            
            // Validate
            if (!createFlat && !filePath) {
              ui.notifications.warn('Пожалуйста, выберите файл или включите создание ровной карты');
              resolve(false);
              return;
            }
            
            if (!importHeights && !importBiomes && !createFlat) {
              ui.notifications.warn('Выберите хотя бы один тип данных для импорта');
              resolve(false);
              return;
            }
            
            // Execute import
            let success = false;
            
            if (createFlat) {
              // Create flat height map
              if (game.spaceholder.heightMapManager) {
                success = await game.spaceholder.heightMapManager.createFlatMap(20);
                if (success) {
                  await game.spaceholder.heightMapRenderer?.show();
                }
              }
            } else {
              // Import from file
              if (importHeights && game.spaceholder.heightMapManager) {
                const heightSuccess = await game.spaceholder.heightMapManager.processFromFile(filePath);
                if (heightSuccess) {
                  // Clear old cache to force regeneration
                  const scene = canvas.scene;
                  if (scene) {
                    await scene.unsetFlag('spaceholder', 'heightFieldPath');
                  }
                  game.spaceholder.heightMapRenderer?.clear();
                  await game.spaceholder.heightMapRenderer?.show();
                  success = true;
                }
              }
              
              if (importBiomes && game.spaceholder.biomeManager) {
                const biomeSuccess = await game.spaceholder.biomeManager.processFromFile(filePath);
                if (biomeSuccess) {
                  game.spaceholder.biomeRenderer?.clear();
                  await game.spaceholder.biomeRenderer?.show();
                  success = true;
                }
              }
            }
            
            resolve(success);
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: 'Отмена',
          callback: () => resolve(false)
        }
      },
      default: 'import',
      render: (html) => {
        // Setup file picker
        const filePicker = html.find('button.file-picker');
        const inputField = html.find('input[name="filePath"]');
        const createFlatCheckbox = html.find('input[name="createFlat"]');
        const importCheckboxes = html.find('input[name="importHeights"], input[name="importBiomes"]');
        
        filePicker.on('click', function(e) {
          e.preventDefault();
          const current = inputField.val();
          const fp = new FilePicker({
            type: 'json',
            current: current,
            callback: (path) => {
              inputField.val(path);
            }
          });
          fp.browse();
        });
        
        // When "create flat" is checked, disable file picker and import biomes
        createFlatCheckbox.on('change', function() {
          if (this.checked) {
            inputField.prop('disabled', true);
            filePicker.prop('disabled', true);
            html.find('input[name="importBiomes"]').prop('disabled', true).prop('checked', false);
            html.find('input[name="importHeights"]').prop('checked', true);
          } else {
            inputField.prop('disabled', false);
            filePicker.prop('disabled', false);
            html.find('input[name="importBiomes"]').prop('disabled', false);
          }
        });
      },
      close: () => resolve(false)
    }, {
      width: 500
    });
    
    dialog.render(true);
  });
}

/**
 * Register terrain controls in scene controls
 */
export function registerTerrainControls(controls) {
  console.log('TerrainControls | Registering unified terrain controls');
  
  if (typeof controls !== 'object' || controls === null) {
    console.warn('TerrainControls | Controls is not an object');
    return;
  }
  
  // Create unified terrain control group
  controls.terrain = {
    name: 'terrain',
    title: 'Terrain (Heights & Biomes)',
    icon: 'fa-solid fa-map',
    layer: 'terrain',
    visible: true,
    order: 11,
    activeTool: 'inspect-terrain',
    tools: {
      'inspect-terrain': {
        name: 'inspect-terrain',
        title: 'Просмотр местности',
        icon: 'fa-solid fa-eye',
        onChange: (isActive) => {
          // Just show both maps if loaded
          if (isActive) {
            if (game.spaceholder.heightMapManager?.isLoaded()) {
              game.spaceholder.heightMapRenderer?.show();
            }
            if (game.spaceholder.biomeManager?.isLoaded()) {
              game.spaceholder.biomeRenderer?.show();
            }
          }
        },
        button: false
      },
      'import-terrain': {
        name: 'import-terrain',
        title: 'Импорт данных местности',
        icon: 'fa-solid fa-file-import',
        onChange: async (isActive) => {
          await showTerrainImportDialog();
        },
        button: true
      },
      'toggle-heights': {
        name: 'toggle-heights',
        title: 'Переключить карту высот',
        icon: 'fa-solid fa-mountain',
        onChange: (isActive) => {
          game.spaceholder.heightMapRenderer?.toggle();
        },
        button: true
      },
      'toggle-biomes': {
        name: 'toggle-biomes',
        title: 'Переключить карту биомов',
        icon: 'fa-solid fa-leaf',
        onChange: (isActive) => {
          game.spaceholder.biomeRenderer?.toggle();
        },
        button: true
      },
      'edit-heights': {
        name: 'edit-heights',
        title: 'Редактировать высоты',
        icon: 'fa-solid fa-pen-to-square',
        onChange: async (isActive) => {
          const editor = game.spaceholder.heightMapEditor;
          if (!editor) return;
          
          if (!editor.renderer.heightMapManager.isLoaded()) {
            ui.notifications.warn('Сначала загрузите карту высот');
            return;
          }
          
          if (!editor.renderer.cachedHeightField) {
            ui.notifications.warn('Сначала отобразите карту высот');
            return;
          }
          
          // Toggle edit mode
          if (editor.isActive) {
            await editor.deactivate();
          } else {
            editor.activate();
          }
        },
        button: true
      },
      'clear-terrain': {
        name: 'clear-terrain',
        title: 'Очистить данные местности',
        icon: 'fa-solid fa-trash',
        onChange: async (isActive) => {
          const hasHeights = game.spaceholder.heightMapManager?.isLoaded();
          const hasBiomes = game.spaceholder.biomeManager?.isLoaded();
          
          if (!hasHeights && !hasBiomes) {
            ui.notifications.warn('Нет данных для очистки');
            return;
          }
          
          const confirmed = await Dialog.confirm({
            title: 'Очистить данные местности?',
            content: '<p>Это удалит все данные о высотах и биомах для текущей сцены. Продолжить?</p>',
            yes: () => true,
            no: () => false
          });
          
          if (confirmed) {
            if (hasHeights) {
              await game.spaceholder.heightMapManager.clearProcessedHeightMap();
              game.spaceholder.heightMapRenderer?.clear();
              game.spaceholder.heightMapRenderer?.hide();
            }
            
            if (hasBiomes) {
              await game.spaceholder.biomeManager.clearProcessedBiomeMap();
              game.spaceholder.biomeRenderer?.clear();
              game.spaceholder.biomeRenderer?.hide();
            }
            
            // Clear terrain field
            const scene = canvas.scene;
            if (scene) {
              await scene.unsetFlag('spaceholder', 'terrainFieldPath');
            }
            game.spaceholder.terrainFieldManager?.clearCache();
            
            ui.notifications.info('Данные местности очищены');
          }
        },
        button: true
      }
    }
  };
  
  console.log('TerrainControls | Unified terrain control group registered');
}

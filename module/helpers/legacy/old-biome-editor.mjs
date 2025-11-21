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
 * @deprecated Используйте новые модули terrain вместо legacy biome
 * 
 * Biome Editor UI
 * Provides interactive tools for managing biome maps
 */

/**
 * Show dialog for creating biome map overlay
 */
async function showCreateBiomeOverlayDialog(editor) {
  const content = `
    <form>
      <div class="form-group">
        <label>Файл карты биомов (JSON)</label>
        <div class="form-fields" style="display: flex; gap: 5px;">
          <button type="button" class="file-picker" data-type="json" title="Выбрать файл" style="flex-shrink: 0;">
            <i class="fas fa-file-import fa-fw"></i>
          </button>
          <input class="biome-map-path" type="text" name="filePath" placeholder="Путь к JSON файлу из Azgaar's FMG" value="" style="flex-grow: 1;">
        </div>
        <p class="notes" style="margin-top: 5px; font-size: 12px;">
          Выберите JSON файл из Azgaar's Fantasy Map Generator с данными о биомах (PackCells или GridCells).
        </p>
      </div>
    </form>
  `;
  
  return new Promise((resolve) => {
    const dialog = new Dialog({
      title: 'Создать оверлей карты биомов',
      content: content,
      buttons: {
        create: {
          icon: '<i class="fas fa-check"></i>',
          label: 'Создать',
          callback: async (html) => {
            // Get the file path from the input field
            const fileInput = html.find('input[name="filePath"]');
            const filePath = fileInput.val() ? fileInput.val().trim() : '';
            
            console.log('BiomeEditor | Dialog callback - filePath:', filePath);
            
            if (filePath && filePath.length > 0) {
              // Import from file
              console.log('BiomeEditor | Creating biome overlay from file:', filePath);
              const success = await editor.renderer.biomeManager.processFromFile(filePath);
              
              if (success) {
                // Clear renderer and show the biome map
                editor.renderer.clear();
                await editor.renderer.show();
              }
            } else {
              ui.notifications.warn('Пожалуйста, выберите файл с данными биомов');
            }
            
            resolve(true);
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: 'Отмена',
          callback: () => resolve(false)
        }
      },
      default: 'create',
      render: (html) => {
        // Setup file picker
        const filePicker = html.find('button.file-picker');
        const inputField = html.find('input[name="filePath"]');
        
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
      },
      close: () => resolve(false)
    }, {
      width: 500
    });
    
    dialog.render(true);
  });
}

export class BiomeEditor {
  constructor(biomeRenderer) {
    this.renderer = biomeRenderer;
    this.isActive = false;
  }

  /**
   * Initialize the editor
   */
  initialize() {
    console.log('BiomeEditor | Initializing...');
    
    // Add control button
    Hooks.on('getSceneControlButtons', (controls) => {
      this.addControlButton(controls);
    });
  }

  /**
   * Add biome editor button to scene controls
   */
  addControlButton(controls) {
    console.log('BiomeEditor | addControlButton called');
    
    // In Foundry v13+, controls is an object, not an array
    if (typeof controls !== 'object' || controls === null) {
      console.warn('BiomeEditor | Controls is not an object');
      return;
    }
    
    // Create a new control group for biome editor
    controls.biomemap = {
      name: 'biomemap',
      title: 'Biome Map',
      icon: 'fa-solid fa-leaf',
      layer: 'biomemap',
      visible: true,
      order: 12, // After heightmap (order: 11)
      activeTool: 'inspect-biome', // Default active tool
      tools: {
        'inspect-biome': {
          name: 'inspect-biome',
          title: 'Просмотр биома',
          icon: 'fa-solid fa-eye',
          onChange: (isActive) => {
            // Simple inspect mode - just show the biome map
            if (isActive && this.renderer.biomeManager.isLoaded()) {
              this.renderer.show();
            }
          },
          button: false // This is the default tool, not a button
        },
        'create-biome-overlay': {
          name: 'create-biome-overlay',
          title: 'Загрузить карту биомов',
          icon: 'fa-solid fa-file-import',
          onChange: async (isActive) => {
            await showCreateBiomeOverlayDialog(this);
          },
          button: true
        },
        'toggle-biome-view': {
          name: 'toggle-biome-view',
          title: 'Переключить видимость',
          icon: 'fa-solid fa-eye-slash',
          onChange: (isActive) => this.renderer.toggle(),
          button: true
        },
        'clear-biome-map': {
          name: 'clear-biome-map',
          title: 'Очистить данные биомов',
          icon: 'fa-solid fa-trash',
          onChange: async (isActive) => {
            if (!this.renderer.biomeManager.isLoaded()) {
              ui.notifications.warn('Нет загруженной карты биомов для очистки');
              return;
            }
            
            const confirmed = await Dialog.confirm({
              title: 'Очистить карту биомов?',
              content: '<p>Это удалит все данные о биомах для текущей сцены. Продолжить?</p>',
              yes: () => true,
              no: () => false
            });
            
            if (confirmed) {
              await this.renderer.biomeManager.clearProcessedBiomeMap();
              this.renderer.clear();
              this.renderer.hide();
              ui.notifications.info('Карта биомов очищена');
            }
          },
          button: true
        }
      }
    };
    
    console.log('BiomeEditor | Added biome control group');
  }
}

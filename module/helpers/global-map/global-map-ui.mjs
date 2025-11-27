/**
 * Global Map UI
 * Registers scene controls and dialogs for global map system
 */

/**
 * Show dialog for importing map or creating flat map
 */
async function showGlobalMapImportDialog(processing, renderer) {
  const content = `
    <form>
      <div class="form-group">
        <label>Карта высот (JSON из Azgaar's FMG)</label>
        <div class="form-fields" style="display: flex; gap: 5px;">
          <button type="button" class="file-picker" data-type="json" title="Выбрать файл" style="flex-shrink: 0;">
            <i class="fas fa-file-import fa-fw"></i>
          </button>
          <input class="map-file-path" type="text" name="filePath" placeholder="Путь к JSON файлу" value="" style="flex-grow: 1;">
        </div>
        <p class="notes" style="margin-top: 5px; font-size: 12px;">
          Выберите JSON файл из Azgaar's Fantasy Map Generator или оставьте пустым для создания плоской карты (высота = 20).
        </p>
      </div>
    </form>
  `;

  return new Promise((resolve) => {
    const dialog = new Dialog(
      {
        title: 'Импорт глобальной карты',
        content: content,
        buttons: {
          import: {
            icon: '<i class="fas fa-check"></i>',
            label: 'Создать',
            callback: async (html) => {
              const filePath = html.find('input[name="filePath"]').val()?.trim() || '';

              try {
                ui.notifications.info('Обработка карты...');

                let result;
                if (filePath && filePath.length > 0) {
                  // Import from file
                  console.log('GlobalMapUI | Importing from:', filePath);
                  const response = await fetch(filePath);
                  if (!response.ok) {
                    throw new Error(`Failed to fetch: ${response.statusText}`);
                  }
                  const rawData = await response.json();
                  result = await processing.processPackCellsToGrid(rawData, canvas.scene);
                } else {
                  // Create flat map
                  console.log('GlobalMapUI | Creating flat map');
                  result = processing.createFlatGrid(20, canvas.scene);
                }

                // Render the grid
                await renderer.render(result.gridData, result.metadata, { mode: 'heights' });

                ui.notifications.info('Карта создана успешно');
                resolve(true);
              } catch (error) {
                console.error('GlobalMapUI | Error:', error);
                ui.notifications.error(`Ошибка: ${error.message}`);
                resolve(false);
              }
            },
          },
          cancel: {
            icon: '<i class="fas fa-times"></i>',
            label: 'Отмена',
            callback: () => resolve(false),
          },
        },
        default: 'import',
        render: (html) => {
          // Setup file picker
          const filePicker = html.find('button.file-picker');
          const inputField = html.find('input[name="filePath"]');

          filePicker.on('click', function (e) {
            e.preventDefault();
            const current = inputField.val();
            const fp = new FilePicker({
              type: 'json',
              current: current,
              callback: (path) => {
                inputField.val(path);
              },
            });
            fp.browse();
          });
        },
        close: () => resolve(false),
      },
      {
        width: 500,
      }
    );

    dialog.render(true);
  });
}

/**
 * Register Global Map UI controls
 * @param {Object} controls - Scene controls object
 * @param {Object} spaceholder - game.spaceholder context
 */

export function registerGlobalMapUI(controls, spaceholder) {
  console.log('GlobalMapUI | Registering controls...');

  if (typeof controls !== 'object' || controls === null) {
    console.warn('GlobalMapUI | Controls is not an object');
    return;
  }

  // Create Global Map control group
  controls.globalmap = {
    name: 'globalmap',
    title: 'Global Map',
    icon: 'fas fa-globe',
    layer: 'globalmap',
    visible: true,
    order: 13,
    activeTool: 'inspect-map',
    tools: {
      'inspect-map': {
        name: 'inspect-map',
        title: 'Просмотр карты',
        icon: 'fas fa-eye',
        onChange: (isActive) => {
          if (isActive && spaceholder.globalMapRenderer?.currentGrid) {
            spaceholder.globalMapRenderer.show();
          }
        },
        button: false,
      },

      'inspect-cell': {
        name: 'inspect-cell',
        title: 'Инспектировать клетку',
        icon: 'fas fa-search',
        onChange: (isActive) => {
          if (isActive) {
            spaceholder.globalMapTools?.activateCellInspector();
          } else {
            spaceholder.globalMapTools?.deactivateCellInspector();
          }
        },
        button: false,
      },

      'import-map': {
        name: 'import-map',
        title: 'Импортировать карту',
        icon: 'fas fa-download',
        onChange: async (isActive) => {
          await showGlobalMapImportDialog(
            spaceholder.globalMapProcessing,
            spaceholder.globalMapRenderer
          );
        },
        button: true,
      },

      'create-test-grid': {
        name: 'create-test-grid',
        title: 'Создать тестовую сетку биомов',
        icon: 'fas fa-th',
        onChange: async (isActive) => {
          try {
            ui.notifications.info('Создание тестовой карты биомов...');
            const result = spaceholder.globalMapProcessing.createBiomeTestGrid(canvas.scene);
            await spaceholder.globalMapRenderer.render(result.gridData, result.metadata, { mode: 'heights' });
            ui.notifications.info('Тестовая карта создана: сетка 5x6 биомов');
          } catch (error) {
            console.error('GlobalMapUI | Error creating test grid:', error);
            ui.notifications.error(`Ошибка: ${error.message}`);
          }
        },
        button: true,
      },

      'toggle-map': {
        name: 'toggle-map',
        title: 'Переключить видимость',
        icon: 'fas fa-eye-slash',
        onChange: (isActive) => {
          spaceholder.globalMapRenderer?.toggle();
        },
        button: true,
      },

'save-map': {
        name: 'save-map',
        title: 'Сохранить в файл',
        icon: 'fas fa-save',
        onChange: async (isActive) => {
          if (!spaceholder.globalMapRenderer?.currentGrid) {
            ui.notifications.warn('Нет карты для сохранения');
            return;
          }
          const ok = await spaceholder.globalMapProcessing.saveGridToFile(canvas.scene);
          if (!ok) {
            ui.notifications.error('Не удалось сохранить карту');
          }
        },
        button: true,
      },

      'load-map': {
        name: 'load-map',
        title: 'Загрузить из файла',
        icon: 'fas fa-upload',
        onChange: async (isActive) => {
          const loaded = await spaceholder.globalMapProcessing.loadGridFromFile(canvas.scene);
          if (loaded && loaded.gridData) {
            await spaceholder.globalMapRenderer.render(loaded.gridData, loaded.metadata, { mode: 'heights' });
            ui.notifications.info('Карта загружена из файла');
          } else {
            ui.notifications.warn('Файл карты не найден');
          }
        },
        button: true,
      },

      'edit-map': {
        name: 'edit-map',
        title: 'Редактировать карту',
        icon: 'fas fa-pencil',
        onChange: async (isActive) => {
          if (!spaceholder.globalMapRenderer?.currentGrid) {
            ui.notifications.warn('Сначала импортируйте карту');
            return;
          }

          if (spaceholder.globalMapTools.isActive) {
            await spaceholder.globalMapTools.deactivate();
          } else {
            spaceholder.globalMapTools.activate();
          }
        },
        button: true,
      },

      'clear-map': {
        name: 'clear-map',
        title: 'Очистить карту',
        icon: 'fas fa-trash',
        onChange: async (isActive) => {
          if (!spaceholder.globalMapRenderer?.currentGrid) {
            ui.notifications.warn('Нет загруженной карты');
            return;
          }

          const confirmed = await Dialog.confirm({
            title: 'Очистить карту?',
            content: '<p>Это удалит загруженную карту. Продолжить?</p>',
            yes: () => true,
            no: () => false,
          });

          if (confirmed) {
            spaceholder.globalMapProcessing.clear();
            spaceholder.globalMapRenderer.clear();
            ui.notifications.info('Карта очищена');
          }
        },
        button: true,
      },

      'toggle-biomes-mode': {
        name: 'toggle-biomes-mode',
        title: 'Режим биомов',
        icon: 'fas fa-seedling',
        onChange: async (isActive) => {
          if (!spaceholder.globalMapRenderer?.currentGrid) {
            ui.notifications.warn('Нет загруженной карты');
            return;
          }

          const modes = ['fancy', 'fancyDebug', 'cells', 'off'];
          const modeNames = {
            'fancy': 'Красивые',
            'fancyDebug': 'Красивые + отладка',
            'cells': 'Сетка',
            'off': 'Выключено'
          };
          
          const currentMode = spaceholder.globalMapRenderer.biomesMode;
          const currentIndex = modes.indexOf(currentMode);
          const newMode = modes[(currentIndex + 1) % modes.length];
          
          spaceholder.globalMapRenderer.setBiomesMode(newMode);
          ui.notifications.info(`Биомы: ${modeNames[newMode]}`);
        },
        button: true,
      },

      'toggle-heights-mode': {
        name: 'toggle-heights-mode',
        title: 'Режим высот',
        icon: 'fas fa-mountain',
        onChange: async (isActive) => {
          if (!spaceholder.globalMapRenderer?.currentGrid) {
            ui.notifications.warn('Нет загруженной карты');
            return;
          }

          const modes = ['contours-bw', 'contours', 'cells', 'off'];
          const modeNames = {
            'contours-bw': 'Чёрные контуры',
            'contours': 'Цветные контуры',
            'cells': 'Цветная сетка',
            'off': 'Выключено'
          };
          
          const currentMode = spaceholder.globalMapRenderer.heightsMode;
          const currentIndex = modes.indexOf(currentMode);
          const newMode = modes[(currentIndex + 1) % modes.length];
          
          spaceholder.globalMapRenderer.setHeightsMode(newMode);
          ui.notifications.info(`Высоты: ${modeNames[newMode]}`);
        },
        button: true,
      },

      'toggle-influence': {
        name: 'toggle-influence',
        title: 'Показать влияние',
        icon: 'fas fa-flag',
        onChange: async (isActive) => {
          if (!spaceholder.influenceManager) {
            ui.notifications.warn('Менеджер влияния недоступен');
            return;
          }

          // Проверяем, есть ли уже отрисованное влияние
          if (spaceholder.influenceManager.currentElements.length > 0) {
            // Если есть - очищаем
            spaceholder.influenceManager.clearAll();
            ui.notifications.info('Влияние скрыто');
          } else {
            // Если нет - отрисовываем
            spaceholder.influenceManager.drawInfluenceZones(false);
            ui.notifications.info('Влияние отображено');
          }
        },
        button: true,
      },
    },
  };

  console.log('GlobalMapUI | ✓ Controls registered');
}

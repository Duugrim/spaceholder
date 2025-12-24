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
 * Show dialog for baking current render into a background image
 * @returns {Promise<{scale:number, mimeType:'image/webp'|'image/png', quality:number} | null>}
 */
async function showGlobalMapBakeDialog() {
  const scene = canvas?.scene;
  const renderer = canvas?.app?.renderer;

  const sceneWidth = scene?.dimensions?.width;
  const sceneHeight = scene?.dimensions?.height;
  const maxSize = renderer?.texture?.maxSize || renderer?.gl?.getParameter(renderer.gl.MAX_TEXTURE_SIZE);

  let maxSafeScale = null;
  if (maxSize && sceneWidth && sceneHeight) {
    maxSafeScale = Math.max(0.01, Math.min(maxSize / sceneWidth, maxSize / sceneHeight));
  }

  const maxSafeScaleRounded = maxSafeScale ? (Math.floor(maxSafeScale * 100) / 100) : null;

  const defaultScale = (() => {
    if (!maxSafeScaleRounded) return 2;
    if (maxSafeScaleRounded >= 2) return 2;
    if (maxSafeScaleRounded >= 1.5) return 1.5;
    if (maxSafeScaleRounded > 1.05) return maxSafeScaleRounded;
    return 1;
  })();

  const baseScaleOptions = [1, 1.5, 2, 3];
  const scaleOptions = [...baseScaleOptions];
  if (maxSafeScaleRounded && maxSafeScaleRounded > 1 && !scaleOptions.some(v => Math.abs(v - maxSafeScaleRounded) < 0.01)) {
    scaleOptions.push(maxSafeScaleRounded);
  }
  scaleOptions.sort((a, b) => a - b);

  const scaleOptionsHtml = scaleOptions.map((v) => {
    const isMax = maxSafeScaleRounded && Math.abs(v - maxSafeScaleRounded) < 0.01;
    const label = isMax ? `Максимум (${v}×)` : `${v}×`;
    const selected = Math.abs(v - defaultScale) < 0.01 ? 'selected' : '';
    return `<option value="${v}" ${selected}>${label}</option>`;
  }).join('');

  const maxInfo = (maxSize && maxSafeScaleRounded)
    ? `<p class="notes">Максимум на этой видеокарте: <b>${maxSafeScaleRounded}×</b> (лимит текстуры: ${maxSize}px).</p>`
    : '';

  const content = `
    <form>
      <div class="form-group">
        <label>Разрешение (множитель)</label>
        <div class="form-fields">
          <select name="scale">
            ${scaleOptionsHtml}
          </select>
        </div>
        <p class="notes">
          При множителе &gt; 1 фон будет автоматически уменьшен (scale) так, чтобы совпасть с размерами сцены.
        </p>
        ${maxInfo}
      </div>

      <div class="form-group">
        <label>Формат</label>
        <div class="form-fields">
          <select name="mimeType">
            <option value="image/webp" selected>WebP (меньше размер)</option>
            <option value="image/png">PNG (без потерь, но больше размер)</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label>Качество WebP</label>
        <div class="form-fields">
          <input type="range" name="quality" min="0.70" max="1.00" step="0.01" value="0.92" style="flex: 1;">
          <span class="global-map-webp-quality" style="min-width: 3em; text-align: right;">0.92</span>
        </div>
        <p class="notes">
          PNG игнорирует этот параметр.
        </p>
      </div>
    </form>
  `;

  return new Promise((resolve) => {
    const dialog = new Dialog(
      {
        title: 'Запечь карту в фон сцены',
        content,
        buttons: {
          bake: {
            icon: '<i class="fas fa-check"></i>',
            label: 'Запечь',
            callback: (html) => {
              const scaleRaw = html.find('select[name="scale"]').val();
              const mimeTypeRaw = html.find('select[name="mimeType"]').val();
              const qualityRaw = html.find('input[name="quality"]').val();

              const scale = Math.max(0.1, Math.min(4, Number(scaleRaw) || 1));
              const mimeType = mimeTypeRaw === 'image/png' ? 'image/png' : 'image/webp';
              const quality = Math.max(0.7, Math.min(1, Number(qualityRaw) || 0.92));

              resolve({ scale, mimeType, quality });
            },
          },
          cancel: {
            icon: '<i class="fas fa-times"></i>',
            label: 'Отмена',
            callback: () => resolve(null),
          },
        },
        default: 'bake',
        render: (html) => {
          const qualityInput = html.find('input[name="quality"]');
          const qualityLabel = html.find('.global-map-webp-quality');
          const mimeTypeSelect = html.find('select[name="mimeType"]');

          const syncQualityLabel = () => {
            qualityLabel.text(qualityInput.val());
          };

          const syncQualityEnabled = () => {
            const isWebp = mimeTypeSelect.val() === 'image/webp';
            qualityInput.prop('disabled', !isWebp);
            qualityLabel.css('opacity', isWebp ? '1' : '0.5');
          };

          qualityInput.on('input', syncQualityLabel);
          mimeTypeSelect.on('change', syncQualityEnabled);

          syncQualityLabel();
          syncQualityEnabled();
        },
        close: () => resolve(null),
      },
      { width: 520 }
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

  // GM/Assistant GM only actions
  const canManageGlobalMap = (() => {
    try {
      if (game.user?.isGM) return true;

      const assistantRole = CONST?.USER_ROLES?.ASSISTANT;
      if (assistantRole !== undefined && typeof game.user?.hasRole === 'function') {
        return game.user.hasRole(assistantRole);
      }
    } catch (e) {
      // ignore
    }

    return false;
  })();

  const requireGMOrAssistant = (action = 'использовать этот инструмент') => {
    if (canManageGlobalMap) return true;
    ui.notifications?.warn?.(`Только ГМ или ассистент ГМа может ${action}`);
    return false;
  };

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
        visible: true,
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
        visible: true,
      },

      'import-map': {
        name: 'import-map',
        title: 'Импортировать карту',
        icon: 'fas fa-download',
        onChange: async (isActive) => {
          if (!requireGMOrAssistant('импортировать карту')) return;

          await showGlobalMapImportDialog(
            spaceholder.globalMapProcessing,
            spaceholder.globalMapRenderer
          );
        },
        button: true,
        visible: canManageGlobalMap,
      },

      'create-test-grid': {
        name: 'create-test-grid',
        title: 'Создать тестовую сетку биомов',
        icon: 'fas fa-th',
        onChange: async (isActive) => {
          if (!requireGMOrAssistant('создавать тестовую сетку')) return;

          try {
            ui.notifications.info('Создание тестовой карты биомов...');
            const result = spaceholder.globalMapProcessing.createBiomeTestGrid(canvas.scene);
            await spaceholder.globalMapRenderer.render(result.gridData, result.metadata, { mode: 'heights' });
            ui.notifications.info('Тестовая карта создана (биомы из реестра)');
          } catch (error) {
            console.error('GlobalMapUI | Error creating test grid:', error);
            ui.notifications.error(`Ошибка: ${error.message}`);
          }
        },
        button: true,
        visible: canManageGlobalMap,
      },

      'toggle-map': {
        name: 'toggle-map',
        title: 'Переключить видимость',
        icon: 'fas fa-eye-slash',
        onChange: (isActive) => {
          spaceholder.globalMapRenderer?.toggle();
        },
        button: true,
        visible: true,
      },

'save-map': {
        name: 'save-map',
        title: 'Сохранить в файл',
        icon: 'fas fa-save',
        onChange: async (isActive) => {
          if (!requireGMOrAssistant('сохранять карту')) return;

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
        visible: canManageGlobalMap,
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
        visible: true,
      },

      'bake-map-background': {
        name: 'bake-map-background',
        title: 'Запечь в фон сцены',
        icon: 'fas fa-file-image',
        onChange: async (isActive) => {
          if (!requireGMOrAssistant('менять фон сцены')) return;

          const scene = canvas.scene;
          if (!scene) {
            ui.notifications.warn('Нет активной сцены');
            return;
          }

          if (!spaceholder.globalMapRenderer?.currentGrid) {
            ui.notifications.warn('Нет загруженной карты');
            return;
          }

          const bakeOptions = await showGlobalMapBakeDialog();
          if (!bakeOptions) {
            return;
          }

          try {
            ui.notifications.info('Экспорт карты в изображение...');

            const requestedScale = bakeOptions.scale;
            const { blob, width, height, scale: actualScale, maxSize } = await spaceholder.globalMapRenderer.exportToBlob({
              mimeType: bakeOptions.mimeType,
              quality: bakeOptions.quality,
              scale: requestedScale,
              allowDownscale: true,
            });

            if (Math.abs(actualScale - requestedScale) > 0.01) {
              const maxInfo = maxSize ? ` (лимит текстуры: ${maxSize}px)` : '';
              ui.notifications.warn(`Масштаб ограничен до ${actualScale.toFixed(2)}×${maxInfo}`);
            }

            const sceneSlug = scene.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const ext = bakeOptions.mimeType === 'image/png' ? 'png' : 'webp';
            const fileName = `${sceneSlug}_${scene.id}_globalmap_${timestamp}_${actualScale.toFixed(2)}x.${ext}`;

            const directory = `worlds/${game.world.id}/global-maps/renders`;

            // Create directory if needed
            try {
              await foundry.applications.apps.FilePicker.implementation.createDirectory('data', directory, {});
            } catch (err) {
              // Directory might already exist
            }

            const file = new File([blob], fileName, { type: blob.type });
            const response = await foundry.applications.apps.FilePicker.implementation.upload(
              'data',
              directory,
              file,
              {}
            );

            if (!response?.path) {
              throw new Error('Upload failed');
            }

            // If the export is higher resolution, scale background down to keep scene size consistent.
            const backgroundScale = 1 / Math.max(0.1, Number(actualScale) || 1);

            // Store for reference
            await scene.setFlag('spaceholder', 'globalMapBackground', {
              src: response.path,
              width,
              height,
              mimeType: blob.type,
              exportScaleRequested: bakeOptions.scale,
              exportScaleUsed: actualScale,
              backgroundScale,
              updatedAt: new Date().toISOString(),
            });

            // Apply as scene background (Foundry v11+)
            try {
              await scene.update({
                'background.src': response.path,
                'background.scaleX': backgroundScale,
                'background.scaleY': backgroundScale,
              });
            } catch (e1) {
              // Some Foundry versions prefer nested object updates
              try {
                console.warn('GlobalMapUI | Failed to set background.* paths, trying background object update:', e1);
                await scene.update({
                  background: {
                    src: response.path,
                    scaleX: backgroundScale,
                    scaleY: backgroundScale,
                  },
                });
              } catch (e2) {
                console.warn('GlobalMapUI | Failed to set background via background object, falling back to img:', e2);
                await scene.update({ img: response.path });
              }
            }

            ui.notifications.info('Фон сцены обновлён');
          } catch (error) {
            console.error('GlobalMapUI | Bake failed:', error);
            ui.notifications.error(`Не удалось запечь фон: ${error.message}`);
          }
        },
        button: true,
        visible: canManageGlobalMap,
      },

      'edit-map': {
        name: 'edit-map',
        title: 'Редактировать карту',
        icon: 'fas fa-pencil',
        onChange: async (isActive) => {
          if (!requireGMOrAssistant('редактировать карту')) return;

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
        visible: canManageGlobalMap,
      },

      'clear-map': {
        name: 'clear-map',
        title: 'Очистить карту',
        icon: 'fas fa-trash',
        onChange: async (isActive) => {
          if (!requireGMOrAssistant('очищать карту')) return;

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
        visible: canManageGlobalMap,
      },

      'toggle-biomes-mode': {
        name: 'toggle-biomes-mode',
        title: 'Режим биомов',
        icon: 'fas fa-seedling',
        onChange: async (isActive) => {
          if (!requireGMOrAssistant('переключать режим биомов')) return;

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
        visible: canManageGlobalMap,
      },

      'toggle-heights-mode': {
        name: 'toggle-heights-mode',
        title: 'Режим высот',
        icon: 'fas fa-mountain',
        onChange: async (isActive) => {
          if (!requireGMOrAssistant('переключать режим высот')) return;

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
        visible: canManageGlobalMap,
      },
    },
  };

  console.log('GlobalMapUI | ✓ Controls registered');
}

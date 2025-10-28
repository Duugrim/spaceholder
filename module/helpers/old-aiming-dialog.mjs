/**
 * ⚠️ LEGACY CODE - ОТКЛЮЧЕН ⚠️
 * Этот файл является устаревшей версией диалога прицеливания.
 * Система переработана в новую модульную архитектуру.
 * Файл сохранён для справки, но не используется.
 * Дата архивации: 2025-10-28
 */

/**
 * Диалоговое окно для настройки параметров прицеливания
 * Использует DialogV2.wait() по образцу системы
 */

export class AimingDialog {

  /**
   * Получить конфигурацию по умолчанию
   */
  static getDefaultConfig() {
    return {
      maxRayDistance: 3000, // Увеличили до снайперской винтовки
      aimingSensitivity: 1.0,
      showAimingReticle: true,
      allowRicochet: false,
      maxRicochets: 3,
      curvedRaysEnabled: false,
      
      // Механические параметры
      previewRayLength: 500,
      fireSegmentLength: 100,
      maxFireSegments: 50,
      previewUpdateRate: 60,
      fireAnimationDelay: 50,
      ricochetAnimationDelay: 75,
    };
  }

  /**
   * Генерация содержимого диалога
   */
  static generateContent(token, config) {
    const tokenName = token?.document?.name || token?.name || 'Неизвестный токен';
    
    const distancePresets = [
      { value: 300, label: "Пистолет (3м / 300px)" },
      { value: 800, label: "Автомат (8м / 800px)" },
      { value: 1500, label: "Штурмовая винтовка (15м / 1500px)" },
      { value: 3000, label: "Снайперская винтовка (30м / 3000px)" },
      { value: 5000, label: "Дальнобойная (50м / 5000px)" },
      { value: 10000, label: "Экстремальная (100м / 10000px)" }
    ];
    
    // Настройки чувствительности убраны - прицел следует прямо за курсором
    
    return `
      <form class="aiming-dialog-form">
        <div class="form-group">
          <h3><i class="fas fa-bullseye"></i> Настройки прицеливания</h3>
          <p><strong>Токен:</strong> ${tokenName}</p>
        </div>

        <div class="form-group">
          <label for="maxRayDistance">
            <i class="fas fa-ruler"></i> Максимальная дальность:
          </label>
          <div class="form-fields">
            <input type="number" id="maxRayDistance" name="maxRayDistance" 
                   value="${config.maxRayDistance}">
            <select id="distancePreset">
              <option value="">Выберите предустановку...</option>
              ${distancePresets.map(preset => `
                <option value="${preset.value}" ${preset.value === config.maxRayDistance ? 'selected' : ''}>
                  ${preset.label}
                </option>
              `).join('')}
            </select>
          </div>
        </div>

        <div class="form-group">
          <label>
            <i class="fas fa-info-circle"></i> Прицеливание:
          </label>
          <p style="margin: 5px 0; color: #666; font-size: 13px;">
            Прицел следует за курсором мыши. Показывается короткий луч для предпросмотра.
          </p>
        </div>

        <div class="form-group">
          <label class="checkbox">
            <input type="checkbox" name="showAimingReticle" 
                   ${config.showAimingReticle ? 'checked' : ''}>
            <i class="fas fa-eye"></i> Показывать прицельную сетку
          </label>
        </div>

        <div class="form-group">
          <label class="checkbox">
            <input type="checkbox" name="allowRicochet" 
                   ${config.allowRicochet ? 'checked' : ''}>
            <i class="fas fa-exchange-alt"></i> Разрешить рикошеты
          </label>
        </div>

        <div class="form-group ${config.allowRicochet ? '' : 'disabled'}" id="ricochet-settings">
          <label for="maxRicochets">
            <i class="fas fa-sort-numeric-up"></i> Максимальное количество рикошетов:
          </label>
          <input type="number" id="maxRicochets" name="maxRicochets" 
                 value="${config.maxRicochets}"
                 ${config.allowRicochet ? '' : 'disabled'}>
        </div>

        <div class="form-group">
          <label class="checkbox">
            <input type="checkbox" name="curvedRaysEnabled" 
                   ${config.curvedRaysEnabled ? 'checked' : ''}>
            <i class="fas fa-bezier-curve"></i> Изогнутые лучи (экспериментально)
          </label>
        </div>

        <div class="form-group mechanics-section">
          <h4><i class="fas fa-cogs"></i> Механика лучей</h4>
          
          <div class="form-subgroup">
            <label for="previewRayLength">
              <i class="fas fa-eye"></i> Длина луча предпросмотра:
            </label>
            <div class="form-fields">
              <input type="number" id="previewRayLength" name="previewRayLength" 
                     value="${config.previewRayLength}">
              <span class="unit">px</span>
            </div>
          </div>
          
          <div class="form-subgroup">
            <label for="fireSegmentLength">
              <i class="fas fa-ruler-horizontal"></i> Длина сегмента выстрела:
            </label>
            <div class="form-fields">
              <input type="number" id="fireSegmentLength" name="fireSegmentLength" 
                     value="${config.fireSegmentLength}">
              <span class="unit">px</span>
            </div>
          </div>
          
          <div class="form-subgroup">
            <label for="maxFireSegments">
              <i class="fas fa-list-ol"></i> Максимум сегментов:
            </label>
            <div class="form-fields">
              <input type="number" id="maxFireSegments" name="maxFireSegments" 
                     value="${config.maxFireSegments}">
              <span class="unit">шт.</span>
            </div>
          </div>
        </div>

        <div class="form-group performance-section">
          <h4><i class="fas fa-tachometer-alt"></i> Производительность и анимация</h4>
          
          <div class="form-subgroup">
            <label for="previewUpdateRate">
              <i class="fas fa-sync"></i> Частота обновления предпросмотра:
            </label>
            <select id="previewUpdateRate" name="previewUpdateRate">
              <option value="30" ${config.previewUpdateRate === 30 ? 'selected' : ''}>30 FPS (экономия)</option>
              <option value="60" ${config.previewUpdateRate === 60 ? 'selected' : ''}>60 FPS (стандарт)</option>
              <option value="120" ${config.previewUpdateRate === 120 ? 'selected' : ''}>120 FPS (высокая точность)</option>
            </select>
          </div>
          
          <div class="form-subgroup">
            <label for="fireAnimationDelay">
              <i class="fas fa-stopwatch"></i> Скорость анимации выстрела:
            </label>
            <select id="fireAnimationDelay" name="fireAnimationDelay">
              <option value="10" ${config.fireAnimationDelay === 10 ? 'selected' : ''}>Очень быстро (10мс)</option>
              <option value="25" ${config.fireAnimationDelay === 25 ? 'selected' : ''}>Быстро (25мс)</option>
              <option value="50" ${config.fireAnimationDelay === 50 ? 'selected' : ''}>Нормально (50мс)</option>
              <option value="100" ${config.fireAnimationDelay === 100 ? 'selected' : ''}>Медленно (100мс)</option>
              <option value="200" ${config.fireAnimationDelay === 200 ? 'selected' : ''}>Очень медленно (200мс)</option>
            </select>
          </div>
          
          <div class="form-subgroup">
            <label for="ricochetAnimationDelay">
              <i class="fas fa-exchange-alt"></i> Скорость анимации рикошетов:
            </label>
            <select id="ricochetAnimationDelay" name="ricochetAnimationDelay">
              <option value="25" ${config.ricochetAnimationDelay === 25 ? 'selected' : ''}>Очень быстро (25мс)</option>
              <option value="50" ${config.ricochetAnimationDelay === 50 ? 'selected' : ''}>Быстро (50мс)</option>
              <option value="75" ${config.ricochetAnimationDelay === 75 ? 'selected' : ''}>Нормально (75мс)</option>
              <option value="100" ${config.ricochetAnimationDelay === 100 ? 'selected' : ''}>Медленно (100мс)</option>
              <option value="150" ${config.ricochetAnimationDelay === 150 ? 'selected' : ''}>Очень медленно (150мс)</option>
            </select>
          </div>
        </div>

        <div class="form-group instruction-panel">
          <h4><i class="fas fa-info-circle"></i> Инструкции:</h4>
          <ul>
            <li><strong>Движение мыши</strong> - поворот прицела</li>
            <li><strong>Левая кнопка мыши</strong> - выстрел</li>
            <li><strong>Правая кнопка мыши / Escape</strong> - отмена</li>
          </ul>
        </div>
      </form>
    `;
  }


  /**
   * Настройка обработчиков пресетов
   */
  static _setupPresetHandlers(dialog) {
    // Обработчик пресетов дистанции
    const distancePreset = dialog.element.querySelector('#distancePreset');
    if (distancePreset) {
      distancePreset.addEventListener('change', (event) => {
        if (event.target.value) {
          const distanceInput = dialog.element.querySelector('#maxRayDistance');
          if (distanceInput) {
            distanceInput.value = event.target.value;
          }
        }
      });
    }
    
    // Чувствительность убрана, прицел следует прямо за курсором
    
    // Обработчик чекбокса рикошетов
    const ricochetCheckbox = dialog.element.querySelector('input[name="allowRicochet"]');
    const ricochetSettings = dialog.element.querySelector('#ricochet-settings');
    const maxRicochetsInput = dialog.element.querySelector('#maxRicochets');
    
    if (ricochetCheckbox && ricochetSettings && maxRicochetsInput) {
      ricochetCheckbox.addEventListener('change', (event) => {
        const enabled = event.target.checked;
        ricochetSettings.classList.toggle('disabled', !enabled);
        maxRicochetsInput.disabled = !enabled;
      });
    }
  }
  
  /**
   * Применить настройки к системе прицеливания
   */
  static applyConfigToAimingSystem(aimingSystem, config) {
    // Обновляем конфигурацию системы
    // Основные параметры
    aimingSystem.config.maxRayDistance = parseInt(config.maxRayDistance) || 2000;
    aimingSystem.config.showAimingReticle = !!config.showAimingReticle;
    aimingSystem.config.allowRicochet = !!config.allowRicochet;
    aimingSystem.config.maxRicochets = parseInt(config.maxRicochets) || 3;
    aimingSystem.config.curvedRaysEnabled = !!config.curvedRaysEnabled;
    
    // Механические параметры лучей
    aimingSystem.config.previewRayLength = parseInt(config.previewRayLength) || 500;
    aimingSystem.config.fireSegmentLength = parseInt(config.fireSegmentLength) || 100;
    aimingSystem.config.maxFireSegments = parseInt(config.maxFireSegments) || 50;
    
    // Параметры производительности и анимации
    aimingSystem.config.previewUpdateRate = parseInt(config.previewUpdateRate) || 60;
    aimingSystem.config.fireAnimationDelay = parseInt(config.fireAnimationDelay) || 50;
    aimingSystem.config.ricochetAnimationDelay = parseInt(config.ricochetAnimationDelay) || 75;
    
    // Обновляем интервал обновления предпросмотра
    aimingSystem._previewUpdateInterval = 1000 / aimingSystem.config.previewUpdateRate;
    
    // Конфигурация применена
  }

  /**
   * Статический метод для показа диалога
   */
  static async show(token) {
    if (!token) {
      ui.notifications.warn('Токен не выбран!');
      return;
    }

    if (!token.isOwner) {
      ui.notifications.warn('Вы не можете управлять этим токеном!');
      return;
    }
    
    // Получаем текущую конфигурацию системы прицеливания
    const aimingSystem = game.spaceholder?.aimingSystem;
    const config = aimingSystem ? {...aimingSystem.config} : AimingDialog.getDefaultConfig();
    
    // Генерируем содержимое диалога
    const content = AimingDialog.generateContent(token, config);
    
    // Показываем диалог
    const result = await foundry.applications.api.DialogV2.wait({
      window: { 
        title: 'Настройка прицеливания', 
        icon: 'fa-solid fa-bullseye' 
      },
      position: { width: 420 },
      content,
      render: (event, dialog) => {
        // Добавляем обработчики пресетов после рендеринга
        AimingDialog._setupPresetHandlers(dialog);
      },
      buttons: [
        {
          action: 'startAiming',
          label: 'Начать прицеливание',
          icon: 'fa-solid fa-bullseye',
          default: true,
          callback: async (event) => {
            try {
              const root = event.currentTarget;
              const formData = new foundry.applications.ux.FormDataExtended(root.querySelector('form'));
              const data = foundry.utils.expandObject(formData.object);

              // Получаем систему прицеливания
              if (!aimingSystem) {
                ui.notifications.error('Система прицеливания не найдена!');
                return;
              }

              // Применяем настройки
              AimingDialog.applyConfigToAimingSystem(aimingSystem, data);

              // Запускаем прицеливание
              const tokenName = token?.document?.name || token?.name || 'Неизвестный токен';
              const success = aimingSystem.startAiming(token);
              
              if (success) {
                ui.notifications.info(`Прицеливание начато для ${tokenName}`);
              } else {
                ui.notifications.warn('Не удалось начать прицеливание');
              }
            } catch (error) {
              console.error('SpaceHolder | AimingDialog: Error starting aiming:', error);
              ui.notifications.error('Ошибка при запуске прицеливания: ' + error.message);
            }
          }
        },
        { 
          action: 'cancel', 
          label: 'Отмена', 
          icon: 'fa-solid fa-times' 
        }
      ]
    });
  }
}
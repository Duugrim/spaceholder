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
                   value="${config.maxRayDistance}" min="100" max="15000" step="50">
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
                 value="${config.maxRicochets}" min="1" max="10" step="1"
                 ${config.allowRicochet ? '' : 'disabled'}>
        </div>

        <div class="form-group">
          <label class="checkbox">
            <input type="checkbox" name="curvedRaysEnabled" 
                   ${config.curvedRaysEnabled ? 'checked' : ''}>
            <i class="fas fa-bezier-curve"></i> Изогнутые лучи (экспериментально)
          </label>
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
    aimingSystem.config.maxRayDistance = parseInt(config.maxRayDistance) || 2000;
    aimingSystem.config.showAimingReticle = !!config.showAimingReticle;
    aimingSystem.config.allowRicochet = !!config.allowRicochet;
    aimingSystem.config.maxRicochets = parseInt(config.maxRicochets) || 3;
    aimingSystem.config.curvedRaysEnabled = !!config.curvedRaysEnabled;
    
    // Обновляем новые параметры оптимизированной механики
    aimingSystem.config.previewRayLength = 500; // Короткие лучи предпросмотра
    aimingSystem.config.fireSegmentLength = 100; // Сегменты по 100 пикселей
    aimingSystem.config.maxFireSegments = Math.floor(aimingSystem.config.maxRayDistance / aimingSystem.config.fireSegmentLength);

    console.log('SpaceHolder | AimingDialog: Applied config to aiming system:', aimingSystem.config);
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
              const formData = new FormDataExtended(root.querySelector('form'));
              const data = foundry.utils.expandObject(formData.object);
              
              console.log('SpaceHolder | AimingDialog: Starting aiming with config:', data);

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
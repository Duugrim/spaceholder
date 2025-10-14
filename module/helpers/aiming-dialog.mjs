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
      maxRayDistance: 2000,
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
      { value: 500, label: "Близкая (500px)" },
      { value: 1000, label: "Средняя (1000px)" },
      { value: 2000, label: "Дальняя (2000px)" },
      { value: 4000, label: "Максимальная (4000px)" }
    ];
    
    const sensitivityPresets = [
      { value: 0.5, label: "Низкая" },
      { value: 1.0, label: "Обычная" },
      { value: 1.5, label: "Высокая" },
      { value: 2.0, label: "Максимальная" }
    ];
    
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
                   value="${config.maxRayDistance}" min="100" max="10000" step="50">
            <select id="distancePreset" onchange="document.getElementById('maxRayDistance').value = this.value">
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
          <label for="aimingSensitivity">
            <i class="fas fa-mouse"></i> Чувствительность прицеливания:
          </label>
          <div class="form-fields">
            <input type="number" id="aimingSensitivity" name="aimingSensitivity" 
                   value="${config.aimingSensitivity}" min="0.1" max="5.0" step="0.1">
            <select id="sensitivityPreset" onchange="document.getElementById('aimingSensitivity').value = this.value">
              <option value="">Выберите предустановку...</option>
              ${sensitivityPresets.map(preset => `
                <option value="${preset.value}" ${preset.value === config.aimingSensitivity ? 'selected' : ''}>
                  ${preset.label}
                </option>
              `).join('')}
            </select>
          </div>
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
   * Применить настройки к системе прицеливания
   */
  static applyConfigToAimingSystem(aimingSystem, config) {
    // Обновляем конфигурацию системы
    aimingSystem.config.maxRayDistance = parseInt(config.maxRayDistance) || 2000;
    aimingSystem.config.aimingSensitivity = parseFloat(config.aimingSensitivity) || 1.0;
    aimingSystem.config.showAimingReticle = !!config.showAimingReticle;
    aimingSystem.config.allowRicochet = !!config.allowRicochet;
    aimingSystem.config.maxRicochets = parseInt(config.maxRicochets) || 3;
    aimingSystem.config.curvedRaysEnabled = !!config.curvedRaysEnabled;

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
    await foundry.applications.api.DialogV2.wait({
      window: { 
        title: 'Настройка прицеливания', 
        icon: 'fa-solid fa-bullseye' 
      },
      position: { width: 420 },
      content,
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
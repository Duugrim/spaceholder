/**
 * Token Controls Helper
 * Добавляет пользовательские кнопки в панель Token Controls
 */

// OLD SYSTEM DISABLED 2025-10-28
// import { AimingDialog } from './old-aiming-dialog.mjs';

/**
 * Регистрирует пользовательские кнопки в Token Controls
 */
export function registerTokenControlButtons() {
  console.log('SpaceHolder | Registering custom Token Control buttons');
}

/**
 * Устанавливает хуки для Token Controls
 */
export function installTokenControlsHooks() {
  // Хук для добавления пользовательских кнопок в Token Controls
  Hooks.on('getSceneControlButtons', (controls) => {
    try {
      // Проверяем структуру controls
      
      if (controls && typeof controls === 'object') {
        // Проверяем, есть ли tokens ключ
        if (controls.tokens) {
          addTestButton(controls.tokens);
          return;
        }
        
        console.warn('SpaceHolder | tokens key not found in controls');
        return;
      }
      
      // Обработка случая, если controls - это массив (для совместимости)
      if (Array.isArray(controls)) {
        const tokenControls = controls.find(c => c.name === 'token' || c.name === 'tokens');
        if (tokenControls) {
          addTestButton(tokenControls);
        } else {
          console.warn('SpaceHolder | Token controls group not found in array');
        }
        return;
      }
      
      console.warn('SpaceHolder | Unsupported controls structure');
    } catch (error) {
      console.error('SpaceHolder | Error in getSceneControlButtons hook:', error);
    }
  });
}

/**
 * Вспомогательная функция для добавления тестовой кнопки
 */
function addTestButton(tokenControls) {
  if (!tokenControls) {
    console.error('SpaceHolder | tokenControls is null or undefined');
    return;
  }
  
  
  // Проверяем, есть ли объект tools
  if (!tokenControls.tools || typeof tokenControls.tools !== 'object') {
    console.error('SpaceHolder | tokenControls.tools is not an object:', tokenControls.tools);
    return;
  }
  
  // Проверяем, не добавлена ли кнопка уже
  if (tokenControls.tools['aiming-tool']) {
    console.log('SpaceHolder | Aiming Tool already exists, skipping');
    return;
  }
  
  // Добавляем кнопку прицеливания
  tokenControls.tools['aiming-tool'] = {
    name: 'aiming-tool',
    title: 'Настройка прицеливания',
    icon: 'fas fa-bullseye',
    onChange: (isActive) => handleAimingToolChange(isActive),
    button: true,
    order: 10 // Порядок отображения
  };
  
  console.log('SpaceHolder | Added Test Button to Token Controls');
}

/**
 * Обработчик изменения состояния кнопки прицеливания
 */
function handleAimingToolChange(isActive) {
  console.log('SpaceHolder | Aiming Tool changed! Active:', isActive);
  
  if (isActive) {
    // Кнопка активирована - показываем диалог
    showAimingDialog();
  }
  // При деактивации ничего не делаем
}

/**
 * Показать диалог настройки прицеливания
 */
function showAimingDialog() {
  // OLD SYSTEM DISABLED - Новая система в разработке
  ui.notifications.warn('Система прицеливания временно отключена. Идёт переработка.');
  deactivateAimingTool();
  
  /* OLD CODE:
  const controlled = canvas.tokens.controlled;
  
  if (controlled.length === 0) {
    ui.notifications.warn('Выберите токен для настройки прицеливания');
    deactivateAimingTool();
    return;
  }
  
  if (controlled.length > 1) {
    ui.notifications.warn('Выберите только один токен для прицеливания');
    deactivateAimingTool();
    return;
  }
  
  const token = controlled[0];
  AimingDialog.show(token).then(() => {
    deactivateAimingTool();
  });
  */
}

/**
 * Деактивировать кнопку прицеливания
 */
function deactivateAimingTool() {
  // Получаем ссылку на систему управления сценой
  const sceneControls = ui.controls;
  if (sceneControls && typeof sceneControls.activate === 'function') {
    // Переключаемся на стандартную группу с инструментом выбора
    sceneControls.activate({ control: 'tokens', tool: 'select' });
  }
}

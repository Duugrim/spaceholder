/**
 * Token Controls Helper
 * Добавляет пользовательские кнопки в панель Token Controls
 */

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
  if (tokenControls.tools['test-button']) {
    console.log('SpaceHolder | Test Button already exists, skipping');
    return;
  }
  
  // Добавляем нашу тестовую кнопку как свойство объекта
  tokenControls.tools['test-button'] = {
    name: 'test-button',
    title: 'Test Button',
    icon: 'fas fa-bug',
    onChange: (isActive) => handleTestButtonChange(isActive),
    button: true,
    order: 10 // Порядок отображения
  };
  
  console.log('SpaceHolder | Added Test Button to Token Controls');
}

/**
 * Обработчик изменения состояния тестовой кнопки
 */
function handleTestButtonChange(isActive) {
  console.log('SpaceHolder | Test Button changed! Active:', isActive, 'Функционал работает корректно.');
  
  if (isActive) {
    // Кнопка активирована
    ui.notifications.info('Test Button активирована! Проверьте консоль для сообщения.');
  } else {
    // Кнопка деактивирована
    ui.notifications.info('Test Button деактивирована.');
  }
}

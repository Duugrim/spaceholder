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
      const tokenControls = resolveTokenControlsGroup(controls);
      if (!tokenControls) {
        console.warn('SpaceHolder | Token controls group not found');
        return;
      }

      addCustomButtons(tokenControls);
    } catch (error) {
      console.error('SpaceHolder | Error in getSceneControlButtons hook:', error);
    }
  });
}

/**
 * Найти группу Token Controls в различных форматах Foundry.
 */
function resolveTokenControlsGroup(controls) {
  // В v11/v12 часто массив, в других окружениях может быть объект
  if (Array.isArray(controls)) {
    return controls.find((c) => c?.name === 'token' || c?.name === 'tokens') || null;
  }

  if (controls && typeof controls === 'object') {
    return controls.tokens || controls.token || null;
  }

  return null;
}

/**
 * Добавить пользовательские кнопки в Token Controls.
 */
function addCustomButtons(tokenControls) {
  if (!tokenControls) {
    console.error('SpaceHolder | tokenControls is null or undefined');
    return;
  }

  const addedAiming = upsertTool(tokenControls, {
    name: 'aiming-tool',
    title: 'Настройка прицеливания',
    icon: 'fas fa-bullseye',
    onChange: (isActive) => handleAimingToolChange(isActive),
    button: true,
    order: 10,
  });

  const addedInfluence = upsertTool(tokenControls, {
    name: 'toggle-influence',
    title: 'Показать влияние',
    icon: 'fas fa-flag',
    onChange: (isActive) => {
      // На кнопках Foundry/окружения могут вызывать onChange и при «снятии» — не переключаемся обратно.
      if (isActive === false) return;
      handleInfluenceToggle();
    },
    button: true,
    order: 20,
  });

  if (addedAiming || addedInfluence) {
    console.log('SpaceHolder | Added custom Token Control buttons');
  }
}

/**
 * Добавить инструмент в tokenControls.tools (object или array) без дублей.
 */
function upsertTool(tokenControls, tool) {
  if (!tokenControls.tools) {
    // Предпочитаем объект-формат (как в нашем global-map-ui)
    tokenControls.tools = {};
  }

  const tools = tokenControls.tools;

  if (Array.isArray(tools)) {
    const exists = tools.some((t) => t?.name === tool.name);
    if (exists) return false;
    tools.push(tool);
    return true;
  }

  if (typeof tools === 'object') {
    if (tools[tool.name]) return false;
    tools[tool.name] = tool;
    return true;
  }

  console.error('SpaceHolder | tokenControls.tools has unsupported type:', tools);
  return false;
}

/**
 * Переключить отображение влияния.
 */
function handleInfluenceToggle() {
  const manager = game.spaceholder?.influenceManager;
  if (!manager) {
    ui.notifications.warn('Менеджер влияния недоступен');
    return;
  }

  const enabled = manager.toggle({ debug: false });
  ui.notifications.info(enabled ? 'Влияние отображено' : 'Влияние скрыто');
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

  // Ленивая загрузка менеджера прицеливания
  import('./aiming-manager.mjs')
    .then(({ AimingManager }) => {
      const manager = new AimingManager();
      manager.showAimingDialog(token).finally(() => {
        // Не держим ссылку, менеджер сам повесит события при старте
        deactivateAimingTool();
      });
    })
    .catch((err) => {
      console.error('SpaceHolder | Failed to load AimingManager:', err);
      ui.notifications.error('Не удалось загрузить модуль прицеливания');
      deactivateAimingTool();
    });
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

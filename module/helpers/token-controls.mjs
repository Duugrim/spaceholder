/**
 * Token Controls Helper
 * Добавляет пользовательские кнопки в панель Token Controls
 */

import { PayloadDialog } from './payload-dialog.mjs';
import { AimingSystem } from './aiming-system.mjs';
import { ShotSystem } from './shot-system.mjs';
import { ShotChatManager } from './shot-chat-manager.mjs';

// Глобальные переменные для системы
let aimingSystem = null;
let shotSystem = null;
let shotRayRenderer = null; // Независимый RayRenderer для ShotSystem
let shotChatManager = null; // Менеджер интеграции с чатом

// Глобальная функция для тестирования через консоль
window.testShotReplay = function() {
  console.log('=== Testing Shot Replay ===');
  
  if (!shotChatManager) {
    console.error('shotChatManager not available');
    return;
  }
  
  // Получаем последнее сообщение в чате
  const messages = game.messages.contents;
  const lastMessage = messages[messages.length - 1];
  
  if (!lastMessage) {
    console.error('No messages found');
    return;
  }
  
  console.log('Testing with message:', lastMessage.id);
  console.log('Message flags:', lastMessage.flags);
  
  // Проверяем, является ли это нашим сообщением
  if (shotChatManager.isShotMessage(lastMessage)) {
    console.log('Message is a shot message, attempting replay...');
    shotChatManager.replayShotFromChat(lastMessage.id);
  } else {
    console.log('Message is not a shot message');
    
    // Попробуем найти последнее сообщение с выстрелом
    for (let i = messages.length - 1; i >= 0; i--) {
      if (shotChatManager.isShotMessage(messages[i])) {
        console.log('Found shot message:', messages[i].id);
        shotChatManager.replayShotFromChat(messages[i].id);
        return;
      }
    }
    console.log('No shot messages found in chat');
  }
};

/**
 * Регистрирует пользовательские кнопки в Token Controls
 */
export function registerTokenControlButtons() {
  console.log('SpaceHolder | Registering custom Token Control buttons');
}

/**
 * Инициализация ShotChatManager
 */
async function initializeShotChatManager() {
  if (shotChatManager) return; // Уже инициализирован
  
  try {
    console.log('SpaceHolder | Initializing global ShotChatManager');
    shotChatManager = new ShotChatManager();
    
    // Создаем независимые компоненты
    const { RayRenderer } = await import('./ray-renderer.mjs');
    const { ShotHistoryManager } = await import('./shot-history-manager.mjs');
    
    const independentRayRenderer = RayRenderer.createIndependent();
    const shotHistoryManager = new ShotHistoryManager(independentRayRenderer);
    
    shotChatManager.initialize(shotHistoryManager);
    console.log('SpaceHolder | Global ShotChatManager initialized');
    
    // Делаем доступным глобально для отладки
    window.shotChatManager = shotChatManager;
  } catch (error) {
    console.error('SpaceHolder | Error initializing ShotChatManager:', error);
  }
}

export function installTokenControlsHooks() {
  // Инициализируем ShotChatManager при готовности холста
  Hooks.once('canvasReady', () => {
    initializeShotChatManager();
  });
  
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
  
  // Добавляем кнопку настройки payload
  tokenControls.tools['aiming-tool'] = {
    name: 'aiming-tool',
    title: 'Настройка траектории выстрела',
    icon: 'fas fa-crosshairs',
    onChange: (isActive) => handleAimingToolChange(isActive),
    button: true,
    order: 10 // Порядок отображения
  };
  
  // Добавляем новую тестовую кнопку
  tokenControls.tools['test-button'] = {
    name: 'test-button',
    title: 'Тестовая кнопка',
    icon: 'fas fa-flask',
    onChange: (isActive) => handleTestButtonChange(isActive),
    button: true,
    order: 11 // Порядок отображения после кнопки прицеливания
  };
  
  console.log('SpaceHolder | Added Test Button to Token Controls');
}

/**
 * Обработчик изменения состояния кнопки настройки payload
 */
function handleAimingToolChange(isActive) {
  console.log('SpaceHolder | Payload Tool changed! Active:', isActive);
  
  if (isActive) {
    // Кнопка активирована - показываем диалог payload
    showPayloadDialog();
  }
  // При деактивации ничего не делаем
}

/**
 * Показать диалог настройки payload
 */
function showPayloadDialog() {
  // Проверяем, есть ли выбранные токены
  const controlled = canvas.tokens.controlled;
  
  if (controlled.length === 0) {
    ui.notifications.warn('Выберите токен для настройки траектории');
    deactivateAimingTool();
    return;
  }
  
  if (controlled.length > 1) {
    ui.notifications.warn('Выберите только один токен для настройки траектории');
    deactivateAimingTool();
    return;
  }
  
  const token = controlled[0];
  
  // Показываем диалог настройки payload
  PayloadDialog.show(token).then((result) => {
    console.log('SpaceHolder | PayloadDialog result:', result);
    deactivateAimingTool();
    
    if (result && result.action === 'fire') {
      // Пользователь нажал "Начать прицеливание" - запускаем прицеливание
      console.log('SpaceHolder | Starting aiming with payload:', result.payload);
      startAimingWithPayload(token, result.payload).catch((error) => {
        console.error('SpaceHolder | Error in startAimingWithPayload:', error);
      });
    } else if (result && result.cancelled) {
      console.log('SpaceHolder | PayloadDialog was cancelled');
    } else {
      console.log('SpaceHolder | Unexpected PayloadDialog result:', result);
    }
  }).catch((error) => {
    console.error('SpaceHolder | Error showing payload dialog:', error);
    deactivateAimingTool();
  });
}

/**
 * Запустить прицеливание с настроенным payload
 * @param {Token} token - Токен для стрельбы
 * @param {Object} payload - Настроенный payload
 */
async function startAimingWithPayload(token, payload) {
  console.log('SpaceHolder | Starting aiming with payload:', payload);
  console.log('SpaceHolder | Token:', token);
  
  // Инициализируем системы, если нужно
  try {
    if (!aimingSystem) {
      console.log('SpaceHolder | Creating new AimingSystem');
      aimingSystem = new AimingSystem(onAimComplete);
      aimingSystem.initialize();
      console.log('SpaceHolder | AimingSystem created and initialized');
    }
    
    if (!shotSystem) {
      console.log('SpaceHolder | Creating new ShotSystem');
      // ShotSystem нужен RayCaster - берём его из AimingSystem
      shotSystem = new ShotSystem(aimingSystem.rayCaster);
      console.log('SpaceHolder | ShotSystem created with RayCaster');
    }
    
    // Инициализируем независимый RayRenderer для ShotSystem
    if (!shotRayRenderer) {
      console.log('SpaceHolder | Creating independent RayRenderer for ShotSystem');
      const { RayRenderer } = await import('./ray-renderer.mjs');
      shotRayRenderer = RayRenderer.createIndependent();
      console.log('SpaceHolder | Independent RayRenderer created');
    }
    
    // ShotChatManager уже должен быть инициализирован глобально
    if (!shotChatManager) {
      console.warn('SpaceHolder | ShotChatManager not initialized globally, trying to initialize...');
      await initializeShotChatManager();
    }
    
    // Сохраняем payload для использования при выстреле
    aimingSystem.currentPayload = payload;
    console.log('SpaceHolder | Payload saved to aimingSystem');
    
    // Запускаем прицеливание
    console.log('SpaceHolder | Starting aiming...');
    const aimingResult = aimingSystem.startAiming(token);
    console.log('SpaceHolder | Aiming start result:', aimingResult);
    
    ui.notifications.info(`Запущено прицеливание с payload "${payload.name}"`);
  } catch (error) {
    console.error('SpaceHolder | Error starting aiming:', error);
    ui.notifications.error('Ошибка запуска прицеливания: ' + error.message);
  }
}

/**
 * Коллбэк для обработки завершения прицеливания
 * @param {Object} aimResult - Результат прицеливания
 */
function onAimComplete(aimResult) {
  console.log('SpaceHolder | Aim completed:', aimResult);
  
  if (!aimResult || !shotSystem) {
    console.warn('SpaceHolder | No aim result or shot system not available');
    return;
  }
  
  // Получаем payload из aiming system
  const payload = aimingSystem.currentPayload;
  if (!payload) {
    console.warn('SpaceHolder | No payload configured');
    ui.notifications.warn('Нет настроенного payload');
    return;
  }
  
  // Выполняем выстрел
  performShot(aimResult, payload);
}

/**
 * Выполнить выстрел
 * @param {Object} aimResult - Результат прицеливания
 * @param {Object} payload - Payload для выстрела
 */
async function performShot(aimResult, payload) {
  console.log('SpaceHolder | Performing shot with:', { aimResult, payload });
  
  try {
    // Выполняем выстрел через ShotSystem
    console.log('SpaceHolder | Calling shotSystem.fire...');
    const shotResult = await shotSystem.fire(
      aimResult.source,
      aimResult.direction, 
      payload,
      aimResult.token
    );
    
    console.log('SpaceHolder | Shot completed:', shotResult);
    console.log('SpaceHolder | Shot segments:', shotResult.segments?.length || 0);
    console.log('SpaceHolder | Shot hits:', shotResult.hits?.length || 0);
    
    // Проверяем, есть ли попадания
    if (shotResult.hits && shotResult.hits.length > 0) {
      console.log('SpaceHolder | Processing hits:', shotResult.hits);
      // TODO: обработка попаданий
      ui.notifications.info(`Попадание! ${shotResult.hits.length} целей`);
    } else {
      console.log('SpaceHolder | No hits - miss!');
      ui.notifications.info('Промах!');
    }
    
    // Пробуем отрисовать результат
    if (shotResult.segments && shotResult.segments.length > 0) {
      console.log('SpaceHolder | Attempting to render shot...');
      await renderShotResult(shotResult);
    }
    
    // Сохраняем выстрел в чат
    if (shotChatManager && shotResult.completed) {
      try {
        await shotChatManager.saveShotToChat(shotResult, {
          speakerToken: aimResult.token
        });
        console.log('SpaceHolder | Shot saved to chat successfully');
      } catch (error) {
        console.error('SpaceHolder | Error saving shot to chat:', error);
        // Не прерываем выполнение из-за ошибки чата
      }
    }
    
    ui.notifications.info(`Выстрел завершён! ${shotResult.segments?.length || 0} сегментов`);
  } catch (error) {
    console.error('SpaceHolder | Error performing shot:', error);
    ui.notifications.error(`Ошибка при выстреле: ${error.message}`);
  }
}

/**
 * Отрисовать результат выстрела
 * @param {Object} shotResult - результат выстрела из ShotSystem
 */
async function renderShotResult(shotResult) {
  try {
    console.log('SpaceHolder | Rendering shot result:', shotResult);
    
    // Приоритет - сначала пробуем независимый shotRayRenderer
    if (shotRayRenderer) {
      console.log('SpaceHolder | Using independent shotRayRenderer');
      
      // Очищаем предыдущие линии
      shotRayRenderer.clearRay();
      
      // Отрисовываем каждый сегмент
      shotResult.segments.forEach((segment, index) => {
        console.log(`SpaceHolder | Drawing segment ${index}:`, segment);
        
        // Используем ray из сегмента, который создал ShotSystem
        const segmentToRender = {
          ...segment.ray, // Основные данные луча
          start: segment.ray.origin || segment.ray.start,
          end: segment.ray.end,
          damage: segment.damage,
          effects: segment.effects,
          type: segment.type
        };
        
        try {
          shotRayRenderer.drawFireSegment(segmentToRender, index);
        } catch (segmentError) {
          console.warn(`SpaceHolder | Error drawing segment ${index}:`, segmentError);
        }
      });
      
      console.log('SpaceHolder | Shot rendering completed with shotRayRenderer');
      
    } else if (aimingSystem && aimingSystem.rayRenderer) {
      console.log('SpaceHolder | Fallback to AimingSystem rayRenderer');
      
      // Очищаем предыдущие линии
      aimingSystem.rayRenderer.clearRay();
      
      // Отрисовываем каждый сегмент
      shotResult.segments.forEach((segment, index) => {
        console.log(`SpaceHolder | Drawing segment ${index}:`, segment);
        
        const segmentToRender = {
          ...segment.ray,
          start: segment.ray.origin || segment.ray.start,
          end: segment.ray.end,
          damage: segment.damage,
          effects: segment.effects,
          type: segment.type
        };
        
        try {
          aimingSystem.rayRenderer.drawFireSegment(segmentToRender, index);
        } catch (segmentError) {
          console.warn(`SpaceHolder | Error drawing segment ${index}:`, segmentError);
        }
      });
      
      console.log('SpaceHolder | Shot rendering completed with aimingSystem.rayRenderer');
    } else {
      console.warn('SpaceHolder | No rayRenderer available');
      
      // Пробуем использовать ShotHistoryManager
      const { ShotHistoryManager } = await import('./shot-history-manager.mjs');
      let shotHistoryManager = window.globalShotHistoryManager;
      
      if (!shotHistoryManager) {
        console.log('SpaceHolder | Creating new ShotHistoryManager');
        shotHistoryManager = new ShotHistoryManager(null); // без renderer пока
        window.globalShotHistoryManager = shotHistoryManager;
      }
      
      shotHistoryManager.addShot(shotResult, {
        isRemote: false,
        animate: true,
        autoFade: false
      });
    }
    
  } catch (error) {
    console.error('SpaceHolder | Error rendering shot:', error);
  }
}

/**
 * Обработчик изменения состояния тестовой кнопки
 */
function handleTestButtonChange(isActive) {
  console.log('SpaceHolder | Test Button changed! Active:', isActive);
  
  if (isActive) {
    // Кнопка активирована - выполняем тестовое действие
    runTestAction();
    // Немедленно деактивируем кнопку
    deactivateTestButton();
  }
}

/**
 * Тестовое действие
 */
function runTestAction() {
  console.log('SpaceHolder | Test Action executed - opening dialog');
  showTestDialog();
}

/**
 * Показать тестовый диалог
 */
async function showTestDialog() {
  const content = `
    <div class="test-dialog-content">
      <h3><i class="fas fa-flask"></i> Тестовое окно</h3>
      <p>Это плейсхолдер контент для тестового диалога.</p>
      
      <div class="form-group">
        <label for="test-input">Тестовое поле:</label>
        <input type="text" id="test-input" name="testInput" value="Пример текста" />
      </div>
      
      <div class="form-group">
        <label>
          <input type="checkbox" name="testCheckbox" checked />
          Тестовый чекбокс
        </label>
      </div>
      
      <div class="table-section" style="margin-top: 15px;">
        <h4 style="margin-bottom: 10px;"><i class="fas fa-table"></i> Динамическая таблица</h4>
        <button type="button" id="add-row-btn" style="margin-bottom: 10px; display: block;">
          <i class="fas fa-plus"></i> Добавить
        </button>
        <div style="max-height: 200px; overflow-y: auto; border: 1px solid #ccc;">
          <table id="dynamic-table" style="width: 100%; border-collapse: collapse;">
            <thead style="position: sticky; top: 0; background: #333; z-index: 10;">
              <tr style="background: #333; color: white;">
                <th style="border: 1px solid #ccc; padding: 8px;">Название</th>
                <th style="border: 1px solid #ccc; padding: 8px;">Значение</th>
                <th style="border: 1px solid #ccc; padding: 8px; width: 80px;">Действия</th>
              </tr>
            </thead>
            <tbody id="table-body">
              <!-- Строки будут добавляться динамически -->
            </tbody>
          </table>
        </div>
      </div>
      
      <p style="color: #666; font-size: 12px; margin-top: 15px;">
        Здесь будет реальный функционал в будущем.
      </p>
    </div>
  `;
  
  try {
    const result = await foundry.applications.api.DialogV2.wait({
      window: { 
        title: 'Тестовое диалоговое окно', 
        icon: 'fa-solid fa-flask'
      },
      position: { width: 500 },
      content,
      render: (event, dialog) => {
        setupDynamicTable(dialog);
      },
      buttons: [
        {
          action: 'confirm',
          label: 'Применить',
          icon: 'fa-solid fa-check',
          default: true,
          callback: (event) => {
            const tableData = collectTableData(event.currentTarget);
            const formData = new foundry.applications.ux.FormDataExtended(
              event.currentTarget.querySelector('.test-dialog-content')
            );
            const data = foundry.utils.expandObject(formData.object);
            
            // Добавляем данные таблицы
            data.tableRows = tableData;
            
            console.log('SpaceHolder | Test Dialog data:', data);
            ui.notifications.info(`Получены данные: ${JSON.stringify(data)}`);
            
            return data;
          }
        },
        { 
          action: 'cancel', 
          label: 'Отмена', 
          icon: 'fa-solid fa-times' 
        }
      ]
    });
    
    console.log('SpaceHolder | Test Dialog result:', result);
  } catch (error) {
    console.error('SpaceHolder | Test Dialog error:', error);
  }
}

/**
 * Настройка обработчиков для динамической таблицы
 */
function setupDynamicTable(dialog) {
  let rowCounter = 0;
  
  const addButton = dialog.element.querySelector('#add-row-btn');
  const tableBody = dialog.element.querySelector('#table-body');
  
  if (!addButton || !tableBody) {
    console.error('SpaceHolder | Dynamic table elements not found');
    return;
  }
  
  // Обработчик кнопки "Добавить"
  addButton.addEventListener('click', () => {
    addTableRow(tableBody, rowCounter++);
  });
}

/**
 * Добавить строку в таблицу
 */
function addTableRow(tableBody, rowId) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td style="border: 1px solid #ccc; padding: 8px;">
      <input type="text" name="row_${rowId}_name" placeholder="Название..." 
             style="width: 100%; border: none; background: transparent;" />
    </td>
    <td style="border: 1px solid #ccc; padding: 8px;">
      <input type="text" name="row_${rowId}_value" placeholder="Значение..." 
             style="width: 100%; border: none; background: transparent;" />
    </td>
    <td style="border: 1px solid #ccc; padding: 8px; text-align: center;">
      <button type="button" class="remove-row-btn" data-row-id="${rowId}" 
              style="background: #d32f2f; color: white; border: none; padding: 4px 8px; cursor: pointer;">
        <i class="fas fa-trash"></i>
      </button>
    </td>
  `;
  
  // Обработчик кнопки удаления
  const removeBtn = row.querySelector('.remove-row-btn');
  removeBtn.addEventListener('click', () => {
    row.remove();
  });
  
  tableBody.appendChild(row);
  
  // Фокус на первом поле новой строки
  const firstInput = row.querySelector('input');
  if (firstInput) {
    firstInput.focus();
  }
}

/**
 * Собрать данные из таблицы
 */
function collectTableData(dialogElement) {
  const tableRows = [];
  const rows = dialogElement.querySelectorAll('#table-body tr');
  
  rows.forEach((row) => {
    const nameInput = row.querySelector('input[name*="_name"]');
    const valueInput = row.querySelector('input[name*="_value"]');
    
    if (nameInput && valueInput) {
      const name = nameInput.value.trim();
      const value = valueInput.value.trim();
      
      if (name || value) { // Добавляем только непустые строки
        tableRows.push({ name, value });
      }
    }
  });
  
  return tableRows;
}

/**
 * Деактивировать тестовую кнопку
 */
function deactivateTestButton() {
  // Получаем ссылку на систему управления сценой
  const sceneControls = ui.controls;
  if (sceneControls && typeof sceneControls.activate === 'function') {
    // Переключаемся на стандартную группу с инструментом выбора
    sceneControls.activate({ control: 'tokens', tool: 'select' });
  }
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

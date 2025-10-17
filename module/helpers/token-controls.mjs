/**
 * Token Controls Helper
 * Добавляет пользовательские кнопки в панель Token Controls
 */

import { AimingDialog } from './aiming-dialog.mjs';

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
  // Проверяем, есть ли выбранные токены
  const controlled = canvas.tokens.controlled;
  
  if (controlled.length === 0) {
    ui.notifications.warn('Выберите токен для настройки прицеливания');
    // Деактивируем кнопку
    deactivateAimingTool();
    return;
  }
  
  if (controlled.length > 1) {
    ui.notifications.warn('Выберите только один токен для прицеливания');
    deactivateAimingTool();
    return;
  }
  
  const token = controlled[0];
  
  // Показываем диалог
  AimingDialog.show(token).then(() => {
    // После закрытия диалога деактивируем кнопку
    deactivateAimingTool();
  });
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

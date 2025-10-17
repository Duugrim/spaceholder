/**
 * PayloadDialog - новый диалог для создания и настройки payload
 * Заменяет старые настройки дальности/рикошетов на гибкую систему сегментов
 */

import { PayloadFactory } from './payload-factory.mjs';
import { TrajectorySegmentFactory } from './trajectory-segment.mjs';

export class PayloadDialog {
  
  /**
   * Показать диалог создания payload
   * @param {Token} token - токен стрелка
   * @param {Object} initialPayload - начальная конфигурация payload (опционально)
   * @returns {Promise<Object>} результат { cancelled: bool, payload: Object }
   */
  static async show(token, initialPayload = null) {
    if (!token) {
      ui.notifications.warn('Токен не выбран!');
      return { cancelled: true };
    }

    if (!token.isOwner) {
      ui.notifications.warn('Вы не можете управлять этим токеном!');
      return { cancelled: true };
    }
    
    // Устанавливаем payload по умолчанию (пистолет)
    const defaultPayload = initialPayload || PayloadFactory.createPistol();
    
    const content = this._generateContent(token, defaultPayload);
    
    try {
      const result = await foundry.applications.api.DialogV2.wait({
        window: { 
          title: 'Настройка траектории выстрела', 
          icon: 'fa-solid fa-crosshairs',
          resizable: true
        },
        position: { 
          width: 600,
          height: 'auto'
        },
        content,
        render: (event, dialog) => {
          this._setupEventHandlers(dialog);
        },
        buttons: [
          {
            action: 'fire',
            label: 'Выстрелить',
            icon: 'fa-solid fa-bullseye',
            default: true,
            callback: (event, dialog) => this._handleFire(event, dialog, token)
          },
          {
            action: 'preview',
            label: 'Предпросмотр',
            icon: 'fa-solid fa-eye',
            callback: (event, dialog) => this._handlePreview(event, dialog, token)
          },
          { 
            action: 'cancel', 
            label: 'Отмена', 
            icon: 'fa-solid fa-times' 
          }
        ]
      });
      
      if (result === 'cancel') {
        return { cancelled: true };
      }
      
      return { cancelled: false, result: result };
      
    } catch (error) {
      console.error('PayloadDialog: Error:', error);
      ui.notifications.error('Ошибка диалога: ' + error.message);
      return { cancelled: true };
    }
  }
  
  /**
   * Генерация HTML содержимого диалога
   * @param {Token} token - токен
   * @param {Object} payload - текущий payload
   * @returns {string} HTML содержимое
   * @private
   */
  static _generateContent(token, payload) {
    const tokenName = token?.document?.name || token?.name || 'Неизвестный токен';
    const weaponTypes = PayloadFactory.getAvailableWeaponTypes();
    
    return `
      <form class="payload-dialog-form">
        <div class="dialog-row header-row">
          <h3><i class="fas fa-crosshairs"></i> Настройка траектории выстрела</h3>
          <p><strong>Токен:</strong> ${tokenName}</p>
        </div>

        <div class="dialog-row preset-row">
          <label for="weaponPreset">
            <i class="fas fa-list"></i> Предустановки оружия:
          </label>
          <select id="weaponPreset" name="weaponPreset">
            <option value="">Выберите тип оружия...</option>
            ${weaponTypes.map(type => {
              const desc = PayloadFactory.getWeaponDescription(type);
              const selected = payload.name === type ? 'selected' : '';
              return `<option value="${type}" ${selected}>${desc.name} - ${desc.description}</option>`;
            }).join('')}
            <option value="custom">Собственная конфигурация</option>
          </select>
        </div>

        <div class="dialog-row trajectory-row">
          <div class="rimworld-header">
            <i class="fas fa-route"></i>
            Сегменты траектории
          </div>
          
          <div class="inventory-controls">
            <button type="button" id="add-segment" class="item-create-btn">
              <i class="fas fa-plus"></i>
              <span class="btn-text">Добавить сегмент</span>
            </button>
          </div>
          
          <div id="segments-container" class="inventory-list">
            ${this._generateSegmentsHTML(payload.trajectory || [])}
          </div>
        </div>

        <div class="dialog-row info-row">
          <div id="payload-info" class="payload-summary">
            ${this._generatePayloadInfo(payload)}
          </div>
        </div>
      </form>
      
      ${this._generateCSS()}
    `;
  }
  
  /**
   * Генерация HTML для сегментов траектории
   * @param {Array} trajectory - массив сегментов
   * @returns {string} HTML для сегментов
   * @private
   */
  static _generateSegmentsHTML(trajectory) {
    if (!trajectory || trajectory.length === 0) {
      return '<div class="no-segments">Нет сегментов. Добавьте первый сегмент.</div>';
    }
    
    return trajectory.map((segment, index) => this._generateSegmentHTML(segment, index)).join('');
  }
  
  /**
   * Генерация HTML для одного сегмента в компактном стиле
   * @param {Object} segment - данные сегмента
   * @param {number} index - индекс сегмента
   * @returns {string} HTML сегмента
   * @private
   */
  static _generateSegmentHTML(segment, index) {
    const segmentTypes = [
      { value: 'line', name: 'Прямая' },
      { value: 'lineRec', name: 'До попадания' }
    ];
    
    // Собираем текст сегмента
    let segmentText = `#${index + 1} `;
    
    // Тип сегмента
    const typeName = segmentTypes.find(t => t.value === segment.type)?.name || 'Прямая';
    segmentText += `${typeName}/${segment.length || 100}px`;
    
    // Итерации для lineRec
    if (segment.type === 'lineRec') {
      segmentText += `, Итер: ${segment.maxIterations || 20}`;
    }
    
    // Рикошеты
    segmentText += `, Рик. ${segment.allowRicochet ? '☑' : '☐'}`;
    if (segment.allowRicochet) {
      segmentText += ` (${segment.maxRicochets || 1})`;
    }
    
    return `
      <div class="segment-row" data-segment-index="${index}">
        <div class="segment-content">
          <span class="segment-label">#${index + 1}</span>
          <select name="segments[${index}].type" class="seg-type">
            ${segmentTypes.map(type => `
              <option value="${type.value}" ${segment.type === type.value ? 'selected' : ''}>
                ${type.name}
              </option>
            `).join('')}
          </select>
          <span class="segment-slash">/</span>
          <input type="number" name="segments[${index}].length" class="seg-distance" 
                 value="${segment.length || 100}" min="10" max="2000" step="10">
          <span class="segment-unit">px</span>
          ${segment.type === 'lineRec' ? `
            , Итер: <input type="number" name="segments[${index}].maxIterations" class="seg-iter" 
                           value="${segment.maxIterations || 20}" min="1" max="100">
          ` : ''}
          , Рик. <input type="checkbox" name="segments[${index}].allowRicochet" class="seg-ricochet" 
                      ${segment.allowRicochet ? 'checked' : ''}>
          ${segment.allowRicochet ? `
            (<input type="number" name="segments[${index}].maxRicochets" class="seg-ric-count" 
                   value="${segment.maxRicochets || 1}" min="0" max="10">)
          ` : ''}
        </div>
        <button type="button" class="btn-remove" data-index="${index}">×</button>
      </div>
    `;
  }
  
  /**
   * Генерация HTML для разделения снарядов
   * @param {Object} segment - данные сегмента
   * @param {number} index - индекс сегмента
   * @returns {string} HTML для разделения
   * @private
   */
  static _generateSplitHTML(segment, index) {
    if (!segment.children || segment.children.length === 0) {
      return `
        <div class="split-section">
          <button type="button" class="add-split" data-segment="${index}">
            <i class="fas fa-code-branch"></i> Добавить разделение снарядов
          </button>
        </div>
      `;
    }
    
    return `
      <div class="split-section expanded">
        <h6><i class="fas fa-code-branch"></i> Разделение на ${segment.children.length} снарядов</h6>
        <div class="split-children">
          ${segment.children.map((child, childIndex) => `
            <div class="child-segment" data-child-index="${childIndex}">
              <div class="form-row">
                <div class="form-field">
                  <label>Угол отклонения:</label>
                  <input type="number" name="segments[${index}].children[${childIndex}].offsetAngle" 
                         value="${child.offsetAngle || 0}" min="-180" max="180" step="5">
                  <span class="unit">°</span>
                </div>
                <div class="form-field">
                  <label>Длина:</label>
                  <input type="number" name="segments[${index}].children[${childIndex}].length" 
                         value="${child.length || 100}" min="10" max="1000" step="10">
                  <span class="unit">px</span>
                </div>
                <button type="button" class="remove-child" data-segment="${index}" data-child="${childIndex}">
                  <i class="fas fa-times"></i>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
        <button type="button" class="add-child" data-segment="${index}">
          <i class="fas fa-plus"></i> Добавить дочерний снаряд
        </button>
      </div>
    `;
  }
  
  /**
   * Генерация информации о payload
   * @param {Object} payload - данные payload
   * @returns {string} HTML информации
   * @private
   */
  static _generatePayloadInfo(payload) {
    const trajectory = payload.trajectory || [];
    const totalSegments = trajectory.length;
    const hasRicochets = trajectory.some(s => s.allowRicochet);
    const hasSplits = trajectory.some(s => s.children && s.children.length > 0);
    
    return `
      <div class="payload-stats">
        <p><strong>Всего сегментов:</strong> ${totalSegments}</p>
        <p><strong>Рикошеты:</strong> ${hasRicochets ? 'Да' : 'Нет'}</p>
        <p><strong>Разделение:</strong> ${hasSplits ? 'Да' : 'Нет'}</p>
      </div>
    `;
  }
  
  /**
   * Получить человекочитаемое название типа сегмента
   * @param {string} type - тип сегмента
   * @returns {string} название
   * @private
   */
  static _getSegmentTypeName(type) {
    const names = {
      'line': 'Прямая линия',
      'lineRec': 'До столкновения'
    };
    return names[type] || type;
  }
  
  /**
   * Настройка обработчиков событий
   * @param {Object} dialog - объект диалога
   * @private
   */
  static _setupEventHandlers(dialog) {
    const form = dialog.element.querySelector('form');
    if (!form) return;
    
    // Переключение предустановок оружия
    const weaponPreset = form.querySelector('#weaponPreset');
    weaponPreset?.addEventListener('change', (e) => {
      this._handleWeaponPresetChange(e, dialog);
    });
    
    // Добавление сегмента
    const addSegmentBtn = form.querySelector('#add-segment');
    addSegmentBtn?.addEventListener('click', (e) => {
      this._handleAddSegment(e, dialog);
    });
    
    // Делегирование событий для динамических элементов
    form.addEventListener('click', (e) => {
      if (e.target.matches('.btn-remove') || e.target.closest('.btn-remove')) {
        this._handleRemoveSegment(e, dialog);
      }
    });
    
    // Изменение полей сегментов
    form.addEventListener('change', (e) => {
      if (e.target.matches('.seg-type')) {
        this._handleSegmentTypeChange(e, dialog);
      } else if (e.target.matches('.seg-ricochet')) {
        this._handleRicochetToggle(e, dialog);
      }
      // Обновляем статистику при любом изменении
      this._updatePayloadInfo(dialog);
    });
  }
  
  /**
   * Обработка смены предустановки оружия
   */
  static _handleWeaponPresetChange(event, dialog) {
    const weaponType = event.target.value;
    if (!weaponType || weaponType === 'custom') return;
    
    try {
      const newPayload = PayloadFactory.create(weaponType);
      this._refreshDialog(dialog, newPayload);
    } catch (error) {
      console.error('Error loading weapon preset:', error);
      ui.notifications.error('Ошибка загрузки предустановки: ' + error.message);
    }
  }
  
  /**
   * Обработка нажатия "Выстрелить"
   */
  static async _handleFire(event, dialog, token) {
    try {
      const payload = this._extractPayloadFromDialog(dialog);
      
      // Импортируем ShotSystem и выполняем выстрел
      const { ShotSystem } = await import('./shot-system.mjs');
      const { ShotHistoryManager } = await import('./shot-history-manager.mjs');
      
      const shotSystem = new ShotSystem(game.spaceholder.aimingSystem.rayCaster);
      const shotResult = await shotSystem.fire(
        token.center,
        0, // направление - пока по умолчанию
        payload,
        token
      );
      
      // Визуализируем выстрел
      let shotHistoryManager = window.newShotTest?.shotHistoryManager;
      if (!shotHistoryManager) {
        shotHistoryManager = new ShotHistoryManager(game.spaceholder.aimingSystem.rayRenderer);
        if (window.newShotTest) {
          window.newShotTest.shotHistoryManager = shotHistoryManager;
        }
      }
      
      shotHistoryManager.addShot(shotResult, {
        isRemote: false,
        animate: true,
        autoFade: false // Для демонстрации оставляем
      });
      
      ui.notifications.info(`Выстрел выполнен! ID: ${shotResult.id.substring(0, 8)}...`);
      console.log('Shot result:', shotResult);
      
      return { action: 'fire', payload, shotResult };
      
    } catch (error) {
      console.error('Error firing shot:', error);
      ui.notifications.error('Ошибка выстрела: ' + error.message);
      return { action: 'error', error: error.message };
    }
  }
  
  /**
   * Извлечение payload из диалога
   * @param {Object} dialog - объект диалога
   * @returns {Object} payload
   * @private
   */
  static _extractPayloadFromDialog(dialog) {
    // В DialogV2 структура может быть разной, попробуем несколько вариантов поиска
    let form = null;
    
    if (dialog && dialog.element) {
      // Попробуем найти форму через разные селекторы
      form = dialog.element.querySelector('form') ||
             dialog.element.querySelector('.payload-dialog-form') ||
             dialog.element.querySelector('[class*="payload-dialog"]');
      
      // Если не нашли форму, но есть контейнер сегментов, используем его
      if (!form) {
        const container = dialog.element.querySelector('#segments-container');
        if (container) {
          form = container.closest('div') || container.parentElement;
        }
      }
    }
    
    // Если всё ещё нет формы, попробуем глобальный поиск
    if (!form) {
      form = document.querySelector('.payload-dialog-form') ||
             document.querySelector('#segments-container')?.parentElement;
    }
    
    if (!form) {
      console.warn('Form not found, returning default payload');
      console.log('Dialog element:', dialog?.element);
      console.log('Available elements:', dialog?.element?.innerHTML?.substring(0, 200));
      return this._getDefaultPayload();
    }
    
    // Извлекаем базовую информацию
    const payload = {
      name: 'custom',
      trajectory: []
    };
    
    // Отладочная информация
    console.log('Form found:', form);
    console.log('Form HTML:', form?.outerHTML?.substring(0, 300));
    
    // Собираем сегменты
    const segmentRows = form.querySelectorAll('.segment-row');
    console.log('Found segment rows:', segmentRows.length);
    
    if (segmentRows.length === 0) {
      // Если нет сегментов, создаем базовый
      console.log('No segments found, using default');
      payload.trajectory.push({
        type: 'line',
        length: 200
      });
      return payload;
    }
    
    segmentRows.forEach((row, index) => {
      // Извлекаем данные сегмента из полей формы
      const segmentIndex = parseInt(row.dataset.segmentIndex) || index;
      
      const segment = {
        type: row.querySelector('select[name*=".type"]')?.value || 'line',
        length: parseInt(row.querySelector('input[name*=".length"]')?.value) || 100
      };
      
      // Добавляем специфичные параметры
      if (segment.type === 'lineRec') {
        segment.maxIterations = parseInt(row.querySelector('input[name*=".maxIterations"]')?.value) || 20;
      }
      
      // Рикошеты
      const ricochetCheckbox = row.querySelector('input[name*=".allowRicochet"]');
      if (ricochetCheckbox?.checked) {
        segment.allowRicochet = true;
        segment.maxRicochets = parseInt(row.querySelector('input[name*=".maxRicochets"]')?.value) || 1;
      }
      
      console.log(`Adding segment ${index}:`, segment);
      payload.trajectory.push(segment);
    });
    
    return payload;
  }
  
  /**
   * Получить payload по умолчанию
   * @returns {Object} базовый payload
   * @private
   */
  static _getDefaultPayload() {
    return {
      name: 'default',
      trajectory: [{
        type: 'line',
        length: 200
      }]
    };
  }
  
  /**
   * Обновить диалог с новым payload
   * @param {Object} dialog - объект диалога  
   * @param {Object} payload - новый payload
   * @private
   */
  static _refreshDialog(dialog, payload) {
    const segmentsContainer = dialog.element.querySelector('#segments-container');
    const payloadInfo = dialog.element.querySelector('#payload-info');
    
    if (segmentsContainer) {
      segmentsContainer.innerHTML = this._generateSegmentsHTML(payload.trajectory);
    }
    
    if (payloadInfo) {
      payloadInfo.innerHTML = this._generatePayloadInfo(payload);
    }
    
    // Пересоздаем обработчики для новых элементов
    this._setupEventHandlers(dialog);
  }
  
  /**
   * CSS стили для диалога
   * @returns {string} CSS
   * @private
   */
  static _generateCSS() {
    return `
      <style>
      .payload-dialog-form {
        font-family: 'Roboto', sans-serif;
        font-size: 13px;
      }
      
      .form-group {
        margin-bottom: 15px;
        border: 1px solid #444;
        padding: 10px;
        border-radius: 5px;
        background: rgba(0, 0, 0, 0.1);
      }
      
      .header-group h3 {
        margin: 0 0 10px 0;
        color: #ff6400;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .preset-group select {
        width: 100%;
        padding: 5px;
        border: 1px solid #555;
        background: #222;
        color: white;
        border-radius: 3px;
      }
      
      /* Простая структура сегментов с инлайн-редактированием */
      .segment-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: linear-gradient(135deg, #1a1a1a 0%, #262626 100%);
        border: 1px solid #4a6e4a;
        border-radius: 6px;
        padding: 8px 12px;
        margin-bottom: 4px;
        font-size: 13px;
        gap: 8px;
      }
      
      .segment-row:hover {
        background: linear-gradient(135deg, #202020 0%, #2c2c2c 100%);
        border-color: #5a7e5a;
      }
      
      .segment-content {
        display: flex;
        align-items: center;
        flex: 1;
        gap: 6px;
        flex-wrap: wrap;
      }
      
      .segment-label {
        color: #ff6400;
        font-weight: bold;
        min-width: 25px;
      }
      
      .seg-type {
        padding: 2px 6px;
        border: 1px solid #555;
        background: #222;
        color: white;
        border-radius: 3px;
        font-size: 12px;
        min-width: 80px;
      }
      
      .segment-slash {
        color: #aaa;
        margin: 0 2px;
      }
      
      .seg-distance, .seg-iter, .seg-ric-count {
        width: 50px;
        padding: 2px 4px;
        border: 1px solid #555;
        background: #222;
        color: white;
        border-radius: 3px;
        font-size: 12px;
        text-align: center;
      }
      
      .segment-unit {
        color: #aaa;
        font-size: 11px;
      }
      
      .seg-ricochet {
        margin: 0 3px;
      }
      
      .btn-remove {
        background: transparent;
        border: 1px solid #555;
        color: #e0e0e0;
        width: 28px;
        height: 28px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      
      .btn-remove:hover {
        background: rgba(231, 76, 60, 0.2);
        border-color: #e74c3c;
        color: white;
      }
      
      /* Кнопки создания */
      .payload-dialog-form .item-create-btn {
        display: inline-flex !important;
        flex-direction: row !important;
        align-items: center !important;
        gap: 6px !important;
        background: transparent !important;
        color: #e0e0e0 !important;
        border: 1px solid #4a6e4a !important;
        border-radius: 6px !important;
        padding: 4px 10px !important;
        white-space: nowrap !important;
        cursor: pointer !important;
        font-size: 12px !important;
        transition: all 0.2s ease !important;
        margin-bottom: 8px !important;
        width: auto !important;
      }
      
      .payload-dialog-form .item-create-btn:hover {
        background: rgba(255,255,255,0.06) !important;
        color: #ffffff !important;
      }
      
      .payload-dialog-form .item-create-btn i {
        color: #8fb98f !important;
      }
      
      /* Заголовки */
      .payload-dialog-form .rimworld-header {
        background: linear-gradient(135deg, rgba(255,100,0,0.2) 0%, rgba(255,100,0,0.1) 100%) !important;
        border: 1px solid rgba(255,100,0,0.3) !important;
        border-radius: 6px !important;
        padding: 8px 12px !important;
        margin-bottom: 8px !important;
        color: #ff6400 !important;
        font-weight: bold !important;
        display: flex !important;
        flex-direction: row !important;
        align-items: center !important;
        gap: 8px !important;
        width: 100% !important;
        box-sizing: border-box !important;
      }
      
      .payload-dialog-form .inventory-controls {
        margin-bottom: 8px !important;
        display: flex !important;
        flex-direction: row !important;
        justify-content: flex-start !important;
        width: 100% !important;
      }
      
      .split-section {
        margin-top: 10px;
        padding: 8px;
        border: 1px dashed #666;
        border-radius: 3px;
        background: rgba(0, 0, 0, 0.1);
      }
      
      .payload-summary {
        background: rgba(74, 144, 226, 0.1);
        padding: 8px;
        border-radius: 3px;
        border-left: 3px solid #4a90e2;
        font-size: 12px;
      }
      
      .no-segments {
        text-align: center;
        color: #aaa;
        font-style: italic;
        padding: 15px;
        background: rgba(0, 0, 0, 0.1);
        border-radius: 3px;
        font-size: 12px;
      }
      </style>
    `;
  }
  
  // Обработчики событий
  static _handleAddSegment(e, dialog) { 
    console.log('Add segment');
    e.preventDefault();
    
    try {
      const form = dialog.element.querySelector('form');
      const container = form.querySelector('#segments-container');
      const existingRows = container.querySelectorAll('.segment-row');
      const newIndex = existingRows.length;
      
      // Создаем новый сегмент
      const newSegment = { type: 'line', length: 100 };
      const segmentHTML = this._generateSegmentHTML(newSegment, newIndex);
      
      // Удаляем сообщение "нет сегментов" если есть
      const noSegments = container.querySelector('.no-segments');
      if (noSegments) {
        noSegments.remove();
      }
      
      container.insertAdjacentHTML('beforeend', segmentHTML);
      this._updatePayloadInfo(dialog);
      
    } catch (error) {
      console.error('Error adding segment:', error);
    }
  }
  
  static _handleRemoveSegment(e, dialog) { 
    console.log('Remove segment');
    e.preventDefault();
    
    try {
      const segmentRow = e.target.closest('.segment-row');
      if (segmentRow) {
        segmentRow.remove();
        
        // Если больше нет сегментов, показываем сообщение
        const form = dialog.element.querySelector('form');
        const container = form.querySelector('#segments-container');
        const remainingRows = container.querySelectorAll('.segment-row');
        
        if (remainingRows.length === 0) {
          container.innerHTML = '<div class="no-segments">Нет сегментов. Добавьте первый сегмент.</div>';
        } else {
          // Перенумеровываем оставшиеся сегменты
          this._refreshAllSegments(dialog, remainingCards);
        }
        
        this._updatePayloadInfo(dialog);
      }
    } catch (error) {
      console.error('Error removing segment:', error);
    }
  }
  
  static _handleAddSplit(e, dialog) { 
    console.log('Add split - TODO: implement');
    ui.notifications.info('Функция разделения снарядов будет реализована позже');
  }
  
  static _handleAddChild(e, dialog) { 
    console.log('Add child - TODO: implement');
  }
  
  static _handleRemoveChild(e, dialog) { 
    console.log('Remove child - TODO: implement');
  }
  
  
  static _handleSegmentTypeChange(e, dialog) {
    console.log('Segment type change');
    
    // Перестроим сегмент с новым типом
    const segmentRow = e.target.closest('.segment-row');
    if (segmentRow) {
      const index = parseInt(segmentRow.dataset.segmentIndex);
      const newType = e.target.value;
      
      // Собираем текущие значения
      const currentLength = parseInt(segmentRow.querySelector('.seg-distance')?.value) || 100;
      const currentRicochet = segmentRow.querySelector('.seg-ricochet')?.checked || false;
      const currentMaxRicochets = parseInt(segmentRow.querySelector('.seg-ric-count')?.value) || 1;
      
      const segment = {
        type: newType,
        length: currentLength,
        allowRicochet: currentRicochet
      };
      
      if (newType === 'lineRec') {
        segment.maxIterations = 20;
      }
      
      if (currentRicochet) {
        segment.maxRicochets = currentMaxRicochets;
      }
      
      // Перегенерируем HTML
      const newHTML = this._generateSegmentHTML(segment, index);
      segmentRow.outerHTML = newHTML;
    }
  }
  
  static _handleRicochetToggle(e, dialog) {
    console.log('Ricochet toggle');
    
    // Перестроим сегмент с новыми настройками рикошета
    const segmentRow = e.target.closest('.segment-row');
    if (segmentRow) {
      const index = parseInt(segmentRow.dataset.segmentIndex);
      const isChecked = e.target.checked;
      
      const segment = {
        type: segmentRow.querySelector('.seg-type')?.value || 'line',
        length: parseInt(segmentRow.querySelector('.seg-distance')?.value) || 100,
        allowRicochet: isChecked
      };
      
      if (segment.type === 'lineRec') {
        segment.maxIterations = parseInt(segmentRow.querySelector('.seg-iter')?.value) || 20;
      }
      
      if (isChecked) {
        segment.maxRicochets = 1;
      }
      
      // Перегенерируем HTML
      const newHTML = this._generateSegmentHTML(segment, index);
      segmentRow.outerHTML = newHTML;
    }
  }
  
  /**
   * Обработка нажатия кнопки редактирования сегмента
   */
  static _handleEditSegment(e, dialog) {
    console.log('Edit segment');
    e.preventDefault();
    
    try {
      const segmentCard = e.target.closest('.segment-item-card');
      if (segmentCard) {
        const controls = segmentCard.querySelector('.segment-controls');
        const display = segmentCard.querySelector('.segment-display');
        const editBtn = segmentCard.querySelector('.segment-edit');
        
        if (controls.style.display === 'none' || !controls.style.display) {
          // Переход в режим редактирования
          controls.style.display = 'flex';
          display.style.display = 'none';
          editBtn.innerHTML = '<i class="fas fa-check"></i>';
          editBtn.title = 'Сохранить';
        } else {
          // Сохранение и выход из режима редактирования
          this._saveSegmentChanges(segmentCard, dialog);
        }
      }
    } catch (error) {
      console.error('Error editing segment:', error);
    }
  }
  
  /**
   * Обновление сегмента из элементов управления
   */
  static _updateSegmentFromControls(e, dialog) {
    try {
      const segmentCard = e.target.closest('.segment-item-card');
      if (segmentCard) {
        const index = parseInt(segmentCard.dataset.segmentIndex);
        const controls = segmentCard.querySelector('.segment-controls');
        
        // Собираем данные из элементов управления
        const segment = this._extractSegmentFromControls(controls, index);
        
        // Обновляем HTML
        const newHTML = this._generateSegmentHTML(segment, index);
        segmentCard.outerHTML = newHTML;
        
        // Активируем режим редактирования для нового элемента
        setTimeout(() => {
          const newCard = dialog.element.querySelector(`[data-segment-index="${index}"]`);
          if (newCard) {
            const newControls = newCard.querySelector('.segment-controls');
            const newDisplay = newCard.querySelector('.segment-display');
            const newEditBtn = newCard.querySelector('.segment-edit');
            
            newControls.style.display = 'flex';
            newDisplay.style.display = 'none';
            newEditBtn.innerHTML = '<i class="fas fa-check"></i>';
            newEditBtn.title = 'Сохранить';
          }
        }, 10);
        
        this._updatePayloadInfo(dialog);
      }
    } catch (error) {
      console.error('Error updating segment from controls:', error);
    }
  }
  
  /**
   * Сохранение изменений сегмента
   */
  static _saveSegmentChanges(segmentCard, dialog) {
    try {
      const index = parseInt(segmentCard.dataset.segmentIndex);
      const controls = segmentCard.querySelector('.segment-controls');
      
      // Извлекаем данные сегмента
      const segment = this._extractSegmentFromControls(controls, index);
      
      // Перегенерируем HTML
      const newHTML = this._generateSegmentHTML(segment, index);
      segmentCard.outerHTML = newHTML;
      
      this._updatePayloadInfo(dialog);
      
    } catch (error) {
      console.error('Error saving segment changes:', error);
    }
  }
  
  /**
   * Извлечение данных сегмента из элементов управления
   */
  static _extractSegmentFromControls(controls, index) {
    const segment = {
      type: controls.querySelector('.seg-type')?.value || 'line',
      length: parseInt(controls.querySelector('.seg-distance')?.value) || 100
    };
    
    if (segment.type === 'lineRec') {
      segment.maxIterations = parseInt(controls.querySelector('.seg-iter')?.value) || 20;
    }
    
    const ricochetCheckbox = controls.querySelector('.seg-ricochet');
    if (ricochetCheckbox?.checked) {
      segment.allowRicochet = true;
      segment.maxRicochets = parseInt(controls.querySelector('.seg-ric-count')?.value) || 1;
    }
    
    return segment;
  }
  
  /**
   * Обновление всех сегментов после удаления
   */
  static _refreshAllSegments(dialog, remainingCards) {
    try {
      const payload = this._extractPayloadFromDialog(dialog);
      const container = dialog.element.querySelector('#segments-container');
      container.innerHTML = this._generateSegmentsHTML(payload.trajectory);
    } catch (error) {
      console.error('Error refreshing segments:', error);
    }
  }
  
  static _handlePreview(e, dialog, token) { 
    console.log('Preview shot');
    e.preventDefault();
    
    try {
      const payload = this._extractPayloadFromDialog(dialog);
      
      // Показываем информацию о payload вместо закрытия диалога
      console.log('Preview payload:', payload);
      ui.notifications.info(`Предпросмотр: ${payload.trajectory.length} сегментов`);
      
      // TODO: здесь можно добавить визуализацию траектории без выстрела
      return false; // Не закрываем диалог
      
    } catch (error) {
      console.error('Error in preview:', error);
      ui.notifications.error('Ошибка предпросмотра: ' + error.message);
      return false;
    }
  }
  
  /**
   * Обновить информацию о payload в диалоге
   * @param {Object} dialog - диалог
   * @private
   */
  static _updatePayloadInfo(dialog) {
    try {
      const payload = this._extractPayloadFromDialog(dialog);
      const payloadInfo = dialog.element.querySelector('#payload-info');
      if (payloadInfo) {
        payloadInfo.innerHTML = this._generatePayloadInfo(payload);
      }
    } catch (error) {
      console.error('Error updating payload info:', error);
    }
  }
}
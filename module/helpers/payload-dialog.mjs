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
    
    // Устанавливаем payload по умолчанию (прямая линия)
    const defaultPayload = initialPayload || await PayloadFactory.create('line_direct');
    
    const content = await this._generateContent(token, defaultPayload);
    
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
            label: 'Начать прицеливание',
            icon: 'fa-solid fa-crosshairs',
            default: true,
            callback: (event, dialog) => this._handleFire(event, dialog, token)
          },
          { 
            action: 'cancel', 
            label: 'Отмена', 
            icon: 'fa-solid fa-times' 
          }
        ]
      });
      
      console.log('PayloadDialog: Dialog result:', result);
      
      if (result === 'cancel') {
        return { cancelled: true };
      }
      
      // DialogV2 возвращает результат callback, а не action
      // Если callback вернул true (успех), значит пользователь нажал "Начать прицеливание"
      if (result === true) {
        const payload = this._lastExtractedPayload || this._getDefaultPayload();
        console.log('PayloadDialog: Returning payload for aiming:', payload);
        return { action: 'fire', payload };
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
   * @returns {Promise<string>} HTML содержимое
   * @private
   */
  static async _generateContent(token, payload) {
    const tokenName = token?.document?.name || token?.name || 'Неизвестный токен';
    const trajectories = PayloadFactory.getAvailableTrajectories();
    
    return `
      <form class="payload-dialog-form">
        <div class="dialog-row header-row">
          <h3><i class="fas fa-crosshairs"></i> Настройка траектории выстрела</h3>
          <p><strong>Токен:</strong> ${tokenName}</p>
        </div>

        <div class="dialog-row preset-row">
          <label for="trajectoryPreset">
            <i class="fas fa-list"></i> Пресеты траекторий:
          </label>
          <select id="trajectoryPreset" name="trajectoryPreset">
            <option value="">Выберите траектория...</option>
            ${Object.entries(trajectories).map(([id, info]) => {
              const selected = payload.id === id ? 'selected' : '';
              return `<option value="${id}" ${selected}>${info.name} - ${info.description}</option>`;
            }).join('')}
          </select>
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
    
    // Переключение пресетов траекторий
    const trajectoryPreset = form.querySelector('#trajectoryPreset');
    trajectoryPreset?.addEventListener('change', (e) => {
      this._handleTrajectoryPresetChange(e, dialog);
    });
  }
  
  
  /**
   * Обновление информации о payload
   * @param {Object} dialog - объект диалога
   * @param {Object} payload - payload для отображения
   * @private
   */
  static _updatePayloadInfo(dialog, payload) {
    const payloadInfo = dialog.element.querySelector('#payload-info');
    if (payloadInfo && payload) {
      payloadInfo.innerHTML = this._generatePayloadInfo(payload);
    }
  }
  
  /**
   * Обработка смены пресета траектории
   */
  static async _handleTrajectoryPresetChange(event, dialog) {
    const trajectoryId = event.target.value;
    if (!trajectoryId) return;
    
    try {
      const newPayload = await PayloadFactory.create(trajectoryId);
      
      // Сохраняем выбранную траекторию в диалоге
      dialog._selectedPayload = newPayload;
      
      // Обновляем статистику
      this._updatePayloadInfo(dialog, newPayload);
      
      console.log('SpaceHolder | Selected trajectory preset:', trajectoryId, newPayload);
      
    } catch (error) {
      console.error('Error loading trajectory preset:', error);
      ui.notifications.error('Ошибка загрузки пресета: ' + error.message);
    }
  }
  
  /**
   * Обработка нажатия "Начать прицеливание"
   * Сохраняем payload для последующего использования
   */
  static async _handleFire(event, dialog, token) {
    try {
      const payload = this._extractPayloadFromDialog(dialog);
      
      // Сохраняем payload для доступа в основном методе
      this._lastExtractedPayload = payload;
      
      console.log('PayloadDialog: Fire button pressed, payload extracted:', payload);
      ui.notifications.info(`Настроен payload "${payload.name}" с ${payload.trajectory.length} сегментами`);
      
      // DialogV2 будет возвращать action, не этот объект
      return true; // Просто подтверждаем успех
      
    } catch (error) {
      console.error('Error extracting payload:', error);
      ui.notifications.error('Ошибка настройки: ' + error.message);
      return false; // Ошибка
    }
  }
  
  /**
   * Извлечение payload из диалога (выбранная траектория)
   * @param {Object} dialog - объект диалога
   * @returns {Object} payload
   * @private
   */
  static _extractPayloadFromDialog(dialog) {
    // Возвращаем выбранную траекторию или по умолчанию
    if (dialog._selectedPayload) {
      console.log('SpaceHolder | Using selected payload:', dialog._selectedPayload);
      return dialog._selectedPayload;
    }
    
    // Если ничего не выбрано, возвращаем по умолчанию
    console.warn('SpaceHolder | No trajectory selected, using default');
    return this._getDefaultPayload();
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
      }],
      ignoreShooterSegments: 1 // По умолчанию первый сегмент игнорирует токен стрелка
    };
  }
  
  /**
   * Обновить диалог с новым payload
   * @param {Object} dialog - объект диалога  
   * @param {Object} payload - новый payload
   * @private
   */
  static async _refreshDialog(dialog, payload) {
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
        width: 100%;
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      
      .dialog-row {
        width: 100%;
        box-sizing: border-box;
        margin-bottom: 10px;
      }
      
      .trajectory-row {
        width: 100%;
        box-sizing: border-box;
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
      
      .preset-row select {
        width: 100%;
        max-width: 100%;
        padding: 5px;
        border: 1px solid #555;
        background: #222;
        color: white;
        border-radius: 3px;
        box-sizing: border-box;
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
}

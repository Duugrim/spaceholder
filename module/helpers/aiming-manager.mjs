/**
 * Aiming Manager - модульная система прицеливания
 * Управляет процессом прицеливания и создаёт выстрелы через shot-manager
 */

/**
 * AimingManager - главный класс для управления прицеливанием
 */
export class AimingManager {
  constructor() {
    // Используем глобальный shotManager из game.spaceholder
    this.shotManager = null;
    this.isAiming = false;
    this.currentToken = null;
    this.currentPayload = null;
    this.currentOptions = null;
    this.pointerGraphics = null;
    
    // Привязки событий
    this._boundEvents = {
      onMouseMove: this._onMouseMove.bind(this),
      onMouseDown: this._onMouseDown.bind(this),
      onContextMenu: this._onContextMenu.bind(this),
      onKeyDown: this._onKeyDown.bind(this)
    };
  }
  
  /**
   * Показать диалог настройки прицеливания
   * @param {Token} token - Токен, для которого настраивается прицеливание
   */
  async showAimingDialog(token) {
    if (!token) {
      ui.notifications.warn('Токен не выбран');
      return;
    }
    
    // Загружаем список доступных payloads
    const payloads = await this._loadPayloads();
    
    // Создаём HTML для диалога
    const payloadOptions = payloads.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    
    const content = `
      <div class="aiming-dialog">
        <div class="form-group">
          <label for="payload-select">Выберите payload:</label>
          <select id="payload-select" style="width: 100%; padding: 6px; margin: 8px 0;">
            ${payloadOptions}
          </select>
        </div>
        <div class="form-group">
          <label for="aiming-type">Тип прицеливания:</label>
          <select id="aiming-type" style="width: 100%; padding: 6px; margin: 8px 0;">
            <option value="simple">Simple</option>
          </select>
        </div>
        <div class="form-group" style="margin: 12px 0;">
          <label style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" id="auto-render" checked>
            <span>Сразу отрисовать</span>
          </label>
        </div>
      </div>
    `;
    
    // Показываем диалог через DialogV2
    await foundry.applications.api.DialogV2.wait({
      window: { title: 'Настройка прицеливания', icon: 'fa-solid fa-crosshairs' },
      position: { width: 400 },
      content: content,
      buttons: [
        {
          action: 'start',
          label: 'Начать',
          icon: 'fa-solid fa-bullseye',
          default: true,
          callback: (event) => {
            const root = event.currentTarget;
            const payloadId = root.querySelector('#payload-select')?.value;
            const aimingType = root.querySelector('#aiming-type')?.value || 'simple';
            const autoRender = root.querySelector('#auto-render')?.checked ?? true;
            
            const payload = payloads.find(p => p.id === payloadId);
            if (payload) {
              this.startAiming(token, payload, { type: aimingType, autoRender: autoRender });
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
  
  /**
   * Загрузить список доступных payloads
   * @private
   * @returns {Array} Массив объектов payloads
   */
  async _loadPayloads() {
    // Загружаем манифест с доступными payloads
    let payloadFiles = [];
    try {
      const manifestResponse = await fetch('systems/spaceholder/module/data/payloads/manifest.json');
      if (manifestResponse.ok) {
        payloadFiles = await manifestResponse.json();
      }
    } catch (error) {
      console.error('Ошибка загрузки манифеста payloads:', error);
      return [];
    }
    
    const payloads = [];
    
    for (const filename of payloadFiles) {
      try {
        const response = await fetch(`systems/spaceholder/module/data/payloads/${filename}.json`);
        if (response.ok) {
          const payload = await response.json();
          payloads.push(payload);
        }
      } catch (error) {
        console.error(`Ошибка загрузки payload ${filename}:`, error);
      }
    }
    
    return payloads;
  }
  
  /**
   * Начать прицеливание
   * @param {Token} token - Токен-стрелок
   * @param {object} payload - Объект payload
   * @param {object} options - Настройки прицеливания (type: 'simple')
   */
  startAiming(token, payload, options) {
    if (!token || !payload) {
      console.error('AimingManager: Invalid token or payload');
      return;
    }
    
    // Если уже прицеливаемся, останавливаем предыдущее
    if (this.isAiming) {
      this.stopAiming();
    }
    
    console.log('AimingManager: Starting aiming for token', token.name);
    console.log('AimingManager: Using payload', payload.id);
    console.log('AimingManager: Options', options);
    
    this.isAiming = true;
    this.currentToken = token;
    this.currentPayload = payload;
    this.currentOptions = options;
    
    // Запускаем режим прицеливания в зависимости от типа
    if (options.type === 'simple') {
      this._startSimpleAiming();
    }
  }
  
  /**
   * Остановить прицеливание
   */
  stopAiming() {
    if (!this.isAiming) return;
    
    console.log('AimingManager: Stopping aiming');
    
    this.isAiming = false;
    this.currentToken = null;
    this.currentPayload = null;
    this.currentOptions = null;
    
    // Убираем визуализацию
    this._clearPointer();
    
    // Отвязываем события
    this._unbindEvents();
    
    // Возвращаем курсор
    document.body.style.cursor = '';
  }
  
  /**
   * Начать режим simple прицеливания
   * @private
   */
  _startSimpleAiming() {
    // Меняем курсор
    document.body.style.cursor = 'crosshair';
    
    // Создаём графику для указателя
    this._createPointer();
    
    // Привязываем события
    this._bindEvents();
    
    ui.notifications.info('Режим прицеливания активирован. ЛКМ - выстрел, ПКМ/ESC - отмена');
  }
  
  /**
   * Создать графику указателя
   * @private
   */
  _createPointer() {
    if (this.pointerGraphics) {
      this.pointerGraphics.destroy();
    }
    
    this.pointerGraphics = new PIXI.Graphics();
    canvas.controls.addChild(this.pointerGraphics);
  }
  
  /**
   * Очистить указатель
   * @private
   */
  _clearPointer() {
    if (this.pointerGraphics) {
      this.pointerGraphics.destroy();
      this.pointerGraphics = null;
    }
  }
  
  /**
   * Обновить визуализацию указателя
   * @private
   */
  _updatePointer() {
    if (!this.isAiming || !this.currentToken || !this.pointerGraphics) return;
    
    const mousePos = canvas.mousePosition;
    const tokenCenter = this.currentToken.center;
    
    // Очищаем предыдущую графику
    this.pointerGraphics.clear();
    
    // Рисуем линию от токена к курсору
    this.pointerGraphics.lineStyle(2, 0x00ff00, 0.8);
    this.pointerGraphics.moveTo(tokenCenter.x, tokenCenter.y);
    this.pointerGraphics.lineTo(mousePos.x, mousePos.y);
    
    // Рисуем круг в точке курсора
    this.pointerGraphics.lineStyle(2, 0x00ff00, 1);
    this.pointerGraphics.drawCircle(mousePos.x, mousePos.y, 10);
  }
  
  /**
   * Получить текущее направление прицеливания
   * @private
   * @returns {number} Направление в градусах
   */
  _getCurrentDirection() {
    if (!this.currentToken) return 0;
    
    const mousePos = canvas.mousePosition;
    const tokenCenter = this.currentToken.center;
    
    const dx = mousePos.x - tokenCenter.x;
    const dy = mousePos.y - tokenCenter.y;
    
    return Math.atan2(dy, dx) * (180 / Math.PI);
  }
  
  /**
   * Выполнить выстрел
   * @private
   */
  _fire() {
    if (!this.isAiming || !this.currentToken || !this.currentPayload) return;
    
    // Получаем глобальный shotManager
    const shotManager = game.spaceholder?.shotManager;
    if (!shotManager) {
      console.error('AimingManager: Global shotManager not initialized');
      return;
    }
    
    const direction = this._getCurrentDirection();
    
    console.log('AimingManager: Firing with direction', direction);
    
    // Создаём выстрел через глобальный shot-manager
    const uid = shotManager.createShot(
      this.currentToken,
      this.currentPayload,
      direction
    );
    
    console.log('AimingManager: Shot created with UID', uid);
    
    // Если включена автоматическая отрисовка, вызываем draw-manager
    if (this.currentOptions.autoRender) {
      const shotResult = shotManager.getShotResult(uid);
      if (shotResult && game.spaceholder?.drawManager) {
        game.spaceholder.drawManager.drawShot(shotResult);
        console.log('AimingManager: Shot rendered via drawManager');
      } else if (!game.spaceholder?.drawManager) {
        console.warn('AimingManager: drawManager not available');
      }
    }
    
    // Не останавливаем прицеливание автоматически - пользователь может продолжить
  }
  
  /**
   * Привязать события
   * @private
   */
  _bindEvents() {
    canvas.stage.on('mousemove', this._boundEvents.onMouseMove);
    canvas.stage.on('mousedown', this._boundEvents.onMouseDown);
    document.addEventListener('contextmenu', this._boundEvents.onContextMenu);
    document.addEventListener('keydown', this._boundEvents.onKeyDown);
  }
  
  /**
   * Отвязать события
   * @private
   */
  _unbindEvents() {
    canvas.stage.off('mousemove', this._boundEvents.onMouseMove);
    canvas.stage.off('mousedown', this._boundEvents.onMouseDown);
    document.removeEventListener('contextmenu', this._boundEvents.onContextMenu);
    document.removeEventListener('keydown', this._boundEvents.onKeyDown);
  }
  
  /**
   * Обработчик движения мыши
   * @private
   */
  _onMouseMove(event) {
    if (!this.isAiming) return;
    this._updatePointer();
  }
  
  /**
   * Обработчик нажатия мыши
   * @private
   */
  _onMouseDown(event) {
    if (!this.isAiming) return;
    
    if (event.data.button === 0) { // ЛКМ
      event.stopPropagation();
      this._fire();
    }
  }
  
  /**
   * Обработчик правого клика
   * @private
   */
  _onContextMenu(event) {
    if (!this.isAiming) return;
    
    event.preventDefault();
    this.stopAiming();
  }
  
  /**
   * Обработчик нажатия клавиш
   * @private
   */
  _onKeyDown(event) {
    if (!this.isAiming) return;
    
    if (event.code === 'Escape') {
      event.preventDefault();
      this.stopAiming();
    }
  }
}

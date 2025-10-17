// Aiming System for SpaceHolder - основная система прицеливания с лучами
// Интегрируется с существующими TokenPointer и TokenRotator системами

import { RayCaster } from './ray-casting.mjs';
import { RayRenderer } from './ray-renderer.mjs';

export class AimingSystem {
  constructor(onAimComplete = null) {
    // Коллбэк для обработки результата прицеливания
    this.onAimComplete = onAimComplete;
    
    // Состояние системы
    this.isAiming = false;
    this.aimingToken = null;
    this.currentAimDirection = 0; // в градусах
    this.currentRay = null;
    
    // Конфигурация по умолчанию (только для прицеливания)
    this.config = {
      aimingSensitivity: 1.0, // чувствительность поворота прицела
      showAimingReticle: true, // показывать ли прицельную сетку
      
      // Механика лучей (только предпросмотр)
      previewRayLength: 500, // длина луча предпросмотра при прицеливании
      
      // Производительность предпросмотра
      previewUpdateRate: 60, // частота обновления предпросмотра (FPS)
    };
    
    // Компоненты системы (только для прицеливания)
    this.rayCaster = new RayCaster({ aimingSystem: this });
    this.rayRenderer = new RayRenderer(this);
    
    // Привязки событий
    this._boundEvents = {
      onMouseMove: this._onMouseMove.bind(this),
      onKeyDown: this._onKeyDown.bind(this),
      onKeyUp: this._onKeyUp.bind(this),
      onMouseDown: this._onMouseDown.bind(this),
      onContextMenu: this._onContextMenu.bind(this)
    };
    
    // Троттлинг для обновления предпросмотра
    this._lastPreviewUpdate = 0;
    this._previewUpdateInterval = 1000 / this.config.previewUpdateRate; // интервал в мс
  }
  
  /**
   * Инициализация системы прицеливания
   */
  initialize() {
    console.log('SpaceHolder | AimingSystem: Initializing aiming system');
    
    // Регистрируем настройки
    this._registerSettings();
    
    // Инициализируем компоненты
    this.rayCaster.initialize();
    this.rayRenderer.initialize();
  }
  
  /**
   * Начать прицеливание для указанного токена
   * @param {Token} token - токен, который начинает прицеливание
   * @param {Object} weapon - оружие или способность для атаки (опционально)
   */
  startAiming(token, weapon = null) {
    if (!token || !token.isOwner) {
      ui.notifications.warn("Вы не можете управлять этим токеном");
      return false;
    }
    
    if (this.isAiming) {
      this.stopAiming();
    }
    
    console.log('SpaceHolder | AimingSystem: Starting aiming for token', token.name);
    
    this.isAiming = true;
    this.aimingToken = token;
    this.weapon = weapon;
    
    // Получаем начальное направление от TokenPointer или устанавливаем 0
    this.currentAimDirection = token.document.getFlag('spaceholder', 'tokenpointerDirection') ?? 0;
    
    // Показываем UI прицеливания
    this._showAimingUI();
    
    // Привязываем события
    this._bindEvents();
    
    // Создаем начальный короткий луч для предпросмотра
    this._updateAimingPreview();
    
    // Уведомляем других игроков
    this._notifyAimingStart();
    
    return true;
  }
  
  /**
   * Прекратить прицеливание
   */
  stopAiming() {
    if (!this.isAiming) return;
    
    this.isAiming = false;
    this.aimingToken = null;
    this.weapon = null;
    
    // Скрываем UI
    this._hideAimingUI();
    
    // Убираем привязки событий
    this._unbindEvents();
    
    // Очищаем визуализацию луча
    this.rayRenderer.clearRay();
    
    // Уведомляем о завершении прицеливания
    this._notifyAimingEnd();
  }
  
  /**
   * Завершить прицеливание и вернуть результат
   * @returns {Object|null} Результат прицеливания или null если не активно
   */
  aim() {
    if (!this.isAiming || !this.aimingToken) {
      ui.notifications.warn("Прицеливание не активно");
      return null;
    }
    
    const aimResult = {
      token: this.aimingToken,
      source: this.aimingToken.center,
      direction: this.currentAimDirection,
      weapon: this.weapon,
      timestamp: Date.now()
    };
    
    // Завершаем прицеливание
    this.stopAiming();
    
    return aimResult;
  }
  
  /**
   * Обновить предпросмотр прицеливания (короткий луч)
   */
  _updateAimingPreview() {
    if (!this.isAiming || !this.aimingToken) return;
    
    // Троттлинг для оптимизации производительности
    const now = Date.now();
    if (now - this._lastPreviewUpdate < this._previewUpdateInterval) {
      return;
    }
    this._lastPreviewUpdate = now;
    
    // Создаем короткий луч для предпросмотра (без проверки коллизий)
    const previewRay = this.rayCaster.createSimpleRay(
      this.aimingToken.center,
      this.currentAimDirection,
      this.config.previewRayLength
    );
    
    this.currentPreviewRay = previewRay;
    
    // Обновляем визуализацию предпросмотра
    this.rayRenderer.updateAimingPreview(previewRay);
  }
  
  
  /**
   * Показать UI прицеливания
   */
  _showAimingUI() {
    // Изменяем курсор
    document.body.style.cursor = 'crosshair';
    
    // Показываем прицельную сетку, если включена
    if (this.config.showAimingReticle) {
      this.rayRenderer.showAimingReticle(this.aimingToken);
    }
    
    // Показываем информационную панель
    this._showAimingInfo();
  }
  
  /**
   * Скрыть UI прицеливания
   */
  _hideAimingUI() {
    // Возвращаем курсор
    document.body.style.cursor = '';
    
    // Скрываем прицельную сетку
    this.rayRenderer.hideAimingReticle();
    
    // Скрываем информационную панель
    this._hideAimingInfo();
  }
  
  /**
   * Показать информационную панель с инструкциями
   */
  _showAimingInfo() {
    const info = document.createElement('div');
    info.id = 'aiming-info';
    info.className = 'aiming-info-panel';
    info.innerHTML = `
      <div class="aiming-instructions">
        <h3>Режим прицеливания</h3>
        <p>🎯 Поворачивайте мышь для наведения</p>
        <p>✅ ЛКМ - подтвердить прицел</p>
        <p>🚫 ПКМ или ESC - отменить</p>
      </div>
    `;
    
    document.body.appendChild(info);
  }
  
  /**
   * Скрыть информационную панель
   */
  _hideAimingInfo() {
    const info = document.getElementById('aiming-info');
    if (info) info.remove();
  }
  
  /**
   * Привязать события
   */
  _bindEvents() {
    canvas.stage.on('mousemove', this._boundEvents.onMouseMove);
    document.addEventListener('keydown', this._boundEvents.onKeyDown);
    document.addEventListener('keyup', this._boundEvents.onKeyUp);
    canvas.stage.on('mousedown', this._boundEvents.onMouseDown);
    document.addEventListener('contextmenu', this._boundEvents.onContextMenu);
  }
  
  /**
   * Убрать привязки событий
   */
  _unbindEvents() {
    canvas.stage.off('mousemove', this._boundEvents.onMouseMove);
    document.removeEventListener('keydown', this._boundEvents.onKeyDown);
    document.removeEventListener('keyup', this._boundEvents.onKeyUp);
    canvas.stage.off('mousedown', this._boundEvents.onMouseDown);
    document.removeEventListener('contextmenu', this._boundEvents.onContextMenu);
  }
  
  /**
   * Обработка движения мыши
   */
  _onMouseMove(event) {
    if (!this.isAiming || !this.aimingToken) return;
    
    const mousePos = canvas.mousePosition;
    const tokenCenter = this.aimingToken.center;
    
    // Вычисляем угол от центра токена до курсора мыши
    const dx = mousePos.x - tokenCenter.x;
    const dy = mousePos.y - tokenCenter.y;
    
    // Конвертируем в градусы (0° = вправо, 90° = вниз)
    // Убрали чувствительность - прицеливаемся прямо в курсор
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);
    
    // Обновляем направление прицеливания
    this.currentAimDirection = angle;
    
    // Обновляем предпросмотр (только короткий луч)
    this._updateAimingPreview();
  }
  
  /**
   * Обработка нажатия клавиш
   */
  _onKeyDown(event) {
    if (!this.isAiming) return;
    
    switch (event.code) {
      case 'Escape':
        event.preventDefault();
        this.stopAiming();
        break;
    }
  }
  
  /**
   * Обработка отпускания клавиш
   */
  _onKeyUp(event) {
    // Пока не используется, но может пригодиться для модификаторов
  }
  
  /**
   * Обработка кликов мыши
   */
  _onMouseDown(event) {
    if (!this.isAiming) return;
    
    if (event.button === 0) { // ЛКМ
      event.preventDefault();
      // Возвращаем результат прицеливания через коллбэк
      const aimResult = this.aim();
      if (aimResult && this.onAimComplete) {
        this.onAimComplete(aimResult);
      }
    }
  }
  
  /**
   * Обработка правого клика (отмена)
   */
  _onContextMenu(event) {
    if (!this.isAiming) return;
    
    event.preventDefault();
    this.stopAiming();
  }
  
  
  /**
   * Уведомление о начале прицеливания
   */
  _notifyAimingStart() {
    // Можно добавить сокет-уведомления для мультиплеера
  }
  
  /**
   * Уведомление о завершении прицеливания
   */
  _notifyAimingEnd() {
    // Можно добавить сокет-уведомления для мультиплеера
  }
  
  /**
   * Регистрация настроек системы прицеливания
   */
  _registerSettings() {
    const MODULE_NS = 'spaceholder';
    const PREF = 'aimingsystem';
    
    game.settings.register(MODULE_NS, `${PREF}.showAimingReticle`, {
      name: 'Показывать прицельную сетку',
      hint: 'Отображать визуальную прицельную сетку во время прицеливания',
      scope: 'client',
      config: false,
      default: true,
      type: Boolean,
    });
    
    game.settings.register(MODULE_NS, `${PREF}.aimingSensitivity`, {
      name: 'Чувствительность прицеливания',
      hint: 'Чувствительность поворота прицела',
      scope: 'client',
      config: false,
      default: 1.0,
      type: Number,
    });
    
    game.settings.register(MODULE_NS, `${PREF}.previewRayLength`, {
      name: 'Длина луча предпросмотра',
      hint: 'Длина зеленого луча при прицеливании (пиксели)',
      scope: 'world',
      config: false,
      default: 500,
      type: Number
    });
    
    game.settings.register(MODULE_NS, `${PREF}.previewUpdateRate`, {
      name: 'Частота обновления предпросмотра',
      hint: 'Количество обновлений луча предпросмотра в секунду (FPS)',
      scope: 'client',
      config: false,
      default: 60,
      type: Number,
      choices: {
        30: '30 FPS (экономия энергии)',
        60: '60 FPS (стандарт)',
        120: '120 FPS (высокая точность)'
      }
    });
  }
  
  /**
   * Получить настройку
   */
  getSetting(key) {
    return game.settings.get('spaceholder', `aimingsystem.${key}`);
  }
}

// Регистрация настроек системы прицеливания
export function registerAimingSystemSettings() {
  // Настройки будут зарегистрированы в конструкторе AimingSystem
}

// Установка хуков для системы прицеливания
export function installAimingSystemHooks() {
  // Хук для интеграции с системой атак
  Hooks.on('preItemRoll', (item, rollConfig) => {
    // Проверяем, хотим ли мы использовать систему прицеливания для этого предмета
    if (item.type === 'item' && item.actor?.getActiveTokens()?.[0]) {
      const token = item.actor.getActiveTokens()[0];
      const aimingSystem = game.spaceholder?.aimingSystem;
      
      if (aimingSystem && game.keyboard.isModifierActive('alt')) {
        // Alt + клик = прицеливание вместо обычной атаки
        aimingSystem.startAiming(token, item);
        return false; // Отменяем обычный ролл
      }
    }
  });
  
  // Хук на готовность холста
  Hooks.on('canvasReady', () => {
    const aimingSystem = game.spaceholder?.aimingSystem;
    if (aimingSystem) {
      aimingSystem.rayRenderer.onCanvasReady();
    }
  });
}
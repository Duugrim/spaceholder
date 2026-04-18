/**
 * Aiming Manager - модульная система прицеливания
 * Управляет процессом прицеливания и создаёт выстрелы через shot-manager
 */
import { setForcedAimingArcOverlay } from './aiming-arc-overlay.mjs';

let _payloadLibraryCache = null;

function _normalizeAimingType(typeRaw) {
  const type = String(typeRaw ?? 'simple').trim().toLowerCase();
  return type === 'standard' ? 'standard' : 'simple';
}

function _normalizeAngleDeltaDeg(a, b) {
  let delta = Math.abs(Number(a) - Number(b));
  while (delta > 360) delta -= 360;
  if (delta > 180) delta = 360 - delta;
  return delta;
}

function _resolveAimingArcConfig(actor) {
  const cfg = CONFIG?.SPACEHOLDER?.aimingArc ?? {};
  const defaults = Array.isArray(cfg.defaultZoneHalfDegrees) ? cfg.defaultZoneHalfDegrees : [1, 5, 15, 25, 30];
  const maxHalf = Math.max(1, Number(cfg.maxHalfAngleDeg) || 90);
  const src = actor?.system?.aimingArc?.zoneHalfDegrees;
  const raw = Array.isArray(src) ? src : defaults;
  const zones = [];
  let remaining = maxHalf;
  for (let i = 0; i < 5; i += 1) {
    const n = Number(raw[i] ?? defaults[i] ?? 0);
    const safe = Number.isFinite(n) ? Math.max(0, n) : 0;
    const clipped = Math.min(remaining, safe);
    zones.push(clipped);
    remaining = Math.max(0, remaining - clipped);
  }
  const baseDevRaw = Number(actor?.system?.aimingArc?.deviationBaseDeg);
  const defaultBase = Math.max(0, Number(cfg.defaultDeviationBaseDeg) || 1);
  const deviationBaseDeg = Number.isFinite(baseDevRaw) ? Math.max(0, baseDevRaw) : defaultBase;
  const multipliers = Array.isArray(cfg.deviationMultipliers) ? cfg.deviationMultipliers : [0, 0, 1, 2, 4];
  return { zones, deviationBaseDeg, multipliers };
}

function _resolveAimingArcZoneIndex(deltaDeg, zones) {
  const safeDelta = Math.max(0, Number(deltaDeg) || 0);
  let cursor = 0;
  for (let i = 0; i < zones.length; i += 1) {
    cursor += Math.max(0, Number(zones[i]) || 0);
    if (safeDelta <= cursor) return i;
  }
  return zones.length - 1;
}

function _zoneKeyByIndex(zoneIndex) {
  switch (Number(zoneIndex)) {
    case 0: return 'SPACEHOLDER.AimingArc.Zones.Purple';
    case 1: return 'SPACEHOLDER.AimingArc.Zones.Green';
    case 2: return 'SPACEHOLDER.AimingArc.Zones.Yellow';
    case 3: return 'SPACEHOLDER.AimingArc.Zones.Orange';
    default: return 'SPACEHOLDER.AimingArc.Zones.Red';
  }
}

function _applyStandardAimingDeviation(token, baseDirectionDeg) {
  const { zones, deviationBaseDeg, multipliers } = _resolveAimingArcConfig(token?.actor);
  const pointerDeg = Number(token?.document?.getFlag?.('spaceholder', 'tokenpointerDirection') ?? 90);
  const deltaFromPointer = _normalizeAngleDeltaDeg(baseDirectionDeg, pointerDeg);
  const zoneIndex = _resolveAimingArcZoneIndex(deltaFromPointer, zones);
  const multiplier = Math.max(0, Number(multipliers[zoneIndex] ?? 0));
  const randomOffset = (!deviationBaseDeg || !multiplier)
    ? 0
    : (Math.random() * 2 - 1) * deviationBaseDeg * multiplier;
  const zoneLabel = game.i18n?.localize?.(_zoneKeyByIndex(zoneIndex)) ?? String(zoneIndex);
  return {
    direction: baseDirectionDeg + randomOffset,
    zoneIndex,
    zoneLabel,
    deviationDeg: randomOffset,
  };
}

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

  _normalizePayloadId(id) {
    return String(id ?? '').trim().toLowerCase();
  }

  /**
   * Получить кэшированную библиотеку payload.
   * Возвращает глубокую копию, чтобы UI/действия не мутировали кэш.
   * @returns {Promise<Array<object>>}
   */
  async getPayloadLibrary() {
    if (!_payloadLibraryCache) {
      _payloadLibraryCache = await this._loadPayloads();
    }
    return foundry.utils.deepClone(_payloadLibraryCache || []);
  }

  /**
   * Найти payload по id из библиотеки.
   * @param {string} payloadId
   * @returns {Promise<object|null>}
   */
  async getPayloadById(payloadId) {
    const wanted = this._normalizePayloadId(payloadId);
    if (!wanted) return null;
    const library = await this.getPayloadLibrary();
    const found = library.find((p) => this._normalizePayloadId(p?.id) === wanted);
    return found || null;
  }

  /**
   * Программный старт прицеливания из action-service.
   * @param {object} cfg
   * @returns {Promise<boolean>}
   */
  async startAimingFromActionConfig(cfg = {}) {
    const token = cfg?.token ?? null;
    if (!token) return false;
    const payloadId = String(cfg?.payloadId ?? '').trim();
    if (!payloadId) return false;
    const payload = await this.getPayloadById(payloadId);
    if (!payload) return false;

    const options = {
      type: _normalizeAimingType(cfg?.aimingType),
      autoRender: cfg?.autoRender !== false,
      damage: Math.max(0, Number(cfg?.damage) || 0),
      actorUuid: String(cfg?.actor?.uuid ?? token?.actor?.uuid ?? '').trim() || null,
      itemUuid: String(cfg?.item?.uuid ?? '').trim() || null,
      actionName: String(cfg?.actionName ?? '').trim() || null,
    };

    this.startAiming(token, payload, options);
    return true;
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
    const payloads = await this.getPayloadLibrary();
    
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
            <option value="simple">${game.i18n.localize('SPACEHOLDER.AimingManager.AimingType.Simple')}</option>
            <option value="standard">${game.i18n.localize('SPACEHOLDER.AimingManager.AimingType.Standard')}</option>
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
      classes: ['spaceholder'],
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
            const aimingType = _normalizeAimingType(root.querySelector('#aiming-type')?.value || 'simple');
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
    const aimingType = _normalizeAimingType(options?.type);
    if (aimingType === 'standard') {
      setForcedAimingArcOverlay(token, true);
    }
    if (aimingType === 'simple' || aimingType === 'standard') {
      this._startSimpleAiming();
    }
  }
  
  /**
   * Остановить прицеливание
   */
  stopAiming() {
    if (!this.isAiming) return;
    
    console.log('AimingManager: Stopping aiming');
    const currentToken = this.currentToken;
    const aimingType = _normalizeAimingType(this.currentOptions?.type);
    
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

    if (aimingType === 'standard' && currentToken) {
      setForcedAimingArcOverlay(currentToken, false);
    }
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
  async _fire() {
    if (!this.isAiming || !this.currentToken || !this.currentPayload) return;
    
    // Получаем глобальный shotManager
    const shotManager = game.spaceholder?.shotManager;
    if (!shotManager) {
      console.error('AimingManager: Global shotManager not initialized');
      return;
    }
    
    const baseDirection = this._getCurrentDirection();
    const aimingType = _normalizeAimingType(this.currentOptions?.type);
    const standardInfo = aimingType === 'standard'
      ? _applyStandardAimingDeviation(this.currentToken, baseDirection)
      : null;
    const direction = standardInfo?.direction ?? baseDirection;
    
    console.log('AimingManager: Firing with direction', direction);
    
    // Создаём выстрел через глобальный shot-manager
    const uid = shotManager.createShot(
      this.currentToken,
      this.currentPayload,
      direction
    );
    
    console.log('AimingManager: Shot created with UID', uid);

    if (standardInfo) {
      const deviationRounded = Math.round((standardInfo.deviationDeg || 0) * 100) / 100;
      const message = game.i18n?.format?.('SPACEHOLDER.AimingManager.Messages.StandardShotInfo', {
        zone: String(standardInfo.zoneLabel ?? ''),
        deviation: String(deviationRounded),
      }) || `Standard aiming: zone=${standardInfo.zoneLabel}, deviation=${deviationRounded}`;
      try {
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: this.currentToken?.actor ?? null }),
          content: `<div>${foundry.utils.escapeHTML(message)}</div>`,
        });
      } catch (_) {
        /* ignore chat errors */
      }
    }
    
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

    await this._applyFirstTokenHitDamage(uid);
    
    // Не останавливаем прицеливание автоматически - пользователь может продолжить
  }

  /**
   * Применить урон первой задетой цели в случайную часть тела.
   * @private
   * @param {string} shotUid
   */
  async _applyFirstTokenHitDamage(shotUid) {
    const shotManager = game.spaceholder?.shotManager;
    if (!shotManager || !shotUid) return;
    const shotResult = shotManager.getShotResult(shotUid);
    const hits = Array.isArray(shotResult?.shotHits) ? shotResult.shotHits : [];
    const firstTokenHit = hits.find((h) => h?.type === 'token' && h?.object?.actor);
    if (!firstTokenHit) return;

    const targetToken = firstTokenHit.object;
    const targetActor = targetToken?.actor ?? null;
    if (!targetActor) return;

    const bodyParts = targetActor.system?.health?.bodyParts ?? {};
    const bodyPartIds = Object.keys(bodyParts);
    if (!bodyPartIds.length) return;

    const randomIdx = Math.floor(Math.random() * bodyPartIds.length);
    const partId = bodyPartIds[randomIdx];
    const partName = String(bodyParts?.[partId]?.name ?? partId);
    const damage = Math.max(0, Number(this.currentOptions?.damage) || 0);
    if (!damage) return;

    if (typeof targetActor.applyBodyPartDamage !== 'function') return;
    const applied = await targetActor.applyBodyPartDamage(partId, damage, 'pierce');
    if (!applied) return;

    const shooterName = String(this.currentToken?.name ?? '');
    const targetName = String(targetToken?.name ?? targetActor?.name ?? '');
    const content = game.i18n?.format?.('SPACEHOLDER.ActionsSystem.AimShot.HitApplied', {
      shooter: shooterName,
      target: targetName,
      part: partName,
      damage: String(damage),
    }) || `${shooterName} hits ${targetName} (${partName}) for ${damage}`;

    ui.notifications?.info?.(content);
    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this.currentToken?.actor ?? null }),
        content: `<div>${foundry.utils.escapeHTML(content)}</div>`,
      });
    } catch (_) {
      /* ignore chat errors */
    }
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
      void this._fire();
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

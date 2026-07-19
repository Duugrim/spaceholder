/**
 * Aiming Manager - модульная система прицеливания
 * Управляет процессом прицеливания и создаёт выстрелы через shot-manager
 */
import { setForcedAimingArcOverlay } from './aiming-arc-overlay.mjs';
import {
  AP_PER_SECOND,
  FIRE_MODES,
  applyErgonomicsToArcs,
  applyDamageModifiers,
  buildProjectileFromDamageEntries,
  resolveEffectiveAttackParams,
} from './weapon/weapon-model.mjs';
import {
  getWeaponData,
  persistWeaponData,
  consumeShotFromLine,
  preflightLineShotReadiness,
} from './weapon/weapon-ammo-runtime.mjs';
import { spendAp } from './actions/transaction-ledger.mjs';
import {
  normalizeTrajectoryKind,
  resolveWeaponLinePayload,
  TRAJECTORY_KINDS,
} from './weapon/trajectory.mjs';

let _payloadLibraryCache = null;

/** Canonical id inside straight-line.json (manifest filename uses hyphens). */
const DEFAULT_WEAPON_PAYLOAD_ID = 'straight_line';

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

function _resolveAimingArcConfig(actor, ergo = null) {
  const cfg = CONFIG?.SPACEHOLDER?.aimingArc ?? {};
  const standardZoneCount = Math.max(1, Number(cfg.standardZoneCount) || 4);
  const defaults = Array.isArray(cfg.defaultZoneWeights) ? cfg.defaultZoneWeights : [5, 15, 25, 30];
  const aimingArc = actor?.system?.aimingArc ?? {};
  const legacyZones = Array.isArray(aimingArc.zoneHalfDegrees) ? aimingArc.zoneHalfDegrees : [];
  const rawWeights = Array.isArray(aimingArc.zoneWeights) ? aimingArc.zoneWeights : [];
  const purpleRaw = Number(aimingArc.purpleZoneDeg);
  const defaultPurple = Math.max(0, Number(cfg.defaultPurpleZoneDeg) || 1);
  const legacyPurple = Number(legacyZones[0]);
  const purpleZoneDeg = Number.isFinite(purpleRaw)
    ? Math.max(0, purpleRaw)
    : (Number.isFinite(legacyPurple) ? Math.max(0, legacyPurple) : defaultPurple);
  const totalArcRaw = Number(aimingArc.totalArcDeg);
  const defaultTotalArc = Math.max(0, Number(cfg.defaultTotalArcDeg) || 90);
  const totalArcFromLegacy = legacyZones.slice(1).reduce((sum, val) => sum + Math.max(0, Number(val) || 0), 0);
  const totalArcDeg = Number.isFinite(totalArcRaw)
    ? Math.max(0, totalArcRaw)
    : (totalArcFromLegacy > 0 ? totalArcFromLegacy : defaultTotalArc);
  const weights = [];
  const weightOffset = rawWeights.length >= standardZoneCount + 1 ? 1 : 0;
  for (let i = 0; i < standardZoneCount; i += 1) {
    const n = Number(rawWeights[i + weightOffset] ?? legacyZones[i + 1] ?? defaults[i] ?? 0);
    weights.push(Number.isFinite(n) ? Math.max(0, n) : 0);
  }
  const deadRaw = Number(aimingArc.deadZoneDeg);
  const deadZoneDeg = Number.isFinite(deadRaw)
    ? Math.max(0, deadRaw)
    : Math.max(0, Number(cfg.defaultDeadZoneDeg) || 0);

  // Weapon ergonomics modify the character's base arcs (v3 refactor).
  const arcs = applyErgonomicsToArcs(
    { purpleZoneDeg, totalArcDeg, weights, deadZoneDeg },
    ergo
  );

  const weightSum = arcs.weights.reduce((sum, w) => sum + w, 0);
  const standardZones = [];
  for (let i = 0; i < standardZoneCount; i += 1) {
    const zone = weightSum > 0 ? (arcs.totalArcDeg * (arcs.weights[i] ?? 0)) / weightSum : 0;
    standardZones.push(Math.max(0, Number(zone) || 0));
  }
  const zones = [arcs.purpleZoneDeg, ...standardZones];
  const baseDevRaw = Number(actor?.system?.aimingArc?.deviationBaseDeg);
  const defaultBase = Math.max(0, Number(cfg.defaultDeviationBaseDeg) || 1);
  const deviationBaseDeg = (Number.isFinite(baseDevRaw) ? Math.max(0, baseDevRaw) : defaultBase) * arcs.aimPenaltyMult;
  const multipliers = Array.isArray(cfg.deviationMultipliers) ? cfg.deviationMultipliers : [0, 0, 1, 2, 4];
  return { zones, deviationBaseDeg, multipliers };
}

function _resolveAimingArcZoneIndex(deltaDeg, zones) {
  const safeDelta = Math.max(0, Number(deltaDeg) || 0);
  const safeZones = Array.isArray(zones)
    ? zones.map((zone) => Math.max(0, Number(zone) || 0))
    : [];
  const hasAnyZone = safeZones.some((zone) => zone > 0);
  if (!hasAnyZone) return 0;
  let cursor = 0;
  for (let i = 0; i < safeZones.length; i += 1) {
    cursor += safeZones[i];
    if (safeDelta <= cursor) return i;
  }
  return safeZones.length - 1;
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

function _applyStandardAimingDeviation(token, baseDirectionDeg, ergo = null) {
  const { zones, deviationBaseDeg, multipliers } = _resolveAimingArcConfig(token?.actor, ergo);
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
      onMouseUp: this._onMouseUp.bind(this),
      onContextMenu: this._onContextMenu.bind(this),
      onKeyDown: this._onKeyDown.bind(this)
    };

    // Авто-режим (v3): таймер серии, пока зажата ЛКМ.
    this._autoFireTimer = null;
    this._fireBusy = false;
  }

  _normalizePayloadId(id) {
    // Manifest/filenames use hyphens; payload `id` fields use underscores.
    return String(id ?? '').trim().toLowerCase().replace(/-/g, '_');
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
   * Старт прицеливания для атаки v3 (Линия × Режим). Вызывается из
   * attack-chain после исполнения цепочки подготовительных Действий.
   *
   * @param {object} args
   * @param {Token} args.token
   * @param {Actor|null} args.actor
   * @param {Item} args.weaponItem
   * @param {string} args.lineId
   * @param {string} args.modeId
   * @returns {Promise<boolean>}
   */
  async startWeaponV3Aiming({ token, actor, weaponItem, lineId, modeId } = {}) {
    if (!token || !weaponItem) return false;
    const weapon = getWeaponData(weaponItem);
    const eff = resolveEffectiveAttackParams(weapon, lineId, modeId);
    if (!eff) return false;

    const payload = await resolveWeaponLinePayload(
      eff.line,
      token,
      (id) => this.getPayloadById(id),
    );
    if (!payload) {
      console.warn('AimingManager: payload not found for v3 attack', {
        trajectoryKind: eff.line.trajectoryKind,
        payloadId: eff.line.payloadId,
        lineId,
        modeId,
        weapon: weaponItem?.name,
      });
      return false;
    }

    this.startAiming(token, payload, {
      type: 'standard',
      autoRender: true,
      actorUuid: String(actor?.uuid ?? token?.actor?.uuid ?? '').trim() || null,
      weaponItemUuid: String(weaponItem.uuid ?? '').trim() || null,
      weaponV3: { weaponItemUuid: weaponItem.uuid, lineId, modeId },
    });
    // Перерисовать дуги с учётом эргономики оружия (с модификаторами режима).
    setForcedAimingArcOverlay(token, true, eff.ergonomics);
    return true;
  }
  
  /**
   * Показать диалог настройки прицеливания
   * @param {Token} token - Токен, для которого настраивается прицеливание
   */
  async showAimingDialog(token) {
    const L = (key) => game.i18n?.localize?.(key) ?? key;
    if (!token) {
      ui.notifications.warn(L('SPACEHOLDER.AimingManager.Messages.TokenNotSelected'));
      return;
    }

    const payloads = await this.getPayloadLibrary();
    const payloadOptions = payloads
      .map((p) => `<option value="${foundry.utils.escapeHTML(p.id)}">${foundry.utils.escapeHTML(p.name ?? p.id)}</option>`)
      .join('');

    const ammoItems = this._collectAmmoItemsForToken(token);
    const ammoOptions = ammoItems
      .map((it) => {
        const qty = Number(it.system?.quantity ?? 0);
        const qtyLabel = Number.isFinite(qty) && qty > 1 ? ` (×${qty})` : '';
        return `<option value="${foundry.utils.escapeHTML(it.uuid)}">${foundry.utils.escapeHTML(it.name)}${qtyLabel}</option>`;
      })
      .join('');
    const noAmmo = ammoItems.length === 0;
    const ammoSelectInner = noAmmo
      ? `<option value="">${foundry.utils.escapeHTML(L('SPACEHOLDER.AimingManager.Dialog.NoAmmo'))}</option>`
      : ammoOptions;

    const content = `
      <div class="aiming-dialog">
        <div class="form-group">
          <label for="payload-select">${L('SPACEHOLDER.AimingManager.Dialog.SelectPayload')}</label>
          <select id="payload-select" style="width: 100%; padding: 6px; margin: 8px 0;">
            ${payloadOptions}
          </select>
        </div>
        <div class="form-group">
          <label for="aiming-type">${L('SPACEHOLDER.AimingManager.Dialog.AimingType')}</label>
          <select id="aiming-type" style="width: 100%; padding: 6px; margin: 8px 0;">
            <option value="simple">${L('SPACEHOLDER.AimingManager.AimingType.Simple')}</option>
            <option value="standard">${L('SPACEHOLDER.AimingManager.AimingType.Standard')}</option>
          </select>
        </div>
        <div class="form-group" style="margin: 12px 0;">
          <label style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" id="auto-render" checked>
            <span>${L('SPACEHOLDER.AimingManager.Dialog.AutoRender')}</span>
          </label>
        </div>
        <hr/>
        <div class="form-group" style="margin: 8px 0;">
          <label style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" id="use-ammo" ${noAmmo ? 'disabled' : ''}>
            <span>${L('SPACEHOLDER.AimingManager.Dialog.UseAmmo')}</span>
          </label>
        </div>
        <div class="form-group">
          <label for="ammo-select">${L('SPACEHOLDER.AimingManager.Dialog.SelectAmmo')}</label>
          <select id="ammo-select" style="width: 100%; padding: 6px; margin: 8px 0;" ${noAmmo ? 'disabled' : 'disabled'}>
            ${ammoSelectInner}
          </select>
        </div>
      </div>
    `;

    await foundry.applications.api.DialogV2.wait({
      classes: ['spaceholder'],
      window: { title: L('SPACEHOLDER.AimingManager.Dialog.Title'), icon: 'fa-solid fa-crosshairs' },
      position: { width: 400 },
      content: content,
      render: (_event, dialog) => {
        const root = dialog?.element ?? null;
        const useAmmo = root?.querySelector?.('#use-ammo');
        const ammoSelect = root?.querySelector?.('#ammo-select');
        if (useAmmo && ammoSelect) {
          useAmmo.addEventListener('change', () => {
            ammoSelect.disabled = !useAmmo.checked || noAmmo;
          });
        }
      },
      buttons: [
        {
          action: 'start',
          label: L('SPACEHOLDER.AimingManager.Buttons.Start'),
          icon: 'fa-solid fa-bullseye',
          default: true,
          callback: (event) => {
            const root = event.currentTarget;
            const payloadId = root.querySelector('#payload-select')?.value;
            const aimingType = _normalizeAimingType(root.querySelector('#aiming-type')?.value || 'simple');
            const autoRender = root.querySelector('#auto-render')?.checked ?? true;
            const useAmmoChecked = !!root.querySelector('#use-ammo')?.checked;
            const ammoUuid = String(root.querySelector('#ammo-select')?.value ?? '').trim();

            const payload = payloads.find((p) => p.id === payloadId);
            if (payload) {
              this.startAiming(token, payload, {
                type: aimingType,
                autoRender,
                useAmmo: useAmmoChecked && !!ammoUuid,
                ammoUuid: useAmmoChecked ? ammoUuid : '',
              });
            }
          }
        },
        {
          action: 'cancel',
          label: L('SPACEHOLDER.AimingManager.Buttons.Cancel'),
          icon: 'fa-solid fa-times'
        }
      ]
    });
  }

  /**
   * Собрать предметы-боеприпасы из инвентаря актора, привязанного к токену.
   * Возвращает массив отсортированных по имени items с `system.itemTags.isAmmo === true`.
   * @param {Token} token
   * @returns {Item[]}
   * @private
   */
  _collectAmmoItemsForToken(token) {
    const actor = token?.actor ?? null;
    if (!actor || !actor.items) return [];
    const out = [];
    for (const it of actor.items) {
      if (it?.type !== 'item') continue;
      if (!it?.system?.itemTags?.isAmmo) continue;
      out.push(it);
    }
    out.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
    return out;
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
    this._stopAutoFire();
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
    
    ui.notifications.info(game.i18n?.localize?.('SPACEHOLDER.AimingManager.Messages.AimingActivated')
      ?? 'Aiming mode activated. LMB - shoot, RMB/ESC - cancel');
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

    // v3: атака Линия × Режим со своим расходом ОД/боеприпасов и режимами огня.
    if (this.currentOptions?.weaponV3) {
      await this._fireWeaponV3();
      return;
    }
    
    const payload = this.currentPayload;
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
      payload,
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

    if (this.currentOptions?.useAmmo && this.currentOptions?.ammoUuid) {
      await this._applyAmmoDamage(uid);
    } else {
      await this._applyFirstTokenHitDamage(uid);
    }
    
    // Не останавливаем прицеливание автоматически - пользователь может продолжить
  }

  /**
   * Атака v3 по нажатию ЛКМ: одиночный / очередь X / авто (пока зажата ЛКМ).
   * @private
   */
  async _fireWeaponV3() {
    if (this._fireBusy || this._autoFireTimer) return;
    const ctx = await this._resolveWeaponV3Context();
    if (!ctx) return;

    const fireMode = ctx.eff.mode.fireMode;
    if (fireMode === FIRE_MODES.AUTO) {
      const delayMs = Math.max(60, (ctx.eff.mode.fireDelayAp / AP_PER_SECOND) * 1000);
      const first = await this._fireWeaponV3Single({ first: true });
      if (!first) return;
      this._autoFireTimer = setInterval(() => {
        if (this._fireBusy) return;
        void this._fireWeaponV3Single({ first: false }).then((cont) => {
          if (!cont) this._stopAutoFire();
        });
      }, delayMs);
      return;
    }

    const count = fireMode === FIRE_MODES.BURST ? Math.max(2, ctx.eff.mode.burstCount) : 1;
    for (let i = 0; i < count; i += 1) {
      const ok = await this._fireWeaponV3Single({ first: i === 0 });
      if (!ok) break;
    }
  }

  _stopAutoFire() {
    if (this._autoFireTimer) {
      clearInterval(this._autoFireTimer);
      this._autoFireTimer = null;
    }
  }

  /**
   * Резолв контекста v3-атаки из currentOptions.
   * @private
   * @returns {Promise<{weaponItem: Item, weapon: object, eff: object, lineId: string, modeId: string}|null>}
   */
  async _resolveWeaponV3Context() {
    const cfg = this.currentOptions?.weaponV3;
    if (!cfg) return null;
    let weaponItem = null;
    try {
      weaponItem = await fromUuid(String(cfg.weaponItemUuid ?? ''));
    } catch (_) {
      weaponItem = null;
    }
    if (!weaponItem) {
      ui.notifications?.warn?.(
        game.i18n?.format?.('SPACEHOLDER.AimingManager.Messages.WeaponNotFound', { uuid: String(cfg.weaponItemUuid ?? '') }) ??
        `Weapon not found: ${cfg.weaponItemUuid}`
      );
      return null;
    }
    const weapon = getWeaponData(weaponItem);
    const eff = resolveEffectiveAttackParams(weapon, cfg.lineId, cfg.modeId);
    if (!eff) return null;
    return { weaponItem, weapon, eff, lineId: cfg.lineId, modeId: cfg.modeId };
  }

  /**
   * Один выстрел v3: трата ОД, расход боеприпаса по всем блокам линии,
   * отклонение по дугам + независимый Разброс линии, создание снаряда.
   *
   * Стоимость первого выстрела серии — Прицеливание + Спуск линии;
   * последующих — задержка режима (Скорострельность, 10 ОД = 1 с).
   *
   * @private
   * @param {{first: boolean}} args
   * @returns {Promise<boolean>} продолжать ли серию
   */
  async _fireWeaponV3Single({ first = true } = {}) {
    if (!this.isAiming || !this.currentToken) return false;
    this._fireBusy = true;
    try {
      const ctx = await this._resolveWeaponV3Context();
      if (!ctx) return false;
      const { weaponItem, weapon, eff, lineId, modeId } = ctx;
      const actor = this.currentToken?.actor ?? null;

      const preflight = await preflightLineShotReadiness(actor, weapon, lineId);
      if (!preflight.ready) {
        const key = preflight.reason === 'needBolt'
          ? 'SPACEHOLDER.WeaponV3.Ammo.NeedBolt'
          : 'SPACEHOLDER.WeaponV3.Ammo.NoAmmoForShot';
        ui.notifications?.warn?.(game.i18n?.localize?.(key) ?? key);
        return false;
      }

      // --- ОД ---------------------------------------------------------
      const cost = first
        ? Math.max(0, eff.line.aiming) + Math.max(0, eff.line.trigger)
        : Math.max(0, eff.mode.fireDelayAp);
      const apCost = Math.ceil(cost);
      if (apCost > 0 && actor?.type === 'character') {
        let spend = null;
        try {
          spend = await spendAp(actor, apCost, {
            source: { type: 'action', actionId: 'weaponV3.shot', label: weaponItem.name },
          });
        } catch (e) {
          ui.notifications?.warn?.(String(e?.message || e));
          return false;
        }
        if (!spend?.ok) {
          ui.notifications?.warn?.(spend?.error ?? 'AP spend failed');
          return false;
        }
      }

      // --- Боеприпас (все блоки линии) ----------------------------------
      const consumed = await consumeShotFromLine({ actor, weapon, weaponItem, lineId, modeId });
      if (!consumed.ok) {
        const key = consumed.reason === 'needBolt'
          ? 'SPACEHOLDER.WeaponV3.Ammo.NeedBolt'
          : 'SPACEHOLDER.WeaponV3.Ammo.NoAmmoForShot';
        ui.notifications?.warn?.(game.i18n?.localize?.(key) ?? key);
        return false;
      }
      await persistWeaponData(weaponItem, weapon);

      // --- Снаряд: модификаторы урона + множитель энергии ----------------
      const entries = applyDamageModifiers(consumed.damageEntries, eff.damageMods, eff.line.energyMult);
      const projectile = buildProjectileFromDamageEntries(entries, { payloadId: consumed.payloadId });

      let payload = this.currentPayload;
      const wantedPayloadId = String(projectile?.payloadId ?? consumed.payloadId ?? '').trim();
      const lineUsesSimple = normalizeTrajectoryKind(eff.line.trajectoryKind) === TRAJECTORY_KINDS.SIMPLE;
      if (lineUsesSimple && !wantedPayloadId) {
        payload = await resolveWeaponLinePayload(
          eff.line,
          this.currentToken,
          (id) => this.getPayloadById(id),
        );
      } else if (wantedPayloadId && this._normalizePayloadId(wantedPayloadId) !== this._normalizePayloadId(payload?.id)) {
        payload = await this.getPayloadById(wantedPayloadId) ?? payload;
      }

      // --- Направление: дуги (с эргономикой) + независимый Разброс -------
      const baseDirection = this._getCurrentDirection();
      const standardInfo = _applyStandardAimingDeviation(this.currentToken, baseDirection, eff.ergonomics);
      let direction = standardInfo.direction;
      if (eff.line.spread?.enabled && eff.line.spread.value > 0) {
        // Разброс НЕ суммируется с отклонением дуг — независимый random.
        direction += (Math.random() * 2 - 1) * eff.line.spread.value;
      }

      const shotManager = game.spaceholder?.shotManager;
      const uid = shotManager.createShot(this.currentToken, payload, direction);

      if (this.currentOptions?.autoRender) {
        const shotResult = shotManager.getShotResult(uid);
        if (shotResult && game.spaceholder?.drawManager) {
          game.spaceholder.drawManager.drawShot(shotResult);
        }
      }

      if (projectile) {
        const firstRound = consumed.rounds.find((r) => r.round)?.round ?? null;
        await this._applyResolvedProjectileDamage(uid, {
          projectile,
          weaponItem,
          ammoItem: firstRound,
          builderContext: {
            shooterActorUuid: actor?.uuid ?? null,
            weaponItemUuid: weaponItem.uuid,
            weaponName: weaponItem.name,
            ammoName: firstRound?.name ?? null,
          },
        });
      }

      // Камера осталась пустой без автоподачи → серия прерывается затвором.
      if (consumed.needsBolt) return false;
      return true;
    } finally {
      this._fireBusy = false;
    }
  }

  async _applyResolvedProjectileDamage(shotUid, shotContext = {}) {
    const shotManager = game.spaceholder?.shotManager;
    if (!shotManager || !shotUid || !shotContext?.projectile) return;
    const shot = shotManager.shotSystem?.getShot?.(shotUid);
    if (!shot) return;

    const builderContext = {
      ...(shotContext.builderContext ?? {}),
      shooterActorUuid: this.currentToken?.actor?.uuid ?? shotContext.builderContext?.shooterActorUuid ?? null,
      weaponItemUuid: shotContext.weaponItem?.uuid ?? shotContext.builderContext?.weaponItemUuid ?? null,
      ammoItemUuid: shotContext.ammoItem?.sourceUuid ?? shotContext.builderContext?.ammoItemUuid ?? null,
      weaponName: shotContext.weaponItem?.name ?? shotContext.builderContext?.weaponName ?? null,
      ammoName: shotContext.ammoItem?.name ?? shotContext.builderContext?.ammoName ?? null,
    };
    const results = await shotManager.applyImpactsToActors(shot, shotContext.projectile, {
      builderContext,
      source: {
        attackerUuid: this.currentToken?.actor?.uuid ?? null,
        attackerName: this.currentToken?.actor?.name ?? this.currentToken?.name ?? null,
        weaponUuid: shotContext.weaponItem?.uuid ?? null,
        weaponName: shotContext.weaponItem?.name ?? null,
        ammoUuid: shotContext.ammoItem?.sourceUuid ?? null,
        ammoName: shotContext.ammoItem?.name ?? null,
        verbKey: 'fire',
        shotUid,
      },
    });

    const shooterName = String(this.currentToken?.name ?? '');
    const weaponName = String(shotContext.weaponItem?.name ?? '');
    const ammoName = String(shotContext.ammoItem?.name ?? '');
    const count = Array.isArray(results) ? results.length : 0;
    const content = game.i18n?.format?.('SPACEHOLDER.AimingManager.Messages.ProjectileShotResolved', {
      shooter: shooterName,
      weapon: weaponName,
      ammo: ammoName,
      hits: String(count),
    }) || `${shooterName} fires ${weaponName} (${ammoName}); impacts: ${count}`;
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
   * Применить урон выбранного боеприпаса ко всем актёрам, попавшим под выстрел,
   * через damage-resolver / armour pipeline.
   * @private
   * @param {string} shotUid
   */
  async _applyAmmoDamage(shotUid) {
    const shotManager = game.spaceholder?.shotManager;
    if (!shotManager || !shotUid) return;
    const shot = shotManager.shotSystem?.getShot?.(shotUid);
    if (!shot) return;

    const ammoUuid = String(this.currentOptions?.ammoUuid ?? '').trim();
    if (!ammoUuid) return;
    let ammoItem = null;
    try {
      ammoItem = await fromUuid(ammoUuid);
    } catch (_) {
      ammoItem = null;
    }
    if (!ammoItem) {
      ui.notifications?.warn?.(`Ammo not found: ${ammoUuid}`);
      return;
    }

    const projectile = ammoItem?.system?.weapon?.ammo?.projectile;
    if (!projectile || typeof projectile !== 'object') {
      ui.notifications?.warn?.(`Item "${ammoItem.name}" has no ammo projectile`);
      return;
    }

    const hits = Array.isArray(shot?.actualHits) ? shot.actualHits : [];
    if (!hits.length) return;

    // Pick a random body slot per actor hit (debug behaviour matches the
    // legacy single-hit fallback). Using a Set per actor would also be valid
    // but we want to demonstrate per-hit randomness.
    const tokenHits = hits.filter((h) => h?.object?.actor);
    if (!tokenHits.length) return;

    const builderContext = {
      shooterActorUuid: this.currentToken?.actor?.uuid ?? null,
      ammoItemUuid: ammoItem.uuid,
    };
    const shooterActor = this.currentToken?.actor ?? null;
    const injurySource = {
      attackerUuid: shooterActor?.uuid ?? null,
      attackerName: shooterActor?.name ?? this.currentToken?.name ?? null,
      ammoUuid: ammoItem.uuid,
      ammoName: ammoItem.name,
      verbKey: 'fire',
      shotUid,
      legacyLabel: `aiming-ammo:${ammoItem.id}`,
    };

    const results = [];
    for (const hit of tokenHits) {
      const targetActor = hit.object.actor;
      if (typeof targetActor.applyDamagePackage !== 'function') continue;
      const bodyParts = targetActor.system?.health?.bodyParts ?? {};
      const partIds = Object.keys(bodyParts);
      if (!partIds.length) continue;
      const partId = partIds[Math.floor(Math.random() * partIds.length)];
      try {
        const out = await targetActor.applyDamagePackage({
          partId,
          projectile,
          builderContext,
          source: injurySource,
        });
        results.push({ actor: targetActor, partId, out });
      } catch (e) {
        console.error('AimingManager: applyDamagePackage failed', e);
      }
    }
    if (!results.length) return;

    const shooterName = String(this.currentToken?.name ?? '');
    const phaseSummary = this._formatApplicationsSummary(projectile);
    const blocks = [];
    for (const { actor: targetActor, partId, out } of results) {
      const targetName = String(targetActor?.name ?? '');
      const partLabel = String(targetActor.system?.health?.bodyParts?.[partId]?.name ?? out?.slotRef ?? partId);
      const damageBits = (Array.isArray(out?.bodyDamage) ? out.bodyDamage : [])
        .filter((d) => d && Number(d.amount) > 0)
        .map((d) => `${d.type}=${this._fmt(d.amount)}`)
        .join(', ');
      // `bodyDamage` is only the residual that reaches the part "core" after
      // the full armour + body layer stack. Held / fully converted hits can
      // leave it empty even when the trace shows heavy layer wear — that is
      // not the same as "stopped by worn armour" only.
      const noCoreKey = 'SPACEHOLDER.ActionsSystem.AimShot.DebugNoCoreWound';
      const noCore = game?.i18n?.localize?.(noCoreKey);
      const summary = damageBits || (noCore && noCore !== noCoreKey ? noCore : 'no core wound (absorbed in layers)');
      const traceHtml = this._formatTraceHtml(out?.trace);
      blocks.push(
        `<div style="margin: 4px 0; padding: 4px 6px; border-left: 2px solid #888;">`
        + `<div><b>${foundry.utils.escapeHTML(targetName)}</b> [${foundry.utils.escapeHTML(partLabel)}]: ${foundry.utils.escapeHTML(summary)}</div>`
        + traceHtml
        + `</div>`
      );
    }
    const content =
      `<div>`
      + `<div><b>${foundry.utils.escapeHTML(shooterName)}</b> · ${foundry.utils.escapeHTML(ammoItem.name)}</div>`
      + (phaseSummary ? `<div style="font-size: 11px; color: #555; margin: 2px 0;">${phaseSummary}</div>` : '')
      + blocks.join('')
      + `</div>`;
    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this.currentToken?.actor ?? null }),
        content,
      });
    } catch (_) {
      /* ignore chat errors */
    }
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
   * Форматировать число для отладочного вывода (2 знака после запятой,
   * без хвостовых нулей).
   * @private
   * @param {number} n
   * @returns {string}
   */
  _fmt(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '?';
    const r = Math.round(v * 100) / 100;
    return String(r);
  }

  /**
   * Краткая сводка применений снаряда (для шапки чат-сообщения).
   * @private
   * @param {Object} projectile
   * @returns {string} безопасный HTML
   */
  _formatApplicationsSummary(projectile) {
    const apps = projectile?.applications;
    if (Array.isArray(apps) && apps.length) {
      const parts = apps.map((phase, idx) => {
        const mode = phase?.mode === 'parallel' ? '∥' : '→';
        const items = Array.isArray(phase?.items) ? phase.items : [];
        const itemBits = items
          .map((it) => {
            const dmg = `${this._fmt(it?.damage ?? 0)} ${String(it?.type ?? '?')}`;
            const apBit = (it?.armorPen ?? 0) > 0 ? ` (AP ${this._fmt(it.armorPen)})` : '';
            const h = Number(it?.hardness ?? 1);
            const hBit = Number.isFinite(h) && h > 0 && Math.abs(h - 1) > 1e-6 ? ` (H ${this._fmt(h)})` : '';
            return dmg + apBit + hBit;
          })
          .join(', ');
        return `[${idx + 1} ${mode} ${foundry.utils.escapeHTML(itemBits)}]`;
      });
      return parts.join(' ');
    }
    const dt = String(projectile?.damageType ?? '').trim();
    const dmg = Number(projectile?.damage ?? 0);
    if (dt && dmg > 0) {
      const apBit = (projectile?.armorPen ?? 0) > 0 ? ` (AP ${this._fmt(projectile.armorPen)})` : '';
      const h = Number(projectile?.hardness ?? 1);
      const hBit = Number.isFinite(h) && h > 0 && Math.abs(h - 1) > 1e-6 ? ` (H ${this._fmt(h)})` : '';
      return `[${this._fmt(dmg)} ${foundry.utils.escapeHTML(dt)}${apBit}${hBit}]`;
    }
    return '';
  }

  /**
   * Отрендерить трассировку damage-resolver в HTML-блок &lt;details&gt;
   * для чат-сообщения. Каждое событие — одна строка с типом
   * (penetrate/hold/bypass/body), индексом слоя, материалом и числами.
   * @private
   * @param {Array<Object>} trace
   * @returns {string}
   */
  _formatTraceHtml(trace) {
    const events = Array.isArray(trace) ? trace : [];
    if (!events.length) return '';
    const matName = (slug) => {
      const id = String(slug ?? '').trim();
      if (!id) return '?';
      try {
        const md = game.spaceholder?.materialsManager?.getMaterial?.(id);
        return md?.name || id;
      } catch (_) {
        return id;
      }
    };
    const E = foundry.utils.escapeHTML;
    const rows = [];
    for (const ev of events) {
      switch (ev?.kind) {
        case 'conduct': {
          const parts = (Array.isArray(ev.items) ? ev.items : [])
            .map((it) => `${E(it.type)} ${this._fmt(it.amount)}`).join(', ');
          const txt = `↗ L${ev.layerIndex} <b>${E(matName(ev.material))}</b> · ${E(ev.fromType)} conducts [${parts}] · remaining ${this._fmt(ev.remaining)}`;
          rows.push(`<li style="color:#448">${txt}</li>`);
          break;
        }
        case 'penetrate': {
          const txt = `▶ L${ev.layerIndex} <b>${E(matName(ev.material))}</b> · ${E(ev.type)} · `
            + `incoming ${this._fmt(ev.incoming)} · E ${this._fmt(ev.energyBefore)} > eAR ${this._fmt(ev.eAR)} → residual ${this._fmt(ev.residual)} · `
            + `wear ${this._fmt(ev.wear)} → integrity ${this._fmt(ev.integrityAfter)}, breach ${this._fmt(ev.breachAfter)} (${E(ev.mode)})`;
          rows.push(`<li style="color:#a44">${txt}</li>`);
          break;
        }
        case 'hold': {
          const txt = `■ L${ev.layerIndex} <b>${E(matName(ev.material))}</b> · ${E(ev.type)} · `
            + `incoming ${this._fmt(ev.incoming)} · E ${this._fmt(ev.energyBefore)} ≤ eAR ${this._fmt(ev.eAR)} (held) · `
            + `wear ${this._fmt(ev.wear)} → integrity ${this._fmt(ev.integrityAfter)} (${E(ev.mode)})`;
          rows.push(`<li style="color:#484">${txt}</li>`);
          break;
        }
        case 'self-induce': {
          const entries = (Array.isArray(ev.entries) ? ev.entries : [])
            .map((e) => `${E(e.type)} ${this._fmt(e.absorbed)} absorbed / ${this._fmt(e.overflow)} overflow`)
            .join(', ');
          const txt = `⎈ L${ev.layerIndex} <b>${E(matName(ev.material))}</b> · ${E(ev.fromType)} induces [${entries}] · integrity ${this._fmt(ev.integrityAfter)}`;
          rows.push(`<li style="color:#864">${txt}</li>`);
          break;
        }
        case 'bypass': {
          const txt = `↷ L${ev.layerIndex} <b>${E(matName(ev.material))}</b> · ${E(ev.type)} ${this._fmt(ev.amount)} bypass (${E(ev.mode)})`;
          rows.push(`<li style="color:#888">${txt}</li>`);
          break;
        }
        case 'body': {
          const txt = `❤ body · ${E(ev.type)} ${this._fmt(ev.amount)}`;
          rows.push(`<li style="color:#222"><b>${txt}</b></li>`);
          break;
        }
        default:
          break;
      }
    }
    if (!rows.length) return '';
    return `<details style="margin-top: 4px;"><summary style="cursor: pointer; font-size: 11px;">trace (${rows.length})</summary>`
      + `<ul style="margin: 4px 0 0 16px; padding: 0; font-size: 11px; line-height: 1.4;">${rows.join('')}</ul>`
      + `</details>`;
  }

  /**
   * Привязать события
   * @private
   */
  _bindEvents() {
    canvas.stage.on('mousemove', this._boundEvents.onMouseMove);
    canvas.stage.on('mousedown', this._boundEvents.onMouseDown);
    canvas.stage.on('mouseup', this._boundEvents.onMouseUp);
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
    canvas.stage.off('mouseup', this._boundEvents.onMouseUp);
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
   * Обработчик отпускания мыши: останавливает авто-огонь (v3, режим Авто).
   * @private
   */
  _onMouseUp(event) {
    if (event?.data?.button === 0) this._stopAutoFire();
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

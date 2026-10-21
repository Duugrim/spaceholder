/**
 * Aiming Manager - модульная система прицеливания
 * Управляет процессом прицеливания и создаёт выстрелы через shot-manager
 */
import { setForcedAimingArcOverlay } from './aiming-arc-overlay.mjs';
import {
  AP_PER_SECOND,
  FIRE_MODES,
  resolveModeCritEffect,
  applyErgonomicsToArcs,
  applyDamageModifiers,
  buildProjectileFromDamageEntries,
  resolveEntriesEffort,
  resolveEffectiveAttackParams,
  normalizeMultishot,
  normalizeOnHitSplash,
  uniformConeDirections,
  normalizeAmmoConfig,
} from './weapon/weapon-model.mjs';
import {
  getWeaponData,
  persistWeaponData,
  consumeShotFromLine,
  preflightLineShotReadiness,
} from './weapon/weapon-ammo-runtime.mjs';
import { spendAp } from './actions/transaction-ledger.mjs';
import { beginCombatAction } from './actions/combat-action-log.mjs';
import { reportAttack } from './actions/attack-report.mjs';
import { shotApCost } from './weapon/attack-chain.mjs';
import { addShot, createAttackLog, formatNumber } from './weapon/attack-log.mjs';
import {
  normalizeTrajectoryKind,
  resolveWeaponLinePayload,
  applyOnHitSplashToPayload,
  TRAJECTORY_KINDS,
} from './weapon/trajectory.mjs';
import { applyEnergyScaleToApplications, BLAST_PART_COUNT, VOLLEY_SHARED_SPREAD, volleySpreadAt } from './weapon/damage-profile.mjs';
import { totalApplicationsDamage } from './walls/wall-penetration.mjs';
import { MIN_CARRY_DAMAGE, clockToHitFace } from './hit-luck.mjs';
import { zoneConfidence } from './shot-confidence.mjs';
import { CRIT_EFFECTS, computeHitQuality, localizeHitQualityTier } from './hit-quality.mjs';
import { availableHitGroups, groupSlotRefs, isPartAlive } from './anatomy-groups.mjs';
import { GM_ACTION_TYPES } from './gm-actions/gm-action-handlers.mjs';
import { composeProjectileApplications } from '../documents/item.mjs';
import { materialsManager } from './damage/materials-manager.mjs';

let _payloadLibraryCache = null;

/** Canonical id inside straight-line.json (manifest filename uses hyphens). */
const DEFAULT_WEAPON_PAYLOAD_ID = 'straight_line';

/**
 * Pointer travel (px) between a right-button press and its release above which the gesture is a
 * camera pan, not a click. Only a click cancels aiming.
 */
const RMB_CLICK_MAX_MOVE_PX = 6;

/** Fired when aiming starts or stops: `Hooks.callAll(AIMING_CHANGED_HOOK, { aiming, token })`. */
export const AIMING_CHANGED_HOOK = 'spaceholder.aimingChanged';


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

function _aimingCfg() {
  return CONFIG?.SPACEHOLDER?.aiming ?? {};
}

function _gridSizePx() {
  return Math.max(1, Number(canvas?.grid?.size) || 100);
}

function _signedDeltaDeg(fromDeg, toDeg) {
  let d = Number(toDeg) - Number(fromDeg);
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function _rotateTowardDeg(currentDeg, targetDeg, maxStepDeg) {
  const step = Math.max(0, Number(maxStepDeg) || 0);
  const delta = _signedDeltaDeg(currentDeg, targetDeg);
  if (Math.abs(delta) <= step) return targetDeg;
  return Number(currentDeg) + Math.sign(delta) * step;
}

function _pointerDeg(token) {
  return Number(token?.document?.getFlag?.('spaceholder', 'tokenpointerDirection') ?? 90);
}

function _accuracyScore(actor) {
  const n = Number(actor?.system?.derivedStats?.accuracyScore);
  // No derived stats (NPC, loot): treat as an average character (accuracy 100).
  return Number.isFinite(n) && n > 0 ? n : 100;
}

function _wanderRadiusPx(actor) {
  const cfg = _aimingCfg();
  const ref = Math.max(0.001, Number(cfg.accuracyRefScore) || 100);
  const score = Math.max(1, _accuracyScore(actor));
  return _gridSizePx() * (ref / score);
}

function _turnRateDegPerSec(ergo) {
  const cfg = _aimingCfg();
  const base = Math.max(0, Number(cfg.turnRateDegPerSec) || 180);
  const min = Math.max(0, Number(cfg.turnRateMinDegPerSec) || 30);
  const overall = Math.max(0, Number(ergo?.overall ?? 100) || 100);
  return Math.max(min, base * (overall / 100));
}

function _laserLengthPx() {
  const cells = Math.max(0.1, Number(_aimingCfg().laserLengthCells) || 6);
  return cells * _gridSizePx();
}

function _randomPointInDisk(radius) {
  const rMax = Math.max(0, Number(radius) || 0);
  if (rMax <= 0) return { x: 0, y: 0 };
  const t = Math.random() * Math.PI * 2;
  const r = rMax * Math.sqrt(Math.random());
  return { x: Math.cos(t) * r, y: Math.sin(t) * r };
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
  const visiblePerSideDeg = Math.max(0, 180 - arcs.deadZoneDeg);
  const zoneSum = zones.reduce((sum, z) => sum + Math.max(0, Number(z) || 0), 0);
  const allowedPerSideDeg = Math.min(visiblePerSideDeg, zoneSum > 0 ? zoneSum : visiblePerSideDeg);
  return { zones, visiblePerSideDeg, allowedPerSideDeg, deadZoneDeg: arcs.deadZoneDeg };
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

function _zoneIdByIndex(zoneIndex) {
  switch (Number(zoneIndex)) {
    case 0: return 'purple';
    case 1: return 'green';
    case 2: return 'yellow';
    case 3: return 'orange';
    default: return 'red';
  }
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

function _clampDesiredToArcs(pointerDeg, desiredDeg, allowedPerSideDeg) {
  const max = Math.max(0, Number(allowedPerSideDeg) || 0);
  const delta = _signedDeltaDeg(pointerDeg, desiredDeg);
  const clampedDelta = Math.max(-max, Math.min(max, delta));
  return {
    deg: Number(pointerDeg) + clampedDelta,
    clamped: Math.abs(delta) > max + 1e-6,
  };
}

/**
 * Luck from the technical line vs the token pointer. Arcs no longer jitter
 * the shot direction. Clamped-behind shots are always red. `confidence` is the zone as a number
 * (`zoneConfidence`): the shot reaches a token only if it is greater than the token's hit resistance.
 */
function _sampleShotLuck(token, lineDeg, ergo = null, clamped = false) {
  const { zones } = _resolveAimingArcConfig(token?.actor, ergo);
  const pointerDeg = _pointerDeg(token);
  const deltaFromPointer = _normalizeAngleDeltaDeg(lineDeg, pointerDeg);
  const zoneIndex = clamped ? Math.max(4, zones.length - 1) : _resolveAimingArcZoneIndex(deltaFromPointer, zones);
  const zone = clamped ? 'red' : _zoneIdByIndex(zoneIndex);
  const labelIndex = clamped ? 4 : zoneIndex;
  const zoneLabel = game.i18n?.localize?.(_zoneKeyByIndex(labelIndex)) ?? zone;
  return {
    zone,
    zoneIndex,
    zoneLabel,
    confidence: zoneConfidence(zone),
    lineDeg: Number(lineDeg) || 0,
    pointerDeg,
    clamped: !!clamped,
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
    /** @type {object|null} wander reticle + turning laser for standard aiming */
    this._standardState = null;
    this._aimingErgo = null;
    this._savedCanvasCursor = undefined;
    this._tickerFn = this._onAimingTick.bind(this);

    // Привязки событий
    this._boundEvents = {
      onMouseMove: this._onMouseMove.bind(this),
      onPointerDown: this._onPointerDown.bind(this),
      onMouseUp: this._onMouseUp.bind(this),
      onContextMenu: this._onContextMenu.bind(this),
      onKeyDown: this._onKeyDown.bind(this)
    };

    // Авто-режим (v3): таймер серии, пока зажата ЛКМ.
    this._autoFireTimer = null;
    this._fireBusy = false;
    /** True while primary button is held during aiming (stops AUTO race on release). */
    this._lmbHeld = false;
    /** Where the current right-button press started (client px); `null` when none. */
    this._rmbPress = null;
    /**
     * The attack of the current aiming session: everything shot until aiming is left. Reported to chat
     * when aiming stops (see `_attackSession`).
     * @type {{log: object, actor: Actor|null, token: Token|null, inFlight: number, closing: boolean, flushed?: boolean}|null}
     */
    this._attack = null;
  }

  /**
   * Whether `actor` has an aiming session running (for UI that offers to cancel it).
   * @param {Actor|null|undefined} actor
   * @returns {boolean}
   */
  isAimingActor(actor) {
    if (!this.isAiming || !actor) return false;
    const aimingActor = this.currentToken?.actor ?? null;
    return !!aimingActor && (aimingActor === actor || aimingActor.uuid === actor.uuid);
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
    // Needs a token on the canvas (a position to shoot from); a document or nothing cannot aim.
    if (!token?.center || !weaponItem) return false;
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
      ergonomics: eff.ergonomics,
      weaponV3: { weaponItemUuid: weaponItem.uuid, lineId, modeId },
    });
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
    
    // Если уже прицеливаемся, останавливаем предыдущее (изготовку этого же оружия не сбрасываем)
    if (this.isAiming) {
      this.stopAiming({ keepReadyWeaponUuid: options?.weaponV3?.weaponItemUuid });
    }
    
    console.log('AimingManager: Starting aiming for token', token.name);
    console.log('AimingManager: Using payload', payload.id);
    console.log('AimingManager: Options', options);
    
    this.isAiming = true;
    this.currentToken = token;
    this.currentPayload = payload;
    this.currentOptions = options;
    this._aimingErgo = options?.ergonomics ?? null;

    const aimingType = _normalizeAimingType(options?.type);
    if (aimingType === 'standard') {
      setForcedAimingArcOverlay(token, true, this._aimingErgo);
      this._startStandardAiming();
    } else {
      this._startSimpleAiming();
    }
    Hooks.callAll(AIMING_CHANGED_HOOK, { aiming: true, token });
  }
  
  /**
   * Остановить прицеливание. Выход из прицеливания снимает изготовку оружия (`state.ready`):
   * следующая атака снова платит за подготовку.
   * @param {object} [opts]
   * @param {string} [opts.keepReadyWeaponUuid] оружие, у которого изготовку сохранить (новое прицеливание им же)
   */
  stopAiming({ keepReadyWeaponUuid = '' } = {}) {
    if (!this.isAiming) return;
    
    console.log('AimingManager: Stopping aiming');
    this._lmbHeld = false;
    this._rmbPress = null;
    this._stopAutoFire();
    const currentToken = this.currentToken;
    const aimingType = _normalizeAimingType(this.currentOptions?.type);
    const readyWeaponUuid = String(this.currentOptions?.weaponV3?.weaponItemUuid ?? '').trim();
    const attack = this._attack;
    this._attack = null;
    
    this.isAiming = false;
    this.currentToken = null;
    this.currentPayload = null;
    this.currentOptions = null;
    this._aimingErgo = null;
    this._standardState = null;

    this._stopAimingTicker();
    this._clearPointer();
    // Shot trails are not cleared here: they fade out by their own age, whatever the aiming state.

    this._unbindEvents();
    this._setStandardCursorHidden(false);
    document.body.style.cursor = '';

    if (aimingType === 'standard' && currentToken) {
      setForcedAimingArcOverlay(currentToken, false);
    }
    if (readyWeaponUuid && readyWeaponUuid !== keepReadyWeaponUuid) void this._standDownWeapon(readyWeaponUuid);
    this._closeAttack(attack);
    Hooks.callAll(AIMING_CHANGED_HOOK, { aiming: false, token: currentToken });
  }

  /**
   * The weapon is no longer held ready (изготовка → боеготовность lost). The HUD refreshes on the item update.
   * @private
   * @param {string} weaponItemUuid
   */
  async _standDownWeapon(weaponItemUuid) {
    try {
      const weaponItem = await fromUuid(weaponItemUuid);
      if (!weaponItem) return;
      const weapon = getWeaponData(weaponItem);
      if (!weapon.state?.ready) return;
      weapon.state.ready = false;
      await persistWeaponData(weaponItem, weapon);
    } catch (e) {
      console.warn('AimingManager: could not stand the weapon down', e);
    }
  }
  
  /**
   * Начать режим simple прицеливания
   * @private
   */
  _startSimpleAiming() {
    document.body.style.cursor = 'crosshair';
    this._createPointer();
    this._bindEvents();
    this._updatePointer();
    ui.notifications.info(game.i18n?.localize?.('SPACEHOLDER.AimingManager.Messages.AimingActivated')
      ?? 'Aiming mode activated. LMB - shoot, RMB/ESC - cancel');
  }

  /**
   * Standard aiming: hidden cursor, wander reticle, turning laser clamped to arcs.
   * @private
   */
  _startStandardAiming() {
    this._setStandardCursorHidden(true);
    this._initStandardState();
    this._createPointer();
    this._bindEvents();
    this._startAimingTicker();
    this._updatePointer();
    ui.notifications.info(game.i18n?.localize?.('SPACEHOLDER.AimingManager.Messages.AimingActivated')
      ?? 'Aiming mode activated. LMB - shoot, RMB/ESC - cancel');
  }

  _setStandardCursorHidden(hidden) {
    const cls = String(_aimingCfg().boardAimingClass || 'spaceholder-aiming-standard');
    const board = document.getElementById('board');
    const canvasEl = canvas?.app?.canvas ?? canvas?.app?.view ?? canvas?.element ?? null;
    if (hidden) {
      board?.classList?.add(cls);
      if (canvasEl) {
        this._savedCanvasCursor = canvasEl.style?.cursor ?? '';
        canvasEl.style.cursor = 'none';
      }
    } else {
      board?.classList?.remove(cls);
      if (canvasEl) {
        canvasEl.style.cursor = this._savedCanvasCursor ?? '';
        this._savedCanvasCursor = undefined;
      }
    }
  }

  _initStandardState() {
    const pointerDeg = _pointerDeg(this.currentToken);
    const radius = _wanderRadiusPx(this.currentToken?.actor);
    const duration = Math.max(200, Number(_aimingCfg().wanderDurationMs) || 2000);
    const from = { x: 0, y: 0 };
    const to = _randomPointInDisk(radius);
    this._standardState = {
      localX: 0,
      localY: 0,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      wanderStartedAt: Date.now(),
      wanderDurationMs: duration,
      lineDeg: pointerDeg,
      clamped: false,
      radius,
    };
  }

  _startAimingTicker() {
    this._stopAimingTicker();
    try {
      canvas?.app?.ticker?.add?.(this._tickerFn);
    } catch (_) { /* ignore */ }
  }

  _stopAimingTicker() {
    try {
      canvas?.app?.ticker?.remove?.(this._tickerFn);
    } catch (_) { /* ignore */ }
  }

  _onAimingTick(ticker) {
    if (!this.isAiming) return;
    if (_normalizeAimingType(this.currentOptions?.type) !== 'standard') return;
    const dt = Math.min(0.1, Math.max(0, Number(ticker?.deltaMS ?? 16.6) / 1000));
    this._tickStandardAiming(dt);
    this._updatePointer();
  }

  _tickStandardAiming(dt) {
    const state = this._standardState;
    const token = this.currentToken;
    if (!state || !token) return;

    state.radius = _wanderRadiusPx(token.actor);
    const duration = Math.max(200, Number(state.wanderDurationMs) || 2000);
    const elapsed = Date.now() - Number(state.wanderStartedAt || 0);
    let t = duration > 0 ? elapsed / duration : 1;
    if (t >= 1) {
      state.localX = state.toX;
      state.localY = state.toY;
      state.fromX = state.localX;
      state.fromY = state.localY;
      const next = _randomPointInDisk(state.radius);
      state.toX = next.x;
      state.toY = next.y;
      state.wanderStartedAt = Date.now();
      t = 0;
    } else {
      state.localX = state.fromX + (state.toX - state.fromX) * t;
      state.localY = state.fromY + (state.toY - state.fromY) * t;
    }
    const mag = Math.hypot(state.localX, state.localY);
    if (mag > state.radius && mag > 1e-6) {
      const s = state.radius / mag;
      state.localX *= s;
      state.localY *= s;
    }

    const mouse = canvas?.mousePosition ?? { x: 0, y: 0 };
    const center = token.center;
    const reticleX = mouse.x + state.localX;
    const reticleY = mouse.y + state.localY;
    const desiredDeg = Math.atan2(reticleY - center.y, reticleX - center.x) * (180 / Math.PI);
    const pointerDeg = _pointerDeg(token);
    const { allowedPerSideDeg } = _resolveAimingArcConfig(token.actor, this._aimingErgo);
    const clampedAim = _clampDesiredToArcs(pointerDeg, desiredDeg, allowedPerSideDeg);
    state.clamped = clampedAim.clamped;
    const rate = _turnRateDegPerSec(this._aimingErgo);
    state.lineDeg = _rotateTowardDeg(state.lineDeg, clampedAim.deg, rate * dt);
    const lineClamp = _clampDesiredToArcs(pointerDeg, state.lineDeg, allowedPerSideDeg);
    state.lineDeg = lineClamp.deg;
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
    this.pointerGraphics.eventMode = 'none';
    this.pointerGraphics.interactive = false;
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

    const aimingType = _normalizeAimingType(this.currentOptions?.type);
    if (aimingType === 'standard') {
      this._drawStandardPointer();
      return;
    }

    const mousePos = canvas.mousePosition;
    const tokenCenter = this.currentToken.center;
    this.pointerGraphics.clear();
    this.pointerGraphics.lineStyle(2, 0x00ff00, 0.8);
    this.pointerGraphics.moveTo(tokenCenter.x, tokenCenter.y);
    this.pointerGraphics.lineTo(mousePos.x, mousePos.y);
    this.pointerGraphics.lineStyle(2, 0x00ff00, 1);
    this.pointerGraphics.drawCircle(mousePos.x, mousePos.y, 10);
  }

  _drawStandardPointer() {
    const g = this.pointerGraphics;
    const token = this.currentToken;
    const state = this._standardState;
    if (!g || !token || !state) return;

    const mouse = canvas?.mousePosition ?? { x: 0, y: 0 };
    const center = token.center;
    const zoneR = Math.max(0, Number(state.radius) || 0);
    const reticleX = mouse.x + state.localX;
    const reticleY = mouse.y + state.localY;
    const cfg = _aimingCfg();
    const laserLen = _laserLengthPx();
    const rad = (Number(state.lineDeg) * Math.PI) / 180;
    const endX = center.x + Math.cos(rad) * laserLen;
    const endY = center.y + Math.sin(rad) * laserLen;
    const color = Number(cfg.laserColor) || 0xff4444;
    const width = Math.max(1, Number(cfg.laserWidth) || 2);
    const segments = Math.max(4, Math.floor(Number(cfg.laserSegments) || 14));
    const zoneAlpha = Math.max(0, Math.min(1, Number(cfg.zoneDebugAlpha) || 0));
    const zoneColor = Number(cfg.zoneDebugColor) || 0x88c8ff;
    const reticleR = Math.max(2, Number(cfg.reticleRadiusPx) || 5);
    const reticleColor = Number(cfg.reticleColor) || 0xff6666;

    g.clear();

    if (zoneAlpha > 0 && zoneR > 0) {
      const debugColor = state.clamped ? 0xe05252 : zoneColor;
      g.lineStyle(1, debugColor, Math.max(zoneAlpha, state.clamped ? 0.45 : 0));
      g.drawCircle(mouse.x, mouse.y, zoneR);
    }

    for (let i = 0; i < segments; i += 1) {
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      const a = 0.9 * (1 - t0);
      g.lineStyle(width, color, a);
      g.moveTo(center.x + (endX - center.x) * t0, center.y + (endY - center.y) * t0);
      g.lineTo(center.x + (endX - center.x) * t1, center.y + (endY - center.y) * t1);
    }

    g.lineStyle(2, reticleColor, 1);
    g.drawCircle(reticleX, reticleY, reticleR);
    g.moveTo(reticleX - reticleR - 3, reticleY);
    g.lineTo(reticleX + reticleR + 3, reticleY);
    g.moveTo(reticleX, reticleY - reticleR - 3);
    g.lineTo(reticleX, reticleY + reticleR + 3);
  }

  /**
   * Получить текущее направление прицеливания
   * @private
   * @returns {number} Направление в градусах
   */
  _getCurrentDirection() {
    if (!this.currentToken) return 0;

    if (_normalizeAimingType(this.currentOptions?.type) === 'standard' && this._standardState) {
      return Number(this._standardState.lineDeg) || 0;
    }

    const mousePos = canvas.mousePosition;
    const tokenCenter = this.currentToken.center;
    const dx = mousePos.x - tokenCenter.x;
    const dy = mousePos.y - tokenCenter.y;
    return Math.atan2(dy, dx) * (180 / Math.PI);
  }

  _currentShotLuck() {
    if (_normalizeAimingType(this.currentOptions?.type) !== 'standard') return null;
    const lineDeg = this._getCurrentDirection();
    const clamped = !!this._standardState?.clamped;
    return _sampleShotLuck(this.currentToken, lineDeg, this._aimingErgo, clamped);
  }

  /**
   * Draw the shot's trail on this client right away (with "auto render" on). The same record goes
   * into the shot's chat message, from which every other client draws it; `DrawManager` ignores a
   * shot it already shows, so the shooter does not get it twice.
   * @private
   * @param {string} uid
   * @param {{extension?: boolean}} [options] `extension`: the rest of the trail — the bullet left the
   *   body and flew on (known once the damage is resolved), a record of its own
   */
  _renderShot(uid, { extension = false } = {}) {
    if (!this.currentOptions?.autoRender) return;
    const shotManager = game.spaceholder?.shotManager;
    const record = extension ? shotManager?.getShotExtension?.(uid) : shotManager?.getShotRecord?.(uid);
    if (!record) return;
    if (!game.spaceholder?.drawManager) {
      console.warn('AimingManager: drawManager not available');
      return;
    }
    game.spaceholder.drawManager.drawRecord(record);
  }

  _attachShotDiagnostics(uid, { luck = null, spread = null } = {}) {
    if (!uid) return;
    try {
      const shot = game.spaceholder?.shotManager?.shotSystem?.getShot?.(uid);
      if (!shot) return;
      if (luck) shot.luck = { ...luck };
      if (spread) {
        const d = Number(spread.spreadDeltaDeg);
        const m = Number(spread.spreadMaxDeg);
        shot.spread = {
          spreadDeltaDeg: Number.isFinite(d) ? d : 0,
          spreadMaxDeg: Number.isFinite(m) ? m : 0,
        };
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * The projectile the shot manager runs through penetrable walls: the damage package of
   * `projectile` composed without a target actor. `null` (every wall stops the shot, as before)
   * when the projectile has no usable damage spec.
   *
   * @private
   * @param {object} projectile
   * @param {object} [builderContext]
   * @returns {{applications: Array<{mode: string, items: object[]}>}|null}
   */
  _wallPenetrationFor(projectile, builderContext = {}) {
    if (!projectile || typeof projectile !== 'object') return null;
    const applications = composeProjectileApplications(projectile, { ...builderContext, actor: null });
    return applications.length ? { applications, falloff: projectile.falloff } : null;
  }

  /**
   * Chat lines for the walls a shot met (penetrated or stopped by).
   * @private
   * @param {object} shot
   * @returns {string[]}
   */
  _wallDiagnosticLines(shot) {
    const i18n = game.i18n;
    const fmt = (n) => this._fmt(n);
    const lines = [];
    for (const event of Array.isArray(shot?.wallPasses) ? shot.wallPasses : []) {
      const material = String(materialsManager.getMaterial(event.material)?.name || event.material || '');
      const thickness = Number.isFinite(event.thickness) ? fmt(event.thickness) : '∞';
      let key;
      if (event.penetrated) key = 'Penetrated';
      else if (event.reason === 'opaque') key = 'Opaque';
      else if (event.reason === 'unbounded') key = 'Unbounded';
      else key = 'Stopped';
      const fallback = `${material} ${thickness}: ${key.toLowerCase()}`;
      lines.push(i18n?.format?.(`SPACEHOLDER.Walls.Chat.${key}`, {
        material,
        thickness,
        before: fmt(event.damageBefore),
        after: fmt(event.damageAfter),
      }) || fallback);
    }
    return lines;
  }

  /**
   * The attack log of the current aiming session — everything shot until aiming is left — started at the
   * first shot. The session counts the shots still in flight, so the attack is reported to chat only after
   * the last of them has landed (`_closeAttack`).
   *
   * @private
   * @param {{weaponItem?: Item, eff?: object}} [weaponCtx] the v3 weapon context of the shot, if any
   */
  _attackSession(weaponCtx = null) {
    if (this._attack) return this._attack;
    const token = this.currentToken;
    const actor = token?.actor ?? null;
    const weaponItem = weaponCtx?.weaponItem ?? null;
    const eff = weaponCtx?.eff ?? null;
    const log = createAttackLog({
      actor: { uuid: actor?.uuid, name: actor?.name },
      token: { uuid: token?.document?.uuid, name: token?.name },
      weapon: weaponItem
        ? { uuid: weaponItem.uuid, name: weaponItem.name }
        : { name: this.currentOptions?.actionName ?? '' },
      lineName: eff?.line?.name,
      modeName: eff?.mode?.name,
      fireMode: eff?.mode?.fireMode,
    });
    this._attack = { log, actor, token, inFlight: 0, closing: false };
    return this._attack;
  }

  /**
   * Aiming was left: the attack is over. It is reported now, or as soon as its shots in flight have landed.
   * @private
   */
  _closeAttack(session) {
    if (!session) return;
    session.closing = true;
    if (session.inFlight <= 0) void this._flushAttack(session);
  }

  /** A shot of the session has landed (or failed); report the attack if it was waiting for it. @private */
  _releaseShot(session) {
    session.inFlight -= 1;
    if (session.closing && session.inFlight <= 0) void this._flushAttack(session);
  }

  /** @private */
  async _flushAttack(session) {
    if (session.flushed) return;
    session.flushed = true;
    try {
      await reportAttack(session.log, { actor: session.actor, token: session.token });
    } catch (error) {
      console.error('AimingManager: could not report the attack', error);
    }
  }

  /**
   * Send the shot's trail to the other clients (the shooter has drawn it already). Only with "auto render".
   * @private
   * @param {string} uid
   * @param {{extension?: boolean}} [options] see {@link _renderShot}
   */
  _broadcastShot(uid, { extension = false } = {}) {
    if (!this.currentOptions?.autoRender) return;
    const shotManager = game.spaceholder?.shotManager;
    const record = extension ? shotManager?.getShotExtension?.(uid) : shotManager?.getShotRecord?.(uid);
    if (record) game.spaceholder?.drawManager?.broadcastRecord?.(record);
  }

  /**
   * Show the rest of the trails of bullets that left a body and flew on (known only once the damage of
   * the shots is resolved).
   * @private
   * @param {string[]} uids
   */
  _showExtensions(uids) {
    for (const uid of uids) {
      this._renderShot(uid, { extension: true });
      this._broadcastShot(uid, { extension: true });
    }
  }

  /**
   * The «flies past» line of a token the projectile did not hit, with the reason: the shot's
   * confidence (its zone) did not beat the token's resistance, and what the resistance is made of.
   * @private
   * @param {{ object?: any, details?: object }} pass entry of `shot.passedThrough`
   * @param {string} [zoneLabel] the zone the shot was taken from
   */
  _passLine(pass, zoneLabel = '') {
    const messages = 'SPACEHOLDER.AimingManager.Messages';
    const details = pass?.details ?? {};
    const reasons = (details.resistanceStates ?? [])
      .map((id) => game.i18n?.localize?.(`${messages}.ResistanceStates.${id}`) ?? id);
    const mod = Number(details.resistanceMod) || 0;
    if (mod) {
      const value = `${mod > 0 ? '+' : ''}${mod}`;
      reasons.push(game.i18n?.format?.(`${messages}.ResistanceMod`, { value }) || `effects ${value}`);
    }
    const args = {
      name: String(pass?.object?.name ?? pass?.object?.actor?.name ?? ''),
      zone: String(zoneLabel ?? ''),
      confidence: formatNumber(details.confidence),
      resistance: formatNumber(details.resistance),
      reasons: reasons.length ? ` (${reasons.join(', ')})` : '',
    };
    return game.i18n?.format?.(`${messages}.DiagnosticPass`, args)
      || `${args.name} · confidence ${args.confidence} (${args.zone}) is not above resistance ${args.resistance}${args.reasons} — flies past`;
  }

  /**
   * What one ray of a shot leaves in the attack log: the luck and spread it was fired with, the tokens
   * it flew past, the walls it met, its impacts and its trail.
   *
   * @private
   * @param {string} uid
   * @param {object[]} impacts from `_resolveHitImpacts`
   * @param {{autoRender: boolean}} opts a trail drawn without «auto render» is stored but not shown
   * @returns {{luck: object|null, spread: object|null, passes: string[], walls: string[], impacts: object[],
   *   record: object|null, extension: object|null}} `extension` is the rest of the trail when the bullet
   *   left the body and flew on
   */
  _collectRay(uid, impacts, { autoRender }) {
    const shot = uid ? game.spaceholder?.shotManager?.shotSystem?.getShot?.(uid) : null;
    const passes = [];
    for (const pass of Array.isArray(shot?.passedThrough) ? shot.passedThrough : []) {
      passes.push(this._passLine(pass, shot.luck?.zoneLabel ?? shot.luck?.zone));
    }
    const luck = shot?.luck
      ? { zone: shot.luck.zone, zoneLabel: shot.luck.zoneLabel, confidence: shot.luck.confidence, clamped: !!shot.luck.clamped }
      : null;
    const spread = shot?.spread
      ? { deltaDeg: Number(shot.spread.spreadDeltaDeg) || 0, maxDeg: Number(shot.spread.spreadMaxDeg) || 0 }
      : null;
    // A trail drawn without «auto render» is stored but not shown; the same goes for its continuation.
    const stored = (record) => (record ? (autoRender ? record : { ...record, quiet: true }) : null);
    return {
      luck,
      spread,
      passes,
      walls: this._wallDiagnosticLines(shot),
      impacts,
      record: stored(shot?.record),
      extension: stored(shot?.extension),
    };
  }

  /**
   * Put a trigger pull into the attack log: the rays fired by it (a multishot volley has several) and
   * what it cost.
   * @private
   * @param {{log: object}} session
   * @param {ReturnType<AimingManager['_collectRay']>[]} rays
   * @param {{apCost?: number, baseApCost?: number}} [cost]
   */
  _logShot(session, rays, { apCost = 0, baseApCost = apCost } = {}) {
    const first = rays[0] ?? {};
    return addShot(session.log, {
      apCost,
      baseApCost,
      rays: rays.length,
      luck: first.luck ?? null,
      spread: first.spread ?? null,
      passes: rays.flatMap((r) => r.passes),
      walls: rays.flatMap((r) => r.walls),
      impacts: rays.flatMap((r) => r.impacts),
      records: rays.flatMap((r) => [r.record, r.extension]).filter(Boolean),
    });
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
    const direction = this._getCurrentDirection();
    const luck = this._currentShotLuck();
    const autoRender = !!this.currentOptions?.autoRender;
    const session = this._attackSession();
    session.inFlight += 1;
    try {
      console.log('AimingManager: Firing with direction', direction);

      const uid = shotManager.createShot(
        this.currentToken,
        payload,
        direction,
        {
          penetration: this._wallPenetrationFor(payload, {
            shooterActorUuid: this.currentToken?.actor?.uuid ?? null,
          }),
          confidence: luck?.confidence ?? null,
        }
      );
      this._attachShotDiagnostics(uid, {
        luck,
        spread: { spreadDeltaDeg: 0, spreadMaxDeg: 0 },
      });

      console.log('AimingManager: Shot created with UID', uid);

      this._renderShot(uid);
      this._broadcastShot(uid);

      const impacts = await this._resolveHitImpacts(uid, { projectile: payload });
      this._showExtensions([uid]);
      this._logShot(session, [this._collectRay(uid, impacts, { autoRender })]);

      // Не останавливаем прицеливание автоматически - пользователь может продолжить
    } finally {
      this._releaseShot(session);
    }
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
      // Release during the first (async) shot must not start a stuck interval.
      if (!this._lmbHeld || !this.isAiming) return;
      this._autoFireTimer = setInterval(() => {
        if (!this._lmbHeld || !this.isAiming) {
          this._stopAutoFire();
          return;
        }
        if (this._fireBusy) return;
        void this._fireWeaponV3Single({ first: false }).then((cont) => {
          if (!cont || !this._lmbHeld) this._stopAutoFire();
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
   * направление по техлинии + независимый Разброс линии, создание снаряда.
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
    let session = null;
    try {
      const ctx = await this._resolveWeaponV3Context();
      if (!ctx) return false;
      // Aiming may have been left while the weapon was being resolved.
      if (!this.isAiming || !this.currentToken) return false;
      const { weaponItem, weapon, eff, lineId, modeId } = ctx;
      const token = this.currentToken;
      const actor = token.actor ?? null;
      const autoRender = !!this.currentOptions?.autoRender;
      session = this._attackSession(ctx);
      session.inFlight += 1;

      const preflight = await preflightLineShotReadiness(actor, weapon, lineId);
      if (!preflight.ready) {
        const key = preflight.reason === 'needBolt'
          ? 'SPACEHOLDER.WeaponV3.Ammo.NeedBolt'
          : 'SPACEHOLDER.WeaponV3.Ammo.NoAmmoForShot';
        ui.notifications?.warn?.(game.i18n?.localize?.(key) ?? key);
        return false;
      }

      // --- ОД ---------------------------------------------------------
      // Action speed (COR) prices shots like every other action. In combat a shot the pool cannot pay is
      // refused (`spendAp`): a burst or an auto series stops there, and nothing is consumed.
      const baseCost = first
        ? Math.max(0, eff.line.aiming) + Math.max(0, eff.line.trigger)
        : Math.max(0, eff.mode.fireDelayAp);
      const baseApCost = Math.ceil(baseCost);
      const apCost = shotApCost(actor, baseCost);
      if (apCost > 0 && actor?.type === 'character') {
        const { combatant } = await beginCombatAction(actor, token.document ?? null);
        let spend = null;
        try {
          spend = await spendAp(actor, apCost, {
            combatantId: combatant?.id ?? null,
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

      // --- Снаряд: усилие стрелка (STR) → урон, затем модификаторы и множитель энергии ---
      // Записи с `effortShare` (ближнее оружие) получают урон от силы атакующего; у боеприпасов доля 0.
      const effort = Number(actor?.system?.abilities?.str?.value) || 0;
      const entries = applyDamageModifiers(
        resolveEntriesEffort(consumed.damageEntries, effort),
        eff.damageMods,
        eff.line.energyMult,
      );
      const firstRound = consumed.rounds.find((r) => r.round)?.round ?? null;
      const ammoCfg = normalizeAmmoConfig(firstRound?.system?.weapon?.ammo);
      const projectile = buildProjectileFromDamageEntries(entries, {
        payloadId: consumed.payloadId,
        falloff: ammoCfg.falloff,
      });

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

      const splash = normalizeOnHitSplash(ammoCfg.onHitSplash);
      if (splash.enabled) {
        payload = applyOnHitSplashToPayload(payload, splash, this.currentToken?.scene ?? canvas?.scene);
      }

      // Multishot: mode > line > ammo; barrel may widen fan via line.coneDegrees without enabling multishot
      const msMode = normalizeMultishot(eff.mode?.multishot);
      const msLine = normalizeMultishot(eff.line?.multishot);
      const msAmmo = normalizeMultishot(ammoCfg.multishot);
      let multishot = msMode.enabled ? msMode : (msLine.enabled ? msLine : msAmmo);
      if (multishot.enabled && !msMode.enabled && msLine.coneDegrees > 0) {
        multishot = { ...multishot, coneDegrees: msLine.coneDegrees };
      }

      // --- Направление: техлиния + удачность дуги + веер + per-ray spread ---
      const baseDirection = this._getCurrentDirection();
      const luck = this._currentShotLuck();
      const coneDirs = multishot.enabled && multishot.count > 1
        ? uniformConeDirections(baseDirection, multishot.count, multishot.coneDegrees)
        : [baseDirection];

      const shotManager = game.spaceholder?.shotManager;
      const penetration = this._wallPenetrationFor(projectile, {
        shooterActorUuid: actor?.uuid ?? null,
        weaponItemUuid: weaponItem?.uuid ?? null,
        ammoItemUuid: firstRound?.uuid ?? firstRound?.sourceUuid ?? null,
      });

      const uids = [];
      for (const coneDir of coneDirs) {
        let direction = coneDir;
        let spreadDeltaDeg = 0;
        const spreadMaxDeg = (eff.line.spread?.enabled && eff.line.spread.value > 0)
          ? Number(eff.line.spread.value) || 0
          : 0;
        if (spreadMaxDeg > 0) {
          spreadDeltaDeg = (Math.random() * 2 - 1) * spreadMaxDeg;
          direction += spreadDeltaDeg;
        }
        const uid = shotManager.createShot(token, payload, direction, {
          penetration,
          confidence: luck?.confidence ?? null,
        });
        this._attachShotDiagnostics(uid, {
          luck,
          spread: { spreadDeltaDeg, spreadMaxDeg },
        });
        this._renderShot(uid);
        this._broadcastShot(uid);
        uids.push(uid);
      }
      const volleyImpacts = await this._resolveVolleyImpacts(uids, {
        projectile,
        weaponItem,
        ammoItem: firstRound,
        critEffect: resolveModeCritEffect(eff.mode),
      }, { coneDegrees: multishot.enabled ? multishot.coneDegrees : 0 });
      this._showExtensions(uids);
      const rays = uids.map((uid, i) => this._collectRay(uid, volleyImpacts[i], { autoRender }));
      this._logShot(session, rays, { apCost, baseApCost });

      // Камера осталась пустой без автоподачи → серия прерывается затвором.
      if (consumed.needsBolt) return false;
      return true;
    } finally {
      this._fireBusy = false;
      if (session) this._releaseShot(session);
    }
  }

  /**
   * Turn every token hit of a shot into damage on the target actor.
   *
   * - Line hits (`details.centrality`): the hit quality (hit-quality.mjs) scales the projectile's
   *   energy — a glancing hit does what an angled armour plate would do, and still hurts a target
   *   without armour less. The bullseye is a crit; what a crit does is the fire mode's `critEffect`:
   *   `pickPart` lands the hit in the group the target has marked (`hitGroupOverride`), every other
   *   hit lands in a random group and part.
   * - AoE hits (`details.area`): no quality. The segment's `coverageMode` already decided who is
   *   affected; the body part is random and the energy is scaled by `details.effectScale`
   *   (coverage for `proportional`, 1 for the other modes); a blast reaches several parts.
   * One ray of {@link _resolveVolleyImpacts}.
   *
   * @private
   * @param {string} shotUid
   * @param {{projectile?: object, weaponItem?: Item, ammoItem?: Item, critEffect?: string}} [shotContext]
   *   `critEffect`: what a crit does in the mode that fired the shot (nothing when omitted)
   * @returns {Promise<object[]>} one impact per token the ray reached (see `weapon/attack-log.mjs`): a hit or an
   *   area hit; damage results are filled in once applied
   */
  async _resolveHitImpacts(shotUid, shotContext = {}) {
    const [impacts] = await this._resolveVolleyImpacts([shotUid], shotContext);
    return impacts ?? [];
  }

  /**
   * Turn every token hit of a trigger pull (one ray, or the rays of a multishot volley) into damage.
   *
   * - Each ray's line hits are scaled by their hit quality and by the distance falloff (a hit behind
   *   walls carries the falloff already, see `planWallPasses`).
   * - Pellets of one volley that hit the same token while the volley is still tight there
   *   ({@link VOLLEY_SHARED_SPREAD}) make one wound: one body-part roll, their damage goes in as one
   *   package (a parallel phase), so it adds up — a point-blank shotgun blast lands in one part.
   * - A blast (`details.blast`) reaches {@link BLAST_PART_COUNT} body parts of each target it covers,
   *   its energy split among them.
   *
   * @private
   * @param {string[]} shotUids
   * @param {{projectile?: object, weaponItem?: Item, ammoItem?: Item, critEffect?: string}} [shotContext]
   * @param {{ coneDegrees?: number }} [volley] the fan of the volley (full angle)
   * @returns {Promise<object[][]>} the impacts of every ray, in the order of `shotUids`
   */
  async _resolveVolleyImpacts(shotUids, shotContext = {}, { coneDegrees = 0 } = {}) {
    const uids = (Array.isArray(shotUids) ? shotUids : [shotUids]).filter(Boolean);
    const perShot = uids.map(() => []);
    const shotManager = game.spaceholder?.shotManager;
    if (!shotManager || !uids.length) return perShot;

    // No damage spec (e.g. a bare GM payload) → the hits are still recorded, nothing is applied.
    const projectile = shotContext.projectile;
    const canApply = projectile && typeof projectile === 'object'
      && (Number(projectile.damage) > 0
        || (Array.isArray(projectile.applications) && projectile.applications.length)
        || projectile.builderId);
    const critEffect = shotContext.critEffect ?? CRIT_EFFECTS.NONE;

    const shooterActor = this.currentToken?.actor ?? null;
    const injurySource = {
      attackerUuid: shooterActor?.uuid ?? null,
      attackerName: shooterActor?.name ?? this.currentToken?.name ?? null,
      weaponUuid: shotContext.weaponItem?.uuid ?? null,
      weaponName: shotContext.weaponItem?.name ?? null,
      ammoUuid: shotContext.ammoItem?.uuid ?? shotContext.ammoItem?.sourceUuid ?? null,
      ammoName: shotContext.ammoItem?.name ?? null,
      verbKey: 'fire',
      shotUid: uids[0],
    };
    const builderContext = {
      shooterActorUuid: shooterActor?.uuid ?? null,
      weaponItemUuid: shotContext.weaponItem?.uuid ?? null,
      ammoItemUuid: injurySource.ammoUuid,
    };

    // 1. Every token hit with its impact record and the scaled projectile that reaches it.
    const entries = [];
    const hitContext = { shotManager, projectile, canApply, builderContext };
    uids.forEach((uid, index) => {
      const shot = shotManager.shotSystem?.getShot?.(uid);
      const tokenHits = (Array.isArray(shot?.actualHits) ? shot.actualHits : [])
        .filter((h) => h?.type === 'token' && h?.object);
      for (const hit of tokenHits) {
        const { impact, entry } = this._hitEntry({ uid, shot, hit, index }, hitContext);
        perShot[index].push(impact);
        if (entry) entries.push(entry);
      }
    });

    // 2. Wounds: tight volley pellets on one token share one; everything else is its own.
    const wounds = [];
    const byToken = new Map();
    for (const entry of entries) {
      const singlePhase = entry.applications.length === 1;
      if (entry.isArea || uids.length < 2 || !singlePhase) {
        wounds.push([entry]);
        continue;
      }
      const list = byToken.get(entry.hit.object) ?? [];
      list.push(entry);
      byToken.set(entry.hit.object, list);
    }
    for (const list of byToken.values()) {
      const { point } = list[0].hit;
      const origin = list[0].shot?.origin;
      const distance = point && origin
        ? shotManager._hitDistanceSceneUnits({ distance: Math.hypot(point.x - origin.x, point.y - origin.y) })
        : Infinity;
      const spread = volleySpreadAt(distance, coneDegrees);
      if (list.length > 1 && spread <= VOLLEY_SHARED_SPREAD) wounds.push(list);
      else for (const entry of list) wounds.push([entry]);
    }

    // 3. Apply. A bullet that leaves the body it wounded flies on and can hurt the next token on its line.
    for (const wound of wounds) {
      const woundContext = { critEffect, builderContext, injurySource: { ...injurySource, shotUid: wound[0].uid } };
      const exit = await this._applyWound(wound, woundContext);
      if (wound.length === 1 && !wound[0].isArea) {
        await this._followThrough(wound[0], exit, { ...woundContext, shotManager, hitContext, perShot });
      }
    }
    return perShot;
  }

  /**
   * The attack-log record of a token a ray reached and the projectile that reaches it: scaled by the hit
   * quality (line hits), the share of a blast it is exposed to (AoE) and the distance falloff.
   *
   * @private
   * @param {{uid: string, shot: object, hit: object, index: number}} at the ray and the hit (`index`: the
   *   ray's place in the volley)
   * @param {{shotManager: ShotManager, projectile: object, canApply: boolean, builderContext: object}} ctx
   * @returns {{impact: object, entry: object|null}} `entry` is what {@link _applyWound} takes; `null` when
   *   there is nothing to apply (no damage spec, or the token has no actor that takes damage)
   */
  _hitEntry({ uid, shot, hit, index }, { shotManager, projectile, canApply, builderContext }) {
    const isArea = hit.details?.area === true;
    let quality = null;
    if (!isArea) {
      quality = computeHitQuality(hit.details?.centrality);
      if (!hit.details || typeof hit.details !== 'object') hit.details = {};
      hit.details.hitQuality = quality;
    }
    const impact = this._impactOf(hit, quality, { outcome: isArea ? 'area' : 'hit' });
    const targetActor = hit.object.actor ?? null;
    if (!canApply || typeof targetActor?.applyDamagePackage !== 'function') return { impact, entry: null };
    // AoE: the share of the blast the target is exposed to (only `proportional` goes below 1).
    const effectScale = isArea ? Math.max(0, Math.min(1, Number(hit.details.effectScale) || 0)) : 1;
    // A shot that went through walls (or out of a body) reaches this target with what is left of the
    // projectile (the falloff to here included); otherwise the falloff from the muzzle applies.
    const carry = Array.isArray(hit.details?.carry) && hit.details.carry.length ? hit.details.carry : null;
    const falloff = isArea || carry ? 1 : shotManager.falloffAt(shot, hit.point);
    // A glancing hit reaches the target with part of the projectile's energy.
    const energyScale = (quality?.multiplier ?? 1) * falloff;
    const applications = shotManager.buildScaledApplications(projectile, {
      actor: targetActor,
      builderContext,
      scale: effectScale,
      energyScale,
      base: carry,
    });
    // Nothing scaled: the actor composes the projectile itself (builders get the target as context).
    const unscaled = !carry && effectScale >= 1 && energyScale >= 1;
    return {
      impact,
      entry: { uid, shot, hit, impact, quality, isArea, targetActor, applications, unscaled, projectile, index },
    };
  }

  /**
   * The bullet left the body of `entry` (`exit`): it goes on along its line and each token it reaches
   * is hurt with what is left, in flight order (`ShotManager#continueShot`). Their impacts follow the
   * first one in the ray's log, marked `through` (the target the bullet came out of); the target a bullet
   * left carries `exit` (the damage that went on). Walls behind the body, flights past a token and the
   * rest of the trail are recorded in the shot.
   *
   * Nothing goes on when the bullet did not leave (`exit` empty) or the damage is not known yet (it waits
   * for the GM): the flight past the first body is simply not played.
   *
   * @private
   * @param {object} entry the entry of the wound the bullet left
   * @param {object[]|null} exit `exitApplications` of the wound
   * @param {object} ctx `_applyWound` context plus `shotManager`, `hitContext` (see {@link _hitEntry})
   *   and `perShot` (the impacts of every ray)
   */
  async _followThrough(entry, exit, ctx) {
    const { shot, hit, index } = entry;
    if (!exit?.length || shot?.tail?.anchor !== hit) return;
    const { shotManager, hitContext, perShot } = ctx;
    // What is left below what an injury can store is no bullet any more.
    const exitDamage = totalApplicationsDamage(exit);
    if (exitDamage < MIN_CARRY_DAMAGE) return;
    let previous = entry.impact;
    previous.exit = exitDamage;

    await shotManager.continueShot(shot, {
      anchor: hit,
      exit,
      deliver: async (nextHit) => {
        const { impact, entry: next } = this._hitEntry({ uid: entry.uid, shot, hit: nextHit, index }, hitContext);
        impact.through = previous.name;
        previous = impact;
        perShot[index].push(impact);
        if (!next) return null;
        const left = await this._applyWound([next], ctx);
        const leftDamage = left?.length ? totalApplicationsDamage(left) : 0;
        if (leftDamage >= MIN_CARRY_DAMAGE) impact.exit = leftDamage;
        return left;
      },
    });
  }

  /**
   * Apply one wound: the body part(s) it lands in and the damage. A volley wound goes in as one package
   * (its pellets in a parallel phase); a blast spreads over several parts.
   * @private
   * @param {object[]} wound entries from {@link _resolveVolleyImpacts}
   * @param {{critEffect: string, builderContext: object, injurySource: object}} ctx
   * @returns {Promise<object[]|null>} what left the body (`exitApplications`) when the wound is one hit of
   *   one bullet in one part and its result is known; otherwise `null` (a blast, a joined volley wound,
   *   damage that waits for the GM or failed)
   */
  async _applyWound(wound, { critEffect, builderContext, injurySource }) {
    const [first, ...rest] = wound;
    const { targetActor, hit, quality, impact } = first;
    const blast = first.isArea && hit.details?.blast === true;
    const partIds = this._pickHitParts(targetActor, {
      count: blast ? BLAST_PART_COUNT : 1,
      quality,
      critEffect,
      impact,
    });
    if (!partIds.length) return null;

    let damageSpec;
    if (wound.length > 1) {
      damageSpec = { applications: [{ mode: 'parallel', items: wound.flatMap((e) => e.applications[0]?.items ?? []) }] };
    } else if (blast && partIds.length > 1) {
      damageSpec = { applications: applyEnergyScaleToApplications(first.applications, 1 / partIds.length) };
    } else if (first.unscaled) {
      damageSpec = { projectile: first.projectile };
    } else {
      damageSpec = { applications: first.applications };
    }
    if (damageSpec.applications && !damageSpec.applications.length) return null;

    const hitDirection = clockToHitFace(hit.details?.clock);
    const results = [];
    try {
      for (const partId of partIds) {
        const result = await this._applyDamage(targetActor, {
          partId,
          ...damageSpec,
          builderContext,
          source: injurySource,
          hitDirection,
        });
        results.push({ partId, result });
      }
      Object.assign(impact, this._damageOutcome(targetActor, results));
    } catch (e) {
      console.error('AimingManager: applying damage failed', e);
      impact.failed = true;
    }
    // The other pellets of a volley wound went into the same wound.
    for (const entry of rest) {
      entry.impact.partName = impact.partName;
      entry.impact.joined = true;
    }
    return wound.length === 1 && results.length === 1 ? this._exitOf(results[0].result) : null;
  }

  /**
   * What left the body in an `applyDamagePackage` result — directly, or through the GM action manager.
   * @private
   * @param {object|null} result
   * @returns {object[]|null} `exitApplications`; `null` when nothing left it or the result is not known
   */
  _exitOf(result) {
    if (result?.status === 'queued') return null;
    const out = result?.status === 'done' ? result.result : result;
    const exit = out?.exitApplications;
    return Array.isArray(exit) && exit.length ? exit : null;
  }

  /**
   * Body parts a hit lands in — never interrupting play with a dialog: the group the target has marked when
   * the shot crit with a part-picking mode, else a random one; the part is a random one inside the group.
   * Several parts (a blast) are distinct while there are enough alive ones.
   * @private
   * @param {Actor} targetActor
   * @param {{count?: number, quality?: object|null, critEffect?: string, impact?: object}} [options]
   * @returns {string[]} slotRefs
   */
  _pickHitParts(targetActor, { count = 1, quality = null, critEffect = CRIT_EFFECTS.NONE, impact = null } = {}) {
    const bodyParts = targetActor.system?.health?.bodyParts ?? {};
    // Lost parts (and what hung below them) cannot be hit; a body with nothing left takes no damage.
    const alive = Object.keys(bodyParts).filter((id) => isPartAlive(bodyParts[id]));
    if (!alive.length) return [];
    const groups = availableHitGroups(targetActor);
    const override = String(targetActor.system?.anatomy?.hitGroupOverride ?? '').trim();
    const picked = quality?.crit && critEffect === CRIT_EFFECTS.PICK_PART && override
      ? groups.find((g) => g.id === override)
      : null;
    if (picked && impact) impact.pickedGroup = picked.name;

    const out = [];
    const want = Math.max(1, Math.min(count, alive.length));
    for (let attempt = 0; out.length < want && attempt < want * 6; attempt += 1) {
      const group = out.length === 0 && picked
        ? picked
        : (groups.length ? groups[Math.floor(Math.random() * groups.length)] : null);
      const slots = group ? groupSlotRefs(bodyParts, group, { aliveOnly: true }) : alive;
      const free = slots.filter((s) => !out.includes(s));
      const pool = free.length ? free : alive.filter((s) => !out.includes(s));
      if (!pool.length) break;
      out.push(pool[Math.floor(Math.random() * pool.length)]);
    }
    return out;
  }

  /**
   * The attack-log record of a token a ray reached: who, where from, how centrally and with how much
   * of the projectile's energy.
   * @private
   * @param {object} hit entry of `shot.actualHits`
   * @param {object|null} quality `computeHitQuality` result (line hits only)
   * @param {{outcome: string}} extra
   */
  _impactOf(hit, quality, extra) {
    const details = hit.details ?? {};
    const impact = {
      tokenUuid: hit.object?.document?.uuid ?? null,
      name: String(hit.object?.name ?? hit.object?.actor?.name ?? ''),
      kind: details.area ? 'area' : 'line',
      clock: details.clock,
      ...extra,
    };
    if (details.area) {
      impact.coverage = details.coverage;
      impact.coverageMode = details.coverageMode;
      impact.effectScale = details.effectScale;
    } else if (quality) {
      impact.centrality = quality.centrality ?? undefined;
      impact.energyScale = quality.multiplier;
      impact.quality = quality.tier;
      impact.qualityLabel = localizeHitQualityTier(quality.tier);
      impact.crit = quality.crit;
    }
    return impact;
  }

  /**
   * What the log keeps of an applied wound: the body part(s) and the damage that reached them, or that the
   * damage waits for the GM.
   * @private
   * @param {Actor} targetActor
   * @param {Array<{partId: string, result: object|null}>} results one per part the wound landed in:
   *   the `applyDamagePackage` result, or what the GM action manager returned
   */
  _damageOutcome(targetActor, results) {
    const bodyParts = targetActor.system?.health?.bodyParts ?? {};
    const names = [];
    const organs = [];
    const damage = new Map();
    let queued = false;
    let known = false;
    for (const { partId, result } of results) {
      queued ||= result?.status === 'queued';
      const out = result?.status === 'done' ? result.result : result;
      const slotRef = out?.slotRef ?? partId;
      const part = bodyParts[slotRef] ?? bodyParts[partId];
      names.push(String(part?.displayName ?? part?.name ?? slotRef ?? ''));
      // Organs the damage reached on its way (the entry part and whatever lay behind it).
      for (const [slot, hits] of Object.entries(out?.innerHitsBySlot ?? {})) {
        for (const hit of Array.isArray(hits) ? hits : []) {
          const inner = (bodyParts[slot]?.inners ?? []).find((o) => o?.id === hit?.innerId);
          const name = String(inner?.displayName ?? inner?.name ?? hit?.innerId ?? '');
          if (name && !organs.includes(name)) organs.push(name);
        }
      }
      if (Array.isArray(out?.bodyDamage)) {
        known = true;
        for (const d of out.bodyDamage) damage.set(d.type, (damage.get(d.type) ?? 0) + d.amount);
      }
    }
    return {
      partName: names.filter(Boolean).join(', '),
      organs: organs.length ? organs : undefined,
      damage: known ? [...damage].map(([type, amount]) => ({ type, amount })) : undefined,
      queued: queued || undefined,
    };
  }

  /**
   * Apply a damage package to a target. Owners (the GM included) apply it directly; anyone else
   * goes through the GM action manager, which runs it on a GM client right away or — when no GM is
   * online — parks it in a queue (and posts the "awaits GM" note).
   *
   * @private
   * @param {Actor} targetActor
   * @param {object} damageArgs arguments of `Actor#applyDamagePackage`
   * @returns {Promise<object>} the `applyDamagePackage` result, or the GM action manager's `{status, ...}`
   */
  async _applyDamage(targetActor, damageArgs) {
    const gmActions = game.spaceholder?.gmActions;
    if (targetActor.isOwner || !gmActions) return targetActor.applyDamagePackage(damageArgs);

    const part = targetActor.system?.health?.bodyParts?.[damageArgs.partId];
    const label = game.i18n?.format?.('SPACEHOLDER.GmActions.Damage.Label', {
      attacker: String(damageArgs.source?.attackerName ?? ''),
      target: String(targetActor.name ?? ''),
      part: String(part?.displayName ?? part?.name ?? damageArgs.partId ?? ''),
    }) ?? '';
    try {
      return await gmActions.request(
        GM_ACTION_TYPES.DAMAGE_APPLY,
        { targetUuid: targetActor.uuid, ...damageArgs },
        { label },
      );
    } catch (error) {
      ui.notifications?.warn?.(game.i18n?.format?.('SPACEHOLDER.GmActions.Damage.NotApplied', {
        reason: error?.message ?? String(error),
      }) ?? `Damage was not applied: ${error?.message ?? error}`);
      throw error;
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
    const luck = shotContext.luck ?? shot?.luck ?? null;
    const luckBit = luck
      ? ` · ${String(luck.zoneLabel ?? luck.zone ?? '')}`
        + (luck.clamped ? ` (${game.i18n?.localize?.('SPACEHOLDER.AimingManager.Messages.LuckClamped') ?? 'clamped'})` : '')
      : '';
    const content = (game.i18n?.format?.('SPACEHOLDER.AimingManager.Messages.ProjectileShotResolved', {
      shooter: shooterName,
      weapon: weaponName,
      ammo: ammoName,
      hits: String(count),
    }) || `${shooterName} fires ${weaponName} (${ammoName}); impacts: ${count}`) + luckBit;
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
      const partIds = Object.keys(bodyParts).filter((id) => isPartAlive(bodyParts[id]));
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
    // Presses are read at window capture, ahead of PIXI and Foundry's own mouse handling, so that
    // the primary button can be taken over completely (see `_onPointerDown`).
    window.addEventListener('pointerdown', this._boundEvents.onPointerDown, true);
    canvas.stage.on('mouseup', this._boundEvents.onMouseUp);
    canvas.stage.on('mouseupoutside', this._boundEvents.onMouseUp);
    canvas.stage.on('pointerupoutside', this._boundEvents.onMouseUp);
    canvas.stage.on('pointercancel', this._boundEvents.onMouseUp);
    document.addEventListener('contextmenu', this._boundEvents.onContextMenu);
    document.addEventListener('keydown', this._boundEvents.onKeyDown);
    // Releases are read at window capture too: a panel that swallows the event, a cancelled pointer or
    // an alt-tab with the button held must not leave auto-fire running.
    window.addEventListener('pointerup', this._boundEvents.onMouseUp, true);
    window.addEventListener('pointercancel', this._boundEvents.onMouseUp, true);
    window.addEventListener('blur', this._boundEvents.onMouseUp);
  }
  
  /**
   * Отвязать события
   * @private
   */
  _unbindEvents() {
    canvas.stage.off('mousemove', this._boundEvents.onMouseMove);
    window.removeEventListener('pointerdown', this._boundEvents.onPointerDown, true);
    canvas.stage.off('mouseup', this._boundEvents.onMouseUp);
    canvas.stage.off('mouseupoutside', this._boundEvents.onMouseUp);
    canvas.stage.off('pointerupoutside', this._boundEvents.onMouseUp);
    canvas.stage.off('pointercancel', this._boundEvents.onMouseUp);
    document.removeEventListener('contextmenu', this._boundEvents.onContextMenu);
    document.removeEventListener('keydown', this._boundEvents.onKeyDown);
    window.removeEventListener('pointerup', this._boundEvents.onMouseUp, true);
    window.removeEventListener('pointercancel', this._boundEvents.onMouseUp, true);
    window.removeEventListener('blur', this._boundEvents.onMouseUp);
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
   * The canvas element Foundry draws on (events that target it are "on the map").
   * @private
   * @returns {HTMLElement|null}
   */
  _canvasElement() {
    return canvas?.app?.canvas ?? canvas?.app?.view ?? null;
  }

  /**
   * @private
   * @param {Event} event
   * @returns {boolean} whether the event landed on the map and not on a window or HUD above it
   */
  _isCanvasEvent(event) {
    const el = this._canvasElement();
    return !!el && event?.target === el;
  }

  /**
   * Pointer press on the map while aiming. The primary button belongs to aiming alone: the event is
   * stopped before PIXI and Foundry see it, so a held button (auto fire) does not also draw a
   * selection box, drag a token or deselect it. The secondary button is left to Foundry (it pans the
   * camera); only where its press began is noted, to tell a click from a pan on release.
   * @private
   * @param {PointerEvent} event
   */
  _onPointerDown(event) {
    if (!this.isAiming || !this._isCanvasEvent(event)) return;

    if (event.button === 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this._lmbHeld = true;
      void this._fire();
    } else if (event.button === 2) {
      this._rmbPress = { x: event.clientX, y: event.clientY };
    }
  }

  /**
   * Обработчик отпускания мыши: останавливает авто-огонь (v3, режим Авто).
   * @private
   */
  _onMouseUp(event) {
    const btn = event?.data?.button ?? event?.button;
    // PIXI events use data.button; DOM pointerup uses button. Treat missing as primary release;
    // a cancelled pointer or a lost window focus ends the press whatever the button was.
    const aborted = event?.type === 'pointercancel' || event?.type === 'blur';
    if (aborted || btn == null || btn === 0) {
      this._lmbHeld = false;
      this._stopAutoFire();
    }
  }

  /**
   * Context-menu event on the map (the end of a right-button gesture). A right click cancels
   * aiming; the same event also ends a camera pan, and that must not.
   * @private
   * @param {MouseEvent} event
   */
  _onContextMenu(event) {
    if (!this.isAiming || !this._isCanvasEvent(event)) return;

    event.preventDefault();
    const press = this._rmbPress;
    this._rmbPress = null;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > RMB_CLICK_MAX_MOVE_PX) return;
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

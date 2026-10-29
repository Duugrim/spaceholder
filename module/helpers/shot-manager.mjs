/**
 * Shot Manager - система просчёта выстрелов
 * Преобразует payload (инструкции) в shotResult (координаты для визуализации)
 */

import { composeProjectileApplications } from '../documents/item.mjs';
import {
  applyEnergyScaleToApplications,
  falloffMultiplier,
  normalizeAreaExcludeDirectHit,
  normalizeAreaIgnoreDirectHitCover,
  normalizeAreaLineOfSight,
  normalizeFalloff,
  resolveAreaCoverageEffect,
} from './weapon/damage-profile.mjs';
import { clockToHitFace, followProjectileThroughBodies, walkProjectileCollisions } from './hit-luck.mjs';
import { hitboxScaleFactor } from './hitbox-scale.mjs';
import { computeHitResistance, createTokenJudge } from './shot-confidence.mjs';
import { materialsManager } from './damage/materials-manager.mjs';
import { applicationsEnergy } from './damage/penetration-track.mjs';
import { planWallPasses } from './walls/wall-penetration.mjs';
import { getPxPerThicknessUnit, isShotBlockingWall, wallCrossingFromCollision } from './walls/wall-data.mjs';
import { buildShotRecord, makeShotId, trailNowMs } from './shot-trail.mjs';
import {
  SWING_HIT_MODES,
  backOffFromWall,
  centralityFromDistance,
  normalizeSwingHitMode,
  resolveSwingSide,
  swingDeepestPass,
  swingSideCentrality,
} from './weapon/trajectory.mjs';

/**
 * A token shields others from an AoE only within this fraction of its hit radius.
 * Keeps the blast origin of a rocket (on the target's hit surface) outside the target's own
 * cover, so tokens standing next to the target still get partial coverage.
 */
const TOKEN_COVER_RADIUS_FACTOR = 0.5;

/** Bisection steps that pin down the exact angle at which a sweeping edge first touches something. */
const SWING_CONTACT_REFINE_STEPS = 12;

/**
 * Shots kept in memory. A shot is only needed while it is resolved (chat, damage, dialogs); what
 * outlives it is its `record`, stored in the chat message. The cap keeps old shots — and the
 * Token/Wall objects their hits point at — from piling up.
 */
const MAX_STORED_SHOTS = 32;

/**
 * ShotSystem - центральное хранилище выстрелов
 */
class ShotSystem {
  constructor() {
    this.shots = new Map(); // Хранилище активных выстрелов (в порядке создания)
  }

  /**
   * Генерация уникального ID для выстрела
   * @returns {string} UID формата shot_{random}; уникален и между клиентами
   */
  generateUID() {
    return makeShotId();
  }

  /**
   * Регистрация нового выстрела
   * @param {string} uid - Уникальный идентификатор выстрела
   * @returns {object} Объект выстрела
   */
  registerShot(uid) {
    const shot = {
      uid: uid,
      shotResult: {
        shotPaths: [],  // Массив траекторий (координат)
        shotHits: [],   // Массив попаданий
        wallPasses: []  // Стены, которые снаряд прошёл или которые его остановили (для отрисовки)
      },
      actualHits: [],   // Массив фактических попаданий от HitSystem
      // Пробитие стен: снаряд, который сейчас летит (applications с остатком энергии);
      // null — стены останавливают выстрел как раньше. Отчёты по стенам — для чата.
      penetration: null,
      // Energy of the projectile at the muzzle (the reference of the penetration view's percentages).
      muzzleEnergy: null,
      wallPasses: [],
      // Токены, мимо которых снаряд пролетел (см. walkProjectileCollisions), и их же как диагностика для чата.
      passedTokens: new Set(),
      passedThrough: [],
      // Уверенность выстрела против сопротивления цели (shot-confidence.mjs): `judgeToken` решает, пролетает ли
      // снаряд мимо токена; null — выстрел без уверенности (отладочный), каждое касание хитбокса — попадание.
      judgeToken: null,
      // Сериализуемая запись выстрела (shot-trail.mjs): рисуется на всех клиентах, хранится в чате.
      record: null,
      // Хвост луча `stop` за первым телом (см. _keepTail) и запись продолжения, если пуля вышла из тела
      // и полетела дальше (см. continueShot): рисуется отдельным куском, когда урон посчитан.
      tail: null,
      extension: null
    };

    this.shots.set(uid, shot);
    while (this.shots.size > MAX_STORED_SHOTS) {
      this.shots.delete(this.shots.keys().next().value);
    }
    return shot;
  }

  /**
   * Получение выстрела по UID
   * @param {string} uid - Уникальный идентификатор
   * @returns {object|null} Объект выстрела или null
   */
  getShot(uid) {
    return this.shots.get(uid) || null;
  }

  /**
   * Удаление выстрела
   * @param {string} uid - Уникальный идентификатор
   */
  removeShot(uid) {
    this.shots.delete(uid);
  }

  /**
   * Очистка всех выстрелов
   */
  clear() {
    this.shots.clear();
  }

  /**
   * Вывод всех сохранённых shotResult в консоль
   */
  logAllShots() {
    if (this.shots.size === 0) {
      console.log('ShotSystem: No shots stored');
      return;
    }

    console.log(`%c=== ShotSystem Debug (${this.shots.size} shots) ===`, 'color: #00ff00; font-weight: bold; font-size: 14px');
    
    this.shots.forEach((shot, uid) => {
      console.group(`%c${uid}`, 'color: #ffff00');
      console.log('shotPaths:', shot.shotResult.shotPaths);
      console.log('shotHits:', shot.shotResult.shotHits);
      console.log('actualHits:', shot.actualHits);
      console.groupEnd();
    });
    
    console.log('%c=== End ShotSystem Debug ===', 'color: #00ff00; font-weight: bold');
  }
}

/**
 * ShotManager - главный класс для управления выстрелами
 */
export class ShotManager {
  constructor() {
    this.shotSystem = new ShotSystem();
  }

  /**
   * Route every actor hit recorded for `shot` through the damage / armour
   * resolver. Call this after the shot's geometry has been processed and
   * `shot.actualHits` is final.
   *
   * The resolver consumes a phased application package; this helper builds
   * it from `projectile` (`{ damage, damageType, applications, builderId, …}`)
   * via `buildProjectileApplications`. If the projectile carries no usable
   * damage spec the call is a no-op.
   *
   * @param {Object} shot - shot object (as returned by shotSystem.registerShot)
   * @param {Object} projectile - the resolved projectile payload (after ammo
   *   substitution etc.)
   * @param {Object} [options]
   * @param {string} [options.partId] - body slot to target; if omitted, the
   *   per-hit `details.partId` is used. Hits without a part id are skipped.
   * @param {Object} [options.builderContext] - extra context forwarded to
   *   `applyDamagePackage` when the projectile uses a builderId.
   * @param {string|Object} [options.source] - либо строка-легаси, либо
   *   частично заполненный snapshot источника. Отсутствующие поля
   *   (`attackerName`, `weaponName`, `ammoName`, `verbKey`, `shotUid` и uuid'ы)
   *   дополняются автоматически из `shot` / `builderContext` / `projectile`.
   * @param {() => number} [options.random]
   * @returns {Promise<Array<{actorId: string, slotRef: string|null, bodyDamage: Array<{type:string, amount:number}>}>>}
   */
  async applyImpactsToActors(shot, projectile, options = {}) {
    if (!shot || !Array.isArray(shot.actualHits) || !shot.actualHits.length) return [];
    if (!projectile || typeof projectile !== 'object') return [];
    const basePhases = composeProjectileApplications(projectile, options.builderContext ?? {});
    if (!basePhases.length) return [];
    const falloff = normalizeFalloff(projectile.falloff);

    const sourceSnapshot = await this._buildInjurySourceSnapshot({
      shot, projectile, builderContext: options.builderContext, override: options.source
    });

    const results = [];
    for (const hit of shot.actualHits) {
      const token = hit?.object?.document ? hit.object : hit?.token ?? hit?.target ?? null;
      const actor = token?.actor ?? hit?.actor ?? null;
      if (!actor || typeof actor.applyDamagePackage !== 'function') continue;
      const partId = options.partId ?? hit?.details?.partId ?? hit?.partId ?? null;
      if (!partId) continue;
      const sceneDist = this._hitDistanceSceneUnits(hit);
      const phases = applyEnergyScaleToApplications(basePhases, falloffMultiplier(sceneDist, falloff));
      const hitDirection = options.hitDirection
        ?? hit?.details?.hitDirection
        ?? clockToHitFace(hit?.details?.clock);
      try {
        const out = await actor.applyDamagePackage({
          partId,
          applications: phases,
          builderContext: options.builderContext,
          source: sourceSnapshot,
          random: options.random,
          hitDirection: hitDirection || undefined,
        });
        results.push({ actorId: actor.id, slotRef: out.slotRef, bodyDamage: out.bodyDamage });
      } catch (e) {
        console.error('SpaceHolder | ShotManager: failed to apply impact', e);
      }
    }
    return results;
  }

  /**
   * Phased applications for one actor hit: scaled by an AoE `effectScale` (the share of the blast the
   * target is exposed to) and by `energyScale` (a glancing hit, see `hit-quality.mjs`; the distance falloff).
   * Both scale the energy; the damage follows it by the armour-damage-reduction law, the armour
   * penetration stays as authored, a carried energy (after walls) is scaled, not recomputed.
   *
   * @param {Object} projectile
   * @param {Object} [options]
   * @param {Actor|null} [options.actor] target actor (forwarded to application builders)
   * @param {Object} [options.builderContext]
   * @param {number} [options.scale=1] 0–1
   * @param {number} [options.energyScale=1] 0–1
   * @param {Array<{mode:string, items:object[]}>|null} [options.base] applications to scale instead of
   *   composing them from `projectile` (what is left of the shot after the walls it went through)
   * @returns {Array<{mode:string, items:object[]}>} empty when the projectile has no usable damage spec
   */
  buildScaledApplications(projectile, { actor = null, builderContext = {}, scale = 1, energyScale = 1, base = null } = {}) {
    const phases = base ?? composeProjectileApplications(projectile, { ...builderContext, actor });
    return applyEnergyScaleToApplications(phases, Math.max(0, scale) * Math.max(0, energyScale));
  }

  /**
   * Convert hit distance (pixels) to scene distance units (e.g. meters).
   * @private
   * @param {object} hit
   * @returns {number}
   */
  /**
   * Share of its muzzle energy the shot's projectile still has at a point (distance falloff, measured in a
   * straight line from the muzzle).
   * @param {object} shot ShotSystem shot (`origin`, `falloff`)
   * @param {{x:number, y:number}} point
   * @returns {number} 0–1 (1 without falloff)
   */
  falloffAt(shot, point) {
    if (!shot?.falloff?.enabled || !shot.origin || !point) return 1;
    const px = Math.hypot(point.x - shot.origin.x, point.y - shot.origin.y);
    return falloffMultiplier(this._hitDistanceSceneUnits({ distance: px }), shot.falloff);
  }

  _hitDistanceSceneUnits(hit) {
    const px = Number(hit?.distance) || 0;
    try {
      const grid = canvas?.grid;
      const size = Number(grid?.size) || 100;
      const unit = Number(grid?.distance) || 1;
      if (size > 0) return (px / size) * unit;
    } catch (_) { /* ignore */ }
    return px / 100;
  }

  /**
   * Собрать snapshot источника травмы: имена атакующего/оружия/аммо + их
   * uuid'ы + id выстрела + глагол. Каждое поле опционально; если что-то
   * определить нельзя — поле просто не попадает в объект.
   * @private
   * @param {Object} args
   * @param {Object} args.shot
   * @param {Object} args.projectile
   * @param {Object} [args.builderContext]
   * @param {string|Object} [args.override]
   * @returns {Promise<Object>}
   */
  async _buildInjurySourceSnapshot({ shot, projectile, builderContext, override }) {
    const snap = {};
    if (shot?.uid) snap.shotUid = String(shot.uid);

    const ctx = builderContext && typeof builderContext === 'object' ? builderContext : {};
    const attackerUuid = ctx.shooterActorUuid ?? ctx.attackerUuid ?? ctx.attacker?.uuid ?? null;
    const weaponUuid = ctx.weaponItemUuid ?? ctx.weaponUuid ?? ctx.weapon?.uuid ?? null;
    const ammoUuid = ctx.ammoItemUuid ?? ctx.ammoUuid ?? ctx.ammo?.uuid ?? null;

    if (attackerUuid) snap.attackerUuid = String(attackerUuid);
    if (weaponUuid) snap.weaponUuid = String(weaponUuid);
    if (ammoUuid) snap.ammoUuid = String(ammoUuid);

    const resolveName = async (uuid, directName) => {
      if (directName) return String(directName);
      if (!uuid) return null;
      try {
        const doc = await fromUuid(uuid);
        return doc?.name ? String(doc.name) : null;
      } catch (_) { return null; }
    };

    const attackerName = await resolveName(attackerUuid, ctx.attackerName ?? ctx.attacker?.name);
    const weaponName = await resolveName(weaponUuid, ctx.weaponName ?? ctx.weapon?.name);
    const ammoName = await resolveName(ammoUuid, ctx.ammoName ?? ctx.ammo?.name ?? projectile?.name);

    if (attackerName) snap.attackerName = attackerName;
    if (weaponName) snap.weaponName = weaponName;
    if (ammoName) snap.ammoName = ammoName;

    const verb = ctx.verbKey ?? ctx.verb ?? (weaponUuid || weaponName ? 'fire' : (ammoUuid || ammoName ? 'fire' : null));
    if (verb) snap.verbKey = String(verb);

    if (typeof override === 'string' && override) {
      snap.legacyLabel = override;
    } else if (override && typeof override === 'object') {
      for (const [k, v] of Object.entries(override)) {
        if (v != null && v !== '') snap[k] = typeof v === 'string' ? v : String(v);
      }
    }

    return snap;
  }

  /**
   * Получение whitelist - список игнорируемых объектов
   * @param {Token} token - Токен, который стреляет
   * @returns {Array} Массив объектов для игнорирования
   */
  getWhitelist(token) {
    // Добавляем стреляющий токен в whitelist
    return [token];
  }

  /**
   * Получение базовых параметров для выстрела
   * @param {Token} token - Токен, который стреляет
   * @returns {object} Объект с базовыми параметрами
   */
  getDefaults(token) {
    const scene = token.scene;
    const grid = scene.grid;
    
    return {
      defSize: grid.size / grid.distance,  // Универсальная длина отрезка
      defPos: {                            // Текущие координаты токена (центр)
        x: token.center.x,
        y: token.center.y
      }
    };
  }

  /**
   * Radius of the area in which projectiles register a hit on `token` (the "target"): the token's
   * body radius times the actor's hitbox scale (`system.hitboxScale`, usually ≤ 100%). This is the
   * only place the scale is applied. Base characteristics (DEX etc.) must not influence the hitbox.
   * @private
   * @param {Token} token
   * @returns {number} px
   */
  _targetHitRadius(token) {
    const bounds = token.bounds;
    return (Math.min(bounds.width, bounds.height) / 2) * hitboxScaleFactor(token.actor);
  }

  /**
   * How hard `token` is to hit right now (see `shot-confidence.mjs`): the statuses of its actor that
   * count as states (`HIT_RESISTANCE_STATES`: combat ready, moving, cover, hidden) plus the flat
   * modifier `system.hitResistanceMod` that effects fill. A token without an actor has no resistance.
   * @private
   * @param {Token|null|undefined} token
   * @returns {ReturnType<typeof computeHitResistance>}
   */
  _hitResistanceFor(token) {
    const actor = token?.actor ?? null;
    return computeHitResistance({
      states: actor?.statuses ?? [],
      modifier: actor?.system?.hitResistanceMod,
    });
  }

  /**
   * Radius of the area in which `token` shields others from an AoE (line-of-sight cover):
   * {@link TOKEN_COVER_RADIUS_FACTOR} of the smaller of the body radius and the hit radius.
   * Always below the hit radius, an enlarged hitbox never inflates cover, and a shrunken
   * hitbox (evasion) shrinks cover with it.
   * @private
   * @param {Token} token
   * @returns {number} px
   */
  _targetCoverRadius(token) {
    const bounds = token.bounds;
    const bodyRadius = Math.min(bounds.width, bounds.height) / 2;
    return Math.min(bodyRadius, this._targetHitRadius(token)) * TOKEN_COVER_RADIUS_FACTOR;
  }

  /**
   * Facing of a token pointer (degrees, canvas atan2). Default 90 = down.
   * @private
   * @param {Token} token
   * @returns {number}
   */
  _tokenPointerDeg(token) {
    return Number(token?.document?.getFlag?.('spaceholder', 'tokenpointerDirection') ?? 90);
  }

  /**
   * Clock position of a point on the token circle vs the target pointer.
   * 12 = facing, increasing clockwise (1…12].
   * @private
   * @param {Token} token
   * @param {{x: number, y: number}} point
   * @param {{x: number, y: number}} center
   * @returns {number}
   */
  _hitClockHours(token, point, center) {
    const pointerDeg = this._tokenPointerDeg(token);
    const hitDeg = Math.atan2(point.y - center.y, point.x - center.x) * (180 / Math.PI);
    let rel = hitDeg - pointerDeg;
    while (rel < 0) rel += 360;
    while (rel >= 360) rel -= 360;
    const hours = rel / 30;
    return hours === 0 ? 12 : hours;
  }

  /**
   * Расчёт процента покрытия токена кругом (метод сэмплирования)
   * @private
   * @param {object} circleCenter - Центр круга {x, y}
   * @param {number} circleRadius - Радиус круга
   * @param {object} tokenCenter - Центр токена {x, y}
   * @param {number} tokenRadius - Радиус хитбокса токена (_targetHitRadius)
   * @param {object} collisionOptions - Опции проверки collision {walls, tokens}
   * @param {Array} whitelist - Список игнорируемых токенов
   * @param {Token} targetToken - Целевой токен (для учета высоты)
   * @returns {object} Результат {coverage: number, hitPoints: [{x, y}]}
   */
  _calculateCircleTokenCoverage(circleCenter, circleRadius, tokenCenter, tokenRadius, collisionOptions = {}, whitelist = [], targetToken = null) {
    const effectiveRadius = tokenRadius; // callers pass _targetHitRadius(token)

    // Расстояние от центра круга до центра токена
    const distance = Math.hypot(tokenCenter.x - circleCenter.x, tokenCenter.y - circleCenter.y);
    
    // Быстрая проверка: токен вне круга (используем эффективный радиус)
    if (distance > circleRadius + effectiveRadius) return { coverage: 0, centerCovered: false, hitPoints: [] };

    // Сэмплирование: разбиваем токен на точки по кругу
    const sampleCount = 32; // Количество точек для сэмплирования
    const sampleRings = 3;  // Кольца сэмплирования (1 = центр + край)

    let hitCount = 0;
    let totalCount = 0;
    let centerCovered = false;
    const hitPoints = [];

    // Центр токена
    totalCount++;
    const centerInCircle = Math.hypot(tokenCenter.x - circleCenter.x, tokenCenter.y - circleCenter.y) <= circleRadius;
    if (centerInCircle) {
      // Проверяем LoS до центра токена
      const losCheck = this._checkLineOfSight(circleCenter, tokenCenter, collisionOptions, whitelist, targetToken);
      if (!losCheck.blocked) {
        hitCount++;
        centerCovered = true;
        hitPoints.push({ x: tokenCenter.x, y: tokenCenter.y });
      }
    }
    
    // Сэмплы по кольцам
    for (let ring = 1; ring <= sampleRings; ring++) {
      // Внешнее кольцо уменьшаем на 5%, чтобы точки были внутри токена
      const ringRadius = (effectiveRadius * ring) / sampleRings * 0.95;
      const pointsInRing = Math.max(8, Math.floor(sampleCount * ring / sampleRings));
      
      for (let i = 0; i < pointsInRing; i++) {
        const angle = (i / pointsInRing) * 2 * Math.PI;
        const samplePoint = {
          x: tokenCenter.x + Math.cos(angle) * ringRadius,
          y: tokenCenter.y + Math.sin(angle) * ringRadius
        };
        
        totalCount++;
        
        // Проверяем, находится ли точка в круге
        const pointInCircle = Math.hypot(samplePoint.x - circleCenter.x, samplePoint.y - circleCenter.y) <= circleRadius;
        if (pointInCircle) {
          // Проверяем LoS до точки сэмплирования
          const losCheck = this._checkLineOfSight(circleCenter, samplePoint, collisionOptions, whitelist, targetToken);
          if (!losCheck.blocked) {
            hitCount++;
            hitPoints.push({ x: samplePoint.x, y: samplePoint.y });
          }
        }
      }
    }

    return {
      coverage: hitCount / totalCount,
      centerCovered,
      hitPoints: hitPoints
    };
  }

  /**
   * Расчёт процента покрытия токена конусом (метод сэмплирования)
   * @private
   * @param {object} collisionOptions - Опции проверки collision {walls, tokens}
   * @param {Array} whitelist - Список игнорируемых токенов
   * @param {Token} targetToken - Целевой токен (для учета высоты)
   * @returns {object} Результат {coverage: number, hitPoints: [{x, y}]}
   */
  _calculateConeTokenCoverage(coneOrigin, coneRange, coneCut, coneDirectionRad, coneHalfAngleRad, tokenCenter, tokenRadius, collisionOptions = {}, whitelist = [], targetToken = null) {
    const effectiveRadius = tokenRadius; // callers pass _targetHitRadius(token)

    // Расстояние от начала конуса до центра токена
    const distance = Math.hypot(tokenCenter.x - coneOrigin.x, tokenCenter.y - coneOrigin.y);
    
    // Быстрая проверка: токен вне возможного радиуса (используем эффективный радиус)
    if (distance > coneRange + effectiveRadius || distance < coneCut - effectiveRadius) return { coverage: 0, centerCovered: false, hitPoints: [] };

    // Сэмплирование: разбиваем токен на точки по кругу
    const sampleCount = 32; // Количество точек для сэмплирования
    const sampleRings = 3;  // Кольца сэмплирования (1 = центр + край)

    let hitCount = 0;
    let totalCount = 0;
    let centerCovered = false;
    const hitPoints = [];

    // Центр токена
    totalCount++;
    if (this._isPointInCone(tokenCenter, coneOrigin, coneRange, coneCut, coneDirectionRad, coneHalfAngleRad)) {
      // Проверяем LoS до центра токена
      const losCheck = this._checkLineOfSight(coneOrigin, tokenCenter, collisionOptions, whitelist, targetToken);
      if (!losCheck.blocked) {
        hitCount++;
        centerCovered = true;
        hitPoints.push({ x: tokenCenter.x, y: tokenCenter.y });
      }
    }
    
    // Сэмплы по кольцам
    for (let ring = 1; ring <= sampleRings; ring++) {
      // Внешнее кольцо уменьшаем на 5%, чтобы точки были внутри токена
      const ringRadius = (effectiveRadius * ring) / sampleRings * 0.95;
      const pointsInRing = Math.max(8, Math.floor(sampleCount * ring / sampleRings));
      
      for (let i = 0; i < pointsInRing; i++) {
        const angle = (i / pointsInRing) * 2 * Math.PI;
        const samplePoint = {
          x: tokenCenter.x + Math.cos(angle) * ringRadius,
          y: tokenCenter.y + Math.sin(angle) * ringRadius
        };
        
        totalCount++;
        if (this._isPointInCone(samplePoint, coneOrigin, coneRange, coneCut, coneDirectionRad, coneHalfAngleRad)) {
          // Проверяем LoS до точки сэмплирования
          const losCheck = this._checkLineOfSight(coneOrigin, samplePoint, collisionOptions, whitelist, targetToken);
          if (!losCheck.blocked) {
            hitCount++;
            hitPoints.push({ x: samplePoint.x, y: samplePoint.y });
          }
        }
      }
    }

    return {
      coverage: hitCount / totalCount,
      centerCovered,
      hitPoints: hitPoints
    };
  }

  /**
   * Проверка, находится ли точка в конусе
   * @private
   */
  _isPointInCone(point, coneOrigin, coneRange, coneCut, coneDirectionRad, coneHalfAngleRad) {
    // Расстояние от начала конуса
    const distance = Math.hypot(point.x - coneOrigin.x, point.y - coneOrigin.y);
    
    // Проверяем радиус
    if (distance > coneRange || distance < coneCut) return false;
    
    // Угол к точке
    const pointAngle = Math.atan2(point.y - coneOrigin.y, point.x - coneOrigin.x);
    
    // Разница углов
    let angleDiff = pointAngle - coneDirectionRad;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
    
    // Проверяем угол
    return Math.abs(angleDiff) <= coneHalfAngleRad;
  }

  /**
   * Проверка пересечения отрезка с отрезком (для стен)
   * @private
   */
  _raySegmentIntersection(rayStart, rayEnd, segmentStart, segmentEnd) {
    const x1 = rayStart.x;
    const y1 = rayStart.y;
    const x2 = rayEnd.x;
    const y2 = rayEnd.y;
    
    const x3 = segmentStart.x;
    const y3 = segmentStart.y;
    const x4 = segmentEnd.x;
    const y4 = segmentEnd.y;
    
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    
    if (Math.abs(denom) < 1e-10) return null;
    
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
    
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return {
        x: x1 + t * (x2 - x1),
        y: y1 + t * (y2 - y1)
      };
    }
    
    return null;
  }

  /**
   * Проверка пересечения отрезка с кругом (для токенов)
   * @private
   */
  _rayCircleIntersection(rayStart, rayEnd, center, radius) {
    const dx = rayEnd.x - rayStart.x;
    const dy = rayEnd.y - rayStart.y;
    
    const fx = rayStart.x - center.x;
    const fy = rayStart.y - center.y;
    
    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = (fx * fx + fy * fy) - radius * radius;
    
    const discriminant = b * b - 4 * a * c;
    
    if (discriminant < 0) return null;
    
    const sqrtDiscriminant = Math.sqrt(discriminant);
    const t1 = (-b - sqrtDiscriminant) / (2 * a);
    const t2 = (-b + sqrtDiscriminant) / (2 * a);
    
    let t = -1;
    if (t1 >= 0 && t1 <= 1) {
      t = t1;
    } else if (t2 >= 0 && t2 <= 1) {
      t = t2;
    }
    
    if (t < 0) return null;
    
    return {
      x: rayStart.x + t * dx,
      y: rayStart.y + t * dy
    };
  }

  /**
   * Вычисление кратчайшего расстояния от центра круга до бесконечной прямой
   * @private
   * @param {object} rayStart - Начало луча {x, y}
   * @param {object} rayEnd - Конец луча {x, y}
   * @param {object} center - Центр круга {x, y}
   * @returns {number} Кратчайшее расстояние от центра до линии
   */
  _distanceFromPointToLine(rayStart, rayEnd, center) {
    const dx = rayEnd.x - rayStart.x;
    const dy = rayEnd.y - rayStart.y;
    
    // Длина отрезка
    const lineLength = Math.sqrt(dx * dx + dy * dy);
    
    if (lineLength === 0) {
      // Если начало и конец совпадают - возвращаем расстояние до точки
      return Math.hypot(center.x - rayStart.x, center.y - rayStart.y);
    }
    
    // Используем формулу расстояния от точки до прямой через векторное произведение
    // distance = |cross product| / |line vector|
    const crossProduct = Math.abs((center.x - rayStart.x) * dy - (center.y - rayStart.y) * dx);
    const distance = crossProduct / lineLength;
    
    return distance;
  }

  /**
   * Расчет угла между лучом и стеной
   * @private
   * @param {number} rayDirection - Направление луча в градусах
   * @param {object} wall - Объект стены
   * @returns {number} Угол между лучом и стеной в градусах (0-90)
   */
  _calculateWallAngle(rayDirection, wall) {
    // Направление стены
    const wallDx = wall.document.c[2] - wall.document.c[0];
    const wallDy = wall.document.c[3] - wall.document.c[1];
    const wallAngle = Math.atan2(wallDy, wallDx) * 180 / Math.PI;
    
    // Угол между лучом и стеной
    let angle = Math.abs(rayDirection - wallAngle);
    
    // Нормализуем угол к 0-180
    while (angle > 180) angle -= 360;
    while (angle < -180) angle += 360;
    angle = Math.abs(angle);
    
    // Приводим к 0-90 (острый угол)
    if (angle > 90) angle = 180 - angle;
    
    return angle;
  }

  /**
   * Расчет направления рикошета от стены
   * @private
   * @param {number} rayDirection - Направление луча в градусах
   * @param {object} wall - Объект стены
   * @returns {number} Новое направление после рикошета в градусах
   */
  _calculateWallRicochet(rayDirection, wall) {
    // Вектор направления луча (конвертируем градусы в вектор)
    const rayRadians = rayDirection * Math.PI / 180;
    const rayDir = {
      x: Math.cos(rayRadians),
      y: Math.sin(rayRadians)
    };
    
    // Вектор стены
    const wallVector = {
      x: wall.document.c[2] - wall.document.c[0],
      y: wall.document.c[3] - wall.document.c[1]
    };
    const wallLength = Math.hypot(wallVector.x, wallVector.y);
    
    // Нормаль к стене (перпендикуляр)
    const wallNormal = {
      x: -wallVector.y / wallLength,
      y: wallVector.x / wallLength
    };
    
    // Формула отражения: R = I - 2(I · N)N
    const dot = 2 * (rayDir.x * wallNormal.x + rayDir.y * wallNormal.y);
    const reflectedDir = {
      x: rayDir.x - dot * wallNormal.x,
      y: rayDir.y - dot * wallNormal.y
    };
    
    // Преобразуем в угол в градусах
    const reflectedAngle = Math.atan2(reflectedDir.y, reflectedDir.x) * (180 / Math.PI);
    
    return reflectedAngle;
  }

  /**
   * Расчет угла между лучом и касательной к токену
   * @private
   * @param {number} rayDirection - Направление луча в градусах
   * @param {object} hitPoint - Точка попадания {x, y}
   * @param {object} tokenCenter - Центр токена {x, y}
   * @returns {number} Угол между лучом и касательной в градусах (0-90)
   */
  _calculateTokenRicochetAngle(rayDirection, hitPoint, tokenCenter) {
    // Радиус-вектор от центра к точке попадания
    const radiusDx = hitPoint.x - tokenCenter.x;
    const radiusDy = hitPoint.y - tokenCenter.y;
    const radiusAngle = Math.atan2(radiusDy, radiusDx) * 180 / Math.PI;
    
    // Касательная перпендикулярна радиусу
    const tangentAngle = radiusAngle + 90;
    
    // Угол между лучом и касательной
    let angle = Math.abs(rayDirection - tangentAngle);
    
    // Нормализуем к 0-180
    while (angle > 180) angle -= 360;
    while (angle < -180) angle += 360;
    angle = Math.abs(angle);
    
    // Приводим к 0-90
    if (angle > 90) angle = 180 - angle;
    
    return angle;
  }

  /**
   * Расчет направления рикошета от токена
   * @private
   * @param {number} rayDirection - Направление луча в градусах
   * @param {object} hitPoint - Точка попадания {x, y}
   * @param {object} tokenCenter - Центр токена {x, y}
   * @returns {number} Новое направление после рикошета в градусах
   */
  _calculateTokenRicochet(rayDirection, hitPoint, tokenCenter) {
    // Вектор направления луча (конвертируем градусы в вектор)
    const rayRadians = rayDirection * Math.PI / 180;
    const rayDir = {
      x: Math.cos(rayRadians),
      y: Math.sin(rayRadians)
    };
    
    // Нормаль поверхности токена (радиус от центра к точке попадания)
    const radiusVector = {
      x: hitPoint.x - tokenCenter.x,
      y: hitPoint.y - tokenCenter.y
    };
    const radiusLength = Math.hypot(radiusVector.x, radiusVector.y);
    
    // Нормализуем нормаль
    const normal = {
      x: radiusVector.x / radiusLength,
      y: radiusVector.y / radiusLength
    };
    
    // Формула отражения: R = I - 2(I · N)N
    const dot = 2 * (rayDir.x * normal.x + rayDir.y * normal.y);
    const reflectedDir = {
      x: rayDir.x - dot * normal.x,
      y: rayDir.y - dot * normal.y
    };
    
    // Преобразуем в угол в градусах
    const reflectedAngle = Math.atan2(reflectedDir.y, reflectedDir.x) * (180 / Math.PI);
    
    return reflectedAngle;
  }

  /**
   * Проверка line of sight между двумя точками
   * @private
   * @param {object} start - Начальная точка {x, y}
   * @param {object} end - Конечная точка {x, y}
   * @param {object} options - Опции проверки {walls: boolean, tokens: boolean}
   * @param {Array} whitelist - Список игнорируемых токенов
   * @param {Token} targetToken - Целевой токен (для учета высоты при стакинге)
   * @returns {object} Результат {blocked: boolean, blockers: [{type, object, point}]}
   */
  _checkLineOfSight(start, end, options = {}, whitelist = [], targetToken = null) {
    const blockers = [];
    const checkWalls = options.walls !== false;
    const checkTokens = options.tokens !== false;
    
    // DEBUG
    const debugLoS = false; // включить для отладки
    if (debugLoS) {
      console.log('_checkLineOfSight:', { start, end, options, whitelist: whitelist.length });
    }
    
    // Проверка стен
    if (checkWalls && canvas.walls?.placeables) {
      for (const wall of canvas.walls.placeables) {
        if (!isShotBlockingWall(wall.document)) continue;
        
        const intersection = this._raySegmentIntersection(
          start,
          end,
          { x: wall.document.c[0], y: wall.document.c[1] },
          { x: wall.document.c[2], y: wall.document.c[3] }
        );
        
        if (intersection) {
          const distance = Math.hypot(
            intersection.x - start.x,
            intersection.y - start.y
          );
          
          blockers.push({
            type: 'wall',
            object: wall,
            point: intersection,
            distance: distance
          });
        }
      }
    }
    
    // Проверка токенов
    if (checkTokens && canvas.tokens?.placeables) {
      for (const token of canvas.tokens.placeables) {
        if (whitelist.includes(token)) continue;
        if (!token.visible) continue;
        
        // Если есть целевой токен, проверяем перекрытие по позиции
        if (targetToken && token !== targetToken) {
          const targetCenter = targetToken.center;
          const tokenCenter = token.center;
          const distanceBetween = Math.hypot(
            targetCenter.x - tokenCenter.x,
            targetCenter.y - tokenCenter.y
          );
          
          // Вычисляем радиусы токенов
          const targetBounds = targetToken.bounds;
          const targetRadius = Math.min(targetBounds.width, targetBounds.height) / 2;
          const tokenBounds = token.bounds;
          const tokenRadius = Math.min(tokenBounds.width, tokenBounds.height) / 2;
          
          // Если токены перекрываются (расстояние меньше суммы радиусов)
          if (distanceBetween < (targetRadius + tokenRadius)) {
            // Получаем z-высоту токенов (порядок рендеринга)
            const targetSort = targetToken.document.sort || 0;
            const tokenSort = token.document.sort || 0;
            
            // Если текущий токен ниже целевого по z - игнорируем его при проверке LoS
            if (tokenSort < targetSort) {
              continue;
            }
          }
        }
        
        const bounds = token.bounds;
        const centerX = bounds.x + bounds.width / 2;
        const centerY = bounds.y + bounds.height / 2;
        // Cover is smaller than the hit radius, so a blast on a target's surface starts outside it.
        const radius = this._targetCoverRadius(token);

        const intersection = this._rayCircleIntersection(
          start,
          end,
          { x: centerX, y: centerY },
          radius
        );
        
        if (intersection) {
          const distance = Math.hypot(
            intersection.x - start.x,
            intersection.y - start.y
          );
          
          blockers.push({
            type: 'token',
            object: token,
            point: intersection,
            distance: distance
          });
        }
      }
    }
    
    if (debugLoS && blockers.length > 0) {
      console.log('LoS blocked by:', blockers);
    }
    
    return {
      blocked: blockers.length > 0,
      blockers: blockers
    };
  }

  /**
   * Проверка столкновений сегмента с объектами (универсальный метод)
   * @param {object} segment - Сегмент {type, collision, props, ...}
   *   Для line: {start, end, type: 'line', collision, props, onHit}
   *   Для circle: {start, range, type: 'circle', collision, props, onHit}
   *   Для cone: {start, range, angle, direction, cut, type: 'cone', collision, props, onHit}
   * @param {Array} whitelist - Список игнорируемых объектов
   * @returns {Array} Массив столкновений {type, object, point, distance, details}
   */
  isHit(segment, whitelist = []) {
    // Проверяем наличие collision настроек
    // Если collision не определена, используем значения по умолчанию (проверяем оба)
    if (!segment.collision) {
      segment.collision = { walls: true, tokens: true };
    }
    
    if (segment.collision.walls === false && segment.collision.tokens === false) {
      return [];
    }

    // Определяем метод проверки на основе типа сегмента
    switch (segment.type) {
      case 'line':
        return this._isHitLine(segment, whitelist);
      case 'circle':
        return this._isHitCircle(segment, whitelist);
      case 'cone':
        return this._isHitCone(segment, whitelist);
      default:
        console.warn(`ShotManager: Unknown segment type in isHit: ${segment.type}`);
        return [];
    }
  }

  /**
   * Проверка столкновений для линейного сегмента
   * @private
   */
  _isHitLine(segment, whitelist) {
    const collisions = [];
    const checkWalls = segment.collision.walls !== false;
    const checkTokens = segment.collision.tokens !== false;
    
    // Проверка столкновений с токенами
    if (checkTokens && canvas.tokens?.placeables) {
      for (const token of canvas.tokens.placeables) {
        if (whitelist.includes(token)) continue;
        if (!token.visible) continue;
        
        const bounds = token.bounds;
        const centerX = bounds.x + bounds.width / 2;
        const centerY = bounds.y + bounds.height / 2;
        const effectiveRadius = this._targetHitRadius(token);

        const intersection = this._rayCircleIntersection(
          segment.start,
          segment.end,
          { x: centerX, y: centerY },
          effectiveRadius
        );
        
        if (intersection) {
          const distance = Math.hypot(
            intersection.x - segment.start.x,
            intersection.y - segment.start.y
          );
          
          // Вычисляем расстояние от центра токена до линии траектории
          const distanceToCenter = this._distanceFromPointToLine(
            segment.start,
            segment.end,
            { x: centerX, y: centerY }
          );

          // centrality: 1 = center, →0 at grazing. Orthographic: 1 - d/R = 1 - sin(α).
          const radiusSafe = effectiveRadius > 0 ? effectiveRadius : 1;
          const centrality = 1 - Math.min(Math.max(distanceToCenter / radiusSafe, 0), 1);
          const clock = this._hitClockHours(token, intersection, { x: centerX, y: centerY });

          // Угол луч ↔ радиус BC (0° в центре, 90° на краю) — для отладки, в чат не идёт.
          const vecSH_x = intersection.x - segment.start.x;
          const vecSH_y = intersection.y - segment.start.y;
          const vecHC_x = centerX - intersection.x;
          const vecHC_y = centerY - intersection.y;
          
          const lenSH = Math.sqrt(vecSH_x * vecSH_x + vecSH_y * vecSH_y);
          const lenHC = Math.sqrt(vecHC_x * vecHC_x + vecHC_y * vecHC_y);
          
          let angleDeg = 0;
          if (lenSH > 0 && lenHC > 0) {
            const dotProduct = vecSH_x * vecHC_x + vecSH_y * vecHC_y;
            const cosAngle = dotProduct / (lenSH * lenHC);
            const angleRad = Math.acos(Math.min(Math.max(cosAngle, -1), 1));
            angleDeg = (angleRad * 180) / Math.PI;
          }
          
          collisions.push({
            type: 'token',
            object: token,
            point: intersection,
            distance: distance,
            details: {
              distanceToCenter: distanceToCenter,
              centrality: centrality,
              clock: clock,
              angleDeg: angleDeg
            }
          });
        }
      }
    }
    
    // Проверка столкновений со стенами
    if (checkWalls && canvas.walls?.placeables) {
      for (const wall of canvas.walls.placeables) {
        if (!isShotBlockingWall(wall.document)) continue;
        
        const intersection = this._raySegmentIntersection(
          segment.start,
          segment.end,
          { x: wall.document.c[0], y: wall.document.c[1] },
          { x: wall.document.c[2], y: wall.document.c[3] }
        );
        
        if (intersection) {
          const distance = Math.hypot(
            intersection.x - segment.start.x,
            intersection.y - segment.start.y
          );
          
          collisions.push({
            type: 'wall',
            object: wall,
            point: intersection,
            distance: distance,
            details: {}
          });
        }
      }
    }
    
    // Сортируем по расстоянию (по умолчанию)
    collisions.sort((a, b) => a.distance - b.distance);
    
    return collisions;
  }

  /**
   * Сортировка и фильтрация попаданий по параметрам hitOrder и hitAmount
   * @private
   * @param {Array} collisions - Массив попаданий
   * @param {string} hitOrder - Порядок выбора: 'near', 'far', 'left', 'right'
   * @param {number|undefined} hitAmount - Количество попаданий (undefined = все)
   * @param {object} sourcePoint - Точка источника для расчёта направлений
   * @returns {Array} Отфильтрованный массив попаданий
   */
  _applyHitOrderAndAmount(collisions, hitOrder, hitAmount, sourcePoint) {
    if (collisions.length === 0) return collisions;
    
    // Работаем со всеми попаданиями (токены и стены)
    let sortedCollisions = [...collisions];
    
    // Применяем hitOrder (сортировку)
    switch (hitOrder) {
      case 'far':
        // Сортируем от дальних к ближним
        sortedCollisions.sort((a, b) => b.distance - a.distance);
        break;
        
      case 'left':
        // Сортируем слева направо (по x-координате относительно источника)
        sortedCollisions.sort((a, b) => {
          const relA = a.point.x - sourcePoint.x;
          const relB = b.point.x - sourcePoint.x;
          return relA - relB;
        });
        break;
        
      case 'right':
        // Сортируем справа налево (по x-координате относительно источника)
        sortedCollisions.sort((a, b) => {
          const relA = a.point.x - sourcePoint.x;
          const relB = b.point.x - sourcePoint.x;
          return relB - relA;
        });
        break;
        
      case 'near':
      default:
        // Уже отсортировано по расстоянию (от ближних к дальним)
        break;
    }
    
    // Применяем hitAmount
    if (hitAmount !== undefined && hitAmount > 0) {
      return sortedCollisions.slice(0, hitAmount);
    }
    
    // Если hitAmount не задан или 0/-1, возвращаем все
    return sortedCollisions;
  }

  /**
   * Collision options for AoE coverage sampling. `lineOfSight: false` turns line-of-sight
   * checks off entirely (walls and token cover), e.g. for a spell that ignores cover.
   * @private
   * @param {object} segment segment with `collision` and optional `lineOfSight`
   * @returns {object}
   */
  _areaLosOptions(segment) {
    return normalizeAreaLineOfSight(segment.lineOfSight)
      ? segment.collision
      : { walls: false, tokens: false };
  }

  /**
   * Direct-hit token lists for the AoE options. A "direct hit" is a token this shot already
   * struck by contact (line / swing — AoE hits do not count).
   * - `excludeDirectHit` → `excludeTokens`: not affected by the AoE. They still act as cover.
   * - `ignoreDirectHitCover` → `coverIgnoreTokens`: do not shield others from the AoE.
   * The two are independent.
   * @private
   * @param {object} segment segment with optional `excludeDirectHit` / `ignoreDirectHitCover`
   * @param {object} shot shot being built (`actualHits` holds earlier segments' hits)
   * @returns {{excludeTokens: Token[], coverIgnoreTokens: Token[]}}
   */
  _areaTokenFilters(segment, shot) {
    const exclude = normalizeAreaExcludeDirectHit(segment.excludeDirectHit);
    const ignoreCover = normalizeAreaIgnoreDirectHitCover(segment.ignoreDirectHitCover);
    if (!exclude && !ignoreCover) return { excludeTokens: [], coverIgnoreTokens: [] };
    const direct = [];
    for (const hit of shot?.actualHits ?? []) {
      if (hit?.type !== 'token' || hit.details?.area || !hit.object) continue;
      if (!direct.includes(hit.object)) direct.push(hit.object);
    }
    return {
      excludeTokens: exclude ? direct : [],
      coverIgnoreTokens: ignoreCover ? direct : [],
    };
  }

  /**
   * Collision entry for a token touched by an AoE (circle / cone), or null when the
   * segment's `coverageMode` says it is not affected. AoE hits carry no aiming luck and
   * no centrality — only sampled coverage and the resulting `effectScale` (0–1).
   * @private
   * @param {Token} token
   * @param {{x: number, y: number}} origin AoE origin (used for the hit face / clock)
   * @param {object} segment segment with optional `coverageMode`
   * @param {{coverage: number, centerCovered: boolean, hitPoints: object[]}} sample
   * @param {number} distance origin → token center (px)
   * @returns {object|null}
   */
  _buildAreaTokenCollision(token, origin, segment, sample, distance) {
    const effect = resolveAreaCoverageEffect(segment.coverageMode, sample, segment.coverageForFullEffect);
    if (!effect.applies) return null;
    const tokenCenter = token.center;
    return {
      type: 'token',
      object: token,
      point: { ...tokenCenter },
      distance,
      details: {
        area: true,
        blast: segment.blast === true,
        coverage: sample.coverage,
        coverageMode: effect.mode,
        effectScale: effect.scale,
        centerCovered: sample.centerCovered,
        // Face toward the AoE origin (12 = target's front) so armour facing matches line hits.
        clock: this._hitClockHours(token, origin, tokenCenter),
        hitPoints: sample.hitPoints,
      },
    };
  }

  /**
   * Проверка столкновений для кругового сегмента (взрыв)
   * @private
   */
  _isHitCircle(segment, whitelist) {
    const collisions = [];
    const checkTokens = segment.collision?.tokens !== false;
    const shooterToken = segment.shooterToken;
    const circleCenter = segment.start;
    const circleRadius = segment.range;

    if (checkTokens && canvas.tokens?.placeables) {
    for (const token of canvas.tokens.placeables) {
      if (whitelist.includes(token)) continue;
      if (segment.excludeTokens?.includes(token)) continue;
      if (!token.visible) continue;
      
      // Проверка диспозиции
      if (shooterToken && this._shouldIgnoreByDisposition(token, segment, shooterToken)) {
        continue;
      }
      
      const tokenCenter = token.center;
      const tokenRadius = this._targetHitRadius(token);

      // Расстояние от центра круга до центра токена
      const distance = Math.hypot(
        tokenCenter.x - circleCenter.x,
        tokenCenter.y - circleCenter.y
      );
      
      // Если токен в радиусе (с учётом радиуса токена)
      if (distance <= circleRadius + tokenRadius) {
      // Добавляем токен в whitelist + токены с игнорируемой диспозицией
      const extendedWhitelist = this._buildExtendedWhitelist(whitelist, token, segment, shooterToken);
      
      // Рассчитываем процент покрытия через сэмплирование
      const result = this._calculateCircleTokenCoverage(
        circleCenter, circleRadius, tokenCenter, tokenRadius,
        this._areaLosOptions(segment), extendedWhitelist, token
      );
        
        // Попадание добавляем, если coverageMode сегмента считает токен задетым
        const collision = this._buildAreaTokenCollision(token, circleCenter, segment, result, distance);
        if (collision) collisions.push(collision);
      }
    }
    }
    
    // Проверка столкновений со стенами (отрезок стены пересекает круг)
    const checkWalls = segment.collision?.walls !== false;
    if (checkWalls && canvas.walls?.placeables) {
      for (const wall of canvas.walls.placeables) {
        if (!isShotBlockingWall(wall.document)) continue;
        const wallStart = { x: wall.document.c[0], y: wall.document.c[1] };
        const wallEnd = { x: wall.document.c[2], y: wall.document.c[3] };
        const hit = this._rayCircleIntersection(wallStart, wallEnd, circleCenter, circleRadius);
        if (hit) {
          const distance = Math.hypot(hit.x - circleCenter.x, hit.y - circleCenter.y);
          collisions.push({
            type: 'wall',
            object: wall,
            point: hit,
            distance: distance,
            details: {}
          });
        }
      }
    }
    
    // Сортируем по расстоянию
    collisions.sort((a, b) => a.distance - b.distance);
    
    return collisions;
  }

  /**
   * Проверка столкновений для конусного сегмента
   * @private
   */
  _isHitCone(segment, whitelist) {
    const collisions = [];
    const checkTokens = segment.collision?.tokens !== false;
    const shooterToken = segment.shooterToken;
    const coneOrigin = segment.start;
    const coneRange = segment.range;
    const coneCut = segment.cut || 0;
    const coneDirectionRad = (segment.direction * Math.PI) / 180;
    const coneHalfAngleRad = ((segment.angle || 90) / 2 * Math.PI) / 180;

    if (checkTokens && canvas.tokens?.placeables) {
    for (const token of canvas.tokens.placeables) {
      if (whitelist.includes(token)) continue;
      if (segment.excludeTokens?.includes(token)) continue;
      if (!token.visible) continue;
      
      // Проверка диспозиции
      if (shooterToken && this._shouldIgnoreByDisposition(token, segment, shooterToken)) {
        continue;
      }
      
      const tokenCenter = token.center;
      const tokenRadius = this._targetHitRadius(token);

      // Расстояние от начала конуса до центра токена
      const distance = Math.hypot(
        tokenCenter.x - coneOrigin.x,
        tokenCenter.y - coneOrigin.y
      );
      
      // Быстрая проверка: токен вне возможного радиуса
      if (distance > coneRange + tokenRadius || distance < coneCut - tokenRadius) {
        continue;
      }
      
      // Добавляем токен в whitelist + токены с игнорируемой диспозицией
      const extendedWhitelist = this._buildExtendedWhitelist(whitelist, token, segment, shooterToken);
      
      // Рассчитываем процент покрытия через сэмплирование
      const result = this._calculateConeTokenCoverage(
        coneOrigin, coneRange, coneCut, coneDirectionRad, coneHalfAngleRad,
        tokenCenter, tokenRadius, this._areaLosOptions(segment), extendedWhitelist, token
      );
      
      // Попадание добавляем, если coverageMode сегмента считает токен задетым
      const collision = this._buildAreaTokenCollision(token, coneOrigin, segment, result, distance);
      if (collision) collisions.push(collision);
    }
    }
    
    // Проверка столкновений со стенами (сектор конуса пересекает отрезок стены)
    const checkWalls = segment.collision?.walls !== false;
    if (checkWalls && canvas.walls?.placeables) {
      const ray1End = {
        x: coneOrigin.x + coneRange * Math.cos(coneDirectionRad - coneHalfAngleRad),
        y: coneOrigin.y + coneRange * Math.sin(coneDirectionRad - coneHalfAngleRad)
      };
      const ray2End = {
        x: coneOrigin.x + coneRange * Math.cos(coneDirectionRad + coneHalfAngleRad),
        y: coneOrigin.y + coneRange * Math.sin(coneDirectionRad + coneHalfAngleRad)
      };
      for (const wall of canvas.walls.placeables) {
        if (!isShotBlockingWall(wall.document)) continue;
        const wallStart = { x: wall.document.c[0], y: wall.document.c[1] };
        const wallEnd = { x: wall.document.c[2], y: wall.document.c[3] };
        const candidates = [];
        const p1 = this._raySegmentIntersection(coneOrigin, ray1End, wallStart, wallEnd);
        if (p1) candidates.push(p1);
        const p2 = this._raySegmentIntersection(coneOrigin, ray2End, wallStart, wallEnd);
        if (p2) candidates.push(p2);
        const p3 = this._rayCircleIntersection(wallStart, wallEnd, coneOrigin, coneRange);
        if (p3 && this._isPointInCone(p3, coneOrigin, coneRange, coneCut, coneDirectionRad, coneHalfAngleRad)) candidates.push(p3);
        const p4 = this._rayCircleIntersection(wallStart, wallEnd, coneOrigin, coneCut);
        if (p4 && this._isPointInCone(p4, coneOrigin, coneRange, coneCut, coneDirectionRad, coneHalfAngleRad)) {
          const d = Math.hypot(p4.x - coneOrigin.x, p4.y - coneOrigin.y);
          if (d >= coneCut - 1e-6) candidates.push(p4);
        }
        if (candidates.length === 0) continue;
        const closest = candidates.reduce((best, p) => {
          const d = Math.hypot(p.x - coneOrigin.x, p.y - coneOrigin.y);
          return (d >= coneCut && d <= coneRange && (!best || d < best.distance)) ? { point: p, distance: d } : best;
        }, null);
        if (closest) {
          collisions.push({
            type: 'wall',
            object: wall,
            point: closest.point,
            distance: closest.distance,
            details: {}
          });
        }
      }
    }
    
    // Сортируем по расстоянию
    collisions.sort((a, b) => a.distance - b.distance);
    
    return collisions;
  }

  /**
   * Построение расширенного whitelist с токенами игнорируемой диспозиции
   * @private
   * @param {Array} whitelist - Базовый whitelist
   * @param {Token} targetToken - Целевой токен (не блокирует сам себя)
   * @param {object} segment - Сегмент с настройками collision
   * @param {Token} shooterToken - Токен, который стреляет
   * @returns {Array} Расширенный whitelist
   */
  _buildExtendedWhitelist(whitelist, targetToken, segment, shooterToken) {
    // `coverIgnoreTokens` (ignoreDirectHitCover): tokens that do not shield anyone from this AoE.
    const extended = [...whitelist, targetToken, ...(segment.coverIgnoreTokens ?? [])];
    
    if (!shooterToken || !canvas.tokens?.placeables) {
      return extended;
    }
    
    // Добавляем все токены с игнорируемой диспозицией
    for (const token of canvas.tokens.placeables) {
      if (this._shouldIgnoreByDisposition(token, segment, shooterToken)) {
        if (!extended.includes(token)) {
          extended.push(token);
        }
      }
    }
    
    return extended;
  }

  /**
   * Проверка необходимости игнорирования токена по диспозиции
   * @private
   * @param {Token} targetToken - Токен, в который попали
   * @param {object} segment - Сегмент с настройками collision
   * @param {Token} shooterToken - Токен, который стреляет
   * @returns {boolean} true если токен нужно игнорировать
   */
  _shouldIgnoreByDisposition(targetToken, segment, shooterToken) {
    const tokenConfig = segment.collision?.tokens;
    
    // Старый формат или tokens = true/false
    if (typeof tokenConfig === 'boolean' || !tokenConfig) {
      return false;
    }
    
    // Проверка owner
    if (targetToken === shooterToken) {
      return !tokenConfig.owner; // Игнорировать если owner: false
    }
    
    const shooterDisposition = shooterToken.document.disposition;
    const targetDisposition = targetToken.document.disposition;
    
    // Проверка ally (одинаковая диспозиция)
    if (shooterDisposition === targetDisposition) {
      return !tokenConfig.ally; // Игнорировать если ally: false
    }
    
    // Проверка other (разная диспозиция)
    return !tokenConfig.other; // Игнорировать если other: false
  }

  /**
   * Расчёт координат конечной точки линии
   * @param {object} start - Начальная точка {x, y}
   * @param {number} direction - Направление в градусах
   * @param {number} length - Длина линии
   * @param {number} defSize - Единица измерения
   * @returns {object} Конечная точка {x, y}
   */
  shotLine(start, direction, length, defSize) {
    const radians = (direction * Math.PI) / 180;
    const distance = length * defSize;
    
    return {
      x: start.x + Math.cos(radians) * distance,
      y: start.y + Math.sin(radians) * distance
    };
  }

  /**
   * Обработка одного сегмента траектории
   * @param {object} segment - Сегмент из payload
   * @param {object} context - Контекст выстрела (lastPos, direction, defSize, whitelist, shot)
   * @returns {object} Результат обработки {endPos, direction, shouldContinue}
   */
  shotSegment(segment, context) {
    const { lastPos, direction, defSize, whitelist, shot } = context;
    
    // Выбираем обработчик в зависимости от типа сегмента
    switch (segment.type) {
      case 'line':
        return this._processLineSegment(segment, context);
      case 'circle':
        return this._processCircleSegment(segment, context);
      case 'cone':
        return this._processConeSegment(segment, context);
      case 'swing':
        return this._processEdgeSwingSegment(segment, context);
      case 'swingFan':
      case 'legacySwing':
        return this._processSwingFanSegment(segment, context);
      case 'complexLine':
        return this._processComplexLineSegment(segment, context);
      default:
        console.warn(`ShotManager: Unknown segment type: ${segment.type}`);
        return {
          endPos: lastPos,
          direction: direction,
          shouldContinue: false
        };
    }
  }

  /**
   * План пробития стен для прямого сегмента: какие стены снаряд проходит (и с каким остатком
   * энергии), а какая его останавливает. `null` — старое поведение (любая стена останавливает):
   * выстрел без снаряда, `onHit: 'need'` (ракета/осколки взрываются на первом касании) и сегмент
   * без стен.
   * @private
   * @param {object} shot
   * @param {{x:number,y:number}} start
   * @param {{x:number,y:number}} end
   * @param {Array} collisions столкновения сегмента, по порядку полёта
   * @param {string} onHit
   * @param {Object} [projectile] снаряд, который идёт через стены, если это не `shot.penetration` (то, что
   *   осталось от пули после тела: `applications` и уровень дальности `energyLevel`, который они уже несут)
   * @returns {object|null} результат `planWallPasses`
   */
  _planWallPasses(shot, start, end, collisions, onHit, projectile = null) {
    const applications = projectile?.applications ?? shot?.penetration?.applications;
    if (!applications?.length) return null;
    if (onHit !== 'stop' && onHit !== 'next') return null;
    const crossings = collisions
      .map((collision) => wallCrossingFromCollision(collision))
      .filter(Boolean);
    if (!crossings.length) return null;
    return planWallPasses({
      crossings,
      rayStart: start,
      rayEnd: end,
      applications,
      resolveMaterial: (id) => materialsManager.getMaterial(id),
      pxPerThickness: getPxPerThicknessUnit(),
      energyAt: (point) => this.falloffAt(shot, point),
      energyLevel: projectile?.energyLevel ?? shot.penetration?.energyLevel ?? 1,
    });
  }

  /**
   * Что осталось от луча `stop` за телом, остановившим его: токены и стены за ним на том же прямом сегменте
   * (по порядку полёта) и конец сегмента. Луч по-прежнему кончается на первом токене; если пуля выйдет
   * из тела, {@link continueShot} пустит её по этому хвосту.
   * @private
   * @param {object} shot
   * @param {object} anchor столкновение токена, остановившего луч
   * @param {Array} collisions столкновения сегмента (после диспозиции), по порядку полёта
   * @param {{x:number,y:number}} start начало сегмента
   * @param {{x:number,y:number}} end конец сегмента (дальность), а не точка попадания
   */
  _keepTail(shot, anchor, collisions, start, end) {
    if (!shot?.penetration?.applications?.length || anchor?.type !== 'token') return;
    const index = collisions.indexOf(anchor);
    if (index < 0) return;
    // Nothing behind the body is fine too: a bullet that leaves it still flies on to the end of the segment.
    shot.tail = {
      anchor,
      collisions: collisions.slice(index + 1),
      start: { ...start },
      end: { ...end },
      used: false,
    };
  }

  /**
   * Записать в выстрел стены, которые снаряд действительно встретил (до `limit` px от начала
   * сегмента), и обновить летящий снаряд — следующий сегмент продолжит с остатком энергии.
   * @private
   * @param {object} shot
   * @param {object|null} plan результат `_planWallPasses`
   * @param {number} limit расстояние, дальше которого снаряд не летит
   */
  _recordWallPlan(shot, plan, limit) {
    if (!plan) return;
    const events = plan.events.filter((event) => event.entryDistance <= limit + 1e-6);
    if (!events.length) return;
    shot.wallPasses.push(...events);
    shot.shotResult.wallPasses.push(...events.map((event) => ({
      entryPoint: event.entryPoint,
      exitPoint: event.exitPoint,
      penetrated: event.penetrated,
    })));
    const carry = plan.carryAt(limit);
    if (carry) {
      shot.penetration.applications = carry;
      shot.penetration.energyLevel = plan.levelAt(limit);
    }
  }

  /**
   * Пуля вышла из тела, остановившего луч: пустить её дальше по хвосту (`shot.tail`) с тем, что от неё
   * осталось (см. `followProjectileThroughBodies`). Стены за телом проходит остаток, а не снаряд из
   * ствола. Что пуля встретила, дописывается в выстрел (`actualHits`, `shotResult`, `wallPasses`,
   * `passedThrough`), а продолжение следа лежит в `shot.extension` — отдельной записью, которую
   * вызывающий рисует и рассылает после урона (первая запись уже нарисована).
   *
   * @param {object} shot
   * @param {Object} args
   * @param {object} args.anchor столкновение токена, из тела которого вышла пуля (`shot.tail.anchor`)
   * @param {Array<{mode: string, items: object[]}>} args.exit что вышло из тела (`exitApplications`)
   * @param {(collision: object, carry: object[]) => Promise<object[]|null|undefined>} args.deliver
   *   пуля достигла токена с `carry`; вернуть то, что вышло из его тела (или пусто, если застряла)
   * @returns {Promise<{hits: object[], end: {reason: string}, extension: object|null}|null>} `null` —
   *   продолжать нечего (хвоста нет, он уже пройден или пуля из другого тела)
   */
  async continueShot(shot, { anchor, exit, deliver } = {}) {
    const tail = shot?.tail;
    if (!tail || tail.used || tail.anchor !== anchor || !Array.isArray(exit) || !exit.length) return null;
    tail.used = true;
    const result = await followProjectileThroughBodies({
      collisions: tail.collisions,
      exit,
      level: this.falloffAt(shot, anchor.point),
      passState: shot,
      judgeToken: shot.judgeToken,
      planWalls: (collisions, applications, energyLevel) => this._planWallPasses(
        shot, tail.start, tail.end, collisions, 'stop', { applications, energyLevel }
      ),
      levelAt: (collision) => this.falloffAt(shot, collision.point),
      scale: applyEnergyScaleToApplications,
      deliver,
    });
    return { hits: result.hits, end: result.end, extension: this._recordContinuation(shot, tail, result) };
  }

  /**
   * Дописать в выстрел полёт после тела и собрать запись продолжения следа: отрезки от точки выхода
   * через каждое достигнутое тело до стены, остановившей пулю, или до конца сегмента.
   * @private
   * @returns {object|null} ShotRecord (id `<uid>.x`, время выстрела) или null, если пуля не пролетела дальше
   */
  _recordContinuation(shot, tail, { hits, wallEvents, end }) {
    const ext = { shotPaths: [], shotHits: [], wallPasses: [] };
    let from = tail.anchor.point;
    for (const hit of hits) {
      ext.shotPaths.push({ start: { ...from }, end: { ...hit.point }, type: 'line' });
      ext.shotHits.push({ point: hit.point, type: hit.type, object: hit.object, ...hit.details });
      shot.actualHits.push(hit);
      from = hit.point;
    }
    // Out of the last body and nothing in the way: it flies to the end of the segment.
    if (end.reason === 'range') ext.shotPaths.push({ start: { ...from }, end: { ...tail.end }, type: 'line' });
    if (wallEvents.length) {
      shot.wallPasses.push(...wallEvents);
      ext.wallPasses.push(...wallEvents.map((event) => ({
        entryPoint: event.entryPoint,
        exitPoint: event.exitPoint,
        penetrated: event.penetrated,
      })));
    }
    if (!ext.shotPaths.length) return null;

    shot.shotResult.shotPaths.push(...ext.shotPaths);
    shot.shotResult.shotHits.push(...ext.shotHits);
    shot.shotResult.wallPasses.push(...ext.wallPasses);
    const base = shot.record ?? {};
    shot.extension = buildShotRecord({ uid: `${shot.uid}.x`, shotResult: ext }, {
      t: base.t,
      sceneId: base.sceneId,
      tokenId: base.tokenId,
      userId: base.userId,
    });
    return shot.extension;
  }

  /**
   * Обработка линейного сегмента
   * @private
   */
  _processLineSegment(segment, context) {
    const { lastPos, direction, defSize, whitelist, shot, shooterToken } = context;
    
    // Вычисляем абсолютное направление сегмента
    const absoluteDirection = direction + segment.direction;
    
    // Расчёт конечной точки для данного сегмента
    let endPos = this.shotLine(lastPos, absoluteDirection, segment.length, defSize);
    
    // Создаём временный объект сегмента для проверки
    const testSegment = {
      start: { ...lastPos },
      end: { ...endPos },
      type: segment.type,
      collision: segment.collision,
      props: segment.props,
      onHit: segment.onHit
    };
    
    // Проверяем столкновения
    const collisions = this.isHit(testSegment, whitelist);
    
    // Фильтруем по диспозиции ДО дальнейших действий
    const validCollisions = collisions.filter(collision => {
      if (collision.type === 'wall') return true;
      return !this._shouldIgnoreByDisposition(collision.object, segment, shooterToken);
    });
    
    // Определяем, продолжать ли выстрел на основе onHit
    let shouldContinue = true;
    const onHit = segment.onHit || "stop";

    // Попадания по порядку полёта: стена останавливает (если снаряд не пробивает её — см.
    // _planWallPasses), токены, мимо которых снаряд пролетел, пропускаются —
    // см. walkProjectileCollisions (hit-luck.mjs).
    const wallPlan = this._planWallPasses(shot, testSegment.start, endPos, validCollisions, onHit);
    const reached = walkProjectileCollisions(validCollisions, onHit, shot, wallPlan, { judgeToken: shot.judgeToken });
    // Стены за токеном, остановившим выстрел, снаряд уже не встречает.
    this._recordWallPlan(shot, wallPlan, onHit === 'stop' && reached.length ? reached[0].distance : Infinity);

    if (reached.length > 0) {
      // Решение о продолжении на основе первого настоящего попадания
      if (onHit === "stop") {
        // Простая линия: добавляем ТОЛЬКО первое попадание и останавливаемся
        const firstCollision = reached[0];
        shot.shotResult.shotHits.push({
          point: firstCollision.point,
          type: firstCollision.type,
          object: firstCollision.object,
          ...firstCollision.details
        });
        shot.actualHits.push(firstCollision);

        // A bullet that leaves the body goes on along the rest of the segment (see continueShot).
        this._keepTail(shot, firstCollision, validCollisions, testSegment.start, testSegment.end);
        shouldContinue = false;
        endPos = firstCollision.point;
      } else if (onHit === "next" || onHit === "need") {
        // `next` — проникновение: все попадания до стены включительно.
        // `need` — только первое касание (ракета взрывается на цели); выстрел продолжается от него.
        for (const collision of reached) {
          shot.shotResult.shotHits.push({
            point: collision.point,
            type: collision.type,
            object: collision.object,
            ...collision.details
          });
          shot.actualHits.push(collision);
        }

        shouldContinue = true;
        endPos = reached[0].point;
        // A blast that goes off on a wall starts just off it: on the wall itself, line of sight from
        // the blast to every target on the open side would be cut by that same wall.
        if (onHit === "need" && reached[0].type === 'wall') {
          endPos = backOffFromWall(reached[0].point, testSegment.start);
        }
      }
    } else {
      // Ничего не остановило снаряд (нет столкновений либо он пролетел мимо всех токенов)
      if (onHit === "need") {
        // Останавливаем выстрел, если попадания не было, а оно требовалось
        shouldContinue = false;
      } else {
        // По умолчанию продолжаем дальше
        shouldContinue = true;
      }
    }

    // Создаём объект пути для сохранения
    const path = {
      start: { ...lastPos },
      end: { ...endPos },
      type: segment.type
    };

    shot.shotResult.shotPaths.push(path);

    return {
      endPos: endPos,
      direction: absoluteDirection,
      shouldContinue: shouldContinue
    };
  }

  /**
   * Обработка кругового сегмента (взрыв)
   * @private
   */
  _processCircleSegment(segment, context) {
    const { lastPos, direction, defSize, whitelist, shot, shooterToken } = context;
    
    // Для круга используем lastPos как центр
    const range = segment.range * defSize;
    
    // Создаём объект сегмента для проверки через isHit
    const testSegment = {
      start: { ...lastPos },
      range: range,
      type: segment.type,
      collision: segment.collision,
      coverageMode: segment.coverageMode,
      lineOfSight: segment.lineOfSight,
      coverageForFullEffect: segment.coverageForFullEffect,
      ...this._areaTokenFilters(segment, shot),
      props: segment.props,
      onHit: segment.onHit,
      shooterToken: shooterToken
    };
    
    // Проверяем столкновения через универсальный метод
    const collisions = this.isHit(testSegment, whitelist);
    
    // Применяем hitOrder и hitAmount для фильтрации попаданий
    const hitOrder = segment.hitOrder || 'near';
    const hitAmount = segment.hitAmount;
    const filteredCollisions = this._applyHitOrderAndAmount(collisions, hitOrder, hitAmount, lastPos);
    
    // Определяем, продолжать ли выстрел на основе onHit
    let shouldContinue = true;
    
    if (filteredCollisions.length > 0) {
      // Определяем onHit на основе сегмента
      const onHit = segment.onHit || "next";
      
      // Обрабатываем отфильтрованные столкновения
      for (const collision of filteredCollisions) {
        shot.shotResult.shotHits.push({
          point: collision.point,
          type: collision.type,
          object: collision.object,
          ...collision.details
        });
        
        shot.actualHits.push(collision);
      }
      
      // Решение о продолжении на основе первого попадания
      if (onHit === "stop") {
        shouldContinue = false;
      } else if (onHit === "next" || onHit === "need") {
        shouldContinue = true;
      }
    } else {
      // Нет столкновений
      const onHit = segment.onHit || "next";
      
      if (onHit === "need") {
        // Останавливаем выстрел, если попадания не было, а оно требовалось
        shouldContinue = false;
      } else {
        // По умолчанию продолжаем дальше
        shouldContinue = true;
      }
    }
    
    // Создаём объект пути для визуализации
    const path = {
      start: { ...lastPos },
      range: range,
      type: segment.type
    };
    
    shot.shotResult.shotPaths.push(path);
    
    return {
      endPos: lastPos,
      direction: direction,
      shouldContinue: shouldContinue
    };
  }

  /**
   * Обработка сложного сегмента swing - серия конусов с изменяющимися параметрами
   * @private
   * @param {object} segment - Сегмент swing
   *   {
   *     type: 'swing',
   *     direction: начальное направление,
   *     range: начальная дальность,
   *     angle: угол конуса,
   *     cut: отсечение,
   *     directionStep: шаг изменения направления (в градусах),
   *     rangeStep: шаг изменения дальности,
   *     count: количество конусов,
   *     collision: {...},
   *     props: {...},
   *     onHit: 'stop' | 'next' | 'skip' | 'need'
   *   }
   * @param {object} context - Контекст выстрела
   * @returns {object} Результат {endPos, direction, shouldContinue}
   */
  /**
   * Legacy stepped-cone swing (formerly `swing`). Prefer `swingFan` in payloads.
   * @private
   */
  _processSwingFanSegment(segment, context) {
    const { lastPos, direction, defSize, whitelist, shot } = context;

    const count = segment.count || 1;
    const directionStep = segment.directionStep || 0;
    const rangeStep = segment.rangeStep || 0;

    let currentDirection = segment.direction || 0;
    let currentRange = segment.range;
    const angle = segment.angle || 90;
    const cut = segment.cut || 0;

    let shouldContinue = true;
    let finalDirection = direction + currentDirection;
    const onHit = segment.onHit || 'next';

    for (let i = 0; i < count; i++) {
      const hitsBefore = shot.actualHits.length;
      const coneSegment = {
        type: 'cone',
        direction: currentDirection,
        range: currentRange,
        angle,
        cut,
        collision: segment.collision,
        coverageMode: segment.coverageMode,
        lineOfSight: segment.lineOfSight,
        excludeDirectHit: segment.excludeDirectHit,
        ignoreDirectHitCover: segment.ignoreDirectHitCover,
        coverageForFullEffect: segment.coverageForFullEffect,
        props: segment.props,
        onHit: 'next',
        hitOrder: segment.hitOrder,
        hitAmount: segment.hitAmount,
      };
      const result = this._processConeSegment(coneSegment, context);
      finalDirection = result.direction;
      const hadHitInThisCone = shot.actualHits.length > hitsBefore;

      if (hadHitInThisCone) {
        if (onHit === 'stop') {
          shouldContinue = false;
          break;
        }
        if (onHit === 'skip') {
          shouldContinue = true;
          break;
        }
      } else if (onHit === 'need') {
        shouldContinue = false;
        break;
      }

      currentDirection += directionStep;
      currentRange += rangeStep;
    }

    return {
      endPos: lastPos,
      direction: finalDirection,
      shouldContinue,
    };
  }

  /**
   * Swing: a cone volume with a rotating edge line from the origin. The sweep stops at the first
   * wall or token the edge touches (the blow lands on it); `hitMode` decides who is damaged and
   * with what centrality — see {@link SWING_HIT_MODES}.
   * @private
   */
  _processEdgeSwingSegment(segment, context) {
    const { lastPos, direction, defSize, whitelist, shot, shooterToken } = context;

    const absoluteDirection = direction + (segment.direction || 0);
    const rangePx = (segment.range || 1) * defSize;
    const cutPx = segment.cut ? segment.cut * defSize : 0;
    const angle = segment.angle || 90;
    // Unless the payload fixes it, the blow sweeps toward the center of the aiming arcs (the facing).
    const side = resolveSwingSide(segment.side, direction, this._tokenPointerDeg(shooterToken));
    const onHit = segment.onHit || 'stop';
    const hitMode = normalizeSwingHitMode(segment.hitMode);
    const samples = Math.max(8, Math.min(48, Math.ceil(angle / 3)));

    const half = angle / 2;
    const startDeg = absoluteDirection - half;
    const endDeg = absoluteDirection + half;
    // Sweep from far edge toward the other; "right" starts at -half → +half.
    const fromDeg = side === 'left' ? endDeg : startDeg;
    const toDeg = side === 'left' ? startDeg : endDeg;
    const sweepSign = toDeg >= fromDeg ? 1 : -1;
    const sampleAngles = Array.from({ length: samples + 1 }, (_unused, i) => fromDeg + (toDeg - fromDeg) * (i / samples));

    const edgePoint = (deg, radiusPx) => ({
      x: lastPos.x + Math.cos((deg * Math.PI) / 180) * radiusPx,
      y: lastPos.y + Math.sin((deg * Math.PI) / 180) * radiusPx,
    });
    // Everything the sweeping edge touches at one angle (hostile tokens and walls), nearest first.
    const edgeAt = (deg, ignoreToken = null) => {
      const testSegment = {
        start: edgePoint(deg, cutPx),
        end: edgePoint(deg, rangePx),
        type: 'line',
        collision: segment.collision,
        props: segment.props,
        onHit: 'next',
      };
      return this.isHit(testSegment, whitelist).filter((c) => {
        if (c.type === 'wall') return true;
        if (ignoreToken && c.object === ignoreToken) return false;
        return !this._shouldIgnoreByDisposition(c.object, segment, shooterToken);
      });
    };

    // The blow lands where the edge first touches something.
    const contact = this._firstSwingContact(edgeAt, sampleAngles);
    let stopDeg = contact ? contact.deg : toDeg;
    const hits = [];

    if (hitMode === SWING_HIT_MODES.AREA) {
      // The sweep stops (visual), but coverage is computed as if it had not: standard cone AoE
      // over the whole swing area, with the usual coverage options.
      const coneSegment = {
        type: 'cone',
        start: { ...lastPos },
        range: rangePx,
        angle,
        direction: absoluteDirection,
        cut: cutPx,
        collision: segment.collision,
        coverageMode: segment.coverageMode,
        lineOfSight: segment.lineOfSight,
        coverageForFullEffect: segment.coverageForFullEffect,
        ...this._areaTokenFilters(segment, shot),
        shooterToken,
      };
      const areaHits = this._isHitCone(coneSegment, whitelist).filter((c) => c.type === 'token');
      hits.push(...this._applyHitOrderAndAmount(areaHits, segment.hitOrder || 'near', segment.hitAmount, lastPos));
    } else if (contact) {
      const first = contact.collisions[0];
      if (first.type === 'wall') {
        hits.push(first);
      } else {
        const token = first.object;
        const radius = this._targetHitRadius(token);
        let point = first.point;
        let details;
        if (hitMode === SWING_HIT_MODES.SIMPLE) {
          // No centrality at all: the blow is neither a bullseye nor a glancing one.
          details = { ...first.details };
          delete details.centrality;
        } else if (hitMode === SWING_HIT_MODES.SIDE) {
          details = {
            ...first.details,
            centrality: swingSideCentrality({
              edgeAngleDeg: contact.deg,
              contact: first.point,
              center: token.center,
              radius,
            }),
          };
        } else {
          // deep: remember the token and keep sweeping until a different wall or token stops
          // the blow; centrality comes from the swing position closest to the token's center.
          const later = sampleAngles.filter((deg) => (deg - contact.deg) * sweepSign > 1e-9);
          const other = this._firstSwingContact((deg) => edgeAt(deg, token), [contact.deg, ...later]);
          const windowEnd = other ? other.deg : toDeg;
          const pass = swingDeepestPass({
            origin: lastPos,
            center: token.center,
            innerPx: cutPx,
            outerPx: rangePx,
            fromDeg: contact.deg,
            toDeg: windowEnd,
          });
          stopDeg = windowEnd;
          point = pass.point;
          details = {
            ...first.details,
            centrality: centralityFromDistance(pass.distance, radius),
            distanceToCenter: pass.distance,
            clock: this._hitClockHours(token, pass.point, token.center),
          };
        }
        details.swingMode = hitMode;
        hits.push({ ...first, point, details });
      }
    }

    for (const hit of hits) {
      shot.shotResult.shotHits.push({
        point: hit.point,
        type: hit.type,
        object: hit.object,
        ...hit.details,
      });
      shot.actualHits.push(hit);
    }

    // Visuals: the swing area plus the edge where the blow stopped (or the end of the arc).
    shot.shotResult.shotPaths.push({
      start: { ...lastPos },
      range: rangePx,
      angle,
      direction: absoluteDirection,
      cut: cutPx,
      type: 'swing',
      side,
      edgeDeg: stopDeg,
    });
    shot.shotResult.shotPaths.push({
      start: edgePoint(stopDeg, cutPx),
      end: edgePoint(stopDeg, rangePx),
      type: 'line',
    });

    let shouldContinue = true;
    if (onHit === 'stop') shouldContinue = hits.length === 0;
    else if (onHit === 'need') shouldContinue = hits.length > 0;

    return {
      endPos: lastPos,
      direction: absoluteDirection,
      shouldContinue,
    };
  }

  /**
   * First sweep angle at which `edgeAt` reports a contact: scan `angles` in order, then refine the
   * exact angle by bisection between the last clear angle and the first touching one (so the
   * contact point does not depend on how coarsely the sweep is sampled).
   * @private
   * @param {(deg: number) => Array} edgeAt collisions of the edge at an angle
   * @param {number[]} angles sweep angles in sweep order
   * @returns {{deg: number, collisions: Array}|null}
   */
  _firstSwingContact(edgeAt, angles) {
    let clearDeg = null;
    for (const deg of angles) {
      const collisions = edgeAt(deg);
      if (!collisions.length) {
        clearDeg = deg;
        continue;
      }
      if (clearDeg === null) return { deg, collisions };
      let lo = clearDeg;
      let hi = deg;
      let found = collisions;
      for (let k = 0; k < SWING_CONTACT_REFINE_STEPS; k += 1) {
        const mid = (lo + hi) / 2;
        const midCollisions = edgeAt(mid);
        if (midCollisions.length) {
          hi = mid;
          found = midCollisions;
        } else {
          lo = mid;
        }
      }
      return { deg: hi, collisions: found };
    }
    return null;
  }

  /**
   * Обработка конуса
   * @private
   */
  _processConeSegment(segment, context) {
    const { lastPos, direction, defSize, whitelist, shot, shooterToken } = context;
    
    // Вычисляем абсолютное направление
    const absoluteDirection = direction + segment.direction;
    const range = segment.range * defSize;
    const angle = segment.angle || 90;  // Угол конуса по умолчанию 90°
    const cut = segment.cut ? segment.cut * defSize : 0;
    
    // Создаём объект сегмента для проверки через isHit
    const testSegment = {
      start: { ...lastPos },
      range: range,
      angle: angle,
      direction: absoluteDirection,
      cut: cut,
      type: segment.type,
      collision: segment.collision,
      coverageMode: segment.coverageMode,
      lineOfSight: segment.lineOfSight,
      coverageForFullEffect: segment.coverageForFullEffect,
      ...this._areaTokenFilters(segment, shot),
      props: segment.props,
      onHit: segment.onHit,
      shooterToken: shooterToken
    };
    
    // Проверяем столкновения через универсальный метод
    const collisions = this.isHit(testSegment, whitelist);
    
    // Применяем hitOrder и hitAmount для фильтрации попаданий
    const hitOrder = segment.hitOrder || 'near';
    const hitAmount = segment.hitAmount;
    const filteredCollisions = this._applyHitOrderAndAmount(collisions, hitOrder, hitAmount, lastPos);
    
    // Определяем, продолжать ли выстрел на основе onHit
    let shouldContinue = true;
    
    if (filteredCollisions.length > 0) {
      // Определяем onHit на основе сегмента
      const onHit = segment.onHit || "next";
      
      // Обрабатываем отфильтрованные столкновения
      for (const collision of filteredCollisions) {
        shot.shotResult.shotHits.push({
          point: collision.point,
          type: collision.type,
          object: collision.object,
          ...collision.details
        });
        
        shot.actualHits.push(collision);
      }
      
      // Решение о продолжении на основе первого попадания
      if (onHit === "stop") {
        shouldContinue = false;
      } else if (onHit === "next" || onHit === "need") {
        shouldContinue = true;
      }
    } else {
      // Нет столкновений
      const onHit = segment.onHit || "next";
      
      if (onHit === "need") {
        // Останавливаем выстрел, если попадания не было, а оно требовалось
        shouldContinue = false;
      } else {
        // По умолчанию продолжаем дальше
        shouldContinue = true;
      }
    }
    
    // Создаём объект пути для визуализации
    const path = {
      start: { ...lastPos },
      range: range,
      angle: angle,
      direction: absoluteDirection,
      cut: cut,
      type: segment.type
    };
    
    shot.shotResult.shotPaths.push(path);
    
    return {
      endPos: lastPos,
      direction: absoluteDirection,
      shouldContinue: shouldContinue
    };
  }

  /**
   * Обработка сложного сегмента complexLine - серия простых линий с рикошетами.
   * Токен всегда останавливает луч (пробития по характеристикам нет; пробитие решит пайплайн урона).
   * @private
   * @param {object} segment - Сегмент complexLine
   *   {
   *     type: 'complexLine',
   *     direction: начальное направление,
   *     length: длина одного отрезка,
   *     amount: количество отрезков,
   *     collision: {...},
   *     damage: {
   *       ricochet: максимальный угол для рикошета
   *     },
   *     onHit: 'stop' | 'next' | 'skip' | 'need'
   *   }
   * @param {object} context - Контекст выстрела
   * @returns {object} Результат {endPos, direction, shouldContinue}
   */
  _processComplexLineSegment(segment, context) {
    const { lastPos, direction, defSize, whitelist, shot, shooterToken } = context;
    
    // ======================
    // ПАРАМЕТРЫ СЕГМЕНТА
    // ======================
    const amount = segment.amount || 1;
    const segmentLength = segment.length;
    const absoluteDirection = direction + (segment.direction || 0);
    const damage = segment.damage || {};
    const maxRicochetAngle = damage.ricochet || 0;
    const onHit = segment.onHit || "stop";
    
    // ======================
    // СОСТОЯНИЕ ТРАЕКТОРИИ
    // ======================
    let currentPos = { ...lastPos };
    let currentDirection = absoluteDirection;
    let shouldContinue = true;
    
    // Временный whitelist для предотвращения повторных попаданий
    const tempWhitelist = [...whitelist];

    // ======================
    // ЦИКЛ ПО ОТРЕЗКАМ
    // ======================
    for (let i = 0; i < amount; i++) {
      // TODO: Здесь будет логика поиска и поворота к ближайшим токенам
      
      // Сохраняем начальную точку отрезка
      const segmentStart = { ...currentPos };
      
      // Рассчитываем конечную точку отрезка
      const segmentEnd = this.shotLine(currentPos, currentDirection, segmentLength, defSize);
      
      // Создаём тестовый сегмент для проверки коллизий
      const testSegment = {
        start: segmentStart,
        end: { ...segmentEnd },
        type: 'line',
        collision: segment.collision
      };
      
      // Проверяем столкновения
      const collisions = this.isHit(testSegment, tempWhitelist);
      
      // Фильтруем по диспозиции
      const validCollisions = collisions.filter(collision => {
        if (collision.type === 'wall') return true;
        return !this._shouldIgnoreByDisposition(collision.object, segment, shooterToken);
      });
      
      // ======================
      // ОБРАБОТКА ПОПАДАНИЙ
      // ======================
      // Стена останавливает луч, токен, мимо которого луч пролетел (уверенность не выше сопротивления), пропускается.
      const reached = walkProjectileCollisions(validCollisions, 'stop', shot, null, { judgeToken: shot.judgeToken });
      if (reached.length > 0) {
        const firstHit = reached[0];
        let segmentEndPos = firstHit.point;
        let hitProcessed = false;
        
        // Обрабатываем первое попадание
        if (firstHit.type === 'wall') {
          // ==================
          // ПОПАДАНИЕ В СТЕНУ
          // ==================
          const wallAngle = this._calculateWallAngle(currentDirection, firstHit.object);
          
          if (wallAngle <= maxRicochetAngle) {
            // РИКОШЕТ ОТ СТЕНЫ
            const newDirection = this._calculateWallRicochet(currentDirection, firstHit.object);
            
            // Смещаем позицию немного в направлении рикошета, чтобы отойти от стены
            const offsetDistance = 0.1; // Небольшое смещение
            const radians = (newDirection * Math.PI) / 180;
            currentPos = {
              x: firstHit.point.x + Math.cos(radians) * offsetDistance,
              y: firstHit.point.y + Math.sin(radians) * offsetDistance
            };
            currentDirection = newDirection;
            hitProcessed = true;
            
            // Очищаем временный whitelist при рикошете и добавляем стену
            tempWhitelist.length = whitelist.length;
            tempWhitelist.splice(whitelist.length, tempWhitelist.length - whitelist.length, ...whitelist.slice(whitelist.length));
            
            // Добавляем стену во временный whitelist
            tempWhitelist.push(firstHit.object);
          } else {
            // TODO: Здесь будет проверка пробития стены
            
            // СТЕНА ОСТАНОВИЛА ЛУЧ — добавляем попадание в стену в shotHits
            shot.shotResult.shotHits.push({
              point: firstHit.point,
              type: firstHit.type,
              object: firstHit.object,
              ...(firstHit.details || {})
            });
            shot.actualHits.push(firstHit);
            shouldContinue = (onHit === "next" || onHit === "skip");
            segmentEndPos = firstHit.point;
            
            // Сохраняем путь
            shot.shotResult.shotPaths.push({
              start: segmentStart,
              end: { ...segmentEndPos },
              type: 'line'
            });
            
            currentPos = segmentEndPos;
            break;
          }
          
        } else if (firstHit.type === 'token') {
          // ==================
          // ПОПАДАНИЕ В ТОКЕН
          // ==================
          const token = firstHit.object;
          const tokenCenter = token.center;
          const tokenAngle = this._calculateTokenRicochetAngle(currentDirection, firstHit.point, tokenCenter);
          
          if (tokenAngle <= maxRicochetAngle) {
            // РИКОШЕТ ОТ ТОКЕНА
            const newDirection = this._calculateTokenRicochet(currentDirection, firstHit.point, tokenCenter);
            
            // Смещаем позицию немного в направлении рикошета, чтобы отойти от токена
            const offsetDistance = 0.1;
            const radians = (newDirection * Math.PI) / 180;
            currentPos = {
              x: firstHit.point.x + Math.cos(radians) * offsetDistance,
              y: firstHit.point.y + Math.sin(radians) * offsetDistance
            };
            currentDirection = newDirection;
            hitProcessed = true;
            
            // Добавляем попадание в результаты
            shot.shotResult.shotHits.push({
              point: firstHit.point,
              type: firstHit.type,
              object: firstHit.object,
              ...firstHit.details
            });
            shot.actualHits.push(firstHit);
            
            // Очищаем временный whitelist при рикошете
            tempWhitelist.length = whitelist.length;
            tempWhitelist.splice(whitelist.length, tempWhitelist.length - whitelist.length, ...whitelist.slice(whitelist.length));
            
          } else {
            // ТОКЕН ОСТАНОВИЛ ЛУЧ (пробития по характеристикам нет)
            segmentEndPos = firstHit.point;

            // Добавляем попадание
            shot.shotResult.shotHits.push({
              point: firstHit.point,
              type: firstHit.type,
              object: firstHit.object,
              ...firstHit.details
            });
            shot.actualHits.push(firstHit);

            // Определяем, продолжать ли
            shouldContinue = (onHit === "next" || onHit === "skip");

            // Сохраняем путь
            shot.shotResult.shotPaths.push({
              start: segmentStart,
              end: { ...segmentEndPos },
              type: 'line'
            });

            currentPos = segmentEndPos;
            break;
          }
        }

        // Сохраняем путь, если был рикошет
        if (hitProcessed) {
          shot.shotResult.shotPaths.push({
            start: segmentStart,
            end: { ...segmentEndPos },
            type: 'line'
          });
        }
        
      } else {
        // ======================
        // НЕТ ПОПАДАНИЙ
        // ======================
        
        // Сохраняем полный отрезок
        shot.shotResult.shotPaths.push({
          start: segmentStart,
          end: { ...segmentEnd },
          type: 'line'
        });
        
        currentPos = segmentEnd;
        
        // Проверяем onHit: "need"
        if (onHit === "need") {
          shouldContinue = false;
          break;
        }
      }
    }
    
    return {
      endPos: currentPos,
      direction: currentDirection,
      shouldContinue: shouldContinue
    };
  }

  /**
   * Создание и просчёт выстрела
   * @param {Token} token - Токен, который стреляет
   * @param {object} payload - Объект с инструкциями траектории
   * @param {number} direction - Начальное направление в градусах
   * @param {object} [options]
   * @param {{applications: Array<{mode: string, items: object[]}>}} [options.penetration] - снаряд
   *   (фазы урона) для пробития стен. Без него каждая стена останавливает выстрел.
   * @param {number|null} [options.confidence] - уверенность выстрела (`zoneConfidence` зоны дуги): токен,
   *   у которого сопротивление попаданию не ниже, снаряд пролетает мимо (shot-confidence.mjs).
   *   Без неё — каждое касание хитбокса попадание.
   * @returns {string} UID созданного выстрела
   */
  createShot(token, payload, direction, { penetration = null, confidence = null } = {}) {
    // 1. Генерация UID и регистрация выстрела
    const uid = this.shotSystem.generateUID();
    const shot = this.shotSystem.registerShot(uid);
    shot.judgeToken = createTokenJudge({
      confidence,
      resistanceFor: (tokenObject) => this._hitResistanceFor(tokenObject),
    });
    const penetrationApps = penetration?.applications;
    if (Array.isArray(penetrationApps) && penetrationApps.length) {
      shot.penetration = { applications: penetrationApps, energyLevel: 1 };
      shot.muzzleEnergy = applicationsEnergy(penetrationApps);
    }
    // Distance falloff of the projectile, measured from the muzzle (walls on the way and the targets).
    shot.falloff = normalizeFalloff(penetration?.falloff);

    // 2. Получение whitelist и базовых параметров
    const whitelist = this.getWhitelist(token);
    const defaults = this.getDefaults(token);
    shot.origin = { x: defaults.defPos.x, y: defaults.defPos.y };
    
    // 3. Инициализация переменных для просчёта
    let lastPos = { ...defaults.defPos };
    let currentDirection = direction;
    
    // 4. Просчёт всех сегментов траектории
    for (const segment of payload.trajectory.segments) {
      const context = {
        lastPos: lastPos,
        direction: currentDirection,
        defSize: defaults.defSize,
        whitelist: whitelist,
        shot: shot,
        shooterToken: token
      };
      
      const result = this.shotSegment(segment, context);
      
      // Обновляем позицию и направление для следующего сегмента
      lastPos = result.endPos;
      currentDirection = result.direction;
      
      // Если не нужно продолжать, прерываем цикл
      if (!result.shouldContinue) {
        break;
      }
    }
    
    // 5. Запись выстрела: чистые данные для отрисовки и для чата (без ссылок на токены/стены)
    shot.record = buildShotRecord(shot, {
      t: trailNowMs(),
      sceneId: token?.scene?.id ?? canvas?.scene?.id,
      tokenId: token?.document?.id ?? token?.id,
      userId: game.user?.id,
    });

    console.log(`Shot ${uid} created with ${shot.shotResult.shotPaths.length} paths`);
    return uid;
  }

  /**
   * Получение результата выстрела для визуализации
   * @param {string} uid - UID выстрела
   * @returns {object|null} shotResult или null
   */
  getShotResult(uid) {
    const shot = this.shotSystem.getShot(uid);
    return shot ? shot.shotResult : null;
  }

  /**
   * Запись выстрела (ShotRecord) для `DrawManager.drawRecord` и флага чата.
   * @param {string} uid - UID выстрела
   * @returns {object|null} запись или null, если выстрел уже вытеснен из памяти
   */
  getShotRecord(uid) {
    return this.shotSystem.getShot(uid)?.record ?? null;
  }

  /**
   * Запись продолжения следа: пуля вышла из тела и полетела дальше (см. `continueShot`).
   * @param {string} uid - UID выстрела
   * @returns {object|null} запись или null, если пуля из тела не вышла
   */
  getShotExtension(uid) {
    return this.shotSystem.getShot(uid)?.extension ?? null;
  }

  /**
   * Вывод всех сохранённых выстрелов в консоль для отладки
   */
  logAllShots() {
    this.shotSystem.logAllShots();
  }
}

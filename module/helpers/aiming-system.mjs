// Aiming System for SpaceHolder - основная система прицеливания с лучами
// Интегрируется с существующими TokenPointer и TokenRotator системами

import { RayCaster } from './ray-casting.mjs';
import { RayRenderer } from './ray-renderer.mjs';
import { AimingSocketManager } from './aiming-socket-manager.mjs';

export class AimingSystem {
  constructor() {
    // Состояние системы
    this.isAiming = false;
    this.aimingToken = null;
    this.currentAimDirection = 0; // в градусах
    this.currentRay = null;
    
    // Конфигурация по умолчанию
    this.config = {
      maxRayDistance: 2000, // максимальная дальность луча в пикселях
      aimingSensitivity: 1.0, // чувствительность поворота прицела
      showAimingReticle: true, // показывать ли прицельную сетку
      allowRicochet: false, // разрешить рикошеты
      maxRicochets: 3, // максимальное количество рикошетов
      curvedRaysEnabled: false, // изогнутые лучи
      
      // Новые константы для оптимизированной механики
      previewRayLength: 500, // длина луча предпросмотра при прицеливании
      fireSegmentLength: 100, // длина одного сегмента при выстреле
      maxFireSegments: 50, // максимальное количество сегментов выстрела
    };
    
    // Компоненты системы
    this.rayCaster = new RayCaster(this);
    this.rayRenderer = new RayRenderer(this);
    this.socketManager = new AimingSocketManager(this);
    
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
    this._previewUpdateInterval = 16; // ~60 FPS
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
    this.socketManager.initialize();
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
    
    console.log('SpaceHolder | AimingSystem: Stopping aiming');
    
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
   * Выстрелить в текущем направлении (рекурсивная отрисовка сегментами)
   */
  async fire() {
    if (!this.isAiming || !this.aimingToken) {
      ui.notifications.warn("Прицеливание не активно");
      return;
    }
    
    const tokenCenter = this.aimingToken.center;
    console.log(`🔥 FIRE! ${this.aimingToken.name} firing from (${Math.round(tokenCenter.x)}, ${Math.round(tokenCenter.y)})`);
    console.log(`🎯 Direction: ${Math.round(this.currentAimDirection)}°`);
    console.log(`📍 Segment length: ${this.config.fireSegmentLength}px, Max segments: ${this.config.maxFireSegments}`);
    
    // Отправляем событие начала выстрела всем клиентам
    const shotData = {
      tokenId: this.aimingToken.id,
      direction: this.currentAimDirection,
      startPosition: tokenCenter,
      timestamp: Date.now(),
      weaponName: this.weapon?.name || 'Неизвестное оружие'
    };
    
    this.socketManager.broadcastFireShot(shotData);
    
    // Очищаем только предпросмотр, оставляем предыдущие выстрелы
    if (this.rayRenderer.currentRayGraphics) {
      this.rayRenderer.currentRayGraphics.destroy();
      this.rayRenderer.currentRayGraphics = null;
    }
    
    // Начинаем рекурсивную отрисовку выстрела
    const fireResult = await this._fireRecursive({
      currentPosition: tokenCenter,
      direction: this.currentAimDirection,
      segmentIndex: 0,
      totalHits: [],
      segments: [],
      socketData: shotData // Передаём данные для socket-синхронизации
    });
    
    // Обрабатываем все попадания
    if (fireResult.totalHits.length > 0) {
      this._processHits(fireResult.totalHits);
      
      // Отправляем события о попаданиях
      for (const hit of fireResult.totalHits) {
        this.socketManager.broadcastShotHit({
          tokenId: this.aimingToken.id,
          hitType: hit.type,
          hitPoint: hit.point,
          targetId: hit.object?.id,
          distance: hit.distance
        });
      }
    } else {
      // Промах
      console.log('❌ No hits detected - miss!');
      ChatMessage.create({
        content: `${this.aimingToken.name} промахивается!`,
        speaker: ChatMessage.getSpeaker({ token: this.aimingToken })
      });
    }
    
    console.log(`✅ Fire sequence completed for ${this.aimingToken.name}. Total segments: ${fireResult.segments.length}`);
    
    // Отправляем событие завершения выстрела
    this.socketManager.broadcastShotComplete({
      tokenId: this.aimingToken.id,
      totalSegments: fireResult.segments.length,
      totalHits: fireResult.totalHits.length,
      segments: fireResult.segments.map(seg => ({
        start: seg.start || seg.origin,
        end: seg.end,
        isRicochet: seg.isRicochet || false,
        bounceNumber: seg.bounceNumber || 0
      }))
    });
    
    // Не завершаем прицеливание автоматически - пользователь может продолжить прицеливание
    // this.stopAiming();
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
   * Рекурсивная отрисовка сегментов выстрела
   * @param {Object} fireState - состояние выстрела
   * @returns {Promise<Object>} результат выстрела
   */
  async _fireRecursive(fireState) {
    const { currentPosition, direction, segmentIndex, totalHits, segments, ricochetCount = 0, lastWallId = null, socketData = null } = fireState;
    
    // Проверяем лимит сегментов
    if (segmentIndex >= this.config.maxFireSegments) {
      console.log(`⚠️ Reached maximum segments limit: ${this.config.maxFireSegments}`);
      return { totalHits, segments };
    }
    
    // Проверяем лимит рикошетов (используем только конфигурацию)
    const maxRicochets = this.config.maxRicochets;
    console.log(`📊 Max ricochets from config: ${maxRicochets}, current: ${ricochetCount}`);
    if (ricochetCount >= maxRicochets) {
      console.log(`🏀 Reached maximum ricochet limit: ${maxRicochets}`);
      return { totalHits, segments };
    }
    
    // Создаем следующий сегмент
    const segment = this.rayCaster.createSimpleRay(
      currentPosition,
      direction,
      this.config.fireSegmentLength
    );
    
    // Отмечаем, если это рикошет
    if (ricochetCount > 0) {
      segment.isRicochet = true;
      segment.bounceNumber = ricochetCount;
    }
    
    segments.push(segment);
    
    const segmentType = ricochetCount > 0 ? `ricochet-${ricochetCount}` : 'primary';
    console.log(`➡️ Segment ${segmentIndex + 1} (${segmentType}): from (${Math.round(currentPosition.x)}, ${Math.round(currentPosition.y)}) to (${Math.round(segment.end.x)}, ${Math.round(segment.end.y)})`);
    
    // Проверяем столкновения для этого сегмента
    const allCollisions = this.rayCaster.checkSegmentCollisions(segment);
    
    // Исключаем последнюю стену для предотвращения немедленных циклов
    const collisions = allCollisions.filter(collision => {
      if (collision.type === 'wall' && lastWallId && collision.object.id === lastWallId) {
        // Пропускаем последнюю стену, если расстояние очень мало
        return collision.distance > 5; // Минимум 5 пикселей
      }
      return true;
    });
    
    // Отрисовываем сегмент
    this.rayRenderer.drawFireSegment(segment, segmentIndex);
    
    // Отправляем событие о сегменте выстрела
    if (socketData) {
      this.socketManager.broadcastShotSegment({
        tokenId: socketData.tokenId,
        segmentIndex: segmentIndex,
        segment: {
          start: segment.start || segment.origin,
          end: segment.end,
          isRicochet: segment.isRicochet || false,
          bounceNumber: segment.bounceNumber || 0
        },
        ricochetCount: ricochetCount
      });
    }
    
    // Небольшая задержка для визуального эффекта
    const delay = ricochetCount > 0 ? 75 : 50; // Рикошеты чуть медленнее
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Обрабатываем столкновения
    if (collisions.length > 0) {
      totalHits.push(...collisions);
      console.log(`🎯 Segment ${segmentIndex + 1} hit ${collisions.length} object(s)`);
      
      // Проверяем первое столкновение
      const firstHit = collisions[0];
      
      // Проверяем, можно ли сделать рикошет
      if (firstHit.type === 'wall' && this._canRicochet(firstHit, ricochetCount)) {
        // Вычисляем отраженное направление
        const reflectedDirection = this._calculateRicochetDirection(segment, firstHit);
        
        // Сдвигаем начальную точку рикошета на несколько пикселей в направлении отражения
        const offsetDistance = 3; // Пиксели сдвига
        const reflectedRadians = reflectedDirection * Math.PI / 180;
        const ricochetStartPoint = {
          x: firstHit.point.x + Math.cos(reflectedRadians) * offsetDistance,
          y: firstHit.point.y + Math.sin(reflectedRadians) * offsetDistance
        };
        
        console.log(`🏀 Ricochet ${ricochetCount + 1}: bouncing off wall (${firstHit.object.id}) at angle ${Math.round(reflectedDirection)}°`);
        console.log(`   ➡️ Hit point: (${Math.round(firstHit.point.x)}, ${Math.round(firstHit.point.y)})`);
        console.log(`   ➡️ Start point: (${Math.round(ricochetStartPoint.x)}, ${Math.round(ricochetStartPoint.y)})`);
        console.log(`   ➡️ Offset: ${offsetDistance}px in direction ${Math.round(reflectedDirection)}°`);
        
        return await this._fireRecursive({
          currentPosition: ricochetStartPoint,
          direction: reflectedDirection,
          segmentIndex: segmentIndex + 1,
          totalHits,
          segments,
          ricochetCount: ricochetCount + 1,
          lastWallId: firstHit.object.id, // Запоминаем ID стены
          socketData: socketData // Передаём дальше данные для socket
        });
      }
      
      // Останавливаемся при попадании в токен или непробиваемую стену
      if (this._shouldStopFiring(firstHit)) {
        console.log(`🛑 Stopping fire at segment ${segmentIndex + 1} due to ${firstHit.type}`);
        return { totalHits, segments };
      }
    }
    
    // Продолжаем следующим сегментом в том же направлении
    return await this._fireRecursive({
      currentPosition: segment.end,
      direction: direction,
      segmentIndex: segmentIndex + 1,
      totalHits,
      segments,
      ricochetCount,
      lastWallId, // Передаём дальше
      socketData: socketData // Передаём дальше данные для socket
    });
  }
  
  /**
   * Определяем, следует ли остановить выстрел при данном столкновении
   * @param {Object} collision - столкновение
   * @returns {boolean} следует ли остановить
   */
  _shouldStopFiring(collision) {
    switch (collision.type) {
      case 'token':
        return true; // Всегда останавливаемся на токенах
      case 'wall':
        return true; // Останавливаемся на стенах (если нет рикошета)
      case 'tile':
        return true; // Останавливаемся на тайлах
      default:
        return true;
    }
  }
  
  /**
   * Проверяем, можно ли сделать рикошет от данного объекта
   * @param {Object} collision - столкновение
   * @param {number} currentRicochets - текущее количество рикошетов
   * @returns {boolean} можно ли рикошет
   */
  _canRicochet(collision, currentRicochets) {
    // Проверяем, включены ли рикошеты вообще
    console.log(`🔍 Ricochet check: allowRicochet=${this.config.allowRicochet}, currentRicochets=${currentRicochets}`);
    if (!this.config.allowRicochet) {
      console.log(`❌ Ricochets disabled in config`);
      return false;
    }
    
    // Проверяем лимит рикошетов (используем только конфигурацию)
    const maxRicochets = this.config.maxRicochets;
    console.log(`🔢 Ricochet limit check: ${currentRicochets}/${maxRicochets}`);
    if (currentRicochets >= maxRicochets) {
      console.log(`⚠️ Ricochet limit reached`);
      return false;
    }
    
    // Рикошет возможен тольо от стен
    if (collision.type !== 'wall') {
      return false;
    }
    
    // Можно добавить дополнительные проверки:
    // - Тип стены (обычная/дверь)
    // - Материал стены
    // - Угол падения
    
    return true;
  }
  
  /**
   * Вычисляем направление рикошета
   * @param {Object} segment - сегмент, который сталкивается со стеной
   * @param {Object} wallCollision - столкновение со стеной
   * @returns {number} новое направление в градусах
   */
  _calculateRicochetDirection(segment, wallCollision) {
    const startPoint = segment.start || segment.origin;
    const endPoint = segment.end;
    const wall = wallCollision.wallRay;
    
    // Вектор направления луча
    const rayVector = {
      x: endPoint.x - startPoint.x,
      y: endPoint.y - startPoint.y
    };
    const rayLength = Math.hypot(rayVector.x, rayVector.y);
    const rayDir = {
      x: rayVector.x / rayLength,
      y: rayVector.y / rayLength
    };
    
    // Вектор стены
    const wallVector = {
      x: wall.B.x - wall.A.x,
      y: wall.B.y - wall.A.y
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
        <p>🔫 ЛКМ - выстрелить</p>
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
      this.fire();
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
   * Обработка попаданий
   */
  _processHits(collisions) {
    console.log('🎯 SpaceHolder | AimingSystem: Processing hits...');
    console.log(`📊 Total collisions detected: ${collisions.length}`);
    
    if (!collisions || collisions.length === 0) {
      console.log('❌ No hits detected - miss!');
      ChatMessage.create({
        content: `${this.aimingToken.name} промахивается!`,
        speaker: ChatMessage.getSpeaker({ token: this.aimingToken })
      });
      return;
    }
    
    // Логируем детали каждого столкновения
    console.group('🔍 Collision Details:');
    collisions.forEach((collision, index) => {
      const distance = Math.round(collision.distance * 100) / 100; // Округляем до 2 знаков
      const point = `(${Math.round(collision.point.x)}, ${Math.round(collision.point.y)})`;
      
      console.log(`${index + 1}. ${this._getCollisionIcon(collision.type)} Type: ${collision.type}`);
      console.log(`   Distance: ${distance}px`);
      console.log(`   Point: ${point}`);
      
      if (collision.type === 'token') {
        console.log(`   Target: ${collision.object.name} (ID: ${collision.object.id})`);
        console.log(`   Token bounds: ${collision.object.bounds.width}x${collision.object.bounds.height}`);
      } else if (collision.type === 'wall') {
        const wall = collision.object;
        console.log(`   Wall ID: ${wall.id}`);
        console.log(`   Wall coordinates: (${wall.document.c[0]},${wall.document.c[1]}) -> (${wall.document.c[2]},${wall.document.c[3]})`);
        console.log(`   Blocks movement: ${wall.document.move}`);
        console.log(`   Blocks sight: ${wall.document.sight}`);
      } else if (collision.type === 'tile') {
        console.log(`   Tile: ${collision.object.document.texture.src}`);
        console.log(`   Tile bounds: ${collision.object.bounds.width}x${collision.object.bounds.height}`);
      }
      
      console.log('   ---');
    });
    console.groupEnd();
    
    // Обрабатываем каждое столкновение в порядке расстояния
    collisions.forEach((collision, index) => {
      if (collision.type === 'token') {
        this._processTokenHit(collision.object, index === 0, index + 1, collisions.length);
      } else if (collision.type === 'wall') {
        this._processWallHit(collision.object, index + 1, collisions.length);
      } else if (collision.type === 'tile') {
        this._processTileHit(collision.object, index + 1, collisions.length);
      }
    });
    
    // Итоговая сводка
    const tokenHits = collisions.filter(c => c.type === 'token').length;
    const wallHits = collisions.filter(c => c.type === 'wall').length;
    const tileHits = collisions.filter(c => c.type === 'tile').length;
    
    console.log(`📋 Hit Summary: ${tokenHits} tokens, ${wallHits} walls, ${tileHits} tiles`);
  }
  
  /**
   * Обработка попадания в токен
   */
  _processTokenHit(target, isPrimary = true, hitNumber = 1, totalHits = 1) {
    const attacker = this.aimingToken;
    
    console.log(`🎯 Token Hit #${hitNumber}: ${attacker.name} -> ${target.name}`);
    
    // Определяем тип попадания
    const hitType = isPrimary ? 'Первичное' : 'Пробивающее';
    const hitMessage = totalHits > 1 ? 
      `🎯 ${attacker.name} попадает в ${target.name}! (${hitType} попадание #${hitNumber} из ${totalHits})` :
      `🎯 ${attacker.name} попадает в ${target.name}!`;
    
    // Создаем сообщение о попадании
    ChatMessage.create({
      content: hitMessage,
      speaker: ChatMessage.getSpeaker({ token: attacker })
    });
  }
  
  /**
   * Обработка попадания в стену
   */
  _processWallHit(wall, hitNumber = 1, totalHits = 1) {
    const attacker = this.aimingToken;
    
    console.log(`💥 Wall Hit #${hitNumber}: ${attacker.name} -> Wall (${wall.id})`);
    console.log(`   Wall type: ${wall.document.door ? 'Door' : 'Wall'}`);
    console.log(`   Wall state: ${wall.document.ds ? 'Open' : 'Closed'}`);
    
    const wallType = wall.document.door ? 'дверь' : 'стену';
    const hitMessage = totalHits > 1 ?
      `💥 ${attacker.name} попадает в ${wallType}! (Попадание #${hitNumber} из ${totalHits})` :
      `💥 ${attacker.name} попадает в ${wallType}!`;
    
    ChatMessage.create({
      content: hitMessage,
      speaker: ChatMessage.getSpeaker({ token: attacker })
    });
  }
  
  /**
   * Обработка попадания в тайл
   */
  _processTileHit(tile, hitNumber = 1, totalHits = 1) {
    const attacker = this.aimingToken;
    
    console.log(`🏠 Tile Hit #${hitNumber}: ${attacker.name} -> Tile (${tile.id})`);
    
    const hitMessage = totalHits > 1 ?
      `🏠 ${attacker.name} попадает в объект! (Попадание #${hitNumber} из ${totalHits})` :
      `🏠 ${attacker.name} попадает в объект!`;
    
    ChatMessage.create({
      content: hitMessage,
      speaker: ChatMessage.getSpeaker({ token: attacker })
    });
  }
  
  /**
   * Получить иконку для типа столкновения
   */
  _getCollisionIcon(type) {
    const icons = {
      'token': '📺',  // токен
      'wall': '🧯',   // стена
      'tile': '🏠',   // тайл
      'door': '🚪',   // дверь
    };
    
    return icons[type] || '❓'; // знак вопроса для неизвестных типов
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
   * Регистрация настроек системы
   */
  _registerSettings() {
    const MODULE_NS = 'spaceholder';
    const PREF = 'aimingsystem';
    
    game.settings.register(MODULE_NS, `${PREF}.maxRayDistance`, {
      name: 'Максимальная дальность луча',
      hint: 'Максимальное расстояние для лучей в пикселях',
      scope: 'world',
      config: false,
      default: 2000,
      type: Number,
    });
    
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
    
    game.settings.register(MODULE_NS, `${PREF}.maxRicochets`, {
      name: 'Максимум рикошетов',
      hint: 'Максимальное количество рикошетов от стен',
      scope: 'world',
      config: false,
      default: 3,
      type: Number,
      range: {
        min: 0,
        max: 10,
        step: 1
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
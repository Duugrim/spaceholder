// Ray Renderer for SpaceHolder - визуализация лучей и UI прицеливания
// Отвечает за отрисовку лучей, прицельной сетки и анимаций

export class RayRenderer {
  constructor(aimingSystem) {
    this.aimingSystem = aimingSystem;
    
    // Графические контейнеры
    this.aimingContainer = null;
    this.rayContainer = null;
    this.reticleContainer = null;
    this.animationContainer = null;
    
    // Текущие визуальные элементы
    this.currentRayGraphics = null;
    this.currentReticle = null;
    this.activeAnimations = [];
  }
  
  /**
   * Инициализация рендерера
   */
  initialize() {
    console.log('SpaceHolder | RayRenderer: Initializing ray renderer');
    this._createContainers();
  }
  
  /**
   * Обработка готовности холста
   */
  onCanvasReady() {
    this._createContainers();
  }
  
  /**
   * Создать графические контейнеры
   * @private
   */
  _createContainers() {
    if (!canvas?.stage) return;
    
    // Основной контейнер для системы прицеливания
    if (!this.aimingContainer || this.aimingContainer.destroyed) {
      this.aimingContainer = new PIXI.Container();
      this.aimingContainer.name = 'aimingSystem';
      this.aimingContainer.zIndex = 1000; // Поверх большинства элементов
      canvas.stage.addChild(this.aimingContainer);
    }
    
    // Контейнер для лучей
    if (!this.rayContainer || this.rayContainer.destroyed) {
      this.rayContainer = new PIXI.Container();
      this.rayContainer.name = 'rayContainer';
      this.aimingContainer.addChild(this.rayContainer);
    }
    
    // Контейнер для прицельной сетки
    if (!this.reticleContainer || this.reticleContainer.destroyed) {
      this.reticleContainer = new PIXI.Container();
      this.reticleContainer.name = 'reticleContainer';
      this.aimingContainer.addChild(this.reticleContainer);
    }
    
    // Контейнер для анимаций
    if (!this.animationContainer || this.animationContainer.destroyed) {
      this.animationContainer = new PIXI.Container();
      this.animationContainer.name = 'animationContainer';
      this.aimingContainer.addChild(this.animationContainer);
    }
  }
  
  /**
   * Показать прицельную сетку вокруг токена
   * @param {Token} token - токен для которого показывается прицел
   */
  showAimingReticle(token) {
    if (!token || !this.reticleContainer) return;
    
    // Убираем предыдущую прицельную сетку
    this.hideAimingReticle();
    
    // Создаем новую прицельную сетку
    const reticle = new PIXI.Graphics();
    const tokenBounds = token.bounds;
    const centerX = tokenBounds.x + tokenBounds.width / 2;
    const centerY = tokenBounds.y + tokenBounds.height / 2;
    const radius = Math.max(tokenBounds.width, tokenBounds.height) * 0.8;
    
    // Стиль прицельной сетки
    const reticleColor = 0xFF0000;
    const reticleAlpha = 0.6;
    const lineWidth = 2;
    
    reticle.lineStyle(lineWidth, reticleColor, reticleAlpha);
    
    // Внешний круг
    reticle.drawCircle(centerX, centerY, radius);
    
    // Внутренний круг
    reticle.drawCircle(centerX, centerY, radius * 0.3);
    
    // Крестик в центре
    const crossSize = radius * 0.1;
    reticle.moveTo(centerX - crossSize, centerY)
          .lineTo(centerX + crossSize, centerY)
          .moveTo(centerX, centerY - crossSize)
          .lineTo(centerX, centerY + crossSize);
    
    // Деления по периметру
    const divisions = 8;
    for (let i = 0; i < divisions; i++) {
      const angle = (i * Math.PI * 2) / divisions;
      const innerR = radius * 0.9;
      const outerR = radius * 1.1;
      
      const innerX = centerX + Math.cos(angle) * innerR;
      const innerY = centerY + Math.sin(angle) * innerR;
      const outerX = centerX + Math.cos(angle) * outerR;
      const outerY = centerY + Math.sin(angle) * outerR;
      
      reticle.moveTo(innerX, innerY).lineTo(outerX, outerY);
    }
    
    this.currentReticle = reticle;
    this.reticleContainer.addChild(reticle);
    
    // Показываем круглые мишени на всех токенах
    this._showTargetCircles();
    
    // Анимация пульсации
    this._animateReticle(reticle);
  }
  
  /**
   * Скрыть прицельную сетку
   */
  hideAimingReticle() {
    if (this.currentReticle) {
      this.currentReticle.destroy();
      this.currentReticle = null;
    }
    
    // Скрываем круглые мишени
    this._hideTargetCircles();
  }
  
  /**
   * Показать круглые мишени на всех токенах
   * @private
   */
  _showTargetCircles() {
    if (!canvas.tokens?.placeables || !this.reticleContainer) return;
    
    // Очищаем предыдущие мишени
    this._hideTargetCircles();
    
    this.targetCircles = new Map();
    
    for (const token of canvas.tokens.placeables) {
      // Пропускаем токен, который стреляет
      if (token === this.aimingSystem.aimingToken) continue;
      
      // Пропускаем невидимые токены
      if (!token.visible) continue;
      
      const bounds = token.bounds;
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      // Используем минимальный размер для более точного попадания
      const radius = Math.min(bounds.width, bounds.height) / 2;
      
      // Создаем мишень
      const targetCircle = new PIXI.Graphics();
      
      // Стиль мишени - полупрозрачные кольца
      const targetColor = 0xFFAA00; // Оранжевый
      const targetAlpha = 0.4;
      const targetLineWidth = 2;
      
      targetCircle.lineStyle(targetLineWidth, targetColor, targetAlpha);
      
      // Внешний круг мишени
      targetCircle.drawCircle(centerX, centerY, radius);
      
      // Внутренний круг мишени (для лучшей видимости)
      targetCircle.drawCircle(centerX, centerY, radius * 0.6);
      
      // Центральная точка
      targetCircle.beginFill(targetColor, targetAlpha * 1.5);
      targetCircle.drawCircle(centerX, centerY, 3);
      targetCircle.endFill();
      
      // Название для отладки
      targetCircle.name = `targetCircle_${token.id}`;
      
      // Добавляем на сцену
      this.reticleContainer.addChild(targetCircle);
      
      // Сохраняем ссылку
      this.targetCircles.set(token.id, targetCircle);
      
      // Легкая анимация появления
      targetCircle.alpha = 0;
      this._animateTargetCircle(targetCircle, targetAlpha);
    }
  }
  
  /**
   * Скрыть круглые мишени
   * @private
   */
  _hideTargetCircles() {
    if (!this.targetCircles) return;
    
    for (const targetCircle of this.targetCircles.values()) {
      if (targetCircle && !targetCircle.destroyed) {
        targetCircle.destroy();
      }
    }
    
    this.targetCircles = null;
  }
  
  /**
   * Анимация появления мишени
   * @private
   */
  _animateTargetCircle(targetCircle, targetAlpha) {
    if (!targetCircle || targetCircle.destroyed) return;
    
    const startTime = Date.now();
    const fadeInDuration = 300;
    
    const fadeIn = () => {
      if (!targetCircle || targetCircle.destroyed || !this.aimingSystem.isAiming) return;
      
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / fadeInDuration, 1);
      targetCircle.alpha = progress * targetAlpha;
      
      if (progress < 1) {
        requestAnimationFrame(fadeIn);
      }
    };
    
    fadeIn();
  }
  
  /**
   * Анимация пульсации прицельной сетки
   * @private
   */
  _animateReticle(reticle) {
    if (!reticle || reticle.destroyed) return;
    
    // Простая анимация альфа-канала
    const startTime = Date.now();
    const duration = 2000; // 2 секунды на полный цикл
    
    const animate = () => {
      if (!reticle || reticle.destroyed || !this.aimingSystem.isAiming) return;
      
      const elapsed = Date.now() - startTime;
      const progress = (elapsed % duration) / duration;
      const alpha = 0.3 + Math.sin(progress * Math.PI * 2) * 0.3;
      
      reticle.alpha = alpha;
      
      requestAnimationFrame(animate);
    };
    
    animate();
  }
  
  /**
   * Обновить предпросмотр прицеливания
   * @param {Object} ray - объект луча для отображения
   */
  updateAimingPreview(ray) {
    if (!ray || !this.rayContainer) return;
    
    // Очищаем только предыдущий луч предпросмотра, оставляем сегменты выстрелов
    this.clearPreview();
    
    // Создаем новую графику для луча
    const rayGraphics = new PIXI.Graphics();
    
    // Стиль луча предпросмотра
    const rayColor = 0x00FF00;
    const rayAlpha = 0.7;
    const rayWidth = 3;
    
    rayGraphics.lineStyle(rayWidth, rayColor, rayAlpha);
    
    // Рисуем упрощенный луч (без сегментов и коллизий)
    rayGraphics.moveTo(ray.origin.x, ray.origin.y)
              .lineTo(ray.end.x, ray.end.y);
    
    // Добавляем маркер начала луча
    rayGraphics.beginFill(rayColor, rayAlpha);
    rayGraphics.drawCircle(ray.origin.x, ray.origin.y, 4);
    rayGraphics.endFill();
    
    // Сохраняем ссылку на текущий луч предпросмотра
    this.currentRayGraphics = rayGraphics;
    this.rayContainer.addChild(rayGraphics);
    
    // Добавляем анимацию мерцания для предпросмотра
    this._animatePreviewRay(rayGraphics);
  }
  
  /**
   * Отрисовать сегмент выстрела
   * @param {Object} segment - сегмент луча
   * @param {number} segmentIndex - индекс сегмента
   */
  drawFireSegment(segment, segmentIndex) {
    if (!segment || !this.rayContainer) return;
    
    // Создаем графику для сегмента выстрела
    const segmentGraphics = new PIXI.Graphics();
    
    // Определяем стиль в зависимости от типа сегмента
    let fireColor, fireAlpha, fireWidth;
    
    if (segment.isRicochet) {
      // Рикошеты - разные оттенки без снижения яркости
      const bounceLevel = segment.bounceNumber || 1;
      fireColor = bounceLevel === 1 ? 0xFF8800 : // Оранжевый для первого рикошета
                  bounceLevel === 2 ? 0xFFCC00 : // Жёлто-оранжевый для второго
                                      0xFFFF00;   // Жёлтый для остальных
      fireAlpha = 0.9; // Одинаковая яркость для всех рикошетов
      fireWidth = 4; // Одинаковая толщина
    } else {
      // Основной выстрел - ярко-красный
      fireColor = 0xFF4444;
      fireAlpha = 0.9;
      fireWidth = 4;
    }
    
    segmentGraphics.lineStyle(fireWidth, fireColor, fireAlpha);
    
    // Поддерживаем оба формата: {start, end} и {origin, end}
    const startPoint = segment.start || segment.origin;
    const endPoint = segment.end;
    
    // Рисуем сегмент
    segmentGraphics.moveTo(startPoint.x, startPoint.y)
                  .lineTo(endPoint.x, endPoint.y);
    
    // Добавляем маркер начала сегмента
    segmentGraphics.beginFill(fireColor, fireAlpha);
    segmentGraphics.drawCircle(startPoint.x, startPoint.y, Math.max(2, fireWidth - 1));
    segmentGraphics.endFill();
    
    // Добавляем ID для управления
    const segmentType = segment.isRicochet ? `ricochet_${segment.bounceNumber}` : 'primary';
    segmentGraphics.name = `fireSegment_${segmentType}_${segmentIndex}`;
    
    // Добавляем сегмент на сцену
    this.rayContainer.addChild(segmentGraphics);
    
    // Сохраняем ссылку для возможности очистки
    if (!this.fireSegments) {
      this.fireSegments = [];
    }
    this.fireSegments.push(segmentGraphics);
    
    // Анимация появления сегмента
    segmentGraphics.alpha = 0;
    const startTime = Date.now();
    const fadeInDuration = segment.isRicochet ? 150 : 100; // Рикошеты появляются немного медленнее
    
    const fadeIn = () => {
      if (segmentGraphics.destroyed) return;
      
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / fadeInDuration, 1);
      segmentGraphics.alpha = progress * fireAlpha;
      
      if (progress < 1) {
        requestAnimationFrame(fadeIn);
      }
    };
    
    fadeIn();
  }
  
  /**
   * Нарисовать изогнутый сегмент луча
   * @private
   */
  _drawCurvedSegment(graphics, ray) {
    if (!ray.curvePoints || ray.curvePoints.length < 2) return;
    
    graphics.moveTo(ray.curvePoints[0].x, ray.curvePoints[0].y);
    
    for (let i = 1; i < ray.curvePoints.length; i++) {
      graphics.lineTo(ray.curvePoints[i].x, ray.curvePoints[i].y);
    }
  }
  
  /**
   * Нарисовать маркеры точек столкновений
   * @private
   */
  _drawCollisionMarkers(graphics, collisions) {
    collisions.forEach((collision, index) => {
      let markerColor = 0xFF0000; // Красный для попаданий
      let markerSize = 8;
      
      if (collision.type === 'wall') {
        markerColor = 0xFFFF00; // Желтый для стен
      } else if (collision.type === 'tile') {
        markerColor = 0x00FFFF; // Голубой для тайлов
      }
      
      // Рисуем маркер
      graphics.lineStyle(2, markerColor, 1.0);
      graphics.beginFill(markerColor, 0.5);
      graphics.drawCircle(collision.point.x, collision.point.y, markerSize);
      graphics.endFill();
      
      // Добавляем номер для нескольких попаданий
      if (collisions.length > 1) {
        // Здесь можно добавить текст с номером попадания
        // Требует дополнительной работы с PIXI.Text
      }
    });
  }
  
  /**
   * Анимация мерцания луча предпросмотра
   * @private
   */
  _animatePreviewRay(rayGraphics) {
    if (!rayGraphics || rayGraphics.destroyed) return;
    
    const startTime = Date.now();
    const duration = 1000; // 1 секунда на цикл
    
    const animate = () => {
      if (!rayGraphics || rayGraphics.destroyed || !this.aimingSystem.isAiming) return;
      
      const elapsed = Date.now() - startTime;
      const progress = (elapsed % duration) / duration;
      const alpha = 0.5 + Math.sin(progress * Math.PI * 2) * 0.2;
      
      rayGraphics.alpha = alpha;
      
      requestAnimationFrame(animate);
    };
    
    animate();
  }
  
  /**
   * Показать анимацию выстрела
   * @param {Object} ray - луч выстрела
   * @param {Array} collisions - столкновения
   */
  showFireAnimation(ray, collisions) {
    if (!ray || !this.animationContainer) return;
    
    console.log('SpaceHolder | RayRenderer: Showing fire animation');
    
    // Создаем графику для анимации выстрела
    const fireGraphics = new PIXI.Graphics();
    
    // Стиль анимации выстрела
    const fireColor = 0xFF4444;
    const fireWidth = 5;
    const animationDuration = 1000; // 1 секунда
    
    // Рисуем луч выстрела
    fireGraphics.lineStyle(fireWidth, fireColor, 1.0);
    
    for (const segment of ray.segments) {
      if (ray.curved) {
        this._drawCurvedSegment(fireGraphics, ray);
      } else {
        fireGraphics.moveTo(segment.start.x, segment.start.y)
                   .lineTo(segment.end.x, segment.end.y);
      }
    }
    
    // Добавляем эффекты попаданий
    this._drawCollisionMarkers(fireGraphics, collisions);
    
    this.animationContainer.addChild(fireGraphics);
    
    // Анимируем исчезновение
    const startTime = Date.now();
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = elapsed / animationDuration;
      
      if (progress >= 1.0 || !fireGraphics || fireGraphics.destroyed) {
        if (fireGraphics && !fireGraphics.destroyed) {
          fireGraphics.destroy();
        }
        return;
      }
      
      // Эффект затухания
      fireGraphics.alpha = 1.0 - progress;
      
      requestAnimationFrame(animate);
    };
    
    animate();
    
    // Добавляем эффекты взрыва в точках попадания
    collisions.forEach((collision, index) => {
      setTimeout(() => {
        this._createExplosionEffect(collision.point, collision.type);
      }, index * 100); // Задержка между взрывами
    });
  }
  
  /**
   * Создать эффект взрыва в точке попадания
   * @private
   */
  _createExplosionEffect(point, type) {
    if (!this.animationContainer) return;
    
    const explosion = new PIXI.Graphics();
    let explosionColor = 0xFF8800; // Оранжевый по умолчанию
    
    if (type === 'token') {
      explosionColor = 0xFF0000; // Красный для попадания в токен
    } else if (type === 'wall') {
      explosionColor = 0x888888; // Серый для стен
    }
    
    const maxRadius = 20;
    const duration = 500;
    
    this.animationContainer.addChild(explosion);
    
    const startTime = Date.now();
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = elapsed / duration;
      
      if (progress >= 1.0 || explosion.destroyed) {
        if (!explosion.destroyed) explosion.destroy();
        return;
      }
      
      const radius = maxRadius * progress;
      const alpha = 1.0 - progress;
      
      explosion.clear();
      explosion.lineStyle(2, explosionColor, alpha);
      explosion.beginFill(explosionColor, alpha * 0.3);
      explosion.drawCircle(point.x, point.y, radius);
      explosion.endFill();
      
      requestAnimationFrame(animate);
    };
    
    animate();
  }
  
  /**
   * Очистить только луч предпросмотра (оставляя сегменты выстрелов)
   */
  clearPreview() {
    // Очищаем только луч предпросмотра
    if (this.currentRayGraphics) {
      this.currentRayGraphics.destroy();
      this.currentRayGraphics = null;
    }
  }
  
  /**
   * Очистить текущий луч и все сегменты выстрела
   */
  clearRay() {
    // Очищаем луч предпросмотра
    this.clearPreview();
    
    // Очищаем все сегменты выстрела
    if (this.fireSegments) {
      this.fireSegments.forEach(segment => {
        if (segment && !segment.destroyed) {
          segment.destroy();
        }
      });
      this.fireSegments = [];
    }
  }
  
  /**
   * Очистить все визуальные элементы
   */
  clearAll() {
    this.clearRay();
    this.hideAimingReticle();
    
    // Очищаем анимации
    if (this.animationContainer) {
      this.animationContainer.removeChildren();
    }
    
    // Останавливаем все активные анимации
    this.activeAnimations.forEach(animation => {
      if (animation && typeof animation.stop === 'function') {
        animation.stop();
      }
    });
    this.activeAnimations = [];
    
    // Очищаем мишени
    this._hideTargetCircles();
  }
  
  /**
   * Визуализация удалённого выстрела (от другого игрока)
   * @param {Object} shotData - данные о выстреле
   */
  async visualizeRemoteShot(shotData) {
    console.log('🌐 Visualizing remote shot:', shotData);
    
    const { token, direction, segments, hits } = shotData;
    
    if (!token || !this.rayContainer) {
      console.warn('SpaceHolder | RayRenderer: Cannot visualize remote shot - missing token or container');
      return;
    }
    
    console.log('🌐 Remote shot data:', {
      tokenId: token.id,
      segmentsCount: segments?.length || 0,
      hitsCount: hits?.length || 0
    });
    
    // Показываем маркер начала выстрела (БЕЗ очистки)
    this._showRemoteShotMarker(token);
    
    // Анимируем все сегменты (если они есть)
    if (segments && segments.length > 0) {
      console.log(`🎬 Animating ${segments.length} segments for remote shot`);
      for (let i = 0; i < segments.length; i++) {
        await this._animateRemoteSegment(segments[i], i, token.id);
      }
    }
    
    // Показываем эффекты попаданий
    if (hits && hits.length > 0) {
      hits.forEach((hit, index) => {
        setTimeout(() => {
          this._createExplosionEffect(hit.point, hit.type);
        }, index * 100);
      });
    }
  }
  
  /**
   * Отобразить сегмент удалённого выстрела
   * @param {Object} segmentData - данные о сегменте
   */
  displayRemoteShotSegment(segmentData) {
    console.log('🌐 Displaying remote shot segment:', segmentData);
    
    const { tokenId, segment, segmentIndex } = segmentData;
    
    if (!segment || !this.rayContainer) return;
    
    // Создаём графику для удалённого сегмента
    const remoteSegmentGraphics = new PIXI.Graphics();
    
    // Стиль для удалённых выстрелов (отличается от локальных)
    let fireColor, fireAlpha, fireWidth;
    
    if (segment.isRicochet) {
      const bounceLevel = segment.bounceNumber || 1;
      fireColor = bounceLevel === 1 ? 0x00FF88 : // Зелёно-голубой для первого рикошета
                  bounceLevel === 2 ? 0x00CCFF : // Голубой для второго
                                      0x0088FF;   // Синий для остальных
      fireAlpha = 0.8;
      fireWidth = 3;
    } else {
      // Основной выстрел - синий (отличается от красного локального)
      fireColor = 0x4444FF;
      fireAlpha = 0.8;
      fireWidth = 3;
    }
    
    remoteSegmentGraphics.lineStyle(fireWidth, fireColor, fireAlpha);
    
    // Рисуем сегмент
    remoteSegmentGraphics.moveTo(segment.start.x, segment.start.y)
                        .lineTo(segment.end.x, segment.end.y);
    
    // Маркер начала
    remoteSegmentGraphics.beginFill(fireColor, fireAlpha);
    remoteSegmentGraphics.drawCircle(segment.start.x, segment.start.y, Math.max(1, fireWidth - 1));
    remoteSegmentGraphics.endFill();
    
    // Идентификация
    remoteSegmentGraphics.name = `remoteSegment_${tokenId}_${segmentIndex}`;
    
    // Добавляем на сцену
    this.rayContainer.addChild(remoteSegmentGraphics);
    
    // Сохраняем ссылку для очистки
    if (!this.remoteSegments) {
      this.remoteSegments = new Map();
    }
    if (!this.remoteSegments.has(tokenId)) {
      this.remoteSegments.set(tokenId, []);
    }
    this.remoteSegments.get(tokenId).push(remoteSegmentGraphics);
  }
  
  /**
   * Отобразить эффект попадания от другого игрока
   * @param {Object} hitData - данные о попадании
   */
  displayRemoteHitEffect(hitData) {
    console.log('🌐 Displaying remote hit effect:', hitData);
    
    if (!hitData.hitPoint) return;
    
    // Показываем эффект взрыва с отличающимся цветом
    this._createRemoteExplosionEffect(hitData.hitPoint, hitData.hitType);
  }
  
  /**
   * Завершить визуализацию удалённого выстрела
   * @param {Object} completeData - итоговые данные
   */
  completeRemoteShot(completeData) {
    console.log('🌐 Completing remote shot visualization:', completeData);
    
    // Можно добавить дополнительные эффекты завершения
  }
  
  /**
   * Показать маркер начала удалённого выстрела
   * @private
   */
  _showRemoteShotMarker(token) {
    if (!token || !this.animationContainer) return;
    
    const marker = new PIXI.Graphics();
    const tokenCenter = token.center;
    
    // Маркер начала выстрела (отличающийся цвет)
    marker.beginFill(0x0088FF, 0.8);
    marker.drawCircle(tokenCenter.x, tokenCenter.y, 8);
    marker.endFill();
    
    marker.beginFill(0xFFFFFF, 1.0);
    marker.drawCircle(tokenCenter.x, tokenCenter.y, 3);
    marker.endFill();
    
    marker.name = `remoteShotMarker_${token.id}`;
    
    this.animationContainer.addChild(marker);
    
    // Анимация мигания
    const startTime = Date.now();
    const animate = () => {
      if (marker.destroyed) return;
      
      const elapsed = Date.now() - startTime;
      const progress = (elapsed % 1000) / 1000;
      marker.alpha = 0.5 + Math.sin(progress * Math.PI * 2) * 0.5;
      
      if (elapsed < 3000) { // 3 секунды
        requestAnimationFrame(animate);
      } else {
        marker.destroy();
      }
    };
    
    animate();
  }
  
  /**
   * Анимация сегмента удалённого выстрела
   * @private
   */
  async _animateRemoteSegment(segment, segmentIndex, tokenId) {
    if (!segment) return;
    
    // Отображаем сегмент
    this.displayRemoteShotSegment({ 
      tokenId,
      segment,
      segmentIndex
    });
    
    // Задержка между сегментами
    const delay = segment.isRicochet ? 75 : 50;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  /**
   * Очистить удалённые эффекты для конкретного токена
   * @private
   */
  _clearRemoteEffects(tokenId) {
    console.log(`🧡 Clearing remote effects for token ${tokenId}`);
    
    if (!this.remoteSegments) return;
    
    const segments = this.remoteSegments.get(tokenId);
    if (segments) {
      console.log(`🧡 Clearing ${segments.length} remote segments`);
      segments.forEach(segment => {
        if (segment && !segment.destroyed) {
          segment.destroy();
        }
      });
      this.remoteSegments.delete(tokenId);
    }
  }
  
  /**
   * Начать новый удалённый выстрел (очищает предыдущие)
   */
  startNewRemoteShot(tokenId) {
    console.log(`🎆 Starting new remote shot for token ${tokenId}`);
    this._clearRemoteEffects(tokenId);
  }
  
  /**
   * Создать эффект взрыва для удалённого попадания
   * @private
   */
  _createRemoteExplosionEffect(point, type) {
    if (!this.animationContainer) return;
    
    const explosion = new PIXI.Graphics();
    let explosionColor = 0x0088FF; // Синий по умолчанию для удалённых
    
    if (type === 'token') {
      explosionColor = 0x0066FF; // Синий для попадания в токен
    } else if (type === 'wall') {
      explosionColor = 0x4488CC; // Серо-синий для стен
    }
    
    const maxRadius = 15; // Меньше локальных взрывов
    const duration = 400;
    
    this.animationContainer.addChild(explosion);
    
    const startTime = Date.now();
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = elapsed / duration;
      
      if (progress >= 1.0 || explosion.destroyed) {
        if (!explosion.destroyed) explosion.destroy();
        return;
      }
      
      const radius = maxRadius * progress;
      const alpha = (1.0 - progress) * 0.8;
      
      explosion.clear();
      explosion.lineStyle(2, explosionColor, alpha);
      explosion.beginFill(explosionColor, alpha * 0.3);
      explosion.drawCircle(point.x, point.y, radius);
      explosion.endFill();
      
      requestAnimationFrame(animate);
    };
    
    animate();
  }
  
  /**
   * Уничтожить рендерер
   */
  destroy() {
    this.clearAll();
    
    // Очищаем все удалённые эффекты
    if (this.remoteSegments) {
      this.remoteSegments.forEach((segments) => {
        segments.forEach(segment => {
          if (segment && !segment.destroyed) {
            segment.destroy();
          }
        });
      });
      this.remoteSegments.clear();
    }
    
    // Окончательно очищаем мишени
    this._hideTargetCircles();
    
    if (this.aimingContainer && !this.aimingContainer.destroyed) {
      this.aimingContainer.destroy();
    }
    
    this.aimingContainer = null;
    this.rayContainer = null;
    this.reticleContainer = null;
    this.animationContainer = null;
    this.targetCircles = null;
  }
}

// CSS стили для информационной панели прицеливания
export const AIMING_STYLES = `
.aiming-info-panel {
  position: fixed;
  top: 20px;
  right: 20px;
  background: rgba(0, 0, 0, 0.8);
  color: white;
  padding: 15px;
  border-radius: 8px;
  border: 2px solid #ff4444;
  font-family: 'Roboto', sans-serif;
  font-size: 14px;
  z-index: 10000;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.5);
  min-width: 200px;
}

.aiming-instructions h3 {
  margin: 0 0 10px 0;
  color: #ff4444;
  text-align: center;
  border-bottom: 1px solid #444;
  padding-bottom: 5px;
}

.aiming-instructions p {
  margin: 5px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.aiming-instructions p:hover {
  background: rgba(255, 255, 255, 0.1);
  padding: 2px 5px;
  border-radius: 4px;
}

@keyframes aimingPulse {
  0% { border-color: #ff4444; }
  50% { border-color: #ff8888; }
  100% { border-color: #ff4444; }
}

.aiming-info-panel {
  animation: aimingPulse 2s infinite;
}
`;

// Функция для внедрения стилей в DOM
export function injectAimingStyles() {
  if (document.getElementById('aiming-styles')) return;
  
  const style = document.createElement('style');
  style.id = 'aiming-styles';
  style.textContent = AIMING_STYLES;
  document.head.appendChild(style);
}
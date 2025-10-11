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
    
    // Убираем предыдущий луч
    this.clearRay();
    
    // Создаем новую графику для луча
    const rayGraphics = new PIXI.Graphics();
    
    // Стиль луча предпросмотра
    const rayColor = 0x00FF00;
    const rayAlpha = 0.7;
    const rayWidth = 3;
    
    rayGraphics.lineStyle(rayWidth, rayColor, rayAlpha);
    
    // Рисуем все сегменты луча
    for (const segment of ray.segments) {
      if (ray.curved) {
        // Для изогнутых лучей рисуем кривую
        this._drawCurvedSegment(rayGraphics, ray);
      } else {
        // Для прямых лучей рисуем линию
        rayGraphics.moveTo(segment.start.x, segment.start.y)
                  .lineTo(segment.end.x, segment.end.y);
      }
    }
    
    // Проверяем коллизии и отмечаем точки попадания
    const collisions = this.aimingSystem.rayCaster.checkCollisions(ray);
    this._drawCollisionMarkers(rayGraphics, collisions);
    
    this.currentRayGraphics = rayGraphics;
    this.rayContainer.addChild(rayGraphics);
    
    // Анимация мерцания для предпросмотра
    this._animatePreviewRay(rayGraphics);
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
   * Очистить текущий луч
   */
  clearRay() {
    if (this.currentRayGraphics) {
      this.currentRayGraphics.destroy();
      this.currentRayGraphics = null;
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
  }
  
  /**
   * Уничтожить рендерер
   */
  destroy() {
    this.clearAll();
    
    if (this.aimingContainer && !this.aimingContainer.destroyed) {
      this.aimingContainer.destroy();
    }
    
    this.aimingContainer = null;
    this.rayContainer = null;
    this.reticleContainer = null;
    this.animationContainer = null;
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
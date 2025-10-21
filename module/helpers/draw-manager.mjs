// Draw Manager для SpaceHolder - отрисовка сегментов выстрелов
// Независимый модуль для рендеринга линий и кругов выстрелов
// Заменяет функциональность ray-renderer для отрисовки траекторий

export class DrawManager {
  constructor() {
    // Контейнеры для графических элементов
    this.drawContainer = null;
    this.currentDrawnElements = [];
    
    // Стили по умолчанию
    this.defaultStyles = {
      line: {
        color: 0xFF4444,
        alpha: 0.9,
        width: 4
      },
      circle: {
        color: 0xFF4444,
        alpha: 0.6,
        lineWidth: 3,
        fillAlpha: 0.2
      },
      cone: {
        color: 0xFF8844,
        alpha: 0.7,
        lineWidth: 2,
        fillAlpha: 0.15
      }
    };
  }
  
  /**
   * Инициализация менеджера отрисовки
   */
  initialize() {
    this._createContainer();
  }
  
  /**
   * Создание графического контейнера
   * @private
   */
  _createContainer() {
    if (!canvas?.stage || !canvas.effects) return;
    
    if (!this.drawContainer || this.drawContainer.destroyed) {
      this.drawContainer = new PIXI.Container();
      this.drawContainer.name = 'drawManager';
      
      // Размещаем на уровне эффектов (скрывается туманом войны)
      // Но с высоким zIndex чтобы быть поверх токенов
      this.drawContainer.zIndex = 1000;
      
      // Делаем контейнер неинтерактивным (прозрачным для кликов)
      this.drawContainer.interactiveChildren = false;
      this.drawContainer.interactive = false;
      
      // Добавляем в слой эффектов вместо stage
      canvas.effects.addChild(this.drawContainer);
    }
  }
  
  /**
   * Основной метод для отрисовки выстрела
   * @param {Object} shotResult - объект результата выстрела
   */
  drawShot(shotResult) {
    if (!shotResult || !shotResult.shotPaths) {
      console.warn('DrawManager: Invalid shotResult provided');
      return;
    }
    
    // Очищаем предыдущие элементы
    this.clearAll();
    
    // Убеждаемся что контейнер существует
    this._createContainer();
    
    // Отрисовываем каждый сегмент
    shotResult.shotPaths.forEach((segment, index) => {
      this.drawSegment(segment);
    });
  }
  
  /**
   * Отрисовка одного сегмента
   * @param {Object} segment - сегмент для отрисовки
   */
  drawSegment(segment) {
    if (!segment || !segment.type) {
      console.warn('DrawManager: Invalid segment provided');
      return;
    }
    
    switch (segment.type) {
      case 'line':
        this.drawLine(segment);
        break;
      case 'circle':
        this.drawCircle(segment);
        break;
      case 'cone':
        this.drawCone(segment);
        break;
      default:
        console.warn(`DrawManager: Unknown segment type: ${segment.type}`);
    }
  }
  
  /**
   * Отрисовка линейного сегмента
   * @param {Object} segment - сегмент с типом 'line'
   */
  drawLine(segment) {
    if (!segment.start || !segment.end || !this.drawContainer) {
      console.warn('DrawManager: Invalid line segment data');
      return;
    }
    
    const lineGraphics = new PIXI.Graphics();
    const style = this.defaultStyles.line;
    
    // Настройка стиля линии
    lineGraphics.lineStyle(style.width, style.color, style.alpha);
    
    // Рисуем линию
    lineGraphics.moveTo(segment.start.x, segment.start.y);
    lineGraphics.lineTo(segment.end.x, segment.end.y);
    
    // Добавляем маркер начала сегмента
    lineGraphics.beginFill(style.color, style.alpha);
    lineGraphics.drawCircle(segment.start.x, segment.start.y, Math.max(2, style.width - 1));
    lineGraphics.endFill();
    
    // Настройка идентификации
    lineGraphics.name = `drawManager_line_${segment.id || 'unknown'}`;
    
    // Делаем неинтерактивным
    lineGraphics.interactive = false;
    lineGraphics.interactiveChildren = false;
    
    // Добавляем на сцену
    this.drawContainer.addChild(lineGraphics);
    this.currentDrawnElements.push(lineGraphics);
    
    // Анимация появления
    this._animateElementAppearance(lineGraphics);
  }
  
  /**
   * Отрисовка кругового сегмента
   * @param {Object} segment - сегмент с типом 'circle'
   */
  drawCircle(segment) {
    if (!segment.start || !segment.range || !this.drawContainer) {
      console.warn('DrawManager: Invalid circle segment data');
      return;
    }
    
    const circleGraphics = new PIXI.Graphics();
    const style = this.defaultStyles.circle;
    
    // Настройка стиля окружности
    circleGraphics.lineStyle(style.lineWidth, style.color, style.alpha);
    circleGraphics.beginFill(style.color, style.fillAlpha);
    
    // Рисуем окружность
    circleGraphics.drawCircle(segment.start.x, segment.start.y, segment.range);
    circleGraphics.endFill();
    
    // Добавляем центральный маркер
    circleGraphics.beginFill(style.color, style.alpha);
    circleGraphics.drawCircle(segment.start.x, segment.start.y, 3);
    circleGraphics.endFill();
    
    // Настройка идентификации
    circleGraphics.name = `drawManager_circle_${segment.id || 'unknown'}`;
    
    // Делаем неинтерактивным
    circleGraphics.interactive = false;
    circleGraphics.interactiveChildren = false;
    
    // Добавляем на сцену
    this.drawContainer.addChild(circleGraphics);
    this.currentDrawnElements.push(circleGraphics);
    
    // Анимация появления
    this._animateElementAppearance(circleGraphics);
  }
  
  /**
   * Отрисовка конуса
   * @param {Object} segment - сегмент с типом 'cone'
   */
  drawCone(segment) {
    if (!segment.start || !segment.range || segment.angle === undefined || segment.direction === undefined || !this.drawContainer) {
      console.warn('DrawManager: Invalid cone segment data');
      return;
    }
    
    const coneGraphics = new PIXI.Graphics();
    const style = this.defaultStyles.cone;
    
    // Настройка стиля конуса
    coneGraphics.lineStyle(style.lineWidth, style.color, style.alpha);
    coneGraphics.beginFill(style.color, style.fillAlpha);
    
    // Параметры конуса
    const centerX = segment.start.x;
    const centerY = segment.start.y;
    const radius = segment.range;
    const angleRad = (segment.angle * Math.PI) / 180; // Переводим в радианы
    const directionRad = (segment.direction * Math.PI) / 180; // Переводим в радианы
    const cutRadius = segment.cut || 0; // Радиус усечения (по умолчанию 0)
    
    // Углы начала и конца конуса
    const startAngle = directionRad - angleRad / 2;
    const endAngle = directionRad + angleRad / 2;
    
    if (cutRadius <= 0) {
      // Обычный конус без усечения
      coneGraphics.moveTo(centerX, centerY);
      
      // Линия к начальной точке дуги
      const startX = centerX + Math.cos(startAngle) * radius;
      const startY = centerY + Math.sin(startAngle) * radius;
      coneGraphics.lineTo(startX, startY);
      
      // Дуга конуса
      coneGraphics.arc(centerX, centerY, radius, startAngle, endAngle);
      
      // Линия обратно к центру
      coneGraphics.lineTo(centerX, centerY);
    } else {
      // Усечённый конус (кольцевой сектор)
      // Внешняя дуга
      const outerStartX = centerX + Math.cos(startAngle) * radius;
      const outerStartY = centerY + Math.sin(startAngle) * radius;
      coneGraphics.moveTo(outerStartX, outerStartY);
      
      // Внешняя дуга от startAngle к endAngle
      coneGraphics.arc(centerX, centerY, radius, startAngle, endAngle);
      
      // Линия к внутренней дуге
      const innerEndX = centerX + Math.cos(endAngle) * cutRadius;
      const innerEndY = centerY + Math.sin(endAngle) * cutRadius;
      coneGraphics.lineTo(innerEndX, innerEndY);
      
      // Внутренняя дуга от endAngle к startAngle (в обратном направлении)
      coneGraphics.arc(centerX, centerY, cutRadius, endAngle, startAngle, true);
      
      // Замыкаем фигуру
      coneGraphics.lineTo(outerStartX, outerStartY);
    }
    
    coneGraphics.endFill();
    
    // Добавляем центральный маркер
    coneGraphics.beginFill(style.color, style.alpha);
    coneGraphics.drawCircle(centerX, centerY, 3);
    coneGraphics.endFill();
    
    // Настройка идентификации
    coneGraphics.name = `drawManager_cone_${segment.id || 'unknown'}`;
    
    // Делаем неинтерактивным
    coneGraphics.interactive = false;
    coneGraphics.interactiveChildren = false;
    
    // Добавляем на сцену
    this.drawContainer.addChild(coneGraphics);
    this.currentDrawnElements.push(coneGraphics);
    
    // Анимация появления
    this._animateElementAppearance(coneGraphics);
  }
  
  /**
   * Анимация появления элемента
   * @param {PIXI.Graphics} element - графический элемент
   * @private
   */
  _animateElementAppearance(element) {
    if (!element || element.destroyed) return;
    
    element.alpha = 0;
    const startTime = Date.now();
    const fadeInDuration = 200;
    const targetAlpha = element === this.currentDrawnElements[this.currentDrawnElements.length - 1] ? 
                      (element.name.includes('circle') ? this.defaultStyles.circle.alpha : this.defaultStyles.line.alpha) : 
                      1.0;
    
    const fadeIn = () => {
      if (!element || element.destroyed) return;
      
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / fadeInDuration, 1);
      element.alpha = progress * targetAlpha;
      
      if (progress < 1) {
        requestAnimationFrame(fadeIn);
      }
    };
    
    fadeIn();
  }
  
  /**
   * Очистка всех нарисованных элементов
   */
  clearAll() {
    if (this.currentDrawnElements.length > 0) {
      this.currentDrawnElements.forEach(element => {
        if (element && !element.destroyed) {
          element.destroy();
        }
      });
      this.currentDrawnElements = [];
    }
  }
  
  /**
   * Установка пользовательских стилей
   * @param {Object} styles - объект со стилями для line, circle и/или cone
   */
  setStyles(styles) {
    if (styles.line) {
      this.defaultStyles.line = { ...this.defaultStyles.line, ...styles.line };
    }
    if (styles.circle) {
      this.defaultStyles.circle = { ...this.defaultStyles.circle, ...styles.circle };
    }
    if (styles.cone) {
      this.defaultStyles.cone = { ...this.defaultStyles.cone, ...styles.cone };
    }
  }
  
  /**
   * Уничтожение менеджера отрисовки
   */
  destroy() {
    this.clearAll();
    
    if (this.drawContainer && !this.drawContainer.destroyed) {
      this.drawContainer.destroy();
    }
    
    this.drawContainer = null;
    this.currentDrawnElements = [];
  }
}
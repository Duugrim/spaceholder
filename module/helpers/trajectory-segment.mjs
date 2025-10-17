// Базовый класс для сегментов траектории выстрела
// Использует полиморфизм - каждый тип сегмента знает, как себя выполнять и рендерить

/**
 * Базовый класс для всех типов сегментов траектории
 */
export class TrajectorySegment {
  constructor(config) {
    this.type = config.type;
    this.length = config.length;
    this.damage = config.damage || null; // Placeholder для будущей системы урона
    this.effects = config.effects || {};
    this.allowRicochet = config.allowRicochet ?? false;
    this.maxRicochets = config.maxRicochets ?? 0;
    this.children = config.children || []; // Для разделяющихся снарядов
  }
  
  /**
   * Выполнить логику сегмента (абстрактный метод)
   * @param {Object} shotContext - контекст выстрела
   * @returns {Promise<Object>} результат выполнения сегмента
   */
  async execute(shotContext) {
    throw new Error(`TrajectorySegment.execute() must be implemented in ${this.constructor.name}`);
  }
  
  /**
   * Отрендерить сегмент (абстрактный метод)
   * @param {RayRenderer} rayRenderer - рендерер лучей
   * @param {number} segmentIndex - индекс сегмента
   * @param {Object} renderContext - контекст рендеринга
   */
  render(rayRenderer, segmentIndex, renderContext) {
    throw new Error(`TrajectorySegment.render() must be implemented in ${this.constructor.name}`);
  }
  
  /**
   * Создать копию сегмента с новыми параметрами
   * @param {Object} overrides - параметры для переопределения
   * @returns {TrajectorySegment} новый экземпляр сегмента
   */
  clone(overrides = {}) {
    const config = {
      type: this.type,
      length: this.length,
      damage: this.damage,
      effects: { ...this.effects },
      allowRicochet: this.allowRicochet,
      maxRicochets: this.maxRicochets,
      children: [...this.children],
      ...overrides
    };
    
    return new this.constructor(config);
  }
  
  /**
   * Проверить, имеет ли сегмент дочерние элементы (разделяющиеся снаряды)
   * @returns {boolean}
   */
  hasSplit() {
    return this.children && this.children.length > 0;
  }
  
  /**
   * Применить эффекты сегмента
   * @param {string} eventType - тип события (onHit, onMiss, onCollision, etc.)
   * @param {Object} context - контекст применения эффектов
   */
  applyEffects(eventType, context) {
    const effects = this.effects[eventType];
    if (!effects || effects.length === 0) return;
    
    // Placeholder для будущей системы эффектов
    console.log(`Applying ${eventType} effects:`, effects, 'Context:', context);
    
    // Здесь будет логика применения эффектов:
    // - Взрывы
    // - Визуальные эффекты
    // - Звуки
    // - Статусные эффекты
  }
}

/**
 * Сегмент прямой линии заданной длины
 */
export class LineSegment extends TrajectorySegment {
  constructor(config) {
    super(config);
    this.type = 'line';
  }
  
  async execute(shotContext) {
    const { rayCaster, currentPosition, direction, shooterToken } = shotContext;
    
    // Создаем луч заданной длины
    const ray = rayCaster.createSimpleRay(currentPosition, direction, this.length);
    
    // Проверяем коллизии (исключаем токен стрелка только если он передан)
    const collisionOptions = shooterToken ? { excludeToken: shooterToken } : {};
    console.log(`LineSegment DEBUG: Ray length=${this.length}, start=${JSON.stringify(currentPosition)}, end=${JSON.stringify(ray.end)}, excludeToken=${shooterToken?.name || 'none'}`);
    const validCollisions = rayCaster.checkSegmentCollisions(ray, collisionOptions);
    console.log(`LineSegment DEBUG: Found ${validCollisions.length} collisions:`, validCollisions.map(c => ({ type: c.type, distance: c.distance, object: c.object?.name || c.object?.id })));
    
    // Применяем эффекты в зависимости от результата
    if (validCollisions.length > 0) {
      const firstHit = validCollisions[0];
      
      // Обрезаем луч до точки столкновения
      const hitDistance = firstHit.distance;
      const actualEnd = {
        x: currentPosition.x + Math.cos(direction * Math.PI / 180) * hitDistance,
        y: currentPosition.y + Math.sin(direction * Math.PI / 180) * hitDistance
      };
      
      ray.end = actualEnd;
      ray.actualLength = hitDistance;
      
      this.applyEffects('onHit', { hit: firstHit, ray });
    } else {
      this.applyEffects('onMiss', { ray });
    }
    
    return {
      ray: ray,
      collisions: validCollisions,
      nextPosition: ray.end,
      shouldContinue: validCollisions.length === 0 // Продолжаем только если нет столкновений
    };
  }
  
  render(rayRenderer, segmentIndex, renderContext) {
    const { ray, isRemote = false } = renderContext;
    
    if (isRemote) {
      rayRenderer.drawRemoteSegment(ray, segmentIndex);
    } else {
      rayRenderer.drawFireSegment(ray, segmentIndex);
    }
  }
}

/**
 * Повторяющийся сегмент линии (до столкновения)
 */
export class LineRecSegment extends TrajectorySegment {
  constructor(config) {
    super(config);
    this.type = 'lineRec';
    this.maxIterations = config.maxIterations || 50; // Защита от бесконечного цикла
  }
  
  async execute(shotContext) {
    const { rayCaster, currentPosition, direction, shooterToken } = shotContext;
    const allRays = [];
    const allCollisions = [];
    
    let position = { ...currentPosition };
    let iteration = 0;
    let hasCollision = false;
    
    // Повторяем создание сегментов до столкновения или достижения лимита
    while (!hasCollision && iteration < this.maxIterations) {
      // Создаем очередной сегмент
      const ray = rayCaster.createSimpleRay(position, direction, this.length);
      ray.iterationIndex = iteration;
      
      // Проверяем коллизии (исключаем токен стрелка только если он передан)
      const collisionOptions = shooterToken ? { excludeToken: shooterToken } : {};
      const validCollisions = rayCaster.checkSegmentCollisions(ray, collisionOptions);
      
      allRays.push(ray);
      
      if (validCollisions.length > 0) {
        const firstHit = validCollisions[0];
        
        // Обрезаем последний луч до точки столкновения
        const hitDistance = firstHit.distance;
        const actualEnd = {
          x: position.x + Math.cos(direction * Math.PI / 180) * hitDistance,
          y: position.y + Math.sin(direction * Math.PI / 180) * hitDistance
        };
        
        ray.end = actualEnd;
        ray.actualLength = hitDistance;
        
        allCollisions.push(...validCollisions);
        hasCollision = true;
        
        this.applyEffects('onCollision', { hit: firstHit, ray, iteration });
      } else {
        // Продвигаемся дальше
        position = { ...ray.end };
      }
      
      iteration++;
    }
    
    // Если дошли до лимита итераций без столкновений
    if (!hasCollision) {
      this.applyEffects('onMiss', { rays: allRays, iterations: iteration });
    }
    
    return {
      rays: allRays,
      collisions: allCollisions,
      nextPosition: allRays[allRays.length - 1]?.end || currentPosition,
      shouldContinue: false, // LineRec всегда завершает траекторию
      iterations: iteration
    };
  }
  
  render(rayRenderer, segmentIndex, renderContext) {
    const { rays, isRemote = false } = renderContext;
    
    // Рендерим все сегменты lineRec
    rays.forEach((ray, index) => {
      const adjustedIndex = segmentIndex + index;
      
      if (isRemote) {
        rayRenderer.drawRemoteSegment(ray, adjustedIndex);
      } else {
        rayRenderer.drawFireSegment(ray, adjustedIndex);
      }
    });
  }
}

/**
 * Фабрика для создания сегментов траектории
 */
export class TrajectorySegmentFactory {
  static create(config) {
    switch (config.type) {
      case 'line':
        return new LineSegment(config);
      case 'lineRec':
        return new LineRecSegment(config);
      default:
        throw new Error(`Unknown trajectory segment type: ${config.type}`);
    }
  }
  
  /**
   * Создать массив сегментов из конфигурации payload
   * @param {Array} trajectoryConfig - конфигурация траектории из payload
   * @returns {Array<TrajectorySegment>} массив сегментов
   */
  static createTrajectory(trajectoryConfig) {
    return trajectoryConfig.map(segmentConfig => this.create(segmentConfig));
  }
}
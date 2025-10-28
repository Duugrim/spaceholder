/**
 * Shot Manager - система просчёта выстрелов
 * Преобразует payload (инструкции) в shotResult (координаты для визуализации)
 */

/**
 * ShotSystem - центральное хранилище выстрелов
 */
class ShotSystem {
  constructor() {
    this.shots = new Map(); // Хранилище активных выстрелов
  }

  /**
   * Генерация уникального ID для выстрела
   * @returns {string} UID формата shot_{timestamp}
   */
  generateUID() {
    return `shot_${Date.now()}`;
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
        shotHits: []    // Массив попаданий
      },
      actualHits: []    // Массив фактических попаданий от HitSystem
    };
    
    this.shots.set(uid, shot);
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
}

/**
 * ShotManager - главный класс для управления выстрелами
 */
export class ShotManager {
  constructor() {
    this.shotSystem = new ShotSystem();
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
   * Проверка столкновений сегмента с объектами
   * @param {object} segment - Сегмент {start, end, type, props}
   * @param {Array} whitelist - Список игнорируемых объектов
   * @returns {object} Результат {hit, point, type, object, shouldStop}
   */
  isHit(segment, whitelist) {
    if (!segment.props.collision) {
      return { hit: false, shouldStop: false };
    }

    const collisions = [];
    
    // Проверка столкновений с токенами
    if (canvas.tokens?.placeables) {
      for (const token of canvas.tokens.placeables) {
        if (whitelist.includes(token)) continue;
        if (!token.visible) continue;
        
        const bounds = token.bounds;
        const centerX = bounds.x + bounds.width / 2;
        const centerY = bounds.y + bounds.height / 2;
        const radius = Math.min(bounds.width, bounds.height) / 2;
        
        const intersection = this._rayCircleIntersection(
          segment.start,
          segment.end,
          { x: centerX, y: centerY },
          radius
        );
        
        if (intersection) {
          const distance = Math.hypot(
            intersection.x - segment.start.x,
            intersection.y - segment.start.y
          );
          
          collisions.push({
            type: 'token',
            object: token,
            point: intersection,
            distance: distance
          });
        }
      }
    }
    
    // Проверка столкновений со стенами
    if (canvas.walls?.placeables) {
      for (const wall of canvas.walls.placeables) {
        if (!wall.document.move) continue;
        
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
            distance: distance
          });
        }
      }
    }
    
    // Сортируем по расстоянию
    collisions.sort((a, b) => a.distance - b.distance);
    
    // Если нет столкновений
    if (collisions.length === 0) {
      return { hit: false, shouldStop: false };
    }
    
    // Берём ближайшее столкновение
    const nearestCollision = collisions[0];
    
    // Определяем, останавливать ли выстрел
    const shouldStop = !segment.props.penetration;
    
    return {
      hit: true,
      point: nearestCollision.point,
      type: nearestCollision.type,
      object: nearestCollision.object,
      shouldStop: shouldStop,
      allCollisions: collisions
    };
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
    
    // Вычисляем абсолютное направление сегмента
    const absoluteDirection = direction + segment.direction;
    
    // Расчёт конечной точки для данного сегмента
    let endPos = this.shotLine(lastPos, absoluteDirection, segment.length, defSize);
    
    // Создаём временный объект сегмента для проверки
    const testSegment = {
      start: { ...lastPos },
      end: { ...endPos },
      type: segment.type,
      props: segment.props
    };
    
    // Проверяем столкновения
    const hitResult = this.isHit(testSegment, whitelist);
    
    // Если есть столкновение и нужно остановиться
    if (hitResult.hit && hitResult.shouldStop) {
      // Корректируем конечную точку до места столкновения
      endPos = hitResult.point;
    }
    
    // Создаём объект пути для сохранения
    const path = {
      start: { ...lastPos },
      end: { ...endPos },
      type: segment.type
    };
    
    shot.shotResult.shotPaths.push(path);
    
    // Сохраняем информацию о попадании
    if (hitResult.hit) {
      shot.shotResult.shotHits.push({
        point: hitResult.point,
        type: hitResult.type,
        object: hitResult.object
      });
      
      shot.actualHits.push(hitResult);
    }
    
    return {
      endPos: endPos,
      direction: absoluteDirection,
      shouldContinue: !hitResult.shouldStop
    };
  }

  /**
   * Создание и просчёт выстрела
   * @param {Token} token - Токен, который стреляет
   * @param {object} payload - Объект с инструкциями траектории
   * @param {number} direction - Начальное направление в градусах
   * @returns {string} UID созданного выстрела
   */
  createShot(token, payload, direction) {
    // 1. Генерация UID и регистрация выстрела
    const uid = this.shotSystem.generateUID();
    const shot = this.shotSystem.registerShot(uid);
    
    // 2. Получение whitelist и базовых параметров
    const whitelist = this.getWhitelist(token);
    const defaults = this.getDefaults(token);
    
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
        shot: shot
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
}

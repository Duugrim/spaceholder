// Ray Casting System for SpaceHolder - создание и обработка лучей
// Обрабатывает создание лучей, обнаружение коллизий с токенами, стенами и тайлами
//
// Примечание: Использует foundry.canvas.geometry.Ray вместо устаревшего Ray для Foundry v13+

export class RayCaster {
  constructor(aimingSystem) {
    this.aimingSystem = aimingSystem;
  }
  
  /**
   * Инициализация системы лучей
   */
  initialize() {
    console.log('SpaceHolder | RayCaster: Initializing ray casting system');
  }
  
  /**
   * Создать луч в указанном направлении
   * @param {Object} origin - начальная точка луча {x, y}
   * @param {number} direction - направление в градусах (0° = вправо)
   * @param {number} maxDistance - максимальная дальность луча
   * @param {Object} options - дополнительные опции луча
   * @returns {Object} объект луча
   */
  createRay(origin, direction, maxDistance, options = {}) {
    // Преобразуем угол в радианы
    const angleRad = (direction * Math.PI) / 180;
    
    // Вычисляем конечную точку луча
    const endX = origin.x + Math.cos(angleRad) * maxDistance;
    const endY = origin.y + Math.sin(angleRad) * maxDistance;
    
    const ray = {
      id: foundry.utils.randomID(),
      origin: { x: origin.x, y: origin.y },
      end: { x: endX, y: endY },
      direction: direction,
      maxDistance: maxDistance,
      angleRad: angleRad,
      
      // Опции луча
      allowRicochet: options.allowRicochet ?? false,
      maxRicochets: options.maxRicochets ?? 3,
      curved: options.curved ?? false,
      curvatureTarget: options.curvatureTarget ?? null,
      
      // Данные для визуализации
      segments: [], // массив сегментов луча (для рикошетов)
      collisions: [] // найденные столкновения
    };
    
    // Добавляем начальный сегмент
    ray.segments.push({
      start: ray.origin,
      end: ray.end,
      direction: ray.direction
    });
    
    return ray;
  }
  
  /**
   * Проверить столкновения луча с объектами на сцене
   * @param {Object} ray - объект луча
   * @returns {Array} массив столкновений, отсортированный по расстоянию
   */
  checkCollisions(ray) {
    const collisions = [];
    
    // Проверяем столкновения для каждого сегмента луча
    for (let i = 0; i < ray.segments.length; i++) {
      const segment = ray.segments[i];
      
      // Проверяем столкновения с токенами
      const tokenCollisions = this._checkTokenCollisions(segment);
      collisions.push(...tokenCollisions);
      
      // Проверяем столкновения со стенами
      const wallCollisions = this._checkWallCollisions(segment);
      collisions.push(...wallCollisions);
      
      // Проверяем столкновения с тайлами (если нужно)
      if (this.aimingSystem.config.checkTileCollisions) {
        const tileCollisions = this._checkTileCollisions(segment);
        collisions.push(...tileCollisions);
      }
    }
    
    // Сортируем столкновения по расстоянию от начала луча
    collisions.sort((a, b) => a.distance - b.distance);
    
    // Сохраняем столкновения в объекте луча
    ray.collisions = collisions;
    
    // Обрабатываем рикошеты, если они включены
    if (ray.allowRicochet && ray.segments.length < ray.maxRicochets + 1) {
      this._processRicochets(ray, collisions);
    }
    
    return collisions;
  }
  
  /**
   * Проверить столкновения с токенами
   * @private
   */
  _checkTokenCollisions(segment) {
    const collisions = [];
    
    if (!canvas.tokens?.placeables) return collisions;
    
    // Создаем объект Ray из Foundry для проверки пересечений
    const ray = new foundry.canvas.geometry.Ray(segment.start, segment.end);
    
    for (const token of canvas.tokens.placeables) {
      // Пропускаем токен, который стреляет
      if (token === this.aimingSystem.aimingToken) continue;
      
      // Пропускаем невидимые токены
      if (!token.visible) continue;
      
      // Создаем прямоугольник токена
      const bounds = token.bounds;
      const tokenRect = new PIXI.Rectangle(bounds.x, bounds.y, bounds.width, bounds.height);
      
      // Проверяем пересечение луча с прямоугольником токена
      const intersection = this._rayRectangleIntersection(ray, tokenRect);
      
      if (intersection) {
        const distance = Math.hypot(
          intersection.x - segment.start.x,
          intersection.y - segment.start.y
        );
        
        collisions.push({
          type: 'token',
          object: token,
          point: intersection,
          distance: distance,
          segment: segment
        });
      }
    }
    
    return collisions;
  }
  
  /**
   * Проверить столкновения со стенами
   * @private
   */
  _checkWallCollisions(segment) {
    const collisions = [];
    
    if (!canvas.walls?.placeables) return collisions;
    
    const ray = new foundry.canvas.geometry.Ray(segment.start, segment.end);
    
    for (const wall of canvas.walls.placeables) {
      // Пропускаем стены, которые не блокируют движение
      if (!wall.document.move) continue;
      
      // Создаем отрезок стены
      const wallRay = new foundry.canvas.geometry.Ray(
        { x: wall.document.c[0], y: wall.document.c[1] },
        { x: wall.document.c[2], y: wall.document.c[3] }
      );
      
      // Проверяем пересечение луча со стеной (отрезок, а не бесконечная линия)
      const intersection = this._raySegmentIntersection(
        segment.start, segment.end,
        wallRay.A, wallRay.B
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
          segment: segment,
          wallRay: wallRay
        });
      }
    }
    
    return collisions;
  }
  
  /**
   * Проверить столкновения с тайлами
   * @private
   */
  _checkTileCollisions(segment) {
    const collisions = [];
    
    if (!canvas.tiles?.placeables) return collisions;
    
    const ray = new foundry.canvas.geometry.Ray(segment.start, segment.end);
    
    for (const tile of canvas.tiles.placeables) {
      // Пропускаем тайлы без коллизий
      if (!tile.document.occlusion?.mode) continue;
      
      const bounds = tile.bounds;
      const tileRect = new PIXI.Rectangle(bounds.x, bounds.y, bounds.width, bounds.height);
      
      const intersection = this._rayRectangleIntersection(ray, tileRect);
      
      if (intersection) {
        const distance = Math.hypot(
          intersection.x - segment.start.x,
          intersection.y - segment.start.y
        );
        
        collisions.push({
          type: 'tile',
          object: tile,
          point: intersection,
          distance: distance,
          segment: segment
        });
      }
    }
    
    return collisions;
  }
  
  /**
   * Проверить пересечение луча (отрезка) с отрезком стены
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
    
    // Линии параллельны
    if (Math.abs(denom) < 1e-10) return null;
    
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
    
    // Проверяем, что пересечение находится на обоих отрезках
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return {
        x: x1 + t * (x2 - x1),
        y: y1 + t * (y2 - y1)
      };
    }
    
    return null;
  }
  
  /**
   * Вычислить пересечение луча с прямоугольником
   * @private
   */
  _rayRectangleIntersection(ray, rectangle) {
    const dx = ray.dx;
    const dy = ray.dy;
    
    if (dx === 0 && dy === 0) return null;
    
    const x1 = ray.A.x;
    const y1 = ray.A.y;
    const x2 = ray.B.x;
    const y2 = ray.B.y;
    
    const left = rectangle.x;
    const right = rectangle.x + rectangle.width;
    const top = rectangle.y;
    const bottom = rectangle.y + rectangle.height;
    
    let tMin = 0;
    let tMax = 1;
    
    // Проверяем пересечение с левой и правой сторонами
    if (dx !== 0) {
      const t1 = (left - x1) / dx;
      const t2 = (right - x1) / dx;
      
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (x1 < left || x1 > right) {
      return null;
    }
    
    // Проверяем пересечение с верхней и нижней сторонами
    if (dy !== 0) {
      const t1 = (top - y1) / dy;
      const t2 = (bottom - y1) / dy;
      
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (y1 < top || y1 > bottom) {
      return null;
    }
    
    if (tMin <= tMax && tMin >= 0 && tMin <= 1) {
      return {
        x: x1 + tMin * dx,
        y: y1 + tMin * dy
      };
    }
    
    return null;
  }
  
  /**
   * Обработать рикошеты луча
   * @private
   */
  _processRicochets(ray, collisions) {
    // Находим первое столкновение со стеной
    const wallCollision = collisions.find(c => c.type === 'wall');
    if (!wallCollision) return;
    
    // Вычисляем отраженный луч
    const reflectedRay = this._calculateReflection(ray, wallCollision);
    if (!reflectedRay) return;
    
    // Добавляем новый сегмент к лучу
    ray.segments.push(reflectedRay);
    
    // Рекурсивно проверяем столкновения нового сегмента
    const newCollisions = this._checkWallCollisions(reflectedRay);
    newCollisions.concat(this._checkTokenCollisions(reflectedRay));
    
    // Добавляем новые столкновения к общему списку
    ray.collisions.push(...newCollisions);
  }
  
  /**
   * Вычислить отраженный луч от стены
   * @private
   */
  _calculateReflection(originalRay, wallCollision) {
    const wall = wallCollision.wallRay;
    const hitPoint = wallCollision.point;
    
    // Вектор направления исходного луча
    const rayDir = {
      x: Math.cos(originalRay.angleRad),
      y: Math.sin(originalRay.angleRad)
    };
    
    // Вектор стены
    const wallVector = {
      x: wall.B.x - wall.A.x,
      y: wall.B.y - wall.A.y
    };
    
    // Нормаль к стене
    const wallLength = Math.hypot(wallVector.x, wallVector.y);
    const wallNormal = {
      x: -wallVector.y / wallLength,
      y: wallVector.x / wallLength
    };
    
    // Отраженный вектор направления
    const dot = 2 * (rayDir.x * wallNormal.x + rayDir.y * wallNormal.y);
    const reflectedDir = {
      x: rayDir.x - dot * wallNormal.x,
      y: rayDir.y - dot * wallNormal.y
    };
    
    // Оставшееся расстояние луча
    const usedDistance = Math.hypot(
      hitPoint.x - originalRay.origin.x,
      hitPoint.y - originalRay.origin.y
    );
    const remainingDistance = originalRay.maxDistance - usedDistance;
    
    if (remainingDistance <= 0) return null;
    
    // Создаем новый сегмент
    return {
      start: hitPoint,
      end: {
        x: hitPoint.x + reflectedDir.x * remainingDistance,
        y: hitPoint.y + reflectedDir.y * remainingDistance
      },
      direction: Math.atan2(reflectedDir.y, reflectedDir.x) * (180 / Math.PI)
    };
  }
  
  /**
   * Создать изогнутый луч, притягивающийся к цели
   * @param {Object} origin - начальная точка
   * @param {Object} target - цель притяжения
   * @param {number} maxDistance - максимальная дальность
   * @param {number} curvature - сила изгиба (0-1)
   */
  createCurvedRay(origin, target, maxDistance, curvature = 0.5) {
    // Прямое направление к цели
    const directDistance = Math.hypot(target.x - origin.x, target.y - origin.y);
    const directAngle = Math.atan2(target.y - origin.y, target.x - origin.x);
    
    // Если цель слишком далеко, создаем обычный луч в направлении цели
    if (directDistance > maxDistance) {
      return this.createRay(origin, directAngle * (180 / Math.PI), maxDistance);
    }
    
    // Создаем кривую Безье для изогнутого луча
    const controlPointDistance = directDistance * curvature;
    const controlAngle = directAngle + Math.PI / 2; // перпендикулярно к прямой линии
    
    const controlPoint = {
      x: origin.x + directDistance * 0.5 * Math.cos(directAngle) + controlPointDistance * Math.cos(controlAngle),
      y: origin.y + directDistance * 0.5 * Math.sin(directAngle) + controlPointDistance * Math.sin(controlAngle)
    };
    
    // Генерируем точки кривой
    const curvePoints = this._generateBezierCurve(origin, controlPoint, target, 20);
    
    const ray = {
      id: foundry.utils.randomID(),
      origin: origin,
      end: target,
      maxDistance: maxDistance,
      curved: true,
      curvature: curvature,
      controlPoint: controlPoint,
      curvePoints: curvePoints,
      segments: [],
      collisions: []
    };
    
    // Создаем сегменты из точек кривой
    for (let i = 0; i < curvePoints.length - 1; i++) {
      ray.segments.push({
        start: curvePoints[i],
        end: curvePoints[i + 1],
        direction: Math.atan2(
          curvePoints[i + 1].y - curvePoints[i].y,
          curvePoints[i + 1].x - curvePoints[i].x
        ) * (180 / Math.PI)
      });
    }
    
    return ray;
  }
  
  /**
   * Генерировать точки кривой Безье
   * @private
   */
  _generateBezierCurve(start, control, end, segments) {
    const points = [];
    
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * control.x + Math.pow(t, 2) * end.x;
      const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * control.y + Math.pow(t, 2) * end.y;
      
      points.push({ x, y });
    }
    
    return points;
  }
}
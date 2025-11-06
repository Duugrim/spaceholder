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
   * Получить множитель размера цели на основе DEX токена
   * @private
   * @param {Token} token - Токен
   * @returns {number} Множитель размера (DEX/10)
   */
  _getTargetSizeMultiplier(token) {
    if (!token || !token.actor) return 1.0;
    
    // Получаем DEX из способностей актора
    const dex = token.actor.system?.abilities?.dex?.value;
    if (typeof dex !== 'number' || dex <= 0) return 1.0;
    
    return dex / 10;
  }

  /**
   * Расчёт процента покрытия токена кругом (метод сэмплирования)
   * @private
   * @param {object} circleCenter - Центр круга {x, y}
   * @param {number} circleRadius - Радиус круга
   * @param {object} tokenCenter - Центр токена {x, y}
   * @param {number} tokenRadius - Радиус токена
   * @param {object} collisionOptions - Опции проверки collision {walls, tokens}
   * @param {Array} whitelist - Список игнорируемых токенов
   * @param {Token} targetToken - Целевой токен (для учета высоты)
   * @returns {object} Результат {coverage: number, hitPoints: [{x, y}]}
   */
  _calculateCircleTokenCoverage(circleCenter, circleRadius, tokenCenter, tokenRadius, collisionOptions = {}, whitelist = [], targetToken = null) {
    // Применяем множитель размера на основе DEX
    const sizeMultiplier = this._getTargetSizeMultiplier(targetToken);
    const effectiveRadius = tokenRadius * sizeMultiplier;
    
    // Расстояние от центра круга до центра токена
    const distance = Math.hypot(tokenCenter.x - circleCenter.x, tokenCenter.y - circleCenter.y);
    
    // Быстрая проверка: токен вне круга (используем эффективный радиус)
    if (distance > circleRadius + effectiveRadius) return { coverage: 0, hitPoints: [] };
    
    // Сэмплирование: разбиваем токен на точки по кругу
    const sampleCount = 32; // Количество точек для сэмплирования
    const sampleRings = 3;  // Кольца сэмплирования (1 = центр + край)
    
    let hitCount = 0;
    let totalCount = 0;
    const hitPoints = [];
    
    // Центр токена
    totalCount++;
    const centerInCircle = Math.hypot(tokenCenter.x - circleCenter.x, tokenCenter.y - circleCenter.y) <= circleRadius;
    if (centerInCircle) {
      // Проверяем LoS до центра токена
      const losCheck = this._checkLineOfSight(circleCenter, tokenCenter, collisionOptions, whitelist, targetToken);
      if (!losCheck.blocked) {
        hitCount++;
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
    // Применяем множитель размера на основе DEX
    const sizeMultiplier = this._getTargetSizeMultiplier(targetToken);
    const effectiveRadius = tokenRadius * sizeMultiplier;
    
    // Расстояние от начала конуса до центра токена
    const distance = Math.hypot(tokenCenter.x - coneOrigin.x, tokenCenter.y - coneOrigin.y);
    
    // Быстрая проверка: токен вне возможного радиуса (используем эффективный радиус)
    if (distance > coneRange + effectiveRadius || distance < coneCut - effectiveRadius) return { coverage: 0, hitPoints: [] };
    
    // Сэмплирование: разбиваем токен на точки по кругу
    const sampleCount = 32; // Количество точек для сэмплирования
    const sampleRings = 3;  // Кольца сэмплирования (1 = центр + край)
    
    let hitCount = 0;
    let totalCount = 0;
    const hitPoints = [];
    
    // Центр токена
    totalCount++;
    if (this._isPointInCone(tokenCenter, coneOrigin, coneRange, coneCut, coneDirectionRad, coneHalfAngleRad)) {
      // Проверяем LoS до центра токена
      const losCheck = this._checkLineOfSight(coneOrigin, tokenCenter, collisionOptions, whitelist, targetToken);
      if (!losCheck.blocked) {
        hitCount++;
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
        if (!wall.document.move) continue;
        
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
        const radius = Math.min(bounds.width, bounds.height) / 2;
        
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
        const radius = Math.min(bounds.width, bounds.height) / 2;
        
        // Применяем множитель размера на основе DEX
        const sizeMultiplier = this._getTargetSizeMultiplier(token);
        const effectiveRadius = radius * sizeMultiplier;
        
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
          
          // Рассчитываем closeness: 1.0 = точно в центр, 0.0 = касательное попадание
          const closeness = 1 - Math.min(Math.max(distanceToCenter / effectiveRadius, 0), 1);
          
          // Рассчитываем угол между векторами SH и HC (опционально)
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
              closeness: closeness,
              angleDeg: angleDeg
            }
          });
        }
      }
    }
    
    // Проверка столкновений со стенами
    if (checkWalls && canvas.walls?.placeables) {
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
   * Проверка столкновений для кругового сегмента (взрыв)
   * @private
   */
  _isHitCircle(segment, whitelist) {
    const collisions = [];
    const checkTokens = segment.collision.tokens !== false;
    const shooterToken = segment.shooterToken;
    
    if (!checkTokens || !canvas.tokens?.placeables) {
      return [];
    }
    
    const circleCenter = segment.start;
    const circleRadius = segment.range;
    
    for (const token of canvas.tokens.placeables) {
      if (whitelist.includes(token)) continue;
      if (!token.visible) continue;
      
      // Проверка диспозиции
      if (shooterToken && this._shouldIgnoreByDisposition(token, segment, shooterToken)) {
        continue;
      }
      
      const tokenCenter = token.center;
      const tokenBounds = token.bounds;
      const tokenRadius = Math.min(tokenBounds.width, tokenBounds.height) / 2;
      
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
        segment.collision, extendedWhitelist, token
      );
        
        // Если есть хоть какое-то покрытие - добавляем попадание
        if (result.coverage > 0) {
          collisions.push({
            type: 'token',
            object: token,
            point: { ...tokenCenter },
            distance: distance,
            details: {
              coverage: result.coverage,
              hitPoints: result.hitPoints
            }
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
    const checkTokens = segment.collision.tokens !== false;
    const shooterToken = segment.shooterToken;
    
    if (!checkTokens || !canvas.tokens?.placeables) {
      return [];
    }
    
    const coneOrigin = segment.start;
    const coneRange = segment.range;
    const coneCut = segment.cut || 0;
    const coneDirectionRad = (segment.direction * Math.PI) / 180;
    const coneHalfAngleRad = ((segment.angle || 90) / 2 * Math.PI) / 180;
    
    for (const token of canvas.tokens.placeables) {
      if (whitelist.includes(token)) continue;
      if (!token.visible) continue;
      
      // Проверка диспозиции
      if (shooterToken && this._shouldIgnoreByDisposition(token, segment, shooterToken)) {
        continue;
      }
      
      const tokenCenter = token.center;
      const tokenBounds = token.bounds;
      const tokenRadius = Math.min(tokenBounds.width, tokenBounds.height) / 2;
      
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
        tokenCenter, tokenRadius, segment.collision, extendedWhitelist, token
      );
      
      // Если есть покрытие - добавляем попадание
      if (result.coverage > 0) {
        collisions.push({
          type: 'token',
          object: token,
          point: { ...tokenCenter },
          distance: distance,
          details: {
            coverage: result.coverage,
            hitPoints: result.hitPoints
          }
        });
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
    const extended = [...whitelist, targetToken];
    
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
        return this._processSwingSegment(segment, context);
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
    
    if (validCollisions.length > 0) {
      // Определяем onHit на основе сегмента
      const onHit = segment.onHit || (!segment.props.penetration ? "stop" : "next");
      
      // Решение о продолжении на основе первого валидного попадания
      if (onHit === "stop") {
        // Простая линия: добавляем ТОЛЬКО первое попадание и останавливаемся
        const firstCollision = validCollisions[0];
        shot.shotResult.shotHits.push({
          point: firstCollision.point,
          type: firstCollision.type,
          object: firstCollision.object,
          ...firstCollision.details
        });
        shot.actualHits.push(firstCollision);
        
        shouldContinue = false;
        endPos = firstCollision.point;
      } else if (onHit === "next" || onHit === "need") {
        // Проникновение: добавляем все попадания
        for (const collision of validCollisions) {
          shot.shotResult.shotHits.push({
            point: collision.point,
            type: collision.type,
            object: collision.object,
            ...collision.details
          });
          shot.actualHits.push(collision);
        }
        
        shouldContinue = true;
        endPos = validCollisions[0].point;
      }
    } else {
      // Нет валидных столкновений
      const onHit = segment.onHit || (!segment.props.penetration ? "stop" : "next");
      
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
  _processSwingSegment(segment, context) {
    const { lastPos, direction, defSize, whitelist, shot } = context;
    
    // Параметры swing
    const count = segment.count || 1;  // Количество конусов
    const directionStep = segment.directionStep || 0;  // Шаг направления
    const rangeStep = segment.rangeStep || 0;  // Шаг дальности
    
    // Начальные параметры конуса
    let currentDirection = segment.direction || 0;
    let currentRange = segment.range;
    const angle = segment.angle || 90;
    const cut = segment.cut || 0;
    
    let shouldContinue = true;
    let finalDirection = direction + currentDirection;
    
    // Определяем onHit для обработки попаданий
    const onHit = segment.onHit || "next";
    
    // Генерируем серию конусов
    for (let i = 0; i < count; i++) {
      // Сохраняем текущее количество попаданий до конуса
      const hitsBefore = shot.actualHits.length;
      
      // Создаём конус с текущими параметрами
      const coneSegment = {
        type: 'cone',
        direction: currentDirection,
        range: currentRange,
        angle: angle,
        cut: cut,
        collision: segment.collision,
        props: segment.props,
        onHit: 'next',  // Внутренние конусы всегда используют 'next'
        hitOrder: segment.hitOrder,  // Передаём hitOrder из swing
        hitAmount: segment.hitAmount  // Передаём hitAmount из swing
      };
      
      // Обрабатываем конус через стандартный метод
      const result = this._processConeSegment(coneSegment, context);
      
      // Сохраняем последнее направление
      finalDirection = result.direction;
      
      // Проверяем, было ли попадание в этом конусе
      const hitsAfter = shot.actualHits.length;
      const hadHitInThisCone = hitsAfter > hitsBefore;
      
      if (hadHitInThisCone) {
        // Обрабатываем onHit для swing
        if (onHit === "stop") {
          // Останавливаем весь выстрел
          shouldContinue = false;
          break;
        } else if (onHit === "skip") {
          // Пропускаем оставшуюся часть swing и переходим к следующему сегменту в payload
          shouldContinue = true;
          break;
        } else if (onHit === "next" || onHit === "need") {
          // Продолжаем к следующему конусу в swing (поведение по умолчанию)
          // Просто продолжаем цикл
        }
      } else if (onHit === "need") {
        // Если в этом конусе не было попадания, а оно требовалось - останавливаем
        shouldContinue = false;
        break;
      }
      
      // Изменяем параметры для следующего конуса
      currentDirection += directionStep;
      currentRange += rangeStep;
    }
    
    return {
      endPos: lastPos,
      direction: finalDirection,
      shouldContinue: shouldContinue
    };
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
   * Вывод всех сохранённых выстрелов в консоль для отладки
   */
  logAllShots() {
    this.shotSystem.logAllShots();
  }
}

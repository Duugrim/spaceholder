// ShotSystem - новый класс для обработки выстрелов
// Отделен от системы прицеливания, работает с payload и TrajectorySegment

import { TrajectorySegmentFactory } from './trajectory-segment.mjs';

/**
 * Система выстрелов - обрабатывает траекторию снарядов без UI
 */
export class ShotSystem {
  constructor(rayCaster = null) {
    this.rayCaster = rayCaster;
    this.shotCounter = 0;
  }
  
  /**
   * Установить RayCaster (если не был передан в конструктор)
   * @param {RayCaster} rayCaster - система обнаружения коллизий
   */
  setRayCaster(rayCaster) {
    this.rayCaster = rayCaster;
  }
  
  /**
   * Выполнить выстрел
   * @param {Object} source - точка начала выстрела {x, y}
   * @param {number} direction - направление в градусах
   * @param {Object} payload - данные о траектории и эффектах
   * @param {Token} shooterToken - токен стрелка (для исключения самоповреждений)
   * @returns {Promise<Object>} полная информация о выстреле
   */
  async fire(source, direction, payload, shooterToken = null) {
    if (!this.rayCaster) {
      throw new Error('ShotSystem: RayCaster not set. Use setRayCaster() or pass it to constructor.');
    }
    
    if (!payload || !payload.trajectory) {
      throw new Error('ShotSystem: Invalid payload. Must contain trajectory array.');
    }
    
    // Генерируем уникальный ID выстрела
    this.shotCounter++;
    const shotId = `shot_${Date.now()}_${this.shotCounter}`;
    
    // Создаем сегменты траектории из payload
    const trajectorySegments = TrajectorySegmentFactory.createTrajectory(payload.trajectory);
    
    // Инициализируем результат выстрела
    const shotResult = {
      id: shotId,
      timestamp: Date.now(),
      shooter: shooterToken?.id || null,
      source: { ...source },
      direction: direction,
      payload: payload, // Сохраняем исходный payload
      
      // Результаты выстрела (заполняются по ходу выполнения)
      segments: [], // Массив отрисованных сегментов
      hits: [],     // Массив всех попаданий
      effects: [],  // Массив примененных эффектов
      splitShots: [], // Массив дочерних выстрелов (при разделении снарядов)
      
      // Метаданные
      totalDistance: 0,
      executionTime: 0,
      completed: false
    };
    
    const startTime = Date.now();
    
    try {
      // Выполняем траекторию поэтапно
      await this._executeTrajectory(trajectorySegments, shotResult, {
        currentPosition: source,
        direction: direction,
        shooterToken: shooterToken
      });
      
      shotResult.completed = true;
      
    } catch (error) {
      console.error('ShotSystem: Error during shot execution:', error);
      shotResult.error = error.message;
    }
    
    shotResult.executionTime = Date.now() - startTime;
    
    return shotResult;
  }
  
  /**
   * Выполнить траекторию поэтапно
   * @param {Array<TrajectorySegment>} segments - сегменты траектории
   * @param {Object} shotResult - результат выстрела (модифицируется)
   * @param {Object} context - контекст выполнения
   * @private
   */
  async _executeTrajectory(segments, shotResult, context) {
    let { currentPosition, direction, shooterToken } = context;
    let segmentGlobalIndex = 0;
    
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      
      // Создаем контекст для выполнения сегмента
      const shotContext = {
        rayCaster: this.rayCaster,
        currentPosition: currentPosition,
        direction: direction,
        shooterToken: shooterToken,
        segmentIndex: i,
        globalSegmentIndex: segmentGlobalIndex
      };
      
      try {
        // Выполняем сегмент
        const segmentResult = await segment.execute(shotContext);
        
        // Обрабатываем результат сегмента
        this._processSegmentResult(segment, segmentResult, shotResult, segmentGlobalIndex);
        
        // Проверяем разделение снарядов
        if (segment.hasSplit()) {
          await this._handleSplitShots(segment, segmentResult, shotResult, shooterToken);
        }
        
        // Обновляем контекст для следующего сегмента
        currentPosition = segmentResult.nextPosition;
        
        // Если сегмент говорит остановиться, завершаем траекторию
        if (!segmentResult.shouldContinue) {
          break;
        }
        
        // Обновляем глобальный индекс сегмента
        if (segmentResult.rays) {
          // LineRecSegment может создать несколько лучей
          segmentGlobalIndex += segmentResult.rays.length;
        } else if (segmentResult.ray) {
          segmentGlobalIndex += 1;
        }
        
      } catch (error) {
        console.error(`ShotSystem: Error executing segment ${i}:`, error);
        break;
      }
    }
  }
  
  /**
   * Обработать результат выполнения сегмента
   * @param {TrajectorySegment} segment - исполненный сегмент
   * @param {Object} segmentResult - результат выполнения
   * @param {Object} shotResult - общий результат выстрела
   * @param {number} segmentGlobalIndex - глобальный индекс сегмента
   * @private
   */
  _processSegmentResult(segment, segmentResult, shotResult, segmentGlobalIndex) {
    // Добавляем сегменты для рендеринга
    if (segmentResult.ray) {
      // Один луч (LineSegment)
      shotResult.segments.push({
        type: segment.type,
        ray: segmentResult.ray,
        segmentIndex: segmentGlobalIndex,
        damage: segment.damage,
        effects: segment.effects
      });
      
      shotResult.totalDistance += segmentResult.ray.actualLength || segmentResult.ray.distance || segment.length;
      
    } else if (segmentResult.rays) {
      // Несколько лучей (LineRecSegment)
      segmentResult.rays.forEach((ray, index) => {
        shotResult.segments.push({
          type: segment.type,
          ray: ray,
          segmentIndex: segmentGlobalIndex + index,
          damage: segment.damage,
          effects: segment.effects,
          iterationIndex: ray.iterationIndex
        });
        
        shotResult.totalDistance += ray.actualLength || ray.distance || segment.length;
      });
    }
    
    // Добавляем попадания
    if (segmentResult.collisions && segmentResult.collisions.length > 0) {
      segmentResult.collisions.forEach(collision => {
        shotResult.hits.push({
          ...collision,
          segmentType: segment.type,
          segmentIndex: segmentGlobalIndex,
          damage: segment.damage
        });
      });
    }
  }
  
  /**
   * Обработать разделение снарядов
   * @param {TrajectorySegment} parentSegment - родительский сегмент
   * @param {Object} segmentResult - результат выполнения родительского сегмента
   * @param {Object} shotResult - общий результат выстрела
   * @param {Token} shooterToken - токен стрелка
   * @private
   */
  async _handleSplitShots(parentSegment, segmentResult, shotResult, shooterToken) {
    const splitPoint = segmentResult.nextPosition;
    const baseDirection = segmentResult.direction || 0; // Направление родительского сегмента
    
    // Создаем отдельные ShotSystem для каждого дочернего снаряда
    for (let i = 0; i < parentSegment.children.length; i++) {
      const childConfig = parentSegment.children[i];
      const childDirection = baseDirection + (childConfig.offsetAngle || 0);
      
      // Создаем payload для дочернего снаряда
      const childPayload = {
        trajectory: [childConfig]
      };
      
      try {
        // Создаем новый ShotSystem для дочернего снаряда
        const childShotSystem = new ShotSystem(this.rayCaster);
        
        // Выполняем дочерний выстрел
        const childResult = await childShotSystem.fire(
          splitPoint,
          childDirection,
          childPayload,
          shooterToken
        );
        
        // Добавляем результат дочернего выстрела
        shotResult.splitShots.push({
          parentSegmentType: parentSegment.type,
          childIndex: i,
          offsetAngle: childConfig.offsetAngle || 0,
          result: childResult
        });
        
      } catch (error) {
        console.error(`ShotSystem: Error executing split shot ${i}:`, error);
      }
    }
  }
  
  /**
   * Получить все сегменты для рендеринга (включая дочерние выстрелы)
   * @param {Object} shotResult - результат выстрела
   * @returns {Array} плоский массив всех сегментов
   */
  static getAllRenderSegments(shotResult) {
    const allSegments = [...shotResult.segments];
    
    // Добавляем сегменты дочерних выстрелов
    shotResult.splitShots.forEach(splitShot => {
      const childSegments = this.getAllRenderSegments(splitShot.result);
      allSegments.push(...childSegments);
    });
    
    return allSegments;
  }
  
  /**
   * Получить все попадания (включая дочерние выстрелы)
   * @param {Object} shotResult - результат выстрела
   * @returns {Array} плоский массив всех попаданий
   */
  static getAllHits(shotResult) {
    const allHits = [...shotResult.hits];
    
    // Добавляем попадания дочерних выстрелов
    shotResult.splitShots.forEach(splitShot => {
      const childHits = this.getAllHits(splitShot.result);
      allHits.push(...childHits);
    });
    
    return allHits;
  }
}
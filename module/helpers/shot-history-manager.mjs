// ShotHistoryManager - управление историей и визуализацией выстрелов
// Отслеживает все выстрелы по shot_id, управляет их отрисовкой и очисткой

import { ShotSystem } from './shot-system.mjs';

/**
 * Менеджер истории выстрелов
 * Управляет визуализацией выстрелов по shot_id
 */
export class ShotHistoryManager {
  constructor(rayRenderer) {
    this.rayRenderer = rayRenderer;
    
    // История выстрелов: shot_id -> { shotResult, graphics, timestamp }
    this.shotHistory = new Map();
    
    // Настройки
    this.maxHistorySize = 50; // Максимум выстрелов в истории
    this.autoCleanupInterval = 30000; // Автоочистка каждые 30 секунд
    this.maxShotAge = 300000; // Максимальный возраст выстрела (5 минут)
    
    // Запускаем автоочистку
    this._startAutoCleanup();
  }
  
  /**
   * Добавить выстрел в историю и визуализировать его
   * @param {Object} shotResult - результат выстрела из ShotSystem
   * @param {Object} options - опции визуализации
   * @param {boolean} options.renderAboveFog - рендерить поверх тумана войны (по умолчанию false)
   */
  addShot(shotResult, options = {}) {
    const { 
      isRemote = false, 
      animate = true,
      color = null,
      autoFade = true,
      fadeDelay = 10000, // 10 секунд до начала затухания
      renderAboveFog = false // По умолчанию рендерим под туманом войны
    } = options;
    
    const shotId = shotResult.id;
    
    // Если выстрел уже существует, удаляем старую визуализацию
    if (this.shotHistory.has(shotId)) {
      this.removeShot(shotId);
    }
    
    // Создаем графические объекты для всех сегментов
    const shotGraphics = {
      shotId: shotId,
      segments: [],
      container: new PIXI.Container(),
      isRemote: isRemote,
      timestamp: Date.now()
    };
    
    // Настраиваем контейнер и выбираем слой
    shotGraphics.container.name = `shot_${shotId}`;
    shotGraphics.renderAboveFog = renderAboveFog;
    
    // Выбираем контейнер в зависимости от renderAboveFog
    if (renderAboveFog) {
      // Поверх тумана войны - используем основной rayContainer
      this.rayRenderer.rayContainer.addChild(shotGraphics.container);
    } else {
      // Под туманом войны - напрямую в слой эффектов
      if (canvas.effects) {
        canvas.effects.addChild(shotGraphics.container);
      } else {
        // Fallback - используем rayContainer
        this.rayRenderer.rayContainer.addChild(shotGraphics.container);
      }
    }
    
    // Получаем все сегменты (включая дочерние выстрелы)
    const allSegments = ShotSystem.getAllRenderSegments ? 
      ShotSystem.getAllRenderSegments(shotResult) : 
      shotResult.segments;
    
    // Создаем графику для каждого сегмента
    allSegments.forEach((segment, index) => {
      const segmentGraphics = this._createSegmentGraphics(segment, index, {
        isRemote,
        color,
        shotId
      });
      
      if (segmentGraphics) {
        shotGraphics.segments.push(segmentGraphics);
        shotGraphics.container.addChild(segmentGraphics);
      }
    });
    
    // Добавляем в историю
    this.shotHistory.set(shotId, {
      shotResult: shotResult,
      graphics: shotGraphics,
      timestamp: Date.now(),
      options: options
    });
    
    // Анимация появления (если включена)
    if (animate) {
      this._animateShotAppearance(shotGraphics);
    }
    
    // Планируем автоматическое затухание
    if (autoFade) {
      setTimeout(() => {
        if (this.shotHistory.has(shotId)) {
          this.fadeOutShot(shotId);
        }
      }, fadeDelay);
    }
    
    // Проверяем лимит истории
    this._enforceHistoryLimit();
    
    console.log(`ShotHistoryManager: Added shot ${shotId} (${allSegments.length} segments)`);
  }
  
  /**
   * Удалить выстрел из истории и сцены
   * @param {string} shotId - ID выстрела
   */
  removeShot(shotId) {
    const shotData = this.shotHistory.get(shotId);
    if (!shotData) return false;
    
    // Удаляем графические объекты
    if (shotData.graphics && shotData.graphics.container) {
      if (!shotData.graphics.container.destroyed) {
        shotData.graphics.container.destroy({ children: true });
      }
    }
    
    // Удаляем из истории
    this.shotHistory.delete(shotId);
    
    console.log(`ShotHistoryManager: Removed shot ${shotId}`);
    return true;
  }
  
  /**
   * Плавно убрать выстрел с затуханием
   * @param {string} shotId - ID выстрела
   * @param {number} fadeDuration - длительность затухания (мс)
   */
  fadeOutShot(shotId, fadeDuration = 2000) {
    const shotData = this.shotHistory.get(shotId);
    if (!shotData || !shotData.graphics) return;
    
    const container = shotData.graphics.container;
    if (!container || container.destroyed) return;
    
    const startAlpha = container.alpha;
    const startTime = Date.now();
    
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / fadeDuration, 1);
      
      if (container.destroyed) return;
      
      container.alpha = startAlpha * (1 - progress);
      
      if (progress >= 1) {
        this.removeShot(shotId);
      } else {
        requestAnimationFrame(animate);
      }
    };
    
    animate();
  }
  
  /**
   * Очистить все выстрелы
   */
  clearAllShots() {
    const shotIds = Array.from(this.shotHistory.keys());
    shotIds.forEach(shotId => this.removeShot(shotId));
    console.log(`ShotHistoryManager: Cleared all shots (${shotIds.length} removed)`);
  }
  
  /**
   * Очистить выстрелы определенного токена
   * @param {string} tokenId - ID токена
   */
  clearShotsByToken(tokenId) {
    let removedCount = 0;
    for (const [shotId, shotData] of this.shotHistory.entries()) {
      if (shotData.shotResult.shooter === tokenId) {
        this.removeShot(shotId);
        removedCount++;
      }
    }
    console.log(`ShotHistoryManager: Cleared ${removedCount} shots from token ${tokenId}`);
  }
  
  /**
   * Получить информацию о выстреле
   * @param {string} shotId - ID выстрела
   * @returns {Object|null} данные выстрела
   */
  getShotInfo(shotId) {
    return this.shotHistory.get(shotId) || null;
  }
  
  /**
   * Получить список всех активных выстрелов
   * @returns {Array} массив ID выстрелов
   */
  getActiveShotIds() {
    return Array.from(this.shotHistory.keys());
  }
  
  /**
   * Получить статистику истории
   * @returns {Object} статистика
   */
  getStats() {
    const localShots = Array.from(this.shotHistory.values()).filter(shot => !shot.graphics.isRemote);
    const remoteShots = Array.from(this.shotHistory.values()).filter(shot => shot.graphics.isRemote);
    
    return {
      totalShots: this.shotHistory.size,
      localShots: localShots.length,
      remoteShots: remoteShots.length,
      oldestShot: this._getOldestShotAge(),
      memoryUsage: this._estimateMemoryUsage()
    };
  }
  
  /**
   * Создать графический объект для сегмента
   * @param {Object} segment - данные сегмента
   * @param {number} index - индекс сегмента
   * @param {Object} options - опции отрисовки
   * @returns {PIXI.Graphics} графический объект сегмента
   * @private
   */
  _createSegmentGraphics(segment, index, options = {}) {
    const { isRemote = false, color = null, shotId = 'unknown' } = options;
    const ray = segment.ray;
    
    if (!ray) return null;
    
    const graphics = new PIXI.Graphics();
    graphics.name = `segment_${shotId}_${index}`;
    
    // Определяем цвет и стиль
    let segmentColor, segmentAlpha, segmentWidth;
    
    if (color) {
      // Пользовательский цвет
      segmentColor = color;
      segmentAlpha = 0.8;
      segmentWidth = 3;
    } else if (isRemote) {
      // Удаленные выстрелы - синие тона
      segmentColor = ray.isRicochet ? 0x0088FF : 0x4444FF;
      segmentAlpha = 0.7;
      segmentWidth = 3;
    } else {
      // Локальные выстрелы - красные тона
      segmentColor = ray.isRicochet ? 0xFF8800 : 0xFF4444;
      segmentAlpha = 0.9;
      segmentWidth = 4;
    }
    
    graphics.lineStyle(segmentWidth, segmentColor, segmentAlpha);
    
    // Рисуем сегмент
    const startPoint = ray.start || ray.origin;
    const endPoint = ray.end;
    
    graphics.moveTo(startPoint.x, startPoint.y)
            .lineTo(endPoint.x, endPoint.y);
    
    // Добавляем маркер начала
    graphics.beginFill(segmentColor, segmentAlpha);
    graphics.drawCircle(startPoint.x, startPoint.y, Math.max(2, segmentWidth - 1));
    graphics.endFill();
    
    return graphics;
  }
  
  /**
   * Анимация появления выстрела
   * @param {Object} shotGraphics - графические данные выстрела
   * @private
   */
  _animateShotAppearance(shotGraphics) {
    const container = shotGraphics.container;
    if (!container) return;
    
    // Начинаем с нулевой прозрачности
    container.alpha = 0;
    
    const duration = 300;
    const startTime = Date.now();
    
    const animate = () => {
      if (container.destroyed) return;
      
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      container.alpha = progress;
      
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    
    animate();
  }
  
  /**
   * Запустить автоматическую очистку устаревших выстрелов
   * @private
   */
  _startAutoCleanup() {
    setInterval(() => {
      this._cleanupOldShots();
    }, this.autoCleanupInterval);
  }
  
  /**
   * Очистить устаревшие выстрелы
   * @private
   */
  _cleanupOldShots() {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [shotId, shotData] of this.shotHistory.entries()) {
      const age = now - shotData.timestamp;
      if (age > this.maxShotAge) {
        this.removeShot(shotId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`ShotHistoryManager: Auto-cleanup removed ${cleanedCount} old shots`);
    }
  }
  
  /**
   * Принудительно ограничить размер истории
   * @private
   */
  _enforceHistoryLimit() {
    if (this.shotHistory.size <= this.maxHistorySize) return;
    
    // Сортируем по времени и удаляем самые старые
    const sortedShots = Array.from(this.shotHistory.entries())
      .sort(([,a], [,b]) => a.timestamp - b.timestamp);
    
    const excessCount = this.shotHistory.size - this.maxHistorySize;
    
    for (let i = 0; i < excessCount; i++) {
      const [shotId] = sortedShots[i];
      this.removeShot(shotId);
    }
    
    console.log(`ShotHistoryManager: Removed ${excessCount} excess shots from history`);
  }
  
  /**
   * Получить возраст самого старого выстрела
   * @returns {number} возраст в миллисекундах
   * @private
   */
  _getOldestShotAge() {
    if (this.shotHistory.size === 0) return 0;
    
    const now = Date.now();
    let oldest = now;
    
    for (const shotData of this.shotHistory.values()) {
      if (shotData.timestamp < oldest) {
        oldest = shotData.timestamp;
      }
    }
    
    return now - oldest;
  }
  
  /**
   * Оценить использование памяти (примерно)
   * @returns {number} количество графических объектов
   * @private
   */
  _estimateMemoryUsage() {
    let totalSegments = 0;
    
    for (const shotData of this.shotHistory.values()) {
      if (shotData.graphics && shotData.graphics.segments) {
        totalSegments += shotData.graphics.segments.length;
      }
    }
    
    return totalSegments;
  }
  
  /**
   * Уничтожить менеджер и очистить все ресурсы
   */
  destroy() {
    this.clearAllShots();
    this.shotHistory.clear();
  }
}
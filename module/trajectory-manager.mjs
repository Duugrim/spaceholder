/**
 * Trajectory Manager - система управления траекториями выстрелов
 * Отвечает за загрузку, кэширование и предоставление данных траекторий
 */
export class TrajectoryManager {
  
  constructor() {
    this.registry = null;
    this.trajectoryCache = new Map();
    this.initialized = false;
  }
  
  /**
   * Инициализация менеджера - загрузка реестра траекторий
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      console.log("SpaceHolder | Initializing Trajectory Manager...");
      
      // Загружаем реестр траекторий
      const registryPath = "systems/spaceholder/module/data/trajectories/registry.json";
      const response = await fetch(registryPath);
      
      if (!response.ok) {
        throw new Error(`Failed to load trajectory registry: ${response.status} ${response.statusText}`);
      }
      
      this.registry = await response.json();
      this.initialized = true;
      
      console.log(`SpaceHolder | Trajectory Manager initialized. Found ${Object.keys(this.registry.trajectories).length} trajectories.`);
      
    } catch (error) {
      console.error("SpaceHolder | Failed to initialize Trajectory Manager:", error);
      throw error;
    }
  }
  
  /**
   * Получить список всех доступных траекторий
   * @returns {Object} Объект с данными траекторий из реестра
   */
  getAvailableTrajectories() {
    if (!this.initialized) {
      console.warn("SpaceHolder | Trajectory Manager not initialized. Call initialize() first.");
      return {};
    }
    
    const allTrajectories = this.registry?.trajectories || {};
    const availableTrajectories = {};
    
    // Исключаем отключенные траектории (те, у которых disabled: true или ключ начинается с '_')
    for (let [id, trajectory] of Object.entries(allTrajectories)) {
      if (!trajectory.disabled && !id.startsWith('_')) {
        availableTrajectories[id] = trajectory;
      }
    }
    
    return availableTrajectories;
  }
  
  /**
   * Загрузить данные конкретной траектории
   * @param {string} trajectoryId - ID траектории
   * @returns {Promise<Object>} Данные траектории
   */
  async loadTrajectory(trajectoryId) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    // Проверяем кэш
    if (this.trajectoryCache.has(trajectoryId)) {
      return this.trajectoryCache.get(trajectoryId);
    }
    
    // Проверяем существование траектории в реестре
    const trajectoryInfo = this.registry?.trajectories?.[trajectoryId];
    if (!trajectoryInfo) {
      throw new Error(`Trajectory '${trajectoryId}' not found in registry`);
    }
    
    try {
      // Загружаем файл траектории
      const trajectoryPath = `systems/spaceholder/module/data/trajectories/${trajectoryInfo.file}`;
      const response = await fetch(trajectoryPath);
      
      if (!response.ok) {
        throw new Error(`Failed to load trajectory file ${trajectoryInfo.file}: ${response.status} ${response.statusText}`);
      }
      
      const trajectoryData = await response.json();
      
      // Валидируем структуру
      if (!this.validateTrajectoryStructure(trajectoryData)) {
        throw new Error(`Invalid trajectory structure in ${trajectoryInfo.file}`);
      }
      
      // Кэшируем результат
      this.trajectoryCache.set(trajectoryId, trajectoryData);
      
      console.log(`SpaceHolder | Loaded trajectory: ${trajectoryId}`);
      return trajectoryData;
      
    } catch (error) {
      console.error(`SpaceHolder | Failed to load trajectory '${trajectoryId}':`, error);
      throw error;
    }
  }
  
  /**
   * Создать payload на основе траектории с пользовательскими параметрами
   * @param {string} trajectoryId - ID траектории
   * @param {Object} options - пользовательские параметры
   * @returns {Promise<Object>} Готовый payload для выстрела
   */
  async createPayload(trajectoryId, options = {}) {
    const trajectoryTemplate = await this.loadTrajectory(trajectoryId);
    const payload = foundry.utils.deepClone(trajectoryTemplate);
    
    // Применяем пользовательские параметры
    this._applyOptions(payload, options);
    
    return payload;
  }
  
  /**
   * Получить информацию о траектории из реестра
   * @param {string} trajectoryId - ID траектории
   * @returns {Object|null} Информация о траектории
   */
  getTrajectoryInfo(trajectoryId) {
    return this.registry?.trajectories?.[trajectoryId] || null;
  }
  
  /**
   * Получить локализованное название траектории
   * @param {string} trajectoryId - ID траектории
   * @returns {string} Локализованное название
   */
  getTrajectoryDisplayName(trajectoryId) {
    const info = this.getTrajectoryInfo(trajectoryId);
    if (!info) return trajectoryId;
    
    // Пытаемся получить локализованное название
    const localized = game.i18n.localize(info.nameLocalized);
    return localized !== info.nameLocalized ? localized : info.name;
  }
  
  /**
   * Получить траектории по категории
   * @param {string} category - категория траекторий
   * @returns {Object} Объект с траекториями указанной категории
   */
  getTrajectoriesByCategory(category) {
    const available = this.getAvailableTrajectories();
    const filtered = {};
    
    for (let [id, trajectory] of Object.entries(available)) {
      if (trajectory.category === category) {
        filtered[id] = trajectory;
      }
    }
    
    return filtered;
  }
  
  /**
   * Валидация структуры траектории
   * @param {Object} trajectoryData - Данные траектории
   * @returns {boolean} Результат валидации
   * @private
   */
  validateTrajectoryStructure(trajectoryData) {
    if (!trajectoryData || typeof trajectoryData !== 'object') {
      console.error("Trajectory data must be an object");
      return false;
    }
    
    const required = ['id', 'name', 'trajectory'];
    for (const field of required) {
      if (!(field in trajectoryData)) {
        console.error(`Missing required field: ${field}`);
        return false;
      }
    }
    
    // Проверяем массив траекторий
    const trajectory = trajectoryData.trajectory;
    if (!Array.isArray(trajectory) || trajectory.length === 0) {
      console.error("trajectory must be a non-empty array");
      return false;
    }
    
    // Проверяем каждый сегмент траектории
    for (let i = 0; i < trajectory.length; i++) {
      const segment = trajectory[i];
      
      if (!segment.type) {
        console.error(`Trajectory segment ${i} missing type`);
        return false;
      }
      
      if (!segment.length || typeof segment.length !== 'number') {
        console.error(`Trajectory segment ${i} missing or invalid length`);
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Применение пользовательских опций к payload
   * @param {Object} payload - payload для модификации
   * @param {Object} options - опции для применения
   * @private
   */
  _applyOptions(payload, options) {
    // Применяем модификаторы дальности
    if (options.rangeMultiplier && options.rangeMultiplier !== 1.0) {
      this._applyRangeMultiplier(payload, options.rangeMultiplier);
    }
    
    // Применяем модификаторы урона
    if (options.damageMultiplier && options.damageMultiplier !== 1.0) {
      this._applyDamageMultiplier(payload, options.damageMultiplier);
    }
    
    // Переопределяем эффекты
    if (options.effects) {
      this._applyEffectOverrides(payload, options.effects);
    }
    
    // Переопределяем отскоки
    if (options.ricochet !== undefined) {
      this._applyRicochetSettings(payload, options.ricochet);
    }
  }
  
  /**
   * Применение модификатора дальности
   * @param {Object} payload - payload для модификации
   * @param {number} multiplier - множитель дальности
   * @private
   */
  _applyRangeMultiplier(payload, multiplier) {
    if (!payload.trajectory) return;
    
    payload.trajectory.forEach(segment => {
      if (segment.length) {
        segment.length = Math.round(segment.length * multiplier);
      }
      
      // Также применяем к дочерним сегментам
      if (segment.children) {
        segment.children.forEach(child => {
          if (child.length) {
            child.length = Math.round(child.length * multiplier);
          }
        });
      }
    });
  }
  
  /**
   * Применение модификатора урона
   * @param {Object} payload - payload для модификации
   * @param {number} multiplier - множитель урона
   * @private
   */
  _applyDamageMultiplier(payload, multiplier) {
    if (!payload.trajectory) return;
    
    payload.trajectory.forEach(segment => {
      if (segment.damage) {
        for (let [damageType, value] of Object.entries(segment.damage)) {
          if (typeof value === 'number') {
            segment.damage[damageType] = Math.round(value * multiplier);
          }
        }
      }
      
      // Также применяем к дочерним сегментам
      if (segment.children) {
        segment.children.forEach(child => {
          if (child.damage) {
            for (let [damageType, value] of Object.entries(child.damage)) {
              if (typeof value === 'number') {
                child.damage[damageType] = Math.round(value * multiplier);
              }
            }
          }
        });
      }
    });
  }
  
  /**
   * Применение настроек эффектов
   * @param {Object} payload - payload для модификации
   * @param {Object} effectOverrides - переопределения эффектов
   * @private
   */
  _applyEffectOverrides(payload, effectOverrides) {
    if (!payload.trajectory) return;
    
    payload.trajectory.forEach(segment => {
      if (segment.effects && effectOverrides) {
        Object.assign(segment.effects, effectOverrides);
      }
    });
  }
  
  /**
   * Применение настроек отскоков
   * @param {Object} payload - payload для модификации
   * @param {Object} ricochetSettings - настройки отскоков
   * @private
   */
  _applyRicochetSettings(payload, ricochetSettings) {
    if (!payload.trajectory) return;
    
    payload.trajectory.forEach(segment => {
      if (ricochetSettings.allowRicochet !== undefined) {
        segment.allowRicochet = ricochetSettings.allowRicochet;
      }
      if (ricochetSettings.maxRicochets !== undefined) {
        segment.maxRicochets = ricochetSettings.maxRicochets;
      }
    });
  }
  
  /**
   * Очистить кэш траекторий
   */
  clearCache() {
    this.trajectoryCache.clear();
    console.log("SpaceHolder | Trajectory cache cleared");
  }
  
  /**
   * Перезагрузить реестр траекторий
   */
  async reload() {
    this.initialized = false;
    this.clearCache();
    await this.initialize();
  }
  
  /**
   * Получить статистику использования траекторий
   * @returns {Object} Статистика
   */
  getStats() {
    return {
      initialized: this.initialized,
      registeredTrajectories: Object.keys(this.registry?.trajectories || {}).length,
      cachedTrajectories: this.trajectoryCache.size,
      availableCategories: Object.keys(this.registry?.meta?.categories || {})
    };
  }
}

// Создаём глобальный экземпляр менеджера
export const trajectoryManager = new TrajectoryManager();
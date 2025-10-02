/**
 * Anatomy Manager - система управления анатомиями существ
 * Отвечает за загрузку, кэширование и предоставление данных анатомий
 */
export class AnatomyManager {
  
  constructor() {
    this.registry = null;
    this.anatomyCache = new Map();
    this.initialized = false;
  }
  
  /**
   * Инициализация менеджера - загрузка реестра анатомий
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      console.log("SpaceHolder | Initializing Anatomy Manager...");
      
      // Загружаем реестр анатомий
      const registryPath = "systems/spaceholder/module/data/anatomy/registry.json";
      const response = await fetch(registryPath);
      
      if (!response.ok) {
        throw new Error(`Failed to load anatomy registry: ${response.status} ${response.statusText}`);
      }
      
      this.registry = await response.json();
      this.initialized = true;
      
      console.log(`SpaceHolder | Anatomy Manager initialized. Found ${Object.keys(this.registry.anatomies).length} anatomies.`);
      
    } catch (error) {
      console.error("SpaceHolder | Failed to initialize Anatomy Manager:", error);
      throw error;
    }
  }
  
  /**
   * Получить список всех доступных анатомий
   * @returns {Object} Объект с данными анатомий из реестра
   */
  getAvailableAnatomies() {
    if (!this.initialized) {
      console.warn("SpaceHolder | Anatomy Manager not initialized. Call initialize() first.");
      return {};
    }
    
    const allAnatomies = this.registry?.anatomies || {};
    const availableAnatomies = {};
    
    // Исключаем отключенные анатомии (те, у которых disabled: true или ключ начинается с '_')
    for (let [id, anatomy] of Object.entries(allAnatomies)) {
      if (!anatomy.disabled && !id.startsWith('_')) {
        availableAnatomies[id] = anatomy;
      }
    }
    
    return availableAnatomies;
  }
  
  /**
   * Загрузить данные конкретной анатомии
   * @param {string} anatomyId - ID анатомии
   * @returns {Promise<Object>} Данные анатомии
   */
  async loadAnatomy(anatomyId) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    // Проверяем кэш
    if (this.anatomyCache.has(anatomyId)) {
      return this.anatomyCache.get(anatomyId);
    }
    
    // Проверяем существование анатомии в реестре
    const anatomyInfo = this.registry?.anatomies?.[anatomyId];
    if (!anatomyInfo) {
      throw new Error(`Anatomy '${anatomyId}' not found in registry`);
    }
    
    try {
      // Загружаем файл анатомии
      const anatomyPath = `systems/spaceholder/module/data/anatomy/${anatomyInfo.file}`;
      const response = await fetch(anatomyPath);
      
      if (!response.ok) {
        throw new Error(`Failed to load anatomy file ${anatomyInfo.file}: ${response.status} ${response.statusText}`);
      }
      
      const anatomyData = await response.json();
      
      // Валидируем структуру
      if (!this.validateAnatomyStructure(anatomyData)) {
        throw new Error(`Invalid anatomy structure in ${anatomyInfo.file}`);
      }
      
      // Кэшируем результат
      this.anatomyCache.set(anatomyId, anatomyData);
      
      console.log(`SpaceHolder | Loaded anatomy: ${anatomyId}`);
      return anatomyData;
      
    } catch (error) {
      console.error(`SpaceHolder | Failed to load anatomy '${anatomyId}':`, error);
      throw error;
    }
  }
  
  /**
   * Создать копию анатомии для актёра (с текущими значениями HP)
   * @param {string} anatomyId - ID анатомии
   * @param {Object} options - Опции создания
   * @param {number} options.healthMultiplier - Множитель здоровья (по умолчанию 1.0)
   * @param {Object} options.overrides - Переопределения для конкретных частей тела
   * @returns {Promise<Object>} Копия анатомии для актёра
   */
  async createActorAnatomy(anatomyId, options = {}) {
    const {
      healthMultiplier = 1.0,
      overrides = {}
    } = options;
    
    const anatomyTemplate = await this.loadAnatomy(anatomyId);
    const actorAnatomy = foundry.utils.deepClone(anatomyTemplate);
    
    // Применяем модификаторы и переопределения
    for (let [partId, part] of Object.entries(actorAnatomy.bodyParts)) {
      // Применяем множитель здоровья
      if (healthMultiplier !== 1.0) {
        part.maxHp = Math.ceil(part.maxHp * healthMultiplier);
        part.currentHp = Math.ceil(part.currentHp * healthMultiplier);
      }
      
      // Применяем переопределения
      if (overrides[partId]) {
        Object.assign(part, overrides[partId]);
      }
    }
    
    return actorAnatomy;
  }
  
  /**
   * Получить информацию об анатомии из реестра
   * @param {string} anatomyId - ID анатомии
   * @returns {Object|null} Информация об анатомии
   */
  getAnatomyInfo(anatomyId) {
    return this.registry?.anatomies?.[anatomyId] || null;
  }
  
  /**
   * Получить локализованное название анатомии
   * @param {string} anatomyId - ID анатомии
   * @returns {string} Локализованное название
   */
  getAnatomyDisplayName(anatomyId) {
    const info = this.getAnatomyInfo(anatomyId);
    if (!info) return anatomyId;
    
    // Пытаемся получить локализованное название
    const localized = game.i18n.localize(info.nameLocalized);
    return localized !== info.nameLocalized ? localized : info.name;
  }
  
  /**
   * Валидация структуры анатомии
   * @param {Object} anatomyData - Данные анатомии
   * @returns {boolean} Результат валидации
   */
  validateAnatomyStructure(anatomyData) {
    if (!anatomyData || typeof anatomyData !== 'object') {
      console.error("Anatomy data must be an object");
      return false;
    }
    
    const required = ['id', 'name', 'bodyParts'];
    for (const field of required) {
      if (!(field in anatomyData)) {
        console.error(`Missing required field: ${field}`);
        return false;
      }
    }
    
    // Проверяем части тела
    const bodyParts = anatomyData.bodyParts;
    if (!bodyParts || typeof bodyParts !== 'object') {
      console.error("bodyParts must be an object");
      return false;
    }
    
    let rootFound = false;
    for (let [partId, part] of Object.entries(bodyParts)) {
      // Проверяем обязательные поля части тела
      const partRequired = ['id', 'name', 'coverage', 'maxHp', 'currentHp'];
      for (const field of partRequired) {
        if (!(field in part)) {
          console.error(`Body part '${partId}' missing required field: ${field}`);
          return false;
        }
      }
      
      // Ищем корневую часть
      if (!part.parent) {
        rootFound = true;
      }
      
      // Проверяем новые поля
      if (!('status' in part)) part.status = 'healthy';
      if (!('internal' in part)) part.internal = false;
      if (!('tags' in part)) part.tags = [];
    }
    
    if (!rootFound) {
      console.error("No root body part found (part with parent: null)");
      return false;
    }
    
    return true;
  }
  
  /**
   * Очистить кэш анатомий
   */
  clearCache() {
    this.anatomyCache.clear();
    console.log("SpaceHolder | Anatomy cache cleared");
  }
  
  /**
   * Перезагрузить реестр анатомий
   */
  async reload() {
    this.initialized = false;
    this.clearCache();
    await this.initialize();
  }
  
  /**
   * Получить статистику использования анатомий
   * @returns {Object} Статистика
   */
  getStats() {
    return {
      initialized: this.initialized,
      registeredAnatomies: Object.keys(this.registry?.anatomies || {}).length,
      cachedAnatomies: this.anatomyCache.size,
      availableCategories: Object.keys(this.registry?.meta?.categories || {})
    };
  }
}

// Создаём глобальный экземпляр менеджера
export const anatomyManager = new AnatomyManager();
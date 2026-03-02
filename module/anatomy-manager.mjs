/**
 * Anatomy Manager - система управления анатомиями существ
 * Отвечает за загрузку, кэширование и предоставление данных анатомий
 */
/** Путь к папке анатомий мира: worlds/<worldId>/spaceholder/anatomy */
function _getWorldAnatomyDir() {
  const wid = String(game?.world?.id ?? "").trim();
  return wid ? `worlds/${wid}/spaceholder/anatomy` : "";
}

function _getFilePicker() {
  return foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

/** Безопасное имя файла из id (только буквы, цифры, дефис, подчёркивание). */
function _safeAnatomyFileName(id) {
  return String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_") || "anatomy";
}

export class AnatomyManager {
  
  constructor() {
    this.registry = null;
    this.anatomyCache = new Map();
    this.initialized = false;
    /** Кэш списка мировых анатомий (JSON того же формата, что системные файлы) */
    this.worldPresetsCache = null;
  }
  
  /**
   * Инициализация менеджера - загрузка реестра анатомий
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      console.log("SpaceHolder | Initializing Anatomy Manager...");
      
      // Загружаем реестр анатомий
      const registryPath = "systems/spaceholder/data/anatomy/registry.json";
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
      const anatomyPath = `systems/spaceholder/data/anatomy/${anatomyInfo.file}`;
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
    
    // Применяем модификаторы и переопределения; задаём слоты органов по умолчанию
    for (const [partId, part] of Object.entries(actorAnatomy.bodyParts)) {
      let newMax = part.maxHp;
      if (healthMultiplier !== 1.0) {
        newMax = Math.ceil(newMax * healthMultiplier);
      }
      part.maxHp = newMax;
      if (!Array.isArray(part.organs)) part.organs = [];

      if (overrides[partId]) {
        Object.assign(part, overrides[partId]);
      }
    }

    return actorAnatomy;
  }

  /**
   * Загрузить список мировых анатомий из папки мира (worlds/<id>/spaceholder/anatomy).
   * Формат файлов такой же, как у системных JSON-анатомий (id, name, description, version, grid, bodyParts, links, meta).
   * Результат кэшируется; кэш сбрасывается при saveToWorld.
   * @returns {Promise<Object[]>}
   */
  async loadWorldPresets() {
    const dir = _getWorldAnatomyDir();
    if (!dir) {
      this.worldPresetsCache = [];
      return [];
    }
    const FP = _getFilePicker();
    if (!FP?.browse) {
      this.worldPresetsCache = [];
      return [];
    }
    let result;
    try {
      result = await FP.browse("data", dir);
    } catch {
      this.worldPresetsCache = [];
      return [];
    }
    const files = Array.isArray(result?.files) ? result.files : [];
    const jsonFiles = files.filter((f) => String(f).toLowerCase().endsWith(".json"));
    const anatomies = [];
    for (const filePath of jsonFiles) {
      try {
        const pathToFetch = String(filePath).includes("/") ? filePath : `${dir}/${filePath}`;
        const url = pathToFetch.startsWith("/") ? pathToFetch : `/${pathToFetch}`;
        const response = await fetch(url);
        if (!response.ok) continue;
        const data = await response.json();
        if (!data || typeof data !== "object") continue;
        if (!data.id || !data.bodyParts) continue;
        anatomies.push({
          id: data.id,
          name: data.name || data.id,
          description: data.description ?? "",
          version: data.version ?? null,
          grid: data.grid ?? null,
          bodyParts: data.bodyParts,
          links: Array.isArray(data.links) ? data.links : null,
          meta: data.meta ?? null,
          source: "world"
        });
      } catch {
        // skip invalid file
      }
    }
    this.worldPresetsCache = anatomies;
    return anatomies;
  }

  /**
   * Получить мировые анатомии (из кэша; перед этим вызвать loadWorldPresets()).
   * @returns {Object[]} Массив записей в формате anatomy JSON
   */
  getWorldPresets() {
    return this.worldPresetsCache ?? [];
  }

  /**
   * Сохранить анатомию в папку мира (worlds/<id>/spaceholder/anatomy/<id>.json).
   * @param {Object} data - Запись в формате anatomy JSON: id?, name?, description?, version?, grid?, bodyParts, links?, meta?
   * @returns {Promise<void>}
   */
  async saveToWorld(data) {
    const dir = _getWorldAnatomyDir();
    if (!dir) {
      console.warn("SpaceHolder | No world anatomy directory (world not loaded?)");
      return;
    }
    const FP = _getFilePicker();
    if (!FP?.createDirectory || !FP?.upload) {
      console.warn("SpaceHolder | FilePicker upload not available");
      return;
    }
    try {
      await FP.createDirectory("data", dir, {});
    } catch {
      // directory may already exist
    }
    const id = data.id || foundry.utils.randomID();
    const name = data.name || id;
    const grid = data.grid ?? null;
    const bodyParts = foundry.utils.deepClone(data.bodyParts || {});
    let links = null;
    if (Array.isArray(data.links)) {
      links = data.links;
    }
    const entry = {
      id,
      name,
      description: data.description ?? "",
      version: data.version ?? null,
      grid,
      bodyParts,
      links,
      meta: data.meta ?? null
    };
    const fileName = _safeAnatomyFileName(id) + ".json";
    const blob = new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" });
    const file = new File([blob], fileName, { type: "application/json" });
    await FP.upload("data", dir, file, { overwrite: true });
    this.worldPresetsCache = null;
  }

  /**
   * Загрузить пресет (анатомия + органы по частям) на актёра
   * @param {Actor} actor - Целевой актёр
   * @param {string} presetId - ID анатомии из getWorldPresets()
   * @returns {Promise<boolean>}
   */
  async applyPresetToActor(actor, presetId) {
    let presets = this.getWorldPresets();
    if (presets.length === 0) presets = await this.loadWorldPresets();
    const preset = presets.find(p => p.id === presetId);
    if (!preset?.bodyParts) return false;

    const currentParts = actor.system.health?.bodyParts || {};
    const delUpdate = {};
    for (const id of Object.keys(currentParts)) {
      delUpdate[`system.health.bodyParts.-=${id}`] = null;
    }
    if (Object.keys(delUpdate).length) {
      await actor.update(delUpdate);
    }

    const bodyParts = foundry.utils.deepClone(preset.bodyParts);
    for (const part of Object.values(bodyParts)) {
      if (!Array.isArray(part.organs)) part.organs = [];
    }

    const update = {
      "system.anatomy.id": preset.id,
      "system.anatomy.name": preset.name || preset.id,
      "system.anatomy.type": preset.id,
      "system.health.bodyParts": bodyParts
    };
    if (preset.grid && typeof preset.grid.width === "number" && typeof preset.grid.height === "number") {
      update["system.health.anatomyGrid"] = { width: preset.grid.width, height: preset.grid.height };
    }
    await actor.update(update);
    await actor.prepareData();
    return true;
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
   * Валидация структуры анатомии (внешняя: weight, links, x/y; без parent и coverage).
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

    const bodyParts = anatomyData.bodyParts;
    if (!bodyParts || typeof bodyParts !== 'object') {
      console.error("bodyParts must be an object");
      return false;
    }

    const partRequired = ['id', 'name', 'weight', 'maxHp'];
    for (let [partId, part] of Object.entries(bodyParts)) {
      for (const field of partRequired) {
        if (!(field in part)) {
          console.error(`Body part '${partId}' missing required field: ${field}`);
          return false;
        }
      }
      if (!('status' in part)) part.status = 'healthy';
      if (!('internal' in part)) part.internal = false;
      if (!('tags' in part)) part.tags = [];
      if (typeof part.x !== 'number') part.x = 0;
      if (typeof part.y !== 'number') part.y = 0;
      if (!Array.isArray(part.links)) part.links = [];
    }

    if (anatomyData.links !== undefined && !Array.isArray(anatomyData.links)) {
      console.error("anatomyData.links must be an array");
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
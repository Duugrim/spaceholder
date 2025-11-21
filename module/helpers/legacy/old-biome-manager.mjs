/**
 * ⚠️ УСТАРЕВШИЙ КОД - НЕ ИСПОЛЬЗОВАТЬ ⚠️
 * 
 * Этот модуль является УСТАРЕВШИМ и больше НЕ используется в системе.
 * Код сохранён только для справки и примеров старой реализации.
 * 
 * ❌ НЕ дорабатывайте этот код
 * ❌ НЕ используйте его в новых функциях
 * ✅ Используйте только как справочный материал
 * 
 * @deprecated Используйте новые модули terrain вместо legacy biome
 * 
 * Biome Manager
 * Manages loading and processing of biome data from Azgaar's Fantasy Map Generator
 * Used only for reading existing processed biome maps from scene flags.
 * New terrain systems should use individual data handlers instead.
 */
export class BiomeManager {
  constructor() {
    this.processedData = null;
    this.currentScene = null;
  }

  /**
   * Initialize the biome manager
   * @deprecated
   */
  initialize() {
    console.warn('DEPRECATED BiomeManager | This component is scheduled for replacement. See .deprecated.md');
    console.log('BiomeManager | Initializing...');
    
    // Hook into scene changes to load processed biome data
    Hooks.on('canvasReady', async (canvas) => {
      await this.onCanvasReady(canvas);
    });
    
    // If canvas is already ready, load immediately
    if (canvas?.ready && canvas?.scene) {
      console.log('BiomeManager | Canvas already ready, loading scene data...');
      this.onCanvasReady(canvas);
    }
  }

  /**
   * Called when canvas is ready - loads processed biome data from scene flags
   */
  async onCanvasReady(canvas) {
    console.log('BiomeManager | onCanvasReady called');
    this.currentScene = canvas.scene;
    
    if (!this.currentScene) {
      console.warn('BiomeManager | No scene available in canvas');
      return;
    }
    
    console.log(`BiomeManager | Checking scene flags for: ${this.currentScene.name}`);
    const processedData = this.currentScene.getFlag('spaceholder', 'processedBiomeMap');
    
    if (processedData) {
      console.log(`BiomeManager | ✓ Loading processed biome map for scene: ${this.currentScene.name}`);
      this.processedData = processedData;
      console.log(`BiomeManager | ✓ Loaded ${processedData.biomePoints?.length || 0} biome points`);
    } else {
      console.log(`BiomeManager | No processed biome map for scene: ${this.currentScene.name}`);
      this.processedData = null;
    }
  }

  /**
   * Process biome map from a specific file path
   * @param {string} filePath - Path to the JSON file
   * @param {Scene} scene - The scene to process for (defaults to current scene)
   * @returns {Promise<boolean>} Success status
   */
  async processFromFile(filePath, scene = null) {
    try {
      const targetScene = scene || this.currentScene || canvas.scene;
      if (!targetScene) {
        throw new Error('No scene available. Make sure you are viewing a scene.');
      }

      if (!filePath) {
        throw new Error('No file path provided.');
      }
      
      console.log(`BiomeManager | Processing biome map from: ${filePath}`);
      ui.notifications.info('Импорт карты биомов...');
      
      // Fetch the JSON file
      const response = await fetch(filePath);
      if (!response.ok) {
        throw new Error(`Failed to fetch biome map: ${response.statusText}`);
      }
      
      const rawData = await response.json();
      
      // Validate the data structure
      if (!this.validateBiomeMapData(rawData)) {
        throw new Error('Invalid biome map data structure');
      }
      
      // Process the raw data
      const processedData = await this.processRawBiomeMapData(rawData, targetScene);
      
      // Save processed data to scene flags
      await targetScene.setFlag('spaceholder', 'processedBiomeMap', processedData);
      
      this.processedData = processedData;
      
      console.log('BiomeManager | ✓ Biome map processed and saved successfully');
      ui.notifications.info('Карта биомов успешно импортирована!');
      
      return true;
    } catch (error) {
      console.error('BiomeManager | Failed to process biome map:', error);
      ui.notifications.error(`Ошибка импорта карты биомов: ${error.message}`);
      return false;
    }
  }

  /**
   * Validate biome map data structure
   * @param {Object} data - The biome map data
   * @returns {boolean} Validation result
   */
  validateBiomeMapData(data) {
    // Check for required properties from Azgaar's Fantasy Map Generator
    if (!data.info || !data.cells) {
      console.error('BiomeManager | Missing required data structure (info, cells)');
      console.error('BiomeManager | Please use PackCells or GridCells export format from Azgaar\'s FMG');
      return false;
    }
    
    // Check if cells have biome data
    const cells = data.cells?.cells || data.cells;
    if (!Array.isArray(cells) || cells.length === 0) {
      console.error('BiomeManager | Cells array is missing or empty');
      return false;
    }
    
    // Verify cells have required properties
    const sampleCell = cells[0];
    if (!sampleCell.hasOwnProperty('biome') || !sampleCell.hasOwnProperty('p')) {
      console.error('BiomeManager | Cells missing biome or position (p) data');
      return false;
    }
    
    console.log(`BiomeManager | ✓ Validated data: ${cells.length} cells`);
    return true;
  }

  /**
   * Process raw biome map data
   * @param {Object} rawData - Raw data from Azgaar's FMG
   * @param {Scene} scene - Target scene for coordinate scaling
   * @returns {Object} Processed biome data
   */
  async processRawBiomeMapData(rawData, scene) {
    console.log('BiomeManager | Processing raw biome map data...');
    
    const cells = rawData.cells?.cells || rawData.cells;
    const mapInfo = rawData.info;
    
    // Extract basic map information
    const mapWidth = mapInfo.width;
    const mapHeight = mapInfo.height;
    
    // Calculate scale factors
    const scaleX = scene.dimensions.width / mapWidth;
    const scaleY = scene.dimensions.height / mapHeight;
    
    console.log(`BiomeManager | Map size: ${mapWidth}x${mapHeight}`);
    console.log(`BiomeManager | Scene size: ${scene.dimensions.width}x${scene.dimensions.height}`);
    console.log(`BiomeManager | Scale factors: ${scaleX.toFixed(2)}x, ${scaleY.toFixed(2)}y`);
    console.log(`BiomeManager | Processing ${cells.length} cells...`);
    
    // Convert cells to scaled points with biome IDs
    const biomePoints = cells.map(cell => ({
      x: cell.p[0] * scaleX,
      y: cell.p[1] * scaleY,
      biome: cell.biome || 0
    }));
    
    // Collect unique biome IDs
    const uniqueBiomes = [...new Set(cells.map(c => c.biome || 0))].sort((a, b) => a - b);
    
    const processedData = {
      mapWidth: mapWidth * scaleX,
      mapHeight: mapHeight * scaleY,
      biomeStats: {
        uniqueBiomes,
        totalCells: cells.length
      },
      biomePoints
    };
    
    console.log(`BiomeManager | ✓ Prepared ${biomePoints.length} biome points`);
    console.log(`BiomeManager | ✓ Found ${uniqueBiomes.length} unique biomes: ${uniqueBiomes.join(', ')}`);
    
    return processedData;
  }

  /**
   * Get processed biome map data
   * @returns {Object|null} Processed biome map data
   */
  getProcessedData() {
    return this.processedData;
  }

  /**
   * Clear processed biome map data from scene
   */
  async clearProcessedBiomeMap(scene = null) {
    const targetScene = scene || this.currentScene;
    if (targetScene) {
      await targetScene.unsetFlag('spaceholder', 'processedBiomeMap');
      console.log('BiomeManager | Processed biome map cleared from scene');
      ui.notifications.info('Карта биомов очищена');
    }
    this.processedData = null;
  }

  /**
   * Check if biome map is loaded
   * @returns {boolean} Whether biome map is loaded
   */
  isLoaded() {
    return this.processedData !== null;
  }

  /**
   * Get current scene
   * @returns {Scene|null} Current scene
   */
  getCurrentScene() {
    return this.currentScene;
  }
}

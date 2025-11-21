import { HEIGHTMAP_CONTOUR_LEVELS } from './old-heightmap-config.mjs';

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
 * @deprecated Используйте новые модули terrain вместо legacy heightmap
 * 
 * Height Map Manager
 * Manages loading, parsing and processing of height map data from Azgaar's Fantasy Map Generator
 * Used only for reading existing processed height maps from scene flags.
 * New terrain systems should use individual data handlers instead.
 */
export class HeightMapManager {
  constructor() {
    this.processedData = null;
    this.currentScene = null;
  }

  /**
   * Initialize the height map manager
   * @deprecated
   */
  initialize() {
    console.warn('DEPRECATED HeightMapManager | This component is scheduled for replacement. See .deprecated.md');
    console.log('HeightMapManager | Initializing...');
    
    // Hook into scene changes to load processed height map
    Hooks.on('canvasReady', async (canvas) => {
      await this.onCanvasReady(canvas);
    });
    
    // If canvas is already ready (e.g., during Foundry startup), load immediately
    if (canvas?.ready && canvas?.scene) {
      console.log('HeightMapManager | Canvas already ready, loading scene data...');
      this.onCanvasReady(canvas);
    }
  }

  /**
   * Called when canvas is ready - loads processed height map data from scene flags
   */
  async onCanvasReady(canvas) {
    console.log('HeightMapManager | onCanvasReady called');
    this.currentScene = canvas.scene;
    
    if (!this.currentScene) {
      console.warn('HeightMapManager | No scene available in canvas');
      return;
    }
    
    console.log(`HeightMapManager | Checking scene flags for: ${this.currentScene.name}`);
    const processedData = this.currentScene.getFlag('spaceholder', 'processedHeightMap');
    
    if (processedData) {
      console.log(`HeightMapManager | ✓ Loading processed height map for scene: ${this.currentScene.name}`);
      this.processedData = processedData;
      console.log(`HeightMapManager | ✓ Loaded ${processedData.contourLevels?.length || 0} contour levels, ${processedData.heightPoints?.length || 0} height points`);
    } else {
      console.log(`HeightMapManager | No processed height map for scene: ${this.currentScene.name}`);
      this.processedData = null;
    }
  }

  /**
   * Process raw height map from source file and save to scene
   * This is the main processing function that should be called manually
   * @param {Scene} scene - The scene to process for (defaults to current scene)
   * @returns {Promise<boolean>} Success status
   */
  async processHeightMapFromSource(scene = null) {
    try {
      const targetScene = scene || this.currentScene || canvas.scene;
      if (!targetScene) {
        throw new Error('No scene available. Make sure you are viewing a scene.');
      }

      const sourcePath = targetScene.getFlag('spaceholder', 'heightMapPath');
      
      if (!sourcePath) {
        throw new Error('No height map source path configured. Please select a height map file in scene settings.');
      }
      
      console.log(`HeightMapManager | Processing height map from: ${sourcePath}`);
      ui.notifications.info('Processing height map data... This may take a moment.');
      
      // Fetch the JSON file
      const response = await fetch(sourcePath);
      if (!response.ok) {
        throw new Error(`Failed to fetch height map: ${response.statusText}`);
      }
      
      const rawData = await response.json();
      
      // Validate the data structure
      if (!this.validateHeightMapData(rawData)) {
        throw new Error('Invalid height map data structure');
      }
      
      // Process the raw data into contours
      const processedData = await this.processRawHeightMapData(rawData, targetScene);
      
      // Save processed data to scene flags
      await targetScene.setFlag('spaceholder', 'processedHeightMap', processedData);
      
      this.processedData = processedData;
      
      console.log('HeightMapManager | ✓ Height map processed and saved successfully');
      ui.notifications.info('Height map processed successfully!');
      
      return true;
    } catch (error) {
      console.error('HeightMapManager | Failed to process height map:', error);
      ui.notifications.error(`Failed to process height map: ${error.message}`);
      return false;
    }
  }

  /**
   * Process height map from a specific file path
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
      
      console.log(`HeightMapManager | Processing height map from: ${filePath}`);
      ui.notifications.info('Импорт карты высот... Это может занять время.');
      
      // Fetch the JSON file
      const response = await fetch(filePath);
      if (!response.ok) {
        throw new Error(`Failed to fetch height map: ${response.statusText}`);
      }
      
      const rawData = await response.json();
      
      // Validate the data structure
      if (!this.validateHeightMapData(rawData)) {
        throw new Error('Invalid height map data structure');
      }
      
      // Process the raw data into contours
      const processedData = await this.processRawHeightMapData(rawData, targetScene);
      
      // Save processed data to scene flags
      await targetScene.setFlag('spaceholder', 'processedHeightMap', processedData);
      
      this.processedData = processedData;
      
      console.log('HeightMapManager | ✓ Height map processed and saved successfully');
      ui.notifications.info('Карта высот успешно импортирована!');
      
      return true;
    } catch (error) {
      console.error('HeightMapManager | Failed to process height map:', error);
      ui.notifications.error(`Ошибка импорта карты высот: ${error.message}`);
      return false;
    }
  }

  /**
   * Create a flat height map with uniform height
   * @param {number} defaultHeight - Default height value (default: 20)
   * @param {Scene} scene - The scene to create for (defaults to current scene)
   * @returns {Promise<boolean>} Success status
   */
  async createFlatMap(defaultHeight = 20, scene = null) {
    try {
      const targetScene = scene || this.currentScene || canvas.scene;
      if (!targetScene) {
        throw new Error('No scene available. Make sure you are viewing a scene.');
      }

      console.log(`HeightMapManager | Creating flat height map with height: ${defaultHeight}`);
      ui.notifications.info('Создание ровной карты высот...');
      
      // Create minimal processedData with 4 corner points at default height
      // This is sufficient for the renderer to create a uniform heightField
      const sceneDimensions = targetScene.dimensions;
      
      const heightPoints = [
        { x: 0, y: 0, height: defaultHeight },
        { x: sceneDimensions.width, y: 0, height: defaultHeight },
        { x: 0, y: sceneDimensions.height, height: defaultHeight },
        { x: sceneDimensions.width, y: sceneDimensions.height, height: defaultHeight }
      ];
      
      const processedData = {
        mapWidth: sceneDimensions.width,
        mapHeight: sceneDimensions.height,
        heightStats: {
          min: defaultHeight,
          max: defaultHeight,
          range: 0
        },
        heightPoints,
        contourLevels: HEIGHTMAP_CONTOUR_LEVELS,
        isFlat: true // Flag to indicate this is a flat map
      };
      
      // Save processed data to scene flags
      await targetScene.setFlag('spaceholder', 'processedHeightMap', processedData);
      
      this.processedData = processedData;
      
      console.log('HeightMapManager | ✓ Flat height map created successfully');
      ui.notifications.info('Ровная карта высот создана!');
      
      return true;
    } catch (error) {
      console.error('HeightMapManager | Failed to create flat height map:', error);
      ui.notifications.error(`Ошибка создания карты высот: ${error.message}`);
      return false;
    }
  }

  /**
   * Validate height map data structure
   * @param {Object} data - The height map data
   * @returns {boolean} Validation result
   */
  validateHeightMapData(data) {
    // Check for required properties from Azgaar's Fantasy Map Generator
    if (!data.info || !data.cells) {
      console.error('HeightMapManager | Missing required data structure (info, cells)');
      console.error('HeightMapManager | Please use PackCells or GridCells export format from Azgaar\'s FMG');
      return false;
    }
    
    // Check if cells have height data
    const cells = data.cells?.cells || data.cells;
    if (!Array.isArray(cells) || cells.length === 0) {
      console.error('HeightMapManager | Cells array is missing or empty');
      return false;
    }
    
    // Verify cells have required properties
    const sampleCell = cells[0];
    if (!sampleCell.hasOwnProperty('h') || !sampleCell.hasOwnProperty('p')) {
      console.error('HeightMapManager | Cells missing height (h) or position (p) data');
      return false;
    }
    
    console.log(`HeightMapManager | ✓ Validated data: ${cells.length} cells`);
    return true;
  }

  /**
   * Process raw height map data into smooth contours using metaballs approach
   * @param {Object} rawData - Raw data from Azgaar's FMG
   * @param {Scene} scene - Target scene for coordinate scaling
   * @returns {Object} Processed contour data
   */
  async processRawHeightMapData(rawData, scene) {
    console.log('HeightMapManager | Processing raw height map data with metaballs...');
    
    const cells = rawData.cells?.cells || rawData.cells;
    const mapInfo = rawData.info;
    
    // Extract basic map information
    const mapWidth = mapInfo.width;
    const mapHeight = mapInfo.height;
    
    // Calculate height statistics
    const heights = cells.map(c => c.h || 0).filter(h => h > 0);
    const minHeight = Math.min(...heights);
    const maxHeight = Math.max(...heights);
    
    console.log(`HeightMapManager | Map size: ${mapWidth}x${mapHeight}`);
    console.log(`HeightMapManager | Height range: ${minHeight} - ${maxHeight}`);
    console.log(`HeightMapManager | Processing ${cells.length} cells...`);
    
    // Calculate scale factors
    const scaleX = scene.dimensions.width / mapWidth;
    const scaleY = scene.dimensions.height / mapHeight;
    
    // Convert cells to scaled points with heights
    const heightPoints = cells.map(cell => ({
      x: cell.p[0] * scaleX,
      y: cell.p[1] * scaleY,
      height: cell.h || 0
    }));
    
    // Use contour levels from configuration
    const contourLevels = HEIGHTMAP_CONTOUR_LEVELS;
    
    const processedData = {
      mapWidth: mapWidth * scaleX,
      mapHeight: mapHeight * scaleY,
      heightStats: {
        min: minHeight,
        max: maxHeight,
        range: maxHeight - minHeight
      },
      heightPoints,
      contourLevels
    };
    
    console.log(`HeightMapManager | ✓ Prepared ${heightPoints.length} height points for metaball rendering`);
    
    return processedData;
  }


  /**
   * Get processed height map data
   * @returns {Object|null} Processed height map data
   */
  getProcessedData() {
    return this.processedData;
  }

  /**
   * Clear processed height map data from scene
   */
  async clearProcessedHeightMap(scene = null) {
    const targetScene = scene || this.currentScene;
    if (targetScene) {
      await targetScene.unsetFlag('spaceholder', 'processedHeightMap');
      console.log('HeightMapManager | Processed height map cleared from scene');
      ui.notifications.info('Processed height map cleared');
    }
    this.processedData = null;
  }

  /**
   * Check if height map is loaded
   * @returns {boolean} Whether height map is loaded
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

  /**
   * Generate heightField file path for a scene
   * @param {Scene} scene - Target scene
   * @returns {string} File path
   */
  _getHeightFieldPath(scene) {
    const sceneSlug = scene.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return `worlds/${game.world.id}/heightfields/${sceneSlug}_${scene.id}.json`;
  }

  /**
   * Calculate MD5 hash of source file path (simple hash for change detection)
   * @param {string} sourcePath - Path to source file
   * @returns {string} Simple hash
   */
  _simpleHash(sourcePath) {
    let hash = 0;
    for (let i = 0; i < sourcePath.length; i++) {
      const char = sourcePath.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }

  /**
   * Save heightField to file
   * @param {Object} heightField - Height field data {values, rows, cols}
   * @param {Object} bounds - Bounds {minX, minY, maxX, maxY}
   * @param {number} cellSize - Cell size
   * @param {Scene} scene - Target scene
   * @param {boolean} edited - Whether this was manually edited
   * @returns {Promise<boolean>} Success status
   */
  async saveHeightFieldToFile(heightField, bounds, cellSize, scene = null, edited = false) {
    try {
      const targetScene = scene || this.currentScene || canvas.scene;
      if (!targetScene) {
        throw new Error('No scene available');
      }

      const sourcePath = targetScene.getFlag('spaceholder', 'heightMapPath');
      const filePath = this._getHeightFieldPath(targetScene);

      console.log(`HeightMapManager | Saving heightField to: ${filePath}`);

      // Convert Float32Array to base64
      const buffer = heightField.values.buffer;
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64Data = btoa(binary);

      const heightFieldData = {
        version: 1,
        metadata: {
          sourceFile: sourcePath || null,
          sourceHash: sourcePath ? this._simpleHash(sourcePath) : null,
          generatedAt: new Date().toISOString(),
          sceneId: targetScene.id,
          sceneName: targetScene.name,
          edited: edited
        },
        bounds: bounds,
        grid: {
          rows: heightField.rows,
          cols: heightField.cols,
          cellSize: cellSize
        },
        heights: {
          encoding: 'base64_float32',
          data: base64Data
        }
      };

      // Upload file to user data
      const blob = new Blob([JSON.stringify(heightFieldData, null, 2)], { type: 'application/json' });
      const file = new File([blob], filePath.split('/').pop(), { type: 'application/json' });
      
      const directory = filePath.substring(0, filePath.lastIndexOf('/'));
      
      // Create directory if it doesn't exist
      try {
        await foundry.applications.apps.FilePicker.implementation.createDirectory('data', directory, {});
      } catch (err) {
        // Directory might already exist, ignore error
      }
      
      const response = await foundry.applications.apps.FilePicker.implementation.upload('data', directory, file, {});
      
      if (response) {
        console.log(`HeightMapManager | ✓ HeightField saved successfully to ${response.path}`);
        // Save reference in scene flags
        await targetScene.setFlag('spaceholder', 'heightFieldPath', response.path);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('HeightMapManager | Failed to save heightField:', error);
      ui.notifications.error(`Failed to save heightField: ${error.message}`);
      return false;
    }
  }

  /**
   * Load heightField from file
   * @param {Scene} scene - Target scene
   * @returns {Promise<Object|null>} HeightField data or null if not found
   */
  async loadHeightFieldFromFile(scene = null) {
    try {
      const targetScene = scene || this.currentScene || canvas.scene;
      if (!targetScene) {
        throw new Error('No scene available');
      }

      const heightFieldPath = targetScene.getFlag('spaceholder', 'heightFieldPath');
      
      if (!heightFieldPath) {
        console.log('HeightMapManager | No heightField file path in scene flags');
        return null;
      }

      console.log(`HeightMapManager | Loading heightField from: ${heightFieldPath}`);

      const response = await fetch(heightFieldPath);
      if (!response.ok) {
        console.warn(`HeightMapManager | HeightField file not found: ${heightFieldPath}`);
        return null;
      }

      const heightFieldData = await response.json();

      // Validate version
      if (heightFieldData.version !== 1) {
        console.warn(`HeightMapManager | Unsupported heightField version: ${heightFieldData.version}`);
        return null;
      }

      // Check if source file has changed
      const currentSourcePath = targetScene.getFlag('spaceholder', 'heightMapPath');
      if (currentSourcePath && heightFieldData.metadata.sourceFile === currentSourcePath) {
        const currentHash = this._simpleHash(currentSourcePath);
        if (currentHash !== heightFieldData.metadata.sourceHash) {
          console.warn('HeightMapManager | Source file has changed, heightField may be outdated');
          ui.notifications.warn('Height map source has changed. Consider regenerating.');
        }
      }

      // Decode base64 to Float32Array
      const binary = atob(heightFieldData.heights.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const values = new Float32Array(bytes.buffer);

      const heightField = {
        values: values,
        rows: heightFieldData.grid.rows,
        cols: heightFieldData.grid.cols
      };

      const result = {
        heightField: heightField,
        bounds: heightFieldData.bounds,
        cellSize: heightFieldData.grid.cellSize,
        metadata: heightFieldData.metadata
      };

      console.log(`HeightMapManager | ✓ HeightField loaded successfully (${heightField.rows}x${heightField.cols})`);
      return result;
    } catch (error) {
      console.error('HeightMapManager | Failed to load heightField:', error);
      return null;
    }
  }
}

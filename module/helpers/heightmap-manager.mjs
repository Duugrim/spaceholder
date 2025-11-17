/**
 * Height Map Manager
 * Manages loading, parsing and processing of height map data from Azgaar's Fantasy Map Generator
 */
export class HeightMapManager {
  constructor() {
    this.processedData = null;
    this.currentScene = null;
  }

  /**
   * Initialize the height map manager
   */
  initialize() {
    console.log('HeightMapManager | Initializing...');
    
    // Hook into scene changes to load processed height map
    Hooks.on('canvasReady', async (canvas) => {
      await this.onCanvasReady(canvas);
    });
  }

  /**
   * Called when canvas is ready - loads processed height map data from scene flags
   */
  async onCanvasReady(canvas) {
    this.currentScene = canvas.scene;
    const processedData = this.currentScene?.getFlag('spaceholder', 'processedHeightMap');
    
    if (processedData) {
      console.log(`HeightMapManager | ✓ Loading processed height map for scene: ${this.currentScene.name}`);
      this.processedData = processedData;
      console.log(`HeightMapManager | ✓ Loaded ${processedData.contourLevels?.length || 0} contour levels from cache`);
    } else {
      console.log(`HeightMapManager | No processed height map for scene: ${this.currentScene?.name || 'unknown'}`);
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
    
    // Define contour levels (height ranges) - from shallow water to peaks
    const contourLevels = [
      { level: 10, minHeight: 10, maxHeight: 18, color: 0x0066CC },   // Shallow water/coast
      { level: 22, minHeight: 22, maxHeight: 25, color: 0x008800 },   // Very low coastal land
      { level: 25, minHeight: 25, maxHeight: 30, color: 0x00AA00 },   // Coastal lowlands
      { level: 30, minHeight: 30, maxHeight: 35, color: 0x22BB00 },   // Low plains
      { level: 35, minHeight: 35, maxHeight: 40, color: 0x44BB00 },   // Plains
      { level: 40, minHeight: 40, maxHeight: 45, color: 0x66CC00 },   // High plains
      { level: 45, minHeight: 45, maxHeight: 50, color: 0x88CC00 },   // Elevated plains
      { level: 50, minHeight: 50, maxHeight: 55, color: 0xAAAA00 },   // Low foothills
      { level: 55, minHeight: 55, maxHeight: 60, color: 0xBBAA00 },   // Foothills
      { level: 60, minHeight: 60, maxHeight: 65, color: 0xBB9900 },   // Hills
      { level: 65, minHeight: 65, maxHeight: 70, color: 0xCC9900 },   // High hills
      { level: 70, minHeight: 70, maxHeight: 75, color: 0xCC8800 },   // Mountains start
      { level: 75, minHeight: 75, maxHeight: 80, color: 0xDD8800 },   // Low mountains
      { level: 80, minHeight: 80, maxHeight: 85, color: 0xDD7700 },   // Mountains
      { level: 85, minHeight: 85, maxHeight: 90, color: 0xEE7700 },   // High mountains
      { level: 90, minHeight: 90, maxHeight: 95, color: 0xFFAA77 },   // Alpine
      { level: 95, minHeight: 95, maxHeight: 100, color: 0xFFFFFF }   // Peaks
    ];
    
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
}

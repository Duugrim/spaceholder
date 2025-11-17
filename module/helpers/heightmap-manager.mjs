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
   * Process raw height map data into contours
   * @param {Object} rawData - Raw data from Azgaar's FMG
   * @param {Scene} scene - Target scene for coordinate scaling
   * @returns {Object} Processed contour data
   */
  async processRawHeightMapData(rawData, scene) {
    console.log('HeightMapManager | Processing raw height map data...');
    
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
    
    // Define contour levels
    const contourLevels = [20, 40, 60, 80, 100];
    
    // Calculate scale factors
    const scaleX = scene.dimensions.width / mapWidth;
    const scaleY = scene.dimensions.height / mapHeight;
    
    // Create interpolated grid
    const gridResolution = 50;
    const gridWidth = Math.ceil(mapWidth * scaleX / gridResolution);
    const gridHeight = Math.ceil(mapHeight * scaleY / gridResolution);
    
    console.log(`HeightMapManager | Creating ${gridWidth}x${gridHeight} interpolation grid...`);
    const grid = this.createInterpolatedGrid(cells, mapWidth, mapHeight, gridWidth, gridHeight, scaleX, scaleY, gridResolution);
    
    // Generate contours for each level
    const contours = {};
    for (const level of contourLevels) {
      console.log(`HeightMapManager | Generating contours for level ${level}...`);
      contours[level] = this.generateContoursForLevel(grid, gridWidth, gridHeight, level, gridResolution);
    }
    
    const processedData = {
      mapWidth: mapWidth * scaleX,
      mapHeight: mapHeight * scaleY,
      heightStats: {
        min: minHeight,
        max: maxHeight,
        range: maxHeight - minHeight
      },
      contourLevels,
      contours,
      gridResolution
    };
    
    console.log(`HeightMapManager | ✓ Generated contours for ${contourLevels.length} levels`);
    
    return processedData;
  }

  /**
   * Create interpolated height grid from Voronoi cells
   */
  createInterpolatedGrid(cells, mapWidth, mapHeight, gridWidth, gridHeight, scaleX, scaleY, gridResolution) {
    const grid = new Array(gridWidth * gridHeight);
    
    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        const mapX = (x * gridResolution) / scaleX;
        const mapY = (y * gridResolution) / scaleY;
        
        // Inverse distance weighting interpolation
        let totalWeight = 0;
        let weightedHeight = 0;
        const maxDistance = 100;
        
        for (const cell of cells) {
          const dx = cell.p[0] - mapX;
          const dy = cell.p[1] - mapY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          
          if (distance < maxDistance) {
            const weight = 1 / (distance + 1);
            weightedHeight += (cell.h || 0) * weight;
            totalWeight += weight;
          }
        }
        
        grid[y * gridWidth + x] = totalWeight > 0 ? weightedHeight / totalWeight : 0;
      }
    }
    
    return grid;
  }

  /**
   * Generate contour lines for specific level using marching squares
   */
  generateContoursForLevel(grid, width, height, threshold, gridResolution) {
    const contourSegments = [];
    
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        const v1 = grid[y * width + x];
        const v2 = grid[y * width + (x + 1)];
        const v3 = grid[(y + 1) * width + (x + 1)];
        const v4 = grid[(y + 1) * width + x];
        
        const edges = [];
        
        // Check each edge for threshold crossing
        if ((v1 < threshold && v2 >= threshold) || (v1 >= threshold && v2 < threshold)) {
          const t = (threshold - v1) / (v2 - v1 + 0.0001);
          edges.push({x: (x + t) * gridResolution, y: y * gridResolution});
        }
        if ((v2 < threshold && v3 >= threshold) || (v2 >= threshold && v3 < threshold)) {
          const t = (threshold - v2) / (v3 - v2 + 0.0001);
          edges.push({x: (x + 1) * gridResolution, y: (y + t) * gridResolution});
        }
        if ((v3 < threshold && v4 >= threshold) || (v3 >= threshold && v4 < threshold)) {
          const t = (threshold - v4) / (v3 - v4 + 0.0001);
          edges.push({x: (x + 1 - t) * gridResolution, y: (y + 1) * gridResolution});
        }
        if ((v4 < threshold && v1 >= threshold) || (v4 >= threshold && v1 < threshold)) {
          const t = (threshold - v4) / (v1 - v4 + 0.0001);
          edges.push({x: x * gridResolution, y: (y + 1 - t) * gridResolution});
        }
        
        if (edges.length >= 2) {
          contourSegments.push(edges);
        }
      }
    }
    
    return contourSegments;
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

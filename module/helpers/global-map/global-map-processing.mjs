import { BiomeResolver } from './global-map-biome-resolver.mjs';

/**
 * Global Map Processing
 * Converts raw PackCells Voronoi data into a unified rectangular height grid
 * Raw data is discarded after processing - only final grid is stored
 */
export class GlobalMapProcessing {
  constructor() {
    this.unifiedGrid = null; // Final rectangular grid: {heights, moisture, temperature, rows, cols}
    this.gridMetadata = null; // Grid metadata: {bounds, cellSize, stats, timestamp}
    this.biomeResolver = new BiomeResolver();
  }

  /**
   * Initialize processing - load biome resolver config
   */
  async initialize() {
    await this.biomeResolver.loadConfig();
    console.log('GlobalMapProcessing | Initialized');
  }

  /**
   * Validate raw PackCells data structure
   * @param {Object} data - Raw data from Azgaar's FMG
   * @returns {Object} {valid: boolean, error?: string}
   */
  validatePackCellsData(data) {
    if (!data.info || !data.cells) {
      return { valid: false, error: 'Missing required structure: info and cells' };
    }

    const cells = data.cells?.cells || data.cells;
    if (!Array.isArray(cells) || cells.length === 0) {
      return { valid: false, error: 'Cells array is missing or empty' };
    }

    const sampleCell = cells[0];
    if (!sampleCell.hasOwnProperty('p')) {
      return { valid: false, error: 'Cells missing position (p) data' };
    }

    // At minimum we need heights OR biomes
    if (!sampleCell.hasOwnProperty('h') && !sampleCell.hasOwnProperty('biome')) {
      return { valid: false, error: 'Cells must have height (h) or biome data' };
    }

    return { valid: true };
  }

  /**
   * Process PackCells Voronoi data into unified rectangular grid
   * Voronoi cells are converted to a regular grid using interpolation
   * @param {Object} rawData - Raw data from Azgaar's FMG
   * @param {Scene} scene - Target scene for grid sizing
   * @param {number} gridResolution - Cells per unit (higher = finer grid, default 2)
   * @returns {Promise<{gridData, metadata}>}
   */
  async processPackCellsToGrid(rawData, scene, gridResolution = 2) {
    console.log('GlobalMapProcessing | Converting PackCells to unified grid...');

    const validation = this.validatePackCellsData(rawData);
    if (!validation.valid) {
      throw new Error(`Invalid PackCells data: ${validation.error}`);
    }

    const cells = rawData.cells?.cells || rawData.cells;
    const mapInfo = rawData.info;

    // Source map dimensions
    const srcMapWidth = mapInfo.width;
    const srcMapHeight = mapInfo.height;

    console.log(`GlobalMapProcessing | Source map: ${srcMapWidth}x${srcMapHeight} Voronoi cells`);

    // Extract Voronoi cell data (will be discarded after interpolation)
    const voronoiCells = cells.map(cell => ({
      x: cell.p[0],
      y: cell.p[1],
      height: cell.h || 0,
      biome: cell.biome || 0,
    }));

    // Calculate stats from source data
    const heights = voronoiCells.map(c => c.height);
    const biomes = voronoiCells.map(c => c.biome);
    const validHeights = heights.filter(h => h > 0);
    const heightStats = {
      min: validHeights.length > 0 ? Math.min(...validHeights) : 0,
      max: validHeights.length > 0 ? Math.max(...validHeights) : 100,
    };
    const uniqueBiomes = [...new Set(biomes)].filter(b => b > 0).sort((a, b) => a - b);

    console.log(`GlobalMapProcessing | Heights: ${heightStats.min}-${heightStats.max}, Biomes: ${uniqueBiomes.length}`);


    // Target grid dimensions (rectangular grid to fill scene)
    const sceneDims = scene.dimensions;
    const cellSize = (scene.canvas?.grid?.size || 64) / gridResolution;

    const gridCols = Math.ceil(sceneDims.width / cellSize);
    const gridRows = Math.ceil(sceneDims.height / cellSize);
    const gridSize = gridRows * gridCols;

    console.log(`GlobalMapProcessing | Target grid: ${gridRows}x${gridCols} (${gridSize} cells, cellSize=${cellSize}px)`);

    // Create unified grid by interpolating Voronoi cells
    const gridHeights = new Float32Array(gridSize);
    const gridMoisture = new Uint8Array(gridSize);
    const gridTemperature = new Uint8Array(gridSize);

    // Interpolate heights and biomes for each grid cell
    // Normalize all heights to 0-100 range
    const sourceMin = heightStats.min;
    const sourceMax = heightStats.max;
    const sourceRange = sourceMax - sourceMin;
    
    for (let row = 0; row < gridRows; row++) {
      for (let col = 0; col < gridCols; col++) {
        const idx = row * gridCols + col;

        // Grid cell coordinates (shifted by half cell to center at coordinate point)
        const worldX = (col + 0.5) * cellSize;
        const worldY = (row + 0.5) * cellSize;

        // Scale to source map coordinates (0..srcMapWidth, 0..srcMapHeight)
        const srcX = (worldX / sceneDims.width) * srcMapWidth;
        const srcY = (worldY / sceneDims.height) * srcMapHeight;

        // Find nearest Voronoi cells using simple distance
        let nearestHeight = heightStats.max / 2; // Default
        let nearestBiome = 0;

        let closestDist = Infinity;
        for (const vorCell of voronoiCells) {
          const dx = vorCell.x - srcX;
          const dy = vorCell.y - srcY;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < closestDist) {
            closestDist = dist;
            nearestHeight = vorCell.height;
            nearestBiome = vorCell.biome;
          }
        }

        // Normalize height to 0-100 range
        let normalizedHeight;
        if (sourceRange > 0) {
          normalizedHeight = ((nearestHeight - sourceMin) / sourceRange) * 100;
        } else {
          normalizedHeight = 50; // If all heights are the same, use middle value
        }
        gridHeights[idx] = normalizedHeight;
        
        // Map Azgaar biome ID to our biome ID, then get moisture/temperature
        const mappedBiomeId = this.biomeResolver.mapAzgaarBiomeId(nearestBiome);
        const params = this.biomeResolver.getParametersFromBiomeId(mappedBiomeId);
        gridMoisture[idx] = params.moisture;
        gridTemperature[idx] = params.temperature;
      }
    }

    // **IMPORTANT: Discard Voronoi data after interpolation**
    // voronoiCells is now garbage collected, we don't keep references to it

    const unifiedGrid = {
      heights: gridHeights,
      moisture: gridMoisture,
      temperature: gridTemperature,
      rows: gridRows,
      cols: gridCols,
    };

    const gridMetadata = {
      sourceType: 'PackCells',
      sourceMapDimensions: { width: srcMapWidth, height: srcMapHeight },
      sceneDimensions: sceneDims,
      gridResolution, // cells per unit
      cellSize,
      bounds: {
        minX: 0,
        minY: 0,
        maxX: sceneDims.width,
        maxY: sceneDims.height,
      },
      heightStats: {
        min: 0,
        max: 100,
        range: 100,
      },
      biomeStats: {
        uniqueBiomes,
        totalCells: gridSize,
      },
      timestamp: new Date().toISOString(),
    };

    console.log(`GlobalMapProcessing | ✓ Grid created: ${gridRows}x${gridCols}`);

    // Store in instance
    this.unifiedGrid = unifiedGrid;
    this.gridMetadata = gridMetadata;

    return { gridData: unifiedGrid, metadata: gridMetadata };
  }

  /**
   * Create flat uniform height grid
   * @param {number} defaultHeight - Uniform height value
   * @param {Scene} scene - Target scene
   * @param {number} gridResolution - Cells per unit (default 2)
   * @returns {Object} {gridData, metadata}
   */
  createFlatGrid(defaultHeight = 20, scene = null, gridResolution = 2) {
    console.log(`GlobalMapProcessing | Creating flat grid with height ${defaultHeight}`);

    const targetScene = scene || canvas.scene;
    if (!targetScene) {
      throw new Error('No scene available');
    }

    const sceneDims = targetScene.dimensions;
    const cellSize = (canvas.grid?.size || 64) / gridResolution;

    const gridCols = Math.ceil(sceneDims.width / cellSize);
    const gridRows = Math.ceil(sceneDims.height / cellSize);
    const gridSize = gridRows * gridCols;

    // All cells have same height, default moisture/temperature
    const gridHeights = new Float32Array(gridSize);
    gridHeights.fill(defaultHeight);

    const gridMoisture = new Uint8Array(gridSize);
    gridMoisture.fill(3); // Default moisture = 3 (moderate)

    const gridTemperature = new Uint8Array(gridSize);
    gridTemperature.fill(3); // Default temperature = 3 (temperate)

    const unifiedGrid = {
      heights: gridHeights,
      moisture: gridMoisture,
      temperature: gridTemperature,
      rows: gridRows,
      cols: gridCols,
    };

    const gridMetadata = {
      sourceType: 'Flat',
      sceneDimensions: sceneDims,
      gridResolution,
      cellSize,
      bounds: {
        minX: 0,
        minY: 0,
        maxX: sceneDims.width,
        maxY: sceneDims.height,
      },
      heightStats: {
        min: 0,
        max: 100,
        range: 100,
      },
      biomeStats: {
        uniqueBiomes: [],
        totalCells: gridSize,
      },
      timestamp: new Date().toISOString(),
      isFlat: true,
    };

    this.unifiedGrid = unifiedGrid;
    this.gridMetadata = gridMetadata;

    return { gridData: unifiedGrid, metadata: gridMetadata };
  }

  /**
   * Create biome test grid (5x6 grid matching biome matrix)
   * Each cell represents one biome from the biome matrix (temperature 1-5, moisture 1-6)
   * @param {Scene} scene - Target scene
   * @param {number} gridResolution - Cells per unit (default 2)
   * @param {number} baseHeight - Base height for all cells (default 20)
   * @returns {Object} {gridData, metadata}
   */
  createBiomeTestGrid(scene = null, gridResolution = 2, baseHeight = 20) {
    console.log(`GlobalMapProcessing | Creating biome test grid (5x6 biome matrix)`);

    const targetScene = scene || canvas.scene;
    if (!targetScene) {
      throw new Error('No scene available');
    }

    const sceneDims = targetScene.dimensions;
    const cellSize = (targetScene.canvas?.grid?.size || 64) / gridResolution;

    // Biome matrix: 5 temperatures (columns) x 6 moisture levels (rows)
    const biomeCols = 5; // Temperature 1-5
    const biomeRows = 6; // Moisture 1-6

    // Calculate cells per biome block to fill scene
    const cellsPerBiomeX = Math.ceil(sceneDims.width / cellSize / biomeCols);
    const cellsPerBiomeY = Math.ceil(sceneDims.height / cellSize / biomeRows);

    const gridCols = biomeCols * cellsPerBiomeX;
    const gridRows = biomeRows * cellsPerBiomeY;
    const gridSize = gridRows * gridCols;

    console.log(`GlobalMapProcessing | Test grid: ${gridRows}x${gridCols} cells, ` +
                `${cellsPerBiomeX}x${cellsPerBiomeY} cells per biome block`);

    const gridHeights = new Float32Array(gridSize);
    const gridMoisture = new Uint8Array(gridSize);
    const gridTemperature = new Uint8Array(gridSize);

    // Fill grid: each block corresponds to one biome from matrix
    for (let row = 0; row < gridRows; row++) {
      for (let col = 0; col < gridCols; col++) {
        const idx = row * gridCols + col;

        // Determine which biome block this cell belongs to
        const biomeCol = Math.floor(col / cellsPerBiomeX); // 0-4 → temperature 1-5
        const biomeRow = Math.floor(row / cellsPerBiomeY); // 0-5 → moisture 1-6

        // Biome matrix coordinates
        const temperature = biomeCol + 1; // 1-5
        const moisture = 6 - biomeRow;     // 6-1 (inverted: top row = moisture 6)

        gridHeights[idx] = baseHeight;
        gridTemperature[idx] = temperature;
        gridMoisture[idx] = moisture;
      }
    }

    const unifiedGrid = {
      heights: gridHeights,
      moisture: gridMoisture,
      temperature: gridTemperature,
      rows: gridRows,
      cols: gridCols,
    };

    // Collect unique biomes for stats
    const uniqueBiomes = [];
    for (let temp = 1; temp <= 5; temp++) {
      for (let moist = 1; moist <= 6; moist++) {
        const biomeId = this.biomeResolver.getBiomeId(moist, temp);
        if (!uniqueBiomes.includes(biomeId)) {
          uniqueBiomes.push(biomeId);
        }
      }
    }

    const gridMetadata = {
      sourceType: 'BiomeTestGrid',
      sceneDimensions: sceneDims,
      gridResolution,
      cellSize,
      bounds: {
        minX: 0,
        minY: 0,
        maxX: sceneDims.width,
        maxY: sceneDims.height,
      },
      heightStats: {
        min: 0,
        max: 100,
        range: 100,
      },
      biomeStats: {
        uniqueBiomes: uniqueBiomes.sort((a, b) => a - b),
        totalCells: gridSize,
        testGrid: true,
        biomeBlockSize: { x: cellsPerBiomeX, y: cellsPerBiomeY },
      },
      timestamp: new Date().toISOString(),
      isBiomeTestGrid: true,
    };

    this.unifiedGrid = unifiedGrid;
    this.gridMetadata = gridMetadata;

    console.log(`GlobalMapProcessing | ✓ Biome test grid created: ${gridRows}x${gridCols}, ` +
                `${uniqueBiomes.length} unique biomes`);

    return { gridData: unifiedGrid, metadata: gridMetadata };
  }

  /**
   * Get current unified grid
   * @returns {Object|null} {heights, biomes, rows, cols}
   */
  getUnifiedGrid() {
    return this.unifiedGrid;
  }

  /**
   * Get current grid metadata
   * @returns {Object|null}
   */
  getGridMetadata() {
    return this.gridMetadata;
  }

  /**
   * Generate file name for a scene
   * @param {Scene} scene - Target scene
   * @returns {string} File name like "SceneName_uuid.json"
   */
  _generateFileName(scene) {
    const sceneName = scene.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return `${sceneName}_${scene.id}.json`;
  }

  /**
   * Generate file path for saving grid
   * @param {Scene} scene - Target scene
   * @returns {string} Full file path
   */
  _getGridFilePath(scene) {
    const fileName = this._generateFileName(scene);
    return `worlds/${game.world.id}/global-maps/${fileName}`;
  }

  /**
   * Save unified grid to file
   * @param {Scene} scene - Target scene
   * @returns {Promise<boolean>} Success status
   */
  async saveGridToFile(scene) {
    try {
      if (!this.unifiedGrid || !this.gridMetadata) {
        throw new Error('No grid data to save');
      }

      const filePath = this._getGridFilePath(scene);
      console.log(`GlobalMapProcessing | Saving grid to: ${filePath}`);

      // Convert typed arrays to regular arrays for JSON serialization
      const heightsArray = Array.from(this.unifiedGrid.heights);
      const moistureArray = Array.from(this.unifiedGrid.moisture);
      const temperatureArray = Array.from(this.unifiedGrid.temperature);

      const gridData = {
        version: 2, // New version with moisture/temperature
        metadata: this.gridMetadata,
        grid: {
          heights: heightsArray,
          moisture: moistureArray,
          temperature: temperatureArray,
          rows: this.unifiedGrid.rows,
          cols: this.unifiedGrid.cols,
        },
      };

      // Create JSON blob
      const blob = new Blob([JSON.stringify(gridData, null, 2)], { type: 'application/json' });
      const file = new File([blob], this._generateFileName(scene), { type: 'application/json' });

      const directory = filePath.substring(0, filePath.lastIndexOf('/'));

      // Create directory if needed
      try {
        await foundry.applications.apps.FilePicker.implementation.createDirectory('data', directory, {});
      } catch (err) {
        // Directory might already exist
      }

      // Upload file
      const response = await foundry.applications.apps.FilePicker.implementation.upload(
        'data',
        directory,
        file,
        {}
      );

      if (response) {
        // Save path to scene flag for later loading
        await scene.setFlag('spaceholder', 'globalMapGridPath', response.path);
        console.log(`GlobalMapProcessing | ✓ Grid saved to ${response.path}`);
        ui.notifications.info('Global map saved successfully');
        return true;
      }

      return false;
    } catch (error) {
      console.error('GlobalMapProcessing | Failed to save grid:', error);
      ui.notifications.error(`Failed to save grid: ${error.message}`);
      return false;
    }
  }

  /**
   * Load unified grid from file
   * @param {Scene} scene - Target scene
   * @returns {Promise<{gridData, metadata}|null>} Loaded grid or null if not found
   */
  async loadGridFromFile(scene) {
    try {
      // Try to load from scene flag first
      let savedPath = scene.getFlag('spaceholder', 'globalMapGridPath');

      if (!savedPath) {
        // Fallback: compute expected path by convention
        savedPath = this._getGridFilePath(scene);
        console.log('GlobalMapProcessing | No saved grid path in scene flags; trying default path:', savedPath);
      }

      console.log(`GlobalMapProcessing | Loading grid from: ${savedPath}`);

      const response = await fetch(savedPath);
      if (!response.ok) {
        console.warn(`GlobalMapProcessing | Grid file not found: ${savedPath}`);
        return null;
      }

      const gridData = await response.json();

      // Handle different versions
      let unifiedGrid;
      
      if (gridData.version === 2) {
        // Version 2: moisture/temperature format
        unifiedGrid = {
          heights: new Float32Array(gridData.grid.heights),
          moisture: new Uint8Array(gridData.grid.moisture),
          temperature: new Uint8Array(gridData.grid.temperature),
          rows: gridData.grid.rows,
          cols: gridData.grid.cols,
        };
      } else if (gridData.version === 1) {
        // Version 1 (legacy): biomes format - convert to moisture/temperature
        console.log('GlobalMapProcessing | Converting legacy format (v1) to v2...');
        const heights = new Float32Array(gridData.grid.heights);
        const biomes = new Uint8Array(gridData.grid.biomes);
        const moisture = new Uint8Array(biomes.length);
        const temperature = new Uint8Array(biomes.length);
        
        // Convert each biome to moisture/temperature
        for (let i = 0; i < biomes.length; i++) {
          const params = this.biomeResolver.getParametersFromBiomeId(biomes[i]);
          moisture[i] = params.moisture;
          temperature[i] = params.temperature;
        }
        
        unifiedGrid = {
          heights,
          moisture,
          temperature,
          rows: gridData.grid.rows,
          cols: gridData.grid.cols,
        };
      } else {
        console.warn(`GlobalMapProcessing | Unsupported grid version: ${gridData.version}`);
        return null;
      }

      // Store in instance
      this.unifiedGrid = unifiedGrid;
      this.gridMetadata = gridData.metadata;

      console.log(`GlobalMapProcessing | ✓ Grid loaded: ${unifiedGrid.rows}x${unifiedGrid.cols}`);

      return {
        gridData: unifiedGrid,
        metadata: gridData.metadata,
      };
    } catch (error) {
      console.error('GlobalMapProcessing | Failed to load grid:', error);
      return null;
    }
  }

  /**
   * Clear processed data
   */
  clear() {
    this.unifiedGrid = null;
    this.gridMetadata = null;
  }
}

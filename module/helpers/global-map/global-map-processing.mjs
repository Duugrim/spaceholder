import { BiomeResolver } from './global-map-biome-resolver.mjs';

function _t(key) {
  return game?.i18n?.localize ? game.i18n.localize(key) : String(key);
}

function _f(key, data) {
  return game?.i18n?.format ? game.i18n.format(key, data) : String(key);
}

/**
 * Global Map Processing
 * Converts raw PackCells Voronoi data into a unified rectangular height grid
 * Raw data is discarded after processing - only final grid is stored
 */
export class GlobalMapProcessing {
  constructor() {
    this.unifiedGrid = null; // Final rectangular grid: {heights, biomes, rivers, rows, cols}
    this.gridMetadata = null; // Grid metadata: {bounds, cellSize, stats, timestamp}
    this.biomeResolver = new BiomeResolver();
  }

  /**
   * Initialize processing - load biome resolver config
   */
  async initialize() {
    // Load base config + world overrides (if any)
    if (typeof this.biomeResolver.reloadConfigWithWorldOverrides === 'function') {
      await this.biomeResolver.reloadConfigWithWorldOverrides();
    } else {
      await this.biomeResolver.loadConfig();
    }

    console.log('GlobalMapProcessing | Initialized');
  }

  /**
   * Validate raw PackCells data structure
   * @param {Object} data - Raw data from Azgaar's FMG
   * @returns {Object} {valid: boolean, error?: string}
   */
  validatePackCellsData(data) {
    if (!data.info || !data.cells) {
      return { valid: false, error: _t('SPACEHOLDER.GlobalMap.Errors.PackCells.MissingInfoAndCells') };
    }

    const cells = data.cells?.cells || data.cells;
    if (!Array.isArray(cells) || cells.length === 0) {
      return { valid: false, error: _t('SPACEHOLDER.GlobalMap.Errors.PackCells.CellsArrayMissingOrEmpty') };
    }

    const sampleCell = cells[0];
    if (!sampleCell.hasOwnProperty('p')) {
      return { valid: false, error: _t('SPACEHOLDER.GlobalMap.Errors.PackCells.CellsMissingPosition') };
    }

    // At minimum we need heights OR biomes
    const hasHeight = (
      ('h' in sampleCell) ||
      ('height' in sampleCell) ||
      ('elevation' in sampleCell) ||
      ('elev' in sampleCell)
    );

    const hasBiome = ('biome' in sampleCell);

    if (!hasHeight && !hasBiome) {
      return { valid: false, error: _t('SPACEHOLDER.GlobalMap.Errors.PackCells.CellsMissingHeightOrBiome') };
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
      throw new Error(_f('SPACEHOLDER.GlobalMap.Errors.InvalidPackCellsData', { error: validation.error }));
    }

    const cells = rawData.cells?.cells || rawData.cells;
    const mapInfo = rawData.info;

    // Source map dimensions
    const srcMapWidth = mapInfo.width;
    const srcMapHeight = mapInfo.height;

    console.log(`GlobalMapProcessing | Source map: ${srcMapWidth}x${srcMapHeight} Voronoi cells`);

    // Extract Voronoi cell data (will be discarded after interpolation)
    const readNumber = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    const voronoiCells = cells.map(cell => {
      const rawHeight = cell?.h ?? cell?.height ?? cell?.elevation ?? cell?.elev;
      const height = readNumber(rawHeight) ?? 0;

      const biome = readNumber(cell?.biome) ?? 0;

      return {
        x: cell.p[0],
        y: cell.p[1],
        height,
        biome,
      };
    });

    // Calculate stats from source data
    const heights = voronoiCells.map(c => c.height);
    const biomes = voronoiCells.map(c => c.biome);

    // Use full finite range (including oceans / negatives) to avoid flattening or negative normalization
    const finiteHeights = heights.filter(h => Number.isFinite(h));
    const heightStats = {
      min: finiteHeights.length > 0 ? Math.min(...finiteHeights) : 0,
      max: finiteHeights.length > 0 ? Math.max(...finiteHeights) : 100,
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
    const gridBiomes = new Uint8Array(gridSize);
    const gridRivers = new Uint8Array(gridSize); // 0 = no river, 1 = river

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
        if (Number.isFinite(nearestHeight) && sourceRange > 0) {
          normalizedHeight = ((nearestHeight - sourceMin) / sourceRange) * 100;
        } else if (Number.isFinite(nearestHeight)) {
          normalizedHeight = 50; // If all heights are the same, use middle value
        } else {
          normalizedHeight = 0;
        }

        // Clamp to expected range (renderer expects 0..100)
        gridHeights[idx] = Math.max(0, Math.min(100, normalizedHeight));
        
        // Map Azgaar biome ID to our biome ID
        const mappedBiomeId = this.biomeResolver.mapAzgaarBiomeId(nearestBiome);
        gridBiomes[idx] = mappedBiomeId;
      }
    }

    // **IMPORTANT: Discard Voronoi data after interpolation**
    // voronoiCells is now garbage collected, we don't keep references to it

    // Collect unique mapped biomes
    const uniqueMappedBiomesSet = new Set();
    for (let i = 0; i < gridBiomes.length; i++) {
      const b = gridBiomes[i];
      if (b > 0) uniqueMappedBiomesSet.add(b);
    }
    const uniqueMappedBiomes = Array.from(uniqueMappedBiomesSet).sort((a, b) => a - b);

    const unifiedGrid = {
      heights: gridHeights,
      biomes: gridBiomes,
      rivers: gridRivers,
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
        // Source biomes are Azgaar indices; mapped biomes are our internal biome IDs
        sourceUniqueBiomes: uniqueBiomes,
        mappedUniqueBiomes: uniqueMappedBiomes,
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
      throw new Error(_t('SPACEHOLDER.GlobalMap.Errors.NoActiveScene'));
    }

    const sceneDims = targetScene.dimensions;
    const cellSize = (canvas.grid?.size || 64) / gridResolution;

    const gridCols = Math.ceil(sceneDims.width / cellSize);
    const gridRows = Math.ceil(sceneDims.height / cellSize);
    const gridSize = gridRows * gridCols;

    // All cells have same height, default biome
    const gridHeights = new Float32Array(gridSize);
    gridHeights.fill(defaultHeight);

    const gridBiomes = new Uint8Array(gridSize);
    const defaultBiomeId = this.biomeResolver.getDefaultBiomeId();
    gridBiomes.fill(defaultBiomeId);

    const gridRivers = new Uint8Array(gridSize); // No rivers by default

    const unifiedGrid = {
      heights: gridHeights,
      biomes: gridBiomes,
      rivers: gridRivers,
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
        mappedUniqueBiomes: [defaultBiomeId],
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
   * Create biome test grid (blocks of all active biomes)
   * Each block represents one biome from the registry (sorted by renderRank)
   * @param {Scene} scene - Target scene
   * @param {number} gridResolution - Cells per unit (default 2)
   * @param {number} baseHeight - Base height for all cells (default 20)
   * @returns {Object} {gridData, metadata}
   */
  createBiomeTestGrid(scene = null, gridResolution = 2, baseHeight = 20) {
    console.log(`GlobalMapProcessing | Creating biome test grid (registry biomes)`);

    const targetScene = scene || canvas.scene;
    if (!targetScene) {
      throw new Error(_t('SPACEHOLDER.GlobalMap.Errors.NoActiveScene'));
    }

    const sceneDims = targetScene.dimensions;
    const cellSize = (targetScene.canvas?.grid?.size || 64) / gridResolution;

    const biomes = this.biomeResolver.listBiomes();
    if (!biomes.length) {
      throw new Error(_t('SPACEHOLDER.GlobalMap.Errors.NoBiomesAvailable'));
    }

    // Layout blocks in a near-square grid
    const biomeCols = Math.ceil(Math.sqrt(biomes.length));
    const biomeRows = Math.ceil(biomes.length / biomeCols);

    // Calculate cells per biome block to fill scene
    const cellsPerBiomeX = Math.ceil(sceneDims.width / cellSize / biomeCols);
    const cellsPerBiomeY = Math.ceil(sceneDims.height / cellSize / biomeRows);

    const gridCols = biomeCols * cellsPerBiomeX;
    const gridRows = biomeRows * cellsPerBiomeY;
    const gridSize = gridRows * gridCols;

    console.log(
      `GlobalMapProcessing | Test grid: ${gridRows}x${gridCols} cells, ` +
      `${cellsPerBiomeX}x${cellsPerBiomeY} cells per biome block, ` +
      `${biomes.length} biomes`
    );

    const gridHeights = new Float32Array(gridSize);
    const gridBiomes = new Uint8Array(gridSize);
    const gridRivers = new Uint8Array(gridSize); // No rivers by default

    const defaultBiomeId = this.biomeResolver.getDefaultBiomeId();

    // Fill grid: each block corresponds to one biome
    for (let row = 0; row < gridRows; row++) {
      for (let col = 0; col < gridCols; col++) {
        const idx = row * gridCols + col;

        const blockCol = Math.floor(col / cellsPerBiomeX);
        const blockRow = Math.floor(row / cellsPerBiomeY);
        const biomeIndex = blockRow * biomeCols + blockCol;

        const biomeId = biomeIndex < biomes.length ? biomes[biomeIndex].id : defaultBiomeId;

        gridHeights[idx] = baseHeight;
        gridBiomes[idx] = biomeId;
      }
    }

    // Collect unique biomes for stats
    const uniqueBiomesSet = new Set();
    for (let i = 0; i < gridBiomes.length; i++) {
      const b = gridBiomes[i];
      if (b > 0) uniqueBiomesSet.add(b);
    }
    const uniqueBiomes = Array.from(uniqueBiomesSet).sort((a, b) => a - b);

    const unifiedGrid = {
      heights: gridHeights,
      biomes: gridBiomes,
      rivers: gridRivers,
      rows: gridRows,
      cols: gridCols,
    };

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
        mappedUniqueBiomes: uniqueBiomes,
        totalCells: gridSize,
        testGrid: true,
        biomeBlockSize: { x: cellsPerBiomeX, y: cellsPerBiomeY },
        biomeLayout: { biomeRows, biomeCols },
      },
      timestamp: new Date().toISOString(),
      isBiomeTestGrid: true,
    };

    this.unifiedGrid = unifiedGrid;
    this.gridMetadata = gridMetadata;

    console.log(
      `GlobalMapProcessing | ✓ Biome test grid created: ${gridRows}x${gridCols}, ` +
      `${uniqueBiomes.length} unique biomes`
    );

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
        throw new Error(_t('SPACEHOLDER.GlobalMap.Errors.NoGridDataToSave'));
      }

      const filePath = this._getGridFilePath(scene);
      console.log(`GlobalMapProcessing | Saving grid to: ${filePath}`);

      // Convert typed arrays to regular arrays for JSON serialization
      const heightsArray = Array.from(this.unifiedGrid.heights);
      const biomesArray = Array.from(this.unifiedGrid.biomes || new Uint8Array(this.unifiedGrid.heights.length));
      const riversArray = Array.from(this.unifiedGrid.rivers || new Uint8Array(this.unifiedGrid.heights.length));

      const gridData = {
        version: 4, // Biomes + rivers
        metadata: this.gridMetadata,
        grid: {
          heights: heightsArray,
          biomes: biomesArray,
          rivers: riversArray,
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
        ui.notifications?.info?.(_t('SPACEHOLDER.GlobalMap.Notifications.MapSaved'));
        return true;
      }

      return false;
    } catch (error) {
      console.error('GlobalMapProcessing | Failed to save grid:', error);
      ui.notifications?.error?.(_f('SPACEHOLDER.GlobalMap.Errors.SaveGridFailed', { message: error.message }));
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
      
      if (gridData.version === 4) {
        // Version 4: biomes + rivers
        unifiedGrid = {
          heights: new Float32Array(gridData.grid.heights),
          biomes: new Uint8Array(gridData.grid.biomes),
          rivers: new Uint8Array(gridData.grid.rivers || new Array(gridData.grid.heights.length).fill(0)),
          rows: gridData.grid.rows,
          cols: gridData.grid.cols,
        };
      } else if (gridData.version === 3) {
        // Version 3 (legacy): moisture/temperature/rivers → convert to biomes
        const heights = new Float32Array(gridData.grid.heights);
        const moisture = new Uint8Array(gridData.grid.moisture);
        const temperature = new Uint8Array(gridData.grid.temperature);
        const rivers = new Uint8Array(gridData.grid.rivers || new Array(gridData.grid.heights.length).fill(0));

        const biomes = new Uint8Array(heights.length);
        for (let i = 0; i < biomes.length; i++) {
          biomes[i] = this.biomeResolver.getBiomeId(moisture[i], temperature[i]);
        }

        unifiedGrid = {
          heights,
          biomes,
          rivers,
          rows: gridData.grid.rows,
          cols: gridData.grid.cols,
        };
      } else if (gridData.version === 2) {
        // Version 2 (legacy): moisture/temperature → convert to biomes
        const heights = new Float32Array(gridData.grid.heights);
        const moisture = new Uint8Array(gridData.grid.moisture);
        const temperature = new Uint8Array(gridData.grid.temperature);
        const rivers = new Uint8Array(gridData.grid.heights.length); // Empty rivers

        const biomes = new Uint8Array(heights.length);
        for (let i = 0; i < biomes.length; i++) {
          biomes[i] = this.biomeResolver.getBiomeId(moisture[i], temperature[i]);
        }

        unifiedGrid = {
          heights,
          biomes,
          rivers,
          rows: gridData.grid.rows,
          cols: gridData.grid.cols,
        };
      } else if (gridData.version === 1) {
        // Version 1 (legacy): biomes (no rivers)
        const heights = new Float32Array(gridData.grid.heights);
        const biomes = new Uint8Array(gridData.grid.biomes);
        
        unifiedGrid = {
          heights,
          biomes,
          rivers: new Uint8Array(heights.length), // Empty rivers for v1
          rows: gridData.grid.rows,
          cols: gridData.grid.cols,
        };
      } else {
        console.warn(`GlobalMapProcessing | Unsupported grid version: ${gridData.version}`);
        return null;
      }

      // Normalize biomes to enabled registry set (if registry is loaded)
      if (unifiedGrid?.biomes?.length) {
        for (let i = 0; i < unifiedGrid.biomes.length; i++) {
          unifiedGrid.biomes[i] = this.biomeResolver.normalizeBiomeId(unifiedGrid.biomes[i]);
        }
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

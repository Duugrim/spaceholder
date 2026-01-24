import { BiomeResolver } from './global-map-biome-resolver.mjs';

function _t(key) {
  return game?.i18n?.localize ? game.i18n.localize(key) : String(key);
}

function _f(key, data) {
  return game?.i18n?.format ? game.i18n.format(key, data) : String(key);
}

/**
 * Global Map Renderer
 * Pure visualization layer - renders unified grid to canvas
 * Does NOT process or modify data, only displays it
 */
export class GlobalMapRenderer {
  constructor() {
    this.container = null; // Root PIXI.Container (added to canvas.primary)
    this.mapLayer = null; // Biomes + heights live here

    // Regions layer (vector polygons)
    this.regionsLayer = null; // Base regions (fill + stroke)
    this.regionHoverLayer = null; // Hover outline overlay (PIXI.Graphics)
    this.regionLabelsLayer = null; // Region labels live here

    this.riversLayer = null; // Vector rivers live here
    this.riverLabelsLayer = null; // River labels live here

    this.isVisible = false;
    this.currentGrid = null; // Reference to current grid being rendered
    this.currentMetadata = null;
    this.currentSceneId = null; // Scene id this grid/metadata belongs to (prevents editing wrong scene)
    this._canvasSceneId = null; // Last scene id we saw in onCanvasReady (used for scene-change detection even without a grid)

    // Separate render modes for heights and biomes
    this.heightsMode = 'contours-bw'; // 'contours-bw', 'contours', 'cells', 'off'
    this.biomesMode = 'fancy'; // 'fancy', 'fancyDebug', 'cells', 'off'

    // Visual tuning (debug/test)
    this.heightContourAlpha = 0.8; // Opacity for height contour lines (0..1)

    this.biomeResolver = new BiomeResolver(); // For dynamic biome determination

    // Legacy (cell-mask) rivers are disabled by default (we use vector rivers instead)
    this.legacyRiversEnabled = false;

    // Vector regions state (loaded from scene flags or set by tools)
    this.vectorRegionsData = null; // {version:1, settings:{labelMode,clickAction,clickModifier}, regions:[...]}

    // Regions hover/click runtime
    this._regionHoverHandler = null;
    this._regionClickHandler = null;
    this._hoveredRegionId = null;
    this._regionHoverLabel = null; // PIXI.Text

    // Cached per-region render metadata
    this._regionLabelAnchors = new Map(); // regionId -> {x,y}
    this._regionBounds = new Map(); // regionId -> {minX,minY,maxX,maxY, pad}
    this._regionRenderPoints = new Map(); // regionId -> points[] used for render/hit-test

    // Vector rivers state (loaded from scene flags or set by tools)
    this.vectorRiversData = null; // {version:1, settings:{labelMode,snapToEndpoints}, rivers:[...]}

    // Hover label runtime
    this._riverHoverHandler = null;
    this._hoveredRiverId = null;
    this._riverHoverLabel = null; // PIXI.Text

    // Cached per-river render metadata
    this._riverLabelAnchors = new Map(); // riverId -> {x,y, angle, width}
    this._riverBounds = new Map(); // riverId -> {minX,minY,maxX,maxY, pad}

    // Client-side fade animations (displayObject -> {cancelled:boolean})
    this._fadeJobs = new Map();
  }

  /**
   * Initialize renderer and set up canvas hooks
   */
  async initialize() {
    console.log('GlobalMapRenderer | Initializing...');

    // Load biome resolver config + world overrides (if any)
    if (typeof this.biomeResolver.reloadConfigWithWorldOverrides === 'function') {
      await this.biomeResolver.reloadConfigWithWorldOverrides();
    } else {
      await this.biomeResolver.loadConfig();
    }

    Hooks.on('canvasReady', async () => {
      await this.onCanvasReady();
    });

    if (canvas?.ready && canvas?.scene) {
      console.log('GlobalMapRenderer | Canvas already ready');
      setTimeout(async () => {
        await this.onCanvasReady();
      }, 100);
    }
  }

  /**
   * Called when canvas is ready - set up rendering container
   */
  async onCanvasReady() {
    console.log('GlobalMapRenderer | onCanvasReady');
    this.isVisible = false;

    // Detect scene changes on canvas rebuild
    const sceneId = canvas?.scene?.id || null;
    const prevCanvasSceneId = this._canvasSceneId;
    const sceneChanged = !!(prevCanvasSceneId && sceneId && prevCanvasSceneId !== sceneId);
    this._canvasSceneId = sceneId;

    // If we have a grid from another scene, drop it to prevent cross-scene editing/rendering bugs
    const gridSceneMismatch = !!(this.currentSceneId && sceneId && this.currentSceneId !== sceneId);
    if (gridSceneMismatch) {
      this.currentGrid = null;
      this.currentMetadata = null;
      this.currentSceneId = null;
    }

    // Recreate container/layers for this canvas
    this.setupContainer();

    // Reload regions for the active scene.
    // If the scene changed, we must read new flags.
    // If the scene did NOT change, preserve in-memory regions (they may include unsaved edits) and only load if empty.
    if (sceneChanged || this.vectorRegionsData === null || this.vectorRegionsData === undefined) {
      this.vectorRegionsData = null;
      await this.loadVectorRegionsFromScene();
    }

    // Reload rivers for the active scene.
    // If the scene changed, we must read new flags.
    // If the scene did NOT change, preserve in-memory rivers (they may include unsaved edits) and only load if empty.
    if (sceneChanged || this.vectorRiversData === null || this.vectorRiversData === undefined) {
      this.vectorRiversData = null;
      await this.loadVectorRiversFromScene();
    }

    // Hover labels (work outside of editing tools)
    this._installRegionHoverHandler();
    this._removeRegionClickHandler();
    this._installRiverHoverHandler();

    // If we already have a rendered grid (same scene refresh), re-render it into the new container.
    // Without this, the map disappears after canvas rebuild until something else triggers render().
    if (this.currentGrid && this.currentMetadata) {
      await this.render(this.currentGrid, this.currentMetadata);
      return;
    }

    // Otherwise, if a grid is already rendered but we don't want to re-render the whole map, at least redraw overlays on top
    if (this.currentMetadata) {
      if (this.vectorRegionsData) {
        this.renderVectorRegions(this.vectorRegionsData, this.currentMetadata);
      }
      if (this.vectorRiversData) {
        this.renderVectorRivers(this.vectorRiversData, this.currentMetadata);
      }
    }
  }

  /**
   * Set up PIXI container on primary layer (under tokens)
   */
  setupContainer() {
    const primaryLayer = canvas.primary;

    if (!primaryLayer) {
      console.warn('GlobalMapRenderer | Primary layer not available');
      return;
    }

    // Clear existing container
    if (this.container) {
      try {
        this.container.destroy({ children: true });
      } catch (e) {
        // ignore
      }
    }

    // Reset layer refs
    this.container = null;
    this.mapLayer = null;

    this.regionsLayer = null;
    this.regionHoverLayer = null;
    this.regionLabelsLayer = null;

    this.riversLayer = null;
    this.riverLabelsLayer = null;

    this.container = new PIXI.Container();
    this.container.name = 'globalMapContainer';

    // Ensure zIndex ordering works within this container
    this.container.sortableChildren = true;

    // Dedicated layers: map (biomes/heights) + regions + rivers + labels
    this.mapLayer = new PIXI.Container();
    this.mapLayer.name = 'globalMapMapLayer';
    this.mapLayer.zIndex = 0;

    this.regionsLayer = new PIXI.Container();
    this.regionsLayer.name = 'globalMapRegionsLayer';
    this.regionsLayer.zIndex = 1500;

    // Hover outline is a Graphics overlay so we can redraw without rebuilding base regions graphics
    this.regionHoverLayer = new PIXI.Graphics();
    this.regionHoverLayer.name = 'globalMapRegionHoverLayer';
    this.regionHoverLayer.zIndex = 2040;

    this.regionLabelsLayer = new PIXI.Container();
    this.regionLabelsLayer.name = 'globalMapRegionLabelsLayer';
    this.regionLabelsLayer.zIndex = 2050;

    this.riversLayer = new PIXI.Container();
    this.riversLayer.name = 'globalMapRiversLayer';
    this.riversLayer.zIndex = 2000;

    this.riverLabelsLayer = new PIXI.Container();
    this.riverLabelsLayer.name = 'globalMapRiverLabelsLayer';
    this.riverLabelsLayer.zIndex = 2100;

    this.container.addChild(this.mapLayer);
    this.container.addChild(this.regionsLayer);
    this.container.addChild(this.riversLayer);
    this.container.addChild(this.regionHoverLayer);
    this.container.addChild(this.regionLabelsLayer);
    this.container.addChild(this.riverLabelsLayer);

    // Устанавливаем высокий zIndex, чтобы быть поверх фона, но под токенами
    this.container.zIndex = 1000;

    primaryLayer.addChild(this.container);
    
    // Включаем сортировку по zIndex для primary layer
    if (!primaryLayer.sortableChildren) {
      primaryLayer.sortableChildren = true;
      primaryLayer.sortChildren();
    }

    console.log('GlobalMapRenderer | Container set up on primary layer (under tokens) with zIndex 1000');
  }

  /**
   * Set heights render mode
   * @param {string} mode - 'contours-bw', 'contours', 'cells', 'off'
   */
  setHeightsMode(mode) {
    if (!['contours-bw', 'contours', 'cells', 'off'].includes(mode)) {
      console.warn(`GlobalMapRenderer | Invalid heights mode: ${mode}`);
      return;
    }
    this.heightsMode = mode;
    console.log(`GlobalMapRenderer | Heights mode set to: ${mode}`);
    // Re-render if data available
    if (this.currentGrid && this.currentMetadata) {
      this.render(this.currentGrid, this.currentMetadata);
    }
  }

  /**
   * Set opacity for height contour lines (applies to contours modes).
   * @param {number} alpha - 0..1
   */
  setHeightContourAlpha(alpha) {
    const n = Number(alpha);
    if (!Number.isFinite(n)) return;

    const clamped = Math.max(0, Math.min(1, n));
    this.heightContourAlpha = clamped;

    console.log(`GlobalMapRenderer | Height contour alpha set to: ${clamped}`);

    // Re-render if data available
    if (this.currentGrid && this.currentMetadata) {
      this.render(this.currentGrid, this.currentMetadata);
    }
  }

  /**
   * Set biomes render mode
   * @param {string} mode - 'fancy', 'fancyDebug', 'cells', 'off'
   */
  setBiomesMode(mode) {
    if (!['fancy', 'fancyDebug', 'cells', 'off'].includes(mode)) {
      console.warn(`GlobalMapRenderer | Invalid biomes mode: ${mode}`);
      return;
    }
    this.biomesMode = mode;
    console.log(`GlobalMapRenderer | Biomes mode set to: ${mode}`);
    // Re-render if data available
    if (this.currentGrid && this.currentMetadata) {
      this.render(this.currentGrid, this.currentMetadata);
    }
  }

  /**
   * Render unified grid to canvas with separate biomes and heights modes
   * @param {Object} gridData - Unified grid {heights, biomes, rivers, rows, cols}
   * @param {Object} metadata - Grid metadata
   */
  async render(gridData, metadata) {
    if (!gridData || !gridData.heights) {
      console.warn('GlobalMapRenderer | No grid data to render');
      return;
    }

    console.log(`GlobalMapRenderer | Rendering grid (biomes: ${this.biomesMode}, heights: ${this.heightsMode})...`);

    // Store reference to current grid
    this.currentGrid = gridData;
    this.currentMetadata = metadata;
    this.currentSceneId = canvas?.scene?.id || null;

    // Make sure container/layers exist
    if (!this.container || !this.mapLayer || !this.riversLayer || !this.riverLabelsLayer) {
      this.setupContainer();
    }

    // Clear previous map rendering (keep rivers/labels/overlays)
    this.mapLayer.removeChildren();

    // Render biomes layer
    if (this.biomesMode !== 'off') {
      this._renderBiomesLayer(gridData, metadata);
    }

    // Render heights layer
    if (this.heightsMode !== 'off') {
      this._renderHeightsLayer(gridData, metadata);
    }

    // Legacy rivers layer (cell-mask) is disabled by default
    if (this.legacyRiversEnabled && gridData.rivers) {
      this._renderRiversLayer(gridData, metadata);
    }

    // Vector regions (new system)
    if (this.vectorRegionsData === null) {
      await this.loadVectorRegionsFromScene();
    }
    if (this.vectorRegionsData) {
      this.renderVectorRegions(this.vectorRegionsData, metadata);
    } else {
      this.clearVectorRegions();
    }

    // Vector rivers (new system)
    if (this.vectorRiversData === null) {
      await this.loadVectorRiversFromScene();
    }
    if (this.vectorRiversData) {
      this.renderVectorRivers(this.vectorRiversData, metadata);
    } else {
      this.clearVectorRivers();
    }

    this.isVisible = true;
    console.log(`GlobalMapRenderer | ✓ Rendered ${gridData.rows}x${gridData.cols} grid`);
  }

  /**
   * Render biomes layer based on current biomesMode
   * @private
   */
  _renderBiomesLayer(gridData, metadata) {
    switch (this.biomesMode) {
      case 'fancy':
        this._renderBiomesSmooth(gridData, metadata, false); // No borders
        break;
      case 'fancyDebug':
        this._renderBiomesSmooth(gridData, metadata, true); // With borders
        break;
      case 'cells':
        this._renderBiomesCells(gridData, metadata);
        break;
    }
  }

  /**
   * Render heights layer based on current heightsMode
   * @private
   */
  _renderHeightsLayer(gridData, metadata) {
    switch (this.heightsMode) {
      case 'contours-bw':
        this._renderHeightContoursBW(gridData, metadata);
        break;
      case 'contours':
        this._renderHeightContours(gridData, metadata);
        break;
      case 'cells':
        this._renderHeightCells(gridData, metadata);
        break;
    }
  }

  /**
   * Render biomes with smooth boundaries
   * @param {boolean} drawBorders - Whether to draw biome borders
   * @private
   */
  _renderBiomesSmooth(gridData, metadata, drawBorders = false) {
    const { biomes, moisture, temperature, heights, rows, cols } = gridData;
    const { cellSize, bounds } = metadata;

    // Prefer explicit biomes array; fall back to legacy moisture/temperature
    let biomeIds;
    if (biomes && biomes.length === rows * cols) {
      biomeIds = biomes;
    } else if (moisture && temperature) {
      biomeIds = new Uint8Array(rows * cols);
      for (let i = 0; i < rows * cols; i++) {
        biomeIds[i] = this.biomeResolver.getBiomeId(moisture[i], temperature[i]);
      }
    } else {
      return;
    }

    if (!biomeIds || biomeIds.length === 0) {
      console.log('GlobalMapRenderer | No biomes to render');
      return;
    }

    console.log('GlobalMapRenderer | Rendering biomes with smooth boundaries...');

    // Build per-biome cell lists in one pass
    const uniqueBiomes = new Set();
    const biomeCells = new Map(); // biomeId -> Array<cellIndex>

    for (let i = 0; i < rows * cols; i++) {
      const biomeId = biomeIds[i];
      uniqueBiomes.add(biomeId);
      let arr = biomeCells.get(biomeId);
      if (!arr) {
        arr = [];
        biomeCells.set(biomeId, arr);
      }
      arr.push(i);
    }

    const sortedBiomes = Array.from(uniqueBiomes).sort((a, b) => {
      const rankA = this.biomeResolver.getBiomeRank(a);
      const rankB = this.biomeResolver.getBiomeRank(b);
      if (rankA !== rankB) return rankA - rankB;
      return a - b;
    });

    console.log(`GlobalMapRenderer | Found ${sortedBiomes.length} unique biomes`);

    // Render biomes in deterministic rank order.
    // IMPORTANT: to avoid gaps after smoothing at multi-biome junctions, we slightly expand each biome
    // into neighboring (not-yet-processed) cells. This creates controlled overlaps that are resolved by
    // render rank ordering.
    const paintedCore = new Set();

    for (const biomeId of sortedBiomes) {
      const cells = biomeCells.get(biomeId);
      if (!cells || cells.length === 0) continue;

      const drawSet = new Set(cells);

      // Expand into 8-neighborhood ring around the biome, but never into already-painted core cells
      // (prevents later biomes from overwriting earlier biome ownership too aggressively).
      for (const cellIdx of cells) {
        const row = Math.floor(cellIdx / cols);
        const col = cellIdx % cols;

        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;

            const nRow = row + dr;
            const nCol = col + dc;
            if (nRow < 0 || nRow >= rows || nCol < 0 || nCol >= cols) continue;

            const nIdx = nRow * cols + nCol;
            if (paintedCore.has(nIdx)) continue;
            if (biomeIds[nIdx] === biomeId) continue;

            drawSet.add(nIdx);
          }
        }
      }

      this._renderBiomeRegionLayered(Array.from(drawSet), rows, cols, bounds, cellSize, biomeId);

      for (const cellIdx of cells) {
        paintedCore.add(cellIdx);
      }
    }

    // Optional: Draw smooth borders between biomes
    if (drawBorders) {
      this._drawBiomeBorders(biomeIds, rows, cols, bounds, cellSize, uniqueBiomes);
    }

    console.log('GlobalMapRenderer | ✓ Smooth biome boundaries rendered');
  }

  /**
   * Render biomes using wave-based approach at cluster level
   * Draws clusters in order of connectivity, starting from wettest biome
   * @private
   */
  _renderBiomesWaveBased(biomeIds, uniqueBiomes, rows, cols, bounds, cellSize) {
    // Build all clusters for all biomes first
    const allClusters = []; // Array of {biomeId, cluster: [cell indices], neighbors: Set}
    
    for (const biomeId of uniqueBiomes) {
      const biomeCells = [];
      for (let i = 0; i < rows * cols; i++) {
        if (biomeIds[i] === biomeId) {
          biomeCells.push(i);
        }
      }
      
      if (biomeCells.length === 0) continue;
      
      const clusters = this._findConnectedClusters(biomeCells, rows, cols);
      
      for (const cluster of clusters) {
        allClusters.push({
          biomeId,
          cluster,
          id: `${biomeId}_${allClusters.length}` // Unique cluster ID
        });
      }
    }
    
    console.log(`GlobalMapRenderer | Total clusters across all biomes: ${allClusters.length}`);
    
    // Find starting cluster (from wettest biome)
    const sortedBiomes = Array.from(uniqueBiomes).sort((a, b) => {
      const paramsA = this.biomeResolver.getParametersFromBiomeId(a);
      const paramsB = this.biomeResolver.getParametersFromBiomeId(b);
      if (paramsA.moisture !== paramsB.moisture) {
        return paramsB.moisture - paramsA.moisture;
      }
      return paramsA.temperature - paramsB.temperature;
    });
    
    const startBiomeId = sortedBiomes[0];
    const startCluster = allClusters.find(c => c.biomeId === startBiomeId);
    
    if (!startCluster) {
      console.warn('GlobalMapRenderer | No starting cluster found');
      return;
    }
    
    // Track rendered cells and processed clusters
    const pastBiomes = new Set(); // Rendered cells
    const processedClusters = new Set(); // Cluster IDs already drawn
    const clusterQueue = [startCluster]; // Queue of clusters to process
    
    // Process clusters in waves
    while (clusterQueue.length > 0) {
      const currentCluster = clusterQueue.shift();
      
      if (processedClusters.has(currentCluster.id)) {
        continue;
      }
      
      processedClusters.add(currentCluster.id);
      
      // Log cluster being drawn
      const biomeParams = this.biomeResolver.getParametersFromBiomeId(currentCluster.biomeId);
      const biomeColor = this.biomeResolver.getBiomeColor(currentCluster.biomeId);
      const colorHex = '#' + biomeColor.toString(16).padStart(6, '0').toUpperCase();
      
      console.log(`GlobalMapRenderer | Drawing cluster: %c${biomeParams.name}%c (ID: ${currentCluster.biomeId}, Cluster: ${currentCluster.id})`,
        `color: ${colorHex}; font-weight: bold;`,
        'color: inherit; font-weight: normal;');
      
      // Find neighboring cells not in pastBiomes
      const addBiome = new Set();
      const neighboringClusterIds = new Set();
      
      for (const idx of currentCluster.cluster) {
        const row = Math.floor(idx / cols);
        const col = idx % cols;
        
        // Check all 8 neighbors
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            
            const newRow = row + dr;
            const newCol = col + dc;
            
            if (newRow >= 0 && newRow < rows && newCol >= 0 && newCol < cols) {
              const neighborIdx = newRow * cols + newCol;
              
              // Find which cluster this neighbor belongs to
              if (biomeIds[neighborIdx] !== currentCluster.biomeId) {
                for (const otherCluster of allClusters) {
                  if (otherCluster.cluster.includes(neighborIdx) && !processedClusters.has(otherCluster.id)) {
                    neighboringClusterIds.add(otherCluster.id);
                    break;
                  }
                }
              }
              
              // Expand into unrendered cells
              if (!pastBiomes.has(neighborIdx)) {
                addBiome.add(neighborIdx);
              }
            }
          }
        }
      }
      
      // Combine cluster and expansion for drawing
      const drawBiome = [...currentCluster.cluster, ...Array.from(addBiome)];
      
      // Draw this cluster
      this._renderBiomeRegionLayered(drawBiome, rows, cols, bounds, cellSize, currentCluster.biomeId);
      
      // Mark cells as rendered
      for (const idx of currentCluster.cluster) {
        pastBiomes.add(idx);
      }
      
      // Add neighboring clusters to queue
      for (const neighborClusterId of neighboringClusterIds) {
        const neighborCluster = allClusters.find(c => c.id === neighborClusterId);
        if (neighborCluster && !clusterQueue.some(c => c.id === neighborClusterId)) {
          clusterQueue.push(neighborCluster);
        }
      }
    }
    
    // Process any remaining unprocessed clusters (disconnected regions)
    for (const cluster of allClusters) {
      if (!processedClusters.has(cluster.id)) {
        console.warn(`GlobalMapRenderer | Cluster ${cluster.id} was not connected, processing separately`);
        clusterQueue.push(cluster);
      }
    }
  }

  /**
   * Find connected clusters (components) in a set of cells
   * Uses flood-fill algorithm with 8-connectivity (including diagonals)
   * @private
   */
  _findConnectedClusters(cells, rows, cols) {
    if (cells.length === 0) return [];
    
    const cellSet = new Set(cells);
    const visited = new Set();
    const clusters = [];
    
    // Helper: Get 8 neighbors (including diagonals)
    const getNeighbors = (idx) => {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const neighbors = [];
      
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          
          const newRow = row + dr;
          const newCol = col + dc;
          
          if (newRow >= 0 && newRow < rows && newCol >= 0 && newCol < cols) {
            neighbors.push(newRow * cols + newCol);
          }
        }
      }
      
      return neighbors;
    };
    
    // Flood-fill to find each cluster
    for (const startIdx of cells) {
      if (visited.has(startIdx)) continue;
      
      // BFS to find all connected cells
      const cluster = [];
      const queue = [startIdx];
      visited.add(startIdx);
      
      while (queue.length > 0) {
        const idx = queue.shift();
        cluster.push(idx);
        
        // Check neighbors
        for (const neighborIdx of getNeighbors(idx)) {
          if (cellSet.has(neighborIdx) && !visited.has(neighborIdx)) {
            visited.add(neighborIdx);
            queue.push(neighborIdx);
          }
        }
      }
      
      clusters.push(cluster);
    }
    
    return clusters;
  }

  /**
   * Render a biome region using layered filling approach
   * Creates smooth contours using marching squares
   * @private
   */
  _renderBiomeRegionLayered(cellIndices, rows, cols, bounds, cellSize, biomeId) {
    if (cellIndices.length === 0) return;
    
    const color = this.biomeResolver.getBiomeColor(biomeId);
    
    // Create EXPANDED binary grid with padding (to handle edges correctly)
    // Add 1 cell padding on all sides filled with 0
    const paddedRows = rows + 2;
    const paddedCols = cols + 2;
    const paddedGrid = new Float32Array(paddedRows * paddedCols); // Default 0
    
    // Fill padded grid (offset by 1)
    for (const idx of cellIndices) {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const paddedIdx = (row + 1) * paddedCols + (col + 1);
      paddedGrid[paddedIdx] = 1.0;
    }
    
    // Adjust bounds for padded grid
    const paddedBounds = {
      minX: bounds.minX - cellSize,
      minY: bounds.minY - cellSize,
      maxX: bounds.maxX + cellSize,
      maxY: bounds.maxY + cellSize
    };
    
    // Use marching squares on padded grid
    const contourSegments = this._marchingSquares(paddedGrid, paddedRows, paddedCols, paddedBounds, cellSize, 0.5);

    if (contourSegments.length === 0) {
      return; // No boundaries for this biome
    }

    // Build contour paths from segments
    const contours = this._buildContourPaths(contourSegments);
    
    // Smooth contours using Chaikin's algorithm
    const smoothedContours = contours.map(path => this._smoothContour(path, 2));

    // Check if this biome has a pattern config
    const patternConfig = this.biomeResolver.getBiomePattern(biomeId);

    if (patternConfig) {
      // Draw with pattern using config
      this._drawBiomeWithPattern(smoothedContours, color, bounds, cellSize, biomeId, patternConfig);
    } else {
      // Draw filled regions (default behavior)
      const graphics = new PIXI.Graphics();
      graphics.beginFill(color, 1.0);
      this._drawContoursWithHoles(graphics, smoothedContours);
      graphics.endFill();

      this.mapLayer.addChild(graphics);
    }
  }

  /**
   * Draw biome region with pattern instead of solid fill
   * @private
   */
  _drawBiomeWithPattern(smoothedContours, color, bounds, cellSize, biomeId, patternConfig) {
    // 1. Сначала рисуем заливку основным цветом
    const baseGraphics = new PIXI.Graphics();
    baseGraphics.beginFill(color, 1.0);
    this._drawContoursWithHoles(baseGraphics, smoothedContours);
    baseGraphics.endFill();
    this.mapLayer.addChild(baseGraphics);
    
    // 2. Вычисляем реальный bounding box биома из контуров
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const contour of smoothedContours) {
      for (const point of contour) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
    }
    const biomeBounds = { minX, minY, maxX, maxY };
    
    // 3. Создаём контейнер для паттерна с маской
    const patternContainer = new PIXI.Container();
    
    // 4. Маска для паттерна (та же форма биома)
    const mask = new PIXI.Graphics();
    mask.beginFill(0xFFFFFF);
    this._drawContoursWithHoles(mask, smoothedContours);
    mask.endFill();
    
    // 5. Рисуем паттерн согласно конфигурации
    const pattern = new PIXI.Graphics();
    
    // Извлекаем параметры из конфига с значениями по умолчанию
    const darkenFactor = patternConfig.darkenFactor ?? 0.4;
    const opacity = patternConfig.opacity ?? 0.9;
    const spacing = patternConfig.spacing ?? 2.0;
    const lineWidth = patternConfig.lineWidth ?? 0.6;
    
    // Определяем цвет паттерна: используем кастомный цвет, если указан, иначе затемняем основной
    let patternColor;
    if (patternConfig.patternColor) {
      // Кастомный цвет из конфига (hex-строка)
      patternColor = parseInt(patternConfig.patternColor, 16);
    } else {
      // Затемнённый основной цвет биома
      patternColor = this._darkenColor(color, darkenFactor);
    }
    
    // Выбираем тип паттерна (используем biomeBounds вместо bounds всей карты)
    switch (patternConfig.type) {
      case 'circles':
        this._drawConcentricCirclesPattern(pattern, smoothedContours, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'diagonal':
        this._drawDiagonalLinesPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'crosshatch':
        this._drawCrosshatchPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'vertical':
        this._drawVerticalLinesPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'horizontal':
        this._drawHorizontalLinesPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'dots':
        this._drawDotsPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'waves':
        this._drawWavesPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'hexagons':
        this._drawHexagonsPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'spots':
        this._drawRandomSpotsPattern(pattern, smoothedContours, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity, biomeId);
        break;
      default:
        // По умолчанию - диагональные линии
        this._drawDiagonalLinesPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
    }
    
    // 6. Применяем маску к паттерну
    pattern.mask = mask;
    
    // 7. Добавляем всё на сцену
    patternContainer.addChild(mask);
    patternContainer.addChild(pattern);
    this.mapLayer.addChild(patternContainer);
  }

  /**
   * Draw diagonal lines pattern
   * @private
   */
  _drawDiagonalLinesPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.6, opacity = 0.9) {
    const spacing = cellSize * spacingMultiplier;
    const lineWidth = Math.max(6, cellSize * lineWidthMultiplier);
    const mapWidth = bounds.maxX - bounds.minX;
    const mapHeight = bounds.maxY - bounds.minY;
    const diagonal = Math.sqrt(mapWidth ** 2 + mapHeight ** 2);
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    // Рисуем диагональные линии (\) сверху-слева вниз-вправо
    // Начинаем с верхнего левого угла, идём по диагонали вправо-вниз
    for (let offset = -diagonal; offset < diagonal * 2; offset += spacing) {
      // Линия начинается либо на левой границе, либо на верхней
      const startX = bounds.minX;
      const startY = bounds.minY + offset;
      
      // Линия заканчивается либо на правой границе, либо на нижней
      const endX = bounds.minX + diagonal;
      const endY = bounds.minY + offset - diagonal;
      
      graphics.moveTo(startX, startY);
      graphics.lineTo(endX, endY);
    }
  }

  /**
   * Draw concentric circles pattern
   * @private
   */
  _drawConcentricCirclesPattern(graphics, contours, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.4, opacity = 0.9) {
    // Находим центр области биома
    let sumX = 0, sumY = 0, pointCount = 0;
    for (const contour of contours) {
      for (const point of contour) {
        sumX += point.x;
        sumY += point.y;
        pointCount++;
      }
    }
    
    if (pointCount === 0) return;
    
    const centerX = sumX / pointCount;
    const centerY = sumY / pointCount;
    
    // Находим максимальное расстояние от центра до границы
    let maxDistance = 0;
    for (const contour of contours) {
      for (const point of contour) {
        const dist = Math.sqrt((point.x - centerX) ** 2 + (point.y - centerY) ** 2);
        if (dist > maxDistance) maxDistance = dist;
      }
    }
    
    // Рисуем концентрические круги
    const spacing = cellSize * spacingMultiplier;
    const lineWidth = Math.max(4, cellSize * lineWidthMultiplier);
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    for (let radius = spacing; radius <= maxDistance + spacing; radius += spacing) {
      graphics.drawCircle(centerX, centerY, radius);
    }
  }

  /**
   * Draw crosshatch pattern (diagonal lines in both directions)
   * @private
   */
  _drawCrosshatchPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.6, opacity = 0.9) {
    // Рисуем диагональные линии в обе стороны
    const spacing = cellSize * spacingMultiplier;
    const lineWidth = Math.max(3, cellSize * lineWidthMultiplier * 0.5); // Тоньше для сетки
    const mapWidth = bounds.maxX - bounds.minX;
    const mapHeight = bounds.maxY - bounds.minY;
    const diagonal = Math.sqrt(mapWidth ** 2 + mapHeight ** 2);
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    // Линии в одну сторону (\) - сверху-слева вниз-вправо
    for (let offset = -diagonal; offset < diagonal * 2; offset += spacing) {
      const startX = bounds.minX;
      const startY = bounds.minY + offset;
      const endX = bounds.minX + diagonal;
      const endY = bounds.minY + offset - diagonal;
      
      graphics.moveTo(startX, startY);
      graphics.lineTo(endX, endY);
    }
    
    // Линии в другую сторону (/) - снизу-слева вверх-вправо
    for (let offset = -diagonal; offset < diagonal * 2; offset += spacing) {
      const startX = bounds.minX;
      const startY = bounds.maxY - offset;
      const endX = bounds.minX + diagonal;
      const endY = bounds.maxY - offset + diagonal;
      
      graphics.moveTo(startX, startY);
      graphics.lineTo(endX, endY);
    }
  }

  /**
   * Draw vertical lines pattern
   * @private
   */
  _drawVerticalLinesPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.6, opacity = 0.9) {
    const spacing = cellSize * spacingMultiplier;
    const lineWidth = Math.max(6, cellSize * lineWidthMultiplier);
    const mapWidth = bounds.maxX - bounds.minX;
    const mapHeight = bounds.maxY - bounds.minY;
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    for (let x = bounds.minX; x <= bounds.maxX; x += spacing) {
      graphics.moveTo(x, bounds.minY);
      graphics.lineTo(x, bounds.maxY);
    }
  }

  /**
   * Draw horizontal lines pattern
   * @private
   */
  _drawHorizontalLinesPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.6, opacity = 0.9) {
    const spacing = cellSize * spacingMultiplier;
    const lineWidth = Math.max(6, cellSize * lineWidthMultiplier);
    const mapWidth = bounds.maxX - bounds.minX;
    const mapHeight = bounds.maxY - bounds.minY;
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    for (let y = bounds.minY; y <= bounds.maxY; y += spacing) {
      graphics.moveTo(bounds.minX, y);
      graphics.lineTo(bounds.maxX, y);
    }
  }

  /**
   * Draw dots pattern
   * @private
   */
  _drawDotsPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.4, opacity = 0.9) {
    const spacing = cellSize * spacingMultiplier;
    const dotRadius = Math.max(2, cellSize * lineWidthMultiplier);
    
    graphics.beginFill(color, opacity);
    
    for (let y = bounds.minY; y <= bounds.maxY; y += spacing) {
      for (let x = bounds.minX; x <= bounds.maxX; x += spacing) {
        graphics.drawCircle(x, y, dotRadius);
      }
    }
    
    graphics.endFill();
  }

  /**
   * Draw waves pattern
   * @private
   */
  _drawWavesPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.6, opacity = 0.9) {
    const spacing = cellSize * spacingMultiplier;
    const lineWidth = Math.max(3, cellSize * lineWidthMultiplier);
    const waveHeight = cellSize * spacingMultiplier * 0.25; // Уменьшили амплитуду с 0.5 до 0.25
    const waveLength = cellSize * 4;
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    const mapWidth = bounds.maxX - bounds.minX;
    const step = cellSize * 0.5; // Меньший шаг для более плавных волн
    
    for (let y = bounds.minY; y <= bounds.maxY; y += spacing) {
      let firstPoint = true;
      
      for (let x = bounds.minX; x <= bounds.maxX + step; x += step) {
        const phase = (x - bounds.minX) / waveLength * Math.PI * 2;
        const waveY = y + Math.sin(phase) * waveHeight;
        
        if (firstPoint) {
          graphics.moveTo(x, waveY);
          firstPoint = false;
        } else {
          graphics.lineTo(x, waveY);
        }
      }
    }
  }

  /**
   * Draw hexagons pattern
   * @private
   */
  _drawHexagonsPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.3, opacity = 0.9) {
    const hexSize = cellSize * spacingMultiplier;
    const lineWidth = Math.max(2, cellSize * lineWidthMultiplier);
    const hexWidth = hexSize * 2;
    const hexHeight = Math.sqrt(3) * hexSize;
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    // Рисуем шестиугольники в шахматном порядке
    for (let row = 0; row * hexHeight <= bounds.maxY - bounds.minY + hexHeight; row++) {
      for (let col = 0; col * hexWidth * 0.75 <= bounds.maxX - bounds.minX + hexWidth; col++) {
        const x = bounds.minX + col * hexWidth * 0.75;
        const y = bounds.minY + row * hexHeight + (col % 2) * hexHeight / 2;
        
        this._drawHexagon(graphics, x, y, hexSize);
      }
    }
  }

  /**
   * Draw random spots pattern
   * @private
   */
  _drawRandomSpotsPattern(graphics, contours, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.4, opacity = 0.9, seed = 0) {
    const spacing = cellSize * spacingMultiplier;
    const minRadius = Math.max(2, cellSize * lineWidthMultiplier * 0.5);
    const maxRadius = Math.max(4, cellSize * lineWidthMultiplier * 1.5);
    
    // Простой генератор псевдослучайных чисел с seed
    let random = seed + 12345;
    const seededRandom = () => {
      random = (random * 9301 + 49297) % 233280;
      return random / 233280;
    };
    
    graphics.beginFill(color, opacity);
    
    // Генерируем пятна на сетке с небольшим смещением
    for (let y = bounds.minY; y <= bounds.maxY; y += spacing) {
      for (let x = bounds.minX; x <= bounds.maxX; x += spacing) {
        // Смещение от сетки
        const offsetX = (seededRandom() - 0.5) * spacing * 0.8;
        const offsetY = (seededRandom() - 0.5) * spacing * 0.8;
        
        // Случайный размер пятна
        const radius = minRadius + seededRandom() * (maxRadius - minRadius);
        
        // Иногда пропускаем пятно для разнообразия
        if (seededRandom() > 0.3) {
          graphics.drawCircle(x + offsetX, y + offsetY, radius);
        }
      }
    }
    
    graphics.endFill();
  }

  /**
   * Draw a single hexagon
   * @private
   */
  _drawHexagon(graphics, centerX, centerY, size) {
    const angles = [0, 60, 120, 180, 240, 300];
    
    graphics.moveTo(
      centerX + size * Math.cos(0),
      centerY + size * Math.sin(0)
    );
    
    for (const angle of angles) {
      const rad = (angle * Math.PI) / 180;
      graphics.lineTo(
        centerX + size * Math.cos(rad),
        centerY + size * Math.sin(rad)
      );
    }
    
    graphics.closePath();
  }

  /**
   * Check if biome cluster touches any edge of the map
   * @private
   */
  _checkBiomeTouchesEdge(cellIndices, rows, cols) {
    for (const idx of cellIndices) {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      
      // Check if on any edge
      if (row === 0 || row === rows - 1 || col === 0 || col === cols - 1) {
        return true;
      }
    }
    return false;
  }

  /**
   * Add explicit boundary paths along map edges for biomes that touch them
   * @private
   */
  _addEdgeBoundaries(contours, cellIndices, rows, cols, bounds, cellSize) {
    // Find cells on each edge
    const topEdge = [];
    const bottomEdge = [];
    const leftEdge = [];
    const rightEdge = [];
    
    for (const idx of cellIndices) {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      
      if (row === 0) topEdge.push(col);
      if (row === rows - 1) bottomEdge.push(col);
      if (col === 0) leftEdge.push(row);
      if (col === cols - 1) rightEdge.push(row);
    }
    
    // Sort edges
    topEdge.sort((a, b) => a - b);
    bottomEdge.sort((a, b) => a - b);
    leftEdge.sort((a, b) => a - b);
    rightEdge.sort((a, b) => a - b);
    
    // Add edge paths to contours
    if (topEdge.length > 0) {
      const path = [];
      for (const col of topEdge) {
        const x = bounds.minX + col * cellSize;
        const y = bounds.minY;
        path.push({ x, y });
        path.push({ x: x + cellSize, y });
      }
      if (path.length > 0) contours.push(path);
    }
    
    if (bottomEdge.length > 0) {
      const path = [];
      for (const col of bottomEdge) {
        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + rows * cellSize;
        path.push({ x, y });
        path.push({ x: x + cellSize, y });
      }
      if (path.length > 0) contours.push(path);
    }
    
    if (leftEdge.length > 0) {
      const path = [];
      for (const row of leftEdge) {
        const x = bounds.minX;
        const y = bounds.minY + row * cellSize;
        path.push({ x, y });
        path.push({ x, y: y + cellSize });
      }
      if (path.length > 0) contours.push(path);
    }
    
    if (rightEdge.length > 0) {
      const path = [];
      for (const row of rightEdge) {
        const x = bounds.minX + cols * cellSize;
        const y = bounds.minY + row * cellSize;
        path.push({ x, y });
        path.push({ x, y: y + cellSize });
      }
      if (path.length > 0) contours.push(path);
    }
  }

  /**
   * Draw smooth borders between different biomes
   * @private
   */
  _drawBiomeBorders(biomeIds, rows, cols, bounds, cellSize, uniqueBiomes) {
    // For each unique biome, draw its borders
    for (const biomeId of uniqueBiomes) {
      this._drawBiomeBorder(biomeIds, rows, cols, bounds, cellSize, biomeId);
    }
  }

  /**
   * Draw border for a single biome using marching squares
   * @private
   */
  _drawBiomeBorder(biomeIds, rows, cols, bounds, cellSize, targetBiomeId) {
    // Create binary grid for this biome (1 = this biome, 0 = other)
    const binaryGrid = new Float32Array(rows * cols);
    for (let i = 0; i < biomeIds.length; i++) {
      binaryGrid[i] = biomeIds[i] === targetBiomeId ? 1.0 : 0.0;
    }

    // Use marching squares to find contours at threshold 0.5
    const contourSegments = this._marchingSquares(binaryGrid, rows, cols, bounds, cellSize, 0.5);

    if (contourSegments.length === 0) {
      return; // No boundaries for this biome
    }

    // Build and smooth contour paths
    const contours = this._buildContourPaths(contourSegments);
    const smoothedContours = contours.map(path => this._smoothContour(path, 2));

    // Draw border lines (not filled regions)
    const graphics = new PIXI.Graphics();
    const color = this.biomeResolver.getBiomeColor(targetBiomeId);
    
    // Draw darker border line
    graphics.lineStyle(1.5, this._darkenColor(color, 0.3), 0.6);
    for (const contour of smoothedContours) {
      if (contour.length < 3) continue;

      graphics.moveTo(contour[0].x, contour[0].y);
      for (let i = 1; i < contour.length; i++) {
        graphics.lineTo(contour[i].x, contour[i].y);
      }
      graphics.closePath();
    }

    this.mapLayer.addChild(graphics);
  }

  /**
   * Darken a color by a factor
   * @private
   */
  _darkenColor(color, factor) {
    const r = (color >> 16) & 0xFF;
    const g = (color >> 8) & 0xFF;
    const b = color & 0xFF;
    
    const newR = Math.floor(r * (1 - factor));
    const newG = Math.floor(g * (1 - factor));
    const newB = Math.floor(b * (1 - factor));
    
    return (newR << 16) | (newG << 8) | newB;
  }

  /**
   * Render a single biome region with smooth boundaries
   * @private
   */
  _renderBiomeRegion(biomeIds, rows, cols, bounds, cellSize, targetBiomeId, color) {
    const graphics = new PIXI.Graphics();

    // Create binary grid for this biome (1 = this biome, 0 = other)
    const binaryGrid = new Float32Array(rows * cols);
    for (let i = 0; i < biomeIds.length; i++) {
      binaryGrid[i] = biomeIds[i] === targetBiomeId ? 1.0 : 0.0;
    }

    // Use marching squares to find contours at threshold 0.5
    const contourSegments = this._marchingSquares(binaryGrid, rows, cols, bounds, cellSize, 0.5);

    if (contourSegments.length === 0) {
      return; // No boundaries for this biome
    }

    // 3. Build contour paths from segments
    const contours = this._buildContourPaths(contourSegments);

    // 4. Smooth contours using Chaikin's algorithm
    const smoothedContours = contours.map(path => this._smoothContour(path, 2));

    // 5. Draw filled regions
    graphics.beginFill(color, 1.0);
    for (const contour of smoothedContours) {
      if (contour.length < 3) continue;

      graphics.moveTo(contour[0].x, contour[0].y);
      for (let i = 1; i < contour.length; i++) {
        graphics.lineTo(contour[i].x, contour[i].y);
      }
      graphics.closePath();
    }
    graphics.endFill();

    this.mapLayer.addChild(graphics);
  }

  /**
   * Build contour paths from disconnected segments
   * Connects segments into closed loops
   * @private
   */
  _buildContourPaths(segments) {
    if (segments.length === 0) return [];

    const paths = [];
    const used = new Set();
    const epsilon = 0.1; // Tolerance for point matching

    const pointsEqual = (p1, p2) => {
      return Math.abs(p1.x - p2.x) < epsilon && Math.abs(p1.y - p2.y) < epsilon;
    };

    for (let i = 0; i < segments.length; i++) {
      if (used.has(i)) continue;

      const path = [segments[i][0], segments[i][1]];
      used.add(i);

      // Try to extend path by finding connecting segments
      let extended = true;
      while (extended) {
        extended = false;

        for (let j = 0; j < segments.length; j++) {
          if (used.has(j)) continue;

          const lastPoint = path[path.length - 1];
          const seg = segments[j];

          // Check if segment connects to end of path
          if (pointsEqual(lastPoint, seg[0])) {
            path.push(seg[1]);
            used.add(j);
            extended = true;
            break;
          } else if (pointsEqual(lastPoint, seg[1])) {
            path.push(seg[0]);
            used.add(j);
            extended = true;
            break;
          }
        }
      }

      paths.push(path);
    }

    return paths;
  }

  /**
   * Smooth contour using Chaikin's corner-cutting algorithm
   * @private
   */
  _smoothContour(points, iterations = 2) {
    if (points.length < 3) return points;

    let smoothed = [...points];

    for (let iter = 0; iter < iterations; iter++) {
      const newPoints = [];

      for (let i = 0; i < smoothed.length; i++) {
        const p0 = smoothed[i];
        const p1 = smoothed[(i + 1) % smoothed.length];

        // Create two new points at 1/4 and 3/4 along the segment
        newPoints.push({
          x: 0.75 * p0.x + 0.25 * p1.x,
          y: 0.75 * p0.y + 0.25 * p1.y
        });
        newPoints.push({
          x: 0.25 * p0.x + 0.75 * p1.x,
          y: 0.25 * p0.y + 0.75 * p1.y
        });
      }

      smoothed = newPoints;
    }

    return smoothed;
  }

  /**
   * Draw contour paths to Graphics, preserving holes (nested contours).
   * Fixes cases when a biome fully surrounds another biome and would otherwise fill over it.
   * @private
   */
  _drawContoursWithHoles(graphics, contours) {
    if (!graphics || !contours || contours.length === 0) return;

    const validContours = contours.filter(c => c && c.length >= 3);
    if (validContours.length === 0) return;

    if (validContours.length === 1) {
      this._drawContourPath(graphics, validContours[0]);
      return;
    }

    // PIXI hole shapes must be defined immediately after the shape they cut.
    // So we must group holes by their parent contour (not just rely on depth ordering).
    const hierarchy = this._buildContourHierarchy(validContours);

    // Build children lists for hierarchy traversal
    const children = hierarchy.map(() => []);
    for (let i = 0; i < hierarchy.length; i++) {
      const p = hierarchy[i].parent;
      if (p !== -1) {
        children[p].push(i);
      }
    }

    // Deterministic ordering: larger roots first; smaller holes first
    for (let i = 0; i < children.length; i++) {
      children[i].sort((a, b) => hierarchy[a].area - hierarchy[b].area);
    }

    const roots = [];
    for (let i = 0; i < hierarchy.length; i++) {
      if (hierarchy[i].parent === -1) {
        roots.push(i);
      }
    }
    roots.sort((a, b) => hierarchy[b].area - hierarchy[a].area);

    const drawSolidWithHoles = (idx) => {
      const contour = hierarchy[idx]?.contour;
      if (!contour || contour.length < 3) return;

      // Draw the solid contour
      this._drawContourPath(graphics, contour);

      // Punch direct children as holes
      const holeIndices = children[idx] || [];
      for (const holeIdx of holeIndices) {
        const holeContour = hierarchy[holeIdx]?.contour;
        if (!holeContour || holeContour.length < 3) continue;

        graphics.beginHole();
        this._drawContourPath(graphics, holeContour);
        graphics.endHole();
      }

      // Draw islands inside each hole (grandchildren), recursively
      for (const holeIdx of holeIndices) {
        const islandIndices = children[holeIdx] || [];
        for (const islandIdx of islandIndices) {
          drawSolidWithHoles(islandIdx);
        }
      }
    };

    for (const rootIdx of roots) {
      drawSolidWithHoles(rootIdx);
    }
  }

  /**
   * Draw a single closed contour path.
   * @private
   */
  _drawContourPath(graphics, contour) {
    graphics.moveTo(contour[0].x, contour[0].y);
    for (let i = 1; i < contour.length; i++) {
      graphics.lineTo(contour[i].x, contour[i].y);
    }
    graphics.closePath();
  }

  /**
   * Build contour hierarchy (nesting) to identify holes.
   * @private
   */
  _buildContourHierarchy(contours) {
    const items = contours.map(contour => ({
      contour,
      parent: -1,
      area: this._calculatePolygonArea(contour),
      bounds: this._getContourBounds(contour)
    }));

    const eps = 0.5;
    const boundsContain = (outer, inner) => {
      return inner.minX >= outer.minX - eps &&
        inner.minY >= outer.minY - eps &&
        inner.maxX <= outer.maxX + eps &&
        inner.maxY <= outer.maxY + eps;
    };

    for (let i = 0; i < items.length; i++) {
      let parent = -1;
      let minArea = Infinity;

      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;

        // Parent must be larger than child
        if (items[j].area <= items[i].area) continue;
        if (!boundsContain(items[j].bounds, items[i].bounds)) continue;

        if (this._isContourInsideContour(items[i].contour, items[j].contour)) {
          if (items[j].area < minArea) {
            minArea = items[j].area;
            parent = j;
          }
        }
      }

      items[i].parent = parent;
    }

    return items;
  }

  /**
   * Compute bounds of a contour.
   * @private
   */
  _getContourBounds(contour) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const p of contour) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    return { minX, minY, maxX, maxY };
  }

  /**
   * Calculate polygon area (absolute).
   * @private
   */
  _calculatePolygonArea(polygon) {
    if (!polygon || polygon.length < 3) return 0;

    let area = 0;
    for (let i = 0; i < polygon.length; i++) {
      const j = (i + 1) % polygon.length;
      area += polygon[i].x * polygon[j].y;
      area -= polygon[j].x * polygon[i].y;
    }

    return Math.abs(area / 2);
  }

  /**
   * Check whether contour A is inside contour B.
   * @private
   */
  _isContourInsideContour(contourA, contourB) {
    const sampleCount = Math.min(5, contourA.length);
    for (let i = 0; i < sampleCount; i++) {
      if (!this._isPointInPolygonInclusive(contourA[i], contourB)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Point-in-polygon test (ray casting), treating boundary points as inside.
   * @private
   */
  _isPointInPolygonInclusive(point, polygon, epsilon = 0.5) {
    if (!point || !polygon || polygon.length < 3) return false;

    // Boundary check (needed because contours may share borders exactly)
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      if (this._isPointOnSegment(point, polygon[j], polygon[i], epsilon)) return true;
    }

    // Ray casting
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;

      const intersect = ((yi > point.y) !== (yj > point.y))
        && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);

      if (intersect) inside = !inside;
    }

    return inside;
  }

  /**
   * Check if point lies on segment AB within epsilon.
   * @private
   */
  _isPointOnSegment(point, a, b, epsilon = 0.5) {
    const px = point.x;
    const py = point.y;
    const ax = a.x;
    const ay = a.y;
    const bx = b.x;
    const by = b.y;

    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;

    const abLenSq = abx * abx + aby * aby;
    const epsSq = epsilon * epsilon;

    // Degenerate segment
    if (abLenSq === 0) {
      const dx = px - ax;
      const dy = py - ay;
      return dx * dx + dy * dy <= epsSq;
    }

    const t = (apx * abx + apy * aby) / abLenSq;
    if (t < 0 || t > 1) return false;

    const closestX = ax + t * abx;
    const closestY = ay + t * aby;
    const dx = px - closestX;
    const dy = py - closestY;

    return dx * dx + dy * dy <= epsSq;
  }

  /**
   * Render biomes as simple colored cells
   * @private
   */
  _renderBiomesCells(gridData, metadata) {
    const { biomes, moisture, temperature, heights, rows, cols } = gridData;
    const { cellSize, bounds } = metadata;

    console.log('GlobalMapRenderer | Rendering biomes as cells...');
    const graphics = new PIXI.Graphics();

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;

        const biomeId = (biomes && biomes.length === rows * cols)
          ? biomes[idx]
          : this.biomeResolver.getBiomeId(moisture?.[idx] ?? 0, temperature?.[idx] ?? 0);

        const color = this.biomeResolver.getBiomeColor(biomeId);

        // IMPORTANT: the unified grid is treated as samples at cell *centers*.
        // When drawing a rect per sample, we center it on the sample point ⇒ shift by half a cell.
        const x = bounds.minX + col * cellSize - cellSize / 2;
        const y = bounds.minY + row * cellSize - cellSize / 2;

        graphics.beginFill(color, 1.0);
        graphics.drawRect(x, y, cellSize, cellSize);
        graphics.endFill();
      }
    }

    this.mapLayer.addChild(graphics);
  }

  /**
   * Render height contours (black and white)
   * @private
   */
  _renderHeightContoursBW(gridData, metadata) {
    const { heights, rows, cols } = gridData;
    const { cellSize, bounds, heightStats } = metadata;

    // Create contour levels (20 levels for better detail)
    const minHeight = heightStats.min;
    const maxHeight = heightStats.max;
    const range = maxHeight - minHeight;

    // Skip if flat map
    if (range < 0.1) {
      console.log('GlobalMapRenderer | Skipping height contours (flat map)');
      return;
    }

    const levels = [];
    for (let i = 1; i <= 20; i++) {
      const level = minHeight + (range * i / 20);
      levels.push({ level });
    }

    // Draw contours for each level (all black)
    for (const levelInfo of levels) {
      const segments = this._marchingSquares(heights, rows, cols, bounds, cellSize, levelInfo.level);
      this._drawContourSegmentsBW(segments, heights, rows, cols, bounds, cellSize);
    }
  }

  /**
   * Render height contours (colored)
   * @private
   */
  _renderHeightContours(gridData, metadata) {
    const { heights, rows, cols } = gridData;
    const { cellSize, bounds, heightStats } = metadata;

    // Create contour levels (20 levels for better detail)
    const minHeight = heightStats.min;
    const maxHeight = heightStats.max;
    const range = maxHeight - minHeight;

    // Skip if flat map
    if (range < 0.1) {
      console.log('GlobalMapRenderer | Skipping height contours (flat map)');
      return;
    }

    const levels = [];
    for (let i = 1; i <= 20; i++) {
      const level = minHeight + (range * i / 20);
      levels.push({
        level,
        color: this._heightToColor(i / 20),
      });
    }

    // Draw contours for each level
    for (const levelInfo of levels) {
      const segments = this._marchingSquares(heights, rows, cols, bounds, cellSize, levelInfo.level);
      this._drawContourSegments(segments, levelInfo.color, heights, rows, cols, bounds, cellSize);
    }
  }

  /**
   * Render heights as colored cells
   * @private
   */
  _renderHeightCells(gridData, metadata) {
    const { heights, rows, cols } = gridData;
    const { cellSize, bounds, heightStats } = metadata;

    const graphics = new PIXI.Graphics();

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        const height = heights[idx];
        
        const normalized = this._normalizeValue(height, heightStats.min, heightStats.max);
        const color = this._heightToColor(normalized);
        
        // Draw cell centered at coordinate point (shift by half cell)
        const x = bounds.minX + col * cellSize - cellSize / 2;
        const y = bounds.minY + row * cellSize - cellSize / 2;
        
        graphics.beginFill(color, 0.7);
        graphics.drawRect(x, y, cellSize, cellSize);
        graphics.endFill();
      }
    }

    this.mapLayer.addChild(graphics);
  }

  /**
   * Render biomes as colored cells (base layer)
   * Dynamically determines biome from moisture/temperature
   * @private
   */
  _renderBiomesBase(gridData, metadata) {
    const { moisture, temperature, heights, rows, cols } = gridData;
    const { cellSize, bounds } = metadata;

    if (!moisture || !temperature || !this.showBiomes) {
      return;
    }

    // Check if there are any biomes to render
    const hasBiomes = moisture.some(m => m > 0) && temperature.some(t => t > 0);
    if (!hasBiomes) {
      console.log('GlobalMapRenderer | No biomes to render');
      return;
    }

    console.log('GlobalMapRenderer | Rendering biome base layer (dynamic)...');
    const graphics = new PIXI.Graphics();

    // Render biome cells
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        
        const moistureVal = moisture[idx];
        const temperatureVal = temperature[idx];
        const height = heights[idx];

        // Dynamically determine biome ID from moisture/temperature/height
        const biomeId = this.biomeResolver.getBiomeId(moistureVal, temperatureVal, height);

        // Draw cell centered at coordinate point (shift by half cell)
        const x = bounds.minX + col * cellSize - cellSize / 2;
        const y = bounds.minY + row * cellSize - cellSize / 2;

        // Get biome color
        const color = this.biomeResolver.getBiomeColor(biomeId);
        const alpha = 1.0; // Fully opaque

        graphics.beginFill(color, alpha);
        graphics.drawRect(x, y, cellSize, cellSize);
        graphics.endFill();
      }
    }

    this.mapLayer.addChild(graphics);
    console.log('GlobalMapRenderer | ✓ Biome base layer rendered');
  }

  /**
   * Render as contour lines using marching squares
   * @private
   */
  _renderContours(gridData, metadata) {
    const { heights, rows, cols } = gridData;
    const { cellSize, bounds, heightStats } = metadata;

    // First, render biomes as base layer with smooth boundaries
    this._renderBiomesSmooth(gridData, metadata);

    // Then render contour lines on top
    // Create contour levels (20 levels for better detail)
    const minHeight = heightStats.min;
    const maxHeight = heightStats.max;
    const range = maxHeight - minHeight;

    const levels = [];
    for (let i = 1; i <= 20; i++) {
      const level = minHeight + (range * i / 20);
      levels.push({
        level,
        color: this._heightToColor(i / 20),
      });
    }

    // Draw contours for each level
    for (const levelInfo of levels) {
      const segments = this._marchingSquares(heights, rows, cols, bounds, cellSize, levelInfo.level);
      this._drawContourSegments(segments, levelInfo.color, heights, rows, cols, bounds, cellSize);
    }
  }

  /**
   * Marching squares algorithm to extract contour segments
   * @private
   */
  _marchingSquares(heights, rows, cols, bounds, cellSize, threshold) {
    const segments = [];

    for (let row = 0; row < rows - 1; row++) {
      for (let col = 0; col < cols - 1; col++) {
        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + row * cellSize;

        // Get corner values
        const v00 = heights[row * cols + col];
        const v10 = heights[row * cols + (col + 1)];
        const v01 = heights[(row + 1) * cols + col];
        const v11 = heights[(row + 1) * cols + (col + 1)];

        // Calculate case
        let caseValue = 0;
        if (v00 >= threshold) caseValue |= 1;
        if (v10 >= threshold) caseValue |= 2;
        if (v11 >= threshold) caseValue |= 4;
        if (v01 >= threshold) caseValue |= 8;

        // Get segments for this case
        const segs = this._getMarchingSquaresSegments(caseValue, x, y, cellSize, v00, v10, v01, v11, threshold);
        segments.push(...segs);
      }
    }

    return segments;
  }

  /**
   * Get line segments for marching squares case
   * @private
   */
  _getMarchingSquaresSegments(caseValue, x, y, size, v00, v10, v01, v11, threshold) {
    const segments = [];

    const lerp = (v1, v2) => {
      if (Math.abs(v2 - v1) < 0.0001) return 0.5;
      return (threshold - v1) / (v2 - v1);
    };

    const edges = {
      top: { x: x + size * lerp(v00, v10), y },
      right: { x: x + size, y: y + size * lerp(v10, v11) },
      bottom: { x: x + size * lerp(v01, v11), y: y + size },
      left: { x, y: y + size * lerp(v00, v01) },
    };

    switch (caseValue) {
      case 1: segments.push([edges.left, edges.top]); break;
      case 2: segments.push([edges.top, edges.right]); break;
      case 3: segments.push([edges.left, edges.right]); break;
      case 4: segments.push([edges.right, edges.bottom]); break;
      case 5:
        segments.push([edges.left, edges.top]);
        segments.push([edges.right, edges.bottom]);
        break;
      case 6: segments.push([edges.top, edges.bottom]); break;
      case 7: segments.push([edges.left, edges.bottom]); break;
      case 8: segments.push([edges.bottom, edges.left]); break;
      case 9: segments.push([edges.bottom, edges.top]); break;
      case 10:
        segments.push([edges.top, edges.right]);
        segments.push([edges.bottom, edges.left]);
        break;
      case 11: segments.push([edges.bottom, edges.right]); break;
      case 12: segments.push([edges.right, edges.left]); break;
      case 13: segments.push([edges.right, edges.top]); break;
      case 14: segments.push([edges.top, edges.left]); break;
    }

    return segments;
  }

  /**
   * Draw contour line segments (black only)
   * @private
   */
  _drawContourSegmentsBW(segments, heights, rows, cols, bounds, cellSize) {
    if (segments.length === 0) return;

    const graphics = new PIXI.Graphics();

    const baseAlpha = Number.isFinite(this.heightContourAlpha) ? this.heightContourAlpha : 0.8;
    const lineAlpha = Math.max(0, Math.min(1, baseAlpha));

    // Draw black contour lines
    graphics.lineStyle(1.5, 0x000000, lineAlpha);
    for (const segment of segments) {
      graphics.moveTo(segment[0].x, segment[0].y);
      graphics.lineTo(segment[1].x, segment[1].y);
    }

    // Draw slope direction marks (hachures)
    this._drawSlopeMarks(graphics, segments, heights, rows, cols, bounds, cellSize, 0x000000);

    this.mapLayer.addChild(graphics);
  }

  /**
   * Draw contour line segments with outline and slope direction marks (colored)
   * @private
   */
  _drawContourSegments(segments, color, heights, rows, cols, bounds, cellSize) {
    if (segments.length === 0) return;

    const graphics = new PIXI.Graphics();

    // Keep the same default look as before (line=0.8, outline=0.6), but allow tuning via slider.
    const baseAlpha = Number.isFinite(this.heightContourAlpha) ? this.heightContourAlpha : 0.8;
    const lineAlpha = Math.max(0, Math.min(1, baseAlpha));
    const outlineAlpha = Math.max(0, Math.min(1, lineAlpha * 0.75));

    // Draw black outline first (for better visibility)
    graphics.lineStyle(2, 0x000000, outlineAlpha);
    for (const segment of segments) {
      graphics.moveTo(segment[0].x, segment[0].y);
      graphics.lineTo(segment[1].x, segment[1].y);
    }

    // Draw colored contour lines
    graphics.lineStyle(1, color, lineAlpha);
    for (const segment of segments) {
      graphics.moveTo(segment[0].x, segment[0].y);
      graphics.lineTo(segment[1].x, segment[1].y);
    }

    // Draw slope direction marks (hachures)
    this._drawSlopeMarks(graphics, segments, heights, rows, cols, bounds, cellSize, color);

    this.mapLayer.addChild(graphics);
  }

  /**
   * Draw short lines indicating downslope direction
   * @private
   */
  _drawSlopeMarks(graphics, segments, heightValues, rows, cols, bounds, cellSize, color) {
    const hachureLength = 4;
    const hachureSpacing = 25;

    const baseAlpha = Number.isFinite(this.heightContourAlpha) ? this.heightContourAlpha : 0.8;
    const lineAlpha = Math.max(0, Math.min(1, baseAlpha));
    const markAlpha = Math.max(0, Math.min(1, lineAlpha * 0.875));

    for (const segment of segments) {
      const dx = segment[1].x - segment[0].x;
      const dy = segment[1].y - segment[0].y;
      const length = Math.sqrt(dx * dx + dy * dy);

      if (length < 1) continue;

      // Number of marks along segment
      const numMarks = Math.floor(length / hachureSpacing);
      if (numMarks === 0) continue;

      // Unit tangent vector (along contour)
      const tx = dx / length;
      const ty = dy / length;

      // Perpendicular vector
      const nx1 = -ty;
      const ny1 = tx;
      const nx2 = ty;
      const ny2 = -tx;

      // Sample points along segment
      for (let i = 1; i <= numMarks; i++) {
        const t = i / (numMarks + 1);
        const px = segment[0].x + dx * t;
        const py = segment[0].y + dy * t;

        // Sample heights in both perpendicular directions
        const sampleDist = cellSize * 2;
        const h1 = this._sampleHeightAtPoint(px + nx1 * sampleDist, py + ny1 * sampleDist, heightValues, rows, cols, bounds, cellSize);
        const h2 = this._sampleHeightAtPoint(px + nx2 * sampleDist, py + ny2 * sampleDist, heightValues, rows, cols, bounds, cellSize);

        // Direction that goes downhill
        let markNx, markNy;
        if (h1 < h2) {
          markNx = nx1;
          markNy = ny1;
        } else {
          markNx = nx2;
          markNy = ny2;
        }

        // Draw mark pointing downhill
        const hx = px + markNx * hachureLength;
        const hy = py + markNy * hachureLength;

        // Keep marks black for readability
        graphics.lineStyle(1, 0x000000, markAlpha);
        graphics.moveTo(px, py);
        graphics.lineTo(hx, hy);
      }
    }
  }

  /**
   * Sample height value from grid at point
   * @private
   */
  _sampleHeightAtPoint(x, y, heightValues, rows, cols, bounds, cellSize) {
    // Convert world coordinates to grid coordinates
    const col = (x - bounds.minX) / cellSize;
    const row = (y - bounds.minY) / cellSize;

    // Check bounds
    if (col < 0 || col >= cols - 1 || row < 0 || row >= rows - 1) {
      return 0;
    }

    // Bilinear interpolation
    const col0 = Math.floor(col);
    const row0 = Math.floor(row);
    const col1 = col0 + 1;
    const row1 = row0 + 1;

    const fx = col - col0;
    const fy = row - row0;

    const v00 = heightValues[row0 * cols + col0];
    const v10 = heightValues[row0 * cols + col1];
    const v01 = heightValues[row1 * cols + col0];
    const v11 = heightValues[row1 * cols + col1];

    return (1 - fx) * (1 - fy) * v00 +
           fx * (1 - fy) * v10 +
           (1 - fx) * fy * v01 +
           fx * fy * v11;
  }

  /**
   * Render as colored cells
   * @private
   */
  _renderCells(gridData, metadata, renderOptions) {
    const {
      mode = 'heights',
      heightColorFunc = null,
      biomeColorFunc = null,
      opacity = 0.7,
      cellBorder = false,
    } = renderOptions;

    const { heights, moisture, temperature, rows, cols } = gridData;
    const { cellSize, bounds } = metadata;

    const graphics = new PIXI.Graphics();

    // Render grid cells
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;

        // Draw cell centered at coordinate point (shift by half cell)
        const x = bounds.minX + col * cellSize - cellSize / 2;
        const y = bounds.minY + row * cellSize - cellSize / 2;

        let color = 0xffffff; // Default white
        let alpha = opacity;

        if (mode === 'heights' || mode === 'both') {
          const height = heights[idx];

          if (heightColorFunc) {
            color = heightColorFunc(height, metadata.heightStats);
          } else {
            const normalized = this._normalizeValue(
              height,
              metadata.heightStats.min,
              metadata.heightStats.max
            );
            color = this._heightToColor(normalized);
          }

          alpha = opacity * 0.7;
        }

        if (mode === 'biomes' || mode === 'both') {
          // Dynamically determine biome from moisture/temperature
          const biomeId = this.biomeResolver.getBiomeId(
            moisture[idx],
            temperature[idx],
            heights[idx]
          );

          if (biomeColorFunc) {
            const biomeColor = biomeColorFunc(biomeId);
            color = biomeColor;
            alpha = opacity;
          } else {
            color = this.biomeResolver.getBiomeColor(biomeId);
            alpha = opacity;
          }
        }

        // Draw cell
        graphics.beginFill(color, alpha);
        graphics.drawRect(x, y, cellSize, cellSize);
        graphics.endFill();

        // Optional cell border
        if (cellBorder) {
          graphics.lineStyle(0.5, 0x000000, 0.3);
          graphics.drawRect(x, y, cellSize, cellSize);
        }
      }
    }

    this.mapLayer.addChild(graphics);
  }

  /**
   * Show renderer (make visible)
   */
  show() {
    if (this.container) {
      this.container.visible = true;
      this.isVisible = true;
      console.log('GlobalMapRenderer | Shown');
    }
  }

  /**
   * Hide renderer
   */
  hide() {
    if (this.container) {
      this.container.visible = false;
      this.isVisible = false;
      console.log('GlobalMapRenderer | Hidden');
    }
  }

  /**
   * Toggle visibility
   */
  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Clear rendering
   */
  clear() {
    if (!this.container) return;

    try {
      this.mapLayer?.removeChildren();

      this.regionsLayer?.removeChildren();
      this.regionLabelsLayer?.removeChildren();
      try {
        this.regionHoverLayer?.clear?.();
      } catch (e) {
        // ignore
      }

      this.riversLayer?.removeChildren();
      this.riverLabelsLayer?.removeChildren();

      // If layers are missing for some reason, fall back to clearing root
      if (!this.mapLayer || !this.riversLayer || !this.riverLabelsLayer) {
        this.container.removeChildren();
      }
    } finally {
      // Also clear references so UI won't think a map is still loaded
      this.currentGrid = null;
      this.currentMetadata = null;
      this.currentSceneId = null;

      this.isVisible = false;
      console.log('GlobalMapRenderer | Cleared');
    }
  }

  /**
   * Export the current rendered map (PIXI container) to an image Blob.
   * This exports the current render state (current modes, already-rendered graphics).
   *
   * @param {Object} [options]
   * @param {number} [options.width] - Export width in pixels (defaults to active scene width)
   * @param {number} [options.height] - Export height in pixels (defaults to active scene height)
   * @param {number} [options.scale=1] - Scale factor (1 = full size)
   * @param {'image/webp'|'image/png'} [options.mimeType='image/webp']
   * @param {number} [options.quality=0.92] - WebP quality 0..1
   * @returns {Promise<{blob: Blob, width: number, height: number}>}
   */
  async exportToBlob(options = {}) {
    const scene = canvas?.scene;
    if (!scene) {
      throw new Error('No active scene');
    }

    if (!this.container) {
      throw new Error('Renderer container not initialized');
    }

    const renderer = canvas?.app?.renderer;
    if (!renderer) {
      throw new Error('PIXI renderer not available');
    }

    const {
      width = scene.dimensions?.width,
      height = scene.dimensions?.height,
      scale = 1,
      mimeType = 'image/webp',
      quality = 0.92,
      allowDownscale = true,
    } = options;

    if (!width || !height) {
      throw new Error('Scene dimensions not available');
    }

    let requestedScale = Math.max(0.05, Math.min(4, Number(scale) || 1));

    // Guard against GPU texture size limits
    const maxSize = renderer.texture?.maxSize || renderer.gl?.getParameter(renderer.gl.MAX_TEXTURE_SIZE);
    if (maxSize) {
      const maxScaleX = maxSize / width;
      const maxScaleY = maxSize / height;
      const maxSafeScale = Math.max(0.01, Math.min(maxScaleX, maxScaleY));

      // Round down a bit to avoid floating-point edge cases
      const maxSafeScaleRounded = Math.floor(maxSafeScale * 1000) / 1000;

      if (requestedScale > maxSafeScaleRounded) {
        if (!allowDownscale) {
          const exportWidth = Math.max(1, Math.floor(width * requestedScale));
          const exportHeight = Math.max(1, Math.floor(height * requestedScale));
          throw new Error(`Export size ${exportWidth}x${exportHeight} exceeds max texture size ${maxSize}`);
        }
        requestedScale = maxSafeScaleRounded;
      }
    }

    const exportScale = requestedScale;
    const exportWidth = Math.max(1, Math.floor(width * exportScale));
    const exportHeight = Math.max(1, Math.floor(height * exportScale));

    if (maxSize && (exportWidth > maxSize || exportHeight > maxSize)) {
      throw new Error(`Export size ${exportWidth}x${exportHeight} exceeds max texture size ${maxSize}`);
    }

    const rt = PIXI.RenderTexture.create({
      width: exportWidth,
      height: exportHeight,
      resolution: 1,
    });

    // Temporarily detach from the canvas (to avoid pan/zoom transforms) and render in scene coordinates.
    const originalParent = this.container.parent;
    const originalVisible = this.container.visible;
    const originalX = this.container.x;
    const originalY = this.container.y;
    const originalScaleX = this.container.scale.x;
    const originalScaleY = this.container.scale.y;
    const originalRotation = this.container.rotation;

    const tempRoot = new PIXI.Container();

    // Hover labels / hover overlays should not end up in exported images
    const originalRiverHoverLabelVisible = this._riverHoverLabel?.visible;
    const originalRegionHoverLabelVisible = this._regionHoverLabel?.visible;
    const originalRegionHoverLayerVisible = this.regionHoverLayer?.visible;

    try {
      this.container.visible = true;

      if (originalParent) {
        originalParent.removeChild(this.container);
      }
      tempRoot.addChild(this.container);

      // Reset transform to predictable export space
      this.container.x = 0;
      this.container.y = 0;
      this.container.rotation = 0;
      this.container.scale.set(exportScale, exportScale);

      if (this._riverHoverLabel) {
        this._riverHoverLabel.visible = false;
      }
      if (this._regionHoverLabel) {
        this._regionHoverLabel.visible = false;
      }
      if (this.regionHoverLayer) {
        this.regionHoverLayer.visible = false;
      }

      renderer.render(this.container, { renderTexture: rt, clear: true });

      const extract = renderer.plugins?.extract || renderer.extract;
      if (!extract?.canvas) {
        throw new Error('PIXI extract plugin not available');
      }

      const exportCanvas = extract.canvas(rt);

      const blob = await new Promise((resolve, reject) => {
        const encoderOptions = mimeType === 'image/webp' ? quality : undefined;
        exportCanvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error('Failed to convert canvas to Blob'));
        }, mimeType, encoderOptions);
      });

      return { blob, width: exportWidth, height: exportHeight, scale: exportScale, maxSize };
    } finally {
      try {
        rt.destroy(true);
      } catch (e) {
        // ignore
      }

      try {
        tempRoot.removeChild(this.container);
      } catch (e) {
        // ignore
      }

      if (originalParent) {
        originalParent.addChild(this.container);
        if (originalParent.sortableChildren) {
          originalParent.sortChildren();
        }
      }

      this.container.visible = originalVisible;
      this.container.x = originalX;
      this.container.y = originalY;
      this.container.scale.set(originalScaleX, originalScaleY);
      this.container.rotation = originalRotation;

      if (this._riverHoverLabel && typeof originalRiverHoverLabelVisible === 'boolean') {
        this._riverHoverLabel.visible = originalRiverHoverLabelVisible;
      }
      if (this._regionHoverLabel && typeof originalRegionHoverLabelVisible === 'boolean') {
        this._regionHoverLabel.visible = originalRegionHoverLabelVisible;
      }
      if (this.regionHoverLayer && typeof originalRegionHoverLayerVisible === 'boolean') {
        this.regionHoverLayer.visible = originalRegionHoverLayerVisible;
      }
    }
  }

  /**
   * Normalize value to 0-1 range
   * @private
   */
  _normalizeValue(value, min, max) {
    if (max === min) return 0.5;
    return (value - min) / (max - min);
  }

  _getClientSetting(key, fallback) {
    try {
      const v = game?.settings?.get?.('spaceholder', key);
      return (v === undefined) ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  _isGlobalMapRiverLabelRotationEnabled() {
    return !!this._getClientSetting('globalmap.rotateRiverLabels', true);
  }

  _isGlobalMapAppearanceAnimationEnabled() {
    return !!this._getClientSetting('globalmap.appearanceAnimation', true);
  }

  _getGlobalMapFadeDurationMs() {
    const raw = Number(this._getClientSetting('globalmap.appearanceAnimationDurationMs', 180));
    if (!Number.isFinite(raw)) return 180;

    return Math.max(0, Math.min(2000, Math.round(raw)));
  }

  _cancelFade(displayObject) {
    if (!displayObject || !this._fadeJobs) return;

    const job = this._fadeJobs.get(displayObject);
    if (job) {
      job.cancelled = true;
      this._fadeJobs.delete(displayObject);
    }
  }

  _fadeTo(displayObject, targetAlpha, durationMs = null, { onComplete = null } = {}) {
    if (!displayObject) return;

    const animate = this._isGlobalMapAppearanceAnimationEnabled();

    // IMPORTANT: treat null/undefined as "use default" (Number(null) === 0 would disable animation)
    const durRaw = (durationMs === null || durationMs === undefined) ? NaN : Number(durationMs);
    const duration = Number.isFinite(durRaw) ? Math.max(0, durRaw) : this._getGlobalMapFadeDurationMs();

    const to = Math.max(0, Math.min(1, Number(targetAlpha)));

    // Cancel any previous fade on this object
    this._cancelFade(displayObject);

    if (!animate || duration <= 0) {
      try {
        displayObject.alpha = to;
      } catch (e) {
        // ignore
      }
      if (typeof onComplete === 'function') {
        try { onComplete(); } catch (e) { /* ignore */ }
      }
      return;
    }

    const from = Number.isFinite(Number(displayObject.alpha)) ? Number(displayObject.alpha) : 1;

    const job = { cancelled: false, targetAlpha: to };
    this._fadeJobs.set(displayObject, job);

    const start = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();

    const step = (now) => {
      if (job.cancelled) return;

      const t = Math.max(0, Math.min(1, (now - start) / duration));
      const a = from + (to - from) * t;

      try {
        displayObject.alpha = a;
      } catch (e) {
        // ignore
      }

      if (t < 1) {
        try {
          requestAnimationFrame(step);
        } catch (e) {
          // Fallback
          setTimeout(() => step(((typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now())), 16);
        }
        return;
      }

      this._fadeJobs.delete(displayObject);

      if (typeof onComplete === 'function') {
        try { onComplete(); } catch (e) { /* ignore */ }
      }
    };

    try {
      requestAnimationFrame(step);
    } catch (e) {
      setTimeout(() => step(((typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now())), 0);
    }
  }

  _showDisplayObjectWithFade(displayObject, durationMs = null) {
    if (!displayObject) return;

    const animate = this._isGlobalMapAppearanceAnimationEnabled();

    if (!animate) {
      try {
        displayObject.alpha = 1;
        displayObject.visible = true;
      } catch (e) {
        // ignore
      }
      return;
    }

    const job = this._fadeJobs?.get?.(displayObject) || null;

    if (!displayObject.visible) {
      try {
        displayObject.alpha = 0;
        displayObject.visible = true;
      } catch (e) {
        // ignore
      }

      this._fadeTo(displayObject, 1, durationMs);
      return;
    }

    const alpha = Number.isFinite(Number(displayObject.alpha)) ? Number(displayObject.alpha) : 1;
    if (alpha >= 0.999) return;

    // Don't restart an existing fade-in on every pointermove
    if (job && job.targetAlpha === 1) return;

    this._fadeTo(displayObject, 1, durationMs);
  }

  _hideDisplayObjectWithFade(displayObject, { durationMs = null, clearOnComplete = false } = {}) {
    if (!displayObject) return;

    const animate = this._isGlobalMapAppearanceAnimationEnabled();

    const finalize = () => {
      try {
        if (clearOnComplete && typeof displayObject.clear === 'function') {
          displayObject.clear();
        }
      } catch (e) {
        // ignore
      }

      try {
        displayObject.visible = false;
      } catch (e) {
        // ignore
      }
    };

    if (!animate) {
      this._cancelFade(displayObject);
      try {
        displayObject.alpha = 1;
      } catch (e) {
        // ignore
      }
      finalize();
      return;
    }

    if (!displayObject.visible) {
      finalize();
      return;
    }

    const job = this._fadeJobs?.get?.(displayObject) || null;

    // Don't restart an existing fade-out on every pointermove
    if (job && job.targetAlpha === 0) return;

    this._fadeTo(displayObject, 0, durationMs, { onComplete: finalize });
  }

  _cancelFadeDeep(displayObject) {
    if (!displayObject) return;

    this._cancelFade(displayObject);

    const kids = displayObject.children;
    if (!Array.isArray(kids) || kids.length === 0) return;

    for (const ch of kids) {
      this._cancelFadeDeep(ch);
    }
  }

  _crossFadeLayer(layer, newChild, durationMs = null) {
    if (!layer) return;

    const animate = this._isGlobalMapAppearanceAnimationEnabled();

    // IMPORTANT: treat null/undefined as "use default" (Number(null) === 0 would disable animation)
    const durRaw = (durationMs === null || durationMs === undefined) ? NaN : Number(durationMs);
    const duration = Number.isFinite(durRaw) ? Math.max(0, durRaw) : this._getGlobalMapFadeDurationMs();

    // Prevent overlapping fades from previous renders (important when re-rendering rapidly)
    try {
      if (Array.isArray(layer.children)) {
        for (const ch of layer.children) {
          this._cancelFadeDeep(ch);
        }
      }
      if (newChild) {
        this._cancelFadeDeep(newChild);
      }
    } catch (e) {
      // ignore
    }

    const hasOld = Array.isArray(layer.children) ? layer.children.length > 0 : false;

    let oldWrap = null;
    if (hasOld) {
      const oldChildren = layer.removeChildren();
      oldWrap = new PIXI.Container();
      oldWrap.name = `${layer.name || 'layer'}OldWrap`;
      oldWrap.addChild(...oldChildren);
      layer.addChild(oldWrap);
    }

    if (newChild) {
      newChild.alpha = animate ? 0 : 1;
      layer.addChild(newChild);
      if (animate) {
        this._fadeTo(newChild, 1, duration);
      }
    }

    if (oldWrap) {
      const destroyOld = () => {
        try {
          oldWrap.parent?.removeChild?.(oldWrap);
        } catch (e) {
          // ignore
        }
        try {
          oldWrap.destroy({ children: true });
        } catch (e) {
          // ignore
        }
      };

      if (animate) {
        this._fadeTo(oldWrap, 0, duration, { onComplete: destroyOld });
      } else {
        destroyOld();
      }
    }
  }

  // ==========================
  // Vector Regions (new system)
  // ==========================

  /**
   * Load vector regions data from the active scene flags.
   */
  async loadVectorRegionsFromScene(scene = canvas?.scene) {
    try {
      const raw = scene?.getFlag?.('spaceholder', 'globalMapRegions');
      this.vectorRegionsData = this._normalizeVectorRegionsData(raw);
      return this.vectorRegionsData;
    } catch (e) {
      console.warn('GlobalMapRenderer | Failed to load globalMapRegions flag, using empty regions', e);
      this.vectorRegionsData = this._normalizeVectorRegionsData(null);
      return this.vectorRegionsData;
    }
  }

  /**
   * Set vector regions data in memory (used by tools while editing).
   */
  setVectorRegionsData(data, metadata = null) {
    this.vectorRegionsData = this._normalizeVectorRegionsData(data);

    const md = metadata || this.currentMetadata;
    if (md) {
      this.renderVectorRegions(this.vectorRegionsData, md);
    } else {
      // We can render regions without metadata as they are in scene coordinates.
      this.renderVectorRegions(this.vectorRegionsData, null);
    }
  }

  /**
   * Clear rendered vector regions (graphics + labels + hover).
   */
  clearVectorRegions() {
    try {
      this._crossFadeLayer(this.regionsLayer, null);
      this._crossFadeLayer(this.regionLabelsLayer, null);
      this._hideDisplayObjectWithFade(this.regionHoverLayer, { clearOnComplete: true });
    } catch (e) {
      // ignore
    }

    this._regionLabelAnchors.clear();
    this._regionBounds.clear();
    this._regionRenderPoints.clear();
    this._hoveredRegionId = null;
    this._regionHoverLabel = null;
  }

  /**
   * Normalize persisted vector regions structure.
   * @private
   */
  _normalizeVectorRegionsData(data) {
    const defaults = {
      version: 1,
      settings: {
        labelMode: 'hover',
        clickAction: 'none',
        clickModifier: 'none',
        smoothIterations: 4,
        renderMode: 'full',
      },
      regions: [],
    };

    const clone = (obj) => {
      return foundry?.utils?.duplicate ? foundry.utils.duplicate(obj) : JSON.parse(JSON.stringify(obj));
    };

    if (!data || typeof data !== 'object') {
      return clone(defaults);
    }

    const settingsRaw = (data.settings && typeof data.settings === 'object') ? data.settings : {};

    const labelMode = ['off', 'hover', 'always'].includes(settingsRaw.labelMode) ? settingsRaw.labelMode : 'hover';

    // clickAction/clickModifier are deprecated (opening journals by click is removed)
    const clickAction = 'none';
    const clickModifier = 'none';

    const renderModeRaw = String(settingsRaw.renderMode ?? '').trim();
    const renderMode = ['name', 'border', 'full'].includes(renderModeRaw) ? renderModeRaw : 'full';

    let smoothIterations = Number.parseInt(settingsRaw.smoothIterations, 10);
    if (!Number.isFinite(smoothIterations)) smoothIterations = 4;
    smoothIterations = Math.max(0, Math.min(4, smoothIterations));

    const regionsRaw = Array.isArray(data.regions) ? data.regions : [];

    const normalizeColorInt = (value, fallback) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value & 0xFFFFFF;

      const s0 = String(value ?? '').trim();
      if (!s0) return fallback;

      let s = s0;
      if (s.startsWith('#')) s = s.slice(1);
      if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);
      s = s.replace(/[^0-9a-fA-F]/g, '');

      if (s.length === 3) {
        s = s.split('').map(ch => ch + ch).join('');
      }
      if (s.length !== 6) return fallback;

      const n = parseInt(s, 16);
      if (!Number.isFinite(n)) return fallback;
      return n & 0xFFFFFF;
    };

    const clamp01 = (n, fallback = 0) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return fallback;
      return Math.max(0, Math.min(1, v));
    };

    const clampPositive = (n, fallback = 1) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return fallback;
      return Math.max(0.1, v);
    };

    const normalizePoint = (p) => {
      if (!p || typeof p !== 'object') return null;
      const x = Number(p.x);
      const y = Number(p.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    };

    const defaultBaseColor = 0x2E7DFF;

    const regions = regionsRaw
      .filter(r => r && typeof r === 'object')
      .map((r, i) => {
        const id = (typeof r.id === 'string' && r.id.trim().length) ? r.id.trim() : `region_${i}_${Math.random().toString(36).slice(2, 8)}`;
        const name = (typeof r.name === 'string' && r.name.trim().length)
          ? r.name.trim()
          : _f('SPACEHOLDER.GlobalMap.Tools.Regions.DefaultName', { n: i + 1 });

        const pointsRaw = Array.isArray(r.points) ? r.points : [];
        const points = pointsRaw.map(normalizePoint).filter(Boolean);

        let closed = !!r.closed;
        if (closed && points.length < 3) closed = false;

        const baseColor = normalizeColorInt(r.color, defaultBaseColor);

        const fillColor = normalizeColorInt(r.fillColor, baseColor);
        const strokeColor = normalizeColorInt(r.strokeColor, baseColor);

        const fillAlpha = clamp01(r.fillAlpha, 0.18);
        const strokeAlpha = clamp01(r.strokeAlpha, 0.9);
        const strokeWidth = clampPositive(r.strokeWidth, 3);

        const journalUuid = (typeof r.journalUuid === 'string' && r.journalUuid.trim().length) ? r.journalUuid.trim() : '';

        return {
          id,
          name,
          points,
          closed,
          fillColor,
          fillAlpha,
          strokeColor,
          strokeAlpha,
          strokeWidth,
          journalUuid,
        };
      });

    return {
      version: Number(data.version) || 1,
      settings: { labelMode, clickAction, clickModifier, smoothIterations, renderMode },
      regions,
    };
  }

  /**
   * Render vector regions on top of the map.
   */
  renderVectorRegions(regionsData = this.vectorRegionsData, _metadata = this.currentMetadata) {
    if (!this.regionsLayer || !this.regionLabelsLayer || !this.regionHoverLayer) return;

    const animate = this._isGlobalMapAppearanceAnimationEnabled();

    // Reset cached metadata (hit tests should follow current data immediately)
    this._regionLabelAnchors.clear();
    this._regionBounds.clear();
    this._regionRenderPoints.clear();
    this._hoveredRegionId = null;

    // Fade out any active hover overlay/label (they depend on current geometry)
    this._hideDisplayObjectWithFade(this._regionHoverLabel);
    this._hideDisplayObjectWithFade(this.regionHoverLayer, { clearOnComplete: true });
    this._regionHoverLabel = null;

    const regions = regionsData?.regions || [];
    if (!Array.isArray(regions) || regions.length === 0) {
      this._crossFadeLayer(this.regionsLayer, null);
      this._crossFadeLayer(this.regionLabelsLayer, null);
      return;
    }

    const modeRaw = String(regionsData?.settings?.labelMode || 'hover');
    const showMode = ['off', 'hover', 'always'].includes(modeRaw) ? modeRaw : 'hover';

    const renderModeRaw = String(regionsData?.settings?.renderMode || 'full');
    const renderMode = ['name', 'border', 'full'].includes(renderModeRaw) ? renderModeRaw : 'full';

    const smoothIterationsRaw = Number.parseInt(regionsData?.settings?.smoothIterations, 10);
    const smoothIterations = Number.isFinite(smoothIterationsRaw) ? Math.max(0, Math.min(4, smoothIterationsRaw)) : 4;

    const allowStroke = renderMode === 'full' || renderMode === 'border';
    const allowFill = renderMode === 'full';

    const drawBaseShapes = showMode === 'always';

    const flatten = (pts) => {
      const out = [];
      for (const p of pts) {
        out.push(p.x, p.y);
      }
      return out;
    };

    const computeBounds = (pts) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const p of pts) {
        if (!p) continue;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }

      if (!Number.isFinite(minX)) {
        minX = minY = maxX = maxY = 0;
      }

      return { minX, minY, maxX, maxY };
    };

    // ===== Build new visuals (groups) =====
    let shapesGroup = null;
    let labelsGroup = null;

    // Labels group exists for both Always and Hover (Hover uses a single hover label)
    if (showMode !== 'off') {
      labelsGroup = new PIXI.Container();
      labelsGroup.name = 'globalMapVectorRegionLabelsGroup';
    }

    const graphics = new PIXI.Graphics();
    graphics.name = 'globalMapVectorRegionsGraphics';
    let didDraw = false;

    for (const region of regions) {
      const pts = Array.isArray(region?.points) ? region.points : [];
      if (pts.length < 2) continue;

      const renderPts = (region.closed && pts.length >= 3 && smoothIterations > 0)
        ? this._smoothContour(pts, smoothIterations)
        : pts;
      this._regionRenderPoints.set(region.id, renderPts);

      const strokeWidth = Number(region.strokeWidth) || 0;
      const strokeColor = Number(region.strokeColor) || 0xFFFFFF;
      const strokeAlpha = Number.isFinite(Number(region.strokeAlpha)) ? Math.max(0, Math.min(1, Number(region.strokeAlpha))) : 1;

      const fillColor = Number(region.fillColor) || strokeColor;
      const fillAlpha = Number.isFinite(Number(region.fillAlpha)) ? Math.max(0, Math.min(1, Number(region.fillAlpha))) : 0;

      const bounds = computeBounds(renderPts);
      const pad = Math.max(0, strokeWidth / 2) + 10;
      this._regionBounds.set(region.id, { ...bounds, pad });

      // Anchor for labels
      let anchor = null;
      if (region.closed && renderPts.length >= 3) {
        anchor = this._computePolygonCentroid(renderPts);
      } else {
        anchor = this._computePolylineMidpoint(renderPts);
      }
      if (anchor) {
        this._regionLabelAnchors.set(region.id, anchor);
      }

      // Base render: only when showMode === 'always'
      if (drawBaseShapes) {
        if (region.closed && renderPts.length >= 3) {
          const useStroke = allowStroke && strokeWidth > 0 && strokeAlpha > 0;
          const useFill = allowFill && fillAlpha > 0;

          if (useStroke || useFill) {
            // Ensure fill does not leak between shapes
            graphics.lineStyle(useStroke ? strokeWidth : 0, strokeColor, useStroke ? strokeAlpha : 0);
            if (useFill) graphics.beginFill(fillColor, fillAlpha);
            graphics.drawPolygon(flatten(renderPts));
            if (useFill) graphics.endFill();
            didDraw = true;
          }
        } else {
          // Preview polyline (not closed)
          if (allowStroke && strokeWidth > 0 && strokeAlpha > 0 && renderPts.length >= 2) {
            graphics.lineStyle(strokeWidth, strokeColor, strokeAlpha);
            graphics.moveTo(renderPts[0].x, renderPts[0].y);
            for (let i = 1; i < renderPts.length; i++) {
              graphics.lineTo(renderPts[i].x, renderPts[i].y);
            }
            didDraw = true;
          }
        }

        // Labels are part of the region display in Always mode
        if (labelsGroup && anchor && region?.name) {
          const text = this._createRegionLabelText(String(region.name), region.id);
          text.position.set(anchor.x, anchor.y);
          labelsGroup.addChild(text);
        }
      }
    }

    if (drawBaseShapes && didDraw) {
      shapesGroup = new PIXI.Container();
      shapesGroup.name = 'globalMapVectorRegionsGroup';
      shapesGroup.addChild(graphics);
    }

    // Hover label (only when showMode === 'hover')
    if (showMode === 'hover' && labelsGroup) {
      this._regionHoverLabel = this._createRegionLabelText('');
      this._regionHoverLabel.visible = false;
      this._regionHoverLabel.alpha = animate ? 0 : 1;
      labelsGroup.addChild(this._regionHoverLabel);
    }

    // ===== Cross-fade (or instant swap) =====
    this._crossFadeLayer(this.regionsLayer, shapesGroup);
    this._crossFadeLayer(this.regionLabelsLayer, labelsGroup);
  }

  /**
   * Install hover handler for showing region names and highlighting outlines.
   * @private
   */
  _installRegionHoverHandler() {
    if (!canvas?.stage) return;

    // Remove previous handler
    if (this._regionHoverHandler) {
      try {
        canvas.stage.off('pointermove', this._regionHoverHandler);
      } catch (e) {
        // ignore
      }
    }

    this._regionHoverHandler = (event) => {
      try {
        this._handleRegionHover(event);
      } catch (e) {
        // ignore
      }
    };

    canvas.stage.on('pointermove', this._regionHoverHandler);
  }

  /**
   * Region click handler (opening region journals) was removed.
   * @private
   */
  _removeRegionClickHandler() {
    if (!this._regionClickHandler || !canvas?.stage) {
      this._regionClickHandler = null;
      return;
    }

    try {
      canvas.stage.off('pointerdown', this._regionClickHandler);
    } catch (e) {
      // ignore
    }

    this._regionClickHandler = null;
  }

  async _handleRegionClick(_event) {
    // Disabled: opening region journals by click was unreliable and is removed.
    return;
  }

  _handleRegionHover(event) {
    const labelMode = this.vectorRegionsData?.settings?.labelMode || 'hover';
    if (labelMode !== 'hover') {
      this._hideDisplayObjectWithFade(this._regionHoverLabel);
      this._hideDisplayObjectWithFade(this.regionHoverLayer, { clearOnComplete: true });
      this._hoveredRegionId = null;
      return;
    }

    const renderModeRaw = String(this.vectorRegionsData?.settings?.renderMode || 'full');
    const renderMode = ['name', 'border', 'full'].includes(renderModeRaw) ? renderModeRaw : 'full';

    const allowStroke = renderMode === 'full' || renderMode === 'border';
    const allowFill = renderMode === 'full';

    if (!this.isVisible || !this._regionHoverLabel || !this.regionHoverLayer) {
      return;
    }

    const regions = this.vectorRegionsData?.regions || [];
    if (!Array.isArray(regions) || regions.length === 0) {
      this._hideDisplayObjectWithFade(this._regionHoverLabel);
      this._hideDisplayObjectWithFade(this.regionHoverLayer, { clearOnComplete: true });
      this._hoveredRegionId = null;
      return;
    }

    const pos = event?.data?.getLocalPosition?.(canvas.stage);
    if (!pos) return;

    const hit = this._findNearestRegionHit(pos.x, pos.y, regions);
    if (!hit) {
      this._hideDisplayObjectWithFade(this._regionHoverLabel);
      this._hideDisplayObjectWithFade(this.regionHoverLayer, { clearOnComplete: true });
      this._hoveredRegionId = null;
      return;
    }

    const region = regions.find(r => r?.id === hit.regionId);
    const anchor = this._regionLabelAnchors.get(hit.regionId);

    if (!region?.name || !anchor) {
      this._hideDisplayObjectWithFade(this._regionHoverLabel);
      this._hideDisplayObjectWithFade(this.regionHoverLayer, { clearOnComplete: true });
      this._hoveredRegionId = null;
      return;
    }

    const didRegionChange = this._hoveredRegionId !== hit.regionId;
    this._hoveredRegionId = hit.regionId;

    // Label
    if (didRegionChange) {
      this._regionHoverLabel.text = String(region.name);
      this._applyRegionLabelStyle(this._regionHoverLabel, hit.regionId);
    }

    this._regionHoverLabel.position.set(anchor.x, anchor.y);
    this._showDisplayObjectWithFade(this._regionHoverLabel);

    // Hover overlay (shape)
    if (!allowStroke && !allowFill) {
      this._hideDisplayObjectWithFade(this.regionHoverLayer, { clearOnComplete: true });
      return;
    }

    const ptsRaw = Array.isArray(region?.points) ? region.points : [];
    const pts = this._regionRenderPoints.get(hit.regionId) || ptsRaw;
    if (pts.length >= 2) {
      const strokeWidth = Number(region.strokeWidth) || 1;
      const strokeColor = Number(region.strokeColor) || 0xFFFFFF;
      const strokeAlpha = Number.isFinite(Number(region.strokeAlpha)) ? Math.max(0, Math.min(1, Number(region.strokeAlpha))) : 1;

      const fillColor = Number(region.fillColor) || strokeColor;
      const fillAlpha = Number.isFinite(Number(region.fillAlpha)) ? Math.max(0, Math.min(1, Number(region.fillAlpha))) : 0;

      const w = allowStroke ? Math.max(1, strokeWidth + 2) : 0;
      const a = allowStroke ? Math.min(1, strokeAlpha + 0.2) : 0;

      this.regionHoverLayer.clear();

      const canFill = allowFill && region.closed && pts.length >= 3 && fillAlpha > 0;
      if (canFill) {
        this.regionHoverLayer.beginFill(fillColor, fillAlpha);
      }

      if (allowStroke && w > 0 && a > 0) {
        this.regionHoverLayer.lineStyle(w, strokeColor, a);
      }

      if (region.closed && pts.length >= 3) {
        const poly = [];
        for (const p of pts) poly.push(p.x, p.y);
        this.regionHoverLayer.drawPolygon(poly);
      } else {
        if (allowStroke && w > 0 && a > 0) {
          this.regionHoverLayer.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            this.regionHoverLayer.lineTo(pts[i].x, pts[i].y);
          }
        }
      }

      if (canFill) {
        this.regionHoverLayer.endFill();
      }

      this._showDisplayObjectWithFade(this.regionHoverLayer);
    } else {
      this._hideDisplayObjectWithFade(this.regionHoverLayer, { clearOnComplete: true });
    }
  }

  _getRegionLabelMaxWidth(regionId) {
    if (!regionId) return null;

    const rb = this._regionBounds.get(regionId);
    if (!rb) return null;

    const w = Number(rb.maxX) - Number(rb.minX);
    if (!Number.isFinite(w) || w <= 0) return null;

    const pad = Number.isFinite(Number(rb.pad)) ? Number(rb.pad) : 0;
    const margin = Math.max(20, Math.min(w * 0.06, 160), pad + 10);

    return Math.max(0, w - margin * 2);
  }

  _getRegionLabelStyle(regionId, text) {
    const baseFontSize = 18;
    const baseStrokeThickness = 4;

    const baseStyle = new PIXI.TextStyle({
      fontFamily: 'IBM Plex Sans',
      fontSize: baseFontSize,
      fill: '#ffffff',
      stroke: '#000000',
      strokeThickness: baseStrokeThickness,
    });

    const s = String(text ?? '');
    const maxWidth = this._getRegionLabelMaxWidth(regionId);
    if (!s.trim() || !Number.isFinite(maxWidth) || maxWidth <= 0) {
      return baseStyle;
    }

    const metrics = (PIXI.TextMetrics && typeof PIXI.TextMetrics.measureText === 'function')
      ? PIXI.TextMetrics.measureText(s, baseStyle)
      : null;

    const baseWidth = metrics?.width;
    if (!Number.isFinite(baseWidth) || baseWidth <= 0) {
      return baseStyle;
    }

    const renderer = canvas?.app?.renderer;
    const maxTexSize = renderer?.texture?.maxSize
      || (renderer?.gl && typeof renderer.gl.getParameter === 'function'
        ? renderer.gl.getParameter(renderer.gl.MAX_TEXTURE_SIZE)
        : null)
      || 4096;

    // Keep the text texture within renderer max size (rough linear scaling approximation)
    const safeMaxScaleW = (maxTexSize * 0.9) / baseWidth;
    const baseHeight = metrics?.height;
    const safeMaxScaleH = (Number.isFinite(baseHeight) && baseHeight > 0)
      ? ((maxTexSize * 0.9) / baseHeight)
      : Infinity;

    const safeMaxFontSize = baseFontSize * Math.min(safeMaxScaleW, safeMaxScaleH);
    const maxFontSize = Math.min(256, Math.max(4, Math.floor(safeMaxFontSize)));
    const minFontSize = Math.min(10, maxFontSize);

    // Make region labels smaller overall (relative to available width)
    const REGION_LABEL_SCALE = 0.5;

    const desiredFontSize = baseFontSize * (maxWidth / baseWidth) * REGION_LABEL_SCALE;
    const fontSize = Math.max(minFontSize, Math.min(maxFontSize, Math.round(desiredFontSize)));
    const strokeThickness = Math.max(2, Math.min(18, Math.round(fontSize * (baseStrokeThickness / baseFontSize))));

    return new PIXI.TextStyle({
      fontFamily: 'IBM Plex Sans',
      fontSize,
      fill: '#ffffff',
      stroke: '#000000',
      strokeThickness,
    });
  }

  _applyTextMaxWidth(textObj, maxWidth) {
    if (!textObj || !Number.isFinite(maxWidth) || maxWidth <= 0) return;

    // Reset scale so measurement is in style pixels
    if (textObj.scale?.set) textObj.scale.set(1);

    const s = String(textObj.text ?? '');

    // Prefer TextMetrics (does not depend on PIXI.Text internals)
    let w = null;
    if (PIXI.TextMetrics && typeof PIXI.TextMetrics.measureText === 'function') {
      const m = PIXI.TextMetrics.measureText(s, textObj.style);
      w = m?.width;
    }

    // Fallback to the object width
    if (!Number.isFinite(w) || w <= 0) {
      try {
        textObj.updateText?.();
      } catch (e) {
        // ignore
      }
      w = textObj.width;
    }

    if (!Number.isFinite(w) || w <= 0) return;

    // Only scale down; never scale up (otherwise huge regions produce comically large labels)
    if (w <= maxWidth) return;

    const scale = maxWidth / w;
    if (textObj.scale?.set) {
      textObj.scale.set(scale);
    } else {
      textObj.scale.x = scale;
      textObj.scale.y = scale;
    }
  }

  _applyRegionLabelStyle(textObj, regionId) {
    if (!textObj) return;

    textObj.style = this._getRegionLabelStyle(regionId, textObj.text);
    this._applyTextMaxWidth(textObj, this._getRegionLabelMaxWidth(regionId));
  }

  _createRegionLabelText(text, regionId = null) {
    const style = this._getRegionLabelStyle(regionId, text);

    const t = new PIXI.Text(text, style);
    t.name = 'globalMapRegionLabel';
    if (t.anchor?.set) t.anchor.set(0.5);

    this._applyTextMaxWidth(t, this._getRegionLabelMaxWidth(regionId));

    return t;
  }

  _computePolygonCentroid(points) {
    if (!points || points.length < 3) return null;

    let area2 = 0;
    let cx = 0;
    let cy = 0;

    for (let i = 0; i < points.length; i++) {
      const p0 = points[i];
      const p1 = points[(i + 1) % points.length];
      const cross = p0.x * p1.y - p1.x * p0.y;
      area2 += cross;
      cx += (p0.x + p1.x) * cross;
      cy += (p0.y + p1.y) * cross;
    }

    if (Math.abs(area2) < 1e-6) {
      // Fallback: average
      let sx = 0;
      let sy = 0;
      for (const p of points) {
        sx += p.x;
        sy += p.y;
      }
      return { x: sx / points.length, y: sy / points.length };
    }

    const area6 = area2 * 3;
    return { x: cx / area6, y: cy / area6 };
  }

  _pointInPolygon(x, y, points) {
    // Ray casting
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i].x;
      const yi = points[i].y;
      const xj = points[j].x;
      const yj = points[j].y;

      const denom = (yj - yi);
      const safeDenom = Math.abs(denom) < 1e-9 ? (denom < 0 ? -1e-9 : 1e-9) : denom;
      const xInt = (xj - xi) * (y - yi) / safeDenom + xi;

      const intersect = ((yi > y) !== (yj > y)) && (x < xInt);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * Найти регион в точке (для UI-инспектора и других подсистем).
   * Возвращает hit по тем же правилам, что и hover/click (внутри полигона, иначе near-border).
   * @param {number} x
   * @param {number} y
   * @returns {{region: object, hit: {regionId: string, distSq: number}} | null}
   */
  findRegionAt(x, y) {
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;

    const regions = this.vectorRegionsData?.regions || [];
    if (!Array.isArray(regions) || regions.length === 0) return null;

    const hit = this._findNearestRegionHit(px, py, regions);
    if (!hit) return null;

    const region = regions.find(r => r?.id === hit.regionId) || null;
    if (!region) return null;

    return { region, hit };
  }

  _findNearestRegionHit(x, y, regions) {
    // Prefer inside hits; if none, allow near-border hits.
    let bestInside = null;
    let bestInsideDistSq = Infinity;

    for (const region of regions) {
      const ptsRaw = region?.points;
      const pts = this._regionRenderPoints.get(region.id) || ptsRaw;
      if (!pts || pts.length < 3 || !region?.closed) continue;

      const rb = this._regionBounds.get(region.id);
      if (rb) {
        const pad = rb.pad ?? 0;
        if (x < rb.minX - pad || x > rb.maxX + pad || y < rb.minY - pad || y > rb.maxY + pad) {
          continue;
        }
      }

      if (!this._pointInPolygon(x, y, pts)) {
        continue;
      }

      // Tie-break: nearest edge (smaller = more specific)
      let minEdgeDistSq = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const d2 = this._distancePointToSegmentSq(x, y, a.x, a.y, b.x, b.y);
        if (d2 < minEdgeDistSq) minEdgeDistSq = d2;
      }

      if (minEdgeDistSq < bestInsideDistSq) {
        bestInsideDistSq = minEdgeDistSq;
        bestInside = { regionId: region.id, distSq: minEdgeDistSq };
      }
    }

    if (bestInside) return bestInside;

    let best = null;
    let bestDistSq = Infinity;

    for (const region of regions) {
      const ptsRaw = region?.points;
      const pts = this._regionRenderPoints.get(region.id) || ptsRaw;
      if (!pts || pts.length < 2) continue;

      const rb = this._regionBounds.get(region.id);
      if (rb) {
        const pad = rb.pad ?? 0;
        if (x < rb.minX - pad || x > rb.maxX + pad || y < rb.minY - pad || y > rb.maxY + pad) {
          continue;
        }
      }

      const strokeWidth = Number(region.strokeWidth) || 1;
      const threshold = strokeWidth / 2 + 6;
      const thresholdSq = threshold * threshold;

      // Segments: polyline, and if closed treat as polygon
      const segCount = region.closed && pts.length >= 3 ? pts.length : (pts.length - 1);
      for (let i = 0; i < segCount; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % pts.length];
        if (!p0 || !p1) continue;

        const distSq = this._distancePointToSegmentSq(x, y, p0.x, p0.y, p1.x, p1.y);
        if (distSq <= thresholdSq && distSq < bestDistSq) {
          bestDistSq = distSq;
          best = { regionId: region.id, distSq };
        }
      }
    }

    return best;
  }

  /**
   * Load vector rivers data from the active scene flags.
   * This is the new (non-grid) rivers system.
   */
  async loadVectorRiversFromScene(scene = canvas?.scene) {
    try {
      const raw = scene?.getFlag?.('spaceholder', 'globalMapRivers');
      this.vectorRiversData = this._normalizeVectorRiversData(raw);
      return this.vectorRiversData;
    } catch (e) {
      console.warn('GlobalMapRenderer | Failed to load globalMapRivers flag, using empty rivers', e);
      this.vectorRiversData = this._normalizeVectorRiversData(null);
      return this.vectorRiversData;
    }
  }

  /**
   * Set vector rivers data in memory (used by tools while editing).
   */
  setVectorRiversData(data, metadata = null) {
    this.vectorRiversData = this._normalizeVectorRiversData(data);

    const md = metadata || this.currentMetadata;
    if (md) {
      this.renderVectorRivers(this.vectorRiversData, md);
    }
  }

  /**
   * Clear rendered vector rivers (graphics + labels).
   */
  clearVectorRivers() {
    try {
      this._crossFadeLayer(this.riversLayer, null);
      this._crossFadeLayer(this.riverLabelsLayer, null);
    } catch (e) {
      // ignore
    }

    this._riverLabelAnchors.clear();
    this._riverBounds.clear();
    this._hoveredRiverId = null;
    this._riverHoverLabel = null;
  }

  /**
   * Normalize persisted vector rivers structure.
   * @private
   */
  _normalizeVectorRiversData(data) {
    const defaults = {
      version: 1,
      settings: {
        labelMode: 'hover',
        snapToEndpoints: true,
      },
      rivers: [],
    };

    if (!data || typeof data !== 'object') {
      return foundry?.utils?.duplicate ? foundry.utils.duplicate(defaults) : JSON.parse(JSON.stringify(defaults));
    }

    const settingsRaw = (data.settings && typeof data.settings === 'object') ? data.settings : {};
    const labelMode = ['off', 'hover', 'always'].includes(settingsRaw.labelMode) ? settingsRaw.labelMode : 'hover';
    const snapToEndpoints = settingsRaw.snapToEndpoints === undefined ? true : !!settingsRaw.snapToEndpoints;

    const riversRaw = Array.isArray(data.rivers) ? data.rivers : [];

    const normalizePoint = (p) => {
      if (!p || typeof p !== 'object') return null;
      const x = Number(p.x);
      const y = Number(p.y);
      const widthRaw = (p.width !== undefined) ? p.width : p.w;
      const width = Number(widthRaw);

      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

      // No hard limits: just ensure it's a finite positive number; fall back to a sane default.
      const safeWidth = Number.isFinite(width) && width > 0 ? width : 24;

      return { x, y, width: safeWidth };
    };

    const rivers = riversRaw
      .filter(r => r && typeof r === 'object')
      .map((r, i) => {
        const id = (typeof r.id === 'string' && r.id.trim().length) ? r.id.trim() : `river_${i}_${Math.random().toString(36).slice(2, 8)}`;
        const name = (typeof r.name === 'string' && r.name.trim().length)
          ? r.name.trim()
          : _f('SPACEHOLDER.GlobalMap.Tools.Rivers.DefaultName', { n: i + 1 });
        const pointsRaw = Array.isArray(r.points) ? r.points : [];
        const points = pointsRaw.map(normalizePoint).filter(Boolean);

        return { id, name, points };
      });

    return {
      version: Number(data.version) || 1,
      settings: { labelMode, snapToEndpoints },
      rivers,
    };
  }

  /**
   * Render vector rivers on top of the map.
   * @param {Object} riversData - normalized rivers data
   */
  renderVectorRivers(riversData = this.vectorRiversData, metadata = this.currentMetadata) {
    if (!this.riversLayer || !this.riverLabelsLayer) return;

    const animate = this._isGlobalMapAppearanceAnimationEnabled();
    const rotateLabels = this._isGlobalMapRiverLabelRotationEnabled();

    // Reset cached metadata (hit tests should follow current data immediately)
    this._riverLabelAnchors.clear();
    this._riverBounds.clear();
    this._hoveredRiverId = null;
    this._riverHoverLabel = null;

    const rivers = riversData?.rivers || [];
    if (!Array.isArray(rivers) || rivers.length === 0) {
      // Fade out previous visuals if any
      this._crossFadeLayer(this.riversLayer, null);
      this._crossFadeLayer(this.riverLabelsLayer, null);
      return;
    }

    const labelMode = riversData?.settings?.labelMode || 'hover';

    // ===== Shapes =====
    const riverGraphics = new PIXI.Graphics();
    riverGraphics.name = 'globalMapVectorRiversGraphics';

    // Default river color: match "Океан" biome color so mouths blend without special logic
    const oceanBiomeId = this.biomeResolver?.getBiomeId?.(6, 3) ?? 2; // moisture=6 (ocean), temperature=3 (temperate)
    const defaultColor = this.biomeResolver?.getBiomeColor?.(oceanBiomeId) ?? 0x1A4780;

    for (const river of rivers) {
      const pts = Array.isArray(river?.points) ? river.points : [];
      if (pts.length < 2) continue;

      const { bounds, maxWidth } = this._computeRiverBounds(pts);
      const pad = maxWidth / 2 + 10;
      this._riverBounds.set(river.id, { ...bounds, pad });

      // Midpoint anchor is still useful for Always labels (and for future features)
      const anchor = this._computePolylineMidpointWithTangent(pts);
      if (anchor) {
        this._riverLabelAnchors.set(river.id, anchor);
      }

      this._drawVectorRiverStamped(riverGraphics, pts, river.color ?? defaultColor);
    }

    const riversGroup = new PIXI.Container();
    riversGroup.name = 'globalMapVectorRiversGroup';
    riversGroup.addChild(riverGraphics);

    // ===== Labels =====
    let labelsGroup = null;
    if (labelMode !== 'off') {
      labelsGroup = new PIXI.Container();
      labelsGroup.name = 'globalMapVectorRiverLabelsGroup';

      if (labelMode === 'always') {
        for (const river of rivers) {
          const anchor = this._riverLabelAnchors.get(river?.id);
          if (!anchor || !river?.name) continue;

          const text = this._createRiverLabelText(String(river.name), anchor.width);
          text.position.set(anchor.x, anchor.y);
          text.rotation = rotateLabels ? anchor.angle : 0;
          labelsGroup.addChild(text);
        }
      }

      if (labelMode === 'hover') {
        this._riverHoverLabel = this._createRiverLabelText('');
        this._riverHoverLabel.visible = false;
        this._riverHoverLabel.alpha = animate ? 0 : 1;
        labelsGroup.addChild(this._riverHoverLabel);
      }
    }

    // Cross-fade (or instant swap) for smooth appearance
    this._crossFadeLayer(this.riversLayer, riversGroup);
    this._crossFadeLayer(this.riverLabelsLayer, labelsGroup);
  }

  /**
   * Install hover handler for showing river names.
   * @private
   */
  _installRiverHoverHandler() {
    if (!canvas?.stage) return;

    // Remove previous handler
    if (this._riverHoverHandler) {
      try {
        canvas.stage.off('pointermove', this._riverHoverHandler);
      } catch (e) {
        // ignore
      }
    }

    this._riverHoverHandler = (event) => {
      try {
        this._handleRiverHover(event);
      } catch (e) {
        // ignore
      }
    };

    canvas.stage.on('pointermove', this._riverHoverHandler);
  }

  /**
   * Handle pointer move for hover labels.
   * @private
   */
  _handleRiverHover(event) {
    const labelMode = this.vectorRiversData?.settings?.labelMode || 'hover';
    if (labelMode !== 'hover') {
      this._hideDisplayObjectWithFade(this._riverHoverLabel);
      this._hoveredRiverId = null;
      return;
    }

    if (!this.isVisible || !this._riverHoverLabel) {
      return;
    }

    const rivers = this.vectorRiversData?.rivers || [];
    if (!Array.isArray(rivers) || rivers.length === 0) {
      this._hideDisplayObjectWithFade(this._riverHoverLabel);
      this._hoveredRiverId = null;
      return;
    }

    const pos = event?.data?.getLocalPosition?.(canvas.stage);
    if (!pos) return;

    const hit = this._findNearestRiverHit(pos.x, pos.y, rivers);
    if (!hit) {
      this._hideDisplayObjectWithFade(this._riverHoverLabel);
      this._hoveredRiverId = null;
      return;
    }

    const river = rivers.find(r => r?.id === hit.riverId);
    if (!river?.name) {
      this._hideDisplayObjectWithFade(this._riverHoverLabel);
      this._hoveredRiverId = null;
      return;
    }

    const rotateLabels = this._isGlobalMapRiverLabelRotationEnabled();

    // Update label (width may change along the river)
    this._riverHoverLabel.text = String(river.name);
    this._riverHoverLabel.style = this._getRiverLabelStyle(hit.width);
    this._riverHoverLabel.rotation = rotateLabels ? hit.angle : 0;
    if (this._riverHoverLabel.scale?.set) this._riverHoverLabel.scale.set(1);

    this._riverHoverLabel.position.set(hit.x, hit.y);

    this._showDisplayObjectWithFade(this._riverHoverLabel);

    this._hoveredRiverId = hit.riverId;
  }

  /**
   * Create PIXI.Text for river labels.
   * @private
   */
  _getRiverLabelStyle(widthPx) {
    const baseFontSize = 18;
    const baseStrokeThickness = 4;

    const w = Number(widthPx);
    if (!Number.isFinite(w) || w <= 0) {
      return new PIXI.TextStyle({
        fontFamily: 'IBM Plex Sans',
        fontSize: baseFontSize,
        fill: '#ffffff',
        stroke: '#000000',
        strokeThickness: baseStrokeThickness,
      });
    }

    // Default river width is 24px; map 24px -> fontSize 18.
    const desiredFontSize = w * 0.75;
    const fontSize = Math.max(10, Math.min(72, Math.round(desiredFontSize)));
    const strokeThickness = Math.max(2, Math.min(18, Math.round(fontSize * (baseStrokeThickness / baseFontSize))));

    return new PIXI.TextStyle({
      fontFamily: 'IBM Plex Sans',
      fontSize,
      fill: '#ffffff',
      stroke: '#000000',
      strokeThickness,
    });
  }

  _createRiverLabelText(text, widthPx = null) {
    const style = this._getRiverLabelStyle(widthPx);

    const t = new PIXI.Text(text, style);
    t.name = 'globalMapRiverLabel';
    if (t.anchor?.set) t.anchor.set(0.5);
    return t;
  }

  /**
   * Draw a vector river by stamping overlapping circles along each segment.
   * This approach avoids gaps on joins and supports variable width.
   * @private
   */
  _drawVectorRiverStamped(graphics, points, color) {
    if (!graphics || !points || points.length < 2) return;

    // Rivers should be opaque (0% transparency)
    graphics.beginFill(color, 1.0);

    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];

      const x0 = p0.x;
      const y0 = p0.y;
      const x1 = p1.x;
      const y1 = p1.y;

      const w0 = Number.isFinite(p0.width) ? p0.width : 24;
      const w1 = Number.isFinite(p1.width) ? p1.width : w0;

      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.sqrt(dx * dx + dy * dy);

      // Degenerate segment: just stamp once
      if (len < 0.001) {
        const r = Math.max(0.5, w0 / 2);
        graphics.drawCircle(x0, y0, r);
        continue;
      }

      const r0 = Math.max(0.5, w0 / 2);
      const r1 = Math.max(0.5, w1 / 2);

      // Stamp density:
      // Previously we used avg radius -> if width changes a lot, avg gets large and thin parts become under-sampled.
      // Use the minimum radius to guarantee enough overlap across the whole segment.
      const minR = Math.min(r0, r1);
      const step = Math.max(1, minR * 0.75);
      const steps = Math.max(1, Math.ceil(len / step));

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = x0 + dx * t;
        const y = y0 + dy * t;
        const r = r0 * (1 - t) + r1 * t;
        graphics.drawCircle(x, y, r);
      }
    }

    graphics.endFill();
  }

  /**
   * Compute bounding box and max width for a river polyline.
   * @private
   */
  _computeRiverBounds(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxWidth = 0;

    for (const p of points) {
      if (!p) continue;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
      if (Number.isFinite(p.width) && p.width > maxWidth) maxWidth = p.width;
    }

    if (!Number.isFinite(minX)) {
      minX = minY = maxX = maxY = 0;
    }

    return { bounds: { minX, minY, maxX, maxY }, maxWidth };
  }

  /**
   * Compute midpoint (by length) of a polyline.
   * @private
   */
  _computePolylineMidpoint(points) {
    if (!points || points.length < 2) return null;

    // Total length
    let total = 0;
    const segLens = [];
    for (let i = 0; i < points.length - 1; i++) {
      const dx = points[i + 1].x - points[i].x;
      const dy = points[i + 1].y - points[i].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      segLens.push(len);
      total += len;
    }

    if (total < 0.001) {
      return { x: points[0].x, y: points[0].y };
    }

    const target = total / 2;
    let acc = 0;
    for (let i = 0; i < segLens.length; i++) {
      const len = segLens[i];
      if (acc + len >= target) {
        const t = (target - acc) / Math.max(0.0001, len);
        const x = points[i].x + (points[i + 1].x - points[i].x) * t;
        const y = points[i].y + (points[i + 1].y - points[i].y) * t;
        return { x, y };
      }
      acc += len;
    }

    return { x: points[points.length - 1].x, y: points[points.length - 1].y };
  }

  _normalizeUprightAngle(angleRad) {
    let a = Number(angleRad);
    if (!Number.isFinite(a)) return 0;

    const TAU = Math.PI * 2;

    // Wrap to (-PI, PI]
    while (a <= -Math.PI) a += TAU;
    while (a > Math.PI) a -= TAU;

    // Clamp to [-PI/2, PI/2] so text is never upside down
    if (a > Math.PI / 2) a -= Math.PI;
    if (a < -Math.PI / 2) a += Math.PI;

    // Guard against floating point drift
    if (a > Math.PI / 2) a = Math.PI / 2;
    if (a < -Math.PI / 2) a = -Math.PI / 2;

    return a;
  }

  _computePolylineMidpointWithTangent(points) {
    if (!points || points.length < 2) return null;

    // Total length
    let total = 0;
    const segLens = [];
    for (let i = 0; i < points.length - 1; i++) {
      const dx = points[i + 1].x - points[i].x;
      const dy = points[i + 1].y - points[i].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      segLens.push(len);
      total += len;
    }

    const defaultWidth = 24;

    if (total < 0.001) {
      const p0 = points[0];
      const p1 = points[1];
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const w0 = Number.isFinite(p0.width) ? p0.width : defaultWidth;

      return {
        x: p0.x,
        y: p0.y,
        angle: this._normalizeUprightAngle(Math.atan2(dy, dx)),
        width: w0,
        segIndex: 0,
        t: 0,
      };
    }

    const target = total / 2;
    let acc = 0;

    for (let i = 0; i < segLens.length; i++) {
      const len = segLens[i];
      if (len < 0.0001) {
        acc += len;
        continue;
      }

      const p0 = points[i];
      const p1 = points[i + 1];

      if (acc + len >= target) {
        const t = (target - acc) / len;
        const x = p0.x + (p1.x - p0.x) * t;
        const y = p0.y + (p1.y - p0.y) * t;

        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const angle = this._normalizeUprightAngle(Math.atan2(dy, dx));

        const w0 = Number.isFinite(p0.width) ? p0.width : defaultWidth;
        const w1 = Number.isFinite(p1.width) ? p1.width : w0;
        const width = w0 * (1 - t) + w1 * t;

        return { x, y, angle, width, segIndex: i, t };
      }

      acc += len;
    }

    // Fallback: last segment direction
    const lastIdx = Math.max(0, points.length - 2);
    const p0 = points[lastIdx];
    const p1 = points[lastIdx + 1];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;

    const w1 = Number.isFinite(p1.width) ? p1.width : (Number.isFinite(p0.width) ? p0.width : defaultWidth);

    return {
      x: p1.x,
      y: p1.y,
      angle: this._normalizeUprightAngle(Math.atan2(dy, dx)),
      width: w1,
      segIndex: lastIdx,
      t: 1,
    };
  }

  /**
   * Find nearest river hit for hover label.
   * @private
   */
  _findNearestRiverHit(x, y, rivers) {
    let best = null;
    let bestDistSq = Infinity;

    for (const river of rivers) {
      const pts = river?.points;
      if (!pts || pts.length < 2) continue;

      const rb = this._riverBounds.get(river.id);
      if (rb) {
        const pad = rb.pad ?? 0;
        if (x < rb.minX - pad || x > rb.maxX + pad || y < rb.minY - pad || y > rb.maxY + pad) {
          continue;
        }
      }

      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];

        const proj = this._projectPointToSegment(x, y, p0.x, p0.y, p1.x, p1.y);
        const distSq = proj.distSq;

        const w0 = Number.isFinite(p0.width) ? p0.width : 24;
        const w1 = Number.isFinite(p1.width) ? p1.width : w0;
        const threshold = Math.max(w0, w1) / 2 + 6;

        if (distSq <= threshold * threshold && distSq < bestDistSq) {
          bestDistSq = distSq;

          const dx = p1.x - p0.x;
          const dy = p1.y - p0.y;
          const angle = this._normalizeUprightAngle(Math.atan2(dy, dx));

          const t = proj.t;
          const width = w0 * (1 - t) + w1 * t;

          best = {
            riverId: river.id,
            distSq,
            x: proj.cx,
            y: proj.cy,
            angle,
            width,
            segIndex: i,
            t,
          };
        }
      }
    }

    return best;
  }

  /**
   * Distance from point to segment squared.
   * @private
   */
  _projectPointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;

    // Degenerate segment
    if (lenSq === 0) {
      const ax = px - x1;
      const ay = py - y1;
      return { t: 0, cx: x1, cy: y1, distSq: ax * ax + ay * ay };
    }

    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const cx = x1 + t * dx;
    const cy = y1 + t * dy;

    const ex = px - cx;
    const ey = py - cy;
    const distSq = ex * ex + ey * ey;

    return { t, cx, cy, distSq };
  }

  /**
   * Distance from point to segment squared.
   * @private
   */
  _distancePointToSegmentSq(px, py, x1, y1, x2, y2) {
    const hit = this._projectPointToSegment(px, py, x1, y1, x2, y2);
    return hit.distSq;
  }

  /**
   * Render rivers layer with smooth Bezier curves and variable width
   * @private
   */
  _renderRiversLayer(gridData, metadata) {
    const { rivers, biomes, moisture, temperature, rows, cols } = gridData;
    const { cellSize, bounds } = metadata;

    if (!rivers) return;

    // Rivers currently rely on ocean detection via legacy moisture/temperature.
    // If those arrays are missing (v4+ saves), derive them from biome IDs.
    let moistureIds = moisture;
    let temperatureIds = temperature;

    if ((!moistureIds || !temperatureIds) && biomes && biomes.length === rows * cols) {
      moistureIds = new Uint8Array(rows * cols);
      temperatureIds = new Uint8Array(rows * cols);

      for (let i = 0; i < rows * cols; i++) {
        const params = this.biomeResolver.getParametersFromBiomeId(biomes[i]);
        moistureIds[i] = params?.moisture ?? 0;
        temperatureIds[i] = params?.temperature ?? 0;
      }
    }

    if (!moistureIds || !temperatureIds) {
      console.warn('GlobalMapRenderer | Rivers: missing moisture/temperature and cannot derive from biomes');
      return;
    }

    // Count rivers for logging
    let riverCount = 0;
    for (let i = 0; i < rivers.length; i++) {
      if (rivers[i] === 1) riverCount++;
    }

    if (riverCount === 0) {
      console.log('GlobalMapRenderer | No rivers to render');
      return;
    }

    console.log(`GlobalMapRenderer | Rendering ${riverCount} river cells with Bezier curves...`);

    // Find all river paths (from ocean mouths to sources)
    const { paths: riverPaths, mainRiverCount, riverColors } = this._extractRiverPaths(rivers, moistureIds, temperatureIds, rows, cols);
    
    console.log(`GlobalMapRenderer | Found ${riverPaths.length} river paths (${mainRiverCount} main, ${riverPaths.length - mainRiverCount} branches)`);

    // Render each river path
    const graphics = new PIXI.Graphics();

    for (let i = 0; i < riverPaths.length; i++) {
      const path = riverPaths[i];
      // Первые mainRiverCount путей - основные реки, остальные - ветки
      const isSubRiver = i >= mainRiverCount;
      const riverColor = riverColors[i] || 0x3A9BD9; // Цвет от океана или дефолтный
      console.log(`GlobalMapRenderer | Drawing river ${i}: isSubRiver=${isSubRiver}, pathLength=${path.length}, color=${riverColor.toString(16)}`);
      this._drawRiverPath(graphics, path, bounds, cellSize, riverColor, isSubRiver);
    }

    this.riversLayer.addChild(graphics);
    console.log(`GlobalMapRenderer | ✓ Rivers rendered: ${riverPaths.length} paths`);
  }

  /**
   * Extract river paths from grid
   * Starts from ocean cells (moisture=6) and traces inland
   * Builds linear paths with proper ordering and handles branches
   * @private
   */
  _extractRiverPaths(rivers, moisture, temperature, rows, cols) {
    const paths = [];
    const riverColors = []; // Цвета рек (от океанов)
    const drawnCells = new Set(); // Клетки, уже нарисованные в каких-либо реках

    // Helper: get cell index
    const idx = (row, col) => row * cols + col;

    // Helper: check if cell is ocean (moisture = 6)
    const isOcean = (row, col) => {
      if (row < 0 || row >= rows || col < 0 || col >= cols) return false;
      return moisture[idx(row, col)] === 6;
    };

    // Helper: check if cell has river
    const hasRiver = (row, col) => {
      if (row < 0 || row >= rows || col < 0 || col >= cols) return false;
      return rivers[idx(row, col)] === 1;
    };

    // Helper: check if two cells are direct neighbors (share edge, not diagonal)
    const isDirectNeighbor = (cell1, cell2) => {
      const dr = Math.abs(cell1.row - cell2.row);
      const dc = Math.abs(cell1.col - cell2.col);
      return (dr === 1 && dc === 0) || (dr === 0 && dc === 1);
    };

    // Helper: check if two cells are neighbors (8-connectivity)
    const areNeighbors = (cell1, cell2) => {
      const dr = Math.abs(cell1.row - cell2.row);
      const dc = Math.abs(cell1.col - cell2.col);
      return dr <= 1 && dc <= 1 && (dr !== 0 || dc !== 0);
    };

    // Helper: get most aligned neighbor (continues in same direction)
    const getMostOppositeNeighbor = (current, prev, neighbors) => {
      if (neighbors.length === 0) return null;
      if (neighbors.length === 1) return neighbors[0];

      // If prev is same as current (no direction), just return first
      if (prev.row === current.row && prev.col === current.col) {
        return neighbors[0];
      }

      // Calculate direction vector from prev to current
      const dirRow = current.row - prev.row;
      const dirCol = current.col - prev.col;

      // Normalize direction (just for clarity, not strictly needed)
      const dirLen = Math.sqrt(dirRow * dirRow + dirCol * dirCol);
      const normDirRow = dirRow / dirLen;
      const normDirCol = dirCol / dirLen;

      // Find neighbor most aligned with this direction
      let bestNeighbor = neighbors[0];
      let bestDot = -Infinity;

      for (const neighbor of neighbors) {
        const nDirRow = neighbor.row - current.row;
        const nDirCol = neighbor.col - current.col;
        const nDirLen = Math.sqrt(nDirRow * nDirRow + nDirCol * nDirCol);
        const normNDirRow = nDirRow / nDirLen;
        const normNDirCol = nDirCol / nDirLen;
        
        // Dot product: 1 = same direction, -1 = opposite, 0 = perpendicular
        const dot = normDirRow * normNDirRow + normDirCol * normNDirCol;
        
        if (dot > bestDot) {
          bestDot = dot;
          bestNeighbor = neighbor;
        }
      }

      console.log(`GlobalMapRenderer | Selected neighbor (${bestNeighbor.row}, ${bestNeighbor.col}) with dot=${bestDot.toFixed(2)}`);
      return bestNeighbor;
    };

    // Step 1: Find all river mouths (river cells adjacent to ocean)
    const qRivers = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (!hasRiver(row, col)) continue;
        
        // Check if adjacent to ocean
        let hasOceanNeighbor = false;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            if (isOcean(row + dr, col + dc)) {
              hasOceanNeighbor = true;
              break;
            }
          }
          if (hasOceanNeighbor) break;
        }
        
        if (hasOceanNeighbor) {
          qRivers.push({ row, col });
        }
      }
    }

    console.log(`GlobalMapRenderer | Found ${qRivers.length} river mouths`);

    // Step 2: Process main rivers
    const qSubRivers = [];
    let mainRiverCount = 0;

    for (const mouth of qRivers) {
      const cellIdx = idx(mouth.row, mouth.col);
      if (drawnCells.has(cellIdx)) {
        console.log(`GlobalMapRenderer | Mouth at (${mouth.row}, ${mouth.col}) already drawn, skipping`);
        continue;
      }

      const riverPath = this._traceRiver(mouth, null, drawnCells, qSubRivers, {
        idx, isOcean, hasRiver, isDirectNeighbor, areNeighbors, getMostOppositeNeighbor,
        rows, cols
      }, null); // parentColor = null для основных рек

      console.log(`GlobalMapRenderer | Traced river from (${mouth.row}, ${mouth.col}), path length: ${riverPath ? riverPath.length : 0}`);

      if (riverPath && riverPath.length >= 2) {
        paths.push(riverPath);
        
        // Определяем цвет от океана
        const oceanColor = this._getOceanColorForMouth(mouth, moisture, temperature, rows, cols, idx);
        riverColors.push(oceanColor);
        
        // Передаём цвет всем веткам этой реки
        for (const subRiver of qSubRivers) {
          if (subRiver.parentColor === null) {
            subRiver.parentColor = oceanColor;
          }
        }
        
        mainRiverCount++; // Считаем только реально добавленные реки
      } else if (riverPath && riverPath.length === 1) {
        console.log(`GlobalMapRenderer | River path too short (1 cell), skipping`);
      }
    }

    // Step 3: Process sub-rivers (branches)
    console.log(`GlobalMapRenderer | Found ${qSubRivers.length} river branches`);

    for (const subRiver of qSubRivers) {
      const cellIdx = idx(subRiver.start.row, subRiver.start.col);
      if (drawnCells.has(cellIdx)) continue;

      const riverPath = this._traceRiver(subRiver.start, subRiver.parent, drawnCells, qSubRivers, {
        idx, isOcean, hasRiver, isDirectNeighbor, areNeighbors, getMostOppositeNeighbor,
        rows, cols
      }, subRiver.parentColor); // Передаём цвет родителя

      if (riverPath && riverPath.length >= 1) {
        // Добавляем родительскую клетку в начало пути для соединения
        riverPath.unshift(subRiver.parent);
        paths.push(riverPath);
        
        // Ветки наследуют цвет родительской реки
        riverColors.push(subRiver.parentColor || 0x3A9BD9);
      }
    }

    return { paths, mainRiverCount, riverColors };
  }

  /**
   * Get ocean color for river mouth
   * Determines color based on ocean biome adjacent to mouth
   * @private
   */
  _getOceanColorForMouth(mouth, moisture, temperature, rows, cols, idx) {
    // Найти соседние океаны
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nRow = mouth.row + dr;
        const nCol = mouth.col + dc;
        
        if (nRow < 0 || nRow >= rows || nCol < 0 || nCol >= cols) continue;
        
        const nIdx = idx(nRow, nCol);
        const nMoisture = moisture[nIdx];
        
        // Проверяем, что это океан (moisture = 6)
        if (nMoisture === 6) {
          const nTemperature = temperature[nIdx];
          const oceanBiomeId = this.biomeResolver.getBiomeId(nMoisture, nTemperature, 0);
          const oceanColor = this.biomeResolver.getBiomeColor(oceanBiomeId);
          
          console.log(`GlobalMapRenderer | River mouth at (${mouth.row}, ${mouth.col}) uses ocean color from biome ${oceanBiomeId}: #${oceanColor.toString(16).padStart(6, '0')}`);
          return oceanColor;
        }
      }
    }
    
    // Дефолтный цвет воды
    return 0x3A9BD9;
  }

  /**
   * Trace a single river from start cell
   * @private
   */
  _traceRiver(start, prevCell, drawnCells, qSubRivers, helpers, parentColor) {
    const { idx, isOcean, hasRiver, isDirectNeighbor, areNeighbors, getMostOppositeNeighbor, rows, cols } = helpers;
    const path = [];
    let current = start;
    let prev = prevCell;
    let isFirstCell = (prev === null);
    let stepCount = 0;
    const maxSteps = 1000; // Защита от бесконечного цикла

    while (current && stepCount < maxSteps) {
      stepCount++;
      const cellIdx = idx(current.row, current.col);
      
      // Skip if already drawn
      if (drawnCells.has(cellIdx)) {
        break;
      }

      // Add to path and mark as drawn
      path.push(current);
      drawnCells.add(cellIdx);

      // Lookup neighbors
      const oceanNeighbors = [];
      const riverNeighbors = [];
      let totalRiverNeighbors = 0; // Сколько всего соседей-рек (включая уже нарисованные)

      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nRow = current.row + dr;
          const nCol = current.col + dc;
          if (nRow < 0 || nRow >= rows || nCol < 0 || nCol >= cols) continue;

          const neighbor = { row: nRow, col: nCol };
          const nIdx = idx(nRow, nCol);

          // Skip previous cell
          if (prev && prev.row === nRow && prev.col === nCol) continue;

          if (isOcean(nRow, nCol)) {
            oceanNeighbors.push({ ...neighbor, isDirect: isDirectNeighbor(current, neighbor) });
          } else if (hasRiver(nRow, nCol)) {
            totalRiverNeighbors++;
            if (!drawnCells.has(nIdx)) {
              riverNeighbors.push({ ...neighbor, isDirect: isDirectNeighbor(current, neighbor) });
            }
          }
        }
      }

      console.log(`GlobalMapRenderer | Cell (${current.row}, ${current.col}): oceans=${oceanNeighbors.length}, rivers=${riverNeighbors.length}, totalRivers=${totalRiverNeighbors}, prev=${prev ? `(${prev.row}, ${prev.col})` : 'null'}`);

      // Decision logic
      let nextCell = null;

      if (isFirstCell) {
        console.log(`GlobalMapRenderer | First cell logic: oceanNeighbors=${oceanNeighbors.length}, riverNeighbors=${riverNeighbors.length}`);
        
        // First cell: check for strait/channel pattern
        if (oceanNeighbors.length >= 2 && riverNeighbors.length === 0) {
          // Check if oceans are NOT neighbors to each other
          const ocean1 = oceanNeighbors[0];
          const ocean2 = oceanNeighbors[1];
          if (!areNeighbors(ocean1, ocean2)) {
            // This is a strait - just a connector, end here
            console.log(`GlobalMapRenderer | Detected strait at (${current.row}, ${current.col}), ending`);
            break;
          }
        }

        // Prefer direct ocean neighbor for mouth
        const directOcean = oceanNeighbors.find(n => n.isDirect);
        if (directOcean) {
          prev = directOcean; // Set ocean as prev for direction
          console.log(`GlobalMapRenderer | Set prev to direct ocean at (${prev.row}, ${prev.col})`);
        } else if (oceanNeighbors.length > 0) {
          prev = oceanNeighbors[0];
          console.log(`GlobalMapRenderer | Set prev to diagonal ocean at (${prev.row}, ${prev.col})`);
        }

        isFirstCell = false;
      }

      // Find next river cell
      if (riverNeighbors.length === 0) {
        // No river neighbors - check if this is end or another ocean mouth
        if (oceanNeighbors.length > 0) {
          console.log(`GlobalMapRenderer | River ends at another ocean at (${current.row}, ${current.col})`);
        } else {
          console.log(`GlobalMapRenderer | End of river at (${current.row}, ${current.col}), no more neighbors`);
        }
        break;
      } else if (riverNeighbors.length === 1) {
        // Single neighbor - continue
        nextCell = riverNeighbors[0];
      } else {
        // Multiple neighbors - junction
        // Choose most opposite to previous direction
        nextCell = getMostOppositeNeighbor(current, prev || current, riverNeighbors);

        // Add other branches to sub-rivers queue
        for (const neighbor of riverNeighbors) {
          if (neighbor.row !== nextCell.row || neighbor.col !== nextCell.col) {
            qSubRivers.push({ 
              start: neighbor, 
              parent: current,
              parentColor: parentColor // Наследуем цвет от текущей реки
            });
          }
        }
      }

      // Move to next cell
      prev = current;
      current = nextCell;
    }

    return path;
  }

  /**
   * Draw a single river path with smooth Bezier curves and variable width
   * Width decreases from mouth (wide) to source (narrow)
   * @private
   */
  _drawRiverPath(graphics, path, bounds, cellSize, color, isSubRiver = false) {
    if (path.length < 2) return;

    // Convert path cells to world coordinates
    const points = path.map(cell => ({
      x: bounds.minX + cell.col * cellSize,
      y: bounds.minY + cell.row * cellSize
    }));

    // Define width range
    // Для саб-рек начальная ширина меньше (они впадают в основную реку)
    const maxWidth = isSubRiver 
      ? Math.max(2, cellSize * 0.4) // Узкое устье для веток
      : Math.max(3, cellSize * 0.8); // Широкое устье для основных рек
    const minWidth = Math.max(1, cellSize * 0.15); // Narrow at source
    
    console.log(`GlobalMapRenderer | _drawRiverPath: isSubRiver=${isSubRiver}, maxWidth=${maxWidth.toFixed(2)}, minWidth=${minWidth.toFixed(2)}, cellSize=${cellSize}`);

    // Special case: very short paths (2 points - just connection)
    if (points.length === 2) {
      // Draw circles along the path with decreasing radius
      const p1 = points[0];
      const p2 = points[1];
      
      // Calculate direction and length
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      
      if (length > 0) {
        // Draw circles with decreasing radius
        const circleCount = Math.max(5, Math.ceil(length / (maxWidth * 0.3)));
        
        for (let i = 0; i <= circleCount; i++) {
          const t = i / circleCount;
          const radius = (maxWidth * (1 - t) + minWidth * t) / 2;
          
          const x = p1.x + dx * t;
          const y = p1.y + dy * t;
          
          graphics.beginFill(color, 0.9);
          graphics.drawCircle(x, y, radius);
          graphics.endFill();
        }
      }
      return;
    }

    // Normal case: smooth the path with Catmull-Rom spline
    const smoothPoints = this._smoothPathCatmullRom(points, 0.5, 10);

    // Draw as overlapping circles with varying radius
    // Увеличиваем частоту кругов чтобы избежать пробелов
    for (let i = 0; i < smoothPoints.length; i++) {
      const t = i / (smoothPoints.length - 1);
      // Radius decreases from mouth (t=0) to source (t=1)
      const radius = (maxWidth * (1 - t) + minWidth * t) / 2;

      const point = smoothPoints[i];

      graphics.beginFill(color, 0.9);
      graphics.drawCircle(point.x, point.y, radius);
      graphics.endFill();
      
      // Добавляем промежуточные круги между точками для избежания пробелов
      if (i < smoothPoints.length - 1) {
        const nextPoint = smoothPoints[i + 1];
        const nextT = (i + 1) / (smoothPoints.length - 1);
        const nextRadius = (maxWidth * (1 - nextT) + minWidth * nextT) / 2;
        
        // Вычисляем расстояние между точками
        const dx = nextPoint.x - point.x;
        const dy = nextPoint.y - point.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        // Определяем сколько промежуточных кругов нужно
        const avgRadius = (radius + nextRadius) / 2;
        const extraCircles = Math.ceil(dist / (avgRadius * 0.8)) - 1;
        
        // Рисуем промежуточные круги
        for (let j = 1; j <= extraCircles; j++) {
          const interpT = j / (extraCircles + 1);
          const interpRadius = radius * (1 - interpT) + nextRadius * interpT;
          const interpX = point.x + dx * interpT;
          const interpY = point.y + dy * interpT;
          
          graphics.beginFill(color, 0.9);
          graphics.drawCircle(interpX, interpY, interpRadius);
          graphics.endFill();
        }
      }
    }
  }

  /**
   * Smooth path using Catmull-Rom spline
   * @private
   */
  _smoothPathCatmullRom(points, tension = 0.5, segments = 10) {
    if (points.length < 2) return points;
    if (points.length === 2) return points;

    const smoothed = [];

    // Add first point
    smoothed.push(points[0]);

    // Interpolate between points
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];

      for (let t = 0; t < segments; t++) {
        const tt = t / segments;
        const tt2 = tt * tt;
        const tt3 = tt2 * tt;

        // Catmull-Rom basis
        const q0 = -tension * tt3 + 2 * tension * tt2 - tension * tt;
        const q1 = (2 - tension) * tt3 + (tension - 3) * tt2 + 1;
        const q2 = (tension - 2) * tt3 + (3 - 2 * tension) * tt2 + tension * tt;
        const q3 = tension * tt3 - tension * tt2;

        const x = p0.x * q0 + p1.x * q1 + p2.x * q2 + p3.x * q3;
        const y = p0.y * q0 + p1.y * q1 + p2.y * q2 + p3.y * q3;

        smoothed.push({ x, y });
      }
    }

    // Add last point
    smoothed.push(points[points.length - 1]);

    return smoothed;
  }

  /**
   * Convert normalized height (0-1) to RGB color
   * Blue (low) -> Green -> Yellow -> Red (high)
   * @private
   */
  _heightToColor(normalized) {
    // Clamp normalized to 0-1 range
    normalized = Math.max(0, Math.min(1, normalized));
    
    let r = 0, g = 0, b = 0;

    if (normalized < 0.25) {
      // Blue to Green
      const t = normalized / 0.25;
      r = 0;
      g = Math.floor(255 * t);
      b = 255;
    } else if (normalized < 0.5) {
      // Green to Yellow
      const t = (normalized - 0.25) / 0.25;
      r = Math.floor(255 * t);
      g = 255;
      b = 0;
    } else if (normalized < 0.75) {
      // Yellow to Orange
      const t = (normalized - 0.5) / 0.25;
      r = 255;
      g = Math.floor(255 * (1 - t * 0.5));
      b = 0;
    } else {
      // Orange to Red
      const t = (normalized - 0.75) / 0.25;
      r = 255;
      g = Math.floor(200 * (1 - t));
      b = 0;
    }
    
    // Apply mask to ensure positive hex value
    return ((r << 16) | (g << 8) | b) & 0xFFFFFF;
  }

}

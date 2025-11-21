import { BIOME_SETTINGS, getBiomeColor } from './biome-config.mjs';

/**
 * Biome Renderer
 * Renders biome visualization as colored cells
 * 
 * @deprecated This component is deprecated and scheduled for replacement.
 * Currently used for rendering legacy biome data only.
 */
export class BiomeRenderer {
  constructor(biomeManager) {
    this.biomeManager = biomeManager;
    this.biomeContainer = null;
    this.isVisible = false;
    
    // Shared terrain field manager (will be set from outside)
    this.terrainFieldManager = null;
  }

  /**
   * Initialize the renderer
   * @deprecated
   */
  initialize() {
    console.warn('DEPRECATED BiomeRenderer | This component is scheduled for replacement. See .deprecated.md');
    console.log('BiomeRenderer | Initializing...');
    
    // Hook into canvas ready to set up rendering
    Hooks.on('canvasReady', async () => {
      await this.onCanvasReady();
    });
    
    // If canvas is already ready, load immediately
    if (canvas?.ready && canvas?.scene) {
      console.log('BiomeRenderer | Canvas already ready, checking for biome map...');
      setTimeout(async () => {
        await this.onInitialLoad();
      }, 200); // Wait for manager to load data
    }
  }

  /**
   * Called when canvas is ready
   */
  async onCanvasReady() {
    // Clear state when switching scenes
    this.isVisible = false;
    
    // Clear terrain field cache (shared with heightmap)
    if (this.terrainFieldManager) {
      this.terrainFieldManager.clearCache();
    }
    
    this.setupContainerLayer();
    
    // Wait a tick for manager to load scene data
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Auto-render if biome map data exists for THIS scene
    if (this.biomeManager.isLoaded()) {
      console.log('BiomeRenderer | Biome map data detected for current scene, auto-rendering...');
      await this.show();
    } else {
      console.log('BiomeRenderer | No biome map data for current scene');
    }
  }

  /**
   * Called on initial Foundry load to auto-show biome map if it exists
   */
  async onInitialLoad() {
    console.log('BiomeRenderer | Checking for biome map on initial load...');
    
    // Wait a bit longer for everything to initialize
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check if biome map data exists for current scene
    if (this.biomeManager.isLoaded()) {
      console.log('BiomeRenderer | Biome map found on initial load, auto-rendering...');
      
      // Setup container if not already done
      if (!this.biomeContainer) {
        this.setupContainerLayer();
      }
      
      // Auto-show biome map
      await this.show();
    } else {
      console.log('BiomeRenderer | No biome map data on initial load');
    }
  }

  /**
   * Set up the container layer on the interface layer
   */
  setupContainerLayer() {
    // Get the interface layer
    const interfaceLayer = canvas.interface;
    
    if (!interfaceLayer) {
      console.warn('BiomeRenderer | Interface layer not available');
      return;
    }

    // Clear any existing container
    if (this.biomeContainer) {
      this.biomeContainer.destroy({children: true});
    }

    // Create new container for biome map
    this.biomeContainer = new PIXI.Container();
    this.biomeContainer.name = 'biomeMapCells';
    
    // Add to interface layer
    interfaceLayer.addChild(this.biomeContainer);
    
    console.log('BiomeRenderer | Container layer set up');
  }

  /**
   * Render the biome map
   */
  async render() {
    if (!this.biomeManager.isLoaded()) {
      console.warn('BiomeRenderer | No biome map data available');
      ui.notifications.warn('Карта биомов не загружена для этой сцены');
      return;
    }

    console.log('BiomeRenderer | Rendering biome map...');

    // Make sure container is set up
    if (!this.biomeContainer) {
      this.setupContainerLayer();
    }

    // Clear existing graphics
    this.clear();

    const processedData = this.biomeManager.getProcessedData();
    const { biomePoints } = processedData;
    
    // Try to load from terrainFieldManager
    let terrainField, bounds, cellSize;
    const cached = this.terrainFieldManager?.getCachedTerrainField();
    
    if (cached) {
      console.log('BiomeRenderer | Using cached terrainField');
      terrainField = cached.terrainField;
      bounds = cached.bounds;
      cellSize = cached.cellSize;
    } else {
      // Try to load from file
      const loaded = await this.terrainFieldManager?.loadTerrainFieldFromFile(canvas.scene);
      
      if (loaded && loaded.terrainField.biomes) {
        console.log('BiomeRenderer | Loaded terrainField from file');
        terrainField = loaded.terrainField;
        bounds = loaded.bounds;
        cellSize = loaded.cellSize;
      } else {
        console.log('BiomeRenderer | Generating biome field from source data');
        
        // Calculate bounds and cell size
        bounds = this._calculateBounds(processedData);
        cellSize = this._calculateCellSize(processedData);
        
        console.log(`BiomeRenderer | Using cell size: ${cellSize}px`);
        
        // Create biome field (grid where each cell has nearest biome)
        const biomeField = this._createBiomeField(biomePoints, bounds, cellSize);
        
        // Create terrain field with biomes (heights will be null for now)
        const rows = biomeField.rows;
        const cols = biomeField.cols;
        terrainField = {
          biomes: biomeField.biomes,
          heights: new Float32Array(rows * cols), // Empty heights
          rows,
          cols
        };
        
        // Cache and save it
        if (this.terrainFieldManager) {
          this.terrainFieldManager.updateCache(terrainField, bounds, cellSize);
          
          // Save to file
          await this.terrainFieldManager.saveTerrainFieldToFile(
            terrainField,
            bounds,
            cellSize,
            canvas.scene,
            { biomeSource: 'Azgaar FMG' }
          );
        }
      }
    }
    
    // Draw biome field
    await this._drawBiomeField(terrainField, bounds, cellSize);

    this.isVisible = true;
    console.log('BiomeRenderer | Biome map rendered successfully');
  }

  /**
   * Calculate bounds based on scene dimensions
   */
  _calculateBounds(processedData) {
    // Use scene dimensions as bounds (same as heightmap)
    const sceneDimensions = canvas.scene.dimensions;
    
    return {
      minX: 0,
      minY: 0,
      maxX: sceneDimensions.width,
      maxY: sceneDimensions.height
    };
  }

  /**
   * Calculate appropriate cell size based on map data
   */
  _calculateCellSize(processedData) {
    const { mapWidth, mapHeight, biomePoints } = processedData;
    const totalArea = mapWidth * mapHeight;
    const numPoints = biomePoints.length;
    
    // Approximate Voronoi cell size
    const avgCellArea = totalArea / numPoints;
    const avgCellSize = Math.sqrt(avgCellArea);
    
    // Use grid size as base, but ensure we cover the area
    // Smaller cells = better coverage
    const cellSize = Math.max(8, Math.min(30, Math.round(avgCellSize / 2)));
    
    return cellSize;
  }

  /**
   * Create biome field - grid where each cell has nearest biome ID
   */
  _createBiomeField(biomePoints, bounds, cellSize) {
    const cols = Math.ceil((bounds.maxX - bounds.minX) / cellSize);
    const rows = Math.ceil((bounds.maxY - bounds.minY) / cellSize);
    const field = { biomes: new Uint8Array(rows * cols), rows, cols };
    
    console.log(`BiomeRenderer | Creating biomeField: ${rows}x${cols} cells`);
    
    // For each cell, find nearest biome point
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = bounds.minX + col * cellSize + cellSize / 2;
        const y = bounds.minY + row * cellSize + cellSize / 2;
        
        // Find nearest biome point
        let nearestBiome = 0;
        let minDistSq = Infinity;
        
        for (const point of biomePoints) {
          const dx = x - point.x;
          const dy = y - point.y;
          const distSq = dx * dx + dy * dy;
          
          if (distSq < minDistSq) {
            minDistSq = distSq;
            nearestBiome = point.biome;
          }
        }
        
        field.biomes[row * cols + col] = nearestBiome;
      }
    }
    
    console.log(`BiomeRenderer | ✓ BiomeField created successfully`);
    return field;
  }

  /**
   * Draw biome field as colored rectangles (complete coverage)
   */
  async _drawBiomeField(terrainField, bounds, cellSize) {
    const { biomes, rows, cols } = terrainField;
    
    // Group cells by biome ID for efficient rendering
    const biomeGroups = {};
    
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        const biomeId = biomes[idx];
        
        if (!biomeGroups[biomeId]) {
          biomeGroups[biomeId] = [];
        }
        
        biomeGroups[biomeId].push({ row, col });
      }
    }
    
    // Render each biome group
    for (const [biomeId, cells] of Object.entries(biomeGroups)) {
      const graphics = new PIXI.Graphics();
      const color = await getBiomeColor(parseInt(biomeId));
      const alpha = BIOME_SETTINGS.fillAlpha;
      
      graphics.beginFill(color, alpha);
      
      // Draw all cells of this biome
      for (const cell of cells) {
        const x = bounds.minX + cell.col * cellSize;
        const y = bounds.minY + cell.row * cellSize;
        graphics.drawRect(x, y, cellSize, cellSize);
      }
      
      graphics.endFill();
      
      // Optional: draw borders between biomes
      if (BIOME_SETTINGS.showBorders) {
        graphics.lineStyle(
          BIOME_SETTINGS.borderWidth,
          BIOME_SETTINGS.borderColor,
          BIOME_SETTINGS.borderAlpha
        );
        
        for (const cell of cells) {
          const x = bounds.minX + cell.col * cellSize;
          const y = bounds.minY + cell.row * cellSize;
          graphics.drawRect(x, y, cellSize, cellSize);
        }
      }
      
      graphics.name = `biome_${biomeId}`;
      graphics.interactive = false;
      this.biomeContainer.addChild(graphics);
    }
    
    console.log(`BiomeRenderer | ✓ Rendered ${Object.keys(biomeGroups).length} biome types with full coverage`);
  }

  /**
   * Clear all rendered biomes
   */
  clear() {
    if (this.biomeContainer) {
      this.biomeContainer.removeChildren();
    }
  }

  /**
   * Show the biome map
   */
  async show() {
    if (!this.biomeManager.isLoaded()) {
      console.warn('BiomeRenderer | No biome map loaded');
      ui.notifications.warn('Карта биомов не загружена для этой сцены');
      return;
    }

    // If container exists and has content, just show it
    if (this.biomeContainer && this.biomeContainer.children.length > 0) {
      this.biomeContainer.visible = true;
      this.isVisible = true;
      console.log('BiomeRenderer | Biome map shown (from cache)');
    } else {
      // Need to render
      await this.render();
      this.isVisible = true;
      console.log('BiomeRenderer | Biome map shown (rendered)');
    }
  }

  /**
   * Hide the biome map
   */
  hide() {
    if (this.biomeContainer) {
      this.biomeContainer.visible = false;
    }
    
    this.isVisible = false;
    console.log('BiomeRenderer | Biome map hidden');
  }

  /**
   * Toggle visibility of the biome map
   */
  async toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      await this.show();
    }
  }

  /**
   * Check if biome map is visible
   */
  isBiomeMapVisible() {
    return this.isVisible;
  }
}

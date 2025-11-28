/**
 * Global Map Tools
 * Editing and manipulation tools for unified grid
 * Handles user interactions like brush editing, flattening, smoothing
 */
export class GlobalMapTools {
  constructor(renderer, processing) {
    this.renderer = renderer;
    this.processing = processing;
    this.isActive = false;
    this.currentTool = 'set-biome'; // 'set-biome', 'raise', 'lower', 'smooth', 'flatten', 'modify-biome', 'draw-river', 'erase-river'
    this.brushRadius = 100;
    this.brushStrength = 0.5;
    this.singleCellMode = false; // If true, brush affects only one cell
    this.savedSingleCellMode = false; // Save state when switching to rivers tool
    this.targetHeight = 50;
    
    // New biome tools settings
    this.modifyTemp = 0; // -3 to 3
    this.modifyMoisture = 0; // -3 to 3
    this.modifyTempEnabled = false;
    this.modifyMoistureEnabled = false;
    this.setTemp = 3; // 1-5
    this.setMoisture = 3; // 1-6
    this.setTempEnabled = false;
    this.setMoistureEnabled = false;
    
    this.globalSmoothStrength = 1.0; // Strength for global smooth (0.1-1.0)
    
    // Brush filters - for Height tools (raise, lower, etc.)
    this.heightFilterEnabled = false; // Enable filtering in height tools
    this.heightFilterMin = 0; // Filter: min height (0-100)
    this.heightFilterMax = 100; // Filter: max height (0-100)
    this.heightFilterByBiomeEnabled = false; // Filter height tools by specific biomes
    this.heightFilterBiomeIds = new Set(); // Biome IDs to affect when editing heights
    
    // Brush filters - for Biome tools (modify-biome, set-biome)
    this.biomeFilterEnabled = false; // Enable filtering in biome tools
    this.biomeFilterHeightMin = 0; // Filter: min height (0-100)
    this.biomeFilterHeightMax = 100; // Filter: max height (0-100)
    this.biomeFilterByBiomeEnabled = false; // Filter biome tools by specific biomes
    this.biomeFilterExcludedIds = new Set(); // Biome IDs to exclude when editing biomes
    
    // Replace tool settings
    this.replaceSourceBiomeIds = new Set(); // Source biomes for replacement (multiple)
    this.replaceTargetBiomeId = null; // Target biome for replacement
    
    // Temperature/moisture editing
    this.tempOverlayTemp = null; // Temporary delta for temperature
    this.tempOverlayMoisture = null; // Temporary delta for moisture

    // Brush state
    this.isBrushActive = false; // Whether brush is currently active and ready to paint
    
    // Mouse state
    this.isMouseDown = false;
    this.lastPosition = null;
    this.tempOverlay = null; // Temporary delta layer for current stroke
    this.affectedCells = null; // Track which cells were affected by current stroke

    // UI elements
    this.brushCursor = null;
    this.brushPreview = null;
    this.overlayPreview = null; // Overlay showing affected cells
    this.cellHighlight = null; // Highlight for single cell mode
    this.inspectLabel = null;

    // Cell inspector
    this.isCellInspectorActive = false;
    this.cellInspectorHandler = null;
  }

  /**
   * Activate editing tools
   */
  activate() {
    if (this.isActive) return;

    console.log('GlobalMapTools | Activating...');
    this.isActive = true;

    // Show renderer if not visible
    if (!this.renderer.isVisible) {
      this.renderer.show();
    }

    // Set up event listeners
    this.setupEventListeners();

    // Create UI elements
    this.createBrushCursor();
    this.createOverlayPreview();
    this.showToolsUI();

    console.log('GlobalMapTools | ✓ Activated');
  }

  /**
   * Deactivate editing tools
   */
  async deactivate() {
    if (!this.isActive) return;

    console.log('GlobalMapTools | Deactivating...');
    this.isActive = false;

    // Destroy UI elements
    this.destroyBrushCursor();
    this.destroyOverlayPreview();
    this.hideToolsUI();

    console.log('GlobalMapTools | ✓ Deactivated');
  }

  /**
   * Activate brush for painting
   */
  activateBrush() {
    if (this.isBrushActive) return;
    
    // Sync currentTool with selected tool from active tab
    if ($('#brush-tab').is(':visible')) {
      // Heights tab is active
      const selectedTool = $('#global-map-tool').val();
      this.setTool(selectedTool);
      // Restore saved single cell mode
      this.singleCellMode = this.savedSingleCellMode;
    } else if ($('#biomes-tab').is(':visible')) {
      // Biomes tab is active
      const selectedTool = $('#global-map-biome-tool').val();
      this.setTool(selectedTool);
      // Restore saved single cell mode
      this.singleCellMode = this.savedSingleCellMode;
    } else if ($('#rivers-tab').is(':visible')) {
      // Rivers tab is active
      const selectedTool = $('#global-map-river-tool').val();
      this.setTool(selectedTool);
      
      // Save current mode and force single cell mode for rivers
      this.savedSingleCellMode = this.singleCellMode;
      this.singleCellMode = true;
      
      // Create cell highlight for rivers tool
      this.createCellHighlight();
      
      // Initialize rivers array if it doesn't exist (for old saved maps)
      if (this.renderer.currentGrid && !this.renderer.currentGrid.rivers) {
        console.log('GlobalMapTools | Initializing rivers array for existing map');
        this.renderer.currentGrid.rivers = new Uint8Array(this.renderer.currentGrid.heights.length);
      }
    }
    
    this.isBrushActive = true;
    this.updateBrushUI();
    console.log(`GlobalMapTools | Brush activated: ${this.currentTool} (singleCell: ${this.singleCellMode})`);
  }
  
  /**
   * Deactivate brush
   */
  deactivateBrush() {
    if (!this.isBrushActive) return;
    
    this.isBrushActive = false;
    this.updateBrushUI();
    console.log('GlobalMapTools | Brush deactivated');
  }
  
  /**
   * Set current tool
   */
  setTool(tool) {
    const validTools = [
      'raise', 'lower', 'smooth', 'roughen', 'flatten',
      'modify-biome', 'set-biome',
      'draw-river', 'erase-river'
    ];
    if (validTools.includes(tool)) {
      this.currentTool = tool;
      this.updateBrushCursorGraphics();
      // Clear overlay preview when switching tools
      this.clearOverlayPreview();
      console.log(`GlobalMapTools | Tool changed to: ${tool}`);
    }
  }

  /**
   * Set brush parameters
   */
  setBrushParams(radius = null, strength = null, targetHeight = null, targetTemperature = null, targetMoisture = null) {
    if (radius !== null) this.brushRadius = radius;
    if (strength !== null) this.brushStrength = strength;
    if (targetHeight !== null) this.targetHeight = targetHeight;
    if (targetTemperature !== null) this.targetTemperature = Math.max(1, Math.min(5, targetTemperature));
    if (targetMoisture !== null) this.targetMoisture = Math.max(1, Math.min(6, targetMoisture));
    this.updateBrushCursorGraphics();
  }

  /**
   * Set up canvas event listeners
   */
  setupEventListeners() {
    if (!canvas.stage) return;

    // Mouse down
    canvas.stage.on('pointerdown', (event) => {
      if (!this.isActive || !this.isBrushActive) return;

      // Allow right-click panning
      if (event.data.button === 2) return;
      if (event.data.button !== 0) return;

      event.stopPropagation();

      this.isMouseDown = true;

      // Start temporary overlay for this stroke
      const gridSize = this.renderer.currentGrid.heights.length;
      this.tempOverlay = new Float32Array(gridSize);
      this.tempOverlayTemp = new Float32Array(gridSize);
      this.tempOverlayMoisture = new Float32Array(gridSize);
      this.affectedCells = new Set();

      const pos = event.data.getLocalPosition(canvas.stage);
      this.applyBrushStroke(pos.x, pos.y);
      this.updateOverlayPreview();
      this.lastPosition = pos;
    });

    // Mouse move
    canvas.stage.on('pointermove', (event) => {
      if (!this.isActive) return;

      const pos = event.data.getLocalPosition(canvas.stage);

      // Update cursor and cell highlight
      this.updateBrushCursorPosition(pos.x, pos.y);
      if (this.singleCellMode) {
        this.updateCellHighlight(pos.x, pos.y);
      }

      if (!this.isBrushActive || !this.isMouseDown) return;

      // Throttle to 10px
      if (this.lastPosition) {
        const dx = pos.x - this.lastPosition.x;
        const dy = pos.y - this.lastPosition.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 10) {
          this.applyBrushStroke(pos.x, pos.y);
          this.updateOverlayPreview();
          this.lastPosition = pos;
        }
      }
    });

    // Mouse up
    canvas.stage.on('pointerup', (event) => {
      if (!this.isActive || !this.isBrushActive || !this.isMouseDown) return;

      this.isMouseDown = false;
      this.lastPosition = null;

      // Commit overlay to grid
      if (this.tempOverlay) {
        this.commitOverlay();
        this.tempOverlay = null;
        this.clearOverlayPreview();
      }
    });
  }

  /**
   * Apply brush stroke to temporary overlay
   */
  applyBrushStroke(worldX, worldY) {
    if (!this.renderer.currentGrid || !this.tempOverlay) return;

    const grid = this.renderer.currentGrid;
    const metadata = this.renderer.currentMetadata;
    const { heights, moisture, temperature, rows, cols } = grid;
    const { cellSize, bounds } = metadata;

    // Convert world coords to grid coords
    const gridCol = (worldX - bounds.minX) / cellSize;
    const gridRow = (worldY - bounds.minY) / cellSize;

    // Calculate affected cells
    let minRow, maxRow, minCol, maxCol;
    
    if (this.singleCellMode) {
      // Single cell mode: affect only the cell under cursor
      const targetRow = Math.floor(gridRow);
      const targetCol = Math.floor(gridCol);
      minRow = Math.max(0, targetRow);
      maxRow = Math.min(rows - 1, targetRow);
      minCol = Math.max(0, targetCol);
      maxCol = Math.min(cols - 1, targetCol);
    } else {
      // Normal brush mode: affect cells in radius
      const gridRadius = this.brushRadius / cellSize;
      minRow = Math.max(0, Math.floor(gridRow - gridRadius));
      maxRow = Math.min(rows - 1, Math.ceil(gridRow + gridRadius));
      minCol = Math.max(0, Math.floor(gridCol - gridRadius));
      maxCol = Math.min(cols - 1, Math.ceil(gridCol + gridRadius));
    }

    const delta = 5; // Base height change per stroke

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        // Check if cell is within brush area
        let inBrush = false;
        let effectiveStrength = this.brushStrength;
        
        if (this.singleCellMode) {
          // Single cell mode: always affect the cell
          inBrush = true;
          effectiveStrength = 1.0; // Full strength for single cell
        } else {
          // Normal brush mode: check distance and calculate falloff
          const dx = col - gridCol;
          const dy = row - gridRow;
          const distSq = dx * dx + dy * dy;
          const gridRadius = this.brushRadius / cellSize;
          const radiusSq = gridRadius * gridRadius;
          
          if (distSq <= radiusSq) {
            inBrush = true;
            const falloff = 1 - Math.sqrt(distSq / radiusSq);
            effectiveStrength = falloff * this.brushStrength;
          }
        }

        if (inBrush) {
          const idx = row * cols + col;

          // Check filters before applying brush
          if (!this._isCellPassesFilter(idx, heights, temperature, moisture)) {
            continue; // Skip this cell if it doesn't pass filter
          }

          // Track affected cells for tools that process in commit
          if (this.currentTool === 'smooth' || this.currentTool === 'roughen' ||
              this.currentTool === 'modify-biome' || this.currentTool === 'set-biome' ||
              this.currentTool === 'draw-river' || this.currentTool === 'erase-river') {
            this.affectedCells.add(idx);
          }

          switch (this.currentTool) {
            case 'raise':
              this.tempOverlay[idx] += delta * effectiveStrength;
              break;
            case 'lower':
              this.tempOverlay[idx] -= delta * effectiveStrength;
              break;
            case 'flatten':
              const currentHeight = heights[idx] + this.tempOverlay[idx];
              this.tempOverlay[idx] += (this.targetHeight - currentHeight) * effectiveStrength;
              break;
            case 'smooth':
            case 'roughen':
            case 'modify-biome':
            case 'set-biome':
            case 'draw-river':
            case 'erase-river':
              // Mark cells, changes applied in commit
              break;
            default:
              break;
          }
        }
      }
    }
  }

  /**
   * Commit temporary overlay to grid
   */
  commitOverlay() {
    if (!this.renderer.currentGrid || !this.tempOverlay) return;

    const { heights, moisture, temperature, rows, cols } = this.renderer.currentGrid;
    let { rivers } = this.renderer.currentGrid;

    // Initialize rivers array if it doesn't exist (for old saved maps)
    if (!rivers) {
      console.log('GlobalMapTools | Initializing rivers array for existing map');
      rivers = new Uint8Array(heights.length);
      this.renderer.currentGrid.rivers = rivers;
    }

    // Apply smooth/roughen if needed
    if (this.currentTool === 'smooth' && this.affectedCells.size > 0) {
      this._applySmoothOverlay(heights, rows, cols);
    } else if (this.currentTool === 'roughen' && this.affectedCells.size > 0) {
      this._applyRoughenOverlay(heights, rows, cols);
    }

    // Apply biome changes
    if (this.affectedCells.size > 0) {
      if (this.currentTool === 'modify-biome') {
        // Modify: apply delta to temperature/moisture if enabled
        for (const idx of this.affectedCells) {
          if (this.modifyTempEnabled) {
            const newTemp = temperature[idx] + this.modifyTemp;
            temperature[idx] = Math.max(1, Math.min(5, newTemp));
          }
          if (this.modifyMoistureEnabled) {
            const newMoisture = moisture[idx] + this.modifyMoisture;
            moisture[idx] = Math.max(1, Math.min(6, newMoisture));
          }
        }
      } else if (this.currentTool === 'set-biome') {
        // Set: set absolute values if enabled
        for (const idx of this.affectedCells) {
          if (this.setTempEnabled) {
            temperature[idx] = this.setTemp;
          }
          if (this.setMoistureEnabled) {
            moisture[idx] = this.setMoisture;
          }
        }
      } else if (this.currentTool === 'draw-river') {
        // Draw rivers
        for (const idx of this.affectedCells) {
          rivers[idx] = 1;
        }
      } else if (this.currentTool === 'erase-river') {
        // Erase rivers
        for (const idx of this.affectedCells) {
          rivers[idx] = 0;
        }
      }
    }

    // Apply overlay to heights
    for (let i = 0; i < heights.length; i++) {
      if (Math.abs(this.tempOverlay[i]) > 0.001) {
        heights[i] = Math.max(0, heights[i] + this.tempOverlay[i]);
      }
    }

    // Re-render
    this.renderer.render(
      this.renderer.currentGrid,
      this.renderer.currentMetadata,
      { mode: 'heights' }
    );

    // Recreate overlays after render (they get destroyed during render)
    this.createOverlayPreview();
    if (this.singleCellMode) {
      this.createCellHighlight();
    }

    console.log('GlobalMapTools | Changes applied');
  }

  /**
   * Create overlay preview graphics
   */
  createOverlayPreview() {
    if (this.overlayPreview) {
      try {
        this.overlayPreview.destroy();
      } catch (e) {
        // Already destroyed
      }
    }
    this.overlayPreview = new PIXI.Graphics();
    this.overlayPreview.name = 'global-map-overlay-preview';
    if (this.renderer.container) {
      this.renderer.container.addChild(this.overlayPreview);
    } else {
      console.warn('GlobalMapTools | Renderer container not available for overlay');
    }
  }

  /**
   * Update overlay preview visualization
   */
  updateOverlayPreview() {
    if (!this.overlayPreview || !this.tempOverlay || !this.renderer.currentGrid) return;

    this.overlayPreview.clear();

    const { heights, rows, cols } = this.renderer.currentGrid;
    const { bounds, cellSize } = this.renderer.currentMetadata;
    const previewOverlay = new Float32Array(this.tempOverlay); // Copy current overlay

    // For smooth/roughen, calculate preview of what will happen
    if ((this.currentTool === 'smooth' || this.currentTool === 'roughen') && this.affectedCells.size > 0) {
      if (this.currentTool === 'smooth') {
        const smoothAmount = this.brushStrength * 0.5;
        const tempHeights = new Float32Array(heights);

        for (const idx of this.affectedCells) {
          const row = Math.floor(idx / cols);
          const col = idx % cols;
          let sum = heights[idx];
          let count = 1;

          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nRow = row + dr;
              const nCol = col + dc;
              if (nRow >= 0 && nRow < rows && nCol >= 0 && nCol < cols) {
                const nIdx = nRow * cols + nCol;
                sum += tempHeights[nIdx];
                count++;
              }
            }
          }
          const avg = sum / count;
          const delta = (avg - heights[idx]) * smoothAmount;
          previewOverlay[idx] = delta;
        }
      } else if (this.currentTool === 'roughen') {
        const roughenAmount = this.brushStrength * 0.3;
        const tempHeights = new Float32Array(heights);

        for (const idx of this.affectedCells) {
          const row = Math.floor(idx / cols);
          const col = idx % cols;
          let sum = 0;
          let count = 0;

          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nRow = row + dr;
              const nCol = col + dc;
              if (nRow >= 0 && nRow < rows && nCol >= 0 && nCol < cols) {
                const nIdx = nRow * cols + nCol;
                sum += tempHeights[nIdx];
                count++;
              }
            }
          }
          if (count > 0) {
            const avg = sum / count;
            const delta = (heights[idx] - avg) * roughenAmount;
            previewOverlay[idx] = delta;
          }
        }
      }
    }

    // For biome tools, show change for affected cells
    if (this.affectedCells.size > 0) {
      if (this.currentTool === 'modify-biome') {
        // Show delta as indicator
        const delta = Math.abs(this.modifyTemp) + Math.abs(this.modifyMoisture);
        for (const idx of this.affectedCells) {
          previewOverlay[idx] = delta > 0 ? delta : 0.1;
        }
      } else if (this.currentTool === 'set-biome') {
        // Show fixed indicator
        for (const idx of this.affectedCells) {
          previewOverlay[idx] = 1;
        }
      } else if (this.currentTool === 'draw-river' || this.currentTool === 'erase-river') {
        // Show river paint/erase indicator
        for (const idx of this.affectedCells) {
          previewOverlay[idx] = 1;
        }
      }
    }

    // Determine colors based on tool
    let positiveColor = 0x00ff00; // default
    let negativeColor = 0xff0000;
    switch (this.currentTool) {
      case 'raise':
        positiveColor = 0x00ff00; // Green for raised
        negativeColor = 0xff0000; // Red for lowered (shouldn't happen)
        break;
      case 'lower':
        positiveColor = 0xff0000; // Red for lowered (inverted)
        negativeColor = 0x00ff00;
        break;
      case 'smooth':
      case 'flatten':
        positiveColor = 0xffff00; // Yellow for modified
        negativeColor = 0xffff00;
        break;
      case 'roughen':
        positiveColor = 0xff9900; // Orange for roughened
        negativeColor = 0xff9900;
        break;
      case 'modify-biome':
        positiveColor = 0xaa66ff; // Purple for modify biome
        negativeColor = 0xaa66ff;
        break;
      case 'set-biome':
        positiveColor = 0x66ffaa; // Teal for set biome
        negativeColor = 0x66ffaa;
        break;
      case 'draw-river':
        positiveColor = 0x3399ff; // Blue for draw river
        negativeColor = 0x3399ff;
        break;
      case 'erase-river':
        positiveColor = 0xff6633; // Orange for erase river
        negativeColor = 0xff6633;
        break;
    }

    // Draw affected cells
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        let delta = previewOverlay[idx];
        
        if (Math.abs(delta) > 0.05) {
          // Draw cell centered at coordinate point (shift by half cell)
          const x = bounds.minX + col * cellSize - cellSize / 2;
          const y = bounds.minY + row * cellSize - cellSize / 2;
          const color = delta > 0 ? positiveColor : negativeColor;
          // Smooth and Roughen get higher alpha for visibility
          let alpha;
          if (this.currentTool === 'smooth' || this.currentTool === 'roughen') {
            alpha = Math.min(0.55, Math.abs(delta) / 5); // Brighter for smooth/roughen
          } else if (this.currentTool === 'modify-biome' || this.currentTool === 'set-biome') {
            alpha = 0.6; // Fixed alpha for biome tools
          } else if (this.currentTool === 'draw-river' || this.currentTool === 'erase-river') {
            alpha = 0.6; // Fixed alpha for river tools
          } else {
            alpha = Math.min(0.35, Math.abs(delta) / 10);
          }
          this.overlayPreview.beginFill(color, alpha);
          this.overlayPreview.drawRect(x, y, cellSize, cellSize);
          this.overlayPreview.endFill();
        }
      }
    }
  }

  /**
   * Clear overlay preview
   */
  clearOverlayPreview() {
    if (this.overlayPreview) {
      this.overlayPreview.clear();
    }
  }

  /**
   * Destroy overlay preview
   */
  destroyOverlayPreview() {
    if (this.overlayPreview) {
      this.overlayPreview.destroy();
      this.overlayPreview = null;
    }
  }

  /**
   * Apply smoothing to affected cells
   * @private
   */
  _applySmoothOverlay(heights, rows, cols) {
    const smoothAmount = this.brushStrength * 0.5; // Smoothing factor
    const tempHeights = new Float32Array(heights); // Copy for sampling

    for (const idx of this.affectedCells) {
      const row = Math.floor(idx / cols);
      const col = idx % cols;

      // Average with neighbors (3x3 neighborhood)
      let sum = heights[idx];
      let count = 1;

      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue; // Skip center

          const nRow = row + dr;
          const nCol = col + dc;

          if (nRow >= 0 && nRow < rows && nCol >= 0 && nCol < cols) {
            const nIdx = nRow * cols + nCol;
            sum += tempHeights[nIdx];
            count++;
          }
        }
      }

      const avg = sum / count;
      const delta = (avg - heights[idx]) * smoothAmount;
      this.tempOverlay[idx] += delta;
    }
  }

  /**
   * Apply roughening to affected cells (opposite of smooth)
   * Adds random perturbation to create natural variation
   * @private
   */
  _applyRoughenOverlay(heights, rows, cols) {
    const roughenAmount = this.brushStrength * 0.3; // Reduced to avoid extreme spikes
    const randomAmount = this.brushStrength * 0.4; // Random perturbation
    const tempHeights = new Float32Array(heights); // Copy for sampling

    for (const idx of this.affectedCells) {
      const row = Math.floor(idx / cols);
      const col = idx % cols;

      // Calculate average of neighbors
      let sum = 0;
      let count = 0;

      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue; // Skip center

          const nRow = row + dr;
          const nCol = col + dc;

          if (nRow >= 0 && nRow < rows && nCol >= 0 && nCol < cols) {
            const nIdx = nRow * cols + nCol;
            sum += tempHeights[nIdx];
            count++;
          }
        }
      }

      if (count > 0) {
        const avg = sum / count;
        // Increase difference from average (roughen) + random noise
        const deterministicDelta = (heights[idx] - avg) * roughenAmount;
        // Random value between -1 and 1
        const randomNoise = (Math.random() * 2 - 1) * randomAmount;
        this.tempOverlay[idx] += deterministicDelta + randomNoise;
      }
    }
  }

  /**
   * Save grid changes to scene
   */
  async saveGridChanges() {
    const scene = canvas.scene;
    if (!scene) return;

    try {
      // Save grid to scene flags
      const gridSnapshot = {
        heights: Array.from(this.renderer.currentGrid.heights),
        moisture: Array.from(this.renderer.currentGrid.moisture),
        temperature: Array.from(this.renderer.currentGrid.temperature),
        rivers: Array.from(this.renderer.currentGrid.rivers || new Uint8Array(this.renderer.currentGrid.heights.length)),
        rows: this.renderer.currentGrid.rows,
        cols: this.renderer.currentGrid.cols,
        metadata: this.renderer.currentMetadata,
        timestamp: new Date().toISOString(),
      };

      await scene.setFlag('spaceholder', 'globalMapGrid', gridSnapshot);
      console.log('GlobalMapTools | ✓ Grid saved to scene');
      ui.notifications.info('Global map saved');
    } catch (error) {
      console.error('GlobalMapTools | Failed to save:', error);
      ui.notifications.error(`Failed to save: ${error.message}`);
    }
  }

  /**
   * Create brush cursor visualization
   */
  createBrushCursor() {
    if (this.brushCursor) {
      this.brushCursor.destroy();
    }

    this.brushCursor = new PIXI.Graphics();
    this.brushCursor.name = 'globalMapBrushCursor';

    if (canvas.interface) {
      canvas.interface.addChild(this.brushCursor);
    }

    this.updateBrushCursorGraphics();
  }
  
  /**
   * Create or update cell highlight for single cell mode
   */
  createCellHighlight() {
    if (this.cellHighlight) {
      try {
        this.cellHighlight.destroy();
      } catch (e) {
        // Already destroyed
      }
    }
    this.cellHighlight = new PIXI.Graphics();
    this.cellHighlight.name = 'global-map-cell-highlight';
    if (this.renderer.container) {
      this.renderer.container.addChild(this.cellHighlight);
    }
  }
  
  /**
   * Update cell highlight position in single cell mode
   */
  updateCellHighlight(worldX, worldY) {
    if (!this.cellHighlight || !this.renderer.currentGrid) {
      this.createCellHighlight();
      if (!this.cellHighlight) return;
    }
    
    const { cellSize, bounds } = this.renderer.currentMetadata;
    const { rows, cols } = this.renderer.currentGrid;
    
    // Convert world coords to grid coords
    const gridCol = (worldX - bounds.minX) / cellSize;
    const gridRow = (worldY - bounds.minY) / cellSize;
    
    const targetRow = Math.floor(gridRow);
    const targetCol = Math.floor(gridCol);
    
    // Check bounds
    if (targetRow < 0 || targetRow >= rows || targetCol < 0 || targetCol >= cols) {
      this.cellHighlight.clear();
      return;
    }
    
    // Draw cell highlight
    this.cellHighlight.clear();
    
    // Get color based on current tool
    let color = 0xffffff;
    switch (this.currentTool) {
      case 'raise': color = 0x00ff00; break;
      case 'lower': color = 0xff0000; break;
      case 'smooth': color = 0xffff00; break;
      case 'roughen': color = 0xff9900; break;
      case 'flatten': color = 0x00ffff; break;
      case 'modify-biome': color = 0xaa66ff; break;
      case 'set-biome': color = 0x66ffaa; break;
      case 'draw-river': color = 0x3399ff; break;
      case 'erase-river': color = 0xff6633; break;
    }
    
    // Draw cell with tool color
    const x = bounds.minX + targetCol * cellSize - cellSize / 2;
    const y = bounds.minY + targetRow * cellSize - cellSize / 2;
    
    this.cellHighlight.beginFill(color, 0.4);
    this.cellHighlight.drawRect(x, y, cellSize, cellSize);
    this.cellHighlight.endFill();
    
    // Draw outline
    this.cellHighlight.lineStyle(2, color, 0.9);
    this.cellHighlight.drawRect(x, y, cellSize, cellSize);
  }
  
  /**
   * Clear cell highlight
   */
  clearCellHighlight() {
    if (this.cellHighlight) {
      this.cellHighlight.clear();
    }
  }

  /**
   * Update brush cursor position
   */
  updateBrushCursorPosition(x, y) {
    if (!this.brushCursor) return;
    this.brushCursor.position.set(x, y);
  }

  /**
   * Update brush cursor graphics
   */
  updateBrushCursorGraphics() {
    if (!this.brushCursor) return;

    this.brushCursor.clear();

    let color = 0xffffff;
    let alpha = 0.3;

    switch (this.currentTool) {
      case 'raise':
        color = 0x00ff00; // Green
        break;
      case 'lower':
        color = 0xff0000; // Red
        break;
      case 'smooth':
        color = 0xffff00; // Yellow
        break;
      case 'roughen':
        color = 0xff9900; // Orange
        break;
      case 'flatten':
        color = 0x00ffff; // Cyan
        break;
      case 'modify-biome':
        color = 0xaa66ff; // Purple for modify biome
        break;
      case 'set-biome':
        color = 0x66ffaa; // Teal for set biome
        break;
      case 'draw-river':
        color = 0x3399ff; // Blue for draw river
        break;
      case 'erase-river':
        color = 0xff6633; // Orange for erase river
        break;
    }

    if (this.singleCellMode) {
      // In single cell mode, don't draw cursor (cell highlight handles it)
      // Just keep cursor invisible
    } else {
      // Draw filled circle
      this.brushCursor.beginFill(color, alpha * this.brushStrength);
      this.brushCursor.drawCircle(0, 0, this.brushRadius);
      this.brushCursor.endFill();

      // Draw outline
      this.brushCursor.lineStyle(2, color, 0.7);
      this.brushCursor.drawCircle(0, 0, this.brushRadius);
    }
  }

  /**
   * Update brush UI state (enable/disable controls based on brush active state)
   */
  updateBrushUI() {
    if (!$('#global-map-tools-ui').length) return;
    
    const isActive = this.isBrushActive;
    
    // Update button text and style
    const buttonText = isActive ? 'Deactivate Brush' : 'Activate Brush';
    const buttonColor = isActive ? '#cc0000' : '#00aa00';
    $('#brush-toggle').text(buttonText).css('background', buttonColor);
    $('#biome-brush-toggle').text(buttonText).css('background', buttonColor);
    $('#river-brush-toggle').text(buttonText).css('background', buttonColor);
    
    // Disable/enable controls
    $('#global-map-tool').prop('disabled', isActive);
    $('#global-map-biome-tool').prop('disabled', isActive);
    $('#global-map-river-tool').prop('disabled', isActive);
    
    // Disable/enable tab switching
    if (isActive) {
      $('#tab-brush').css('pointer-events', 'none').css('opacity', '0.5');
      $('#tab-biomes').css('pointer-events', 'none').css('opacity', '0.5');
      $('#tab-rivers').css('pointer-events', 'none').css('opacity', '0.5');
      $('#tab-global').css('pointer-events', 'none').css('opacity', '0.5');
    } else {
      $('#tab-brush').css('pointer-events', 'auto').css('opacity', '1');
      $('#tab-biomes').css('pointer-events', 'auto').css('opacity', '1');
      $('#tab-rivers').css('pointer-events', 'auto').css('opacity', '1');
      $('#tab-global').css('pointer-events', 'auto').css('opacity', '1');
    }
    
    // Update cursor visibility
    if (this.brushCursor) {
      this.brushCursor.visible = isActive && !this.singleCellMode;
    }
    
    // Update cell highlight visibility
    if (this.cellHighlight) {
      this.cellHighlight.visible = isActive && this.singleCellMode;
      if (!isActive || !this.singleCellMode) {
        this.clearCellHighlight();
      }
    }
  }
  
  /**
   * Destroy brush cursor
   */
  destroyBrushCursor() {
    if (this.brushCursor) {
      this.brushCursor.destroy();
      this.brushCursor = null;
    }
    if (this.cellHighlight) {
      this.cellHighlight.destroy();
      this.cellHighlight = null;
    }
  }

  /**
   * Show tools UI panel
   */
  showToolsUI() {
    // Remove existing UI
    this.hideToolsUI();

    const html = `
      <div id="global-map-tools-ui" style="
        position: fixed;
        top: 100px;
        right: 20px;
        background: rgba(0, 0, 0, 0.85);
        color: white;
        padding: 15px;
        border-radius: 5px;
        min-width: 250px;
        z-index: 1000;
        font-family: 'Signika', sans-serif;
        cursor: move;
      ">
        <div id="global-map-tools-titlebar" style="
          cursor: move;
          user-select: none;
          margin: -15px -15px 10px -15px;
          padding: 8px 15px;
          background: rgba(0, 0, 0, 0.5);
          border-bottom: 1px solid #444;
          border-radius: 5px 5px 0 0;
        ">
          <h3 style="margin: 0; display: inline-block; flex: 1;">Global Map Tools</h3>
        </div>

        <div style="display: flex; gap: 5px; margin-bottom: 10px;">
          <button id="tab-brush" data-tab="brush" style="flex: 1; padding: 8px; background: #0066cc; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
            Heights
          </button>
          <button id="tab-biomes" data-tab="biomes" style="flex: 1; padding: 8px; background: #333; border: none; color: white; border-radius: 3px; cursor: pointer;">
            Biomes
          </button>
          <button id="tab-rivers" data-tab="rivers" style="flex: 1; padding: 8px; background: #333; border: none; color: white; border-radius: 3px; cursor: pointer;">
            Rivers
          </button>
          <button id="tab-global" data-tab="global" style="flex: 1; padding: 8px; background: #333; border: none; color: white; border-radius: 3px; cursor: pointer;">
            Global
          </button>
        </div>

        <div id="brush-tab" style="display: block;">
          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">Tool:</label>
          <select id="global-map-tool" style="width: 100%; padding: 5px;">
            <option value="raise" selected>Raise Terrain</option>
            <option value="lower">Lower Terrain</option>
            <option value="smooth">Smooth</option>
            <option value="roughen">Roughen</option>
            <option value="flatten">Flatten</option>
          </select>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
              <input type="checkbox" id="single-cell-mode" style="margin: 0;">
              <span>Single Cell Mode</span>
            </label>
            <div id="radius-container">
              <label style="display: block; margin-bottom: 5px;">Radius: <span id="radius-value">${this.brushRadius}</span>px</label>
              <input type="range" id="global-map-radius" min="25" max="500" step="5" value="${this.brushRadius}" style="width: 100%;">
            </div>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">Strength: <span id="strength-value">${this.brushStrength.toFixed(1)}</span></label>
            <input type="range" id="global-map-strength" min="0.1" max="1.0" step="0.1" value="${this.brushStrength}" style="width: 100%;">
          </div>
          
          <!-- Height Filter -->
          <div style="margin-bottom: 10px; padding: 8px; background: rgba(100, 150, 100, 0.15); border-radius: 3px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <input type="checkbox" id="height-filter-enabled" style="margin: 0;">
              <span style="font-weight: bold; font-size: 12px;">Filter by Height</span>
            </label>
            <div style="display: none;" id="height-filter-controls">
              <div style="margin-bottom: 6px;">
                <label style="display: block; margin-bottom: 2px; font-size: 10px;">Min: <span id="height-filter-min-value">0</span>%</label>
                <input type="range" id="height-filter-min" min="0" max="100" step="1" value="0" style="width: 100%;" disabled>
              </div>
              <div style="margin-bottom: 6px;">
                <label style="display: block; margin-bottom: 2px; font-size: 10px;">Max: <span id="height-filter-max-value">100</span>%</label>
                <input type="range" id="height-filter-max" min="0" max="100" step="1" value="100" style="width: 100%;" disabled>
              </div>
              <div style="font-size: 10px; color: #aaa; text-align: center;">
                Range: <span id="height-filter-display">0-100</span>%
              </div>
            </div>
          </div>
          
          <!-- Biome Filter for Height Tools -->
          <div style="margin-bottom: 10px; padding: 8px; background: rgba(100, 150, 100, 0.15); border-radius: 3px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <input type="checkbox" id="height-tool-biome-filter-enabled" style="margin: 0;">
              <span style="font-weight: bold; font-size: 12px;">Filter by Biome</span>
            </label>
            <div style="display: none;" id="height-tool-biome-filter-controls">
              <div id="height-filter-biome-matrix" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; margin-bottom: 5px;"></div>
              <div style="font-size: 9px; color: #aaa; text-align: center;">
                Click to select biomes to affect
              </div>
            </div>
          </div>
          
          <button id="brush-toggle" style="width: 100%; padding: 10px; margin-top: 10px; background: #00aa00; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
            Activate Brush
          </button>
        </div>

        <div id="biomes-tab" style="display: none;">
          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">Tool:</label>
          <select id="global-map-biome-tool" style="width: 100%; padding: 5px;">
            <option value="set-biome" selected>Set Biome</option>
            <option value="modify-biome">Modify Biome</option>
          </select>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
              <input type="checkbox" id="biome-single-cell-mode" style="margin: 0;">
              <span>Single Cell Mode</span>
            </label>
            <div id="biome-radius-container">
              <label style="display: block; margin-bottom: 5px;">Radius: <span id="biome-radius-value">${this.brushRadius}</span>px</label>
              <input type="range" id="global-map-biome-radius" min="25" max="500" step="5" value="${this.brushRadius}" style="width: 100%;">
            </div>
          </div>

          <!-- Modify Biome Controls -->
          <div id="modify-biome-controls" style="margin-bottom: 10px;">
            <div style="margin-bottom: 8px;">
              <label style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="modify-temp-enabled" style="margin: 0;">
                <span>Temperature:</span>
                <span id="modify-temp-value" style="margin-left: auto; font-weight: bold;">0</span>
              </label>
              <input type="range" id="modify-temp" min="-3" max="3" step="1" value="0" style="width: 100%; margin-top: 4px;">
            </div>
            <div style="margin-bottom: 8px;">
              <label style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="modify-moisture-enabled" style="margin: 0;">
                <span>Moisture:</span>
                <span id="modify-moisture-value" style="margin-left: auto; font-weight: bold;">0</span>
              </label>
              <input type="range" id="modify-moisture" min="-3" max="3" step="1" value="0" style="width: 100%; margin-top: 4px;">
            </div>
          </div>

          <!-- Set Biome Controls -->
          <div id="set-biome-controls" style="margin-bottom: 10px; display: none;">
            <div style="margin-bottom: 8px;">
              <label style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="set-temp-enabled" style="margin: 0;">
                <span>Temperature:</span>
                <span id="set-temp-value" style="margin-left: auto; font-weight: bold;">3</span>
              </label>
              <input type="range" id="set-temp" min="1" max="5" step="1" value="3" style="width: 100%; margin-top: 4px;">
            </div>
            <div style="margin-bottom: 8px;">
              <label style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="set-moisture-enabled" style="margin: 0;">
                <span>Moisture:</span>
                <span id="set-moisture-value" style="margin-left: auto; font-weight: bold;">3</span>
              </label>
              <input type="range" id="set-moisture" min="1" max="6" step="1" value="3" style="width: 100%; margin-top: 4px;">
            </div>
            
            <!-- Biome Presets Matrix -->
            <div style="margin-top: 10px;">
              <label style="display: block; margin-bottom: 5px; font-size: 11px;">Biome Presets:</label>
              <div id="biome-preset-matrix" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; margin-bottom: 5px;"></div>
            </div>
          </div>
          
          <!-- Height Filter for Biome Tools -->
          <div style="margin-bottom: 10px; padding: 8px; background: rgba(100, 100, 150, 0.15); border-radius: 3px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <input type="checkbox" id="biome-tool-height-filter-enabled" style="margin: 0;">
              <span style="font-weight: bold; font-size: 12px;">Filter by Height</span>
            </label>
            <div style="display: none;" id="biome-tool-height-filter-controls">
              <div style="margin-bottom: 6px;">
                <label style="display: block; margin-bottom: 2px; font-size: 10px;">Min: <span id="biome-tool-height-min-value">0</span>%</label>
                <input type="range" id="biome-tool-height-min" min="0" max="100" step="1" value="0" style="width: 100%;" disabled>
              </div>
              <div style="margin-bottom: 6px;">
                <label style="display: block; margin-bottom: 2px; font-size: 10px;">Max: <span id="biome-tool-height-max-value">100</span>%</label>
                <input type="range" id="biome-tool-height-max" min="0" max="100" step="1" value="100" style="width: 100%;" disabled>
              </div>
              <div style="font-size: 10px; color: #aaa; text-align: center;">
                Range: <span id="biome-tool-height-display">0-100</span>%
              </div>
            </div>
          </div>
          
          <!-- Biome Filter for Biome Tools -->
          <div style="margin-bottom: 10px; padding: 8px; background: rgba(100, 100, 150, 0.15); border-radius: 3px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <input type="checkbox" id="biome-tool-biome-filter-enabled" style="margin: 0;">
              <span style="font-weight: bold; font-size: 12px;">Filter by Biome</span>
            </label>
            <div style="display: none;" id="biome-tool-biome-filter-controls">
              <div id="biome-filter-biome-matrix" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; margin-bottom: 5px;"></div>
              <div style="font-size: 9px; color: #aaa; text-align: center;">
                Click to exclude biomes from editing
              </div>
            </div>
          </div>
          
          <button id="biome-brush-toggle" style="width: 100%; padding: 10px; margin-top: 10px; background: #00aa00; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
            Activate Brush
          </button>
        </div>

        <div id="rivers-tab" style="display: none;">
          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">Tool:</label>
            <select id="global-map-river-tool" style="width: 100%; padding: 5px;">
              <option value="draw-river" selected>Draw River</option>
              <option value="erase-river">Erase River</option>
            </select>
          </div>
          
          <button id="river-brush-toggle" style="width: 100%; padding: 10px; margin-top: 10px; background: #00aa00; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
            Activate Brush
          </button>
        </div>

        <div id="global-tab" style="display: none;">
          <!-- Smooth Operations -->
          <div style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #555;">
            <label style="display: block; margin-bottom: 5px; font-weight: bold; color: #ffff00;">Smoothing:</label>
            <div style="margin-bottom: 10px;">
              <label style="display: block; margin-bottom: 5px; font-size: 12px;">Strength: <span id="global-smooth-strength-value">${this.globalSmoothStrength.toFixed(1)}</span></label>
              <input type="range" id="global-smooth-strength" min="0.1" max="1.0" step="0.1" value="${this.globalSmoothStrength}" style="width: 100%;">
            </div>
            <button id="global-smooth-btn" style="width: 100%; padding: 8px; margin-bottom: 5px; background: #ffff00; color: black; border: none; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 12px;">
              Smooth (1 pass)
            </button>
            <button id="global-smooth-3-btn" style="width: 100%; padding: 8px; background: #ffdd00; color: black; border: none; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 12px;">
              Smooth (3 passes)
            </button>
          </div>

          <!-- Unified Replace Tool -->
          <div style="margin-bottom: 15px; padding: 10px; background: rgba(150, 150, 100, 0.1); border-radius: 3px;">
            <label style="display: block; margin-bottom: 8px; font-weight: bold; color: #ffff99; font-size: 13px;">Replace Cells:</label>
            
            <!-- Filters Section -->
            <div style="margin-bottom: 12px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 3px;">
              <label style="display: block; margin-bottom: 6px; font-weight: bold; color: #ccccff; font-size: 11px;">Filters (at least one):</label>
              
              <!-- Height Filter -->
              <div style="margin-bottom: 8px;">
                <label style="display: flex; align-items: center; gap: 6px; font-size: 10px;">
                  <input type="checkbox" id="replace-use-height" style="margin: 0;">
                  <span>Height Range:</span>
                </label>
                <div style="margin-left: 20px; margin-top: 4px;">
                  <label style="display: block; margin-bottom: 2px; font-size: 9px;">Min: <span id="replace-height-min-value">0</span>%</label>
                  <input type="range" id="replace-height-min" min="0" max="100" step="1" value="0" style="width: 100%; margin-bottom: 4px;" disabled>
                  <label style="display: block; margin-bottom: 2px; font-size: 9px;">Max: <span id="replace-height-max-value">100</span>%</label>
                  <input type="range" id="replace-height-max" min="0" max="100" step="1" value="100" style="width: 100%;" disabled>
                </div>
              </div>
              
              <!-- Biome Filter -->
              <div style="margin-bottom: 8px;">
                <label style="display: flex; align-items: center; gap: 6px; font-size: 10px;">
                  <input type="checkbox" id="replace-use-biome" style="margin: 0;">
                  <span>Source Biome:</span>
                </label>
                <div id="replace-source-biome-matrix" style="display: none; display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; margin-top: 4px; opacity: 0.6;"></div>
              </div>
            </div>
            
            <!-- Actions Section -->
            <div style="margin-bottom: 12px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 3px;">
              <label style="display: block; margin-bottom: 6px; font-weight: bold; color: #ccffcc; font-size: 11px;">Actions (at least one):</label>
              
              <!-- Set Height Action -->
              <div style="margin-bottom: 8px;">
                <label style="display: flex; align-items: center; gap: 6px; font-size: 10px;">
                  <input type="checkbox" id="replace-set-height" style="margin: 0;">
                  <span>Set Height:</span>
                  <input type="range" id="replace-set-height-val" min="0" max="100" step="1" value="50" style="flex: 1;" disabled>
                  <span id="replace-set-height-display" style="font-size: 9px; color: #aaa; min-width: 25px;">50</span>
                </label>
              </div>
              
              <!-- Set Biome Action -->
              <div style="margin-bottom: 0;">
                <label style="display: flex; align-items: center; gap: 6px; font-size: 10px;">
                  <input type="checkbox" id="replace-set-biome" style="margin: 0;">
                  <span>Set Biome:</span>
                </label>
                <div id="replace-target-biome-matrix" style="display: none; display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; margin-top: 4px; opacity: 0.6;"></div>
              </div>
            </div>
            
            <!-- Preview and Action -->
            <div style="margin-bottom: 8px; padding: 6px; background: rgba(0,0,0,0.2); border-radius: 3px; font-size: 10px; color: #aaa;">
              Matches: <span id="replace-preview-count">0</span> cells
            </div>
            
            <button id="replace-apply-btn" style="width: 100%; padding: 6px; margin-bottom: 4px; background: #88dd88; color: black; border: none; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">
              Replace
            </button>
            <button id="replace-flatten-btn" style="width: 100%; padding: 6px; background: #ffaa44; color: black; border: none; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 11px;">
              Flatten All
            </button>
          </div>
        </div>

        <button id="global-map-exit" style="width: 100%; padding: 8px; margin-top: 5px; background: #888; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
          Exit
        </button>
      </div>
    `;

    $('body').append(html);

    // ===== DRAGGABLE UI =====
    // Make the tools UI draggable
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    const toolsUI = $('#global-map-tools-ui');
    const titlebar = $('#global-map-tools-titlebar');
    
    titlebar.on('mousedown', (e) => {
      if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
        isDragging = true;
        const rect = toolsUI[0].getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        titlebar.css('background', 'rgba(0, 100, 200, 0.5)');
        e.preventDefault();
      }
    });
    
    $(document).on('mousemove', (e) => {
      if (isDragging) {
        toolsUI.css({
          'right': 'auto',
          'left': (e.clientX - dragOffsetX) + 'px',
          'top': (e.clientY - dragOffsetY) + 'px'
        });
      }
    });
    
    $(document).on('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        titlebar.css('background', 'rgba(0, 0, 0, 0.5)');
      }
    });

    // Generate biome preset matrix (used in Set Biome)
    const generateBiomeMatrix = () => {
      const matrix = $('#biome-preset-matrix');
      matrix.empty();
      
      // Matrix: 6 rows (moisture 6 to 1, top to bottom) x 5 columns (temperature 1 to 5, left to right)
      for (let moisture = 6; moisture >= 1; moisture--) {
        for (let temp = 1; temp <= 5; temp++) {
          const biomeId = this.processing.biomeResolver.getBiomeId(moisture, temp, 20);
          const color = this.processing.biomeResolver.getBiomeColor(biomeId);
          const colorHex = '#' + color.toString(16).padStart(6, '0');
          const pattern = this.processing.biomeResolver.getBiomePattern(biomeId);
          
          const cellStyles = {
            'aspect-ratio': '1',
            'cursor': 'pointer',
            'border': '1px solid rgba(0,0,0,0.3)',
            'border-radius': '2px',
            'position': 'relative'
          };
          
          // Add pattern or solid background
          if (pattern) {
            const patternColor = this._getPatternColor(pattern, color);
            if (patternColor) {
              // Diagonal stripes: base color with pattern color stripes
              cellStyles['background'] = `repeating-linear-gradient(
                45deg,
                ${colorHex},
                ${colorHex} 8px,
                ${patternColor} 8px,
                ${patternColor} 16px
              )`;
            } else {
              cellStyles['background-color'] = colorHex;
            }
          } else {
            cellStyles['background-color'] = colorHex;
          }
          
          const cell = $('<div></div>').css(cellStyles).attr({
            'data-temp': temp,
            'data-moisture': moisture,
            'title': `T:${temp} M:${moisture}`
          });
          
          cell.on('click', () => {
            this.setTemp = temp;
            this.setMoisture = moisture;
            this.setTempEnabled = true;
            this.setMoistureEnabled = true;
            $('#set-temp').val(temp);
            $('#set-temp-value').text(temp);
            $('#set-temp-enabled').prop('checked', true);
            $('#set-moisture').val(moisture);
            $('#set-moisture-value').text(moisture);
            $('#set-moisture-enabled').prop('checked', true);
          });
          
          matrix.append(cell);
        }
      }
    };

    // Generate biome selection matrix for Height tools filter (allowed biomes)
    this._generateHeightFilterBiomeMatrix = () => {
      const matrix = $('#height-filter-biome-matrix');
      matrix.empty();
      // 6 rows (moisture 6..1) x 5 cols (temp 1..5)
      for (let moisture = 6; moisture >= 1; moisture--) {
        for (let temp = 1; temp <= 5; temp++) {
          const biomeId = this.processing.biomeResolver.getBiomeId(moisture, temp, 20);
          const color = this.processing.biomeResolver.getBiomeColor(biomeId);
          const colorHex = '#' + color.toString(16).padStart(6, '0');
          const pattern = this.processing.biomeResolver.getBiomePattern(biomeId);
          const selected = this.heightFilterBiomeIds.has(biomeId);
          
          const cellStyles = {
            'aspect-ratio': '1',
            'cursor': 'pointer',
            'border': selected ? '2px solid #ffffff' : '1px solid rgba(0,0,0,0.3)',
            'border-radius': '2px',
            'box-shadow': selected ? '0 0 0 2px rgba(255,255,255,0.3) inset' : 'none',
            'position': 'relative',
            'min-width': '50px',
            'min-height': '50px'
          };
          
          // Add pattern or solid background
          if (pattern) {
            const patternColor = this._getPatternColor(pattern, color);
            if (patternColor) {
              // Diagonal stripes: base color with pattern color stripes
              cellStyles['background'] = `repeating-linear-gradient(
                45deg,
                ${colorHex},
                ${colorHex} 10px,
                ${patternColor} 10px,
                ${patternColor} 20px
              )`;
            } else {
              cellStyles['background-color'] = colorHex;
            }
          } else {
            cellStyles['background-color'] = colorHex;
          }
          
          const cell = $('<div></div>').css(cellStyles).attr({
            'data-biome-id': biomeId,
            'title': `T:${temp} M:${moisture} (ID:${biomeId})`
          });
          
          cell.on('click', () => {
            if (this.heightFilterBiomeIds.has(biomeId)) {
              this.heightFilterBiomeIds.delete(biomeId);
            } else {
              this.heightFilterBiomeIds.add(biomeId);
            }
            // Toggle style
            const isSel = this.heightFilterBiomeIds.has(biomeId);
            cell.css('border', isSel ? '2px solid #ffffff' : '1px solid rgba(0,0,0,0.3)');
            cell.css('box-shadow', isSel ? '0 0 0 2px rgba(255,255,255,0.3) inset' : 'none');
          });
          matrix.append(cell);
        }
      }
    };

    // Generate biome selection matrix for Biome tools filter (excluded biomes)
    this._generateBiomeToolBiomeFilterMatrix = () => {
      const matrix = $('#biome-filter-biome-matrix');
      matrix.empty();
      for (let moisture = 6; moisture >= 1; moisture--) {
        for (let temp = 1; temp <= 5; temp++) {
          const biomeId = this.processing.biomeResolver.getBiomeId(moisture, temp, 20);
          const color = this.processing.biomeResolver.getBiomeColor(biomeId);
          const colorHex = '#' + color.toString(16).padStart(6, '0');
          const pattern = this.processing.biomeResolver.getBiomePattern(biomeId);
          const excluded = this.biomeFilterExcludedIds.has(biomeId);
          
          const cellStyles = {
            'aspect-ratio': '1',
            'cursor': 'pointer',
            'border': excluded ? '2px solid #ff6666' : '1px solid rgba(0,0,0,0.3)',
            'border-radius': '2px',
            'position': 'relative',
            'min-width': '50px',
            'min-height': '50px'
          };
          
          // Add pattern or solid background
          if (pattern) {
            const patternColor = this._getPatternColor(pattern, color);
            if (patternColor) {
              // Diagonal stripes: base color with pattern color stripes
              cellStyles['background'] = `repeating-linear-gradient(
                45deg,
                ${colorHex},
                ${colorHex} 10px,
                ${patternColor} 10px,
                ${patternColor} 20px
              )`;
            } else {
              cellStyles['background-color'] = colorHex;
            }
          } else {
            cellStyles['background-color'] = colorHex;
          }
          
          const cell = $('<div></div>').css(cellStyles).attr({
            'data-biome-id': biomeId,
            'title': `T:${temp} M:${moisture} (ID:${biomeId})`
          });
          
          // Add small X overlay when excluded
          if (excluded) {
            const overlay = $('<div></div>').css({
              'position': 'absolute','inset':'0','display':'flex','align-items':'center','justify-content':'center','color':'#ffdddd','font-weight':'bold','text-shadow':'0 0 2px #000','font-size':'14px','background':'rgba(0,0,0,0.3)'
            }).text('×');
            cell.append(overlay);
          }
          
          cell.on('click', () => {
            if (this.biomeFilterExcludedIds.has(biomeId)) {
              this.biomeFilterExcludedIds.delete(biomeId);
            } else {
              this.biomeFilterExcludedIds.add(biomeId);
            }
            // Regenerate to refresh overlays/styles
            this._generateBiomeToolBiomeFilterMatrix();
          });
          matrix.append(cell);
        }
      }
    };

    // Generate replace source biome selection matrix
    this._generateReplaceSourceBiomeMatrix = () => {
      const matrix = $('#replace-source-biome-matrix');
      matrix.empty();
      const selectedBiomes = this.replaceSourceBiomeIds;
      
      for (let moisture = 6; moisture >= 1; moisture--) {
        for (let temp = 1; temp <= 5; temp++) {
          const biomeId = this.processing.biomeResolver.getBiomeId(moisture, temp, 20);
          const color = this.processing.biomeResolver.getBiomeColor(biomeId);
          const colorHex = '#' + color.toString(16).padStart(6, '0');
          const pattern = this.processing.biomeResolver.getBiomePattern(biomeId);
          const isSelected = selectedBiomes.has(biomeId);
          
          const cellStyles = {
            'aspect-ratio': '1',
            'cursor': 'pointer',
            'border': isSelected ? '2px solid #ffff00' : '1px solid rgba(0,0,0,0.3)',
            'border-radius': '2px',
            'position': 'relative',
            'min-width': '40px',
            'min-height': '40px'
          };
          
          // Add pattern or solid background
          if (pattern) {
            const patternColor = this._getPatternColor(pattern, color);
            if (patternColor) {
              cellStyles['background'] = `repeating-linear-gradient(
                45deg,
                ${colorHex},
                ${colorHex} 10px,
                ${patternColor} 10px,
                ${patternColor} 20px
              )`;
            } else {
              cellStyles['background-color'] = colorHex;
            }
          } else {
            cellStyles['background-color'] = colorHex;
          }
          
          const cell = $('<div></div>').css(cellStyles).attr({
            'data-biome-id': biomeId,
            'title': `T:${temp} M:${moisture} (ID:${biomeId})`
          });
          
          cell.on('click', () => {
            if (this.replaceSourceBiomeIds.has(biomeId)) {
              this.replaceSourceBiomeIds.delete(biomeId);
            } else {
              this.replaceSourceBiomeIds.add(biomeId);
            }
            this._generateReplaceSourceBiomeMatrix();
            this.updateReplacePreview();
          });
          
          matrix.append(cell);
        }
      }
    };

    // Generate replace target biome selection matrix
    this._generateReplaceTargetBiomeMatrix = () => {
      const matrix = $('#replace-target-biome-matrix');
      matrix.empty();
      const selectedBiome = this.replaceTargetBiomeId;
      
      for (let moisture = 6; moisture >= 1; moisture--) {
        for (let temp = 1; temp <= 5; temp++) {
          const biomeId = this.processing.biomeResolver.getBiomeId(moisture, temp, 20);
          const color = this.processing.biomeResolver.getBiomeColor(biomeId);
          const colorHex = '#' + color.toString(16).padStart(6, '0');
          const pattern = this.processing.biomeResolver.getBiomePattern(biomeId);
          const isSelected = selectedBiome === biomeId;
          
          const cellStyles = {
            'aspect-ratio': '1',
            'cursor': 'pointer',
            'border': isSelected ? '2px solid #00ff00' : '1px solid rgba(0,0,0,0.3)',
            'border-radius': '2px',
            'position': 'relative',
            'min-width': '40px',
            'min-height': '40px'
          };
          
          // Add pattern or solid background
          if (pattern) {
            const patternColor = this._getPatternColor(pattern, color);
            if (patternColor) {
              cellStyles['background'] = `repeating-linear-gradient(
                45deg,
                ${colorHex},
                ${colorHex} 10px,
                ${patternColor} 10px,
                ${patternColor} 20px
              )`;
            } else {
              cellStyles['background-color'] = colorHex;
            }
          } else {
            cellStyles['background-color'] = colorHex;
          }
          
          const cell = $('<div></div>').css(cellStyles).attr({
            'data-biome-id': biomeId,
            'title': `T:${temp} M:${moisture} (ID:${biomeId})`
          });
          
          cell.on('click', () => {
            this.replaceTargetBiomeId = biomeId;
            this._generateReplaceTargetBiomeMatrix();
          });
          
          matrix.append(cell);
        }
      }
    };

    // Update UI visibility based on tool (biomes tab)
    const updateBiomeToolUI = (tool) => {
      if (tool === 'modify-biome') {
        $('#modify-biome-controls').show();
        $('#set-biome-controls').hide();
      } else if (tool === 'set-biome') {
        $('#modify-biome-controls').hide();
        $('#set-biome-controls').show();
        // Generate matrix if not already generated
        if ($('#biome-preset-matrix').children().length === 0) {
          generateBiomeMatrix();
        }
      }
    };

    // Event listeners for Heights tab
    $('#global-map-tool').on('change', (e) => {
      this.setTool(e.target.value);
    });

    $('#single-cell-mode').on('change', (e) => {
      this.singleCellMode = e.target.checked;
      // Sync both checkboxes
      $('#biome-single-cell-mode').prop('checked', this.singleCellMode);
      // Show/hide radius controls
      if (this.singleCellMode) {
        $('#radius-container').hide();
        $('#biome-radius-container').hide();
      } else {
        $('#radius-container').show();
        $('#biome-radius-container').show();
      }
      this.updateBrushCursorGraphics();
      this.updateBrushUI();
      if (!this.singleCellMode) {
        this.clearCellHighlight();
      }
    });

    $('#global-map-radius').on('input', (e) => {
      this.brushRadius = parseInt(e.target.value);
      $('#radius-value').text(this.brushRadius);
      $('#biome-radius-value').text(this.brushRadius);
      this.updateBrushCursorGraphics();
    });

    $('#global-map-strength').on('input', (e) => {
      this.brushStrength = parseFloat(e.target.value);
      $('#strength-value').text(this.brushStrength.toFixed(1));
      $('#biome-strength-value').text(this.brushStrength.toFixed(1));
      this.updateBrushCursorGraphics();
    });

    // Event listeners for Biomes tab
    $('#global-map-biome-tool').on('change', (e) => {
      this.setTool(e.target.value);
      updateBiomeToolUI(e.target.value);
    });

    $('#biome-single-cell-mode').on('change', (e) => {
      this.singleCellMode = e.target.checked;
      // Sync both checkboxes
      $('#single-cell-mode').prop('checked', this.singleCellMode);
      // Show/hide radius controls
      if (this.singleCellMode) {
        $('#radius-container').hide();
        $('#biome-radius-container').hide();
      } else {
        $('#radius-container').show();
        $('#biome-radius-container').show();
      }
      this.updateBrushCursorGraphics();
      this.updateBrushUI();
      if (!this.singleCellMode) {
        this.clearCellHighlight();
      }
    });

    $('#global-map-biome-radius').on('input', (e) => {
      this.brushRadius = parseInt(e.target.value);
      $('#radius-value').text(this.brushRadius);
      $('#biome-radius-value').text(this.brushRadius);
      this.updateBrushCursorGraphics();
    });

    // Modify Biome controls
    $('#modify-temp-enabled').on('change', (e) => {
      this.modifyTempEnabled = e.target.checked;
    });
    
    $('#modify-temp').on('input', (e) => {
      this.modifyTemp = parseInt(e.target.value);
      $('#modify-temp-value').text(this.modifyTemp > 0 ? `+${this.modifyTemp}` : this.modifyTemp);
    });
    
    $('#modify-moisture-enabled').on('change', (e) => {
      this.modifyMoistureEnabled = e.target.checked;
    });
    
    $('#modify-moisture').on('input', (e) => {
      this.modifyMoisture = parseInt(e.target.value);
      $('#modify-moisture-value').text(this.modifyMoisture > 0 ? `+${this.modifyMoisture}` : this.modifyMoisture);
    });
    
    // Set Biome controls
    $('#set-temp-enabled').on('change', (e) => {
      this.setTempEnabled = e.target.checked;
    });
    
    $('#set-temp').on('input', (e) => {
      this.setTemp = parseInt(e.target.value);
      $('#set-temp-value').text(this.setTemp);
    });
    
    $('#set-moisture-enabled').on('change', (e) => {
      this.setMoistureEnabled = e.target.checked;
    });
    
    $('#set-moisture').on('input', (e) => {
      this.setMoisture = parseInt(e.target.value);
      $('#set-moisture-value').text(this.setMoisture);
    });
    
    // Brush activation/deactivation
    $('#brush-toggle').on('click', () => {
      if (this.isBrushActive) {
        this.deactivateBrush();
      } else {
        this.activateBrush();
      }
    });
    
    $('#biome-brush-toggle').on('click', () => {
      if (this.isBrushActive) {
        this.deactivateBrush();
      } else {
        this.activateBrush();
      }
    });

    // ===== HEIGHTS TAB FILTERS =====
    // Height Range Filter for height tools
    $('#height-filter-enabled').on('change', (e) => {
      this.heightFilterEnabled = e.target.checked;
      $('#height-filter-controls').toggle(this.heightFilterEnabled);
      $('#height-filter-min').prop('disabled', !this.heightFilterEnabled);
      $('#height-filter-max').prop('disabled', !this.heightFilterEnabled);
    });
    
    $('#height-filter-min').on('input', (e) => {
      const minVal = parseInt(e.target.value);
      $('#height-filter-min-value').text(minVal);
      const maxVal = parseInt($('#height-filter-max').val());
      if (minVal > maxVal) {
        $('#height-filter-max').val(minVal);
        $('#height-filter-max-value').text(minVal);
      }
      this.heightFilterMin = minVal;
      const max = parseInt($('#height-filter-max').val());
      $('#height-filter-display').text(`${minVal}-${max}`);
    });
    
    $('#height-filter-max').on('input', (e) => {
      const maxVal = parseInt(e.target.value);
      $('#height-filter-max-value').text(maxVal);
      const minVal = parseInt($('#height-filter-min').val());
      if (maxVal < minVal) {
        $('#height-filter-min').val(maxVal);
        $('#height-filter-min-value').text(maxVal);
      }
      this.heightFilterMax = maxVal;
      const min = parseInt($('#height-filter-min').val());
      $('#height-filter-display').text(`${min}-${maxVal}`);
    });

    // Biome Filter for height tools (only affect selected biomes)
    $('#height-tool-biome-filter-enabled').on('change', (e) => {
      this.heightFilterByBiomeEnabled = e.target.checked;
      $('#height-tool-biome-filter-controls').toggle(this.heightFilterByBiomeEnabled);
      
      if (this.heightFilterByBiomeEnabled) {
        const matrix = $('#height-filter-biome-matrix');
        if (matrix.children().length === 0) {
          this._generateHeightFilterBiomeMatrix();
        }
      }
    });

    // ===== BIOMES TAB FILTERS =====
    // Height Range Filter for biome tools
    $('#biome-tool-height-filter-enabled').on('change', (e) => {
      this.biomeFilterEnabled = e.target.checked;
      $('#biome-tool-height-filter-controls').toggle(this.biomeFilterEnabled);
      $('#biome-tool-height-min').prop('disabled', !this.biomeFilterEnabled);
      $('#biome-tool-height-max').prop('disabled', !this.biomeFilterEnabled);
    });
    
    $('#biome-tool-height-min').on('input', (e) => {
      const minVal = parseInt(e.target.value);
      $('#biome-tool-height-min-value').text(minVal);
      const maxVal = parseInt($('#biome-tool-height-max').val());
      if (minVal > maxVal) {
        $('#biome-tool-height-max').val(minVal);
        $('#biome-tool-height-max-value').text(minVal);
      }
      this.biomeFilterHeightMin = minVal;
      const max = parseInt($('#biome-tool-height-max').val());
      $('#biome-tool-height-display').text(`${minVal}-${max}`);
    });
    
    $('#biome-tool-height-max').on('input', (e) => {
      const maxVal = parseInt(e.target.value);
      $('#biome-tool-height-max-value').text(maxVal);
      const minVal = parseInt($('#biome-tool-height-min').val());
      if (maxVal < minVal) {
        $('#biome-tool-height-min').val(maxVal);
        $('#biome-tool-height-min-value').text(maxVal);
      }
      this.biomeFilterHeightMax = maxVal;
      const min = parseInt($('#biome-tool-height-min').val());
      $('#biome-tool-height-display').text(`${min}-${maxVal}`);
    });

    // Biome Filter for biome tools (exclude certain biomes)
    $('#biome-tool-biome-filter-enabled').on('change', (e) => {
      this.biomeFilterByBiomeEnabled = e.target.checked;
      $('#biome-tool-biome-filter-controls').toggle(this.biomeFilterByBiomeEnabled);
      
      if (this.biomeFilterByBiomeEnabled) {
        const matrix = $('#biome-filter-biome-matrix');
        if (matrix.children().length === 0) {
          this._generateBiomeToolBiomeFilterMatrix();
        }
      }
    });
    
    $('#biome-tool-biome-filter-select').on('change', (e) => {
      const selectedValues = $(e.target).val();
      this.biomeFilterExcludedIds.clear();
      if (selectedValues) {
        selectedValues.forEach(val => this.biomeFilterExcludedIds.add(parseInt(val)));
      }
    });

    // Tabs switching
    const activateTab = (tab) => {
      // Hide all tabs
      $('#brush-tab').hide();
      $('#biomes-tab').hide();
      $('#rivers-tab').hide();
      $('#global-tab').hide();
      
      // Reset all tab buttons
      $('#tab-brush').css('background', '#333').css('font-weight', 'normal');
      $('#tab-biomes').css('background', '#333').css('font-weight', 'normal');
      $('#tab-rivers').css('background', '#333').css('font-weight', 'normal');
      $('#tab-global').css('background', '#333').css('font-weight', 'normal');
      
      // Show selected tab and highlight button
      if (tab === 'brush') {
        $('#brush-tab').show();
        $('#tab-brush').css('background', '#0066cc').css('font-weight', 'bold');
      } else if (tab === 'biomes') {
        $('#biomes-tab').show();
        $('#tab-biomes').css('background', '#0066cc').css('font-weight', 'bold');
        // Initialize biome tool UI state
        updateBiomeToolUI($('#global-map-biome-tool').val());
      } else if (tab === 'rivers') {
        $('#rivers-tab').show();
        $('#tab-rivers').css('background', '#0066cc').css('font-weight', 'bold');
      } else if (tab === 'global') {
        $('#global-tab').show();
        $('#tab-global').css('background', '#0066cc').css('font-weight', 'bold');
      }
    };
    $('#tab-brush').on('click', () => activateTab('brush'));
    $('#tab-biomes').on('click', () => activateTab('biomes'));
    $('#tab-rivers').on('click', () => activateTab('rivers'));
    $('#tab-global').on('click', () => activateTab('global'));

    // ===== RIVERS TAB =====
    $('#global-map-river-tool').on('change', (e) => {
      const tool = e.target.value;
      this.setTool(tool);
    });

    $('#river-brush-toggle').on('click', () => {
      if (this.isBrushActive) {
        this.deactivateBrush();
      } else {
        this.activateBrush();
      }
    });

    // Global operations
    $('#global-smooth-strength').on('input', (e) => {
      this.globalSmoothStrength = parseFloat(e.target.value);
      $('#global-smooth-strength-value').text(this.globalSmoothStrength.toFixed(1));
    });

    $('#global-smooth-btn').on('click', async () => {
      $('#global-smooth-btn').prop('disabled', true);
      try { this.globalSmooth(1); } finally { $('#global-smooth-btn').prop('disabled', false); }
    });
    $('#global-smooth-3-btn').on('click', async () => {
      $('#global-smooth-3-btn').prop('disabled', true);
      try { this.globalSmooth(3); } finally { $('#global-smooth-3-btn').prop('disabled', false); }
    });

    // ===== UNIFIED REPLACE TOOL =====
    // Update preview when filters or actions change
    this.updateReplacePreview = () => {
      const useBiome = $('#replace-use-biome').prop('checked');
      const useHeight = $('#replace-use-height').prop('checked');
      
      if (!useBiome && !useHeight) {
        $('#replace-preview-count').text('0');
        return;
      }
      
      const criteria = {
        heightMin: useHeight ? parseInt($('#replace-height-min').val()) : null,
        heightMax: useHeight ? parseInt($('#replace-height-max').val()) : null,
        biomeIds: useBiome ? this.replaceSourceBiomeIds : null
      };
      
      const count = this.getAffectedCellsCount(criteria);
      $('#replace-preview-count').text(count);
    };
    
    // Filter toggles
    $('#replace-use-height').on('change', (e) => {
      $('#replace-height-min').prop('disabled', !e.target.checked);
      $('#replace-height-max').prop('disabled', !e.target.checked);
      this.updateReplacePreview();
    });
    
    $('#replace-use-biome').on('change', (e) => {
      const isChecked = e.target.checked;
      const matrix = $('#replace-source-biome-matrix');
      if (isChecked) {
        if (matrix.children().length === 0) {
          this._generateReplaceSourceBiomeMatrix();
        }
        matrix.show();
      } else {
        matrix.hide();
      }
      this.updateReplacePreview();
    });
    
    // Height filter sliders
    $('#replace-height-min').on('input', (e) => {
      const minVal = parseInt(e.target.value);
      $('#replace-height-min-value').text(minVal);
      const maxVal = parseInt($('#replace-height-max').val());
      if (minVal > maxVal) {
        $('#replace-height-max').val(minVal);
        $('#replace-height-max-value').text(minVal);
      }
      this.updateReplacePreview();
    });
    
    $('#replace-height-max').on('input', (e) => {
      const maxVal = parseInt(e.target.value);
      $('#replace-height-max-value').text(maxVal);
      const minVal = parseInt($('#replace-height-min').val());
      if (maxVal < minVal) {
        $('#replace-height-min').val(maxVal);
        $('#replace-height-min-value').text(maxVal);
      }
      this.updateReplacePreview();
    });
    
    // Action toggles
    $('#replace-set-height').on('change', (e) => {
      $('#replace-set-height-val').prop('disabled', !e.target.checked);
    });
    
    $('#replace-set-biome').on('change', (e) => {
      const isChecked = e.target.checked;
      const matrix = $('#replace-target-biome-matrix');
      if (isChecked) {
        if (matrix.children().length === 0) {
          this._generateReplaceTargetBiomeMatrix();
        }
        matrix.show();
      } else {
        matrix.hide();
      }
    });
    
    // Set height slider
    $('#replace-set-height-val').on('input', (e) => {
      $('#replace-set-height-display').text(e.target.value);
    });
    
    // Main Replace button
    $('#replace-apply-btn').on('click', () => {
      const useBiome = $('#replace-use-biome').prop('checked');
      const useHeight = $('#replace-use-height').prop('checked');
      const setHeight = $('#replace-set-height').prop('checked');
      const setBiome = $('#replace-set-biome').prop('checked');
      
      if (!useBiome && !useHeight) {
        ui.notifications.warn('Select at least one filter');
        return;
      }
      
      if (!setHeight && !setBiome) {
        ui.notifications.warn('Select at least one action');
        return;
      }
      
      const criteria = {
        heightMin: useHeight ? parseInt($('#replace-height-min').val()) : null,
        heightMax: useHeight ? parseInt($('#replace-height-max').val()) : null,
        sourceBiomeIds: useBiome ? this.replaceSourceBiomeIds : null,
        targetHeight: setHeight ? parseInt($('#replace-set-height-val').val()) : null
      };
      
      if (setBiome) {
        if (!this.replaceTargetBiomeId) {
          ui.notifications.warn('Select target biome');
          return;
        }
        const targetParams = this.processing.biomeResolver.getParametersFromBiomeId(this.replaceTargetBiomeId);
        criteria.targetTemp = targetParams.temperature;
        criteria.targetMoisture = targetParams.moisture;
      }
      
      this.applyReplaceByCombinedFilter(criteria);
    });
    
    // Flatten All button
    $('#replace-flatten-btn').on('click', () => {
      const targetHeight = parseInt($('#replace-set-height-val').val());
      const confirmed = confirm(`Flatten entire map to height ${targetHeight}%?`);
      if (confirmed) {
        this.applyFlattenMap(targetHeight);
      }
    });

    $('#global-map-exit').on('click', async () => {
      await this.deactivate();
    });
    
    // Initialize UI state
    this.updateBrushUI();
  }

  /**
   * Get pattern color or darken base color
   * @private
   * @param {Object} pattern - Pattern config from biome
   * @param {number} baseColor - RGB color as hex
   * @returns {string} RGB color string for pattern overlay
   */
  _getPatternColor(pattern, baseColor) {
    if (!pattern) return null;
    
    if (pattern.patternColor) {
      // Use explicit pattern color from config
      const colorStr = pattern.patternColor;
      if (colorStr.startsWith('#')) {
        return colorStr;
      }
      // Parse hex string like "284828"
      const color = parseInt(colorStr, 16);
      const r = (color >> 16) & 0xFF;
      const g = (color >> 8) & 0xFF;
      const b = color & 0xFF;
      return `rgb(${r},${g},${b})`;
    }
    
    // Darken base color
    const darkenFactor = pattern.darkenFactor || 0.3;
    const r = Math.floor(((baseColor >> 16) & 0xFF) * (1 - darkenFactor));
    const g = Math.floor(((baseColor >> 8) & 0xFF) * (1 - darkenFactor));
    const b = Math.floor((baseColor & 0xFF) * (1 - darkenFactor));
    return `rgb(${r},${g},${b})`;
  }

  /**
   * Check if cell passes current filters based on current tool
   * @private
   * @param {number} idx - Cell index in grid
   * @param {Float32Array} heights - Heights array
   * @param {Uint8Array} temperature - Temperature array
   * @param {Uint8Array} moisture - Moisture array
   * @returns {boolean} True if cell should be affected by brush
   */
  _isCellPassesFilter(idx, heights, temperature, moisture) {
    const h = heights[idx];
    const temp = temperature ? temperature[idx] : 0;
    const moist = moisture ? moisture[idx] : 0;
    const cellBiomeId = this.processing.biomeResolver.getBiomeId(moist, temp, h);

    // Height-based tools: raise, lower, smooth, roughen, flatten
    const isHeightTool = ['raise', 'lower', 'smooth', 'roughen', 'flatten'].includes(this.currentTool);
    
    if (isHeightTool) {
      // Filter by height range
      if (this.heightFilterEnabled) {
        if (h < this.heightFilterMin || h > this.heightFilterMax) {
          return false; // Cell height is outside filter range
        }
      }
      
      // Filter by specific biomes (only affect selected biomes)
      if (this.heightFilterByBiomeEnabled && this.heightFilterBiomeIds.size > 0) {
        if (!this.heightFilterBiomeIds.has(cellBiomeId)) {
          return false; // Cell biome is not in the allowed list
        }
      }
    }
    // Biome-based tools: modify-biome, set-biome
    else if (this.currentTool === 'modify-biome' || this.currentTool === 'set-biome') {
      // Filter by height range
      if (this.biomeFilterEnabled) {
        if (h < this.biomeFilterHeightMin || h > this.biomeFilterHeightMax) {
          return false; // Cell height is outside filter range
        }
      }
      
      // Filter by specific biomes (exclude certain biomes)
      if (this.biomeFilterByBiomeEnabled && this.biomeFilterExcludedIds.size > 0) {
        if (this.biomeFilterExcludedIds.has(cellBiomeId)) {
          return false; // Cell biome is in excluded list
        }
      }
    }

    return true; // Cell passes all filters
  }

  /**
   * Hide tools UI panel
   */
  hideToolsUI() {
    $('#global-map-tools-ui').remove();
  }

  /**
   * Update combined preview count
   * @private
   */
  updateCombinedPreview() {
    const useBiome = $('#combined-use-biome').prop('checked');
    const useHeight = $('#combined-use-height').prop('checked');
    
    if (!useBiome && !useHeight) {
      $('#combined-count').text('0');
      return;
    }
    
    const criteria = {
      heightMin: useHeight ? parseInt($('#combined-height-min').val()) : null,
      heightMax: useHeight ? parseInt($('#combined-height-max').val()) : null,
      biomeId: useBiome ? parseInt($('#combined-biome').val()) : null
    };
    
    const count = this.getAffectedCellsCount(criteria);
    $('#combined-count').text(count);
  }

  /**
   * Count cells matching criteria for preview
   * @param {Object} criteria - Filter criteria {heightMin, heightMax, biomeId/biomeIds}
   * @returns {number} Count of matching cells
   */
  getAffectedCellsCount(criteria) {
    if (!this.renderer.currentGrid) return 0;

    const { heights, temperature, moisture, rows, cols } = this.renderer.currentGrid;
    let count = 0;

    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      const t = temperature ? temperature[i] : 0;
      const m = moisture ? moisture[i] : 0;

      let matches = true;

      // Check height range
      if (criteria.heightMin !== null && h < criteria.heightMin) matches = false;
      if (criteria.heightMax !== null && h > criteria.heightMax) matches = false;

      // Check biome (single or multiple)
      if (criteria.biomeId !== null && criteria.biomeId !== undefined) {
        const cellBiomeId = this.processing.biomeResolver.getBiomeId(m, t, h);
        if (cellBiomeId !== criteria.biomeId) matches = false;
      } else if (criteria.biomeIds !== null && criteria.biomeIds !== undefined && criteria.biomeIds.size > 0) {
        const cellBiomeId = this.processing.biomeResolver.getBiomeId(m, t, h);
        if (!criteria.biomeIds.has(cellBiomeId)) matches = false;
      }

      if (matches) count++;
    }

    return count;
  }

  /**
   * Replace all cells matching height criteria
   * @param {number} heightMin - Minimum height to match
   * @param {number} heightMax - Maximum height to match
   * @param {number} replacementHeight - Height to replace with
   * @returns {number} Number of cells modified
   */
  applyReplaceByHeight(heightMin, heightMax, replacementHeight) {
    if (!this.renderer.currentGrid) {
      ui.notifications.warn('No grid loaded');
      return 0;
    }

    const { heights } = this.renderer.currentGrid;
    let count = 0;

    for (let i = 0; i < heights.length; i++) {
      if (heights[i] >= heightMin && heights[i] <= heightMax) {
        heights[i] = replacementHeight;
        count++;
      }
    }

    // Re-render
    this.renderer.render(
      this.renderer.currentGrid,
      this.renderer.currentMetadata,
      { mode: 'heights' }
    );

    console.log(`GlobalMapTools | ✓ Replaced ${count} cells by height`);
    ui.notifications.info(`Replaced ${count} cells (height ${heightMin.toFixed(1)}-${heightMax.toFixed(1)} → ${replacementHeight.toFixed(1)})`);
    return count;
  }

  /**
   * Replace all cells with specific biome
   * @param {number} sourceBiomeId - Biome ID to replace
   * @param {number} targetTemp - New temperature
   * @param {number} targetMoisture - New moisture
   * @returns {number} Number of cells modified
   */
  applyReplaceByBiome(sourceBiomeId, targetTemp, targetMoisture) {
    if (!this.renderer.currentGrid) {
      ui.notifications.warn('No grid loaded');
      return 0;
    }

    const { heights, temperature, moisture } = this.renderer.currentGrid;
    let count = 0;

    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      const t = temperature ? temperature[i] : 0;
      const m = moisture ? moisture[i] : 0;

      const cellBiomeId = this.processing.biomeResolver.getBiomeId(m, t, h);
      if (cellBiomeId === sourceBiomeId) {
        if (temperature) temperature[i] = targetTemp;
        if (moisture) moisture[i] = targetMoisture;
        count++;
      }
    }

    // Re-render
    this.renderer.render(
      this.renderer.currentGrid,
      this.renderer.currentMetadata,
      { mode: 'heights' }
    );

    console.log(`GlobalMapTools | ✓ Replaced ${count} cells by biome`);
    ui.notifications.info(`Replaced ${count} cells: biome changed`);
    return count;
  }

  /**
   * Apply combined filter replacement (height AND/OR biome)
   * @param {Object} criteria - {heightMin, heightMax, sourceBiomeId/sourceBiomeIds, targetTemp, targetMoisture, targetHeight}
   * @returns {number} Number of cells modified
   */
  applyReplaceByCombinedFilter(criteria) {
    if (!this.renderer.currentGrid) {
      ui.notifications.warn('No grid loaded');
      return 0;
    }

    const { heights, temperature, moisture } = this.renderer.currentGrid;
    let count = 0;

    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      const t = temperature ? temperature[i] : 0;
      const m = moisture ? moisture[i] : 0;

      let matches = true;

      // Check height range (if specified)
      if (criteria.heightMin !== null && criteria.heightMin !== undefined) {
        if (h < criteria.heightMin) matches = false;
      }
      if (criteria.heightMax !== null && criteria.heightMax !== undefined) {
        if (h > criteria.heightMax) matches = false;
      }

      // Check biome (single or multiple)
      if (matches && criteria.sourceBiomeId !== null && criteria.sourceBiomeId !== undefined) {
        const cellBiomeId = this.processing.biomeResolver.getBiomeId(m, t, h);
        if (cellBiomeId !== criteria.sourceBiomeId) matches = false;
      } else if (matches && criteria.sourceBiomeIds !== null && criteria.sourceBiomeIds !== undefined && criteria.sourceBiomeIds.size > 0) {
        const cellBiomeId = this.processing.biomeResolver.getBiomeId(m, t, h);
        if (!criteria.sourceBiomeIds.has(cellBiomeId)) matches = false;
      }

      if (matches) {
        // Apply replacements
        if (criteria.targetHeight !== null && criteria.targetHeight !== undefined) {
          heights[i] = criteria.targetHeight;
        }
        if (criteria.targetTemp !== null && criteria.targetTemp !== undefined && temperature) {
          temperature[i] = criteria.targetTemp;
        }
        if (criteria.targetMoisture !== null && criteria.targetMoisture !== undefined && moisture) {
          moisture[i] = criteria.targetMoisture;
        }
        count++;
      }
    }

    // Re-render
    this.renderer.render(
      this.renderer.currentGrid,
      this.renderer.currentMetadata,
      { mode: 'heights' }
    );

    console.log(`GlobalMapTools | ✓ Applied combined filter replacement to ${count} cells`);
    ui.notifications.info(`Replaced ${count} cells with combined criteria`);
    return count;
  }

  /**
   * Flatten entire map to single height
   * @param {number} targetHeight - Height to set all cells to
   * @returns {number} Always returns total number of cells
   */
  applyFlattenMap(targetHeight) {
    if (!this.renderer.currentGrid) {
      ui.notifications.warn('No grid loaded');
      return 0;
    }

    const { heights } = this.renderer.currentGrid;
    const count = heights.length;

    for (let i = 0; i < heights.length; i++) {
      heights[i] = targetHeight;
    }

    // Re-render
    this.renderer.render(
      this.renderer.currentGrid,
      this.renderer.currentMetadata,
      { mode: 'heights' }
    );

    console.log(`GlobalMapTools | ✓ Flattened entire map to height ${targetHeight}`);
    ui.notifications.info(`Map flattened: all ${count} cells set to height ${targetHeight.toFixed(1)}`);
    return count;
  }

  /**
   * Apply global smooth to entire grid
   * @param {number} iterations - Number of smoothing passes
   */
  globalSmooth(iterations = 1) {
    if (!this.renderer.currentGrid) {
      ui.notifications.warn('No grid loaded');
      return;
    }

    console.log(`GlobalMapTools | Applying global smooth (${iterations} iterations, strength: ${this.globalSmoothStrength})...`);
    const { heights, rows, cols } = this.renderer.currentGrid;

    for (let iter = 0; iter < iterations; iter++) {
      const tempHeights = new Float32Array(heights);

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const idx = row * cols + col;

          // Average with neighbors (3x3 neighborhood)
          let sum = heights[idx];
          let count = 1;

          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;

              const nRow = row + dr;
              const nCol = col + dc;

              if (nRow >= 0 && nRow < rows && nCol >= 0 && nCol < cols) {
                const nIdx = nRow * cols + nCol;
                sum += tempHeights[nIdx];
                count++;
              }
            }
          }

          const avg = sum / count;
          const delta = (avg - heights[idx]) * this.globalSmoothStrength;
          heights[idx] += delta;
        }
      }
    }

    // Re-render
    this.renderer.render(
      this.renderer.currentGrid,
      this.renderer.currentMetadata,
      { mode: 'heights' }
    );

    console.log(`GlobalMapTools | ✓ Global smooth applied (${iterations} iterations, strength: ${this.globalSmoothStrength})`);
    ui.notifications.info(`Global map smoothed (${iterations} ${iterations === 1 ? 'pass' : 'passes'}, strength: ${this.globalSmoothStrength.toFixed(1)})`);
  }

  /**
   * Activate cell inspector mode
   */
  activateCellInspector() {
    if (this.isCellInspectorActive) return;

    console.log('GlobalMapTools | Activating cell inspector...');
    this.isCellInspectorActive = true;

    // Show renderer if not visible
    if (!this.renderer.isVisible) {
      this.renderer.show();
    }

    // Create click handler
    this.cellInspectorHandler = (event) => {
      if (!this.isCellInspectorActive) return;
      if (event.data.button !== 0) return; // Only left click

      const pos = event.data.getLocalPosition(canvas.stage);
      this.inspectCellAtPosition(pos.x, pos.y);
    };

    // Attach to canvas
    if (canvas.stage) {
      canvas.stage.on('pointerdown', this.cellInspectorHandler);
    }

    console.log('GlobalMapTools | ✓ Cell inspector activated');
  }

  /**
   * Deactivate cell inspector mode
   */
  deactivateCellInspector() {
    if (!this.isCellInspectorActive) return;

    console.log('GlobalMapTools | Deactivating cell inspector...');
    this.isCellInspectorActive = false;

    // Remove event handler
    if (canvas.stage && this.cellInspectorHandler) {
      canvas.stage.off('pointerdown', this.cellInspectorHandler);
      this.cellInspectorHandler = null;
    }

    console.log('GlobalMapTools | ✓ Cell inspector deactivated');
  }

  /**
   * Inspect cell at world position and log data to console
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   */
  inspectCellAtPosition(worldX, worldY) {
    if (!this.renderer.currentGrid || !this.renderer.currentMetadata) {
      console.warn('GlobalMapTools | No grid loaded for inspection');
      return;
    }

    const grid = this.renderer.currentGrid;
    const metadata = this.renderer.currentMetadata;
    const { heights, biomes, moisture, temperature, rows, cols } = grid;
    const { cellSize, bounds } = metadata;

    // Convert world coords to grid coords
    const gridCol = Math.floor((worldX - bounds.minX) / cellSize);
    const gridRow = Math.floor((worldY - bounds.minY) / cellSize);

    // Check bounds
    if (gridRow < 0 || gridRow >= rows || gridCol < 0 || gridCol >= cols) {
      console.log('GlobalMapTools | Click outside grid bounds');
      return;
    }

    const idx = gridRow * cols + gridCol;

    // Gather cell data
    const height = heights[idx];
    const moist = moisture ? moisture[idx] : null;
    const temp = temperature ? temperature[idx] : null;

    // Get biome name and color from BiomeResolver
    let biomeName = 'Unknown';
    let biomeColor = 0x888888; // Default gray
    if (moist !== null && temp !== null && this.processing?.biomeResolver) {
      // Calculate biome ID from moisture, temperature, and height
      const biomeId = this.processing.biomeResolver.getBiomeId(moist, temp, height);
      const params = this.processing.biomeResolver.getParametersFromBiomeId(biomeId);
      biomeName = params.name || `Biome ${biomeId}`;
      
      // Get biome color
      biomeColor = this.processing.biomeResolver.getBiomeColor(biomeId);
    }

    // Format color as hex string
    const colorHex = '#' + ('000000' + biomeColor.toString(16)).slice(-6).toUpperCase();
    
    // Log to console with color styling
    console.log(
      `%c${biomeName}%c (h=${height.toFixed(1)}, t=${temp ?? '?'}, m=${moist ?? '?'})`,
      `background-color: ${colorHex}; color: ${this._getContrastColor(biomeColor)}; padding: 2px 6px; border-radius: 3px; font-weight: bold;`,
      `color: inherit; padding: 2px 0;`
    );
  }

  /**
   * Get contrasting text color (black or white) for given background color
   * @private
   * @param {number} rgbColor - RGB color as 24-bit integer
   * @returns {string} '#000000' or '#FFFFFF'
   */
  _getContrastColor(rgbColor) {
    // Extract RGB components
    const r = (rgbColor >> 16) & 0xFF;
    const g = (rgbColor >> 8) & 0xFF;
    const b = rgbColor & 0xFF;
    
    // Calculate relative luminance (WCAG formula)
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    
    // Return black for bright colors, white for dark colors
    return luminance > 0.5 ? '#000000' : '#FFFFFF';
  }
}

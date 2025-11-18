import { HEIGHTMAP_SETTINGS } from './heightmap-config.mjs';

/**
 * Height Map Renderer using Metaballs
 * Renders smooth height map visualization using metaball technique
 */
export class HeightMapRenderer {
  constructor(heightMapManager) {
    this.heightMapManager = heightMapManager;
    this.contourContainer = null;
    this.isVisible = false;
    this.renderMode = HEIGHTMAP_SETTINGS.defaultRenderMode;
    
    // Cache for heightField
    this.cachedHeightField = null;
    this.cachedBounds = null;
    this.cachedCellSize = null;
  }

  /**
   * Initialize the renderer
   */
  initialize() {
    console.log('HeightMapRenderer | Initializing...');
    
    // Hook into canvas ready to set up rendering
    Hooks.on('canvasReady', async () => {
      await this.onCanvasReady();
    });
  }

  /**
   * Called when canvas is ready
   */
  async onCanvasReady() {
    this.setupContainerLayer();
    
    // If height map is loaded and was previously visible, render it
    if (this.heightMapManager.isLoaded() && this.isVisible) {
      await this.render();
    }
  }

  /**
   * Set up the container layer on the effects layer
   */
  setupContainerLayer() {
    // Get the effects layer
    const effectsLayer = canvas.interface;
    
    if (!effectsLayer) {
      console.warn('HeightMapRenderer | Effects layer not available');
      return;
    }

    // Clear any existing container
    if (this.contourContainer) {
      this.contourContainer.destroy({children: true});
    }

    // Create new container for height map
    this.contourContainer = new PIXI.Container();
    this.contourContainer.name = 'heightMapContours';
    
    // Add to effects layer
    effectsLayer.addChild(this.contourContainer);
    
    console.log('HeightMapRenderer | Container layer set up');
  }

  /**
   * Render the height map
   */
  async render() {
    if (!this.heightMapManager.isLoaded()) {
      console.warn('HeightMapRenderer | No height map data available');
      ui.notifications.warn('No height map loaded for this scene');
      return;
    }

    console.log('HeightMapRenderer | Rendering height map...');

    // Make sure container is set up
    if (!this.contourContainer) {
      this.setupContainerLayer();
    }

    // Clear existing graphics
    this.clear();

    const processedData = this.heightMapManager.getProcessedData();
    
    // Try to load heightField from file or cache
    let heightField, bounds, cellSize;
    
    if (this.cachedHeightField) {
      console.log('HeightMapRenderer | Using cached heightField');
      heightField = this.cachedHeightField;
      bounds = this.cachedBounds;
      cellSize = this.cachedCellSize;
    } else {
      // Try to load from file
      const loadedData = await this.heightMapManager.loadHeightFieldFromFile();
      
      if (loadedData) {
        console.log('HeightMapRenderer | Loaded heightField from file');
        heightField = loadedData.heightField;
        bounds = loadedData.bounds;
        cellSize = loadedData.cellSize;
        
        // Cache it
        this.cachedHeightField = heightField;
        this.cachedBounds = bounds;
        this.cachedCellSize = cellSize;
      } else {
        // Generate from scratch
        console.log('HeightMapRenderer | Generating heightField from source data');
        
        bounds = this._calculateBounds(processedData.heightPoints);
        if (!bounds) {
          console.warn('HeightMapRenderer | Could not calculate bounds');
          return;
        }
        
        cellSize = canvas.grid.size / 4;
        heightField = this._createHeightField(processedData.heightPoints, bounds, cellSize);
        
        // Cache it
        this.cachedHeightField = heightField;
        this.cachedBounds = bounds;
        this.cachedCellSize = cellSize;
        
        // Save to file for future use
        await this.heightMapManager.saveHeightFieldToFile(heightField, bounds, cellSize);
        console.log('HeightMapRenderer | HeightField saved to file');
      }
    }
    
    // Draw based on render mode
    if (this.renderMode === 'filled') {
      this._drawFilledRegions(heightField, bounds, cellSize, processedData.contourLevels);
    } else {
      this._drawContourLines(heightField, bounds, cellSize, processedData.contourLevels);
    }

    this.isVisible = true;
    console.log('HeightMapRenderer | Height map rendered successfully');
  }

  /**
   * Create height field from all points with actual height values
   */
  _createHeightField(points, bounds, cellSize) {
    const cols = Math.ceil((bounds.maxX - bounds.minX) / cellSize);
    const rows = Math.ceil((bounds.maxY - bounds.minY) / cellSize);
    const field = { values: new Float32Array(rows * cols), rows, cols };
    const influenceRadius = cellSize * 4;
    
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + row * cellSize;
        
        // Inverse distance weighted interpolation of actual height values
        let totalWeight = 0;
        let weightedHeight = 0;
        
        for (const point of points) {
          const dx = x - point.x;
          const dy = y - point.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          
          if (distance < influenceRadius) {
            const weight = 1 / (distance + 1);
            weightedHeight += point.height * weight;
            totalWeight += weight;
          }
        }
        
        field.values[row * cols + col] = totalWeight > 0 ? weightedHeight / totalWeight : 0;
      }
    }
    
    return field;
  }
  
  /**
   * Draw filled regions by sampling height field
   */
  _drawFilledRegions(heightField, bounds, cellSize, contourLevels) {
    const { values, rows, cols } = heightField;
    
    // Draw from highest to lowest so higher elevations are on top
    const sortedLevels = [...contourLevels].sort((a, b) => b.level - a.level);
    
    for (const levelInfo of sortedLevels) {
      const graphics = new PIXI.Graphics();
      graphics.beginFill(levelInfo.color, HEIGHTMAP_SETTINGS.fillAlpha);
      
      // Find all cells that belong to this height range
      for (let row = 0; row < rows - 1; row++) {
        for (let col = 0; col < cols - 1; col++) {
          const height = values[row * cols + col];
          
          // Check if this cell is in the current height range
          if (height >= levelInfo.minHeight && height < levelInfo.maxHeight) {
            const x = bounds.minX + col * cellSize;
            const y = bounds.minY + row * cellSize;
            
            // Draw a small rectangle for this cell
            graphics.drawRect(x, y, cellSize, cellSize);
          }
        }
      }
      
      graphics.endFill();
      graphics.name = `heightmap_fill_${levelInfo.level}`;
      graphics.interactive = false;
      this.contourContainer.addChild(graphics);
    }
  }

  /**
   * Calculate bounds based on scene dimensions
   * This ensures heightField covers entire scene, not just data points
   */
  _calculateBounds(points) {
    if (points.length === 0) return null;
    
    // Use scene dimensions as bounds
    const sceneDimensions = canvas.scene.dimensions;
    
    return {
      minX: 0,
      minY: 0,
      maxX: sceneDimensions.width,
      maxY: sceneDimensions.height
    };
  }

  /**
   * Create influence field for metaball rendering
   */
  _createInfluenceField(points, bounds, cellSize, rows, cols) {
    const field = new Array(rows * cols);
    const influenceRadius = cellSize * 4; // How far each point influences
    
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + row * cellSize;
        
        let totalInfluence = 0;
        
        // Calculate influence from all points
        for (const point of points) {
          const dx = x - point.x;
          const dy = y - point.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          
          if (distance < influenceRadius) {
            // Metaball function: 1 - (d/r)^2
            const normalizedDistance = distance / influenceRadius;
            const influence = Math.max(0, 1 - normalizedDistance * normalizedDistance);
            totalInfluence += influence;
          }
        }
        
        field[row * cols + col] = totalInfluence;
      }
    }
    
    return field;
  }

  /**
   * Marching squares algorithm with masking for hierarchical layers
   */
  _marchingSquaresWithMask(field, maskField, rows, cols, bounds, cellSize, threshold) {
    const contours = [];
    const maskThreshold = 0.4; // Threshold for mask
    
    for (let row = 0; row < rows - 1; row++) {
      for (let col = 0; col < cols - 1; col++) {
        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + row * cellSize;
        
        // Get corner values
        let v00 = field[row * cols + col];
        let v10 = field[row * cols + (col + 1)];
        let v01 = field[(row + 1) * cols + col];
        let v11 = field[(row + 1) * cols + (col + 1)];
        
        // Apply mask - if any corner is masked by higher level, set its value to 0
        if (maskField) {
          if (maskField[row * cols + col] >= maskThreshold) v00 = 0;
          if (maskField[row * cols + (col + 1)] >= maskThreshold) v10 = 0;
          if (maskField[(row + 1) * cols + col] >= maskThreshold) v01 = 0;
          if (maskField[(row + 1) * cols + (col + 1)] >= maskThreshold) v11 = 0;
        }
        
        // Calculate marching squares case
        let caseValue = 0;
        if (v00 >= threshold) caseValue |= 1;
        if (v10 >= threshold) caseValue |= 2;
        if (v11 >= threshold) caseValue |= 4;
        if (v01 >= threshold) caseValue |= 8;
        
        // Generate line segments based on case
        const segments = this._getSegmentsForCase(caseValue, x, y, cellSize, 
          v00, v10, v01, v11, threshold);
        
        if (segments.length > 0) {
          contours.push(...segments);
        }
      }
    }
    
    return contours;
  }

  /**
   * Marching squares algorithm to extract contours from field (original without mask)
   */
  _marchingSquares(field, rows, cols, bounds, cellSize, threshold) {
    const contours = [];
    
    for (let row = 0; row < rows - 1; row++) {
      for (let col = 0; col < cols - 1; col++) {
        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + row * cellSize;
        
        // Get corner values
        const v00 = field[row * cols + col];
        const v10 = field[row * cols + (col + 1)];
        const v01 = field[(row + 1) * cols + col];
        const v11 = field[(row + 1) * cols + (col + 1)];
        
        // Calculate marching squares case
        let caseValue = 0;
        if (v00 >= threshold) caseValue |= 1;
        if (v10 >= threshold) caseValue |= 2;
        if (v11 >= threshold) caseValue |= 4;
        if (v01 >= threshold) caseValue |= 8;
        
        // Generate line segments based on case
        const segments = this._getSegmentsForCase(caseValue, x, y, cellSize, 
          v00, v10, v01, v11, threshold);
        
        if (segments.length > 0) {
          contours.push(...segments);
        }
      }
    }
    
    return contours;
  }

  /**
   * Get line segments for marching squares case
   */
  _getSegmentsForCase(caseValue, x, y, size, v00, v10, v01, v11, threshold) {
    const segments = [];
    
    // Helper to interpolate edge crossing
    const lerp = (v1, v2) => {
      if (Math.abs(v2 - v1) < 0.0001) return 0.5;
      return (threshold - v1) / (v2 - v1);
    };
    
    // Edge midpoints (with interpolation)
    const edges = {
      top: { x: x + size * lerp(v00, v10), y: y },
      right: { x: x + size, y: y + size * lerp(v10, v11) },
      bottom: { x: x + size * lerp(v01, v11), y: y + size },
      left: { x: x, y: y + size * lerp(v00, v01) }
    };
    
    // Marching squares lookup table
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
      // case 0 and 15: no lines
    }
    
    return segments;
  }

  /**
   * Draw contours
   */
  _drawContours(contours, color, level) {
    if (contours.length === 0) return;
    
    const graphics = new PIXI.Graphics();
    graphics.lineStyle(2, color, 0.8);
    graphics.beginFill(color, 0.15);
    
    // Draw each segment
    for (const segment of contours) {
      if (segment.length === 2) {
        graphics.moveTo(segment[0].x, segment[0].y);
        graphics.lineTo(segment[1].x, segment[1].y);
      }
    }
    
    graphics.endFill();
    graphics.name = `heightmap_level_${level}`;
    graphics.interactive = false;
    
    this.contourContainer.addChild(graphics);
  }

  /**
   * Clear all rendered contours
   */
  clear() {
    if (this.contourContainer) {
      this.contourContainer.removeChildren();
    }
  }

  /**
   * Show the height map
   */
  async show() {
    if (!this.heightMapManager.isLoaded()) {
      console.warn('HeightMapRenderer | No height map loaded');
      ui.notifications.warn('No height map loaded for this scene');
      return;
    }

    // If container exists and has content, just show it
    if (this.contourContainer && this.contourContainer.children.length > 0) {
      this.contourContainer.visible = true;
      this.isVisible = true;
      console.log('HeightMapRenderer | Height map shown (from cache)');
    } else {
      // Need to render
      await this.render();
      this.isVisible = true;
      console.log('HeightMapRenderer | Height map shown (rendered)');
    }
  }

  /**
   * Hide the height map
   */
  hide() {
    if (this.contourContainer) {
      this.contourContainer.visible = false;
    }
    
    this.isVisible = false;
    console.log('HeightMapRenderer | Height map hidden');
  }

  /**
   * Toggle visibility of the height map
   */
  async toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      await this.show();
    }
  }

  /**
   * Check if height map is visible
   */
  isHeightMapVisible() {
    return this.isVisible;
  }

  /**
   * Set render mode
   * @param {string} mode - 'filled' or 'contours'
   */
  setRenderMode(mode) {
    if (mode !== 'filled' && mode !== 'contours') {
      console.warn(`HeightMapRenderer | Invalid render mode: ${mode}`);
      return;
    }
    
    this.renderMode = mode;
    console.log(`HeightMapRenderer | Render mode set to: ${mode}`);
    
    // Re-render if currently visible
    if (this.isVisible) {
      this.render();
    }
  }

  /**
   * Get current render mode
   */
  getRenderMode() {
    return this.renderMode;
  }

  /**
   * Get cached heightField
   * @returns {Object|null} Cached heightField or null
   */
  getHeightField() {
    return this.cachedHeightField ? {
      heightField: this.cachedHeightField,
      bounds: this.cachedBounds,
      cellSize: this.cachedCellSize
    } : null;
  }

  /**
   * Invalidate heightField cache (force regeneration on next render)
   */
  invalidateCache() {
    console.log('HeightMapRenderer | Cache invalidated');
    this.cachedHeightField = null;
    this.cachedBounds = null;
    this.cachedCellSize = null;
    this.isVisible = false;  // Force re-render on next show()
  }

  /**
   * Update heightField cache and optionally save to file
   * @param {Object} heightField - Updated heightField
   * @param {boolean} saveToFile - Whether to save to file immediately
   */
  async updateHeightField(heightField, saveToFile = false) {
    this.cachedHeightField = heightField;
    
    if (saveToFile) {
      await this.heightMapManager.saveHeightFieldToFile(
        heightField, 
        this.cachedBounds, 
        this.cachedCellSize,
        null,
        true // Mark as edited
      );
      console.log('HeightMapRenderer | HeightField updated and saved');
    }
    
    // Re-render if visible
    if (this.isVisible) {
      await this.render();
    }
  }

  /**
   * Edit height at a specific world coordinate using a brush
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   * @param {number} radius - Brush radius in pixels
   * @param {number} delta - Height change (can be positive or negative)
   * @param {number} strength - Brush strength (0-1), affects falloff
   * @returns {boolean} Success status
   */
  editHeight(worldX, worldY, radius, delta, strength = 1.0) {
    if (!this.cachedHeightField) {
      console.warn('HeightMapRenderer | No heightField loaded for editing');
      return false;
    }

    const { values, rows, cols } = this.cachedHeightField;
    const { minX, minY } = this.cachedBounds;
    const cellSize = this.cachedCellSize;

    // Convert world coordinates to grid coordinates
    const centerCol = (worldX - minX) / cellSize;
    const centerRow = (worldY - minY) / cellSize;

    // Calculate grid radius
    const gridRadius = radius / cellSize;
    const radiusSq = gridRadius * gridRadius;

    // Apply brush to affected cells
    const minRow = Math.max(0, Math.floor(centerRow - gridRadius));
    const maxRow = Math.min(rows - 1, Math.ceil(centerRow + gridRadius));
    const minCol = Math.max(0, Math.floor(centerCol - gridRadius));
    const maxCol = Math.min(cols - 1, Math.ceil(centerCol + gridRadius));

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const dx = col - centerCol;
        const dy = row - centerRow;
        const distSq = dx * dx + dy * dy;

        if (distSq <= radiusSq) {
          // Calculate falloff (smooth at edges)
          const falloff = 1 - Math.sqrt(distSq / radiusSq);
          const effectiveStrength = falloff * strength;

          const idx = row * cols + col;
          const currentHeight = values[idx];
          const newHeight = currentHeight + (delta * effectiveStrength);

          // Clamp to valid range (0-100)
          values[idx] = Math.max(0, Math.min(100, newHeight));
        }
      }
    }

    return true;
  }

  /**
   * Smooth heights in a region
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate  
   * @param {number} radius - Brush radius in pixels
   * @param {number} strength - Smoothing strength (0-1)
   * @returns {boolean} Success status
   */
  smoothHeight(worldX, worldY, radius, strength = 0.5) {
    if (!this.cachedHeightField) {
      console.warn('HeightMapRenderer | No heightField loaded for editing');
      return false;
    }

    const { values, rows, cols } = this.cachedHeightField;
    const { minX, minY } = this.cachedBounds;
    const cellSize = this.cachedCellSize;

    // Convert world coordinates to grid coordinates
    const centerCol = (worldX - minX) / cellSize;
    const centerRow = (worldY - minY) / cellSize;

    // Calculate grid radius
    const gridRadius = radius / cellSize;
    const radiusSq = gridRadius * gridRadius;

    // Calculate affected area
    const minRow = Math.max(0, Math.floor(centerRow - gridRadius));
    const maxRow = Math.min(rows - 1, Math.ceil(centerRow + gridRadius));
    const minCol = Math.max(0, Math.floor(centerCol - gridRadius));
    const maxCol = Math.min(cols - 1, Math.ceil(centerCol + gridRadius));

    // Create temporary array for smoothed values
    const smoothed = new Float32Array(values.length);
    smoothed.set(values);

    // Apply smoothing
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const dx = col - centerCol;
        const dy = row - centerRow;
        const distSq = dx * dx + dy * dy;

        if (distSq <= radiusSq) {
          // Calculate average of neighbors
          let sum = 0;
          let count = 0;

          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const nr = row + dr;
              const nc = col + dc;

              if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                sum += values[nr * cols + nc];
                count++;
              }
            }
          }

          const average = sum / count;
          const idx = row * cols + col;
          const currentHeight = values[idx];

          // Calculate falloff
          const falloff = 1 - Math.sqrt(distSq / radiusSq);
          const effectiveStrength = falloff * strength;

          // Blend between current and smoothed
          smoothed[idx] = currentHeight + (average - currentHeight) * effectiveStrength;
        }
      }
    }

    // Copy smoothed values back
    values.set(smoothed);

    return true;
  }

  /**
   * Flatten heights to a specific value in a region
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   * @param {number} radius - Brush radius in pixels
   * @param {number} targetHeight - Target height to flatten to
   * @param {number} strength - Flattening strength (0-1)
   * @returns {boolean} Success status
   */
  flattenHeight(worldX, worldY, radius, targetHeight, strength = 1.0) {
    if (!this.cachedHeightField) {
      console.warn('HeightMapRenderer | No heightField loaded for editing');
      return false;
    }

    const { values, rows, cols } = this.cachedHeightField;
    const { minX, minY } = this.cachedBounds;
    const cellSize = this.cachedCellSize;

    // Convert world coordinates to grid coordinates
    const centerCol = (worldX - minX) / cellSize;
    const centerRow = (worldY - minY) / cellSize;

    // Calculate grid radius
    const gridRadius = radius / cellSize;
    const radiusSq = gridRadius * gridRadius;

    // Apply flattening
    const minRow = Math.max(0, Math.floor(centerRow - gridRadius));
    const maxRow = Math.min(rows - 1, Math.ceil(centerRow + gridRadius));
    const minCol = Math.max(0, Math.floor(centerCol - gridRadius));
    const maxCol = Math.min(cols - 1, Math.ceil(centerCol + gridRadius));

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const dx = col - centerCol;
        const dy = row - centerRow;
        const distSq = dx * dx + dy * dy;

        if (distSq <= radiusSq) {
          // Calculate falloff
          const falloff = 1 - Math.sqrt(distSq / radiusSq);
          const effectiveStrength = falloff * strength;

          const idx = row * cols + col;
          const currentHeight = values[idx];

          // Blend towards target height
          values[idx] = currentHeight + (targetHeight - currentHeight) * effectiveStrength;
        }
      }
    }

    return true;
  }

  _drawContourLines(heightField, bounds, cellSize, contourLevels) {
    const { values, rows, cols } = heightField;
    
    // Get filtering settings
    const filtering = HEIGHTMAP_SETTINGS.filtering || { enabled: true, minElevationSize: 9, minDepressionSize: 9 };
    
    // Draw contours for each level
    for (const levelInfo of contourLevels) {
      const graphics = new PIXI.Graphics();
      graphics.lineStyle(HEIGHTMAP_SETTINGS.lineWidth, levelInfo.color, HEIGHTMAP_SETTINGS.lineAlpha);
      
      // Use marching squares to find contour lines at this height threshold
      const threshold = levelInfo.minHeight + (levelInfo.maxHeight - levelInfo.minHeight) / 2;
      
      // Create binary mask for this threshold
      const mask = new Uint8Array(rows * cols);
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          mask[row * cols + col] = values[row * cols + col] >= threshold ? 1 : 0;
        }
      }
      
      // Filter out small regions if enabled
      const filteredMask = filtering.enabled 
        ? this._filterSmallRegions(mask, rows, cols, filtering.minElevationSize, filtering.minDepressionSize)
        : mask;
      
      // Collect all contour segments first
      const allSegments = [];
      
      for (let row = 0; row < rows - 1; row++) {
        for (let col = 0; col < cols - 1; col++) {
          const x = bounds.minX + col * cellSize;
          const y = bounds.minY + row * cellSize;
          
          // Use filtered mask values
          const v00 = filteredMask[row * cols + col];
          const v10 = filteredMask[row * cols + (col + 1)];
          const v01 = filteredMask[(row + 1) * cols + col];
          const v11 = filteredMask[(row + 1) * cols + (col + 1)];
          
          // Calculate marching squares case
          let caseValue = 0;
          if (v00) caseValue |= 1;
          if (v10) caseValue |= 2;
          if (v11) caseValue |= 4;
          if (v01) caseValue |= 8;
          
          // Skip fully inside or outside
          if (caseValue === 0 || caseValue === 15) continue;
          
          // Get actual height values for interpolation
          const h00 = values[row * cols + col];
          const h10 = values[row * cols + (col + 1)];
          const h01 = values[(row + 1) * cols + col];
          const h11 = values[(row + 1) * cols + (col + 1)];
          
          // Get line segments
          const segments = this._getContourSegments(caseValue, x, y, cellSize, h00, h10, h01, h11, threshold);
          allSegments.push(...segments);
        }
      }
      
      // Draw contour lines
      for (const segment of allSegments) {
        graphics.moveTo(segment[0].x, segment[0].y);
        graphics.lineTo(segment[1].x, segment[1].y);
      }
      
      // Add slope hachures if enabled
      if (HEIGHTMAP_SETTINGS.slopeHachures) {
        graphics.lineStyle(HEIGHTMAP_SETTINGS.hachureWidth || 1, levelInfo.color, HEIGHTMAP_SETTINGS.lineAlpha);
        this._drawSlopeHachures(graphics, allSegments, values, rows, cols, bounds, cellSize, threshold);
      }
      
      graphics.name = `heightmap_contour_${levelInfo.level}`;
      graphics.interactive = false;
      this.contourContainer.addChild(graphics);
    }
  }

  /**
   * Draw slope hachures (short perpendicular lines indicating downslope direction)
   */
  _drawSlopeHachures(graphics, segments, heightValues, rows, cols, bounds, cellSize, threshold) {
    const hachureLength = HEIGHTMAP_SETTINGS.hachureLength || 10;
    const hachureSpacing = HEIGHTMAP_SETTINGS.hachureSpacing || 20;
    
    for (const segment of segments) {
      // Calculate segment length and direction
      const dx = segment[1].x - segment[0].x;
      const dy = segment[1].y - segment[0].y;
      const length = Math.sqrt(dx * dx + dy * dy);
      
      if (length < 1) continue;
      
      // Number of hachures along this segment
      const numHachures = Math.floor(length / hachureSpacing);
      if (numHachures === 0) continue;
      
      // Unit tangent vector (along the contour line)
      const tx = dx / length;
      const ty = dy / length;
      
      // Perpendicular vector (potential downslope directions)
      const nx1 = -ty;
      const ny1 = tx;
      const nx2 = ty;
      const ny2 = -tx;
      
      // Sample points along the segment to determine downslope direction
      for (let i = 1; i <= numHachures; i++) {
        const t = i / (numHachures + 1);
        const px = segment[0].x + dx * t;
        const py = segment[0].y + dy * t;
        
        // Sample height field at two perpendicular directions
        const sampleDist = cellSize * 2;
        const h1 = this._sampleHeightField(px + nx1 * sampleDist, py + ny1 * sampleDist, heightValues, rows, cols, bounds, cellSize);
        const h2 = this._sampleHeightField(px + nx2 * sampleDist, py + ny2 * sampleDist, heightValues, rows, cols, bounds, cellSize);
        
        // Determine which direction goes downhill
        let hachureNx, hachureNy;
        if (h1 < threshold && h2 >= threshold) {
          // Direction 1 is downhill
          hachureNx = nx1;
          hachureNy = ny1;
        } else if (h2 < threshold && h1 >= threshold) {
          // Direction 2 is downhill
          hachureNx = nx2;
          hachureNy = ny2;
        } else {
          // Ambiguous or both same - use the lower one
          if (h1 < h2) {
            hachureNx = nx1;
            hachureNy = ny1;
          } else {
            hachureNx = nx2;
            hachureNy = ny2;
          }
        }
        
        // Draw hachure pointing downhill
        const hx = px + hachureNx * hachureLength;
        const hy = py + hachureNy * hachureLength;
        
        graphics.moveTo(px, py);
        graphics.lineTo(hx, hy);
      }
    }
  }
  
  /**
   * Sample height from interpolated field
   */
  _sampleHeightField(x, y, values, rows, cols, bounds, cellSize) {
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
    
    const v00 = values[row0 * cols + col0];
    const v10 = values[row0 * cols + col1];
    const v01 = values[row1 * cols + col0];
    const v11 = values[row1 * cols + col1];
    
    return (1 - fx) * (1 - fy) * v00 +
           fx * (1 - fy) * v10 +
           (1 - fx) * fy * v01 +
           fx * fy * v11;
  }

  /**
   * Filter out small isolated regions using flood fill
   * Filters both elevations (1s) and depressions/holes (0s)
   * @param {Uint8Array} mask - Binary mask to filter
   * @param {number} rows - Number of rows
   * @param {number} cols - Number of columns
   * @param {number} minElevationSize - Minimum size for elevation regions (value=1)
   * @param {number} minDepressionSize - Minimum size for depression regions (value=0)
   */
  _filterSmallRegions(mask, rows, cols, minElevationSize, minDepressionSize) {
    const result = new Uint8Array(rows * cols);
    const visited = new Uint8Array(rows * cols);
    
    // Process both types of regions: elevations (value=1) and holes (value=0)
    for (let value = 0; value <= 1; value++) {
      visited.fill(0); // Reset visited for each pass
      const minSize = value === 1 ? minElevationSize : minDepressionSize;
      
      for (let startRow = 0; startRow < rows; startRow++) {
        for (let startCol = 0; startCol < cols; startCol++) {
          const startIdx = startRow * cols + startCol;
          
          if (mask[startIdx] !== value || visited[startIdx]) continue;
          
          // Flood fill to find connected region with this value
          const region = [];
          const queue = [{row: startRow, col: startCol}];
          visited[startIdx] = 1;
          
          while (queue.length > 0) {
            const {row, col} = queue.shift();
            const idx = row * cols + col;
            region.push(idx);
            
            // Check 4-connected neighbors
            const neighbors = [
              {row: row - 1, col: col},
              {row: row + 1, col: col},
              {row: row, col: col - 1},
              {row: row, col: col + 1}
            ];
            
            for (const n of neighbors) {
              if (n.row < 0 || n.row >= rows || n.col < 0 || n.col >= cols) continue;
              
              const nIdx = n.row * cols + n.col;
              if (mask[nIdx] === value && !visited[nIdx]) {
                visited[nIdx] = 1;
                queue.push(n);
              }
            }
          }
          
          // Keep region if it's large enough
          if (region.length >= minSize) {
            for (const idx of region) {
              result[idx] = value;
            }
          } else {
            // Small region - invert it (fill holes, remove small peaks)
            for (const idx of region) {
              result[idx] = 1 - value;
            }
          }
        }
      }
    }
    
    return result;
  }

  /**
   * Get contour segments for marching squares case
   */
  _getContourSegments(caseValue, x, y, size, v00, v10, v01, v11, threshold) {
    const segments = [];
    
    // Helper to interpolate edge crossing
    const lerp = (v1, v2) => {
      if (Math.abs(v2 - v1) < 0.0001) return 0.5;
      return (threshold - v1) / (v2 - v1);
    };
    
    // Edge midpoints (with interpolation)
    const edges = {
      top: { x: x + size * lerp(v00, v10), y: y },
      right: { x: x + size, y: y + size * lerp(v10, v11) },
      bottom: { x: x + size * lerp(v01, v11), y: y + size },
      left: { x: x, y: y + size * lerp(v00, v01) }
    };
    
    // Marching squares lookup table
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
}

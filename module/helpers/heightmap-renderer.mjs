/**
 * Height Map Renderer using Metaballs
 * Renders smooth height map visualization using metaball technique
 */
export class HeightMapRenderer {
  constructor(heightMapManager) {
    this.heightMapManager = heightMapManager;
    this.contourContainer = null;
    this.isVisible = false;
    this.renderMode = 'contours'; // 'filled' or 'contours'
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
   * Render the height map using filled regions instead of contour lines
   */
  async render() {
    if (!this.heightMapManager.isLoaded()) {
      console.warn('HeightMapRenderer | No height map data available');
      ui.notifications.warn('No height map loaded for this scene');
      return;
    }

    console.log('HeightMapRenderer | Rendering height map with filled regions...');

    // Make sure container is set up
    if (!this.contourContainer) {
      this.setupContainerLayer();
    }

    // Clear existing graphics
    this.clear();

    const processedData = this.heightMapManager.getProcessedData();
    
    // Calculate bounds
    const bounds = this._calculateBounds(processedData.heightPoints);
    if (!bounds) {
      console.warn('HeightMapRenderer | Could not calculate bounds');
      return;
    }
    
    // Cell size for grid (smaller = more detail, slower performance)
    const cellSize = canvas.grid.size / 4;
    
    // Create a single height field from all points
    const heightField = this._createHeightField(processedData.heightPoints, bounds, cellSize);
    
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
    const field = { values: new Array(rows * cols), rows, cols };
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
      graphics.beginFill(levelInfo.color, 0.3);
      
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
   * Calculate bounds for all height points
   */
  _calculateBounds(points) {
    if (points.length === 0) return null;
    
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    
    // Add padding
    const padding = canvas.grid.size;
    return {
      minX: minX - padding,
      minY: minY - padding,
      maxX: maxX + padding,
      maxY: maxY + padding
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

    if (!this.isVisible) {
      await this.render();
    } else if (this.contourContainer) {
      this.contourContainer.visible = true;
    }
    
    this.isVisible = true;
    console.log('HeightMapRenderer | Height map shown');
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
   * Draw contour lines from height field
   */
  _drawContourLines(heightField, bounds, cellSize, contourLevels) {
    const { values, rows, cols } = heightField;
    
    // Draw contours for each level
    for (const levelInfo of contourLevels) {
      const graphics = new PIXI.Graphics();
      graphics.lineStyle(2, levelInfo.color, 0.8);
      
      // Use marching squares to find contour lines at this height threshold
      const threshold = levelInfo.minHeight + (levelInfo.maxHeight - levelInfo.minHeight) / 2;
      
      for (let row = 0; row < rows - 1; row++) {
        for (let col = 0; col < cols - 1; col++) {
          const x = bounds.minX + col * cellSize;
          const y = bounds.minY + row * cellSize;
          
          // Get corner heights
          const v00 = values[row * cols + col];
          const v10 = values[row * cols + (col + 1)];
          const v01 = values[(row + 1) * cols + col];
          const v11 = values[(row + 1) * cols + (col + 1)];
          
          // Calculate marching squares case
          let caseValue = 0;
          if (v00 >= threshold) caseValue |= 1;
          if (v10 >= threshold) caseValue |= 2;
          if (v11 >= threshold) caseValue |= 4;
          if (v01 >= threshold) caseValue |= 8;
          
          // Skip fully inside or outside
          if (caseValue === 0 || caseValue === 15) continue;
          
          // Draw line segments
          const segments = this._getContourSegments(caseValue, x, y, cellSize, v00, v10, v01, v11, threshold);
          
          for (const segment of segments) {
            graphics.moveTo(segment[0].x, segment[0].y);
            graphics.lineTo(segment[1].x, segment[1].y);
          }
        }
      }
      
      graphics.name = `heightmap_contour_${levelInfo.level}`;
      graphics.interactive = false;
      this.contourContainer.addChild(graphics);
    }
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

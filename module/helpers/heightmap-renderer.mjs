/**
 * Height Map Renderer
 * Renders height map contour lines on the effects layer
 */
export class HeightMapRenderer {
  constructor(heightMapManager) {
    this.heightMapManager = heightMapManager;
    this.contourContainer = null;
    this.isVisible = false;
    this.contourLevels = [20, 40, 60, 80, 100]; // Default contour levels
    this.contourColors = {
      20: 0x8B4513,  // Brown - low elevations
      40: 0xA0522D,  // Sienna
      60: 0xCD853F,  // Peru
      80: 0xD2691E,  // Chocolate
      100: 0x696969  // Dim gray - high elevations
    };
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

    // Create new container for contour lines
    this.contourContainer = new PIXI.Container();
    this.contourContainer.name = 'heightMapContours';
    
    // Add to effects layer
    effectsLayer.addChild(this.contourContainer);
    
    console.log('HeightMapRenderer | Container layer set up');
  }

  /**
   * Render the height map contours
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

    // Draw contour lines for each level
    for (const level of processedData.contourLevels) {
      await this.drawContourLevel(level, processedData);
    }

    this.isVisible = true;
    console.log('HeightMapRenderer | Height map rendered successfully');
  }

  /**
   * Draw contour lines for a specific height level
   * @param {number} level - Height level
   * @param {Object} data - Processed height map data
   */
  async drawContourLevel(level, data) {
    const graphics = new PIXI.Graphics();
    const color = this.contourColors[level] || 0x888888;
    
    graphics.lineStyle(2, color, 0.7);

    // Get pre-generated contours from processed data
    const contours = data.contours[level];
    
    if (!contours || contours.length === 0) {
      console.warn(`HeightMapRenderer | No contours found for level ${level}`);
      return;
    }
    
    // Draw each contour segment
    for (const segment of contours) {
      if (segment.length < 2) continue;
      
      graphics.moveTo(segment[0].x, segment[0].y);
      for (let i = 1; i < segment.length; i++) {
        graphics.lineTo(segment[i].x, segment[i].y);
      }
    }

    graphics.name = `contour-${level}`;
    this.contourContainer.addChild(graphics);
  }

  /**
   * Create interpolated height grid
   */
  createInterpolatedGrid(data, width, height, scaleX, scaleY, gridResolution) {
    const grid = new Array(width * height);
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const mapX = (x * gridResolution) / scaleX;
        const mapY = (y * gridResolution) / scaleY;
        
        // Find nearest cells and interpolate using inverse distance weighting
        let totalWeight = 0;
        let weightedHeight = 0;
        const maxDistance = 100; // Maximum distance to consider
        
        for (const cell of data.cells) {
          const dx = cell.position.x - mapX;
          const dy = cell.position.y - mapY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          
          if (distance < maxDistance) {
            const weight = 1 / (distance + 1); // +1 to avoid division by zero
            weightedHeight += cell.height * weight;
            totalWeight += weight;
          }
        }
        
        grid[y * width + x] = totalWeight > 0 ? weightedHeight / totalWeight : 0;
      }
    }
    
    return grid;
  }

  /**
   * Marching squares algorithm to find contour lines
   */
  marchingSquares(grid, width, height, threshold, maxHeight) {
    const contours = [];
    const visited = new Set();
    
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        const key = `${x},${y}`;
        if (visited.has(key)) continue;
        
        const contour = this.traceContour(grid, width, height, x, y, threshold, visited);
        if (contour.length > 0) {
          contours.push(contour);
        }
      }
    }
    
    return contours;
  }

  /**
   * Trace a single contour starting from given cell
   */
  traceContour(grid, width, height, startX, startY, threshold, visited) {
    const contour = [];
    let x = startX;
    let y = startY;
    
    // Simple contour tracing - check if any edge crosses threshold
    const v1 = grid[y * width + x];
    const v2 = grid[y * width + (x + 1)];
    const v3 = grid[(y + 1) * width + (x + 1)];
    const v4 = grid[(y + 1) * width + x];
    
    const edges = [];
    
    // Top edge
    if ((v1 < threshold && v2 >= threshold) || (v1 >= threshold && v2 < threshold)) {
      const t = (threshold - v1) / (v2 - v1);
      edges.push({x: x + t, y: y});
    }
    // Right edge
    if ((v2 < threshold && v3 >= threshold) || (v2 >= threshold && v3 < threshold)) {
      const t = (threshold - v2) / (v3 - v2);
      edges.push({x: x + 1, y: y + t});
    }
    // Bottom edge
    if ((v3 < threshold && v4 >= threshold) || (v3 >= threshold && v4 < threshold)) {
      const t = (threshold - v4) / (v3 - v4);
      edges.push({x: x + 1 - t, y: y + 1});
    }
    // Left edge
    if ((v4 < threshold && v1 >= threshold) || (v4 >= threshold && v1 < threshold)) {
      const t = (threshold - v4) / (v1 - v4);
      edges.push({x: x, y: y + 1 - t});
    }
    
    return edges;
  }

  /**
   * Smooth contour using simple averaging
   */
  smoothContour(contour, factor) {
    if (contour.length < 3) return contour;
    
    const smoothed = [];
    for (let i = 0; i < contour.length; i++) {
      const prev = contour[i > 0 ? i - 1 : contour.length - 1];
      const curr = contour[i];
      const next = contour[i < contour.length - 1 ? i + 1 : 0];
      
      smoothed.push({
        x: curr.x * (1 - factor) + (prev.x + next.x) * 0.5 * factor,
        y: curr.y * (1 - factor) + (prev.y + next.y) * 0.5 * factor
      });
    }
    
    return smoothed;
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
   * Set contour levels
   * @param {number[]} levels - Array of height levels
   */
  setContourLevels(levels) {
    this.contourLevels = levels;
    console.log(`HeightMapRenderer | Contour levels set to: ${levels.join(', ')}`);
    
    // Re-render if currently visible
    if (this.isVisible && this.heightMapManager.isLoaded()) {
      this.render();
    }
  }

  /**
   * Set contour colors
   * @param {Object} colors - Object mapping levels to colors
   */
  setContourColors(colors) {
    this.contourColors = {...this.contourColors, ...colors};
    console.log('HeightMapRenderer | Contour colors updated');
    
    // Re-render if currently visible
    if (this.isVisible && this.heightMapManager.isLoaded()) {
      this.render();
    }
  }

  /**
   * Check if height map is currently visible
   * @returns {boolean} Visibility status
   */
  isHeightMapVisible() {
    return this.isVisible;
  }

  /**
   * Destroy the renderer and clean up resources
   */
  destroy() {
    this.clear();
    if (this.contourContainer) {
      this.contourContainer.destroy({children: true});
      this.contourContainer = null;
    }
    this.isVisible = false;
    console.log('HeightMapRenderer | Destroyed');
  }
}

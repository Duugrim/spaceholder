import { BiomeResolver } from './global-map-biome-resolver.mjs';

/**
 * Global Map Renderer
 * Pure visualization layer - renders unified grid to canvas
 * Does NOT process or modify data, only displays it
 */
export class GlobalMapRenderer {
  constructor() {
    this.container = null; // PIXI.Container for rendering
    this.isVisible = false;
    this.currentGrid = null; // Reference to current grid being rendered
    this.currentMetadata = null;
    this.renderMode = 'contours'; // 'contours' (default) or 'cells'
    this.biomeResolver = new BiomeResolver(); // For dynamic biome determination
    this.showBiomes = true; // Whether to render biomes under heights
  }

  /**
   * Initialize renderer and set up canvas hooks
   */
  async initialize() {
    console.log('GlobalMapRenderer | Initializing...');

    // Load biome resolver config
    await this.biomeResolver.loadConfig();

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
    this.setupContainer();
  }

  /**
   * Set up PIXI container on interface layer
   */
  setupContainer() {
    const interfaceLayer = canvas.interface;

    if (!interfaceLayer) {
      console.warn('GlobalMapRenderer | Interface layer not available');
      return;
    }

    // Clear existing container
    if (this.container) {
      this.container.destroy({ children: true });
    }

    this.container = new PIXI.Container();
    this.container.name = 'globalMapContainer';
    interfaceLayer.addChild(this.container);

    console.log('GlobalMapRenderer | Container set up');
  }

  /**
   * Set render mode
   * @param {string} mode - 'contours' (default) or 'cells'
   */
  setRenderMode(mode) {
    if (mode !== 'contours' && mode !== 'cells') {
      console.warn(`GlobalMapRenderer | Invalid render mode: ${mode}`);
      return;
    }
    this.renderMode = mode;
    console.log(`GlobalMapRenderer | Render mode set to: ${mode}`);
    // Re-render if data available
    if (this.currentGrid && this.currentMetadata) {
      this.render(this.currentGrid, this.currentMetadata, { mode: 'heights' });
    }
  }

  /**
   * Render unified grid to canvas
   * @param {Object} gridData - Unified grid {heights, biomes, rows, cols}
   * @param {Object} metadata - Grid metadata
   * @param {Object} renderOptions - Render options {mode: 'heights'|'biomes'|'both', colorFunc, etc}
   */
  async render(gridData, metadata, renderOptions = {}) {
    if (!gridData || !gridData.heights) {
      console.warn('GlobalMapRenderer | No grid data to render');
      return;
    }

    console.log(`GlobalMapRenderer | Rendering grid (mode: ${this.renderMode})...`);

    // Store reference to current grid
    this.currentGrid = gridData;
    this.currentMetadata = metadata;

    // Make sure container exists
    if (!this.container) {
      this.setupContainer();
    }

    // Clear previous rendering
    this.container.removeChildren();

    // Choose rendering method
    if (this.renderMode === 'contours') {
      this._renderContours(gridData, metadata);
    } else {
      this._renderCells(gridData, metadata, renderOptions);
    }

    this.isVisible = true;
    console.log(`GlobalMapRenderer | ✓ Rendered ${gridData.rows}x${gridData.cols} grid`);
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

        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + row * cellSize;

        // Get biome color
        const color = this.biomeResolver.getBiomeColor(biomeId);
        const alpha = 1.0; // Fully opaque

        graphics.beginFill(color, alpha);
        graphics.drawRect(x, y, cellSize, cellSize);
        graphics.endFill();
      }
    }

    this.container.addChild(graphics);
    console.log('GlobalMapRenderer | ✓ Biome base layer rendered');
  }

  /**
   * Render as contour lines using marching squares
   * @private
   */
  _renderContours(gridData, metadata) {
    const { heights, rows, cols } = gridData;
    const { cellSize, bounds, heightStats } = metadata;

    // First, render biomes as base layer
    this._renderBiomesBase(gridData, metadata);

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
   * Draw contour line segments with outline and slope direction marks
   * @private
   */
  _drawContourSegments(segments, color, heights, rows, cols, bounds, cellSize) {
    if (segments.length === 0) return;

    const graphics = new PIXI.Graphics();

    // Draw black outline first (for better visibility)
    graphics.lineStyle(2, 0x000000, 0.6);
    for (const segment of segments) {
      graphics.moveTo(segment[0].x, segment[0].y);
      graphics.lineTo(segment[1].x, segment[1].y);
    }

    // Draw colored contour lines
    graphics.lineStyle(1, color, 0.8);
    for (const segment of segments) {
      graphics.moveTo(segment[0].x, segment[0].y);
      graphics.lineTo(segment[1].x, segment[1].y);
    }

    // Draw slope direction marks (hachures)
    this._drawSlopeMarks(graphics, segments, heights, rows, cols, bounds, cellSize, color);

    this.container.addChild(graphics);
  }

  /**
   * Draw short lines indicating downslope direction
   * @private
   */
  _drawSlopeMarks(graphics, segments, heightValues, rows, cols, bounds, cellSize, color) {
    const hachureLength = 4;
    const hachureSpacing = 25;

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

        graphics.lineStyle(1, 0x000000, 0.7);
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

        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + row * cellSize;

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

    this.container.addChild(graphics);
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
    if (this.container) {
      this.container.removeChildren();
      this.isVisible = false;
      console.log('GlobalMapRenderer | Cleared');
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

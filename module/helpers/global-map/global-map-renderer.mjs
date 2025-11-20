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
  }

  /**
   * Initialize renderer and set up canvas hooks
   */
  initialize() {
    console.log('GlobalMapRenderer | Initializing...');

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

    console.log('GlobalMapRenderer | Rendering grid...');

    // Store reference to current grid
    this.currentGrid = gridData;
    this.currentMetadata = metadata;

    // Make sure container exists
    if (!this.container) {
      this.setupContainer();
    }

    // Clear previous rendering
    this.container.removeChildren();

    const {
      mode = 'heights', // 'heights', 'biomes', or 'both'
      heightColorFunc = null, // Custom color function for heights
      biomeColorFunc = null, // Custom color function for biomes
      opacity = 0.7,
      cellBorder = false,
    } = renderOptions;

    const { heights, biomes, rows, cols } = gridData;
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
            // Default: gradient from blue (low) to red (high)
            const normalized = this._normalizeValue(
              height,
              metadata.heightStats.min,
              metadata.heightStats.max
            );
            color = this._heightToColor(normalized);
          }

          alpha = opacity * 0.7; // Heights slightly transparent
        }

        if (mode === 'biomes' || mode === 'both') {
          const biome = biomes[idx];

          if (biome > 0) {
            if (biomeColorFunc) {
              const biomeColor = biomeColorFunc(biome);
              color = biomeColor;
              alpha = opacity; // Biomes more opaque
            } else {
              // Default: simple hue-based colors
              color = this._biomeToColor(biome);
              alpha = opacity;
            }
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
    this.isVisible = true;

    console.log(`GlobalMapRenderer | ✓ Rendered ${gridData.rows}x${gridData.cols} grid`);
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

  /**
   * Convert biome ID to RGB color
   * @private
   */
  _biomeToColor(biomeId) {
    // Simple hash-based color from biome ID
    const hue = (biomeId * 137.508) % 360; // Golden angle for good color distribution
    return this._hslToRgb(hue, 70, 50);
  }

  /**
   * Convert HSL to RGB
   * @private
   */
  _hslToRgb(h, s, l) {
    h = h / 360;
    s = s / 100;
    l = l / 100;

    let r, g, b;

    if (s === 0) {
      r = g = b = l; // achromatic
    } else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };

      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }

    const ri = Math.floor(Math.max(0, Math.min(255, r * 255)));
    const gi = Math.floor(Math.max(0, Math.min(255, g * 255)));
    const bi = Math.floor(Math.max(0, Math.min(255, b * 255)));

    // Apply 0xFFFFFF mask to ensure positive hex value
    return ((ri << 16) | (gi << 8) | bi) & 0xFFFFFF;
  }
}

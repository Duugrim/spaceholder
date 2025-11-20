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
    this.currentTool = 'inspect'; // 'inspect', 'raise', 'lower', 'smooth', 'flatten'
    this.brushRadius = 100;
    this.brushStrength = 0.5;
    this.targetHeight = 50;

    // Mouse state
    this.isMouseDown = false;
    this.lastPosition = null;
    this.tempOverlay = null; // Temporary delta layer for current stroke

    // UI elements
    this.brushCursor = null;
    this.brushPreview = null;
    this.inspectLabel = null;
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
    this.hideToolsUI();

    console.log('GlobalMapTools | ✓ Deactivated');
  }

  /**
   * Set current tool
   */
  setTool(tool) {
    if (['inspect', 'raise', 'lower', 'smooth', 'flatten'].includes(tool)) {
      this.currentTool = tool;
      this.updateBrushCursorGraphics();
      console.log(`GlobalMapTools | Tool changed to: ${tool}`);
    }
  }

  /**
   * Set brush parameters
   */
  setBrushParams(radius = null, strength = null, targetHeight = null) {
    if (radius !== null) this.brushRadius = radius;
    if (strength !== null) this.brushStrength = strength;
    if (targetHeight !== null) this.targetHeight = targetHeight;
    this.updateBrushCursorGraphics();
  }

  /**
   * Set up canvas event listeners
   */
  setupEventListeners() {
    if (!canvas.stage) return;

    // Mouse down
    canvas.stage.on('pointerdown', (event) => {
      if (!this.isActive) return;

      // Allow right-click panning
      if (event.data.button === 2) return;
      if (event.data.button !== 0) return;

      event.stopPropagation();

      this.isMouseDown = true;

      // Start temporary overlay for this stroke
      const gridSize = this.renderer.currentGrid.heights.length;
      this.tempOverlay = new Float32Array(gridSize);

      const pos = event.data.getLocalPosition(canvas.stage);
      this.applyBrushStroke(pos.x, pos.y);
      this.lastPosition = pos;
    });

    // Mouse move
    canvas.stage.on('pointermove', (event) => {
      if (!this.isActive) return;

      const pos = event.data.getLocalPosition(canvas.stage);

      // Update cursor
      this.updateBrushCursorPosition(pos.x, pos.y);

      if (!this.isMouseDown || this.currentTool === 'inspect') return;

      // Throttle to 10px
      if (this.lastPosition) {
        const dx = pos.x - this.lastPosition.x;
        const dy = pos.y - this.lastPosition.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 10) {
          this.applyBrushStroke(pos.x, pos.y);
          this.lastPosition = pos;
        }
      }
    });

    // Mouse up
    canvas.stage.on('pointerup', (event) => {
      if (!this.isActive || !this.isMouseDown) return;

      this.isMouseDown = false;
      this.lastPosition = null;

      // Commit overlay to grid
      if (this.tempOverlay) {
        this.commitOverlay();
        this.tempOverlay = null;
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
    const { heights, biomes, rows, cols } = grid;
    const { cellSize, bounds } = metadata;

    // Convert world coords to grid coords
    const gridCol = (worldX - bounds.minX) / cellSize;
    const gridRow = (worldY - bounds.minY) / cellSize;

    // Calculate affected cells
    const gridRadius = this.brushRadius / cellSize;
    const radiusSq = gridRadius * gridRadius;

    const minRow = Math.max(0, Math.floor(gridRow - gridRadius));
    const maxRow = Math.min(rows - 1, Math.ceil(gridRow + gridRadius));
    const minCol = Math.max(0, Math.floor(gridCol - gridRadius));
    const maxCol = Math.min(cols - 1, Math.ceil(gridCol + gridRadius));

    const delta = 5; // Base height change per stroke

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const dx = col - gridCol;
        const dy = row - gridRow;
        const distSq = dx * dx + dy * dy;

        if (distSq <= radiusSq) {
          const falloff = 1 - Math.sqrt(distSq / radiusSq);
          const effectiveStrength = falloff * this.brushStrength;
          const idx = row * cols + col;

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
              // Smooth is applied on commit
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

    const { heights } = this.renderer.currentGrid;

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

    console.log('GlobalMapTools | Changes applied');
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
        biomes: Array.from(this.renderer.currentGrid.biomes),
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
      case 'flatten':
        color = 0x00ffff; // Cyan
        break;
      case 'inspect':
        color = 0x0088ff; // Blue
        break;
    }

    // Draw filled circle
    this.brushCursor.beginFill(color, alpha * this.brushStrength);
    this.brushCursor.drawCircle(0, 0, this.brushRadius);
    this.brushCursor.endFill();

    // Draw outline
    this.brushCursor.lineStyle(2, color, 0.7);
    this.brushCursor.drawCircle(0, 0, this.brushRadius);
  }

  /**
   * Destroy brush cursor
   */
  destroyBrushCursor() {
    if (this.brushCursor) {
      this.brushCursor.destroy();
      this.brushCursor = null;
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
        min-width: 200px;
        z-index: 1000;
        font-family: 'Signika', sans-serif;
      ">
        <h3 style="margin-top: 0; margin-bottom: 10px;">Global Map Tools</h3>

        <div style="margin-bottom: 10px;">
          <label style="display: block; margin-bottom: 5px;">Tool:</label>
          <select id="global-map-tool" style="width: 100%; padding: 5px;">
            <option value="inspect" selected>Inspect</option>
            <option value="raise">Raise Terrain</option>
            <option value="lower">Lower Terrain</option>
            <option value="smooth">Smooth</option>
            <option value="flatten">Flatten</option>
          </select>
        </div>

        <div style="margin-bottom: 10px;">
          <label style="display: block; margin-bottom: 5px;">Radius: <span id="radius-value">${this.brushRadius}</span>px</label>
          <input type="range" id="global-map-radius" min="50" max="500" step="10" value="${this.brushRadius}" style="width: 100%;">
        </div>

        <div style="margin-bottom: 10px;">
          <label style="display: block; margin-bottom: 5px;">Strength: <span id="strength-value">${this.brushStrength.toFixed(1)}</span></label>
          <input type="range" id="global-map-strength" min="0.1" max="1.0" step="0.1" value="${this.brushStrength}" style="width: 100%;">
        </div>

        <button id="global-map-exit" style="width: 100%; padding: 8px; margin-top: 5px; background: #888; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
          Exit
        </button>
      </div>
    `;

    $('body').append(html);

    // Event listeners
    $('#global-map-tool').on('change', (e) => {
      this.setTool(e.target.value);
    });

    $('#global-map-radius').on('input', (e) => {
      this.brushRadius = parseInt(e.target.value);
      $('#radius-value').text(this.brushRadius);
      this.updateBrushCursorGraphics();
    });

    $('#global-map-strength').on('input', (e) => {
      this.brushStrength = parseFloat(e.target.value);
      $('#strength-value').text(this.brushStrength.toFixed(1));
      this.updateBrushCursorGraphics();
    });

    $('#global-map-exit').on('click', async () => {
      await this.deactivate();
    });
  }

  /**
   * Hide tools UI panel
   */
  hideToolsUI() {
    $('#global-map-tools-ui').remove();
  }
}

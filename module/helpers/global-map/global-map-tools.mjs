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
    this.currentTool = 'raise'; // 'raise', 'lower', 'smooth', 'flatten'
    this.brushRadius = 100;
    this.brushStrength = 0.5;
    this.targetHeight = 50;
    this.globalSmoothStrength = 1.0; // Strength for global smooth (0.1-1.0)

    // Mouse state
    this.isMouseDown = false;
    this.lastPosition = null;
    this.tempOverlay = null; // Temporary delta layer for current stroke
    this.affectedCells = null; // Track which cells were affected by current stroke

    // UI elements
    this.brushCursor = null;
    this.brushPreview = null;
    this.overlayPreview = null; // Overlay showing affected cells
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
   * Set current tool
   */
  setTool(tool) {
    if (['raise', 'lower', 'smooth', 'roughen', 'flatten'].includes(tool)) {
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

      // Update cursor
      this.updateBrushCursorPosition(pos.x, pos.y);

      if (!this.isMouseDown) return;

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
      if (!this.isActive || !this.isMouseDown) return;

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

          // Track affected cells for smooth/roughen tool
          if (this.currentTool === 'smooth' || this.currentTool === 'roughen') {
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
              // Mark for smoothing, processed in commit
              break;
            case 'roughen':
              // Mark for roughening, processed in commit
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

    const { heights, rows, cols } = this.renderer.currentGrid;

    // Apply smooth/roughen if needed
    if (this.currentTool === 'smooth' && this.affectedCells.size > 0) {
      this._applySmoothOverlay(heights, rows, cols);
    } else if (this.currentTool === 'roughen' && this.affectedCells.size > 0) {
      this._applyRoughenOverlay(heights, rows, cols);
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

    // Recreate overlay preview after render (it gets destroyed)
    this.createOverlayPreview();

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
    }

    // Draw affected cells
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        const delta = previewOverlay[idx];
        if (Math.abs(delta) > 0.05) {
          const x = bounds.minX + col * cellSize;
          const y = bounds.minY + row * cellSize;
          const color = delta > 0 ? positiveColor : negativeColor;
          // Smooth and Roughen get higher alpha for visibility
          let alpha;
          if (this.currentTool === 'smooth' || this.currentTool === 'roughen') {
            alpha = Math.min(0.55, Math.abs(delta) / 5); // Brighter for smooth/roughen
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
      case 'roughen':
        color = 0xff9900; // Orange
        break;
      case 'flatten':
        color = 0x00ffff; // Cyan
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
        min-width: 250px;
        z-index: 1000;
        font-family: 'Signika', sans-serif;
      ">
        <h3 style="margin-top: 0; margin-bottom: 10px;">Global Map Tools</h3>

        <div style="display: flex; gap: 5px; margin-bottom: 10px;">
          <button id="tab-brush" data-tab="brush" style="flex: 1; padding: 8px; background: #0066cc; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
            Brush
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
            <label style="display: block; margin-bottom: 5px;">Radius: <span id="radius-value">${this.brushRadius}</span>px</label>
            <input type="range" id="global-map-radius" min="50" max="500" step="10" value="${this.brushRadius}" style="width: 100%;">
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">Strength: <span id="strength-value">${this.brushStrength.toFixed(1)}</span></label>
            <input type="range" id="global-map-strength" min="0.1" max="1.0" step="0.1" value="${this.brushStrength}" style="width: 100%;">
          </div>
        </div>

        <div id="global-tab" style="display: none;">
          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">Smooth Strength: <span id="global-smooth-strength-value">${this.globalSmoothStrength.toFixed(1)}</span></label>
            <input type="range" id="global-smooth-strength" min="0.1" max="1.0" step="0.1" value="${this.globalSmoothStrength}" style="width: 100%; margin-bottom: 10px;">
          </div>
          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px;">Global Operations:</label>
            <button id="global-smooth-btn" style="width: 100%; padding: 8px; margin-bottom: 5px; background: #ffff00; color: black; border: none; border-radius: 3px; cursor: pointer; font-weight: bold;">
              Smooth (1 pass)
            </button>
            <button id="global-smooth-3-btn" style="width: 100%; padding: 8px; background: #ffdd00; color: black; border: none; border-radius: 3px; cursor: pointer; font-weight: bold;">
              Smooth (3 passes)
            </button>
          </div>
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

    // Tabs switching
    const activateTab = (tab) => {
      if (tab === 'brush') {
        $('#brush-tab').show();
        $('#global-tab').hide();
        $('#tab-brush').css('background', '#0066cc').css('font-weight', 'bold');
        $('#tab-global').css('background', '#333').css('font-weight', 'normal');
      } else {
        $('#brush-tab').hide();
        $('#global-tab').show();
        $('#tab-global').css('background', '#0066cc').css('font-weight', 'bold');
        $('#tab-brush').css('background', '#333').css('font-weight', 'normal');
      }
    };
    $('#tab-brush').on('click', () => activateTab('brush'));
    $('#tab-global').on('click', () => activateTab('global'));

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
}

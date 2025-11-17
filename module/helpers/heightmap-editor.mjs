/**
 * Height Map Editor UI
 * Provides interactive tools for editing height maps
 */

export class HeightMapEditor {
  constructor(heightMapRenderer) {
    this.renderer = heightMapRenderer;
    this.isActive = false;
    this.currentTool = 'raise'; // 'raise', 'lower', 'smooth', 'flatten'
    this.brushRadius = 100;
    this.brushStrength = 0.5;
    this.targetHeight = 50;
    
    // Mouse state
    this.isMouseDown = false;
    this.lastPosition = null;
    
    // Temporary overlay for stroke
    this.tempOverlay = null; // Temporary Float32Array with deltas
    this.strokeHistory = []; // For undo/redo
    
    // Brush cursor visualization
    this.brushCursor = null; // PIXI.Graphics for cursor
  }

  /**
   * Initialize the editor
   */
  initialize() {
    console.log('HeightMapEditor | Initializing...');
    
    // Hook into canvas ready
    Hooks.on('canvasReady', () => {
      this.setupEventListeners();
    });
    
    // Add control button
    Hooks.on('getSceneControlButtons', (controls) => {
      this.addControlButton(controls);
    });
    
    // Block canvas drag selection when editor is active
    Hooks.on('controlToken', (token, controlled) => {
      if (this.isActive) return false;
    });
  }

  /**
   * Add height map editor button to scene controls
   */
  addControlButton(controls) {
    console.log('HeightMapEditor | addControlButton called');
    
    // In Foundry v13+, controls is an object, not an array
    if (typeof controls !== 'object' || controls === null) {
      console.warn('HeightMapEditor | Controls is not an object');
      return;
    }
    
    // Create a new control group for height map editor
    controls.heightmap = {
      name: 'heightmap',
      title: 'Height Map Editor',
      icon: 'fa-solid fa-mountain',
      layer: 'heightmap',
      visible: true,
      order: 11, // After notes (order: 10)
      tools: {
        'load-heightmap': {
          name: 'load-heightmap',
          title: 'Load/Show Height Map',
          icon: 'fa-solid fa-map',
          onChange: async (isActive) => {
            // Load processed data if not loaded
            if (!this.renderer.heightMapManager.isLoaded()) {
              ui.notifications.info('Loading height map data...');
              await this.renderer.heightMapManager.processHeightMapFromSource();
            }
            // Show height map
            await this.renderer.show();
            ui.notifications.info('Height map ready for editing!');
          },
          button: true
        },
        'toggle-view': {
          name: 'toggle-view',
          title: 'Toggle Height Map Visibility',
          icon: 'fa-solid fa-eye',
          onChange: (isActive) => this.renderer.toggle(),
          button: true
        },
        'edit-mode': {
          name: 'edit-mode',
          title: 'Edit Terrain',
          icon: 'fa-solid fa-pencil',
          onChange: async (isActive) => {
            if (!this.checkHeightMapLoaded()) return;
            
            // Toggle edit mode
            if (this.isActive) {
              await this.deactivate();
            } else {
              this.activate();
            }
          },
          button: true
        }
      }
    };
    
    console.log('HeightMapEditor | Added height map control group');
  }

  /**
   * Check if height map is loaded and warn user if not
   */
  checkHeightMapLoaded() {
    if (!this.renderer.heightMapManager.isLoaded() || !this.renderer.cachedHeightField) {
      ui.notifications.warn('Please load the height map first using the map button.');
      return false;
    }
    return true;
  }

  /**
   * Toggle editor on/off
   */
  toggle() {
    this.isActive = !this.isActive;
    
    if (this.isActive) {
      this.activate();
    } else {
      this.deactivate();
    }
  }

  /**
   * Activate the editor
   */
  activate() {
    this.isActive = true;
    
    // Show height map if not visible
    if (!this.renderer.isVisible) {
      this.renderer.show();
    }
    
    // Disable canvas selection
    this._savedCanvasState = {
      controlsDrag: canvas.controls?.options?.drag,
      mouseEnabled: canvas.mouseInteractionManager?.options?.dragResistance
    };
    
    if (canvas.controls) {
      canvas.controls.options.drag = false;
      if (canvas.controls.interactionManager) {
        canvas.controls.interactionManager.drag = false;
      }
    }
    
    if (canvas.mouseInteractionManager) {
      canvas.mouseInteractionManager.options.dragResistance = 999999;
    }
    
    // Create brush cursor
    this.createBrushCursor();
    
    // Show UI
    this.showUI();
    
    ui.notifications.info('Height Map Editor activated. Click and drag to edit terrain.');
  }

  /**
   * Deactivate the editor and save changes
   */
  async deactivate() {
    console.log('HeightMapEditor | Deactivating...');
    this.isActive = false;
    
    // Destroy brush cursor
    this.destroyBrushCursor();
    
    // Restore canvas selection
    if (this._savedCanvasState) {
      if (canvas.controls) {
        canvas.controls.options.drag = this._savedCanvasState.controlsDrag;
        if (canvas.controls.interactionManager) {
          canvas.controls.interactionManager.drag = this._savedCanvasState.controlsDrag;
        }
      }
      if (canvas.mouseInteractionManager) {
        canvas.mouseInteractionManager.options.dragResistance = this._savedCanvasState.mouseEnabled;
      }
      this._savedCanvasState = null;
    }
    
    // Save changes to file
    if (this.renderer.cachedHeightField) {
      await this.renderer.updateHeightField(this.renderer.cachedHeightField, true);
      ui.notifications.info('Height map saved successfully.');
    }
    
    // Hide UI
    this.hideUI();
  }

  /**
   * Setup event listeners for canvas interaction
   */
  setupEventListeners() {
    if (!canvas.stage) return;
    
    // Mouse down - highest priority to prevent selection
    canvas.stage.on('pointerdown', (event) => {
      if (!this.isActive) return;
      
      // Only respond to left mouse button
      if (event.data.button !== 0) return;
      
      // Prevent default selection box and stop propagation
      event.stopPropagation();
      event.data.originalEvent.preventDefault();
      event.data.originalEvent.stopPropagation();
      
      this.isMouseDown = true;
      
      // Create temporary overlay for this stroke
      if (this.renderer.cachedHeightField) {
        const size = this.renderer.cachedHeightField.values.length;
        this.tempOverlay = new Float32Array(size);
      }
      
      const pos = event.data.getLocalPosition(canvas.stage);
      this.applyBrushToOverlay(pos.x, pos.y);
      this.lastPosition = pos;
      
      return false;
    }, true); // Use capture phase
    
    // Mouse move
    canvas.stage.on('pointermove', (event) => {
      if (!this.isActive) return;
      
      const pos = event.data.getLocalPosition(canvas.stage);
      
      // Update brush cursor position
      this.updateBrushCursor(pos.x, pos.y);
      
      if (!this.isMouseDown) return;
      
      // Throttle - only apply every 10 pixels
      if (this.lastPosition) {
        const dx = pos.x - this.lastPosition.x;
        const dy = pos.y - this.lastPosition.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        // Only apply if moved enough
        if (dist > 10) {
          this.applyBrushToOverlay(pos.x, pos.y);
          this.lastPosition = pos;
        }
      }
    });
    
    // Mouse up
    canvas.stage.on('pointerup', (event) => {
      if (!this.isActive || !this.isMouseDown) return;
      
      this.isMouseDown = false;
      this.lastPosition = null;
      
      // Apply overlay to heightField
      this.commitOverlay();
    });
  }

  /**
   * Apply brush to temporary overlay (no render)
   */
  applyBrushToOverlay(x, y) {
    if (!this.renderer.cachedHeightField || !this.tempOverlay) return;
    
    const { values, rows, cols } = this.renderer.cachedHeightField;
    const { minX, minY } = this.renderer.cachedBounds;
    const cellSize = this.renderer.cachedCellSize;
    
    // Convert world coordinates to grid coordinates
    const centerCol = (x - minX) / cellSize;
    const centerRow = (y - minY) / cellSize;
    
    // Calculate grid radius
    const gridRadius = this.brushRadius / cellSize;
    const radiusSq = gridRadius * gridRadius;
    
    // Apply brush to overlay
    const minRow = Math.max(0, Math.floor(centerRow - gridRadius));
    const maxRow = Math.min(rows - 1, Math.ceil(centerRow + gridRadius));
    const minCol = Math.max(0, Math.floor(centerCol - gridRadius));
    const maxCol = Math.min(cols - 1, Math.ceil(centerCol + gridRadius));
    
    const delta = 5; // Base height change
    
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const dx = col - centerCol;
        const dy = row - centerRow;
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
            case 'smooth':
              // Smooth will be calculated on commit
              break;
            case 'flatten':
              const currentHeight = values[idx] + this.tempOverlay[idx];
              this.tempOverlay[idx] += (this.targetHeight - currentHeight) * effectiveStrength;
              break;
          }
        }
      }
    }
  }
  
  /**
   * Commit overlay to heightField and render
   */
  commitOverlay() {
    if (!this.tempOverlay || !this.renderer.cachedHeightField) return;
    
    const { values, rows, cols } = this.renderer.cachedHeightField;
    
    // Apply smooth if needed
    if (this.currentTool === 'smooth') {
      // For smooth, recalculate from affected area
      this.applySmoothFromOverlay();
    }
    
    // Apply overlay to heightField
    for (let i = 0; i < values.length; i++) {
      if (this.tempOverlay[i] !== 0) {
        values[i] = Math.max(0, Math.min(100, values[i] + this.tempOverlay[i]));
      }
    }
    
    // Save to history for undo
    this.strokeHistory.push(new Float32Array(this.tempOverlay));
    
    // Clear overlay
    this.tempOverlay = null;
    
    // Render once
    this.renderer.render();
  }
  
  /**
   * Apply smooth tool from overlay
   */
  applySmoothFromOverlay() {
    // For smooth tool, we mark affected cells and average them
    // This is simplified - just apply smoothing to non-zero overlay cells
    const { values, rows, cols } = this.renderer.cachedHeightField;
    const smoothed = new Float32Array(values.length);
    smoothed.set(values);
    
    for (let row = 1; row < rows - 1; row++) {
      for (let col = 1; col < cols - 1; col++) {
        const idx = row * cols + col;
        
        // Only smooth where overlay was applied
        if (Math.abs(this.tempOverlay[idx]) > 0.001) {
          let sum = 0;
          let count = 0;
          
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const nIdx = (row + dr) * cols + (col + dc);
              sum += values[nIdx];
              count++;
            }
          }
          
          const average = sum / count;
          const strength = this.brushStrength;
          this.tempOverlay[idx] = (average - values[idx]) * strength;
        }
      }
    }
  }

  /**
   * Show editor UI
   */
  showUI() {
    // Remove existing UI if any
    this.hideUI();
    
    const html = `
      <div id="heightmap-editor-ui" style="
        position: fixed;
        top: 100px;
        right: 20px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 15px;
        border-radius: 5px;
        min-width: 200px;
        z-index: 1000;
        font-family: 'Signika', sans-serif;
      ">
        <h3 style="margin-top: 0; margin-bottom: 10px;">Height Map Editor</h3>
        
        <div style="margin-bottom: 10px;">
          <label style="display: block; margin-bottom: 5px;">Tool:</label>
          <select id="heightmap-tool" style="width: 100%; padding: 5px;">
            <option value="raise" selected>Raise Terrain</option>
            <option value="lower">Lower Terrain</option>
            <option value="smooth">Smooth Terrain</option>
            <option value="flatten">Flatten Terrain</option>
          </select>
        </div>
        
        <div style="margin-bottom: 10px;">
          <label style="display: block; margin-bottom: 5px;">Radius: <span id="radius-value">${this.brushRadius}</span>px</label>
          <input type="range" id="heightmap-radius" min="50" max="500" step="10" value="${this.brushRadius}" style="width: 100%;">
        </div>
        
        <div style="margin-bottom: 10px;">
          <label style="display: block; margin-bottom: 5px;">Strength: <span id="strength-value">${this.brushStrength}</span></label>
          <input type="range" id="heightmap-strength" min="0.1" max="1.0" step="0.1" value="${this.brushStrength}" style="width: 100%;">
        </div>
        
        <div id="flatten-height-container" style="margin-bottom: 10px; display: none;">
          <label style="display: block; margin-bottom: 5px;">Target Height: <span id="target-value">${this.targetHeight}</span></label>
          <input type="range" id="heightmap-target" min="0" max="100" step="5" value="${this.targetHeight}" style="width: 100%;">
        </div>
        
        <button id="heightmap-save" style="width: 100%; padding: 8px; margin-top: 5px; background: #4a4; border: none; color: white; border-radius: 3px; cursor: pointer; font-weight: bold;">
          Save & Exit
        </button>
        
        <div style="margin-top: 10px; padding: 10px; background: rgba(255,255,255,0.1); border-radius: 3px; font-size: 12px;">
          <strong>Tip:</strong> Click "Save & Exit" or the Edit Terrain button to finish editing.
        </div>
      </div>
    `;
    
    $('body').append(html);
    
    // Event listeners
    $('#heightmap-tool').on('change', (e) => {
      this.currentTool = e.target.value;
      $('#flatten-height-container').toggle(this.currentTool === 'flatten');
      this.updateBrushCursorGraphics();
    });
    
    $('#heightmap-radius').on('input', (e) => {
      this.brushRadius = parseInt(e.target.value);
      $('#radius-value').text(this.brushRadius);
      this.updateBrushCursorGraphics();
    });
    
    $('#heightmap-strength').on('input', (e) => {
      this.brushStrength = parseFloat(e.target.value);
      $('#strength-value').text(this.brushStrength.toFixed(1));
      this.updateBrushCursorGraphics();
    });
    
    $('#heightmap-target').on('input', (e) => {
      this.targetHeight = parseInt(e.target.value);
      $('#target-value').text(this.targetHeight);
    });
    
    $('#heightmap-save').on('click', async () => {
      await this.deactivate();
    });
  }

  /**
   * Hide editor UI
   */
  hideUI() {
    $('#heightmap-editor-ui').remove();
  }

  /**
   * Create brush cursor visualization
   */
  createBrushCursor() {
    if (this.brushCursor) {
      this.brushCursor.destroy();
    }
    
    this.brushCursor = new PIXI.Graphics();
    this.brushCursor.name = 'heightmap-brush-cursor';
    
    // Add to interface layer
    if (canvas.interface) {
      canvas.interface.addChild(this.brushCursor);
    }
    
    this.updateBrushCursorGraphics();
  }

  /**
   * Update brush cursor position
   */
  updateBrushCursor(x, y) {
    if (!this.brushCursor) return;
    
    this.brushCursor.position.set(x, y);
  }

  /**
   * Update brush cursor graphics (when tool/radius/strength changes)
   */
  updateBrushCursorGraphics() {
    if (!this.brushCursor) return;
    
    this.brushCursor.clear();
    
    // Determine color based on tool
    let color, alpha;
    switch (this.currentTool) {
      case 'raise':
        color = 0x00ff00; // Green
        alpha = 0.2;
        break;
      case 'lower':
        color = 0xff0000; // Red
        alpha = 0.2;
        break;
      case 'smooth':
        color = 0xffff00; // Yellow
        alpha = 0.15;
        break;
      case 'flatten':
        color = 0x00ffff; // Cyan
        alpha = 0.2;
        break;
      default:
        color = 0xffffff;
        alpha = 0.1;
    }
    
    // Draw filled circle
    this.brushCursor.beginFill(color, alpha * this.brushStrength);
    this.brushCursor.drawCircle(0, 0, this.brushRadius);
    this.brushCursor.endFill();
    
    // Draw outline
    this.brushCursor.lineStyle(2, color, 0.6);
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
}

/**
 * ⚠️ УСТАРЕВШИЙ КОД - НЕ ИСПОЛЬЗОВАТЬ ⚠️
 * 
 * Этот модуль является УСТАРЕВШИМ и больше НЕ используется в системе.
 * Код сохранён только для справки и примеров старой реализации.
 * 
 * ❌ НЕ дорабатывайте этот код
 * ❌ НЕ используйте его в новых функциях
 * ✅ Используйте только как справочный материал
 * 
 * @deprecated Используйте новые модули terrain вместо legacy heightmap
 * 
 * Height Map Editor UI
 * Provides interactive tools for editing height maps
 */

/**
 * Show dialog for creating height map overlay
 */
async function showCreateOverlayDialog(editor) {
  const content = `
    <form>
      <div class="form-group">
        <label>Файл карты высот (JSON)</label>
        <div class="form-fields" style="display: flex; gap: 5px;">
          <button type="button" class="file-picker" data-type="json" title="Выбрать файл" style="flex-shrink: 0;">
            <i class="fas fa-file-import fa-fw"></i>
          </button>
          <input class="height-map-path" type="text" name="filePath" placeholder="Путь к JSON файлу из Azgaar's FMG" value="" style="flex-grow: 1;">
        </div>
        <p class="notes" style="margin-top: 5px; font-size: 12px;">
          Выберите JSON файл из Azgaar's Fantasy Map Generator или оставьте пустым для создания ровной карты (высота = 20).
        </p>
      </div>
    </form>
  `;
  
  return new Promise((resolve) => {
    const dialog = new Dialog({
      title: 'Создать оверлей карты высот',
      content: content,
      buttons: {
        create: {
          icon: '<i class="fas fa-check"></i>',
          label: 'Создать',
          callback: async (html) => {
            // Get the file path from the input field
            const fileInput = html.find('input[name="filePath"]');
            const filePath = fileInput.val() ? fileInput.val().trim() : '';
            
            console.log('HeightMapEditor | Dialog callback - filePath:', filePath, 'empty?', !filePath);
            
            if (filePath && filePath.length > 0) {
              // Import from file
              console.log('HeightMapEditor | Creating overlay from file:', filePath);
              const success = await editor.renderer.heightMapManager.processFromFile(filePath);
              
              if (success) {
                // Clear old heightField file reference so it regenerates
                const scene = canvas.scene;
                if (scene) {
                  await scene.unsetFlag('spaceholder', 'heightFieldPath');
                }
                // Clear renderer cache and container to force regeneration
                editor.renderer.cachedHeightField = null;
                editor.renderer.cachedBounds = null;
                editor.renderer.cachedCellSize = null;
                editor.renderer.clear(); // Clear visual content
                // Show the height map (will render from scratch)
                await editor.renderer.show();
              }
            } else {
              // Create flat map
              console.log('HeightMapEditor | Creating flat overlay map');
              const success = await editor.renderer.heightMapManager.createFlatMap(20);
              
              if (success) {
                // Clear old heightField file reference so it regenerates
                const scene = canvas.scene;
                if (scene) {
                  await scene.unsetFlag('spaceholder', 'heightFieldPath');
                }
                // Clear renderer cache and container to force regeneration
                editor.renderer.cachedHeightField = null;
                editor.renderer.cachedBounds = null;
                editor.renderer.cachedCellSize = null;
                editor.renderer.clear(); // Clear visual content
                // Show the height map (will render from scratch)
                await editor.renderer.show();
              }
            }
            
            resolve(true);
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: 'Отмена',
          callback: () => resolve(false)
        }
      },
      default: 'create',
      render: (html) => {
        // Setup file picker
        const filePicker = html.find('button.file-picker');
        const inputField = html.find('input[name="filePath"]');
        
        filePicker.on('click', function(e) {
          e.preventDefault();
          const current = inputField.val();
          const fp = new FilePicker({
            type: 'json',
            current: current,
            callback: (path) => {
              inputField.val(path);
            }
          });
          fp.browse();
        });
      },
      close: () => resolve(false)
    }, {
      width: 500
    });
    
    dialog.render(true);
  });
}

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
    this.overlayPreview = null; // PIXI.Graphics for overlay preview
    
    // Inspect mode
    this.isInspectMode = false;
    this.inspectLabel = null; // PIXI.Text for height display
  }

  /**
   * Initialize the editor
   */
  initialize() {
    console.log('HeightMapEditor | Initializing...');
    
    // Hook into canvas ready
    Hooks.on('canvasReady', async () => {
      this.setupEventListeners();
      await this.autoLoadHeightMap();
    });
    
    // Add control button
    Hooks.on('getSceneControlButtons', (controls) => {
      this.addControlButton(controls);
    });
    
    // Block canvas drag selection when editor is active
    Hooks.on('controlToken', (token, controlled) => {
      if (this.isActive) return false;
    });
    
    // Block ping when editor is active
    Hooks.on('canvasPan', (canvas, position) => {
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
      activeTool: 'inspect-height', // Default active tool
      tools: {
        'inspect-height': {
          name: 'inspect-height',
          title: 'Просмотр высоты',
          icon: 'fa-solid fa-ruler',
          onChange: (isActive) => {
            if (isActive) {
              this.activateInspectMode();
            } else {
              this.deactivateInspectMode();
            }
          },
          button: false // This is the default tool, not a button
        },
        'create-overlay': {
          name: 'create-overlay',
          title: 'Создать оверлей карты',
          icon: 'fa-solid fa-map',
          onChange: async (isActive) => {
            await showCreateOverlayDialog(this);
          },
          button: true
        },
        'toggle-view': {
          name: 'toggle-view',
          title: 'Переключить видимость',
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
   * Auto-load height map if processed data exists for this scene
   * Note: The renderer now handles auto-loading automatically via its canvasReady hook
   */
  async autoLoadHeightMap() {
    // The renderer's onCanvasReady now handles auto-loading automatically
    // This method is kept for compatibility but does nothing
    // Height map will be shown if data exists in scene flags
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
   * Activate inspect mode
   */
  activateInspectMode() {
    this.isInspectMode = true;
    
    // Show height map if not visible
    if (!this.renderer.isVisible) {
      this.renderer.show();
    }
    
    // Create inspect label
    this.createInspectLabel();
    
    // Setup inspect event listener
    this.setupInspectListener();
  }
  
  /**
   * Deactivate inspect mode
   */
  deactivateInspectMode() {
    this.isInspectMode = false;
    this.destroyInspectLabel();
    this.removeInspectListener();
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
    
    // Note: We don't disable canvas controls, just prevent selection via our event handlers
    
    // Create brush cursor
    this.createBrushCursor();
    
    // Create overlay preview graphics
    this.createOverlayPreview();
    
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
    
    // Destroy brush cursor and preview
    this.destroyBrushCursor();
    this.destroyOverlayPreview();
    
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
    
    // Mouse down - prevent selection on LMB, allow pan on RMB
    canvas.stage.on('pointerdown', (event) => {
      if (!this.isActive) return;
      
      // Allow right mouse button for panning
      if (event.data.button === 2) return;
      
      // Only work with left mouse button
      if (event.data.button !== 0) return;
      
      // Stop event propagation to prevent selection box
      event.stopPropagation();
      
      this.isMouseDown = true;
      
      // Create temporary overlay for this stroke
      if (this.renderer.cachedHeightField) {
        const size = this.renderer.cachedHeightField.values.length;
        this.tempOverlay = new Float32Array(size);
        
        // Recreate overlay preview for this stroke
        this.createOverlayPreview();
      }
      
      const pos = event.data.getLocalPosition(canvas.stage);
      this.applyBrushToOverlay(pos.x, pos.y);
      this.lastPosition = pos;
    });
    
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
      
      // Clear preview
      this.clearOverlayPreview();
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
    
    // Update preview after applying brush
    this.updateOverlayPreview();
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

  /**
   * Create overlay preview graphics
   */
  createOverlayPreview() {
    if (this.overlayPreview) {
      this.overlayPreview.destroy();
    }
    
    this.overlayPreview = new PIXI.Graphics();
    this.overlayPreview.name = 'heightmap-overlay-preview';
    
    // Add to renderer's container (above height map, below cursor)
    if (this.renderer.contourContainer) {
      this.renderer.contourContainer.addChild(this.overlayPreview);
    }
  }

  /**
   * Update overlay preview visualization
   */
  updateOverlayPreview() {
    if (!this.overlayPreview || !this.tempOverlay || !this.renderer.cachedHeightField) return;
    
    this.overlayPreview.clear();
    
    const { rows, cols } = this.renderer.cachedHeightField;
    const { minX, minY } = this.renderer.cachedBounds;
    const cellSize = this.renderer.cachedCellSize;
    
    // Determine color based on tool
    let positiveColor, negativeColor;
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
      default:
        positiveColor = 0xffffff;
        negativeColor = 0xffffff;
    }
    
    // Draw affected cells with alpha based on delta
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        const delta = this.tempOverlay[idx];
        
        if (Math.abs(delta) > 0.1) {
          const x = minX + col * cellSize;
          const y = minY + row * cellSize;
          
          // Choose color based on direction
          const color = delta > 0 ? positiveColor : negativeColor;
          // Alpha based on magnitude (capped at 0.4)
          const alpha = Math.min(0.4, Math.abs(delta) / 10);
          
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
   * Create inspect label for displaying height
   */
  createInspectLabel() {
    // Safely destroy existing label
    if (this.inspectLabel) {
      try {
        this.inspectLabel.destroy();
      } catch (error) {
        console.warn('HeightMapEditor | Error destroying inspectLabel:', error);
      }
      this.inspectLabel = null;
    }
    
    // Create PIXI text with background
    const style = new PIXI.TextStyle({
      fontFamily: 'Signika',
      fontSize: 16,
      fill: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3,
      dropShadow: true,
      dropShadowColor: '#000000',
      dropShadowBlur: 4,
      dropShadowDistance: 2
    });
    
    this.inspectLabel = new PIXI.Text('Height: --', style);
    this.inspectLabel.name = 'heightmap-inspect-label';
    this.inspectLabel.visible = false;
    
    // Add to interface layer
    if (canvas.interface) {
      canvas.interface.addChild(this.inspectLabel);
    }
  }
  
  /**
   * Setup inspect event listener
   */
  setupInspectListener() {
    if (!canvas.stage) return;
    
    this.inspectMoveHandler = (event) => {
      if (!this.isInspectMode) return;
      
      const pos = event.data.getLocalPosition(canvas.stage);
      this.updateInspectLabel(pos.x, pos.y);
    };
    
    canvas.stage.on('pointermove', this.inspectMoveHandler);
  }
  
  /**
   * Remove inspect event listener
   */
  removeInspectListener() {
    if (canvas.stage && this.inspectMoveHandler) {
      canvas.stage.off('pointermove', this.inspectMoveHandler);
      this.inspectMoveHandler = null;
    }
  }
  
  /**
   * Update inspect label with height at position
   */
  updateInspectLabel(x, y) {
    if (!this.inspectLabel || !this.renderer.cachedHeightField) return;
    
    const { values, rows, cols } = this.renderer.cachedHeightField;
    const { minX, minY } = this.renderer.cachedBounds;
    const cellSize = this.renderer.cachedCellSize;
    
    // Convert world coordinates to grid coordinates
    const col = Math.floor((x - minX) / cellSize);
    const row = Math.floor((y - minY) / cellSize);
    
    // Check if position is within bounds
    if (row >= 0 && row < rows && col >= 0 && col < cols) {
      const idx = row * cols + col;
      const height = values[idx];
      
      // Update label text and position
      this.inspectLabel.text = `Height: ${height.toFixed(1)}`;
      this.inspectLabel.position.set(x + 20, y - 10); // Offset from cursor
      this.inspectLabel.visible = true;
    } else {
      this.inspectLabel.visible = false;
    }
  }
  
  /**
   * Destroy inspect label
   */
  destroyInspectLabel() {
    if (this.inspectLabel) {
      this.inspectLabel.destroy();
      this.inspectLabel = null;
    }
  }
}

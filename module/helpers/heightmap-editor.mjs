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
          title: 'Edit Terrain Mode',
          icon: 'fa-solid fa-pencil',
          onChange: async (isActive) => {
            if (isActive) {
              if (!this.checkHeightMapLoaded()) {
                // Deactivate tool if height map not loaded
                ui.controls.control.activeTool = null;
                return;
              }
              this.activate();
            } else {
              await this.deactivate();
            }
          },
          toggle: true
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
    
    // Show UI
    this.showUI();
    
    ui.notifications.info('Height Map Editor activated. Click and drag to edit terrain.');
  }

  /**
   * Deactivate the editor and save changes
   */
  async deactivate() {
    this.isActive = false;
    
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
      const pos = event.data.getLocalPosition(canvas.stage);
      this.applyBrush(pos.x, pos.y);
      this.lastPosition = pos;
      
      return false;
    }, true); // Use capture phase
    
    // Mouse move
    canvas.stage.on('pointermove', (event) => {
      if (!this.isActive || !this.isMouseDown) return;
      
      const pos = event.data.getLocalPosition(canvas.stage);
      
      // Throttle - only apply every 50ms
      if (this.lastPosition) {
        const dx = pos.x - this.lastPosition.x;
        const dy = pos.y - this.lastPosition.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        // Only apply if moved enough
        if (dist > 10) {
          this.applyBrush(pos.x, pos.y);
          this.lastPosition = pos;
        }
      }
    });
    
    // Mouse up
    canvas.stage.on('pointerup', (event) => {
      if (!this.isActive || !this.isMouseDown) return;
      
      this.isMouseDown = false;
      this.lastPosition = null;
      
      // Changes are kept in cache, will be saved on deactivate
    });
  }

  /**
   * Apply brush at position
   */
  applyBrush(x, y) {
    if (!this.renderer.cachedHeightField) return;
    
    const delta = 5; // Base height change per application
    
    switch (this.currentTool) {
      case 'raise':
        this.renderer.editHeight(x, y, this.brushRadius, delta * this.brushStrength, this.brushStrength);
        break;
        
      case 'lower':
        this.renderer.editHeight(x, y, this.brushRadius, -delta * this.brushStrength, this.brushStrength);
        break;
        
      case 'smooth':
        this.renderer.smoothHeight(x, y, this.brushRadius, this.brushStrength);
        break;
        
      case 'flatten':
        this.renderer.flattenHeight(x, y, this.brushRadius, this.targetHeight, this.brushStrength);
        break;
    }
    
    // Re-render
    this.renderer.render();
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
        
        <div style="margin-top: 10px; padding: 10px; background: rgba(255,255,255,0.1); border-radius: 3px; font-size: 12px;">
          <strong>Tip:</strong> Changes are saved automatically when you exit Edit Mode.
        </div>
      </div>
    `;
    
    $('body').append(html);
    
    // Event listeners
    $('#heightmap-tool').on('change', (e) => {
      this.currentTool = e.target.value;
      $('#flatten-height-container').toggle(this.currentTool === 'flatten');
    });
    
    $('#heightmap-radius').on('input', (e) => {
      this.brushRadius = parseInt(e.target.value);
      $('#radius-value').text(this.brushRadius);
    });
    
    $('#heightmap-strength').on('input', (e) => {
      this.brushStrength = parseFloat(e.target.value);
      $('#strength-value').text(this.brushStrength.toFixed(1));
    });
    
    $('#heightmap-target').on('input', (e) => {
      this.targetHeight = parseInt(e.target.value);
      $('#target-value').text(this.targetHeight);
    });
  }

  /**
   * Hide editor UI
   */
  hideUI() {
    $('#heightmap-editor-ui').remove();
  }
}

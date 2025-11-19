/**
 * Terrain Field Manager
 * Manages unified terrain grid with both heights and biomes
 * Replaces separate caching for heightField and biomeField
 */
export class TerrainFieldManager {
  constructor() {
    this.cachedTerrainField = null;
    this.cachedBounds = null;
    this.cachedCellSize = null;
  }

  /**
   * Generate terrainField file path for a scene
   * @param {Scene} scene - Target scene
   * @returns {string} File path
   */
  _getTerrainFieldPath(scene) {
    const sceneSlug = scene.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return `worlds/${game.world.id}/terrainfields/${sceneSlug}_${scene.id}.json`;
  }

  /**
   * Calculate simple hash of source file path for change detection
   * @param {string} sourcePath - Path to source file
   * @returns {string} Simple hash
   */
  _simpleHash(sourcePath) {
    let hash = 0;
    for (let i = 0; i < sourcePath.length; i++) {
      const char = sourcePath.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }

  /**
   * Save terrainField to file
   * @param {Object} terrainField - Terrain field data {heights, biomes, rows, cols}
   * @param {Object} bounds - Bounds {minX, minY, maxX, maxY}
   * @param {number} cellSize - Cell size
   * @param {Scene} scene - Target scene
   * @param {Object} metadata - Additional metadata {heightSource, biomeSource, edited}
   * @returns {Promise<boolean>} Success status
   */
  async saveTerrainFieldToFile(terrainField, bounds, cellSize, scene, metadata = {}) {
    try {
      if (!scene) {
        throw new Error('No scene provided');
      }

      const filePath = this._getTerrainFieldPath(scene);
      console.log(`TerrainFieldManager | Saving terrainField to: ${filePath}`);

      // Convert Float32Array (heights) to base64
      const heightBuffer = terrainField.heights.buffer;
      const heightBytes = new Uint8Array(heightBuffer);
      let heightBinary = '';
      for (let i = 0; i < heightBytes.length; i++) {
        heightBinary += String.fromCharCode(heightBytes[i]);
      }
      const heightBase64 = btoa(heightBinary);

      // Convert Uint8Array (biomes) to base64
      const biomeBytes = terrainField.biomes;
      let biomeBinary = '';
      for (let i = 0; i < biomeBytes.length; i++) {
        biomeBinary += String.fromCharCode(biomeBytes[i]);
      }
      const biomeBase64 = btoa(biomeBinary);

      const terrainFieldData = {
        version: 1,
        metadata: {
          heightSource: metadata.heightSource || null,
          biomeSource: metadata.biomeSource || null,
          heightSourceHash: metadata.heightSource ? this._simpleHash(metadata.heightSource) : null,
          biomeSourceHash: metadata.biomeSource ? this._simpleHash(metadata.biomeSource) : null,
          generatedAt: new Date().toISOString(),
          sceneId: scene.id,
          sceneName: scene.name,
          edited: metadata.edited || false
        },
        bounds: bounds,
        grid: {
          rows: terrainField.rows,
          cols: terrainField.cols,
          cellSize: cellSize
        },
        heights: {
          encoding: 'base64_float32',
          data: heightBase64
        },
        biomes: {
          encoding: 'base64_uint8',
          data: biomeBase64
        }
      };

      // Upload file to user data
      const blob = new Blob([JSON.stringify(terrainFieldData, null, 2)], { type: 'application/json' });
      const file = new File([blob], filePath.split('/').pop(), { type: 'application/json' });
      
      const directory = filePath.substring(0, filePath.lastIndexOf('/'));
      
      // Create directory if it doesn't exist
      try {
        await foundry.applications.apps.FilePicker.implementation.createDirectory('data', directory, {});
      } catch (err) {
        // Directory might already exist, ignore error
      }
      
      const response = await foundry.applications.apps.FilePicker.implementation.upload('data', directory, file, {});
      
      if (response) {
        console.log(`TerrainFieldManager | ✓ TerrainField saved successfully to ${response.path}`);
        // Save reference in scene flags
        await scene.setFlag('spaceholder', 'terrainFieldPath', response.path);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('TerrainFieldManager | Failed to save terrainField:', error);
      ui.notifications.error(`Ошибка сохранения terrain field: ${error.message}`);
      return false;
    }
  }

  /**
   * Load terrainField from file
   * @param {Scene} scene - Target scene
   * @returns {Promise<Object|null>} TerrainField data or null if not found
   */
  async loadTerrainFieldFromFile(scene) {
    try {
      if (!scene) {
        throw new Error('No scene available');
      }

      const terrainFieldPath = scene.getFlag('spaceholder', 'terrainFieldPath');
      
      if (!terrainFieldPath) {
        console.log('TerrainFieldManager | No terrainField file path in scene flags');
        return null;
      }

      console.log(`TerrainFieldManager | Loading terrainField from: ${terrainFieldPath}`);

      const response = await fetch(terrainFieldPath);
      if (!response.ok) {
        console.warn(`TerrainFieldManager | TerrainField file not found: ${terrainFieldPath}`);
        return null;
      }

      const terrainFieldData = await response.json();

      // Validate version
      if (terrainFieldData.version !== 1) {
        console.warn(`TerrainFieldManager | Unsupported terrainField version: ${terrainFieldData.version}`);
        return null;
      }

      // Decode base64 to Float32Array (heights)
      const heightBinary = atob(terrainFieldData.heights.data);
      const heightBytes = new Uint8Array(heightBinary.length);
      for (let i = 0; i < heightBinary.length; i++) {
        heightBytes[i] = heightBinary.charCodeAt(i);
      }
      const heights = new Float32Array(heightBytes.buffer);

      // Decode base64 to Uint8Array (biomes)
      const biomeBinary = atob(terrainFieldData.biomes.data);
      const biomes = new Uint8Array(biomeBinary.length);
      for (let i = 0; i < biomeBinary.length; i++) {
        biomes[i] = biomeBinary.charCodeAt(i);
      }

      const terrainField = {
        heights: heights,
        biomes: biomes,
        rows: terrainFieldData.grid.rows,
        cols: terrainFieldData.grid.cols
      };

      const result = {
        terrainField: terrainField,
        bounds: terrainFieldData.bounds,
        cellSize: terrainFieldData.grid.cellSize,
        metadata: terrainFieldData.metadata
      };

      console.log(`TerrainFieldManager | ✓ TerrainField loaded successfully (${terrainField.rows}x${terrainField.cols})`);
      
      // Cache it
      this.cachedTerrainField = terrainField;
      this.cachedBounds = terrainFieldData.bounds;
      this.cachedCellSize = terrainFieldData.grid.cellSize;
      
      return result;
    } catch (error) {
      console.error('TerrainFieldManager | Failed to load terrainField:', error);
      return null;
    }
  }

  /**
   * Get cached terrain field
   */
  getCachedTerrainField() {
    if (!this.cachedTerrainField) return null;
    
    return {
      terrainField: this.cachedTerrainField,
      bounds: this.cachedBounds,
      cellSize: this.cachedCellSize
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cachedTerrainField = null;
    this.cachedBounds = null;
    this.cachedCellSize = null;
  }

  /**
   * Update cached terrain field
   */
  updateCache(terrainField, bounds, cellSize) {
    this.cachedTerrainField = terrainField;
    this.cachedBounds = bounds;
    this.cachedCellSize = cellSize;
  }
}

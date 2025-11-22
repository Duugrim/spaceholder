/**
 * Global Map Biome Resolver
 * Determines biome ID based on moisture, temperature, and optionally height
 */
export class BiomeResolver {
  constructor() {
    this.biomeMatrix = null;
    this.biomeParameters = null;
    this.biomeColors = null;
    this.azgaarBiomeMappings = null;
  }

  /**
   * Load biome configuration from file
   * @returns {Promise<boolean>} Success status
   */
  async loadConfig() {
    try {
      const response = await fetch('systems/spaceholder/module/data/globalmaps/biome-config.json');
      if (!response.ok) {
        console.warn('BiomeResolver | Failed to load config');
        return false;
      }

      const config = await response.json();
      
      this.biomeMatrix = config.biomeMatrix || [];
      this.biomeParameters = config.biomeParameters || {};
      this.azgaarBiomeMappings = config.azgaarBiomeMappings || {};
      
      // Load biome colors as well
      this.biomeColors = new Map();
      for (const biome of config.biomeColors || []) {
        this.biomeColors.set(biome.id, parseInt(biome.color, 16));
      }

      console.log(`BiomeResolver | Loaded ${this.biomeMatrix.length} biome rules, ${Object.keys(this.biomeParameters).length} biome parameters, ${Object.keys(this.azgaarBiomeMappings).length} Azgaar mappings`);
      return true;
    } catch (error) {
      console.error('BiomeResolver | Failed to load config:', error);
      return false;
    }
  }

  /**
   * Determine biome ID based on moisture and temperature
   * @param {number} moisture - 1-5
   * @param {number} temperature - 1-5
   * @returns {number} biomeId
   */
  getBiomeId(moisture, temperature) {
    if (!this.biomeMatrix || this.biomeMatrix.length === 0) {
      console.warn('BiomeResolver | Biome matrix not loaded');
      return 0;
    }

    // Special case: no moisture or temperature data
    if (moisture === 0 || temperature === 0) {
      return 0;
    }

    // Find matching biome in matrix
    for (const entry of this.biomeMatrix) {
      const tempMatch = temperature >= entry.tempRange[0] && temperature <= entry.tempRange[1];
      const moistMatch = moisture >= entry.moistRange[0] && moisture <= entry.moistRange[1];
      
      if (tempMatch && moistMatch) {
        return entry.biomeId;
      }
    }

    // Fallback: if no match found, return 0
    console.warn(`BiomeResolver | No biome found for moisture=${moisture}, temperature=${temperature}`);
    return 0;
  }

  /**
   * Get moisture and temperature from biome ID (reverse mapping)
   * Used when importing data that only has biome IDs
   * @param {number} biomeId
   * @returns {Object} {moisture, temperature, name}
   */
  getParametersFromBiomeId(biomeId) {
    if (!this.biomeParameters) {
      console.warn('BiomeResolver | Biome parameters not loaded');
      return { moisture: 3, temperature: 3, name: 'Unknown' };
    }

    const params = this.biomeParameters[biomeId.toString()];
    if (!params) {
      console.warn(`BiomeResolver | No parameters found for biomeId ${biomeId}`);
      return { moisture: 3, temperature: 3, name: 'Unknown' };
    }

    return params;
  }

  /**
   * Map Azgaar biome ID to our biome ID using pre-configured mappings
   * @param {number} azBiomeId - Azgaar biome index from cells.biome
   * @returns {number} Our biome ID
   */
  mapAzgaarBiomeId(azBiomeId) {
    if (!this.azgaarBiomeMappings) {
      console.warn(`BiomeResolver | Azgaar mappings not loaded`);
      return 17; // Default to Луга (grassland)
    }

    const mappedId = this.azgaarBiomeMappings[azBiomeId.toString()];
    if (mappedId === undefined) {
      console.warn(`BiomeResolver | No mapping for Azgaar biome ${azBiomeId}, using default`);
      return 17; // Default to Луга
    }

    return mappedId;
  }

  /**
   * Get biome color by ID
   * @param {number} biomeId
   * @returns {number} RGB color as hex
   */
  getBiomeColor(biomeId) {
    if (this.biomeColors && this.biomeColors.has(biomeId)) {
      return this.biomeColors.get(biomeId);
    }
    
    // Fallback: generate color from ID
    const hue = (biomeId * 137.508) % 360;
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
      r = g = b = l;
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

    return ((ri << 16) | (gi << 8) | bi) & 0xFFFFFF;
  }
}

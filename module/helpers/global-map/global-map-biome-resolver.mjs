/**
 * Global Map Biome Resolver
 * Determines biome ID based on moisture, temperature, and optionally height
 */
export class BiomeResolver {
  constructor() {
    this.biomeMatrix = null;
    this.biomeParameters = null;
    this.biomeColors = null;
    this.biomeNames = null;
    this.biomePatterns = null;
    this.biomeRegistry = null; // { version, defaultBiomeId, biomes: [{id, renderRank, enabled}], legacyRemap?: object }
    this.biomeRanks = null; // Map<biomeId, renderRank>
    this.enabledBiomeIds = null; // Set<biomeId> of enabled registry biomes
    this.legacyRemap = null; // Map<legacyBiomeId, biomeId>
    this.azgaarBiomeMappings = null;
    this.settings = null;
  }

  /**
   * Load biome configuration from file
   * @returns {Promise<boolean>} Success status
   */
  async loadConfig() {
    try {
      // 1) Load legacy biome config (colors/patterns + moisture/temperature matrix)
      const response = await fetch('systems/spaceholder/module/data/globalmaps/biome-config.json');
      if (!response.ok) {
        console.warn('BiomeResolver | Failed to load config');
        return false;
      }

      const config = await response.json();

      this.biomeMatrix = config.biomeMatrix || [];
      this.biomeParameters = config.biomeParameters || {};
      this.azgaarBiomeMappings = config.azgaarBiomeMappings || {};
      this.settings = config.settings || {};

      // Load biome colors, names, and patterns (MUST stay stable; user wants to preserve current palette)
      this.biomeColors = new Map();
      this.biomeNames = new Map();
      this.biomePatterns = new Map();
      for (const biome of config.biomeColors || []) {
        this.biomeColors.set(biome.id, parseInt(biome.color, 16));
        if (biome.name) {
          this.biomeNames.set(biome.id, biome.name);
        }
        if (biome.pattern) {
          this.biomePatterns.set(biome.id, biome.pattern);
        }
      }

      // 2) Load biome registry (explicit biome list + renderRank)
      this.biomeRegistry = null;
      this.biomeRanks = new Map();
      this.enabledBiomeIds = null;
      this.legacyRemap = null;
      try {
        const regResponse = await fetch('systems/spaceholder/module/data/globalmaps/biome-registry.json');
        if (regResponse.ok) {
          const registry = await regResponse.json();
          this.biomeRegistry = registry;

          this.enabledBiomeIds = new Set();
          this.legacyRemap = new Map();

          for (const entry of registry.biomes || []) {
            if (typeof entry?.id !== 'number') continue;

            if (entry.enabled !== false) {
              this.enabledBiomeIds.add(entry.id);
            }

            if (typeof entry?.renderRank !== 'number') continue;
            this.biomeRanks.set(entry.id, entry.renderRank);
          }

          if (registry?.legacyRemap && typeof registry.legacyRemap === 'object') {
            for (const [fromStr, toVal] of Object.entries(registry.legacyRemap)) {
              const from = Number(fromStr);
              const to = Number(toVal);
              if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
              this.legacyRemap.set(from, to);
            }
          }
        } else {
          console.warn('BiomeResolver | Failed to load biome registry, continuing without ranks');
        }
      } catch (e) {
        console.warn('BiomeResolver | Failed to load biome registry, continuing without ranks:', e);
      }

      const loadedRegistry = this.biomeRegistry ? `, registry biomes: ${(this.biomeRegistry.biomes || []).length}` : '';
      console.log(
        `BiomeResolver | Loaded ${this.biomeMatrix.length} biome rules, ` +
        `${Object.keys(this.biomeParameters).length} biome parameters, ` +
        `${Object.keys(this.azgaarBiomeMappings).length} Azgaar mappings${loadedRegistry}`
      );

      return true;
    } catch (error) {
      console.error('BiomeResolver | Failed to load config:', error);
      return false;
    }
  }

  /**
   * Determine biome ID based on moisture and temperature
   * @param {number} moisture - 1-6
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
      return this.getDefaultBiomeId();
    }

    const mappedId = this.azgaarBiomeMappings[azBiomeId.toString()];
    if (mappedId === undefined) {
      console.warn(`BiomeResolver | No mapping for Azgaar biome ${azBiomeId}, using default`);
      return this.getDefaultBiomeId();
    }

    return this.normalizeBiomeId(mappedId);
  }

  /**
   * Normalize biome ID to an enabled biome using registry legacyRemap.
   * If registry is not loaded, returns biomeId unchanged.
   * @param {number} biomeId
   * @returns {number}
   */
  normalizeBiomeId(biomeId) {
    if (typeof biomeId !== 'number' || Number.isNaN(biomeId)) {
      return this.getDefaultBiomeId();
    }

    // No registry → keep legacy behavior
    if (!this.biomeRegistry?.biomes?.length) {
      return biomeId;
    }

    if (this.enabledBiomeIds?.has(biomeId)) {
      return biomeId;
    }

    // Follow legacy remap chain (bounded to avoid cycles)
    let current = biomeId;
    const seen = new Set([current]);
    for (let step = 0; step < 8; step++) {
      const next = this.legacyRemap?.get(current);
      if (typeof next !== 'number' || Number.isNaN(next)) break;
      if (seen.has(next)) break;
      if (this.enabledBiomeIds?.has(next)) return next;
      seen.add(next);
      current = next;
    }

    return this.getDefaultBiomeId();
  }

  /**
   * Get default biome ID (used for fallbacks)
   * @returns {number}
   */
  getDefaultBiomeId() {
    const fromRegistry = this.biomeRegistry?.defaultBiomeId;
    if (typeof fromRegistry === 'number') return fromRegistry;
    return 17; // Legacy default: Луга
  }

  /**
   * Get biome render rank.
   * Higher rank = rendered later (on top).
   * @param {number} biomeId
   * @returns {number}
   */
  getBiomeRank(biomeId) {
    if (this.biomeRanks && this.biomeRanks.has(biomeId)) {
      return this.biomeRanks.get(biomeId);
    }

    // Fallback: approximate rank from legacy moisture/temperature mapping
    const params = this.getParametersFromBiomeId(biomeId);
    if (params && typeof params.moisture === 'number' && typeof params.temperature === 'number') {
      return 100 + params.moisture * 10 + params.temperature;
    }

    return 0;
  }

  /**
   * List active biomes from registry (enabled = true).
   * Falls back to all biomes found in biomeColors.
   * @returns {Array<{id:number, renderRank:number, name:string}>}
   */
  listBiomes() {
    const result = [];

    if (this.biomeRegistry?.biomes?.length) {
      for (const entry of this.biomeRegistry.biomes) {
        if (!entry || typeof entry.id !== 'number') continue;
        if (entry.enabled === false) continue;
        result.push({
          id: entry.id,
          renderRank: typeof entry.renderRank === 'number' ? entry.renderRank : this.getBiomeRank(entry.id),
          name: this.getBiomeName(entry.id),
        });
      }
    } else if (this.biomeColors) {
      for (const id of this.biomeColors.keys()) {
        result.push({ id, renderRank: this.getBiomeRank(id), name: this.getBiomeName(id) });
      }
    }

    result.sort((a, b) => {
      if (a.renderRank !== b.renderRank) return a.renderRank - b.renderRank;
      return a.id - b.id;
    });

    return result;
  }

  /**
   * Get biome name by ID.
   * @param {number} biomeId
   * @returns {string}
   */
  getBiomeName(biomeId) {
    if (this.biomeNames && this.biomeNames.has(biomeId)) {
      return this.biomeNames.get(biomeId);
    }

    const params = this.biomeParameters?.[biomeId?.toString?.()];
    if (params?.name) return params.name;

    return `Biome ${biomeId}`;
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
   * Get biome pattern config by ID
   * @param {number} biomeId
   * @returns {Object|null} Pattern config or null
   */
  getBiomePattern(biomeId) {
    if (this.biomePatterns && this.biomePatterns.has(biomeId)) {
      return this.biomePatterns.get(biomeId);
    }
    return null;
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

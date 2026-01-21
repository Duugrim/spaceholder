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
    this.biomeLinks = null;
    this.biomeRegistry = null; // { version, defaultBiomeId, biomes: [{id, renderRank, enabled}], legacyRemap?: object }
    this.biomeRanks = null; // Map<biomeId, renderRank>
    this.enabledBiomeIds = null; // Set<biomeId> of enabled registry biomes
    this.legacyRemap = null; // Map<legacyBiomeId, biomeId>
    this.azgaarBiomeMappings = null;
    this.settings = null;

    // World overrides (stored as JSON in the world folder)
    this.worldBiomeOverrides = null; // {version, biomes:[...]} (raw loaded structure)
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

      // Load biome colors, names, patterns and links.
      // Colors/patterns MUST stay stable; user wants to preserve current palette.
      this.biomeColors = new Map();
      this.biomeNames = new Map();
      this.biomePatterns = new Map();
      this.biomeLinks = new Map();
      for (const biome of config.biomeColors || []) {
        this.biomeColors.set(biome.id, parseInt(biome.color, 16));
        if (biome.name) {
          this.biomeNames.set(biome.id, biome.name);
        }
        if (biome.pattern) {
          this.biomePatterns.set(biome.id, biome.pattern);
        }
        // Links live only in world overrides for now.
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
   * List biomes from registry.
   * By default returns only enabled biomes.
   * @param {{includeDisabled?: boolean}} [options]
   * @returns {Array<{id:number, renderRank:number, name:string, enabled:boolean}>}
   */
  listBiomes({ includeDisabled = false } = {}) {
    const result = [];

    if (this.biomeRegistry?.biomes?.length) {
      for (const entry of this.biomeRegistry.biomes) {
        if (!entry || typeof entry.id !== 'number') continue;

        const enabled = entry.enabled !== false;
        if (!includeDisabled && !enabled) continue;

        result.push({
          id: entry.id,
          renderRank: typeof entry.renderRank === 'number' ? entry.renderRank : this.getBiomeRank(entry.id),
          name: this.getBiomeName(entry.id),
          enabled,
        });
      }
    } else if (this.biomeColors) {
      for (const id of this.biomeColors.keys()) {
        result.push({ id, renderRank: this.getBiomeRank(id), name: this.getBiomeName(id), enabled: true });
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
   * Get biome link UUID by ID (JournalEntry/JournalEntryPage).
   * @param {number} biomeId
   * @returns {string}
   */
  getBiomeLink(biomeId) {
    if (this.biomeLinks && this.biomeLinks.has(biomeId)) {
      return String(this.biomeLinks.get(biomeId) ?? '').trim();
    }
    return '';
  }

  // ==========================
  // World overrides (JSON file)
  // ==========================

  _getWorldOverridesDirectory() {
    try {
      const worldId = game?.world?.id;
      if (!worldId) return null;
      return `worlds/${worldId}/global-maps`;
    } catch (e) {
      return null;
    }
  }

  getWorldOverridesPath() {
    const dir = this._getWorldOverridesDirectory();
    if (!dir) return null;
    return `${dir}/biome-overrides.json`;
  }

  _normalizeHexColorToInt(value) {
    if (value === null || value === undefined) return null;

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value & 0xFFFFFF;
    }

    let s = String(value).trim();
    if (!s) return null;

    if (s.startsWith('#')) s = s.slice(1);
    if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);

    // Keep only hex digits
    s = s.replace(/[^0-9a-fA-F]/g, '');

    // Expand short form (#abc)
    if (s.length === 3) {
      s = s.split('').map((ch) => ch + ch).join('');
    }

    if (s.length !== 6) return null;

    const n = parseInt(s, 16);
    if (!Number.isFinite(n)) return null;

    return n & 0xFFFFFF;
  }

  _normalizeHexColorToHex6(value) {
    const n = this._normalizeHexColorToInt(value);
    if (n === null) return null;
    return n.toString(16).padStart(6, '0').toUpperCase();
  }

  _normalizePatternConfig(pattern, baseColorInt = null) {
    if (!pattern || typeof pattern !== 'object') return null;

    const typeRaw = String(pattern.type || '').trim();
    const type = [
      'circles',
      'diagonal',
      'crosshatch',
      'vertical',
      'horizontal',
      'dots',
      'waves',
      'hexagons',
      'spots',
    ].includes(typeRaw) ? typeRaw : null;

    if (!type) return null;

    const patternColorHex6 = this._normalizeHexColorToHex6(pattern.patternColor);

    const spacing = Number(pattern.spacing);
    const lineWidth = Number(pattern.lineWidth);
    const opacity = Number(pattern.opacity);
    const darkenFactor = Number(pattern.darkenFactor);

    const out = {
      type,
    };

    // Keep patternColor as hex WITHOUT '#', because renderer does parseInt(str, 16)
    if (patternColorHex6) {
      out.patternColor = patternColorHex6;
    }

    if (Number.isFinite(spacing) && spacing > 0) out.spacing = spacing;
    if (Number.isFinite(lineWidth) && lineWidth > 0) out.lineWidth = lineWidth;
    if (Number.isFinite(opacity) && opacity >= 0 && opacity <= 1) out.opacity = opacity;
    if (Number.isFinite(darkenFactor) && darkenFactor >= 0 && darkenFactor <= 1) out.darkenFactor = darkenFactor;

    return out;
  }

  async loadOverridesFromWorldFile(path = null) {
    const p = path || this.getWorldOverridesPath();
    if (!p) return null;

    try {
      const response = await fetch(p);
      if (!response.ok) {
        // Not found is OK: no overrides.
        if (response.status === 404) return null;
        console.warn(`BiomeResolver | Failed to load world biome overrides (${response.status} ${response.statusText})`);
        return null;
      }

      const json = await response.json();
      if (!json || typeof json !== 'object') return null;
      return json;
    } catch (e) {
      console.warn('BiomeResolver | Failed to load world biome overrides:', e);
      return null;
    }
  }

  async saveOverridesToWorldFile(overrides, path = null) {
    const p = path || this.getWorldOverridesPath();
    const dir = this._getWorldOverridesDirectory();

    if (!p || !dir) {
      throw new Error('World overrides path is not available');
    }

    // GM/Assistant only (same intent as map editing)
    try {
      const canWrite = (() => {
        if (game.user?.isGM) return true;
        const assistantRole = CONST?.USER_ROLES?.ASSISTANT;
        if (assistantRole !== undefined && typeof game.user?.hasRole === 'function') {
          return game.user.hasRole(assistantRole);
        }
        return false;
      })();

      if (!canWrite) {
        throw new Error('Only GM or Assistant GM can save biome overrides');
      }
    } catch (e) {
      throw e;
    }

    const fileName = p.split('/').pop() || 'biome-overrides.json';

    // Ensure directory exists
    try {
      await foundry.applications.apps.FilePicker.implementation.createDirectory('data', dir, {});
    } catch (err) {
      // may already exist
    }

    const payload = overrides && typeof overrides === 'object' ? overrides : { version: 1, biomes: [] };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const file = new File([blob], fileName, { type: 'application/json' });

    const response = await foundry.applications.apps.FilePicker.implementation.upload(
      'data',
      dir,
      file,
      {}
    );

    return response?.path || p;
  }

  applyBiomeOverrides(overrides) {
    if (!overrides || typeof overrides !== 'object') return;

    const biomes = Array.isArray(overrides.biomes) ? overrides.biomes : [];
    if (!biomes.length) return;

    // Ensure maps exist (defensive)
    if (!this.biomeColors) this.biomeColors = new Map();
    if (!this.biomeNames) this.biomeNames = new Map();
    if (!this.biomePatterns) this.biomePatterns = new Map();
    if (!this.biomeLinks) this.biomeLinks = new Map();
    if (!this.biomeRanks) this.biomeRanks = new Map();
    if (!this.enabledBiomeIds) this.enabledBiomeIds = new Set();

    // Ensure registry exists so listBiomes() includes custom entries.
    if (!this.biomeRegistry || typeof this.biomeRegistry !== 'object') {
      this.biomeRegistry = {
        version: 1,
        defaultBiomeId: this.getDefaultBiomeId(),
        biomes: [],
      };
    }
    if (!Array.isArray(this.biomeRegistry.biomes)) {
      this.biomeRegistry.biomes = [];
    }

    for (const raw of biomes) {
      if (!raw || typeof raw !== 'object') continue;

      const id = Number(raw.id);
      if (!Number.isFinite(id) || id < 0 || id > 255) continue;

      const enabled = raw.enabled !== false;

      const rank = Number(raw.renderRank);

      // If explicitly disabled in overrides: keep in registry, but do not apply any visual overrides.
      if (!enabled) {
        // Ensure biome is present in registry and disabled.
        let regEntry = this.biomeRegistry.biomes.find(e => e && typeof e.id === 'number' && e.id === id);
        if (!regEntry) {
          regEntry = { id, renderRank: Number.isFinite(rank) ? rank : this.getBiomeRank(id), enabled: false };
          this.biomeRegistry.biomes.push(regEntry);
        } else {
          if (Number.isFinite(rank)) {
            regEntry.renderRank = rank;
          }
          regEntry.enabled = false;
        }

        // Do not add to enabledBiomeIds.
        continue;
      }

      const name = (typeof raw.name === 'string') ? raw.name.trim() : '';
      if (name) {
        this.biomeNames.set(id, name);
      }

      const colorInt = this._normalizeHexColorToInt(raw.color);
      if (colorInt !== null) {
        this.biomeColors.set(id, colorInt);
      }

      const linkRaw = (typeof raw.link === 'string') ? raw.link.trim() : '';
      if (linkRaw) {
        // Keep as UUID string.
        const match = linkRaw.match(/@UUID\[(.+?)\]/);
        const uuid = String(match?.[1] ?? linkRaw).trim();
        if (uuid) this.biomeLinks.set(id, uuid);
      } else {
        this.biomeLinks.delete(id);
      }

      // Pattern: allow explicit null/empty to remove
      if (raw.pattern === null) {
        this.biomePatterns.delete(id);
      } else {
        const baseColor = (colorInt !== null)
          ? colorInt
          : (this.biomeColors?.get?.(id) ?? null);

        const normalizedPattern = this._normalizePatternConfig(raw.pattern, baseColor);
        if (normalizedPattern) {
          this.biomePatterns.set(id, normalizedPattern);
        }
      }

      if (Number.isFinite(rank)) {
        this.biomeRanks.set(id, rank);
      }

      // Ensure biome is present in registry and enabled.
      let regEntry = this.biomeRegistry.biomes.find(e => e && typeof e.id === 'number' && e.id === id);
      if (!regEntry) {
        regEntry = { id, renderRank: Number.isFinite(rank) ? rank : this.getBiomeRank(id), enabled: true };
        this.biomeRegistry.biomes.push(regEntry);
      } else {
        if (Number.isFinite(rank)) {
          regEntry.renderRank = rank;
        }
        if (regEntry.enabled === false) {
          regEntry.enabled = true;
        }
      }

      this.enabledBiomeIds.add(id);
    }

    // Rebuild ranks/enabled sets from registry to keep everything consistent.
    try {
      const nextRanks = new Map();
      const nextEnabled = new Set();

      for (const entry of this.biomeRegistry.biomes) {
        if (!entry || typeof entry.id !== 'number') continue;
        if (entry.enabled === false) continue;
        nextEnabled.add(entry.id);
        if (typeof entry.renderRank === 'number') {
          nextRanks.set(entry.id, entry.renderRank);
        }
      }

      this.enabledBiomeIds = nextEnabled;
      this.biomeRanks = nextRanks;
    } catch (e) {
      // ignore
    }
  }

  async reloadConfigWithWorldOverrides() {
    const ok = await this.loadConfig();
    if (!ok) return false;

    const overrides = await this.loadOverridesFromWorldFile();
    this.worldBiomeOverrides = overrides;

    if (overrides) {
      this.applyBiomeOverrides(overrides);
    }

    return true;
  }

  getNextFreeBiomeId() {
    const used = new Set();

    try {
      if (this.biomeColors) {
        for (const id of this.biomeColors.keys()) {
          used.add(Number(id));
        }
      }

      if (this.biomeRegistry?.biomes?.length) {
        for (const entry of this.biomeRegistry.biomes) {
          if (typeof entry?.id === 'number') used.add(entry.id);
        }
      }
    } catch (e) {
      // ignore
    }

    for (let id = 0; id <= 255; id++) {
      if (!used.has(id)) return id;
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

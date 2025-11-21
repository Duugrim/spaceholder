/**
 * Biome Configuration
 * Manages biome colors and settings
 */

let configCache = null;

/**
 * Load configuration from JSON file
 */
async function loadConfig() {
  if (configCache) return configCache;
  
  try {
    const response = await fetch('systems/spaceholder/module/data/globalmaps/biome-config.json');
    if (!response.ok) {
      throw new Error(`Failed to load biome config: ${response.statusText}`);
    }
    
    const config = await response.json();
    
    // Parse hex color strings to numbers
    config.biomeColors = config.biomeColors.map(biome => ({
      ...biome,
      color: parseInt(biome.color, 16)
    }));
    
    configCache = config;
    return config;
  } catch (error) {
    console.error('BiomeConfig | Failed to load config:', error);
    // Return default config if loading fails
    return getDefaultConfig();
  }
}

/**
 * Get default configuration (fallback)
 * Based on Azgaar's FMG biome IDs
 */
function getDefaultConfig() {
  return {
    biomeColors: [
      { id: 0, name: 'Marine', color: 0x003366 },          // Темно-синий (море/океан)
      { id: 1, name: 'Hot desert', color: 0xFFCC66 },      // Песочный
      { id: 2, name: 'Cold desert', color: 0xCCCCBB },     // Серо-бежевый
      { id: 3, name: 'Savanna', color: 0xDDDD88 },         // Светло-желтый
      { id: 4, name: 'Grassland', color: 0x88CC55 },       // Светло-зеленый
      { id: 5, name: 'Tropical seasonal forest', color: 0x66AA44 }, // Зеленый
      { id: 6, name: 'Temperate deciduous forest', color: 0x558833 }, // Темно-зеленый
      { id: 7, name: 'Tropical rainforest', color: 0x336622 }, // Очень темно-зеленый
      { id: 8, name: 'Temperate rainforest', color: 0x447744 }, // Лесной зеленый
      { id: 9, name: 'Taiga', color: 0x667744 },           // Хвойный
      { id: 10, name: 'Tundra', color: 0xAABB99 },         // Серо-зеленый
      { id: 11, name: 'Glacier', color: 0xEEFFFF },        // Ледяной белый
      { id: 12, name: 'Wetland', color: 0x5588AA },        // Болотный сине-зеленый
    ],
    settings: {
      defaultRenderMode: 'filled',  // Биомы всегда заливкой
      fillAlpha: 0.5,               // Прозрачность заливки
      showBorders: false,           // Показывать границы между биомами
      borderWidth: 1,
      borderAlpha: 0.3,
      borderColor: 0x000000
    }
  };
}

/**
 * Get biome colors (loads config if needed)
 */
export async function getBiomeColors() {
  const config = await loadConfig();
  return config.biomeColors;
}

/**
 * Get settings (loads config if needed)
 */
export async function getSettings() {
  const config = await loadConfig();
  return config.settings;
}

/**
 * Get color for specific biome ID
 */
export async function getBiomeColor(biomeId) {
  const colors = await getBiomeColors();
  const biome = colors.find(b => b.id === biomeId);
  return biome ? biome.color : 0x808080; // Gray fallback
}

/**
 * Reload configuration from file (clears cache)
 */
export async function reloadConfig() {
  configCache = null;
  return await loadConfig();
}

// For backward compatibility, export synchronous defaults
export const BIOME_COLORS = [];
export const BIOME_SETTINGS = getDefaultConfig().settings;

// Load config on module initialization
loadConfig().then(config => {
  BIOME_COLORS.push(...config.biomeColors);
  Object.assign(BIOME_SETTINGS, config.settings);
});

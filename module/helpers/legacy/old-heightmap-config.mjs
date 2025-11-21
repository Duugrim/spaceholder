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
 * Height Map Configuration
 * Loads configuration from JSON file
 */

let configCache = null;

/**
 * Load configuration from JSON file
 */
async function loadConfig() {
  if (configCache) return configCache;
  
  try {
    const response = await fetch('systems/spaceholder/module/data/globalmaps/heightmap-config.json');
    if (!response.ok) {
      throw new Error(`Failed to load heightmap config: ${response.statusText}`);
    }
    
    const config = await response.json();
    
    // Parse hex color strings to numbers
    config.contourLevels = config.contourLevels.map(level => ({
      ...level,
      color: parseInt(level.color, 16)
    }));
    
    configCache = config;
    return config;
  } catch (error) {
    console.error('HeightMapConfig | Failed to load config:', error);
    // Return default config if loading fails
    return getDefaultConfig();
  }
}

/**
 * Get default configuration (fallback)
 */
function getDefaultConfig() {
  return {
    contourLevels: [
      { level: 10, minHeight: 10, maxHeight: 18, color: 0x0066CC },
      { level: 25, minHeight: 25, maxHeight: 30, color: 0x00AA00 },
      { level: 50, minHeight: 50, maxHeight: 55, color: 0xAAAA00 },
      { level: 75, minHeight: 75, maxHeight: 80, color: 0xDD8800 },
      { level: 95, minHeight: 95, maxHeight: 100, color: 0xFFFFFF }
    ],
    settings: {
      defaultRenderMode: 'contours',
      minRegionSize: 9,
      lineWidth: 2,
      lineAlpha: 0.8,
      fillAlpha: 0.3
    }
  };
}

/**
 * Get contour levels (loads config if needed)
 */
export async function getContourLevels() {
  const config = await loadConfig();
  return config.contourLevels;
}

/**
 * Get settings (loads config if needed)
 */
export async function getSettings() {
  const config = await loadConfig();
  return config.settings;
}

/**
 * Reload configuration from file (clears cache)
 */
export async function reloadConfig() {
  configCache = null;
  return await loadConfig();
}

// For backward compatibility, export synchronous defaults
export const HEIGHTMAP_CONTOUR_LEVELS = [];
export const HEIGHTMAP_SETTINGS = getDefaultConfig().settings;

// Load config on module initialization
loadConfig().then(config => {
  HEIGHTMAP_CONTOUR_LEVELS.push(...config.contourLevels);
  Object.assign(HEIGHTMAP_SETTINGS, config.settings);
});

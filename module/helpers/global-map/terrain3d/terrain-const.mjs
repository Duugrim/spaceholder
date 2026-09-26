export const MODULE_NS = 'spaceholder';

export const TERRAIN_VERSION = 2;
export const DEFAULT_SAMPLES = 1024;
export const MAX_SAMPLES = 2048;
export const SPLAT_LAYERS = 4;
export const HEIGHT_MIN = 0;
export const HEIGHT_MAX = 100;
export const MESH_SEGMENTS = 256;

export const CLIENT_SETTING_VIEW_3D = 'globalmap.view3d';
export const FLAG_TERRAIN_PATH = 'globalMapTerrainPath';

export const CAMERA_FOV = 40;
export const CAMERA_TILT_RAD = (32 * Math.PI) / 180;
export const VIEW_HEIGHT_EXAGGERATION = 2.75;
export const MAX_RENDER_PIXEL_RATIO = 1.5;
export const TOKEN_SYNC_INTERVAL_MS = 100;
export const REGION_WALL_HEIGHT_FACTOR = 0.018;
export const LOOK_EYE_HEIGHT_GRID = 0.55;

export const UNDO_MAX = 16;

export const OVERLAY_ID = 'spaceholder-terrain3d-overlay';
export const TOOLBAR_ID = 'spaceholder-terrain3d-toolbar';

export const TOOLS = Object.freeze({
  SELECT: 'select',
  RAISE: 'raise',
  LOWER: 'lower',
  SMOOTH: 'smooth',
  FLATTEN: 'flatten',
  NOISE: 'noise',
  PAINT: 'paint',
  LOOK: 'look',
});

import { CLIENT_SETTING_VIEW_3D, MODULE_NS } from './terrain-const.mjs';
import { TerrainData } from './terrain-data.mjs';
import { TerrainView } from './terrain-view.mjs';
import { openLookFromPoint } from './look-from-app.mjs';

let _threeLoadPromise = null;
function loadThree() {
  if (!_threeLoadPromise) _threeLoadPromise = import('../../../vendor/three.module.mjs');
  return _threeLoadPromise;
}

function _t(key) {
  return game?.i18n?.localize ? game.i18n.localize(key) : String(key);
}

function isGlobalMapScene(scene = canvas?.scene) {
  return Boolean(scene?.getFlag?.(MODULE_NS, 'isGlobalMap') ?? scene?.flags?.[MODULE_NS]?.isGlobalMap);
}

function biomeResolver() {
  return game.spaceholder?.globalMapProcessing?.biomeResolver
    ?? game.spaceholder?.globalMapRenderer?.biomeResolver
    ?? null;
}

/**
 * Orchestrates 3D terrain data, overlay view, 2D bake, and look-from window.
 */
export class GlobalMapTerrain3D {
  constructor() {
    this.data = null;
    this.view = new TerrainView({
      biomeResolver: biomeResolver(),
      getRegions: () => game.spaceholder?.globalMapRenderer?.vectorRegionsData ?? canvas?.scene?.getFlag?.(MODULE_NS, 'globalMapRegions') ?? null,
      onLookFrom: (opts) => this.openLookFrom(opts),
      onSave: () => this.save(),
    });
    this._hooks = false;
    this._lookApp = null;
    this._readySeq = 0;
  }

  get enabled() {
    return this.view.enabled;
  }

  install() {
    if (this._hooks) return;
    this._hooks = true;
    this._registerSetting();

    Hooks.on('canvasReady', () => {
      void this._onCanvasReady();
    });
    Hooks.on('updateScene', (scene) => {
      if (scene?.id !== canvas?.scene?.id) return;
      void this._syncButton();
    });
  }

  _registerSetting() {
    try {
      if (game.settings.settings.has(`${MODULE_NS}.${CLIENT_SETTING_VIEW_3D}`)) return;
      game.settings.register(MODULE_NS, CLIENT_SETTING_VIEW_3D, {
        name: _t('SPACEHOLDER.GlobalMap.Terrain3d.Setting.Name'),
        hint: _t('SPACEHOLDER.GlobalMap.Terrain3d.Setting.Hint'),
        scope: 'client',
        config: false,
        type: Boolean,
        default: false,
        onChange: (v) => {
          void this._applyEnabled(Boolean(v));
        },
      });
    } catch (e) {
      console.warn('GlobalMapTerrain3D | setting register failed', e);
    }
  }

  isEnabledSetting() {
    try {
      return Boolean(game.settings.get(MODULE_NS, CLIENT_SETTING_VIEW_3D));
    } catch (_) {
      return false;
    }
  }

  async toggle() {
    return this.setEnabled(!this.enabled);
  }

  async setEnabled(on) {
    const want = Boolean(on);
    if (!isGlobalMapScene()) {
      if (this.view.enabled) await this.view.disable();
      this._syncButton();
      return false;
    }
    const cur = this.isEnabledSetting();
    if (cur !== want) {
      try {
        await game.settings.set(MODULE_NS, CLIENT_SETTING_VIEW_3D, want);
      } catch (_) {
        /* ignore */
      }
    }
    return this._applyEnabled(want);
  }

  async _applyEnabled(on) {
    if (!isGlobalMapScene()) {
      if (this.view.enabled) await this.view.disable();
      this._syncButton();
      return false;
    }
    if (!on) {
      if (this.view.enabled) await this.view.disable();
      await this.restoreCellMap();
      this._syncButton();
      return false;
    }
    this.view.biomeResolver = biomeResolver();
    const data = await this.ensureData();
    if (!data) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Terrain3d.Errors.NoData'));
      try {
        await game.settings.set(MODULE_NS, CLIENT_SETTING_VIEW_3D, false);
      } catch (_) {
        /* ignore */
      }
      this._syncButton();
      return false;
    }
    this.view.biomeResolver = biomeResolver();
    const THREE = await loadThree();
    await this.view.enable(THREE, data);
    this._syncButton();
    return true;
  }

  /**
   * Rebuild the canonical heightmap from the current (or given) cell grid.
   * Used after import / test-grid so 3D is not stuck on a previous file.
   */
  async syncFromUnifiedGrid({ grid, metadata } = {}) {
    const scene = canvas?.scene;
    if (!scene || !isGlobalMapScene(scene)) return null;
    const processing = game.spaceholder?.globalMapProcessing;
    const gridData = grid ?? processing?.getUnifiedGrid?.() ?? game.spaceholder?.globalMapRenderer?.currentGrid;
    const meta = metadata ?? processing?.getGridMetadata?.() ?? game.spaceholder?.globalMapRenderer?.currentMetadata;
    if (!gridData || !meta) return null;
    const resolver = biomeResolver();
    this.data = TerrainData.fromUnifiedGrid(gridData, meta, scene, {
      biomeId: resolver?.getDefaultBiomeId?.() ?? 17,
    });
    this.view.biomeResolver = resolver;
    this.view.data = this.data;
    if (this.view.enabled) await this.view.rebuild(this.data);
    else this.view.clear2dBake();
    if (game.user?.isGM) {
      try {
        await this.data.saveToScene(scene);
      } catch (e) {
        console.warn('GlobalMapTerrain3D | sync save failed', e);
      }
    }
    return this.data;
  }

  async restoreCellMap() {
    this.view.clear2dBake();
    const renderer = game.spaceholder?.globalMapRenderer;
    if (renderer?.currentGrid && renderer?.currentMetadata) {
      try {
        await renderer.render(renderer.currentGrid, renderer.currentMetadata);
      } catch (e) {
        console.warn('GlobalMapTerrain3D | restore cell map failed', e);
      }
    }
  }

  /**
   * Load terrain file, or import the current/legacy unified grid, or create a flat heightmap.
   * @returns {Promise<TerrainData|null>}
   */
  async ensureData() {
    const scene = canvas?.scene;
    if (!scene) return null;

    const renderer = game.spaceholder?.globalMapRenderer;
    const processing = game.spaceholder?.globalMapProcessing;
    const liveGrid = processing?.getUnifiedGrid?.() ?? renderer?.currentGrid;
    const liveMeta = processing?.getGridMetadata?.() ?? renderer?.currentMetadata;
    const resolver = biomeResolver();
    const defaultBiome = resolver?.getDefaultBiomeId?.() ?? 17;

    if (this.data && this.data.source !== 'empty') return this.data;

    const existing = await TerrainData.loadFromScene(scene);
    if (existing) {
      this.data = existing;
      return existing;
    }

    let grid = liveGrid;
    let meta = liveMeta;
    if (!grid) {
      try {
        const loaded = await processing?.loadGridFromFile?.(scene);
        grid = loaded?.gridData ?? processing?.getUnifiedGrid?.() ?? renderer?.currentGrid;
        meta = loaded?.metadata ?? processing?.getGridMetadata?.() ?? renderer?.currentMetadata;
      } catch (_) {
        /* ignore */
      }
    }

    if (grid && meta) {
      this.data = TerrainData.fromUnifiedGrid(grid, meta, scene, { biomeId: defaultBiome });
      if (game.user?.isGM) {
        try {
          await this.data.saveToScene(scene);
        } catch (_) {
          /* ignore */
        }
      }
    } else {
      this.data = TerrainData.createEmpty(scene, { biomeId: defaultBiome, height: 20 });
    }
    return this.data;
  }

  async save() {
    const scene = canvas?.scene;
    if (!this.data || !scene) return false;
    const ok = await this.data.saveToScene(scene);
    if (ok) this.view.apply2dBake();
    return ok;
  }

  /**
   * @param {{ x?: number, y?: number, token?: Token }} opts
   */
  async openLookFrom(opts = {}) {
    const data = this.data || (await this.ensureData());
    if (!data) return null;
    let x = Number(opts.x);
    let y = Number(opts.y);
    const token = opts.token || canvas.tokens?.controlled?.[0];
    if ((!Number.isFinite(x) || !Number.isFinite(y)) && token) {
      x = Number(token.document.x) + (Number(token.w) || 0) / 2;
      y = Number(token.document.y) + (Number(token.h) || 0) / 2;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Terrain3d.LookFrom.NeedPoint'));
      return null;
    }
    if (this._lookApp) {
      try {
        await this._lookApp.close();
      } catch (_) {
        /* ignore */
      }
    }
    this._lookApp = await openLookFromPoint({
      data,
      biomeResolver: biomeResolver(),
      regionsData: game.spaceholder?.globalMapRenderer?.vectorRegionsData ?? null,
      x,
      y,
    });
    return this._lookApp;
  }

  async onRendererReady() {
    return this._onCanvasReady();
  }

  async _onCanvasReady() {
    const seq = ++this._readySeq;
    this.view.biomeResolver = biomeResolver();
    const want3d = this.isEnabledSetting();
    if (this.view.enabled) await this.view.disable();
    this.data = null;
    if (seq !== this._readySeq) return;
    if (!isGlobalMapScene()) {
      this.data = null;
      this._syncButton();
      return;
    }
    if (want3d) {
      await this._applyEnabled(true);
      return;
    }
    this.view.clear2dBake();
    this._syncButton();
  }

  _syncButton() {
    const btn = document.querySelector('#spaceholder-globalmap-edge-ui [data-action="toggle-view-3d"]');
    if (!btn) return;
    const on = this.enabled;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

export function createGlobalMapTerrain3D() {
  return new GlobalMapTerrain3D();
}

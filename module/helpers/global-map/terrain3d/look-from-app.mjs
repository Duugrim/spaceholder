import { LOOK_EYE_HEIGHT_GRID } from './terrain-const.mjs';
import { createTerrainVisual } from './terrain-mesh.mjs';
import { createRegionMeshes } from './terrain-regions.mjs';

const TEMPLATE = 'systems/spaceholder/templates/global-map/terrain-look-from.hbs';

let _threeLoadPromise = null;
function loadThree() {
  if (!_threeLoadPromise) _threeLoadPromise = import('../../../vendor/three.module.mjs');
  return _threeLoadPromise;
}

function _t(key) {
  return game?.i18n?.localize ? game.i18n.localize(key) : String(key);
}

export class TerrainLookFromApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2,
) {
  static DEFAULT_OPTIONS = {
    id: 'spaceholder-terrain-look-from',
    classes: ['spaceholder', 'terrain-look-from'],
    window: { resizable: true },
    position: { width: 780, height: 560 },
  };

  static PARTS = {
    main: { root: true, template: TEMPLATE },
  };

  /**
   * @param {object} options
   * @param {import('./terrain-data.mjs').TerrainData} options.data
   * @param {object} options.biomeResolver
   * @param {object} [options.regionsData]
   * @param {number} options.x
   * @param {number} options.y
   */
  constructor(options = {}) {
    const { data, biomeResolver, regionsData, x, y, ...rest } = options;
    super(rest);
    this._data = data;
    this._biomeResolver = biomeResolver;
    this._regionsData = regionsData ?? null;
    this._originX = Number(x) || 0;
    this._originY = Number(y) || 0;
    this._THREE = null;
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._visual = null;
    this._regions = null;
    this._raf = null;
    this._yaw = 0;
    this._pitch = 0.12;
    this._drag = false;
    this._keys = new Set();
    this._mounting = false;
    this._disposed = false;
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
  }

  get title() {
    return _t('SPACEHOLDER.GlobalMap.Terrain3d.LookFrom.Title');
  }

  async _prepareContext() {
    return {
      hint: _t('SPACEHOLDER.GlobalMap.Terrain3d.LookFrom.Hint'),
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    void this._mount();
  }

  async close(opts) {
    this._teardown();
    return super.close(opts);
  }

  async _mount() {
    const host = this.element?.querySelector?.('[data-look-from-canvas]');
    if (!host || !this._data) return;
    if (this._renderer || this._mounting) {
      this._resize();
      return;
    }
    this._mounting = true;
    const THREE = await loadThree();
    if (this._disposed) {
      this._mounting = false;
      return;
    }
    this._THREE = THREE;
    host.innerHTML = '';

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x87a0c0, 1);
    if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    this._renderer = renderer;

    const scene = new THREE.Scene();
    this._scene = scene;

    const camera = new THREE.PerspectiveCamera(70, 1, 2, 200000);
    this._camera = camera;

    this._visual = createTerrainVisual(THREE, this._data, this._biomeResolver);
    scene.add(this._visual.mesh);
    this._regions = createRegionMeshes(THREE, this._data, this._regionsData);
    scene.add(this._regions.group);

    const amb = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(amb);
    scene.add(new THREE.HemisphereLight(0xc8d6e8, 0x3a3228, 0.5));
    const sun = new THREE.DirectionalLight(0xfff0d2, 1.1);
    sun.position.set(480, 720, 320);
    scene.add(sun);

    this._resize();
    this._placeCamera();

    const el = renderer.domElement;
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.display = 'block';
    el.tabIndex = 0;
    el.addEventListener('pointerdown', (ev) => {
      this._drag = true;
      el.setPointerCapture?.(ev.pointerId);
      el.focus?.();
    });
    el.addEventListener('keydown', this._onKey);
    el.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);

    const loop = () => {
      if (this._disposed || !this._renderer) return;
      this._raf = requestAnimationFrame(loop);
      this._stepMove();
      this._placeCamera();
      this._resize();
      renderer.render(scene, camera);
    };
    loop();
    this._mounting = false;
  }

  _eyeHeight() {
    const size = Number(canvas?.scene?.grid?.size) || 100;
    return size * LOOK_EYE_HEIGHT_GRID;
  }

  _placeCamera() {
    if (!this._camera || !this._data) return;
    const z = this._data.terrainZ(this._originX, this._originY) + this._eyeHeight();
    this._camera.position.set(this._originX, z, this._originY);
    const cy = Math.cos(this._pitch);
    const lx = this._originX + Math.sin(this._yaw) * cy * 100;
    const ly = z + Math.sin(this._pitch) * 100;
    const lz = this._originY + Math.cos(this._yaw) * cy * 100;
    this._camera.lookAt(lx, ly, lz);
  }

  _stepMove() {
    if (!this._keys.size || !this._data) return;
    const size = Number(canvas?.scene?.grid?.size) || 100;
    const speed = size * 0.18;
    let dx = 0;
    let dz = 0;
    if (this._keys.has('KeyW') || this._keys.has('ArrowUp')) {
      dx += Math.sin(this._yaw);
      dz += Math.cos(this._yaw);
    }
    if (this._keys.has('KeyS') || this._keys.has('ArrowDown')) {
      dx -= Math.sin(this._yaw);
      dz -= Math.cos(this._yaw);
    }
    if (this._keys.has('KeyA') || this._keys.has('ArrowLeft')) {
      dx -= Math.cos(this._yaw);
      dz += Math.sin(this._yaw);
    }
    if (this._keys.has('KeyD') || this._keys.has('ArrowRight')) {
      dx += Math.cos(this._yaw);
      dz -= Math.sin(this._yaw);
    }
    const len = Math.hypot(dx, dz) || 1;
    this._originX += (dx / len) * speed;
    this._originY += (dz / len) * speed;
  }

  _onMove(ev) {
    if (!this._drag) return;
    this._yaw -= ev.movementX * 0.005;
    this._pitch = Math.max(-1.2, Math.min(1.2, this._pitch - ev.movementY * 0.005));
  }

  _onUp() {
    this._drag = false;
  }

  _onKey(ev) {
    this._keys.add(ev.code);
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(ev.code)) {
      ev.preventDefault();
    }
  }

  _onKeyUp(ev) {
    this._keys.delete(ev.code);
  }

  _resize() {
    const host = this.element?.querySelector?.('[data-look-from-canvas]');
    if (!host || !this._renderer || !this._camera) return;
    const w = Math.max(64, host.clientWidth || 1);
    const h = Math.max(64, host.clientHeight || 1);
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  _teardown() {
    this._disposed = true;
    this._mounting = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    try {
      this._renderer?.domElement?.removeEventListener('keydown', this._onKey);
      this._renderer?.domElement?.removeEventListener('keyup', this._onKeyUp);
    } catch (_) {
      /* ignore */
    }
    this._visual?.dispose?.();
    this._visual = null;
    this._regions?.dispose?.();
    this._regions = null;
    try {
      this._renderer?.dispose?.();
      this._renderer?.domElement?.remove?.();
    } catch (_) {
      /* ignore */
    }
    this._renderer = null;
    this._scene = null;
    this._camera = null;
  }
}

/**
 * @param {object} opts
 */
export async function openLookFromPoint(opts) {
  const app = new TerrainLookFromApp(opts);
  await app.render({ force: true });
  return app;
}

import {
  CAMERA_FOV,
  CAMERA_TILT_RAD,
  MAX_RENDER_PIXEL_RATIO,
  OVERLAY_ID,
  TOKEN_SYNC_INTERVAL_MS,
  TOOLBAR_ID,
  TOOLS,
} from './terrain-const.mjs';
import { bakeTerrainAlbedo, createTerrainVisual } from './terrain-mesh.mjs';
import { createRegionMeshes } from './terrain-regions.mjs';
import { TerrainTokens } from './terrain-tokens.mjs';
import { TerrainEditor } from './terrain-editor.mjs';

function _t(key) {
  return game?.i18n?.localize ? game.i18n.localize(key) : String(key);
}

function viewCenterWorld(rect) {
  if (!rect || !canvas?.canvasCoordinatesFromClient) {
    return { x: canvas?.scene?.dimensions?.width / 2 || 0, y: canvas?.scene?.dimensions?.height / 2 || 0 };
  }
  return canvas.canvasCoordinatesFromClient({
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  });
}

function viewSizeWorld(rect) {
  const zoom = Number(canvas?.stage?.scale?.x) || 1;
  const w = (rect?.width || window.innerWidth) / zoom;
  const h = (rect?.height || window.innerHeight) / zoom;
  return { w, h };
}

/**
 * Three.js overlay: Skyrim-like top-down perspective over the Foundry board.
 */
export class TerrainView {
  constructor({ biomeResolver, getRegions, onLookFrom, onSave } = {}) {
    this.biomeResolver = biomeResolver;
    this.getRegions = typeof getRegions === 'function' ? getRegions : () => null;
    this.onLookFrom = typeof onLookFrom === 'function' ? onLookFrom : async () => {};
    this.onSave = typeof onSave === 'function' ? onSave : async () => {};

    this.data = null;
    this.editor = new TerrainEditor();
    this.enabled = false;

    this._THREE = null;
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._raycaster = null;
    this._pointer = null;
    this._visual = null;
    this._tokens = null;
    this._regions = null;
    this._cursor = null;
    this._raf = null;
    this._host = null;
    this._interfaceStack = null;
    this._toolbar = null;
    this._bakeSprite = null;

    this._draggingToken = null;
    this._panning = false;
    this._painting = false;
    this._lastPaint = null;
    this._lastClient = null;
    this._dragPreview = null;
    this._dragPointerId = null;
    this._tokenShield = null;
    this._hiddenMeshes = [];
    this._gridWasVisible = null;
    this._lastW = 0;
    this._lastH = 0;
    this._lastOverlayRect = null;
    this._lastCameraState = null;
    this._lastTokenSync = 0;
    this._renderDirty = true;
    this._resizeObs = null;
    this._toolbarPos = null;
    this._toolbarDrag = null;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onDragOver = this._onDragOver.bind(this);
    this._onDrop = this._onDrop.bind(this);
    this._onToolbar = this._onToolbar.bind(this);
  }

  async enable(THREE, data) {
    this._THREE = THREE;
    this.data = data;
    this.editor.biomeId = this.biomeResolver?.getDefaultBiomeId?.() ?? this.editor.biomeId;
    if (this.enabled) {
      await this.rebuild(data);
      return;
    }
    this.enabled = true;
    try {
      game.spaceholder?.globalMapTools?.deactivate?.();
    } catch (_) {
      /* ignore */
    }
    this._mountOverlay(THREE);
    this._buildScene(THREE, data);
    this._applyFoundryShield(true);
    this._hidePixiMap(true);
    this._bind();
    this._observeSize();
    this._loop();
  }

  async disable() {
    if (!this.enabled) return;
    this.enabled = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._unbind();
    this._unobserveSize();
    this._applyFoundryShield(false);
    this._hidePixiMap(false);
    this._teardownGl();
    this._removeOverlay();
  }

  async rebuild(data) {
    this.data = data;
    if (!this.enabled || !this._THREE) return;
    this._clearSceneContent();
    this._buildScene(this._THREE, data);
  }

  apply2dBake() {
    const renderer = game.spaceholder?.globalMapRenderer;
    if (!renderer || !this.data) return;
    try {
      const canvasEl = bakeTerrainAlbedo(this.data, this.biomeResolver, 1024);
      const tex = PIXI.Texture.from(canvasEl);
      const sprite = new PIXI.Sprite(tex);
      sprite.name = 'globalMapTerrainBake';
      sprite.position.set(this.data.bounds.minX, this.data.bounds.minY);
      sprite.width = this.data.worldWidth;
      sprite.height = this.data.worldHeight;
      if (this._bakeSprite) {
        try {
          this._bakeSprite.destroy({ texture: true, baseTexture: true });
        } catch (_) {
          /* ignore */
        }
      }
      this._bakeSprite = sprite;
      renderer.setTerrainBake?.(sprite);
    } catch (e) {
      console.warn('TerrainView | 2D bake failed', e);
    }
  }

  clear2dBake() {
    const renderer = game.spaceholder?.globalMapRenderer;
    renderer?.setTerrainBake?.(null);
    this._bakeSprite = null;
  }

  getViewHit(clientX, clientY) {
    if (!this._renderer || !this._camera || !this._visual) return null;
    const rect = this._renderer.domElement.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this._pointer.set(x, y);
    this._raycaster.setFromCamera(this._pointer, this._camera);
    const token = this._tokens?.pick(this._raycaster) ?? null;
    const hits = this._raycaster.intersectObject(this._visual.mesh, false);
    const terrain = hits[0] || null;
    return { token, terrain, ray: this._raycaster };
  }

  _mountOverlay(THREE) {
    let host = document.getElementById(OVERLAY_ID);
    const view = canvas?.app?.view;
    if (!host) {
      host = document.createElement('div');
      host.id = OVERLAY_ID;
      host.className = 'spaceholder-terrain3d-overlay';
    }
    const parent = view?.parentElement;
    const interfaceEl = document.getElementById('interface');
    if (interfaceEl) {
      this._interfaceStack = {
        element: interfaceEl,
        inlineZIndex: interfaceEl.style.zIndex,
      };
      interfaceEl.style.zIndex = '1';
      interfaceEl.prepend(host);
    }
    else if (parent) view.insertAdjacentElement('afterend', host);
    else document.body.appendChild(host);
    host.innerHTML = '';
    this._host = host;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x141820, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_RENDER_PIXEL_RATIO));
    if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'spaceholder-terrain3d-canvas';
    host.appendChild(renderer.domElement);
    this._renderer = renderer;
    this._scene = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 1, 800000);
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
  }

  _buildScene(THREE, data) {
    this._visual = createTerrainVisual(THREE, data, this.biomeResolver);
    this._scene.add(this._visual.mesh);

    const hemi = new THREE.HemisphereLight(0xc8d6e8, 0x3a3228, 0.55);
    this._scene.add(hemi);
    const cx = data.bounds.minX + data.worldWidth / 2;
    const cz = data.bounds.minY + data.worldHeight / 2;
    const sun = new THREE.DirectionalLight(0xfff0d2, 1.05);
    sun.position.set(cx + data.worldWidth * 0.4, Math.max(data.worldWidth, data.worldHeight) * 0.45, cz + data.worldHeight * 0.22);
    sun.target.position.set(cx, 0, cz);
    this._scene.add(sun);
    this._scene.add(sun.target);
    this._scene.add(new THREE.AmbientLight(0x8899aa, 0.28));

    this._tokens = new TerrainTokens(THREE, data);
    this._scene.add(this._tokens.group);
    this._tokens.sync();

    this._regions = createRegionMeshes(THREE, data, this.getRegions());
    this._scene.add(this._regions.group);

    const ring = new THREE.RingGeometry(0.85, 1, 48);
    ring.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xf2e6c9,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    this._cursor = new THREE.Mesh(ring, ringMat);
    this._cursor.renderOrder = 20;
    this._cursor.visible = false;
    this._scene.add(this._cursor);

    this._resize();
    this._syncCamera();
    this._renderDirty = true;
    this._renderToolbar();
  }

  _clearSceneContent() {
    this._visual?.dispose?.();
    this._visual = null;
    this._tokens?.dispose?.();
    this._tokens = null;
    this._regions?.dispose?.();
    this._regions = null;
    if (this._cursor) {
      this._cursor.geometry?.dispose?.();
      this._cursor.material?.dispose?.();
      this._scene?.remove(this._cursor);
      this._cursor = null;
    }
    this._scene?.clear();
  }

  _loop() {
    const tick = () => {
      if (!this.enabled) return;
      this._raf = requestAnimationFrame(tick);
      const resized = this._resize();
      const cameraChanged = this._syncCamera();
      const visualChanged = Boolean(this._visual?.flush?.());
      const now = performance.now();
      let tokensChanged = false;
      if (now - this._lastTokenSync >= TOKEN_SYNC_INTERVAL_MS) {
        this._tokens?.sync?.();
        this._lastTokenSync = now;
        tokensChanged = true;
      }
      if (resized || cameraChanged || visualChanged || tokensChanged || this._renderDirty) {
        this._renderer?.render(this._scene, this._camera);
        this._renderDirty = false;
      }
    };
    tick();
  }

  _syncCamera() {
    if (!this._camera || !this.data) return false;
    const center = viewCenterWorld(this._lastOverlayRect);
    const { h } = viewSizeWorld(this._lastOverlayRect);
    const fov = (CAMERA_FOV * Math.PI) / 180;
    const dist = Math.max(80, (h / 2) / Math.tan(fov / 2));
    const tilt = CAMERA_TILT_RAD;
    const x = center.x;
    const z = center.y;
    const groundY = this.data.terrainZ(x, z);
    const state = { x, z, groundY, dist };
    const prev = this._lastCameraState;
    if (
      prev
      && Math.abs(prev.x - state.x) < 0.01
      && Math.abs(prev.z - state.z) < 0.01
      && Math.abs(prev.groundY - state.groundY) < 0.01
      && Math.abs(prev.dist - state.dist) < 0.01
    ) return false;
    this._lastCameraState = state;
    this._camera.position.set(x, groundY + dist * Math.cos(tilt), z + dist * Math.sin(tilt));
    this._camera.lookAt(x, groundY, z);
    this._camera.near = Math.max(0.5, dist * 0.02);
    this._camera.far = Math.max(20000, dist * 40);
    this._camera.updateProjectionMatrix();
    return true;
  }

  _resize() {
    const rect = this._syncOverlayRect();
    const host = this._host;
    if (!host || !this._renderer || !this._camera) return false;
    const w = Math.max(64, rect?.width || host.clientWidth || 1);
    const h = Math.max(64, rect?.height || host.clientHeight || 1);
    if (this._lastW === w && this._lastH === h) return false;
    this._lastW = w;
    this._lastH = h;
    this._renderer.setSize(w, h, true);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
    return true;
  }

  _syncOverlayRect() {
    const host = this._host;
    const view = canvas?.app?.view;
    if (!host || !view) return null;
    const r = view.getBoundingClientRect();
    const rect = {
      left: Math.round(r.left * 100) / 100,
      top: Math.round(r.top * 100) / 100,
      width: Math.round(r.width * 100) / 100,
      height: Math.round(r.height * 100) / 100,
    };
    const prev = this._lastOverlayRect;
    if (
      prev
      && prev.left === rect.left
      && prev.top === rect.top
      && prev.width === rect.width
      && prev.height === rect.height
    ) return rect;
    this._lastOverlayRect = rect;
    host.style.position = 'fixed';
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    host.style.width = `${Math.max(1, rect.width)}px`;
    host.style.height = `${Math.max(1, rect.height)}px`;
    host.style.zIndex = '0';
    host.style.inset = 'auto';
    return rect;
  }

  _observeSize() {
    this._unobserveSize();
    const target = canvas?.app?.view || this._host;
    if (!target || typeof ResizeObserver !== 'function') return;
    this._resizeObs = new ResizeObserver(() => {
      this._lastW = 0;
      this._lastH = 0;
      this._resize();
    });
    this._resizeObs.observe(target);
  }

  _unobserveSize() {
    try {
      this._resizeObs?.disconnect?.();
    } catch (_) {
      /* ignore */
    }
    this._resizeObs = null;
  }

  _bind() {
    const el = this._renderer?.domElement;
    if (!el) return;
    el.addEventListener('pointerdown', this._onPointerDown);
    el.addEventListener('pointermove', this._onPointerMove);
    el.addEventListener('pointerup', this._onPointerUp);
    el.addEventListener('pointercancel', this._onPointerUp);
    el.addEventListener('pointerleave', this._onPointerUp);
    el.addEventListener('wheel', this._onWheel, { passive: false });
    el.addEventListener('dragenter', this._onDragOver);
    el.addEventListener('dragover', this._onDragOver);
    el.addEventListener('drop', this._onDrop);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _unbind() {
    const el = this._renderer?.domElement;
    if (!el) return;
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerup', this._onPointerUp);
    el.removeEventListener('pointercancel', this._onPointerUp);
    el.removeEventListener('pointerleave', this._onPointerUp);
    el.removeEventListener('wheel', this._onWheel);
    el.removeEventListener('dragenter', this._onDragOver);
    el.removeEventListener('dragover', this._onDragOver);
    el.removeEventListener('drop', this._onDrop);
  }

  _onPointerDown(ev) {
    ev.preventDefault();
    this._lastClient = { x: ev.clientX, y: ev.clientY };
    const hit = this.getViewHit(ev.clientX, ev.clientY);

    if (ev.button === 1) {
      this._panning = true;
      return;
    }

    if (ev.button === 0 && this.editor.tool === TOOLS.LOOK) {
      const p = hit?.terrain?.point;
      if (p) void this.onLookFrom({ x: p.x, y: p.z });
      return;
    }

    if (ev.button === 0 && this.editor.isSculptTool() && game.user?.isGM) {
      this._painting = true;
      this.editor.beginStroke(this.data);
      this._stampAt(hit);
      return;
    }

    if (hit?.token) {
      if (ev.button === 2) {
        hit.token._onClickRight?.(ev);
        this._tokens?.sync?.();
        this._renderDirty = true;
        return;
      }
      if (ev.button === 0) this._onTokenPointerDown(ev, hit.token);
      return;
    }

    if (ev.button === 2) {
      this._panning = true;
      return;
    }
    if (ev.button !== 0) return;

    canvas.tokens?.releaseAll?.();
    this._tokens?.sync?.();
    this._panning = true;
  }

  _onPointerMove(ev) {
    const hit = this._panning ? null : this.getViewHit(ev.clientX, ev.clientY);
    const hoverChanged = this._tokens?.setHovered?.(hit?.token?.id ?? null);
    if (this._renderer?.domElement) {
      this._renderer.domElement.style.cursor = hit?.token ? 'pointer' : '';
    }
    if (hoverChanged) this._renderDirty = true;
    this._updateCursor(hit);

    if (this._painting) {
      this._stampAt(hit);
      return;
    }

    if (this._draggingToken && hit?.terrain?.point) {
      const p = hit.terrain.point;
      const token = this._draggingToken;
      const w = Number(token.w) || 100;
      const hgt = Number(token.h) || 100;
      this._tokens?.previewMove(token.id, p.x, p.z);
      this._dragPreview = { x: p.x - w / 2, y: p.z - hgt / 2 };
      this._renderDirty = true;
      return;
    }

    if (this._panning && this._lastClient) {
      const zoom = Number(canvas?.stage?.scale?.x) || 1;
      const dx = (ev.clientX - this._lastClient.x) / zoom;
      const dy = (ev.clientY - this._lastClient.y) / zoom;
      const center = viewCenterWorld(this._lastOverlayRect);
      canvas.pan?.({ x: center.x - dx, y: center.y - dy });
    }
    this._lastClient = { x: ev.clientX, y: ev.clientY };
  }

  async _onPointerUp(ev) {
    const pointerEl = this._renderer?.domElement;
    if (
      ev.type === 'pointerleave'
      && this._dragPointerId != null
      && pointerEl?.hasPointerCapture?.(this._dragPointerId)
    ) return;

    if (this._painting) {
      this.editor.endStroke(this.data);
      this._painting = false;
      this._lastPaint = null;
      this._visual?.refreshHeights?.({ preview: false });
      this._renderToolbar();
    }
    const draggingToken = this._draggingToken;
    try {
      if (ev.type === 'pointerup' && draggingToken && this._dragPreview) {
        const pos = this._dragPreview;
        try {
          if (draggingToken.document.canUserModify?.(game.user, 'update')) {
            await draggingToken.document.update({ x: pos.x, y: pos.y });
          }
        } catch (e) {
          console.warn('TerrainView | token move failed', e);
        }
      }
    } finally {
      this._tokens?.endMove?.();
      this._tokens?.sync?.();
      this._renderDirty = true;
    }
    this._draggingToken = null;
    this._dragPreview = null;
    this._panning = false;
    this._lastClient = null;
    const el = this._renderer?.domElement;
    if (el && this._dragPointerId != null && el.hasPointerCapture?.(this._dragPointerId)) {
      try {
        el.releasePointerCapture(this._dragPointerId);
      } catch (_) {
        /* ignore */
      }
    }
    this._dragPointerId = null;
  }

  _onWheel(ev) {
    ev.preventDefault();
    const zoom = Number(canvas?.stage?.scale?.x) || 1;
    const factor = ev.deltaY > 0 ? 0.92 : 1.08;
    const next = Math.max(0.1, Math.min(8, zoom * factor));
    const center = viewCenterWorld(this._lastOverlayRect);
    canvas.pan?.({ x: center.x, y: center.y, scale: next });
  }

  _onTokenPointerDown(ev, token) {
    if (!token) return;
    if (ev.detail >= 2) {
      this._tokens?.endMove?.();
      this._draggingToken = null;
      this._dragPreview = null;
      token._onClickLeft2?.(ev);
      return;
    }

    if (game.activeTool === 'target') {
      void token.setTarget?.(!token.isTargeted, { releaseOthers: !ev.shiftKey });
      return;
    }

    if (ev.shiftKey && token.controlled) {
      token.release?.();
      this._tokens?.sync?.();
      this._renderDirty = true;
      return;
    }

    token.control?.({ releaseOthers: !ev.shiftKey });
    this._tokens?.sync?.();
    this._renderDirty = true;

    const canModify = Boolean(token.document?.canUserModify?.(game.user, 'update'));
    const canDrag = token._canDrag?.(game.user, ev) ?? canModify;
    if (!canModify || !canDrag) return;

    this._draggingToken = token;
    this._dragPreview = null;
    this._dragPointerId = ev.pointerId;
    this._tokens?.beginMove?.(token);
    try {
      this._renderer?.domElement?.setPointerCapture?.(ev.pointerId);
    } catch (_) {
      /* ignore */
    }
  }

  _onDragOver(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  }

  async _onDrop(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const point = this.getViewHit(ev.clientX, ev.clientY)?.terrain?.point;
    if (!point) return;

    let raw;
    try {
      raw = TextEditor.getDragEventData(ev);
    } catch (e) {
      console.warn('TerrainView | failed to read dropped data', e);
      return;
    }
    if (!raw || typeof raw !== 'object') return;

    const data = {
      ...raw,
      x: point.x,
      y: point.z,
      elevation: 0,
    };
    if (Hooks.call('dropCanvasData', canvas, data) === false) return;

    try {
      if (data.type === 'Actor') {
        await canvas.tokens?._onDropActorData?.(ev, data);
        this._tokens?.sync?.();
        this._renderDirty = true;
      }
    } catch (e) {
      console.warn('TerrainView | actor drop failed', e);
      ui.notifications?.error?.(e.message);
    }
  }

  _stampAt(hit) {
    const p = hit?.terrain?.point;
    if (!p || !this.data) return;
    if (this._lastPaint) {
      const dist = Math.hypot(p.x - this._lastPaint.x, p.z - this._lastPaint.y);
      const step = Math.max(8, this.editor.radius * 0.32);
      const n = Math.max(1, Math.ceil(dist / step));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const x = this._lastPaint.x + (p.x - this._lastPaint.x) * t;
        const y = this._lastPaint.y + (p.z - this._lastPaint.y) * t;
        this._applyStamp(x, y);
      }
    } else {
      this._applyStamp(p.x, p.z);
    }
    this._lastPaint = { x: p.x, y: p.z };
  }

  _applyStamp(x, y) {
    const changed = this.editor.stamp(this.data, x, y);
    if (changed.heights) this._visual?.markHeights();
    if (changed.splat) this._visual?.markSplat();
  }

  _updateCursor(hit) {
    if (!this._cursor) return;
    const p = hit?.terrain?.point;
    if (!p || !this.editor.isSculptTool()) {
      this._cursor.visible = false;
      this._renderDirty = true;
      return;
    }
    this._cursor.visible = true;
    this._cursor.position.set(p.x, p.y + 4, p.z);
    const r = this.editor.radius;
    this._cursor.scale.set(r, 1, r);
    this._renderDirty = true;
  }

  _applyFoundryShield(on) {
    const tokens = canvas?.tokens;
    if (!tokens) return;
    if (on) {
      this._tokenShield = {
        eventMode: tokens.eventMode,
        interactiveChildren: tokens.interactiveChildren,
      };
      tokens.eventMode = 'none';
      tokens.interactiveChildren = false;
      this._hiddenMeshes = [];
      for (const t of tokens.placeables ?? []) {
        const mesh = t.mesh;
        if (mesh) {
          this._hiddenMeshes.push({ mesh, visible: mesh.visible });
          mesh.visible = false;
        }
      }
      const grid = canvas.interface?.grid ?? canvas.grid;
      if (grid && 'visible' in grid) {
        this._gridWasVisible = grid.visible;
        grid.visible = false;
      }
    } else {
      if (this._tokenShield && tokens) {
        tokens.eventMode = this._tokenShield.eventMode;
        tokens.interactiveChildren = this._tokenShield.interactiveChildren;
      }
      for (const rec of this._hiddenMeshes) {
        if (rec.mesh) rec.mesh.visible = rec.visible;
      }
      const grid = canvas.interface?.grid ?? canvas.grid;
      if (grid && this._gridWasVisible != null) grid.visible = this._gridWasVisible;
      this._tokenShield = null;
      this._hiddenMeshes = [];
      this._gridWasVisible = null;
    }
  }

  _hidePixiMap(hide) {
    const r = game.spaceholder?.globalMapRenderer;
    if (r?.container) r.container.visible = !hide;
  }

  _renderToolbar() {
    let bar = this._toolbar;
    if (!bar || !bar.isConnected) {
      bar = document.getElementById(TOOLBAR_ID);
      if (!bar) {
        bar = document.createElement('div');
        bar.id = TOOLBAR_ID;
        bar.className = 'spaceholder-terrain3d-toolbar';
        document.body.appendChild(bar);
        bar.addEventListener('click', this._onToolbar);
        bar.addEventListener('input', this._onToolbar);
        bar.addEventListener('change', this._onToolbar);
        bar.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          if (e.target.closest?.('[data-drag-handle]')) this._beginToolbarDrag(e);
        });
        bar.addEventListener('wheel', (e) => e.stopPropagation());
      }
    }
    this._toolbar = bar;
    this._applyToolbarPos();
    const isGM = Boolean(game.user?.isGM);
    const tool = this.editor.tool;
    const biomes = this.biomeResolver?.listBiomes?.() ?? [];
    const toolBtn = (id, icon, labelKey) => `
      <button type="button" class="icon-btn${tool === id ? ' is-active' : ''}" data-tool="${id}"
        data-tooltip="${_t(labelKey)}" aria-label="${_t(labelKey)}">
        <i class="fa-solid ${icon}" aria-hidden="true"></i>
      </button>`;

    bar.innerHTML = `
      <div class="spaceholder-terrain3d-toolbar__drag" data-drag-handle title="${_t('SPACEHOLDER.GlobalMap.Terrain3d.Tools.Drag')}">
        <i class="fa-solid fa-grip-lines" aria-hidden="true"></i>
        <span>${_t('SPACEHOLDER.GlobalMap.Terrain3d.Tools.Hint')}</span>
      </div>
      <div class="spaceholder-terrain3d-toolbar__row" role="group">
        ${toolBtn(TOOLS.SELECT, 'fa-arrow-pointer', 'SPACEHOLDER.GlobalMap.Terrain3d.Tools.Select')}
        ${toolBtn(TOOLS.LOOK, 'fa-eye', 'SPACEHOLDER.GlobalMap.Terrain3d.Tools.Look')}
        ${isGM ? toolBtn(TOOLS.RAISE, 'fa-arrow-up', 'SPACEHOLDER.GlobalMap.Terrain3d.Tools.Raise') : ''}
        ${isGM ? toolBtn(TOOLS.LOWER, 'fa-arrow-down', 'SPACEHOLDER.GlobalMap.Terrain3d.Tools.Lower') : ''}
        ${isGM ? toolBtn(TOOLS.SMOOTH, 'fa-water', 'SPACEHOLDER.GlobalMap.Terrain3d.Tools.Smooth') : ''}
        ${isGM ? toolBtn(TOOLS.FLATTEN, 'fa-minus', 'SPACEHOLDER.GlobalMap.Terrain3d.Tools.Flatten') : ''}
        ${isGM ? toolBtn(TOOLS.NOISE, 'fa-burst', 'SPACEHOLDER.GlobalMap.Terrain3d.Tools.Noise') : ''}
        ${isGM ? toolBtn(TOOLS.PAINT, 'fa-brush', 'SPACEHOLDER.GlobalMap.Terrain3d.Tools.Paint') : ''}
      </div>
      ${isGM ? `
      <div class="spaceholder-terrain3d-toolbar__row">
        <label>${_t('SPACEHOLDER.GlobalMap.Terrain3d.Tools.Radius')}
          <input type="range" min="20" max="800" step="10" data-field="radius" value="${this.editor.radius}">
        </label>
        <label>${_t('SPACEHOLDER.GlobalMap.Terrain3d.Tools.Strength')}
          <input type="range" min="0.05" max="1" step="0.05" data-field="strength" value="${this.editor.strength}">
        </label>
        <label>${_t('SPACEHOLDER.GlobalMap.Terrain3d.Tools.FlattenTo')}
          <input type="number" min="0" max="100" step="1" data-field="targetHeight" value="${this.editor.targetHeight}">
        </label>
        <label>${_t('SPACEHOLDER.GlobalMap.Terrain3d.Tools.Biome')}
          <select data-field="biomeId">
            ${biomes.map((b) => `<option value="${b.id}" ${Number(this.editor.biomeId) === Number(b.id) ? 'selected' : ''}>${b.name}</option>`).join('')}
          </select>
        </label>
        <button type="button" class="spaceholder-terrain3d-toolbar__textBtn" data-action="undo" ${this.editor.canUndo ? '' : 'disabled'}>${_t('SPACEHOLDER.Actions.Undo')}</button>
        <button type="button" class="spaceholder-terrain3d-toolbar__textBtn" data-action="redo" ${this.editor.canRedo ? '' : 'disabled'}>${_t('SPACEHOLDER.Actions.Redo')}</button>
        <button type="button" class="spaceholder-terrain3d-toolbar__textBtn" data-action="save">${_t('SPACEHOLDER.GlobalMap.Terrain3d.Tools.Save')}</button>
      </div>` : ''}
    `;
  }

  _onToolbar(ev) {
    const toolBtn = ev.target.closest?.('[data-tool]');
    if (toolBtn) {
      ev.preventDefault();
      this.editor.tool = toolBtn.dataset.tool;
      this._renderToolbar();
      return;
    }
    const actionBtn = ev.target.closest?.('[data-action]');
    if (actionBtn) {
      ev.preventDefault();
      const action = actionBtn.dataset.action;
      if (action === 'undo') {
        if (this.editor.undo(this.data)) this._visual?.refreshHeights?.({ preview: false });
      } else if (action === 'redo') {
        if (this.editor.redo(this.data)) this._visual?.refreshHeights?.({ preview: false });
      } else if (action === 'save') {
        void this.onSave();
      }
      this._renderToolbar();
      return;
    }
    const field = ev.target?.dataset?.field;
    if (!field) return;
    if (field === 'radius') this.editor.radius = Number(ev.target.value) || this.editor.radius;
    if (field === 'strength') this.editor.strength = Number(ev.target.value) || this.editor.strength;
    if (field === 'targetHeight') this.editor.targetHeight = Number(ev.target.value) || this.editor.targetHeight;
    if (field === 'biomeId') this.editor.biomeId = Number(ev.target.value) || this.editor.biomeId;
  }

  _applyToolbarPos() {
    const bar = this._toolbar;
    if (!bar) return;
    if (!this._toolbarPos) {
      bar.classList.remove('is-moved');
      bar.style.left = '';
      bar.style.top = '';
      return;
    }
    bar.classList.add('is-moved');
    bar.style.left = `${this._toolbarPos.left}px`;
    bar.style.top = `${this._toolbarPos.top}px`;
  }

  _beginToolbarDrag(ev) {
    const bar = this._toolbar;
    if (!bar || ev.button !== 0) return;
    ev.preventDefault();
    const rect = bar.getBoundingClientRect();
    this._toolbarDrag = {
      dx: ev.clientX - rect.left,
      dy: ev.clientY - rect.top,
    };
    bar.classList.add('is-dragging');
    this._onToolbarDragMove = (e) => {
      const pos = this._toolbarDrag;
      if (!pos) return;
      const left = Math.max(8, Math.min(window.innerWidth - 80, e.clientX - pos.dx));
      const top = Math.max(8, Math.min(window.innerHeight - 40, e.clientY - pos.dy));
      this._toolbarPos = { left, top };
      this._applyToolbarPos();
    };
    this._onToolbarDragUp = () => {
      bar.classList.remove('is-dragging');
      window.removeEventListener('pointermove', this._onToolbarDragMove);
      window.removeEventListener('pointerup', this._onToolbarDragUp);
      this._toolbarDrag = null;
    };
    window.addEventListener('pointermove', this._onToolbarDragMove);
    window.addEventListener('pointerup', this._onToolbarDragUp);
  }

  _teardownGl() {
    this._clearSceneContent();
    try {
      this._renderer?.dispose?.();
      this._renderer?.domElement?.remove?.();
    } catch (_) {
      /* ignore */
    }
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._lastW = 0;
    this._lastH = 0;
    this._lastOverlayRect = null;
    this._lastCameraState = null;
    this._lastTokenSync = 0;
    this._renderDirty = true;
  }

  _removeOverlay() {
    this._host?.remove?.();
    this._host = null;
    const interfaceStack = this._interfaceStack;
    if (interfaceStack?.element?.style?.zIndex === '1') {
      interfaceStack.element.style.zIndex = interfaceStack.inlineZIndex;
    }
    this._interfaceStack = null;
    this._toolbar?.remove?.();
    this._toolbar = null;
  }
}

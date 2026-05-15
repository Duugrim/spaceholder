import { sanitizePosition3d } from "../anatomy-manager.mjs";

/** @type {Promise<typeof import('../vendor/three.module.mjs')>|null} */
let _threeLoadPromise = null;

function loadThree() {
  if (!_threeLoadPromise) _threeLoadPromise = import("../vendor/three.module.mjs");
  return _threeLoadPromise;
}

/**
 * @param {string} status
 * @returns {number}
 */
function statusToColorHex(status) {
  const s = String(status ?? "healthy").toLowerCase();
  switch (s) {
    case "bruised":
      return 0xffc107;
    case "injured":
      return 0xff9800;
    case "badly_injured":
      return 0xff6b6b;
    case "destroyed":
      return 0xc084fc;
    case "missing":
      return 0x90a4ae;
    default:
      return 0x6b9b6b;
  }
}

/**
 * @param {string} slotRef
 * @returns {number}
 */
function hashJiggle01(slotRef) {
  const s = String(slotRef ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

/**
 * Опциональные координаты для 3D-просмотра вкладки «Здоровье» (Three.js: X вправо, Y вверх, Z глубина).
 * Если заданы все три компонента и они конечные числа — позиция сферы в 3D берётся отсюда; иначе — эвристика из сеточных `x`/`y`.
 * @param {Record<string, object>} bodyParts
 * @param {{ width?: number, height?: number }} grid
 * @returns {Record<string, { x: number, y: number, z: number }>}
 */
export function computeAnatomy3DLayout(bodyParts, grid) {
  const parts = bodyParts && typeof bodyParts === "object" ? bodyParts : {};
  const w = Math.max(1, parseInt(String(grid?.width ?? 9), 10) || 9);
  const h = Math.max(1, parseInt(String(grid?.height ?? 10), 10) || 10);
  const cell = 0.62;
  const centerX = (w - 1) / 2;
  const centerZ = (h - 1) / 2;

  /** @type {Map<string, string|null>} */
  const parentBySlot = new Map();
  for (const [slotRef, part] of Object.entries(parts)) {
    const rels = Array.isArray(part?.relations) ? part.relations : [];
    const parent = rels.find((r) => r && String(r.kind) === "parent" && String(r.target ?? "").trim());
    parentBySlot.set(slotRef, parent ? String(parent.target).trim() || null : null);
  }

  /** @type {Map<string, number>} */
  const depthMemo = new Map();
  function depthFor(slotRef) {
    if (depthMemo.has(slotRef)) return /** @type {number} */ (depthMemo.get(slotRef));
    const p = parentBySlot.get(slotRef);
    if (!p || !parts[p]) {
      depthMemo.set(slotRef, 0);
      return 0;
    }
    const d = 1 + depthFor(p);
    depthMemo.set(slotRef, d);
    return d;
  }

  /** @type {Record<string, { x: number, y: number, z: number }>} */
  const out = {};
  const buckets = new Map();
  for (const slotRef of Object.keys(parts)) {
    const part = parts[slotRef];
    const manual = sanitizePosition3d(part.position3d);
    if (manual) {
      out[slotRef] = { x: manual.x, y: manual.y, z: manual.z };
      continue;
    }
    const gx = Number(part?.x ?? 0);
    const gy = Number(part?.y ?? 0);
    const key = `${Math.trunc(gx)},${Math.trunc(gy)}`;
    const n = buckets.get(key) ?? 0;
    buckets.set(key, n + 1);
    const j = hashJiggle01(slotRef);
    const spread = (n * 0.22 + j * 0.12) * (n % 2 === 0 ? 1 : -1);
    const wx = (gx - centerX) * cell + spread;
    const wz = (gy - centerZ) * cell + spread * 0.6;
    const dep = depthFor(slotRef);
    const internal = Boolean(part?.internal);
    const wy = (h - gy - 0.5) * cell * 0.95 + dep * 0.18 + (internal ? 0.12 : 0);
    out[slotRef] = { x: wx, y: wy, z: wz };
  }
  return out;
}

export class AnatomyEditor3D {
  /**
   * @param {HTMLElement|null} container
   * @param {object} [options]
   * @param {Actor|null} [options.actor]
   * @param {() => string|null} [options.getSelectedPartId]
   * @param {(slotRef: string) => void} [options.onSelectPartId]
   */
  constructor(container, options = {}) {
    this.container = container;
    this.actor = options.actor ?? null;
    this.getSelectedPartId =
      typeof options.getSelectedPartId === "function" ? options.getSelectedPartId : () => null;
    this.onSelectPartId =
      typeof options.onSelectPartId === "function" ? options.onSelectPartId : () => {};

    /** @type {Awaited<ReturnType<typeof loadThree>>|null} */
    this._THREE = null;
    this._scene = null;
    this._camera = null;
    this._renderer = null;
    /** @type {number|null} */
    this._raf = null;
    this._ro = null;

    /** @type {Map<string, import('three').Mesh>} */
    this._meshes = new Map();

    this._target = null;
    this._radius = 11;
    this._theta = 0.55;
    this._phi = 1.05;
    this._lastSel = null;

    this._drag = false;
    this._dragMoved = false;
    this._ptrDown = { x: 0, y: 0, id: -1 };

    this._disposed = false;
    /** @type {Promise<void>|null} */
    this._mountPromise = null;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
  }

  setActor(actor) {
    this.actor = actor;
    void this.refresh();
  }

  dispose() {
    this._disposed = true;
    if (this._raf != null) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    try {
      this._ro?.disconnect();
    } catch (_) {
      /* ignore */
    }
    this._ro = null;

    if (this._renderer) {
      try {
        this._renderer.domElement.removeEventListener("pointerdown", this._onPointerDown);
        this._renderer.domElement.removeEventListener("pointermove", this._onPointerMove);
        this._renderer.domElement.removeEventListener("pointerup", this._onPointerUp);
        this._renderer.domElement.removeEventListener("pointercancel", this._onPointerUp);
        this._renderer.domElement.removeEventListener("wheel", this._onWheel);
      } catch (_) {
        /* ignore */
      }
      try {
        this._renderer.dispose();
      } catch (_) {
        /* ignore */
      }
      try {
        this._renderer.domElement.remove();
      } catch (_) {
        /* ignore */
      }
      this._renderer = null;
    }

    if (this._scene) {
      this._scene.traverse((obj) => {
        const m = /** @type {import('three').Mesh} */ (obj);
        if (m?.geometry) m.geometry.dispose();
        const mat = m?.material;
        if (Array.isArray(mat)) mat.forEach((mm) => mm?.dispose?.());
        else mat?.dispose?.();
      });
      this._scene = null;
    }
    this._camera = null;
    this._meshes.clear();
    this._THREE = null;
    this._mountPromise = null;
  }

  /**
   * @returns {Promise<boolean>} true if 3D view is usable (including empty anatomy without WebGL); false → use 2D fallback
   */
  async refresh() {
    if (this._disposed || !this.container) return false;
    if (this._mountPromise) {
      try {
        await this._mountPromise;
      } catch (_) {
        /* ignore */
      }
    }
    let ok = false;
    try {
      this._mountPromise = this._mountInternal();
      ok = await this._mountPromise;
    } catch (e) {
      console.warn("SpaceHolder | AnatomyEditor3D refresh failed", e);
      this._teardownGl();
      ok = false;
    } finally {
      this._mountPromise = null;
    }
    return ok;
  }

  /**
   * @private
   * @returns {Promise<boolean>}
   */
  async _mountInternal() {
    const bodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const keys = Object.keys(bodyParts);
    this.container.innerHTML = "";
    this.container.classList.add("spaceholder-anatomy-3d");

    if (!keys.length) {
      const empty = document.createElement("div");
      empty.className = "spaceholder-anatomy-3d-empty";
      empty.textContent =
        typeof game !== "undefined"
          ? game.i18n?.localize?.("SPACEHOLDER.Health.Anatomy3d.Empty") ?? "—"
          : "—";
      this.container.appendChild(empty);
      this._teardownGl();
      return true;
    }

    const THREE = await loadThree();
    if (this._disposed || !this.container) return false;
    this._THREE = THREE;

    try {
      const grid = this.actor?.system?.health?.anatomyGrid ?? {};
      const layout = computeAnatomy3DLayout(bodyParts, grid);

      if (!this._renderer) {
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        const gl = renderer.getContext?.();
        if (!gl) {
          try {
            renderer.dispose();
          } catch (_) {
            /* ignore */
          }
          return false;
        }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        if ("outputColorSpace" in renderer && THREE.SRGBColorSpace) {
          renderer.outputColorSpace = THREE.SRGBColorSpace;
        }
        renderer.setClearColor(0x000000, 0);
        this.container.appendChild(renderer.domElement);
        renderer.domElement.classList.add("spaceholder-anatomy-3d-canvas");
        this._renderer = renderer;

        renderer.domElement.addEventListener("pointerdown", this._onPointerDown);
        renderer.domElement.addEventListener("pointermove", this._onPointerMove);
        renderer.domElement.addEventListener("pointerup", this._onPointerUp);
        renderer.domElement.addEventListener("pointercancel", this._onPointerUp);
        renderer.domElement.addEventListener("wheel", this._onWheel, { passive: false });

        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(this.container);
      }

      if (!this._scene) this._scene = new THREE.Scene();
      if (!this._camera) this._camera = new THREE.PerspectiveCamera(42, 1, 0.08, 200);

      while (this._scene.children.length) this._scene.remove(this._scene.children[0]);
      this._meshes.clear();

      const amb = new THREE.AmbientLight(0xffffff, 0.55);
      const dir = new THREE.DirectionalLight(0xffffff, 0.85);
      dir.position.set(4, 10, 6);
      this._scene.add(amb, dir);

      let maxY = 0;
      let minY = 0;
      let maxXZ = 0;
      for (const pos of Object.values(layout)) {
        maxY = Math.max(maxY, pos.y);
        minY = Math.min(minY, pos.y);
        maxXZ = Math.max(maxXZ, Math.hypot(pos.x, pos.z));
      }
      const centerY = (maxY + minY) * 0.5;
      this._target = new THREE.Vector3(0, centerY, 0);
      this._radius = Math.max(7, maxXZ * 2.2 + 4, (maxY - minY) * 2.4 + 3);

      for (const slotRef of keys) {
        const part = bodyParts[slotRef];
        const pos = layout[slotRef] ?? { x: 0, y: centerY, z: 0 };
        const col = statusToColorHex(part?.status);
        const geom = new THREE.SphereGeometry(0.38, 22, 18);
        const mat = new THREE.MeshStandardMaterial({
          color: col,
          metalness: 0.12,
          roughness: 0.55,
          emissive: 0x000000,
          emissiveIntensity: 0.9,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(pos.x, pos.y, pos.z);
        mesh.userData.slotRef = slotRef;
        this._scene.add(mesh);
        this._meshes.set(slotRef, mesh);
      }

      this._resize();
      this._updateCamera();
      this._syncSelectionMaterial();
      this._startLoop();
      return true;
    } catch (e) {
      console.warn("SpaceHolder | AnatomyEditor3D mount failed", e);
      this._teardownGl();
      return false;
    }
  }

  _teardownGl() {
    if (this._raf != null) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    if (this._renderer) {
      try {
        this._renderer.domElement.removeEventListener("pointerdown", this._onPointerDown);
        this._renderer.domElement.removeEventListener("pointermove", this._onPointerMove);
        this._renderer.domElement.removeEventListener("pointerup", this._onPointerUp);
        this._renderer.domElement.removeEventListener("pointercancel", this._onPointerUp);
        this._renderer.domElement.removeEventListener("wheel", this._onWheel);
      } catch (_) {
        /* ignore */
      }
      try {
        this._renderer.dispose();
      } catch (_) {
        /* ignore */
      }
      try {
        this._renderer.domElement.remove();
      } catch (_) {
        /* ignore */
      }
      this._renderer = null;
    }
    try {
      this._ro?.disconnect();
    } catch (_) {
      /* ignore */
    }
    this._ro = null;
    if (this._scene) {
      this._scene.traverse((obj) => {
        const m = /** @type {import('three').Mesh} */ (obj);
        if (m?.geometry) m.geometry.dispose();
        const mat = m?.material;
        if (Array.isArray(mat)) mat.forEach((mm) => mm?.dispose?.());
        else mat?.dispose?.();
      });
      this._scene = null;
    }
    this._camera = null;
    this._meshes.clear();
  }

  _startLoop() {
    if (this._raf != null) return;
    const tick = () => {
      if (this._disposed) return;
      this._raf = requestAnimationFrame(tick);
      this._syncSelectionMaterial();
      if (this._renderer && this._scene && this._camera) {
        this._renderer.render(this._scene, this._camera);
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  _syncSelectionMaterial() {
    const sel = this.getSelectedPartId?.() ?? null;
    if (sel === this._lastSel) return;
    this._lastSel = sel;
    const THREE = this._THREE;
    if (!THREE) return;
    for (const [ref, mesh] of this._meshes) {
      const mat = /** @type {import('three').MeshStandardMaterial} */ (mesh.material);
      const part = this.actor?.system?.health?.bodyParts?.[ref];
      const base = statusToColorHex(part?.status);
      if (ref === sel) {
        mat.emissive = new THREE.Color(0xffc44d);
        mat.emissiveIntensity = 0.55;
      } else {
        mat.emissive = new THREE.Color(0x000000);
        mat.emissiveIntensity = 0.9;
      }
      mat.color = new THREE.Color(base);
    }
  }

  _updateCamera() {
    if (!this._camera || !this._target || !this._THREE) return;
    const phi = Math.min(Math.PI - 0.12, Math.max(0.12, this._phi));
    const sinPhi = Math.sin(phi);
    const x = this._target.x + this._radius * sinPhi * Math.cos(this._theta);
    const y = this._target.y + this._radius * Math.cos(phi);
    const z = this._target.z + this._radius * sinPhi * Math.sin(this._theta);
    this._camera.position.set(x, y, z);
    this._camera.lookAt(this._target);
    this._camera.updateProjectionMatrix();
  }

  _resize() {
    if (!this._renderer || !this._camera || !this.container) return;
    const w = Math.max(1, this.container.clientWidth | 0);
    const h = Math.max(1, this.container.clientHeight | 0);
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  _onPointerDown(ev) {
    if (!this._renderer) return;
    this._drag = true;
    this._dragMoved = false;
    this._ptrDown = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    try {
      this._renderer.domElement.setPointerCapture(ev.pointerId);
    } catch (_) {
      /* ignore */
    }
  }

  _onPointerMove(ev) {
    if (!this._drag) return;
    const dx = ev.clientX - this._ptrDown.x;
    const dy = ev.clientY - this._ptrDown.y;
    if (Math.hypot(dx, dy) > 4) this._dragMoved = true;
    // +dx when dragging right → orbit matches screen motion (was inverted with -=)
    this._theta += dx * 0.0065;
    this._phi -= dy * 0.0065;
    this._ptrDown = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    this._updateCamera();
  }

  _onPointerUp(ev) {
    if (!this._renderer) return;
    try {
      this._renderer.domElement.releasePointerCapture(ev.pointerId);
    } catch (_) {
      /* ignore */
    }
    const wasDrag = this._dragMoved;
    this._drag = false;
    this._dragMoved = false;
    if (wasDrag) return;
    this._pick(ev);
  }

  _onWheel(ev) {
    if (!this._renderer) return;
    ev.preventDefault();
    const k = Math.exp(-ev.deltaY * 0.0012);
    this._radius = Math.min(48, Math.max(3.5, this._radius * k));
    this._updateCamera();
  }

  /**
   * @param {PointerEvent} ev
   */
  _pick(ev) {
    const THREE = this._THREE;
    if (!THREE || !this._camera || !this._scene || !this._renderer) return;
    const rect = this._renderer.domElement.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const y = -(((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera({ x, y }, this._camera);
    const hits = raycaster.intersectObjects(Array.from(this._meshes.values()), false);
    const first = hits[0]?.object;
    const ref = first?.userData?.slotRef;
    if (ref) this.onSelectPartId(String(ref));
  }
}

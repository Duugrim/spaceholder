import { HEIGHT_MAX, HEIGHT_MIN, SPLAT_LAYERS, TOOLS, UNDO_MAX } from './terrain-const.mjs';

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1274126177) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function kernel(dx, dy, radius) {
  const d2 = dx * dx + dy * dy;
  const r2 = radius * radius;
  if (d2 >= r2 || r2 <= 0) return 0;
  const n = d2 / r2;
  return Math.exp(-3 * n) * (1 - n);
}

function addSplatWeight(ids, weights, base, biomeId, amount) {
  const id = clamp(biomeId, 0, 255);
  const add = amount;
  if (add <= 0) return false;
  let slot = -1;
  for (let k = 0; k < SPLAT_LAYERS; k++) {
    if (ids[base + k] === id) {
      slot = k;
      break;
    }
  }
  if (slot < 0) {
    slot = 0;
    for (let k = 1; k < SPLAT_LAYERS; k++) {
      if (weights[base + k] < weights[base + slot]) slot = k;
    }
    ids[base + slot] = id;
    weights[base + slot] = 0;
  }
  weights[base + slot] = clamp(weights[base + slot] + add, 0, 255);
  let sum = 0;
  for (let k = 0; k < SPLAT_LAYERS; k++) sum += weights[base + k];
  if (sum <= 0) {
    weights[base] = 255;
    return true;
  }
  let written = 0;
  for (let k = 0; k < SPLAT_LAYERS - 1; k++) {
    weights[base + k] = Math.round((weights[base + k] / sum) * 255);
    written += weights[base + k];
  }
  weights[base + SPLAT_LAYERS - 1] = clamp(255 - written, 0, 255);
  return true;
}

/**
 * Sculpt + splat brushes on TerrainData sample buffers.
 */
export class TerrainEditor {
  constructor() {
    this.tool = TOOLS.SELECT;
    this.radius = 180;
    this.strength = 0.45;
    this.targetHeight = 50;
    this.biomeId = 17;
    this._undo = [];
    this._redo = [];
    this._strokeSnap = null;
    this._strokeChanged = false;
    this._noiseSeed = 1;
  }

  get canUndo() {
    return this._undo.length > 0;
  }

  get canRedo() {
    return this._redo.length > 0;
  }

  isSculptTool() {
    return this.tool !== TOOLS.SELECT && this.tool !== TOOLS.LOOK;
  }

  beginStroke(data) {
    if (!data) return;
    this._strokeSnap = data.cloneBuffers();
    this._strokeChanged = false;
    this._noiseSeed = (Date.now() ^ (Math.random() * 1e9)) >>> 0;
  }

  endStroke(data) {
    if (!data || !this._strokeSnap || !this._strokeChanged) {
      this._strokeSnap = null;
      this._strokeChanged = false;
      return false;
    }
    this._undo.push(this._strokeSnap);
    if (this._undo.length > UNDO_MAX) this._undo.shift();
    this._redo.length = 0;
    this._strokeSnap = null;
    this._strokeChanged = false;
    data.dirty = true;
    return true;
  }

  undo(data) {
    if (!data || !this._undo.length) return false;
    const snap = this._undo.pop();
    this._redo.push(data.cloneBuffers());
    data.restoreBuffers(snap);
    return true;
  }

  redo(data) {
    if (!data || !this._redo.length) return false;
    const snap = this._redo.pop();
    this._undo.push(data.cloneBuffers());
    data.restoreBuffers(snap);
    return true;
  }

  /**
   * Apply a brush stamp at Foundry world (x, y).
   * @returns {{ heights: boolean, splat: boolean }}
   */
  stamp(data, worldX, worldY) {
    const changed = { heights: false, splat: false };
    if (!data || !this.isSculptTool()) return changed;

    const radius = Math.max(8, this.radius);
    const { u, v } = data.worldToUv(worldX, worldY);
    const cx = u * (data.samplesW - 1);
    const cy = v * (data.samplesH - 1);
    const rx = (radius / data.worldWidth) * (data.samplesW - 1);
    const ry = (radius / data.worldHeight) * (data.samplesH - 1);
    const rad = Math.max(rx, ry);
    const x0 = Math.max(0, Math.floor(cx - rad - 1));
    const x1 = Math.min(data.samplesW - 1, Math.ceil(cx + rad + 1));
    const y0 = Math.max(0, Math.floor(cy - rad - 1));
    const y1 = Math.min(data.samplesH - 1, Math.ceil(cy + rad + 1));

    const source = this._strokeSnap?.heights ?? data.heights;
    const kStrength = clamp(this.strength, 0.02, 1);

    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const dx = ((ix - cx) / Math.max(rx, 1e-3)) * radius;
        const dy = ((iy - cy) / Math.max(ry, 1e-3)) * radius;
        const k = kernel(dx, dy, radius);
        if (k <= 0) continue;
        const idx = iy * data.samplesW + ix;

        if (this.tool === TOOLS.PAINT) {
          const base = idx * SPLAT_LAYERS;
          if (addSplatWeight(data.splatIds, data.splatWeights, base, this.biomeId, Math.round(k * kStrength * 90))) {
            changed.splat = true;
          }
          continue;
        }

        let h = data.heights[idx];
        if (this.tool === TOOLS.RAISE) {
          h += k * kStrength * 18;
        } else if (this.tool === TOOLS.LOWER) {
          h -= k * kStrength * 18;
        } else if (this.tool === TOOLS.FLATTEN) {
          h += (this.targetHeight - h) * k * kStrength;
        } else if (this.tool === TOOLS.NOISE) {
          h += (hash2(ix, iy, this._noiseSeed) * 2 - 1) * k * kStrength * 7;
        } else if (this.tool === TOOLS.SMOOTH) {
          let acc = 0;
          let n = 0;
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              const nx = clamp(ix + ox, 0, data.samplesW - 1);
              const ny = clamp(iy + oy, 0, data.samplesH - 1);
              acc += source[ny * data.samplesW + nx];
              n += 1;
            }
          }
          const avg = acc / n;
          h += (avg - h) * k * Math.min(1, kStrength * 1.4);
        }
        const next = clamp(h, HEIGHT_MIN, HEIGHT_MAX);
        if (next !== data.heights[idx]) {
          data.heights[idx] = next;
          changed.heights = true;
        }
      }
    }

    if (changed.heights || changed.splat) {
      this._strokeChanged = true;
      data.dirty = true;
    }
    return changed;
  }
}

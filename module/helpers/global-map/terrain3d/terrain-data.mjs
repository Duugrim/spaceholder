import {
  DEFAULT_SAMPLES,
  FLAG_TERRAIN_PATH,
  HEIGHT_MAX,
  HEIGHT_MIN,
  MAX_SAMPLES,
  MODULE_NS,
  SPLAT_LAYERS,
  TERRAIN_VERSION,
  VIEW_HEIGHT_EXAGGERATION,
} from './terrain-const.mjs';

function _t(key) {
  return game?.i18n?.localize ? game.i18n.localize(key) : String(key);
}

function _f(key, data) {
  return game?.i18n?.format ? game.i18n.format(key, data) : String(key);
}

function _fp() {
  return foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function sceneBounds(scene) {
  const d = scene?.dimensions;
  const w = Number(d?.width) || Number(scene?.width) || 4000;
  const h = Number(d?.height) || Number(scene?.height) || 4000;
  return { minX: 0, minY: 0, maxX: w, maxY: h };
}

function defaultVerticalScale(bounds) {
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  return (Math.min(bw, bh) * 0.22) / HEIGHT_MAX;
}

function computeSampleSize(bounds, requested = DEFAULT_SAMPLES) {
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const aspect = bw / bh;
  const cap = Math.min(MAX_SAMPLES, Math.max(32, Math.round(requested)));
  let w;
  let h;
  if (aspect >= 1) {
    w = cap;
    h = Math.max(32, Math.round(cap / aspect));
  } else {
    h = cap;
    w = Math.max(32, Math.round(cap * aspect));
  }
  w -= w % 2;
  h -= h % 2;
  return { samplesW: Math.max(32, w), samplesH: Math.max(32, h) };
}

function encodeSplatSolid(samplesW, samplesH, biomeId) {
  const n = samplesW * samplesH * SPLAT_LAYERS;
  const ids = new Uint8Array(n);
  const weights = new Uint8Array(n);
  const id = clamp(biomeId | 0, 0, 255);
  for (let i = 0; i < samplesW * samplesH; i++) {
    const b = i * SPLAT_LAYERS;
    ids[b] = id;
    weights[b] = 255;
  }
  return { splatIds: ids, splatWeights: weights };
}

function smoothstep01(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function blurHeights(src, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  const sigma = Math.max(0.6, r / 2.4);
  const kernel = new Float32Array(r * 2 + 1);
  let ksum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + r] = v;
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[y * w + clamp(x + k, 0, w - 1)] * kernel[k + r];
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[clamp(y + k, 0, h - 1) * w + x] * kernel[k + r];
      out[y * w + x] = clamp(acc, HEIGHT_MIN, HEIGHT_MAX);
    }
  }
  return out;
}

function packSplatFromWeights(weightMap) {
  const entries = [...weightMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, SPLAT_LAYERS);
  let sum = 0;
  for (const e of entries) sum += e[1];
  const ids = [0, 0, 0, 0];
  const wts = [0, 0, 0, 0];
  if (sum <= 0) {
    wts[0] = 255;
    return { ids, wts };
  }
  let used = 0;
  for (let i = 0; i < entries.length; i++) {
    ids[i] = clamp(entries[i][0], 0, 255);
    wts[i] = i === entries.length - 1
      ? clamp(255 - used, 0, 255)
      : clamp(Math.round((entries[i][1] / sum) * 255), 0, 255);
    used += wts[i];
  }
  return { ids, wts };
}

const FILE_META = 'meta.json';
const FILE_HEIGHTS = 'heights.png';
const FILE_SPLAT = 'splat.json';

/**
 * Foundry FilePicker forbids .bin. Heights go in lossless PNG (16-bit in R,G; A=255
 * so canvas premultiply cannot wipe RGB). Splat bytes go in JSON as base64.
 */
function packHeightsRgba(heights) {
  const data = new Uint8ClampedArray(heights.length * 4);
  for (let i = 0; i < heights.length; i++) {
    const u = Math.max(0, Math.min(65535, Math.round((heights[i] / HEIGHT_MAX) * 65535)));
    const o = i * 4;
    data[o] = (u >> 8) & 255;
    data[o + 1] = u & 255;
    data[o + 3] = 255;
  }
  return data;
}

function unpackHeightsRgba(rgba, count) {
  const heights = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const u = (rgba[o] << 8) | rgba[o + 1];
    heights[i] = (u / 65535) * HEIGHT_MAX;
  }
  return heights;
}

function u8ToBase64(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

function base64ToU8(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pngFileFromRgba(rgba, width, height, fileName) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const src = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
  ctx.putImageData(new ImageData(src, width, height), 0, 0);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
  return new File([blob], fileName, { type: 'image/png' });
}

async function rgbaFromPngUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  try {
    bmp.close?.();
  } catch (_) {
    /* ignore */
  }
  return img;
}

async function listDataFiles(dir) {
  const FP = _fp();
  if (!dir || !FP?.browse) return new Set();
  try {
    const result = await FP.browse('data', dir);
    const files = Array.isArray(result?.files) ? result.files : [];
    const names = new Set();
    for (const f of files) {
      const s = String(f).replace(/\\/g, '/');
      const base = s.includes('/') ? s.split('/').pop() : s;
      if (base) names.add(base.toLowerCase());
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Canonical high-resolution terrain for the global map (heightmap + top-4 biome splat).
 */
export class TerrainData {
  /**
   * @param {object} init
   */
  constructor(init = {}) {
    this.version = TERRAIN_VERSION;
    this.samplesW = init.samplesW || DEFAULT_SAMPLES;
    this.samplesH = init.samplesH || DEFAULT_SAMPLES;
    this.bounds = init.bounds || { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    this.verticalScale = Number.isFinite(init.verticalScale)
      ? init.verticalScale
      : defaultVerticalScale(this.bounds);
    this.heights = init.heights instanceof Float32Array
      ? init.heights
      : new Float32Array(this.samplesW * this.samplesH);
    this.splatIds = init.splatIds instanceof Uint8Array
      ? init.splatIds
      : new Uint8Array(this.samplesW * this.samplesH * SPLAT_LAYERS);
    this.splatWeights = init.splatWeights instanceof Uint8Array
      ? init.splatWeights
      : new Uint8Array(this.samplesW * this.samplesH * SPLAT_LAYERS);
    this.dirty = Boolean(init.dirty);
    this.source = init.source || 'empty';
  }

  get worldWidth() {
    return Math.max(1, this.bounds.maxX - this.bounds.minX);
  }

  get worldHeight() {
    return Math.max(1, this.bounds.maxY - this.bounds.minY);
  }

  cloneBuffers() {
    return {
      heights: new Float32Array(this.heights),
      splatIds: new Uint8Array(this.splatIds),
      splatWeights: new Uint8Array(this.splatWeights),
    };
  }

  restoreBuffers(snap) {
    if (!snap) return;
    this.heights.set(snap.heights);
    this.splatIds.set(snap.splatIds);
    this.splatWeights.set(snap.splatWeights);
    this.dirty = true;
  }

  worldToUv(worldX, worldY) {
    const u = (worldX - this.bounds.minX) / this.worldWidth;
    const v = (worldY - this.bounds.minY) / this.worldHeight;
    return { u: clamp(u, 0, 1), v: clamp(v, 0, 1) };
  }

  uvToWorld(u, v) {
    return {
      x: this.bounds.minX + clamp(u, 0, 1) * this.worldWidth,
      y: this.bounds.minY + clamp(v, 0, 1) * this.worldHeight,
    };
  }

  /**
   * @param {number} worldX
   * @param {number} worldY
   * @returns {number} height 0..100
   */
  sampleHeight(worldX, worldY) {
    const { u, v } = this.worldToUv(worldX, worldY);
    return this._sampleHeightUv(u, v);
  }

  _sampleHeightUv(u, v) {
    const fx = u * (this.samplesW - 1);
    const fy = v * (this.samplesH - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, this.samplesW - 1);
    const y1 = Math.min(y0 + 1, this.samplesH - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const h00 = this.heights[y0 * this.samplesW + x0];
    const h10 = this.heights[y0 * this.samplesW + x1];
    const h01 = this.heights[y1 * this.samplesW + x0];
    const h11 = this.heights[y1 * this.samplesW + x1];
    const a = h00 * (1 - tx) + h10 * tx;
    const b = h01 * (1 - tx) + h11 * tx;
    return a * (1 - ty) + b * ty;
  }

  /**
   * World-space Y (Three.js up) for terrain surface at Foundry (x, y).
   */
  terrainZ(worldX, worldY) {
    return this.sampleHeight(worldX, worldY) * this.verticalScale * VIEW_HEIGHT_EXAGGERATION;
  }

  /**
   * Convert Foundry TokenDocument.elevation (grid distance units) to world Z.
   * @param {number} elevation
   * @param {Scene} [scene]
   */
  elevationToWorldZ(elevation, scene = canvas?.scene) {
    const elev = Number(elevation) || 0;
    const grid = scene?.grid;
    const size = Number(grid?.size) || 100;
    const distance = Number(grid?.distance) || 1;
    return (elev / distance) * size;
  }

  indexAtUv(u, v) {
    const ix = clamp(Math.round(u * (this.samplesW - 1)), 0, this.samplesW - 1);
    const iy = clamp(Math.round(v * (this.samplesH - 1)), 0, this.samplesH - 1);
    return { ix, iy, index: iy * this.samplesW + ix };
  }

  toMeta() {
    return {
      version: TERRAIN_VERSION,
      storage: 'png+json',
      samplesW: this.samplesW,
      samplesH: this.samplesH,
      bounds: { ...this.bounds },
      verticalScale: this.verticalScale,
      source: this.source,
      timestamp: new Date().toISOString(),
    };
  }

  static createEmpty(scene, { biomeId = 17, height = 20, samples } = {}) {
    const bounds = sceneBounds(scene);
    const { samplesW, samplesH } = computeSampleSize(bounds, samples ?? DEFAULT_SAMPLES);
    const heights = new Float32Array(samplesW * samplesH);
    heights.fill(clamp(Number(height) || 20, HEIGHT_MIN, HEIGHT_MAX));
    const splat = encodeSplatSolid(samplesW, samplesH, biomeId);
    return new TerrainData({
      samplesW,
      samplesH,
      bounds,
      verticalScale: defaultVerticalScale(bounds),
      heights,
      splatIds: splat.splatIds,
      splatWeights: splat.splatWeights,
      dirty: true,
      source: 'empty',
    });
  }

  /**
   * Bilinear upsample of the legacy rectangular cell grid into a high-res heightmap.
   * @param {{heights: ArrayLike<number>, biomes?: ArrayLike<number>, rows: number, cols: number}} grid
   * @param {object} metadata
   * @param {Scene} scene
   * @param {{ biomeId?: number, samples?: number }} [opts]
   */
  static fromUnifiedGrid(grid, metadata, scene, opts = {}) {
    const bounds = metadata?.bounds
      ? {
          minX: Number(metadata.bounds.minX) || 0,
          minY: Number(metadata.bounds.minY) || 0,
          maxX: Number(metadata.bounds.maxX) || sceneBounds(scene).maxX,
          maxY: Number(metadata.bounds.maxY) || sceneBounds(scene).maxY,
        }
      : sceneBounds(scene);

    const { samplesW, samplesH } = computeSampleSize(bounds, opts.samples ?? DEFAULT_SAMPLES);
    const rows = Math.max(1, Number(grid.rows) || 1);
    const cols = Math.max(1, Number(grid.cols) || 1);
    const gHeights = grid.heights;
    const gBiomes = grid.biomes;
    const defaultBiome = opts.biomeId ?? 17;

    const rawHeights = new Float32Array(samplesW * samplesH);
    const splatIds = new Uint8Array(samplesW * samplesH * SPLAT_LAYERS);
    const splatWeights = new Uint8Array(samplesW * samplesH * SPLAT_LAYERS);

    const cellW = (bounds.maxX - bounds.minX) / cols;
    const cellH = (bounds.maxY - bounds.minY) / rows;
    const cellAt = (cx, cy) => {
      const x = clamp(cx, 0, cols - 1);
      const y = clamp(cy, 0, rows - 1);
      return Number(gHeights[y * cols + x]) || 0;
    };
    const biomeAt = (cx, cy) => {
      if (!gBiomes) return defaultBiome;
      const x = clamp(cx, 0, cols - 1);
      const y = clamp(cy, 0, rows - 1);
      return Number(gBiomes[y * cols + x]) || defaultBiome;
    };

    for (let iy = 0; iy < samplesH; iy++) {
      const v = iy / Math.max(1, samplesH - 1);
      const worldY = bounds.minY + v * (bounds.maxY - bounds.minY);
      const gy = clamp((worldY - bounds.minY) / cellH - 0.5, 0, rows - 1);
      const y0 = Math.floor(gy);
      const y1 = Math.min(y0 + 1, rows - 1);
      const ty = smoothstep01(gy - y0);

      for (let ix = 0; ix < samplesW; ix++) {
        const u = ix / Math.max(1, samplesW - 1);
        const worldX = bounds.minX + u * (bounds.maxX - bounds.minX);
        const gx = clamp((worldX - bounds.minX) / cellW - 0.5, 0, cols - 1);
        const x0 = Math.floor(gx);
        const x1 = Math.min(x0 + 1, cols - 1);
        const tx = smoothstep01(gx - x0);

        const h00 = cellAt(x0, y0);
        const h10 = cellAt(x1, y0);
        const h01 = cellAt(x0, y1);
        const h11 = cellAt(x1, y1);
        const ha = h00 * (1 - tx) + h10 * tx;
        const hb = h01 * (1 - tx) + h11 * tx;
        const idx = iy * samplesW + ix;
        rawHeights[idx] = clamp(ha * (1 - ty) + hb * ty, HEIGHT_MIN, HEIGHT_MAX);

        const w00 = (1 - tx) * (1 - ty);
        const w10 = tx * (1 - ty);
        const w01 = (1 - tx) * ty;
        const w11 = tx * ty;
        const acc = new Map();
        const add = (id, wt) => {
          if (wt <= 0.001) return;
          acc.set(id, (acc.get(id) || 0) + wt);
        };
        add(biomeAt(x0, y0), w00);
        add(biomeAt(x1, y0), w10);
        add(biomeAt(x0, y1), w01);
        add(biomeAt(x1, y1), w11);
        const packed = packSplatFromWeights(acc);
        const b = idx * SPLAT_LAYERS;
        for (let k = 0; k < SPLAT_LAYERS; k++) {
          splatIds[b + k] = packed.ids[k];
          splatWeights[b + k] = packed.wts[k];
        }
      }
    }

    const samplesPerCell = Math.max(samplesW / cols, samplesH / rows);
    const heights = blurHeights(rawHeights, samplesW, samplesH, Math.max(8, samplesPerCell * 1.6));

    return new TerrainData({
      samplesW,
      samplesH,
      bounds,
      verticalScale: defaultVerticalScale(bounds),
      heights,
      splatIds,
      splatWeights,
      dirty: true,
      source: 'unifiedGrid',
    });
  }

  static directoryForScene(scene) {
    const worldId = game?.world?.id;
    if (!worldId || !scene?.id) return null;
    return `worlds/${worldId}/global-maps/${scene.id}-terrain`;
  }

  static async loadFromScene(scene) {
    const stored = scene?.getFlag?.(MODULE_NS, FLAG_TERRAIN_PATH);
    const dir = stored || TerrainData.directoryForScene(scene);
    if (!dir) return null;
    try {
      const listed = await listDataFiles(dir);
      if (!listed.has(FILE_META) || !listed.has(FILE_HEIGHTS) || !listed.has(FILE_SPLAT)) return null;

      const metaRes = await fetch(`${dir}/${FILE_META}`);
      if (!metaRes.ok) return null;
      const meta = await metaRes.json();
      if (!meta || Number(meta.version) !== TERRAIN_VERSION) return null;

      const samplesW = Number(meta.samplesW);
      const samplesH = Number(meta.samplesH);
      if (!Number.isFinite(samplesW) || !Number.isFinite(samplesH)) return null;

      const expectedH = samplesW * samplesH;
      const expectedS = expectedH * SPLAT_LAYERS;

      const heightImg = await rgbaFromPngUrl(`${dir}/${FILE_HEIGHTS}`);
      if (heightImg.width !== samplesW || heightImg.height !== samplesH) {
        console.warn('TerrainData | PNG size mismatch, ignoring file');
        return null;
      }

      const splatRes = await fetch(`${dir}/${FILE_SPLAT}`);
      if (!splatRes.ok) return null;
      const splatJson = await splatRes.json();
      const splatIds = base64ToU8(splatJson?.ids);
      const splatWeights = base64ToU8(splatJson?.weights);
      const heights = unpackHeightsRgba(heightImg.data, expectedH);
      if (heights.length !== expectedH || splatIds.length !== expectedS || splatWeights.length !== expectedS) {
        console.warn('TerrainData | size mismatch, ignoring file');
        return null;
      }

      return new TerrainData({
        samplesW,
        samplesH,
        bounds: meta.bounds || sceneBounds(scene),
        verticalScale: Number(meta.verticalScale) || defaultVerticalScale(meta.bounds || sceneBounds(scene)),
        heights,
        splatIds,
        splatWeights,
        dirty: false,
        source: meta.source || 'file',
      });
    } catch (e) {
      console.warn('TerrainData | load failed', e);
      return null;
    }
  }

  /**
   * @param {Scene} scene
   * @returns {Promise<boolean>}
   */
  async saveToScene(scene) {
    const dir = TerrainData.directoryForScene(scene);
    if (!dir || !scene) return false;
    const FP = _fp();
    if (!FP?.upload) return false;

    try {
      try {
        await FP.createDirectory('data', dir, {});
      } catch (_) {
        /* exists */
      }

      const metaFile = new File(
        [JSON.stringify(this.toMeta(), null, 2)],
        FILE_META,
        { type: 'application/json' },
      );
      const heightsFile = await pngFileFromRgba(
        packHeightsRgba(this.heights),
        this.samplesW,
        this.samplesH,
        FILE_HEIGHTS,
      );
      const splatFile = new File(
        [JSON.stringify({
          ids: u8ToBase64(this.splatIds),
          weights: u8ToBase64(this.splatWeights),
        })],
        FILE_SPLAT,
        { type: 'application/json' },
      );

      const upload = async (file) => {
        const res = await FP.upload('data', dir, file, {}, { notify: false });
        return Boolean(res);
      };

      const ok = (await upload(metaFile)) && (await upload(heightsFile)) && (await upload(splatFile));
      if (!ok) return false;

      await scene.setFlag(MODULE_NS, FLAG_TERRAIN_PATH, dir);
      this.dirty = false;
      ui.notifications?.info?.(_t('SPACEHOLDER.GlobalMap.Terrain3d.Notifications.Saved'));
      return true;
    } catch (e) {
      console.error('TerrainData | save failed', e);
      ui.notifications?.error?.(_f('SPACEHOLDER.GlobalMap.Terrain3d.Errors.SaveFailed', { message: e.message }));
      return false;
    }
  }
}

export { computeSampleSize, defaultVerticalScale, sceneBounds };

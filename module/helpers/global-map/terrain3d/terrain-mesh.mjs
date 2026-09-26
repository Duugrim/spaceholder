import { HEIGHT_MAX, MESH_SEGMENTS, SPLAT_LAYERS, VIEW_HEIGHT_EXAGGERATION } from './terrain-const.mjs';

const CONTOUR_INTERVAL = 5;
const MAJOR_CONTOUR_INTERVAL = 10;
const CONTOUR_MINOR_COLOR = 0x24282b;
const CONTOUR_MAJOR_COLOR = 0x090b0c;

function visualHeightScale(data) {
  return data.verticalScale * HEIGHT_MAX * VIEW_HEIGHT_EXAGGERATION;
}

function makePaletteData(biomeResolver) {
  const data = new Uint8Array(256 * 4);
  for (let id = 0; id < 256; id++) {
    let hex = 0x668866;
    try {
      hex = biomeResolver?.getBiomeColor?.(id) ?? hex;
    } catch (_) {
      /* ignore */
    }
    const i = id * 4;
    data[i] = (hex >> 16) & 255;
    data[i + 1] = (hex >> 8) & 255;
    data[i + 2] = hex & 255;
    data[i + 3] = 255;
  }
  return data;
}

function sampleHeightAt(data, sx, sy) {
  const fx = Math.max(0, Math.min(data.samplesW - 1, sx));
  const fy = Math.max(0, Math.min(data.samplesH - 1, sy));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, data.samplesW - 1);
  const y1 = Math.min(y0 + 1, data.samplesH - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const h00 = data.heights[y0 * data.samplesW + x0];
  const h10 = data.heights[y0 * data.samplesW + x1];
  const h01 = data.heights[y1 * data.samplesW + x0];
  const h11 = data.heights[y1 * data.samplesW + x1];
  const a = h00 * (1 - tx) + h10 * tx;
  const b = h01 * (1 - tx) + h11 * tx;
  return a * (1 - ty) + b * ty;
}

function sampleAlbedo(data, palette, sx, sy) {
  const x = Math.max(0, Math.min(data.samplesW - 1, sx | 0));
  const y = Math.max(0, Math.min(data.samplesH - 1, sy | 0));
  const b = (y * data.samplesW + x) * SPLAT_LAYERS;
  let r = 0;
  let g = 0;
  let bl = 0;
  let wsum = 0;
  for (let k = 0; k < SPLAT_LAYERS; k++) {
    const wt = data.splatWeights[b + k] / 255;
    if (wt <= 0) continue;
    const i = (data.splatIds[b + k] & 255) * 4;
    r += palette[i] * wt;
    g += palette[i + 1] * wt;
    bl += palette[i + 2] * wt;
    wsum += wt;
  }
  if (wsum > 0) {
    r /= wsum;
    g /= wsum;
    bl /= wsum;
  }
  return [r, g, bl];
}

/**
 * Albedo + slope shade + height-field shadow for a standard material map.
 * @returns {ImageData}
 */
export function bakeTerrainShadedMap(data, biomeResolver, outSize = 768) {
  const w = Math.max(64, Math.min(outSize, data.samplesW));
  const h = Math.max(64, Math.min(outSize, data.samplesH));
  const img = new ImageData(w, h);
  const px = img.data;
  const palette = makePaletteData(biomeResolver);
  const heightScale = visualHeightScale(data);
  const worldW = data.worldWidth;
  const worldH = data.worldHeight;
  const stepX = worldW / Math.max(1, w - 1);
  const stepZ = worldH / Math.max(1, h - 1);
  const sampleStepX = (data.samplesW - 1) / Math.max(1, w - 1);
  const sampleStepY = (data.samplesH - 1) / Math.max(1, h - 1);
  const lightX = 0.72;
  const lightY = 0.45;
  const lightZ = 0.48;
  const lxz = Math.hypot(lightX, lightZ);
  const rise = lightY / lxz;
  const dirX = lightX / lxz;
  const dirZ = lightZ / lxz;
  const shadowStep = Math.min(worldW, worldH) / 160;

  for (let iy = 0; iy < h; iy++) {
    const v = iy / Math.max(1, h - 1);
    const sy = v * (data.samplesH - 1);
    for (let ix = 0; ix < w; ix++) {
      const u = ix / Math.max(1, w - 1);
      const sx = u * (data.samplesW - 1);
      const albedo = sampleAlbedo(data, palette, Math.round(sx), Math.round(sy));
      const hC = sampleHeightAt(data, sx, sy);
      const hL = sampleHeightAt(data, sx - sampleStepX, sy);
      const hR = sampleHeightAt(data, sx + sampleStepX, sy);
      const hD = sampleHeightAt(data, sx, sy - sampleStepY);
      const hU = sampleHeightAt(data, sx, sy + sampleStepY);
      const dHx = ((hR - hL) / HEIGHT_MAX) * heightScale;
      const dHz = ((hU - hD) / HEIGHT_MAX) * heightScale;
      const nx = -dHx;
      const ny = stepX * 2;
      const nz = -dHz;
      const nlen = Math.hypot(nx, ny, nz) || 1;
      const ndl = Math.max(0, (nx * lightX + ny * lightY + nz * lightZ) / nlen);
      const hemi = (ny / nlen) * 0.5 + 0.5;

      const h0 = (hC / HEIGHT_MAX) * heightScale;
      let occ = 0;
      for (let s = 1; s <= 18; s++) {
        const dist = s * shadowStep;
        const su = u + (dirX * dist) / worldW;
        const sv = v + (dirZ * dist) / worldH;
        if (su < 0 || su > 1 || sv < 0 || sv > 1) break;
        const hs = sampleHeightAt(data, su * (data.samplesW - 1), sv * (data.samplesH - 1));
        const rayH = h0 + dist * rise;
        const blocked = ((hs / HEIGHT_MAX) * heightScale - rayH - 2) / 18;
        if (blocked > occ) occ = blocked;
        if (occ >= 1) break;
      }
      occ = Math.max(0, Math.min(1, occ));
      const shade = 0.18 + 0.22 * hemi + 0.72 * ndl * (1 - occ * 0.82);

      let r = albedo[0] * shade;
      let g = albedo[1] * shade;
      let b = albedo[2] * shade;

      const p = (iy * w + ix) * 4;
      px[p] = Math.max(0, Math.min(255, Math.round(r)));
      px[p + 1] = Math.max(0, Math.min(255, Math.round(g)));
      px[p + 2] = Math.max(0, Math.min(255, Math.round(b)));
      px[p + 3] = 255;
    }
  }
  return img;
}

function buildGridGeometry(THREE, data, segments) {
  const segsX = segments.x;
  const segsY = segments.y;
  const verts = (segsX + 1) * (segsY + 1);
  const positions = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  const indices = [];
  const minX = data.bounds.minX;
  const minY = data.bounds.minY;
  const worldW = data.worldWidth;
  const worldH = data.worldHeight;

  let i = 0;
  for (let iy = 0; iy <= segsY; iy++) {
    const v = iy / segsY;
    const z = minY + v * worldH;
    for (let ix = 0; ix <= segsX; ix++) {
      const u = ix / segsX;
      const x = minX + u * worldW;
      const p = i * 3;
      positions[p] = x;
      positions[p + 1] = 0;
      positions[p + 2] = z;
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
      i += 1;
    }
  }

  for (let iy = 0; iy < segsY; iy++) {
    for (let ix = 0; ix < segsX; ix++) {
      const a = iy * (segsX + 1) + ix;
      const b = a + 1;
      const c = a + (segsX + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  applyHeightToGeometry(geo, data);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

function applyHeightToGeometry(geo, data) {
  const pos = geo.attributes.position;
  const scale = visualHeightScale(data);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, (data.sampleHeight(x, z) / HEIGHT_MAX) * scale);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
}

function addUniquePoint(points, point, epsilon) {
  const epsilonSq = epsilon * epsilon;
  for (const existing of points) {
    const dx = existing.x - point.x;
    const dy = existing.y - point.y;
    const dz = existing.z - point.z;
    if (dx * dx + dy * dy + dz * dz <= epsilonSq) return;
  }
  points.push(point);
}

/**
 * Intersect one terrain triangle with a horizontal plane.
 * Returns the two endpoints of the geometric isoline segment.
 *
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 * @param {{x:number,y:number,z:number}} c
 * @param {number} planeY
 * @param {number} [epsilon]
 * @returns {Array<object>|null}
 */
export function intersectTriangleWithHorizontalPlane(a, b, c, planeY, epsilon = 1e-5) {
  const vertices = [a, b, c];
  const distances = vertices.map((point) => point.y - planeY);
  if (distances.every((distance) => Math.abs(distance) <= epsilon)) return null;

  const points = [];
  const edges = [[0, 1], [1, 2], [2, 0]];
  for (const [ia, ib] of edges) {
    const pa = vertices[ia];
    const pb = vertices[ib];
    const da = distances[ia];
    const db = distances[ib];
    const aOnPlane = Math.abs(da) <= epsilon;
    const bOnPlane = Math.abs(db) <= epsilon;

    if (aOnPlane) addUniquePoint(points, pa, epsilon);
    if (bOnPlane) addUniquePoint(points, pb, epsilon);
    if (aOnPlane || bOnPlane || da * db >= 0) continue;

    const t = da / (da - db);
    addUniquePoint(points, {
      x: pa.x + (pb.x - pa.x) * t,
      y: planeY,
      z: pa.z + (pb.z - pa.z) * t,
    }, epsilon);
  }

  if (points.length < 2) return null;
  if (points.length === 2) return points;

  let best = null;
  let bestDistanceSq = -1;
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      const dz = points[i].z - points[j].z;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq > bestDistanceSq) {
        best = [points[i], points[j]];
        bestDistanceSq = distanceSq;
      }
    }
  }
  return best;
}

function contourSegmentKey(a, b) {
  const pointKey = (point) => `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)},${Math.round(point.z * 1000)}`;
  const ka = pointKey(a);
  const kb = pointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function createContourLines(THREE, positions, { name, color, opacity, renderOrder }) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.computeBoundingSphere();
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.name = name;
  lines.renderOrder = renderOrder;
  lines.frustumCulled = false;
  return lines;
}

/**
 * Build true geometric isolines by intersecting horizontal planes with every
 * triangle of the rendered terrain mesh.
 */
function buildTerrainContours(THREE, geo, data) {
  const group = new THREE.Group();
  group.name = 'spaceholderTerrainContours';

  const pos = geo.attributes.position;
  const index = geo.index;
  const triangleCount = index ? index.count / 3 : pos.count / 3;
  const heightUnit = visualHeightScale(data) / HEIGHT_MAX;
  const planeEpsilon = Math.max(1e-5, heightUnit * 1e-5);
  const heightEpsilon = planeEpsilon / heightUnit;
  const surfaceOffset = Math.max(0.75, Math.min(data.worldWidth, data.worldHeight) * 0.0002);
  const minorPositions = [];
  const majorPositions = [];
  const minorKeys = new Set();
  const majorKeys = new Set();

  const vertexAt = (vertexIndex) => ({
    x: pos.getX(vertexIndex),
    y: pos.getY(vertexIndex),
    z: pos.getZ(vertexIndex),
  });

  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const offset = triangle * 3;
    const ia = index ? index.getX(offset) : offset;
    const ib = index ? index.getX(offset + 1) : offset + 1;
    const ic = index ? index.getX(offset + 2) : offset + 2;
    const a = vertexAt(ia);
    const b = vertexAt(ib);
    const c = vertexAt(ic);
    const minHeight = Math.min(a.y, b.y, c.y) / heightUnit;
    const maxHeight = Math.max(a.y, b.y, c.y) / heightUnit;
    const firstLevel = Math.max(
      CONTOUR_INTERVAL,
      Math.ceil((minHeight - heightEpsilon) / CONTOUR_INTERVAL) * CONTOUR_INTERVAL,
    );
    const lastLevel = Math.min(
      HEIGHT_MAX - CONTOUR_INTERVAL,
      Math.floor((maxHeight + heightEpsilon) / CONTOUR_INTERVAL) * CONTOUR_INTERVAL,
    );

    for (let level = firstLevel; level <= lastLevel; level += CONTOUR_INTERVAL) {
      const segment = intersectTriangleWithHorizontalPlane(a, b, c, level * heightUnit, planeEpsilon);
      if (!segment) continue;
      const [start, end] = segment;
      const major = level % MAJOR_CONTOUR_INTERVAL === 0;
      const keys = major ? majorKeys : minorKeys;
      const key = contourSegmentKey(start, end);
      if (keys.has(key)) continue;
      keys.add(key);

      const positions = major ? majorPositions : minorPositions;
      positions.push(
        start.x, start.y + surfaceOffset, start.z,
        end.x, end.y + surfaceOffset, end.z,
      );
    }
  }

  if (minorPositions.length > 0) {
    group.add(createContourLines(THREE, minorPositions, {
      name: 'spaceholderTerrainContoursMinor',
      color: CONTOUR_MINOR_COLOR,
      opacity: 0.72,
      renderOrder: 4,
    }));
  }
  if (majorPositions.length > 0) {
    group.add(createContourLines(THREE, majorPositions, {
      name: 'spaceholderTerrainContoursMajor',
      color: CONTOUR_MAJOR_COLOR,
      opacity: 0.92,
      renderOrder: 5,
    }));
  }
  return group;
}

function disposeTerrainContours(group) {
  if (!group) return;
  group.traverse((child) => {
    child.geometry?.dispose?.();
    child.material?.dispose?.();
  });
  group.removeFromParent();
}

function segmentCounts(data) {
  const aspect = data.worldWidth / data.worldHeight;
  let sx;
  let sy;
  if (aspect >= 1) {
    sx = MESH_SEGMENTS;
    sy = Math.max(32, Math.round(MESH_SEGMENTS / aspect));
  } else {
    sy = MESH_SEGMENTS;
    sx = Math.max(32, Math.round(MESH_SEGMENTS * aspect));
  }
  return { x: sx, y: sy };
}

function applyImageToTexture(tex, img) {
  const canvas = tex.image;
  if (!canvas || canvas.width !== img.width || canvas.height !== img.height) {
    const next = document.createElement('canvas');
    next.width = img.width;
    next.height = img.height;
    tex.image = next;
  }
  const ctx = tex.image.getContext('2d');
  ctx.putImageData(img, 0, 0);
  tex.needsUpdate = true;
}

/**
 * CPU-displaced terrain mesh with a standard lit material (no custom GLSL).
 * @param {typeof import('../../../vendor/three.module.mjs')} THREE
 * @param {import('./terrain-data.mjs').TerrainData} data
 * @param {object} biomeResolver
 */
export function createTerrainVisual(THREE, data, biomeResolver) {
  const canvasEl = document.createElement('canvas');
  canvasEl.width = 4;
  canvasEl.height = 4;
  const colorTex = new THREE.CanvasTexture(canvasEl);
  colorTex.magFilter = THREE.LinearFilter;
  colorTex.minFilter = THREE.LinearMipmapLinearFilter;
  colorTex.generateMipmaps = true;
  colorTex.anisotropy = 4;
  colorTex.wrapS = THREE.ClampToEdgeWrapping;
  colorTex.wrapT = THREE.ClampToEdgeWrapping;
  colorTex.flipY = false;
  colorTex.colorSpace = THREE.SRGBColorSpace || THREE.NoColorSpace;
  colorTex.needsUpdate = true;

  const mat = new THREE.MeshPhongMaterial({
    map: colorTex,
    shininess: 8,
    specular: 0x202018,
    side: THREE.DoubleSide,
    dithering: true,
  });

  const geo = buildGridGeometry(THREE, data, segmentCounts(data));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'spaceholderTerrainMesh';
  mesh.frustumCulled = false;
  let contours = null;

  const rebuildContours = () => {
    disposeTerrainContours(contours);
    contours = buildTerrainContours(THREE, geo, data);
    mesh.add(contours);
  };

  const visual = {
    mesh,
    colorTex,
    get contours() {
      return contours;
    },
    heightsDirty: false,
    splatDirty: false,

    refreshHeights({ preview = false } = {}) {
      applyHeightToGeometry(geo, data);
      if (preview) {
        if (contours) contours.visible = false;
      } else {
        rebuildContours();
      }
      applyImageToTexture(colorTex, bakeTerrainShadedMap(data, biomeResolver, preview ? 256 : 768));
      this.heightsDirty = false;
      this.splatDirty = false;
    },

    refreshSplat() {
      applyImageToTexture(colorTex, bakeTerrainShadedMap(data, biomeResolver, 768));
      this.splatDirty = false;
    },

    refreshPalette() {
      applyImageToTexture(colorTex, bakeTerrainShadedMap(data, biomeResolver, 768));
    },

    markHeights() {
      this.heightsDirty = true;
    },

    markSplat() {
      this.splatDirty = true;
    },

    flush() {
      if (!this.heightsDirty && !this.splatDirty) return false;
      this.refreshHeights({ preview: true });
      return true;
    },

    dispose() {
      disposeTerrainContours(contours);
      contours = null;
      geo.dispose();
      mat.dispose();
      colorTex.dispose();
    },
  };

  visual.refreshHeights({ preview: false });
  return visual;
}

/**
 * Orthographic albedo+hillshade bake for the 2D PIXI fallback.
 * @param {import('./terrain-data.mjs').TerrainData} data
 * @param {object} biomeResolver
 * @param {number} [outSize]
 * @returns {HTMLCanvasElement}
 */
export function bakeTerrainAlbedo(data, biomeResolver, outSize = 1024) {
  const img = bakeTerrainShadedMap(data, biomeResolver, outSize);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d').putImageData(img, 0, 0);
  return canvas;
}

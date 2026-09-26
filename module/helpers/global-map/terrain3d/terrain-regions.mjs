import { REGION_WALL_HEIGHT_FACTOR } from './terrain-const.mjs';

function chaikin(points, iterations) {
  if (!Array.isArray(points) || points.length < 3) return points || [];
  let smoothed = points.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
  const nIter = Math.max(0, Math.min(4, iterations | 0));
  for (let iter = 0; iter < nIter; iter++) {
    const next = [];
    for (let i = 0; i < smoothed.length; i++) {
      const p0 = smoothed[i];
      const p1 = smoothed[(i + 1) % smoothed.length];
      next.push({ x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y });
      next.push({ x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y });
    }
    smoothed = next;
  }
  return smoothed;
}

function hexToInt(v, fallback = 0x2e7dff) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function subsample(p0, p1, step) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(len / Math.max(step, 8)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    out.push({ x: p0.x + dx * t, y: p0.y + dy * t });
  }
  return out;
}

/**
 * Region fill draped on terrain + translucent vertical border walls.
 * @param {typeof import('../../../vendor/three.module.mjs')} THREE
 * @param {import('./terrain-data.mjs').TerrainData} data
 * @param {object|null} regionsData flags.spaceholder.globalMapRegions
 */
export function createRegionMeshes(THREE, data, regionsData) {
  const group = new THREE.Group();
  group.name = 'spaceholderTerrainRegions';
  if (!data || !regionsData?.regions?.length) return { group, dispose() {} };

  const smooth = Number.parseInt(regionsData.settings?.smoothIterations, 10);
  const iterations = Number.isFinite(smooth) ? Math.max(0, Math.min(4, smooth)) : 4;
  const wallH = Math.max(40, Math.min(data.worldWidth, data.worldHeight) * REGION_WALL_HEIGHT_FACTOR);
  const sampleStep = Math.max(16, Math.min(data.worldWidth, data.worldHeight) / 180);
  const disposables = [];

  for (const region of regionsData.regions) {
    try {
    const raw = Array.isArray(region?.points) ? region.points : [];
    if (raw.length < 3 || region.closed === false) continue;
    const pts = chaikin(raw, iterations);
    if (pts.length < 3) continue;

    const fillColor = hexToInt(region.fillColor, hexToInt(region.strokeColor));
    const fillAlpha = Number.isFinite(Number(region.fillAlpha)) ? Number(region.fillAlpha) : 0.18;
    const strokeColor = hexToInt(region.strokeColor, fillColor);
    const strokeAlpha = Number.isFinite(Number(region.strokeAlpha)) ? Number(region.strokeAlpha) : 0.55;

    if (fillAlpha > 0.01) {
      const shape = new THREE.Shape();
      shape.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
      shape.closePath();
      const geo = new THREE.ShapeGeometry(shape);
      const pos = geo.attributes.position;
      const arr = pos.array;
      for (let i = 0; i < pos.count; i++) {
        const x = arr[i * 3];
        const y2 = arr[i * 3 + 1];
        const z = data.terrainZ(x, y2) + 2;
        arr[i * 3] = x;
        arr[i * 3 + 1] = z;
        arr[i * 3 + 2] = y2;
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
      const mat = new THREE.MeshBasicMaterial({
        color: fillColor,
        transparent: true,
        opacity: Math.max(0.06, Math.min(0.35, fillAlpha)),
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 2;
      group.add(mesh);
      disposables.push(geo, mat);
    }

    const wallPos = [];
    const wallIdx = [];
    let v = 0;
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[i];
      const p1 = pts[(i + 1) % pts.length];
      const samples = subsample(p0, p1, sampleStep);
      samples.push(p1);
      for (let s = 0; s < samples.length - 1; s++) {
        const a = samples[s];
        const b = samples[s + 1];
        const za = data.terrainZ(a.x, a.y);
        const zb = data.terrainZ(b.x, b.y);
        wallPos.push(a.x, za, a.y, a.x, za + wallH, a.y, b.x, zb, b.y, b.x, zb + wallH, b.y);
        wallIdx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        v += 4;
      }
    }
    if (wallPos.length >= 18) {
      const wgeo = new THREE.BufferGeometry();
      wgeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
      wgeo.setIndex(wallIdx);
      wgeo.computeVertexNormals();
      const wmat = new THREE.MeshBasicMaterial({
        color: strokeColor,
        transparent: true,
        opacity: Math.max(0.18, Math.min(0.55, strokeAlpha * 0.7)),
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const wmesh = new THREE.Mesh(wgeo, wmat);
      wmesh.renderOrder = 3;
      group.add(wmesh);
      disposables.push(wgeo, wmat);
    }

    const name = String(region.name || '').trim();
    if (name) {
      let cx = 0;
      let cy = 0;
      for (const p of pts) {
        cx += p.x;
        cy += p.y;
      }
      cx /= pts.length;
      cy /= pts.length;
      const label = makeLabelSprite(THREE, name, strokeColor);
      const lz = data.terrainZ(cx, cy) + wallH * 0.65;
      label.position.set(cx, lz, cy);
      group.add(label);
      disposables.push(label.material.map, label.material);
    }
    } catch (e) {
      console.warn('TerrainRegions | skip region', region?.id, e);
    }
  }

  return {
    group,
    dispose() {
      for (const d of disposables) {
        try {
          d.dispose?.();
        } catch (_) {
          /* ignore */
        }
      }
      group.clear();
    },
  };
}

function makeLabelSprite(THREE, text, color) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 512, 128);
  ctx.font = '600 42px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.fillStyle = `#${(color >>> 0).toString(16).padStart(6, '0')}`;
  ctx.strokeText(text, 256, 64);
  ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(420, 105, 1);
  sprite.center.set(0.5, 0.5);
  sprite.renderOrder = 10;
  return sprite;
}

/**
 * Token billboards in 3D. Document (x, y) stay Foundry-canonical;
 * elevation is a relative offset from terrain surface.
 */
const TOKEN_RENDER_ORDER = 40;
const TOKEN_FRAME_RENDER_ORDER = 41;
const TOKEN_PATH_RENDER_ORDER = 39;
const TOKEN_SURFACE_OFFSET = 3;
const TOKEN_PATH_MAX_POINTS = 129;
const TOKEN_PATH_SAMPLE_WORLD = 40;

export class TerrainTokens {
  /**
   * @param {typeof import('../../../vendor/three.module.mjs')} THREE
   * @param {import('./terrain-data.mjs').TerrainData} data
   */
  constructor(THREE, data) {
    this.THREE = THREE;
    this.data = data;
    this.group = new THREE.Group();
    this.group.name = 'spaceholderTerrainTokens';
    /** @type {Map<string, import('three').Sprite>} */
    this._sprites = new Map();
    /** @type {Map<string, import('three').Texture>} */
    this._textures = new Map();
    this._loader = new THREE.TextureLoader();
    this._selectionTexture = this._createSelectionTexture();
    this._hoveredTokenId = null;
    this._movePreview = null;
  }

  setData(data) {
    this.data = data;
  }

  worldPosForToken(token) {
    const doc = token?.document ?? token;
    if (!doc || !this.data) return null;
    const x = Number(doc.x) + (Number(token?.w ?? doc.width * (canvas?.grid?.size || 100)) / 2);
    const y = Number(doc.y) + (Number(token?.h ?? doc.height * (canvas?.grid?.size || 100)) / 2);
    const elev = Number(doc.elevation) || 0;
    const z = this.data.terrainZ(x, y) + this.data.elevationToWorldZ(elev);
    return { x, y, z };
  }

  sync() {
    if (!this.data || !canvas?.tokens) return;
    const seen = new Set();
    for (const token of canvas.tokens.placeables ?? []) {
      const id = token.id;
      if (!id || token.document?.hidden) continue;
      seen.add(id);
      let sprite = this._sprites.get(id);
      if (!sprite) {
        sprite = this._createSprite(token);
        if (!sprite) continue;
        this._sprites.set(id, sprite);
        this.group.add(sprite);
      }
      this._updateSprite(sprite, token);
    }
    for (const [id, sprite] of this._sprites) {
      if (seen.has(id)) continue;
      this.group.remove(sprite);
      this._disposeSprite(sprite);
      this._sprites.delete(id);
      this._textures.delete(id);
    }
  }

  pick(raycaster) {
    const list = [...this._sprites.values()];
    if (!list.length) return null;
    const hits = raycaster.intersectObjects(list, false);
    if (!hits.length) return null;
    const id = hits[0].object?.userData?.tokenId;
    return id ? canvas.tokens.get(id) ?? null : null;
  }

  setHovered(tokenId) {
    const nextId = tokenId ? String(tokenId) : null;
    if (this._hoveredTokenId === nextId) return false;
    const previous = this._hoveredTokenId;
    this._hoveredTokenId = nextId;
    if (previous) {
      const token = canvas.tokens.get(previous);
      const sprite = this._sprites.get(previous);
      if (token && sprite) this._updateFrame(sprite, token);
    }
    if (nextId) {
      const token = canvas.tokens.get(nextId);
      const sprite = this._sprites.get(nextId);
      if (token && sprite) this._updateFrame(sprite, token);
    }
    return true;
  }

  beginMove(token) {
    const tokenId = String(token?.id ?? '');
    if (!tokenId || !this.data) return false;
    this.endMove();
    const origin = this.worldPosForToken(token);
    if (!origin) return false;

    const THREE = this.THREE;
    const positions = new Float32Array(TOKEN_PATH_MAX_POINTS * 3);
    const geometry = new THREE.BufferGeometry();
    const attribute = new THREE.BufferAttribute(positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', attribute);
    geometry.setDrawRange(0, 0);
    const material = new THREE.LineBasicMaterial({
      color: 0xffc766,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const line = new THREE.Line(geometry, material);
    line.name = `tokenPath:${tokenId}`;
    line.renderOrder = TOKEN_PATH_RENDER_ORDER;
    line.frustumCulled = false;
    this.group.add(line);

    this._movePreview = {
      tokenId,
      originX: origin.x,
      originY: origin.y,
      elevationWorld: this.data.elevationToWorldZ(Number(token.document?.elevation) || 0),
      line,
      positions,
    };
    this._updateMovePath(origin.x, origin.y);
    return true;
  }

  previewMove(tokenId, worldX, worldY) {
    const sprite = this._sprites.get(tokenId);
    const token = canvas.tokens.get(tokenId);
    if (!sprite || !token || !this.data) return;
    if (this._movePreview?.tokenId !== String(tokenId)) this.beginMove(token);
    const w = Number(token.w) || 100;
    const h = Number(token.h) || 100;
    const cx = worldX;
    const cy = worldY;
    const elev = Number(token.document.elevation) || 0;
    const z = this.data.terrainZ(cx, cy) + this.data.elevationToWorldZ(elev) + TOKEN_SURFACE_OFFSET;
    sprite.position.set(cx, z, cy);
    sprite.scale.set(w, h, 1);
    this._updateMovePath(cx, cy);
  }

  endMove() {
    const preview = this._movePreview;
    if (!preview) return;
    preview.line.removeFromParent();
    preview.line.geometry?.dispose?.();
    preview.line.material?.dispose?.();
    this._movePreview = null;
  }

  dispose() {
    this.endMove();
    for (const sprite of this._sprites.values()) {
      this._disposeSprite(sprite);
    }
    this._sprites.clear();
    this._textures.clear();
    this._selectionTexture?.dispose?.();
    this._selectionTexture = null;
    this._hoveredTokenId = null;
    this.group.clear();
  }

  _createSelectionTexture() {
    const THREE = this.THREE;
    const canvasEl = document.createElement('canvas');
    canvasEl.width = 128;
    canvasEl.height = 128;
    const ctx = canvasEl.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 5;
    ctx.strokeRect(4, 4, 120, 120);
    const tex = new THREE.CanvasTexture(canvasEl);
    tex.colorSpace = THREE.SRGBColorSpace || THREE.NoColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  _createSprite(token) {
    const THREE = this.THREE;
    const src = token.document?.texture?.src || token.actor?.img;
    const mat = new THREE.SpriteMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: true,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.center.set(0.5, 0);
    sprite.userData.tokenId = token.id;
    sprite.name = `token:${token.id}`;
    sprite.renderOrder = TOKEN_RENDER_ORDER;

    const frameMaterial = new THREE.SpriteMaterial({
      map: this._selectionTexture,
      color: 0xffb347,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: true,
      toneMapped: false,
    });
    const frame = new THREE.Sprite(frameMaterial);
    frame.center.copy(sprite.center);
    frame.position.set(0, 0, 0);
    frame.scale.set(1.08, 1.08, 1);
    frame.renderOrder = TOKEN_FRAME_RENDER_ORDER;
    frame.visible = false;
    frame.userData.isTokenFrame = true;
    sprite.userData.selectionFrame = frame;
    sprite.add(frame);

    if (src) {
      this._loader.load(src, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        mat.map = tex;
        mat.needsUpdate = true;
        this._textures.set(token.id, tex);
      });
    }
    return sprite;
  }

  _updateSprite(sprite, token) {
    const pos = this.worldPosForToken(token);
    if (!pos) return;
    if (this._movePreview?.tokenId !== String(token.id)) {
      sprite.position.set(pos.x, pos.z + TOKEN_SURFACE_OFFSET, pos.y);
    }
    const w = Number(token.w) || 100;
    const h = Number(token.h) || 100;
    sprite.scale.set(w, h, 1);
    sprite.visible = true;
    this._updateFrame(sprite, token);
  }

  _updateFrame(sprite, token) {
    const frame = sprite.userData?.selectionFrame;
    if (!frame) return;
    const controlled = Boolean(token.controlled);
    const hovered = this._hoveredTokenId === String(token.id);
    const targeted = Boolean(token.isTargeted ?? token.targeted?.has?.(globalThis.game?.user));
    frame.visible = controlled || targeted || hovered;
    frame.material.color.setHex(controlled ? 0xffb347 : targeted ? 0xff5d5d : 0xf1f3f5);
    frame.material.opacity = controlled || targeted ? 0.98 : 0.72;
  }

  _updateMovePath(destinationX, destinationY) {
    const preview = this._movePreview;
    if (!preview || !this.data) return;
    const dx = destinationX - preview.originX;
    const dy = destinationY - preview.originY;
    const distance = Math.hypot(dx, dy);
    const pointCount = Math.max(
      2,
      Math.min(TOKEN_PATH_MAX_POINTS, Math.ceil(distance / TOKEN_PATH_SAMPLE_WORLD) + 1),
    );

    for (let i = 0; i < pointCount; i++) {
      const t = i / (pointCount - 1);
      const x = preview.originX + dx * t;
      const y = preview.originY + dy * t;
      const z = this.data.terrainZ(x, y) + preview.elevationWorld + TOKEN_SURFACE_OFFSET * 1.5;
      const offset = i * 3;
      preview.positions[offset] = x;
      preview.positions[offset + 1] = z;
      preview.positions[offset + 2] = y;
    }

    const position = preview.line.geometry.attributes.position;
    position.needsUpdate = true;
    preview.line.geometry.setDrawRange(0, pointCount);
    preview.line.geometry.computeBoundingSphere();
  }

  _disposeSprite(sprite) {
    const frame = sprite?.userData?.selectionFrame;
    frame?.material?.dispose?.();
    sprite?.material?.map?.dispose?.();
    sprite?.material?.dispose?.();
  }
}

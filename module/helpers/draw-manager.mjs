// Draw Manager for SpaceHolder — shot trajectory rendering with history + fade.

const SHOT_FADE_MS = 60_000;
const AGED_TINT = 0x888888;
const AGED_BASE_ALPHA = 0.55;
const ACTIVE_ALPHA = 1;

export class DrawManager {
  constructor() {
    this.drawContainer = null;
    /** @type {Array<{ container: PIXI.Container, createdAt: number, active: boolean }>} */
    this.shotLayers = [];
    /** @deprecated kept for callers that still inspect elements; mirrors all layer children */
    this.currentDrawnElements = [];
    this._fadeRaf = null;

    this.defaultStyles = {
      line: { color: 0xFF4444, alpha: 0.9, width: 4 },
      circle: { color: 0xFF4444, alpha: 0.6, lineWidth: 3, fillAlpha: 0.2 },
      cone: { color: 0xFF8844, alpha: 0.7, lineWidth: 2, fillAlpha: 0.15 },
      hit: { color: 0xFF0000, alpha: 0.9, radius: 8, lineWidth: 2 },
    };
  }

  initialize() {
    this._createContainer();
  }

  _createContainer() {
    if (!canvas?.stage || !canvas.effects) return;

    if (!this.drawContainer || this.drawContainer.destroyed) {
      this.drawContainer = new PIXI.Container();
      this.drawContainer.name = 'drawManager';
      this.drawContainer.zIndex = 1000;
      this.drawContainer.interactiveChildren = false;
      this.drawContainer.interactive = false;
      canvas.effects.addChild(this.drawContainer);
    }
  }

  /**
   * Draw a shot as a new layer. Previous layers stay and age (gray → fade out).
   * @param {Object} shotResult
   */
  drawShot(shotResult) {
    if (!shotResult || !shotResult.shotPaths) {
      console.warn('DrawManager: Invalid shotResult provided');
      return;
    }

    this._createContainer();
    if (!this.drawContainer) return;

    this._demoteActiveLayers();

    const layer = new PIXI.Container();
    layer.name = `drawManager_shot_${Date.now()}`;
    layer.interactive = false;
    layer.interactiveChildren = false;
    layer.alpha = 0;
    this.drawContainer.addChild(layer);

    const prevTarget = this._layerTarget;
    this._layerTarget = layer;

    for (const segment of shotResult.shotPaths) {
      this.drawSegment(segment);
    }
    if (shotResult.shotHits?.length) {
      shotResult.shotHits.forEach((hit, index) => this.drawHit(hit, index));
    }

    this._layerTarget = prevTarget;

    const entry = { container: layer, createdAt: Date.now(), active: true };
    this.shotLayers.push(entry);
    this._rebuildElementIndex();
    this._animateLayerAppearance(layer, ACTIVE_ALPHA);
    this._ensureFadeLoop();
  }

  _demoteActiveLayers() {
    for (const entry of this.shotLayers) {
      if (!entry.active) continue;
      entry.active = false;
      const c = entry.container;
      if (!c || c.destroyed) continue;
      c.tint = AGED_TINT;
      if (c.alpha > AGED_BASE_ALPHA) c.alpha = AGED_BASE_ALPHA;
    }
  }

  _layerParent() {
    return this._layerTarget || this.drawContainer;
  }

  _track(graphics) {
    const parent = this._layerParent();
    if (!parent) return;
    parent.addChild(graphics);
    this.currentDrawnElements.push(graphics);
  }

  drawSegment(segment) {
    if (!segment?.type) {
      console.warn('DrawManager: Invalid segment provided');
      return;
    }
    switch (segment.type) {
      case 'line':
        this.drawLine(segment);
        break;
      case 'circle':
        this.drawCircle(segment);
        break;
      case 'cone':
        this.drawCone(segment);
        break;
      case 'swing':
        this.drawSwing(segment);
        break;
      case 'swingFan':
      case 'legacySwing':
        // Stepped-cone legacy swing is expanded to cones by shot-manager;
        // if a raw fan segment appears, draw as cone fallback.
        this.drawCone(segment);
        break;
      default:
        console.warn(`DrawManager: Unknown segment type: ${segment.type}`);
    }
  }

  drawLine(segment) {
    if (!segment.start || !segment.end || !this._layerParent()) {
      console.warn('DrawManager: Invalid line segment data');
      return;
    }
    const g = new PIXI.Graphics();
    const style = this.defaultStyles.line;
    g.lineStyle(style.width, style.color, style.alpha);
    g.moveTo(segment.start.x, segment.start.y);
    g.lineTo(segment.end.x, segment.end.y);
    g.beginFill(style.color, style.alpha);
    g.drawCircle(segment.start.x, segment.start.y, Math.max(2, style.width - 1));
    g.endFill();
    g.name = `drawManager_line_${segment.id || 'unknown'}`;
    g.interactive = false;
    g.interactiveChildren = false;
    this._track(g);
  }

  drawCircle(segment) {
    if (!segment.start || !segment.range || !this._layerParent()) {
      console.warn('DrawManager: Invalid circle segment data');
      return;
    }
    const g = new PIXI.Graphics();
    const style = this.defaultStyles.circle;
    g.lineStyle(style.lineWidth, style.color, style.alpha);
    g.beginFill(style.color, style.fillAlpha);
    g.drawCircle(segment.start.x, segment.start.y, segment.range);
    g.endFill();
    g.beginFill(style.color, style.alpha);
    g.drawCircle(segment.start.x, segment.start.y, 3);
    g.endFill();
    g.name = `drawManager_circle_${segment.id || 'unknown'}`;
    g.interactive = false;
    g.interactiveChildren = false;
    this._track(g);
  }

  drawCone(segment) {
    if (!segment.start || !segment.range || segment.angle === undefined
      || segment.direction === undefined || !this._layerParent()) {
      console.warn('DrawManager: Invalid cone segment data');
      return;
    }
    const g = new PIXI.Graphics();
    const style = this.defaultStyles.cone;
    g.lineStyle(style.lineWidth, style.color, style.alpha);
    g.beginFill(style.color, style.fillAlpha);

    const centerX = segment.start.x;
    const centerY = segment.start.y;
    const radius = segment.range;
    const angleRad = (segment.angle * Math.PI) / 180;
    const directionRad = (segment.direction * Math.PI) / 180;
    const cutRadius = segment.cut || 0;
    const startAngle = directionRad - angleRad / 2;
    const endAngle = directionRad + angleRad / 2;

    if (cutRadius <= 0) {
      g.moveTo(centerX, centerY);
      g.lineTo(centerX + Math.cos(startAngle) * radius, centerY + Math.sin(startAngle) * radius);
      g.arc(centerX, centerY, radius, startAngle, endAngle);
      g.lineTo(centerX, centerY);
    } else {
      const outerStartX = centerX + Math.cos(startAngle) * radius;
      const outerStartY = centerY + Math.sin(startAngle) * radius;
      g.moveTo(outerStartX, outerStartY);
      g.arc(centerX, centerY, radius, startAngle, endAngle);
      g.lineTo(centerX + Math.cos(endAngle) * cutRadius, centerY + Math.sin(endAngle) * cutRadius);
      g.arc(centerX, centerY, cutRadius, endAngle, startAngle, true);
      g.lineTo(outerStartX, outerStartY);
    }
    g.endFill();
    g.beginFill(style.color, style.alpha);
    g.drawCircle(centerX, centerY, 3);
    g.endFill();
    g.name = `drawManager_cone_${segment.id || 'unknown'}`;
    g.interactive = false;
    g.interactiveChildren = false;
    this._track(g);
  }

  /**
   * New swing: cone outline + sweeping edge line (visual).
   * @param {Object} segment
   */
  drawSwing(segment) {
    if (!segment.start || !segment.range || segment.angle === undefined
      || segment.direction === undefined || !this._layerParent()) {
      console.warn('DrawManager: Invalid swing segment data');
      return;
    }
    // Cone guide (aged look of area)
    this.drawCone({ ...segment, type: 'cone' });

    const centerX = segment.start.x;
    const centerY = segment.start.y;
    const radius = segment.range;
    const cut = Math.max(0, Number(segment.cut) || 0);
    const angleRad = (segment.angle * Math.PI) / 180;
    const directionRad = (segment.direction * Math.PI) / 180;
    const side = String(segment.side || 'right').toLowerCase();
    const startA = directionRad - angleRad / 2;
    const endA = directionRad + angleRad / 2;
    // Edge at end of swing for a static “after swing” pose.
    const edgeA = side === 'left' ? startA : endA;

    const g = new PIXI.Graphics();
    const style = this.defaultStyles.line;
    g.lineStyle(style.width + 1, 0xFFCC66, style.alpha);
    const inner = cut > 0 ? cut : 0;
    g.moveTo(centerX + Math.cos(edgeA) * inner, centerY + Math.sin(edgeA) * inner);
    g.lineTo(centerX + Math.cos(edgeA) * radius, centerY + Math.sin(edgeA) * radius);
    g.name = `drawManager_swing_${segment.id || 'unknown'}`;
    g.interactive = false;
    g.interactiveChildren = false;
    this._track(g);
  }

  drawHit(hit, index) {
    if (!hit?.point || !this._layerParent()) {
      console.warn('DrawManager: Invalid hit data');
      return;
    }
    const g = new PIXI.Graphics();
    const style = this.defaultStyles.hit;

    if (hit.hitPoints && Array.isArray(hit.hitPoints) && hit.hitPoints.length > 0) {
      g.beginFill(style.color, style.alpha * 0.6);
      for (const point of hit.hitPoints) g.drawCircle(point.x, point.y, 3);
      g.endFill();
      g.lineStyle(style.lineWidth, style.color, style.alpha);
      g.drawCircle(hit.point.x, hit.point.y, style.radius * 0.7);
      g.beginFill(style.color, style.alpha);
      g.drawCircle(hit.point.x, hit.point.y, 4);
      g.endFill();
    } else {
      g.lineStyle(style.lineWidth, style.color, style.alpha);
      g.moveTo(hit.point.x - style.radius, hit.point.y);
      g.lineTo(hit.point.x + style.radius, hit.point.y);
      g.moveTo(hit.point.x, hit.point.y - style.radius);
      g.lineTo(hit.point.x, hit.point.y + style.radius);
      g.lineStyle(style.lineWidth, style.color, style.alpha * 0.7);
      g.drawCircle(hit.point.x, hit.point.y, style.radius * 0.7);
      g.beginFill(style.color, style.alpha);
      g.drawCircle(hit.point.x, hit.point.y, 2);
      g.endFill();
    }
    g.name = `drawManager_hit_${index}`;
    g.interactive = false;
    g.interactiveChildren = false;
    this._track(g);
  }

  _animateLayerAppearance(layer, targetAlpha) {
    if (!layer || layer.destroyed) return;
    layer.alpha = 0;
    const startTime = Date.now();
    const fadeInDuration = 200;
    const tick = () => {
      if (!layer || layer.destroyed) return;
      const progress = Math.min((Date.now() - startTime) / fadeInDuration, 1);
      layer.alpha = progress * targetAlpha;
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _ensureFadeLoop() {
    if (this._fadeRaf) return;
    const tick = () => {
      this._fadeRaf = null;
      const now = Date.now();
      let anyLeft = false;
      const keep = [];
      for (const entry of this.shotLayers) {
        const c = entry.container;
        if (!c || c.destroyed) continue;
        if (entry.active) {
          keep.push(entry);
          anyLeft = true;
          continue;
        }
        const age = now - entry.createdAt;
        if (age >= SHOT_FADE_MS) {
          c.destroy({ children: true });
          continue;
        }
        const t = age / SHOT_FADE_MS;
        c.alpha = AGED_BASE_ALPHA * (1 - t);
        c.tint = AGED_TINT;
        keep.push(entry);
        anyLeft = true;
      }
      this.shotLayers = keep;
      this._rebuildElementIndex();
      if (anyLeft) this._fadeRaf = requestAnimationFrame(tick);
    };
    this._fadeRaf = requestAnimationFrame(tick);
  }

  _rebuildElementIndex() {
    this.currentDrawnElements = [];
    for (const entry of this.shotLayers) {
      const c = entry.container;
      if (!c || c.destroyed) continue;
      for (const child of c.children) this.currentDrawnElements.push(child);
    }
  }

  clearAll() {
    if (this._fadeRaf) {
      cancelAnimationFrame(this._fadeRaf);
      this._fadeRaf = null;
    }
    for (const entry of this.shotLayers) {
      const c = entry.container;
      if (c && !c.destroyed) c.destroy({ children: true });
    }
    this.shotLayers = [];
    this.currentDrawnElements = [];
  }

  setStyles(styles) {
    if (styles.line) this.defaultStyles.line = { ...this.defaultStyles.line, ...styles.line };
    if (styles.circle) this.defaultStyles.circle = { ...this.defaultStyles.circle, ...styles.circle };
    if (styles.cone) this.defaultStyles.cone = { ...this.defaultStyles.cone, ...styles.cone };
    if (styles.hit) this.defaultStyles.hit = { ...this.defaultStyles.hit, ...styles.hit };
  }

  destroy() {
    this.clearAll();
    if (this.drawContainer && !this.drawContainer.destroyed) {
      this.drawContainer.destroy();
    }
    this.drawContainer = null;
  }
}

// Draw Manager for SpaceHolder — shot trajectory rendering.
// Every shot is its own layer whose brightness depends only on the shot's age (see shot-trail.mjs),
// so trails fade out by themselves whatever the shooter is doing. Layers come from shot records:
// drawn at once by the shooter, by the other clients when the socket brings the shot, and (for a client that
// missed it, or after a reload) from the attack logs in the chat.

import {
  DEFAULT_SHOT_TRAIL_FADE_SECONDS,
  chainLinePaths,
  getShotTrailFadeSeconds,
  SHOT_TRAIL_SOCKET_TYPE,
  makeShotId,
  readShotRecords,
  sanitizeShotRecord,
  shotTrailAlpha,
  shotTrailFadeMs,
  trailNowMs,
} from './shot-trail.mjs';

/** Fade-in of a freshly fired shot (ms). */
const APPEAR_MS = 200;
/** Only a shot younger than this fades in; older ones (page reload, scene change) show at once. */
const APPEAR_MAX_AGE_MS = 1000;
/** Trails kept at once. The oldest beyond this fade out quickly (guards auto-fire). */
const MAX_LIVE_LAYERS = 150;
/** Quick fade-out of a trail pushed over `MAX_LIVE_LAYERS` (ms). */
const EVICT_MS = 500;

export class DrawManager {
  constructor() {
    this.drawContainer = null;
    /**
     * Drawn trails by shot id, oldest first.
     * @type {Map<string, { id: string, container: PIXI.Container, t: number, appearAt: number|null, evictedAt: number|null }>}
     */
    this.layers = new Map();
    /** Trail lifetime in ms (client setting `shotTrailFadeSeconds`). */
    this.fadeMs = shotTrailFadeMs(DEFAULT_SHOT_TRAIL_FADE_SECONDS);
    this._fadeRaf = null;
    this._hookIds = null;
    this._socketBound = false;

    this.defaultStyles = {
      line: { color: 0xFF4444, alpha: 0.9, width: 4 },
      circle: { color: 0xFF4444, alpha: 0.6, lineWidth: 3, fillAlpha: 0.2 },
      cone: { color: 0xFF8844, alpha: 0.7, lineWidth: 2, fillAlpha: 0.15 },
      hit: { color: 0xFF0000, alpha: 0.9, radius: 8, lineWidth: 2 },
      wallPass: { color: 0xFFC247, alpha: 0.95, radius: 6, lineWidth: 2 },
    };
  }

  /**
   * Start-up (`ready`): listen for shots and canvas changes, and redraw the trails that are still
   * fresh in the chat log (page reload).
   */
  initialize() {
    this._installHooks();
    this._installSocket();
    this.applyFadeSetting();
    this._createContainer();
    this.rehydrateFromChat();
  }

  /** Re-read the trail lifetime from the client setting. */
  applyFadeSetting() {
    this.fadeMs = shotTrailFadeMs(getShotTrailFadeSeconds());
  }

  _installHooks() {
    if (this._hookIds) return;
    this._hookIds = [
      ['createChatMessage', Hooks.on('createChatMessage', (message) => this._onChatMessage(message))],
      ['canvasReady', Hooks.on('canvasReady', () => this._onCanvasReady())],
      ['canvasTearDown', Hooks.on('canvasTearDown', () => this.clearAll())],
    ];
  }

  _socketName() {
    try {
      return `system.${game.system.id}`;
    } catch (_) {
      return 'system.spaceholder';
    }
  }

  /** Listen for the trails the other clients' shooters send. */
  _installSocket() {
    if (this._socketBound) return;
    try {
      game.socket.on(this._socketName(), (message) => this._onSocketMessage(message));
      this._socketBound = true;
    } catch (error) {
      console.error('SpaceHolder | DrawManager: socket unavailable', error);
    }
  }

  /**
   * Send a freshly fired shot's record to the other clients, which draw it at once (the shooter has
   * drawn it already). Whoever misses it still gets it from the attack log in chat.
   * @param {object} record ShotRecord
   */
  broadcastRecord(record) {
    if (!record?.id) return;
    try {
      game.socket.emit(this._socketName(), { type: SHOT_TRAIL_SOCKET_TYPE, record });
    } catch (error) {
      console.warn('SpaceHolder | DrawManager: could not send a shot trail', error);
    }
  }

  _onSocketMessage(message) {
    try {
      if (message?.type !== SHOT_TRAIL_SOCKET_TYPE || !canvas?.ready) return;
      const record = sanitizeShotRecord(message.record);
      if (!record || record.quiet) return;
      this.drawRecord(record);
    } catch (error) {
      console.error('SpaceHolder | DrawManager: failed to draw a shot from the socket', error);
    }
  }

  /** A chat message arrived (own or someone else's): draw the trails of the attack it reports. */
  _onChatMessage(message) {
    try {
      if (!canvas?.ready) return;
      for (const record of readShotRecords(message)) {
        if (!record.quiet) this.drawRecord(record);
      }
    } catch (error) {
      console.error('SpaceHolder | DrawManager: failed to draw a shot from chat', error);
    }
  }

  /** New scene on screen: drop the old trails and redraw the fresh ones that belong to this scene. */
  _onCanvasReady() {
    try {
      this.clearAll();
      this._createContainer();
      this.rehydrateFromChat();
    } catch (error) {
      console.error('SpaceHolder | DrawManager: failed to restore shot trails', error);
    }
  }

  _createContainer() {
    if (!canvas?.stage || !canvas.effects) return;

    if (!this.drawContainer || this.drawContainer.destroyed) {
      this.drawContainer = new PIXI.Container();
      this.drawContainer.name = 'drawManager';
      this.drawContainer.zIndex = 1000;
      this.drawContainer.interactiveChildren = false;
      this.drawContainer.interactive = false;
    }
    if (this.drawContainer.parent !== canvas.effects) canvas.effects.addChild(this.drawContainer);
  }

  /**
   * Redraw, from the chat log, the trails of this scene that have not faded out yet.
   * @returns {number} how many trails were drawn
   */
  rehydrateFromChat() {
    if (!canvas?.ready || !canvas.scene) return 0;
    const sceneId = canvas.scene.id;
    const now = trailNowMs();
    const records = [];
    for (const message of game.messages?.contents ?? []) {
      for (const record of readShotRecords(message)) {
        if (record.quiet) continue;
        if (record.sceneId && record.sceneId !== sceneId) continue;
        if (now - record.t >= this.fadeMs) continue;
        records.push(record);
      }
    }
    records.sort((a, b) => a.t - b.t);
    let drawn = 0;
    for (const record of records.slice(-MAX_LIVE_LAYERS)) {
      if (this.drawRecord(record)) drawn += 1;
    }
    return drawn;
  }

  /**
   * Draw a shot result as a fresh trail. Kept for macros and tests; the game itself draws shot
   * records (see `drawRecord`).
   * @param {{shotPaths: object[], shotHits?: object[], wallPasses?: object[]}} shotResult
   * @returns {boolean} whether a trail was drawn
   */
  drawShot(shotResult) {
    if (!shotResult || !shotResult.shotPaths) {
      console.warn('DrawManager: Invalid shotResult provided');
      return false;
    }
    return this.drawRecord({
      id: makeShotId(),
      t: trailNowMs(),
      paths: shotResult.shotPaths,
      hits: shotResult.shotHits ?? [],
      wallPasses: shotResult.wallPasses ?? [],
    });
  }

  /**
   * Draw a shot record as a trail that fades with the shot's age. A record that is already drawn,
   * belongs to another scene, or has faded out is ignored, so it is safe to offer the same shot
   * from several sources (local fire + chat message).
   * @param {{id: string, t?: number, sceneId?: string, paths: object[], hits?: object[], wallPasses?: object[]}} record
   * @returns {boolean} whether a trail was drawn
   */
  drawRecord(record) {
    if (!record?.id || !Array.isArray(record.paths)) {
      console.warn('DrawManager: Invalid shot record provided');
      return false;
    }
    if (this.layers.has(record.id)) return false;
    if (record.sceneId && canvas?.scene && record.sceneId !== canvas.scene.id) return false;

    const now = trailNowMs();
    const t = Number.isFinite(Number(record.t)) ? Number(record.t) : now;
    const age = Math.max(0, now - t);
    if (age >= this.fadeMs) return false;

    this._createContainer();
    if (!this.drawContainer) return false;

    const layer = new PIXI.Container();
    layer.name = `drawManager_shot_${record.id}`;
    layer.interactive = false;
    layer.interactiveChildren = false;
    this.drawContainer.addChild(layer);

    const prevTarget = this._layerTarget;
    this._layerTarget = layer;
    try {
      for (const segment of chainLinePaths(record.paths)) this.drawSegment(segment);
      if (Array.isArray(record.hits)) record.hits.forEach((hit, index) => this.drawHit(hit, index));
      if (Array.isArray(record.wallPasses)) {
        record.wallPasses.forEach((pass, index) => this.drawWallPass(pass, index));
      }
    } finally {
      this._layerTarget = prevTarget;
    }

    const fadesIn = age < APPEAR_MAX_AGE_MS;
    layer.alpha = fadesIn ? 0 : shotTrailAlpha(age, this.fadeMs);
    this.layers.set(record.id, {
      id: record.id,
      container: layer,
      t,
      appearAt: fadesIn ? performance.now() : null,
      evictedAt: null,
    });
    this._evictOverflow();
    this._ensureFadeLoop();
    return true;
  }

  _layerParent() {
    return this._layerTarget || this.drawContainer;
  }

  _track(graphics) {
    const parent = this._layerParent();
    if (!parent) return;
    parent.addChild(graphics);
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

  /**
   * A straight trail, or a polyline when the segment carries `points` (see `chainLinePaths`). Round
   * caps and joins keep a bend smooth; no mark is drawn at the start or at the bends — the trail
   * shows something flying, not a geometric figure.
   * @param {{start?: {x:number,y:number}, end?: {x:number,y:number}, points?: Array<{x:number,y:number}>}} segment
   */
  drawLine(segment) {
    const points = Array.isArray(segment.points) && segment.points.length >= 2
      ? segment.points
      : [segment.start, segment.end];
    if (!points.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)) || !this._layerParent()) {
      console.warn('DrawManager: Invalid line segment data');
      return;
    }
    const g = new PIXI.Graphics();
    const style = this.defaultStyles.line;
    g.lineStyle({
      width: style.width,
      color: style.color,
      alpha: style.alpha,
      cap: PIXI.LINE_CAP.ROUND,
      join: PIXI.LINE_JOIN.ROUND,
    });
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) g.lineTo(points[i].x, points[i].y);
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
    // Edge where the blow stopped (shot-manager's `edgeDeg`), else the end of the arc: a static
    // “after swing” pose.
    const stoppedAt = Number(segment.edgeDeg);
    const edgeA = Number.isFinite(stoppedAt)
      ? (stoppedAt * Math.PI) / 180
      : (side === 'left' ? startA : endA);

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

  /**
   * A wall the projectile went through: a ring on the face it entered and one on the face it left,
   * joined by a line. (A wall that stopped the shot is an ordinary hit mark.)
   * @param {{entryPoint: {x:number,y:number}, exitPoint?: {x:number,y:number}|null, penetrated?: boolean}} pass
   * @param {number} index
   */
  drawWallPass(pass, index) {
    if (!pass?.penetrated || !pass.entryPoint || !this._layerParent()) return;
    const style = this.defaultStyles.wallPass;
    const g = new PIXI.Graphics();
    g.lineStyle(style.lineWidth, style.color, style.alpha);
    g.drawCircle(pass.entryPoint.x, pass.entryPoint.y, style.radius);
    if (pass.exitPoint) {
      g.moveTo(pass.entryPoint.x, pass.entryPoint.y);
      g.lineTo(pass.exitPoint.x, pass.exitPoint.y);
      g.drawCircle(pass.exitPoint.x, pass.exitPoint.y, style.radius);
    }
    g.name = `drawManager_wallPass_${index}`;
    g.interactive = false;
    g.interactiveChildren = false;
    this._track(g);
  }

  /** Trails beyond `MAX_LIVE_LAYERS` (oldest first) start a quick fade-out. */
  _evictOverflow() {
    const live = [...this.layers.values()].filter((entry) => entry.evictedAt == null);
    const surplus = live.length - MAX_LIVE_LAYERS;
    if (surplus <= 0) return;
    const now = performance.now();
    for (let i = 0; i < surplus; i += 1) live[i].evictedAt = now;
  }

  /**
   * Set every trail's brightness from its age. The only place that writes a layer's alpha, so the
   * fade-in, the age fade and the overflow fade-out cannot fight each other.
   */
  _updateLayers() {
    const now = trailNowMs();
    const frameTime = performance.now();
    for (const [id, entry] of this.layers) {
      const container = entry.container;
      if (!container || container.destroyed) {
        this.layers.delete(id);
        continue;
      }
      let alpha = shotTrailAlpha(now - entry.t, this.fadeMs);
      if (entry.appearAt != null) {
        const progress = (frameTime - entry.appearAt) / APPEAR_MS;
        if (progress >= 1) entry.appearAt = null;
        else alpha *= Math.max(0, progress);
      }
      if (entry.evictedAt != null) {
        alpha *= Math.max(0, 1 - (frameTime - entry.evictedAt) / EVICT_MS);
      }
      if (alpha <= 0.001) {
        container.destroy({ children: true });
        this.layers.delete(id);
        continue;
      }
      if (Math.abs(container.alpha - alpha) > 0.002) container.alpha = alpha;
    }
  }

  /** Run the per-frame update while there are trails; it stops itself when the last one is gone. */
  _ensureFadeLoop() {
    if (this._fadeRaf || !this.layers.size) return;
    const tick = () => {
      this._fadeRaf = null;
      this._updateLayers();
      if (this.layers.size) this._fadeRaf = requestAnimationFrame(tick);
    };
    this._fadeRaf = requestAnimationFrame(tick);
  }

  /** Remove every trail at once (also used on scene change). Trails normally fade out by themselves. */
  clearAll() {
    if (this._fadeRaf) {
      cancelAnimationFrame(this._fadeRaf);
      this._fadeRaf = null;
    }
    for (const entry of this.layers.values()) {
      const container = entry.container;
      if (container && !container.destroyed) container.destroy({ children: true });
    }
    this.layers.clear();
  }

  setStyles(styles) {
    if (styles.line) this.defaultStyles.line = { ...this.defaultStyles.line, ...styles.line };
    if (styles.circle) this.defaultStyles.circle = { ...this.defaultStyles.circle, ...styles.circle };
    if (styles.cone) this.defaultStyles.cone = { ...this.defaultStyles.cone, ...styles.cone };
    if (styles.hit) this.defaultStyles.hit = { ...this.defaultStyles.hit, ...styles.hit };
  }

  destroy() {
    this.clearAll();
    for (const [name, id] of this._hookIds ?? []) Hooks.off(name, id);
    this._hookIds = null;
    if (this.drawContainer && !this.drawContainer.destroyed) {
      this.drawContainer.destroy();
    }
    this.drawContainer = null;
  }
}

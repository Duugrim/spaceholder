// Influence Manager для SpaceHolder - управление сферами влияния
// Собирает данные с Global Objects и рисует объединённые территории

export class InfluenceManager {
  constructor() {
    // Контейнер для графики
    this.influenceContainer = null;
    this.currentElements = [];
    
    // Цвета по умолчанию для сторон
    this.defaultColors = {
      'neutral': 0x808080,
      'ally': 0x00AA00,
      'enemy': 0xAA0000,
      'faction1': 0x0088FF,
      'faction2': 0xFF8800,
      'faction3': 0xFF00FF
    };
  }
  
  /**
   * Инициализация менеджера
   */
  initialize() {
    this._createContainer();
  }
  
  /**
   * Создание графического контейнера
   * @private
   */
  _createContainer() {
    if (!canvas?.stage || !canvas.effects) return;
    
    if (!this.influenceContainer || this.influenceContainer.destroyed) {
      this.influenceContainer = new PIXI.Container();
      this.influenceContainer.name = 'influenceManager';
      
      // Размещаем под токенами но над фоном
      this.influenceContainer.zIndex = 50;
      
      // Делаем контейнер неинтерактивным
      this.influenceContainer.interactiveChildren = false;
      this.influenceContainer.interactive = false;
      
      canvas.effects.addChild(this.influenceContainer);
    }
  }
  
  /**
   * Собрать данные со всех Global Objects на сцене
   * @returns {Array} Массив объектов {token, gRange, gPower, gSide, position}
   */
  collectGlobalObjects() {
    const objects = [];
    
    if (!canvas.tokens) return objects;
    
    for (const token of canvas.tokens.placeables) {
      // Проверяем, является ли актор типом globalobject
      if (token.actor?.type !== 'globalobject') continue;
      
      const system = token.actor.system;
      if (!system) continue;
      
      objects.push({
        token: token,
        gRange: system.gRange || 0,
        gPower: system.gPower || 1,
        gSide: system.gSide || 'neutral',
        position: {
          x: token.center.x,
          y: token.center.y
        }
      });
    }
    
    return objects;
  }
  
  /**
   * Группировать объекты по gSide
   * @param {Array} objects - массив Global Objects
   * @returns {Object} Объект {side: [objects]}
   */
  groupBySide(objects) {
    const groups = {};
    
    for (const obj of objects) {
      const side = obj.gSide;
      if (!groups[side]) {
        groups[side] = [];
      }
      groups[side].push(obj);
    }
    
    return groups;
  }
  
  /**
   * Получить цвет для стороны
   * @param {string} side
   * @returns {number} PIXI color
   */
  getColorForSide(side) {
    return this.defaultColors[side] || 0x808080;
  }
  
  /**
   * Нарисовать сферы влияния (простая версия - отдельные круги)
   */
  drawInfluenceZones() {
    // Очищаем предыдущую графику
    this.clearAll();
    
    // Убеждаемся что контейнер существует
    this._createContainer();
    
    // Собираем данные
    const objects = this.collectGlobalObjects();
    
    if (objects.length === 0) {
      console.log('InfluenceManager: No Global Objects found on scene');
      return;
    }
    
    console.log(`InfluenceManager: Found ${objects.length} Global Objects`);
    
    // Группируем по сторонам
    const groups = this.groupBySide(objects);
    console.log('InfluenceManager: Groups by side:', groups);
    
    // Рисуем каждую группу
    for (const [side, sideObjects] of Object.entries(groups)) {
      console.log(`InfluenceManager: Drawing ${sideObjects.length} objects for side "${side}"`);
      this._drawSideInfluence(side, sideObjects);
    }
  }
  
  /**
   * Нарисовать влияние одной стороны с объединением геометрии
   * @param {string} side - название стороны
   * @param {Array} objects - объекты этой стороны
   * @private
   */
  _drawSideInfluence(side, objects) {
    const color = this.getColorForSide(side);
    
    if (objects.length === 0) return;
    
    // Фильтруем объекты с валидным радиусом
    const validObjects = objects.filter(obj => obj.gRange > 0);
    if (validObjects.length === 0) return;
    
    // Если один объект — просто рисуем круг
    if (validObjects.length === 1) {
      this._drawSimpleCircle(validObjects[0], color, side);
      return;
    }
    
    // Объединяем геометрию всех кругов
    const unionPolygon = this._unionCircles(validObjects);
    
    if (!unionPolygon || unionPolygon.length === 0) {
      console.warn(`InfluenceManager: Failed to union circles for side ${side}`);
      // Fallback: рисуем отдельные круги
      validObjects.forEach(obj => this._drawSimpleCircle(obj, color, side));
      return;
    }
    
    // Рисуем объединённую геометрию
    this._drawUnionPolygon(unionPolygon, color, side);
    
    // Рисуем центральные точки источников
    validObjects.forEach(obj => {
      const centerGraphics = new PIXI.Graphics();
      centerGraphics.beginFill(color, 0.9);
      centerGraphics.drawCircle(obj.position.x, obj.position.y, 5);
      centerGraphics.endFill();
      centerGraphics.name = `influence_center_${side}_${obj.token.id}`;
      centerGraphics.interactive = false;
      this.influenceContainer.addChild(centerGraphics);
      this.currentElements.push(centerGraphics);
    });
  }
  
  /**
   * Нарисовать простой круг (для fallback или одиночных объектов)
   * @private
   */
  _drawSimpleCircle(obj, color, side) {
    const graphics = new PIXI.Graphics();
    graphics.lineStyle(2, color, 0.8);
    graphics.beginFill(color, 0.2);
    graphics.drawCircle(obj.position.x, obj.position.y, obj.gRange);
    graphics.endFill();
    graphics.name = `influence_${side}_${obj.token.id}`;
    graphics.interactive = false;
    this.influenceContainer.addChild(graphics);
    this.currentElements.push(graphics);
  }
  
  /**
   * Объединить несколько кругов в один полигон
   * @param {Array} objects - массив объектов с position и gRange
   * @returns {Array} Массив точек объединённого полигона
   * @private
   */
  _unionCircles(objects) {
    if (!objects || objects.length === 0) return null;
    
    // Количество сегментов для аппроксимации круга (больше = глаже, но медленнее)
    const segments = 64;
    
    // Преобразуем каждый круг в полигон
    const polygons = objects.map(obj => this._circleToPolygon(obj.position, obj.gRange, segments));
    
    // Используем ClipperLib для объединения
    try {
      // ClipperLib работает с целыми числами, масштабируем координаты
      const scale = 1000;
      const clipper = new ClipperLib.Clipper();
      
      // Добавляем первый полигон как subject
      const scaledFirst = this._scalePolygon(polygons[0], scale);
      clipper.AddPath(scaledFirst, ClipperLib.PolyType.ptSubject, true);
      
      // Добавляем остальные полигоны как clip (для union)
      for (let i = 1; i < polygons.length; i++) {
        const scaled = this._scalePolygon(polygons[i], scale);
        clipper.AddPath(scaled, ClipperLib.PolyType.ptClip, true);
      }
      
      // Выполняем Union
      const solution = new ClipperLib.Paths();
      clipper.Execute(ClipperLib.ClipType.ctUnion, solution, 
        ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
      
      if (solution.length === 0) return null;
      
      // Берём самый большой полигон из результата (может быть несколько отдельных областей)
      let largestPolygon = solution[0];
      for (let i = 1; i < solution.length; i++) {
        if (solution[i].length > largestPolygon.length) {
          largestPolygon = solution[i];
        }
      }
      
      // Масштабируем обратно
      return this._scalePolygon(largestPolygon, 1/scale);
      
    } catch (error) {
      console.error('InfluenceManager: ClipperLib union failed:', error);
      return null;
    }
  }
  
  /**
   * Преобразовать круг в полигон
   * @private
   */
  _circleToPolygon(center, radius, segments) {
    const points = [];
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      points.push({
        X: center.x + Math.cos(angle) * radius,
        Y: center.y + Math.sin(angle) * radius
      });
    }
    return points;
  }
  
  /**
   * Масштабировать полигон
   * @private
   */
  _scalePolygon(polygon, scale) {
    return polygon.map(p => ({
      X: Math.round(p.X * scale),
      Y: Math.round(p.Y * scale)
    }));
  }
  
  /**
   * Нарисовать объединённый полигон
   * @private
   */
  _drawUnionPolygon(polygon, color, side) {
    if (!polygon || polygon.length < 3) return;
    
    const graphics = new PIXI.Graphics();
    graphics.lineStyle(3, color, 0.9);
    graphics.beginFill(color, 0.25);
    
    // Рисуем полигон
    graphics.moveTo(polygon[0].X, polygon[0].Y);
    for (let i = 1; i < polygon.length; i++) {
      graphics.lineTo(polygon[i].X, polygon[i].Y);
    }
    graphics.closePath();
    graphics.endFill();
    
    graphics.name = `influence_union_${side}`;
    graphics.interactive = false;
    this.influenceContainer.addChild(graphics);
    this.currentElements.push(graphics);
  }
  
  /**
   * Очистить все нарисованные элементы
   */
  clearAll() {
    for (const element of this.currentElements) {
      element.destroy({ children: true });
    }
    this.currentElements = [];
    
    if (this.influenceContainer && !this.influenceContainer.destroyed) {
      this.influenceContainer.removeChildren();
    }
  }
  
  /**
   * Уничтожить менеджер
   */
  destroy() {
    this.clearAll();
    
    if (this.influenceContainer && !this.influenceContainer.destroyed) {
      this.influenceContainer.destroy({ children: true });
    }
    this.influenceContainer = null;
  }
}

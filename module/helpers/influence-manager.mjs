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
   * Нарисовать сферы влияния с учётом давления между фракциями
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
    
    // Используем новый метод с силовым полем
    this._drawInfluenceWithPressure(groups, objects);
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
  
  /**
   * Нарисовать зоны влияния с учётом давления между фракциями
   * @param {Object} groups - группы объектов по сторонам
   * @param {Array} allObjects - все объекты
   * @private
   */
  _drawInfluenceWithPressure(groups, allObjects) {
    if (!canvas?.dimensions) return;
    
    // Определяем границы области для расчёта
    const bounds = this._calculateBounds(allObjects);
    if (!bounds) return;
    
    // Размер ячейки сетки (в пикселях canvas)
    // Меньше значение = точнее, но медленнее
    const gridSize = canvas.grid.size || 100;
    const cellSize = gridSize / 2; // Половина размера клетки для баланса
    
    // Создаём карту доминирования для каждой фракции
    const factionTerritories = this._calculateFactionTerritories(groups, bounds, cellSize);
    
    // Рисуем территории каждой фракции
    for (const [side, territory] of Object.entries(factionTerritories)) {
      if (territory.length === 0) continue;
      
      const color = this.getColorForSide(side);
      this._drawTerritoryPolygons(territory, color, side);
    }
    
    // Рисуем центральные точки источников
    for (const obj of allObjects) {
      if (obj.gRange <= 0) continue;
      
      const color = this.getColorForSide(obj.gSide);
      const centerGraphics = new PIXI.Graphics();
      centerGraphics.beginFill(color, 0.9);
      centerGraphics.drawCircle(obj.position.x, obj.position.y, 5);
      centerGraphics.endFill();
      centerGraphics.name = `influence_center_${obj.gSide}_${obj.token.id}`;
      centerGraphics.interactive = false;
      this.influenceContainer.addChild(centerGraphics);
      this.currentElements.push(centerGraphics);
    }
  }
  
  /**
   * Вычислить границы области для расчёта влияния
   * @param {Array} objects - все объекты
   * @returns {Object} {minX, minY, maxX, maxY}
   * @private
   */
  _calculateBounds(objects) {
    if (objects.length === 0) return null;
    
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    for (const obj of objects) {
      if (obj.gRange <= 0) continue;
      
      minX = Math.min(minX, obj.position.x - obj.gRange);
      minY = Math.min(minY, obj.position.y - obj.gRange);
      maxX = Math.max(maxX, obj.position.x + obj.gRange);
      maxY = Math.max(maxY, obj.position.y + obj.gRange);
    }
    
    // Добавляем небольшой отступ
    const padding = 50;
    return {
      minX: minX - padding,
      minY: minY - padding,
      maxX: maxX + padding,
      maxY: maxY + padding
    };
  }
  
  /**
   * Вычислить силу влияния объекта в точке
   * @param {Object} obj - объект влияния
   * @param {number} x - координата X точки
   * @param {number} y - координата Y точки
   * @returns {number} сила влияния (0 если вне радиуса)
   * @private
   */
  _calculateInfluenceStrength(obj, x, y) {
    const dx = x - obj.position.x;
    const dy = y - obj.position.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // Если точка вне радиуса влияния - сила 0
    if (distance > obj.gRange) return 0;
    
    // Используем квадратичный спад влияния
    // Можно настроить: linear, quadratic, exponential
    const normalizedDistance = distance / obj.gRange; // 0..1
    const falloff = 1 - (normalizedDistance * normalizedDistance); // квадратичный спад
    
    // Умножаем на мощность объекта
    return falloff * obj.gPower;
  }
  
  /**
   * Вычислить территории каждой фракции на основе силового поля
   * @param {Object} groups - группы объектов по сторонам
   * @param {Object} bounds - границы области
   * @param {number} cellSize - размер ячейки сетки
   * @returns {Object} {side: [polygons]}
   * @private
   */
  _calculateFactionTerritories(groups, bounds, cellSize) {
    const territories = {};
    const sides = Object.keys(groups);
    
    // Инициализируем территории для каждой стороны
    for (const side of sides) {
      territories[side] = [];
    }
    
    // Создаём сетку точек и определяем доминирующую фракцию
    const dominanceGrid = [];
    const cols = Math.ceil((bounds.maxX - bounds.minX) / cellSize);
    const rows = Math.ceil((bounds.maxY - bounds.minY) / cellSize);
    
    for (let row = 0; row < rows; row++) {
      dominanceGrid[row] = [];
      for (let col = 0; col < cols; col++) {
        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + row * cellSize;
        
        // Вычисляем силу влияния каждой фракции в этой точке
        let maxStrength = 0;
        let dominantSide = null;
        
        for (const [side, objects] of Object.entries(groups)) {
          let totalStrength = 0;
          
          for (const obj of objects) {
            totalStrength += this._calculateInfluenceStrength(obj, x, y);
          }
          
          if (totalStrength > maxStrength) {
            maxStrength = totalStrength;
            dominantSide = side;
          }
        }
        
        dominanceGrid[row][col] = {
          side: dominantSide,
          strength: maxStrength,
          x: x,
          y: y
        };
      }
    }
    
    // Преобразуем сетку в полигоны для каждой фракции
    for (const side of sides) {
      const polygons = this._gridToPolygons(dominanceGrid, side, cellSize);
      territories[side] = polygons;
    }
    
    return territories;
  }
  
  /**
   * Преобразовать сетку доминирования в полигоны для конкретной стороны
   * @param {Array} grid - сетка доминирования
   * @param {string} side - сторона для которой строим полигоны
   * @param {number} cellSize - размер ячейки
   * @returns {Array} массив полигонов (ClipperLib format)
   * @private
   */
  _gridToPolygons(grid, side, cellSize) {
    if (!grid || grid.length === 0) return [];
    
    const rows = grid.length;
    const cols = grid[0].length;
    const scale = 1000; // для ClipperLib
    
    // Создаём список прямоугольников (ячеек) принадлежащих этой стороне
    const cells = [];
    
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = grid[row][col];
        
        if (cell.side === side && cell.strength > 0) {
          // Создаём прямоугольник для этой ячейки
          const halfCell = cellSize / 2;
          const rect = [
            { X: Math.round((cell.x - halfCell) * scale), Y: Math.round((cell.y - halfCell) * scale) },
            { X: Math.round((cell.x + halfCell) * scale), Y: Math.round((cell.y - halfCell) * scale) },
            { X: Math.round((cell.x + halfCell) * scale), Y: Math.round((cell.y + halfCell) * scale) },
            { X: Math.round((cell.x - halfCell) * scale), Y: Math.round((cell.y + halfCell) * scale) }
          ];
          cells.push(rect);
        }
      }
    }
    
    if (cells.length === 0) return [];
    
    // Объединяем все прямоугольники в единую геометрию
    try {
      const clipper = new ClipperLib.Clipper();
      
      // Добавляем первую ячейку как subject
      clipper.AddPath(cells[0], ClipperLib.PolyType.ptSubject, true);
      
      // Добавляем остальные ячейки и объединяем
      for (let i = 1; i < cells.length; i++) {
        clipper.AddPath(cells[i], ClipperLib.PolyType.ptClip, true);
      }
      
      const solution = new ClipperLib.Paths();
      clipper.Execute(ClipperLib.ClipType.ctUnion, solution,
        ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
      
      // Масштабируем обратно
      return solution.map(poly => this._scalePolygon(poly, 1/scale));
      
    } catch (error) {
      console.error('InfluenceManager: Failed to union grid cells:', error);
      return [];
    }
  }
  
  /**
   * Нарисовать полигоны территории
   * @param {Array} polygons - массив полигонов
   * @param {number} color - цвет
   * @param {string} side - название стороны
   * @private
   */
  _drawTerritoryPolygons(polygons, color, side) {
    if (!polygons || polygons.length === 0) return;
    
    for (let i = 0; i < polygons.length; i++) {
      const polygon = polygons[i];
      if (!polygon || polygon.length < 3) continue;
      
      const graphics = new PIXI.Graphics();
      graphics.lineStyle(3, color, 0.9);
      graphics.beginFill(color, 0.25);
      
      // Рисуем полигон
      graphics.moveTo(polygon[0].X, polygon[0].Y);
      for (let j = 1; j < polygon.length; j++) {
        graphics.lineTo(polygon[j].X, polygon[j].Y);
      }
      graphics.closePath();
      graphics.endFill();
      
      graphics.name = `influence_territory_${side}_${i}`;
      graphics.interactive = false;
      this.influenceContainer.addChild(graphics);
      this.currentElements.push(graphics);
    }
  }
}

// Influence Manager для SpaceHolder - управление сферами влияния
// Собирает данные с Global Objects и рисует объединённые территории

export class InfluenceManager {
  constructor() {
    // Контейнер для графики
    this.influenceContainer = null;
    this.currentElements = [];
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
      
      // Размещаем поверх глобальной карты
      this.influenceContainer.zIndex = 1000;
      
      // Делаем контейнер неинтерактивным
      this.influenceContainer.interactiveChildren = false;
      this.influenceContainer.interactive = false;
      
      canvas.effects.addChild(this.influenceContainer);
      
      // Включаем сортировку по zIndex для effects layer
      if (!canvas.effects.sortableChildren) {
        canvas.effects.sortableChildren = true;
        canvas.effects.sortChildren();
      }
    }
  }
  
  /**
   * Собрать данные со всех Global Objects на сцене
   * @returns {Array} Массив объектов {token, gRange, gPower, gFaction, position}
   */
  collectGlobalObjects() {
    const objects = [];
    
    if (!canvas.tokens) return objects;
    
    // Размер клетки сцены в пикселях
    const gridSize = canvas.grid.size || 100;
    
    for (const token of canvas.tokens.placeables) {
      // Проверяем, является ли актор типом globalobject
      if (token.actor?.type !== 'globalobject') continue;
      
      const system = token.actor.system;
      if (!system) continue;
      
      // Конвертируем gRange из единиц сетки×100 в пиксели
      // Например: gRange=500 и gridSize=100 → 5 клеток → 500 пикселей
      const rangeInGridUnits = (system.gRange || 0) / 100; // 500 → 5
      const rangeInPixels = rangeInGridUnits * gridSize; // 5 × 100 = 500

      // Фракция: по умолчанию — UUID связанного Journal (system.gFaction).
      // Для обратной совместимости: если UUID не задан, используем legacy system.gSide.
      const factionUuid = this._normalizeUuid(system.gFaction);
      const factionKey = factionUuid || system.gSide || 'neutral';
      
      objects.push({
        token: token,
        gRange: rangeInPixels,
        gPower: system.gPower || 1,
        gFaction: factionKey,
        position: {
          x: token.center.x,
          y: token.center.y
        }
      });
    }
    
    return objects;
  }
  
  /**
   * Группировать объекты по фракции (gFaction)
   * @param {Array} objects - массив Global Objects
   * @returns {Object} Объект {factionKey: [objects]}
   */
  groupByFaction(objects) {
    const groups = {};
    
    for (const obj of objects) {
      const key = obj.gFaction || 'neutral';
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(obj);
    }
    
    return groups;
  }
  
  /**
   * Получить цвет для фракции.
   * Правило:
   * - Если UUID указывает на JournalEntry и он лежит в Folder с заданным цветом — используем цвет папки.
   * - Иначе: детерминированный fallback-цвет по хэшу строки.
   * @param {string} side
   * @returns {number} PIXI color
   */
  getColorForSide(side) {
    const raw = String(side ?? '').trim();
    const key = this._normalizeUuid(raw) || raw || 'neutral';

    const folderColorHex = this._getFactionFolderColorHex(key);
    if (typeof folderColorHex === 'number') return folderColorHex;

    const hue = this._hashStringToHue(key);
    return this._hslToHex(hue, 65, 50);
  }

  /**
   * Получить цвет (0xRRGGBB) папки журнала фракции, если доступно.
   * @private
   */
  _getFactionFolderColorHex(factionKey) {
    const entry = this._resolveJournalEntryForUuid(factionKey);
    const color = entry?.folder?.color;
    const hex = this._cssColorToHex(color);
    return typeof hex === 'number' ? hex : null;
  }

  /**
   * Попытаться синхронно резолвнуть JournalEntry по UUID.
   * Поддерживает world UUID (JournalEntry.<id>[.JournalEntryPage.<id>]) и, если доступно, fromUuidSync.
   * @private
   */
  _resolveJournalEntryForUuid(rawUuid) {
    const uuid = this._normalizeUuid(rawUuid);
    if (!uuid) return null;

    // 1) Если доступен fromUuidSync — используем (может вернуть JournalEntryPage)
    if (typeof fromUuidSync === 'function') {
      try {
        let doc = fromUuidSync(uuid);
        if (doc?.documentName === 'JournalEntryPage' && doc.parent) doc = doc.parent;
        if (doc?.documentName === 'JournalEntry') return doc;
      } catch (e) {
        // ignore
      }
    }

    // 2) Быстрый путь для world UUID
    const parts = uuid.split('.');
    if (parts[0] === 'JournalEntry' && parts[1]) {
      return game?.journal?.get?.(parts[1]) || null;
    }

    return null;
  }

  /**
   * Преобразовать CSS hex (#RRGGBB или #RGB) в число 0xRRGGBB.
   * @private
   */
  _cssColorToHex(color) {
    const str = String(color ?? '').trim();
    if (!str) return null;

    const hex = str.startsWith('#') ? str.slice(1) : str;
    if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16);
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      const r = hex[0] + hex[0];
      const g = hex[1] + hex[1];
      const b = hex[2] + hex[2];
      return parseInt(r + g + b, 16);
    }

    return null;
  }

  /**
   * Нормализовать UUID-подобную строку (поддерживает @UUID[...]).
   * @private
   */
  _normalizeUuid(raw) {
    const str = String(raw ?? '').trim();
    if (!str) return '';
    const match = str.match(/@UUID\[(.+?)\]/);
    return (match?.[1] ?? str).trim();
  }

  /**
   * Преобразовать строку в hue (0..359)
   * @private
   */
  _hashStringToHue(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) % 360;
  }

  /**
   * HSL -> 0xRRGGBB
   * @private
   */
  _hslToHex(h, s, l) {
    const sat = (s ?? 0) / 100;
    const lig = (l ?? 0) / 100;
    const c = (1 - Math.abs(2 * lig - 1)) * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = lig - c / 2;

    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }

    const to255 = (v) => Math.max(0, Math.min(255, Math.round((v + m) * 255)));
    const rr = to255(r);
    const gg = to255(g);
    const bb = to255(b);
    return (rr << 16) + (gg << 8) + bb;
  }
  
  /**
   * Нарисовать сферы влияния с учётом давления между фракциями
   * @param {boolean} debug - отображать ли отладочные окружности gRange
   */
  drawInfluenceZones(debug = false) {
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
    
    // Группируем по фракциям
    const groups = this.groupByFaction(objects);
    console.log('InfluenceManager: Groups by faction:', groups);
    
    // Используем новый метод с силовым полем
    this._drawInfluenceWithPressure(groups, objects, debug);
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
   * @param {boolean} debug - отображать ли отладочные окружности
   * @private
   */
  _drawInfluenceWithPressure(groups, allObjects, debug = false) {
    if (!canvas?.dimensions) return;
    
    // Определяем границы области для расчёта
    const bounds = this._calculateBounds(allObjects);
    if (!bounds) return;
    
    // Размер ячейки сетки (в пикселях canvas)
    // Меньше значение = точнее, но медленнее
    const gridSize = canvas.grid.size || 100;
    const cellSize = gridSize / 4; // Уменьшаем для более плавных контуров
    
    // Используем метод метабольных шаров с Marching Squares
    this._drawInfluenceWithMetaballs(groups, bounds, cellSize);
    
    // Рисуем центральные точки источников (и опционально отладочные окружности)
    for (const obj of allObjects) {
      if (obj.gRange <= 0) continue;
      
      const color = this.getColorForSide(obj.gFaction);
      
      // Отладочная окружность радиуса gRange (только в режиме отладки)
      if (debug) {
        const debugCircle = new PIXI.Graphics();
        debugCircle.lineStyle(2, color, 0.5);
        debugCircle.drawCircle(obj.position.x, obj.position.y, obj.gRange);
        debugCircle.name = `influence_debug_circle_${obj.gFaction}_${obj.token.id}`;
        debugCircle.interactive = false;
        this.influenceContainer.addChild(debugCircle);
        this.currentElements.push(debugCircle);
      }
      
      // Центральная точка
      const centerGraphics = new PIXI.Graphics();
      centerGraphics.beginFill(color, 0.9);
      centerGraphics.drawCircle(obj.position.x, obj.position.y, 5);
      centerGraphics.endFill();
      centerGraphics.name = `influence_center_${obj.gFaction}_${obj.token.id}`;
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
  
  /**
   * Нарисовать зоны влияния используя метабольные шары (Metaballs)
   * @param {Object} groups - группы объектов по сторонам
   * @param {Object} bounds - границы области
   * @param {number} cellSize - размер ячейки сетки
   * @private
   */
  _drawInfluenceWithMetaballs(groups, bounds, cellSize) {
    const cols = Math.ceil((bounds.maxX - bounds.minX) / cellSize);
    const rows = Math.ceil((bounds.maxY - bounds.minY) / cellSize);
    
    // Вычисляем доминирование фракций (какая фракция доминирует в каждой точке)
    const dominanceField = this._calculateDominanceField(groups, bounds, cellSize, rows, cols);
    
    // Для каждой фракции строим изоконтуры её территории
    for (const [side, objects] of Object.entries(groups)) {
      if (objects.length === 0) continue;
      
      const validObjects = objects.filter(obj => obj.gRange > 0);
      if (validObjects.length === 0) continue;
      
      // Создаём поле силы влияния с учётом доминирования
      const territoryField = this._extractTerritoryFieldWithStrength(
        dominanceField, 
        validObjects, 
        side, 
        bounds, 
        cellSize, 
        rows, 
        cols
      );
      
      // Используем Marching Squares для построения изоконтуров
      const threshold = 0.3; // Порог для предотвращения перекрытия зон
      const contours = this._marchingSquares(territoryField, rows, cols, bounds, cellSize, threshold);
      
      // Рисуем контуры
      const color = this.getColorForSide(side);
      this._drawMetaballContours(contours, color, side);
    }
  }
  
  /**
   * Вычислить поле доминирования фракций (учитывая конкуренцию)
   * @param {Object} groups - группы объектов по сторонам
   * @param {Object} bounds - границы области
   * @param {number} cellSize - размер ячейки
   * @param {number} rows - количество строк
   * @param {number} cols - количество столбцов
   * @returns {Array} двумерный массив с доминирующей стороной и силой
   * @private
   */
  _calculateDominanceField(groups, bounds, cellSize, rows, cols) {
    const field = [];
    
    for (let row = 0; row <= rows; row++) {
      field[row] = [];
      for (let col = 0; col <= cols; col++) {
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
        
        field[row][col] = {
          side: dominantSide,
          strength: maxStrength
        };
      }
    }
    
    return field;
  }
  
  /**
   * Извлечь поле территории с учётом реальной силы влияния
   * @param {Array} dominanceField - поле доминирования
   * @param {Array} objects - объекты этой фракции
   * @param {string} side - сторона
   * @param {Object} bounds - границы
   * @param {number} cellSize - размер ячейки
   * @param {number} rows - количество строк
   * @param {number} cols - количество столбцов
   * @returns {Array} двумерный массив значений 0-1
   * @private
   */
  _extractTerritoryFieldWithStrength(dominanceField, objects, side, bounds, cellSize, rows, cols) {
    const field = [];
    
    for (let row = 0; row <= rows; row++) {
      field[row] = [];
      for (let col = 0; col <= cols; col++) {
        const cell = dominanceField[row][col];
        
        // Только если эта фракция доминирует в этой точке
        if (cell.side === side) {
          // Вычисляем реальную силу влияния в этой точке
          const x = bounds.minX + col * cellSize;
          const y = bounds.minY + row * cellSize;
          
          let totalStrength = 0;
          for (const obj of objects) {
            totalStrength += this._calculateInfluenceStrength(obj, x, y);
          }
          
          // Нормализуем значение (0-1)
          field[row][col] = Math.min(totalStrength, 1);
        } else {
          // Чужая территория
          field[row][col] = 0;
        }
      }
    }
    
    return field;
  }
  
  /**
   * Алгоритм Marching Squares для построения изоконтуров
   * @param {Array} field - скалярное поле
   * @param {number} rows - количество строк
   * @param {number} cols - количество столбцов
   * @param {Object} bounds - границы области
   * @param {number} cellSize - размер ячейки
   * @param {number} threshold - порог для изоповерхности
   * @returns {Array} массив контуров
   * @private
   */
  _marchingSquares(field, rows, cols, bounds, cellSize, threshold) {
    const contours = [];
    
    // Проходим по каждой ячейке сетки
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        // Получаем значения в 4 углах ячейки
        const v0 = field[row][col];         // top-left
        const v1 = field[row][col + 1];     // top-right
        const v2 = field[row + 1][col + 1]; // bottom-right
        const v3 = field[row + 1][col];     // bottom-left
        
        // Определяем конфигурацию ячейки (какие углы выше порога)
        let config = 0;
        if (v0 >= threshold) config |= 1;
        if (v1 >= threshold) config |= 2;
        if (v2 >= threshold) config |= 4;
        if (v3 >= threshold) config |= 8;
        
        // Пропускаем полностью внутренние или внешние ячейки
        if (config === 0 || config === 15) continue;
        
        // Координаты углов ячейки
        const x0 = bounds.minX + col * cellSize;
        const y0 = bounds.minY + row * cellSize;
        const x1 = x0 + cellSize;
        const y1 = y0 + cellSize;
        
        // Вычисляем точки пересечения рёбер (используем линейную интерполяцию)
        const edges = [
          this._lerp2D({x: x0, y: y0}, {x: x1, y: y0}, v0, v1, threshold), // top
          this._lerp2D({x: x1, y: y0}, {x: x1, y: y1}, v1, v2, threshold), // right
          this._lerp2D({x: x1, y: y1}, {x: x0, y: y1}, v2, v3, threshold), // bottom
          this._lerp2D({x: x0, y: y1}, {x: x0, y: y0}, v3, v0, threshold)  // left
        ];
        
        // Добавляем сегменты линий в зависимости от конфигурации
        const segments = this._getMarchingSquaresSegments(config, edges);
        contours.push(...segments);
      }
    }
    
    return contours;
  }
  
  /**
   * Линейная интерполяция между двумя точками на основе значений поля
   * @private
   */
  _lerp2D(p0, p1, v0, v1, threshold) {
    if (Math.abs(v0 - v1) < 0.001) {
      return { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    }
    
    const t = (threshold - v0) / (v1 - v0);
    return {
      x: p0.x + t * (p1.x - p0.x),
      y: p0.y + t * (p1.y - p0.y)
    };
  }
  
  /**
   * Получить сегменты линий для конкретной конфигурации Marching Squares
   * @private
   */
  _getMarchingSquaresSegments(config, edges) {
    // Таблица сегментов для каждой из 16 конфигураций
    // Каждая конфигурация определяет, какие рёбра соединять
    const segmentTable = {
      0: [],
      1: [[edges[3], edges[0]]],
      2: [[edges[0], edges[1]]],
      3: [[edges[3], edges[1]]],
      4: [[edges[1], edges[2]]],
      5: [[edges[3], edges[0]], [edges[1], edges[2]]], // ambiguous case
      6: [[edges[0], edges[2]]],
      7: [[edges[3], edges[2]]],
      8: [[edges[2], edges[3]]],
      9: [[edges[2], edges[0]]],
      10: [[edges[0], edges[1]], [edges[2], edges[3]]], // ambiguous case
      11: [[edges[2], edges[1]]],
      12: [[edges[1], edges[3]]],
      13: [[edges[1], edges[0]]],
      14: [[edges[0], edges[3]]],
      15: []
    };
    
    return segmentTable[config] || [];
  }
  
  /**
   * Нарисовать контуры метабольных шаров
   * @param {Array} contours - массив сегментов линий
   * @param {number} color - цвет
   * @param {string} side - название стороны
   * @param {Object} dominanceField - поле доминирования
   * @private
   */
  _drawMetaballContours(contours, color, side, dominanceField) {
    if (!contours || contours.length === 0) return;
    
    // Соединяем сегменты в замкнутые контуры
    const closedContours = this._connectSegments(contours);
    
    // Определяем иерархию контуров (кто внутри кого)
    const hierarchy = this._buildContourHierarchy(closedContours);
    
    // Рисуем только внешние контуры (с дырками внутри)
    for (let i = 0; i < hierarchy.length; i++) {
      const item = hierarchy[i];
      if (item.parent !== -1) continue; // Пропускаем вложенные контуры
      
      const contour = item.contour;
      if (!contour || contour.length < 3) continue;
      
      const graphics = new PIXI.Graphics();
      graphics.lineStyle(3, color, 0.9);
      graphics.beginFill(color, 0.25);
      
      // Рисуем внешний контур
      graphics.moveTo(contour[0].x, contour[0].y);
      for (let j = 1; j < contour.length; j++) {
        graphics.lineTo(contour[j].x, contour[j].y);
      }
      graphics.closePath();
      
      // Добавляем дырки (внутренние контуры)
      for (let k = 0; k < hierarchy.length; k++) {
        if (hierarchy[k].parent === i) {
          const holeContour = hierarchy[k].contour;
          graphics.beginHole();
          graphics.moveTo(holeContour[0].x, holeContour[0].y);
          for (let j = 1; j < holeContour.length; j++) {
            graphics.lineTo(holeContour[j].x, holeContour[j].y);
          }
          graphics.closePath();
          graphics.endHole();
        }
      }
      
      graphics.endFill();
      
      graphics.name = `influence_metaball_${side}_${i}`;
      graphics.interactive = false;
      this.influenceContainer.addChild(graphics);
      this.currentElements.push(graphics);
    }
  }
  
  /**
   * Соединить сегменты линий в замкнутые контуры
   * @param {Array} segments - массив сегментов [[p1, p2], ...]
   * @returns {Array} массив замкнутых контуров
   * @private
   */
  _connectSegments(segments) {
    if (segments.length === 0) return [];
    
    const closedContours = [];
    const remainingSegments = [...segments];
    const epsilon = 1.5;
    
    while (remainingSegments.length > 0) {
      const contour = [];
      let currentSegment = remainingSegments.pop();
      
      contour.push(currentSegment[0]);
      contour.push(currentSegment[1]);
      
      // Пытаемся найти следующие сегменты
      let foundConnection = true;
      while (foundConnection && remainingSegments.length > 0) {
        foundConnection = false;
        const lastPoint = contour[contour.length - 1];
        
        for (let i = 0; i < remainingSegments.length; i++) {
          const seg = remainingSegments[i];
          
          if (this._pointsClose(lastPoint, seg[0], epsilon)) {
            contour.push(seg[1]);
            remainingSegments.splice(i, 1);
            foundConnection = true;
            break;
          } else if (this._pointsClose(lastPoint, seg[1], epsilon)) {
            contour.push(seg[0]);
            remainingSegments.splice(i, 1);
            foundConnection = true;
            break;
          }
        }
      }
      
      if (contour.length >= 3) {
        closedContours.push(contour);
      }
    }
    
    return closedContours;
  }
  
  /**
   * Проверить, находятся ли две точки достаточно близко
   * @private
   */
  _pointsClose(p1, p2, epsilon) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return (dx * dx + dy * dy) < (epsilon * epsilon);
  }
  
  /**
   * Построить иерархию контуров (кто внутри кого)
   * @param {Array} contours - массив контуров
   * @returns {Array} массив объектов {contour, parent}
   * @private
   */
  _buildContourHierarchy(contours) {
    const hierarchy = [];
    
    for (let i = 0; i < contours.length; i++) {
      let parent = -1;
      let minArea = Infinity;
      
      // Ищем самый маленький контур, который содержит текущий
      for (let j = 0; j < contours.length; j++) {
        if (i === j) continue;
        
        if (this._isContourInsideContour(contours[i], contours[j])) {
          const area = this._calculatePolygonArea(contours[j]);
          if (area < minArea) {
            minArea = area;
            parent = j;
          }
        }
      }
      
      hierarchy.push({
        contour: contours[i],
        parent: parent
      });
    }
    
    return hierarchy;
  }
  
  /**
   * Проверить, находится ли контур A внутри контура B
   * @private
   */
  _isContourInsideContour(contourA, contourB) {
    // Проверяем несколько точек контура A
    for (let i = 0; i < Math.min(3, contourA.length); i++) {
      if (!this._isPointInPolygon(contourA[i], contourB)) {
        return false;
      }
    }
    return true;
  }
  
  /**
   * Проверить, находится ли точка внутри полигона (ray casting)
   * @private
   */
  _isPointInPolygon(point, polygon) {
    let inside = false;
    
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;
      
      const intersect = ((yi > point.y) !== (yj > point.y))
        && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
      
      if (intersect) inside = !inside;
    }
    
    return inside;
  }
  
  /**
   * Вычислить площадь полигона (формула шнуровки)
   * @param {Array} polygon - массив точек {x, y}
   * @returns {number} площадь
   * @private
   */
  _calculatePolygonArea(polygon) {
    if (!polygon || polygon.length < 3) return 0;
    
    let area = 0;
    for (let i = 0; i < polygon.length; i++) {
      const j = (i + 1) % polygon.length;
      area += polygon[i].x * polygon[j].y;
      area -= polygon[j].x * polygon[i].y;
    }
    
    return Math.abs(area / 2);
  }
}

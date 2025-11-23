import { BiomeResolver } from './global-map-biome-resolver.mjs';

/**
 * Global Map Renderer
 * Pure visualization layer - renders unified grid to canvas
 * Does NOT process or modify data, only displays it
 */
export class GlobalMapRenderer {
  constructor() {
    this.container = null; // PIXI.Container for rendering
    this.isVisible = false;
    this.currentGrid = null; // Reference to current grid being rendered
    this.currentMetadata = null;
    // Separate render modes for heights and biomes
    this.heightsMode = 'contours'; // 'contours', 'cells', 'off'
    this.biomesMode = 'fancy'; // 'fancy', 'fancyDebug', 'cells', 'off'
    this.biomeResolver = new BiomeResolver(); // For dynamic biome determination
  }

  /**
   * Initialize renderer and set up canvas hooks
   */
  async initialize() {
    console.log('GlobalMapRenderer | Initializing...');

    // Load biome resolver config
    await this.biomeResolver.loadConfig();

    Hooks.on('canvasReady', async () => {
      await this.onCanvasReady();
    });

    if (canvas?.ready && canvas?.scene) {
      console.log('GlobalMapRenderer | Canvas already ready');
      setTimeout(async () => {
        await this.onCanvasReady();
      }, 100);
    }
  }

  /**
   * Called when canvas is ready - set up rendering container
   */
  async onCanvasReady() {
    console.log('GlobalMapRenderer | onCanvasReady');
    this.isVisible = false;
    this.setupContainer();
  }

  /**
   * Set up PIXI container on interface layer
   */
  setupContainer() {
    const interfaceLayer = canvas.interface;

    if (!interfaceLayer) {
      console.warn('GlobalMapRenderer | Interface layer not available');
      return;
    }

    // Clear existing container
    if (this.container) {
      this.container.destroy({ children: true });
    }

    this.container = new PIXI.Container();
    this.container.name = 'globalMapContainer';
    interfaceLayer.addChild(this.container);

    console.log('GlobalMapRenderer | Container set up');
  }

  /**
   * Set heights render mode
   * @param {string} mode - 'contours', 'cells', 'off'
   */
  setHeightsMode(mode) {
    if (!['contours', 'cells', 'off'].includes(mode)) {
      console.warn(`GlobalMapRenderer | Invalid heights mode: ${mode}`);
      return;
    }
    this.heightsMode = mode;
    console.log(`GlobalMapRenderer | Heights mode set to: ${mode}`);
    // Re-render if data available
    if (this.currentGrid && this.currentMetadata) {
      this.render(this.currentGrid, this.currentMetadata);
    }
  }

  /**
   * Set biomes render mode
   * @param {string} mode - 'fancy', 'fancyDebug', 'cells', 'off'
   */
  setBiomesMode(mode) {
    if (!['fancy', 'fancyDebug', 'cells', 'off'].includes(mode)) {
      console.warn(`GlobalMapRenderer | Invalid biomes mode: ${mode}`);
      return;
    }
    this.biomesMode = mode;
    console.log(`GlobalMapRenderer | Biomes mode set to: ${mode}`);
    // Re-render if data available
    if (this.currentGrid && this.currentMetadata) {
      this.render(this.currentGrid, this.currentMetadata);
    }
  }

  /**
   * Render unified grid to canvas with separate biomes and heights modes
   * @param {Object} gridData - Unified grid {heights, biomes, rows, cols}
   * @param {Object} metadata - Grid metadata
   */
  async render(gridData, metadata) {
    if (!gridData || !gridData.heights) {
      console.warn('GlobalMapRenderer | No grid data to render');
      return;
    }

    console.log(`GlobalMapRenderer | Rendering grid (biomes: ${this.biomesMode}, heights: ${this.heightsMode})...`);

    // Store reference to current grid
    this.currentGrid = gridData;
    this.currentMetadata = metadata;

    // Make sure container exists
    if (!this.container) {
      this.setupContainer();
    }

    // Clear previous rendering
    this.container.removeChildren();

    // Render biomes layer
    if (this.biomesMode !== 'off') {
      this._renderBiomesLayer(gridData, metadata);
    }

    // Render heights layer
    if (this.heightsMode !== 'off') {
      this._renderHeightsLayer(gridData, metadata);
    }

    this.isVisible = true;
    console.log(`GlobalMapRenderer | ✓ Rendered ${gridData.rows}x${gridData.cols} grid`);
  }

  /**
   * Render biomes layer based on current biomesMode
   * @private
   */
  _renderBiomesLayer(gridData, metadata) {
    switch (this.biomesMode) {
      case 'fancy':
        this._renderBiomesSmooth(gridData, metadata, false); // No borders
        break;
      case 'fancyDebug':
        this._renderBiomesSmooth(gridData, metadata, true); // With borders
        break;
      case 'cells':
        this._renderBiomesCells(gridData, metadata);
        break;
    }
  }

  /**
   * Render heights layer based on current heightsMode
   * @private
   */
  _renderHeightsLayer(gridData, metadata) {
    switch (this.heightsMode) {
      case 'contours':
        this._renderHeightContours(gridData, metadata);
        break;
      case 'cells':
        this._renderHeightCells(gridData, metadata);
        break;
    }
  }

  /**
   * Render biomes with smooth boundaries
   * @param {boolean} drawBorders - Whether to draw biome borders
   * @private
   */
  _renderBiomesSmooth(gridData, metadata, drawBorders = false) {
    const { moisture, temperature, heights, rows, cols } = gridData;
    const { cellSize, bounds } = metadata;

    if (!moisture || !temperature) {
      return;
    }

    // Check if there are any biomes to render
    const hasBiomes = moisture.some(m => m > 0) && temperature.some(t => t > 0);
    if (!hasBiomes) {
      console.log('GlobalMapRenderer | No biomes to render');
      return;
    }

    console.log('GlobalMapRenderer | Rendering biomes with smooth boundaries...');

    // 1. Build biomeId grid
    const biomeIds = new Uint8Array(rows * cols);
    const uniqueBiomes = new Set();
    
    for (let i = 0; i < rows * cols; i++) {
      const biomeId = this.biomeResolver.getBiomeId(moisture[i], temperature[i], heights[i]);
      biomeIds[i] = biomeId;
      uniqueBiomes.add(biomeId);
    }

    console.log(`GlobalMapRenderer | Found ${uniqueBiomes.size} unique biomes`);

    // 2. Wave-based rendering: draw biomes in order of connectivity
    // Start with wettest biome, then draw neighbors, then their neighbors, etc.
    this._renderBiomesWaveBased(biomeIds, uniqueBiomes, rows, cols, bounds, cellSize);

    // 3. Optional: Draw smooth borders between biomes
    if (drawBorders) {
      this._drawBiomeBorders(biomeIds, rows, cols, bounds, cellSize, uniqueBiomes);
    }

    console.log('GlobalMapRenderer | ✓ Smooth biome boundaries rendered');

    /* ALTERNATIVE APPROACH (commented out):
    // 2. Sort biomes by moisture (ascending), then temperature (ascending)
    // This ensures consistent overlap: drier renders first, then wetter
    // Within same moisture: colder renders first, then hotter
    const sortedBiomes = Array.from(uniqueBiomes).sort((a, b) => {
      const paramsA = this.biomeResolver.getParametersFromBiomeId(a);
      const paramsB = this.biomeResolver.getParametersFromBiomeId(b);
      
      // Primary sort: moisture (ascending)
      if (paramsA.moisture !== paramsB.moisture) {
        return paramsA.moisture - paramsB.moisture;
      }
      
      // Secondary sort: temperature (ascending)
      return paramsA.temperature - paramsB.temperature;
    });

    // 3. Render biomes in sorted order
    // Later biomes will slightly overdraw earlier ones at boundaries
    for (const biomeId of sortedBiomes) {
      const color = this.biomeResolver.getBiomeColor(biomeId);
      this._renderBiomeRegion(biomeIds, rows, cols, bounds, cellSize, biomeId, color);
    }
    */
  }

  /**
   * Render biomes using wave-based approach at cluster level
   * Draws clusters in order of connectivity, starting from wettest biome
   * @private
   */
  _renderBiomesWaveBased(biomeIds, uniqueBiomes, rows, cols, bounds, cellSize) {
    // Build all clusters for all biomes first
    const allClusters = []; // Array of {biomeId, cluster: [cell indices], neighbors: Set}
    
    for (const biomeId of uniqueBiomes) {
      const biomeCells = [];
      for (let i = 0; i < rows * cols; i++) {
        if (biomeIds[i] === biomeId) {
          biomeCells.push(i);
        }
      }
      
      if (biomeCells.length === 0) continue;
      
      const clusters = this._findConnectedClusters(biomeCells, rows, cols);
      
      for (const cluster of clusters) {
        allClusters.push({
          biomeId,
          cluster,
          id: `${biomeId}_${allClusters.length}` // Unique cluster ID
        });
      }
    }
    
    console.log(`GlobalMapRenderer | Total clusters across all biomes: ${allClusters.length}`);
    
    // Find starting cluster (from wettest biome)
    const sortedBiomes = Array.from(uniqueBiomes).sort((a, b) => {
      const paramsA = this.biomeResolver.getParametersFromBiomeId(a);
      const paramsB = this.biomeResolver.getParametersFromBiomeId(b);
      if (paramsA.moisture !== paramsB.moisture) {
        return paramsB.moisture - paramsA.moisture;
      }
      return paramsA.temperature - paramsB.temperature;
    });
    
    const startBiomeId = sortedBiomes[0];
    const startCluster = allClusters.find(c => c.biomeId === startBiomeId);
    
    if (!startCluster) {
      console.warn('GlobalMapRenderer | No starting cluster found');
      return;
    }
    
    // Track rendered cells and processed clusters
    const pastBiomes = new Set(); // Rendered cells
    const processedClusters = new Set(); // Cluster IDs already drawn
    const clusterQueue = [startCluster]; // Queue of clusters to process
    
    // Process clusters in waves
    while (clusterQueue.length > 0) {
      const currentCluster = clusterQueue.shift();
      
      if (processedClusters.has(currentCluster.id)) {
        continue;
      }
      
      processedClusters.add(currentCluster.id);
      
      // Log cluster being drawn
      const biomeParams = this.biomeResolver.getParametersFromBiomeId(currentCluster.biomeId);
      const biomeColor = this.biomeResolver.getBiomeColor(currentCluster.biomeId);
      const colorHex = '#' + biomeColor.toString(16).padStart(6, '0').toUpperCase();
      
      console.log(`GlobalMapRenderer | Drawing cluster: %c${biomeParams.name}%c (ID: ${currentCluster.biomeId}, Cluster: ${currentCluster.id})`,
        `color: ${colorHex}; font-weight: bold;`,
        'color: inherit; font-weight: normal;');
      
      // Find neighboring cells not in pastBiomes
      const addBiome = new Set();
      const neighboringClusterIds = new Set();
      
      for (const idx of currentCluster.cluster) {
        const row = Math.floor(idx / cols);
        const col = idx % cols;
        
        // Check all 8 neighbors
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            
            const newRow = row + dr;
            const newCol = col + dc;
            
            if (newRow >= 0 && newRow < rows && newCol >= 0 && newCol < cols) {
              const neighborIdx = newRow * cols + newCol;
              
              // Find which cluster this neighbor belongs to
              if (biomeIds[neighborIdx] !== currentCluster.biomeId) {
                for (const otherCluster of allClusters) {
                  if (otherCluster.cluster.includes(neighborIdx) && !processedClusters.has(otherCluster.id)) {
                    neighboringClusterIds.add(otherCluster.id);
                    break;
                  }
                }
              }
              
              // Expand into unrendered cells
              if (!pastBiomes.has(neighborIdx)) {
                addBiome.add(neighborIdx);
              }
            }
          }
        }
      }
      
      // Combine cluster and expansion for drawing
      const drawBiome = [...currentCluster.cluster, ...Array.from(addBiome)];
      
      // Draw this cluster
      this._renderBiomeRegionLayered(drawBiome, rows, cols, bounds, cellSize, currentCluster.biomeId);
      
      // Mark cells as rendered
      for (const idx of currentCluster.cluster) {
        pastBiomes.add(idx);
      }
      
      // Add neighboring clusters to queue
      for (const neighborClusterId of neighboringClusterIds) {
        const neighborCluster = allClusters.find(c => c.id === neighborClusterId);
        if (neighborCluster && !clusterQueue.some(c => c.id === neighborClusterId)) {
          clusterQueue.push(neighborCluster);
        }
      }
    }
    
    // Process any remaining unprocessed clusters (disconnected regions)
    for (const cluster of allClusters) {
      if (!processedClusters.has(cluster.id)) {
        console.warn(`GlobalMapRenderer | Cluster ${cluster.id} was not connected, processing separately`);
        clusterQueue.push(cluster);
      }
    }
  }

  /**
   * Find connected clusters (components) in a set of cells
   * Uses flood-fill algorithm with 8-connectivity (including diagonals)
   * @private
   */
  _findConnectedClusters(cells, rows, cols) {
    if (cells.length === 0) return [];
    
    const cellSet = new Set(cells);
    const visited = new Set();
    const clusters = [];
    
    // Helper: Get 8 neighbors (including diagonals)
    const getNeighbors = (idx) => {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const neighbors = [];
      
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          
          const newRow = row + dr;
          const newCol = col + dc;
          
          if (newRow >= 0 && newRow < rows && newCol >= 0 && newCol < cols) {
            neighbors.push(newRow * cols + newCol);
          }
        }
      }
      
      return neighbors;
    };
    
    // Flood-fill to find each cluster
    for (const startIdx of cells) {
      if (visited.has(startIdx)) continue;
      
      // BFS to find all connected cells
      const cluster = [];
      const queue = [startIdx];
      visited.add(startIdx);
      
      while (queue.length > 0) {
        const idx = queue.shift();
        cluster.push(idx);
        
        // Check neighbors
        for (const neighborIdx of getNeighbors(idx)) {
          if (cellSet.has(neighborIdx) && !visited.has(neighborIdx)) {
            visited.add(neighborIdx);
            queue.push(neighborIdx);
          }
        }
      }
      
      clusters.push(cluster);
    }
    
    return clusters;
  }

  /**
   * Render a biome region using layered filling approach
   * Creates smooth contours using marching squares
   * @private
   */
  _renderBiomeRegionLayered(cellIndices, rows, cols, bounds, cellSize, biomeId) {
    if (cellIndices.length === 0) return;
    
    const color = this.biomeResolver.getBiomeColor(biomeId);
    
    // Create EXPANDED binary grid with padding (to handle edges correctly)
    // Add 1 cell padding on all sides filled with 0
    const paddedRows = rows + 2;
    const paddedCols = cols + 2;
    const paddedGrid = new Float32Array(paddedRows * paddedCols); // Default 0
    
    // Fill padded grid (offset by 1)
    for (const idx of cellIndices) {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const paddedIdx = (row + 1) * paddedCols + (col + 1);
      paddedGrid[paddedIdx] = 1.0;
    }
    
    // Adjust bounds for padded grid
    const paddedBounds = {
      minX: bounds.minX - cellSize,
      minY: bounds.minY - cellSize,
      maxX: bounds.maxX + cellSize,
      maxY: bounds.maxY + cellSize
    };
    
    // Use marching squares on padded grid
    const contourSegments = this._marchingSquares(paddedGrid, paddedRows, paddedCols, paddedBounds, cellSize, 0.5);

    if (contourSegments.length === 0) {
      return; // No boundaries for this biome
    }

    // Build contour paths from segments
    const contours = this._buildContourPaths(contourSegments);
    
    // Smooth contours using Chaikin's algorithm
    const smoothedContours = contours.map(path => this._smoothContour(path, 2));

    // Check if this biome has a pattern config
    const patternConfig = this.biomeResolver.getBiomePattern(biomeId);

    if (patternConfig) {
      // Draw with pattern using config
      this._drawBiomeWithPattern(smoothedContours, color, bounds, cellSize, biomeId, patternConfig);
    } else {
      // Draw filled regions (default behavior)
      const graphics = new PIXI.Graphics();
      graphics.beginFill(color, 1.0);
      for (const contour of smoothedContours) {
        if (contour.length < 3) continue;

        graphics.moveTo(contour[0].x, contour[0].y);
        for (let i = 1; i < contour.length; i++) {
          graphics.lineTo(contour[i].x, contour[i].y);
        }
        graphics.closePath();
      }
      graphics.endFill();

      this.container.addChild(graphics);
    }
  }

  /**
   * Draw biome region with pattern instead of solid fill
   * @private
   */
  _drawBiomeWithPattern(smoothedContours, color, bounds, cellSize, biomeId, patternConfig) {
    // 1. Сначала рисуем заливку основным цветом
    const baseGraphics = new PIXI.Graphics();
    baseGraphics.beginFill(color, 1.0);
    for (const contour of smoothedContours) {
      if (contour.length < 3) continue;
      baseGraphics.moveTo(contour[0].x, contour[0].y);
      for (let i = 1; i < contour.length; i++) {
        baseGraphics.lineTo(contour[i].x, contour[i].y);
      }
      baseGraphics.closePath();
    }
    baseGraphics.endFill();
    this.container.addChild(baseGraphics);
    
    // 2. Вычисляем реальный bounding box биома из контуров
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const contour of smoothedContours) {
      for (const point of contour) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
    }
    const biomeBounds = { minX, minY, maxX, maxY };
    
    // 3. Создаём контейнер для паттерна с маской
    const patternContainer = new PIXI.Container();
    
    // 4. Маска для паттерна (та же форма биома)
    const mask = new PIXI.Graphics();
    mask.beginFill(0xFFFFFF);
    for (const contour of smoothedContours) {
      if (contour.length < 3) continue;
      mask.moveTo(contour[0].x, contour[0].y);
      for (let i = 1; i < contour.length; i++) {
        mask.lineTo(contour[i].x, contour[i].y);
      }
      mask.closePath();
    }
    mask.endFill();
    
    // 5. Рисуем паттерн согласно конфигурации
    const pattern = new PIXI.Graphics();
    
    // Извлекаем параметры из конфига с значениями по умолчанию
    const darkenFactor = patternConfig.darkenFactor ?? 0.4;
    const opacity = patternConfig.opacity ?? 0.9;
    const spacing = patternConfig.spacing ?? 2.0;
    const lineWidth = patternConfig.lineWidth ?? 0.6;
    
    // Определяем цвет паттерна: используем кастомный цвет, если указан, иначе затемняем основной
    let patternColor;
    if (patternConfig.patternColor) {
      // Кастомный цвет из конфига (hex-строка)
      patternColor = parseInt(patternConfig.patternColor, 16);
    } else {
      // Затемнённый основной цвет биома
      patternColor = this._darkenColor(color, darkenFactor);
    }
    
    // Выбираем тип паттерна (используем biomeBounds вместо bounds всей карты)
    switch (patternConfig.type) {
      case 'circles':
        this._drawConcentricCirclesPattern(pattern, smoothedContours, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'diagonal':
        this._drawDiagonalLinesPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'crosshatch':
        this._drawCrosshatchPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'vertical':
        this._drawVerticalLinesPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'horizontal':
        this._drawHorizontalLinesPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'dots':
        this._drawDotsPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'waves':
        this._drawWavesPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'hexagons':
        this._drawHexagonsPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
        break;
      case 'spots':
        this._drawRandomSpotsPattern(pattern, smoothedContours, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity, biomeId);
        break;
      default:
        // По умолчанию - диагональные линии
        this._drawDiagonalLinesPattern(pattern, biomeBounds, cellSize, patternColor, spacing, lineWidth, opacity);
    }
    
    // 6. Применяем маску к паттерну
    pattern.mask = mask;
    
    // 7. Добавляем всё на сцену
    patternContainer.addChild(mask);
    patternContainer.addChild(pattern);
    this.container.addChild(patternContainer);
  }

  /**
   * Draw diagonal lines pattern
   * @private
   */
  _drawDiagonalLinesPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.6, opacity = 0.9) {
    const spacing = cellSize * spacingMultiplier;
    const lineWidth = Math.max(6, cellSize * lineWidthMultiplier);
    const mapWidth = bounds.maxX - bounds.minX;
    const mapHeight = bounds.maxY - bounds.minY;
    const diagonal = Math.sqrt(mapWidth ** 2 + mapHeight ** 2);
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    // Рисуем диагональные линии (\) сверху-слева вниз-вправо
    // Начинаем с верхнего левого угла, идём по диагонали вправо-вниз
    for (let offset = -diagonal; offset < diagonal * 2; offset += spacing) {
      // Линия начинается либо на левой границе, либо на верхней
      const startX = bounds.minX;
      const startY = bounds.minY + offset;
      
      // Линия заканчивается либо на правой границе, либо на нижней
      const endX = bounds.minX + diagonal;
      const endY = bounds.minY + offset - diagonal;
      
      graphics.moveTo(startX, startY);
      graphics.lineTo(endX, endY);
    }
  }

  /**
   * Draw concentric circles pattern
   * @private
   */
  _drawConcentricCirclesPattern(graphics, contours, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.4, opacity = 0.9) {
    // Находим центр области биома
    let sumX = 0, sumY = 0, pointCount = 0;
    for (const contour of contours) {
      for (const point of contour) {
        sumX += point.x;
        sumY += point.y;
        pointCount++;
      }
    }
    
    if (pointCount === 0) return;
    
    const centerX = sumX / pointCount;
    const centerY = sumY / pointCount;
    
    // Находим максимальное расстояние от центра до границы
    let maxDistance = 0;
    for (const contour of contours) {
      for (const point of contour) {
        const dist = Math.sqrt((point.x - centerX) ** 2 + (point.y - centerY) ** 2);
        if (dist > maxDistance) maxDistance = dist;
      }
    }
    
    // Рисуем концентрические круги
    const spacing = cellSize * spacingMultiplier;
    const lineWidth = Math.max(4, cellSize * lineWidthMultiplier);
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    for (let radius = spacing; radius <= maxDistance + spacing; radius += spacing) {
      graphics.drawCircle(centerX, centerY, radius);
    }
  }

  /**
   * Draw crosshatch pattern (diagonal lines in both directions)
   * @private
   */
  _drawCrosshatchPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.6, opacity = 0.9) {
    // Рисуем диагональные линии в обе стороны
    const spacing = cellSize * spacingMultiplier;
    const lineWidth = Math.max(3, cellSize * lineWidthMultiplier * 0.5); // Тоньше для сетки
    const mapWidth = bounds.maxX - bounds.minX;
    const mapHeight = bounds.maxY - bounds.minY;
    const diagonal = Math.sqrt(mapWidth ** 2 + mapHeight ** 2);
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    // Линии в одну сторону (\) - сверху-слева вниз-вправо
    for (let offset = -diagonal; offset < diagonal * 2; offset += spacing) {
      const startX = bounds.minX;
      const startY = bounds.minY + offset;
      const endX = bounds.minX + diagonal;
      const endY = bounds.minY + offset - diagonal;
      
      graphics.moveTo(startX, startY);
      graphics.lineTo(endX, endY);
    }
    
    // Линии в другую сторону (/) - снизу-слева вверх-вправо
    for (let offset = -diagonal; offset < diagonal * 2; offset += spacing) {
      const startX = bounds.minX;
      const startY = bounds.maxY - offset;
      const endX = bounds.minX + diagonal;
      const endY = bounds.maxY - offset + diagonal;
      
      graphics.moveTo(startX, startY);
      graphics.lineTo(endX, endY);
    }
  }

  /**
   * Draw vertical lines pattern
   * @private
   */
  _drawVerticalLinesPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.6, opacity = 0.9) {
    const spacing = cellSize * spacingMultiplier;
    const lineWidth = Math.max(6, cellSize * lineWidthMultiplier);
    const mapWidth = bounds.maxX - bounds.minX;
    const mapHeight = bounds.maxY - bounds.minY;
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    for (let x = bounds.minX; x <= bounds.maxX; x += spacing) {
      graphics.moveTo(x, bounds.minY);
      graphics.lineTo(x, bounds.maxY);
    }
  }

  /**
   * Draw horizontal lines pattern
   * @private
   */
  _drawHorizontalLinesPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.6, opacity = 0.9) {
    const spacing = cellSize * spacingMultiplier;
    const lineWidth = Math.max(6, cellSize * lineWidthMultiplier);
    const mapWidth = bounds.maxX - bounds.minX;
    const mapHeight = bounds.maxY - bounds.minY;
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    for (let y = bounds.minY; y <= bounds.maxY; y += spacing) {
      graphics.moveTo(bounds.minX, y);
      graphics.lineTo(bounds.maxX, y);
    }
  }

  /**
   * Draw dots pattern
   * @private
   */
  _drawDotsPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.4, opacity = 0.9) {
    const spacing = cellSize * spacingMultiplier;
    const dotRadius = Math.max(2, cellSize * lineWidthMultiplier);
    
    graphics.beginFill(color, opacity);
    
    for (let y = bounds.minY; y <= bounds.maxY; y += spacing) {
      for (let x = bounds.minX; x <= bounds.maxX; x += spacing) {
        graphics.drawCircle(x, y, dotRadius);
      }
    }
    
    graphics.endFill();
  }

  /**
   * Draw waves pattern
   * @private
   */
  _drawWavesPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.6, opacity = 0.9) {
    const spacing = cellSize * spacingMultiplier;
    const lineWidth = Math.max(3, cellSize * lineWidthMultiplier);
    const waveHeight = cellSize * spacingMultiplier * 0.25; // Уменьшили амплитуду с 0.5 до 0.25
    const waveLength = cellSize * 4;
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    const mapWidth = bounds.maxX - bounds.minX;
    const step = cellSize * 0.5; // Меньший шаг для более плавных волн
    
    for (let y = bounds.minY; y <= bounds.maxY; y += spacing) {
      let firstPoint = true;
      
      for (let x = bounds.minX; x <= bounds.maxX + step; x += step) {
        const phase = (x - bounds.minX) / waveLength * Math.PI * 2;
        const waveY = y + Math.sin(phase) * waveHeight;
        
        if (firstPoint) {
          graphics.moveTo(x, waveY);
          firstPoint = false;
        } else {
          graphics.lineTo(x, waveY);
        }
      }
    }
  }

  /**
   * Draw hexagons pattern
   * @private
   */
  _drawHexagonsPattern(graphics, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.3, opacity = 0.9) {
    const hexSize = cellSize * spacingMultiplier;
    const lineWidth = Math.max(2, cellSize * lineWidthMultiplier);
    const hexWidth = hexSize * 2;
    const hexHeight = Math.sqrt(3) * hexSize;
    
    graphics.lineStyle(lineWidth, color, opacity);
    
    // Рисуем шестиугольники в шахматном порядке
    for (let row = 0; row * hexHeight <= bounds.maxY - bounds.minY + hexHeight; row++) {
      for (let col = 0; col * hexWidth * 0.75 <= bounds.maxX - bounds.minX + hexWidth; col++) {
        const x = bounds.minX + col * hexWidth * 0.75;
        const y = bounds.minY + row * hexHeight + (col % 2) * hexHeight / 2;
        
        this._drawHexagon(graphics, x, y, hexSize);
      }
    }
  }

  /**
   * Draw random spots pattern
   * @private
   */
  _drawRandomSpotsPattern(graphics, contours, bounds, cellSize, color, spacingMultiplier = 2.0, lineWidthMultiplier = 0.4, opacity = 0.9, seed = 0) {
    const spacing = cellSize * spacingMultiplier;
    const minRadius = Math.max(2, cellSize * lineWidthMultiplier * 0.5);
    const maxRadius = Math.max(4, cellSize * lineWidthMultiplier * 1.5);
    
    // Простой генератор псевдослучайных чисел с seed
    let random = seed + 12345;
    const seededRandom = () => {
      random = (random * 9301 + 49297) % 233280;
      return random / 233280;
    };
    
    graphics.beginFill(color, opacity);
    
    // Генерируем пятна на сетке с небольшим смещением
    for (let y = bounds.minY; y <= bounds.maxY; y += spacing) {
      for (let x = bounds.minX; x <= bounds.maxX; x += spacing) {
        // Смещение от сетки
        const offsetX = (seededRandom() - 0.5) * spacing * 0.8;
        const offsetY = (seededRandom() - 0.5) * spacing * 0.8;
        
        // Случайный размер пятна
        const radius = minRadius + seededRandom() * (maxRadius - minRadius);
        
        // Иногда пропускаем пятно для разнообразия
        if (seededRandom() > 0.3) {
          graphics.drawCircle(x + offsetX, y + offsetY, radius);
        }
      }
    }
    
    graphics.endFill();
  }

  /**
   * Draw a single hexagon
   * @private
   */
  _drawHexagon(graphics, centerX, centerY, size) {
    const angles = [0, 60, 120, 180, 240, 300];
    
    graphics.moveTo(
      centerX + size * Math.cos(0),
      centerY + size * Math.sin(0)
    );
    
    for (const angle of angles) {
      const rad = (angle * Math.PI) / 180;
      graphics.lineTo(
        centerX + size * Math.cos(rad),
        centerY + size * Math.sin(rad)
      );
    }
    
    graphics.closePath();
  }

  /**
   * Check if biome cluster touches any edge of the map
   * @private
   */
  _checkBiomeTouchesEdge(cellIndices, rows, cols) {
    for (const idx of cellIndices) {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      
      // Check if on any edge
      if (row === 0 || row === rows - 1 || col === 0 || col === cols - 1) {
        return true;
      }
    }
    return false;
  }

  /**
   * Add explicit boundary paths along map edges for biomes that touch them
   * @private
   */
  _addEdgeBoundaries(contours, cellIndices, rows, cols, bounds, cellSize) {
    // Find cells on each edge
    const topEdge = [];
    const bottomEdge = [];
    const leftEdge = [];
    const rightEdge = [];
    
    for (const idx of cellIndices) {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      
      if (row === 0) topEdge.push(col);
      if (row === rows - 1) bottomEdge.push(col);
      if (col === 0) leftEdge.push(row);
      if (col === cols - 1) rightEdge.push(row);
    }
    
    // Sort edges
    topEdge.sort((a, b) => a - b);
    bottomEdge.sort((a, b) => a - b);
    leftEdge.sort((a, b) => a - b);
    rightEdge.sort((a, b) => a - b);
    
    // Add edge paths to contours
    if (topEdge.length > 0) {
      const path = [];
      for (const col of topEdge) {
        const x = bounds.minX + col * cellSize;
        const y = bounds.minY;
        path.push({ x, y });
        path.push({ x: x + cellSize, y });
      }
      if (path.length > 0) contours.push(path);
    }
    
    if (bottomEdge.length > 0) {
      const path = [];
      for (const col of bottomEdge) {
        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + rows * cellSize;
        path.push({ x, y });
        path.push({ x: x + cellSize, y });
      }
      if (path.length > 0) contours.push(path);
    }
    
    if (leftEdge.length > 0) {
      const path = [];
      for (const row of leftEdge) {
        const x = bounds.minX;
        const y = bounds.minY + row * cellSize;
        path.push({ x, y });
        path.push({ x, y: y + cellSize });
      }
      if (path.length > 0) contours.push(path);
    }
    
    if (rightEdge.length > 0) {
      const path = [];
      for (const row of rightEdge) {
        const x = bounds.minX + cols * cellSize;
        const y = bounds.minY + row * cellSize;
        path.push({ x, y });
        path.push({ x, y: y + cellSize });
      }
      if (path.length > 0) contours.push(path);
    }
  }

  /**
   * Draw smooth borders between different biomes
   * @private
   */
  _drawBiomeBorders(biomeIds, rows, cols, bounds, cellSize, uniqueBiomes) {
    // For each unique biome, draw its borders
    for (const biomeId of uniqueBiomes) {
      this._drawBiomeBorder(biomeIds, rows, cols, bounds, cellSize, biomeId);
    }
  }

  /**
   * Draw border for a single biome using marching squares
   * @private
   */
  _drawBiomeBorder(biomeIds, rows, cols, bounds, cellSize, targetBiomeId) {
    // Create binary grid for this biome (1 = this biome, 0 = other)
    const binaryGrid = new Float32Array(rows * cols);
    for (let i = 0; i < biomeIds.length; i++) {
      binaryGrid[i] = biomeIds[i] === targetBiomeId ? 1.0 : 0.0;
    }

    // Use marching squares to find contours at threshold 0.5
    const contourSegments = this._marchingSquares(binaryGrid, rows, cols, bounds, cellSize, 0.5);

    if (contourSegments.length === 0) {
      return; // No boundaries for this biome
    }

    // Build and smooth contour paths
    const contours = this._buildContourPaths(contourSegments);
    const smoothedContours = contours.map(path => this._smoothContour(path, 2));

    // Draw border lines (not filled regions)
    const graphics = new PIXI.Graphics();
    const color = this.biomeResolver.getBiomeColor(targetBiomeId);
    
    // Draw darker border line
    graphics.lineStyle(1.5, this._darkenColor(color, 0.3), 0.6);
    for (const contour of smoothedContours) {
      if (contour.length < 3) continue;

      graphics.moveTo(contour[0].x, contour[0].y);
      for (let i = 1; i < contour.length; i++) {
        graphics.lineTo(contour[i].x, contour[i].y);
      }
      graphics.closePath();
    }

    this.container.addChild(graphics);
  }

  /**
   * Darken a color by a factor
   * @private
   */
  _darkenColor(color, factor) {
    const r = (color >> 16) & 0xFF;
    const g = (color >> 8) & 0xFF;
    const b = color & 0xFF;
    
    const newR = Math.floor(r * (1 - factor));
    const newG = Math.floor(g * (1 - factor));
    const newB = Math.floor(b * (1 - factor));
    
    return (newR << 16) | (newG << 8) | newB;
  }

  /**
   * Render a single biome region with smooth boundaries
   * @private
   */
  _renderBiomeRegion(biomeIds, rows, cols, bounds, cellSize, targetBiomeId, color) {
    const graphics = new PIXI.Graphics();

    // Create binary grid for this biome (1 = this biome, 0 = other)
    const binaryGrid = new Float32Array(rows * cols);
    for (let i = 0; i < biomeIds.length; i++) {
      binaryGrid[i] = biomeIds[i] === targetBiomeId ? 1.0 : 0.0;
    }

    // Use marching squares to find contours at threshold 0.5
    const contourSegments = this._marchingSquares(binaryGrid, rows, cols, bounds, cellSize, 0.5);

    if (contourSegments.length === 0) {
      return; // No boundaries for this biome
    }

    // 3. Build contour paths from segments
    const contours = this._buildContourPaths(contourSegments);

    // 4. Smooth contours using Chaikin's algorithm
    const smoothedContours = contours.map(path => this._smoothContour(path, 2));

    // 5. Draw filled regions
    graphics.beginFill(color, 1.0);
    for (const contour of smoothedContours) {
      if (contour.length < 3) continue;

      graphics.moveTo(contour[0].x, contour[0].y);
      for (let i = 1; i < contour.length; i++) {
        graphics.lineTo(contour[i].x, contour[i].y);
      }
      graphics.closePath();
    }
    graphics.endFill();

    this.container.addChild(graphics);
  }

  /**
   * Build contour paths from disconnected segments
   * Connects segments into closed loops
   * @private
   */
  _buildContourPaths(segments) {
    if (segments.length === 0) return [];

    const paths = [];
    const used = new Set();
    const epsilon = 0.1; // Tolerance for point matching

    const pointsEqual = (p1, p2) => {
      return Math.abs(p1.x - p2.x) < epsilon && Math.abs(p1.y - p2.y) < epsilon;
    };

    for (let i = 0; i < segments.length; i++) {
      if (used.has(i)) continue;

      const path = [segments[i][0], segments[i][1]];
      used.add(i);

      // Try to extend path by finding connecting segments
      let extended = true;
      while (extended) {
        extended = false;

        for (let j = 0; j < segments.length; j++) {
          if (used.has(j)) continue;

          const lastPoint = path[path.length - 1];
          const seg = segments[j];

          // Check if segment connects to end of path
          if (pointsEqual(lastPoint, seg[0])) {
            path.push(seg[1]);
            used.add(j);
            extended = true;
            break;
          } else if (pointsEqual(lastPoint, seg[1])) {
            path.push(seg[0]);
            used.add(j);
            extended = true;
            break;
          }
        }
      }

      paths.push(path);
    }

    return paths;
  }

  /**
   * Smooth contour using Chaikin's corner-cutting algorithm
   * @private
   */
  _smoothContour(points, iterations = 2) {
    if (points.length < 3) return points;

    let smoothed = [...points];

    for (let iter = 0; iter < iterations; iter++) {
      const newPoints = [];

      for (let i = 0; i < smoothed.length; i++) {
        const p0 = smoothed[i];
        const p1 = smoothed[(i + 1) % smoothed.length];

        // Create two new points at 1/4 and 3/4 along the segment
        newPoints.push({
          x: 0.75 * p0.x + 0.25 * p1.x,
          y: 0.75 * p0.y + 0.25 * p1.y
        });
        newPoints.push({
          x: 0.25 * p0.x + 0.75 * p1.x,
          y: 0.25 * p0.y + 0.75 * p1.y
        });
      }

      smoothed = newPoints;
    }

    return smoothed;
  }

  /**
   * Render biomes as simple colored cells
   * @private
   */
  _renderBiomesCells(gridData, metadata) {
    const { moisture, temperature, heights, rows, cols } = gridData;
    const { cellSize, bounds } = metadata;

    if (!moisture || !temperature) {
      return;
    }

    console.log('GlobalMapRenderer | Rendering biomes as cells...');
    const graphics = new PIXI.Graphics();

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        const biomeId = this.biomeResolver.getBiomeId(moisture[idx], temperature[idx], heights[idx]);
        const color = this.biomeResolver.getBiomeColor(biomeId);
        
        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + row * cellSize;
        
        graphics.beginFill(color, 1.0);
        graphics.drawRect(x, y, cellSize, cellSize);
        graphics.endFill();
      }
    }

    this.container.addChild(graphics);
  }

  /**
   * Render height contours
   * @private
   */
  _renderHeightContours(gridData, metadata) {
    const { heights, rows, cols } = gridData;
    const { cellSize, bounds, heightStats } = metadata;

    // Create contour levels (20 levels for better detail)
    const minHeight = heightStats.min;
    const maxHeight = heightStats.max;
    const range = maxHeight - minHeight;

    const levels = [];
    for (let i = 1; i <= 20; i++) {
      const level = minHeight + (range * i / 20);
      levels.push({
        level,
        color: this._heightToColor(i / 20),
      });
    }

    // Draw contours for each level
    for (const levelInfo of levels) {
      const segments = this._marchingSquares(heights, rows, cols, bounds, cellSize, levelInfo.level);
      this._drawContourSegments(segments, levelInfo.color, heights, rows, cols, bounds, cellSize);
    }
  }

  /**
   * Render heights as colored cells
   * @private
   */
  _renderHeightCells(gridData, metadata) {
    const { heights, rows, cols } = gridData;
    const { cellSize, bounds, heightStats } = metadata;

    const graphics = new PIXI.Graphics();

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        const height = heights[idx];
        
        const normalized = this._normalizeValue(height, heightStats.min, heightStats.max);
        const color = this._heightToColor(normalized);
        
        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + row * cellSize;
        
        graphics.beginFill(color, 0.7);
        graphics.drawRect(x, y, cellSize, cellSize);
        graphics.endFill();
      }
    }

    this.container.addChild(graphics);
  }

  /**
   * Render biomes as colored cells (base layer)
   * Dynamically determines biome from moisture/temperature
   * @private
   */
  _renderBiomesBase(gridData, metadata) {
    const { moisture, temperature, heights, rows, cols } = gridData;
    const { cellSize, bounds } = metadata;

    if (!moisture || !temperature || !this.showBiomes) {
      return;
    }

    // Check if there are any biomes to render
    const hasBiomes = moisture.some(m => m > 0) && temperature.some(t => t > 0);
    if (!hasBiomes) {
      console.log('GlobalMapRenderer | No biomes to render');
      return;
    }

    console.log('GlobalMapRenderer | Rendering biome base layer (dynamic)...');
    const graphics = new PIXI.Graphics();

    // Render biome cells
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        
        const moistureVal = moisture[idx];
        const temperatureVal = temperature[idx];
        const height = heights[idx];

        // Dynamically determine biome ID from moisture/temperature/height
        const biomeId = this.biomeResolver.getBiomeId(moistureVal, temperatureVal, height);

        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + row * cellSize;

        // Get biome color
        const color = this.biomeResolver.getBiomeColor(biomeId);
        const alpha = 1.0; // Fully opaque

        graphics.beginFill(color, alpha);
        graphics.drawRect(x, y, cellSize, cellSize);
        graphics.endFill();
      }
    }

    this.container.addChild(graphics);
    console.log('GlobalMapRenderer | ✓ Biome base layer rendered');
  }

  /**
   * Render as contour lines using marching squares
   * @private
   */
  _renderContours(gridData, metadata) {
    const { heights, rows, cols } = gridData;
    const { cellSize, bounds, heightStats } = metadata;

    // First, render biomes as base layer with smooth boundaries
    this._renderBiomesSmooth(gridData, metadata);

    // Then render contour lines on top
    // Create contour levels (20 levels for better detail)
    const minHeight = heightStats.min;
    const maxHeight = heightStats.max;
    const range = maxHeight - minHeight;

    const levels = [];
    for (let i = 1; i <= 20; i++) {
      const level = minHeight + (range * i / 20);
      levels.push({
        level,
        color: this._heightToColor(i / 20),
      });
    }

    // Draw contours for each level
    for (const levelInfo of levels) {
      const segments = this._marchingSquares(heights, rows, cols, bounds, cellSize, levelInfo.level);
      this._drawContourSegments(segments, levelInfo.color, heights, rows, cols, bounds, cellSize);
    }
  }

  /**
   * Marching squares algorithm to extract contour segments
   * @private
   */
  _marchingSquares(heights, rows, cols, bounds, cellSize, threshold) {
    const segments = [];

    for (let row = 0; row < rows - 1; row++) {
      for (let col = 0; col < cols - 1; col++) {
        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + row * cellSize;

        // Get corner values
        const v00 = heights[row * cols + col];
        const v10 = heights[row * cols + (col + 1)];
        const v01 = heights[(row + 1) * cols + col];
        const v11 = heights[(row + 1) * cols + (col + 1)];

        // Calculate case
        let caseValue = 0;
        if (v00 >= threshold) caseValue |= 1;
        if (v10 >= threshold) caseValue |= 2;
        if (v11 >= threshold) caseValue |= 4;
        if (v01 >= threshold) caseValue |= 8;

        // Get segments for this case
        const segs = this._getMarchingSquaresSegments(caseValue, x, y, cellSize, v00, v10, v01, v11, threshold);
        segments.push(...segs);
      }
    }

    return segments;
  }

  /**
   * Get line segments for marching squares case
   * @private
   */
  _getMarchingSquaresSegments(caseValue, x, y, size, v00, v10, v01, v11, threshold) {
    const segments = [];

    const lerp = (v1, v2) => {
      if (Math.abs(v2 - v1) < 0.0001) return 0.5;
      return (threshold - v1) / (v2 - v1);
    };

    const edges = {
      top: { x: x + size * lerp(v00, v10), y },
      right: { x: x + size, y: y + size * lerp(v10, v11) },
      bottom: { x: x + size * lerp(v01, v11), y: y + size },
      left: { x, y: y + size * lerp(v00, v01) },
    };

    switch (caseValue) {
      case 1: segments.push([edges.left, edges.top]); break;
      case 2: segments.push([edges.top, edges.right]); break;
      case 3: segments.push([edges.left, edges.right]); break;
      case 4: segments.push([edges.right, edges.bottom]); break;
      case 5:
        segments.push([edges.left, edges.top]);
        segments.push([edges.right, edges.bottom]);
        break;
      case 6: segments.push([edges.top, edges.bottom]); break;
      case 7: segments.push([edges.left, edges.bottom]); break;
      case 8: segments.push([edges.bottom, edges.left]); break;
      case 9: segments.push([edges.bottom, edges.top]); break;
      case 10:
        segments.push([edges.top, edges.right]);
        segments.push([edges.bottom, edges.left]);
        break;
      case 11: segments.push([edges.bottom, edges.right]); break;
      case 12: segments.push([edges.right, edges.left]); break;
      case 13: segments.push([edges.right, edges.top]); break;
      case 14: segments.push([edges.top, edges.left]); break;
    }

    return segments;
  }

  /**
   * Draw contour line segments with outline and slope direction marks
   * @private
   */
  _drawContourSegments(segments, color, heights, rows, cols, bounds, cellSize) {
    if (segments.length === 0) return;

    const graphics = new PIXI.Graphics();

    // Draw black outline first (for better visibility)
    graphics.lineStyle(2, 0x000000, 0.6);
    for (const segment of segments) {
      graphics.moveTo(segment[0].x, segment[0].y);
      graphics.lineTo(segment[1].x, segment[1].y);
    }

    // Draw colored contour lines
    graphics.lineStyle(1, color, 0.8);
    for (const segment of segments) {
      graphics.moveTo(segment[0].x, segment[0].y);
      graphics.lineTo(segment[1].x, segment[1].y);
    }

    // Draw slope direction marks (hachures)
    this._drawSlopeMarks(graphics, segments, heights, rows, cols, bounds, cellSize, color);

    this.container.addChild(graphics);
  }

  /**
   * Draw short lines indicating downslope direction
   * @private
   */
  _drawSlopeMarks(graphics, segments, heightValues, rows, cols, bounds, cellSize, color) {
    const hachureLength = 4;
    const hachureSpacing = 25;

    for (const segment of segments) {
      const dx = segment[1].x - segment[0].x;
      const dy = segment[1].y - segment[0].y;
      const length = Math.sqrt(dx * dx + dy * dy);

      if (length < 1) continue;

      // Number of marks along segment
      const numMarks = Math.floor(length / hachureSpacing);
      if (numMarks === 0) continue;

      // Unit tangent vector (along contour)
      const tx = dx / length;
      const ty = dy / length;

      // Perpendicular vector
      const nx1 = -ty;
      const ny1 = tx;
      const nx2 = ty;
      const ny2 = -tx;

      // Sample points along segment
      for (let i = 1; i <= numMarks; i++) {
        const t = i / (numMarks + 1);
        const px = segment[0].x + dx * t;
        const py = segment[0].y + dy * t;

        // Sample heights in both perpendicular directions
        const sampleDist = cellSize * 2;
        const h1 = this._sampleHeightAtPoint(px + nx1 * sampleDist, py + ny1 * sampleDist, heightValues, rows, cols, bounds, cellSize);
        const h2 = this._sampleHeightAtPoint(px + nx2 * sampleDist, py + ny2 * sampleDist, heightValues, rows, cols, bounds, cellSize);

        // Direction that goes downhill
        let markNx, markNy;
        if (h1 < h2) {
          markNx = nx1;
          markNy = ny1;
        } else {
          markNx = nx2;
          markNy = ny2;
        }

        // Draw mark pointing downhill
        const hx = px + markNx * hachureLength;
        const hy = py + markNy * hachureLength;

        graphics.lineStyle(1, 0x000000, 0.7);
        graphics.moveTo(px, py);
        graphics.lineTo(hx, hy);
      }
    }
  }

  /**
   * Sample height value from grid at point
   * @private
   */
  _sampleHeightAtPoint(x, y, heightValues, rows, cols, bounds, cellSize) {
    // Convert world coordinates to grid coordinates
    const col = (x - bounds.minX) / cellSize;
    const row = (y - bounds.minY) / cellSize;

    // Check bounds
    if (col < 0 || col >= cols - 1 || row < 0 || row >= rows - 1) {
      return 0;
    }

    // Bilinear interpolation
    const col0 = Math.floor(col);
    const row0 = Math.floor(row);
    const col1 = col0 + 1;
    const row1 = row0 + 1;

    const fx = col - col0;
    const fy = row - row0;

    const v00 = heightValues[row0 * cols + col0];
    const v10 = heightValues[row0 * cols + col1];
    const v01 = heightValues[row1 * cols + col0];
    const v11 = heightValues[row1 * cols + col1];

    return (1 - fx) * (1 - fy) * v00 +
           fx * (1 - fy) * v10 +
           (1 - fx) * fy * v01 +
           fx * fy * v11;
  }

  /**
   * Render as colored cells
   * @private
   */
  _renderCells(gridData, metadata, renderOptions) {
    const {
      mode = 'heights',
      heightColorFunc = null,
      biomeColorFunc = null,
      opacity = 0.7,
      cellBorder = false,
    } = renderOptions;

    const { heights, moisture, temperature, rows, cols } = gridData;
    const { cellSize, bounds } = metadata;

    const graphics = new PIXI.Graphics();

    // Render grid cells
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;

        const x = bounds.minX + col * cellSize;
        const y = bounds.minY + row * cellSize;

        let color = 0xffffff; // Default white
        let alpha = opacity;

        if (mode === 'heights' || mode === 'both') {
          const height = heights[idx];

          if (heightColorFunc) {
            color = heightColorFunc(height, metadata.heightStats);
          } else {
            const normalized = this._normalizeValue(
              height,
              metadata.heightStats.min,
              metadata.heightStats.max
            );
            color = this._heightToColor(normalized);
          }

          alpha = opacity * 0.7;
        }

        if (mode === 'biomes' || mode === 'both') {
          // Dynamically determine biome from moisture/temperature
          const biomeId = this.biomeResolver.getBiomeId(
            moisture[idx],
            temperature[idx],
            heights[idx]
          );

          if (biomeColorFunc) {
            const biomeColor = biomeColorFunc(biomeId);
            color = biomeColor;
            alpha = opacity;
          } else {
            color = this.biomeResolver.getBiomeColor(biomeId);
            alpha = opacity;
          }
        }

        // Draw cell
        graphics.beginFill(color, alpha);
        graphics.drawRect(x, y, cellSize, cellSize);
        graphics.endFill();

        // Optional cell border
        if (cellBorder) {
          graphics.lineStyle(0.5, 0x000000, 0.3);
          graphics.drawRect(x, y, cellSize, cellSize);
        }
      }
    }

    this.container.addChild(graphics);
  }

  /**
   * Show renderer (make visible)
   */
  show() {
    if (this.container) {
      this.container.visible = true;
      this.isVisible = true;
      console.log('GlobalMapRenderer | Shown');
    }
  }

  /**
   * Hide renderer
   */
  hide() {
    if (this.container) {
      this.container.visible = false;
      this.isVisible = false;
      console.log('GlobalMapRenderer | Hidden');
    }
  }

  /**
   * Toggle visibility
   */
  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Clear rendering
   */
  clear() {
    if (this.container) {
      this.container.removeChildren();
      this.isVisible = false;
      console.log('GlobalMapRenderer | Cleared');
    }
  }

  /**
   * Normalize value to 0-1 range
   * @private
   */
  _normalizeValue(value, min, max) {
    if (max === min) return 0.5;
    return (value - min) / (max - min);
  }

  /**
   * Convert normalized height (0-1) to RGB color
   * Blue (low) -> Green -> Yellow -> Red (high)
   * @private
   */
  _heightToColor(normalized) {
    // Clamp normalized to 0-1 range
    normalized = Math.max(0, Math.min(1, normalized));
    
    let r = 0, g = 0, b = 0;

    if (normalized < 0.25) {
      // Blue to Green
      const t = normalized / 0.25;
      r = 0;
      g = Math.floor(255 * t);
      b = 255;
    } else if (normalized < 0.5) {
      // Green to Yellow
      const t = (normalized - 0.25) / 0.25;
      r = Math.floor(255 * t);
      g = 255;
      b = 0;
    } else if (normalized < 0.75) {
      // Yellow to Orange
      const t = (normalized - 0.5) / 0.25;
      r = 255;
      g = Math.floor(255 * (1 - t * 0.5));
      b = 0;
    } else {
      // Orange to Red
      const t = (normalized - 0.75) / 0.25;
      r = 255;
      g = Math.floor(200 * (1 - t));
      b = 0;
    }
    
    // Apply mask to ensure positive hex value
    return ((r << 16) | (g << 8) | b) & 0xFFFFFF;
  }

}

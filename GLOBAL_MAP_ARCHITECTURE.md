# Global Map System - Архитектура

## Обзор

Новая система управления глобальной картой состоит из 4 независимых модулей с чётким разделением ответственности:

```
User UI (global-map-ui)
         ↓
    Dialog/Controls
         ↓
Processing (global-map-processing) → Renderer (global-map-renderer)
         ↓                                    ↓
    Unified Grid                          PIXI Canvas
         ↓
    Tools (global-map-tools)
         ↓
    Save to Scene Flags
```

## Модули

### 1. `global-map-processing.mjs`
**Назначение**: Обработка сырых данных PackCells в unified сетку

**Ответственность**:
- Валидация структуры Voronoi данных из Azgaar's FMG
- Конвертация Voronoi ячеек в прямоугольную сетку через интерполяцию
- Генерация плоской карты
- **КЛЮЧЕВОЕ**: Voronoi данные **discardируются** после интерполяции

**Основные методы**:
- `validatePackCellsData(data)` - валидация JSON структуры
- `processPackCellsToGrid(rawData, scene, gridResolution)` - основной конвертер
- `createFlatGrid(defaultHeight, scene, gridResolution)` - плоская карта
- `getUnifiedGrid()` - получить текущую сетку
- `getGridMetadata()` - получить метаданные
- `clear()` - очистить данные

**Хранит**:
- `unifiedGrid`: {heights: Float32Array, biomes: Uint8Array, rows, cols}
- `gridMetadata`: {sourceType, cellSize, bounds, heightStats, biomeStats, timestamp, ...}

**НЕ хранит**: Исходные Voronoi координаты, cellPositions, или другие ссылки на исходные данные

---

### 2. `global-map-renderer.mjs`
**Назначение**: Чистая визуализация unified сетки

**Ответственность**:
- Рендеринг сетки на PIXI canvas
- Управление видимостью (show/hide/toggle)
- Применение цветовых функций (heights, biomes или оба)
- **КЛЮЧЕВОЕ**: Не модифицирует данные, только отображает

**Основные методы**:
- `initialize()` - инициализация с canvasReady hook
- `setupContainer()` - создание PIXI контейнера
- `render(gridData, metadata, renderOptions)` - основной рендер
- `show()`, `hide()`, `toggle()` - управление видимостью
- `clear()` - удалить рендеринг

**Рендер-опции**:
```javascript
{
  mode: 'heights' | 'biomes' | 'both',
  heightColorFunc: (height, stats) => color,
  biomeColorFunc: (biomeId) => color,
  opacity: 0-1,
  cellBorder: true/false
}
```

**Встроенные цветовые функции**:
- Heights: Blue (min) → Green → Yellow → Red (max)
- Biomes: HSL-based распределение по ID

---

### 3. `global-map-tools.mjs`
**Назначение**: Инструменты редактирования unified сетки

**Ответственность**:
- Управление инструментами (raise, lower, smooth, flatten, inspect)
- Обработка mouse events для рисования
- Визуализация курсора и превью
- Сохранение изменений в scene flags

**Основные методы**:
- `activate()` / `deactivate()` - включить/выключить режим редактирования
- `setTool(tool)` - выбрать инструмент
- `setBrushParams(radius, strength, targetHeight)` - параметры кисти
- `applyBrushStroke(x, y)` - применить stroke к temporary overlay
- `commitOverlay()` - применить temporary overlay к grid
- `saveGridChanges()` - сохранить в scene flags

**Инструменты**:
- `inspect` - просмотр высоты в точке
- `raise` - поднять местность
- `lower` - опустить местность
- `smooth` - сглаживание
- `flatten` - выравнивание к целевой высоте

---

### 4. `global-map-ui.mjs`
**Назначение**: UI контролы и диалоги

**Ответственность**:
- Регистрация сцены-контролов (вкладка Global Map)
- Диалог импорта карты
- Управление кнопками действий

**Основные функции**:
- `registerGlobalMapUI(controls, spaceholder)` - регистрация UI
- `showGlobalMapImportDialog(processing, renderer)` - диалог импорта

**Кнопки в сцене-контролах**:
- `inspect-map` (default tool) - просмотр карты
- `import-map` (button) - импорт из JSON или создание плоской карты
- `toggle-map` (button) - скрыть/показать
- `edit-map` (button) - активировать режим редактирования
- `clear-map` (button) - очистить загруженную карту

---

## Поток данных

### Импорт карты из файла
```
User нажимает "Импортировать карту"
         ↓
showGlobalMapImportDialog() открывается
         ↓
User выбирает JSON файл или оставляет пусто
         ↓
processing.processPackCellsToGrid(rawData, scene)
         ↓
Voronoi ячейки → интерполяция → rectangular grid
         ↓
Voronoi данные discardируются (GC)
         ↓
unifiedGrid = {heights: Float32Array, biomes: Uint8Array, rows, cols}
metadata = {cellSize, bounds, heightStats, ...}
         ↓
renderer.render(unifiedGrid, metadata, {mode: 'heights'})
         ↓
PIXI Graphics рисует сетку с цветовой градацией
         ↓
Карта видна на canvas
```

### Редактирование карты
```
User нажимает "Редактировать карту"
         ↓
tools.activate()
         ↓
Mouse listeners установлены
Brush cursor показан
Tools UI отображена
         ↓
User рисует на canvas с кистью (raise/lower/smooth/flatten)
         ↓
tools.applyBrushStroke(x, y)
         ↓
tempOverlay += delta * falloff * strength (для каждой клетки)
         ↓
User отпускает мышь
         ↓
tools.commitOverlay()
         ↓
unifiedGrid.heights[i] += tempOverlay[i]
         ↓
renderer.render() перерисовывает сетку
         ↓
User нажимает "Save & Exit"
         ↓
tools.deactivate()
         ↓
tools.saveGridChanges()
         ↓
scene.setFlag('spaceholder', 'globalMapGrid', {heights, biomes, rows, cols, metadata})
```

---

## Ключевые особенности архитектуры

### ✅ Разделение ответственности
- **Processing**: только обработка данных
- **Renderer**: только визуализация
- **Tools**: только редактирование
- **UI**: только управление UI

### ✅ Независимость от исходного формата
- Voronoi данные конвертируются один раз и удаляются
- Система работает только с unified rectangular grid
- Если формат Azgaar FMG изменится - нужно менять только processing модуль

### ✅ Нет сохранения Voronoi ячеек
- После интерполяции все исходные позиции discardируются
- Память используется эффективнее (только Float32Array + Uint8Array)
- Гарантирует воспроизводимость: одни и те же входные данные → одна и та же сетка

### ✅ Чистая архитектура
- Каждый модуль имеет ясный интерфейс
- Модули легко тестировать независимо
- Легко добавлять новые рендер-опции или инструменты

---

## Хранение данных

### Scene Flags
```javascript
scene.getFlag('spaceholder', 'globalMapGrid')
↓
{
  heights: [1, 2, 3, ...],  // Array из Float32Array
  biomes: [0, 0, 1, ...],   // Array из Uint8Array
  rows: 32,
  cols: 48,
  metadata: {
    sourceType: 'PackCells' | 'Flat',
    cellSize: 16,
    bounds: {minX: 0, minY: 0, maxX: 768, maxY: 512},
    heightStats: {min: 0, max: 100, range: 100},
    biomeStats: {uniqueBiomes: [0, 1, 2, ...], totalCells: 1536},
    timestamp: '2025-11-20T02:16:00.000Z'
  }
}
```

---

## Переход от старой системы

### Что отключено
- HeightMapManager
- HeightMapRenderer
- HeightMapEditor
- BiomeManager
- BiomeRenderer
- BiomeEditor
- TerrainFieldManager

### Что нового
- GlobalMapProcessing
- GlobalMapRenderer
- GlobalMapTools
- GlobalMapUI (регистрирует сцена-контролы)

### API для других компонентов
```javascript
game.spaceholder.globalMapProcessing   // Обработка данных
game.spaceholder.globalMapRenderer     // Визуализация
game.spaceholder.globalMapTools        // Редактирование
```

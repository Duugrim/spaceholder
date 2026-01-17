# Проблема
Нужно добавить в Global Map возможность создавать «Регионы»: произвольные области на карте, которые при наведении подсвечивают границы и показывают название. Опционально — у региона может быть ссылка на Journal (JournalEntry/JournalEntryPage) и действие по клику.
# Текущее состояние (как сейчас устроено)
## Визуализация
`module/helpers/global-map/global-map-renderer.mjs` рисует карту в `PIXI.Container`, который добавляется в `canvas.primary`:
* `mapLayer` — биомы/высоты
* `riversLayer` и `riverLabelsLayer` — «векторные реки» поверх карты
Векторные реки:
* хранятся в флаге сцены `scene.flags.spaceholder.globalMapRivers`
* отрисовываются через `renderVectorRivers()`
* подписи показываются в режиме `labelMode: hover|always|off` через обработчик `pointermove` на `canvas.stage`.
## Редактирование
`module/helpers/global-map/global-map-tools.mjs` содержит UI-окно (jQuery + inline styles) с вкладкой Rivers:
* режимы `river-draw` (добавление точек) и `river-edit` (перетаскивание/вставка/удаление)
* оверлей хэндлов (`PIXI.Graphics`) на `canvas.interface` (чтобы не попадал в экспорт)
* сохранение в флаг сцены через `scene.setFlag('spaceholder','globalMapRivers', data)`.
# Предлагаемое решение
## 1) Модель данных (Scene Flags)
Добавить новый флаг сцены `scene.flags.spaceholder.globalMapRegions` со структурой, аналогичной рекам:
* `version: 1`
* `settings`: 
    * `labelMode: 'hover'|'always'|'off'` (по умолчанию `hover`)
    * `clickAction: 'none'|'openJournal'` (по умолчанию `openJournal` или `none` — уточнить)
    * `clickModifier: 'none'|'ctrl'|'alt'|'shift'` (по умолчанию `ctrl` — чтобы не мешать обычным кликам)
* `regions: Array<Region>`
`Region` (v1):
* `id: string`
* `name: string`
* `points: Array<{x:number,y:number}>`
* `closed: boolean` (пока рисуем — `false`, после Finish — `true`)
* `color?: number` (0xRRGGBB, опционально; если нет — берём дефолт)
* `journalUuid?: string` (опционально, может быть JournalEntry или JournalEntryPage)
Нормализация/валидация данных делается в renderer (как сейчас для рек) и используется tools как “source of truth”.
## 2) Renderer: слой и отрисовка регионов
Правки в `global-map-renderer.mjs`:
* В `setupContainer()` добавить слои:
    * `regionsLayer` (базовые контуры/заливка)
    * `regionLabelsLayer`
    * `regionHoverLayer` (подсветка наведённого региона; отдельный `PIXI.Graphics`, чтобы не перерисовывать всё)
* Добавить состояние:
    * `vectorRegionsData`
    * `_regionHoverHandler`, `_regionClickHandler`
    * `_hoveredRegionId`, `_regionHoverLabel`
    * кэши: `_regionBounds`, `_regionLabelAnchors` (аналогично рекам)
* Реализовать методы:
    * `loadVectorRegionsFromScene(scene)`
    * `setVectorRegionsData(data, metadata)`
    * `clearVectorRegions()`
    * `_normalizeVectorRegionsData(data)`
    * `renderVectorRegions(regionsData, metadata)`
Отрисовка:
* Если регион `closed` и `points.length >= 3`:
    * базовый контур тонкий/полупрозрачный (и, опционально, очень слабая заливка)
    * для `labelMode === 'always'` рисуем подпись в `regionLabelsLayer` в якорной точке (центроид или центр bbox).
* Если регион не закрыт — рисуем полилинию (как превью при рисовании).
Hover:
* На `pointermove` вычисляем “hit”:
    * быстрый отсев по bbox
    * точное попадание через point-in-polygon (ray casting) только для `closed` регионов
* При попадании:
    * в `regionHoverLayer` рисуем подсветку контура (толще/ярче)
    * показываем `_regionHoverLabel` (в режиме `hover`) в anchor.
Click (опционально):
* На `pointerdown` при попадании по региону и выполнении модификатора (`ctrl/alt/shift`):
    * если у региона есть `journalUuid`, открыть документ:
        * если `JournalEntryPage` → открыть `doc.parent.sheet`
        * иначе `doc.sheet`
Export:
* В `exportToBlob()` временно скрывать не только `_riverHoverLabel`, но и `_regionHoverLabel` и `regionHoverLayer` (чтобы подсветка не “попала” в запекание).
## 3) Tools: вкладка Regions и редактор
Правки в `global-map-tools.mjs`:
* Добавить состояние (аналогично rivers):
    * `vectorRegions`, `vectorRegionsDirty`
    * `selectedRegionId`, `selectedRegionPointIndex`
    * `regionHandles`, `_regionDrag`
    * `_selectedRegionsTool` и инструменты `region-draw`, `region-edit`
* UI:
    * Добавить вкладку `Regions` рядом с `Rivers`.
    * Элементы управления:
        * select региона
        * New / Rename / Delete
        * Mode: Draw / Edit
        * Finish (закрыть полигон)
        * Label mode (hover/always/off)
        * Link to Journal (поле + кнопки: Clear / Open; и поддержка drag&drop UUID как в других местах системы)
        * Save regions
        * Activate Region Editor
* Логика событий:
    * В `activateBrush()` добавить ветку для `#regions-tab` (как для rivers):
        * отключать `singleCellMode`
        * инициализировать данные и оверлей хэндлов
    * В `_installStageEventListeners()` маршрутизировать события в редактор регионов, если активен `region-*` инструмент.
Редактирование (MVP, по аналогии с реками):
* Draw:
    * click → добавить точку в конец
    * Finish → если точек < 3, предупреждение; иначе `closed = true` и переключаемся в Edit
* Edit:
    * drag точки → перемещение
    * Alt+click по ребру → вставка вершины
    * Ctrl+click по вершине → удалить вершину
Сохранение:
* `saveVectorRegions()` → `scene.setFlag('spaceholder','globalMapRegions', vectorRegions)`.
## 4) Минимальный набор изменений по файлам
* `module/helpers/global-map/global-map-renderer.mjs`
    * новые слои, загрузка/нормализация/рендер регионов, hover/click handlers, экспорт.
* `module/helpers/global-map/global-map-tools.mjs`
    * новая вкладка Regions, новые инструменты и обработчики, сохранение флага.
* Опционально: `module/helpers/global-map/global-map-ui.mjs`
    * добавить кнопку/тумблер “toggle regions visibility” (если понадобится отдельное управление видимостью).
# Вопросы для уточнения (чтобы зафиксировать поведение до реализации)
1) Регионы должны быть видимы всегда (тонкий контур) или полностью “скрытые” и показываются только при наведении?
2) Клик по региону должен открывать журнал без модификаторов или лучше Ctrl+Click/Alt+Click?
3) Нужна ли заливка региона (очень слабая) или только контур?
4) Ссылка — достаточно JournalEntry/JournalEntryPage или нужно поддержать и другие документы (например, Scene/Actor)?
5) Хотим ли цвет на регион (разные регионы разными цветами) уже в первой версии?
# Риски и как их закрыть
* Производительность hover: решаем bbox-отсевом + point-in-polygon только на кандидатов.
* “Лишние” клики: по умолчанию используем модификатор для clickAction.
* Экспорт/запекание: обязательно скрывать hover-подсветку на время export.
* Canvas rebuild: как для рек, переустанавливать обработчики и переаттачивать слои/оверлеи в `onCanvasReady`.
# Вне рамок (можно отдельным PR)
* Миграция диалогов на DialogV2 и, при желании, перенос Tools UI на ApplicationV2.
* Вынос inline styles в SCSS (сейчас в GlobalMapTools много inline CSS).

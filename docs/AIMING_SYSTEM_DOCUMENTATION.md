# Документация системы прицеливания SpaceHolder

## Обзор архитектуры

Система прицеливания состоит из 5 основных модулей:
- **AimingSystem** - основной контроллер
- **RayCaster** - создание лучей и проверка коллизий
- **RayRenderer** - визуализация и UI
- **AimingSocketManager** - мультиплеерная синхронизация
- **AimingDialog** - диалог настроек

---

## AimingSystem (aiming-system.mjs)

### Основные функции

#### `initialize()`
- **Назначение**: Инициализация системы прицеливания при загрузке
- **Условия вызова**: Автоматически в хуке `ready`
- **Вызывает**: 
  - `_registerSettings()`
  - `rayCaster.initialize()`
  - `rayRenderer.initialize()`
  - `socketManager.initialize()`

#### `startAiming(token, weapon = null)`
- **Назначение**: Начать прицеливание для указанного токена
- **Условия вызова**: Пользователь активирует прицеливание (макрос, UI)
- **Параметры**: 
  - `token` - Token объект
  - `weapon` - оружие (опционально)
- **Вызывает**:
  - `stopAiming()` (если уже прицеливается)
  - `_showAimingUI()`
  - `_bindEvents()`
  - `_updateAimingPreview()`
  - `_notifyAimingStart()`
- **Возвращает**: `boolean` - успех операции

#### `stopAiming()`
- **Назначение**: Прекратить текущее прицеливание
- **Условия вызова**: 
  - Пользователь отменяет (ПКМ, ESC)
  - Автоматически при завершении выстрела (опционально)
  - При смене токена
- **Вызывает**:
  - `_hideAimingUI()`
  - `_unbindEvents()`
  - `rayRenderer.clearRay()`
  - `_notifyAimingEnd()`

#### `fire()`
- **Назначение**: Выстрелить в текущем направлении (асинхронный)
- **Условия вызова**: 
  - ЛКМ во время прицеливания
  - Вызов `fireShot()` макроса
- **Вызывает**:
  - `aimingLogger.startShot()`
  - `socketManager.broadcastFireShot()`
  - `_fireRecursive()` - основная логика выстрела
  - `_processHits()` - обработка попаданий
  - `aimingLogger.finishShot()`
  - `socketManager.broadcastShotComplete()`

### Приватные функции выстрела

#### `_fireRecursive(fireState)`
- **Назначение**: Рекурсивная отрисовка сегментов выстрела с проверкой коллизий
- **Условия вызова**: Внутренняя логика выстрела
- **Параметры**: 
  ```javascript
  fireState = {
    currentPosition: {x, y},
    direction: число,
    segmentIndex: число,
    totalHits: массив,
    segments: массив,
    ricochetCount: число,
    lastWallId: строка,
    socketData: объект
  }
  ```
- **Вызывает**:
  - `rayCaster.createSimpleRay()`
  - `rayCaster.checkSegmentCollisions()`
  - `rayRenderer.drawFireSegment()`
  - `socketManager.broadcastShotSegment()`
  - `_canRicochet()` и `_calculateRicochetDirection()`
  - Рекурсивно самостоятельно для рикошетов
- **Возвращает**: `Promise<{totalHits, segments}>`

#### `_canRicochet(collision, currentRicochets)`
- **Назначение**: Проверить возможность рикошета
- **Условия вызова**: При столкновении со стеной в `_fireRecursive()`
- **Параметры**: объект коллизии, текущее количество рикошетов
- **Проверяет**:
  - `config.allowRicochet`
  - Лимит `config.maxRicochets`
  - Тип объекта (только стены)
- **Возвращает**: `boolean`

#### `_calculateRicochetDirection(segment, wallCollision)`
- **Назначение**: Вычислить направление рикошета по формуле отражения
- **Условия вызова**: После подтверждения возможности рикошета
- **Алгоритм**: R = I - 2(I·N)N (отражение от нормали стены)
- **Возвращает**: число (новое направление в градусах)

#### `_shouldStopFiring(collision)`
- **Назначение**: Определить нужно ли остановить выстрел
- **Условия вызова**: При любой коллизии в `_fireRecursive()`
- **Правила**:
  - `token` → всегда стоп
  - `wall` → стоп (если нет рикошета)
  - `tile` → стоп
- **Возвращает**: `boolean`

### Обработка событий

#### `_onMouseMove(event)`
- **Назначение**: Обновление направления прицела по движению мыши
- **Условия вызова**: Событие `mousemove` во время прицеливания
- **Вычисляет**: угол от центра токена до курсора
- **Вызывает**: `_updateAimingPreview()`

#### `_onMouseDown(event)`
- **Назначение**: Обработка кликов мыши
- **Условия вызова**: Событие `mousedown` во время прицеливания
- **Логика**:
  - ЛКМ (button === 0) → `fire()`
- **Вызывает**: `fire()`

#### `_onKeyDown(event)` / `_onKeyUp(event)`
- **Назначение**: Обработка клавиатуры
- **Условия вызова**: События клавиатуры во время прицеливания
- **Обрабатывает**:
  - `Escape` → `stopAiming()`

#### `_onContextMenu(event)`
- **Назначение**: Обработка ПКМ (отмена прицеливания)
- **Условия вызова**: `contextmenu` во время прицеливания
- **Вызывает**: `stopAiming()`

### UI и визуализация

#### `_updateAimingPreview()`
- **Назначение**: Обновить предпросмотр прицеливания (зеленый луч)
- **Условия вызова**: 
  - При движении мыши
  - При начале прицеливания
- **Троттлинг**: Ограничен `_previewUpdateInterval`
- **Вызывает**:
  - `rayCaster.createSimpleRay()` с `config.previewRayLength`
  - `rayRenderer.updateAimingPreview()`

#### `_showAimingUI()` / `_hideAimingUI()`
- **Назначение**: Показать/скрыть UI прицеливания
- **Вызывает**:
  - `rayRenderer.showAimingReticle()` / `hideAimingReticle()`
  - `_showAimingInfo()` / `_hideAimingInfo()`
- **Изменяет**: курсор на `crosshair`

#### `_showAimingInfo()` / `_hideAimingInfo()`
- **Назначение**: Управление информационной панелью
- **Создает/удаляет**: DOM элемент `#aiming-info`

### Обработка попаданий

#### `_processHits(collisions)`
- **Назначение**: Обработать все столкновения после выстрела
- **Условия вызова**: После завершения `_fireRecursive()`
- **Вызывает** для каждой коллизии:
  - `_processTokenHit()`
  - `_processWallHit()` 
  - `_processTileHit()`

#### `_processTokenHit(target, isPrimary, hitNumber, totalHits)`
- **Назначение**: Обработать попадание в токен
- **Создает**: `ChatMessage` с информацией о попадании
- **Логика**: Различает первичные и пробивающие попадания

#### `_processWallHit(wall, hitNumber, totalHits)`
- **Назначение**: Обработать попадание в стену
- **Определяет**: тип стены (дверь/стена), состояние (открыта/закрыта)
- **Создает**: `ChatMessage`

#### `_processTileHit(tile, hitNumber, totalHits)`
- **Назначение**: Обработать попадание в тайл
- **Создает**: `ChatMessage`

### Управление событиями

#### `_bindEvents()` / `_unbindEvents()`
- **Назначение**: Привязка/отвязка обработчиков событий
- **События**:
  - `canvas.stage.on('mousemove')`
  - `canvas.stage.on('mousedown')`
  - `document.addEventListener('keydown/keyup/contextmenu')`

---

## RayCaster (ray-casting.mjs)

### Основные функции создания лучей

#### `initialize()`
- **Назначение**: Инициализация системы лучей
- **Условия вызова**: Из `AimingSystem.initialize()`

#### `createRay(origin, direction, maxDistance, options = {})`
- **Назначение**: Создать полноценный луч с поддержкой рикошетов
- **Параметры**:
  - `origin: {x, y}` - начальная точка
  - `direction: число` - направление в градусах
  - `maxDistance: число` - максимальная дальность
  - `options: объект` - настройки (allowRicochet, maxRicochets, curved)
- **Вычисляет**: конечную точку через тригонометрию
- **Создает**: объект луча с сегментами и свойствами коллизий
- **Возвращает**: объект луча

#### `createSimpleRay(origin, direction, distance)`
- **Назначение**: Создать упрощенный луч для предпросмотра и сегментов
- **Условия вызова**:
  - Из `_updateAimingPreview()` для предпросмотра
  - Из `_fireRecursive()` для сегментов выстрела
- **Отличие**: Без дополнительных свойств коллизий
- **Возвращает**: упрощенный объект луча

#### `createCurvedRay(origin, target, maxDistance, curvature = 0.5)`
- **Назначение**: Создать изогнутый луч (экспериментальная функция)
- **Алгоритм**: кривая Безье с контрольной точкой
- **Вызывает**: `_generateBezierCurve()`
- **Возвращает**: луч с массивом точек кривой

### Проверка коллизий

#### `checkSegmentCollisions(segment)`
- **Назначение**: Проверить столкновения для одного сегмента
- **Условия вызова**: Из `_fireRecursive()` для каждого сегмента
- **Вызывает**:
  - `_checkTokenCollisions(segment)`
  - `_checkWallCollisions(segment)`
  - `_checkTileCollisions(segment)` (если включено)
- **Сортирует**: результаты по расстоянию
- **Возвращает**: массив коллизий

#### `checkCollisions(ray)`
- **Назначение**: Проверить коллизии для полного луча (устаревшая)
- **Вызывает**: проверки для всех сегментов луча
- **Обрабатывает**: рикошеты через `_processRicochets()`

### Приватные функции проверки коллизий

#### `_checkTokenCollisions(segment)`
- **Назначение**: Найти пересечения с токенами
- **Алгоритм**: пересечение луча с кругом (не прямоугольником)
- **Исключения**: 
  - Токен-стрелок (`this.aimingSystem.aimingToken`)
  - Невидимые токены
- **Вызывает**: `_rayCircleIntersection()`
- **Возвращает**: массив объектов `{type: 'token', object, point, distance, segment}`

#### `_checkWallCollisions(segment)`
- **Назначение**: Найти пересечения со стенами
- **Алгоритм**: пересечение отрезков
- **Фильтрует**: только стены с `wall.document.move` (блокирующие движение)
- **Вызывает**: `_raySegmentIntersection()`
- **Создает**: `foundry.canvas.geometry.Ray` для стен
- **Возвращает**: массив объектов `{type: 'wall', object, point, distance, segment, wallRay}`

#### `_checkTileCollisions(segment)`
- **Назначение**: Найти пересечения с тайлами
- **Фильтрует**: только тайлы с `tile.document.occlusion.mode`
- **Вызывает**: `_rayRectangleIntersection()`
- **Возвращает**: массив объектов `{type: 'tile', object, point, distance, segment}`

### Математические функции

#### `_raySegmentIntersection(rayStart, rayEnd, segmentStart, segmentEnd)`
- **Назначение**: Вычислить пересечение двух отрезков
- **Алгоритм**: Система линейных уравнений
- **Проверяет**: что пересечение лежит на обоих отрезках (t ∈ [0,1], u ∈ [0,1])
- **Возвращает**: `{x, y}` или `null`

#### `_rayCircleIntersection(rayStart, rayEnd, center, radius)`
- **Назначение**: Вычислить пересечение отрезка с кругом
- **Алгоритм**: Квадратное уравнение at² + bt + c = 0
- **Выбирает**: ближайшую точку пересечения
- **Возвращает**: `{x, y}` или `null`

#### `_rayRectangleIntersection(ray, rectangle)`
- **Назначение**: Вычислить пересечение луча с прямоугольником
- **Алгоритм**: Метод отсечения по осям
- **Возвращает**: `{x, y}` или `null`

### Рикошеты (устаревший функционал)

#### `_processRicochets(ray, collisions, maxRicochets, currentBounce)`
- **Назначение**: Обработать рикошеты (используется в старой версии)
- **Логика**: Рекурсивная обработка отражений от стен
- **Вызывает**: `_calculateReflection()`
- **Примечание**: В новой версии рикошеты обрабатываются в AimingSystem

#### `_calculateReflection(ray, wallCollision)`
- **Назначение**: Вычислить отраженный сегмент
- **Использует**: формулу отражения вектора от нормали
- **Возвращает**: новый сегмент для рикошета

---

## RayRenderer (ray-renderer.mjs)

### Инициализация и контейнеры

#### `initialize()`
- **Назначение**: Базовая инициализация рендерера
- **Создает**: `this.graphics = new PIXI.Graphics()`

#### `onCanvasReady()`
- **Назначение**: Обработка готовности холста
- **Условия вызова**: Хук `canvasReady`
- **Вызывает**: `_createContainers()`

#### `_createContainers()`
- **Назначение**: Создать графические контейнеры PIXI
- **Создает**:
  - `aimingContainer` (основной, zIndex: 1000)
  - `rayContainer` (лучи)
  - `reticleContainer` (прицельная сетка)
  - `animationContainer` (анимации)
- **Добавляет**: в `canvas.stage`

### Прицельная сетка

#### `showAimingReticle(token)`
- **Назначение**: Показать прицельную сетку вокруг токена-стрелка
- **Условия вызова**: Из `_showAimingUI()`
- **Создает**:
  - Красные концентрические круги
  - Крестик в центре
  - Деления по периметру (8 штук)
- **Вызывает**:
  - `hideAimingReticle()` (очистка предыдущей)
  - `_showTargetCircles()`
  - `_animateReticle()`

#### `hideAimingReticle()`
- **Назначение**: Скрыть прицельную сетку
- **Вызывает**: `_hideTargetCircles()`
- **Уничтожает**: `currentReticle`

#### `_showTargetCircles()`
- **Назначение**: Показать оранжевые мишени на всех токенах
- **Исключения**: токен-стрелок, невидимые токены
- **Создает**: оранжевые кольца с центральной точкой
- **Вызывает**: `_animateTargetCircle()` для каждой мишени
- **Сохраняет**: в `this.targetCircles Map`

#### `_hideTargetCircles()`
- **Назначение**: Скрыть все мишени
- **Уничтожает**: все объекты из `targetCircles`

### Анимации UI

#### `_animateReticle(reticle)`
- **Назначение**: Анимация пульсации прицельной сетки
- **Алгоритм**: Синусоидальное изменение альфы (0.3 ± 0.3)
- **Цикл**: 2 секунды
- **Останавливается**: при `!this.aimingSystem.isAiming`

#### `_animateTargetCircle(targetCircle, targetAlpha)`
- **Назначение**: Анимация появления мишени
- **Длительность**: 300мс fade-in
- **Останавливается**: при `!this.aimingSystem.isAiming`

### Предпросмотр прицеливания

#### `updateAimingPreview(ray)`
- **Назначение**: Обновить зеленый луч предпросмотра
- **Условия вызова**: Из `_updateAimingPreview()` при движении мыши
- **Стиль**: зеленый (#00FF00), альфа 0.7, ширина 3px
- **Очищает**: только предыдущий предпросмотр (не сегменты выстрелов)
- **Вызывает**: `clearPreview()`, `_animatePreviewRay()`
- **Создает**: маркер начала луча (зеленый кружок)

#### `_animatePreviewRay(rayGraphics)`
- **Назначение**: Мигание луча предпросмотра
- **Алгоритм**: Синусоидальное изменение альфы (0.5 ± 0.2)
- **Цикл**: 1 секунда
- **Останавливается**: при `!this.aimingSystem.isAiming`

### Отрисовка выстрелов

#### `drawFireSegment(segment, segmentIndex)`
- **Назначение**: Отрисовать один сегмент выстрела
- **Условия вызова**: Из `_fireRecursive()` для каждого сегмента
- **Стили**:
  - **Основной выстрел**: красный (#FF4444), альфа 0.9, ширина 4px
  - **Рикошет 1**: оранжевый (#FF8800), альфа 0.9, ширина 4px
  - **Рикошет 2**: желто-оранжевый (#FFCC00), альфа 0.9, ширина 4px
  - **Рикошет 3+**: желтый (#FFFF00), альфа 0.9, ширина 4px
- **Анимация**: fade-in за 100мс (рикошеты 150мс)
- **Сохраняет**: в `this.fireSegments[]` для управления
- **Создает**: маркер начала сегмента

### Мультиплеерная визуализация

#### `visualizeRemoteShot(shotData)`
- **Назначение**: Показать выстрел от другого игрока
- **Условия вызова**: Из `AimingSocketManager._startRemoteShotVisualization()`
- **Параметры**: `{token, direction, segments, hits}`
- **Вызывает**:
  - `_showRemoteShotMarker()`
  - `_animateRemoteSegment()` для каждого сегмента
  - `_createExplosionEffect()` для попаданий
- **НЕ очищает**: предыдущие выстрелы

#### `displayRemoteShotSegment(segmentData)`
- **Назначение**: Отобразить один сегмент удаленного выстрела
- **Условия вызова**: Из `AimingSocketManager._handleShotSegment()`
- **Стили** (синие вместо красных):
  - **Основной**: синий (#4444FF), альфа 0.8, ширина 3px
  - **Рикошет 1**: зелено-голубой (#00FF88)
  - **Рикошет 2**: голубой (#00CCFF)
  - **Рикошет 3+**: синий (#0088FF)
- **Сохраняет**: в `this.remoteSegments Map(tokenId -> segments[])`

#### `displayRemoteHitEffect(hitData)`
- **Назначение**: Показать эффект попадания от другого игрока
- **Вызывает**: `_createRemoteExplosionEffect()`

#### `completeRemoteShot(completeData)`
- **Назначение**: Завершить визуализацию удаленного выстрела
- **Вызывает**: `_scheduleRemoteShotFadeOut()` (исчезновение через 10 сек)

### Приватные функции удаленной визуализации

#### `_showRemoteShotMarker(token)`
- **Назначение**: Показать синий маркер начала удаленного выстрела
- **Стиль**: синий круг (#0088FF) с белым центром
- **Анимация**: мигание 3 секунды
- **Название**: `remoteShotMarker_${token.id}`

#### `_animateRemoteSegment(segment, segmentIndex, tokenId)`
- **Назначение**: Анимировать сегмент удаленного выстрела
- **Вызывает**: `displayRemoteShotSegment()`
- **Задержка**: 50мс (основной) или 75мс (рикошет)

#### `_scheduleRemoteShotFadeOut(tokenId)` / `_fadeOutRemoteShot(tokenId)`
- **Назначение**: Запланировать/выполнить исчезновение удаленного выстрела
- **Таймер**: 10 секунд после завершения
- **Анимация**: 2-секундное fade-out
- **Управляет**: `this.remoteShotTimers Map`

#### `_clearRemoteEffects(tokenId)`
- **Назначение**: Очистить все удаленные эффекты для токена
- **Отменяет**: таймеры исчезновения
- **Уничтожает**: все сегменты из `remoteSegments`

### Эффекты взрывов

#### `_createExplosionEffect(point, type)`
- **Назначение**: Создать эффект взрыва в точке попадания (локальный)
- **Условия вызова**: После попадания в `fire()`
- **Стили**:
  - `token` → красный (#FF0000)
  - `wall` → серый (#888888)
  - `default` → оранжевый (#FF8800)
- **Анимация**: расширяющийся круг 500мс, радиус до 20px

#### `_createRemoteExplosionEffect(point, type)`
- **Назначение**: Эффект взрыва для удаленного попадания
- **Стили**: синие оттенки вместо красно-оранжевых
- **Анимация**: меньший радиус (15px), 400мс

### Управление визуализацией

#### `clearPreview()`
- **Назначение**: Очистить только луч предпросмотра
- **Уничтожает**: `currentRayGraphics`
- **НЕ трогает**: сегменты выстрелов

#### `clearRay()`
- **Назначение**: Очистить предпросмотр и все сегменты выстрела
- **Вызывает**: `clearPreview()`
- **Уничтожает**: все объекты из `fireSegments[]`

#### `clearAll()`
- **Назначение**: Полная очистка всех визуальных элементов
- **Вызывает**: `clearRay()`, `hideAimingReticle()`
- **Очищает**: `animationContainer`, останавливает анимации
- **Условия вызова**: При выходе из системы

---

## AimingSocketManager (aiming-socket-manager.mjs)

### Инициализация

#### `initialize()`
- **Назначение**: Инициализация socket-менеджера
- **Условия вызова**: Из `AimingSystem.initialize()`
- **Регистрирует**: `game.socket.on(this.socketName, this._handleSocketMessage)`
- **socketName**: `system.${game.system.id}` (system.spaceholder)

### Отправка событий

#### `broadcastFireShot(shotData)`
- **Назначение**: Отправить событие начала выстрела всем клиентам
- **Условия вызова**: Из `fire()` при начале выстрела
- **Тип сообщения**: `aimingSystem.fireShot`
- **Данные**: `{tokenId, direction, startPosition, timestamp, weaponName}`
- **Логирует**: через `socketLogger.logOutgoing()`

#### `broadcastShotSegment(segmentData)`
- **Назначение**: Отправить данные о сегменте траектории
- **Условия вызова**: Из `_fireRecursive()` для каждого сегмента
- **Тип сообщения**: `aimingSystem.shotSegment`
- **Данные**: `{tokenId, segmentIndex, segment{start, end, isRicochet, bounceNumber}, ricochetCount}`

#### `broadcastShotHit(hitData)`
- **Назначение**: Отправить данные о попадании
- **Условия вызова**: Из `fire()` для каждого попадания
- **Тип сообщения**: `aimingSystem.shotHit`
- **Данные**: `{tokenId, hitType, hitPoint, targetId, distance}`

#### `broadcastShotComplete(completeData)`
- **Назначение**: Отправить итоговые данные выстрела
- **Условия вызова**: Из `fire()` в конце выстрела
- **Тип сообщения**: `aimingSystem.shotComplete`
- **Данные**: `{tokenId, totalSegments, totalHits, segments[]}`

### Обработка входящих сообщений

#### `_handleSocketMessage(message)`
- **Назначение**: Роутер входящих socket-сообщений
- **Фильтрует**: собственные сообщения (`message.userId === game.user.id`)
- **Логирует**: через `socketLogger.logIncoming()`
- **Добавляет**: `_socketUserId` и `_socketUserName` в данные
- **Маршрутизирует**: по `message.type` к соответствующим обработчикам

#### `_handleFireShot(data)`
- **Назначение**: Обработать начало удаленного выстрела
- **Проверки**:
  - Наличие `data.tokenId`
  - Готовность `canvas.tokens`
  - Существование токена
  - Доступность `rayRenderer`
- **Вызывает**:
  - `socketLogger.startRemoteShot()`
  - `_startRemoteShotVisualization()`

#### `_handleShotSegment(data)`
- **Назначение**: Обработать сегмент удаленного выстрела
- **Вызывает**:
  - `socketLogger.addSegment()`
  - `rayRenderer.displayRemoteShotSegment()`

#### `_handleShotHit(data)`
- **Назначение**: Обработать попадание удаленного выстрела
- **Вызывает**:
  - `socketLogger.addHit()`
  - `rayRenderer.displayRemoteHitEffect()`

#### `_handleShotComplete(data)`
- **Назначение**: Обработать завершение удаленного выстрела
- **Вызывает**:
  - `socketLogger.finishRemoteShot()`
  - `rayRenderer.completeRemoteShot()`

### Приватные функции

#### `_startRemoteShotVisualization(token, shotData)`
- **Назначение**: Начать визуализацию удаленного выстрела
- **Проверки**: доступность `animationContainer`
- **Вызывает**:
  - `rayRenderer._resetRemoteShotTimer()` - сброс старого таймера
  - `rayRenderer._showRemoteShotMarker()` - показ маркера
  - `rayRenderer.visualizeRemoteShot()` (с задержкой 500мс)

---

## AimingDialog (aiming-dialog.mjs)

### Статические методы

#### `show(token)`
- **Назначение**: Показать диалог настройки прицеливания
- **Условия вызова**: Пользователь выбирает настройки прицеливания
- **Проверки**: токен выбран и принадлежит пользователю
- **Создает**: `foundry.applications.api.DialogV2.wait()`
- **Вызывает**:
  - `generateContent()` - создание HTML
  - `_setupPresetHandlers()` - привязка обработчиков
  - `applyConfigToAimingSystem()` при подтверждении

#### `generateContent(token, config)`
- **Назначение**: Генерация HTML-содержимого диалога
- **Включает**:
  - Пресеты дистанции (пистолет → снайперская винтовка)
  - Чекбоксы настроек
  - Механические параметры
  - Настройки производительности
  - Инструкции по использованию
- **Возвращает**: HTML строку

#### `getDefaultConfig()`
- **Назначение**: Получить конфигурацию по умолчанию
- **Значения**:
  ```javascript
  {
    maxRayDistance: 3000,
    aimingSensitivity: 1.0,
    showAimingReticle: true,
    allowRicochet: false,
    maxRicochets: 3,
    // ... остальные параметры
  }
  ```

#### `applyConfigToAimingSystem(aimingSystem, config)`
- **Назначение**: Применить настройки к системе прицеливания
- **Обновляет**: все поля в `aimingSystem.config`
- **Пересчитывает**: `_previewUpdateInterval`

### Приватные методы

#### `_setupPresetHandlers(dialog)`
- **Назначение**: Настроить обработчики пресетов в диалоге
- **Обработчики**:
  - Пресеты дистанции → обновление поля `maxRayDistance`
  - Чекбокс рикошетов → включение/отключение поля `maxRicochets`

---

## Логгеры (aiming-logger.mjs, socket-logger.mjs)

### AimingLogger

#### `startShot(token, direction, maxDistance)` / `finishShot()`
- **Назначение**: Начать/завершить отслеживание выстрела
- **Собирает**: сегменты, коллизии, рикошеты
- **Выводит**: сводный отчет в консоль

#### `addSegment()` / `addCollision()` / `addRicochetAttempt()`
- **Назначение**: Добавить события в текущий выстрел
- **Группирует**: мелкие события в большой отчет

### SocketLogger

#### `startRemoteShot()` / `finishRemoteShot()`
- **Назначение**: Отслеживание удаленных выстрелов
- **Выводит**: сводные отчеты по мультиплеерным событиям

#### `logOutgoing()` / `logIncoming()`
- **Назначение**: Логирование socket-событий
- **Фильтрует**: избыточные события (например, shotSegment)

---

## Демонстрационные функции (aiming-demo-macros.mjs)

### Глобальные макросы

#### `window.startAiming()` / `window.stopAiming()` / `window.fireShot()`
- **Назначение**: Быстрые макросы для тестирования
- **Проверяют**: выбранный токен, состояние системы
- **Показывают**: уведомления пользователю

#### `window.getAimingInfo()`
- **Назначение**: Показать статус системы в чате
- **Выводит**: детальную информацию о состоянии

#### `window.createAimingTestScene()`
- **Назначение**: Создать тестовую сцену (только GM)
- **Создает**: токены (Стрелок, Цель 1, Цель 2), стены
- **Показывает**: инструкции в чате

#### `window.quickAimingTest()` / `window.testWallIntersection()`
- **Назначение**: Автоматические тесты функционала

---

## Последовательность вызовов

### Инициализация системы
```
spaceholder.mjs:ready
├── AimingSystem.initialize()
│   ├── _registerSettings()
│   ├── RayCaster.initialize()
│   ├── RayRenderer.initialize()
│   └── AimingSocketManager.initialize()
└── injectAimingStyles()
```

### Начало прицеливания
```
startAiming(token)
├── stopAiming() [если уже активно]
├── _showAimingUI()
│   ├── rayRenderer.showAimingReticle()
│   │   ├── hideAimingReticle()
│   │   ├── _showTargetCircles()
│   │   └── _animateReticle()
│   └── _showAimingInfo()
├── _bindEvents()
├── _updateAimingPreview()
│   ├── rayCaster.createSimpleRay()
│   └── rayRenderer.updateAimingPreview()
│       └── _animatePreviewRay()
└── _notifyAimingStart()
```

### Движение мыши во время прицеливания
```
_onMouseMove()
└── _updateAimingPreview()
    ├── rayCaster.createSimpleRay()
    └── rayRenderer.updateAimingPreview()
        ├── clearPreview()
        └── _animatePreviewRay()
```

### Выстрел
```
fire()
├── aimingLogger.startShot()
├── socketManager.broadcastFireShot()
├── _fireRecursive() [рекурсивно]
│   ├── rayCaster.createSimpleRay()
│   ├── rayCaster.checkSegmentCollisions()
│   │   ├── _checkTokenCollisions()
│   │   │   └── _rayCircleIntersection()
│   │   ├── _checkWallCollisions()
│   │   │   └── _raySegmentIntersection()
│   │   └── _checkTileCollisions()
│   │       └── _rayRectangleIntersection()
│   ├── rayRenderer.drawFireSegment()
│   ├── socketManager.broadcastShotSegment()
│   ├── [если рикошет] _canRicochet() + _calculateRicochetDirection()
│   └── [рекурсивно] _fireRecursive()
├── _processHits()
│   ├── _processTokenHit()
│   ├── _processWallHit()
│   └── _processTileHit()
├── aimingLogger.finishShot()
└── socketManager.broadcastShotComplete()
```

### Обработка удаленного выстрела
```
game.socket.emit() → _handleSocketMessage()
├── _handleFireShot()
│   ├── socketLogger.startRemoteShot()
│   └── _startRemoteShotVisualization()
│       ├── rayRenderer._resetRemoteShotTimer()
│       ├── rayRenderer._showRemoteShotMarker()
│       └── rayRenderer.visualizeRemoteShot()
│           └── _animateRemoteSegment()
├── _handleShotSegment()
│   ├── socketLogger.addSegment()
│   └── rayRenderer.displayRemoteShotSegment()
├── _handleShotHit()
│   ├── socketLogger.addHit()
│   └── rayRenderer.displayRemoteHitEffect()
└── _handleShotComplete()
    ├── socketLogger.finishRemoteShot()
    └── rayRenderer.completeRemoteShot()
        └── _scheduleRemoteShotFadeOut()
```

Эта документация покрывает все основные функции системы прицеливания, их назначение, условия вызова и взаимосвязи.
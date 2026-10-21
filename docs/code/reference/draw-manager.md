---
doc-type: reference
status: current
tags:
  - sh-code-doc/reference
  - sh-code-doc/status/current
---

# DrawManager Documentation

DrawManager — модуль для отрисовки траекторий выстрелов в системе SpaceHolder. Визуализирует результат работы ShotManager.

См. также [SHOOTING_SYSTEM.md](./SHOOTING_SYSTEM.md) для общей архитектуры.

## Инициализация

```javascript
// DrawManager инициализируется в spaceholder.mjs
game.spaceholder.drawManager
game.spaceholder.drawManager.initialize()  // при canvasReady
```

## След выстрела: жизненный цикл

Каждый выстрел — отдельный слой (`PIXI.Container`) в `drawManager.layers` (Map по id выстрела). Яркость слоя зависит **только от возраста выстрела** (`shotTrailAlpha` в `helpers/shot-trail.mjs`) и не зависит от состояния стрелка:

| Возраст (при жизни 60 с) | Яркость |
|--------------------------|---------|
| 0–3 с | 1 (плавное появление за 200 мс) |
| 3–9 с | плавно до 0.55 |
| 9–60 с | линейно до 0, затем слой уничтожается |

Время жизни — клиентская настройка `spaceholder.shotTrailFadeSeconds` (5–600 с, по умолчанию 60); применяется сразу (`applyFadeSetting()`). Возраст считается по эпохальному времени (`trailNowMs()` = `Date.now()`). **Не** по `game.time.serverTime`: в Foundry это аптайм сервера, он обнуляется при каждом перезапуске, и след, записанный до перезапуска, выглядел бы новым (отрицательный возраст) и не гас. Записи со штампом меньше `1e12` (старый формат на аптайме) отбрасываются при чтении.

Больше 150 следов одновременно (автоогонь) — самые старые быстро гаснут за 0.5 с. Цикл `requestAnimationFrame` работает, пока есть хотя бы один след, и останавливается сам. Выход из прицеливания следы **не** убирает; `clearAll()` — явная очистка.

### Откуда берутся следы

1. **Стрелок:** `AimingManager` рисует запись выстрела сразу (`drawRecord`) при включённой «автоотрисовке».
2. **Остальные клиенты:** запись приходит по сокету (`broadcastRecord` → сообщение типа `spaceholder.shotTrail` на канале `system.spaceholder`, обработчик `_onSocketMessage`) и рисуется у каждого, кто на той же сцене. Дубль отсекается по id.
3. **Запись об атаке в чате:** следы лежат внутри записи об атаке (`flags.spaceholder.attackLog` отдельного сообщения или `lines[].attack` журнала действий). Она пишется при выходе из прицеливания; хук `createChatMessage` рисует то, что клиент ещё не видел (потерянный сокет), по возрасту.
4. **Перезагрузка и смена сцены:** на `ready` и `canvasReady` `rehydrateFromChat()` перерисовывает из `game.messages` следы этой сцены, которые ещё не затухли (с яркостью по возрасту); читает `readShotRecords(message)`.

След видят все; туман войны скрывает его так же, как остальные эффекты слоя `canvas.effects`. Запись с флагом `quiet` (прицеливание с выключенной автоотрисовкой) хранится, но сама не рисуется.

### Запись выстрела (`ShotRecord`)

Чистый JSON без ссылок на токены/стены (`ShotManager.getShotRecord(uid)` → `buildShotRecord`, `helpers/shot-trail.mjs`):

```javascript
{
  v: 1, id: 'shot_…', t: 1700000000000,      // t — эпохальное время, мс (Date.now())
  sceneId, tokenId, userId,                   // опционально
  paths: [ /* shotPaths: line/circle/cone/swing…; координаты округлены до 0.1 */ ],
  hits: [ { point: {x,y}, type?: 'token'|'wall', hitPoints?: [{x,y}] } ],   // hitPoints — не больше 32
  wallPasses: [ { entryPoint, exitPoint?, penetrated: true } ],
  quiet?: true
}
```

Входящая запись из чужого флага проходит `sanitizeShotRecord` (неизвестная версия, нет `id`/`t`/путей → отбрасывается; число путей/попаданий и координаты ограничены). Тесты: `node module/helpers/shot-trail.test.mjs`.

## Основные методы

### `drawRecord(record)`

Рисует запись выстрела как слой, который затухает по возрасту. Возвращает `true`, если слой нарисован. Повторный вызов с тем же `record.id`, запись другой сцены и уже затухшая запись игнорируются — один выстрел можно безопасно предлагать из нескольких источников.

### `drawShot(shotResult)`

Оставлен для макросов и тестов: оборачивает `shotResult` в запись с новым id и временем «сейчас» и вызывает `drawRecord`. Сама система рисует записи (`drawRecord`), а не `shotResult`.

**Параметры:**
- `shotResult` (Object) — объект, возвращаемый `ShotManager.getShotResult(uid)`

**Структура shotResult (из ShotManager):**
```javascript
{
  shotPaths: [
    { type: "line", start: {x,y}, end: {x,y} },
    { type: "circle", start: {x,y}, range: number },
    { type: "cone", start: {x,y}, range, angle, direction, cut }
  ],
  shotHits: [
    { point: {x,y}, type: "token"|"wall", object, ...details }
  ]
}
```

Поле `id` в сегментах опционально (для имени PIXI-объекта).
```

**Пример использования:**
```javascript
// Через ShotManager
const uid = game.spaceholder.shotManager.createShot(token, payload, direction);
const shotResult = game.spaceholder.shotManager.getShotResult(uid);
game.spaceholder.drawManager.drawShot(shotResult);

// Ручной shotResult
game.spaceholder.drawManager.drawShot({
  shotPaths: [
    { type: "line", start: { x: 100, y: 300 }, end: { x: 200, y: 270 } }
  ],
  shotHits: []
});
```

### `clearAll()`

Сразу убирает все следы с canvas. Обычно не нужен — следы затухают сами; вызывается при смене сцены (`canvasTearDown`/`canvasReady`).

```javascript
game.spaceholder.drawManager.clearAll();
```

### `setStyles(styles)`

Устанавливает пользовательские стили для отрисовки.

**Параметры:**
- `styles` (Object) - объект со стилями для разных типов сегментов

**Структура styles:**
```javascript
{
  line: {
    color: 0xFF4444,    // Цвет в hex формате
    alpha: 0.9,         // Прозрачность (0-1)
    width: 4            // Толщина линии
  },
  circle: {
    color: 0xFF4444,    // Цвет контура
    alpha: 0.6,         // Прозрачность контура
    lineWidth: 3,       // Толщина контура
    fillAlpha: 0.2      // Прозрачность заливки
  },
  cone: {
    color: 0xFF8844,    // Цвет
    alpha: 0.7,         // Прозрачность контура
    lineWidth: 2,       // Толщина контура
    fillAlpha: 0.15     // Прозрачность заливки
  }
}
```

**Пример:**
```javascript
game.spaceholder.drawManager.setStyles({
  line: { color: 0x00FF00, width: 6 },
  circle: { color: 0x0000FF, fillAlpha: 0.3 }
});
```

## Типы сегментов

### 1. Line (Линия)

Отрисовывает прямую линию между двумя точками.

**Структура (как создаёт ShotManager):**
```javascript
{
  type: "line",
  start: { x: 100, y: 300 },
  end: { x: 200, y: 270 }
}
```

**Обязательные поля:** `type`, `start`, `end`

**Ломаная.** Перед отрисовкой `drawRecord` пропускает пути через `chainLinePaths` (`helpers/shot-trail.mjs`): подряд идущие `line`, где следующая начинается там, где закончилась предыдущая (зазор до 1.5 px — ноги рикошета лазера), склеиваются в один путь с `points: [{x,y}, …]`, а `drawLine` рисует его одной ломаной с круглыми колпачками и стыками. Отметок в начале линии и на изломах нет — след показывает пролёт, а не геометрическую фигуру. Запись выстрела при этом не меняется (в ней по-прежнему отдельные `line`), поэтому старые сообщения чата рисуются так же.

### 2. Circle (Окружность)

Отрисовывает круг с центром и радиусом.

**Структура (как создаёт ShotManager):**
```javascript
{
  type: "circle",
  start: { x: 250, y: 240 },  // Центр
  range: 50                   // Радиус
}
```

**Обязательные поля:** `type`, `start`, `range`

### 3. Cone (Конус)

Отрисовывает конусообразный сектор.

**Структура (как создаёт ShotManager):**
```javascript
{
  type: "cone",
  start: { x: 300, y: 200 },
  range: 100,
  angle: 45,
  direction: 90,
  cut: 20                     // опционально, по умолчанию 0
}
```

**Обязательные поля:** `type`, `start`, `range`, `angle`, `direction`  
**Опционально:** `cut` — радиус внутреннего усечения (0 = конус от центра, >0 = кольцевой сектор)  
**Направление:** 0° = восток (→), 90° = юг (↓), 180° = запад (←), 270° = север (↑)

**Примеры конусов:**
```javascript
// Обычный конус
{
  id: 0,
  type: "cone",
  range: 80,
  angle: 45,
  direction: 0,      // направлен на восток
  start: { x: 200, y: 200 }
}

// Усечённый конус
{
  id: 1,
  type: "cone",
  range: 100,
  angle: 60,
  direction: 90,     // направлен на юг
  cut: 30,           // внутренний радиус 30
  start: { x: 300, y: 200 }
}
```

## Стили по умолчанию

```javascript
{
  line: {
    color: 0xFF4444,    // Красный
    alpha: 0.9,
    width: 4
  },
  circle: {
    color: 0xFF4444,    // Красный
    alpha: 0.6,
    lineWidth: 3,
    fillAlpha: 0.2
  },
  cone: {
    color: 0xFF8844,    // Оранжевый
    alpha: 0.7,
    lineWidth: 2,
    fillAlpha: 0.15
  }
}
```

## Особенности реализации

### Размещение на canvas
- Графика размещается в слое `canvas.effects`
- Скрывается туманом войны
- Отображается поверх токенов (`zIndex: 1000`)

### Интерактивность
- Графика полностью неинтерактивна
- Не блокирует клики по токенам
- Прозрачна для всех пользовательских взаимодействий

### Анимация
- Свежий выстрел появляется за 200 мс; дальше яркость — функция возраста (см. «След выстрела»)
- Яркостью слоя управляет единственный цикл `_updateLayers`, поэтому появление, старение и вытеснение не конфликтуют

### Управление памятью
- Предыдущие следы **не** удаляются при новой отрисовке: каждый живёт своё время и уничтожается по затуханию
- Корректное уничтожение PIXI объектов; не более 150 следов одновременно
- `ShotManager` хранит не более 32 последних выстрелов целиком (с ссылками на токены/стены); долговечна только запись выстрела во флаге чата

## Тестовые функции

В консоли FoundryVTT доступны следующие тестовые функции:

```javascript
// Простой тест с линиями и кругом
testDrawManager()

// Продвинутый тест с комбинацией элементов
testDrawManagerAdvanced()

// Тест одного конуса
testDrawManagerCone()

// Тест нескольких конусов в разных направлениях
testDrawManagerMultipleCones()

// Тест усечённых конусов
testDrawManagerCutCones()

// Тест с пользовательскими стилями
testDrawManagerCustomStyles()

// Очистка canvas
clearDrawManager()
```

## Пример полного использования

```javascript
// Создание сложной траектории выстрела
const complexShot = {
  shotPaths: [
    // Начальная линия
    {
      id: 0,
      type: "line",
      start: { x: 100, y: 300 },
      end: { x: 200, y: 270 }
    },
    // Область взрыва
    {
      id: 1,
      type: "circle",
      start: { x: 200, y: 270 },
      end: { x: 200, y: 270 },
      range: 40
    },
    // Конус осколков
    {
      id: 2,
      type: "cone",
      start: { x: 200, y: 270 },
      end: { x: 200, y: 270 },
      range: 80,
      angle: 90,
      direction: 45,
      cut: 15  // безопасная зона
    }
  ]
};

// Настройка стилей
game.spaceholder.drawManager.setStyles({
  line: { color: 0xFF0000, width: 5 },
  circle: { color: 0xFFAA00, fillAlpha: 0.4 },
  cone: { color: 0xFF4400, fillAlpha: 0.2 }
});

// Отрисовка
game.spaceholder.drawManager.drawShot(complexShot);

// Очистка через 5 секунд
setTimeout(() => {
  game.spaceholder.drawManager.clearAll();
}, 5000);
```
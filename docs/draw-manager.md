# DrawManager Documentation

DrawManager — модуль для отрисовки траекторий выстрелов в системе SpaceHolder. Визуализирует результат работы ShotManager.

См. также [SHOOTING_SYSTEM.md](./SHOOTING_SYSTEM.md) для общей архитектуры.

## Инициализация

```javascript
// DrawManager инициализируется в spaceholder.mjs
game.spaceholder.drawManager
game.spaceholder.drawManager.initialize()  // при canvasReady
```

## Основные методы

### `drawShot(shotResult)`

Основной метод для отрисовки результата выстрела.

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

Очищает все нарисованные элементы с canvas.

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
- Все элементы появляются с плавной анимацией
- Длительность анимации: 200ms

### Управление памятью
- Автоматическая очистка предыдущих элементов при новой отрисовке
- Корректное уничтожение PIXI объектов

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
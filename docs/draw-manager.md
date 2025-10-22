# DrawManager Documentation

DrawManager - модуль для отрисовки траекторий выстрелов в системе SpaceHolder для FoundryVTT.

## Инициализация

```javascript
// DrawManager автоматически инициализируется в system и доступен как:
game.spaceholder.drawManager
```

## Основные методы

### `drawShot(shotResult)`

Основной метод для отрисовки результата выстрела.

**Параметры:**
- `shotResult` (Object) - объект с результатами выстрела

**Структура shotResult:**
```javascript
{
  shotPaths: [
    // Массив сегментов для отрисовки
    {
      id: 0,           // Уникальный идентификатор сегмента
      type: "line",    // Тип сегмента: "line", "circle", "cone"
      // ... дополнительные параметры в зависимости от типа
    }
  ],
  shotHits: [
    // Игнорируется в текущей версии
  ]
}
```

**Пример использования:**
```javascript
const shotResult = {
  shotPaths: [
    {
      id: 0,
      type: "line",
      start: { x: 100, y: 300 },
      end: { x: 200, y: 270 }
    }
  ]
};

game.spaceholder.drawManager.drawShot(shotResult);
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

**Структура:**
```javascript
{
  id: 0,
  type: "line",
  start: { x: 100, y: 300 },  // Начальная точка
  end: { x: 200, y: 270 }     // Конечная точка
}
```

**Обязательные поля:**
- `id` - идентификатор
- `type` - должен быть `"line"`
- `start` - начальная точка с координатами `x` и `y`
- `end` - конечная точка с координатами `x` и `y`

### 2. Circle (Окружность)

Отрисовывает круг с центром и радиусом.

**Структура:**
```javascript
{
  id: 1,
  type: "circle",
  start: { x: 250, y: 240 },  // Центр окружности
  end: { x: 250, y: 240 },    // Не используется, но должен быть
  range: 50                   // Радиус окружности
}
```

**Обязательные поля:**
- `id` - идентификатор
- `type` - должен быть `"circle"`
- `start` - центр окружности с координатами `x` и `y`
- `range` - радиус окружности

### 3. Cone (Конус)

Отрисовывает конусообразный сектор.

**Структура:**
```javascript
{
  id: 2,
  type: "cone",
  start: { x: 300, y: 200 },  // Центр конуса
  end: { x: 300, y: 200 },    // Не используется, но должен быть
  range: 100,                 // Радиус конуса
  angle: 45,                  // Угол конуса в градусах
  direction: 90,              // Направление конуса в градусах
  cut: 20                     // Радиус усечения (опционально)
}
```

**Обязательные поля:**
- `id` - идентификатор
- `type` - должен быть `"cone"`
- `start` - центр конуса с координатами `x` и `y`
- `range` - внешний радиус конуса
- `angle` - угол раскрытия конуса в градусах
- `direction` - направление конуса в градусах:
  - `0°` = восток (→)
  - `90°` = юг (↓)
  - `180°` = запад (←)
  - `270°` = север (↑)

**Опциональные поля:**
- `cut` - радиус внутреннего усечения. Если не указан или `0`, рисуется обычный конус от центра. Если `> 0`, рисуется кольцевой сектор.

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
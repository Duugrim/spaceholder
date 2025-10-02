# Динамическая система анатомий SpaceHolder

## Обзор
Система позволяет использовать различные типы анатомий для актёров вместо жёстко прописанной человекоподобной структуры.

## Структура файлов

```
module/data/anatomy/
├── registry.json          # Реестр всех доступных анатомий
├── humanoid.json          # Человекоподобная анатомия
├── quadruped.json         # Четвероногие существа
└── ...                    # Дополнительные анатомии
```

## Основные компоненты

### 1. AnatomyManager (`module/anatomy-manager.mjs`)
Центральный класс для управления анатомиями:
- Загрузка и кэширование анатомий
- Валидация структуры
- Создание экземпляров для актёров
- API для получения информации

### 2. Модифицированный Actor (`module/documents/actor.mjs`)
Обновлённый класс актёра:
- Динамическая загрузка анатомий
- Совместимость со старой системой
- Новый метод `changeAnatomyType()`

### 3. Обновлённый ActorSheet (`module/sheets/actor-sheet.mjs`)
Интерфейс с поддержкой выбора анатомии:
- Выпадающий список типов анатомий
- Подтверждение смены типа
- Автоматическое обновление UI

## Структура анатомии

### Registry.json
```json
{
  "anatomies": {
    "humanoid": {
      "name": "Humanoid",
      "nameLocalized": "SPACEHOLDER.Anatomy.Humanoid",
      "file": "humanoid.json",
      "description": "Standard human-like anatomy",
      "category": "basic",
      "icon": "fas fa-male"
    }
  }
}
```

### Файл анатомии
```json
{
  "id": "humanoid",
  "name": "Humanoid",
  "bodyParts": {
    "torso": {
      "id": "torso",
      "name": "Torso", 
      "parent": null,
      "coverage": 10000,
      "currentHp": 50,
      "maxHp": 50,
      "status": "healthy",
      "internal": false,
      "tags": ["core", "vital", "armor_chest"]
    }
  }
}
```

### Новые поля частей тела
- **status** (string): Текущее состояние ("healthy", "bruised", "injured", "badly_injured", "destroyed", "missing")
- **internal** (bool): Является ли часть внутренней
- **tags** (array): Теги для категоризации и поиска

## Использование

### В коде
```javascript
// Получить менеджер анатомий
const manager = game.spaceholder.anatomyManager;

// Загрузить анатомию
const anatomy = await manager.loadAnatomy('humanoid');

// Создать анатомию для актёра с модификаторами
const actorAnatomy = await manager.createActorAnatomy('quadruped', {
  healthMultiplier: 1.5,
  overrides: {
    torso: { maxHp: 100, currentHp: 100 }
  }
});

// Сменить тип анатомии у актёра
await actor.changeAnatomyType('quadruped');
```

### В интерфейсе
1. Откройте лист персонажа
2. Перейдите на вкладку "Health"
3. Используйте выпадающий список "Anatomy Type" 
4. Подтвердите смену (все текущие части тела будут заменены)

## Тестирование

Запустите скрипт `test-anatomy.js` в консоли FoundryVTT для проверки всех функций системы.

## Добавление новых анатомий

1. Создайте JSON файл в `module/data/anatomy/`
2. Добавьте запись в `registry.json`
3. Система автоматически подхватит новую анатомию

## Совместимость

Система полностью совместима со старой системой здоровья. Старые актёры автоматически получат анатомию "humanoid" при первом открытии.

## API AnatomyManager

- `initialize()` - Инициализация менеджера
- `getAvailableAnatomies()` - Список доступных анатомий
- `loadAnatomy(id)` - Загрузка анатомии
- `createActorAnatomy(id, options)` - Создание экземпляра для актёра
- `getAnatomyDisplayName(id)` - Локализованное название
- `getStats()` - Статистика использования
- `clearCache()` - Очистка кэша
- `reload()` - Перезагрузка системы
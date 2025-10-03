# SpaceHolder Health System Documentation

## Обзор системы

SpaceHolder включает в себя комплексную систему здоровья, вдохновлённую RimWorld, которая включает:
- Детализированную анатомию с частями тела
- Систему крови и кровотечений
- Систему боли и болевого шока
- Физические способности (Physical Capacities)
- Влияние повреждений на игровые способности

## Архитектура данных

### Структура в template.json

```json
{
  "health": {
    "totalHealth": {
      "current": 0,
      "max": 0, 
      "percentage": 100
    },
    "bodyParts": {
      // Иерархическая структура частей тела
      // Загружается из анатомических шаблонов
    },
    "blood": {
      "current": 100,    // Текущий уровень крови (0-100)
      "max": 100,        // Максимальный уровень крови
      "percentage": 100, // Процент крови
      "bleeding": 0      // Скорость кровотечения
    },
    "pain": {
      "current": 0,      // Текущий уровень боли (0-100)
      "max": 100,        // Максимальная боль
      "shock": false     // Болевой шок (при боли >80%)
    }
  },
  "physicalCapacities": {
    "consciousness": { "base": 100, "current": 100, "percentage": 100 },
    "sight": { "base": 100, "current": 100, "percentage": 100 },
    "hearing": { "base": 100, "current": 100, "percentage": 100 },
    "manipulation": { "base": 100, "current": 100, "percentage": 100 },
    "movement": { "base": 100, "current": 100, "percentage": 100 },
    "breathing": { "base": 100, "current": 100, "percentage": 100 },
    "bloodPumping": { "base": 100, "current": 100, "percentage": 100 },
    "bloodFiltration": { "base": 100, "current": 100, "percentage": 100 },
    "metabolism": { "base": 100, "current": 100, "percentage": 100 },
    "talking": { "base": 100, "current": 100, "percentage": 100 }
  }
}
```

## Система расчётов

### Принцип целых чисел

**ВАЖНО**: Все расчёты используют целые числа для избежания проблем с floating point округлением:
- Множители масштабируются на **100** или **10000**
- Пример: `150` означает `1.5x`, `10000` означает `100%`
- Комментарии в коде всегда указывают масштаб

### Формула расчёта физических способностей

```javascript
// В _preparePhysicalCapacities()
for (let [capacityId, capacity] of Object.entries(physicalCapacities)) {
  const modifier = capacityModifiers[capacityId] || 10000; // 10000 = 100%
  capacity.current = Math.max(0, Math.min(100, Math.floor((capacity.base * modifier) / 10000)));
  capacity.percentage = Math.round(capacity.current);
}
```

### Модификаторы способностей

Модификаторы рассчитываются в `_calculateCapacityModifiers()`:

#### 1. Модификатор боли
```javascript
const painScaled = pain.current * 100; // 0-10000
if (painScaled > 1000) { // > 10% боли
  const painPenalty = Math.max(2000, 10000 - (painScaled * 8000) / 10000); // мин. 20%
  modifiers.consciousness = Math.floor((modifiers.consciousness * painPenalty) / 10000);
}
```

#### 2. Модификатор кровопотери
```javascript
const bloodPercentage = Math.floor((blood.current * 10000) / blood.max);
if (bloodPercentage < 8000) { // < 80% крови
  const bloodPenalty = Math.max(1000, bloodPercentage); // мин. 10%
  modifiers.consciousness = Math.floor((modifiers.consciousness * bloodPenalty) / 10000);
}
```

#### 3. Модификаторы частей тела
```javascript
const healthPercentage = Math.floor((part.currentHp * 10000) / part.maxHp);
const partModifier = Math.max(1000, healthPercentage); // мин. 10%

// Применяется в зависимости от тегов части тела:
if (part.tags.includes('brain')) {
  modifiers.consciousness = Math.floor((modifiers.consciousness * partModifier) / 10000);
}
```

## Система урона

### Метод applyBodyPartDamage()

```javascript
async applyBodyPartDamage(partId, damage, damageType = 'blunt')
```

**Параметры**:
- `partId` - ID части тела
- `damage` - количество урона
- `damageType` - тип урона (влияет на боль и кровотечение)

**Процесс**:
1. Применяет урон к части тела
2. Рассчитывает боль от урона (`_calculatePainFromDamage`)
3. Рассчитывает кровотечение (`_calculateBleedingFromDamage`)
4. Обновляет общее здоровье
5. Обновляет данные актёра

### Типы урона

| Тип | Множитель боли | Множитель кровотечения |
|-----|---------------|----------------------|
| `blunt` | 100 (1.0x) | 20 (0.2x) |
| `cut`/`slash` | 120 (1.2x) | 150 (1.5x) |
| `pierce`/`stab` | 110 (1.1x) | 120 (1.2x) |
| `burn` | 150 (1.5x) | 20 (0.2x) |
| `bullet`/`projectile` | 100 (1.0x) | 100 (1.0x) |

### Расчёт боли

```javascript
// Базовая боль: урон относительно максимального HP части
let basePain = Math.floor((damage * 1000) / bodyPart.maxHp);

// Применяем модификаторы типа урона и части тела
const finalPain = Math.floor((basePain * damageTypeMultiplier * bodyPartMultiplier) / 10000);
```

**Модификаторы по частям тела**:
- Мозг (`brain`): 200 (2.0x боль)
- Жизненно важные (`vital`): 130 (1.3x боль)
- Конечности (`extremity`): 80 (0.8x боль)

### Расчёт кровотечения

```javascript
// Базовое кровотечение: урон относительно максимального HP части
let baseBleeding = Math.floor((damage * 100) / bodyPart.maxHp);

// Применяем модификаторы
const finalBleeding = Math.floor((baseBleeding * bleedingMultiplier * bodyPartMultiplier) / 10000);
```

## Система анатомии

### Теги частей тела

Система использует теги для определения влияния повреждений:

| Тег | Влияет на способности |
|-----|----------------------|
| `brain` | consciousness, sight, hearing, talking |
| `sensory` | sight (глаза), hearing (уши) |
| `manipulator` | manipulation |
| `locomotion` | movement |
| `vital` | breathing (лёгкие), bloodPumping (сердце), bloodFiltration/metabolism (почки/печень) |

### Пример части тела

```json
"head": {
  "id": "head",
  "name": "Head",
  "parent": "neck",
  "coverage": 8000,
  "maxHp": 25,
  "status": "healthy",
  "tags": ["vital", "brain", "sensory", "armor_head"]
}
```

## Влияние способностей на игру

### Consciousness (Сознание)
- **Основная способность** - влияет на все действия
- При 0% - персонаж без сознания
- Снижается от боли, кровопотери, повреждений мозга

### Manipulation (Манипуляция)
- Влияет на точность, скорость работы с предметами
- Снижается от боли, повреждений рук/плеч

### Movement (Движение)
- Влияет на скорость передвижения
- Снижается от повреждений ног, бёдер, кровопотери

### Остальные способности
- **Sight/Hearing**: восприятие окружения
- **Breathing**: выносливость, устойчивость к удушению
- **Blood Pumping**: устойчивость к кровопотере
- **Blood Filtration**: устойчивость к токсинам
- **Metabolism**: эффективность питания
- **Talking**: социальные взаимодействия

## API для разработчиков

### Основные методы

```javascript
// Применить урон
await actor.applyBodyPartDamage(partId, damage, damageType);

// Установить анатомию
await actor.setAnatomy('humanoid');

// Сбросить анатомию
await actor.resetAnatomy();

// Получить данные для бросков
const rollData = actor.getRollData();
```

### Доступ к данным

```javascript
// Физические способности
const consciousness = actor.system.physicalCapacities.consciousness.percentage;
const manipulation = actor.system.physicalCapacities.manipulation.percentage;

// Здоровье
const bloodLevel = actor.system.health.blood.percentage;
const painLevel = actor.system.health.pain.current;
const isInPainShock = actor.system.health.pain.shock;

// Части тела
const bodyParts = actor.system.health.bodyParts;
const headHealth = bodyParts.head?.currentHp;
```

## Интерфейс

### Отображение в листе персонажа

1. **Вкладка "Характеристики"**:
   - Статус крови с индикатором кровотечения
   - Уровень боли с предупреждением о шоке
   - Сетка физических способностей

2. **Вкладка "Здоровье"**:
   - Общее здоровье
   - Иерархическое дерево частей тела
   - Управление анатомией

### CSS классы

```css
.impaired           /* Способности <50% */
.bleeding-indicator /* Индикатор кровотечения */
.pain-shock        /* Предупреждение о болевом шоке */
.blood-fill        /* Заливка полосы крови */
.pain-fill         /* Заливка полосы боли */
.capacity-fill     /* Заливка полосы способности */
```

## Будущие расширения

### Планируемые функции
- [ ] Система лечения и регенерации
- [ ] Временные эффекты (кровотечение по времени)
- [ ] Хирургические операции
- [ ] Протезы и импланты
- [ ] Болезни и инфекции
- [ ] Химические эффекты

### Точки расширения
- `_calculateCapacityModifiers()` - добавление новых модификаторов
- `applyBodyPartDamage()` - дополнительные эффекты урона
- Новые типы урона в switch-case конструкциях
- Дополнительные теги частей тела

## Технические детали

### Файлы системы

| Файл | Назначение |
|------|------------|
| `template.json` | Структура данных актёра |
| `module/documents/actor.mjs` | Логика расчётов |
| `module/helpers/config.mjs` | Конфигурация способностей |
| `lang/en.json` | Локализация |
| `templates/actor/actor-character-sheet.hbs` | Интерфейс |

### Порядок выполнения

1. `prepareData()` - основной метод подготовки
2. `_prepareCharacterData()` - данные персонажа
3. `_prepareBodyParts()` - обработка частей тела
4. `_preparePhysicalCapacities()` - расчёт способностей
5. `_calculateCapacityModifiers()` - модификаторы

### Совместимость

- **FoundryVTT v11+**
- **Application v2 sheets**
- **Handlebars templates**
- Совместимо с существующей системой анатомии
- Обратная совместимость с персонажами без физических способностей

---

*Документация актуальна на версию системы с физическими способностями RimWorld-style.*
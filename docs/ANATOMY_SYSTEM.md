# Динамическая система анатомий SpaceHolder

## Обзор

Система позволяет использовать различные типы анатомий для актёров вместо жёстко прописанной структуры. У каждой части тела задаются **экспозиция по направлениям** (взвешенная) и **типизированные связи** (`relations`): рядом (`adjacent`), за (`behind`), родитель (`parent`).

## Где лежат файлы

- **Рантайм (реестр и системные пресеты):** `data/anatomy/` в корне системы (`systems/spaceholder/data/anatomy/`). Тот же набор дублируется в `module/data/anatomy/` для удобства в репозитории.
- **Мировые пресеты:** `worlds/<worldId>/spaceholder/anatomy/<id>.json` (тот же формат JSON).

## Основные компоненты

### 1. AnatomyManager (`module/anatomy-manager.mjs`)

- Загрузка и кэширование анатомий из `data/anatomy/`
- Валидация структуры (`validateAnatomyStructure`)
- Нормализация для актёра: ключи слотов `typeId#N`, `uuid`, ремап целей `relations` и производное поле `links` (только `adjacent`)

### 2. Anatomy relations helper (`module/helpers/anatomy-relations.mjs`)

- Константы направлений экспозиции и видов связей
- Санитизация, дедупликация, миграция legacy-`links` → `relations`
- `ensureActorPartRelationsSynced` для актёров со старыми данными

### 3. Actor (`module/documents/actor.mjs`)

- В `prepareDerivedData` синхронизируются `relations`/`links`, выставляются производные `linkedPartIds`, `parentRef`

### 4. Anatomy Editor (`module/helpers/anatomy-editor.mjs`)

- Редактирование `exposure` и `relations` на листе (режим правки)
- Режим связи перетаскиванием добавляет только **`adjacent`** (в обе стороны)

### 5. ActorSheet (`module/sheets/actor-sheet.mjs`)

- `hasChildren` в списке частей тела: есть ли у кого-то `parent` на эту часть

## Структура файла анатомии

Корень:

| Поле | Описание |
|------|-----------|
| `id`, `name`, `description`, `version` | Идентификация |
| `grid` | `{ width, height }` сетки редактора |
| `bodyParts` | Объект частей; **ключи** — стабильные id в пресете (до применения к актёру) |
| `links` | Опционально: массив `{ from, to }` только по **`adjacent`** (дубль для экспорта/чтения; источник истины — `bodyParts[].relations`) |

### Часть тела (`bodyParts.<key>`)

Обязательные поля: `id`, `weight`, `maxHp`. Частые: `name`, `x`, `y`, `status`, `internal`, `tags`, `organs`, `material`.

**Экспозиция (направления «куда обращена» зона):**

```json
"exposure": {
  "front": 100,
  "back": 0,
  "left": 0,
  "right": 0
}
```

Ключи: только `front` | `back` | `left` | `right` (азимут в плоскости боя). Значения — неотрицательные числа (веса; не обязаны суммироваться в 100). Пустой объект `{}` — нейтральная / не заданная экспозиция.

**Визуализация на сетке (2D):** круг части тела делится на 4 квадранта — **перед**, **право**, **зад**, **лево**. Толщина «ободка» в каждом квадранте по радиусу пропорциональна весу; при весе 0 сегмент не рисуется.

**Авторинг сетки (`x`, `y`):** не размещайте **разные** части тела в **одной и той же** клетке `(x, y)`, если это можно избежать — так проще читать схему и редактор. Это рекомендация по данным; движок **не** валидирует уникальность координат.

**Legacy:** в старых JSON могли быть `top` / `bottom`. При загрузке `sanitizeExposure` прибавляет `top` к `front`, `bottom` к `back` и дальше работает только с четырьмя осями.

**Связи:**

```json
"relations": [
  { "kind": "adjacent", "target": "abdomen" },
  { "kind": "behind", "target": "back", "chance": 80, "direction": "front" },
  { "kind": "parent", "target": "chest" }
]
```

| `kind` | Смысл |
|--------|--------|
| `adjacent` | «Рядом» на поверхности: распространение взрыва, соседи на схеме. Рёбра **двунаправленные** в редакторе (добавляются с двух сторон). |
| `behind` | «За» для пробития и т.п. Опционально **`chance`** 0–100. Опционально **`direction`**: `front` \| `back` \| `left` \| `right` — азимут, с которого связь применяется (согласован с осями экспозиции). Односторонняя связь от источника к цели. |
| `parent` | Указательная иерархия: у части не более **одного** родителя. Ребро **от потомка к родителю**. |

`target` в файле пресета — **ключ** другой части в том же `bodyParts` (не slotRef).

### Legacy: только `links`

Массив строк `links` по-прежнему поддерживается **только если** нет `relations`: каждая строка становится `{ "kind": "adjacent", "target": "..." }`. После загрузки в кэш менеджер выставляет производный `links` из `adjacent`.

## Нормализация на актёре

`AnatomyManager` / `_buildNormalizedActorBodyParts`:

1. Ключи слотов: `head#1`, …; в каждой части `slotRef`, `uuid`, `displayName`.
2. Цели в `relations` ремапятся с ключей пресета на `slotRef`.
3. `links` = уникальные цели всех `adjacent` у этой части (для старых визуализаторов и кода, который ждёт список соседей).

## Registry.json

Без изменений: реестр указывает `file` для каждой анатомии.

## Миграция старых JSON

В репозитории есть одноразовый скрипт `scripts/migrate-anatomy-relations.mjs` (уже применён к встроенным пресетам). Для мировых файлов можно использовать его как образец или прогнать вручную под свои пути.

## API AnatomyManager

- `initialize()`, `getAvailableAnatomies()`, `loadAnatomy(id)`, `createActorAnatomy(id, options)`
- `saveToWorld(data)`, `loadWorldPresets()`, `applyPresetToActor(actor, presetId)`
- `validateAnatomyStructure(anatomyData)`
- `getAnatomyDisplayName(id)`, `getStats()`, `clearCache()`, `reload()`

## Совместимость

- Старые актёры с только `links`: при `prepareDerivedData` поднимаются `relations` и обратно синхронизируется `links`.
- Боевая логика попаданий в этой итерации **не** использует `exposure`/`behind` автоматически — данные готовятся для следующих шагов.

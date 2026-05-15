---
doc-type: reference
status: current
tags:
  - sh-code-doc/reference
  - sh-code-doc/status/current
---

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

Обязательные поля: `id`, `weight`, `maxHp`. Частые: `name`, `x`, `y`, `status`, `internal`, `tags`, `organs`, `material`, `bodyLayers`.

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

### Слои тела (`bodyLayers`)

Часть тела может иметь собственный **стек тканей** — массив
`{ material, thickness }`. Резолвер урона
(`body-traversal-resolver.mjs`) применяет эти слои **как ещё один
кусок брони**: сначала внешняя броня, затем `bodyLayers`, и только
после этого — «центр» части, где копится `bodyDamage`.

```json
"chest": {
  "id": "chest",
  "name": "Chest",
  "weight": 2,
  "maxHp": 50,
  "exposure": { "front": 100, "back": 0, "left": 20, "right": 20 },
  "bodyLayers": [
    { "material": "skin",   "thickness": 1 },
    { "material": "muscle", "thickness": 3 },
    { "material": "bone",   "thickness": 2 }
  ]
}
```

**Правило порядка:** стек **однонаправленный** — от внешней
поверхности части тела к её геометрическому центру. **Не
дублируйте** слои «туда-обратно». Когда снаряд выходит наружу (по
задней экспозиции после прохождения через центр), резолвер сам
инвертирует стек на лету. Это избавляет анатомию от громоздкого
mirroring и оставляет JSON читаемым.

**Материалы:** `skin` / `muscle` / `bone` (категория
`biological`) живут как обычные записи типа `material` в системном
компендиуме (`pack-src/sh-test-items/SH_Material_{Skin,Muscle,Bone}.json`)
и индексируются через `MaterialsManager`. Можно подставить любой
другой материал (мировой или из пака) — резолвер не знает «броня vs
ткани», он резолвит стек.

**Дефолты:** если поле `bodyLayers` не задано, `AnatomyManager` при
нормализации подставит значение из
`module/helpers/damage/body-layers-defaults.mjs`
(`DEFAULTS_BY_TYPE_ID[part.id]`, иначе — generic `skin/muscle/bone`).
Если нужна часть **без** тканевых слоёв — это легально: пропишите
явно `"bodyLayers": []`; дефолт подставляется только при отсутствии
поля или когда значение не массив.

**Органы** (`bodyPart.organs`) **не являются** `bodyLayers` и в v2
**не моделируются** как слои. Это отдельная «критическая структура»
внутри части, которая резолвится другой системой после того, как
посчитан `bodyDamage`.

#### Ограничения v2
- Стек симметричный (один и тот же как на вход, так и на выход),
  без `byDirection`-override.
- У слоёв тела нет persistent integrity: на каждый выстрел стек
  пересоздаётся со свежим здоровьем. «Хронический» износ кости
  моделируется через `Injury`, не через `layer.integrity`.
- Органы как отдельные структуры остаются out-of-scope текущего
  цикла правок.

### Legacy: только `links`

Массив строк `links` по-прежнему поддерживается **только если** нет `relations`: каждая строка становится `{ "kind": "adjacent", "target": "..." }`. После загрузки в кэш менеджер выставляет производный `links` из `adjacent`.

## Нормализация на актёре

`AnatomyManager` / `_buildNormalizedActorBodyParts`:

1. Ключи слотов: `head#1`, …; в каждой части `slotRef`, `uuid`, `displayName`.
2. Цели в `relations` ремапятся с ключей пресета на `slotRef`.
3. `links` = уникальные цели всех `adjacent` у этой части (для старых визуализаторов и кода, который ждёт список соседей).
4. `bodyLayers` санируются (через `sanitizeBodyLayers`); если поле не массив, подставляется `getDefaultBodyLayersForType(part.id)`.

## Registry.json

Без изменений: реестр указывает `file` для каждой анатомии.

## Миграция старых JSON

Одноразовые миграционные скрипты в репозитории:

- **`scripts/migrate-anatomy-relations.mjs`** — legacy `links` → `relations` + `exposure` (уже применён к встроенным пресетам).
- **`scripts/add-body-layers-to-anatomies.mjs`** — добавляет поле `bodyLayers` в каждую часть. Идемпотентен: уже заполненное `bodyLayers` не трогает. По умолчанию правит только `data/anatomy/*.json` и `module/data/anatomy/*.json`; для мировых файлов передайте корень `--worlds-root <path>`, например:

  ```bash
  node scripts/add-body-layers-to-anatomies.mjs --worlds-root "E:/FoundryVTT/Data/worlds"
  ```

  Скрипт пройдёт по `<path>/<worldId>/spaceholder/anatomy/*.json`. Актёров в мировых базах данных он не трогает — их `bodyLayers` подтянет `ensureActorPartBodyLayersSynced` при следующем `prepareDerivedData`.

## API AnatomyManager

- `initialize()`, `getAvailableAnatomies()`, `loadAnatomy(id)`, `createActorAnatomy(id, options)`
- `saveToWorld(data)`, `loadWorldPresets()`, `applyPresetToActor(actor, presetId)`
- `validateAnatomyStructure(anatomyData)`
- `getAnatomyDisplayName(id)`, `getStats()`, `clearCache()`, `reload()`

## Совместимость

- Старые актёры с только `links`: при `prepareDerivedData` поднимаются `relations` и обратно синхронизируется `links`.
- Старые актёры без `bodyLayers` получают дефолтный стек при следующей нормализации (`createActorAnatomy`, `applyPresetToActor`, либо вручную через миграцию из §«Миграция старых JSON»). До тех пор `body-traversal-resolver` сам подставит дефолт по `part.id`, поэтому ничего не ломается.
- Боевая логика попаданий c v2 использует `exposure` и `relations.behind` **в рантайме** через `actor.applyDamagePackage` → `resolveBodyTraversal`. Направление пока всегда `'front'` — настоящее определение стороны попадания в `shot-manager` — задача следующей итерации.

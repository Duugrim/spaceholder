---
doc-type: reference
status: current
tags:
  - sh-code-doc/reference
  - sh-code-doc/status/current
---

# Динамическая система анатомий SpaceHolder

## Обзор

Система позволяет использовать различные типы анатомий для актёров вместо жёстко прописанной структуры. У каждой части тела своё HP на 2D-сетке, **стороны** (`faces`) для брони, **материал** из каталога, **группы** (манипуляция / передвижение / сенсорная / критическая) и типизированные связи (`relations`): рядом (`adjacent`), за (`behind` между разными частями), родитель (`parent`).

Выстрел сначала попадает в токен; `hitLuck = combine(centrality, зона дуги)` задаёт пояс (часть или группа / только группа / угол брони / задел / снаряд летит дальше). Диалог группы — после хита. См. `module/helpers/hit-luck.mjs`, `module/helpers/anatomy-groups.mjs`.

## Где лежат файлы

- **Рантайм (реестр и системные пресеты):** `data/anatomy/` в корне системы (`systems/spaceholder/data/anatomy/`). Тот же набор дублируется в `module/data/anatomy/` для удобства в репозитории.
- **Мировые пресеты:** `worlds/<worldId>/spaceholder/anatomy/<id>.json` (тот же формат JSON).

## Основные компоненты

### 1. AnatomyManager (`module/anatomy-manager.mjs`)

- Загрузка и кэширование анатомий из `data/anatomy/`
- Валидация структуры (`validateAnatomyStructure`)
- Нормализация для актёра: ключи слотов `typeId#N`, `uuid`, ремап `relations`/`groups`, производное `links` (только `adjacent`)
- Поля части: `material`, `faces`, `inners`, `heightFrac` (не `exposure` / `bodyLayers` / `position3d` / `weight` / `status`)

### 2. Anatomy relations helper (`module/helpers/anatomy-relations.mjs`)

- Константы направлений экспозиции и видов связей
- Санитизация, дедупликация, миграция legacy-`links` → `relations`
- `ensureActorPartRelationsSynced` для актёров со старыми данными

### 3. Actor (`module/documents/actor.mjs`)

- В `prepareDerivedData` синхронизируются `relations`/`links`, выставляются производные `linkedPartIds`, `parentRef`

### 4. Anatomy Editor (`module/helpers/anatomy-editor.mjs`)

- Редактирование `faces`, `material`, `heightFrac`, `inners`, `relations`, групп на листе (режим правки)
- Режим связи перетаскиванием добавляет только **`adjacent`** (в обе стороны)

### 5. ActorSheet (`module/sheets/actor-sheet.mjs`)

- `hasChildren` в списке частей тела: есть ли у кого-то `parent` на эту часть

## Структура файла анатомии

Корень:

| Поле | Описание |
|------|-----------|
| `id`, `name`, `description`, `version` | Идентификация |
| `heightM` | Ожидаемый рост (м); у персонажа `system.heightM` |
| `groups` | `{ id, type, name, parts[] }` — type: manipulation / movement / sensory / critical |
| `grid` | `{ width, height }` сетки редактора |
| `bodyParts` | Объект частей; **ключи** — стабильные id в пресете (до применения к актёру) |
| `links` | Опционально: массив `{ from, to }` только по **`adjacent`** |

### Часть тела (`bodyParts.<key>`)

Обязательные поля: `id`, `maxHp`, `material` (slug каталога, не пустой). Частые: `name`, `x`, `y`, `tags`, `faces`, `inners`, `heightFrac`, `relations`.

**Сетка (`x`, `y`):** целые координаты ячейки для **2D**-редактора на вкладке «Здоровье». Не влияют на резолвер урона.

**Стороны (`faces`):** `front` и/или `back` — слоты брони, не HP. Торс: оба. Конечность: обычно `["front"]`. Броня: `coveredParts` `{ slotRef, face, layers }`. Legacy `chest`/`back`/`abdomen` ремапятся в `upperTorso`/`lowerTorso` + face.

**Материал:** один slug на часть (`skin` / `muscle` / `bone` …). В траверсе это единственный тканевой слой после брони входящей стороны.

**Внутренности (`inners`):** `{ id, name, material, occupancyPct, statuses[] }`, сумма долей ≤ 100. Не клетка сетки и не сторона.

**Высота:** `heightFrac` 0–1 от `actor.system.heightM`. Высота части от пола = `heightFrac * heightM` (укрытие токенами — не этот срез).

Человек: `upperTorso` / `lowerTorso` вместо груди+спины+живота. Отдельного кружка «спина» нет.

**Авторинг сетки (`x`, `y`):** не размещайте **разные** части тела в **одной и той же** клетке `(x, y)`, если это можно избежать — так проще читать схему и редактор. Это рекомендация по данным; движок **не** валидирует уникальность координат.

**Связи:**

```json
"relations": [
  { "kind": "adjacent", "target": "lowerTorso" },
  { "kind": "behind", "target": "neck", "chance": 20, "direction": "front" },
  { "kind": "parent", "target": "upperTorso" }
]
```

| `kind` | Смысл |
|--------|--------|
| `adjacent` | «Рядом» на поверхности: распространение взрыва, соседи на схеме. Рёбра **двунаправленные** в редакторе (добавляются с двух сторон). |
| `behind` | «За» для пробития и т.п. Опционально **`chance`** 0–100. Опционально **`direction`**: `front` \| `back` \| `left` \| `right` — азимут, с которого связь применяется (согласован с осями экспозиции). Односторонняя связь от источника к цели. |
| `parent` | Указательная иерархия: у части не более **одного** родителя. Ребро **от потомка к родителю**. |

`target` в файле пресета — **ключ** другой части в том же `bodyParts` (не slotRef).

### Ткань части и броня по сторонам

У части один `material` (каталог). Резолвер (`body-traversal-resolver.mjs`): броня **входящей** стороны → материал части → HP центра → при пробитии броня **противоположной** стороны (если `faces` её содержит) → `behind` / дальше.

```json
"upperTorso": {
  "id": "upperTorso",
  "name": "Upper Torso",
  "maxHp": 50,
  "material": "muscle",
  "faces": ["front", "back"],
  "heightFrac": 0.7,
  "inners": [
    { "id": "heart", "name": "Heart", "material": "muscle", "occupancyPct": 15, "statuses": [] }
  ]
}
```

**Органы** (`inners`) не слои брони и не имеют своего HP.

Способность группы: `game.spaceholder.getGroupAbility(actor, groupId)` = sum currentHp / sum maxHp.

**Материалы:** `skin` / `muscle` / `bone` живут как записи типа `material` в системном компендиуме и индексируются через `MaterialsManager`.

### Legacy: только `links`

Массив строк `links` по-прежнему поддерживается **только если** нет `relations`: каждая строка становится `{ "kind": "adjacent", "target": "..." }`. После загрузки в кэш менеджер выставляет производный `links` из `adjacent`.

## Нормализация на актёре

`AnatomyManager` / `_buildNormalizedActorBodyParts`:

1. Ключи слотов: `head#1`, …; в каждой части `slotRef`, `uuid`, `displayName`.
2. Цели в `relations` ремапятся с ключей пресета на `slotRef`.
3. `links` = уникальные цели всех `adjacent` у этой части (для старых визуализаторов и кода, который ждёт список соседей).
4. `groups` ремапятся с ключей пресета на `slotRef`.

## Registry.json

Без изменений: реестр указывает `file` для каждой анатомии.

## Миграция старых JSON

Одноразовые скрипты в `scripts/` (relations, bodyLayers) — исторические. Текущий контракт части: `material` + `faces` + `inners` + `heightFrac`; группы на корне пресета. Legacy `chest`/`back`/`abdomen`/`groin` ремапятся в `upperTorso`/`lowerTorso` + face (`LEGACY_HUMANOID_PART_REMAP`).

Актёров в мировых базах скрипт не трогает — GM заново применяет пресет humanoid.

## API AnatomyManager

- `initialize()`, `getAvailableAnatomies()`, `loadAnatomy(id)`, `createActorAnatomy(id, options)`
- `saveToWorld(data)`, `loadWorldPresets()`, `applyPresetToActor(actor, presetId)`
- `validateAnatomyStructure(anatomyData)`
- `getAnatomyDisplayName(id)`, `getStats()`, `clearCache()`, `reload()`

## Совместимость

- Старые актёры с только `links`: при `prepareDerivedData` поднимаются `relations` и обратно синхронизируется `links`.
- Старые актёры без `bodyLayers` получают дефолтный стек при следующей нормализации (`createActorAnatomy`, `applyPresetToActor`, либо вручную через миграцию из §«Миграция старых JSON»). До тех пор `body-traversal-resolver` сам подставит дефолт по `part.id`, поэтому ничего не ломается.
- Боевая логика попаданий c v2 использует `exposure` и `relations.behind` **в рантайме** через `actor.applyDamagePackage` → `resolveBodyTraversal`. Направление пока всегда `'front'` — настоящее определение стороны попадания в `shot-manager` — задача следующей итерации.

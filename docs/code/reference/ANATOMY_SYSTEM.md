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

Выстрел сначала попадает в токен; центровость задаёт качество попадания (множитель энергии снаряда и крит — `module/helpers/hit-quality.mjs`, см. `SHOOTING_SYSTEM.md`), потом группа и часть: помеченная у цели группа при крите режима с `pickPart`, иначе случайная (диалога выбора нет). См. `module/helpers/anatomy-groups.mjs`.

Части образуют **дерево** по связям `parent` с явным корнем (у человека — голова). Часть получает то, что **поглотила** (`tissue`: оболочка и глубина); остаток снаряда выходит из тела. Часть с HP 0 теряется вместе со всем, что ниже; в части живут **органы** с собственным HP. Повреждённый жизненно важный орган или быстрое кровотечение — **при смерти**, уничтоженный орган или потеря корня — смерть. См. «Ткань части», «Дерево частей, потеря и смерть» ниже.

## Где лежат файлы

- **Рантайм (реестр и системные пресеты):** `data/anatomy/` в корне системы (`systems/spaceholder/data/anatomy/`). Других копий нет.
- **Мировые пресеты:** `worlds/<worldId>/spaceholder/anatomy/<id>.json` (тот же формат JSON).

## Основные компоненты

### 1. AnatomyManager (`module/anatomy-manager.mjs`)

- Загрузка и кэширование анатомий из `data/anatomy/`
- Валидация структуры (`validateAnatomyStructure`)
- Нормализация для актёра: ключи слотов `typeId#N`, `uuid`, ремап `relations`/`groups`, производное `links` (только `adjacent`)
- Поля части: `material`, `tissue`, `faces`, `inners`, `heightFrac` (не `exposure` / `bodyLayers` / `position3d` / `weight` / `status`)

### 2. Anatomy relations helper (`module/helpers/anatomy-relations.mjs`)

- Константы направлений экспозиции и видов связей
- Санитизация, дедупликация, миграция legacy-`links` → `relations`
- `ensureActorPartRelationsSynced` для актёров со старыми данными
- Дерево `parent`: `parentOf`, `childrenOf`, `descendantsOf`, `resolveRootRef`, `validatePartTree`, `rerootParents` (смена корня), `computeLostParts` (потерянные части). Тест: `node module/helpers/anatomy-relations.test.mjs`

### 3. Actor (`module/documents/actor.mjs`)

- В `prepareDerivedData` синхронизируются `relations`/`links`, выставляются производные `linkedPartIds`, `parentRef`; HP частей, `lost`/`lostVia`, состояние органов (`inners[].currentHp/status`), кровотечение `system.health.bleeding` и состояние тела `system.health.dead` (мёртв / при смерти) считает `applyBodyState` (`module/helpers/body-state.mjs`) — тот же код, которым утилита баланса судит исход выстрела
- `getRootBodyPart()` — слот корня; `applyDamagePackage` не бьёт по потерянной части, пишет в травму задетые органы `inners: [{ id, amount }]` и возвращает, что вышло из тела (`exitApplications`), и раны частей (`woundsBySlot`)

### 4. Anatomy Editor (`module/helpers/anatomy-editor.mjs`)

- Редактирование `faces`, `material`, `heightFrac`, `inners`, `relations`, групп на листе (режим правки)
- Режим связи перетаскиванием добавляет только **`adjacent`** (в обе стороны)
- Корень: выбор в диалоге «Группы анатомии» (цепочка родителей разворачивается до нового корня), кольцо корня на сетке, подсветка поддерева выбранной части, потерянные части бледные. Корень удалить нельзя; потомки удалённой части переходят к её родителю
- «Параметры вида» (режим правки): рост `heightM` и боевая скорость вида `speedMps`; диалог гравитации на листе правит только γ
- Органы: вкладка «Органы» с долей, HP и признаком «жизненно важный»

### 5. ActorSheet (`module/sheets/actor-sheet.mjs`)

- `hasChildren` в списке частей тела: есть ли у кого-то `parent` на эту часть

### 6. Смерть в мире (`module/helpers/actor-death.mjs`)

- Актёр считает `system.health.dead` (`computeDeathState` в `anatomy-groups.mjs`): `{ dead, dying, reason, … }`; модуль держит статусы Foundry в соответствии с ним: «dead» у мёртвого, «unconscious» у того, кто при смерти (выбыл). Только активный ГМ, только по хуку `updateActor` (срабатывает и для актёра токена без привязки); статус, поставленный вручную, не снимается (флаги `flags.spaceholder.autoDead`, `autoDying`). Тест: `node module/helpers/actor-death.test.mjs`

## Структура файла анатомии

Корень:

| Поле | Описание |
|------|-----------|
| `id`, `name`, `description`, `version` | Идентификация |
| `root` | Ключ корневой части (`head` у humanoid и quadruped, `cephalothorax` у arachnid); у актёра — `system.anatomy.rootRef` (slotRef) |
| `heightM` | Рост вида (м); у персонажа `system.heightM`; правится в редакторе анатомии |
| `speedMps` | Боевая скорость вида (м/с) при AGI 100; у персонажа `system.speedMps`; по умолчанию 3 |
| `groups` | `{ id, type, name, parts[] }` — type: manipulation / movement / sensory / critical |
| `grid` | `{ width, height }` сетки редактора |
| `bodyParts` | Объект частей; **ключи** — стабильные id в пресете (до применения к актёру) |
| `links` | Опционально: массив `{ from, to }` только по **`adjacent`** |

### Часть тела (`bodyParts.<key>`)

Обязательные поля: `id`, `maxHp`, `material` (slug каталога, не пустой). Частые: `name`, `x`, `y`, `tags`, `tissue`, `faces`, `inners`, `heightFrac`, `relations`.

**Сетка (`x`, `y`):** целые координаты ячейки для **2D**-редактора на вкладке «Здоровье». Не влияют на резолвер урона.

**Стороны (`faces`):** `front` и/или `back` — слоты брони, не HP. Торс: оба. Конечность: обычно `["front"]`. Броня: `coveredParts` `{ slotRef, face, layers }`. Legacy `chest`/`back`/`abdomen` ремапятся в `upperTorso`/`lowerTorso` + face.

**Материал:** один slug на часть (`skin` / `muscle` / `bone` …) — оболочка части (см. «Ткань части»).

**Ткань (`tissue`):** как часть принимает снаряд — `{ shellThickness, depthFlat, depthShare, organDepth, cavity, bluntToParent, bleed }`, все поля необязательны (`DEFAULT_PART_TISSUE`, `partTissue` в `anatomy-groups.mjs`).

**Строение (`structure`):** как часть держит урон целиком — `{ saturation, reserve }` (`DEFAULT_PART_STRUCTURE`, `partStructure`; не ткань — подходит и неорганике). `saturation` (k) — раны одной силы доводят часть максимум до k раз того, что одна такая рана делает свежей части: первое попадание считается полностью, следующие — всё меньше, слабые перестают значить (0 — без предела). `reserve` (R) — на 0 HP часть **не работает** (`disabled`), **уничтожена** — только на −R её HP. Отсюда: оружие выводит часть из строя, только если одно попадание ≥ 1/k её HP, и уничтожает — если ≥ (1 + R)/k. У `humanoid`: голова и половины торса k 2, R 0,5; шея k 2, R 0,2; конечности k 3, R 0,15 (прототип, карточка «S-XL Баланс HP частей анатомии», вопрос 4).

**Внутренности (`inners`):** `{ id, name, material, occupancyPct, maxHp, bleed, mortalShare?, tags[] }`, сумма долей ≤ 100. Не клетка сетки и не сторона. `maxHp` 0 — орган без HP (не повреждается), тег `vital` — жизненно важный, `bleed` — кровотечение при ранении органа, `mortalShare` — какая доля HP жизненно важного органа должна уйти, чтобы тело было при смерти (по умолчанию `MORTAL_ORGAN_SHARE` 0,25; мозг — 0,1).

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

Резолвер (`body-traversal-resolver.mjs`), по шагам:

1. **Броня входящей стороны.** Слой с `coverage` < 100 (пластина со щелями) может не встретиться: бросок места попадания уходит в щель. Поглощённая слоем доля урона уходит дальше ударом (`conductance` материала), слои за ним его только смягчают (`damping`). Механический снаряд (пуля, клинок, удар), остановленный бронёй, дальше ничего не «переливает» — за бронёй только удар.
2. **Ткань.** Часть получает то, что **поглотила**. Пробивающий снаряд (`penetratesBody` типа урона: пуля, клинок, луч) сначала проходит оболочку — материал части толщиной `shellThickness` (череп); снаряд слабее оболочки в ней и остаётся: полный урон части, до органов не доходит. Внутри часть берёт `depthFlat + depthShare × энергия`. Урон части — доля урона снаряда, соответствующая поглощённой энергии (урон следует за энергией), плюс `cavity × энергия, поглощённая внутри` (временная полость: из-за неё очень энергичный снаряд разносит часть, а пистолетный — нет); остаток выходит из тела. Удар, ожог и всё, что передала броня, остаются на части целиком.
3. **Выход.** Остаток идёт через броню **противоположной** стороны (если `faces` её содержит; её удар — в ту же часть) и покидает тело (`exitApplications` — для цели за спиной), либо в часть `behind`. В живой атаке пуля с таким остатком летит дальше и ранит следующий токен на линии — «Пуля, вышедшая из тела» в [[SHOOTING_SYSTEM]].
4. **Органы** — см. ниже.
5. **Удар родителю:** `bluntToParent` удара уходит в родительскую часть (каска → шея).

```json
"upperTorso": {
  "id": "upperTorso",
  "name": "Upper Torso",
  "maxHp": 190,
  "material": "muscle",
  "tissue": { "depthFlat": 3, "depthShare": 0.85, "organDepth": 4, "cavity": 0.3, "bleed": 10 },
  "faces": ["front", "back"],
  "heightFrac": 0.7,
  "inners": [
    { "id": "heart", "name": "Heart", "material": "muscle", "occupancyPct": 15, "maxHp": 66, "bleed": 40, "tags": ["vital"] }
  ]
}
```

**Органы** (`inners`) не слои брони. Их состояние не хранится, а считается из травм (см. ниже).

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

## Дерево частей, потеря и смерть

**Дерево.** Связи `parent` (от потомка к родителю) образуют одно дерево с корнем `root`. У humanoid и quadruped корень — голова (шея → голова, торс → шея, остальное как раньше); у arachnid — головогрудь. `validateAnatomyStructure` предупреждает о сломанном дереве (корень с родителем, цикл, часть вне корня).

**HP и потеря части.** HP части = макс. HP − урон части целиком: `saturatedDamage(сумма сырых ран, самая большая рана, saturation)` в `body-state.mjs` (до самой большой раны всё считается, выше урон приближается к k × ей всё медленнее; порядок ран не важен). На 0 HP и ниже часть `disabled` (HP остаётся отрицательным, на листе так и показывается), на −R — `destroyed`. Уничтоженная часть **потеряна вместе со всеми потомками** (`computeLostParts`: флаг `destroyed`, без него — HP ≤ 0); без `structure` всё как раньше: 0 HP = потеряна. Органы и кровотечение считают сырые раны. Производные поля части: `lost`, `lostVia` (ближний предок, чья потеря унесла эту часть; пусто, если часть потеряна сама). У потерянной части `currentHp` 0 и статус `lost`. Травмы остаются единственным источником правды: убрать или вылечить травму — части возвращаются. Потерянная часть не выбирается выстрелом (`isPartAlive`, `groupSlotRefs({ aliveOnly })`), не принимает переход `behind` и не принимает прямой удар (`applyDamagePackage`); `getGroupAbility` падает сам.

**Органы.** Каждый орган разыгрывается отдельно (`rollOrgans`): шанс `1 − (1 − доля)^(1 + E/organCavityEnergy)`, где `E` — энергия, поглощённая частью (и бронёй прямо перед ней): большая временная полость задевает больше органов. Пробивающий снаряд доходит до органов, только если после оболочки у него больше `organDepth` энергии (нож до сердца не достаёт, пуля достаёт). Удар доходит до органов только выше порога сотрясения (`concussionThreshold`), в счёт идёт превышение. Орган получает `organShare` урона части. Константы — `DEFAULT_BODY_MODEL` (`organCavityEnergy` 4, `organShare` 0,5, `concussionThreshold` 60). Результат — `innerHitsBySlot: { slot: [{ innerId, amount, type }] }`; `applyDamagePackage` пишет в травму `inners: [{ id, amount }]` (x100, не больше `amount`). Состояние органа (`computeInnerState`): `maxHp` с множителем END, как у частей, минус урон из травм; статусы `ok` / `damaged` / `destroyed` / `lost`.

**Кровотечение** (`damage/bleeding.mjs`, статическая часть): скорость, % крови в минуту — сумма по ранам `урон / HP части × tissue.bleed × множитель типа × стадия` (множитель типа — `bleed` в реестре типов урона: рез 1,5, укол 1,2, пуля 1, удар 0,15, ожог 0; стадия — открытая рана 1, затягивающаяся или обработанная 0,25, рубец 0), плюс органы (`bleed` органа) и культи потерянных частей (`tissue.bleed × LOST_PART_BLEED` и `bleed` всех органов, оторванных с частью: бедро — артерия, низ торса — печень). Время до смерти = 100 / скорость; меньше `MORTAL_BLEED_MINUTES` (5) — при смерти. Течение времени, перевязка и жгут — позже (карточка «A-L Кровопотеря»). Результат — `system.health.bleeding = { rate, minutesToDeath, mortal, bySlot }`.

**Смерть и «при смерти».** `computeDeathState`: **мёртв** — потеряна корневая часть, либо жизненно важный (`vital`) орган уничтожен или потерян; **при смерти** — жизненно важный орган потерял не меньше `mortalShare` своего HP (по умолчанию 25%, мозг — 10%; меньше — просто тяжёлая рана), но цел, или кровотечение `mortal`. Результат — `system.health.dead = { dead, dying, reason: 'root'|'organ'|'bleeding', slotRef, innerId, minutesToDeath? }`. Показ: красная полоса и череп в шапке у мёртвого, оранжевая полоса и пульс в шапке у того, кто при смерти; статусы «dead» / «unconscious» на токене (`actor-death.mjs`).

Числа `humanoid` подобраны под случаи утилиты баланса (≈ RimWorld × 4,4: голова 110, верх торса 190, мозг 44; артерии в шее и бедре, печень) — карточка «S-XL Баланс HP частей анатомии», раздел «Фаза 4». `quadruped` и `arachnid` — по пропорциям: HP части = старое HP × (новое / старое HP аналогичной части человека); ткань и органы — как у аналога (торс четвероногого — сердце, лёгкие, кишечник, печень; артерии в шее и бёдрах; головогрудь паукообразного — ткань головы). **HP органов не масштабируются** (мозг 44, сердце 66…): урон органу — доля урона части, а он зависит от энергии снаряда, а не от размера части, поэтому пистолет в мозг у любого вида — «при смерти», а не смерть.

Тесты: `node module/helpers/anatomy-relations.test.mjs`, `node module/helpers/anatomy-groups.test.mjs`, `node module/helpers/damage/body-traversal-resolver.test.mjs`, `node module/helpers/damage/damage-resolver.test.mjs`, `node module/helpers/damage/bleeding.test.mjs`, `node module/helpers/actor-death.test.mjs`.

## Registry.json

Без изменений: реестр указывает `file` для каждой анатомии.

## Миграция старых JSON

Одноразовые скрипты в `scripts/` (relations, bodyLayers) — исторические. Текущий контракт части: `material` + `tissue` + `faces` + `inners` + `heightFrac`; группы на корне пресета. Legacy `chest`/`back`/`abdomen`/`groin` ремапятся в `upperTorso`/`lowerTorso` + face (`LEGACY_HUMANOID_PART_REMAP`).

Актёров в мировых базах скрипт не трогает — GM заново применяет пресет humanoid.

## API AnatomyManager

- `initialize()`, `getAvailableAnatomies()`, `loadAnatomy(id)`, `createActorAnatomy(id, options)`
- `saveToWorld(data)`, `loadWorldPresets()`, `applyPresetToActor(actor, presetId)`
- `validateAnatomyStructure(anatomyData)`
- `getAnatomyDisplayName(id)`, `getStats()`, `clearCache()`, `reload()`

## Совместимость

- Старые актёры с только `links`: при `prepareDerivedData` поднимаются `relations` и обратно синхронизируется `links`.
- Части без `tissue` (старые актёры, пресеты, которые ещё не дополнены) получают `DEFAULT_PART_TISSUE`; `bodyLayers` больше не читается.
- Сторона попадания приходит из часового угла выстрела (`clockToHitFace`: `front` / `back`).

# AGENTS.md

Руководство для контрибьютеров и AI-агентов, работающих с системой SpaceHolder для Foundry VTT.

> Источник истины по архитектуре в этом репозитории — код в `module/`. Этот документ обновлён на основе `WARP.md` и текущей структуры `module/**`.

# ВАЖНО!

Always think, reason, and plan in English. 
Even if the user asks a question in another language, execute all internal reasoning, steps, tool calls, and final responses strictly in English. 
Keep technical explanations concise and aligned with official documentation.

---

## Проект в двух словах

SpaceHolder — игровая система (Foundry VTT v14+) с ES-модулями. Точка входа — `module/spaceholder.mjs`. Система регистрирует кастомные Document-классы (Actor/Item), Application V2 листы, набор хуков/настроек и публикует вспомогательный API в `game.spaceholder`.

## Где что лежит (актуально по `module/`)

- **`module/spaceholder.mjs`** — инициализация системы (Hooks `init`/`ready`), регистрация документов/листов/хелперов, экспорт публичного API в `game.spaceholder`.
- **`module/documents/`**
  - `actor.mjs` — логика Actor (в т.ч. анатомия/здоровье).
  - `item.mjs` — логика Item (в т.ч. `roll()`).
- **`module/sheets/`**
  - `actor-sheet.mjs` — Application V2 лист актёра.
  - `item-sheet.mjs` — Application V2 лист предмета.
- **`module/anatomy-manager.mjs`** — загрузка/валидация/кэш анатомий.
- **`module/helpers/`** — подсистемы и UI-инструменты:
  - Боёвка/прицеливание/визуализация:
    - `aiming-manager.mjs` — управление режимом прицеливания и выбором payload.
    - `shot-manager.mjs` — расчёт попаданий/коллизий/сегментов (крупный модуль).
    - `draw-manager.mjs` — отрисовка результатов выстрела/сегментов на PIXI; следы выстрелов затухают по возрасту.
    - `shot-trail.mjs` — запись выстрела (`ShotRecord`: рисуется стрелком сразу, остальным клиентам идёт по сокету, хранится внутри записи об атаке в чате), чтение следов из сообщений (`readShotRecords`), кривая затухания, настройка `shotTrailFadeSeconds`. Тест: `node module/helpers/shot-trail.test.mjs`.
    - `weapon/attack-log.mjs` — запись об атаке (всё, что выстрелено с начала стрельбы до выхода из прицеливания: выстрелы, попадания по токенам, сводка по целям). `actions/attack-journal-html.mjs` рисует её строкой журнала действий, `actions/attack-report.mjs` пишет в чат (в бою — раскрываемая строка журнала + таблица боя, иначе отдельное сообщение). Тесты: `node module/helpers/weapon/attack-log.test.mjs`, `node module/helpers/actions/attack-journal-html.test.mjs`.
  - Зоны влияния:
    - `influence-manager.mjs` — расчёт/отрисовка influence-зон глобальных объектов.
  - Таймлайн:
    - `timeline-v2.mjs` — данные/инфраструктура (контейнеры/страницы/флаги/сокеты/настройки).
    - `timeline-v2-app.mjs` — UI (Application V2) для Timeline V2.
  - Иконки:
    - `icon-library/*` — индексация/миграции/"bake" SVG.
    - `icon-picker/*` — UI выбора, перекраска и применение к Actor/Token.
  - Глобальная карта:
    - `global-map/*` — обработка/рендер/инструменты/Editor UI.
    - `global-map/terrain3d/*` — канонический heightmap + Three.js вид сверху / осмотр из точки.
  - Пользователи и фракции:
    - `user-factions.mjs` — привязка пользователей/токенов/акторов к фракциям (через флаги).
    - `faction-display.mjs`, `hotbar-faction-ui.mjs` — UI-хелперы для фракций.
  - Журналы/прогрессия:
    - `journal-check.mjs` — workflow статусов Journal (draft/proposed/approved/denied), bulk-действия.
    - `progression-points.mjs`, `progression-points-app.mjs` — система progression points и UI.
  - Токены:
    - `token-pointer.mjs` — рендер/настройки указателя токена.
    - `token-rotator.mjs` — вращение токена, снап, хоткеи.
  - Прочее:
    - `effects.mjs` — управление ActiveEffect.
    - `settings-menus.mjs`, `token-controls.mjs`, `journal-directory.mjs`, `journal-update-log-app.mjs` и др.
    - `skills/*` — дерево физических навыков, extras, `getSkillEffect` (пока не в формуле попадания).
    - `anatomy-groups.mjs` — группы, faces, ткань части (`partTissue`: оболочка, глубина, `organDepth`, удар родителю, кровоток), inners (органы: HP, `bleed`, тег `vital`, состояние `computeInnerState`), `getGroupAbility`, `computeDeathState` (мёртв / при смерти). Тест: `node module/helpers/anatomy-groups.test.mjs`.
    - `damage/body-traversal-resolver.mjs` — путь снаряда через часть тела: броня входящей стороны (щели `coverage`), ткань (часть получает поглощённое, остаток выходит — `exitApplications`), органы (бросок на каждый, полость, порог сотрясения; `DEFAULT_BODY_MODEL`), удар родителю. `damage/damage-resolver.mjs` — броня: v3, урон следует за энергией, поглощённое уходит дальше ударом (`conductance`), слои за ним его смягчают (`damping`). Тесты: `node module/helpers/damage/body-traversal-resolver.test.mjs`, `node module/helpers/damage/damage-resolver.test.mjs`.
    - `damage/bleeding.mjs` — кровотечение (статика): скорость по ранам, органам и культям, время до смерти, «смертельно» быстрее 5 мин; культя кровит и органами, оторванными с частью. Тест: `node module/helpers/damage/bleeding.test.mjs`.
    - `body-state.mjs` — состояние тела из ран (`applyBodyState`: HP частей с насыщением и запасом (`structure` части, `saturatedDamage`: не работает ниже 0, уничтожена ниже −запаса), потери, органы, кровотечение, мёртв/при смерти; его зовёт `actor._prepareBodyParts`) и исход попадания по семиступенчатой шкале (`classifyOutcome`; ею сверяет утилита баланса). Тест: `node module/helpers/body-state.test.mjs`.
    - `anatomy-relations.mjs` — связи частей и дерево `parent`: корень (`root` в пресете, `system.anatomy.rootRef`), `descendantsOf`, `computeLostParts` (уничтоженная часть теряется вместе с потомками; без `structure` — часть с HP 0), `rerootParents`. Тест: `node module/helpers/anatomy-relations.test.mjs`.
    - `actor-death.mjs` — статусы на токене по `system.health.dead`: «dead» (потерян корень или уничтожен `vital`-орган), «unconscious» при смерти (повреждён `vital`-орган или смертельное кровотечение); работает только на клиенте активного ГМа. Тест: `node module/helpers/actor-death.test.mjs`.
    - `hit-quality.mjs` — качество попадания по центровости: зона полного попадания, «яблочко» (крит), равномерное падение множителя энергии к краю хитбокса, эффект крита режима (`critEffect`: `resolveModeCritEffect` в `weapon-model.mjs`). Множитель режет энергию снаряда (`applyEnergyScaleToApplications`), урон следует за энергией по закону брони (`damageRatioForEnergyRatio`); углового `armorScale` нет. Зона дуги сюда не входит. Тесты: `node module/helpers/hit-quality.test.mjs`, `node module/helpers/aiming-hit-quality.test.mjs`. См. `docs/code/reference/SHOOTING_SYSTEM.md` («Качество попадания»).
    - `hit-luck.mjs` — зоны дуги прицеливания (`normalizeLuckZone`), `clockToHitFace`, `walkProjectileCollisions` (ход снаряда по столкновениям со стенами и планом пробития; пролёт мимо токена — через хук `judgeToken`, его подключает `createShot`).
    - `shot-confidence.mjs` — уверенность выстрела против сопротивления попаданию цели (чистые функции): зона дуги → число (красная 1, оранжевая 2, жёлтая 3, зелёная 5, фиолетовая 6), сопротивление = максимум по состояниям цели (в бою 1, движется 2, в укрытии 3, спрятана 5) + модификатор `system.hitResistanceMod` (эффекты); попадает, если уверенность **строго больше**; иначе снаряд пролетает мимо (`createTokenJudge` → `judgeToken`). Подключено в `ShotManager.createShot({ confidence })`; пока определяется только состояние «в бою». Тест: `node module/helpers/shot-confidence.test.mjs`. См. `docs/code/reference/SHOOTING_SYSTEM.md` («Уверенность и сопротивление»).
    - `hitbox-scale.mjs` — масштаб хитбокса цели (`system.hitboxScale`, %), применяется в `ShotManager._targetHitRadius`.
    - `derived-stats.mjs` — формулы производных характеристик актёра (чистые функции: HP-множитель, подъём/перенос, скорости, прыжки, счёты, ОД, героизм и др.; `computeDerivedStats`). Вызывается из `SpaceHolderActor._prepareDerivedCharacterStats`. Шкала: 100 = средний человек; STR абсолютная, END/AGI относительные к виду. Тест: `node module/helpers/derived-stats.test.mjs`. См. `docs/code/reference/DERIVED_STATS.md`.
    - `ability-scale-migration.mjs` — одноразовая миграция мира на шкалу 100 и `dex` → `agi` (запускается на `ready` у ГМа). Тест: `node module/helpers/ability-scale-migration.test.mjs`.
    - `walls/*` — пробитие стен выстрелами: `wall-data.mjs` (флаги `flags.spaceholder.wall`, `isShotBlockingWall`), `wall-spans.mjs` (спаны материала вдоль луча, углы/толстые стены), `wall-penetration.mjs` (`planWallPasses`, правила брони v3), `wall-config.mjs` (конфиг стены + настройка). См. `docs/code/reference/WALL_PENETRATION.md`.
    - `gm-actions/*` — единый путь действий с правами ГМа (урон по чужим токенам, запись журнала раунда игроком не в его ход и др.): живой запрос ГМу, очередь в отсутствие ГМа, окно «Действия игроков в ваше отсутствие», заметка в чате. См. `docs/code/reference/GM_ACTIONS.md`.
    - `actions/ap-pool.mjs` (правила, чисто) + `actions/transaction-ledger.mjs` (`spendAp`, `resetApPool`, `describeApCounter`) — пул ОД: **в бою жёсткий лимит** (не хватает ОД — действие не происходит), **вне боя счётчик «потрачено с последнего боя»** (значение уходит в минус); сброс при конце боя. `actions/combat-action-log.mjs` — запись действия в лог боя (таблица + журнал в чате). Тесты: `node module/helpers/actions/ap-pool.test.mjs`, `node module/helpers/actions/transaction-ledger.test.mjs`. См. `docs/code/reference/COMBAT_SYSTEM_V1.md` («AP rules»).
  - **`helpers/legacy/`** — старый/экспериментальный код (не расширять без причины).
- **`module/data/`** — данные системы (JSON): `data/payloads/*`, `data/globalmaps/*` (анатомии см. ниже).
- **`data/anatomy/`** (в корне системы) — стандартные анатомии: `registry.json` и JSON-файлы шаблонов (тот же формат для всех). Путь в рантайме: `systems/spaceholder/data/anatomy/`.
- **`data/skills/`** — пресет дерева физических навыков (`physical-tree.json`; рантайм — `module/helpers/skills/physical-tree.mjs`).
- Анатомии, созданные в мире, хранятся **только в папке мира** как JSON-файлы: `worlds/<worldId>/spaceholder/anatomy/<id>.json` (тот же формат, что и в `data/anatomy/`). Загрузка по необходимости через `loadWorldPresets()` (FilePicker browse + fetch).

## Остальные ключевые папки проекта

- `templates/` — Handlebars-шаблоны UI (подгружаются заранее).
- `src/scss/` → `css/spaceholder.css` — стили (SCSS компилируется в CSS).
- `lang/en.json`, `lang/ru.json` — локализация.
- `docs/code/` — документация по коду (см. `docs/code/README.md` — структура папок). Кратко: **`docs/code/reference/`** — как устроена реализация (стрельба, анатомия, зоны влияния, item piles и т.д.); **`docs/code/guides/`** — гайды по UI/листам; **`docs/code/tooling/`** — внешние инструменты (compendium, npm). У каждого `.md` в `docs/code` в YAML frontmatter заданы `doc-type` и `status` (например `current`, `verify`, `legacy`) и теги `sh-code-doc/…` для навигации в Obsidian. **При доработках интерфейса** см. `docs/code/guides/UI_DESIGN_GUIDE.md` — правила дизайна. **Проблемы с листами App V2** (кнопки, вкладка, `ForcedDeletion`) — `docs/code/guides/APP_V2_SHEET_PATTERNS.md`. **Item piles на сцене** — `docs/code/reference/ITEM_PILES_SH.md`.
- `docs/Kanban/` — оперативный трекинг задач (Obsidian Kanban). Доска: `docs/Kanban/Tasks.md`. Не путать с `docs/code/` — там «как устроено», здесь «что делаем / проверяем».
- `tools/balance/` — утилита баланса (веб-интерфейс + локальный сервер на Node, вне Foundry): база случаев «оружие → часть тела → броня → исход», база предметов (черновики из компендиума) и калькулятор на настоящем резолвере. Запуск: `npm run balance`. Данные — `tools/balance/data/*.json` (в git). Сверка случаев с механикой — `tools/balance/lib/outcome.mjs` (все ветки места попадания × семейство оружия → худший/лучший исход). См. **`docs/code/tooling/BALANCE_TOOL.md`**; тесты: `npm run test:balance`.
- `pack-src/` — исходные JSON встроенных компендиумов (в git). Каталоги **`packs/<имя-пака>/`** — LevelDB, собираемые из `pack-src/`; не класть туда «ручные» JSON как единственный источник записей. Рабочий процесс: **`docs/code/tooling/COMPENDIUM_PACKS.md`**.
  - Паки: `sh-test-items` (предметы; источник истины — `pack-src/sh-test-items`, `generate:sh-catalog` устарел), `sh-test-actors` (`generate:sh-test-actors`), `sh-test-scenes` — **Adventure**: тестовые сцены с готовыми к бою актёрами, фракциями и журналом «что проверить» (`generate:sh-test-scenes`, задники `assets/scenes/*.svg`). Актёров собирает `scripts/lib/sh-actor-builder.mjs`. Сборка любого пака — `node scripts/compile-pack.mjs <имя> [--in-place]` (npm: `pack:<имя>`).
  - Каталог материалов (записи типа `material`) живёт **только** в системном компендиуме (`pack-src/sh-test-items/SH_Material_*.json`). В коде нет встроенного fallback-каталога: `MaterialsManager` индексирует паки + мировые айтемы и возвращает «пустой» материал, если slug не найден. Тестовая фикстура для Node-смоков — `module/helpers/damage/__fixtures__/test-materials.mjs` (изолирована от пака, чтобы тюнинг значений в JSON не ломал ассерты).

## Команды разработки

```bash
npm install
npm run build   # SCSS → css/spaceholder.css
npm run watch   # авто-пересборка SCSS
```

Важно: после правок в `src/scss/` нужно прогнать `npm run build` или `npm run watch`, чтобы обновился `css/spaceholder.css`.

Компендиумы (после правок в `pack-src/`): закрыть Foundry, затем `npm run pack:sh-test-items` / `pack:sh-test-actors` / `pack:sh-test-scenes` (см. `docs/code/tooling/COMPENDIUM_PACKS.md`).

### File Search: Avoid Glob/Grep, prefer rg

The `Glob` and `Grep` tools are broken in this workspace — they hang indefinitely and must not be used.
For text search, prefer `rg` (ripgrep).
**Use Shell commands for file/directory discovery:**

- **Find files by name/pattern:**
  `cmd /c "dir /S /B E:\FoundryVTT\Data\systems\spaceholder<subfolder>*.ext"`

Add `| cmd /c "findstr pattern"` to filter results.

- **List directory contents:**
  `cmd /c "dir E:\FoundryVTT\Data\systems\spaceholder<subfolder>"`

- **Search text in files (preferred):**
  `rg -n --glob "*.mjs" "pattern" E:\FoundryVTT\Data\systems\spaceholder<subfolder>`

- **Fallback search text in files (if needed):**
  `cmd /c "findstr /S /I /N /M "pattern" E:\FoundryVTT\Data\systems\spaceholder<subfolder>*.mjs"`

- **Read a known file:** use the `Read` tool directly with the full path — never use Glob to locate files whose path can be inferred from AGENTS.md or the conversation context.
  **Never use:**

- `Glob` — hangs indefinitely

- `Grep` — hangs indefinitely

## Инициализация и публичный API

### Инициализация

В `module/spaceholder.mjs` система в основном делает:

- `Hooks.once('init')`:
  - настраивает `CONFIG.SPACEHOLDER` и базовые вещи (инициатива и т.п.);
  - регистрирует documentClass для Actor/Item;
  - регистрирует Application V2 листы;
  - регистрирует Handlebars helpers;
  - отключает legacyTransferral для ActiveEffect;
  - прелоадит шаблоны.
- `Hooks.once('ready')`:
  - инициализирует менеджеры (например `AnatomyManager`);
  - подключает дополнительные хуки (например hotbar drop → item macro).

### Публичный API (`game.spaceholder`)

Система публикует часть функций/менеджеров в `game.spaceholder` (см. `module/spaceholder.mjs`). Наиболее используемое:

- Документы:
  - `game.spaceholder.SpaceHolderActor`
  - `game.spaceholder.SpaceHolderItem`
- Макросы:
  - `game.spaceholder.rollItemMacro(itemUuid)`
- Иконки:
  - `await game.spaceholder.pickIcon({ root?, defaultColor?, title?, factionColor?, initialPath?, initialOpts? }) → string | null`
  - `await game.spaceholder.applyIconPathToActorOrToken({ path, actor, tokenDoc?, applyTo: 'actor'|'token'|'both' }) → boolean`
  - `await game.spaceholder.pickAndApplyIconToActorOrToken(...) → string | null`
  - `await game.spaceholder.promptPickAndApplyIconToActorOrToken(...) → string | null`
  - `await game.spaceholder.getIconLibraryIndex({ root?, force?, extensions? }) → icon[]`
  - `game.spaceholder.getIconLibraryCacheInfo() → { root, hasIcons, count, at }`
  - миграции generated SVG:
    - `game.spaceholder.migrateIconLibraryGeneratedSvgsRemoveNonScalingStroke(opts)`
    - `game.spaceholder.migrateIconLibraryGeneratedSvgsInsetBackgroundStroke(opts)`
- Influence:
  - `game.spaceholder.showInfluence(debug?)`, `hideInfluence()`, `toggleInfluence(debug?)`
- Фракции пользователей:
  - `game.spaceholder.getUserFactionUuids(user)`
  - `game.spaceholder.getUsersForFaction(factionUuid)`
  - `game.spaceholder.getUsersForToken(tokenLike)`
  - `game.spaceholder.normalizeUuid(raw)`
  - Вложенное хранилище предметов:
    - `game.spaceholder.nestedItemStorage.addItemToNestedStorage({ containerItem, item, quantity?, consumeSource?, parentPath? })`
    - `game.spaceholder.nestedItemStorage.extractNestedItemToActor({ containerItem, path, quantity? })`
    - `game.spaceholder.nestedItemStorage.getNestedStorage(itemLike)`
    - `game.spaceholder.nestedItemStorage.resolveAndConsumeRangedAmmoForShot({ actor, weaponItem })`
  - Миграция характеристик:
    - `await game.spaceholder.migrateAbilityScale({ force? })` — перевод актёров/предметов/эффектов на шкалу 100 (по умолчанию один раз на мир; повтор безопасен).
  - Личное время (секунды из ОД; см. `docs/code/reference/PERSONAL_TIME.md`):
    - `game.spaceholder.apToSeconds(actor, ap)`, `secondsToAp(actor, seconds)`
    - `await game.spaceholder.advancePersonalTime(actor, seconds, meta?)`
    - `game.spaceholder.getPersonalTimeTotal(actor)`
    - `await game.spaceholder.openSkipPersonalTimeDialog()` (GM)
    - `game.spaceholder.REFERENCE_TURN_SECONDS` (= 10)
    - Миниигра взлома (локально, без привязки к навыкам/миру):
    - `await game.spaceholder.openHackMinigame()` — диалог генерации → Application V2
    - `await game.spaceholder.openLockpickMinigame()` — диалог генерации → Application V2 (взлом замков)
    - Доступ к инстансам/подсистемам (если экспортируются):
    - `game.spaceholder.tokenpointer`, `drawManager`, `shotManager`, `influenceManager`
    - `game.spaceholder.globalMapProcessing`, `globalMapRenderer`, `globalMapTools`
    - `game.spaceholder.globalMapTerrain` — 3D-рельеф (heightmap/splat, overlay, редактор)
    - `await game.spaceholder.openLookFromPoint({ x, y } | { token })` — окно осмотра с точки на террейне
- Действия и атака:
  - `game.spaceholder.collectActorActions(actor, ctx?)`, `executeActorAction(actor, action, ctx?)`
  - `await game.spaceholder.runActorAction(actorUuid, actionId)` — выполнить действие по id (макросы хотбара)
  - `await game.spaceholder.runItemAttack(itemUuid, { lineId?, modeId? })` — атака предметом по UUID (макросы хотбара «Атака»; без `lineId`+`modeId` — активные линия/режим, оружие не в руках берётся цепочкой)
  - `item.canAttack` / `await item.attack({ token, lineId?, modeId? })` (`SpaceHolderItem`) — атака предметом активными (или заданными) линией/режимом
  - Прицеливание: `game.spaceholder.aimingManager.isAimingActor(actor)`, `stopAiming()`; хук `spaceholder.aimingChanged` (`{ aiming, token }`) при старте/конце прицеливания — на него подписан быстрый HUD (кнопка «Атаковать» ↔ «Отмена»)
- Действия с правами ГМа (`docs/code/reference/GM_ACTIONS.md`):
  - `await game.spaceholder.gmActions.request(type, payload, { label?, chatMessageId? })` → `{ status: 'done', id, result }` | `{ status: 'queued', id }`
  - `game.spaceholder.gmActions.register(type, { category?, handler, validate? })` — на каждом клиенте
  - `game.spaceholder.gmActions.listQueue()`, `openQueue()` (ГМ)
- Навыки (структура; в aiming/shot не подключено):
  - `game.spaceholder.getSkillEffect(actor, nodeId)` — взвешенное среднее 0–10 по цепочке от корня (нули не схлопываются)
  - `game.spaceholder.getSkillLevel(actor, nodeId)` — уровень узла пресета или extra (0–10)
  - `game.spaceholder.getSkillPath(nodeId)` — предки пресет-узла от корня
- Анатомия / группы:
  - `game.spaceholder.getGroupAbility(actor, groupId)` — sum currentHp / sum maxHp (0–1)
  - `game.spaceholder.getAnatomyGroups(actor)`, `getGroupsByType(actor, type)`, `getPartGroups(actor, slotRef)`

Если добавляете новый публичный метод, считайте это как изменение внешнего API: документируйте в этом файле и старайтесь держать сигнатуру стабильной.

## Икон-библиотека и Icon Picker (важные правила)

(Актуально по `WARP.md`)

- Иконки лежат в папке мира (Data): `<root>/source/**.svg`.
- Перекрашенные/"запечённые" версии автоматически сохраняются в `<root>/generated/`.
- По умолчанию `<root>` = `worlds/<worldId>/spaceholder/icon-library`.
  - Можно переопределить через world setting `spaceholder.iconLibrary.root` (setting скрыт из UI; менять через консоль).
- Подпапки внутри `source/` считаются категориями (category = относительный путь).
- Сейчас поддерживается только `.svg`.

## Стиль кода и соглашения

### Сохраняем модульность

При добавлении новых фич, расширении старого функционала и даже при исправлении багов — **пытаемся расширить старый код, а не плодить специфический новый**. Исключение — если задача явно про рефакторинг, изменение структуры или подобное.

Пример:
Допустим, есть метод `drawRedCircle()`, который рисует красный круг на указанных координатах. Когда понадобится зелёный круг:

- **НЕ ДЕЛАЕМ** новый метод `drawGreenCircle()`, дублирующий логику `drawRedCircle()` с мелкими специфичными отличиями.
- **ДОРАБАТЫВАЕМ** `drawRedCircle()` до общего `drawCircle()`, в который передаётся нужный `color` (и при необходимости другие параметры).

Проще говоря: прежде чем писать новую функцию/метод/класс рядом с существующим — посмотри, нельзя ли обобщить существующий и переиспользовать его.

### JavaScript / ES Modules

- ES6+ синтаксис (import/export).
- Классы: `PascalCase`, функции/переменные: `camelCase`.
- Константы: `UPPER_SNAKE_CASE`.
- Избегайте магических значений — выносите в именованные константы.
- Для публичных функций/классов: JSDoc.

### UI/шаблоны

- Handlebars: `.hbs` в `templates/`.
- Любой новый UI-текст — через i18n:
  - добавляйте ключи в `lang/en.json` и `lang/ru.json`.

### SCSS/CSS

- Правим `src/scss/`, результат — `css/spaceholder.css`.
- Префиксуйте классы `spaceholder-*`.
- Стараемся не использовать `!important`

## Kanban (`docs/Kanban/`)

Доска `Tasks.md` — колонки и их смысл:

- **Backlog** — идеи и «надо когда-нибудь»; отсортирован по классу (S сверху).
- **Soon** — следующие в очереди.
- **Work** — в работе сейчас (включая код, который ждёт ручной проверки владельцем).
- **Done** — закрыто.

**Классификация** — префикс `класс-размер` в начале названия карточки, например `S-XL` (файл `S-XL Имя.md`, на доске `- [ ] [[S-XL Имя]]`, у карточек без файла — `- [ ] B-M Имя`). Разделитель — дефис: `|` нельзя в именах файлов Windows и он ломает `[[ссылки]]` в Obsidian. Классификация хранится **только в названии** — больше нигде не дублируется, чтобы менять её в одном месте: переименуй карточку и обнови все `[[ссылки]]` на неё. Нужна карточкам Backlog/Soon; в Work/Done её нет (при переносе в Work префикс можно оставить).

- **S** — критически важно: без этого нельзя нормально играть (ядро боя, травмы, баланс, баги, ломающие сессию).
- **A** — важная часть НРИ в Foundry, но технически играть можно и без неё (модификаторы, эффекты, журнал боя и т.п.).
- **B** — обычные задачи.
- **C** — прикольная штука, которую хорошо бы иметь, но фактическая ценность крайне относительна.

**Размер** (после дефиса):

- **S** — один заход в 1–3 файла, без открытых вопросов дизайна.
- **M** — один сфокусированный заход, 4–8 файлов, без новой подсистемы.
- **L** — несколько заходов или новая подсистема среднего размера, затрагивает ядро.
- **XL** — переработка ядра или большая новая система; сначала дизайн, плюс правки данных.

Буква размера `S` и класс `S` — разные вещи: класс стоит до дефиса, размер после.

Новая карточка получает классификацию сразу; если она неочевидна — предложи и спроси владельца. Префикс `NR ` (карточки после перерыва) больше не ставим: в Backlog он заменён классификацией, в Done остался у уже закрытых.

Необязательные пометки — `flags: [design, split, merge]` во frontmatter файла карточки: `design` — дизайн не решён, сначала решить; `split` — стоит разбить на карточки; `merge` — стоит слить с другой. Это заметки, не часть классификации.

**Задачи на доске — два формата:**

- **Только заголовок** — строка без wiki-link, например `- [ ] Починить X`. Отдельного файла нет; **в строке карточки — только заголовок**, без дополнительного текста.
- **Со ссылкой** — `- [ ] [[имя]]`, содержимое в одноимённом `.md` рядом с доской.

**Формат карточек на доске:**

- Строка карточки — **только** чекбокс и заголовок (или `[[wiki-link]]`). **Не дописывать** под карточкой текст, шаги проверки, комментарии.
- Заголовки колонок (`## Backlog`, `## Work`, …) — **только** названия колонок, без пояснений.
- Любой текст сверх заголовка карточки — в отдельном `.md` и ссылка `- [ ] [[имя]]` на доске.

**Когда нужен отдельный файл (`[[имя]]`):**

- Задача **не помещается в одну строку** — нужны детали, контекст, ссылки, несколько шагов реализации или шаги ручной проверки.
- Если задача **короткая и однозначная** (например «Поменять цвет текста в баннере на красный») — wiki-файл **не нужен**: и что сделать, и что проверить, уже понятно из названия.

**Взять задачу в работу (Backlog/Soon → Work):**

- Владелец **отмечает чекбокс** задачи (`[x]`) как сигнал «взять в работу».
- Агент ищет отмеченные пункты поиском по `[x]` в `docs/Kanban/Tasks.md` (не читать всю доску целиком, если задач много).
- Переносит карточку в колонку **Work** и **снимает отметку** (`[ ]`).

**Правила для агентов:**

- Пиши в wiki-файлы задач свободно, но **кратко** — пара строк, не абзацы ради одной мысли.
- Колонки **Check нет**: не переносить карточку в Done самому. Когда код готов — оставить в **Work** и дописать **в конец карточки** (её wiki-файла) раздел `## Проверить руками`: шаги, актор/предмет, ожидаемое поведение. Общей заметки с проверками (вроде «Тесты») нет — проверки живут в своей карточке. В Done карточку двигает владелец.
  - Для **самодостаточных** коротких задач без wiki-файла проверка должна быть понятна из **названия** карточки.
  - Если шаги проверки (или любые детали) **не помещаются в название** — создай `docs/Kanban/<имя>.md`, перепиши карточку как `- [ ] [[имя]]` и запиши детали в файл.
- Долгоживущую доку по реализации — в `docs/code/`, не в Kanban.

## Листы Application V2 (шпаргалка)

При задачах и багах, связанных с листами документов (Item/Actor) в Application V2:

- **Сначала сверяться с `docs/code/guides/APP_V2_SHEET_PATTERNS.md`**: там описаны проверенные решения (кнопки, сохранение вкладки, удаление ключей в документе).
- Если после дебага проблемы вида «кнопка должна нажиматься, а не нажимается», «вкладка сбрасывается», «удаление не сохраняется» и т.п. найдено решение, которого **нет** в этой доке — **предложить пользователю добавить его в `docs/code/guides/APP_V2_SHEET_PATTERNS.md`**, чтобы нарабатывать шпаргалку под специфику проекта.

## Паттерны проекта, на которые стоит ориентироваться

- **Большие подсистемы живут в `module/helpers/*`**, а вход в них — из `module/spaceholder.mjs`.
- **Флаги (`flags.spaceholder.*`) активно используются** для хранения состояния (фракции, токен-указатель, journal-check, timeline v2 и т.п.).
- **Timeline V2** имеет инфраструктуру контейнеров/страниц и сокет-операции для GM-действий (`timeline-v2.mjs`).
- **Global Map** — отдельный пакет модулей (`helpers/global-map/*`) с UI и обработкой данных.
- **`helpers/legacy/*`**: не расширяйте и не рефакторьте по пути, если задача не про это.

## Наследие исходного форка (низкий приоритет)

Не удаляем из репозитория, но **не дорабатываем и не «причёсываем» без отдельной просьбы** — внутри возможен нетронутый мусор или случайно затронутый хлам от форка.

- **Лист NPC** — шаблон `templates/actor/actor-npc-sheet.hbs`, ветка типа `npc` в листе актёра и связанные куски. Сейчас не целевой продукт; не ожидайте согласованности с остальной системой.
- **Типы Item `feature` и `spell`** — записи в `template.json`, листы/шаблоны под эти типы. Активная разработка под них не ведётся, пока явно не попросят.

## Тестирование и проверка изменений

- В репозитории нет единого тест-раннера. Возможны точечные Node-скрипты (`test-*.js` в корне) или ручная проверка в Foundry.
- Для изменений UI/хуков основная проверка — запуск Foundry пользователем и просмотр консоли.
- **Ручные проверки пишем в конце карточки задачи** (раздел `## Проверить руками` в `docs/Kanban/<карточка>.md`, пункты — чекбоксы `- [ ]`; общего списка нет) **и пишем понятными:** что именно сделать (на каком токене, вкладке, какую кнопку нажать) и что должно получиться. Перед тем как записать или выдать пользователю список проверок, сверить его с кодом: пункт должен быть актуален. Непонятный или устаревший пункт — переписать или убрать.
- **Обратная совместимость по умолчанию не нужна** (проект в разработке): не делаем миграций, алиасов и «регресс»-проверок, если об этом не просили. Если кажется, что совместимость может понадобиться, — спросить, нужна ли она.
- В системе **нет бросков характеристик** (`d20 + мод`): не добавлять и не тестировать.

## Коммиты и релизы

- Сообщения коммитов — короткие, описательные, обычно на английском (исторически).
- Не делайте push автоматически.
- Релизы делаются через `release.ps1` (обновляет `system.json`, формирует ассеты и т.д.).

---

**Совместимость:** Foundry VTT v14+
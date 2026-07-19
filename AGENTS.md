# AGENTS.md

Руководство для контрибьютеров и AI-агентов, работающих с системой SpaceHolder для Foundry VTT.

> Источник истины по архитектуре в этом репозитории — код в `module/`. Этот документ обновлён на основе `WARP.md` и текущей структуры `module/**`.

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
    - `draw-manager.mjs` — отрисовка результатов выстрела/сегментов на PIXI.
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
  - **`helpers/legacy/`** — старый/экспериментальный код (не расширять без причины).
- **`module/data/`** — данные системы (JSON): `data/payloads/*`, `data/globalmaps/*` (анатомии см. ниже).
- **`data/anatomy/`** (в корне системы) — стандартные анатомии: `registry.json` и JSON-файлы шаблонов (тот же формат для всех). Путь в рантайме: `systems/spaceholder/data/anatomy/`.
- Анатомии, созданные в мире, хранятся **только в папке мира** как JSON-файлы: `worlds/<worldId>/spaceholder/anatomy/<id>.json` (тот же формат, что и в `data/anatomy/`). Загрузка по необходимости через `loadWorldPresets()` (FilePicker browse + fetch).

## Остальные ключевые папки проекта

- `templates/` — Handlebars-шаблоны UI (подгружаются заранее).
- `src/scss/` → `css/spaceholder.css` — стили (SCSS компилируется в CSS).
- `lang/en.json`, `lang/ru.json` — локализация.
- `docs/code/` — документация по коду (см. `docs/code/README.md` — структура папок). Кратко: **`docs/code/reference/`** — как устроена реализация (стрельба, анатомия, зоны влияния, item piles и т.д.); **`docs/code/guides/`** — гайды по UI/листам; **`docs/code/tooling/`** — внешние инструменты (compendium, npm). У каждого `.md` в `docs/code` в YAML frontmatter заданы `doc-type` и `status` (например `current`, `verify`, `legacy`) и теги `sh-code-doc/…` для навигации в Obsidian. **При доработках интерфейса** см. `docs/code/guides/UI_DESIGN_GUIDE.md` — правила дизайна. **Проблемы с листами App V2** (кнопки, вкладка, `ForcedDeletion`) — `docs/code/guides/APP_V2_SHEET_PATTERNS.md`. **Item piles на сцене** — `docs/code/reference/ITEM_PILES_SH.md`.
- `docs/Kanban/` — оперативный трекинг задач (Obsidian Kanban). Доска: `docs/Kanban/Tasks.md`. Не путать с `docs/code/` — там «как устроено», здесь «что делаем / проверяем».
- `pack-src/` — исходные JSON встроенных компендиумов (в git). Каталоги **`packs/<имя-пака>/`** — LevelDB, собираемые из `pack-src/`; не класть туда «ручные» JSON как единственный источник записей. Рабочий процесс: **`docs/code/tooling/COMPENDIUM_PACKS.md`**.
  - Каталог материалов (записи типа `material`) живёт **только** в системном компендиуме (`pack-src/sh-test-items/SH_Material_*.json`). В коде нет встроенного fallback-каталога: `MaterialsManager` индексирует паки + мировые айтемы и возвращает «пустой» материал, если slug не найден. Тестовая фикстура для Node-смоков — `module/helpers/damage/__fixtures__/test-materials.mjs` (изолирована от пака, чтобы тюнинг значений в JSON не ломал ассерты).

## Команды разработки

```bash
npm install
npm run build   # SCSS → css/spaceholder.css
npm run watch   # авто-пересборка SCSS
```

Важно: после правок в `src/scss/` нужно прогнать `npm run build` или `npm run watch`, чтобы обновился `css/spaceholder.css`.

Компендиумы (после правок в `pack-src/`): закрыть Foundry, затем `npm run pack:sh-test-items` (см. `docs/code/tooling/COMPENDIUM_PACKS.md`).

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
  - Личное время (секунды из ОД; см. `docs/code/reference/PERSONAL_TIME.md`):
    - `game.spaceholder.apToSeconds(actor, ap)`, `secondsToAp(actor, seconds)`
    - `await game.spaceholder.advancePersonalTime(actor, seconds, meta?)`
    - `game.spaceholder.getPersonalTimeTotal(actor)`
    - `await game.spaceholder.openSkipPersonalTimeDialog()` (GM)
    - `game.spaceholder.REFERENCE_TURN_SECONDS` (= 10)
    - Миниигра взлома (локально, без привязки к навыкам/миру):
    - `await game.spaceholder.openHackMinigame()` — диалог генерации → Application V2
    - Доступ к инстансам/подсистемам (если экспортируются):
    - `game.spaceholder.tokenpointer`, `drawManager`, `shotManager`, `influenceManager`
    - `game.spaceholder.globalMapProcessing`, `globalMapRenderer`, `globalMapTools`

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

- **Backlog** — идеи и «надо когда-нибудь», без приоритета.
- **Soon** — следующие в очереди.
- **Work** — в работе сейчас.
- **Check** — сделано кодом, ждёт **ручной** проверки владельцем (Foundry, регресс, UX).
- **Done** — закрыто.

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
- Перенося в **Check**, обязательно укажи **что проверить руками** (шаги, актор/предмет, ожидаемое поведение). Без этого колонка бесполезна.
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

## Коммиты и релизы

- Сообщения коммитов — короткие, описательные, обычно на английском (исторически).
- Не делайте push автоматически.
- Релизы делаются через `release.ps1` (обновляет `system.json`, формирует ассеты и т.д.).

---

**Совместимость:** Foundry VTT v14+
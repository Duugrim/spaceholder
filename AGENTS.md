# AGENTS.md

Руководство для контрибьютеров и AI-агентов, работающих с системой SpaceHolder для Foundry VTT.

> Источник истины по архитектуре в этом репозитории — код в `module/`. Этот документ обновлён на основе `WARP.md` и текущей структуры `module/**`.

## Проект в двух словах

SpaceHolder — игровая система (Foundry VTT v13+) с ES-модулями. Точка входа — `module/spaceholder.mjs`. Система регистрирует кастомные Document-классы (Actor/Item), Application V2 листы, набор хуков/настроек и публикует вспомогательный API в `game.spaceholder`.

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
- **`module/data/`** — данные системы (JSON):
  - `data/anatomy/*` — анатомии (`registry.json`, шаблоны анатомий).
  - `data/payloads/*` — payload-описания для прицеливания/выстрелов (`manifest.json` + набор паттернов).
  - `data/globalmaps/*` — конфиги глобальной карты (биомы/heightmap).

## Остальные ключевые папки проекта

- `templates/` — Handlebars-шаблоны UI (подгружаются заранее).
- `src/scss/` → `css/spaceholder.css` — стили (SCSS компилируется в CSS).
- `lang/en.json`, `lang/ru.json` — локализация.
- `docs/` — техническая документация: `SHOOTING_SYSTEM.md` (стрельба/payload/сегменты), анатомия, влияние, глобальная карта и т.д.

## Команды разработки

```bash
npm install
npm run build   # SCSS → css/spaceholder.css
npm run watch   # авто-пересборка SCSS
```

Важно: после правок в `src/scss/` нужно прогнать `npm run build` или `npm run watch`, чтобы обновился `css/spaceholder.css`.

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

## Паттерны проекта, на которые стоит ориентироваться

- **Большие подсистемы живут в `module/helpers/*`**, а вход в них — из `module/spaceholder.mjs`.
- **Флаги (`flags.spaceholder.*`) активно используются** для хранения состояния (фракции, токен-указатель, journal-check, timeline v2 и т.п.).
- **Timeline V2** имеет инфраструктуру контейнеров/страниц и сокет-операции для GM-действий (`timeline-v2.mjs`).
- **Global Map** — отдельный пакет модулей (`helpers/global-map/*`) с UI и обработкой данных.
- **`helpers/legacy/*`**: не расширяйте и не рефакторьте по пути, если задача не про это.

## Тестирование и проверка изменений

- В репозитории нет единого тест-раннера. Возможны точечные Node-скрипты (`test-*.js` в корне) или ручная проверка в Foundry.
- Для изменений UI/хуков основная проверка — запуск Foundry пользователем и просмотр консоли.

## Коммиты и релизы

- Сообщения коммитов — короткие, описательные, обычно на английском (исторически).
- Не делайте push автоматически.
- Релизы делаются через `release.ps1` (обновляет `system.json`, формирует ассеты и т.д.).

---

**Совместимость:** Foundry VTT v13+

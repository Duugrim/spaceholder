# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

Проект: Foundry VTT system «SpaceHolder» (личный форк boilerplate)

- Корневой манифест: system.json
- Точка входа JS: module/spaceholder.mjs (ES module)
- Стили: css/spaceholder.css (генерируется из src/scss/spaceholder.scss)
- Локализация: lang/en.json
- Шаблоны (Handlebars): systems/spaceholder/templates/** (заранее подгружаются)

Команды (pwsh / Node.js)

- Установка зависимостей
```powershell path=null start=null
npm install
```

- Сборка CSS из SCSS
```powershell path=null start=null
npm run build
```

- Наблюдение за SCSS и автосборка
```powershell path=null start=null
npm run watch
```

- Линтинг и тесты
В репозитории не настроены линтеры и тестовый раннер. Команд для запуска отдельных тестов нет.

Архитектура и ключевые связи

- Манифест (system.json)
  - id: "spaceholder"; styles указывает на css/spaceholder.css; esmodules на module/spaceholder.mjs
  - Совместимость Foundry v13; локализация «en»; медиа/иконки; packs пустые

- Инициализация системы (module/spaceholder.mjs)
  - Hooks.once('init'): публикует API в game.spaceholder, задаёт CONFIG.SPACEHOLDER, настраивает инициативу (1d20 + @abilities.dex.mod), регистрирует кастомные Document-классы (Actor/Item) и листы (Application V2), отключает legacyTransferral для ActiveEffect, прелоадит шаблоны
  - Handlebars helpers (toLowerCase, multiply, join, lt/gt/eq)
  - Hooks.once('ready'): инициализация AnatomyManager; регистрация hotbarDrop → создание макросов для предметов

- Документы
  - Actor (module/documents/actor.mjs)
    - prepareDerivedData рассчитывает модификаторы характеристик, подготавливает систему здоровья по частям тела
    - Подсистема «анатомии» и здоровья: bodyParts с иерархией, вычисление healthPercentage и общего totalHealth
    - Алгоритм попаданий: chanceHit(targetPartId, roll) рекурсивно спускается по дочерним частям с учётом coverage; performHit применяет урон; applyBodyPartDamage обновляет конкретную часть и пересчитывает totalHealth
    - Управление анатомией: setAnatomy/changeAnatomyType создают копию шаблона анатомии для актёра; resetAnatomy/clearAnatomy очищают текущее состояние
    - getRollData готовит данные для бросков; поддержка типов character/npc
  - Item (module/documents/item.mjs)
    - roll(): формирует чат-сообщение либо бросок по formula из system

- Листы (Application V2)
  - ActorSheets (module/sheets/actor-sheet.mjs)
    - Базовый лист подмешан через HandlebarsApplicationMixin; готовит контекст (system, flags, config), обогащает биографию, собирает эффекты
    - Tabs: для персонажа «stats» и «health»; активная вкладка запоминается
    - UI для инвентаря, эффектов, макродраг-н-дропа
    - UI анатомии: выбор/смена типа, полный сброс с подтверждением, построение иерархии частей для отображения
  - ItemSheets (module/sheets/item-sheet.mjs)
    - Tabs: description/attributes/effects; готовит контекст и управление эффектами

- Хелперы
  - templates.mjs: прелоад набора partials актёра и предмета
  - effects.mjs: управление ActiveEffect (create/edit/delete/toggle), категоризация на temporary/passive/inactive
  - icon-library/** и icon-picker/**: кураторская библиотека SVG + окно выбора иконки (перекраска и bake в generated/)

Икон-библиотека + Icon Picker (SVG)

Куда складывать иконки
- Иконки лежат в папке мира (Data): `<root>/source/**.svg`.
- Перекрашенные/"запечённые" версии автоматически сохраняются в `<root>/generated/`.
- По умолчанию `<root>` = `worlds/<worldId>/spaceholder/icon-library`.
  - Можно переопределить через world setting `spaceholder.iconLibrary.root` (setting скрыт из UI; менять через консоль).
- Подпапки внутри `source/` считаются категориями (category = относительный путь).

Публичный API (доступен как `game.spaceholder.*`)
- `await game.spaceholder.pickIcon({ root?, defaultColor?, title? })` → `string | null`
  - Открывает окно выбора, перекрашивает SVG, сохраняет в `generated/` и возвращает путь к файлу.
- `await game.spaceholder.applyIconPathToActorOrToken({ path, actor, tokenDoc?, applyTo: 'actor'|'token'|'both' })` → `boolean`
- `await game.spaceholder.pickAndApplyIconToActorOrToken({ actor, tokenDoc?, applyTo, root?, defaultColor?, title? })` → `string | null`
- `await game.spaceholder.promptPickAndApplyIconToActorOrToken({ actor, tokenDoc?, root?, defaultColor?, title? })` → `string | null`
- `await game.spaceholder.getIconLibraryIndex({ root?, force?, extensions? })` → `icon[]`
  - `icon` meta: `{ id, path, previewUrl, name, category, ext, tags }`
- `game.spaceholder.getIconLibraryCacheInfo()` → `{ root, hasIcons, count, at }`

Типичный сценарий использования (в любом новом месте)
1) Получить путь к готовой иконке
```js path=null start=null
const iconPath = await game.spaceholder.pickIcon({
  defaultColor: '#ffffff',
  title: 'Choose icon',
});
if (!iconPath) return;
```
2) Применить куда нужно (пример: любой документ с img)
```js path=null start=null
await someDoc.update({ img: iconPath });
```

Ограничения/примечания
- Сейчас поддерживается только `.svg`.
- При превью и при bake пытаемся убрать "фон-квадрат" (rect/path на весь viewBox) и затем перекрашиваем `fill`/`stroke`.

- Анатомии существ
  - AnatomyManager (module/anatomy-manager.mjs)
    - initialize() загружает реестр module/data/anatomy/registry.json и кэширует данные
    - loadAnatomy() достаёт JSON анатомии (например humanoid.json, quadruped.json), валидирует и кэширует
    - createActorAnatomy() формирует копию шаблона для актёра (maxHp с учётом коэффициента, currentHp из maxHp)
    - getAvailableAnatomies(), getAnatomyDisplayName(), reload(), getStats()
  - Данные: module/data/anatomy/registry.json описывает список доступных анатомий, категории и отключённые варианты (с префиксом "_")
  
- Модули глобальной карты находятся в module\helpers\global-map

- Стили
  - Источник: src/scss/** (компоненты, утилиты, глобальные стили)
  - Результат: css/spaceholder.css — подключается через system.json

Замечания по разработке в этом репозитории

- Проект специфичен для Foundry VTT: для проверки UI используется запуск Foundry; лежит в Data/systems/spaceholder, сборка CSS обновляет внешний вид листов
- README.md краткий: «Boilerplate fork for personal system development» — ориентируйтесь на текущую архитектуру как на персональную основу

Проектные правила (важно для Warp)

- Не делать push автоматически. Для публикации (commit/tag/push/release) владелец репо будет использовать скрипт `release.ps1` вручную.
- Версии: теги вида `v0.NN` (инкремент на 1). При релизе обновлять `system.json` (version/manifest/download) и создавать GitHub Release. Этот функционал включён в `release.ps1`.
- Установка/обновления Foundry: ориентируемся на манифест из последнего релиза — `https://github.com/Duugrim/spaceholder/releases/latest/download/system.json`.
  - В релиз прикреплять ассеты: `spaceholder.zip` и `system.json`. Этот функционал включён в `release.ps1`.
- Предпочтительный язык ответов для работы в проекте: русский

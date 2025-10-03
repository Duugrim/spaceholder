# Архитектура SpaceHolder (FoundryVTT)

Статус: актуально на 2025-10-03 22:05 UTC. Документ может содержать неточности и со временем устареть; не полагайтесь на него на 100%.

## Общее устройство
- Тип проекта: FoundryVTT System (manifest: `system.json`).
- Точка входа: `module/spaceholder.mjs` (подключается через `esmodules` в `system.json`).
- UI слой: классы листов (Application V2 + Handlebars) в `module/sheets` и шаблоны в `templates/`.
- Доменная логика: кастомные документы Actor/Item и система «анатомии» в `module/documents` и `module/anatomy-manager.mjs`.
- Данные и локализация: `templates/`, `lang/`, `module/data/anatomy/*.json`.
- Стили: SCSS в `src/scss`, сборка в `css/spaceholder.css` (Sass через `package.json` scripts).
- Внешние ассеты/библиотеки: `assets/`, `lib/`.

## Манифест и конфигурация
- `system.json`:
  - `id: spaceholder`, `styles: css/spaceholder.css`, `esmodules: module/spaceholder.mjs`.
  - Foundry compatibility: `minimum: 13`, `verified: "13"`.
  - Grid defaults и token-атрибуты: `primaryTokenAttribute: "health"`, `secondaryTokenAttribute: "power"`.
  - Языки: `en` (`lang/en.json`). URL/manifest/download — заглушки (для релизов потребуют обновления).
- `template.json`:
  - Определяет базовые схемы данных для Actor (`types: character, npc`) и Item (`types: item, feature, spell`).
  - Блок `system.health/power/physicalCapacities` задаёт структуру для дальнейших вычислений на уровне Actor.
- `package.json`:
  - Dev-инфраструктура только для стилей: `sass` компилирует `src/scss/spaceholder.scss` → `css/spaceholder.css`.
  - Версии: `package.json@2.1.0`, `system.json@1.0` (нормально: `package.json` служит для дев-сборки и не обязан совпадать).

## Точка входа и жизненный цикл
- `module/spaceholder.mjs`:
  - `Hooks.once('init')`: публикует API в `game.spaceholder`, конфигурирует `CONFIG.SPACEHOLDER`, задаёт инициативу, регистрирует кастомные `documentClass` (Actor, Item), регистрирует V2-листы для актёров/предметов, предзагружает шаблоны.
  - Handlebars helpers: `toLowerCase`, `multiply`, `join`, `lt/gt/eq`.
  - `Hooks.once('ready')`: инициализирует `anatomyManager` (загрузка реестра анатомий), регистрирует `hotbarDrop` для макросов предметов.
  - Макросы: `createItemMacro` и `rollItemMacro` для быстрого вызова бросков предметов.

## Документы (доменная логика)
- `module/documents/actor.mjs` (`SpaceHolderActor`):
  - Жизненный цикл: `prepareData/prepareDerivedData`; разветвление по типам (character/npc).
  - Механика «здоровья по частям тела»:
    - Источник истины: `system.health.bodyParts` (объект с частями, их `maxHp/currentHp`, `coverage`, `parent`, `tags`, `status`).
    - Расчёт общего здоровья (`totalHealth`) — сумма hp частей.
    - Генерация иерархии частей (`children`) по `parent`, сортировка по `coverage` для распределения попаданий.
    - Оценка статуса части по проценту hp.
  - Физические способности (`physicalCapacities`) в стиле RimWorld:
    - Рассчитываются из состояния частей тела, боли (`pain`) и крови (`blood`).
    - Используется целочисленная математика со шкалами `100/10000` для избежания ошибок плавающей точки.
  - Механики боя/урона:
    - `chanceHit`: рекурсивное распределение попадания по дочерним частям на основе `coverage`.
    - `performHit/applyBodyPartDamage`: уменьшение hp части, перерасчёт `totalHealth`, увеличение `pain`, расчёт `bleeding`; обновление через точечные пути в `this.update()`.
    - Расчёт pain/bleeding с учётом типа урона и тегов части (`brain`, `vital`, `manipulator`, `locomotion`, `sensory`, `extremity`), расчёты — на целых числах (scale).
  - Анатомия актёра:
    - `setAnatomy`/`changeAnatomyType`/`resetAnatomy` взаимодействуют с `anatomyManager`: загрузка пресета анатомии, установка `system.anatomy.type` и `system.health.bodyParts`, пересчёт `totalHealth`.
  - Данные для бросков:
    - `getRollData` копирует `system` и подготавливает удобные поля (например, `@str.mod`).
- `module/documents/item.mjs` (`SpaceHolderItem`):
  - Броски предметов: формула из `item.system.formula`, вывод в чат; `rollData` включает `actor.getRollData()` при наличии.

## Сервис управления анатомиями
- `module/anatomy-manager.mjs`:
  - `initialize()` загружает реестр `module/data/anatomy/registry.json` (через `fetch`), кэширует, выставляет `initialized`.
  - `getAvailableAnatomies()` — фильтрует отключённые и служебные ключи.
  - `loadAnatomy(id)` — загрузка JSON файла анатомии, валидация структуры, кэширование.
  - `createActorAnatomy(id, { healthMultiplier, overrides })` — готовит копию для актёра: `currentHp = maxHp` (с учётом множителя/оверрайдов).
  - `validateAnatomyStructure` — простая валидация полей (id, name, bodyParts, обязательные поля части, наличие корневой части).
  - API утилиты: `getAnatomyInfo`, `getAnatomyDisplayName` (через i18n ключ), `clearCache`, `reload`, `getStats`.

## UI слой: листы и шаблоны
- Листы (Application V2 + Handlebars):
  - Actor: `module/sheets/actor-sheet.mjs`
    - Базовый класс `SpaceHolderBaseActorSheet`: собирает context (`system`, `flags`, `config`), обогащает биографию, готовит эффекты, поддерживает актуальные данные здоровья.
    - Характеристики: автозаполнение модификаторов, интеграция с бросками.
    - Анатомия: извлечение доступных типов из `anatomyManager`, диалоги на переключение/сброс анатомии, toggle-кнопка в UI.
    - Здоровье: построение иерархии частей для отображения, маркировка повреждённых частей, синхронизация `blood/pain/physicalCapacities`.
    - Обработчики: создание/удаление предметов, клик по броскам, управление `Active Effects`, drag-and-drop в хотбар.
    - Табы: primary: `stats/health` (для персонажа), для NPC — свой шаблон и вкладки.
  - Item: `module/sheets/item-sheet.mjs`
    - Базовый класс `SpaceHolderBaseItemSheet`: вкладки `description/attributes/effects`, обогащение описания, управление эффектами.
    - Частные классы по типам — под разные шаблоны (`item`, `feature`, `spell`, `generic`).
- Шаблоны:
  - Actor: `templates/actor/actor-character-sheet.hbs` и `actor-npc-sheet.hbs` + partials в `templates/actor/parts` (`health`, `items`, `features`, `spells`, `effects`).
  - Item: `templates/item/*.hbs` + partials.
  - Предзагрузка partials — в `helpers/templates.mjs`.
- Локализация:
  - `lang/en.json`: ключи для способностей, физических способностей, подписей листов и эффектов.
  - Константы с i18n-ключами — в `helpers/config.mjs` (`SPACEHOLDER.*`).

## Стили и сборка
- SCSS структура:
  - `src/scss/spaceholder.scss` как корневой файл; подпапки `components`, `global`, `utils`.
- Сборка CSS:
  - Sass через `package.json` scripts (`build`, `watch`), вывод в `css/spaceholder.css`, который подключается в `system.json`.
  - Примечание: сборка SCSS не выполнялась в рамках данного документа.

## Данные и ресурсы
- Анатомии: `module/data/anatomy/{humanoid.json, quadruped.json, registry.json}`.
- Компендии: `packs/` (пока пусто, только `.gitattributes`).
- Медиа: `assets/anvil-impact.png`; background/thumbnail/media — используются в манифесте.
- Внешняя библиотека: `lib/some-lib/*` (подключения в коде на момент написания не обнаружено).

## Потоки данных и взаимодействия
- Инициализация:
  - `init`: регистрация документов/листов, конфиг, шаблоны.
  - `ready`: загрузка реестра анатомий, регистрация хотбар-макросов.
- Изменения анатомии:
  - UI → `anatomyManager` → загрузка шаблона → `Actor.setAnatomy` → обновление `system.health.bodyParts/totalHealth` → `prepareDerivedData` → пересчёт способностей/статусов.
- Урон и состояние:
  - `performHit/applyBodyPartDamage` → обновление части/`totalHealth` → `pain/bleeding` → `prepareDerivedData` → перерасчёт физических способностей и шока от боли.
- Отрисовка листов:
  - `_prepareContext/_onRender` собирают свежие данные, вкладки, обработчики; partials предзагружаются для быстрых рендеров.

## Особенности и практики
- Целочисленная арифметика вместо float: проценты/модификаторы в шкалах `100/10000` с явным округлением — снижает ошибки округления.
- Application V2: используются новые API Foundry для листов и шаблонов (`tabs/parts`, `HandlebarsApplicationMixin`).
- Расширяемость:
  - Добавление новых анатомий через `registry.json` + файл анатомии.
  - Добавление новых Item/Actor типов — через `template.json` + регистрация листов.
  - Handlebars helpers уже подготовлены, можно добавлять новые.

## Замеченные моменты внимания
- `system.json`: поля `url/bugs/manifest/download` — заглушки, для публикации их нужно заполнить.
- Версии: `system.json` и `package.json` различаются — это нормально (см. выше).
- `lib/some-lib` не подключён в манифесте/esmodules/styles; если планируется использование — потребуется добавить.

---
Авторы системы (по `system.json`): Asacolips, Lee Talman.

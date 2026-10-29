---
doc-type: reference
status: current
tags:
  - sh-code-doc/reference
  - sh-code-doc/status/current
---

# Связь с модулем Azimuth (`game.spaceholder.integration`)

Модуль **Azimuth** (`Data/modules/azimuth`, свой репозиторий: глобальная карта и 3D-рельеф, хронология, события, очки прогресса, тип «объект Azimuth») работает с системой как одно целое, хотя в системе его кода нет. Связь двусторонняя, у каждой стороны своя половина:

- **Система** даёт нейтральные точки расширения (реестры), в которые модуль добавляет то, что относится к интерфейсу системы: кнопки, раздел листа, типы актёров. Ещё она **спрашивает у модуля то, что принадлежит модулю**: где источники влияния и чей это журнал (`azimuth-link.mjs`).
- **Модуль** наполняет реестры системы (`scripts/integrations/` в модуле) и в мире SpaceHolder работает на системных фракциях.

Обе половины проверяют версию чужого API и при несовпадении не подключаются (ГМ видит предупреждение): система ждёт у модуля `game.azimuth.integrationApiVersion === 1`, модуль ждёт у системы `game.spaceholder.integration.apiVersion === 1`. Модуль без подключения работает сам по себе (свой тип фракции, свой блок у хотбара).

Код системы: `module/helpers/integration-registry.mjs` (чистые данные и функции, без Foundry), `module/helpers/azimuth-link.mjs` (половина системы), подключение — `spaceholder.mjs` (`game.spaceholder.integration` собирает `createIntegrationApi`, `CONFIG.SPACEHOLDER`; связь ставится на хук `setup`). Тесты: `node module/helpers/integration-registry.test.mjs`, `influence-manager.test.mjs`, `journal-check-integration.test.mjs`, `integration-templates.test.mjs`, `azimuth-link.test.mjs` (если модуль лежит рядом, прогоняет настоящий код обеих половин друг против друга), `module/documents/actor-create-dialog.test.mjs`. В модуле: `npm test`.

Провайдер, который бросил ошибку, пишется в консоль и пропускается: один пакет не ломает интерфейс системы. Повторная регистрация того же `id` заменяет предыдущую; регистрирующие функции возвращают функцию-отмену.

## Порядок загрузки

Скрипты системы грузятся раньше скриптов модулей, поэтому `init` системы идёт первым. Дальше: `init` модуля (профиль, тип актёров, API `game.azimuth`) → `setup` (модуль наполняет реестры системы, система подключает провайдеров) → отрисовка интерфейса → `ready`.

## Что в мире SpaceHolder делает модуль

- **Фракции — системные** (`faction`). Своего `azimuth.faction` модуль там не использует: фракции не теряются при выключении модуля. Привязка пользователей — `flags.spaceholder.factions`/`activeFaction`.
- Кнопки создания в шапке вкладки «Акторы» и панель фракций в настройках пользователя скрыты (в системе есть свои), модульный тип фракции скрыт из диалога создания, «Объект Azimuth» там есть.
- Очки прогресса системных фракций лежат во флагах `flags.azimuth.pp` (`modifier`, `spends`); блок очков модуль выводит разделом на листе фракции.
- Блок у хотбара один, системный; кнопки хронологии, очков, событий, переключатель влияния и счётчик очков добавляет модуль.
- Статус страниц для очков прогресса — из `journal-check` системы.

## Что можно подключить (реестры системы)

| Точка | Как | Что делает система |
| --- | --- | --- |
| Скрытые типы актёров | `CONFIG.SPACEHOLDER.hiddenActorTypes.add(type)` | `SpaceHolderActor.createDialog` не предлагает эти типы (сами актёры остаются). Если скрыть все предлагаемые типы, диалог не меняется |
| Указатель токена | `CONFIG.SPACEHOLDER.tokenPointerOffTypes.add(type)` | у токенов этого типа указатель по умолчанию выключен; флаг токена сильнее |
| Источники влияния | `integration.setInfluenceSourceProvider(provider)`, `integration.requestInfluenceRedraw({ reason?, delayMs? })` | менеджер берёт источники у провайдера; `null` убирает их (зон нет) |
| Раздел листа фракции | `integration.registerFactionSheetSection({ id, render, activate? })` | лист фракции вставляет разметку раздела внутрь своей формы и вызывает `activate` после каждой отрисовки |
| Кнопки и счётчики хотбара | `integration.registerHotbarFactionItems({ id, quickActions?, indicators? })`, `integration.requestHotbarFactionRender()` | блок фракции в хотбаре рисует кнопки (вместо пустого слота) и счётчики |
| Служебные журналы | `integration.registerServiceJournalPredicate({ id, test })`, `integration.registerJournalOperationMarker(key)` | `journal-check` не ведёт статусы у таких журналов и страниц, директория журналов прячет контейнеры и папки; изменения с зарегистрированным маркером в опциях не получают статус «черновик» |
| Статус страницы журнала | `integration.getJournalPageStatus(page)` → `'draft' \| 'proposed' \| 'approved' \| 'denied'` | отдаёт статус `journal-check` |

Всё это публикует `createIntegrationApi` (один объект `game.spaceholder.integration`), `hiddenActorTypes` и `tokenPointerOffTypes` те же объекты, что в `CONFIG.SPACEHOLDER`.

## Что система спрашивает у модуля (`game.azimuth`)

`azimuth-link.mjs` на `setup` проверяет, что модуль активен и его `integrationApiVersion` и функции на месте, и тогда:

- **Источники влияния**: `getInfluenceSources({ scene })`, `isInfluenceSourceToken(tokenDoc)`, `isInfluenceSourceActorChange(actor, change)` → провайдер менеджера зон.
- **Служебные журналы**: `isServiceJournal(doc)` → предикат `azimuth` реестра. Модуль отвечает «да» для папок и записей-контейнеров хронологии и событий и их страниц.

Модуль выставляет и поле `game.azimuth.influenceManager` (менеджер системы), по нему инспектор панели края карты показывает влияние в точке; вне SpaceHolder поля нет, колонка «Влияние» скрыта.

## Источники влияния

`provider = { collect({ scene, gridSize }), isSourceToken?(tokenDoc), isSourceActorChange?(actor, change) }`.

- `collect` возвращает массив `{ token?, position?, rangeCells, power = 1, faction }`: радиус в клетках сцены (менеджер переводит в пиксели), `faction` — UUID стороны, центр — по токену или из `position`. Источник без фракции или без центра отбрасывается.
- `isSourceToken` — создание, движение и удаление такого токена перерисовывает зоны (движение ждёт конца анимации). `isSourceActorChange` — такое изменение актёра перерисовывает зоны. Без предикатов хуки менеджера ничего не перерисовывают, провайдер сам зовёт `requestInfluenceRedraw`.
- Цвет стороны менеджер берёт у актёра типа `faction` по `faction`: `system.fColor`.
- Зоны показывает и прячет только вызывающий (`influenceManager.enable/disable/toggle`); менеджер сам не включается, без провайдера зон нет.

## Раздел листа фракции

- `render({ actor, sheet, context, editable })` → строка разметки или `null` (ничего не показывать). Раздел оборачивается в `<div class="sh-faction-extra" data-faction-section="<id>">` внутри формы, поэтому поля с именами документа (`flags.pkg.x`) сохраняются самим листом.
- `activate(container, { actor, sheet, editable })` — вешает обработчики на элементы раздела; `container` — его элемент. Вызывается и у листа только для чтения: решайте по `editable`.
- Не вешайте на элементы раздела `data-action`: лист обрабатывает их сам.

## Хотбар

- `quickActions(ctx)` → `[{ key, icon, label, disabled?, active?, onClick?(event, button) }]`; `indicators(ctx)` → `[{ key, text, tooltip? }]`. `ctx` — `{ user, isGM, active, allowedUuids }` (`active` — выбранная фракция `{ uuid, name, img }`).
- Кнопка получает `data-action="ext:<id провайдера>:<key>"`, клик ведёт к её `onClick`. Собственная кнопка у системы одна («журнал изменений»), плюс пустой слот, который кнопки пакетов заменяют. Блок показывается только пользователю, у которого есть фракции.

## Служебные журналы

- `test(doc)` получает `JournalEntry`, `JournalEntryPage` или `Folder`; `true` — документ принадлежит пакету. Страница считается служебной и тогда, когда служебна её запись (проверяет реестр, пакету это знать не обязательно).
- Маркер — имя опции операции (`{ pkgJournalCheck: true }` при `create`/`update`/`delete`): с ним `journal-check` не ставит «черновик» и не пересчитывает статус записи. Модуль ставит `azimuthJournalCheck`.
- Своих проверок флагов хронологии и событий в системе нет: что служебное, решает пакет.

---
doc-type: reference
status: verify
note: "MVP; упоминания Foundry v13 — сверить с текущим API движения/боевки."
tags:
  - sh-code-doc/reference
  - sh-code-doc/status/verify
---

# Actions System (MVP)

Этот документ описывает новую подсистему **Действий** (Actions) в SpaceHolder.

## Цели MVP

- Единый слой, который позволяет **любой сущности** (Actor/Item/система) добавить актёру действие.
- Возможность **фильтровать действия по контексту** (например, скрывать в бою).
- Базовый ресурс **Очки Действия (ОД)** у персонажа (Character) и списание при выполнении действий.
- Боевая интеграция: таблицы действий по участнику/раунду, стороны конфликта, события боя.
- Движение через core Foundry v13 (`TokenDocument.movement`) с автоматическим логированием в бою.

## Что MVP не делает

- Полные реплеи боя (есть только foundation для перемотки/undo).
- Жёсткие ограничения на действия при нехватке ОД.

## Данные (schema)

Источник истины — `template.json`.

- `Actor.character.system.gFaction`: постоянная фракция персонажа (UUID Actor(faction)).
- `Actor.character.system.speed`: скорость (если `<= 0`, действие «Движение» недоступно).
- `Actor.character.system.actions[]`: кастомные действия персонажа.
- `Item.*.system.actions[]`: кастомные действия предмета.
- `Item.item.system.defaultActions`: флаги видимости стандартных «Надеть/Снять».

## Контракт действия (runtime)

Сервис строит список `ActionDescriptor` и отдаёт его UI/панелям.

Ключевые поля:

- `id`: стабильный идентификатор действия (используется UI).
- `label`: отображаемое имя (i18n или user-defined).
- `apCost`: стоимость в ОД (для большинства действий списывается сразу; для движения — при confirm).
- `showInCombat`, `showInQuickbar`: фильтры видимости. `showInQuickbar === false` — действие не показывается в быстром HUD токена (лист персонажа его не читает).
- `interactMenuOnly`: только в меню ПКМ предмета (`openItemInteractMenu`), не в списках действий.
- `uiOnly`: UI-переключатель, а не игровое действие — `executeActorAction` вызывает `run` без ОД, старта хода и журнала (пример: «быстрый доступ»).
- `previewApCost`: стоимость для показа в меню, когда `run` сам списывает ОД (у дескриптора `apCost` = 0; пример: смена режима стрельбы).
- `visible(ctx)`, `enabled(ctx)`, `disabledReason(ctx)`: условия доступности.
- `run(ctx)`: выполнение.

Реализация: `module/helpers/actions/action-service.mjs`.

## Источники действий (providers в MVP)

Сейчас сервис собирает действия из:

- **Base actor actions**: `Движение` для `character` при `speed > 0`.
- **Предмет (тип `item`)**: стандартные `Надеть/Снять` только если `item.system.itemTags.isArmor === true`, в зависимости от `item.system.equipped`.
- **Custom actions**: `actor.system.actions[]` и `item.system.actions[]` (для предметов — только при `item.system.itemTags.isActions === true`).
- **Оружие v3**: только «Взаимодействовать» (`weaponInteract`, `showInQuickbar: false` — дубль ПКМ). Атака **не является действием**: это возможность предмета `item.canAttack` / `item.attack({ token })` (`module/helpers/weapon/attack-chain.mjs`: `canAttackWithItem`, `attackWithItem`, `previewItemAttack`). Атака идёт активными линией/режимом из `system.weapon.state`.
- **Меню ПКМ предмета** дополнительно содержит группу «Режим стрельбы» (`switchWeaponMode`: явная смена линии/режима с ценами exit/enter, без прицеливания) и переключатель `system.quickAccess` (оружие не в руках получает карточку в быстром HUD).

Избранное: `flags.spaceholder.favoriteActionIds` — `getFavoriteActionIds(actor)` / `toggleFavoriteAction(actor, actionId)` (лист и HUD).

## Movement tracking (боевое движение)

Реализация: `module/helpers/actions/movement-manager.mjs` + `module/helpers/combat/combat-session-manager.mjs`.

Lifecycle:

1. Core Foundry завершает перемещение и заполняет `tokenDocument.movement`.
2. `MovementManager` ловит `updateToken` при `movement.recorded && state === 'completed'`. Стоимость одного перетаскивания: в первую очередь **`movement.passed`** (сегмент только что завершённого пути); иначе `movement.history.recorded`, затем суммарный `movement.history` (часто кумулятивно за цепочку ходов — только запасной вариант). Пересчёта по сетке нет. Если ядро не сообщило ни `cost`, ни `distance` (> 0), запись в таблицу боя **не создаётся**. Координаты для undo — `movement.origin` / `movement.destination`, с запасным `from` из `preUpdateToken`, если `origin` нет.
3. В бою движение автоматически превращается в `move`-событие и попадает в action table участника.
4. Для записи движения можно выставить флаг «Вынужденное движение», тогда её AP cost = 0.
5. Undo строится через action events (`action.undo`) и inverse-данные.

## Интеграция в UI

- **Character sheet**: вывод ОД/скорости, доступных действий и редактора кастомных действий.\n  Файл: `module/sheets/actor-sheet.mjs` + partial `templates/actor/parts/actor-actions.hbs`.
- **Item sheets**: вкладка `Теги` (`system.itemTags`) и условные вкладки; `Actions` с редактором `system.actions[]` при включённом теге «Действия».\n  Файл: `module/sheets/item-sheet.mjs` + `templates/item/item-wearable-sheet.hbs` + partial `templates/item/parts/item-actions.hbs`.

## Публичный API

В `module/spaceholder.mjs` экспортировано в `game.spaceholder`:

- `collectActorActions(actor, ctx?)`
- `executeActorAction(actor, action, ctx?)`
- `runActorAction(actorUuid, actionId)` — выполнить действие по id (макросы хотбара; токен — выбранный токен актёра или первый активный). Макрос создаётся перетаскиванием чипа действия из быстрого HUD на хотбар (`ACTION_DRAG_TYPE`, `createActorActionMacro`).
- `combatSessionManager` (turn/side/action tables/undo; events applied on `Combat` flags)


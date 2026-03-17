# Actions System (MVP)

Этот документ описывает новую подсистему **Действий** (Actions) в SpaceHolder.

## Цели MVP

- Единый слой, который позволяет **любой сущности** (Actor/Item/система) добавить актёру действие.
- Возможность **фильтровать действия по контексту** (например, скрывать в бою).
- Базовый ресурс **Очки Действия (ОД)** у персонажа (Character) и списание при выполнении действий.
- Отдельный режим **Движение**, который считает дистанцию автоматически по перемещению токена и списывает ОД при подтверждении.

## Что MVP не делает

- Автоматическое восстановление ОД по раундам/ходам.
- Полноценную панель быстрых действий (быстрые действия сейчас только контракт/флаги).

## Данные (schema)

Источник истины — `template.json`.

- `Actor.character.system.actionPoints.value/max`: ОД персонажа (дефолт 100/100).
- `Actor.character.system.speed`: скорость (если `<= 0`, действие «Движение» недоступно).
- `Actor.character.system.actions[]`: кастомные действия персонажа.
- `Item.*.system.actions[]`: кастомные действия предмета.
- `Item.wearable.system.defaultActions`: флаги видимости стандартных «Надеть/Снять».

## Контракт действия (runtime)

Сервис строит список `ActionDescriptor` и отдаёт его UI/панелям.

Ключевые поля:

- `id`: стабильный идентификатор действия (используется UI).
- `label`: отображаемое имя (i18n или user-defined).
- `apCost`: стоимость в ОД (для большинства действий списывается сразу; для движения — при confirm).
- `showInCombat`, `showInQuickbar`: фильтры видимости.
- `visible(ctx)`, `enabled(ctx)`, `disabledReason(ctx)`: условия доступности.
- `run(ctx)`: выполнение.

Реализация: `module/helpers/actions/action-service.mjs`.

## Источники действий (providers в MVP)

Сейчас сервис собирает действия из:

- **Base actor actions**: `Движение` для `character` при `speed > 0`.
- **Wearable**: стандартные `Надеть/Снять` в зависимости от `item.system.equipped`.
- **Custom actions**: `actor.system.actions[]` и `item.system.actions[]`.

## Movement Mode (режим «Движение»)

Реализация: `module/helpers/actions/movement-manager.mjs`.

Lifecycle:

1. Пользователь запускает действие `Движение` из листа персонажа.
2. Менеджер фиксирует стартовую точку и начинает слушать `preUpdateToken`.
3. При перемещении токена накапливается дистанция (в единицах сцены) и рисуется overlay-траектория.
4. `Confirm` списывает ОД: `ceil(distance / speed)` и завершает режим.
5. `Cancel` пытается вернуть токен в стартовую точку и завершает режим.
6. `ESC`/`ПКМ` — отмена.

Примечание: менеджер рассчитан на **MVP без боя/раундов** — он не трогает `Combat` и очередность.

## Интеграция в UI

- **Character sheet**: вывод ОД/скорости, доступных действий и редактора кастомных действий.\n  Файл: `module/sheets/actor-sheet.mjs` + partial `templates/actor/parts/actor-actions.hbs`.
- **Item sheets**: вкладка `Actions` с редактором `system.actions[]`.\n  Файл: `module/sheets/item-sheet.mjs` + partial `templates/item/parts/item-actions.hbs`.

## Публичный API

В `module/spaceholder.mjs` экспортировано в `game.spaceholder`:

- `collectActorActions(actor, ctx?)`
- `executeActorAction(actor, action, ctx?)`
- `movementManager` (start/confirm/cancel)


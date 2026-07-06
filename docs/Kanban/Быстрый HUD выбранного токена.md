# Быстрый HUD выбранного токена

Панель над макро-рядом хотбара: имя/иконка токена, ОД, чипы удерживаемого оружия, быстрые действия.

## Реализация

- `module/helpers/token-quick-hud.mjs` — резолв токена, сбор действий, инжект в `#hotbar`
- `templates/hud/token-quick-hud.hbs`
- `src/scss/components/_token-quick-hud.scss`

## Логика токена

1. Последний `canvas.tokens.controlled` с actor, если пользователь владеет токеном (ГМ — всегда).
2. Иначе fallback: первый активный токен `game.user.character` на сцене.
3. Иначе у ГМа fallback на последний выбранный токен в сессии (если ещё на сцене).
4. Иначе пустая панель (не скрывается).

Панель — `position: fixed` над хотбаром, не сдвигает `#hotbar`.

## Действия

- `collectActorActions` / `executeActorAction` с явным `tokenDoc`
- Сначала избранные (`flags.spaceholder.favoriteActionIds`), затем `showInQuickbar !== false`, максимум 10

## Проверить в Foundry

- Игрок, выбран свой токен: действия и ОД своего персонажа, weapon v3 action запускается с правильным `tokenDoc`
- Игрок выбрал чужой токен: панель показывает fallback на `game.user.character`, не чужие действия
- ГМ выбрал любой токен: действия выбранного токена
- Нет выбора и нет токена персонажа на сцене: панель скрыта, хотбар не ломается
- Global map сцена: `#spaceholder-globalmap-edge-ui` и hotbar faction UI кликабельны, новая панель не перекрывает flyout
- Неактивные global map кнопки (если замечены): проверить `flags.spaceholder.isGlobalMap`, GM-only flyout, закрытый flyout (`pointer-events: none`), sidebar `controls.globalmap`

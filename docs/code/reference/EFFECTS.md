---
doc-type: reference
status: current
tags:
  - sh-code-doc/reference
  - sh-code-doc/status/current
---

# Эффекты и статусы

Как в системе работают ActiveEffect (Foundry 14) и где лежат статусы SpaceHolder. Сверено с исходниками `client/documents/active-effect.mjs`, `client/documents/actor.mjs`, `common/data/active-effect.mjs` (Foundry 14.353) и проверено на настоящей модели данных в Node.

## Что это

ActiveEffect — встроенный документ актёра или предмета (`actor.effects`, `item.effects`). Он делает три вещи, любую можно не использовать:

- **Меняет данные** актёра: список `system.changes`.
- **Держится какое-то время**: `duration` + `start`.
- **Несёт статусы**: `statuses` (набор id), по ним код узнаёт «персонаж ослеплён» через `actor.statuses.has(id)`.

| Поле | Смысл |
|---|---|
| `name`, `img`, `description`, `tint` | вид |
| `type` | подтип; в системе только `base` (модель `ActiveEffectTypeDataModel`, регистрируется в `register-active-effect-models.mjs`) |
| `system.changes[]` | `{ key, type, value, phase, priority }` — что менять |
| `disabled` | выключен, но лежит на актёре |
| `duration` | `{ value, units, expiry, expired }`; `value: null` — без срока |
| `start` | `{ time, combat, combatant, initiative, round, turn }`; ставится при создании на актёре |
| `statuses` | id статусов (`Set`) |
| `showIcon` | иконка на токене: 0 никогда, 1 только временные (по умолчанию), 2 всегда |
| `transfer` | у эффекта на предмете: действует на владельца предмета |
| `origin` | UUID источника |
| `flags` | произвольные данные (`flags.spaceholder.*`) |

## Как эффект меняет данные

`Actor#applyActiveEffects(phase)` идёт в два прохода за один цикл подготовки данных:

1. `initial` — внутри `prepareEmbeddedDocuments`: **после** `prepareBaseData`, **до** `prepareDerivedData`. Сюда ложатся изменения исходных полей (`system.params.*`, `system.abilities.*.value`, `system.hitResistanceMod`): производные считаются уже от них.
2. `final` — в конце `prepareData`. Нужен, если меняется то, что система считает в `prepareDerivedData`: иначе расчёт перезапишет изменение.

Внутри прохода изменения сортируются по `priority` (по умолчанию от типа: `custom` 0, `multiply` 10, `add`/`subtract` 20, `downgrade` 30, `upgrade` 40, `override` 50).

Типы изменений: `add`, `subtract`, `multiply`, `override`, `upgrade` (взять большее), `downgrade` (взять меньшее), `custom.N` (обрабатывает хук `applyActiveEffect`).

- `key` — путь от актёра: `system.params.gravity`. Префикс `token.` меняет данные токена, а не актёра.
- `value` — число, строка, булево; строка с `@abilities.str.value` подставляет данные из `actor.getRollData()`.
- Данные актёров в системе описаны в `template.json`, а не моделью, поэтому типа поля у Foundry нет: он выводит его из текущего значения (число — складывает как число).

## Срок жизни

- `duration.units`: `seconds, minutes, hours, days, months, years` (мировое время) или `rounds, turns` (бой).
- `duration.expiry`: когда эффект истекает после выхода срока: `turnStart`, `turnEnd`, `roundStart`, `roundEnd`, `combatStart`, `combatEnd`. Если задано число, а `expiry` нет — `turnStart`.
- Истечение разбирает `ActiveEffect.registry` на клиенте активного ГМа. По умолчанию (`CONFIG.ActiveEffect.expiryAction = 'update'`) эффект остаётся с `duration.expired = true` и не применяется; `'delete'` — удаляет.
- Пакеты могут объявить свои события истечения: `CONFIG.ActiveEffect.expiryEvents` + вызов `ActiveEffect.registry.refresh(event)`.
- «Временный» (`effect.isTemporary`) — есть срок или `expiry`. По умолчанию иконку на токене дают только временные эффекты (`actor.temporaryEffects` — их список).

## Статусы

Статус — запись в `CONFIG.statusEffects` (массив, к которому можно обращаться по id). Повесить статус — создать на актёре обычный эффект с `statuses: [id]`.

- `actor.toggleStatusEffect(id, { active?, overlay? })` — повесить, снять или переключить. Без статического `_id` ищет эффекты, у которых это единственный статус.
- `actor.statuses.has(id)` — висит ли статус (набор собирается на первом проходе, из всех активных эффектов, включая предметы).
- Запись статуса — это заготовка эффекта: `name` (ключ локализации), `img`, `order`, `hud` (`false` или `{ actorTypes }`), плюс любые поля эффекта (`system.changes`, `duration`, `flags`, `_id`). При применении она копируется в эффект; статус из каталога всегда показывает иконку на токене (`showIcon = 2`).
- Токен-HUD (правый клик по токену → иконка статусов) показывает записи с `hud !== false`, сортирует по `order`, затем по названию, и вешает статус на `token.actor`: у токена без связи с актёром статус живёт только на этом токене.

### Статусы системы

Живут в `module/helpers/status-effects.mjs` (`SPACEHOLDER_STATUS_EFFECTS`, `STATUS_IDS`), регистрируются на `init` (`registerSpaceholderStatusEffects`). Названия — `SPACEHOLDER.Effect.Statuses.<id>` в `lang/*.json`. Чтобы добавить статус: запись в `SPACEHOLDER_STATUS_EFFECTS`, id в `STATUS_IDS`, ключ в оба `lang`. Порядок в списке — порядок в токен-HUD. Все четыре — только для `character` и `npc`.

| id | Название | Сопротивление попаданию | Вешается | Снимается |
|---|---|---|---|---|
| `combatReady` | Боеготовность | 1 | в начале хода, если нет и не запрещено; руками | концом боя; появлением `dead` / `unconscious` |
| `moving` | Движется | 2 | передвижением токена в бою; руками | другим действием (не перемещением); началом нового раунда; концом боя |
| `cover` | В укрытии | 3 | руками | перемещением токена |
| `hidden` | Скрыт за укрытием | 5 | руками | перемещением токена |

Сопротивление берёт `ShotManager._hitResistanceFor` из `actor.statuses`: максимум по висящим статусам (`HIT_RESISTANCE_STATES` в `shot-confidence.mjs`, ключи — id статусов), плюс `system.hitResistanceMod`. Числа складывать нельзя: поэтому состояния — статусы без `system.changes`, а плоские поправки — отдельные эффекты на `hitResistanceMod`.

**Два правила в записи статуса** (читаются из реестра в момент события, поэтому пакет может дополнить их на `CONFIG.statusEffects[id]`):

- `blockedBy` — id статусов, которые запрещают этот: пока один из них висит, статус не вешается (ни автоматикой, ни руками через токен-HUD: `preCreateActiveEffect` отменяет создание с предупреждением), а когда появляется — снимается. У `combatReady`: `dead`, `unconscious`. Новый запрет — строка в списке.
- `endOn` — события `STATUS_EVENTS`, после которых статус снимается: `move` (позиция токена), `turn` (поворот токена), `action` (действие в бою, кроме перемещения: пока любое, какие именно прерывают движение — решит карточка «Теги действий»), `roundStart` (новый логический раунд), `combatEnd` (бой закончен или участник из него вышел). Эффект, который не статус (например «Выжидание» с предмета), может нести свой список в `flags.spaceholder.endOn`.

Чистые правила (`activeBlockers`, `endEventsOf`, `statusFitsActorType`, `tokenChangeEvents`) — в `status-effects.mjs`, проводка к хукам — в `module/helpers/status-lifecycle.mjs` (`installStatusLifecycle` на `ready`):

| Хук | Кто делает | Что |
|---|---|---|
| `spaceholder.combatTurnPicked` (начало хода, `CombatSessionManager.pickTurn`) | клиент ГМа, выполнивший выбор | вешает `combatReady` |
| `spaceholder.combatRoundStarted` (`_flushRoundBoundary`, новый раунд) | клиент ГМа | снимает статусы с `roundStart` у всех участников |
| `deleteCombat`, `deleteCombatant` | активный ГМ | снимает статусы с `combatEnd` |
| `createActiveEffect` | активный ГМ | снимает статусы, которые запрещены появившимся |
| `preCreateActiveEffect` | клиент, создающий эффект | отменяет создание запрещённого статуса |
| `updateToken` (`x`/`y`, `rotation` или `flags.spaceholder.tokenpointerDirection`) | клиент, двигавший токен | снимает статусы с `move` / `turn`; движение в бою вешает `moving` |
| `spaceholder.combatActionTaken` (`announceCombatAction` в `combat-action-log.mjs`: `logCombatAction` и выстрел) | клиент актёра, совершившего действие | снимает статусы с `action` |

Foundry 14 при перемещении сам поворачивает токен по направлению пути (если `rotation` не задан явно), поэтому обычный шаг несёт и событие `turn`. Всё идемпотентно: повторный вызов ничего не делает. Тесты: `node module/helpers/status-effects.test.mjs`, `node module/helpers/status-lifecycle.test.mjs`.

Статусы Foundry (`dead`, `unconscious`, `bleeding`, `poison`, …) остаются в списке. Автоматику со статусами уже делает `actor-death.mjs`: ставит `dead` и «при смерти» (`unconscious`) и ведёт флаги `flags.spaceholder.autoDead` / `autoDying`, чтобы снимать только то, что поставил сам, а не руками ГМа. Для новых автоматических статусов — тот же приём.

## Как добавлять и менять

**Руками.** Статус — правый клик по токену → иконка статусов. Произвольный эффект — вкладка «Эффекты» листа актёра или предмета: «Новый» создаёт пустой эффект (`module/helpers/effects.mjs`, `onManageActiveEffect`), «Изменить» открывает лист эффекта Foundry, переключатель выключает, корзина удаляет.

**Кодом.**

```js
// Статус
await actor.toggleStatusEffect('combatReady', { active: true });   // повесить
await actor.toggleStatusEffect('combatReady', { active: false });  // снять
actor.statuses.has('combatReady');

// Эффект с изменением и сроком
const [effect] = await actor.createEmbeddedDocuments('ActiveEffect', [{
  name: 'Низкая гравитация',
  img: 'icons/svg/wingfoot.svg',
  origin: actor.uuid,
  duration: { value: 3, units: 'rounds' },
  system: { changes: [{ key: 'system.params.gravity', type: 'override', value: 0.38 }] },
}]);

// Изменить: массив changes заменяется целиком
await effect.update({ 'system.changes': [{ key: 'system.params.gravity', type: 'override', value: 0.165 }] });
await effect.update({ disabled: true });
await effect.delete();
```

Эффект на предмете с `transfer: true` действует на владельца, **пока предмет лежит у него** (не только когда надет): `allApplicableEffects()` не смотрит на `equipped`.

Права: создавать и удалять эффект на актёре может его владелец (OWNER); эффект вне актёра — только ГМ. Игрок не может повесить эффект на чужой токен: для этого нужно действие с правами ГМа (`game.spaceholder.gmActions`, `GM_ACTIONS.md`); обработчика для эффектов там пока нет.

## Что уже связано с эффектами

- `system.hitResistanceMod` — плоская поправка сопротивления попаданию; читает `shot-confidence.mjs` (`SHOOTING_SYSTEM.md`).
- `system.params.{gravity, awarenessMult, willMult, turnStarts}`, `system.abilities.*.value`, `system.hitboxScale` — поля, которые эффекты уже могут менять (`DERIVED_STATS.md`).
- Параллельный механизм: модификаторы надетой одежды (`system.modifiers`, `Actor#_applyWearableModifiers`) складывают те же поля, но только `add` и только у надетых предметов.
- `ability-scale-migration.mjs` переводит `system.abilities.*` в изменениях эффектов на шкалу 100.
- Быстрый HUD (`token-quick-hud.mjs`, `_collectEffectIcons`) показывает **только временные** эффекты: статус без срока там не виден (на токене и на листе — виден).

## Ловушки

- `SpaceHolderActor#prepareBaseData` обязан вызывать `super`: там `_clearData`, без него `applyActiveEffects` падает.
- Изменения лежат в `system.changes` и называются `type` (строка), а не `changes[].mode` (число): старые данные Foundry мигрирует сам (проверено: `{ mode: 2, value: '1' }` → `{ type: 'add', value: 1 }`), так же `duration.rounds: 1` → `{ value: 1, units: 'rounds', expiry: 'turnStart' }`. Кнопка «Новый» в листе пока создаёт временный эффект по старой форме (`'duration.rounds'`) — работает через эту миграцию.
- У нового эффекта на актёре `transfer` принудительно `false`; на предмете — `true`.
- Эффект по умолчанию (`showIcon = 1`) без срока иконки на токене не имеет; статусы из каталога имеют.
- `phase: 'initial'` для вычисляемых полей бесполезен: пересчитает `prepareDerivedData`. Нужен `final`.

---
name: Decouple combat.round + GM queue
overview: Логический раунд в combatState без инкремента Combat.round; плюс очередь действий, требующих ГМа, с ожиданием появления активного ГМа вместо немедленного провала.
todos:
  - id: endturn-flush
    content: "endTurn: убрать combat.update(round+1); инкремент state.round; GM setFlag + await _flushRoundBoundary; поправить nextSide в return"
  - id: flush-round-source
    content: "_flushRoundBoundary: не синхронизировать state.round с combat.round; один источник инкремента (согласовать с endTurn)"
  - id: hook-display
    content: "_onUpdateCombat: убрать реакцию на changes.round; _displayRound и activeTurn.round → state.round; пройти остальные combat.round в файле"
  - id: optional-turn0
    content: "При необходимости: combat.update({ turn: 0 }) без round на исчерпании"
  - id: hide-round-ui
    content: "Скрыть кнопки смены раунда в renderCombatTracker +/или SCSS (селекторы проверить на v13.350)"
  - id: docs-combat
    content: "docs/COMBAT_SYSTEM_V1.md: логический раунд, отказ от инкремента Combat.round"
  - id: gm-wait-queue
    content: "Очередь/ретраи для действий через сокет: при отсутствии ответа ГМа не проваливать — ждать активного ГМа и переотправлять"
---

# Логический раунд без `Combat.round` + ожидание ГМа

## Часть A — декуплинг раунда (как ранее)

- При исчерпании раунда **не** вызывать `combat.update({ round: +1 })`; увеличивать только `flags.spaceholder.combatState.round` и вызывать `_flushRoundBoundary` напрямую из `endTurn` (GM).
- `_onUpdateCombat` не реагировать на `changes.round` для flush.
- `_displayRound` и связанная логика AP — опираться на **`state.round`**, не на `combat.round`.
- Скрыть штатные кнопки смены раунда в трекере (расширить `_hideInitiativeControls` / SCSS).
- Документация в `docs/COMBAT_SYSTEM_V1.md`.

Детали и риски — как в обсуждении (миграция старых боёв, опционально `turn: 0` без `round`).

## Часть B — очередь и ожидание ГМа (новое требование)

**Цель:** действия, которые сейчас идут через сокет к ГМу (`endTurn`, `pickTurn`, `setSide`, `appendEvent` с клиента и т.д.), при недоступности ГМа **не завершаются ошибкой**, а **остаются в очереди** и **повторяются**, пока не появится хотя бы один **активный** пользователь с правами ГМ.

### Текущее состояние в коде

- Уже есть **outbox** в `localStorage` и `_flushOutbox` для событий: при неудаче `appendEvent` по сокету элемент остаётся, ретрай через `_scheduleOutboxFlush(2000)` ([`combat-session-manager.mjs`](module/helpers/combat/combat-session-manager.mjs) ~152–176).
- `_requestViaSocket` при таймауте или ошибке emit **сразу reject** (~192–216) — любые `await` на клиенте падают, если ГМ не ответил.

### Предлагаемая модель

1. **Проверка «есть ли ГМ онлайн»**  
   Использовать API Foundry для активных пользователей с ролью GM (например, перебор `game.users` с учётом `active` / доступности получателя сокета). Точную проверку зафиксировать по версии v13 в коде.

2. **Два уровня поведения**  
   - **Outbox** (уже есть): продолжить/усилить — при отсутствии ГМа не полагаться только на короткий таймаут сокета; периодический flush с интервалом, пока есть pending.  
   - **RPC-запросы** (`endTurn`, `pickTurn`, `setSide`, …): при `reject` по таймауту или при известной «нет получателя» ситуации **класть операцию в ту же или отдельную persistent queue** (тип действия + payload + request metadata) и **не отклонять пользовательский поток** как фатальную ошибку — либо `resolve({ ok: false, queued: true })`, либо долгоживущий Promise, который резолвится, когда ГМ обработает очередь (продуктовое решение выбрать при реализации).

3. **Триггеры повторной отправки**  
   - Существующий таймер outbox + увеличенный/адаптивный backoff.  
   - `Hooks.on("userConnected")` / смена активности пользователя — при появлении GM вызвать `_flushOutbox()` и дрен очереди RPC.  
   - Опционально: при фокусе окна / `document.visibilitychange` — один retry.

4. **UX**  
   - Уведомление `ui.notifications.info` при постановке в очередь («Ожидание ГМа…») и при успешной отработке — по желанию, i18n.

5. **Ограничения**  
   - Если ГМ **никогда** не зайдёт, запрос остаётся в очереди — в плане заложить опциональный потолок попыток или кнопку «отмена» позже, не обязательно в первой итерации.

### Файлы

- Основная реализация: [`module/helpers/combat/combat-session-manager.mjs`](module/helpers/combat/combat-session-manager.mjs) (`_requestViaSocket`, `_flushOutbox`, установка хуков при `ready`, обработчики вызовов `endTurn`/`pickTurn` с клиента).

### Зависимость от части A

Прямой вызов `_flushRoundBoundary` из `endTurn` на **GM** не меняет потребность в очереди: **игрок** по-прежнему шлёт `endTurn` через сокет — очередь как раз для этого сценария «ГМ оффлайн».

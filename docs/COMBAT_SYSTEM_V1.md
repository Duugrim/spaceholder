# Combat System V1

This document describes the implemented V1 combat architecture for SpaceHolder.

## Goals

- Apply combat events to runtime state (flags on the `Combat` document) as they occur.
- Use a hybrid multi-writer model: initiator produces an event, GM applies it authoritatively (including via socket for non-GM clients).
- Support popcorn initiative with side alternation and GM override.
- Track AP as `DEX * INT` with action-table spend per round.
- Track movement from Foundry v13 core movement history.
- Support undo scaffolding via event effects/inverse metadata.

## Main module

- `module/helpers/combat/combat-session-manager.mjs`

This manager owns:

- combat lifecycle hooks (`combatStart`, `updateCombat`, `deleteCombat`)
- socket relay (`spaceholder.combatLog`) for client→GM requests (events and related combat actions)
- persistent outbox on clients (`localStorage`) for retry/ACK
- runtime state and action tables in `Combat.flags.spaceholder.*` (no separate world-folder combat journal)
- tracker panel UI and row controls (change side, undo, forced move)

Combat events are not written to world data files; only `Combat` flags and the client outbox apply.

## Event schema (v1)

```json
{
  "schema": 1,
  "eventId": "abc123",
  "combatId": "k8dE...",
  "type": "move",
  "meta": {
    "createdAt": "2026-03-18T10:31:00.000Z",
    "byUserId": "userId"
  },
  "actor": { "id": "actorId", "uuid": "Actor.x" },
  "combatant": { "id": "combatantId", "tokenUuid": "Scene.x.Token.y" },
  "context": { "round": 2, "side": "disp:friendly" },
  "data": { "baseApCost": 20, "apCost": 15, "movementId": "m1" },
  "effects": [],
  "inverse": []
}
```

## Side resolution order

1. `Combatant.flags.spaceholder.combatSide`
2. `Actor.system.gFaction`
3. `Token.disposition` -> `disp:friendly|neutral|hostile|secret`

## Side order in the tracker and turn queue

Popcorn / side alternation uses a **fixed order of `sideId` values**, independent of encounter list order or `Object.keys` iteration:

1. `disp:friendly`
2. `disp:neutral`
3. `disp:hostile`
4. `disp:secret`
5. All other sides (faction ids, custom strings) **sorted alphabetically** (case-insensitive `localeCompare`).

When advancing the active side (`endTurn`), the next side is the next entry in this sorted ring that still has **at least one combatant** with `startedTurns < turnStarts` for the current round. Sides with no remaining “starts” are skipped. After a **round boundary** (`Combat.round` changes), `currentSide` is reset to the **first** side in that order that still has remaining starts (after counters are cleared, that is typically the first side that has any combatant).

Combat tracker **folder headers** are rendered in this same order.

## Turn pick (official turn vs spending AP)

Spending AP on actions or movement **does not** start an official turn anymore. The runtime flag `flags.spaceholder.combatState.activeTurn` is advanced only when a turn is **picked**:

- After `endTurn` (or round flush), if the new `currentSide` has **at least one** combatant with remaining starts, `combatState.turnPick` is set to `{ active: true, sideId, eligibleCombatantIds }` — including when there is only one eligible combatant (player still confirms via pick / overlay).
- **GM** may pick any eligible combatant on the active side. **Players** may pick only a combatant whose token they **own** (`OWNER`). Requests go through the existing combat socket (`pickTurn`); the GM applies the result.
- **Token overlay** (`module/helpers/combat/turn-pick-overlay.mjs`): on the **viewed scene only**, eligible tokens get a rotating segmented ring (segment count = remaining starts for that combatant; color from side). Click triggers `pickTurn` when allowed.

Off-turn actions are still logged into the action table under `turnStartIndex: 0` for that round (`data.offTurn: true` on the stored row payload) until an official pick increments `startedTurns` for that combatant.

## AP rules

- `maxAP = floor(DEX * INT)`
- spent AP = sum of non-ignored action costs in current round table
- value shown as `maxAP - spent` (can go below zero; no hard lock)
- coordination adjustment:
  - for non-negative base cost: `max(0, baseCost - (COR - 10))`
  - negative base costs stay negative

### Round advance (GM)

Automatic increment of `Combat.round` **after each `move` / `action` in the table** was removed: with popcorn initiative, “everyone has `startedTurns >= turnStarts`” can become true as soon as each unit has acted once in the round, which is not the same as “round over.”

**Logical round** for AP tables, UI badges, and `round.start` events is stored in `flags.spaceholder.combatState.round`. SpaceHolder **does not** increment core `Combat.round` when the round boundary is reached (so Foundry does not reset token movement history on a core round bump). The boundary still runs `CombatSessionManager._flushRoundBoundary` from `endTurn`, which bumps `combatState.round`, resets `startedTurnsByCombatant` / turn pick state, and may call `combat.update({ turn: 0 })` without changing `round`. Core previous/next **round** controls in the tracker are hidden; use SpaceHolder flow only.

Resetting a token’s drawn path remains a **core** concern (e.g. `TokenDocument#revertRecordedMovement` / clearing history), not tied to `Combat.round`.

## Movement

- Hook source: `updateToken` and `TokenDocument.movement` (`recorded && completed`)
- Movement entry is automatically logged in combat.
- Movement can be marked as forced (`move.forced`) -> AP cost becomes zero.

## Undo

Current V1 behavior:

- Undo command emits `action.undo` marker.
- For movement, best-effort token rollback to stored `from` position when available.
- Runtime action table marks target entry as ignored.

This is the baseline scaffolding for future full inverse handlers.

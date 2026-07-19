---
doc-type: reference
status: current
tags:
  - sh-code-doc/reference
  - sh-code-doc/status/current
---

# Personal Time

Per-actor clock in **seconds**, driven by AP spend (and GM absolute skip). Not a calendar; Timeline V2 is unrelated.

## Formula

Full AP pool ≈ `REFERENCE_TURN_SECONDS` (10) of personal time:

```text
seconds = spentAp * 10 / maxAp
```

Examples: max 70 → 7 AP ≈ 1 s; max 130 → 13 AP ≈ 1 s. If `maxAp === 0`, no tick.

## When it advances

| Source | Delta | AP pool |
|--------|-------|---------|
| `spendAp` | `apToSeconds(actor, actualSpent)` | decreased |
| `refreshApPool` (official turn start) | remaining AP before refill → seconds | refilled to max |
| GM Skip Time (token controls) | absolute seconds / minutes | unchanged |

Only the affected actor’s clock moves.

## Storage and hook

- Flag: `flags.spaceholder.personalTime.totalSeconds` (cumulative)
- Hook: `spaceholder.personalTimeAdvanced(actor, { seconds, total, previous, source })`
- Undo of AP ledger transactions reverses the stored personal-time delta

## API

`module/helpers/actions/personal-time.mjs`, also on `game.spaceholder`:

- `apToSeconds`, `secondsToAp`, `advancePersonalTime`, `getPersonalTimeTotal`
- `openSkipPersonalTimeDialog`, `REFERENCE_TURN_SECONDS`

## Not linked (yet)

Global `AP_PER_SECOND = 10` (weapon RPM / aiming delay) and `CONFIG.SPACEHOLDER.movementApTimeSlice` stay as design abstractions. Aligning them with per-actor personal time is a separate backlog item (`[[ОД и AP_PER_SECOND]]`).

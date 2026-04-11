# Item Piles SH

`item-piles-sh` is an internal SpaceHolder subsystem that handles item drops on canvas.

## Why it exists

- SpaceHolder does not rely on external `item-piles` module anymore for core canvas drop.
- The subsystem provides a focused in-system implementation for:
  - drop item to empty canvas position -> create pile token + actor
  - drop item on existing pile token -> merge quantity into pile
  - non-GM player drops -> routed to GM through system socket
  - transfer operations between character inventory and loot containers (`transferItem`, `transferAll`, `splitItem`)

## Location

- Runtime entry: `module/helpers/item-piles-sh/index.mjs`
- Public API: `module/helpers/item-piles-sh/api.mjs`
- Internal drop logic: `module/helpers/item-piles-sh/private-api.mjs`
- GM execution/socket adapter: `module/helpers/item-piles-sh/socket-adapter.mjs`
- Optional wrapper adapter: `module/helpers/item-piles-sh/wrapper-adapter.mjs`

## Lifecycle

`spaceholder` calls:

- `registerItemPilesShSettings()` during `init`
- `initializeItemPilesSh()` during `ready`

## Flags and data model

- Pile marker flag:
  - `flags.spaceholder.itemPilesSh.isPile = true`
- A pile is represented as:
  - Actor (`loot` by default)
  - Token on current scene linked by `actorId`
  - Embedded item documents with `system.quantity`

## Settings

- `spaceholder.itemPilesShEnabled` (world, boolean)
- `spaceholder.itemPilesShDebug` (world, boolean)

## Public API

Available at `game.spaceholder.itemPilesSh.api`:

- `createItemPile({ sceneId, x, y, items })`
- `dropData({ dropData, sceneId })`
- `transferItem({ fromItemUuid, toActorUuid, quantity, sourceTokenUuid?, pileTokenUuid? })`
- `transferAll({ fromActorUuid, toActorUuid })`
- `splitItem({ fromItemUuid, toActorUuid, quantity })`
- `openPile({ actorUuid, sourceTokenUuid?, pileTokenUuid? })`

## Container rules

- `loot` actor supports settings in `system`:
  - `isContainer`, `isLocked`, `keyId`, `visibilityMode`, `interactionDistance`, `autoLoot`
- Access checks happen on GM side:
  - ownership/faction/public visibility
  - lock/key validation
  - optional interaction distance check (token to pile token)
- Auto-generated loot actors:
  - use one shared template actor `Generic Item Pile` in hidden Actor folder `SH Hidden`
  - pile instances are created as unlinked (`actorLink: false`) tokens of that template
  - each pile token keeps its own inventory via token actor delta (no new Actor per drop)

## Notes

- This subsystem intentionally prioritizes reliable canvas drop flow.
- If legacy/alternative drop handlers conflict, `item-piles-sh` should remain the primary `dropCanvasData` item handler.

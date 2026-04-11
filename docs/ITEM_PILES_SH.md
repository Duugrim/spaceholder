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
- Stack merge identity hash: `module/helpers/item-piles-sh/stack-fingerprint.mjs`
- GM execution/socket adapter: `module/helpers/item-piles-sh/socket-adapter.mjs`
- Optional wrapper adapter: `module/helpers/item-piles-sh/wrapper-adapter.mjs`

## Lifecycle

`spaceholder` calls:

- `registerItemPilesShSettings()` during `init`
- `initializeItemPilesSh()` during `ready`

## Flags and data model

- Pile marker flag:
  - `flags.spaceholder.itemPilesSh.isPile = true`
- Per-item stack cache (pile `loot` actors only):
  - `flags.spaceholder.itemPilesSh.stackFingerprint` — hex string; maintained by `preCreateItem` / `preUpdateItem` hooks when the parent actor is a pile (`type === loot` and `isPile`).
- A pile is represented as:
  - Actor (`loot` by default)
  - Token on current scene linked by `actorId`
  - Embedded item documents with `system.quantity`

## Stack identity

When an item is dropped or transferred into a pile, the subsystem looks for an existing embedded item with the **same stack fingerprint** and, if found, increases `system.quantity` instead of creating a new item.

- **Fingerprint input** (canonical JSON + FNV-1a 32-bit hex): `type`, `name`, `img`, `system` with `quantity`, `held`, and `equipped` removed, sorted `effects`, and `flags` with `flags.spaceholder.itemPilesSh` removed entirely (so `droppedAt` and the cache field do not affect identity). `flags.core.sourceId` is also omitted so compendium linkage does not force incorrect merges.
- **Lazy match**: if an older pile item has no `stackFingerprint` flag yet, the fingerprint is computed from `item.toObject(false)` on demand when searching (no automatic DB write until the next update hook runs).
- **New creates** from `item-piles-sh` set `stackFingerprint` on the create payload before `preCreateItem`; the hook skips recomputation when the field is already present so the hash stays aligned with the merge logic.

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

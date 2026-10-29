/**
 * Statuses of the system: ready-made ActiveEffects an actor can be given by hand (token HUD) or by code
 * (`actor.toggleStatusEffect(id)`). A status is an entry of `CONFIG.statusEffects`; hanging one creates an
 * ordinary ActiveEffect on the actor with `statuses: [id]`, so `actor.statuses.has(id)` tells whether it is on.
 *
 * A status can carry its own effect data (`system.changes`, `duration`, `flags`, …): it is copied into the
 * effect when the status is applied. Besides Foundry's fields an entry may hold two rules of the system, read
 * from the registry at the moment they matter (so a package can extend them on `CONFIG.statusEffects[id]`):
 *
 *  - `blockedBy` — ids of statuses that forbid this one: it is not put on while one of them is on, and it comes
 *    off when one of them appears;
 *  - `endOn` — events ({@link STATUS_EVENTS}) that take the status off.
 *
 * The rules are pure functions below; `status-lifecycle.mjs` wires them to Foundry's hooks.
 * See `docs/code/reference/EFFECTS.md`.
 */

/** Status ids (`ActiveEffect#statuses`, `Actor#statuses`). */
export const STATUS_IDS = Object.freeze({
  /** The actor is in the fight and can answer fire: it is hung at the start of its turn and it is hard to hit. */
  COMBAT_READY: 'combatReady',
  /** The actor has run this round. */
  MOVING: 'moving',
  /** The actor stands in cover. */
  COVER: 'cover',
  /** The actor is wholly hidden behind cover. */
  HIDDEN: 'hidden',
});

/** Foundry's own status ids the system rules refer to. */
export const CORE_STATUS_IDS = Object.freeze({
  DEAD: 'dead',
  UNCONSCIOUS: 'unconscious',
});

/** Events that can take a status off (`endOn`). */
export const STATUS_EVENTS = Object.freeze({
  /** The token's position changed. */
  MOVE: 'move',
  /** The token's facing changed. */
  TURN: 'turn',
  /** The actor took an action in combat other than moving (any of them, until actions get tags). */
  ACTION: 'action',
  /** A new combat round began. */
  ROUND_START: 'roundStart',
  /** The combat is over (or the actor left it). */
  COMBAT_END: 'combatEnd',
});

/** Actor types that fight and so can carry combat statuses (the token HUD hides them on other types). */
const COMBATANT_ACTOR_TYPES = ['character', 'npc'];

/** The token HUD sorts by `order`, then by title; negative puts the system statuses ahead of Foundry's own. */
const SYSTEM_STATUS_ORDER = -100;

const defineStatus = (definition) => Object.freeze({
  ...definition,
  hud: Object.freeze({ actorTypes: Object.freeze([...COMBATANT_ACTOR_TYPES]) }),
  ...(definition.blockedBy && { blockedBy: Object.freeze([...definition.blockedBy]) }),
  ...(definition.endOn && { endOn: Object.freeze([...definition.endOn]) }),
});

/**
 * Definitions in the shape of `CONFIG.statusEffects` entries (`name` is a localization key, the HUD localizes it).
 * Add a status here and it is registered on `init`; the lang keys go to `SPACEHOLDER.Effect.Statuses`. The list
 * order is the order in the token HUD.
 */
export const SPACEHOLDER_STATUS_EFFECTS = Object.freeze([
  {
    id: STATUS_IDS.COMBAT_READY,
    name: 'SPACEHOLDER.Effect.Statuses.combatReady',
    img: 'icons/svg/combat.svg',
    blockedBy: [CORE_STATUS_IDS.DEAD, CORE_STATUS_IDS.UNCONSCIOUS],
    endOn: [STATUS_EVENTS.COMBAT_END],
  },
  {
    id: STATUS_IDS.MOVING,
    name: 'SPACEHOLDER.Effect.Statuses.moving',
    img: 'icons/svg/walk.svg',
    endOn: [STATUS_EVENTS.ACTION, STATUS_EVENTS.ROUND_START, STATUS_EVENTS.COMBAT_END],
  },
  {
    id: STATUS_IDS.COVER,
    name: 'SPACEHOLDER.Effect.Statuses.cover',
    img: 'icons/svg/shield.svg',
    endOn: [STATUS_EVENTS.MOVE],
  },
  {
    id: STATUS_IDS.HIDDEN,
    name: 'SPACEHOLDER.Effect.Statuses.hidden',
    img: 'icons/svg/invisible.svg',
    endOn: [STATUS_EVENTS.MOVE],
  },
].map((definition, index) => defineStatus({ ...definition, order: SYSTEM_STATUS_ORDER + index })));

/**
 * Put the system statuses into `CONFIG.statusEffects`. Safe to call again: an entry with the same id is replaced,
 * not duplicated. Entries are copied, so a module that decorates the registered ones never touches these constants.
 *
 * @param {object} [config]       `CONFIG`
 * @param {object[]} [definitions]
 * @returns {string[]} ids registered
 */
export function registerSpaceholderStatusEffects(config = CONFIG, definitions = SPACEHOLDER_STATUS_EFFECTS) {
  const ids = [];
  for (const definition of definitions) {
    config.statusEffects[definition.id] = structuredClone(definition);
    ids.push(definition.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Rules (pure: the registry is passed in — `CONFIG.statusEffects`, or any `{ [id]: entry }` map)
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} statusId
 * @param {Iterable<string>} activeIds ids of the statuses the actor has now
 * @param {object} registry
 * @returns {string[]} the statuses among `activeIds` that forbid `statusId`
 */
export function activeBlockers(statusId, activeIds, registry) {
  const blockedBy = registry?.[statusId]?.blockedBy;
  if (!Array.isArray(blockedBy)) return [];
  const active = activeIds instanceof Set ? activeIds : new Set(activeIds);
  return blockedBy.filter((id) => active.has(id));
}

/**
 * Whether the status is meant for this kind of actor (`hud.actorTypes`; no list — any).
 * @param {string} statusId
 * @param {string} actorType
 * @param {object} registry
 * @returns {boolean}
 */
export function statusFitsActorType(statusId, actorType, registry) {
  const types = registry?.[statusId]?.hud?.actorTypes;
  return !Array.isArray(types) || types.includes(actorType);
}

/**
 * The events that take an effect off: the `endOn` of every status it carries plus its own
 * `flags.spaceholder.endOn` (for an effect that is not a status, e.g. an item's «Выжидание»).
 * @param {Iterable<string>} statusIds `effect.statuses`
 * @param {string[]|null|undefined} ownEndOn the effect's own list
 * @param {object} registry
 * @returns {Set<string>}
 */
export function endEventsOf(statusIds, ownEndOn, registry) {
  const events = new Set(Array.isArray(ownEndOn) ? ownEndOn : []);
  for (const id of statusIds ?? []) {
    for (const event of registry?.[id]?.endOn ?? []) events.add(event);
  }
  return events;
}

/** Flag of the token that holds the system's facing (`flags.spaceholder.tokenpointerDirection`). */
const FACING_FLAG = 'tokenpointerDirection';

/**
 * Events a token update stands for.
 * @param {object|null|undefined} changes the `changes` of `updateToken`
 * @returns {string[]} {@link STATUS_EVENTS} `MOVE` when the position changed, `TURN` when the facing did
 *   (Foundry's `rotation`, or the system's facing the token rotator writes)
 */
export function tokenChangeEvents(changes) {
  const events = [];
  if (!changes || typeof changes !== 'object') return events;
  if (Object.hasOwn(changes, 'x') || Object.hasOwn(changes, 'y')) events.push(STATUS_EVENTS.MOVE);
  const facing = changes.flags?.spaceholder;
  if (Object.hasOwn(changes, 'rotation') || (facing && typeof facing === 'object' && Object.hasOwn(facing, FACING_FLAG))) {
    events.push(STATUS_EVENTS.TURN);
  }
  return events;
}

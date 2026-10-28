/**
 * Statuses the system hangs and takes off by itself (the rules live in `status-effects.mjs`):
 *
 *  - **Combat ready** is hung at the start of an actor's turn (`spaceholder.combatTurnPicked`) unless it is
 *    already there or something in its `blockedBy` list (dead, unconscious, …) is on. A status in that list
 *    that appears later takes it off, and while one is on it cannot be hung at all, by hand too.
 *  - **Moving** is hung when a token of the running combat changes position.
 *  - A status comes off on the events of its `endOn`: a token moved or turned, the actor took an action that
 *    is not a move (`spaceholder.combatActionTaken`), a new round began (`spaceholder.combatRoundStarted`),
 *    the combat is over or the actor left it.
 *
 * Moves are handled where they are made (the user who dragged the token owns the actor); everything that
 * hooks fire on every client is done by the active GM only. All steps are idempotent, so two GMs racing
 * leave the same state.
 */

import {
  STATUS_EVENTS,
  STATUS_IDS,
  activeBlockers,
  endEventsOf,
  statusFitsActorType,
  tokenChangeEvents,
} from './status-effects.mjs';

const FLAG_SCOPE = 'spaceholder';
const FLAG_END_ON = 'endOn';

/** Statuses being hung right now, so two calls in a row do not hang one twice (`toggleStatusEffect` is async). */
const _hanging = new Set();

/**
 * Ids of the statuses an actor has, read from its effects (not from `Actor#statuses`, which lags behind
 * until the actor is prepared again).
 * @param {Actor} actor
 * @returns {Set<string>}
 */
export function activeStatusIds(actor) {
  const ids = new Set();
  const effects = typeof actor?.allApplicableEffects === 'function' ? actor.allApplicableEffects() : (actor?.effects ?? []);
  for (const effect of effects) {
    if (!effect.active) continue;
    for (const id of effect.statuses ?? []) ids.add(id);
  }
  return ids;
}

/**
 * Hang a status unless the actor has it, it does not fit the actor, or a blocker is on.
 * @param {Actor|null|undefined} actor
 * @param {string} statusId
 * @param {object} [registry] `CONFIG.statusEffects`
 * @returns {Promise<'added'|'present'|'blocked'|'skipped'|'pending'|'unknown'>}
 */
export async function hangStatus(actor, statusId, registry = CONFIG.statusEffects) {
  if (!actor || !registry?.[statusId]) return 'unknown';
  if (!statusFitsActorType(statusId, actor.type, registry)) return 'skipped';
  const active = activeStatusIds(actor);
  if (active.has(statusId)) return 'present';
  if (activeBlockers(statusId, active, registry).length) return 'blocked';
  const key = `${actor.uuid}|${statusId}`;
  if (_hanging.has(key)) return 'pending';
  _hanging.add(key);
  try {
    await actor.toggleStatusEffect(statusId, { active: true });
    return 'added';
  } finally {
    _hanging.delete(key);
  }
}

/**
 * Take off the actor's effects that end on `event`.
 * @param {Actor|null|undefined} actor
 * @param {string} event {@link STATUS_EVENTS}
 * @param {object} [registry] `CONFIG.statusEffects`
 * @returns {Promise<number>} how many effects were removed
 */
export async function endStatuses(actor, event, registry = CONFIG.statusEffects) {
  const ids = [];
  for (const effect of actor?.effects ?? []) {
    const ends = endEventsOf(effect.statuses, effect.getFlag?.(FLAG_SCOPE, FLAG_END_ON), registry);
    if (ends.has(event)) ids.push(effect.id);
  }
  if (!ids.length) return 0;
  await actor.deleteEmbeddedDocuments('ActiveEffect', ids);
  return ids.length;
}

/**
 * Take off the effects whose status is forbidden by a status the actor has now.
 * @param {Actor|null|undefined} actor
 * @param {object} [registry] `CONFIG.statusEffects`
 * @returns {Promise<number>} how many effects were removed
 */
export async function dropBlockedStatuses(actor, registry = CONFIG.statusEffects) {
  const active = activeStatusIds(actor);
  const ids = [];
  for (const effect of actor?.effects ?? []) {
    if (!effect.active) continue;
    if ([...(effect.statuses ?? [])].some((id) => activeBlockers(id, active, registry).length)) ids.push(effect.id);
  }
  if (!ids.length) return 0;
  await actor.deleteEmbeddedDocuments('ActiveEffect', ids);
  return ids.length;
}

/**
 * The statuses on the actor that forbid a new effect (the effect is not on the actor yet).
 * @param {ActiveEffect} effect effect about to be created on an actor
 * @param {object} [registry] `CONFIG.statusEffects`
 * @returns {string[]}
 */
export function blockersOfNewEffect(effect, registry = CONFIG.statusEffects) {
  if (effect?.parent?.documentName !== 'Actor') return [];
  const active = activeStatusIds(effect.parent);
  const blockers = new Set();
  for (const id of effect.statuses ?? []) {
    for (const blocker of activeBlockers(id, active, registry)) blockers.add(blocker);
  }
  return [...blockers];
}

/**
 * Whether the token takes part in the running combat.
 * @param {TokenDocument} tokenDocument
 * @param {Combat|null|undefined} combat
 * @returns {boolean}
 */
export function isTokenInCombat(tokenDocument, combat) {
  if (!combat?.started) return false;
  return (combat.combatants?.contents ?? []).some((c) => String(c.tokenId ?? '') === String(tokenDocument?.id ?? ''));
}

/**
 * A token was updated: the statuses that end on its move / turn come off, and a move in the running combat
 * makes the actor «moving».
 * @param {TokenDocument} tokenDocument
 * @param {object} changes
 * @param {{ isUndo?: boolean }} [options]
 * @param {{ combat?: Combat|null, registry?: object }} [context]
 * @returns {Promise<string[]>} the events the update stood for
 */
export async function handleTokenUpdate(tokenDocument, changes, options = {}, { combat = game.combat, registry = CONFIG.statusEffects } = {}) {
  const events = tokenChangeEvents(changes);
  const actor = tokenDocument?.actor;
  if (!events.length || !actor) return events;
  for (const event of events) await endStatuses(actor, event, registry);
  if (events.includes(STATUS_EVENTS.MOVE) && options?.isUndo !== true && isTokenInCombat(tokenDocument, combat)) {
    await hangStatus(actor, STATUS_IDS.MOVING, registry);
  }
  return events;
}

/**
 * The actor took an action in combat (anything but a move): the statuses that end on an action come off.
 * @param {{ actor?: Actor|null }} [action] payload of `spaceholder.combatActionTaken`
 * @param {object} [registry]
 * @returns {Promise<number>} how many effects were removed
 */
export function handleCombatAction({ actor = null } = {}, registry = CONFIG.statusEffects) {
  return endStatuses(actor, STATUS_EVENTS.ACTION, registry);
}

/**
 * End `event` for everyone in a combat.
 * @param {Combat} combat
 * @param {string} event
 * @param {object} [registry]
 */
export async function endStatusesInCombat(combat, event, registry = CONFIG.statusEffects) {
  const actors = new Set();
  for (const combatant of combat?.combatants?.contents ?? []) {
    if (combatant.actor) actors.add(combatant.actor);
  }
  for (const actor of actors) await endStatuses(actor, event, registry);
}

const isActiveGm = () => game.users?.activeGM?.id === game.user?.id;

const logFailure = (what) => (error) => console.error(`SpaceHolder | ${what} failed`, error);

let _installed = false;

/** Subscribe to the hooks described at the top of the file. Call once, on `ready`. */
export function installStatusLifecycle() {
  if (_installed) return;
  _installed = true;

  // A blocked status cannot be hung, whoever tries (the token HUD, the sheet, a macro, the turn start).
  Hooks.on('preCreateActiveEffect', (effect) => {
    const blockers = blockersOfNewEffect(effect);
    if (!blockers.length) return;
    const names = blockers.map((id) => game.i18n.localize(CONFIG.statusEffects[id]?.name ?? id)).join(', ');
    ui.notifications?.warn(game.i18n.format('SPACEHOLDER.Effect.Blocked', { status: effect.name, blockers: names }));
    return false;
  });

  // A blocker appeared: what it forbids comes off.
  Hooks.on('createActiveEffect', (effect) => {
    if (!isActiveGm() || !effect.actor) return;
    dropBlockedStatuses(effect.actor).catch(logFailure('dropping blocked statuses'));
  });

  // The turn starts: the picking GM's client fires this hook once per pick.
  Hooks.on('spaceholder.combatTurnPicked', (combat, { combatantId } = {}) => {
    if (!game.user?.isGM) return;
    hangStatus(combat?.combatants?.get(combatantId)?.actor, STATUS_IDS.COMBAT_READY)
      .catch(logFailure('hanging combat readiness'));
  });

  Hooks.on('spaceholder.combatRoundStarted', (combat) => {
    if (!game.user?.isGM) return;
    endStatusesInCombat(combat, STATUS_EVENTS.ROUND_START).catch(logFailure('ending statuses at round start'));
  });

  Hooks.on('deleteCombat', (combat) => {
    if (!isActiveGm()) return;
    endStatusesInCombat(combat, STATUS_EVENTS.COMBAT_END).catch(logFailure('ending statuses at combat end'));
  });

  Hooks.on('deleteCombatant', (combatant) => {
    if (!isActiveGm()) return;
    endStatuses(combatant.actor, STATUS_EVENTS.COMBAT_END).catch(logFailure('ending statuses of a leaving combatant'));
  });

  // An action: announced by the client of the actor that took it (see `announceCombatAction`).
  Hooks.on('spaceholder.combatActionTaken', (action) => {
    handleCombatAction(action).catch(logFailure('ending statuses on an action'));
  });

  Hooks.on('updateToken', (tokenDocument, changes, options, userId) => {
    if (String(userId ?? '') !== String(game.user?.id ?? '')) return;
    handleTokenUpdate(tokenDocument, changes, options).catch(logFailure('updating statuses on token move'));
  });
}

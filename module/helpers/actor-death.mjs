/**
 * Death of an actor in the world: the actor derives `system.health.dead` from its anatomy
 * (`computeDeathState`: dead — the root part is lost, or a vital organ is destroyed or lost; dying — a vital
 * organ is damaged, or the body bleeds out within minutes). This module keeps Foundry's own statuses in line
 * with it: "dead" (the overlay on the token, the defeated mark in the combat tracker — `Combatant#isDefeated`
 * follows the status) and, while dying, "unconscious" (out of action).
 *
 * Only the active GM touches the statuses. It sets one when the state comes and takes it off again when it
 * goes (an injury healed or removed), but only if it was this module that set it: a status the GM put on by
 * hand is left alone.
 */

const FLAG_SCOPE = 'spaceholder';
const FLAG_AUTO_DEAD = 'autoDead';
const FLAG_AUTO_DYING = 'autoDying';

/** Status shown while the body is dying: out of action (Foundry core "unconscious"). */
export const DYING_STATUS_ID = 'unconscious';

/**
 * What to do with the status.
 * @param {{ dead: boolean, hasStatus: boolean, auto: boolean }} state
 *   `dead` — derived by the anatomy; `hasStatus` — the actor has the status; `auto` — this module set it
 * @returns {'add'|'remove'|null}
 */
export function decideDeathSync({ dead, hasStatus, auto }) {
  if (dead && !hasStatus) return 'add';
  if (!dead && hasStatus && auto) return 'remove';
  return null;
}

/** Id of the status Foundry gives defeated actors (`CONFIG.specialStatusEffects.DEFEATED`, "dead"). */
export function defeatedStatusId() {
  return CONFIG.specialStatusEffects?.DEFEATED ?? 'dead';
}

/**
 * Bring one status of an actor in line with a derived state.
 * @param {Actor} actor
 * @param {{ statusId: string, active: boolean, flag: string, overlay?: boolean }} spec
 * @returns {Promise<'add'|'remove'|null>} what was done
 */
async function syncStatus(actor, { statusId, active, flag, overlay = false }) {
  if (!CONFIG.statusEffects?.some((s) => s.id === statusId)) return null;
  const action = decideDeathSync({
    dead: active,
    hasStatus: actor.statuses?.has(statusId) === true,
    auto: actor.getFlag(FLAG_SCOPE, flag) === true,
  });
  if (action === 'add') {
    await actor.toggleStatusEffect(statusId, { active: true, overlay });
    await actor.setFlag(FLAG_SCOPE, flag, true);
  } else if (action === 'remove') {
    await actor.toggleStatusEffect(statusId, { active: false });
    await actor.unsetFlag(FLAG_SCOPE, flag);
  }
  return action;
}

/**
 * Bring the "dead" and "unconscious" (dying) statuses of an actor in line with its derived state.
 * @param {Actor} actor
 * @returns {Promise<{dead: 'add'|'remove'|null, dying: 'add'|'remove'|null}|null>} what was done
 */
export async function syncDeathStatus(actor) {
  if (!actor?.system?.health) return null;
  const state = actor.system.health.dead ?? {};
  const dead = await syncStatus(actor, { statusId: defeatedStatusId(), active: state.dead === true, flag: FLAG_AUTO_DEAD, overlay: true });
  const dying = await syncStatus(actor, { statusId: DYING_STATUS_ID, active: state.dying === true && state.dead !== true, flag: FLAG_AUTO_DYING });
  return { dead, dying };
}

let _installed = false;

/**
 * Sync the status after every change of an actor's health (injuries, body parts). `updateActor` also
 * fires for the synthetic actor of an unlinked token (`ActorDelta#_onUpdate`), so token actors are covered.
 */
export function installActorDeathSync() {
  if (_installed) return;
  _installed = true;
  Hooks.on('updateActor', (actor, changed) => {
    if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return;
    if (!foundry.utils.hasProperty(changed ?? {}, 'system.health')) return;
    syncDeathStatus(actor).catch((e) => console.error('SpaceHolder | death status sync failed', e));
  });
}

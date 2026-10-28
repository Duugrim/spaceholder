/**
 * GM actions — the action types the system itself registers.
 *
 * Every handler runs on the GM client. Payloads must be plain JSON (they travel over the socket
 * and sit in a User flag while the GM is away).
 */

import {
  JOURNAL_GM_ACTIONS,
  applyJournalAppendLineAsGm,
  applyJournalReplaceMessageAsGm,
  collectJournalActorUuids,
} from '../actions/action-chat-journal.mjs';

/** Action types as constants, so callers do not repeat strings. */
export const GM_ACTION_TYPES = Object.freeze({
  DAMAGE_APPLY: 'damage.apply',
  JOURNAL_APPEND_LINE: JOURNAL_GM_ACTIONS.APPEND_LINE,
  JOURNAL_REPLACE_MESSAGE: JOURNAL_GM_ACTIONS.REPLACE_MESSAGE,
});

/** Category ids (queue window groups). Labels: `SPACEHOLDER.GmActions.Category.<id>`. */
export const GM_ACTION_CATEGORIES = Object.freeze({
  DAMAGE: 'damage',
  MISC: 'misc',
});

/** Resolve a UUID to an Actor (world actor, or the synthetic actor of an unlinked token). */
async function _resolveActor(uuid) {
  const doc = await fromUuid(String(uuid ?? ''));
  if (!doc) return null;
  if (doc.documentName === 'Actor') return doc;
  return doc.actor ?? null;
}

/** Whether `user` owns the actor behind `uuid`. */
async function _userOwnsActor(user, uuid) {
  const actor = await _resolveActor(uuid);
  return !!actor && !!user && !!actor.testUserPermission(user, 'OWNER');
}

/**
 * `damage.apply` — run `Actor#applyDamagePackage` on a target the requester does not own.
 *
 * Payload: `{ targetUuid, partId, projectile?, applications?, builderContext?, source?,
 * hitDirection? }` — the same fields `applyDamagePackage` takes, plus the target uuid.
 * Validation: the requester must own the attacker named in `source.attackerUuid` (a GM always passes).
 *
 * @param {import('./gm-action-manager.mjs').GmActionManager} manager
 */
export function registerBuiltinGmActions(manager) {
  manager.register(GM_ACTION_TYPES.DAMAGE_APPLY, {
    category: GM_ACTION_CATEGORIES.DAMAGE,

    validate: async ({ payload, requester }) => {
      if (!requester) return 'unknown requester';
      if (requester.isGM) return true;
      if (typeof payload?.targetUuid !== 'string' || typeof payload?.partId !== 'string') return 'invalid damage payload';
      if (!payload.projectile && !payload.applications) return 'no damage specification';
      const attackerUuid = String(payload?.source?.attackerUuid ?? '');
      if (!attackerUuid) return 'missing attacker';
      const attacker = await _resolveActor(attackerUuid);
      const user = game.users?.get?.(requester.id);
      if (!attacker || !user || !attacker.testUserPermission(user, 'OWNER')) {
        return 'the requester does not own the attacker';
      }
      return true;
    },

    handler: async (payload) => {
      const actor = await _resolveActor(payload.targetUuid);
      if (!actor || typeof actor.applyDamagePackage !== 'function') throw new Error('damage target not found');
      const out = await actor.applyDamagePackage({
        partId: payload.partId,
        projectile: payload.projectile,
        applications: payload.applications,
        builderContext: payload.builderContext,
        source: payload.source,
        hitDirection: payload.hitDirection,
      });
      // The requester's attack log shows what reached the part, and a bullet that left the body flies on
      // with `exitApplications` (to the next target on its line). The penetration track draws the body's
      // layers from `trace` and names the organs from `innerHitsBySlot`.
      return {
        slotRef: out?.slotRef ?? null,
        bodyDamage: out?.bodyDamage ?? [],
        exitApplications: out?.exitApplications ?? [],
        innerHitsBySlot: out?.innerHitsBySlot ?? {},
        trace: out?.trace ?? [],
      };
    },
  });

  // Action journal writes (a reaction on somebody else's turn, an undo on a message the player did not post).
  // See `action-chat-journal.mjs` (`JOURNAL_GM_ACTIONS`).

  /**
   * `journal.appendLine` — add a line to the journal of the character whose turn it is.
   * Payload: the options of `appendCombatActionJournalLine`, with documents as uuids / ids.
   * Validation: the requester owns the acting character (`actorUuid`).
   */
  manager.register(GM_ACTION_TYPES.JOURNAL_APPEND_LINE, {
    category: GM_ACTION_CATEGORIES.MISC,
    validate: async ({ payload, requester }) => {
      if (!requester) return 'unknown requester';
      if (requester.isGM) return true;
      const user = game.users?.get?.(requester.id);
      return (await _userOwnsActor(user, payload?.actorUuid)) ? true : 'the requester does not own the acting character';
    },
    handler: (payload) => applyJournalAppendLineAsGm(payload),
  });

  /**
   * `journal.replaceMessage` — re-post a journal message with new lines.
   * Payload: `{ messageId, journalFlags, anchorActorUuid? }`.
   * Validation: the requester owns a character the journal's lines refer to.
   */
  manager.register(GM_ACTION_TYPES.JOURNAL_REPLACE_MESSAGE, {
    category: GM_ACTION_CATEGORIES.MISC,
    validate: async ({ payload, requester }) => {
      if (!requester) return 'unknown requester';
      if (requester.isGM) return true;
      const user = game.users?.get?.(requester.id);
      for (const uuid of collectJournalActorUuids(payload?.journalFlags)) {
        if (await _userOwnsActor(user, uuid)) return true;
      }
      return 'the requester owns no character of this journal';
    },
    handler: (payload) => applyJournalReplaceMessageAsGm(payload),
  });
}

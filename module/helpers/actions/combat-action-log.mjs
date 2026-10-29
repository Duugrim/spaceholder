/**
 * An action taken in combat: find the actor's combatant, let the first action of a round start the
 * official turn, and write the action into the combat action table and the actor's round journal in
 * chat. Used by `executeActorAction` and by the weapon attack chain, so every spend of AP in combat
 * is logged the same way.
 */

import { appendCombatActionJournalLine } from './action-chat-journal.mjs';

const MODULE_NS = 'spaceholder';

/** Hook fired when an actor takes an action in combat (anything but a move); see `status-lifecycle.mjs`. */
export const COMBAT_ACTION_HOOK = 'spaceholder.combatActionTaken';

/**
 * Tell the system that `actor` has just taken an action (its AP is spent, it is going to happen). Statuses
 * that end on an action come off. Moves do not come through here.
 * @param {{ actor: Actor, tokenDoc?: TokenDocument|null, actionId?: string }} action
 */
export function announceCombatAction({ actor, tokenDoc = null, actionId = '' }) {
  Hooks.callAll(COMBAT_ACTION_HOOK, { actor, tokenDoc, actionId });
}

/** @returns {Combat|null} the started combat, if any */
export function activeCombat() {
  return game?.combat?.started ? game.combat : null;
}

/**
 * @param {Actor} actor
 * @param {TokenDocument|null} [tokenDoc]
 * @param {Combat|null} [combat]
 * @returns {Combatant|null} the combatant of the token, else of the actor
 */
export function combatantForActor(actor, tokenDoc = null, combat = activeCombat()) {
  if (!actor || !combat) return null;
  const list = combat.combatants?.contents || [];
  if (tokenDoc?.id) {
    const byToken = list.find((c) => String(c.tokenId ?? c.token?.id ?? '') === String(tokenDoc.id));
    if (byToken) return byToken;
  }
  return list.find((c) => String(c.actorId ?? c.actor?.id ?? '') === String(actor.id)) || null;
}

/**
 * The combat and combatant an action of `actor` belongs to. The first action of a round starts the
 * actor's official turn (the turn pick refills the AP pool), so it is done before AP is spent.
 * @param {Actor} actor
 * @param {TokenDocument|null} [tokenDoc]
 * @returns {Promise<{ combat: Combat|null, combatant: Combatant|null }>}
 */
export async function beginCombatAction(actor, tokenDoc = null) {
  let combat = activeCombat();
  let combatant = combatantForActor(actor, tokenDoc, combat);
  const mgr = game.spaceholder?.combatSessionManager;
  if (combat && combatant && !combat.getFlag?.(MODULE_NS, 'combatState')?.activeTurn?.combatantId && mgr?.pickTurn) {
    await mgr.pickTurn({ combatId: combat.id, combatantId: combatant.id });
    combat = activeCombat();
    combatant = combatantForActor(actor, tokenDoc, combat);
  }
  return { combat, combatant };
}

/**
 * Combat session log + per-actor chat journal line (after AP spend). Does nothing outside combat.
 * @param {object} p
 * @param {Actor} p.actor
 * @param {TokenDocument|null} [p.tokenDoc]
 * @param {string} p.actionId
 * @param {string} p.label
 * @param {string} [p.description]
 * @param {number} p.baseCost AP before the actor's action speed
 * @param {number} p.cost AP charged
 * @param {string|null} [p.transactionId]
 * @param {Combatant|null} [p.combatantHint]
 * @param {'action'|'attack'} [p.kind] journal row kind; `attack` carries the `attack` log of the aiming session
 * @param {object|null} [p.attack] attack log (see weapon/attack-log.mjs), for `kind: 'attack'`
 * @param {boolean} [p.undoable] whether the journal row offers undo
 */
export async function logCombatAction({
  actor,
  tokenDoc = null,
  actionId,
  label,
  description = '',
  baseCost,
  cost,
  transactionId = null,
  combatantHint = null,
  kind = 'action',
  attack = null,
  undoable = true,
}) {
  const combat = activeCombat();
  const combatant = combatantHint || combatantForActor(actor, tokenDoc, combat);
  const activeTurnId = String(combat?.getFlag?.(MODULE_NS, 'combatState')?.activeTurn?.combatantId || '').trim();
  const anchorCombatant = activeTurnId && combat?.combatants?.get?.(activeTurnId)
    ? combat.combatants.get(activeTurnId)
    : combatant;
  const anchorActor = anchorCombatant?.actor || actor;
  const isReaction = !!(combat && combatant && activeTurnId && activeTurnId !== combatant.id);
  if (combat && combatant) announceCombatAction({ actor, tokenDoc, actionId });

  let combatEventId = null;
  if (combat && combatant && game.spaceholder?.combatSessionManager?.logAction) {
    const logResult = await game.spaceholder.combatSessionManager.logAction({
      combat,
      actor,
      combatant,
      type: 'action',
      baseApCost: baseCost,
      apCost: cost,
      data: {
        actionId,
        label,
        description: String(description || '').trim() || null,
        tokenUuid: tokenDoc?.uuid ?? null,
        transactionId,
        isReaction,
        anchorCombatantId: anchorCombatant?.id ?? null,
        reactionOfEventId: null,
      },
      effects: [],
      inverse: [],
    });
    combatEventId = logResult?.eventId ?? null;
  }

  if (combat && combatant) {
    await appendCombatActionJournalLine({
      actor,
      combat,
      combatant,
      anchorActor,
      anchorCombatant,
      label,
      description: String(description || '').trim(),
      apCost: cost,
      kind,
      attack,
      undoable,
      isReaction,
      actorName: actor?.name || '',
      transactionId,
      combatEventId,
      tokenUuid: tokenDoc?.uuid ?? null,
    });
  }
}

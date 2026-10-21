/**
 * Report a finished attack (the aiming session's `AttackLog`) to chat. In combat it becomes one expandable
 * row of the actor's action journal plus a row of the combat action table; outside combat (or when the
 * journal cannot be written) it is a message of its own. Either way the log travels with the message, so
 * the shot trails can be redrawn from it.
 */

import { attackApTotals, finishAttackLog } from '../weapon/attack-log.mjs';
import { ATTACK_LOG_FLAG_KEY, SHOT_FLAG_SCOPE } from '../shot-trail.mjs';
import { buildActionJournalHtml, canWriteActionJournal } from './action-chat-journal.mjs';
import { activeCombat, combatantForActor, logCombatAction } from './combat-action-log.mjs';

export const ATTACK_ACTION_ID = 'weaponV3.attack';

function _L(key, fallback) {
  const value = game?.i18n?.localize?.(key);
  return value && value !== key ? value : fallback;
}

/**
 * @param {object} log AttackLog
 * @param {{ actor?: Actor|null, token?: Token|TokenDocument|null }} [who]
 * @returns {Promise<'journal'|'chat'|null>} where the attack was reported (`null`: nothing was shot)
 */
export async function reportAttack(log, { actor = null, token = null } = {}) {
  if (!log?.shots?.length) return null;
  finishAttackLog(log);
  const { ap, baseAp } = attackApTotals(log);
  const weaponName = log.weaponName || log.tokenName || actor?.name || '';
  const label = game?.i18n?.format?.('SPACEHOLDER.AttackLog.Label', { weapon: weaponName }) || `Attack: ${weaponName}`;
  const tokenDoc = token?.document ?? token ?? null;

  const combat = activeCombat();
  const combatant = combatantForActor(actor, tokenDoc, combat);
  if (canWriteActionJournal(actor, combat, combatant)) {
    await logCombatAction({
      actor,
      tokenDoc,
      actionId: ATTACK_ACTION_ID,
      label,
      baseCost: baseAp,
      cost: ap,
      kind: 'attack',
      attack: log,
      undoable: false,
      combatantHint: combatant,
    });
    return 'journal';
  }

  const line = { id: log.id, kind: 'attack', label, apCost: ap, attack: log, undone: false, undoable: false };
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token: tokenDoc }),
    content: buildActionJournalHtml([line], 0, _L('SPACEHOLDER.AttackLog.ChatTitle', 'Attack')),
    flags: { [SHOT_FLAG_SCOPE]: { [ATTACK_LOG_FLAG_KEY]: log } },
  });
  return 'chat';
}

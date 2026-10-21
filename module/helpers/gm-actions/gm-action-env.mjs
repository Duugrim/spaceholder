/**
 * GM actions — the Foundry side of {@link GmActionEnv}: socket, User flags (the queue) and chat
 * messages (the "awaits GM" note). Kept apart from the manager so the manager stays testable.
 */

import { GM_ACTION_SCOPE, GM_CHAT_FLAG, GM_QUEUE_FLAG, GM_ACTION_STATUS } from './gm-actions-core.mjs';

/** The system socket channel (shared with other features; messages are told apart by `type`). */
export function gmActionSocketName() {
  try {
    return `system.${game.system.id}`;
  } catch (_) {
    return `system.${GM_ACTION_SCOPE}`;
  }
}

function _L(key, fallback = '') {
  const v = game?.i18n?.localize?.(key);
  return v && v !== key ? v : fallback;
}

const _flagPath = (flag, id) => `flags.${GM_ACTION_SCOPE}.${flag}.${id}`;

/**
 * @returns {import('./gm-action-manager.mjs').GmActionEnv}
 */
export function createFoundryGmActionEnv() {
  return {
    get userId() {
      return String(game.user?.id ?? '');
    },
    get isGM() {
      return !!game.user?.isGM;
    },

    activeGMId: () => game.users?.activeGM?.id ?? null,

    getUser: (id) => {
      const user = game.users?.get?.(id);
      return user ? { id: user.id, name: user.name, isGM: !!user.isGM } : null;
    },

    emit: (message) => {
      try {
        game.socket.emit(gmActionSocketName(), message);
        return true;
      } catch (error) {
        console.error('SpaceHolder | gm-actions: socket emit failed', error);
        return false;
      }
    },

    listQueues: () => (game.users?.contents ?? []).map((user) => ({
      userId: user.id,
      entries: Object.values(user.getFlag(GM_ACTION_SCOPE, GM_QUEUE_FLAG) ?? {}),
    })),

    putQueueEntry: async (userId, entry) => {
      const user = game.users?.get?.(userId);
      if (!user) throw new Error(`gm-actions: user not found: ${userId}`);
      await user.update({ [_flagPath(GM_QUEUE_FLAG, entry.id)]: entry });
    },

    removeQueueEntry: async (userId, entryId) => {
      const user = game.users?.get?.(userId);
      if (!user) return;
      await user.update({ [_flagPath(GM_QUEUE_FLAG, entryId)]: new foundry.data.operators.ForcedDeletion() });
    },

    setChatStatus: async (messageId, entryId, status) => {
      const message = game.messages?.get?.(messageId);
      if (!message) return false;
      try {
        await message.update({
          [_flagPath(GM_CHAT_FLAG, entryId)]: status == null ? new foundry.data.operators.ForcedDeletion() : status,
        });
        return true;
      } catch (_) {
        return false; // e.g. the requester may not edit this message: the caller falls back
      }
    },

    createPendingChat: async (entry) => {
      const text = entry.label || _L('SPACEHOLDER.GmActions.Chat.DefaultLabel', 'Action');
      const message = await ChatMessage.create({
        speaker: ChatMessage.getSpeaker(),
        content: `<div class="spaceholder-gm-action-note">${foundry.utils.escapeHTML(text)}</div>`,
        flags: { [GM_ACTION_SCOPE]: { [GM_CHAT_FLAG]: { [entry.id]: GM_ACTION_STATUS.PENDING } } },
      });
      return message?.id ?? null;
    },

    now: () => Date.now(),
  };
}

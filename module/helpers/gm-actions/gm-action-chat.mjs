/**
 * GM actions — the chat note. A message whose `flags.spaceholder.gmActions` map has pending,
 * cancelled or failed entries gets a status line appended when it is rendered. The GM clears the
 * entry on success, so the note disappears by itself.
 */

import { GM_ACTION_SCOPE, GM_CHAT_FLAG, GM_ACTION_STATUS, summarizeChatStatuses } from './gm-actions-core.mjs';

const NOTE_CLASS = 'spaceholder-gm-action-status';

/**
 * @param {string} key
 * @param {string} fallback
 * @param {object} [data]
 */
function _t(key, fallback, data) {
  const i18n = game?.i18n;
  if (!i18n) return fallback;
  const out = data ? i18n.format?.(key, data) : i18n.localize?.(key);
  return out && out !== key ? out : fallback;
}

/**
 * Status lines for a message's flag map.
 * @param {Record<string, string>|null|undefined} map
 * @returns {Array<{status: string, icon: string, text: string}>}
 */
export function describeGmActionStatuses(map) {
  const counts = summarizeChatStatuses(map);
  const lines = [];
  if (counts.pending) {
    lines.push({
      status: GM_ACTION_STATUS.PENDING,
      icon: 'fa-hourglass-half',
      text: counts.pending === 1
        ? _t('SPACEHOLDER.GmActions.Chat.Pending', 'Action awaits GM')
        : _t('SPACEHOLDER.GmActions.Chat.PendingMany', `Actions await GM (${counts.pending})`, { count: counts.pending }),
    });
  }
  if (counts.cancelled) {
    lines.push({
      status: GM_ACTION_STATUS.CANCELLED,
      icon: 'fa-ban',
      text: counts.cancelled === 1
        ? _t('SPACEHOLDER.GmActions.Chat.Cancelled', 'Cancelled by GM')
        : _t('SPACEHOLDER.GmActions.Chat.CancelledMany', `Cancelled by GM (${counts.cancelled})`, { count: counts.cancelled }),
    });
  }
  if (counts.failed) {
    lines.push({
      status: GM_ACTION_STATUS.FAILED,
      icon: 'fa-triangle-exclamation',
      text: counts.failed === 1
        ? _t('SPACEHOLDER.GmActions.Chat.Failed', 'Action failed')
        : _t('SPACEHOLDER.GmActions.Chat.FailedMany', `Actions failed (${counts.failed})`, { count: counts.failed }),
    });
  }
  return lines;
}

/** Append the status lines to a rendered chat message (idempotent). */
export function renderGmActionStatus(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  root.querySelectorAll(`.${NOTE_CLASS}`).forEach((el) => el.remove());
  const lines = describeGmActionStatuses(message?.flags?.[GM_ACTION_SCOPE]?.[GM_CHAT_FLAG]);
  if (!lines.length) return;
  const host = root.querySelector('.message-content') ?? root;
  for (const line of lines) {
    const el = document.createElement('div');
    el.className = `${NOTE_CLASS} ${NOTE_CLASS}--${line.status}`;
    const icon = document.createElement('i');
    icon.className = `fa-solid ${line.icon}`;
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = line.text;
    el.append(icon, text);
    host.append(el);
  }
}

export function installGmActionChatHook() {
  Hooks.on('renderChatMessageHTML', (message, html) => {
    try {
      renderGmActionStatus(message, html);
    } catch (error) {
      console.error('SpaceHolder | gm-actions: chat note failed', error);
    }
  });
}

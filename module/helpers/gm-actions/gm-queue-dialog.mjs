/**
 * GM actions — the "Player actions while you were away" window.
 *
 * Entries are grouped by category (damage, global map, …). The GM unticks what should not happen:
 * ticked entries are applied (chronologically), unticked ones are cancelled — the matching chat
 * notes switch to "Cancelled by GM". "Later" keeps the whole queue as it is.
 */

import { groupEntriesByCategory } from './gm-actions-core.mjs';

const TEMPLATE = 'systems/spaceholder/templates/gm-actions/queue-dialog.hbs';

/** @type {Promise<object|null>|null} */
let _open = null;

function _L(key, fallback = '') {
  const v = game?.i18n?.localize?.(key);
  return v && v !== key ? v : fallback;
}

function _categoryLabel(category) {
  return _L(`SPACEHOLDER.GmActions.Category.${category}`, category);
}

function _formatTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString(game.i18n?.lang || undefined, { hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

/**
 * Open the queue window. Returns the processing summary, or `null` when nothing was applied
 * (empty queue, "Later", or the window was closed). Only one window is open at a time.
 *
 * @param {import('./gm-action-manager.mjs').GmActionManager} manager
 * @returns {Promise<{applied: number, cancelled: number, failed: number}|null>}
 */
export function openGmQueueDialog(manager) {
  if (_open) return _open;
  _open = _openImpl(manager).finally(() => { _open = null; });
  return _open;
}

async function _openImpl(manager) {
  const entries = manager.listQueue();
  if (!entries.length) {
    ui.notifications?.info?.(_L('SPACEHOLDER.GmActions.Queue.Empty', 'No player actions are waiting.'));
    return null;
  }

  const groups = groupEntriesByCategory(entries).map(({ category, entries: list }) => ({
    category,
    label: _categoryLabel(category),
    entries: list.map((e) => ({
      id: e.id,
      requesterName: e.requesterName || e.requesterId,
      label: e.label || e.type,
      time: _formatTime(e.createdAt),
    })),
  }));
  const content = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
    hint: _L('SPACEHOLDER.GmActions.Queue.Hint', 'Untick what should not happen: unticked actions are cancelled.'),
    groups,
  });

  const picked = await foundry.applications.api.DialogV2.wait({
    classes: ['spaceholder'],
    window: {
      title: _L('SPACEHOLDER.GmActions.Queue.Title', 'Player actions while you were away'),
      icon: 'fa-solid fa-inbox',
    },
    position: { width: 540 },
    content,
    rejectClose: false,
    render: (_event, dialog) => {
      const root = dialog.element;
      // A group checkbox ticks / unticks all of its entries; it reflects "all ticked".
      root.querySelectorAll('.spaceholder-gm-queue__group').forEach((group) => {
        const toggle = group.querySelector('.spaceholder-gm-queue__group-toggle');
        const rows = [...group.querySelectorAll('input[name="entry"]')];
        toggle?.addEventListener('change', () => rows.forEach((r) => { r.checked = toggle.checked; }));
        rows.forEach((r) => r.addEventListener('change', () => {
          if (toggle) toggle.checked = rows.every((x) => x.checked);
        }));
      });
    },
    buttons: [
      {
        action: 'apply',
        label: _L('SPACEHOLDER.GmActions.Queue.Apply', 'Apply selected'),
        icon: 'fa-solid fa-check',
        default: true,
        callback: (_event, button) => [...button.form.querySelectorAll('input[name="entry"]:checked')].map((el) => el.value),
      },
      {
        action: 'later',
        label: _L('SPACEHOLDER.GmActions.Queue.Later', 'Later'),
        icon: 'fa-solid fa-clock',
      },
    ],
  });

  if (!Array.isArray(picked)) return null; // "Later" or closed: the queue stays as it is
  const result = await manager.processQueue({ selectedIds: picked });
  ui.notifications?.info?.(game.i18n?.format?.('SPACEHOLDER.GmActions.Queue.Summary', {
    applied: result.applied,
    cancelled: result.cancelled,
    failed: result.failed,
  }) ?? `Applied ${result.applied}, cancelled ${result.cancelled}, failed ${result.failed}.`);
  return result;
}

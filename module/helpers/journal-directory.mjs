/**
 * Journal Directory helpers
 *
 * Добавляет кнопку «Очистить журналы» рядом с Create Entry / Create Folder.
 */

let _hooksInstalled = false;

/**
 * Установить хуки для Journal Directory.
 */
function _isTimelineContainer(entry) {
  try {
    const f1 = entry?.getFlag?.('spaceholder', 'timeline') ?? entry?.flags?.spaceholder?.timeline ?? {};
    const f2 = entry?.getFlag?.('spaceholder', 'timelineV2') ?? entry?.flags?.spaceholder?.timelineV2 ?? {};
    return !!(f1?.isContainer || f2?.isContainer);
  } catch (_) {
    return false;
  }
}

function _isTimelineFolder(folder) {
  try {
    const f1 = folder?.getFlag?.('spaceholder', 'timeline') ?? folder?.flags?.spaceholder?.timeline ?? {};
    const f2 = folder?.getFlag?.('spaceholder', 'timelineV2') ?? folder?.flags?.spaceholder?.timelineV2 ?? {};
    return !!(f1?.isFolder || f2?.isFolder);
  } catch (_) {
    return false;
  }
}

function _hideTimelineFoldersFromDirectory(root) {
  if (!root) return;

  const items = root.querySelectorAll('.directory-item.folder[data-folder-id]');
  for (const li of items) {
    const folderId = li?.dataset?.folderId;
    if (!folderId) continue;

    const folder = game?.folders?.get?.(folderId) ?? null;
    if (!folder) continue;

    if (_isTimelineFolder(folder)) {
      li.remove();
    }
  }
}

function _hideTimelineContainersFromDirectory(root) {
  if (!root) return;

  // Foundry directory items for journal entries use data-entry-id.
  const items = root.querySelectorAll('.directory-item[data-entry-id]');
  for (const li of items) {
    const entryId = li?.dataset?.entryId;
    if (!entryId) continue;

    const entry = game?.journal?.get?.(entryId) ?? null;
    if (!entry) continue;

    if (_isTimelineContainer(entry)) {
      li.remove();
    }
  }
}

export function installJournalDirectoryHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

Hooks.on('renderJournalDirectory', (app, html /*, data */) => {
    try {
      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!root) return;

      // Hide timeline containers and their folder from non-GM even if they have edit rights.
      if (!game?.user?.isGM) {
        _hideTimelineFoldersFromDirectory(root);
        _hideTimelineContainersFromDirectory(root);
        return;
      }

      // Найдём контейнер, где лежат core-кнопки Create Entry / Create Folder.
      const header = root.querySelector('.directory-header') || root.querySelector('header') || root;

      // 1) Пытаемся найти стандартный контейнер действий.
      let actions = header.querySelector('.header-actions')
        || header.querySelector('.action-buttons')
        || header.querySelector('.header-controls');

      // 2) Если не нашли — ищем по существующим кнопкам создания и берём их родителя.
      if (!actions) {
        const createBtn = header.querySelector(
          '[data-action="createEntry"], [data-action="create-entry"], [data-action="createFolder"], [data-action="create-folder"], .create-entry, .create-folder'
        );
        actions = createBtn?.parentElement ?? null;
      }

      if (!actions) return;

      // Не добавляем кнопку повторно.
      if (actions.querySelector('.spaceholder-clear-journals')) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.classList.add('spaceholder-clear-journals');
      btn.title = 'Удалить все журналы';
      btn.innerHTML = '<i class="fas fa-trash"></i> Очистить журналы';

      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        if (!game?.user?.isGM) {
          ui.notifications?.warn?.('Только GM может очищать журналы');
          return;
        }

        await clearAllJournalsWithConfirm();
      });

      actions.appendChild(btn);
    } catch (e) {
      console.error('SpaceHolder | Failed to inject Clear Journals button', e);
    }
  });
}

async function clearAllJournalsWithConfirm() {
  const entries = Array.isArray(game?.journal?.contents) ? game.journal.contents : [];
  const foldersAll = Array.isArray(game?.folders?.contents) ? game.folders.contents : [];
  const folders = foldersAll.filter((f) => f?.type === 'JournalEntry');

  const entryCount = entries.length;
  const folderCount = folders.length;

  if (!entryCount && !folderCount) {
    ui.notifications?.info?.('Журналы уже пусты');
    return;
  }

  const content = `
    <div>
      <p><strong>Очистить журналы?</strong></p>
      <p>Будут удалены все записи журнала: <b>${entryCount}</b>${folderCount ? `, а также папки: <b>${folderCount}</b>` : ''}.</p>
      <p>Действие необратимо.</p>
    </div>
  `;

  const confirmed = await confirmDialog({
    title: 'Очистить журналы',
    content,
    yesLabel: 'Удалить',
    yesIcon: 'fa-solid fa-trash',
    noLabel: 'Отмена',
    noIcon: 'fa-solid fa-times',
  });

  if (!confirmed) return;

  // Удаляем сначала записи, затем папки (папки — от глубины к корню).
  try {
    if (entryCount) {
      const ids = entries.map((e) => e.id).filter(Boolean);
      const DocClass = globalThis.JournalEntry ?? game?.journal?.documentClass;
      if (typeof DocClass?.deleteDocuments === 'function') {
        await DocClass.deleteDocuments(ids);
      }
    }

    if (folderCount) {
      const depthOf = (f) => {
        let d = 0;
        let cur = f;
        // parent может быть в f.folder или f.parent (на разных версиях)
        while (cur?.folder || cur?.parent) {
          cur = cur.folder ?? cur.parent;
          d += 1;
          if (d > 100) break;
        }
        return d;
      };

      const folderIds = [...folders]
        .sort((a, b) => depthOf(b) - depthOf(a))
        .map((f) => f.id)
        .filter(Boolean);

      const FolderClass = globalThis.Folder ?? game?.folders?.documentClass;
      if (typeof FolderClass?.deleteDocuments === 'function') {
        await FolderClass.deleteDocuments(folderIds);
      }
    }

    ui.notifications?.info?.(`Журналы очищены (удалено записей: ${entryCount}, папок: ${folderCount})`);
  } catch (e) {
    console.error('SpaceHolder | Failed to clear journals', e);
    ui.notifications?.error?.('Не удалось очистить журналы (подробности в консоли)');
  }
}

/**
 * Единая обёртка над confirm для Foundry v13:
 * - предпочитаем DialogV2.confirm
 * - fallback на Dialog.confirm
 */
async function confirmDialog({ title, content, yesLabel, yesIcon, noLabel, noIcon }) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (DialogV2?.confirm) {
    try {
      return await new Promise((resolve) => {
        let settled = false;
        const settle = (v) => {
          if (settled) return;
          settled = true;
          resolve(!!v);
        };

        const maybePromise = DialogV2.confirm({
          window: { title, icon: yesIcon || 'fa-solid fa-question' },
          content,
          yes: {
            label: yesLabel ?? 'Да',
            icon: yesIcon ?? 'fa-solid fa-check',
            callback: () => {
              settle(true);
              return true;
            },
          },
          no: {
            label: noLabel ?? 'Нет',
            icon: noIcon ?? 'fa-solid fa-times',
            callback: () => {
              settle(false);
              return false;
            },
          },
        });

        // На случай, если confirm() возвращает Promise<boolean> и закрытие окна тоже резолвит.
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then((r) => settle(r)).catch(() => settle(false));
        }
      });
    } catch (e) {
      // ignore and fallback
    }
  }

  // Fallback
  const DialogImpl = globalThis.Dialog;
  if (typeof DialogImpl?.confirm === 'function') {
    return await DialogImpl.confirm({
      title,
      content,
      yes: () => true,
      no: () => false,
      defaultYes: false,
    });
  }

  // Last resort
  return globalThis.confirm?.(title) ?? false;
}

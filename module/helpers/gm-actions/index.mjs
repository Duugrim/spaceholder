/**
 * GM actions — entry point. `installGmActions()` runs on every client at `ready`:
 * it creates the manager, registers the system's action types, listens on the socket, installs
 * the chat note and, on the GM client, offers the login backlog.
 *
 * Public API (`game.spaceholder.gmActions`):
 * - `request(type, payload, { label?, chatMessageId? })` — do something with GM permissions
 * - `register(type, { category?, handler, validate? })` — add an action type (on every client)
 * - `listQueue()` / `openQueue()` — the parked actions / the GM window (GM only)
 */

import { GmActionManager } from './gm-action-manager.mjs';
import { createFoundryGmActionEnv, gmActionSocketName } from './gm-action-env.mjs';
import { installGmActionChatHook } from './gm-action-chat.mjs';
import { registerBuiltinGmActions, GM_ACTION_TYPES, GM_ACTION_CATEGORIES } from './gm-action-handlers.mjs';
import { openGmQueueDialog } from './gm-queue-dialog.mjs';
import { GM_ACTION_SCOPE, GM_QUEUE_FLAG } from './gm-actions-core.mjs';

export { GM_ACTION_TYPES, GM_ACTION_CATEGORIES };

/** @type {GmActionManager|null} */
let _manager = null;

/** @returns {GmActionManager|null} the manager once installed */
export function getGmActionManager() {
  return _manager;
}

export function installGmActions() {
  if (_manager) return _manager;
  const manager = new GmActionManager(createFoundryGmActionEnv());
  _manager = manager;
  registerBuiltinGmActions(manager);

  game.spaceholder = game.spaceholder ?? {};
  game.spaceholder.gmActions = {
    manager,
    request: (type, payload, opts) => manager.request(type, payload, opts),
    register: (type, def) => manager.register(type, def),
    listQueue: () => manager.listQueue(),
    openQueue: () => openGmQueueDialog(manager),
  };

  try {
    game.socket.on(gmActionSocketName(), (msg) => {
      manager.handleMessage(msg).catch((error) => console.error('SpaceHolder | gm-actions: message failed', error));
    });
  } catch (error) {
    console.error('SpaceHolder | gm-actions: socket unavailable', error);
  }

  installGmActionChatHook();

  if (game.user?.isGM) {
    // Entries that show up while this GM is online (a client lost the GM for a moment) run by themselves.
    Hooks.on('updateUser', (_user, changes) => {
      if (!foundry.utils.hasProperty(changes ?? {}, `flags.${GM_ACTION_SCOPE}.${GM_QUEUE_FLAG}`)) return;
      manager.processLive().catch((error) => console.error('SpaceHolder | gm-actions: live queue failed', error));
    });

    // The backlog from when no GM was around: only the designated GM is asked, once, at login.
    const backlog = manager.listQueue();
    manager.deferEntries(backlog.map((e) => e.id));
    if (backlog.length && game.user.id === game.users?.activeGM?.id) {
      openGmQueueDialog(manager).catch((error) => console.error('SpaceHolder | gm-actions: queue window failed', error));
    }
  }
  return manager;
}

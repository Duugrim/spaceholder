import { ITEM_PILES_SH } from './constants.mjs';
import { ItemPilesShApi } from './api.mjs';
import { ItemPilesShPrivateApi } from './private-api.mjs';
import { installItemPilesShSocketAdapter, registerItemPilesShSocketAction } from './socket-adapter.mjs';

let _bootstrapped = false;

function _registerSettings() {
  game.settings.register('spaceholder', 'itemPilesShEnabled', {
    name: 'SPACEHOLDER.ItemPilesSh.Settings.Enabled.Name',
    hint: 'SPACEHOLDER.ItemPilesSh.Settings.Enabled.Hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register('spaceholder', 'itemPilesShDebug', {
    name: 'SPACEHOLDER.ItemPilesSh.Settings.Debug.Name',
    hint: 'SPACEHOLDER.ItemPilesSh.Settings.Debug.Hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });
}

export function registerItemPilesShSettings() {
  _registerSettings();
}

export function initializeItemPilesSh() {
  if (_bootstrapped) return;
  _bootstrapped = true;

  if (!game.settings.get('spaceholder', 'itemPilesShEnabled')) {
    console.log('SpaceHolder | item-piles-sh disabled by setting');
    return;
  }

  installItemPilesShSocketAdapter();

  registerItemPilesShSocketAction(ITEM_PILES_SH.SOCKET_ACTION_DROP_ITEM, (payload) => ItemPilesShPrivateApi.dropData(payload));
  registerItemPilesShSocketAction(ITEM_PILES_SH.SOCKET_ACTION_CREATE_PILE, (payload) => ItemPilesShPrivateApi.createPile(payload));
  registerItemPilesShSocketAction(ITEM_PILES_SH.SOCKET_ACTION_TRANSFER_ITEM, (payload, meta) => ItemPilesShPrivateApi.transferItem(payload, meta));
  registerItemPilesShSocketAction(ITEM_PILES_SH.SOCKET_ACTION_TRANSFER_ALL, (payload, meta) => ItemPilesShPrivateApi.transferAll(payload, meta));
  registerItemPilesShSocketAction(ITEM_PILES_SH.SOCKET_ACTION_SPLIT_ITEM, (payload, meta) => ItemPilesShPrivateApi.splitItem(payload, meta));
  registerItemPilesShSocketAction(ITEM_PILES_SH.SOCKET_ACTION_OPEN_PILE, (payload, meta) => ItemPilesShPrivateApi.canOpenPile(payload, meta));

  ItemPilesShPrivateApi.initialize();

  game.spaceholder = game.spaceholder || {};
  game.spaceholder.itemPilesSh = {
    api: ItemPilesShApi,
    privateApi: ItemPilesShPrivateApi,
    constants: ITEM_PILES_SH,
  };

  if (game.settings.get('spaceholder', 'itemPilesShDebug')) {
    console.log('SpaceHolder | item-piles-sh initialized', game.spaceholder.itemPilesSh);
  }
}

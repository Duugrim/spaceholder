export const ITEM_PILES_SH = {
  MODULE_ID: 'item-piles-sh',
  MODULE_NS: 'spaceholder',
  FLAG_SCOPE: 'spaceholder',
  FLAG_ROOT: 'itemPilesSh',
  SOCKET_TYPE: 'spaceholder.item-piles-sh',
  SOCKET_OP_REQUEST: 'request',
  SOCKET_OP_RESPONSE: 'response',
  SOCKET_ACTION_DROP_ITEM: 'DROP_ITEM',
  SOCKET_ACTION_CREATE_PILE: 'CREATE_PILE',
  SOCKET_ACTION_TRANSFER_ITEM: 'TRANSFER_ITEM',
  SOCKET_ACTION_TRANSFER_ALL: 'TRANSFER_ALL',
  SOCKET_ACTION_SPLIT_ITEM: 'SPLIT_ITEM',
  SOCKET_ACTION_OPEN_PILE: 'OPEN_PILE',
  PILE_DEFAULT_NAME: 'Item Pile',
  PILE_GENERIC_ACTOR_NAME: 'Generic Item Pile',
  PILE_TECH_FOLDER_NAME: 'SH Hidden',
  PILE_DEFAULT_ACTOR_TYPE: 'loot',
  PILE_DEFAULT_TOKEN_TEXTURE: 'icons/svg/chest.svg',
  PILE_MERGE_DISTANCE_MULTIPLIER: 0.5,
};

export function getSystemSocketName() {
  try {
    return `system.${game.system.id}`;
  } catch (_) {
    return `system.${ITEM_PILES_SH.MODULE_NS}`;
  }
}

export function getPileFlagPath() {
  return `flags.${ITEM_PILES_SH.FLAG_SCOPE}.${ITEM_PILES_SH.FLAG_ROOT}.isPile`;
}

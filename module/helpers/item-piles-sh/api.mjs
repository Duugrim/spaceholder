import { ITEM_PILES_SH } from './constants.mjs';
import { executeItemPilesShAsGm } from './socket-adapter.mjs';

export const ItemPilesShApi = {
  /**
   * Create a new pile token with supplied item data.
   * @param {object} params
   * @returns {Promise<{tokenId: string | null, actorId: string | null}>}
   */
  async createItemPile(params = {}) {
    return executeItemPilesShAsGm(ITEM_PILES_SH.SOCKET_ACTION_CREATE_PILE, params);
  },

  /**
   * Execute item drop payload through the same flow as canvas drop.
   * @param {object} params
   * @returns {Promise<object>}
   */
  async dropData(params = {}) {
    return executeItemPilesShAsGm(ITEM_PILES_SH.SOCKET_ACTION_DROP_ITEM, params);
  },

  async transferItem(params = {}) {
    return executeItemPilesShAsGm(ITEM_PILES_SH.SOCKET_ACTION_TRANSFER_ITEM, params);
  },

  async transferAll(params = {}) {
    return executeItemPilesShAsGm(ITEM_PILES_SH.SOCKET_ACTION_TRANSFER_ALL, params);
  },

  async splitItem(params = {}) {
    return executeItemPilesShAsGm(ITEM_PILES_SH.SOCKET_ACTION_SPLIT_ITEM, params);
  },

  async openPile(params = {}) {
    return executeItemPilesShAsGm(ITEM_PILES_SH.SOCKET_ACTION_OPEN_PILE, params);
  },

  async canOpenPile(params = {}) {
    return executeItemPilesShAsGm(ITEM_PILES_SH.SOCKET_ACTION_OPEN_PILE, params);
  },
};

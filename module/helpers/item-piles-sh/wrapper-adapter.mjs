import { ITEM_PILES_SH } from './constants.mjs';

let _warnedNoLibWrapper = false;

function _getLibWrapper() {
  return globalThis.libWrapper ?? null;
}

export function registerItemPilesShWrapper(target, fn, type = 'WRAPPER') {
  const lib = _getLibWrapper();
  if (lib?.register) {
    lib.register(ITEM_PILES_SH.MODULE_ID, target, fn, type);
    return true;
  }
  if (!_warnedNoLibWrapper) {
    _warnedNoLibWrapper = true;
    console.warn('SpaceHolder | item-piles-sh: libWrapper not found, using no-op wrapper adapter');
  }
  return false;
}

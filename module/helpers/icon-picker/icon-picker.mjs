// Icon Picker API (SpaceHolder, Foundry v13)

import { ensureIconLibraryDirs, getIconIndex } from '../icon-library/icon-library.mjs';
import { bakeSvgToGenerated } from '../icon-library/svg-bake.mjs';
import { IconPickerApp } from './icon-picker-app.mjs';

function _L(key) {
  try { return game.i18n.localize(key); } catch (_) { return key; }
}

export async function pickIcon({ root = null, defaultColor = '#ffffff', title = null } = {}) {
  await ensureIconLibraryDirs({ root });

  const loadIcons = async () => {
    return await getIconIndex({ root, force: true, extensions: ['.svg'] });
  };

  let icons = [];
  try {
    icons = await loadIcons();
  } catch (e) {
    console.error('SpaceHolder | IconPicker: failed to load index', e);
    ui.notifications?.error?.(_L('SPACEHOLDER.IconPicker.Errors.LoadFailed'));
    icons = [];
  }

  const selection = await IconPickerApp.wait({
    icons,
    title,
    defaultColor,
    loadIcons,
  });

  if (!selection) return null;

  try {
    return await bakeSvgToGenerated({
      srcPath: selection.srcPath,
      color: selection.color,
      root,
    });
  } catch (e) {
    console.error('SpaceHolder | IconPicker: bake failed', e);
    ui.notifications?.error?.(_L('SPACEHOLDER.IconPicker.Errors.BakeFailed'));
    return null;
  }
}

// Icon Picker API (SpaceHolder, Foundry v13)

import { ensureIconLibraryDirs, getIconLibraryDirs, getIconIndex } from '../icon-library/icon-library.mjs';
import { bakeSvgToGenerated, computeBakeHash, extractBakeMeta, normalizeHexColor } from '../icon-library/svg-bake.mjs';
import { IconPickerApp } from './icon-picker-app.mjs';

function _L(key) {
  try { return game.i18n.localize(key); } catch (_) { return key; }
}

function _trimSlash(path) {
  return String(path ?? '').trim().replace(/\/+$/g, '');
}

function _toFetchUrl(path) {
  const p = String(path ?? '').trim();
  if (!p) return '';
  if (p.startsWith('/')) return p;
  if (/^[a-zA-Z]+:/.test(p)) return p;
  return `/${p}`;
}

function _isUnderPath(filePath, dirPath) {
  const fp = _trimSlash(filePath).toLowerCase();
  const dp = _trimSlash(dirPath).toLowerCase();
  if (!fp || !dp) return false;
  return fp === dp || fp.startsWith(`${dp}/`);
}

function _parseGeneratedName(path) {
  const p = String(path ?? '').trim();
  const m = p.match(/__([0-9a-fA-F]{6})__([0-9a-fA-F]{8})\.svg$/);
  if (!m) return null;
  return { color: `#${m[1].toLowerCase()}`, hash: m[2].toLowerCase() };
}

async function _tryResolveGeneratedSource({ pickedPath, root }) {
  const { generated } = getIconLibraryDirs({ root });
  if (!_isUnderPath(pickedPath, generated)) return null;

  // 1) Fast path: baked meta inside the SVG.
  try {
    const res = await fetch(_toFetchUrl(pickedPath));
    if (res?.ok) {
      const txt = await res.text();
      const meta = extractBakeMeta(txt);
      if (meta?.srcPath) {
        return {
          srcPath: String(meta.srcPath).trim(),
          bakedColor: String(meta.color ?? '').trim().toLowerCase(),
        };
      }
    }
  } catch (_) {
    // ignore
  }

  // 2) Fallback: parse name and brute-force match against source index.
  const parsed = _parseGeneratedName(pickedPath);
  if (!parsed) return null;

  let icons = [];
  try {
    icons = await getIconIndex({ root, force: true, extensions: ['.svg'] });
  } catch (_) {
    icons = [];
  }

  for (const ic of icons) {
    const cand = String(ic?.path ?? '').trim();
    if (!cand) continue;
    const h = computeBakeHash({ srcPath: cand, color: parsed.color, version: 'v1' });
    if (h === parsed.hash) {
      return { srcPath: cand, bakedColor: parsed.color };
    }
  }

  return { srcPath: String(pickedPath).trim(), bakedColor: parsed.color };
}

export async function pickIcon({ root = null, defaultColor = '#ffffff', title = null } = {}) {
  await ensureIconLibraryDirs({ root });

  const { source } = getIconLibraryDirs({ root });

  const selection = await IconPickerApp.wait({
    title,
    defaultColor,
    startDir: source,
    autoOpenFilePicker: true,
  });

  if (!selection) return null;

  const pickedPath = String(selection.srcPath ?? '').trim();
  if (!pickedPath) return null;

  const chosenColor = normalizeHexColor(selection.color, normalizeHexColor(defaultColor));

  const resolved = await _tryResolveGeneratedSource({ pickedPath, root });
  if (resolved?.bakedColor && resolved.bakedColor === chosenColor.toLowerCase()) {
    // The user selected an already-baked icon of the same color.
    return pickedPath;
  }

  const srcPath = String(resolved?.srcPath ?? pickedPath).trim();

  try {
    return await bakeSvgToGenerated({ srcPath, color: chosenColor, root });
  } catch (e) {
    console.error('SpaceHolder | IconPicker: bake failed', e);
    ui.notifications?.error?.(_L('SPACEHOLDER.IconPicker.Errors.BakeFailed'));
    return null;
  }
}

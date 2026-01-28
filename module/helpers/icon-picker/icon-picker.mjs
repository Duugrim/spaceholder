// Icon Picker API (SpaceHolder, Foundry v13)

import { ensureIconLibraryDirs, getIconLibraryDirs, getIconIndex } from '../icon-library/icon-library.mjs';
import {
  bakeSvgToGenerated,
  computeBakeHash,
  extractBakeMeta,
  normalizeBakeOptions,
  normalizeHexColor,
} from '../icon-library/svg-bake.mjs';
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
          bakedOpts: meta?.opts ?? null,
          bakedVersion: String(meta?.version ?? '').trim(),
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

function _isLegacyEquivalentBakeOpts(opts) {
  const o = normalizeBakeOptions(opts);
  return !o.background.enabled
    && !o.icon.stroke.enabled
    && Number(o.icon.opacity) === 1;
}

function _sameBakeOpts(a, b) {
  // normalizeBakeOptions returns a stable object (fixed key order) so JSON stringify is ok.
  try {
    return JSON.stringify(normalizeBakeOptions(a)) === JSON.stringify(normalizeBakeOptions(b));
  } catch (_) {
    return false;
  }
}

async function _resolveInitialIconForEdit({ initialPath, defaultColor = '#ffffff' } = {}) {
  const p = String(initialPath ?? '').trim();
  if (!p) return null;
  if (!p.toLowerCase().endsWith('.svg')) return null;

  // Try meta first: works for both generated/ and any baked svg.
  try {
    const res = await fetch(_toFetchUrl(p));
    if (res?.ok) {
      const txt = await res.text();
      const meta = extractBakeMeta(txt);
      if (meta?.srcPath) {
        const opts = meta?.opts ?? (meta?.color ? normalizeBakeOptions({ icon: { color: meta.color } }, { fallbackColor: defaultColor }) : null);
        return {
          srcPath: String(meta.srcPath).trim(),
          opts,
        };
      }
    }
  } catch (_) {
    // ignore
  }

  // Fallback: treat as direct source path.
  return {
    srcPath: p,
    opts: null,
  };
}

export async function pickIcon({
  root = null,
  defaultColor = '#ffffff',
  title = null,
  factionColor = null,
  initialPath = null,
  initialOpts = null,
} = {}) {
  await ensureIconLibraryDirs({ root });

  const { source } = getIconLibraryDirs({ root });

  let initial = null;
  if (initialPath) {
    initial = await _resolveInitialIconForEdit({ initialPath, defaultColor });
  }

  const effectiveInitialPath = String(initial?.srcPath ?? '').trim();
  const effectiveInitialOpts = initialOpts ?? initial?.opts ?? null;

  // Prefer initial opts color as the starting picker color, so UI matches the icon.
  let effectiveDefaultColor = defaultColor;
  try {
    if (effectiveInitialOpts?.icon?.color) effectiveDefaultColor = effectiveInitialOpts.icon.color;
  } catch (_) {
    // ignore
  }

  const selection = await IconPickerApp.wait({
    title,
    defaultColor: effectiveDefaultColor,
    factionColor,
    startDir: source,
    autoOpenFilePicker: !effectiveInitialPath,
    initialPath: effectiveInitialPath || null,
    initialOpts: effectiveInitialOpts,
  });

  if (!selection) return null;

  const pickedPath = String(selection.srcPath ?? '').trim();
  if (!pickedPath) return null;

  const chosenColor = normalizeHexColor(selection.color, normalizeHexColor(defaultColor));

  // v2: selection can include full bake options.
  const requestedOpts = normalizeBakeOptions(selection.opts ?? selection.style ?? selection, { fallbackColor: chosenColor });
  requestedOpts.icon.color = chosenColor;

  const resolved = await _tryResolveGeneratedSource({ pickedPath, root });
  if (resolved?.bakedColor && resolved.bakedColor === chosenColor.toLowerCase()) {
    // The user selected an already-baked icon of the same color.
    // Reuse only if bake opts match (or legacy baked icon & requested opts are legacy-equivalent).
    if (resolved?.bakedOpts) {
      if (_sameBakeOpts(resolved.bakedOpts, requestedOpts)) return pickedPath;
    } else if (_isLegacyEquivalentBakeOpts(requestedOpts)) {
      return pickedPath;
    }
  }

  const srcPath = String(resolved?.srcPath ?? pickedPath).trim();

  try {
    return await bakeSvgToGenerated({ srcPath, color: chosenColor, opts: requestedOpts, root });
  } catch (e) {
    console.error('SpaceHolder | IconPicker: bake failed', e);
    ui.notifications?.error?.(_L('SPACEHOLDER.IconPicker.Errors.BakeFailed'));
    return null;
  }
}

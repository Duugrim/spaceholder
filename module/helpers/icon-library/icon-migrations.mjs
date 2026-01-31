// Icon library migrations (SpaceHolder, Foundry v13)
// Purpose: keep existing baked icons compatible with current rendering decisions.

import { ensureIconLibraryDirs, getIconLibraryDirs } from './icon-library.mjs';

const MODULE_NS = 'spaceholder';
const SETTING_REMOVE_NON_SCALING_STROKE = 'iconLibrary.migrations.removeNonScalingStroke.v1';
const SETTING_INSET_BG_STROKE = 'iconLibrary.migrations.insetBackgroundStroke.v1';

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

function _getFilePickerImpl() {
  return foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

function _splitDirAndFile(filePath) {
  const parts = String(filePath ?? '').split('/').filter((p) => p.length);
  const file = parts.pop() ?? '';
  const dir = parts.join('/');
  return { dir, file };
}

async function _browseRecursive(dir, { outFiles, seenDirs } = {}) {
  const d = _trimSlash(dir);
  if (!d) return;

  if (seenDirs.has(d)) return;
  seenDirs.add(d);

  const FP = _getFilePickerImpl();
  if (!FP?.browse) return;

  let res = null;
  try {
    res = await FP.browse('data', d);
  } catch (_) {
    return;
  }

  const files = Array.isArray(res?.files) ? res.files : [];
  for (const f of files) {
    const fp = String(f ?? '').trim();
    if (!fp) continue;
    if (fp.toLowerCase().endsWith('.svg')) outFiles.push(fp);
  }

  const dirs = Array.isArray(res?.dirs) ? res.dirs : [];
  for (const child of dirs) {
    await _browseRecursive(child, { outFiles, seenDirs });
  }
}

function _removeNonScalingStroke(svgText) {
  const raw = String(svgText ?? '');

  let doc = null;
  try {
    doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  } catch (_) {
    return { changed: false, text: raw };
  }

  const svg = doc?.querySelector?.('svg');
  if (!svg) return { changed: false, text: raw };

  const els = Array.from(doc.querySelectorAll('[vector-effect="non-scaling-stroke"]'));
  if (!els.length) return { changed: false, text: raw };

  for (const el of els) {
    try { el.removeAttribute('vector-effect'); } catch (_) { /* ignore */ }
  }

  try {
    return { changed: true, text: new XMLSerializer().serializeToString(svg) };
  } catch (_) {
    return { changed: false, text: raw };
  }
}

function _numAttr(el, name) {
  const v = String(el?.getAttribute?.(name) ?? '').trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _setNumAttr(el, name, value) {
  if (!el?.setAttribute) return;
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  el.setAttribute(name, String(n));
}

function _insetBgStroke(svgText) {
  const raw = String(svgText ?? '');

  let doc = null;
  try {
    doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  } catch (_) {
    return { changed: false, text: raw };
  }

  const svg = doc?.querySelector?.('svg');
  if (!svg) return { changed: false, text: raw };

  const bg = svg.querySelector?.('[data-sh-role="bg"]');
  if (!bg) return { changed: false, text: raw };

  // Already migrated / already baked with inset.
  if (String(bg.getAttribute?.('data-sh-bg-stroke-inset') ?? '') === '1') {
    return { changed: false, text: raw };
  }

  const sw = _numAttr(bg, 'stroke-width');
  if (!sw || sw <= 0) return { changed: false, text: raw };

  const delta = sw / 2;

  const tag = String(bg.tagName ?? '').toLowerCase();
  let changed = false;

  if (tag === 'rect') {
    const x = _numAttr(bg, 'x') ?? 0;
    const y = _numAttr(bg, 'y') ?? 0;
    const w = _numAttr(bg, 'width');
    const h = _numAttr(bg, 'height');
    if (w === null || h === null) return { changed: false, text: raw };

    const nw = w - sw;
    const nh = h - sw;
    if (nw <= 0 || nh <= 0) return { changed: false, text: raw };

    _setNumAttr(bg, 'x', x + delta);
    _setNumAttr(bg, 'y', y + delta);
    _setNumAttr(bg, 'width', nw);
    _setNumAttr(bg, 'height', nh);

    // Rounded rect: shrink radii a bit to keep visual parity.
    const rx = _numAttr(bg, 'rx');
    const ry = _numAttr(bg, 'ry');
    if (rx !== null) _setNumAttr(bg, 'rx', Math.max(0, rx - delta));
    if (ry !== null) _setNumAttr(bg, 'ry', Math.max(0, ry - delta));

    changed = true;
  } else if (tag === 'circle') {
    const r = _numAttr(bg, 'r');
    if (r === null) return { changed: false, text: raw };
    const nr = r - delta;
    if (nr <= 0) return { changed: false, text: raw };
    _setNumAttr(bg, 'r', nr);
    changed = true;
  } else if (tag === 'polygon') {
    const ptsRaw = String(bg.getAttribute('points') ?? '').trim();
    if (!ptsRaw) return { changed: false, text: raw };

    const pts = ptsRaw
      .split(/[\s]+/)
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [xs, ys] = pair.split(',');
        const x = Number(xs);
        const y = Number(ys);
        return (Number.isFinite(x) && Number.isFinite(y)) ? { x, y } : null;
      })
      .filter(Boolean);

    if (pts.length < 3) return { changed: false, text: raw };

    let minX = pts[0].x;
    let maxX = pts[0].x;
    let minY = pts[0].y;
    let maxY = pts[0].y;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const w = maxX - minX;
    const h = maxY - minY;
    if (w <= sw || h <= sw) return { changed: false, text: raw };

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const sx = (w - sw) / w;
    const sy = (h - sw) / h;

    const nextPts = pts.map((p) => ({
      x: cx + (p.x - cx) * sx,
      y: cy + (p.y - cy) * sy,
    }));

    const nextStr = nextPts.map((p) => `${p.x},${p.y}`).join(' ');
    bg.setAttribute('points', nextStr);
    changed = true;
  }

  if (!changed) return { changed: false, text: raw };

  try { bg.setAttribute('data-sh-bg-stroke-inset', '1'); } catch (_) { /* ignore */ }

  try {
    return { changed: true, text: new XMLSerializer().serializeToString(svg) };
  } catch (_) {
    return { changed: false, text: raw };
  }
}

export function registerIconLibraryMigrationSettings() {
  if (!game?.settings?.register) return;

  try {
    game.settings.register(MODULE_NS, SETTING_REMOVE_NON_SCALING_STROKE, {
      name: 'SpaceHolder: Icon Library migration (remove non-scaling stroke)',
      hint: 'Internal flag. Set automatically after migrating generated SVGs.',
      scope: 'world',
      config: false,
      type: Boolean,
      default: false,
    });
  } catch (_) {
    // ignore double-register
  }

  try {
    game.settings.register(MODULE_NS, SETTING_INSET_BG_STROKE, {
      name: 'SpaceHolder: Icon Library migration (inset background stroke)',
      hint: 'Internal flag. Set automatically after migrating generated SVGs.',
      scope: 'world',
      config: false,
      type: Boolean,
      default: false,
    });
  } catch (_) {
    // ignore double-register
  }
}

export async function migrateIconLibraryGeneratedSvgsRemoveNonScalingStroke({ root = null, force = false } = {}) {
  // Only GM should mutate world files.
  if (!game?.user?.isGM) return { skipped: true, reason: 'not-gm' };

  // Skip if already done.
  if (!force) {
    try {
      const done = Boolean(game.settings.get(MODULE_NS, SETTING_REMOVE_NON_SCALING_STROKE));
      if (done) return { skipped: true, reason: 'already-done' };
    } catch (_) {
      // ignore
    }
  }

  await ensureIconLibraryDirs({ root });
  const { generated } = getIconLibraryDirs({ root });

  const outFiles = [];
  const seenDirs = new Set();
  await _browseRecursive(generated, { outFiles, seenDirs });

  const FP = _getFilePickerImpl();
  if (!FP?.upload) return { skipped: true, reason: 'no-upload' };

  let total = 0;
  let patched = 0;

  for (const filePath of outFiles) {
    total++;

    let svgText = '';
    try {
      const res = await fetch(_toFetchUrl(filePath));
      if (!res?.ok) continue;
      svgText = await res.text();
    } catch (_) {
      continue;
    }

    const next = _removeNonScalingStroke(svgText);
    if (!next.changed) continue;

    const { dir, file } = _splitDirAndFile(filePath);
    if (!dir || !file) continue;

    try {
      const uploadFile = new File([next.text], file, { type: 'image/svg+xml' });
      await FP.upload('data', _trimSlash(dir), uploadFile, { overwrite: true });
      patched++;
    } catch (_) {
      // ignore per-file failures
    }
  }

  try {
    await game.settings.set(MODULE_NS, SETTING_REMOVE_NON_SCALING_STROKE, true);
  } catch (_) {
    // ignore
  }

  return { skipped: false, total, patched };
}

export async function migrateIconLibraryGeneratedSvgsInsetBackgroundStroke({ root = null, force = false } = {}) {
  // Only GM should mutate world files.
  if (!game?.user?.isGM) return { skipped: true, reason: 'not-gm' };

  // Skip if already done.
  if (!force) {
    try {
      const done = Boolean(game.settings.get(MODULE_NS, SETTING_INSET_BG_STROKE));
      if (done) return { skipped: true, reason: 'already-done' };
    } catch (_) {
      // ignore
    }
  }

  await ensureIconLibraryDirs({ root });
  const { generated } = getIconLibraryDirs({ root });

  const outFiles = [];
  const seenDirs = new Set();
  await _browseRecursive(generated, { outFiles, seenDirs });

  const FP = _getFilePickerImpl();
  if (!FP?.upload) return { skipped: true, reason: 'no-upload' };

  let total = 0;
  let patched = 0;

  for (const filePath of outFiles) {
    total++;

    let svgText = '';
    try {
      const res = await fetch(_toFetchUrl(filePath));
      if (!res?.ok) continue;
      svgText = await res.text();
    } catch (_) {
      continue;
    }

    const next = _insetBgStroke(svgText);
    if (!next.changed) continue;

    const { dir, file } = _splitDirAndFile(filePath);
    if (!dir || !file) continue;

    try {
      const uploadFile = new File([next.text], file, { type: 'image/svg+xml' });
      await FP.upload('data', _trimSlash(dir), uploadFile, { overwrite: true });
      patched++;
    } catch (_) {
      // ignore per-file failures
    }
  }

  try {
    await game.settings.set(MODULE_NS, SETTING_INSET_BG_STROKE, true);
  } catch (_) {
    // ignore
  }

  return { skipped: false, total, patched };
}

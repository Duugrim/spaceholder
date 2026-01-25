// SpaceHolder Icon Library (Foundry v13)
// - Stores curated source icons in the world data folder
// - Generates processed/baked variants into a separate folder

const MODULE_NS = 'spaceholder';
const SETTING_ROOT = 'iconLibrary.root';

// Cache (per-root)
let _cacheRoot = null;
let _cacheIcons = null;
let _cacheAt = 0;

function _defaultRoot() {
  const wid = String(game?.world?.id ?? '').trim();
  // Foundry data paths are served from the Data folder.
  // World folder name usually matches game.world.id.
  if (wid) return `worlds/${wid}/spaceholder/icon-library`;
  return 'worlds/_unknown_/spaceholder/icon-library';
}

function _trimSlash(path) {
  return String(path ?? '').trim().replace(/\/+$/g, '');
}

/** Register world settings for icon library. */
export function registerIconLibrarySettings() {
  if (!game?.settings?.register) return;

  try {
    game.settings.register(MODULE_NS, SETTING_ROOT, {
      name: 'SpaceHolder: Icon Library Root',
      hint: 'Data path to world icon library root (contains source/ and generated/).',
      scope: 'world',
      config: false,
      type: String,
      default: _defaultRoot(),
      onChange: () => invalidateIconIndexCache(),
    });
  } catch (_) {
    // Ignore double-register (Foundry throws if setting already exists)
  }
}

export function getIconLibraryRoot() {
  try {
    const raw = game.settings.get(MODULE_NS, SETTING_ROOT);
    const s = _trimSlash(raw);
    return s || _defaultRoot();
  } catch (_) {
    return _defaultRoot();
  }
}

export function getIconLibraryDirs({ root = null } = {}) {
  const r = _trimSlash(root ?? getIconLibraryRoot()) || _defaultRoot();
  return {
    root: r,
    source: `${r}/source`,
    generated: `${r}/generated`,
  };
}

async function _ensureDirTree(path, { source = 'data' } = {}) {
  const clean = _trimSlash(path);
  if (!clean) return false;

  const parts = clean.split('/').filter(Boolean);
  if (!parts.length) return false;

  let acc = parts[0];
  for (let i = 1; i < parts.length; i++) {
    acc = `${acc}/${parts[i]}`;
    try {
      // createDirectory is idempotent enough for our use; ignore errors.
      await FilePicker.createDirectory(source, acc, {});
    } catch (_) {
      // ignore
    }
  }

  return true;
}

/** Ensure root/source/generated directories exist (best-effort). */
export async function ensureIconLibraryDirs({ root = null } = {}) {
  const { root: r, source, generated } = getIconLibraryDirs({ root });

  // Ensure root and parents
  await _ensureDirTree(r);

  // Ensure required subfolders
  await _ensureDirTree(source);
  await _ensureDirTree(generated);
}

function _normalizeExtList(exts) {
  const out = [];
  for (const raw of (Array.isArray(exts) ? exts : [])) {
    const s = String(raw ?? '').trim().toLowerCase();
    if (!s) continue;
    out.push(s.startsWith('.') ? s : `.${s}`);
  }
  return out.length ? out : ['.svg'];
}

function _matchesExt(path, allowedExts) {
  const p = String(path ?? '').toLowerCase();
  return allowedExts.some((ext) => p.endsWith(ext));
}

async function _browseRecursive(dir, { source = 'data', allowedExts, outFiles, seenDirs }) {
  const d = _trimSlash(dir);
  if (!d) return;

  if (seenDirs.has(d)) return;
  seenDirs.add(d);

  let res = null;
  try {
    res = await FilePicker.browse(source, d);
  } catch (e) {
    // Missing directory or no permissions.
    return;
  }

  const files = Array.isArray(res?.files) ? res.files : [];
  for (const f of files) {
    if (_matchesExt(f, allowedExts)) outFiles.push(String(f));
  }

  const dirs = Array.isArray(res?.dirs) ? res.dirs : [];
  for (const child of dirs) {
    await _browseRecursive(child, { source, allowedExts, outFiles, seenDirs });
  }
}

function _splitFileName(filePath) {
  const parts = String(filePath ?? '').split('/');
  const file = parts.pop() ?? '';
  const dir = parts.join('/');
  const m = file.match(/^(.*?)(\.[^.]*)?$/);
  return {
    dir,
    file,
    base: String(m?.[1] ?? file),
    ext: String(m?.[2] ?? '').toLowerCase(),
  };
}

function _buildTags({ baseName, category }) {
  const tags = new Set();

  const addTokens = (s) => {
    for (const t of String(s ?? '')
      .toLowerCase()
      .split(/[\s\-_\/]+/)
      .map((x) => x.trim())
      .filter(Boolean)) {
      tags.add(t);
    }
  };

  addTokens(baseName);
  addTokens(category);

  return Array.from(tags.values());
}

function _toPreviewUrl(path) {
  const p = String(path ?? '').trim();
  if (!p) return '';

  // Already absolute or special scheme
  if (p.startsWith('/')) return p;
  if (/^[a-zA-Z]+:/.test(p)) return p;

  // Make absolute to the Foundry server root to avoid CSS-relative resolution
  return `/${p}`;
}

function _fileToIconMeta(filePath, sourceDir) {
  const src = _trimSlash(sourceDir);
  const fp = String(filePath);

  const rel = fp.startsWith(`${src}/`) ? fp.slice(src.length + 1) : fp;

  const relParts = rel.split('/');
  const fileName = relParts.pop() ?? rel;
  const category = relParts.join('/');

  const { base, ext } = _splitFileName(fileName);
  const tags = _buildTags({ baseName: base, category });

  return {
    id: rel,
    path: fp,
    previewUrl: _toPreviewUrl(fp),
    name: base,
    category,
    ext,
    tags,
  };
}

/**
 * Build (or return cached) icon index from the world icon library source/.
 * @returns {Promise<Array<{id:string, path:string, name:string, category:string, ext:string, tags:string[]}>>}
 */
export async function getIconIndex({ root = null, force = false, extensions = ['.svg'] } = {}) {
  const { source } = getIconLibraryDirs({ root });

  const allowedExts = _normalizeExtList(extensions);

  // Cache hit
  if (!force && _cacheIcons && _cacheRoot === source) {
    return _cacheIcons;
  }

  await ensureIconLibraryDirs({ root });

  const outFiles = [];
  const seenDirs = new Set();

  await _browseRecursive(source, { allowedExts, outFiles, seenDirs });

  const icons = outFiles
    .map((fp) => _fileToIconMeta(fp, source))
    .sort((a, b) => {
      const ca = String(a.category || '');
      const cb = String(b.category || '');
      if (ca !== cb) return ca.localeCompare(cb, 'ru');
      return String(a.name || '').localeCompare(String(b.name || ''), 'ru');
    });

  _cacheRoot = source;
  _cacheIcons = icons;
  _cacheAt = Date.now();

  return icons;
}

export function invalidateIconIndexCache() {
  _cacheRoot = null;
  _cacheIcons = null;
  _cacheAt = 0;
}

export function getIconIndexCacheInfo() {
  return {
    root: _cacheRoot,
    hasIcons: !!_cacheIcons,
    count: _cacheIcons?.length ?? 0,
    at: _cacheAt,
  };
}

// SpaceHolder SVG baking helper (Foundry v13)
// Takes a source SVG path from the icon library and writes a recolored copy into generated/.

import { ensureIconLibraryDirs, getIconLibraryDirs } from './icon-library.mjs';

function _trimSlash(path) {
  return String(path ?? '').trim().replace(/\/+$/g, '');
}

function _normalizeHexColor(raw, fallback = '#ffffff') {
  const s = String(raw ?? '').trim();
  if (!s) return fallback;

  // #rgb or #rrggbb
  const m3 = s.match(/^#([0-9a-fA-F]{3})$/);
  if (m3) {
    const h = m3[1];
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
  }

  const m6 = s.match(/^#([0-9a-fA-F]{6})$/);
  if (m6) return `#${m6[1]}`.toLowerCase();

  return fallback;
}

function _fnv1a32Hex(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV-1a 32-bit
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function _slugify(raw, { maxLen = 42 } = {}) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const out = s || 'icon';
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}

function _parseStyle(styleText) {
  const out = {};
  const s = String(styleText ?? '').trim();
  if (!s) return out;

  for (const part of s.split(';')) {
    const [kRaw, vRaw] = part.split(':');
    const k = String(kRaw ?? '').trim().toLowerCase();
    const v = String(vRaw ?? '').trim();
    if (!k) continue;
    out[k] = v;
  }

  return out;
}

function _serializeStyle(map) {
  const parts = [];
  for (const [k, v] of Object.entries(map ?? {})) {
    const kk = String(k ?? '').trim();
    const vv = String(v ?? '').trim();
    if (!kk || !vv) continue;
    parts.push(`${kk}: ${vv}`);
  }
  return parts.join('; ');
}

function _parseViewBox(svg) {
  const vb = String(svg?.getAttribute?.('viewBox') ?? '').trim();
  const parts = vb.split(/[\s,]+/).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (parts.length === 4) {
    return { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
  }

  // Fallback: width/height attrs (common on some SVGs)
  const w = Number(svg?.getAttribute?.('width'));
  const h = Number(svg?.getAttribute?.('height'));
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { minX: 0, minY: 0, width: w, height: h };
  }

  return null;
}

function _approxEq(a, b, tol = 0.5) {
  const da = Number(a);
  const db = Number(b);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return false;
  return Math.abs(da - db) <= tol;
}

function _parseLen(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.endsWith('%')) return s; // keep percentage
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function _coversViewBoxRect(el, vb) {
  if (!vb) return false;

  const xRaw = _parseLen(el.getAttribute('x'));
  const yRaw = _parseLen(el.getAttribute('y'));
  const wRaw = _parseLen(el.getAttribute('width'));
  const hRaw = _parseLen(el.getAttribute('height'));

  const xOk = (xRaw === null) ? true : (typeof xRaw === 'number' ? _approxEq(xRaw, vb.minX) : xRaw === '0%');
  const yOk = (yRaw === null) ? true : (typeof yRaw === 'number' ? _approxEq(yRaw, vb.minY) : yRaw === '0%');

  const wOk = (wRaw === null) ? false : (typeof wRaw === 'number' ? _approxEq(wRaw, vb.width) : wRaw === '100%');
  const hOk = (hRaw === null) ? false : (typeof hRaw === 'number' ? _approxEq(hRaw, vb.height) : hRaw === '100%');

  return xOk && yOk && wOk && hOk;
}

function _tokenizePath(d) {
  const re = /[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g;
  return String(d ?? '').match(re) ?? [];
}

function _coversViewBoxPath(el, vb) {
  if (!vb) return false;

  const d = el.getAttribute('d');
  if (!d) return false;

  const tokens = _tokenizePath(d);
  if (!tokens.length) return false;

  // Only handle simple rect paths made from M/m + H/h + V/v + Z/z.
  const allowedCmd = new Set(['M','m','H','h','V','v','Z','z']);
  for (const t of tokens) {
    if (/^[a-zA-Z]$/.test(t) && !allowedCmd.has(t)) return false;
  }

  let i = 0;
  let cmd = null;

  let x = 0;
  let y = 0;
  let sx = null;
  let sy = null;

  const pts = [];
  let hasClose = false;

  const nextNum = () => {
    if (i >= tokens.length) return null;
    const t = tokens[i];
    if (/^[a-zA-Z]$/.test(t)) return null;
    i++;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  while (i < tokens.length) {
    const t = tokens[i++];
    if (/^[a-zA-Z]$/.test(t)) {
      cmd = t;
    } else {
      // Implicit command repetition: step back one token and continue.
      i--;
    }

    if (!cmd) return false;

    if (cmd === 'M' || cmd === 'm') {
      const nx = nextNum();
      const ny = nextNum();
      if (nx === null || ny === null) return false;
      if (cmd === 'm') { x += nx; y += ny; } else { x = nx; y = ny; }
      sx = x; sy = y;
      pts.push({ x, y });
      continue;
    }

    if (cmd === 'H' || cmd === 'h') {
      let n;
      while ((n = nextNum()) !== null) {
        x = (cmd === 'h') ? (x + n) : n;
        pts.push({ x, y });
      }
      continue;
    }

    if (cmd === 'V' || cmd === 'v') {
      let n;
      while ((n = nextNum()) !== null) {
        y = (cmd === 'v') ? (y + n) : n;
        pts.push({ x, y });
      }
      continue;
    }

    if (cmd === 'Z' || cmd === 'z') {
      hasClose = true;
      if (sx !== null && sy !== null) {
        x = sx; y = sy;
        pts.push({ x, y });
      }
      continue;
    }
  }

  if (!hasClose || sx === null || sy === null) return false;
  if (pts.length < 4) return false;

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

  return _approxEq(minX, vb.minX) && _approxEq(minY, vb.minY)
    && _approxEq(maxX - minX, vb.width) && _approxEq(maxY - minY, vb.height);
}

function _isNoneFill(el) {
  const attr = String(el.getAttribute('fill') ?? '').trim().toLowerCase();
  if (attr === 'none') return true;

  const styleRaw = el.getAttribute('style');
  if (!styleRaw) return false;
  const map = _parseStyle(styleRaw);
  const fillV = String(map.fill ?? '').trim().toLowerCase();
  return fillV === 'none';
}

export function stripSvgBackground(svgText) {
  let doc = null;
  try {
    doc = new DOMParser().parseFromString(String(svgText ?? ''), 'image/svg+xml');
  } catch (_) {
    return String(svgText ?? '');
  }

  const svg = doc?.querySelector?.('svg');
  if (!svg) return String(svgText ?? '');

  // Ensure xmlns for safety
  if (!svg.getAttribute('xmlns')) {
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }

  const vb = _parseViewBox(svg);

  const selector = [
    'path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line',
  ].join(',');

  const els = Array.from(svg.querySelectorAll(selector));
  if (els.length <= 1) {
    // Avoid stripping the whole icon if the icon is literally a square.
    return new XMLSerializer().serializeToString(svg);
  }

  for (const el of els) {
    const tag = String(el.tagName ?? '').toLowerCase();

    // Do not strip outline-only rects
    if (_isNoneFill(el)) continue;

    const isBg = (tag === 'rect')
      ? _coversViewBoxRect(el, vb)
      : (tag === 'path')
        ? _coversViewBoxPath(el, vb)
        : false;

    if (isBg) {
      try { el.remove(); } catch (_) { /* ignore */ }
    }
  }

  try {
    return new XMLSerializer().serializeToString(svg);
  } catch (_) {
    return String(svgText ?? '');
  }
}

export function recolorSvg(svgText, { color = '#ffffff' } = {}) {
  const fillColor = _normalizeHexColor(color);

  let doc = null;
  try {
    doc = new DOMParser().parseFromString(String(svgText ?? ''), 'image/svg+xml');
  } catch (_) {
    return String(svgText ?? '');
  }

  const svg = doc?.querySelector?.('svg');
  if (!svg) return String(svgText ?? '');

  // Ensure xmlns for safety
  if (!svg.getAttribute('xmlns')) {
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }

  // Default fill at root helps cover elements without explicit fill.
  svg.setAttribute('fill', fillColor);

  const selector = [
    'path', 'circle', 'rect', 'ellipse', 'polygon', 'polyline', 'line',
  ].join(',');

  const els = svg.querySelectorAll(selector);
  for (const el of els) {
    if (!el?.getAttribute) continue;

    // Handle style="fill:...; stroke:..."
    const styleRaw = el.getAttribute('style');
    if (styleRaw) {
      const map = _parseStyle(styleRaw);
      const fillV = String(map.fill ?? '').trim().toLowerCase();
      if (!fillV || fillV !== 'none') {
        map.fill = fillColor;
      }
      const strokeV = String(map.stroke ?? '').trim().toLowerCase();
      if (strokeV && strokeV !== 'none') {
        map.stroke = fillColor;
      }
      el.setAttribute('style', _serializeStyle(map));
    }

    // fill attr
    const fillAttr = el.getAttribute('fill');
    if (fillAttr === null) {
      el.setAttribute('fill', fillColor);
    } else {
      const fv = String(fillAttr).trim().toLowerCase();
      if (fv !== 'none') el.setAttribute('fill', fillColor);
    }

    // stroke attr: only if present & not none
    if (el.hasAttribute('stroke')) {
      const sv = String(el.getAttribute('stroke') ?? '').trim().toLowerCase();
      if (sv !== 'none') el.setAttribute('stroke', fillColor);
    }
  }

  try {
    return new XMLSerializer().serializeToString(svg);
  } catch (_) {
    return String(svgText ?? '');
  }
}

/**
 * Bake a recolored SVG to the icon library generated/ folder.
 * @returns {Promise<string>} destPath
 */
export async function bakeSvgToGenerated({ srcPath, color = '#ffffff', root = null } = {}) {
  const src = String(srcPath ?? '').trim();
  if (!src) throw new Error('Missing srcPath');

  const c = _normalizeHexColor(color);

  await ensureIconLibraryDirs({ root });
  const { generated } = getIconLibraryDirs({ root });

  // Load source SVG
  let svgText = '';
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    svgText = await res.text();
  } catch (e) {
    throw new Error(`Failed to fetch SVG: ${e?.message ?? e}`);
  }

  // Remove background squares if present, then recolor.
  const cleaned = stripSvgBackground(svgText);
  const baked = recolorSvg(cleaned, { color: c });

  const fileNameRaw = src.split('/').pop() ?? 'icon.svg';
  const base = _slugify(fileNameRaw);

  const hash = _fnv1a32Hex(`v1|${src}|${c}`);
  const colorToken = c.slice(1);
  const fileName = `${base}__${colorToken}__${hash}.svg`;

  // Upload (overwrite to keep deterministic file stable even if algo changes)
  const file = new File([baked], fileName, { type: 'image/svg+xml' });

  try {
    const result = await FilePicker.upload('data', _trimSlash(generated), file, { overwrite: true });
    const destPath = String(result?.path ?? '').trim();
    return destPath || `${_trimSlash(generated)}/${fileName}`;
  } catch (e) {
    throw new Error(`Failed to upload baked SVG: ${e?.message ?? e}`);
  }
}

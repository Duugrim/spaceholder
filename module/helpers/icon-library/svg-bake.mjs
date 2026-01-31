// SpaceHolder SVG baking helper (Foundry v13)
// Takes a source SVG path from the icon library and writes a recolored copy into generated/.

import { ensureIconLibraryDirs, getIconLibraryDirs } from './icon-library.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

function _trimSlash(path) {
  return String(path ?? '').trim().replace(/\/+$/g, '');
}

function _clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 1;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function _clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

export function normalizeHexColor(raw, fallback = '#ffffff') {
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

function _toFetchUrl(path) {
  const p = String(path ?? '').trim();
  if (!p) return '';
  if (p.startsWith('/')) return p;
  if (/^[a-zA-Z]+:/.test(p)) return p;
  return `/${p}`;
}

function _normalizePct(raw, { fallback = 0, min = 0, max = 100 } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return _clamp(n, min, max);
}

function _normalizeShape(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'square' || s === 'rounded' || s === 'circle' || s === 'hex') return s;
  return 'square';
}

function _stableBakeOpts(opts) {
  const o = opts ?? {};
  const icon = o.icon ?? {};
  const bg = o.background ?? {};
  const iconStroke = icon.stroke ?? {};
  const bgStroke = bg.stroke ?? {};

  return {
    icon: {
      color: normalizeHexColor(icon.color, '#ffffff'),
      opacity: _clamp01(icon.opacity ?? 1),
      scalePct: _normalizePct(icon.scalePct, { fallback: 100, min: 25, max: 200 }),
      stroke: {
        enabled: Boolean(iconStroke.enabled),
        color: normalizeHexColor(iconStroke.color, '#000000'),
        widthPct: _normalizePct(iconStroke.widthPct, { fallback: 4, min: 0, max: 50 }),
        opacity: _clamp01(iconStroke.opacity ?? 1),
      },
    },
    background: {
      enabled: Boolean(bg.enabled),
      shape: _normalizeShape(bg.shape),
      color: normalizeHexColor(bg.color, '#000000'),
      opacity: _clamp01(bg.opacity ?? 1),
      insetPct: _normalizePct(bg.insetPct, { fallback: 0, min: 0, max: 49 }),
      radiusPct: _normalizePct(bg.radiusPct, { fallback: 18, min: 0, max: 50 }),
      stroke: {
        enabled: Boolean(bgStroke.enabled),
        color: normalizeHexColor(bgStroke.color, '#ffffff'),
        widthPct: _normalizePct(bgStroke.widthPct, { fallback: 2, min: 0, max: 50 }),
        opacity: _clamp01(bgStroke.opacity ?? 1),
      },
    },
  };
}

export function normalizeBakeOptions(raw, { fallbackColor = '#ffffff' } = {}) {
  if (!raw || typeof raw !== 'object') {
    return _stableBakeOpts({ icon: { color: normalizeHexColor(fallbackColor) } });
  }

  // Legacy: allow {color:"#rrggbb"}
  if (typeof raw?.color === 'string' && !raw?.icon) {
    return _stableBakeOpts({ icon: { color: normalizeHexColor(raw.color, fallbackColor) } });
  }

  const opts = _stableBakeOpts(raw);
  // Ensure icon.color always present.
  opts.icon.color = normalizeHexColor(opts.icon.color, normalizeHexColor(fallbackColor));
  return opts;
}

function _bakeOptsDigest(opts) {
  // Small schema => fixed key order. This becomes part of the hash string.
  return JSON.stringify(_stableBakeOpts(opts));
}

export function computeBakeHash({ srcPath, color = '#ffffff', opts = null, version = 'v1' } = {}) {
  const src = String(srcPath ?? '').trim();
  const v = String(version ?? 'v1').trim() || 'v1';

  if (opts) {
    const n = normalizeBakeOptions(opts, { fallbackColor: color });
    return _fnv1a32Hex(`${v}|${src}|${_bakeOptsDigest(n)}`);
  }

  const c = normalizeHexColor(color);
  return _fnv1a32Hex(`${v}|${src}|${c}`);
}

export function extractBakeMeta(svgText) {
  const s = String(svgText ?? '');
  const m = s.match(/<!--\s*spaceholder-bake:(v\d+)\s+data=([\s\S]*?)\s*-->/);
  if (!m) return null;

  const version = m[1];
  const dataRaw = String(m[2] ?? '').trim();

  try {
    const parsed = JSON.parse(decodeURIComponent(dataRaw));
    const srcPath = String(parsed?.src ?? '').trim();
    const color = String(parsed?.color ?? '').trim();
    const opts = (parsed?.opts && typeof parsed.opts === 'object') ? parsed.opts : null;

    return {
      version,
      srcPath,
      color: /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : color,
      opts: opts ? normalizeBakeOptions(opts, { fallbackColor: color }) : null,
    };
  } catch (_) {
    return { version };
  }
}

function _removeBakeComments(svg) {
  try {
    const nodes = Array.from(svg.childNodes || []);
    for (const n of nodes) {
      if (n?.nodeType !== 8) continue; // Comment
      const txt = String(n.nodeValue ?? '').trim();
      if (txt.startsWith('spaceholder-bake:')) {
        try { svg.removeChild(n); } catch (_) { /* ignore */ }
      }
    }
  } catch (_) {
    // ignore
  }
}

function _buildBakeMetaComment({ srcPath, opts, version = 'v2' } = {}) {
  const normalized = normalizeBakeOptions(opts);
  const payload = {
    src: String(srcPath ?? '').trim(),
    color: normalized.icon.color,
    opts: normalized,
  };

  // encodeURIComponent avoids forbidden "--" sequences in XML comments.
  const data = encodeURIComponent(JSON.stringify(payload));
  const v = String(version ?? 'v2').trim() || 'v2';
  return `spaceholder-bake:${v} data=${data}`;
}

function _injectBakeMetaToDoc(doc, svg, { srcPath, opts, version = 'v2' } = {}) {
  if (!doc || !svg) return;
  _removeBakeComments(svg);

  try {
    const comment = doc.createComment(_buildBakeMetaComment({ srcPath, opts, version }));
    svg.insertBefore(comment, svg.firstChild);
  } catch (_) {
    // ignore
  }
}

function _buildBakeMetaCommentV1({ srcPath, color, version = 'v1' } = {}) {
  const payload = {
    src: String(srcPath ?? '').trim(),
    color: normalizeHexColor(color),
  };

  const data = encodeURIComponent(JSON.stringify(payload));
  const v = String(version ?? 'v1').trim() || 'v1';
  return `spaceholder-bake:${v} data=${data}`;
}

function _injectBakeMetaV1(svgText, { srcPath, color } = {}) {
  const raw = String(svgText ?? '');

  let doc = null;
  try {
    doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  } catch (_) {
    return raw;
  }

  const svg = doc?.querySelector?.('svg');
  if (!svg) return raw;

  if (!svg.getAttribute('xmlns')) {
    svg.setAttribute('xmlns', SVG_NS);
  }

  _removeBakeComments(svg);

  try {
    const comment = doc.createComment(_buildBakeMetaCommentV1({ srcPath, color, version: 'v1' }));
    svg.insertBefore(comment, svg.firstChild);
    return new XMLSerializer().serializeToString(svg);
  } catch (_) {
    return raw;
  }
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
  const fillColor = normalizeHexColor(color);

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
    svg.setAttribute('xmlns', SVG_NS);
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

function _ensureXmlns(svg) {
  if (!svg) return;
  if (!svg.getAttribute('xmlns')) {
    svg.setAttribute('xmlns', SVG_NS);
  }
}

function _createSvgEl(doc, tag) {
  try {
    return doc.createElementNS(SVG_NS, tag);
  } catch (_) {
    return doc.createElement(tag);
  }
}

function _wrapIconInGroup(doc, svg) {
  if (!doc || !svg) return null;

  const existing = svg.querySelector?.('g[data-sh-role="icon"]');
  if (existing) return existing;

  const group = _createSvgEl(doc, 'g');
  group.setAttribute('data-sh-role', 'icon');
  group.setAttribute('id', 'sh-icon');

  const nodes = Array.from(svg.childNodes || []);
  let moved = 0;

  for (const n of nodes) {
    if (n?.nodeType !== 1) continue; // element only
    const tag = String(n.tagName ?? '').toLowerCase();
    if (tag === 'defs' || tag === 'metadata' || tag === 'title' || tag === 'desc') continue;
    try { group.appendChild(n); moved++; } catch (_) { /* ignore */ }
  }

  if (!moved) return null;

  try {
    svg.appendChild(group);
    return group;
  } catch (_) {
    return null;
  }
}

function _recolorSvgSubtree(rootEl, { color } = {}) {
  const fillColor = normalizeHexColor(color);
  if (!rootEl?.querySelectorAll) return;

  // Default fill at group helps cover elements without explicit fill.
  try { rootEl.setAttribute('fill', fillColor); } catch (_) { /* ignore */ }

  const selector = [
    'path', 'circle', 'rect', 'ellipse', 'polygon', 'polyline', 'line',
  ].join(',');

  const els = rootEl.querySelectorAll(selector);
  for (const el of els) {
    if (!el?.getAttribute) continue;

    // Skip generated background.
    if (String(el.getAttribute('data-sh-role') ?? '') === 'bg') continue;

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

    const fillAttr = el.getAttribute('fill');
    if (fillAttr === null) {
      el.setAttribute('fill', fillColor);
    } else {
      const fv = String(fillAttr).trim().toLowerCase();
      if (fv !== 'none') el.setAttribute('fill', fillColor);
    }

    if (el.hasAttribute('stroke')) {
      const sv = String(el.getAttribute('stroke') ?? '').trim().toLowerCase();
      if (sv !== 'none') el.setAttribute('stroke', fillColor);
    }
  }
}

function _applyStrokeToSubtree(rootEl, { color, width, opacity } = {}) {
  if (!rootEl?.querySelectorAll) return;

  const strokeColor = normalizeHexColor(color, '#000000');
  const w = Number(width);
  if (!Number.isFinite(w) || w <= 0) return;
  const a = _clamp01(opacity ?? 1);

  const selector = [
    'path', 'circle', 'rect', 'ellipse', 'polygon', 'polyline', 'line',
  ].join(',');

  const els = rootEl.querySelectorAll(selector);
  for (const el of els) {
    if (!el?.setAttribute) continue;
    if (String(el.getAttribute('data-sh-role') ?? '') === 'bg') continue;

    el.setAttribute('stroke', strokeColor);
    el.setAttribute('stroke-width', String(w));
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-opacity', String(a));

    // Ensure stroke is rendered above fill.
    const styleRaw = el.getAttribute('style');
    const map = _parseStyle(styleRaw);
    map['paint-order'] = 'stroke fill';
    el.setAttribute('style', _serializeStyle(map));
  }
}

function _computeViewBoxOrFallback(svg) {
  const vb = _parseViewBox(svg);
  if (vb) return vb;
  return { minX: 0, minY: 0, width: 100, height: 100 };
}

function _insertBackground(doc, svg, iconGroup, vb, bg) {
  if (!doc || !svg || !bg?.enabled) return null;

  const minDim = Math.min(vb.width, vb.height);

  const baseInset = minDim * (Number(bg.insetPct) / 100);

  // SVG stroke is centered on the shape outline (half inside, half outside).
  // To keep the entire stroke inside the viewBox (avoid clipping), inset the shape by strokeWidth/2.
  let strokeInset = 0;
  if (bg.stroke?.enabled) {
    const sw = minDim * (Number(bg.stroke.widthPct) / 100);
    if (Number.isFinite(sw) && sw > 0) strokeInset = sw / 2;
  }

  const inset = baseInset + strokeInset;
  const x = vb.minX + inset;
  const y = vb.minY + inset;
  const w = Math.max(0, vb.width - 2 * inset);
  const h = Math.max(0, vb.height - 2 * inset);

  const shape = _normalizeShape(bg.shape);

  let el = null;
  if (shape === 'circle') {
    el = _createSvgEl(doc, 'circle');
    el.setAttribute('cx', String(vb.minX + vb.width / 2));
    el.setAttribute('cy', String(vb.minY + vb.height / 2));
    // Keep radius in sync with inset-adjusted rect/hex (supports bg stroke inset above).
    el.setAttribute('r', String(Math.max(0, (Math.min(vb.width, vb.height) / 2) - inset)));
  } else if (shape === 'hex') {
    el = _createSvgEl(doc, 'polygon');
    const pts = [
      [x + w * 0.25, y],
      [x + w * 0.75, y],
      [x + w, y + h / 2],
      [x + w * 0.75, y + h],
      [x + w * 0.25, y + h],
      [x, y + h / 2],
    ].map(([px, py]) => `${px},${py}`).join(' ');
    el.setAttribute('points', pts);
  } else {
    // square / rounded
    el = _createSvgEl(doc, 'rect');
    el.setAttribute('x', String(x));
    el.setAttribute('y', String(y));
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));

    if (shape === 'rounded') {
      const rBase = minDim * (Number(bg.radiusPct) / 100);
      const r = Math.max(0, Math.min(rBase, w / 2, h / 2));
      el.setAttribute('rx', String(r));
      el.setAttribute('ry', String(r));
    }
  }

  if (!el) return null;

  el.setAttribute('id', 'sh-bg');
  el.setAttribute('data-sh-role', 'bg');
  el.setAttribute('fill', normalizeHexColor(bg.color, '#000000'));
  el.setAttribute('fill-opacity', String(_clamp01(bg.opacity ?? 1)));

  // Optional background stroke.
  if (bg.stroke?.enabled) {
    const sw = minDim * (Number(bg.stroke.widthPct) / 100);
    if (sw > 0) {
      el.setAttribute('stroke', normalizeHexColor(bg.stroke.color, '#ffffff'));
      el.setAttribute('stroke-width', String(sw));
      el.setAttribute('stroke-linejoin', 'round');
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-opacity', String(_clamp01(bg.stroke.opacity ?? 1)));

      // Marker for migrations/diagnostics: background geometry was inset to keep stroke inside.
      el.setAttribute('data-sh-bg-stroke-inset', '1');
    }
  }

  try {
    if (iconGroup && iconGroup.parentNode === svg) {
      svg.insertBefore(el, iconGroup);
    } else {
      svg.insertBefore(el, svg.firstChild);
    }
  } catch (_) {
    try { svg.appendChild(el); } catch (_) { /* ignore */ }
  }

  return el;
}

function _isLegacyEquivalent(opts) {
  const o = normalizeBakeOptions(opts);
  return !o.background.enabled
    && !o.icon.stroke.enabled
    && _clamp01(o.icon.opacity) === 1
    && Number(o.icon.scalePct ?? 100) === 100;
}

export function buildBakedSvgText(srcSvgText, {
  srcPath = '',
  opts = null,
  version = 'v2',
  includeMeta = false,
} = {}) {
  const normalized = normalizeBakeOptions(opts);

  // Start by stripping "native" bg.
  const cleanedText = stripSvgBackground(srcSvgText);

  let doc = null;
  try {
    doc = new DOMParser().parseFromString(String(cleanedText ?? ''), 'image/svg+xml');
  } catch (_) {
    return String(cleanedText ?? srcSvgText ?? '');
  }

  const svg = doc?.querySelector?.('svg');
  if (!svg) return String(cleanedText ?? srcSvgText ?? '');

  _ensureXmlns(svg);

  const vb = _computeViewBoxOrFallback(svg);

  // Wrap existing icon into a group so we can apply icon opacity without touching bg.
  const iconGroup = _wrapIconInGroup(doc, svg) ?? svg;

  // Recolor icon.
  _recolorSvgSubtree(iconGroup, { color: normalized.icon.color });

  // Insert background (if enabled) before applying strokes, so strokes can target bg separately.
  _insertBackground(doc, svg, (iconGroup === svg) ? null : iconGroup, vb, normalized.background);

  // Icon scale (around viewBox center). Only safe when icon is wrapped in its own group.
  if (iconGroup !== svg) {
    const sp = Number(normalized.icon.scalePct ?? 100);
    if (Number.isFinite(sp) && sp > 0 && sp !== 100) {
      const s = sp / 100;
      const cx = vb.minX + vb.width / 2;
      const cy = vb.minY + vb.height / 2;
      const old = String(iconGroup.getAttribute('transform') ?? '').trim();
      const t = `translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`;
      try {
        iconGroup.setAttribute('transform', old ? `${old} ${t}` : t);
      } catch (_) {
        // ignore
      }
    }
  }

  // Icon stroke.
  if (normalized.icon.stroke?.enabled) {
    const minDim = Math.min(vb.width, vb.height);
    const sw = minDim * (Number(normalized.icon.stroke.widthPct) / 100);
    _applyStrokeToSubtree(iconGroup, {
      color: normalized.icon.stroke.color,
      width: sw,
      opacity: normalized.icon.stroke.opacity,
    });
  }

  // Icon opacity.
  if (iconGroup !== svg) {
    try { iconGroup.setAttribute('opacity', String(_clamp01(normalized.icon.opacity))); } catch (_) { /* ignore */ }
  }

  if (includeMeta) {
    if (_isLegacyEquivalent(normalized) && String(version) === 'v1') {
      // v1: keep legacy meta shape.
      return _injectBakeMetaV1(new XMLSerializer().serializeToString(svg), {
        srcPath,
        color: normalized.icon.color,
      });
    }

    _injectBakeMetaToDoc(doc, svg, { srcPath, opts: normalized, version });
  }

  try {
    return new XMLSerializer().serializeToString(svg);
  } catch (_) {
    return String(cleanedText ?? srcSvgText ?? '');
  }
}

/**
 * Bake a recolored SVG to the icon library generated/ folder.
 * @returns {Promise<string>} destPath
 */
export async function bakeSvgToGenerated({ srcPath, color = '#ffffff', opts = null, root = null } = {}) {
  const src = String(srcPath ?? '').trim();
  if (!src) throw new Error('Missing srcPath');

  const normalized = normalizeBakeOptions(opts ?? { icon: { color } }, { fallbackColor: color });

  await ensureIconLibraryDirs({ root });
  const { generated } = getIconLibraryDirs({ root });

  // Load source SVG
  let svgText = '';
  try {
    const res = await fetch(_toFetchUrl(src));
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    svgText = await res.text();
  } catch (e) {
    throw new Error(`Failed to fetch SVG: ${e?.message ?? e}`);
  }

  // Legacy-equivalent => keep v1 file identity to avoid duplicating existing generated icons.
  const useLegacy = _isLegacyEquivalent(normalized);

  const baked = useLegacy
    ? _injectBakeMetaV1(recolorSvg(stripSvgBackground(svgText), { color: normalized.icon.color }), {
      srcPath: src,
      color: normalized.icon.color,
    })
    : buildBakedSvgText(svgText, {
      srcPath: src,
      opts: normalized,
      version: 'v2',
      includeMeta: true,
    });

  const fileNameRaw = src.split('/').pop() ?? 'icon.svg';
  const base = _slugify(fileNameRaw);

  const hash = useLegacy
    ? computeBakeHash({ srcPath: src, color: normalized.icon.color, version: 'v1' })
    : computeBakeHash({ srcPath: src, opts: normalized, color: normalized.icon.color, version: 'v2' });

  const colorToken = normalizeHexColor(normalized.icon.color).slice(1);
  const fileName = `${base}__${colorToken}__${hash}.svg`;

  // Upload (overwrite to keep deterministic file stable even if algo changes)
  const file = new File([baked], fileName, { type: 'image/svg+xml' });

  const FP = foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  if (!FP?.upload) {
    throw new Error('FilePicker.upload is not available');
  }

  try {
    const result = await FP.upload('data', _trimSlash(generated), file, { overwrite: true });
    const destPath = String(result?.path ?? '').trim();
    return destPath || `${_trimSlash(generated)}/${fileName}`;
  } catch (e) {
    throw new Error(`Failed to upload baked SVG: ${e?.message ?? e}`);
  }
}

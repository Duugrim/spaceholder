// Icon Picker UI (Foundry v13, ApplicationV2)

import { buildBakedSvgText, normalizeBakeOptions } from '../icon-library/svg-bake.mjs';

const TEMPLATE = 'systems/spaceholder/templates/icon-picker/icon-picker.hbs';

function _L(key) {
  try { return game.i18n.localize(key); } catch (_) { return key; }
}

function _trim(s) {
  return String(s ?? '').trim();
}

function _toPreviewUrl(path) {
  const p = String(path ?? '').trim();
  if (!p) return '';
  if (p.startsWith('/')) return p;
  if (/^[a-zA-Z]+:/.test(p)) return p;
  return `/${p}`;
}

function _normalizeColor(raw, fallback = '#ffffff') {
  const s = _trim(raw);
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  const m3 = s.match(/^#([0-9a-fA-F]{3})$/);
  if (m3) {
    const h = m3[1];
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
  }
  return fallback;
}

function _clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function _pct01FromInt(pct) {
  const p = _clamp(pct, 0, 100);
  return p / 100;
}

function _intFromPct01(x) {
  const n = _clamp(Number(x) * 100, 0, 100);
  return Math.round(n);
}

function _invertHex(hex) {
  const h = _normalizeColor(hex, '#000000');
  const r = 255 - parseInt(h.slice(1, 3), 16);
  const g = 255 - parseInt(h.slice(3, 5), 16);
  const b = 255 - parseInt(h.slice(5, 7), 16);
  const to2 = (v) => v.toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

function _isSvgPath(path) {
  const p = String(path ?? '').trim().toLowerCase();
  return p.endsWith('.svg');
}

function _getFilePickerImpl() {
  return foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

export class IconPickerApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-icon-picker',
    classes: ['spaceholder', 'icon-picker'],
    tag: 'div',
    window: { title: 'Icon Picker', resizable: true },
    position: { width: 660, height: 780 },
  };

  static PARTS = {
    main: { root: true, template: TEMPLATE },
  };

  constructor({
    title = null,
    defaultColor = '#ffffff',
    factionColor = null,
    initialPath = null,
    initialOpts = null,
    startDir = '',
    autoOpenFilePicker = false,
  } = {}) {
    super();

    this._titleOverride = _trim(title) || null;

    this._startDir = String(startDir ?? '').trim();
    this._autoOpenFilePicker = Boolean(autoOpenFilePicker);
    this._didAutoOpen = false;

    this._srcPath = String(initialPath ?? '').trim();

    // Styling options (persisted)
    this._prefsKey = 'spaceholder.iconPicker.prefs.v2';

    // Optional faction color (used by quick buttons)
    this._factionColor = _normalizeColor(factionColor, '');

    // Icon color is still the primary control.
    this._color = _normalizeColor(defaultColor);

    // Defaults (will be overridden by persisted prefs if present)
    this._iconOpacity = 1;
    this._iconScalePct = 100;
    this._iconStrokeEnabled = false;
    this._iconStrokeColor = '#000000';
    this._iconStrokeWidthPct = 4;
    this._iconStrokeOpacity = 1;

    this._bgEnabled = false;
    this._bgColor = '#000000';
    this._bgShape = 'square';
    this._bgOpacity = 1;
    this._bgInsetPct = 0;
    this._bgRadiusPct = 18;

    this._bgStrokeEnabled = false;
    this._bgStrokeColor = '#ffffff';
    this._bgStrokeWidthPct = 2;
    this._bgStrokeOpacity = 1;

    this._loadPrefs();

    // If the caller provided initial opts (or we resolved them from baked meta), prefer them.
    if (initialOpts && typeof initialOpts === 'object') {
      this._applyOpts(initialOpts);
    }

    this._resolve = null;

    // Preview caching
    this._previewToken = 0;
    this._cachedPreviewSrc = '';
    this._cachedSvgText = '';

    this._onRootClick = this._onRootClick.bind(this);
    this._onRootInput = this._onRootInput.bind(this);
  }

  get title() {
    return this._titleOverride || _L('SPACEHOLDER.IconPicker.Title');
  }

  static async wait(options = {}) {
    return await new Promise((resolve) => {
      const app = new IconPickerApp(options);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async close(options = {}) {
    await super.close(options);

    // If closed without explicit resolve, resolve null.
    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve(null);
    }
  }

  async _prepareContext(_options) {
    const srcPath = String(this._srcPath ?? '').trim();
    const fileName = srcPath ? (srcPath.split('/').pop() ?? srcPath) : '';

    return {
      srcPath,
      fileName,
      hasSrc: !!srcPath,
      previewUrl: _toPreviewUrl(srcPath),

      color: this._color,

      hasFactionColor: !!this._factionColor,
      factionColor: this._factionColor,

      // Background
      bgEnabled: this._bgEnabled,
      bgColor: this._bgColor,
      bgShape: this._bgShape,
      bgOpacityPct: _intFromPct01(this._bgOpacity),
      bgInsetPct: this._bgInsetPct,
      bgRadiusPct: this._bgRadiusPct,

      bgStrokeEnabled: this._bgStrokeEnabled,
      bgStrokeColor: this._bgStrokeColor,
      bgStrokeWidthPct: this._bgStrokeWidthPct,
      bgStrokeOpacityPct: _intFromPct01(this._bgStrokeOpacity),

      // Icon
      iconOpacityPct: _intFromPct01(this._iconOpacity),
      iconScalePct: this._iconScalePct,
      iconStrokeEnabled: this._iconStrokeEnabled,
      iconStrokeColor: this._iconStrokeColor,
      iconStrokeWidthPct: this._iconStrokeWidthPct,
      iconStrokeOpacityPct: _intFromPct01(this._iconStrokeOpacity),

      canConfirm: !!srcPath,
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    const el = this.element;
    if (!el) return;

    const root = el.querySelector('.sh-icon-picker') || el;

    if (root.dataset?.shIconPickerHandlers !== 'true') {
      root.dataset.shIconPickerHandlers = 'true';
      root.addEventListener('click', this._onRootClick);
      root.addEventListener('input', this._onRootInput);
      root.addEventListener('change', this._onRootInput);
    }

    // Sync preview (mask hydration + current color)
    this._syncPreview(root);

    // Optionally auto-open file picker on first render.
    if (this._autoOpenFilePicker && !this._didAutoOpen && !this._srcPath) {
      this._didAutoOpen = true;
      setTimeout(() => this._openFilePicker(), 0);
    }
  }

  _encodeSvgDataUri(svgText) {
    const s = String(svgText ?? '');
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
  }

  _getBakeOpts() {
    return normalizeBakeOptions({
      icon: {
        color: this._color,
        opacity: this._iconOpacity,
        scalePct: this._iconScalePct,
        stroke: {
          enabled: this._iconStrokeEnabled,
          color: this._iconStrokeColor,
          widthPct: this._iconStrokeWidthPct,
          opacity: this._iconStrokeOpacity,
        },
      },
      background: {
        enabled: this._bgEnabled,
        shape: this._bgShape,
        color: this._bgColor,
        opacity: this._bgOpacity,
        insetPct: this._bgInsetPct,
        radiusPct: this._bgRadiusPct,
        stroke: {
          enabled: this._bgEnabled && this._bgStrokeEnabled,
          color: this._bgStrokeColor,
          widthPct: this._bgStrokeWidthPct,
          opacity: this._bgStrokeOpacity,
        },
      },
    }, { fallbackColor: this._color });
  }

  _applyOpts(raw) {
    try {
      const opts = normalizeBakeOptions(raw);

      this._color = _normalizeColor(opts.icon.color, this._color);
      this._iconOpacity = _clamp(opts.icon.opacity ?? 1, 0, 1);
      this._iconScalePct = _clamp(opts.icon.scalePct ?? 100, 25, 200);
      this._iconStrokeEnabled = Boolean(opts.icon.stroke?.enabled);
      this._iconStrokeColor = _normalizeColor(opts.icon.stroke?.color, this._iconStrokeColor);
      this._iconStrokeWidthPct = _clamp(opts.icon.stroke?.widthPct ?? 4, 0, 50);
      this._iconStrokeOpacity = _clamp(opts.icon.stroke?.opacity ?? 1, 0, 1);

      this._bgEnabled = Boolean(opts.background.enabled);
      this._bgColor = _normalizeColor(opts.background.color, this._bgColor);
      this._bgShape = String(opts.background.shape ?? this._bgShape);
      this._bgOpacity = _clamp(opts.background.opacity ?? 1, 0, 1);
      this._bgInsetPct = _clamp(opts.background.insetPct ?? 0, 0, 49);
      this._bgRadiusPct = _clamp(opts.background.radiusPct ?? 18, 0, 50);

      this._bgStrokeEnabled = Boolean(opts.background.stroke?.enabled);
      this._bgStrokeColor = _normalizeColor(opts.background.stroke?.color, this._bgStrokeColor);
      this._bgStrokeWidthPct = _clamp(opts.background.stroke?.widthPct ?? 2, 0, 50);
      this._bgStrokeOpacity = _clamp(opts.background.stroke?.opacity ?? 1, 0, 1);
    } catch (_) {
      // ignore
    }
  }

  _loadPrefs() {
    try {
      const raw = globalThis?.localStorage?.getItem?.(this._prefsKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      this._applyOpts(parsed?.opts ?? parsed);
    } catch (_) {
      // ignore
    }
  }

  _savePrefs() {
    try {
      const payload = { opts: this._getBakeOpts() };
      globalThis?.localStorage?.setItem?.(this._prefsKey, JSON.stringify(payload));
    } catch (_) {
      // ignore
    }
  }

  async _ensureCachedSvgText(src) {
    const s = String(src ?? '').trim();
    if (!s) return '';
    if (this._cachedPreviewSrc === s && this._cachedSvgText) return this._cachedSvgText;

    let svgText = '';
    try {
      const res = await fetch(s);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      svgText = await res.text();
    } catch (_) {
      this._cachedPreviewSrc = s;
      this._cachedSvgText = '';
      return '';
    }

    this._cachedPreviewSrc = s;
    this._cachedSvgText = String(svgText ?? '');
    return this._cachedSvgText;
  }

  async _hydratePreviewThumb(thumb, src) {
    const token = ++this._previewToken;
    if (!thumb) return;

    const img = thumb.querySelector('[data-role="preview-img"]');
    if (!img) return;

    thumb.dataset.shPreviewReady = 'pending';
    thumb.dataset.shPreviewFailed = 'false';

    const svgText = await this._ensureCachedSvgText(src);
    if (token !== this._previewToken) return;

    if (!svgText) {
      thumb.dataset.shPreviewFailed = 'true';
      thumb.dataset.shPreviewReady = 'false';
      // Fallback: show original file.
      try { img.src = String(src ?? ''); } catch (_) { /* ignore */ }
      return;
    }

    const bakedPreview = buildBakedSvgText(svgText, { opts: this._getBakeOpts(), includeMeta: false });
    const uri = this._encodeSvgDataUri(bakedPreview);

    try {
      img.src = uri;
    } catch (_) {
      // ignore
    }

    thumb.dataset.shPreviewReady = 'true';
    thumb.dataset.shPreviewFailed = 'false';
  }

  _syncPreview(root) {
    const thumb = root.querySelector('[data-role="preview-thumb"]');
    if (!thumb) return;

    const src = String(thumb.dataset?.src ?? '').trim();
    if (!src) return;

    // Re-hydrate preview when source or options change.
    const sig = JSON.stringify(this._getBakeOpts());
    if (thumb.dataset?.shPreviewSrc !== src || thumb.dataset?.shPreviewSig !== sig) {
      thumb.dataset.shPreviewSrc = src;
      thumb.dataset.shPreviewSig = sig;
      thumb.dataset.shPreviewReady = 'false';
      thumb.dataset.shPreviewFailed = 'false';
      this._hydratePreviewThumb(thumb, src);
    }
  }

  _openFilePicker() {
    const FP = _getFilePickerImpl();
    if (typeof FP !== 'function') {
      ui.notifications?.warn?.('FilePicker недоступен');
      return;
    }

    const current = this._srcPath || this._startDir || '';
    const fp = new FP({
      type: 'image',
      current,
      callback: (path) => {
        const next = String(path ?? '').trim();
        if (!next) return;
        this._srcPath = next;
        this.render(false);
      },
    });

    try {
      fp.render(true);
    } catch (_) {
      try { fp.browse(); } catch (_) { /* ignore */ }
    }
  }

  async _confirmSelection() {
    const srcPath = String(this._srcPath ?? '').trim();
    if (!srcPath) return;

    if (!_isSvgPath(srcPath)) {
      ui.notifications?.warn?.(_L('SPACEHOLDER.IconPicker.Errors.OnlySvg'));
      return;
    }

    const payload = {
      srcPath,
      color: this._color,
      opts: this._getBakeOpts(),
    };

    this._savePrefs();

    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve(payload);
    }

    await this.close();
  }

  _onRootInput(ev) {
    const root = ev.currentTarget;

    const actionEl = ev.target?.closest?.('[data-action]');
    const action = String(actionEl?.dataset?.action ?? '').trim();

    // Icon color
    if (action === 'color' && actionEl?.type === 'color') {
      this._color = _normalizeColor(actionEl.value, this._color);
      const hex = root.querySelector('input[data-action="color-hex"]');
      if (hex) hex.value = this._color;
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'color-hex') {
      const next = _normalizeColor(actionEl.value, this._color);
      this._color = next;
      const colorInput = root.querySelector('input[type="color"][data-action="color"]');
      if (colorInput) colorInput.value = this._color;
      actionEl.value = this._color;
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    // Background enable
    if (action === 'bg-enabled') {
      this._bgEnabled = Boolean(actionEl.checked);
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'bg-color' && actionEl?.type === 'color') {
      this._bgColor = _normalizeColor(actionEl.value, this._bgColor);
      const hex = root.querySelector('input[data-action="bg-color-hex"]');
      if (hex) hex.value = this._bgColor;
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'bg-color-hex') {
      this._bgColor = _normalizeColor(actionEl.value, this._bgColor);
      const colorInput = root.querySelector('input[type="color"][data-action="bg-color"]');
      if (colorInput) colorInput.value = this._bgColor;
      actionEl.value = this._bgColor;
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'bg-shape') {
      this._bgShape = String(actionEl.value ?? '').trim();
      this._savePrefs();
      this.render(false);
      return;
    }

    if (action === 'bg-inset') {
      this._bgInsetPct = _clamp(actionEl.value, 0, 49);
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'bg-radius') {
      this._bgRadiusPct = _clamp(actionEl.value, 0, 50);
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'bg-opacity') {
      this._bgOpacity = _pct01FromInt(actionEl.value);
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    // Background stroke
    if (action === 'bg-stroke-enabled') {
      this._bgStrokeEnabled = Boolean(actionEl.checked);
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'bg-stroke-color' && actionEl?.type === 'color') {
      this._bgStrokeColor = _normalizeColor(actionEl.value, this._bgStrokeColor);
      const hex = root.querySelector('input[data-action="bg-stroke-color-hex"]');
      if (hex) hex.value = this._bgStrokeColor;
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'bg-stroke-color-hex') {
      this._bgStrokeColor = _normalizeColor(actionEl.value, this._bgStrokeColor);
      const colorInput = root.querySelector('input[type="color"][data-action="bg-stroke-color"]');
      if (colorInput) colorInput.value = this._bgStrokeColor;
      actionEl.value = this._bgStrokeColor;
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'bg-stroke-width') {
      this._bgStrokeWidthPct = _clamp(actionEl.value, 0, 50);
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'bg-stroke-opacity') {
      this._bgStrokeOpacity = _pct01FromInt(actionEl.value);
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    // Icon stroke
    if (action === 'icon-stroke-enabled') {
      this._iconStrokeEnabled = Boolean(actionEl.checked);
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'icon-stroke-color' && actionEl?.type === 'color') {
      this._iconStrokeColor = _normalizeColor(actionEl.value, this._iconStrokeColor);
      const hex = root.querySelector('input[data-action="icon-stroke-color-hex"]');
      if (hex) hex.value = this._iconStrokeColor;
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'icon-stroke-color-hex') {
      this._iconStrokeColor = _normalizeColor(actionEl.value, this._iconStrokeColor);
      const colorInput = root.querySelector('input[type="color"][data-action="icon-stroke-color"]');
      if (colorInput) colorInput.value = this._iconStrokeColor;
      actionEl.value = this._iconStrokeColor;
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'icon-stroke-width') {
      this._iconStrokeWidthPct = _clamp(actionEl.value, 0, 50);
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'icon-stroke-opacity') {
      this._iconStrokeOpacity = _pct01FromInt(actionEl.value);
      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'icon-scale') {
      this._iconScalePct = _clamp(actionEl.value, 25, 200);

      const range = root.querySelector('input[type="range"][data-action="icon-scale"]');
      const num = root.querySelector('input[type="number"][data-action="icon-scale-number"]');
      if (range && range !== actionEl) range.value = String(this._iconScalePct);
      if (num && num !== actionEl) num.value = String(this._iconScalePct);

      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'icon-scale-number') {
      this._iconScalePct = _clamp(actionEl.value, 25, 200);

      const range = root.querySelector('input[type="range"][data-action="icon-scale"]');
      const num = root.querySelector('input[type="number"][data-action="icon-scale-number"]');
      if (range) range.value = String(this._iconScalePct);
      if (num) num.value = String(this._iconScalePct);

      this._savePrefs();
      this._syncPreview(root);
      return;
    }

    if (action === 'icon-opacity') {
      this._iconOpacity = _pct01FromInt(actionEl.value);
      this._savePrefs();
      this._syncPreview(root);
    }
  }

  async _onRootClick(ev) {
    const el = ev.target?.closest?.('[data-action]');
    if (!el) return;

    const action = String(el.dataset.action ?? '').trim();

    if (action === 'pick-file') {
      ev.preventDefault();
      ev.stopPropagation();
      this._openFilePicker();
      return;
    }

    if (action === 'swap-colors') {
      ev.preventDefault();
      ev.stopPropagation();
      const a = this._color;
      this._color = this._bgColor;
      this._bgColor = a;
      this._savePrefs();
      this.render(false);
      return;
    }

    if (action === 'set-icon-faction-color') {
      ev.preventDefault();
      ev.stopPropagation();
      if (!this._factionColor) return;
      this._color = this._factionColor;
      this._savePrefs();
      this.render(false);
      return;
    }

    if (action === 'set-bg-faction-color') {
      ev.preventDefault();
      ev.stopPropagation();
      if (!this._factionColor) return;
      this._bgColor = this._factionColor;
      this._savePrefs();
      this.render(false);
      return;
    }

    if (action === 'invert-icon') {
      ev.preventDefault();
      ev.stopPropagation();
      this._color = _invertHex(this._color);
      this._savePrefs();
      this.render(false);
      return;
    }

    if (action === 'invert-bg') {
      ev.preventDefault();
      ev.stopPropagation();
      this._bgColor = _invertHex(this._bgColor);
      this._savePrefs();
      this.render(false);
      return;
    }

    if (action === 'confirm') {
      ev.preventDefault();
      ev.stopPropagation();
      await this._confirmSelection();
      return;
    }

    if (action === 'cancel') {
      ev.preventDefault();
      ev.stopPropagation();
      await this.close();
    }
  }
}

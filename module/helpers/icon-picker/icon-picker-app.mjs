// Icon Picker UI (Foundry v13, ApplicationV2)

import { stripSvgBackground } from '../icon-library/svg-bake.mjs';

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
    position: { width: 560, height: 520 },
  };

  static PARTS = {
    main: { root: true, template: TEMPLATE },
  };

  constructor({
    title = null,
    defaultColor = '#ffffff',
    startDir = '',
    autoOpenFilePicker = false,
  } = {}) {
    super();

    this._titleOverride = _trim(title) || null;

    this._startDir = String(startDir ?? '').trim();
    this._autoOpenFilePicker = Boolean(autoOpenFilePicker);
    this._didAutoOpen = false;

    this._srcPath = '';
    this._color = _normalizeColor(defaultColor);

    this._resolve = null;

    this._previewToken = 0;

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

  async _hydratePreviewThumb(thumb, src) {
    const token = ++this._previewToken;
    if (!thumb) return;

    thumb.dataset.shMaskReady = 'pending';
    thumb.dataset.shMaskFailed = 'false';

    let svgText = '';
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      svgText = await res.text();
    } catch (_) {
      if (token !== this._previewToken) return;
      thumb.dataset.shMaskFailed = 'true';
      thumb.dataset.shMaskReady = 'false';
      return;
    }

    if (token !== this._previewToken) return;

    const cleaned = stripSvgBackground(svgText);
    const uri = this._encodeSvgDataUri(cleaned);

    try {
      thumb.style.setProperty('--sh-icon-url', `url("${uri}")`);
    } catch (_) {
      // ignore
    }

    thumb.dataset.shMaskReady = 'true';
    thumb.dataset.shMaskFailed = 'false';
  }

  _syncPreview(root) {
    const thumb = root.querySelector('[data-role="preview-thumb"]');
    if (!thumb) return;

    // Always keep preview color in sync.
    try {
      thumb.style.setProperty('--sh-icon-color', this._color);
    } catch (_) {
      // ignore
    }

    const src = String(thumb.dataset?.src ?? '').trim();
    if (!src) return;

    // Re-hydrate mask when source changes.
    if (thumb.dataset?.shMaskSrc !== src) {
      thumb.dataset.shMaskSrc = src;
      thumb.dataset.shMaskReady = 'false';
      thumb.dataset.shMaskFailed = 'false';
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
    };

    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve(payload);
    }

    await this.close();
  }

  _onRootInput(ev) {
    const root = ev.currentTarget;

    const color = ev.target?.closest?.('input[type="color"][data-action="color"]');
    if (color) {
      this._color = _normalizeColor(color.value, this._color);

      const hex = root.querySelector('input[data-action="color-hex"]');
      if (hex) hex.value = this._color;

      this._syncPreview(root);
      return;
    }

    const hex = ev.target?.closest?.('input[type="text"][data-action="color-hex"]');
    if (hex) {
      const next = _normalizeColor(hex.value, this._color);
      this._color = next;

      const colorInput = root.querySelector('input[type="color"][data-action="color"]');
      if (colorInput) colorInput.value = this._color;

      hex.value = this._color;

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

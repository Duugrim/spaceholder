// Icon Picker UI (Foundry v13, ApplicationV2)

import { stripSvgBackground } from '../icon-library/svg-bake.mjs';

const TEMPLATE = 'systems/spaceholder/templates/icon-picker/icon-picker.hbs';

function _L(key) {
  try { return game.i18n.localize(key); } catch (_) { return key; }
}

function _trim(s) {
  return String(s ?? '').trim();
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

function _buildSearchKey(icon) {
  const parts = [
    icon?.name,
    icon?.category,
    ...(Array.isArray(icon?.tags) ? icon.tags : []),
  ]
    .map((x) => String(x ?? '').toLowerCase().trim())
    .filter(Boolean);

  return parts.join(' ');
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
    position: { width: 760, height: 720 },
  };

  static PARTS = {
    main: { root: true, template: TEMPLATE },
  };

  constructor({
    icons = [],
    title = null,
    defaultColor = '#ffffff',
    loadIcons = null,
  } = {}) {
    super();

    this._titleOverride = _trim(title) || null;

    this._icons = Array.isArray(icons) ? icons : [];
    this._loadIcons = (typeof loadIcons === 'function') ? loadIcons : null;

    this._query = '';
    this._category = '';
    this._color = _normalizeColor(defaultColor);

    this._selectedId = '';

    this._resolve = null;

    this._onRootClick = this._onRootClick.bind(this);
    this._onRootDblClick = this._onRootDblClick.bind(this);
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

  _getCategories() {
    const set = new Set();
    for (const ic of (Array.isArray(this._icons) ? this._icons : [])) {
      const c = _trim(ic?.category);
      if (!c) continue;
      set.add(c);
    }
    return Array.from(set.values()).sort((a, b) => a.localeCompare(b, 'ru'));
  }

  _getSelectedIcon() {
    const id = String(this._selectedId ?? '');
    if (!id) return null;
    return (Array.isArray(this._icons) ? this._icons : []).find((i) => String(i?.id) === id) ?? null;
  }

  async _prepareContext(_options) {
    const icons = (Array.isArray(this._icons) ? this._icons : []).map((i) => ({
      ...i,
      searchKey: _buildSearchKey(i),
    }));

    const selected = {};
    if (this._selectedId) selected[String(this._selectedId)] = true;

    return {
      query: this._query,
      category: this._category,
      color: this._color,
      categories: this._getCategories(),
      icons,
      selected,
      hasSelection: !!this._selectedId,
      canRefresh: !!this._loadIcons,
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
      root.addEventListener('dblclick', this._onRootDblClick);
      root.addEventListener('input', this._onRootInput);
      root.addEventListener('change', this._onRootInput);
    }

    // Apply current color to CSS var (for instant preview)
    try {
      root.style.setProperty('--sh-icon-color', this._color);
    } catch (_) {
      // ignore
    }

    // Apply initial filtering state
    this._applyFiltersToDom(root);
    this._syncConfirmButton(root);

    // Hydrate previews: convert SVGs to background-free mask data URIs
    this._hydrateMaskPreviews(root);
  }

  _applyFiltersToDom(root) {
    const q = String(this._query ?? '').trim().toLowerCase();
    const cat = String(this._category ?? '').trim();

    const items = Array.from(root.querySelectorAll('[data-action="select-icon"][data-id]'));
    let visible = 0;

    for (const btn of items) {
      const s = String(btn.dataset.search ?? '').toLowerCase();
      const itemCat = String(btn.dataset.category ?? '');

      const okQ = !q || s.includes(q);
      const okCat = !cat || itemCat === cat;

      const show = okQ && okCat;
      btn.classList.toggle('is-hidden', !show);
      if (show) visible++;
    }

    const empty = root.querySelector('[data-role="empty"]');
    if (empty) empty.classList.toggle('is-hidden', visible > 0);
  }

  _syncConfirmButton(root) {
    const btn = root.querySelector('[data-action="confirm"]');
    if (!btn) return;
    btn.disabled = !this._selectedId;
  }

  _encodeSvgDataUri(svgText) {
    const s = String(svgText ?? '');
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
  }

  async _hydrateOneMaskPreview(btn) {
    if (!btn || btn.dataset?.shMaskReady === 'true' || btn.dataset?.shMaskFailed === 'true') return;

    const src = String(btn.dataset?.src ?? '').trim();
    if (!src) return;

    btn.dataset.shMaskReady = 'pending';

    let svgText = '';
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      svgText = await res.text();
    } catch (e) {
      btn.dataset.shMaskFailed = 'true';
      return;
    }

    const cleaned = stripSvgBackground(svgText);
    const uri = this._encodeSvgDataUri(cleaned);

    const thumb = btn.querySelector('.sh-icon-picker__thumb');
    if (thumb) {
      // Update the CSS var used by mask-image
      thumb.style.setProperty('--sh-icon-url', `url("${uri}")`);
    }

    btn.dataset.shMaskReady = 'true';
  }

  _hydrateMaskPreviews(root) {
    // Fire-and-forget, guard against re-entrancy.
    if (this._maskHydrateRunning) return;
    this._maskHydrateRunning = true;

    const run = async () => {
      try {
        const btns = Array.from(root.querySelectorAll('.sh-icon-picker__item[data-src]'));
        if (!btns.length) return;

        // Small concurrency to keep UI responsive.
        const concurrency = 6;
        let idx = 0;

        const worker = async () => {
          while (idx < btns.length) {
            const b = btns[idx++];
            await this._hydrateOneMaskPreview(b);
          }
        };

        const workers = [];
        for (let i = 0; i < concurrency; i++) workers.push(worker());
        await Promise.allSettled(workers);
      } finally {
        this._maskHydrateRunning = false;
      }
    };

    // Allow initial paint first.
    setTimeout(() => run(), 0);
  }

  _setSelected(root, id) {
    const nextId = String(id ?? '').trim();
    if (!nextId) return;

    // Update DOM selection
    const prev = root.querySelector('.sh-icon-picker__item.is-selected');
    if (prev) prev.classList.remove('is-selected');

    const nextEl = Array.from(root.querySelectorAll('[data-action="select-icon"][data-id]'))
      .find((b) => String(b.dataset.id ?? '') === nextId);
    if (nextEl) nextEl.classList.add('is-selected');

    this._selectedId = nextId;
    this._syncConfirmButton(root);
  }

  async _confirmSelection() {
    const icon = this._getSelectedIcon();
    if (!icon) return;

    const payload = {
      srcPath: String(icon.path ?? ''),
      color: this._color,
    };

    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve(payload);
    }

    await this.close();
  }

  async _refreshIcons() {
    if (!this._loadIcons) return;

    try {
      const icons = await this._loadIcons();
      this._icons = Array.isArray(icons) ? icons : [];
      this._selectedId = '';
      await this.render(false);
    } catch (e) {
      console.error('SpaceHolder | IconPicker: refresh failed', e);
      ui.notifications?.error?.(_L('SPACEHOLDER.IconPicker.Errors.RefreshFailed'));
    }
  }

  _onRootInput(ev) {
    const root = ev.currentTarget;

    const search = ev.target?.closest?.('input[data-action="search"]');
    if (search) {
      this._query = String(search.value ?? '');
      this._applyFiltersToDom(root);
      return;
    }

    const category = ev.target?.closest?.('select[data-action="category"]');
    if (category) {
      this._category = String(category.value ?? '');
      this._applyFiltersToDom(root);
      return;
    }

    const color = ev.target?.closest?.('input[type="color"][data-action="color"]');
    if (color) {
      this._color = _normalizeColor(color.value, this._color);
      try {
        root.style.setProperty('--sh-icon-color', this._color);
      } catch (_) {
        // ignore
      }
      return;
    }
  }

  async _onRootClick(ev) {
    const root = ev.currentTarget;
    const el = ev.target?.closest?.('[data-action]');
    if (!el) return;

    const action = String(el.dataset.action ?? '').trim();

    if (action === 'select-icon') {
      ev.preventDefault();
      ev.stopPropagation();
      this._setSelected(root, el.dataset.id);
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
      return;
    }

    if (action === 'refresh') {
      ev.preventDefault();
      ev.stopPropagation();
      await this._refreshIcons();
    }
  }

  async _onRootDblClick(ev) {
    const root = ev.currentTarget;
    const el = ev.target?.closest?.('[data-action="select-icon"]');
    if (!el) return;

    ev.preventDefault();
    ev.stopPropagation();

    this._setSelected(root, el.dataset.id);
    await this._confirmSelection();
  }
}

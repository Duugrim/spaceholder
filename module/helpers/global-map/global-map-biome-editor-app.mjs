// Global Map Biome Editor (Foundry v13, ApplicationV2)
// Stores overrides as JSON in: worlds/<worldId>/global-maps/biome-overrides.json

const PATTERN_TYPES = [
  { value: '', label: '(без паттерна)' },
  { value: 'diagonal', label: 'Диагональные линии' },
  { value: 'crosshatch', label: 'Штриховка (крест-накрест)' },
  { value: 'vertical', label: 'Вертикальные линии' },
  { value: 'horizontal', label: 'Горизонтальные линии' },
  { value: 'dots', label: 'Точки' },
  { value: 'circles', label: 'Круги' },
  { value: 'waves', label: 'Волны' },
  { value: 'hexagons', label: 'Шестиугольники' },
  { value: 'spots', label: 'Пятна' },
];

function clamp01(n, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

function normalizeHexToInt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value & 0xFFFFFF;

  let s = String(value).trim();
  if (!s) return null;

  if (s.startsWith('#')) s = s.slice(1);
  if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);

  s = s.replace(/[^0-9a-fA-F]/g, '');
  if (s.length === 3) s = s.split('').map(ch => ch + ch).join('');
  if (s.length !== 6) return null;

  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return null;
  return n & 0xFFFFFF;
}

function normalizeHexToHex6(value) {
  const n = normalizeHexToInt(value);
  if (n === null) return null;
  return n.toString(16).padStart(6, '0').toUpperCase();
}

function intToCssHex(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '#000000';
  return `#${(v & 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase()}`;
}

function darkenColorInt(colorInt, factor) {
  const f = clamp01(factor, 0.4);
  const r = (colorInt >> 16) & 0xFF;
  const g = (colorInt >> 8) & 0xFF;
  const b = colorInt & 0xFF;
  const nr = Math.floor(r * (1 - f));
  const ng = Math.floor(g * (1 - f));
  const nb = Math.floor(b * (1 - f));
  return ((nr << 16) | (ng << 8) | nb) & 0xFFFFFF;
}

export class GlobalMapBiomeEditorApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-globalmap-biome-editor',
    classes: ['spaceholder', 'globalmap-biome-editor'],
    tag: 'div',
    window: { title: 'Биомы (Global Map)', resizable: true },
    position: { width: 860, height: 720 },
  };

  static PARTS = {
    main: { root: true, template: 'systems/spaceholder/templates/global-map/biome-editor.hbs' },
  };

  constructor({ biomeResolver, onSaved } = {}) {
    super();
    this.biomeResolver = biomeResolver;
    this.onSaved = typeof onSaved === 'function' ? onSaved : null;

    this._loaded = false;
    this._biomes = []; // editable list

    this._reloadOnNextRender = false;
  }

  async _loadFromResolver() {
    if (!this.biomeResolver) {
      this._biomes = [];
      this._loaded = true;
      return;
    }

    // Ensure base + world overrides are applied
    try {
      if (typeof this.biomeResolver.reloadConfigWithWorldOverrides === 'function') {
        await this.biomeResolver.reloadConfigWithWorldOverrides();
      }
    } catch (e) {
      console.warn('GlobalMapBiomeEditorApp | Failed to reload biome resolver:', e);
    }

    const list = this.biomeResolver.listBiomes();

    this._biomes = list.map((b) => {
      const id = Number(b.id);

      const colorInt = this.biomeResolver.getBiomeColor(id);
      const color = intToCssHex(colorInt);

      const pat = this.biomeResolver.getBiomePattern(id);
      const patType = (pat && typeof pat.type === 'string') ? pat.type : '';
      const patColor = pat?.patternColor ? `#${normalizeHexToHex6(pat.patternColor)}` : '';

      return {
        id,
        name: String(b.name ?? `Biome ${id}`),
        renderRank: Number.isFinite(b.renderRank) ? b.renderRank : 0,
        color,
        pattern: {
          type: PATTERN_TYPES.some(t => t.value === patType) ? patType : '',
          patternColor: patColor,
          spacing: Number.isFinite(Number(pat?.spacing)) ? Number(pat.spacing) : 2.0,
          lineWidth: Number.isFinite(Number(pat?.lineWidth)) ? Number(pat.lineWidth) : 0.6,
          opacity: Number.isFinite(Number(pat?.opacity)) ? Number(pat.opacity) : 0.9,
          darkenFactor: Number.isFinite(Number(pat?.darkenFactor)) ? Number(pat.darkenFactor) : 0.4,
        },
      };
    });

    this._loaded = true;
  }

  _getSortedBiomes() {
    const arr = Array.isArray(this._biomes) ? [...this._biomes] : [];
    arr.sort((a, b) => {
      const ra = Number(a?.renderRank) || 0;
      const rb = Number(b?.renderRank) || 0;
      if (ra !== rb) return ra - rb;
      return (Number(a?.id) || 0) - (Number(b?.id) || 0);
    });
    return arr;
  }

  async _prepareContext(_options) {
    if (!this._loaded || this._reloadOnNextRender) {
      this._reloadOnNextRender = false;
      await this._loadFromResolver();
    }

    const path = this.biomeResolver?.getWorldOverridesPath?.() || '';

    return {
      filePath: path,
      patternTypes: PATTERN_TYPES,
      biomes: this._getSortedBiomes(),
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    const el = this.element;
    if (!el) return;

    // Buttons
    el.querySelectorAll('[data-action="add-biome"]').forEach(btn => btn.addEventListener('click', this._onAddBiome.bind(this)));
    el.querySelectorAll('[data-action="save"]').forEach(btn => btn.addEventListener('click', this._onSave.bind(this)));
    el.querySelectorAll('[data-action="reload"]').forEach(btn => btn.addEventListener('click', this._onReload.bind(this)));
    el.querySelectorAll('[data-action="reset-overrides"]').forEach(btn => btn.addEventListener('click', this._onResetOverrides.bind(this)));
    el.querySelectorAll('[data-action="pattern-color-auto"]').forEach(btn => btn.addEventListener('click', this._onPatternColorAuto.bind(this)));

    // Inputs (event delegation would also work, но так проще)
    el.querySelectorAll('[data-biome-id] input[data-field], [data-biome-id] select[data-field]').forEach((input) => {
      input.addEventListener('change', this._onFieldChange.bind(this));
      input.addEventListener('input', this._onFieldInput.bind(this));
    });

    // Previews
    this._renderAllPreviews();
  }

  _findBiome(id) {
    const n = Number(id);
    if (!Number.isFinite(n)) return null;
    return this._biomes.find(b => Number(b.id) === n) || null;
  }

  _renderAllPreviews() {
    const el = this.element;
    if (!el) return;

    el.querySelectorAll('canvas[data-preview="biome"]').forEach((canvas) => {
      const id = Number(canvas.dataset.biomeId);
      const biome = this._findBiome(id);
      if (!biome) return;
      this._drawBiomePreview(canvas, biome);
    });
  }

  _drawBiomePreview(canvas, biome) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = Math.min(canvas.width || 64, canvas.height || 64);

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = biome.color || '#000000';
    ctx.fillRect(0, 0, size, size);

    const pattern = biome.pattern || null;
    const type = String(pattern?.type || '');
    if (!type) {
      // Border
      ctx.strokeStyle = 'rgba(255,255,255,0.20)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
      return;
    }

    const baseInt = normalizeHexToInt(biome.color) ?? 0x000000;
    const patInt = normalizeHexToInt(pattern.patternColor) ?? darkenColorInt(baseInt, pattern.darkenFactor);

    const opacity = clamp01(pattern.opacity, 0.9);

    const cellSize = 12;
    const spacingPx = Math.max(2, cellSize * (Number(pattern.spacing) || 2.0));
    const lineWidthPx = Math.max(1, cellSize * (Number(pattern.lineWidth) || 0.6));

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = intToCssHex(patInt);
    ctx.fillStyle = intToCssHex(patInt);
    ctx.lineWidth = lineWidthPx;

    const drawDiagonal = (angleRad) => {
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.rotate(angleRad);
      ctx.translate(-size / 2, -size / 2);

      const diag = Math.sqrt(2) * size;
      for (let x = -diag; x <= diag * 2; x += spacingPx) {
        ctx.beginPath();
        ctx.moveTo(x, -diag);
        ctx.lineTo(x, diag * 2);
        ctx.stroke();
      }

      ctx.restore();
    };

    switch (type) {
      case 'diagonal':
        drawDiagonal(Math.PI / 4);
        break;

      case 'crosshatch':
        drawDiagonal(Math.PI / 4);
        drawDiagonal(-Math.PI / 4);
        break;

      case 'vertical':
        for (let x = 0; x <= size; x += spacingPx) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, size);
          ctx.stroke();
        }
        break;

      case 'horizontal':
        for (let y = 0; y <= size; y += spacingPx) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(size, y);
          ctx.stroke();
        }
        break;

      case 'dots': {
        const r = Math.max(1, lineWidthPx * 0.8);
        for (let y = spacingPx / 2; y < size; y += spacingPx) {
          for (let x = spacingPx / 2; x < size; x += spacingPx) {
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
      }

      case 'circles': {
        const cx = size / 2;
        const cy = size / 2;
        const maxR = Math.sqrt(cx * cx + cy * cy);
        for (let r = spacingPx; r <= maxR + spacingPx; r += spacingPx) {
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }

      case 'waves': {
        // Horizontal sine waves
        const waveHeight = spacingPx * 0.25;
        const waveLen = spacingPx * 2.5;
        const step = 2;

        for (let y0 = spacingPx / 2; y0 <= size + spacingPx; y0 += spacingPx) {
          ctx.beginPath();
          let first = true;
          for (let x = 0; x <= size + step; x += step) {
            const phase = (x / waveLen) * Math.PI * 2;
            const y = y0 + Math.sin(phase) * waveHeight;
            if (first) {
              ctx.moveTo(x, y);
              first = false;
            } else {
              ctx.lineTo(x, y);
            }
          }
          ctx.stroke();
        }
        break;
      }

      case 'hexagons': {
        const hexSize = Math.max(4, spacingPx * 0.6);
        const w = hexSize * 2;
        const h = Math.sqrt(3) * hexSize;
        const stepX = w * 0.75;
        const stepY = h;

        const drawHex = (cx, cy) => {
          ctx.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i;
            const x = cx + hexSize * Math.cos(a);
            const y = cy + hexSize * Math.sin(a);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.stroke();
        };

        for (let row = -1; row * stepY <= size + stepY; row++) {
          for (let col = -1; col * stepX <= size + stepX; col++) {
            const x = col * stepX;
            const y = row * stepY + (col % 2) * (stepY / 2);
            drawHex(x, y);
          }
        }
        break;
      }

      case 'spots': {
        // Deterministic pseudo-random
        let seed = Number(biome.id) + 12345;
        const rnd = () => {
          seed = (seed * 9301 + 49297) % 233280;
          return seed / 233280;
        };

        const count = Math.max(8, Math.floor((size * size) / (spacingPx * spacingPx)));
        const minR = Math.max(1, lineWidthPx * 1.2);
        const maxR = Math.max(minR + 1, spacingPx * 0.35);

        for (let i = 0; i < count; i++) {
          const x = rnd() * size;
          const y = rnd() * size;
          const r = minR + rnd() * (maxR - minR);
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }

      default:
        // Fallback: diagonal
        drawDiagonal(Math.PI / 4);
        break;
    }

    ctx.restore();

    // Border
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  }

  _getNextFreeIdLocal() {
    const used = new Set((this._biomes || []).map(b => Number(b.id)));
    for (let id = 0; id <= 255; id++) {
      if (!used.has(id)) return id;
    }
    return null;
  }

  async _onAddBiome(event) {
    event?.preventDefault?.();

    const id = this._getNextFreeIdLocal();
    if (id === null) {
      ui.notifications?.warn?.('Достигнут лимит: больше нет свободных ID (0..255)');
      return;
    }

    // Put new biomes on top by default
    const maxRank = this._biomes.reduce((m, b) => Math.max(m, Number(b.renderRank) || 0), 0);

    this._biomes.push({
      id,
      name: `Новый биом ${id}`,
      renderRank: maxRank + 10,
      color: '#808080',
      pattern: {
        type: '',
        patternColor: '',
        spacing: 2.0,
        lineWidth: 0.6,
        opacity: 0.9,
        darkenFactor: 0.4,
      },
    });

    await this.render(true);
  }

  _readValueFromInput(input) {
    const type = String(input.type || '').toLowerCase();
    if (type === 'number') {
      const n = Number(input.value);
      return Number.isFinite(n) ? n : 0;
    }
    return input.value;
  }

  _applyFieldToBiome(biome, field, value) {
    if (!biome) return;

    switch (field) {
      case 'name':
        biome.name = String(value ?? '').trim();
        return;

      case 'renderRank':
        biome.renderRank = Number.isFinite(Number(value)) ? Number(value) : 0;
        return;

      case 'color':
        biome.color = String(value || '').trim() || '#000000';
        return;

      default:
        break;
    }

    if (field.startsWith('pattern.')) {
      if (!biome.pattern) {
        biome.pattern = { type: '', patternColor: '', spacing: 2.0, lineWidth: 0.6, opacity: 0.9, darkenFactor: 0.4 };
      }

      const key = field.slice('pattern.'.length);
      if (key === 'type') {
        const v = String(value || '');
        biome.pattern.type = PATTERN_TYPES.some(t => t.value === v) ? v : '';
        return;
      }

      if (key === 'patternColor') {
        biome.pattern.patternColor = String(value || '').trim();
        return;
      }

      if (['spacing', 'lineWidth', 'opacity', 'darkenFactor'].includes(key)) {
        const n = Number(value);
        biome.pattern[key] = Number.isFinite(n) ? n : biome.pattern[key];
        return;
      }
    }
  }

  _onFieldChange(event) {
    const input = event.currentTarget;
    const row = input.closest('[data-biome-id]');
    if (!row) return;

    const id = Number(row.dataset.biomeId);
    const biome = this._findBiome(id);
    if (!biome) return;

    const field = String(input.dataset.field || '');
    const value = this._readValueFromInput(input);

    this._applyFieldToBiome(biome, field, value);

    // If rank changed, re-render to re-sort list
    if (field === 'renderRank') {
      this.render(true);
      return;
    }

    if (field === 'pattern.patternColor') {
      this._syncPatternColorUI(row, biome);
    }

    // Redraw preview for this row only
    const canvas = row.querySelector('canvas[data-preview="biome"]');
    if (canvas) {
      this._drawBiomePreview(canvas, biome);
    }
  }

  _onFieldInput(event) {
    // Keep state in sync while typing (esp. name/patternColor), but avoid full rerender.
    const input = event.currentTarget;
    const row = input.closest('[data-biome-id]');
    if (!row) return;

    const id = Number(row.dataset.biomeId);
    const biome = this._findBiome(id);
    if (!biome) return;

    const field = String(input.dataset.field || '');
    if (!field) return;

    // Only handle lightweight fields on input
    if (field !== 'name' && field !== 'pattern.patternColor') return;

    const value = this._readValueFromInput(input);
    this._applyFieldToBiome(biome, field, value);

    if (field === 'pattern.patternColor') {
      this._syncPatternColorUI(row, biome);
    }

    const canvas = row.querySelector('canvas[data-preview="biome"]');
    if (canvas) {
      this._drawBiomePreview(canvas, biome);
    }
  }

  _syncPatternColorUI(row, biome) {
    if (!row || !biome) return;

    const raw = String(biome?.pattern?.patternColor || '').trim();
    const hex6 = normalizeHexToHex6(raw);

    const display = row.querySelector('[data-display="pattern.patternColor"]');
    if (display) {
      display.textContent = raw ? raw : '(авто)';
    }

    const colorInput = row.querySelector('input[type="color"][data-field="pattern.patternColor"]');
    if (colorInput) {
      // input[type=color] cannot have empty value.
      colorInput.value = hex6 ? `#${hex6}` : '#000000';
    }
  }

  _onPatternColorAuto(event) {
    event?.preventDefault?.();

    const btn = event.currentTarget;
    const row = btn?.closest?.('[data-biome-id]');
    if (!row) return;

    const id = Number(row.dataset.biomeId);
    const biome = this._findBiome(id);
    if (!biome) return;

    if (!biome.pattern) {
      biome.pattern = { type: '', patternColor: '', spacing: 2.0, lineWidth: 0.6, opacity: 0.9, darkenFactor: 0.4 };
    }

    biome.pattern.patternColor = '';

    this._syncPatternColorUI(row, biome);

    const canvas = row.querySelector('canvas[data-preview="biome"]');
    if (canvas) {
      this._drawBiomePreview(canvas, biome);
    }
  }

  _buildOverridesPayload() {
    const biomes = this._getSortedBiomes().map((b) => {
      const id = Number(b.id);
      const name = String(b.name || '').trim();
      const rank = Number(b.renderRank);

      const colorHex6 = normalizeHexToHex6(b.color) || '000000';

      const patType = String(b.pattern?.type || '');

      let pattern = null;
      if (patType) {
        const p = b.pattern || {};
        const patternColorHex6 = normalizeHexToHex6(p.patternColor);

        pattern = {
          type: patType,
          ...(patternColorHex6 ? { patternColor: patternColorHex6 } : {}),
          ...(Number.isFinite(Number(p.spacing)) ? { spacing: Number(p.spacing) } : {}),
          ...(Number.isFinite(Number(p.lineWidth)) ? { lineWidth: Number(p.lineWidth) } : {}),
          ...(Number.isFinite(Number(p.opacity)) ? { opacity: Number(p.opacity) } : {}),
          ...(Number.isFinite(Number(p.darkenFactor)) ? { darkenFactor: Number(p.darkenFactor) } : {}),
        };
      } else {
        // Explicitly remove pattern
        pattern = null;
      }

      return {
        id,
        ...(name ? { name } : {}),
        color: colorHex6,
        renderRank: Number.isFinite(rank) ? rank : 0,
        pattern,
      };
    });

    return { version: 1, biomes };
  }

  async _reloadAllResolvers() {
    try {
      await game?.spaceholder?.globalMapProcessing?.biomeResolver?.reloadConfigWithWorldOverrides?.();
    } catch (e) {
      // ignore
    }

    try {
      await game?.spaceholder?.globalMapRenderer?.biomeResolver?.reloadConfigWithWorldOverrides?.();
    } catch (e) {
      // ignore
    }

    // Re-render map if it is already loaded
    try {
      const r = game?.spaceholder?.globalMapRenderer;
      if (r?.currentGrid && r?.currentMetadata) {
        await r.render(r.currentGrid, r.currentMetadata);
      }
    } catch (e) {
      // ignore
    }

    // Refresh tools UI palette if open
    try {
      game?.spaceholder?.globalMapTools?.refreshBiomeLists?.();
    } catch (e) {
      // ignore
    }
  }

  async _onSave(event) {
    event?.preventDefault?.();

    if (!this.biomeResolver?.saveOverridesToWorldFile) {
      ui.notifications?.error?.('BiomeResolver не поддерживает сохранение overrides');
      return;
    }

    try {
      const payload = this._buildOverridesPayload();
      await this.biomeResolver.saveOverridesToWorldFile(payload);

      ui.notifications?.info?.('Биомы сохранены (biome-overrides.json)');

      await this._reloadAllResolvers();

      if (this.onSaved) {
        try { await this.onSaved(); } catch (e) { /* ignore */ }
      }

      // Reload state from resolver to ensure we display the merged result
      this._reloadOnNextRender = true;
      await this.render(true);
    } catch (e) {
      console.error('GlobalMapBiomeEditorApp | Save failed:', e);
      ui.notifications?.error?.(`Не удалось сохранить биомы: ${e.message}`);
    }
  }

  async _onReload(event) {
    event?.preventDefault?.();
    this._reloadOnNextRender = true;
    await this.render(true);
  }

  async _onResetOverrides(event) {
    event?.preventDefault?.();

    const ok = await Dialog.confirm({
      title: 'Сбросить biome-overrides.json?',
      content: '<p>Это очистит файл overrides и вернёт стандартные биомы (после перезагрузки списка).</p>',
      yes: () => true,
      no: () => false,
    });

    if (!ok) return;

    try {
      await this.biomeResolver.saveOverridesToWorldFile({ version: 1, biomes: [] });
      ui.notifications?.info?.('Overrides очищены');

      await this._reloadAllResolvers();

      this._reloadOnNextRender = true;
      await this.render(true);
    } catch (e) {
      console.error('GlobalMapBiomeEditorApp | Reset failed:', e);
      ui.notifications?.error?.(`Не удалось очистить overrides: ${e.message}`);
    }
  }
}

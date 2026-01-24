import { GlobalMapBiomeEditorApp } from './global-map-biome-editor-app.mjs';
import { bakeGlobalMapToSceneBackground, showGlobalMapImportDialog } from './global-map-ui.mjs';

const MODULE_NS = 'spaceholder';
const UI_ID = 'spaceholder-globalmap-edge-ui';
const TEMPLATE_PATH = 'systems/spaceholder/templates/global-map/edge-panel.hbs';

const CLIENT_SETTING_RIVER_LABEL_ROTATE = 'globalmap.rotateRiverLabels';
const CLIENT_SETTING_APPEAR_ANIM = 'globalmap.appearanceAnimation';
const CLIENT_SETTING_APPEAR_ANIM_DURATION = 'globalmap.appearanceAnimationDurationMs';

function _t(key) {
  return game?.i18n?.localize ? game.i18n.localize(key) : String(key);
}

function _f(key, data) {
  return game?.i18n?.format ? game.i18n.format(key, data) : String(key);
}

function _registerGlobalMapClientSettings() {
  try {
    const s = game?.settings?.settings;
    if (
      s?.has?.(`${MODULE_NS}.${CLIENT_SETTING_RIVER_LABEL_ROTATE}`)
      && s?.has?.(`${MODULE_NS}.${CLIENT_SETTING_APPEAR_ANIM}`)
      && s?.has?.(`${MODULE_NS}.${CLIENT_SETTING_APPEAR_ANIM_DURATION}`)
    ) {
      return;
    }
  } catch (e) {
    // ignore
  }

  try {
    game?.settings?.register?.(MODULE_NS, CLIENT_SETTING_RIVER_LABEL_ROTATE, {
      name: _t('SPACEHOLDER.GlobalMap.ClientSettings.RotateRiverLabels.Name'),
      hint: _t('SPACEHOLDER.GlobalMap.ClientSettings.RotateRiverLabels.Hint'),
      scope: 'client',
      config: false,
      type: Boolean,
      default: true,
      onChange: () => {
        try {
          const r = game?.spaceholder?.globalMapRenderer;
          if (r?.currentMetadata && r?.vectorRiversData) {
            r.renderVectorRivers?.(r.vectorRiversData, r.currentMetadata);
          }
        } catch (e) {
          // ignore
        }
      },
    });
  } catch (e) {
    // ignore
  }

  try {
    game?.settings?.register?.(MODULE_NS, CLIENT_SETTING_APPEAR_ANIM, {
      name: _t('SPACEHOLDER.GlobalMap.ClientSettings.AppearanceAnimations.Name'),
      hint: _t('SPACEHOLDER.GlobalMap.ClientSettings.AppearanceAnimations.Hint'),
      scope: 'client',
      config: false,
      type: Boolean,
      default: true,
      onChange: () => {
        try {
          const r = game?.spaceholder?.globalMapRenderer;
          if (r?.currentMetadata) {
            if (r?.vectorRegionsData) r.renderVectorRegions?.(r.vectorRegionsData, r.currentMetadata);
            if (r?.vectorRiversData) r.renderVectorRivers?.(r.vectorRiversData, r.currentMetadata);
          }
        } catch (e) {
          // ignore
        }
      },
    });
  } catch (e) {
    // ignore
  }

  try {
    game?.settings?.register?.(MODULE_NS, CLIENT_SETTING_APPEAR_ANIM_DURATION, {
      name: _t('SPACEHOLDER.GlobalMap.ClientSettings.AppearanceAnimationDuration.Name'),
      hint: _t('SPACEHOLDER.GlobalMap.ClientSettings.AppearanceAnimationDuration.Hint'),
      scope: 'client',
      config: false,
      type: Number,
      default: 180,
      onChange: () => {
        try {
          const r = game?.spaceholder?.globalMapRenderer;
          if (r?.currentMetadata) {
            if (r?.vectorRegionsData) r.renderVectorRegions?.(r.vectorRegionsData, r.currentMetadata);
            if (r?.vectorRiversData) r.renderVectorRivers?.(r.vectorRiversData, r.currentMetadata);
          }
        } catch (e) {
          // ignore
        }
      },
    });
  } catch (e) {
    // ignore
  }
}

let _hooksInstalled = false;
let _uiInstance = null;

function _isGlobalMapScene(scene) {
  return !!(
    scene?.getFlag?.(MODULE_NS, 'isGlobalMap')
    ?? scene?.flags?.[MODULE_NS]?.isGlobalMap
  );
}

function _isGlobalMapFlagChanged(changes) {
  if (!changes || typeof changes !== 'object') return false;

  const flags = changes.flags;
  if (flags && typeof flags === 'object') {
    const sh = flags[MODULE_NS];
    if (sh && typeof sh === 'object' && 'isGlobalMap' in sh) return true;
  }

  for (const k of Object.keys(changes)) {
    if (k === `flags.${MODULE_NS}.isGlobalMap` || k.startsWith(`flags.${MODULE_NS}.isGlobalMap`)) return true;
  }

  return false;
}

class GlobalMapEdgeUI {
  constructor() {
    this.flyoutLeftOpen = false;
    this.flyoutRightOpen = false;
    this.inspectorOpen = true;

    // Inspector state (bottom panel)
    this.inspectorUpdatesEnabled = true;
    this._lastInspectPos = null; // {x,y} in stage coords
    this._inspectSyncSeq = 0;

    this._inspectedBiomeId = null;
    this._inspectedBiomeName = _t('SPACEHOLDER.GlobalMap.Common.Unknown');
    this._inspectedBiomeJournalUuid = '';
    this._inspectedBiomeJournalName = '';

    this._inspectedRegionId = '';
    this._inspectedRegionName = '';
    this._inspectedRegionJournalUuid = '';
    this._inspectedRegionJournalName = '';

    this._inspectedInfluenceSideUuid = '';
    this._inspectedInfluenceName = '';
    this._inspectedInfluenceJournalName = '';
    this._inspectedInfluenceTooltip = '';

    // Canvas stage listener for inspector clicks
    this._inspectorStageForListeners = null;
    this._onInspectorStagePointerDown = null;

    // Selected token state (top bar)
    this._selectedTokenDocIds = new Set();
    this._selectedActorIds = new Set();
    this._tokenSyncSeq = 0;
    this._uuidNameCache = new Map();

    // Journals to open for top buttons (computed from current selection)
    this._selectedLinkUuid = '';
    this._selectedFactionUuid = '';

    this._onClick = this._onClick.bind(this);
    this._onResize = this._onResize.bind(this);

    // Keep identity text fitted when viewport changes
    try {
      window.addEventListener('resize', this._onResize);
    } catch (e) {
      // ignore
    }
  }

  get element() {
    return document.getElementById(UI_ID);
  }

  async render({ scene } = {}) {
    const existing = this.element;
    if (existing) {
      this._syncUiState(existing);
      this._syncRenderModeSelectors(existing);
      this._syncInspectorUpdatesUi(existing);
      this._syncInspectorUi(existing);
      this._syncTimelineButtonVisibility(existing);
      this._installInspectorDomHandlers(existing);
      this._installFlyoutDomHandlers(existing);
      this._installInspectorStageHandler();
      await this._syncSelectedTokenInfo(existing);
      this._syncUndoRedoButtons(existing);
      this._fitAll(existing);
      return;
    }

    const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, {
      sceneName: scene?.name ?? '',
      isGM: !!game?.user?.isGM,
      showTimeline: this._canShowTimelineButton(),
      tokenName: '',
      tokenFaction: '',
    });

    const wrap = document.createElement('div');
    wrap.innerHTML = String(html || '').trim();
    const el = wrap.firstElementChild;
    if (!el) return;

    document.body.appendChild(el);
    el.addEventListener('click', this._onClick);
    this._syncUiState(el);
    this._syncRenderModeSelectors(el);
    this._syncInspectorUpdatesUi(el);
    this._syncInspectorUi(el);
    this._syncTimelineButtonVisibility(el);
    this._installInspectorDomHandlers(el);
    this._installFlyoutDomHandlers(el);
    this._installInspectorStageHandler();
    await this._syncSelectedTokenInfo(el);
    this._syncUndoRedoButtons(el);
    this._fitAll(el);
  }

  destroy() {
    const el = this.element;
    if (!el) return;

    try {
      el.removeEventListener('click', this._onClick);
    } catch (e) {
      // ignore
    }

    // Inspector: detach stage listener and clear cached state
    this._removeInspectorStageHandler();
    this._lastInspectPos = null;
    this._inspectSyncSeq++;
    this._inspectedBiomeId = null;
    this._inspectedBiomeName = _t('SPACEHOLDER.GlobalMap.Common.Unknown');
    this._inspectedBiomeJournalUuid = '';
    this._inspectedBiomeJournalName = '';
    this._inspectedRegionId = '';
    this._inspectedRegionName = '';
    this._inspectedRegionJournalUuid = '';
    this._inspectedRegionJournalName = '';
    this._inspectedInfluenceSideUuid = '';
    this._inspectedInfluenceName = '';
    this._inspectedInfluenceJournalName = '';
    this._inspectedInfluenceTooltip = '';

    // Reset token state so we don't keep stale ids across scenes
    this._selectedTokenDocIds = new Set();
    this._selectedActorIds = new Set();
    this._selectedLinkUuid = '';
    this._selectedFactionUuid = '';
    this._tokenSyncSeq++;

    el.remove();
  }

  _onResize() {
    const root = this.element;
    if (!root) return;
    this._fitAll(root);
  }

  _fitText(el) {
    if (!el) return;

    const max = Math.max(1, Number(el.dataset.fitMax) || 12);
    const min = Math.max(1, Number(el.dataset.fitMin) || 8);

    // Reset to max before measuring
    el.style.fontSize = `${max}px`;

    // Reduce font size until it fits
    for (let size = max; size >= min; size--) {
      el.style.fontSize = `${size}px`;
      if (el.scrollWidth <= el.clientWidth + 1) break;
    }
  }

  _fitAll(root) {
    try {
      root.querySelectorAll('[data-autofit]').forEach((el) => this._fitText(el));
    } catch (e) {
      // ignore
    }
  }

  _syncUiState(root) {
    const leftOpen = !!this.flyoutLeftOpen;
    const rightOpen = !!this.flyoutRightOpen;
    const inspectorOpen = !!this.inspectorOpen;

    root.dataset.flyoutLeft = leftOpen ? 'true' : 'false';
    root.dataset.flyoutRight = rightOpen ? 'true' : 'false';
    root.dataset.inspector = inspectorOpen ? 'true' : 'false';

    root.classList.toggle('is-flyout-left-open', leftOpen);
    root.classList.toggle('is-flyout-right-open', rightOpen);
    root.classList.toggle('is-inspector-open', inspectorOpen);

    const leftToggle = root.querySelector('[data-action="toggle-flyout"][data-side="left"]');
    if (leftToggle) leftToggle.setAttribute('aria-expanded', leftOpen ? 'true' : 'false');

    const rightToggle = root.querySelector('[data-action="toggle-flyout"][data-side="right"]');
    if (rightToggle) rightToggle.setAttribute('aria-expanded', rightOpen ? 'true' : 'false');

    const inspToggle = root.querySelector('[data-action="toggle-inspector"]');
    if (inspToggle) inspToggle.setAttribute('aria-expanded', inspectorOpen ? 'true' : 'false');

    const leftFlyout = root.querySelector('.sh-gm-edge__flyout--left');
    if (leftFlyout) leftFlyout.setAttribute('aria-hidden', leftOpen ? 'false' : 'true');

    const rightFlyout = root.querySelector('.sh-gm-edge__flyout--right');
    if (rightFlyout) rightFlyout.setAttribute('aria-hidden', rightOpen ? 'false' : 'true');

    const inspector = root.querySelector('.sh-gm-edge__inspector');
    if (inspector) inspector.setAttribute('aria-hidden', inspectorOpen ? 'false' : 'true');
  }

  _togglePressed(btn) {
    const cur = btn.getAttribute('aria-pressed');
    const isPressed = cur === 'true';
    const next = !isPressed;

    btn.setAttribute('aria-pressed', next ? 'true' : 'false');
    btn.classList.toggle('is-active', next);
  }

  _selectOption(btn) {
    const groupId = String(btn.dataset.select || '').trim();
    const value = String(btn.dataset.value || '').trim();
    if (!groupId || !value) return;

    const root = this.element;
    if (!root) return;

    const group = root.querySelector(
      `.sh-gm-edge__selector[data-select="${groupId}"], .sh-gm-edge__iconGroup[data-select="${groupId}"]`
    );
    if (!group) return;

    group.dataset.value = value;

    group.querySelectorAll('button[data-action="select"]').forEach((b) => {
      const isActive = b === btn;
      b.classList.toggle('is-active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  _syncRenderModeSelectors(_root = null) {
    const root = this.element;
    if (!root) return;

    const renderer = game?.spaceholder?.globalMapRenderer;
    if (!renderer) return;

    // ===== Map render modes =====
    const biomesMode = String(renderer.biomesMode || 'fancy');
    const heightsMode = String(renderer.heightsMode || 'contours-bw');

    const biomesBtn = root.querySelector(`button[data-action="select"][data-select="biomes"][data-value="${biomesMode}"]`);
    if (biomesBtn) this._selectOption(biomesBtn);

    const heightsBtn = root.querySelector(`button[data-action="select"][data-select="heights"][data-value="${heightsMode}"]`);
    if (heightsBtn) this._selectOption(heightsBtn);

    // ===== Rivers / Regions visibility settings =====
    const riversLabelMode = String(renderer?.vectorRiversData?.settings?.labelMode || 'hover');
    const riversLabelBtn = root.querySelector(`button[data-action="select"][data-select="riverLabels"][data-value="${riversLabelMode}"]`);
    if (riversLabelBtn) this._selectOption(riversLabelBtn);

    // ===== Client-only visual toggles =====
    const rotateEnabled = (() => {
      try {
        const v = game?.settings?.get?.(MODULE_NS, CLIENT_SETTING_RIVER_LABEL_ROTATE);
        return (v === undefined) ? true : !!v;
      } catch (e) {
        return true;
      }
    })();

    const rotateBtn = root.querySelector(
      `button[data-action="select"][data-select="riverLabelRotate"][data-value="${rotateEnabled ? 'on' : 'off'}"]`
    );
    if (rotateBtn) this._selectOption(rotateBtn);

    const animEnabled = (() => {
      try {
        const v = game?.settings?.get?.(MODULE_NS, CLIENT_SETTING_APPEAR_ANIM);
        return (v === undefined) ? true : !!v;
      } catch (e) {
        return true;
      }
    })();

    const animBtn = root.querySelector(
      `button[data-action="select"][data-select="appearAnim"][data-value="${animEnabled ? 'on' : 'off'}"]`
    );
    if (animBtn) this._selectOption(animBtn);

    const durRaw = (() => {
      try {
        return game?.settings?.get?.(MODULE_NS, CLIENT_SETTING_APPEAR_ANIM_DURATION);
      } catch (e) {
        return 180;
      }
    })();

    const dur = (() => {
      const n = Number(durRaw);
      if (!Number.isFinite(n)) return 180;
      return Math.max(0, Math.min(2000, Math.round(n)));
    })();

    const durInput = root.querySelector('input[data-field="appearAnimDurationMs"]');
    if (durInput) {
      // Don't clobber while user is typing
      if (document.activeElement !== durInput) {
        durInput.value = String(dur);
      }
      durInput.disabled = !animEnabled;
    }

    const regionsRenderMode = String(renderer?.vectorRegionsData?.settings?.renderMode || 'full');
    const regionsRenderBtn = root.querySelector(`button[data-action="select"][data-select="regions"][data-value="${regionsRenderMode}"]`);
    if (regionsRenderBtn) this._selectOption(regionsRenderBtn);

    const regionsWhenMode = String(renderer?.vectorRegionsData?.settings?.labelMode || 'hover');
    const regionsWhenBtn = root.querySelector(`button[data-action="select"][data-select="regionsWhen"][data-value="${regionsWhenMode}"]`);
    if (regionsWhenBtn) this._selectOption(regionsWhenBtn);

    const smoothIterationsRaw = Number.parseInt(renderer?.vectorRegionsData?.settings?.smoothIterations, 10);
    const smoothIterations = Number.isFinite(smoothIterationsRaw) ? Math.max(0, Math.min(4, smoothIterationsRaw)) : 4;
    const smoothBtn = root.querySelector(`button[data-action="select"][data-select="smooth"][data-value="${String(smoothIterations)}"]`);
    if (smoothBtn) this._selectOption(smoothBtn);
  }

  _syncUndoRedoButtons(root = null) {
    const el = root || this.element;
    if (!el) return;

    const tools = game?.spaceholder?.globalMapTools;
    const canUndo = !!tools && typeof tools._canUndo === 'function' ? tools._canUndo() : false;
    const canRedo = !!tools && typeof tools._canRedo === 'function' ? tools._canRedo() : false;

    const undoBtn = el.querySelector('button[data-action="global-map-undo"]');
    const redoBtn = el.querySelector('button[data-action="global-map-redo"]');

    if (undoBtn) undoBtn.disabled = !canUndo;
    if (redoBtn) redoBtn.disabled = !canRedo;
  }

  _getControlledTokens() {
    const controlled = canvas?.tokens?.controlled;
    return Array.isArray(controlled) ? controlled : [];
  }

  _getSelectedToken() {
    const controlled = this._getControlledTokens();
    if (controlled.length) {
      // Prefer most recently controlled token
      return controlled[controlled.length - 1];
    }
    return null;
  }

  _normalizeUuid(raw) {
    const str = String(raw ?? '').trim();
    if (!str) return '';
    const match = str.match(/@UUID\[(.+?)\]/);
    return (match?.[1] ?? str).trim();
  }

  _getFactionColorCss(system) {
    const gFaction = String(system?.gFaction ?? '').trim();
    const key = this._normalizeUuid(gFaction);
    if (!key) return '';

    const im = game?.spaceholder?.influenceManager;
    const n = im?.getColorForSide?.(key);
    if (typeof n !== 'number') return '';
    return `#${n.toString(16).padStart(6, '0')}`;
  }

  _toCssHex(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    return `#${(v & 0xFFFFFF).toString(16).padStart(6, '0')}`;
  }

  _darkenColorInt(color, factor = 0.4) {
    const c = Number(color);
    const fRaw = Number(factor);
    const f = Number.isFinite(fRaw) ? Math.max(0, Math.min(1, fRaw)) : 0;

    if (!Number.isFinite(c)) return 0;

    const r = (c >> 16) & 0xFF;
    const g = (c >> 8) & 0xFF;
    const b = c & 0xFF;

    const newR = Math.floor(r * (1 - f));
    const newG = Math.floor(g * (1 - f));
    const newB = Math.floor(b * (1 - f));

    return (newR << 16) | (newG << 8) | newB;
  }

  _getInfluenceColorCss(rawSideUuid) {
    const key = this._normalizeUuid(rawSideUuid);
    if (!key) return '';

    const im = game?.spaceholder?.influenceManager;
    const n = im?.getColorForSide?.(key);
    if (typeof n !== 'number') return '';
    return this._toCssHex(n);
  }

  _syncInspectorInfluenceOutlineUi(root = null) {
    const el = root || this.element;
    if (!el) return;

    const inspectorEl = el.querySelector('.sh-gm-edge__inspector');
    if (!inspectorEl) return;

    const color = this._getInfluenceColorCss(this._inspectedInfluenceSideUuid);
    if (color) {
      inspectorEl.style.setProperty('--sh-gm-edge-influence-outline-color', color);
      inspectorEl.style.setProperty('--sh-gm-edge-influence-outline-width', '4px');
    } else {
      inspectorEl.style.removeProperty('--sh-gm-edge-influence-outline-color');
      inspectorEl.style.removeProperty('--sh-gm-edge-influence-outline-width');
    }
  }

  _clearCanvas(canvasEl) {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext?.('2d');
    if (!ctx) return;

    const w = Number(canvasEl.width) || 0;
    const h = Number(canvasEl.height) || 0;

    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
  }

  _syncInspectorBiomeSwatchUi(root = null) {
    const el = root || this.element;
    if (!el) return;

    const canvasEl = el.querySelector('canvas[data-field="inspectBiomeSwatch"]');
    if (!canvasEl) return;

    const biomeId = this._inspectedBiomeId;
    if (!Number.isFinite(biomeId)) {
      this._clearCanvas(canvasEl);
      return;
    }

    const sh = game?.spaceholder;
    const resolver = sh?.globalMapProcessing?.biomeResolver || sh?.globalMapRenderer?.biomeResolver;

    let baseColor = 0x000000;
    let patternConfig = null;

    try {
      baseColor = resolver?.getBiomeColor?.(biomeId);
    } catch (e) {
      baseColor = 0x000000;
    }

    try {
      patternConfig = resolver?.getBiomePattern?.(biomeId);
    } catch (e) {
      patternConfig = null;
    }

    this._drawBiomeSwatch(canvasEl, baseColor, patternConfig, biomeId);
  }

  _drawBiomeSwatch(canvasEl, baseColor, patternConfig, seed = 0) {
    const ctx = canvasEl?.getContext?.('2d');
    if (!ctx) return;

    const w = Math.max(1, Number(canvasEl.width) || 24);
    const h = Math.max(1, Number(canvasEl.height) || 24);

    // Base fill
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this._toCssHex(baseColor) || '#000000';
    ctx.fillRect(0, 0, w, h);

    if (!patternConfig || typeof patternConfig !== 'object') return;

    const type = String(patternConfig.type || '').trim();
    if (!type) return;

    const spacingMultRaw = Number(patternConfig.spacing);
    const lineWidthMultRaw = Number(patternConfig.lineWidth);
    const opacityRaw = Number(patternConfig.opacity);
    const darkenRaw = Number(patternConfig.darkenFactor);

    const spacingMult = Number.isFinite(spacingMultRaw) ? spacingMultRaw : 2.0;
    const lineWidthMult = Number.isFinite(lineWidthMultRaw) ? lineWidthMultRaw : 0.6;
    const opacity = Number.isFinite(opacityRaw) ? Math.max(0, Math.min(1, opacityRaw)) : 0.9;
    const darkenFactor = Number.isFinite(darkenRaw) ? Math.max(0, Math.min(1, darkenRaw)) : 0.4;

    let patternColorInt = null;
    if (patternConfig.patternColor) {
      const n = parseInt(String(patternConfig.patternColor).trim(), 16);
      if (Number.isFinite(n)) patternColorInt = n & 0xFFFFFF;
    }
    if (patternColorInt === null) {
      patternColorInt = this._darkenColorInt(baseColor, darkenFactor);
    }

    const patternColorCss = this._toCssHex(patternColorInt) || '#000000';

    const size = Math.min(w, h);
    const cellSize = Math.max(1, size / 8);

    const spacing = Math.max(1, cellSize * spacingMult);
    const lineWidth = Math.max(1, cellSize * lineWidthMult);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const drawLine = (x1, y1, x2, y2) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };

    const drawCircle = (cx, cy, r) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    };

    const drawFilledCircle = (cx, cy, r) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    };

    const drawHexagon = (cx, cy, r) => {
      const angles = [0, 60, 120, 180, 240, 300].map((a) => a * Math.PI / 180);
      ctx.beginPath();
      ctx.moveTo(cx + r * Math.cos(angles[0]), cy + r * Math.sin(angles[0]));
      for (let i = 1; i < angles.length; i++) {
        ctx.lineTo(cx + r * Math.cos(angles[i]), cy + r * Math.sin(angles[i]));
      }
      ctx.closePath();
      ctx.stroke();
    };

    if (type === 'dots' || type === 'spots') {
      ctx.fillStyle = patternColorCss;
      ctx.globalAlpha = opacity;
    } else {
      ctx.strokeStyle = patternColorCss;
      ctx.lineWidth = lineWidth;
      ctx.globalAlpha = opacity;
    }

    const diagonal = Math.sqrt(w ** 2 + h ** 2);

    switch (type) {
      case 'diagonal': {
        for (let offset = -diagonal; offset < diagonal * 2; offset += spacing) {
          drawLine(0, offset, diagonal, offset - diagonal);
        }
        break;
      }
      case 'crosshatch': {
        for (let offset = -diagonal; offset < diagonal * 2; offset += spacing) {
          drawLine(0, offset, diagonal, offset - diagonal);
        }
        for (let offset = -diagonal; offset < diagonal * 2; offset += spacing) {
          drawLine(0, h - offset, diagonal, h - offset + diagonal);
        }
        break;
      }
      case 'vertical': {
        for (let x = 0; x <= w; x += spacing) {
          drawLine(x, 0, x, h);
        }
        break;
      }
      case 'horizontal': {
        for (let y = 0; y <= h; y += spacing) {
          drawLine(0, y, w, y);
        }
        break;
      }
      case 'circles': {
        const cx = w / 2;
        const cy = h / 2;
        const maxR = Math.sqrt(cx ** 2 + cy ** 2);
        for (let r = spacing; r <= maxR + spacing; r += spacing) {
          drawCircle(cx, cy, r);
        }
        break;
      }
      case 'dots': {
        const r = Math.max(1, lineWidth);
        const start = spacing / 2;
        for (let y = start; y <= h; y += spacing) {
          for (let x = start; x <= w; x += spacing) {
            drawFilledCircle(x, y, r);
          }
        }
        break;
      }
      case 'waves': {
        ctx.strokeStyle = patternColorCss;
        ctx.lineWidth = lineWidth;
        ctx.globalAlpha = opacity;

        const waveHeight = cellSize * spacingMult * 0.25;
        const waveLength = cellSize * 4;
        const step = Math.max(1, cellSize * 0.5);

        for (let y = spacing / 2; y <= h; y += spacing) {
          let first = true;
          ctx.beginPath();

          for (let x = 0; x <= w + step; x += step) {
            const phase = (x / waveLength) * Math.PI * 2;
            const yy = y + Math.sin(phase) * waveHeight;
            if (first) {
              ctx.moveTo(x, yy);
              first = false;
            } else {
              ctx.lineTo(x, yy);
            }
          }

          ctx.stroke();
        }

        break;
      }
      case 'hexagons': {
        ctx.strokeStyle = patternColorCss;
        ctx.lineWidth = Math.max(1, lineWidth * 0.8);
        ctx.globalAlpha = opacity;

        const hexSize = cellSize * spacingMult;
        const hexWidth = hexSize * 2;
        const hexHeight = Math.sqrt(3) * hexSize;

        for (let row = 0; row * hexHeight <= h + hexHeight; row++) {
          for (let col = 0; col * hexWidth * 0.75 <= w + hexWidth; col++) {
            const x = col * hexWidth * 0.75;
            const y = row * hexHeight + (col % 2) * (hexHeight / 2);
            drawHexagon(x, y, hexSize);
          }
        }

        break;
      }
      case 'spots': {
        const spacingLocal = spacing;
        const minRadius = Math.max(1, lineWidth * 0.5);
        const maxRadius = Math.max(2, lineWidth * 1.5);

        let random = Number(seed) + 12345;
        const seededRandom = () => {
          random = (random * 9301 + 49297) % 233280;
          return random / 233280;
        };

        const start = spacingLocal / 2;
        for (let y = start; y <= h; y += spacingLocal) {
          for (let x = start; x <= w; x += spacingLocal) {
            const offsetX = (seededRandom() - 0.5) * spacingLocal * 0.8;
            const offsetY = (seededRandom() - 0.5) * spacingLocal * 0.8;
            const r = minRadius + seededRandom() * (maxRadius - minRadius);

            if (seededRandom() > 0.3) {
              drawFilledCircle(x + offsetX, y + offsetY, r);
            }
          }
        }

        break;
      }
      default: {
        for (let offset = -diagonal; offset < diagonal * 2; offset += spacing) {
          drawLine(0, offset, diagonal, offset - diagonal);
        }
        break;
      }
    }

    ctx.restore();
  }

  async _resolveDocName(rawUuid) {
    const uuid = this._normalizeUuid(rawUuid);
    if (!uuid) return '';

    if (this._uuidNameCache.has(uuid)) {
      return this._uuidNameCache.get(uuid) || '';
    }

    let doc = null;
    try {
      doc = await fromUuid(uuid);
    } catch (e) {
      doc = null;
    }

    const name = String(doc?.name ?? '');
    this._uuidNameCache.set(uuid, name);
    return name;
  }

  async _openJournalUuid(rawUuid) {
    const uuid = this._normalizeUuid(rawUuid);
    if (!uuid) return false;

    let doc = null;
    try {
      doc = await fromUuid(uuid);
    } catch (e) {
      doc = null;
    }

    if (!doc) return false;

    if (doc.documentName === 'JournalEntryPage' && doc.parent?.sheet?.render) {
      doc.parent.sheet.render(true);
      return true;
    }

    if (doc.sheet?.render) {
      doc.sheet.render(true);
      return true;
    }

    return false;
  }

  async _openFactionLinkByUuid(rawFactionUuid) {
    const factionUuid = this._normalizeUuid(rawFactionUuid);
    if (!factionUuid) return false;

    let doc = null;
    try {
      doc = await fromUuid(factionUuid);
    } catch (e) {
      doc = null;
    }

    if (!doc || doc.documentName !== 'Actor' || doc.type !== 'faction') return false;

    const linkUuid = this._normalizeUuid(doc.system?.fLink);
    if (!linkUuid) return false;

    return this._openJournalUuid(linkUuid);
  }

  _requireGM(actionKey = 'SPACEHOLDER.GlobalMap.Permissions.Actions.UseTool') {
    if (game?.user?.isGM) return true;
    const action = _t(actionKey);
    ui.notifications?.warn?.(_f('SPACEHOLDER.GlobalMap.Permissions.GMOnly', { action }));
    return false;
  }

  _clone(obj) {
    try {
      if (foundry?.utils?.duplicate) return foundry.utils.duplicate(obj);
    } catch (e) {
      // ignore
    }
    return JSON.parse(JSON.stringify(obj));
  }

  async _setRiversLabelMode(mode) {
    const renderer = game?.spaceholder?.globalMapRenderer;
    if (!renderer) return;

    const m = String(mode || '').trim();
    if (!['off', 'hover', 'always'].includes(m)) return;

    if (renderer.vectorRiversData === null || renderer.vectorRiversData === undefined) {
      try {
        await renderer.loadVectorRiversFromScene?.(canvas?.scene);
      } catch (e) {
        // ignore
      }
    }

    const cur = (renderer.vectorRiversData && typeof renderer.vectorRiversData === 'object')
      ? renderer.vectorRiversData
      : { version: 1, settings: { labelMode: 'hover', snapToEndpoints: true }, rivers: [] };

    const next = this._clone(cur);
    if (!next.settings || typeof next.settings !== 'object') next.settings = {};
    next.settings.labelMode = m;

    renderer.setVectorRiversData(next);
  }

  async _setRegionsRenderMode(mode) {
    const renderer = game?.spaceholder?.globalMapRenderer;
    if (!renderer) return;

    const m = String(mode || '').trim();
    if (!['name', 'border', 'full'].includes(m)) return;

    if (renderer.vectorRegionsData === null || renderer.vectorRegionsData === undefined) {
      try {
        await renderer.loadVectorRegionsFromScene?.(canvas?.scene);
      } catch (e) {
        // ignore
      }
    }

    const cur = (renderer.vectorRegionsData && typeof renderer.vectorRegionsData === 'object')
      ? renderer.vectorRegionsData
: { version: 1, settings: { labelMode: 'hover', clickAction: 'none', clickModifier: 'none', smoothIterations: 4, renderMode: 'full' }, regions: [] };

    const next = this._clone(cur);
    if (!next.settings || typeof next.settings !== 'object') next.settings = {};
    next.settings.renderMode = m;

    renderer.setVectorRegionsData(next);
  }

  async _setRegionsWhenMode(mode) {
    const renderer = game?.spaceholder?.globalMapRenderer;
    if (!renderer) return;

    const m = String(mode || '').trim();
    if (!['off', 'hover', 'always'].includes(m)) return;

    if (renderer.vectorRegionsData === null || renderer.vectorRegionsData === undefined) {
      try {
        await renderer.loadVectorRegionsFromScene?.(canvas?.scene);
      } catch (e) {
        // ignore
      }
    }

    const cur = (renderer.vectorRegionsData && typeof renderer.vectorRegionsData === 'object')
      ? renderer.vectorRegionsData
: { version: 1, settings: { labelMode: 'hover', clickAction: 'none', clickModifier: 'none', smoothIterations: 4, renderMode: 'full' }, regions: [] };

    const next = this._clone(cur);
    if (!next.settings || typeof next.settings !== 'object') next.settings = {};
    next.settings.labelMode = m;

    renderer.setVectorRegionsData(next);
  }

  async _setClientSettingOnOff(key, value) {
    const v = String(value || '').trim();
    if (!['on', 'off'].includes(v)) return;

    const enabled = v === 'on';

    try {
      await game?.settings?.set?.(MODULE_NS, key, enabled);
    } catch (e) {
      // ignore
    }
  }

  async _setClientSettingNumber(key, value, { min = 0, max = 2000, fallback = 180 } = {}) {
    let n = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(n)) n = Number(fallback);
    if (!Number.isFinite(n)) n = 0;

    const clamped = Math.max(Number(min) || 0, Math.min(Number(max) || 0, n));

    try {
      await game?.settings?.set?.(MODULE_NS, key, clamped);
    } catch (e) {
      // ignore
    }
  }

  async _setRegionsSmoothIterations(value) {
    const renderer = game?.spaceholder?.globalMapRenderer;
    if (!renderer) return;

    const raw = Number.parseInt(String(value || '').trim(), 10);
    const v = Number.isFinite(raw) ? Math.max(0, Math.min(4, raw)) : 4;

    if (renderer.vectorRegionsData === null || renderer.vectorRegionsData === undefined) {
      try {
        await renderer.loadVectorRegionsFromScene?.(canvas?.scene);
      } catch (e) {
        // ignore
      }
    }

    const cur = (renderer.vectorRegionsData && typeof renderer.vectorRegionsData === 'object')
      ? renderer.vectorRegionsData
: { version: 1, settings: { labelMode: 'hover', clickAction: 'none', clickModifier: 'none', smoothIterations: 4, renderMode: 'full' }, regions: [] };

    const next = this._clone(cur);
    if (!next.settings || typeof next.settings !== 'object') next.settings = {};
    next.settings.smoothIterations = v;

    renderer.setVectorRegionsData(next);
  }

  async _syncSelectedTokenInfo(root = null) {
    const el = root || this.element;
    if (!el) return;

    const seq = ++this._tokenSyncSeq;

    const tokens = this._getControlledTokens();

    // Track selection ids for update hooks
    this._selectedTokenDocIds.clear();
    this._selectedActorIds.clear();

    for (const t of tokens) {
      const td = t?.document;
      if (td?.id) this._selectedTokenDocIds.add(td.id);
      const a = td?.actor;
      if (a?.id) this._selectedActorIds.add(a.id);
    }

    // Default: no token
    let tokenName = '';
    let tokenFactionText = '';
    let selectedFactionUuid = '';
    let selectedLinkUuid = '';

    if (tokens.length === 1) {
      const token = tokens[0];
      const tokenDoc = token?.document ?? null;
      const actor = tokenDoc?.actor ?? token?.actor ?? null;
      const isGlobalObject = actor?.type === 'globalobject';
      const sys = actor?.system;

      tokenName = String(tokenDoc?.name ?? '');

      selectedFactionUuid = isGlobalObject ? this._normalizeUuid(sys?.gFaction) : '';
      selectedLinkUuid = isGlobalObject ? this._normalizeUuid(sys?.gLink) : '';

      tokenFactionText = selectedFactionUuid ? await this._resolveDocName(selectedFactionUuid) : '';
    } else if (tokens.length > 1) {
      tokenName = _t('SPACEHOLDER.GlobalMap.Edge.Selection.MultipleTokens');

      // Determine if ALL selected tokens share the same (non-empty) faction uuid
      let allSameFaction = true;
      let firstFaction = null;

      for (const t of tokens) {
        const actor = t?.document?.actor ?? null;
        const isGlobalObject = actor?.type === 'globalobject';
        const uuid = isGlobalObject ? this._normalizeUuid(actor?.system?.gFaction) : '';

        if (!uuid) {
          allSameFaction = false;
          break;
        }

        if (!firstFaction) {
          firstFaction = uuid;
        } else if (uuid !== firstFaction) {
          allSameFaction = false;
          break;
        }
      }

      if (allSameFaction && firstFaction) {
        selectedFactionUuid = firstFaction;
        tokenFactionText = await this._resolveDocName(firstFaction);
      } else {
        tokenFactionText = _t('SPACEHOLDER.GlobalMap.Edge.Selection.MultipleFactions');
      }

      // For multiple selection we do not expose per-token link.
      selectedLinkUuid = '';
    }

    // stale async guard
    if (seq !== this._tokenSyncSeq) return;

    this._selectedFactionUuid = selectedFactionUuid;
    this._selectedLinkUuid = selectedLinkUuid;

    // Text fields
    const nameEl = el.querySelector('[data-field="tokenName"]');
    if (nameEl) nameEl.textContent = tokenName;

    const factionEl = el.querySelector('[data-field="tokenFaction"]');
    if (factionEl) factionEl.textContent = tokenFactionText;

    // Faction accent (outline): only when we have a single faction selected
    const factionColor = selectedFactionUuid ? this._getFactionColorCss({ gFaction: selectedFactionUuid }) : '';
    if (factionColor) {
      el.style.setProperty('--sh-gm-edge-faction-outline-color', factionColor);
      el.style.setProperty('--sh-gm-edge-faction-outline-width', '4px');
    } else {
      el.style.removeProperty('--sh-gm-edge-faction-outline-color');
      el.style.removeProperty('--sh-gm-edge-faction-outline-width');
    }

    // Buttons: faction / link
    const factionBtn = el.querySelector('button[data-action="open-token-faction"]');
    if (factionBtn) factionBtn.hidden = !selectedFactionUuid;

    const linkBtn = el.querySelector('button[data-action="open-token-link"]');
    if (linkBtn) linkBtn.hidden = !selectedLinkUuid;

    // Refit after content changes
    this._fitAll(el);
  }

  _canShowTimelineButton() {
    if (game?.user?.isGM) return true;
    try {
      const uuids = game?.spaceholder?.getUserFactionUuids?.(game.user) ?? [];
      return Array.isArray(uuids) && uuids.length > 0;
    } catch (e) {
      return false;
    }
  }

  _syncTimelineButtonVisibility(root = null) {
    const el = root || this.element;
    if (!el) return;

    const btn = el.querySelector('button[data-action="open-timeline"]');
    if (!btn) return;

    btn.hidden = !this._canShowTimelineButton();
  }

  _syncInspectorUpdatesUi(root = null) {
    const el = root || this.element;
    if (!el) return;

    const btn = el.querySelector('button[data-action="toggle-inspector-updates"]');
    if (!btn) return;

    // aria-pressed=true means "updates paused"
    const paused = !this.inspectorUpdatesEnabled;
    btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    btn.classList.toggle('is-active', paused);

    const icon = btn.querySelector('i');
    if (icon) {
      icon.classList.remove('fa-lock', 'fa-lock-open');
      icon.classList.add(paused ? 'fa-lock' : 'fa-lock-open');
    }

    const tip = paused
      ? _t('SPACEHOLDER.GlobalMap.Edge.InspectorUpdates.Off')
      : _t('SPACEHOLDER.GlobalMap.Edge.InspectorUpdates.On');
    btn.setAttribute('data-tooltip', tip);
    btn.setAttribute('aria-label', tip);
  }

  _syncInspectorUi(root = null) {
    const el = root || this.element;
    if (!el) return;

    this._syncInspectorInfluenceOutlineUi(el);
    this._syncInspectorBiomeSwatchUi(el);

    // Values
    const biomeValueEl = el.querySelector('[data-field="inspectBiomeValue"]');
    if (biomeValueEl) biomeValueEl.textContent = String(this._inspectedBiomeName || _t('SPACEHOLDER.GlobalMap.Common.Unknown'));

    const regionValueEl = el.querySelector('[data-field="inspectRegionValue"]');
    if (regionValueEl) regionValueEl.textContent = String(this._inspectedRegionName || '');

    const influenceValueEl = el.querySelector('[data-field="inspectInfluenceValue"]');
    if (influenceValueEl) influenceValueEl.textContent = String(this._inspectedInfluenceName || '');

    // Influence tooltip (on the whole column so it works even when value is empty)
    const inflCol = el.querySelector('.sh-gm-edge__inspectCol[data-scope="influence"]');
    if (inflCol) {
      const tip = String(this._inspectedInfluenceTooltip || '');
      if (tip) {
        inflCol.setAttribute('data-tooltip', tip);
        inflCol.setAttribute('aria-label', tip);
      } else {
        inflCol.removeAttribute('data-tooltip');
        inflCol.removeAttribute('aria-label');
      }
    }

    // Helper
    const setHidden = (node, hidden) => {
      if (!node) return;
      node.hidden = !!hidden;
    };

    // ===== Biome journal =====
    const biomeLinkedRow = el.querySelector('[data-scope="biomeJournalLinked"]');
    const biomeBindRow = el.querySelector('[data-scope="biomeJournalBind"]');
    const biomeHasContext = Number.isFinite(this._inspectedBiomeId);
    const biomeUuid = String(this._inspectedBiomeJournalUuid || '').trim();

    if (biomeUuid) {
      setHidden(biomeLinkedRow, false);
      setHidden(biomeBindRow, true);

      const nameEl = biomeLinkedRow?.querySelector?.('[data-field="inspectBiomeJournalName"]');
      if (nameEl) nameEl.textContent = String(this._inspectedBiomeJournalName || biomeUuid);

      const inputEl = biomeBindRow?.querySelector?.('input[data-field="inspectBiomeJournalUuid"]');
      if (inputEl) inputEl.value = '';
    } else {
      setHidden(biomeLinkedRow, true);
      setHidden(biomeBindRow, !biomeHasContext);

      const inputEl = biomeBindRow?.querySelector?.('input[data-field="inspectBiomeJournalUuid"]');
      if (inputEl) inputEl.value = '';
    }

    // ===== Region journal =====
    const regionLinkedRow = el.querySelector('[data-scope="regionJournalLinked"]');
    const regionBindRow = el.querySelector('[data-scope="regionJournalBind"]');
    const regionHasContext = !!String(this._inspectedRegionId || '').trim();
    const regionUuid = String(this._inspectedRegionJournalUuid || '').trim();

    if (regionUuid) {
      setHidden(regionLinkedRow, false);
      setHidden(regionBindRow, true);

      const nameEl = regionLinkedRow?.querySelector?.('[data-field="inspectRegionJournalName"]');
      if (nameEl) nameEl.textContent = String(this._inspectedRegionJournalName || regionUuid);

      const inputEl = regionBindRow?.querySelector?.('input[data-field="inspectRegionJournalUuid"]');
      if (inputEl) inputEl.value = '';
    } else {
      setHidden(regionLinkedRow, true);
      setHidden(regionBindRow, !regionHasContext);

      const inputEl = regionBindRow?.querySelector?.('input[data-field="inspectRegionJournalUuid"]');
      if (inputEl) inputEl.value = '';
    }

    // ===== Influence journal =====
    const inflLinkedRow = el.querySelector('[data-scope="influenceJournalLinked"]');
    const inflUuid = String(this._inspectedInfluenceSideUuid || '').trim();
    if (inflUuid) {
      setHidden(inflLinkedRow, false);
      const nameEl = inflLinkedRow?.querySelector?.('[data-field="inspectInfluenceJournalName"]');
      if (nameEl) nameEl.textContent = String(this._inspectedInfluenceJournalName || inflUuid);
    } else {
      setHidden(inflLinkedRow, true);
    }
  }

  _installInspectorDomHandlers(root = null) {
    const el = root || this.element;
    if (!el) return;

    if (el.dataset?.shInspectorHandlers === 'true') return;
    el.dataset.shInspectorHandlers = 'true';

    // Drop zones for binding journals
    el.querySelectorAll('.sh-gm-edge__journalRow[data-drop-scope]').forEach((zone) => {
      zone.addEventListener('dragover', (ev) => ev.preventDefault());
      zone.addEventListener('drop', async (ev) => {
        ev.preventDefault();

        const scope = String(zone.dataset.dropScope || '').trim();
        const uuid = this._extractUuidFromDropEvent(ev);
        if (!uuid) {
          ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.DropUuidNotFound'));
          return;
        }

        if (scope === 'biome') {
          const input = zone.querySelector('input[data-field="inspectBiomeJournalUuid"]');
          if (input) input.value = uuid;
          await this._setInspectedBiomeJournalUuid(uuid);
        }

        if (scope === 'region') {
          const input = zone.querySelector('input[data-field="inspectRegionJournalUuid"]');
          if (input) input.value = uuid;
          await this._setInspectedRegionJournalUuid(uuid);
        }
      });
    });

    // Inputs: Enter -> apply
    el.querySelectorAll('input[data-field="inspectBiomeJournalUuid"], input[data-field="inspectRegionJournalUuid"]').forEach((input) => {
      input.addEventListener('keydown', async (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();

        const zone = input.closest('.sh-gm-edge__journalRow[data-drop-scope]');
        const scope = String(zone?.dataset?.dropScope || '').trim();

        if (scope === 'biome') {
          await this._setInspectedBiomeJournalUuid(input.value);
        }

        if (scope === 'region') {
          await this._setInspectedRegionJournalUuid(input.value);
        }
      });
    });
  }

  _installFlyoutDomHandlers(root = null) {
    const el = root || this.element;
    if (!el) return;

    if (el.dataset?.shFlyoutHandlers === 'true') return;
    el.dataset.shFlyoutHandlers = 'true';

    const input = el.querySelector('input[data-field="appearAnimDurationMs"]');
    if (!input) return;

    const apply = async () => {
      await this._setClientSettingNumber(CLIENT_SETTING_APPEAR_ANIM_DURATION, input.value, { min: 0, max: 2000, fallback: 180 });
      this._syncRenderModeSelectors(el);
    };

    input.addEventListener('keydown', async (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      await apply();
      try { input.blur(); } catch (e) { /* ignore */ }
    });

    input.addEventListener('change', () => {
      apply().catch(() => {});
    });
  }

  _installInspectorStageHandler() {
    const stage = canvas?.stage;
    if (!stage) return;

    // Stage can get rebuilt and, in some cases, its listeners can be cleared on soft reloads.
    // Always (re)bind to ensure inspector keeps working.
    const stageChanged = this._inspectorStageForListeners !== stage;
    if (stageChanged) {
      this._removeInspectorStageHandler();
      this._inspectorStageForListeners = stage;
    }

    if (!this._onInspectorStagePointerDown) {
      this._onInspectorStagePointerDown = (event) => {
        try {
          this._handleInspectorStagePointerDown(event);
        } catch (e) {
          // ignore
        }
      };
    }

    // Ensure single binding (no duplicates) and restore after any internal stage resets.
    try {
      stage.off('pointerdown', this._onInspectorStagePointerDown);
    } catch (e) {
      // ignore
    }

    try {
      stage.on('pointerdown', this._onInspectorStagePointerDown);
    } catch (e) {
      // ignore
    }
  }

  _removeInspectorStageHandler() {
    const stage = this._inspectorStageForListeners;
    const handler = this._onInspectorStagePointerDown;

    if (stage && handler) {
      try {
        stage.off('pointerdown', handler);
      } catch (e) {
        // ignore
      }
    }

    this._inspectorStageForListeners = null;
    this._onInspectorStagePointerDown = null;
  }

  _handleInspectorStagePointerDown(event) {
    if (!this.element) return;
    if (!this.inspectorUpdatesEnabled) return;

    // Left click only
    if (event?.data?.button !== 0) return;

    const pos = event?.data?.getLocalPosition?.(canvas.stage);
    if (!pos) return;

    this._lastInspectPos = { x: pos.x, y: pos.y };

    // Fire and forget (no UI-blocking)
    this._inspectAtPosition(pos.x, pos.y).catch(() => {});
  }

  _extractUuidFromDropEvent(event) {
    const dt = event?.dataTransfer;
    if (!dt) return '';

    const rawCandidates = [
      dt.getData('application/json'),
      dt.getData('text/plain'),
    ].filter(Boolean);

    for (const raw of rawCandidates) {
      try {
        const data = JSON.parse(raw);
        const uuid = data?.uuid || data?.data?.uuid;
        if (uuid) return this._normalizeUuid(uuid);
      } catch (e) {
        const uuid = this._normalizeUuid(raw);
        if (uuid) return uuid;
      }
    }

    return '';
  }

  async _resolveDocNameSafe(rawUuid) {
    const uuid = this._normalizeUuid(rawUuid);
    if (!uuid) return '';
    const name = await this._resolveDocName(uuid);
    return name || uuid;
  }

  async _validateJournalUuid(rawUuid) {
    const uuid = this._normalizeUuid(rawUuid);
    if (!uuid) return '';

    let doc = null;
    try {
      doc = await fromUuid(uuid);
    } catch (e) {
      doc = null;
    }

    if (!doc) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.DocNotFoundByUuid'));
      return null;
    }

    if (!['JournalEntry', 'JournalEntryPage'].includes(doc.documentName)) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.ExpectedJournalDoc'));
      return null;
    }

    return uuid;
  }

  async _reloadBiomeResolversAndRerender() {
    // Keep processing + renderer in sync
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

  async _setInspectedBiomeJournalUuid(rawUuid) {
    if (!this._requireGM('SPACEHOLDER.GlobalMap.Permissions.Actions.BindJournals')) return false;

    const id = this._inspectedBiomeId;
    if (!Number.isFinite(id)) return false;

    const uuidNorm = this._normalizeUuid(rawUuid);
    const uuid = uuidNorm ? (await this._validateJournalUuid(uuidNorm)) : '';
    if (uuid === null) return false;

    const sh = game?.spaceholder;
    const resolver = sh?.globalMapProcessing?.biomeResolver || sh?.globalMapRenderer?.biomeResolver;

    if (!resolver?.saveOverridesToWorldFile) {
      ui.notifications?.error?.(_t('SPACEHOLDER.GlobalMap.Errors.BiomeResolverOverridesNotSupported'));
      return false;
    }

    let overrides = null;
    try {
      overrides = await resolver.loadOverridesFromWorldFile?.();
    } catch (e) {
      overrides = null;
    }

    if (!overrides || typeof overrides !== 'object') {
      overrides = { version: 2, biomes: [] };
    }
    if (!Array.isArray(overrides.biomes)) {
      overrides.biomes = [];
    }

    let entry = overrides.biomes.find(b => Number(b?.id) === id) || null;
    if (!entry) {
      entry = { id };
      overrides.biomes.push(entry);
    }

    if (uuid) {
      entry.link = uuid;
    } else {
      delete entry.link;

      // If entry is otherwise empty, remove it to avoid clutter
      const keys = Object.keys(entry || {}).filter(k => k !== 'id');
      if (keys.length === 0) {
        const idx = overrides.biomes.indexOf(entry);
        if (idx >= 0) overrides.biomes.splice(idx, 1);
      }
    }

    try {
      await resolver.saveOverridesToWorldFile(overrides);
    } catch (e) {
      console.error('SpaceHolder | Global map edge UI: failed to save biome journal link', e);
      ui.notifications?.error?.(_f('SPACEHOLDER.GlobalMap.Errors.SaveBiomeJournalFailed', { message: e.message }));
      return false;
    }

    await this._reloadBiomeResolversAndRerender();

    const pos = this._lastInspectPos;
    if (pos) {
      await this._inspectAtPosition(pos.x, pos.y);
    } else {
      this._syncInspectorUi();
    }

    return true;
  }

  async _setInspectedRegionJournalUuid(rawUuid) {
    if (!this._requireGM('SPACEHOLDER.GlobalMap.Permissions.Actions.BindJournals')) return false;

    const regionId = String(this._inspectedRegionId || '').trim();
    if (!regionId) return false;

    const uuidNorm = this._normalizeUuid(rawUuid);
    const uuid = uuidNorm ? (await this._validateJournalUuid(uuidNorm)) : '';
    if (uuid === null) return false;

    const scene = canvas?.scene;
    if (!scene?.setFlag) return false;

    const renderer = game?.spaceholder?.globalMapRenderer;
    const cur = renderer?.vectorRegionsData;
    if (!cur || typeof cur !== 'object') return false;

    const next = this._clone(cur);
    if (!Array.isArray(next.regions)) next.regions = [];

    const region = next.regions.find(r => String(r?.id) === regionId);
    if (!region) return false;

    region.journalUuid = uuid;

    try {
      await scene.setFlag(MODULE_NS, 'globalMapRegions', next);
    } catch (e) {
      console.error('SpaceHolder | Global map edge UI: failed to save region journal link', e);
      ui.notifications?.error?.(_f('SPACEHOLDER.GlobalMap.Errors.SaveRegionJournalFailed', { message: e.message }));
      return false;
    }

    try {
      renderer.setVectorRegionsData?.(next, renderer.currentMetadata);
    } catch (e) {
      // ignore
    }

    const pos = this._lastInspectPos;
    if (pos) {
      await this._inspectAtPosition(pos.x, pos.y);
    } else {
      this._syncInspectorUi();
    }

    return true;
  }

  async _inspectAtPosition(x, y) {
    const seq = ++this._inspectSyncSeq;

    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;

    // Store last click position for "refresh after save"
    this._lastInspectPos = { x: px, y: py };

    const sh = game?.spaceholder;
    const renderer = sh?.globalMapRenderer;
    const processing = sh?.globalMapProcessing;
    const biomeResolver = processing?.biomeResolver || renderer?.biomeResolver;

    // ===== Biome =====
    let biomeId = null;
    let biomeName = _t('SPACEHOLDER.GlobalMap.Common.Unknown');
    let biomeJournalUuid = '';

    const grid = renderer?.currentGrid;
    const md = renderer?.currentMetadata;
    if (grid && md && biomeResolver) {
      try {
        const { rows, cols, biomes, moisture, temperature } = grid;
        const { cellSize, bounds } = md;

        const gridCol = Math.floor((px - bounds.minX) / cellSize);
        const gridRow = Math.floor((py - bounds.minY) / cellSize);

        if (gridRow >= 0 && gridRow < rows && gridCol >= 0 && gridCol < cols) {
          const idx = gridRow * cols + gridCol;

          const moist = moisture ? moisture[idx] : 0;
          const temp = temperature ? temperature[idx] : 0;

          biomeId = (biomes && biomes.length === rows * cols)
            ? biomes[idx]
            : biomeResolver.getBiomeId(moist ?? 0, temp ?? 0);

          biomeName = biomeResolver.getBiomeName(biomeId);
          biomeJournalUuid = biomeResolver.getBiomeLink?.(biomeId) || '';
        }
      } catch (e) {
        // ignore
      }
    }

    // ===== Region =====
    let regionId = '';
    let regionName = '';
    let regionJournalUuid = '';

    try {
      if (renderer?.findRegionAt) {
        const hit = renderer.findRegionAt(px, py);
        const region = hit?.region;
        if (region) {
          regionId = String(region.id || '');
          regionName = String(region.name || '');
          regionJournalUuid = String(region.journalUuid || '').trim();
        }
      }
    } catch (e) {
      // ignore
    }

    // ===== Influence =====
    const im = sh?.influenceManager;
    let influenceEntries = [];
    let influenceWinner = null;
    let influenceThreshold = 0.3;

    try {
      if (im?.sampleInfluenceAtPoint) {
        const sample = im.sampleInfluenceAtPoint(px, py) || {};
        influenceEntries = Array.isArray(sample.entries) ? sample.entries : [];
        influenceWinner = sample.winner || null;
        influenceThreshold = Number.isFinite(Number(sample.threshold)) ? Number(sample.threshold) : 0.3;
      }
    } catch (e) {
      // ignore
    }

    const influenceCount = influenceEntries.length;
    const influenceWinnerSide = String(influenceWinner?.side || '').trim();
    const influenceWinnerStrengthRaw = Number(influenceWinner?.strength);
    const influenceWinnerStrength = Number.isFinite(influenceWinnerStrengthRaw) ? influenceWinnerStrengthRaw : 0;

    const influenceWinnerClamped = Math.min(Math.max(0, influenceWinnerStrength), 1);
    const hasWinner = !!(influenceWinnerSide && influenceWinnerClamped >= influenceThreshold);

    let influenceName = '';
    let influenceSideUuid = '';

    if (hasWinner) {
      influenceSideUuid = influenceWinnerSide;
    } else {
      influenceSideUuid = '';
    }

    // Resolve doc names (async)
    const biomeJournalUuidNorm = this._normalizeUuid(biomeJournalUuid);
    const regionJournalUuidNorm = this._normalizeUuid(regionJournalUuid);
    const influenceSideUuidNorm = this._normalizeUuid(influenceSideUuid);

    const biomeJournalNameP = biomeJournalUuidNorm ? this._resolveDocNameSafe(biomeJournalUuidNorm) : Promise.resolve('');
    const regionJournalNameP = regionJournalUuidNorm ? this._resolveDocNameSafe(regionJournalUuidNorm) : Promise.resolve('');
    const influenceWinnerNameP = influenceSideUuidNorm ? this._resolveDocNameSafe(influenceSideUuidNorm) : Promise.resolve('');

    const influenceTooltipP = (async () => {
      if (!influenceCount) return '';

      const pairs = influenceEntries
        .map((e) => ({
          side: String(e?.side || '').trim(),
          strength: Number(e?.strength) || 0,
        }))
        .filter((e) => e.side && e.strength > 0);

      if (!pairs.length) return '';

      // Resolve names in parallel
      const names = await Promise.all(pairs.map((p) => this._resolveDocNameSafe(p.side)));

      const lines = [];
      for (let i = 0; i < pairs.length; i++) {
        const name = names[i] || pairs[i].side;
        const v = pairs[i].strength;
        lines.push(`${name}: ${v.toFixed(2)}`);
      }
      return lines.join('\n');
    })();

    const [biomeJournalName, regionJournalName, influenceWinnerName, influenceTooltip] = await Promise.all([
      biomeJournalNameP,
      regionJournalNameP,
      influenceWinnerNameP,
      influenceTooltipP,
    ]);

    // stale async guard
    if (seq !== this._inspectSyncSeq) return;

    // Determine influence display text by rules
    if (hasWinner) {
      influenceName = influenceWinnerName || influenceSideUuidNorm;
    } else if (influenceCount >= 2) {
      influenceName = _t('SPACEHOLDER.GlobalMap.Common.Unknown');
    } else {
      // 0 influences OR 1 weak influence
      influenceName = '';
    }

    // Save state
    this._inspectedBiomeId = (biomeId === null || biomeId === undefined) ? null : Number(biomeId);
    this._inspectedBiomeName = String(biomeName || _t('SPACEHOLDER.GlobalMap.Common.Unknown'));
    this._inspectedBiomeJournalUuid = biomeJournalUuidNorm;
    this._inspectedBiomeJournalName = String(biomeJournalName || biomeJournalUuidNorm || '');

    this._inspectedRegionId = regionId;
    this._inspectedRegionName = String(regionName || '');
    this._inspectedRegionJournalUuid = regionJournalUuidNorm;
    this._inspectedRegionJournalName = String(regionJournalName || regionJournalUuidNorm || '');

    this._inspectedInfluenceSideUuid = influenceSideUuidNorm;
    this._inspectedInfluenceName = influenceName;
    this._inspectedInfluenceJournalName = String(influenceWinnerName || influenceSideUuidNorm || '');
    this._inspectedInfluenceTooltip = String(influenceTooltip || '');

    // Apply to DOM
    this._syncInspectorUi();

    // Refit after content changes
    const root = this.element;
    if (root) this._fitAll(root);
  }

  async _onClick(event) {
    const btn = event.target?.closest?.('button[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;

    // ===== Timeline =====
    if (action === 'open-timeline') {
      event.preventDefault();
      if (!this._canShowTimelineButton()) return;

      try {
        game?.spaceholder?.openTimelineApp?.();
      } catch (e) {
        console.error('SpaceHolder | Global map edge UI: failed to open timeline', e);
        ui.notifications?.error?.(_t('SPACEHOLDER.GlobalMap.Errors.OpenTimelineFailed'));
      }
      return;
    }

    // ===== Inspector (bottom panel) =====
    if (action === 'toggle-inspector-updates') {
      event.preventDefault();
      this.inspectorUpdatesEnabled = !this.inspectorUpdatesEnabled;
      this._syncInspectorUpdatesUi();
      return;
    }

    if (action === 'open-inspect-biome-journal') {
      event.preventDefault();
      await this._openJournalUuid(this._inspectedBiomeJournalUuid);
      return;
    }

    if (action === 'clear-inspect-biome-journal') {
      event.preventDefault();
      await this._setInspectedBiomeJournalUuid('');
      return;
    }

    if (action === 'apply-inspect-biome-journal') {
      event.preventDefault();
      const root = this.element;
      const input = root?.querySelector?.('input[data-field="inspectBiomeJournalUuid"]');
      const raw = String(input?.value || '').trim();
      await this._setInspectedBiomeJournalUuid(raw);
      return;
    }

    if (action === 'open-inspect-region-journal') {
      event.preventDefault();
      await this._openJournalUuid(this._inspectedRegionJournalUuid);
      return;
    }

    if (action === 'clear-inspect-region-journal') {
      event.preventDefault();
      await this._setInspectedRegionJournalUuid('');
      return;
    }

    if (action === 'apply-inspect-region-journal') {
      event.preventDefault();
      const root = this.element;
      const input = root?.querySelector?.('input[data-field="inspectRegionJournalUuid"]');
      const raw = String(input?.value || '').trim();
      await this._setInspectedRegionJournalUuid(raw);
      return;
    }

    if (action === 'open-inspect-influence-journal') {
      event.preventDefault();
      await this._openFactionLinkByUuid(this._inspectedInfluenceSideUuid);
      return;
    }

    // ===== Existing controls =====
    if (action === 'load-map') {
      event.preventDefault();
      await this._loadMapFromFile();
      return;
    }

    if (action === 'open-token-link') {
      event.preventDefault();
      await this._openJournalUuid(this._selectedLinkUuid);
      return;
    }

    if (action === 'open-token-faction') {
      event.preventDefault();
      await this._openFactionLinkByUuid(this._selectedFactionUuid);
      return;
    }

    if (action === 'open-biome-editor') {
      event.preventDefault();
      if (!this._requireGM('SPACEHOLDER.GlobalMap.Permissions.Actions.OpenBiomeEditor')) return;

      try {
        const sh = game?.spaceholder;
        const biomeResolver = sh?.globalMapProcessing?.biomeResolver || sh?.globalMapRenderer?.biomeResolver;
        const app = new GlobalMapBiomeEditorApp({ biomeResolver });
        app.render(true);
      } catch (e) {
        console.error('SpaceHolder | Global map edge UI: failed to open biome editor', e);
        ui.notifications?.error?.(_t('SPACEHOLDER.GlobalMap.Errors.OpenBiomeEditorFailed'));
      }
      return;
    }

    if (action === 'import-map') {
      event.preventDefault();
      if (!this._requireGM('SPACEHOLDER.GlobalMap.Permissions.Actions.ImportMap')) return;

      const sh = game?.spaceholder;
      const processing = sh?.globalMapProcessing;
      const renderer = sh?.globalMapRenderer;
      if (!processing || !renderer) return;

      // Ensure biome overrides are loaded.
      try {
        await processing?.biomeResolver?.reloadConfigWithWorldOverrides?.();
      } catch (e) {
        // ignore
      }
      try {
        await renderer?.biomeResolver?.reloadConfigWithWorldOverrides?.();
      } catch (e) {
        // ignore
      }

      await showGlobalMapImportDialog(processing, renderer);
      return;
    }

    if (action === 'save-map') {
      event.preventDefault();
      if (!this._requireGM('SPACEHOLDER.GlobalMap.Permissions.Actions.SaveMap')) return;

      const sh = game?.spaceholder;
      const processing = sh?.globalMapProcessing;
      const renderer = sh?.globalMapRenderer;
      const tools = sh?.globalMapTools;
      const scene = canvas?.scene;

      if (!scene || !processing || !renderer) return;

      if (!renderer?.currentGrid) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.NoMapToSave'));
        return;
      }

      // Ensure vector overlays are loaded/normalized before saving.
      try {
        if (renderer.vectorRiversData === null || renderer.vectorRiversData === undefined) {
          await renderer.loadVectorRiversFromScene?.(scene);
        }
      } catch (e) {
        // ignore
      }
      try {
        if (renderer.vectorRegionsData === null || renderer.vectorRegionsData === undefined) {
          await renderer.loadVectorRegionsFromScene?.(scene);
        }
      } catch (e) {
        // ignore
      }

      const errors = [];

      // Save grid (biomes/heights)
      const okGrid = await processing?.saveGridToFile?.(scene);
      if (!okGrid) errors.push(_t('SPACEHOLDER.GlobalMap.Save.Parts.Map'));

      // Save vector rivers/regions (stored in scene flags)
      const saveFlagSafe = async (key, value) => {
        if (!scene?.setFlag) return false;
        if (!value || typeof value !== 'object') return false;
        try {
          await scene.setFlag(MODULE_NS, key, value);
          return true;
        } catch (e) {
          console.error(`SpaceHolder | Global map edge UI: failed to save ${key}`, e);
          return false;
        }
      };

      const okRivers = await saveFlagSafe('globalMapRivers', renderer.vectorRiversData);
      const okRegions = await saveFlagSafe('globalMapRegions', renderer.vectorRegionsData);

      if (!okRivers) errors.push(_t('SPACEHOLDER.GlobalMap.Save.Parts.Rivers'));
      if (!okRegions) errors.push(_t('SPACEHOLDER.GlobalMap.Save.Parts.Regions'));

      // Keep tools UI indicators in sync (if open)
      try {
        if (tools) {
          if (okRivers) tools.vectorRiversDirty = false;
          if (okRegions) tools.vectorRegionsDirty = false;
          tools._refreshRiversUI?.();
          tools._refreshRegionsUI?.();
        }
      } catch (e) {
        // ignore
      }

      if (errors.length) {
        ui.notifications?.error?.(_f('SPACEHOLDER.GlobalMap.Errors.FailedToSave', { what: errors.join(', ') }));
      }

      return;
    }

    if (action === 'bake-map-background') {
      event.preventDefault();
      if (!this._requireGM('SPACEHOLDER.GlobalMap.Permissions.Actions.BakeBackground')) return;

      try {
        const sh = game?.spaceholder;
        const renderer = sh?.globalMapRenderer;
        const scene = canvas?.scene;
        if (!renderer || !scene) return;
        await bakeGlobalMapToSceneBackground(renderer, scene);
      } catch (e) {
        console.error('SpaceHolder | Global map edge UI: bake failed', e);
      }
      return;
    }

    if (action === 'create-test-grid') {
      event.preventDefault();
      if (!this._requireGM('SPACEHOLDER.GlobalMap.Permissions.Actions.CreateTestGrid')) return;

      const sh = game?.spaceholder;
      const processing = sh?.globalMapProcessing;
      const renderer = sh?.globalMapRenderer;
      if (!processing || !renderer) return;

      // Ensure biome overrides are loaded.
      try {
        await processing?.biomeResolver?.reloadConfigWithWorldOverrides?.();
      } catch (e) {
        // ignore
      }
      try {
        await renderer?.biomeResolver?.reloadConfigWithWorldOverrides?.();
      } catch (e) {
        // ignore
      }

      try {
        const result = processing.createBiomeTestGrid(canvas.scene);
        await renderer.render(result.gridData, result.metadata);
        ui.notifications?.info?.(_t('SPACEHOLDER.GlobalMap.Notifications.TestGridCreated'));
      } catch (e) {
        console.error('SpaceHolder | Global map edge UI: create-test-grid failed', e);
        ui.notifications?.error?.(_t('SPACEHOLDER.GlobalMap.Errors.CreateTestGridFailed'));
      }
      return;
    }

    if (action === 'edit-map') {
      event.preventDefault();
      if (!this._requireGM('SPACEHOLDER.GlobalMap.Permissions.Actions.EditMap')) return;

      const sh = game?.spaceholder;
      const renderer = sh?.globalMapRenderer;
      const tools = sh?.globalMapTools;

      if (!renderer?.currentGrid) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Warnings.ImportMapFirst'));
        return;
      }

      if (!tools) return;

      try {
        if (tools.isActive) {
          await tools.deactivate();
        } else {
          tools.activate();
        }
      } catch (e) {
        console.error('SpaceHolder | Global map edge UI: edit-map failed', e);
      }

      // По умолчанию кнопки disabled в шаблоне; дополнительно синхронизируем, если вдруг история уже есть
      this._syncUndoRedoButtons();

      return;
    }

    if (action === 'global-map-undo') {
      event.preventDefault();
      const tools = game?.spaceholder?.globalMapTools;
      tools?.undo?.();
      this._syncUndoRedoButtons();
      return;
    }

    if (action === 'global-map-redo') {
      event.preventDefault();
      const tools = game?.spaceholder?.globalMapTools;
      tools?.redo?.();
      this._syncUndoRedoButtons();
      return;
    }

    if (action === 'clear-map') {
      event.preventDefault();
      if (!this._requireGM('SPACEHOLDER.GlobalMap.Permissions.Actions.ClearMap')) return;

      const sh = game?.spaceholder;
      const processing = sh?.globalMapProcessing;
      const renderer = sh?.globalMapRenderer;

      if (!renderer?.currentGrid) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Errors.NoLoadedMap'));
        return;
      }

      const confirmed = await Dialog.confirm({
        title: _t('SPACEHOLDER.GlobalMap.Confirm.ClearMap.Title'),
        content: `<p>${_t('SPACEHOLDER.GlobalMap.Confirm.ClearMap.Content')}</p>`,
        yes: () => true,
        no: () => false,
      });

      if (!confirmed) return;

      try {
        processing?.clear?.();
        renderer?.clear?.();
        ui.notifications?.info?.(_t('SPACEHOLDER.GlobalMap.Notifications.MapCleared'));
      } catch (e) {
        console.error('SpaceHolder | Global map edge UI: clear-map failed', e);
      }

      return;
    }

    if (action === 'toggle-flyout') {
      event.preventDefault();

      const side = String(btn.dataset.side || '').trim();
      if (side === 'left') {
        this.flyoutLeftOpen = !this.flyoutLeftOpen;
      } else if (side === 'right') {
        this.flyoutRightOpen = !this.flyoutRightOpen;
      }

      const root = this.element;
      if (root) {
        this._syncUiState(root);
        this._syncRenderModeSelectors(root);
      }
      return;
    }

    if (action === 'toggle-inspector') {
      event.preventDefault();
      this.inspectorOpen = !this.inspectorOpen;
      const root = this.element;
      if (root) this._syncUiState(root);
      return;
    }

    if (action === 'toggle') {
      event.preventDefault();
      this._togglePressed(btn);
      return;
    }

    if (action === 'select') {
      event.preventDefault();
      this._selectOption(btn);

      const groupId = String(btn.dataset.select || '').trim();
      const value = String(btn.dataset.value || '').trim();

      const renderer = game?.spaceholder?.globalMapRenderer;
      if (renderer) {
        // Map render modes
        if (groupId === 'biomes' && typeof renderer.setBiomesMode === 'function') {
          renderer.setBiomesMode(value);
        }
        if (groupId === 'heights' && typeof renderer.setHeightsMode === 'function') {
          renderer.setHeightsMode(value);
        }

        // Rivers / Regions settings (global for this client)
        if (groupId === 'riverLabels') {
          await this._setRiversLabelMode(value);
        }
        if (groupId === 'regions') {
          await this._setRegionsRenderMode(value);
        }
        if (groupId === 'regionsWhen') {
          await this._setRegionsWhenMode(value);
        }
        if (groupId === 'smooth') {
          await this._setRegionsSmoothIterations(value);
        }

        // Client-only visual toggles
        if (groupId === 'riverLabelRotate') {
          await this._setClientSettingOnOff(CLIENT_SETTING_RIVER_LABEL_ROTATE, value);
        }
        if (groupId === 'appearAnim') {
          await this._setClientSettingOnOff(CLIENT_SETTING_APPEAR_ANIM, value);
        }

        // Keep UI in sync with normalized values
        const root = this.element;
        if (root) this._syncRenderModeSelectors(root);
      }

      return;
    }

    // placeholder: no-op
    event.preventDefault();
  }

  async _loadMapFromFile() {
    const scene = canvas?.scene;
    const sh = game?.spaceholder;
    const processing = sh?.globalMapProcessing;
    const renderer = sh?.globalMapRenderer;

    if (!scene || !processing || !renderer) return;

    // Ensure biome overrides are loaded before we normalize/render biomes.
    try {
      await processing?.biomeResolver?.reloadConfigWithWorldOverrides?.();
    } catch (e) {
      // ignore
    }
    try {
      await renderer?.biomeResolver?.reloadConfigWithWorldOverrides?.();
    } catch (e) {
      // ignore
    }

    try {
      // Rivers + Regions are stored separately in scene flags; reload them as part of refresh.
      try {
        await renderer.loadVectorRegionsFromScene?.(scene);
      } catch (e) {
        // ignore
      }
      try {
        await renderer.loadVectorRiversFromScene?.(scene);
      } catch (e) {
        // ignore
      }

      const loaded = await processing.loadGridFromFile(scene);
      if (loaded && loaded.gridData) {
        await renderer.render(loaded.gridData, loaded.metadata, { mode: 'heights' });
        ui.notifications?.info?.(_t('SPACEHOLDER.GlobalMap.Notifications.MapRefreshed'));
      } else {
        // Grid file missing; still try to re-render reloaded vector overlays on top of current map.
        try {
          if (renderer?.currentMetadata) {
            if (renderer.vectorRegionsData) renderer.renderVectorRegions?.(renderer.vectorRegionsData, renderer.currentMetadata);
            if (renderer.vectorRiversData) renderer.renderVectorRivers?.(renderer.vectorRiversData, renderer.currentMetadata);
          }
        } catch (e) {
          // ignore
        }

        ui.notifications?.warn?.(_t('SPACEHOLDER.GlobalMap.Warnings.MapFileNotFound'));
      }
    } catch (e) {
      console.error('SpaceHolder | Global map edge UI: load-map failed', e);
      ui.notifications?.error?.(_t('SPACEHOLDER.GlobalMap.Errors.RefreshMapFailed'));
    }
  }
}

async function _syncForScene(scene) {
  if (!_uiInstance) _uiInstance = new GlobalMapEdgeUI();

  if (_isGlobalMapScene(scene)) {
    await _uiInstance.render({ scene });
  } else {
    _uiInstance.destroy();
  }
}

export function installGlobalMapEdgeUiHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  _registerGlobalMapClientSettings();

  Hooks.on('canvasReady', async () => {
    try {
      await _syncForScene(canvas?.scene);
      await _uiInstance?._syncSelectedTokenInfo?.();
    } catch (e) {
      console.error('SpaceHolder | Global map edge UI: failed to sync on canvasReady', e);
    }
  });

  // Some UI/settings changes can trigger partial UI/canvas refreshes.
  // Re-bind inspector stage handler when scene controls re-render.
  Hooks.on('renderSceneControls', () => {
    try {
      if (!_uiInstance?.element) return;
      _uiInstance._installInspectorStageHandler();
    } catch (e) {
      // ignore
    }
  });

  Hooks.on('updateScene', async (scene, changes, _options, _userId) => {
    try {
      if (!_isGlobalMapFlagChanged(changes)) return;

      const activeScene = canvas?.scene;
      if (!activeScene || scene?.id !== activeScene.id) return;

      await _syncForScene(scene);
    } catch (e) {
      console.error('SpaceHolder | Global map edge UI: failed to sync on updateScene', e);
    }
  });

  // Selected token info
  Hooks.on('controlToken', async () => {
    try {
      if (!_uiInstance?.element) return;
      await _uiInstance._syncSelectedTokenInfo();
    } catch (e) {
      // ignore
    }
  });

  Hooks.on('updateToken', async (tokenDoc, _changes, _options, _userId) => {
    try {
      if (!_uiInstance?.element) return;
      if (!_uiInstance._selectedTokenDocIds?.size) return;
      if (!tokenDoc?.id || !_uiInstance._selectedTokenDocIds.has(tokenDoc.id)) return;
      await _uiInstance._syncSelectedTokenInfo();
    } catch (e) {
      // ignore
    }
  });

  Hooks.on('deleteToken', async (tokenDoc, _options, _userId) => {
    try {
      if (!_uiInstance?.element) return;
      if (!_uiInstance._selectedTokenDocIds?.size) return;
      if (!tokenDoc?.id || !_uiInstance._selectedTokenDocIds.has(tokenDoc.id)) return;
      await _uiInstance._syncSelectedTokenInfo();
    } catch (e) {
      // ignore
    }
  });

  Hooks.on('updateActor', async (actor, _changes, _options, _userId) => {
    try {
      if (!_uiInstance?.element) return;
      if (!_uiInstance._selectedActorIds?.size) return;
      if (!actor?.id || !_uiInstance._selectedActorIds.has(actor.id)) return;
      await _uiInstance._syncSelectedTokenInfo();
    } catch (e) {
      // ignore
    }
  });
}

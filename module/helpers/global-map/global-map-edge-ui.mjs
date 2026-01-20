import { GlobalMapBiomeEditorApp } from './global-map-biome-editor-app.mjs';
import { bakeGlobalMapToSceneBackground, showGlobalMapImportDialog } from './global-map-ui.mjs';

const MODULE_NS = 'spaceholder';
const UI_ID = 'spaceholder-globalmap-edge-ui';
const TEMPLATE_PATH = 'systems/spaceholder/templates/global-map/edge-panel.hbs';

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
      await this._syncSelectedTokenInfo(existing);
      this._fitAll(existing);
      return;
    }

    const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, {
      sceneName: scene?.name ?? '',
      isGM: !!game?.user?.isGM,
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
    await this._syncSelectedTokenInfo(el);
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

    const biomesMode = String(renderer.biomesMode || 'fancy');
    const heightsMode = String(renderer.heightsMode || 'contours-bw');

    const biomesBtn = root.querySelector(`button[data-action="select"][data-select="biomes"][data-value="${biomesMode}"]`);
    if (biomesBtn) this._selectOption(biomesBtn);

    const heightsBtn = root.querySelector(`button[data-action="select"][data-select="heights"][data-value="${heightsMode}"]`);
    if (heightsBtn) this._selectOption(heightsBtn);
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

  _normalizeVisibilityMode(raw) {
    const mode = String(raw ?? '').trim();
    if (!mode) return 'public';
    if (mode === 'hidden') return 'halfHidden'; // legacy fallback
    if (mode === 'public' || mode === 'halfHidden' || mode === 'fullHidden' || mode === 'secret') return mode;
    return 'public';
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

  _requireGM(action = 'выполнить это действие') {
    if (game?.user?.isGM) return true;
    ui.notifications?.warn?.(`Только ГМ может ${action}`);
    return false;
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

    // Visibility icon state (single token only)
    let visibilityMode = null;

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

      // Visibility icon (globalobject only)
      if (isGlobalObject) {
        const rawMode = actor?.getFlag?.(MODULE_NS, 'tokenVisibility') ?? actor?.flags?.[MODULE_NS]?.tokenVisibility;
        visibilityMode = this._normalizeVisibilityMode(rawMode);
      }
    } else if (tokens.length > 1) {
      tokenName = 'Несколько токенов';

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
        tokenFactionText = 'Несколько фракций';
      }

      // For multiple selection we do not expose per-token link/visibility.
      selectedLinkUuid = '';
      visibilityMode = null;
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

    // Visibility icon (only when exactly one token selected and it is a globalobject)
    const visWrap = el.querySelector('.sh-gm-edge__visIcon');
    if (visWrap) {
      if (!visibilityMode) {
        visWrap.hidden = true;
      } else {
        const icon = visWrap.querySelector('i');
        const tooltipMap = {
          public: 'Публичный',
          halfHidden: 'HalfHidden',
          fullHidden: 'FullHidden',
          secret: 'Секретный',
        };
        const iconMap = {
          public: 'fa-user',
          halfHidden: 'fa-user-magnifying-glass',
          fullHidden: 'fa-user-lock',
          secret: 'fa-user-secret',
        };

        if (icon) {
          icon.classList.remove('fa-user', 'fa-user-magnifying-glass', 'fa-user-lock', 'fa-user-secret');
          icon.classList.add(iconMap[visibilityMode] || 'fa-user');
        }

        const tip = tooltipMap[visibilityMode] || 'Видимость';
        visWrap.setAttribute('data-tooltip', tip);
        visWrap.setAttribute('aria-label', tip);
        visWrap.hidden = false;
      }
    }

    // Refit after content changes
    this._fitAll(el);
  }

  async _onClick(event) {
    const btn = event.target?.closest?.('button[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;

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
      await this._openJournalUuid(this._selectedFactionUuid);
      return;
    }

    if (action === 'open-biome-editor') {
      event.preventDefault();
      if (!this._requireGM('открывать список биомов')) return;

      try {
        const sh = game?.spaceholder;
        const biomeResolver = sh?.globalMapProcessing?.biomeResolver || sh?.globalMapRenderer?.biomeResolver;
        const app = new GlobalMapBiomeEditorApp({ biomeResolver });
        app.render(true);
      } catch (e) {
        console.error('SpaceHolder | Global map edge UI: failed to open biome editor', e);
        ui.notifications?.error?.('Не удалось открыть список биомов');
      }
      return;
    }

    if (action === 'import-map') {
      event.preventDefault();
      if (!this._requireGM('импортировать карту')) return;

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
      if (!this._requireGM('сохранять карту')) return;

      const sh = game?.spaceholder;
      const processing = sh?.globalMapProcessing;
      const renderer = sh?.globalMapRenderer;

      if (!renderer?.currentGrid) {
        ui.notifications?.warn?.('Нет карты для сохранения');
        return;
      }

      const ok = await processing?.saveGridToFile?.(canvas?.scene);
      if (!ok) {
        ui.notifications?.error?.('Не удалось сохранить карту');
      }
      return;
    }

    if (action === 'bake-map-background') {
      event.preventDefault();
      if (!this._requireGM('запекать фон сцены')) return;

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
      if (!this._requireGM('создавать тестовую сетку')) return;

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
        ui.notifications?.info?.('Тестовая карта создана (биомы из реестра)');
      } catch (e) {
        console.error('SpaceHolder | Global map edge UI: create-test-grid failed', e);
        ui.notifications?.error?.('Не удалось создать тестовую сетку');
      }
      return;
    }

    if (action === 'edit-map') {
      event.preventDefault();
      if (!this._requireGM('редактировать карту')) return;

      const sh = game?.spaceholder;
      const renderer = sh?.globalMapRenderer;
      const tools = sh?.globalMapTools;

      if (!renderer?.currentGrid) {
        ui.notifications?.warn?.('Сначала импортируйте карту');
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

      return;
    }

    if (action === 'clear-map') {
      event.preventDefault();
      if (!this._requireGM('очищать карту')) return;

      const sh = game?.spaceholder;
      const processing = sh?.globalMapProcessing;
      const renderer = sh?.globalMapRenderer;

      if (!renderer?.currentGrid) {
        ui.notifications?.warn?.('Нет загруженной карты');
        return;
      }

      const confirmed = await Dialog.confirm({
        title: 'Очистить карту?',
        content: '<p>Это удалит загруженную карту. Продолжить?</p>',
        yes: () => true,
        no: () => false,
      });

      if (!confirmed) return;

      try {
        processing?.clear?.();
        renderer?.clear?.();
        ui.notifications?.info?.('Карта очищена');
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

      // Only wire render modes for now.
      const renderer = game?.spaceholder?.globalMapRenderer;
      if (renderer) {
        if (groupId === 'biomes' && typeof renderer.setBiomesMode === 'function') {
          renderer.setBiomesMode(value);
        }
        if (groupId === 'heights' && typeof renderer.setHeightsMode === 'function') {
          renderer.setHeightsMode(value);
        }
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
      const loaded = await processing.loadGridFromFile(scene);
      if (loaded && loaded.gridData) {
        await renderer.render(loaded.gridData, loaded.metadata, { mode: 'heights' });
        ui.notifications?.info?.('Карта обновлена');
      } else {
        ui.notifications?.warn?.('Файл карты не найден');
      }
    } catch (e) {
      console.error('SpaceHolder | Global map edge UI: load-map failed', e);
      ui.notifications?.error?.('Не удалось обновить карту');
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

  Hooks.on('canvasReady', async () => {
    try {
      await _syncForScene(canvas?.scene);
      await _uiInstance?._syncSelectedTokenInfo?.();
    } catch (e) {
      console.error('SpaceHolder | Global map edge UI: failed to sync on canvasReady', e);
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

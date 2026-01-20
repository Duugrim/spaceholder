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

    this._onClick = this._onClick.bind(this);
  }

  get element() {
    return document.getElementById(UI_ID);
  }

  async render({ scene } = {}) {
    const existing = this.element;
    if (existing) {
      this._syncUiState(existing);
      return;
    }

    const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE_PATH, {
      sceneName: scene?.name ?? '',
    });

    const wrap = document.createElement('div');
    wrap.innerHTML = String(html || '').trim();
    const el = wrap.firstElementChild;
    if (!el) return;

    document.body.appendChild(el);
    el.addEventListener('click', this._onClick);
    this._syncUiState(el);
  }

  destroy() {
    const el = this.element;
    if (!el) return;

    try {
      el.removeEventListener('click', this._onClick);
    } catch (e) {
      // ignore
    }

    el.remove();
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

  _onClick(event) {
    const btn = event.target?.closest?.('button[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;

    if (action === 'toggle-flyout') {
      event.preventDefault();

      const side = String(btn.dataset.side || '').trim();
      if (side === 'left') {
        this.flyoutLeftOpen = !this.flyoutLeftOpen;
      } else if (side === 'right') {
        this.flyoutRightOpen = !this.flyoutRightOpen;
      }

      const root = this.element;
      if (root) this._syncUiState(root);
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
      return;
    }

    // placeholder: no-op
    event.preventDefault();
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
}

const MODULE_NS = 'spaceholder';
let _hooksInstalled = false;
let _autoloadInProgress = false;

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

function _isGlobalMapScene(scene) {
  return !!(
    scene?.getFlag?.(MODULE_NS, 'isGlobalMap')
    ?? scene?.flags?.[MODULE_NS]?.isGlobalMap
  );
}

async function _tryAutoloadGlobalMap(scene, { force = false } = {}) {
  if (!scene || !_isGlobalMapScene(scene)) return false;

  const processing = game.spaceholder?.globalMapProcessing;
  const renderer = game.spaceholder?.globalMapRenderer;
  if (!processing || !renderer) return false;

  if (!force && renderer.currentSceneId === scene.id && renderer.currentGrid && renderer.currentMetadata) {
    return true;
  }

  if (_autoloadInProgress) return false;
  _autoloadInProgress = true;

  try {
    // Ensure biome overrides are loaded before we normalize/render biomes.
    try {
      await processing.biomeResolver?.reloadConfigWithWorldOverrides?.();
    } catch (e) {
      // ignore
    }
    try {
      await renderer.biomeResolver?.reloadConfigWithWorldOverrides?.();
    } catch (e) {
      // ignore
    }

    const loaded = await processing.loadGridFromFile(scene);
    if (loaded?.gridData) {
      await renderer.render(loaded.gridData, loaded.metadata);
      console.log(`SpaceHolder | Global map autoloaded for scene: ${scene?.name ?? scene?.id ?? 'unknown'}`);
      return true;
    }

    console.info(`SpaceHolder | Global map autoload: file not found for scene: ${scene?.name ?? scene?.id ?? 'unknown'}`);
  } catch (e) {
    console.error('SpaceHolder | Failed to autoload global map', e);
  } finally {
    _autoloadInProgress = false;
  }

  return false;
}

export function installGlobalMapSceneConfigHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  const renderHandler = async (app, formEl, data) => {
    try {
      const root = formEl instanceof HTMLElement ? formEl : (formEl?.[0] ?? formEl);
      if (!root) return;

      const scene = data?.document ?? data?.scene ?? data?.object ?? app?.document ?? app?.object ?? null;
      const isGlobalMap = !!(
        scene?.getFlag?.(MODULE_NS, 'isGlobalMap')
        ?? scene?.flags?.[MODULE_NS]?.isGlobalMap
      );

      const tpl = await foundry.applications.handlebars.renderTemplate(
        'systems/spaceholder/templates/scene-global-map-config.hbs',
        { isGlobalMap }
      );

      const wrap = document.createElement('div');
      wrap.innerHTML = tpl;
      const newPanel = wrap.firstElementChild;
      if (!newPanel) return;

      const existing = root.querySelector('.spaceholder-scene-global-map');
      if (existing) {
        existing.replaceWith(newPanel);
        return;
      }

      const nameInput = root.querySelector('input[name="name"]');
      const anchor = nameInput?.closest?.('.form-group') ?? nameInput?.parentElement ?? null;

      if (anchor && anchor.parentElement) {
        anchor.insertAdjacentElement('afterend', newPanel);
      } else {
        const footer = root.querySelector('footer') || root.querySelector('.sheet-footer');
        if (footer) footer.insertAdjacentElement('beforebegin', newPanel);
        else root.appendChild(newPanel);
      }
    } catch (e) {
      console.error('SpaceHolder | SceneConfig injection failed', e);
    }
  };

  Hooks.on('renderSceneConfig', renderHandler);
  Hooks.on('canvasReady', async () => {
    try {
      await _tryAutoloadGlobalMap(canvas?.scene);
    } catch (e) {
      // ignore
    }
  });

  Hooks.on('updateScene', async (scene, changes, _options, _userId) => {
    try {
      if (!_isGlobalMapFlagChanged(changes)) return;

      const activeScene = canvas?.scene;
      if (!activeScene || scene?.id !== activeScene.id) return;

      const isGlobalMapNow = _isGlobalMapScene(scene);

      if (!isGlobalMapNow) {
        try {
          const tools = game.spaceholder?.globalMapTools;
          if (tools?.isActive) await tools.deactivate();
        } catch (e) {
          // ignore
        }

        try {
          game.spaceholder?.globalMapRenderer?.hide?.();
        } catch (e) {
          // ignore
        }
      } else {
        await _tryAutoloadGlobalMap(scene, { force: true });
      }

      try {
        ui.controls?.initialize?.();
      } catch (e) {
        // ignore
      }
    } catch (e) {
      console.error('SpaceHolder | Failed to handle global map scene flag update', e);
    }
  });
}

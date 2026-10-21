/**
 * Wall config UI + settings for shot penetration.
 *
 * Injects a "Shot penetration" fieldset into the core Wall Config sheet (material, kind, thickness).
 * The inputs are named `flags.spaceholder.wall.*`, so the core form saves them — no custom save code.
 * Pattern: `global-map/global-map-scene-config.mjs` (render hook + template + insert).
 */

import { materialsManager } from '../damage/materials-manager.mjs';
import { WALL_FLAG_KEY, WALL_FLAG_SCOPE } from './wall-data.mjs';
import { WALL_KIND, WALL_SIDE } from './wall-spans.mjs';

const TEMPLATE = 'systems/spaceholder/templates/wall-shot-config.hbs';
const PANEL_CLASS = 'spaceholder-wall-shot-config';

let _installed = false;

/** Hook the Wall Config sheet (call from `init`). */
export function installWallConfigHooks() {
  if (_installed) return;
  _installed = true;
  Hooks.on('renderWallConfig', _onRenderWallConfig);
}

async function _onRenderWallConfig(app, formEl) {
  try {
    const root = formEl instanceof HTMLElement ? formEl : (formEl?.[0] ?? formEl);
    if (!root?.querySelector) return;

    const raw = app?.document?.flags?.[WALL_FLAG_SCOPE]?.[WALL_FLAG_KEY] ?? {};
    const material = String(raw.material ?? '').trim();
    const ids = materialsManager.listMaterialIds();
    const materials = ids.map((id) => ({
      id,
      name: materialsManager.getMaterial(id)?.name || id,
      selected: id === material,
    }));
    if (material && !ids.includes(material)) {
      materials.push({
        id: material,
        name: game.i18n.format('SPACEHOLDER.Walls.Config.MaterialMissing', { id: material }),
        selected: true,
      });
    }

    const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
      material,
      materials,
      isSolid: raw.kind === WALL_KIND.SOLID,
      thickness: Number(raw.thickness) > 0 ? Number(raw.thickness) : 0,
    });
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const panel = wrap.firstElementChild;
    if (!panel) return;

    const existing = root.querySelector(`.${PANEL_CLASS}`);
    if (existing) {
      existing.replaceWith(panel);
    } else {
      const anchor = root.querySelector('fieldset');
      if (anchor) {
        anchor.insertAdjacentElement('afterend', panel);
      } else {
        const footer = root.querySelector('footer') || root.querySelector('.form-footer');
        if (footer) footer.insertAdjacentElement('beforebegin', panel);
        else root.appendChild(panel);
      }
    }

    // A solid wall needs a direction (the open side); otherwise it is treated as thin.
    const kindSelect = panel.querySelector('select[name="flags.spaceholder.wall.kind"]');
    const dirSelect = root.querySelector('select[name="dir"]');
    const warning = panel.querySelector('.spaceholder-wall-solid-warning');
    const updateWarning = () => {
      if (!warning) return;
      const solid = kindSelect?.value === WALL_KIND.SOLID;
      const hasDirection = Number(dirSelect?.value ?? app.document?.dir) !== WALL_SIDE.BOTH;
      warning.hidden = !(solid && !hasDirection);
    };
    kindSelect?.addEventListener('change', updateWarning);
    dirSelect?.addEventListener('change', updateWarning);
    updateWarning();
  } catch (e) {
    console.error('SpaceHolder | WallConfig injection failed', e);
  }
}

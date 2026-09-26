/**
 * Lightweight context menu (single instance) styled like the item interact
 * menu (`spaceholder-weapon-interact-menu`). Rows run plain callbacks — no
 * action pipeline, AP or combat logging.
 */

const MENU_ID = 'spaceholder-simple-context-menu';
const VIEWPORT_PAD_PX = 8;

let _cleanup = null;

/**
 * @typedef {object} SimpleContextMenuItem
 * @property {string} id
 * @property {string} label
 * @property {string} [icon] FontAwesome class
 * @property {() => (void|Promise<void>)} run
 */

/**
 * Close the open menu, if any.
 */
export function closeSimpleContextMenu() {
  const cleanup = _cleanup;
  _cleanup = null;
  try { cleanup?.(); } catch (_) { /* ignore */ }
}

/**
 * Open the menu at the pointer (or under `anchorElement` for keyboard events).
 * @param {MouseEvent|null} event
 * @param {{ title?: string, items: SimpleContextMenuItem[], anchorElement?: HTMLElement|null }} spec
 */
export function openSimpleContextMenu(event, spec) {
  closeSimpleContextMenu();
  const items = Array.isArray(spec?.items) ? spec.items.filter((it) => it?.id && it?.label) : [];
  if (!items.length || !document?.body) return;

  const escape = foundry.utils?.escapeHTML ?? ((s) => String(s ?? ''));
  const menu = document.createElement('nav');
  menu.id = MENU_ID;
  menu.className = 'spaceholder-weapon-interact-menu';
  menu.setAttribute('role', 'menu');
  const title = String(spec?.title ?? '').trim();
  menu.innerHTML = `
    ${title ? `<div class="spaceholder-weapon-interact-menu__title">${escape(title)}</div>` : ''}
    <section class="spaceholder-weapon-interact-menu__group">
      ${items.map((it) => `
        <button type="button" class="spaceholder-weapon-interact-menu__action" data-menu-id="${escape(it.id)}" role="menuitem">
          ${it.icon ? `<i class="${escape(it.icon)}" aria-hidden="true"></i>` : ''}
          <span class="spaceholder-weapon-interact-menu__label">${escape(it.label)}</span>
        </button>
      `).join('')}
    </section>
  `;
  document.body.appendChild(menu);

  const vw = window.innerWidth || 800;
  const vh = window.innerHeight || 600;
  let x = Number(event?.clientX) || 0;
  let y = Number(event?.clientY) || 0;
  const anchor = spec?.anchorElement;
  if (!x && !y && anchor instanceof HTMLElement) {
    const r = anchor.getBoundingClientRect();
    x = r.left;
    y = r.bottom;
  }
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(VIEWPORT_PAD_PX, Math.min(x, vw - rect.width - VIEWPORT_PAD_PX))}px`;
  menu.style.top = `${Math.max(VIEWPORT_PAD_PX, Math.min(y, vh - rect.height - VIEWPORT_PAD_PX))}px`;

  const finish = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    try { menu.remove(); } catch (_) { /* ignore */ }
    if (_cleanup === finish) _cleanup = null;
  };
  const onPointerDown = (ev) => {
    if (menu.contains(ev.target)) return;
    finish();
  };
  const onKeyDown = (ev) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    finish();
  };

  _cleanup = finish;
  menu.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  menu.addEventListener('click', async (ev) => {
    const btn = ev.target?.closest?.('[data-menu-id]');
    if (!btn || !menu.contains(btn)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const id = String(btn.dataset.menuId ?? '').trim();
    const item = items.find((it) => it.id === id);
    finish();
    try { await item?.run?.(); } catch (e) {
      console.error('SpaceHolder | context menu action failed', e);
    }
  });
  // Defer so the opening pointer event does not close the menu immediately.
  setTimeout(() => {
    if (_cleanup !== finish) return;
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
  }, 0);
  try { menu.querySelector('[data-menu-id]')?.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
}

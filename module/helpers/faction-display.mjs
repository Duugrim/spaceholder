// Faction display helpers
// Goal: render factions as [avatar][name] instead of [color][name]

/**
 * Normalize UUID-like strings (supports @UUID[...]).
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeUuid(raw) {
  const str = String(raw ?? '').trim();
  if (!str) return '';
  const match = str.match(/@UUID\[(.+?)\]/);
  return (match?.[1] ?? str).trim();
}

async function _resolveDocSafe(rawUuid) {
  const uuid = normalizeUuid(rawUuid);
  if (!uuid) return null;

  // Fast path for world actors
  try {
    const parts = uuid.split('.');
    if (parts[0] === 'Actor' && parts[1] && parts.length === 2) {
      return game?.actors?.get?.(parts[1]) ?? null;
    }
  } catch (_) {
    // ignore
  }

  try {
    return await fromUuid(uuid);
  } catch (_) {
    return null;
  }
}

/**
 * Resolve a faction actor by UUID.
 * @param {unknown} uuid
 * @returns {Promise<Actor|null>}
 */
export async function resolveFactionActor(uuid) {
  const doc = await _resolveDocSafe(uuid);
  if (!doc) return null;
  if (doc.documentName !== 'Actor') return null;
  if (doc.type !== 'faction') return null;
  return doc;
}

/**
 * Resolve data needed to display a faction.
 * @param {unknown} uuid
 * @returns {Promise<{uuid:string,name:string,img:string,color:string} | null>}
 */
export async function resolveFactionDisplay(uuid) {
  const actor = await resolveFactionActor(uuid);
  if (!actor) return null;

  return {
    uuid: String(actor.uuid ?? '').trim(),
    name: String(actor.name ?? '').trim() || String(actor.uuid ?? '').trim(),
    img: String(actor.img ?? '').trim(),
    color: String(actor.system?.fColor ?? '').trim(),
  };
}

/**
 * Replace the icon inside Foundry content-link for Actor(faction) with an <img> avatar.
 * Safe to run multiple times; uses data marker to prevent duplicates.
 *
 * @param {string} html
 * @param {{cache?: Map<string, {uuid:string,name:string,img:string,color:string} | null>}} [opts]
 * @returns {Promise<string>}
 */
export async function decorateFactionLinksInHtml(html, { cache } = {}) {
  const raw = String(html ?? '');
  if (!raw) return raw;

  // If we're not in a browser-ish environment, don't try to parse.
  if (typeof document === 'undefined') return raw;

  const tpl = document.createElement('template');
  tpl.innerHTML = raw;

  const links = Array.from(tpl.content.querySelectorAll('a.content-link[data-uuid]'));
  if (!links.length) return raw;

  const localCache = cache instanceof Map ? cache : new Map();

  for (const a of links) {
    if (!a) continue;
    if (a.dataset?.shFactionDecorated === 'true') continue;

    const uuid = normalizeUuid(a.dataset.uuid);
    if (!uuid) continue;

    let display = localCache.get(uuid);
    if (display === undefined) {
      display = await resolveFactionDisplay(uuid);
      localCache.set(uuid, display);
    }

    if (!display) continue;

    // Remove the default icon (usually a direct child <i>).
    try {
      const icon = a.querySelector(':scope > i');
      if (icon) icon.remove();
    } catch (_) {
      // ignore
    }

    // Avoid duplicating our own img.
    if (a.querySelector(':scope > img.sh-faction-link__img')) {
      a.dataset.shFactionDecorated = 'true';
      continue;
    }

    if (display.img) {
      const img = document.createElement('img');
      img.className = 'sh-faction-link__img';
      img.src = display.img;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      a.insertBefore(img, a.firstChild);
    } else {
      // Fallback: keep it icon-less but add a small placeholder marker.
      // (No color swatch, per requirement.)
      const span = document.createElement('span');
      span.className = 'sh-faction-link__placeholder';
      span.setAttribute('aria-hidden', 'true');
      span.innerHTML = '<i class="fa-solid fa-flag" aria-hidden="true"></i>';
      a.insertBefore(span, a.firstChild);
    }

    // Ensure label is present. Prefer existing text; otherwise inject name.
    const hasText = Array.from(a.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && String(n.textContent || '').trim());
    if (!hasText) {
      a.appendChild(document.createTextNode(` ${display.name}`));
    }

    a.dataset.shFactionDecorated = 'true';
  }

  return tpl.innerHTML;
}

function _getTextEditorImpl() {
  return foundry?.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
}

/**
 * enrichHTML + faction content-link decoration.
 *
 * @param {unknown} content
 * @param {object} opts
 * @returns {Promise<string>}
 */
export async function enrichHTMLWithFactionIcons(content, opts = {}) {
  const impl = _getTextEditorImpl();
  const raw = String(content ?? '');
  if (!impl?.enrichHTML) return raw;

  const enriched = await impl.enrichHTML(raw, {
    async: true,
    ...(opts && typeof opts === 'object' ? opts : {}),
  });

  return await decorateFactionLinksInHtml(String(enriched ?? ''), { cache: new Map() });
}

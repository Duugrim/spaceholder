// Progression Points (PP) helper for SpaceHolder (Foundry v13)
// - Points are stored per JournalEntryPage (flags)
// - Manual adjustments are stored per User (flags)
// - Computations are derived (no hard enforcement)

import { getStatus } from './journal-check.mjs';
import { normalizeUuid, getUsersForFaction } from './user-factions.mjs';

const MODULE_NS = 'spaceholder';
const FLAG_ROOT = 'progression';

const SETTING_ENABLED = 'progression.enabled';

let _hooksInstalled = false;

export function registerProgressionPointsSettings() {
  game.settings.register(MODULE_NS, SETTING_ENABLED, {
    name: 'Очки прогрессии (PP)',
    hint: 'Включает UI и расчёты Очков прогрессии на основе одобренных страниц журналов.',
    scope: 'world',
    config: true,
    restricted: true,
    default: false,
    type: Boolean,
    onChange: () => {
      try { ui?.journal?.render(true); } catch (_) {}
    },
  });
}

export function isProgressionEnabled() {
  try {
    return !!game.settings.get(MODULE_NS, SETTING_ENABLED);
  } catch (_) {
    return false;
  }
}

function _isOurUpdate(options) {
  return !!options?.spaceholderProgression;
}

function _currentUserIsActor(userId) {
  return !!userId && (userId === game?.user?.id);
}

function _getFlagObj(doc) {
  try {
    return doc?.getFlag?.(MODULE_NS, FLAG_ROOT) ?? doc?.flags?.[MODULE_NS]?.[FLAG_ROOT] ?? {};
  } catch (_) {
    return {};
  }
}

export function getPageProgression(page) {
  return _getFlagObj(page);
}

export function getPagePoints(page) {
  const raw = _getFlagObj(page)?.points;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function getPageAuthorUserId(page) {
  const id = String(_getFlagObj(page)?.authorUserId ?? '').trim();
  return id || null;
}

export async function setPageProgression(page, { points = null, authorUserId = null } = {}) {
  if (!page) return;

  const next = { ...(_getFlagObj(page) || {}) };
  if (points !== null && points !== undefined) next.points = Number(points) || 0;
  if (authorUserId !== null && authorUserId !== undefined) next.authorUserId = String(authorUserId ?? '').trim() || null;

  await page.setFlag(MODULE_NS, FLAG_ROOT, next);
}

export function getUserProgression(user) {
  if (!user) return {};
  try {
    return user.getFlag?.(MODULE_NS, FLAG_ROOT) ?? user.flags?.[MODULE_NS]?.[FLAG_ROOT] ?? {};
  } catch (_) {
    return {};
  }
}

export function getUserManualAdjustments(user) {
  const raw = getUserProgression(user)?.manual;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => ({
      id: String(r?.id ?? '').trim(),
      name: String(r?.name ?? '').trim(),
      points: Number(r?.points) || 0,
    }))
    .filter((r) => r.id);
}

export async function setUserManualAdjustments(user, manual) {
  if (!user) return;

  const next = { ...(getUserProgression(user) || {}) };
  next.manual = Array.isArray(manual) ? manual : [];

  await user.setFlag(MODULE_NS, FLAG_ROOT, next);
}

function _randomId() {
  try { return foundry.utils.randomID?.(); } catch (_) {}
  try { return globalThis.randomID?.(); } catch (_) {}
  try { return globalThis.crypto?.randomUUID?.(); } catch (_) {}
  return String(Date.now());
}

function _getTimelineFlagObj(doc, root) {
  try {
    return doc?.getFlag?.(MODULE_NS, root) ?? doc?.flags?.[MODULE_NS]?.[root] ?? {};
  } catch (_) {
    return {};
  }
}

function _isTimelineContainer(entry) {
  const v1 = _getTimelineFlagObj(entry, 'timeline');
  if (v1?.isContainer) return true;
  const v2 = _getTimelineFlagObj(entry, 'timelineV2');
  return !!v2?.isContainer;
}

function _isTimelinePage(page) {
  const v1 = _getTimelineFlagObj(page, 'timeline');
  if (v1?.isEntry) return true;

  const v2 = _getTimelineFlagObj(page, 'timelineV2');
  if (v2?.isIndex || v2?.isDetail) return true;

  return _isTimelineContainer(page?.parent);
}

export function collectApprovedPages() {
  const out = [];
  const entries = Array.isArray(game?.journal?.contents) ? game.journal.contents : [];

  for (const entry of entries) {
    if (!entry?.id) continue;
    if (_isTimelineContainer(entry)) continue;

    const pages = entry?.pages?.contents ?? [];
    for (const page of pages) {
      if (!page?.id) continue;
      if (_isTimelinePage(page)) continue;
      if (getStatus(page) !== 'approved') continue;

      out.push({ entry, page });
    }
  }

  return out;
}

export function computePlayerPointsBreakdown(user) {
  const userId = String(user?.id ?? '').trim();
  const approved = collectApprovedPages();

  const journalLines = [];
  let journalPoints = 0;

  for (const { entry, page } of approved) {
    const authorId = getPageAuthorUserId(page);
    if (!authorId || authorId !== userId) continue;

    const pts = getPagePoints(page);
    journalPoints += pts;

    journalLines.push({
      type: 'journal',
      id: page.uuid ?? `${entry.id}:${page.id}`,
      name: (page?.name || '').trim() || '(без названия)',
      entryName: (entry?.name || '').trim() || '(без названия)',
      points: pts,
      uuid: page.uuid ?? null,
    });
  }

  const manual = getUserManualAdjustments(user);
  const manualLines = manual.map((m) => ({
    type: 'manual',
    id: m.id,
    name: m.name || '(без названия)',
    points: Number(m.points) || 0,
  }));

  const manualPoints = manualLines.reduce((acc, r) => acc + (Number(r.points) || 0), 0);
  const totalPlayerPoints = journalPoints + manualPoints;

  return {
    journalLines,
    manualLines,
    journalPoints,
    manualPoints,
    totalPlayerPoints,
  };
}

export function computeFactionMaxPoints(factionActor) {
  const factionUuid = normalizeUuid(factionActor?.uuid);
  if (!factionUuid) return 0;

  const users = getUsersForFaction(factionUuid);
  let base = 0;

  for (const u of users) {
    const bd = computePlayerPointsBreakdown(u);
    base += Number(bd.totalPlayerPoints) || 0;
  }

  const mod = Number(factionActor?.system?.ppModifier);
  const modifier = Number.isFinite(mod) ? mod : 1;

  return base * modifier;
}

function _isGlobalMapScene(scene) {
  try {
    return !!(scene?.getFlag?.(MODULE_NS, 'isGlobalMap') ?? scene?.flags?.[MODULE_NS]?.isGlobalMap);
  } catch (_) {
    return false;
  }
}

export function collectGlobalObjectTokensForFaction(factionUuidRaw) {
  const factionUuid = normalizeUuid(factionUuidRaw);
  if (!factionUuid) return [];

  const out = [];
  const scenes = Array.isArray(game?.scenes?.contents) ? game.scenes.contents : [];

  for (const scene of scenes) {
    if (!scene?.id) continue;
    if (!_isGlobalMapScene(scene)) continue;

    const tokens = scene?.tokens?.contents ?? [];
    for (const td of tokens) {
      const actor = td?.actor ?? null;
      if (!actor || actor.type !== 'globalobject') continue;

      const gFaction = normalizeUuid(actor.system?.gFaction);
      if (!gFaction || gFaction !== factionUuid) continue;

      const cost = Number(actor.system?.ppCost) || 0;

      out.push({
        sceneId: scene.id,
        sceneName: String(scene.name ?? '').trim() || scene.id,
        tokenId: td.id,
        tokenName: String(td.name ?? '').trim() || String(actor.name ?? '').trim() || '(без названия)',
        actorId: actor.id,
        actorName: String(actor.name ?? '').trim() || actor.id,
        actorUuid: actor.uuid ?? null,
        cost,
      });
    }
  }

  return out;
}

export function computeFactionSpentPoints(factionActor) {
  const factionUuid = normalizeUuid(factionActor?.uuid);
  if (!factionUuid) return { spentTablePoints: 0, spentGlobalObjectsPoints: 0, spentTotal: 0, tokenRows: [] };

  const spends = Array.isArray(factionActor?.system?.ppSpends) ? factionActor.system.ppSpends : [];
  const spentTablePoints = spends.reduce((acc, r) => acc + (Number(r?.points) || 0), 0);

  const tokenRows = collectGlobalObjectTokensForFaction(factionUuid);
  const spentGlobalObjectsPoints = tokenRows.reduce((acc, r) => acc + (Number(r?.cost) || 0), 0);

  return {
    spentTablePoints,
    spentGlobalObjectsPoints,
    spentTotal: spentTablePoints + spentGlobalObjectsPoints,
    tokenRows,
  };
}

function _ensureProgressionMetaBlock(root) {
  if (!root) return null;

  let host = root.querySelector('[data-spaceholder-pp-host]');
  if (host) return host;

  // Prefer placing into the journal header (inside window content), per UX request.
  const header = root.querySelector('.window-content .journal-header')
    || root.querySelector('.journal-header')
    || root.querySelector('.window-content header')
    || root.querySelector('header');

  host = header || root;

  const wrap = document.createElement('span');
  wrap.dataset.spaceholderPpHost = '1';
  host.appendChild(wrap);
  return wrap;
}

async function _injectCurrentPageMeta(app, root) {
  const entry = app?.entry;
  if (!entry) return;

  // Determine current page
  const pageId = String(
    app?.page?.id
      ?? app?.pageId
      ?? app?.options?.pageId
      ?? root?.querySelector?.('.toc [data-page-id].active')?.dataset?.pageId
      ?? root?.querySelector?.('[data-page-id].active')?.dataset?.pageId
      ?? ''
  ).trim();

  const page = pageId ? (entry.pages?.get?.(pageId) ?? null) : null;
  if (!page) return;
  if (_isTimelinePage(page)) return;

  const host = _ensureProgressionMetaBlock(root);
  if (!host) return;

  // Replace content each render
  host.innerHTML = '';

  const canEdit = (() => {
    try { return !!page?.canUserModify?.(game.user, 'update'); } catch (_) { return false; }
  })();

  const points = getPagePoints(page);
  const authorUserId = getPageAuthorUserId(page);

  const authorName = authorUserId
    ? (String(game?.users?.get?.(authorUserId)?.name ?? '').trim() || authorUserId)
    : '—';


  const panel = document.createElement('div');
  panel.className = 'spaceholder-pp-meta';

  const pointsInput = document.createElement('input');
  pointsInput.type = 'number';
  pointsInput.value = String(points);
  pointsInput.step = '1';
  pointsInput.className = 'spaceholder-pp-meta__points';
  pointsInput.setAttribute('aria-label', 'Очки прогрессии');
  pointsInput.title = 'Очки прогрессии';

  const select = document.createElement('select');
  select.className = 'spaceholder-pp-meta__author';
  select.setAttribute('aria-label', 'Автор');
  select.title = 'Автор';

  const users = Array.from(game?.users?.values?.() ?? game?.users?.contents ?? []);
  users.sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' }));

  const optEmpty = document.createElement('option');
  optEmpty.value = '';
  optEmpty.textContent = '—';
  select.appendChild(optEmpty);

  for (const u of users) {
    if (!u?.id) continue;
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = u.name || u.id;
    if (authorUserId && authorUserId === u.id) opt.selected = true;
    select.appendChild(opt);
  }

  const apply = async () => {
    if (!canEdit) return;
    const nextPoints = Number(pointsInput.value) || 0;
    const nextAuthor = String(select.value || '').trim() || null;
    try {
      await setPageProgression(page, { points: nextPoints, authorUserId: nextAuthor });
    } catch (e) {
      console.error('SpaceHolder | Progression: failed to update page progression', e);
    }
  };

  pointsInput.addEventListener('change', apply);
  select.addEventListener('change', apply);

  if (!canEdit) {
    pointsInput.disabled = true;
    select.disabled = true;
    // keep some context visible via native tooltips
    pointsInput.title = `Очки прогрессии: ${points}`;
    select.title = `Автор: ${authorName}`;
  }

  panel.appendChild(pointsInput);
  panel.appendChild(select);

  host.appendChild(panel);
}

export function installProgressionPointsHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  Hooks.on('preCreateJournalEntryPage', (page, data, options, userId) => {
    try {
      if (!isProgressionEnabled()) return;
      if (_isOurUpdate(options)) return;
      if (!_currentUserIsActor(userId)) return;

      const current = foundry.utils.getProperty(data, `flags.${MODULE_NS}.${FLAG_ROOT}`);
      const hasPoints = current && current.points !== undefined && current.points !== null;
      const hasAuthor = current && current.authorUserId !== undefined && current.authorUserId !== null;

      if (!hasPoints) foundry.utils.setProperty(data, `flags.${MODULE_NS}.${FLAG_ROOT}.points`, 1);
      if (!hasAuthor) foundry.utils.setProperty(data, `flags.${MODULE_NS}.${FLAG_ROOT}.authorUserId`, game.user.id);
    } catch (e) {
      console.error('SpaceHolder | Progression: preCreateJournalEntryPage failed', e);
    }
  });

  Hooks.on('renderJournalDirectory', (app, html /*, context, options */) => {
    try {
      if (!isProgressionEnabled()) return;
      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!root) return;

      const header = root.querySelector('.directory-header') || root.querySelector('header') || root;
      let actions = header.querySelector('.header-actions')
        || header.querySelector('.action-buttons')
        || header.querySelector('.header-controls');

      if (!actions) {
        const createBtn = header.querySelector(
          '[data-action="createEntry"], [data-action="create-entry"], [data-action="createFolder"], [data-action="create-folder"], .create-entry, .create-folder'
        );
        actions = createBtn?.parentElement ?? null;
      }

      if (!actions) return;
      if (actions.querySelector('.spaceholder-progression-open')) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.classList.add('spaceholder-progression-open');
      btn.title = 'Очки прогрессии';
      btn.innerHTML = '<i class="fa-solid fa-coins"></i>';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try { game.spaceholder?.openProgressionPointsApp?.(); } catch (_) {}
      });

      actions.appendChild(btn);
    } catch (e) {
      console.error('SpaceHolder | Progression: renderJournalDirectory failed', e);
    }
  });

  Hooks.on('renderJournalEntrySheet', (app, html /*, context, options */) => {
    try {
      if (!isProgressionEnabled()) return;
      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!root) return;
      _injectCurrentPageMeta(app, root);
    } catch (e) {
      console.error('SpaceHolder | Progression: renderJournalEntrySheet failed', e);
    }
  });
}

export function makeNewManualEntry() {
  return { id: _randomId(), name: '', points: 0 };
}

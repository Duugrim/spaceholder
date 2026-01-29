// Timeline V2 (SpaceHolder)
// Storage: JournalEntry containers + JournalEntryPage events.
// - World container holds public index (stubs) for ALL events.
// - Faction containers hold details:
//   - Private (non-global): only faction members can view.
//   - Public (global): everyone can view, but only faction members can edit.
// Calendar: simplified (12 months x 30 days). Year can be negative/0.

import {
  getUserFactionUuids,
  getUsersForFaction,
  normalizeUuid as normalizeUuidUserFactions,
  parseFactionUuidList,
} from './user-factions.mjs';

const MODULE_NS = 'spaceholder';
const FLAG_ROOT = 'timelineV2';

const SOCKET_TYPE = `${MODULE_NS}.timelineV2`;

// Settings (client)
const SETTING_ACTIVE_FACTIONS = 'timelineV2.activeFactions';
const SETTING_HIDE_UNKNOWN = 'timelineV2.hideUnknown';
const SETTING_ZOOM = 'timelineV2.zoom';
const SETTING_PINNED_EVENTS = 'timelineV2.pinnedEvents';

export const TIMELINE_V2_ORIGIN = {
  FACTION: 'faction',
  WORLD: 'world',
};

export const TIMELINE_V2_CONTAINER_KIND = {
  WORLD: 'world',

  // NOTE: keep legacy internal kind value for private containers to avoid breaking early V2 data.
  FACTION_PRIVATE: 'factionDetails',
  FACTION_PUBLIC: 'factionDetailsPublic',

  // Backward-compat alias (internal to V2 development).
  FACTION_DETAILS: 'factionDetails',
};

// Dedicated folder for timeline V2 containers (no migration of existing documents)
const TIMELINE_V2_FOLDER_NAME = 'SpaceHolder Timeline V2';
let _timelineV2FolderId = null;

let _socketInstalled = false;
let _hooksInstalled = false;

// Request/response (client-side)
let _reqSeq = 0;
const _pending = new Map(); // requestId -> {resolve,reject,timeoutId}

// Cache containers by key
const _containerCache = new Map(); // key -> JournalEntry

function _socketName() {
  try {
    return `system.${game.system.id}`;
  } catch (_) {
    return `system.${MODULE_NS}`;
  }
}

export function normalizeUuid(raw) {
  // Delegate to shared helper so @UUID[...] is supported consistently.
  return normalizeUuidUserFactions(raw);
}

function _getFlagObj(doc) {
  try {
    return doc?.getFlag?.(MODULE_NS, FLAG_ROOT) ?? doc?.flags?.[MODULE_NS]?.[FLAG_ROOT] ?? {};
  } catch (_) {
    return {};
  }
}

function _containerKey(kind, factionUuid = '') {
  return `${String(kind || '').trim()}::${normalizeUuid(factionUuid)}`;
}

function _invalidateContainerCache() {
  _containerCache.clear();
}

function _isTimelineV2Folder(folder) {
  const f = _getFlagObj(folder);
  return !!f?.isFolder;
}

function _findTimelineV2FolderInWorld() {
  if (_timelineV2FolderId) {
    const cached = game?.folders?.get?.(_timelineV2FolderId) ?? null;
    if (cached && _isTimelineV2Folder(cached)) return cached;
    _timelineV2FolderId = null;
  }

  const folders = Array.isArray(game?.folders?.contents) ? game.folders.contents : [];
  for (const folder of folders) {
    if (!folder?.id) continue;
    if (folder.type !== 'JournalEntry') continue;
    if (!_isTimelineV2Folder(folder)) continue;
    _timelineV2FolderId = folder.id;
    return folder;
  }

  return null;
}

async function _gmEnsureTimelineV2Folder() {
  if (!game?.user?.isGM) return null;

  const existing = _findTimelineV2FolderInWorld();
  if (existing) return existing;

  const flags = {
    [MODULE_NS]: {
      [FLAG_ROOT]: {
        isFolder: true,
      },
    },
  };

  const data = {
    name: TIMELINE_V2_FOLDER_NAME,
    type: 'JournalEntry',
    flags,
  };

  const FolderClass = globalThis.Folder ?? game?.folders?.documentClass;
  if (!FolderClass?.create) {
    console.error('SpaceHolder | TimelineV2: Folder class unavailable');
    return null;
  }

  const created = await FolderClass.create(data, { render: false, spaceholderJournalCheck: true });
  _timelineV2FolderId = created?.id ?? null;
  return created;
}

export function isTimelineV2Container(entry) {
  const f = _getFlagObj(entry);
  return !!f?.isContainer;
}

export function isTimelineV2Page(page) {
  const f = _getFlagObj(page);
  return !!(f?.isIndex || f?.isDetail);
}

export function isTimelineV2IndexPage(page) {
  const f = _getFlagObj(page);
  return !!f?.isIndex;
}

export function isTimelineV2DetailPage(page) {
  const f = _getFlagObj(page);
  return !!f?.isDetail;
}

export function getTimelineV2ContainerKind(entry) {
  const f = _getFlagObj(entry);
  return String(f?.containerKind ?? '').trim() || null;
}

export function getTimelineV2ContainerFactionUuid(entry) {
  const f = _getFlagObj(entry);
  return normalizeUuid(f?.factionUuid);
}

function _normalizeYear(raw) {
  const y = Number.parseInt(raw, 10);
  return Number.isFinite(y) ? y : 0;
}

function _normalizeMonth(raw) {
  const m = Number.parseInt(raw, 10);
  if (!Number.isFinite(m)) return 1;
  return Math.min(12, Math.max(1, m));
}

function _normalizeDay(raw) {
  const d = Number.parseInt(raw, 10);
  if (!Number.isFinite(d)) return 1;
  return Math.min(30, Math.max(1, d));
}

function _normalizeOrigin(raw, { factionUuid = '' } = {}) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === TIMELINE_V2_ORIGIN.WORLD) return TIMELINE_V2_ORIGIN.WORLD;
  if (s === TIMELINE_V2_ORIGIN.FACTION) return TIMELINE_V2_ORIGIN.FACTION;
  return factionUuid ? TIMELINE_V2_ORIGIN.FACTION : TIMELINE_V2_ORIGIN.WORLD;
}

function _normalizeIconPath(raw) {
  const s = String(raw ?? '').trim();
  return s;
}

function _normalizeDurationDays(raw) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

export function getTimelineV2PageData(page) {
  const f = _getFlagObj(page);

  const year = _normalizeYear(f?.year);
  const month = _normalizeMonth(f?.month);
  const day = _normalizeDay(f?.day);

  const factionUuid = normalizeUuid(f?.factionUuid);

  const origin = _normalizeOrigin(f?.origin, { factionUuid });
  const iconPath = _normalizeIconPath(f?.iconPath);

  const isGlobal = !!f?.isGlobal;
  const isHidden = !!f?.isHidden;

  const hasDuration = !!f?.hasDuration;
  const durationDays = _normalizeDurationDays(f?.durationDays);

  const schema = Number.parseInt(String(f?.schema ?? '').trim(), 10);

  const isIndex = !!f?.isIndex;
  const isDetail = !!f?.isDetail;

  const detailUuid = normalizeUuid(f?.detailUuid);
  const indexUuid = normalizeUuid(f?.indexUuid);

  return {
    year,
    month,
    day,
    factionUuid,
    origin,
    iconPath,
    isGlobal,
    isHidden,
    hasDuration: hasDuration && durationDays > 0,
    durationDays,
    schema: Number.isFinite(schema) ? schema : null,
    isIndex,
    isDetail,
    detailUuid,
    indexUuid,
  };
}

function _findContainerInWorld({ kind, factionUuid = '' }) {
  const key = _containerKey(kind, factionUuid);
  if (_containerCache.has(key)) {
    const cached = _containerCache.get(key);
    if (cached && cached.id && game?.journal?.get?.(cached.id)) return cached;
    _containerCache.delete(key);
  }

  const entries = Array.isArray(game?.journal?.contents) ? game.journal.contents : [];
  for (const e of entries) {
    if (!e?.id) continue;
    const f = _getFlagObj(e);
    if (!f?.isContainer) continue;

    const k = String(f?.containerKind ?? '').trim();
    if (k !== kind) continue;

    const fu = normalizeUuid(f?.factionUuid);
    if (normalizeUuid(factionUuid) !== fu) continue;

    _containerCache.set(key, e);
    return e;
  }

  return null;
}

function _buildContainerName({ kind, factionDoc = null, factionUuid = '' }) {
  const fu = normalizeUuid(factionUuid);
  const factionName = String(factionDoc?.name ?? '').trim();
  const suffix = factionName ? `${factionName} (${fu || 'no-uuid'})` : (fu || 'no-uuid');

  if (kind === TIMELINE_V2_CONTAINER_KIND.WORLD) return 'Spaceholder Timeline V2: World';

  if (kind === TIMELINE_V2_CONTAINER_KIND.FACTION_PUBLIC) {
    return `Spaceholder Timeline V2: Faction ${suffix} (Public)`;
  }

  // Private (and legacy alias)
  if (kind === TIMELINE_V2_CONTAINER_KIND.FACTION_PRIVATE || kind === TIMELINE_V2_CONTAINER_KIND.FACTION_DETAILS) {
    return `Spaceholder Timeline V2: Faction ${suffix} (Private)`;
  }

  return `Spaceholder Timeline V2: ${kind}`;
}

function _ownershipObj({ defaultLevel, ownerIds = [] }) {
  const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

  const out = { default: defaultLevel };

  // GMs always own
  const users = Array.from(game?.users?.values?.() ?? game?.users?.contents ?? []);
  for (const u of users) {
    if (!u?.id) continue;
    if (u.isGM) out[u.id] = OWN;
  }

  for (const id of ownerIds) {
    const k = String(id ?? '').trim();
    if (!k) continue;
    out[k] = OWN;
  }

  return out;
}

async function _gmUpsertContainer({ kind, factionUuid = '' }) {
  if (!game?.user?.isGM) return null;

  const fu = normalizeUuid(factionUuid);
  const existing = _findContainerInWorld({ kind, factionUuid: fu });

  // Resolve faction doc for naming (best-effort)
  let factionDoc = null;
  if (fu) {
    try {
      factionDoc = await fromUuid(fu);
    } catch (_) {
      factionDoc = null;
    }
  }

  const name = _buildContainerName({ kind, factionDoc, factionUuid: fu });

  const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

  // В этой конфигурации мы доверяем игрокам: все контейнеры (включая world) доступны на уровне OWNER.
  // Это позволяет создавать/редактировать индексные страницы напрямую, без проксирования через сокет.
  const ownerIds = [];
  const defaultLevel = OWN;

  const desiredOwnership = _ownershipObj({ defaultLevel, ownerIds });

  if (!existing) {
    const flags = {
      [MODULE_NS]: {
        [FLAG_ROOT]: {
          isContainer: true,
          containerKind: kind,
          factionUuid: fu,
        },
      },
    };

    // Place newly created containers into the dedicated folder.
    let folder = _findTimelineV2FolderInWorld();
    if (!folder) {
      await _gmEnsureTimelineV2Folder();
      folder = _findTimelineV2FolderInWorld();
    }

    const data = {
      name,
      folder: folder?.id ?? null,
      ownership: desiredOwnership,
      flags,
    };

    const DocClass = globalThis.JournalEntry ?? game?.journal?.documentClass;
    if (!DocClass?.create) {
      console.error('SpaceHolder | TimelineV2: JournalEntry class unavailable');
      return null;
    }

    const created = await DocClass.create(data, { render: false, spaceholderJournalCheck: true });
    _invalidateContainerCache();
    return created;
  }

  // Ensure flags
  const f = _getFlagObj(existing);
  const needsFlag = !f?.isContainer || String(f?.containerKind ?? '') !== kind || normalizeUuid(f?.factionUuid) !== fu;

  const patch = {};
  if (needsFlag) {
    patch[`flags.${MODULE_NS}.${FLAG_ROOT}`] = {
      ...(f || {}),
      isContainer: true,
      containerKind: kind,
      factionUuid: fu,
    };
  }

  // Keep name updated (best-effort)
  if (String(existing.name ?? '') !== name) patch.name = name;

  // Ownership sync
  patch.ownership = desiredOwnership;

  if (Object.keys(patch).length) {
    await existing.update(patch, { diff: false, spaceholderJournalCheck: true });
  }

  _containerCache.set(_containerKey(kind, fu), existing);
  return existing;
}

export async function gmEnsureTimelineV2Containers({ factionUuids = [] } = {}) {
  if (!game?.user?.isGM) return false;

  await _gmEnsureTimelineV2Folder();

  await _gmUpsertContainer({ kind: TIMELINE_V2_CONTAINER_KIND.WORLD });

  const uuids = Array.isArray(factionUuids) ? factionUuids : [];
  for (const raw of uuids) {
    const fu = normalizeUuid(raw);
    if (!fu) continue;
    await _gmUpsertContainer({ kind: TIMELINE_V2_CONTAINER_KIND.FACTION_PRIVATE, factionUuid: fu });
    await _gmUpsertContainer({ kind: TIMELINE_V2_CONTAINER_KIND.FACTION_PUBLIC, factionUuid: fu });
  }

  return true;
}

export async function gmSyncTimelineV2OwnershipForAllFactions() {
  if (!game?.user?.isGM) return false;

  const factionActors = Array.from(game?.actors?.values?.() ?? game?.actors?.contents ?? [])
    .filter((a) => a?.type === 'faction');

  const factionUuids = factionActors.map((a) => a.uuid).filter(Boolean);
  await gmEnsureTimelineV2Containers({ factionUuids });
  return true;
}

export function getTimelineV2Container({ kind, factionUuid = '' }) {
  return _findContainerInWorld({ kind, factionUuid });
}

export function listTimelineV2Containers({ kind = null } = {}) {
  const entries = Array.isArray(game?.journal?.contents) ? game.journal.contents : [];
  const out = [];
  for (const e of entries) {
    if (!e?.id) continue;
    const f = _getFlagObj(e);
    if (!f?.isContainer) continue;

    const k = String(f?.containerKind ?? '').trim();
    if (kind && k !== kind) continue;

    out.push(e);
  }
  return out;
}

export function listTimelineV2PagesInContainer(entry) {
  const pages = entry?.pages?.contents ?? [];
  return pages.filter((p) => p?.id && isTimelineV2Page(p));
}

export function listTimelineV2IndexPages() {
  const world = getTimelineV2Container({ kind: TIMELINE_V2_CONTAINER_KIND.WORLD });
  if (!world) return [];

  return listTimelineV2PagesInContainer(world).filter((p) => isTimelineV2IndexPage(p));
}

export async function resolveTimelineV2Page(rawUuid) {
  const uuid = normalizeUuid(rawUuid);
  if (!uuid) return null;

  let doc = null;
  try {
    doc = await fromUuid(uuid);
  } catch (_) {
    doc = null;
  }

  if (!doc || doc.documentName !== 'JournalEntryPage') return null;
  if (!isTimelineV2Page(doc)) return null;

  return doc;
}

export async function resolveTimelineV2DetailFromIndex(indexPage) {
  if (!indexPage) return null;
  const t = getTimelineV2PageData(indexPage);
  if (!t.isIndex || !t.detailUuid) return null;
  return await resolveTimelineV2Page(t.detailUuid);
}

async function _updateTimelineV2PageDate(page, { year, month, day }) {
  if (!page) return false;

  const f = { ..._getFlagObj(page) };
  f.year = _normalizeYear(year);
  f.month = _normalizeMonth(month);
  f.day = _normalizeDay(day);

  await page.update({ [`flags.${MODULE_NS}.${FLAG_ROOT}`]: f }, { diff: false, spaceholderJournalCheck: true });
  return true;
}

export async function updateTimelineV2EventDate({ indexUuid, year, month, day } = {}) {
  const indexPage = await resolveTimelineV2Page(indexUuid);
  if (!indexPage) throw new Error('Index page not found');

  const t = getTimelineV2PageData(indexPage);
  if (!t.isIndex) throw new Error('Expected index page');

  const detailPage = await resolveTimelineV2DetailFromIndex(indexPage);
  if (!detailPage) throw new Error('Detail page not found');

  const y = _normalizeYear(year);
  const m = _normalizeMonth(month);
  const d = _normalizeDay(day);

  const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

  // GM can update directly.
  if (game.user?.isGM) {
    await _updateTimelineV2PageDate(indexPage, { year: y, month: m, day: d });
    await _updateTimelineV2PageDate(detailPage, { year: y, month: m, day: d });
    return true;
  }

  // Players can only request updates for pages they own.
  if (!detailPage.testUserPermission?.(game.user, OWN)) {
    throw new Error('No permission');
  }

  await _requestViaSocket('updateDate', {
    indexUuid: indexPage.uuid,
    year: y,
    month: m,
    day: d,
  }, { timeoutMs: 12000 });

  return true;
}

async function _updateTimelineV2PageMeta(page, { iconPath, hasDuration, durationDays } = {}) {
  if (!page) return false;

  const f = { ..._getFlagObj(page) };

  f.iconPath = _normalizeIconPath(iconPath);

  const hd = !!hasDuration;
  if (hd) {
    const dd = _normalizeDurationDays(durationDays);
    if (!(dd > 0)) throw new Error('Invalid duration');
    f.hasDuration = true;
    f.durationDays = dd;
  } else {
    f.hasDuration = false;
    delete f.durationDays;
  }

  f.schema = 2;

  await page.update({ [`flags.${MODULE_NS}.${FLAG_ROOT}`]: f }, { diff: false, spaceholderJournalCheck: true });
  return true;
}

export async function updateTimelineV2EventMeta({
  indexUuid,
  iconPath = '',
  hasDuration = false,
  durationDays = 0,
} = {}) {
  const indexPage = await resolveTimelineV2Page(indexUuid);
  if (!indexPage) throw new Error('Index page not found');

  const t = getTimelineV2PageData(indexPage);
  if (!t.isIndex) throw new Error('Expected index page');

  const detailPage = await resolveTimelineV2DetailFromIndex(indexPage);
  if (!detailPage) throw new Error('Detail page not found');

  const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

  // GM can update directly.
  if (game.user?.isGM) {
    await _updateTimelineV2PageMeta(indexPage, { iconPath, hasDuration, durationDays });
    await _updateTimelineV2PageMeta(detailPage, { iconPath, hasDuration, durationDays });
    return true;
  }

  // Players can only request updates for pages they own.
  if (!detailPage.testUserPermission?.(game.user, OWN)) {
    throw new Error('No permission');
  }

  await _requestViaSocket('updateMeta', {
    indexUuid: indexPage.uuid,
    iconPath: _normalizeIconPath(iconPath),
    hasDuration: !!hasDuration,
    durationDays: _normalizeDurationDays(durationDays),
  }, { timeoutMs: 12000 });

  return true;
}

async function _deleteTimelineV2EmbeddedPage(page) {
  if (!page) return false;

  // Preferred: delete via parent embedded deletion for consistent behavior.
  try {
    if (page.parent?.deleteEmbeddedDocuments && page.id) {
      await page.parent.deleteEmbeddedDocuments('JournalEntryPage', [page.id], { spaceholderJournalCheck: true });
      return true;
    }
  } catch (_) {
    // fallback below
  }

  try {
    if (typeof page.delete === 'function') {
      await page.delete({ spaceholderJournalCheck: true });
      return true;
    }
  } catch (_) {
    // ignore
  }

  return false;
}

export async function deleteTimelineV2Event({ indexUuid } = {}) {
  const indexPage = await resolveTimelineV2Page(indexUuid);
  if (!indexPage) throw new Error('Index page not found');

  const t = getTimelineV2PageData(indexPage);
  if (!t.isIndex) throw new Error('Expected index page');

  const detailPage = await resolveTimelineV2DetailFromIndex(indexPage);

  const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

  // GM can delete directly.
  if (game.user?.isGM) {
    const okIndex = await _deleteTimelineV2EmbeddedPage(indexPage);
    if (!okIndex) throw new Error('Failed to delete index page');

    // Best-effort: allow cleanup even if detail is missing.
    if (detailPage) {
      const okDetail = await _deleteTimelineV2EmbeddedPage(detailPage);
      if (!okDetail) throw new Error('Failed to delete detail page');
    }

    return true;
  }

  // Players can only request deletion for pages they own.
  if (!detailPage || !detailPage.testUserPermission?.(game.user, OWN)) {
    throw new Error('No permission');
  }

  await _requestViaSocket('deleteEvent', {
    indexUuid: indexPage.uuid,
  }, { timeoutMs: 12000 });

  return true;
}

export function canUserOwnContainer(entry, user) {
  try {
    return !!entry?.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
  } catch (_) {
    return false;
  }
}

// ===== Settings (client) =====

function _getSettingSafe(key, fallback) {
  try {
    return game.settings.get(MODULE_NS, key);
  } catch (_) {
    return fallback;
  }
}

async function _setSettingSafe(key, value) {
  try {
    await game.settings.set(MODULE_NS, key, value);
    return true;
  } catch (e) {
    console.error(`SpaceHolder | TimelineV2: failed to persist setting ${key}`, e);
    return false;
  }
}

export function getTimelineV2HideUnknown() {
  return !!_getSettingSafe(SETTING_HIDE_UNKNOWN, false);
}

export async function setTimelineV2HideUnknown(v) {
  return await _setSettingSafe(SETTING_HIDE_UNKNOWN, !!v);
}

export function getTimelineV2Zoom() {
  const raw = Number(_getSettingSafe(SETTING_ZOOM, 1));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export async function setTimelineV2Zoom(v) {
  const n = Number(v);
  const safe = Number.isFinite(n) && n > 0 ? n : 1;
  return await _setSettingSafe(SETTING_ZOOM, safe);
}

export function getTimelineV2ActiveFactionsSetting() {
  const raw = _getSettingSafe(SETTING_ACTIVE_FACTIONS, null);
  if (!raw || typeof raw !== 'object') {
    return { mode: 'auto', uuids: [] };
  }

  const mode = String(raw.mode || 'auto');
  const uuids = Array.isArray(raw.uuids) ? raw.uuids.map(normalizeUuid).filter(Boolean) : [];
  return {
    mode: (mode === 'custom') ? 'custom' : 'auto',
    uuids,
  };
}

export async function setTimelineV2ActiveFactionsSetting({ mode, uuids } = {}) {
  const m = (String(mode || 'auto') === 'custom') ? 'custom' : 'auto';
  const list = Array.isArray(uuids) ? uuids.map(normalizeUuid).filter(Boolean) : [];
  return await _setSettingSafe(SETTING_ACTIVE_FACTIONS, { mode: m, uuids: list });
}

export function getAvailableFactionChoices({ includeAllWorldFactions = false } = {}) {
  const isGM = !!game?.user?.isGM;

  const uuids = isGM || includeAllWorldFactions
    ? Array.from(game?.actors?.values?.() ?? game?.actors?.contents ?? [])
      .filter((a) => a?.type === 'faction')
      .map((a) => a.uuid)
    : getUserFactionUuids(game.user);

  const seen = new Set();
  const out = [];

  for (const raw of uuids) {
    const uuid = String(raw || '').trim();
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);

    let doc = null;
    // Fast-path for world actors
    try {
      const parts = uuid.split('.');
      if (parts[0] === 'Actor' && parts[1] && parts.length === 2) {
        doc = game?.actors?.get?.(parts[1]) ?? null;
      }
    } catch (_) {
      doc = null;
    }

    const name = String(doc?.name ?? uuid);
    const color = String(doc?.system?.fColor ?? '').trim();

    out.push({ uuid, name, color });
  }

  out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru', { sensitivity: 'base' }));
  return out;
}

export function getTimelineV2ActiveFactionUuids() {
  const cfg = getTimelineV2ActiveFactionsSetting();
  if (cfg.mode === 'custom') return cfg.uuids;

  // auto: all available for current user (GM: all world factions; player: user factions)
  const isGM = !!game?.user?.isGM;
  const all = isGM
    ? getAvailableFactionChoices({ includeAllWorldFactions: true }).map((f) => f.uuid)
    : getUserFactionUuids(game.user);

  return Array.from(new Set(all.map(normalizeUuid).filter(Boolean)));
}

function _normalizePinnedEventUuids(raw) {
  // New schema: { uuids: [] }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const list = Array.isArray(raw.uuids) ? raw.uuids : [];
    return Array.from(new Set(list.map(normalizeUuid).filter(Boolean)));
  }

  // Legacy: array
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.map(normalizeUuid).filter(Boolean)));
  }

  // Edge-case: arrays serialized as plain objects {"0":"uuid", ...}
  if (raw && typeof raw === 'object') {
    const vals = Object.values(raw).filter((v) => typeof v === 'string');
    return Array.from(new Set(vals.map(normalizeUuid).filter(Boolean)));
  }

  return [];
}

export function getTimelineV2PinnedEventUuids() {
  const raw = _getSettingSafe(SETTING_PINNED_EVENTS, { uuids: [] });
  return _normalizePinnedEventUuids(raw);
}

export function isTimelineV2EventPinned(indexUuid) {
  const uuid = normalizeUuid(indexUuid);
  if (!uuid) return false;
  return getTimelineV2PinnedEventUuids().includes(uuid);
}

export async function setTimelineV2PinnedEventUuids(uuids) {
  const list = Array.isArray(uuids) ? uuids.map(normalizeUuid).filter(Boolean) : [];
  const unique = Array.from(new Set(list));
  return await _setSettingSafe(SETTING_PINNED_EVENTS, { uuids: unique });
}

export async function toggleTimelineV2EventPinned(indexUuid) {
  const uuid = normalizeUuid(indexUuid);
  if (!uuid) return false;

  const cur = getTimelineV2PinnedEventUuids();
  const set = new Set(cur);

  if (set.has(uuid)) set.delete(uuid);
  else set.add(uuid);

  await setTimelineV2PinnedEventUuids(Array.from(set));
  return set.has(uuid);
}

export function registerTimelineV2Settings() {
  const settings = game?.settings;
  const registry = settings?.settings;

  try {
    if (registry?.has?.(`${MODULE_NS}.${SETTING_ACTIVE_FACTIONS}`) !== true) {
      settings.register(MODULE_NS, SETTING_ACTIVE_FACTIONS, {
        name: 'TimelineV2: Active Factions (client)',
        hint: 'Internal selection of factions considered "mine"',
        scope: 'client',
        config: false,
        type: Object,
        default: { mode: 'auto', uuids: [] },
      });
    }

    if (registry?.has?.(`${MODULE_NS}.${SETTING_HIDE_UNKNOWN}`) !== true) {
      settings.register(MODULE_NS, SETTING_HIDE_UNKNOWN, {
        name: 'TimelineV2: Hide Unknown (client)',
        hint: 'Hide unknown events for other factions',
        scope: 'client',
        config: false,
        type: Boolean,
        default: false,
      });
    }

    if (registry?.has?.(`${MODULE_NS}.${SETTING_ZOOM}`) !== true) {
      settings.register(MODULE_NS, SETTING_ZOOM, {
        name: 'TimelineV2: Zoom (client)',
        hint: 'Timeline zoom level',
        scope: 'client',
        config: false,
        type: Number,
        default: 1,
      });
    }

    if (registry?.has?.(`${MODULE_NS}.${SETTING_PINNED_EVENTS}`) !== true) {
      settings.register(MODULE_NS, SETTING_PINNED_EVENTS, {
        name: 'TimelineV2: Pinned events (client)',
        hint: 'Internal list of pinned timeline events',
        scope: 'client',
        config: false,
        type: Object,
        default: { uuids: [] },
      });
    }
  } catch (e) {
    console.error('SpaceHolder | TimelineV2: failed to register settings', e);
  }
}

// ===== Socket ensure (GM) =====

function _makeRequestId() {
  _reqSeq += 1;
  return `${Date.now()}-${game.user?.id || 'user'}-${_reqSeq}`;
}

function _sendSocket(message) {
  try {
    game.socket.emit(_socketName(), message);
    return true;
  } catch (e) {
    console.error('SpaceHolder | TimelineV2: socket.emit failed', e);
    return false;
  }
}

function _requestViaSocket(action, payload, { timeoutMs = 8000 } = {}) {
  const requestId = _makeRequestId();

  const msg = {
    type: SOCKET_TYPE,
    op: 'request',
    action,
    requestId,
    userId: game.user?.id,
    payload,
  };

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      _pending.delete(requestId);
      reject(new Error(`TimelineV2 socket request timed out: ${action}`));
    }, Math.max(1000, Number(timeoutMs) || 8000));

    _pending.set(requestId, { resolve, reject, timeoutId });

    const ok = _sendSocket(msg);
    if (!ok) {
      clearTimeout(timeoutId);
      _pending.delete(requestId);
      reject(new Error(`TimelineV2 socket emit failed: ${action}`));
    }
  });
}

function _handleSocketResponse(msg) {
  const requestId = String(msg?.requestId || '').trim();
  const userId = String(msg?.userId || '').trim();
  if (!requestId || !userId) return;

  // Responses are addressed to a specific userId.
  if (userId !== String(game.user?.id || '').trim()) return;

  const pending = _pending.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timeoutId);
  _pending.delete(requestId);

  if (msg?.ok) pending.resolve(msg?.payload);
  else pending.reject(new Error(String(msg?.error || 'TimelineV2 socket request failed')));
}

async function _handleSocketRequestAsGM(msg) {
  const action = String(msg?.action || '').trim();
  const requestId = String(msg?.requestId || '').trim();
  const userId = String(msg?.userId || '').trim();

  const reply = (ok, payload = null, error = null) => {
    _sendSocket({
      type: SOCKET_TYPE,
      op: 'response',
      action,
      requestId,
      userId,
      ok: !!ok,
      payload,
      error: error ? String(error) : null,
    });
  };

  try {
    if (!requestId || !userId) return;

    if (action === 'ensure') {
      const factionUuids = Array.isArray(msg?.payload?.factionUuids) ? msg.payload.factionUuids : [];
      await gmEnsureTimelineV2Containers({ factionUuids });
      reply(true, { ok: true });
      return;
    }

    if (action === 'createIndex') {
      const requester = game?.users?.get?.(userId) ?? null;
      if (!requester) {
        reply(false, null, 'requester not found');
        return;
      }

      const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

      const detailUuid = normalizeUuid(msg?.payload?.detailUuid);
      const detailPage = await resolveTimelineV2Page(detailUuid);
      if (!detailPage || !isTimelineV2DetailPage(detailPage)) {
        reply(false, null, 'detail page not found');
        return;
      }

      // Prevent players from creating world-only (no faction) events.
      const detailData = getTimelineV2PageData(detailPage);
      if (!detailData?.isDetail) {
        reply(false, null, 'expected detail page');
        return;
      }

      if (!detailData.factionUuid && !requester.isGM) {
        reply(false, null, 'faction is required');
        return;
      }

      // Allow only owners of the detail page to publish it into the world index.
      const canEdit = requester.isGM || detailPage.testUserPermission?.(requester, OWN);
      if (!canEdit) {
        reply(false, null, 'no permission');
        return;
      }

      // If already linked, return the existing index UUID.
      if (detailData.indexUuid) {
        const existingIndex = await resolveTimelineV2Page(detailData.indexUuid);
        if (existingIndex && isTimelineV2IndexPage(existingIndex)) {
          reply(true, { indexUuid: existingIndex.uuid });
          return;
        }
      }

      // Ensure world container exists.
      let world = getTimelineV2Container({ kind: TIMELINE_V2_CONTAINER_KIND.WORLD });
      if (!world) {
        await _gmEnsureTimelineV2Folder();
        world = await _gmUpsertContainer({ kind: TIMELINE_V2_CONTAINER_KIND.WORLD });
      }

      if (!world) {
        reply(false, null, 'world container not found');
        return;
      }

      const flagsIndex = {
        [MODULE_NS]: {
          [FLAG_ROOT]: {
            schema: 2,
            isIndex: true,
            year: detailData.year,
            month: detailData.month,
            day: detailData.day,
            factionUuid: detailData.factionUuid,
            origin: detailData.origin,
            iconPath: _normalizeIconPath(detailData.iconPath),
            hasDuration: !!detailData.hasDuration,
            durationDays: detailData.hasDuration ? detailData.durationDays : undefined,
            isGlobal: !!detailData.isGlobal,
            isHidden: !!detailData.isHidden,
            detailUuid: detailPage.uuid,
          },
        },
      };

      const indexData = {
        name: '(событие)',
        type: 'text',
        text: { content: '' },
        flags: flagsIndex,
      };

      const createdIndexArr = await world.createEmbeddedDocuments('JournalEntryPage', [indexData], { spaceholderJournalCheck: true });
      const indexPage = createdIndexArr?.[0] ?? null;
      if (!indexPage) {
        reply(false, null, 'failed to create index page');
        return;
      }

      // Link back (best-effort)
      try {
        const f = { ..._getFlagObj(detailPage) };
        f.indexUuid = indexPage.uuid;
        await detailPage.update({ [`flags.${MODULE_NS}.${FLAG_ROOT}`]: f }, { diff: false, spaceholderJournalCheck: true });
      } catch (_) {
        // ignore
      }

      reply(true, { indexUuid: indexPage.uuid });
      return;
    }

    if (action === 'updateDate') {
      const requester = game?.users?.get?.(userId) ?? null;
      if (!requester) {
        reply(false, null, 'requester not found');
        return;
      }

      const indexUuid = normalizeUuid(msg?.payload?.indexUuid);
      const year = msg?.payload?.year;
      const month = msg?.payload?.month;
      const day = msg?.payload?.day;

      const indexPage = await resolveTimelineV2Page(indexUuid);
      if (!indexPage) {
        reply(false, null, 'index page not found');
        return;
      }

      const t = getTimelineV2PageData(indexPage);
      if (!t.isIndex) {
        reply(false, null, 'expected index page');
        return;
      }

      const detailPage = await resolveTimelineV2DetailFromIndex(indexPage);
      if (!detailPage) {
        reply(false, null, 'detail page not found');
        return;
      }

      const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
      const canEdit = requester.isGM || detailPage.testUserPermission?.(requester, OWN);
      if (!canEdit) {
        reply(false, null, 'no permission');
        return;
      }

      const y = _normalizeYear(year);
      const m = _normalizeMonth(month);
      const d = _normalizeDay(day);

      await _updateTimelineV2PageDate(indexPage, { year: y, month: m, day: d });
      await _updateTimelineV2PageDate(detailPage, { year: y, month: m, day: d });

      reply(true, { ok: true });
      return;
    }

    if (action === 'updateMeta') {
      const requester = game?.users?.get?.(userId) ?? null;
      if (!requester) {
        reply(false, null, 'requester not found');
        return;
      }

      const indexUuid = normalizeUuid(msg?.payload?.indexUuid);
      const iconPath = msg?.payload?.iconPath;
      const hasDuration = msg?.payload?.hasDuration;
      const durationDays = msg?.payload?.durationDays;

      const indexPage = await resolveTimelineV2Page(indexUuid);
      if (!indexPage) {
        reply(false, null, 'index page not found');
        return;
      }

      const t = getTimelineV2PageData(indexPage);
      if (!t.isIndex) {
        reply(false, null, 'expected index page');
        return;
      }

      const detailPage = await resolveTimelineV2DetailFromIndex(indexPage);
      if (!detailPage) {
        reply(false, null, 'detail page not found');
        return;
      }

      const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
      const canEdit = requester.isGM || detailPage.testUserPermission?.(requester, OWN);
      if (!canEdit) {
        reply(false, null, 'no permission');
        return;
      }

      const hd = !!hasDuration;
      const dd = _normalizeDurationDays(durationDays);

      if (hd && !(dd > 0)) {
        reply(false, null, 'invalid duration');
        return;
      }

      await _updateTimelineV2PageMeta(indexPage, { iconPath, hasDuration: hd, durationDays: dd });
      await _updateTimelineV2PageMeta(detailPage, { iconPath, hasDuration: hd, durationDays: dd });

      reply(true, { ok: true });
      return;
    }

    if (action === 'deleteEvent') {
      const requester = game?.users?.get?.(userId) ?? null;
      if (!requester) {
        reply(false, null, 'requester not found');
        return;
      }

      const indexUuid = normalizeUuid(msg?.payload?.indexUuid);

      const indexPage = await resolveTimelineV2Page(indexUuid);
      if (!indexPage) {
        reply(false, null, 'index page not found');
        return;
      }

      const t = getTimelineV2PageData(indexPage);
      if (!t.isIndex) {
        reply(false, null, 'expected index page');
        return;
      }

      const detailPage = await resolveTimelineV2DetailFromIndex(indexPage);
      if (!detailPage) {
        reply(false, null, 'detail page not found');
        return;
      }

      const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
      const canEdit = requester.isGM || detailPage.testUserPermission?.(requester, OWN);
      if (!canEdit) {
        reply(false, null, 'no permission');
        return;
      }

      const okIndex = await _deleteTimelineV2EmbeddedPage(indexPage);
      if (!okIndex) {
        reply(false, null, 'failed to delete index page');
        return;
      }

      const okDetail = await _deleteTimelineV2EmbeddedPage(detailPage);
      if (!okDetail) {
        reply(false, null, 'failed to delete detail page');
        return;
      }

      reply(true, { ok: true });
      return;
    }

    reply(false, null, `unknown action: ${action}`);
  } catch (e) {
    console.error('SpaceHolder | TimelineV2: GM socket handler failed', e);
    reply(false, null, e?.message || e);
  }
}

export function installTimelineV2SocketHandlers() {
  if (_socketInstalled) return;
  _socketInstalled = true;

  const name = _socketName();

  if (!game?.socket?.on) {
    console.warn('SpaceHolder | TimelineV2: game.socket unavailable, cannot install socket handlers');
    return;
  }

  game.socket.on(name, async (msg) => {
    try {
      if (!msg || msg.type !== SOCKET_TYPE) return;

      if (msg.op === 'response') {
        _handleSocketResponse(msg);
        return;
      }

      if (msg.op === 'request') {
        if (!game.user?.isGM) return;
        await _handleSocketRequestAsGM(msg);
      }
    } catch (e) {
      console.error('SpaceHolder | TimelineV2: socket message handler crashed', e);
    }
  });
}

export function installTimelineV2Hooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  const invalidate = () => _invalidateContainerCache();

  Hooks.on('createJournalEntry', invalidate);
  Hooks.on('deleteJournalEntry', invalidate);
  Hooks.on('updateJournalEntry', invalidate);

  // GM: keep ownership in sync when User factions change.
  if (game.user?.isGM) {
    let t = null;
    const schedule = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        gmSyncTimelineV2OwnershipForAllFactions().catch(() => {});
      }, 300);
    };

    Hooks.on('updateUser', schedule);
    Hooks.on('createActor', (actor) => {
      if (actor?.type === 'faction') schedule();
    });
    Hooks.on('updateActor', (actor) => {
      if (actor?.type === 'faction') schedule();
    });
    Hooks.on('deleteActor', (actor) => {
      if (actor?.type === 'faction') schedule();
    });
  }
}

export async function ensureTimelineV2InfrastructureForCurrentUser() {
  // World container is always needed.
  if (game.user?.isGM) {
    await gmSyncTimelineV2OwnershipForAllFactions();
    return true;
  }

  const factions = (() => {
    try {
      return getUserFactionUuids(game.user);
    } catch (_) {
      return [];
    }
  })();

  // Player with no faction can still view global timeline, so ensure world container only.
  // We still ask GM to ensure the world container, but we also pass player factions (if any)
  // so that private detail containers exist when needed.
  try {
    await _requestViaSocket('ensure', { factionUuids: factions });
    return true;
  } catch (e) {
    console.warn('SpaceHolder | TimelineV2: ensure infrastructure failed', e);
    return false;
  }
}

// ===== Events (create) =====

export async function createTimelineV2Event({
  year,
  month,
  day,
  factionUuid = '',
  origin = TIMELINE_V2_ORIGIN.FACTION,
  isGlobal = false,
  isHidden = false,
  iconPath = '',
  hasDuration = false,
  durationDays = 0,
  title,
  content = '',
} = {}) {
  const t = String(title || '').trim();
  if (!t) throw new Error('Title is required');

  const y = _normalizeYear(year);
  const m = _normalizeMonth(month);
  const d = _normalizeDay(day);

  const fu = normalizeUuid(factionUuid);

  // World-only events (no faction) are GM-only.
  if (!fu && !game.user?.isGM) {
    throw new Error('Faction is required');
  }

  const finalOrigin = _normalizeOrigin(origin, { factionUuid: fu });

  const finalHasDuration = !!hasDuration;
  const finalDurationDays = finalHasDuration ? _normalizeDurationDays(durationDays) : 0;
  if (finalHasDuration && !(finalDurationDays > 0)) {
    throw new Error('Invalid duration');
  }

  // World-only events are always global.
  const finalIsGlobal = fu ? !!isGlobal : true;

  const world = getTimelineV2Container({ kind: TIMELINE_V2_CONTAINER_KIND.WORLD });
  if (!world) {
    throw new Error('TimelineV2 world container not found (ask GM to initialize timeline)');
  }

  const detailsContainer = (() => {
    // World-only events (no faction) live in the world container.
    if (!fu) return world;

    // Faction events:
    // - global => public faction container (everyone can view, faction can edit)
    // - private => private faction container
    if (finalIsGlobal) {
      return getTimelineV2Container({ kind: TIMELINE_V2_CONTAINER_KIND.FACTION_PUBLIC, factionUuid: fu });
    }

    return getTimelineV2Container({ kind: TIMELINE_V2_CONTAINER_KIND.FACTION_PRIVATE, factionUuid: fu });
  })();

  if (!detailsContainer) {
    throw new Error('TimelineV2 details container not found (ask GM to initialize timeline)');
  }

  // Permissions: players can only create details in containers they own.
  if (!game.user?.isGM && !canUserOwnContainer(detailsContainer, game.user)) {
    throw new Error('No permission');
  }

  const flagsDetail = {
    [MODULE_NS]: {
      [FLAG_ROOT]: {
        schema: 2,
        isDetail: true,
        year: y,
        month: m,
        day: d,
        factionUuid: fu,
        origin: finalOrigin,
        iconPath: _normalizeIconPath(iconPath),
        hasDuration: finalHasDuration && finalDurationDays > 0,
        durationDays: finalHasDuration ? finalDurationDays : undefined,
        isGlobal: finalIsGlobal,
        isHidden: !!isHidden,
      },
    },
  };

  const detailData = {
    name: t,
    type: 'text',
    text: { content: String(content || '') },
    flags: flagsDetail,
  };

  const createdDetailArr = await detailsContainer.createEmbeddedDocuments('JournalEntryPage', [detailData], { spaceholderJournalCheck: true });
  const detailPage = createdDetailArr?.[0] ?? null;
  if (!detailPage) throw new Error('Failed to create detail page');

  const flagsIndex = {
    [MODULE_NS]: {
      [FLAG_ROOT]: {
        schema: 2,
        isIndex: true,
        year: y,
        month: m,
        day: d,
        factionUuid: fu,
        origin: finalOrigin,
        iconPath: _normalizeIconPath(iconPath),
        hasDuration: finalHasDuration && finalDurationDays > 0,
        durationDays: finalHasDuration ? finalDurationDays : undefined,
        isGlobal: finalIsGlobal,
        isHidden: !!isHidden,
        detailUuid: detailPage.uuid,
      },
    },
  };

  const indexData = {
    name: '(событие)',
    type: 'text',
    text: { content: '' },
    flags: flagsIndex,
  };

  let indexPage = null;
  try {
    const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    const canWriteWorld = !!world?.testUserPermission?.(game.user, OWN);

    if (game.user?.isGM || canWriteWorld) {
      const createdIndexArr = await world.createEmbeddedDocuments('JournalEntryPage', [indexData], { spaceholderJournalCheck: true });
      indexPage = createdIndexArr?.[0] ?? null;
    } else {
      // Fallback: if world container is GM-owned, publish via socket.
      const res = await _requestViaSocket('createIndex', { detailUuid: detailPage.uuid }, { timeoutMs: 12000 });
      const indexUuid = normalizeUuid(res?.indexUuid);
      if (!indexUuid) throw new Error('Failed to create index page');

      // Index page propagation to clients can be asynchronous; don't hard-fail if it isn't resolvable yet.
      indexPage = await resolveTimelineV2Page(indexUuid);
      if (!indexPage) indexPage = { uuid: indexUuid };
    }
  } catch (e) {
    // Rollback best-effort
    try {
      await detailsContainer.deleteEmbeddedDocuments('JournalEntryPage', [detailPage.id], { spaceholderJournalCheck: true });
    } catch (_) {
      // ignore
    }
    throw e;
  }

  if (!indexPage) {
    // Rollback best-effort
    try {
      await detailsContainer.deleteEmbeddedDocuments('JournalEntryPage', [detailPage.id], { spaceholderJournalCheck: true });
    } catch (_) {
      // ignore
    }
    throw new Error('Failed to create index page');
  }

  // Link back (best-effort)
  try {
    const f = { ..._getFlagObj(detailPage) };
    f.indexUuid = indexPage.uuid;
    await detailPage.update({ [`flags.${MODULE_NS}.${FLAG_ROOT}`]: f }, { diff: false, spaceholderJournalCheck: true });
  } catch (_) {
    // ignore
  }

  return { indexPage, detailPage };
}

// ===== Helper: parse list strings (re-export) =====

export function parseUuidList(raw) {
  return parseFactionUuidList(raw);
}

/**
 * LEGACY MODULE: Deprecated in favor of timeline-v2.mjs
 * This module is kept for backward compatibility only.
 * New development should use the V2 timeline system.
 */

// Timeline (SpaceHolder)
// Storage: JournalEntry containers + JournalEntryPage entries.
// - World (Public)
// - Faction (Private)
// - Faction (Public)
// Ordering: year ASC, id ASC (id is an integer sort key per year; values are sparse to allow insert-between reordering).

import { getUserFactionUuids, getUsersForFaction, normalizeUuid as normalizeUuidUserFactions } from './user-factions.mjs';

const MODULE_NS = 'spaceholder';
const FLAG_ROOT = 'timeline';

// Sparse integer step for ordering inside a year.
export const TIMELINE_ORDER_STEP = 1000;

const SETTING_NEXT_ID_BY_YEAR = 'timeline.nextIdByYear';
const SETTING_ORDERING_VERSION = 'timeline.orderingVersion';
const ORDERING_VERSION = 2;

const SOCKET_TYPE = `${MODULE_NS}.timeline`;

export const TIMELINE_CONTAINER_KIND = {
  WORLD_PUBLIC: 'worldPublic',
  FACTION_PRIVATE: 'factionPrivate',
  FACTION_PUBLIC: 'factionPublic',
};

export const TIMELINE_ORIGIN = {
  WORLD: 'world',
  FACTION: 'faction',
};

let _socketInstalled = false;
let _hooksInstalled = false;

// Request/response (client-side)
let _reqSeq = 0;
const _pending = new Map(); // requestId -> {resolve,reject,timeoutId}

// GM-side allocation queue per year
const _allocQueueByYear = new Map(); // year -> Promise

// Cache containers by key
const _containerCache = new Map(); // key -> JournalEntry

// Dedicated folder for timeline containers (no migration of existing documents)
const TIMELINE_FOLDER_NAME = 'SpaceHolder Timeline';
let _timelineFolderId = null;

function _socketName() {
  try {
    return `system.${game.system.id}`;
  } catch (_) {
    return `system.${MODULE_NS}`;
  }
}

export function normalizeUuid(raw) {
  // Delegate to the shared helper so @UUID[...] is supported consistently.
  return normalizeUuidUserFactions(raw);
}

function _getFlagObj(doc) {
  try {
    return doc?.getFlag?.(MODULE_NS, FLAG_ROOT) ?? doc?.flags?.[MODULE_NS]?.[FLAG_ROOT] ?? {};
  } catch (_) {
    return {};
  }
}

function _isTimelineFolder(folder) {
  const f = _getFlagObj(folder);
  return !!f?.isFolder;
}

function _findTimelineFolderInWorld() {
  if (_timelineFolderId) {
    const cached = game?.folders?.get?.(_timelineFolderId) ?? null;
    if (cached && _isTimelineFolder(cached)) return cached;
    _timelineFolderId = null;
  }

  const folders = Array.isArray(game?.folders?.contents) ? game.folders.contents : [];
  for (const folder of folders) {
    if (!folder?.id) continue;
    if (folder.type !== 'JournalEntry') continue;
    if (!_isTimelineFolder(folder)) continue;
    _timelineFolderId = folder.id;
    return folder;
  }

  return null;
}

async function _gmEnsureTimelineFolder() {
  if (!game?.user?.isGM) return null;

  const existing = _findTimelineFolderInWorld();
  if (existing) return existing;

  const flags = {
    [MODULE_NS]: {
      [FLAG_ROOT]: {
        isFolder: true,
      },
    },
  };

  const data = {
    name: TIMELINE_FOLDER_NAME,
    type: 'JournalEntry',
    flags,
  };

  const FolderClass = globalThis.Folder ?? game?.folders?.documentClass;
  if (!FolderClass?.create) {
    console.error('SpaceHolder | Timeline: Folder class unavailable');
    return null;
  }

  const created = await FolderClass.create(data, { render: false, spaceholderJournalCheck: true });
  _timelineFolderId = created?.id ?? null;
  return created;
}

export function isTimelineContainer(entry) {
  const f = _getFlagObj(entry);
  return !!f?.isContainer;
}

export function isTimelineEntryPage(page) {
  const f = _getFlagObj(page);
  return !!f?.isEntry;
}

export function getTimelineContainerKind(entry) {
  const f = _getFlagObj(entry);
  return String(f?.containerKind ?? '').trim() || null;
}

export function getTimelineContainerFactionUuid(entry) {
  const f = _getFlagObj(entry);
  return normalizeUuid(f?.factionUuid);
}

export function getTimelineEntryData(page) {
  const f = _getFlagObj(page);
  const yearRaw = Number.parseInt(f?.year, 10);
  const idRaw = Number.parseInt(f?.id, 10);

  const year = Number.isFinite(yearRaw) && yearRaw > 0 ? yearRaw : 1;
  const id = Number.isFinite(idRaw) && idRaw > 0 ? idRaw : 0;

  const origin = String(f?.origin ?? '').trim();
  const factionUuid = normalizeUuid(f?.factionUuid);
  const isGlobal = !!f?.isGlobal;
  const isHidden = !!f?.isHidden;

  return { year, id, origin, factionUuid, isGlobal, isHidden };
}

function _containerKey(kind, factionUuid = '') {
  return `${String(kind || '').trim()}::${normalizeUuid(factionUuid)}`;
}

function _invalidateContainerCache() {
  _containerCache.clear();
}

function _findContainerInWorld({ kind, factionUuid = '' }) {
  const key = _containerKey(kind, factionUuid);
  if (_containerCache.has(key)) {
    const cached = _containerCache.get(key);
    // Ensure it still exists
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

  if (kind === TIMELINE_CONTAINER_KIND.WORLD_PUBLIC) return 'Spaceholder Timeline: World (Public)';
  if (kind === TIMELINE_CONTAINER_KIND.FACTION_PRIVATE) return `Spaceholder Timeline: Faction ${suffix} (Private)`;
  if (kind === TIMELINE_CONTAINER_KIND.FACTION_PUBLIC) return `Spaceholder Timeline: Faction ${suffix} (Public)`;
  return `Spaceholder Timeline: ${kind}`;
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

function _worldOnlyPageOwnership({ isGlobal = false } = {}) {
  const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const OBS = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
  const NONE = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0;

  const out = { default: isGlobal ? OBS : NONE };

  // GMs always own
  const users = Array.from(game?.users?.values?.() ?? game?.users?.contents ?? []);
  for (const u of users) {
    if (!u?.id) continue;
    if (u.isGM) out[u.id] = OWN;
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

  const OBS = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
  const NONE = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0;

  const ownerIds = (() => {
    if (kind === TIMELINE_CONTAINER_KIND.WORLD_PUBLIC) return [];
    if (!fu) return [];
    return getUsersForFaction(fu).map((u) => u?.id).filter(Boolean);
  })();

  const defaultLevel = (() => {
    if (kind === TIMELINE_CONTAINER_KIND.FACTION_PRIVATE) return NONE;
    return OBS; // worldPublic + factionPublic
  })();

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
    // Existing containers are not migrated.
    let folder = _findTimelineFolderInWorld();
    if (!folder) {
      await _gmEnsureTimelineFolder();
      folder = _findTimelineFolderInWorld();
    }

    const data = {
      name,
      folder: folder?.id ?? null,
      ownership: desiredOwnership,
      flags,
    };

    const DocClass = globalThis.JournalEntry ?? game?.journal?.documentClass;
    if (!DocClass?.create) {
      console.error('SpaceHolder | Timeline: JournalEntry class unavailable');
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

  // Ownership sync (diff is cheap)
  patch.ownership = desiredOwnership;

  if (Object.keys(patch).length) {
    await existing.update(patch, { diff: false, spaceholderJournalCheck: true });
  }

  _containerCache.set(_containerKey(kind, fu), existing);
  return existing;
}

export async function gmEnsureTimelineContainers({ factionUuids = [] } = {}) {
  if (!game?.user?.isGM) return false;

  // Create (or find) a dedicated folder for timeline containers.
  await _gmEnsureTimelineFolder();

  await _gmUpsertContainer({ kind: TIMELINE_CONTAINER_KIND.WORLD_PUBLIC });

  const uuids = Array.isArray(factionUuids) ? factionUuids : [];
  for (const raw of uuids) {
    const fu = normalizeUuid(raw);
    if (!fu) continue;
    await _gmUpsertContainer({ kind: TIMELINE_CONTAINER_KIND.FACTION_PRIVATE, factionUuid: fu });
    await _gmUpsertContainer({ kind: TIMELINE_CONTAINER_KIND.FACTION_PUBLIC, factionUuid: fu });
  }

  return true;
}

export async function gmSyncTimelineOwnershipForAllFactions() {
  if (!game?.user?.isGM) return false;

  // Ensure containers for all existing factions
  const factionActors = Array.from(game?.actors?.values?.() ?? game?.actors?.contents ?? [])
    .filter((a) => a?.type === 'faction');

  const factionUuids = factionActors.map((a) => a.uuid).filter(Boolean);
  await gmEnsureTimelineContainers({ factionUuids });
  return true;
}

async function _gmComputeMaxIdForYear(year) {
  const y = Number(year) || 1;
  const entries = Array.isArray(game?.journal?.contents) ? game.journal.contents : [];

  let maxId = 0;

  for (const entry of entries) {
    if (!entry?.id) continue;
    const ef = _getFlagObj(entry);
    if (!ef?.isContainer) continue;

    const pages = entry?.pages?.contents ?? [];
    for (const page of pages) {
      if (!page?.id) continue;
      const pf = _getFlagObj(page);
      if (!pf?.isEntry) continue;

      const pyRaw = Number.parseInt(pf?.year, 10);
      const py = Number.isFinite(pyRaw) && pyRaw > 0 ? pyRaw : 1;
      if (py !== y) continue;

      const pidRaw = Number.parseInt(pf?.id, 10);
      const pid = Number.isFinite(pidRaw) && pidRaw > 0 ? pidRaw : 0;
      if (pid > maxId) maxId = pid;
    }
  }

  return maxId;
}

function _getNextIdMapSafe() {
  try {
    const raw = game.settings.get(MODULE_NS, SETTING_NEXT_ID_BY_YEAR);
    return (raw && typeof raw === 'object') ? raw : {};
  } catch (_) {
    return {};
  }
}

async function _setNextIdMapSafe(map) {
  try {
    await game.settings.set(MODULE_NS, SETTING_NEXT_ID_BY_YEAR, map);
    return true;
  } catch (e) {
    console.error('SpaceHolder | Timeline: failed to persist nextIdByYear setting', e);
    return false;
  }
}

function _getOrderingVersionSafe() {
  try {
    const raw = game.settings.get(MODULE_NS, SETTING_ORDERING_VERSION);
    const v = Number.parseInt(raw, 10);
    return Number.isFinite(v) ? v : 0;
  } catch (_) {
    return 0;
  }
}

async function _setOrderingVersionSafe(version) {
  try {
    await game.settings.set(MODULE_NS, SETTING_ORDERING_VERSION, Number(version) || 0);
    return true;
  } catch (e) {
    console.error('SpaceHolder | Timeline: failed to persist orderingVersion setting', e);
    return false;
  }
}

async function _gmAllocateNextId(year) {
  if (!game?.user?.isGM) return null;

  const yRaw = Number.parseInt(year, 10);
  const y = Number.isFinite(yRaw) && yRaw > 0 ? yRaw : 1;
  const key = String(y);

  const prev = _allocQueueByYear.get(key) ?? Promise.resolve();

  const nextP = prev.then(async () => {
    const map = { ..._getNextIdMapSafe() };

    const curRaw = Number.parseInt(map[key], 10);
    const hasCur = Number.isFinite(curRaw) && curRaw > 0;

    let last = curRaw;
    if (!hasCur) {
      // First time for this year: initialize from existing data
      last = await _gmComputeMaxIdForYear(y);
    }

    const nextId = Math.max(0, Number(last) || 0) + TIMELINE_ORDER_STEP;
    map[key] = nextId;

    await _setNextIdMapSafe(map);
    return nextId;
  });

  _allocQueueByYear.set(key, nextP.catch(() => {}));
  return nextP;
}

function _makeRequestId() {
  _reqSeq += 1;
  return `${Date.now()}-${game.user?.id || 'user'}-${_reqSeq}`;
}

function _sendSocket(message) {
  try {
    game.socket.emit(_socketName(), message);
    return true;
  } catch (e) {
    console.error('SpaceHolder | Timeline: socket.emit failed', e);
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
      reject(new Error(`Timeline socket request timed out: ${action}`));
    }, Math.max(1000, Number(timeoutMs) || 8000));

    _pending.set(requestId, { resolve, reject, timeoutId });

    const ok = _sendSocket(msg);
    if (!ok) {
      clearTimeout(timeoutId);
      _pending.delete(requestId);
      reject(new Error(`Timeline socket emit failed: ${action}`));
    }
  });
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

    if (action === 'nextId') {
      const y = msg?.payload?.year;
      const id = await _gmAllocateNextId(y);
      if (!id) {
        reply(false, null, 'failed to allocate id');
        return;
      }
      reply(true, { id });
      return;
    }

    if (action === 'ensure') {
      const factionUuids = Array.isArray(msg?.payload?.factionUuids) ? msg.payload.factionUuids : [];
      // Always ensure world container
      await gmEnsureTimelineContainers({ factionUuids });

      // Best-effort migrations (cheap when already applied).
      try {
        await _gmMigrateTimelinePagesToNewRules();
      } catch (_) {
        // ignore
      }
      try {
        await _gmMigrateTimelineOrderingToSparseIds();
      } catch (_) {
        // ignore
      }

      reply(true, { ok: true });
      return;
    }

    reply(false, null, `unknown action: ${action}`);
  } catch (e) {
    console.error('SpaceHolder | Timeline: GM socket handler failed', e);
    reply(false, null, e?.message || e);
  }
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
  else pending.reject(new Error(String(msg?.error || 'Timeline socket request failed')));
}

export function registerTimelineSettings() {
  const settings = game?.settings;
  const registry = settings?.settings;

  try {
    if (registry?.has?.(`${MODULE_NS}.${SETTING_NEXT_ID_BY_YEAR}`) !== true) {
      settings.register(MODULE_NS, SETTING_NEXT_ID_BY_YEAR, {
        name: 'Timeline: Next ID By Year',
        hint: 'Internal counter for timeline ordering',
        scope: 'world',
        config: false,
        type: Object,
        default: {},
        restricted: true,
      });
    }

    if (registry?.has?.(`${MODULE_NS}.${SETTING_ORDERING_VERSION}`) !== true) {
      settings.register(MODULE_NS, SETTING_ORDERING_VERSION, {
        name: 'Timeline: Ordering Version',
        hint: 'Internal migration version for timeline ordering',
        scope: 'world',
        config: false,
        type: Number,
        default: 0,
        restricted: true,
      });
    }
  } catch (e) {
    console.error('SpaceHolder | Timeline: failed to register settings', e);
  }
}

export function installTimelineSocketHandlers() {
  if (_socketInstalled) return;
  _socketInstalled = true;

  const name = _socketName();

  if (!game?.socket?.on) {
    console.warn('SpaceHolder | Timeline: game.socket unavailable, cannot install socket handlers');
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
      console.error('SpaceHolder | Timeline: socket message handler crashed', e);
    }
  });
}

export function installTimelineHooks() {
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
        gmSyncTimelineOwnershipForAllFactions().catch(() => {});
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

export async function ensureTimelineInfrastructureForCurrentUser() {
  const factions = getUserFactionUuids(game.user);

  // GM: we can ensure all factions opportunistically.
  if (game.user?.isGM) {
    await gmSyncTimelineOwnershipForAllFactions();

    // Migration (best-effort): faction-bound "world" entries should inherit container permissions,
    // and world-only entries in World container should have consistent isGlobal/ownership.
    try {
      await _gmMigrateTimelinePagesToNewRules();
    } catch (e) {
      console.warn('SpaceHolder | Timeline: migration failed', e);
    }

    // Ordering migration: convert legacy small sequential ids to sparse values.
    try {
      await _gmMigrateTimelineOrderingToSparseIds();
    } catch (e) {
      console.warn('SpaceHolder | Timeline: ordering migration failed', e);
    }

    return true;
  }

  if (!factions.length) return false;

  try {
    await _requestViaSocket('ensure', { factionUuids: factions });
    return true;
  } catch (e) {
    console.warn('SpaceHolder | Timeline: ensure infrastructure failed', e);
    return false;
  }
}

export async function requestNextTimelineId(year) {
  const yRaw = Number.parseInt(year, 10);
  const y = Number.isFinite(yRaw) && yRaw > 0 ? yRaw : 1;

  if (game.user?.isGM) {
    const id = await _gmAllocateNextId(y);
    return Number(id) || TIMELINE_ORDER_STEP;
  }

  const payload = await _requestViaSocket('nextId', { year: y });
  const idRaw = Number.parseInt(payload?.id, 10);
  return Number.isFinite(idRaw) && idRaw > 0 ? idRaw : TIMELINE_ORDER_STEP;
}

export function getTimelineContainer({ kind, factionUuid = '' }) {
  return _findContainerInWorld({ kind, factionUuid });
}

export function listTimelineContainers({ kind = null } = {}) {
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

export function listTimelinePagesInContainer(entry) {
  const pages = entry?.pages?.contents ?? [];
  return pages.filter((p) => p?.id && isTimelineEntryPage(p));
}

async function _gmMigrateTimelinePagesToNewRules() {
  if (!game?.user?.isGM) return false;

  const containers = listTimelineContainers();

  for (const entry of containers) {
    if (!entry?.id) continue;
    const kind = getTimelineContainerKind(entry);
    if (!kind) continue;

    const pages = listTimelinePagesInContainer(entry);
    for (const page of pages) {
      if (!page?.id) continue;

      const t = getTimelineEntryData(page);
      const flags = { ..._getFlagObj(page) };

      const patch = {};
      let flagsChanged = false;

      // World container: older entries might miss isGlobal (assume true for backward compatibility).
      if (kind === TIMELINE_CONTAINER_KIND.WORLD_PUBLIC) {
        if (flags.isGlobal === undefined) {
          flags.isGlobal = true;
          flagsChanged = true;
        }

        // Private world-only entries must not be visible to players.
        if (flags.isGlobal === false) {
          patch.ownership = _worldOnlyPageOwnership({ isGlobal: false });
        }
      }

      // Faction containers: old "world" entries used GM-only ownership. They should inherit container ownership now.
      if (kind === TIMELINE_CONTAINER_KIND.FACTION_PUBLIC || kind === TIMELINE_CONTAINER_KIND.FACTION_PRIVATE) {
        const desiredGlobal = (kind === TIMELINE_CONTAINER_KIND.FACTION_PUBLIC);
        if (flags.isGlobal !== desiredGlobal) {
          flags.isGlobal = desiredGlobal;
          flagsChanged = true;
        }

        if (t.origin === TIMELINE_ORIGIN.WORLD && t.factionUuid) {
          patch.ownership = foundry.utils.deepClone(entry.ownership);
        }
      }

      if (flagsChanged) {
        patch[`flags.${MODULE_NS}.${FLAG_ROOT}`] = flags;
      }

      if (Object.keys(patch).length) {
        await page.update(patch, { diff: false, spaceholderJournalCheck: true });
      }
    }
  }

  return true;
}

async function _gmMigrateTimelineOrderingToSparseIds() {
  if (!game?.user?.isGM) return false;

  const currentVersion = _getOrderingVersionSafe();
  if (currentVersion >= ORDERING_VERSION) return false;

  const containers = listTimelineContainers();
  const byYear = new Map();

  for (const entry of containers) {
    if (!entry?.id) continue;

    const pages = listTimelinePagesInContainer(entry);
    for (const page of pages) {
      if (!page?.id) continue;
      const t = getTimelineEntryData(page);
      const y = Number(t.year) || 1;
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(page);
    }
  }

  const nextMap = { ..._getNextIdMapSafe() };

  for (const [year, pages] of byYear.entries()) {
    pages.sort((a, b) => {
      const ta = getTimelineEntryData(a);
      const tb = getTimelineEntryData(b);

      if (ta.year !== tb.year) return ta.year - tb.year;
      if (ta.id !== tb.id) return ta.id - tb.id;

      return String(a.uuid).localeCompare(String(b.uuid));
    });

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const flags = { ..._getFlagObj(page) };
      flags.id = (i + 1) * TIMELINE_ORDER_STEP;

      await page.update({
        [`flags.${MODULE_NS}.${FLAG_ROOT}`]: flags,
      }, { diff: false, spaceholderJournalCheck: true });
    }

    nextMap[String(year)] = pages.length * TIMELINE_ORDER_STEP;
  }

  await _setNextIdMapSafe(nextMap);
  await _setOrderingVersionSafe(ORDERING_VERSION);

  return true;
}

export async function createTimelineEntry({
  origin,
  factionUuid = '',
  isGlobal = false,
  isHidden = false,
  year,
  title,
  content = '',
}) {
  const oRaw = String(origin || '').trim();
  const o = (oRaw === TIMELINE_ORIGIN.WORLD) ? TIMELINE_ORIGIN.WORLD : TIMELINE_ORIGIN.FACTION;

  const fu = normalizeUuid(factionUuid);

  const yRaw = Number.parseInt(year, 10);
  const y = Number.isFinite(yRaw) && yRaw > 0 ? yRaw : 1;

  // World-only entries (no factionUuid) can only be created by GM and must be origin=world.
  if (!fu) {
    if (!game.user?.isGM) {
      throw new Error('Faction is required for timeline entry');
    }
    if (o !== TIMELINE_ORIGIN.WORLD) {
      throw new Error('World-only timeline entry must be origin=world');
    }
  }

  // Faction-origin entries must always be tied to a faction.
  if (o === TIMELINE_ORIGIN.FACTION && !fu) {
    throw new Error('Faction is required for timeline entry');
  }

  const id = await requestNextTimelineId(y);

  const containerKind = (() => {
    // World-only (no faction): stored in World container.
    if (!fu) return TIMELINE_CONTAINER_KIND.WORLD_PUBLIC;

    // Faction-bound (private/public) regardless of origin label.
    return isGlobal ? TIMELINE_CONTAINER_KIND.FACTION_PUBLIC : TIMELINE_CONTAINER_KIND.FACTION_PRIVATE;
  })();

  const containerFactionUuid = fu || '';

  const container = getTimelineContainer({ kind: containerKind, factionUuid: containerFactionUuid });
  if (!container) {
    throw new Error('Timeline container not found (ask GM to initialize timeline)');
  }

  const finalIsGlobal = (containerKind === TIMELINE_CONTAINER_KIND.FACTION_PUBLIC)
    ? true
    : (containerKind === TIMELINE_CONTAINER_KIND.FACTION_PRIVATE)
      ? false
      : !!isGlobal;

  const flags = {
    [MODULE_NS]: {
      [FLAG_ROOT]: {
        isEntry: true,
        year: y,
        id,
        origin: o,
        factionUuid: fu,
        isGlobal: finalIsGlobal,
        isHidden: !!isHidden,
      },
    },
  };

  const pageData = {
    name: String(title || '').trim() || '(без названия)',
    type: 'text',
    text: { content: String(content || '') },
    flags,
    ...(!fu ? { ownership: _worldOnlyPageOwnership({ isGlobal: finalIsGlobal }) } : {}),
  };

  const created = await container.createEmbeddedDocuments('JournalEntryPage', [pageData], { spaceholderJournalCheck: true });
  return created?.[0] ?? null;
}

export async function updateTimelineEntryPage(page, { year = null, title = null, content = null } = {}) {
  if (!page) return null;

  const cur = getTimelineEntryData(page);

  const update = {};
  const flagsUpdate = { ..._getFlagObj(page) };

  let nextYear = cur.year;
  if (year !== null && year !== undefined) {
    const yRaw = Number.parseInt(year, 10);
    if (Number.isFinite(yRaw) && yRaw > 0) {
      nextYear = yRaw;
      flagsUpdate.year = yRaw;
    }
  }

  // If year changed, allocate new id
  if (nextYear !== cur.year) {
    const nextId = await requestNextTimelineId(nextYear);
    flagsUpdate.id = nextId;
  }

  if (title !== null && title !== undefined) {
    const t = String(title || '').trim();
    if (t) update.name = t;
  }

  if (content !== null && content !== undefined) {
    update.text = { ...(page.text || {}), content: String(content || '') };
  }

  update[`flags.${MODULE_NS}.${FLAG_ROOT}`] = flagsUpdate;

  await page.update(update, { diff: false, spaceholderJournalCheck: true });
  return page;
}

export async function setTimelineEntryHidden(page, hidden) {
  if (!page) return false;

  const flags = { ..._getFlagObj(page) };
  flags.isHidden = !!hidden;

  await page.update({ [`flags.${MODULE_NS}.${FLAG_ROOT}`]: flags }, { diff: false, spaceholderJournalCheck: true });
  return true;
}

export async function setTimelineEntryGlobal(page, isGlobal) {
  if (!page) return null;

  const desired = !!isGlobal;
  const entryData = getTimelineEntryData(page);

  // Faction-bound entries: move between Private/Public containers.
  if (entryData.factionUuid) {
    const kind = getTimelineContainerKind(page.parent);
    const curGlobal = (kind === TIMELINE_CONTAINER_KIND.FACTION_PUBLIC);

    if (desired === curGlobal) return page;

    const toKind = desired ? TIMELINE_CONTAINER_KIND.FACTION_PUBLIC : TIMELINE_CONTAINER_KIND.FACTION_PRIVATE;
    return await moveTimelineEntryBetweenContainers(page, { toKind, factionUuid: entryData.factionUuid });
  }

  // World-only entries: stay in World container, update flag + ownership.
  const flags = { ..._getFlagObj(page) };
  flags.isGlobal = desired;

  await page.update({
    [`flags.${MODULE_NS}.${FLAG_ROOT}`]: flags,
    ownership: _worldOnlyPageOwnership({ isGlobal: desired }),
  }, { diff: false, spaceholderJournalCheck: true });

  return page;
}

export async function setTimelineEntryOrder(page, order) {
  if (!page) return false;

  const n = Number.parseInt(order, 10);
  if (!Number.isFinite(n) || n <= 0) return false;

  const flags = { ..._getFlagObj(page) };
  flags.id = n;

  await page.update({ [`flags.${MODULE_NS}.${FLAG_ROOT}`]: flags }, { diff: false, spaceholderJournalCheck: true });
  return true;
}

export async function renormalizeTimelineEntryOrders(pages, { year = null, orderStep = TIMELINE_ORDER_STEP } = {}) {
  const list = Array.isArray(pages) ? pages.filter((p) => p?.id) : [];
  if (!list.length) return false;

  const y = (year === null || year === undefined) ? null : (Number(year) || 1);

  const sameYear = y
    ? list.filter((p) => getTimelineEntryData(p).year === y)
    : list;

  sameYear.sort((a, b) => {
    const ta = getTimelineEntryData(a);
    const tb = getTimelineEntryData(b);

    if (ta.year !== tb.year) return ta.year - tb.year;
    if (ta.id !== tb.id) return ta.id - tb.id;

    return String(a.uuid).localeCompare(String(b.uuid));
  });

  for (let i = 0; i < sameYear.length; i++) {
    const page = sameYear[i];
    const flags = { ..._getFlagObj(page) };
    flags.id = (i + 1) * (Number(orderStep) || TIMELINE_ORDER_STEP);

    await page.update({
      [`flags.${MODULE_NS}.${FLAG_ROOT}`]: flags,
    }, { diff: false, spaceholderJournalCheck: true });
  }

  return true;
}

export async function moveTimelineEntryOrderInList(page, { pages, dir, orderStep = TIMELINE_ORDER_STEP } = {}) {
  if (!page) return false;

  const direction = Number(dir) < 0 ? -1 : 1;
  const cur = getTimelineEntryData(page);
  const year = cur.year;

  const list = (Array.isArray(pages) ? pages : [])
    .filter((p) => p?.uuid && p?.id)
    .filter((p) => getTimelineEntryData(p).year === year)
    .sort((a, b) => {
      const ta = getTimelineEntryData(a);
      const tb = getTimelineEntryData(b);

      if (ta.id !== tb.id) return ta.id - tb.id;
      return String(a.uuid).localeCompare(String(b.uuid));
    });

  const idx = list.findIndex((p) => p.uuid === page.uuid);
  if (idx < 0) return false;

  const targetIndex = idx + direction;
  if (targetIndex < 0 || targetIndex >= list.length) return false;

  const step = Math.max(1, Number(orderStep) || TIMELINE_ORDER_STEP);

  const computeNewOrder = () => {
    if (direction < 0) {
      const next = list[targetIndex]; // neighbor above
      const prev = (targetIndex - 1) >= 0 ? list[targetIndex - 1] : null;

      const nextOrder = getTimelineEntryData(next).id;
      const prevOrder = prev ? getTimelineEntryData(prev).id : null;

      if (!prevOrder) {
        // Insert before the first visible item: use half of nextOrder.
        const candidate = Math.floor(nextOrder / 2);
        return candidate;
      }

      if ((nextOrder - prevOrder) <= 1) return 0;
      return Math.floor((prevOrder + nextOrder) / 2);
    }

    // direction > 0
    const prev = list[targetIndex]; // neighbor below
    const next = (targetIndex + 1) < list.length ? list[targetIndex + 1] : null;

    const prevOrder = getTimelineEntryData(prev).id;

    if (!next) {
      // Append after the last visible item.
      return prevOrder + step;
    }

    const nextOrder = getTimelineEntryData(next).id;
    if ((nextOrder - prevOrder) <= 1) return 0;
    return Math.floor((prevOrder + nextOrder) / 2);
  };

  let newOrder = computeNewOrder();

  // Not enough space or invalid candidate => renormalize, then retry once.
  if (!Number.isFinite(newOrder) || newOrder <= 0) {
    await renormalizeTimelineEntryOrders(list, { year, orderStep: step });
    newOrder = computeNewOrder();
  }

  if (!Number.isFinite(newOrder) || newOrder <= 0) return false;

  return await setTimelineEntryOrder(page, newOrder);
}

export async function swapTimelineEntryIds(pageA, pageB) {
  if (!pageA || !pageB) return false;

  const fa = { ..._getFlagObj(pageA) };
  const fb = { ..._getFlagObj(pageB) };

  const ya = Number.parseInt(fa?.year, 10) || 1;
  const yb = Number.parseInt(fb?.year, 10) || 1;
  if (ya !== yb) return false;

  const ida = Number.parseInt(fa?.id, 10) || 0;
  const idb = Number.parseInt(fb?.id, 10) || 0;

  fa.id = idb;
  fb.id = ida;

  await pageA.update({ [`flags.${MODULE_NS}.${FLAG_ROOT}`]: fa }, { diff: false, spaceholderJournalCheck: true });
  await pageB.update({ [`flags.${MODULE_NS}.${FLAG_ROOT}`]: fb }, { diff: false, spaceholderJournalCheck: true });

  return true;
}

export async function deleteTimelineEntryPage(page) {
  if (!page) return false;

  const parent = page.parent;
  if (!parent?.id) return false;

  await parent.deleteEmbeddedDocuments('JournalEntryPage', [page.id], { spaceholderJournalCheck: true });
  return true;
}

function _clonePageToData(page, { override = {} } = {}) {
  const data = page.toObject(false);

  // keep fields we care about
  const out = {
    name: data.name,
    type: data.type,
    text: { ...(data.text || {}) },
    flags: foundry.utils.deepClone(data.flags || {}),
    ...(data.ownership ? { ownership: foundry.utils.deepClone(data.ownership) } : {}),
  };

  // force timeline flag root to merge
  const t = _getFlagObj(page);
  out.flags[MODULE_NS] = out.flags[MODULE_NS] || {};
  out.flags[MODULE_NS][FLAG_ROOT] = { ...(t || {}), ...(override.flagsTimeline || {}) };

  if (override.name !== undefined) out.name = override.name;
  if (override.textContent !== undefined) {
    out.text = out.text || {};
    out.text.content = String(override.textContent || '');
  }

  return out;
}

export async function moveTimelineEntryBetweenContainers(page, { toKind, factionUuid = '' } = {}) {
  if (!page) return null;

  const targetKind = String(toKind || '').trim();
  if (!targetKind) return null;

  const fu = normalizeUuid(factionUuid) || getTimelineEntryData(page).factionUuid;

  const target = getTimelineContainer({ kind: targetKind, factionUuid: fu });
  if (!target) throw new Error('Target timeline container not found');

  // Clone data while preserving year/id/etc.
  const entryData = getTimelineEntryData(page);

  const desiredIsGlobal = (targetKind === TIMELINE_CONTAINER_KIND.FACTION_PUBLIC)
    ? true
    : (targetKind === TIMELINE_CONTAINER_KIND.FACTION_PRIVATE)
      ? false
      : !!entryData.isGlobal;

  const clone = _clonePageToData(page, {
    override: {
      flagsTimeline: {
        isGlobal: desiredIsGlobal,
        origin: entryData.origin,
        factionUuid: entryData.factionUuid,
      },
    },
  });

  // Faction-bound entries must inherit container ownership (players can edit their faction entries).
  if (entryData.factionUuid) {
    delete clone.ownership;
  } else {
    // World-only entries: enforce ownership based on global flag.
    clone.ownership = _worldOnlyPageOwnership({ isGlobal: desiredIsGlobal });
  }

  const created = await target.createEmbeddedDocuments('JournalEntryPage', [clone], { spaceholderJournalCheck: true });
  const newPage = created?.[0] ?? null;

  // Delete old
  await deleteTimelineEntryPage(page);

  return newPage;
}

export async function resolveTimelinePage(rawUuid) {
  const uuid = normalizeUuid(rawUuid);
  if (!uuid) return null;

  let doc = null;
  try {
    doc = await fromUuid(uuid);
  } catch (_) {
    doc = null;
  }

  if (!doc || doc.documentName !== 'JournalEntryPage') return null;
  if (!isTimelineEntryPage(doc)) return null;

  return doc;
}

export function canUserOwnContainer(entry, user) {
  try {
    return !!entry?.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
  } catch (_) {
    return false;
  }
}

export function getUserFactionUuidsSafe(user) {
  try {
    return getUserFactionUuids(user);
  } catch (_) {
    return [];
  }
}

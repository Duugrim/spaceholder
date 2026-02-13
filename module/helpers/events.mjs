import { getUserFactionUuids, getUsersForFaction, normalizeUuid as normalizeUuidUserFactions } from './user-factions.mjs';
import { createTimelineV2Event, ensureTimelineV2InfrastructureForCurrentUser, TIMELINE_V2_ORIGIN } from './timeline-v2.mjs';

const MODULE_NS = 'spaceholder';
const FLAG_ROOT = 'events';
const SOCKET_TYPE = `${MODULE_NS}.events`;
const EVENTS_FOLDER_NAME = 'SpaceHolder Events';

export const EVENT_CONTAINER_KIND = {
  TEMPLATES: 'templates',
  FACTION_EVENTS: 'factionEvents',
};

export const EVENT_TYPE = {
  DRAFT_TEMPLATE: 'draftTemplate',
  EVENT_INSTANCE: 'eventInstance',
};

export const EVENT_RESPONSE_MODE = {
  CHOICE_ONLY: 'choice-only',
  TEXT_ONLY: 'text-only',
  EITHER: 'either',
  BOTH: 'both',
};

export const EVENT_STATUS = {
  CREATED: 'created',
  ANSWERED: 'answered',
  RESOLVED: 'resolved',
  FINISHED: 'finished',
};

let _socketInstalled = false;
let _hooksInstalled = false;
let _folderId = null;
const _containerCache = new Map();

let _reqSeq = 0;
const _pending = new Map();

function _socketName() {
  try {
    return `system.${game.system.id}`;
  } catch (_) {
    return `system.${MODULE_NS}`;
  }
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
    console.error('SpaceHolder | Events: socket.emit failed', e);
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
      reject(new Error(`Events socket request timed out: ${action}`));
    }, Math.max(1000, Number(timeoutMs) || 8000));

    _pending.set(requestId, { resolve, reject, timeoutId });
    const ok = _sendSocket(msg);
    if (!ok) {
      clearTimeout(timeoutId);
      _pending.delete(requestId);
      reject(new Error(`Events socket emit failed: ${action}`));
    }
  });
}

function _hasOnlineGm() {
  try {
    return Array.from(game?.users?.values?.() ?? game?.users?.contents ?? []).some((u) => !!u?.isGM && !!u?.active);
  } catch (_) {
    return false;
  }
}

function _handleSocketResponse(msg) {
  const requestId = String(msg?.requestId || '').trim();
  const userId = String(msg?.userId || '').trim();
  if (!requestId || !userId) return;
  if (userId !== String(game.user?.id || '').trim()) return;

  const pending = _pending.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timeoutId);
  _pending.delete(requestId);

  if (msg?.ok) pending.resolve(msg?.payload);
  else pending.reject(new Error(String(msg?.error || 'Events socket request failed')));
}

export function normalizeUuid(raw) {
  return normalizeUuidUserFactions(raw);
}

function _nowIso() {
  return new Date().toISOString();
}

function _eventDateToTimelineV2Date(raw) {
  const s = String(raw || '').trim();
  const mYmd = s.match(/^(-?\d{1,6})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (mYmd) {
    const year = Number.parseInt(mYmd[1], 10);
    const month = Math.min(12, Math.max(1, Number.parseInt(mYmd[2], 10) || 1));
    const day = Math.min(30, Math.max(1, Number.parseInt(mYmd[3], 10) || 1));
    return { year: Number.isFinite(year) ? year : 0, month, day };
  }

  const mDmy = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](-?\d{1,6})$/);
  if (mDmy) {
    const year = Number.parseInt(mDmy[3], 10);
    const month = Math.min(12, Math.max(1, Number.parseInt(mDmy[2], 10) || 1));
    const day = Math.min(30, Math.max(1, Number.parseInt(mDmy[1], 10) || 1));
    return { year: Number.isFinite(year) ? year : 0, month, day };
  }

  const now = new Date();
  return {
    year: now.getFullYear(),
    month: Math.min(12, Math.max(1, now.getMonth() + 1)),
    day: Math.min(30, Math.max(1, now.getDate())),
  };
}

function _safeString(raw, fallback = '') {
  const out = String(raw ?? '').trim();
  return out || fallback;
}

function _safeOptions(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const label = _safeString(it.label);
    if (!label) continue;
    const optionOutcome = _safeString(it.optionOutcome);
    out.push({
      label,
      ...(optionOutcome ? { optionOutcome } : {}),
    });
  }
  return out;
}

function _normalizeResponseMode(raw) {
  const v = _safeString(raw, EVENT_RESPONSE_MODE.EITHER);
  if (Object.values(EVENT_RESPONSE_MODE).includes(v)) return v;
  return EVENT_RESPONSE_MODE.EITHER;
}

function _getFlagObj(doc) {
  try {
    return doc?.getFlag?.(MODULE_NS, FLAG_ROOT) ?? doc?.flags?.[MODULE_NS]?.[FLAG_ROOT] ?? {};
  } catch (_) {
    return {};
  }
}

function _isEventsFolder(folder) {
  const f = _getFlagObj(folder);
  return !!f?.isFolder;
}

function _containerKey(kind, factionUuid = '') {
  return `${String(kind || '').trim()}::${normalizeUuid(factionUuid)}`;
}

function _invalidateContainerCache() {
  _containerCache.clear();
}

function _findEventsFolderInWorld() {
  if (_folderId) {
    const cached = game?.folders?.get?.(_folderId) ?? null;
    if (cached && _isEventsFolder(cached)) return cached;
    _folderId = null;
  }

  const folders = Array.isArray(game?.folders?.contents) ? game.folders.contents : [];
  for (const folder of folders) {
    if (!folder?.id) continue;
    if (folder.type !== 'JournalEntry') continue;
    if (!_isEventsFolder(folder)) continue;
    _folderId = folder.id;
    return folder;
  }

  return null;
}

async function _gmEnsureEventsFolder() {
  if (!game?.user?.isGM) return null;

  const existing = _findEventsFolderInWorld();
  if (existing) return existing;

  const data = {
    name: EVENTS_FOLDER_NAME,
    type: 'JournalEntry',
    flags: {
      [MODULE_NS]: {
        [FLAG_ROOT]: {
          isFolder: true,
        },
      },
    },
  };

  const FolderClass = globalThis.Folder ?? game?.folders?.documentClass;
  if (!FolderClass?.create) return null;

  const created = await FolderClass.create(data, { render: false, spaceholderJournalCheck: true });
  _folderId = created?.id ?? null;
  return created;
}

function _findContainerInWorld({ kind, factionUuid = '' }) {
  const key = _containerKey(kind, factionUuid);
  if (_containerCache.has(key)) {
    const cached = _containerCache.get(key);
    if (cached?.id && game?.journal?.get?.(cached.id)) return cached;
    _containerCache.delete(key);
  }

  const entries = Array.isArray(game?.journal?.contents) ? game.journal.contents : [];
  for (const entry of entries) {
    if (!entry?.id) continue;
    const f = _getFlagObj(entry);
    if (!f?.isContainer) continue;
    if (String(f?.containerKind || '').trim() !== kind) continue;
    if (normalizeUuid(f?.factionUuid) !== normalizeUuid(factionUuid)) continue;
    _containerCache.set(key, entry);
    return entry;
  }

  return null;
}

function _containerName({ kind, factionDoc = null, factionUuid = '' }) {
  if (kind === EVENT_CONTAINER_KIND.TEMPLATES) return 'SpaceHolder Events: Draft Templates';
  const fu = normalizeUuid(factionUuid);
  const factionName = _safeString(factionDoc?.name);
  const suffix = factionName ? `${factionName} (${fu || 'no-uuid'})` : (fu || 'no-uuid');
  return `SpaceHolder Events: Faction ${suffix}`;
}

function _ownershipObj({ defaultLevel, ownerIds = [] }) {
  const OWN = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const out = { default: defaultLevel };

  const users = Array.from(game?.users?.values?.() ?? game?.users?.contents ?? []);
  for (const user of users) {
    if (!user?.id) continue;
    if (user.isGM) out[user.id] = OWN;
  }

  for (const id of ownerIds) {
    const k = _safeString(id);
    if (!k) continue;
    out[k] = OWN;
  }

  return out;
}

async function _gmUpsertContainer({ kind, factionUuid = '' }) {
  if (!game?.user?.isGM) return null;

  const fu = normalizeUuid(factionUuid);
  const existing = _findContainerInWorld({ kind, factionUuid: fu });

  let factionDoc = null;
  if (fu) {
    try {
      factionDoc = await fromUuid(fu);
    } catch (_) {
      factionDoc = null;
    }
  }

  const name = _containerName({ kind, factionDoc, factionUuid: fu });
  const NONE = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0;
  const ownerIds = kind === EVENT_CONTAINER_KIND.FACTION_EVENTS
    ? getUsersForFaction(fu).map((u) => u?.id).filter(Boolean)
    : [];
  const ownership = _ownershipObj({ defaultLevel: NONE, ownerIds });

  if (!existing) {
    let folder = _findEventsFolderInWorld();
    if (!folder) {
      await _gmEnsureEventsFolder();
      folder = _findEventsFolderInWorld();
    }

    const flags = {
      [MODULE_NS]: {
        [FLAG_ROOT]: {
          isContainer: true,
          containerKind: kind,
          factionUuid: fu,
        },
      },
    };

    const JournalEntryClass = globalThis.JournalEntry ?? game?.journal?.documentClass;
    if (!JournalEntryClass?.create) return null;

    const created = await JournalEntryClass.create({
      name,
      folder: folder?.id ?? null,
      ownership,
      flags,
    }, { render: false, spaceholderJournalCheck: true });

    _invalidateContainerCache();
    return created;
  }

  const f = _getFlagObj(existing);
  const patch = {
    ownership,
  };

  if (!f?.isContainer || String(f?.containerKind || '') !== kind || normalizeUuid(f?.factionUuid) !== fu) {
    patch[`flags.${MODULE_NS}.${FLAG_ROOT}`] = {
      ...(f || {}),
      isContainer: true,
      containerKind: kind,
      factionUuid: fu,
    };
  }

  if (_safeString(existing.name) !== name) patch.name = name;

  if (Object.keys(patch).length) {
    await existing.update(patch, { diff: false, spaceholderJournalCheck: true });
  }

  _containerCache.set(_containerKey(kind, fu), existing);
  return existing;
}

export function getEventsContainer({ kind, factionUuid = '' }) {
  return _findContainerInWorld({ kind, factionUuid });
}

export function listEventsContainers({ kind = null } = {}) {
  const entries = Array.isArray(game?.journal?.contents) ? game.journal.contents : [];
  const out = [];
  for (const entry of entries) {
    if (!entry?.id) continue;
    const f = _getFlagObj(entry);
    if (!f?.isContainer) continue;
    if (kind && String(f?.containerKind || '').trim() !== kind) continue;
    out.push(entry);
  }
  return out;
}

export function isEventPage(page) {
  const f = _getFlagObj(page);
  return !!f?.isEvent;
}

export function getEventPageData(page) {
  const f = _getFlagObj(page);
  const options = _safeOptions(f?.options);
  const responseMode = _normalizeResponseMode(f?.responseMode);

  const data = {
    isEvent: !!f?.isEvent,
    eventType: _safeString(f?.eventType),
    targetFactionUuid: normalizeUuid(f?.targetFactionUuid),
    title: _safeString(f?.title) || _safeString(page?.name) || '(untitled)',
    description: String(f?.description ?? page?.text?.content ?? ''),
    eventDate: _safeString(f?.eventDate),
    iconPath: _safeString(f?.iconPath),
    options,
    responseMode,
    selectedOptionIndex: Number.isInteger(f?.selectedOptionIndex) ? f.selectedOptionIndex : null,
    freeText: String(f?.freeText ?? ''),
    outcome: String(f?.outcome ?? ''),
    outcomeMode: _safeString(f?.outcomeMode, 'manual'),
    isFinished: !!f?.isFinished,
    status: _safeString(f?.status),
    timelineEntryUuid: _safeString(f?.timelineEntryUuid),
    createdAt: _safeString(f?.createdAt),
    updatedAt: _safeString(f?.updatedAt),
    respondedAt: _safeString(f?.respondedAt),
    respondedBy: _safeString(f?.respondedBy),
    resolvedAt: _safeString(f?.resolvedAt),
    resolvedBy: _safeString(f?.resolvedBy),
    finishedAt: _safeString(f?.finishedAt),
    finishedBy: _safeString(f?.finishedBy),
  };

  if (!Object.values(EVENT_STATUS).includes(data.status)) {
    data.status = computeEventStatus(data);
  }
  return data;
}

export function computeEventStatus(data) {
  const hasOutcome = _safeString(data?.outcome).length > 0;
  if (data?.isFinished && hasOutcome) return EVENT_STATUS.FINISHED;
  if (hasOutcome) return EVENT_STATUS.RESOLVED;

  const hasChoice = Number.isInteger(data?.selectedOptionIndex) && data.selectedOptionIndex >= 0;
  const hasText = _safeString(data?.freeText).length > 0;
  if (hasChoice || hasText) return EVENT_STATUS.ANSWERED;
  return EVENT_STATUS.CREATED;
}

export function validateResponseByMode({ responseMode, selectedOptionIndex, freeText }) {
  const mode = _normalizeResponseMode(responseMode);
  const hasChoice = Number.isInteger(selectedOptionIndex) && selectedOptionIndex >= 0;
  const hasText = _safeString(freeText).length > 0;

  if (mode === EVENT_RESPONSE_MODE.CHOICE_ONLY) return hasChoice;
  if (mode === EVENT_RESPONSE_MODE.TEXT_ONLY) return hasText;
  if (mode === EVENT_RESPONSE_MODE.BOTH) return hasChoice && hasText;
  return hasChoice || hasText;
}

function _assertEventDefinitionValid({ options, responseMode }) {
  const mode = _normalizeResponseMode(responseMode);
  const count = _safeOptions(options).length;
  if ((mode === EVENT_RESPONSE_MODE.CHOICE_ONLY || mode === EVENT_RESPONSE_MODE.BOTH) && count < 1) {
    throw new Error('At least one option is required for selected response mode');
  }
}

function _buildPageFlags({
  eventType,
  targetFactionUuid = '',
  title,
  description = '',
  eventDate = '',
  iconPath = '',
  options = [],
  responseMode = EVENT_RESPONSE_MODE.EITHER,
  selectedOptionIndex = null,
  freeText = '',
  outcome = '',
  outcomeMode = 'manual',
  isFinished = false,
  timelineEntryUuid = '',
  createdAt = _nowIso(),
  updatedAt = _nowIso(),
  respondedAt = '',
  respondedBy = '',
  resolvedAt = '',
  resolvedBy = '',
  finishedAt = '',
  finishedBy = '',
}) {
  const payload = {
    isEvent: true,
    eventType,
    targetFactionUuid: normalizeUuid(targetFactionUuid),
    title: _safeString(title) || '(untitled)',
    description: String(description ?? ''),
    eventDate: _safeString(eventDate),
    iconPath: _safeString(iconPath),
    options: _safeOptions(options),
    responseMode: _normalizeResponseMode(responseMode),
    selectedOptionIndex: Number.isInteger(selectedOptionIndex) ? selectedOptionIndex : null,
    freeText: String(freeText ?? ''),
    outcome: String(outcome ?? ''),
    outcomeMode: _safeString(outcomeMode, 'manual'),
    isFinished: !!isFinished,
    timelineEntryUuid: _safeString(timelineEntryUuid),
    createdAt: _safeString(createdAt) || _nowIso(),
    updatedAt: _safeString(updatedAt) || _nowIso(),
    respondedAt: _safeString(respondedAt),
    respondedBy: _safeString(respondedBy),
    resolvedAt: _safeString(resolvedAt),
    resolvedBy: _safeString(resolvedBy),
    finishedAt: _safeString(finishedAt),
    finishedBy: _safeString(finishedBy),
  };

  payload.status = computeEventStatus(payload);
  return payload;
}

async function _updateEventPageFromData(page, next) {
  const flags = _buildPageFlags(next);
  await page.update({
    name: flags.title,
    text: { ...(page.text || {}), content: flags.description },
    [`flags.${MODULE_NS}.${FLAG_ROOT}`]: flags,
  }, { diff: false, spaceholderJournalCheck: true });
  return page;
}

export async function resolveEventPage(rawUuid) {
  const uuid = normalizeUuid(rawUuid);
  if (!uuid) return null;

  let doc = null;
  try {
    doc = await fromUuid(uuid);
  } catch (_) {
    doc = null;
  }

  if (!doc || doc.documentName !== 'JournalEntryPage') return null;
  if (!isEventPage(doc)) return null;
  return doc;
}

export function canUserOwnContainer(entry, user) {
  try {
    return !!entry?.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
  } catch (_) {
    return false;
  }
}

function _canUserOwnEventPage(page, user) {
  try {
    if (!page || !user) return false;
    if (page?.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) return true;
    return canUserOwnContainer(page?.parent, user);
  } catch (_) {
    return false;
  }
}

export async function gmEnsureEventsContainers({ factionUuids = [] } = {}) {
  if (!game?.user?.isGM) return false;
  await _gmEnsureEventsFolder();
  await _gmUpsertContainer({ kind: EVENT_CONTAINER_KIND.TEMPLATES });
  for (const raw of (Array.isArray(factionUuids) ? factionUuids : [])) {
    const fu = normalizeUuid(raw);
    if (!fu) continue;
    await _gmUpsertContainer({ kind: EVENT_CONTAINER_KIND.FACTION_EVENTS, factionUuid: fu });
  }
  return true;
}

export async function gmSyncEventsOwnershipForAllFactions() {
  if (!game?.user?.isGM) return false;
  const factionActors = Array.from(game?.actors?.values?.() ?? game?.actors?.contents ?? []).filter((a) => a?.type === 'faction');
  const factionUuids = factionActors.map((a) => a.uuid).filter(Boolean);
  await gmEnsureEventsContainers({ factionUuids });
  return true;
}

export async function ensureEventsInfrastructureForCurrentUser() {
  const factions = getUserFactionUuids(game.user);
  if (game.user?.isGM) {
    await gmSyncEventsOwnershipForAllFactions();
    return true;
  }
  if (!factions.length) return false;

  // If containers already exist, players can work without GM online.
  let allPresent = true;
  for (const fu of factions) {
    const container = getEventsContainer({ kind: EVENT_CONTAINER_KIND.FACTION_EVENTS, factionUuid: fu });
    if (!container) {
      allPresent = false;
      break;
    }
  }
  if (allPresent) return true;

  if (!_hasOnlineGm()) {
    // No active GM to process ensure via socket.
    return false;
  }

  try {
    await _requestViaSocket('ensure', { factionUuids: factions });
    return true;
  } catch (e) {
    console.warn('SpaceHolder | Events: ensure infrastructure failed', e);
    return false;
  }
}

export function listEventTemplates() {
  const container = getEventsContainer({ kind: EVENT_CONTAINER_KIND.TEMPLATES });
  const pages = container?.pages?.contents ?? [];
  return pages.filter((p) => isEventPage(p) && getEventPageData(p).eventType === EVENT_TYPE.DRAFT_TEMPLATE);
}

export function listFactionEventPages({ factionUuid = '' } = {}) {
  const fu = normalizeUuid(factionUuid);
  const containers = fu
    ? [getEventsContainer({ kind: EVENT_CONTAINER_KIND.FACTION_EVENTS, factionUuid: fu })].filter(Boolean)
    : listEventsContainers({ kind: EVENT_CONTAINER_KIND.FACTION_EVENTS });
  const out = [];
  for (const container of containers) {
    const pages = container?.pages?.contents ?? [];
    for (const page of pages) {
      if (!isEventPage(page)) continue;
      const data = getEventPageData(page);
      if (data.eventType !== EVENT_TYPE.EVENT_INSTANCE) continue;
      out.push(page);
    }
  }
  return out;
}

export async function createEventTemplate({
  title,
  description = '',
  eventDate = '',
  iconPath = '',
  options = [],
  responseMode = EVENT_RESPONSE_MODE.EITHER,
} = {}) {
  if (!game.user?.isGM) throw new Error('Only GM can create event templates');
  _assertEventDefinitionValid({ options, responseMode });
  const container = getEventsContainer({ kind: EVENT_CONTAINER_KIND.TEMPLATES });
  if (!container) throw new Error('Events template container not found');

  const flags = _buildPageFlags({
    eventType: EVENT_TYPE.DRAFT_TEMPLATE,
    title,
    description,
    eventDate,
    iconPath,
    options,
    responseMode,
  });

  const created = await container.createEmbeddedDocuments('JournalEntryPage', [{
    name: flags.title,
    type: 'text',
    text: { content: flags.description },
    flags: { [MODULE_NS]: { [FLAG_ROOT]: flags } },
  }], { spaceholderJournalCheck: true });

  return created?.[0] ?? null;
}

export async function updateEventTemplate(page, { title, description, eventDate, iconPath, options, responseMode } = {}) {
  if (!game.user?.isGM) throw new Error('Only GM can update event templates');
  if (!page) return null;
  const cur = getEventPageData(page);
  if (cur.eventType !== EVENT_TYPE.DRAFT_TEMPLATE) throw new Error('Expected draft template page');
  _assertEventDefinitionValid({
    options: options ?? cur.options,
    responseMode: responseMode ?? cur.responseMode,
  });

  return await _updateEventPageFromData(page, {
    ...cur,
    title: title ?? cur.title,
    description: description ?? cur.description,
    eventDate: eventDate ?? cur.eventDate,
    iconPath: iconPath ?? cur.iconPath,
    options: options ?? cur.options,
    responseMode: responseMode ?? cur.responseMode,
    updatedAt: _nowIso(),
  });
}

export async function deleteEventPage(page) {
  if (!page?.parent?.id) return false;
  await page.parent.deleteEmbeddedDocuments('JournalEntryPage', [page.id], { spaceholderJournalCheck: true });
  return true;
}

export async function createFactionEventFromTemplate(templatePage, { targetFactionUuid } = {}) {
  if (!game.user?.isGM) throw new Error('Only GM can send events');
  if (!templatePage) throw new Error('Template page not found');
  const src = getEventPageData(templatePage);
  if (src.eventType !== EVENT_TYPE.DRAFT_TEMPLATE) throw new Error('Expected template page');
  return await createFactionEvent({
    targetFactionUuid,
    title: src.title,
    description: src.description,
    eventDate: src.eventDate,
    iconPath: src.iconPath,
    options: src.options,
    responseMode: src.responseMode,
  });
}

export async function createFactionEvent({
  targetFactionUuid,
  title,
  description = '',
  eventDate = '',
  iconPath = '',
  options = [],
  responseMode = EVENT_RESPONSE_MODE.EITHER,
} = {}) {
  if (!game.user?.isGM) throw new Error('Only GM can create faction events');
  _assertEventDefinitionValid({ options, responseMode });
  const fu = normalizeUuid(targetFactionUuid);
  if (!fu) throw new Error('Faction is required');

  const container = getEventsContainer({ kind: EVENT_CONTAINER_KIND.FACTION_EVENTS, factionUuid: fu });
  if (!container) throw new Error('Faction events container not found');

  const flags = _buildPageFlags({
    eventType: EVENT_TYPE.EVENT_INSTANCE,
    targetFactionUuid: fu,
    title,
    description,
    eventDate,
    iconPath,
    options,
    responseMode,
  });

  const created = await container.createEmbeddedDocuments('JournalEntryPage', [{
    name: flags.title,
    type: 'text',
    text: { content: flags.description },
    flags: { [MODULE_NS]: { [FLAG_ROOT]: flags } },
  }], { spaceholderJournalCheck: true });
  return created?.[0] ?? null;
}

export async function updateFactionEventDetails(page, {
  title,
  description,
  eventDate,
  iconPath,
  options,
  responseMode,
} = {}) {
  if (!game.user?.isGM) throw new Error('Only GM can update faction events');
  if (!page) return null;
  const cur = getEventPageData(page);
  if (cur.eventType !== EVENT_TYPE.EVENT_INSTANCE) throw new Error('Expected event instance');
  _assertEventDefinitionValid({
    options: options ?? cur.options,
    responseMode: responseMode ?? cur.responseMode,
  });

  return await _updateEventPageFromData(page, {
    ...cur,
    title: title ?? cur.title,
    description: description ?? cur.description,
    eventDate: eventDate ?? cur.eventDate,
    iconPath: iconPath ?? cur.iconPath,
    options: options ?? cur.options,
    responseMode: responseMode ?? cur.responseMode,
    updatedAt: _nowIso(),
  });
}

async function _submitResponseInternal(page, { selectedOptionIndex = null, freeText = '', userId = '' } = {}) {
  if (!page) throw new Error('Event page not found');
  const cur = getEventPageData(page);
  if (cur.eventType !== EVENT_TYPE.EVENT_INSTANCE) throw new Error('Expected event instance');

  const nextSelected = Number.isInteger(selectedOptionIndex) ? selectedOptionIndex : null;
  const nextText = String(freeText ?? '');
  if (Number.isInteger(nextSelected) && !cur.options[nextSelected]) {
    throw new Error('Selected option is out of range');
  }
  if (!validateResponseByMode({ responseMode: cur.responseMode, selectedOptionIndex: nextSelected, freeText: nextText })) {
    throw new Error('Response does not satisfy configured mode');
  }

  let outcome = cur.outcome;
  let outcomeMode = cur.outcomeMode;
  let resolvedAt = cur.resolvedAt;
  let resolvedBy = cur.resolvedBy;
  if (!outcome && Number.isInteger(nextSelected) && cur.options[nextSelected]?.optionOutcome) {
    outcome = String(cur.options[nextSelected].optionOutcome);
    outcomeMode = 'auto';
    resolvedAt = _nowIso();
    resolvedBy = _safeString(userId || game.user?.id);
  }

  return await _updateEventPageFromData(page, {
    ...cur,
    selectedOptionIndex: nextSelected,
    freeText: nextText,
    respondedAt: _nowIso(),
    respondedBy: _safeString(userId || game.user?.id),
    outcome,
    outcomeMode,
    resolvedAt,
    resolvedBy,
    updatedAt: _nowIso(),
  });
}

export async function submitFactionEventResponse(page, { selectedOptionIndex = null, freeText = '' } = {}) {
  if (!page) return null;
  const cur = getEventPageData(page);
  const fu = normalizeUuid(cur.targetFactionUuid);
  if (!fu) throw new Error('Event is missing faction');

  if (game.user?.isGM) {
    return await _submitResponseInternal(page, { selectedOptionIndex, freeText, userId: game.user?.id });
  }

  const myFactions = getUserFactionUuids(game.user);
  if (!myFactions.includes(fu)) throw new Error('No access to faction event');

  // Prefer direct update when player has OWNER permission.
  if (_canUserOwnEventPage(page, game.user)) {
    return await _submitResponseInternal(page, { selectedOptionIndex, freeText, userId: game.user?.id });
  }
  if (!_hasOnlineGm()) {
    throw new Error('Cannot submit response: no active GM and no OWNER permission');
  }

  const payload = await _requestViaSocket('submitResponse', {
    pageUuid: page.uuid,
    selectedOptionIndex,
    freeText,
  });
  return await resolveEventPage(payload?.pageUuid || page.uuid);
}

export async function resolveFactionEventOutcome(page, { outcome = '', outcomeMode = 'manual' } = {}) {
  if (!game.user?.isGM) throw new Error('Only GM can resolve outcomes');
  if (!page) return null;
  const cur = getEventPageData(page);
  if (cur.eventType !== EVENT_TYPE.EVENT_INSTANCE) throw new Error('Expected event instance');

  const nextOutcome = String(outcome ?? '').trim();
  const nextMode = nextOutcome ? _safeString(outcomeMode, 'manual') : '';
  return await _updateEventPageFromData(page, {
    ...cur,
    outcome: nextOutcome,
    outcomeMode: nextMode || cur.outcomeMode || 'manual',
    resolvedAt: nextOutcome ? _nowIso() : '',
    resolvedBy: nextOutcome ? _safeString(game.user?.id) : '',
    isFinished: nextOutcome ? cur.isFinished : false,
    finishedAt: nextOutcome ? cur.finishedAt : '',
    finishedBy: nextOutcome ? cur.finishedBy : '',
    updatedAt: _nowIso(),
  });
}

async function _setFinishedInternal(page, finished, { userId = '' } = {}) {
  const cur = getEventPageData(page);
  if (!_safeString(cur.outcome)) {
    throw new Error('Cannot finish event without outcome');
  }
  const isFinished = !!finished;
  return await _updateEventPageFromData(page, {
    ...cur,
    isFinished,
    finishedAt: isFinished ? _nowIso() : '',
    finishedBy: isFinished ? _safeString(userId || game.user?.id) : '',
    updatedAt: _nowIso(),
  });
}

export async function setFactionEventFinished(page, finished) {
  if (!page) return null;
  const cur = getEventPageData(page);
  const fu = normalizeUuid(cur.targetFactionUuid);
  if (!fu) throw new Error('Event is missing faction');

  if (game.user?.isGM) {
    return await _setFinishedInternal(page, finished, { userId: game.user?.id });
  }

  const myFactions = getUserFactionUuids(game.user);
  if (!myFactions.includes(fu)) throw new Error('No access to faction event');

  // Prefer direct update when player has OWNER permission.
  if (_canUserOwnEventPage(page, game.user)) {
    return await _setFinishedInternal(page, !!finished, { userId: game.user?.id });
  }
  if (!_hasOnlineGm()) {
    throw new Error('Cannot finish event: no active GM and no OWNER permission');
  }

  const payload = await _requestViaSocket('setFinished', {
    pageUuid: page.uuid,
    finished: !!finished,
  });
  return await resolveEventPage(payload?.pageUuid || page.uuid);
}

export async function createTimelineEntryFromResolvedEvent(page, { year = null } = {}) {
  if (!game.user?.isGM) throw new Error('Only GM can export to timeline');
  if (!page) throw new Error('Event page not found');
  const cur = getEventPageData(page);
  if (cur.eventType !== EVENT_TYPE.EVENT_INSTANCE) throw new Error('Expected event instance');
  if (cur.status !== EVENT_STATUS.RESOLVED && cur.status !== EVENT_STATUS.FINISHED) {
    throw new Error('Only resolved events can be exported');
  }
  if (cur.timelineEntryUuid) return cur.timelineEntryUuid;

  await ensureTimelineV2InfrastructureForCurrentUser();

  const parsedDate = _eventDateToTimelineV2Date(cur.eventDate);
  if (Number.isFinite(Number.parseInt(year, 10))) {
    parsedDate.year = Number.parseInt(year, 10);
  }
  const pieces = [
    `<h3>${foundry.utils.escapeHTML(cur.title)}</h3>`,
    `<p>${foundry.utils.escapeHTML(cur.description || '')}</p>`,
  ];
  const responseParts = [];
  if (Number.isInteger(cur.selectedOptionIndex) && cur.options[cur.selectedOptionIndex]) {
    responseParts.push(`<p><b>Selected option:</b> ${foundry.utils.escapeHTML(cur.options[cur.selectedOptionIndex].label)}</p>`);
  }
  if (_safeString(cur.freeText)) {
    responseParts.push(`<p><b>Free response:</b> ${foundry.utils.escapeHTML(cur.freeText)}</p>`);
  }
  if (responseParts.length) pieces.push(`<hr/><h4>Faction response</h4>${responseParts.join('')}`);
  pieces.push(`<hr/><h4>Outcome</h4><p>${foundry.utils.escapeHTML(cur.outcome)}</p>`);
  const content = pieces.join('\n');

  const created = await createTimelineV2Event({
    year: parsedDate.year,
    month: parsedDate.month,
    day: parsedDate.day,
    origin: TIMELINE_V2_ORIGIN.FACTION,
    factionUuid: cur.targetFactionUuid,
    isGlobal: false,
    isHidden: false,
    title: cur.title,
    content,
  });
  const timelinePageUuid = created?.detailPage?.uuid || created?.indexPage?.uuid || '';
  if (!timelinePageUuid) throw new Error('Failed to create timeline entry');

  await _updateEventPageFromData(page, {
    ...cur,
    timelineEntryUuid: timelinePageUuid,
    updatedAt: _nowIso(),
  });

  return timelinePageUuid;
}

async function _handleSocketRequestAsGM(msg) {
  const action = _safeString(msg?.action);
  const requestId = _safeString(msg?.requestId);
  const userId = _safeString(msg?.userId);

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
      await gmEnsureEventsContainers({ factionUuids });
      reply(true, { ok: true });
      return;
    }

    if (action === 'submitResponse') {
      const page = await resolveEventPage(msg?.payload?.pageUuid);
      if (!page) throw new Error('Event not found');
      const selectedOptionIndex = msg?.payload?.selectedOptionIndex;
      const freeText = String(msg?.payload?.freeText ?? '');
      await _submitResponseInternal(page, { selectedOptionIndex, freeText, userId });
      reply(true, { pageUuid: page.uuid });
      return;
    }

    if (action === 'setFinished') {
      const page = await resolveEventPage(msg?.payload?.pageUuid);
      if (!page) throw new Error('Event not found');
      await _setFinishedInternal(page, !!msg?.payload?.finished, { userId });
      reply(true, { pageUuid: page.uuid });
      return;
    }

    reply(false, null, `Unknown events action: ${action}`);
  } catch (e) {
    console.error('SpaceHolder | Events: GM socket handler failed', e);
    reply(false, null, e?.message || e);
  }
}

export function installEventsSocketHandlers() {
  if (_socketInstalled) return;
  _socketInstalled = true;

  const name = _socketName();
  if (!game?.socket?.on) return;

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
      console.error('SpaceHolder | Events: socket message handler crashed', e);
    }
  });
}

export function installEventsHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  const invalidate = () => _invalidateContainerCache();
  Hooks.on('createJournalEntry', invalidate);
  Hooks.on('deleteJournalEntry', invalidate);
  Hooks.on('updateJournalEntry', invalidate);

  if (game.user?.isGM) {
    let t = null;
    const schedule = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        gmSyncEventsOwnershipForAllFactions().catch(() => {});
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

export function getAvailableFactionChoices({ forUser = game.user, includeAllForGm = true } = {}) {
  const isGm = !!forUser?.isGM;
  const uuids = isGm && includeAllForGm
    ? Array.from(game?.actors?.values?.() ?? game?.actors?.contents ?? []).filter((a) => a?.type === 'faction').map((a) => a.uuid)
    : getUserFactionUuids(forUser);

  const out = [];
  const seen = new Set();
  for (const raw of uuids) {
    const uuid = normalizeUuid(raw);
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    let name = uuid;
    let color = '';
    try {
      const parts = uuid.split('.');
      if (parts[0] === 'Actor' && parts[1] && parts.length === 2) {
        const actor = game?.actors?.get?.(parts[1]) ?? null;
        if (actor) {
          name = actor.name;
          color = _safeString(actor?.system?.fColor);
        }
      }
    } catch (_) {
      // ignore
    }
    out.push({ uuid, name, color });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru', { sensitivity: 'base' }));
  return out;
}

/**
 * Action Log for Actors
 * Хранится в flags.spaceholder.actionLog как массив записей.
 */

function _num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Получить массив записей лога действий для актора.
 * @param {Actor} actor
 * @returns {Array<object>}
 */
export function getActorActionLog(actor) {
  if (!actor) return [];
  const raw = actor.getFlag?.('spaceholder', 'actionLog');
  const list = Array.isArray(raw) ? raw : [];
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const apCost = _num(entry.apCost, 0);
    return {
      id: String(entry.id ?? ''),
      type: String(entry.type ?? 'other'),
      movementId: entry.movementId ?? null,
      tokenUuid: entry.tokenUuid ?? null,
      combatId: entry.combatId ?? null,
      combatantId: entry.combatantId ?? null,
      round: _num(entry.round, 0),
      distance: _num(entry.distance, 0),
      baseApCost: _num(entry.baseApCost, apCost),
      apCost,
      forced: !!entry.forced,
      ignored: !!entry.ignored,
      replacedBy: entry.replacedBy ?? null,
      createdAt: _num(entry.createdAt, Date.now()),
    };
  }).filter(Boolean);
}

/**
 * Сохранить массив записей лога действий.
 * @param {Actor} actor
 * @param {Array<object>} entries
 */
export async function setActorActionLog(actor, entries) {
  if (!actor?.setFlag) return;
  await actor.setFlag('spaceholder', 'actionLog', Array.isArray(entries) ? entries : []);
}

/**
 * Добавить запись в лог действий.
 * @param {Actor} actor
 * @param {object} entry
 */
export async function addActionEntry(actor, entry) {
  if (!actor) return;
  const base = getActorActionLog(actor);
  const now = Date.now();
  const id =
    String(entry?.id ?? '') ||
    (foundry.utils.randomID?.() || globalThis.randomID?.() || globalThis.crypto?.randomUUID?.() || String(now));

  const normalized = {
    id,
    type: String(entry?.type ?? 'other'),
    movementId: entry?.movementId ?? null,
    tokenUuid: entry?.tokenUuid ?? null,
    combatId: entry?.combatId ?? null,
    combatantId: entry?.combatantId ?? null,
    round: _num(entry?.round, 0),
    distance: _num(entry?.distance, 0),
    baseApCost: _num(entry?.baseApCost, _num(entry?.apCost, 0)),
    apCost: Math.max(0, Math.floor(_num(entry?.apCost, 0))),
    forced: !!entry?.forced,
    ignored: !!entry?.ignored,
    replacedBy: entry?.replacedBy ?? null,
    createdAt: _num(entry?.createdAt, now),
  };

  await setActorActionLog(actor, [...base, normalized]);
  return normalized;
}

/**
 * Пометить запись как ignored / не ignored.
 * @param {Actor} actor
 * @param {string} entryId
 * @param {boolean} ignored
 */
export async function markEntryIgnored(actor, entryId, ignored = true) {
  if (!actor || !entryId) return;
  const base = getActorActionLog(actor);
  const next = base.map((e) => (String(e?.id ?? '') === String(entryId) ? { ...e, ignored: !!ignored } : e));
  await setActorActionLog(actor, next);
}

/**
 * Заменить одну запись другой (old -> new), пометив старую replacedBy.
 * @param {Actor} actor
 * @param {string} oldId
 * @param {string} newId
 */
export async function replaceEntry(actor, oldId, newId) {
  if (!actor || !oldId || !newId) return;
  const base = getActorActionLog(actor);
  const next = base.map((e) => (String(e?.id ?? '') === String(oldId) ? { ...e, replacedBy: String(newId) } : e));
  await setActorActionLog(actor, next);
}

/**
 * Очистить лог действий.
 * @param {Actor} actor
 */
export async function clearActorActionLog(actor) {
  if (!actor) return;
  await setActorActionLog(actor, []);
}


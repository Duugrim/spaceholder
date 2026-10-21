/**
 * Client-side copy of the database plus debounced autosave.
 *
 * Tabs mutate `db.<collection>` in place and call `touch(name)`; the store saves the whole collection after
 * a short pause. A save carries the revision it was based on — if the server file moved on (another tab,
 * a script) the save is rejected and the UI asks for a reload instead of overwriting.
 */

import { api } from './api.js';

export const db = { cases: null, items: null, dictionaries: null, anatomy: null };

const SAVE_DELAY_MS = 500;
const versions = { cases: 0, items: 0, dictionaries: 0 };
const dirty = new Set();
let timer = null;
let inFlight = null;
let status = 'saved'; // saved | dirty | saving | error | conflict
const statusListeners = new Set();
const changeListeners = new Set();
let itemIndex = null;

function setStatus(next, detail = '') {
  status = next;
  for (const fn of statusListeners) fn(next, detail);
}

export const onStatus = (fn) => { statusListeners.add(fn); fn(status, ''); return () => statusListeners.delete(fn); };
export const onChange = (fn) => { changeListeners.add(fn); return () => changeListeners.delete(fn); };
export const emitChange = (topic) => { for (const fn of changeListeners) fn(topic); };

export async function load() {
  Object.assign(db, await api.state());
  itemIndex = null;
  setStatus('saved');
}

/** Mark a collection as changed; saves after a pause. */
export function touch(name) {
  versions[name] += 1;
  dirty.add(name);
  if (name === 'items') itemIndex = null;
  if (status !== 'conflict') setStatus('dirty');
  clearTimeout(timer);
  timer = setTimeout(() => { flush(); }, SAVE_DELAY_MS);
}

/** Save everything pending now. */
export async function flush({ keepalive = false } = {}) {
  clearTimeout(timer);
  timer = null;
  if (inFlight) await inFlight;
  if (!dirty.size || status === 'conflict') return;
  inFlight = (async () => {
    setStatus('saving');
    for (const name of [...dirty]) {
      const version = versions[name];
      const doc = db[name];
      try {
        const res = await api.save(name, doc, doc.revision, { keepalive });
        doc.revision = res.revision;
        if (versions[name] === version) dirty.delete(name);
      } catch (e) {
        if (e.status === 409) { setStatus('conflict', e.message); return; }
        setStatus('error', e.message);
        return;
      }
    }
    setStatus(dirty.size ? 'dirty' : 'saved');
    if (dirty.size) timer = setTimeout(() => { flush(); }, SAVE_DELAY_MS);
  })();
  try { await inFlight; } finally { inFlight = null; }
}

export function hasUnsaved() {
  return dirty.size > 0;
}

/** Replace a collection with a document returned by the server (after import). */
export function adoptCollection(name, doc) {
  db[name] = doc;
  versions[name] += 1;
  dirty.delete(name);
  if (name === 'items') itemIndex = null;
}

/* ------------------------------------------------------------------ *
 *  Lookups                                                            *
 * ------------------------------------------------------------------ */

export function itemMap() {
  if (!itemIndex) itemIndex = new Map(db.items.items.map((it) => [it.id, it]));
  return itemIndex;
}

export const getItem = (id) => itemMap().get(id) ?? null;
export const itemsOfKind = (kind) => db.items.items.filter((it) => it.kind === kind);
export const outcomeOf = (id) => db.dictionaries.outcomes.find((o) => o.id === id) ?? null;
export const partOf = (id) => db.dictionaries.parts.find((p) => p.id === id) ?? null;
export const weaponTypeOf = (id) => db.dictionaries.weaponTypes.find((t) => t.id === id) ?? null;

export function materialName(slug) {
  return getItem(`material.${slug}`)?.name ?? slug;
}

/** `Пистолет (9×19)`. */
export function weaponLabel(group) {
  const weapon = group.weapon || 'Оружие';
  return group.ammo ? `${weapon} (${group.ammo})` : weapon;
}

/** Human label of an armour spec. */
export function armorLabel(spec) {
  if (!spec || !spec.kind || spec.kind === 'none') return 'Без брони';
  if (spec.kind === 'preset') return getItem(spec.presetId)?.name ?? '(набор удалён)';
  if (spec.kind === 'item') return getItem(spec.itemId)?.name ?? '(предмет не найден)';
  const text = layersLabel(spec.layers);
  return spec.label ? `${spec.label}: ${text}` : text || 'Свой набор';
}

export function layersLabel(layers) {
  return (layers ?? []).map((l) => `${materialName(l.material)} ${l.thickness} мм`).join(' + ');
}

/** The pagehide/visibility hooks keep the last edits from being lost on close. */
export function installUnloadFlush() {
  const save = () => { if (dirty.size) flush({ keepalive: true }); };
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
}

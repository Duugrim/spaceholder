/**
 * Bridge between the balance database and the built-in test compendium sources (`pack-src/sh-test-items`).
 *
 *  - {@link importFromPackSrc} reads the source JSON and turns materials, ammo, weapons and wearables into
 *    database items (`base` = what the game has now, `values` = the working copy balance edits).
 *  - {@link mergeImport} folds a fresh import into the stored items without losing the user's edits.
 *  - {@link planWriteBack} / {@link applyWriteBack} push changed `values` back into the source JSON. A
 *    magazine or cell carries its own copy of the round (that copy is what a gun fires), so it follows its round.
 *    Packing the sources into LevelDB (`npm run pack:sh-test-items`) is a separate step and needs Foundry closed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TOOL_DIR } from './store.mjs';

export const REPO_DIR = path.resolve(TOOL_DIR, '..', '..');
export const PACK_SRC_DIR = path.join(REPO_DIR, 'pack-src', 'sh-test-items');
const PACK_SCRIPT = 'pack:sh-test-items';

/** Item kinds the compendium bridge produces. */
export const COMPENDIUM_KINDS = Object.freeze(['material', 'ammo', 'weapon', 'armor']);

const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

/** Key-sorted JSON, so two equal values always compare equal as strings. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sameValue = (a, b) => stableStringify(a) === stableStringify(b);

function slugify(text) {
  return String(text ?? '').toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[^a-z0-9а-яё.]+/gi, '-')
    .replace(/^-+|-+$/g, '');
}

/* ------------------------------------------------------------------ *
 *  Source documents                                                   *
 * ------------------------------------------------------------------ */

function readSourceDocs(dir = PACK_SRC_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      return { file, doc: JSON.parse(raw) };
    });
}

function folderPathOf(folders, id) {
  const out = [];
  let cur = folders.get(id);
  while (cur) {
    out.unshift(cur.name);
    cur = folders.get(cur.folder);
  }
  return out;
}

/** Strip the magazine suffix so `9mm-s` and `9mm` are the same caliber. */
export function baseCaliber(caliber) {
  return String(caliber ?? '').replace(/-s$/i, '');
}

/* ------------------------------------------------------------------ *
 *  Adapters: source document <-> item.values                         *
 * ------------------------------------------------------------------ */

const MATERIAL_KEYS = ['category', 'hardness', 'integrityPerThickness', 'breachCapacityPerThickness',
  'weightPerThickness', 'resistance', 'wear', 'damping', 'conductance', 'selfInduction', 'degradation'];
const AMMO_KEYS = ['caliber', 'damage', 'falloff', 'multishot', 'onHitSplash'];
/** What a magazine copies from its round (its own caliber, `9mm-s`, stays). */
const MAGAZINE_KEYS = AMMO_KEYS.filter((k) => k !== 'caliber');
const MAGAZINE_NAME = /^(Магазин|Ячейка)/;

/** @type {Record<string, { read(doc: object, ctx: object): object|null, write(doc: object, values: object): void }>} */
const ADAPTERS = {
  material: {
    read(doc) {
      const sys = doc.system ?? {};
      if (!sys.materialId) return null;
      const values = {};
      for (const k of MATERIAL_KEYS) values[k] = clone(sys[k] ?? (k === 'resistance' || k === 'wear' ? {} : null));
      return { id: `material.${sys.materialId}`, name: doc.name, group: sys.category || 'other', values };
    },
    write(doc, values) {
      for (const k of MATERIAL_KEYS) if (k in values) doc.system[k] = clone(values[k]);
    },
  },
  ammo: {
    read(doc, ctx) {
      const ammo = doc.system?.weapon?.ammo;
      const damage = Array.isArray(ammo?.damage) ? ammo.damage : [];
      if (!damage.some((e) => Number(e?.damage) > 0)) return null;
      if (MAGAZINE_NAME.test(doc.name)) return null; // magazines and cells carry copies of the round
      const values = {};
      for (const k of AMMO_KEYS) values[k] = clone(ammo[k]);
      const id = `ammo.${slugify(baseCaliber(ammo.caliber) || doc.name)}`;
      // Two rounds can share a caliber (rockets): the later one is told apart by its name.
      return { id: ctx.taken?.has(id) ? `${id}-${slugify(doc.name)}` : id, name: doc.name, group: baseCaliber(ammo.caliber), values };
    },
    write(doc, values) {
      for (const k of AMMO_KEYS) if (k in values) doc.system.weapon.ammo[k] = clone(values[k]);
    },
  },
  weapon: {
    read(doc, ctx) {
      const weapon = doc.system?.weapon;
      if (!weapon || !Array.isArray(weapon.lines)) return null;
      const lines = weapon.lines.map((line) => ({
        id: line.id,
        name: line.name,
        energyMult: clone(line.energyMult ?? { enabled: false, value: 100 }),
        damage: clone(line.damage ?? []),
        calibers: (line.ammoBlocks ?? []).map((b) => baseCaliber(b.caliber)).filter(Boolean),
      }));
      const path_ = ctx.folderPath ?? [];
      return {
        id: `weapon.${slugify(doc.name)}`,
        name: doc.name,
        group: path_[path_.length - 1] ?? '',
        values: { family: path_[1] ?? '', lines },
      };
    },
    write(doc, values) {
      for (const line of values.lines ?? []) {
        const target = (doc.system.weapon.lines ?? []).find((l) => l.id === line.id);
        if (!target) continue;
        target.energyMult = clone(line.energyMult);
        target.damage = clone(line.damage);
      }
    },
  },
  armor: {
    read(doc) {
      const sys = doc.system ?? {};
      if (!sys.itemTags?.isArmor || !Array.isArray(sys.coveredParts)) return null;
      return {
        id: `armor.${slugify(doc.name)}`,
        name: doc.name,
        group: '',
        values: { anatomyId: sys.anatomyId || 'humanoid', coveredParts: clone(sys.coveredParts) },
      };
    },
    write(doc, values) {
      if ('coveredParts' in values) doc.system.coveredParts = clone(values.coveredParts);
    },
  },
};

function kindOfDoc(doc) {
  if (doc.type === 'material') return 'material';
  const tags = doc.system?.itemTags ?? {};
  if (tags.isAmmo) return 'ammo';
  if (tags.isWeapon) return 'weapon';
  if (tags.isArmor) return 'armor';
  return null;
}

/* ------------------------------------------------------------------ *
 *  Import                                                             *
 * ------------------------------------------------------------------ */

/**
 * Records are read in the compendium's own order (`sort`), so of two rounds of one caliber the first one in
 * its folder keeps the plain id (`ammo.9mm`) whatever the file names.
 * @param {string} [dir]
 * @returns {Array<object>} database items with `base` and `values` (equal) and `source`
 */
export function importFromPackSrc(dir = PACK_SRC_DIR) {
  const docs = readSourceDocs(dir)
    .sort((a, b) => (Number(a.doc.sort) || 0) - (Number(b.doc.sort) || 0) || a.file.localeCompare(b.file));
  const folders = new Map(docs.filter(({ doc }) => doc.type === 'Item').map(({ doc }) => [doc._id, doc]));
  const out = [];
  const seen = new Set();
  for (const { file, doc } of docs) {
    const kind = kindOfDoc(doc);
    if (!kind) continue;
    const ctx = { folderPath: folderPathOf(folders, doc.folder), taken: seen };
    const read = ADAPTERS[kind].read(doc, ctx);
    if (!read || seen.has(read.id)) continue;
    seen.add(read.id);
    out.push({
      id: read.id,
      kind,
      name: read.name,
      group: read.group,
      status: 'draft',
      source: { type: 'compendium', file, docId: doc._id },
      base: clone(read.values),
      values: clone(read.values),
      notes: '',
    });
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'ru'));
}

/**
 * Fold a fresh import into stored items. New items arrive as drafts; for existing compendium items the
 * `base` is refreshed and `values` follow it only when the user never edited them.
 * @param {Array<object>} stored
 * @param {Array<object>} imported
 * @returns {{ items: Array<object>, added: number, refreshed: number, kept: number, missing: number }}
 */
export function mergeImport(stored, imported) {
  const byId = new Map(stored.map((it) => [it.id, it]));
  const importedIds = new Set(imported.map((it) => it.id));
  let added = 0;
  let refreshed = 0;
  let kept = 0;
  const items = [...stored];
  for (const fresh of imported) {
    const old = byId.get(fresh.id);
    if (!old) {
      items.push(fresh);
      added += 1;
      continue;
    }
    if (old.source?.type !== 'compendium') continue;
    const untouched = sameValue(old.values, old.base);
    old.name = fresh.name;
    old.group = fresh.group;
    old.source = fresh.source;
    old.missing = false;
    if (!sameValue(old.base, fresh.base)) {
      if (untouched) {
        old.values = clone(fresh.values);
        refreshed += 1;
      } else if (sameValue(old.values, fresh.base)) {
        // The edits were written back to the compendium: the game now has exactly the working values.
        old.baseChanged = false;
      } else {
        old.baseChanged = true;
        kept += 1;
      }
      old.base = clone(fresh.base);
    }
  }
  let missing = 0;
  for (const it of items) {
    if (it.source?.type === 'compendium' && !importedIds.has(it.id)) {
      it.missing = true;
      missing += 1;
    }
  }
  return { items, added, refreshed, kept, missing };
}

/* ------------------------------------------------------------------ *
 *  Write back                                                         *
 * ------------------------------------------------------------------ */

function listChangedKeys(item) {
  const keys = new Set([...Object.keys(item.base ?? {}), ...Object.keys(item.values ?? {})]);
  return [...keys].filter((k) => !sameValue(item.base?.[k], item.values?.[k]));
}

/**
 * Magazines and cells loaded with a round: the same caliber (`9mm-s` ↔ `9mm`) and a copy of the round as the
 * game has it now (`base`). Another load of the caliber (an AP round) has its own magazine with its own copy.
 * @param {object} item database ammo item
 * @param {Array<{file: string, doc: object}>} docs source documents
 */
function magazinesOf(item, docs) {
  const base = item.base ?? {};
  return docs.filter(({ doc }) => {
    const ammo = doc.system?.weapon?.ammo;
    return MAGAZINE_NAME.test(doc.name ?? '') && ammo && baseCaliber(ammo.caliber) === baseCaliber(base.caliber)
      && MAGAZINE_KEYS.every((k) => sameValue(ammo[k], base[k]));
  });
}

/**
 * @param {Array<object>} items database items
 * @param {string} [dir]
 * @returns {Array<{ id: string, name: string, kind: string, file: string, keys: string[], follows?: string }>}
 *   `follows` — the round a magazine entry copies
 */
export function planWriteBack(items, dir = PACK_SRC_DIR) {
  const plan = [];
  let docs = null;
  for (const item of items) {
    if (item.source?.type !== 'compendium' || !COMPENDIUM_KINDS.includes(item.kind)) continue;
    const keys = listChangedKeys(item);
    if (!keys.length) continue;
    const file = item.source.file;
    if (!file || file.includes('/') || file.includes('\\') || !fs.existsSync(path.join(dir, file))) continue;
    plan.push({ id: item.id, name: item.name, kind: item.kind, file, keys });
    const magazineKeys = item.kind === 'ammo' ? keys.filter((k) => MAGAZINE_KEYS.includes(k)) : [];
    if (!magazineKeys.length) continue;
    docs ??= readSourceDocs(dir);
    for (const mag of magazinesOf(item, docs)) {
      plan.push({ id: item.id, name: mag.doc.name, kind: item.kind, file: mag.file, keys: magazineKeys, follows: item.id });
    }
  }
  return plan;
}

function detectEol(raw) {
  return raw.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Write changed `values` into the source JSON files. A file is rewritten as `JSON.stringify(doc, null, 2)`
 * with its original line endings and trailing newline.
 * @returns {{ written: string[] }}
 */
export function applyWriteBack(items, dir = PACK_SRC_DIR) {
  const written = [];
  for (const entry of planWriteBack(items, dir)) {
    const item = items.find((it) => it.id === entry.id);
    const full = path.join(dir, entry.file);
    const raw = fs.readFileSync(full, 'utf8');
    const eol = detectEol(raw);
    const doc = JSON.parse(raw);
    const values = entry.follows
      ? Object.fromEntries(MAGAZINE_KEYS.filter((k) => k in (item.values ?? {})).map((k) => [k, item.values[k]]))
      : item.values;
    ADAPTERS[item.kind].write(doc, values);
    let text = JSON.stringify(doc, null, 2);
    if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
    if (/\r?\n$/.test(raw)) text += eol;
    fs.writeFileSync(full, text, 'utf8');
    written.push(entry.file);
  }
  return { written };
}

/** Whether re-serialising a source file leaves it byte-identical (a write-back would not churn the diff). */
export function roundTripIsClean(dir = PACK_SRC_DIR, sample = 5) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).slice(0, sample);
  return files.every((file) => {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const eol = detectEol(raw);
    let text = JSON.stringify(JSON.parse(raw), null, 2);
    if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
    if (/\r?\n$/.test(raw)) text += eol;
    return text === raw;
  });
}

/**
 * Run `npm run pack:sh-test-items` (writes the LevelDB pack in place; Foundry must be closed).
 * @returns {Promise<{ code: number, output: string }>}
 */
export function runPack() {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', PACK_SCRIPT], { cwd: REPO_DIR, shell: true });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('error', (e) => resolve({ code: -1, output: String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, output }));
  });
}

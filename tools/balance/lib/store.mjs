/**
 * JSON document store for the balance tool.
 *
 * Every collection (`cases`, `items`, `dictionaries`) is one JSON file in `data/`. A write replaces the
 * whole document atomically (temp file + rename) and bumps `revision`; a client that saves with a stale
 * revision gets a conflict instead of silently overwriting a newer save from another tab.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_DIR = path.resolve(HERE, '..');
/** `BALANCE_DATA_DIR` lets the smoke tests work in a scratch folder instead of the real data. */
export const DATA_DIR = process.env.BALANCE_DATA_DIR ? path.resolve(process.env.BALANCE_DATA_DIR) : path.join(TOOL_DIR, 'data');
export const BACKUP_DIR = path.join(DATA_DIR, '.backups');

/** Collections the API may read and write. */
export const COLLECTIONS = Object.freeze(['cases', 'items', 'dictionaries']);

const BACKUPS_KEPT = 15;

export class ConflictError extends Error {
  constructor(name, current) {
    super(`Collection "${name}" changed elsewhere (revision ${current}).`);
    this.name = 'ConflictError';
    this.currentRevision = current;
  }
}

function filePath(name) {
  if (!COLLECTIONS.includes(name)) throw new Error(`Unknown collection "${name}"`);
  return path.join(DATA_DIR, `${name}.json`);
}

/** @param {string} name */
export function readCollection(name) {
  const file = filePath(name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {string} name
 * @param {object} doc
 * @param {{ expectedRevision?: number|null }} [options] `null`/missing skips the conflict check
 * @returns {object} the stored document (with the new `revision`)
 */
export function writeCollection(name, doc, { expectedRevision = null } = {}) {
  const file = filePath(name);
  const current = readCollection(name);
  const currentRevision = Number(current?.revision) || 0;
  if (expectedRevision != null && current && Number(expectedRevision) !== currentRevision) {
    throw new ConflictError(name, currentRevision);
  }
  const next = { ...doc, revision: currentRevision + 1 };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 1)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

/** Copy every data file into `data/.backups/` (called once at server start). */
export function backupAll(now = new Date()) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  for (const name of COLLECTIONS) {
    const file = filePath(name);
    if (!fs.existsSync(file)) continue;
    fs.copyFileSync(file, path.join(BACKUP_DIR, `${name}.${stamp}.json`));
    const mine = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith(`${name}.`) && f.endsWith('.json'))
      .sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - BACKUPS_KEPT))) {
      fs.rmSync(path.join(BACKUP_DIR, old), { force: true });
    }
  }
}

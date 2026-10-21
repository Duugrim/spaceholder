/**
 * Balance tool server: static web UI + a small JSON API over the data files.
 *
 *   node tools/balance/server.mjs [--port 8766] [--open]
 *
 * Listens on 127.0.0.1 only. No dependencies — Node's `http` module is enough.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  COLLECTIONS, ConflictError, TOOL_DIR, backupAll, readCollection, writeCollection,
} from './lib/store.mjs';
import {
  applyWriteBack, importFromPackSrc, mergeImport, planWriteBack, roundTripIsClean, runPack,
} from './lib/compendium.mjs';
import { loadAnatomy, simulate } from './lib/engine.mjs';
import { checkCases } from './lib/outcome.mjs';
import { buildMarkdown } from './lib/export-md.mjs';
import { seedCases, seedDictionaries, seedPresets } from './lib/seed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, 'web');
const EXPORT_DIR = path.join(TOOL_DIR, 'exports');
const DEFAULT_PORT = 8766;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};

/* ------------------------------------------------------------------ *
 *  First run                                                          *
 * ------------------------------------------------------------------ */

/** Create any data file that is missing; items are imported from the compendium sources. */
export function ensureData() {
  const created = [];
  if (!readCollection('dictionaries')) { writeCollection('dictionaries', seedDictionaries()); created.push('dictionaries'); }
  if (!readCollection('items')) {
    const imported = importFromPackSrc();
    writeCollection('items', { version: 1, items: [...imported, ...seedPresets(imported)] });
    created.push('items');
  }
  if (!readCollection('cases')) { writeCollection('cases', seedCases()); created.push('cases'); }
  return created;
}

/* ------------------------------------------------------------------ *
 *  API                                                                *
 * ------------------------------------------------------------------ */

function anatomySummary(id = 'humanoid') {
  const a = loadAnatomy(id);
  return {
    id: a.id,
    name: a.name,
    parts: Object.entries(a.bodyParts).map(([slot, p]) => ({ slot, name: p.name, maxHp: p.maxHp, material: p.material, faces: p.faces })),
  };
}

const dbNow = () => ({
  cases: readCollection('cases'),
  items: readCollection('items'),
  dictionaries: readCollection('dictionaries'),
});

const sim = (extra = {}) => ({
  valuesMode: extra.valuesMode === 'base' ? 'base' : 'values',
  falloff: extra.falloff !== false,
  random: extra.random,
  shots: 1,
});

/** @type {Record<string, (body: any, query: URLSearchParams) => any | Promise<any>>} */
const ROUTES = {
  'GET /api/state': () => ({ ...dbNow(), anatomy: anatomySummary('humanoid') }),

  'POST /api/import': () => {
    const items = readCollection('items');
    const merged = mergeImport(items.items, importFromPackSrc());
    const doc = writeCollection('items', { ...items, items: merged.items });
    return { doc, stats: { added: merged.added, refreshed: merged.refreshed, kept: merged.kept, missing: merged.missing } };
  },

  'POST /api/simulate': (body) => {
    const { items } = dbNow();
    try {
      return simulate(body, items.items);
    } catch (e) {
      throw Object.assign(e, { status: 400 }); // a bad scenario (unknown item, part...) is the caller's problem
    }
  },

  'POST /api/check': (body) => {
    const { cases, items, dictionaries } = dbNow();
    return { results: checkCases({ groups: cases.groups, rows: cases.rows, dictionaries, items: items.items, extra: sim(body) }) };
  },

  'GET /api/export': (_body, query) => {
    const text = buildMarkdown(dbNow());
    let savedTo = null;
    if (query.get('save')) {
      fs.mkdirSync(EXPORT_DIR, { recursive: true });
      savedTo = path.join(EXPORT_DIR, 'balance-cases.md');
      fs.writeFileSync(savedTo, text, 'utf8');
    }
    return { text, savedTo };
  },

  'POST /api/writeback/plan': () => ({ plan: planWriteBack(readCollection('items').items), cleanRoundTrip: roundTripIsClean() }),
  'POST /api/writeback/apply': () => applyWriteBack(readCollection('items').items),
  'POST /api/writeback/pack': () => runPack(),
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Same-origin guard: the page is only ever opened on the loopback address. */
function isLocalRequest(req, port) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return allowedHosts.has(new URL(origin).host.toLowerCase());
  } catch {
    return false;
  }
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  const collectionMatch = url.pathname.match(/^\/api\/(cases|items|dictionaries)$/);
  if (collectionMatch && req.method === 'PUT') {
    const name = collectionMatch[1];
    if (!COLLECTIONS.includes(name)) return sendJson(res, 404, { error: 'Unknown collection' });
    const body = await readBody(req);
    if (!body.doc || typeof body.doc !== 'object') return sendJson(res, 400, { error: 'Missing "doc"' });
    try {
      const doc = writeCollection(name, body.doc, { expectedRevision: body.expectedRevision ?? null });
      return sendJson(res, 200, { revision: doc.revision });
    } catch (e) {
      if (e instanceof ConflictError) return sendJson(res, 409, { error: e.message, revision: e.currentRevision });
      throw e;
    }
  }

  const handler = ROUTES[route];
  if (!handler) return sendJson(res, 404, { error: `No route ${route}` });
  const body = req.method === 'GET' ? {} : await readBody(req);
  return sendJson(res, 200, await handler(body, url.searchParams));
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  return fs.createReadStream(file).pipe(res);
}

/**
 * @param {{ port?: number }} [options]
 * @returns {Promise<http.Server>}
 */
export function startServer({ port = DEFAULT_PORT } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (!isLocalRequest(req, port)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Forbidden');
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(res, url.pathname);
    } catch (e) {
      if (!e.status || e.status >= 500) console.error(e);
      return sendJson(res, e.status ?? 500, { error: String(e.message ?? e) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/* ------------------------------------------------------------------ *
 *  CLI                                                                *
 * ------------------------------------------------------------------ */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const port = portArg >= 0 ? Number(args[portArg + 1]) || DEFAULT_PORT : DEFAULT_PORT;
  backupAll();
  const created = ensureData();
  if (created.length) console.log(`Created data files: ${created.join(', ')}`);
  startServer({ port }).then(() => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`SpaceHolder balance tool: ${url}`);
    console.log('Close this window (or press Ctrl+C) to stop the server.');
    if (args.includes('--open')) spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  }).catch((e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy — another instance is probably running.` : e);
    process.exit(1);
  });
}

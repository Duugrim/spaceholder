/**
 * Smoke tests for the balance tool's storage, compendium bridge and HTTP API. Plain Node:
 *   node tools/balance/test/store-api.test.mjs
 *
 * Everything runs in a scratch folder (`BALANCE_DATA_DIR`, a copy of a few pack-src files); the real data
 * and the real compendium sources are never written.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-test-'));
process.env.BALANCE_DATA_DIR = path.join(scratch, 'data');

const store = await import('../lib/store.mjs');
const compendium = await import('../lib/compendium.mjs');
const { ensureData, startServer } = await import('../server.mjs');

let failed = 0;
function assert(label, cond, detail) {
  if (cond) console.log(`PASS  ${label}`);
  else { failed += 1; console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`); }
}

/* ---- store ------------------------------------------------------ */

{
  const first = store.writeCollection('cases', { version: 1, groups: [], rows: [] });
  assert('first write gets revision 1', first.revision === 1);
  const second = store.writeCollection('cases', { ...first, rows: [{ id: 'a' }] }, { expectedRevision: 1 });
  assert('a write with the current revision bumps it', second.revision === 2);
  let conflict = null;
  try { store.writeCollection('cases', first, { expectedRevision: 1 }); } catch (e) { conflict = e; }
  assert('a stale revision is a conflict', conflict instanceof store.ConflictError && conflict.currentRevision === 2);
  assert('the conflicting write did not land', store.readCollection('cases').rows.length === 1);
  let unknown = false;
  try { store.readCollection('../secrets'); } catch { unknown = true; }
  assert('only known collections can be addressed', unknown);

  for (let i = 0; i < 20; i += 1) store.backupAll(new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
  const backups = fs.readdirSync(store.BACKUP_DIR).filter((f) => f.startsWith('cases.'));
  assert('backups are pruned to a fixed count', backups.length === 15, `${backups.length}`);
  assert('the newest backups survive', backups.includes('cases.2026-01-01T00-00-19-000Z.json'));
}

/* ---- compendium bridge ----------------------------------------- */

const packDir = path.join(scratch, 'pack');
fs.mkdirSync(packDir);
const wanted = ['SH_Ammo_9mm_round', 'SH_Material_bone', 'SH_Wear_vest-light', 'SH_Wpn_glock', 'SH_Ammo_9mm_mag_s'];
for (const f of fs.readdirSync(compendium.PACK_SRC_DIR)) {
  if (wanted.some((w) => f.startsWith(w)) || /^SH_Folder|Folder/.test(f)) fs.copyFileSync(path.join(compendium.PACK_SRC_DIR, f), path.join(packDir, f));
}

{
  const imported = compendium.importFromPackSrc(packDir);
  const kinds = imported.map((i) => i.kind).sort().join();
  assert('import finds the ammo round, material, armour and weapon', kinds === 'ammo,armor,material,weapon', kinds);
  assert('magazines are not imported as ammo', imported.filter((i) => i.kind === 'ammo').length === 1);
  assert('values start equal to base', imported.every((i) => compendium.sameValue(i.values, i.base)));
  assert('an untouched import has nothing to write back', compendium.planWriteBack(imported, packDir).length === 0);

  const items = imported.map((i) => JSON.parse(JSON.stringify(i)));
  const ammo = items.find((i) => i.kind === 'ammo');
  const material = items.find((i) => i.kind === 'material');
  const ammoFile = path.join(packDir, ammo.source.file);
  const before = JSON.parse(fs.readFileSync(ammoFile, 'utf8'));
  ammo.values.damage[0].damage = 77;
  material.values.hardness = 9.5;
  const plan = compendium.planWriteBack(items, packDir);
  assert('a plan lists exactly the changed records and keys', plan.length === 3 && plan.find((p) => p.kind === 'ammo').keys.join() === 'damage');
  const magEntry = plan.find((p) => p.follows === ammo.id);
  assert('the magazine loaded with that round follows it', magEntry && /^SH_Ammo_9mm_mag_s/.test(magEntry.file) && magEntry.keys.join() === 'damage', JSON.stringify(plan));
  const { written } = compendium.applyWriteBack(items, packDir);
  assert('write-back rewrites the three files', written.length === 3);
  const after = JSON.parse(fs.readFileSync(ammoFile, 'utf8'));
  assert('write-back changed the value', after.system.weapon.ammo.damage[0].damage === 77);
  const mag = JSON.parse(fs.readFileSync(path.join(packDir, magEntry.file), 'utf8'));
  assert('the magazine got the new value and kept its own caliber', mag.system.weapon.ammo.damage[0].damage === 77 && mag.system.weapon.ammo.caliber === '9mm-s');
  after.system.weapon.ammo.damage[0].damage = before.system.weapon.ammo.damage[0].damage;
  assert('nothing else in the file changed', compendium.sameValue(after, before));

  // The edits are now in the sources: a re-import must adopt them quietly.
  const merged = compendium.mergeImport(items, compendium.importFromPackSrc(packDir));
  const mergedAmmo = merged.items.find((i) => i.kind === 'ammo');
  assert('after write-back the base follows the values without a warning', compendium.sameValue(mergedAmmo.base, mergedAmmo.values) && !mergedAmmo.baseChanged);
}

{
  const old = (id, base, values) => ({ id, kind: 'material', name: id, status: 'draft', source: { type: 'compendium', file: `${id}.json` }, base, values });
  const stored = [old('material.a', { hardness: 1 }, { hardness: 1 }), old('material.b', { hardness: 2 }, { hardness: 5 }), old('material.gone', { hardness: 3 }, { hardness: 3 }),
    { id: 'preset.x', kind: 'preset', name: 'x', source: { type: 'custom' }, base: null, values: { layers: [] } }];
  const fresh = [
    { ...old('material.a', { hardness: 10 }, { hardness: 10 }) },
    { ...old('material.b', { hardness: 20 }, { hardness: 20 }) },
    { ...old('material.new', { hardness: 4 }, { hardness: 4 }) },
  ];
  const res = compendium.mergeImport(stored, fresh);
  const byId = Object.fromEntries(res.items.map((i) => [i.id, i]));
  assert('an untouched record follows the new game values', byId['material.a'].values.hardness === 10 && res.refreshed === 1);
  assert('an edited record keeps the edit and is flagged', byId['material.b'].values.hardness === 5 && byId['material.b'].baseChanged === true && byId['material.b'].base.hardness === 20);
  assert('a new compendium record arrives as a draft', byId['material.new'].status === 'draft' && res.added === 1);
  assert('a record gone from the compendium is marked missing', byId['material.gone'].missing === true && res.missing === 1);
  assert('custom items are left alone', byId['preset.x'].values.layers.length === 0 && !byId['preset.x'].missing);
}

/* ---- seed and API ----------------------------------------------- */

{
  fs.rmSync(store.DATA_DIR, { recursive: true, force: true });
  const created = ensureData();
  assert('first run creates every data file', created.sort().join() === 'cases,dictionaries,items');
  const cases = store.readCollection('cases');
  const dict = store.readCollection('dictionaries');
  const items = store.readCollection('items').items;
  const ids = new Set(items.map((i) => i.id));
  assert('seed cases reference existing types, parts and ammo',
    cases.groups.every((g) => dict.weaponTypes.some((t) => t.id === g.weaponType) && dict.parts.some((p) => p.id === g.part) && (!g.ammoItem || ids.has(g.ammoItem))));
  assert('seed rows reference existing groups and armour', cases.rows.every((r) => cases.groups.some((g) => g.id === r.groupId)
    && (r.armor.kind !== 'preset' || ids.has(r.armor.presetId)) && (r.armor.kind !== 'item' || ids.has(r.armor.itemId))));
  assert('seed outcomes start empty', cases.rows.every((r) => r.worst === null && r.best === null));
  assert('the case seed is a small example set', cases.groups.length === 1 && cases.rows.length === 3);
  assert('case rows carry no review or legacy fields', cases.rows.every((r) => !('review' in r) && !('legacy' in r)));
  assert('seed presets carry layers copied from the game armour', items.filter((i) => i.kind === 'preset' && i.source.from).every((i) => i.values.layers.length > 0));
}

{
  const port = 18766;
  const server = await startServer({ port });
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null), res };
  };
  try {
    const state = await call('GET', '/api/state');
    assert('state returns the three collections and the anatomy', state.status === 200 && state.json.cases && state.json.items && state.json.dictionaries && state.json.anatomy.parts.length > 5);

    const check = await call('POST', '/api/check', {});
    assert('check simulates every linked case row', check.status === 200 && check.json.results.some((r) => r.ok));
    const linked = state.json.cases.rows.filter((r) => state.json.cases.groups.find((g) => g.id === r.groupId)?.ammoItem);
    assert('every linked seed row can be simulated', check.json.results.filter((r) => r.ok).length === linked.length);

    const sim = await call('POST', '/api/simulate', { source: { kind: 'ammo', itemId: 'ammo.9mm' }, elements: [{ type: 'target', distance: 0, partId: 'head', armor: { kind: 'none' } }] });
    assert('simulate answers over HTTP', sim.status === 200 && sim.json.target.shots[0].entry.total > 0);

    const bad = await call('POST', '/api/simulate', { source: { kind: 'ammo', itemId: 'ammo.nope' }, elements: [] });
    assert('a bad scenario is a 400 with a message', bad.status === 400 && /ammo\.nope/.test(bad.json.error));

    const doc = state.json.cases;
    const saved = await call('PUT', '/api/cases', { doc, expectedRevision: doc.revision });
    assert('a save with the current revision succeeds', saved.status === 200 && saved.json.revision === doc.revision + 1);
    const stale = await call('PUT', '/api/cases', { doc, expectedRevision: doc.revision });
    assert('a stale save is rejected with 409', stale.status === 409);

    const md = await call('GET', '/api/export');
    assert('the export is Markdown with the case tables', md.status === 200 && md.json.text.startsWith('# База случаев баланса') && md.json.text.includes('| Броня |'));

    // fetch() cannot forge a Host header, so a raw request stands in for a DNS-rebinding page.
    const rawStatus = (headers) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/state', headers }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert('a foreign Host header is refused', await rawStatus({ Host: 'evil.example' }) === 403);
    assert('the loopback Host header is accepted', await rawStatus({ Host: `localhost:${port}` }) === 200);
    assert('a foreign Origin is refused', await rawStatus({ Host: `127.0.0.1:${port}`, Origin: 'http://evil.example' }) === 403);

    const traversal = await fetch(`http://127.0.0.1:${port}/..%2f..%2fpackage.json`);
    assert('static files cannot escape the web folder', traversal.status === 404);
    const index = await fetch(`http://127.0.0.1:${port}/`);
    assert('the index page is served', index.status === 200 && (await index.text()).includes('<title>Баланс SpaceHolder</title>'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

fs.rmSync(scratch, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll balance store/API tests passed');

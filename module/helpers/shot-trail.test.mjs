/**
 * Smoke tests for shot trails: the fade curve and the shot record (build, sanitize, chat flag).
 * Runs in plain Node (no Foundry globals required). Execute with:
 *   node module/helpers/shot-trail.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if
 * any assertion fails.
 */

import {
  ACTION_JOURNAL_FLAG_KEY,
  ATTACK_LOG_FLAG_KEY,
  DEFAULT_SHOT_TRAIL_FADE_SECONDS,
  SHOT_FLAG_KEY,
  SHOT_FLAG_SCOPE,
  buildShotRecord,
  chainLinePaths,
  makeShotId,
  readShotRecords,
  sanitizeShotRecord,
  shotTrailAlpha,
  shotTrailFadeMs,
  trailNowMs,
} from './shot-trail.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* -------------------------------------------- */
/*  Fade curve                                  */
/* -------------------------------------------- */

const FADE = 60_000;

assert('alpha: full brightness at the moment of the shot', shotTrailAlpha(0, FADE) === 1);
assert('alpha: negative age (clock skew) stays full', shotTrailAlpha(-500, FADE) === 1);
assert('alpha: gone at the end of the lifetime', shotTrailAlpha(FADE, FADE) === 0);
assert('alpha: gone past the lifetime', shotTrailAlpha(FADE * 2, FADE) === 0);

let monotonic = true;
let prev = 1;
for (let age = 0; age <= FADE; age += 250) {
  const a = shotTrailAlpha(age, FADE);
  if (a > prev + 1e-12 || a < 0 || a > 1) monotonic = false;
  prev = a;
}
assert('alpha: never rises, stays within 0..1', monotonic);

let maxStep = 0;
let last = shotTrailAlpha(0, FADE);
for (let age = 10; age <= FADE; age += 10) {
  const a = shotTrailAlpha(age, FADE);
  maxStep = Math.max(maxStep, Math.abs(a - last));
  last = a;
}
assert('alpha: no visible jump between 10 ms steps (smooth fade)', maxStep < 0.01, { maxStep });

assert('alpha: scales with the lifetime', near(shotTrailAlpha(5_000, 10_000), shotTrailAlpha(30_000, 60_000)));
assert('alpha: tolerates a zero lifetime', shotTrailAlpha(10, 0) === 0);

assert('fadeMs: default for junk input', shotTrailFadeMs('nope') === DEFAULT_SHOT_TRAIL_FADE_SECONDS * 1000);
assert('fadeMs: clamps below the minimum', shotTrailFadeMs(1) === 5_000);
assert('fadeMs: clamps above the maximum', shotTrailFadeMs(99_999) === 600_000);
assert('fadeMs: converts seconds', shotTrailFadeMs(30) === 30_000);

/* -------------------------------------------- */
/*  Record                                      */
/* -------------------------------------------- */

const fakeToken = { id: 'tok1' };
const shot = {
  uid: 'shot_abc',
  shotResult: {
    shotPaths: [
      { type: 'line', start: { x: 10.04, y: 20.06 }, end: { x: 300, y: 400 } },
      { type: 'circle', start: { x: 300, y: 400 }, range: 50 },
      { type: 'cone', start: { x: 1, y: 2 }, range: 80, angle: 45, direction: 90, cut: 0 },
      { type: 'swing', start: { x: 0, y: 0 }, range: 90, angle: 120, direction: 10, cut: 5, side: 'LEFT', edgeDeg: 33.33 },
      { type: 'line', start: { x: 1, y: 1 } }, // no end → not drawable
      { type: 'mystery', start: { x: 1, y: 1 } },
    ],
    shotHits: [
      { point: { x: 300, y: 400 }, type: 'token', object: fakeToken, centrality: 0.9, details: { big: 1 } },
      {
        point: { x: 5, y: 5 },
        type: 'token',
        object: fakeToken,
        hitPoints: Array.from({ length: 62 }, (_, i) => ({ x: i, y: i * 2 })),
      },
      { point: { x: NaN, y: 1 } },
    ],
    wallPasses: [
      { entryPoint: { x: 1, y: 1 }, exitPoint: { x: 2, y: 2 }, penetrated: true },
      { entryPoint: { x: 3, y: 3 }, exitPoint: null, penetrated: false },
    ],
  },
};

const record = buildShotRecord(shot, { t: 1_700_000_000_000, sceneId: 'scene1', tokenId: 'tok1', userId: 'user1' });

assert('record: carries id, time and origin metadata',
  record.v === 1 && record.id === 'shot_abc' && record.t === 1_700_000_000_000
  && record.sceneId === 'scene1' && record.tokenId === 'tok1' && record.userId === 'user1', record);
assert('record: keeps only drawable paths', record.paths.length === 4, record.paths.map((p) => p.type));
assert('record: rounds coordinates to 0.1', record.paths[0].start.x === 10 && record.paths[0].start.y === 20.1, record.paths[0]);
assert('record: keeps cut = 0', record.paths[2].cut === 0);
assert('record: swing keeps side and stop angle', record.paths[3].side === 'left' && record.paths[3].edgeDeg === 33.3, record.paths[3]);
assert('record: drops invalid hits', record.hits.length === 2, record.hits);
assert('record: strips live objects and combat details',
  record.hits.every((h) => !('object' in h) && !('centrality' in h) && !('details' in h)), record.hits[0]);
assert('record: caps AoE coverage samples', record.hits[1].hitPoints.length === 32, record.hits[1].hitPoints.length);
assert('record: keeps only penetrated walls', record.wallPasses.length === 1 && record.wallPasses[0].exitPoint.x === 2, record.wallPasses);

const json = JSON.stringify(record);
assert('record: survives a JSON round trip unchanged', JSON.stringify(JSON.parse(json)) === json);
assert('record: stays small for a typical shot', json.length < 1500, json.length);

/* -------------------------------------------- */
/*  Sanitizing incoming flags                   */
/* -------------------------------------------- */

assert('sanitize: accepts a built record', sanitizeShotRecord(JSON.parse(json))?.id === 'shot_abc');
assert('sanitize: rejects null / non-objects', sanitizeShotRecord(null) === null && sanitizeShotRecord('x') === null);
assert('sanitize: rejects an unknown version', sanitizeShotRecord({ ...record, v: 2 }) === null);
assert('sanitize: rejects a record without id', sanitizeShotRecord({ ...record, id: '' }) === null);
assert('sanitize: rejects a record without time', sanitizeShotRecord({ ...record, t: 'now' }) === null);
assert('sanitize: rejects an uptime stamp (earlier versions stored game.time.serverTime, which restarts with the server)',
  sanitizeShotRecord({ ...record, t: 190736 }) === null);
assert('trailNowMs is an epoch time', trailNowMs() > 1e12 && Math.abs(trailNowMs() - Date.now()) < 1000);
assert('a record stamped now builds with an epoch time',
  buildShotRecord(shot, { sceneId: 's' }).t > 1e12);
assert('sanitize: rejects a record with nothing to draw', sanitizeShotRecord({ ...record, paths: [] }) === null);
assert('sanitize: rejects a record whose paths are all junk',
  sanitizeShotRecord({ ...record, paths: [{ type: 'line' }, 7, null] }) === null);

const hostile = sanitizeShotRecord({
  ...record,
  paths: Array.from({ length: 500 }, () => ({ type: 'line', start: { x: 1e12, y: -1e12 }, end: { x: 1, y: 1 } })),
  hits: Array.from({ length: 500 }, () => ({ point: { x: 1, y: 1 } })),
});
assert('sanitize: bounds the number of paths and hits', hostile.paths.length === 64 && hostile.hits.length === 64);
assert('sanitize: bounds coordinates', hostile.paths[0].start.x === 1e6 && hostile.paths[0].start.y === -1e6, hostile.paths[0]);
assert('sanitize: quiet only when strictly true',
  sanitizeShotRecord({ ...record, quiet: true }).quiet === true && sanitizeShotRecord({ ...record, quiet: 'yes' }).quiet === undefined);

/* -------------------------------------------- */
/*  Chat flag                                   */
/* -------------------------------------------- */

const msg = (spaceholderFlags) => ({ flags: { [SHOT_FLAG_SCOPE]: spaceholderFlags } });
const rec = (id) => ({ ...record, id });
const attackLog = (...ids) => ({ shots: ids.map((id) => ({ n: 1, records: [rec(id)] })) });

assert('read: a lone record (older messages)', readShotRecords(msg({ [SHOT_FLAG_KEY]: record })).map((r) => r.id).join() === 'shot_abc');
assert('read: the records of a standalone attack message',
  readShotRecords(msg({ [ATTACK_LOG_FLAG_KEY]: attackLog('a', 'b') })).map((r) => r.id).join() === 'a,b');
assert('read: the attack rows of a combat journal, also those nested as reactions',
  readShotRecords(msg({
    [ACTION_JOURNAL_FLAG_KEY]: {
      lines: [
        { kind: 'action' },
        { kind: 'attack', attack: attackLog('x') },
        { kind: 'moveGroup', segments: [{ reactions: [{ kind: 'attack', attack: attackLog('y', 'z') }] }] },
      ],
    },
  })).map((r) => r.id).join() === 'x,y,z');
assert('read: a shot without a drawing is skipped',
  readShotRecords(msg({ [ATTACK_LOG_FLAG_KEY]: { shots: [{ n: 1, records: [] }, { n: 2, records: [rec('ok')] }] } })).map((r) => r.id).join() === 'ok');
assert('read: a volley gives one record per ray',
  readShotRecords(msg({ [ATTACK_LOG_FLAG_KEY]: { shots: [{ n: 1, records: [rec('r1'), rec('r2'), rec('r3')] }] } })).map((r) => r.id).join() === 'r1,r2,r3');
assert('read: a message without any record, or none at all, is empty',
  readShotRecords({ flags: {} }).length === 0 && readShotRecords(null).length === 0 && readShotRecords(msg({ [ATTACK_LOG_FLAG_KEY]: 7 })).length === 0);
assert('read: hostile records are validated', readShotRecords(msg({ [ATTACK_LOG_FLAG_KEY]: { shots: [{ records: [{ id: 'bad', t: 5, paths: [] }] }] } })).length === 0);

/* -------------------------------------------- */
/*  Ids                                         */
/* -------------------------------------------- */

const ids = new Set(Array.from({ length: 2000 }, () => makeShotId()));
assert('ids: unique even when created in the same millisecond', ids.size === 2000);
assert('ids: keep the shot_ prefix', [...ids].every((id) => id.startsWith('shot_')));

// --- chainLinePaths: a bouncing beam is one polyline -------------------------
{
  const P = (x, y) => ({ x, y });
  const line = (a, b) => ({ type: 'line', start: a, end: b });
  const legs = [line(P(0, 0), P(100, 0)), line(P(100.1, 0), P(150, 40)), line(P(150, 40), P(210, 0))];
  const chained = chainLinePaths(legs);
  assert('three touching legs become one polyline of four points',
    chained.length === 1 && chained[0].points.length === 4
    && chained[0].points[0].x === 0 && chained[0].points[3].x === 210, chained);
  assert('the input paths are not modified', legs[0].points === undefined && legs.length === 3);
}
{
  const P = (x, y) => ({ x, y });
  const chained = chainLinePaths([
    { type: 'line', start: P(0, 0), end: P(50, 0) },
    { type: 'line', start: P(200, 200), end: P(260, 200) },
    { type: 'circle', start: P(260, 200), range: 30 },
    { type: 'line', start: P(260, 200), end: P(300, 200) },
  ]);
  assert('separate lines stay separate, and a circle between breaks the chain',
    chained.length === 4 && chained.filter((p) => p.type === 'line').every((p) => p.points.length === 2), chained);
  assert('non-line paths pass through untouched', chained[2].type === 'circle' && chained[2].range === 30);
}
assert('empty / invalid input is safe', chainLinePaths(undefined).length === 0 && chainLinePaths([null, { type: 'line' }]).length === 2);

if (failed > 0) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll shot-trail tests passed');

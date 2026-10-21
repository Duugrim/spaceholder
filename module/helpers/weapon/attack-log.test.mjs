/**
 * Smoke tests for the attack log (shots → totals → per-target summary). Runs in plain Node. Execute with:
 *   node module/helpers/weapon/attack-log.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

import {
  MAX_RECORDED_TRAILS,
  addShot,
  attackApTotals,
  attackTotals,
  collectAttackRecords,
  createAttackLog,
  finishAttackLog,
  formatClock,
  formatNumber,
  isHitImpact,
  summarizeTargets,
} from './attack-log.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const hit = (name, extra = {}) => ({ tokenUuid: `Token.${name}`, name, kind: 'line', outcome: 'hit', ...extra });

/* -------------------------------------------- */
/*  A burst of three: two hit an orc, one flies past a bandit and misses */
/* -------------------------------------------- */

{
  const log = createAttackLog({
    startedAt: 1000,
    actor: { uuid: 'Actor.a', name: 'Ann' },
    token: { uuid: 'Token.ann', name: 'Ann' },
    weapon: { uuid: 'Item.w', name: 'AK-74' },
    modeName: 'Burst',
    fireMode: 'burst',
  });
  addShot(log, { apCost: 15, baseApCost: 20, impacts: [hit('Orc')] });
  addShot(log, { apCost: 6, baseApCost: 8, impacts: [hit('Orc', { quality: 'glancing' }), hit('Bandit')] });
  addShot(log, { apCost: 6, baseApCost: 8, impacts: [{ tokenUuid: 'Token.Bandit', name: 'Bandit', outcome: 'pass' }] });
  finishAttackLog(log, 2000);

  assert('shots are numbered from 1', log.shots.map((s) => s.n).join() === '1,2,3', log.shots.map((s) => s.n));
  assert('the log is closed', log.endedAt === 2000 && log.weaponName === 'AK-74' && log.fireMode === 'burst', log);

  const ap = attackApTotals(log);
  assert('AP: charged and base totals', ap.ap === 27 && ap.baseAp === 36, ap);

  const totals = attackTotals(log);
  assert('totals: a glancing hit counts as a hit, a fly-past does not', totals.shots === 3 && totals.hits === 3 && totals.missedShots === 1, totals);

  const targets = summarizeTargets(log);
  assert('summary: targets in order of first hit', targets.map((t) => t.name).join() === 'Orc,Bandit', targets.map((t) => t.name));
  assert('summary: hit counts per token', targets[0].hits === 2 && targets[1].hits === 1, targets.map((t) => t.hits));
  assert('summary: each hit remembers its shot', targets[0].entries.map((e) => e.shot).join() === '1,2', targets[0].entries);
  assert('a fly-past is not a hit', !isHitImpact({ outcome: 'pass' }) && isHitImpact({ outcome: 'area' }) && isHitImpact({ outcome: 'hit' }) && !isHitImpact({ outcome: 'graze' }));
}

/* -------------------------------------------- */
/*  Miss and empty logs                         */
/* -------------------------------------------- */

{
  const log = createAttackLog({ weapon: { name: 'Pistol' } });
  addShot(log, { apCost: 12, impacts: [] });
  assert('a shot with no impacts is a miss', attackTotals(log).hits === 0 && attackTotals(log).missedShots === 1);
  assert('no hits, no targets', summarizeTargets(log).length === 0);
  assert('base AP defaults to the charged AP', attackApTotals(log).baseAp === 12);

  const empty = createAttackLog();
  assert('an empty log is safe', attackTotals(empty).shots === 0 && summarizeTargets(empty).length === 0 && attackApTotals(empty).ap === 0);
  assert('missing log is safe', attackTotals(null).shots === 0 && summarizeTargets(undefined).length === 0);
}

/* -------------------------------------------- */
/*  Tokens without uuid, area hits, trail guard */
/* -------------------------------------------- */

{
  const log = createAttackLog();
  addShot(log, { impacts: [{ name: 'Crate', outcome: 'area', kind: 'area' }, { name: 'Crate', outcome: 'area', kind: 'area' }] });
  const targets = summarizeTargets(log);
  assert('targets without a uuid are told apart by name', targets.length === 1 && targets[0].hits === 2 && targets[0].tokenUuid === null, targets);
}

{
  const log = createAttackLog();
  for (let i = 0; i < MAX_RECORDED_TRAILS + 5; i += 1) {
    addShot(log, { apCost: 1, impacts: [hit('Orc')], records: [{ id: `shot_${i}`, t: 1e12 + i, paths: [] }] });
  }
  assert('trails are kept for the first shots only', collectAttackRecords(log).length === MAX_RECORDED_TRAILS, collectAttackRecords(log).length);
  assert('shots beyond the trail limit keep their results', log.shots.length === MAX_RECORDED_TRAILS + 5 && attackTotals(log).hits === MAX_RECORDED_TRAILS + 5);
  assert('trails come out oldest first', collectAttackRecords(log)[0].id === 'shot_0');
}

{
  const log = createAttackLog();
  const volley = addShot(log, { apCost: 15, rays: 8, impacts: [], records: Array.from({ length: 8 }, (_, i) => ({ id: `ray_${i}` })) });
  assert('a volley is one shot with several rays and trails', log.shots.length === 1 && volley.rays === 8 && volley.records.length === 8);
  const next = addShot(log, { apCost: 15, impacts: [] });
  assert('rays default to one', next.rays === 1 && next.records.length === 0);
  const tight = createAttackLog();
  for (let i = 0; i < MAX_RECORDED_TRAILS - 4; i += 1) addShot(tight, { records: [{ id: `s${i}` }] });
  const cut = addShot(tight, { rays: 8, records: Array.from({ length: 8 }, (_, k) => ({ id: `v${k}` })) });
  assert('the trail limit counts rays: a volley is cut where the limit falls', cut.records.length === 4 && collectAttackRecords(tight).length === MAX_RECORDED_TRAILS, cut.records.length);
  assert('a shot past the limit keeps no drawing', addShot(tight, { rays: 8, records: [{ id: 'late' }] }).records.length === 0);
}

{
  assert('numbers: two decimals at most', formatNumber(0.8249) === '0.82' && formatNumber(3) === '3' && formatNumber('x') === '?');
  assert('clock: wraps into 1..12 with 12 for the front', formatClock(0) === '12' && formatClock(-3) === '9' && formatClock(15) === '3' && formatClock(2.46) === '2.5');
  assert('clock: junk is safe', formatClock(undefined) === '?');
}

if (failed > 0) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll attack-log tests passed');

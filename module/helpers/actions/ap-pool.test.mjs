/**
 * Smoke tests for the action-point pool rules. Runs in plain Node. Execute with:
 *   node module/helpers/actions/ap-pool.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

import { AP_SHORTAGE, apReadout, planApSpend, readApPool } from './ap-pool.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

/* -------------------------------------------- */
/*  readApPool                                  */
/* -------------------------------------------- */

{
  const full = readApPool({ rawValue: undefined, max: 100 });
  assert('missing value = full pool', full.value === 100 && full.spent === 0 && full.rawValue === 100, full);

  const part = readApPool({ rawValue: 70, max: 100 });
  assert('value and spent are complementary', part.value === 70 && part.spent === 30, part);

  const debt = readApPool({ rawValue: -240, max: 100 });
  assert('below zero: nothing left, spent exceeds max', debt.value === 0 && debt.spent === 340 && debt.rawValue === -240, debt);

  const over = readApPool({ rawValue: 130, max: 100 });
  assert('above max is capped for the pool and costs nothing', over.value === 100 && over.spent === 0, over);

  const junk = readApPool({ rawValue: 'x', max: 'y' });
  assert('garbage is safe', junk.value === 0 && junk.max === 0 && junk.spent === 0, junk);
}

/* -------------------------------------------- */
/*  planApSpend                                 */
/* -------------------------------------------- */

{
  const pool = readApPool({ rawValue: 40, max: 100 });

  const ok = planApSpend({ inCombat: true, pool, cost: 25 });
  assert('in combat: affordable spend takes the cost', ok.ok && ok.next === 15 && ok.spent === 25, ok);

  const exact = planApSpend({ inCombat: true, pool, cost: 40 });
  assert('in combat: spending exactly what is left is fine', exact.ok && exact.next === 0 && exact.spent === 40, exact);

  const short = planApSpend({ inCombat: true, pool, cost: 41 });
  assert('in combat: one AP too many is refused with need / have',
    !short.ok && short.error === 'notEnoughAp' && short.need === 41 && short.have === 40, short);

  const clamp = planApSpend({ inCombat: true, pool, cost: 90, shortage: AP_SHORTAGE.CLAMP });
  assert('in combat: clamp takes what is left and forgives the rest', clamp.ok && clamp.next === 0 && clamp.spent === 40, clamp);

  const free = planApSpend({ inCombat: true, pool, cost: 0 });
  assert('a free action is always fine', free.ok && free.next === 40 && free.spent === 0, free);

  const empty = readApPool({ rawValue: 0, max: 100 });
  const none = planApSpend({ inCombat: true, pool: empty, cost: 1 });
  assert('in combat with 0 AP nothing is free any more', !none.ok && none.have === 0, none);
}

{
  const pool = readApPool({ rawValue: 10, max: 100 });
  const big = planApSpend({ inCombat: false, pool, cost: 340 });
  assert('out of combat: spending is not limited, the counter runs below zero', big.ok && big.next === -330 && big.spent === 340, big);

  const again = planApSpend({ inCombat: false, pool: readApPool({ rawValue: big.next, max: 100 }), cost: 60 });
  assert('out of combat: the counter keeps adding up', again.ok && again.next === -390 && again.spent === 60, again);
}

/* -------------------------------------------- */
/*  apReadout                                   */
/* -------------------------------------------- */

{
  const pool = readApPool({ rawValue: 35, max: 100 });
  const inFight = apReadout({ inCombat: true, pool });
  assert('in combat the counter shows what is left', inFight.mode === 'pool' && inFight.value === 35 && inFight.max === 100 && !inFight.empty, inFight);

  const out = apReadout({ inCombat: false, pool: readApPool({ rawValue: -240, max: 100 }) });
  assert('out of combat the counter shows what was spent since the last combat', out.mode === 'spent' && out.value === 340 && out.max === 100 && !out.empty, out);

  const dry = apReadout({ inCombat: true, pool: readApPool({ rawValue: 0, max: 100 }) });
  assert('an empty pool in combat is flagged', dry.empty === true, dry);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll ap-pool tests passed');

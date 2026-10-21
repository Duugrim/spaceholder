/**
 * Smoke tests for the death status decision. Plain Node, no Foundry globals:
 *   node module/helpers/actor-death.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

import { decideDeathSync } from './actor-death.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

assert('dead without the status → add it', decideDeathSync({ dead: true, hasStatus: false, auto: false }) === 'add');
assert('dead with the status already → nothing to do', decideDeathSync({ dead: true, hasStatus: true, auto: true }) === null);
assert('alive again and the status was ours → remove it', decideDeathSync({ dead: false, hasStatus: true, auto: true }) === 'remove');
assert('alive but the GM set the status by hand → leave it', decideDeathSync({ dead: false, hasStatus: true, auto: false }) === null);
assert('alive without the status → nothing', decideDeathSync({ dead: false, hasStatus: false, auto: false }) === null);
assert('a stale flag without the status does not add or remove anything', decideDeathSync({ dead: false, hasStatus: false, auto: true }) === null);

if (failed) {
  console.log(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll actor-death checks passed');

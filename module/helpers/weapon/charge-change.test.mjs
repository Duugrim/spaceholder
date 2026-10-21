/**
 * Smoke tests for charge packs: a battery loses charge per shot, a heat sink gains heat, and what
 * each can still give. Runs in plain Node. Execute with:
 *   node module/helpers/weapon/charge-change.test.mjs
 */

import {
  applyChargeChange,
  chargeCanFeedShot,
  chargeGrowsWithShots,
  chargeSpendableAmount,
} from './charge-change.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const battery = (current, max = 40) => ({
  enabled: true, current, max, changePerShot: { sign: '-', formula: '4' }, clampNonNegative: true,
});
const heatSink = (current, max = 40) => ({
  enabled: true, current, max, changePerShot: { sign: '+', formula: '4' }, clampNonNegative: true,
});

assert('battery: grows with shots? no', chargeGrowsWithShots(battery(10)) === false);
assert('heat sink: grows with shots? yes', chargeGrowsWithShots(heatSink(10)) === true);

assert('battery spendable = charge left', chargeSpendableAmount(battery(12)) === 12);
assert('heat sink spendable = room before overheating', chargeSpendableAmount(heatSink(12)) === 28);
assert('a cold heat sink gives all of max', chargeSpendableAmount(heatSink(0)) === 40);
assert('heat sink without a max is never "full"', chargeSpendableAmount(heatSink(5, 0)) === Number.POSITIVE_INFINITY);

assert('empty battery cannot feed a shot', chargeCanFeedShot(battery(0)) === false);
assert('battery with charge can', chargeCanFeedShot(battery(1)) === true);
assert('a cold heat sink (0 heat) CAN feed a shot', chargeCanFeedShot(heatSink(0)) === true);
assert('an overheated heat sink (heat = max) cannot', chargeCanFeedShot(heatSink(40)) === false);
assert('a pack without charge tracking always can', chargeCanFeedShot({ enabled: false }) === true && chargeCanFeedShot(null) === true);

{
  const sink = heatSink(0);
  let shots = 0;
  while (chargeCanFeedShot(sink) && shots < 50) {
    applyChargeChange(sink, { which: 'perShot' });
    shots += 1;
  }
  assert('a cold sink of 40 at +4 per shot gives exactly 10 shots, then overheats', shots === 10 && sink.current === 40, { shots, current: sink.current });
}

if (failed) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll charge-change tests passed');

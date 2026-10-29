/**
 * Smoke tests for shot-confidence: zone → confidence, the target's resistance, the "confidence must
 * be greater" verdict and its plug into `walkProjectileCollisions`. Plain Node, no Foundry globals:
 *   node module/helpers/shot-confidence.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

import {
  HIT_RESISTANCE_STATES,
  computeHitResistance,
  createTokenJudge,
  normalizeHitResistanceMod,
  shotHits,
  zoneConfidence,
} from './shot-confidence.mjs';
import { walkProjectileCollisions } from './hit-luck.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

// --- zone → confidence -----------------------------------------------------------------------------
assert('zones: red 1, orange 2, yellow 3, green 5, purple above green',
  zoneConfidence('red') === 1 && zoneConfidence('orange') === 2 && zoneConfidence('yellow') === 3
  && zoneConfidence('green') === 5 && zoneConfidence('purple') > zoneConfidence('green'));
assert('zones: unknown / missing counts as green',
  zoneConfidence('blue') === 5 && zoneConfidence(undefined) === 5);

// --- resistance ------------------------------------------------------------------------------------
assert('resistance: no state, no modifier → 0', computeHitResistance().value === 0);
assert('resistance: combat ready → 1', computeHitResistance({ states: ['combatReady'] }).value === 1);
assert('resistance: the table (combatReady 1, moving 2, cover 3, hidden 5)',
  Object.entries({ combatReady: 1, moving: 2, cover: 3, hidden: 5 })
    .every(([id, v]) => computeHitResistance({ states: [id] }).value === v && HIT_RESISTANCE_STATES[id] === v));
assert('resistance: states do not add up, the highest counts',
  computeHitResistance({ states: ['combatReady', 'cover', 'moving'] }).value === 3);
assert('resistance: unknown states are ignored', computeHitResistance({ states: ['bogus'] }).value === 0
  && computeHitResistance({ states: ['bogus', 'combatReady'] }).states.join() === 'combatReady');
assert('resistance: the flat modifier adds to the base',
  computeHitResistance({ states: ['combatReady'], modifier: 2 }).value === 3
  && computeHitResistance({ modifier: 1 }).value === 1);
assert('resistance: never below 0', computeHitResistance({ states: ['combatReady'], modifier: -5 }).value === 0);
assert('modifier: invalid → 0, fractions round',
  normalizeHitResistanceMod('x') === 0 && normalizeHitResistanceMod(undefined) === 0 && normalizeHitResistanceMod(1.6) === 2);

// --- verdict ---------------------------------------------------------------------------------------
assert('hit: confidence must be GREATER than resistance',
  shotHits(2, 1) && !shotHits(1, 1) && !shotHits(1, 2) && shotHits(1, 0));
{
  // The card's table: the last zone that no longer hits each state.
  const miss = (zone, states) => !shotHits(zoneConfidence(zone), computeHitResistance({ states }).value);
  assert('table: no states (not yet in the fight, standing) — every zone hits',
    ['red', 'orange', 'yellow', 'green'].every((z) => !miss(z, [])));
  assert('table: combat ready — red misses, orange hits', miss('red', ['combatReady']) && !miss('orange', ['combatReady']));
  assert('table: moving — red and orange miss, yellow hits',
    miss('red', ['moving']) && miss('orange', ['moving']) && !miss('yellow', ['moving']));
  assert('table: in cover — red…yellow miss, green hits',
    miss('yellow', ['cover']) && !miss('green', ['cover']));
  assert('table: hidden — green misses too, purple still hits',
    miss('green', ['hidden']) && !miss('purple', ['hidden']));
}

// --- the judge ---------------------------------------------------------------------------------------
const resistanceFor = (token) => computeHitResistance({ states: token.states ?? [], modifier: token.mod ?? 0 });
const tok = (id, extra = {}) => ({ id, ...extra });
const touch = (object) => ({ type: 'token', object, point: { x: 0, y: 0 }, details: { centrality: 0.7 } });

assert('judge: no confidence → no judge (AoE, debug shots)',
  createTokenJudge({ confidence: null, resistanceFor }) === null
  && createTokenJudge({ confidence: undefined, resistanceFor }) === null
  && createTokenJudge({ confidence: 3 }) === null);
{
  const judge = createTokenJudge({ confidence: zoneConfidence('red'), resistanceFor });
  const verdict = judge(touch(tok('A', { states: ['combatReady'] })));
  assert('judge: red (1) vs a combat-ready target (1) — flies past, details say why',
    verdict.pass === true && verdict.details.confidence === 1 && verdict.details.resistance === 1
    && verdict.details.resistanceStates.join() === 'combatReady' && verdict.details.resistanceMod === 0, verdict);
  assert('judge: red (1) vs a target with no state (0) — hit', judge(touch(tok('B'))).pass === false);
  assert('judge: an effect modifier raises resistance',
    judge(touch(tok('C', { mod: 1 }))).pass === true && judge(touch(tok('C', { mod: 1 }))).details.resistanceMod === 1);
}

// --- plugged into the collision walk ------------------------------------------------------------------
{
  const state = () => ({ passedTokens: new Set(), passedThrough: [] });
  const A = tok('A', { states: ['combatReady'] });
  const B = tok('B');
  const judgeToken = createTokenJudge({ confidence: zoneConfidence('red'), resistanceFor });
  const st = state();
  const out = walkProjectileCollisions([touch(A), touch(B)], 'stop', st, null, { judgeToken });
  assert('walk: a red shot flies past the combat-ready man and hits the one standing behind him',
    out.length === 1 && out[0].object === B && st.passedThrough.length === 1 && st.passedThrough[0].object === A);
  assert('walk: the fly-past keeps the reason (centrality + confidence + resistance)',
    st.passedThrough[0].details.confidence === 1 && st.passedThrough[0].details.resistance === 1
    && st.passedThrough[0].details.centrality === 0.7, st.passedThrough[0]);
  assert('walk: the token that was hit carries the verdict too',
    out[0].details.confidence === 1 && out[0].details.resistance === 0, out[0].details);

  const green = createTokenJudge({ confidence: zoneConfidence('green'), resistanceFor });
  const st2 = state();
  const out2 = walkProjectileCollisions([touch(A), touch(B)], 'stop', st2, null, { judgeToken: green });
  assert('walk: a green shot hits the first man', out2.length === 1 && out2[0].object === A && st2.passedThrough.length === 0);
}

if (failed) {
  console.log(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll shot-confidence checks passed');

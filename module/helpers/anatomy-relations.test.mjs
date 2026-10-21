/**
 * Smoke tests for the part tree helpers in anatomy-relations. Plain Node, no Foundry globals:
 *   node module/helpers/anatomy-relations.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

import { readFileSync } from 'node:fs';
import {
  childrenOf,
  computeLostParts,
  descendantsOf,
  parentOf,
  parentlessParts,
  rerootParents,
  resolveRootRef,
  validatePartTree,
} from './anatomy-relations.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const part = (parent) => ({ relations: [{ kind: 'adjacent', target: 'x' }, ...(parent ? [{ kind: 'parent', target: parent }] : [])] });

// head → neck → torso → (arm → hand), leg
const body = {
  head: part(null),
  neck: part('head'),
  torso: part('neck'),
  arm: part('torso'),
  hand: part('arm'),
  leg: part('torso'),
};

assert('parentOf: the parent relation, null for the root', parentOf(body, 'neck') === 'head' && parentOf(body, 'head') === null);
assert('parentOf: unknown part and unknown target are null',
  parentOf(body, 'ghost') === null && parentOf({ a: part('nope') }, 'a') === null);
assert('childrenOf: direct children only', childrenOf(body, 'torso').join() === 'arm,leg' && childrenOf(body, 'hand').length === 0);
assert('descendantsOf: the whole subtree, not the part itself',
  descendantsOf(body, 'neck').sort().join() === 'arm,hand,leg,torso'
  && descendantsOf(body, 'arm').join() === 'hand'
  && descendantsOf(body, 'hand').length === 0);
assert('descendantsOf: the root carries everyone', descendantsOf(body, 'head').length === 5);
assert('descendantsOf: survives a cycle', descendantsOf({ a: part('b'), b: part('a') }, 'a').join() === 'b');
assert('parentlessParts: one root', parentlessParts(body).join() === 'head');
assert('resolveRootRef: an existing rootRef wins', resolveRootRef(body, 'torso') === 'torso');
assert('resolveRootRef: missing or unknown falls back to the parentless part',
  resolveRootRef(body, '') === 'head' && resolveRootRef(body, 'ghost') === 'head' && resolveRootRef({}, '') === null);

assert('validatePartTree: a proper tree', validatePartTree(body, 'head').ok);
assert('validatePartTree: unknown root', validatePartTree(body, 'ghost').errors[0]?.code === 'root-missing');
assert('validatePartTree: root with a parent', validatePartTree(body, 'neck').errors.some((e) => e.code === 'root-has-parent'));
assert('validatePartTree: a second parentless part is not under the root',
  validatePartTree({ ...body, tail: part(null) }, 'head').errors.some((e) => e.code === 'not-under-root' && e.part === 'tail'));
assert('validatePartTree: a cycle is reported',
  validatePartTree({ head: part(null), a: part('b'), b: part('a') }, 'head').errors.some((e) => e.code === 'cycle'));
assert('validatePartTree: no parts is fine', validatePartTree({}, '').ok);

// --- rerootParents ---------------------------------------------------------------------------------
{
  const changes = rerootParents(body, 'torso');
  assert('rerootParents: the chain up to the old root is turned around',
    changes.torso === null && changes.neck === 'torso' && changes.head === 'neck' && Object.keys(changes).length === 3, changes);
  const apply = (parts, ch) => Object.fromEntries(Object.entries(parts).map(([k, p]) => [k, ch[k] === undefined
    ? p
    : { relations: [...p.relations.filter((r) => r.kind !== 'parent'), ...(ch[k] ? [{ kind: 'parent', target: ch[k] }] : [])] }]));
  const rerooted = apply(body, changes);
  assert('rerootParents: the result is a valid tree under the new root', validatePartTree(rerooted, 'torso').ok, validatePartTree(rerooted, 'torso'));
  assert('rerootParents: the old root now hangs below',
    descendantsOf(rerooted, 'torso').sort().join() === 'arm,hand,head,leg,neck');
  assert('rerootParents: the current root changes nothing but itself', JSON.stringify(rerootParents(body, 'head')) === '{"head":null}');
  assert('rerootParents: unknown part → nothing', Object.keys(rerootParents(body, 'ghost')).length === 0);
}

// --- lost parts -----------------------------------------------------------------------------------
{
  const hp = (parts, current) => Object.fromEntries(Object.entries(parts).map(([k, p]) => [k, { ...p, maxHp: 10, currentHp: current[k] ?? 10 }]));
  assert('computeLostParts: nothing at 0 HP → nothing lost', Object.keys(computeLostParts(hp(body, {}))).length === 0);
  const armOff = computeLostParts(hp(body, { arm: 0 }));
  assert('computeLostParts: the part and what hangs below it, nothing else',
    armOff.arm === 'arm' && armOff.hand === 'arm' && Object.keys(armOff).length === 2, armOff);
  const neckOff = computeLostParts(hp(body, { neck: 0 }));
  assert('computeLostParts: the neck takes everything below, not the head',
    Object.keys(neckOff).sort().join() === 'arm,hand,leg,neck,torso' && neckOff.head === undefined && neckOff.torso === 'neck', neckOff);
  const rootOff = computeLostParts(hp(body, { head: 0 }));
  assert('computeLostParts: the root takes the whole body', Object.keys(rootOff).length === 6 && rootOff.hand === 'head', rootOff);
  const both = computeLostParts(hp(body, { torso: 0, arm: 0 }));
  assert('computeLostParts: the nearest destroyed ancestor gets the credit', both.hand === 'arm' && both.leg === 'torso', both);
  assert('computeLostParts: a part with no HP to lose is never lost by itself',
    Object.keys(computeLostParts({ a: { maxHp: 0, currentHp: 0, relations: [] } })).length === 0);
  const flagged = computeLostParts(Object.fromEntries(Object.entries(hp(body, { torso: -4, arm: 3 })).map(([k, p]) => [k, { ...p, destroyed: k === 'arm' }])));
  assert('computeLostParts: an explicit destroyed flag decides (a disabled torso below 0 stays, the arm goes)',
    flagged.torso === undefined && flagged.arm === 'arm' && flagged.hand === 'arm', flagged);
  assert('computeLostParts: effectiveMaxHp wins over maxHp',
    computeLostParts({ a: { maxHp: 5, effectiveMaxHp: 0, currentHp: 0, relations: [] } }).a === undefined);
}

// --- the shipped presets ---------------------------------------------------------------------------
for (const id of ['humanoid', 'quadruped', 'arachnid']) {
  const preset = JSON.parse(readFileSync(new URL('../../data/anatomy/' + id + '.json', import.meta.url), 'utf8'));
  const check = validatePartTree(preset.bodyParts, preset.root);
  assert('preset ' + id + ": one part tree under its root '" + preset.root + "'", Boolean(preset.root) && check.ok, check.errors);
}
{
  const humanoid = JSON.parse(readFileSync(new URL('../../data/anatomy/humanoid.json', import.meta.url), 'utf8'));
  assert('preset humanoid: the head is the root, losing the neck takes everything below',
    humanoid.root === 'head'
    && descendantsOf(humanoid.bodyParts, 'neck').length === Object.keys(humanoid.bodyParts).length - 2);
}

if (failed) {
  console.log(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll anatomy-relations checks passed');

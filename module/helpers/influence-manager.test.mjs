// node module/helpers/influence-manager.test.mjs
// Sources of influence: a provider plugged in from outside (the Azimuth module); without one there are none.
import assert from 'node:assert/strict';

const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args);

const hooks = [];
globalThis.Hooks = { on: (name, fn) => hooks.push({ name, fn }) };
const GRID = 100;
let tokens = [];
globalThis.canvas = {
  grid: { size: GRID },
  get scene() { return { id: 'scene1', tokens: { contents: tokens } }; },
};

const { InfluenceManager } = await import('./influence-manager.mjs');

let passed = 0;
const test = async (name, fn) => {
  errors.length = 0;
  hooks.length = 0;
  tokens = [];
  try {
    await fn();
    passed++;
  } catch (e) {
    originalError(`FAIL ${name}\n`, e);
    process.exitCode = 1;
  }
};

const tokenDoc = (id, actor, extra = {}) => ({ id, actor, x: 200, y: 300, width: 2, height: 1, texture: { scaleX: 1, scaleY: 1 }, ...extra });
const sourceActor = (system) => ({ type: 'azimuth.globalobject', system });
const trigger = (name, ...args) => hooks.filter((h) => h.name === name).forEach((h) => h.fn(...args));

/** A manager with its hooks installed and every redraw/watch call recorded. */
function makeManager({ enabled = true } = {}) {
  const m = new InfluenceManager();
  m.enabled = enabled;
  m.scheduled = [];
  m.watched = [];
  m._scheduleRedraw = (opts) => m.scheduled.push(opts);
  m._watchTokenMoveAndRedraw = (...args) => m.watched.push(args);
  m._installHooks();
  return m;
}

// ---- without a provider ----
await test('without a provider there are no sources and no redraw triggers', () => {
  tokens = [tokenDoc('t1', sourceActor({ gRange: 5, gPower: 2, gFaction: 'Actor.f1' }))];
  const m = makeManager();
  assert.deepEqual(m.collectGlobalObjects(), [], 'the system looks for no sources of its own');
  trigger('createToken', tokens[0]);
  trigger('deleteToken', tokens[0]);
  trigger('updateActor', tokens[0].actor, { system: { gRange: 3 } });
  trigger('updateToken', tokens[0], { x: 5 }, {});
  assert.deepEqual([m.scheduled.length, m.watched.length], [0, 0]);
});

await test('no scene: no sources', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis.canvas, 'scene');
  Object.defineProperty(globalThis.canvas, 'scene', { get: () => null, configurable: true });
  assert.deepEqual(new InfluenceManager().collectGlobalObjects(), []);
  Object.defineProperty(globalThis.canvas, 'scene', saved);
});

// ---- a provider from outside ----
await test('a provider gets the scene and the grid size; range in cells becomes pixels', () => {
  let seen = null;
  const m = new InfluenceManager();
  m.setSourceProvider({
    collect: (ctx) => {
      seen = ctx;
      return [{ token: tokenDoc('src', sourceActor({})), rangeCells: 3, power: 4, faction: '@UUID[Actor.f9]{Red}' }];
    },
  });
  const objects = m.collectGlobalObjects();
  assert.equal(seen.scene.id, 'scene1');
  assert.equal(seen.gridSize, GRID);
  assert.deepEqual(objects.map((o) => [o.token.id, o.gRange, o.gPower, o.gFaction]), [['src', 300, 4, 'Actor.f9']], 'the faction is normalised to a plain uuid');
  assert.equal(objects[0].gRangeSq, 90000);
  assert.equal(objects[0].gInvRangeSq, 1 / 90000);
  assert.deepEqual(objects[0].position, { x: 300, y: 350 }, 'the centre of a 2x1 token at 200,300');
});

await test('a source can give its own centre and need no token', () => {
  const m = new InfluenceManager();
  m.setSourceProvider({ collect: () => [{ position: { x: 40, y: 60 }, rangeCells: 1, faction: 'Actor.f' }] });
  const [obj] = m.collectGlobalObjects();
  assert.equal(obj.token, null);
  assert.deepEqual(obj.position, { x: 40, y: 60 });
  assert.equal(obj.gPower, 1);
});

await test('provider sources without a faction or a centre are dropped', () => {
  const m = new InfluenceManager();
  m.setSourceProvider({
    collect: () => [
      { token: tokenDoc('a', {}), rangeCells: 1, faction: '' },
      { token: tokenDoc('b', {}), rangeCells: 1 },
      { rangeCells: 1, faction: 'Actor.f' },
      null,
      { token: tokenDoc('ok', {}), rangeCells: 2, faction: 'Actor.f' },
    ],
  });
  assert.deepEqual(m.collectGlobalObjects().map((o) => o.token.id), ['ok']);
});

await test('power 0 counts as 1', () => {
  const m = new InfluenceManager();
  m.setSourceProvider({ collect: () => [{ position: { x: 0, y: 0 }, rangeCells: 1, power: 0, faction: 'Actor.f' }] });
  assert.equal(m.collectGlobalObjects()[0].gPower, 1);
});

await test('a provider that throws gives no sources and is logged', () => {
  const m = new InfluenceManager();
  m.setSourceProvider({ collect: () => { throw new Error('boom'); } });
  assert.deepEqual(m.collectGlobalObjects(), []);
  assert.equal(errors.length, 1);
});

await test('null removes the provider; a bad provider is refused and changes nothing', () => {
  const m = new InfluenceManager();
  m.setSourceProvider({ collect: () => [{ position: { x: 1, y: 1 }, rangeCells: 1, faction: 'Actor.f' }] });
  assert.equal(m.collectGlobalObjects().length, 1);
  assert.throws(() => m.setSourceProvider({}), TypeError);
  assert.throws(() => m.setSourceProvider(() => []), TypeError);
  assert.throws(() => m.setSourceProvider(undefined), TypeError);
  assert.equal(m.collectGlobalObjects().length, 1, 'a refused provider changes nothing');
  m.setSourceProvider(null);
  assert.deepEqual(m.collectGlobalObjects(), []);
});

await test('grouping still goes by faction', () => {
  const m = new InfluenceManager();
  const groups = m.groupByFaction([{ gFaction: 'a' }, { gFaction: 'b' }, { gFaction: 'a' }, { gFaction: '' }]);
  assert.deepEqual(Object.keys(groups), ['a', 'b']);
  assert.equal(groups.a.length, 2);
});

// ---- redraw requests ----
await test('requestRedraw schedules only while influence is shown', () => {
  const off = makeManager({ enabled: false });
  off.requestRedraw({ reason: 'x' });
  assert.deepEqual(off.scheduled, []);
  const on = makeManager();
  on.requestRedraw();
  on.requestRedraw({ reason: 'pp', delayMs: 200 });
  assert.deepEqual(on.scheduled, [{ reason: 'requested' }, { reason: 'pp', delayMs: 200 }]);
});

await test('setting a provider while influence is shown redraws at once', () => {
  const m = makeManager();
  m.setSourceProvider({ collect: () => [] });
  assert.deepEqual(m.scheduled, [{ reason: 'sourceProvider', delayMs: 0 }]);
  const idle = makeManager({ enabled: false });
  idle.setSourceProvider({ collect: () => [] });
  assert.deepEqual(idle.scheduled, []);
});

// ---- hooks follow the provider ----
await test('with a provider, its predicates decide what triggers a redraw', () => {
  const m = makeManager();
  m.setSourceProvider({
    collect: () => [],
    isSourceToken: (td) => td?.actor?.type === 'azimuth.globalobject',
    isSourceActorChange: (actor, change) => actor?.type === 'azimuth.globalobject' && 'gRange' in (change.system ?? {}),
  });
  m.scheduled.length = 0;
  trigger('createToken', tokenDoc('a', { type: 'azimuth.globalobject' }));
  trigger('createToken', tokenDoc('b', { type: 'character' }));
  trigger('deleteToken', tokenDoc('a', { type: 'azimuth.globalobject' }));
  trigger('updateActor', { type: 'azimuth.globalobject' }, { system: { gRange: 1 } });
  trigger('updateActor', { type: 'azimuth.globalobject' }, { system: { gPower: 1 } });
  trigger('updateActor', { type: 'character' }, { system: { gRange: 1 } });
  assert.deepEqual(m.scheduled.map((s) => s.reason), ['tokenCreate', 'tokenDelete', 'actorUpdate']);
  trigger('updateToken', tokenDoc('a', { type: 'azimuth.globalobject' }), { y: 1 }, {});
  trigger('updateToken', tokenDoc('a', { type: 'azimuth.globalobject' }), { name: 'n' }, {});
  trigger('updateToken', tokenDoc('b', { type: 'character' }), { y: 1 }, {});
  assert.equal(m.watched.length, 1, 'only a move of a source token is watched');
});

await test('a provider without predicates never triggers hook redraws (it asks with requestRedraw)', () => {
  const m = makeManager();
  m.setSourceProvider({ collect: () => [] });
  m.scheduled.length = 0;
  trigger('createToken', tokenDoc('go', sourceActor({})));
  trigger('updateActor', sourceActor({}), { system: { gRange: 1 } });
  assert.deepEqual(m.scheduled, []);
});

await test('a throwing predicate counts as no and is logged', () => {
  const m = makeManager();
  m.setSourceProvider({ collect: () => [], isSourceToken: () => { throw new Error('boom'); }, isSourceActorChange: () => { throw new Error('boom'); } });
  m.scheduled.length = 0;
  trigger('createToken', tokenDoc('x', {}));
  trigger('updateActor', {}, {});
  assert.deepEqual(m.scheduled, []);
  assert.equal(errors.length, 2);
});

await test('nothing happens while influence is hidden', () => {
  const m = makeManager({ enabled: false });
  m.setSourceProvider({ collect: () => [], isSourceToken: () => true, isSourceActorChange: () => true });
  m.scheduled.length = 0;
  trigger('createToken', tokenDoc('go', sourceActor({})));
  trigger('updateActor', sourceActor({}), { system: { gRange: 1 } });
  trigger('updateToken', tokenDoc('go', sourceActor({})), { x: 1 }, {});
  assert.deepEqual([m.scheduled.length, m.watched.length], [0, 0]);
});

console.error = originalError;
console.log(`influence-manager.test.mjs: ${passed} passed`);

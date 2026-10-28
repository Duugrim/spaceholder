// node module/helpers/integration-registry.test.mjs
import assert from 'node:assert/strict';

const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args);

const registry = await import('./integration-registry.mjs');
const {
  INTEGRATION_API_VERSION, hiddenActorTypes, tokenPointerOffTypes, HOTBAR_EXTENSION_ACTION_PREFIX,
  withoutHiddenTypes, isTokenPointerOffType,
  registerFactionSheetSection, renderFactionSheetSections, activateFactionSheetSections,
  registerHotbarFactionItems, collectHotbarFactionItems,
  registerServiceJournalPredicate, isServiceJournal, registerJournalOperationMarker, isRegisteredJournalOperation,
  resetIntegrationRegistry,
} = registry;

let passed = 0;
const test = async (name, fn) => {
  resetIntegrationRegistry();
  errors.length = 0;
  try {
    await fn();
    passed++;
  } catch (e) {
    originalError(`FAIL ${name}\n`, e);
    process.exitCode = 1;
  }
};

await test('api version is a positive integer', () => {
  assert.ok(Number.isInteger(INTEGRATION_API_VERSION) && INTEGRATION_API_VERSION >= 1);
});

// ---- create dialog ----
await test('nothing hidden: the dialog is left alone', () => {
  assert.equal(withoutHiddenTypes(['character', 'faction']), null);
});

await test('hidden types are dropped from the offered list', () => {
  hiddenActorTypes.add('azimuth.faction');
  assert.deepEqual(withoutHiddenTypes(['character', 'faction', 'azimuth.faction', 'azimuth.globalobject']), ['character', 'faction', 'azimuth.globalobject']);
});

await test('a hidden type that is not offered changes nothing', () => {
  hiddenActorTypes.add('azimuth.faction');
  assert.equal(withoutHiddenTypes(['character', 'faction']), null);
});

await test('hiding every offered type changes nothing (the dialog needs one)', () => {
  hiddenActorTypes.add('character');
  assert.equal(withoutHiddenTypes(['character']), null);
});

await test('a restricted list (types option) is filtered too', () => {
  hiddenActorTypes.add('b');
  assert.deepEqual(withoutHiddenTypes(['a', 'b']), ['a']);
});

await test('a custom hidden set can be passed', () => {
  assert.deepEqual(withoutHiddenTypes(['a', 'b'], new Set(['a'])), ['b']);
  assert.equal(withoutHiddenTypes('nope', new Set(['a'])), null);
});

// ---- token pointer ----
await test('every actor type has a pointer by default; packages add theirs', () => {
  assert.ok(!isTokenPointerOffType('character'));
  assert.ok(!isTokenPointerOffType('globalobject'));
  assert.ok(!isTokenPointerOffType(undefined));
  tokenPointerOffTypes.add('azimuth.globalobject');
  assert.ok(isTokenPointerOffType('azimuth.globalobject'));
});

// ---- faction sheet sections ----
await test('sections render in registration order and skip empty ones', async () => {
  registerFactionSheetSection({ id: 'a', render: () => '<p>A</p>' });
  registerFactionSheetSection({ id: 'empty', render: () => null });
  registerFactionSheetSection({ id: 'b', render: async () => '<p>B</p>' });
  assert.deepEqual(await renderFactionSheetSections({}), [{ id: 'a', html: '<p>A</p>' }, { id: 'b', html: '<p>B</p>' }]);
});

await test('sections get the sheet arguments', async () => {
  let seen = null;
  registerFactionSheetSection({ id: 'a', render: (args) => { seen = args; return 'x'; } });
  const args = { actor: { id: 'f1' }, sheet: {}, context: {}, editable: true };
  await renderFactionSheetSections(args);
  assert.equal(seen, args);
});

await test('a section that throws is logged and skipped', async () => {
  registerFactionSheetSection({ id: 'bad', render: () => { throw new Error('boom'); } });
  registerFactionSheetSection({ id: 'good', render: () => 'ok' });
  assert.deepEqual(await renderFactionSheetSections({}), [{ id: 'good', html: 'ok' }]);
  assert.equal(errors.length, 1);
});

await test('registering an id again replaces the section; unregister removes it', async () => {
  registerFactionSheetSection({ id: 'a', render: () => 'old' });
  const off = registerFactionSheetSection({ id: 'a', render: () => 'new' });
  assert.deepEqual(await renderFactionSheetSections({}), [{ id: 'a', html: 'new' }]);
  off();
  assert.deepEqual(await renderFactionSheetSections({}), []);
});

await test('an old unregister does not remove a replacement', async () => {
  const offOld = registerFactionSheetSection({ id: 'a', render: () => 'old' });
  registerFactionSheetSection({ id: 'a', render: () => 'new' });
  offOld();
  assert.deepEqual(await renderFactionSheetSections({}), [{ id: 'a', html: 'new' }]);
});

await test('section specs are validated', () => {
  assert.throws(() => registerFactionSheetSection({ render: () => '' }), /id/);
  assert.throws(() => registerFactionSheetSection({ id: ' ', render: () => '' }), /id/);
  assert.throws(() => registerFactionSheetSection({ id: 'a' }), /render/);
  assert.throws(() => registerFactionSheetSection({ id: 'a', render: () => '', activate: 'x' }), /activate/);
  assert.throws(() => registerFactionSheetSection(null), /id/);
});

await test('activate runs with the section element, only for sections present in the sheet', () => {
  const calls = [];
  registerFactionSheetSection({ id: 'here', render: () => '', activate: (el, args) => calls.push(['here', el, args]) });
  registerFactionSheetSection({ id: 'gone', render: () => '', activate: () => calls.push(['gone']) });
  registerFactionSheetSection({ id: 'plain', render: () => '' });
  const elements = { here: { name: 'el-here' } };
  const root = { querySelector: (selector) => elements[selector.match(/"(.+)"/)[1]] ?? null };
  const args = { actor: {}, editable: true };
  activateFactionSheetSections(root, args);
  assert.deepEqual(calls, [['here', elements.here, args]]);
  activateFactionSheetSections(null, args);
  activateFactionSheetSections({}, args);
});

await test('a section whose activate throws does not stop the others', () => {
  const calls = [];
  registerFactionSheetSection({ id: 'bad', render: () => '', activate: () => { throw new Error('boom'); } });
  registerFactionSheetSection({ id: 'good', render: () => '', activate: () => calls.push('good') });
  activateFactionSheetSections({ querySelector: () => ({}) }, {});
  assert.deepEqual(calls, ['good']);
  assert.equal(errors.length, 1);
});

await test('a section whose element lookup throws does not stop the others', () => {
  const calls = [];
  registerFactionSheetSection({ id: 'bad"id', render: () => '', activate: () => calls.push('bad') });
  registerFactionSheetSection({ id: 'good', render: () => '', activate: () => calls.push('good') });
  const root = {
    querySelector: (selector) => {
      if (selector.includes('bad')) throw new SyntaxError('not a valid selector');
      return {};
    },
  };
  activateFactionSheetSections(root, {});
  assert.deepEqual(calls, ['good']);
  assert.equal(errors.length, 1);
});

// ---- hotbar items ----
await test('quick actions get a prefixed action and a handler; indicators are collected', async () => {
  const clicked = [];
  registerHotbarFactionItems({
    id: 'pkg',
    quickActions: (ctx) => [
      { key: 'one', icon: 'fa-solid fa-a', label: 'One', onClick: (event) => clicked.push(['one', event, ctx.tag]) },
      { key: 'two', icon: 'fa-solid fa-b', label: 'Two', disabled: 1, active: 1 },
    ],
    indicators: () => [{ key: 'pp', text: ' 3/10 ', tooltip: 'Points' }],
  });
  const out = await collectHotbarFactionItems({ tag: 't' });
  assert.deepEqual(out.quickActions, [
    { key: 'pkg:one', action: 'ext:pkg:one', icon: 'fa-solid fa-a', label: 'One', disabled: false, active: false },
    { key: 'pkg:two', action: 'ext:pkg:two', icon: 'fa-solid fa-b', label: 'Two', disabled: true, active: true },
  ]);
  assert.deepEqual(out.indicators, [{ key: 'pkg:pp', text: '3/10', tooltip: 'Points' }]);
  assert.deepEqual([...out.handlers.keys()], ['ext:pkg:one'], 'only a button with onClick has a handler');
  await out.handlers.get('ext:pkg:one')('ev');
  assert.deepEqual(clicked, [['one', 'ev', 't']]);
  assert.ok(out.quickActions.every((a) => a.action.startsWith(HOTBAR_EXTENSION_ACTION_PREFIX)));
});

await test('malformed items and empty indicators are dropped', async () => {
  registerHotbarFactionItems({
    id: 'pkg',
    quickActions: () => [null, { key: '', icon: 'i', label: 'l' }, { key: 'noicon', label: 'l' }, { key: 'nolabel', icon: 'i' }, { key: 'ok', icon: 'i', label: 'l' }],
    indicators: () => [{ key: 'blank', text: '  ' }, { text: 'nokey' }, null],
  });
  const out = await collectHotbarFactionItems({});
  assert.deepEqual(out.quickActions.map((a) => a.key), ['pkg:ok']);
  assert.deepEqual(out.indicators, []);
});

await test('providers are asked in registration order; a failing one is skipped', async () => {
  registerHotbarFactionItems({ id: 'a', quickActions: () => [{ key: 'x', icon: 'i', label: 'A' }] });
  registerHotbarFactionItems({ id: 'bad', quickActions: () => { throw new Error('boom'); }, indicators: async () => { throw new Error('boom'); } });
  registerHotbarFactionItems({ id: 'c', indicators: () => [{ key: 'y', text: 'C' }] });
  const out = await collectHotbarFactionItems({});
  assert.deepEqual(out.quickActions.map((a) => a.key), ['a:x']);
  assert.deepEqual(out.indicators.map((i) => i.key), ['c:y']);
  assert.equal(errors.length, 2);
});

await test('hotbar items are validated and can be unregistered', async () => {
  assert.throws(() => registerHotbarFactionItems({ id: 'a' }), /neither/);
  assert.throws(() => registerHotbarFactionItems({ quickActions: () => [] }), /id/);
  assert.throws(() => registerHotbarFactionItems({ id: 'a', quickActions: 'x' }), /quickActions/);
  assert.throws(() => registerHotbarFactionItems({ id: 'a', indicators: 5 }), /indicators/);
  const off = registerHotbarFactionItems({ id: 'a', indicators: () => [{ key: 'k', text: 't' }] });
  assert.equal((await collectHotbarFactionItems({})).indicators.length, 1);
  off();
  assert.equal((await collectHotbarFactionItems({})).indicators.length, 0);
});

await test('no providers: empty result', async () => {
  const out = await collectHotbarFactionItems({});
  assert.deepEqual([out.quickActions, out.indicators, out.handlers.size], [[], [], 0]);
});

// ---- service journals ----
await test('a document is a service journal if any predicate says so', () => {
  registerServiceJournalPredicate({ id: 'timeline', test: (doc) => doc.kind === 'timeline' });
  registerServiceJournalPredicate({ id: 'events', test: (doc) => doc.kind === 'events' });
  assert.ok(isServiceJournal({ kind: 'timeline' }));
  assert.ok(isServiceJournal({ kind: 'events' }));
  assert.ok(!isServiceJournal({ kind: 'notes' }));
  assert.ok(!isServiceJournal(null));
  assert.ok(!isServiceJournal(undefined));
});

await test('a page of a claimed entry is a service journal too, not the other way round', () => {
  registerServiceJournalPredicate({ id: 'pkg', test: (doc) => doc.documentName === 'JournalEntry' && doc.claimed === true });
  const entry = { documentName: 'JournalEntry', claimed: true };
  assert.ok(isServiceJournal({ documentName: 'JournalEntryPage', parent: entry }));
  assert.ok(!isServiceJournal({ documentName: 'JournalEntryPage', parent: { documentName: 'JournalEntry' } }));
  assert.ok(!isServiceJournal({ documentName: 'JournalEntryPage' }), 'a page without an entry');
  assert.ok(!isServiceJournal({ documentName: 'Folder', parent: entry }), 'only pages follow their entry');
});

await test('no predicates: nothing is a service journal', () => {
  assert.ok(!isServiceJournal({ kind: 'timeline' }));
});

await test('a throwing predicate counts as no and is logged', () => {
  registerServiceJournalPredicate({ id: 'bad', test: () => { throw new Error('boom'); } });
  registerServiceJournalPredicate({ id: 'good', test: () => true });
  assert.ok(isServiceJournal({}));
  assert.equal(errors.length, 1);
});

await test('predicate specs are validated and unregistered', () => {
  assert.throws(() => registerServiceJournalPredicate({ test: () => true }), /id/);
  assert.throws(() => registerServiceJournalPredicate({ id: 'a' }), /test/);
  const off = registerServiceJournalPredicate({ id: 'a', test: () => true });
  assert.ok(isServiceJournal({}));
  off();
  assert.ok(!isServiceJournal({}));
});

await test('operation markers: only registered option names count', () => {
  assert.ok(!isRegisteredJournalOperation({ pkgJournalCheck: true }));
  const off = registerJournalOperationMarker('pkgJournalCheck');
  assert.ok(isRegisteredJournalOperation({ pkgJournalCheck: true }));
  assert.ok(!isRegisteredJournalOperation({ pkgJournalCheck: false }));
  assert.ok(!isRegisteredJournalOperation({ other: true }));
  assert.ok(!isRegisteredJournalOperation(null));
  assert.ok(!isRegisteredJournalOperation('x'));
  off();
  assert.ok(!isRegisteredJournalOperation({ pkgJournalCheck: true }));
  const first = registerJournalOperationMarker('shared');
  const second = registerJournalOperationMarker('shared');
  first();
  first();
  assert.ok(isRegisteredJournalOperation({ shared: true }), 'a marker stays while another registration holds it');
  second();
  assert.ok(!isRegisteredJournalOperation({ shared: true }));
  assert.throws(() => registerJournalOperationMarker(''), /marker/);
  assert.throws(() => registerJournalOperationMarker(undefined), /marker/);
});

await test('reset clears every registry and type set', () => {
  hiddenActorTypes.add('x');
  tokenPointerOffTypes.add('y');
  registerServiceJournalPredicate({ id: 'a', test: () => true });
  registerJournalOperationMarker('m');
  resetIntegrationRegistry();
  assert.deepEqual([...hiddenActorTypes], []);
  assert.deepEqual([...tokenPointerOffTypes], []);
  assert.ok(!isServiceJournal({}));
  assert.ok(!isRegisteredJournalOperation({ m: true }));
});

console.error = originalError;
console.log(`integration-registry.test.mjs: ${passed} passed`);

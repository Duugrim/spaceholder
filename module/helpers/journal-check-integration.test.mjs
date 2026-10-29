// node module/helpers/journal-check-integration.test.mjs
// Journals that an integrating package keeps for itself stay out of the journal-check workflow.
import assert from 'node:assert/strict';

const handlers = {};
globalThis.Hooks = {
  on: (name, fn) => { handlers[name] = fn; },
  callAll: () => {},
};
globalThis.game = { user: { id: 'u1' }, users: { get: () => ({ isGM: true }) }, settings: { get: () => undefined } };
globalThis.foundry = {
  utils: {
    setProperty(obj, path, value) {
      const keys = path.split('.');
      let node = obj;
      for (const key of keys.slice(0, -1)) node = node[key] ??= {};
      node[keys.at(-1)] = value;
    },
  },
};
const originalError = console.error;
const errors = [];
console.error = (...args) => errors.push(args);

const { installJournalCheckHooks } = await import('./journal-check.mjs');
const {
  registerServiceJournalPredicate, registerJournalOperationMarker, resetIntegrationRegistry,
} = await import('./integration-registry.mjs');
installJournalCheckHooks();

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

const statusOf = (data) => data.flags?.spaceholder?.journalCheck?.status;

// ---- new entries and pages start as drafts, unless the change is a package's own ----
await test('a new entry gets the draft status', () => {
  const data = {};
  handlers.preCreateJournalEntry({}, data, {}, 'u1');
  assert.equal(statusOf(data), 'draft');
});

await test("the system's own marker keeps the workflow out", () => {
  const data = {};
  handlers.preCreateJournalEntry({}, data, { spaceholderJournalCheck: true }, 'u1');
  assert.equal(statusOf(data), undefined);
});

await test('a package marker counts only once it is registered', () => {
  let data = {};
  handlers.preCreateJournalEntryPage({}, data, { pkgJournalCheck: true }, 'u1');
  assert.equal(statusOf(data), 'draft', 'unknown marker: the workflow applies');

  registerJournalOperationMarker('pkgJournalCheck');
  data = {};
  handlers.preCreateJournalEntryPage({}, data, { pkgJournalCheck: true }, 'u1');
  assert.equal(statusOf(data), undefined, 'registered marker: left alone');
  data = {};
  handlers.preCreateJournalEntry({}, data, { pkgJournalCheck: true }, 'u1');
  assert.equal(statusOf(data), undefined);
  data = {};
  handlers.preCreateJournalEntryPage({}, data, {}, 'u1');
  assert.equal(statusOf(data), 'draft', 'a change without the marker still gets it');
});

// ---- pages of a service journal do not move the status of their entry ----
const makeEntry = (entryStatus, pageStatus, flagsByKey = {}) => {
  const entry = {
    updates: [],
    getFlag: (_scope, key) => (key === 'journalCheck' ? { status: entryStatus } : flagsByKey.entry?.[key]),
    update: async (data, options) => { entry.updates.push([data, options]); },
    flags: {},
  };
  const page = {
    documentName: 'JournalEntryPage',
    parent: entry,
    getFlag: (_scope, key) => (key === 'journalCheck' ? { status: pageStatus } : flagsByKey.page?.[key]),
    flags: {},
  };
  entry.pages = { contents: [page] };
  return { entry, page };
};

await test('a new page makes its entry follow the weakest page', async () => {
  const { entry, page } = makeEntry('approved', 'draft');
  await handlers.createJournalEntryPage(page, {}, 'u1');
  assert.equal(entry.updates.length, 1, 'the entry was moved to draft');
  assert.equal(entry.updates[0][0]['flags.spaceholder.journalCheck.status'], 'draft');
});

await test('a page of a service journal is skipped (page or its entry claimed by a package)', async () => {
  registerServiceJournalPredicate({ id: 'pkg', test: (doc) => doc.isServicePage === true });
  let { entry, page } = makeEntry('approved', 'draft');
  page.isServicePage = true;
  await handlers.createJournalEntryPage(page, {}, 'u1');
  await handlers.deleteJournalEntryPage(page, {}, 'u1');
  assert.equal(entry.updates.length, 0, 'claimed page: the entry status is left alone');

  resetIntegrationRegistry();
  registerServiceJournalPredicate({ id: 'pkg', test: (doc) => doc.isServiceEntry === true });
  ({ entry, page } = makeEntry('approved', 'draft'));
  entry.isServiceEntry = true;
  await handlers.createJournalEntryPage(page, {}, 'u1');
  await handlers.deleteJournalEntryPage(page, {}, 'u1');
  assert.equal(entry.updates.length, 0, 'claimed entry: its pages are skipped too');
});

await test('a package marker on the page change also skips the sync', async () => {
  registerJournalOperationMarker('pkgJournalCheck');
  const { entry, page } = makeEntry('approved', 'draft');
  await handlers.createJournalEntryPage(page, { pkgJournalCheck: true }, 'u1');
  assert.equal(entry.updates.length, 0);
});

await test('the system does not know the flags of a package: only its claim skips the workflow', async () => {
  const { entry, page } = makeEntry('approved', 'draft', { entry: { timelineV2: { isContainer: true } } });
  await handlers.createJournalEntryPage(page, {}, 'u1');
  assert.equal(entry.updates.length, 1, 'no package claims the entry: it is an ordinary journal');
});

assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors.map((e) => String(e[1]?.message ?? e[0])))}`);
console.error = originalError;
console.log(`journal-check-integration.test.mjs: ${passed} passed`);

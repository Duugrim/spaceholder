// node module/helpers/azimuth-link.test.mjs
// The system's half of the link with the Azimuth module, and (when the module sits next to the system)
// both halves together: the module's real code against the system's real registries and influence manager.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '../../../../modules/azimuth');

const errors = [];
const originalError = console.error;
const originalWarn = console.warn;
console.error = (...args) => errors.push(args);
console.warn = () => {};

const notices = [];
const hooks = {};
const addHook = (name, fn) => { (hooks[name] ??= []).push(fn); return 1; };
const fire = (name, ...args) => (hooks[name] ?? []).forEach((fn) => fn(...args));

globalThis.Hooks = { on: addHook };
globalThis.ui = { notifications: { warn: (text) => notices.push(text), info: () => {} } };
globalThis.game = { i18n: { localize: (key) => key }, user: { isGM: true }, modules: new Map() };

const link = await import('./azimuth-link.mjs');
const registry = await import('./integration-registry.mjs');

let passed = 0;
const test = async (name, fn, { reset = true } = {}) => {
  errors.length = 0;
  notices.length = 0;
  if (reset) registry.resetIntegrationRegistry();
  try {
    await fn();
    passed++;
  } catch (e) {
    originalError(`FAIL ${name}\n`, e);
    process.exitCode = 1;
  }
};

/** A stand-in for `game.azimuth` that speaks the version this half expects. */
const fakeApi = (patch = {}) => ({
  integrationApiVersion: link.EXPECTED_AZIMUTH_API_VERSION,
  getInfluenceSources: () => [{ position: { x: 1, y: 2 }, rangeCells: 3, faction: 'Actor.f' }],
  isInfluenceSourceToken: (token) => token?.mine === true,
  isInfluenceSourceActorChange: (actor, change) => actor?.mine === true && 'gRange' in (change?.system ?? {}),
  isServiceJournal: (doc) => doc?.service === true,
  ...patch,
});

const fakeIntegration = () => {
  const calls = { provider: [], predicates: [] };
  return {
    calls,
    setInfluenceSourceProvider: (p) => calls.provider.push(p),
    registerServiceJournalPredicate: (spec) => { calls.predicates.push(spec); return registry.registerServiceJournalPredicate(spec); },
  };
};

// ---- the module's API must be the one this half expects ----
await test('an API is supported only with the right version and every function', () => {
  assert.ok(link.isAzimuthApiSupported(fakeApi()));
  assert.ok(!link.isAzimuthApiSupported(fakeApi({ integrationApiVersion: 2 })));
  assert.ok(!link.isAzimuthApiSupported(fakeApi({ integrationApiVersion: undefined })));
  assert.ok(!link.isAzimuthApiSupported(fakeApi({ isServiceJournal: undefined })));
  assert.ok(!link.isAzimuthApiSupported(fakeApi({ getInfluenceSources: 'nope' })));
  assert.ok(!link.isAzimuthApiSupported(null) && !link.isAzimuthApiSupported(undefined));
});

await test('connecting gives the manager a provider that asks the module', () => {
  const integration = fakeIntegration();
  const api = fakeApi();
  assert.equal(link.connectAzimuth({ api, integration }), true);

  const [provider] = integration.calls.provider;
  assert.deepEqual(provider.collect({ scene: {}, gridSize: 100 }), [{ position: { x: 1, y: 2 }, rangeCells: 3, faction: 'Actor.f' }]);
  assert.equal(provider.isSourceToken({ mine: true }), true);
  assert.equal(provider.isSourceToken({}), false);
  assert.equal(provider.isSourceActorChange({ mine: true }, { system: { gRange: 1 } }), true);
  assert.equal(provider.isSourceActorChange({ mine: true }, { system: { gPower: 1 } }), false);
  assert.equal(provider.isSourceActorChange({}, { system: { gRange: 1 } }), false);
});

await test('connecting makes the journal workflow ask the module which journals are its own', () => {
  link.connectAzimuth({ api: fakeApi(), integration: fakeIntegration() });
  assert.equal(registry.isServiceJournal({ service: true }), true);
  assert.equal(registry.isServiceJournal({ service: false }), false);
  assert.equal(registry.isServiceJournal({}), false);
});

await test('an API this half does not know connects nothing', () => {
  const integration = fakeIntegration();
  assert.equal(link.connectAzimuth({ api: fakeApi({ integrationApiVersion: 7 }), integration }), false);
  assert.deepEqual(integration.calls.provider, []);
  assert.deepEqual(integration.calls.predicates, []);
});

// ---- install: the module may be absent, inactive, or unsupported ----
await test('without an active module nothing happens', () => {
  game.spaceholder = { integration: fakeIntegration() };
  assert.equal(link.installAzimuthLink(), false);
  assert.equal(link.azimuthLinkState(), 'off');
  game.modules.set('azimuth', { active: false, api: fakeApi() });
  assert.equal(link.installAzimuthLink(), false);
  assert.equal(link.azimuthLinkState(), 'off');
  assert.deepEqual(game.spaceholder.integration.calls.provider, []);
  assert.equal(link.warnIfAzimuthUnsupported(), false);
  game.modules.clear();
});

await test('an active module with the right API is linked', () => {
  game.spaceholder = { integration: fakeIntegration() };
  game.modules.set('azimuth', { active: true, api: fakeApi() });
  assert.equal(link.installAzimuthLink(), true);
  assert.equal(link.azimuthLinkState(), 'linked');
  assert.equal(game.spaceholder.integration.calls.provider.length, 1);
  assert.equal(link.warnIfAzimuthUnsupported(), false);
  game.modules.clear();
});

await test('an active module that is too old or too new is reported to the GM, not connected', () => {
  game.spaceholder = { integration: fakeIntegration() };
  game.modules.set('azimuth', { active: true, api: fakeApi({ integrationApiVersion: 0 }) });
  assert.equal(link.installAzimuthLink(), false);
  assert.equal(link.azimuthLinkState(), 'unsupported');
  assert.deepEqual(game.spaceholder.integration.calls.provider, []);
  assert.equal(link.warnIfAzimuthUnsupported(), true);
  assert.deepEqual(notices, ['SPACEHOLDER.Azimuth.Unsupported']);
  game.user.isGM = false;
  assert.equal(link.warnIfAzimuthUnsupported(), false, 'players are not bothered');
  game.user.isGM = true;
  game.modules.clear();
});

await test('a module without api falls back to game.azimuth', () => {
  game.spaceholder = { integration: fakeIntegration() };
  game.azimuth = fakeApi();
  game.modules.set('azimuth', { active: true });
  assert.equal(link.installAzimuthLink(), true);
  delete game.azimuth;
  game.modules.clear();
});

// ---- both halves together: the module's real code, the system's real registries ----
const moduleThere = fs.existsSync(path.join(moduleRoot, 'scripts/integrations/spaceholder.mjs'));
if (!moduleThere) {
  console.log(`azimuth-link.test.mjs: the module is not at ${moduleRoot}, skipping the end-to-end part`);
} else {
  const e2e = (name, fn) => test(name, fn, { reset: false });
  const load = (rel) => import(pathToFileURL(path.join(moduleRoot, rel)).href);

  // Foundry stand-ins the module's code touches
  const rendered = [];
  let progressionOn = false;
  globalThis.fromUuid = async () => null;
  globalThis.foundry = {
    applications: { handlebars: { renderTemplate: async (template, context) => { rendered.push({ template, context }); return '<div class="pp"></div>'; } } },
    utils: { randomID: () => 'rid' },
  };
  const GRID = 100;
  let sceneTokens = [];
  globalThis.canvas = { grid: { size: GRID }, get scene() { return { id: 's1', tokens: { contents: sceneTokens } }; } };
  const opened = [];
  let hotbarRedraws = 0;

  const { InfluenceManager } = await import('./influence-manager.mjs');
  const manager = new InfluenceManager();
  manager._installHooks();

  // The system as spaceholder.mjs publishes it
  const integration = registry.createIntegrationApi({
    requestHotbarFactionRender: () => { hotbarRedraws++; },
    getJournalPageStatus: (page) => (page.draft ? 'draft' : 'approved'),
    getInfluenceManager: () => manager,
  });
  game.system = { id: 'spaceholder' };
  game.spaceholder = { integration, influenceManager: manager };
  game.settings = { get: () => progressionOn };
  game.users = { contents: [] };
  game.scenes = { contents: [] };

  const { ACTOR_TYPES, INTEGRATION_API_VERSION } = await load('scripts/constants.mjs');
  const moduleIntegrations = await load('scripts/integrations/index.mjs');
  const { collectInfluenceSources, isInfluenceSourceToken, isInfluenceSourceActorChange } = await load('scripts/helpers/influence-sources.mjs');
  const { isServiceJournal: moduleIsServiceJournal } = await load('scripts/helpers/service-journals.mjs');
  const { getStatus, setPageStatusProvider } = await load('scripts/helpers/page-status.mjs');
  const hostProfile = await load('scripts/lib/host-profile.mjs');

  // The module's API as azimuth.mjs publishes it (the parts the system uses)
  const api = {
    integrationApiVersion: INTEGRATION_API_VERSION,
    getInfluenceSources: (ctx) => collectInfluenceSources(ctx),
    isInfluenceSourceToken: (t) => isInfluenceSourceToken(t),
    isInfluenceSourceActorChange: (a, c) => isInfluenceSourceActorChange(a, c),
    isServiceJournal: (d) => moduleIsServiceJournal(d),
    openTimelineV2App: () => opened.push('timeline'),
    openProgressionPointsApp: () => opened.push('points'),
    openEventsApp: () => opened.push('events'),
    influenceManager: null,
  };
  game.azimuth = api;
  game.modules.set('azimuth', { active: true, api });

  await e2e('the versions agree on both sides', () => {
    assert.equal(INTEGRATION_API_VERSION, link.EXPECTED_AZIMUTH_API_VERSION, 'the module offers the version the system expects');
    assert.equal(registry.INTEGRATION_API_VERSION, 1);
    assert.equal(integration.apiVersion, registry.INTEGRATION_API_VERSION);
  });

  await e2e('both halves connect', () => {
    assert.equal(moduleIntegrations.installIntegrations(), 'spaceholder', 'the module accepts the system API');
    assert.equal(hostProfile.isFactionType('faction'), true);
    assert.equal(hostProfile.showsHotbarBlock(), false);
    moduleIntegrations.connectIntegrations(api);
    assert.equal(link.installAzimuthLink(), true);
    assert.equal(link.azimuthLinkState(), 'linked');
    assert.equal(api.influenceManager, manager, 'the edge panel can read zones from the system');
  });

  await e2e('types: the module faction is hidden from creation, objects have no pointer, objects stay creatable', () => {
    assert.deepEqual(registry.withoutHiddenTypes(['character', 'faction', ACTOR_TYPES.faction, ACTOR_TYPES.globalObject]), ['character', 'faction', ACTOR_TYPES.globalObject]);
    assert.ok(registry.isTokenPointerOffType(ACTOR_TYPES.globalObject));
    assert.ok(!registry.isTokenPointerOffType('character'));
  });

  await e2e('journals: the module claims its own, the system leaves them out', () => {
    const container = { documentName: 'JournalEntry', flags: { azimuth: { timelineV2: { isContainer: true } } } };
    const folder = { documentName: 'Folder', flags: { azimuth: { events: { isFolder: true } } } };
    const page = { documentName: 'JournalEntryPage', flags: {}, parent: container };
    const ordinary = { documentName: 'JournalEntry', flags: {} };
    assert.ok(registry.isServiceJournal(container));
    assert.ok(registry.isServiceJournal(folder));
    assert.ok(registry.isServiceJournal(page), 'pages of the module journals');
    assert.ok(!registry.isServiceJournal(ordinary));
    assert.ok(!registry.isServiceJournal({ documentName: 'JournalEntry', flags: { spaceholder: { timelineV2: { isContainer: true } } } }), "the system's old flags no longer count");
    assert.ok(registry.isRegisteredJournalOperation({ azimuthJournalCheck: true }), "the module's own journal changes skip the workflow");
    assert.ok(!registry.isRegisteredJournalOperation({ somethingElse: true }));
    assert.equal(getStatus({ draft: true }), 'draft', 'progression points count what the journal workflow approved');
    assert.equal(getStatus({}), 'approved');
    setPageStatusProvider(null);
  });

  await e2e('influence: the real manager draws what the module reports and redraws on its changes', () => {
    const object = (system) => ({ type: ACTOR_TYPES.globalObject, system });
    const token = (id, actor) => ({ id, actor, x: 200, y: 300, width: 1, height: 1, texture: { scaleX: 1, scaleY: 1 } });
    sceneTokens = [
      token('a', object({ gRange: 4, gPower: 2, gFaction: 'Actor.f1', gInfluenceEnabled: true })),
      token('off', object({ gRange: 4, gFaction: 'Actor.f1', gInfluenceEnabled: false })),
      token('hero', { type: 'character', system: { gRange: 9, gFaction: 'Actor.f1' } }),
    ];
    const objects = manager.collectGlobalObjects();
    assert.deepEqual(objects.map((o) => [o.token.id, o.gRange, o.gPower, o.gFaction]), [['a', 400, 2, 'Actor.f1']]);

    manager.enabled = true;
    const scheduled = [];
    manager._scheduleRedraw = (opts) => scheduled.push(opts.reason);
    fire('createToken', sceneTokens[0]);
    fire('createToken', sceneTokens[2]);
    fire('updateActor', sceneTokens[0].actor, { system: { gRange: 5 } });
    fire('updateActor', sceneTokens[0].actor, { system: { ppCost: 2 } });
    fire('updateActor', sceneTokens[2].actor, { system: { gRange: 5 } });
    assert.deepEqual(scheduled, ['tokenCreate', 'actorUpdate']);
    manager.enabled = false;
  });

  await e2e('hotbar: the module adds its buttons and the points counter to the system block', async () => {
    const ctx = { user: { isGM: true }, isGM: true, active: { uuid: '' }, allowedUuids: [] };
    const out = await registry.collectHotbarFactionItems(ctx);
    assert.deepEqual(out.quickActions.map((a) => a.action), ['ext:azimuth:timeline', 'ext:azimuth:progression-points', 'ext:azimuth:events', 'ext:azimuth:influence']);
    assert.deepEqual(out.indicators, [], 'no counter while progression points are off');

    out.handlers.get('ext:azimuth:timeline')();
    out.handlers.get('ext:azimuth:events')();
    assert.deepEqual(opened, ['timeline', 'events'], "a button opens the module's window");

    const before = hotbarRedraws;
    out.handlers.get('ext:azimuth:influence')();
    assert.equal(manager.enabled, true, 'the influence button switches the system\'s zones');
    assert.equal(hotbarRedraws, before + 1, 'and the block redraws so the button shows its state');
    manager.enabled = false;

    progressionOn = true;
    fire('updateJournalEntryPage');
    assert.equal(hotbarRedraws, before + 2, 'the counter follows journal pages while points are on');
    progressionOn = false;
  });

  await e2e('faction sheet: the module adds the points section to the system sheet', async () => {
    const actor = { type: 'faction', uuid: 'Actor.f1', flags: {} };
    assert.deepEqual(await registry.renderFactionSheetSections({ actor, editable: true }), [], 'nothing while points are off');
    progressionOn = true;
    const sections = await registry.renderFactionSheetSections({ actor, editable: true });
    progressionOn = false;
    assert.deepEqual(sections.map((s) => s.id), ['azimuth']);
    assert.equal(rendered.at(-1).context.pp.modifierName, 'flags.azimuth.pp.modifier', "a system faction's points are saved in flags");
    const container = { querySelectorAll: () => [] };
    registry.activateFactionSheetSections({ querySelector: (sel) => (sel === '[data-faction-section="azimuth"]' ? container : null) }, { actor, sheet: {}, editable: true });
  });

  await e2e('a system that speaks another API leaves the module on its own', () => {
    integration.apiVersion = 99;
    hostProfile.resetHostProfile();
    assert.equal(moduleIntegrations.installIntegrations(), null);
    assert.equal(hostProfile.isFactionType('faction'), false, 'its own faction type, as without a system integration');
    assert.equal(hostProfile.showsHotbarBlock(), true, 'its own hotbar block');
    integration.apiVersion = registry.INTEGRATION_API_VERSION;
  });
}

assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors.map((e) => String(e[1]?.message ?? e[0])))}`);
console.error = originalError;
console.warn = originalWarn;
console.log(`azimuth-link.test.mjs: ${passed} passed`);

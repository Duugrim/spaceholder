// node module/documents/actor-create-dialog.test.mjs
// The create-actor dialog of SpaceHolderActor leaves out the types that integrating packages hid.
import assert from 'node:assert/strict';

// Foundry's globals as permissive stand-ins, so actor.mjs can be imported
const handler = {
  get(target, prop) {
    if (prop === Symbol.toPrimitive) return () => '';
    if (prop === 'then') return undefined;
    if (!(prop in target)) target[prop] = makeStub();
    return target[prop];
  },
  apply() { return makeStub(); },
  construct() { return makeStub(); },
  has() { return true; },
};
function makeStub() { return new Proxy(function stub() {}, handler); }
for (const name of ['foundry', 'game', 'Hooks', 'CONFIG', 'CONST', 'canvas', 'ui', 'PIXI', 'fromUuid', 'fromUuidSync', 'Handlebars', 'Item', 'ChatMessage', 'Roll']) {
  globalThis[name] = makeStub();
}
globalThis.document = makeStub();
globalThis.window = makeStub();

const coreCalls = [];
globalThis.Actor = class Actor {
  static TYPES = ['base', 'character', 'faction', 'azimuth.faction', 'azimuth.globalobject'];
  static async createDialog(...args) { coreCalls.push({ self: this, args }); return 'dialog'; }
};

const { SpaceHolderActor } = await import('./actor.mjs');
const { hiddenActorTypes, resetIntegrationRegistry } = await import('../helpers/integration-registry.mjs');

let passed = 0;
const test = async (name, fn) => {
  resetIntegrationRegistry();
  coreCalls.length = 0;
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n`, e);
    process.exitCode = 1;
  }
};

await test('nothing hidden: the core dialog gets exactly what it was given', async () => {
  const data = { folder: 'f' };
  const createOptions = { parent: null };
  const options = { width: 300 };
  const render = { force: true };
  assert.equal(await SpaceHolderActor.createDialog(data, createOptions, options, render), 'dialog');
  const [call] = coreCalls;
  assert.equal(call.self, SpaceHolderActor);
  assert.equal(call.args[0], data);
  assert.equal(call.args[1], createOptions);
  assert.equal(call.args[2], options, 'the options object is passed untouched');
  assert.equal(call.args[3], render);
});

await test('defaults match the core signature', async () => {
  await SpaceHolderActor.createDialog();
  assert.deepEqual(coreCalls[0].args, [{}, {}, {}, {}]);
});

await test('hidden types are removed from the types the dialog offers', async () => {
  hiddenActorTypes.add('azimuth.faction');
  await SpaceHolderActor.createDialog({}, {}, { width: 300 });
  assert.deepEqual(coreCalls[0].args[2], { width: 300, types: ['character', 'faction', 'azimuth.globalobject'] });
});

await test('hiding every creatable type leaves the dialog as it was (the base type does not count)', async () => {
  for (const type of ['character', 'faction', 'azimuth.faction', 'azimuth.globalobject']) hiddenActorTypes.add(type);
  const options = { width: 300 };
  await SpaceHolderActor.createDialog({}, {}, options);
  assert.equal(coreCalls[0].args[2], options);
});

await test('an explicit types list is filtered, not replaced', async () => {
  hiddenActorTypes.add('azimuth.faction');
  await SpaceHolderActor.createDialog({}, {}, { types: ['azimuth.faction', 'azimuth.globalobject'] });
  assert.deepEqual(coreCalls[0].args[2].types, ['azimuth.globalobject']);
});

await test('a hidden type that is not offered leaves the options alone', async () => {
  hiddenActorTypes.add('azimuth.faction');
  const options = { types: ['character'] };
  await SpaceHolderActor.createDialog({}, {}, options);
  assert.equal(coreCalls[0].args[2], options);
});

await test('hiding every offered type leaves the dialog as it was', async () => {
  hiddenActorTypes.add('azimuth.faction');
  const options = { types: ['azimuth.faction'] };
  await SpaceHolderActor.createDialog({}, {}, options);
  assert.equal(coreCalls[0].args[2], options);
});

console.log(`actor-create-dialog.test.mjs: ${passed} passed`);

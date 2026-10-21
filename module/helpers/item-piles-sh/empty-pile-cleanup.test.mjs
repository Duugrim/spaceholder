/**
 * Smoke test: a pile marked «delete when empty» disappears from the scene with its last item.
 * Runs in plain Node with stubbed Foundry globals. Execute with:
 *   node module/helpers/item-piles-sh/empty-pile-cleanup.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

let failed = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const hooks = new Map();
globalThis.Hooks = {
  on: (name, fn) => {
    if (!hooks.has(name)) hooks.set(name, []);
    hooks.get(name).push(fn);
  },
  off() {},
  callAll() {},
};
globalThis.game = { user: { id: 'gm1', isGM: false }, users: { activeGM: { id: 'gm1' } } };
globalThis.CONST = {};
globalThis.foundry = { utils: {} };

const { ItemPilesShPrivateApi } = await import('./private-api.mjs');
// Installed once (not a GM yet: the template-actor warm-up is not started).
ItemPilesShPrivateApi.initialize();
const onDeleteItem = hooks.get('deleteItem')?.[0];
assert('the cleanup listens to deleted items', typeof onDeleteItem === 'function');

const WAIT_MS = 120;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A pile actor with `itemCount` items left whose token sits in `inScene` on the scene. */
function makePile({ itemCount = 0, deleteWhenEmpty = true, hasToken = true, inScene = true, type = 'loot' } = {}) {
  const calls = { tokenDeleted: 0 };
  const token = {
    id: 'tok1',
    parent: { tokens: { has: (id) => inScene && id === 'tok1' } },
    delete: async () => {
      calls.tokenDeleted += 1;
    },
  };
  const actor = {
    documentName: 'Actor',
    type,
    system: { deleteWhenEmpty },
    items: { size: itemCount },
    token: hasToken ? token : null,
  };
  return { actor, calls };
}

async function takeLastItem(pile) {
  onDeleteItem({ parent: pile.actor });
  await sleep(WAIT_MS);
}

{
  game.user = { id: 'gm1', isGM: true };
  const pile = makePile();
  await takeLastItem(pile);
  assert('the pile token is deleted once the last item is gone', pile.calls.tokenDeleted === 1, pile.calls);
}
{
  const pile = makePile({ itemCount: 2 });
  await takeLastItem(pile);
  assert('a pile that still holds items stays', pile.calls.tokenDeleted === 0, pile.calls);
}
{
  const pile = makePile({ deleteWhenEmpty: false });
  await takeLastItem(pile);
  assert('a pile without the setting stays (the GM can switch it off)', pile.calls.tokenDeleted === 0, pile.calls);
}
{
  const pile = makePile({ hasToken: false });
  await takeLastItem(pile);
  assert('an actor with no token of its own (the shared template, a linked chest) is never touched', pile.calls.tokenDeleted === 0, pile.calls);
}
{
  const pile = makePile({ inScene: false });
  await takeLastItem(pile);
  assert('a token that is already gone is not deleted twice', pile.calls.tokenDeleted === 0, pile.calls);
}
{
  const pile = makePile({ type: 'character' });
  await takeLastItem(pile);
  assert('only loot actors are cleaned up', pile.calls.tokenDeleted === 0, pile.calls);
}
{
  game.user = { id: 'gm2', isGM: true }; // a second GM: the active one is gm1
  const pile = makePile();
  await takeLastItem(pile);
  assert('only the active GM deletes (two GMs would race)', pile.calls.tokenDeleted === 0, pile.calls);
}
{
  game.user = { id: 'p1', isGM: false };
  const pile = makePile();
  await takeLastItem(pile);
  assert('a player client never deletes', pile.calls.tokenDeleted === 0, pile.calls);
}
{
  game.user = { id: 'gm1', isGM: true };
  const pile = makePile();
  onDeleteItem({ parent: null });
  onDeleteItem({ parent: { documentName: 'Item' } });
  await sleep(WAIT_MS);
  assert('an item with no actor parent is ignored', pile.calls.tokenDeleted === 0);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll empty-pile-cleanup tests passed');

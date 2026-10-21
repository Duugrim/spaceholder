/**
 * Smoke test: changing a combatant's side between turns (combat started, nobody has been picked to act yet)
 * must rebuild the list of tokens that may take the turn. Runs in plain Node with stubbed Foundry globals.
 * Execute with:
 *   node module/helpers/combat/combat-side-change.test.mjs
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

let hookCalls = [];
globalThis.CONST = { TOKEN_DISPOSITIONS: { FRIENDLY: 1, NEUTRAL: 0, HOSTILE: -1, SECRET: -2 } };
globalThis.foundry = {
  utils: {
    randomID: () => 'evt',
    deepClone: (o) => JSON.parse(JSON.stringify(o)),
  },
};
globalThis.Hooks = { callAll: (...args) => hookCalls.push(args), on() {}, off() {} };
globalThis.ui = { combat: { render() {} } };

const { CombatSessionManager } = await import('./combat-session-manager.mjs');

function makeWorld({ sides, state }) {
  const flagsByCombatant = new Map();
  const list = Object.entries(sides).map(([id, disposition]) => {
    flagsByCombatant.set(id, {});
    return {
      id,
      actor: { system: {} },
      token: { disposition },
      getFlag: (_ns, key) => flagsByCombatant.get(id)[key],
      setFlag: async (_ns, key, value) => {
        flagsByCombatant.get(id)[key] = value;
      },
    };
  });
  let savedState = null;
  const combat = {
    id: 'combat1',
    started: true,
    combatants: { contents: list, get: (id) => list.find((c) => c.id === id) ?? null },
    setFlag: async (_ns, _key, value) => {
      savedState = JSON.parse(JSON.stringify(value));
    },
  };
  globalThis.game = {
    user: { id: 'gm', isGM: true },
    combats: { get: () => combat },
    combat,
  };
  const mgr = new CombatSessionManager();
  mgr._ensureCombatState = async () => state;
  mgr.appendEvent = async () => ({ ok: true });
  return { mgr, combat, saved: () => savedState };
}

const FRIENDLY = 1;
const HOSTILE = -1;

{
  hookCalls = [];
  const state = {
    schema: 1,
    round: 1,
    currentSide: 'disp:friendly',
    activeTurn: null,
    startedTurnsByCombatant: {},
    turnPick: { active: true, sideId: 'disp:friendly', eligibleCombatantIds: ['A', 'C'] },
    sides: [],
  };
  const { mgr, saved } = makeWorld({ sides: { A: FRIENDLY, B: HOSTILE, C: FRIENDLY }, state });
  const ok = await mgr.setCombatantSide({ combatId: 'combat1', combatantId: 'A', sideId: 'disp:hostile' });
  assert('the side change goes through', ok === true);
  assert('the token that changed side is no longer offered for the friendly turn', JSON.stringify(saved()?.turnPick?.eligibleCombatantIds) === JSON.stringify(['C']), saved()?.turnPick);
  assert('the pick is still the friendly side\'s', saved()?.currentSide === 'disp:friendly' && saved()?.turnPick?.sideId === 'disp:friendly', saved());
  assert('clients are told the pick list changed', hookCalls.some(([name]) => name === 'spaceholder.combatTurnPickMode'), hookCalls);
}
{
  hookCalls = [];
  const state = {
    schema: 1,
    round: 1,
    currentSide: 'disp:friendly',
    activeTurn: null,
    startedTurnsByCombatant: {},
    turnPick: { active: true, sideId: 'disp:friendly', eligibleCombatantIds: ['A'] },
    sides: [],
  };
  const { mgr, saved } = makeWorld({ sides: { A: FRIENDLY, B: HOSTILE }, state });
  await mgr.setCombatantSide({ combatId: 'combat1', combatantId: 'A', sideId: 'disp:hostile' });
  assert('the current side is left with nobody to act: the turn moves on to the next side', saved()?.currentSide === 'disp:hostile', saved());
  assert('…and the pick lists everyone of that side', JSON.stringify(saved()?.turnPick?.eligibleCombatantIds?.slice().sort()) === JSON.stringify(['A', 'B']), saved()?.turnPick);
}
{
  const state = {
    schema: 1,
    round: 1,
    currentSide: 'disp:friendly',
    activeTurn: null,
    startedTurnsByCombatant: {},
    turnPick: { active: true, sideId: 'disp:friendly', eligibleCombatantIds: ['A'] },
    sides: [],
  };
  const { mgr, saved } = makeWorld({ sides: { A: FRIENDLY, B: HOSTILE }, state });
  await mgr.setCombatantSide({ combatId: 'combat1', combatantId: 'B', sideId: 'disp:friendly' });
  assert('a token that joins the current side becomes pickable', JSON.stringify(saved()?.turnPick?.eligibleCombatantIds?.slice().sort()) === JSON.stringify(['A', 'B']), saved()?.turnPick);
}
{
  hookCalls = [];
  const state = {
    schema: 1,
    round: 1,
    currentSide: 'disp:friendly',
    activeTurn: { combatantId: 'A' },
    startedTurnsByCombatant: { A: 1 },
    turnPick: null,
    sides: [],
  };
  const { mgr, saved } = makeWorld({ sides: { A: FRIENDLY, B: HOSTILE }, state });
  await mgr.setCombatantSide({ combatId: 'combat1', combatantId: 'B', sideId: 'disp:friendly' });
  assert('during somebody\'s turn there is no pick list to touch', saved()?.turnPick === null && saved()?.currentSide === 'disp:friendly', saved());
  assert('…and no pick-mode notification', !hookCalls.some(([name]) => name === 'spaceholder.combatTurnPickMode'), hookCalls);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll combat-side-change tests passed');

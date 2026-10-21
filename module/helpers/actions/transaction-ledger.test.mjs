/**
 * Smoke tests for spending AP through the ledger: a hard limit in combat, a spent-AP counter outside it,
 * the reset after combat and what personal time follows. Runs in plain Node with stubbed Foundry
 * globals. Execute with:
 *   node module/helpers/actions/transaction-ledger.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

const registry = new Map();

function getProperty(object, path) {
  return String(path).split('.').reduce((node, part) => (node == null ? undefined : node[part]), object);
}

globalThis.foundry = {
  utils: {
    getProperty,
    deepClone: (o) => JSON.parse(JSON.stringify(o)),
    randomID: () => Math.random().toString(36).slice(2, 10),
  },
};
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };
globalThis.Hooks = { callAll() {}, on() {} };
globalThis.fromUuid = async (uuid) => registry.get(uuid) ?? null;
globalThis.game = {
  combat: null,
  combats: new Map(),
  user: { id: 'u1', isGM: true },
  i18n: { localize: (k) => k, format: (k, d) => `${k} ${JSON.stringify(d)}` },
  spaceholder: {},
};

function makeActor(id, { value = 100, max = 100, agi = 100, int = 100 } = {}) {
  const flags = { spaceholder: { apLedgerSyncedV1: true } };
  const actor = {
    id,
    uuid: `Actor.${id}`,
    type: 'character',
    documentName: 'Actor',
    isOwner: true,
    system: { abilities: { agi: { value: agi }, int: { value: int } }, actionPoints: { value, max } },
    testUserPermission: () => true,
    getFlag: (ns, key) => flags[ns]?.[key],
    setFlag: async (ns, key, v) => {
      (flags[ns] ??= {})[key] = v;
      return actor;
    },
    update: async (data) => {
      for (const [path, v] of Object.entries(data)) {
        const parts = path.split('.');
        let node = actor;
        for (const part of parts.slice(0, -1)) node = node[part];
        node[parts.at(-1)] = v;
      }
    },
  };
  registry.set(actor.uuid, actor);
  return actor;
}

function makeCombat(actorIds) {
  const flags = {};
  return {
    id: 'c1',
    started: true,
    combatants: { contents: actorIds.map((actorId) => ({ actorId })) },
    getFlag: (ns, key) => flags[ns]?.[key],
    setFlag: async (ns, key, v) => {
      (flags[ns] ??= {})[key] = v;
    },
    ledger: () => flags.spaceholder?.transactionLedger ?? [],
  };
}

function enterCombat(combat) {
  game.combat = combat;
  game.combats = new Map([[combat.id, combat]]);
}

function leaveCombat() {
  game.combat = null;
  game.combats = new Map();
}

const ledger = await import('./transaction-ledger.mjs');
const { personalTime } = { personalTime: await import('./personal-time.mjs') };

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

/* -------------------------------------------- */
/*  Out of combat: nothing is limited           */
/* -------------------------------------------- */
{
  leaveCombat();
  const actor = makeActor('a1', { value: 100 });
  assert('no combat: the actor is not in combat', ledger.isActorInActiveCombat(actor) === false);

  const res = await ledger.spendAp(actor, 340);
  assert('out of combat: a spend far above the pool goes through', res.ok === true && res.transactionId, res);
  assert('out of combat: the stored value runs below zero', actor.system.actionPoints.value === -240, actor.system.actionPoints.value);

  const pool = ledger.getStoredActionPoints(actor);
  assert('out of combat: AP left is 0 and AP spent is the whole 340', pool.value === 0 && pool.spent === 340 && pool.rawValue === -240, pool);

  const counter = ledger.describeApCounter(actor);
  assert('out of combat: the counter shows AP spent since the last combat', counter.isSpent && counter.text === '340' && counter.mode === 'spent', counter);

  assert('out of combat: personal time follows the whole spend (340 of a 100 pool = 34 s)',
    Math.abs(personalTime.getPersonalTimeTotal(actor) - 34) < 1e-9, personalTime.getPersonalTimeTotal(actor));

  const afford = ledger.canAffordAp(actor, 9999);
  assert('out of combat: anything can be afforded', afford.ok === true && afford.inCombat === false, afford);

  await ledger.recomputeApMaxForActor(actor);
  assert('a change of abilities keeps the spent-AP counter (does not clamp it to 0)', actor.system.actionPoints.value === -240, actor.system.actionPoints.value);
}

/* -------------------------------------------- */
/*  In combat: a hard limit                     */
/* -------------------------------------------- */
{
  const actor = makeActor('a1', { value: 100 });
  const combat = makeCombat(['a1']);
  enterCombat(combat);
  assert('combat: the actor is a combatant', ledger.isActorInActiveCombat(actor) === true);

  const ok = await ledger.spendAp(actor, 40);
  assert('combat: an affordable spend is charged', ok.ok && actor.system.actionPoints.value === 60, actor.system.actionPoints.value);
  assert('combat: and written to the combat ledger', combat.ledger().length === 1 && combat.ledger()[0].kind === 'apSpend', combat.ledger());

  const refused = await ledger.spendAp(actor, 70);
  assert('combat: a spend the pool cannot cover is refused', refused.ok === false && refused.code === 'notEnoughAp', refused);
  assert('combat: the refusal says what was needed and what was left', /70/.test(refused.error) && /60/.test(refused.error), refused.error);
  assert('combat: a refused spend changes nothing', actor.system.actionPoints.value === 60 && combat.ledger().length === 1);
  assert('combat: and moves no personal time', Math.abs(personalTime.getPersonalTimeTotal(actor) - 4) < 1e-9, personalTime.getPersonalTimeTotal(actor));

  const exact = await ledger.spendAp(actor, 60);
  assert('combat: spending exactly what is left works', exact.ok && actor.system.actionPoints.value === 0);

  const none = await ledger.spendAp(actor, 1);
  assert('combat: with 0 left nothing is free any more', none.ok === false, none);

  const counter = ledger.describeApCounter(actor);
  assert('combat: the counter shows AP left, flagged empty', !counter.isSpent && counter.text === '0/100' && counter.empty === true, counter);

  const afford = ledger.canAffordAp(actor, 5);
  assert('combat: canAffordAp agrees', afford.ok === false && afford.have === 0 && afford.need === 5 && afford.inCombat === true, afford);
}

/* -------------------------------------------- */
/*  Clamp (movement) and bystanders             */
/* -------------------------------------------- */
{
  const actor = makeActor('a1', { value: 25 });
  enterCombat(makeCombat(['a1']));
  const res = await ledger.spendAp(actor, 90, { shortage: ledger.AP_SHORTAGE.CLAMP });
  assert('clamp: the move takes what is left and is not refused', res.ok && actor.system.actionPoints.value === 0, actor.system.actionPoints.value);
  assert('clamp: personal time follows only what was really spent (25 of 100 = 2.5 s)',
    Math.abs(personalTime.getPersonalTimeTotal(actor) - 2.5) < 1e-9, personalTime.getPersonalTimeTotal(actor));
}
{
  const bystander = makeActor('b1', { value: 100 });
  enterCombat(makeCombat(['someoneElse']));
  assert('a combat the actor is not in does not limit them', ledger.isActorInActiveCombat(bystander) === false);
  const res = await ledger.spendAp(bystander, 250);
  assert('a bystander spends freely and the counter runs below zero', res.ok && bystander.system.actionPoints.value === -150, bystander.system.actionPoints.value);
}

/* -------------------------------------------- */
/*  Reset after combat                          */
/* -------------------------------------------- */
{
  leaveCombat();
  const actor = makeActor('a1', { value: -240 });
  const before = personalTime.getPersonalTimeTotal(actor);
  const res = await ledger.resetApPool(actor);
  assert('reset: the pool is full again', res.ok && actor.system.actionPoints.value === 100 && actor.system.actionPoints.max === 100, actor.system.actionPoints);
  assert('reset: out of combat the counter starts from zero spent', ledger.describeApCounter(actor).text === '0');
  assert('reset: no personal time passes with it', personalTime.getPersonalTimeTotal(actor) === before);

  const again = await ledger.resetApPool(actor);
  assert('reset: a full pool is left alone (no ledger entry)', again.ok && again.transactionId === null);

  const half = makeActor('a2', { value: 40 });
  await ledger.resetApPool(half);
  assert('reset: also refills what a fight left over', half.system.actionPoints.value === 100);
}

/* -------------------------------------------- */
/*  Refill at a turn start still counts the remainder as time */
/* -------------------------------------------- */
{
  const actor = makeActor('a1', { value: -50 });
  await ledger.refreshApPool(actor);
  assert('turn start after an overspend: the pool is refilled', actor.system.actionPoints.value === 100);
  assert('turn start after an overspend: the debt is not counted as remaining AP (no negative time)', personalTime.getPersonalTimeTotal(actor) === 0);

  const other = makeActor('a3', { value: 30 });
  await ledger.refreshApPool(other);
  assert('turn start: the unspent 30 of 100 still passes as 3 s', Math.abs(personalTime.getPersonalTimeTotal(other) - 3) < 1e-9, personalTime.getPersonalTimeTotal(other));
}

if (failed > 0) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll transaction-ledger tests passed');

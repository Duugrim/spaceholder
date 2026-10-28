/**
 * Smoke tests for the system statuses. Plain Node, no Foundry globals needed:
 *   node module/helpers/status-effects.test.mjs
 *
 * When Foundry's source is installed (`FOUNDRY_APP`, or the default install path), the last block also builds
 * a real ActiveEffect from every registered status the way `ActiveEffect.fromStatusEffect` does.
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CORE_STATUS_IDS,
  STATUS_EVENTS,
  STATUS_IDS,
  SPACEHOLDER_STATUS_EFFECTS,
  activeBlockers,
  endEventsOf,
  registerSpaceholderStatusEffects,
  statusFitsActorType,
  tokenChangeEvents,
} from './status-effects.mjs';
import { HIT_RESISTANCE_STATES } from './shot-confidence.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

/**
 * A stand-in for `CONFIG.statusEffects` with the behaviour that matters here (client/config.mjs): an array
 * that is also reachable by status id; assigning an unknown id appends, a known id replaces in place.
 */
function createStatusEffects(initial = []) {
  const registry = new Proxy([], {
    set(statuses, prop, value) {
      if (prop === 'length' || Number.isInteger(Number(prop))) {
        statuses[prop] = value;
        return true;
      }
      if (prop in statuses) {
        const index = statuses.findIndex((e) => e.id === prop);
        if (index >= 0) statuses[index] = value;
      } else statuses.push(value);
      statuses[prop] = value;
      return true;
    },
  });
  for (const status of initial) registry[status.id] = status;
  return registry;
}

const readLang = (code) =>
  JSON.parse(readFileSync(new URL(`../../lang/${code}.json`, import.meta.url), 'utf8'));

const resolve = (tree, dotted) => dotted.split('.').reduce((node, key) => node?.[key], tree);

// ---------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------

const ids = SPACEHOLDER_STATUS_EFFECTS.map((s) => s.id);
assert('status ids are unique', new Set(ids).size === ids.length, ids);
assert(
  'every STATUS_IDS value is defined',
  Object.values(STATUS_IDS).every((id) => ids.includes(id)),
  { ids },
);
assert(
  'every definition has an id, a name key, an image and an order',
  SPACEHOLDER_STATUS_EFFECTS.every(
    (s) => s.id && s.name && s.img && Number.isFinite(s.order),
  ),
);
assert(
  'combat statuses are limited to actor types that fight',
  SPACEHOLDER_STATUS_EFFECTS.every((s) => Array.isArray(s.hud?.actorTypes) && s.hud.actorTypes.length > 0),
);

for (const code of ['en', 'ru']) {
  const lang = readLang(code);
  for (const status of SPACEHOLDER_STATUS_EFFECTS) {
    const text = resolve(lang, status.name);
    assert(`${code}: «${status.name}» is localized`, typeof text === 'string' && text.length > 0 && text !== status.name, text);
  }
}
assert('ru: Боеготовность', resolve(readLang('ru'), 'SPACEHOLDER.Effect.Statuses.combatReady') === 'Боеготовность');

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

const config = { statusEffects: createStatusEffects([{ id: 'dead', name: 'EFFECT.StatusDead', img: 'icons/svg/skull.svg' }]) };
const registered = registerSpaceholderStatusEffects(config);

assert('register returns the ids it added', registered.join() === ids.join(), registered);
assert('status is reachable by id', config.statusEffects.combatReady?.id === 'combatReady');
assert('status is in the list too (the token HUD iterates it)', config.statusEffects.some((s) => s.id === 'combatReady'));
assert('Foundry\'s own statuses stay', config.statusEffects.dead?.id === 'dead' && config.statusEffects.length === 1 + ids.length);

registerSpaceholderStatusEffects(config);
assert('registering twice does not duplicate', config.statusEffects.length === 1 + ids.length, config.statusEffects.length);

config.statusEffects.combatReady.img = 'somewhere/else.svg';
assert(
  'a decorated entry does not leak back into the definitions',
  SPACEHOLDER_STATUS_EFFECTS.find((s) => s.id === 'combatReady').img === 'icons/svg/combat.svg',
);

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

const events = Object.values(STATUS_EVENTS);
assert(
  'every endOn of a definition is a known event',
  SPACEHOLDER_STATUS_EFFECTS.every((s) => (s.endOn ?? []).every((e) => events.includes(e))),
);
assert(
  'every state of the hit-resistance table is a defined status',
  Object.keys(HIT_RESISTANCE_STATES).every((id) => ids.includes(id)),
  Object.keys(HIT_RESISTANCE_STATES),
);

const registry = config.statusEffects;
assert('combat ready: dead blocks it', activeBlockers('combatReady', ['dead'], registry).join() === 'dead');
assert('combat ready: unconscious blocks it', activeBlockers('combatReady', new Set(['unconscious']), registry).join() === 'unconscious');
assert('combat ready: both listed, in the list order',
  activeBlockers('combatReady', ['unconscious', 'dead', 'moving'], registry).join() === 'dead,unconscious');
assert('combat ready: nothing blocks it on a healthy actor', activeBlockers('combatReady', ['moving', 'cover'], registry).length === 0);
assert('blockers: a status without a list is never blocked', activeBlockers('moving', ['dead'], registry).length === 0);
assert('blockers: an unknown status is never blocked', activeBlockers('nope', ['dead'], registry).length === 0);
assert(
  'blockers: dead and unconscious are the ids of Foundry core statuses',
  CORE_STATUS_IDS.DEAD === 'dead' && CORE_STATUS_IDS.UNCONSCIOUS === 'unconscious',
);

registry.combatReady.blockedBy.push('stun');
assert('blockers: the list is extendable at runtime', activeBlockers('combatReady', ['stun'], registry).join() === 'stun');
assert('blockers: the definitions are not touched by that',
  !SPACEHOLDER_STATUS_EFFECTS.find((s) => s.id === 'combatReady').blockedBy.includes('stun'));

assert('actor types: combat statuses fit characters and NPCs, not loot',
  statusFitsActorType('combatReady', 'character', registry) && statusFitsActorType('moving', 'npc', registry)
  && !statusFitsActorType('combatReady', 'loot', registry));
assert('actor types: a status without hud.actorTypes fits anyone', statusFitsActorType('dead', 'loot', registry));

const ends = (statusIds, own) => [...endEventsOf(statusIds, own, registry)].sort().join();
assert('endOn: combat ready ends with the combat', ends(['combatReady']) === 'combatEnd');
assert('endOn: moving ends on another action, with the round and with the combat', ends(['moving']) === 'action,combatEnd,roundStart');
assert('endOn: cover and hidden end when the token moves', ends(['cover']) === 'move' && ends(['hidden']) === 'move');
assert('endOn: an effect that is not a status carries its own list', ends([], ['move', 'turn']) === 'move,turn');
assert('endOn: own list and statuses add up', ends(['cover'], ['turn']) === 'move,turn');
assert('endOn: nothing for an unknown status or a bad own list', ends(['nope'], 'move') === '');

assert('token change: a position change is a move', tokenChangeEvents({ x: 10 }).join() === 'move' && tokenChangeEvents({ y: 0 }).join() === 'move');
assert('token change: a facing change is a turn', tokenChangeEvents({ rotation: 90 }).join() === 'turn');
assert('token change: both', tokenChangeEvents({ x: 1, rotation: 5 }).join() === 'move,turn');
assert('token change: anything else is neither', tokenChangeEvents({ name: 'A', hidden: true }).length === 0
  && tokenChangeEvents(null).length === 0 && tokenChangeEvents(undefined).length === 0);

// ---------------------------------------------------------------------------------------------
// Against Foundry's own ActiveEffect model (optional)
// ---------------------------------------------------------------------------------------------

const foundryApp = process.env.FOUNDRY_APP ?? 'E:/Foundry14/Foundry Virtual Tabletop/resources/app';
const serverEntry = join(foundryApp, 'common/server.mjs');

if (!existsSync(serverEntry)) {
  console.log(`SKIP  Foundry source not found at ${foundryApp} — set FOUNDRY_APP to run the ActiveEffect check`);
} else {
  globalThis.foundry = await import(pathToFileURL(serverEntry).href);
  const { BaseActiveEffect } = foundry.documents;
  globalThis.game = {
    view: 'setup',
    release: { version: '14.353', generation: 14, build: 353 },
    version: '14.353',
    system: { id: 'spaceholder', documentTypes: { ActiveEffect: {} } },
    documentTypes: { ActiveEffect: ['base'] },
    model: { ActiveEffect: { base: {} } },
    modules: new Map(),
  };
  globalThis.CONFIG = {
    ActiveEffect: { documentClass: BaseActiveEffect, dataModels: { base: foundry.data.ActiveEffectTypeDataModel } },
  };

  for (const status of SPACEHOLDER_STATUS_EFFECTS) {
    // What ActiveEffect.fromStatusEffect does with a CONFIG.statusEffects entry (client/documents/active-effect.mjs).
    const { id, hud: _hud, ...effectData } = structuredClone(status);
    effectData.name = 'Test';
    effectData.statuses = Array.from(new Set([id, ...(effectData.statuses ?? [])]));
    effectData.showIcon ??= foundry.CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS;

    let effect = null;
    let error = null;
    try {
      effect = new BaseActiveEffect(effectData);
    } catch (e) {
      error = e.message;
    }
    assert(`${id}: builds a valid ActiveEffect`, !!effect, error);
    if (!effect) continue;
    assert(`${id}: the effect carries its status`, effect.statuses.has(id));
    assert(`${id}: its icon is always shown on the token`, effect.showIcon === foundry.CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS);
    assert(`${id}: has no duration (stays until removed)`, effect.duration.value === null && effect.duration.expiry === null);
    assert(`${id}: changes nothing`, effect.system.changes.length === 0);
  }
}

if (failed) {
  console.log(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll status-effects checks passed');

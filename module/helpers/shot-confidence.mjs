/**
 * Shot confidence vs hit resistance.
 *
 * A shot is a miss for a reason, never for a die roll: the aiming-arc zone says how confidently the
 * shot was taken (a barrel thrown aside is not a tir), the target's state says how hard it is to hit
 * (a man under fire who is running is not an easy mark). A projectile that touches a token's hitbox hits
 * it only if the shot's confidence is **greater** than the token's resistance; otherwise it flies past
 * (`walkProjectileCollisions`, `judgeToken` in `hit-luck.mjs`).
 *
 * Pure rules, no Foundry globals: the shot manager supplies `resistanceFor(token)`.
 */

import { normalizeLuckZone } from './hit-luck.mjs';
import { STATUS_IDS } from './status-effects.mjs';

/**
 * Confidence of a shot per aiming-arc zone. 4 is left out on purpose. Purple (the shooter's crit
 * zone, nobody has it by default) sits above green so that it beats every resistance state.
 */
export const SHOT_CONFIDENCE_BY_ZONE = Object.freeze({
  red: 1,
  orange: 2,
  yellow: 3,
  green: 5,
  purple: 6,
});

/**
 * Resistance a state of the target gives. A state is a status of the actor (`status-effects.mjs`, ids are
 * the keys); the shot manager passes the ids of the statuses the actor has. States do not add up: the highest
 * one counts (a man in cover who is also running is as hard to hit as the harder of the two).
 */
export const HIT_RESISTANCE_STATES = Object.freeze({
  [STATUS_IDS.COMBAT_READY]: 1,
  [STATUS_IDS.MOVING]: 2,
  [STATUS_IDS.COVER]: 3,
  [STATUS_IDS.HIDDEN]: 5,
});

/** Resistance of a target in none of the states (not yet in the fight, standing in the open). */
export const HIT_RESISTANCE_BASE = 0;

/**
 * @param {unknown} zone aiming-arc zone id (`red` … `purple`); anything unknown counts as green
 * @returns {number} the shot's confidence
 */
export function zoneConfidence(zone) {
  return SHOT_CONFIDENCE_BY_ZONE[normalizeLuckZone(zone)];
}

/**
 * The flat resistance modifier an actor carries (`system.hitResistanceMod`, filled by active effects).
 * @param {unknown} raw stored value
 * @returns {number} a whole number; missing / invalid → 0
 */
export function normalizeHitResistanceMod(raw) {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {{ states?: Iterable<string>, modifier?: unknown }} [args] ids of the actor's statuses (those
 *   not in {@link HIT_RESISTANCE_STATES} are ignored) and the actor's flat modifier
 * @returns {{ value: number, base: number, modifier: number, states: string[] }} `value` is never
 *   below 0; `states` are the known ones that apply
 */
export function computeHitResistance({ states = [], modifier = 0 } = {}) {
  const known = [...new Set(states)].filter((id) => Object.hasOwn(HIT_RESISTANCE_STATES, id));
  const base = known.reduce((max, id) => Math.max(max, HIT_RESISTANCE_STATES[id]), HIT_RESISTANCE_BASE);
  const mod = normalizeHitResistanceMod(modifier);
  return { value: Math.max(0, base + mod), base, modifier: mod, states: known };
}

/**
 * Does a shot of this confidence hit a target of this resistance?
 * @param {number} confidence
 * @param {number} resistance
 * @returns {boolean}
 */
export function shotHits(confidence, resistance) {
  return Number(confidence) > Number(resistance);
}

/**
 * The `judgeToken` hook of `walkProjectileCollisions` for one shot: a touched token is flown past
 * when the shot's confidence does not beat its resistance. The verdict's `details` say why, for the
 * journal.
 *
 * @param {{
 *   confidence: number|null|undefined,
 *   resistanceFor: (tokenObject: any) => ReturnType<typeof computeHitResistance>
 * }} args `confidence` null/undefined — the shot carries no confidence (AoE, debug shots): no judging
 * @returns {((collision: { object?: any }) => { pass: boolean, details: object })|null} `null` when
 *   there is nothing to judge with
 */
export function createTokenJudge({ confidence, resistanceFor }) {
  if (confidence == null || !Number.isFinite(Number(confidence)) || typeof resistanceFor !== 'function') return null;
  const shotConfidence = Number(confidence);
  return (collision) => {
    const resistance = resistanceFor(collision?.object);
    return {
      pass: !shotHits(shotConfidence, resistance.value),
      details: {
        confidence: shotConfidence,
        resistance: resistance.value,
        resistanceStates: resistance.states,
        resistanceMod: resistance.modifier,
      },
    };
  };
}

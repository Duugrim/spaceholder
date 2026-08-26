/**
 * Seeded generation + action replay for the lockpick minigame.
 */

import { createRng, rngInt } from '../hack/rng.mjs';
import {
  circularDistance,
  cloneSession,
  rotatePick,
  switchPin,
  tryCheck,
} from './lockpick-session.mjs';
import {
  DEFAULT_SOUND_SLOTS,
  DEFAULT_SOUND_VOLUMES,
  LOCKPICK_SOUND_IDS,
  normalizeSoundSlots,
  normalizeSoundVolumes,
} from './lockpick-audio.mjs';

export const LOCKPICK_SEGMENT_OPTIONS = Object.freeze([1, 2, 5, 6, 10, 20]);
export const DEFAULT_LOCKPICK_PINS = 5;
export const DEFAULT_LOCKPICK_SEGMENT_DEG = 10;
export const DEFAULT_LOCKPICK_TMIN = 1;
export const DEFAULT_LOCKPICK_TMAX = 2;
export const DEFAULT_LOCKPICK_HP = 3;
export const DEFAULT_LOCKPICK_FAIL_JUMP_MAX = 3;
export const DEFAULT_LOCKPICK_NOISE_CHANCE = 0.05;

/**
 * @returns {string}
 */
export function randomLockpickSeed() {
  try {
    return foundry.utils.randomID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  } catch (_) {
    return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/**
 * @param {object} raw
 */
export function normalizeLockpickParams(raw = {}) {
  const seed = String(raw.seed ?? '').trim();
  if (!seed) return null;

  let segmentDegrees = Math.floor(Number(raw.segmentDegrees) || DEFAULT_LOCKPICK_SEGMENT_DEG);
  if (!LOCKPICK_SEGMENT_OPTIONS.includes(segmentDegrees)) {
    segmentDegrees = DEFAULT_LOCKPICK_SEGMENT_DEG;
  }
  if (360 % segmentDegrees !== 0) {
    segmentDegrees = DEFAULT_LOCKPICK_SEGMENT_DEG;
  }

  const pinCount = Math.max(1, Math.min(20, Math.floor(Number(raw.pinCount) || DEFAULT_LOCKPICK_PINS)));
  let toleranceMin = Math.max(0, Math.floor(Number(raw.toleranceMin) ?? DEFAULT_LOCKPICK_TMIN));
  let toleranceMax = Math.max(0, Math.floor(Number(raw.toleranceMax) ?? DEFAULT_LOCKPICK_TMAX));
  if (toleranceMax < toleranceMin) {
    const tmp = toleranceMin;
    toleranceMin = toleranceMax;
    toleranceMax = tmp;
  }

  const pinHpMax = Math.max(1, Math.min(20, Math.floor(Number(raw.pinHpMax) || DEFAULT_LOCKPICK_HP)));
  const failJumpEnabled = !!raw.failJumpEnabled;
  const failJumpMax = Math.max(0, Math.min(180, Math.floor(Number(raw.failJumpMax) || DEFAULT_LOCKPICK_FAIL_JUMP_MAX)));
  const soundNoiseEnabled = !!raw.soundNoiseEnabled;
  let soundNoiseChance = Number(raw.soundNoiseChance);
  if (!Number.isFinite(soundNoiseChance)) soundNoiseChance = DEFAULT_LOCKPICK_NOISE_CHANCE;
  soundNoiseChance = Math.max(0, Math.min(1, soundNoiseChance));

  return {
    seed,
    segmentDegrees,
    pinCount,
    toleranceMin,
    toleranceMax,
    pinHpMax,
    failJumpEnabled,
    failJumpMax,
    soundNoiseEnabled,
    soundNoiseChance,
    soundSlots: normalizeSoundSlots(raw.soundSlots),
    soundVolumes: normalizeSoundVolumes(raw.soundVolumes),
  };
}

/**
 * @param {object} params normalized or raw
 * @returns {import('./lockpick-session.mjs').LockpickSession}
 */
export function generateLockpickSession(params = {}) {
  const p = normalizeLockpickParams(params) || normalizeLockpickParams({
    ...params,
    seed: randomLockpickSeed(),
  });
  if (!p) throw new Error('lockpick params invalid');

  const rng = createRng(p.seed);
  const segmentCount = 360 / p.segmentDegrees;

  /** @type {import('./lockpick-session.mjs').LockpickPin[]} */
  const pins = [];
  for (let i = 0; i < p.pinCount; i += 1) {
    pins.push({
      targetSegment: rngInt(rng, 0, segmentCount - 1),
      tolerance: rngInt(rng, p.toleranceMin, p.toleranceMax),
      unlocked: false,
      hp: p.pinHpMax,
    });
  }

  return {
    seed: p.seed,
    segmentDegrees: p.segmentDegrees,
    segmentCount,
    pinCount: p.pinCount,
    pinHpMax: p.pinHpMax,
    toleranceMin: p.toleranceMin,
    toleranceMax: p.toleranceMax,
    failJumpEnabled: p.failJumpEnabled,
    failJumpMax: p.failJumpMax,
    soundNoiseEnabled: p.soundNoiseEnabled,
    soundNoiseChance: p.soundNoiseChance,
    soundSlots: { ...p.soundSlots },
    soundVolumes: { ...p.soundVolumes },
    activePinIndex: 0,
    pickSegment: 0,
    pins,
    won: false,
    checkCount: 0,
  };
}

/**
 * Serialize a logged action for chat sync.
 * @param {object} action
 */
export function serializeLockpickAction(action) {
  const type = String(action?.type || '');
  if (type === 'rotate') {
    return {
      type: 'rotate',
      delta: action.delta >= 0 ? 1 : -1,
      playedHot: !!action.playedHot,
    };
  }
  if (type === 'switch') {
    return {
      type: 'switch',
      index: Math.max(0, Math.floor(Number(action.index) || 0)),
    };
  }
  if (type === 'check') {
    return {
      type: 'check',
      jumpDelta: Math.floor(Number(action.jumpDelta) || 0),
    };
  }
  return { type: 'noop' };
}

/**
 * Apply one logged action (deterministic — uses logged noise/jump outcomes).
 * @param {import('./lockpick-session.mjs').LockpickSession} session
 * @param {object} action
 */
export function applyLockpickAction(session, action) {
  const a = serializeLockpickAction(action);
  if (a.type === 'rotate') {
    const { session: next } = rotatePick(session, a.delta, { playedHot: a.playedHot });
    return next;
  }
  if (a.type === 'switch') {
    return switchPin(session, a.index);
  }
  if (a.type === 'check') {
    const { session: next } = tryCheck(session, { jumpDelta: a.jumpDelta });
    return next;
  }
  return cloneSession(session);
}

/**
 * Replay from params + action log.
 * @param {object} params
 * @param {object[]} [actions]
 * @returns {{ session: import('./lockpick-session.mjs').LockpickSession, stats: { checkCount: number, pinsUnlocked: number } }}
 */
export function replayLockpickSession(params, actions = []) {
  let session = generateLockpickSession(params);
  const list = Array.isArray(actions) ? actions : [];
  for (const action of list) {
    session = applyLockpickAction(session, action);
  }
  return {
    session,
    stats: {
      checkCount: session.checkCount || 0,
      pinsUnlocked: session.pins.filter((p) => p.unlocked).length,
    },
  };
}

/**
 * Live rotate with optional sound noise (rng from seed+checkCount+pick for variety,
 * but outcome is returned so caller can log it).
 * @param {import('./lockpick-session.mjs').LockpickSession} session
 * @param {number} delta
 * @param {() => number} [rng]
 */
export function liveRotate(session, delta, rng) {
  const { session: moved, reallyHot } = rotatePick(session, delta);
  let playedHot = reallyHot;
  if (session.soundNoiseEnabled && typeof rng === 'function') {
    if (rng() < session.soundNoiseChance) playedHot = !reallyHot;
  }
  // Re-apply with logged outcome baked (session already moved; only flag matters for audio)
  return { session: moved, playedHot, reallyHot };
}

/**
 * Live check: roll fail-jump if needed.
 * @param {import('./lockpick-session.mjs').LockpickSession} session
 * @param {() => number} [rng]
 */
export function liveCheck(session, rng) {
  let jumpDelta = 0;
  if (session.failJumpEnabled && session.failJumpMax > 0 && typeof rng === 'function') {
    const pin = session.pins[session.activePinIndex];
    const wouldSucceed = pin
      ? circularDistance(session.pickSegment, pin.targetSegment, session.segmentCount) <= pin.tolerance
      : false;
    if (!wouldSucceed) {
      const mag = rngInt(rng, 1, session.failJumpMax);
      jumpDelta = rng() < 0.5 ? -mag : mag;
    }
  }
  return tryCheck(session, { jumpDelta });
}

export { DEFAULT_SOUND_SLOTS, DEFAULT_SOUND_VOLUMES, LOCKPICK_SOUND_IDS };

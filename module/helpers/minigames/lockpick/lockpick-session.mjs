/**
 * Lockpick minigame session helpers: zones, mutate API, serialize.
 */

/**
 * @typedef {object} LockpickPin
 * @property {number} targetSegment
 * @property {number} tolerance
 * @property {boolean} unlocked
 * @property {number} hp
 */

/**
 * @typedef {object} LockpickSoundSlots
 * @property {string} segmentHot
 * @property {string} segmentCold
 * @property {string} pinPassed
 * @property {string} pinReset
 */

/**
 * @typedef {object} LockpickSession
 * @property {string} seed
 * @property {number} segmentDegrees
 * @property {number} segmentCount
 * @property {number} pinCount
 * @property {number} pinHpMax
 * @property {number} toleranceMin
 * @property {number} toleranceMax
 * @property {boolean} failJumpEnabled
 * @property {number} failJumpMax
 * @property {boolean} soundNoiseEnabled
 * @property {number} soundNoiseChance
 * @property {LockpickSoundSlots} soundSlots
 * @property {{ segmentHot: number, segmentCold: number, pinPassed: number, pinReset: number }} soundVolumes
 * @property {number} activePinIndex
 * @property {number} pickSegment
 * @property {LockpickPin[]} pins
 * @property {boolean} won
 * @property {number} checkCount
 */

/**
 * Circular distance on a ring of `n` segments.
 * @param {number} a
 * @param {number} b
 * @param {number} n
 */
export function circularDistance(a, b, n) {
  if (!(n > 0)) return 0;
  const d = Math.abs(((a % n) + n) % n - ((b % n) + n) % n);
  return Math.min(d, n - d);
}

/**
 * @param {number} pick
 * @param {number} target
 * @param {number} tolerance
 * @param {number} segmentCount
 */
export function inSuccessZone(pick, target, tolerance, segmentCount) {
  const T = Math.max(0, Math.floor(Number(tolerance) || 0));
  return circularDistance(pick, target, segmentCount) <= T;
}

/**
 * Hot sound zone is ±2T (width 4T+1). At T=0 only the exact segment.
 * @param {number} pick
 * @param {number} target
 * @param {number} tolerance
 * @param {number} segmentCount
 */
export function inHotZone(pick, target, tolerance, segmentCount) {
  const T = Math.max(0, Math.floor(Number(tolerance) || 0));
  return circularDistance(pick, target, segmentCount) <= 2 * T;
}

/**
 * @param {number} tolerance
 * @param {number} tMin
 * @param {number} tMax
 * @returns {'low'|'mid'|'high'}
 */
export function toleranceBand(tolerance, tMin, tMax) {
  const T = Math.max(0, Number(tolerance) || 0);
  const lo = Math.max(0, Number(tMin) || 0);
  const hi = Math.max(lo, Number(tMax) || lo);
  if (hi <= lo) return 'mid';
  const t = (T - lo) / (hi - lo);
  if (t < 1 / 3) return 'low';
  if (t < 2 / 3) return 'mid';
  return 'high';
}

/**
 * Neighbor pin indices (adjacent only).
 * @param {number} index
 * @param {number} pinCount
 * @returns {number[]}
 */
export function neighborIndices(index, pinCount) {
  /** @type {number[]} */
  const out = [];
  if (index > 0) out.push(index - 1);
  if (index < pinCount - 1) out.push(index + 1);
  return out;
}

/**
 * Visual rotation degrees for pick (0 = top, clockwise positive for CSS).
 * Centers segment 0 at top via half-segment offset baked into segment indexing.
 * @param {number} pickSegment
 * @param {number} segmentDegrees
 */
export function pickRotationDeg(pickSegment, segmentDegrees) {
  const step = Number(segmentDegrees) || 5;
  return pickSegment * step;
}

/**
 * Deep-ish clone of session (plain data).
 * @param {LockpickSession} session
 * @returns {LockpickSession}
 */
export function cloneSession(session) {
  return {
    ...session,
    soundSlots: { ...session.soundSlots },
    soundVolumes: { ...(session.soundVolumes || {}) },
    pins: session.pins.map((p) => ({ ...p })),
  };
}

/**
 * @param {LockpickSession} session
 * @param {number} delta +1 or -1
 * @param {{ playedHot?: boolean }} [opts] if playedHot set, use it; else compute
 * @returns {{ session: LockpickSession, playedHot: boolean, reallyHot: boolean }}
 */
export function rotatePick(session, delta, opts = {}) {
  const next = cloneSession(session);
  if (next.won) return { session: next, playedHot: false, reallyHot: false };

  const n = next.segmentCount;
  const d = delta >= 0 ? 1 : -1;
  next.pickSegment = (((next.pickSegment + d) % n) + n) % n;

  const pin = next.pins[next.activePinIndex];
  const reallyHot = pin
    ? inHotZone(next.pickSegment, pin.targetSegment, pin.tolerance, n)
    : false;

  let playedHot = reallyHot;
  if (opts.playedHot != null) {
    playedHot = !!opts.playedHot;
  }

  return { session: next, playedHot, reallyHot };
}

/**
 * @param {LockpickSession} session
 * @param {number} index
 * @returns {LockpickSession}
 */
export function switchPin(session, index) {
  const next = cloneSession(session);
  if (next.won) return next;
  const i = Math.max(0, Math.min(next.pinCount - 1, Math.floor(Number(index) || 0)));
  next.activePinIndex = i;
  return next;
}

/**
 * @param {LockpickSession} session
 * @param {number} delta +1 / -1 relative to active
 * @returns {LockpickSession}
 */
export function switchPinRelative(session, delta) {
  const next = cloneSession(session);
  if (next.won) return next;
  const d = delta >= 0 ? 1 : -1;
  next.activePinIndex = Math.max(0, Math.min(next.pinCount - 1, next.activePinIndex + d));
  return next;
}

/**
 * Apply a failed-check jump to the active pin's target.
 * @param {LockpickSession} session
 * @param {number} jumpDelta signed segment delta (already chosen)
 */
export function applyTargetJump(session, jumpDelta) {
  const next = cloneSession(session);
  const pin = next.pins[next.activePinIndex];
  if (!pin || !jumpDelta) return next;
  const n = next.segmentCount;
  pin.targetSegment = (((pin.targetSegment + jumpDelta) % n) + n) % n;
  return next;
}

/**
 * Attempt Space check on active pin.
 * @param {LockpickSession} session
 * @param {{ jumpDelta?: number }} [opts] jumpDelta applied on miss when fail-jump on
 * @returns {{
 *   session: LockpickSession,
 *   success: boolean,
 *   resetPins: number[],
 *   damagedPins: number[],
 *   jumpDelta: number
 * }}
 */
export function tryCheck(session, opts = {}) {
  const next = cloneSession(session);
  if (next.won) {
    return { session: next, success: true, resetPins: [], damagedPins: [], jumpDelta: 0 };
  }

  const pin = next.pins[next.activePinIndex];
  if (!pin) {
    return { session: next, success: false, resetPins: [], damagedPins: [], jumpDelta: 0 };
  }

  next.checkCount = (next.checkCount || 0) + 1;
  const success = inSuccessZone(
    next.pickSegment,
    pin.targetSegment,
    pin.tolerance,
    next.segmentCount
  );

  if (success) {
    if (!pin.unlocked) {
      pin.unlocked = true;
      pin.hp = next.pinHpMax;
    }
    next.won = next.pins.every((p) => p.unlocked);
    return { session: next, success: true, resetPins: [], damagedPins: [], jumpDelta: 0 };
  }

  /** @type {number[]} */
  const damagedPins = [];
  /** @type {number[]} */
  const resetPins = [];

  for (const ni of neighborIndices(next.activePinIndex, next.pinCount)) {
    const neighbor = next.pins[ni];
    if (!neighbor?.unlocked) continue;
    neighbor.hp = Math.max(0, neighbor.hp - 1);
    damagedPins.push(ni);
    if (neighbor.hp <= 0) {
      neighbor.unlocked = false;
      neighbor.hp = next.pinHpMax;
      resetPins.push(ni);
    }
  }

  let jumpDelta = 0;
  if (next.failJumpEnabled && opts.jumpDelta != null) {
    jumpDelta = Math.floor(Number(opts.jumpDelta) || 0);
    if (jumpDelta) {
      const n = next.segmentCount;
      pin.targetSegment = (((pin.targetSegment + jumpDelta) % n) + n) % n;
    }
  }

  return { session: next, success: false, resetPins, damagedPins, jumpDelta };
}

/**
 * After unlocking the active pin, pick the next locked pin: prefer upward
 * (higher index), else downward.
 * @param {LockpickSession} session
 * @returns {number}
 */
export function findNextPinAfterUnlock(session) {
  const cur = session.activePinIndex;
  const n = session.pinCount;
  for (let i = cur + 1; i < n; i += 1) {
    if (!session.pins[i]?.unlocked) return i;
  }
  for (let i = cur - 1; i >= 0; i -= 1) {
    if (!session.pins[i]?.unlocked) return i;
  }
  return cur;
}

/**
 * How far the pin protrudes into the shear channel (1 = fully blocking, 0 = clear).
 * Locked pins are fully out; unlocked pins retract with remaining HP.
 * @param {{ unlocked: boolean, hp: number }} pin
 * @param {number} hpMax
 */
export function pinExtendRatio(pin, hpMax) {
  if (!pin?.unlocked) return 1;
  const max = Math.max(1, Number(hpMax) || 1);
  const hp = Math.max(0, Math.min(max, Number(pin.hp) || 0));
  // Full HP → aside (0); damaged → sticks out again
  return 1 - hp / max;
}

/**
 * View model for UI (no secrets beyond what MVP shows — targets stay hidden).
 * @param {LockpickSession} session
 */
export function sessionToView(session) {
  const pin = session.pins[session.activePinIndex];
  const reallyHot = pin
    ? inHotZone(session.pickSegment, pin.targetSegment, pin.tolerance, session.segmentCount)
    : false;
  const inSuccess = pin
    ? inSuccessZone(session.pickSegment, pin.targetSegment, pin.tolerance, session.segmentCount)
    : false;

  const pins = session.pins.map((p, i) => {
    const band = toleranceBand(p.tolerance, session.toleranceMin, session.toleranceMax);
    const extend = pinExtendRatio(p, session.pinHpMax);
    return {
      index: i,
      label: i + 1,
      unlocked: !!p.unlocked,
      hp: p.hp,
      hpMax: session.pinHpMax,
      active: i === session.activePinIndex,
      toleranceBand: band,
      /** CSS --sh-lp-extend 0..1 */
      extend,
      extendPct: Math.round(extend * 100),
    };
  });

  // Display top→bottom visually: high index at top
  const pinsTopFirst = [...pins].reverse();
  const activeFromTop = pinsTopFirst.findIndex((p) => p.active);

  return {
    seed: session.seed,
    segmentDegrees: session.segmentDegrees,
    segmentCount: session.segmentCount,
    pickSegment: session.pickSegment,
    pickRotation: pickRotationDeg(session.pickSegment, session.segmentDegrees),
    activePinIndex: session.activePinIndex,
    activeFromTop: activeFromTop < 0 ? 0 : activeFromTop,
    pinCount: session.pinCount,
    pinHpMax: session.pinHpMax,
    won: !!session.won,
    checkCount: session.checkCount || 0,
    reallyHot,
    inSuccess,
    pins,
    pinsTopFirst,
    soundSlots: { ...session.soundSlots },
    soundVolumes: { ...(session.soundVolumes || {}) },
  };
}

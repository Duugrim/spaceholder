/**
 * Derived character stats — pure formulas (no Foundry globals), so they can be
 * unit-tested with plain Node. The Actor document only gathers inputs and calls
 * {@link computeDerivedStats}.
 *
 * Design source of truth: docs/Kanban/Характеристики актёра.md and
 * docs/code/reference/DERIVED_STATS.md.
 *
 * Scale: 100 = average human, 200 = human peak, 0 = non-functional.
 * STR is absolute (kg / "effort"); END and AGI are relative to the species norm
 * (the norm lives in the anatomy: HP, height, base speed).
 */

/** Value that means "the norm" on every ability. */
export const ABILITY_NORM = 100;

/** Ability ids on the new scale (AGI was `dex`). */
export const ABILITY_IDS = Object.freeze(['end', 'str', 'agi', 'cor', 'per', 'int', 'luc']);

/** Defaults for `system.params` (wearable/effect modifiers add to these). */
export const DEFAULT_PARAMS = Object.freeze({
  /** γ = g / 9.81 acting on the actor. */
  gravity: 1,
  /** Passive perception share of PER. */
  awarenessMult: 0.5,
  /** Multiplier on INT for the will score. */
  willMult: 1,
  /** Turn starts per round (each start refills the AP pool). */
  turnStarts: 3,
});

/** Base combat speed of a species when its anatomy does not define `speedMps`. */
export const DEFAULT_SPEED_MPS = 3;
export const DEFAULT_HEIGHT_M = 1.75;

/** Below this γ the "÷γ" laws stop growing (in zero-g inertia sets the limit, not weight). */
export const MIN_GRAVITY = 0.1;
/** Leg thrust-to-weight of a human; at γ ≥ this value there is no push-off. */
export const THRUST_TO_WEIGHT = 2.3;

/** Lift = STR² / LIFT_DIVISOR kg (80 kg at STR 100). */
export const LIFT_DIVISOR = 125;
/** Sprint = SPRINT_MULT × combat speed. */
export const SPRINT_MULT = 2;
/** Walking (march) share of the combat speed at END 100: 1.4 / 3. */
export const WALK_RATIO = 7 / 15;
/** Speed multiplier reached at the lift limit (load == lift). */
export const ENCUMBRANCE_MIN_FACTOR = 0.5;

/** Reference long jump: 3.6 m with a 6 m/s sprint. */
export const RUN_JUMP_REF_M = 3.6;
export const RUN_JUMP_REF_SPEED = 6;
export const RUN_JUMP_EXPONENT = 1.5;

/** Height thresholds as shares of body height: [body part, jump part]. */
export const HEIGHT_THRESHOLDS = Object.freeze({
  run: Object.freeze([0.1, 0.15]),
  climb: Object.freeze([0.35, 0.25]),
  pull: Object.freeze([1.05, 0.25]),
});

/** Smallest action-speed multiplier (COR → 0 would make every action infinitely expensive). */
export const MIN_ACTION_SPEED_MULT = 0.05;

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {unknown} value
 * @returns {number} finite, ≥ 0
 */
function nonNeg(value) {
  return Math.max(0, num(value, 0));
}

/**
 * d20-style modifier: floor(√value). 10 for an average character.
 * @param {unknown} value
 * @returns {number}
 */
export function abilityMod(value) {
  return Math.floor(Math.sqrt(nonNeg(value)));
}

/**
 * γ used in "÷γ" formulas and gravity factors.
 * @param {unknown} gamma
 * @returns {number}
 */
export function effectiveGravity(gamma) {
  return Math.max(num(gamma, 1), MIN_GRAVITY);
}

/**
 * Speed factor Γv = √min(γ, 1/γ): peaks at γ = 1.
 * @param {unknown} gamma
 * @returns {number}
 */
export function speedGravityFactor(gamma) {
  const g = effectiveGravity(gamma);
  return Math.sqrt(Math.min(g, 1 / g));
}

/**
 * Jump factor J(γ) = min(1, (2.3 − γ) / 1.3) / γ, never below 0.
 * @param {unknown} gamma
 * @returns {number}
 */
export function jumpGravityFactor(gamma) {
  const g = effectiveGravity(gamma);
  return Math.max(0, Math.min(1, (THRUST_TO_WEIGHT - g) / (THRUST_TO_WEIGHT - 1)) / g);
}

/**
 * HP multiplier from END (relative): √(END / 100).
 * @param {unknown} end
 * @returns {number}
 */
export function healthMultiplier(end) {
  return Math.sqrt(nonNeg(end) / ABILITY_NORM);
}

/**
 * Max one-off lift, kg: STR² / 125 / γ*.
 * @param {unknown} str
 * @param {unknown} [gamma]
 * @returns {number}
 */
export function liftWeightKg(str, gamma = 1) {
  const s = nonNeg(str);
  return (s * s) / LIFT_DIVISOR / effectiveGravity(gamma);
}

/**
 * Sustained carry (no encumbrance penalty), kg: lift × END / (END + 100).
 * @param {unknown} str
 * @param {unknown} end
 * @param {unknown} [gamma]
 * @returns {number}
 */
export function carryWeightKg(str, end, gamma = 1) {
  const e = nonNeg(end);
  return liftWeightKg(str, gamma) * (e / (e + ABILITY_NORM));
}

/**
 * Speed multiplier from the carried load: 1 up to `carry`, then linear down to
 * 0.5 at `lift`; above `lift` the load cannot be carried (0).
 * @param {unknown} loadKg
 * @param {unknown} carryKg
 * @param {unknown} liftKg
 * @returns {number}
 */
export function encumbranceSpeedFactor(loadKg, carryKg, liftKg) {
  const load = nonNeg(loadKg);
  const carry = nonNeg(carryKg);
  const lift = nonNeg(liftKg);
  if (load <= carry) return 1;
  if (load > lift) return 0;
  if (lift <= carry) return 1;
  const x = (load - carry) / (lift - carry);
  return 1 - (1 - ENCUMBRANCE_MIN_FACTOR) * x;
}

/**
 * Action cost multiplier m = 2·COR / (COR + 100): 1 at 100, → 0 at 0, → 2 at ∞.
 * Cost = base / m.
 * @param {unknown} cor
 * @returns {number}
 */
export function actionSpeedMultiplier(cor) {
  const c = nonNeg(cor);
  return (2 * c) / (c + ABILITY_NORM);
}

/**
 * AP cost of an action after coordination. Non-positive bases are untouched;
 * positive bases never drop below 1 (nothing becomes free).
 * Movement is NOT passed through this function.
 * @param {unknown} baseCost
 * @param {unknown} cor
 * @returns {number}
 */
export function applyActionSpeedToCost(baseCost, cor) {
  const base = num(baseCost, 0);
  if (base <= 0) return base;
  const m = Math.max(actionSpeedMultiplier(cor), MIN_ACTION_SPEED_MULT);
  return Math.max(1, Math.round(base / m));
}

/**
 * Combat speed, m/s: species speed × AGI/100 × Γv(γ) × load factor.
 * @param {object} p
 * @param {number} p.agi
 * @param {number} [p.speedMps]
 * @param {number} [p.gamma]
 * @param {number} [p.loadFactor]
 * @returns {number}
 */
export function combatSpeedMps({ agi, speedMps = DEFAULT_SPEED_MPS, gamma = 1, loadFactor = 1 }) {
  return nonNeg(speedMps) * (nonNeg(agi) / ABILITY_NORM) * speedGravityFactor(gamma) * nonNeg(loadFactor);
}

/**
 * March speed, m/s: min(7/15 × species × √(END/100), species × AGI/100) × Γv × load.
 * @param {object} p
 * @param {number} p.agi
 * @param {number} p.end
 * @param {number} [p.speedMps]
 * @param {number} [p.gamma]
 * @param {number} [p.loadFactor]
 * @returns {number}
 */
export function travelSpeedMps({ agi, end, speedMps = DEFAULT_SPEED_MPS, gamma = 1, loadFactor = 1 }) {
  const species = nonNeg(speedMps);
  const byEnd = WALK_RATIO * species * Math.sqrt(nonNeg(end) / ABILITY_NORM);
  const byAgi = species * (nonNeg(agi) / ABILITY_NORM);
  return Math.min(byEnd, byAgi) * speedGravityFactor(gamma) * nonNeg(loadFactor);
}

/**
 * Running long jump, m: 3.6 × (v_sprint / 6)^1.5 × J(γ).
 * @param {number} sprintSpeed m/s (already includes γ and load)
 * @param {number} [gamma]
 * @returns {number}
 */
export function runningLongJumpM(sprintSpeed, gamma = 1) {
  const v = nonNeg(sprintSpeed);
  return RUN_JUMP_REF_M * Math.pow(v / RUN_JUMP_REF_SPEED, RUN_JUMP_EXPONENT) * jumpGravityFactor(gamma);
}

/**
 * Three obstacle heights, m: threshold = H × (body + jump × k), k = (AGI/100)^¼ × J(γ).
 * @param {object} p
 * @param {number} p.agi
 * @param {number} [p.heightM]
 * @param {number} [p.gamma]
 * @returns {{ run: number, climb: number, pull: number }}
 */
export function heightThresholds({ agi, heightM = DEFAULT_HEIGHT_M, gamma = 1 }) {
  const h = Math.max(0, num(heightM, DEFAULT_HEIGHT_M));
  const k = Math.pow(nonNeg(agi) / ABILITY_NORM, 0.25) * jumpGravityFactor(gamma);
  const at = ([body, jump]) => h * (body + jump * k);
  return {
    run: at(HEIGHT_THRESHOLDS.run),
    climb: at(HEIGHT_THRESHOLDS.climb),
    pull: at(HEIGHT_THRESHOLDS.pull),
  };
}

/**
 * Weighted geometric mean (both qualities needed).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function geometricMean(a, b) {
  return Math.sqrt(nonNeg(a) * nonNeg(b));
}

/**
 * Arithmetic mean (one high value is enough).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function arithmeticMean(a, b) {
  return (nonNeg(a) + nonNeg(b)) / 2;
}

/**
 * Max AP: floor(√(AGI × INT)). 100 for an average character.
 * @param {unknown} agi
 * @param {unknown} int
 * @returns {number}
 */
export function maxApFromScores(agi, int) {
  return Math.floor(geometricMean(agi, int));
}

/**
 * Heroism points: round(√LUC / 2). 5 at LUC 100.
 * @param {unknown} luc
 * @returns {number}
 */
export function heroismPoints(luc) {
  return Math.round(Math.sqrt(nonNeg(luc)) / 2);
}

/**
 * Second wind points: round(√(END × LUC) / 20) = heroism × √(END / 100).
 * @param {unknown} end
 * @param {unknown} luc
 * @returns {number}
 */
export function secondWindPoints(end, luc) {
  return Math.round(geometricMean(end, luc) / 20);
}

/**
 * Intuition pool max: round(√min(LUC, INT)).
 * @param {unknown} luc
 * @param {unknown} int
 * @returns {number}
 */
export function intuitionMax(luc, int) {
  return Math.round(Math.sqrt(Math.min(nonNeg(luc), nonNeg(int))));
}

/**
 * Total skill-level budget: round(√(PER × INT) / 2).
 * @param {unknown} per
 * @param {unknown} int
 * @returns {number}
 */
export function skillBudget(per, int) {
  return Math.round(geometricMean(per, int) / 2);
}

/**
 * Read `system.params`, falling back to {@link DEFAULT_PARAMS} for anything
 * missing or non-numeric.
 * @param {object|null|undefined} params
 * @returns {{ gravity: number, awarenessMult: number, willMult: number, turnStarts: number }}
 */
export function normalizeParams(params) {
  const src = params && typeof params === 'object' ? params : {};
  return {
    gravity: num(src.gravity, DEFAULT_PARAMS.gravity),
    awarenessMult: Math.max(0, num(src.awarenessMult, DEFAULT_PARAMS.awarenessMult)),
    willMult: Math.max(0, num(src.willMult, DEFAULT_PARAMS.willMult)),
    turnStarts: Math.max(1, Math.round(num(src.turnStarts, DEFAULT_PARAMS.turnStarts))),
  };
}

/**
 * Compute every derived stat of a character.
 *
 * @param {object} input
 * @param {Record<string, unknown>} input.abilities ability id → value (end, str, agi, cor, per, int, luc)
 * @param {number} [input.speedMps] species combat speed (anatomy), m/s
 * @param {number} [input.heightM] body height (anatomy), m
 * @param {object} [input.params] `system.params` (gravity, awarenessMult, willMult, turnStarts)
 * @param {number} [input.loadKg] carried weight; undefined/null → no encumbrance
 * @param {number} [input.apSlice] AP in one movement time slice (CONFIG.SPACEHOLDER.movementApTimeSlice)
 * @param {number} [input.apPerSecond] AP per second (weapon-model AP_PER_SECOND)
 * @param {number} [input.minDistPerSlice] smallest distance of a slice, m
 * @param {boolean} [input.encumbrance] apply the load penalty to speeds (default true)
 * @returns {Record<string, number>}
 */
export function computeDerivedStats(input = {}) {
  const a = input.abilities && typeof input.abilities === 'object' ? input.abilities : {};
  const val = (id) => nonNeg(a[id]);
  const end = val('end');
  const str = val('str');
  const agi = val('agi');
  const cor = val('cor');
  const per = val('per');
  const int = val('int');
  const luc = val('luc');

  const params = normalizeParams(input.params);
  const gamma = params.gravity;
  const speedMps = nonNeg(input.speedMps) > 0 ? nonNeg(input.speedMps) : DEFAULT_SPEED_MPS;
  const heightM = nonNeg(input.heightM) > 0 ? nonNeg(input.heightM) : DEFAULT_HEIGHT_M;
  const apPerSecond = Math.max(1, num(input.apPerSecond, 10));
  const apSlice = Math.max(1, num(input.apSlice, 10));
  const minDist = Math.max(Number.EPSILON, num(input.minDistPerSlice, 0.25));

  const healthMult = healthMultiplier(end);
  const lift = liftWeightKg(str, gamma);
  const carry = carryWeightKg(str, end, gamma);
  const loadKg = input.loadKg === undefined || input.loadKg === null ? 0 : nonNeg(input.loadKg);
  const loadFactor = input.encumbrance === false ? 1 : encumbranceSpeedFactor(loadKg, carry, lift);

  const combatSpeed = combatSpeedMps({ agi, speedMps, gamma, loadFactor });
  const sprintSpeed = SPRINT_MULT * combatSpeed;
  const travelSpeed = travelSpeedMps({ agi, end, speedMps, gamma, loadFactor });
  const heights = heightThresholds({ agi, heightM, gamma });

  // AP per metre: the movement slice lasts apSlice / apPerSecond seconds.
  const distPerSlice = combatSpeed * (apSlice / apPerSecond);
  const apPerMeter = apSlice / Math.max(minDist, distPerSlice);

  const actionSpeed = actionSpeedMultiplier(cor);

  return {
    gravity: gamma,
    healthMult,
    healthBonusPct: (healthMult - 1) * 100,
    liftWeight: lift,
    carryWeight: carry,
    loadKg,
    loadFactor,
    combatSpeed,
    sprintSpeed,
    travelSpeed,
    travelSpeedKmh: travelSpeed * 3.6,
    jumpLongRun: runningLongJumpM(sprintSpeed, gamma),
    heightRun: heights.run,
    heightClimb: heights.climb,
    heightPull: heights.pull,
    speedApPerMeter: apPerMeter,
    movementTimeSliceAp: apSlice,
    dexterityScore: arithmeticMean(agi, cor),
    actionSpeed,
    actionSpeedBonusPct: (actionSpeed - 1) * 100,
    reactionScore: geometricMean(agi, per),
    accuracyScore: geometricMean(cor, per),
    awarenessMult: params.awarenessMult,
    awarenessScore: per * params.awarenessMult,
    learnRateScore: geometricMean(per, int),
    skillBudget: skillBudget(per, int),
    willMult: params.willMult,
    willScore: int * params.willMult,
    intuitionMax: intuitionMax(luc, int),
    heroismPoints: heroismPoints(luc),
    secondWindPoints: secondWindPoints(end, luc),
    turnsPerRound: params.turnStarts,
    maxApFromAbilities: maxApFromScores(agi, int),
  };
}

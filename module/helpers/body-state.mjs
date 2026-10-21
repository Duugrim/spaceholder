/**
 * Body state from wounds — the part of an actor's health that follows from its injuries alone: part HP,
 * lost parts, organ states, bleeding, dead / dying — and the outcome of a hit on the seven-step scale the
 * balance work uses. Pure (no Foundry); the actor (`_prepareBodyParts`) and the balance tool both call it,
 * so the tool judges a shot exactly as the game would show it.
 *
 * Runs in plain Node: `node module/helpers/body-state.test.mjs`.
 */

import { computeLostParts } from './anatomy-relations.mjs';
import { computeDeathState, computeInnerState, partStructure } from './anatomy-groups.mjs';
import { computeBleeding } from './damage/bleeding.mjs';

/**
 * Damage a part has taken as a whole, from its raw wounds (`structure.saturation`, see `partStructure`): up to the
 * biggest single wound everything counts; above it the damage approaches `saturation` × that wound ever more
 * slowly. So the first hit counts in full, each next hit of the same strength less, and many weak hits never add
 * up to what one strong hit does. Order of the wounds does not matter (only their sum and the biggest one).
 * @param {number} sum sum of the raw wounds
 * @param {number} biggest the biggest single raw wound
 * @param {number} saturation `structure.saturation` (0 = no limit: the plain sum)
 * @returns {number}
 */
export function saturatedDamage(sum, biggest, saturation) {
  const total = Math.max(0, Number(sum) || 0);
  const top = Math.min(total, Math.max(0, Number(biggest) || 0));
  if (!(saturation >= 1) || total <= top) return total;
  const room = (saturation - 1) * top;
  if (!(room > 0)) return top;
  return top + room * (1 - Math.exp(-(total - top) / room));
}

/** Outcome ids from the mildest to the worst (the balance tool's outcome dictionary uses the same ids). */
export const WOUND_OUTCOME_IDS = Object.freeze(['stopped', 'graze', 'light', 'severe', 'mortal', 'destroyed', 'death']);

/**
 * Where the steps start:
 * - `graze` — at least this much damage (HP) reached the body at all; less is "stopped";
 * - `light` / `severe` — the worst wound reaches this share of its part's HP.
 */
export const WOUND_OUTCOME_THRESHOLDS = Object.freeze({
  graze: 1,
  light: 0.05,
  severe: 0.3,
});

/** Organ states in the reasons of {@link classifyOutcome} (a diagnostic line for the balance tool, Russian like it). */
const ORGAN_STATUS_WORDS = Object.freeze({ ok: 'цел', damaged: 'повреждён', destroyed: 'уничтожен', lost: 'потерян' });

/**
 * @typedef {Object} BodyWound a wound in HP units
 * @property {string} slotRef
 * @property {number} amount
 * @property {number} [initialAmount]
 * @property {string} [type]
 * @property {string} [status]
 * @property {Array<{id: string, amount: number}>} [inners]
 */

/**
 * Derive the state of the body from its wounds. Writes onto the parts (like an actor's prepared data):
 * `effectiveMaxHp`, `currentHp`, `healthPercentage`, `disabled`, `destroyed`, `lost`, `lostVia`, and on organs
 * `effectiveMaxHp`, `currentHp`, `lost`, `status`.
 *
 * Part HP = max − its damage as a whole ({@link saturatedDamage} of the raw wounds). At 0 HP and below the part is
 * `disabled`; it is `destroyed` (and lost with everything below it) at −`structure.reserve` of its max HP; a
 * disabled part keeps its negative HP. Organs and bleeding take the raw wounds.
 * @param {Record<string, object>} bodyParts parts keyed by slotRef (`maxHp`, `tissue`, `inners`, `relations`) — mutated
 * @param {BodyWound[]} wounds
 * @param {{ hpScale?: number, rootRef?: string|null, materialOf?: (part: object) => string }} [options]
 *   `hpScale` — the END multiplier of HP; `materialOf` — `biological` | `bionic` (bionic parts do not bleed)
 * @returns {{ bleeding: ReturnType<typeof computeBleeding>, death: ReturnType<typeof computeDeathState> }}
 */
export function applyBodyState(bodyParts, wounds, { hpScale = 1, rootRef = null, materialOf } = {}) {
  const parts = bodyParts && typeof bodyParts === 'object' ? bodyParts : {};
  const scale = Number.isFinite(hpScale) && hpScale > 0 ? hpScale : 1;
  const list = Array.isArray(wounds) ? wounds : [];

  const damageByPart = {};
  const biggestByPart = {};
  const damageByInner = {};
  for (const wound of list) {
    if (!parts[wound?.slotRef]) continue;
    const amount = Math.max(0, Number(wound.amount) || 0);
    damageByPart[wound.slotRef] = (damageByPart[wound.slotRef] ?? 0) + amount;
    biggestByPart[wound.slotRef] = Math.max(biggestByPart[wound.slotRef] ?? 0, amount);
    for (const organ of Array.isArray(wound.inners) ? wound.inners : []) {
      if (!organ?.id) continue;
      const perInner = (damageByInner[wound.slotRef] ??= {});
      perInner[organ.id] = (perInner[organ.id] ?? 0) + Math.max(0, Number(organ.amount) || 0);
    }
  }

  // HP: the stored `maxHp` × the END multiplier, minus whole units of the part's damage as a whole;
  // below 0 the part is disabled, below −reserve destroyed.
  for (const [slotRef, part] of Object.entries(parts)) {
    const baseMaxHp = Math.max(0, Number(part.maxHp) || 0);
    const effectiveMaxHp = scale === 1 ? baseMaxHp : Math.ceil(baseMaxHp * scale);
    const { saturation, reserve } = partStructure(part);
    const damage = saturatedDamage(damageByPart[slotRef] ?? 0, biggestByPart[slotRef] ?? 0, saturation);
    const units = Math.floor(Number(damage.toFixed(6)));
    const reserveHp = Math.floor(effectiveMaxHp * reserve);
    part.effectiveMaxHp = effectiveMaxHp;
    part.destroyed = effectiveMaxHp > 0 && units >= effectiveMaxHp + reserveHp;
    part.currentHp = Math.max(-reserveHp, effectiveMaxHp - units);
    part.disabled = effectiveMaxHp > 0 && !part.destroyed && part.currentHp <= 0;
    part.healthPercentage = effectiveMaxHp > 0 ? Math.floor((part.currentHp * 100) / effectiveMaxHp) : 100;
  }

  // Loss: a destroyed part is lost with everything below it in the `parent` tree.
  const lostMap = computeLostParts(parts);
  for (const [slotRef, part] of Object.entries(parts)) {
    const lostVia = lostMap[slotRef];
    part.lost = lostVia !== undefined;
    part.lostVia = part.lost && lostVia !== slotRef ? lostVia : null;
    if (!part.lost) continue;
    part.disabled = false;
    part.currentHp = 0;
    part.healthPercentage = 0;
  }

  // Organs: own HP (scaled like the parts'), damaged by the wounds that reached them; lost with their part.
  for (const [slotRef, part] of Object.entries(parts)) {
    for (const inner of Array.isArray(part.inners) ? part.inners : []) {
      Object.assign(inner, computeInnerState(inner, {
        damageAmount: Math.round((damageByInner[slotRef]?.[inner.id] ?? 0) * 100),
        hpScale: scale,
        lost: part.lost === true,
      }));
    }
  }

  const bleeding = computeBleeding({ bodyParts: parts, wounds: list, materialOf });
  const death = computeDeathState(parts, rootRef, { bleeding });
  return { bleeding, death };
}

/**
 * Outcome of a hit on the seven-step scale, from the body state after it:
 * - `destroyed` — the hit part is lost (`fatal` when that killed: the head, the upper torso with the heart);
 * - `death` — dead otherwise (a vital organ destroyed);
 * - `mortal` — dying (a vital organ damaged, or bleeding out within minutes);
 * - `severe` — the worst wound reaches {@link WOUND_OUTCOME_THRESHOLDS}.severe of its part, or an organ that
 *   is not vital was hit;
 * - `light` / `graze` / `stopped` — by the worst wound's share and by whether anything reached the body.
 *
 * @param {{ bodyParts: Record<string, object>, death: object, bleeding: object }} state parts after
 *   {@link applyBodyState}, and its result
 * @param {{ hitSlot: string, damageBySlot: Record<string, number>, organHits?: Array<{slot: string, id: string}> }} hit
 *   the part the hit landed in, the damage it put into each part (HP), the organs it reached
 * @param {typeof WOUND_OUTCOME_THRESHOLDS} [thresholds]
 * @returns {{ id: string, severity: number, fatal: boolean, why: string[] }} `why` — diagnostic lines (part share, organ
 *   states, time to bleed out) for the balance tool
 */
export function classifyOutcome({ bodyParts, death, bleeding }, { hitSlot, damageBySlot = {}, organHits = [] }, thresholds = WOUND_OUTCOME_THRESHOLDS) {
  const parts = bodyParts ?? {};
  const why = [];
  const result = (id, extra = {}) => ({ id, severity: WOUND_OUTCOME_IDS.indexOf(id), fatal: false, why, ...extra });
  const name = (slot) => parts[slot]?.name ?? slot;

  // The share of a part is what the body shows: max HP minus current HP (saturation and all), not the raw sum.
  let total = 0;
  let worst = 0;
  let worstSlot = hitSlot;
  for (const [slot, amount] of Object.entries(damageBySlot)) {
    const dmg = Math.max(0, Number(amount) || 0);
    total += dmg;
    if (!(dmg > 0)) continue;
    const part = parts[slot];
    const max = Math.max(1, Number(part?.effectiveMaxHp ?? part?.maxHp) || 0);
    const share = Number.isFinite(Number(part?.currentHp)) && Number(part?.effectiveMaxHp) > 0
      ? (part.effectiveMaxHp - part.currentHp) / part.effectiveMaxHp
      : dmg / max;
    if (share > worst) {
      worst = share;
      worstSlot = slot;
    }
  }
  if (total > 0) why.push(`${name(worstSlot)} ${Math.round(worst * 100)}% HP${parts[worstSlot]?.disabled ? ', не работает' : ''}`);
  const organs = organHits.map((hit) => (parts[hit.slot]?.inners ?? []).find((o) => o.id === hit.id)).filter(Boolean);
  for (const organ of organs) why.push(`${organ.name ?? organ.id}: ${ORGAN_STATUS_WORDS[organ.status] ?? organ.status}`);
  if (Number.isFinite(bleeding?.minutesToDeath)) why.push(`кровотечение ~${Math.round(bleeding.minutesToDeath)} мин`);

  const hit = parts[hitSlot];
  if (hit?.lost && !hit.lostVia) return result('destroyed', { fatal: death?.dead === true });
  if (death?.dead) return result('death');
  if (death?.dying) return result('mortal');
  if (worst >= thresholds.severe || organs.some((o) => o.status === 'damaged' || o.status === 'destroyed')) return result('severe');
  if (worst >= thresholds.light) return result('light');
  if (total >= thresholds.graze) return result('graze');
  return result('stopped');
}

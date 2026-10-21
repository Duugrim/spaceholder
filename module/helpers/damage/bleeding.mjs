/**
 * Bleeding — the static part: how fast a body loses blood right now and how long until that kills.
 * Blood actually draining over time, first aid and tourniquets are a later step (see the Kanban card
 * «A-L Кровопотеря»).
 *
 * Rate, % of blood per minute:
 * - every wound: `wound / part HP × part bleed × type factor × stage factor`
 *   (part bleed — `part.tissue.bleed`; type factor — `bleedFactor` of the damage type: blades bleed
 *   most, blows little, burns are cauterised; stage — an open wound bleeds fully, a closing or treated
 *   one a quarter, a scarring one not at all);
 * - every organ a wound reached: `organ damage / organ HP × organ bleed` (same stage factor);
 * - every part lost on its own (not with its parent): `part bleed × LOST_PART_BLEED`, plus the bleeding of every
 *   organ it held (torn out with it: losing the lower torso tears the liver, losing a thigh — the femoral
 *   artery).
 *
 * Pure; runs in plain Node (`node module/helpers/damage/bleeding.test.mjs`).
 */

import { bleedFactor } from './damage-types.mjs';
import { computeWoundState } from './injury-description.mjs';
import { partTissue } from '../anatomy-groups.mjs';

/** Blood a body can lose before it dies, %. */
export const BLOOD_POOL = 100;

/** Bleeding that kills faster than this (minutes) makes the wound mortal: the body is dying (a cut artery). */
export const MORTAL_BLEED_MINUTES = 5;

/** A stump bleeds like a wound this many times the whole part. */
export const LOST_PART_BLEED = 1.5;

const STAGE_FACTOR = Object.freeze({ bleeding: 1, clotting: 0.25 });

/**
 * How much of its bleeding a wound still has: open → 1, closing or treated → 0.25, scarring → 0.
 * @param {{amount?: number, initialAmount?: number, status?: string}} injury
 * @param {string} [material] `biological` | `bionic` (bionic parts do not bleed)
 * @returns {number}
 */
export function woundStageFactor(injury, material = 'biological') {
  if (material === 'bionic') return 0;
  return STAGE_FACTOR[computeWoundState(injury, null, material).bleed] ?? 0;
}

/**
 * @typedef {Object} BleedingWound
 * @property {string} slotRef part the wound is on
 * @property {number} amount damage, HP units
 * @property {number} [initialAmount] damage when it was fresh (healing progress)
 * @property {string} type damage type
 * @property {string} [status] `raw` | `treated`
 * @property {Array<{id: string, amount: number}>} [inners] organs the wound reached, damage in HP units
 */

/**
 * @param {Object} args
 * @param {Record<string, object>} args.bodyParts prepared parts (`effectiveMaxHp`/`maxHp`, `tissue`, `inners`,
 *   `lost`, `lostVia`, `material`)
 * @param {BleedingWound[]} args.wounds
 * @param {(part: object) => string} [args.materialOf] `biological` | `bionic` for a part
 * @returns {{ rate: number, minutesToDeath: number, mortal: boolean, bySlot: Record<string, number> }}
 *   `minutesToDeath` is `Infinity` when nothing bleeds
 */
export function computeBleeding({ bodyParts, wounds, materialOf = () => 'biological' } = {}) {
  const parts = bodyParts && typeof bodyParts === 'object' ? bodyParts : {};
  const bySlot = {};
  const add = (slot, value) => {
    if (!(value > 0)) return;
    bySlot[slot] = (bySlot[slot] ?? 0) + value;
  };

  for (const wound of Array.isArray(wounds) ? wounds : []) {
    const part = parts[wound?.slotRef];
    if (!part) continue;
    const material = materialOf(part);
    const stage = woundStageFactor(wound, material);
    if (stage <= 0) continue;
    const hp = Math.max(1, Number(part.effectiveMaxHp ?? part.maxHp) || 0);
    const amount = Math.max(0, Number(wound.amount) || 0);
    add(wound.slotRef, (amount / hp) * partTissue(part).bleed * bleedFactor(wound.type) * stage);
    for (const hit of Array.isArray(wound.inners) ? wound.inners : []) {
      const inner = (part.inners ?? []).find((o) => o?.id === hit?.id);
      const innerHp = Math.max(1, Number(inner?.effectiveMaxHp ?? inner?.maxHp) || 0);
      const bleed = Math.max(0, Number(inner?.bleed) || 0);
      add(wound.slotRef, (Math.max(0, Number(hit.amount) || 0) / innerHp) * bleed * stage);
    }
  }

  for (const [slot, part] of Object.entries(parts)) {
    if (!part?.lost || part.lostVia || materialOf(part) === 'bionic') continue;
    const organs = (part.inners ?? []).reduce((sum, inner) => sum + Math.max(0, Number(inner?.bleed) || 0), 0);
    add(slot, partTissue(part).bleed * LOST_PART_BLEED + organs);
  }

  const rate = Object.values(bySlot).reduce((s, v) => s + v, 0);
  const minutesToDeath = rate > 0 ? BLOOD_POOL / rate : Infinity;
  return { rate, minutesToDeath, mortal: minutesToDeath < MORTAL_BLEED_MINUTES, bySlot };
}

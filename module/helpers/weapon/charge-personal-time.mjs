/**
 * Apply ammo.charge.changePerSecond when personal time advances.
 */

import {
  normalizeWeaponV3,
} from './weapon-model.mjs';
import { applyChargeChange } from './charge-change.mjs';

function _hasPerSecondChange(charge) {
  if (!charge?.enabled) return false;
  const formula = String(charge.changePerSecond?.formula ?? '').trim();
  if (!formula || formula === '0') return false;
  return true;
}

/**
 * @param {object} charge mutated
 * @param {number} seconds signed
 * @returns {boolean} whether current changed
 */
function _applyTick(charge, seconds) {
  if (!_hasPerSecondChange(charge) || !seconds) return false;
  // applyChargeChange multiplies magnitude by max(0, seconds) — for rewind,
  // flip the change sign instead of passing negative seconds.
  const whichOpts = { which: 'perSecond', ammoCost: 1, requireEnough: false };
  const before = charge.current;
  if (seconds > 0) {
    applyChargeChange(charge, { ...whichOpts, seconds });
  } else {
    const abs = Math.abs(seconds);
    const flipped = {
      ...charge,
      changePerSecond: {
        ...charge.changePerSecond,
        sign: charge.changePerSecond?.sign === '+' ? '-' : '+',
      },
    };
    applyChargeChange(flipped, { ...whichOpts, seconds: abs });
    charge.current = flipped.current;
  }
  return charge.current !== before;
}

function _tickItemCharge(item, seconds) {
  if (!item || item.type !== 'item' || !item.system?.itemTags?.isAmmo) return null;
  const weapon = normalizeWeaponV3(item.system?.weapon, item.system?.itemTags ?? {});
  const charge = weapon.ammo?.charge;
  if (!_applyTick(charge, seconds)) return null;
  return {
    _id: item.id,
    'system.weapon.ammo.charge.current': charge.current,
  };
}

/**
 * Live batteries are Actor Items (possibly hosted under a weapon). Tick all ammo
 * charge items once; weapon JSON no longer embeds charge snapshots.
 * @param {Actor} actor
 * @param {{seconds: number}} payload
 */
export async function onPersonalTimeAdvancedChargeTick(actor, payload) {
  const seconds = Number(payload?.seconds) || 0;
  if (!actor || !seconds) return;

  const updates = [];
  for (const item of actor.items ?? []) {
    if (!item.system?.itemTags?.isAmmo) continue;
    const u = _tickItemCharge(item, seconds);
    if (u) updates.push(u);
  }
  if (!updates.length) return;
  try {
    await actor.updateEmbeddedDocuments('Item', updates);
  } catch (e) {
    console.error('SpaceHolder | charge personal-time tick failed', e);
  }
}

export function registerChargePersonalTimeHooks() {
  Hooks.on('spaceholder.personalTimeAdvanced', (actor, payload) => {
    void onPersonalTimeAdvancedChargeTick(actor, payload);
  });
}

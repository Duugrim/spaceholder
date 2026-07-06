/**
 * Attack chain — «Атака = Линия × Режим» as a composite player action.
 *
 * The chain builder inspects the current state (weapon in hands? right
 * mode? loaded? readied?) and emits ONLY the missing atomic steps:
 *   hold → exit old mode → enter line → enter mode → reload/bolt →
 *   readying → start aiming.
 *
 * Execution shows a confirmation dialog with the step breakdown and the AP
 * total (unless the actor has the «auto-confirm complex actions» flag),
 * then performs the steps one by one, spending AP through the transaction
 * ledger, and finally enters the aiming UI bound to the chosen line/mode.
 */

import {
  getWeaponLineMode,
  resolveEffectiveAttackParams,
} from './weapon-model.mjs';
import {
  getWeaponData,
  persistWeaponData,
  lineShotReadiness,
  getAmmoBlock,
  reloadBlock,
  operateBolt,
  canReloadBlock,
} from './weapon-ammo-runtime.mjs';
import { spendAp, ensureCharacterApSynced } from '../actions/transaction-ledger.mjs';

/** MVP: «Открыть рюкзак» + взять предмет в руки. */
export const TAKE_WEAPON_AP_COST = 10;

const AUTO_CONFIRM_FLAG = 'autoConfirmComplexActions';

function _t(key, data = undefined) {
  try {
    const i18n = game?.i18n;
    if (!i18n) return key;
    return data ? i18n.format(key, data) : i18n.localize(key);
  } catch (_) {
    return key;
  }
}

/* ================================================================== *
 *  Chain building                                                     *
 * ================================================================== */

/**
 * @typedef {object} AttackChainStep
 * @property {string} kind  - hold | exitMode | enterLine | enterMode |
 *                            reload | bolt | attachMagazine | ready | aim
 * @property {string} label - localized display label
 * @property {number} apCost
 * @property {string} [blockId] - for reload/bolt steps
 */

/**
 * Build the missing-step chain for an attack (line × mode).
 *
 * @param {object} args
 * @param {Actor} args.actor
 * @param {Item} args.weaponItem
 * @param {string} args.lineId
 * @param {string} args.modeId
 * @returns {{ok: boolean, reason?: string, steps: AttackChainStep[], totalAp: number, weapon: object}}
 */
export function buildAttackChain({ actor, weaponItem, lineId, modeId }) {
  const weapon = getWeaponData(weaponItem);
  const { line, mode } = getWeaponLineMode(weapon, lineId, modeId);
  if (!line || !mode) return { ok: false, reason: 'noAttack', steps: [], totalAp: 0, weapon };

  const eff = resolveEffectiveAttackParams(weapon, lineId, modeId);
  const steps = [];

  // 1. Weapon in hands.
  if (!weaponItem.system?.held) {
    steps.push({
      kind: 'hold',
      label: _t('SPACEHOLDER.WeaponV3.Chain.TakeWeapon', { name: weaponItem.name }),
      apCost: TAKE_WEAPON_AP_COST,
    });
  }

  // 2. Mode switch. We track the active mode; the previous line is NOT
  //    stored per ТЗ — its exit cost is never charged here.
  const state = weapon.state ?? {};
  const sameMode = state.activeModeId === modeId && state.activeLineId === lineId;
  if (!sameMode) {
    if (state.activeModeId) {
      const { mode: oldMode } = getWeaponLineMode(weapon, state.activeLineId, state.activeModeId);
      if (oldMode?.exitCost?.enabled) {
        steps.push({
          kind: 'exitMode',
          label: _t('SPACEHOLDER.WeaponV3.Chain.ExitMode', { name: oldMode.name || oldMode.id }),
          apCost: Math.max(0, oldMode.exitCost.value),
        });
      }
    }
    if (line.enterCost?.enabled) {
      steps.push({
        kind: 'enterLine',
        label: _t('SPACEHOLDER.WeaponV3.Chain.EnterLine', { name: line.name || _t('SPACEHOLDER.WeaponV3.Line.Default') }),
        apCost: Math.max(0, line.enterCost.value),
      });
    }
    if (mode.enterCost?.enabled) {
      steps.push({
        kind: 'enterMode',
        label: _t('SPACEHOLDER.WeaponV3.Chain.EnterMode', { name: mode.name || mode.id }),
        apCost: Math.max(0, mode.enterCost.value),
      });
    }
    if (!steps.some((s) => ['exitMode', 'enterLine', 'enterMode'].includes(s.kind))) {
      // All costs disabled — still need a zero-cost switch step so the
      // weapon state is updated during execution.
      steps.push({ kind: 'enterMode', label: _t('SPACEHOLDER.WeaponV3.Chain.SwitchMode'), apCost: 0 });
    }
  }

  // 3. Ammo readiness per block.
  const readiness = lineShotReadiness(weapon, lineId);
  for (const blockInfo of readiness.blocks) {
    if (blockInfo.ready) continue;
    const block = getAmmoBlock(weapon, lineId, blockInfo.blockId);
    if (!block) continue;
    if (blockInfo.reason === 'needReload' || blockInfo.reason === 'noAmmo') {
      if (!block.apActions?.reload?.enabled || !canReloadBlock(actor, block)) {
        return { ok: false, reason: 'reloadUnavailable', steps: [], totalAp: 0, weapon };
      }
      steps.push({
        kind: 'reload',
        label: _t('SPACEHOLDER.WeaponV3.Chain.Reload'),
        apCost: Math.max(0, block.apActions.reload.value),
        blockId: block.id,
      });
    } else if (blockInfo.reason === 'needBolt') {
      steps.push({
        kind: 'bolt',
        label: _t('SPACEHOLDER.WeaponV3.Chain.Bolt'),
        apCost: block.apActions?.bolt?.enabled ? Math.max(0, block.apActions.bolt.value) : 0,
        blockId: block.id,
      });
    }
  }

  // 4. Readying (изготовка → боеготовность).
  const readying = eff?.ergonomics?.readying ?? weapon.ergonomics.readying;
  if (readying?.enabled && !state.ready) {
    steps.push({
      kind: 'ready',
      label: _t('SPACEHOLDER.WeaponV3.Chain.Ready'),
      apCost: Math.max(0, readying.value),
    });
  }

  // 5. Enter aiming UI (free when readied / readying disabled).
  steps.push({ kind: 'aim', label: _t('SPACEHOLDER.WeaponV3.Chain.Aim'), apCost: 0 });

  const totalAp = steps.reduce((sum, s) => sum + Math.max(0, Number(s.apCost) || 0), 0);
  return { ok: true, steps, totalAp, weapon };
}

/* ================================================================== *
 *  Confirmation                                                       *
 * ================================================================== */

/**
 * Whether complex chains run without confirmation for this actor.
 * MVP: per-actor flag (per-player desired later).
 * @param {Actor} actor
 */
export function isAutoConfirmEnabled(actor) {
  try {
    return !!actor?.getFlag?.('spaceholder', AUTO_CONFIRM_FLAG);
  } catch (_) {
    return false;
  }
}

/**
 * @param {Actor} actor
 * @param {boolean} value
 */
export async function setAutoConfirmEnabled(actor, value) {
  try {
    await actor?.setFlag?.('spaceholder', AUTO_CONFIRM_FLAG, !!value);
  } catch (_) { /* ignore */ }
}

/**
 * Show the chain breakdown dialog. Resolves to true when the player
 * confirmed (or auto-confirm is enabled).
 *
 * @param {object} args
 * @param {Actor} args.actor
 * @param {AttackChainStep[]} args.steps
 * @param {number} args.totalAp
 * @param {string} args.title
 * @returns {Promise<boolean>}
 */
export async function confirmAttackChain({ actor, steps, totalAp, title = '' }) {
  if (isAutoConfirmEnabled(actor)) return true;
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return true;

  const E = foundry.utils.escapeHTML;
  const rows = steps
    .map((s) => `<tr><td>${E(s.label)}</td><td style="text-align:right; white-space:nowrap;">${Number(s.apCost) || 0} ${E(_t('SPACEHOLDER.WeaponV3.Chain.ApShort'))}</td></tr>`)
    .join('');
  const content = `
    <div class="spaceholder-attack-chain-confirm">
      <table style="width:100%; border-collapse:collapse;">
        <tbody>${rows}</tbody>
        <tfoot>
          <tr style="border-top:1px solid var(--color-border-light-primary, #888); font-weight:bold;">
            <td>${E(_t('SPACEHOLDER.WeaponV3.Chain.Total'))}</td>
            <td style="text-align:right; white-space:nowrap;">${totalAp} ${E(_t('SPACEHOLDER.WeaponV3.Chain.ApShort'))}</td>
          </tr>
        </tfoot>
      </table>
      <label style="display:flex; align-items:center; gap:8px; margin-top:10px;">
        <input type="checkbox" name="sh-chain-autoconfirm">
        <span>${E(_t('SPACEHOLDER.WeaponV3.Chain.AutoConfirm'))}</span>
      </label>
    </div>`;

  let confirmed = false;
  let rememberAuto = false;
  await DialogV2.wait({
    classes: ['spaceholder'],
    window: { title: title || _t('SPACEHOLDER.WeaponV3.Chain.Title'), icon: 'fa-solid fa-crosshairs' },
    position: { width: 400 },
    content,
    buttons: [
      {
        action: 'confirm',
        label: _t('SPACEHOLDER.WeaponV3.Chain.Execute'),
        icon: 'fa-solid fa-check',
        default: true,
        callback: (ev) => {
          confirmed = true;
          const root = ev?.currentTarget?.closest?.('.window-content') ?? document;
          rememberAuto = !!root.querySelector('[name="sh-chain-autoconfirm"]')?.checked;
        },
      },
      { action: 'cancel', label: _t('SPACEHOLDER.Actions.Cancel'), icon: 'fa-solid fa-times' },
    ],
  });
  if (confirmed && rememberAuto) await setAutoConfirmEnabled(actor, true);
  return confirmed;
}

/* ================================================================== *
 *  Execution                                                          *
 * ================================================================== */

async function _spendStepAp(actor, step) {
  const cost = Math.max(0, Math.floor(Number(step.apCost) || 0));
  if (cost <= 0 || actor.type !== 'character') return true;
  let spend = null;
  try {
    spend = await spendAp(actor, cost, {
      source: { type: 'action', actionId: `weaponChain.${step.kind}`, label: step.label },
    });
  } catch (e) {
    ui.notifications?.warn?.(String(e?.message || e));
    return false;
  }
  if (!spend?.ok) {
    ui.notifications?.warn?.(spend?.error || _t('SPACEHOLDER.ActionsSystem.Errors.ApSpendFailed'));
    return false;
  }
  return true;
}

/**
 * Execute the chain step by step. Stops with a warning when AP runs out or
 * a step fails (e.g. no ammo found during reload).
 *
 * @param {object} args
 * @param {Actor} args.actor
 * @param {Item} args.weaponItem
 * @param {Token|null} args.token
 * @param {string} args.lineId
 * @param {string} args.modeId
 * @param {AttackChainStep[]} args.steps
 * @returns {Promise<boolean>}
 */
export async function executeAttackChain({ actor, weaponItem, token, lineId, modeId, steps }) {
  await ensureCharacterApSynced(actor);

  for (const step of steps) {
    // Charge AP first; the step effect follows only when affordable.
    if (!(await _spendStepAp(actor, step))) return false;

    switch (step.kind) {
      case 'hold': {
        await weaponItem.update({ 'system.held': true, 'system.equipped': false, 'system.containerHostId': '' });
        break;
      }
      case 'exitMode': {
        const weapon = getWeaponData(weaponItem);
        weapon.state.activeModeId = '';
        weapon.state.activeLineId = '';
        await persistWeaponData(weaponItem, weapon);
        break;
      }
      case 'enterLine':
        // State change happens in enterMode; the step only carries the cost.
        break;
      case 'enterMode': {
        const weapon = getWeaponData(weaponItem);
        weapon.state.activeLineId = lineId;
        weapon.state.activeModeId = modeId;
        await persistWeaponData(weaponItem, weapon);
        break;
      }
      case 'reload': {
        const weapon = getWeaponData(weaponItem);
        const block = getAmmoBlock(weapon, lineId, step.blockId);
        const res = await reloadBlock({ actor, block });
        if (!res.ok) {
          ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.Ammo.NoCandidates'));
          return false;
        }
        await persistWeaponData(weaponItem, weapon);
        break;
      }
      case 'bolt': {
        const weapon = getWeaponData(weaponItem);
        const block = getAmmoBlock(weapon, lineId, step.blockId);
        const res = await operateBolt({ actor, block });
        if (!res.ok) {
          ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.Ammo.BoltFailed'));
          return false;
        }
        await persistWeaponData(weaponItem, weapon);
        break;
      }
      case 'ready': {
        const weapon = getWeaponData(weaponItem);
        weapon.state.ready = true;
        await persistWeaponData(weaponItem, weapon);
        break;
      }
      case 'aim': {
        const aimingManager = await _ensureAimingManager();
        if (!aimingManager) {
          ui.notifications?.warn?.(_t('SPACEHOLDER.ActionsSystem.Errors.AimingUnavailable'));
          return false;
        }
        const started = await aimingManager.startWeaponV3Aiming({
          token,
          actor,
          weaponItem,
          lineId,
          modeId,
        });
        if (!started) {
          ui.notifications?.warn?.(_t('SPACEHOLDER.ActionsSystem.Errors.AimingStartFailed'));
          return false;
        }
        break;
      }
      default:
        break;
    }
  }
  return true;
}

async function _ensureAimingManager() {
  let mgr = game.spaceholder?.aimingManager || null;
  if (mgr) return mgr;
  try {
    const mod = await import('../aiming-manager.mjs');
    const Ctor = mod?.AimingManager;
    if (typeof Ctor !== 'function') return null;
    mgr = new Ctor();
    if (game.spaceholder) game.spaceholder.aimingManager = mgr;
    return mgr;
  } catch (e) {
    console.error('SpaceHolder | Failed to initialize AimingManager', e);
    return null;
  }
}

/**
 * Full attack flow: build chain → confirm → execute.
 *
 * @param {object} args
 * @param {Actor} args.actor
 * @param {Item} args.weaponItem
 * @param {Token|null} args.token
 * @param {string} args.lineId
 * @param {string} args.modeId
 * @returns {Promise<boolean>}
 */
export async function runWeaponAttack({ actor, weaponItem, token, lineId, modeId }) {
  const chain = buildAttackChain({ actor, weaponItem, lineId, modeId });
  if (!chain.ok) {
    ui.notifications?.warn?.(_t(`SPACEHOLDER.WeaponV3.Chain.Blocked.${chain.reason ?? 'unknown'}`));
    return false;
  }
  const { line, mode } = getWeaponLineMode(chain.weapon, lineId, modeId);
  const title = `${weaponItem.name}: ${line?.name || _t('SPACEHOLDER.WeaponV3.Line.Default')} / ${mode?.name || _t('SPACEHOLDER.WeaponV3.Mode.Default')}`;
  const confirmed = await confirmAttackChain({ actor, steps: chain.steps, totalAp: chain.totalAp, title });
  if (!confirmed) return false;
  return executeAttackChain({ actor, weaponItem, token, lineId, modeId, steps: chain.steps });
}

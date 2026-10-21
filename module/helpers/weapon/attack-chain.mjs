/**
 * Attack chain — «Атака = Линия × Режим» as a composite player action.
 *
 * The chain builder inspects the current state (weapon in hands? right
 * mode? loaded? readied?) and emits ONLY the missing atomic steps:
 *   hold → exit old mode → enter line → enter mode → reload/bolt →
 *   readying → start aiming.
 *
 * The steps are performed one by one, spending AP through the transaction ledger
 * (priced with the actor's action speed) and each logged as an action of its own in the
 * combat log, and finally the aiming UI bound to the chosen line/mode is entered. No
 * confirmation is asked: the «Attack» button shows the price (the missing steps, and the
 * first shot). In combat the whole price (steps + first shot) must fit the AP pool before the
 * first step is paid. The old confirmation dialog is kept behind `CONFIRM_ATTACK_CHAIN_ENABLED` (off).
 * The shots themselves are charged and logged by the aiming session (`AimingManager`).
 */

import {
  getWeaponLineMode,
  resolveActiveWeaponAttack,
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
  syncExternalChargeHostedRuntime,
} from './weapon-ammo-runtime.mjs';
import { unparentActorItemFromHost } from '../item-weapon-host.mjs';
import {
  canAffordAp,
  ensureCharacterApSynced,
  notEnoughApMessage,
  spendAp,
} from '../actions/transaction-ledger.mjs';
import { beginCombatAction, logCombatAction } from '../actions/combat-action-log.mjs';
import { getSelectedItemIds, setSelectedItemIds } from '../hud-selection.mjs';
import { ABILITY_NORM, applyActionSpeedToCost } from '../derived-stats.mjs';

/**
 * The confirmation dialog of a costly attack chain is legacy: an attack no longer asks anything (the
 * button shows the price, the steps just run). The dialog code stays, switched off, for the places that
 * will assemble a long chain of actions out of the inventory. Turn on to bring it back.
 */
export const CONFIRM_ATTACK_CHAIN_ENABLED = false;

/** Base AP of «take in hands» (`CONFIG.SPACEHOLDER.itemActionAp.hold`), the same as the item's own action. */
function takeWeaponAp() {
  const n = Number(globalThis.CONFIG?.SPACEHOLDER?.itemActionAp?.hold);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10;
}

function _actorCor(actor) {
  const cor = Number(actor?.system?.abilities?.cor?.value);
  return Number.isFinite(cor) ? cor : ABILITY_NORM;
}

/**
 * Chain steps priced for this actor: action speed (COR) applies to the steps like it does to every
 * other action, so the cost the button shows is the cost that is charged. `baseApCost` keeps the
 * price before the actor's speed (the combat log shows both).
 * @param {Actor|null|undefined} actor
 * @param {AttackChainStep[]} steps
 * @returns {AttackChainStep[]}
 */
function _priceSteps(actor, steps) {
  const cor = _actorCor(actor);
  return steps.map((s) => {
    const base = Math.max(0, Number(s.apCost) || 0);
    return { ...s, baseApCost: base, apCost: applyActionSpeedToCost(base, cor) };
  });
}

/**
 * AP of a weapon timing (aiming + trigger of the first shot, the delay of a following shot of a series)
 * priced for this actor: action speed (COR) applies to shots like it does to every other action.
 * The same function prices the button and the charge. The real rate of fire (auto-fire timer, RPM)
 * is not touched: it stays on the global `AP_PER_SECOND`.
 *
 * @param {Actor|null|undefined} actor
 * @param {number} baseAp timing in AP, as the weapon defines it
 * @returns {number} whole AP
 */
export function shotApCost(actor, baseAp) {
  return applyActionSpeedToCost(Math.ceil(Math.max(0, Number(baseAp) || 0)), _actorCor(actor));
}

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
 * Steps that move the weapon from its stored line/mode to `line × mode`.
 * We track the active mode; the previous line is NOT stored per ТЗ — its
 * exit cost is never charged here. The last step is always `enterMode`,
 * which is the one that persists the new state.
 *
 * @param {object} weapon normalized v3 weapon
 * @param {object} line target line
 * @param {object} mode target mode
 * @returns {AttackChainStep[]}
 */
function _buildModeSwitchSteps(weapon, line, mode) {
  const steps = [];
  const state = weapon.state ?? {};
  const sameMode = state.activeModeId === mode.id && state.activeLineId === line.id;
  if (sameMode) return steps;

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
  } else {
    // No enter cost — still need a zero-cost step so the new state is persisted
    // (exitMode clears it, enterLine only carries the cost).
    steps.push({ kind: 'enterMode', label: _t('SPACEHOLDER.WeaponV3.Chain.SwitchMode'), apCost: 0 });
  }
  return steps;
}

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
      apCost: takeWeaponAp(),
    });
  }

  // 2. Mode switch.
  const state = weapon.state ?? {};
  steps.push(..._buildModeSwitchSteps(weapon, line, mode));

  // 3. Ammo readiness per block (actor required to resolve live contentItemIds / charge).
  for (const line of weapon.lines ?? []) {
    if (line.id !== lineId) continue;
    for (const block of line.ammoBlocks ?? []) {
      syncExternalChargeHostedRuntime(actor, weaponItem, block);
    }
  }
  const readiness = lineShotReadiness(weapon, lineId, actor);
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

  const priced = _priceSteps(actor, steps);
  const totalAp = priced.reduce((sum, s) => sum + Math.max(0, Number(s.apCost) || 0), 0);
  return { ok: true, steps: priced, totalAp, weapon };
}

/**
 * AP of the first shot of an attack: aiming + trigger of the line. Charged when the shot is fired
 * (`AimingManager`), not by the chain; follow-up shots of a burst / auto series cost the mode delay.
 *
 * @param {object} weapon normalized v3 weapon
 * @param {string} lineId
 * @param {string} modeId
 * @param {Actor|null} [actor] whose action speed prices the shot
 * @returns {number} whole AP
 */
export function firstShotAp(weapon, lineId, modeId, actor = null) {
  const eff = resolveEffectiveAttackParams(weapon, lineId, modeId);
  if (!eff) return 0;
  return shotApCost(actor, Math.max(0, Number(eff.line.aiming) || 0) + Math.max(0, Number(eff.line.trigger) || 0));
}

/**
 * The rows the confirmation dialog shows: the steps that mean something to the player. The terminal
 * «aim» step and a free «switch mode» step are bookkeeping and stay out; the first shot is added so the
 * dialog total matches the cost preview.
 *
 * @param {AttackChainStep[]} steps
 * @param {number} shotAp
 * @returns {AttackChainStep[]}
 */
export function describeChainForConfirm(steps, shotAp) {
  const rows = steps.filter((s) => s.kind !== 'aim' && !(s.kind === 'enterMode' && !(Number(s.apCost) > 0)));
  if (shotAp > 0) rows.push({ kind: 'shot', label: _t('SPACEHOLDER.WeaponV3.Chain.FirstShot'), apCost: shotAp });
  return rows;
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

/** Steps that are real actions worth a line in the combat log even when free (the rest is bookkeeping). */
const LOGGED_FREE_STEPS = new Set(['hold', 'reload', 'bolt', 'ready']);

/**
 * @param {AttackChainStep} step
 * @returns {boolean}
 */
function _isLoggedStep(step) {
  return step.kind !== 'aim' && (Number(step.apCost) > 0 || LOGGED_FREE_STEPS.has(step.kind));
}

/**
 * Pay for a step. In combat the whole chain was checked up front, so a refusal here only means the
 * pool changed meanwhile.
 * @returns {Promise<{ok: boolean, transactionId: string|null}>}
 */
async function _spendStepAp(actor, step, combatant) {
  const cost = Math.max(0, Math.floor(Number(step.apCost) || 0));
  if (cost <= 0 || actor.type !== 'character') return { ok: true, transactionId: null };
  let spend = null;
  try {
    spend = await spendAp(actor, cost, {
      combatantId: combatant?.id ?? null,
      source: { type: 'action', actionId: `weaponChain.${step.kind}`, label: step.label },
    });
  } catch (e) {
    ui.notifications?.warn?.(String(e?.message || e));
    return { ok: false, transactionId: null };
  }
  if (!spend?.ok) {
    ui.notifications?.warn?.(spend?.error || _t('SPACEHOLDER.ActionsSystem.Errors.ApSpendFailed'));
    return { ok: false, transactionId: null };
  }
  return { ok: true, transactionId: spend.transactionId ?? null };
}

/**
 * Execute the chain step by step. In combat the whole price (steps + `reserveAp`) must fit the AP pool,
 * or nothing is paid and nothing happens. Stops with a warning when a step fails (e.g. no ammo found
 * during reload). Every paid step is an action of its own in the combat log, so the log shows what was
 * prepared BEFORE the attack (the shots are logged as the attack itself).
 *
 * @param {object} args
 * @param {Actor} args.actor
 * @param {Item} args.weaponItem
 * @param {Token|null} args.token
 * @param {string} args.lineId
 * @param {string} args.modeId
 * @param {AttackChainStep[]} args.steps
 * @param {number} [args.reserveAp] AP the caller still needs after the steps (the first shot), checked together with them
 * @returns {Promise<boolean>}
 */
export async function executeAttackChain({ actor, weaponItem, token, lineId, modeId, steps, reserveAp = 0 }) {
  await ensureCharacterApSynced(actor);

  // The first action of a round starts the actor's official turn (and refills the pool): that comes
  // before the check, which must see the pool the steps will really be paid from.
  const { combatant } = await beginCombatAction(actor, token?.document ?? null);

  const stepsAp = steps.reduce((sum, s) => sum + Math.max(0, Number(s.apCost) || 0), 0);
  const afford = canAffordAp(actor, stepsAp + Math.max(0, Number(reserveAp) || 0));
  if (!afford.ok) {
    ui.notifications?.warn?.(notEnoughApMessage(afford));
    return false;
  }

  for (const step of steps) {
    // Charge AP first; the step effect follows only when affordable.
    const paid = await _spendStepAp(actor, step, combatant);
    if (!paid.ok) return false;
    if (combatant && _isLoggedStep(step)) {
      await logCombatAction({
        actor,
        tokenDoc: token?.document ?? null,
        actionId: `weaponChain.${step.kind}`,
        label: step.label,
        baseCost: step.baseApCost ?? step.apCost,
        cost: step.apCost,
        transactionId: paid.transactionId,
        combatantHint: combatant,
      });
    }

    switch (step.kind) {
      case 'hold': {
        // Out of a container / weapon host: leave the host's contents consistent (not just clear the id).
        const hosted = String(weaponItem.system?.containerHostId ?? '').trim();
        const unparented = hosted ? await unparentActorItemFromHost(actor, weaponItem.id, { held: true }) : false;
        if (!unparented) await weaponItem.update({ 'system.held': true, 'system.equipped': false });
        break;
      }
      case 'exitMode': {
        const weapon = getWeaponData(weaponItem);
        weapon.state.activeModeId = '';
        weapon.state.activeLineId = '';
        await persistWeaponData(weaponItem, weapon);
        if (step.apCost > 0 && !combatant) await _announceModeStep(actor, weaponItem, step);
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
        if (step.apCost > 0 && !combatant) await _announceModeStep(actor, weaponItem, step);
        break;
      }
      case 'reload': {
        const weapon = getWeaponData(weaponItem);
        const block = getAmmoBlock(weapon, lineId, step.blockId);
        const res = await reloadBlock({ actor, weaponItem, block });
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
        const res = await operateBolt({ actor, weaponItem, block });
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
 * Chat ping when switching fire modes with a real AP enter/exit cost out of combat (in combat the
 * combat log carries the step).
 * @param {Actor|null} actor
 * @param {Item} weaponItem
 * @param {AttackChainStep} step
 */
async function _announceModeStep(actor, weaponItem, step) {
  const label = String(step?.label || '').trim();
  if (!label) return;
  const weaponName = String(weaponItem?.name || '');
  const content = weaponName ? `${weaponName}: ${label}` : label;
  try {
    ui.notifications?.info?.(content);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: actor ?? null }),
      content: `<div>${foundry.utils.escapeHTML(content)}</div>`,
    });
  } catch (_) {
    /* ignore */
  }
}

/**
 * Loadout swaps in progress: the weapon an attack borrowed, by actor id. An entry lives until the
 * aiming it belongs to ends and the previous selection is back.
 * @type {Map<string, {hookName: string, hookId: number, prevSelected: string[], wasHeld: boolean, weaponItem: Item, restoring: Promise<void>|null}>}
 */
const _borrowedWeapons = new Map();

/**
 * While aiming, the weapon in use must be the selected one: the HUD's Attack / Cancel button and the
 * card readouts follow the selection. An attack started from elsewhere (a hotbar macro, the sheet) with
 * another item selected therefore swaps: the weapon becomes the selection (the chain has already put
 * it in hands), and when aiming ends `_returnBorrowedWeapon` brings the previous selection back and puts
 * the weapon away again if it was not in hands before.
 *
 * @param {object} args
 * @param {Actor} args.actor
 * @param {Item} args.weaponItem
 * @param {string[]} args.prevSelected selection before the attack
 * @param {boolean} args.wasHeld whether the weapon was in hands before the attack
 */
async function _borrowWeaponForAttack({ actor, weaponItem, prevSelected, wasHeld }) {
  if (prevSelected.includes(weaponItem.id)) return;
  const { AIMING_CHANGED_HOOK } = await import('../aiming-manager.mjs');
  const entry = { hookName: AIMING_CHANGED_HOOK, hookId: 0, prevSelected, wasHeld, weaponItem, restoring: null };
  _borrowedWeapons.set(actor.id, entry);
  entry.hookId = Hooks.on(AIMING_CHANGED_HOOK, ({ aiming, token } = {}) => {
    if (!aiming && token?.actor?.id === actor.id) void _returnBorrowedWeapon(actor);
  });
  await setSelectedItemIds(actor, [weaponItem.id]);
}

/**
 * Undo `_borrowWeaponForAttack` (idempotent; resolves when the previous state is back).
 * @param {Actor} actor
 * @returns {Promise<void>}
 */
function _returnBorrowedWeapon(actor) {
  const entry = _borrowedWeapons.get(actor.id);
  if (!entry) return Promise.resolve();
  entry.restoring ??= (async () => {
    Hooks.off(entry.hookName, entry.hookId);
    try {
      await setSelectedItemIds(actor, entry.prevSelected.filter((id) => actor.items?.has?.(id)));
      if (!entry.wasHeld && entry.weaponItem.system?.held) await entry.weaponItem.update({ 'system.held': false });
    } finally {
      _borrowedWeapons.delete(actor.id);
    }
  })();
  return entry.restoring;
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
  // Persist EXTERNAL_CHARGE host reconciliation before building the chain so
  // readiness / detach menus share the same contentItemIds as live items.
  {
    const weapon = getWeaponData(weaponItem);
    let synced = false;
    for (const line of weapon.lines ?? []) {
      for (const block of line.ammoBlocks ?? []) {
        const sync = syncExternalChargeHostedRuntime(actor, weaponItem, block);
        if (sync.changed) synced = true;
        for (const extraId of sync.extraIds) {
          await unparentActorItemFromHost(actor, extraId, { held: true });
          synced = true;
        }
      }
    }
    if (synced) await persistWeaponData(weaponItem, weapon);
  }

  // A previous attack's borrowed weapon goes back first, so this attack records the real loadout.
  await _returnBorrowedWeapon(actor);
  const prevSelected = getSelectedItemIds(actor).filter((id) => actor.items?.has?.(id));
  const wasHeld = !!weaponItem.system?.held;

  const chain = buildAttackChain({ actor, weaponItem, lineId, modeId });
  if (!chain.ok) {
    ui.notifications?.warn?.(_t(`SPACEHOLDER.WeaponV3.Chain.Blocked.${chain.reason ?? 'unknown'}`));
    return false;
  }
  const { line, mode } = getWeaponLineMode(chain.weapon, lineId, modeId);
  // The confirmation dialog is legacy and off (`CONFIRM_ATTACK_CHAIN_ENABLED`): the steps just run.
  if (CONFIRM_ATTACK_CHAIN_ENABLED && chain.totalAp > 0) {
    const title = `${weaponItem.name}: ${line?.name || _t('SPACEHOLDER.WeaponV3.Line.Default')} / ${mode?.name || _t('SPACEHOLDER.WeaponV3.Mode.Default')}`;
    const shotAp = firstShotAp(chain.weapon, lineId, modeId, actor);
    const confirmed = await confirmAttackChain({
      actor,
      steps: describeChainForConfirm(chain.steps, shotAp),
      totalAp: chain.totalAp + shotAp,
      title,
    });
    if (!confirmed) return false;
  }
  const started = await executeAttackChain({
    actor,
    weaponItem,
    token,
    lineId,
    modeId,
    steps: chain.steps,
    reserveAp: firstShotAp(chain.weapon, lineId, modeId, actor),
  });
  if (started) await _borrowWeaponForAttack({ actor, weaponItem, prevSelected, wasHeld });
  return started;
}

/* ================================================================== *
 *  Item-level attack API                                              *
 * ================================================================== */

/**
 * Whether the item can be used to attack. Today only v3 weapons with at
 * least one line; later any item (improvised blunt attack).
 * @param {Item} item
 * @returns {boolean}
 */
export function canAttackWithItem(item) {
  if (item?.type !== 'item' || !item.system?.itemTags?.isWeapon) return false;
  const weapon = getWeaponData(item);
  return Array.isArray(weapon.lines) && weapon.lines.length > 0;
}

/**
 * AP cost of switching the weapon to `line × mode` (0 when already active).
 * @param {Item} weaponItem
 * @param {string} lineId
 * @param {string} modeId
 * @returns {number}
 */
export function previewModeSwitchAp(weaponItem, lineId, modeId) {
  const weapon = getWeaponData(weaponItem);
  const { line, mode } = getWeaponLineMode(weapon, lineId, modeId);
  if (!line || !mode) return 0;
  const actor = weaponItem?.actor ?? weaponItem?.parent ?? null;
  return _priceSteps(actor, _buildModeSwitchSteps(weapon, line, mode))
    .reduce((sum, s) => sum + Math.max(0, Number(s.apCost) || 0), 0);
}

/**
 * Explicitly switch the weapon's active line/mode (no aiming). Charges the
 * same exit/enter costs as the attack chain and asks for confirmation when
 * the switch is not free.
 *
 * @param {object} args
 * @param {Actor} args.actor
 * @param {Item} args.weaponItem
 * @param {string} args.lineId
 * @param {string} args.modeId
 * @returns {Promise<boolean>}
 */
export async function switchWeaponMode({ actor, weaponItem, lineId, modeId }) {
  const weapon = getWeaponData(weaponItem);
  const { line, mode } = getWeaponLineMode(weapon, lineId, modeId);
  if (!line || !mode) return false;

  const steps = _priceSteps(actor, _buildModeSwitchSteps(weapon, line, mode));
  if (!steps.length) return true;

  const totalAp = steps.reduce((sum, s) => sum + Math.max(0, Number(s.apCost) || 0), 0);
  if (CONFIRM_ATTACK_CHAIN_ENABLED && totalAp > 0) {
    const title = `${weaponItem.name}: ${line.name || _t('SPACEHOLDER.WeaponV3.Line.Default')} / ${mode.name || _t('SPACEHOLDER.WeaponV3.Mode.Default')}`;
    const confirmed = await confirmAttackChain({ actor, steps: describeChainForConfirm(steps, 0), totalAp, title });
    if (!confirmed) return false;
  }
  return executeAttackChain({ actor, weaponItem, token: null, lineId, modeId, steps });
}

/**
 * Cost preview for attacking with the item's active line/mode, split the way the Attack button shows it:
 * `prepAp` — the missing chain steps (take in hands, reload, readying…), `shotAp` — the first shot
 * (aiming + trigger), `nextShotAp` — each following shot of a burst / auto series (0 for a single shot).
 * In combat `affordable` says whether `totalAp` fits the pool (`apLeft`); out of combat it is always true.
 *
 * @param {object} args
 * @param {Actor} args.actor
 * @param {Item} args.item
 * @returns {{ok: boolean, reason?: string, prepAp: number, shotAp: number, nextShotAp: number, totalAp: number, lineName: string, modeName: string, affordable?: boolean, apLeft?: number|null}}
 */
export function previewItemAttack({ actor, item }) {
  if (!canAttackWithItem(item)) return { ok: false, reason: 'noAttack', prepAp: 0, shotAp: 0, nextShotAp: 0, totalAp: 0, lineName: '', modeName: '' };
  const weapon = getWeaponData(item);
  const attack = resolveActiveWeaponAttack(weapon);
  const lineName = String(attack.line?.name || _t('SPACEHOLDER.WeaponV3.Line.Default'));
  const modeName = String(attack.mode?.name || _t('SPACEHOLDER.WeaponV3.Mode.Default'));

  const chain = buildAttackChain({ actor, weaponItem: item, lineId: attack.lineId, modeId: attack.modeId });
  if (!chain.ok) return { ok: false, reason: chain.reason, prepAp: 0, shotAp: 0, nextShotAp: 0, totalAp: 0, lineName, modeName };

  const shotAp = firstShotAp(weapon, attack.lineId, attack.modeId, actor);
  const eff = resolveEffectiveAttackParams(weapon, attack.lineId, attack.modeId);
  const series = eff?.mode?.fireMode && eff.mode.fireMode !== 'single';
  const nextShotAp = series ? shotApCost(actor, eff.mode.fireDelayAp) : 0;
  const totalAp = chain.totalAp + shotAp;
  const afford = canAffordAp(actor, totalAp);
  return {
    ok: true,
    prepAp: chain.totalAp,
    shotAp,
    nextShotAp,
    totalAp,
    lineName,
    modeName,
    affordable: afford.ok,
    apLeft: afford.inCombat ? afford.have : null,
  };
}

/**
 * Attack with the item's active line/mode (switching nothing explicitly —
 * the chain enters the default mode when state is empty). A valid
 * `lineId` + `modeId` pair overrides the active attack (pinned shortcuts);
 * the chain then adds the mode switch steps.
 *
 * @param {object} args
 * @param {Actor} args.actor
 * @param {Item} args.item
 * @param {Token|null} args.token
 * @param {string} [args.lineId]
 * @param {string} [args.modeId]
 * @returns {Promise<boolean>}
 */
export async function attackWithItem({ actor, item, token, lineId = '', modeId = '' }) {
  if (!canAttackWithItem(item)) return false;
  if (!token) {
    ui.notifications?.warn?.(_t('SPACEHOLDER.ActionsSystem.Errors.NoTokenForAiming'));
    return false;
  }
  const weapon = getWeaponData(item);
  const pinned = getWeaponLineMode(weapon, lineId, modeId);
  const attack = pinned.line && pinned.mode
    ? { lineId, modeId }
    : resolveActiveWeaponAttack(weapon);
  if (!attack.lineId || !attack.modeId) return false;
  return runWeaponAttack({ actor, weaponItem: item, token, lineId: attack.lineId, modeId: attack.modeId });
}

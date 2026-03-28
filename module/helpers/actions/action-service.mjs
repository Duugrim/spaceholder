/**
 * Action Service (MVP)
 * Унифицированный слой, который собирает и исполняет действия от Actor/Item.
 *
 * Важно: это runtime-сервис. Он не вводит панель быстрых действий, только контракт.
 */
 
/**
 * @typedef {object} ActionContext
 * @property {User} user
 * @property {boolean} isGM
 * @property {boolean} inCombat
 * @property {Actor|null} actor
 * @property {TokenDocument|null} tokenDoc
 * @property {boolean} editable
 */
 
/**
 * @typedef {object} ActionDescriptor
 * @property {string} id - Stable id, e.g. "item.<uuid>.equip"
 * @property {string} source - "actor" | "item" | "system"
 * @property {string} label - Localized label
 * @property {string} [icon] - FontAwesome class, e.g. "fa-solid fa-person-walking"
 * @property {number} [apCost] - Action Points cost, evaluated at runtime if needed
 * @property {boolean} [showInCombat]
 * @property {boolean} [showInQuickbar]
 * @property {(ctx: ActionContext)=>boolean} [visible]
 * @property {(ctx: ActionContext)=>boolean} [enabled]
 * @property {(ctx: ActionContext)=>string|null} [disabledReason]
 * @property {(ctx: ActionContext)=>Promise<void>|void} run
 */
 
/**
 * Safe i18n helper (works even during init edge-cases).
 * @param {string} key
 * @param {object} [data]
 */
function _t(key, data = undefined) {
  try {
    const i18n = game?.i18n;
    if (!i18n) return key;
    return data ? i18n.format(key, data) : i18n.localize(key);
  } catch (_) {
    return key;
  }
}
 
function _num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
 
import { ensureCharacterApSynced, getStoredActionPoints, spendAp } from './transaction-ledger.mjs';
import { appendCombatActionJournalLine } from './action-chat-journal.mjs';

function _activeCombat() {
  return game?.combat?.started ? game.combat : null;
}

function _getCombatantForActor(actor, tokenDoc = null, combat = _activeCombat()) {
  if (!actor || !combat) return null;
  const list = combat.combatants?.contents || [];
  if (tokenDoc?.id) {
    const byToken = list.find((c) => String(c.tokenId ?? c.token?.id ?? '') === String(tokenDoc.id));
    if (byToken) return byToken;
  }
  return list.find((c) => String(c.actorId ?? c.actor?.id ?? '') === String(actor.id)) || null;
}

function _coordinationValue(actor) {
  return _num(actor?.system?.abilities?.cor?.value, 10);
}

/**
 * Raw AP for movement from scene distance: AP per 1 grid-agnostic distance unit × distance, rounded up.
 * `actor.system.speed` = AP spent per 1 unit of distance (not per cell).
 * If speed is not set (<= 0), falls back to the cost/distance reported by core (e.g. grid steps), then ceil.
 *
 * @param {Actor|null|undefined} actor
 * @param {number} distance - passed segment length from TokenMovementData
 * @param {number} [coreReportedCost] - Foundry-reported cost for the segment (fallback)
 * @returns {number}
 */
export function getMovementDistanceApBase(actor, distance, coreReportedCost = 0) {
  const dist = Math.max(0, _num(distance, 0));
  const speed = _num(actor?.system?.speed, 0);
  if (speed > 0) {
    if (dist <= 0) return 0;
    return Math.ceil(dist * speed);
  }
  const core = Math.max(0, _num(coreReportedCost, 0));
  if (core > 0) return Math.ceil(core);
  if (dist > 0) return Math.ceil(dist);
  return 0;
}

/**
 * Coordination modifies non-negative base costs only.
 * Base negative costs remain negative by design.
 * @param {Actor} actor
 * @param {number} baseCost
 */
export function getEffectiveActionCost(actor, baseCost) {
  const base = _num(baseCost, 0);
  if (base < 0) return base;
  const cor = _coordinationValue(actor);
  const reduction = cor - 10;
  return Math.max(0, Math.floor(base - reduction));
}

/**
 * @param {Actor} actor
 * @returns {{value:number,max:number,base:number,spent:number}}
 */
export function getActorActionPoints(actor) {
  return getStoredActionPoints(actor);
}
 
/**
 * Normalize user-defined actions array.
 * @param {any} raw
 */
function _normalizeCustomActions(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((a) => {
      if (!a || typeof a !== 'object') return null;
      const id = String(a.id ?? '').trim() || null;
      const name = String(a.name ?? '').trim() || null;
      if (!id || !name) return null;
      return {
        id,
        name,
        apCost: _num(a.apCost, 0),
        mode: String(a.mode ?? 'chat').trim() || 'chat', // 'chat' | 'itemRoll' | 'macro'
        macro: String(a.macro ?? '').trim() || '',
        showInCombat: a.showInCombat !== undefined ? !!a.showInCombat : true,
        showInQuickbar: a.showInQuickbar !== undefined ? !!a.showInQuickbar : true,
      };
    })
    .filter(Boolean);
}
 
/**
 * Collect standard wearable actions: equip/unequip.
 * @param {Actor} actor
 * @param {ActionContext} ctx
 */
function _collectWearableToggleActions(actor, ctx) {
  const actions = [];
  const items = actor?.items ? Array.from(actor.items) : [];
  for (const item of items) {
    if (!item || item.type !== 'item') continue;
    if (!item.system?.itemTags?.isArmor) continue;
    const equipped = !!item.system?.equipped;
    const defaults = item.system?.defaultActions ?? {};
    const equipDefaults = defaults?.equip ?? {};
    const unequipDefaults = defaults?.unequip ?? {};
 
    if (!equipped) {
      actions.push({
        id: `item.${item.uuid}.equip`,
        source: 'item',
        label: _t('SPACEHOLDER.ActionsSystem.Wearable.Equip', { item: item.name }),
        icon: 'fa-solid fa-shield-halved',
        apCost: 0,
        showInCombat: equipDefaults.showInCombat ?? false,
        showInQuickbar: equipDefaults.showInQuickbar ?? true,
        visible: () => true,
        enabled: () => !!ctx.editable,
        disabledReason: () => (ctx.editable ? null : _t('SPACEHOLDER.ActionsSystem.Common.NotEditable')),
        run: async () => {
          await item.update({ 'system.equipped': true });
        }
      });
    } else {
      actions.push({
        id: `item.${item.uuid}.unequip`,
        source: 'item',
        label: _t('SPACEHOLDER.ActionsSystem.Wearable.Unequip', { item: item.name }),
        icon: 'fa-solid fa-shield',
        apCost: 0,
        showInCombat: unequipDefaults.showInCombat ?? false,
        showInQuickbar: unequipDefaults.showInQuickbar ?? true,
        visible: () => true,
        enabled: () => !!ctx.editable,
        disabledReason: () => (ctx.editable ? null : _t('SPACEHOLDER.ActionsSystem.Common.NotEditable')),
        run: async () => {
          await item.update({ 'system.equipped': false });
        }
      });
    }
  }
  return actions;
}
 
/**
 * Collect custom actions from actor + items.
 * @param {Actor} actor
 * @param {ActionContext} ctx
 */
function _collectCustomActions(actor, ctx) {
  const out = [];
  const actorActions = _normalizeCustomActions(actor?.system?.actions);
  for (const a of actorActions) {
    out.push({
      id: `actor.custom.${a.id}`,
      source: 'actor',
      label: a.name,
      icon: 'fa-solid fa-bolt',
      apCost: a.apCost ?? 0,
      showInCombat: a.showInCombat,
      showInQuickbar: a.showInQuickbar,
      visible: () => true,
      enabled: () => true,
      run: async () => {
        if (a.mode === 'macro' && a.macro) {
          // MVP: unsafe by nature, but intentional for power users
          // eslint-disable-next-line no-new-func
          const fn = new Function(a.macro);
          await fn.call(globalThis);
          return;
        }
        // default: chat message
        ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<div><strong>${foundry.utils.escapeHTML(a.name)}</strong></div>`,
        });
      },
    });
  }
 
  const items = actor?.items ? Array.from(actor.items) : [];
  for (const item of items) {
    if (item?.type === 'item' && !item.system?.itemTags?.isActions) continue;
    const itemActions = _normalizeCustomActions(item?.system?.actions);
    for (const a of itemActions) {
      out.push({
        id: `item.${item.uuid}.custom.${a.id}`,
        source: 'item',
        label: `${item.name}: ${a.name}`,
        icon: 'fa-solid fa-bolt',
        apCost: a.apCost ?? 0,
        showInCombat: a.showInCombat,
        showInQuickbar: a.showInQuickbar,
        visible: () => true,
        enabled: () => true,
        run: async () => {
          if (a.mode === 'itemRoll') {
            return item.roll?.();
          }
          if (a.mode === 'macro' && a.macro) {
            // eslint-disable-next-line no-new-func
            const fn = new Function(a.macro);
            await fn.call(globalThis);
            return;
          }
          ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div><strong>${foundry.utils.escapeHTML(item.name)}</strong>: ${foundry.utils.escapeHTML(a.name)}</div>`,
          });
        },
      });
    }
  }
 
  return out;
}
 
/**
 * Apply context filters.
 * @param {ActionDescriptor[]} list
 * @param {ActionContext} ctx
 */
export function filterActions(list, ctx) {
  const inCombat = !!ctx.inCombat;
  return (Array.isArray(list) ? list : []).filter((a) => {
    if (!a) return false;
    if (typeof a.visible === 'function' && !a.visible(ctx)) return false;
    // MVP filters: showInCombat if explicitly false in combat context.
    if (inCombat && a.showInCombat === false) return false;
    return true;
  });
}
 
/**
 * Collect all available actions for actor (MVP).
 * @param {Actor} actor
 * @param {Partial<ActionContext>} partialCtx
 */
export function collectActorActions(actor, partialCtx = {}) {
  const ctx = {
    user: game.user,
    isGM: !!game.user?.isGM,
    inCombat: !!_activeCombat(),
    actor,
    tokenDoc: partialCtx.tokenDoc ?? null,
    editable: partialCtx.editable !== undefined ? !!partialCtx.editable : !!actor?.isOwner,
  };
 
  let list = [];
  list = list.concat(_collectWearableToggleActions(actor, ctx));
  list = list.concat(_collectCustomActions(actor, ctx));
 
  // ensure stable deterministic ordering (grouping later by UI)
  list.sort((a, b) => String(a.label || '').localeCompare(String(b.label || ''), game.i18n?.lang || 'en'));
 
  return {
    context: ctx,
    actions: filterActions(list, ctx),
  };
}
 
/**
 * Execute action by descriptor and spend AP if needed.
 * Movement AP is handled when the token finishes a move (movement-manager); this applies direct apCost for the action.
 * @param {Actor} actor
 * @param {ActionDescriptor} action
 * @param {Partial<ActionContext>} partialCtx
 */
export async function executeActorAction(actor, action, partialCtx = {}) {
  const { context } = collectActorActions(actor, partialCtx);
  const ctx = { ...context, ...partialCtx, actor };
 
  const enabled = typeof action.enabled === 'function' ? action.enabled(ctx) : true;
  if (!enabled) {
    const reason = typeof action.disabledReason === 'function' ? action.disabledReason(ctx) : null;
    if (reason) ui.notifications?.warn?.(reason);
    return false;
  }
 
  const baseCost = Math.floor(_num(action.apCost, 0));
  const cost = getEffectiveActionCost(actor, baseCost);
  await ensureCharacterApSynced(actor);

  let transactionId = null;
  if (cost > 0 && actor.type === "character") {
    const combatPre = _activeCombat();
    const combatantPre = _getCombatantForActor(actor, ctx.tokenDoc ?? null, combatPre);
    let spend = null;
    try {
      spend = await spendAp(actor, cost, {
        combatantId: combatantPre?.id ?? null,
        source: { type: "action", actionId: action.id, label: action.label },
      });
    } catch (e) {
      ui.notifications?.warn?.(String(e?.message || e) || _t("SPACEHOLDER.ActionsSystem.Errors.ApSpendFailed"));
      return false;
    }
    if (!spend?.ok) {
      ui.notifications?.warn?.(spend?.error || _t("SPACEHOLDER.ActionsSystem.Errors.ApSpendFailed"));
      return false;
    }
    transactionId = spend.transactionId ?? null;
  }

  await action.run(ctx);

  const combat = _activeCombat();
  const combatant = _getCombatantForActor(actor, ctx.tokenDoc ?? null, combat);
  let combatEventId = null;
  if (combat && combatant && game.spaceholder?.combatSessionManager?.logAction) {
    const logResult = await game.spaceholder.combatSessionManager.logAction({
      combat,
      actor,
      combatant,
      type: 'action',
      baseApCost: baseCost,
      apCost: cost,
      data: {
        actionId: action.id,
        label: action.label,
        tokenUuid: ctx.tokenDoc?.uuid ?? null,
        transactionId,
      },
      effects: [],
      inverse: [],
    });
    combatEventId = logResult?.eventId ?? null;
  }

  if (combat && combatant) {
    await appendCombatActionJournalLine({
      actor,
      combat,
      combatant,
      label: action.label,
      apCost: cost,
      kind: 'action',
      transactionId,
      combatEventId,
      tokenUuid: ctx.tokenDoc?.uuid ?? null,
    });
  }

  return true;
}
 

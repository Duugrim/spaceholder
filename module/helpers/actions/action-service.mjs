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
 * @property {string} id - Stable id, e.g. "actor.move" or "item.<uuid>.equip"
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
 
import { getActorActionLog, addActionEntry } from './action-log.mjs';
/**
 * @param {Actor} actor
 * @returns {{value:number,max:number,base:number,spent:number}}
 */
export function getActorActionPoints(actor) {
  const ap = actor?.system?.actionPoints ?? null;
  const base = _num(ap?.value, 0);
  const max = _num(ap?.max, base);

  const log = getActorActionLog(actor);
  let spent = 0;
  for (const e of log) {
    if (!e || e.ignored) continue;
    const cost = _num(e.apCost, 0);
    if (cost <= 0) continue;
    if (e.replacedBy) continue;
    spent += cost;
  }

  const current = Math.max(0, base - spent);
  return { value: current, max, base, spent };
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
    if (!item || item.type !== 'wearable') continue;
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
 * Collect base actor actions (MVP: movement entry point only).
 * The actual movement mode is handled by movement-manager; here we just provide action descriptor.
 * @param {Actor} actor
 * @param {ActionContext} ctx
 */
function _collectBaseActorActions(actor, ctx) {
  const out = [];
  const speed = _num(actor?.system?.speed, 0);
  if (actor?.type === 'character' && speed > 0) {
    out.push({
      id: 'actor.move',
      source: 'system',
      label: _t('SPACEHOLDER.ActionsSystem.Movement.Move'),
      icon: 'fa-solid fa-person-walking',
      apCost: 0, // spent on confirm
      showInCombat: true,
      showInQuickbar: true,
      visible: () => true,
      enabled: (c) => !!c.tokenDoc,
      disabledReason: (c) => (c.tokenDoc ? null : _t('SPACEHOLDER.ActionsSystem.Movement.NoTokenContext')),
      run: async (c) => {
        const mm = game.spaceholder?.movementManager;
        if (!mm) {
          ui.notifications?.error?.(_t('SPACEHOLDER.ActionsSystem.Errors.MovementNotAvailable'));
          return;
        }
        await mm.start({ actor: c.actor, tokenDoc: c.tokenDoc });
      }
    });
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
    inCombat: !!game.combat,
    actor,
    tokenDoc: partialCtx.tokenDoc ?? null,
    editable: partialCtx.editable !== undefined ? !!partialCtx.editable : !!actor?.isOwner,
  };
 
  let list = [];
  list = list.concat(_collectBaseActorActions(actor, ctx));
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
 * Note: movement spends on confirm; this function only applies direct apCost.
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
 
  const cost = Math.max(0, Math.floor(_num(action.apCost, 0)));
  await action.run(ctx);
  if (cost > 0) {
    await addActionEntry(actor, {
      type: 'other',
      apCost: cost,
      movementId: null,
      tokenUuid: ctx.tokenDoc?.uuid ?? null,
    });
  }
 
  return true;
}
 

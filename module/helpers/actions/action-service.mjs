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
 * @property {string} [sourceItemName] - Owning item name when source === "item" (preview/UI)
 * @property {string} label - Localized label
 * @property {string} [icon] - FontAwesome class, e.g. "fa-solid fa-person-walking"
 * @property {number} [apCost] - Action Points cost, evaluated at runtime if needed
 * @property {string} [description] - Optional detail text for compact chat log
 * @property {boolean} [showInCombat]
 * @property {boolean} [showInQuickbar]
 * @property {(ctx: ActionContext)=>boolean} [visible]
 * @property {(ctx: ActionContext)=>boolean} [enabled]
 * @property {(ctx: ActionContext)=>string|null} [disabledReason]
 * @property {(ctx: ActionContext)=>Promise<boolean|void>|boolean|void} run
 * @property {boolean} [skipPostCombatLog] - if true, `executeActorAction` skips AP log + combat journal after `run` (run handles it)
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

function _normalizeAimingType(v) {
  const raw = String(v ?? "simple").trim().toLowerCase();
  return raw === "standard" ? "standard" : "simple";
}
 
import { ensureCharacterApSynced, getStoredActionPoints, spendAp } from './transaction-ledger.mjs';
import { appendCombatActionJournalLine } from './action-chat-journal.mjs';

async function _ensureAimingManager() {
  let mgr = game.spaceholder?.aimingManager || null;
  if (mgr) return mgr;
  try {
    const mod = await import("../aiming-manager.mjs");
    const Ctor = mod?.AimingManager;
    if (typeof Ctor !== "function") return null;
    mgr = new Ctor();
    if (game.spaceholder) game.spaceholder.aimingManager = mgr;
    return mgr;
  } catch (e) {
    console.error("SpaceHolder | Failed to initialize AimingManager", e);
    return null;
  }
}

function _resolveActionToken(ctx, actor) {
  const direct = ctx?.tokenDoc?.object ?? null;
  if (direct) return direct;
  const controlled = canvas?.tokens?.controlled || [];
  const fromControlled = controlled.find((t) => String(t?.actor?.id || "") === String(actor?.id || ""));
  if (fromControlled) return fromControlled;
  try {
    const active = actor?.getActiveTokens?.(true, true) || [];
    return active[0] || null;
  } catch (_) {
    return null;
  }
}

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

const SYSTEM_FREE_ACTION_ID = 'system.freeAction';

/**
 * Combat session log + per-actor chat journal line (after AP spend).
 * @param {object} p
 * @param {Actor} p.actor
 * @param {ActionContext} p.ctx
 * @param {string} p.actionId
 * @param {string} p.label
 * @param {string} p.description
 * @param {number} p.baseCost
 * @param {number} p.cost
 * @param {string|null} p.transactionId
 * @param {object|null} [p.combatantHint]
 */
async function _postRunCombatActionLogging({
  actor,
  ctx,
  actionId,
  label,
  description,
  baseCost,
  cost,
  transactionId,
  combatantHint = null,
}) {
  const combat = _activeCombat();
  const combatant = combatantHint || _getCombatantForActor(actor, ctx.tokenDoc ?? null, combat);
  const activeTurnId = String(combat?.getFlag?.("spaceholder", "combatState")?.activeTurn?.combatantId || "").trim();
  const anchorCombatant = activeTurnId && combat?.combatants?.get?.(activeTurnId)
    ? combat.combatants.get(activeTurnId)
    : combatant;
  const anchorActor = anchorCombatant?.actor || actor;
  const isReaction = !!(combat && combatant && activeTurnId && activeTurnId !== combatant.id);

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
        actionId,
        label,
        description: String(description || "").trim() || null,
        tokenUuid: ctx.tokenDoc?.uuid ?? null,
        transactionId,
        isReaction,
        anchorCombatantId: anchorCombatant?.id ?? null,
        reactionOfEventId: null,
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
      anchorActor,
      anchorCombatant,
      label,
      description: String(description || "").trim(),
      apCost: cost,
      kind: 'action',
      isReaction,
      actorName: actor?.name || "",
      transactionId,
      combatEventId,
      tokenUuid: ctx.tokenDoc?.uuid ?? null,
    });
  }
}

/**
 * @param {ActionContext} ctx
 * @returns {ActionDescriptor}
 */
function _buildSystemFreeAction(ctx) {
  return {
    id: SYSTEM_FREE_ACTION_ID,
    source: 'system',
    label: _t('SPACEHOLDER.ActionsSystem.FreeAction.Label'),
    icon: 'fa-solid fa-pen-to-square',
    apCost: 0,
    description: '',
    showInCombat: true,
    showInQuickbar: true,
    skipPostCombatLog: true,
    visible: () => true,
    enabled: () => !!ctx.actor && ctx.actor.type === 'character',
    run: async (runCtx) => {
      const actor = runCtx.actor;
      if (!actor || actor.type !== 'character') return false;

      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (!DialogV2?.wait) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.ActionsSystem.FreeAction.DialogUnavailable'));
        return false;
      }

      const uid = foundry.utils.randomID?.() ?? `sh-free-${Date.now()}`;
      const idName = `sh-free-act-name-${uid}`;
      const idDesc = `sh-free-act-desc-${uid}`;
      const idAp = `sh-free-act-ap-${uid}`;

      const title = _t('SPACEHOLDER.ActionsSystem.FreeAction.DialogTitle');
      const lblName = _t('SPACEHOLDER.ActionsSystem.FreeAction.FieldName');
      const lblDesc = _t('SPACEHOLDER.ActionsSystem.FreeAction.FieldDescription');
      const lblAp = _t('SPACEHOLDER.ActionsSystem.FreeAction.FieldApCost');
      const okLabel = _t('SPACEHOLDER.Actions.Apply');
      const cancelLabel = _t('SPACEHOLDER.Actions.Cancel');

      const content = `
        <div class="spaceholder-free-action-dialog">
          <div class="spaceholder-free-action-dialog__field">
            <label class="spaceholder-free-action-dialog__label" for="${idName}">${foundry.utils.escapeHTML(lblName)}</label>
            <input class="spaceholder-free-action-dialog__input" id="${idName}" type="text" autocomplete="off" />
          </div>
          <div class="spaceholder-free-action-dialog__field">
            <label class="spaceholder-free-action-dialog__label" for="${idDesc}">${foundry.utils.escapeHTML(lblDesc)}</label>
            <textarea class="spaceholder-free-action-dialog__input" id="${idDesc}" rows="5"></textarea>
          </div>
          <div class="spaceholder-free-action-dialog__field spaceholder-free-action-dialog__field--ap">
            <label class="spaceholder-free-action-dialog__label" for="${idAp}">${foundry.utils.escapeHTML(lblAp)}</label>
            <input class="spaceholder-free-action-dialog__input" id="${idAp}" type="number" step="1" min="0" value="0" />
          </div>
        </div>`;

      const _formRoot = (dlgEvent) =>
        dlgEvent?.currentTarget?.form ||
        dlgEvent?.target?.form ||
        dlgEvent?.currentTarget?.closest?.('form') ||
        dlgEvent?.target?.closest?.('form') ||
        dlgEvent?.currentTarget;

      /** @type {{ ok: true, name: string, description: string, baseCost: number } | { ok: false } | null} */
      let outcome = null;

      await DialogV2.wait({
        classes: ['spaceholder'],
        window: {
          title,
          icon: 'fa-solid fa-pen-to-square',
        },
        position: { width: 480 },
        content,
        buttons: [
          {
            action: 'ok',
            label: okLabel,
            icon: 'fa-solid fa-check',
            default: true,
            callback: (dlgEvent) => {
              const root = _formRoot(dlgEvent);
              const name = String(root?.querySelector?.(`#${idName}`)?.value ?? '').trim();
              if (!name) {
                ui.notifications?.warn?.(_t('SPACEHOLDER.ActionsSystem.FreeAction.NameRequired'));
                return;
              }
              const description = String(root?.querySelector?.(`#${idDesc}`)?.value ?? '').trim();
              const apRaw = String(root?.querySelector?.(`#${idAp}`)?.value ?? '0').trim().replace(',', '.');
              const baseCost = Math.max(0, Math.floor(Number.parseFloat(apRaw) || 0));
              outcome = { ok: true, name, description, baseCost };
            },
          },
          {
            action: 'cancel',
            label: cancelLabel,
            icon: 'fa-solid fa-times',
            callback: () => {
              outcome = { ok: false };
            },
          },
        ],
      });

      if (!outcome || !outcome.ok) return false;

      const { name, description, baseCost } = outcome;
      const cost = getEffectiveActionCost(actor, baseCost);
      await ensureCharacterApSynced(actor);

      let combat = _activeCombat();
      let combatant = _getCombatantForActor(actor, runCtx.tokenDoc ?? null, combat);
      const mgr = game.spaceholder?.combatSessionManager;
      if (combat && combatant && !combat.getFlag?.("spaceholder", "combatState")?.activeTurn?.combatantId && mgr?.pickTurn) {
        await mgr.pickTurn({ combatId: combat.id, combatantId: combatant.id });
        combat = _activeCombat();
        combatant = _getCombatantForActor(actor, runCtx.tokenDoc ?? null, combat);
      }

      let transactionId = null;
      if (cost > 0) {
        let spend = null;
        try {
          spend = await spendAp(actor, cost, {
            combatantId: combatant?.id ?? null,
            source: { type: 'action', actionId: SYSTEM_FREE_ACTION_ID, label: name },
          });
        } catch (e) {
          ui.notifications?.warn?.(String(e?.message || e) || _t('SPACEHOLDER.ActionsSystem.Errors.ApSpendFailed'));
          return false;
        }
        if (!spend?.ok) {
          ui.notifications?.warn?.(spend?.error || _t('SPACEHOLDER.ActionsSystem.Errors.ApSpendFailed'));
          return false;
        }
        transactionId = spend.transactionId ?? null;
      }

      if (combat && combatant) {
        await _postRunCombatActionLogging({
          actor,
          ctx: runCtx,
          actionId: SYSTEM_FREE_ACTION_ID,
          label: name,
          description,
          baseCost,
          cost,
          transactionId,
          combatantHint: combatant,
        });
      } else if (!combat) {
        const descHtml = description
          ? `<div>${foundry.utils.escapeHTML(description)}</div>`
          : '';
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<div><strong>${foundry.utils.escapeHTML(name)}</strong></div>${descHtml}`,
        });
      }

      return true;
    },
  };
}

function _coordinationValue(actor) {
  return _num(actor?.system?.abilities?.cor?.value, 10);
}

/**
 * Raw AP for movement from scene distance: AP per 1 grid-agnostic distance unit × distance, rounded up.
 * `actor.system.speed` = AP spent per 1 unit of distance (not per cell).
 * Для персонажей задаётся в `prepareDerivedData`: бюджет `CONFIG.SPACEHOLDER.movementApTimeSlice` ОД / дистанция за этот бюджет (от DEX).
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
        description: String(a.description ?? "").trim(),
        apCost: _num(a.apCost, 0),
        mode: String(a.mode ?? "chat").trim() || "chat", // 'chat' | 'itemRoll' | 'macro' | 'aimShot'
        macro: String(a.macro ?? '').trim() || '',
        aimingType: _normalizeAimingType(a.aimingType),
        payloadId: String(a.payloadId ?? "").trim(),
        damage: Math.max(0, _num(a.damage, 1)),
        requiresHolding: !!a.requiresHolding,
        showInCombat: a.showInCombat !== undefined ? !!a.showInCombat : true,
        showInQuickbar: a.showInQuickbar !== undefined ? !!a.showInQuickbar : true,
      };
    })
    .filter(Boolean);
}
 
/**
 * Collect standard wearable/holding actions for gear items.
 * State machine:
 * - bag: equipped=false, held=false
 * - held: equipped=false, held=true
 * - equipped: equipped=true, held=false
 * @param {Actor} actor
 * @param {ActionContext} ctx
 */
function _collectWearableToggleActions(actor, ctx) {
  const actions = [];
  const items = actor?.items ? Array.from(actor.items) : [];
  for (const item of items) {
    if (!item || item.type !== 'item') continue;
    const isArmor = !!item.system?.itemTags?.isArmor;
    const equipped = !!item.system?.equipped;
    const held = !!item.system?.held;
    const defaults = item.system?.defaultActions ?? {};
    const equipDefaults = defaults?.equip ?? {};
    const unequipDefaults = defaults?.unequip ?? {};
    const holdDefaults = defaults?.hold ?? {};
    const stowDefaults = defaults?.stow ?? {};
 
    if (equipped && isArmor) {
      actions.push({
        id: `item.${item.uuid}.unequip`,
        source: 'item',
        sourceItemName: item.name,
        label: _t('SPACEHOLDER.ActionsSystem.Wearable.Unequip', { item: item.name }),
        icon: 'fa-solid fa-shield',
        apCost: 0,
        showInCombat: unequipDefaults.showInCombat ?? false,
        showInQuickbar: unequipDefaults.showInQuickbar ?? true,
        visible: () => true,
        enabled: () => !!ctx.editable,
        disabledReason: () => (ctx.editable ? null : _t('SPACEHOLDER.ActionsSystem.Common.NotEditable')),
        run: async () => {
          await item.update({ 'system.equipped': false, 'system.held': true });
        }
      });
      continue;
    }

    if (held) {
      if (isArmor) {
        actions.push({
          id: `item.${item.uuid}.equip`,
          source: 'item',
          sourceItemName: item.name,
          label: _t('SPACEHOLDER.ActionsSystem.Wearable.Equip', { item: item.name }),
          icon: 'fa-solid fa-shield-halved',
          apCost: 0,
          showInCombat: equipDefaults.showInCombat ?? false,
          showInQuickbar: equipDefaults.showInQuickbar ?? true,
          visible: () => true,
          enabled: () => !!ctx.editable,
          disabledReason: () => (ctx.editable ? null : _t('SPACEHOLDER.ActionsSystem.Common.NotEditable')),
          run: async () => {
            await item.update({ 'system.equipped': true, 'system.held': false });
          }
        });
      }
      actions.push({
        id: `item.${item.uuid}.stow`,
        source: 'item',
        sourceItemName: item.name,
        label: _t('SPACEHOLDER.ActionsSystem.Wearable.Stow', { item: item.name }),
        icon: 'fa-solid fa-box-open',
        apCost: 0,
        showInCombat: stowDefaults.showInCombat ?? false,
        showInQuickbar: stowDefaults.showInQuickbar ?? true,
        visible: () => true,
        enabled: () => !!ctx.editable,
        disabledReason: () => (ctx.editable ? null : _t('SPACEHOLDER.ActionsSystem.Common.NotEditable')),
        run: async () => {
          await item.update({ 'system.equipped': false, 'system.held': false });
        }
      });
      continue;
    }

    actions.push({
      id: `item.${item.uuid}.hold`,
      source: 'item',
      sourceItemName: item.name,
      label: _t('SPACEHOLDER.ActionsSystem.Wearable.Hold', { item: item.name }),
      icon: 'fa-solid fa-hand',
      apCost: 0,
      showInCombat: holdDefaults.showInCombat ?? false,
      showInQuickbar: holdDefaults.showInQuickbar ?? true,
      visible: () => true,
      enabled: () => !!ctx.editable,
      disabledReason: () => (ctx.editable ? null : _t('SPACEHOLDER.ActionsSystem.Common.NotEditable')),
      run: async () => {
        await item.update({ 'system.equipped': false, 'system.held': true });
      }
    });
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
      description: a.description || "",
      showInCombat: a.showInCombat,
      showInQuickbar: a.showInQuickbar,
      requiresHolding: false,
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
        // In active combat actions are logged into the combat journal only.
        if (_activeCombat()) return;
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
        sourceItemName: item.name,
        label: `${item.name}: ${a.name}`,
        icon: 'fa-solid fa-bolt',
        apCost: a.apCost ?? 0,
        description: a.description || "",
        showInCombat: a.showInCombat,
        showInQuickbar: a.showInQuickbar,
        requiresHolding: !!a.requiresHolding,
        visible: () => true,
        enabled: () => true,
        run: async () => {
          if (a.mode === 'itemRoll') {
            if (_activeCombat()) return;
            return item.roll?.();
          }
          if (a.mode === "aimShot") {
            const token = _resolveActionToken(ctx, actor);
            if (!token) {
              ui.notifications?.warn?.(_t("SPACEHOLDER.ActionsSystem.Errors.NoTokenForAiming"));
              return false;
            }
            const payloadId = String(a.payloadId || "").trim();
            if (!payloadId) {
              ui.notifications?.warn?.(_t("SPACEHOLDER.ActionsSystem.Errors.MissingActionPayload"));
              return false;
            }
            const aimingManager = await _ensureAimingManager();
            if (!aimingManager?.startAimingFromActionConfig) {
              ui.notifications?.warn?.(_t("SPACEHOLDER.ActionsSystem.Errors.AimingUnavailable"));
              return false;
            }
            const started = await aimingManager.startAimingFromActionConfig({
              token,
              payloadId,
              aimingType: _normalizeAimingType(a.aimingType),
              damage: Math.max(0, _num(a.damage, 1)),
              actor,
              item,
              actionName: a.name,
            });
            if (!started) {
              ui.notifications?.warn?.(_t("SPACEHOLDER.ActionsSystem.Errors.AimingStartFailed"));
              return false;
            }
            return true;
          }
          if (a.mode === 'macro' && a.macro) {
            // eslint-disable-next-line no-new-func
            const fn = new Function(a.macro);
            await fn.call(globalThis);
            return;
          }
          if (_activeCombat()) return;
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
  if (actor?.type === 'character') {
    list.push(_buildSystemFreeAction(ctx));
  }

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

  let combat = _activeCombat();
  let combatant = _getCombatantForActor(actor, ctx.tokenDoc ?? null, combat);
  const mgr = game.spaceholder?.combatSessionManager;
  if (combat && combatant && !combat.getFlag?.("spaceholder", "combatState")?.activeTurn?.combatantId && mgr?.pickTurn) {
    // Corner case: first action in combat can start the actor's official turn.
    await mgr.pickTurn({ combatId: combat.id, combatantId: combatant.id });
    combat = _activeCombat();
    combatant = _getCombatantForActor(actor, ctx.tokenDoc ?? null, combat);
  }

  let transactionId = null;
  if (cost > 0 && actor.type === "character") {
    let spend = null;
    try {
      spend = await spendAp(actor, cost, {
        combatantId: combatant?.id ?? null,
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

  const runOutcome = await action.run(ctx);
  if (action.skipPostCombatLog) {
    return runOutcome !== false;
  }

  await _postRunCombatActionLogging({
    actor,
    ctx,
    actionId: action.id,
    label: action.label,
    description: String(action.description || "").trim(),
    baseCost,
    cost,
    transactionId,
    combatantHint: combatant,
  });

  return true;
}
 

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
 * @property {string} [menuGroup] - Optional context-menu group label
 * @property {string} [menuLabel] - Optional context-menu row label
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

function _escapeHTML(value) {
  try {
    return foundry.utils.escapeHTML(String(value ?? ''));
  } catch (_) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
}

function _normalizeAimingType(v) {
  const raw = String(v ?? "simple").trim().toLowerCase();
  return raw === "standard" ? "standard" : "simple";
}
 
import { ensureCharacterApSynced, getStoredActionPoints, spendAp } from './transaction-ledger.mjs';
import { appendCombatActionJournalLine } from './action-chat-journal.mjs';
import { listWeaponAttacks, AMMO_BLOCK_TYPES } from '../weapon/weapon-model.mjs';
import {
  getWeaponData,
  persistWeaponData,
  getAmmoBlock,
  loadBlock,
  operateBolt,
  unloadBlock,
  emptyBlock,
  attachMagazine,
  detachMagazine,
  reloadBlock,
  canLoadOne,
  canLoadX,
  canReloadBlock,
  canBoltBlock,
  canUnloadBlock,
  canEmptyBlock,
  canAttachMagazine,
  canDetachMagazine,
} from '../weapon/weapon-ammo-runtime.mjs';
import { runWeaponAttack } from '../weapon/attack-chain.mjs';
import { findNearestPileDropPointWithinCells } from '../item-piles-sh/held-drop-resolve.mjs';

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
const ITEM_STANDARD_GROUP_KEY = 'SPACEHOLDER.ActionsSystem.ItemMenu.StandardGroup';

function _itemActionPrefix(item) {
  return `item.${item?.uuid ?? ''}.`;
}

function _actionBelongsToItem(action, item) {
  const prefix = _itemActionPrefix(item);
  return !!prefix && String(action?.id ?? '').startsWith(prefix);
}

async function _dropItemToScene(actor, item, ctx) {
  if (!actor || !item) return false;
  if (!game.settings.get('spaceholder', 'itemPilesShEnabled')) {
    ui.notifications?.warn?.(_t('SPACEHOLDER.Inventory.HeldActions.DropItemPilesDisabled'));
    return false;
  }
  const pilesApi = game.spaceholder?.itemPilesSh?.api;
  if (!pilesApi?.dropData) {
    ui.notifications?.warn?.(_t('SPACEHOLDER.Inventory.HeldActions.DropItemPilesDisabled'));
    return false;
  }
  const scene = canvas?.scene;
  if (!scene) {
    ui.notifications?.warn?.(_t('SPACEHOLDER.Inventory.HeldActions.DropNoToken'));
    return false;
  }
  const token = ctx?.tokenDoc?.object
    ?? (canvas.tokens?.controlled ?? []).find((t) => t.actor?.id === actor.id)
    ?? actor.getActiveTokens?.()?.[0]
    ?? null;
  if (!token?.center) {
    ui.notifications?.warn?.(_t('SPACEHOLDER.Inventory.HeldActions.DropNoToken'));
    return false;
  }

  const gridSize = canvas.grid.size;
  const cx = token.center.x;
  const cy = token.center.y;
  const dirDeg = Number(token.document?.getFlag?.('spaceholder', 'tokenpointerDirection') ?? 90);
  const rad = (dirDeg * Math.PI) / 180;
  const step = gridSize / 2;
  const targetX = cx + Math.cos(rad) * step;
  const targetY = cy + Math.sin(rad) * step;
  const mergeCenter = findNearestPileDropPointWithinCells(scene, cx, cy, 2, gridSize);
  const dropX = mergeCenter ? mergeCenter.x : targetX - gridSize / 2;
  const dropY = mergeCenter ? mergeCenter.y : targetY - gridSize / 2;

  try {
    await pilesApi.dropData({
      dropData: {
        type: 'Item',
        uuid: item.uuid,
        x: dropX,
        y: dropY,
        quantity: 1,
      },
      sceneId: scene.id,
    });
    return true;
  } catch (e) {
    console.error('SpaceHolder | failed to drop item via item-piles-sh:', e);
    ui.notifications?.warn?.(_t('SPACEHOLDER.Inventory.HeldActions.DropFailed'));
    return false;
  }
}

async function _showItemInChat(item) {
  if (!item) return false;
  const escape = foundry.utils.escapeHTML;
  const qty = Math.max(1, Number(item.system?.quantity) || 1);
  const desc = String(item.system?.description ?? '').trim();
  const safeDesc = desc ? await TextEditor.enrichHTML(desc, { async: true }) : '';
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: item.parent ?? null }),
    content: `
      <div class="spaceholder-chat-card">
        <h3>${escape(item.name ?? '')}</h3>
        <div><img src="${escape(item.img ?? '')}" width="48" height="48" style="float:left;margin:0 8px 4px 0;" /></div>
        <p><strong>${escape(_t('SPACEHOLDER.Inventory.Quantity'))}:</strong> ${qty}</p>
        ${safeDesc ? `<div>${safeDesc}</div>` : ''}
      </div>
    `,
  });
  return true;
}

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
    const dropDefaults = defaults?.drop ?? {};
    const showDefaults = defaults?.show ?? {};
    const standardGroup = _t(ITEM_STANDARD_GROUP_KEY);
    const pushCommonItemActions = () => {
      actions.push({
        id: `item.${item.uuid}.drop`,
        source: 'item',
        sourceItemName: item.name,
        label: _t('SPACEHOLDER.ActionsSystem.Wearable.Drop', { item: item.name }),
        menuGroup: standardGroup,
        menuLabel: _t('SPACEHOLDER.ActionsSystem.Wearable.DropShort'),
        icon: 'fa-solid fa-arrow-down',
        apCost: 0,
        showInCombat: dropDefaults.showInCombat ?? false,
        showInQuickbar: dropDefaults.showInQuickbar ?? false,
        visible: () => true,
        enabled: () => !!ctx.editable,
        disabledReason: () => (ctx.editable ? null : _t('SPACEHOLDER.ActionsSystem.Common.NotEditable')),
        run: async (runCtx) => _dropItemToScene(actor, item, runCtx),
      });
      actions.push({
        id: `item.${item.uuid}.show`,
        source: 'item',
        sourceItemName: item.name,
        label: _t('SPACEHOLDER.ActionsSystem.Wearable.Show', { item: item.name }),
        menuGroup: standardGroup,
        menuLabel: _t('SPACEHOLDER.ActionsSystem.Wearable.ShowShort'),
        icon: 'fa-solid fa-comment-dots',
        apCost: 0,
        showInCombat: showDefaults.showInCombat ?? false,
        showInQuickbar: showDefaults.showInQuickbar ?? false,
        visible: () => true,
        enabled: () => true,
        run: async () => _showItemInChat(item),
      });
    };
 
    if (equipped && isArmor) {
      actions.push({
        id: `item.${item.uuid}.unequip`,
        source: 'item',
        sourceItemName: item.name,
        label: _t('SPACEHOLDER.ActionsSystem.Wearable.Unequip', { item: item.name }),
        menuGroup: standardGroup,
        menuLabel: _t('SPACEHOLDER.ActionsSystem.Wearable.UnequipShort'),
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
      pushCommonItemActions();
      continue;
    }

    if (held) {
      if (isArmor) {
        actions.push({
          id: `item.${item.uuid}.equip`,
          source: 'item',
          sourceItemName: item.name,
          label: _t('SPACEHOLDER.ActionsSystem.Wearable.Equip', { item: item.name }),
          menuGroup: standardGroup,
          menuLabel: _t('SPACEHOLDER.ActionsSystem.Wearable.EquipShort'),
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
        menuGroup: standardGroup,
        menuLabel: _t('SPACEHOLDER.ActionsSystem.Wearable.StowShort'),
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
      pushCommonItemActions();
      continue;
    }

    actions.push({
      id: `item.${item.uuid}.hold`,
      source: 'item',
      sourceItemName: item.name,
      label: _t('SPACEHOLDER.ActionsSystem.Wearable.Hold', { item: item.name }),
      menuGroup: standardGroup,
      menuLabel: _t('SPACEHOLDER.ActionsSystem.Wearable.HoldShort'),
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
    pushCommonItemActions();
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
 
let _weaponInteractMenuEl = null;
let _weaponInteractMenuCleanup = null;

function _filterWeaponInteractActions(interactActions, ctx, { requireEnabled = true } = {}) {
  return (interactActions ?? []).filter((a) => {
    if (typeof a.visible === 'function' && !a.visible(ctx)) return false;
    if (requireEnabled && typeof a.enabled === 'function' && !a.enabled(ctx)) return false;
    return true;
  });
}

function _closeWeaponInteractMenu(result = false) {
  const cleanup = _weaponInteractMenuCleanup;
  _weaponInteractMenuCleanup = null;
  if (cleanup) {
    try { cleanup(result); } catch (_) { /* ignore */ }
    return;
  }
  try { _weaponInteractMenuEl?.remove?.(); } catch (_) { /* ignore */ }
  _weaponInteractMenuEl = null;
}

function _resolveWeaponMenuPosition(ctx) {
  const ev = ctx?.event;
  if (Number.isFinite(ev?.clientX) && Number.isFinite(ev?.clientY)) {
    return { x: ev.clientX, y: ev.clientY };
  }
  const anchor = ctx?.anchorElement;
  const rect = anchor?.getBoundingClientRect?.();
  if (rect) return { x: rect.left, y: rect.bottom + 4 };
  return {
    x: Math.round((window.innerWidth || 800) / 2),
    y: Math.round((window.innerHeight || 600) / 2),
  };
}

function _positionWeaponInteractMenu(menu, ctx) {
  const { x, y } = _resolveWeaponMenuPosition(ctx);
  const pad = 8;
  const vw = window.innerWidth || document.documentElement?.clientWidth || 800;
  const vh = window.innerHeight || document.documentElement?.clientHeight || 600;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(pad, Math.min(x, vw - rect.width - pad));
  const top = Math.max(pad, Math.min(y, vh - rect.height - pad));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function _groupWeaponInteractActions(actions) {
  const groups = [];
  const byName = new Map();
  for (const action of actions) {
    const groupName = String(action.menuGroup || action.description || '').trim();
    if (!byName.has(groupName)) {
      const group = { name: groupName, actions: [] };
      byName.set(groupName, group);
      groups.push(group);
    }
    byName.get(groupName).actions.push(action);
  }
  return groups;
}

/**
 * Fallback dialog for environments where a DOM popover cannot be rendered.
 * @param {Actor} actor
 * @param {Item} weaponItem
 * @param {ActionDescriptor[]} interactActions
 * @param {Partial<ActionContext>} ctx
 * @returns {Promise<boolean>}
 */
async function _showWeaponInteractDialog(actor, weaponItem, interactActions, ctx) {
  const available = (interactActions ?? []).filter((a) => {
    if (typeof a.visible === 'function' && !a.visible(ctx)) return false;
    if (typeof a.enabled === 'function' && !a.enabled(ctx)) return false;
    return true;
  });
  if (!available.length) {
    ui.notifications?.info?.(_t('SPACEHOLDER.WeaponV3.Interact.NoActions'));
    return false;
  }
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) {
    return executeActorAction(actor, available[0], ctx);
  }
  let result = false;
  const apShort = _t('SPACEHOLDER.WeaponV3.Chain.ApShort');
  const buttons = available.map((action, i) => ({
    action: `pick_${i}`,
    label: `${action.menuLabel || action.label}${action.apCost ? ` (${action.apCost} ${apShort})` : ''}`,
    icon: action.icon ?? 'fa-solid fa-box-open',
    callback: async () => {
      result = await executeActorAction(actor, action, ctx);
    },
  }));
  buttons.push({ action: 'cancel', label: _t('SPACEHOLDER.Actions.Cancel'), icon: 'fa-solid fa-times' });
  await DialogV2.wait({
    classes: ['spaceholder'],
    window: {
      title: _t('SPACEHOLDER.WeaponV3.Interact.Title', { name: weaponItem.name }),
      icon: 'fa-solid fa-hand',
    },
    position: { width: 420 },
    content: `<p class="notes">${_escapeHTML(_t('SPACEHOLDER.WeaponV3.Interact.Hint'))}</p>`,
    buttons,
  });
  return result;
}

/**
 * Show weapon interact menu (atomic block actions).
 * @param {Actor} actor
 * @param {Item} weaponItem
 * @param {ActionDescriptor[]} interactActions
 * @param {Partial<ActionContext>} ctx
 * @returns {Promise<boolean>}
 */
async function _showWeaponInteractMenu(actor, weaponItem, interactActions, ctx) {
  const visible = _filterWeaponInteractActions(interactActions, ctx, { requireEnabled: false });
  if (!visible.length) {
    ui.notifications?.info?.(_t('SPACEHOLDER.WeaponV3.Interact.NoActions'));
    return false;
  }

  if (!document?.body) return _showWeaponInteractDialog(actor, weaponItem, visible, ctx);
  _closeWeaponInteractMenu(false);

  const apShort = _t('SPACEHOLDER.WeaponV3.Chain.ApShort');
  const menu = document.createElement('nav');
  menu.id = 'spaceholder-weapon-interact-menu';
  menu.className = 'spaceholder-weapon-interact-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <div class="spaceholder-weapon-interact-menu__title">${_escapeHTML(weaponItem.name)}</div>
    ${_groupWeaponInteractActions(visible).map((group) => `
      <section class="spaceholder-weapon-interact-menu__group">
        ${group.name ? `<div class="spaceholder-weapon-interact-menu__group-title">${_escapeHTML(group.name)}</div>` : ''}
        ${group.actions.map((action) => `
          <button type="button" class="spaceholder-weapon-interact-menu__action" data-action-id="${_escapeHTML(action.id)}" role="menuitem" ${typeof action.enabled === 'function' && !action.enabled(ctx) ? 'disabled' : ''}>
            <span class="spaceholder-weapon-interact-menu__label">${_escapeHTML(action.menuLabel || action.label)}</span>
            <span class="spaceholder-weapon-interact-menu__ap">${Math.max(0, Number(action.apCost) || 0)} ${_escapeHTML(apShort)}</span>
          </button>
        `).join('')}
      </section>
    `).join('')}
  `;

  document.body.appendChild(menu);
  _weaponInteractMenuEl = menu;
  _positionWeaponInteractMenu(menu, ctx);

  return new Promise((resolve) => {
    const finish = (value) => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      try { menu.remove(); } catch (_) { /* ignore */ }
      if (_weaponInteractMenuEl === menu) _weaponInteractMenuEl = null;
      resolve(!!value);
    };

    const onPointerDown = (ev) => {
      if (menu.contains(ev.target)) return;
      _closeWeaponInteractMenu(false);
    };
    const onKeyDown = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      _closeWeaponInteractMenu(false);
    };

    _weaponInteractMenuCleanup = finish;
    menu.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    menu.addEventListener('click', async (ev) => {
      const btn = ev.target?.closest?.('[data-action-id]');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const action = visible.find((a) => a.id === btn.dataset.actionId);
      if (!action) return;
      _weaponInteractMenuCleanup = null;
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      try { menu.remove(); } catch (_) { /* ignore */ }
      if (_weaponInteractMenuEl === menu) _weaponInteractMenuEl = null;
      const result = await executeActorAction(actor, action, ctx);
      resolve(!!result);
    });

    setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
    }, 0);
  });
}

function _collectItemInteractActions(actor, item, ctx) {
  const interactActions = [];
  interactActions.push(..._collectWearableToggleActions(actor, ctx).filter((a) => _actionBelongsToItem(a, item)));
  interactActions.push(..._collectCustomActions(actor, ctx).filter((a) => _actionBelongsToItem(a, item)));

  if (item?.system?.itemTags?.isWeapon) {
    const weapon = getWeaponData(item);
    for (const line of weapon.lines ?? []) {
      for (const block of line.ammoBlocks ?? []) {
        interactActions.push(..._buildWeaponBlockActions(actor, item, line, block));
      }
    }
  }

  return interactActions;
}

/**
 * Open standard item interact menu (HUD / inventory PKM).
 * @param {Actor} actor
 * @param {Item} item
 * @param {Partial<ActionContext>} partialCtx
 * @returns {Promise<boolean>}
 */
export async function openItemInteractMenu(actor, item, partialCtx = {}) {
  if (!actor || !item || item.type !== 'item') return false;
  const ctx = {
    user: game.user,
    isGM: !!game.user?.isGM,
    inCombat: !!_activeCombat(),
    actor,
    tokenDoc: partialCtx.tokenDoc ?? null,
    editable: partialCtx.editable !== undefined ? !!partialCtx.editable : !!actor?.isOwner,
    event: partialCtx.event ?? null,
    anchorElement: partialCtx.anchorElement ?? null,
  };
  const interactActions = _collectItemInteractActions(actor, item, ctx);
  return _showWeaponInteractMenu(actor, item, interactActions, ctx);
}

/**
 * Backward-compatible name for weapon callers; now opens the generic item menu.
 */
export async function openWeaponInteractMenu(actor, item, partialCtx = {}) {
  return openItemInteractMenu(actor, item, partialCtx);
}

/**
 * Build atomic ammo-block action descriptors for one weapon block.
 * @returns {ActionDescriptor[]}
 */
function _buildWeaponBlockActions(actor, item, line, block) {
  const out = [];
  const lineName = line.name || _t('SPACEHOLDER.WeaponV3.Line.Default');
  const prefix = `${lineName}`;

  const pushAction = ({ id, labelKey, labelData, icon, apKey, canFn, runFn }) => {
    const cfg = block.apActions?.[apKey];
    if (!cfg?.enabled) return;
    const actionLabel = labelData ? _t(labelKey, labelData) : _t(labelKey);
    out.push({
      id,
      source: 'item',
      sourceItemName: item.name,
      label: `${prefix}: ${actionLabel}`,
      menuGroup: prefix,
      menuLabel: actionLabel,
      icon: icon ?? 'fa-solid fa-box-open',
      apCost: Math.max(0, cfg.value),
      description: prefix,
      showInCombat: true,
      showInQuickbar: false,
      weaponInteract: true,
      visible: () => canFn(),
      enabled: () => !!item.system?.held && canFn(),
      run: runFn,
    });
  };

  pushAction({
    id: `item.${item.uuid}.weaponBlock.${line.id}.${block.id}.loadOne`,
    labelKey: 'SPACEHOLDER.WeaponV3.BlockActions.LoadOne',
    apKey: 'loadOne',
    canFn: () => canLoadOne(actor, block),
    runFn: async () => {
      const w = getWeaponData(item);
      const b = getAmmoBlock(w, line.id, block.id);
      if (!b) return false;
      const res = await loadBlock({ actor, block: b, count: 1 });
      if (!res?.ok) { ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed')); return false; }
      await persistWeaponData(item, w);
      return true;
    },
  });

  const loadXAmount = Math.max(0, Number(block.loadAmount) || 0);
  if (block.apActions?.loadX?.enabled && loadXAmount > 0) {
    pushAction({
      id: `item.${item.uuid}.weaponBlock.${line.id}.${block.id}.loadX`,
      labelKey: 'SPACEHOLDER.WeaponV3.BlockActions.LoadX',
      labelData: { count: loadXAmount },
      apKey: 'loadX',
      canFn: () => canLoadX(actor, block),
      runFn: async () => {
        const w = getWeaponData(item);
        const b = getAmmoBlock(w, line.id, block.id);
        if (!b) return false;
        const res = await loadBlock({ actor, block: b, count: loadXAmount });
        if (!res?.ok) { ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed')); return false; }
        await persistWeaponData(item, w);
        return true;
      },
    });
  }

  pushAction({
    id: `item.${item.uuid}.weaponBlock.${line.id}.${block.id}.reload`,
    labelKey: 'SPACEHOLDER.WeaponV3.BlockActions.Reload',
    apKey: 'reload',
    canFn: () => canReloadBlock(actor, block),
    runFn: async () => {
      const w = getWeaponData(item);
      const b = getAmmoBlock(w, line.id, block.id);
      if (!b) return false;
      const res = await reloadBlock({ actor, block: b });
      if (!res?.ok) { ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed')); return false; }
      await persistWeaponData(item, w);
      return true;
    },
  });

  if (block.chamberEnabled) {
    pushAction({
      id: `item.${item.uuid}.weaponBlock.${line.id}.${block.id}.bolt`,
      labelKey: 'SPACEHOLDER.WeaponV3.BlockActions.Bolt',
      apKey: 'bolt',
      icon: 'fa-solid fa-rotate',
      canFn: () => canBoltBlock(block),
      runFn: async () => {
        const w = getWeaponData(item);
        const b = getAmmoBlock(w, line.id, block.id);
        if (!b) return false;
        const res = await operateBolt({ actor, block: b });
        if (!res?.ok) { ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed')); return false; }
        await persistWeaponData(item, w);
        return true;
      },
    });
  }

  pushAction({
    id: `item.${item.uuid}.weaponBlock.${line.id}.${block.id}.unload`,
    labelKey: 'SPACEHOLDER.WeaponV3.BlockActions.Unload',
    apKey: 'unload',
    canFn: () => canUnloadBlock(block),
    runFn: async () => {
      const w = getWeaponData(item);
      const b = getAmmoBlock(w, line.id, block.id);
      if (!b) return false;
      const res = await unloadBlock({ actor, block: b });
      if (!res?.ok) { ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed')); return false; }
      await persistWeaponData(item, w);
      return true;
    },
  });

  pushAction({
    id: `item.${item.uuid}.weaponBlock.${line.id}.${block.id}.empty`,
    labelKey: 'SPACEHOLDER.WeaponV3.BlockActions.Empty',
    apKey: 'empty',
    canFn: () => canEmptyBlock(block),
    runFn: async () => {
      const w = getWeaponData(item);
      const b = getAmmoBlock(w, line.id, block.id);
      if (!b) return false;
      const res = await emptyBlock({ actor, block: b });
      if (!res?.ok) { ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed')); return false; }
      await persistWeaponData(item, w);
      return true;
    },
  });

  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    if (canAttachMagazine(actor, block)) {
      out.push({
        id: `item.${item.uuid}.weaponBlock.${line.id}.${block.id}.attachMagazine`,
        source: 'item',
        sourceItemName: item.name,
        label: `${prefix}: ${_t('SPACEHOLDER.WeaponV3.BlockActions.AttachMagazine')}`,
        menuGroup: prefix,
        menuLabel: _t('SPACEHOLDER.WeaponV3.BlockActions.AttachMagazine'),
        icon: 'fa-solid fa-box',
        apCost: block.apActions?.reload?.enabled ? Math.max(0, block.apActions.reload.value) : 0,
        description: prefix,
        showInCombat: true,
        showInQuickbar: false,
        weaponInteract: true,
        visible: () => canAttachMagazine(actor, block),
        enabled: () => !!item.system?.held && canAttachMagazine(actor, block),
        run: async () => {
          const w = getWeaponData(item);
          const b = getAmmoBlock(w, line.id, block.id);
          if (!b) return false;
          const res = await attachMagazine({ actor, block: b });
          if (!res?.ok) { ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed')); return false; }
          await persistWeaponData(item, w);
          return true;
        },
      });
    }
    if (canDetachMagazine(block)) {
      out.push({
        id: `item.${item.uuid}.weaponBlock.${line.id}.${block.id}.detachMagazine`,
        source: 'item',
        sourceItemName: item.name,
        label: `${prefix}: ${_t('SPACEHOLDER.WeaponV3.BlockActions.DetachMagazine')}`,
        menuGroup: prefix,
        menuLabel: _t('SPACEHOLDER.WeaponV3.BlockActions.DetachMagazine'),
        icon: 'fa-solid fa-box',
        apCost: 0,
        description: prefix,
        showInCombat: true,
        showInQuickbar: false,
        weaponInteract: true,
        visible: () => canDetachMagazine(block),
        enabled: () => !!item.system?.held && canDetachMagazine(block),
        run: async () => {
          const w = getWeaponData(item);
          const b = getAmmoBlock(w, line.id, block.id);
          if (!b) return false;
          const res = await detachMagazine({ actor, block: b });
          if (!res?.ok) { ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed')); return false; }
          await persistWeaponData(item, w);
          return true;
        },
      });
    }
  }

  return out;
}

/**
 * Weapon v3: attacks (line × mode) + interact menu for atomic ammo actions.
 *
 * @param {Actor} actor
 * @param {ActionContext} ctx
 * @returns {ActionDescriptor[]}
 */
function _collectWeaponV3Actions(actor, ctx) {
  const out = [];
  const items = actor?.items ? Array.from(actor.items) : [];
  for (const item of items) {
    if (item?.type !== 'item') continue;
    const tags = item.system?.itemTags ?? {};
    if (!tags.isWeapon) continue;
    const weapon = getWeaponData(item);
    if (!Array.isArray(weapon.lines) || !weapon.lines.length) continue;

    for (const attack of listWeaponAttacks(weapon)) {
      const lineName = attack.line.name || _t('SPACEHOLDER.WeaponV3.Line.Default');
      const modeName = attack.mode.name || _t('SPACEHOLDER.WeaponV3.Mode.Default');
      out.push({
        id: `item.${item.uuid}.weaponAttack.${attack.lineId}.${attack.modeId}`,
        source: 'item',
        sourceItemName: item.name,
        label: `${item.name}: ${lineName} / ${modeName}`,
        icon: 'fa-solid fa-crosshairs',
        apCost: 0,
        description: '',
        showInCombat: true,
        showInQuickbar: true,
        requiresHolding: false,
        skipPostCombatLog: true,
        visible: () => true,
        enabled: () => true,
        run: async (runCtx) => {
          const token = _resolveActionToken(runCtx, actor);
          if (!token) {
            ui.notifications?.warn?.(_t('SPACEHOLDER.ActionsSystem.Errors.NoTokenForAiming'));
            return false;
          }
          return runWeaponAttack({
            actor,
            weaponItem: item,
            token,
            lineId: attack.lineId,
            modeId: attack.modeId,
          });
        },
      });
    }

    if (!item.system?.held) continue;

    const interactActions = [];
    for (const line of weapon.lines) {
      for (const block of line.ammoBlocks ?? []) {
        interactActions.push(..._buildWeaponBlockActions(actor, item, line, block));
      }
    }

    out.push({
      id: `item.${item.uuid}.weaponInteract`,
      source: 'item',
      sourceItemName: item.name,
      label: _t('SPACEHOLDER.WeaponV3.Interact.ActionLabel', { name: item.name }),
      icon: 'fa-solid fa-hand',
      apCost: 0,
      description: '',
      showInCombat: true,
      showInQuickbar: true,
      requiresHolding: true,
      skipPostCombatLog: true,
      visible: () => true,
      enabled: () => !!item.system?.held,
      run: async (runCtx) => openItemInteractMenu(actor, item, runCtx),
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
    inCombat: !!_activeCombat(),
    actor,
    tokenDoc: partialCtx.tokenDoc ?? null,
    editable: partialCtx.editable !== undefined ? !!partialCtx.editable : !!actor?.isOwner,
  };
 
  let list = [];
  list = list.concat(_collectWearableToggleActions(actor, ctx));
  list = list.concat(_collectWeaponV3Actions(actor, ctx));
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
 

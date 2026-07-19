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
  emptyBlock,
  attachMagazine,
  detachMagazine,
  reloadBlock,
  canLoadOne,
  canLoadX,
  canReloadBlock,
  canBoltBlock,
  canEmptyBlock,
  canDetachMagazine,
  findChargeCandidatesForBlock,
  findCompatibleWeaponLoadTargets,
  findCompatibleMagazineLoadTargets,
  getAmmoItemChargePreview,
  getAttachedMagazineItem,
  getBlockContentItems,
  getChamberItem,
  hasAttachedMagazine,
} from '../weapon/weapon-ammo-runtime.mjs';
import { moveQtyIntoMagazineContainer, unparentActorItemFromHost } from '../item-weapon-host.mjs';
import {
  getOrderedDirectChildItemIds,
  removeActorItemFromContainer,
} from '../item-container.mjs';
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
      // Hold is available via item interact (RMB) only — keep the actions list uncluttered.
      showInCombat: false,
      showInQuickbar: false,
      interactMenuOnly: true,
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

/**
 * Point-in-triangle (same-side / barycentric sign test).
 * @param {{x:number,y:number}} p
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {{x:number,y:number}} c
 */
function _pointInTriangle(p, a, b, c) {
  const sign = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const b1 = sign(p, a, b) < 0;
  const b2 = sign(p, b, c) < 0;
  const b3 = sign(p, c, a) < 0;
  return b1 === b2 && b2 === b3;
}

/**
 * Amazon / Kamens "triangle of expectation" for nested flyouts.
 * Keeps the open submenu alive while the cursor travels through empty space
 * between the parent row and the flyout panel (outside the menu hit-box).
 *
 * @param {HTMLElement} menu
 * @returns {() => void} dispose
 */
function _bindWeaponInteractFlyoutAim(menu) {
  const FLYOUT_SEL = '.spaceholder-weapon-interact-menu__flyout';
  const SUB_SEL = '.spaceholder-weapon-interact-menu__submenu';
  const CLOSE_GRACE_MS = 120;
  const LOC_HISTORY = 4;

  /** @type {HTMLElement|null} */
  let openFlyout = null;
  /** @type {{x:number,y:number}|null} */
  let bridgeApex = null;
  /** @type {{x:number,y:number}[]} */
  const mouseLocs = [];
  /** @type {ReturnType<typeof setTimeout>|null} */
  let closeTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let siblingTimer = null;
  /** @type {HTMLElement|null} */
  let pendingSibling = null;
  let docTracking = false;

  const flyouts = Array.from(menu.querySelectorAll(FLYOUT_SEL));

  const pushMouse = (x, y) => {
    mouseLocs.push({ x, y });
    if (mouseLocs.length > LOC_HISTORY) mouseLocs.shift();
  };

  const clearCloseTimer = () => {
    if (closeTimer != null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  const clearSiblingTimer = () => {
    if (siblingTimer != null) {
      clearTimeout(siblingTimer);
      siblingTimer = null;
    }
    pendingSibling = null;
  };

  const stopDocTracking = () => {
    if (!docTracking) return;
    document.removeEventListener('pointermove', onDocPointerMove, true);
    docTracking = false;
  };

  const startDocTracking = () => {
    if (docTracking) return;
    document.addEventListener('pointermove', onDocPointerMove, true);
    docTracking = true;
  };

  const setOpen = (flyout) => {
    clearCloseTimer();
    clearSiblingTimer();
    if (!flyout) stopDocTracking();
    if (openFlyout === flyout) {
      if (flyout) flyout.classList.add('is-open');
      return;
    }
    for (const f of flyouts) {
      f.classList.toggle('is-open', f === flyout);
      const trigger = f.querySelector('.spaceholder-weapon-interact-menu__flyout-trigger');
      if (trigger) trigger.setAttribute('aria-expanded', f === flyout ? 'true' : 'false');
    }
    openFlyout = flyout;
    if (flyout) {
      const loc = mouseLocs[mouseLocs.length - 1];
      bridgeApex = loc ? { ...loc } : null;
    } else {
      bridgeApex = null;
    }
  };

  /**
   * Safe corridor from apex (exit point on parent) to the near edge of the submenu.
   * @param {{x:number,y:number}} loc
   */
  const isInExpectationTriangle = (loc) => {
    if (!openFlyout || !loc) return false;
    const sub = openFlyout.querySelector(SUB_SEL);
    if (!sub) return false;
    // Must be open for a real rect; force layout if needed.
    if (!openFlyout.classList.contains('is-open')) return false;
    const rect = sub.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const apex = bridgeApex ?? mouseLocs[0] ?? loc;
    // Near edge of submenu (opens to the right). Pad vertically so the corridor is forgiving.
    const padY = 8;
    const top = { x: rect.left, y: rect.top - padY };
    const bottom = { x: rect.left, y: rect.bottom + padY };
    // Also accept being over the submenu rect itself.
    if (
      loc.x >= rect.left
      && loc.x <= rect.right
      && loc.y >= rect.top
      && loc.y <= rect.bottom
    ) {
      return true;
    }
    return _pointInTriangle(loc, apex, top, bottom);
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      const loc = mouseLocs[mouseLocs.length - 1];
      if (loc && isInExpectationTriangle(loc)) {
        // Still aiming at the panel — keep open and keep tracking.
        startDocTracking();
        return;
      }
      // Pointer may be over the menu again (missed events).
      const el = loc ? document.elementFromPoint(loc.x, loc.y) : null;
      if (el && menu.contains(el)) {
        stopDocTracking();
        return;
      }
      setOpen(null);
    }, CLOSE_GRACE_MS);
  };

  const activate = (flyout) => {
    if (!flyout) {
      setOpen(null);
      return;
    }
    stopDocTracking();
    clearCloseTimer();
    if (flyout === openFlyout) {
      clearSiblingTimer();
      const loc = mouseLocs[mouseLocs.length - 1];
      if (loc) bridgeApex = { ...loc };
      return;
    }
    // Mild sibling delay only while clearly aiming at the current submenu.
    const loc = mouseLocs[mouseLocs.length - 1];
    if (openFlyout && loc && isInExpectationTriangle(loc)) {
      pendingSibling = flyout;
      if (siblingTimer != null) clearTimeout(siblingTimer);
      siblingTimer = setTimeout(() => {
        siblingTimer = null;
        const next = pendingSibling;
        pendingSibling = null;
        if (next) setOpen(next);
      }, 280);
      return;
    }
    setOpen(flyout);
  };

  const onMenuPointerMove = (ev) => {
    pushMouse(ev.clientX, ev.clientY);
    if (pendingSibling) {
      const loc = { x: ev.clientX, y: ev.clientY };
      if (!isInExpectationTriangle(loc)) {
        const next = pendingSibling;
        clearSiblingTimer();
        setOpen(next);
      }
    }
  };

  const onDocPointerMove = (ev) => {
    pushMouse(ev.clientX, ev.clientY);
    const loc = { x: ev.clientX, y: ev.clientY };
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (el && menu.contains(el)) {
      // Re-entered menu DOM (trigger or submenu).
      clearCloseTimer();
      stopDocTracking();
      if (openFlyout) {
        const flyout = el.closest?.(FLYOUT_SEL);
        if (flyout === openFlyout) bridgeApex = { ...loc };
      }
      return;
    }
    if (isInExpectationTriangle(loc)) {
      clearCloseTimer();
      return;
    }
    // Left the safe corridor — close.
    setOpen(null);
  };

  const onFlyoutEnter = (ev) => {
    const flyout = ev.currentTarget;
    if (!(flyout instanceof HTMLElement)) return;
    activate(flyout);
  };

  const onMenuLeave = (ev) => {
    const related = ev.relatedTarget;
    if (related && menu.contains(related)) return;
    // Leaving into empty space: keep submenu if aiming at it.
    const loc = mouseLocs[mouseLocs.length - 1];
    if (openFlyout) {
      if (loc) bridgeApex = bridgeApex ?? { ...loc };
      startDocTracking();
      if (loc && isInExpectationTriangle(loc)) {
        clearCloseTimer();
        return;
      }
      scheduleClose();
      return;
    }
    setOpen(null);
  };

  for (const flyout of flyouts) {
    const trigger = flyout.querySelector('.spaceholder-weapon-interact-menu__flyout-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    flyout.addEventListener('pointerenter', onFlyoutEnter);
  }
  menu.addEventListener('pointermove', onMenuPointerMove);
  menu.addEventListener('pointerleave', onMenuLeave);

  return () => {
    clearCloseTimer();
    clearSiblingTimer();
    stopDocTracking();
    menu.removeEventListener('pointermove', onMenuPointerMove);
    menu.removeEventListener('pointerleave', onMenuLeave);
    for (const flyout of flyouts) {
      flyout.removeEventListener('pointerenter', onFlyoutEnter);
      flyout.classList.remove('is-open');
    }
    openFlyout = null;
    bridgeApex = null;
  };
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

function _weaponLineCount(item) {
  if (!item?.system?.itemTags?.isWeapon) return 0;
  return (getWeaponData(item).lines ?? []).length;
}

function _formatChargeFillLabel(preview) {
  if (!preview) return '';
  if (preview.max > 0) return `${preview.current}/${preview.max}`;
  if (preview.current > 0) return `×${preview.current}`;
  return '';
}

function _renderChargeCandidateRow(candidate) {
  const item = candidate.item;
  const preview = getAmmoItemChargePreview(item);
  const fill = _formatChargeFillLabel(preview);
  const groupLabel = String(candidate.group ?? '').trim();
  const loadedText = preview.loadedLabel
    ? String(preview.loadedLabel).trim()
    : (preview.isMagazine && preview.isEmpty
      ? _t('SPACEHOLDER.WeaponV3.Interact.EmptyMagazine')
      : '');
  const infoParts = [groupLabel, loadedText].filter(Boolean);
  const info = infoParts.join(' · ');
  const infoIsEmpty = !preview.loadedLabel && preview.isMagazine && preview.isEmpty;
  const percent = Math.round((preview.percent || 0) * 100);
  const showBar = preview.max > 0 || preview.isMagazine;
  return `
    <button type="button" class="spaceholder-weapon-interact-menu__action spaceholder-weapon-interact-menu__charge-item" data-charge-item-id="${_escapeHTML(item.id)}" role="menuitem">
      <span class="spaceholder-weapon-interact-menu__charge-name">${_escapeHTML(item.name)}</span>
      ${info ? `<span class="spaceholder-weapon-interact-menu__charge-info${infoIsEmpty ? ' is-empty' : ''}">${_escapeHTML(info)}</span>` : ''}
      ${showBar || fill ? `
        <span class="spaceholder-weapon-interact-menu__charge-fill-row">
          ${showBar ? `
            <span class="spaceholder-weapon-interact-menu__charge-bar" aria-hidden="true">
              <span class="spaceholder-weapon-interact-menu__charge-bar-fill" style="width:${percent}%"></span>
            </span>
          ` : '<span class="spaceholder-weapon-interact-menu__charge-bar-spacer"></span>'}
          ${fill ? `<span class="spaceholder-weapon-interact-menu__charge-count">${_escapeHTML(fill)}</span>` : ''}
        </span>
      ` : ''}
    </button>
  `;
}

function _renderLoadTargetRow(target, index) {
  let label = '';
  if (target.targetKind === 'magazine' && target.magazineItem) {
    const magName = target.magazineItem.name ?? '';
    const free = Math.max(0, Number(target.free) || 0);
    label = free > 0
      ? `${magName} (${free})`
      : magName;
  } else {
    const weaponName = target.weaponItem?.name ?? '';
    const lineName = String(target.line?.name ?? '').trim();
    const showLine = _weaponLineCount(target.weaponItem) > 1 && lineName;
    label = showLine ? `${weaponName} · ${lineName}` : weaponName;
  }
  return `
    <button type="button" class="spaceholder-weapon-interact-menu__action spaceholder-weapon-interact-menu__charge-item" data-load-target-index="${index}" role="menuitem">
      <span class="spaceholder-weapon-interact-menu__label">${_escapeHTML(label)}</span>
    </button>
  `;
}

function _renderBoltTargetRow(target, index, apShort) {
  const can = !!target?.can;
  return `
    <button type="button" class="spaceholder-weapon-interact-menu__action" data-bolt-target-index="${index}" role="menuitem" ${can ? '' : 'disabled'}>
      <span class="spaceholder-weapon-interact-menu__label">${_escapeHTML(target.label)}</span>
      <span class="spaceholder-weapon-interact-menu__ap">${Math.max(0, Number(target.apCost) || 0)} ${_escapeHTML(apShort)}</span>
    </button>
  `;
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
  const lineCount = _weaponLineCount(weaponItem);
  const singleLineName = lineCount === 1
    ? String(getWeaponData(weaponItem).lines?.[0]?.name || _t('SPACEHOLDER.WeaponV3.Line.Default')).trim()
    : '';
  const groups = _groupWeaponInteractActions(visible).map((group) => ({
    ...group,
    name: (singleLineName && group.name === singleLineName) ? '' : group.name,
  }));

  const menu = document.createElement('nav');
  menu.id = 'spaceholder-weapon-interact-menu';
  menu.className = 'spaceholder-weapon-interact-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <div class="spaceholder-weapon-interact-menu__title">${_escapeHTML(weaponItem.name)}</div>
    ${groups.map((group) => `
      <section class="spaceholder-weapon-interact-menu__group">
        ${group.name ? `<div class="spaceholder-weapon-interact-menu__group-title">${_escapeHTML(group.name)}</div>` : ''}
        ${group.actions.map((action) => {
          const hasSub = Array.isArray(action.submenuItems) && action.submenuItems.length > 0;
          if (hasSub) {
            const isLoadInto = action.submenuKind === 'loadInto';
            const isBolt = action.submenuKind === 'bolt';
            return `
              <div class="spaceholder-weapon-interact-menu__flyout" data-has-submenu="1">
                <button type="button" class="spaceholder-weapon-interact-menu__action spaceholder-weapon-interact-menu__flyout-trigger" data-action-id="${_escapeHTML(action.id)}" role="menuitem" aria-haspopup="true" ${typeof action.enabled === 'function' && !action.enabled(ctx) ? 'disabled' : ''}>
                  <span class="spaceholder-weapon-interact-menu__label">${_escapeHTML(action.menuLabel || action.label)}</span>
                  <span class="spaceholder-weapon-interact-menu__flyout-caret"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></span>
                </button>
                <div class="spaceholder-weapon-interact-menu__submenu" role="menu">
                  ${isLoadInto
                    ? action.submenuItems.map((target, index) => _renderLoadTargetRow(target, index)).join('')
                    : isBolt
                      ? action.submenuItems.map((target, index) => _renderBoltTargetRow(target, index, apShort)).join('')
                      : action.submenuItems.map((candidate) => _renderChargeCandidateRow(candidate)).join('')}
                </div>
              </div>
            `;
          }
          return `
            <button type="button" class="spaceholder-weapon-interact-menu__action" data-action-id="${_escapeHTML(action.id)}" role="menuitem" ${typeof action.enabled === 'function' && !action.enabled(ctx) ? 'disabled' : ''}>
              <span class="spaceholder-weapon-interact-menu__label">${_escapeHTML(action.menuLabel || action.label)}</span>
              <span class="spaceholder-weapon-interact-menu__ap">${Math.max(0, Number(action.apCost) || 0)} ${_escapeHTML(apShort)}</span>
            </button>
          `;
        }).join('')}
      </section>
    `).join('')}
  `;

  document.body.appendChild(menu);
  _weaponInteractMenuEl = menu;
  _positionWeaponInteractMenu(menu, ctx);
  const disposeFlyoutAim = _bindWeaponInteractFlyoutAim(menu);

  return new Promise((resolve) => {
    const finish = (value) => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      try { disposeFlyoutAim?.(); } catch (_) { /* ignore */ }
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
      const chargeBtn = ev.target?.closest?.('[data-charge-item-id]');
      const loadBtn = ev.target?.closest?.('[data-load-target-index]');
      const boltBtn = ev.target?.closest?.('[data-bolt-target-index]');
      const flyoutTrigger = ev.target?.closest?.('.spaceholder-weapon-interact-menu__flyout-trigger');
      if (flyoutTrigger && !chargeBtn && !loadBtn && !boltBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const flyout = flyoutTrigger.closest('.spaceholder-weapon-interact-menu__flyout');
        if (flyout) {
          for (const f of menu.querySelectorAll('.spaceholder-weapon-interact-menu__flyout')) {
            const open = f === flyout;
            f.classList.toggle('is-open', open);
            const t = f.querySelector('.spaceholder-weapon-interact-menu__flyout-trigger');
            if (t) t.setAttribute('aria-expanded', open ? 'true' : 'false');
          }
        }
        return;
      }

      const btn = chargeBtn || loadBtn || boltBtn || ev.target?.closest?.('[data-action-id]');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();

      let action = null;
      let runCtx = ctx;
      if (chargeBtn) {
        const flyout = chargeBtn.closest('.spaceholder-weapon-interact-menu__flyout');
        const parentId = flyout?.querySelector?.('[data-action-id]')?.dataset?.actionId;
        action = visible.find((a) => a.id === parentId);
        const itemId = chargeBtn.dataset.chargeItemId;
        const candidate = action?.submenuItems?.find((c) => String(c.item?.id) === String(itemId));
        if (!action || !candidate) return;
        runCtx = { ...ctx, chargeCandidate: candidate };
      } else if (loadBtn) {
        const flyout = loadBtn.closest('.spaceholder-weapon-interact-menu__flyout');
        const parentId = flyout?.querySelector?.('[data-action-id]')?.dataset?.actionId;
        action = visible.find((a) => a.id === parentId);
        const idx = Number(loadBtn.dataset.loadTargetIndex);
        const target = action?.submenuItems?.[idx];
        if (!action || !target) return;
        runCtx = { ...ctx, loadTarget: target };
      } else if (boltBtn) {
        const flyout = boltBtn.closest('.spaceholder-weapon-interact-menu__flyout');
        const parentId = flyout?.querySelector?.('[data-action-id]')?.dataset?.actionId;
        const parent = visible.find((a) => a.id === parentId);
        const idx = Number(boltBtn.dataset.boltTargetIndex);
        const target = parent?.submenuItems?.[idx];
        if (!parent || !target?.can) return;
        action = {
          ...parent,
          apCost: Math.max(0, Number(target.apCost) || 0),
          label: `${parent.label}: ${target.label}`,
        };
        runCtx = { ...ctx, boltTarget: target };
      } else {
        action = visible.find((a) => a.id === btn.dataset.actionId);
        if (!action) return;
        if (Array.isArray(action.submenuItems) && action.submenuItems.length) return;
      }

      _weaponInteractMenuCleanup = null;
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      try { disposeFlyoutAim?.(); } catch (_) { /* ignore */ }
      try { menu.remove(); } catch (_) { /* ignore */ }
      if (_weaponInteractMenuEl === menu) _weaponInteractMenuEl = null;
      const result = await executeActorAction(actor, action, runCtx);
      resolve(!!result);
    });

    setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
    }, 0);
  });
}

function _collectAmmoChargeIntoActions(actor, item, ctx) {
  if (!item?.system?.itemTags?.isAmmo) return [];
  const weaponTargets = findCompatibleWeaponLoadTargets(actor, item).map((t) => ({
    ...t,
    targetKind: 'weapon',
  }));
  const magTargets = findCompatibleMagazineLoadTargets(actor, item).map((t) => ({
    magazineItem: t.magazineItem,
    free: t.free,
    targetKind: 'magazine',
  }));
  const targets = [...weaponTargets, ...magTargets];
  if (!targets.length) return [];
  const isMag = !!item.system?.weapon?.ammo?.connector?.enabled;
  return [{
    id: `item.${item.uuid}.chargeInto`,
    source: 'item',
    sourceItemName: item.name,
    label: _t('SPACEHOLDER.WeaponV3.Interact.ChargeInto'),
    menuGroup: _t(ITEM_STANDARD_GROUP_KEY),
    menuLabel: _t('SPACEHOLDER.WeaponV3.Interact.ChargeIntoShort'),
    icon: 'fa-solid fa-gun',
    apCost: 0,
    description: '',
    showInCombat: false,
    showInQuickbar: false,
    interactMenuOnly: true,
    weaponInteract: true,
    submenuKind: 'loadInto',
    submenuItems: targets,
    visible: () => true,
    enabled: () => !!ctx.editable,
    disabledReason: () => (ctx.editable ? null : _t('SPACEHOLDER.ActionsSystem.Common.NotEditable')),
    run: async (runCtx) => {
      const target = runCtx?.loadTarget;
      if (!target) return false;

      if (target.targetKind === 'magazine' && target.magazineItem) {
        const free = Math.max(1, Number(target.free) || 1);
        const qty = Math.min(free, Math.max(1, Number(item.system?.quantity) || 1));
        if (!target.magazineItem.system?.itemTags?.isContainer) {
          await target.magazineItem.update({ 'system.itemTags.isContainer': true }, { render: false });
        }
        const moved = await moveQtyIntoMagazineContainer(actor, target.magazineItem, item, qty);
        if (!moved?.ok) {
          ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed'));
          return false;
        }
        return true;
      }

      if (!target?.weaponItem || !target?.line || !target?.block) return false;
      const w = getWeaponData(target.weaponItem);
      const b = getAmmoBlock(w, target.line.id, target.block.id);
      if (!b) return false;
      let res;
      if (isMag || target.mode === 'magazine') {
        res = await attachMagazine({ actor, weaponItem: target.weaponItem, block: b, magazineItem: item });
      } else {
        res = await loadBlock({ actor, weaponItem: target.weaponItem, block: b, count: Infinity, ammoItem: item });
      }
      if (!res?.ok) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed'));
        return false;
      }
      await persistWeaponData(target.weaponItem, w);
      return true;
    },
  }];
}

function _collectItemInteractActions(actor, item, ctx) {
  const interactActions = [];
  interactActions.push(..._collectWearableToggleActions(actor, ctx).filter((a) => _actionBelongsToItem(a, item)));
  interactActions.push(..._collectCustomActions(actor, ctx).filter((a) => _actionBelongsToItem(a, item)));
  interactActions.push(..._collectAmmoChargeIntoActions(actor, item, ctx));
  interactActions.push(..._collectMagazineUnloadActions(actor, item, ctx));

  if (item?.system?.itemTags?.isWeapon) {
    const weapon = getWeaponData(item);
    let blockCount = 0;
    for (const line of weapon.lines ?? []) {
      blockCount += (line.ammoBlocks ?? []).length;
    }
    for (const line of weapon.lines ?? []) {
      for (const block of line.ammoBlocks ?? []) {
        interactActions.push(..._buildWeaponBlockActions(actor, item, line, block, { blockCount }));
      }
    }
    interactActions.push(..._buildWeaponBoltActions(actor, item));
    interactActions.push(..._buildWeaponEmptyAction(actor, item));
    interactActions.push(..._buildWeaponDetachSubmenu(actor, item));
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
 * Unload live rounds from a magazine item (ammo + connector) back to inventory root.
 * @returns {ActionDescriptor[]}
 */
function _collectMagazineUnloadActions(actor, item, ctx) {
  if (!item?.system?.itemTags?.isAmmo) return [];
  if (!item.system?.weapon?.ammo?.connector?.enabled) return [];
  const childIds = getOrderedDirectChildItemIds(actor, item.id);
  if (!childIds.length) return [];
  const ammoGroup = _t('SPACEHOLDER.WeaponV3.Interact.AmmoGroup');
  return [{
    id: `item.${item.uuid}.unloadRounds`,
    source: 'item',
    sourceItemName: item.name,
    label: _t('SPACEHOLDER.WeaponV3.Interact.UnloadRounds'),
    menuGroup: ammoGroup,
    menuLabel: _t('SPACEHOLDER.WeaponV3.Interact.UnloadRoundsShort'),
    icon: 'fa-solid fa-box-open',
    apCost: 0,
    description: '',
    showInCombat: false,
    showInQuickbar: false,
    interactMenuOnly: true,
    weaponInteract: true,
    visible: () => getOrderedDirectChildItemIds(actor, item.id).length > 0,
    enabled: () => !!ctx.editable && getOrderedDirectChildItemIds(actor, item.id).length > 0,
    disabledReason: () => (ctx.editable ? null : _t('SPACEHOLDER.ActionsSystem.Common.NotEditable')),
    run: async () => {
      const ids = getOrderedDirectChildItemIds(actor, item.id);
      if (!ids.length) return false;
      let any = false;
      for (const id of ids) {
        const ok = await removeActorItemFromContainer(actor, item, id);
        if (!ok) continue;
        const child = actor.items.get(id);
        if (child) {
          try {
            await child.update({ 'system.held': true }, { render: false });
          } catch (_) { /* ignore */ }
        }
        any = true;
      }
      if (!any) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed'));
        return false;
      }
      return true;
    },
  }];
}

/**
 * Menu group / label prefix for one ammo block.
 * @param {object} line
 * @param {object} block
 * @param {{blockCount?: number}} [opts]
 * @returns {string}
 */
function _blockMenuPrefix(line, block, opts = {}) {
  const lineName = String(line?.name || _t('SPACEHOLDER.WeaponV3.Line.Default')).trim();
  const blockCount = Math.max(0, Number(opts.blockCount) || 0);
  if (blockCount <= 1) return lineName;
  const label = _blockLabel(block);
  return label ? `${lineName} · ${label}` : lineName;
}

/**
 * Short disambiguator for an ammo block (connector / caliber / localized type).
 * @param {object} block
 * @returns {string}
 */
function _blockLabel(block) {
  if (!block) return '';
  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    const connector = String(block.connector ?? '').trim();
    if (connector) return connector;
    return _t('SPACEHOLDER.WeaponV3.Block.Types.externalMagazine');
  }
  const caliber = String(block.caliber ?? '').trim();
  if (caliber) return caliber;
  const typeKey = `SPACEHOLDER.WeaponV3.Block.Types.${block.type}`;
  const typed = _t(typeKey);
  return typed && typed !== typeKey ? typed : String(block.type ?? '').trim();
}

/**
 * Weapon-level flyout: detach attached magazines / batteries / charge units.
 * @returns {ActionDescriptor[]}
 */
function _buildWeaponDetachSubmenu(actor, item) {
  const out = [];
  if (!item?.system?.itemTags?.isWeapon) return out;

  const collect = () => {
    const next = [];
    const w = getWeaponData(item);
    for (const line of w.lines ?? []) {
      for (const block of line.ammoBlocks ?? []) {
        if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
          if (!canDetachMagazine(block)) continue;
          const mag = getAttachedMagazineItem(actor, block);
          if (!mag) continue;
          next.push({
            item: mag,
            line,
            block,
            mode: 'detachMagazine',
            group: _blockMenuPrefix(line, block, { blockCount: 2 }),
          });
          continue;
        }
        if (block.type !== AMMO_BLOCK_TYPES.EXTERNAL_CHARGE) continue;
        const chamber = getChamberItem(actor, block);
        if (chamber) {
          next.push({
            item: chamber,
            line,
            block,
            mode: 'detachChargeUnit',
            slot: 'chamber',
            group: _blockMenuPrefix(line, block, { blockCount: 2 }),
          });
        }
        for (const unit of getBlockContentItems(actor, block)) {
          next.push({
            item: unit,
            line,
            block,
            mode: 'detachChargeUnit',
            slot: 'content',
            group: _blockMenuPrefix(line, block, { blockCount: 2 }),
          });
        }
      }
    }
    return next;
  };

  const submenuItems = collect();
  if (!submenuItems.length) return out;
  const ammoGroup = _t('SPACEHOLDER.WeaponV3.Interact.AmmoGroup');
  out.push({
    id: `item.${item.uuid}.detachMenu`,
    source: 'item',
    sourceItemName: item.name,
    label: _t('SPACEHOLDER.WeaponV3.Interact.DetachMenu'),
    menuGroup: ammoGroup,
    menuLabel: _t('SPACEHOLDER.WeaponV3.Interact.DetachMenuShort'),
    icon: 'fa-solid fa-box-open',
    apCost: 0,
    description: ammoGroup,
    showInCombat: true,
    showInQuickbar: false,
    weaponInteract: true,
    submenuKind: 'charge',
    submenuItems,
    visible: () => collect().length > 0,
    enabled: () => collect().length > 0,
    run: async (runCtx) => {
      const candidate = runCtx?.chargeCandidate;
      const line = candidate?.line;
      const blockRef = candidate?.block;
      const unit = candidate?.item;
      if (!line || !blockRef) return false;
      const w = getWeaponData(item);
      const b = getAmmoBlock(w, line.id, blockRef.id);
      if (!b) return false;

      if (candidate.mode === 'detachMagazine') {
        const res = await detachMagazine({ actor, weaponItem: item, block: b });
        if (!res?.ok) {
          ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed'));
          return false;
        }
        await persistWeaponData(item, w);
        return true;
      }

      if (candidate.mode === 'detachChargeUnit' && unit) {
        const rt = b.runtime ?? {};
        if (String(rt.chamberItemId ?? '') === unit.id) rt.chamberItemId = '';
        if (Array.isArray(rt.contentItemIds)) {
          rt.contentItemIds = rt.contentItemIds.filter((id) => String(id) !== unit.id);
        }
        await unparentActorItemFromHost(actor, unit.id, { held: true });
        await persistWeaponData(item, w);
        return true;
      }

      return false;
    },
  });
  return out;
}

/**
 * Weapon-level bolt: single «Затвор» or flyout «Затвор…» when several chamber blocks.
 * @returns {ActionDescriptor[]}
 */
function _buildWeaponBoltActions(actor, item) {
  const out = [];
  if (!item?.system?.itemTags?.isWeapon) return out;

  const collect = () => {
    const w = getWeaponData(item);
    let blockCount = 0;
    for (const line of w.lines ?? []) blockCount += (line.ammoBlocks ?? []).length;
    const targets = [];
    for (const line of w.lines ?? []) {
      for (const block of line.ammoBlocks ?? []) {
        if (!block?.chamberEnabled || !block.apActions?.bolt?.enabled) continue;
        targets.push({
          lineId: line.id,
          blockId: block.id,
          line,
          block,
          label: _blockMenuPrefix(line, block, { blockCount }),
          apCost: Math.max(0, Number(block.apActions.bolt.value) || 0),
          can: canBoltBlock(block, actor),
        });
      }
    }
    return targets;
  };

  const targets = collect();
  if (!targets.length) return out;
  const ammoGroup = _t('SPACEHOLDER.WeaponV3.Interact.AmmoGroup');

  if (targets.length === 1) {
    const only = targets[0];
    out.push({
      id: `item.${item.uuid}.weaponBolt`,
      source: 'item',
      sourceItemName: item.name,
      label: _t('SPACEHOLDER.WeaponV3.BlockActions.Bolt'),
      menuGroup: ammoGroup,
      menuLabel: _t('SPACEHOLDER.WeaponV3.BlockActions.Bolt'),
      icon: 'fa-solid fa-rotate',
      apCost: only.apCost,
      description: ammoGroup,
      showInCombat: true,
      showInQuickbar: false,
      weaponInteract: true,
      visible: () => true,
      enabled: () => canBoltBlock(
        getAmmoBlock(getWeaponData(item), only.lineId, only.blockId) ?? only.block,
        actor,
      ),
      run: async () => {
        const w = getWeaponData(item);
        const b = getAmmoBlock(w, only.lineId, only.blockId);
        if (!b) return false;
        const res = await operateBolt({ actor, weaponItem: item, block: b });
        if (!res?.ok) {
          ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed'));
          return false;
        }
        await persistWeaponData(item, w);
        return true;
      },
    });
    return out;
  }

  out.push({
    id: `item.${item.uuid}.weaponBoltMenu`,
    source: 'item',
    sourceItemName: item.name,
    label: _t('SPACEHOLDER.WeaponV3.Interact.BoltMenu'),
    menuGroup: ammoGroup,
    menuLabel: _t('SPACEHOLDER.WeaponV3.Interact.BoltMenuShort'),
    icon: 'fa-solid fa-rotate',
    apCost: 0,
    description: ammoGroup,
    showInCombat: true,
    showInQuickbar: false,
    weaponInteract: true,
    submenuKind: 'bolt',
    submenuItems: targets,
    visible: () => collect().length > 1,
    enabled: () => collect().some((t) => t.can),
    run: async (runCtx) => {
      const target = runCtx?.boltTarget;
      const lineId = target?.lineId ?? target?.line?.id;
      const blockId = target?.blockId ?? target?.block?.id;
      if (!lineId || !blockId) return false;
      const w = getWeaponData(item);
      const b = getAmmoBlock(w, lineId, blockId);
      if (!b) return false;
      const res = await operateBolt({ actor, weaponItem: item, block: b });
      if (!res?.ok) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed'));
        return false;
      }
      await persistWeaponData(item, w);
      return true;
    },
  });
  return out;
}

/**
 * Weapon-level «Опустошить»: empty every ammo block that supports it.
 * @returns {ActionDescriptor[]}
 */
function _buildWeaponEmptyAction(actor, item) {
  const out = [];
  if (!item?.system?.itemTags?.isWeapon) return out;

  const listEmptyable = () => {
    const w = getWeaponData(item);
    const rows = [];
    for (const line of w.lines ?? []) {
      for (const block of line.ammoBlocks ?? []) {
        if (!block?.apActions?.empty?.enabled) continue;
        rows.push({
          lineId: line.id,
          blockId: block.id,
          block,
          apCost: Math.max(0, Number(block.apActions.empty.value) || 0),
          can: canEmptyBlock(block, actor),
        });
      }
    }
    return rows;
  };

  const rows = listEmptyable();
  if (!rows.length) return out;
  const ammoGroup = _t('SPACEHOLDER.WeaponV3.Interact.AmmoGroup');
  const apCost = rows.reduce((sum, row) => (row.can ? sum + row.apCost : sum), 0);

  out.push({
    id: `item.${item.uuid}.weaponEmpty`,
    source: 'item',
    sourceItemName: item.name,
    label: _t('SPACEHOLDER.WeaponV3.BlockActions.Empty'),
    menuGroup: ammoGroup,
    menuLabel: _t('SPACEHOLDER.WeaponV3.BlockActions.Empty'),
    icon: 'fa-solid fa-box-open',
    apCost,
    description: ammoGroup,
    showInCombat: true,
    showInQuickbar: false,
    weaponInteract: true,
    visible: () => listEmptyable().length > 0,
    enabled: () => listEmptyable().some((row) => row.can),
    run: async () => {
      const w = getWeaponData(item);
      let any = false;
      for (const line of w.lines ?? []) {
        for (const block of line.ammoBlocks ?? []) {
          if (!block?.apActions?.empty?.enabled) continue;
          if (!canEmptyBlock(block, actor)) continue;
          const res = await emptyBlock({ actor, weaponItem: item, block });
          if (res?.ok) any = true;
        }
      }
      if (!any) {
        ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed'));
        return false;
      }
      await persistWeaponData(item, w);
      return true;
    },
  });
  return out;
}

/**
 * Build atomic ammo-block action descriptors for one weapon block.
 * @param {Actor} actor
 * @param {Item} item
 * @param {object} line
 * @param {object} block
 * @param {{blockCount?: number}} [opts]
 * @returns {ActionDescriptor[]}
 */
function _buildWeaponBlockActions(actor, item, line, block, opts = {}) {
  const out = [];
  const prefix = _blockMenuPrefix(line, block, opts);

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
      enabled: () => canFn(),
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
      const res = await loadBlock({ actor, weaponItem: item, block: b, count: 1 });
      if (!res?.ok) { ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed')); return false; }
      await persistWeaponData(item, w);
      return true;
    },
  });

  const loadXAmount = Math.max(0, Number(block.loadAmount) || 0);
  // Avoid duplicate "Зарядить 1" when loadOne already covers a single round.
  const showLoadX = block.apActions?.loadX?.enabled
    && loadXAmount > 0
    && !(block.apActions?.loadOne?.enabled && loadXAmount === 1);
  if (showLoadX) {
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
        const res = await loadBlock({ actor, weaponItem: item, block: b, count: loadXAmount });
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
      const res = await reloadBlock({ actor, weaponItem: item, block: b });
      if (!res?.ok) { ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed')); return false; }
      await persistWeaponData(item, w);
      return true;
    },
  });

  // Unload / Empty / Bolt are weapon-level (Detach… / Empty / Bolt or Bolt…).

  if (block.type === AMMO_BLOCK_TYPES.EXTERNAL_MAGAZINE) {
    const chargeCandidates = findChargeCandidatesForBlock(actor, block);
    if (chargeCandidates.length) {
      const apCost = block.apActions?.reload?.enabled ? Math.max(0, block.apActions.reload.value) : 0;
      out.push({
        id: `item.${item.uuid}.weaponBlock.${line.id}.${block.id}.charge`,
        source: 'item',
        sourceItemName: item.name,
        label: `${prefix}: ${_t('SPACEHOLDER.WeaponV3.Interact.Charge')}`,
        menuGroup: prefix,
        menuLabel: _t('SPACEHOLDER.WeaponV3.Interact.ChargeShort'),
        icon: 'fa-solid fa-box',
        apCost,
        description: prefix,
        showInCombat: true,
        showInQuickbar: false,
        weaponInteract: true,
        submenuKind: 'charge',
        submenuItems: chargeCandidates,
        visible: () => findChargeCandidatesForBlock(actor, block).length > 0,
        enabled: () => findChargeCandidatesForBlock(actor, block).length > 0,
        run: async (runCtx) => {
          const candidate = runCtx?.chargeCandidate;
          const magItem = candidate?.item;
          if (!magItem) return false;
          const w = getWeaponData(item);
          const b = getAmmoBlock(w, line.id, block.id);
          if (!b) return false;
          const res = await attachMagazine({ actor, weaponItem: item, block: b, magazineItem: magItem });
          if (!res?.ok) { ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed')); return false; }
          await persistWeaponData(item, w);
          return true;
        },
      });
    }
  } else if (block.type !== AMMO_BLOCK_TYPES.INTERNAL_CHARGE) {
    const chargeCandidates = findChargeCandidatesForBlock(actor, block);
    if (chargeCandidates.length) {
      const apCost = block.apActions?.loadOne?.enabled
        ? Math.max(0, block.apActions.loadOne.value)
        : (block.apActions?.reload?.enabled ? Math.max(0, block.apActions.reload.value) : 0);
      out.push({
        id: `item.${item.uuid}.weaponBlock.${line.id}.${block.id}.charge`,
        source: 'item',
        sourceItemName: item.name,
        label: `${prefix}: ${_t('SPACEHOLDER.WeaponV3.Interact.Charge')}`,
        menuGroup: prefix,
        menuLabel: _t('SPACEHOLDER.WeaponV3.Interact.ChargeShort'),
        icon: 'fa-solid fa-box-open',
        apCost,
        description: prefix,
        showInCombat: true,
        showInQuickbar: false,
        weaponInteract: true,
        submenuKind: 'charge',
        submenuItems: chargeCandidates,
        visible: () => findChargeCandidatesForBlock(actor, block).length > 0,
        enabled: () => findChargeCandidatesForBlock(actor, block).length > 0,
        run: async (runCtx) => {
          const candidate = runCtx?.chargeCandidate;
          const ammoItem = candidate?.item;
          if (!ammoItem) return false;
          const w = getWeaponData(item);
          const b = getAmmoBlock(w, line.id, block.id);
          if (!b) return false;
          const res = await loadBlock({ actor, weaponItem: item, block: b, count: Infinity, ammoItem });
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
      skipPostCombatLog: true,
      visible: () => true,
      enabled: () => true,
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
    if (a.interactMenuOnly) return false;
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
 

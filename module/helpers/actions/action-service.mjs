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
 * @property {boolean} [basic] - a simple action every item has (take off, drop…): listed only when favorited
 * @property {boolean} [uiOnly] - UI toggle, not a game action: `executeActorAction` runs it without AP, turn start or logging
 * @property {number} [previewApCost] - AP shown in menus when `run` spends AP itself (descriptor `apCost` stays 0)
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
import { activeCombat, beginCombatAction, logCombatAction } from './combat-action-log.mjs';
import { ABILITY_NORM, applyActionSpeedToCost } from '../derived-stats.mjs';
import { getWeaponLineMode, listWeaponAttacks, resolveActiveWeaponAttack, AMMO_BLOCK_TYPES } from '../weapon/weapon-model.mjs';
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
  syncExternalChargeHostedRuntime,
} from '../weapon/weapon-ammo-runtime.mjs';
import { moveQtyIntoMagazineContainer, unparentActorItemFromHost } from '../item-weapon-host.mjs';
import {
  getOrderedDirectChildItemIds,
  removeActorItemFromContainer,
} from '../item-container.mjs';
import { canAttackWithItem, switchWeaponMode, previewModeSwitchAp } from '../weapon/attack-chain.mjs';
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

/**
 * Token to act with: explicit ctx token, else a controlled token of the actor,
 * else its first active token on the scene.
 * @param {Partial<ActionContext>|null} ctx
 * @param {Actor} actor
 * @returns {Token|null}
 */
export function resolveActionToken(ctx, actor) {
  const direct = ctx?.tokenDoc?.object ?? null;
  if (direct) return direct;
  const controlled = canvas?.tokens?.controlled || [];
  const fromControlled = controlled.find((t) => String(t?.actor?.id || "") === String(actor?.id || ""));
  if (fromControlled) return fromControlled;
  try {
    // Placeable tokens (`document = false`): the aiming UI needs the canvas object, not the document.
    const active = actor?.getActiveTokens?.(false, false) || [];
    const first = active[0] ?? null;
    return first?.object ?? first;
  } catch (_) {
    return null;
  }
}

const SYSTEM_FREE_ACTION_ID = 'system.freeAction';
const ITEM_STANDARD_GROUP_KEY = 'SPACEHOLDER.ActionsSystem.ItemMenu.StandardGroup';
const FAVORITE_ACTION_IDS_FLAG = 'favoriteActionIds';

/**
 * Favorite action ids of the actor, in the order they were added.
 * @param {Actor} actor
 * @returns {string[]}
 */
export function getFavoriteActionIds(actor) {
  const raw = actor?.getFlag?.('spaceholder', FAVORITE_ACTION_IDS_FLAG);
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => String(id ?? '').trim()).filter(Boolean);
}

/**
 * Add the action to favorites or remove it from them.
 * @param {Actor} actor
 * @param {string} actionId
 * @returns {Promise<boolean>} whether the action is a favorite afterwards
 */
export async function toggleFavoriteAction(actor, actionId) {
  const id = String(actionId ?? '').trim();
  const current = getFavoriteActionIds(actor);
  if (!id || !actor) return current.includes(id);
  const isFavorite = current.includes(id);
  const next = isFavorite ? current.filter((x) => x !== id) : [...current, id];
  try {
    await actor.setFlag('spaceholder', FAVORITE_ACTION_IDS_FLAG, next);
    return !isFavorite;
  } catch (e) {
    console.warn('SpaceHolder | failed to persist favorite actions', e);
    ui.notifications?.warn?.(_t('SPACEHOLDER.ActionsSystem.UI.FavoritePersistFailed'));
    return isFavorite;
  }
}

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

      const { combat, combatant } = await beginCombatAction(actor, runCtx.tokenDoc ?? null);

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
        await logCombatAction({
          actor,
          tokenDoc: runCtx.tokenDoc ?? null,
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
  return _num(actor?.system?.abilities?.cor?.value, ABILITY_NORM);
}

/**
 * Raw AP for movement from scene distance: AP per 1 grid-agnostic distance unit × distance, rounded up.
 * `actor.system.speed` = AP spent per 1 unit of distance (not per cell).
 * Для персонажей задаётся в `prepareDerivedData`: `AP_PER_SECOND` / боевая скорость, м/с (от AGI, скорости вида, γ и нагрузки).
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
 * Coordination (action speed) scales positive base costs: cost = base / m, m = 2·COR / (COR + 100).
 * Negative (refund) bases stay as they are; a positive base never drops below 1.
 * Movement is NOT passed through this function: distance cost is final.
 * @param {Actor} actor
 * @param {number} baseCost
 */
export function getEffectiveActionCost(actor, baseCost) {
  return applyActionSpeedToCost(baseCost, _coordinationValue(actor));
}

/**
 * The AP a menu / HUD / sheet shows for an action: what executing it will really cost.
 * A descriptor's `apCost` is the base and goes through the actor's action speed (COR) when the action runs.
 * `previewApCost` (actions whose `run` charges AP itself, e.g. the chain of a mode switch) is already final.
 * @param {Actor|null|undefined} actor
 * @param {ActionDescriptor} action
 * @returns {number}
 */
export function actionApShown(actor, action) {
  if (action?.previewApCost != null) return Math.max(0, Number(action.previewApCost) || 0);
  return Math.max(0, getEffectiveActionCost(actor, Math.floor(_num(action?.apCost, 0))));
}

/** Base AP of a simple item action (`CONFIG.SPACEHOLDER.itemActionAp`). */
function _itemActionAp(key) {
  return Math.max(0, Math.floor(_num(globalThis.CONFIG?.SPACEHOLDER?.itemActionAp?.[key], 0)));
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
        apCost: _itemActionAp('drop'),
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
        apCost: _itemActionAp('show'),
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
        apCost: _itemActionAp('unequip'),
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
          apCost: _itemActionAp('equip'),
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
        apCost: _itemActionAp('stow'),
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
      apCost: _itemActionAp('hold'),
      showInCombat: false,
      showInQuickbar: false,
      visible: () => true,
      enabled: () => !!ctx.editable,
      disabledReason: () => (ctx.editable ? null : _t('SPACEHOLDER.ActionsSystem.Common.NotEditable')),
      run: async () => {
        await item.update({ 'system.equipped': false, 'system.held': true });
      }
    });
    pushCommonItemActions();
  }
  // Take off / put away / hold / drop / show: every item has them, so they stay out of the general
  // lists unless favorited (see `listableActions`). They are offered, with a favorite star, in the
  // inventory preview of the item.
  for (const action of actions) action.basic = true;
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
        if (activeCombat()) return;
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
            if (activeCombat()) return;
            return item.roll?.();
          }
          if (a.mode === "aimShot") {
            const token = resolveActionToken(ctx, actor);
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
          if (activeCombat()) return;
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
 * The sharp corner sits at the left edge of the row that owns the open flyout, not at the pointer:
 * the pointer drifts while the mouse is in motion, which made the corridor lean the wrong way.
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
  };

  /** Corner of the corridor: left edge of the open flyout's row, at its vertical middle. */
  const getApex = () => {
    const row = openFlyout?.querySelector('.spaceholder-weapon-interact-menu__flyout-trigger') ?? openFlyout;
    if (!row) return null;
    const r = row.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.left, y: r.top + r.height / 2 };
  };

  /**
   * Safe corridor from apex (left edge of the hovered row) to the near edge of the submenu.
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
    const apex = getApex();
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
    return !!apex && _pointInTriangle(loc, apex, top, bottom);
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

function _renderBoltTargetRow(target, index, apShort, actor) {
  const can = !!target?.can;
  return `
    <button type="button" class="spaceholder-weapon-interact-menu__action" data-bolt-target-index="${index}" role="menuitem" ${can ? '' : 'disabled'}>
      <span class="spaceholder-weapon-interact-menu__label">${_escapeHTML(target.label)}</span>
      <span class="spaceholder-weapon-interact-menu__ap">${actionApShown(actor, target)} ${_escapeHTML(apShort)}</span>
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
                      ? action.submenuItems.map((target, index) => _renderBoltTargetRow(target, index, apShort, actor)).join('')
                      : action.submenuItems.map((candidate) => _renderChargeCandidateRow(candidate)).join('')}
                </div>
              </div>
            `;
          }
          return `
            <button type="button" class="spaceholder-weapon-interact-menu__action" data-action-id="${_escapeHTML(action.id)}" role="menuitem" ${typeof action.enabled === 'function' && !action.enabled(ctx) ? 'disabled' : ''}>
              <span class="spaceholder-weapon-interact-menu__label">${_escapeHTML(action.menuLabel || action.label)}</span>
              ${action.uiOnly ? '' : `<span class="spaceholder-weapon-interact-menu__ap">${actionApShown(actor, action)} ${_escapeHTML(apShort)}</span>`}
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

/**
 * Weapon fire mode switch rows (line × mode) for the item interact menu.
 * @param {Actor} actor
 * @param {Item} item
 * @returns {ActionDescriptor[]}
 */
function _buildWeaponModeActions(actor, item) {
  const weapon = getWeaponData(item);
  const attacks = listWeaponAttacks(weapon);
  if (attacks.length < 2) return [];
  const active = resolveActiveWeaponAttack(weapon);
  const multiLine = (weapon.lines ?? []).length > 1;
  const group = _t('SPACEHOLDER.WeaponV3.Interact.FireModeGroup');
  return attacks.map(({ lineId, modeId, line, mode }) => {
    const lineName = line.name || _t('SPACEHOLDER.WeaponV3.Line.Default');
    const modeName = mode.name || _t('SPACEHOLDER.WeaponV3.Mode.Default');
    const modeLabel = multiLine ? `${lineName} / ${modeName}` : modeName;
    const isActive = lineId === active.lineId && modeId === active.modeId;
    return {
      id: `item.${item.uuid}.fireMode.${lineId}.${modeId}`,
      source: 'item',
      sourceItemName: item.name,
      label: `${item.name}: ${modeLabel}`,
      menuGroup: group,
      menuLabel: modeLabel,
      icon: 'fa-solid fa-sliders',
      apCost: 0,
      previewApCost: isActive ? 0 : previewModeSwitchAp(item, lineId, modeId),
      showInQuickbar: false,
      interactMenuOnly: true,
      skipPostCombatLog: true,
      visible: () => true,
      enabled: (ctx) => !isActive && !!ctx?.editable,
      run: async () => switchWeaponMode({ actor, weaponItem: item, lineId, modeId }),
    };
  });
}

/**
 * «Quick access» toggle: attack-capable items not in hands still get a HUD card.
 * @param {Item} item
 * @returns {ActionDescriptor[]}
 */
function _buildQuickAccessAction(item) {
  if (!canAttackWithItem(item)) return [];
  const on = !!item.system?.quickAccess;
  return [{
    id: `item.${item.uuid}.quickAccess`,
    source: 'item',
    sourceItemName: item.name,
    label: _t(on ? 'SPACEHOLDER.ActionsSystem.QuickAccess.Remove' : 'SPACEHOLDER.ActionsSystem.QuickAccess.Add', { item: item.name }),
    menuGroup: _t(ITEM_STANDARD_GROUP_KEY),
    menuLabel: _t(on ? 'SPACEHOLDER.ActionsSystem.QuickAccess.RemoveShort' : 'SPACEHOLDER.ActionsSystem.QuickAccess.AddShort'),
    icon: 'fa-solid fa-bolt',
    apCost: 0,
    showInQuickbar: false,
    interactMenuOnly: true,
    uiOnly: true,
    visible: () => true,
    enabled: (ctx) => !!ctx?.editable,
    run: async () => {
      await item.update({ 'system.quickAccess': !on });
      return true;
    },
  }];
}

function _collectItemInteractActions(actor, item, ctx) {
  const interactActions = [];
  interactActions.push(..._collectWearableToggleActions(actor, ctx).filter((a) => _actionBelongsToItem(a, item)));
  interactActions.push(..._buildQuickAccessAction(item));
  interactActions.push(..._collectCustomActions(actor, ctx).filter((a) => _actionBelongsToItem(a, item)));
  interactActions.push(..._collectAmmoChargeIntoActions(actor, item, ctx));
  interactActions.push(..._collectMagazineUnloadActions(actor, item, ctx));
  interactActions.push(..._buildAttachedItemDetachAction(actor, item, ctx));

  if (item?.system?.itemTags?.isWeapon) {
    interactActions.push(..._buildWeaponModeActions(actor, item));
    interactActions.push(..._collectWeaponAmmoActions(actor, item));
  }

  return interactActions;
}

/**
 * Atomic ammo actions of a weapon: per-block load/reload/charge, bolt, empty, detach.
 * @param {Actor} actor
 * @param {Item} item
 * @returns {ActionDescriptor[]}
 */
function _collectWeaponAmmoActions(actor, item) {
  const out = [];
  const weapon = getWeaponData(item);
  let blockCount = 0;
  for (const line of weapon.lines ?? []) {
    blockCount += (line.ammoBlocks ?? []).length;
  }
  for (const line of weapon.lines ?? []) {
    for (const block of line.ammoBlocks ?? []) {
      out.push(..._buildWeaponBlockActions(actor, item, line, block, { blockCount }));
    }
  }
  out.push(..._buildWeaponBoltActions(actor, item));
  out.push(..._buildWeaponEmptyAction(actor, item));
  out.push(..._buildWeaponDetachSubmenu(actor, item));
  return out;
}

/**
 * Weapon actions worth a one-click HUD button: atomic ammo actions of the
 * active line (reload, load N) and a single-chamber bolt, only while they are
 * actionable. Submenu actions (load…, detach…, empty) stay in the item menu.
 * @param {Actor} actor
 * @param {Item} item
 * @param {ActionContext} ctx
 * @returns {ActionDescriptor[]}
 */
export function collectWeaponQuickActions(actor, item, ctx) {
  if (!actor || !item?.system?.itemTags?.isWeapon) return [];
  const activeLineId = resolveActiveWeaponAttack(getWeaponData(item)).lineId;
  return _collectWeaponAmmoActions(actor, item).filter((a) => {
    if (!a.hudQuick || a.submenuKind) return false;
    if (a.lineId && activeLineId && a.lineId !== activeLineId) return false;
    if (typeof a.visible === 'function' && !a.visible(ctx)) return false;
    return typeof a.enabled === 'function' ? !!a.enabled(ctx) : true;
  });
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
    inCombat: !!activeCombat(),
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
 * Everything attached to a weapon that can be taken off: external magazines, chambered and hosted charge units.
 * @param {Actor} actor
 * @param {Item} item weapon
 * @returns {Array<{item: Item, line: object, block: object, mode: 'detachMagazine'|'detachChargeUnit', slot?: string, group: string}>}
 */
function _collectWeaponDetachCandidates(actor, item) {
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
      syncExternalChargeHostedRuntime(actor, item, block);
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
      const seen = new Set(chamber ? [chamber.id] : []);
      for (const unit of getBlockContentItems(actor, block)) {
        if (seen.has(unit.id)) continue;
        seen.add(unit.id);
        next.push({
          item: unit,
          line,
          block,
          mode: 'detachChargeUnit',
          slot: 'content',
          group: _blockMenuPrefix(line, block, { blockCount: 2 }),
        });
      }
      // Also list any compatible host children not yet in contentItemIds (orphans).
      for (const it of actor?.items ?? []) {
        if (String(it.system?.containerHostId ?? '') !== item.id) continue;
        if (seen.has(it.id)) continue;
        if (!it.system?.itemTags?.isAmmo) continue;
        seen.add(it.id);
        next.push({
          item: it,
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
}

/**
 * Take one detach candidate off its weapon (magazine back to the hands, charge unit out of the host).
 * @param {Actor} actor
 * @param {Item} weaponItem
 * @param {{item?: Item, line?: object, block?: object, mode?: string}|null|undefined} candidate
 * @returns {Promise<boolean>}
 */
async function _runWeaponDetach(actor, weaponItem, candidate) {
  const line = candidate?.line;
  const blockRef = candidate?.block;
  const unit = candidate?.item;
  if (!line || !blockRef) return false;
  const w = getWeaponData(weaponItem);
  const b = getAmmoBlock(w, line.id, blockRef.id);
  if (!b) return false;

  if (candidate.mode === 'detachMagazine') {
    const res = await detachMagazine({ actor, weaponItem, block: b });
    if (!res?.ok) {
      ui.notifications?.warn?.(_t('SPACEHOLDER.WeaponV3.BlockActions.Failed'));
      return false;
    }
    await persistWeaponData(weaponItem, w);
    return true;
  }

  if (candidate.mode === 'detachChargeUnit' && unit) {
    const rt = b.runtime ?? {};
    if (String(rt.chamberItemId ?? '') === unit.id) rt.chamberItemId = '';
    if (Array.isArray(rt.contentItemIds)) {
      rt.contentItemIds = rt.contentItemIds.filter((id) => String(id) !== unit.id);
    }
    await unparentActorItemFromHost(actor, unit.id, { held: true });
    await persistWeaponData(weaponItem, w);
    return true;
  }

  return false;
}

/**
 * Weapon-level flyout: detach attached magazines / batteries / charge units.
 * @returns {ActionDescriptor[]}
 */
function _buildWeaponDetachSubmenu(actor, item) {
  const out = [];
  if (!item?.system?.itemTags?.isWeapon) return out;

  const collect = () => _collectWeaponDetachCandidates(actor, item);
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
    run: async (runCtx) => _runWeaponDetach(actor, item, runCtx?.chargeCandidate),
  });
  return out;
}

/**
 * «Detach» on the attached item itself (magazine, battery) — the row of a weapon's child in the inventory:
 * the same operation as the weapon's «Detach…» flyout, reachable from the item's own menu.
 * @param {Actor} actor
 * @param {Item} item the attached item
 * @param {ActionContext} ctx
 * @returns {ActionDescriptor[]}
 */
function _buildAttachedItemDetachAction(actor, item, ctx) {
  const hostId = String(item?.system?.containerHostId ?? '').trim();
  const weapon = hostId ? actor?.items?.get?.(hostId) : null;
  if (!weapon?.system?.itemTags?.isWeapon) return [];
  const findCandidate = () => _collectWeaponDetachCandidates(actor, weapon).find((c) => c.item?.id === item.id) ?? null;
  if (!findCandidate()) return [];
  return [{
    id: `item.${item.uuid}.detachFromWeapon`,
    source: 'item',
    sourceItemName: item.name,
    label: _t('SPACEHOLDER.WeaponV3.Interact.DetachItem', { item: item.name }),
    menuGroup: _t('SPACEHOLDER.WeaponV3.Interact.AmmoGroup'),
    menuLabel: _t('SPACEHOLDER.WeaponV3.Interact.DetachItemShort'),
    icon: 'fa-solid fa-box-open',
    apCost: 0,
    description: '',
    showInCombat: false,
    showInQuickbar: false,
    interactMenuOnly: true,
    weaponInteract: true,
    visible: () => !!findCandidate(),
    enabled: () => !!ctx.editable && !!findCandidate(),
    disabledReason: () => (ctx.editable ? null : _t('SPACEHOLDER.ActionsSystem.Common.NotEditable')),
    run: async () => _runWeaponDetach(actor, weapon, findCandidate()),
  }];
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
      hudQuick: true,
      lineId: only.lineId,
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
      hudQuick: true,
      lineId: line.id,
      blockPrefix: prefix,
      visible: () => canFn(),
      enabled: () => canFn(),
      run: runFn,
    });
  };

  pushAction({
    id: `item.${item.uuid}.weaponBlock.${line.id}.${block.id}.loadOne`,
    labelKey: 'SPACEHOLDER.WeaponV3.BlockActions.LoadOne',
    icon: 'fa-solid fa-circle-plus',
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
      icon: 'fa-solid fa-circle-plus',
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
    icon: 'fa-solid fa-arrows-rotate',
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
 * The actions that deserve a place in the general lists (the sheet's action tab, the quick HUD). The
 * simple actions every item has (`basic`: take off, put away, drop, show…) are listed only when they
 * are favorites; everything else is listed as it is.
 *
 * @param {ActionDescriptor[]} actions result of `collectActorActions`
 * @param {Iterable<string>} favoriteIds
 * @returns {ActionDescriptor[]}
 */
export function listableActions(actions, favoriteIds) {
  const favorites = favoriteIds instanceof Set ? favoriteIds : new Set(favoriteIds ?? []);
  return (Array.isArray(actions) ? actions : []).filter((a) => !a.basic || favorites.has(a.id));
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
    inCombat: !!activeCombat(),
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

  if (action.uiOnly) {
    return (await action.run(ctx)) !== false;
  }
 
  const baseCost = Math.floor(_num(action.apCost, 0));
  const cost = getEffectiveActionCost(actor, baseCost);
  await ensureCharacterApSynced(actor);

  // The first action of a round can start the actor's official turn.
  const { combatant } = await beginCombatAction(actor, ctx.tokenDoc ?? null);

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

  await logCombatAction({
    actor,
    tokenDoc: ctx.tokenDoc ?? null,
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
 

/**
 * Resolve an action descriptor by id: the general list first, then the
 * one-click weapon actions (reload, bolt…) that live outside it.
 * @param {Actor} actor
 * @param {string} actionId
 * @param {Partial<ActionContext>} [partialCtx]
 * @returns {ActionDescriptor|null}
 */
export function findActorAction(actor, actionId, partialCtx = {}) {
  const id = String(actionId ?? '').trim();
  if (!actor || !id) return null;

  const { context, actions } = collectActorActions(actor, partialCtx);
  const general = actions.find((a) => String(a?.id ?? '') === id);
  if (general) return general;

  const item = Array.from(actor.items ?? []).find((i) => id.startsWith(`item.${i.uuid}.`));
  if (!item?.system?.itemTags?.isWeapon) return null;
  return collectWeaponQuickActions(actor, item, context).find((a) => String(a?.id ?? '') === id) ?? null;
}

/**
 * Item actions that share one hotbar macro: whichever of the two the item's current state offers runs,
 * so the macro works in both directions (take in hands ↔ put away).
 */
const ITEM_TOGGLE_PAIRS = [['hold', 'stow']];

/**
 * The toggle an item action id (`item.<uuid>.<verb>`) belongs to.
 * @param {string} actionId
 * @returns {{ itemUuid: string, ids: string[] }|null} `ids` — the action ids of the pair, the id a macro stores first
 */
export function itemActionToggle(actionId) {
  const id = String(actionId ?? '').trim();
  const dot = id.lastIndexOf('.');
  if (!id.startsWith('item.') || dot <= 'item.'.length) return null;
  const itemUuid = id.slice('item.'.length, dot);
  const verb = id.slice(dot + 1);
  const pair = ITEM_TOGGLE_PAIRS.find((verbs) => verbs.includes(verb));
  return pair ? { itemUuid, ids: pair.map((v) => `item.${itemUuid}.${v}`) } : null;
}

/**
 * Run an actor action by id (hotbar action macros). Uses a controlled token of
 * the actor, else its first active token on the scene. An item action that belongs to a toggle
 * (`itemActionToggle`) runs whichever verb of the pair the item's state allows.
 * @param {string} actorUuid
 * @param {string} actionId
 * @returns {Promise<boolean>}
 */
export async function runActorActionById(actorUuid, actionId) {
  let actor = null;
  try {
    actor = await fromUuid(String(actorUuid ?? ''));
  } catch (_) {
    actor = null;
  }
  if (!(actor instanceof Actor)) {
    ui.notifications?.warn?.(_t('SPACEHOLDER.ActionsSystem.Errors.ActionNotFound'));
    return false;
  }

  const token = resolveActionToken(null, actor);
  const tokenDoc = token?.document ?? null;
  const editable = !!actor.isOwner || !!game.user?.isGM;
  let action = findActorAction(actor, actionId, { tokenDoc, editable });
  if (!action) {
    for (const id of itemActionToggle(actionId)?.ids ?? []) {
      action = findActorAction(actor, id, { tokenDoc, editable });
      if (action) break;
    }
  }
  if (!action) {
    ui.notifications?.warn?.(_t('SPACEHOLDER.ActionsSystem.Errors.ActionNotFound'));
    return false;
  }
  return executeActorAction(actor, action, { tokenDoc, editable });
}

/** Drag data `type` for an actor action dragged onto the macro hotbar. */
export const ACTION_DRAG_TYPE = 'SpaceholderAction';

/**
 * Create (or reuse) a script macro that runs an actor action and put it into
 * the hotbar slot. Drop data: `{ type: ACTION_DRAG_TYPE, actorUuid, actionId, label, img }`.
 * @param {object} data
 * @param {number} slot
 * @returns {Promise<boolean>}
 */
export async function createActorActionMacro(data, slot) {
  const actorUuid = String(data?.actorUuid ?? '').trim();
  let actionId = String(data?.actionId ?? '').trim();
  if (!actorUuid || !actionId) return false;

  // «Take in hands» and «put away» make the same two-way macro, named after the item.
  let name = String(data?.label ?? '').trim() || actionId;
  const toggle = itemActionToggle(actionId);
  if (toggle) {
    actionId = toggle.ids[0];
    let itemName = '';
    try {
      itemName = String((await fromUuid(toggle.itemUuid))?.name ?? '').trim();
    } catch (_) { /* the label below is enough */ }
    if (itemName) name = _t('SPACEHOLDER.ActionsSystem.Wearable.HoldStowToggle', { item: itemName });
  }

  const command = `game.spaceholder.runActorAction(${JSON.stringify(actorUuid)}, ${JSON.stringify(actionId)});`;
  let macro = game.macros?.find?.((m) => m.command === command && m.isOwner) ?? null;
  if (!macro) {
    macro = await Macro.create({
      name,
      type: 'script',
      img: String(data?.img ?? '').trim() || Macro.DEFAULT_ICON,
      command,
      flags: { spaceholder: { actionMacro: { actorUuid, actionId } } },
    });
  }
  if (!macro) return false;
  await game.user.assignHotbarMacro(macro, slot);
  return true;
}

/** Drag data `type` for an attack shortcut dragged onto the macro hotbar. */
export const ATTACK_DRAG_TYPE = 'SpaceholderAttack';

/**
 * Attack with an owned item by UUID (hotbar attack macros). Uses a controlled
 * token of the owning actor, else its first active token on the scene.
 * `lineId` + `modeId` pin the fire mode; without them the item's active
 * line/mode is used. Works for weapons that are not in hands (the attack
 * chain adds the «take in hands» step).
 * @param {string} itemUuid
 * @param {{ lineId?: string, modeId?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export async function runItemAttackByUuid(itemUuid, { lineId = '', modeId = '' } = {}) {
  let item = null;
  try {
    item = await fromUuid(String(itemUuid ?? ''));
  } catch (_) {
    item = null;
  }
  const actor = item?.actor ?? null;
  if (!(item instanceof Item) || !actor || !item.canAttack) {
    ui.notifications?.warn?.(_t('SPACEHOLDER.ActionsSystem.Errors.AttackItemNotFound'));
    return false;
  }
  return item.attack({ token: resolveActionToken(null, actor), lineId, modeId });
}

/**
 * Create (or reuse) a script macro that attacks with an item and put it into
 * the hotbar slot. Drop data: `{ type: ATTACK_DRAG_TYPE, itemUuid, lineId?, modeId? }`.
 * @param {object} data
 * @param {number} slot
 * @returns {Promise<boolean>}
 */
export async function createItemAttackMacro(data, slot) {
  const itemUuid = String(data?.itemUuid ?? '').trim();
  if (!itemUuid) return false;

  let item = null;
  try {
    item = await fromUuid(itemUuid);
  } catch (_) {
    item = null;
  }
  if (!(item instanceof Item) || !item.actor || !item.canAttack) {
    ui.notifications?.warn?.(_t('SPACEHOLDER.ActionsSystem.Errors.AttackItemNotFound'));
    return false;
  }

  const weapon = getWeaponData(item);
  const { line, mode } = getWeaponLineMode(weapon, data?.lineId, data?.modeId);
  const pinned = !!(line && mode);
  const lineId = pinned ? line.id : '';
  const modeId = pinned ? mode.id : '';

  const args = pinned ? `, ${JSON.stringify({ lineId, modeId })}` : '';
  const command = `game.spaceholder.runItemAttack(${JSON.stringify(itemUuid)}${args});`;
  let macro = game.macros?.find?.((m) => m.command === command && m.isOwner) ?? null;
  if (!macro) {
    const modeName = String(mode?.name || _t('SPACEHOLDER.WeaponV3.Mode.Default'));
    const modeLabel = (weapon.lines ?? []).length > 1
      ? `${line?.name || _t('SPACEHOLDER.WeaponV3.Line.Default')} / ${modeName}`
      : modeName;
    macro = await Macro.create({
      name: pinned
        ? _t('SPACEHOLDER.ActionsSystem.AttackMacro.NameMode', { item: item.name, mode: modeLabel })
        : _t('SPACEHOLDER.ActionsSystem.AttackMacro.Name', { item: item.name }),
      type: 'script',
      img: String(item.img ?? '').trim() || Macro.DEFAULT_ICON,
      command,
      flags: { spaceholder: { attackMacro: { itemUuid, lineId, modeId } } },
    });
  }
  if (!macro) return false;
  await game.user.assignHotbarMacro(macro, slot);
  return true;
}

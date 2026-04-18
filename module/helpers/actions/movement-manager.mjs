/**
 * Movement Manager (v13 integration)
 * - Не включает режимы вручную
 * - Слушает завершённые движения токенов (TokenDocument.movement)
 * - В бою пишет `move` в таблицу: база ОД = ceil(дистанция × system.speed), затем модификатор координации (getEffectiveActionCost).
 *   У персонажей `system.speed` производный: movementApTimeSlice / дистанция за этот бюджет (см. Actor `_prepareDerivedCharacterStats`).
 */

import { getEffectiveActionCost, getMovementDistanceApBase } from './action-service.mjs';
import { ensureCharacterApSynced, spendAp } from './transaction-ledger.mjs';
import { appendCombatActionJournalLine } from './action-chat-journal.mjs';

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

/**
 * Read position from core TokenPosition-like object.
 * @param {object|null|undefined} pos
 * @returns {{ x: number, y: number } | null}
 */
function _posXY(pos) {
  if (!pos || typeof pos !== "object") return null;
  const x = _num(pos.x, NaN);
  const y = _num(pos.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * Endpoints for undo: prefer core `movement.origin` / `movement.destination` (Foundry v13 TokenMovementData).
 * @param {object} movement
 * @param {TokenDocument} tokenDocument
 * @param {{ x: number, y: number } | null} prevPos from preUpdateToken when origin missing
 */
function _coreMovementEndpoints(movement, tokenDocument, prevPos) {
  const to =
    _posXY(movement?.destination) ||
    _posXY({ x: tokenDocument?.x, y: tokenDocument?.y });
  const from = _posXY(movement?.origin) || prevPos || null;
  return { from, to };
}

/**
 * Cost / distance as reported by core only (no canvas re-measure).
 * v13: `movement.passed` is the segment just completed (one drag) — use it first.
 * `movement.history` top-level is cumulative across the combat turn / chain — do not use for AP before `passed`.
 * @returns {{ baseCost: number, distance: number }}
 */
function _readCoreMovementMeasures(movement) {
  const passed = movement?.passed ?? {};
  const pCost = _num(passed.cost, 0);
  const pDist = _num(passed.distance, 0);
  if (pCost > 0 || pDist > 0) {
    return {
      baseCost: pCost > 0 ? pCost : pDist,
      distance: pDist > 0 ? pDist : pCost,
    };
  }

  const h = movement?.history ?? {};
  const rec = h.recorded ?? {};
  const rCost = _num(rec.cost, 0);
  const rDist = _num(rec.distance, 0);
  if (rCost > 0 || rDist > 0) {
    return {
      baseCost: rCost > 0 ? rCost : rDist,
      distance: rDist > 0 ? rDist : rCost,
    };
  }

  const hCost = _num(h.cost, 0);
  const hDist = _num(h.distance, 0);
  if (hCost > 0 || hDist > 0) {
    return {
      baseCost: hCost > 0 ? hCost : hDist,
      distance: hDist > 0 ? hDist : hCost,
    };
  }

  return { baseCost: 0, distance: 0 };
}

export class MovementManager {
  constructor() {
    this._bound = {
      onPreUpdateToken: this._onPreUpdateToken.bind(this),
      onUpdateToken: this._onUpdateToken.bind(this),
      onDeleteCombat: this._onDeleteCombat.bind(this),
    };
    this._hooksInstalled = false;
    /** @type {Set<string>} */
    this._loggedMovementIds = new Set();
    /** @type {Map<string,{x:number,y:number,at:number}>} */
    this._tokenPrevPos = new Map();
  }

  installHooks() {
    if (this._hooksInstalled) return;
    Hooks.on('preUpdateToken', this._bound.onPreUpdateToken);
    Hooks.on('updateToken', this._bound.onUpdateToken);
    Hooks.on('deleteCombat', this._bound.onDeleteCombat);
    this._hooksInstalled = true;
  }

  destroy() {
    if (!this._hooksInstalled) return;
    Hooks.off('preUpdateToken', this._bound.onPreUpdateToken);
    Hooks.off('updateToken', this._bound.onUpdateToken);
    Hooks.off('deleteCombat', this._bound.onDeleteCombat);
    this._hooksInstalled = false;
    this._loggedMovementIds.clear();
    this._tokenPrevPos.clear();
  }

  _onDeleteCombat() {
    this._loggedMovementIds.clear();
    this._tokenPrevPos.clear();
  }

  _onPreUpdateToken(tokenDocument, changes) {
    try {
      const hasMove = Object.prototype.hasOwnProperty.call(changes || {}, 'x') || Object.prototype.hasOwnProperty.call(changes || {}, 'y');
      if (!hasMove) return;
      this._tokenPrevPos.set(String(tokenDocument?.id || ''), {
        x: _num(tokenDocument?.x, 0),
        y: _num(tokenDocument?.y, 0),
        at: Date.now(),
      });
    } catch (_) {
      // ignore
    }
  }
  /**
   * Хук updateToken: когда ядро завершило движение и записало movement,
   * добавляем запись в actionLog для актёра (если идёт бой).
   * @private
   */
  async _onUpdateToken(tokenDocument, changes, options, userId) {
    try {
      if (!game.combat) return; // только в бою
      if (String(userId ?? '') !== String(game.user?.id ?? '')) return;
      const movement = tokenDocument?.movement;
      if (!movement) return;
      if (!movement.recorded || movement.state !== 'completed') {
        const isUndo = options?.isUndo === true;
        if (isUndo && game.spaceholder?.combatSessionManager?.syncUndoFromTokenUpdate) {
          await game.spaceholder.combatSessionManager.syncUndoFromTokenUpdate({
            combatId: game.combat?.id || null,
            tokenUuid: tokenDocument?.uuid || null,
            movementId: String(movement?.id || ''),
          });
        }
        return;
      }

      const moveId = String(movement.id ?? '').trim();
      if (!moveId || this._loggedMovementIds.has(moveId)) return;

      const actor = tokenDocument?.actor;
      if (!actor || actor.type !== 'character') return;

      const { baseCost, distance: dist } = _readCoreMovementMeasures(movement);
      const savedPrev = this._tokenPrevPos.get(String(tokenDocument?.id || '')) || null;
      const prevPos = savedPrev ? { x: _num(savedPrev.x, 0), y: _num(savedPrev.y, 0) } : null;
      const { from, to } = _coreMovementEndpoints(movement, tokenDocument, prevPos);

      if (baseCost <= 0 && dist <= 0) {
        this._tokenPrevPos.delete(String(tokenDocument?.id || ''));
        return;
      }

      const rawMovementAp = getMovementDistanceApBase(actor, dist, baseCost);
      const cost = getEffectiveActionCost(actor, rawMovementAp);
      this._tokenPrevPos.delete(String(tokenDocument?.id || ''));

      const combat = game?.combat?.started ? game.combat : null;
      let combatant = combat?.combatants?.contents?.find((c) => {
        const tokenId = String(c.tokenId ?? c.token?.id ?? '');
        return tokenId === String(tokenDocument.id ?? '');
      }) || null;
      const mgr = game.spaceholder?.combatSessionManager;
      if (combat && combatant && !combat.getFlag?.("spaceholder", "combatState")?.activeTurn?.combatantId && mgr?.pickTurn) {
        await mgr.pickTurn({ combatId: combat.id, combatantId: combatant.id });
      }
      const activeTurnId = String(combat?.getFlag?.("spaceholder", "combatState")?.activeTurn?.combatantId || "").trim();
      const anchorCombatant = activeTurnId && combat?.combatants?.get?.(activeTurnId)
        ? combat.combatants.get(activeTurnId)
        : combatant;
      const anchorActor = anchorCombatant?.actor || actor;
      const isReaction = !!(combat && combatant && activeTurnId && activeTurnId !== combatant.id);

      let moveTransactionId = null;
      if (cost > 0) {
        await ensureCharacterApSynced(actor);
        try {
          const spend = await spendAp(actor, cost, {
            combatantId: combatant?.id ?? null,
            source: { type: "move", movementId: moveId },
          });
          if (!spend?.ok) {
            console.warn("SpaceHolder | Movement AP spend failed", spend?.error);
          } else {
            moveTransactionId = spend.transactionId ?? null;
          }
        } catch (e) {
          console.warn("SpaceHolder | Movement AP spend failed", e);
        }
      }

      let moveCombatEventId = null;
      if (combat && combatant && game.spaceholder?.combatSessionManager?.logMovement) {
        const logRes = await game.spaceholder.combatSessionManager.logMovement({
          combat,
          actor,
          combatant,
          tokenDoc: tokenDocument,
          movementId: moveId,
          distance: dist,
          apCost: cost,
          baseApCost: rawMovementAp,
          from,
          to,
          transactionId: moveTransactionId,
          isReaction,
          anchorCombatantId: anchorCombatant?.id ?? null,
          reactionOfEventId: null,
        });
        moveCombatEventId = logRes?.eventId ?? null;
      }

      if (combat && combatant) {
        const moveLabel =
          game.i18n?.localize?.('SPACEHOLDER.ActionsSystem.Movement.Move') || 'Move';
        await appendCombatActionJournalLine({
          actor,
          combat,
          combatant,
          anchorActor,
          anchorCombatant,
          label: moveLabel,
          description: `${Math.max(0, _num(dist, 0)).toFixed(1)} u`,
          apCost: cost,
          kind: 'move',
          isReaction,
          actorName: actor?.name || "",
          transactionId: moveTransactionId,
          combatEventId: moveCombatEventId,
          movementId: moveId,
          tokenUuid: tokenDocument.uuid,
        });
      }

      this._loggedMovementIds.add(moveId);
    } catch (e) {
      console.error('SpaceHolder | Movement updateToken handler error', e);
    }
  }
}


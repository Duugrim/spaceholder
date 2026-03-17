/**
 * Movement Manager (v13 integration)
 * - Не включает режимы вручную
 * - Слушает завершённые движения токенов (TokenDocument.movement)
 * - В бою пишет запись типа 'move' в actionLog актёра с использованием cost/distance из ядра
 */

import { addActionEntry } from './action-log.mjs';

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

export class MovementManager {
  constructor() {
    this._bound = {
      onUpdateToken: this._onUpdateToken.bind(this),
    };
    this._hooksInstalled = false;
    /** @type {Set<string>} */
    this._loggedMovementIds = new Set();
  }

  installHooks() {
    if (this._hooksInstalled) return;
    Hooks.on('updateToken', this._bound.onUpdateToken);
    this._hooksInstalled = true;
  }

  destroy() {
    if (!this._hooksInstalled) return;
    Hooks.off('updateToken', this._bound.onUpdateToken);
    this._hooksInstalled = false;
    this._loggedMovementIds.clear();
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
      if (!movement.recorded) return;
      if (movement.state !== 'completed') return;

      const moveId = String(movement.id ?? '').trim();
      if (!moveId || this._loggedMovementIds.has(moveId)) return;

      const actor = tokenDocument?.actor;
      if (!actor || actor.type !== 'character') return;

      // Берём данные из history; fallback на passed.
      const hist = movement.history ?? {};
      const passed = movement.passed ?? {};
      const dist = _num(hist.distance ?? passed.distance, 0);
      const cost = _num(hist.cost ?? passed.cost ?? hist.distance ?? dist, 0);
      if (cost <= 0 && dist <= 0) return;

      await addActionEntry(actor, {
        type: 'move',
        movementId: moveId,
        tokenUuid: tokenDocument.uuid,
        distance: dist,
        apCost: cost,
      });

      this._loggedMovementIds.add(moveId);
    } catch (e) {
      console.error('SpaceHolder | Movement updateToken handler error', e);
    }
  }
}


/**
 * Personal time: per-actor seconds derived from AP spend (and GM absolute skip).
 *
 * Full AP pool ≈ REFERENCE_TURN_SECONDS of personal time:
 *   seconds = spentAp * REFERENCE_TURN_SECONDS / maxAp
 *
 * Consumers (DoT, heat, poison) listen to Hook `spaceholder.personalTimeAdvanced`.
 * Global `AP_PER_SECOND` / movementApTimeSlice are intentionally separate for now.
 */

import { getStoredActionPoints } from './transaction-ledger.mjs';

const MODULE_NS = 'spaceholder';
const FLAG_PERSONAL_TIME = 'personalTime';

/** Seconds of personal time represented by a full AP pool (any maxAp). */
export const REFERENCE_TURN_SECONDS = 10;

function _num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {Actor|null|undefined} actor
 * @returns {number}
 */
export function getMaxApForTime(actor) {
  return Math.max(0, Math.floor(_num(getStoredActionPoints(actor)?.max, 0)));
}

/**
 * Convert spent AP to personal-time seconds for this actor.
 * @param {Actor|null|undefined} actor
 * @param {number} ap
 * @returns {number}
 */
export function apToSeconds(actor, ap) {
  const spent = Math.max(0, _num(ap, 0));
  const maxAp = getMaxApForTime(actor);
  if (maxAp <= 0 || spent <= 0) return 0;
  return (spent * REFERENCE_TURN_SECONDS) / maxAp;
}

/**
 * Convert personal-time seconds to AP for this actor (inverse of apToSeconds).
 * @param {Actor|null|undefined} actor
 * @param {number} seconds
 * @returns {number}
 */
export function secondsToAp(actor, seconds) {
  const sec = Math.max(0, _num(seconds, 0));
  const maxAp = getMaxApForTime(actor);
  if (maxAp <= 0 || sec <= 0) return 0;
  return (sec * maxAp) / REFERENCE_TURN_SECONDS;
}

/**
 * Cumulative personal-time seconds stored on the actor.
 * @param {Actor|null|undefined} actor
 * @returns {number}
 */
export function getPersonalTimeTotal(actor) {
  const raw = actor?.getFlag?.(MODULE_NS, FLAG_PERSONAL_TIME);
  return Math.max(0, _num(raw?.totalSeconds, 0));
}

/**
 * Advance (or rewind) an actor's personal clock. Does not spend AP.
 *
 * @param {Actor} actor
 * @param {number} seconds  Positive to advance, negative to rewind (undo).
 * @param {object} [meta]
 * @param {string} [meta.source]
 * @returns {Promise<{ ok: boolean, seconds: number, total: number, previous: number, error?: string }>}
 */
export async function advancePersonalTime(actor, seconds, meta = {}) {
  const delta = _num(seconds, 0);
  if (!actor || actor.documentName !== 'Actor') {
    return { ok: false, seconds: 0, total: 0, previous: 0, error: 'Not an actor' };
  }
  if (!Number.isFinite(delta) || delta === 0) {
    const total = getPersonalTimeTotal(actor);
    return { ok: true, seconds: 0, total, previous: total };
  }

  const previous = getPersonalTimeTotal(actor);
  const total = Math.max(0, previous + delta);
  const prevFlag = actor.getFlag?.(MODULE_NS, FLAG_PERSONAL_TIME);
  const nextFlag =
    prevFlag && typeof prevFlag === 'object' && !Array.isArray(prevFlag)
      ? { ...prevFlag, totalSeconds: total }
      : { totalSeconds: total };

  try {
    await actor.setFlag(MODULE_NS, FLAG_PERSONAL_TIME, nextFlag);
  } catch (e) {
    console.error('SpaceHolder | advancePersonalTime failed', e);
    return { ok: false, seconds: 0, total: previous, previous, error: String(e?.message || e) };
  }

  const payload = {
    seconds: delta,
    total,
    previous,
    source: meta.source ?? null,
  };
  try {
    Hooks.callAll('spaceholder.personalTimeAdvanced', actor, payload);
  } catch (e) {
    console.error('SpaceHolder | personalTimeAdvanced hook failed', e);
  }

  return { ok: true, seconds: delta, total, previous };
}

/**
 * Resolve character actors for GM skip-time targets.
 * @param {'selected'|'scene'|'world'} scope
 * @returns {Actor[]}
 */
export function resolveSkipTimeActors(scope) {
  const seen = new Set();
  /** @type {Actor[]} */
  const out = [];

  const add = (actor) => {
    if (!actor || actor.type !== 'character') return;
    const id = actor.id || actor.uuid;
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(actor);
  };

  if (scope === 'selected') {
    for (const t of canvas?.tokens?.controlled || []) add(t.actor);
  } else if (scope === 'scene') {
    for (const t of canvas?.tokens?.placeables || []) add(t.actor);
  } else if (scope === 'world') {
    for (const a of game.actors || []) add(a);
  }

  return out;
}

/**
 * GM dialog: advance absolute personal time for a set of characters (no AP spend).
 * @returns {Promise<{ ok: boolean, count?: number, seconds?: number }>}
 */
export async function openSkipPersonalTimeDialog() {
  if (!game.user?.isGM) {
    ui.notifications?.warn?.(game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.GmOnly'));
    return { ok: false };
  }

  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) {
    ui.notifications?.warn?.(game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.DialogUnavailable'));
    return { ok: false };
  }

  const uid = foundry.utils.randomID?.() ?? `sh-skip-${Date.now()}`;
  const idAmount = `sh-skip-amount-${uid}`;
  const idUnit = `sh-skip-unit-${uid}`;
  const idScope = `sh-skip-scope-${uid}`;

  const title = game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.DialogTitle');
  const lblAmount = game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.Amount');
  const lblUnit = game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.Unit');
  const lblScope = game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.Scope');
  const unitSeconds = game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.UnitSeconds');
  const unitMinutes = game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.UnitMinutes');
  const scopeSelected = game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.ScopeSelected');
  const scopeScene = game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.ScopeScene');
  const scopeWorld = game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.ScopeWorld');
  const okLabel = game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.Confirm');
  const cancelLabel = game.i18n.localize('SPACEHOLDER.Actions.Cancel');

  const content = `
    <div class="spaceholder-skip-time-dialog">
      <div class="form-group">
        <label for="${idAmount}">${foundry.utils.escapeHTML(lblAmount)}</label>
        <input id="${idAmount}" type="number" min="0" step="any" value="10" />
      </div>
      <div class="form-group">
        <label for="${idUnit}">${foundry.utils.escapeHTML(lblUnit)}</label>
        <select id="${idUnit}">
          <option value="seconds" selected>${foundry.utils.escapeHTML(unitSeconds)}</option>
          <option value="minutes">${foundry.utils.escapeHTML(unitMinutes)}</option>
        </select>
      </div>
      <div class="form-group">
        <label for="${idScope}">${foundry.utils.escapeHTML(lblScope)}</label>
        <select id="${idScope}">
          <option value="selected" selected>${foundry.utils.escapeHTML(scopeSelected)}</option>
          <option value="scene">${foundry.utils.escapeHTML(scopeScene)}</option>
          <option value="world">${foundry.utils.escapeHTML(scopeWorld)}</option>
        </select>
      </div>
    </div>`;

  const _formRoot = (dlgEvent) =>
    dlgEvent?.currentTarget?.form ||
    dlgEvent?.target?.form ||
    dlgEvent?.currentTarget?.closest?.('form') ||
    dlgEvent?.target?.closest?.('form') ||
    dlgEvent?.currentTarget;

  /** @type {{ ok: true, amount: number, unit: string, scope: string } | { ok: false } | null} */
  let outcome = null;

  await DialogV2.wait({
    classes: ['spaceholder'],
    window: {
      title,
      icon: 'fa-solid fa-hourglass-half',
    },
    position: { width: 420 },
    content,
    buttons: [
      {
        action: 'ok',
        label: okLabel,
        icon: 'fa-solid fa-check',
        default: true,
        callback: (dlgEvent) => {
          const root = _formRoot(dlgEvent);
          const amountRaw = String(root?.querySelector?.(`#${idAmount}`)?.value ?? '0').trim().replace(',', '.');
          const amount = Math.max(0, Number.parseFloat(amountRaw) || 0);
          const unit = String(root?.querySelector?.(`#${idUnit}`)?.value ?? 'seconds');
          const scope = String(root?.querySelector?.(`#${idScope}`)?.value ?? 'selected');
          if (!(amount > 0)) {
            ui.notifications?.warn?.(game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.AmountRequired'));
            return;
          }
          outcome = { ok: true, amount, unit, scope };
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

  if (!outcome?.ok) return { ok: false };

  const seconds = outcome.unit === 'minutes' ? outcome.amount * 60 : outcome.amount;
  const actors = resolveSkipTimeActors(outcome.scope);
  if (!actors.length) {
    ui.notifications?.warn?.(game.i18n.localize('SPACEHOLDER.TokenControls.SkipTime.NoTargets'));
    return { ok: false };
  }

  let okCount = 0;
  for (const actor of actors) {
    const res = await advancePersonalTime(actor, seconds, { source: 'gmSkip' });
    if (res.ok) okCount += 1;
  }

  ui.notifications?.info?.(
    game.i18n.format('SPACEHOLDER.TokenControls.SkipTime.Done', {
      count: okCount,
      seconds: Math.round(seconds * 1000) / 1000,
    })
  );

  return { ok: true, count: okCount, seconds };
}

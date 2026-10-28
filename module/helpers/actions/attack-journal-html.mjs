/**
 * HTML of an attack row for the chat action journal (`action-chat-journal.mjs`): the attack as one entry.
 * Collapsed it shows the summary — every token that was hit and how many times (walls are not counted). The
 * facts of every shot and hit (the side of the blow, the centrality, the arc zone, the damage…) and the math of
 * the penetration are in the penetration view, one button per shot opens it: an attack of one shot carries the
 * button in the row, an attack of several lists its shots behind the chevron, each with its button.
 *
 * The shots panel opens and closes in the DOM only (`sh-journal-toggle-panel`, see the journal's click
 * handler): nothing is written to the message.
 */

import {
  attackApTotals,
  attackTotals,
  isHitImpact,
  summarizeTargets,
} from '../weapon/attack-log.mjs';
import { entryRayIds } from '../damage/penetration-track.mjs';

const I18N = 'SPACEHOLDER.AttackLog';
const AIMING_MESSAGES = 'SPACEHOLDER.AimingManager.Messages';

function _esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ''));
}

function _safeId(id) {
  return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Localized string, or `fallback` when the key is missing. */
function _L(key, fallback = '') {
  const value = game?.i18n?.localize?.(key);
  return value && value !== key ? value : fallback;
}

/** Formatted string, or `fallback` when the key is missing. */
function _F(key, data, fallback = '') {
  const value = game?.i18n?.format?.(key, data);
  return value && value !== key ? value : fallback;
}

/**
 * The button that opens the penetration view of a shot (`game.spaceholder.openPenetrationView`): the shot is
 * named by its first ray, the view lists the others.
 * @param {object} shot ShotEntry
 * @returns {string} the button, empty when the shot has no ray to open
 */
function _penetrationButton(shot) {
  const shotId = entryRayIds(shot)[0];
  if (!shotId) return '';
  const label = _L(`${I18N}.ShowPenetration`, 'Penetration');
  return `<button type="button" class="spaceholder-action-journal__toggle" data-action="sh-journal-open-penetration" data-shot-id="${_esc(shotId)}" title="${_esc(label)}" aria-label="${_esc(label)}"><i class="fa-solid fa-layer-group" aria-hidden="true"></i></button>`;
}

/** `Shot 2 · 2 hits` / `Shot 3 · miss` */
function _shotHitsText(shot) {
  const hits = (shot.impacts ?? []).filter(isHitImpact).length;
  return hits
    ? _F(`${I18N}.ShotHits`, { count: String(hits) }, `${hits}`)
    : _L(`${AIMING_MESSAGES}.DiagnosticMiss`, 'miss');
}

function _renderShotsPanel(shots, panelId) {
  const items = shots.map((shot) => {
    const button = _penetrationButton(shot);
    return `<li class="spaceholder-action-journal__attack-shot">
        <div class="spaceholder-action-journal__attack-shot-head">
          <span class="spaceholder-action-journal__attack-shot-title">${_esc(_F(`${I18N}.ShotTitle`, { n: String(shot.n) }, `#${shot.n}`))} · ${_esc(_shotHitsText(shot))}</span>
          ${button ? `<span class="spaceholder-action-journal__attack-shot-tools">${button}</span>` : ''}
          ${shot.apCost > 0 ? `<span class="spaceholder-action-journal__attack-shot-ap">${_esc(shot.apCost)}</span>` : ''}
        </div>
      </li>`;
  });
  return `<ol class="spaceholder-action-journal__attack-shots spaceholder-action-journal__attack-panel" id="${panelId}" data-collapsed="1">${items.join('')}</ol>`;
}

function _renderTargets(targets) {
  if (!targets.length) {
    return `<div class="spaceholder-action-journal__attack-nohits">${_esc(_L(`${I18N}.NoHits`, 'No hits'))}</div>`;
  }
  const items = targets.map((target) => `<li class="spaceholder-action-journal__attack-target">
        <div class="spaceholder-action-journal__attack-target-head">
          <span class="spaceholder-action-journal__attack-target-name">${_esc(target.name || '?')}</span>
          <span class="spaceholder-action-journal__attack-target-hits">×${target.hits}</span>
        </div>
      </li>`);
  return `<ul class="spaceholder-action-journal__attack-targets">${items.join('')}</ul>`;
}

/**
 * The journal row of an attack.
 * @param {object} line journal line: `{ id, kind: 'attack', label, attack: AttackLog, ... }`
 * @param {{ nested?: boolean, renderApChip: (ap: number) => string }} ctx
 * @returns {string} an `<li>`
 */
export function renderAttackRowHtml(line, ctx) {
  const log = line.attack ?? {};
  const idBase = `sh-attack-${_safeId(line.id || log.id)}`;
  const shotsPanelId = `${idBase}-shots`;
  const { ap } = attackApTotals(log);
  const totals = attackTotals(log);
  const modeLabel = [log.lineName, log.modeName].filter(Boolean).join(' / ');
  const meta = [
    modeLabel,
    _F(`${I18N}.Summary`, { shots: String(totals.shots), hits: String(totals.hits) }, `${totals.shots} / ${totals.hits}`),
  ].filter(Boolean).join(' · ');
  const nestedClass = ctx.nested ? ' spaceholder-action-journal__row--nested' : '';

  let tools = '';
  let shotsPanel = '';
  if (totals.shots === 1) {
    tools = _penetrationButton(log.shots[0]);
  } else if (totals.shots > 1) {
    tools = `<button type="button" class="spaceholder-action-journal__toggle spaceholder-action-journal__toggle--chevron" data-action="sh-journal-toggle-panel" data-target="${shotsPanelId}" aria-expanded="false" title="${_esc(_L(`${I18N}.ShowShots`, 'Show shots'))}"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
    shotsPanel = _renderShotsPanel(log.shots, shotsPanelId);
  }

  return `<li class="spaceholder-action-journal__row spaceholder-action-journal__row--attack${nestedClass}" data-line-id="${_esc(line.id || '')}" data-event-id="${_esc(line.combatEventId || '')}">
      <span class="spaceholder-action-journal__main">
        <span class="spaceholder-action-journal__kind"><i class="fa-solid fa-crosshairs" aria-hidden="true"></i></span>
        <span class="spaceholder-action-journal__text">${_esc(line.label || '')}</span>
      </span>
      ${ctx.renderApChip(ap)}
      <span class="spaceholder-action-journal__tools">${tools}</span>
      <div class="spaceholder-action-journal__attack-body">
        <div class="spaceholder-action-journal__attack-meta">${_esc(meta)}</div>
        ${_renderTargets(summarizeTargets(log))}
        ${shotsPanel}
      </div>
    </li>`;
}

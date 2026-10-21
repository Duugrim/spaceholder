/**
 * HTML of an attack row for the chat action journal (`action-chat-journal.mjs`): the attack as one
 * expandable entry. Collapsed it shows the summary — every token that was hit and how many times (walls
 * are not counted). A target expands into its hits with their exact parameters; the chevron of the row
 * expands the shots (the actions the attack consisted of) with the diagnostics of each.
 *
 * Panels open and close in the DOM only (`sh-journal-toggle-panel`, see the journal's click handler):
 * nothing is written to the message.
 */

import {
  attackApTotals,
  attackTotals,
  formatClock,
  formatNumber,
  isHitImpact,
  summarizeTargets,
} from '../weapon/attack-log.mjs';

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

/** `12 pierce, 3 blunt` — the damage that reached the part. */
function _damageText(damage) {
  return (Array.isArray(damage) ? damage : [])
    .filter((d) => d && Number(d.amount) > 0)
    .map((d) => `${formatNumber(d.amount)} ${d.type ?? ''}`.trim())
    .join(', ');
}

/** What became of one hit: the part and the damage, or that it waits for the GM. */
function _impactResultText(impact) {
  if (impact.failed) return _L(`${I18N}.DamageFailed`, 'damage not applied');
  if (impact.queued) return _L(`${I18N}.DamageQueued`, 'awaits the GM');
  // Another pellet of the same volley made this wound already.
  if (impact.joined) return _F(`${I18N}.SameWound`, { part: impact.partName ?? '' }, `${impact.partName ?? ''}: same wound`);
  // `damage` is unknown (not an array) when the target's owner is not here to tell what reached the part.
  const damage = _damageText(impact.damage) || (Array.isArray(impact.damage) ? _L(`${I18N}.NoWound`, 'no wound') : '');
  // The organs the damage reached, if it got that far.
  const organs = Array.isArray(impact.organs) && impact.organs.length
    ? _F(`${I18N}.OrganReached`, { organs: impact.organs.join(', ') }, `organ hit: ${impact.organs.join(', ')}`)
    : '';
  if (!impact.partName) return [damage, organs].filter(Boolean).join(' · ');
  const base = damage
    ? _F(`${I18N}.ImpactResult`, { part: impact.partName, damage }, `${impact.partName}: ${damage}`)
    : impact.partName;
  return organs ? `${base} · ${organs}` : base;
}

/** One hit under its target: the exact parameters of the hit and what it did. */
function _hitLineText(shotN, impact) {
  const shot = String(shotN);
  const head = impact.kind === 'area' || impact.outcome === 'area'
    ? _F(`${I18N}.AreaHitLine`, {
      shot,
      clock: formatClock(impact.clock),
      coverage: String(Math.round((Number(impact.coverage) || 0) * 100)),
      mode: String(impact.coverageMode ?? ''),
      scale: formatNumber(impact.effectScale),
    }, `#${shot} · AoE · ${formatClock(impact.clock)}h`)
    : Number.isFinite(Number(impact.centrality))
      ? _F(`${I18N}.HitLine`, {
        shot,
        clock: formatClock(impact.clock),
        centrality: formatNumber(impact.centrality),
        energy: formatNumber(impact.energyScale),
        quality: String(impact.qualityLabel ?? impact.quality ?? ''),
      }, `#${shot} · ${formatClock(impact.clock)}h · ${formatNumber(impact.centrality)} · ×${formatNumber(impact.energyScale)}`)
      : _F(`${I18N}.HitLinePlain`, { shot, clock: formatClock(impact.clock) }, `#${shot} · ${formatClock(impact.clock)}h`);
  const picked = impact.pickedGroup
    ? _F(`${I18N}.HitPicked`, { group: String(impact.pickedGroup) }, String(impact.pickedGroup))
    : '';
  const result = _impactResultText(impact);
  // The bullet came out of another target before it got here / goes on past this one.
  const through = impact.through
    ? _F(`${I18N}.ThroughBody`, { name: String(impact.through) }, `through ${impact.through}`)
    : '';
  const goesOn = Number(impact.exit) > 0
    ? _F(`${I18N}.BulletGoesOn`, { damage: formatNumber(impact.exit) }, `goes on: ${formatNumber(impact.exit)}`)
    : '';
  return [head, through, picked, result, goesOn].filter(Boolean).join(' · ');
}

/** The diagnostic lines of one shot (what the old per-shot chat message used to carry). */
function _shotDetailLines(shot) {
  const lines = [];
  if (shot.luck) {
    const clamped = shot.luck.clamped ? ` (${_L(`${AIMING_MESSAGES}.LuckClamped`, 'clamped')})` : '';
    const confidence = Number.isFinite(Number(shot.luck.confidence)) ? ` ${formatNumber(shot.luck.confidence)}` : '';
    const value = _F(`${AIMING_MESSAGES}.DiagnosticLuck`, {
      zone: String(shot.luck.zoneLabel ?? shot.luck.zone ?? ''),
      confidence,
      clamped,
    }, `${shot.luck.zoneLabel ?? shot.luck.zone ?? ''}${confidence}${clamped}`);
    lines.push(_F(`${AIMING_MESSAGES}.DiagnosticLuckLine`, { value }, value));
  }
  const delta = Number(shot.spread?.deltaDeg) || 0;
  const max = Number(shot.spread?.maxDeg) || 0;
  if (delta || max) {
    const signed = `${delta > 0 ? '+' : ''}${formatNumber(delta)}°`;
    const value = max > 0 ? `${signed} / ${formatNumber(max)}°` : signed;
    lines.push(_F(`${AIMING_MESSAGES}.DiagnosticSpreadLine`, { value }, value));
  }
  lines.push(...(shot.passes ?? []), ...(shot.walls ?? []));
  return lines;
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
    const details = _shotDetailLines(shot)
      .map((line) => `<div class="spaceholder-action-journal__attack-detail">${_esc(line)}</div>`)
      .join('');
    return `<li class="spaceholder-action-journal__attack-shot">
        <div class="spaceholder-action-journal__attack-shot-head">
          <span class="spaceholder-action-journal__attack-shot-title">${_esc(_F(`${I18N}.ShotTitle`, { n: String(shot.n) }, `#${shot.n}`))} · ${_esc(_shotHitsText(shot))}</span>
          ${shot.apCost > 0 ? `<span class="spaceholder-action-journal__attack-shot-ap">${_esc(shot.apCost)}</span>` : ''}
        </div>
        ${details}
      </li>`;
  });
  return `<ol class="spaceholder-action-journal__attack-shots spaceholder-action-journal__attack-panel" id="${panelId}" data-collapsed="1">${items.join('')}</ol>`;
}

function _renderTargets(targets, idBase) {
  if (!targets.length) {
    return `<div class="spaceholder-action-journal__attack-nohits">${_esc(_L(`${I18N}.NoHits`, 'No hits'))}</div>`;
  }
  const showHits = _L(`${I18N}.ShowHits`, 'Show hits');
  const items = targets.map((target, index) => {
    const panelId = `${idBase}-t${index}`;
    const hitLines = target.entries
      .map(({ shot, impact }) => `<li class="spaceholder-action-journal__attack-hit">${_esc(_hitLineText(shot, impact))}</li>`)
      .join('');
    return `<li class="spaceholder-action-journal__attack-target">
        <div class="spaceholder-action-journal__attack-target-head">
          <span class="spaceholder-action-journal__attack-target-name">${_esc(target.name || '?')}</span>
          <span class="spaceholder-action-journal__attack-target-hits">×${target.hits}</span>
          <button type="button" class="spaceholder-action-journal__toggle" data-action="sh-journal-toggle-panel" data-target="${panelId}" aria-expanded="false" title="${_esc(showHits)}"><i class="fa-solid fa-list" aria-hidden="true"></i></button>
        </div>
        <ul class="spaceholder-action-journal__attack-hits spaceholder-action-journal__attack-panel" id="${panelId}" data-collapsed="1">${hitLines}</ul>
      </li>`;
  });
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
  const toggle = totals.shots
    ? `<button type="button" class="spaceholder-action-journal__toggle spaceholder-action-journal__toggle--chevron" data-action="sh-journal-toggle-panel" data-target="${shotsPanelId}" aria-expanded="false" title="${_esc(_L(`${I18N}.ShowShots`, 'Show shots'))}"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`
    : '';

  return `<li class="spaceholder-action-journal__row spaceholder-action-journal__row--attack${nestedClass}" data-line-id="${_esc(line.id || '')}" data-event-id="${_esc(line.combatEventId || '')}">
      <span class="spaceholder-action-journal__main">
        <span class="spaceholder-action-journal__kind"><i class="fa-solid fa-crosshairs" aria-hidden="true"></i></span>
        <span class="spaceholder-action-journal__text">${_esc(line.label || '')}</span>
      </span>
      ${ctx.renderApChip(ap)}
      <span class="spaceholder-action-journal__tools">${toggle}</span>
      <div class="spaceholder-action-journal__attack-body">
        <div class="spaceholder-action-journal__attack-meta">${_esc(meta)}</div>
        ${_renderTargets(summarizeTargets(log), idBase)}
        ${totals.shots ? _renderShotsPanel(log.shots, shotsPanelId) : ''}
      </div>
    </li>`;
}

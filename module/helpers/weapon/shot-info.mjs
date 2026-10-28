/**
 * The facts of a shot and of its hits, as rows for the penetration view (`damage/penetration-view-app.mjs`):
 * the side the blow came from, how centrally the hitbox was met, the share of the projectile's energy that
 * reached the target, the part and the damage, the organs; and of the shot itself the arc zone, the spread, what
 * the projectile flew past. They used to be a dump of lines in the chat journal; the journal keeps only the
 * summary now.
 *
 * Pure (no Foundry globals; the localizer is injected) — `node module/helpers/weapon/shot-info.test.mjs`.
 */

import { getDamageType } from '../damage/damage-types.mjs';
import { clockToHitFace } from '../hit-luck.mjs';
import { foundryLocalizer } from '../i18n-localizer.mjs';
import { formatClock, formatNumber, isHitImpact } from './attack-log.mjs';

const I18N = 'SPACEHOLDER.PenetrationView';
const AIMING_MESSAGES = 'SPACEHOLDER.AimingManager.Messages';

/** `12 Ballistic, 3 Concussive` — the damage that reached the part. */
function damageText(damage, t) {
  return (Array.isArray(damage) ? damage : [])
    .filter((d) => d && Number(d.amount) > 0)
    .map((d) => {
      const label = getDamageType(d.type)?.label;
      return `${formatNumber(d.amount)} ${(label && t(label, '')) || d.type || ''}`.trim();
    })
    .join(', ');
}

/**
 * The rows of a hit: who was hit where and what came of it.
 * @param {object} impact `Impact` of the attack log (`weapon/attack-log.mjs`)
 * @param {{ t: Function, f: Function }} [i18n]
 * @returns {Array<{ key: string, label: string, value: string, tone?: 'warn'|'danger' }>} `key` the name of the fact
 *   (`Side`, `Damage`, `Status`…), for whoever picks one out
 */
export function buildHitInfo(impact, { t, f } = foundryLocalizer()) {
  if (!impact || typeof impact !== 'object') return [];
  const rows = [];
  const row = (key, value, fallback, tone) => {
    if (value === '' || value === undefined || value === null) return;
    rows.push({ key, label: t(`${I18N}.Hit.${key}`, fallback), value: String(value), ...(tone ? { tone } : {}) });
  };

  const area = impact.kind === 'area' || impact.outcome === 'area';
  if (Number.isFinite(Number(impact.clock))) {
    const face = clockToHitFace(impact.clock) === 'back' ? t(`${I18N}.Hit.Back`, 'behind') : t(`${I18N}.Hit.Front`, 'in front');
    row('Side', f(`${I18N}.Hit.SideValue`, { face, clock: formatClock(impact.clock) }, `${face} · ${formatClock(impact.clock)}h`), 'Side of the hit');
  }
  if (area) {
    row('Coverage', `${Math.round((Number(impact.coverage) || 0) * 100)}%`, 'Coverage');
    row('Mode', impact.coverageMode, 'Mode');
    row('EffectScale', Number.isFinite(Number(impact.effectScale)) ? `×${formatNumber(impact.effectScale)}` : '', 'Effect');
  } else {
    if (Number.isFinite(Number(impact.centrality))) {
      row('Centrality', formatNumber(impact.centrality), 'Centrality');
      row('Energy', `×${formatNumber(impact.energyScale)}`, 'Energy');
      row('Quality', impact.qualityLabel ?? impact.quality, 'Quality');
    }
  }
  row('Picked', impact.pickedGroup, 'Group picked');
  row('Part', impact.partName, 'Body part');

  // `damage` is unknown (not an array) when the target's owner is not here to tell what reached the part.
  if (Array.isArray(impact.damage) && !impact.queued && !impact.failed && !impact.joined) {
    row('Damage', damageText(impact.damage, t) || t(`${I18N}.Hit.NoWound`, 'no wound'), 'Damage');
  }
  if (Array.isArray(impact.organs) && impact.organs.length) row('Organs', impact.organs.join(', '), 'Organs');
  if (impact.through) row('Through', f(`${I18N}.Hit.ThroughValue`, { name: String(impact.through) }, `out of ${impact.through}`), 'Through');
  if (Number(impact.exit) > 0) row('GoesOn', formatNumber(impact.exit), 'Goes on');
  if (impact.failed) row('Status', t(`${I18N}.Hit.Failed`, 'damage not applied'), 'Status', 'danger');
  else if (impact.queued) row('Status', t(`${I18N}.Hit.Queued`, 'awaits the GM'), 'Status', 'warn');
  else if (impact.joined) row('Status', t(`${I18N}.Hit.SameWound`, 'same wound'), 'Status');
  return rows;
}

/** `1.2` for one value, `0.4–1.2` for a spread of them. */
function rangeText(values, format = formatNumber) {
  const list = values.map(Number).filter(Number.isFinite);
  if (!list.length) return '';
  const low = Math.min(...list);
  const high = Math.max(...list);
  return format(low) === format(high) ? format(low) : `${format(low)}–${format(high)}`;
}

/** Distinct values with how many times each came: `полное ×2, скользящее`. */
function countedText(values, t, f) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([label, count]) => (count > 1 ? f(`${I18N}.Hit.Count`, { label, count: String(count) }, `${label} ×${count}`) : label))
    .join(', ');
}

/**
 * The rows of the hits of one block of the view: all the projectiles that landed in one part of one target (the
 * pellets of a volley). One hit gives {@link buildHitInfo}; several give the same facts summed up — how many
 * there were, the spread of the centrality and of the energy that reached the target, the damage of the wounds
 * together (pellets that went into a wound already counted are not counted twice).
 * @param {object[]} impacts `Impact`s of the attack log
 * @param {{ t: Function, f: Function }} [i18n]
 * @returns {Array<{ label: string, value: string, tone?: 'warn'|'danger' }>}
 */
export function buildHitsInfo(impacts, { t, f } = foundryLocalizer()) {
  const list = (Array.isArray(impacts) ? impacts : []).filter((impact) => impact && typeof impact === 'object');
  if (list.length < 2) return buildHitInfo(list[0], { t, f });
  if (list.some((impact) => impact.kind === 'area' || impact.outcome === 'area')) return buildHitInfo(list[0], { t, f });

  const rows = [];
  const row = (key, value, fallback, tone) => {
    if (value === '' || value === undefined || value === null) return;
    rows.push({ key, label: t(`${I18N}.Hit.${key}`, fallback), value: String(value), ...(tone ? { tone } : {}) });
  };

  row('Pellets', String(list.length), 'Projectiles');

  const clocks = list.map((impact) => impact.clock).filter((clock) => clock !== undefined && Number.isFinite(Number(clock)));
  if (clocks.length) {
    const faces = clocks.map((clock) => (clockToHitFace(clock) === 'back' ? t(`${I18N}.Hit.Back`, 'behind') : t(`${I18N}.Hit.Front`, 'in front')));
    const oneFace = new Set(faces).size === 1;
    const face = oneFace ? faces[0] : countedText(faces, t, f);
    const sameClock = clocks.every((clock) => Number(clock) === Number(clocks[0]));
    row('Side', sameClock && oneFace
      ? f(`${I18N}.Hit.SideValue`, { face, clock: formatClock(clocks[0]) }, `${face} · ${formatClock(clocks[0])}h`)
      : face, 'Side of the hit');
  }
  const centralities = list.map((impact) => impact.centrality).filter((value) => value !== undefined && Number.isFinite(Number(value)));
  if (centralities.length) {
    row('Centrality', rangeText(centralities), 'Centrality');
    row('Energy', `×${rangeText(list.map((impact) => impact.energyScale).filter((value) => value !== undefined))}`, 'Energy');
    row('Quality', countedText(list.map((impact) => String(impact.qualityLabel ?? impact.quality ?? '')), t, f), 'Quality');
  }
  row('Picked', [...new Set(list.map((impact) => impact.pickedGroup).filter(Boolean))].join(', '), 'Group picked');
  row('Part', [...new Set(list.map((impact) => impact.partName).filter(Boolean))].join(', '), 'Body part');

  // The damage is the wound's: a pellet that went into the wound of another has none of its own.
  const wounds = list.filter((impact) => Array.isArray(impact.damage) && !impact.queued && !impact.failed && !impact.joined);
  if (wounds.length) {
    const sum = new Map();
    for (const { damage } of wounds) for (const d of damage) if (d && Number(d.amount) > 0) sum.set(d.type, (sum.get(d.type) ?? 0) + Number(d.amount));
    row('Damage', damageText([...sum].map(([type, amount]) => ({ type, amount })), t) || t(`${I18N}.Hit.NoWound`, 'no wound'), 'Damage');
  }
  const organs = [...new Set(list.flatMap((impact) => (Array.isArray(impact.organs) ? impact.organs : [])))];
  if (organs.length) row('Organs', organs.join(', '), 'Organs');

  if (list.some((impact) => impact.failed)) row('Status', t(`${I18N}.Hit.Failed`, 'damage not applied'), 'Status', 'danger');
  else if (list.some((impact) => impact.queued)) row('Status', t(`${I18N}.Hit.Queued`, 'awaits the GM'), 'Status', 'warn');
  return rows;
}

/**
 * The rows of a shot (one trigger pull): what it cost, the arc zone it was taken from, the spread, how it
 * ended — and what the projectile flew past.
 * @param {object} entry `ShotEntry` of the attack log
 * @param {{ t: Function, f: Function }} [i18n]
 * @returns {{ rows: Array<{ label: string, value: string }>, passes: string[] }}
 */
export function buildShotInfo(entry, { t, f } = foundryLocalizer()) {
  const rows = [];
  const row = (key, value, fallback) => {
    if (value === '' || value === undefined || value === null) return;
    rows.push({ label: t(`${I18N}.Shot.${key}`, fallback), value: String(value) });
  };
  if (!entry || typeof entry !== 'object') return { rows, passes: [] };

  const hits = (Array.isArray(entry.impacts) ? entry.impacts : []).filter(isHitImpact).length;
  row('Result', hits ? f('SPACEHOLDER.AttackLog.ShotHits', { count: String(hits) }, String(hits)) : t(`${AIMING_MESSAGES}.DiagnosticMiss`, 'miss'), 'Result');
  if (Number(entry.apCost) > 0) {
    const base = Number(entry.baseApCost);
    row('Ap', base > Number(entry.apCost) ? f(`${I18N}.Shot.ApBase`, { ap: String(entry.apCost), base: String(base) }, `${entry.apCost} (${base})`) : String(entry.apCost), 'AP');
  }
  if (Number(entry.rays) > 1) row('Rays', String(entry.rays), 'Rays');

  const luck = entry.luck;
  if (luck && typeof luck === 'object') {
    const clamped = luck.clamped ? ` (${t(`${AIMING_MESSAGES}.LuckClamped`, 'clamped')})` : '';
    const confidence = Number.isFinite(Number(luck.confidence)) ? ` ${formatNumber(luck.confidence)}` : '';
    const zone = String(luck.zoneLabel ?? luck.zone ?? '');
    row('Luck', f(`${AIMING_MESSAGES}.DiagnosticLuck`, { zone, confidence, clamped }, `${zone}${confidence}${clamped}`), 'Arc zone');
  }
  const delta = Number(entry.spread?.deltaDeg) || 0;
  const max = Number(entry.spread?.maxDeg) || 0;
  if (delta || max) {
    const signed = `${delta > 0 ? '+' : ''}${formatNumber(delta)}°`;
    row('Spread', max > 0 ? `${signed} / ${formatNumber(max)}°` : signed, 'Spread');
  }
  return { rows, passes: (Array.isArray(entry.passes) ? entry.passes : []).map(String).filter(Boolean) };
}

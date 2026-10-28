/**
 * Smoke tests for the shot and hit rows of the penetration view. Runs in plain Node; the strings come from
 * lang/ru.json and lang/en.json, so keys and placeholders are checked too:
 *   node module/helpers/weapon/shot-info.test.mjs
 */

import { readFileSync } from 'node:fs';
import { buildHitInfo, buildHitsInfo, buildShotInfo } from './shot-info.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

function localizer(file) {
  const lang = JSON.parse(readFileSync(new URL(`../../../lang/${file}.json`, import.meta.url), 'utf8'));
  const lookup = (key) => key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), lang);
  return {
    t: (key, fallback = '') => (typeof lookup(key) === 'string' ? lookup(key) : fallback),
    f: (key, data, fallback = '') => {
      const template = lookup(key);
      if (typeof template !== 'string') return fallback;
      return template.replace(/\{(\w+)\}/g, (_, name) => String(data?.[name] ?? ''));
    },
  };
}
const ru = localizer('ru');
const en = localizer('en');

const rowsOf = (rows) => Object.fromEntries(rows.map((r) => [r.label, r.value]));
const line = (over = {}) => ({
  tokenUuid: 'Token.o', name: 'Орк', kind: 'line', outcome: 'hit', clock: 3, centrality: 0.82, energyScale: 1,
  quality: 'full', qualityLabel: 'полное попадание', partName: 'Торс', damage: [{ type: 'ballistic', amount: 12 }], ...over,
});

/* -------------------------------------------- */
/*  Hits                                        */
/* -------------------------------------------- */

{
  const rows = rowsOf(buildHitInfo(line(), ru));
  assert('hit: the side, the centrality, the energy that reached the target and the quality',
    rows['Сторона удара'] === 'спереди · 3 ч' && rows['Центровость'] === '0.82' && rows['Энергия'] === '×1' && rows['Попадание'] === 'полное попадание', rows);
  assert('hit: the part and the damage with the type named', rows['Часть тела'] === 'Торс' && rows['Урон'] === '12 Баллистический', rows);
}
{
  const rows = rowsOf(buildHitInfo(line({ clock: 6, centrality: 0.3, energyScale: 0.4, quality: 'glancing', qualityLabel: 'скользящее' }), ru));
  assert('hit: a blow from behind, a glancing hit loses energy', rows['Сторона удара'] === 'сзади · 6 ч' && rows['Энергия'] === '×0.4' && rows['Попадание'] === 'скользящее', rows);
}
{
  const rows = rowsOf(buildHitInfo(line({ pickedGroup: 'Голова', organs: ['Мозг'], damage: [{ type: 'piercing', amount: 9 }] }), ru));
  assert('hit: the group picked by a crit and the organs reached', rows['Выбрана группа'] === 'Голова' && rows['Органы'] === 'Мозг', rows);
}
{
  const rows = rowsOf(buildHitInfo(line({ damage: [] }), ru));
  assert('hit: an empty damage list says there was no wound', rows['Урон'] === 'без ранения', rows);
  const unknown = rowsOf(buildHitInfo(line({ damage: undefined }), ru));
  assert('hit: damage that is not known (the owner is not here) is not guessed', !('Урон' in unknown), unknown);
}
{
  const queued = rowsOf(buildHitInfo(line({ queued: true, damage: undefined }), ru));
  const failed2 = buildHitInfo(line({ failed: true }), ru);
  const joined = rowsOf(buildHitInfo(line({ joined: true }), ru));
  assert('hit: damage that waits for the GM, failed damage, a pellet in the same wound',
    queued['Статус'] === 'ждёт ГМа' && failed2.find((r) => r.label === 'Статус')?.tone === 'danger' && joined['Статус'] === 'в ту же рану' && !('Урон' in joined), [queued, failed2, joined]);
}
{
  const rows = rowsOf(buildHitInfo(line({ through: 'Охранник', exit: 39.434 }), ru));
  assert('hit: the target the bullet came out of and what goes on', rows['Пуля вышла из'] === 'Охранник' && rows['Летит дальше'] === '39.43', rows);
}
{
  const rows = rowsOf(buildHitInfo({ name: 'Бандит', kind: 'area', outcome: 'area', clock: 9, coverage: 0.5, coverageMode: 'proportional', effectScale: 0.5, partName: 'Нога' }, ru));
  assert('hit: a blast shows coverage, mode and effect, no centrality', rows['Покрытие'] === '50%' && rows['Режим'] === 'proportional' && rows['Эффект'] === '×0.5' && !('Центровость' in rows), rows);
}
{
  const rows = rowsOf(buildHitInfo(line(), en));
  assert('hit: English wording', rows['Side of the hit'] === 'in front · 3 o\'clock' && rows.Centrality === '0.82', rows);
  assert('hit: nothing to show for junk', buildHitInfo(null, ru).length === 0 && buildHitInfo('x', ru).length === 0);
}

/* -------------------------------------------- */
/*  The hits of one block (several projectiles)  */
/* -------------------------------------------- */

{
  const one = buildHitsInfo([line()], ru);
  assert('hits: one hit is told as before', JSON.stringify(one) === JSON.stringify(buildHitInfo(line(), ru)));
  assert('hits: nothing for nothing', buildHitsInfo([], ru).length === 0 && buildHitsInfo(null, ru).length === 0);

  // Three pellets of one wound: the leader has the damage, the others joined it.
  const wound = [
    line({ centrality: 0.9, energyScale: 1, damage: [{ type: 'ballistic', amount: 12 }, { type: 'concussive', amount: 3 }] }),
    line({ centrality: 0.5, energyScale: 0.8, quality: 'glancing', qualityLabel: 'скользящее', joined: true, damage: undefined }),
    line({ centrality: 0.2, energyScale: 0.4, quality: 'glancing', qualityLabel: 'скользящее', joined: true, damage: undefined, organs: ['Лёгкое'] }),
  ];
  const rows = rowsOf(buildHitsInfo(wound, ru));
  assert('hits: how many projectiles landed', rows['Снарядов'] === '3', rows);
  assert('hits: the spread of the centrality and of the energy that reached the target', rows['Центровость'] === '0.2–0.9' && rows['Энергия'] === '×0.4–1', rows);
  assert('hits: the qualities with their counts', rows['Попадание'] === 'полное попадание, скользящее ×2', rows);
  assert('hits: the damage of the wound is counted once (the pellets that joined it have none)', rows['Урон'] === '12 Баллистический, 3 Ударный'
    || rows['Урон']?.startsWith('12 Баллистический'), rows);
  assert('hits: one side, one part, the organs of all', rows['Сторона удара'] === 'спереди · 3 ч' && rows['Часть тела'] === 'Торс' && rows['Органы'] === 'Лёгкое', rows);
}
{
  // Separate wounds in one part add up; sides that differ are counted.
  const rows = rowsOf(buildHitsInfo([
    line({ clock: 3, damage: [{ type: 'ballistic', amount: 5 }] }),
    line({ clock: 6, damage: [{ type: 'ballistic', amount: 7 }] }),
  ], ru));
  assert('hits: the damage of separate wounds adds up', rows['Урон'] === '12 Баллистический', rows);
  assert('hits: blows from both sides are counted', rows['Сторона удара'] === 'спереди, сзади', rows);
  const queued = buildHitsInfo([line({ queued: true, damage: undefined }), line({ damage: [{ type: 'ballistic', amount: 5 }] })], ru);
  assert('hits: damage that waits for the GM is flagged, the rest is told', queued.find((r) => r.label === 'Статус')?.tone === 'warn'
    && rowsOf(queued)['Урон'] === '5 Баллистический', queued);
  const failedRows = buildHitsInfo([line({ failed: true }), line()], ru);
  assert('hits: failed damage is flagged as an error', failedRows.find((r) => r.label === 'Статус')?.tone === 'danger');
  const mixed = rowsOf(buildHitsInfo([line({ clock: 3 }), line({ clock: 6 })], en));
  assert('hits: English wording', mixed['Side of the hit'] === 'in front, behind' && mixed.Projectiles === '2', mixed);
  const area = buildHitsInfo([{ name: 'Бандит', kind: 'area', outcome: 'area', coverage: 1, coverageMode: 'all', effectScale: 1 }, line()], ru);
  assert('hits: a blast hit is told as itself', rowsOf(area)['Покрытие'] === '100%' && !('Снарядов' in rowsOf(area)), area);
}

/* -------------------------------------------- */
/*  Shots                                       */
/* -------------------------------------------- */

{
  const info = buildShotInfo({
    n: 1, apCost: 15, baseApCost: 20, rays: 3,
    luck: { zone: 'green', zoneLabel: 'Зелёная зона', confidence: 5, clamped: true },
    spread: { deltaDeg: 0.4, maxDeg: 1.5 },
    passes: ['Ящик · уверенность 1 не выше сопротивления 1 — пролетел мимо'],
    impacts: [line(), line({ outcome: 'pass' })],
  }, ru);
  const rows = rowsOf(info.rows);
  assert('shot: hits, AP with the base cost, rays, the arc zone and the spread',
    rows['Итог'] === 'попаданий: 1' && rows['ОД'] === '15 (базово 20)' && rows['Лучей'] === '3' && rows['Дуга'] === 'Зелёная зона 5 (кламп)' && rows['Разброс'] === '+0.4° / 1.5°', rows);
  assert('shot: what the projectile flew past', info.passes.length === 1 && info.passes[0].includes('пролетел мимо'), info.passes);
}
{
  const info = buildShotInfo({ n: 2, apCost: 6, baseApCost: 6, impacts: [] }, ru);
  assert('shot: a miss, a plain AP cost, no rays or arc when there are none',
    rowsOf(info.rows)['Итог'] === 'мимо' && rowsOf(info.rows)['ОД'] === '6' && info.rows.length === 2 && info.passes.length === 0, info.rows);
  assert('shot: nothing for junk', buildShotInfo(null, ru).rows.length === 0 && buildShotInfo(undefined, en).passes.length === 0);
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll shot-info tests passed');

/**
 * Smoke tests for the attack row of the chat journal. Runs in plain Node with stubbed `game` / `foundry`
 * globals (English strings come from lang/en.json, so keys and placeholders are checked too). Execute with:
 *   node module/helpers/actions/attack-journal-html.test.mjs
 *
 * Each case prints a single PASS/FAIL line. Process exits with code 1 if any assertion fails.
 */

import { readFileSync } from 'node:fs';
import { addShot, createAttackLog } from '../weapon/attack-log.mjs';

const lang = JSON.parse(readFileSync(new URL('../../../lang/en.json', import.meta.url), 'utf8'));
const lookup = (key) => key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), lang);

globalThis.foundry = {
  utils: {
    escapeHTML: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  },
};
globalThis.game = {
  i18n: {
    localize: (key) => lookup(key) ?? key,
    format: (key, data) => {
      const template = lookup(key);
      if (typeof template !== 'string') return key;
      return template.replace(/\{(\w+)\}/g, (_, name) => String(data?.[name] ?? ''));
    },
  },
};

const { renderAttackRowHtml } = await import('./attack-journal-html.mjs');

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const renderApChip = (ap) => `<span class="chip">${ap}</span>`;
const render = (log, extra = {}) => renderAttackRowHtml({ id: log.id, kind: 'attack', label: 'Attack: AK-74', attack: log, ...extra }, { renderApChip });

/* -------------------------------------------- */
/*  A burst: hits on the orc (full, crit, glancing), one on a bandit, one fly-past */
/* -------------------------------------------- */

const log = createAttackLog({ weapon: { name: 'AK-74' }, lineName: 'Barrel', modeName: 'Burst', fireMode: 'burst' });
addShot(log, {
  apCost: 15,
  baseApCost: 20,
  luck: { zone: 'green', zoneLabel: 'Green zone', confidence: 5, clamped: false },
  spread: { deltaDeg: 0.4, maxDeg: 1.5 },
  impacts: [{
    tokenUuid: 'Token.o', name: 'Orc <b>Boss</b>', kind: 'line', outcome: 'hit', clock: 3, centrality: 0.82, energyScale: 1,
    quality: 'full', qualityLabel: 'full hit', crit: false, partName: 'Torso', damage: [{ type: 'pierce', amount: 12 }],
  }],
});
addShot(log, {
  apCost: 6,
  baseApCost: 8,
  passes: ['Crate · confidence 1 (Red zone) is not above resistance 1 (in combat) — flies past'],
  walls: ['Concrete 30: penetrated'],
  impacts: [
    { tokenUuid: 'Token.o', name: 'Orc <b>Boss</b>', kind: 'line', outcome: 'hit', clock: 4, centrality: 0.3, energyScale: 0.4, quality: 'glancing', qualityLabel: 'glancing', crit: false, partName: 'Arm', damage: [] },
    { tokenUuid: 'Token.o', name: 'Orc <b>Boss</b>', kind: 'line', outcome: 'hit', clock: 12, centrality: 0.97, energyScale: 1, quality: 'crit', qualityLabel: 'crit', crit: true, pickedGroup: 'Head', partName: 'Skull', organs: ['Brain'], damage: [{ type: 'pierce', amount: 9 }] },
    { tokenUuid: 'Token.o', name: 'Orc <b>Boss</b>', kind: 'line', outcome: 'hit', clock: 5, partName: 'Leg', damage: [{ type: 'cutting', amount: 3 }] },
    { tokenUuid: 'Token.b', name: 'Bandit', kind: 'area', outcome: 'area', clock: 9, coverage: 0.5, coverageMode: 'proportional', effectScale: 0.5, queued: true, partName: 'Leg' },
  ],
});
addShot(log, { apCost: 6, baseApCost: 8, impacts: [] });

const html = render(log);

assert('the row is an attack row with the label', html.includes('spaceholder-action-journal__row--attack') && html.includes('Attack: AK-74'));
assert('the AP chip carries the total', html.includes('<span class="chip">27</span>'), html.match(/chip">\d+/g));
assert('the summary line has the mode and the totals', html.includes('Barrel / Burst · Shots: 3 · Hits: 5'), html.match(/attack-meta">[^<]*/)?.[0]);
assert('targets: names escaped, hit counts shown',
  html.includes('Orc &lt;b&gt;Boss&lt;/b&gt;') && !html.includes('<b>Boss</b>') && html.includes('×4') && html.includes('Bandit') && html.includes('×1'));
assert('hit parameters sit in a collapsed panel',
  html.includes('Shot 1 · from 3 o&#39;clock') || html.includes("Shot 1 · from 3 o'clock"));
assert('hit line: centrality, the energy that reached the target and the quality', html.includes('centrality 0.82 · energy ×1 (full hit)'));
assert('hit line: a glancing hit shows the energy it lost', html.includes('centrality 0.3 · energy ×0.4 (glancing)'));
assert('hit line: a crit says so and which group was picked', html.includes('(crit) · picked: Head · Skull: 9 pierce'));
assert('hit line: a blow with no centrality has no quality part', html.includes('Shot 2 · from 5 o&#39;clock · Leg: 3 cutting') || html.includes("Shot 2 · from 5 o'clock · Leg: 3 cutting"));
assert('hit line: the part and the damage that reached it', html.includes('Torso: 12 pierce'));
assert('a hit with an empty damage list says there was no wound', html.includes('Arm: no wound'));
assert('a hit that reached an organ names it', html.includes('Skull: 9 pierce · organ hit: Brain'), html.match(/Skull[^<]*/)?.[0]);
assert('an area hit shows coverage and mode', html.includes('AoE') && html.includes('coverage 50% · proportional · effect ×0.5'));
assert('damage waiting for the GM is marked', html.includes('awaits the GM'));
assert('every panel starts collapsed', (html.match(/data-collapsed="1"/g) ?? []).length >= 3 && !html.includes('data-collapsed="0"'));
assert('every toggle names an existing panel',
  [...html.matchAll(/data-target="([^"]+)"/g)].every(([, id]) => html.includes(`id="${id}"`)));
assert('the shots panel lists every shot with its AP',
  html.includes('Shot 1 · hits: 1') && html.includes('Shot 3 · miss') && html.includes('attack-shot-ap">15<'));
assert('the shot diagnostics are kept: luck, spread, fly-past, walls',
  html.includes('Confidence: Green zone 5') && html.includes('Spread: +0.4° / 1.5°') && html.includes('flies past') && html.includes('Concrete 30: penetrated'));
assert('panel ids are unique', (() => {
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  return new Set(ids).size === ids.length;
})());

/* -------------------------------------------- */
/*  A bullet that went through the first target */
/* -------------------------------------------- */

{
  const through = createAttackLog({ weapon: { name: 'Anti-materiel rifle' } });
  addShot(through, {
    apCost: 20,
    impacts: [
      { tokenUuid: 'Token.a', name: 'Guard', kind: 'line', outcome: 'hit', clock: 12, centrality: 0.8, energyScale: 1, quality: 'full', qualityLabel: 'full hit', partName: 'Torso', damage: [{ type: 'ballistic', amount: 240.6 }], exit: 39.43 },
      { tokenUuid: 'Token.b', name: 'Clerk', kind: 'line', outcome: 'hit', clock: 12, centrality: 0.7, energyScale: 1, quality: 'full', qualityLabel: 'full hit', partName: 'Torso', damage: [{ type: 'ballistic', amount: 36.08 }], through: 'Guard' },
    ],
  });
  const out = render(through);
  assert('a bullet that went through: both targets are in the summary', out.includes('Guard') && out.includes('Clerk') && out.includes('Hits: 2'), out.match(/attack-meta">[^<]*/)?.[0]);
  assert('hit line: the target the bullet left shows what went on', out.includes('Torso: 240.6 ballistic · the bullet goes on: 39.43'), out.match(/Torso: 240[^<]*/)?.[0]);
  assert('hit line: the target behind says which one the bullet came through', out.includes('through Guard · Torso: 36.08 ballistic'), out.match(/through Guard[^<]*/)?.[0]);
}

/* -------------------------------------------- */
/*  No hits, nested, empty                      */
/* -------------------------------------------- */

{
  const miss = createAttackLog({ weapon: { name: 'Pistol' } });
  addShot(miss, { apCost: 12, impacts: [] });
  const out = render(miss);
  assert('no hits: says so, no target list', out.includes('No hits') && !out.includes('attack-targets'));
  assert('no hits: the shot is still listed', out.includes('Shot 1 · miss'));
}
{
  const out = render(log, { id: 'reaction-1' });
  assert('a nested row (reaction) gets the nested class', renderAttackRowHtml({ id: 'x', kind: 'attack', label: 'A', attack: log }, { nested: true, renderApChip }).includes('row--nested'));
  assert('the row id is part of the panel ids (several attacks in one message stay apart)', out.includes('sh-attack-reaction-1-'));
}
{
  const out = renderAttackRowHtml({ id: 'e', kind: 'attack', label: 'Empty', attack: createAttackLog() }, { renderApChip });
  assert('an empty log renders without panels', out.includes('No hits') && !out.includes('data-target'));
  const broken = renderAttackRowHtml({ id: 'b', kind: 'attack', label: 'No attack' }, { renderApChip });
  assert('a line with no attack data does not throw', broken.includes('No attack'));
}

if (failed > 0) {
  console.log(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll attack-journal-html tests passed');

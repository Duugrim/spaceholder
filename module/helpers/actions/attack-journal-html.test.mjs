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
const buttons = (html) => [...html.matchAll(/data-action="sh-journal-open-penetration" data-shot-id="([^"]+)"/g)].map((m) => m[1]);

const hit = (name, over = {}) => ({
  tokenUuid: `Token.${name}`, name, kind: 'line', outcome: 'hit', clock: 3, centrality: 0.82, energyScale: 1,
  quality: 'full', qualityLabel: 'full hit', partName: 'Torso', damage: [{ type: 'ballistic', amount: 12 }], ...over,
});

/* -------------------------------------------- */
/*  A burst: several shots                      */
/* -------------------------------------------- */

const log = createAttackLog({ weapon: { name: 'AK-74' }, lineName: 'Barrel', modeName: 'Burst', fireMode: 'burst' });
addShot(log, {
  apCost: 15, baseApCost: 20, ids: ['shot_1a'],
  luck: { zone: 'green', zoneLabel: 'Green zone', confidence: 5, clamped: false },
  spread: { deltaDeg: 0.4, maxDeg: 1.5 },
  impacts: [hit('Orc <b>Boss</b>', { shotId: 'shot_1a' })],
});
addShot(log, {
  apCost: 6, baseApCost: 8, ids: ['shot_2a', 'shot_2b'],
  passes: ['Crate · confidence 1 (Red zone) is not above resistance 1 (in combat) — flies past'],
  impacts: [hit('Orc <b>Boss</b>', { shotId: 'shot_2a' }), hit('Orc <b>Boss</b>', { shotId: 'shot_2a', clock: 12, crit: true, pickedGroup: 'Head' }), hit('Bandit', { shotId: 'shot_2b', kind: 'area', outcome: 'area', queued: true })],
});
addShot(log, { apCost: 6, baseApCost: 8, impacts: [] });

const html = render(log);

assert('the row is an attack row with the label', html.includes('spaceholder-action-journal__row--attack') && html.includes('Attack: AK-74'));
assert('the AP chip carries the total', html.includes('<span class="chip">27</span>'), html.match(/chip">\d+/g));
assert('the summary line has the mode and the totals', html.includes('Barrel / Burst · Shots: 3 · Hits: 4'), html.match(/attack-meta">[^<]*/)?.[0]);
assert('targets: names escaped, hit counts shown',
  html.includes('Orc &lt;b&gt;Boss&lt;/b&gt;') && !html.includes('<b>Boss</b>') && html.includes('×3') && html.includes('Bandit') && html.includes('×1'));
assert('the dump of the hits and of the shots is not in the journal any more (it is in the penetration view)',
  !/centrality|energy ×|o'clock|Spread|Confidence|flies past|picked|awaits the GM|Show hits/i.test(html), html.match(/centrality|energy ×|o'clock|Spread|Confidence|flies past|picked|awaits the GM|Show hits/i));
assert('a target has no panel of hits to open', !html.includes('attack-hits') && (html.match(/data-target="/g) ?? []).length === 1, html.match(/data-target="[^"]+"/g));
assert('several shots: the chevron opens the list of shots, collapsed', html.includes('toggle--chevron') && html.includes('title="Show shots"') && html.includes('data-collapsed="1"') && !html.includes('data-collapsed="0"'));
assert('the shots panel lists every shot with its hits and AP',
  html.includes('Shot 1 · hits: 1') && html.includes('Shot 2 · hits: 3') && html.includes('Shot 3 · miss') && html.includes('attack-shot-ap">15<'), html.match(/attack-shot-title">[^<]*/g));
assert('one button per shot: it names the first ray, a shot with several rays still has one', JSON.stringify(buttons(html)) === JSON.stringify(['shot_1a', 'shot_2a']), buttons(html));
assert('a shot without a ray to open has no button but is listed', html.includes('Shot 3 · miss'));
assert('the button is named, no instruction', html.includes('title="Penetration"') && html.includes('aria-label="Penetration"') && html.includes('fa-layer-group'));
assert('the toggle names an existing panel', [...html.matchAll(/data-target="([^"]+)"/g)].every(([, id]) => html.includes(`id="${id}"`)));
assert('panel ids are unique', (() => {
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  return new Set(ids).size === ids.length;
})());

/* -------------------------------------------- */
/*  One shot: the button is in the row          */
/* -------------------------------------------- */

{
  const single = createAttackLog({ weapon: { name: 'Pistol' } });
  addShot(single, { apCost: 12, ids: ['shot_only'], impacts: [hit('Guard', { shotId: 'shot_only' })] });
  const out = render(single);
  assert('one shot: the button is in the row, no chevron and no panel', JSON.stringify(buttons(out)) === JSON.stringify(['shot_only'])
    && out.includes('spaceholder-action-journal__tools"><button') && !out.includes('data-target') && !out.includes('attack-shots'), out.match(/__tools">[^]{0,120}/)?.[0]);
  assert('one shot: the summary is still there', out.includes('Shots: 1 · Hits: 1') && out.includes('Guard') && out.includes('×1'));

  const older = createAttackLog({ weapon: { name: 'Pistol' } });
  addShot(older, { apCost: 12, tracks: [{ v: 1, shotId: 'shot_old', groups: [{ kind: 'wall', stages: [{ kind: 'wall', verdict: 'hold', name: 'W', items: [] }] }] }], impacts: [] });
  assert('an entry without ids is opened by the ray of its track', JSON.stringify(buttons(render(older))) === JSON.stringify(['shot_old']), buttons(render(older)));

  const bare = createAttackLog({ weapon: { name: 'Pistol' } });
  addShot(bare, { apCost: 12, impacts: [] });
  assert('an entry with no ray at all has no button', buttons(render(bare)).length === 0 && render(bare).includes('__tools"></span>'));
}

/* -------------------------------------------- */
/*  No hits, nested, empty                      */
/* -------------------------------------------- */

{
  const miss = createAttackLog({ weapon: { name: 'Pistol' } });
  addShot(miss, { apCost: 12, ids: ['shot_miss'], impacts: [] });
  const out = render(miss);
  assert('no hits: says so, no target list', out.includes('No hits') && !out.includes('attack-targets'));
  assert('no hits: the shot can still be opened (the arc, what it flew past)', buttons(out).join() === 'shot_miss');
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

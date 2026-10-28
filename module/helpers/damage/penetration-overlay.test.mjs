/**
 * Smoke tests for the layout of the cards over the tokens (pure functions of the overlay). Runs in plain Node:
 *   node module/helpers/damage/penetration-overlay.test.mjs
 */

import { cardTracks, overlayKey, placeCard } from './penetration-overlay.mjs';

let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const VIEWPORT = { width: 1600, height: 900 };
const SIZE = { width: 236, height: 120 };
const token = (x, y, s = 100) => ({ left: x, top: y, right: x + s, bottom: y + s });
const rectOf = (p) => ({ left: p.left, top: p.top, right: p.left + SIZE.width, bottom: p.top + SIZE.height });
const overlaps = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);

{
  const anchor = token(700, 400);
  const p = placeCard({ anchor, size: SIZE, viewport: VIEWPORT });
  assert('a card hangs above the token, centred on it', Math.abs(p.left + SIZE.width / 2 - 750) < 1 && p.top + SIZE.height <= anchor.top, p);
}
{
  const anchor = token(700, 20);
  const p = placeCard({ anchor, size: SIZE, viewport: VIEWPORT });
  assert('no room above: the card goes below the token', p.top >= anchor.bottom, p);
}
{
  const anchor = token(10, 400);
  const p = placeCard({ anchor, size: SIZE, viewport: VIEWPORT });
  assert('a card at the edge of the screen stays on the screen', p.left >= 6 && p.left + SIZE.width <= VIEWPORT.width - 6 && p.top >= 6, p);
}
{
  const first = placeCard({ anchor: token(700, 400), size: SIZE, viewport: VIEWPORT });
  const second = placeCard({ anchor: token(780, 400), size: SIZE, viewport: VIEWPORT, taken: [rectOf(first)] });
  assert('a card does not cover the card of the token next to it', !overlaps(rectOf(second), rectOf(first)), [first, second]);
  const third = placeCard({ anchor: token(860, 400), size: SIZE, viewport: VIEWPORT, taken: [rectOf(first), rectOf(second)] });
  assert('and neither the third one', !overlaps(rectOf(third), rectOf(first)) && !overlaps(rectOf(third), rectOf(second)), third);
}
{
  const anchor = { left: 500, top: 300, right: 500, bottom: 300 };
  const p = placeCard({ anchor, size: SIZE, viewport: VIEWPORT });
  assert('a point (a wall that was hit) is a valid anchor', p.top + SIZE.height <= 300 && Number.isFinite(p.left), p);
}
{
  const blockers = [];
  for (let x = 0; x < 1600; x += 200) for (let y = 0; y < 900; y += 100) blockers.push({ left: x, top: y, right: x + 220, bottom: y + 110 });
  const p = placeCard({ anchor: token(700, 400), size: SIZE, viewport: VIEWPORT, taken: blockers });
  assert('with no free place the card is still placed on the screen', Number.isFinite(p.left) && Number.isFinite(p.top) && p.left >= 0 && p.top >= 0, p);
}

assert('overlayKey: a token, a place, else the group',
  overlayKey({ tokenId: 't1' }) === 'token:t1' && overlayKey({ at: { x: 10.4, y: 20.6 } }) === 'at:10,21' && overlayKey({ key: 'g2' }) === 'group:g2' && overlayKey(null) === 'group:');

{
  // Two pellets into one target (two parts), one into another, a wall, a hit that left no layers, one that awaits the GM.
  const block = (tokenId, part, streams) => ({ kind: 'body', tokenId, subtitle: part, streams, stages: [{}] });
  const track = {
    v: 1, shotId: 'r', streams: ['a', 'b', 'c', 'd'],
    groups: [
      { kind: 'wall', at: { x: 5, y: 5 }, streams: [0], stages: [{}] },
      block('x', 'Грудь', [0]), block('x', 'Рука', [1]), block('y', 'Грудь', [2]),
      { tokenId: 'z', kind: 'body', streams: [3], stages: [] },
      { tokenId: 'w', kind: 'body', streams: [3], pending: true, stages: [] },
    ],
  };
  const cards = cardTracks(track);
  assert('cardTracks: one card per target, in the order the shot reached them, the parts of a target together',
    cards.map((c) => `${c.key}:${c.track.groups.length}`).join() === 'at:5,5:1,token:x:2,token:y:1,token:w:1', cards.map((c) => `${c.key}:${c.track.groups.length}`));
  assert('cardTracks: a hit with no layers has no card, one that awaits the GM has', !cards.some((c) => c.key === 'token:z') && cards.some((c) => c.key === 'token:w'));
  const x = cards.find((c) => c.key === 'token:x');
  assert('cardTracks: a card has only the streams of its target, numbered from its own first', x.track.streams.join() === 'a,b' && x.track.groups.map((g) => g.streams.join()).join('|') === '0|1', x.track);
  const y = cards.find((c) => c.key === 'token:y');
  assert('cardTracks: …whatever number they had in the shot', y.track.streams.join() === 'c' && y.track.groups[0].streams.join() === '0' && x.anchor === track.groups[1], y.track);
  const plain = cardTracks({ v: 1, shotId: 'solo', groups: [{ kind: 'body', tokenId: 't', stages: [{}] }, { kind: 'body', tokenId: 't', subtitle: 'p', stages: [{}] }] });
  assert('cardTracks: a track that does not say its streams is read as one (its groups are one projectile)', plain.length === 1 && plain[0].track.streams.join() === 'solo' && plain[0].track.groups.every((g) => g.streams.join() === '0'), plain[0].track);
  assert('cardTracks: nothing for junk', cardTracks(null).length === 0 && cardTracks({}).length === 0);
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll penetration-overlay tests passed');

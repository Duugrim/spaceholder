/**
 * Smoke tests for the penetration view model. Runs in plain Node; the strings come from lang/ru.json and
 * lang/en.json, so keys and placeholders are checked too:
 *   node module/helpers/damage/penetration-view-model.test.mjs
 */

import { readFileSync } from 'node:fs';
import { buildPenetrationView, buildShotView, flowGeometry, flowWidth, formatValue, lanesFlowGeometry, streamWidth } from './penetration-view-model.mjs';
import { buildPenetrationTrack } from './penetration-track.mjs';

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

const item = (over = {}) => ({ type: 'ballistic', verdict: 'pass', eIn: 46, eOut: 6, dIn: 12, dOut: 4, ...over });
const stage = (over = {}) => ({
  kind: 'armor', verdict: 'pass', name: 'Кевлар', thickness: 1, items: [item()], ...over,
});
const trackOf = (stages, extra = {}, groupExtra = {}) => buildPenetrationTrack({
  shotId: 'shot_t', projectile: '9x19', energy: 50, ...extra,
  groups: [{ kind: 'body', title: 'Бандит', subtitle: 'Грудь', stages, ...groupExtra }],
});

const stagesOf = (view) => view.groups.flatMap((g) => g.stages);
const headline = (view, i = 0) => stagesOf(view)[i].detail.headline;
const rowsOf = (view, i = 0) => Object.fromEntries(stagesOf(view)[i].detail.rows.map((r) => [r.label, r.value]));

/* -------------------------------------------- */
/*  The wording                                 */
/* -------------------------------------------- */

{
  const view = buildPenetrationView(trackOf([stage()]), ru);
  assert('preview: the sentence of the brief — projectile pierces the layer, energy before → after with percent of the muzzle energy',
    headline(view) === '9x19 пробивает Кевлар 1 мм, энергия 46 (92%) → 6 (12%)', headline(view));
}
{
  const view = buildPenetrationView(trackOf([stage({ verdict: 'hold', items: [item({ verdict: 'hold', eIn: 30, eOut: 0, dOut: 0 })], thickness: 3 })]), ru);
  assert('preview: a layer that holds', headline(view) === 'Кевлар 3 мм останавливает 9x19, энергия 30 (60%) → 0', headline(view));
}
{
  const view = buildPenetrationView(buildPenetrationTrack({ shotId: 's', projectile: '9x19', groups: [{ kind: 'wall', stages: [stage()] }] }), ru);
  assert('preview: without a muzzle energy the first layer is the reference (100%)', headline(view) === '9x19 пробивает Кевлар 1 мм, энергия 46 (100%) → 6 (13%)', headline(view));
}
{
  const view = buildPenetrationView({ v: 1, shotId: 's', projectile: '9x19', groups: [{ kind: 'wall', stages: [stage()] }] }, ru);
  assert('preview: with no energy reference at all, plain numbers and no stream', headline(view) === '9x19 пробивает Кевлар 1 мм, энергия 46 → 6'
    && stagesOf(view)[0].flow === null && view.groups[0].flow === null, headline(view));
}
{
  const view = buildPenetrationView(trackOf([
    stage({ kind: 'tissue', name: 'Грудь', thickness: undefined, items: [item({ eIn: 6, eOut: 2 })], notes: { deposit: 3.5, organs: ['Лёгкое'] } }),
    stage({ kind: 'tissue', name: 'Голова', verdict: 'hold', items: [item({ verdict: 'hold', eIn: 6, eOut: 0, dOut: 0 })] }),
    stage({ kind: 'tissue', name: 'Череп', verdict: 'hold', items: [item({ verdict: 'hold', eIn: 6, eOut: 0, dOut: 0 })], notes: { inShell: true } }),
  ]), ru);
  assert('preview: tissue — through / lodged / the shell stops it',
    headline(view, 0) === '9x19 проходит Грудь насквозь, энергия 6 (12%) → 2 (4%)'
    && headline(view, 1) === '9x19 застревает: Голова, энергия 6 (12%) → 0'
    && headline(view, 2) === 'Череп: оболочка останавливает 9x19, энергия 6 (12%) → 0',
    [headline(view, 0), headline(view, 1), headline(view, 2)]);
  const rows = rowsOf(view, 0);
  assert('preview: tissue lists the deposit and the organs', rows['Ткань получает урона'] === '3.5' && rows['Задеты органы'] === 'Лёгкое', rows);
  assert('rows: tissue has no thickness label (the one on it is the shell)', stagesOf(view)[0].thicknessLabel === '');
  assert('verdict labels: tissue says through / lodged, not pierced / stopped',
    stagesOf(view)[0].verdictLabel === 'Насквозь' && stagesOf(view)[1].verdictLabel === 'Застряла');
}
{
  const view = buildPenetrationView(trackOf([
    stage({ verdict: 'skip', skip: 'gap', items: [], notes: { coverage: 60 } }),
    stage({ verdict: 'skip', skip: 'degraded', name: 'Керамика', items: [item({ verdict: 'skip', eIn: 46, eOut: 46 })] }),
  ]), ru);
  assert('preview: a layer missed through a gap, and a worn-out layer', headline(view, 0) === '9x19 проходит в щель покрытия: Кевлар 1 мм пропущен (покрытие 60%)'
    && headline(view, 1) === '9x19 не задевает Керамика 1 мм: слой повреждён', [headline(view, 0), headline(view, 1)]);
  assert('verdict labels: gap and bypass', stagesOf(view)[0].verdictLabel === 'Щель' && stagesOf(view)[1].verdictLabel === 'Обход');
}
{
  const view = buildPenetrationView(buildPenetrationTrack({
    shotId: 's', projectile: '9x19', energy: 50,
    groups: [{ kind: 'wall', stages: [
      { kind: 'wall', verdict: 'hold', name: '', items: [{ type: '', verdict: 'hold', eIn: null, eOut: 0, dIn: 10, dOut: 0 }], notes: { reason: 'opaque' } },
      { kind: 'wall', verdict: 'hold', name: 'Бетон', items: [{ type: '', verdict: 'hold', eIn: null, eOut: 0, dIn: 10, dOut: 0 }], notes: { reason: 'unbounded' } },
    ] }],
  }), ru);
  assert('preview: walls without a material or without a far face', headline(view, 0) === 'Стена: стена без материала останавливает выстрел'
    && headline(view, 1) === 'Бетон: нет дальней грани, выстрел остановлен', [headline(view, 0), headline(view, 1)]);
}
{
  const view = buildPenetrationView(trackOf([stage({
    resist: 40, lostBefore: 3, source: 'Бронежилет',
    items: [item(), item({ type: 'thermal', eIn: 5, eOut: 2, dIn: 4, dOut: 1 })],
    notes: { wear: 0.5, integrity: 7.5, conduct: [{ type: 'concussive', amount: 3 }] },
  })]), ru);
  const rows = rowsOf(view);
  assert('preview: the energy, the resistance, the damage per type "before → after", other types, the loss, wear and the blow handed on',
    rows['Энергия'] === '46 (92%) → 6 (12%)' && rows['Сопротивление слоя'] === '40' && rows['Урон (Баллистический)'] === '12 → 4'
    && rows['Урон (Тепловой)'] === '4 → 1' && rows['Тепловой'] === '5 (10%) → 2 (4%)' && rows['Потеряно до слоя'] === '3'
    && rows['Износ слоя'] === '0.5, целостность 7.5' && rows['Передаёт удар'] === 'Ударный 3', rows);
  assert('preview: the armour piece is its own line', stagesOf(view)[0].detail.source === 'Бронежилет');
}
{
  const view = buildPenetrationView(trackOf([stage({ verdict: 'hold', resist: 180, items: [item({ verdict: 'hold', eIn: 28.8, eOut: 0, dOut: 0 })] })]), ru);
  assert('preview: a layer that held says how much energy it was short by', rowsOf(view)['Не хватило энергии'] === '151.2', rowsOf(view));
}
{
  const view = buildPenetrationView(trackOf([stage()]), en);
  assert('preview: English wording', headline(view) === '9x19 pierces Кевлар 1 mm, energy 46 (92%) → 6 (12%)', headline(view));
}

/* -------------------------------------------- */
/*  The stream                                  */
/* -------------------------------------------- */

assert('flowWidth: share of the muzzle energy, never thinner than the minimum while it carries energy, 0 for none',
  flowWidth(25, 50) === 50 && flowWidth(0.1, 50) === 4 && flowWidth(0, 50) === 0 && flowWidth(80, 50) === 100 && flowWidth(5, 0) === 0 && flowWidth('x', 50) === 0);
{
  const view = buildPenetrationView(trackOf([
    stage({ resist: 10 }),
    stage({ name: 'Сталь', thickness: 4, verdict: 'hold', items: [item({ verdict: 'hold', eIn: 6, eOut: 0, dOut: 0 })], resist: 60 }),
    stage({ name: 'Щель', verdict: 'skip', skip: 'gap', items: [] }),
  ]), ru);
  const [a, b, c] = stagesOf(view);
  assert('stream: a layer narrows it from what entered to what is left; one that holds ends it', a.flow.w0 === 92 && a.flow.w1 === 12 && b.flow.w0 === 12 && b.flow.w1 === 0, [a.flow, b.flow]);
  assert('stream: a layer that took no part has no flow of its own', c.flow === null, c.flow);
  assert('animation: a gap behind the layer that held the projectile has no lane on it (the animation shows it right after the layer before)', c.here === '' && c.stops === '', [c.here, c.stops]);
  assert('stream: the head of the first group runs from the muzzle energy to what enters the first layer', view.groups[0].flow.w0 === 100 && view.groups[0].flow.w1 === 92, view.groups[0].flow);
  assert('view: the layer that holds the projectile is the one it stops at', a.stops === '' && b.stops === '0' && a.here === '0' && b.here === '0' && view.stageCount === 3
    && a.key === 's0' && b.index === 1, [a.stops, b.stops, a.here, b.here]);
  assert('view: the window title names the projectile, the energy label the muzzle energy', view.title === 'Пробитие: 9x19' && view.energyLabel === 'Энергия 50' && view.energy === '50', view);
}
{
  const track = buildPenetrationTrack({
    shotId: 's', projectile: '9x19', energy: 50,
    groups: [
      { kind: 'wall', stages: [stage({ kind: 'wall', name: 'Бетон', thickness: 100, items: [item({ eIn: 40, eOut: 30 })] })] },
      { kind: 'body', title: 'Бандит', subtitle: 'Грудь', stages: [stage({ items: [item({ eIn: 25, eOut: 10 })] })] },
    ],
  });
  const view = buildPenetrationView(track, ru);
  assert('stream: energy lost between two groups (the distance, a glancing hit) is the head of the second',
    view.groups[1].flow.w0 === 60 && view.groups[1].flow.w1 === 50, view.groups[1].flow);
}

{
  // The energy column: the value entering the first layer of a target, then what leaves every layer.
  const view = buildPenetrationView(buildPenetrationTrack({
    shotId: 's', projectile: '9x19', energy: 50,
    groups: [
      { kind: 'wall', stages: [stage({ kind: 'wall', name: 'Бетон', items: [item({ eIn: 40, eOut: 30 })] })] },
      { kind: 'body', title: 'Бандит', stages: [
        stage({ items: [item({ eIn: 25, eOut: 10 })] }),
        stage({ verdict: 'skip', skip: 'gap', items: [] }),
        stage({ verdict: 'skip', skip: 'degraded', name: 'Керамика', items: [item({ verdict: 'skip', eIn: 10, eOut: 10 })] }),
        stage({ kind: 'tissue', name: 'Грудь', verdict: 'hold', items: [item({ verdict: 'hold', eIn: 10, eOut: 0, dOut: 0 })] }),
      ] },
    ],
  }), ru);
  const flows = stagesOf(view).map((s) => s.flow && [s.flow.valueIn, s.flow.valueOut]);
  assert('energy column: the entry value only on the first layer of a target, what leaves every layer, "0" where the layer held; layers that took no part have no numbers',
    JSON.stringify(flows) === JSON.stringify([['40', '30'], ['25', '10'], ['', ''], ['', ''], ['', '0']]), flows);
  const widths = stagesOf(view).map((s) => [s.flow.w0, s.flow.w1]);
  assert('stream: a layer that took no part (a gap, a bypass) lets the stream through as it is — no hole in it, and each piece starts where the one before ended',
    JSON.stringify(widths) === JSON.stringify([[80, 60], [50, 20], [20, 20], [20, 20], [20, 0]]), widths);
  assert('animation: a layer nobody took part in (a gap) is visited by the lane that goes through it, so it is not left for the end; one behind the layer that held it has no visitor',
    stagesOf(view)[2].here === '0' && stagesOf(view)[2].stops === '' && stagesOf(view)[3].here === '0', stagesOf(view).map((s) => s.here));
  const gear = stagesOf(buildPenetrationView(trackOf([
    stage({ source: 'Бронежилет', items: [item({ eIn: 40, eOut: 30 })] }),
    stage({ source: 'Бронежилет', name: 'Сталь', items: [item({ eIn: 30, eOut: 20 })] }),
    stage({ source: 'Каска', name: 'Сталь', items: [item({ eIn: 20, eOut: 10 })] }),
    stage({ name: 'Кожа', source: '', items: [item({ eIn: 10, eOut: 5 })] }),
    stage({ source: 'Бронежилет', name: 'Пластина', items: [item({ eIn: 5, eOut: 3 })] }),
  ]), ru));
  assert('gear: the layers of one piece that follow each other are a run — the name of the piece is on the first, the run ends on the last',
    JSON.stringify(gear.map((s) => [s.pieceName, s.pieceStart, s.pieceEnd, s.inPiece])) === JSON.stringify([
      ['Бронежилет', true, false, true], ['', false, true, true], ['Каска', true, true, true], ['', false, false, false], ['Бронежилет', true, true, true],
    ]), gear.map((s) => [s.pieceName, s.pieceStart, s.pieceEnd]));
  const chain = buildPenetrationView(buildPenetrationTrack({
    shotId: 's', projectile: '9x19', energy: 50,
    groups: [
      { kind: 'body', title: 'А', stages: [stage({ items: [item({ eIn: 40, eOut: 30 })] })] },
      { kind: 'body', title: 'Б', stages: [stage({ items: [item({ eIn: 30, eOut: 20 })] })] },
      { kind: 'body', title: 'В', stages: [stage({ items: [item({ eIn: 18, eOut: 5 })] })] },
    ],
  }), ru);
  assert('energy column: a value is not written twice when the next target is entered with what the last layer let go, but is where energy was lost in between',
    JSON.stringify(stagesOf(chain).map((s) => [s.flow.valueIn, s.flow.valueOut])) === JSON.stringify([['40', '30'], ['', '20'], ['18', '5']]), stagesOf(chain).map((s) => [s.flow.valueIn, s.flow.valueOut]));
  assert('energy column: the head of a group has no numbers of its own', view.groups.every((g) => !g.flow || (g.flow.valueIn === '' && g.flow.valueOut === '')));
}
{
  const g = flowGeometry(100, 50);
  assert('flowGeometry: a shape as wide as the energy entering at the top and leaving at the bottom, the muzzle energy being 80% of the column',
    g.shape === 'M 10 0 L 90 0 L 70 100 L 30 100 Z' && g.edges === 'M 10 0 L 30 100 M 90 0 L 70 100', g);
  assert('flowGeometry: a stream that ends is a point', flowGeometry(20, 0).shape === 'M 42 0 L 58 0 L 50 100 L 50 100 Z');
  const lanes = lanesFlowGeometry([{ w0: 100, w1: 100 }, null, { w0: 50, w1: 0 }]);
  assert('lanesFlowGeometry: the column is cut into a slot for each lane, a lane that is not here is left empty',
    lanes.shape === 'M 3.3 0 L 30 0 L 30 100 L 3.3 100 Z M 76.7 0 L 90 0 L 83.3 100 L 83.3 100 Z', lanes);
  assert('streamWidth: room for a lane to be seen, within bounds', streamWidth(1) === 64 && streamWidth(3) === 64 && streamWidth(8) === 112 && streamWidth(16) === 160
    && streamWidth(8, { base: 40, perLane: 10, max: 120 }) === 80, [streamWidth(1), streamWidth(8), streamWidth(16)]);
}

/* -------------------------------------------- */
/*  Groups                                      */
/* -------------------------------------------- */

{
  const track = buildPenetrationTrack({
    shotId: 's', projectile: '9x19', energy: 50,
    groups: [
      { kind: 'wall', stages: [stage({ kind: 'wall', name: 'Бетон', thickness: 100 })] },
      { kind: 'body', title: 'Бандит', subtitle: 'Грудь', img: 'tokens/bandit.webp', hit: 0, scale: 0.6, quality: 'скользящее', stages: [stage()] },
      { kind: 'body', title: 'Клерк', hit: 1, pending: true, stages: [] },
    ],
  });
  const bandit = { shotId: 's', name: 'Бандит', kind: 'line', outcome: 'hit', clock: 3, centrality: 0.8, energyScale: 0.6, qualityLabel: 'скользящее', partName: 'Грудь', damage: [] };
  const clerk = { shotId: 's', name: 'Клерк', kind: 'line', outcome: 'hit', clock: 12, queued: true, partName: 'Рука' };
  const entry = {
    n: 2, impacts: [bandit, clerk],
    apCost: 10, baseApCost: 10, luck: { zoneLabel: 'Красная зона', confidence: 1 }, spread: null, passes: [],
  };
  const view = buildPenetrationView(track, ru, { entry, impacts: [[], [bandit], [clerk]] });
  const [wall, body, pending] = view.groups;
  assert('groups: a wall is titled Стена, a body by its owner and part, with its picture', wall.title === 'Стена' && wall.subtitle === '' && wall.img === ''
    && body.title === 'Бандит' && body.subtitle === 'Грудь' && body.img === 'tokens/bandit.webp');
  assert('groups: how much of the energy reached the body, and why', body.chip === 'скользящее ×0.6' && wall.chip === '', [body.chip, wall.chip]);
  assert('groups: the chip comes in parts, so a card with little room can keep the number and drop the word',
    body.chipQuality === 'скользящее' && body.chipScale === '×0.6' && wall.chipQuality === '' && wall.chipScale === '', [body.chipQuality, body.chipScale]);
  assert('groups: a body whose damage waits for the GM says so', pending.pending && pending.pendingLabel === 'Урон ждёт ГМа' && pending.stages.length === 0, pending);
  const bodyRows = Object.fromEntries(body.info.map((r) => [r.label, r.value]));
  assert('groups: the facts of the hit come with the group', bodyRows['Центровость'] === '0.8' && bodyRows['Часть тела'] === 'Грудь'
    && Object.fromEntries(pending.info.map((r) => [r.label, r.value]))['Статус'] === 'ждёт ГМа' && wall.info.length === 0, [body.info, pending.info]);
  assert('view: the facts of the shot, the shot number', view.shotLabel === 'Выстрел 2' && view.shot.rows.some((r) => r.label === 'Дуга' && r.value.startsWith('Красная зона')), view.shot);
  assert('groups: the damage of the hit is the summary of a folded group', body.summary === 'без ранения' && pending.summary === 'ждёт ГМа' && pending.summaryTone === 'warn', [body.summary, pending.summary]);
  assert('groups: three blocks are open, no foldable part is folded', view.groups.every((g) => !g.collapsed) && view.foldable && !view.folded);
}
{
  const view = buildPenetrationView(null, ru, { entry: { n: 3, ids: ['ray_a'], impacts: [], passes: ['Ящик пролетел'], apCost: 5 }, projectile: 'АК-74' });
  assert('view: a ray that met nothing has no groups but the facts of the shot, named by the weapon',
    view.empty && view.groups.length === 0 && view.projectile === 'АК-74' && view.shot.passes[0] === 'Ящик пролетел' && view.emptyLabel === 'Снаряд ничего не встретил', view);
}
{
  const view = buildPenetrationView(trackOf([stage()], { projectile: '' }), ru);
  assert('view: an unnamed projectile is just a projectile', view.projectile === 'Снаряд' && view.title === 'Пробитие: Снаряд', view.title);
}

{
  // Hits the track has no layers for: still targets, with their facts, in the order of the hits.
  const track = buildPenetrationTrack({
    shotId: 's', projectile: '9x19', energy: 50,
    groups: [{ kind: 'body', title: 'Второй', subtitle: 'Грудь', hit: 1, stages: [stage()] }],
  });
  const entry = {
    n: 1, ids: ['s'], tracks: [track], impacts: [
      { shotId: 's', name: 'Первый', kind: 'line', outcome: 'hit', clock: 3, centrality: 0.9, partName: 'Рука', damage: [] },
      { shotId: 's', name: 'Второй', kind: 'line', outcome: 'hit', clock: 12, partName: 'Грудь' },
      { shotId: 's', name: 'Третий', kind: 'area', outcome: 'area', clock: 9, partName: 'Нога', coverage: 1, coverageMode: 'full', effectScale: 1 },
      { shotId: 's', name: 'Мимо', kind: 'line', outcome: 'pass' },
    ],
  };
  const view = buildShotView(entry, ru);
  assert('hits without layers: a target of their own, before the one with layers when they came first, after when they came last',
    view.groups.map((g) => g.title).join() === 'Первый,Второй,Третий' && view.groups.map((g) => g.key).join() === 'g0,g1,g2', view.groups.map((g) => g.title));
  assert('hits without layers: no rows, the facts of the hit, the part on the head', view.groups[0].stages.length === 0 && view.groups[0].subtitle === 'Рука'
    && view.groups[0].info.some((r) => r.label === 'Центровость' && r.value === '0.9') && view.groups[2].info.some((r) => r.label === 'Покрытие'), view.groups[0]);
  assert('hits without layers: a token that was flown past is not a target', !view.groups.some((g) => g.title === 'Мимо'));
  const none = buildShotView({ n: 1, ids: ['s'], impacts: [{ shotId: 's', name: 'Цель', kind: 'line', outcome: 'hit', clock: 3, centrality: 0.5 }] }, ru);
  assert('hits without a track at all: the window is not empty — the target and its facts', !none.empty && none.groups.length === 1 && none.groups[0].info.length > 0
    && none.groups[0].stages.length === 0 && !none.groups[0].foldable, none.groups);
}

/* -------------------------------------------- */
/*  Lanes: several projectiles in one block      */
/* -------------------------------------------- */

{
  // Three pellets: the plate stops the third, the tissue is reached by two.
  const lane = (n, over = {}) => item({ lane: n, eIn: 40, eOut: 30, dIn: 10, dOut: 7.5, ...over });
  const track = buildPenetrationTrack({
    shotId: 's', projectile: 'Картечь', energy: 40,
    groups: [{
      kind: 'body', title: 'Бандит', subtitle: 'Грудь', lanes: 3, rays: ['a', 'b', 'c'], parallel: true,
      stages: [
        stage({ name: 'Сталь', thickness: 1, resist: 10, items: [lane(0), lane(1), lane(2, { verdict: 'hold', eIn: 20, eOut: 0, dOut: 0 })] }),
        stage({ kind: 'tissue', name: 'Грудь', thickness: undefined, items: [lane(0, { eIn: 30, eOut: 12 }), lane(1, { eIn: 30, eOut: 12 })] }),
      ],
    }],
  });
  {
    // The rightmost pellet ends on the first layer of a vest: the second layer is narrower, but its text stays under the first's.
    const vestOf = (stages) => buildPenetrationView(buildPenetrationTrack({
      shotId: 's', projectile: 'Картечь', energy: 40,
      groups: [{ kind: 'body', title: 'Бандит', subtitle: 'Грудь', lanes: 3, rays: ['a', 'b', 'c'], parallel: true, stages }],
    }), ru).groups[0].stages;
    const held = lane(0, { verdict: 'hold', eIn: 20, eOut: 0, dOut: 0 });
    const [first, second] = vestOf([
      stage({ name: 'Сталь', source: 'Бронежилет', items: [held, lane(1), lane(2)] }),
      stage({ name: 'Кевлар', source: 'Бронежилет', items: [lane(1, { eIn: 30, eOut: 20 }), lane(2, { eIn: 30, eOut: 20 })] }),
    ]);
    assert('gear: the rows of one piece keep their text where the widest of them has it, the rows of no piece step left as the lanes end',
      first.used === 3 && second.used === 2 && first.pieceUsed === 3 && second.pieceUsed === 3, [first.used, second.used, first.pieceUsed, second.pieceUsed]);
    const [, other] = vestOf([
      stage({ name: 'Сталь', source: 'Бронежилет', items: [held, lane(1), lane(2)] }),
      stage({ name: 'Кевлар', source: '', items: [lane(1, { eIn: 30, eOut: 20 }), lane(2, { eIn: 30, eOut: 20 })] }),
    ]);
    assert('gear: a layer of no piece steps left on its own', other.used === 2 && other.pieceUsed === 2, [other.used, other.pieceUsed]);
  }
  const view = buildPenetrationView(track, ru);
  const [block] = view.groups;
  const [plate, tissue] = block.stages;
  assert('lanes: the block knows its projectiles', block.lanes === 3 && block.lanesLabel === '×3' && block.lanesTip === 'Снарядов: 3' && view.streamWidth === 64, block);
  assert('lanes: a lane for each projectile in the stream, cut from the same column', (plate.flow.shape.match(/M/g) ?? []).length === 3, plate.flow.shape);
  assert('lanes: the numbers are the sums of what the projectiles carry', plate.flow.valueIn === '100' && plate.flow.valueOut === '60' && tissue.flow.valueOut === '24', [plate.flow, tissue.flow]);
  assert('lanes: the layer says how many got through', plate.verdictLabel === '2 из 3' && tissue.verdictLabel === 'Насквозь', [plate.verdictLabel, tissue.verdictLabel]);
  assert('lanes: the lane that is held stops there and is gone after it', plate.stops === '0' && plate.here === '0 1 2' && tissue.stops === '' && tissue.here === '1 2'
    && plate.widths === '0 75 75', [plate.stops, plate.here, tissue.here, plate.widths]);
  assert('lanes: the preview counts them and gives a line for each', plate.detail.headline === 'Сталь 1 мм: пробивают 2 из 3 снарядов, остановлено 1'
    && rowsOf(view, 0)['Снаряд 1'] === '40 (100%) → 30 (75%)' && rowsOf(view, 0)['Снаряд 3'] === '20 (50%) → 0' && rowsOf(view, 0)['Урон (Баллистический)'] === '30 → 15', rowsOf(view, 0));
  assert('lanes: the head of a block of several projectiles comes from the muzzle for each', block.flow.shape !== '' && block.here === '0 1 2' && block.widths === '100 100 100', [block.here, block.widths]);
  const all = buildPenetrationView(buildPenetrationTrack({
    shotId: 's', projectile: 'Картечь', energy: 40,
    groups: [{ kind: 'body', title: 'Б', lanes: 2, rays: ['a', 'b'], stages: [stage({ items: [lane(0), lane(1)] })] }],
  }), ru);
  assert('lanes: when all of them get through it says so, with the usual verdict',
    all.groups[0].stages[0].verdictLabel === 'Пробито' && all.groups[0].stages[0].detail.headline === 'Кевлар 1 мм: пробивают все снаряды (2)', all.groups[0].stages[0]);
}
{
  // A list of targets (a blast): each starts from the muzzle.
  const body = (title) => ({ kind: 'body', title, subtitle: 'Грудь', parallel: true, stages: [stage({ items: [item({ eIn: 40, eOut: 20 })] })] });
  const many = buildPenetrationView(buildPenetrationTrack({ shotId: 's', projectile: 'Граната', energy: 50, groups: ['А', 'Б', 'В', 'Г', 'Д'].map(body) }), ru);
  assert('blast: every target is open, whatever their number (the user folds them)', many.groups.every((g) => !g.collapsed && g.foldable) && !many.folded, many.groups.map((g) => g.collapsed));
  assert('blast: the stream of each begins at the muzzle energy, not where the target before it ended', many.groups.every((g) => g.flow.w0 === 100), many.groups.map((g) => g.flow.w0));
  assert('blast: the number that enters each target is written (nothing before it to read it from)', many.groups.every((g) => g.stages[0].flow.valueIn === '40'));
}

/* -------------------------------------------- */
/*  A target and its parts                       */
/* -------------------------------------------- */

{
  // Two pellets in one target, in different parts; a third in another target.
  const ray = (id, title, part, eOut = 10) => buildPenetrationTrack({
    shotId: id, projectile: 'Дробь', energy: 40,
    groups: [{ kind: 'body', title, subtitle: part, tokenId: title, hit: 0, scale: part === 'Голова' ? 0.9 : undefined, quality: part === 'Голова' ? 'скользящее' : undefined,
      stages: [stage({ name: 'Сталь', items: [item({ eIn: 40, eOut })] }), stage({ kind: 'tissue', name: part, items: [item({ eIn: eOut, eOut: 2 })] })] }],
  });
  const hit = (shotId, name, partName, amount) => ({ shotId, name, kind: 'line', outcome: 'hit', clock: 3, centrality: 0.7, energyScale: 1, partName, damage: [{ type: 'ballistic', amount }] });
  const entry = {
    n: 1, ids: ['a', 'b', 'c'],
    tracks: [ray('a', 'Громила', 'Ступня'), ray('b', 'Бандит', 'Грудь'), ray('c', 'Громила', 'Голова')],
    impacts: [hit('a', 'Громила', 'Ступня', 5), hit('b', 'Бандит', 'Грудь', 6), hit('c', 'Громила', 'Голова', 7)],
  };
  const view = buildShotView(entry, ru);
  const [thug, bandit] = view.groups;
  assert('target: one group for a target, whatever the parts of it that were hit (and the parts stand together on the list)',
    view.groups.length === 2 && thug.title === 'Громила' && bandit.title === 'Бандит' && thug.parts.length === 2 && thug.multi && !bandit.multi, view.groups.map((g) => g.title));
  assert('target: the parts are told by name on the group, each with its own layers, the stages of the group are all of them in order',
    thug.subtitle === 'Ступня, Голова' && thug.parts.map((p) => p.partName).join() === 'Ступня,Голова' && thug.stages.length === 4 && thug.parts[1].stages.length === 2, [thug.subtitle, thug.stages.length]);
  assert('target: the lanes of a target go down to its parts — the head of the target is passed by all of them, each part takes its own',
    thug.here === '1 2' && thug.parts[0].here === '2' && thug.parts[1].here === '1' && bandit.here === '0', [thug.here, thug.parts.map((p) => p.here), bandit.here]);
  const lanesIn = (flow) => (flow?.shape.match(/M/g) ?? []).length;
  assert('target: the head of a target with several parts shows all the lanes going down (3 streams), a part narrows its own lane',
    lanesIn(thug.flow) === 3 && lanesIn(thug.parts[0].flow) === 3 && lanesIn(thug.parts[1].flow) === 2 && thug.parts[0].stages[0].flow && lanesIn(thug.parts[1].stages[0].flow) === 2,
    [lanesIn(thug.flow), lanesIn(thug.parts[0].flow), lanesIn(thug.parts[1].flow)]);
  assert('target: folded, the lanes of the target narrow to what they carry out of it', lanesIn(thug.flow.folded) === 3, thug.flow.folded);
  assert('target: the lanes end from the right and the rows below them take only the lanes they need — the room is given back (the text of the row moves left)',
    thug.used === 3 && thug.parts[0].used === 3 && thug.parts[0].stages[0].used === 3 && thug.parts[1].used === 2 && thug.parts[1].stages[0].used === 2 && bandit.used === 1 && bandit.stages[0].used === 1,
    [thug.used, thug.parts.map((p) => p.used), bandit.used]);
  assert('target: a row narrower than the column draws its lanes in a column of its own width (the lane keeps its place, the outline is cut for fewer slots)',
    lanesIn(bandit.flow) === 1 && bandit.flow.shape.startsWith('M 10 0 L 90 0'), bandit.flow.shape);
  assert('target: the quality and the share of the energy belong to the part when there are several parts, to the head when there is one',
    thug.chip === '' && thug.parts[1].chip === 'скользящее ×0.9' && thug.parts[1].chipScale === '×0.9' && bandit.chip === '' && thug.lanes === 2 && thug.lanesLabel === '×2' && bandit.lanesLabel === '', [thug.chip, thug.parts[1].chip]);
  const rowsOfInfo = (info) => Object.fromEntries(info.map((r) => [r.label, r.value]));
  assert('target: the facts of the target add the parts up, the facts of a part are its own',
    rowsOfInfo(thug.info)['Урон'] === '12 Баллистический' && rowsOfInfo(thug.info)['Часть тела'] === 'Ступня, Голова' && rowsOfInfo(thug.parts[1].info)['Урон'] === '7 Баллистический', [thug.info, thug.parts[1].info]);
}

/* -------------------------------------------- */
/*  A shot: the lanes of all its streams         */
/* -------------------------------------------- */

{
  // Three pellets, each in a target of its own: the third is held by its target's armour.
  const ray = (id, title, items, extra = {}) => buildPenetrationTrack({
    shotId: id, projectile: 'Дробь', energy: 40,
    groups: [{ kind: 'body', title, subtitle: 'Грудь', hit: 0, stages: [stage({ name: 'Сталь', items }), stage({ kind: 'tissue', name: 'Грудь', items: [item({ eIn: 20, eOut: 5 })] })], ...extra }],
  });
  const pass = (eOut) => [item({ eIn: 40, eOut })];
  const held = [item({ verdict: 'hold', eIn: 40, eOut: 0, dOut: 0 })];
  const hit = (shotId, name) => ({ shotId, name, kind: 'line', outcome: 'hit', clock: 3, centrality: 0.7, energyScale: 1, partName: 'Грудь', damage: [{ type: 'ballistic', amount: 5 }] });
  const entry = {
    n: 1, ids: ['a', 'b', 'c'],
    tracks: [ray('a', 'А', pass(20)), ray('b', 'Б', pass(20)), ray('c', 'В', held)],
    impacts: [hit('a', 'А'), hit('b', 'Б'), hit('c', 'В')],
  };
  const view = buildShotView(entry, ru);
  const lanesOf = (flow) => (flow?.shape.match(/M/g) ?? []).length;
  const [first, second, third] = view.groups;
  assert('shot: a lane for each projectile, the column as wide as they need', view.lanes === 3 && view.groups.every((g) => g.slots === 3 && g.lanes === 1) && view.streamWidth === 64, view.lanes);
  assert('shot: the first projectile is the rightmost lane, its records come first, then the next one from the right',
    first.here === '2' && second.here === '1' && third.here === '0', [first.here, second.here, third.here]);
  assert('shot: all the lanes run down from the top, one by one dropping out where their records end',
    lanesOf(first.flow) === 3 && lanesOf(second.flow) === 2 && lanesOf(third.flow) === 1
    && lanesOf(first.stages[0].flow) === 3 && lanesOf(second.stages[0].flow) === 2 && lanesOf(third.stages[1].flow) === 1,
    [lanesOf(first.flow), lanesOf(second.flow), lanesOf(third.flow)]);
  assert('shot: a lane that is not of the block goes by it as it is, one that is over is gone', lanesOf(first.stages[1].flow) === 3 && lanesOf(second.stages[1].flow) === 2, [lanesOf(first.stages[1].flow), lanesOf(second.stages[1].flow)]);
  assert('shot: the layer that holds a projectile names its lane, the lanes after it have no such stop', third.stages[0].stops === '0' && first.stages[0].stops === '' && third.stages[0].here === '0', [third.stages[0].stops]);
  assert('shot: what the rows say to the animation: every lane\'s energy after the row', first.stages[0].widths.split(' ').length === 3);
  assert('shot: a block is told from the rows of the other lanes passing by — the lane that is not here has no stage of its own',
    first.stages.every((s) => s.here === '2') && second.stages.every((s) => s.here === '1'), first.stages.map((s) => s.here));
  assert('shot: a block that holds a projectile in its layers tells the head of a folded block too', third.stopsFolded === '0' && first.stopsFolded === '', [third.stopsFolded, first.stopsFolded]);
  assert('shot: the head has outlines for a folded block as well (what the lanes carry out of the block)', first.flow.folded && lanesOf(first.flow.folded) === 3, first.flow.folded);
}
{
  // One projectile that goes wall → body: the body takes the stream up where the wall left it.
  const wall = { kind: 'wall', stages: [stage({ kind: 'wall', name: 'Бетон', items: [item({ eIn: 40, eOut: 30 })] })] };
  const track = (bodyIn) => buildPenetrationTrack({
    shotId: 'r', projectile: '9x19', energy: 50,
    groups: [wall, { kind: 'body', title: 'Бандит', subtitle: 'Грудь', hit: 0, stages: [stage({ items: [item({ eIn: bodyIn, eOut: 10 })] })] }],
  });
  const impacts = [{ shotId: 'r', name: 'Бандит', kind: 'line', outcome: 'hit', clock: 3, partName: 'Грудь', damage: [] }];
  const smooth = buildShotView({ n: 1, ids: ['r'], tracks: [track(30)], impacts }, ru);
  const lossy = buildShotView({ n: 1, ids: ['r'], tracks: [track(25)], impacts }, ru);
  const [, bodySmooth] = smooth.groups;
  const [, bodyLossy] = lossy.groups;
  assert('shot: a block after a wall takes up the stream where the wall left it (no taper in the head, no number written twice)',
    bodySmooth.flow.w0 === 60 && bodySmooth.flow.w1 === 60 && bodySmooth.stages[0].flow.valueIn === '' && smooth.groups[0].flow.w0 === 100, [bodySmooth.flow, bodySmooth.stages[0].flow.valueIn]);
  assert('shot: energy lost on the way to it (distance, a glancing hit) is the head of the block, and the number is written',
    bodyLossy.flow.w0 === 60 && bodyLossy.flow.w1 === 50 && bodyLossy.stages[0].flow.valueIn === '25', [bodyLossy.flow, bodyLossy.stages[0].flow.valueIn]);
}
{
  // A blast: every target is a stream of its own, all starting at the muzzle.
  const body = (title) => ({ kind: 'body', title, subtitle: 'Грудь', hit: 0, parallel: true, stages: [stage({ items: [item({ eIn: 40, eOut: 20 })] })] });
  const ray = buildPenetrationTrack({ shotId: 'blast', projectile: 'Граната', energy: 50, groups: ['А', 'Б', 'В'].map((t, i) => ({ ...body(t), hit: i })) });
  const impacts = ['А', 'Б', 'В'].map((name) => ({ shotId: 'blast', name, kind: 'area', outcome: 'area', coverage: 1, partName: 'Грудь' }));
  const view = buildShotView({ n: 1, ids: ['blast'], tracks: [ray], impacts }, ru);
  assert('shot: the targets of a blast are lanes side by side, each from the muzzle energy (not from the target before it)',
    view.lanes === 3 && view.groups.map((g) => g.here).join() === '2,1,0' && view.groups.every((g) => g.flow.w0 === 80 || g.flow.w0 === 100), view.groups.map((g) => [g.here, g.flow?.w0]));
}
{
  // More streams than the column holds: the rest have no lane, their blocks are still on the list.
  const rays = Array.from({ length: 20 }, (_, i) => buildPenetrationTrack({
    shotId: `r${i}`, projectile: 'Дробь', energy: 40,
    groups: [{ kind: 'body', title: `Ц${i}`, subtitle: 'Грудь', hit: 0, stages: [stage({ items: [item({ eIn: 40, eOut: 20 })] })] }],
  }));
  const impacts = rays.map((r, i) => ({ shotId: r.shotId, name: `Ц${i}`, kind: 'line', outcome: 'hit', clock: 3, partName: 'Грудь', damage: [] }));
  const view = buildShotView({ n: 1, ids: rays.map((r) => r.shotId), tracks: rays, impacts }, ru);
  assert('shot: a column holds 16 lanes; the 17th projectile and the ones after it have a block, but no lane', view.lanes === 16 && view.groups.length === 20
    && view.groups[15].here === '0' && view.groups[16].here === '' && view.groups[19].here === '', view.groups.map((g) => g.here).join('|'));
}

assert('formatValue', formatValue(3.14159) === '3.14' && formatValue('x') === '?' && formatValue(2) === '2');

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll penetration-view-model tests passed');

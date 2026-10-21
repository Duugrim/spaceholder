/**
 * "Калькулятор" tab: place a shot on a line and watch what the current mechanics do to it.
 *
 * Scenario: a projectile (ammo, optionally fired from a weapon) flies from the muzzle past walls to one
 * target. The server runs the game's own resolver on database items; every element reports what the
 * projectile had before and after.
 */

import { el, clear, uid, clone, fmt, pct, readStored, writeStored, debounce } from './util.js';
import { db, flush, getItem, itemsOfKind, outcomeOf, partOf, weaponLabel, touch, emitChange, onChange } from './state.js';
import { api } from './api.js';
import {
  armorPicker, button, checkbox, chip, iconButton, materialTag, numInput, openModal, segmented, selectEl, textInput, toast,
} from './widgets.js';
import { FACES, damageTypeLabel } from './schema.js';
import { damageTypeColor, partColor } from './icons.js';

const SCENARIO_KEY = 'balance.calc.scenario';

const defaultScenario = () => ({
  source: { kind: 'ammo', itemId: '', weaponId: '', lineId: '', effort: 100 },
  options: { valuesMode: 'values', falloff: true, random: 0.5 },
  walls: [],
  target: {
    distance: 5, partId: 'head', hitDirection: 'front', armor: { kind: 'none' }, energyScalePct: 100, shots: 1, partHp: '',
  },
});

let scenario = Object.assign(defaultScenario(), readStored(SCENARIO_KEY, {}));
let root = null;
let resultBox = null;
let lastResult = null;
let lastError = null;

const persist = () => writeStored(SCENARIO_KEY, scenario);

/* ------------------------------------------------------------------ *
 *  Request                                                            *
 * ------------------------------------------------------------------ */

function wallLayers(wall) {
  if (wall.spec?.kind === 'preset') return clone(getItem(wall.spec.presetId)?.values?.layers ?? []);
  return clone(wall.spec?.layers ?? []);
}

export function buildRequest(sc = scenario) {
  const src = sc.source;
  const elements = [];
  for (const wall of sc.walls) {
    for (const layer of wallLayers(wall)) {
      elements.push({ type: 'wall', distance: wall.distance, material: layer.material, thickness: layer.thickness });
    }
  }
  const t = sc.target;
  if (t) {
    const part = partOf(t.partId);
    elements.push({
      type: 'target', distance: t.distance, partId: part?.slot ?? t.partId, hitDirection: t.hitDirection, armor: t.armor,
      energyScale: Math.max(0, Math.min(100, Number(t.energyScalePct) || 0)) / 100, shots: t.shots,
      partHp: Number(t.partHp) > 0 ? Number(t.partHp) : (part?.hp || undefined),
    });
  }
  return {
    valuesMode: sc.options.valuesMode,
    falloff: sc.options.falloff,
    random: sc.options.random,
    partNames: Object.fromEntries(db.dictionaries.parts.map((p) => [p.slot, p.label])),
    source: {
      kind: src.kind, itemId: src.itemId, weaponId: src.kind === 'ammo' ? (src.weaponId || undefined) : undefined,
      lineId: src.lineId || undefined, effort: src.effort,
    },
    elements,
  };
}

const run = debounce(async () => {
  persist();
  if (!scenario.source.itemId) {
    lastResult = null;
    lastError = 'Выберите патрон или оружие.';
    renderResult();
    return;
  }
  try {
    await flush();
    lastResult = await api.simulate(buildRequest());
    lastError = null;
  } catch (e) {
    lastResult = null;
    lastError = e.message;
  }
  renderResult();
}, 120);

/* ------------------------------------------------------------------ *
 *  Scenario form                                                      *
 * ------------------------------------------------------------------ */

function ammoOptions() {
  return [{ value: '', label: '— патрон —' }, ...itemsOfKind('ammo').map((a) => ({ value: a.id, label: a.name }))];
}

function weaponOptions({ melee }) {
  const weapons = itemsOfKind('weapon').filter((w) => {
    const hasOwnDamage = (w.values.lines ?? []).some((l) => (l.damage ?? []).length);
    return melee ? hasOwnDamage : true;
  });
  return [{ value: '', label: melee ? '— оружие —' : '— без оружия —' }, ...weapons.map((w) => ({ value: w.id, label: w.name }))];
}

function sourceBlock() {
  const s = scenario.source;
  const isAmmo = s.kind === 'ammo';
  const weapon = isAmmo ? getItem(s.weaponId) : getItem(s.itemId);
  const lineOptions = weapon
    ? (weapon.values.lines ?? []).filter((l) => isAmmo || (l.damage ?? []).length).map((l) => ({ value: l.id, label: l.name }))
    : [];
  const ammoValues = isAmmo ? getItem(s.itemId)?.values : null;
  const notes = [];
  if (ammoValues?.multishot?.enabled) notes.push(`Несколько лучей (${ammoValues.multishot.count}): считается один луч`);
  if (ammoValues?.onHitSplash?.enabled) notes.push('Взрыв при попадании: радиус не считается');
  return el('section', { class: 'card' },
    el('h3', null, 'Выстрел'),
    el('div', { class: 'kv-row' },
      segmented([{ value: 'ammo', label: 'Патрон' }, { value: 'weapon', label: 'Собственный урон оружия' }], s.kind, (v) => {
        scenario.source = { ...defaultScenario().source, kind: v };
        rerenderForm();
        run();
      })),
    isAmmo
      ? el('div', { class: 'kv-row' },
        selectEl(ammoOptions(), s.itemId, (v) => { s.itemId = v; rerenderForm(); run(); }, { title: 'Патрон' }),
        el('span', { class: 'muted' }, 'из'),
        selectEl(weaponOptions({ melee: false }), s.weaponId, (v) => { s.weaponId = v; s.lineId = ''; rerenderForm(); run(); }, { title: 'Оружие (множитель энергии)' }),
        s.weaponId && lineOptions.length > 1 && selectEl(lineOptions, s.lineId || lineOptions[0].value, (v) => { s.lineId = v; run(); }, { title: 'Линия оружия' }))
      : el('div', { class: 'kv-row' },
        selectEl(weaponOptions({ melee: true }), s.itemId, (v) => { s.itemId = v; s.lineId = ''; rerenderForm(); run(); }, { title: 'Оружие' }),
        lineOptions.length > 0 && selectEl(lineOptions, s.lineId || lineOptions[0].value, (v) => { s.lineId = v; run(); }, { title: 'Линия оружия' }),
        el('label', { class: 'kv kv-compact' }, el('span', { class: 'kv-label' }, 'Усилие (СИЛ)'), numInput(s.effort, (v) => { s.effort = v; run(); }, { min: 0, width: '5rem', title: 'Усилие атакующего' }))),
    notes.length > 0 && el('p', { class: 'hint' }, notes.join(' · ')));
}

function optionsBlock() {
  const o = scenario.options;
  return el('section', { class: 'card' },
    el('h3', null, 'Условия расчёта'),
    el('div', { class: 'kv-row' },
      segmented([{ value: 'values', label: 'Рабочие значения' }, { value: 'base', label: 'Игровые значения' }], o.valuesMode, (v) => { o.valuesMode = v; rerenderForm(); run(); }),
      el('label', { class: 'check', title: 'Спад урона и пробития по дистанции' }, checkbox(o.falloff, (on) => { o.falloff = on; run(); }), 'Спад по дистанции'),
      el('label', { class: 'kv kv-compact', title: 'Значение, которое получает каждый случайный выбор резолвера' },
        el('span', { class: 'kv-label' }, 'Бросок 0–1'), numInput(o.random, (v) => { o.random = Math.max(0, Math.min(0.999, v)); run(); }, { min: 0, max: 0.999, step: 0.1, width: '4.6rem' }))));
}

function wallRow(wall, index) {
  return el('div', { class: 'elem' },
    el('span', { class: 'elem-tag' }, 'Стена'),
    el('label', { class: 'kv kv-compact' }, el('span', { class: 'kv-label' }, 'Дистанция, м'), numInput(wall.distance, (v) => { wall.distance = Math.max(0, v); run(); }, { min: 0, width: '5rem' })),
    armorPicker(wall.spec, (spec) => { wall.spec = spec; run(); }, { mode: 'wall', title: 'Материал стены' }),
    iconButton('✕', 'Убрать стену', () => { scenario.walls.splice(index, 1); rerenderForm(); run(); }));
}

function targetBlock() {
  const t = scenario.target;
  if (!t) return el('div', { class: 'elem elem-empty' }, button('+ Цель', () => { scenario.target = defaultScenario().target; rerenderForm(); run(); }, { cls: 'btn-small' }));
  const parts = db.dictionaries.parts.map((p) => ({ value: p.id, label: p.label }));
  return el('div', { class: 'elem elem-target' },
    el('span', { class: 'elem-tag elem-tag-target' }, 'Цель'),
    el('div', { class: 'kv-row' },
      el('label', { class: 'kv kv-compact' }, el('span', { class: 'kv-label' }, 'Дистанция, м'), numInput(t.distance, (v) => { t.distance = Math.max(0, v); run(); }, { min: 0, width: '5rem' })),
      el('label', { class: 'kv kv-compact' }, el('span', { class: 'kv-label' }, 'Часть тела'), selectEl(parts, t.partId, (v) => { t.partId = v; rerenderForm(); run(); }, { class: 'field f-part', title: 'Часть тела', style: `--part:${partColor(t.partId)}` })),
      el('label', { class: 'kv kv-compact' }, el('span', { class: 'kv-label' }, 'Сторона'), selectEl(FACES, t.hitDirection, (v) => { t.hitDirection = v; rerenderForm(); run(); }, { title: 'Сторона попадания' })),
      iconButton('✕', 'Убрать цель', () => { scenario.target = null; rerenderForm(); run(); })),
    t.hitDirection === 'side' && el('p', { class: 'hint' }, 'У анатомий есть только грани «спереди» и «сзади»: удар сбоку считается как по первой грани части — так же, как спереди.'),
    el('div', { class: 'kv-row' },
      el('label', { class: 'kv kv-compact' }, el('span', { class: 'kv-label' }, 'Броня'), armorPicker(t.armor, (spec) => { t.armor = spec; run(); }, { title: 'Броня цели' }))),
    el('div', { class: 'kv-row' },
      el('label', { class: 'kv kv-compact', title: 'Доля энергии, дошедшая до цели при скользящем попадании' }, el('span', { class: 'kv-label' }, 'Энергия попадания, %'), numInput(t.energyScalePct, (v) => { t.energyScalePct = v; run(); }, { min: 0, max: 100, width: '5rem' })),
      el('label', { class: 'kv kv-compact', title: 'Сколько раз подряд попасть в ту же цель (износ брони копится)' }, el('span', { class: 'kv-label' }, 'Попаданий подряд'), numInput(t.shots, (v) => { t.shots = Math.max(1, Math.min(50, Math.round(v))); run(); }, { min: 1, max: 50, step: 1, width: '4.6rem' })),
      el('label', { class: 'kv kv-compact', title: 'Своё HP части вместо анатомии' }, el('span', { class: 'kv-label' }, 'HP части'), numInput(t.partHp, (v) => { t.partHp = v > 0 ? v : ''; run(); }, { min: 0, width: '5rem', placeholder: 'из анатомии' }))));
}

function lineBlock() {
  return el('section', { class: 'card' },
    el('h3', null, 'Линия выстрела'),
    el('p', { class: 'hint' }, 'Элементы считаются по дистанции от дула; на одном метре — в порядке добавления.'),
    scenario.walls.map(wallRow),
    targetBlock(),
    el('div', { class: 'kv-row' }, button('+ Стена', () => {
      const presets = itemsOfKind('preset');
      const wallPreset = presets.find((p) => p.values?.use === 'wall') ?? presets.find((p) => p.values?.use === 'both');
      scenario.walls.push({ id: uid('w'), distance: 2, spec: wallPreset ? { kind: 'preset', presetId: wallPreset.id } : { kind: 'layers', layers: [] } });
      rerenderForm();
      run();
    }, { cls: 'btn-small' })));
}

let formBox = null;
function rerenderForm() {
  clear(formBox);
  formBox.append(sourceBlock(), optionsBlock(), lineBlock());
}

/* ------------------------------------------------------------------ *
 *  Results                                                            *
 * ------------------------------------------------------------------ */

function itemChips(items) {
  return items.map((it) => el('div', { class: 'proj' },
    el('span', { class: 'proj-type' }, damageTypeLabel(it.type)),
    el('span', null, `урон ${fmt(it.damage)}`),
    el('span', null, `пробитие ${fmt(it.armorPen)}%`),
    el('span', { class: 'proj-energy' }, `энергия ${fmt(it.energy)}`)));
}

function stepCard(step, e0) {
  const kindClass = step.kind === 'stopped' ? 'step-stop' : step.kind === 'wall' ? (step.penetrated ? 'step-pass' : 'step-stop') : '';
  const head = el('header', null,
    el('strong', null, step.kind === 'start' ? 'Выстрел' : step.kind === 'wall' ? `Стена · ${step.label}` : step.kind === 'target' ? `Цель · ${step.label}` : step.label),
    step.kind !== 'start' && el('span', { class: 'muted' }, `${fmt(step.distance)} м`),
    step.kind === 'wall' && chip(step.penetrated ? 'пробита' : 'остановила', { tone: step.penetrated ? 'ok' : 'bad' }));
  const card = el('article', { class: `step ${kindClass}` }, head);
  if (step.falloffRatio != null && Math.abs(step.falloffRatio - 1) > 1e-6) {
    card.append(el('p', { class: 'muted' }, `Спад до этой точки: ×${fmt(step.falloffRatio, 3)}`));
  }
  if (step.kind === 'target' && step.energyScale < 1) card.append(el('p', { class: 'muted' }, `Энергия попадания: ${pct(step.energyScale)}`));
  const rows = (step.in?.length ? step.in : step.out) ?? [];
  rows.forEach((inp, i) => {
    const out = step.in?.length ? step.out?.[i] : null;
    const eIn = inp.energy;
    const eOut = out ? out.energy : null;
    card.append(el('div', { class: 'step-item' },
      el('div', { class: 'step-line' }, el('span', { class: 'proj-type', style: `color:${damageTypeColor(inp.type)}` }, damageTypeLabel(inp.type)),
        step.kind === 'start' ? el('span', null, `урон ${fmt(inp.damage)} · пробитие ${fmt(inp.armorPen)}%`) : el('span', null, `урон ${fmt(inp.damage)}${out ? ` → ${fmt(out.damage)}` : ''}`)),
      el('div', { class: 'bar', title: 'Энергия снаряда относительно выстрела' },
        el('span', { class: 'bar-in', style: `width:${Math.min(100, (eIn / e0) * 100)}%` }),
        out && el('span', { class: 'bar-out', style: `width:${Math.min(100, (eOut / e0) * 100)}%` })),
      el('div', { class: 'step-line muted' }, `энергия ${fmt(eIn)}${out ? ` → ${fmt(eOut)}` : ''}`)));
  });
  if (step.kind === 'wall' && !step.penetrated) card.append(el('p', { class: 'muted' }, 'Ничего не вышло с другой стороны.'));
  return card;
}

function traceTable(trace) {
  if (!trace?.length) return null;
  return el('details', { class: 'raw' },
    el('summary', null, `Слои по шагам (${trace.length})`),
    el('table', { class: 'plain-table trace' },
      el('thead', null, el('tr', null, ['Часть', 'Этап', 'Слой', 'Тип', 'Событие', 'Входящий', 'Держит', 'Энергия до', 'Энергия после', 'Остаток', 'Целостность'].map((h) => el('th', null, h)))),
      el('tbody', null, trace.map((t) => el('tr', { class: `tr-${t.kind}` },
        el('td', null, t.slotRef), el('td', null, t.phase), el('td', null, materialTag(t.material)), el('td', { style: `color:${damageTypeColor(t.type)}` }, damageTypeLabel(t.type)),
        el('td', null, t.kind === 'penetrate' ? 'пробит' : t.kind === 'hold' ? 'держит' : t.kind),
        el('td', null, fmt(t.incoming)), el('td', null, fmt(t.eAR)), el('td', null, fmt(t.energyBefore)), el('td', null, fmt(t.energyAfter)),
        el('td', null, fmt(t.residual)), el('td', null, fmt(t.integrityAfter)))))));
}

/** Armour layers as coloured material tags with their remaining integrity. */
function integrityTags(layers) {
  return el('span', { class: 'layer-tags' }, layers.map((l) => {
    const tag = materialTag(l.material);
    tag.append(el('b', { title: 'Целостность слоя' }, `${fmt(l.integrity, 0)}/${fmt(l.integrityMax, 0)}`));
    return tag;
  }));
}

/** HP of the hit part after a hit of a series: `-12 / 190 · не работает`, `уничтожена`. */
function partHpCell(hp) {
  if (!hp || !(hp.max > 0)) return '—';
  if (hp.lost) return 'уничтожена';
  return `${hp.current} / ${hp.max}${hp.disabled ? ' · не работает' : ''}`;
}

/** `Смертельная травма` / `Часть тела уничтожена (смерть)` — the outcome scale in words. */
function outcomeName(o) {
  if (!o) return '—';
  const label = outcomeOf(o.id)?.label ?? o.id;
  return o.fatal ? `${label} (смерть)` : label;
}

/** The outcome of the shot on the agreed scale, with its reasons. */
function outcomeLine(shot) {
  const o = shot.outcome;
  return el('p', { class: 'outcome-line', title: 'Исход по шкале случаев (как его покажет игра); при броске органов здесь — один вариант места попадания, все варианты считает сверка случаев' },
    el('span', { class: 'muted' }, 'Исход: '),
    el('b', { class: `now-out sev-${o.severity}` }, outcomeName(o)),
    o.why?.length ? el('span', { class: 'muted' }, ` — ${o.why.join(', ')}`) : null);
}

function targetResult(target) {
  const first = target.shots[0];
  const box = el('section', { class: 'card result-target' });
  const entry = first.entry;
  box.append(el('h3', null, `Результат: ${target.partName}`));
  box.append(el('div', { class: 'big' },
    el('span', { class: 'big-num' }, fmt(entry.total, 1)),
    el('span', { class: 'big-unit' }, 'урона дошло до части'),
    el('span', { class: `big-ratio${entry.ratio >= 1 ? ' is-over' : ''}` }, entry.ratio == null ? '' : `${pct(entry.ratio)} от ${fmt(entry.maxHp, 0)} HP`)));
  if (entry.byType.length) {
    box.append(el('p', { class: 'muted' }, entry.byType.map((b) => `${damageTypeLabel(b.type)} ${fmt(b.amount, 1)}`).join(' · ')));
  }
  if (first.outcome) box.append(outcomeLine(first));
  const facts = [];
  if (first.wound?.inShell) facts.push('застрял в оболочке части');
  if (first.wound?.blunt > 0) facts.push(`удар ${fmt(first.wound.blunt, 1)}`);
  if (first.organs?.length) facts.push(`органы: ${first.organs.map((o) => `${o.name} ${fmt(o.amount, 1)}/${fmt(o.maxHp, 0)}`).join(', ')}`);
  if (first.exit?.length) facts.push(`вышло из тела: урон ${fmt(first.exit.reduce((s, i) => s + i.damage, 0), 1)}, энергия ${fmt(first.exit.reduce((s, i) => s + i.energy, 0), 2)}`);
  if (first.bleeding?.minutesToDeath != null) facts.push(`кровотечение ${fmt(first.bleeding.rate, 1)}%/мин (~${fmt(first.bleeding.minutesToDeath, 0)} мин)`);
  if (facts.length) box.append(el('p', { class: 'muted' }, facts.join(' · ')));
  const extra = first.parts.filter((p) => p.slot !== target.partId);
  if (extra.length) {
    box.append(el('table', { class: 'plain-table' },
      el('thead', null, el('tr', null, el('th', null, 'Части за ней'), el('th', null, 'Урон'), el('th', null, 'Доля HP'))),
      el('tbody', null, extra.map((p) => el('tr', null, el('td', null, p.name), el('td', null, fmt(p.total, 1)), el('td', null, p.ratio == null ? '—' : pct(p.ratio)))))));
  }
  if (target.shots.length > 1) {
    box.append(el('h4', null, 'Серия попаданий'));
    box.append(el('table', { class: 'plain-table' },
      el('thead', null, el('tr', null, el('th', null, '№'), el('th', null, 'Урон'), el('th', null, 'Доля HP'),
        el('th', { title: 'HP части после этого попадания: раны одной силы насыщаются (у части — «насыщение»); ниже 0 часть не работает, ниже −запаса уничтожена' }, 'HP части'),
        el('th', { title: 'Состояние цели после этого попадания (раны копятся)' }, 'Состояние'), el('th', null, 'Слои брони после'))),
      el('tbody', null, target.shots.map((s) => el('tr', null,
        el('td', null, s.n), el('td', null, fmt(s.entry.total, 1)), el('td', null, s.entry.ratio == null ? '—' : pct(s.entry.ratio)),
        el('td', null, partHpCell(s.hp)),
        el('td', { class: `now-out sev-${s.outcome?.severity ?? 0}`, title: (s.outcome?.why ?? []).join('\n') }, outcomeName(s.outcome)),
        el('td', null, s.armorLayers.length ? integrityTags(s.armorLayers) : '—'))))));
  } else if (first.armorLayers.length) {
    box.append(el('p', { class: 'muted' }, 'Целостность брони после выстрела: ', integrityTags(first.armorLayers)));
  }
  if (first.path.length > 1) box.append(el('p', { class: 'muted' }, 'Путь: ', first.path.map((p) => p.slotRef).join(' → ')));
  const trace = traceTable(first.trace);
  if (trace) box.append(trace);
  box.append(el('div', { class: 'kv-row' }, button('Занести в случаи', addToCases, { cls: 'btn-small', title: 'Добавить этот сценарий вариантом в базу случаев' })));
  return box;
}

function renderResult() {
  clear(resultBox);
  if (lastError) {
    resultBox.append(el('p', { class: 'empty' }, lastError));
    return;
  }
  const r = lastResult;
  if (!r) return;
  const e0 = Math.max(1e-9, ...r.steps[0].out.map((i) => i.energy));
  resultBox.append(el('section', { class: 'card' },
    el('h3', null, 'Что происходит по линии'),
    el('div', { class: 'steps' }, r.steps.map((s, i) => [i > 0 && el('span', { class: 'step-arrow' }, '→'), stepCard(s, e0)]))));
  if (r.projectile.falloff.enabled) {
    resultBox.querySelector('.card').append(el('p', { class: 'muted' }, `Спад: половина силы на ${fmt(r.projectile.falloff.halfDistance, 0)} м${r.projectile.useFalloff ? '' : ' (выключен)'}.`));
  }
  if (r.warnings?.length) resultBox.append(el('section', { class: 'card warn' }, r.warnings.map((w) => el('p', null, w))));
  if (r.target) resultBox.append(targetResult(r.target));
  else if (scenario.target) resultBox.append(el('section', { class: 'card' }, el('p', { class: 'empty' }, 'Снаряд не дошёл до цели.')));
}

/* ------------------------------------------------------------------ *
 *  Cases link                                                         *
 * ------------------------------------------------------------------ */

/** Fill the scenario from a case row and show it. */
export function loadFromCase(group, row) {
  const next = defaultScenario();
  next.source = { ...next.source, kind: 'ammo', itemId: group.ammoItem || '', weaponId: group.weaponItem || '' };
  next.target = {
    ...next.target, distance: row.distance, partId: group.part, hitDirection: row.face || 'front', armor: clone(row.armor ?? { kind: 'none' }),
  };
  next.options = { ...scenario.options };
  scenario = next;
  if (formBox) rerenderForm();
  run();
  if (!group.ammoItem) toast('У этого случая не выбран патрон из базы — выберите его в калькуляторе.');
}

function addToCases() {
  const t = scenario.target;
  const s = scenario.source;
  if (!t || s.kind !== 'ammo' || !s.itemId) { toast('Нужны патрон и цель', { tone: 'error' }); return; }
  let group = db.cases.groups.find((g) => g.ammoItem === s.itemId && g.part === t.partId);
  const finish = () => {
    db.cases.rows.push({
      id: uid('r'), groupId: group.id, armor: clone(t.armor), face: t.hitDirection, distance: t.distance, condition: '',
      worst: null, best: null, note: '',
    });
    touch('cases');
    emitChange('cases');
    toast(`Добавлено в «${weaponLabel(group)} → ${partOf(group.part)?.label ?? group.part}»`);
  };
  if (group) { finish(); return; }
  const ammo = getItem(s.itemId);
  let weaponType = db.dictionaries.weaponTypes[0]?.id ?? '';
  let weaponName = getItem(s.weaponId)?.name ?? '';
  const body = el('div', null,
    el('p', { class: 'hint' }, 'Для этого патрона и части тела случая ещё нет — создайте его.'),
    el('label', { class: 'row-gap' }, el('span', { class: 'muted' }, 'Оружие или тип'), textInput(weaponName, (v) => { weaponName = v; }, { placeholder: 'Пистолет' })),
    el('label', { class: 'row-gap' }, el('span', { class: 'muted' }, 'Тип оружия'),
      selectEl(db.dictionaries.weaponTypes.map((x) => ({ value: x.id, label: x.label })), weaponType, (v) => { weaponType = v; })));
  openModal({
    title: 'Новый случай',
    body,
    buttons: [{ label: 'Отмена' }, {
      label: 'Создать', primary: true,
      onClick: () => {
        group = {
          id: uid('g'), weaponType, weapon: weaponName || 'Оружие', ammo: (ammo?.name ?? '').replace(/^Патрон\s*/, ''), ammoItem: s.itemId,
          weaponItem: s.weaponId || '', part: t.partId, note: '', favorite: false,
        };
        db.cases.groups.push(group);
        finish();
      },
    }],
  });
}

/* ------------------------------------------------------------------ *
 *  Mount                                                              *
 * ------------------------------------------------------------------ */

export function mountCalc(container) {
  root = container;
  clear(root);
  formBox = el('div', { class: 'calc-form' });
  resultBox = el('div', { class: 'calc-result' });
  root.append(el('div', { class: 'calc' }, formBox, resultBox));
  if (!scenario.source.itemId) {
    const ammo = itemsOfKind('ammo').find((a) => a.id === 'ammo.9mm') ?? itemsOfKind('ammo')[0];
    if (ammo) scenario.source.itemId = ammo.id;
  }
  rerenderForm();
  run();
}

onChange((topic) => { if (topic === 'items' && formBox?.isConnected) run(); });

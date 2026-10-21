/**
 * "Случаи" tab: the case base.
 *
 * Tree: weapon type -> global case (weapon + ammo vs a body part) -> variants (armour, side, distance,
 * condition). The outcome is what happens to the TARGET: a skull marks the worst outcome of the shot, a
 * heart the best one; both are picked from the outcome dictionary.
 */

import { el, clear, append, uid, clone, fmt, pct, readStored, writeStored, debounce, autoGrow } from './util.js';
import {
  db, touch, flush, partOf, outcomeOf, itemsOfKind, armorLabel, weaponLabel, getItem,
} from './state.js';
import { api } from './api.js';
import {
  armorPicker, button, checkbox, chip, iconButton, numInput, openModal, outcomeSelect, segmented, selectEl, textInput, toast,
} from './widgets.js';
import { heartIcon, partColor, skullIcon, typeColor } from './icons.js';
import { FACES } from './schema.js';

const PREFS_KEY = 'balance.cases.ui';
const FILTERS = [
  { value: 'all', label: 'Все' },
  { value: 'empty', label: 'Без исхода', title: 'Случаи, где исход не выбран' },
  { value: 'fav', label: '★', title: 'Избранные случаи' },
  { value: 'proposed', label: 'ИИ', title: 'Варианты, предложенные ИИ и ещё не принятые' },
  { value: 'miss', label: '✗', title: 'Расходится с механикой (считается при включённой «Сверке с механикой»)' },
];

/** Verdict of the mechanics against the agreed outcome (`lib/outcome.mjs` `verdict`). */
const VERDICTS = Object.freeze({
  match: { glyph: '✓', tone: 'ok', title: 'Совпадает с договорённым исходом' },
  near: { glyph: '≈', tone: 'warn', title: 'В пределах договорённого: совпадает один край, второй — мягче' },
  miss: { glyph: '✗', tone: 'bad', title: 'Расходится с договорённым исходом' },
});

/** Where the measured target stands. */
const TARGETS = Object.freeze([
  { value: '', label: 'одна цель' },
  { value: 'behind', label: 'вторая за первой' },
]);

const prefs = Object.assign({ collapsed: {}, filter: 'all', search: '', showNow: false }, readStored(PREFS_KEY, {}));
if (!FILTERS.some((f) => f.value === prefs.filter)) prefs.filter = 'all';
const savePrefs = () => writeStored(PREFS_KEY, prefs);

let root = null;
let hooks = { openCalc: () => {} };
let checks = new Map();
let focusGroupId = null;

/* ------------------------------------------------------------------ *
 *  Model helpers                                                      *
 * ------------------------------------------------------------------ */

const rowsOf = (groupId) => db.cases.rows.filter((r) => r.groupId === groupId);
const isFilled = (row) => !!row.worst;
/** A variant drafted by the AI that the owner has not reviewed yet. */
const isProposed = (row) => row.proposed === true;

/** Accept the AI proposal: the variant becomes an ordinary one; a case with nothing left to review loses its mark. */
function acceptRows(rows) {
  for (const row of rows) delete row.proposed;
  for (const group of db.cases.groups) {
    if (group.proposed && !rowsOf(group.id).some(isProposed)) delete group.proposed;
  }
  touchCases();
  render();
}

function proposedBadge(title) {
  return el('span', { class: 'badge badge-ai', title }, 'ИИ');
}

function touchCases() {
  touch('cases');
  if (prefs.showNow) refreshChecks();
}

function severity(id) {
  return outcomeOf(id)?.severity ?? null;
}

function newRow(groupId, seed = {}) {
  return {
    id: uid('r'), groupId, armor: { kind: 'none' }, face: 'front', distance: 0, condition: '',
    worst: null, best: null, note: '', ...seed,
  };
}

function matchesFilter(group, row) {
  switch (prefs.filter) {
    case 'empty': return !isFilled(row);
    case 'fav': return !!group.favorite;
    case 'proposed': return isProposed(row);
    case 'miss': return checks.get(row.id)?.status === 'miss';
    default: return true;
  }
}

function matchesSearch(group, row) {
  const q = prefs.search.trim().toLowerCase();
  if (!q) return true;
  const hay = [weaponLabel(group), partOf(group.part)?.label, armorLabel(row.armor), row.condition, row.note, group.note].join(' ').toLowerCase();
  return hay.includes(q);
}

/* ------------------------------------------------------------------ *
 *  Counters                                                           *
 * ------------------------------------------------------------------ */

function counts(groups) {
  let total = 0;
  let filled = 0;
  for (const g of groups) {
    for (const r of rowsOf(g.id)) { total += 1; if (isFilled(r)) filled += 1; }
  }
  return { total, filled };
}

function refreshCounters() {
  const all = counts(db.cases.groups);
  const total = root.querySelector('[data-count-total]');
  if (total) total.textContent = `Исход выбран: ${all.filled} из ${all.total}`;
  const verdicts = root.querySelector('[data-count-verdict]');
  if (verdicts) {
    const n = { match: 0, near: 0, miss: 0 };
    for (const r of checks.values()) if (r.ok && n[r.status] !== undefined) n[r.status] += 1;
    verdicts.textContent = prefs.showNow && checks.size ? `✓ ${n.match} · ≈ ${n.near} · ✗ ${n.miss}` : '';
  }
  const proposed = root.querySelector('[data-count-proposed]');
  if (proposed) {
    const n = db.cases.rows.filter(isProposed).length;
    proposed.textContent = n ? `предложено ИИ: ${n}` : '';
  }
  for (const node of root.querySelectorAll('[data-count-type]')) {
    const c = counts(db.cases.groups.filter((g) => g.weaponType === node.dataset.countType));
    node.textContent = `${c.filled}/${c.total}`;
  }
  for (const node of root.querySelectorAll('[data-count-group]')) {
    const c = counts(db.cases.groups.filter((g) => g.id === node.dataset.countGroup));
    node.textContent = `${c.filled}/${c.total}`;
    node.classList.toggle('is-done', c.total > 0 && c.filled === c.total);
  }
}

/* ------------------------------------------------------------------ *
 *  Checks against the current mechanics                               *
 * ------------------------------------------------------------------ */

const refreshChecks = debounce(async () => {
  if (!prefs.showNow) return;
  try {
    await flush();
    const res = await api.check({ valuesMode: prefs.valuesMode ?? 'values' });
    checks = new Map(res.results.map((r) => [r.rowId, r]));
    for (const cell of root.querySelectorAll('[data-now-row]')) fillNowCell(cell, cell.dataset.nowRow);
    refreshCounters();
    if (prefs.filter === 'miss') render();
  } catch (e) {
    toast(`Сверка с механикой не удалась: ${e.message}`, { tone: 'error' });
  }
}, 600);

/** `Смертельная травма` / `Часть тела уничтожена (смерть)` — an outcome of the mechanics in words. */
function outcomeText(o) {
  if (!o) return '—';
  const label = outcomeOf(o.id)?.label ?? o.id;
  return o.fatal ? `${label} (смерть)` : label;
}

/** Tooltip of a computed outcome: how likely, with what, where it landed and why. */
function outcomeDetail(o) {
  const head = `${outcomeText(o)} — ${pct(o.p)}${o.member ? `, ${o.member}` : ''}`;
  return [head, o.location && `место: ${o.location}`, o.note, ...(o.why ?? [])].filter(Boolean).join('\n  ');
}

function fillNowCell(cell, rowId) {
  clear(cell);
  const res = checks.get(rowId);
  if (!res) { cell.append(el('span', { class: 'muted' }, '…')); return; }
  if (!res.ok) {
    cell.append(el('span', { class: 'muted', title: res.error === 'skip' ? 'У случая нет патрона или оружия из базы, или часть тела без слота' : res.error }, '—'));
    return;
  }
  const v = VERDICTS[res.status];
  const ratio = res.ratio == null ? '' : `${fmt(res.total, 1)} · ${pct(res.ratio)}`;
  const line = (icon, o) => el('div', { class: 'now-line' }, el('span', { class: 'oc-icon' }, icon), el('span', { class: `now-out sev-${o.severity}` }, outcomeText(o)));
  append(cell, [
    el('div', { class: 'now-head' }, v && chip(v.glyph, { tone: v.tone, title: v.title }), el('span', { class: 'muted now-num' }, ratio)),
    line(skullIcon(), res.worst),
    res.best && res.best.id !== res.worst.id && line(heartIcon(), res.best),
  ]);
  const members = (res.members ?? []).map((m) => `${m.label}: ${Object.entries(m.dist).sort((x, y) => y[1] - x[1]).map(([id, p]) => `${outcomeOf(id)?.label ?? id} ${pct(p)}`).join(', ')}`);
  cell.title = [
    `Худший: ${outcomeDetail(res.worst)}`,
    res.best && (res.best.id !== res.worst.id || res.best.p !== res.worst.p || res.best.member !== res.worst.member) ? `Лучший: ${outcomeDetail(res.best)}` : null,
    members.length ? `По оружию:\n  ${members.join('\n  ')}` : null,
    'Число — урон в часть и доля её HP (самый вероятный исход первого оружия)',
  ].filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------ *
 *  Rows                                                               *
 * ------------------------------------------------------------------ */

function outcomeCell(row) {
  const cell = el('td', { class: 'c-outcome' });
  const draw = () => {
    clear(cell);
    const two = row.best != null;
    const warn = two && row.worst && row.best && severity(row.best) > severity(row.worst);
    const worstSelect = outcomeSelect(row.worst, (v) => { row.worst = v; touchCases(); refreshCounters(); draw(); }, { emptyLabel: 'исход…', title: two ? 'Худший исход для цели' : 'Исход для цели' });
    if (two) {
      append(cell, [
        el('div', { class: 'oc-line' }, el('span', { class: 'oc-icon', title: 'Худший исход для цели' }, skullIcon()), worstSelect),
        el('div', { class: 'oc-line' },
          el('span', { class: 'oc-icon', title: 'Лучший исход для цели' }, heartIcon()),
          outcomeSelect(row.best || null, (v) => { row.best = v ?? ''; touchCases(); draw(); }, { emptyLabel: 'исход…', title: 'Лучший исход для цели' }),
          warn && iconButton('⇅', 'Лучший исход тяжелее худшего — поменять местами', () => { [row.worst, row.best] = [row.best, row.worst]; touchCases(); draw(); }, { cls: 'is-warn' }),
          iconButton('−', 'Убрать второй исход', () => { row.best = null; touchCases(); draw(); })),
      ]);
    } else {
      cell.append(el('div', { class: 'oc-line' }, worstSelect, iconButton('+', 'Второй исход: первый станет худшим, второй лучшим', () => { row.best = ''; touchCases(); draw(); })));
    }
  };
  draw();
  return cell;
}

function noteCell(obj, { placeholder = 'Почему так' } = {}) {
  const area = el('textarea', {
    class: 'field note', rows: 1, placeholder, value: obj.note ?? '',
    on: { change: () => { obj.note = area.value; touchCases(); } },
  });
  area.value = obj.note ?? '';
  autoGrow(area);
  return area;
}

function renderRow(group, row) {
  const body = el('tbody', { class: `case-row${isProposed(row) ? ' is-proposed' : ''}`, dataset: { rowId: row.id } });
  const main = el('tr', null,
    el('td', { class: 'c-armor' }, armorPicker(row.armor, (spec) => { row.armor = spec; touchCases(); })),
    el('td', { class: 'c-face' }, selectEl(FACES, row.face, (v) => { row.face = v; touchCases(); }, { title: 'Сторона попадания' })),
    el('td', { class: 'c-dist' }, numInput(row.distance, (v) => { row.distance = Math.max(0, v); touchCases(); }, { min: 0, title: 'Дистанция, м', width: '4.6rem' })),
    el('td', { class: 'c-cond' }, conditionCell(group, row)),
    outcomeCell(row),
    prefs.showNow && el('td', { class: 'c-now', dataset: { nowRow: row.id } }),
    el('td', { class: 'c-note' }, noteCell(row)),
    el('td', { class: 'c-actions' },
      isProposed(row) && proposedBadge('Вариант предложен ИИ: исход и примечание — его догадка, проверьте'),
      isProposed(row) && iconButton('✓', 'Принять вариант ИИ (исход проверен)', () => acceptRows([row]), { cls: 'is-accept' }),
      iconButton('▶', 'Открыть в калькуляторе', () => hooks.openCalc(group, row)),
      iconButton('⧉', 'Дублировать вариант', () => duplicateRow(row)),
      iconButton('↑', 'Выше', () => moveRow(row, -1)),
      iconButton('↓', 'Ниже', () => moveRow(row, 1)),
      iconButton('✕', 'Удалить вариант', () => deleteRow(row))),
  );
  body.append(main);
  if (prefs.showNow) fillNowCell(main.querySelector('[data-now-row]'), row.id);
  return body;
}

/**
 * Condition of a variant: free text, plus what the mechanics need to know — where the measured target stands
 * (for a shot) or which blow and with what strength (for a melee weapon).
 */
function conditionCell(group, row) {
  const weapon = group.weaponItem ? getItem(group.weaponItem) : null;
  const melee = !group.ammoItem && weapon?.kind === 'weapon';
  const extras = [];
  if (group.ammoItem) {
    extras.push(selectEl(TARGETS, row.target ?? '', (v) => { if (v) row.target = v; else delete row.target; touchCases(); }, { class: 'field f-target', title: 'Кого считаем: цель или вторую цель за ней (пуля прошла первую насквозь)' }));
  }
  if (melee) {
    const lines = (weapon.values?.lines ?? []).filter((l) => (l.damage ?? []).length);
    extras.push(selectEl([{ value: '', label: 'любой удар' }, ...lines.map((l) => ({ value: l.id, label: l.name }))], row.lineId ?? '', (v) => { if (v) row.lineId = v; else delete row.lineId; touchCases(); }, { class: 'field f-line', title: 'Удар (линия оружия); «любой удар» — все удары оружия' }));
    extras.push(numInput(row.effort ?? 100, (v) => { row.effort = Math.max(0, Math.round(v)); touchCases(); }, { min: 0, step: 10, width: '4.2rem', title: 'Сила атакующего (СИЛ; 100 — средний человек)' }));
  }
  return el('div', { class: 'cond-line' },
    ...extras,
    textInput(row.condition, (v) => { row.condition = v; touchCases(); }, { placeholder: 'условие', title: 'Дополнительное условие' }));
}

function duplicateRow(row) {
  const copy = { ...clone(row), id: uid('r') };
  const idx = db.cases.rows.indexOf(row);
  db.cases.rows.splice(idx + 1, 0, copy);
  touchCases();
  render();
}

function moveRow(row, dir) {
  const siblings = rowsOf(row.groupId);
  const i = siblings.indexOf(row);
  const other = siblings[i + dir];
  if (!other) return;
  const a = db.cases.rows.indexOf(row);
  const b = db.cases.rows.indexOf(other);
  [db.cases.rows[a], db.cases.rows[b]] = [db.cases.rows[b], db.cases.rows[a]];
  touchCases();
  render();
}

function deleteRow(row) {
  const idx = db.cases.rows.indexOf(row);
  db.cases.rows.splice(idx, 1);
  touchCases();
  render();
  toast('Вариант удалён', { undo: () => { db.cases.rows.splice(idx, 0, row); touchCases(); render(); } });
}

/* ------------------------------------------------------------------ *
 *  Groups                                                             *
 * ------------------------------------------------------------------ */

function ammoItemOptions() {
  const ammo = itemsOfKind('ammo');
  return [{ value: '', label: '— патрон из базы —' }, ...ammo.map((a) => ({ value: a.id, label: a.name }))];
}

function partOptions() {
  return db.dictionaries.parts.map((p) => ({ value: p.id, label: p.label }));
}

function weaponItemOptions() {
  const weapons = itemsOfKind('weapon');
  return [{ value: '', label: '— оружие из базы —' }, ...weapons.map((w) => ({ value: w.id, label: `${w.name}${w.group ? ` (${w.group})` : ''}` }))];
}

function typeOptions() {
  return db.dictionaries.weaponTypes.map((t) => ({ value: t.id, label: t.label }));
}

function renderGroup(group) {
  const visibleRows = rowsOf(group.id).filter((r) => matchesFilter(group, r) && matchesSearch(group, r));
  const collapsed = !!prefs.collapsed[`g:${group.id}`];
  const card = el('section', { class: `group${collapsed ? ' is-collapsed' : ''}`, dataset: { groupId: group.id } });

  const weaponField = textInput(group.weapon, (v) => { group.weapon = v; touchCases(); }, { placeholder: 'оружие или его тип', cls: 'f-weapon', title: 'Оружие или тип оружия' });
  const header = el('header', { class: 'group-head' },
    iconButton(collapsed ? '▸' : '▾', collapsed ? 'Развернуть случай' : 'Свернуть случай', () => { prefs.collapsed[`g:${group.id}`] = !collapsed; savePrefs(); render(); }, { cls: 'fold' }),
    weaponField,
    el('span', { class: 'paren' }, '('),
    textInput(group.ammo, (v) => { group.ammo = v; touchCases(); }, { placeholder: 'патрон', cls: 'f-ammo', title: 'Патрон' }),
    el('span', { class: 'paren' }, ')'),
    el('span', { class: 'arrow' }, '→'),
    selectEl(partOptions(), group.part, (v) => { group.part = v; touchCases(); render(); }, { class: 'field f-part', title: 'Часть тела', style: `--part:${partColor(group.part)}` }),
    selectEl(ammoItemOptions(), group.ammoItem || '', (v) => {
      group.ammoItem = v;
      if (v && !group.ammo) group.ammo = (getItem(v)?.name ?? '').replace(/^Патрон\s*/, '');
      touchCases();
      render();
    }, { title: 'Патрон из базы (нужен для калькулятора и сверки)' }),
    selectEl(weaponItemOptions(), group.weaponItem || '', (v) => { group.weaponItem = v; touchCases(); render(); }, { title: 'Оружие из базы: с патроном — только это оружие; без патрона — оружие ближнего боя (удар и сила задаются в варианте)' }),
    group.ammoItem && !group.weaponItem && el('label', { class: 'check', title: 'Считать по всем оружиям этого типа под этот калибр и всем патронам этой группы: «не всегда пробивает» = разные пистолеты/патроны' },
      checkbox(group.family !== false, (on) => { if (on) delete group.family; else group.family = false; touchCases(); }), 'семейство'),
    selectEl(typeOptions(), group.weaponType, (v) => { group.weaponType = v; touchCases(); render(); }, { title: 'Тип оружия' }),
    el('span', { class: 'spacer' }),
    group.proposed && proposedBadge('Случай предложен ИИ'),
    rowsOf(group.id).some(isProposed) && button('Принять всё', () => acceptRows(rowsOf(group.id).filter(isProposed)), { cls: 'btn-small', title: 'Принять все варианты ИИ в этом случае' }),
    el('span', { class: 'count', dataset: { countGroup: group.id }, title: 'Варианты с выбранным исходом' }),
    iconButton(group.favorite ? '★' : '☆', 'Избранное', () => { group.favorite = !group.favorite; touchCases(); render(); }, { cls: group.favorite ? 'is-fav' : '' }),
    iconButton('⧉', 'Дублировать случай', () => duplicateGroup(group)),
    iconButton('✕', 'Удалить случай', () => deleteGroup(group)));
  card.append(header);

  if (!collapsed) {
    const note = el('textarea', { class: 'field note group-note', rows: 1, placeholder: 'Общее примечание к случаю', value: group.note ?? '', on: { change: () => { group.note = note.value; touchCases(); } } });
    note.value = group.note ?? '';
    autoGrow(note);
    card.append(el('div', { class: 'group-note-wrap' }, note));

    const table = el('table', { class: 'case-table' },
      el('thead', null, el('tr', null,
        el('th', null, 'Броня'), el('th', null, 'Сторона'), el('th', null, 'Дист., м'), el('th', null, 'Условие'),
        el('th', { title: 'Что происходит с целью' }, 'Исход для цели'), prefs.showNow && el('th', null, 'Сейчас'), el('th', null, 'Примечание'), el('th', null))));
    for (const row of visibleRows) table.append(renderRow(group, row));
    card.append(el('div', { class: 'table-scroll' }, table));
    if (!visibleRows.length) card.append(el('p', { class: 'empty' }, rowsOf(group.id).length ? 'Под фильтр ничего не попало.' : 'Вариантов пока нет.'));
    card.append(el('footer', { class: 'group-foot' },
      button('+ Вариант', () => addRow(group), { cls: 'btn-small' }),
      button('+ По броне и дистанциям…', () => matrixDialog(group), { cls: 'btn-small' })));
  }
  if (group.id === focusGroupId) {
    focusGroupId = null;
    requestAnimationFrame(() => weaponField.focus());
  }
  return card;
}

function addRow(group) {
  const last = rowsOf(group.id).at(-1);
  const row = newRow(group.id, last ? { face: last.face } : {});
  const idx = last ? db.cases.rows.indexOf(last) + 1 : db.cases.rows.length;
  db.cases.rows.splice(idx, 0, row);
  touchCases();
  render();
}

function duplicateGroup(group) {
  const copy = { ...clone(group), id: uid('g') };
  const rows = rowsOf(group.id).map((r) => ({ ...clone(r), id: uid('r'), groupId: copy.id }));
  db.cases.groups.splice(db.cases.groups.indexOf(group) + 1, 0, copy);
  db.cases.rows.push(...rows);
  focusGroupId = copy.id;
  touchCases();
  render();
}

function deleteGroup(group) {
  const gi = db.cases.groups.indexOf(group);
  const removed = rowsOf(group.id).map((r) => ({ row: r, index: db.cases.rows.indexOf(r) }));
  db.cases.groups.splice(gi, 1);
  db.cases.rows = db.cases.rows.filter((r) => r.groupId !== group.id);
  touchCases();
  render();
  toast(`Случай «${weaponLabel(group)}» удалён`, {
    undo: () => {
      db.cases.groups.splice(gi, 0, group);
      for (const { row } of removed) db.cases.rows.push(row);
      touchCases();
      render();
    },
  });
}

function addGroup(typeId) {
  const group = { id: uid('g'), weaponType: typeId, weapon: '', ammo: '', ammoItem: '', weaponItem: '', part: 'head', note: '', favorite: false };
  const lastOfType = db.cases.groups.filter((g) => g.weaponType === typeId).at(-1);
  const idx = lastOfType ? db.cases.groups.indexOf(lastOfType) + 1 : db.cases.groups.length;
  db.cases.groups.splice(idx, 0, group);
  db.cases.rows.push(newRow(group.id));
  prefs.collapsed[`t:${typeId}`] = false;
  savePrefs();
  focusGroupId = group.id;
  touchCases();
  render();
}

/** Create variants for every chosen armour at every listed distance. */
function matrixDialog(group) {
  const armors = [
    { key: 'none', label: 'Без брони', spec: { kind: 'none' } },
    ...itemsOfKind('preset').filter((p) => ['armor', 'both'].includes(p.values?.use)).map((p) => ({ key: p.id, label: p.name, spec: { kind: 'preset', presetId: p.id } })),
    ...itemsOfKind('armor').map((p) => ({ key: p.id, label: `${p.name} (предмет)`, spec: { kind: 'item', itemId: p.id } })),
  ];
  const chosen = new Set();
  let distances = '0';
  const body = el('div', null,
    el('p', { class: 'hint' }, 'Добавляет по варианту на каждую отмеченную броню и каждую дистанцию. Уже существующие сочетания пропускаются.'),
    el('div', { class: 'matrix-list' }, armors.map((a) => el('label', { class: 'check' }, checkbox(false, (on) => { on ? chosen.add(a.key) : chosen.delete(a.key); }), a.label))),
    el('label', { class: 'row-gap' }, el('span', { class: 'muted' }, 'Дистанции, м (через запятую)'), textInput(distances, (v) => { distances = v; }, { placeholder: '0, 25, 100' })));
  openModal({
    title: `Варианты: ${weaponLabel(group)}`,
    body,
    buttons: [{ label: 'Отмена' }, {
      label: 'Добавить', primary: true,
      onClick: () => {
        const list = distances.split(/[;,\s]+/).map((s) => Number(s.replace(',', '.'))).filter((n) => Number.isFinite(n) && n >= 0);
        const dists = list.length ? list : [0];
        const existing = rowsOf(group.id);
        let added = 0;
        for (const a of armors.filter((x) => chosen.has(x.key))) {
          for (const d of dists) {
            const dup = existing.some((r) => JSON.stringify(r.armor) === JSON.stringify(a.spec) && Number(r.distance) === d);
            if (dup) continue;
            db.cases.rows.push(newRow(group.id, { armor: clone(a.spec), distance: d }));
            added += 1;
          }
        }
        if (added) { touchCases(); render(); }
        toast(added ? `Добавлено вариантов: ${added}` : 'Новых сочетаний нет');
      },
    }],
  });
}

/* ------------------------------------------------------------------ *
 *  Types and toolbar                                                  *
 * ------------------------------------------------------------------ */

function renderType(type, groups, color) {
  const collapsed = !!prefs.collapsed[`t:${type.id}`];
  const filtering = prefs.filter !== 'all' || prefs.search.trim();
  const shown = groups.filter((g) => !filtering || rowsOf(g.id).some((r) => matchesFilter(g, r) && matchesSearch(g, r)));
  if (filtering && !shown.length) return null;
  const empty = !groups.length;
  const section = el('section', { class: `wtype${collapsed ? ' is-collapsed' : ''}${empty ? ' is-empty' : ''}`, dataset: { typeId: type.id }, style: `--type:${color}` },
    el('header', { class: 'wtype-head' },
      iconButton(collapsed ? '▸' : '▾', collapsed ? 'Развернуть тип' : 'Свернуть тип', () => { prefs.collapsed[`t:${type.id}`] = !collapsed; savePrefs(); render(); }, { cls: 'fold' }),
      el('h2', { on: { click: () => { prefs.collapsed[`t:${type.id}`] = !collapsed; savePrefs(); render(); } } }, type.label),
      el('span', { class: 'count', dataset: { countType: type.id }, title: 'Варианты с выбранным исходом' }),
      el('span', { class: 'spacer' }),
      button('+ Случай', () => addGroup(type.id), { cls: 'btn-small', title: 'Новый случай этого типа оружия' })));
  if (!collapsed && !empty) {
    const body = el('div', { class: 'wtype-body' }, shown.map(renderGroup));
    if (!shown.length) body.append(el('p', { class: 'empty' }, 'Под фильтр ничего не попало.'));
    section.append(body);
  }
  return section;
}

function renderToolbar() {
  const search = el('input', {
    class: 'field search', type: 'search', placeholder: 'Поиск по случаям', value: prefs.search, title: 'Поиск по случаям',
    on: { input: debounce(() => { prefs.search = search.value; savePrefs(); render({ keepFocus: 'search' }); }, 250) },
  });
  search.value = prefs.search;
  return el('div', { class: 'toolbar' },
    segmented(FILTERS, prefs.filter, (v) => { prefs.filter = v; savePrefs(); render(); }),
    search,
    el('span', { class: 'count-total', dataset: { countTotal: '' } }),
    el('span', { class: 'count-total count-ai', dataset: { countProposed: '' }, title: 'Варианты, предложенные ИИ и ещё не принятые' }),
    el('span', { class: 'count-total', dataset: { countVerdict: '' }, title: 'Сверка с механикой: совпадает · в пределах · расходится' }),
    el('span', { class: 'legend', title: 'Исход — это то, что происходит с целью' },
      el('span', { class: 'legend-item' }, skullIcon(), 'худший исход для цели'),
      el('span', { class: 'legend-item' }, heartIcon(), 'лучший исход для цели')),
    el('span', { class: 'spacer' }),
    el('label', { class: 'check', title: 'Показать урон по текущим механикам рядом с исходами' },
      checkbox(prefs.showNow, (on) => { prefs.showNow = on; savePrefs(); if (on) refreshChecks.flush(); render(); }), 'Сверка с механикой'),
    prefs.showNow && iconButton('↻', 'Пересчитать сверку', () => refreshChecks.flush()),
    button('Развернуть всё', () => setAllCollapsed(false), { cls: 'btn-small' }),
    button('Свернуть всё', () => setAllCollapsed(true), { cls: 'btn-small' }),
    button('+ Тип оружия', addTypeDialog, { cls: 'btn-small' }));
}

function setAllCollapsed(value) {
  for (const t of db.dictionaries.weaponTypes) prefs.collapsed[`t:${t.id}`] = value;
  for (const g of db.cases.groups) prefs.collapsed[`g:${g.id}`] = value;
  savePrefs();
  render();
}

function addTypeDialog() {
  let label = '';
  const input = textInput('', (v) => { label = v; }, { placeholder: 'Например, Арбалеты' });
  openModal({
    title: 'Новый тип оружия',
    body: el('div', null, input),
    buttons: [{ label: 'Отмена' }, {
      label: 'Создать', primary: true,
      onClick: () => {
        label = (label || input.value).trim();
        if (!label) return false;
        const id = uid('t');
        db.dictionaries.weaponTypes.push({ id, label });
        touch('dictionaries');
        render();
      },
    }],
  });
  setTimeout(() => input.focus(), 30);
}

/* ------------------------------------------------------------------ *
 *  Render                                                             *
 * ------------------------------------------------------------------ */

export function render({ keepFocus = null } = {}) {
  const scroll = window.scrollY;
  clear(root);
  root.append(renderToolbar());
  const list = el('div', { class: 'cases-list' });
  const known = new Set(db.dictionaries.weaponTypes.map((t) => t.id));
  db.dictionaries.weaponTypes.forEach((type, index) => {
    const node = renderType(type, db.cases.groups.filter((g) => g.weaponType === type.id), typeColor(index));
    if (node) list.append(node);
  });
  const orphans = db.cases.groups.filter((g) => !known.has(g.weaponType));
  if (orphans.length) {
    const node = renderType({ id: '__none', label: 'Без типа' }, orphans, typeColor(-1));
    if (node) list.append(node);
  }
  root.append(list);
  refreshCounters();
  window.scrollTo(0, scroll);
  if (keepFocus === 'search') {
    const s = root.querySelector('.search');
    s?.focus();
    s?.setSelectionRange(s.value.length, s.value.length);
  }
}

/**
 * @param {HTMLElement} container
 * @param {{ openCalc: (group: object, row: object) => void }} options
 */
export function mountCases(container, options) {
  root = container;
  hooks = { ...hooks, ...options };
  render();
  if (prefs.showNow) refreshChecks.flush();
}

/**
 * "База" tab: materials, ammo, weapons, armour and layer presets.
 *
 * Compendium items carry `base` (what the game has) and `values` (the working copy balance edits);
 * changed fields are marked and show the game value. Custom items and presets have no `base`.
 */

import { el, clear, uid, clone, fmt, readStored, writeStored, sameValue, autoGrow } from './util.js';
import { db, touch, flush, adoptCollection, getItem, emitChange, itemsOfKind } from './state.js';
import { api } from './api.js';
import {
  button, checkbox, chip, iconButton, layersEditor, materialDot, numInput, openModal, segmented, selectEl, statusBadge, STATUS_LABELS, textInput, toast,
} from './widgets.js';
import { damageTypeColor } from './icons.js';
import {
  DAMAGE_TYPES, KINDS, PRESET_USES, FACES, blankDamageEntry, blankValues, damageTypeLabel, entryEnergy,
} from './schema.js';

const PREFS_KEY = 'balance.db.ui';
const prefs = Object.assign({ kind: 'ammo', selectedId: null, search: '', status: 'all' }, readStored(PREFS_KEY, {}));
const savePrefs = () => writeStored(PREFS_KEY, prefs);

let root = null;
let listBox = null;
let detailBox = null;

/* ------------------------------------------------------------------ *
 *  Helpers                                                            *
 * ------------------------------------------------------------------ */

const isCompendium = (item) => item.source?.type === 'compendium';
const isChanged = (item) => isCompendium(item) && !sameValue(item.values, item.base);

function touchItem() {
  touch('items');
  emitChange('items');
  renderList();
  refreshDiffs();
  refreshHead();
}

/** Controls whose value is compared with the game's; refreshed after every edit. */
let diffables = [];

function refreshDiffs() {
  for (const d of diffables) d();
}

/**
 * Wrap a control so a value that differs from the game's shows a marker and the game value.
 * @param {HTMLElement} control
 * @param {() => any} getCurrent reads the live value (evaluated after each edit)
 * @param {any} baseValue the game's value; `undefined` means "nothing to compare with"
 */
function diffable(control, getCurrent, baseValue, format = (v) => fmt(Number(v))) {
  const wrap = el('span', { class: 'diffable' }, control);
  const marker = el('span', { class: 'game-value', title: 'Значение в игре' }, `в игре: ${baseValue === undefined ? '' : format(baseValue)}`);
  const update = () => {
    const changed = baseValue !== undefined && !sameValue(getCurrent(), baseValue);
    wrap.classList.toggle('is-changed', changed);
    if (changed && !marker.isConnected) wrap.append(marker);
    if (!changed && marker.isConnected) marker.remove();
  };
  update();
  diffables.push(update);
  return wrap;
}

function labelled(label, control, { hint = null } = {}) {
  return el('label', { class: 'kv' }, el('span', { class: 'kv-label' }, label), control, hint && el('span', { class: 'muted' }, hint));
}

/** Number field bound to `obj[key]`; `baseObj` (optional) drives the changed marker. */
function numField(obj, key, baseObj, opts = {}) {
  const input = numInput(obj[key], (v) => { obj[key] = opts.integer ? Math.round(v) : v; touchItem(); redrawReadouts(); }, { min: opts.min ?? 0, width: opts.width ?? '5.5rem', title: opts.title ?? null });
  return diffable(input, () => obj[key], baseObj?.[key]);
}

function toggleField(obj, key, baseObj, title) {
  return diffable(checkbox(obj[key], (on) => { obj[key] = on; touchItem(); }, { title }), () => !!obj[key], baseObj ? !!baseObj[key] : undefined, (v) => (v ? 'да' : 'нет'));
}

let readoutRedraws = [];
const redrawReadouts = () => readoutRedraws.forEach((fn) => fn());

/* ------------------------------------------------------------------ *
 *  Editors per kind                                                   *
 * ------------------------------------------------------------------ */

function damageEntriesEditor(item, entries, baseEntries, { withEffort = false } = {}) {
  const box = el('div', { class: 'entries' });
  const draw = () => {
    clear(box);
    const head = el('div', { class: 'entry-row entry-head' },
      el('span', null, 'Тип'), el('span', null, 'Урон'), withEffort && el('span', { title: 'Доля усилия атакующего (СИЛ), %' }, 'Усилие, %'),
      el('span', { title: 'Пробитие, %' }, 'Пробитие, %'), el('span', null, 'Твёрдость'), el('span', { title: 'Износ брони, %' }, 'Износ, %'),
      el('span', { title: 'Снижение урона бронёй, %' }, 'Сниж., %'), el('span', { title: 'Энергия снаряда' }, 'Энергия'), el('span', null));
    box.append(head);
    entries.forEach((entry, i) => {
      const base = baseEntries?.[i];
      const energy = el('span', { class: 'energy', title: 'Энергия снаряда' });
      const setEnergy = () => { energy.textContent = fmt(entryEnergy(entry)); };
      setEnergy();
      readoutRedraws.push(setEnergy);
      box.append(el('div', { class: 'entry-row' },
        diffable(selectEl(DAMAGE_TYPES.map((t) => ({ value: t.id, label: t.label })), entry.damageType, (v) => { entry.damageType = v; touchItem(); draw(); }, { title: 'Тип урона', style: `border-left:3px solid ${damageTypeColor(entry.damageType)}` }), () => entry.damageType, base?.damageType, damageTypeLabel),
        numField(entry, 'damage', base, { title: 'Урон' }),
        withEffort && numField(entry, 'effortShare', base, { title: 'Доля усилия' }),
        numField(entry, 'armorPen', base, { integer: true, title: 'Пробитие, %' }),
        numField(entry, 'hardness', base, { title: 'Твёрдость снаряда' }),
        numField(entry, 'armorDamageFactor', base, { integer: true, title: 'Износ брони, %' }),
        numField(entry, 'armorDamageReduction', base, { integer: true, title: 'Снижение урона бронёй, %' }),
        energy,
        iconButton('✕', 'Убрать запись урона', () => { entries.splice(i, 1); touchItem(); draw(); })));
    });
    box.append(button('+ запись урона', () => { entries.push(blankDamageEntry()); touchItem(); draw(); }, { cls: 'btn-small' }));
  };
  draw();
  return box;
}

function editMaterial(item) {
  const v = item.values;
  const b = isCompendium(item) ? item.base : null;
  const damageGrid = (key, label, { integer = true, step } = {}) => el('div', { class: 'grid-block' },
    el('h4', null, label),
    el('div', { class: 'type-grid' }, DAMAGE_TYPES.map((t) => el('label', { class: 'kv kv-compact' },
      el('span', { class: 'kv-label', style: `color:${damageTypeColor(t.id)}` }, t.label),
      diffable(numInput(v[key]?.[t.id] ?? 0, (n) => { (v[key] ??= {})[t.id] = Math.max(0, integer ? Math.round(n) : n); touchItem(); redrawReadouts(); }, { min: 0, step, width: '4.8rem', title: `${label}: ${t.label}` }), () => v[key]?.[t.id] ?? 0, b ? (b[key]?.[t.id] ?? 0) : undefined)))));
  // Shock transfer: the share of the absorbed damage a layer hands on as a blow (`conductance[T]` → concussive).
  const shockOf = (src, typeId) => (src?.conductance?.[typeId] ?? []).find((e) => e?.type === 'concussive')?.fraction ?? 0;
  const shockGrid = el('div', { class: 'grid-block' },
    el('h4', { title: 'Доля поглощённого слоем урона, которая уходит дальше ударом (запреградный удар)' }, 'Передача удара, доля'),
    el('div', { class: 'type-grid' }, DAMAGE_TYPES.map((t) => el('label', { class: 'kv kv-compact' },
      el('span', { class: 'kv-label', style: `color:${damageTypeColor(t.id)}` }, t.label),
      diffable(numInput(shockOf(v, t.id), (n) => {
        const list = (v.conductance ??= {})[t.id] = (v.conductance[t.id] ?? []).filter((e) => e?.type !== 'concussive');
        if (n > 0) list.push({ type: 'concussive', fraction: Math.min(1, Math.max(0, n)) });
        touchItem();
      }, { min: 0, max: 1, step: 0.05, width: '4.8rem', title: `Передача удара: ${t.label}` }), () => shockOf(v, t.id), b ? shockOf(b, t.id) : undefined)))));
  const holds = el('div', { class: 'readout' });
  const drawHolds = () => {
    clear(holds);
    holds.append(el('span', { class: 'muted' }, 'Держит энергию (баллистика): '));
    for (const t of [1, 5, 10, 50]) {
      holds.append(chip(`${t} мм → ${fmt((Number(v.hardness) || 0) * t * t * ((v.resistance?.ballistic ?? 0) / 100))}`, { title: `Энергия, которую слой толщиной ${t} мм держит против баллистики` }));
    }
  };
  readoutRedraws.push(drawHolds);
  drawHolds();
  return el('div', { class: 'editor' },
    el('div', { class: 'kv-row' },
      labelled('Категория', diffable(textInput(v.category, (s) => { v.category = s; touchItem(); }, { width: '9rem' }), () => v.category, b?.category, String)),
      labelled('Твёрдость', numField(v, 'hardness', b)),
      labelled('Прочность на мм', numField(v, 'integrityPerThickness', b)),
      labelled('Пробиваемость на мм', numField(v, 'breachCapacityPerThickness', b)),
      labelled('Вес на мм', numField(v, 'weightPerThickness', b))),
    holds,
    damageGrid('resistance', 'Сопротивление, %'),
    damageGrid('wear', 'Износ, %'),
    shockGrid,
    damageGrid('damping', 'Гашение удара на мм', { integer: false, step: 0.01 }),
    el('details', { class: 'raw' }, el('summary', null, 'Проводимость, самоиндукция, деградация (только чтение)'),
      el('pre', null, JSON.stringify({ conductance: v.conductance, selfInduction: v.selfInduction, degradation: v.degradation }, null, 1))));
}

function editAmmo(item) {
  const v = item.values;
  const b = isCompendium(item) ? item.base : null;
  v.falloff ??= { enabled: false, halfDistance: 0 };
  v.multishot ??= { enabled: false, count: 1, coneDegrees: 0 };
  v.onHitSplash ??= { enabled: false, radius: 0, unit: 'grid' };
  return el('div', { class: 'editor' },
    el('div', { class: 'kv-row' }, labelled('Калибр', diffable(textInput(v.caliber, (s) => { v.caliber = s; touchItem(); }, { width: '9rem' }), () => v.caliber, b?.caliber, String))),
    el('h4', null, 'Урон снаряда'),
    damageEntriesEditor(item, v.damage, b?.damage),
    el('h4', null, 'Спад по дистанции'),
    el('div', { class: 'kv-row' },
      labelled('Включён', toggleField(v.falloff, 'enabled', b?.falloff)),
      labelled('Половина силы на, м', numField(v.falloff, 'halfDistance', b?.falloff, { title: 'Расстояние, на котором энергия (и урон за ней) падает вдвое; пробитие не меняется' }))),
    el('h4', null, 'Дробь и взрыв'),
    el('div', { class: 'kv-row' },
      labelled('Несколько лучей', toggleField(v.multishot, 'enabled', b?.multishot)),
      labelled('Лучей', numField(v.multishot, 'count', b?.multishot, { integer: true, min: 1 })),
      labelled('Конус, °', numField(v.multishot, 'coneDegrees', b?.multishot)),
      labelled('Взрыв при попадании', toggleField(v.onHitSplash, 'enabled', b?.onHitSplash)),
      labelled('Радиус', numField(v.onHitSplash, 'radius', b?.onHitSplash))));
}

function editWeapon(item) {
  const v = item.values;
  const b = isCompendium(item) ? item.base : null;
  const lines = (v.lines ?? []).map((line, i) => {
    const baseLine = b?.lines?.[i];
    line.energyMult ??= { enabled: false, value: 100 };
    return el('div', { class: 'line-card' },
      el('div', { class: 'kv-row' },
        el('strong', null, line.name),
        labelled('Множитель энергии', toggleField(line.energyMult, 'enabled', baseLine?.energyMult)),
        labelled('Значение, %', numField(line.energyMult, 'value', baseLine?.energyMult, { integer: true })),
        el('span', { class: 'muted' }, 'Патроны: '), (line.calibers ?? []).length ? (line.calibers ?? []).map((c) => chip(c)) : chip('нет', { tone: 'dim' })),
      (line.damage ?? []).length ? [el('h4', null, 'Собственный урон линии'), damageEntriesEditor(item, line.damage, baseLine?.damage, { withEffort: true })] : el('p', { class: 'muted' }, 'Урон берётся из патрона.'));
  });
  return el('div', { class: 'editor' },
    el('div', { class: 'kv-row' }, labelled('Семейство', el('span', null, v.family || '—'))),
    el('p', { class: 'hint' }, 'У стрелкового оружия урон даёт патрон, оружие добавляет множитель энергии. У ближнего боя и лучевого — собственный урон линии.'),
    lines);
}

function editArmor(item) {
  const v = item.values;
  const b = isCompendium(item) ? item.base : null;
  const slots = db.anatomy.parts.map((p) => ({ value: p.slot, label: p.name }));
  const box = el('div', { class: 'editor' });
  const draw = () => {
    clear(box);
    box.append(el('p', { class: 'hint' }, `Анатомия: ${v.anatomyId}. Слои идут снаружи внутрь.`));
    (v.coveredParts ?? []).forEach((cover, i) => {
      box.append(el('div', { class: 'cover-card' },
        el('div', { class: 'kv-row' },
          labelled('Часть', selectEl(slots, cover.slotRef, (s) => { cover.slotRef = s; touchItem(); }, { title: 'Часть тела' })),
          labelled('Сторона', selectEl(FACES, cover.face ?? 'front', (s) => { cover.face = s; touchItem(); }, { title: 'Сторона' })),
          iconButton('✕', 'Убрать покрытие', () => { v.coveredParts.splice(i, 1); touchItem(); draw(); })),
        diffable(layersEditor(cover.layers ?? [], (layers) => { cover.layers = layers; touchItem(); }), () => cover.layers, b?.coveredParts?.[i]?.layers, (l) => (l ?? []).map((x) => `${x.material} ${x.thickness}`).join(' + '))));
    });
    box.append(button('+ покрытие', () => {
      (v.coveredParts ??= []).push({ slotRef: 'upperTorso', face: 'front', layers: [] });
      touchItem();
      draw();
    }, { cls: 'btn-small' }));
  };
  draw();
  return box;
}

function editPreset(item) {
  const v = item.values;
  return el('div', { class: 'editor' },
    el('div', { class: 'kv-row' }, labelled('Где используется', selectEl(PRESET_USES, v.use ?? 'armor', (s) => { v.use = s; touchItem(); }, { title: 'Где используется набор' }))),
    el('p', { class: 'hint' }, 'Набор слоёв — не предмет Foundry, а заготовка: броня на части тела или стена. Слои идут снаружи внутрь.'),
    layersEditor(v.layers ?? [], (layers) => { v.layers = layers; touchItem(); }));
}

const EDITORS = { material: editMaterial, ammo: editAmmo, weapon: editWeapon, armor: editArmor, preset: editPreset };

/* ------------------------------------------------------------------ *
 *  Detail pane                                                        *
 * ------------------------------------------------------------------ */

let headBox = null;

/** Name, status, actions and source line of the selected record (rebuilt after every edit). */
function buildHead(item) {
  const custom = !isCompendium(item);
  const nameField = custom
    ? textInput(item.name, (s) => { item.name = s.trim() || item.name; touchItem(); }, { cls: 'name-field', title: 'Название' })
    : el('h2', { class: 'item-title' }, item.name);
  return el('div', { class: 'head-wrap' },
    el('header', { class: 'detail-head' },
      item.kind === 'material' && materialDot(item.id.slice('material.'.length)),
      nameField,
      selectEl(Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })), item.status, (s) => { item.status = s; touchItem(); }, { title: 'Статус записи' }),
      el('span', { class: 'spacer' }),
      isChanged(item) && button('Сбросить к игровым', () => { item.values = clone(item.base); item.baseChanged = false; touchItem(); renderDetail(); }, { cls: 'btn-small' }),
      button('Дублировать', () => duplicateItem(item), { cls: 'btn-small' }),
      custom && button('Удалить', () => deleteItem(item), { cls: 'btn-small btn-danger' })),
    el('p', { class: 'source muted' },
      isCompendium(item) ? `Компендиум: ${item.source.file}` : (item.source?.from ? `Свой набор, скопирован из «${item.source.from}»` : 'Свой предмет (не из компендиума)'),
      item.baseChanged && ' · игровые значения в компендиуме изменились после правок',
      item.missing && ' · записи больше нет в компендиуме'),
    item.status === 'draft' && el('p', { class: 'draft-note' }, 'Черновик: числа взяты из игры как есть и не считаются целью баланса.'));
}

function refreshHead() {
  const item = prefs.selectedId ? getItem(prefs.selectedId) : null;
  if (!headBox?.isConnected || !item) return;
  const next = buildHead(item);
  headBox.replaceWith(next);
  headBox = next;
}

function renderDetail() {
  clear(detailBox);
  readoutRedraws = [];
  diffables = [];
  const item = prefs.selectedId ? getItem(prefs.selectedId) : null;
  if (!item || item.kind !== prefs.kind) {
    detailBox.append(el('p', { class: 'empty' }, 'Выберите запись слева.'));
    return;
  }
  const notes = el('textarea', { class: 'field note', rows: 2, placeholder: 'Заметки: почему такие значения', on: { change: () => { item.notes = notes.value; touch('items'); } } });
  notes.value = item.notes ?? '';
  autoGrow(notes);
  headBox = buildHead(item);
  detailBox.append(
    headBox,
    EDITORS[item.kind](item),
    el('label', { class: 'kv kv-wide' }, el('span', { class: 'kv-label' }, 'Заметки'), notes));
}

function duplicateItem(item) {
  const copy = clone(item);
  copy.id = uid(item.kind);
  copy.name = `${item.name} (копия)`;
  copy.status = 'working';
  copy.source = { type: 'custom', from: item.id };
  copy.base = null;
  copy.baseChanged = false;
  copy.missing = false;
  db.items.items.push(copy);
  prefs.selectedId = copy.id;
  savePrefs();
  touchItem();
  renderDetail();
}

function deleteItem(item) {
  const idx = db.items.items.indexOf(item);
  db.items.items.splice(idx, 1);
  prefs.selectedId = null;
  savePrefs();
  touchItem();
  renderDetail();
  toast(`«${item.name}» удалено`, { undo: () => { db.items.items.splice(idx, 0, item); touchItem(); } });
}

function createItem() {
  const kind = prefs.kind;
  if (kind === 'weapon') { toast('Оружие создаётся копированием существующего', { tone: 'info' }); return; }
  const item = {
    id: uid(kind), kind, name: `Новый ${KINDS.find((k) => k.id === kind).one}`, group: '', status: 'working',
    source: { type: 'custom' }, base: null, values: blankValues(kind), notes: '',
  };
  db.items.items.push(item);
  prefs.selectedId = item.id;
  savePrefs();
  touchItem();
  renderDetail();
}

/* ------------------------------------------------------------------ *
 *  List pane                                                          *
 * ------------------------------------------------------------------ */

function visibleItems() {
  const q = prefs.search.trim().toLowerCase();
  return db.items.items
    .filter((it) => it.kind === prefs.kind)
    .filter((it) => prefs.status === 'all' || it.status === prefs.status || (prefs.status === 'changed' && isChanged(it)))
    .filter((it) => !q || `${it.name} ${it.group}`.toLowerCase().includes(q))
    .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '', 'ru') || a.name.localeCompare(b.name, 'ru'));
}

function renderList() {
  clear(listBox);
  const items = visibleItems();
  let lastGroup = null;
  for (const it of items) {
    if (it.group !== lastGroup) {
      lastGroup = it.group;
      if (it.group) listBox.append(el('div', { class: 'list-group' }, it.group));
    }
    listBox.append(el('button', {
      class: `list-item${it.id === prefs.selectedId ? ' is-active' : ''}`, type: 'button',
      on: { click: () => { prefs.selectedId = it.id; savePrefs(); renderList(); renderDetail(); } },
    },
    it.kind === 'material' && materialDot(it.id.slice('material.'.length)),
    el('span', { class: 'li-name' }, it.name),
    isChanged(it) && el('span', { class: 'dot dot-changed', title: 'Значения изменены относительно игры' }),
    it.baseChanged && el('span', { class: 'dot dot-warn', title: 'Игровые значения изменились' }),
    it.missing && el('span', { class: 'dot dot-warn', title: 'Нет в компендиуме' }),
    statusBadge(it.status)));
  }
  if (!items.length) listBox.append(el('p', { class: 'empty' }, 'Ничего не найдено.'));
}

/* ------------------------------------------------------------------ *
 *  Compendium actions                                                 *
 * ------------------------------------------------------------------ */

async function importCompendium() {
  try {
    await flush();
    const res = await api.importCompendium();
    adoptCollection('items', res.doc);
    emitChange('items');
    renderList();
    renderDetail();
    const s = res.stats;
    toast(`Компендиум: новых ${s.added}, обновлено ${s.refreshed}, с правками сохранено ${s.kept}, пропало ${s.missing}`);
  } catch (e) {
    toast(`Импорт не удался: ${e.message}`, { tone: 'error' });
  }
}

async function writeBackDialog() {
  await flush();
  let plan;
  try {
    plan = await api.writeBackPlan();
  } catch (e) {
    toast(`Не удалось собрать список: ${e.message}`, { tone: 'error' });
    return;
  }
  const log = el('pre', { class: 'log' });
  const body = el('div', null,
    plan.plan.length
      ? el('table', { class: 'plain-table' },
        el('thead', null, el('tr', null, el('th', null, 'Запись'), el('th', null, 'Что изменено'), el('th', null, 'Файл'))),
        el('tbody', null, plan.plan.map((p) => el('tr', null, el('td', null, p.name), el('td', null, p.keys.join(', ')), el('td', { class: 'muted' }, p.file)))))
      : el('p', { class: 'empty' }, 'Изменённых значений нет — писать нечего.'),
    !plan.cleanRoundTrip && el('p', { class: 'hint' }, 'Часть исходных файлов форматирована иначе, чем JSON.stringify: после записи в git появятся лишние строки diff.'),
    el('p', { class: 'hint' }, 'Запись меняет файлы в pack-src/sh-test-items. Сборка в LevelDB — отдельный шаг, Foundry при этом должен быть закрыт.'),
    log);
  const modal = openModal({
    title: 'Записать значения в компендиум',
    body,
    wide: true,
    buttons: [
      { label: 'Закрыть' },
      {
        label: 'Записать в pack-src', primary: true,
        onClick: async () => {
          const res = await api.writeBackApply();
          log.textContent = `Записано файлов: ${res.written.length}\n${res.written.join('\n')}`;
          return false;
        },
      },
      {
        label: 'Собрать пак (Foundry закрыт)',
        onClick: async () => {
          log.textContent = 'Сборка…';
          const res = await api.pack();
          log.textContent = `Код выхода ${res.code}\n${res.output}`;
          return false;
        },
      },
    ],
  });
  return modal;
}

/* ------------------------------------------------------------------ *
 *  Mount                                                              *
 * ------------------------------------------------------------------ */

function renderShell() {
  clear(root);
  const counts = Object.fromEntries(KINDS.map((k) => [k.id, itemsOfKind(k.id).length]));
  const search = el('input', {
    class: 'field search', type: 'search', placeholder: 'Поиск', title: 'Поиск по базе', value: prefs.search,
    on: { input: () => { prefs.search = search.value; savePrefs(); renderList(); } },
  });
  search.value = prefs.search;
  listBox = el('div', { class: 'item-list' });
  detailBox = el('div', { class: 'item-detail' });
  root.append(
    el('div', { class: 'toolbar' },
      segmented(KINDS.map((k) => ({ value: k.id, label: `${k.label} ${counts[k.id]}` })), prefs.kind, (v) => { prefs.kind = v; prefs.selectedId = null; savePrefs(); renderShell(); }),
      el('span', { class: 'spacer' }),
      button('Обновить из компендиума', importCompendium, { cls: 'btn-small', title: 'Подтянуть предметы из pack-src/sh-test-items' }),
      button('В компендиум…', writeBackDialog, { cls: 'btn-small', title: 'Записать изменённые значения в pack-src' })),
    el('div', { class: 'split' },
      el('aside', { class: 'split-list' },
        el('div', { class: 'list-tools' },
          search,
          selectEl([{ value: 'all', label: 'Все статусы' }, ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })), { value: 'changed', label: 'Изменённые' }], prefs.status, (v) => { prefs.status = v; savePrefs(); renderList(); }, { title: 'Фильтр по статусу' }),
          iconButton('+', 'Новая запись', createItem)),
        listBox),
      detailBox));
  renderList();
  renderDetail();
}

export function mountDb(container) {
  root = container;
  renderShell();
}

export function refreshDb() {
  if (root) renderShell();
}

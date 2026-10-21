/** Dictionary editor: outcome scale, weapon types and hit parts. */

import { el, clear, uid } from './util.js';
import { db, touch, emitChange } from './state.js';
import { button, iconButton, numInput, openModal, selectEl, textInput } from './widgets.js';

const SEVERITIES = [6, 5, 4, 3, 2, 1, 0].map((n) => ({ value: String(n), label: `${n}${n === 6 ? ' — худший' : n === 0 ? ' — без последствий' : ''}` }));

function usage() {
  const rows = db.cases.rows;
  const groups = db.cases.groups;
  return {
    outcome: (id) => rows.filter((r) => r.worst === id || r.best === id).length,
    type: (id) => groups.filter((g) => g.weaponType === id).length,
    part: (id) => groups.filter((g) => g.part === id).length,
  };
}

export function openDictionaries(onClose) {
  const body = el('div', { class: 'dicts' });
  const dict = db.dictionaries;
  const used = usage();
  const changed = () => { touch('dictionaries'); emitChange('dictionaries'); };

  const move = (list, i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    changed();
    draw();
  };

  const section = (title, hint, rows, adder) => el('section', { class: 'card' }, el('h3', null, title), hint && el('p', { class: 'hint' }, hint), rows, adder);

  const draw = () => {
    clear(body);
    body.append(
      section('Исходы для цели', 'От худшего к лучшему для цели. «Тяжесть» красит выпадающие списки и подсказывает, какой исход в паре ☠ худший / ♥ лучший.',
        dict.outcomes.map((o, i) => el('div', { class: 'dict-row' },
          textInput(o.label, (v) => { o.label = v.trim() || o.label; changed(); }, { width: '16rem', title: 'Название исхода' }),
          selectEl(SEVERITIES, String(o.severity), (v) => { o.severity = Number(v); changed(); }, { title: 'Тяжесть' }),
          el('span', { class: 'muted' }, used.outcome(o.id) ? `используется: ${used.outcome(o.id)}` : ''),
          iconButton('↑', 'Выше', () => move(dict.outcomes, i, -1)), iconButton('↓', 'Ниже', () => move(dict.outcomes, i, 1)),
          iconButton('✕', used.outcome(o.id) ? 'Исход используется' : 'Удалить исход', () => { if (used.outcome(o.id)) return; dict.outcomes.splice(i, 1); changed(); draw(); }, { cls: used.outcome(o.id) ? 'is-disabled' : '' }))),
        button('+ исход', () => { dict.outcomes.push({ id: uid('o'), label: 'Новый исход', severity: 3 }); changed(); draw(); }, { cls: 'btn-small' })),
      section('Типы оружия', 'Корень дерева случаев.',
        dict.weaponTypes.map((t, i) => el('div', { class: 'dict-row' },
          textInput(t.label, (v) => { t.label = v.trim() || t.label; changed(); }, { width: '16rem', title: 'Название типа' }),
          el('span', { class: 'muted' }, used.type(t.id) ? `случаев: ${used.type(t.id)}` : ''),
          iconButton('↑', 'Выше', () => move(dict.weaponTypes, i, -1)), iconButton('↓', 'Ниже', () => move(dict.weaponTypes, i, 1)),
          iconButton('✕', used.type(t.id) ? 'В типе есть случаи' : 'Удалить тип', () => { if (used.type(t.id)) return; dict.weaponTypes.splice(i, 1); changed(); draw(); }, { cls: used.type(t.id) ? 'is-disabled' : '' }))),
        button('+ тип', () => { dict.weaponTypes.push({ id: uid('t'), label: 'Новый тип' }); changed(); draw(); }, { cls: 'btn-small' })),
      section('Части тела', 'Слот — часть анатомии humanoid, по которой бьёт калькулятор; своё HP заменяет HP из анатомии.',
        dict.parts.map((p, i) => el('div', { class: 'dict-row' },
          textInput(p.label, (v) => { p.label = v.trim() || p.label; changed(); }, { width: '12rem', title: 'Название части' }),
          selectEl(db.anatomy.parts.map((a) => ({ value: a.slot, label: `${a.name} (${a.maxHp} HP)` })), p.slot, (v) => { p.slot = v; changed(); }, { title: 'Слот анатомии' }),
          el('label', { class: 'kv kv-compact' }, el('span', { class: 'kv-label' }, 'Своё HP'), numInput(p.hp ?? '', (v) => { p.hp = v > 0 ? v : null; changed(); }, { min: 0, width: '5rem', placeholder: 'из анатомии' })),
          el('span', { class: 'muted' }, used.part(p.id) ? `случаев: ${used.part(p.id)}` : ''),
          iconButton('✕', used.part(p.id) ? 'Часть используется' : 'Удалить часть', () => { if (used.part(p.id)) return; dict.parts.splice(i, 1); changed(); draw(); }, { cls: used.part(p.id) ? 'is-disabled' : '' }))),
        button('+ часть', () => { dict.parts.push({ id: uid('p'), label: 'Новая часть', slot: db.anatomy.parts[0].slot, hp: null }); changed(); draw(); }, { cls: 'btn-small' })));
  };
  draw();
  openModal({ title: 'Справочники', body, wide: true, buttons: [{ label: 'Готово', primary: true }], onClose });
}

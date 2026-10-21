/** Reusable controls: selects, number fields, layer editor, armour picker, modal and toast. */

import { el, clear, parseNum, clone, sameValue } from './util.js';
import { db, getItem, itemsOfKind, materialName, outcomeOf } from './state.js';
import { materialColor } from './icons.js';

/* ------------------------------------------------------------------ *
 *  Toast / modal                                                      *
 * ------------------------------------------------------------------ */

export function toast(text, { undo = null, ms = 6000, tone = 'info' } = {}) {
  const host = document.getElementById('toasts');
  const node = el('div', { class: `toast toast-${tone}` }, el('span', null, text));
  if (undo) {
    node.append(el('button', { class: 'btn btn-link', type: 'button', on: { click: () => { undo(); node.remove(); } } }, 'Отменить'));
  }
  host.append(node);
  setTimeout(() => node.remove(), ms);
  return node;
}

/**
 * @param {{ title: string, body: Node, buttons?: Array<{label: string, primary?: boolean, onClick?: () => (void|false|Promise<void|false>)}>, wide?: boolean }} options
 * @returns {{ close: () => void, root: HTMLElement }}
 */
export function openModal({ title, body, buttons = [{ label: 'Закрыть' }], wide = false, onClose = null }) {
  const host = document.getElementById('modals');
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const footer = el('footer', { class: 'modal-foot' }, buttons.map((b) => el('button', {
    class: `btn${b.primary ? ' btn-primary' : ''}`,
    type: 'button',
    on: {
      click: async () => {
        const keep = await b.onClick?.();
        if (keep !== false) close();
      },
    },
  }, b.label)));
  const root = el('div', { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-label': title },
    el('header', { class: 'modal-head' }, el('h2', null, title), el('button', { class: 'btn btn-icon', type: 'button', title: 'Закрыть', on: { click: close } }, '✕')),
    el('div', { class: 'modal-body' }, body),
    footer);
  const backdrop = el('div', { class: 'modal-backdrop', on: { mousedown: (e) => { if (e.target === backdrop) close(); } } }, root);
  host.append(backdrop);
  document.addEventListener('keydown', onKey);
  return { close, root };
}

/* ------------------------------------------------------------------ *
 *  Fields                                                             *
 * ------------------------------------------------------------------ */

/**
 * @param {Array<{value: string, label: string}|{group: string, options: Array<{value: string, label: string}>}>} options
 * @param {string} value
 * @param {(value: string) => void} onChange
 * @param {Record<string, any>} [attrs]
 */
export function selectEl(options, value, onChange, attrs = {}) {
  const select = el('select', { class: 'field', ...attrs, on: { change: () => onChange(select.value) } });
  const build = (opt) => el('option', { value: opt.value, selected: opt.value === value }, opt.label);
  for (const opt of options) {
    if (opt.group) select.append(el('optgroup', { label: opt.group }, opt.options.map(build)));
    else select.append(build(opt));
  }
  if (!options.flatMap((o) => o.options ?? [o]).some((o) => o.value === value)) {
    select.prepend(el('option', { value, selected: true }, value ? `(${value})` : '—'));
  }
  select.value = value;
  return select;
}

/** Numeric input that commits on change (not on every keystroke). */
export function numInput(value, onChange, { min = null, max = null, step = 'any', width = null, title = null, placeholder = null, cls = '' } = {}) {
  const input = el('input', {
    class: `field field-num ${cls}`.trim(), type: 'number', value: value ?? '', min, max, step, title, placeholder,
    style: width ? `width:${width}` : null,
    on: { change: () => onChange(parseNum(input.value, 0), input) },
  });
  return input;
}

export function textInput(value, onChange, { placeholder = '', list = null, cls = '', title = null, width = null } = {}) {
  return el('input', {
    class: `field ${cls}`.trim(), type: 'text', value: value ?? '', placeholder, list, title,
    style: width ? `width:${width}` : null,
    on: { change: (e) => onChange(e.target.value) },
  });
}

export function checkbox(checked, onChange, { title = null } = {}) {
  const input = el('input', { type: 'checkbox', checked: !!checked, title, on: { change: () => onChange(input.checked) } });
  return input;
}

export function iconButton(glyph, title, onClick, { cls = '' } = {}) {
  return el('button', { class: `btn btn-icon ${cls}`.trim(), type: 'button', title, 'aria-label': title, on: { click: onClick } }, glyph);
}

export function button(label, onClick, { primary = false, cls = '', title = null, disabled = false } = {}) {
  return el('button', { class: `btn${primary ? ' btn-primary' : ''} ${cls}`.trim(), type: 'button', title, disabled, on: { click: onClick } }, label);
}

/** A row of exclusive buttons (segmented control). */
export function segmented(options, value, onChange) {
  const wrap = el('div', { class: 'seg', role: 'group' });
  for (const opt of options) {
    wrap.append(el('button', {
      class: `seg-item${opt.value === value ? ' is-on' : ''}`, type: 'button', title: opt.title ?? null,
      on: { click: () => { onChange(opt.value); } },
    }, opt.label));
  }
  return wrap;
}

/* ------------------------------------------------------------------ *
 *  Outcome select                                                     *
 * ------------------------------------------------------------------ */

export function outcomeOptions(emptyLabel = '—') {
  return [{ value: '', label: emptyLabel }, ...db.dictionaries.outcomes.map((o) => ({ value: o.id, label: o.label }))];
}

/** Dropdown of outcomes, coloured by severity. */
export function outcomeSelect(value, onChange, { emptyLabel = '—', title = null } = {}) {
  const sev = outcomeOf(value)?.severity;
  const select = selectEl(outcomeOptions(emptyLabel), value ?? '', (v) => {
    onChange(v || null);
    const s = outcomeOf(v)?.severity;
    select.className = `field outcome${s == null ? '' : ` sev-${s}`}`;
  }, { title });
  select.className = `field outcome${sev == null ? '' : ` sev-${sev}`}`;
  return select;
}

/* ------------------------------------------------------------------ *
 *  Layers                                                             *
 * ------------------------------------------------------------------ */

/** Colour of a material slug, using the category of its database record as the fallback. */
export function colorOfMaterial(slug) {
  return materialColor(slug, getItem(`material.${slug}`)?.values?.category);
}

/** Small round swatch in the material's colour. */
export function materialDot(slug) {
  return el('i', { class: 'mat-dot', style: `--mat:${colorOfMaterial(slug)}` });
}

/** Material name with its swatch (and optional thickness), tinted in the material's colour. */
export function materialTag(slug, thickness = null) {
  return el('span', { class: 'mat-tag', style: `--mat:${colorOfMaterial(slug)}` },
    el('i', { class: 'mat-dot' }), materialName(slug), thickness != null && el('b', null, `${thickness} мм`));
}

/** A layer list as a row of coloured material tags, outer layer first. */
export function layerTags(layers) {
  const list = layers ?? [];
  if (!list.length) return el('span', { class: 'muted' }, 'нет слоёв');
  return el('span', { class: 'layer-tags', title: 'Слои снаружи внутрь' }, list.map((l) => materialTag(l.material, l.thickness)));
}

function materialOptions() {
  const byCategory = new Map();
  for (const m of itemsOfKind('material')) {
    const cat = m.values?.category || 'other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push({ value: m.id.replace(/^material\./, ''), label: m.name });
  }
  return [...byCategory.entries()].map(([group, options]) => ({ group, options: options.sort((a, b) => a.label.localeCompare(b.label, 'ru')) }));
}

/**
 * Editor of an ordered layer list (outer first).
 * @param {Array<{material: string, thickness: number}>} layers
 * @param {(layers: Array<{material: string, thickness: number}>) => void} onChange
 */
export function layersEditor(layers, onChange) {
  const root = el('div', { class: 'layers' });
  const state = layers.map((l) => ({ ...l }));
  const commit = () => onChange(state.map((l) => ({ ...l })));
  const render = () => {
    clear(root);
    const options = materialOptions();
    state.forEach((layer, i) => {
      root.append(el('div', { class: 'layer-row' },
        el('span', { class: 'layer-n' }, `${i + 1}`),
        materialDot(layer.material),
        selectEl(options, layer.material, (v) => { layer.material = v; commit(); render(); }, { title: 'Материал слоя' }),
        numInput(layer.thickness, (v) => { layer.thickness = Math.max(0, v); commit(); }, { min: 0, width: '5.5rem', title: 'Толщина слоя, мм' }),
        el('span', { class: 'unit' }, 'мм'),
        iconButton('↑', 'Слой выше', () => { if (i > 0) { [state[i - 1], state[i]] = [state[i], state[i - 1]]; commit(); render(); } }),
        iconButton('↓', 'Слой ниже', () => { if (i < state.length - 1) { [state[i + 1], state[i]] = [state[i], state[i + 1]]; commit(); render(); } }),
        iconButton('✕', 'Убрать слой', () => { state.splice(i, 1); commit(); render(); })));
    });
    root.append(button('+ слой', () => {
      state.push({ material: options[0]?.options?.[0]?.value ?? 'steel-plate', thickness: 1 });
      commit();
      render();
    }, { cls: 'btn-small' }));
  };
  render();
  return root;
}

/** Dialog that edits a layer list; resolves with the layers or `null` when cancelled. */
export function editLayersDialog(layers, { title = 'Слои брони', label = null } = {}) {
  return new Promise((resolve) => {
    let current = layers.map((l) => ({ ...l }));
    let name = label ?? '';
    const body = el('div', null,
      el('p', { class: 'hint' }, 'Слои идут снаружи внутрь: первый встречает пулю первым.'),
      layersEditor(current, (next) => { current = next; }),
      el('label', { class: 'row-gap' }, el('span', { class: 'muted' }, 'Подпись (необязательно)'),
        textInput(name, (v) => { name = v; }, { placeholder: 'например, Метр стали' })));
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    openModal({
      title,
      body,
      buttons: [
        { label: 'Отмена', onClick: () => finish(null) },
        { label: 'Применить', primary: true, onClick: () => finish({ layers: current.filter((l) => l.material && l.thickness > 0), label: name.trim() }) },
      ],
      onClose: () => finish(null),
    });
  });
}

/* ------------------------------------------------------------------ *
 *  Armour picker                                                      *
 * ------------------------------------------------------------------ */

const CUSTOM_LAYERS = '__layers';

function armorSelectOptions(mode) {
  const uses = mode === 'wall' ? ['wall', 'both'] : ['armor', 'both'];
  const presets = itemsOfKind('preset').filter((p) => uses.includes(p.values?.use));
  const wearables = mode === 'wall' ? [] : itemsOfKind('armor');
  const out = mode === 'wall' ? [] : [{ value: 'none', label: 'Без брони' }];
  if (presets.length) out.push({ group: 'Наборы', options: presets.map((p) => ({ value: `preset:${p.id}`, label: p.name })) });
  if (wearables.length) out.push({ group: 'Предметы из игры', options: wearables.map((p) => ({ value: `item:${p.id}`, label: p.name })) });
  out.push({ value: CUSTOM_LAYERS, label: '✎ Свои слои…' });
  return out;
}

function specKey(spec) {
  if (!spec || !spec.kind || spec.kind === 'none') return 'none';
  if (spec.kind === 'preset') return `preset:${spec.presetId}`;
  if (spec.kind === 'item') return `item:${spec.itemId}`;
  return CUSTOM_LAYERS;
}

/**
 * Armour selector: none / preset / game wearable / own layers. `mode: 'wall'` offers wall presets and
 * own layers only.
 * @param {object} spec current armour spec (not mutated)
 * @param {(spec: object) => void} onChange
 */
export function armorPicker(spec, onChange, { title = 'Броня', mode = 'armor' } = {}) {
  const wrap = el('span', { class: 'armor-pick' });
  const draw = (current) => {
    clear(wrap);
    const options = armorSelectOptions(mode);
    const key = specKey(current);
    const select = selectEl(options, key, async (v) => {
      if (v === 'none') return commit({ kind: 'none' });
      if (v.startsWith('preset:')) return commit({ kind: 'preset', presetId: v.slice(7) });
      if (v.startsWith('item:')) return commit({ kind: 'item', itemId: v.slice(5) });
      const seed = current.kind === 'preset' ? clone(getItem(current.presetId)?.values?.layers ?? []) : (current.layers ?? []);
      const res = await editLayersDialog(seed, { label: current.label });
      if (!res) return draw(current);
      return commit({ kind: 'layers', layers: res.layers, label: res.label });
    }, { title });
    if (current.kind === 'layers') {
      const existing = [...select.options].find((o) => o.value === CUSTOM_LAYERS);
      if (existing) existing.textContent = `✎ ${current.label || 'Свои слои'}`;
    }
    wrap.append(select);
    if (current.kind === 'layers') {
      wrap.append(iconButton('✎', 'Изменить слои', async () => {
        const res = await editLayersDialog(current.layers ?? [], { label: current.label });
        if (res) commit({ kind: 'layers', layers: res.layers, label: res.label });
      }));
    }
    if (current.kind === 'preset') {
      const target = getItem(current.presetId);
      if (target?.kind === 'preset') wrap.append(layerTags(target.values.layers));
    } else if (current.kind === 'layers') {
      wrap.append(layerTags(current.layers));
    }
  };
  const commit = (next) => {
    if (!sameValue(next, spec)) onChange(next);
    spec = next;
    draw(next);
  };
  draw(spec ?? { kind: mode === 'wall' ? 'layers' : 'none', layers: [] });
  return wrap;
}

/* ------------------------------------------------------------------ *
 *  Misc                                                               *
 * ------------------------------------------------------------------ */

export function chip(text, { tone = '', title = null } = {}) {
  return el('span', { class: `chip${tone ? ` chip-${tone}` : ''}`, title }, text);
}

export const STATUS_LABELS = Object.freeze({ draft: 'Черновик', working: 'В работе', approved: 'Утверждено' });

export function statusBadge(status) {
  return el('span', { class: `badge badge-${status}`, title: 'Статус записи' }, STATUS_LABELS[status] ?? status);
}

export { materialName };

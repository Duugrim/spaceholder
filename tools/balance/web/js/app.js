/** Entry point: loads the database, builds the tabs and wires the top bar. */

import { el, clear, readStored, writeStored } from './util.js';
import { db, load, onStatus, onChange, flush, installUnloadFlush } from './state.js';
import { api } from './api.js';
import { button, openModal, toast } from './widgets.js';
import { mountCases } from './tab-cases.js';
import { mountDb } from './tab-db.js';
import { mountCalc, loadFromCase } from './tab-calc.js';
import { openDictionaries } from './dictionaries.js';

const TABS = [
  { id: 'cases', label: 'Случаи', mount: (panel) => mountCases(panel, { openCalc }) },
  { id: 'db', label: 'База', mount: (panel) => mountDb(panel) },
  { id: 'calc', label: 'Калькулятор', mount: (panel) => mountCalc(panel) },
];

const STATUS_TEXT = { saved: 'Сохранено', dirty: 'Изменено…', saving: 'Сохранение…', error: 'Ошибка сохранения', conflict: 'Конфликт версий' };

let active = null;

function activate(id, { push = true } = {}) {
  const tab = TABS.find((t) => t.id === id) ?? TABS[0];
  active = tab.id;
  for (const btn of document.querySelectorAll('#tabs .tab')) btn.classList.toggle('is-on', btn.dataset.tab === tab.id);
  if (push) history.replaceState(null, '', `#${tab.id}`);
  writeStored('balance.tab', tab.id);
  const panel = document.getElementById('panel');
  clear(panel);
  window.scrollTo(0, 0);
  tab.mount(panel);
}

function openCalc(group, row) {
  loadFromCase(group, row);
  activate('calc');
}

function buildTabs() {
  const nav = document.getElementById('tabs');
  for (const tab of TABS) {
    nav.append(el('button', { class: 'tab', type: 'button', dataset: { tab: tab.id }, on: { click: () => activate(tab.id) } }, tab.label));
  }
}

function wireStatus() {
  const node = document.getElementById('save-status');
  const banner = document.getElementById('banner');
  onStatus((status, detail) => {
    node.textContent = STATUS_TEXT[status] ?? status;
    node.className = `save-status is-${status}`;
    node.title = detail || '';
    banner.hidden = status !== 'conflict';
    if (status === 'conflict') {
      clear(banner);
      banner.append(el('span', null, 'Данные на диске изменились вне этой вкладки. Ваши последние правки не сохранены.'),
        button('Перезагрузить страницу', () => location.reload(), { cls: 'btn-small' }));
    }
  });
}

async function exportForAi() {
  await flush();
  try {
    const res = await api.exportMarkdown(true);
    const area = el('textarea', { class: 'field export-text', readonly: true, rows: 18 });
    area.value = res.text;
    openModal({
      title: 'Экспорт для ИИ',
      wide: true,
      body: el('div', null,
        el('p', { class: 'hint' }, res.savedTo ? `Сохранено в ${res.savedTo}` : 'Не сохранено на диск.'),
        area),
      buttons: [
        { label: 'Закрыть' },
        {
          label: 'Копировать', primary: true,
          onClick: async () => {
            try { await navigator.clipboard.writeText(res.text); toast('Скопировано'); } catch { area.select(); toast('Выделено — скопируйте вручную', { tone: 'error' }); }
            return false;
          },
        },
      ],
    });
  } catch (e) {
    toast(`Экспорт не удался: ${e.message}`, { tone: 'error' });
  }
}

async function main() {
  buildTabs();
  wireStatus();
  installUnloadFlush();
  try {
    await load();
  } catch (e) {
    document.getElementById('panel').append(el('p', { class: 'empty' }, `Не удалось загрузить данные: ${e.message}`));
    return;
  }
  document.getElementById('btn-dicts').addEventListener('click', () => openDictionaries(() => { if (active === 'cases') activate('cases', { push: false }); }));
  document.getElementById('btn-export').addEventListener('click', exportForAi);
  onChange((topic) => { if (topic === 'cases' && active === 'cases') activate('cases', { push: false }); });
  const wanted = location.hash.slice(1) || readStored('balance.tab', 'cases');
  activate(wanted, { push: false });
}

main();

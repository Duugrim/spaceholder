const MODULE_NS = 'spaceholder';
let _hooksInstalled = false;

/**
 * Нормализовать UUID-подобную строку.
 * Поддерживает @UUID[...]
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeUuid(raw) {
  const str = String(raw ?? '').trim();
  if (!str) return '';
  const match = str.match(/@UUID\[(.+?)\]/);
  return (match?.[1] ?? str).trim();
}

/**
 * Разобрать строку со списком фракций пользователя.
 * Основной формат: 1 UUID на строку.
 * Дополнительно поддерживаем разделение запятыми/точками с запятой.
 * @param {unknown} raw
 * @returns {string[]} массив нормализованных UUID
 */
export function parseFactionUuidList(raw) {
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.map(normalizeUuid).filter(Boolean)));
  }

  const text = String(raw ?? '').trim();
  if (!text) return [];

  const parts = text
    .split(/\r?\n|,|;/g)
    .map((s) => normalizeUuid(s))
    .map((s) => s.trim())
    .filter(Boolean);

  return Array.from(new Set(parts));
}

/**
 * Получить список фракций для пользователя.
 * @param {User} user
 * @returns {string[]}
 */
export function getUserFactionUuids(user) {
  if (!user) return [];
  const raw = user.getFlag?.(MODULE_NS, 'factions');
  return parseFactionUuidList(raw);
}

/**
 * Получить фракцию(и) актора.
 * Пока используем только globalobject + system.gFaction.
 * @param {Actor} actor
 * @returns {string[]}
 */
export function getActorFactionUuids(actor) {
  if (!actor) return [];
  if (actor.type !== 'globalobject') return [];
  const uuid = normalizeUuid(actor.system?.gFaction);
  return uuid ? [uuid] : [];
}

/**
 * Получить фракцию(и) токена.
 * Принимает TokenDocument или Token (placeable).
 * @param {TokenDocument|Token} tokenLike
 * @returns {string[]}
 */
export function getTokenFactionUuids(tokenLike) {
  const doc = tokenLike?.document ?? tokenLike;
  const actor = doc?.actor;
  return getActorFactionUuids(actor);
}

/**
 * Найти пользователей, у которых назначена указанная фракция.
 * @param {string} factionUuid
 * @returns {User[]}
 */
export function getUsersForFaction(factionUuid) {
  const key = normalizeUuid(factionUuid);
  if (!key) return [];

  const users = Array.from(game?.users?.values?.() ?? game?.users?.contents ?? []);
  return users.filter((u) => getUserFactionUuids(u).includes(key));
}

/**
 * Найти пользователей по фракции токена.
 * @param {TokenDocument|Token} tokenLike
 * @returns {User[]}
 */
export function getUsersForToken(tokenLike) {
  const factions = getTokenFactionUuids(tokenLike);
  if (!factions.length) return [];
  // На будущее (если актёров будет многофракционность) — объединяем по любому совпадению.
  const users = new Set();
  for (const f of factions) {
    for (const u of getUsersForFaction(f)) users.add(u);
  }
  return Array.from(users);
}

/**
 * Попытаться извлечь UUID из drag&drop данных (JournalEntry/JournalEntryPage).
 * @param {DragEvent} event
 * @returns {string}
 */
function _extractUuidFromDropEvent(event) {
  const dt = event?.dataTransfer;
  if (!dt) return '';

  const rawCandidates = [
    dt.getData('application/json'),
    dt.getData('text/plain'),
  ].filter(Boolean);

  for (const raw of rawCandidates) {
    try {
      const data = JSON.parse(raw);
      const uuid = data?.uuid || data?.data?.uuid;
      if (uuid) return normalizeUuid(uuid);
    } catch (e) {
      const uuid = normalizeUuid(raw);
      if (uuid) return uuid;
    }
  }

  return '';
}

/**
 * Если UUID указывает на JournalEntryPage — вернуть uuid родительского JournalEntry.
 * Иначе вернуть исходный UUID.
 * @param {string} uuid
 * @returns {Promise<string>}
 */
function _looksLikeJournalUuid(uuid) {
  const u = normalizeUuid(uuid);
  return !!u && u.includes('JournalEntry');
}

async function _coerceToJournalEntryUuid(uuid) {
  const u = normalizeUuid(uuid);
  if (!u) return '';

  let doc = null;
  try {
    doc = await fromUuid(u);
  } catch (e) {
    doc = null;
  }

  // Если документ удалось резолвнуть — строго валидируем тип
  if (doc) {
    const name = doc.documentName;
    if (name === 'JournalEntry') return doc.uuid;
    if (name === 'JournalEntryPage' && doc.parent?.uuid) return doc.parent.uuid;
    return '';
  }

  // Если документ не найден — принимаем только UUID, похожий на Journal
  return _looksLikeJournalUuid(u) ? u : '';
}

/**
 * Инъекция поля в UserConfig для привязки пользователя к фракциям.
 * Хранение: flags.spaceholder.factions (строка, 1 UUID на строку)
 */
export function installUserFactionsHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  const renderHandler = async (app, formEl, data /*, options */) => {
    try {
      const root = formEl instanceof HTMLElement ? formEl : formEl?.[0];
      if (!root) return;

      // Найдём текущего пользователя (документ)
      const user = data?.user
        ?? data?.document
        ?? data?.object
        ?? app?.document
        ?? app?.object
        ?? app?.user
        ?? null;
      if (!user) return;

      // Подготовим контекст
      const factionsText = String(user.getFlag?.(MODULE_NS, 'factions') ?? '');
      const ctx = {
        factionsText,
      };

      // Рендерим HTML панели
      const tpl = await foundry.applications.handlebars.renderTemplate('systems/spaceholder/templates/user-factions-config.hbs', ctx);
      const wrap = document.createElement('div');
      wrap.innerHTML = tpl;
      const newPanel = wrap.firstElementChild;
      if (!newPanel) return;

      // Если уже вставляли — заменим
      const existing = root.querySelector('.spaceholder-user-factions');
      if (existing) existing.replaceWith(newPanel);
      else {
        // Вставляем сразу после выбора персонажа (если найдено)
        const charSelect = root.querySelector('select[name="character"]') || root.querySelector('select[name="characterId"]');
        const anchor = charSelect?.closest?.('.form-group') ?? null;
        if (anchor && anchor.parentElement) {
          anchor.insertAdjacentElement('afterend', newPanel);
        } else {
          // Fallback: перед футером/кнопками сохранения
          const footer = root.querySelector('footer') || root.querySelector('.sheet-footer');
          if (footer) footer.insertAdjacentElement('beforebegin', newPanel);
          else root.appendChild(newPanel);
        }
      }

      // Хелперы для обновления textarea
      const textarea = newPanel.querySelector('textarea[name="flags.spaceholder.factions"]');
      const clearBtn = newPanel.querySelector('[data-action="spaceholder-user-factions-clear"]');
      if (!textarea) return;

      const dispatchChange = () => {
        try {
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
          // ignore
        }
      };

      const setValue = (v) => {
        textarea.value = String(v ?? '');
        dispatchChange();
      };

      // Очистка
      clearBtn?.addEventListener('click', (ev) => {
        ev.preventDefault();
        setValue('');
      });

      // Drag & drop Journal UUID
      textarea.addEventListener('dragover', (ev) => ev.preventDefault());
      textarea.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const rawUuid = _extractUuidFromDropEvent(ev);
        if (!rawUuid) {
          ui.notifications?.warn?.('Не удалось извлечь UUID из перетаскивания');
          return;
        }

        const uuid = await _coerceToJournalEntryUuid(rawUuid);
        if (!uuid) {
          ui.notifications?.warn?.('Ожидался Journal (JournalEntry/JournalEntryPage)');
          return;
        }

        // Дедуп и 1 UUID на строку
        const current = parseFactionUuidList(textarea.value);
        if (current.includes(uuid)) {
          ui.notifications?.info?.('Эта фракция уже добавлена');
          return;
        }

        current.push(uuid);
        setValue(current.join('\n'));
      });

    } catch (e) {
      console.error('SpaceHolder | UserFactions: renderUserConfig injection failed', e);
    }
  };

  Hooks.on('renderUserConfig', renderHandler);
}

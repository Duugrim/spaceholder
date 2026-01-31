const MODULE_NS = 'spaceholder';
const FLAG_FACTIONS = 'factions';
const FLAG_ACTIVE_FACTION = 'activeFaction';

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
  const raw = user.getFlag?.(MODULE_NS, FLAG_FACTIONS);
  return parseFactionUuidList(raw);
}

/**
 * Получить выбранную (активную) фракцию пользователя.
 * Хранение: flags.spaceholder.activeFaction
 * @param {User} user
 * @returns {string}
 */
export function getUserActiveFactionUuid(user) {
  if (!user) return '';
  const raw = user.getFlag?.(MODULE_NS, FLAG_ACTIVE_FACTION);
  return normalizeUuid(raw);
}

/**
 * Установить выбранную (активную) фракцию пользователя.
 * Пустая строка означает "Нет фракции" (важно для ГМа).
 * @param {User} user
 * @param {unknown} factionUuid
 */
export async function setUserActiveFactionUuid(user, factionUuid) {
  if (!user?.setFlag) return;
  const uuid = normalizeUuid(factionUuid);
  await user.setFlag(MODULE_NS, FLAG_ACTIVE_FACTION, uuid || '');
}

/**
 * Получить все фракции мира (Actor.type === 'faction'), отсортированные по имени.
 * @returns {Actor[]}
 */
export function getWorldFactionActors() {
  const actors = Array.from(game?.actors?.values?.() ?? game?.actors?.contents ?? []);
  return actors
    .filter((a) => a?.type === 'faction')
    .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' }));
}

/**
 * Разрешённые фракции для пользователя.
 * Игрок: из flags.spaceholder.factions.
 * ГМ: все фракции мира.
 * @param {User} user
 * @returns {string[]} UUID
 */
export function getAllowedFactionUuidsForUser(user) {
  if (!user) return [];
  if (user.isGM) {
    return getWorldFactionActors().map((a) => a.uuid).filter(Boolean);
  }
  return getUserFactionUuids(user);
}

/**
 * Эффективная фракция пользователя (одна) для UI/vision.
 * - Игрок: activeFaction, иначе первая из разрешённых.
 * - ГМ: activeFaction (может быть пустой строкой => "нет фракции").
 * @param {User} user
 * @returns {string} UUID или ''
 */
export function getEffectiveFactionUuidForUser(user) {
  if (!user) return '';

  const allowed = getAllowedFactionUuidsForUser(user);
  const active = getUserActiveFactionUuid(user);

  if (user.isGM) {
    // GM can deliberately choose "none".
    if (!active) return '';
    return allowed.includes(active) ? active : '';
  }

  if (active && allowed.includes(active)) return active;
  return allowed[0] || '';
}

/**
 * Для игроков: если активная фракция не задана/невалидна, сохранить первую доступную.
 * Для ГМа: не автоназначаем, но если установлена невалидная — очищаем.
 * @param {User} user
 * @returns {Promise<string>} итоговый effective UUID или ''
 */
export async function ensureUserActiveFaction(user) {
  if (!user) return '';

  const allowed = getAllowedFactionUuidsForUser(user);
  const active = getUserActiveFactionUuid(user);

  if (user.isGM) {
    if (!active) return '';
    if (allowed.includes(active)) return active;
    await setUserActiveFactionUuid(user, '');
    return '';
  }

  if (active && allowed.includes(active)) return active;
  const next = allowed[0] || '';
  if (next) {
    await setUserActiveFactionUuid(user, next);
  } else if (active) {
    await setUserActiveFactionUuid(user, '');
  }
  return next;
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
 * Инъекция UI в UserConfig для привязки пользователя к фракциям.
 * Хранение: flags.spaceholder.factions (UUID актёров типа faction, 1 UUID на строку)
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

      // Доступные фракции (world actors)
      const factionActors = Array.from(game?.actors?.values?.() ?? game?.actors?.contents ?? [])
        .filter((a) => a?.type === 'faction')
        .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' }));

      const factionChoices = factionActors.map((a) => ({
        uuid: a.uuid,
        name: a.name || a.uuid,
      }));

      // Текущее значение фракций пользователя
      const currentUuids = getUserFactionUuids(user);
      const factionsText = currentUuids.join('\n');

      const ctx = {
        factionsText,
        factionChoices,
      };

      // Рендерим HTML панели
      const tpl = await foundry.applications.handlebars.renderTemplate('systems/spaceholder/templates/user-factions-config.hbs', ctx);
      const wrap = document.createElement('div');
      wrap.innerHTML = String(tpl || '').trim();
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

      const textarea = newPanel.querySelector('textarea[name="flags.spaceholder.factions"]');
      const listEl = newPanel.querySelector('[data-field="spaceholderFactionList"]');
      const selectEl = newPanel.querySelector('select[data-field="spaceholderFactionSelect"]');
      if (!textarea || !listEl || !selectEl) return;

      const dispatchChange = () => {
        try {
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
          // ignore
        }
      };

      const getValueUuids = () => parseFactionUuidList(textarea.value);

      const setValueUuids = (uuids) => {
        textarea.value = Array.isArray(uuids) ? uuids.join('\n') : '';
        dispatchChange();
      };

      const resolveDocSafe = async (uuid) => {
        const u = normalizeUuid(uuid);
        if (!u) return null;

        // Быстрый путь для world UUID
        const parts = u.split('.');
        if (parts[0] === 'Actor' && parts[1] && parts.length === 2) {
          return game?.actors?.get?.(parts[1]) || null;
        }

        try {
          return await fromUuid(u);
        } catch (e) {
          return null;
        }
      };

      const renderList = async () => {
        const uuids = getValueUuids();
        listEl.innerHTML = '';

        // Резолвим имена/цвета фракций
        const docs = await Promise.all(uuids.map((u) => resolveDocSafe(u)));

        for (let i = 0; i < uuids.length; i++) {
          const uuid = uuids[i];
          const doc = docs[i];

          const isFactionActor = doc?.documentName === 'Actor' && doc?.type === 'faction';
          const name = String(doc?.name || uuid);
          const color = isFactionActor ? String(doc?.system?.fColor || '').trim() : '';
          const img = isFactionActor ? String(doc?.img || '').trim() : '';

          const row = document.createElement('div');
          row.classList.add('spaceholder-user-faction-row');
          if (color) row.style.setProperty('--faction-color', color);

          row.style.display = 'flex';
          row.style.alignItems = 'center';
          row.style.gap = '6px';
          row.style.justifyContent = 'space-between';

          const link = document.createElement('a');
          link.className = 'content-link';
          link.href = '#';
          link.dataset.action = 'uuid-open';
          link.dataset.uuid = uuid;
          link.style.display = 'inline-flex';
          link.style.alignItems = 'center';
          link.style.gap = '8px';
          link.style.minWidth = '0';
          link.style.flex = '1 1 auto';

          let avatarEl = null;
          if (img) {
            const aimg = document.createElement('img');
            aimg.className = 'sh-faction-avatar sh-faction-avatar--sm';
            aimg.src = img;
            aimg.alt = '';
            aimg.loading = 'lazy';
            aimg.decoding = 'async';
            avatarEl = aimg;
          } else {
            const ph = document.createElement('span');
            ph.className = 'sh-faction-avatarPlaceholder sh-faction-avatarPlaceholder--sm';
            ph.setAttribute('aria-hidden', 'true');
            ph.innerHTML = '<i class="fa-solid fa-flag" aria-hidden="true"></i>';
            avatarEl = ph;
          }

          const text = document.createElement('span');
          text.style.minWidth = '0';
          text.style.overflow = 'hidden';
          text.style.textOverflow = 'ellipsis';
          text.style.whiteSpace = 'nowrap';
          text.textContent = name;

          link.appendChild(avatarEl);
          link.appendChild(text);

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'icon-btn';
          removeBtn.dataset.action = 'spaceholder-user-factions-remove';
          removeBtn.dataset.uuid = uuid;
          removeBtn.setAttribute('aria-label', 'Удалить');
          removeBtn.setAttribute('data-tooltip', 'Удалить');
          removeBtn.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

          row.appendChild(link);
          row.appendChild(removeBtn);
          listEl.appendChild(row);
        }
      };

      const openUuid = async (rawUuid) => {
        const uuid = normalizeUuid(rawUuid);
        if (!uuid) return;

        let doc = null;
        try {
          doc = await fromUuid(uuid);
        } catch (e) {
          doc = null;
        }

        if (!doc) return;

        if (doc.sheet?.render) {
          doc.sheet.render(true);
        }
      };

      // Initial render of the list
      await renderList();

      newPanel.addEventListener('click', async (ev) => {
        const link = ev.target?.closest?.('[data-action="uuid-open"]');
        if (link) {
          ev.preventDefault();
          ev.stopPropagation();
          await openUuid(link.dataset.uuid);
          return;
        }

        const btn = ev.target?.closest?.('button[data-action]');
        if (!btn) return;

        const action = String(btn.dataset.action || '').trim();

        if (action === 'spaceholder-user-factions-add') {
          ev.preventDefault();
          const uuid = normalizeUuid(selectEl.value);
          if (!uuid) return;

          // Гарантируем, что добавляем только Actor(faction)
          const doc = await resolveDocSafe(uuid);
          if (!doc || doc.documentName !== 'Actor' || doc.type !== 'faction') {
            ui.notifications?.warn?.('Ожидался Actor типа "faction"');
            return;
          }

          const current = getValueUuids();
          if (current.includes(uuid)) return;

          current.push(uuid);
          setValueUuids(current);
          await renderList();
          return;
        }

        if (action === 'spaceholder-user-factions-clear') {
          ev.preventDefault();
          setValueUuids([]);
          await renderList();
          return;
        }

        if (action === 'spaceholder-user-factions-remove') {
          ev.preventDefault();
          const uuid = normalizeUuid(btn.dataset.uuid);
          if (!uuid) return;

          const current = getValueUuids();
          const next = current.filter((u) => normalizeUuid(u) !== uuid);
          setValueUuids(next);
          await renderList();
          return;
        }
      });

    } catch (e) {
      console.error('SpaceHolder | UserFactions: renderUserConfig injection failed', e);
    }
  };

  Hooks.on('renderUserConfig', renderHandler);
}

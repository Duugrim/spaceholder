# Паттерны Application V2: листы документов (Item/Actor)

Шпаргалка по типичным задачам в листах Foundry Application V2. Решения проверены на коде SpaceHolder (лист предмета Wearable, лист персонажа). При проблемах вида «кнопка не нажимается» или «вкладка сбрасывается после обновления» — сверяться с этим документом. Если после дебага найдено новое решение такого же типа — **добавить его в этот документ**.

## Краткая сводка

| Задача | Что использовать |
|--------|-------------------|
| Кнопка в листе Item/Actor V2 | Хук `renderItemSheetV2` / `renderActorSheetV2` + при необходимости делегирование на `document.body` с `data-*-uuid` на кнопке |
| Вкладка сбрасывается после render | `_activeTabPrimary`, переопределение `changeTab`, `_configureRenderOptions` (options.tab), в `_onRender` — `changeTab(..., { force: true })`, после своих update+render — снова `changeTab` |
| Удалить ключ из объекта в документе | `doc.update({ ['system.object.-=key']: null })`; для массового удаления/обновления — циклы с `-=` и точечными путями |

---

## 1. Кнопки и обработчики в листе (Item Sheet V2 / Actor Sheet V2)

### Проблема

Кнопка в шаблоне листа (Handlebars) не срабатывает при клике: обработчик не вызывается или элемент не находится.

### Причина

- Для **Application V2** (ItemSheetV2, ActorSheetV2) Foundry вызывает хуки **`renderItemSheetV2`** / **`renderApplicationV2`**, а не `renderItemSheet` / `renderActorSheet`. Обработчики, повешенные только в `renderItemSheet`, для V2-листов не выполняются.
- После `app.render()` DOM пересоздаётся, поэтому обработчики, повешенные на элементы внутри листа, теряются, если не повесить их заново при каждом рендере.

### Решение (два уровня)

**A) Основной: хук `renderItemSheetV2`**

В `module/spaceholder.mjs` в блоке `Hooks.once('init')` подписаться на хук:

```javascript
Hooks.on('renderItemSheetV2', async (app, element, context, options) => {
  const doc = app.document;
  if (!doc || doc.type !== 'wearable') return;  // или нужный тип
  if (!(element instanceof HTMLElement)) return;

  const btn = element.querySelector('[data-action="wearable-select-anatomy-group"]');
  if (btn && !btn.dataset.spaceholderBound) {
    btn.dataset.spaceholderBound = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openWearableAnatomyDialog(doc);
    });
  }
});
```

- Селектор по `data-action` (или другому атрибуту) задаётся в шаблоне `.hbs`.
- Флаг `dataset.spaceholderBound` (или аналог) нужен, чтобы не вешать один и тот же обработчик дважды при повторном рендере (хук может вызываться несколько раз).
- Документ берётся из `app.document`; для диалогов и обновлений используем его, а не ищем по DOM.

**B) Подстраховка: делегирование на `document.body`**

Если хук по какой-то причине не срабатывает или элемент появляется позже, можно повесить один глобальный обработчик (один раз при `init`):

```javascript
document.body.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('[data-action="wearable-select-anatomy-group"]');
  if (!btn?.dataset?.itemUuid) return;
  e.preventDefault();
  e.stopPropagation();
  const doc = await fromUuid(btn.dataset.itemUuid);
  if (doc?.type === 'wearable') openWearableAnatomyDialog(doc);
});
```

В шаблоне кнопка должна содержать **идентификатор документа**, чтобы в обработчике получить документ без привязки к конкретному экземпляру листа:

```html
<button type="button" ... data-action="wearable-select-anatomy-group" data-item-uuid="{{item.uuid}}">
```

- `data-item-uuid` (или `data-actor-uuid` для актора) задаётся в Handlebars из `item.uuid` / `actor.uuid`.
- В обработчике: `const doc = await fromUuid(btn.dataset.itemUuid)`.

Итог: для кнопок в V2-листах использовать **`renderItemSheetV2`** (или `renderActorSheetV2` для актора) и при необходимости — делегирование на `document.body` с `data-*-uuid` на кнопке.

---

## 2. Сохранение активной вкладки при перерисовке листа

### Проблема

После обновления документа (например, `item.update(...)`) вызывается `app.render()`, и лист перерисовывается. Активная вкладка сбрасывается на начальную (например, «Описание» вместо «Покрытие»).

### Причина

При каждом полном рендере Application V2 восстанавливает вкладки из своих опций/состояния. Если не передать явно «какая вкладка была активна», используется дефолт.

### Решение (как в `item-sheet.mjs` и `actor-sheet.mjs`)

**Шаг 1.** Хранить активную вкладку при переключении — переопределить `changeTab`:

```javascript
changeTab(tab, group, options = {}) {
  if (group === 'primary') this._activeTabPrimary = tab;
  return super.changeTab(tab, group, options);
}
```

**Шаг 2.** При каждом рендере передавать эту вкладку в опции — переопределить `_configureRenderOptions`:

```javascript
_configureRenderOptions(options) {
  super._configureRenderOptions(options);
  options.tab = { primary: this._activeTabPrimary ?? this.tabGroups?.primary ?? 'description' };
}
```

**Шаг 3.** После отрисовки снова применить вкладку — в `_onRender`:

```javascript
async _onRender(context, options) {
  await super._onRender(context, options);
  const desiredTab = this._activeTabPrimary ?? this.tabGroups?.primary ?? 'description';
  try { this.changeTab(desiredTab, 'primary', { updatePosition: false, force: true }); } catch (e) { /* ignore */ }
  // ... остальная логика
}
```

**Шаг 4.** При первом рендере восстановить вкладку — в `_onFirstRender` (опционально, для согласованности):

```javascript
async _onFirstRender(context, options) {
  await super._onFirstRender(context, options);
  const tabId = this._activeTabPrimary ?? this.tabGroups?.primary ?? 'description';
  try { this.changeTab(tabId, 'primary', { updatePosition: false }); } catch (e) { /* ignore */ }
}
```

После обновления документа из контекста вкладки (например, после выбора анатомии или изменения покрытия) вызывать перерисовку и явно возвращать пользователя на нужную вкладку:

```javascript
const renderAndStayOnCoverage = async () => {
  await app.render();
  try {
    app.changeTab?.('attributes', 'primary', { updatePosition: false });
  } catch (_) { /* ignore */ }
};
```

Итого: хранить `_activeTabPrimary`, прокидывать его в `options.tab` в `_configureRenderOptions`, в `_onRender` вызывать `changeTab(..., { force: true })`, а после своих `update` + `render` — снова `changeTab` на нужную вкладку.

---

## 3. Обновление документа: удаление ключей из объекта (не массив)

### Проблема

В документе есть объект-словарь (например, `system.armorByPart`: `{ partId: { value: 5 }, ... }`). При «удалении» ключа через `doc.update({ system: { armorByPart: next } })`, где в `next` этого ключа уже нет, в документе ключ **остаётся**. То же при замене всего объекта через `doc.update({ "system.armorByPart": next })` в некоторых версиях/случаях может вести себя как merge.

### Причина

В Foundry VTT `document.update(updateData)` для вложенных объектов по умолчанию выполняет **глубокое слияние** (deep merge): отсутствующие в `updateData` ключи не удаляются. Чтобы именно **удалить** ключ, нужен специальный синтаксис.

### Решение

**Удаление одного ключа** из объекта (например, убрать одну часть тела из `armorByPart`):

```javascript
await doc.update({ [`system.armorByPart.-=${partId}`]: null });
```

**Удаление нескольких ключей и обновление остальных** (например, тоггл покрытия частей в редакторе):

- Собрать новое состояние `next` (объект без удалённых ключей).
- Для каждого ключа из **старого** состояния, которого нет в `next`, отправить удаление.
- Для каждого ключа из `next` отправить обновление вложенного поля (точечно).

Пример:

```javascript
const prev = doc.system?.armorByPart ?? {};
const update = {};

for (const key of Object.keys(prev)) {
  if (!Object.prototype.hasOwnProperty.call(next, key)) {
    update[`system.armorByPart.-=${key}`] = null;
  }
}
for (const [key, data] of Object.entries(next)) {
  const val = Number(data?.value) || 0;
  update[`system.armorByPart.${key}.value`] = val;
}
await doc.update(update);
```

**Сравнение с массивами:** для массивов (например, `system.health.injuries`, **`system.coveredParts`** у Wearable) полная замена работает: `await this.update({ 'system.health.injuries': filtered })` или `await doc.update({ system: { coveredParts: nextCoveredParts } })` — массив подменяется целиком. Для объектов-словарей полагаться на замену целиком не стоит — использовать `-=key` для удаления.

Итого: чтобы запись в объекте документа действительно исчезла, использовать ключ вида **`path.-=keyName`** со значением **`null`** в `update()`. Для списка покрытых частей Wearable используется массив **`system.coveredParts`** (`[{ partId, value }, ...]`), чтобы не привязывать данные к объекту-словарю и упростить обновление (замена массива целиком).

Если при дебаге проблемы вида «кнопка не нажимается» или «вкладка сбрасывается» найдено решение, которого нет в этом документе — добавить его в соответствующий раздел (или новый) и при необходимости обновить сводку в начале документа.

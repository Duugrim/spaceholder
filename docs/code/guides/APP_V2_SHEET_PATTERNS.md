---
doc-type: guide
status: current
tags:
  - sh-code-doc/guide
  - sh-code-doc/status/current
---

# Паттерны Application V2: листы документов (Item/Actor)

Шпаргалка по типичным задачам в листах Foundry Application V2. Решения проверены на коде SpaceHolder (лист предмета типа `item`, лист персонажа). При проблемах вида «кнопка не нажимается» или «вкладка сбрасывается после обновления» — сверяться с этим документом. Если после дебага найдено новое решение такого же типа — **добавить его в этот документ**.

## Краткая сводка

| Задача | Что использовать |
|--------|-------------------|
| Кнопка в листе Item/Actor V2 | Хук `renderItemSheetV2` / `renderActorSheetV2` + при необходимости делегирование на `document.body` с `data-*-uuid` на кнопке |
| Вкладка сбрасывается после render | `_activeTabPrimary`, переопределение `changeTab`, `_configureRenderOptions` (options.tab), в `_onRender` — `changeTab(..., { force: true })`, после своих update+render — снова `changeTab` |
| Имя предмета сбрасывается после своего `item.update` + render; частичный submit | `_getPendingNameFromForm()`, подмешивать `name` в `update` и в `_prepareSubmitData` (см. §1b) |
| Портрет предмета / битый `img` в Item V2 | Явный клик по `img.profile-img` + FilePicker (`_onProfileImageClick`), в контексте `itemImgSrc` с fallback `Item.DEFAULT_ICON` (см. §1b) |
| Удалить ключ из объекта в документе (v14) | `doc.update({ 'system.object.key': new foundry.data.operators.ForcedDeletion() })`; для атомарной замены поля — `ForcedReplacement.create(value)` (см. §3) |
| v14: «ForcedReplacement» / «name: may not be undefined» при частичных update'ах | Переопределить `Document.updateSource()` и подставлять `type`/`name` из `_source`; в `update()` короткозамкнуть пустые патчи (см. §5) |
| v14: чекбоксы без `name` рушат `submitOnChange` | На `change`/`input` вызывать `ev.stopImmediatePropagation()` (см. §5) |
| v14: «ActiveEffect application phase already completed» / «One of original or other are not Objects!» в `Actor.prepareData` | В переопределённом `prepareBaseData()` обязательно вызывать `super.prepareBaseData()` — он запускает `Actor._clearData` (см. §6) |
| App V2: пункты меню окна дублируются | `static DEFAULT_OPTIONS` задавать как дельту; не делать `mergeObject(super.DEFAULT_OPTIONS, ...)` (см. §0) |

---

## 0. `DEFAULT_OPTIONS` в Application V2

### Проблема

В меню окна повторяются базовые пункты вроде «Прототип токена», «Просмотр портрета», «Просмотр изображения токена».

### Причина

Application V2 сам собирает `DEFAULT_OPTIONS` по цепочке наследования. Если в классе написать `static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {...})`, родительские опции попадают в дочерний класс заранее, а потом Foundry мержит родителя ещё раз. Для массивов вроде `window.controls` это даёт дубликаты.

### Решение

В App V2 классах `DEFAULT_OPTIONS` должен содержать только отличия текущего класса:

```javascript
class MySheet extends BaseSheet {
  static DEFAULT_OPTIONS = {
    position: { width: 720, height: 860 },
    window: { resizable: true },
  };
}
```

Не копировать `super.DEFAULT_OPTIONS.window` через `Object.assign` и не оборачивать `DEFAULT_OPTIONS` в `mergeObject(super.DEFAULT_OPTIONS, ...)`.

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
  if (!doc || doc.type !== 'item') return;  // или нужный тип
  if (!(element instanceof HTMLElement)) return;

  const btn = element.querySelector('[data-action="wearable-select-anatomy"]');
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
  const btn = e.target.closest?.('[data-action="wearable-select-anatomy"]');
  if (!btn?.dataset?.itemUuid) return;
  e.preventDefault();
  e.stopPropagation();
  const doc = await fromUuid(btn.dataset.itemUuid);
  if (doc?.type === 'item') openWearableAnatomyDialog(doc);
});
```

В шаблоне кнопка должна содержать **идентификатор документа**, чтобы в обработчике получить документ без привязки к конкретному экземпляру листа:

```html
<button type="button" ... data-action="wearable-select-anatomy" data-item-uuid="{{item.uuid}}">
```

- `data-item-uuid` (или `data-actor-uuid` для актора) задаётся в Handlebars из `item.uuid` / `actor.uuid`.
- В обработчике: `const doc = await fromUuid(btn.dataset.itemUuid)`.

Итог: для кнопок в V2-листах использовать **`renderItemSheetV2`** (или `renderActorSheetV2` для актора) и при необходимости — делегирование на `document.body` с `data-*-uuid` на кнопке.

---

## 1b. Лист предмета (ItemSheet V2): имя в шапке и портрет

### Проблема

- После `item.update` только по части полей (теги, `system.actions` и т.д.) и `render(false)` поле **имени** снова берётся из документа — текст в `<input name="name">`, ещё не отправленный формой, **теряется**.
- Атрибут **`data-edit="img"`** на портрете в ItemSheet V2 **не всегда** обрабатывается ядром; пустой **`item.img`** даёт битую картинку в `<img src>`.

### Решение (реализация: `module/sheets/item-sheet.mjs`)

1. **`_getPendingNameFromForm()`** — прочитать `this.element.querySelector('input[name="name"]')`, вернуть обрезанную строку или `null`.
2. **`_prepareSubmitData`** — если в DOM непустое имя, задать `data.name` из DOM (приоритет над пустым полем из частичного submit); иначе сохранить fallback на `this.document.name` для валидации DataModel.
3. Любой **собственный** `item.update` перед `render` (чекбоксы тегов, редактор `system.actions`, …) — в тот же объект обновления добавить **`name`**, если `_getPendingNameFromForm()` непустое и отличается от `this.item.name`.
4. Портрет: в **`_onRender`** сразу после `super._onRender` повесить обработчик клика на **`img.profile-img[data-edit]`** / **`img.profile-img`** → метод вроде **`_onProfileImageClick`** (FilePicker при редактировании, `ImagePopout` при просмотре), **аналогично** `actor-sheet.mjs`.
5. В **`_prepareContext`** выставить **`itemImgSrc`**: действующий `item.img` или **`Item.DEFAULT_ICON`** — в шаблоне `src="{{itemImgSrc}}"`.

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

### Решение (v14: `foundry.data.operators`)

> **Внимание:** legacy-синтаксис `{ 'path.-=key': null }` в v14 deprecated. При использовании Foundry выводит:
> `You are specifying a forced deletion or replacement key "-=key" using legacy syntax which should be migrated to instead pass {key: foundry.data.operators.ForcedDeletion}`.
> Используйте операторы из `foundry.data.operators` (`ForcedDeletion`, `ForcedReplacement`).

**Удаление одного ключа** из объекта (например, убрать одну часть тела из `armorByPart`):

```javascript
await doc.update({
  [`system.armorByPart.${partId}`]: new foundry.data.operators.ForcedDeletion(),
});
```

**Удаление нескольких ключей и обновление остальных** (например, тоггл покрытия частей в редакторе):

- Собрать новое состояние `next` (объект без удалённых ключей).
- Для каждого ключа из **старого** состояния, которого нет в `next`, отправить `ForcedDeletion`.
- Для каждого ключа из `next` отправить обновление вложенного поля (точечно).

Пример:

```javascript
const prev = doc.system?.armorByPart ?? {};
const update = {};

for (const key of Object.keys(prev)) {
  if (!Object.prototype.hasOwnProperty.call(next, key)) {
    update[`system.armorByPart.${key}`] = new foundry.data.operators.ForcedDeletion();
  }
}
for (const [key, data] of Object.entries(next)) {
  const val = Number(data?.value) || 0;
  update[`system.armorByPart.${key}.value`] = val;
}
await doc.update(update);
```

**Атомарная замена объекта без merge** (например, обнулить словарь `flags.<ns>.startedTurnsByCombatant` в один update без сочетания «удалить + записать `{}`»):

```javascript
await combat.update({
  [`flags.${MODULE_NS}.${FLAG_STATE}.startedTurnsByCombatant`]:
    foundry.data.operators.ForcedReplacement.create({}),
});
```

`ForcedReplacement` пишет значение целиком, минуя глубокий merge — то, что раньше требовало пары «`-=key` + новая запись», теперь делается одним ключом.

**Сравнение с массивами:** для массивов (например, `system.health.injuries`, **`system.coveredParts`** у предмета типа `item`) полная замена работает через **точечный путь**: `await this.update({ 'system.health.injuries': filtered })` или `await doc.update({ 'system.coveredParts': nextCoveredParts, 'system.anatomyId': … })`. У **Item** в SpaceHolder одного ключа `'system.coveredParts'` **недостаточно** — в текущей связке Foundry/DataModel это сбрасывает `anatomyId`; передавайте `anatomyId` в том же `update`. Не использовать `update({ system: { coveredParts: … } })` — вложенный объект `system` может заменить весь `system`. Для объектов-словарей полагаться на замену целиком не стоит — использовать `ForcedDeletion` для удаления.

**Ограничение `ActorDelta`:** в одном update **нельзя** одновременно слать `ForcedDeletion` для слота и его же запись — для совпадающих ключей в дельте окажется пустой объект. Удаление и пересоздание разводите по двум `update()` либо записывайте только нужные ключи без удаления.

Итого: чтобы запись в объекте документа действительно исчезла, передавать значением `new foundry.data.operators.ForcedDeletion()` (а для атомарной замены — `ForcedReplacement.create(value)`). Legacy `path.-=key: null` всё ещё работает, но печатает compatibility-warning. Для списка покрытых частей предмета используется массив **`system.coveredParts`** (`[{ partId, value }, ...]`), чтобы не привязывать данные к объекту-словарю и упростить обновление (замена массива целиком).

Если при дебаге проблемы вида «кнопка не нажимается» или «вкладка сбрасывается» найдено решение, которого нет в этом документе — добавить его в соответствующий раздел (или новый) и при необходимости обновить сводку в начале документа.

---

## 4. Сложные поля в ItemSheet V2: редактирование через DialogV2

### Когда применять

Если список в листе содержит «тяжёлые» сущности (много полей, часть полей зависит от режима), не стоит редактировать всё inline в одной строке.

### Паттерн

1. На вкладке оставляем **компактный список** карточек (минимум метаданных + кнопки edit/duplicate/delete).
2. Кнопки **Add/Edit/Duplicate** открывают `foundry.applications.api.DialogV2.wait(...)`.
3. Форма диалога рендерится из отдельного `hbs`-partial через `renderTemplate(...)`.
4. Режим-зависимые группы полей (`data-*-mode-block`) скрываются/показываются по `select` внутри диалога.
5. На `Save` данные проходят нормализацию/валидацию в одном месте.
6. Сохранение выполняется **одним** `item.update({ 'system.actions': next })` вместо апдейта на каждое изменение поля.

### Практическая польза

- Убирает «дребезг» рендера листа при `submitOnChange`.
- Упрощает визуальную структуру вкладки.
- Делает расширение схемы действия предсказуемым (добавление новых mode-полей).

---

## 5. Foundry v14: частичные `update()` ломают валидацию документа

### Симптомы

Любой частичный `item.update(...)` (правка имени, описания, веса, количества, тоггл тегов, сохранение оружия) кидает в консоль одну из двух ошибок:

- `Error: The type of a Document may only be changed if the system field is also updated with a ForcedReplacement operator.` — приходит из `_updateDiff` (`foundry.mjs:14672`).
- `Error: SpaceHolderItem [Item.<id>] validation errors: SchemaField#_updateDiff name: may not be undefined` — приходит из `updateSource` после `cleanData`.

Иногда на тех же действиях добавляется третья:

- `Error: SpaceHolderItem must be constructed with a DataModel or Object.` — `cleanData({_id})` без полезной нагрузки.

В v13 этих ошибок не было; всё всплыло после миграции на v14.

### Причина

В v14 поменялся пайплайн обновления документа. Любой частичный патч проходит через `static cleanData(source, options)` с флагами `partial: true, addTypes: true`. Этот вызов:

1. Раскрывает плоские пути (`system.quantity` → `{ system: { quantity } }`).
2. **Дополняет объект изменений ключами схемы** (`type`, `name`, …) — **но без значений**, потому что статический `cleanData` не знает про `_source` конкретного документа.

Следом `Document._updateDiff` сравнивает результат с `this._source`:

- видит `_source.type === 'item'`, а в патче `type === undefined` → считает, что тип меняется → требует `ForcedReplacement` → бросает ошибку;
- видит `name === undefined` → валидация SchemaField падает.

Ошибка возникает **на трёх разных путях**:

1. `ClientDatabaseBackend._updateDocuments → #preUpdateDocumentArray → updateSource` — обычный `doc.update(...)`.
2. `#handleUpdateDocuments → updateSource` — обработка апдейта, пришедшего от сервера (повторно режется патч).
3. `_prepareSubmitData → validate → updateSource` — `submitOnChange` валидирует форму до отправки.

Дополнительный кейс: при `submitOnChange` чекбоксы без `name`-атрибута триггерят пустой submit; `_onSubmitDocumentForm` после неудачной валидации всё равно зовёт `_processSubmitData(form, event, {})`, что приводит к `super.update({})` → `cleanData({_id})` → «must be constructed with a DataModel or Object».

### Решение

Точка склейки всех трёх путей — instance-метод `Document.updateSource(changes, options)`. Переопределяем его в кастомном Document-классе и до вызова `super.updateSource` подставляем недостающие значения из `this._source`. Реализация: `module/documents/item.mjs`.

```javascript
export class SpaceHolderItem extends Item {
  /**
   * v14: Foundry's update pipeline expands partial change objects via cleanData
   * with `addTypes:true`, which adds schema keys (`type`, `name`) but leaves them
   * as `undefined` because static cleanData doesn't know `_source`. _updateDiff
   * then either sees `_source.type !== changes.type (undefined)` and throws
   * "ForcedReplacement", or validates `name: undefined` and throws a schema error.
   */
  updateSource(changes, options) {
    if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
      const src = this._source ?? {};
      if ((!('type' in changes) || changes.type === undefined || changes.type === null) && src.type !== undefined) {
        changes.type = src.type;
      }
      if ((!('name' in changes) || changes.name === undefined || changes.name === null) && src.name !== undefined) {
        changes.name = src.name;
      }
    }
    return super.updateSource(changes, options);
  }

  /**
   * v14: short-circuit no-op updates that carry no actual changes (only `_id`
   * or empty). Foundry's `#onSubmitDocumentForm` can call `_processSubmitData`
   * with `{}` after a failed validate; the resulting `cleanData({_id})` then
   * throws "must be constructed with a DataModel or Object".
   */
  async update(data, operation) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const meaningfulKeys = Object.keys(data).filter((k) => k !== '_id');
      if (meaningfulKeys.length === 0) return this;
    }
    return super.update(data, operation);
  }
}
```

Дополнительно для чекбоксов без `name` (которые триггерят пустой submit при `submitOnChange`) — глушим события до того, как форма их увидит:

```javascript
// В _onRender на каждом чекбоксе, который коммитится отдельной кнопкой:
const swallow = (ev) => ev.stopImmediatePropagation();
cb.addEventListener('change', swallow);
cb.addEventListener('input', swallow);
```

### Применимость

- Если кастомный Document-класс даёт **то же поведение** на других типах (Actor, Macro и т.д.) — переопределить `updateSource` тем же паттерном в соответствующем классе.
- Если в схеме появятся **другие required-поля без default** — добавить их в список инжектируемых в `updateSource`.
- Чекбоксный фикс нужен только там, где элементы **без `name`** соседствуют с формой `submitOnChange`. Для обычных `<input name="…">` ничего делать не нужно.

---

## 6. Foundry v14: `Actor.prepareBaseData()` обязан звать `super`

### Симптомы

После миграции на v14 в консоли при разных действиях с актёром появляются ошибки из пайплайна active effects:

- При редактировании любого поля актёра (характеристики, имя, описание):
  `Error: ActiveEffect application phase "initial" has already completed and cannot be run again in this Actor's data-preparation cycle.`
  (и аналогично для phase `"final"`).
- При перетаскивании актёра на канвас (создание synthetic-актёра из токена):
  `Error: Failed data preparation for Actor.<id>. Cannot set properties of undefined (setting 'initial')`,
  затем мутирует в `Error: One of original or other are not Objects!` из `mergeObject` внутри `Actor.applyActiveEffects` (`foundry.mjs:46402`).

В v13 этих ошибок не было.

### Причина

В v14 базовый `Actor.prepareBaseData()` вызывает `this._clearData()`, который на каждом цикле подготовки данных:

```javascript
_clearData() {
  this.overrides = {};
  this.tokenActiveEffectChanges = {};
  this.statuses.clear();
  this._completedActiveEffectPhases.clear();
}
```

Если кастомный `Actor`-класс переопределяет `prepareBaseData()` и **не зовёт `super.prepareBaseData()`** (типичная заготовка из официального бойлерплейта system'а: пустое тело с комментарием «Data modifications in this step…»), то `_clearData` никогда не выполняется. Последствия:

1. `_completedActiveEffectPhases` (Set из применённых фаз) не очищается между циклами `_updateCommit → _initialize → prepareData`. На втором цикле `applyActiveEffects("initial")` видит, что `"initial"` уже в Set → бросает «already completed».
2. `this.overrides` остаётся `undefined` для **synthetic-актёров** (создаваемых из токена через `ActorDelta.applyDelta`). На строке `foundry.utils.mergeObject(this.overrides, foundry.utils.expandObject(overrides))` mergeObject ругается «One of original or other are not Objects!» потому что `original` — это `undefined`.

Для «несинтетических» актёров `overrides` иногда оказывается определённым из предыдущего цикла или из конструктора, поэтому ошибка №2 проявляется только на drop-актёра-на-канвас, а ошибка №1 — на любом редактировании.

### Решение

В кастомном `Actor`-классе либо **удалить переопределение целиком**, либо явно вызывать `super.prepareBaseData()`. Реализация в `module/documents/actor.mjs`:

```javascript
export class SpaceHolderActor extends Actor {
  /** @override */
  prepareBaseData() {
    // CRITICAL: must invoke super to run Foundry v14's `_clearData`, which
    // initializes `this.overrides`, `this.tokenActiveEffectChanges`,
    // `this.statuses`, and clears `this._completedActiveEffectPhases`.
    super.prepareBaseData();
    // ... здесь можно дописать собственные модификации base-данных ...
  }
}
```

### Применимость

- Любой кастомный `Actor`/`Item`-класс, у которого переопределён один из `prepare*Data` хуков, должен вызывать соответствующий `super.prepare*Data()` — иначе ломается внутреннее состояние Foundry, и проявления могут быть произвольными (от молчаливых багов до исключений в `applyActiveEffects`).
- В заготовках official boilerplate'ов System'а часто стоит пустой `prepareBaseData()` без `super`-вызова — в v14 это перестало быть безопасным, при апгрейде надо проверять и чинить.

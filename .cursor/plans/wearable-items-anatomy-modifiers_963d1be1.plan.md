---
name: wearable-items-anatomy-modifiers
overview: Add a new Wearable item type that ties into anatomy groups and per-body-part protection, and lay the foundation for character stat modifiers applied from equipped items.
todos:
  - id: add-anatomy-groups
    content: Добавить поддержку групп анатомий (registry + AnatomyManager утилиты).
    status: completed
  - id: define-wearable-schema
    content: Расширить template.json новым типом Item.wearable и полями (equipped, anatomyGroup, armorByPart, modifiers).
    status: completed
  - id: implement-wearable-sheet
    content: Создать лист и шаблон item-wearable-sheet.hbs с вкладками Description/Attributes/Modifiers и UI выбора частей тела.
    status: completed
  - id: hook-wearables-into-actor
    content: Реализовать расчёт защиты по частям тела и применение модификаторов от экипированных Wearable-предметов для актёров типа character.
    status: completed
  - id: update-inventory-ui
    content: Добавить в инвентарь переключатель экипировки для Wearable и отобразить защиту по частям в вкладке здоровья.
    status: completed
isProject: false
---

## План: тип предмета «Надеваемый» (Wearable), группы анатомий и модификаторы

### 1. Расширение данных анатомий (Группа)

- **Добавить поле группы в реестр анатомий**
  - Обновить `[data/anatomy/registry.json](e:/FoundryVTT/Data/systems/spaceholder/data/anatomy/registry.json)`:
    - В каждой записи `anatomies[<id>]` добавить строковое поле `group`, напр. `"group": "humanoid"`, `"group": "quadruped"`, и т.п.
    - Описать ожидание: все анатомии с одним `group` имеют одинаковый набор `bodyParts` и идентичные `id` частей тела.
- **Поддержка групп в мировых анатомиях**
  - Создать новое поле `group` в JSON анатомий (и системных, и мировых), напр. `human.group`:
    - Пример структуры файла анатомии: `{"id": "humanoid", ..., "bodyParts": {...}, "group": "humanoid" }`.
- **Утилиты по группам в `AnatomyManager`**
  - В `[module/anatomy-manager.mjs](e:/FoundryVTT/Data/systems/spaceholder/module/anatomy-manager.mjs)` добавить методы:
    - `getAnatomyGroupId(anatomyId)` → строка группы (из `registry.anatomies[anatomyId].group` или `null`).
    - `getAnatomyGroups()` → объект `groupId -> { id: groupId, anatomies: [ { id, name }... ] }` для использования в UI.
    - `getRepresentativeAnatomyForGroup(groupId)` → ID анатомии (первой по списку), чтобы по ней брать список частей тела для настройки Wearable.

### 2. Новый тип предмета Wearable (Надеваемый)

- **Схема данных в `template.json`**
  - В `[template.json](e:/FoundryVTT/Data/systems/spaceholder/template.json)`:
    - Добавить новый тип в `Item.types`: `"wearable"`.
    - Определить секцию `"wearable"` по аналогии с `"item"`, с дополнительными полями:
      - `equipped: false` — флаг экипировки.
      - `anatomyGroup: null` — ID группы анатомий, под которую сделан предмет.
      - `armorByPart: {}` — словарь `partId -> { value: number }` для числовой защиты по частям тела.
      - `modifiers` (задел под этап 2):
        - `abilities: []` — массив записей `{ id, target, value, mode }`.
        - `derived: []` — аналогично, для посчитанных характеристик.
        - `params: []` — для прочих per-character параметров (гравитация и т.п.).
- **Локализация для нового типа**
  - В `[lang/ru.json](e:/FoundryVTT/Data/systems/spaceholder/lang/ru.json)` и `[lang/en.json](e:/FoundryVTT/Data/systems/spaceholder/lang/en.json)`:
    - В `TYPES.Item` добавить ключ `"wearable"` (RU: "Надеваемый", EN: "Wearable").
    - Добавить новые строки для UI вкладки и полей, напр. `SPACEHOLDER.Tabs.Modifiers`, `SPACEHOLDER.Wearable.AnatomyGroup`, `SPACEHOLDER.Wearable.BodyParts`, `SPACEHOLDER.Wearable.ArmorValue` и т.д.

### 3. Лист предмета Wearable: вкладки и UI

- **Новый класс листа для Wearable**
  - В `[module/sheets/item-sheet.mjs](e:/FoundryVTT/Data/systems/spaceholder/module/sheets/item-sheet.mjs)`:
    - Создать новый класс `SpaceHolderItemSheet_Wearable` на базе `SpaceHolderBaseItemSheet`.
    - Определить `static PARTS` c шаблоном `systems/spaceholder/templates/item/item-wearable-sheet.hbs`.
    - При необходимости переопределить `_prepareContext`, чтобы добавить:
      - `wearable`-флаги (equipped, anatomyGroup, armorByPart).
      - Список доступных групп анатомий и частей тела (через `anatomyManager` и методы из раздела 1).
- **Регистрация листа и типа**
  - В `[module/spaceholder.mjs](e:/FoundryVTT/Data/systems/spaceholder/module/spaceholder.mjs)`:
    - Импортировать `SpaceHolderItemSheet_Wearable`.
    - При регистрации листов Items добавить запись с `types: ['wearable']`, `makeDefault: true`.
- **Шаблон листа Wearable (UI по гайду)**
  - Создать новый шаблон `[templates/item/item-wearable-sheet.hbs](e:/FoundryVTT/Data/systems/spaceholder/templates/item/item-wearable-sheet.hbs)`, ориентируясь на `item-item-sheet.hbs` и `docs/UI_DESIGN_GUIDE.md`:
    - **Хедер**: иконка, имя, `quantity`, `weight` в гриде 2 колонки, как у обычного `item`.
    - **Табы (native Application V2)**:
      - `description` — редактор описания (как сейчас).
      - `attributes` — настройки анатомии и защиты.
      - `modifiers` — модификаторы характеристик (этап 2).
    - **Вкладка Attributes (анатомия + защита)**:
      - Блок с заголовком (section-header) по образцу других экранов.
      - Строка выбора группы анатомий: селектор/икон-кнопки по списку групп (в духе селекторов в UI-гайде, не `<select>` если опций немного).
      - После выбора группы — список частей тела (из representative-анатомии группы):
        - Табличка/список `"Часть тела" + поле "Защита" (число)`.
        - Возможность оставлять часть без записи (нулевая защита, поле пустое).
- **Поведение сохранения**
  - Привязать поля шаблона к свойствам `system.anatomyGroup` и `system.armorByPart[partId].value`.
  - Обеспечить, чтобы незаполненные/пустые поля либо не создавали запись, либо сбрасывали её к 0.

### 4. Базовая экипировка Wearable и расчёт защиты по частям

- **Флаг экипировки на предмете**
  - В схеме `Item.wearable` (см. раздел 2) использовать `system.equipped`.
  - В инвентаре персонажа (`[templates/actor/parts/actor-inventory.hbs](e:/FoundryVTT/Data/systems/spaceholder/templates/actor/parts/actor-inventory.hbs)`):
    - Для предметов `type === 'wearable'` добавить иконку-переключатель экипировки (кнопка-иконка в блоке `item-controls`, с tooltip, по UI-гайду).
    - Привязать кнопку к обновлению `item.update({ 'system.equipped': !system.equipped })` через логику в `[module/sheets/actor-sheet.mjs](e:/FoundryVTT/Data/systems/spaceholder/module/sheets/actor-sheet.mjs)` (`_onRender` → навешивание обработчика по `data-action="wearable-toggle"`).
- **Расчёт защиты по частям тела**
  - В `[module/documents/actor.mjs](e:/FoundryVTT/Data/systems/spaceholder/module/documents/actor.mjs)`, в `_prepareCharacterData` или отдельном методе (например, `_prepareWearableDefense`):
    - Проверять только актёров `type === 'character'`.
    - Инициализировать для каждой части тела (`system.health.bodyParts[partId]`) поле, напр. `armor` или `armorValue`, в 0.
    - Пройтись по всем предметам `this.items` с `type === 'wearable'` и `system.equipped === true`:
      - Если `item.system.anatomyGroup` совпадает с фактической группой анатомии актёра (по `anatomyManager.getAnatomyGroupId(actor.system.anatomy.type)`), применять их.
      - Для каждого `partId` из `item.system.armorByPart` суммировать `value` в `bodyPart.armor`.
    - Сохранить итоговое `bodyPart.armor` как derived-поле (не в шаблоне), рядом с уже вычисляемыми `healthPercentage` и `status`.
- **Отображение защиты в UI здоровья**
  - В шаблонах вкладки здоровья (например, `[templates/actor/parts/actor-health.hbs](e:/FoundryVTT/Data/systems/spaceholder/templates/actor/parts/actor-health.hbs)`):
    - Добавить ненавязчивый вывод значения `armor` для части тела (иконка щита + число) в строке части.
    - Использовать существующие паттерны стилей (`section-header`, бейджи, icon-btn) из UI-гайда.

### 5. Архитектура модификаторов (этап 2)

- **Список модифицируемых характеристик персонажа**
  - В `[module/helpers/config.mjs](e:/FoundryVTT/Data/systems/spaceholder/module/helpers/config.mjs)` или отдельном модуле (например, `module/helpers/modifiers-config.mjs`) описать конфиг:
    - Структура вида:
      - `SPACEHOLDER.characterModifierTargets = { abilities: [...], derived: [...], params: [...] }`.
      - Каждый элемент: `{ id: 'abilities.end', path: 'abilities.end.value', label: 'SPACEHOLDER.Modifiers.Abilities.End' }` и т.п.
  - Добавить соответствующие `SPACEHOLDER.Modifiers.*` ключи в `lang/*.json` для дружелюбных названий.
- **Данные модификаторов на Wearable**
  - В схеме `Item.wearable.modifiers` (раздел 2) зафиксировать формат записей:
    - `{ id, targetId, value, mode }`, где `mode` пока может быть `'add'` (сложение), с заделом на `'mul'` и др.
- **Вкладка "Модификаторы" на листе Wearable**
  - В `[item-wearable-sheet.hbs](e:/FoundryVTT/Data/systems/spaceholder/templates/item/item-wearable-sheet.hbs)`:
    - На вкладке `modifiers` отрисовать список записей `system.modifiers.abilities`/`derived`/`params`:
      - Таблица: "Цель" (select по `characterModifierTargets`), "Значение" (number), опционально "Режим".
      - Кнопки-иконки добавить/удалить запись (по образцу других UI, с tooltip).
  - В `SpaceHolderItemSheet_Wearable._prepareContext` собрать список доступных таргетов из `CONFIG.SPACEHOLDER.characterModifierTargets` и подготовить удобную структуру для шаблона.
- **Применение модификаторов к данным актёра**
  - В `[module/documents/actor.mjs](e:/FoundryVTT/Data/systems/spaceholder/module/documents/actor.mjs)`:
    - В `_prepareCharacterData` (после базовых `abilities`):
      - Собрать все экипированные Wearable-предметы.
      - Построить агрегированную карту модификаторов по `targetId` (сумма `value` для `mode === 'add'`).
      - Применить:
        - Для `abilities.*` — к `systemData.abilities[abilityId].value` до пересчёта `mod`.
        - Для `derived.*` — к соответствующим полям в `systemData` (пока можно ограничиться заглушками или минимальным набором, описанным в конфиге).
        - Для `params.*` — создавать/обновлять поля в `systemData.params` (например, `systemData.params.gravityModifier`).
    - Обеспечить, чтобы эти изменения были чисто derived (не сохранялись в актёра напрямую, только в runtime-представлении).

### 6. Ограничение на тип актёра (только Character)

- **Применение Wearable только для персонажей**
  - Во всех местах обработки защит и модификаторов (разделы 4 и 5) явно проверять `actor.type === 'character'`.
  - В UI (инвентарь и лист предмета):
    - Разрешить экипировку (toggle) и применение модификаторов только когда родительский актёр — `character`.
    - Если предмет Wearable открыт без актёра, UI всё равно позволяет настраивать анатомию и модификаторы, но фактическое влияние будет только у персонажей.

### 7. Учёт существующего паттерна имплантов

- **Совместимость с `implantReplaceOrgan`**
  - В `[module/helpers/anatomy-editor.mjs](e:/FoundryVTT/Data/systems/spaceholder/module/helpers/anatomy-editor.mjs)` уже есть логика отображения предметов по `item.system.implantReplaceOrgan == partId`, но она сейчас не работает.
  - При проектировании Wearable не трогать этот паттерн; он остаётся отдельным будущим механизмом имплантов.
  - В будущем (отдельной задачей) можно унифицировать: позволить Wearable-слоям и имплантам сосуществовать на одной части тела.

### 8. Минимальные проверки и отладка

- **Ручное тестирование в Foundry**
  - Создать/мигрировать пару анатомий с одинаковой группой (например, "Гуманоид", "Синт", "Клингонец").
  - Создать предмет типа Wearable:
    - Настроить группу и несколько частей тела с защитой.
    - Добавить предмет персонажу, экипировать, убедиться, что `armor` по частям пересчитывается и отображается.
  - Проверить, что снятие экипировки и изменение значений в предмете обновляют derived-поля без ошибок в консоли.

### 9. Задел на дальнейшее развитие

- **Планируемые расширения (за рамками первой реализации)**
  - Визуальное отображение слоёв (несколько Wearable на одну часть тела, порядок слоёв).
  - Разделение типов модификаторов (боевые, социальные, технические) для удобства выбора в UI.
  - Интеграция защит по частям тела в систему стрельбы / попаданий (`shot-manager`).


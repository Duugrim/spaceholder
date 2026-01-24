# Инвентаризация строк для локализации

## 1. Token Pointer Settings (`tokenpointer.hbs`, `token-pointer.mjs`)

### Шаблон: `templates/settings/tokenpointer.hbs`
- **Line 2:** `Token Pointer Settings` → Settings title
- **Line 4:** `Color` → Label
- **Line 8:** `Distance` → Label
- **Line 12:** `Scale` → Label
- **Line 16:** `Mode` → Label
- **Line 18:** `Off` → Mode option
- **Line 19:** `Hover` → Mode option
- **Line 20:** `Always` → Mode option
- **Line 24:** `Only in Combat` → Checkbox label
- **Line 28:** `Hide on Defeated` → Checkbox label
- **Line 32:** `Lock to Grid Facings` → Checkbox label
- **Line 36:** `Flip Token Horizontally` → Checkbox label
- **Line 40:** `Render Under Token` → Checkbox label
- **Line 44:** `Pointer Type` → Label
- **Line 46:** `Arrow` → Pointer type option
- **Line 47:** `Line` → Pointer type option
- **Line 48:** `Marker` → Pointer type option
- **Line 49:** `Marker V2` → Pointer type option
- **Line 53:** `Save` → Button

### Шаблон: `templates/token-pointer-config.hbs` (токен-конфиг таб)
- **Line 3:** `Pointer Type` → Label
- **Line 5:** `Arrow` → Option
- **Line 6:** `Line` → Option
- **Line 7:** `Marker` → Option
- **Line 8:** `Marker V2` → Option
- **Line 12:** `Color` → Label
- **Line 16:** `Distance` → Label
- **Line 20:** `Scale` → Label
- **Line 24:** `Mode` → Label
- **Line 26:** `Off` → Option
- **Line 27:** `Hover` → Option
- **Line 28:** `Always` → Option
- **Line 32:** `Lock to Grid Facings` → Label
- **Line 36:** `Render Under Token` → Label
- **Line 40:** `Disable ATR` → Label
- **Line 41:** `title` attribute: `Disable Automatic Token Rotation: Prevents the core token from rotating automatically during movement. The pointer will still rotate.` → Tooltip

### JS: `module/helpers/token-pointer.mjs`
- **Line 274-276:** Setting names/hints (множество)
  - `Token Pointer Color` / `Color of the pointer indicator`
  - `Token Pointer Distance` / `Relative distance of pointer from token center`
  - `Token Pointer Scale` / `Relative size of the pointer`
  - `Token Pointer Mode` / `Show pointer Off / on Hover / Always`
  - `Token Pointer: Only in Combat` / `Show pointer only while combat is running`
  - `Token Pointer: Hide on Defeated` / `Hide pointer for defeated tokens`
  - `Token Pointer: Lock to Grid Facings` / `Snap pointer angle to grid facings`
  - `Token Pointer: Flip Token Horizontally` / `Mirror token horizontally based on horizontal movement`
  - `Token Pointer: Render Under Token` / `If enabled, the pointer is drawn beneath the token sprite`
  - `Token Pointer: Type` / `Pointer drawing style`
- **Line 329:** `choices` для Mode (Off, Hover, Always) в конце
- **Line 430:** `choices` для pointerType (arrow, line, marker, markerV2)

---

## 2. Token Rotator Settings (`tokenrotator.hbs`, `settings-menus.mjs`)

### Шаблон: `templates/settings/tokenrotator.hbs`
- **Line 2:** `Token Rotator Settings` → Title
- **Line 4:** `Snap by Default` → Label
- **Line 8:** `Smooth Rotation` → Label
- **Line 12:** `Fast Preview` → Label
- **Line 16:** `Update Frequency (Hz)` → Label
- **Line 20:** `Save` → Button

### JS: `module/helpers/settings-menus.mjs`
- **Line 29:** `Token Pointer Settings` → Settings window title
- **Line 80:** `Token Rotator Settings` → Settings window title
- **Line 118-119:** Settings menu labels/hints
  - `Token Rotator` / `Configure` / `Configure Token Rotator settings`

---

## 3. Token Controls (`token-controls.mjs`)

### JS: `module/helpers/token-controls.mjs`
- **Line 63:** `Настройка прицеливания` → Button title (Aiming settings)
- **Line 72:** `Показать влияние` → Button title (Show influence)
- **Line 122:** `Менеджер влияния недоступен` → Warning notification
- **Line 127:** Conditional: `Влияние отображено` (Influence shown) / `Влияние скрыто` (Influence hidden)
- **Line 150:** `Выберите токен для настройки прицеливания` → Warning (Select token for aiming)
- **Line 156:** `Выберите только один токен для прицеливания` → Warning (Select only one token)
- **Line 174:** `Не удалось загрузить модуль прицеливания` → Error (Failed to load aiming module)

---

## 4. Aiming Manager (`aiming-manager.mjs`)

### JS: `module/helpers/aiming-manager.mjs`
- **Line 34:** `Токен не выбран` → Warning notification (Token not selected)
- **Line 42:** Option labels from payloads (dynamic)
- **Line 47:** `Выберите payload:` → Label
- **Line 53:** `Тип прицеливания:` → Label
- **Line 55:** `Simple` → Aiming type option
- **Line 61:** `Сразу отрисовать` → Checkbox label (Auto-render)
- **Line 69:** `Настройка прицеливания` → Dialog title
- **Line 75:** `Начать` → Button label
- **Line 92:** `Отмена` → Button label
- **Line 113:** Error message in console: `Ошибка загрузки манифеста payloads:` 
- **Line 127:** Error message in console: `Ошибка загрузки payload ${filename}:`
- **Line 151:** `AimingManager: Starting aiming for token` → Console log
- **Line 152:** `AimingManager: Using payload` → Console log
- **Line 172:** `AimingManager: Stopping aiming` → Console log
- **Line 195:** Cursor style (not a string key)
- **Line 203:** `Режим прицеливания активирован. ЛКМ - выстрел, ПКМ/ESC - отмена` → Notification

---

## 5. Timeline (`timeline-app.hbs`, `timeline-entry-editor.hbs`, `timeline-app.mjs`, `timeline.mjs`)

### Шаблон: `templates/timeline/timeline-app.hbs`
- **Line 11:** `aria-label="Фракция"` → Aria label (Faction select)
- **Line 25-26:** `aria-label="Скрытые"` / `data-tooltip="Скрытые"` → Eye/hidden toggle
- **Line 41-42:** `aria-label="Добавить"` / `data-tooltip="Добавить"` → Create button
- **Line 50:** `Загрузка…` → Loading text
- **Line 64:** `aria-label="Действия"` → Actions group label
- **Line 66-67:** `aria-label="Порядок"` / buttons: `Вверх` / `Вниз` → Order group
- **Line 77-78:** `aria-label="Видимость"` / `aria-label="Глобально"` / `data-tooltip="Глобально"` → Visibility group
- **Line 82-83:** `aria-label="Скрыть"` / `data-tooltip="Скрыть"` → Hide button
- **Line 89:** `aria-label="Видимость"` → Visibility group (alternative)
- **Line 98:** `aria-label="Редактирование"` → Edit group
- **Line 100-104:** Edit/delete buttons: `aria-label="Редактировать"` / `aria-label="Удалить"` / tooltips
- **Line 108:** `aria-label="Содержание"` → Content group
- **Line 114-115:** Expand button: `aria-label="Содержание"` / `data-tooltip="Содержание"`
- **Line 134:** `Пока нет записей.` → Empty state

### Шаблон: `templates/timeline/timeline-entry-editor.hbs`
- **Line 5:** `Год` → Label (Year)
- **Line 20:** `Название` → Label (Title)
- **Line 37:** `От имени` → Label (Origin/On behalf of)
- **Line 40:** `Фракции` → Option (Factions)
- **Line 41:** `Мира` → Option (World)
- **Line 49:** `Фракция` → Label
- **Line 66:** `Глобально` → Checkbox label
- **Line 89:** `Сохранить` → Button
- **Line 93:** `Отмена` → Button

### JS: `module/helpers/timeline-app.mjs`
- **Line 93:** `Да` / `Нет` → Dialog buttons (default labels in _confirmDialog)
- **Lines 77-130:** Confirm dialog function uses hardcoded Russian text as fallback

---

## 6. Journal Update Log (`update-log.hbs`, `journal-update-log-app.mjs`)

### Шаблон: `templates/journal/update-log.hbs`
- **Line 5:** `Предложено` → Tab (Proposed)
- **Line 7:** `Подтверждено` → Tab (Approved)
- **Line 12-14:** Approve button: text `Подтвердить` (Approve) + icon
- **Line 29-30:** `title="Выбрать всё"` → Tooltip (Select all)
- **Line 33:** `title="Выбрать"` → Tooltip (Select)
- **Line 38:** `title="Открыть"` → Tooltip (Open)
- **Line 51-56:** Pages list, checkboxes with `title="Выбрать"` / buttons `title="Открыть"`
- **Line 70:** `Нет предложенных записей.` → Empty state (Proposed)
- **Line 114:** `Пока нет подтверждений.` → Empty state (Approved)

### JS: `module/helpers/journal-update-log-app.mjs`
- **Line 134:** Window title: `Лог обновлений` (Update Log)
- **Line 190, 200, 219, 283-284:** Dynamic placeholders:
  - `(без названия)` → Default name for untitled entries
  - `(удалено)` → Placeholder for deleted pages
  - `Неизвестно` → Unknown name (permission restricted)
- **Line 232:** Localized sort: `'ru'` locale hint (already localized in code)
- **Line 308:** Default GM name: `'GM'` (fallback for unknown GM)

---

## 7. Settings / User Factions (`user-factions-config.hbs`, `user-factions.mjs`)

### Шаблон: `templates/user-factions-config.hbs`
- **Line 17-18:** `aria-label="Добавить"` / `data-tooltip="Добавить"` → Add button
- **Line 25-26:** `aria-label="Очистить"` / `data-tooltip="Очистить"` → Clear button

### JS: `module/helpers/user-factions.mjs`
- **Line 264-265:** `aria-label="Удалить"` / `data-tooltip="Удалить"` → Remove button (generated in code)
- **Line 317:** `Ожидался Actor типа "faction"` → Warning notification

---

## 8. Global Map (в плане, но не в текущем скопе)
**Status:** Отложено — не включено в список для этого раунда локализации.

---

## Структура ключей i18n (предложение)

```
SPACEHOLDER.
  TokenPointer.
    Settings.title
    Settings.color
    Settings.distance
    Settings.scale
    Settings.mode
    Settings.combatOnly
    Settings.hideOnDead
    Settings.lockToGrid
    Settings.flipHorizontal
    Settings.underToken
    Settings.pointerType
    Mode.off
    Mode.hover
    Mode.always
    PointerType.arrow
    PointerType.line
    PointerType.marker
    PointerType.markerV2
    Tab.label
    Disabled.atr (ATR tooltip)
  
  TokenRotator.
    Settings.title
    Settings.snapByDefault
    Settings.smoothRotation
    Settings.fastPreview
    Settings.updateFrequency
  
  TokenControls.
    AimingTool.title
    InfluenceTool.title
    Messages.selectToken
    Messages.selectOneToken
    Messages.influenceShown
    Messages.influenceHidden
    Messages.loadError
    Messages.unavailable
  
  Timeline.
    App.title
    App.loading
    App.emptyState
    Faction.label
    Origin.label
    Origin.faction
    Origin.world
    Year.label
    Title.label
    Global.label
    Buttons.add
    Buttons.edit
    Buttons.delete
    Buttons.moveUp
    Buttons.moveDown
    Buttons.toggleGlobal
    Buttons.toggleHidden
    Buttons.expand
    Buttons.save
    Buttons.cancel
    Buttons.yes
    Buttons.no
  
  Journal.
    UpdateLog.title
    UpdateLog.tabProposed
    UpdateLog.tabApproved
    UpdateLog.empty.proposed
    UpdateLog.empty.approved
    UpdateLog.approveButton
    Buttons.open
    Buttons.selectAll
    Buttons.select
  
  UserFactions.
    Config.label
    Buttons.add
    Buttons.clear
    Buttons.remove
    Messages.invalidType
```

---

## Статус по модулям

| Модуль | HBS | JS | Статус |
|--------|-----|----|----|
| Token Pointer | ✓ | ✓ | Готов к локализации |
| Token Rotator | ✓ | ✓ | Готов к локализации |
| Token Controls | — | ✓ | Требует просмотра Aiming |
| Aiming Manager | — | ✓ | Готов к локализации |
| Timeline | ✓ | ⚠️ | Частично (нужен полный просмотр timeline.mjs) |
| Journal | ✓ | ✓ | Готов к локализации |
| User Factions | ✓ | ✓ | Готов к локализации |

---

## Следующий шаг

1. Дополнить информацию по `aiming-manager.mjs`, `timeline.mjs`, `journal-check.mjs`, `journal-update-log-app.mjs` (полный просмотр)
2. Подготовить lang/en.json и lang/ru.json с установленными ключами
3. Обновить system.json с регистрацией русского языка
4. Приступить к замене строк в шаблонах и JS

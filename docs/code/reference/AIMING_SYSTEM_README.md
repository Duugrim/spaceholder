---
doc-type: reference
status: current
tags:
  - sh-code-doc/reference
  - sh-code-doc/status/current
---

# Система прицеливания SpaceHolder

## Актуальная архитектура (2025)

Система строится на **Payload → ShotManager → DrawManager**. Подробности — в **[SHOOTING_SYSTEM.md](./SHOOTING_SYSTEM.md)**.

### Компоненты

| Компонент | Описание |
|-----------|----------|
| **AimingManager** | UI прицеливания, диалог выбора payload |
| **ShotManager** | Расчёт траекторий и попаданий |
| **DrawManager** | Отрисовка выстрелов на canvas |

### Активация прицеливания

1. Выберите токен на сцене
2. Нажмите кнопку прицеливания в Token Controls (панель управления сценой)
3. В диалоге выберите payload и нажмите «Начать»
4. ЛКМ — выстрел в направлении курсора, клик ПКМ или ESC — отмена (в быстром HUD кнопка «Атаковать» на время прицеливания превращается в «Отменить атаку»)

### Ввод во время прицеливания

`AimingManager` читает нажатия на **захвате `window`** (`pointerdown`, `capture`), раньше PIXI и обработчиков Foundry, и только если событие пришло на сам canvas (`event.target` — элемент холста; клики по окнам и HUD не затрагиваются).

- **ЛКМ принадлежит прицеливанию целиком.** Событие гасится (`preventDefault` + `stopImmediatePropagation`), поэтому зажатая кнопка (авто-огонь) не рисует рамку выделения токенов, не перетаскивает токен под курсором и не снимает выделение. Отпускание ловит `pointerup` на `document`.
- **ПКМ остаётся за Foundry** (панорама камеры). Прицеливание отменяет только *клик* ПКМ: событие `contextmenu` приходит и после перетаскивания камеры, поэтому смещение между нажатием и отпусканием больше `RMB_CLICK_MAX_MOVE_PX` (6 px) считается панорамой и прицеливание не прерывает.
- **ESC** отменяет прицеливание всегда.
- Начало и конец прицеливания объявляются хуком `spaceholder.aimingChanged` (`{ aiming, token }`, константа `AIMING_CHANGED_HOOK`); `aimingManager.isAimingActor(actor)` отвечает, прицеливается ли актёр. На хук подписан быстрый HUD.

### Программный доступ

```javascript
// Загрузка AimingManager (ленивая загрузка при клике на кнопку)
const { AimingManager } = await import('systems/spaceholder/module/helpers/aiming-manager.mjs');
const manager = new AimingManager();
manager.showAimingDialog(token);

// Прямой вызов ShotManager (без UI)
const uid = game.spaceholder.shotManager.createShot(token, payload, direction);
const shotResult = game.spaceholder.shotManager.getShotResult(uid);
game.spaceholder.drawManager.drawShot(shotResult);
```

### Payloads

Список в `module/data/payloads/manifest.json`. Примеры: `straight-line`, `bouncing-laser`, `cone-blast`, `sword-swing` и др.

---

## Устаревшая система (legacy)

Ранее использовались **AimingSystem**, **RayCaster**, **RayRenderer** (файлы в `helpers/legacy/`). Они отключены с 2025-10-28.

- Глобальные макросы (`startAiming`, `fireShot`, `createAimingTestScene` и т.д.) относятся к legacy и могут быть недоступны
- Подробное описание старой архитектуры — в [AIMING_SYSTEM_DOCUMENTATION.md](./legacy/AIMING_SYSTEM_DOCUMENTATION.md) (только для справки)

---

## Документация

- **[SHOOTING_SYSTEM.md](./SHOOTING_SYSTEM.md)** — основной документ: компоненты выстрела, типы сегментов, настройки
- **[shot-manager-example.md](./shot-manager-example.md)** — примеры payload и конфигураций
- **[draw-manager.md](./draw-manager.md)** — визуализация shotResult
- **[target-size-scaling.md](./target-size-scaling.md)** — размер цели (хитбокс) и прикрытие от АоЕ

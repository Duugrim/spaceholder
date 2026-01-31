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
4. ЛКМ — выстрел в направлении курсора, ПКМ/ESC — отмена

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
- Подробное описание старой архитектуры — в [AIMING_SYSTEM_DOCUMENTATION.md](./AIMING_SYSTEM_DOCUMENTATION.md) (только для справки)

---

## Документация

- **[SHOOTING_SYSTEM.md](./SHOOTING_SYSTEM.md)** — основной документ: компоненты выстрела, типы сегментов, настройки
- **[shot-manager-example.md](./shot-manager-example.md)** — примеры payload и конфигураций
- **[draw-manager.md](./draw-manager.md)** — визуализация shotResult
- **[target-size-scaling.md](./target-size-scaling.md)** — масштабирование целей по DEX

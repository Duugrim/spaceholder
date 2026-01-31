# Система стрельбы и выстрелов SpaceHolder

Документация актуальной архитектуры системы выстрелов (2025).

## Обзор

Выстрел строится из трёх стадий:

1. **Payload** — JSON-описание траектории (сегменты, коллизии, поведение при попадании)
2. **ShotManager** — расчёт траектории и попаданий (`payload` → `shotResult`)
3. **DrawManager** — визуализация `shotResult` на canvas

### Модули (актуальные)

| Модуль | Путь | Назначение |
|--------|------|------------|
| **AimingManager** | `helpers/aiming-manager.mjs` | UI прицеливания, выбор payload, вызов ShotManager |
| **ShotManager** | `helpers/shot-manager.mjs` | Расчёт траекторий, коллизий, рикошетов, пробития |
| **DrawManager** | `helpers/draw-manager.mjs` | Отрисовка линий, кругов, конусов, маркеров попаданий |

Payloads хранятся в `module/data/payloads/*.json`.

### Устаревшие модули (legacy)

- **AimingSystem**, **RayCaster**, **RayRenderer** — в `helpers/legacy/`, не используются
- См. `AIMING_SYSTEM_DOCUMENTATION.md` только для справки по старой архитектуре

---

## Структура Payload

```json
{
  "id": "unique_id",
  "name": "Название",
  "description": "Описание",
  "type": "linear|area|complex|melee",
  "trajectory": {
    "segments": [ /* массив сегментов */ ]
  }
}
```

Поле `type` — метаданные для UI; логика выстрела определяется только `trajectory.segments`.

---

## Типы сегментов и их настройки

### 1. `line` — прямая линия

Простой отрезок от текущей позиции в заданном направлении.

| Параметр | Тип | Описание | Влияние на траекторию |
|----------|-----|----------|------------------------|
| `direction` | number | Угол относительно текущего направления (град.) | Направление отрезка |
| `length` | number | Длина в единицах `defSize` (grid.size/grid.distance) | Длина до проверки коллизий |
| `collision` | object | См. ниже | Что проверять при столкновении |
| `onHit` | string | `"stop"`, `"next"`, `"need"` | Поведение при попадании |

**Поведение `onHit`:**

- `stop` — добавить первое попадание, завершить траекторию (конец сегмента = точка попадания)
- `next` — добавить все попадания, продолжить к следующему сегменту (используется для пробития)
- `need` — если попадания не было — завершить выстрел

---

### 2. `circle` — круг (AOE, взрыв)

Круг с центром в текущей позиции. Не двигает позицию — `endPos` остаётся `lastPos`.

| Параметр | Тип | Описание | Влияние |
|----------|-----|----------|---------|
| `range` | number | Радиус в единицах `defSize` | Размер зоны |
| `collision` | object | См. ниже | Стены/токены |
| `onHit` | string | По умолчанию `"next"` | stop/next/need |
| `hitOrder` | string | `"near"`, `"far"`, `"left"`, `"right"` | Порядок выбора целей |
| `hitAmount` | number | Лимит попаданий (undefined = все) | Сколько целей считать |

---

### 3. `cone` — конус

Сектор с центром в текущей позиции. Позиция не меняется.

| Параметр | Тип | Описание | Влияние |
|----------|-----|----------|---------|
| `direction` | number | Угол относительно текущего направления (град.) | Ось конуса |
| `range` | number | Внешний радиус | Размер зоны |
| `angle` | number | Угол раскрытия в градусах (по умолчанию 90) | Ширина конуса |
| `cut` | number | Внутренний радиус (0 = конус от центра) | Усечённый конус |
| `collision` | object | См. ниже | Стены/токены |
| `onHit` | string | По умолчанию `"next"` | stop/next/need |
| `hitOrder` | string | `"near"`, `"far"`, `"left"`, `"right"` | Порядок целей |
| `hitAmount` | number | Лимит попаданий | Сколько целей |

---

### 4. `swing` — серия конусов

Последовательность конусов с меняющимися параметрами (например, размах меча).

| Параметр | Тип | Описание | Влияние |
|----------|-----|----------|---------|
| `direction` | number | Начальный угол | Ось первого конуса |
| `range` | number | Начальная дальность | Размер первого конуса |
| `angle` | number | Угол каждого конуса | Ширина |
| `cut` | number | Отсечение каждого конуса | Внутренний радиус |
| `directionStep` | number | Приращение угла на конус (град.) | Поворот серии |
| `rangeStep` | number | Приращение дальности на конус | Расширение/сужение |
| `count` | number | Количество конусов | Длина серии |
| `collision` | object | См. ниже | Стены/токены |
| `onHit` | string | `"stop"`, `"next"`, `"skip"`, `"need"` | Поведение |
| `hitOrder` | string | Передаётся в каждый конус | Порядок целей |
| `hitAmount` | number | Передаётся в каждый конус | Лимит целей |

**Поведение `onHit` для swing:**

- `stop` — при попадании в любом конусе — завершить весь выстрел
- `skip` — при попадании — пропустить оставшиеся конусы и перейти к следующему сегменту payload
- `next` / `need` — как для конуса

---

### 5. `complexLine` — линия с рикошетами и пробитием

Серия отрезков с рикошетом от стен/токенов и пробитием слабых целей.

| Параметр | Тип | Описание | Влияние |
|----------|-----|----------|---------|
| `direction` | number | Начальное направление (град.) | Ось первого отрезка |
| `length` | number | Длина одного отрезка | Шаг траектории |
| `amount` | number | Количество отрезков | Макс. длина траектории |
| `collision` | object | См. ниже | Стены/токены |
| `damage` | object | `{ penetration, ricochet }` | Логика пробития/рикошета |
| `onHit` | string | По умолчанию `"stop"` | stop/next/skip |

**`damage`:**

- `penetration` — пробиваем токены с `actor.system.abilities.end.value <= penetration`
- `ricochet` — максимальный угол (град.) для рикошета от стены/токена; при большем угле — остановка

---

## Настройки collision

```json
"collision": {
  "walls": true,   // проверять стены
  "tokens": true   // или объект (см. ниже)
}
```

**Простой вариант:** `"tokens": true` — все токены; `"tokens": false` — игнорировать токены.

**Расширенный вариант (фильтр по диспозиции):**

```json
"tokens": {
  "owner": false,  // игнорировать свой токен
  "ally": true,    // учитывать союзников (та же диспозиция)
  "other": true    // учитывать врагов (другая диспозиция)
}
```

---

## Цепочка сегментов

Сегменты обрабатываются последовательно. Для каждого сегмента:

- `lastPos` — конечная точка предыдущего сегмента (или центр токена для первого)
- `direction` — направление на выходе предыдущего сегмента (для line/cone — `direction + segment.direction`; для complexLine — после рикошета)

Если `shouldContinue === false` (из‑за `onHit`), следующие сегменты не обрабатываются.

---

## Результат: shotResult

`ShotManager.createShot()` возвращает UID. Результат получается через `shotManager.getShotResult(uid)`:

```javascript
{
  shotPaths: [
    { type: 'line', start: {x,y}, end: {x,y} },
    { type: 'circle', start: {x,y}, range: number },
    { type: 'cone', start: {x,y}, range, angle, direction, cut }
  ],
  shotHits: [
    { point: {x,y}, type: 'token'|'wall', object, ...details }
  ]
}
```

`shotPaths` передаётся в `DrawManager.drawShot(shotResult)`.

---

## Масштабирование целей (DEX)

Эффективный размер цели для расчёта попаданий масштабируется по DEX токена:

- **Формула:** `effectiveRadius = tokenRadius * (DEX / 10)`
- Применяется в `_isHitLine`, `_calculateCircleTokenCoverage`, `_calculateConeTokenCoverage`
- См. `target-size-scaling.md`

---

## Доступные payloads

Из `manifest.json`:

- `straight-line` — простая линия
- `zigzag-line` — несколько линий под углами
- `bouncing-laser` — complexLine (рикошеты, пробитие)
- `cone-blast`, `explosion` — конус и круг
- `sword-swing`, `sweeping-strike`, `swing-to-blast` — swing
- `circle-left-sweep`, `cone-far-priority` — примеры hitOrder/hitAmount
- `rocket` — линия + взрыв

---

## Связанная документация

- `shot-manager-example.md` — примеры payload и конфигураций
- `draw-manager.md` — визуализация shotResult
- `target-size-scaling.md` — DEX и размер целей
- `AIMING_SYSTEM_README.md` — быстрый старт (частично устарел)
- `AIMING_SYSTEM_DOCUMENTATION.md` — legacy система (только справка)

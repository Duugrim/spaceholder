# Shot Manager — примеры payload и конфигураций

Дополнение к [SHOOTING_SYSTEM.md](./SHOOTING_SYSTEM.md). Примеры описывают структуру payload и влияют на логику ShotManager.

## Базовая структура payload

```json
{
  "id": "straight_line",
  "name": "Прямая линия",
  "description": "Классическая прямолинейная траектория без отклонений",
  "type": "linear",
  "trajectory": {
    "segments": [
      {
        "type": "line",
        "direction": 0,
        "length": 3,
        "collision": { "walls": true, "tokens": true },
        "onHit": "stop"
      }
    ]
  }
}
```

---

## Примеры collision

```json
// Полная проверка (по умолчанию)
"collision": { "walls": true, "tokens": true }

// Только стены
"collision": { "walls": true, "tokens": false }

// Только токены (проходит сквозь стены)
"collision": { "walls": false, "tokens": true }

// Без проверок
"collision": { "walls": false, "tokens": false }

// Фильтр по диспозиции
"collision": {
  "walls": true,
  "tokens": {
    "owner": false,   // игнорировать свой токен
    "ally": true,     // попадать по союзникам
    "other": true     // попадать по врагам
  }
}
```

---

## Примеры сегментов по типам

### line

```json
{
  "type": "line",
  "direction": 0,
  "length": 3,
  "collision": { "walls": true, "tokens": true },
  "onHit": "stop"
}
```

### circle (взрыв)

```json
{
  "type": "circle",
  "range": 3,
  "collision": { "walls": true, "tokens": false },
  "onHit": "next"
}
```

### cone

```json
{
  "type": "cone",
  "direction": 0,
  "range": 5,
  "angle": 90,
  "cut": 0,
  "collision": { "walls": false, "tokens": true },
  "onHit": "next",
  "hitOrder": "far",
  "hitAmount": 2
}
```

### swing (серия конусов)

```json
{
  "type": "swing",
  "direction": -45,
  "range": 2,
  "angle": 30,
  "cut": 0,
  "directionStep": 15,
  "rangeStep": 0.2,
  "count": 7,
  "collision": { "walls": true, "tokens": true },
  "onHit": "next",
  "hitOrder": "near",
  "hitAmount": 1
}
```

### complexLine (рикошеты + пробитие)

```json
{
  "type": "complexLine",
  "direction": 0,
  "length": 2,
  "amount": 15,
  "collision": {
    "walls": true,
    "tokens": {
      "owner": false,
      "ally": false,
      "other": true
    }
  },
  "damage": {
    "penetration": 10,
    "ricochet": 45
  },
  "onHit": "stop"
}
```

---

## hitOrder и hitAmount

Для circle и cone (и swing, передаётся в каждый конус):

| hitOrder | Смысл |
|----------|-------|
| `near` | Ближайшие цели первыми (по умолчанию) |
| `far` | Дальние цели первыми |
| `left` | Слева направо относительно источника |
| `right` | Справа налево относительно источника |

`hitAmount` — максимальное количество целей (undefined = все).

---

## Алгоритм createShot

1. `createShot(token, payload, direction)` регистрирует выстрел в ShotSystem.
2. `getWhitelist(token)` — список игнорируемых объектов (стреляющий токен).
3. `getDefaults(token)` — `defSize` (grid.size/grid.distance), `defPos` (центр токена).
4. Цикл по `payload.trajectory.segments`:
   - `shotSegment(segment, context)` выбирает обработчик по `segment.type`.
   - Обработчик вызывает `isHit()` для проверки коллизий.
   - Применяются `hitOrder` и `hitAmount` (для circle/cone).
   - Результаты попадают в `shotResult.shotPaths` и `shotResult.shotHits`.
   - Если `shouldContinue === false` — выход из цикла.
5. Возвращается UID; `getShotResult(uid)` возвращает `shotResult`.

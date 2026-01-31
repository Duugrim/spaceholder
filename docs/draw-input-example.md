# DrawManager — пример входных данных (shotResult)

Структура `shotResult`, которую ожидает `DrawManager.drawShot()`. Эту же структуру возвращает `ShotManager.getShotResult(uid)`.

```javascript
shotResult = {
  shotPaths: [
    {
      type: "line",
      start: { x: 100, y: 300 },
      end: { x: 150, y: 290 }
    },
    {
      type: "line",
      start: { x: 150, y: 290 },
      end: { x: 200, y: 270 }
    },
    {
      type: "circle",
      start: { x: 200, y: 270 },
      range: 50
    }
  ],
  shotHits: [
    {
      point: { x: 150, y: 292 },
      type: "token",
      object: token1,
      distance: 50,
      details: {
        distanceToCenter: 5,
        closeness: 0.9,
        angleDeg: 12
      }
    },
    {
      point: { x: 198, y: 268 },
      type: "token",
      object: token2,
      distance: 120,
      details: {
        coverage: 0.7,
        hitPoints: [{ x, y }, ...]
      }
    }
  ]
};
```

## shotPaths

- **line:** `{ type, start, end }`
- **circle:** `{ type, start, range }`
- **cone:** `{ type, start, range, angle, direction, cut? }`

## shotHits

- `point` — координаты попадания
- `type` — `"token"` или `"wall"`
- `object` — ссылка на Token или Wall
- `distance` — расстояние от начала сегмента
- `details` — дополнительные данные (closeness, coverage, hitPoints и т.д. в зависимости от типа сегмента)

DrawManager рисует маркеры в каждой точке `shotHits[].point`.

---
doc-type: reference
status: partial
note: "PoC v1. Источники зон отдаёт модуль Azimuth; сам менеджер остался в системе как «библиотека без включателей»."
tags:
  - sh-code-doc/reference
  - sh-code-doc/status/partial
---

# Система сфер влияния (Influence Zones)

## Обзор

Менеджер зон влияния рисует на сцене территории сторон: каждая сторона (фракция) имеет источники с радиусом и силой, зоны одной стороны сливаются в общую территорию (как в Stellaris).

Менеджер остался в системе, потому что к нему подключатся новые источники. **Сам он источников не ищет и сам не включается**: источники отдаёт подключённый пакет, показывает и прячет зоны тоже пакет. Без пакета зон нет.

## Откуда берутся источники

Сегодня их отдаёт модуль **Azimuth**: токены его актёров «Объект Azimuth» (тип `azimuth.globalobject`; поля `gRange` — радиус в **клетках**, `gPower` — сила, `gFaction` — UUID фракции, `gInfluenceEnabled` — вкл/выкл). Фракция — системная («Фракция» SpaceHolder), цвет зоны берётся из её `fColor`. Связь описана в `docs/code/reference/AZIMUTH_INTEGRATION.md`: `azimuth-link.mjs` ставит провайдера, модуль добавляет кнопку включения зон в блок фракции у хотбара.

Любой другой пакет подключается так же — провайдером:

```js
game.spaceholder.integration.setInfluenceSourceProvider({
  // источники на сцене; без `faction` источник не учитывается
  collect: ({ scene, gridSize }) => [{ token, rangeCells: 4, power: 1, faction: 'Actor.<id фракции>' }],
  // что считать поводом для перерисовки (необязательно: без них пакет сам зовёт requestInfluenceRedraw)
  isSourceToken: (tokenDoc) => boolean,
  isSourceActorChange: (actor, change) => boolean,
});
game.spaceholder.integration.setInfluenceSourceProvider(null); // убрать
```

Источник может не иметь токена: вместо `token` даётся `position: {x, y}` в пикселях сцены.

## Показать и скрыть

```js
game.spaceholder.influenceManager.enable()   // показать (и держать обновлённым)
game.spaceholder.influenceManager.disable()  // скрыть
game.spaceholder.influenceManager.toggle()
```

В игре это кнопка «Переключить отображение влияния» в блоке фракции у хотбара (её добавляет модуль).

## Цвета и поведение

- Цвет стороны — `fColor` актёра-фракции, иначе детерминированный цвет по UUID.
- Зоны одной стороны сливаются, зоны разных сторон имеют свои цвета и могут пересекаться.
- Пересчёт автоматический: по создании/удалении источника, по окончании движения токена-источника, по изменению параметров источника (это решает провайдер через `isSourceToken`/`isSourceActorChange`).

## Технические детали

### InfluenceManager

**Методы:**
- `initialize()` — контейнер PIXI и хуки (на `ready`)
- `setSourceProvider(provider | null)` — подключить/снять источники
- `requestRedraw({ reason?, delayMs? })` — попросить перерисовать (пока зоны показаны)
- `enable({ debug? })`, `disable()`, `toggle()`, поле `enabled`
- `collectGlobalObjects()` — собрать источники сцены у провайдера (имя историческое)
- `drawInfluenceZones()`, `clearAll()`, `destroy()`
- `sampleInfluenceAtPoint(x, y)` — влияние в точке (для панели осмотра карты в модуле)

**Доступ:** `game.spaceholder.influenceManager`. Тест: `node module/helpers/influence-manager.test.mjs`.

### Структура источника после сбора

```js
{
  token: TokenDocument|null,
  gRange: number, // радиус в пикселях (rangeCells * grid.size)
  gPower: number,
  gFaction: string,
  position: {x: number, y: number}
}
```

## Планы развития

### v2: Настоящее объединение геометрии
- Использование библиотеки вычислительной геометрии (martinez-polygon-clipping или polybooljs)
- Точное объединение (union) кругов одной стороны в один контур
- Вычитание (subtract) областей разных сторон

### v3: Механики столкновений
- Использование `gPower` для определения границы между фракциями
- Визуализация «линии фронта» между враждебными сторонами
- Смещение границы в сторону более слабой фракции

## Troubleshooting

**Зон нет:**
- Модуль Azimuth включён и подключён (`game.modules.get('azimuth').active`; при несовпадении версий ГМ получает предупреждение)
- На сцене есть токены «Объекта Azimuth» с `gRange > 0`, включённым влиянием и заданной фракцией
- Зоны включены (`game.spaceholder.influenceManager.enabled`)
- В консоли нет ошибок (`InfluenceManager: source provider failed`)

**Цвет не тот:**
- Проверьте `gFaction` объекта (UUID фракции) и цвет самой фракции

**Производительность:**
- Текущая версия рисует отдельные круги для каждого объекта; при сотнях объектов возможны задержки

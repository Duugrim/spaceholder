---
doc-type: reference
status: current
tags:
  - sh-code-doc/reference
  - sh-code-doc/status/current
---

# Производные характеристики актёра

Источник дизайна и обоснований — карточка `docs/Kanban/Характеристики актёра.md` (там же сравнение со старыми формулами и открытые вопросы). Здесь — как это устроено в коде.

## Где что лежит

| Что | Где |
|-----|-----|
| Все формулы (чистые функции, без Foundry) | `module/helpers/derived-stats.mjs`; тест — `node module/helpers/derived-stats.test.mjs` |
| Сбор входов и запись в `system.derivedStats` | `SpaceHolderActor._prepareDerivedCharacterStats` (`module/documents/actor.mjs`) |
| Скорость вида и рост | анатомия: `speedMps`, `heightM` → `system.speedMps`, `system.heightM` |
| Поправки (`gravity`, `awarenessMult`, `willMult`, `turnStarts`) | `system.params` (`DEFAULT_PARAMS`), цели модификаторов — `CONFIG.SPACEHOLDER.characterModifierTargets.params` |
| Стоимость действий от координации | `getEffectiveActionCost` (`action-service.mjs`) → `applyActionSpeedToCost` |
| Макс. ОД | `getMaxApFromAbilities` (`transaction-ledger.mjs`) — единственная копия правила |
| Урон ближнего боя от силы | `effortShare` в записи урона (`weapon/damage-profile.mjs`), подставляется в `aiming-manager.mjs` |
| Миграция мира на шкалу 100 | `module/helpers/ability-scale-migration.mjs` |

## Шкала

100 — средний человек, 200 — пик человека. **STR** абсолютная (килограммы, «усилие»). **END** и **AGI** относительные к виду: 100 — норма вида, а норма лежит в анатомии (HP частей, рост, базовая скорость). COR, PER, INT, LUC — безразмерные.

`ability.mod = floor(√value)` (10 у среднего) нужен только d20-броскам. В производных `floor` до конца расчёта не ставится: считаем дробно, округляем на выходе. Ключ подвижности — `agi` (бывший `dex`); «ловкость» — это производная `dexterityScore`.

## Формулы

`γ` — гравитация актёра (`system.params.gravity`, 1 = Земля), `γ* = max(γ, 0.1)`.

| Ключ в `derivedStats` | Формула |
|---|---|
| `healthMult` / `healthBonusPct` | `√(END / 100)`; множитель к HP частей считается на лету в `_prepareBodyParts` (`bodyPart.effectiveMaxHp`, сохранённый `maxHp` не трогаем) |
| `liftWeight` | `STR² / 125 / γ*` кг |
| `carryWeight` | `liftWeight × END / (END + 100)` кг — без штрафа |
| `loadKg`, `loadFactor` | вес всех `item` у актёра; штраф скорости: 1 до `carry`, линейно до ×0.5 на `lift`, выше `lift` — 0 (`CONFIG.SPACEHOLDER.encumbrance.enabled`) |
| `combatSpeed` | `speedMps × AGI/100 × Γv(γ) × loadFactor` м/с, `Γv = √min(γ, 1/γ)` |
| `sprintSpeed` | `2 × combatSpeed` |
| `travelSpeed` / `travelSpeedKmh` | `min(7/15 × speedMps × √(END/100), speedMps × AGI/100) × Γv × loadFactor` |
| `speedApPerMeter` → `system.speed` | `movementApTimeSlice / max(minDist, combatSpeed × slice / AP_PER_SECOND)` |
| `jumpLongRun` | `3.6 × (sprintSpeed / 6)^1.5 × J(γ)`, `J = min(1, (2.3 − γ)/1.3)/γ`, не ниже 0 |
| `heightRun`, `heightClimb`, `heightPull` | `H × (тело + прыжок × k)`, `k = (AGI/100)^¼ × J(γ)`; коэффициенты `0.10/0.15`, `0.35/0.25`, `1.05/0.25` |
| `dexterityScore` | `(AGI + COR) / 2` |
| `actionSpeed` / `actionSpeedBonusPct` | `m = 2·COR / (COR + 100)`; цена действия = `round(база / m)`, не меньше 1; отрицательные базы и **движение** не затрагиваются |
| `reactionScore` | `√(AGI × PER)` |
| `accuracyScore` | `√(COR × PER)`; радиус блуждания прицела = клетка × `accuracyRefScore (100)` / точность |
| `awarenessScore` | `PER × awarenessMult` (по умолчанию 0.5) |
| `learnRateScore`, `skillBudget` | `√(PER × INT)`; бюджет = `round(обучаемость / 2)` |
| `willScore` | `INT × willMult` |
| `intuitionMax` | `round(√min(LUC, INT))` |
| `heroismPoints` | `round(√LUC / 2)` |
| `secondWindPoints` | `round(√(END × LUC) / 20)` |
| `turnsPerRound` | `params.turnStarts` (3); каждый старт пополняет пул ОД |
| `maxApFromAbilities` | `floor(√(AGI × INT))` |

Раунд = 3 старта × пул ≈ 10 с личного времени = 30 с (см. `PERSONAL_TIME.md`).

## Модификаторы

Предметы и эффекты складываются в `system.abilities.*.value` и `system.params.*` до расчёта производных. Прямо в `derivedStats` писать нельзя: объект пересоздаётся после модификаторов. Идентификаторы целей — `CONFIG.SPACEHOLDER.characterModifierTargets`; старый `abilities.dex` в предметах читается как `abilities.agi`.

## Урон ближнего боя

`усилие = STR` (на листе строки нет). Запись урона оружия: `урон = damage + effortShare / 100 × STR`. У боеприпасов `effortShare = 0`. Нынешние ножи, мечи и копья заданы как `damage: 0`, `effortShare: <прежний урон>`: при STR 100 урон прежний. Усилие подставляется в `aiming-manager.mjs` до модификаторов урона. Кулак (естественное оружие из анатомии) ещё не реализован — карточка «Атака любым предметом».

## Миграция

При первом запуске мира (GM) `migrateAbilityScale()`: актёры ×10 и `dex` → `agi` (старые значения — во флаге актёра `flags.spaceholder.migrations.abilityScaleV2`), модификаторы предметов ×10, изменения эффектов на `system.abilities.*`, дельты незалинкованных токенов. Маркер актёра — ключ `dex`, повторный запуск ничего не удвоит. Вручную: `await game.spaceholder.migrateAbilityScale({ force: true })`. Паки (`packs/`) пересобираются из `pack-src/` отдельно (Foundry закрыт): `npm run pack:sh-test-items`, `npm run pack:sh-test-actors`.

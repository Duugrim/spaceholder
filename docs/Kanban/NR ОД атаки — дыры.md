# ОД атаки — дыры

Стоимость атаки динамическая: шаги цепочки (`attack-chain.mjs`) + выстрелы (`aiming-manager.mjs` `_fireWeaponV3Single`). Найденные дыры:

- Координация (`getEffectiveActionCost`) не применяется к шагам цепочки и выстрелам.
- `skipPostCombatLog` у атаки, но ни цепочка, ни прицеливание не логируют — атаки нет в таблице действий боя и журнале; `combatantId: null` в ledger.
- `spendAp` обрезает до 0 и ничего не блокирует — при 0 ОД цепочка и стрельба бесплатны (доки `COMBAT_SYSTEM_V1.md` про «уходит в минус» тоже расходятся).
- `state.ready` нигде не сбрасывается — изготовка платится один раз навсегда.
- «Взять в руки»: пункт меню (`hold`) — 0 ОД, шаг цепочки — 10 ОД (`TAKE_WEAPON_AP_COST`).
- Шаг цепочки `hold` ставит `containerHostId: ''` без `unparentActorItemFromHost` — у хоста остаётся мусор в `container.contents`.

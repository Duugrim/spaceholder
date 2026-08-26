# ОД и AP_PER_SECOND

Связано с отвергнутым личным временем: [[NR Общее время]]. **Пока не трогать** код `AP_PER_SECOND` / `movementApTimeSlice`.

## Вопросы

1. Согласовать ли глобальный `AP_PER_SECOND = 10` (RPM, aiming delay) и `movementApTimeSlice` с per-actor формулой `maxОД / 10`?
2. Если да — UI оружия («сек» / RPM) должен показывать личное время стрелка или «базовые» 10 ОД = 1 с?
3. Движение: `system.speed` сейчас от фиксированного slice 10 ОД; нужен ли per-actor пересчёт?

См. `docs/code/reference/PERSONAL_TIME.md` (секция Not linked).

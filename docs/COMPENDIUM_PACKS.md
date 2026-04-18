# Компендиумы системы (Foundry v11+): устройство и поддержка

Документ для контрибьютеров и агентов: как в SpaceHolder устроены встроенные паки предметов и как их безопасно менять.

## Как это устроено в Foundry

- С **v11** данные компендиума хранятся не в одном `.db` и не «просто россыпью `.json` в папке пака», а в **LevelDB**: каталог пака (`packs/<имя-пака>/`) содержит служебные файлы (`MANIFEST-*`, `*.ldb`, `LOG`, `CURRENT`, при открытом клиенте ещё `LOCK` и т.д.).
- Поля `packs` в **`system.json`** задают **`name`**, **`label`**, **`path`** (каталог относительно корня системы), **`type`** (например `Item`), **`system`** (`spaceholder` для наших Item-паков).
- **Отдельные JSON-файлы, положенные вручную в тот же каталог, что и LevelDB, движок не подхватывает как записи компендиума.** Они только засоряют репозиторий и вводят в заблуждение. Источник правды для git — каталог **`pack-src/`**.

## Структура в репозитории SpaceHolder

| Путь | Назначение |
|------|------------|
| `system.json` → `packs[]` | Объявление паков и путей к каталогам LevelDB. |
| `pack-src/<имя-пака>/` | **Исходники**: по одному JSON на документ (человекочитаемо, нормально диффается в git). |
| `packs/<имя-пака>/` | **Собранный** компендиум (LevelDB). То, что реально читает Foundry. |
| `scripts/compile-sh-test-items.mjs` | Сборка LevelDB из `pack-src/sh-test-items` через `@foundryvtt/foundryvtt-cli` (`compilePack`). |
| `packs/.gitattributes` | У каталогов паков бинарные артефакты LevelDB помечены как binary (см. статью Foundry про CRLF). |

Пример пака: **`sh-test-items`** (`SpaceHolder Test Items`), исходники в **`pack-src/sh-test-items/`**.

## Обязательные поля в JSON исходника (Item)

Ориентир — экспорт/unpack из Foundry или эталон в `pack-src/sh-test-items/*.json`.

- Стандартные поля документа: `_id`, `name`, `type`, `img`, `system`, `effects`, `folder`, `sort`, `ownership`, `flags`.
- **`_key`**: строка вида `"!items!<_id>"`. Без неё **foundryvtt-cli** при сборке пропускает файл.
- **`_stats`**: метаданные версий (как в данных Foundry). Для репозитория допустимо выравнивать `systemId` / `systemVersion` под текущий `system.json`, `lastModifiedBy: null` для записей без привязки к пользователю.

Схема `system` для типа `item` задаётся **`template.json`** и поведением **`SpaceHolderItem`** (`module/documents/item.mjs`).

## Двухэтапный рабочий процесс (обязательный для агентов)

Цель: не ломать LevelDB и не упираться в **LOCK**, пока Foundry держит пак открытым.

### Этап 1 — правки только в исходниках (агент / разработчик)

1. Менять или добавлять записи **только** в **`pack-src/<имя-пака>/*.json`**.
2. У новых предметов задать уникальный `_id`, **`_key`**: `"!items!" + _id`, заполнить `system` по шаблону системы.
3. Закоммитить изменения в `pack-src/`, скрипты и при необходимости `system.json` — **без** попытки пересобрать пак в среде, где это невозможно.

### Этап 2 — сборка пака (пользователь-разработчик локально)

1. **Полностью закрыть Foundry VTT** (иначе на каталоге пака остаётся LOCK, сборка может завершиться ошибкой или дать неконсистентную базу).
2. В корне системы выполнить:
   ```bash
   npm run pack:sh-test-items
   ```
   Это пересобирает **`packs/sh-test-items`** из **`pack-src/sh-test-items`** на месте (`--in-place` в `scripts/compile-sh-test-items.mjs`).

**Инструкция для пользователя в чате/PR (копипаст):**  
«Закрой Foundry, в папке системы выполни `npm run pack:sh-test-items`, затем снова открой мир и проверь компендиум.»

Агент не заменяет этот шаг «магией», если нет гарантии, что Foundry закрыт и LOCK снят.

## Команды npm (справочно)

| Команда | Когда использовать |
|---------|-------------------|
| `npm run pack:sh-test-items` | Основная сборка в **`packs/sh-test-items`**. **Foundry должен быть закрыт.** |
| `npm run pack:sh-test-items:next` | Сборка в **`packs/sh-test-items-next`** (обход LOCK на основном каталоге, пока клиент открыт). Потом вручную: закрыть Foundry, заменить каталог пака или перенести содержимое. |
| `npm run unpack:sh-test-items` | Выгрузить текущий LevelDB из **`packs/sh-test-items`** в **`pack-src/sh-test-items`** (с `-c` очищает цель). **Предпочтительно при закрытом Foundry.** Удобно подтянуть правки, сделанные в UI компендиума, обратно в исходники. |

Зависимость: **`@foundryvtt/foundryvtt-cli`** (devDependency), см. официальный CLI и статью Foundry про LevelDB-паки.

## Добавление нового пака предметов (чеклист)

1. Добавить блок в **`system.json`** → `packs` (`name`, `label`, `path`, `type`, `system`).
2. Создать **`pack-src/<name>/`** с JSON-файлами.
3. Добавить скрипт сборки по образцу **`scripts/compile-sh-test-items.mjs`** (другой `dest`) или обобщить один скрипт с аргументами — и строки в **`package.json`**.
4. Собрать пак командой после закрытия Foundry.
5. При необходимости расширить **`packFolders`** в `system.json`.

## Частые проблемы

- **В компендиуме пусто, хотя JSON лежит рядом с паком** — JSON не является источником для Foundry; нужна пересборка LevelDB из `pack-src/`.
- **`The pack is currently in use by Foundry VTT`** — открыт клиент; закрыть Foundry или собрать во временный каталог (`pack:sh-test-items:next`).
- **Путаница с git и LevelDB** — не менять line endings у бинарных файлов пака; исходники держать в **`pack-src/`**.

## Ссылки

- [Version 11 Content Packaging Changes (Foundry)](https://foundryvtt.com/article/v11-leveldb-packs/)
- [foundryvtt-cli](https://github.com/foundryvtt/foundryvtt-cli)

# Контент-план Publikator

Контент-план предназначен для массовой подготовки публикаций в CSV/XLSX без превращения таблицы во вторую runtime-базу данных.

## Основной контракт

Одна строка файла = одна новая публикация Publikator.

Версия схемы: `1`.

Обязательные колонки:

| Колонка | Формат | Назначение |
|---|---|---|
| `project` | string | `slug` уже существующего проекта |
| `title` | string | заголовок публикации |
| `body` | string | базовый текст публикации |
| `schedule_mode` | `MANUAL` / `AT` / `QUEUE` | режим публикации |
| `scheduled_at` | ISO-8601 datetime или пусто | обязательно только для `AT`; для `MANUAL`/`QUEUE` должно быть пустым |
| `targets` | JSON array | выбранные аккаунты публикации |
| `platform_overrides` | JSON array | отдельные тексты конкретных аккаунтов |
| `media_references` | JSON array | ссылки на уже существующие media Publikator |

Порядок колонок при импорте может отличаться. Пропущенные, неизвестные и повторяющиеся колонки блокируют импорт.

## Targets

Ячейка `targets` содержит JSON-массив:

```json
[
  {
    "platform": "telegram",
    "name": "Основной канал",
    "accountId": "acc_123"
  },
  {
    "platform": "vk",
    "name": "Школа"
  }
]
```

`platform` принимает только `telegram`, `vk`, `max`, `instagram`.

Для максимально устойчивого round-trip экспорт сохраняет `accountId`, `platform` и `name`. При импорте сначала используется точный `accountId`; если он отсутствует или больше не существует, допускается поиск по уникальной паре `platform + name`.

Если несколько аккаунтов имеют одинаковые `platform + name`, импорт без `accountId` блокируется как неоднозначный.

Отключённый аккаунт нельзя выбрать как target.

## Platform overrides

Ячейка `platform_overrides` содержит JSON-массив:

```json
[
  {
    "platform": "telegram",
    "name": "Основной канал",
    "accountId": "acc_123",
    "text": "Отдельный текст для Telegram"
  }
]
```

Override относится к конкретному аккаунту, а не только к типу площадки. Поэтому Publikator корректно поддерживает несколько Telegram/VK/MAX/Instagram аккаунтов одновременно.

Override для невыбранного target разрешён: текст будет сохранён, но target останется выключенным. Dry-run показывает предупреждение.

Максимальная длина override — 20 000 символов.

## Media references

Ячейка `media_references` содержит JSON-массив в порядке показа изображений:

```json
[
  {
    "relativePath": "post_abc/med_def.jpg",
    "originalName": "poster.png",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
]
```

Контент-план **не встраивает бинарные изображения** в CSV/XLSX и не читает произвольные локальные пути компьютера. `relativePath` должен указывать на media, уже зарегистрированную в текущей SQLite и существующую в `data/media`.

Перед импортом Publikator проверяет:

- наличие записи media в SQLite;
- наличие файла на диске;
- размер файла;
- SHA-256 из SQLite;
- SHA-256 из таблицы, если он указан.

При apply исходный нормализованный media-файл копируется в каталог нового поста с новым `media.id`. Порядок списка становится `sort_order` новой публикации.

Для переноса данных между серверами используйте полный backup bundle Publikator. CSV/XLSX предназначен для управления контент-планом, а не для замены backup/restore.

## CSV

Экспорт Publikator:

- UTF-8;
- BOM для корректного открытия в Excel;
- разделитель `;`;
- стандартное экранирование двойными кавычками;
- переносы строк внутри `body` и JSON корректно заключаются в кавычки.

Импорт автоматически распознаёт `;`, `,` и tab.

Лимиты:

- до 10 000 строк данных;
- до 20 МБ на файл.

## XLSX

XLSX читается и создаётся непосредственно Node.js приложением. LibreOffice, Microsoft Excel, Google Sheets, Python и отдельный converter-сервис в runtime не нужны.

Используется первый лист книги. Заголовок должен содержать полный набор колонок схемы.

## Dry-run

`POST /api/content-plan/import/preview` только разбирает и проверяет файл. Записи в SQLite и media storage не создаются.

Ответ содержит:

- `fileSha256`;
- общую статистику;
- `canApply`;
- результат каждой строки;
- ошибки и предупреждения;
- нормализованные project/schedule/targets/media для корректных строк.

Apply-кнопка UI активируется только при `canApply=true`.

## Apply

`POST /api/content-plan/import/apply` требует одновременно:

```text
x-publikator-content-plan: IMPORT
x-content-plan-sha256: <SHA-256 из последнего preview>
```

Сервер повторно читает файл и сравнивает его SHA-256. Изменённый после preview файл блокируется.

Затем текущий запрос получает эксклюзивный maintenance gate, файл проверяется **ещё раз** уже внутри защищённого окна, и только после этого начинается запись.

Все импортированные публикации создаются как `DRAFT`. Контент-план не может автоматически поставить публикацию в `READY` и тем более отправить её во внешние соцсети.

Если ошибка возникает во время копирования/записи, все уже созданные этим импортом публикации удаляются вместе с их новыми media-каталогами.

## Export API

Все проекты:

```text
GET /api/content-plan/export.csv
GET /api/content-plan/export.xlsx
```

Один проект:

```text
GET /api/content-plan/export.csv?projectId=<project-id>
GET /api/content-plan/export.xlsx?projectId=<project-id>
```

Схема для UI/интеграций:

```text
GET /api/content-plan/schema
```

Google Sheets может быть добавлен в будущем только как необязательный import/export connector. Он не является runtime-зависимостью Publikator.

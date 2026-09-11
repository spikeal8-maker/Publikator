# Content Pipeline v2

> Normative vNext decisions are defined in [`VNEXT_TECHNICAL_SPEC.md`](VNEXT_TECHNICAL_SPEC.md). If this document conflicts with the master specification, the master specification wins.


## Цель

Сделать Publikator не только движком публикации, но и единым рабочим местом, куда контент поступает вручную, массовым импортом, из Google Sheets, из облачных папок и через API от ботов/AI.

Ключевой принцип: **Publikator остаётся единственным source of truth.** Таблицы, Google Sheets, Google Drive, Яндекс Диск и внешние агенты являются только источниками/коннекторами. После импорта пост, media, расписание и состояние публикации живут в Publikator.

## Целевой поток

```text
Ручной ввод ─┐
CSV/XLSX ────┤
ZIP bundle ──┤
Google Sheets├──> Content Inbox -> DRAFT -> Review/Preview -> READY -> Calendar/Queue -> Publish
Google Drive ┤                                  │
Яндекс Диск ─┤                                  └-> TG / VK / MAX / Instagram
AI / Bot API ┘
```

## Что не делаем

- не превращаем Google Sheets в runtime-БД;
- не публикуем непосредственно из таблицы;
- не даём AI обходить Publikator и писать напрямую в соцсети;
- не делаем embedded image внутри XLSX/Google Sheets основным контрактом;
- не добавляем Redis/RabbitMQ/Kafka/отдельный worker только ради импорта.

## 1. Контент как каноническая сущность

Существующая таблица `posts` остаётся канонической. Статусы публикации не надо ломать: `DRAFT -> READY -> PUBLISHING/PUBLISHED/...`.

Для происхождения контента добавить отдельную ingestion metadata, а не смешивать её со статусами публикации:

```text
source_type       manual | xlsx | csv | bundle | google_sheets | google_drive | yandex_disk | api | ai
source_ref        внешний ID/номер строки/URL/ID задания
source_batch_id   ID импорта
source_revision   версия строки/объекта источника
imported_at
```

Повторный импорт одного `external_id/source_ref` должен быть идемпотентным: либо обновить существующий DRAFT по явному режиму, либо вернуть `duplicate`.

## 2. Ручной ввод

Существующий `Контент -> Новый пост` сохраняется, но становится одним из входов в общий Content Inbox.

Нужно добавить:

- нормальный список будущих публикаций;
- фильтры `Inbox / Draft / Ready / Scheduled / Published / Problems`;
- явную дату/время в списке;
- источник поста (`manual`, `Google Sheets`, `AI`, ...);
- кнопку `Клонировать`;
- bulk actions для нескольких DRAFT/READY.

## 3. CSV/XLSX schema 3 template

Пользователь должен иметь кнопку `Скачать шаблон`.

Минимальные колонки:

| Поле | Назначение |
|---|---|
| `external_id` | стабильный ID строки/поста |
| `project` | slug проекта |
| `title` | внутренний заголовок |
| `body` | базовый текст |
| `schedule_mode` | `MANUAL / AT / QUEUE` |
| `scheduled_at` | дата/время для AT |
| `timezone` | timezone |
| `targets` | площадки/аккаунты |
| `platform_overrides` | отдельные тексты |
| `media` | список media keys/файлов/URL |
| `source_note` | комментарий оператора/бота |

Формат `media` в CSV/XLSX должен быть простым и человекочитаемым. Базовый вариант:

```text
asa-001__01.jpg|asa-001__02.jpg
```

или JSON-массив при сложном случае:

```json
["asa-001__01.jpg","asa-001__02.jpg"]
```

Импорт всегда идёт через preview/dry-run. Apply создаёт только DRAFT.

## 4. Content Bundle — основной массовый перенос

Для сотен постов основной перенос должен быть одним ZIP:

```text
content-bundle.zip
  content.xlsx
  media/
    asa-001__01.jpg
    asa-001__02.jpg
    asa-002__01.png
  manifest.json        # опционально
```

Преимущества:

- не зависит от Google/Яндекс;
- легко генерируется ботом;
- переносим между Windows/Linux;
- media не теряются;
- можно проверить bundle целиком до записи;
- можно импортировать сотни постов одной операцией.

### Naming convention

Рекомендуемый формат:

```text
<external_id>__<order>.<ext>
asa-001__01.jpg
asa-001__02.jpg
```

Если `media` в таблице пустой, importer может в permissive mode автоматически собрать все файлы с префиксом `<external_id>__` и отсортировать по номеру.

При явном `media` используется только указанный список и порядок.

## 5. Картинки внутри Excel/Google Sheets

### Основной контракт — НЕ embedded image

Картинка внутри ячейки/рисунок над ячейкой выглядит удобно, но как машинный обмен это нестабильно:

- XLSX drawings привязаны к anchor/cell relationship, а не к простому cell value;
- Google Sheets может хранить `IMAGE()`/drawing отдельно;
- экспорт между Sheets/Excel может менять привязки;
- у изображения часто нет стабильного имени.

Поэтому основной контракт: `media key / filename / cloud URL`.

### Дополнительная поддержка позже

После базового bundle можно добавить best-effort импорт:

- XLSX embedded image, привязанное к строке;
- Google Sheets `=IMAGE(url)`;
- URL в ячейке.

Но importer должен преобразовать найденное изображение в обычный media asset Publikator и больше не зависеть от таблицы.

## 6. Google Sheets connector

Google Sheets — внешний редактор/inbox, не база.

Нужно дать пользователю:

- `Скачать XLSX шаблон`;
- `Создать копию Google Sheets шаблона`;
- подключить конкретную таблицу;
- выбрать лист;
- `Preview sync`;
- `Import new/changed rows`.

Синхронизация только в направлении:

```text
Google Sheets -> Publikator DRAFT
```

Для предотвращения дублей используются `external_id + source_revision`.

Обратно в таблицу можно писать только служебный результат:

```text
publikator_id
import_status
imported_at
last_error
```

Это не должно становиться обязательным для работы Publikator.

## 7. Google Drive / Яндекс Диск / файловые папки

Коннекторы нужны главным образом для media.

Таблица может содержать:

```text
media = asa-001__01.jpg|asa-001__02.jpg
```

а source config задаёт папку:

```text
Google Drive folder: /Publikator/ASA/September
```

или:

```text
Yandex Disk folder: /Publikator/ASA/September
```

Importer:

1. читает media keys из строки;
2. находит файлы в подключённой папке;
3. скачивает bytes;
4. прогоняет обычный media pipeline Publikator;
5. сохраняет локально;
6. после импорта runtime больше не зависит от облака.

Нужно поддержать также публичный HTTPS URL как media source.

Приоритет реализации:

1. ZIP bundle / local upload;
2. Google Drive;
3. Яндекс Диск;
4. другие источники при реальной необходимости.

## 8. Integration API v1 для ботов и AI

Browser session cookie не подходит внешним агентам. Нужны отдельные integration API keys.

Пример:

```http
POST /api/integration/v1/drafts
Authorization: Bearer pk_...
Idempotency-Key: asa-2026-09-001
```

JSON без media:

```json
{
  "externalId": "asa-2026-09-001",
  "project": "asa-lab",
  "title": "Новый модуль",
  "body": "Текст поста...",
  "schedule": {
    "mode": "AT",
    "at": "2026-09-15T10:00:00+03:00"
  },
  "targets": ["telegram-main","vk-main"],
  "overrides": {
    "telegram-main": "Отдельный Telegram текст"
  }
}
```

Для media нужен multipart endpoint либо отдельная загрузка по `draftId`.

Минимальный API:

```text
POST /api/integration/v1/drafts
POST /api/integration/v1/drafts/:id/media
GET  /api/integration/v1/drafts/:id
POST /api/integration/v1/batches/preview
POST /api/integration/v1/batches/apply
```

Ключи должны иметь scopes, например:

```text
content:write
content:read
media:write
```

По умолчанию внешнее API создаёт только DRAFT. Автоматический READY/publish — отдельное явно включаемое право после стабилизации.

## 9. AI content source

AI не должен быть встроен жёстко в publication runtime. Он является ещё одним producer контента.

Для каждого проекта нужен `Content Profile`:

```text
описание продукта
аудитория
темы
тон
CTA
запрещённые утверждения
ссылки/источники
частота публикаций
площадки по умолчанию
```

AI pipeline:

```text
project sources -> generate text/images -> Integration API -> DRAFT -> human review -> READY
```

Позже можно добавить `autopilot` на уровне проекта, но только после отдельного acceptance.

## 10. Calendar / Content Board

Текущий экран `Расписание` — технические QUEUE slots. Он не заменяет календарь контента.

Нужен новый основной экран `Календарь` или `Контент-план`:

```text
Месяц / Неделя / Список
```

Карточка должна показывать:

- дату/время;
- проект;
- заголовок;
- thumbnail первого media;
- площадки;
- DRAFT/READY/PUBLISHED;
- источник;
- наличие предупреждений.

Нужны отдельные представления:

```text
Inbox
Черновики
На проверке/Ready
Запланировано
Опубликовано
Проблемы
```

QUEUE posts должны отображаться как очередь проекта даже если точное будущее время ещё не присвоено.

## 11. Preview перед публикацией

Preview становится обязательной частью редактора.

Для каждого target показывать:

- resolved text;
- media order;
- число изображений;
- ограничения площадки;
- caption/text split для Telegram;
- carousel для Instagram;
- публичную media accessibility для MAX/Instagram.

Preview ориентировочный по UI, но publish input должен быть тем же объектом, который пойдёт в adapter.

## 12. Этапы реализации

### CP2-001 — Content UX / Calendar

- будущие публикации видны по времени;
- Inbox/Draft/Ready/Scheduled/Published/Problems;
- source badge;
- нормальный calendar/list UI;
- технический QUEUE scheduler отделён от пользовательского календаря.

### CP2-002 ? Content Plan schema 3

- downloadable CSV;
- downloadable XLSX;
- public schema 3;
- `external_id`;
- media filename/key references;
- preview/apply;
- batch result report.

### CP2-003 — ZIP Content Bundle

- `content.xlsx|csv + media/`;
- filename matching;
- deterministic media order;
- duplicate/idempotency handling;
- all-or-nothing apply per row, clear batch report.

### CP2-004 — Integration API v1

- API keys/scopes;
- draft creation;
- media upload;
- batch endpoint;
- idempotency key;
- API documentation/examples.

### CP2-005 — Google Sheets

- reusable template;
- connector settings;
- preview/import;
- `external_id` mapping;
- optional status write-back.

### CP2-006 — Cloud media

- Google Drive folder resolver;
- then Яндекс Диск resolver;
- HTTP media source;
- download -> existing media pipeline.

### CP2-007 — AI Content Profile

- project content profile;
- external AI producer example;
- text/image -> Integration API;
- only DRAFT by default.

### CP2-008 — Advanced ingest

- best-effort XLSX embedded images;
- Google Sheets `IMAGE()` URLs;
- optional autopilot policies.

## 13. Acceptance criteria

Сценарий на 100 постов:

1. бот формирует `content.xlsx` и 150 изображений;
2. файлы упаковываются в ZIP либо кладутся в cloud folder;
3. Publikator Preview показывает 100 строк, найденные media, даты, targets и ошибки;
4. Apply создаёт 100 DRAFT без дублей;
5. календарь показывает будущие публикации;
6. оператор открывает любой пост и видит platform previews;
7. выбранные посты переводятся в READY;
8. scheduler публикует их без повторного обращения к исходной таблице/облаку;
9. повторный импорт того же batch не создаёт 100 дублей;
10. export/backup содержит canonical state Publikator.

## 14. Порядок приоритетов

Рекомендуемый порядок без расползания проекта:

```text
CP2-001 Calendar/UX
CP2-002 Content Plan schema 3
CP2-003 ZIP Bundle
CP2-004 Integration API
CP2-005 Google Sheets
CP2-006 Drive/Yandex media
CP2-007 AI producer
CP2-008 Embedded images/autopilot
```

Главный критерий: после первых четырёх этапов Publikator уже должен уверенно принимать сотни постов вручную, из файлов и от ботов. Коннекторы облаков и AI строятся поверх этого контракта, а не создают параллельные модели данных.

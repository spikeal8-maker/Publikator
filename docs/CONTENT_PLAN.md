# Контент-план Publikator

## Статус документа

Этот документ фиксирует **текущий V1 contract schema 1** и правила совместимости с будущим vNext contract.

Нормативное vNext ТЗ:

[`VNEXT_TECHNICAL_SPEC.md`](VNEXT_TECHNICAL_SPEC.md)

Важно:

```text
schema 1 = текущий V1 contract
schema 2 = planning draft, НЕ выпускать как публичный contract
schema 3 = первый публичный vNext contract
```

Существующие V1 endpoints нельзя скрытно менять на schema 3.

---

# 1. V1 schema 1

Контент-план предназначен для массовой подготовки публикаций в CSV/XLSX без превращения таблицы во вторую runtime-базу.

Одна строка файла = одна новая публикация Publikator.

Версия схемы:

```text
1
```

Обязательные колонки V1:

| Колонка | Формат | Назначение |
|---|---|---|
| `project` | string | slug существующего проекта |
| `title` | string | внутренний заголовок |
| `body` | string | базовый plain text |
| `schedule_mode` | `MANUAL / AT / QUEUE` | режим публикации |
| `scheduled_at` | ISO-8601 или пусто | только для AT |
| `targets` | JSON array | выбранные accounts |
| `platform_overrides` | JSON array | account-specific plain text |
| `media_references` | JSON array | существующие media Publikator |

V1 import не читает произвольные local paths и не встраивает binary media в spreadsheet.

---

# 2. V1 Targets

`targets` содержит JSON array.

Пример:

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

Разрешённые platforms V1:

```text
telegram
vk
max
instagram
```

Resolution:

1. точный `accountId`;
2. fallback на уникальную пару `platform + name`.

Неоднозначный fallback блокирует import.

Disabled account нельзя выбрать как active target.

---

# 3. V1 Platform overrides

Пример:

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

V1 override = plain text.

vNext rich-text overrides реализуются только в schema 3.

---

# 4. V1 Media references

Пример:

```json
[
  {
    "relativePath": "post_abc/med_def.jpg",
    "originalName": "poster.png",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
]
```

Schema 1 media reference должен указывать на media, уже зарегистрированный в текущей SQLite и существующий в canonical `data/media`.

V1 importer проверяет:

- DB record;
- файл;
- размер;
- SHA-256;
- optional SHA из таблицы.

При apply media копируется в новый post и получает новый media id.

---

# 5. CSV/XLSX V1

CSV:

- UTF-8;
- BOM для Excel;
- `;` по умолчанию;
- importer также распознаёт `,` и tab;
- корректное quote escaping;
- multiline body поддерживается.

V1 limits:

```text
до 10 000 data rows
до 20 MB file
```

XLSX:

- читается Node.js приложением;
- используется первый лист;
- LibreOffice/Excel/Python runtime dependency не требуется.

---

# 6. V1 Preview / Apply

Preview endpoint:

```text
POST /api/content-plan/import/preview
```

Preview:

- ничего не записывает;
- возвращает file SHA-256;
- row results;
- errors/warnings;
- normalized project/schedule/targets/media;
- `canApply`.

Apply endpoint:

```text
POST /api/content-plan/import/apply
```

Требует:

```text
x-publikator-content-plan: IMPORT
x-content-plan-sha256: <preview sha>
```

Apply повторно проверяет файл и SHA.

Все импортированные posts V1 создаются как `DRAFT`.

Content-plan import никогда автоматически не публикует наружу.

---

# 7. V1 Export API

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

Schema:

```text
GET /api/content-plan/schema
```

Эти endpoints сохраняют V1 semantics на compatibility period.

---

# 8. vNext schema 3

Schema 3 является новым контрактом и реализуется отдельно от V1 namespace.

Рекомендуемые endpoints:

```text
GET  /api/content-plan/v3/schema
GET  /api/content-plan/v3/template.csv
GET  /api/content-plan/v3/template.xlsx
POST /api/content-plan/v3/import/preview
POST /api/content-plan/v3/import/apply
GET  /api/content-plan/v3/export.csv
GET  /api/content-plan/v3/export.xlsx
```

Mandatory columns schema 3:

| Поле | Назначение |
|---|---|
| `schema_version` | всегда `3` |
| `external_id` | стабильный ID source row/content |
| `action` | `UPSERT / ARCHIVE / TRASH_REQUEST` |
| `project` | project slug |
| `template_key` | optional template |
| `internal_title` | внутреннее название |
| `body` | portable rich text |
| `publication_kind` | FEED/SHORT/STORY |
| `content_format` | TEXT_ONLY/IMAGE/CAROUSEL/VIDEO/VERTICAL_VIDEO/STORY_SEQUENCE |
| `schedule_mode` | MANUAL/AT/QUEUE |
| `scheduled_at` | date/time for AT |
| `timezone` | IANA timezone |
| `targets` | account aliases/IDs |
| `telegram_body` | optional rendition text |
| `vk_body` | optional rendition text |
| `max_body` | optional rendition text |
| `instagram_body` | optional rendition text |
| `media` | filenames/keys/URLs |
| `tags` | internal tags |
| `source_note` | internal source note |
| `source_revision` | source revision/version |

Schema 3 plain spreadsheet syntax является neutral portable markup, не Telegram/MAX markup.

---

# 9. Schema 3 source identity

Repeated import MUST быть idempotent через:

```text
source_id + external_id
```

Importer хранит SourceBinding.

Повторный import одной source row:

- не создаёт второй post;
- классифицируется как UPDATE/UNCHANGED/CONFLICT;
- автоматически UPDATE только если local content после предыдущего import не менялся.

---

# 10. Schema 3 delete semantics

Отсутствие строки в следующей таблице ничего не удаляет.

Удаление/архивация требует явного `action`:

```text
ARCHIVE
TRASH_REQUEST
```

Hard delete через spreadsheet запрещён.

---

# 11. Schema 3 media

Основной contract:

```text
filename / media key / supported cloud reference / allowed HTTPS URL
```

ZIP bundle naming:

```text
<external_id>__01.jpg
<external_id>__02.mp4
```

Embedded XLSX/Google Sheets images — optional advanced ingest, не базовый contract.

Найденный внешний asset после import становится local canonical MediaAsset.

---

# 12. Google Sheets

Google Sheets template schema 3 SHOULD иметь sheets:

```text
Posts
Lists
Instructions
Examples
```

Sheets является connector/editor, не runtime DB.

Preview classifications:

```text
NEW
UPDATE
UNCHANGED
CONFLICT
ARCHIVE_REQUEST
TRASH_REQUEST
ERROR
```

Удаление row не удаляет post.

---

# 13. Migration / compatibility rules

Во время vNext development:

- V1 schema 1 import/export regression сохраняется;
- schema 3 имеет отдельные tests/endpoints;
- schema 2 наружу не публикуется;
- existing V1 users не обязаны немедленно мигрировать spreadsheets;
- stable removal/deprecation V1 API требует отдельного release note и migration path.

---

# 14. Security

Schema 3 importer обязан выполнять требования `VNEXT_TECHNICAL_SPEC.md`, включая:

- ZIP traversal/bomb protections;
- MIME verification;
- SSRF protections для remote media;
- portable rich-text validation;
- spreadsheet formula injection protection на export;
- batch/upload limits;
- preview-before-apply.

---

# 15. Source of truth

Ни schema 1, ни schema 3 spreadsheet не являются backup или runtime source of truth.

Для disaster recovery используется canonical full `.tgz` backup Publikator.
# Архитектура Publikator

## Статус документа

Этот документ описывает общую архитектуру Publikator и обязан соответствовать [`VNEXT_TECHNICAL_SPEC.md`](VNEXT_TECHNICAL_SPEC.md).

При конфликте нормативное vNext ТЗ имеет приоритет.

Текущая стабильная линия V1 и дальнейшая vNext-разработка разделены:

```text
release/1.0  -> v1.0.0-rc.4 -> live acceptance -> v1.0.0
main         -> vNext product development
```

---

# 1. Архитектурное решение

Publikator — **модульный монолит**.

В production запускается:

```text
1 repository
1 Docker container
1 Node.js/Fastify process
1 SQLite/WAL
1 local media storage
1 embedded scheduler
```

```text
Browser / Integration API / Connectors
                │
                ▼
             Fastify
                │
      ┌─────────┼─────────┐
      ▼         ▼         ▼
    SQLite    Scheduler   Media pipeline
      │                     │
      │                     ├─ Images / Sharp
      │                     └─ vNext Video / ffmpeg+ffprobe
      │
      └──────────────► Platform adapters
                       ├─ Telegram
                       ├─ VK
                       ├─ MAX
                       └─ Instagram
```

Без отдельного ADR нельзя добавлять второй backend, worker service, Redis, RabbitMQ, Kafka, n8n или вторую runtime-БД.

---

# 2. Source of truth

Единственный runtime source of truth после ingestion:

```text
SQLite + local canonical media storage
```

Не являются runtime master:

- Google Sheets;
- Google Drive;
- Яндекс Диск;
- CSV/XLSX;
- ZIP bundle;
- AI agent;
- внешний bot/API client.

После успешного import content и media должны быть локально канонизированы в Publikator.

---

# 3. V1 и vNext media invariant

## 3.1 Текущая V1 реализация

RC4 поддерживает image-based publication и backend действительно блокирует READY/publish без изображения.

Это **V1 implementation invariant**, а не вечное правило продукта.

## 3.2 vNext invariant

vNext вводит:

```text
TEXT_ONLY
IMAGE
CAROUSEL
VIDEO
VERTICAL_VIDEO
STORY_SEQUENCE
```

Поэтому общий invariant vNext:

> READY допускается только тогда, когда resolved rendition каждого выбранного target соответствует capability соответствующего platform adapter.

Media обязательно только там, где его требует выбранный формат/площадка.

Пока новый adapter/capability не реализован, старый image adapter продолжает корректно блокировать неподдерживаемый формат.

---

# 4. Каноническая content-модель vNext

Нормативная модель определена в `VNEXT_TECHNICAL_SPEC.md`.

Ключевые сущности:

```text
Project
Post / Content
ContentRevision
MediaAsset
ContentMedia
SocialAccount
PostTarget
TargetRendition
PublicationUnit
Template / Snippet
IngestionSource
SourceBinding
ImportBatch
IntegrationApiKey
```

Основной принцип:

```text
editable working content
        │
        ├─ content_version
        │
        ▼
immutable ContentRevision
        │
        ▼
preflight / READY
        │
        ▼
publication uses only immutable revision
```

Publisher не должен после claim читать mutable working content.

---

# 5. Состояния

## 5.1 Editorial stage

```text
IDEA
DRAFT
IN_REVIEW
APPROVED
ARCHIVED
TRASHED
```

Редакционный этап не смешивается с доставкой в соцсеть.

## 5.2 Publication status

Канонический vNext lifecycle:

```text
DRAFT
READY
PUBLISHING
PARTIAL
PUBLISHED
FAILED
```

`QUEUE` — schedule mode.

Текущее DB-значение `QUEUED` является legacy/reserved и новым vNext кодом не выставляется. При миграции старые `QUEUED` должны нормализоваться в `READY + schedule_mode=QUEUE`.

## 5.3 Target state

Сохраняется текущая безопасная модель:

```text
PENDING
PUBLISHING
PUBLISHED
RETRY
FAILED
RECOVERY_NEEDED
```

---

# 6. Publication concurrency

Ни один внешний публичный POST нельзя выполнять до успешного atomic claim.

vNext усиливает этот invariant:

- claim должен относиться к конкретной `ready_revision_id`;
- `content_version` должен совпадать с версией одобренной revision;
- publisher получает resolved input только из immutable revision/rendition snapshot;
- editing endpoint использует optimistic concurrency.

Это устраняет гонку:

```text
scheduler выбрал READY
↕
пользователь одновременно изменил текст/media
```

Нельзя строить external PublishInput из mutable post до claim и отправлять его после claim.

---

# 7. Recovery

`RECOVERY_NEEDED` означает, что внешний POST мог завершиться успешно, но локальный процесс не знает результат.

Правила:

- generic retry запрещён;
- оператор сначала проверяет площадку;
- `confirm-published` не делает второй POST;
- `confirm-not-published` только после достоверной проверки возвращает возможность retry.

Для Story Sequence и других multi-public-operation formats вводится `PublicationUnit`.

Каждый публичный POST sequence имеет отдельное состояние, поэтому уже опубликованные story items не повторяются автоматически.

---

# 8. Scheduler

Поддерживаются три scheduling semantics:

```text
MANUAL
AT
QUEUE
```

## AT

vNext хранит:

```text
scheduled_at_utc
schedule_timezone (IANA)
```

Scheduler работает по UTC instant.

Timezone хранится для корректного пользовательского отображения и редактирования.

## QUEUE

QUEUE post остаётся `READY` и выбирается schedule slot проекта.

Технический экран `Расписание` управляет slots.

Visual `Календарь` не является альтернативным scheduler и не реализует собственный publish loop.

Drag QUEUE post в точное время требует явного `QUEUE -> AT` подтверждения.

---

# 9. Platform capability

Каждый adapter должен объявлять capability contract, используемый одновременно:

- backend preflight;
- UI controls;
- platform preview;
- publish validation.

Минимум capability:

```text
supportsFeed
supportsStories
supportsShortVideo
supportsTextOnly
supportsImage
supportsVideo
supportsCarousel
supportsMixedCarousel
maxMediaPerPublication
allowedMimeTypes
aspectRatioRules
durationRules
textRules
requiresPublicHttpsMedia
platformOptionsSchema
```

Frontend не хранит независимую копию platform rules.

---

# 10. Rich text

Source of truth текста vNext:

```text
canonical rich-text AST + plain fallback
```

Нельзя использовать raw Telegram Markdown/MAX HTML как канонический content.

Platform compiler преобразует AST в формат конкретного API и формирует downgrade report.

Preview и publisher должны работать с одним resolved rendition.

---

# 11. Media architecture

## Images

Текущий Sharp pipeline сохраняется.

## Video vNext first scope

Production-safe первый scope:

```text
MP4
H.264 video
AAC or no audio
ffprobe metadata
ffmpeg poster frame
```

ffmpeg/ffprobe устанавливаются в тот же production container.

Неподдерживаемый input блокируется. Distributed transcoding не добавляется.

Размеры upload/bundle/temp storage конфигурируемы и диагностируемы.

---

# 12. Ingestion / connectors

Все ingestion paths сходятся в один canonical pipeline:

```text
Manual
CSV/XLSX
ZIP Bundle
Google Sheets
Google Drive
Яндекс Диск
Integration API
AI producer
        │
        ▼
Preview / validation
        │
        ▼
DRAFT + local media
```

Apply не может незаметно публиковать наружу.

Google Sheets row deletion не означает deletion в Publikator.

Cloud media после import копируется локально.

---

# 13. Security boundaries

Новые ingestion surfaces должны учитывать:

- ZIP traversal / zip bomb;
- SSRF и redirect validation;
- private/metadata IP blocking;
- MIME sniffing;
- upload/download size limits;
- connector credential encryption;
- hashed Integration API keys;
- rich-text AST allowlist;
- XSS-safe preview;
- spreadsheet formula injection protection.

Внешний URL/media connector не может быть произвольным серверным proxy к localhost/internal network.

---

# 14. Backup / restore

Canonical disaster recovery остаётся:

```text
SQLite + media + manifest/checksums -> .tgz
```

Новые vNext entities входят в SQLite и обязаны переживать full backup/restore.

Temporary import/transcode files в backup не входят.

`APP_MASTER_KEY` хранится отдельно.

Каждая schema migration должна иметь restore regression.

---

# 15. Schema evolution

Текущая schema: `3`.

vNext меняется небольшими milestones, а не giant migration:

```text
M1 identity/versioning/revisions
M2 rich text/renditions/templates
M3 rich media/publication units
M4 connectors/API keys/import batches
```

Старые V1 image posts должны мигрировать без потери публикационной истории.

Downgrade binary на более новую DB блокируется.

---

# 16. Модульные границы

Рекомендуемое развитие текущих границ:

```text
src/platforms/*       external API details/capabilities
src/publisher.ts      publication orchestration/recovery
src/scheduler.ts      due-work selection only
src/http/*            HTTP validation/auth
src/db.ts             DB primitives/migrations bootstrap
src/media.ts          image media primitives
src/content/*         vNext domain/revisions/renditions
src/ingestion/*       import/source resolution
src/editorial/*       lifecycle/templates/revisions
src/integrations/*    API keys/connectors
src/backups*          canonical backup/restore
```

Имена новых директорий могут уточняться, но ответственность не должна смешиваться с platform API или scheduler.

---

# 17. Документационный contract

Нормативное vNext ТЗ:

[`VNEXT_TECHNICAL_SPEC.md`](VNEXT_TECHNICAL_SPEC.md)

Продуктовая детализация:

- [`CONTENT_PIPELINE_V2.md`](CONTENT_PIPELINE_V2.md)
- [`CONTENT_EXPERIENCE_V3.md`](CONTENT_EXPERIENCE_V3.md)
- [`EDITORIAL_WORKFLOW_V4.md`](EDITORIAL_WORKFLOW_V4.md)

Current V1 content-plan contract:

- [`CONTENT_PLAN.md`](CONTENT_PLAN.md)

Новая разработка обязана обновлять нормативное ТЗ/ADR при изменении доменных invariants, а не только код.
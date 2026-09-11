# Техническое задание Publikator vNext

Статус: **AUTHORITATIVE / NORMATIVE**

Версия документа: `1.0`

Назначение: этот документ является главным техническим контрактом для разработки vNext. Он сводит и нормализует требования `CONTENT_PIPELINE_V2.md`, `CONTENT_EXPERIENCE_V3.md` и `EDITORIAL_WORKFLOW_V4.md`, устраняет противоречия со старой V1-документацией и задаёт обязательные invariants для людей и coding agents.

---

## 0. Приоритет документации

Если документы противоречат друг другу, применять приоритет:

1. `VNEXT_TECHNICAL_SPEC.md` — нормативное ТЗ vNext.
2. `ARCHITECTURE.md` и `DEVELOPMENT_RULES.md` — архитектурные/инженерные invariants, приведённые к этому ТЗ.
3. `CONTENT_PIPELINE_V2.md`, `CONTENT_EXPERIENCE_V3.md`, `EDITORIAL_WORKFLOW_V4.md` — продуктовые требования и UX-детализация.
4. `CONTENT_PLAN.md`, `PLATFORMS.md`, текущие V1 docs — контракт текущей V1 реализации, пока соответствующий участок не мигрирован во vNext.
5. Исходный код — доказательство текущего поведения, но не основание игнорировать это ТЗ.

Coding agent не имеет права самостоятельно выбирать между противоречащими документами. При конфликте применяется этот порядок.

В этом документе:

- **MUST** — обязательное требование;
- **SHOULD** — требование, отступление возможно только с аргументом в PR;
- **MAY** — допустимое расширение.

---

# 1. Release lanes

## 1.1 V1

Stable V1 выпускается из ветки:

```text
release/1.0
```

Она создана от `v1.0.0-rc.4`.

В `release/1.0` разрешены только:

- live-acceptance fixes;
- security fixes;
- release/documentation fixes;
- минимальные исправления, необходимые для `v1.0.0`.

vNext-функции туда не попадают.

Любой V1 fix SHOULD быть forward-ported в `main`, если применим.

## 1.2 vNext

`main` является основной веткой дальнейшего product-development.

Content Pipeline / Experience / Editorial Workflow реализуются только в `main` через PR и `Publikator CI / Acceptance`.

Нельзя блокировать vNext-разработку ожиданием live acceptance V1, если изменения не затрагивают `release/1.0`.

---

# 2. Архитектурные ограничения

Publikator остаётся **модульным монолитом**:

```text
1 Git repository
1 production Docker container
1 Node.js/Fastify process
1 SQLite/WAL database
1 local media storage
1 embedded scheduler
platform adapters inside same application
```

Без отдельного ADR запрещено добавлять:

- n8n;
- Redis;
- RabbitMQ;
- Kafka;
- отдельный worker-container;
- вторую runtime-БД;
- отдельный scheduler service;
- внешний обязательный converter-service.

Google Sheets, Google Drive, Яндекс Диск и AI являются **connectors/producers**, а не runtime source of truth.

---

# 3. Каноническая доменная модель

vNext MUST развиваться вокруг следующих сущностей.

Accepted ownership/schema-boundary ADR for M0-001: [ADR_CONTENT_DOMAIN_M1.md](ADR_CONTENT_DOMAIN_M1.md).

## 3.1 Project

Содержит:

- `id`;
- `name`;
- `slug`;
- project defaults;
- default timezone;
- default targets;
- default template/policies.

## 3.2 Content / Post

Канонический объект публикации.

Минимальные поля направления:

```text
id
project_id
internal_title
editorial_stage
publication_status
publication_kind
content_format
schedule_mode
scheduled_at_utc
schedule_timezone
content_version
ready_revision_id
source_note
tags
created_at
updated_at
```

## 3.3 ContentRevision

Иммутабельный snapshot значимого контента.

Хранит минимум:

```text
revision_id
post_id
content_version
body_rich_json
body_plain
publication_kind
content_format
schedule snapshot
target selection snapshot
rendition snapshot references
media order snapshot
actor/source
created_at
```

Revision нельзя изменять после создания.

## 3.4 MediaAsset

Физический нормализованный asset.

Общие поля:

```text
id
mime_type
size_bytes
sha256
width
height
duration_ms nullable
poster_asset_id nullable
original_name
relative_path
created_at
```

Один asset MAY использоваться несколькими content objects только после введения явного reference model. До этого importer копирует asset по текущему безопасному подходу.

## 3.5 ContentMedia

Связь post/revision с media:

```text
post_id / revision_id
media_id
sort_order
role
```

Role MAY быть:

```text
primary
carousel_item
story_item
video
poster
```

## 3.6 SocialAccount

Текущая модель сохраняется: platform, display name, encrypted credentials, enabled.

## 3.7 PostTarget

Выбранный social account и aggregate delivery state.

Сохраняются текущие гарантии:

```text
enabled
state
attempts
next_attempt_at
external_id
external_url
last_error
published_at
```

## 3.8 TargetRendition

Platform/account-specific представление поста без полного копирования Post.

Хранит только отличия от canonical content:

```text
target_id
text_rich_json nullable
text_plain nullable
publication_kind override nullable
content_format override nullable
media_plan_json nullable
options_json nullable
```

Если override отсутствует, rendition наследуется из canonical revision.

## 3.9 PublicationUnit

Отдельная внешняя публичная операция внутри target.

Нужна для sequence/multi-post форматов, где один target может породить несколько внешних POST.

Минимум:

```text
id
target_id
unit_index
unit_type
state
attempts
external_id
external_url
last_error
published_at
```

Telegram media group может быть одной unit. Story sequence из 5 отдельных stories — пять units.

## 3.10 Template / Snippet

Шаблоны и reusable fragments.

Изменение template не меняет уже созданные posts. `Create from template` копирует snapshot.

## 3.11 IngestionSource / SourceBinding / ImportBatch

Для внешних источников:

```text
IngestionSource
- id
- type
- name
- connector config/credentials reference

SourceBinding
- source_id
- external_id
- post_id
- source_revision
- imported_content_version

ImportBatch
- id
- source_id
- file/source hash
- status
- summary
- created_at
```

Уникальность source identity:

```text
UNIQUE(source_id, external_id)
```

---

# 4. Две независимые state machines

## 4.1 Editorial stage

```text
IDEA
DRAFT
IN_REVIEW
APPROVED
ARCHIVED
TRASHED
```

Editorial stage отвечает только за редакционную готовность.

## 4.2 Publication status

Канонический vNext lifecycle:

```text
DRAFT
READY
PUBLISHING
PARTIAL
PUBLISHED
FAILED
```

`QUEUE` — это **schedule_mode**, а не новый publication state.

Текущий DB enum `QUEUED` считается legacy/reserved:

- новый vNext код MUST NOT устанавливать `status='QUEUED'`;
- существующие `QUEUED` при миграции нормализуются в `READY` при `schedule_mode='QUEUE'`;
- удаление `QUEUED` из DB CHECK допускается при schema rebuild.

## 4.3 READY

`READY` означает:

- editorial policy выполнена;
- есть минимум один активный target;
- существует immutable ready revision;
- platform preflight прошёл;
- `ready_revision_id` соответствует текущему `content_version`;
- расписание валидно.

Любое значимое изменение будущего READY content MUST:

1. увеличить `content_version`;
2. сбросить `ready_revision_id`;
3. перевести publication status в `DRAFT`;
4. потребовать новый preflight.

## 4.4 Archive / Trash

Для ещё не публиковавшегося content:

- `ARCHIVED` и `TRASHED` находятся в editorial stage;
- publication status MUST стать `DRAFT`;
- scheduler MUST игнорировать такой content;
- schedule metadata можно сохранить для восстановления;
- Restore всегда требует новый preflight.

Если у target уже были реальные publication attempts, audit и target history не удаляются.

Permanent delete через обычный UI разрешён только если:

- ни один target не был опубликован;
- нет `PUBLISHING`/`RECOVERY_NEEDED`;
- отсутствует известный внешний public result;
- выполнено отдельное подтверждение.

Published/PARTIAL history через обычную кнопку Delete не уничтожается; используется Archive.

---

# 5. Content versioning и optimistic concurrency

Каждый Post MUST иметь монотонный `content_version`.

Любая редакционная mutation использует optimistic concurrency:

```text
expectedContentVersion
```

или эквивалент `If-Match`/ETag.

Если версия изменилась другим клиентом:

```text
HTTP 409 CONFLICT
```

UI предлагает reload/compare, но не перезаписывает изменения молча.

Это обязательно для:

- две вкладки браузера;
- Google Sheets sync;
- bot/API update;
- calendar drag;
- bulk actions.

---

# 6. Immutable publication snapshot

Главный concurrency invariant vNext:

> Внешний publisher никогда не читает «живой редактируемый post» после начала publication operation.

Перед READY создаётся immutable `ContentRevision`.

`ready_revision_id` указывает на revision, прошедшую preflight.

Начало публикации MUST атомарно подтвердить:

```text
post status = READY
current content_version = ready revision content_version
editorial_stage active
ready_revision_id exists
```

После успешного claim publisher строит `PublishInput` только из immutable ready revision + target rendition snapshot.

Редактирование working content не может изменить уже захваченную revision.

Atomic target claim текущего V1 сохраняется и расширяется проверкой ready revision/version.

Нельзя:

```text
прочитать current post
потом claim
потом отправить ранее прочитанный mutable content
```

---

# 7. Target / PublicationUnit recovery

Текущий принцип `RECOVERY_NEEDED` сохраняется.

Для multi-unit target:

- каждая публичная операция имеет собственную `PublicationUnit`;
- уже подтверждённые units никогда автоматически не повторяются;
- unknown outcome конкретной unit → unit `RECOVERY_NEEDED`;
- aggregate target получает `RECOVERY_NEEDED` или `PARTIAL` согласно units;
- оператор видит, какие элементы уже опубликованы.

Пример Story Sequence:

```text
1 PUBLISHED
2 PUBLISHED
3 RECOVERY_NEEDED
4 PENDING
5 PENDING
```

Generic retry всей sequence запрещён.

---

# 8. Content kinds и media formats

## 8.1 Publication kind

```text
FEED
SHORT
STORY
```

## 8.2 Content format

```text
TEXT_ONLY
IMAGE
CAROUSEL
VIDEO
VERTICAL_VIDEO
STORY_SEQUENCE
```

Нельзя сохранять V1 invariant «изображение обязательно» как общий vNext invariant.

Новый invariant:

> READY разрешён только если resolved rendition каждого выбранного target соответствует capability данного adapter.

Media обязательно только если его требует выбранный content format/platform capability.

До реализации TEXT_ONLY/video/story adapters текущие image adapters продолжают блокировать несовместимые форматы через capability/preflight.

---

# 9. Capability matrix

Каждый adapter MUST объявлять capability DTO/schema.

Минимум:

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

UI, preflight и publisher используют один источник capability.

Нельзя дублировать platform limits отдельно в frontend и backend.

Capability включается только после:

1. сверки с актуальной официальной API документацией;
2. focused regression tests;
3. live acceptance перед stable capability release.

---

# 10. Rich text

Canonical text MUST храниться как структурированный rich-text document/AST плюс plain fallback.

Raw Telegram MarkdownV2, MAX Markdown или platform HTML не являются source of truth.

Portable marks v1:

```text
bold
italic
underline
strikethrough
inline code
link
quote
bulleted list
numbered list
line break
emoji
```

Для CSV/XLSX/Sheets используется neutral portable syntax:

```text
**bold**
_italic_
~~strike~~
`code`
[link](https://example.org)
> quote
```

Importer:

```text
portable text -> canonical AST -> platform compiler
```

Platform compiler MUST:

- escape platform syntax;
- генерировать supported entities/markup;
- выдавать INFO/WARNING/ERROR downgrade report;
- не исполнять raw HTML от пользователя.

---

# 11. Media pipeline

## 11.1 Images

Текущий Sharp pipeline сохраняется:

```text
decode
EXIF orientation
normalize
metadata
sha256
duplicate detection
local storage
```

## 11.2 Video v1

Первый production-safe video scope MUST быть ограничен и явен.

Для первой версии:

- canonical accepted container: MP4;
- canonical video codec: H.264;
- audio: AAC либо no audio;
- metadata читается через `ffprobe`;
- poster создаётся через `ffmpeg`;
- ffmpeg/ffprobe находятся в том же production container;
- отдельный media-worker service запрещён.

Неподдерживаемый codec/container блокируется понятной ошибкой. Автоматическое transcoding других форматов не добавлять без отдельного ADR/acceptance.

Конфигурация MUST задавать и документировать:

```text
max image bytes
max video bytes
max bundle upload bytes
max expanded bundle bytes
max media files per bundle
processing timeout
temporary disk budget
```

Temp files удаляются при success/failure/restart cleanup.

Platform adapter применяет более строгие собственные limits через capability.

---

# 12. Расписание и timezone

## 12.1 AT

Хранить:

```text
scheduled_at_utc
schedule_timezone (IANA)
```

`scheduled_at_utc` — единственный instant для scheduler.

`schedule_timezone` нужен для UI и редакционного смысла.

Для legacy AT posts, у которых timezone не был сохранён, migration устанавливает явно маркированный fallback (`UTC`/legacy migration value), не пытаясь «угадывать» исходную timezone.

## 12.2 QUEUE

QUEUE остаётся:

```text
schedule_mode=QUEUE
status=READY
```

Точное publish time заранее не гарантируется.

Visual Calendar показывает QUEUE отдельно от точных AT events. Допускается projected/ghost occurrence, но она MUST быть визуально отличима от точного расписания.

## 12.3 Drag & drop

Перетаскивание AT event меняет точный instant.

Перетаскивание QUEUE post в конкретный time slot MUST требовать подтверждение:

```text
Convert QUEUE -> AT ?
```

Нельзя молча менять scheduling semantics.

## 12.4 DST

Server conversion MUST корректно обрабатывать IANA timezone.

- nonexistent local time → validation error;
- ambiguous local time → UI/API требует явный offset/choice;
- в БД сохраняется точный UTC instant.

Per-platform schedule одного canonical post в первом vNext scope **не поддерживается**. Все targets одного post получают одну schedule policy. Отдельное platform scheduling — future ADR.

---

# 13. Visual Calendar и Content Inspector

Visual Calendar является главным пользовательским экраном planning, но не владельцем scheduler logic.

Views:

```text
Month
Week
Day
Agenda
```

Card MUST показывать где применимо:

- thumbnail/poster;
- internal title;
- project;
- exact time или QUEUE marker;
- platform/account badges;
- editorial stage;
- publication status;
- source;
- warnings.

Click открывает Content Inspector.

Inspector MUST позволять по status/policy:

```text
Edit
Duplicate
Send to review
Approve
Mark READY
Publish now
Reschedule
Archive
Move to Trash
Restore
```

Calendar drag/update использует optimistic concurrency и не обходит preflight invalidation.

---

# 14. Templates, defaults, targets

Project defaults MAY задавать:

```text
default targets
default timezone
default schedule mode
default publication kind
default content format
default CTA/signature
default hashtags
default template
default source folder
default approval policy
```

Defaults применяются только при создании нового post.

Изменение defaults не меняет существующие posts.

Target selection в UI MUST быть явным checkbox list конкретных accounts.

Import/API semantics:

- targets переданы явно → заменить defaults для конкретного post;
- targets не переданы → использовать project defaults;
- unsupported target format → disabled/error with reason.

---

# 15. Content Plan schema versioning

## 15.1 V1 schema

Текущий `CONTENT_PLAN.md` schema `1` остаётся current V1 contract.

Существующие endpoints schema 1 не ломать во время vNext foundation.

## 15.2 vNext schema

Промежуточный «Template v2» считается planning draft и **не реализуется как публичный контракт**.

Первый новый публичный contract — **schema version 3**.

Каждая row MUST содержать:

```text
schema_version = 3
external_id
action
project
template_key
internal_title
body
publication_kind
content_format
schedule_mode
scheduled_at
timezone
targets
telegram_body
vk_body
max_body
instagram_body
media
tags
source_note
source_revision
```

`action`:

```text
UPSERT
ARCHIVE
TRASH_REQUEST
```

Отсутствие строки в следующей таблице никогда не означает delete.

## 15.3 Endpoints

V1 legacy endpoints сохраняются.

vNext schema 3 MUST использовать версионированный namespace, например:

```text
GET  /api/content-plan/v3/schema
GET  /api/content-plan/v3/template.xlsx
POST /api/content-plan/v3/import/preview
POST /api/content-plan/v3/import/apply
GET  /api/content-plan/v3/export.xlsx
```

Не подменять существующие V1 endpoints новым поведением без compatibility period.

---

# 16. ZIP Content Bundle

Canonical bulk bundle:

```text
content-bundle.zip
  content.xlsx | content.csv
  media/
    <external_id>__01.jpg
    <external_id>__02.mp4
  manifest.json optional
```

Security MUST выполняться до apply.

Обязательные защиты:

- reject absolute paths;
- reject `..` traversal;
- reject symlink/device entries;
- limit file count;
- limit compressed size;
- limit expanded size;
- limit compression ratio;
- MIME sniffing, не доверять extension;
- normalize filenames;
- temp extraction outside served public paths;
- cleanup on error.

Preview не изменяет canonical DB/media.

Apply создаёт/обновляет только допустимые editable content records и никогда автоматически не публикует.

---

# 17. Google Sheets sync

Google Sheets — external editing/source connector, не master DB.

Template v3 MUST иметь sheets:

```text
Posts
Lists
Instructions
Examples
```

Preview классифицирует rows:

```text
NEW
UPDATE
UNCHANGED
CONFLICT
ARCHIVE_REQUEST
TRASH_REQUEST
ERROR
```

Update автоматически допустим только если:

```text
local content_version == SourceBinding.imported_content_version
```

Иначе `CONFLICT`.

Conflict actions:

```text
Keep Publikator
Use source version
Compare manually
```

Удаление строки из Google Sheets ничего не удаляет.

Optional write-back:

```text
publikator_id
sync_status
editorial_stage
publication_status
scheduled_at_actual
last_synced_at
published_at
external_urls
last_error
```

---

# 18. Cloud media connectors / SSRF security

Google Drive / Яндекс Диск / URL source используются только для ingestion.

После import asset MUST быть скопирован в local canonical media storage.

Runtime publication не зависит от cloud connector availability.

Connector credentials:

- минимальные scopes;
- refresh tokens зашифрованы AES-256-GCM;
- секреты не попадают в frontend/log/events/export.

Для arbitrary URL ingestion:

- HTTPS only by default;
- запрет `file:`, `ftp:`, `data:` и иных protocols;
- DNS resolve до request;
- reject loopback/private/link-local/multicast/reserved/metadata IP ranges;
- redirect count ограничен;
- каждый redirect повторно проходит protocol/DNS/IP validation;
- response size limited streaming, не только `Content-Length`;
- timeout;
- MIME sniffing;
- DNS rebinding protection через проверку фактического destination where feasible.

---

# 19. Integration API v1

Browser cookie auth не используется внешними агентами.

API key:

- генерируется криптографически случайным минимум 256-bit token;
- полное значение показывается один раз;
- в DB хранится только hash + prefix/display metadata;
- key можно revoke/rotate;
- каждый key имеет scopes;
- все calls audit log.

Минимальные scopes:

```text
content:draft:write
content:read
media:write
schedule:write
approval:request
```

`publish:request` — restricted future scope, не выдаётся по умолчанию.

Обязательные HTTP свойства:

- idempotency key для create/batch mutation;
- rate limiting;
- request size limits;
- structured error codes;
- optimistic content version для update;
- pagination;
- OpenAPI contract до объявления API stable.

External API по умолчанию создаёт editable DRAFT, а не READY/PUBLISHED.

---

# 20. Rich content security

Canonical rich AST валидируется schema allowlist.

Запрещено хранить/рендерить произвольный user HTML.

Links:

- allow only supported URL protocols;
- normalize/validate URL;
- preview renderer MUST escape generated HTML;
- platform compiler MUST escape destination syntax.

CSV/XLSX export MUST защищать от spreadsheet formula injection: значения, начинающиеся с формульных control prefixes, экспортируются безопасно как text.

---

# 21. Audit model

Редакционные events отделяются логически от publication events, но MAY находиться в общей event table с typed event_type.

Минимум:

```text
post.created
post.edited
post.rescheduled
post.targets_changed
post.sent_to_review
post.approved
post.ready
post.moved_to_trash
post.restored
post.archived
template.applied
import.previewed
import.applied
sheet.sync_update
sheet.sync_conflict
api_key.created
api_key.revoked
publication.*
recovery.*
```

Audit MUST содержать actor/source и relevant IDs, но не credentials/tokens/full sensitive request bodies.

---

# 22. Backup / restore

Canonical `.tgz` backup остаётся единственным disaster-recovery contract.

Backup включает:

```text
SQLite
canonical media assets
manifest/checksums
```

Новые vNext tables автоматически должны входить через SQLite.

Temporary/transcoding/import staging files не входят.

`APP_MASTER_KEY` по-прежнему не входит и хранится отдельно.

Restore MUST:

- проверять manifest/checksums;
- проверять DB schema compatibility;
- сохранять encrypted connector credentials;
- сохранять API key hashes;
- восстанавливать revisions/templates/source bindings/publication units;
- проходить diagnostics после restart.

Любая новая schema migration MUST иметь backup→migrate→backup→restore regression.

---

# 23. Migration strategy from schema 3

Release line `release/1.0` / `v1.0.0-rc.4` остаётся на schema `3`.

vNext `main` после M0-002 использует schema `4` как первый узкий M1 state/versioning slice:

```text
posts.editorial_stage
posts.content_version
posts.ready_revision_id
content_revisions
```

Остальные M1 ingestion/provenance поля относятся к M0-003 и не должны затягиваться в M0-002.

vNext schema изменения MUST выполняться additive/migratable этапами.

Запрещено делать один giant migration одновременно для Pipeline + Experience + Editorial.

Рекомендуемый порядок schema milestones:

```text
M1 identity/versioning
- ingestion metadata
- editorial_stage
- content_version
- revisions

M2 rendition/editor
- canonical rich text
- target renditions/options
- project defaults/templates

M3 rich media
- publication kind/format
- video metadata
- publication units/story sequence

M4 connectors/API
- API keys
- connector/source bindings
- import batches
```

Каждый migration step:

- idempotent on one schema version transition;
- tested from real previous schema;
- preserves V1 image posts;
- blocks downgrade if DB newer than binary;
- has dedicated regression script in existing CI.

Legacy image posts migration result:

```text
publication_kind = FEED
content_format = IMAGE or CAROUSEL
editorial_stage = APPROVED for READY/PUBLISHED historical content, otherwise DRAFT
content_version = 1
```

Historical published content MUST remain immutable.

---

# 24. UX / visual requirements

Main user-facing navigation SHOULD converge to:

```text
Обзор
Календарь
Контент
Шаблоны
Проекты
Соцсети
Источники / Интеграции
Расписание
Журнал
Резервные копии
Диагностика
```

`Расписание` = technical QUEUE slots.

`Календарь` = visual content planning.

`Журнал` = audit/publication events.

Основной текст:

- light surface → near-black primary;
- dark surface → near-white primary;
- muted remains readable;
- status uses icon/label + color, never color only;
- keyboard focus visible;
- hover is not sole information path.

Semantic CSS tokens mandatory.

---

# 25. Performance targets

Foundation acceptance MUST включать как минимум:

- 500 calendar entries across 60 days;
- 100-post batch import;
- 150+ media assets in one test batch;
- pagination/virtualization for library;
- no full DOM render of thousands of items;
- repeated import creates no duplicates;
- restart preserves canonical state.

Large library count itself не имеет искусственного product limit.

Technical batch/upload limits конфигурируемы и отображаются в diagnostics/config documentation.

---

# 26. CI invariants

Остаётся один workflow:

```text
Publikator CI / Acceptance
```

Новые tests добавляются как scripts/steps в него.

Каждый foundation PR MUST проходить relevant checks:

```text
TypeScript/build
schema migration
HTTP/security
publication concurrency
editorial concurrency
content version/preflight invalidation
bulk import idempotency
ZIP traversal/bomb defenses
SSRF defenses where connector introduced
rich text sanitization/compiler tests
calendar/timezone/DST tests
backup/restore
Docker build identity
```

Feature не считается DONE только потому, что UI её показывает.

---

# 27. Definition of Done для любого этапа

Этап DONE только если одновременно:

1. schema/data model реализованы без обходных legacy fields;
2. API contract реализован и валидируется backend;
3. UI использует тот же backend contract;
4. permissions/security/recovery paths определены;
5. migrations протестированы;
6. backup/restore не потерял новую сущность;
7. diagnostics/audit достаточно для расследования ошибки;
8. regression добавлен в единый Acceptance;
9. documentation обновлена;
10. нет нового обязательного сервиса без ADR.

---

# 28. M0 — обязательный gate перед feature development

До реализации крупных пользовательских функций выполнить шесть convergence tasks.

## M0-001 Domain Model

Зафиксировать schema/ADR сущностей из раздела 3 и их ownership.

## M0-002 State + Concurrency

Реализовать/описать:

- editorial vs publication states;
- content_version;
- immutable ready revision;
- optimistic concurrency;
- atomic publication snapshot claim.

## M0-003 Import contracts

- V1 schema 1 остаётся legacy contract;
- vNext public schema сразу version 3;
- v2 как public format не выпускать;
- batch/source identity semantics.

## M0-004 Security model

Закрыть:

- ZIP safety;
- SSRF;
- API keys;
- connector secrets;
- rich text XSS;
- spreadsheet injection;
- upload/bundle limits.

## M0-005 Time / Rendition / Sequence semantics

Зафиксировать:

- UTC + IANA timezone;
- DST behavior;
- QUEUE/AT conversion;
- TargetRendition;
- PublicationUnit story recovery.

## M0-006 Release / Migration plan

- `release/1.0` frozen from RC4;
- `main` vNext;
- schema milestone order;
- forward-port release fixes.

После M0 feature-development может идти параллельными небольшими PR, но schema ownership и invariants не меняются без ADR.

---

# 29. Рекомендуемый порядок реализации после M0

```text
1. identity/versioning/revisions + safe edit/trash
2. Content Inspector + visual calendar on existing image posts
3. canonical rich text + target compilers
4. Template/Content Plan v3 + ZIP bundle
5. Integration API v1
6. project defaults/templates/target options
7. TargetRendition model
8. video metadata/player pipeline
9. story/short canonical model + PublicationUnit
10. Google Sheets connector
11. Google Drive / Яндекс Диск
12. AI producer/content profile
13. platform-specific video/story/short live adapters
```

Нельзя начинать platform Stories/Shorts adapter до готовности canonical model, capability matrix, player/preview и PublicationUnit recovery.

---

# 30. Явно вне первого vNext scope

До отдельного ADR/acceptance не входят:

- multi-user RBAC сложнее single-admin/editor foundation;
- per-platform independent publish time одного post;
- automatic deletion of external posts;
- arbitrary video transcoding farm;
- distributed workers;
- Google Sheets как master DB;
- direct AI publish bypassing Publikator;
- automatic retry of unknown public outcome.

---

# 31. Финальный пользовательский контракт

После реализации foundation пользователь без знания API должен всегда понимать:

```text
что будет опубликовано
где будет опубликовано
когда будет опубликовано
как это будет выглядеть
кто/что создал или изменил запись
какая версия одобрена
можно ли безопасно изменить её сейчас
как перенести публикацию
как убрать её из будущего плана
как восстановить
что уже реально ушло наружу
что требует ручного recovery
```

Если интерфейс не может однозначно ответить хотя бы на один из этих вопросов, соответствующий этап ещё не считается завершённым.

# Roadmap Publikator

## Статус

Текущая V1 release candidate:

```text
v1.0.0-rc.4
```

Release lane:

```text
release/1.0
```

vNext development lane:

```text
main
```

Главный нормативный документ vNext:

[`VNEXT_TECHNICAL_SPEC.md`](VNEXT_TECHNICAL_SPEC.md)

Этот roadmap определяет порядок реализации, но не переопределяет domain/security invariants ТЗ.

---

# 1. Что уже готово в publication core

## Foundation

- Web UI + REST API;
- projects/posts/social accounts;
- SQLite/WAL;
- AES-256-GCM credentials;
- local media storage;
- Docker deployment;
- Telegram/VK/MAX/Instagram adapters.

## Publication safety

- per-target states;
- platform-specific text override V1;
- manual / AT / QUEUE;
- atomic target claim;
- `RECOVERY_NEEDED`;
- scheduler grace-window;
- retry known failures only;
- recovery audit trail.

## Media V1

- image decode/orientation/normalization;
- metadata/SHA;
- duplicate detection;
- media order;
- platform image limits;
- current preview.

## Portability / operations

- full `.tgz` backup/restore;
- content-plan schema 1 import/export;
- diagnostics;
- release gate;
- event/backup retention;
- immutable baked build SHA;
- single Acceptance CI.

---

# 2. V1 release track

`release/1.0` frozen from RC4.

До stable V1:

1. public HTTPS deployment;
2. live Telegram acceptance;
3. live VK acceptance;
4. live MAX acceptance;
5. live Instagram acceptance;
6. concurrency/scheduler smoke;
7. controlled recovery acceptance;
8. post-live backup/restore;
9. branch/ruleset protection;
10. stable `v1.0.0`.

vNext feature code не попадает в release branch.

---

# 3. vNext product layers

## Layer A — Content Pipeline

Вопрос:

> Как content попадает в Publikator?

Подробности:

[`CONTENT_PIPELINE_V2.md`](CONTENT_PIPELINE_V2.md)

Issue: #26.

Темы:

- source identity;
- bulk CSV/XLSX;
- ZIP bundle;
- Integration API;
- Google Sheets;
- Google Drive;
- Яндекс Диск;
- AI producer.

## Layer B — Content Experience

Вопрос:

> Что это за content и как человек его видит?

Подробности:

[`CONTENT_EXPERIENCE_V3.md`](CONTENT_EXPERIENCE_V3.md)

Issue: #28.

Темы:

- visual calendar;
- Content Inspector;
- content library;
- video/player;
- Shorts/Stories;
- platform preview;
- capability matrix;
- contrast/design system.

## Layer C — Editorial Workflow

Вопрос:

> Как content редактировать, согласовывать, шаблонизировать, переносить и удалять?

Подробности:

[`EDITORIAL_WORKFLOW_V4.md`](EDITORIAL_WORKFLOW_V4.md)

Issue: #30.

Темы:

- editorial lifecycle;
- Trash/Restore;
- revisions;
- rich text;
- platform compilers;
- defaults/targets;
- templates;
- calendar editing;
- Sheets conflict semantics.

---

# 4. CONTENT-M0 — обязательный gate

Status: **ACCEPTED foundation**. Evidence and checkpoint status are tracked in issue #32.

Это не «ещё один дизайн-этап», а фиксация тех contracts, без которых агенты будут реализовывать несовместимые модели.

## M0-001 — Canonical Domain Model

Зафиксировать/реализовать ownership сущностей:

```text
Project
Post
ContentRevision
MediaAsset
ContentMedia
SocialAccount
PostTarget
TargetRendition
PublicationUnit
Template/Snippet
IngestionSource
SourceBinding
ImportBatch
IntegrationApiKey
```

Acceptance:

- domain ADR/schema plan accepted;
- нет дублирующих альтернативных сущностей в разных модулях.

## M0-002 — State + Concurrency Contract

Зафиксировать:

```text
editorial stage
publication status
content_version
ready_revision_id
optimistic concurrency
immutable publication snapshot
```

Decision:

```text
QUEUE = schedule_mode
new vNext code does not emit status=QUEUED
```

Acceptance:

- два concurrent edit не теряют update;
- edit vs publish не публикует stale mutable content;
- READY invalidates after meaningful edit.

Implementation scope: schema `4` is the state/versioning slice only. Ingestion/source identity stays in M0-003 instead of being mixed into this checkpoint.

## M0-003 — Import Contract Versioning

Decision:

```text
schema 1 = V1
schema 2 = never public
schema 3 = vNext
```

Acceptance:

- legacy schema 1 tests still pass;
- versioned v3 namespace/spec defined;
- external/source identity idempotency defined.

## M0-004 — Ingestion Security

Зафиксировать и тестировать:

- ZIP safety;
- SSRF;
- upload/download/bundle limits;
- API key storage/scopes/rate-limit;
- connector secret encryption;
- rich-text XSS protections;
- spreadsheet formula injection.

## M0-005 — Time / Rendition / Sequence semantics

Зафиксировать:

- UTC instant + IANA timezone;
- DST behavior;
- QUEUE↔AT conversion;
- TargetRendition inheritance;
- PublicationUnit recovery for Stories sequence.

## M0-006 — Release / Migration Strategy

Готово организационно:

```text
release/1.0 from v1.0.0-rc.4
main for vNext
```

Schema milestone migrations и forward-port process определены в [`RELEASE_MIGRATION_POLICY.md`](RELEASE_MIGRATION_POLICY.md) и [`src/schema.ts`](../src/schema.ts); повторно проектировать этот foundation не требуется.

---

# 5. Фактический schema foundation после M0

Источник версии и migration/backup regressions — [`SCHEMA_MILESTONES`](../src/schema.ts). Для проверенного ниже снимка `main` SQLite-схема равна **12**:

```text
3  V1 baseline / release/1.0
4  content versioning + immutable revisions
5  ingestion provenance/source identity
6  ingestion security state
7  UTC/IANA schedule + TargetRendition + PublicationUnit
8  rich-media model
9  revision-history
10 canonical-rich-text
11 project-defaults
12 templates
```

Это SQLite milestones, а не версии XLSX/CSV-контракта и не версия пакета. Новые feature PR не должны повторно создавать эти primitives. Следующая schema version появляется только при новом coherent data invariant и обязана следовать `docs/RELEASE_MIGRATION_POLICY.md` + `SCHEMA_MILESTONES`.

---

# 6. Текущее состояние и оставшийся порядок разработки

Снимок исходников проверен **01.10.2026** на `main` `f89f43d0be8d8e0ea37cfd0a3d24b3ed8f846e16`. Это не подтверждение версии установленного контейнера, не live acceptance и не объявление всех требований vNext завершёнными. Перед новой задачей сверять fresh `main` и относящийся к ней код, а не переносить этот SHA как постоянный expected HEAD.

## Что уже существует — не реализовывать заново

| Область | Реализованный объём и точка входа | Что этим не закрывается |
|---|---|---|
| CONTENT-M0 / EW4-001…004 | Versioning, lifecycle, revision history, canonical rich text и platform compilers: `src/content-versioning.ts`, `src/editorial-lifecycle.ts`, `src/revision-history.ts`, `src/rich-text.ts`, `src/platform-text.ts` | Итоговая product/live acceptance |
| EW4-005 | Project timezone и default targets: `src/project-defaults-migration.ts`, `src/http/routes.ts`; regression `scripts/ew4-005a1-project-timezone-e2e.mjs` | Полная parity всех project policies/platform options; название A1-теста не означает, что default targets отсутствуют |
| EW4-006 | Шаблоны, повторно используемые блоки, создание поста из шаблона: `src/templates.ts`, `src/http/templates.ts`; regression `scripts/ew4-006-templates-e2e.mjs`; schema 12 | Любые ещё не сопоставленные требования полного template UX |
| EW4-007 | Calendar projection и редактирование через canonical post API: `src/http/calendar.ts`, `public/calendar-v3.js`; regression `scripts/ew4-007-calendar-editing-e2e.mjs` проверяет перенос AT, конфликт версии, READY invalidation, QUEUE→AT confirmation и создание из точного слота | Полный bulk/context-menu/UX scope из ТЗ и незамерженного PR #113 |
| EW4-008 / Content Plan v3 | CSV/XLSX v3, source identity и editorial contract: `src/content-plan-v3.ts`, `src/content-plan-v3-template.ts`; regression `scripts/content-plan-v3-e2e.mjs` | ZIP bundle, embedded images/IMAGE(), cloud video и вся mass acceptance |
| EW4-009 / CP2-004 | Действующий HTTP API черновиков, read/update/request-review, keys/scopes/rate limit и idempotent create: `src/http/integration-api.ts`, `src/integration-security.ts`; regression `scripts/ew4-009-integration-api-e2e.mjs` | Multipart media и batch preview/apply всего целевого Integration API; наличие `openapi.json` не доказывает полноту контракта |
| Sheets / cloud media | Sheets polling, Auto Apply, trusted Auto Ready, result write-back, image ingest из Drive/Яндекс: `src/google-sheets*.ts`, `src/google-drive-media.ts`, `src/yandex-disk-media.ts` | Cloud video, все сценарии управления источниками и разрешения конфликтов |
| CX3 / frontend | Calendar/library/preview/media viewer и существующая ownership consolidation: `public/`; browser harness `scripts/browser-operator-acceptance-e2e.mjs` | Удаление файлов с `v04/v05/v3/v4/v5` по одному имени: многие остаются подключёнными runtime-модулями |
| VK repairs | USER OAuth, PERSONAL/COMMUNITY destinations, ограниченное хранение COMMUNITY/PENDING keys: `src/http/vk-oauth.ts`, `src/http/routes.ts`, `src/platforms/vk.ts`, `src/platforms/connection-test.ts` | Real VK live acceptance; сохранённый ключ не равен разрешению публикации |

Реализации FEED/VIDEO, Telegram Story/Sequence и Instagram Short/Reel не включают production capability автоматически: действуют соответствующие capability/live-evidence gates. Не ослаблять их ради зелёной UI-кнопки.

Идентификаторы `CP2-007A…D` и `CP2-008A` в merged Google Sheets lane **не означают**, что исходные milestones CP2-007 AI producer и CP2-008 Advanced ingest завершены. Их исходные требования сохраняются в issue #26.

Исторические чек-листы issues #26/#30 содержат более ранние снимки: например, утверждения «EW4-006 не начат» и «Integration API — только security foundation» больше не описывают этот `main`. При reconciliation обновлять фактический объём и evidence, не отмечать весь milestone DONE только по существованию файла. Этот документ не закрывает issues и не принимает PR #113.

## Ближайший порядок оптимизации

1. Согласовать текущие инструкции и фактический объём; после принятия документационного PR отдельно обновить tracking issues. Не создавать новый параллельный roadmap/state framework.
2. Выполнить read-only salvage review PR #113: отделить уникальные нужные изменения от уже реализованных. Не merge всего PR и не удалять его ветку без проверки сохранности. Старые ветки оценивать по содержимому и merge history, не по имени или одному ahead/behind.
3. Небольшим отдельным срезом закрепить защиту `main`/`release/1.0` и required Acceptance; не менять release lanes. Факт настройки проверять в GitHub, а не считать выполненным по этому пункту.
4. Перед frontend/code/CI оптимизацией зафиксировать измерения: длительности jobs/steps и нестабильность тестов; загрузку реально используемых страниц; ownership/import/call graph выбранного модуля. Затем один bounded PR с сохранением regression coverage. Большой файл или число шагов сами по себе не доказывают bottleneck.

## Оставшиеся продуктовые требования

После согласованного maintenance-среза выбирать отдельный checkpoint, а не выполнять весь список в одном PR:

1. Residual EW4-005/006/007: сопоставить полные требования defaults/options/templates/calendar с существующим кодом и перенести только доказанные пробелы.
2. **CP2-003 ZIP Content Bundle** — детерминированная media binding и acceptance на 100 posts / 150 media.
3. **CP2-004 + EW4-009** — завершить отсутствующие media/batch части Integration API, переиспользуя существующий HTTP/editorial/security contract.
4. **CP2-006** — cloud video ingest и оставшийся browser-proven UX управления connectors.
5. **CP2-007 AI Content Profile / producer** — AI создаёт DRAFT через Integration API; прямой AI→social bypass запрещён.
6. **CP2-008 Advanced ingest** — embedded images в XLSX, Google Sheets `IMAGE()` и ограниченные advanced-source сценарии.
7. **EW4-010 + Pipeline mass acceptance + live capability enablement** — итоговая product acceptance после закрытия относящихся к ней контрактов.

V1 live acceptance ведётся отдельно в issue #12 и ветке `release/1.0`. Ожидание V1 live acceptance само по себе не блокирует независимую vNext-разработку согласно `VNEXT_TECHNICAL_SPEC.md`.

---

# 7. Visual Calendar contract

Calendar ownership находится в Content Experience, не Pipeline.

Pipeline лишь поставляет canonical data.

Calendar MUST поддерживать:

```text
Month
Week
Day
Agenda
```

Card:

- thumbnail/poster;
- title/project;
- time or QUEUE marker;
- targets;
- editorial/publication state;
- source;
- warnings.

Click -> Inspector.

Drag AT -> new AT instant.

Drag QUEUE into exact time -> explicit confirmation QUEUE→AT.

---

# 8. Content Plan contract

Current V1:

```text
CONTENT_PLAN.md schema 1
```

vNext:

```text
schema 3
/api/content-plan/v3/...
```

Schema 2 не реализовывать как public contract.

Bulk acceptance:

- 100 posts;
- 150+ media assets;
- preview;
- idempotent apply;
- repeated import no duplicates;
- conflicts detected, not overwritten.

---

# 9. Rich media contract

Initial video scope intentionally narrow:

```text
MP4
H.264
AAC or no audio
```

Unsupported input -> clear validation error.

No transcoding farm.

Story sequence uses per-public-operation PublicationUnit states.

Platform Stories/Shorts adapters are last, not first.

---

# 10. Integration / AI contract

Integration API default:

```text
create/read/update DRAFT
upload media
schedule request
approval request
```

Это целевой product contract; реализованный HTTP-поднабор и оставшиеся media/batch задачи перечислены в разделе 6.

Direct publish permission absent by default.

AI is a producer:

```text
sources
→ generate text/media
→ Integration API
→ DRAFT
→ review
→ READY
```

No direct AI→social network bypass.

---

# 11. Acceptance gates by category

## Domain

- migration from previous schema;
- optimistic concurrency;
- immutable revision publish.

## Ingestion

- duplicate prevention;
- conflict detection;
- ZIP traversal/bomb tests;
- SSRF tests.

## Editorial

- edit READY invalidates preflight;
- Trash removes from scheduler/calendar active set;
- Restore requires new preflight;
- revision restore works for unpublished content.

## Rich text

- canonical AST validation;
- platform downgrade warnings;
- no raw HTML XSS.

## Calendar

- 500 entries / 60 days;
- timezone/DST;
- no duplicate scheduling logic.

## Rich media

- video metadata/poster;
- processing limits;
- story sequence partial/recovery semantics.

## Operations

- diagnostics;
- backup/restore;
- Docker identity;
- one Acceptance workflow.

---

# 12. Definition of Done

Этап не считается DONE, пока нет одновременно:

1. backend model/API;
2. migration;
3. UI using same contract;
4. security/recovery handling;
5. audit/diagnostics;
6. backup/restore proof;
7. focused automated regression;
8. full `Publikator CI / Acceptance = PASS`;
9. updated documentation.

---

# 13. Не делать раньше времени

Отложено до отдельной необходимости/ADR:

- complex multi-user RBAC;
- per-platform different publish time одного post;
- arbitrary external post delete automation;
- distributed workers;
- transcoding farm;
- Google Sheets as database;
- unrestricted autopilot direct publish;
- analytics, если platform API не даёт устойчивый contract.

---

# 14. Целевой пользовательский поток

```text
Manual / XLSX / ZIP / Sheets / API / AI
                  ↓
                Inbox
                  ↓
            Draft / Template
                  ↓
       Edit text + image/video
                  ↓
        Select target accounts
                  ↓
       Platform-aware preview
                  ↓
          Review / Approve
                  ↓
                READY
                  ↓
        Calendar / Queue / Now
                  ↓
              Publish
                  ↓
        Journal / Recovery
```

Пользователь в любой момент должен понимать:

1. что выйдет;
2. где;
3. когда;
4. в каком формате;
5. какая версия одобрена;
6. можно ли её изменить;
7. кто/что изменил её последним;
8. как перенести/дублировать/архивировать/удалить будущую публикацию;
9. что уже реально опубликовано;
10. где требуется recovery.
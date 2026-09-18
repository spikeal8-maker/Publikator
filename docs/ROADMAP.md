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

Дополнительно определить schema milestone migrations и forward-port process.

---

# 5. Фактический schema foundation после M0

Publikator уже прошёл маленькие additive milestones вместо giant migration:

```text
3  V1 baseline / release/1.0
4  content versioning + immutable revisions
5  ingestion provenance/source identity
6  ingestion security state
7  UTC/IANA schedule + TargetRendition + PublicationUnit
```

Новые feature PR не должны повторно создавать эти primitives. Следующая schema version появляется только при новом coherent data invariant и обязана следовать `docs/RELEASE_MIGRATION_POLICY.md` + `SCHEMA_MILESTONES`.

---

# 6. Current implementation status and remaining order

Reconciled: **2026-09-18**, after merge of PR #88.

The following foundation/product work is already implemented and MUST NOT be recreated as a new parallel layer:

- CONTENT-M0 / schemas 4–7;
- EW4-001 safe lifecycle + Content Inspector;
- CX3-001…CX3-014 visual/calendar/library/rich-media/operator foundations;
- schema 8 rich-media model;
- FEED/VIDEO adapter implementations for Telegram/VK/MAX/Instagram, still live-gated;
- Telegram Story image/video/sequence implementation, still live-gated;
- Instagram Short/Reel implementation, still live-gated;
- Google Sheets connector and automation lane #72/#79–#85;
- Google Drive and Yandex Disk image binding;
- real browser operator acceptance added by #86;
- frontend Sources consolidation started by #87/#88.

Checkpoint names `CP2-007A…D` and `CP2-008A` used by the merged Google Sheets lane do **not** mean the original CP2-007 AI producer or CP2-008 Advanced ingest milestones are complete. Issue #26 is authoritative for that reconciliation.

## Remaining recommended order

1. **Frontend consolidation** — remove remaining post-render/MutationObserver ownership where a route/component can own its markup directly. Do not introduce another `ui-vN-polish` layer. Preserve the real browser gate.
2. **EW4-002 Revision history UX** — view/diff/restore immutable revisions for unpublished content.
3. **EW4-003 Canonical rich text editor** — structured AST + plain fallback.
4. **EW4-004 Platform compilers** — Telegram/MAX/VK/Instagram compilation + downgrade diagnostics.
5. **EW4-005/006 Defaults + Templates/Snippets** — project defaults and snapshot semantics.
6. **EW4-007 Calendar editing** — drag/drop, create-from-slot, quick edit and optimistic-conflict handling.
7. **CP2-003 ZIP Content Bundle** — deterministic media binding and 100-post/150-media acceptance.
8. **CP2-004 + EW4-009 Integration API v1** — complete product contract on the existing hashed/scoped API-key security foundation.
9. **CP2-006 completion** — cloud video ingestion and browser-proven connector management UI.
10. **CP2-007 AI Content Profile / producer** — AI produces DRAFT through the Integration API; no direct social bypass.
11. **CP2-008 Advanced ingest** — embedded XLSX images / Google Sheets `IMAGE()` and explicitly bounded advanced source behavior.
12. **EW4-010 + Pipeline mass acceptance + live capability enablement** — close the remaining product acceptance only after the above contracts are complete.

V1 release acceptance remains a separate track in issue #12 and `release/1.0`; it does not redefine the vNext implementation order.

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
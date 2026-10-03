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
8  rich-media model
9  revision-history — EW4-002 accepted/merged
10 canonical-rich-text — EW4-003 accepted/merged
11 project-defaults — EW4-005 accepted/merged
12 templates / reusable content blocks — EW4-006 accepted/merged (#107/#108)
13 social-credential-capability-profile — planned CRED-01A
```

Новые feature PR не должны повторно создавать эти primitives. Следующая schema version появляется только при новом coherent data invariant и обязана следовать `docs/RELEASE_MIGRATION_POLICY.md` + `SCHEMA_MILESTONES`.

---

# 6. Текущее состояние и оставшийся порядок разработки

Сверено: **03.10.2026**. Credential readiness contract принят через PR #141; executable tracking — #142–#145 ниже. Перед каждым implementation checkpoint обязателен fresh guard текущего `main`, поэтому exact main SHA намеренно не фиксируется в roadmap.

Актуальное состояние social credential lane:

- KEY-02 merged: VK validity отделена от method capability; PENDING/COMMUNITY credentials сохраняются безопасно;
- существующий VK WALL publisher имеет system-path proof candidate PR #139, но live VK publication ещё не является доказанной;
- PR #138 с alternate VK album transport является superseded experiment и не должен влиять на CRED architecture;
- PR #139 — test-only доказательство существующего WALL publisher; держать HOLD до convergence с credential lane;
- нормативный foundation: `SOCIAL_CREDENTIAL_CAPABILITY_CONTRACT.md`;
- schema 13 persistence + Save-and-check + visible access-level UX являются первым executable credential lane;
- server-authoritative updates и READY destination/profile binding идут отдельными следующими checkpoints.

Предыдущие content/editorial foundation milestones остаются действующими; social credential foundation не отменяет их, но имеет приоритет для publisher/platform work.

## Оставшийся рекомендуемый порядок

Parent tracking: **#142 CRED-01**.

1. **#143 CRED-01A Schema 13 + CapabilityProfile persistence** — ACTIVE FIRST; credential_version, safe profile table, migration 12→13, backup/restore regression; no provider network during migration.
2. **#144 CRED-01B Save-and-check + Recheck server flow** — BLOCKED by #143; persist first, inspect second, provider denial becomes profile state rather than lost credential.
3. **#145 CRED-01C Visible Socials UX** — BLOCKED by #144; ПОЛНОЦЕННЫЙ/ОГРАНИЧЕННЫЙ/НЕДЕЙСТВИТЕЛЬНЫЙ/НЕ ПРОВЕРЕН, per-format matrix, exact remediation.
4. **CRED-02 Server authority convergence** — legacy POST/PATCH/activate cannot bypass verification; valid-but-limited remains usable only for READY formats.
5. **CRED-03 READY capability binding** — capability-aware preflight + immutable destination/credential_version/profile_fingerprint binding.
6. **CRED-04 VK exact diagnostics** — USER/GROUP/SERVICE evidence, account.getAppPermissions for USER, groups.getTokenPermissions for GROUP, exact method-token matrix.
7. **CRED-05 Telegram/MAX/Instagram granular diagnostics**.
8. **CRED-06 Controlled live acceptance** — real public-write evidence on exact build without secrets.
9. Далее продолжить remaining content/editorial roadmap.

Правило порядка: новые alternate platform transports, Stories/Shorts и расширение publisher methods не должны опережать credential capability foundation, если их необходимость определяется правами/типом конкретного credential.


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

## Social credentials

- valid != capability != destination != readiness;
- provider credential type/role determined or explicitly UNKNOWN;
- provider-declared permissions preserved where available;
- method states individually CONFIRMED/DENIED/UNAVAILABLE/NOT_CHECKED/NOT_SUPPORTED/REQUIRES_SETUP/NOT_IMPLEMENTED;
- direct API cannot self-assert verified/active connection;
- saved secret not returned to browser/log/events;
- READY destination/credential mutation cannot redirect an approved post;
- VK credential type is diagnosed correctly; GROUP/COMMUNITY remains valid-but-limited where USER-only methods are required; USER permission evidence and method readiness are shown;
- cross-platform per-format readiness rendered by the same backend contract.

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
9. updated documentation;
10. for social/platform work: credential CapabilityProfile and server-side activation invariants pass;
11. READY publication intent remains bound to approved destination/credential semantics.

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
   Verify credentials/capabilities
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
10. где требуется recovery;
11. какие credentials подключены и какого они типа/роли;
12. какие permissions/method capabilities реально подтверждены;
13. какие publication formats READY для конкретного destination;
14. чего не хватает и как получить нужный credential/право.
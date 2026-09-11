# ADR — Canonical Content Domain and M1 schema boundary

Status: **ACCEPTED for CONTENT-M0 / M0-001**

This ADR narrows `VNEXT_TECHNICAL_SPEC.md` into one ownership model for implementation. It does not perform the M1 SQLite migration; it defines what M0-002/M1 must persist.

## Decision

There is one canonical content model. No feature may introduce parallel `post`, `draft`, `story`, `campaign post`, or platform-post tables as alternative sources of truth.

Canonical entities:

```text
Post
ContentRevision
MediaAsset
ContentMedia
PostTarget
TargetRendition
PublicationUnit
Template
IngestionSource
SourceBinding
ImportBatch
IntegrationApiKey
```

`Post` remains the aggregate root for one editorial publication intent. Platform differences are renditions/targets, not cloned posts.
## Ownership boundaries

| Entity | Domain owner | Persistence/runtime owner |
|---|---|---|
| `Post` | content domain | SQLite + application services |
| `ContentRevision` | content domain | SQLite; immutable once created |
| `MediaAsset` | media domain | `src/media.ts` + SQLite metadata |
| `ContentMedia` | content/media relation | SQLite relation; ordered roles |
| `PostTarget` | publication domain | publisher orchestration + SQLite |
| `TargetRendition` | publication/content boundary | SQLite; target-specific overrides only |
| `PublicationUnit` | publication domain | publisher recovery + SQLite |
| `Template` / snippets | editorial content domain | SQLite |
| `IngestionSource` | ingestion domain | connector config + encrypted secrets refs |
| `SourceBinding` | ingestion domain | SQLite identity/idempotency relation |
| `ImportBatch` | ingestion domain | SQLite audit/batch state |
| `IntegrationApiKey` | integration security domain | hash/scopes/revoke metadata in SQLite |

Platform adapters own only external API translation and capability/error semantics. They must not own canonical content state.

HTTP routes own validation/transport only. They must not create alternate domain records that bypass the canonical services.

## M1 schema milestone

M1 is **identity/versioning foundation only**. It must not pull M2/M3/M4 features forward.
M1 persistence must add or establish:

```text
posts.editorial_stage
posts.content_version
posts.ready_revision_id

content_revisions
- id
- post_id
- content_version
- body snapshot
- schedule snapshot
- target snapshot
- media order snapshot
- actor/source
- created_at

lightweight provenance on current post/import path
- source_type
- source_ref
- source_revision
- source_batch_id
- imported_at
```

`IngestionSource`, normalized `SourceBinding`, `ImportBatch` tables and `IntegrationApiKey` persistence are canonical entities, but their normalized M4 persistence must not be implemented inside M1 unless a later accepted ADR explicitly moves them.

This keeps schema evolution additive and avoids one giant Pipeline/Experience/Editorial migration.
## Legacy V1 image-post mapping

Migration from current schema 3 is deterministic.

For every legacy post:

```text
publication_kind = FEED
content_version   = 1
```

Media mapping:

```text
0 or 1 image  -> content_format = IMAGE
2+ images     -> content_format = CAROUSEL
```

A zero-media V1 draft maps to `IMAGE`, not `TEXT_ONLY`: in V1, missing media means an incomplete image-post draft, not explicit text-only intent.

Editorial mapping follows the authoritative vNext spec exactly:

```text
READY      -> APPROVED
PUBLISHED  -> APPROVED
all other legacy statuses -> DRAFT
```

Publication history remains authoritative separately. `PARTIAL`, `PUBLISHING`, `FAILED` and any recovery state are not made editable merely because editorial stage maps to `DRAFT`; publication-state immutability/recovery rules still apply.
Legacy media rows map to `MediaAsset` metadata plus ordered `ContentMedia` links without changing file bytes during M1. Existing `media.sort_order` becomes `ContentMedia.sort_order` when that relation is introduced.

M1 must preserve current target rows and publication evidence. It does not create `TargetRendition` or `PublicationUnit` rows yet; those arrive in their later schema milestones.

## Code contract in M0-001

`src/domain/content-domain.ts` is the first shared domain contract. It contains canonical entity names, content/editorial enums and the deterministic legacy projection used by future migration code/tests.

No SQLite table is changed in M0-001.

Future schema code must import/reuse this contract rather than reimplementing legacy mapping in an unrelated migration module.

## Rejected alternatives

- Separate canonical Story/Short/Post tables — rejected; they are content kinds of one `Post` model.
- Per-platform cloned posts — rejected; use `PostTarget` + `TargetRendition`.
- Implement all M1–M4 tables in one migration — rejected; violates milestone migration strategy.
- Infer zero-media V1 drafts as `TEXT_ONLY` — rejected; V1 had no explicit text-only intent.

## Acceptance

M0-001 is complete when:

1. ownership above is the accepted implementation boundary;
2. legacy projection is executable and regression-tested;
3. current V1 schema/runtime behavior is unchanged;
4. `Publikator CI / Acceptance` passes.

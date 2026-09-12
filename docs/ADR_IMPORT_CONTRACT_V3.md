# ADR: Content Plan v3 import identity and conflict contract

Status: ACCEPTED for CONTENT-M0 / M0-003.

Authoritative parent: `docs/VNEXT_TECHNICAL_SPEC.md`.

## Scope

This ADR defines only import contract versioning, source identity, idempotency and conflict detection.
It does not implement ZIP/cloud media, connectors, rich text, video, Stories or API-key authentication.

M0-003 foundation intentionally accepts only:

```text
publication_kind = FEED
content_format   = IMAGE
timezone         = UTC
```

`CAROUSEL`, media resolution and richer formats are deferred until their persistence exists.

## Version policy

- Content Plan schema 1 remains the V1 compatibility contract.
- Schema 2 is never a public format.
- Schema 3 is the first public vNext content-plan contract.
- V1 endpoints remain unchanged.
- vNext endpoints live only under `/api/content-plan/v3/...`.
## Source identity

Every v3 import is executed for a stable `sourceId` supplied by the caller.
A row has a mandatory `external_id` supplied by that source.
The canonical semantic identity is:

```text
(sourceId, external_id)
```

The current lightweight persistence stores this pair deterministically in `posts.source_ref` while `source_type='content-plan-v3'`.
Normalized `IngestionSource` and `SourceBinding` tables remain deferred to their later schema milestone; this is not a second domain model.

## Payload hash and revision semantics

`source_revision` is an opaque source-owned token. Publikator compares it for equality and never infers ordering from it.
`source_payload_hash` is SHA-256 of the normalized meaningful schema-3 payload, excluding source identity and `source_revision`.

The normalized hash includes action, canonical project/content, schedule, selected account IDs and platform override values.
Target ordering does not change the hash.

Rules:

- same payload hash -> `UNCHANGED`, even if the source advances its revision token;
- same `source_revision` + different payload hash -> `ERROR` (`source_revision` was reused incorrectly);
- changed payload + local content unchanged -> update/request may proceed;
- changed payload + local content changed since last import -> `CONFLICT`.
## Local conflict semantics

`imported_content_version` stores the local `posts.content_version` produced by the last successful content-changing import.
If `content_version != imported_content_version`, local content has diverged and a changed source payload becomes `CONFLICT`.
A conflict is never overwritten automatically.

`ARCHIVE` / `TRASH_REQUEST` use the same rules. Preview rejects mutations that `commitContentEdit` cannot apply, so `canApply=true` must not become a predictable immutable-status failure during apply.

## Target resolution and overrides

A target with `accountId` resolves only that exact enabled account. Optional platform/name fields must match it.
Without `accountId`, `platform + name` must resolve to exactly one enabled account; 0 or 2+ matches are errors.

`telegram_body`, `vk_body`, `max_body`, `instagram_body` are platform-level overrides in this foundation and apply to every selected account of that platform.
Per-account divergent renditions remain a later `TargetRendition` feature.

## Idempotency

Repeating an already applied semantic payload for the same `(sourceId, external_id)` MUST NOT create another Post or increment `content_version`.
The database enforces one lightweight source binding per semantic identity.
A later normalized `SourceBinding` migration MUST preserve the same uniqueness.

## Apply safety

Preview and apply parse the same schema-3 contract.
Apply revalidates uploaded bytes and source identity under exclusive runtime maintenance.
Apply requires the SHA-256 returned by preview, so changed input cannot be silently applied.
All applied rows become canonical Publikator state; the source table is never a runtime database.
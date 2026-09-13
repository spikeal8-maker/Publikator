# ADR — M0-005 Time / Rendition / Sequence semantics

Status: ACCEPTED for vNext foundation.

Authoritative parent: `docs/VNEXT_TECHNICAL_SPEC.md`.

## Decision 1 — schedule identity

An `AT` post has one canonical publish instant:

```text
scheduled_at_utc
schedule_timezone (IANA)
```

`scheduled_at_utc` is the only value used by the scheduler.
`schedule_timezone` preserves the editorial/UI meaning of the local time.

The legacy `scheduled_at` column remains temporarily for compatibility and mirrors the canonical UTC instant.
Legacy AT rows without a stored timezone are migrated with explicit fallback `UTC`; original timezone is never guessed.
## Decision 2 — local time and DST

Local editor/import input is resolved server-side against an IANA timezone.

- nonexistent local time during a DST forward jump is invalid;
- ambiguous local time during a DST fallback is invalid unless an explicit offset/choice is supplied;
- explicit RFC3339 `Z`/offset is accepted as an exact instant;
- storage is always normalized to UTC.

No per-platform independent publish time exists in the first vNext scope.

## Decision 3 — QUEUE to AT

`QUEUE` is scheduling semantics, not merely a missing timestamp.
Changing a QUEUE post to an exact AT time requires an explicit confirmation flag.
Calendar drag-and-drop must use the same backend rule and may not silently convert the mode.
## Decision 4 — TargetRendition

`TargetRendition` stores only target-specific differences from the immutable canonical revision.
Nullable fields mean inheritance, not an empty replacement:

```text
text_rich_json
text_plain
publication_kind
content_format
media_plan_json
options_json
```

The resolved publish view is canonical revision plus explicit target overrides.
A target rendition never becomes a second full copy of `Post`.

Changing a TargetRendition is a meaningful content edit: it MUST use optimistic `content_version`, invalidates an existing READY snapshot, and the resolved override data is included in the immutable revision target snapshot.

## Decision 5 — PublicationUnit

A `PublicationUnit` represents one externally visible operation inside one target/revision plan.
The unit plan is immutable once created for `(target_id, revision_id)`.
A Story Sequence with five external Story calls has five ordered units.
Unit states are:

```text
PENDING | PUBLISHING | PUBLISHED | RETRY | FAILED | RECOVERY_NEEDED
```

Unknown external outcome is never automatically retried. It becomes `RECOVERY_NEEDED` and blocks later units until operator resolution.
Already `PUBLISHED` units are immutable and are never reset by sequence retry/recovery.
After confirmed-not-published recovery the same unit becomes `RETRY`; only that unit is retried.
A known `FAILED` unit also blocks every later unit until an explicit unit-level retry; ordered sequences may never skip a failed earlier operation.

Aggregate target state may be `PARTIAL` when at least one unit is published while later units remain incomplete.
Any unresolved unit recovery makes the aggregate target `RECOVERY_NEEDED`.

## Scope boundary

M0-005 does not implement platform Story/Short adapters or the visual calendar.
Future adapters and calendar mutations must reuse this foundation rather than create parallel time/recovery semantics.

# ADR: Rich Media ownership in schema 8

Status: **ACCEPTED by CX3-003 implementation**

Parent contracts: `VNEXT_TECHNICAL_SPEC.md`, `CONTENT_EXPERIENCE_V3.md`, `ADR_CONTENT_DOMAIN_M1.md`.

## Decision

Schema 8 completes the authoring-side rich-media model without changing delivery semantics.

- `posts.publication_kind` and `posts.content_format` remain the canonical format selectors introduced in schema 7.
- `media` remains the physical `MediaAsset` table and gains nullable video metadata: duration, fps, video/audio codec, container and poster asset reference.
- `content_media` is the canonical authoring relation between a Post and its media assets. It stores order, role and optional preview duration.
- `content_revisions.content_media_json` snapshots the authoring relation at revision creation time.
- `publication_units` remain delivery/recovery records only. They never become the source of truth for Story Sequence authoring.

## ContentMedia roles

Allowed roles are:

```text
primary
carousel_item
story_item
video
poster
```

A Story Sequence is represented as `publication_kind=STORY`, `content_format=STORY_SEQUENCE` plus ordered `content_media(role=story_item)` rows.

## Video metadata

A video asset may store:

```text
duration_ms
fps
video_codec
audio_codec
container
poster_asset_id
```

`poster_asset_id`, when present, must reference an image asset belonging to the same Post. This milestone stores metadata only; probing/transcoding/upload UX belongs to later checkpoints.

## Compatibility

Existing `media.sort_order` remains as a compatibility field for the current image editor/publisher. Schema-8 triggers keep the new authoring relation synchronized with existing image insert/order/format mutations.

Existing schema-7 image posts are backfilled as:

- `IMAGE` -> `primary`;
- `CAROUSEL` -> `carousel_item`;
- `VIDEO` / `VERTICAL_VIDEO` -> `video`;
- `STORY_SEQUENCE` -> `story_item`.

Historical revisions are normalized into `content_media_json` from their immutable `media_json`; they are not rebuilt from mutable current Post state.

## Versioning

Changes to video metadata, media role/order, Story Sequence order or preview duration are meaningful content edits and MUST use optimistic `content_version` semantics. They invalidate READY through the existing `commitContentEdit()` contract.

## Out of scope

CX3-003 does not enable platform video/story publication, media transcoding, video upload UI, story player, capability checks or platform previews. Those remain CX3-004+ work.
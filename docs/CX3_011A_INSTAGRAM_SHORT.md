# CX3-011A — Instagram SHORT / VERTICAL_VIDEO via Reel

Status: implementation checkpoint. Production capability remains disabled until separate live acceptance.

## Goal

Add a real adapter path for canonical `SHORT / VERTICAL_VIDEO` without creating another publication model. Instagram Short is executed through Meta's existing Reel container flow while remaining separate from `FEED / VIDEO` at the Publikator domain level.

## Official API verification

Re-checked 2026-09-14 against Meta's official Instagram API collection:

- Reel container: `POST /{ig-user-id}/media`;
- `media_type=REELS`;
- `video_url` must be publicly reachable by Meta;
- `share_to_feed=false` publishes only to the Reels tab;
- `share_to_feed=true` publishes to both Feed and Reels tab;
- container must reach `status_code=FINISHED` before `media_publish`;
- final publication: `POST /{ig-user-id}/media_publish?creation_id=...`;
- official Reel input profile currently documents MOV/MP4, AAC audio, HEVC/H.264 video, 23–60 FPS, max horizontal size 1920 px, recommended 9:16, duration 3 s–15 min, max file size 1 GB.

Official references:

- https://www.postman.com/meta/instagram/folder/830j7my/reels-publishing
- https://www.postman.com/meta/instagram/request/5kkpkh6/upload-a-reel-to-an-ig-container

Publikator intentionally keeps its narrower canonical media profile: MP4 + H.264 + AAC-or-no-audio. We do not widen canonical storage just because Meta accepts additional codecs/containers.

## Resolved compositions

| Publikator composition | Instagram transport | `share_to_feed` |
| --- | --- | --- |
| `FEED / VIDEO` | Reel | `true` |
| `SHORT / VERTICAL_VIDEO` | Reel | `false` |

Crossed combinations are rejected before any Graph API request:

- `SHORT / VIDEO`;
- `FEED / VERTICAL_VIDEO`.

`VERTICAL_VIDEO` additionally requires portrait dimensions when both width and height are known (`height > width`). Exact 9:16 is not treated as a Meta hard limit because current official documentation describes 9:16 as recommended.

## Safety and recovery

The existing Instagram safety boundary is reused unchanged:

1. container creation is not yet a public publication;
2. container status polling is not a public publication;
3. failures before `media_publish` may be retried according to the existing adapter rules;
4. after `media_publish` starts, transport failure or a response without stable media ID is an unknown public outcome and must become `RECOVERY_NEEDED` through the generic publisher.

A Short therefore does not introduce a second retry/recovery model.

## Public media transport

Instagram fetches `video_url` from Publikator. `SHORT / VERTICAL_VIDEO` therefore requires exactly one public HTTPS media URL without embedded credentials, the same as the existing Instagram Reel feed path.

## Capability gate

This checkpoint MUST NOT change production capability truth:

- `supportsShortVideo` remains `false`;
- `supportsVideo` remains `false` until the corresponding live evidence policy allows enablement;
- `richMediaPendingLiveAcceptance` remains `true`.

Mock/E2E success proves adapter behavior, not external production entitlement or visibility.

A later checkpoint must extend the real live-acceptance evidence contract from `FEED / VIDEO` to `SHORT / VERTICAL_VIDEO`, perform a real Instagram publication, record stable external media ID, and require manual visibility confirmation before capability enablement is considered.

## Acceptance

`CX3-011A Instagram Short Reel` regression must prove:

- `media_type=REELS`;
- public HTTPS `video_url`;
- caption forwarding;
- `share_to_feed=false` for Short;
- crossed FEED/SHORT compositions rejected before network I/O;
- horizontal media rejected for canonical `VERTICAL_VIDEO`;
- container failure remains pre-publication/safe-retry;
- failure after `media_publish` starts remains unknown-outcome/recovery;
- production capability remains disabled.

Full `Publikator CI / Acceptance` must pass before merge. Schema remains 8.

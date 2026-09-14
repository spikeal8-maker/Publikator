# CX3-008E — Instagram FEED/VIDEO via Reels

Status: implementation-ready, production capability remains live-gated.

This checkpoint is subordinate to `CX3_008_VIDEO_PUBLICATION.md`, `CONTENT_EXPERIENCE_V3.md` and the single platform capability source in `src/platforms/capabilities.ts`.

## Official contract reviewed

Current Meta Instagram API Reels publishing material was re-checked on 2026-09-14 using Meta's Instagram API Postman collection and Meta's official Reels publishing sample.

For Publikator `FEED/VIDEO`, the external representation is an Instagram Reel with `share_to_feed=true`:

1. `POST /{ig_user_id}/media` creates a non-public media container.
2. The request uses `media_type=REELS` and a publicly reachable HTTPS `video_url`.
3. `share_to_feed=true` requests placement in the main Instagram Feed in addition to the Reels surface.
4. Publikator polls the container with `fields=status_code,status` until `status_code=FINISHED`.
5. Only after `FINISHED` does Publikator call `POST /{ig_user_id}/media_publish` with the container as `creation_id`.
6. A successful publish must return a stable media `id`, which becomes the Publikator external id.

Stories are not part of this checkpoint. `STORY/VERTICAL_VIDEO` and `SHORT/VERTICAL_VIDEO` remain independently gated combinations.

## Media profile

Meta accepts a broader Reel input set, including H.264 or HEVC. Publikator intentionally keeps the narrower canonical video profile already established by CX3-008A:

- container: MP4;
- video codec: H.264;
- audio codec: AAC or no audio;
- one video asset per FEED/VIDEO publication;
- public media transport: exactly one HTTPS `video_url` without embedded credentials.

Current Meta Reel limits enforced defensively when canonical metadata is present:

- maximum file size: 1 GB;
- duration: 3 seconds through 15 minutes;
- frame rate: 23 through 60 FPS;
- maximum horizontal resolution: 1920 pixels.

The narrower canonical profile is deliberate. Publikator must not expand its accepted upload profile merely because one external platform accepts additional codecs or containers.

## Implementation

`src/platforms/instagram.ts` now has an explicit FEED/VIDEO branch while leaving the existing image and image-carousel behavior intact.

The video path is:

`canonical MP4 -> public HTTPS video_url -> REELS container -> FINISHED -> media_publish`

Container request parameters include:

- `media_type=REELS`;
- `video_url=<public HTTPS URL>`;
- `caption=<target text>`;
- `share_to_feed=true`;
- `access_token=<Instagram credential>`.

No binary upload is performed by the Instagram adapter. Meta fetches the video from Publikator's public HTTPS media endpoint.

## Failure and recovery boundary

The existing Instagram recovery model is preserved and applies equally to Reel publication.

Before `media_publish`:

- container creation is preparation only;
- status polling is preparation only;
- transport/5xx failures are normalized to `outcomeUnknown=false` and may be safely retried;
- `ERROR` or `EXPIRED` container states are known non-public failures;
- timeout while waiting for `FINISHED` is retryable and does not imply a public post exists.

At `media_publish`:

- this is the first operation that may create the public Instagram publication;
- transport, timeout or 5xx ambiguity is `outcomeUnknown=true`;
- such an outcome must enter the existing manual recovery path rather than automatically retrying the whole target;
- a success-like response without a stable media id is also treated as unknown to prevent duplicate publication.

## Capability gate

Implementation readiness does not enable production publication.

The following remain unchanged until live acceptance evidence exists:

- `PLATFORM_CAPABILITIES.instagram.supportsVideo = false`;
- `supportsStories = false`;
- `supportsShortVideo = false`;
- `verification.richMediaPendingLiveAcceptance = true`.

Instagram VIDEO also continues to require public HTTPS media through the common capability preflight.

Therefore READY/preflight blocks Instagram FEED/VIDEO before any Graph API request in production despite the adapter code being implementation-ready.

## Acceptance

The focused Instagram adapter suite must prove:

- existing single-image publication remains green;
- existing image carousel publication remains green;
- FEED/VIDEO creates `media_type=REELS` with `share_to_feed=true` and the canonical public `video_url`;
- the adapter waits for `FINISHED` before `media_publish`;
- public URL, asset count, MIME, canonical codec/container, size, duration, FPS and width guards reject invalid input before the first external request;
- container creation/status failures stay on the safe preparation side of the recovery boundary;
- `media_publish` 5xx/transport ambiguity and missing publish id are unknown outcomes that block automatic retry;
- the suite asserts Instagram video capability remains disabled;
- full `Publikator CI / Acceptance` passes before merge.

## Live acceptance required before enablement

A later CX3-008F live acceptance must use a real eligible Instagram account and production-equivalent public media URL. Evidence must show one canonical MP4 is fetched, processed and published exactly once, `media_publish` returns a stable media id, and the Reel is visible in the intended Feed/Reels surfaces. Only after that evidence may `supportsVideo` be considered for enablement.

# CX3-008 — Video / Story publication execution plan

Status: implementation plan subordinate to `VNEXT_TECHNICAL_SPEC.md` and `CONTENT_EXPERIENCE_V3.md`.

CX3-008 is intentionally split into independently reviewable checkpoints. A single PR must not simultaneously add the media pipeline and enable several external platform capabilities.

## CX3-008A — Production video media pipeline

Scope:

- canonical upload endpoint for MP4 video;
- accepted video codec H.264;
- accepted audio AAC or no audio;
- bounded streaming upload, no full-video buffering in Node.js;
- `ffprobe` metadata: width, height, duration, FPS, codecs, container;
- automatic JPEG poster through `ffmpeg`;
- video + poster stored in the existing local media store and schema-8 `content_media` relation;
- one optimistic `content_version` mutation for the video/poster pair;
- immutable revision publication-media projection excludes poster assets;
- stale temp cleanup at startup;
- explicit byte/time/temp-disk configuration;
- production Docker contains `ffmpeg` and `ffprobe`.

Non-goals:

- no transcoding of non-H.264/non-MP4 input;
- no new database schema;
- no Story/Short platform capability enabled;
- no external social API behavior changed;
- no mixed-media carousel authoring.

Acceptance:

- MP4/H.264/AAC upload persists video metadata and generated poster;
- invalid codec/container is rejected before DB commit;
- oversize/truncated upload leaves no media rows/files;
- video deletion removes an unshared generated poster;
- immutable revision delivers video as publication media and keeps poster as presentation metadata only;
- Docker runtime exposes both `ffmpeg` and `ffprobe`;
- full `Publikator CI / Acceptance` passes.

## CX3-008A2 — Browser video authoring closure

Scope:

- the normal post editor accepts both `image/*` and `video/mp4`;
- MP4 is routed to the canonical `/api/posts/:id/video` endpoint and images remain on `/api/posts/:id/media`;
- generated poster media is hidden as an implementation asset and is never presented to the editor as a second user attachment;
- video is rendered through an HTML5 player with the generated poster;
- Video v1 prevents mixed image/video authoring and prevents a second video until the first video is removed;
- video deletion uses the same optimistic `content_version` contract and relies on the backend cascade for the generated poster;
- platform cards show the video poster and defer sendability to capability preflight instead of pretending image semantics.

Acceptance:

- browser shell loads the video-authoring JS/CSS assets;
- UI projection collapses the stored video+poster pair into one authoring item;
- image and MP4 uploads are routed to different canonical endpoints;
- existing image authoring remains available;
- full `Publikator CI / Acceptance` passes.

## CX3-008B — Telegram FEED/VIDEO adapter

Official API review: Telegram Bot API 10.3, published 2026-08-24 and re-checked 2026-09-14.

Confirmed FEED/VIDEO contract:

- `sendVideo` is the publication method for MPEG4 video messages;
- new files may be sent through `multipart/form-data`;
- bot-uploaded video is limited to 50 MB by the current Bot API;
- caption limit is 1024 characters after entity parsing;
- `supports_streaming` may be set for streamable uploads;
- successful publication returns a `Message`, and `message_id` remains the adapter external id;
- local bytes must be available and size-valid before the first external POST;
- text longer than the caption limit uses the existing two-step `sendVideo` then `sendMessage` path; failure after confirmed video publication enters manual recovery and must never retry the whole target automatically.

Implementation scope:

- one canonical `video/mp4` asset only;
- `publicationKind=FEED`, `contentFormat=VIDEO` only;
- defense-in-depth verification of canonical H.264, AAC-or-none and MP4 metadata when present;
- no video carousel or mixed-media group in this checkpoint;
- existing photo and photo-carousel behavior remains unchanged.

Capability gate:

- implementation readiness does **not** enable production capability;
- `PLATFORM_CAPABILITIES.telegram.supportsVideo` remains `false`;
- `verification.richMediaPendingLiveAcceptance` remains `true`;
- therefore READY/preflight still blocks Telegram FEED/VIDEO before any external POST;
- enablement requires a live acceptance with real Telegram credentials/channel and recorded evidence that one canonical MP4 publishes exactly once and returns a stable `message_id`.

Telegram Story/Short is explicitly out of scope. The current Bot API Story video profile requires 720×1280, streamable H.265 MPEG4, keyframes each second, max 30 MB and duration up to 60 seconds. That is a different rendition from the canonical H.264 FEED video and must not be enabled by this adapter.

Acceptance:

- focused adapter test covers `sendVideo` multipart fields and external id;
- >50 MB and non-H.264 canonical input are rejected before `fetch`;
- 429, 5xx and network unknown-outcome semantics remain covered;
- long-caption partial publication remains duplicate-safe for both image and video;
- test asserts the production capability gate is still disabled;
- full `Publikator CI / Acceptance` passes.

## CX3-008C — VK video adapter

Same rule: current official VK API review first, focused tests second, live acceptance before capability enablement.

## CX3-008D — MAX video adapter

Same rule. Public-media requirements, upload/publication phases and unknown-outcome boundary must be documented from the current API.

## CX3-008E — Instagram video / Reels adapter

Same rule. Container creation, processing wait, publish phase, Reels/Story distinctions and public HTTPS requirements must be verified against the current Meta API before enabling capability.

## CX3-008F — Story/Short live acceptance and capability gate

Final CX3-008 closure requires platform-by-platform live evidence for every capability that is enabled. Unsupported or unaccepted combinations remain `false` in the single `PlatformCapability` source and continue to be blocked before external POST.

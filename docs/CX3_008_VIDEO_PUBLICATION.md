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

## CX3-008B — Telegram video adapter

Before implementation, re-check the current official Telegram Bot API. Implement only capabilities confirmed by current docs. Add focused adapter/recovery tests. Capability remains disabled until the live-acceptance evidence required by the master spec is recorded.

## CX3-008C — VK video adapter

Same rule: current official VK API review first, focused tests second, live acceptance before capability enablement.

## CX3-008D — MAX video adapter

Same rule. Public-media requirements, upload/publication phases and unknown-outcome boundary must be documented from the current API.

## CX3-008E — Instagram video / Reels adapter

Same rule. Container creation, processing wait, publish phase, Reels/Story distinctions and public HTTPS requirements must be verified against the current Meta API before enabling capability.

## CX3-008F — Story/Short live acceptance and capability gate

Final CX3-008 closure requires platform-by-platform live evidence for every capability that is enabled. Unsupported or unaccepted combinations remain `false` in the single `PlatformCapability` source and continue to be blocked before external POST.

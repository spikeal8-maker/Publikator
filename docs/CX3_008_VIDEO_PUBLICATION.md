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

## CX3-008C — VK FEED/VIDEO adapter

Official API review: VK API JSON schema version 5.199 and the official VK SDK upload flow, re-checked 2026-09-14.

Confirmed FEED/VIDEO contract:

- `video.save` creates the upload reservation and returns `upload_url`, `owner_id` and `video_id`;
- community upload uses positive `group_id`;
- `wallpost=0` keeps `video.save` in the preparation phase instead of asking VK to create a wall post implicitly;
- the binary video is sent to the returned upload server through `multipart/form-data` in field `video_file`;
- the resulting video can be attached to `wall.post` as `video<owner_id>_<video_id>`;
- `wall.post` supports deterministic `guid`, and Publikator continues to use `postId` as that GUID;
- VK video processing is asynchronous after upload, so the adapter must not invent a second public side effect to probe readiness.

Implementation scope:

- one canonical `video/mp4` asset only;
- `publicationKind=FEED`, `contentFormat=VIDEO` only;
- local video bytes are read before `video.save`, so a missing local file produces zero external requests;
- defense-in-depth verification of canonical H.264, AAC-or-none and MP4 metadata when present;
- phase 1: `video.save(wallpost=0)`;
- phase 2: multipart `video_file` upload to `upload_url`;
- phase 3: the only public wall side effect is the existing `wall.post` with `guid=postId`;
- existing photo and photo-carousel upload path remains unchanged.

Failure and recovery boundary:

- failures during local read, `video.save` or binary upload are preparation failures with `outcomeUnknown=false`;
- temporary preparation transport/5xx failures may be retried and can at worst leave orphan prepared video media in VK;
- an inconsistent upload response is a known preparation failure and must not reach `wall.post`;
- an explicit VK API error returned by `wall.post` is a known outcome and keeps its VK retryability classification;
- only a transport/timeout failure after `wall.post` starts can have an unknown public result and therefore enters `RECOVERY_NEEDED`;
- automatic retry of an unknown `wall.post` outcome remains prohibited to avoid duplicate posts.

Capability gate:

- implementation readiness does **not** enable production capability;
- `PLATFORM_CAPABILITIES.vk.supportsVideo` remains `false`;
- Stories and Shorts remain disabled;
- `verification.richMediaPendingLiveAcceptance` remains `true`;
- READY/preflight therefore continues blocking VK FEED/VIDEO before any external POST;
- enablement requires live acceptance with real VK credentials/community and evidence that one canonical MP4 is uploaded, attached and published exactly once with a stable `post_id`.

Acceptance:

- existing image adapter scenarios remain green;
- focused test covers `video.save` parameters, `video_file` multipart upload and final video attachment;
- missing local video and invalid canonical codec are rejected before network activity;
- preparation network/5xx failures remain safe-retry/known-outcome;
- mismatched upload identifiers never reach `wall.post`;
- `wall.post` transport failure remains the only unknown-outcome boundary;
- test asserts the production capability gate is still disabled;
- full `Publikator CI / Acceptance` passes.

## CX3-008D — MAX FEED/VIDEO adapter

Official API review: current MAX Developer API (`platform-api2.max.ru`), re-checked 2026-09-14.

Confirmed FEED/VIDEO contract:

- MAX video attachments support MP4, MOV, MKV and WEBM; Publikator keeps its canonical MP4/H.264 profile;
- one video may be up to 250 MB;
- media messages may contain up to 12 media attachments, but Video v1 keeps exactly one canonical video per publication;
- unlike MAX images, video cannot be attached from a public URL and must use the upload-token flow;
- `POST /uploads?type=video` returns an upload URL and a token for the future attachment;
- the documented video upload host is `https://omub.okcdn.ru`;
- multipart binary upload uses field `data`;
- the final `POST /messages` attachment is `{ "type": "video", "payload": { "token": "..." } }`;
- message text is limited to 4000 characters;
- MAX can return explicit `attachment.not.ready` while server-side media processing is still in progress; documentation recommends retrying later with increasing delay.

Implementation scope:

- one canonical `video/mp4` asset only;
- `publicationKind=FEED`, `contentFormat=VIDEO` only;
- defense-in-depth verification of canonical H.264, AAC-or-none and MP4 metadata when present;
- both declared media size and actual local file size are bounded at 250 MB before upload;
- local media is opened through Node `fs.openAsBlob`, so a 250 MB video is file-backed instead of copied into a Node Buffer;
- phase 1: `POST /uploads?type=video` with bot token only in the MAX Authorization header;
- phase 2: multipart `data` upload to the signed video upload URL without leaking the bot token to the upload host;
- phase 3: one public `POST /messages` with the video attachment token;
- upload URL is restricted to HTTPS host `omub.okcdn.ru` before the application performs the upload;
- existing image and carousel behavior remains URL-based and unchanged.

Public-media capability rule:

- `requiresPublicHttpsMedia` is now format-aware through `publicHttpsMediaFormats`;
- MAX `IMAGE` and `CAROUSEL` continue to require public HTTPS URLs;
- MAX `VIDEO` does not require `PUBLIC_BASE_URL`, because MAX video publication uses an upload token instead;
- Instagram retains its existing public-HTTPS requirement for all currently modeled formats.

Failure and recovery boundary:

- missing local video, `/uploads` failures and binary-upload failures are preparation failures with `outcomeUnknown=false`;
- temporary preparation transport/5xx failures are safe to retry and can at worst leave an unused upload token/media object;
- an upload URL outside the documented HTTPS video host is rejected before the upload request as an SSRF guard;
- explicit `attachment.not.ready` is a known, retryable rejection and must not enter `RECOVERY_NEEDED`;
- only timeout/transport/5xx ambiguity after final `POST /messages` starts can have an unknown public result;
- a success-like message response without a stable message identifier is also treated as unknown and blocks automatic retry.

Capability gate:

- implementation readiness does **not** enable production capability;
- `PLATFORM_CAPABILITIES.max.supportsVideo` remains `false`;
- Stories and Shorts remain disabled;
- `verification.richMediaPendingLiveAcceptance` remains `true`;
- READY/preflight therefore continues blocking MAX FEED/VIDEO before any external POST;
- enablement requires live acceptance with a real MAX bot/channel and evidence that one canonical MP4 is uploaded, processed and published exactly once with a stable message id.

Acceptance:

- all existing image/public-URL scenarios remain green;
- focused adapter test covers upload reservation, file-backed multipart `data`, token attachment and external id;
- 250 MB, codec, missing-local-file and upload-host SSRF guards execute before the unsafe network phase;
- `/uploads` and upload-host 5xx failures remain safe-retry/known-outcome;
- `attachment.not.ready` is classified as known/retryable;
- final `/messages` 5xx/transport and missing-id cases remain unknown-outcome;
- test asserts production video capability is still disabled;
- full `Publikator CI / Acceptance` passes.

## CX3-008E — Instagram video / Reels adapter

Same rule. Container creation, processing wait, publish phase, Reels/Story distinctions and public HTTPS requirements must be verified against the current Meta API before enabling capability.

## CX3-008F — Story/Short live acceptance and capability gate

Final CX3-008 closure requires platform-by-platform live evidence for every capability that is enabled. Unsupported or unaccepted combinations remain `false` in the single `PlatformCapability` source and continue to be blocked before external POST.

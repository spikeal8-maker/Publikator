# CX3-010A — Telegram STORY/IMAGE foundation

Status: adapter implemented, capability intentionally live-gated.

Official contract re-checked on 2026-09-14 against Telegram Bot API 10.3.

## Scope

This checkpoint adds only `Telegram + STORY + IMAGE` delivery through Bot API `postStory`.

It does **not** enable `supportsStories` and does not claim production readiness without a real managed business account acceptance.

## Telegram requirements enforced before external POST

- `botToken` is required;
- `businessConnectionId` is required for Story publication; `chatId` remains the FEED credential and is not required for Story;
- exactly one media asset;
- MIME `image/jpeg`;
- exact dimensions `1080x1920`;
- maximum declared size 10 MB;
- Story caption maximum 2048 Unicode code points;
- media is uploaded as a new multipart file using `attach://story` as required by `InputStoryContentPhoto`;
- `active_period` is fixed to 86400 seconds (24 hours) in this first foundation checkpoint.

## External effect

`POST https://api.telegram.org/bot<TOKEN>/postStory`

Multipart fields:

- `business_connection_id`;
- `content={"type":"photo","photo":"attach://story"}`;
- `active_period=86400`;
- optional `caption`;
- binary `story` JPEG.

A successful response must contain a positive integer Story `id`. Missing Story id is treated as an unknown external outcome and must not be automatically retried.

Network/5xx uncertainty follows the existing Telegram recovery semantics. Known 429 remains retryable.

## Capability gate

`PLATFORM_CAPABILITIES.telegram.supportsStories` remains `false`.

Reason: mock/E2E adapter evidence is not equivalent to a successful live publication through a real Telegram Business connection with `can_manage_stories`.

## Explicitly out of scope

### STORY/VIDEO

Telegram requires Story video to be:

- 720x1280;
- streamable MPEG-4;
- H.265;
- key frames every second;
- no more than 30 MB;
- duration 0–60 seconds.

Publikator Video v1 intentionally stores canonical H.264/AAC MP4. Therefore Story video must receive a separate platform rendition/transcoding path; the H.264 FEED asset must not be mislabeled as Story-ready.

### STORY_SEQUENCE

Sequence delivery remains a separate checkpoint. The existing `publication_units` recovery foundation is retained and must be connected only after single Story delivery is proven live.

## Regression

The existing CI command `node scripts/telegram-adapter-e2e.mjs` now runs two isolated Node processes:

1. the preserved 12-scenario FEED/image/carousel/video regression;
2. the new Story/image regression covering successful multipart construction, exact dimensions, size, business credential, caption limit, 429 handling, unknown success response, and network uncertainty.

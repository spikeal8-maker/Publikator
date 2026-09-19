# CX3-005 Platform capability / preflight

This document records the capability boundary implemented by CX3-005.

Normative product rules remain in `VNEXT_TECHNICAL_SPEC.md`. The capability DTO in `src/platforms/capabilities.ts` is the executable source used by UI/API consumers, READY preflight and the publisher safety gate.

## Conservative enablement rule

A platform may support a feature in its public API while Publikator still reports that feature as unsupported.

A capability is enabled only when the corresponding Publikator adapter path exists and is safe to use. New video/story/short capabilities stay disabled until the platform-specific CX3-008 work has focused tests and live acceptance.

Therefore CX3-005 keeps the existing proven adapter surface:

| Platform | FEED/IMAGE | FEED/CAROUSEL | VIDEO | SHORT | STORY | STORY_SEQUENCE |
| --- | --- | --- | --- | --- | --- | --- |
| Telegram | enabled | enabled | disabled | disabled | disabled | disabled |
| VK | enabled | enabled | disabled | disabled | disabled | disabled |
| MAX | enabled | enabled | disabled | disabled | disabled | disabled |
| Instagram | enabled | enabled | disabled | disabled | disabled | disabled |

`TEXT_ONLY` is also disabled in this checkpoint because the current production publishers are image-oriented. It must not be enabled merely because an external API can send text messages.

## Official documentation review — 2026-09-19

The implementation was checked against current platform documentation before freezing the matrix:

- Telegram Bot API: https://core.telegram.org/bots/api
  - `sendPhoto` currently documents a 10 MB photo limit, width+height <= 10000 and max aspect ratio 20;
  - `sendMediaGroup` supports 2-10 media items;
  - Telegram also exposes video/story APIs, but Publikator does not enable those capabilities yet.
- MAX developer API: https://dev.max.ru/docs-api
  - `POST /messages` supports image/video attachments;
  - up to 12 combined media attachments are documented;
  - images may be provided by URL, while other media need the upload/token path;
  - current Publikator adapter only implements the image URL path, so video remains disabled.
- Instagram Platform content publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing
  - Meta documents image/video/Reels/carousel publishing and current APIs also expose Story publishing for eligible professional accounts;
  - current Publikator adapter implements JPEG image/carousel only, so video/Reels/Stories stay disabled pending CX3-008 live acceptance.
- VK API schema maintained by VK: https://github.com/VKCOM/vk-api-schema
  - wall attachments include photo/video types and the schema contains Stories methods;
  - current Publikator adapter specifically uploads wall photos then calls `wall.post`, therefore only image feed/carousel is enabled.

The matrix intentionally distinguishes **external platform capability** from **Publikator adapter capability**.

EW4-004 adds a second, orthogonal rich-text capability dimension to this same registry; it does **not** create a second capability registry:

| Feature | Telegram | MAX | VK | Instagram |
| --- | --- | --- | --- | --- |
| bold / italic / underline / strike | native | native | drop | drop |
| inline code | native | native | drop | drop |
| code block | native | native | transform | transform |
| link | native | native | transform | transform |
| quote | native | native | transform | transform |
| bullet / ordered lists | transform | transform | transform | transform |

Modes:
- `native` — platform transport preserves presentation directly;
- `transform` — meaning is preserved deterministically through textual/structural transformation;
- `drop` — presentation is simplified and compiler emits WARNING.

Detailed external evidence and diagnostic codes: `PLATFORM_TEXT_COMPILERS_EW4_004.md`.

## Preflight invariant

For each enabled target, Publikator resolves the immutable READY revision plus target rendition first, then validates:

- publication kind / content format support;
- media count;
- MIME types;
- mixed-carousel support;
- known aspect/dimension rules;
- known duration rules;
- text limits;
- public HTTPS media requirement.

Compiler diagnostics are merged into preflight with severity `info | warning | error`. INFO/WARNING do not block READY. ERROR does. Existing hard capability failures remain ERROR.

Any actual incompatibility blocks READY with HTTP 409 and structured capability issue codes.

The same capability guard runs again against the immutable revision immediately before target publication, before claim/external POST. This prevents scheduler/retry paths from bypassing READY preflight.

## Scope exclusions

CX3-005 does not add:

- new video/story/short publication adapters;
- platform preview UI;
- video upload/transcoding;
- a new database schema.

Current schema remains 10. EW4-004 adds no schema migration.

# CX3-006 Platform previews v2

Platform preview is a review surface, not a pixel-perfect clone of a social client.

## Truth contract

Preview resolves, per target, through the **same EW4-004 truth path as preflight/publisher**:

1. canonical publication kind/content format;
2. target text source precedence: TargetRendition rich → legacy override → historical rendition-plain compatibility → Base rich document;
3. one platform compiler;
4. canonical `ContentMedia` order/roles;
5. compiler diagnostics plus current `PlatformCapability` validation issues.

The API returns the text source, resolved canonical rich document, typed compilation transport and diagnostics. There is no separate preview compiler.

The preview must not invent behavior that the publisher does not execute. In particular, `TargetRendition.mediaPlanJson` is not currently interpreted by production publishers, so CX3-006 shows canonical media order and emits `MEDIA_PLAN_NOT_EXECUTED` when such a plan exists.

Telegram/MAX formatted preview is rendered from the resolved canonical AST through the safe rich renderer. Compiled MAX HTML is diagnostic/transport data only and is never inserted into the browser as raw HTML. VK/Instagram preview displays the actual deterministic plain compiler result and downgrade diagnostics.

## Layout scope

Cards are platform-aware and layout-accurate only for Publikator-controlled parameters:

- resolved text;
- publication kind/content format;
- media order/count;
- video duration/poster;
- approximate caption placement;
- vertical 9:16 safe-zone guides;
- capability/preflight warnings and errors.

Client chrome, fonts and pixel spacing are intentionally approximate because external apps change independently.

## Safety

CX3-006 does not enable VIDEO/SHORT/STORY publication adapters. Capability flags remain conservative until CX3-008 live acceptance.

Current schema remains 10. EW4-004 adds no schema migration.

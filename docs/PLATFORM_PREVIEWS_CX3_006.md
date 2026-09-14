# CX3-006 Platform previews v2

Platform preview is a review surface, not a pixel-perfect clone of a social client.

## Truth contract

Preview resolves, per target:

1. canonical Post publication kind/content format/text;
2. target rendition overrides;
3. legacy target text override when no rendition text is set;
4. canonical schema-8 `ContentMedia` order/roles;
5. current `PlatformCapability` validation issues.

The preview must not invent behavior that the publisher does not execute. In particular, `TargetRendition.mediaPlanJson` is not currently interpreted by production publishers, so CX3-006 shows canonical media order and emits `MEDIA_PLAN_NOT_EXECUTED` when such a plan exists.

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

Schema remains 8.

# CX3-010B — Telegram STORY/VERTICAL_VIDEO rendition

Status: implementation checkpoint; `supportsStories` remains live-gated.

Official Telegram Bot API contract re-checked on 2026-09-14 against Bot API 10.3.

## Why a platform rendition is required

Publikator Video v1 intentionally stores a canonical MP4/H.264 source with AAC or no audio. Telegram Story video instead requires a newly uploaded, streamable MPEG-4 file that is exactly 720x1280, encoded as H.265/HEVC, has key frames each second, is no larger than 30 MB, and has duration in the 0–60 second range.

The canonical media model is therefore not changed to H.265. CX3-010B creates an ephemeral Telegram-only rendition immediately before the external `postStory` call.

## Pipeline

1. Validate one immutable canonical `video/mp4` source.
2. Require known duration `0 < duration <= 60s`.
3. Require canonical H.264 and AAC-or-no-audio metadata.
4. Transcode locally with FFmpeg/libx265 into the media temp directory.
5. Preserve source aspect ratio with scale + black padding to exact 720x1280 rather than destructive crop.
6. Encode H.265 (`libx265`, `hvc1`) and force a key frame every second.
7. Use `+faststart` MP4 layout.
8. Re-probe the result before any external side effect:
   - MP4 container;
   - exactly one HEVC video stream;
   - exactly 720x1280;
   - AAC or no audio;
   - duration <=60s;
   - file size <=30 MB;
   - keyframe cadence no more than about one second (small timestamp tolerance);
   - `moov` before `mdat` in the faststart scan.
9. Upload the rendition as new multipart content through `postStory`.
10. Always remove the temporary rendition after the request path completes.

## Size policy

The encoder targets a conservative 24 MiB payload budget rather than the Telegram 30 MiB hard limit, leaving room for muxing variability. The resulting file is still checked against the actual 30 MiB limit before the external POST.

## Recovery semantics

There are two distinct phases:

- **local preparation** — source missing, FFmpeg/FFprobe failure, invalid codec/dimensions/keyframes, oversize output. No Telegram side effect has occurred, so the result is known and `outcomeUnknown=false`;
- **external `postStory`** — network interruption, 5xx, or an apparently successful response with no Story id can have an unknown external effect and must block unsafe automatic replay.

Temporary-file cleanup failure must never turn a Telegram-confirmed publication into a failed publication result.

## Runtime gate

The production Dockerfile now asserts that the installed FFmpeg exposes `libx265`. A production image without the required encoder cannot pass the image build.

## Capability gate

`PLATFORM_CAPABILITIES.telegram.supportsStories` remains `false`.

A capability may only be enabled after a real Telegram Business connection with `can_manage_stories` successfully publishes and the result is verified externally. Mock/E2E evidence does not open production capability.

## Still out of scope

- `STORY_SEQUENCE` orchestration through multiple `postStory` calls;
- Story-specific areas/links/options;
- automatic enabling of `supportsStories`;
- changing canonical Video v1 away from H.264.

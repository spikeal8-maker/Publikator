# CX3-011B — Instagram Short live acceptance gate

Status: implementation checkpoint. Production capability stays disabled until a real control publication reaches `PASSED`.

## Scope

CX3-011A added the implementation-ready Instagram `SHORT / VERTICAL_VIDEO` adapter path through the existing Reels publishing primitive. CX3-011B adds a production-native acceptance tool for that exact composition without changing the normal capability matrix.

This checkpoint deliberately does not reuse or mutate the existing CX3-008F FEED/VIDEO evidence format. The old gate remains valid and unchanged. Short acceptance uses its own evidence contract and crash-safe lock namespace.

## External composition

The live input is fixed to:

- platform: `instagram`;
- publication kind: `SHORT`;
- content format: `VERTICAL_VIDEO`;
- one canonical `video/mp4` asset;
- portrait dimensions (`height > width`);
- one public credential-free HTTPS `video_url`;
- adapter publishes through Meta `media_type=REELS` with `share_to_feed=false`.

The adapter still enforces the canonical Publikator H.264/AAC-or-none/MP4 Reel profile and the current duration/FPS/size bounds from CX3-011A.

## Operator flow

Plan-only mode performs local media verification but does not decrypt credentials or perform external requests:

```bash
npm run live:instagram-short:accept -- --account acc_... --media med_...
```

A real control publication requires an explicit confirmation and an immutable production build SHA:

```bash
PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM=I_UNDERSTAND_THIS_WILL_PUBLISH_EXTERNALLY \
npm run live:instagram-short:accept -- --publish --account acc_... --media med_...
```

The CLI writes protected evidence into `DATA_DIR/live-acceptance-evidence/` and returns `API_CONFIRMED` only after the Instagram API returns a stable external media id.

After an operator visually verifies that the control Short/Reel is actually visible:

```bash
PUBLIKATOR_LIVE_VISIBILITY_CONFIRM=I_VERIFIED_THE_VIDEO_IS_VISIBLE \
npm run live:instagram-short:accept -- --confirm-visible \
  --evidence /app/data/live-acceptance-evidence/<run>.json \
  --note "Visible as Instagram Reel/Short"
```

Only then does evidence transition to `PASSED`.

## Safety invariants

- `supportsShortVideo` and `supportsVideo` remain `false` in this checkpoint.
- Source media must belong to a target-free `MANUAL` post in `DRAFT/DRAFT`, preventing scheduler publication in parallel.
- The media file is re-read, SHA-256 checked and inspected with `ffprobe` before the live attempt.
- Credentials are decrypted only after the explicit `--publish` guard.
- The same build/account/media combination cannot be live-published twice while valid CX3-011B evidence exists.
- A dedicated `.cx3-011b-*` lock serializes concurrent Short acceptance attempts and remains after an interrupted/unsafe persistence boundary.
- Known pre-publication failures release the lock; unknown public outcomes create `RECOVERY_NEEDED` and must not be blindly retried.
- Evidence never contains credentials. Query strings and fragments are stripped from the stored public video URL.
- Evidence files and lock files use mode `0600`.

## Compatibility with CX3-008F

CX3-008F remains the FEED/VIDEO live gate. Its schema, CLI, evidence and `.cx3-008f-*` lock namespace are unchanged.

This separation is intentional:

- a successful FEED/VIDEO control publication does not prove Short behavior;
- a successful Short control publication does not prove Feed behavior;
- the same canonical vertical video may be tested once for each composition without the two gates blocking one another;
- legacy CX3-008F evidence files continue to validate exactly as before.

## Production enablement

A green CI run or mocked adapter test is not sufficient to enable the feature. `supportsShortVideo`/`supportsVideo` may only be changed in a separate reviewed change after real CX3-011B evidence is `PASSED` and there is no unresolved Short recovery attempt.

Schema remains 8.

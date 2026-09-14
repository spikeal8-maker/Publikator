# CX3-008F — live acceptance gate for FEED/VIDEO

Status: operator tooling implemented; all platform `supportsVideo` flags remain closed until platform-specific evidence reaches `PASSED` and a separate reviewed capability change is merged.

This checkpoint follows CX3-008A through CX3-008E. Adapter implementation and mock/E2E success are necessary but are not sufficient to enable production video publication.

## What this gate proves

For each of Telegram, VK, MAX and Instagram the live gate must use:

- the exact production build identified by a 40-character `IMAGE_BUILD_SHA` / `APP_BUILD_SHA`;
- an existing enabled account from `social_accounts`;
- credentials already encrypted by Publikator with the deployment master key;
- an existing canonical `VIDEO` media asset created through the normal Publikator video pipeline;
- the real production adapter from `getPublisher(platform)`;
- the real connection test from `testConnection(platform, credentials)`;
- exactly one explicit FEED/VIDEO control publication.

The gate does not create an alternate credential store, does not accept raw tokens on the command line, and does not enable any capability by itself.

## Why account_id and media_id are mandatory

The live CLI intentionally accepts `social_accounts.id` and `media.id`, not a loose credentials file or arbitrary local MP4.

This ensures that acceptance exercises the same system that production uses:

- the account comes from the normal encrypted account store;
- the video comes from the canonical media store under `/app/data/media`;
- file size and SHA-256 are checked against the database;
- ffprobe re-checks codec, dimensions, duration, FPS and container from the actual stored bytes;
- Instagram derives its public `video_url` from the normal `PUBLIC_BASE_URL` through `mediaPublicUrl`;
- Telegram, VK and MAX use the same local media path as their production adapters.

## Safety states

CX3-008F deliberately separates three evidence states.

### `API_CONFIRMED`

The platform API returned a stable external publication identifier. This is not yet full acceptance because the operator has not confirmed the control video is actually visible in the intended channel/feed/Reels surface.

### `PASSED`

The operator visually checked the control publication and then performed the separate explicit visibility-confirmation command. Only this state is valid evidence for a later `supportsVideo` review.

### `RECOVERY_NEEDED`

The public POST may have succeeded but its response was ambiguous. Automatic retry is prohibited. The operator must inspect the target platform manually before any new control publication is attempted.

A `RECOVERY_NEEDED` evidence file cannot be converted to `PASSED` by the visibility command.

## Evidence security

Evidence files are written under `/app/data/live-acceptance-evidence` by default and are forced to mode `0600`.

Evidence includes:

- build SHA;
- platform;
- account id and display name;
- connection-test identity/destination;
- canonical media id and fingerprint;
- external publication id/URL when confirmed by the API;
- visibility confirmation timestamp and optional note.

Evidence does not include:

- plaintext credentials;
- encrypted credential payloads;
- access tokens;
- bot tokens;
- signed URL query strings or fragments;
- raw provider responses.

## Operator workflow

The production image contains `dist/cli/live-video-acceptance.js`, and `package.json` exposes it as `npm run live:video:accept`.

### 1. Identify an enabled account and canonical video

Use the existing Publikator UI/API to identify the target account id and a canonical video media id. The media must belong to a post with `content_format=VIDEO` and be `video/mp4`.

The examples below use concrete syntactically valid ids only to demonstrate command structure; replace them with ids shown by the running Publikator instance before executing the command.

### 2. Plan-only check

This command makes no external request and does not decrypt credentials:

```bash
docker exec publikator npm run live:video:accept -- --account acc_11111111-1111-4111-8111-111111111111 --media med_22222222-2222-4222-8222-222222222222
```

The output shows the platform, selected account, build SHA, media fingerprint and whether a public video URL is required.

### 3. Explicit real publication

Only after the plan output is correct, run exactly one control publication:

```bash
docker exec \
  -e PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM=I_UNDERSTAND_THIS_WILL_PUBLISH_EXTERNALLY \
  publikator \
  npm run live:video:accept -- \
  --publish \
  --account acc_11111111-1111-4111-8111-111111111111 \
  --media med_22222222-2222-4222-8222-222222222222 \
  --text "Publikator CX3-008F control FEED/VIDEO"
```

The CLI performs these operations in order:

1. validates the stored canonical media bytes and metadata;
2. verifies the running build has a full immutable build SHA;
3. only after the explicit confirmation guard, decrypts the selected stored account credentials;
4. validates the credential shape for the account platform;
5. runs the real non-public connection test;
6. validates the exact `PublishInput` through the real adapter;
7. executes exactly one real `publisher.publish(input)`;
8. writes evidence.

A normal successful run produces `API_CONFIRMED`, not `PASSED`.

### 4. Visual verification

Open the actual target platform and verify all of the following:

- the control video exists exactly once;
- it is visible in the intended feed/channel/Reels surface;
- the media is playable;
- caption/text is associated with the expected publication;
- no duplicate publication exists.

### 5. Convert evidence to PASSED

Use the exact evidence path printed by the publish command. Example:

```bash
docker exec \
  -e PUBLIKATOR_LIVE_VISIBILITY_CONFIRM=I_VERIFIED_THE_VIDEO_IS_VISIBLE \
  publikator \
  npm run live:video:accept -- \
  --confirm-visible \
  --evidence /app/data/live-acceptance-evidence/telegram-2026-09-14T15-00-00-000Z-a1b2c3d4.json \
  --note "Control video verified visually; one playable publication in target channel"
```

The evidence status becomes `PASSED`. This still does not modify `PLATFORM_CAPABILITIES`.

## Recovery rule

If the CLI reports `RECOVERY_NEEDED`, do not rerun the publish command. Inspect the target platform first. The evidence path printed by the error is the durable record of the ambiguous attempt.

The correct next engineering action is to resolve whether the external publication exists and document that resolution. A fresh acceptance publication may be attempted only after the ambiguous attempt is manually resolved.

## Capability enablement rule

`supportsVideo` must stay `false` until all of the following are true for that platform:

1. adapter focused tests pass;
2. full `Publikator CI / Acceptance` passes on the same code line;
3. CX3-008F evidence is `PASSED` for a production-equivalent build;
4. there is no unresolved `RECOVERY_NEEDED` acceptance attempt;
5. a separate code review explicitly changes that platform capability.

Stories and Shorts remain separate capability combinations. Passing FEED/VIDEO must not enable `supportsStories` or `supportsShortVideo`.

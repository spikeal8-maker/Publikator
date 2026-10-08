# TG-MAX-FEED-PUBLISH-001

Owner reference: supplied 02_CONTENT_ROUTER_PUBLISH.json, inspected as data only. No exports or secrets are committed.

Telegram FEED/TEXT_ONLY uses sendMessage; IMAGE uses multipart sendPhoto; CAROUSEL preserves sendMediaGroup. Existing entities preserve rich text. Captions exceeding 1024 characters retain the existing separate full-text message and unknown-outcome protection if media succeeded but the text did not. TEXT_ONLY requires no media and creates one message up to 4096 characters.

MAX FEED/TEXT_ONLY uses POST /messages without attachments (up to 4000 characters). Ordinary IMAGE/CAROUSEL validates all local JPEG files, reserves POST /uploads?type=image, sends multipart data to the verified HTTPS iu.oneme.ru/uploadImage endpoint and posts the returned image tokens. This follows the supplied n8n upload principle. The prior external-URL path cannot serve the owner's loopback-only Docker deployment: MAX cannot retrieve 127.0.0.1 files. Explicit legacy public-URL adapter inputs remain supported and validated; normal publisher inputs use local files. MAX allows up to 12 image attachments; all uploads precede one message.

Official references reviewed 2026-10-08:
- https://core.telegram.org/bots/api#sendmessage
- https://core.telegram.org/bots/api#sendphoto
- https://core.telegram.org/bots/api#sendmediagroup
- https://dev.max.ru/docs-api/use-cases/sending-messages/media
- https://dev.max.ru/docs-api/changelog-api

MAX uses the current platform-api2.max.ru endpoint, rather than the older domain in n8n. Existing HTML compilation replaces n8n Markdown string interpolation; arbitrary workflow code, schedules and channel footers are not executed. Per-platform editor text and selected destinations remain operator choices.

No schema change; inspection/save/READY do not post. Bot rights are checked server-side. Secrets remain encrypted and absent from account responses. Claims, recovery, immutable revisions and current video/story gates are retained. An explicit attachment.not.ready remains retryable; ambiguous public POST outcomes remain non-retryable pending recovery. Unsafe upload hosts/redirects and missing local files are rejected before public writes.

## Acceptance

Named single-CI regression exercises ordinary browser credential entry, encrypted save, text/image creation, READY and publication for both platforms with mocked provider responses. It also checks localhost image and carousel token flow, no public write during inspection/save/READY, secret non-leakage, rich text, unsafe host, missing files and preparation/public error boundaries. Existing adapter tests preserve explicit URL validation and rich-media gates. Full exact-head Acceptance required before merge.

Host acceptance requires the owner's Windows Docker and real provider credentials; GitHub CI cannot reproduce those. Real posts must have observed provider identifiers and ordinary product PUBLISHED state. The n8n exports contain MAX credentials and Telegram channel IDs, but only a reference to Telegram server_bot_1bot credentials, not its bot token. Live Telegram acceptance remains pending that token. Keep publication success, automated tests and credential availability separate.

## MAX TLS in Docker

Live Windows/Docker diagnostics found `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` for
`platform-api2.max.ru/me` with the valid n8n bot. MAX's official July 2026 migration
requires the Russian Trusted Root CA: https://dev.max.ru/docs-api/changelog-api.
The public root is bundled in `src/platforms/max-transport.ts`, downloaded over
verified HTTPS from https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer;
DER SHA-256 is D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31,
expiry 2032-02-27. A dedicated Undici dispatcher extends Node's standard CA list
only for MAX API and the two approved MAX upload hosts. Certificate and hostname
verification remain enabled; redirects are rejected. No OS trust changes,
global dispatcher, `NODE_EXTRA_CA_CERTS`, or TLS bypass is used.
Connection checking, capability inspection and publishing use this same transport.
A verified-CA read-only probe from the actual Docker runtime returned HTTP 200
and the expected bot identity; this is connection evidence, not a publication test.
The acceptance journey asserts transport isolation and pre-request rejection of
unapproved hosts, credentials in URLs, non-HTTPS and nonstandard ports.

Live connection after PR #157 exposed a second failure: Undici 8's dispatcher
handler is incompatible with Node 22's built-in fetch (bundled Undici 6).
Pin the maintained compatible 6.29.0 line. The new named real-socket transport
regression verifies built-in fetch over an actual loopback HTTP server and rejects
an ephemeral self-signed HTTPS server with DEPTH_ZERO_SELF_SIGNED_CERT. Mocked
provider responses alone do not establish dispatcher compatibility. No real public
post was created by the failed connection checks.

## Real MAX content verification

On 2026-10-08 the ordinary encrypted-connect/editor/READY/publish journey sent
TEXT_ONLY and a locally uploaded JPEG to the authorized n8n AI channel. Both
product targets became PUBLISHED after one attempt. GET /messages/{mid} returned
HTTP 200, matching IDs/destination and respectively zero / one image attachment.
However the provider text lacked paragraph separators: the prior MAX HTML compiler
emitted unsupported br tags, which the real provider silently removes. That is not
full content acceptance. MAX HTML now uses literal newline characters for hard
breaks, paragraphs, list items and quote paragraphs, keeping supported tags and
escaping intact. Regression covers exact layout in text/media contexts and the
actual outgoing operator payload; full CI and live publication after deployment
are required. Reference: https://dev.max.ru/docs-api/use-cases/sending-messages/text-formatting.

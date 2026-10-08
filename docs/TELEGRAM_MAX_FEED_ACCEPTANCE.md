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

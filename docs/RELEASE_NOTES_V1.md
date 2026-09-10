# Publikator 1.0.0 — release notes draft

Текущий кандидат: **`1.0.0-rc.1`**.

Этот документ станет release notes стабильного `v1.0.0` только после четырёх реальных platform `LIVE PASS`, post-acceptance backup/restore и зелёного `Publikator CI / Acceptance` на том же commit.

## Назначение

Publikator — единая self-hosted система планирования и публикации контента в Telegram, VK, MAX и Instagram.

Production architecture:

```text
1 repository
1 Docker container
1 Fastify process
1 SQLite/WAL database
local media storage
embedded scheduler
```

n8n, Redis, RabbitMQ, Kafka и отдельный worker не используются.

## V1 capabilities

### Content

- проекты;
- drafts;
- обязательное изображение;
- platform/account selection;
- platform-specific text override;
- live preview;
- media reorder;
- manual / AT / QUEUE scheduling;
- CSV/XLSX content-plan import/export.

### Media

- EXIF orientation;
- JPEG normalization;
- size/dimensions/SHA-256;
- duplicate detection;
- deterministic `sort_order`;
- Telegram album до 10;
- MAX до 12;
- Instagram carousel 2–10.

### Publishing safety

- platform-specific preflight;
- atomic SQLite claim before public POST;
- duplicate-safe concurrent publish/retry;
- per-target durable state;
- retry только известных временных ошибок;
- phase-aware external API semantics;
- `RECOVERY_NEEDED` для unknown/partial public outcome;
- manual recovery confirmation;
- content freeze после partial/published.

### Scheduler

- `AT` exact datetime;
- `QUEUE` weekly project slots with timezone;
- grace-window для краткого restart/maintenance;
- duplicate schedule slots запрещены SQLite UNIQUE;
- schema v3 migration очищает исторические дубли.

### Platform hardening

**Telegram**
- Unicode text limits;
- local media read before POST;
- 30s request timeout;
- safe long-text partial recovery.

**VK**
- preparation upload phase отдельно от `wall.post`;
- `guid=post.id`;
- 30s timeout;
- unknown only on public phase.

**MAX**
- Unicode 4000;
- max 12 media;
- strict public HTTPS URL validation;
- 30s public POST timeout/recovery.

**Instagram**
- container readiness polling;
- child/parent carousel readiness;
- safe preparation retry;
- unknown `media_publish` recovery.

### Security

- AES-256-GCM credentials;
- HttpOnly/SameSite session cookie;
- login throttling;
- exact same-origin browser mutation guard;
- CSP / nosniff / frame deny / no-referrer / Permissions-Policy / COOP;
- HSTS under HTTPS;
- API no-store;
- explicit trusted reverse proxy list;
- wildcard proxy trust forbidden;
- `/public-media` intentionally cross-origin for social media ingestion.

### Data / disaster recovery

- SQLite/WAL;
- schema v3;
- one canonical `.tgz` backup format;
- DB/media SHA-256 manifest;
- key fingerprint;
- tar traversal/link protection;
- staging restore;
- pre-restore backup;
- restart-before-open apply;
- filesystem rollback;
- release acceptance evidence included in backup.

### Diagnostics / release gate

- SQLite health;
- scheduler/retention state;
- media DB↔disk reconciliation;
- disk space;
- PUBLIC_BASE_URL readiness;
- pending recovery;
- full backups;
- four persistent live acceptance records.

Stable gate requires:

```text
Telegram PASS
VK PASS
MAX PASS
Instagram PASS
same commit SHA
baked image revision == acceptance SHA
no RECOVERY_NEEDED
clean diagnostics
full backup after latest PASS
restore verification
Publikator CI / Acceptance PASS
```

## Reproducible release identity

- Node `22.23.2`;
- pinned `node:22.23.2-bookworm-slim` digest;
- `package-lock.json`;
- production `npm ci`;
- production high/critical audit gate;
- `BUILD_SHA` baked into Docker `IMAGE_BUILD_SHA`;
- OCI `org.opencontainers.image.revision` label;
- non-root runtime.

## CI

В V1 остаётся один постоянный GitHub Actions workflow:

```text
.github/workflows/publikator-ci.yml
```

Один `Acceptance` job проверяет весь release-контур, включая concurrent publication and full Docker restore/restart.

## Не входит в V1

- AI generation как часть core runtime;
- analytics всех соцсетей;
- обязательный Google Sheets;
- n8n;
- Redis/queue broker;
- отдельный worker;
- отдельная database service.

Эти возможности могут рассматриваться после стабильного V1 только если не разрушают простую архитектуру.

## Release procedure

Перед финальным `v1.0.0` выполнить [`LIVE_INTEGRATION_CHECKLIST.md`](LIVE_INTEGRATION_CHECKLIST.md). Пока хотя бы один пункт release gate не выполнен, `1.0.0-rc.1` остаётся release candidate и stable tag не создаётся.

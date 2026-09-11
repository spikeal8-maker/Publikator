# Roadmap Publikator

## Текущий статус

**Версия:** `1.0.0-rc.4`

**Архитектура:** один production Docker-контейнер, Fastify, SQLite/WAL, local media storage, embedded scheduler, Telegram/VK/MAX/Instagram adapters.

Стабильный `v1.0.0` блокируется реальным live acceptance и финальным release gate. Product-development после стабилизации ядра начинается с **Content Pipeline v2**.

## Завершённые этапы

### Foundation — DONE

- Web UI + REST API;
- проекты, посты и подключаемые social accounts;
- SQLite/WAL;
- AES-256-GCM credentials;
- local media storage;
- Docker deployment;
- Telegram / VK / MAX / Instagram adapters.

### Publication model — DONE

- отдельный target state на каждый аккаунт;
- platform-specific `override_text`;
- обязательное media перед `READY`;
- preflight использует тот же `PublishInput`, что реальный publisher;
- manual / AT / QUEUE;
- retry только для известных временных ошибок;
- `RECOVERY_NEEDED` для небезопасного автоматического повтора;
- ручные recovery-развязки с audit trail;
- immutable content после partial/published.

### Media — DONE

- EXIF orientation;
- JPEG normalization;
- width/height/size/SHA-256;
- duplicate media detection;
- `sort_order`;
- Telegram groups до 10;
- MAX до 12;
- Instagram carousel 2–10;
- UI reorder/preview.

### Portability — DONE

- единый `.tgz` backup: SQLite + media + manifest;
- SQLite/media SHA-256;
- tar safety validation;
- `APP_MASTER_KEY` fingerprint;
- pre-restore backup;
- staged restart-before-open restore;
- filesystem rollback;
- canonical backup API/UI;
- CSV/XLSX content-plan export/import с dry-run и SHA-bound apply.

### Operations — DONE

- diagnostics;
- scheduler status;
- event/backup retention;
- recovery UI;
- release gate;
- persistent live acceptance evidence;
- package-lock + `npm ci`;
- pinned Node/Docker base;
- production dependency audit.

## V1 stabilization — DONE по коду, acceptance pending

### STAB-001 — Atomic publication claim — DONE

Перед внешним POST target захватывается атомарным SQLite compare-and-set. Два конкурентных `publishPost`/`publishTarget` не могут выполнить два внешних POST одного target. Retry и recovery transitions также используют условные state transitions.

Acceptance: dedicated concurrency E2E с удерживаемым mock publisher и требованием `externalPublishCalls === 1`.

### STAB-002 — Scheduler slot uniqueness — DONE

SQLite schema: **v3**.

- UNIQUE `(project_id, weekday, time_hhmm, timezone)`;
- API duplicate → `409`;
- migration v2→v3 схлопывает исторические дубли;
- сохраняется наиболее поздний `last_fired_on`;
- queue grace-window остаётся действующим.

### STAB-003 — Browser / proxy security — DONE

- same-origin guard для browser mutation API;
- CSP / nosniff / frame deny / no-referrer / permissions / COOP;
- API `Cache-Control: no-store`;
- HSTS при HTTPS;
- `/public-media/*` остаётся cross-origin для внешних платформ;
- `TRUST_PROXY` — только explicit trusted proxy list;
- wildcard proxy trust запрещён;
- login throttling проверен за trusted proxy.

### STAB-004 — Adapter phase safety — DONE

**Telegram**
- local media read до public POST;
- timeout 30s;
- >4096 Unicode chars block на preflight;
- missing file = known failure;
- transport/5xx public POST = recovery;
- partial media+follow-up-text error сохраняет media message id.

**VK**
- upload preparation отделён от `wall.post`;
- unknown outcome возможен только на public phase;
- timeout 30s.

**MAX**
- 4000 Unicode chars;
- 12 media;
- strict HTTPS media URL validation;
- timeout 30s;
- unknown public POST → recovery.

**Instagram**
- child/parent container readiness до `media_publish`;
- `IN_PROGRESS/FINISHED/ERROR/EXPIRED` обработаны;
- preparation failure не создаёт ложный recovery;
- unknown `media_publish` → recovery.

### STAB-005 — Build identity — DONE

Release SHA передаётся как `BUILD_SHA` при `docker build` и зашивается в image:

```text
IMAGE_BUILD_SHA
org.opencontainers.image.revision
```

Production Release gate использует baked revision. Runtime `APP_BUILD_SHA` не является источником release identity.

### STAB-006 — CI simplification — DONE

В `.github/workflows` остаётся один файл:

```text
publikator-ci.yml
```

Один job `Acceptance` проверяет весь продукт последовательно. Большие test scenarios находятся в `scripts/`, а не спрятаны в YAML.

### STAB-007 — Repository hygiene — DONE

- старый PR #10 закрыт как superseded;
- старый PR #15 закрыт после fresh-port security logic;
- legacy SQLite-only backup route implementation удалена;
- legacy endpoint blocker `410` оставлен для явной совместимости.

## V1 live acceptance — RELEASE BLOCKER

Работать только с текущим release candidate `v1.0.0-rc.4` и его точным SHA.

1. Получить точный SHA: `git rev-parse HEAD`.
2. Проверить Release gate: встроенный build SHA должен совпадать с проверяемым commit.
3. Создать pre-acceptance full backup.
4. Выполнить `docs/LIVE_INTEGRATION_CHECKLIST.md` на реальных Telegram, VK, MAX и Instagram.
5. Записать четыре `LIVE PASS` на одном SHA.
6. Разобрать все `RECOVERY_NEEDED`.
7. Убедиться, что diagnostics не содержит ошибок.
8. После последнего PASS создать новый full backup.
9. Проверить restore release-state bundle на отдельной тестовой установке с тем же `APP_MASTER_KEY`.
10. Получить `Publikator CI / Acceptance = PASS` на том же commit.
11. Только после этого выпускать `v1.0.0`.

## Content Pipeline v2 — NEXT PRODUCT LANE

Главная следующая продуктовая задача — не ещё один адаптер соцсети, а полный жизненный цикл контента: массовый импорт, media resolution, API для ботов/AI, календарь и внешние коннекторы.

Полное ТЗ: [`CONTENT_PIPELINE_V2.md`](CONTENT_PIPELINE_V2.md).

Последовательность:

```text
CP2-001 Calendar / Content UX
CP2-002 CSV/XLSX Template v2
CP2-003 ZIP Content Bundle
CP2-004 Integration API v1
CP2-005 Google Sheets connector
CP2-006 Google Drive / Яндекс Диск media
CP2-007 AI Content Profile / producer
CP2-008 embedded images / optional autopilot
```

Критический архитектурный принцип: **Publikator — единственный source of truth.** Google Sheets, файлы, облачные диски и AI-агенты после импорта не участвуют в runtime публикации.

Целевой acceptance: импорт партии 100 постов + 150 изображений, корректный preview, отсутствие дублей при повторном импорте, отображение в календаре и дальнейшая публикация без обращения к исходной таблице/облаку.

## После Content Pipeline v2

- analytics там, где API площадки даёт стабильные данные;
- расширенные project policies/autopilot;
- дополнительные cloud/content connectors по фактической необходимости;
- формализация migration-файлов при дальнейшем росте SQLite schema.

## Архитектурный запрет

Нельзя добавлять n8n, Redis, RabbitMQ, Kafka, отдельный worker-container, отдельную runtime-БД или новый обязательный инфраструктурный сервис без ADR с доказанной необходимостью.

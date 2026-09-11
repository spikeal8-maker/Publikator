# Roadmap Publikator

## Текущий статус

**Версия:** `1.0.0-rc.4`

**Архитектура:** один production Docker-контейнер, Fastify, SQLite/WAL, local media storage, embedded scheduler, Telegram/VK/MAX/Instagram adapters.

Стабильный `v1.0.0` блокируется реальным live acceptance и финальным release gate. Следующий product-development разделён на три связанных слоя: **Content Pipeline v2 → Content Experience v3 → Editorial Workflow v4**.

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

# Product Development после publication core

## Layer 1 — Content Pipeline v2

Отвечает на вопрос: **как контент попадает в Publikator?**

Полное ТЗ: [`CONTENT_PIPELINE_V2.md`](CONTENT_PIPELINE_V2.md).

Issue: #26.

```text
CP2-001 Calendar / Content UX foundation
CP2-002 CSV/XLSX Template v2
CP2-003 ZIP Content Bundle
CP2-004 Integration API v1
CP2-005 Google Sheets connector
CP2-006 Google Drive / Яндекс Диск media
CP2-007 AI Content Profile / producer
CP2-008 embedded images / optional autopilot
```

Ключевой принцип: **Publikator — единственный source of truth.** Google Sheets, файлы, cloud drives и AI-агенты после импорта не участвуют в runtime публикации.

Целевой acceptance: 100 постов + 150 media assets, preview, отсутствие дублей при повторном импорте и дальнейшая публикация без обращения к исходной таблице/облаку.

## Layer 2 — Content Experience v3

Отвечает на вопрос: **что это за контент и как человек его видит?**

Полное ТЗ: [`CONTENT_EXPERIENCE_V3.md`](CONTENT_EXPERIENCE_V3.md).

Issue: #28.

```text
CX3-001 Visual Calendar
CX3-002 Content Library
CX3-003 Rich Media data model
CX3-004 Media Viewer / Player
CX3-005 Platform capability/preflight
CX3-006 Platform Preview v2
CX3-007 Dashboard + contrast/design tokens
CX3-008 Video / Story publication adapters
```

Обязательные форматы:

```text
Feed image
Carousel
Video
Short/Reel-like vertical video
Story image
Story video
Story sequence
```

Главный пользовательский экран — визуальный календарь Month/Week/Day/Agenda с thumbnail/poster, Content Inspector и platform-aware preview.

## Layer 3 — Editorial Workflow v4

Отвечает на вопрос: **как человек редактирует, согласовывает, переносит, шаблонизирует и удаляет будущий контент?**

Полное ТЗ: [`EDITORIAL_WORKFLOW_V4.md`](EDITORIAL_WORKFLOW_V4.md).

Issue: #30.

```text
EW4-001 Safe edit/delete lifecycle
EW4-002 Revision history
EW4-003 Canonical rich text editor
EW4-004 Platform rich-text compilers
EW4-005 Targets/defaults/platform options
EW4-006 Templates/snippets
EW4-007 Calendar editing
EW4-008 XLSX/Google Sheets Template v3
EW4-009 Integration API editorial contract
EW4-010 Editorial acceptance
```

Обязательные правила:

- future delete по умолчанию = Trash, не hard delete;
- удаление строки из Google Sheets не удаляет публикацию;
- изменение будущего READY-post инвалидирует старый preflight;
- canonical rich text не хранится как raw Telegram/MAX markup;
- project defaults не меняют уже созданный content;
- platform downgrade/unsupported feature показывается до READY;
- published historical content не переписывается молча.

## Рекомендуемый порядок foundation-разработки

Не обязательно ждать полного завершения одного слоя, чтобы начать следующий. Правильная последовательность foundation:

```text
1. CP2 external_id / ingestion metadata / media bundle
2. CX3 visual calendar shell / Content Inspector
3. EW4 editorial lifecycle / Trash / revisions
4. EW4 canonical rich text + platform compilers
5. CP2 Integration API + Template v3
6. CX3 video/story player + rich media model
7. EW4 templates/default targets/calendar editing
8. Google Sheets/Drive/Yandex connectors
9. AI producer/content profiles
10. platform-specific Stories/Shorts live adapters
```

## Целевой пользовательский workflow

```text
Manual / XLSX / Sheets / API / AI
                ↓
             Inbox
                ↓
        Draft / Template
                ↓
      Edit rich content/media
                ↓
       Select target accounts
                ↓
      Platform-aware preview
                ↓
        Review / Approve
                ↓
              READY
                ↓
      Visual Calendar / Queue
                ↓
             Publish
                ↓
        Journal / Results
```

Пользователь должен в любой момент открыть будущую публикацию и без знания API понять:

1. что выйдет;
2. где выйдет;
3. когда выйдет;
4. как будет выглядеть;
5. что можно изменить;
6. кто/что последним изменило запись;
7. как перенести, продублировать, архивировать или удалить её.

## После этих трёх слоёв

- analytics там, где API площадки даёт стабильные данные;
- расширенные project policies/autopilot;
- дополнительные cloud/content connectors по фактической необходимости;
- roles/permissions/editorial assignment при реальной необходимости;
- формализация migration-файлов при дальнейшем росте SQLite schema.

## Архитектурный запрет

Нельзя добавлять n8n, Redis, RabbitMQ, Kafka, отдельный worker-container, отдельную runtime-БД или новый обязательный инфраструктурный сервис без ADR с доказанной необходимостью.

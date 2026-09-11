# Publikator

Self-hosted система автопубликации контента в **Telegram, VK, MAX и Instagram**.

Publikator намеренно построен как **модульный монолит**: один репозиторий, один production Docker-контейнер, один Web UI, одна SQLite/WAL база, локальное media storage и встроенный scheduler. n8n, Redis, RabbitMQ, Kafka, отдельный worker и отдельная runtime-БД не требуются.

Текущая версия: **1.0.0-rc.4**. Стабильный `v1.0.0` выпускается только после реального live acceptance всех четырёх площадок на одном release build.

## Основной контур

```text
Web UI / REST API
       │
       ├── Posts / Projects / Accounts
       ├── Media pipeline
       ├── Scheduler AT / QUEUE
       ├── Publication state machine
       ├── Diagnostics / Release gate
       └── Backup / Restore
              │
           SQLite/WAL + data/media
              │
    Telegram │ VK │ MAX │ Instagram
```

Каждая площадка имеет отдельный target state. Ошибка одной соцсети не заставляет публиковать остальные повторно.

## Что реализовано

- проекты и независимые очереди контента;
- редактор поста с отдельным `override_text` для каждого аккаунта/площадки;
- live preview площадок;
- обязательное изображение: пост без media не может стать `READY`;
- JPEG normalization, EXIF orientation, размеры, SHA-256 и дедупликация;
- явный `media.sort_order` и изменение порядка до публикации;
- Telegram: single image / media group до 10 изображений;
- VK: загрузка нескольких изображений и `wall.post` с `guid=post.id`;
- MAX: до 12 изображений через публичные HTTPS URL;
- Instagram: single JPEG и carousel 2–10 JPEG;
- проверка подключения и прав до сохранения/использования аккаунта;
- ручная публикация;
- `AT` — точная дата/время;
- `QUEUE` — проектные недельные слоты с timezone и grace-window;
- уникальность schedule slots `(project, weekday, time, timezone)`;
- platform-specific preflight перед `READY` и перед внешним publish;
- retry только для известных временных ошибок;
- `RECOVERY_NEEDED` при небезопасном для автоматического повтора исходе;
- atomic SQLite claim перед внешним POST: конкурентные вызовы одного target не создают два запроса;
- immutable content после частичной/полной публикации;
- журнал событий и retention;
- диагностика SQLite/media/scheduler/storage/public URL/recovery;
- CSV/XLSX export/import контент-плана с dry-run и SHA-256 привязкой apply;
- единый full backup `.tgz`: SQLite + media + manifest;
- staging restore, проверка SHA/integrity/key fingerprint, pre-restore backup и rollback;
- Release gate с persistent live evidence;
- AES-256-GCM для credentials;
- same-origin guard для browser mutations и security headers;
- явная конфигурация доверенного reverse proxy;
- release `v1.0.0-rc.4`: SQLite schema v3; `main` vNext после M0-002: schema v4;
- один GitHub Actions pipeline: **`Publikator CI / Acceptance`**.

## Для coding agents

Перед любым изменением кода агент начинает с [AGENTS.md](AGENTS.md). Этот файл задаёт экономный порядок чтения контекста, правило **один checkpoint = одна ветка = один PR**, порядок тестов и обязательный короткий handoff для следующего агента. Нормативное vNext-ТЗ: [docs/VNEXT_TECHNICAL_SPEC.md](docs/VNEXT_TECHNICAL_SPEC.md).
## Установка из GitHub

Для обычного пользователя рекомендуемый путь — использовать системный launcher. **Docker сам проект не устанавливает:** Docker Desktop/Engine и Git являются предварительными требованиями. Launcher проверяет их, а затем полностью создаёт runtime Publikator.

### Windows 10/11 + Docker Desktop

Скопируйте весь блок в PowerShell:

```powershell
git clone https://github.com/spikeal8-maker/Publikator.git
cd Publikator
git checkout v1.0.0-rc.4
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-windows.ps1
```

Windows launcher:

1. ищет `docker.exe` в `PATH`;
2. если его там нет — проверяет стандартную папку Docker Desktop;
3. проверяет `docker compose` v2;
4. если Docker Desktop установлен, но Engine ещё не запущен — запускает Docker Desktop и ждёт Engine;
5. требует режим **Linux containers**;
6. проверяет Git и точный commit SHA;
7. на первой установке проверяет свободен ли порт `8080`;
8. создаёт `.env` со случайными `ADMIN_PASSWORD` и `APP_MASTER_KEY`;
9. создаёт Docker named volume, собирает image и запускает контейнер;
10. ждёт состояния Docker `healthy` и выводит локальный URL.

Если Docker Desktop отсутствует, launcher **не устанавливает Docker автоматически** и завершится с понятной ошибкой. Docker — системная зависимость.

### Linux x86_64 + Docker Engine

Скопируйте весь блок в shell:

```bash
git clone https://github.com/spikeal8-maker/Publikator.git
cd Publikator
git checkout v1.0.0-rc.4
bash scripts/deploy-linux.sh
```

Linux launcher проверяет `docker`, Compose v2, доступность Docker daemon, права текущего пользователя на Docker, режим Linux containers и Git checkout. Затем выполняет полный build/start/health flow.

### Что получится после запуска

По умолчанию Publikator доступен только на этом компьютере:

```text
http://127.0.0.1:8080
```

Runtime-данные находятся в Docker named volume `publikator-data`, поэтому обычный `docker compose down` их не удаляет. Существующие секреты и deployment-настройки в `.env` при обновлении сохраняются; launcher обновляет только `BUILD_SHA` до текущего Git commit.

Для публичного сервера рекомендуется оставить Publikator на `127.0.0.1:8080` и публиковать его наружу через nginx/Caddy/другой HTTPS reverse proxy.

Полная инструкция, обновление, смена порта, сеть и backup: [`docs/DEPLOY_DOCKER.md`](docs/DEPLOY_DOCKER.md).

### Ручной режим

Если нужен ручной запуск без launcher:

```bash
cp .env.example .env
```

Обязательно замените:

```env
PUBLIC_BASE_URL=https://publisher.example.ru
ADMIN_PASSWORD=<сильный пароль>
APP_MASTER_KEY=<случайный секрет минимум 32 символа>
```

`APP_MASTER_KEY` нельзя терять: он не входит в backup и нужен для расшифровки credentials после restore.

Для обычной разработки:

```bash
docker compose up -d --build
```

Для release/live acceptance SHA должен быть зашит в image на этапе build:

```bash
export BUILD_SHA="$(git rev-parse HEAD)"
docker compose build --no-cache
docker compose up -d
```

Dockerfile сохраняет этот SHA как:

```text
IMAGE_BUILD_SHA
org.opencontainers.image.revision
```

В production Release gate использует именно встроенную revision образа. Переданный при запуске `APP_BUILD_SHA` не является release identity.

## HTTPS и reverse proxy

Publikator внутри контейнера слушает HTTP `:8080`. TLS обычно завершается существующим reverse proxy/ingress сервера.

MAX и Instagram требуют, чтобы `PUBLIC_BASE_URL` был реально доступен из интернета по HTTPS, потому внешняя площадка должна получить `/public-media/...` без cookie и VPN.

Если приложение стоит за reverse proxy и нужно учитывать реальный IP клиента для login throttling, задайте **только доверенные proxy адреса/сети**:

```env
TRUST_PROXY=127.0.0.1,172.16.0.0/12
```

`TRUST_PROXY=true` и `TRUST_PROXY=*` намеренно запрещены.

## Публикационная безопасность

Перед внешним POST target атомарно захватывается SQLite compare-and-set:

```text
PENDING / RETRY / FAILED
          │
          ├── CAS успешен → PUBLISHING → внешний API
          │
          └── CAS неуспешен → другой вызов уже владеет target → STOP
```

Это защищает от double-click, двух вкладок, ручного запуска рядом со scheduler и stale retry.

После неизвестного исхода публичного POST target получает `RECOVERY_NEEDED`. Обычный retry для этого состояния запрещён. Оператор вручную проверяет площадку и выбирает:

- **Публикация найдена** → `PUBLISHED` без нового POST;
- **Публикации точно нет** → `FAILED`, после чего разрешён один обычный retry.

## Scheduler

Поддерживаются три режима поста:

```text
MANUAL — только ручная публикация
AT     — конкретная дата/время
QUEUE  — следующий подходящий slot проекта
```

Для `QUEUE` действует `QUEUE_SLOT_GRACE_MINUTES` (по умолчанию 60). Краткий restart/maintenance не теряет слот; после завершения grace-window stale публикация не выполняется.

Одинаковые slots физически запрещены UNIQUE-индексом. При миграции schema v2→v3 исторические дубли схлопываются детерминированно, при этом сохраняется наиболее поздний `last_fired_on`.

## Площадки

### Telegram

- media group: до 10 изображений;
- caption: до 1024 Unicode-символов;
- 1025–4096: media + отдельный `sendMessage`;
- >4096 блокируется preflight;
- local file read выполняется до публичного POST;
- external request timeout: 30 секунд;
- если media уже опубликовано, а follow-up text не подтверждён, используется `RECOVERY_NEEDED` с исходным media `message_id`.

### VK

Подготовительные шаги `getWallUploadServer → upload → saveWallPhoto` не создают запись стены. Их временные ошибки можно безопасно повторять. Только `wall.post` является публичной фазой; неопределённый исход этой фазы требует recovery.

### MAX

- до 12 изображений;
- текст до 4000 Unicode-символов;
- каждому media соответствует один валидный HTTPS URL;
- `POST /messages` имеет timeout 30 секунд и сразу является публичной фазой.

### Instagram

- single JPEG или carousel 2–10 JPEG;
- каждый child/parent media container ожидается до `status_code=FINISHED`;
- `ERROR/EXPIRED` останавливают подготовку;
- неопределённый исход только после начала `media_publish` требует recovery.

Подробно: [`docs/PLATFORMS.md`](docs/PLATFORMS.md).

## Данные

Всё runtime-состояние находится в одном volume:

```text
data/
  publikator.sqlite
  media/
  backups/
```

SQLite работает в WAL mode. Release `v1.0.0-rc.4` использует schema **3**; ветка `main` vNext после M0-002 использует schema **4**.

## Backup / restore

Единственный рабочий backup-формат:

```text
publikator-....tgz
  manifest.json
  publikator.sqlite
  media/
```

Backup проверяет согласованность SQLite/media и SHA-256. Restore дополнительно проверяет структуру tar, `APP_MASTER_KEY` fingerprint, SQLite integrity/schema и media manifest. Перед заменой данных создаётся `pre-restore` bundle; применение выполняется при следующем старте **до открытия runtime SQLite**.

Legacy `/api/backups` не создаёт SQLite-only копии и возвращает `410 Gone`.

Подробно: [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md).

## Контент-план

CSV/XLSX содержит:

```text
project
title
body
schedule_mode
scheduled_at
targets
platform_overrides
media_references
```

Импорт всегда начинается с dry-run. Apply разрешён только для того же файла по SHA-256 и создаёт исключительно `DRAFT`.

Подробно: [`docs/CONTENT_PLAN.md`](docs/CONTENT_PLAN.md).

## CI

В репозитории существует один workflow:

```text
.github/workflows/publikator-ci.yml
```

Один job **Acceptance** последовательно проверяет:

```text
npm ci / typecheck / build / frontend syntax
npm audit
legacy + schema-v3 migrations
HTTP CRUD / recovery / diagnostics
browser security / trusted proxy
scheduler reliability
atomic publication concurrency
Telegram / VK / MAX / Instagram adapters
CSV/XLSX content-plan
backup API / release gate
pinned Docker base + baked revision + non-root runtime
cross-platform Docker Compose fresh install / persistence
production Docker backup → mutation → restore → restart
```

Если любой шаг падает, `Publikator CI / Acceptance` не проходит.

## Release gate и stable V1

`1.0.0-rc.4` — кандидат, а не стабильный V1. Перед `v1.0.0` требуется:

1. собрать финальный commit с `BUILD_SHA=$(git rev-parse HEAD)`;
2. выполнить [`docs/LIVE_INTEGRATION_CHECKLIST.md`](docs/LIVE_INTEGRATION_CHECKLIST.md) для Telegram, VK, MAX и Instagram;
3. записать четыре `LIVE PASS` на одном SHA;
4. убедиться, что нет `RECOVERY_NEEDED` и diagnostics не содержит ошибок;
5. создать full backup **после** последнего live PASS;
6. получить `Publikator CI / Acceptance = PASS` на том же release commit;
7. только затем выпустить tag/release `v1.0.0`.

## Правила архитектуры

Publikator остаётся одним production-приложением. Добавление n8n, Redis, RabbitMQ, Kafka, отдельного worker, отдельной runtime-БД или нового обязательного инфраструктурного сервиса требует отдельного ADR с доказанной необходимостью.

См. также:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/DEVELOPMENT_RULES.md`](docs/DEVELOPMENT_RULES.md)
- [`docs/ROADMAP.md`](docs/ROADMAP.md)
- [`docs/SCHEDULER.md`](docs/SCHEDULER.md)
- [`docs/DEPLOY_DOCKER.md`](docs/DEPLOY_DOCKER.md)
- [`docs/LIVE_INTEGRATION_CHECKLIST.md`](docs/LIVE_INTEGRATION_CHECKLIST.md)


## vNext development contract

Authoritative technical specification for further product development: [`docs/VNEXT_TECHNICAL_SPEC.md`](docs/VNEXT_TECHNICAL_SPEC.md).

Supporting product specifications:

- [`docs/CONTENT_PIPELINE_V2.md`](docs/CONTENT_PIPELINE_V2.md)
- [`docs/CONTENT_EXPERIENCE_V3.md`](docs/CONTENT_EXPERIENCE_V3.md)
- [`docs/EDITORIAL_WORKFLOW_V4.md`](docs/EDITORIAL_WORKFLOW_V4.md)

Release V1 is maintained separately in `release/1.0`; vNext development continues in `main`.


### Show the generated administrator password

Windows PowerShell:

```powershell
Get-Content .env | Select-String "^ADMIN_PASSWORD="
```

Linux:

```bash
grep '^ADMIN_PASSWORD=' .env
```

Do not publish `.env`; keep `APP_MASTER_KEY` separately and securely.

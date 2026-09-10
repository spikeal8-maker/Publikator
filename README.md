# Publikator

Единая self-hosted система автопубликации контента в **Telegram, VK, MAX и Instagram**.

Publikator специально построен как **модульный монолит**: один репозиторий, один Docker-контейнер, один интерфейс, одна SQLite-база и встроенный scheduler. n8n, Redis, RabbitMQ и отдельный worker не нужны.

Текущая версия: **0.8.0-rc.1** — release candidate. Стабильный `v1.0.0` намеренно не создаётся до реального live acceptance всех четырёх заявленных площадок.

## Что уже реализовано

- Web UI с авторизацией и ограничением перебора пароля;
- проекты и независимые контентные очереди;
- создание и редактирование публикаций;
- явный выбор конкретных подключённых соцсетей для каждого поста;
- обязательное изображение перед переводом поста в `READY`;
- обязательный platform preflight перед `READY` и ручной публикацией;
- загрузка изображений, EXIF rotation, нормализация в JPEG и локальное хранение;
- SHA-256 дедупликация одинаковых изображений внутри поста;
- управляемый порядок изображений с сохранением `sort_order`;
- Instagram carousel до 10 изображений;
- Telegram media group до 10 изображений;
- MAX до 12 изображений;
- формы подключения Telegram / VK / MAX / Instagram без ручного JSON;
- проверка токена, назначения и доступных прав через официальные API до сохранения подключения;
- шифрование credentials AES-256-GCM;
- отдельный статус публикации для каждой площадки;
- отдельный текст для каждой целевой площадки/аккаунта;
- live preview публикации в Web UI;
- ручная публикация;
- публикация по точной дате (`AT`);
- проектная очередь публикаций (`QUEUE`) со слотами по дням недели и timezone;
- retry только для явно временных API-ошибок;
- `RECOVERY_NEEDED` при неопределённом результате внешнего POST;
- обычный retry не может обойти `RECOVERY_NEEDED`: требуется отдельное ручное решение после проверки площадки;
- запрет изменения текста, площадок и медиа после частичной публикации;
- журнал событий;
- автоматический retention журнала и backup bundles без отдельного cron/worker;
- CSV/XLSX экспорт контент-плана;
- CSV/XLSX импорт с обязательным dry-run, построчной валидацией и SHA-256 привязкой apply к проверенному файлу;
- полные `.tgz` backup bundles: SQLite + media + manifest;
- безопасный restore через staging, pre-restore backup и перезапуск до открытия SQLite;
- экран **Диагностика**: SQLite, scheduler, media reconciliation, disk space, PUBLIC_BASE_URL, backups, retention и recovery;
- экран **Release gate** с persistent live evidence по четырём площадкам;
- SQLite schema v2 с блокировкой запуска на более новой неизвестной схеме;
- Docker HEALTHCHECK;
- CI для компиляции, frontend, миграций, Docker/runtime/restore, content-plan, operations и release gate;
- Docker deployment.

## Быстрый запуск

```bash
cp .env.example .env
```

Задайте как минимум:

```env
PUBLIC_BASE_URL=https://publisher.example.ru
ADMIN_PASSWORD=very-strong-admin-password
APP_MASTER_KEY=very-long-random-secret-at-least-32-characters
```

Затем:

```bash
docker compose up -d --build
```

Интерфейс по умолчанию: `http://localhost:8080`.

> Для MAX и Instagram `PUBLIC_BASE_URL` должен быть реальным публичным HTTPS-адресом: внешняя площадка должна суметь скачать изображение из `/public-media/...`.

## Данные

Весь runtime state лежит в `./data`:

```text
data/
  publikator.sqlite
  media/
  backups/
```

`APP_MASTER_KEY` хранится **вне** `data/` и backup bundle. Этот ключ нужен для расшифровки credentials соцсетей. Не меняйте и не теряйте его: восстановление bundle с другим ключом намеренно блокируется.

## Release gate перед V1

`0.8.0-rc.1` добавляет встроенный release gate. Он не подменяет реальный тест соцсетей mock-результатами.

Перед live acceptance release build должен знать свой полный Git SHA:

```bash
git rev-parse HEAD
```

Полученный 40-символьный SHA задаётся в `.env`:

```env
APP_BUILD_SHA=0123456789abcdef0123456789abcdef01234567
RELEASE_TARGET_VERSION=1.0.0
```

В production используйте **фактический SHA команды `git rev-parse HEAD`**, а не пример из документации.

Для Telegram, VK, MAX и Instagram оператор выполняет `docs/LIVE_INTEGRATION_CHECKLIST.md`, после чего фиксирует результат в разделе **Release gate**. `LIVE PASS` требует имя тестового аккаунта, полный commit SHA и явное текстовое подтверждение.

Gate остаётся заблокированным, пока одновременно не выполнены все условия:

- четыре площадки имеют `PASS`;
- все PASS относятся к одному commit SHA;
- этот SHA совпадает с `APP_BUILD_SHA` запущенного контейнера;
- diagnostics не содержит ошибок;
- нет `RECOVERY_NEEDED`;
- scheduler не хранит последнюю ошибку;
- `PUBLIC_BASE_URL` является HTTPS;
- после последней live-проверки создан новый полный `.tgz` backup.

Даже после зелёного runtime/live gate стабильный тег создаётся только после зелёного automated CI на том же commit.

Подробно: [`docs/LIVE_INTEGRATION_CHECKLIST.md`](docs/LIVE_INTEGRATION_CHECKLIST.md), [`docs/UPGRADE_TO_V1.md`](docs/UPGRADE_TO_V1.md), [`docs/RELEASE_NOTES_V1.md`](docs/RELEASE_NOTES_V1.md).

## Диагностика

Раздел **«Диагностика»** собирает read-only снимок эксплуатационного состояния:

- версию приложения, Node.js и uptime;
- SQLite `quick_check`, `journal_mode`, schema version, размеры DB/WAL и counts;
- состояние scheduler и сведения о последнем tick;
- сверку media SQLite ↔ файлы на диске, включая missing/orphan/size mismatch;
- свободное место файловой системы `DATA_DIR`;
- готовность `PUBLIC_BASE_URL` для активных MAX/Instagram;
- активные аккаунты, `RECOVERY_NEEDED`, maintenance;
- backup bundles и retention policy.

Диагностика не возвращает `APP_MASTER_KEY`, `ADMIN_PASSWORD` или расшифрованные credentials.

## RECOVERY_NEEDED

`RECOVERY_NEEDED` означает, что после начала внешнего POST возникла ошибка с неопределённым исходом: публикация могла реально появиться на площадке. Поэтому обычный retry заблокирован и не может автоматически сбросить это состояние.

В Web UI нужно нажать **«Разобрать»**, затем вручную проверить площадку и выбрать один из двух вариантов:

- **Публикация найдена** — target становится `PUBLISHED` без нового внешнего POST; при желании можно сохранить external ID/URL.
- **Публикации точно нет** — target становится `FAILED`, и только после этого обычный ручной retry снова доступен. Сам retry автоматически не запускается.

Оба решения записываются в журнал вместе с предыдущей ошибкой.

## Retention

Retention выполняется тем же встроенным scheduler, без второго процесса:

```env
EVENT_RETENTION_DAYS=180
BACKUP_RETENTION_COUNT=30
```

`EVENT_RETENTION_DAYS=0` отключает автоочистку событий. История постов, у которых остаётся активный `RECOVERY_NEEDED`, от удаления защищена.

`BACKUP_RETENTION_COUNT=0` отключает автоочистку `.tgz` backup bundles. При включённой политике сохраняются N самых свежих bundle; дополнительно сохраняется самый свежий `pre-restore` bundle, даже если он оказался за пределами N.

Начиная с `0.8.0-rc.1`, `docker-compose.yml` явно передаёт обе retention-переменные в контейнер; пользовательские значения из `.env` больше не теряются.

## Контент-план CSV/XLSX

Раздел **«Контент-план»** позволяет выгрузить все публикации или один проект в CSV/XLSX, отредактировать таблицу и загрузить её обратно.

Перед импортом всегда выполняется dry-run: Publikator проверяет каждую строку, проект, режим расписания, целевые аккаунты, platform overrides и media references **без записи в БД**. Apply разрешается только при нуле ошибок и повторно проверяет SHA-256 того же файла под эксклюзивным maintenance gate.

Импорт никогда не публикует автоматически: каждая строка создаёт новый `DRAFT`.

Табличная схема и правила: [`docs/CONTENT_PLAN.md`](docs/CONTENT_PLAN.md).

## Полные резервные копии

Backup bundle имеет вид:

```text
publikator-2026-09-09T20-00-00-000Z-manual.tgz
  manifest.json
  publikator.sqlite
  media/
```

Перед созданием snapshot приложение кратко входит во встроенный maintenance mode: новые изменения и scheduler не пересекаются с копированием, а уже активную публикацию backup прервать не может.

Перед восстановлением проверяются формат/версия bundle, fingerprint `APP_MASTER_KEY`, SHA-256 SQLite/media, `PRAGMA integrity_check`, обязательные таблицы и безопасность tar entries.

После успешной проверки Publikator сначала создаёт полный `pre-restore` backup текущего состояния, затем помещает восстановление в `.restore-pending`, делает graceful restart и применяет его **до открытия runtime SQLite**. Если файловая замена не завершается, startup-код пытается вернуть прежние SQLite/WAL/SHM/media из локального rollback.

Подробно: [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md).

## Media pipeline

Изображения не хранятся в стороннем S3 и не требуют отдельного сервиса. Publikator приводит их к JPEG, сохраняет размеры и SHA-256, отсекает дубли внутри одного поста и хранит явный порядок. Порядок можно менять до начала публикации; после `PUBLISHING` / `PARTIAL` / `PUBLISHED` он замораживается вместе с остальным контентом.

Перед `READY` каждый выбранный adapter проверяет свои локальные требования. Ошибка одной площадки не маскируется общей надписью: API возвращает конкретный аккаунт, площадку и причину блокировки.

## Архитектура

Подключения и adapter-поведение: [`docs/PLATFORMS.md`](docs/PLATFORMS.md).

Архитектура и обязательные правила для coding agents: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/DEVELOPMENT_RULES.md`](docs/DEVELOPMENT_RULES.md).

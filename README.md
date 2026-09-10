# Publikator

Единая self-hosted система автопубликации контента в **Telegram, VK, MAX и Instagram**.

Publikator специально построен как **модульный монолит**: один репозиторий, один Docker-контейнер, один интерфейс, одна SQLite-база и встроенный scheduler. n8n, Redis, RabbitMQ и отдельный worker не нужны.

Текущая версия: **0.6.1**.

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
- нормальные формы подключения Telegram / VK / MAX / Instagram без ручного JSON;
- проверка токена, назначения и доступных прав через официальные API до сохранения подключения;
- шифрование credentials AES-256-GCM;
- отдельный статус публикации для каждой площадки;
- отдельный текст для каждой целевой площадки/аккаунта;
- live preview публикации в Web UI;
- ручная публикация;
- публикация по точной дате (`AT`);
- проектная очередь публикаций (`QUEUE`) со слотами по дням недели и timezone;
- retry только для явно временных API-ошибок;
- `RECOVERY_NEEDED` при неопределённом результате внешнего POST — автоматического дубля не будет;
- запрет изменения текста, площадок и медиа после частичной публикации;
- журнал событий;
- CSV/XLSX экспорт контент-плана;
- CSV/XLSX импорт с обязательным dry-run, построчной валидацией и SHA-256 привязкой apply к проверенному файлу;
- полные `.tgz` backup bundles: SQLite + media + manifest;
- безопасный restore через staging, pre-restore backup и перезапуск до открытия SQLite;
- Docker HEALTHCHECK;
- CI проверяет компиляцию, frontend JS, миграции, Docker build, runtime/API smoke и полный backup/restore cycle;
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

Перед восстановлением проверяются:

- формат и версия backup;
- версия SQLite-схемы;
- fingerprint текущего `APP_MASTER_KEY`;
- SHA-256 SQLite;
- `PRAGMA integrity_check`;
- обязательные таблицы;
- список, размеры и SHA-256 каждого media-файла;
- отсутствие неизвестных/лишних файлов;
- безопасность tar entries: path traversal и links запрещены.

После успешной проверки Publikator сначала создаёт полный `pre-restore` backup текущего состояния, затем помещает восстановление в `.restore-pending`, делает graceful restart и применяет его **до открытия runtime SQLite**. Если файловая замена не завершается, startup-код пытается вернуть прежние SQLite/WAL/SHM/media из локального rollback.

Подробно: [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md).

## Media pipeline

Изображения не хранятся в стороннем S3 и не требуют отдельного сервиса. Publikator приводит их к JPEG, сохраняет размеры и SHA-256, отсекает дубли внутри одного поста и хранит явный порядок. Порядок можно менять до начала публикации; после `PUBLISHING` / `PARTIAL` / `PUBLISHED` он замораживается вместе с остальным контентом.

Перед `READY` каждый выбранный adapter проверяет свои локальные требования. Ошибка одной площадки не маскируется общей надписью: API возвращает конкретный аккаунт, площадку и причину блокировки.

## Параметры площадок

См. [`docs/PLATFORMS.md`](docs/PLATFORMS.md).

## Архитектура

См. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) и обязательные правила для coding agents в [`docs/DEVELOPMENT_RULES.md`](docs/DEVELOPMENT_RULES.md).

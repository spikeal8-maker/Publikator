# Roadmap Publikator

## Текущая базовая версия

Рабочий модульный монолит: один production-контейнер, Fastify, SQLite/WAL, локальное media storage, встроенный scheduler, Telegram/VK/MAX/Instagram adapters, явный выбор целевых аккаунтов, retry/recovery, журнал событий и шифрование credentials.

Уже закрыто:

1. Platform-specific формы подключения без ручного JSON.
2. Проверка соединения и прав до сохранения аккаунта.
3. Защита от автоматических дублей через консервативный `RECOVERY_NEEDED`.
4. Блокировка изменения контента после частичной/полной публикации.
5. Базовый CI smoke-flow и Docker healthcheck.
6. Backend-контракт отдельного текста для каждой целевой площадки.

## V0.4 — редактор публикации

Функциональный объём V0.4 закрыт:

1. UI редактирования и сброса `override_text` для каждого аккаунта.
2. Live preview Telegram / VK / MAX / Instagram с реальным изображением поста.
3. Счётчик длины итогового текста и предупреждения media-политики площадки.
4. Явное отображение `Базовый текст` / `Свой текст` и выбранности площадки.
5. Сохранённое `scheduled_at` корректно возвращается в поле `datetime-local`; дата скрыта вне режима `AT`.
6. `PUBLISHING` / `PARTIAL` / `PUBLISHED` визуально блокируются от редактирования так же, как на backend.
7. CI проверяет синтаксис UI-модуля и API-flow сохранения platform override.

## V0.5 — media pipeline

Функциональный объём V0.5 закрыт:

1. Instagram: один JPEG или carousel из 2–10 JPEG через child containers → `CAROUSEL` parent → `media_publish`.
2. Platform-specific preflight обязателен до `READY` и повторно выполняется перед ручной/автоматической публикацией.
3. Один builder формирует `PublishInput` и для preflight, и для реального adapter — две логики не расходятся.
4. Изображения нормализуются в JPEG с учётом EXIF orientation; сохраняются фактические width/height, размер и SHA-256.
5. Одинаковое нормализованное изображение не добавляется в один пост повторно.
6. В `media` появился мигрируемый `sort_order`; старые установки получают детерминированный порядок по прежнему `created_at`.
7. Порядок можно менять через API и Web UI; после удаления он автоматически уплотняется.
8. Preview показывает первый кадр, количество остальных изображений, размеры и aspect ratio; Instagram явно предупреждает, что первый кадр задаёт основу кадрирования carousel.
9. CI smoke-flow проверяет дедупликацию, порядок, перестановку, успешный Telegram preflight и блокировку `READY` при невалидном MAX public media URL.

Точный набор дополнительных aspect-ratio ограничений каждой платформы следует добавлять только после проверки по актуальной официальной документации/реальному API, без догадок и «универсальных» жёстких чисел.

## V0.6 — переносимость и данные

### V0.6A — backup / restore — закрыто

1. Полный `.tgz` bundle: согласованный SQLite snapshot + media + versioned manifest.
2. SHA-256 SQLite и каждого media, `PRAGMA integrity_check`, обязательные таблицы и schema compatibility.
3. Fingerprint `APP_MASTER_KEY` без включения самого секрета в bundle.
4. Защищённая распаковка untrusted tar: path traversal, links, duplicate/unknown entries и лишние media запрещены.
5. Maintenance gate исключает пересечение backup/restore с активной публикацией и незавершёнными API-операциями.
6. Автоматический `pre-restore` backup текущего состояния.
7. Restore через `.restore-pending` и graceful restart; SQLite заменяется до `import('./db.js')`.
8. Файловый rollback SQLite/WAL/SHM/media при ошибке применения pending restore.
9. API create/list/download/restore/upload и Web UI с обязательным ручным подтверждением `RESTORE`.
10. CI проверяет полный цикл `backup → mutation → restore → Docker restart → rollback state/media`.

### V0.6B — контент-план — следующий этап

1. Экспорт контент-плана в CSV.
2. Импорт CSV с dry-run preview и валидацией строк до записи в БД.
3. XLSX import/export без зависимости от LibreOffice/Google Sheets runtime.
4. Явная схема колонок: project, title, body, schedule mode/time, targets, platform overrides, media references.
5. Google Sheets только как необязательный импорт/экспорт в будущем, никогда как runtime-зависимость.

## V0.7 — эксплуатация и test hardening

1. Полные CRUD/scheduler/publisher E2E-тесты на временной SQLite и mock-adapters.
2. Экран диагностики: версия приложения, состояние БД, scheduler, media storage, PUBLIC_BASE_URL.
3. Более удобная ручная обработка `RECOVERY_NEEDED`.
4. Retention журнала событий и backup policy.
5. Live integration checklist для Telegram/VK/MAX/Instagram перед выпуском стабильного V1.

## После стабильного V1

- статистика публикаций там, где официальные API позволяют получать её стабильно;
- генерация черновиков и изображений через внешние AI API как подключаемая функция;
- интеграции с ASSA Lab / IZO только через стабильный внутренний HTTP API Publikator.

## Архитектурный запрет

Любой новый инфраструктурный компонент требует отдельного ADR и не должен нарушать правило одного production-контейнера без доказанной необходимости. n8n, Redis, RabbitMQ, Kafka, отдельный worker-контейнер и отдельная runtime-БД по умолчанию запрещены.

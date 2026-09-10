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

### V0.6B — контент-план — закрыто

1. CSV export всех проектов или одного проекта; UTF-8 BOM, `;`, корректные quoted/multiline cells.
2. CSV import распознаёт `;`, `,` и tab и использует тот же versioned parser/validator, что XLSX.
3. XLSX import/export выполняется непосредственно Node.js без LibreOffice/Google Sheets/Python runtime.
4. Схема v1: `project`, `title`, `body`, `schedule_mode`, `scheduled_at`, `targets`, `platform_overrides`, `media_references`.
5. Target refs поддерживают несколько аккаунтов одной площадки через `accountId` с fallback на уникальную пару `platform + name`.
6. Dry-run preview не меняет БД, показывает ошибки/предупреждения по каждой строке и выдаёт SHA-256 проверенного файла.
7. Apply требует явный `IMPORT`, тот же SHA-256 и повторную полную валидацию под exclusive maintenance gate.
8. Media references проверяются по SQLite, наличию файла, размеру и SHA-256; при импорте нормализованные bytes копируются в новый post без повторного JPEG encode.
9. Любой импорт создаёт только `DRAFT`; автоматический `READY`/publish из таблицы запрещён.
10. При ошибке apply созданные этим импортом posts/media очищаются.
11. Web UI `Контент-план`: project-scoped export CSV/XLSX, выбор файла, dry-run, post-row diagnostics и подтверждаемый apply.
12. Regression CI проверяет настоящий CSV/XLSX round-trip с `;`, кавычками, multiline body/override, расписанием, target и media SHA, а также негативную строку `AT` без даты.
13. Google Sheets остаётся только возможным необязательным import/export connector после V1 и не является runtime-зависимостью.

## V0.7 — эксплуатация и test hardening — следующий этап

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

# Roadmap Publikator

## Текущая базовая версия

Рабочий модульный монолит: один production-контейнер, Fastify, SQLite/WAL, локальное media storage, встроенный scheduler, Telegram/VK/MAX/Instagram adapters, явный выбор целевых аккаунтов, retry/recovery, журнал событий и шифрование credentials.

## V0.4 — редактор публикации — закрыто

1. UI редактирования и сброса `override_text` для каждого аккаунта.
2. Live preview Telegram / VK / MAX / Instagram с реальным изображением поста.
3. Счётчик длины итогового текста и предупреждения media-политики площадки.
4. Явное отображение `Базовый текст` / `Свой текст` и выбранности площадки.
5. Сохранённое `scheduled_at` корректно возвращается в поле `datetime-local`; дата скрыта вне режима `AT`.
6. `PUBLISHING` / `PARTIAL` / `PUBLISHED` визуально блокируются от редактирования так же, как на backend.
7. CI проверяет синтаксис UI-модуля и API-flow сохранения platform override.

## V0.5 — media pipeline — закрыто

1. Instagram: один JPEG или carousel из 2–10 JPEG через child containers → `CAROUSEL` parent → `media_publish`.
2. Platform-specific preflight обязателен до `READY` и повторно выполняется перед ручной/автоматической публикацией.
3. Один builder формирует `PublishInput` и для preflight, и для реального adapter — две логики не расходятся.
4. Изображения нормализуются в JPEG с учётом EXIF orientation; сохраняются фактические width/height, размер и SHA-256.
5. Одинаковое нормализованное изображение не добавляется в один пост повторно.
6. В `media` появился мигрируемый `sort_order`; старые установки получают детерминированный порядок по прежнему `created_at`.
7. Порядок можно менять через API и Web UI; после удаления он автоматически уплотняется.
8. Preview показывает первый кадр, количество остальных изображений, размеры и aspect ratio; Instagram явно предупреждает, что первый кадр задаёт основу кадрирования carousel.
9. CI smoke-flow проверяет дедупликацию, порядок, перестановку, успешный Telegram preflight и блокировку `READY` при невалидном MAX public media URL.

## V0.6 — переносимость и данные — закрыто

### V0.6A — backup / restore

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

### V0.6B — контент-план

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

## V0.7 — эксплуатация и test hardening — закрыто

1. Реальный authenticated HTTP CRUD E2E использует тот же `buildApp()`/Fastify router stack и временную SQLite; внешняя публикация заменяется mock publisher только при `NODE_ENV=test`.
2. Отдельный publisher/scheduler E2E проверяет success, неопределённый внешний POST, запрет опасного retry, обе recovery-развязки и `AT` scheduler.
3. `RECOVERY_NEEDED` больше нельзя перевести обычным retry обратно в `PENDING`; оператор обязан вручную выбрать `Публикация найдена` или `Публикации точно нет`.
4. Обе recovery-развязки журналируются; подтверждение найденной публикации не вызывает новый внешний POST.
5. Экран `Диагностика`: версия/Node/uptime, SQLite `quick_check`/WAL/schema/counts, scheduler state, media SQLite↔disk, storage, PUBLIC_BASE_URL, accounts, backups, maintenance и recovery count.
6. Scheduler хранит last start/completion/duration/error/skip и статистику последнего tick.
7. Retention выполняется тем же scheduler: события по умолчанию 180 дней, `.tgz` bundles — 30 последних; `0` отключает соответствующую политику.
8. Старая история активного `RECOVERY_NEEDED` защищена от event retention; самый свежий `pre-restore` bundle дополнительно защищён от backup pruning.
9. Retention покрыт E2E: старые события/backup удаляются, recovery-history и защищённый pre-restore сохраняются.
10. Создан обязательный `docs/LIVE_INTEGRATION_CHECKLIST.md` для Telegram/VK/MAX/Instagram, recovery и backup/restore acceptance перед стабильным V1.
11. Архитектура осталась модульным монолитом: новый cron, worker, Redis, RabbitMQ или второй runtime не добавлялись.

## V0.8 — release candidate / стабильный V1 — в работе

### V0.8A — release tooling — реализовано

RC1 (`0.8.0-rc.1`):

1. SQLite schema поднята до `2`; добавлена таблица `release_acceptance`.
2. При запуске более старого бинарника на более новой SQLite schema выполнение блокируется вместо silent downgrade `user_version`.
3. В Web UI появился `Release gate` для Telegram/VK/MAX/Instagram.
4. Live evidence хранит platform, PASS/FAIL, test account, tested time, полный Git commit SHA и notes.
5. `PASS` требует явного подтверждения `LIVE PASS`, полного 40-char SHA и имени реального тестового аккаунта/канала.
6. Четыре PASS должны относиться к одному commit SHA.
7. `APP_BUILD_SHA` связывает запущенный контейнер с acceptance commit; несовпадение блокирует выпуск.
8. Gate также блокируется при diagnostics errors, `RECOVERY_NEEDED`, scheduler last error, некорректном HTTPS `PUBLIC_BASE_URL` или отсутствии полного backup после последнего acceptance.
9. Release evidence находится в основной SQLite и автоматически входит в full backup/restore; schema-v2 backup обязан содержать `release_acceptance`.
10. Исправлен `docker-compose.yml`: `EVENT_RETENTION_DAYS` и `BACKUP_RETENTION_COUNT` действительно передаются из `.env` в container runtime.
11. Добавлены `docs/UPGRADE_TO_V1.md` и `docs/RELEASE_NOTES_V1.md`.
12. Добавлен отдельный Release gate E2E/CI; общий migration/restore CI переведён на schema v2.

RC2 (`0.8.0-rc.2`):

13. Legacy `GET/POST /api/backups`, создававшие SQLite-only копии, отключены с `410 Gone`.
14. Раздел «Резервные копии» сразу открывает canonical full-bundle UI без промежуточного legacy API.
15. В эксплуатации остаётся один backup-формат: `.tgz` = SQLite + media + manifest; старые `.sqlite` файлы могут храниться только как исторические артефакты.
16. Добавлен отдельный `Backup path CI`, который проверяет недоступность legacy API и успешный full-bundle flow.

RC3 (`0.8.0-rc.3`):

17. Pre-live audit выявил две high production vulnerabilities в direct dependencies; `@fastify/static` обновлён до `10.1.3`, `sharp` — до `0.35.4`.
18. После обновления production `npm audit --omit=dev` показывает 0 vulnerabilities.
19. В репозиторий добавлен `package-lock.json` lockfileVersion 3; dependency graph стал частью release identity.
20. Docker и все acceptance CI устанавливают зависимости через `npm ci`; `npm install` больше не используется для production/acceptance сборки.
21. Добавлен read-only `Dependency security CI`: exact lock install + блокировка high/critical production vulnerabilities.
22. Правила для coding agents запрещают удаление lockfile, плавающую production install и dependency fixes через `npm audit fix --force` без анализа.

### V0.8B — live acceptance — блокирует стабильный V1

1. Выбрать финальный RC commit и собрать именно его с заданным `APP_BUILD_SHA`.
2. Выполнить `docs/LIVE_INTEGRATION_CHECKLIST.md` на реальных тестовых Telegram/VK/MAX/Instagram аккаунтах.
3. Зафиксировать четыре `LIVE PASS` в Release gate на одном commit SHA.
4. Убедиться, что нет `RECOVERY_NEEDED` и diagnostics не содержит ошибок.
5. После последнего live acceptance создать новый полный `.tgz` backup release-state.
6. Получить PASS всех automated CI, включая `Backup path CI` и `Dependency security CI`, на том же release commit.
7. Убедиться, что production dependency audit не содержит high/critical vulnerabilities.
8. Только после пунктов 1–7 изменить version на `1.0.0` и создать стабильный Git tag/release `v1.0.0`.

Ни один mock/E2E тест не имеет права автоматически записывать реальный live PASS в production data.

## После стабильного V1

- статистика публикаций там, где официальные API позволяют получать её стабильно;
- генерация черновиков и изображений через внешние AI API как подключаемая функция;
- интеграции с ASSA Lab / IZO только через стабильный внутренний HTTP API Publikator;
- Google Sheets только как необязательный connector импорта/экспорта, если он действительно понадобится.

## Архитектурный запрет

Любой новый инфраструктурный компонент требует отдельного ADR и не должен нарушать правило одного production-контейнера без доказанной необходимости. n8n, Redis, RabbitMQ, Kafka, отдельный worker-контейнер и отдельная runtime-БД по умолчанию запрещены.

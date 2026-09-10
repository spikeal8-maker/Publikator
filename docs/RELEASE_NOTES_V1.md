# Publikator V1 — release candidate notes

Текущий pre-release: **0.8.0-rc.2**.

Стабильный тег `v1.0.0` не должен создаваться до завершения реального live acceptance Telegram, VK, MAX и Instagram на одном release commit.

## Что входит в кандидат V1

### Публикация

- Telegram, VK, MAX и Instagram adapters;
- отдельный текст для каждой площадки/аккаунта;
- одиночные изображения и поддерживаемые media groups/carousels;
- обязательный platform preflight;
- ручная публикация, `AT` и проектная `QUEUE`;
- retry только при определённо безопасных временных ошибках;
- `RECOVERY_NEEDED` при неизвестном результате внешнего POST с отдельным операторским разбором.

### Контент и media

- локальное JPEG media storage;
- EXIF orientation;
- SHA-256 дедупликация;
- управляемый `sort_order`;
- CSV/XLSX content plan import/export;
- dry-run и SHA-256 binding перед импортом.

### Эксплуатация

- один production Docker-контейнер;
- SQLite/WAL;
- encrypted social credentials;
- diagnostics UI;
- event/backup retention;
- единый full `.tgz` backup и safe restore до открытия SQLite;
- SQLite-only backup API ранних версий отключён;
- mock publisher/scheduler E2E;
- authenticated HTTP CRUD E2E;
- content-plan round-trip CI;
- canonical backup-path E2E;
- production Docker/restore CI.

## Новое в 0.8.0-rc.1

- SQLite schema `2`;
- таблица `release_acceptance` внутри основной SQLite;
- Web UI `Release gate`;
- live evidence: platform, status, test account, tested time, full Git SHA, notes;
- `LIVE PASS` требует явного подтверждения и полного 40-символьного commit SHA;
- четыре площадки должны иметь PASS на одном commit;
- `APP_BUILD_SHA` связывает запущенный контейнер с проверенным commit;
- release gate учитывает diagnostics, `RECOVERY_NEEDED`, scheduler last error, HTTPS `PUBLIC_BASE_URL` и полный backup после последнего acceptance;
- release evidence автоматически попадает в тот же backup/restore;
- старый бинарник больше не должен принимать SQLite с более новой schema;
- `docker-compose.yml` реально передаёт пользовательские `EVENT_RETENTION_DAYS` и `BACKUP_RETENTION_COUNT` в контейнер;
- добавлен отдельный Release gate CI.

## Новое в 0.8.0-rc.2

- отключены legacy `GET /api/backups` и `POST /api/backups`, создававшие SQLite-only копии;
- раздел «Резервные копии» сразу открывает canonical full-bundle UI и не делает промежуточный legacy-запрос;
- рабочий backup-формат теперь однозначен: только `.tgz` с SQLite, media и manifest;
- исторические `.sqlite` файлы не удаляются автоматически только из-за обновления, но новые через приложение не создаются;
- добавлен отдельный `Backup path CI`, который проверяет `410 Gone` для legacy API и успешное создание full bundle.

## Что намеренно не автоматизировано

Publikator не ставит live PASS после mock/E2E и не обращается к GitHub API из production runtime, чтобы самостоятельно объявить релиз готовым.

Причина: реальный acceptance должен подтвердить внешние API, права, сетевую доступность media URL и фактический результат публикации. Эти условия нельзя достоверно заменить локальным mock.

## Условие стабильного v1.0.0

Для одного и того же release commit должны одновременно выполняться:

1. `CI` — PASS;
2. `Content plan CI` — PASS;
3. `Ops hardening CI` — PASS;
4. `Release gate CI` — PASS;
5. `Backup path CI` — PASS;
6. live Telegram — PASS;
7. live VK — PASS;
8. live MAX — PASS;
9. live Instagram — PASS;
10. нет необработанных `RECOVERY_NEEDED`;
11. diagnostics не содержит ошибок SQLite/media/public URL;
12. после последнего live acceptance создан полный `.tgz` backup;
13. runtime `APP_BUILD_SHA` совпадает с acceptance commit.

Только после этого версия меняется на `1.0.0` и создаётся стабильный Git tag/release.

## Обновление

Порядок обновления и rollback: `docs/UPGRADE_TO_V1.md`.

Live сценарии: `docs/LIVE_INTEGRATION_CHECKLIST.md`.

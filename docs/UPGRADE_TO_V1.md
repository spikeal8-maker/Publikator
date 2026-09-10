# Обновление Publikator 0.6.x / 0.7.0 → 0.8.0-rc.3 → V1

Publikator 0.8.0-rc.3 сохраняет архитектуру одного production-контейнера и локального `data/`, поднимает SQLite schema с **1 до 2**, оставляет один рабочий формат резервной копии — полный `.tgz` bundle — и фиксирует npm dependency graph через committed `package-lock.json`.

## Перед обновлением

1. В текущем Publikator создайте **полный `.tgz` backup bundle** через раздел «Резервные копии».
2. Скачайте этот bundle на отдельный диск/компьютер.
3. Убедитесь, что сохранён текущий `APP_MASTER_KEY`. Он не входит в backup и нужен для расшифровки credentials после восстановления.
4. Запишите текущую версию/commit и убедитесь, что раздел «Диагностика» не показывает ошибок SQLite/media.
5. Не удаляйте существующий каталог `data/`.

Старые `.sqlite`-файлы из ранних версий можно оставить в `data/backups`, но приложение больше не создаёт SQLite-only backup через `/api/backups`.

## Обновление

После получения нужного release commit выполните:

```bash
git pull --ff-only
git rev-parse HEAD
```

В `.env` задайте `APP_BUILD_SHA` равным **точному полному выводу** второй команды. Сокращённый SHA не подходит.

Остальные release-параметры:

```env
RELEASE_TARGET_VERSION=1.0.0
EVENT_RETENTION_DAYS=180
BACKUP_RETENTION_COUNT=30
```

Проверьте, что committed dependency graph согласован:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm audit --omit=dev --audit-level=high
```

Production audit перед release не должен содержать high/critical vulnerabilities.

Затем пересоберите **тот же единственный контейнер**:

```bash
docker compose up -d --build
```

Dockerfile использует `npm ci`, поэтому build обязан совпадать с `package-lock.json`. Если `package.json` и lockfile расходятся, сборка должна падать, а не тихо разрешать новый набор зависимостей.

При старте Publikator:

- проверит, что SQLite schema не новее поддерживаемой бинарником;
- создаст таблицу `release_acceptance`;
- сохранит существующие проекты, аккаунты, посты, media, targets, расписание и журнал;
- выставит `PRAGMA user_version = 2`.

## Проверка после обновления

Откройте «Диагностика» и проверьте:

- `quick_check = ok`;
- `journal_mode = wal`;
- schema version = `2`;
- нет missing media и size mismatch;
- scheduler не имеет необработанной последней ошибки;
- `PUBLIC_BASE_URL` корректен;
- нет неожиданных `RECOVERY_NEEDED`.

Откройте «Резервные копии» и убедитесь, что отображаются только полные `.tgz` bundles; создание новой копии должно формировать bundle с SQLite, media и manifest.

Затем откройте **Release gate**. После обновления все четыре площадки должны быть `Не проверено` до реального live acceptance.

## APP_BUILD_SHA и зависимости

`APP_BUILD_SHA` — не секрет. Это полный Git commit SHA исходников, из которых собран текущий контейнер. Release gate использует его, чтобы не принять результаты тестов другого build.

Начиная с RC3, тот же commit содержит `package-lock.json`, поэтому SHA также фиксирует точный dependency graph. Не перегенерируйте lockfile после live acceptance без нового commit и повторного полного acceptance.

Значение `APP_BUILD_SHA` должно состоять ровно из 40 hex-символов и совпадать с выводом `git rev-parse HEAD` непосредственно перед сборкой контейнера.

## Live acceptance перед V1

Для одного и того же `APP_BUILD_SHA` выполните `docs/LIVE_INTEGRATION_CHECKLIST.md` отдельно для:

- Telegram;
- VK;
- MAX;
- Instagram.

После фактической проверки каждой площадки заполните её карточку в Release gate и зафиксируйте `LIVE PASS`.

Release gate остаётся заблокированным, если:

- хотя бы одна площадка не имеет PASS;
- PASS относятся к разным commit SHA;
- `APP_BUILD_SHA` не задан или не совпадает с acceptance commit;
- есть ошибки диагностики;
- остался `RECOVERY_NEEDED`;
- scheduler хранит последнюю ошибку;
- нет корректного HTTPS `PUBLIC_BASE_URL`;
- после последней live-проверки не создан новый полный `.tgz` backup.

Перед стабильным тегом дополнительно должны быть зелёными `CI`, `Content plan CI`, `Ops hardening CI`, `Release gate CI`, `Backup path CI` и `Dependency security CI` на том же commit.

После четырёх PASS создайте **ещё один полный backup bundle**. Только backup, созданный после последнего acceptance, закрывает release gate.

## Rollback

После миграции schema 1 → 2 не запускайте старую 0.7.0 поверх уже мигрированного рабочего `data/` как способ rollback.

Правильный rollback:

1. остановить текущий контейнер;
2. вернуть исходники/образ прежней версии;
3. восстановить **pre-upgrade полный backup** вместе с тем же `APP_MASTER_KEY`;
4. запустить прежнюю версию;
5. проверить диагностику и данные.

Такой порядок исключает запуск старого бинарника на схеме, о которой он не знает.

## Что не меняется

Обновление не добавляет:

- n8n;
- Redis;
- RabbitMQ;
- отдельный worker;
- отдельную runtime-БД;
- внешнее media storage.

По-прежнему достаточно одного Docker-контейнера и каталога `data/`.

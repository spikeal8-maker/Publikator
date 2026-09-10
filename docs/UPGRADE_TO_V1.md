# Upgrade to Publikator 1.0.0-rc.1

Этот документ описывает переход существующей установки на текущий release candidate перед live acceptance.

## 1. Не обновляться без backup

На работающей старой версии сначала создать canonical full `.tgz` backup через интерфейс Publikator.

Убедиться, что bundle содержит:

```text
manifest.json
publikator.sqlite
media/
```

Отдельно сохранить текущий `APP_MASTER_KEY`. Сам ключ намеренно не входит в bundle.

## 2. Зафиксировать старое состояние

Перед обновлением записать:

```text
текущий Git commit
текущую версию Publikator
имя последнего full backup
APP_MASTER_KEY fingerprint/место безопасного хранения ключа
PUBLIC_BASE_URL
reverse-proxy configuration
```

Если используется reverse proxy, определить его реальный IP/CIDR для `TRUST_PROXY`. Не использовать wildcard trust.

## 3. Получить 1.0.0-rc.1

```bash
git checkout main
git pull --ff-only
git rev-parse HEAD
```

Проверить:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm audit --omit=dev --audit-level=high
```

High/critical production vulnerability блокирует deployment.

## 4. Обновить `.env`

Минимум:

```env
PUBLIC_BASE_URL=https://publisher.example.ru
ADMIN_PASSWORD=<existing-or-new-strong-password>
APP_MASTER_KEY=<ТОТ ЖЕ КЛЮЧ, ЧТО И ДО ОБНОВЛЕНИЯ>
RELEASE_TARGET_VERSION=1.0.0
```

При reverse proxy:

```env
TRUST_PROXY=127.0.0.1,172.16.0.0/12
```

Подставьте только реально доверенные адреса/сети.

Scheduler settings при необходимости:

```env
SCHEDULER_INTERVAL_MS=15000
QUEUE_SLOT_GRACE_MINUTES=60
EVENT_RETENTION_DAYS=180
BACKUP_RETENTION_COUNT=30
```

## 5. Собрать image с baked revision

```bash
export BUILD_SHA="$(git rev-parse HEAD)"
docker compose build --no-cache
docker compose up -d
```

Не передавайте release identity через runtime `APP_BUILD_SHA`. Production image должен содержать:

```text
IMAGE_BUILD_SHA=$BUILD_SHA
org.opencontainers.image.revision=$BUILD_SHA
```

Проверить label можно командой:

```bash
docker image inspect publikator-publikator --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

Имя image может отличаться в зависимости от имени compose project; важен сам label.

## 6. Schema migration

Текущая SQLite schema version: **3**.

Upgrade выполняется автоматически при старте.

Schema v3 добавляет уникальность schedule slots:

```text
(project_id, weekday, time_hhmm, timezone)
```

Если в старой SQLite были дубли:

- сохраняется детерминированный самый ранний slot;
- `last_fired_on` объединяется до наиболее поздней известной даты;
- остальные дубли удаляются;
- затем создаётся UNIQUE index.

Также сохраняются прежние media-order/release-acceptance migrations.

Более новая неизвестная schema по-прежнему блокирует запуск старого бинарника.

## 7. Первый запуск после upgrade

Открыть **Диагностика** и проверить:

- version = `1.0.0-rc.1`;
- schema = `3`;
- SQLite `quick_check = ok`;
- WAL;
- media missing/size mismatch = 0;
- scheduler без last error;
- PUBLIC_BASE_URL корректен;
- нет неожиданного `RECOVERY_NEEDED`;
- backup bundles видны.

Проверить список schedule slots: исторические точные дубли должны исчезнуть.

## 8. Security smoke

Через обычный браузер:

- login работает;
- mutation UI работает с основного origin;
- cookie остаётся HttpOnly/SameSite;
- интерфейс не должен открываться во frame;
- `/public-media/...` остаётся доступным извне.

Если включён `TRUST_PROXY`, убедиться, что он содержит только proxy, который действительно стоит перед Publikator.

## 9. Publication smoke

До live acceptance использовать тестовый проект.

Проверить:

1. создать draft;
2. добавить media;
3. выбрать один тестовый account;
4. READY;
5. открыть две вкладки и почти одновременно выполнить publish;
6. внешний пост должен появиться ровно один раз;
7. target attempts не должен показывать двойной первый запуск.

Этот smoke подтверждает atomic publication claim на конкретном deployment.

## 10. Rollback

После успешного старта schema v3 **не запускайте старый бинарник поверх уже мигрированного `data/`**.

Rollback делается так:

1. остановить новый container;
2. вернуть предыдущую версию кода/image;
3. восстановить pre-upgrade full `.tgz` backup через совместимую процедуру с тем же `APP_MASTER_KEY`;
4. запустить старую версию на восстановленных данных.

Нельзя считать downgrade кода заменой rollback данных.

## 11. После upgrade

Upgrade до RC не означает stable release. Далее выполнить:

```text
docs/LIVE_INTEGRATION_CHECKLIST.md
```

Четыре площадки должны получить `LIVE PASS` на одном baked build SHA. После последнего PASS нужен новый full backup и его restore-test. Только затем разрешается выпуск `v1.0.0`.

## 12. CI gate

В репозитории теперь один постоянный workflow:

```text
Publikator CI / Acceptance
```

Перед merge/release он должен быть зелёным целиком. Отдельные старые `Content plan CI`, `Ops hardening CI`, `Toolchain CI`, platform workflows и т.п. больше не являются самостоятельными release gates: их сценарии включены внутрь единого acceptance.

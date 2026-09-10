# Upgrade Publikator

Этот документ описывает безопасное обновление существующей установки Publikator до release candidate `0.8.0-rc.1` и последующих совместимых релизов.

## Главный принцип

`data/` и `APP_MASTER_KEY` важнее Docker image.

В `data/` находятся SQLite, media и backup bundles. `APP_MASTER_KEY` находится вне `data/` и используется для расшифровки credentials соцсетей. Потеря или незапланированная смена этого ключа делает сохранённые credentials недоступными.

Перед обновлением **не копируйте открытую SQLite вручную** и не заменяйте файлы внутри `data/` поверх работающего контейнера. Используйте встроенный полный backup bundle.

## Поддерживаемый путь в 0.8.0-rc.1

Проверяется переход с рабочей ветки `0.6.x`/`0.7.0` на `0.8.0-rc.1` при сохранении:

- того же volume/каталога `DATA_DIR`;
- того же `APP_MASTER_KEY`;
- того же `ADMIN_PASSWORD` либо осознанно изменённого администратором;
- корректного `PUBLIC_BASE_URL`;
- существующей SQLite и media.

В `0.8.0-rc.1` нет новой destructive миграции пользовательских данных. Текущая SQLite schema version остаётся совместимой с V0.7, а startup migration сохраняет idempotent-поведение.

## Перед обновлением

1. Откройте **Диагностика** и устраните ошибки SQLite/media.
2. Разберите все `RECOVERY_NEEDED` либо зафиксируйте, почему они должны остаться незакрытыми. Для RC gate активный `RECOVERY_NEEDED` является блокером.
3. Откройте **Резервные копии** и создайте новый полный `.tgz` bundle.
4. Скачайте этот bundle на отдельный носитель/хранилище.
5. Отдельно убедитесь, что сохранён текущий `APP_MASTER_KEY`. Сам ключ намеренно не входит в backup bundle.
6. Зафиксируйте текущий image/tag/commit, чтобы при необходимости вернуть предыдущую версию приложения.
7. Проверьте, что Docker volume или bind mount для `DATA_DIR` не меняется при обновлении.

## Обновление Docker deployment

Если установка собирается из репозитория:

```bash
git fetch --all --tags
git checkout v0.8.0-rc.1
docker compose build --pull
docker compose up -d
```

Если release tag ещё не создан, используйте exact release commit, указанный в GitHub prerelease, а не произвольную вершину `main`.

После запуска:

```bash
docker compose ps
docker compose logs --tail=200
```

Контейнер должен перейти в healthy state.

## Проверка после обновления

1. Войти в Web UI.
2. Открыть **Диагностика**:
   - SQLite `quick_check = ok`;
   - `journal_mode = wal`;
   - missing media = 0;
   - size mismatch = 0;
   - scheduler не имеет последней необработанной ошибки.
3. Открыть **Готовность V1**.
4. Убедиться, что версия отображается как `0.8.0-rc.1`.
5. Automated RC gate должен быть PASS либо показывать конкретные технические блокеры.
6. Проверить несколько существующих постов, platform overrides и порядок media.
7. Проверить список backup bundles.
8. Не считать `stableV1Ready=false` ошибкой: для RC это ожидаемое состояние до ручного live acceptance Telegram/VK/MAX/Instagram.

## Новые/важные env-параметры

Обязательные параметры не изменились:

```env
PUBLIC_BASE_URL=https://publisher.example.ru
ADMIN_PASSWORD=very-strong-admin-password
APP_MASTER_KEY=very-long-random-secret-at-least-32-characters
```

Retention, введённый в V0.7, остаётся опционально настраиваемым:

```env
EVENT_RETENTION_DAYS=180
BACKUP_RETENTION_COUNT=30
```

`0` отключает соответствующую автоматическую очистку.

## Rollback приложения

Если проблема только в новом application image, а данные не нужно откатывать:

1. Верните previous known-good image/tag/commit.
2. Не меняйте `DATA_DIR`.
3. Не меняйте `APP_MASTER_KEY`.
4. Запустите контейнер.
5. Повторно проверьте **Диагностика**.

Для перехода `0.7.0 ↔ 0.8.0-rc.1` это предпочтительный rollback, потому что RC не вводит несовместимую новую схему данных.

## Rollback данных

Если нужно вернуть и состояние данных на момент перед обновлением:

1. Запустите known-good Publikator с тем же `APP_MASTER_KEY`.
2. Через **Резервные копии** загрузите сохранённый pre-upgrade `.tgz` bundle.
3. Выполните штатный restore с ручным подтверждением `RESTORE`.
4. Дождитесь автоматического рестарта контейнера.
5. Проверьте проекты, посты, targets, media, журнал и диагностику.

Не распаковывайте `.tgz` вручную поверх работающего `data/`: штатный restore специально проверяет manifest, SHA-256, SQLite integrity, ключ шифрования и применяет данные до открытия runtime SQLite.

## Когда можно переходить со RC на stable V1

Только когда одновременно:

- automated CI зелёный на exact release commit;
- экран **Готовность V1** показывает `automatedReady=true`;
- выполнен `docs/LIVE_INTEGRATION_CHECKLIST.md` на реальных тестовых аккаунтах Telegram/VK/MAX/Instagram;
- зафиксирован release commit SHA и результаты live acceptance;
- отсутствуют неразобранные acceptance `RECOVERY_NEEDED`;
- создан новый полный backup release-state.

До этого `stableV1Ready=false` является намеренной защитой от преждевременного объявления стабильного V1.

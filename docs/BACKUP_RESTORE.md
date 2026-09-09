# Backup и восстановление Publikator

## Цель

Publikator должен переноситься и восстанавливаться без внешней инфраструктуры. Полная резервная копия содержит runtime SQLite и все media-файлы, необходимые этой SQLite.

`APP_MASTER_KEY` в архив **не включается**. Его нужно хранить отдельно от backup: он необходим для расшифровки credentials Telegram / VK / MAX / Instagram.

## Что находится в `.tgz`

```text
manifest.json
publikator.sqlite
media/
```

`manifest.json` содержит:

- `format = publikator-backup`;
- `formatVersion`;
- версию Publikator;
- `schemaVersion` SQLite;
- время создания;
- label backup;
- SHA-256 fingerprint `APP_MASTER_KEY`, но не сам ключ;
- SHA-256 SQLite;
- количество проектов, постов, social accounts и media;
- полный список media: relative path, size, SHA-256.

## Создание backup

Основной способ — Web UI:

```text
Резервные копии → Создать полный backup
```

API:

```http
POST /api/backup-bundles
Content-Type: application/json

{"label":"manual"}
```

Во время создания:

1. Publikator пытается войти в maintenance gate.
2. Если выполняется публикация или другая API-операция ещё не завершилась, snapshot не начинается.
3. Scheduler не запускает новые публикации.
4. SQLite копируется штатным `db.backup()` в staging.
5. Staging SQLite проходит `PRAGMA integrity_check`.
6. Копируются только media, на которые ссылается snapshot SQLite.
7. Для каждого media сверяются size и SHA-256.
8. Создаётся manifest.
9. Весь staging валидируется тем же валидатором, который используется при restore.
10. Только после этого формируется `.tgz`.

Если любой файл отсутствует или изменился неожиданно, backup завершается ошибкой; неполный архив не сохраняется.

## Проверки restore

До изменения runtime данных проверяются:

1. Разрешены только `manifest.json`, `publikator.sqlite`, `media/**`.
2. Absolute paths и `..` запрещены.
3. Symlink, hardlink и другие link entries запрещены.
4. Duplicate tar entries запрещены.
5. Количество entries ограничено.
6. Суммарный заявленный распакованный размер ограничен 16 ГБ.
7. Формат и `formatVersion` должны поддерживаться текущей версией.
8. Backup с более новой SQLite-схемой не принимается.
9. Fingerprint `APP_MASTER_KEY` должен совпасть.
10. SHA-256 SQLite должен совпасть с manifest.
11. `PRAGMA integrity_check` должен вернуть `ok`.
12. Обязательные таблицы должны существовать.
13. `user_version` SQLite должен совпасть со `schemaVersion` manifest.
14. Media в SQLite, manifest и файловой системе должны совпасть один к одному.
15. Size и SHA-256 каждого media должны совпасть.
16. Лишние media-файлы запрещены.

## Восстановление сохранённой копии

В Web UI нажмите `Восстановить` напротив нужного bundle. Для защиты от случайного нажатия интерфейс потребует вручную ввести:

```text
RESTORE
```

API также требует отдельный заголовок:

```http
X-Publikator-Restore: RESTORE
```

Запрос сохранённого bundle:

```http
POST /api/backup-bundles/<name>/restore
X-Publikator-Restore: RESTORE
```

## Восстановление из загруженного файла

Web UI принимает `.tgz` / `.tar.gz` до 2 ГБ.

API:

```http
POST /api/backup-bundles/restore-upload
X-Publikator-Restore: RESTORE
Content-Type: multipart/form-data
```

Файл передаётся streaming-способом во временный файл и не загружается целиком в RAM.

## Почему restore требует restart

SQLite нельзя безопасно заменить под работающим приложением, когда `db.ts` уже открыл соединение. Поэтому Publikator не делает `copy over live db`.

Схема:

```text
валидировать bundle
        ↓
создать pre-restore backup текущего состояния
        ↓
rename staging → data/.restore-pending
        ↓
grаceful SIGTERM
        ↓
Docker restart: unless-stopped
        ↓
server.ts запускается
        ↓
applyPendingRestore() ДО import('./db.js')
        ↓
замена SQLite/WAL/SHM/media
        ↓
обычный migrate()
        ↓
HTTP server
```

`docker-compose.yml` уже использует:

```yaml
restart: unless-stopped
```

Поэтому штатный restore в Docker возвращает сервис автоматически.

## Pre-restore backup

Перед постановкой restore в pending автоматически создаётся новый полный bundle с label:

```text
pre-restore
```

Он остаётся в `data/backups/` и нужен как дополнительная точка возврата, если пользователь выбрал не тот архив или после restore обнаружилась логическая проблема.

## Файловый rollback при startup

Во время применения pending restore старые файлы сначала перемещаются в локальный `.restore-rollback-*`:

- `publikator.sqlite`;
- `publikator.sqlite-wal`, если существует;
- `publikator.sqlite-shm`, если существует;
- `media/`.

Только затем pending SQLite/media становятся live. Если операция файловой замены падает, startup-код пытается вернуть прежние файлы. При успешном rollback повреждённый pending удаляется, чтобы контейнер не попал в бесконечный restart-loop.

## Перенос на другой сервер

Минимальный безопасный перенос:

1. Сохранить текущий `APP_MASTER_KEY` в защищённом месте.
2. Создать полный backup bundle и скачать его.
3. Развернуть ту же или более новую совместимую версию Publikator на новом сервере.
4. В `.env` нового сервера установить **тот же** `APP_MASTER_KEY`.
5. Запустить Publikator.
6. Открыть `Резервные копии`.
7. Загрузить bundle и выполнить restore.
8. После автоматического restart проверить `Соцсети`, несколько постов и изображения.

Не требуется переносить PostgreSQL, Redis, S3, n8n или отдельный worker: таких runtime-компонентов у Publikator нет.

## Старые `.sqlite` backup

Старые endpoint'ы `/api/backups` пока оставлены для обратной совместимости. Они создают только SQLite и не являются полной переносимой копией, потому что не содержат `media/`.

Новый Web UI использует `/api/backup-bundles` и `.tgz` bundles. Для disaster recovery следует использовать именно полный bundle.

## Что backup не содержит

Архив намеренно не содержит:

- `APP_MASTER_KEY`;
- `ADMIN_PASSWORD`;
- `.env`;
- Docker secrets;
- Docker image;
- TLS/private keys reverse proxy.

Это разделяет резервную копию данных и секреты окружения.

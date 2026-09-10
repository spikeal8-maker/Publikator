# Live integration checklist перед стабильным V1

Этот checklist используется только для **реальной** проверки Telegram, VK, MAX и Instagram перед выпуском `v1.0.0`. Mock/E2E и зелёный CI не заменяют внешний API acceptance.

Текущий release candidate: **`1.0.0-rc.1`**. SQLite schema: **v3**.

## 1. Зафиксировать release build

Перед любыми live-публикациями:

```bash
git checkout main
git pull --ff-only
export BUILD_SHA="$(git rev-parse HEAD)"
echo "$BUILD_SHA"
docker compose build --no-cache
docker compose up -d
```

Нельзя менять код, lockfile или Dockerfile после начала acceptance. Если код изменился — четыре live PASS аннулируются и тестирование начинается заново на новом SHA.

В production Publikator берёт release identity из встроенного `IMAGE_BUILD_SHA` / OCI `org.opencontainers.image.revision`. Runtime-переменная `APP_BUILD_SHA` не используется как доказательство release build.

## 2. Preflight установки

Перед первой публикацией открыть **Диагностика** и проверить:

- SQLite `quick_check = ok`;
- `journal_mode = wal`;
- schema version = `3`;
- нет missing/size-mismatch media;
- scheduler не содержит необработанной ошибки;
- нет старых `RECOVERY_NEEDED`;
- для MAX/Instagram `PUBLIC_BASE_URL` — публичный HTTPS URL;
- встроенный build SHA соответствует `git rev-parse HEAD`;
- используется только canonical `.tgz` backup flow.

Создать **pre-acceptance full backup**.

Для live-проверок использовать тестовые каналы/аккаунты, а не боевые публикации, особенно для retry/recovery сценариев.

## 3. Общая публикационная матрица

Для каждой площадки проверить:

1. **Проверить подключение** в UI.
2. Одна JPEG-картинка + короткий текст.
3. Кириллица, emoji, URL и переносы строк.
4. Отдельный `override_text`: внешний текст совпадает именно с platform preview.
5. Несколько изображений в допустимом количестве и правильном `sort_order`.
6. `publish-now`.
7. `AT` на несколько минут вперёд.
8. `QUEUE` через отдельный тестовый schedule slot.
9. После успешного/частичного publish текст, targets и media нельзя незаметно изменить.
10. Target содержит внешний ID; если adapter возвращает URL — проверить URL.
11. В журнале нет неожиданного второго `publish_started` / второго внешнего поста.
12. Double-click на publish не должен создавать дубль.

После проверки каждой площадки сразу записывать результат в **Release gate**. `LIVE PASS` ставится только после фактической внешней проверки.

## 4. Telegram

Подготовка:

- бот добавлен в канал/чат;
- бот имеет необходимые права публикации;
- `Bot token` относится к этому боту;
- `chat_id` соответствует нужному месту назначения.

Acceptance:

1. Connection test: `getMe → getChat → getChatMember` проходит.
2. Single image с caption до 1024 символов.
3. Media group из нескольких изображений; порядок совпадает с UI.
4. Текст 1025–4096 символов: media публикуется один раз, затем один отдельный `sendMessage`.
5. Проверить кириллицу/emoji около границ длины.
6. Убедиться, что текст >4096 блокируется **до** внешней публикации.
7. Проверить, что повторный быстрый publish/double-click не создаёт второй пост.
8. Зафиксировать Telegram `LIVE PASS`.

Если long-text follow-up не подтверждён после уже опубликованного media, target обязан перейти в `RECOVERY_NEEDED`, а сообщение об ошибке должно содержать `message_id` уже опубликованного media.

## 5. VK

Подготовка:

- token имеет права нужного сообщества;
- `Group ID` корректен;
- API version поддерживается текущим VK API.

Acceptance:

1. Connection test получает `photos.getWallUploadServer`.
2. Single image + text.
3. Несколько изображений; порядок правильный.
4. Проверить `override_text`.
5. Проверить `AT` и `QUEUE`.
6. Повтор одного `post.id` в контролируемом тесте не должен создавать дубль там, где `guid` поддерживает идемпотентность.
7. Transport failure на подготовительном upload не должен считаться уже опубликованной записью стены.
8. Неопределённый исход после начала `wall.post` должен требовать recovery.
9. Зафиксировать VK `LIVE PASS`.

Тип токена обязательно проверять на реальном API: неподходящий community token может не пройти wall photo upload.

## 6. MAX

Подготовка:

- актуальный API host `platform-api2.max.ru`;
- bot/access token имеет write permission;
- `PUBLIC_BASE_URL` открывается из внешнего интернета по HTTPS;
- `/public-media/...` доступен без cookie/авторизации.

Acceptance:

1. Connection test: `/me` + membership/permission check.
2. Single JPEG через публичный URL.
3. Несколько изображений, максимум 12.
4. Текст с Unicode; >4000 должен блокироваться preflight.
5. Из внешней сети открыть URL конкретного media, который получает MAX.
6. Проверить `POST /messages`, внешний ID и ссылку при наличии.
7. Проверить `AT`, `QUEUE`, override.
8. Неопределённый timeout/transport исход публичного POST → `RECOVERY_NEEDED`, без автоматического дубля.
9. Зафиксировать MAX `LIVE PASS`.

## 7. Instagram

Подготовка:

- professional Instagram account поддерживает publishing API;
- access token и Instagram User ID относятся к одной интеграции;
- выбранная Graph/Instagram API version ещё поддерживается;
- Meta может скачать `/public-media/...` по HTTPS без cookie.

Acceptance:

1. Connection test показывает нужный professional account.
2. Single JPEG.
3. Carousel из 2 изображений.
4. Carousel из 10 изображений.
5. Порядок совпадает с `media.sort_order`.
6. Проверить фактическое кадрирование первого изображения/карусели.
7. В логах container flow проходит до `FINISHED` перед `media_publish`.
8. `ERROR/EXPIRED` container не создаёт ложный public recovery.
9. Неопределённый результат `media_publish` не повторяется автоматически.
10. Проверить `AT`, `QUEUE`, override.
11. Зафиксировать Instagram `LIVE PASS`.

## 8. Concurrency acceptance

Автоматический CI уже проверяет race-condition mock publisher, но перед stable V1 выполнить простой UI smoke:

1. Создать отдельный тестовый post с одной выбранной площадкой.
2. Открыть его в двух вкладках.
3. Практически одновременно нажать publish в обеих вкладках.
4. На площадке должен существовать **ровно один** новый пост.
5. Target `attempts` не должен показывать два первых запуска одного состояния.

Это подтверждает atomic publication claim в реальном HTTP/UI контуре.

## 9. Scheduler acceptance

### AT

- поставить публикацию на несколько минут вперёд;
- получить ровно один publish;
- после publish она не должна запускаться снова.

### QUEUE

- создать уникальный тестовый slot;
- второй идентичный slot должен получить `409`/сообщение «уже существует»;
- проверить обычный запуск в минуту slot;
- повторить с коротким restart/maintenance и убедиться, что grace-window догоняет occurrence;
- убедиться, что сильно просроченный occurrence не публикуется задним числом.

## 10. RECOVERY_NEEDED

Проводить только на тестовой площадке.

1. Контролируемо получить неопределённый исход после начала публичного POST.
2. Target становится `RECOVERY_NEEDED`.
3. Обычный retry заблокирован.
4. Вручную проверить площадку.
5. Если пост найден: **Публикация найдена** → `PUBLISHED` без второго POST.
6. Если поста точно нет: **Публикации точно нет** → `FAILED`; затем разрешён один ручной retry.
7. Проверить audit events recovery.

## 11. Backup / restore acceptance

После последнего live PASS:

1. Создать **новый** full `.tgz` backup.
2. Release gate должен показать `Backup после acceptance = да`.
3. Скачать bundle.
4. На отдельной тестовой установке использовать **тот же `APP_MASTER_KEY`**.
5. Восстановить bundle и перезапустить приложение.
6. Проверить проекты, accounts, posts, target states, overrides, media order, events и release acceptance records.
7. Diagnostics после restore не содержит ошибок.
8. Restore с другим `APP_MASTER_KEY` блокируется до замены данных.

## 12. Финальный gate

Stable `v1.0.0` разрешён только если одновременно:

- Telegram = `LIVE PASS`;
- VK = `LIVE PASS`;
- MAX = `LIVE PASS`;
- Instagram = `LIVE PASS`;
- все четыре PASS относятся к одному SHA;
- SHA совпадает со встроенным release image revision;
- нет `RECOVERY_NEEDED`;
- diagnostics не содержит ошибок;
- после последнего PASS создан новый full backup;
- restore этого bundle проверен на тестовой установке;
- `Publikator CI / Acceptance = PASS` на том же release commit;
- package version/lockfile не менялись после начала acceptance.

Только после этого создаётся стабильный tag/release `v1.0.0` и закрывается V1 blocker issue.

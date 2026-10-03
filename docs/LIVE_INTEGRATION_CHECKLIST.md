# Live integration checklist перед стабильным V1

Этот checklist используется только для **реальной** проверки Telegram, VK, MAX и Instagram перед выпуском `v1.0.0`. Mock/E2E и зелёный CI не заменяют внешний API acceptance.

Для current main/vNext credential semantics применяется `SOCIAL_CREDENTIAL_CAPABILITY_CONTRACT.md`. Live acceptance не заменяет capability profile: она добавляет evidence для public-write операций, которые нельзя безопасно доказать обычной проверкой credentials.

Текущий release candidate: **`1.0.0-rc.4`**. Release tag: **`v1.0.0-rc.4`**. Release commit: **`095e289e503a79a21fa877f6afb2d300b87b4a21`**. SQLite schema: **v3**.

## 1. Зафиксировать release build

Перед любыми live-публикациями:

```bash
git fetch --tags --prune
git checkout --detach v1.0.0-rc.4
export BUILD_SHA="$(git rev-parse HEAD)"
test "$BUILD_SHA" = "095e289e503a79a21fa877f6afb2d300b87b4a21"
echo "$BUILD_SHA"
docker compose build --no-cache
docker compose up -d
```

Live acceptance V1 проводится только на неизменённом `v1.0.0-rc.4` / `095e289e503a79a21fa877f6afb2d300b87b4a21`. Ветка `main` является vNext и для V1 acceptance не используется. Нельзя менять код, lockfile или Dockerfile после начала acceptance. Если release-код изменился и выпускается новый RC — четыре live PASS аннулируются и тестирование начинается заново на новом release SHA.

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

Для каждой площадки до public publish:

1. **Проверить credentials** в UI и сохранить capability evidence:
   - credential validity;
   - provider type/role;
   - identity;
   - declared permissions/scopes where available;
   - destination identity/role;
   - method states;
   - per-format readiness;
   - checked_at/build.
2. Убедиться, что UI не показывает provider outage/timeout как INVALID.
3. Убедиться, что valid-but-limited credential сохраняется и остаётся usable для READY formats; formats без capability блокируются отдельно. Credential с нулём READY publish formats не становится автоматической publish target.
4. Убедиться, что direct API cannot activate connection by client-asserted authKind/publishReady.
5. Одна JPEG-картинка + короткий текст.
6. Кириллица, emoji, URL и переносы строк.
7. Отдельный `override_text`: внешний текст совпадает именно с platform preview.
8. Несколько изображений в допустимом количестве и правильном `sort_order`.
9. `publish-now`.
10. `AT` на несколько минут вперёд.
11. `QUEUE` через отдельный тестовый schedule slot.
12. После успешного/частичного publish текст, targets и media нельзя незаметно изменить.
13. Target содержит внешний ID; если adapter возвращает URL — проверить URL.
14. В журнале нет неожиданного второго `publish_started` / второго внешнего поста.
15. Double-click на publish не должен создавать дубль.

После проверки каждой площадки сразу записывать результат в **Release gate**. `LIVE PASS` ставится только после фактической внешней проверки.

## 4. Telegram

Подготовка:

- бот добавлен в канал/чат;
- бот имеет необходимые права публикации;
- `Bot token` относится к этому боту;
- `chat_id` соответствует нужному месту назначения.

Acceptance:

1. Credential capability report показывает bot identity, destination, member/admin role и provider-returned granular rights.
2. Для channel отдельно зафиксировать `can_post_messages`; при наличии также `can_edit_messages`, `can_delete_messages`, story rights.
3. Valid bot без publish right должен остаться valid credential, но access level = SETUP_REQUIRED, если точное исправление известно.
4. Single image с caption до 1024 символов.
5. Media group из нескольких изображений; порядок совпадает с UI.
6. Текст 1025–4096 символов: media публикуется один раз, затем один отдельный `sendMessage`.
7. Проверить кириллицу/emoji около границ длины.
8. Убедиться, что текст >4096 блокируется **до** внешней публикации.
9. Проверить, что повторный быстрый publish/double-click не создаёт второй пост.
10. Зафиксировать Telegram `LIVE PASS`.

Если long-text follow-up не подтверждён после уже опубликованного media, target обязан перейти в `RECOVERY_NEEDED`, а сообщение об ошибке должно содержать `message_id` уже опубликованного media.

## 5. VK

Подготовка:

- определить provider credential types/roles, а не использовать термин "VK token" без типа;
- current wall/image publication path проверяется USER credential;
- GROUP/COMMUNITY credential MAY быть сохранён и проверен отдельно, но не является обязательной второй publish-role;
- `Group ID` корректен;
- API version поддерживается текущим VK API.

Acceptance:

1. Save-and-check определяет access level каждого введённого VK credential.
2. GROUP/COMMUNITY credential остаётся valid-but-limited, если group permissions подтверждены, но USER-only publish methods недоступны.
3. USER credential показывает `account.getAppPermissions` evidence (если provider method доступен) и current preparation capability `photos.getWallUploadServer`.
4. `users.get` success сам по себе не классифицирует token как USER.
5. `groups.getById` не считать ownership/admin proof.
6. Обычная credential check не вызывает `wall.post`.
7. Publication matrix показывает IMAGE/CAROUSEL can/cannot и точное remediation.
8. Single image + text.
3. Несколько изображений; порядок правильный.
4. Проверить `override_text`.
5. Проверить `AT` и `QUEUE`.
6. Повтор одного `post.id` в контролируемом тесте не должен создавать дубль там, где `guid` поддерживает идемпотентность.
7. Transport failure на подготовительном upload не должен считаться уже опубликованной записью стены.
8. Неопределённый исход после начала `wall.post` должен требовать recovery.
9. Зафиксировать VK `LIVE PASS`.

Тип credential обязательно проверять на реальном API. Capability report должен сохранять факт, что credential может быть валидным и иметь declared group permissions, но не подходить для конкретного current publish method.

Если current WALL transport не работает с verified credential/destination profile, сначала зафиксировать method-level evidence. Только после этого рассматривать alternate transport; наличие такого transport в стороннем workflow само по себе не является основанием.

## 6. MAX

Подготовка:

- актуальный API host `platform-api2.max.ru`;
- bot/access token имеет write permission;
- `PUBLIC_BASE_URL` открывается из внешнего интернета по HTTPS;
- `/public-media/...` доступен без cookie/авторизации.

Acceptance:

1. Capability report: `/me` + destination membership/role + полный relevant permissions list.
2. Valid token без `write` остаётся valid, но publication readiness blocked.
3. Single JPEG через публичный URL.
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

1. Capability report показывает нужный professional account и отдельно publication readiness.
2. Identity success не считается доказательством всех media formats.
3. Если provider API безопасно отдаёт scopes/expiry/account type — evidence записывается отдельно.
4. Single JPEG.
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
- active social connections имеют server-verified capability profile/evidence;
- credential/destination semantics соответствуют approved/live-tested target;
- diagnostics не содержит ошибок;
- после последнего PASS создан новый full backup;
- restore этого bundle проверен на тестовой установке;
- `Publikator CI / Acceptance = PASS` на том же release commit;
- package version/lockfile не менялись после начала acceptance.

Только после этого создаётся стабильный tag/release `v1.0.0` и закрывается V1 blocker issue.

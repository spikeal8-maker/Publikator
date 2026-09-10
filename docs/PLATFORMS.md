# Platform adapters

Каждый adapter реализует единый контракт `SocialPublisher`, но самостоятельно отвечает за ограничения, API phases и классификацию ошибок своей площадки.

Перед `READY` и непосредственно перед publish используется один и тот же `PublishInput`. Поэтому UI approval и runtime не должны иметь разные platform rules.

## Общая модель ошибок

Не все сетевые операции равны.

```text
local/preparation phase
    │
    ├── ошибка известна → FAILED или RETRY
    └── не могла создать публичный пост → НЕ RECOVERY_NEEDED

public POST phase
    │
    ├── явная API ошибка → FAILED/RETRY по семантике API
    └── transport/timeout/5xx с неопределённым исходом → RECOVERY_NEEDED
```

`RECOVERY_NEEDED` означает, что повтор всего target потенциально создаст дубль либо повторит уже частично выполненную публикацию. Generic auto-retry запрещён.

Перед вызовом любого adapter target дополнительно защищён atomic SQLite claim в `publisher.ts`.

## Telegram

Credentials:

```text
botToken
chatId
```

Connection test:

```text
getMe → getChat → getChatMember
```

Бот должен видеть назначение и иметь право публикации.

### Media

- минимум 1 изображение;
- максимум 10;
- single image → `sendPhoto`;
- несколько → `sendMediaGroup`;
- local JPEG bytes читаются **до** соответствующего внешнего POST.

Missing local file является известной локальной ошибкой (`outcomeUnknown=false`).

### Text

Publikator считает Unicode code points:

```text
0–1024      → caption
1025–4096   → media без caption + отдельный sendMessage
>4096       → preflight block до внешнего POST
```

### Network / recovery

Все publication requests имеют timeout 30 секунд.

- explicit `429` → известная retryable ошибка;
- transport/timeout/5xx после начала `sendPhoto`/`sendMediaGroup` → unknown public outcome;
- success-like response без `message_id` → recovery;
- если media уже подтверждено, но follow-up `sendMessage` не подтверждён, target получает `RECOVERY_NEEDED`, а ошибка содержит `message_id` уже опубликованного media.

Официальная документация: https://core.telegram.org/bots/api

## VK

Credentials:

```text
accessToken
groupId
apiVersion
```

Connection test проверяет возможность получить `photos.getWallUploadServer` для указанной группы.

### Publication phases

```text
photos.getWallUploadServer   preparation
binary upload                preparation
photos.saveWallPhoto         preparation
wall.post                    PUBLIC
```

Первые три шага ещё не создают запись стены. Их timeout/5xx не должны давать ложный recovery; временные сбои можно безопасно повторить.

`wall.post` вызывается с:

```text
guid = post.id
```

чтобы использовать platform idempotency там, где VK её поддерживает.

VK API/upload timeout: 30 секунд.

- явная VK API error остаётся известной ошибкой;
- transport/5xx после начала `wall.post` → unknown public outcome;
- success-like ответ `wall.post` без `post_id` → recovery.

Актуальные права/token type необходимо повторно проверять на live API перед каждым стабильным release.

## MAX

Credentials:

```text
accessToken
chatId
```

Connection test:

```text
GET /me
GET /chats/{chatId}/members/me
```

Требуется owner либо admin с permission `write`.

### Media / text

- минимум 1 media;
- максимум 12;
- текст максимум 4000 Unicode code points;
- каждому media соответствует один `publicMediaUrl`;
- URL обязан быть корректным HTTPS URL с hostname и без embedded credentials.

MAX получает изображения напрямую из Publikator, поэтому `PUBLIC_BASE_URL` должен быть доступен из интернета по HTTPS.

### Public phase

`POST /messages` сразу является публичной операцией и имеет timeout 30 секунд.

- explicit 429 → известная retryable ошибка;
- transport/timeout/5xx после начала POST → `RECOVERY_NEEDED`;
- success-like response без external message id → recovery.

Официальная документация:

- https://dev.max.ru/docs-api
- https://dev.max.ru/docs-api/methods/POST/messages

## Instagram

Credentials:

```text
accessToken
igUserId
graphVersion
```

Connection test получает `id,username` professional Instagram account.

`graphVersion` хранится явно, а не hardcoded навсегда.

### Single image

```text
create media container
        ↓
wait status_code=FINISHED
        ↓
media_publish
```

### Carousel

```text
create child #1 → wait FINISHED
create child #2 → wait FINISHED
...
create CAROUSEL parent
        ↓
wait FINISHED
        ↓
media_publish(parent)
```

Поддерживается 2–10 JPEG.

### Container status

```text
IN_PROGRESS → wait
FINISHED    → следующий шаг
ERROR       → known preparation failure
EXPIRED     → known preparation failure
PUBLISHED до текущего media_publish → manual recovery
```

Create/status container ещё не создаёт текущий публичный пост, поэтому transport/5xx на preparation phase могут быть безопасно повторены.

Только неопределённый исход после начала `media_publish` переводит target в `RECOVERY_NEEDED`.

Meta скачивает изображения с `PUBLIC_BASE_URL`, поэтому media URL должен быть публичным HTTPS.

Официальная Meta/Postman collection:

- https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api
- https://www.postman.com/meta/instagram/overview

## Media pipeline до adapter

Все загруженные изображения проходят общий pipeline:

1. decode Sharp;
2. EXIF orientation;
3. JPEG normalization;
4. width/height/size;
5. SHA-256;
6. duplicate detection внутри post;
7. stable `sort_order`;
8. local storage в `data/media`.

После `PUBLISHING` / `PARTIAL` / `PUBLISHED` media order и content замораживаются.

## Добавление новой площадки после V1

Новый adapter должен:

- реализовать `SocialPublisher`;
- иметь local preflight;
- явно разделить preparation и public phases;
- не обходить atomic claim;
- определить timeout;
- определить retryable known errors;
- определить unknown public outcome;
- иметь focused regression script, добавленный **в существующий** `Publikator CI / Acceptance`, а не новый самостоятельный workflow;
- иметь live acceptance checklist перед включением в stable release.

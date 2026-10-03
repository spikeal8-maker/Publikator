# Platform adapters

Каждый adapter реализует единый контракт `SocialPublisher`, но самостоятельно отвечает за ограничения, API phases и классификацию ошибок своей площадки.

Credential/destination diagnostics регулируются отдельным нормативным контрактом `SOCIAL_CREDENTIAL_CAPABILITY_CONTRACT.md`.

Перед `READY` и непосредственно перед publish используется один и тот же `PublishInput`. Поэтому UI approval и runtime не должны иметь разные platform rules.

Для каждой платформы существуют две независимые матрицы:

```text
adapter capability      — что реализует Publikator
credential capability   — что может конкретный credential set на конкретном destination
```

Формат READY только на пересечении обеих матриц.

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

Connection inspection:

```text
getMe → getChat → getChatMember
```

Результат MUST сохранять отдельно token validity, bot identity, destination identity, membership/role и granular administrator rights.

Как минимум UI/capability profile показывает provider-returned `can_post_messages`, `can_edit_messages`, `can_delete_messages`, story/admin rights и иные relevant fields, когда они присутствуют.

Валидный bot token без права публикации остаётся валидным credential, но publication readiness нужного формата = BLOCKED/PARTIAL.

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

Full credential/access contract: SOCIAL_CREDENTIAL_CAPABILITY_CONTRACT.md.

VK credential handling is diagnostic-first:

~~~text
Save and check
→ detect/establish token type
→ show owner/identity
→ show provider permissions where available
→ probe only safe methods
→ compute publication readiness
→ show exact remediation
~~~

Current VK API 5.199 schema distinguishes access-token types including user, group, service and open.

### Current method/token matrix

| Method | USER | GROUP | SERVICE | Meaning |
| --- | --- | --- | --- | --- |
| users.get | yes | yes | yes | reads user data; success alone does not classify token as USER |
| groups.getById | yes | yes | yes | reads group object; not ownership/admin proof |
| groups.getTokenPermissions | no | yes | no | GROUP credential permission set |
| account.getAppPermissions | yes | no | no | USER application permission mask |
| photos.getWallUploadServer | yes | no | no | current wall-photo preparation |
| photos.saveWallPhoto | yes | no | no | current wall-photo save |
| photos.getUploadServer | yes | no | no | album upload preparation |
| photos.save | yes | no | no | album photo save |
| wall.post | yes | no | no | public wall publication |

Therefore the current VK image/wall publisher is a USER-credential path.

A GROUP/COMMUNITY credential is still accepted, encrypted, inspected and displayed. It may provide group-scoped identity/permissions, but it is not the mandatory second half of wall publication.

### VK access levels

Example USER credential:

~~~text
Credential verdict: FULL / ПОЛНОЦЕННЫЙ
🟢 Full access for current IMAGE/CAROUSEL Publikator

USER credential
✓ valid
Owner: id123

Permissions:
✓ photos
✓ wall
✓ groups

Methods:
✓ photos.getWallUploadServer
? wall.post — not executed during normal inspection

Publication:
✓ IMAGE
✓ CAROUSEL
◇ VIDEO — adapter status
◇ STORY — adapter status
~~~

Example GROUP credential:

~~~text
Credential verdict: LIMITED / ОГРАНИЧЕННЫЙ
🟠 Setup required

GROUP credential
✓ valid
Group: club456

Declared permissions:
✓ wall
✓ photos

Methods:
✓ groups.getTokenPermissions
✓ groups.getById
— photos.getWallUploadServer: USER required
— wall.post: USER required in current schema

Publication:
✗ IMAGE — USER credential required
✗ CAROUSEL — USER credential required
◇ VIDEO — adapter status
◇ STORY — adapter status
~~~

This GROUP credential remains saved and must not be described as invalid.

### USER permission inspection

For a confirmed USER credential, inspection SHOULD call account.getAppPermissions where current provider behavior allows it and persist the returned permission mask as provider evidence.

If Publikator decodes the mask into names, the mapping MUST be versioned/tested. Unknown bits remain visible as raw evidence rather than being silently invented or dropped.

### Safe probes

Safe inspection MAY include:

- users.get;
- groups.getTokenPermissions for GROUP;
- account.getAppPermissions for USER;
- groups.getById;
- photos.getWallUploadServer for current USER image readiness.

wall.post is public and MUST NOT run during ordinary credential inspection.

### Publication phases: current WALL image transport

~~~text
photos.getWallUploadServer   preparation
binary upload                preparation
photos.saveWallPhoto         preparation
wall.post                    PUBLIC
~~~

Preparation failures do not create a wall post and must not become false public recovery.

Only an ambiguous outcome after wall.post starts may become RECOVERY_NEEDED.

A different media transport is not added merely because it exists in another workflow. It requires an actual product need demonstrated by credential/destination capability evidence plus focused tests/live acceptance.

### User remediation

Blocked capability MUST name the exact fix.

Examples:

~~~text
IMAGE unavailable:
current credential type is GROUP.
Current VK image methods require USER.

[ Connect via VK ]
[ Enter USER credential ]
~~~

or:

~~~text
USER credential detected,
but required application permission is missing.

[ Re-authorize VK ]
[ Show required permissions ]
~~~

Do not say only "get a stronger key".

## MAX

Credentials:

```text
accessToken
chatId
```

Connection inspection:

```text
GET /me
GET /chats/{chatId}/members/me
```

CapabilityProfile сохраняет identity, owner/admin state и полный relevant provider permissions list. `write` участвует в publication readiness, но отсутствие `write` не делает token INVALID, если identity уже CONFIRMED.

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

Connection inspection не ограничивается фразой "account найден".

CapabilityProfile отдельно хранит token/account identity, professional account identity/type когда provider его отдаёт, scopes/permissions когда их можно безопасно определить, account/destination match, expiry если известен, public-media prerequisites и readiness каждого implemented format.

Успешное чтение `id,username` не является доказательством готовности IMAGE/CAROUSEL/VIDEO/SHORT/STORY.

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

- определить credential types/roles и CapabilityProfile по `SOCIAL_CREDENTIAL_CAPABILITY_CONTRACT.md`;
- реализовать `SocialPublisher`;
- иметь local preflight;
- явно разделить preparation и public phases;
- не обходить atomic claim;
- определить timeout;
- определить retryable known errors;
- определить unknown public outcome;
- иметь focused regression script, добавленный **в существующий** `Publikator CI / Acceptance`, а не новый самостоятельный workflow;
- иметь live acceptance checklist перед включением в stable release.

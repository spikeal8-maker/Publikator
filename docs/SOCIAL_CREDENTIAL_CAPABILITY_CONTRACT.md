# Social Credential Capability Contract

Status: **AUTHORITATIVE / NORMATIVE** for social credentials, connection diagnostics, access-level display and publication authorization.

Verified baseline date: **2026-10-03**.

This document defines the product contract for Telegram, VK, MAX and Instagram credentials.

The central product rule is simple:

> Publikator MUST accept and safely store a non-empty credential even when it is only partially useful, then explain exactly what this credential can do, what it cannot do, why, and what the user must change to gain more publication capability.

A publishing product MUST NOT reduce credential diagnostics to "valid / invalid" or "connection works / does not work".

---

# 1. Primary user workflow

The canonical action is:

~~~text
enter credential(s) + destination
        ↓
[ Save and check ]
        ↓
store secret encrypted
        ↓
server checks provider identity/type/permissions/methods
        ↓
persist capability result
        ↓
show ACCESS LEVEL
        ↓
show exact publication matrix
        ↓
show what is missing and how to fix it
~~~

The button wording SHOULD be **"Сохранить и проверить"**.

A separate "Проверить" action MAY exist for already saved credentials, but it MUST use the server-stored secret; the browser must not resend a previously stored secret.

A non-empty credential that cannot fully publish is not rejected merely for being limited.

Instead it is stored encrypted and classified.

---

# 2. User-visible credential verdict + access level

Before any detailed list, the UI MUST show a plain-language credential verdict:

~~~text
Ключ: ПОЛНОЦЕННЫЙ
Ключ: ОГРАНИЧЕННЫЙ
Ключ: НЕДЕЙСТВИТЕЛЬНЫЙ
Ключ: НЕ ПРОВЕРЕН
~~~

Mapping:

- ПОЛНОЦЕННЫЙ — access level FULL;
- ОГРАНИЧЕННЫЙ — PARTIAL, READ_ONLY or SETUP_REQUIRED;
- НЕДЕЙСТВИТЕЛЬНЫЙ — INVALID;
- НЕ ПРОВЕРЕН — UNAVAILABLE or UNCHECKED.

This verdict is intentionally simple. It does not replace the detailed reason matrix.

Below it, every saved credential/connection MUST have one precise access level.

Canonical levels:

## FULL

~~~text
🟢 Полный доступ для текущих возможностей Publikator
~~~

Meaning:

- credential is valid;
- destination is resolved;
- every publication format currently implemented by Publikator for this platform/destination and selected use case is READY.

"FULL" does NOT mean the provider account has every theoretical permission the provider offers. It means "full for the publication capabilities Publikator currently implements and checked".

## PARTIAL

~~~text
🟡 Ограниченный доступ
~~~

Meaning:

- credential is valid;
- at least one currently implemented publication format is READY;
- at least one other currently implemented relevant publication format is not READY.

The credential remains usable for the READY formats.

Example:

~~~text
✓ TEXT — READY
✗ IMAGE — missing permission
✗ CAROUSEL — missing permission
~~~

## READ_ONLY

~~~text
🔵 Только чтение / диагностика
~~~

Meaning:

- credential is valid;
- identity/read methods work;
- no currently implemented public publication format is READY;
- Publikator has no currently confirmed configuration change that would make this exact credential publish-ready without replacing/augmenting it.

This credential is still accepted and saved.

## SETUP_REQUIRED

~~~text
🟠 Требуется настройка
~~~

Meaning:

- credential itself is valid or sufficiently identified;
- zero currently implemented publication formats are READY;
- at least one publication format can become READY through a known action: selecting a destination, granting a permission, changing bot/admin rights, using the required credential type, configuring public HTTPS media, or another explicit setup step.

The exact missing requirement MUST be shown.

## INVALID

~~~text
🔴 Ключ недействителен
~~~

Use only when the provider explicitly establishes invalid/expired/revoked credentials.

Provider timeout, DNS failure, 5xx or temporary outage MUST NOT produce INVALID.

## UNAVAILABLE

~~~text
⚪ Не удалось проверить сейчас
~~~

The credential may be valid, but the provider/network did not allow a reliable verdict.

The saved secret remains available for re-check.

## UNCHECKED

~~~text
⚪ Сохранён, ещё не проверен
~~~

Used for a newly stored credential before inspection completes or when inspection has never completed.

## 2.1 Deterministic access-level algorithm

The backend MUST assign the level deterministically in this order:

1. Provider explicitly proves invalid/expired/revoked → INVALID.
2. Provider/network prevents any reliable validity verdict → UNAVAILABLE.
3. Inspection has not completed → UNCHECKED.
4. Credential valid and every currently implemented relevant publication format is READY → FULL.
5. Credential valid and at least one currently implemented publication format is READY, but another relevant implemented format is not READY → PARTIAL.
6. Credential valid, zero publication formats READY, but at least one exact remediation can make an implemented format READY → SETUP_REQUIRED.
7. Credential valid, zero publication formats READY, only read/diagnostic capabilities remain and no current remediation for this exact credential is known → READ_ONLY.

NOT_IMPLEMENTED formats do not lower FULL to PARTIAL. They describe a Publikator limitation, not a credential limitation.

The algorithm result MUST be stored with the capability profile and shown consistently after reload.


---

# 3. Detailed capability matrix

The access level is only a summary.

Every connection MUST also expose an expandable detailed report.

At minimum:

~~~text
Credential
  validity
  provider type
  owner / identity
  expiry if known
  declared permissions/scopes if available

Destination
  type
  id
  name
  membership/admin/ownership evidence

Provider methods
  method
  status
  reason
  evidence

Publication in Publikator
  TEXT
  IMAGE
  CAROUSEL
  VIDEO
  SHORT
  STORY
~~~

Publication states:

- READY — Publikator can currently publish this format with this credential/destination;
- BLOCKED — an explicit provider/destination/credential condition prevents it;
- SETUP_REQUIRED — possible after a concrete configuration/permission change;
- NOT_IMPLEMENTED — provider/credential may support it, but Publikator has no accepted adapter path;
- UNKNOWN — not enough evidence;
- UNAVAILABLE — provider/network prevented a reliable check.

The UI MUST NOT use a red cross for NOT_IMPLEMENTED as if the credential were bad.

It should say:

~~~text
◇ Publikator пока не реализовал этот формат
~~~

---

# 4. Exact result shown after Save and Check

After successful inspection the page SHOULD show a compact summary like:

~~~text
VK · ASA Lab

Ключ: ОГРАНИЧЕННЫЙ
🟠 Требуется настройка

Ключ действителен
Тип: GROUP / COMMUNITY
Сообщество: ASA Lab

Публикация
✗ IMAGE — этому типу ключа недоступен photos.getWallUploadServer
✗ CAROUSEL — требуется USER credential
✓ TEXT — доступен при праве wall и совпадении сообщества ключа с назначением
◇ VIDEO — не реализовано/не принято в текущем adapter
◇ STORY — не реализовано/не принято в текущем adapter

Доступно
✓ данные сообщества
✓ provider permissions: wall, photos

Чтобы открыть публикацию изображений:
[ Подключить USER credential ]
[ Где получить USER credential? ]

[ Подробная диагностика ]
~~~

A full credential may show:

~~~text
Ключ: ПОЛНОЦЕННЫЙ
🟢 Полный доступ для текущего IMAGE/CAROUSEL Publikator

◇ TEXT — текущий TEXT_ONLY adapter не включён
✓ IMAGE
✓ CAROUSEL
◇ VIDEO — не реализовано
◇ STORY — не реализовано
~~~

This is still FULL for the currently implemented publication scope if every implemented relevant format is READY.

---

# 5. Save semantics

The user asked Publikator to remember the credential; Publikator SHOULD remember it safely even if capability is limited.

Rules:

1. Empty secret is rejected.
2. Syntactically acceptable non-empty secret MAY be stored before capability inspection finishes.
3. Secret is encrypted immediately.
4. Stored secret is never returned by account APIs.
5. Inspection uses the server-stored credential.
6. If credential is valid but limited, keep it saved with FULL/PARTIAL/READ_ONLY/SETUP_REQUIRED as appropriate.
7. If provider is unavailable, keep it saved with UNAVAILABLE/UNCHECKED.
8. If provider explicitly proves INVALID, keep-or-delete policy must be explicit in UI; default SHOULD be to keep the saved entry disabled long enough for the user to replace/re-check it, without exposing the secret.
9. Unsupported publication formats are blocked by preflight; the whole saved credential is not discarded.
10. A limited credential MUST NOT silently enter a publication path that its capability profile does not permit.

Storage and publication eligibility are separate concepts.

---

# 6. Capability facts MUST stay separate

Publikator MUST preserve:

~~~text
credential validity
    !=
provider credential type
    !=
provider-declared permissions/scopes
    !=
safe method capability
    !=
destination role/right
    !=
Publikator adapter implementation
    !=
publication readiness
~~~

Examples:

- a VK GROUP token may be valid and report wall/photos permissions while the current VK image publication methods require a USER token;
- a Telegram bot token may be valid while the bot cannot post to the selected channel;
- a MAX token may identify the bot while the destination denies write;
- an Instagram credential may identify the professional account while a requested media format is not publish-ready.

A failure in one layer MUST NOT erase confirmed facts from another layer.

---

# 7. Method status

Method-level status values:

- CONFIRMED;
- DENIED;
- UNAVAILABLE;
- NOT_CHECKED;
- NOT_SUPPORTED_FOR_CREDENTIAL_TYPE;
- SETUP_REQUIRED;
- NOT_IMPLEMENTED_IN_PUBLIKATOR.

Each row MUST include a human-readable reason.

Example:

~~~text
photos.getWallUploadServer
DENIED
Current credential type: GROUP.
VK schema requires USER for this method.
~~~

---

# 8. Safe inspection

"Save and check" MUST NOT create a public post.

Normal inspection MUST NOT call public/destructive methods only to discover permissions.

Safe read/preparation probes MAY be used when they cannot create a public publication.

Examples of methods that ordinary inspection MUST NOT invoke for proof:

- VK wall.post;
- Telegram sendMessage/sendPhoto/sendMediaGroup;
- MAX POST /messages;
- Instagram media_publish.

If a capability can only be proven by a real public operation, show:

~~~text
? Not live-proven
~~~

and prove it in controlled live acceptance.

---

# 9. Backend authority

The backend owns verification.

Browser fields such as:

- authKind;
- publishReady;
- destinationId;
- permission flags;
- access level

are never proof.

Creating/updating an active publication connection MUST use server-side evidence.

Direct API callers MUST NOT bypass the same checks required by the UI.

If a credential is stored but not publication-ready, it remains a saved limited credential; publication preflight blocks unsupported formats.

---

# 10. READY destination safety

READY means immutable publication intent, not only immutable text/media.

A READY target MUST bind/fingerprint:

- social account/connection;
- effective destination type/id;
- publication-relevant credential profile revision/fingerprint;
- publication-relevant options.

If credential/destination changes after READY:

- invalidate READY and require new preflight; or
- publish using the immutable approved binding.

Never silently redirect an already approved post to a new destination.

---

# 11. VK — exact contract

VK is the platform where credential type must be especially explicit.

Verified against VK API schema baseline 5.199 on 2026-10-03.

Official schema source:
https://github.com/VKCOM/vk-api-schema

VK schema defines access-token types including:

- user;
- group;
- service;
- open.

Publikator MUST detect/represent the credential type when provider evidence allows it.

## 11.1 VK method/token matrix

Current schema evidence, amended by controlled VK API 5.199 acceptance on 2026-10-08:

| VK method | USER | GROUP | SERVICE | What it proves |
| --- | --- | --- | --- | --- |
| users.get | allowed | allowed | allowed | user data/identity read; NOT sufficient by itself to classify token type |
| groups.getById | allowed | allowed | allowed | selected-object lookup proves readability only; GROUP request WITHOUT group_id returns the credential-bound community |
| groups.getTokenPermissions | no | allowed | no | declared GROUP-token permissions |
| account.getAppPermissions | allowed | no | no | USER application permission mask |
| photos.getWallUploadServer | allowed | no | no | current wall-photo preparation availability |
| photos.saveWallPhoto | allowed | no | no | current wall-photo save step |
| photos.getUploadServer | allowed | no | no | album upload preparation; does not make GROUP token publish-capable |
| photos.save | allowed | no | no | album photo save step |
| wall.post | allowed | TEXT observed with wall permission | no | public operation; never invoked during ordinary inspection |

Therefore:

> Current VK photo publishing paths in Publikator are USER-credential paths.

A GROUP/COMMUNITY key is still a valid and useful credential for group-scoped inspection/permissions where supported, but it is NOT described as the mandatory second half of wall publication.

## 11.2 VK credential inputs

VK connect UI MUST support:

### Recommended

~~~text
[ Подключить через VK ]
~~~

Preferred route for obtaining/checking a USER credential when OAuth is configured.

### Manual USER credential

~~~text
USER credential
[________________]
[ Где получить USER credential? ]
~~~

### GROUP / COMMUNITY credential

~~~text
GROUP / COMMUNITY credential
[________________]
[ Где получить ключ сообщества? ]
~~~

The GROUP field is optional/additional.

It is accepted and inspected because it can expose group-token identity/permissions and other group-scoped capabilities.

Do NOT tell the user they always need both.

## 11.3 VK USER inspection

At minimum attempt:

1. classify/establish USER identity;
2. obtain user id/identity;
3. call account.getAppPermissions when safe/current API supports it;
4. decode the returned permission mask into named permissions using a versioned mapping;
5. resolve destination;
6. groups.getById for destination readability when COMMUNITY destination;
7. safe current adapter probes such as photos.getWallUploadServer;
8. do NOT call wall.post during normal inspection.

Report:

~~~text
USER credential
Validity: CONFIRMED
Owner: id12345

App permissions:
✓ photos
✓ wall
✓ groups
...

Destination:
ASA Lab / club67890

Methods:
✓ photos.getWallUploadServer
? wall.post — NOT_CHECKED (public operation)

Publication:
✓ IMAGE
✓ CAROUSEL
...
~~~

If permission-mask decoding is not reliable for the current provider version, show the raw/provider evidence rather than invent named permissions.

## 11.4 VK GROUP inspection

At minimum attempt:

1. establish GROUP credential validity/type;
2. groups.getTokenPermissions;
3. groups.getById WITHOUT group_id to identify the credential-bound community, then compare the selected numeric ID or screen name;
4. show returned group permissions;
5. do not probe USER-only methods as though failure meant INVALID.

Example:

~~~text
Ключ: ОГРАНИЧЕННЫЙ
GROUP credential
Validity: CONFIRMED
Group: club67890

Declared permissions:
✓ wall
✓ photos

Current Publikator publication:
✓ TEXT — FEED/TEXT_ONLY when wall permission and credential-bound destination match
✗ IMAGE — current required method photos.getWallUploadServer requires USER
✗ CAROUSEL — requires USER
◇ VIDEO — adapter status
◇ STORY — adapter status

This key is valid but limited for current Publikator publishing.
~~~

## 11.5 VK remediation

Every blocked row MUST have a specific remediation.

Examples:

~~~text
IMAGE
✗ Requires USER credential
[ Подключить через VK ]
[ Ввести USER credential вручную ]
[ Почему? ]

GROUP key
✓ saved and valid
No need to delete it.
~~~

If a USER credential is valid but lacks app permissions:

~~~text
🟠 Требуется настройка

Не хватает разрешения: photos

[ Переавторизовать VK с нужными правами ]
[ Какие права нужны? ]
~~~

Do not tell the user to create a "stronger key" without naming the required provider credential type/permission/method.

---

# 12. Telegram — exact user-facing contract

Normal inspection:

~~~text
getMe
→ getChat
→ getChatMember
~~~

Show separately:

- bot token validity;
- bot identity;
- destination identity;
- membership/status;
- administrator/creator state;
- can_post_messages when returned;
- can_edit_messages when returned;
- can_delete_messages when returned;
- story-related admin rights when returned;
- other relevant provider-returned rights.

Example:

~~~text
Ключ: ПОЛНОЦЕННЫЙ
🟢 Полный доступ для текущих IMAGE/CAROUSEL возможностей

Bot: @school_bot
Channel: School

✓ token valid
✓ administrator
✓ can_post_messages
✗ can_delete_messages
✓ can_post_stories

Publikator:
◇ TEXT — текущий TEXT_ONLY adapter не включён
✓ IMAGE
✓ CAROUSEL
◇ STORY — provider right exists, but Publikator adapter not accepted
~~~

If the bot is a valid member without publish rights, token validity remains CONFIRMED while publication is BLOCKED/SETUP_REQUIRED.

Remediation:

~~~text
[ Откройте настройки канала Telegram ]
[ Сделайте бота администратором ]
[ Разрешите публикацию сообщений ]
~~~

---

# 13. MAX — exact user-facing contract

Inspection:

~~~text
GET /me
GET /chats/{chatId}/members/me
~~~

Show:

- token validity;
- bot identity;
- destination;
- owner/admin state;
- complete relevant provider-returned permissions list;
- write permission separately;
- Publikator format readiness.

Example:

~~~text
Ключ: ОГРАНИЧЕННЫЙ
🟠 Требуется настройка

✓ token valid
✓ admin
✗ write

TEXT: ◇ если TEXT_ONLY adapter не включён
IMAGE: ✗ BLOCKED

Чтобы публиковать:
выдайте боту permission write в выбранном чате/канале.
~~~

A missing write permission is not an INVALID token if /me succeeded.

---

# 14. Instagram — exact user-facing contract

Inspection MUST show separately:

- token validity/availability;
- account identity;
- professional account identity/type when provider exposes it;
- scopes/permissions when current provider API safely exposes them;
- destination/account match;
- expiry when reliably known;
- public HTTPS media prerequisite;
- per-format readiness.

Identity success alone is not proof of publishing capability.

Example:

~~~text
🟠 Требуется настройка

✓ account identified
✓ professional account
? media publishing permission not proven
✗ public media URL unavailable

IMAGE: SETUP_REQUIRED
CAROUSEL: SETUP_REQUIRED
VIDEO: SETUP_REQUIRED
~~~

Remediation must identify the exact missing requirement, not say only "check token".

---

# 15. Remediation contract

Every BLOCKED / SETUP_REQUIRED publication row MUST have structured remediation.

Conceptual shape:

~~~text
code
title
explanation
requiredCredentialType nullable
requiredPermissions[]
steps[]
primaryAction:
  label
  kind = INTERNAL_ROUTE | OFFICIAL_HELP_URL | RECHECK
  target
secondaryActions[]
~~~

Examples:

~~~text
code: VK_IMAGE_REQUIRES_USER
title: Для публикации изображений нужен USER credential
primaryAction: Подключить через VK
secondaryAction: Как получить USER credential
~~~

~~~text
code: TELEGRAM_CAN_POST_MESSAGES_REQUIRED
title: Бот не может публиковать в выбранный канал
steps:
  1. Откройте настройки канала
  2. Сделайте бота администратором
  3. Разрешите публикацию сообщений
primaryAction: Проверить снова
~~~

The UI MUST NOT use generic remediation like "get a better key" when the system knows the exact missing type/permission/setup.

Official help links MUST be platform-owned/configured data rather than random third-party articles. Current first-party references include:

- Telegram bot creation/token: https://core.telegram.org/bots/tutorial
- MAX bot token management: https://dev.max.ru/docs/chatbots/bots-create/manage
- VK API/schema evidence: https://github.com/VKCOM/vk-api-schema
- VK first-party SDK authorization examples: https://github.com/VKCOM/vk-php-sdk
- Instagram publishing documentation: https://developers.facebook.com/docs/instagram-platform/content-publishing

If an official provider URL changes, update the help metadata without changing credential semantics.

---

# 16. "Where do I get the credential?"

Every connect screen MUST include contextual help before and after inspection.

Before inspection:

- what credential type is expected;
- preferred authorization method;
- manual alternative;
- required provider permissions for implemented formats;
- link/instructions to provider settings.

After inspection:

- exact missing type/permission/setup;
- direct action where possible;
- explain that the current limited credential remains saved and may still be useful.

The text must be specific.

Bad:

~~~text
Get a key with more rights.
~~~

Required style:

~~~text
For VK IMAGE publication, current methods require a USER credential
with the application permissions needed for photos/wall access.

[ Подключить через VK ]
[ Как получить USER credential вручную ]
~~~

---

# 17. Persistence of diagnostic result

Publikator MUST persist the canonical safe capability result/evidence metadata so the connection card survives reload and all server consumers use the same evidence.

Persist at least:

- credential_version;
- last check attempt, safe machine code/message, and last successful check;
- access level;
- credential provider type;
- identity;
- destination;
- declared permissions/scopes;
- method statuses/evidence;
- per-format readiness;
- profile schema version/fingerprint.

Never persist secret copies or arbitrary raw provider responses inside capability evidence.

All persistence MUST use the canonical write/read rules in section 22.

A successful re-check replaces the current semantic profile. A transient UNAVAILABLE re-check preserves the previous successful semantic profile when credential_version still matches and only updates check-status/timestamps as defined in section 27.

---

# 18. Publication preflight

Preflight consumes server-owned capability evidence plus the adapter capability registry.

For each selected target/format it answers:

~~~text
Does Publikator implement this format?
Is destination resolved?
Is the required credential type present?
Is required provider permission confirmed where applicable?
Are required safe preparation methods confirmed or covered by accepted evidence?
Is the capability profile current?
~~~

Preflight returns structured reason codes and user-facing remediation.

Examples:

- VK_IMAGE_REQUIRES_USER;
- VK_PHOTOS_PERMISSION_REQUIRED;
- VK_WALL_UPLOAD_DENIED;
- TELEGRAM_CAN_POST_MESSAGES_REQUIRED;
- MAX_WRITE_REQUIRED;
- INSTAGRAM_PUBLIC_MEDIA_REQUIRED;
- CREDENTIAL_CHECK_UNAVAILABLE;
- CREDENTIAL_PROFILE_STALE;
- DESTINATION_CHANGED_AFTER_READY.

---

# 19. Platform capability vs key capability

Two matrices exist:

## Adapter matrix

What Publikator implements.

## Credential/destination matrix

What this concrete saved credential can do on this concrete destination.

Final readiness:

~~~text
adapter implemented
AND
credential suitable
AND
destination suitable
AND
required method evidence
AND
runtime prerequisites
~~~

Never blame the key for a format that Publikator itself does not implement.

---

# 20. CI acceptance for credential work

Minimum focused scenarios:

1. valid/full credential;
2. valid/partial credential;
3. valid/read-only credential;
4. invalid/expired credential;
5. provider/network unavailable;
6. destination mismatch;
7. permission missing;
8. provider permission present but required method denied;
9. save-limited-key succeeds and survives reload;
10. stored secret is not returned/resubmitted by browser;
11. exact access level persists;
12. remediation message names the missing credential type/permission/setup;
13. direct API cannot self-assert FULL/verified;
14. READY destination/credential change cannot redirect approved post;
15. provider format supported but Publikator NOT_IMPLEMENTED is displayed distinctly.

For VK additionally:

16. GROUP token valid + permissions returned + IMAGE blocked because USER method required;
17. USER token + account.getAppPermissions evidence;
18. USER token + photos.getWallUploadServer confirmed → IMAGE readiness;
19. users.get success alone must not misclassify GROUP/SERVICE token as USER;
20. wall.post calls during normal credential inspection = 0.

---

# 21. Implementation priority

Before speculative alternate transports, implement the credential foundation in this fixed order:

1. **CRED-01A — persistence/domain foundation**: schema 13, safe CapabilityProfile persistence, deterministic classifier, semantic fingerprint, stale-profile handling and secret-safe normalization. No provider calls and no route/UI changes.
2. **CRED-01B — structured credential inspection foundation**: one normalized inspection result for VK/Telegram/MAX/Instagram; validity separated from destination/method rights; limited/unavailable/invalid represented as data, not generic exceptions.
3. **CRED-01C — Save-and-check / Recheck + credential mutation authority**: persist-first/inspect-second API and convergence of every credential-changing path onto credential_version/profile invalidation.
4. **CRED-01D — visible Socials UI**: verdict, access level, can/cannot matrix, expandable evidence and exact remediation.
5. **CRED-02 — capability-aware READY/preflight binding**: destination + credential_version + profile_fingerprint become immutable publication intent.
6. **CRED-03 — controlled live publication acceptance**: real public-write evidence without secrets.

Each lettered slice is one checkpoint = one branch = one PR.

Do not implement Save-and-check before the structured inspection foundation exists. Persisting an inaccurate capability result is worse than having no capability profile.

An alternate transport becomes justified only after the diagnostic profile proves why the current implemented transport cannot satisfy a real required credential/destination scenario.

---

# 22. Exact persistence contract — schema 13

Current main before CRED implementation is schema 12.

CRED-01A owns schema 13: social-credential-capability-profile.

Do not redesign the entire social account model in this migration.

The existing table remains the secret/account owner:

~~~text
social_accounts
- id
- platform
- name
- credentials_encrypted
- enabled
- credential_version      NEW
- created_at
- updated_at
~~~

Add:

~~~text
credential_version INTEGER NOT NULL DEFAULT 1 CHECK(credential_version >= 1)
~~~

credential_version increments only when publication-relevant credential/config stored in credentials_encrypted changes, including destination or provider API version when those fields are stored there.

Changing only display name or operator enabled MUST NOT increment credential_version.

Add one new table:

~~~text
social_account_capability_profiles

account_id                  TEXT PRIMARY KEY
profile_schema_version      INTEGER NOT NULL
credential_version          INTEGER NOT NULL
access_level                TEXT NOT NULL
provider_type               TEXT NOT NULL
profile_json                TEXT NOT NULL
profile_fingerprint         TEXT NOT NULL
last_check_status           TEXT NOT NULL
last_check_at               TEXT
last_successful_checked_at  TEXT
last_check_code             TEXT
last_check_message          TEXT
updated_at                  TEXT NOT NULL
~~~

Foreign key:

~~~text
account_id -> social_accounts(id) ON DELETE CASCADE
~~~

Allowed access_level:

~~~text
FULL
PARTIAL
READ_ONLY
SETUP_REQUIRED
INVALID
UNAVAILABLE
UNCHECKED
~~~

Allowed last_check_status:

~~~text
SUCCESS
INVALID
UNAVAILABLE
UNCHECKED
~~~

`last_check_code` is an optional stable machine code for the latest attempt (for example provider invalid-token code, NETWORK_TIMEOUT, PROVIDER_5XX).

`last_check_message` is an optional short operator-facing message for the latest attempt. It MUST be sanitized/redacted and MUST NOT contain a secret-bearing URL or provider raw body.

Both latest-attempt fields are diagnostic metadata and are excluded from semantic fingerprint.

profile_json is the safe non-secret semantic evidence payload only. It MAY contain credential validity/identity, destination, declared permissions, method statuses, per-format readiness, remediation and warnings. It MUST NOT duplicate storage/check metadata or contain access tokens, bot tokens, client secrets, authorization codes or any secret-bearing URL.

profile_schema_version starts at 1.

Application code MUST expose one `CURRENT_CAPABILITY_PROFILE_VERSION`. Any material change to inspection/classification/profile semantics that makes stored evidence unsafe to reuse increments this version. Canonical read treats an older/newer unsupported profile version as stale/UNCHECKED.

provider_type is a normalized provider credential type such as USER, GROUP, SERVICE, BOT, UNKNOWN; platform-specific values are allowed but must be documented.

## 22.1 Capability DTO v1

The server-owned API DTO synthesized from persisted metadata + semantic evidence MUST have these semantics:

~~~text
profileVersion: 1
accountId
credentialVersion
profileFingerprint
checkedAt
lastSuccessfulCheckedAt nullable
lastCheckStatus
lastCheckCode nullable
lastCheckMessage nullable

verdict:
  FULL | LIMITED | INVALID | UNCHECKED

accessLevel:
  FULL | PARTIAL | READ_ONLY | SETUP_REQUIRED |
  INVALID | UNAVAILABLE | UNCHECKED

credential:
  validity
  providerType
  identity
  ownerId nullable
  expiresAt nullable
  declaredPermissions[]
  permissionsSource nullable

destination:
  kind nullable
  id nullable
  name nullable
  role nullable
  ownershipConfirmed nullable

methods[]:
  method
  state
  reason
  evidenceSource

publicationReadiness:
  TEXT
  IMAGE
  CAROUSEL
  VIDEO
  SHORT
  STORY

remediation[]:
  code
  title
  explanation
  requiredCredentialType nullable
  requiredPermissions[]
  steps[]
  primaryAction nullable
  secondaryActions[]

warnings[]
~~~

Publication readiness entry contains at minimum:

~~~text
state:
  READY | BLOCKED | SETUP_REQUIRED |
  NOT_IMPLEMENTED | UNKNOWN | UNAVAILABLE

reason
requiredMethods[]
remediationCodes[]
~~~

Frontend MUST render this DTO rather than recreate the classification algorithm independently.
The API DTO is synthesized from table metadata plus one persisted semantic payload.

`profile_json` MUST contain only safe semantic evidence:

~~~text
credential:
  validity
  identity
  ownerId
  expiresAt
  declaredPermissions[]
  permissionsSource

destination
methods[]
publicationReadiness
remediation[]
warnings[]
~~~

The following are storage metadata or derived API fields and MUST NOT be duplicated inside `profile_json`:

- profileVersion / profile_schema_version;
- credentialVersion / credential_version;
- profileFingerprint / profile_fingerprint;
- checkedAt / last_check_at;
- lastSuccessfulCheckedAt / last_successful_checked_at;
- lastCheckStatus / last_check_status;
- lastCheckCode / last_check_code;
- lastCheckMessage / last_check_message;
- accessLevel / access_level;
- verdict;
- credential.providerType / provider_type.

The API assembler injects these fields into the returned CapabilityProfile DTO.

## 22.2 One canonical persistence write-path

There are two canonical domain operations:

~~~text
buildCapabilityProfile(structuredInspection, adapterCapability, runtimePrerequisites)
→ normalized CapabilityProfile input

saveCapabilityProfile(account, normalizedProfileInput)
~~~

`buildCapabilityProfile` owns final per-format readiness and access-level derivation.

For each format:

1. if Publikator adapter does not implement it → `NOT_IMPLEMENTED` regardless of key strength;
2. else provider evidence `DENIED` → `BLOCKED` or `SETUP_REQUIRED` according to remediation;
3. else provider evidence `UNAVAILABLE` → `UNAVAILABLE`;
4. else provider evidence insufficient → `UNKNOWN`;
5. else runtime prerequisite missing (for example public HTTPS media) → `SETUP_REQUIRED`;
6. only confirmed provider prerequisites + implemented adapter + satisfied runtime prerequisites → `READY`.

The access-level classifier then consumes this final publicationReadiness map.

There is exactly one canonical profile write operation:

~~~text
saveCapabilityProfile(account, normalizedInspectionOrProfileInput)
~~~

It MUST:

1. validate the strict semantic evidence shape;
2. normalize and sanitize safe evidence;
3. compute access level with the canonical classifier;
4. derive verdict from access level at API assembly time;
5. derive provider_type from normalized credential-type evidence;
6. bind the current account credential_version;
7. calculate the semantic fingerprint;
8. serialize only the canonical safe semantic payload into profile_json;
9. persist metadata columns + semantic JSON atomically.

Callers MUST NOT independently write `social_account_capability_profiles` or provide precomputed `access_level`, `provider_type`, `profile_fingerprint` or serialized `profile_json`.

Canonical read MUST:

- parse and validate the semantic payload;
- verify supported profile_schema_version;
- verify profile credential_version matches the account;
- recompute and verify profile_fingerprint;
- synthesize the API DTO from columns + semantic payload;
- derive verdict from access_level.

Invalid semantic JSON, unsupported profile version, stale credential version or fingerprint mismatch makes the row non-current and unusable as authorization evidence.
## 22.3 Semantic fingerprint

`profile_fingerprint` is SHA-256 of machine semantics only.

Canonicalization MUST be deterministic:

- object keys serialized in lexicographic order;
- `declaredPermissions` sorted and deduplicated;
- methods sorted by stable method identifier;
- publication formats emitted in fixed order: `TEXT`, `IMAGE`, `CAROUSEL`, `VIDEO`, `SHORT`, `STORY`;
- `requiredMethods` sorted and deduplicated;
- `requiredPermissions` sorted and deduplicated;
- stable machine state/evidence identifiers included;
- `profile_schema_version` included;
- `credential_version` included;
- canonical `access_level` included;
- provider type/validity and stable provider principal ID (`ownerId` or equivalent) included;
- destination kind/id/role/ownership evidence included;
- human display names/usernames are excluded unless the provider has no separate stable routing identifier and that exact identifier is publication-relevant.

Exclude from fingerprint:

- check timestamps/status/code/message (`last_check_*`);
- request IDs;
- latency;
- provider raw response ordering;
- human-readable identity/display names when a stable provider ID exists;
- human-readable reason/title/explanation text;
- remediation/warning prose;
- UI labels;
- all secrets.

Semantically equivalent evidence with different provider array ordering MUST produce the same fingerprint.

A real change in credential type, destination, permission set, method state or publication readiness MUST change the fingerprint.

CRED-02 will snapshot this fingerprint into READY target intent.

## 22.4 Stale-profile rule

A profile is current only when BOTH are true:

~~~text
profile.profileVersion == CURRENT_CAPABILITY_PROFILE_VERSION
profile.credentialVersion == social_accounts.credential_version
~~~

If they differ:

~~~text
profileCurrent = false
effective verdict = UNCHECKED
effective accessLevel = UNCHECKED
~~~

The stale row MAY remain for audit/debug evidence, but it MUST NOT authorize publication or be rendered as current FULL/PARTIAL capability.

Canonical read helpers MUST enforce this comparison centrally.

Required regression:

~~~text
case A:
account credential_version = N+1
stored profile credential_version = N
→ current profile rejected
→ effective UNCHECKED

case B:
stored profile profileVersion != CURRENT_CAPABILITY_PROFILE_VERSION
→ current profile rejected
→ effective UNCHECKED
~~~

## 22.5 Secret-safe profile normalization

CapabilityProfile persistence uses a strict allowlisted DTO, never arbitrary provider objects.

The canonical normalizer MUST reject or remove secret-bearing fields and values before persistence and fingerprinting.

Forbidden field names include at least:

~~~text
accessToken
access_token
botToken
token
refreshToken
refresh_token
clientSecret
client_secret
authorizationCode
authorization_code
code_verifier
secret
password
~~~

Secret-bearing URLs/query parameters MUST be sanitized before evidence persistence. Provider raw response bodies MUST NOT be stored wholesale. Human-readable provider errors may be persisted only after redaction.

Required regression injects one fake secret into provider error text, a URL query and an unexpected nested object and proves that the secret is absent from:

- `profile_json`;
- fingerprint input/debug serialization;
- returned safe profile;
- capability-module event/log evidence.

## 22.6 Deterministic access-level classifier

Access level is computed in the canonical domain module, never supplied by browser or provider prose.

Classification order:

1. provider explicitly proves invalid/expired/revoked → `INVALID`;
2. no reliable validity verdict because provider/network is unavailable → `UNAVAILABLE`;
3. inspection not completed → `UNCHECKED`;
4. credential valid and every currently implemented relevant publication format is `READY` → `FULL`;
5. credential valid, at least one implemented format `READY`, and another relevant implemented format is not `READY` → `PARTIAL`;
6. credential valid, zero `READY`, but a concrete known remediation can make an implemented format ready → `SETUP_REQUIRED`;
7. credential valid, zero `READY`, useful read/diagnostic capability exists, and no current remediation for this credential is known → `READ_ONLY`.

`NOT_IMPLEMENTED` formats MUST NOT lower FULL/PARTIAL because they are a Publikator limitation, not a key limitation.

Required classifier regressions:

- all implemented relevant formats READY → FULL;
- one READY + one BLOCKED → PARTIAL;
- zero READY + known remediation → SETUP_REQUIRED;
- zero READY + read capability + no remediation → READ_ONLY;
- explicit invalid → INVALID;
- transport/provider unavailable without invalid evidence → UNAVAILABLE;
- NOT_IMPLEMENTED-only differences do not lower FULL.

---

## 22.7 Canonical credential mutation primitive

CRED-01A MAY define the DB/domain primitive without changing routes yet.

Conceptual operation:

~~~text
replaceSocialAccountCredentials(accountId, encryptedCredentials)
~~~

For any publication-relevant credential/config replacement it atomically:

~~~text
update credentials_encrypted
credential_version = credential_version + 1
updated_at = now
invalidate/remove current capability profile
~~~

Display-name-only and `enabled`-only changes MUST use separate operations and MUST NOT bump `credential_version`.

Before any live saved CapabilityProfile is relied upon, all current credential-changing paths MUST converge on this primitive.

Known current mutation paths include:

- `POST /api/accounts`;
- `PATCH /api/accounts/:id` when credentials change;
- `POST /api/accounts/:id/activate`;
- `POST /api/accounts/:id/vk-community` when it creates or changes credential/config semantics;
- VK OAuth completion create/update;
- canonical Save-and-check;
- any future credential replacement path.

Creating a new account starts at `credential_version=1`.

---
# 23. Schema-13 migration contract

Migration 12 → 13 MUST be local-only and deterministic.

It MUST:

1. add social_accounts.credential_version with value 1 for historical rows;
2. create social_account_capability_profiles;
3. add schema 13 to SCHEMA_MILESTONES;
4. set database user_version to 13 through the existing milestone mechanism;
5. add dedicated migration regression;
6. add dedicated canonical backup/restore regression;
7. preserve all existing encrypted credentials byte-for-byte;
8. preserve social_accounts.enabled;
9. preserve project_default_targets;
10. perform zero external provider requests.

Historical accounts receive no fabricated capability profile row.

No profile row means:

~~~text
verdict = UNCHECKED
accessLevel = UNCHECKED
credentialVersion = current account credential_version
~~~

at API/render time until the operator runs Save-and-check/Recheck.

This is a bounded legacy compatibility window. CRED-01 migration MUST NOT disable existing working accounts merely because historical evidence did not yet exist.

CRED-02/CRED-03 introduce strict server-authority/preflight rules for new/changed/READY publication paths.

---

# 24. enabled semantics

social_accounts.enabled is only the operator master switch.

It MUST NOT mean:

~~~text
all publication formats are allowed
~~~

Final format eligibility is:

~~~text
account.enabled == true
AND
CapabilityProfile.publicationReadiness[requestedFormat] == READY
AND
platform adapter capability == implemented
AND
normal target/preflight invariants pass
~~~

Therefore this is valid:

~~~text
enabled = 1

TEXT      = READY
IMAGE     = BLOCKED
CAROUSEL  = BLOCKED
~~~

The account remains usable for TEXT.

A valid-but-limited credential MUST NOT be globally disabled merely because some formats are blocked.

For a newly created account through Save-and-check:

- if at least one currently implemented publication format is READY, default enabled=1;
- if zero currently implemented publication formats are READY, default enabled=0;
- INVALID or initial UNAVAILABLE/UNCHECKED accounts default enabled=0.

For an existing account re-check:

- do not silently change operator enabled for PARTIAL/FULL/SETUP_REQUIRED/READ_ONLY;
- explicit INVALID MAY force enabled=0 because no provider authorization remains;
- transient UNAVAILABLE MUST NOT erase a prior successful profile or silently toggle enabled.

Project-default-target insertion is allowed only when the new account is enabled and has at least one READY implemented format.

A later re-check that gains capability MUST NOT silently add the account to project defaults; show an explicit "Включить подключение" / project-default action.

---

# 25. Structured credential inspection contract

Save-and-check MUST NOT build CapabilityProfile from legacy success-or-throw connection tests.

CRED-01B introduces one normalized inspection function in application code, conceptually:

~~~text
inspectSocialCredential(platform, credentials, destination)
→ CredentialInspectionResult
~~~

Provider capability outcomes are returned as structured data. Exceptions are reserved for local programmer/invariant failures, not ordinary provider limitations.

CredentialInspectionResult MUST contain enough machine evidence to build a CapabilityProfile without parsing human error strings:

~~~text
credential:
  validity = CONFIRMED | INVALID | UNAVAILABLE | UNKNOWN
  providerType
  identity
  ownerId nullable
  declaredPermissions[]
  permissionsSource nullable

destination:
  resolutionState
  kind nullable
  id nullable
  name nullable
  role nullable
  ownershipConfirmed nullable

methods[]:
  method
  state
  evidenceSource
  machineCode nullable
  reason

publicationEvidence:
  TEXT | IMAGE | CAROUSEL | VIDEO | SHORT | STORY each:
    state = CONFIRMED | DENIED | SETUP_REQUIRED | UNKNOWN | UNAVAILABLE
    requiredMethods[]
    remediationCodes[]

runtimePrerequisiteEvidence[]
remediation[]
~~~

## 25.1 Failure classification

Provider/network outcomes MUST be classified before Save-and-check:

- explicit invalid/expired/revoked → credential `INVALID`;
- valid identity + insufficient destination/method right → credential stays `CONFIRMED`, capability becomes `DENIED` / `SETUP_REQUIRED`;
- timeout, DNS, 5xx, temporary provider failure → `UNAVAILABLE`;
- provider method unsupported for credential type → `NOT_SUPPORTED_FOR_CREDENTIAL_TYPE`;
- public/destructive method intentionally not executed → `NOT_CHECKED`.

No caller may infer capability/validity by matching localized human prose.

Classification is evidence-layered and monotonic within one inspection:

- once credential identity/validity is CONFIRMED, a later destination/method timeout MUST NOT downgrade credential validity to UNAVAILABLE;
- instead, preserve confirmed credential facts and mark only the unresolved destination/method/readiness layer UNAVAILABLE;
- similarly, a confirmed destination read does not disappear because a later publish-preparation probe is unavailable;
- only facts not yet established remain UNKNOWN/UNAVAILABLE.

Example:

~~~text
Telegram getMe = CONFIRMED
getChat = CONFIRMED
getChatMember = timeout

credential.validity = CONFIRMED
destination.resolution = CONFIRMED
membership/method readiness = UNAVAILABLE
overall publication access may be UNAVAILABLE,
but the key itself is not "unverified" or "invalid".
~~~

## 25.2 VK inspection requirements

Current VK classifier MUST NOT use `users.get` success as proof of USER because that method may succeed for multiple token types.

Type-specific evidence:

- GROUP: `groups.getTokenPermissions` success is GROUP evidence;
- USER: `account.getAppPermissions` success is USER evidence;
- `users.get` may provide user identity/read evidence but not USER classification by itself;
- `groups.getById` with a selected group proves readability only; without group_id for a GROUP key it identifies the credential-bound community;
- `photos.getWallUploadServer` is USER image-preparation evidence;
- `wall.post` remains `NOT_CHECKED` during normal inspection.

If GROUP- and USER-specific probes both fail without explicit invalid evidence, classify SERVICE/UNKNOWN or UNAVAILABLE from machine provider evidence. Do not invent USER.

Historical implementation prose such as `n8n`, `KEY-02`, checkpoint names or experiment names MUST NOT appear in user-facing method reasons.

## 25.3 Telegram inspection requirements

Telegram inspection preserves evidence even when publish rights are insufficient:

~~~text
getMe
→ credential validity + bot identity

getChat
→ destination resolution

getChatMember
→ membership/admin rights
~~~

If `getMe` succeeds but bot is not administrator or `can_post_messages=false`:

- credential validity remains CONFIRMED;
- identity/destination evidence remains preserved;
- publication capability becomes BLOCKED/SETUP_REQUIRED;
- remediation names the exact administrator/right change.

Preserve relevant provider-returned granular rights including post/edit/delete/story rights when present.

## 25.4 MAX inspection requirements

MAX inspection preserves token identity independently from destination write access:

~~~text
GET /me
→ credential validity + identity

GET /chats/{chatId}/members/me
→ destination role + permissions
~~~

If `/me` succeeds but `write` is absent, the credential remains CONFIRMED and write readiness becomes DENIED/SETUP_REQUIRED.

Preserve relevant provider-returned permissions as structured evidence.

## 25.5 Instagram inspection requirements

Instagram identity success alone MUST NOT imply media publishing READY.

Inspection separates:

- token/account identity;
- professional account identity/type when safely available;
- scopes/permissions when safely obtainable;
- destination/account match;
- public HTTPS media prerequisite;
- per-format provider evidence.

If safe inspection cannot prove publish authorization for IMAGE/CAROUSEL, readiness is UNKNOWN or SETUP_REQUIRED, never fabricated READY.

CRED-01B may conservatively under-claim; it MUST NOT over-claim.

## 25.6 Inspection acceptance

Focused regressions MUST cover:

- valid + fully capable;
- valid + limited rights;
- valid + read-only;
- invalid;
- unavailable;
- destination mismatch;
- provider permission present but required method denied;
- no public publish call;
- no secret leakage;
- no parsing of human prose to determine capability.

---
# 26. Canonical Save-and-check / Recheck + mutation authority

CRED-01C introduces the canonical creation and recheck endpoints:

~~~text
POST /api/accounts/save-and-check
POST /api/accounts/:id/recheck
~~~

CRED-01C consumes only the normalized structured inspection result from CRED-01B.

Request v1 preserves the current platform-specific credential/config compatibility shape. CRED-01 does not split destination/config into a new table.

For a syntactically valid non-empty credential, server order is:

~~~text
validate local request
→ persist encrypted credentials
→ initialize/bump credential_version
→ effective profile becomes UNCHECKED
→ commit local persistence
→ run CRED-01B structured inspection
→ normalize/classify
→ save through canonical profile write-path
→ return safe account + CapabilityProfile
~~~

Provider capability outcome is NOT an HTTP validation result.

These outcomes still retain the saved account:

~~~text
FULL
PARTIAL
READ_ONLY
SETUP_REQUIRED
INVALID
UNAVAILABLE
~~~

HTTP 400 is reserved for malformed/local-invalid request such as missing platform, missing/empty required secret, invalid request shape or impossible local normalization.

Provider rejection, insufficient permissions or temporary provider failure MUST become structured profile state rather than a generic 400 that loses the saved credential.

Structural duplicate conflicts MAY return 409 when the repository invariant forbids creating the same canonical connection twice.

## 26.1 Recheck

`POST /api/accounts/:id/recheck` normally has an empty body.

It:

1. loads encrypted secret server-side;
2. performs CRED-01B structured inspection;
3. updates check metadata/profile through the canonical write-path;
4. returns only safe account/profile data.

Browser MUST NOT resend a stored secret.

Transient UNAVAILABLE on recheck:

- updates `last_check_status` and `last_check_at`;
- preserves prior successful semantic profile/fingerprint when credential_version still matches;
- does not silently toggle operator `enabled`.

Explicit INVALID replaces effective profile and may disable according to section 24.

## 26.2 Credential mutation convergence is mandatory in CRED-01C

CRED-01C is the first live route layer that persists/uses capability profiles. Therefore every current credential-changing path MUST use the canonical mutation primitive before this checkpoint is DONE.

Required inventory:

- `POST /api/accounts`;
- `PATCH /api/accounts/:id` credential/config replacement;
- `POST /api/accounts/:id/activate`;
- `POST /api/accounts/:id/vk-community` when it creates/changes credential/config semantics;
- VK OAuth completion create/update;
- new Save-and-check;
- any future credential replacement path.

Creating a new account starts at `credential_version=1`.

Updating an existing credential/config must be atomic:

~~~text
credentials_encrypted changes
→ credential_version++
→ old profile invalidated
→ new inspection/profile or effective UNCHECKED
~~~

No route may leave a current-looking FULL/PARTIAL profile attached to changed credentials.

This requirement supersedes the earlier plan to defer credential mutation convergence to a later server-authority checkpoint.

## 26.3 Legacy endpoints

Existing `POST /api/accounts` MAY delegate to Save-and-check for compatibility.

Existing `/api/accounts/:id/test` MAY delegate to Recheck or remain an explicitly ephemeral diagnostic endpoint, but it cannot be an independent source of truth.

Browser-provided `authKind`, `publishReady`, provider type, permission flags and access level are never evidence.

---

# 27. Recheck and freshness policy

CRED-01 introduces no background polling and no arbitrary time TTL.

A profile is current only when:

- profile credential_version equals account credential_version;
- no publication-relevant credential/destination mutation occurred after inspection.

Mutation invalidates the current profile immediately.

UI always shows:

- last check attempt;
- last successful check when available.

Transient provider/network failure on recheck:

- MUST NOT destroy prior successful semantic profile;
- sets `last_check_status=UNAVAILABLE`, updates `last_check_at`, and stores safe redacted `last_check_code` / `last_check_message`;
- preserves previous access level/profile_json/fingerprint when credential_version still matches;
- UI warns that the latest recheck failed and shows last successful evidence time.

If no prior successful profile exists, effective access level is UNAVAILABLE.

Explicit provider INVALID/REVOKED evidence replaces the effective profile with INVALID and may disable the account as defined in section 24.

Future automatic revalidation before READY/publish is CRED-02 scope.

---

# 28. Visible Socials UI

CRED-01D implements the operator UX only after CRED-01A/B/C are accepted.

UI consumes the server-owned profile and shows:

- key verdict;
- exact access level;
- TEXT / IMAGE / CAROUSEL / VIDEO / SHORT / STORY matrix;
- expandable identity/permission/method evidence;
- last check status/timestamps;
- exact remediation actions.

UI MUST NOT parse provider errors or re-run the access classifier.

---

# 29. READY capability binding

CRED-02 makes capability evidence part of immutable publication intent.

READY/preflight must require:

~~~text
account enabled
current profile credential_version == account credential_version
requested format == READY
profile fingerprint current
destination current
adapter capability implemented
~~~

READY target snapshot/fingerprint binds at least:

- account id;
- destination kind/id;
- credential_version;
- profile_fingerprint;
- publication-relevant options.

Credential/destination change after READY must invalidate READY or leave publication bound to the old immutable approved intent. It must never silently redirect.

---

# 30. Legacy compatibility stages

## CRED-01A

Adds schema/profile persistence primitives only. Historical accounts remain operational; migration performs no provider calls.

## CRED-01B

Adds structured provider inspection. No saved profile route flow yet.

## CRED-01C

Adds Save-and-check/Recheck and converges all credential mutation paths onto credential_version/profile invalidation.

## CRED-01D

Adds the visible access-level/capability/remediation UI.

## CRED-02

Adds capability-aware READY/publish preflight and immutable destination/profile binding.

This staged rollout prevents schema migration itself from depending on provider availability or unexpectedly disabling all historical accounts.

---

# 31. Definition of Done


Credential handling is DONE only when a non-technical user can paste/save a credential and immediately understand:

1. whether the provider accepts it;
2. what type it is;
3. who/what owns it;
4. what provider permissions were detected;
5. which safe methods are available;
6. which Publikator publication formats are READY;
7. which formats are unavailable;
8. whether the limitation is the key, destination, provider setup or Publikator implementation;
9. exactly what to do to improve access;
10. that the limited credential is still safely saved and usable for whatever it actually supports.

A page that says only "Подключение работает" or "Ключ неверный" is non-compliant.


## VK photo credential roles — VK-PHOTO-CREDENTIAL-ROLES-001
An existing COMMUNITY connection may carry an optional encrypted USER uploadAccessToken. GROUP eligibility for photos is not inferred: the secondary USER is separately verified with account.getAppPermissions, users.get identity and a safe photos.getWallUploadServer request for the primary's bound community. The primary GROUP's wall permission and destination match remain required. Photo-method evidence must identify the secondary actor; primary credential validity remains independent of secondary readiness.

The implemented transport is the existing wall-photo path. photos.getWallUploadServer/photos.saveWallPhoto use USER; wall.post uses the verified GROUP. Inspection/save/READY never upload a file or publish. A missing, invalid, IP-bound or wrong-type secondary key leaves TEXT available and IMAGE/CAROUSEL SETUP_REQUIRED with exact remediation. Browser readiness flags are never authority. The secondary secret is part of the same encrypted/versioned credential envelope, is never returned by account listing, and its verified owner is checked again before upload. Album/archive transport remains unimplemented.

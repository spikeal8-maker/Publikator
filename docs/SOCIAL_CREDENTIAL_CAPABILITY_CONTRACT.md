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
◇ TEXT — текущий TEXT_ONLY adapter Publikator не включён
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

Current schema evidence:

| VK method | USER | GROUP | SERVICE | What it proves |
| --- | --- | --- | --- | --- |
| users.get | allowed | allowed | allowed | user data/identity read; NOT sufficient by itself to classify token type |
| groups.getById | allowed | allowed | allowed | group object readability; NOT ownership/admin proof |
| groups.getTokenPermissions | no | allowed | no | declared GROUP-token permissions |
| account.getAppPermissions | allowed | no | no | USER application permission mask |
| photos.getWallUploadServer | allowed | no | no | current wall-photo preparation availability |
| photos.saveWallPhoto | allowed | no | no | current wall-photo save step |
| photos.getUploadServer | allowed | no | no | album upload preparation; does not make GROUP token publish-capable |
| photos.save | allowed | no | no | album photo save step |
| wall.post | allowed | no | no | public wall publication method in current schema |

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
3. groups.getById when destination is known;
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

Publikator SHOULD persist the latest capability result/evidence metadata so the connection card survives reload.

Persist at least:

- checked_at;
- access level;
- credential provider type;
- identity;
- destination;
- declared permissions/scopes;
- method statuses/evidence;
- per-format readiness;
- profile version/fingerprint.

Never persist secret copies inside capability evidence.

A re-check replaces/versions the evidence.

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

Before speculative alternate transports, implement the credential foundation in bounded checkpoints.

Canonical order:

1. CRED-01A — schema 13 + persisted safe CapabilityProfile DTO.
2. CRED-01B — canonical Save-and-check / Recheck server flow.
3. CRED-01C — visible Socials UI: verdict, access level, can/cannot matrix and remediation.
4. CRED-02 — remove server activation/update bypasses from legacy POST/PATCH/activate paths.
5. CRED-03 — READY destination + credential/profile binding and capability-aware preflight.
6. CRED-04 — exact VK USER/GROUP/SERVICE diagnostics and permission evidence.
7. CRED-05 — Telegram/MAX/Instagram granular diagnostics.
8. CRED-06 — controlled live publication acceptance and evidence.

Each A/B/C slice is a separate checkpoint/branch/PR. Do not implement CRED-01 as one giant PR.

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

profile_json is safe non-secret evidence only. It MAY contain identity, destination, declared permissions, method statuses, per-format readiness and remediation. It MUST NOT contain access tokens, bot tokens, client secrets, authorization codes or any secret-bearing URL.

profile_schema_version starts at 1.

provider_type is a normalized provider credential type such as USER, GROUP, SERVICE, BOT, UNKNOWN; platform-specific values are allowed but must be documented.

## 22.1 Capability DTO v1

The server-owned DTO persisted inside/synthesized from the profile MUST have these semantics:

~~~text
profileVersion: 1
accountId
credentialVersion
profileFingerprint
checkedAt
lastCheckStatus

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

## 22.2 Semantic fingerprint

profile_fingerprint is SHA-256 of a deterministic canonical representation of semantic publication evidence:

~~~text
profile_schema_version
credential_version
provider_type
credential validity/type/identity
destination kind/id/role evidence
declared permissions
method states
publication readiness
publication-relevant adapter/config evidence
~~~

Exclude volatile fields such as checkedAt, request IDs, latency and transient prose.

A successful re-check with identical semantic capabilities SHOULD keep the same fingerprint.

A real change in credential type, destination, permissions, method capability or per-format readiness MUST change the fingerprint.

CRED-03 will snapshot this fingerprint into READY target intent.

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

# 25. Canonical Save-and-check API

CRED-01B introduces the canonical creation endpoint:

~~~text
POST /api/accounts/save-and-check
Content-Type: application/json
~~~

Request v1:

~~~json
{
  "platform": "vk",
  "name": "ASA Lab",
  "credentials": {
    "...": "platform-specific input including destination fields used by the current compatibility model"
  }
}
~~~

CRED-01 does NOT split destination/config into a new table. It preserves the current credentials_encrypted compatibility shape and adds a safe external CapabilityProfile.

For a syntactically valid non-empty credential, server order is:

~~~text
validate request shape
→ create account id
→ encrypt and persist credentials
→ credential_version=1
→ persist UNCHECKED profile state
→ run provider inspection
→ persist capability result
→ return safe account + CapabilityProfile
~~~

Provider capability result is NOT an HTTP validation result.

Therefore these outcomes still return a persisted account:

~~~text
FULL
PARTIAL
READ_ONLY
SETUP_REQUIRED
INVALID
UNAVAILABLE
~~~

Recommended response:

~~~text
201 Created
~~~

~~~json
{
  "account": {
    "id": "acc_...",
    "platform": "vk",
    "name": "ASA Lab",
    "enabled": false
  },
  "capabilityProfile": {
    "profileVersion": 1,
    "verdict": "LIMITED",
    "accessLevel": "SETUP_REQUIRED"
  }
}
~~~

HTTP 400 is reserved for malformed input such as missing platform, missing/empty secret, invalid request shape or impossible local normalization.

Provider rejection/insufficient permissions MUST be represented in the capability profile, not converted into a generic 400 that loses the saved credential.

Structural duplicate conflicts MAY return 409 when the existing repository invariant forbids creating the same canonical connection twice.

## 25.1 Recheck

Canonical saved-account inspection:

~~~text
POST /api/accounts/:id/recheck
~~~

Normal body is empty.

It:

1. loads encrypted secret server-side;
2. performs current safe provider inspection;
3. updates check metadata/profile;
4. returns only safe account/profile data.

Browser MUST NOT resend a saved secret.

Existing /api/accounts/:id/test MAY temporarily delegate to the same implementation for compatibility, but new UI uses /recheck.

## 25.2 Existing unsaved test endpoint

POST /api/accounts/test MAY remain as an optional ephemeral diagnostic endpoint.

It is not activation authority and is not the primary UI flow.

The primary UI is Save-and-check.

## 25.3 Legacy create/update endpoints

After CRED-01B:

- existing POST /api/accounts MUST NOT create an enabled publish connection from client-asserted authKind, permissions or publishReady;
- it SHOULD delegate to the same server-authoritative save/inspection path where compatibility requires the route;
- existing PATCH/activate bypasses are fully converged in CRED-02.

No endpoint may treat browser-provided capability fields as evidence.

---

# 26. Recheck and freshness policy

CRED-01 deliberately introduces no background polling and no arbitrary time TTL.

A profile is current when:

- its credential_version equals the account credential_version;
- no credential/destination/capability-relevant mutation has occurred since inspection.

Immediate invalidation triggers:

- secret replacement;
- destination change;
- provider API version/config change that affects capability;
- any other publication-relevant credential/config mutation.

Mutation transaction:

~~~text
update credentials_encrypted
→ credential_version += 1
→ remove/invalidate current capability profile
→ effective state becomes UNCHECKED
~~~

Manual Recheck creates fresh evidence.

UI always shows:

- last check attempt;
- last successful check when available.

Transient provider/network failure on recheck:

- MUST NOT destroy a previous successful semantic profile;
- sets last_check_status=UNAVAILABLE and updates last_check_at;
- preserves previous access level, profile_json and semantic fingerprint when a prior successful profile exists;
- UI shows a warning that the latest recheck failed and displays the time of the last successful evidence.

If there is no prior successful profile, the effective access level is UNAVAILABLE.

Explicit provider INVALID/REVOKED evidence replaces the effective profile with INVALID and MAY disable the account as defined in section 24.

Future automatic revalidation before READY/publish is CRED-03 scope.

---

# 27. Legacy compatibility stages

The credential foundation is intentionally staged.

## CRED-01

Adds schema/profile persistence, Save-and-check/Recheck and visible access-level UX.

Historical accounts remain operational under the bounded legacy compatibility described in section 23.

## CRED-02

Makes server verification authoritative for every create/update/enable/credential replacement path.

No direct API bypass remains.

## CRED-03

Adds capability-aware READY/publish preflight and immutable destination/credential/profile binding.

At this point a target cannot enter/use READY publication intent without an appropriate current capability profile for the requested format, except for any explicitly documented one-time migration exception.

This staged rollout prevents schema migration itself from depending on provider availability or unexpectedly disabling all historical accounts.

---

# 28. Definition of Done

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

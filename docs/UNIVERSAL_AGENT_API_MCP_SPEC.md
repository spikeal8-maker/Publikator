# PUB-AGENT-MCP-001 — универсальный REST API, MCP и управление ИИ-агентами

**Статус:** NORMATIVE IMPLEMENTATION SPEC / продуктовая программа P0, реализация не началась в рамках данного документа  
**Дата:** 25 октября 2026 года  
**Основная задача:** [Issue #172](https://github.com/spikeal8-maker/Publikator/issues/172)  
**Репозиторий:** `spikeal8-maker/Publikator`  
**Зафиксированный baseline первоначального аудита:** `main@2b2cb75132c8b5ddb1ad49f254c805ce6cea34bb`, SQLite schema `14`. **Актуализация 25.10.2026:** PR #171 объединён в `main@e869dd098364e1040e77f4cf4d638e91705edc65`; до реализации проверять ещё более свежий HEAD, а не выполнять слепой checkout на старый SHA.  
**Область:** только `main`/vNext; ветка `release/1.0` не затрагивается.

## 0. Нормативность и принцип продукта

Это **детальная спецификация интеграционного направления**, подчинённая `VNEXT_TECHNICAL_SPEC.md`, `SOCIAL_CREDENTIAL_CAPABILITY_CONTRACT.md`, `ARCHITECTURE.md`, `DEVELOPMENT_RULES.md` и `RELEASE_MIGRATION_POLICY.md`. При противоречии использовать установленный в `VNEXT_TECHNICAL_SPEC.md` порядок приоритета; не переписывать доменную модель этим приложением.

**Целевой сценарий владельца:**

> Я прошу ChatGPT или другого бота взять материалы из разрешённой папки Google Drive, подготовить один текст и несколько фотографий в выбранном порядке, отметить конкретные аккаунты VK/Telegram/MAX/Instagram, показать точный предпросмотр, запланировать или отправить после моего согласования и вернуть фактические ссылки/ошибки отдельно по каждой площадке.

Используемые клиенты не обязаны знать слова `ContentRevision`, `READY`, `Queue`, `TargetRendition` и устройство SQLite. API может содержать эти понятия внутри, но возвращает понятно названные действия, статусы и инструкции исправления.

**MUST:** одна каноническая бизнес-операция и единая проверка прав для Web UI, REST API и MCP. **MUST NOT:** самостоятельный publisher в MCP, отдельный scheduler, вторая runtime-БД, дублирующий контур публикации. **MUST NOT:** отправлять реальные публичные посты по умолчанию или менять рабочий D2-R2 в ходе разработки/тестов.

### 0.1 Что уже существует: не реализовывать повторно

| Есть в `main` | Доказательство в коде | Что реально ещё отсутствует для агента |
|---|---|---|
| Fastify, browser API, legacy auth | `src/app.ts`, `src/http/routes.ts` | независимый авторизованный Agent API/MCP |
| Integration API + hashed `pk_` keys + rate limit/revoke/rotate | `src/http/integration-api.ts`, `src/integration-security.ts` | гранулярные grants, полный OpenAPI, агентские операции медиа/отправки |
| Создание/чтение/изменение DRAFT, request-review | `src/http/integration-api.ts` | end-to-end агентский composer, approvals, publish/status |
| Google Sheets/Drive/Яндекс Диск | `src/http/google-sheets.ts`, `src/google-drive-media.ts`, `src/yandex-disk-media.ts` | scoped агентский поиск/импорт с проверкой источника |
| Editor, preflight, scheduler, targets, provider adapters | `src/http/routes.ts`, `src/publisher.ts`, `src/scheduler.ts`, `src/platforms/` | безопасный единый application facade для REST/MCP и Web UI |
| Schema milestones и backup/restore | `src/schema.ts`, `docs/RELEASE_MIGRATION_POLICY.md` | миграции agent principal/grant/consent/jobs по мере необходимости |

В `src/integration-security.ts` уже определены scopes `media:write` и `publish:request`, **но обычная выдача ключей в `src/http/integration-api.ts` разрешает лишь четыре более узких scope**. Объявленный scope не означает существующего публичного маршрута или разрешения на отправку.

`/api/integration/v1` и его semantics продолжают работать. Новый контракт не переопределяет legacy endpoint. Существующий `/api/posts/:id/publish-now` защищён административной browser session и **не является готовым агентским publish API**.

В [Issue #170](https://github.com/spikeal8-maker/Publikator/issues/170) и [PR #171](https://github.com/spikeal8-maker/Publikator/pull/171) реализован единый быстрый composer (текст + фото + список конкретных аккаунтов). **PR #171 MERGED 25.10.2026** в `e869dd098364e1040e77f4cf4d638e91705edc65`: AGENT-04 MUST использовать уже принятый пользовательский сценарий и переиспользовать существующий серверный контур, не разрабатывать второй редактор.

Другие зависимости: [#144](https://github.com/spikeal8-maker/Publikator/issues/144), [#145](https://github.com/spikeal8-maker/Publikator/issues/145) (credential mutation/capability UI), [#160](https://github.com/spikeal8-maker/Publikator/issues/160) (Google source и реальная VK-готовность). Интеграция не объявляет ограниченные VK-ключи пригодными для фото.

## 1. Поддерживаемые клиенты и границы гарантии

| Клиент | Предпочтительный интерфейс | Поддерживающий путь | Приёмка |
|---|---|---|---|
| ChatGPT (custom MCP/plugin) | remote MCP over HTTPS либо Secure MCP Tunnel | REST-интеграция, если инструменты записи не предоставляются текущим клиентом | фактическое создание подключения, сканирование tools, авторизованные calls |
| Custom GPT Actions | OpenAPI 3.1 / HTTP | — | вызовы через реальный Actions client |
| OpenAI Codex | MCP | REST | минимум `tools/list`, `tools/call` и один scoped draft |
| Claude / Claude Desktop / Claude Code | MCP (совместимая версия клиента) | REST | конкретная версия клиента зафиксирована в matrix |
| Cursor / IDE агенты | MCP (remote или локальный bridge) | REST | реальный клиентский handshake/call |
| n8n, Telegram/MAX боты, Python/Node, CI | REST + webhooks | MCP при поддержке реализации клиента | machine-to-machine flow |
| Собственные агенты любого производителя | REST или MCP | polling/webhooks | контрактные тесты без vendor lock-in |

Совместимость обеспечивается **на уровне протоколов и проверенного клиентского набора**, а не обещанием работы в любой модели/подписке/версии. Поддержка write-инструментов ChatGPT может зависеть от доступных пользователю возможностей: если write MCP недоступен, необходимо предложить доступный REST/Actions workflow, не обходить ограничения клиента.

Не требовать OpenAI API Key для использования собственного ChatGPT-клиента. Наличие Google Drive Plugin в чате **не даёт автоматически** Publikator права на тот же Drive.

## 2. Архитектура и границы ответственности

```text
ChatGPT / Codex / Claude / Cursor / Custom GPT / n8n / bots
           │ REST/OpenAPI или MCP (OAuth/API-key)
           ▼
     AuthN + AuthZ + project/account/source policy
           │
      Agent Application Services
      ├── Query + Composer + MediaImport
      ├── Preflight + Approval + Schedule
      ├── PublishRequest + Status + Job + Events
           │
     Existing Publikator canonical domain
     ├── Post/ContentRevision/MediaAsset/Targets
     ├── PlatformCapability + CredentialCapabilityProfile
     ├── SQLite/WAL + local media
     └── publisher/scheduler/recovery
           │
     VK / Telegram / MAX / Instagram
```

- **MUST:** оставить один production Docker container, Fastify process, SQLite/WAL и локальный scheduler по `VNEXT_TECHNICAL_SPEC.md`.
- **MUST:** new Agent REST and MCP adapters вызывают общий application service in-process. Нельзя использовать административную cookie-сессию, вызовы `inject` или HTTP к своему собственному API как внутреннюю authority.
- **MUST:** Web UI и API используют те же валидаторы, определения форматов, canonical media ordering и server-authoritative preflight. Принятый редактор PR #171 и Agent API должны постепенно использовать общие Application Services без изменения работающего пользовательского сценария.
- **MUST:** 1Panel управляет инфраструктурой/сертификатами, но не содержанием постов. Нельзя выдавать 1Panel administrative API как Publikator capability.
- **MUST:** никакой обязательной n8n/Redis/RabbitMQ/second worker/second scheduler; архитектурное исключение — только отдельный ADR, явно утверждённый владельцем.

Рекомендуемые границы исходников (имена уточняются после чтения существующих модулей): `src/agents/{commands,queries,policies,authz,publication-intents,jobs,audit}.ts`, `src/http/agent-api-v1.ts`, `src/mcp/{server,tools,resources,auth}.ts`. Запрещено механически создавать параллельные сущности вместо использования `src/publisher.ts`/`src/content-versioning.ts`.

## 3. Контракт идентичностей и разрешений

### 3.1 Идентичности

Для каждого подключённого клиента создавать отдельную `AgentPrincipal`, связанную с владельцем одной установки (текущая single-admin архитектура). **Не вводить новый многопользовательский RBAC приложения** этим проектом.

Реквизиты: `agentId`, `ownerAdminId`, `name`, `clientKind`, `authType`, `status` (ACTIVE/PAUSED/REVOKED), `createdAt`, `lastUsedAt`, `expiresAt`, `tokenVersion`. OAuth-токены и machine API keys имеют отдельные безопасные идентификаторы и **не хранятся в plaintext**.

`AgentGrant` хранит:
- разрешённые scopes;
- allowlist `projectId[]`, `accountId[]`, `sourceConnectorId[]` / конкретных корневых папок;
- режим публикации (`DRAFT_ONLY`, `OWNER_APPROVAL`, `PREAPPROVED_POLICY`);
- ограничения количества, периода, форматов, времени публикации, expiration;
- изменяемую генерацию политики `policyVersion` и автора изменения.

По умолчанию **DRAFT_ONLY**, все allowlists пусты до явного выбора. `*`/«все аккаунты» не выдавать неявно: доступы разрешаются только после отдельного согласия владельца.

### 3.2 Политика каждой операции

Запрос разрешён **только** если одновременно соблюдены:

`authenticated principal ∩ active token scopes ∩ AgentGrant ∩ project/account/source ACL ∩ provider capability ∩ content lifecycle ∩ exact consent/policy`.

MUST фильтровать списки по разрешённым ресурсам и отдельно повторно проверять каждый ID на write. Нельзя считать доступ к проекту разрешением постить во все подключённые аккаунты. Клиент не может объявить `publishReady`, `authKind`, `providerType` или `credentialCapability` собственным payload.

Раздельные permissions: `projects:read`, `accounts:read`, `sources:read`, `media:read`, `media:import`, `posts:read`, `posts:write`, `posts:preview`, `approval:request`, `schedule:write`, `publish:request`, `jobs:read`, `events:read`.

Роли Observer/Editor/Producer/Coordinator/Publisher — UI-наборы предложенных scopes, **не** широкие привилегии по умолчанию. Administrative credential management, permanent deletion, credential export/rotation и webhook registration не должны входить в обычный набор агента.

### 3.3 Обязательная безопасность

- Отдельная аутентификация `/mcp` и `/api/agent/v1`; существующий `/api/` cookie guard не является авторизацией для новых путей.
- Token hashes/opaque or signed tokens with server-side revocation; refresh token rotation/replay detection; короткие сроки access-token; проверка issuer, audience, expiry, scopes, client binding, resource.
- Не раскрывать `APP_MASTER_KEY`, Google Service Account private key, provider tokens, admin cookie, OAuth authorization code/refresh token.
- Сквозные audit events по `actorId`/`requestId`/`jobId`, masked token ID, action, target IDs; redact тела HTTP/MCP/Webhook ответов от секретов.
- Rate limits per actor AND operation; выдача/отзыв грантов, подписи webhook, стоп всех agent publishing без остановки пользовательского UI.
- Данные Google Drive, тексты публикаций и изображения — untrusted content, не системные команды; prompt injection в материале не меняет scopes, аккаунты, состав recipients и consent.
- Ни SQL, ни filesystem, ни shell, ни произвольный fetch прокси, ни настройки 1Panel не экспортировать через MCP.
- Browser CSRF/origin защита остаётся. Для HTTP/MCP использовать Bearer и проверку Host/Origin как применимо; запрещены анонимные write-tools.

## 4. Авторизация внешних клиентов

### 4.1 Remote MCP: OAuth

Для remote MCP MUST поддерживать защищённый OAuth Authorization Code + PKCE для публичных клиентов, при необходимости confidential client flow; HTTPS, discovery и привязка токена к Publikator resource.

Обязательные элементы: OAuth Protected Resource Metadata (RFC 9728), AS metadata (RFC 8414 / OIDC discovery при применении), Resource Indicators (RFC 8707), issuer check (RFC 9207), token audience validation, проверка `state`/PKCE/redirect URI, consent scopes, refresh/revocation. **Не реализовывать собственную криптографию OAuth «с нуля»**, использовать проверенную библиотеку/провайдера с интеграцией в существующий процесс либо ADR для внешнего issuer.

Client ID Metadata Documents (CIMD) — приоритетный способ регистрации, если конкретный клиент поддерживает. Static clients поддержать обязательно для проверяемого подключения; Dynamic Client Registration — только ограниченный и проверенный compatibility path, когда он нужен конкретному клиенту (в актуальном MCP DCR deprecated). Все redirect URI и client identity валидировать, не допускать произвольного privileged self-registration.

### 4.2 Machine-to-machine

Для n8n/Telegram/других unattended клиентов сохранить подход hashed `pk_` keys, scoped и per-agent. Новая агентская схема не должна автоматически расширять разрешения существующих Integration API keys. Bearer key выдаётся один раз, далее только rotate/revoke.

Не использовать static master API key на всех клиентов. Возможность OAuth client credentials (`client_credentials`) — MAY при настоящей потребности и явной client policy; это не замена authorization code для ChatGPT.

### 4.3 Деплой транспорта

Вариант A: HTTPS remote `/mcp` за доверенным reverse proxy с OAuth. Вариант B: официально поддерживаемый Secure MCP Tunnel для приватного D2-R2. Вариант C: локальный stdio bridge у поддерживаемого клиента, вызывающий те же application services/REST с собственным credential.

На D2-R2 текущий Publikator слушает `127.0.0.1:8080` — НЕ открывать напрямую на `0.0.0.0` ради агента. При публичном ingress публиковать только утверждённые пути, сохранить loopback внутренней службы, SSL/TLS, exact forwarded proxy trust, request limits. Настройка tunnel/domain — отдельное acceptance, не часть фиктивного «CI уже подключил ChatGPT».

## 5. REST Agent API — контракт

База: `/api/agent/v1`; старый `/api/integration/v1` неизменен. OpenAPI `3.1` генерируется из валидируемых серверных DTO (не hand-written summaries без schemas). Для каждого метода требуются `operationId`, request/response JSON Schema, `security`, error codes, pagination и примеры.

| Метод | Путь | Scope | Поведение |
|---|---|---|---|
| GET | `/capabilities` | authenticated | effective scoped tools, formats, limits |
| GET | `/projects` | `projects:read` | только разрешённые проекты |
| GET | `/accounts` | `accounts:read` | accountId, platform, destination, per-format readiness/remediation |
| GET | `/sources` | `sources:read` | разрешённые Drive/Sheets/Yandex connectors |
| GET | `/media` | `media:read` | assets, search + pagination, без приватных raw paths |
| POST | `/media/import` | `media:import` | sourceConnectorId + relativePath[] → job/media IDs |
| GET | `/posts`, `/posts/:id` | `posts:read` | scoped post list/detail with pagination |
| POST | `/posts` | `posts:write` | one logical draft create, canonical text/targets/media order |
| PATCH | `/posts/:id` | `posts:write` | expectedContentVersion; no mutate immutable publish |
| POST | `/posts/:id/preview` | `posts:preview` | effective renditions, downgrade report; no publish |
| POST | `/posts/:id/preflight` | `posts:preview` | per-target capability/credential validation; no publish |
| POST | `/posts/:id/request-approval` | `approval:request` | requests owner approval; does not self-approve |
| GET | `/posts/:id/approval` | `posts:read` | consent state, revision/fingerprint, expires |
| POST | `/posts/:id/schedule` | `schedule:write` | binds approved intent, UTC + IANA zone |
| POST | `/posts/:id/publish` | `publish:request` | one safe publish intent, not direct provider POST |
| GET | `/posts/:id/status` | `posts:read` | each target status, external links, recovery instructions |
| POST | `/posts/:id/cancel-schedule` | `schedule:write` | only pending not claimed jobs |
| GET | `/jobs`, `/jobs/:id` | `jobs:read` | durable state/results, pagination |
| GET | `/events` | `events:read` | cursor-based safe event feed |
| POST | `/webhook-subscriptions` | admin-only | signed destination configuration, not generic agent |

**MUST:** публикация использует существующие `ContentRevision`, `TargetRendition`, `PostTarget`, `PublicationUnit`, `scheduler` и `publisher`. Не ставить READY при неверном profile/destination и не считать scope `publish:request` разрешением обходить owner policy.

### 5.1 Канонические DTO

`CreateDraftRequest`:
- `projectId` (optional только при однозначном owner-approved default), `internalTitle?`;
- `bodyRich` и `bodyPlain`, нейтральная AST модель `rich-text` (не raw VK/Telegram Markdown как master);
- `publicationKind` / `contentFormat` выводятся по данным или задаются явно с серверной проверкой;
- `mediaAssetIds[]` упорядочены и уникальны; `sourceReference[]` предварительно импортированы в каноническую media library; ни raw произвольные URL, ни Dropbox/Google tokens в payload не передавать;
- `targetAccountIds[]` явные точные ID, несколько аккаунтов одной платформы допустимы;
- `targetTextOverrides[]` только для выбранных target ID;
- `schedule` = MANUAL / AT / QUEUE; AT = UTC instant + IANA timezone;
- `clientRequestId`/`idempotencyKey` для client replay.

`DraftResponse`: `postId`, `contentVersion`, `status`, `mediaIds`, `targetAccountIds`, `warnings[]`, `links`, `requestId`. При импорте файлов сначала выдаётся `jobId` (202 Accepted); затем клиент вызывает создание поста с готовыми `mediaAssetIds`. Пользовательский «одно действие» реализуется оркестрацией server-side и UI без ручного перезахода в редактор. Partial failure не создаёт дубликатов; результат содержит ссылку на восстанавливаемый draft.

`PreviewResult`: resolved text per account, safe thumbnail/media ID + order, формат и размер, downgrade warnings, конкретные blocked targets и рекомендации. **MUST NOT:** отображать «успешно опубликовано», когда это лишь подготовка.

`PublicationStatus`: postId, exact approved revision, requested mode/time, per-account {accountId, platform, state, externalId?, externalUrl?, errorCode?, remediation?}, overall status and `recoveryNeeded`. Не скрывать PARTIAL и неверные credentials одним зелёным «Готово».

`ApiError`: {error: {code, message, details?}, requestId, retryable?, remediation?}; стабильные коды `UNAUTHORIZED`, `FORBIDDEN_SCOPE`, `RESOURCE_DENIED` (404 для скрываемых ресурсов), `POLICY_DENIED`, `VALIDATION_ERROR`, `PRECONDITION_REQUIRED`, `CONTENT_VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `APPROVAL_REQUIRED`, `CAPABILITY_BLOCKED`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `RECOVERY_NEEDED`. `Retry-After` для 429; никаких stack traces, provider токенов или персональных данных в errors.

### 5.2 Идемпотентность и долговременность

Все mutation endpoints MUST принимать `Idempotency-Key`, привязанный к `agentId + operation + logical resource`, и хешу canonical payload; сохранять receipt в SQLite до внешнего действия.

- Same key + same payload возвращает исходный job/result без повторной внешней отправки.
- Same key + другой payload → 409 `IDEMPOTENCY_CONFLICT`.
- Concurrent requests одного recipient/revision не могут создать два provider `POST`: использовать существующий atomic claim; нельзя держать DB transaction во время network I/O.
- Если outcome provider unknown, пометить `RECOVERY_NEEDED`; не делать generic retry.
- Cроки TTL receipts и порядок cleanup определить в пакете A0, совместить с сохранением доказательств публикаций.
- GET list endpoints иметь серверную пагинацию, bounded page size, курсор либо стабильную сортировку; no cross-agent data leakage.

## 6. MCP server и протокол

Основной transport: **Streamable HTTP `POST /mcp`**, совместимый с официальной спецификацией `2026-07-28` и проверяемой клиентской матрицей. Использовать поддерживаемый официальный TypeScript SDK и закреплять dependency version; запрещено hand-roll JSON-RPC parser/auth.

Для `2026-07-28`: stateless core, request-level protocol metadata, заголовки `MCP-Protocol-Version`, `Mcp-Method`/`Mcp-Name`, `server/discover`, deterministic `tools/list`, cache hints и server identity in result `_meta`. Не вводить обязательные устаревшие `initialize`/`Mcp-Session-Id` в modern path. Для старых handshaking клиентов добавить **только явно протестированный** compatibility path, без неявного bypass auth, и отдельно фиксировать поддерживаемые версии в matrix.

### 6.1 Инструменты

| Tool | Application operation |
|---|---|
| `publikator_get_capabilities` | effective capabilities/grants |
| `publikator_list_projects` | projects.query |
| `publikator_list_accounts` | accounts.query with per-format readiness |
| `publikator_list_sources` | connectors.query |
| `publikator_search_media` | media.query |
| `publikator_import_media` | media.import job |
| `publikator_list_posts` / `publikator_get_post` | posts.query |
| `publikator_create_post` / `publikator_update_post` | composer create/edit |
| `publikator_preview_post` / `publikator_preflight_post` | canonical preview/preflight |
| `publikator_request_approval` / `publikator_get_approval_status` | approval service |
| `publikator_schedule_post` / `publikator_cancel_schedule` | schedule service |
| `publikator_publish_post` | publish intent (policy gated) |
| `publikator_get_publication_status` | per-target publishing evidence |
| `publikator_get_job` / `publikator_list_jobs` | jobs.query |

Каждый Tool MUST иметь JSON Schema, краткое русское и/или английское описание, explicit side-effect annotation и bounded structuredContent. Возвращать ID/ссылки для последующих операций, а не гигантский дамп базы. Список инструментов фильтруется по разрешениям, но **каждый tools/call** MUST заново проверить grant на сервере.

MCP Resources MAY предоставлять scoped descriptions/preview/status без секретов; медиа должны быть доступны только авторизованному клиенту по bounded URL/content (не публичные вечные URL). MCP Prompts MAY предлагать готовые сценарии, но не могут выдавать grants или approvals.

MCP Apps interactive UI — **опционально**, не требование для первой интеграции; инструменты должны работать в клиенте, который не рендерит MCP App.

### 6.2 Конкретный ChatGPT flow

- Создать подключение к remote HTTPS MCP или Tunnel; пройти OAuth/consent; просканировать tools.
- Проверить `list_accounts`/`list_sources` и создание draft с реально scoped grant.
- Подключение не считать завершённым только по 200 от `/mcp` или локальному SDK smoke.
- Инструменты могут кэшироваться клиентом: после изменения `tools/list` документировать обновление подключения и проверку актуальных permissions.
- Если аккаунт/рабочее пространство не даёт ChatGPT write-tools, честно зафиксировать `UNSUPPORTED_CLIENT_ENTITLEMENT` и проверить write через поддерживаемый клиент/REST без обхода модели прав.

## 7. Медиа и внешние источники

### 7.1 Google Drive

Сохранить существующий service-account connector с root folder и Google `drive.readonly`. Агент видит только разрешённый connector/root folder.

MUST предоставить поиск по относительному пути/имени, MIME, размерам, разрешённой вложенности и pagination; идемпотентный import по file ID + revision; downloaded bytes проверяются, SHA-256/dedupe, MIME sniffing, лимиты, EXIF/orientation, normalizer, persistence into Publikator media. До READY медиа обязательно должны быть локальными canonical assets.

Не путать подключение Google Drive к ChatGPT и credentials коннектора Publikator. Не выводить Service Account JSON наружу. Не превращать Google Drive коннектор в generic HTTP proxy. Google Docs export/text parsing — отдельный **P2 optional** adapter, пока не включать в обязательную media pipeline.

### 7.2 Google Sheets

Использовать существующий `preview → validate → apply` со source snapshot SHA и `UPSERT` semantics. Обратная запись статусов не authority. Синхронизация не публикует напрямую в обход редакционной политики. Agent tools могут запускать scoped preview/apply после отдельного `sources:sync` grant (если этот scope введён в A0); не повторять существующий ingestion module.

### 7.3 Яндекс/локальные/прочие источники

Повторно использовать проверенные канонические connectors; local upload допускается только через ограниченный authenticated endpoint, если реально нужен агентам. Запретить SSRF, private/meta IP и redirects, path traversal, ZIP bombs, oversized content, неподдерживаемые форматы и доступ к host filesystem по пути, переданному моделью.

При импорте сохранять исходный provenance/source hash и точную заданную пользователем сортировку. Нельзя менять порядок «по имени файла» после explicit selection.

## 8. Consent, publication intent и безопасность доставки

Создать серверный `PublicationIntent` (или эквивалентный immutable receipt) на основе существующих ревизий, а не конкурентное новое состояние постов.

Намерение фиксирует:
- `postId`, `approvedContentVersion`, `readyRevisionId`;
- хеш canonical текста/медиа/order/target overrides;
- exact `targetAccountIds[]` и effective destination/credential fingerprint;
- `mode` (publish-now / AT / QUEUE), `UTC instant` + `IANA timezone`;
- `agentId`, `policyVersion`, approving `adminId`, `confirmedAt`, `expiresAt`;
- idempotency token / execution receipt.

Любая material change текста, медиа, порядка, recipients, credential semantics или существенного времени MUST инвалидировать старое approval или потребовать новый canonical preflight, как требует vNext. Агент не может сам подтверждать собственную заявку через `approval:request`. Owner approval производится authenticated owner UI с точным предпросмотром; external MCP confirmation UX может быть дополнительным способом **только при доказанной сервером идентичности владельца**.

### Режимы

1. **DRAFT_ONLY**: только подготовка.
2. **OWNER_APPROVAL**: агент готовит, владелец подтверждает конкретную revision/recipients/time.
3. **PREAPPROVED_POLICY**: владелец заранее задаёт allowlist проектов/аккаунтов, форматы, источники, дневной лимит, временное окно и expiry. Каждое выполнение сверяет текущую версию policy.

`publish:request` — право **запросить выполнение**, а не bypass editor/publisher. Все targets выполняют собственный preflight и atomic claim. Не сбрасывать `RECOVERY_NEEDED` повтором запроса. Provider status cannot be guessed from HTTP timeout. **Не публиковать** в соцсети без owner-authorized policy или direct approval.

Массовое действие (несколько аккаунтов) — независимо учтённый outcome каждого target, в том числе PARTIAL. Отключение или изменение credential одного аккаунта не переключает READY на другой destination.

### Платформенные ограничения

MUST использовать пересечение `PlatformCapability` и server-verified `CapabilityProfile` для конкретного credential/destination/method. Для VK различать ключ сообщества (возможен текст) и подтверждённый пользовательский метод загрузки фото; не называть совместимым media target при ошибке IP/permissions. Нативная отложенная публикация VK не входит в P0: применять существующий scheduler, пока другой transport не доказан capability и отдельным acceptance.

## 9. Jobs, события, webhooks

Для длительных импортов, отложенных публикаций и проверки внешних результатов — **durable job receipt** в существующей SQLite. Состояния: `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `REQUIRES_ATTENTION`; jobId, actor, postId, timestamps, per-target result, retryable code. На рестарте неполные provider sends не превращаются в повторяемую `QUEUED` задачу без reconciliation.

Постраничное получение задач + события cursor/sequence через REST/MCP; polling обязателен.

P1 webhooks: `post.created`, `post.approval_requested`, `post.approved`, `post.scheduled`, `target.published`, `target.failed`, `post.partial`, `post.published`, `post.recovery_needed`, `job.completed`. Для webhook есть `eventId`/version/timestamp и HMAC-SHA256 подпись с отдельным секретом; bounded retry, durable delivery journal, replay window, фильтр подписок, HTTPS destination allowlist + SSRF/redirect control. Никогда не отправлять secrets и media raw bytes. Webhook **не** инициирует новую публикацию напрямую.

Встраивание в текущий event/journal слой предпочтительнее создания нового внешнего event broker.

## 10. Пользовательский экран «ИИ и API»

Расположение: `Настройки → ИИ и API` или согласованный с `CANONICAL_OPERATOR_UI_FUNCTIONAL_SPEC.md` существующий раздел «Интеграции»; **не делать вторую главную навигацию**.

- Подключения: имя, тип клиента, scope, связанные project/account/source, ACTIVE/PAUSED/REVOKED, last use.
- Мастер «Подключить»: ChatGPT MCP, Custom GPT Actions, Codex, Claude, Cursor, n8n, Telegram/другой bot, Generic REST; показывает только пригодный URL и безопасные шаги; проверяет соединение.
- Гранты: чекбоксы по **конкретным** аккаунтам и проектам, права работы с медиа, draft-only/approval/automatic, лимиты и expiry.
- Review Inbox: exact text/media order/targets/time/revision; явное «Подтвердить» или «Отклонить».
- Журнал: кто/что/куда/когда + SHA/revision/policy result; без credential/token.
- Выдача машинного ключа показывает его **один раз**; есть pause, revoke, rotate и экстренный «Остановить публикации агентов» (не останавливает уже состоявшиеся внешние посты).

Desktop — плотная читаемая таблица; телефон 390/320 px — компактные карточки без горизонтального скролла; клавиатура, focus, явные ошибки, отсутствие технических понятий в основных действиях.

## 11. Contract, migrations, backup, эксплуатация

- Версионирование: `/api/agent/v1` + OpenAPI `3.1`; MCP-version negotiation и capability discover отдельно. **Не** переименовывать существующий `/api/integration/v1`.
- Схема основного репозитория на дату baseline — `14`. Каждое новое persistent ownership (agent principal/grant, approval policy, receipts/webhook delivery) — осмысленный incremental milestone; **не фиксировать заранее N=15**, если другая PR займёт номер. Сначала прочитать актуальный `SCHEMA_MILESTONES`.
- На каждый milestone выполнить реальную миграцию из N−1, idempotency, dedicated `schema-vN`, канонический `backup-vN`, restart/rollback по `RELEASE_MIGRATION_POLICY.md`. Не делать silent downgrade или `docker compose down -v`.
- Canonical backup включает SQLite + media + manifest; новым таблицам нельзя исчезнуть из restore. `APP_MASTER_KEY` остаётся отдельно и не публикуется.
- В существующем Docker image зафиксировать build SHA/schema; staging release health + API/MCP readiness, затем авторизованная live-проверка.
- Доступность D2-R2 = только `127.0.0.1:8080`, пока владелец отдельно не одобрит ingress/tunnel; в документационном пакете серверные настройки не менять.
- OAuth/provider credentials/Google SDK и любые secrets не записывать в GitHub/CI/log/PR. Проверить threat model до открытия внешнего MCP endpoint.

## 12. Стандартизованные проверки

| Case | Acceptance |
|---|---|
| T-01 | Observer видит только allowlisted projects/accounts/media, запрещённые ID не раскрывают данные |
| T-02 | Агент с `posts:write` без `publish:request` сохраняет DRAFT, не создаёт внешних POST |
| T-03 | При наличии 11 аккаунтов (в том числе 9 VK) точный список из 3 ID сохраняется; прочие не затронуты |
| T-04 | 2+ изображения из разрешённого Drive сохраняются локально, SHA и заданный порядок совпадают после restart |
| T-05 | Google Sheets preview SHA защищает от изменения исходной таблицы между preview/apply |
| T-06 | 2 одинаковых concurrent create/publish intent с одним idempotency key имеют один draft/job/claim |
| T-07 | Один idempotency key + разные payload → 409, без side effects |
| T-08 | Нет owner approval → 0 реальных provider POST; смена recipients/revision/time инвалидирует stale approval |
| T-09 | Preapproved scope ограничивает дневной лимит, аккаунт, формат, timezone и expiration; превышение отклоняется |
| T-10 | Текстовый VK group key не выдаётся за право загрузки фото; IP/permission denial виден по target |
| T-11 | При ambiguous provider result → `RECOVERY_NEEDED`, повторный вызов не дублирует post |
| T-12 | Разная ошибка двух targets → PARTIAL + точные per-target статусы и ссылки |
| T-13 | Agent A не может читать чужой token/grant и посты **за пределами своих allowlist**; посты в общем разрешённом проекте доступны обоим согласно `posts:read`; пауза/отзыв действует немедленно |
| T-14 | API-key, OAuth bearer, invalid audience, expired/rotated refresh, Origin/Host, CSRF проверены; secrets отсутствуют в output/log |
| T-15 | `/mcp`: protocol negotiation, discovery, tools/list/call, tool schema, JSON errors, unsupported version fail-closed |
| T-16 | Реальные клиенты: ChatGPT сканирует tools и вызывает разрешённый read/draft; Codex/Claude либо другой независимый MCP-клиент проходит тот же сценарий |
| T-17 | REST/OpenAPI-клиент выполняет те же operations, что MCP, с одинаковыми idempotency/permitted outcomes |
| T-18 | Webhook HMAC, allowlisted URL, event IDs, bounded retry, SSRF/replay protections |
| T-19 | Canonical backup→schema migrate→backup/restore сохраняет grants, credentials, revisions, media, schedules и receipts |
| T-20 | Один production Docker/process/SQLite/publisher/scheduler после интеграции; release gates не ослаблены |

GitHub CI должен использовать fake-provider network/no public sends. Live tests выполняются только на owner-approved test accounts, с отдельным подтверждением и скриншотами/записями статусов. Если нет доступного ChatGPT write permission — отметить ограничение клиента отдельно, **не** заявлять провал backend.

Для performance: 100 drafts, 150 media, 10+ targets, параллельные два агента, большие списки с pagination. Каждая операция bounded; измерения фиксируются в CI и stage proof. Без выдуманных SLA на неподтверждённом железе.

## 13. Этапы реализации, зависимости и Definition of Done

**Правило:** один небольшой finished checkpoint = ветка/PR + focused regression + полный `Publikator CI / Acceptance` на точном SHA + независимое review + merge; следующий пакет не начинает свой продуктовый срез до принятия необходимых API/contracts. Цель — end-to-end, не количество созданных endpoints.

| Этап | Приоритет | Продуктовый результат | Зависит от |
|---|---|---|---|
| A0 — AGENT-CONTRACT | P0 | статический OpenAPI/MCP DTO + Threat model + ADR и accepted API error/version contract; без live изменение | базовый аудит |
| A1 — AGENT-IDENTITY | P0 | agent principal/scoped grants/API-key isolation/OAuth discovery/token lifecycle | A0 |
| A2 — AGENT-REST | P0 | read lists + create/edit DRAFT + OpenAPI без admin cookie | A1 |
| A3 — AGENT-MCP | P0 | remote MCP, tools/resources, OAuth, read/write draft smoke с независимым клиентом | A2 |
| A4 — AGENT-COMPOSER | P0 | Google Drive/media + один логический текст/фото/несколько target flow + previews, повторное использование принятого #171 | A2, #171 MERGED |
| A5 — AGENT-PUBLISH | P0 | owner approval/policy + scheduled/publish intent + statuses + recovery | A1,A4 и credential lane |
| A6 — AGENT-EVENTS | P1 | durable jobs/polling/webhooks с HMAC/retry | A5 |
| A7 — AGENT-UI | P0 consent / P1 остальное | Минимальная настройка grants и owner consent обязательна для P0; полный onboarding/журнал/UX — P1 | A1,A3,A5 |
| A8 — AGENT-ACCEPTANCE | P0 release gate | реальная ChatGPT/другие MCP/REST приёмка, live scoped send, backup/restore, release acceptance | A0–A5 + A7 P0 consent (A6 webhooks и A7 полный onboarding могут выйти позже как P1) |

**Обязательный P0 пользовательский DoD:** бот получает разрешённые материалы из Drive, делает текст и фото, выбирает конкретные аккаунты, показывает предпросмотр, получает owner consent, запланировано публикует в тестовые target и возвращает доказуемые ссылки/ошибки **без дублирующего внешнего POST**.

**A0 review MUST resolve прежде кодирования**: используются ли одни и те же Application Services для PR #171 и Agent API; формат owner consent/revision fingerprint; точные токенные scopes/expiry; транспортные версии MCP; авторизованный remote endpoint; latest schema milestone. Всё согласовывать **в рамках данного ТЗ**, не создавать второй master roadmap.

## 14. Ссылки на протоколы / реализация должна перепроверять актуальную документацию

- MCP release spec 2026-07-28: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- TypeScript SDK migration/compatibility: https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28
- OpenAI custom MCP: https://developers.openai.com/api/docs/guides/custom-mcp-server
- OpenAI remote MCP / Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- Google Drive OAuth scope и разрешения — текущий официальный Google Drive API, не выдуманные permissions.
- VK methods — provider-specific method evidence в существующем `SOCIAL_CREDENTIAL_CAPABILITY_CONTRACT.md`.

**До внедрения следует подтвердить версии SDK/клиентов и авторизационную матрицу на реальных экземплярах; ссылки — baseline стандарта, не утверждение о наличии всех возможностей в любой подписке.**

## 15. Граница этого документационного задания

Публикация настоящего ТЗ в GitHub **не** означает: создан работающий MCP, опубликован новый HTTPS endpoint, изменена БД/секреты, выполнено реальное OAuth подключение или размещены посты. Любое утверждение DONE требует отдельного доказательства. Владелец поручил создать точное исполнимое ТЗ, issue backlog и контроль зависимостей.

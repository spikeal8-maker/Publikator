# ADR-AGENT-AUTH-001 — Route authority, OAuth и remote MCP

**Статус:** A0c DESIGN CANDIDATE; `NOT_IMPLEMENTED`. Внешний issuer/HTTPS/ChatGPT proof: `BLOCKED_BY_LIVE_PROOF`.  
**Родитель:** [#174](https://github.com/spikeal8-maker/Publikator/issues/174), [нормативное ТЗ](UNIVERSAL_AGENT_API_MCP_SPEC.md) `16; [уровни ботов](AGENT_ACCESS_LEVELS_AND_ACTIVITY_LOGS.md).  
**Совместимость:** один Fastify, SQLite/WAL, Docker container, scheduler и publisher. Никаких новых производственных DB, queue и HTTP-сервера.

## 1. Решение по независимым trust boundaries

| Route class | Путь | Authentication | Authorization |
|---|---|---|---|
| BROWSER | прежний `/api/*` кроме специальных префиксов | существующий `publikator_session` | existing owner + browser Origin/CSRF |
| LEGACY_INTEGRATION | `/api/integration/v1/*` | legacy hashed `pk_` | прежние scopes; **не** полноценная изоляция по ключам |
| AGENT | `/api/agent/v1/*` | проверенный OAuth resource bearer либо независимый scoped machine token | `AgentGrant` + grantVersion + project/account/source/post allowlist |
| MCP | `POST /mcp` | OAuth resource-bound bearer | тот же AgentGrant + per-tool scopes + повторная проверка на каждый tools/call |
| OWNER_AGENT | `/api/owner/*` | только owner cookie | admin-only, CSRF/Origin, expectedGrantVersion, audit |
| OAUTH_META | явно allowlisted `/.well-known/*` GET | public metadata only | без пользовательских данных или write |
| OAUTH_FLOW | `/oauth/*` | OAuth authorization server и owner consent | exact PKCE, resource, issuer, client, redirect URI |

**Исходные блокеры в коде:** `src/http/routes.ts` регистрирует `preHandler`, требующий owner-cookie почти на все `/api/*`; `src/http/security.ts` проверяет browser Origin у mutating API. **Нельзя** решить это «исключением нового префикса», которое случайно откроет анонимный API. A1b должен создать одну явную систему route classification, обязательный authN перед authZ и отрицательные интеграционные тесты на method/path/encoded segments/Origin. Fastify plugin encapsulation требует проверки порядка наследования hooks — не рассчитывать на него по умолчанию.

**Owner и агентские полномочия строго несовместимы:** bearer никогда не управляет grants, чужими токенами/креденшелами и секретами; browser cookie не является credential для `/mcp`. Cookie+Bearer в одном запросе → reject ambiguous authority, не объединять права. Старый `/api/integration/v1` сохраняет доверенную shared-namespace семантику, но не является безопасным способом подключения множества изолированных внешних ботов.

**Agent GET purity:** GET/preview не вызывает `ensureTargets()` или какую-либо запись; отсутствие `targetAccountIds`/`[]` не добавляет recipients по умолчанию.

## 2. OAuth: конкретный выбранный кандидат и необходимые проверки

**Выбран основной путь:** встраиваемый в текущий Node-процесс `oidc-provider` v9.x как проверенная OAuth/OIDC библиотека (не самописный issuer). Версию/sha/lockfile закрепить только после отдельного A1c compatibility spike. Она поддерживает RFC 8414, PKCE/S256, RFC 8707 Resource Indicators, RFC 9207 issuer-in-response, revocation, refresh; CIMD экспериментальный, поэтому должен пройти реальное связывание ChatGPT до объявления production-ready. Никакого собственного OAuth token crypto.

**Один canonical HTTPS public origin:** документационный `https://publisher.example.invalid` — **не существующий** адрес. Он содержит `/mcp`, защищённые resource metadata, authorization-server discovery, `/oauth/authorize`, `/oauth/token`, JWKS/revocation и callbacks, только после одобренного ingress. Текущий `127.0.0.1:8080` не открывать напрямую. 1Panel обслуживает TLS/proxy/backup только как инфраструктуру, **не** экспортируется через MCP. Разрешён upstream reverse proxy / исходящий туннель к loopback, но весь OAuth flow должен быть доступен одному облачному клиенту — «туннель только для /mcp» недостаточен.

**Metadata / client requirements:**
- Protected Resource Metadata RFC 9728: exact canonical HTTPS resource + authorization_servers; 401 `WWW-Authenticate: Bearer resource_metadata=...`.
- AS metadata RFC 8414/OIDC: issuer, authorize/token, revocation, `code_challenge_methods_supported: ["S256"]`, advertised token methods; `authorization_response_iss_parameter_supported` только если `iss` реально возвращается и в ошибках.
- `resource` parameter in authorize **and** token, target `aud` verification at resource server; wrong/missing audience, expired/grant-revoked token fail closed.
- ChatGPT client binding: CIMD только при проверенной SSRF/TLS/redirect в выбранном `oidc-provider`, иначе vetted static client либо ограниченный DCR compatibility path. Redirect URI — точная строка из клиента (никаких wildcards). OAuth `state`/S256 PKCE/issuer `iss`/consent.
- Каждый MCP tool объявляет `securitySchemes: [{type:"oauth2",scopes:[...]}]`; недостаточные полномочия возвращают `_meta["mcp/www_authenticate"]` и protected resource metadata. `tools/list` cache keyed by identity, grantVersion, protocol. Ни cached list, ни заголовки модели не являются разрешением на вызов.
- Для n8n/Telegram machine agents использовать отдельные bearer keys из Agent API. ChatGPT OAuth нельзя заменять `client_credentials`, APP_MASTER_KEY или сервисным аккаунтом.
- Tokens/JWK, owner consent и refresh state — durable persistent storage и canonical backup/restore; OAuth signing keys не генерируются заново каждый startup, приватные JWK не доступны UI/API/CI. Rotation: unique kid, grace period for already minted tokens, deny stale grants after revoke.

**Статус:** выбор библиотеки — доказуемая проектная гипотеза, **не** установленная зависимость. A1c обязан протестировать точную версию `oidc-provider`, auth metadata, реальный PKCE/CIMD либо static client, ключи и restore; если fails, зафиксировать отдельный ADR для established hosted IdP вместо незащищённого fallback.

## 3. MCP version / transport

`@modelcontextprotocol/server` v2, modern `2026-07-28` с **явным opt-in**; stateless POST с `MCP-Protocol-Version`, `Mcp-Method`/`Mcp-Name`, version in `params._meta`, optional `server/discover`. Новый транспорт не обязан поддерживать прежние GET stream / `Mcp-Session-Id` / `initialize`. Legacy 2025 adapter разрешается только для реально проверенного клиента при том же ACL, без анонимного fallback. Несоответствие request headers/body или неподдерживаемый protocol → 400, а не поведение «как-нибудь заработает». Инструменты вызывать единые Application Services из REST.

## 4. Набор threat→proof

| Threat | Required rejection/proof |
|---|---|
| Agent-prefix accidentally public | missing token yields 401 for all agent GET/mutations and MCP tool calls |
| Token from another issuer/resource | wrong `iss/aud` yields 401 without data change |
| owner-cookie used as MCP bearer | cookie-only `/mcp` denied |
| agent bearer used on `/api/owner` | 401/403 without policy change |
| ambiguous cookie + bearer | request denied; no authority merging |
| expired/revoked token/grant | 401/403 on subsequent tool call, including cached tools |
| malicious Drive text tells bot to change recipients | scopes/allowlists unchanged; 0 unauthorized send |
| malicious CIMD redirects/metadata | reject non-HTTPS, private networks, invalid host and redirect mismatch |
| browser Origin bypass | wrong Origin denied for owner write, valid agent bearer not mistaken for browser session |
| stale authorization after restart | revoked remains revoked and refresh token rotation persists |
| leaked logging | 0 bearer/refresh/APP_MASTER_KEY/provider tokens in logs, SQLite or exported backup |
| encoded path & query tricks | route class exact, unknown paths fail closed |

## 5. Deployment and acceptance separation

**A0c CI proves only documents/manifests**, not actual ingress. Runtime gate: install on isolated staging with exact SHA/image digest/schema and safe backup, publish only approved HTTPS proxy paths, verify outside-client metadata/authorize/token/redirect/JWKS and independent MCP tools/list and scoped draft. ChatGPT entitlement/write separately verified; blocked write does not imply a broken REST backend. Network/API infrastructure changes require explicit owner deployment decision. No change to local DNS, VPN, firewall, routes, proxy or Docker networking in this ADR.

**Required static files:** `docs/contracts/agent-route-boundaries.v1.json`; `docs/contracts/client-compatibility-matrix.md`; `docs/contracts/agent-fault-matrix.v1.json` plus human test plan; `scripts/agent-contract-a0c-e2e.mjs` in canonical CI.

**Official references, re-check before implementation:**
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28
- https://developers.openai.com/plugins/build/auth
- https://github.com/panva/node-oidc-provider

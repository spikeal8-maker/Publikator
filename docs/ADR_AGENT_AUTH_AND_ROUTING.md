# ADR AGENT-A0c — authorization, network ingress, route isolation and MCP transport

**Status:** DECISION CONTRACT / IMPLEMENTATION GATED — **not deployed**  
**Date:** 2026-10-25  
**Parent:** [#172](https://github.com/spikeal8-maker/Publikator/issues/172) / [#174](https://github.com/spikeal8-maker/Publikator/issues/174)  
**Normative precedence:** `VNEXT_TECHNICAL_SPEC.md` → `SOCIAL_CREDENTIAL_CAPABILITY_CONTRACT.md` → `UNIVERSAL_AGENT_API_MCP_SPEC.md` → this ADR.  
**Machine-readable route matrix:** [agent-route-policy.v1.json](contracts/agent-route-policy.v1.json).

## 1. Source-backed current behavior

At baseline `main@19141f5db280fa2522731228a5a81e492c64a264`:

- `src/http/routes.ts` registers a root Fastify `preHandler` requiring `publikator_session` for `/api/*` except exact browser/auth allowlist and `/api/integration/v1/*`. It does **not** authorize new bearer-agent routes.
- `src/http/security.ts` registers global origin check for mutating `/api/*` and exempts legacy Integration API, and attaches a broad browser-oriented CSP. It does **not** verify OAuth bearer tokens.
- `src/app.ts` loads common Fastify plugins/hooks, browser routes and legacy API into one process. It publishes `config.mediaDir` via `fastifyStatic('/public-media/')` for existing provider delivery.
- `docs/DEPLOY_DOCKER.md` binds the application to `127.0.0.1:8080` by default. ChatGPT remote OAuth cannot reach that URL directly. `PUBLIC_BASE_URL` may be HTTPS, but **no actual owner-approved public HTTPS hostname is verified by this checkpoint**.
- `src/integration-security.ts` hashed legacy `pk_` keys remain a trusted shared namespace. Their scopes must **never** turn into new `AgentGrant` privileges through request payload or host configuration.
- `docs/contracts/agent-api-v1.openapi.yaml` and `mcp-tools.v1.json` are static **PLANNED** contracts accepted in A0b, not routes implemented in current Fastify.

The new API MUST preserve all existing manual drafts, scheduler, provider capabilities, owner sessions, saved credentials and backup/restore behavior.

## 2. Decision D-01: three independently authenticated application surfaces

**Chosen architecture:** retain one existing Fastify modular monolith, one SQLite/WAL database, one scheduler and one canonical publisher. Create three **independently guarded** route groups:

| Exact URL class | Identity authority | Authorization & side effects |
|---|---|---|
| `/api/*` legacy/browser routes | Existing owner cookie/session, browser origin policy | Existing role; keep working. Exempt only documented login/bootstrap/health/callback endpoints. |
| `/api/integration/v1/*` | Existing hashed legacy integration key | Retain backward compatibility; no new AgentGrant, cross-key isolation cannot be assumed. |
| `/api/owner/*` | **Owner cookie only**, plus CSRF/same-origin | Create/pause/revoke agents, preview grants, owner approval/reject, view all bot logs. Agent bearer never works. |
| `/api/agent/v1/*` | Agent OAuth bearer or separately scoped machine API key | Validate issuer/audience/expiry/client/grant/status + exact project/account/source/post ACL on **every** operation. Never inherit admin cookie. |
| `POST /mcp` | OAuth bearer on intended resource | Same application services and grant checks as Agent REST. `tools/list` may cache only per agent/grantVersion/protocolVersion; `tools/call` revalidates. |
| `/.well-known/*` | No credential for the narrowly permitted discovery documents | No API data, no token grant, no owner rights. Exact path + GET-only; never a wildcard exemption. |
| `/oauth/authorize` / `/oauth/token` / `/oauth/revoke` | Separate verified authorization-server flow | Browser owner login + explicit consent for initial grant, PKCE, bound redirect/callback, refresh/revoke and issuer validation. Never anonymous minting. |
| `/public-media/*` | Existing provider-facing legacy delivery | Preserved while designing private/canonical media isolation; not a general Agent API for private preview. |

**Implementation seam:** place an explicit dispatcher/classification **before** the old root cookie `preHandler` (or cleanly encapsulate route registrations so the old hook cannot deny valid agent requests). Never solve the 401 by simply adding `/api/agent/v1/*` to a global anonymous whitelist. Protected agent route MUST verify new bearer and resource grant before it can execute; an unrecognized path FAILS CLOSED. Fastify hook registration order and URL query stripping require direct automated tests. Browser Origin failures must not accidentally reject conformant remote OAuth clients, but absent Origin is not proof of authorization. All owner mutations remain browser CSRF-protected.

The machine-readable mapping in `agent-route-policy.v1.json` drives A1/A2 negative route tests and MUST be updated in the same PR as any new public route.

## 3. Decision D-02: OAuth security and deployment topology

**Target:** remote `https://OWNER_APPROVED_HOST/mcp`, resource metadata (RFC 9728) under `/.well-known/oauth-protected-resource`, an OAuth AS with RFC 8414 or OIDC discovery, and browser-visible authorization and token endpoints. The public base URL and issuer SHALL use approved trustworthy HTTPS and be stable across requests. `OWNER_APPROVED_HOST` is deliberately a **nonfunctional placeholder**; it is **not** a live URL.

The AS may share the origin/process with the MCP resource server (preferred for current single-container target) while using separate middleware/security contexts. **Candidate implementation:** established `oidc-provider` stable 9.x supporting authorization code, PKCE, issuer discovery, revocation, RFC 8707 resource indicators, RFC 9207 mix-up protection, OAuth token audience. Candidate does **not** mean installed, configured or security-accepted: A1 security checkpoint MUST pin exact release, verify integration with Fastify 5/Node 22, register a durable SQLite-backed token/grant adapter, replace all developer-mode account interactions with existing owner identity and run dedicated OAuth regression.

Reference: https://github.com/panva/node-oidc-provider (implements the required standards). MCP server SDK: https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/ (official TypeScript v2, MCP `2026-07-28`).

**Transport:** HTTP Streamable MCP 2026-era `server/discover` and per-request metadata, no legacy `Mcp-Session-Id` assumptions. Implement compatibility with older initialize clients only as a separately authenticated, explicitly tested adapter. Do not create a second business publisher.

**Required OAuth checks:**
- initial request without token → HTTP 401 `WWW-Authenticate` with `resource_metadata` discovery URL and minimal `scope`; non-public tool → OAuth `securitySchemes` plus proper `mcp/www_authenticate` as applicable;
- authorization code + PKCE with strict redirect URIs, state, issuer and protected-resource audience; no implicit grant;
- token expiry, rotation, revocation, pending/expired owner grants, grantVersion invalidation and exact agent/project/account/source boundaries on each operation;
- CIMD/static client registration preferred; restricted DCR only for an independently verified backward-compatibility client; no arbitrary privileged registration;
- agent access token MUST NOT be forwarded to Google/VK/MAX/Telegram. Provider credentials remain encrypted in Publikator and used only by provider adapters;
- no URL query bearer, no plaintext token in SQLite activity, HTTP logs, MCP tool results, crash reports or backup output.

**Ingress:** preserve `127.0.0.1:8080` as private service. Use an owner-approved 1Panel-managed HTTPS reverse proxy on authorized Ubuntu **or** a supported private outbound tunnel that routes all OAuth discovery, interactive login, token exchange and `/mcp` endpoints. A tunnel exposing only `/mcp` is insufficient. Never modify host DNS, firewall, routes or existing Docker network as an implicit integration step; explicit owner acceptance is required. Do not publish 1Panel administrative API to MCP.

**Live-network STOP:** `PUBLIC_HOST_NOT_APPROVED` until owner-approved actual host/tunnel and external browser/client probe; `ISSUER_NOT_DEPLOYED` until real OAuth AS lives there; `CHATGPT_CLIENT_NOT_TESTED` until the actual connected ChatGPT client performs discovery and an allowlisted tool. Local `curl localhost`, mock SDK or CI do not clear these conditions.

## 4. Decision D-03: grants, owner consent and publication admission

- Exactly five human-facing presets (OBSERVER/LIMITED/EXTENDED/FULL_CONTENT/CUSTOM) are snapshots of per-agent scopes and allowlisted projectId/accountId/sourceConnectorId, as accepted in `agent-access-presets.v1.json`.
- Three *independent* publication modes remain `DRAFT_ONLY` / `OWNER_APPROVAL` / `PREAPPROVED_POLICY`. `FULL_CONTENT` grants **content operations only**, never admin secrets, 1Panel or automatic external posting without separate owner-confirmed policy.
- `READY`/`APPROVED` from existing `markReadyRevision()` **never** substitutes for an exact owner-approved `PublicationIntent` on agent-managed content. Before scheduler/publisher atomic claim, validate immutable revision+media ordering+account IDs+schedule+grantVersion+credential capability, plus daily quota.
- Grant revoke is linearized with **future execution claims**: after revoke commit new claims are denied; already admitted/in-flight provider requests may still finish. Audit must distinguish those outcomes; never claim retroactive cancellation.
- Provider-side outcome ambiguity must remain `RECOVERY_NEEDED` with no automatic duplicate dispatch. Exactly-once cross-provider guarantee cannot be claimed.
- No second queue, worker or table duplicating the canonical post or publisher.

## 5. Decision D-04: private media and safe provider-visible delivery

**Known present issue:** `src/app.ts` serves the entire `config.mediaDir` on public `/public-media/*` without per-agent ACL. Random media IDs are not an authorization boundary. Do NOT use these URLs for scoped private source discovery, private draft thumbnails or MCP resources.

**Migration design:** canonical private originals remain attached to owner/AgentGrant and accessed through a future authenticated media endpoint; provider-visible derivatives are separate, publication-scoped, time/allowlist bounded where platform supports it, and never copy provider keys into public URLs. Preserve legacy externally referenced media URLs until real VK/Instagram/MAX compatibility and live fetch behavior are independently confirmed; changes require staged regression/rollback plan. Do not close `/public-media` globally in A1 and break current published media. A later separate media ADR/slice shall finalize exact derivative bucket and TTL per target platform; this ADR records the required safety boundary.

## 6. Test entry, deployment evidence and safeguards

Required checkpoint tests (not yet implemented):
1. HTTP negative matrix for public-health, owner-cookie, agent-bearer, OAuth metadata/token, MCP and legacy API; invalid/anonymous/wrong-audience/Origin/path/method must return correct denial with **0** data side effects.
2. MCP modern vs legacy client handshake tests; `tools/list` effective cache and `tools/call` live reauthorization after grant change.
3. OAuth redirect/PKCE/cross-client/token-issuer mix-up, refresh/revoke replay, exact `aud`, expired/future claims.
4. Owner consent and grant/policy changes linearized with scheduler. No provider POST for unapproved agent-managed READY content.
5. Private original media cannot be downloaded through user-facing public URLs; existing provider-visible media delivery survives.
6. Schema migration N−1→N, canonical backup/restore with owner credentials encrypted and no secret leakage.
7. Live record: GitHub commit SHA, Docker image digest, DB schema, backup receipt, external HTTPS origin/issuer, tested client version, exact scopes, evidence of real tool call. Separate `main` CI from deployed runtime acceptance.

**A0c static test:** `scripts/agent-contract-a0c-auth-e2e.mjs` checks decision matrix and source invariants **only**. It MUST report `deployment=NOT_VERIFIED`; it cannot certify a working AS, MCP server or remote ChatGPT integration.

## 7. Implementation gates and recommended next PR order

A0c: accepted route policy / ADR / static negative matrix **without code routing or secrets** → A0d: media and fault-injection security decisions/client matrix if not in this slice → A1a: AgentPrincipal/Grant schema & backup → A1b: guarded machine keys + explicit route boundary → A1c: trusted OAuth AS, actual external connectivity → A2 REST read/drafts + durable audit → A3 MCP → A4 Drive/media → A5a exact intent → A7a owner permission/log UI → A5b safe publish → A8 independent live client/provider acceptance.

**Open explicit owner-controlled decisions:** exact public HTTPS hostname/tunnel; which installation will host it; permission to provision TLS/ingress; real provider test accounts. None are silently decided by this ADR. No software development task should claim these are already fulfilled merely because the technical design is approved.

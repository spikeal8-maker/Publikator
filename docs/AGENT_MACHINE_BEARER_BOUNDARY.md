# AGENT-A1b2b2 — machine Bearer HTTP boundary

**State:** implemented in PR #224, subject to exact-SHA CI and independent review. This is not a deployed OAuth issuer, a ChatGPT connector, or an MCP server. Parent milestones: A1a / A1b1 / A1b2a / A1b2b1.

## Trust separation

| Namespace | Required authority | Machine `pak1_` result |
| --- | --- | --- |
| Browser `/api/*` | Existing owner cookie/session, with existing Origin protection | No owner authority |
| `/api/owner/agents/*` | Current DB-backed owner session (`pa2_`), exact Origin on mutations | Reject Bearer/mixed cookie |
| Legacy `/api/integration/v1/*` | Existing `pk_` Integration API key, legacy trusted-owner namespace | Reject `pak1_` |
| `/api/agent/v1/*` | Mandatory global `onRequest` verified machine Bearer for **all** routes, including unknown routes | Authorize only valid active machine principal |
| `/mcp` | No server is implemented | 404 (not the HTML SPA) |

The new Agent Bearer guard is registered **before** the legacy `registerRoutes` owner-cookie preHandler. The preHandler excludes the exact Agent namespace only because the earlier global guard is mandatory; removing that guard while retaining the exemption would be a security regression. Prefix lookalikes such as `/api/agent/v1malicious` remain browser-cookie protected. Do not expose Agent routes via a generic public-route allowlist.

Machine HTTP requests must use exactly one `Authorization: Bearer pak1_...` header, without cookies, legacy API-key headers or URL-carried tokens. A browser `Origin` is optional only for a headless machine client; if supplied, it must match the configured application origin. The opaque token is checked against the SQLite digest and current principal status, token version, grant version and expiry. Reject invalid, expired, paused and revoked credentials immediately.

## Implemented operation

**`GET /api/agent/v1/capabilities`** was the first implemented Agent namespace operation in A1b2b2; A2a1 adds SQL-filtered `GET /api/agent/v1/projects` separately. It returns a **sanitized effective view** derived from a freshly authenticated principal and the current grant in one SQLite transaction:

- `agentId`, preset, current grant version and the **effective** token/grant scope intersection.
- Exact existing project/account/source connector IDs only when the machine token independently has the corresponding read scope.
- `publishMode: DRAFT_ONLY`, with explicit blocked reasons for resource API operations, publish/schedule and OAuth/MCP.
- No raw machine token, social credentials, provider-secret status, media originals, post contents or arbitrary SQL output.

This endpoint does not create a publication, schedule, approval or job. Granting a scope does **not** itself make an unimplemented REST operation available. Unknown Agent routes, including writes, remain 404 for valid tokens and 401 for unauthenticated clients. `/mcp` must not appear successful via an HTML fallback.

## Future endpoints — required proof before acceptance

A2a resource reads and A2b edits must recheck **authenticated token scope ∩ saved current grant scope ∩ exact live resource IDs ∩ allowed content lifecycle**, in the same operation-time SQLite claim where effects are recorded. Never trust an `agentId`, `grantVersion`, `scope`, `projectId` or account ID from model text as identity/consent evidence. List endpoints require SQL-level filtering by current allowlists and must not expose a broad list and rely on frontend filtering. Deny mixed-target posts where any target account is not permitted until a proven redacted DTO is introduced.

A3a MCP and A3b OAuth require separate issuer/resource metadata, audience, PKCE, HTTPS ingress and real-client acceptance. This machine token is not a ChatGPT OAuth substitute. A5b execution-time quotas, immutable owner consent, publication fingerprinting and recovery must pass before any external provider POST from an agent.

## Negative acceptance

Canonical focused regression: `scripts/agent-a1b2b2-bearer-boundary-e2e.mjs`. It covers missing/wrong/mixed auth, origin rejection, unknown paths, reserved MCP, cross-agent metadata isolation, scope/resource filtering, token expiry and pause, restart stability, and zero side effects. Keep it in the **single** `Publikator CI / Acceptance`; no second workflow or bypass.

**Release gate:** full exact-head CI, independent Code Review and Security Review, plus integration acceptance of all ancestor PRs. Working Docker/D2-R2 installation is unchanged until a separately approved deployment.

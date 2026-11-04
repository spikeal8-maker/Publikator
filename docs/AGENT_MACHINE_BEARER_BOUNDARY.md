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

**`GET /api/agent/v1/capabilities`** was the first implemented Agent namespace operation in A1b2b2; A2a1 adds SQL-filtered `GET /api/agent/v1/projects`, and A2a2 adds exact-allowlist `GET /api/agent/v1/accounts` with safe version-bound capability verdicts, and A2a3 adds read-only `GET /api/agent/v1/sources` without connector config, file paths or secrets. It returns a **sanitized effective view** derived from a freshly authenticated principal and the current grant in one SQLite transaction:

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


## AGENT-A2b3: own text-draft retrieval

The only activated post read operations are GET /api/agent/v1/posts and
GET /api/agent/v1/posts/{postId}. These are **not** broad feed, publication,
media, review or owner activity endpoints.

Required conditions, all evaluated in a single SQLite read transaction:

- Current hashed machine Bearer and current saved grant must independently
  authorize posts:read; posts:write does **not** imply read permission.
- Immutable agent_draft_ownership.agent_id must equal the server-authenticated
  agent. A model-supplied agent ID, URL cursor or project ID is not an identity.
- Project must appear in the live explicit grant allowlist. Every saved target
  account must be allowed and enabled, including target-row enabled state;
  mixed-recipient posts are withheld in their entirety.
- Only DRAFT / DRAFT-stage / MANUAL / agent-api / FEED / TEXT_ONLY content is
  returned. Posts with any media, content-media, target overrides, target
  renditions, ready revision, scheduled timestamp or unsupported resources are
  omitted/404. Manual and unowned drafts are never exposed.
- The SQL query filters ownership, scopes and target allowlists before
  selecting text; per-post assertEffectiveAgentGrant then checks the saved
  policy a second time. The exact filter is reused by the list and detail
  endpoints, so a direct ID cannot bypass list restrictions.
- A list uses the established strict limit 1..100 and canonical base64url
  cursor encoding of ascending post IDs. The cursor is a position only, never
  an authorization capability. GET detail rejects all unknown query params.
- Only the safe Post DTO is serialized: post ID, project ID, current title,
  bodyPlain, canonical contentVersion, explicit targetAccountIds, immutable
  DRAFT state and no media/schedule/target overrides. Responses are marked
  Cache-Control: no-store. No social provider credentials, OAuth metadata,
  raw machine Bearer or publisher execution state.

The endpoints cannot modify a post, send it to a provider, change READY status,
schedule it, or read unrelated owner/editor drafts. All permission changes or
token revocation immediately affect the next GET. Only original owner-operated
publishing remains available through its existing separate control path.

Acceptance: scripts/agent-a2b3-own-drafts-read-e2e.mjs in **both** jobs of the
single canonical GitHub Acceptance workflow. Main merge remains blocked until
the exact-head CI, independent Code/Security reviews and all stacked ancestor
PRs have been accepted and reconciled.

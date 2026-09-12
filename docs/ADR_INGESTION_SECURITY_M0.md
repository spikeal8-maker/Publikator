# ADR: M0-004 Ingestion Security Foundation

Status: ACCEPTED for CONTENT-M0 / M0-004.

Authoritative parent: `docs/VNEXT_TECHNICAL_SPEC.md`.

## Scope

This checkpoint defines reusable security primitives and persistence only.
It does not implement ZIP bundle ingestion, Google Drive/Yandex download flows,
Google Sheets sync, rich-text editing UI, or public Integration API endpoints.

Future ingestion features MUST reuse these guards instead of creating parallel logic.

## Schema milestone

vNext schema moves from `5` to `6`.

Schema 6 adds:

- `integration_api_keys`;
- `ingestion_connectors`.

Existing content, revisions, publication state, provenance and media remain unchanged.
## Archive / bundle safety

Before any future ZIP extraction, archive metadata MUST pass `validateBundleEntries`.
The guard rejects:

- absolute, UNC, drive-letter and `..` traversal paths;
- duplicate/case-colliding paths and unsafe Windows device names;
- symlink, device, FIFO and other non-file/non-directory entries;
- excessive file count;
- excessive compressed bytes;
- excessive expanded bytes;
- oversized individual entries;
- unsafe compression ratios.

A future ZIP reader MUST derive these values from archive metadata before extraction.
Extraction MUST use non-public temporary storage and cleanup on failure.

## Remote media / SSRF

Remote media is HTTPS-only. Userinfo in URLs is forbidden.
Every hop resolves DNS before request and rejects blocked/private/special addresses.
Redirect destinations repeat the same protocol/DNS/IP validation.
Production HTTPS connects to the validated IP directly while preserving the original Host header and TLS SNI.
This prevents a second hostname resolution from bypassing the validation step.

Each redirect is bounded. Response size is enforced while streaming, not only from Content-Length.
Requests have timeouts and accepted media must pass byte-level MIME sniffing.

## Integration API keys

Keys use at least 256 bits of cryptographic randomness.
Only SHA-256 hash, display prefix, scopes and lifecycle metadata are stored.
The complete token is returned only at creation/rotation time.

Keys support:

- explicit scopes;
- revoke;
- rotate with lineage;
- last-used metadata;
- per-key rate limiting;
- audit events without full tokens.

The in-memory rate limiter is valid for the current single-instance modular monolith.
A future architecture change to multiple app instances requires a separate ADR for distributed rate limiting.
## Connector secrets

Connector public config MUST be secret-free.
Secret-like fields such as tokens, passwords, credentials and API/private keys are rejected from `config_json`.
Credentials are stored only through existing AES-256-GCM encryption under `APP_MASTER_KEY`.
Config and credential payloads have bounded serialized size.

Secrets MUST NOT appear in frontend payloads, audit events, exports or backup manifests.
Canonical backup contains encrypted connector credentials and API-key hashes, never plaintext tokens.

## Rich content

Canonical rich-text AST is validated by a strict node/mark/property allowlist.
Raw HTML and event-like properties are forbidden.
Marks may only appear on text nodes and currently contain only their allowed `type`.
Text nodes cannot contain child nodes.
Links allow only HTTP/HTTPS, forbid credentials and have bounded metadata lengths.

Renderers and platform compilers must still escape destination syntax at output time.
## Spreadsheet injection

Every generated CSV/XLSX cell that can contain user/source text MUST pass `spreadsheetSafeText`.
Formula-like prefixes (`=`, `+`, `-`, `@`, tabs/newlines and whitespace-prefixed formulas) are emitted as text.
Both V1 and v3 XLSX export paths use the same guard.

## Backup / restore

Schema-6 backup validation requires `integration_api_keys` and `ingestion_connectors`.
Regression coverage proves API-key hashes and encrypted connector ciphertext survive canonical backup/restore while plaintext secrets remain absent.

## Acceptance

M0-004 is complete only when focused regressions prove archive guards, SSRF/redirect/IP pinning, MIME sniffing,
API-key lifecycle/rate limiting, connector secret encryption, strict rich-text validation and spreadsheet-injection protection,
and the full `Publikator CI / Acceptance` passes on the PR head.

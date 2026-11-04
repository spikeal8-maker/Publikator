# Publikator Release & Migration Policy

Status: **NORMATIVE for M0-006 and all later vNext work**.

Authoritative parent: `docs/VNEXT_TECHNICAL_SPEC.md`.

## 1. Release lanes

`release/1.0` is the frozen V1 release line created from `v1.0.0-rc.4` and remains on schema 3.
`main` is the vNext development line and owns all schema milestones after 3.

Never merge `main` back into `release/1.0`. Never cherry-pick a vNext feature commit into V1.
Release tags `v1.0.x` are cut only from `release/1.0`; vNext release tags are cut only from the appropriate vNext release line/main policy.
## 2. V1 fix and forward-port policy

Every V1 code fix starts from the latest `release/1.0` head in a small `hotfix/1.0-*` branch and lands through PR + full Acceptance.

After merge, the fix is evaluated for `main`:
- security, data-loss, backup/restore, publication-safety and dependency fixes **MUST** be forward-ported;
- functional bug fixes **SHOULD** be forward-ported when the affected code still exists;
- V1-only release/documentation changes MAY be marked `not applicable` with an explicit reason.

Forward-port uses a separate PR to `main`. Prefer cherry-pick when code is still compatible; otherwise re-implement the same invariant on vNext and cite the V1 fix commit.
A V1 fix is not operationally complete until its main disposition is recorded: forward-port commit/PR, already-fixed equivalent, or documented `not applicable`.
## 3. Schema milestone rule

Publikator uses monotonic, one-step schema milestones. Current ledger:

| Schema | Owner | Purpose |
|---|---|---|
| 3 | V1 baseline | release/1.0 image publisher |
| 4 | M0-002 | editorial stage, content version, immutable revisions |
| 5 | M0-003 | ingestion provenance and source identity |
| 6 | M0-004 | ingestion security state |
| 7 | M0-005 | UTC/IANA scheduling, rendition and publication units |
| 8 | CX3-003 | rich-media authoring relation, video metadata and immutable story/media ordering |
| 9 | EW4-002 | revision-history metadata and complete immutable revision capture for schema-9 content |
| 10 | EW4-003 | canonical rich-text AST + deterministic plain fallback for working posts and immutable revisions |
| 11 | EW4-005 | accepted project defaults: timezone, default targets and per-post isolation |
| 12 | EW4-006 | accepted templates / reusable content blocks |
| 13 | CRED-01A | social credential capability profile persistence + credential_version |
| 14 | P0 admin auth (#167) | local owner sessions and installer setup grants |
| 15 | AGENT-A1a (#175) | owner-scoped AgentPrincipal/AgentGrant and server activity records; no live API or auto-publishing |
| 16 | AGENT-A1b1 (#175) | immutable owner-operation response receipts with hashed idempotency identity; no agent bearer or publishing authority |
| 17 | AGENT-A1b2b1 (#175) | keyed machine identities with hashed opaque tokens, scoped versions, expiry, revoke and rotation; no external agent route |

A feature PR MUST NOT combine several unrelated future data-model milestones into one schema jump.
A new schema version must represent one coherent data ownership/invariant change and migrate from the immediately previous version.
## 4. Mandatory evidence for every new schema version

Schema 11 `project-defaults` and schema 12 `templates` are accepted in `main`. Schema 12 evidence includes:
- migration regression: `scripts/schema-v12-templates-e2e.mjs`;
- backup regression: `scripts/backup-v12-templates-e2e.mjs`;
- feature/domain regression: `scripts/ew4-006-templates-e2e.mjs`;
- migration 11 → 12 is additive and preserves existing projects, posts, revisions, targets, media and schedules.

Schema 13 `social-credential-capability-profile` is owned only by CRED-01A. Evidence: `scripts/schema-v13-social-credential-capability-e2e.mjs`, `scripts/backup-v13-social-credential-capability-e2e.mjs`, and `scripts/cred-01a-capability-profile-e2e.mjs`. Its exact columns, legacy migration semantics and no-network migration rule are normative in `SOCIAL_CREDENTIAL_CAPABILITY_CONTRACT.md` sections 22–24.

Schema 14 `admin-local-accounts` is an additive P0 owner-auth migration (#167) with installer-issued, single-use bootstrap grants; it preserves existing projects, posts, credentials and release data. Its dedicated regressions are `scripts/schema-v14-admin-auth-e2e.mjs` and `scripts/backup-v14-admin-auth-e2e.mjs`.

Schema 15 `agent-ownership-audit` is AGENT-A1a (#175), adding inactive-by-default agent principal/grant storage and bounded safe server-observed audit events. No bot is granted accounts or publication rights during migration; no `/mcp` or Agent API endpoints are exposed. Dedicated regressions: `scripts/schema-v15-agent-ownership-e2e.mjs` and `scripts/backup-v15-agent-ownership-e2e.mjs`. Real A1b owner-authenticated permission mutations and A2 safe event writers require separate accepted checkpoints.

Schema 15 audit hardening (security review P2-01/P2-02): `agent_activity_events.target_account_ids_json` is limited to 4096 UTF-8 bytes, at most 20 items, each an ASCII `[A-Za-z0-9._:-]` ID of 1–128 characters; `[]` remains valid. `safe_summary` is limited to 1–240 Unicode characters and 960 UTF-8 bytes with NUL forbidden. Direct SQLite INSERT/UPDATE are additionally guarded by idempotent `trg_agent_audit_payload_insert` and `trg_agent_audit_payload_update`. SQL constraints only bound shape and size: **A1b/A2 server writers must generate sanitized, allowlisted audit messages without copying credentials, user text or provider responses**; this storage change does not implement a sanitizer or publish permissions.

**Already-created SQLite v15 databases:** SQLite does not modify an existing table's CHECK with `CREATE TABLE IF NOT EXISTS`. The v15 startup path therefore creates missing audit triggers in place, transactionally and without a new milestone, table rebuild or data deletion. Old historical audit rows are **not** retroactively cleaned or revalidated: legacy invalid rows can remain and must be assessed separately before any remediation. Canonical backups produced after guard installation contain both triggers. Restoring a pre-hardening v15 backup requires startup with the hardened binary to reinstall guards before audit writes. The choice of historical data remediation, if needed, belongs to a separate owner-approved migration; never silently rewrite or purge events.

Schema 16 `agent-owner-idempotency-receipts` is the additive AGENT-A1b1 milestone that atomically persists original, server-sanitized REST response DTOs and canonical request fingerprints so a retry after later grant changes, restart, or backup returns the **original response**, never a new state. No raw idempotency keys, bearer tokens or provider credentials are stored. Focused regressions: `scripts/schema-v16-agent-owner-receipts-e2e.mjs` and `scripts/backup-v16-agent-owner-receipts-e2e.mjs`.

Schema 17 `agent-machine-key-digests` adds bounded owner-issued machine keys with SHA-256 digests of cryptographically random 256-bit bearer secrets, explicit token/grant version snapshots, expiry/revoke and safe metadata. Secrets are returned **once** and never persisted, audited, logged or backed up. Replays of issue/rotate only return metadata; lost tokens must be reissued after revocation. Machine keys are restricted to server bots (`n8n`, `telegram_bot`, `max_bot`, `rest_client`) and are not OAuth credentials for ChatGPT. Dedicated migration and backup regressions: `scripts/schema-v17-agent-machine-keys-e2e.mjs`, `scripts/backup-v17-agent-machine-keys-e2e.mjs`. No live API/MCP transport or external publishing in this milestone.

Every schema `N` after the V1 baseline MUST add all of the following in the same checkpoint PR:
1. explicit migration code from `N-1` to `N`;
2. dedicated `scripts/schema-vN-*-e2e.mjs` regression built from a realistic `N-1` fixture;
3. rerun/idempotency assertion;
4. dedicated backup/restore regression proving the new state survives the canonical `.tgz` path;
5. entry in `SCHEMA_MILESTONES`;
6. both regression scripts wired into the single `Publikator CI / Acceptance` workflow.

The migration must preserve historical published content and all previous milestone invariants. A binary MUST refuse to open a database whose `user_version` is newer than it supports.
## 5. Rollback and destructive changes

Publikator does not use reverse/down migrations as the rollback mechanism. Rollback is: stop the incompatible binary, restore a canonical backup, then run the older compatible binary.

Additive migrations are preferred. A destructive migration requires a separate ADR, a pre-migration canonical backup requirement, explicit rollback rehearsal and evidence that retained backups remain readable.

## 6. Agent rule

A coding agent adding schema `N+1` must update the migration ledger and satisfy the policy regression before opening the PR. Missing migration or backup evidence is a hard Acceptance failure, not a documentation TODO.
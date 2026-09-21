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
| 12 | EW4-006 | accepted templates and reusable content snapshots |
| 13 | Product completion | editorial metadata: editor/source notes, tags and campaign in posts + revisions |

A feature PR MUST NOT combine several unrelated future data-model milestones into one schema jump.
A new schema version must represent one coherent data ownership/invariant change and migrate from the immediately previous version.
## 4. Mandatory evidence for every new schema version

Schema 12 `templates` is accepted in `main`. Product completion introduces schema 13 `editorial-metadata`; evidence is:
- migration regression: `scripts/schema-v13-editorial-metadata-e2e.mjs`;
- backup regression: `scripts/backup-v13-editorial-metadata-e2e.mjs`;
- migration 12 → 13 is additive and preserves all existing post/revision content while backfilling neutral metadata defaults;
- editor/source notes, tags and campaign are versioned with ContentRevision and survive canonical backup/restore.

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
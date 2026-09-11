# Publikator — coding agent execution contract

This file is the first entry point for coding agents working in this repository.

## 1. Read order

Do not begin with a repository-wide audit unless the task explicitly asks for one.

For a normal implementation task read only:

1. this `AGENTS.md`;
2. the GitHub issue/checkpoint being implemented;
3. the relevant section(s) of `docs/VNEXT_TECHNICAL_SPEC.md`;
4. `docs/DEVELOPMENT_RULES.md` only for invariants touched by the change;
5. the minimum source/test files needed for that checkpoint.

Use search before opening large files. Do not repeatedly reread unchanged documentation in the same task.

Document precedence is defined by `docs/VNEXT_TECHNICAL_SPEC.md`.

## 2. Unit of work

Default rule: **one checkpoint = one branch = one PR**.

Examples: `M0-001`, `CP2-003`, `CX3-001`, `EW4-003` are separate work units unless the authoritative spec explicitly requires them together.

A checkpoint PR SHOULD:

- change one subsystem or one coherent vertical slice;
- have one focused acceptance script/test set;
- avoid unrelated refactors, formatting and dependency upgrades;
- avoid implementing the next checkpoint “while already here”.

If a change crosses multiple schema milestones, multiple unrelated modules, or cannot be reviewed independently, split it before coding.

## 3. Token/context economy

Agents MUST prefer targeted retrieval over broad context loading.

- Search by symbol/path/endpoint before reading full files.
- Read exact ranges when possible.
- Do not scan `node_modules`, generated assets, build output or backup data.
- Do not read `package-lock.json` unless dependency identity is relevant.
- Do not re-audit architecture already settled by the master spec.
- Reuse existing helpers/tests instead of rediscovering equivalent logic.
- Keep implementation notes short and factual.

A task that starts requiring a new product decision is not an excuse for a large exploratory rewrite. Record the ambiguity in the PR/issue and implement only the non-ambiguous checkpoint scope.

## 4. Change discipline

Before editing, identify:

- checkpoint ID;
- files expected to change;
- invariant(s) that must remain true;
- focused acceptance required.

During implementation:

- preserve modular-monolith boundaries;
- preserve V1 regressions unless the migration checkpoint explicitly changes them;
- use additive/milestone migrations rather than a giant schema rewrite;
- do not bypass atomic publication/recovery/concurrency rules;
- do not invent platform capabilities not confirmed by the spec/current official API work item.

## 5. Test order

Use the cheapest useful test first:

1. focused unit/integration/regression for the changed checkpoint;
2. related existing regression scripts;
3. build/typecheck when relevant;
4. full `Publikator CI / Acceptance` before merge.

Do not repeatedly run the full acceptance suite after every small edit when a focused test can provide faster feedback.

New substantial behavior gets a focused regression script under `scripts/` and a named step in the single existing CI workflow. Do not create a second permanent workflow.

## 6. PR handoff

Every PR must leave enough context so the next agent does not need another repo-wide investigation.

PR body must contain these compact sections:

- **Checkpoint** — issue/checkpoint ID;
- **Changed** — what behavior/schema changed;
- **Invariants** — what was intentionally preserved;
- **Tests** — focused tests + full CI result;
- **Next** — the next checkpoint only, not a new roadmap.

Update the GitHub issue checklist when the checkpoint acceptance is actually satisfied.

## 7. Stop conditions

Do not silently broaden scope when any of these occurs:

- authoritative documents conflict;
- implementation would require a new infrastructure service;
- current checkpoint needs a domain-model change not covered by the master spec;
- platform behavior depends on an unverified API capability;
- safe migration/backward compatibility cannot be demonstrated.

In those cases make the smallest safe change possible and record the unresolved decision explicitly.

## 8. Completion definition

A checkpoint is not DONE because code compiles.

DONE requires the checkpoint acceptance from the issue/spec, focused regression coverage, required migration/backup compatibility, updated docs when the public contract changed, and `Publikator CI / Acceptance = PASS` on the PR head.

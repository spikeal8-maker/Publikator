# CX3-012 — Operator Quick Start

Status: implementation checkpoint.

## Problem

Publikator had working platform/account, content-plan, calendar and publication APIs, but the browser shell exposed them as independent technical modules. A new operator had to understand internal terms such as release gate, schema and acceptance before finding the normal publishing workflow.

## Operator path

The primary browser flow is now:

1. **Старт** — one operational home screen.
2. **Соцсети** — add platform token plus the concrete destination (channel/group/chat) and verify it without publishing.
3. **Импорт таблицы** — upload CSV/XLSX, run preview, then apply the exact validated file as DRAFT posts.
4. **Контент** — review text/media and target selection.
5. **Календарь / Расписание** — choose publication timing.

The Start screen also exposes spreadsheet preview/apply directly, so bulk import does not require discovering a separate technical page.

## Spreadsheet safety

The quick import reuses the existing V1 content-plan API:

- `GET /api/content-plan/schema`;
- `POST /api/content-plan/import/preview`;
- `POST /api/content-plan/import/apply`.

Apply still requires the preview SHA-256 and `x-publikator-content-plan: IMPORT`. Imported rows remain DRAFT and never publish automatically.

The browser can generate a header-only CSV template from the live schema. XLSX upload remains supported by the existing importer.

## Navigation

Normal work appears first: Start, Social networks, Import table, Content, Calendar, Schedule, Library and Projects.

Events, Backups, Diagnostics and Release verification remain available but are visually demoted under **Система**. No release/safety subsystem is removed or bypassed.

## Invariants

- no schema change;
- no publisher/recovery/scheduler change;
- no capability flag change;
- no automatic external publication from import;
- account secrets remain encrypted by the existing backend;
- existing content-plan and technical pages remain available.

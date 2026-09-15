# CP2-005 — Google Sheets connector

Normative product rules remain in `VNEXT_TECHNICAL_SPEC.md` and `CONTENT_PIPELINE_V2.md`.

## Boundary

Google Sheets is an external editor/inbox, never Publikator's runtime database.

```text
Google Sheets -> Preview -> schema-v3 validation -> Apply -> Publikator DRAFT
```

The connector does not publish directly to social platforms and deleting a row from Google Sheets never deletes a Publikator post.

## Authentication

CP2-005 uses a Google service-account JSON credential for server-to-server access.

- The spreadsheet must be shared with the service account `client_email`.
- The private key is stored only in `ingestion_connectors.credentials_encrypted` through the existing AES-256-GCM connector security layer.
- `config_json` contains only non-secret `spreadsheetId`, `sheetName`, `writeBack`, and `serviceAccountEmail` metadata.
- Google OAuth assertions are signed with RS256 and sent only to `https://oauth2.googleapis.com/token`.
- Sheet calls are sent only to the fixed `https://sheets.googleapis.com/v4/spreadsheets` API root.
- Import-only connectors request the read-only Sheets scope. Optional status write-back requests the Sheets write scope only for the write operation.

## Import contract

The selected sheet uses the existing public schema-v3 columns in A:U. The connector reads at most 10,000 data rows, converts the returned values into the existing schema-v3 parser, and reuses its normalization, target resolution, scheduling, payload hashing and apply logic.

The Google transport adds only source binding semantics:

- `source_type = google_sheets`;
- stable source identity `gs:<connectorId>`;
- duplicate/update identity remains `sourceId + external_id`;
- every row must supply `source_revision`;
- local edits after import produce `CONFLICT` instead of being overwritten;
- the same `source_revision` with a different payload is rejected;
- only `action=UPSERT` is accepted for Sheets sync in this checkpoint.

The connector intentionally does not translate row deletion into ARCHIVE/TRASH/DELETE.

## Preview / Apply consistency

Preview is read-only and returns `sourceSnapshotSha256` calculated from the normalized A:U values. Apply re-reads Google Sheets and requires the exact preview SHA. If any source value changed, Apply fails and the operator must preview again.

Apply runs under the existing exclusive runtime-maintenance gate and creates/updates only canonical Publikator content. New records remain `DRAFT`.

## Optional status write-back

When enabled, after a successful canonical import Publikator writes service fields to V:Y:

```text
publikator_id
import_status
imported_at
last_error
```

Write-back is deliberately non-authoritative. If Google rejects this write, the already successful Publikator import is not rolled back; the API returns a write-back warning and records an audit event.

## Template workflow

The existing downloadable schema-v3 XLSX template remains the reusable template. An operator can upload/copy it into Google Sheets, share that spreadsheet with the service-account email, select the target sheet, Preview, then Import new/changed rows.

Creating a Google-owned copy through Drive API is not required for connector correctness and would require a broader Google Drive authorization surface. It is intentionally not introduced by CP2-005.

## Schema and architecture

- SQLite schema remains 8.
- Existing `ingestion_connectors` and post provenance fields are reused.
- No Redis, queue, extra worker, Google SDK, or second database is introduced.
- Publisher, scheduler, recovery and platform adapters are unchanged.

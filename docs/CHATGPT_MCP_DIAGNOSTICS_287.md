# ChatGPT MCP: temporary HTTP 415 diagnostics and acceptance (#287)

Status: temporary production observability only; not a product fix and not proof that the original defect is resolved. Owner task: [PUBLIKATOR-MCP-RECONNECT-FIX-001](https://github.com/spikeal8-maker/Publikator/issues/287).

## Scope and guardrails

The existing deployment on `admins-MS-7D22` (1Panel installation `asa-test`) continues serving `https://pub.asa-lab.ru/mcp/chatgpt`. Deployment directory: `/home/admins/publikator-live`; container: `publikator-live-publikator-1`. At installation and follow-up, its image revision was `2b6c6a2246db99af3da8f25d6905ee0ae0631c7f`.

The only temporary server change was OpenResty access logging at the exact MCP location. It does not change routing, application code, supported Content-Types, OAuth, PKCE, token lifetimes (300 seconds / rolling 90 days / maximum 365 days), grants, application data or publishing behavior. Do not revoke an existing working grant, force relinking, modify production token rows, or replay production refresh tokens. Concurrency and fresh-link regression tests must use independent fixture grants and a temporary database. No real publications.

## Actual installed configuration (23 November 2026, 23:37 MSK)

| Item | Host path |
| --- | --- |
| Active site file | `/opt/1panel/www/conf.d/pub.asa-lab.ru.conf` |
| Temporary HTTP-level maps/log format | `/opt/1panel/www/conf.d/00-publikator-mcp-diag-287.conf` |
| Root-only diagnostic log | `/opt/1panel/www/sites/pub.asa-lab.ru/log/mcp-diagnostic-287.log` |
| Root-only original site backup and checksums | `/root/publikator-mcp-diagnostics-287/` |
| Guarded rollback script | `/root/publikator-mcp-diagnostics-287/rollback.sh` |

The exact location preserves the pre-existing main access log and adds:

```nginx
access_log /www/sites/pub.asa-lab.ru/log/access.log main;
access_log /www/sites/pub.asa-lab.ru/log/mcp-diagnostic-287.log pb287_mcp if=$pb287_capture;
```

The HTTP-level capture condition is fail-closed and expires automatically:

```nginx
map "$status:$time_iso8601" $pb287_capture {
    default 0;
    "~^415:2026-11-(23|24|25)T" 1;
}
```

The format uses JSON escaping and these fields only: time, generated request ID, HTTP status/upstream status, HTTP method, allowlisted Content-Type classification (JSON, octet-stream, text/plain, form, multipart, event-stream, MCP JSON, JSON-RPC, absent or other), presence of Content-Type parameters, numeric Content-Length (bounded to 12 digits; absent/invalid otherwise), Transfer-Encoding classification, Accept classification, protocol version (date-shaped or absent/other), MCP method (fixed allowlist or absent/other), presence of Authorization (0/1). It does not log raw unrecognized header values, IP, authorization value, cookies, query, body or publication data. Unknown Content-Type is classified as `other`; an absent `Mcp-Method` header does not establish the actual legacy RPC method. Do not infer an RPC stage from timing alone or enable body logging.

Capture ends at the end of **25 November 2026 local server time**, even if the temporary files remain. The operator must remove the temporary configuration after collecting the required evidence, or immediately after the capture window expires. Do not silently extend the window.

Checksums recorded after install and verified again on 24 November at 00:11 MSK:

- Active site file: `ba17c2c53dc01850aa6ff87689e958b6de3f17a72ccaa5490b5c07f4e0441532`.
- Temporary config: `e1c0ca85b6cdf1addef6699f0968327da24b1186a35d89328418ba385e1953dd`.
- Guarded rollback script: `b12eb581f43d4ce46aaa98fdda8e6d5bf71cad1a5a5652762347fd2be8bb621e`.
- The original backup SHA matches `site-original.sha256` on the host; the active files match their saved hashes. Backup directory and script mode 0700, diagnostic log 0600, owned by root.

These checksums describe this one installation; they must not be reused as authorization to overwrite another configuration.

## Collect and classify evidence

1. Use the existing owner-authorized 1Panel administration surface. Confirm hostname, image revision, health and that the site/config/backup hashes match the recorded guards.
2. Inspect only the restricted diagnostic JSON fields for status 415 and correlate with sanitized application request times/status and normal access-log status. Exclude the known synthetic 23:37:40 MSK probe (ID `9d99e6ceb8987ba2f4f105fe41fa33c7`, octet-stream, length 2, no Authorization). Do not share full access logs or credentials.
3. Existing working ChatGPT connection: use read-only project/account list calls. New chat: owner opens a new chat with the already connected app and performs the same calls without resetting permissions. Fresh consent/catalog discovery: observe an actual ordinary first-link flow when available, without disconnecting the working integration. If the UI prompts for reconnect, a single normal owner-approved attempt is sufficient for capture. Do not force a failure.
4. Compare captured framing and known protocol stage to the official SDK and the existing HTTP E2E fixture. If no new real failure exists, retain the unresolved historical defect as such; never declare a parser change necessary based only on a synthetic unsupported payload. No arbitrary global parser, blanket HTTP 200 or OAuth bypass.

## Guarded removal / rollback

The original site file is preserved under the root-only backup path. The installed rollback script checks the exact active site and diagnostic configuration SHA-256 before restoring the original site file, removing the temporary HTTP configuration and running nginx configuration validation and a graceful reload.

Before running it, independently validate the original backup against `site-original.sha256` and check that the current site file and diagnostic file agree with their saved hashes. Check hostname and `nginx -t`. Preserve any necessary sanitized incident evidence in issue #287, not raw application logs. If a hash differs, **stop**: the site may have changed since installation. Reconcile the current config with only the temporary additions; do not blindly overwrite newer site settings. If no divergence exists:

```bash
test "$(hostname)" = admins-MS-7D22
b=/root/publikator-mcp-diagnostics-287
test "$(sha256sum "$b/pub.asa-lab.ru.conf" | cut -d' ' -f1)" = "$(cat "$b/site-original.sha256")"
docker exec 1Panel-openresty-fc55 nginx -t
"$b/rollback.sh"
docker exec 1Panel-openresty-fc55 nginx -t
test ! -e /opt/1panel/www/conf.d/00-publikator-mcp-diag-287.conf
test "$(sha256sum /opt/1panel/www/conf.d/pub.asa-lab.ru.conf | cut -d' ' -f1)" = "$(cat "$b/site-original.sha256")"
docker inspect --format '{{.State.Health.Status}}' publikator-live-publikator-1
```

Verify that the active MCP location no longer includes the extra log, HTTPS discovery and two real ChatGPT read calls still succeed, and the image revision is unchanged. Once the old proxy workers no longer have the file open, retain only the necessary sanitized incident summary, then remove the temporary diagnostic log under owner-authorized retention policy. Never remove ordinary access logs, backups, application data or OAuth artifacts. Keep the root-only original configuration/rollback evidence under the host's backup policy until acceptance is closed. Record actual removal time, config test, live checks and outcome in issue #287.

## Acceptance evidence and limitations (24 November 2026, 00:11 MSK)

- Before the temporary logger, four consecutive real ChatGPT linking attempts returned OAuth authorize 303, token 200, MCP 200 then MCP 415 (`FST_ERR_CTP_INVALID_MEDIA_TYPE`). The original request headers and exact legacy/modern stage were not retained.
- 22 sequential actual ChatGPT calls on 23 November were successful before/after graceful proxy reload. A later pair succeeded at 23:51:27 and 23:51:31 MSK, and two more read calls at 00:10:14 and 00:10:16 MSK on 24 November, returning the same 2 projects / 3 accounts for the latter pair. No fresh authorization redirect or additional real 415 was observed in the inspected interval. Token requests returned HTTP 200. The 18-minute gap establishes connectivity beyond the nominal five-minute access TTL in the existing conversation, not proof that ChatGPT reused an expired access token or that a particular refresh was used.
- Existing exact deployed revision CI [45252512510](https://github.com/spikeal8-maker/Publikator/actions/runs/45252512510) passed Acceptance and focused agent auth security. The existing suite tests fixture owner consent, OAuth refresh/expiry across app restart, scoped MCP SDK operations, and revocation/restore invalidation. Explicit legacy transport phases and concurrent refresh are additional fixture coverage, not a substitute for real ChatGPT first-link acceptance.
- Still required: a fresh real ChatGPT consent/catalog discovery observation (or explicit unresolved client-side blocker), a new-chat read with the existing link, verified safe concurrent fixture refresh/replay, real post-container-restart read when an authorized deployment/restart is appropriate, and a recorded removal of the temporary diagnostic config. Do not restart a healthy production container solely to fabricate an accepted release.
- No product fix is claimed; no user data, permissions, credentials or production container image changed. Issue #287 stays open until acceptance.

# VK-GROUP-TEXT-001

## Provider evidence

Controlled owner-authorized acceptance on 2026-10-08, API 5.199, community 234601853:
- groups.getTokenPermissions confirmed GROUP identity and wall permission.
- groups.getById without group_id returned the community bound to the credential.
- wall.post with owner_id=-234601853 and from_group=1 succeeded (post 1039).
- photos.getWallUploadServer and photos.getUploadServer each returned code 27: unavailable with group authorization.

This corrects the schema-only assumption that every wall.post requires USER. It does not establish GROUP photo uploading. No secret belongs in evidence, source or logs.

## Scope and invariants

The existing wall.post adapter accepts FEED/TEXT_ONLY without media. GROUP accepts only text with matching bound community and wall permission; safe probes run again immediately before sending. Public write is never used to inspect/save/check credentials. IMAGE/CAROUSEL still require USER. Existing atomic claim, guid, retry/recovery and immutable text/media revision mechanisms remain in use.

GROUP saves persist encrypted secrets and a PARTIAL per-format profile. New GROUP accounts enable only when text is ready. Enabling an existing account uses its stored encrypted secret, never browser readiness claims. Pending keys remain disabled until server verification. Limited GROUP keys remain valid. This slice does not complete the separate CRED-01C convergence or CRED-02 credential-binding lanes.

## Acceptance

GitHub is the implementation and regression surface. The host is required only for real Windows Docker deployment and owner-authorized live VK acceptance; fixture CI cannot prove those API responses.

Focused regression: scripts/vk-group-text-e2e.mjs, existing VK key storage/pending/capability/inspection regressions, then the single full Publikator CI / Acceptance. Live post through deployed product and UI result must be recorded before reporting deployed acceptance.

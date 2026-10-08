# VK-PHOTO-CREDENTIAL-ROLES-001

## Scope and evidence
The owner-supplied 02_CONTENT_ROUTER_PUBLISH export separates VK_USER_TOKEN for photo preparation and VK_WALL_TOKEN for wall.post. Its album path is photos.getUploadServer → multipart file1 → photos.save → wall.post with saved attachment IDs. The personal USER literal differs from the chat test key; direct Windows users.get returned VK error 5 invalid access_token (4). The chat USER key returned error 5 IP binding. Neither can prove live photo acceptance now.

This checkpoint transfers the credential-role principle using the existing supported wall-photo transport: photos.getWallUploadServer → multipart photo → photos.saveWallPhoto → wall.post. Album/archive configuration is not implemented or inferred from the export. No alternate publication transport or schema migration is introduced.

## Changed
A COMMUNITY connection can optionally store uploadAccessToken alongside the main accessToken in the same encrypted credential envelope. Server probes confirm the primary GROUP's bound community/wall permission, secondary USER method eligibility via account.getAppPermissions, secondary identity and wall-upload URL for the same community. users.get alone cannot prove USER eligibility.

TEXT can stay ready when the secondary key is invalid, IP-bound, service-only or absent. IMAGE/CAROUSEL require a verified secondary key and show the exact remediation. The profile's primary credential/destination remains GROUP; each photo-method reason explicitly identifies the secondary actor. Save/check do not upload files or publish.

Before media preparation, publication rechecks both roles and the persisted secondary owner. Photo methods use only the USER key; wall.post uses only the primary key and its verified community. Existing atomic claim, guid and unknown-result recovery remain in use. Server-derived photo readiness cannot be supplied by the browser. GROUP key replacement remains outside this slice; rechecked credential semantics use replaceSocialAccountCredentials/version invalidation.

## Acceptance
scripts/vk-photo-credential-roles-e2e.mjs covers ordinary browser entry/save of both keys, encrypted persistence, secret-free listing, canonical capability evidence, READY without provider writes, actual adapter image publication with separated API roles, invalid helper preserving TEXT, service helper rejection despite users.get identity and revoked upload rights blocking before upload/public post. The single required full Acceptance must pass on the exact PR head.

Host access is required only for Windows Docker and owner-authorized real provider/UI acceptance, which GitHub fixtures cannot reproduce. Do not report live photos as passed until a currently usable USER key completes them.

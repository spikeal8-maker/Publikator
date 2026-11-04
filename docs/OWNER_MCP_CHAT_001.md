# OWNER-MCP-CHAT-001

Status: implementation candidate; acceptance evidence is recorded in the PR.

## Owner authorization
The owner requested full publication/application administration through MCP, an embedded OpenAI/DeepSeek/compatible/Ollama chat, and authorized container changes. This introduces a distinct OWNER_ADMIN key, not a silent expansion of existing FULL_CONTENT or legacy integration keys. Every key is owner-issued, hashed, expiring and revocable. No administrative/provider secret is sent to a model as tool output.

## One application implementation
Browser chat and MCP share the same validated tool registry. Registered application operations execute through an internal single-request server capability (AsyncLocalStorage plus an explicit in-memory permit for injected request boundaries), bound to exact method/URL and an unguessable nonce; a spoofed header or a legacy bearer never grants administrative access. The canonical publisher, version checks, explicit recipients, preflight and recovery remain authoritative. Owner-admin schedules are persistent owner instructions: revoking a connection blocks new calls but does not silently erase already-saved schedules.

## Interfaces
The owner page is /assistant.html; connections, chat and key management require the existing local-account login and exact Origin. MCP is /mcp, using an explicit Authorization: Bearer owner key. SDK 2 handles modern and stateless legacy HTTP. OAuth linking and public HTTPS publication of the endpoint are NOT supplied by this checkpoint; a caller must already be able to reach the configured server address securely.

Model configurations accept a cloud API key or an Ollama address. Custom cloud endpoints require HTTPS and may not resolve to private/link-local networks; only explicitly configured Ollama may access a local model host. Redirects are not followed, DNS answers are pinned, request/response/loop sizes are bounded. Connection testing calls one harmless probe tool and never publishes content.

## Coverage and boundaries
The operation catalog exposes installed JSON publication, account, project, source, schedule, template, agent administration and diagnostic operations. Dedicated post/media tools validate current content versions and exact recipients. MCP accepts small files up to 5 MiB inline or chunked uploads up to 512 MiB with exact offsets and SHA verification; the chat also accepts authenticated multipart uploads. Google Drive and Yandex directory listing is root-bounded and paginated. Cloud import follows existing connector capabilities. Unknown platform formats are not invented. Database replacement uses a separately named restore tool, exact archive confirmation and the existing canonical pre-restore backup/restart flow; it is not a generic operation. Raw credential export and operating-system shell access are not publication administration tools.

## Preservation
The candidate integrates existing agent work on top of deployed 244c7f36aa7dc365fc74d0a1bdc6e513867d774c. Original Windows instance, encrypted credentials and media remain authoritative. Pre-upgrade canonical backup is outside the container. Schema 19 is additive, but rollback must restore the pre-upgrade bundle. Pending upload staging is ephemeral and excluded from backup; attached media, encrypted chats and settings are retained in the canonical bundle.

## Required evidence
Typecheck/build, focused auth/Origin/key/revoke/receipt/GET purity tests, actual SDK client tools/list+call, fake-model tool loop and cancellation, migration and canonical backup/restore, browser desktop+mobile, exact-SHA full Acceptance, then isolated and installed Docker readback. No unspecific live social test post.

## Initial focused evidence
Actual official SDK HTTP client: 45 assertions PASS, 28 tools, scoped legacy-key denial, owner-admin delegation, chunk upload/attachment, read-pure preview, idempotency, model loop and cancellation. Schema18→19 migration and canonical backup/restore: PASS. Real Chrome: 12 assertions PASS at 1440/390/320px. Local Ollama gemma4:12b: harmless tool probe and synthetic read/result roundtrip PASS, no real social writes. Cloud models have mock/adapter acceptance only until an owner-supplied provider key is tested. Full canonical CI and deployment evidence remain separate.

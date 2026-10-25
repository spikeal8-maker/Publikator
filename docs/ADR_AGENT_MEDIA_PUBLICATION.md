# ADR-AGENT-MEDIA-002 — приватные медиа, безопасное чтение и точные получатели

**Статус:** A0c planned contract; не реализовано. Parent: [#174](https://github.com/spikeal8-maker/Publikator/issues/174), #178.  
**Выбор:** не менять существующую отправку в соцсети, пока нет работающей альтернативной поставки медиа по HTTPS; разделить **доступ владельца/агента к оригиналам** и **минимально необходимую публичную доставку конкретным провайдерам**.

## 1. Проверенный исходный риск

`src/app.ts` монтирует `config.mediaDir` через `@fastify/static` на префикс `/public-media/` без agent grant. `src/http/security.ts` выставляет для этого префикса `Cross-Origin-Resource-Policy: cross-origin`. Следовательно, любая ссылка на оригинальный файл из private черновика потенциально переживает отзыв доступа агента и доступна любому, кто знает URL, если наружу опубликован весь этот префикс. Без изменения provider delivery нельзя просто закрыть маршрут cookie-auth: MAX/Instagram могут забирать изображение по публичному HTTPS.

**Запрещённое «решение»:** URL как единственный ACL, случайный UUID как гарантия приватности, глобальное выключение `/public-media/` без provider regressions, выдача боту временных Google API keys и любых абсолютных путей на хосте.

## 2. Выбранные контуры

- **Canonical originals** хранятся в прежнем volume, но **не имеют общей anonymous static раздачи** для приватных/новых agent-managed файлов. Access через `GET /api/agent/v1/media/:id/...` (planned), owner session либо scoped agent; точные project/source/media ACL и denial tests. Использовать закрытый route, no-store, safe thumbnail/media ID, без bearer в URL.
- **Provider delivery derivative** создаётся только для определённой approved revision/target/media, прошедшей preflight/claim, когда адаптер соцсети действительно требует внешний HTTPS fetch. Публичная URL-часть имеет независимый неугадываемый capability ID, bounded TTL, content-type и deterministic checksum; нельзя получить приватный original по его ID или «../». Доступ может сохраняться после POST лишь столько, сколько фактически требует провайдер — TTL устанавливается по подтверждённым методам конкретной площадки, не произвольно.
- **Existing media**: migration/compat mode определяется отдельно: существующие исторические provider URLs не ломать, но не расширять общую анонимную экспозицию новыми upload/agent files. Перед снятием старого prefix — real provider fetch, checksum, offsite HTTPS, backup/restore acceptance, owner-approved cutover.
- **Google Drive source**: только owner allowlisted connector/root; `listAgentSourceFiles` отдаёт root-relative `relativePath` и стабильные file ID/revision, а `media/import` заново валидирует scope/root, путь, редиректы, MIME, размер, source revision. Content from Google is **untrusted data**, not instructions. Canonical asset gets SHA-256, source provenance, ordered media IDs; failed import is recoverable without duplicate canonical IDs.
- **Rest/MCP previews**: never expose raw host paths or indefinite public URLs; provide protected IDs plus *effective per-target* media order, resolved text and downgrade warnings. `GetPost`/preview read never changes DB.

## 3. Read purity, explicit recipient semantics

Legacy `GET /api/posts/:id` calls `ensureTargets()`, which can INSERT default targets. New Agent API/MCP GET/preview **cannot reuse that side effect**. A read must leave row count, status/version, recipient membership, media and job receipts unchanged. Any migration of legacy behavior is separate and backward-compatible.

- Missing `targetAccountIds` or `[]` on new Agent Draft means **no recipients**; do not silently choose project defaults or all connected accounts.
- Explicit targets (including multiple VK groups) are validated individually against agent grant/project/provider capability, stored in supplied order or canonical deterministic order, and cryptographically bound to immutable owner approval.
- Invalid/not allowed target ID yields validation/permission error; never silently drop it to publish to the remaining accounts.
- Copying already posted material creates a new versioned draft; owner approval and provider credentials cannot be inherited blindly from the original.
- Preview/preflight may use a write-shaped endpoint for computation, but returns no mutations/claims/public posts, verified by before/after DB and fake-provider request counts.

## 4. Acceptance requirements (fake providers and real staging only with consent)

| Gate | Test |
|---|---|
| MEDIA-01 | unauthenticated access to agent private original/thumbnail denied; media ID from agent A not readable by B |
| MEDIA-02 | existing authorized provider pulls still work against controlled delivery URL until safe cutover |
| MEDIA-03 | provider derivative differs from private original access path, scope and bounded TTL; no raw URL without capability |
| MEDIA-04 | malicious folder path/..\\ /symlink/redirect/private address/MIME spoof rejected before import |
| MEDIA-05 | search/list scoped Drive files → import job → ordered canonical IDs → draft → preview; source revision and SHA preserved |
| MEDIA-06 | aborted import/restart returns same receipt, only durable media, no untracked duplicate |
| READ-01 | GET/list/preview 100x cause 0 DB/media/recipient/job changes |
| TARGET-01 | with 9 VK + 2 Telegram accounts, exactly selected 3 IDs appear in draft and provider calls; no defaults |
| TARGET-02 | missing/empty IDs produce 0 recipients and no READY; invalid/disallowed ID cannot turn into partial publish |
| TARGET-03 | content media order and per-target effective rendition differ only by verified provider capability; downgrades disclosed |

**Source boundary:** `docs/contracts/agent-api-v1.openapi.yaml` has source-file discovery and owner-level grants; implementation follows these schemas, not a second media subsystem. No live provider POST in GitHub CI. UI/admin shows secure media previews without exposing links that bypass revocation.

**Status:** runtime, migration and public HTTPS delivery remain **NOT_IMPLEMENTED**. Include these gates in A4 and A8.

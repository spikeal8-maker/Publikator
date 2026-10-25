# A0c — матрица реальных клиентов и совместимости

**Статус:** `NOT_VERIFIED` для всех реальных подключений: Publikator ещё не имеет запущенного Agent REST/OAuth/MCP. Здесь фиксируется **что проверить**, а не обещание универсальной работоспособности. Протокольные документы сверены 25.10.2026.  
**Обязательное различие:** `PROTOCOL_DOCUMENTED` ≠ `CLIENT_CONNECTED` ≠ `WRITE_VERIFIED` ≠ `LIVE_PROVIDER_ACCEPTED`.

| Клиент/сценарий | Протокол | Транспорт | Auth | Факт в Publikator | Минимальное доказательство |
|---|---|---|---|---|---|
| MCP Inspector | modern `2026-07-28` | Streamable HTTP POST | тестовый OAuth/S256 | `NOT_VERIFIED` | outside HTTPS: discovery, token exchange, tools/list, unauthorized/authorized calls |
| ChatGPT Plugins | remote MCP | HTTPS / одобренный tunnel | OAuth CIMD/static, resource/aud, PKCE, tool securitySchemes | `NOT_VERIFIED` | пользователь видит linking UI, scoped list+read+draft, owner consent на write при entitlement |
| OpenAI Codex | MCP | remote или tested local | OAuth/agent grant | `NOT_VERIFIED` | реальные tools/list/call и REST parity |
| Claude Code/Desktop | MCP version agreed by concrete client | remote/local | supported OAuth mode | `NOT_VERIFIED` | exact app/client version, negotiation, read/draft + permission denied |
| Cursor/VS Code | MCP version agreed by concrete client | remote или stdio bridge | scoped token/OAuth | `NOT_VERIFIED` | read-only smoke и draft with revocation |
| n8n | REST/OpenAPI | HTTPS | отдельный hashed machine agent bearer | `NOT_VERIFIED` | import → draft, per-account status, 401 after revoke |
| Telegram/MAX собственный бот | REST/OpenAPI | HTTPS | отдельный limited agent key | `NOT_VERIFIED` | только разрешённые проекты/аккаунты, без master key |
| Python/Node generic client | REST/OpenAPI 3.1 | HTTPS/local integration | restricted machine bearer | `NOT_VERIFIED` | request/response JSON Schema, retry 409, pagination, audit |
| Legacy MCP client `2025-*` | explicit legacy only | only enabled after proof | same grants | `NOT_VERIFIED` | protocol negotiation, no silent downgrade, same 401/403 behavior |
| Custom GPT Actions | legacy REST/OpenAPI integration | HTTPS | per-client OAuth / API key per supported product | `NOT_VERIFIED` | compatibility-only; не долгосрочный primary UI |

## Modern MCP / SDK договорённость

- Required target: `2026-07-28`, SDK `@modelcontextprotocol/server` **v2**. Версия библиотеки pinned после A1c/A3 spike; дефолт v2 может говорить legacy — **явно включить современный режим**.
- Заголовки POST: `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` для named calls, то же protocol version в `params._meta`; no required GET-stream/session.
- `securitySchemes` per-tool + `_meta["mcp/www_authenticate"]`; OAuth issuer, audience, scopes проверять на **каждый** tool call. Owner-only endpoints never tools.
- CIMD экспериментален в выбранной `oidc-provider` v9.x: публичный client metadata документ должен пройти allowlist/HTTPS/SSRF/check redirect, и только реальное подключение ChatGPT доказывает пригодность.
- Remote address ``https://publisher.example.invalid`` — **пример, не hostname**. Для внешнего теста нужен owner-authorized настоящий ingress с доступом к `/mcp` **и всем OAuth-операциям**.
- Никакая модель/подписка не предполагается имеющей write MCP без реального подтверждения; если конкретный клиент не поддерживает, зафиксировать `CLIENT_CAPABILITY_LIMIT` отдельно от backend.
- Custom GPT Actions — compatibility path; главный контракт — Plugins/MCP и REST/OpenAPI независимо от вендора.

## Как фиксировать доказательство после реализации

Одна строка доказательства = имя и точная версия клиента, дата, настоящий redacted HTTPS origin, immutable build SHA / Docker digest / schema version, OAuth issuer/resource (без секретов), набор разрешённых scopes, tools/list hash, выбранный tool/operation, result IDs, отсутствие unauthorized side effects, link на test log/screenshots. Для отсутствующей возможности — `NOT_VERIFIED` с причиной, не `SUCCESS`.

**Live execution gate:** независимый MCP Inspector + как минимум один коммерческий клиент, затем ChatGPT при доступных возможностях рабочего пространства. Последующая реальная VK/Telegram отправка только отдельным owner-approved тестом с конкретными accountId и сохранёнными ссылками.

**Документация:** https://developers.openai.com/plugins/build/auth ; https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28 ; https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

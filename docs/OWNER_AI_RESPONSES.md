# Owner chat — OpenAI Responses compatibility

The `openai` provider uses `POST /v1/responses`, not Chat Completions. This is required for tool use with current GPT-6 Astra / GPT-6.1 Sol models. DeepSeek and generic compatible endpoints retain their Chat Completions transport; Ollama retains its native API.

The adapter translates the existing shared Publikator tool registry, maps Responses `call_id` to canonical tool feedback, and replays the complete provider output item sequence, including opaque reasoning items, for subsequent tool rounds. Requests use `store:false`; protocol state belongs to the encrypted local conversation. It is bound to the configured connection ID, revision and model. Switching provider/model does not forward another model's opaque state. The existing `safeOutput` filter removes `openai_raw_response` from browser/tool DTOs.

Incomplete, failed, cancelled, malformed, duplicate-call-ID and unsupported result types fail before invoking an application tool. There is no implicit retry or fallback capable of duplicating a publication. Provider authentication, pinned DNS, redirect rejection, bounded responses, cancellation and owner permissions are unchanged. No database migration, stored secret modification or new network service is needed.

## Verification

`node scripts/owner-ai-responses-e2e.mjs` runs 21 deterministic protocol/transport tests. The existing `owner-mcp-chat-e2e.mjs` imports that suite and adds actual browser-history redaction and OpenAI-to-Ollama state-isolation checks. Both canonical CI jobs already execute that script. A passing mock is not live OpenAI billing/entitlement proof; live cloud verification still requires an owner-supplied API key.

Official references consulted on 2026-11-04:
- https://developers.openai.com/api/docs/guides/migrate-to-responses
- https://developers.openai.com/api/docs/guides/function-calling
- https://developers.openai.com/api/reference/resources/responses/methods/create

# EW4-004 Platform Text Compilers — official API evidence

Evidence date: **2026-09-19**.

This document records only the external API facts used by EW4-004. It does not activate live publication capabilities. Existing platform live gates remain authoritative.

## Telegram

Official contract:
- https://core.telegram.org/bots/api
- `sendMessage` supports explicit `entities` instead of `parse_mode`;
- media captions support `caption_entities`;
- `postStory` documents `caption_entities` as an alternative to `parse_mode`.

Publikator decision:
- transport = plain `text` plus explicit `entities`, or `caption` plus `caption_entities`;
- no MarkdownV2 authoring or compiler transport;
- entity offsets/lengths are UTF-16 code units;
- bullet/numbered lists are deterministic textual prefixes;
- incompatible code/link/mark overlaps are downgraded with stable WARNING diagnostics.

## MAX

Official contract:
- https://dev.max.ru/docs-api
- https://dev.max.ru/docs-api/methods/POST/messages
- current message API accepts a `format` value including `html`;
- current HTML formatting documentation covers bold, italic, underline, strike, code/pre, links and blockquote.

Publikator decision:
- transport = `text` + `format=html`;
- all text and href values are compiler-escaped;
- raw user HTML is never inserted or forwarded;
- lists use deterministic textual prefixes, not claimed native list semantics.

## VK

Official source:
- https://github.com/VKCOM/vk-api-schema
- `wall/methods.json`, `wall.post`, parameter `message`: ordinary post text.

Publikator decision:
- transport = deterministic plain `message`;
- no undocumented Markdown/HTML mode;
- marks such as bold/italic/underline/strike/inline-code downgrade to plain with WARNING;
- links/quotes/lists/code-block preserve meaning through plain transforms with INFO diagnostics.

## Instagram

Official contract URL:
- https://developers.facebook.com/documentation/instagram-platform/content-publishing

The Meta documentation endpoint was not reliably retrievable from the verification environment on 2026-09-19. EW4-004 therefore makes **no expanded rich-formatting claim** beyond the existing reviewed content-publishing container contract used by the adapter: a normal `caption` string.

Publikator decision:
- transport = deterministic plain caption;
- no generated HTML or Markdown;
- marks downgrade with WARNING;
- links/quotes/lists/code-block preserve readable meaning with INFO diagnostics;
- hashtags and @mentions remain ordinary text.

## Canonical source precedence

One resolver is used by preview, preflight and publisher:

```text
TargetRendition.text_rich_json
        ↓
legacy post_targets.override_text
        ↓
historical TargetRendition.text_plain compatibility
        ↓
immutable/base body_rich_json
```

If rich JSON exists it is authoritative. A mismatching stored `text_plain` is an ERROR diagnostic. Legacy plain text is converted to literal canonical AST and is never parsed as Markdown.

## Capability modes

| Feature | Telegram | MAX | VK | Instagram |
|---|---|---|---|---|
| bold | native | native | drop | drop |
| italic | native | native | drop | drop |
| underline | native | native | drop | drop |
| strike | native | native | drop | drop |
| inline code | native | native | drop | drop |
| code block | native | native | transform | transform |
| link | native | native | transform | transform |
| quote | native | native | transform | transform |
| bullet list | transform | transform | transform | transform |
| ordered list | transform | transform | transform | transform |

`native` means the transport preserves the presentation semantics directly.
`transform` means semantic meaning is retained deterministically without claiming native representation.
`drop` means presentation is removed and a WARNING is emitted.

## Diagnostic matrix

| Code | Severity | Platforms / meaning |
|---|---|---|
| `RICH_BOLD_DOWNGRADED` | warning | VK/Instagram bold presentation removed |
| `RICH_ITALIC_DOWNGRADED` | warning | VK/Instagram italic presentation removed |
| `RICH_UNDERLINE_DOWNGRADED` | warning | VK/Instagram underline presentation removed |
| `RICH_STRIKE_DOWNGRADED` | warning | VK/Instagram strike presentation removed |
| `RICH_INLINE_CODE_DOWNGRADED` | warning | VK/Instagram inline-code presentation removed |
| `RICH_TELEGRAM_CODE_OVERLAP_DOWNGRADED` | warning | Telegram keeps code and drops incompatible overlapping marks |
| `RICH_TELEGRAM_LINK_CODE_OVERLAP_DOWNGRADED` | warning | Telegram preserves readable URL instead of invalid overlap |
| `RICH_MAX_CODE_OVERLAP_DOWNGRADED` | warning | MAX keeps code and drops incompatible overlapping marks |
| `RICH_LINK_TRANSFORMED` | info | readable link text/URL transform |
| `RICH_BLOCKQUOTE_TRANSFORMED` | info | plain quote transform where native presentation is unavailable |
| `RICH_BULLET_LIST_TRANSFORMED` | info | textual bullet prefixes |
| `RICH_ORDERED_LIST_TRANSFORMED` | info | textual numeric prefixes |
| `RICH_CODE_BLOCK_TRANSFORMED` | info | code text/newlines preserved without rich presentation |
| `RICH_LEGACY_RENDITION_PLAIN` | info | historical plain TargetRendition converted literally |
| `RICH_TEXT_PLAIN_MISMATCH` | error | authoritative target rich AST disagrees with stored plain fallback |
| `RICH_BASE_PLAIN_MISMATCH` | error | authoritative Base rich AST disagrees with Base plain fallback |

Compiler warnings/info do not block READY. ERROR diagnostics do. Existing capability/media/content errors remain errors.

## Safety / purity

Compilers are pure deterministic functions:
- no DB;
- no network;
- no filesystem;
- no credentials;
- no DOM.

Preview renders canonical AST through the existing safe renderer. Compiled MAX HTML is never inserted through `innerHTML`.

## Scope boundary

EW4-004 does not:
- change schema 10;
- enable currently live-gated video/story/short capabilities;
- add spoiler/custom emoji/headings/platform advanced options;
- start EW4-005/006.

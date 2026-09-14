# CX3-007 Dashboard + visual contrast

This checkpoint turns `Обзор` into an editorial surface without replacing technical diagnostics.

## Dashboard truth

`/api/editorial-dashboard` is authenticated and receives browser-derived UTC boundaries for the operator's local `today` and seven-day window. The server never guesses the browser timezone.

The dashboard exposes:

- `Сегодня` — exact scheduled items in the local-day UTC interval;
- `Следующие 7 дней` — total scheduled items and enabled-platform distribution;
- `Нужно проверить` — active `IDEA / DRAFT / IN_REVIEW` items with explicit warning codes;
- `Готово к публикации` — active `READY` items;
- `Проблемы` — `FAILED / PARTIAL` posts or targets in `FAILED / RETRY / RECOVERY_NEEDED`;
- recent external publication results.

Archive and Trash are excluded from editorial metrics. Technical diagnostics and recovery remain separate pages.

Summary values use unbounded SQL `COUNT(*)`; visible lists stay bounded so the dashboard does not render the whole library into the DOM.

## Visual language

`theme-v3.css` defines shared semantic tokens:

`--bg`, `--surface`, `--text-primary`, `--text-secondary`, `--border`, `--accent`, `--success`, `--warning`, `--danger`.

Primary text is near-black on light surfaces; the dark navigation uses explicit near-white foreground tokens. Focus states are visible. Status badges always contain text plus an icon/prefix and color is not the sole carrier of meaning.

## Scope boundary

Schema remains 8. Publisher, scheduler, platform adapters and CX3-008 capability enablement are unchanged.

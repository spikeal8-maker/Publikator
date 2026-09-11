# Editorial Workflow v4

> Normative vNext decisions are defined in [`VNEXT_TECHNICAL_SPEC.md`](VNEXT_TECHNICAL_SPEC.md). If this document conflicts with the master specification, the master specification wins.


## Цель

Сделать Publikator не только местом, куда попадает контент и где он визуально отображается, но и полноценной редакционной системой: создавать, сохранять как черновик, редактировать, согласовывать, переносить по календарю, выбирать площадки, применять шаблоны, импортировать обновления из таблиц и безопасно удалять будущие публикации.

Этот документ дополняет:

- `CONTENT_PIPELINE_V2.md` — как контент попадает в Publikator;
- `CONTENT_EXPERIENCE_V3.md` — как контент выглядит, проигрывается и отображается в календаре;
- `EDITORIAL_WORKFLOW_V4.md` — как человек редактирует, согласовывает, обновляет, шаблонизирует и удаляет контент.

Publikator остаётся единственным runtime source of truth.

---

## 1. Две независимые оси состояния

Не смешивать редакционный этап и техническое состояние публикации.

### Editorial stage

```text
IDEA
DRAFT
IN_REVIEW
APPROVED
ARCHIVED
TRASHED
```

### Publication state

Существующая state machine остаётся отдельной:

```text
DRAFT
READY
PUBLISHING
PARTIAL
PUBLISHED
FAILED
```

`QUEUE` is a schedule mode, not a vNext publication state. Legacy DB value `QUEUED` must not be emitted by new code.

`editorial_stage` отвечает на вопрос «готов ли материал редакционно».

`publication state` отвечает на вопрос «что происходит с доставкой на площадки».

Изменение редакционно значимого поля у будущего `READY` поста должно сбрасывать его обратно в состояние, требующее повторного preflight/approval.

---

## 2. Что можно редактировать у будущей публикации

До начала внешней публикации пользователь должен иметь возможность изменить:

- внутренний заголовок;
- основной текст;
- форматирование;
- platform-specific тексты;
- изображения;
- видео;
- порядок media;
- publication kind (`FEED / SHORT / STORY`);
- content format;
- дату и время;
- timezone;
- schedule mode;
- список площадок;
- конкретные social accounts;
- source note;
- теги;
- шаблон/пресет;
- внутренние редакторские заметки.

Для `PUBLISHING` контент блокируется.

Для `PARTIAL/PUBLISHED` историческая версия не переписывается молча. Редактирование уже опубликованного материала — отдельная platform capability и отдельный workflow с audit trail.

---

## 3. Удаление будущих публикаций

Нужна безопасная модель удаления.

### Неопубликованный пост

Действия:

```text
Archive
Move to Trash
Restore
Delete permanently
```

`Delete` из календаря/библиотеки по умолчанию означает `Move to Trash`, а не физическое уничтожение.

При перемещении будущего поста в Trash:

- он исчезает из активного календаря;
- scheduler больше не рассматривает его;
- media остаются доступны для восстановления;
- audit event фиксирует действие;
- запись можно восстановить.

Рекомендуемый retention Trash: 30 дней, настраиваемый.

### Permanent delete

Разрешать только после отдельного подтверждения.

При permanent delete:

- удалить post/targets/editorial revisions;
- удалить media только если они не используются другими объектами;
- не затрагивать внешние соцсети.

### Published post

Для опубликованного поста базовое действие — `Archive locally`.

Удаление уже опубликованного поста с внешней платформы должно быть отдельной capability-specific операцией, если API площадки это реально поддерживает.

Нельзя одной кнопкой «Удалить» случайно стереть внешний пост без явного подтверждения.

---

## 4. Revision history / Undo

Редактор должен автоматически создавать revisions при существенных изменениях.

Хранить минимум:

```text
revision_id
post_id
created_at
actor/source
editorial_stage
schedule snapshot
targets snapshot
rich text snapshot
media order snapshot
```

UI:

- `История изменений`;
- кто/что изменил;
- сравнение текста;
- сравнение даты/targets;
- `Восстановить эту версию` для ещё не опубликованного контента.

Imported/API changes должны отображаться как отдельный source actor.

---

## 5. Редактор текста

Обычный textarea недостаточен.

Нужен rich text editor с визуальным toolbar.

### Базовые portable marks

```text
Bold
Italic
Underline
Strikethrough
Inline code
Link
Quote
Bulleted list
Numbered list
Line break
Emoji
```

Не хранить raw Telegram Markdown/HTML как основной текст.

Канонический формат — структурированный rich-text document/AST + plain-text fallback.

Пример направления:

```json
{
  "type": "doc",
  "content": [
    {
      "type": "paragraph",
      "content": [
        {"type":"text","text":"Новый ","marks":[]},
        {"type":"text","text":"модуль","marks":[{"type":"bold"}]},
        {"type":"text","text":" ASA Lab","marks":[]}
      ]
    }
  ]
}
```

Adapter компилирует canonical rich text в безопасный формат площадки.

---

## 6. Platform-specific редактор

У каждого выбранного target должна быть вкладка/карточка:

```text
Base
Telegram
VK
MAX
Instagram
```

Если platform override пустой — используется Base.

Если override задан — он хранит свой rich-text document, а не только plain string.

Редактор показывает только те инструменты, которые реально поддерживает конкретная capability.

### Telegram

На текущем Bot API есть entities/parse mode, ссылки, форматирование, link preview options и другие message-level options. Реализация должна компилировать canonical rich text в Telegram entities/caption entities, а не заставлять пользователя вручную экранировать Markdown.

Дополнительные target options могут включать, если подтверждены capability:

- link preview policy;
- silent notification;
- protect content;
- caption placement;
- inline buttons/keyboard;
- spoiler/monospace/underline и другие Telegram marks.

### MAX

Актуальный MAX API поддерживает формат `markdown` или `html` для message body, а также message attachments и inline keyboard. Publikator должен скрывать синтаксис от обычного пользователя и генерировать его из canonical editor document.

Дополнительные target options могут включать:

- notify;
- inline keyboard;
- platform links/mentions;
- quote/highlight/heading — только если capability подтверждена актуальным API.

### VK

VK target editor должен иметь собственный compiler и capability set. Не считать автоматически, что Telegram/HTML semantics работают в VK. Текст, attachments, ссылки, mentions и platform-specific поля проверяются по актуальной документации в момент реализации.

### Instagram

Instagram caption/mentions/hashtags/link behavior обрабатываются отдельным target compiler. Unsupported rich marks должны быть явно показаны как downgraded/removed ещё на preview.

---

## 7. Portable rich-text subset

Чтобы ручной editor, XLSX/CSV, Google Sheets и Integration API использовали один контракт, определить portable subset.

Для таблиц человек вводит нейтральную Markdown-подобную разметку:

```text
**жирный**
_курсив_
~~зачёркнутый~~
`код`
[ссылка](https://example.ru)
> цитата
```

Это НЕ Telegram MarkdownV2 и НЕ MAX Markdown.

Importer сначала парсит portable markup в canonical rich-text AST.

Потом каждый platform compiler делает свой output.

Это убирает проблему platform escaping из Google Sheets/Excel.

---

## 8. Platform preview и downgrade warnings

Перед READY пользователь должен видеть resolved preview.

Например:

```text
Base: Bold + Link + Underline
Telegram: всё поддержано
MAX: всё поддержано
VK: underline будет снят
Instagram: rich formatting будет упрощено
```

Preflight должен различать:

```text
INFO      нормальная трансформация
WARNING   часть оформления будет упрощена
ERROR     публикация невозможна
```

READY блокируется только при ERROR.

---

## 9. Куда публиковать

Выбор площадок должен быть максимально очевидным.

В editor header:

```text
Публиковать в:
☑ Telegram / Основной канал
☑ VK / ASA Lab
☐ MAX / Основной
☑ Instagram / asa.lab

[Выбрать все поддерживаемые]
[Снять все]
```

Если формат несовместим с площадкой, checkbox disabled и рядом причина.

Например:

```text
☐ Instagram / Story — формат не поддержан текущим adapter
```

---

## 10. Project defaults

Для каждого проекта нужны дефолты.

```text
default targets
default timezone
default schedule mode
default publication kind
default content format
default CTA/signature
default hashtags
default source folder
default approval policy
default template
default posting slots
```

Новый пост сразу наследует defaults, но пользователь может изменить их для конкретного post.

Дефолт не должен ретроактивно менять уже созданные публикации.

---

## 11. Templates / Заготовки

Нужна библиотека шаблонов.

### Типы шаблонов

```text
Post template
Story template
Short/Reel template
Campaign template
Snippet
CTA block
Signature block
Hashtag set
```

### Post template

Может содержать:

- project;
- publication kind;
- default targets;
- base structure;
- media placeholders;
- default schedule mode;
- platform overrides;
- CTA;
- internal checklist.

### Поведение

`Создать из шаблона` копирует snapshot шаблона в новый DRAFT.

Изменение template позже не должно тихо менять существующие posts.

Можно добавить явное действие `Reapply template`, показывающее diff.

---

## 12. Draft workflow

Основной human workflow:

```text
IDEA
  ↓
DRAFT
  ↓
IN_REVIEW
  ↓
APPROVED
  ↓
READY
  ↓
SCHEDULED/QUEUE
  ↓
PUBLISHED
```

Действия:

- Save draft;
- Send to review;
- Return to draft;
- Approve;
- Mark READY;
- Publish now;
- Schedule;
- Duplicate;
- Archive;
- Move to Trash.

Для одного администратора review остаётся простым workflow, но модель не должна мешать добавить роли позже.

---

## 13. Editorial notes

Посту нужны внутренние поля, которые никогда не уходят в соцсеть:

```text
internal_title
editor_note
source_note
tags
campaign
owner/assignee (future)
```

Это важно для больших партий AI/Sheets content.

---

## 14. Calendar interactions

Календарь — не read-only.

Должны быть действия:

- click → Content Inspector;
- double-click/Enter → Edit;
- drag-and-drop → изменить publish_at;
- resize/quick edit времени в Week/Day;
- context menu → Edit / Duplicate / Move / Archive / Trash;
- клик по пустому time slot → `Новый пост` с уже заполненной датой/временем;
- multi-select → bulk reschedule/targets/archive.

После drag reschedule:

- сохраняется новое время;
- timezone остаётся явным;
- выполняется conflict check;
- READY публикация повторно проходит schedule validation.

---

## 15. Content Library actions

Grid/List должны иметь bulk actions:

```text
Set project
Set targets
Set schedule mode
Move date/time
Send to review
Approve
Mark READY
Duplicate
Archive
Trash
```

Bulk publish-now требует отдельного подтверждения.

Нельзя массово обходить platform preflight.

---

## 16. XLSX/CSV Template v3

Content Pipeline v2 template расширяется editorial fields.

Рекомендуемые колонки:

| Поле | Назначение |
|---|---|
| `external_id` | стабильный ID |
| `action` | `UPSERT / ARCHIVE / TRASH_REQUEST` |
| `project` | slug проекта |
| `template_key` | optional template |
| `internal_title` | внутреннее название |
| `body` | portable rich text |
| `publication_kind` | FEED/SHORT/STORY |
| `content_format` | IMAGE/CAROUSEL/VIDEO/... |
| `schedule_mode` | MANUAL/AT/QUEUE |
| `scheduled_at` | дата/время |
| `timezone` | timezone |
| `targets` | account aliases |
| `telegram_body` | optional override |
| `vk_body` | optional override |
| `max_body` | optional override |
| `instagram_body` | optional override |
| `media` | filenames/keys/URLs |
| `tags` | internal tags |
| `source_note` | внутренний комментарий |
| `source_revision` | revision источника |

Все текстовые поля используют portable rich-text syntax, не platform markup.

---

## 17. Google Sheets template

Google Sheets template должен быть не пустой таблицей, а готовым рабочим документом.

Предлагаемые листы:

### `Posts`

Основные строки контента.

### `Lists`

Справочники для data validation:

- project slugs;
- account aliases;
- publication kinds;
- schedule modes;
- template keys.

### `Instructions`

Краткая инструкция и примеры portable rich text.

### `Examples`

2–5 демонстрационных строк.

### UX шаблона

- закреплённая header row;
- dropdowns;
- conditional formatting;
- дата/время с понятным timezone;
- пример media filename;
- readonly/write-back колонки визуально отделены.

---

## 18. Google Sheets sync semantics

Google Sheets не становится master database.

Sync выполняется через Preview.

Для каждой строки результат:

```text
NEW
UPDATE
UNCHANGED
CONFLICT
ARCHIVE_REQUEST
TRASH_REQUEST
ERROR
```

### NEW

`external_id` не найден → новый DRAFT.

### UPDATE

Есть imported post, локально после последней sync не менялся → показать diff и применить после подтверждения.

### CONFLICT

Пост после импорта изменён в Publikator и одновременно изменён в Sheet → автоматически не перетирать.

UI предлагает:

```text
Keep Publikator
Use Sheet version
Compare manually
```

### Удаление строки из Google Sheet

Никогда не означает удаление поста.

Для удаления/архивации требуется явное поле `action`.

---

## 19. Write-back в Google Sheets

Опционально Publikator пишет обратно служебные колонки:

```text
publikator_id
sync_status
editorial_stage
publication_state
scheduled_at_actual
last_synced_at
published_at
external_urls
last_error
```

Write-back не является обязательным для runtime.

---

## 20. Integration API v1 — editorial fields

API от бота/AI должен уметь создать не только текст, но полноценный editable draft.

Пример:

```json
{
  "externalId": "asa-2026-09-001",
  "project": "asa-lab",
  "templateKey": "product-update",
  "internalTitle": "Новый модуль электроники",
  "body": "**Новый модуль** уже доступен...",
  "publicationKind": "FEED",
  "contentFormat": "IMAGE",
  "targets": ["telegram-main", "vk-main"],
  "overrides": {
    "telegram-main": "**Telegram версия**..."
  },
  "schedule": {
    "mode": "AT",
    "at": "2026-09-15T10:00:00+03:00"
  },
  "editorialStage": "DRAFT"
}
```

External API по умолчанию не может сразу PUBLISH.

Отдельные scopes:

```text
content:draft:write
content:read
media:write
schedule:write
approval:request
publish:request (future/restricted)
```

---

## 21. Default targets and per-post overrides

На уровне проекта может быть:

```text
Telegram = ON
VK = ON
MAX = OFF
Instagram = ON
```

При создании поста checkbox уже заполнены.

Импорт/API может явно передать targets и тем самым заменить default для конкретного поста.

Если targets не переданы — применяются project defaults.

---

## 22. Platform options model

Не добавлять отдельные случайные колонки в `posts` на каждую новую функцию площадки.

Использовать platform target options DTO/JSON, валидируемый adapter capability.

Пример:

```json
{
  "linkPreview": "auto",
  "notify": true,
  "protectContent": false,
  "buttons": []
}
```

UI генерируется из capability schema target adapter.

Таким образом новая Telegram/MAX/VK опция не ломает canonical post model.

---

## 23. Preflight после изменения

Любое изменение ниже инвалидирует предыдущий successful preflight:

- body/rich text;
- target override;
- media;
- media order;
- platform targets;
- publication kind/format;
- schedule relevant fields;
- platform options.

READY после изменения возвращается в DRAFT/APPROVED согласно editorial policy и требует нового preflight.

---

## 24. Audit events

Редакционные действия должны попадать в audit log отдельно от publication events.

Примеры:

```text
post.created
post.edited
post.rescheduled
post.targets_changed
post.sent_to_review
post.approved
post.moved_to_trash
post.restored
post.archived
template.applied
sheet.sync_update
sheet.sync_conflict
api.draft_created
```

Не хранить в event log секреты/token values.

---

## 25. UX Content Inspector

Content Inspector должен быть основным редакторским элементом.

Структура:

```text
Header
- title
- stage/status
- source
- date/time

Media
- viewer/player

Editor
- Base rich text
- Telegram
- VK
- MAX
- Instagram

Targets
- checkboxes

Schedule
- mode/date/time/timezone

Warnings
- preflight

History
- revisions/events

Actions
- Save
- Review
- Approve
- READY
- Publish now
- Duplicate
- Archive
- Trash
```

Автосохранение допустимо для DRAFT, но явно показывать `Сохранено` / `Есть несохранённые изменения`.

---

## 26. Этапы реализации

### EW4-001 — Safe edit/delete lifecycle

- editorial_stage;
- Archive/Trash/Restore/Permanent delete;
- scheduled content edit;
- READY invalidation;
- audit events.

### EW4-002 — Revision history

- snapshots;
- compare;
- restore previous revision;
- source actor.

### EW4-003 — Canonical rich text editor

- portable editor model;
- toolbar;
- canonical AST;
- plain fallback;
- links/lists/quotes/code.

### EW4-004 — Platform rich-text compilers

- Telegram entities/caption entities;
- MAX markdown/html compiler;
- VK compiler;
- Instagram compiler;
- downgrade warnings.

### EW4-005 — Targets/defaults/platform options

- project default targets;
- checkboxes;
- select-all-supported;
- platform options capability schema;
- per-post override.

### EW4-006 — Templates/snippets

- template library;
- project defaults;
- snippets/CTA/signatures/hashtags;
- snapshot application.

### EW4-007 — Calendar editing

- drag/drop reschedule;
- create from empty slot;
- quick edit;
- bulk operations;
- conflict warnings.

### EW4-008 — XLSX/Google Sheets Template v3

- downloadable XLSX;
- Google Sheets template;
- Lists/Instructions/Examples tabs;
- portable rich text;
- explicit action field;
- sync preview/diff/conflict.

### EW4-009 — Integration API editorial contract

- rich text;
- templateKey;
- targets;
- schedule;
- editorial stage;
- idempotency/revision conflict.

### EW4-010 — Editorial acceptance

Full workflow acceptance on manual + XLSX + Sheets + API sources.

---

## 27. Acceptance scenarios

### Scenario A — manual future post

1. Create post from template.
2. Default TG/VK selected.
3. Add bold/link/quote.
4. Add Telegram override.
5. Schedule tomorrow 10:00.
6. Mark READY.
7. Re-open and change text.
8. READY invalidates.
9. Re-run preflight and approve.
10. Drag to 12:00 in calendar.
11. Calendar updates immediately.

### Scenario B — delete/restore

1. Future READY post in calendar.
2. Move to Trash.
3. It disappears from active calendar/scheduler.
4. Restore it.
5. It returns with media, schedule, targets and revisions intact.

### Scenario C — rich text portability

One canonical document contains bold, italic, underline, link, code and quote.

Preview shows per-platform transformation and warnings.

No platform receives invalid markup.

### Scenario D — Google Sheets 100 rows

- 60 NEW;
- 20 UPDATE;
- 10 UNCHANGED;
- 5 CONFLICT;
- 3 ARCHIVE_REQUEST;
- 2 ERROR.

Preview must classify all 100 before apply.

Repeated sync produces no duplicates.

### Scenario E — local vs sheet conflict

1. Import row `external_id=x`.
2. Edit post locally.
3. Edit same row in Sheets.
4. Sync shows CONFLICT.
5. No automatic overwrite occurs.

### Scenario F — target defaults

Project default: Telegram + VK.

New manual/API/Sheet post without explicit targets gets TG+VK.

One post explicitly chooses only MAX and does not mutate project defaults.

### Scenario G — template snapshot

1. Create post from template v1.
2. Change template to v2.
3. Existing post stays unchanged.
4. New post uses v2.

---

## 28. Что не делать

- не удалять пост по факту удаления строки из Google Sheets;
- не хранить raw platform Markdown как canonical text;
- не разрешать AI/API обходить review/publish policy по умолчанию;
- не смешивать editorial stage с publication state;
- не менять уже опубликованный historical content silently;
- не делать один общий rich-text capability для всех платформ;
- не скрывать platform downgrade от оператора;
- не делать hard delete единственным вариантом удаления.

---

## 29. Связанные планы

Рекомендуемый порядок разработки после publication-core stabilization:

```text
Content Pipeline v2
        ↓
Content Experience v3
        ↓
Editorial Workflow v4
        ↓
Platform live capabilities
        ↓
AI/Sheets/Drive automation
```

Но отдельные foundation-части можно выполнять параллельно:

- Pipeline external_id/media bundle;
- Experience calendar shell;
- Editorial lifecycle/rich text.

Главный UX acceptance: человек должен открыть календарь, выбрать любую будущую публикацию и без технических знаний понять:

1. что именно выйдет;
2. где оно выйдет;
3. когда оно выйдет;
4. как оно будет выглядеть;
5. что можно изменить;
6. что уже согласовано;
7. как перенести, продублировать или удалить будущую публикацию.
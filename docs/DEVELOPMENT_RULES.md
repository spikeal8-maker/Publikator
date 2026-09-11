# Правила разработки Publikator для людей и coding agents

## 0. Главный контракт

Операционный порядок работы coding agent, включая экономию контекста и размер PR, задаёт корневой [AGENTS.md](../AGENTS.md). Его нужно прочитать первым.

Перед любым vNext feature PR разработчик/agent обязан прочитать:

1. [`VNEXT_TECHNICAL_SPEC.md`](VNEXT_TECHNICAL_SPEC.md)
2. [`ARCHITECTURE.md`](ARCHITECTURE.md)
3. соответствующий продуктовый документ Pipeline / Experience / Editorial.

При противоречии главным является `VNEXT_TECHNICAL_SPEC.md`.

Coding agent не имеет права «додумать архитектуру», если нормативное ТЗ задаёт решение.

---

# 1. Цель разработки

Publikator должен оставаться:

- простым;
- диагностируемым;
- воспроизводимым;
- безопасным;
- дешёвым в сопровождении;
- удобным для небольших последовательных PR.

Production runtime — один modular monolith, а не набор сервисов.

---

# 2. Release discipline

```text
release/1.0 = frozen V1 line from v1.0.0-rc.4
main        = vNext development
```

vNext features не вливать в `release/1.0`.

Release fix, сделанный в `release/1.0`, при необходимости forward-port в `main`.

Stable `v1.0.0` выпускается из release line после live acceptance, не из случайного текущего `main`.

---

# 3. Запрещено без ADR

- добавлять n8n;
- добавлять второй backend/worker container;
- Redis/RabbitMQ/Kafka/Celery;
- вторую runtime DB;
- отдельный scheduler service;
- отдельный media transcoding service;
- переносить credentials/API tokens в frontend;
- хранить secrets открытым текстом;
- обходить atomic publication claim;
- автоматически повторять `RECOVERY_NEEDED`;
- возвращать несколько постоянных CI workflows вместо одного Acceptance;
- `TRUST_PROXY=*` / unconditional forwarded-header trust;
- massive refactor «заодно» с feature milestone;
- менять domain invariant без обновления нормативного ТЗ/ADR.

---

# 4. Media invariant: V1 vs vNext

## V1 release line

Текущий RC4 image publisher блокирует READY/publish без изображения. В `release/1.0` это правило сохраняется.

## vNext

Нельзя переносить это правило как вечный product invariant.

vNext поддерживает разные content formats.

Обязательный invariant:

> READY разрешён только если resolved rendition всех выбранных targets проходит capability/preflight.

TEXT_ONLY/VIDEO/STORY могут существовать только после соответствующей capability реализации и tests.

---

# 5. Publication snapshot invariant

Главное правило vNext:

> Publisher никогда не публикует mutable working content.

READY создаёт/фиксирует immutable `ContentRevision`.

`ready_revision_id` и `content_version` должны совпадать с revision, прошедшей preflight.

Начало publication проверяет это атомарно.

PublishInput строится из:

```text
immutable revision
+ target rendition snapshot
+ immutable media order
+ target options snapshot
```

Запрещён паттерн:

```text
read current mutable post
→ потом claim
→ external POST из старого read
```

---

# 6. Target atomic claim invariant

Ни один внешний публичный POST нельзя выполнять до успешного conditional claim.

Существующий принцип сохраняется:

```sql
UPDATE post_targets
SET state='PUBLISHING', ...
WHERE id=?
  AND enabled=1
  AND state IN ('PENDING','RETRY','FAILED');
```

vNext claim дополнительно обязан быть согласован с `ready_revision_id/content_version`.

Конкретная SQL-реализация может быть transaction/EXISTS/CAS, но два конкурентных запуска одного target не могут сделать два external POST.

Dedicated concurrency regression обязателен.

---

# 7. Optimistic editorial concurrency

Любое изменение editable content должно проверять `expectedContentVersion` / ETag.

Если другой browser/API/Sheets sync уже изменил post:

```text
409 CONFLICT
```

Нельзя применять last-write-wins молча.

Это относится к:

- editor save;
- calendar drag;
- bulk actions;
- API update;
- Google Sheets sync;
- target changes;
- media reorder.

---

# 8. Preflight invalidation

Следующие изменения инвалидируют READY/preflight:

- canonical body/rich text;
- platform override/rendition;
- media add/remove/order;
- target selection;
- publication kind/format;
- schedule relevant fields;
- platform options.

Обязательное поведение:

```text
content_version++
ready_revision_id = null
publication status -> DRAFT
new preflight required
```

Нельзя сохранять READY после значимого изменения ради удобства UI.

---

# 9. Recovery invariant

`RECOVERY_NEEDED` означает: внешний результат неизвестен и повтор может создать дубль.

- generic retry запрещён;
- confirm-published не вызывает external POST;
- confirm-not-published требует ручной достоверной проверки;
- preparation и public phase различаются;
- unknown outcome только после операции, которая реально могла создать public artifact.

Для sequence форматов recovery ведётся на уровне `PublicationUnit`, а не слепым retry всей sequence.

---

# 10. Scheduler invariant

Scheduler:

- только определяет due work;
- не является альтернативным publisher;
- не обходит revision/preflight/claim;
- уважает maintenance gate;
- использует durable SQLite state.

QUEUE:

```text
status=READY
schedule_mode=QUEUE
```

Новый код не устанавливает `status=QUEUED`.

Schedule slots сохраняют UNIQUE `(project_id, weekday, time_hhmm, timezone)`.

---

# 11. Timezone rules

Новый AT content хранит:

```text
scheduled_at_utc
schedule_timezone (IANA)
```

Нельзя хранить ambiguous «локальную строку» без timezone.

DST nonexistent time блокируется.

DST ambiguous time требует явного выбора offset/occurrence.

Calendar не вводит собственную независимую временную модель.

---

# 12. DB / migrations

Текущая V1 schema = 3.

Нельзя делать один giant vNext migration.

Schema растёт milestones:

```text
M1 identity/versioning/revisions
M2 rich text/renditions/templates
M3 rich media/publication units
M4 integrations/connectors
```

Каждый transition:

- deterministic;
- tested from exact previous schema;
- сохраняет старые posts/events/targets;
- выставляет `PRAGMA user_version` только после успешной migration;
- newer DB blocks older binary;
- имеет backup/migrate/restore regression.

Нельзя удалять/пересоздавать historical publication data ради упрощения migration.

---

# 13. Ingestion security

## ZIP

До extraction/apply обязательны:

- path traversal rejection;
- absolute path rejection;
- symlink/device rejection;
- file count limit;
- compressed/expanded size limits;
- compression ratio limit;
- MIME sniffing;
- filename normalization;
- temp cleanup.

## Remote URL

Connector не является unrestricted proxy.

Обязательно:

- HTTPS by default;
- DNS/IP validation;
- block localhost/private/link-local/metadata/reserved ranges;
- validate every redirect;
- limit redirects;
- stream size limit;
- timeout;
- MIME verification.

Нельзя разрешать `file://`, arbitrary internal URL или cloud metadata endpoint.

---

# 14. Rich text security

Canonical text = validated AST allowlist.

Запрещено сохранять и напрямую рендерить arbitrary HTML.

Links проходят protocol/URL validation.

Preview renderer escape-ит output.

Platform compilers сами экранируют platform markup.

CSV/XLSX export защищается от formula injection.

---

# 15. Integration API keys

External agent key:

- random >=256-bit;
- показывается полностью один раз;
- в DB хранится hash, не plaintext;
- имеет prefix/display name/scopes;
- revoke/rotate;
- rate limit;
- audit.

External API default permission — DRAFT creation, не direct publish.

---

# 16. Connector credentials

Google/Yandex OAuth tokens и подобные reusable secrets:

- encrypt AES-256-GCM;
- APP_MASTER_KEY;
- minimum scopes;
- не логировать;
- не отдавать назад в UI;
- revoke/reconnect workflow.

---

# 17. Platform capability ownership

Platform rules принадлежат adapter layer.

UI получает capability/schema от backend.

Нельзя хардкодить independent duplicate limits в frontend.

Новую platform capability включать только после:

1. актуальной official API verification;
2. adapter regression;
3. preflight test;
4. live acceptance для stable capability.

---

# 18. Video scope discipline

Первый video milestone:

```text
MP4 / H.264 / AAC-or-none
ffprobe metadata
ffmpeg poster
```

Другие codecs/container reject с понятной ошибкой.

Не добавлять transcoding farm или автоматический arbitrary conversion без ADR.

ffmpeg/ffprobe работают в том же production container.

Обязательны upload/temp/processing limits и cleanup.

---

# 19. Google Sheets sync

Google Sheets не master DB.

Удаление row не удаляет post.

Для mutation требуется явный `action`.

UPDATE автоматически допускается только если local content не изменился после последнего import.

Иначе `CONFLICT` и ручной выбор.

Нельзя делать source-wins silent overwrite.

---

# 20. Content Plan compatibility

`CONTENT_PLAN.md` schema 1 = V1 contract.

vNext public import contract начинается сразу с schema 3.

Публичную schema 2 не выпускать.

Новые endpoints versioned `/api/content-plan/v3/...`.

Старые endpoints не менять скрытно.

---

# 21. Backup / restore invariant

Любая новая сущность должна переживать canonical full backup/restore.

Нельзя считать feature DONE, если после restore потерялись:

- revisions;
- templates;
- renditions;
- source bindings;
- integration key hashes;
- publication units;
- connector encrypted state.

Temporary processing files в backup не входят.

---

# 22. Coding-agent экономичность

Каждая задача должна быть минимальным завершённым vertical slice.

Agent обязан:

1. сначала читать relevant spec/issue;
2. назвать изменяемые модули;
3. не переписывать соседние подсистемы без необходимости;
4. не добавлять новую инфраструктуру «на будущее»;
5. переиспользовать существующий publisher/media/backup/runtime gate;
6. писать focused regression до/вместе с implementation;
7. обновлять документацию только там, где меняется контракт.

Запрещены PR вида «рефакторинг всего проекта перед маленькой функцией».

Предпочитать additive migration и узкий PR большому rewrite.

---

# 23. Module ownership

- `src/platforms/*` — API/capability/error semantics платформ;
- `src/publisher.ts` — orchestration/claim/retry/recovery;
- `src/scheduler.ts` — due selection;
- `src/http/*` — HTTP auth/validation/application entrypoints;
- `src/db.ts` + migrations — persistence primitives;
- `src/media.ts` — existing image pipeline;
- `src/content/*` — vNext content/revisions/renditions;
- `src/editorial/*` — lifecycle/templates;
- `src/ingestion/*` — bulk/source import;
- `src/integrations/*` — API keys/connectors;
- `src/backups*` — canonical backup/restore.

Platform API calls не должны появляться в calendar/importer/editor code.

---

# 24. CI

Один workflow:

```text
.github/workflows/publikator-ci.yml
Publikator CI / Acceptance
```

Большие scenarios — `scripts/*-e2e.*`.

Новые milestones расширяют существующий Acceptance.

Минимальные vNext regressions по мере появления функций:

- content-version concurrency;
- immutable publication revision;
- preflight invalidation;
- schema migration;
- ZIP security;
- SSRF;
- rich text sanitization/compilers;
- import idempotency/conflict;
- timezone/DST;
- story publication-unit recovery;
- backup/restore.

---

# 25. Definition of Done

Feature считается DONE только если:

- backend contract реализован;
- UI не имеет отдельной противоречащей бизнес-логики;
- migration есть и протестирована;
- concurrency path безопасен;
- security path закрыт;
- audit/diagnostics дают расследовать ошибку;
- backup/restore сохраняет state;
- focused regression в Acceptance;
- docs/spec синхронизированы.

`UI выглядит работающим` не является Definition of Done.

---

# 26. Merge discipline

Перед merge любого feature PR:

```text
Publikator CI / Acceptance = PASS
```

Не merge-ить одновременно несколько PR, меняющих одну и ту же schema/state machine без последовательной rebasing/validation.

Domain invariant меняется только отдельным ADR/spec update, а не скрытым code patch.
# Правила разработки для людей и coding agents

## Главная цель

Сохранять Publikator простым, диагностируемым, воспроизводимым и дешёвым в сопровождении. Production runtime — один модульный монолит, а не набор связанных сервисов.

## Запрещено без ADR

- добавлять n8n;
- добавлять второй backend/worker-контейнер;
- добавлять Redis, RabbitMQ, Kafka, Celery и подобную инфраструктуру;
- добавлять вторую runtime-БД;
- переносить credentials в frontend, таблицы, GitHub или незашифрованные поля SQLite;
- обходить invariant «нет изображения — нет READY/публикации»;
- автоматически повторять `RECOVERY_NEEDED`;
- смешивать platform API с общим scheduler/UI;
- удалять `package-lock.json`;
- использовать `npm install` вместо `npm ci` в production/acceptance;
- применять `npm audit fix --force` без анализа;
- возвращать несколько независимых push/PR GitHub Actions workflows вместо одного `Publikator CI / Acceptance`;
- включать `trustProxy=true`, `TRUST_PROXY=*` или иное безусловное доверие forwarded headers;
- передавать release SHA как свободно изменяемую production runtime identity вместо baked Docker revision.

## Критический publication invariant

**Ни один внешний публичный POST нельзя выполнять до успешного atomic claim target.**

Допустимый переход:

```sql
UPDATE post_targets
SET state='PUBLISHING', ...
WHERE id=?
  AND enabled=1
  AND state IN ('PENDING','RETRY','FAILED');
```

Только `changes === 1` даёт право вызвать внешний API.

Запрещено:

```text
SELECT state
→ обычный UPDATE PUBLISHING
→ external POST
```

потому что два конкурентных запроса могут оба пройти такой check.

Любое изменение publisher/retry/scheduler обязано сохранять regression `scripts/publication-concurrency-e2e.mjs`: два конкурентных запуска одного target → **ровно один** вызов external publisher и `attempts === 1`.

## Recovery invariant

`RECOVERY_NEEDED` означает: повтор всего target может создать дубль или усугубить уже частично выполненную публикацию.

- generic retry не сбрасывает `RECOVERY_NEEDED`;
- `confirm-published` и `confirm-not-published` используют conditional state transition;
- ручное подтверждение найденной публикации не вызывает новый external POST;
- platform adapter обязан различать preparation/local phase и public phase.

Если операция физически не могла создать публичный пост, она не должна без причины становиться `outcomeUnknown=true`.

## Scheduler invariant

- одинаковые slots `(project_id, weekday, time_hhmm, timezone)` запрещены на уровне SQLite UNIQUE, а не только UI/API;
- миграция обязана безопасно обрабатывать старые дубли;
- `QUEUE_SLOT_GRACE_MINUTES` не должен приводить к stale публикации после закрытия occurrence;
- scheduler не обходит atomic publication claim.

## Browser security invariant

Browser mutation `POST/PUT/PATCH/DELETE /api/*` с заголовком `Origin` разрешается только для точного same-origin.

`/public-media/*` намеренно доступен cross-origin, потому MAX/Instagram должны получать изображения извне. Это исключение нельзя распространять на API или интерфейс.

За reverse proxy реальный IP клиента учитывается только через explicit `TRUST_PROXY` list. Wildcard trust запрещён.

## Зависимости и release identity

- `package.json` и `package-lock.json` меняются вместе;
- direct dependency update проходит `npm audit --omit=dev --audit-level=high`;
- high/critical production vulnerability блокирует release;
- Docker base остаётся pinned по digest;
- release build получает SHA через `BUILD_SHA` во время `docker build`;
- Docker сохраняет SHA как `IMAGE_BUILD_SHA` и `org.opencontainers.image.revision`;
- production Release gate сравнивает live acceptance с baked revision;
- изменение Docker base/digest требует отдельного security review и полного acceptance.

## Границы модулей

- `src/platforms/*` — только детали внешних API и их phase/error semantics;
- `src/publisher.ts` — publication orchestration, atomic claim, retry/recovery policy;
- `src/scheduler.ts` — определение due work, не альтернативный publisher;
- `src/http/*` — HTTP validation/security/application calls;
- `src/db.ts` — schema/migrations/base DB primitives;
- `src/media.ts` — нормализация и local media storage;
- `src/backups.ts` / `src/backup-format.ts` — canonical full backup/restore;
- `scripts/*-e2e.*` — regression scenarios, вызываемые единым CI.

## CI

В `.github/workflows` должен оставаться один постоянный workflow:

```text
publikator-ci.yml
```

Большие тесты хранятся в `scripts/`, а не как сотни строк shell внутри YAML.

Перед merge обязателен:

```text
Publikator CI / Acceptance = PASS
```

Он должен включать как минимум:

- exact `npm ci`;
- strict TypeScript + build;
- frontend syntax;
- production dependency audit;
- schema/migration tests;
- HTTP + security tests;
- concurrency test;
- four platform adapter tests;
- content-plan test;
- backup/release-gate tests;
- production Docker build identity;
- full backup/restore restart smoke.

Новый отдельный workflow для очередной функции **не добавлять**: добавляйте новый именованный step/script в существующий acceptance.

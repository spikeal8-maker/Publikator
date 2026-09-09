# Архитектура Publikator

## Решение

Publikator — модульный монолит. В production запускается один Node.js-процесс в одном Docker-контейнере. Он одновременно обслуживает Web UI, REST API, SQLite, встроенный scheduler, локальное медиахранилище и адаптеры соцсетей.

```text
Browser
  │
  ▼
Fastify ── Web UI / REST API
  │
  ├── SQLite (WAL)
  ├── data/media
  ├── Scheduler
  └── Platform adapters
       ├── Telegram Bot API
       ├── VK API
       ├── MAX Bot API
       └── Instagram Graph API
```

## Неподвижные архитектурные правила

1. n8n запрещён.
2. Redis, RabbitMQ, Kafka и другие внешние очереди запрещены без отдельного ADR.
3. Нельзя выносить scheduler или адаптеры площадок в отдельные сервисы без доказанной необходимости.
4. Публикация без хотя бы одного изображения запрещена на уровне backend.
5. Состояние хранится отдельно для каждой пары `post + social_account`.
6. После падения процесса цель, находившаяся в `PUBLISHING`, переводится в `RECOVERY_NEEDED` и не повторяется автоматически: внешний API мог успеть принять публикацию.
7. Токены соцсетей не хранятся в открытом виде. Используется AES-256-GCM и `APP_MASTER_KEY`.
8. `data/` является переносимым состоянием инсталляции и монтируется как Docker volume.

## Состояния

Пост: `DRAFT → READY → PUBLISHING → PUBLISHED/PARTIAL/FAILED`.

Цель площадки: `PENDING → PUBLISHING → PUBLISHED` либо `RETRY → FAILED`. После неопределённого падения: `RECOVERY_NEEDED`.

## Scheduler

Есть два автоматических режима:

- `AT`: точная дата/время в UTC (`scheduled_at`);
- `QUEUE`: пост попадает в очередь проекта и забирается ближайшим `schedule_slot` (день недели + локальное время + IANA timezone).

Scheduler работает внутри процесса и использует SQLite как durable state.

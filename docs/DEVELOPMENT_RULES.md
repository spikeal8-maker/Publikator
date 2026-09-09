# Правила разработки для людей и coding agents

## Главная цель

Сохранять проект простым, диагностируемым и дешёвым в сопровождении.

## Запрещено без ADR

- добавлять n8n;
- добавлять второй backend/worker-контейнер;
- добавлять Redis, RabbitMQ, Kafka, Celery и подобную инфраструктуру;
- добавлять вторую базу данных;
- переносить токены в frontend, Google Sheets, GitHub или незашифрованные поля SQLite;
- обходить invariant «нет изображения — нет READY/публикации»;
- автоматически повторять `RECOVERY_NEEDED`;
- смешивать API конкретной соцсети с общим scheduler/UI.

## Границы модулей

- `src/platforms/*` — только детали внешних API.
- `src/publisher.ts` — orchestration одной публикации и retry policy.
- `src/scheduler.ts` — только определение того, что пора запускать.
- `src/http/*` — валидация HTTP и вызов application services.
- `src/db.ts` — schema/migration и базовые DB primitives.
- `src/media.ts` — нормализация и локальное хранение изображений.

## Перед merge

Минимальный gate: `npm run typecheck`, `npm run build`, сборка Docker image, smoke-test `/api/health`. Изменение API площадки должно сопровождаться ссылкой на актуальную официальную документацию в PR.

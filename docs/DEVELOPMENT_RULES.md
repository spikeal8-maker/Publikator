# Правила разработки для людей и coding agents

## Главная цель

Сохранять проект простым, диагностируемым, воспроизводимым и дешёвым в сопровождении.

## Запрещено без ADR

- добавлять n8n;
- добавлять второй backend/worker-контейнер;
- добавлять Redis, RabbitMQ, Kafka, Celery и подобную инфраструктуру;
- добавлять вторую базу данных;
- переносить токены в frontend, Google Sheets, GitHub или незашифрованные поля SQLite;
- обходить invariant «нет изображения — нет READY/публикации»;
- автоматически повторять `RECOVERY_NEEDED`;
- смешивать API конкретной соцсети с общим scheduler/UI;
- удалять `package-lock.json` или возвращать production/CI установку зависимостей с `npm ci` на плавающий `npm install`;
- менять production dependency без проверки совместимости и `npm audit --omit=dev --audit-level=high`.

## Воспроизводимые зависимости

- `package.json` и `package-lock.json` изменяются вместе и коммитятся в одном PR.
- Docker и все acceptance workflows устанавливают зависимости через `npm ci`.
- `package-lock.json` является частью release identity вместе с Git commit SHA.
- Любое обновление direct dependency должно пройти все существующие CI, включая production Docker/media/backup/restore сценарий.
- High/critical production vulnerability блокирует release. Исправление не выполняется вслепую через `npm audit fix --force`: сначала анализируется затронутый direct/transitive package и безопасная patched version.
- `Dependency security CI` должен оставаться read-only; ему не нужны write permissions к репозиторию.

## Границы модулей

- `src/platforms/*` — только детали внешних API.
- `src/publisher.ts` — orchestration одной публикации и retry policy.
- `src/scheduler.ts` — только определение того, что пора запускать.
- `src/http/*` — валидация HTTP и вызов application services.
- `src/db.ts` — schema/migration и базовые DB primitives.
- `src/media.ts` — нормализация и локальное хранение изображений.

## Перед merge

Минимальный gate: `npm ci`, `npm run typecheck`, `npm run build`, `npm audit --omit=dev --audit-level=high`, сборка Docker image и smoke-test `/api/health`. Изменение API площадки должно сопровождаться ссылкой на актуальную официальную документацию в PR.

# Publikator

Единая self-hosted система автопубликации контента в **Telegram, VK, MAX и Instagram**.

Publikator специально построен как **модульный монолит**: один репозиторий, один Docker-контейнер, один интерфейс, одна SQLite-база и встроенный scheduler. n8n, Redis, RabbitMQ и отдельный worker не нужны.

## Что уже реализовано

- Web UI с авторизацией;
- проекты и контент;
- обязательное изображение перед переводом поста в `READY`;
- загрузка изображений, нормализация в JPEG и локальное хранение;
- подключения Telegram / VK / MAX / Instagram с шифрованием credentials AES-256-GCM;
- отдельный статус публикации для каждой площадки;
- ручная публикация;
- публикация по точной дате (`AT`);
- проектная очередь публикаций (`QUEUE`) со слотами по дням недели и timezone;
- retry policy для временных ошибок;
- `RECOVERY_NEEDED` после аварийной остановки во время внешнего POST — автоматического дубля не будет;
- журнал событий;
- SQLite backups;
- Docker deployment.

## Быстрый запуск

```bash
cp .env.example .env
```

Задайте как минимум:

```env
PUBLIC_BASE_URL=https://publisher.example.ru
ADMIN_PASSWORD=very-strong-admin-password
APP_MASTER_KEY=very-long-random-secret-at-least-32-characters
```

Затем:

```bash
docker compose up -d --build
```

Интерфейс по умолчанию: `http://localhost:8080`.

> Для MAX и Instagram `PUBLIC_BASE_URL` должен быть реальным публичным HTTPS-адресом: внешняя площадка должна суметь скачать изображение из `/public-media/...`.

## Данные

Весь переносимый runtime state лежит в `./data`:

```text
data/
  publikator.sqlite
  media/
  backups/
```

Для переноса инсталляции остановите контейнер и перенесите `data/` вместе с тем же `APP_MASTER_KEY`.

## Параметры площадок

См. [`docs/PLATFORMS.md`](docs/PLATFORMS.md).

## Архитектура

См. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) и обязательные правила для coding agents в [`docs/DEVELOPMENT_RULES.md`](docs/DEVELOPMENT_RULES.md).

## Важное ограничение v0.1

Instagram пока публикует ровно одно изображение. Telegram поддерживает до 10 изображений, MAX — до 12; VK загружает все изображения поста последовательно.

# Publikator

Единая self-hosted система автопубликации контента в **Telegram, VK, MAX и Instagram**.

Publikator специально построен как **модульный монолит**: один репозиторий, один Docker-контейнер, один интерфейс, одна SQLite-база и встроенный scheduler. n8n, Redis, RabbitMQ и отдельный worker не нужны.

## Что уже реализовано

- Web UI с авторизацией и ограничением перебора пароля;
- проекты и независимые контентные очереди;
- создание и редактирование публикаций;
- явный выбор конкретных подключённых соцсетей для каждого поста;
- обязательное изображение перед переводом поста в `READY`;
- загрузка изображений, нормализация в JPEG и локальное хранение;
- нормальные формы подключения Telegram / VK / MAX / Instagram без ручного JSON;
- проверка токена, назначения и доступных прав через официальные API до сохранения подключения;
- шифрование credentials AES-256-GCM;
- отдельный статус публикации для каждой площадки;
- ручная публикация;
- публикация по точной дате (`AT`);
- проектная очередь публикаций (`QUEUE`) со слотами по дням недели и timezone;
- retry только для явно временных API-ошибок;
- `RECOVERY_NEEDED` при неопределённом результате внешнего POST — автоматического дубля не будет;
- запрет изменения текста, площадок и медиа после частичной публикации;
- журнал событий;
- SQLite backups;
- Docker HEALTHCHECK;
- CI проверяет компиляцию, frontend JS, Docker build и полный smoke-flow `login → account → post → media → READY`;
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

## Важное ограничение текущей версии

Instagram пока публикует ровно одно изображение. Telegram поддерживает до 10 изображений, MAX — до 12; VK загружает все изображения поста последовательно.

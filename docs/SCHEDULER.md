# Scheduler Publikator

Scheduler является частью того же Node.js процесса Publikator. Отдельный cron/worker/Redis не используется.

## AT

`AT` выбирает `READY` посты с `scheduled_at <= текущее время`.

Если после перевода в `READY` публикация стала невозможна до момента запуска (например, выбранный аккаунт отключён), scheduler записывает `scheduler_publish_blocked` и переводит пост из `READY` в `FAILED`. Это намеренно прекращает повтор одного и того же заведомо заблокированного запуска каждые `SCHEDULER_INTERVAL_MS`.

После исправления причины оператор редактирует/проверяет пост и снова переводит его в `READY`.

## QUEUE

У каждого project slot есть локальные weekday/time/timezone и `last_fired_on`.

По умолчанию после времени слота действует окно:

```env
QUEUE_SLOT_GRACE_MINUTES=60
```

В пределах окна:

- краткий restart/maintenance не теряет публикацию;
- если в момент слота очередь пуста, occurrence остаётся открытым;
- если `READY + QUEUE` пост появляется позже, но ещё внутри окна, он публикуется;
- окно может корректно перейти через локальную полночь, при этом `last_fired_on` хранит дату исходного occurrence.

После завершения окна неиспользованный occurrence закрывается и журналируется как `queue_slot_missed`. Поздний пост не публикуется задним числом через много часов: он ждёт следующего слота.

`QUEUE_SLOT_GRACE_MINUTES=0` оставляет только точную минуту. Максимально разрешено 1440 минут.

## Повторы target

Target со статусом `RETRY` обрабатывается отдельно по `next_attempt_at`. `RECOVERY_NEEDED` scheduler автоматически не повторяет.

## Maintenance

Во время backup/restore/import maintenance scheduler не начинает новую работу. После выхода из maintenance QUEUE может догнать слот, если occurrence ещё находится в grace-window.

# Scheduler Publikator

Scheduler является частью того же Node.js процесса Publikator. Отдельный cron/worker/Redis не используется.

## AT

`AT` выбирает `READY` посты с `scheduled_at <= текущее время`.

Если после `READY` публикация стала невозможна до момента запуска, scheduler записывает `scheduler_publish_blocked` и переводит пост из `READY` в `FAILED`. Это прекращает бесконечный повтор одной и той же блокировки каждые `SCHEDULER_INTERVAL_MS`.

После исправления причины оператор снова проверяет пост и переводит его в `READY`.

## QUEUE

У каждого project slot есть:

```text
project_id
weekday
time_hhmm
timezone
last_fired_on
```

SQLite schema v3 физически запрещает два одинаковых slot:

```text
UNIQUE(project_id, weekday, time_hhmm, timezone)
```

API также возвращает `409` при попытке создать точный дубль.

При migration v2→v3 старые дубли схлопываются до одного deterministic slot. Если у дублей различается `last_fired_on`, сохраняется наиболее поздняя дата, чтобы migration не создала повтор уже отработанного occurrence.

## Grace window

По умолчанию после времени slot действует:

```env
QUEUE_SLOT_GRACE_MINUTES=60
```

В пределах окна:

- краткий restart/maintenance не теряет публикацию;
- если в момент slot очередь пуста, occurrence остаётся открытым;
- если `READY + QUEUE` пост появляется позже внутри окна, он публикуется;
- окно может перейти через локальную полночь, а `last_fired_on` хранит дату исходного occurrence.

После окна неиспользованный occurrence закрывается один раз событием `queue_slot_missed`. Поздний пост не публикуется задним числом.

`QUEUE_SLOT_GRACE_MINUTES=0` означает только точную минуту. Максимум: `1440`.

## Atomic publication claim

Scheduler **не владеет альтернативным publish-механизмом**. Он вызывает тот же publisher, что ручной UI.

Перед внешним POST target атомарно переводится в `PUBLISHING` только из claimable state:

```text
PENDING / RETRY / FAILED
```

Если manual publish, другой scheduler tick или stale retry уже захватил target, второй вызов прекращается до внешнего API. Это защищает от дублей при пересечении scheduler и ручной публикации.

## Повторы target

`RETRY` выбирается по `next_attempt_at`. Повтор также проходит atomic claim.

`RECOVERY_NEEDED` scheduler автоматически **никогда** не повторяет.

## Maintenance

Во время backup/restore/import maintenance scheduler не начинает новую работу. После выхода из maintenance QUEUE может догнать slot, только если occurrence ещё находится в grace-window.

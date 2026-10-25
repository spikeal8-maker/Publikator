# A0c — воспроизводимая проверка аварий, квот и восстановления

**Машинная матрица:** [agent-fault-matrix.v1.json](agent-fault-matrix.v1.json) — 14 обязательных deterministic failpoints.  
**Статус:** `DESIGN_NOT_IMPLEMENTED`; тесты A5/A8 ещё не написаны. Эта страница не выдаёт статическое прохождение CI за реальное исполнение fault-injection.

## Изоляция тестов

Test harness запускает реальный Publikator `buildApp`/scheduler/publisher **только в отдельном временном процессе**, с временным SQLite и медиапапкой; входящие fake VK/Telegram/MAX adapters фиксируют every external request (ID, target, revision digest, idempotency key) без реального сетевого доступа наружу. Provider simulator имеет контролируемое решение «получил POST», «вернул success», «отключился после приёма». CI по умолчанию закрывает исходящий интернет.

В каждом тесте:
1. Создать synthetic `AgentPrincipal` с явным grant, synthetic owner approval и известными credential fingerprints — всё без настоящих секретов.
2. Получить durable receipt, record `jobId`, `postId`, immutable revision digest, target list, media SHA и audit event sequence.
3. Принудительно остановить/перезапустить runtime **в точной фазе**, указанной `cutPoint` в JSON; это не имитация исключением до внешнего вызова, если необходим provider-received-but-response-lost.
4. Восстановить ту же SQLite и canonical media из persistent volume либо backup fixture.
5. Сравнить SQLite state before/after, provider fake request log, authorization/grantVersion, quota reservations, target result IDs и событие `RECOVERY_NEEDED`.
6. Повторить тот же client idempotency key/payload; проверить no duplicate send, а другой payload с тем же key → 409.
7. Отдельно выполнить тест инвариантов: deny при отозванном доступе, запрос без consent, неверный accountId, неактивный provider capability, 2 конкурентных агентов.

## Приёмочные инварианты

- Атомарность коротких SQLite транзакций, `no DB lock` на время HTTP.
- Не более одной **автоматической** попытки внешней отправки для идентичного target/revision, если провайдер не доказал собственную идемпотентность.
- `UNKNOWN` не означает `FAILED` и не разрешает автоматический повтор; `RECOVERY_NEEDED` остаётся до reconciliation.
- Один успешный target не перезапускается после восстановления второго.
- Новые claims не проходят после committed revoke/pause/expiry/credential change; уже admitted request может завершиться — без ложного «отменено».
- Квота в локальном IANA timezone и при DST сохраняется в SQLite. `Unknown outcome` не возвращает quota автоматически.
- Данные, журналы и approvals в backup/restore сохраняются. Секреты никогда не попадают в CI logs или fake provider request fixtures.

## Срезы разработки

| Checkpoint | Что реализует |
|---|---|
| A1 | короткие grant/pause/revoke transactions и точную модель token/authorization |
| A2 | durable `AgentOperationReceipt` и idempotent `jobId` / operation queries |
| A4 | reversible media import, canonical SHA и порядок изображений |
| A5a/A7a | owner approval с immutable intent/revision/recipients/time |
| A5b | execution claim/quota, provider unknown outcome и replay isolation |
| A8 | все 14 аварийных сценариев, real Docker restart/restore, отдельная live-provider приёмка |

**Релизное доказательство:** конкретный exact SHA, fake-provider request count, sanitized SQLite/media hashes и независимое review. Одни отметки в данном списке ничего не доказывают.

Источник технических решений: [ADR_AGENT_CLAIM_AND_QUOTA.md](../ADR_AGENT_CLAIM_AND_QUOTA.md); безопасность медиа: [ADR_AGENT_MEDIA_PUBLICATION.md](../ADR_AGENT_MEDIA_PUBLICATION.md).

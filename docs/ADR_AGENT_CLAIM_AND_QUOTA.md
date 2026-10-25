# ADR-AGENT-CLAIM-003 — подтверждение, квоты, конкурентная отправка и безопасное восстановление

**Статус:** A0c planned contract; runtime not implemented. Parent [#174](https://github.com/spikeal8-maker/Publikator/issues/174), #179, #182.  
**Инвариант:** agent-managed publication cannot reach external provider without an immutable owner-authorized intent **checked again at target execution claim**. Отправка в несколько аккаунтов учитывается независимо по каждому target.

## 1. Нельзя принимать READY как разрешение

В прежнем коде `markReadyRevision()` выставляет `READY` вместе с `APPROVED`, а `schedulerTick()` исполняет `AT/QUEUE`. Это легитимный owner/manual lifecycle, но не доказательство согласия владельца на публикацию **агентом**.

Контрольный объект `PublicationIntent`: `intentId`, `agentId`, `postId`, `contentVersion`, ready revision ID, digest canonical rich/plain content + ordered media + target account IDs + overrides, scheduled UTC instant + IANA timezone, credential/capability/destination fingerprints, grantVersion, owner approval/policy version, expiry, idempotency/operation receipt, fixed target-level statuses. Отдельное owner confirmation не может быть инициировано самим ботом. Перемена любого material параметра требует нового preflight/consent и invalidation старого intent.

## 2. Атомарная точка допуска (не обещать отмену уже отправленного POST)

Перед отправкой каждого target в краткой SQLite транзакции:
1. прочитать актуальные `AgentGrant` и разрешённую политику; проверить agent ACTIVE, scopes, exact accounts/project/source, `PublicationIntent` status, content digest, credential/capability fingerprint, expiration, target not already claimed/complete;
2. проверить расписание, действующий owner approval либо отдельную `PREAPPROVED_POLICY`, соответствие времени, формата и лимитов;
3. **атомарно** зарезервировать durable quota unit и publication target claim, increment/witness `grantVersion`+`policyVersion` и audit/operation receipt; commit;
4. после commit, перед сетью, выполнить повторную best-effort invalidation/credential check, не открывая долгую транзакцию через HTTP;
5. external provider POST выполняется только для successfully claimed target; result и external ID/link сохраняются, при unknown outcome → `RECOVERY_NEEDED`.

**Точка линейности:** `execution claim COMMIT`. Если owner revoke/pause/grant reduction или отключение аккаунта committed **до него**, claim отказывается. Если revoke произошло **после** claim, не обещать физически отменить уже доставленный/in-flight провайдеру POST: логировать `IN_FLIGHT`, по возможности abort до dispatch и затем reconcile. Прямая ручная публикация owner с тем же target не должна игнорировать уже committed immutable provider claim; общий publisher сохраняет защиту от дублей.

**Квоты:** не использовать in-memory 60/min Integration API limiter как дневную публикационную квоту. SQLite quota reservations per effective owner/policy/agent/project/account/local IANA day + UTC window. Согласовать семантику `dailyMax`: для multi-target quota unit = **каждая попытка по отдельному аккаунту**, дополнительный aggregate limit через явно отдельную owner policy. Переход дня по IANA timezone должен учитывать DST (не «UTC+3 навсегда»). Unknown outcome не возвращает резерв до доказанного reconciliation. При отмене до выполнения — атомарная reversal reservation с audit, без корректировки уже начатой внешней отправки.

## 3. Durable receipts/recovery

Каждая мутирующая Agent операция требует `Idempotency-Key`, keyed by agentId + operation + logical resource + canonical payload hash. Same key/payload после restart возвращает тот же jobId/result; reused key with different payload → 409 и 0 side effects. Перед API 202 durable receipt уже в SQLite.

**Невозможность exactly-once:** HTTP ответ от VK/Telegram/MAX может потеряться после фактического успешного provider POST. Если провайдер **не** даёт доказанного idempotency, агент не совершает автоматически повторный POST для того же target/revision. `RECOVERY_NEEDED` → operator inspection/провайдерская reconciliation, без ложного `PUBLISHED`. Подтверждённые target не повторять при частично успешной рассылке.

**Crash failpoints** (после restart восстановить SQLite, media, журнал и provider fake-call log):
- before/after durable operation receipt commit;
- during source media write/hash linking;
- before/after owner approval commit;
- after scheduler selects due post but before agent claim;
- after claim+quota commit before network;
- provider received request but response lost;
- provider response success before DB PUBLISHED;
- between two targets when first is PUBLISHED, second not yet claimed;
- immediately after revoke COMMIT;
- after DB backup capture before test restore.

## 4. Требования к наблюдаемости

В каждую critical транзакцию писать server-authored AgentActivityEvent в **тот же SQLite**: actor, request/operation/job/post/intent/target, safe stage, result, errorCode, grantVersion, timestamp, redacted summary. Owner показывает genuine queue/current/partial/recovery, never model thoughts. Ни токены, ни plaintext provider responses, ни произвольные prompts не попадают в event storage.

Если критичный audit commit не может быть выполнен — опасную операцию fail-closed. Не ложно объявлять `100%`, если total невозможно измерить.

## 5. Интеграционная матрица проверки

| Gate | Сценарий | Ожидаемый результат |
|---|---|---|
| CLAIM-01 | агентская READY/APPROVED без отдельного owner intent | 0 provider POST |
| CLAIM-02 | exact consent + immutable digest/targets/schedule | только выбранные target calls |
| CLAIM-03 | старое consent после изменения текста, фото/order, recipients или credentials | fail closed |
| CLAIM-04 | два агента одновременной отправки того же target/revision | один external attempt |
| CLAIM-05 | revoke committed до claim | ни одного нового claim |
| CLAIM-06 | revoke после уже admitted request | status IN_FLIGHT/reconciliation, без фиктивного rollback |
| CLAIM-07 | timeout после provider accepted | RECOVERY_NEEDED, 0 automatic retry |
| CLAIM-08 | первый target succeeded, второй unknown | PARTIAL, сохраняются external ID/link первого |
| CLAIM-09 | quota на границе IANA дня/DST | предсказуемый дневной лимит без превышения |
| CLAIM-10 | запрет релиза по неверным/expired credentials | 0 provider POST даже при `publish:request` scope |
| CLAIM-11 | same idempotency key → restart → retry | тот же durable receipt/job, 0 extra POST |
| CLAIM-12 | restore from canonical backup | сохранились provenance/grant/consent/claim/unknown outcomes; signing keys not leaked |

**Acceptance делится:** fake provider и deterministic SQLite fault harness в canonical CI; реальное тестовое сообщество только после owner approval на точную публикацию. Наличие `200 OK` от MCP не считается выполнением этих правил.

**Status:** decision recorded, no runtime implementation. Machine-readable failpoints in `docs/contracts/agent-fault-matrix.v1.json` и script A0c должны проверить полноту набора перед A5b.

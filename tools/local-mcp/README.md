# Publikator Local MCP — ограниченный локальный режим (MCP-LOCAL-001)

Необязательный MCP **stdio**-адаптер к существующему `/api/integration/v1`. Использует официальные pinned SDK v2.0.0 и Zod 4.2.0. **Это не remote MCP для ChatGPT, не OAuth и не независимая per-agent модель прав.**

## Инструменты

| Tool | Возможности |
| --- | --- |
| `get_connection_status` | Проверка локального API |
| `list_drafts` | Список черновиков trusted Integration namespace |
| `get_draft` | Чтение черновика по точному ID |
| `create_text_draft` | Только TEXT_ONLY DRAFT, без получателей и расписания; idempotencyKey обязателен |

Нет инструментов публикации, READY, расписания, изменения соцсетей/ключей, доступа к файловой системе, shell, SQL или сетевого proxy. Список возвращаемых полей API ограничен allowlist.

**Обязательная граница доверия:** legacy `/api/integration/v1` — `trusted shared integration namespace`. Его `content:read` не изолирует черновики между ключами разных ботов. Не выдавайте legacy local MCP ключ недоверенным удалённым агентам. Remote OAuth/MCP и per-agent grants реализуются отдельно в #177, #179 и #181.

## Установка на машине оператора

1. Node.js 22+. В папке `tools/local-mcp` выполните `npm ci --no-audit --no-fund`.
2. Через штатные настройки Publikator создайте **новый ограниченный** ключ только со scopes `content:read` и `content:draft:write`. Не используйте `APP_MASTER_KEY`, provider credentials и admin cookie.
3. Сохраните ключ в защищённом локальном хранилище ОС, например Windows DPAPI под профилем оператора. Доверенный launcher передаёт ключ **только** в переменной окружения `PUBLIKATOR_LOCAL_MCP_KEY` процесса MCP. Никогда не записывайте ключ в client JSON, командную строку, GitHub или логи.
4. Для MCP клиента задайте `command` = абсолютный путь к Node.js, `args` = абсолютный путь к `tools/local-mcp/server.mjs`. Процесс не открывает входящий порт — общение исключительно по stdio.
5. Клиент обращается только к локальному Publikator на `http://127.0.0.1:8080`. При необходимости порт можно настроить через `PUBLIKATOR_LOCAL_BASE_URL=http://127.0.0.1:<порт>`, но все внешние хосты, HTTPS и пути отвергаются.
6. При переносе на новый компьютер выпустите новый ограниченный ключ и отзовите старый. Файл Windows DPAPI не является переносимым секретом.

На D2-R2 прежний рабочий хостовый launcher, привязанный к Windows identity и путям этой машины, остаётся в `C:\Users\spike\Documents\Publikator-MCP-Local-20261029`. Репозиторий намеренно не включает этот частный launcher или секрет.

## Проверки

Выполните `npm test` после `npm ci` из папки `tools/local-mcp`. Проверка использует официальный MCP SDK v2 stdio client/server и изолированный fake HTTP-сервер **на 127.0.0.1 с динамическим портом**. Никакая настоящая SQLite-база, Docker или внешние соцсети не используются.

Проверяются handshake, ровно четыре инструмента, чтение, создание DRAFT, идемпотентность и конфликт, строгая Zod-валидация, отсутствие publish/schedule, запрет внешнего URL, отсутствие ключа, редактирование ошибок и непередача неизвестных полей API (включая имитацию credentials).

**Это не полный Publikator Agent API.** Для ChatGPT через интернет необходимы защищённый HTTPS remote MCP, OAuth/PKCE, строгие per-agent grants и отдельный owner consent до отправки: см. [#177](https://github.com/spikeal8-maker/Publikator/issues/177), [#179](https://github.com/spikeal8-maker/Publikator/issues/179), [#181](https://github.com/spikeal8-maker/Publikator/issues/181).

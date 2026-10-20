# MCP-сервер `btx-dev`

Локальный stdio MCP-сервер для coding-агентов (Claude Code, Codex) и CLI для людей.
Код — `tools/mcp-server`, подключение — `.mcp.json` (Claude Code) и `.codex/config.toml` (Codex).
Сервер запускается клиентом из корня репозитория; отдельный демон не нужен.

Рядом подключён второй, внешний MCP — `bitrix24-docs` (официальная документация REST API
Битрикс24, `https://mcp-dev.bitrix24.com/mcp`). Он read-only и не видит наш портал.

## Инструменты

| Инструмент | Что делает | Источник |
|---|---|---|
| `project_overview` | workspaces, модули (+ есть ли `MODULE.md`), ключевые доки, git, npm-скрипты | файлы репо |
| `search_code` | поиск символов, эндпоинтов NestJS, моделей Prisma/SQL, заголовков docs, путей, текста; RU/EN через глоссарий | индекс в памяти |
| `read_source` | фрагмент файла по `symbol_id` или пути и строкам (≤250), с хешем для проверки устаревания | файлы репо |
| `get_module_context` | `MODULE.md` + эндпоинты + экспортируемые символы + тесты модуля | индекс |
| `get_task_state` | чекпоинт `.agent/tasks/<id>.md` | файл |
| `env_status` | `docker compose ps` + ответ `/api/health` | Docker, HTTP |
| `app_logs` | хвост логов сервиса compose, фильтр по подстроке | Docker |
| `db_schema` | таблицы, колонки, ограничения (PK/FK/unique/check), индексы, последние миграции | MariaDB (`agent_ro`) |
| `db_query` | один read-only запрос (SELECT/WITH/EXPLAIN/SHOW/DESCRIBE), лимит строк | MariaDB (`agent_ro`) |

Все инструменты только читают. Запуск/остановка контейнеров, миграции, изменение данных
намеренно не реализованы — это делается кодом, миграциями и явными командами человека/агента.

## Модель безопасности
- Корень репозитория фиксируется при старте; пути проверяются через `realpath` (симлинки за
  пределы корня, `..`, абсолютные пути — отказ).
- Запрещены: `.env*` (кроме `.env.example`), ключи/сертификаты, `node_modules`, `dist`,
  `generated`, `.git`.
- Всё, что уходит агенту (код, логи, строки БД), проходит маскирование секретов: пароли в URL,
  `*_TOKEN`/`*_SECRET`/`AUTH_ID`/`REFRESH_ID`, Bearer, JWT, PEM, коды входящих вебхуков.
- БД: отдельный пользователь `agent_ro` (только `SELECT`/`SHOW VIEW`, ≤5 соединений) +
  `START TRANSACTION READ ONLY` + `max_statement_time 5s` + `sql_select_limit` + лексическая проверка
  (один оператор, без DML/DDL/блокировок/`LOAD_FILE`/`INTO OUTFILE`/`SLEEP`) + лимит строк + маскирование колонок
  с именами вроде `*token*`, `*secret*`, `*password*`, `*hash*`.
- Из корневого `.env` сервер читает только `DB_NAME`, `DB_HOST_PORT`, `AGENT_DB_PASSWORD`,
  `APP_HOST_PORT`, `BTX_AGENT_DB_URL` — и никогда не возвращает их значения.
- Docker вызывается через `execFile` с фиксированными аргументами (`ps`, `logs`,
  `config --services`), без shell.
- Размер ответов ограничен бюджетами (`src/config.mjs`), жёсткий потолок 32 КБ.

## Требования окружения
- Node 24, `npm ci` в корне.
- Для `env_status`/`app_logs` — пользователь, от которого запущен агент, должен иметь доступ к
  Docker (группа `docker`).
- Для `db_*` — в корневом `.env` задан `AGENT_DB_PASSWORD`, контейнер `db` запущен. Если том БД
  создан раньше, чем появилась роль, или пароль сменился: `./scripts/db-ensure-agent-role.sh`.

## CLI (тот же код, для людей и как fallback)

```bash
npm run mcp:cli -- list
npm run mcp:cli -- project_overview
npm run mcp:cli -- search_code '{"query":"бронь ресурса"}'
npm run mcp:cli -- search_code '{"kind":"endpoint"}'
npm run mcp:cli -- read_source '{"path":"apps/api/src/main.ts"}'
npm run mcp:cli -- env_status
npm run mcp:cli -- app_logs '{"service":"api","tail":100,"grep":"error"}'
npm run mcp:cli -- db_schema '{"table":"Portal"}'
npm run mcp:cli -- db_query '{"sql":"SELECT count(*) FROM `Portal`"}'
```

## Развитие
- Новый инструмент добавляется в `src/tools.mjs` (+ метод в `src/core.mjs`) и автоматически
  становится доступен и в MCP, и в CLI. Тест в `test/` обязателен; список инструментов
  зафиксирован в `test/mcp-protocol.spec.mjs`.
- Кандидаты на следующие этапы: `bitrix_rest_docs` (поиск по документации REST), read-only
  вызовы REST тестового портала через вебхук, `list_migrations` со статусом, `find_references`.
- Новые доменные термины → `domain-aliases.json`.

# @btx24/mcp-server (`btx-dev`)

Stdio MCP-сервер + CLI для агентов. Описание инструментов и модели безопасности —
[`docs/agents/MCP_SERVER.md`](../../docs/agents/MCP_SERVER.md).

```bash
node tools/mcp-server/src/server.mjs     # MCP (так его запускают Claude Code/Codex)
npm run mcp:cli -- list                  # CLI
npm run mcp:test                         # тесты (vitest)
```

## Структура

```
src/
  config.mjs        корпус, запреты, бюджеты, лимиты, allowlist ключей .env
  security.mjs      проверка путей, маскирование секретов
  budget.mjs        усечение ответов под бюджет
  tools.mjs         реестр инструментов (общий для MCP и CLI)
  core.mjs          BtxCore — реализация инструментов
  server.mjs        MCP-адаптер (stdio)
  cli.mjs           CLI-адаптер
  repo/             fileset, индексатор (TS/Nest/Prisma/SQL/MD), поиск
  runtime/          .env, docker compose, PostgreSQL (read-only)
domain-aliases.json RU→EN глоссарий для поиска
test/               vitest: безопасность, SQL-guard, ядро, протокол MCP
```

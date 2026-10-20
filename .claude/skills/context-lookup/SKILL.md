---
name: context-lookup
description: How to find code and runtime context in btx24bookingsystems with the btx-dev MCP server (search_code, read_source, get_module_context, env_status, app_logs, db_schema, db_query) and when to fall back to native search. Use at the start of an unfamiliar or cross-module task.
---

# Поиск контекста

1. Файл/символ известен → `Read` напрямую. Стоп.
2. Первый раз в сессии → `project_overview` (модули, доки, git).
3. `search_code`:
   - `kind: "endpoint"` без query — все HTTP-маршруты;
   - `kind: "prisma"` без query — все модели/enum и DDL из миграций;
   - по умолчанию — символы + эндпоинты + prisma + заголовки docs; русские слова
     расширяются глоссарием (`бронь` → `booking`);
   - `kind: "text"` — полнотекст, когда символ неизвестен;
   - `scope` — ограничить модулем.
4. `read_source({ symbol_id })` — точный фрагмент; для соседнего кода — `path` + строки.
5. `get_module_context({ module })` — инварианты модуля (`MODULE.md`), его эндпоинты и тесты.
6. Пусто или не о том → `rg` по вероятному каталогу. Не перефразируйте один и тот же запрос
   в MCP несколько раз.
7. Вопрос «как сейчас на стенде» → `env_status`, `app_logs` (`grep`), `db_schema`,
   `db_query` (только чтение; таблицы Prisma — в кавычках: `"Booking"`).
8. MCP не отвечает после одной повторной попытки → `npm run mcp:cli -- <tool> '<json>'`.

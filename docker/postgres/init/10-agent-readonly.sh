#!/bin/sh
# Выполняется ОДИН раз — при первой инициализации пустого тома БД.
# Создаёт роль agent_ro: только чтение схемы public, включая таблицы, которые миграции
# создадут позже (ALTER DEFAULT PRIVILEGES). Ею пользуется MCP-сервер (db_schema/db_query).
# Скрипт идемпотентен: если том уже существовал или сменился AGENT_DB_PASSWORD —
# запустите scripts/db-ensure-agent-role.sh.
set -eu
if [ -z "${AGENT_DB_PASSWORD:-}" ]; then
  echo "[init] AGENT_DB_PASSWORD is empty — skipping agent_ro role" >&2
  exit 0
fi
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v agent_pw="$AGENT_DB_PASSWORD" -v app_user="$POSTGRES_USER" -v db_name="$POSTGRES_DB" <<'SQL'
SELECT 'CREATE ROLE agent_ro LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ro') \gexec
ALTER ROLE agent_ro PASSWORD :'agent_pw';
ALTER ROLE agent_ro SET default_transaction_read_only = on;
ALTER ROLE agent_ro SET statement_timeout = '5s';
ALTER ROLE agent_ro CONNECTION LIMIT 5;
GRANT CONNECT ON DATABASE :"db_name" TO agent_ro;
GRANT USAGE ON SCHEMA public TO agent_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_ro;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO agent_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE :"app_user" IN SCHEMA public GRANT SELECT ON TABLES TO agent_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE :"app_user" IN SCHEMA public GRANT SELECT ON SEQUENCES TO agent_ro;
SQL

#!/bin/sh
# Создаёт/обновляет пользователя agent_ro: только SELECT на базу приложения (включая таблицы,
# которые миграции создадут позже — права выдаются на всю базу), до 5 соединений.
# Им пользуется MCP-сервер (db_schema / db_query). Идемпотентен: выполняется при первой
# инициализации тома и вручную через scripts/db-ensure-agent-role.sh.
set -eu
if [ -z "${AGENT_DB_PASSWORD:-}" ]; then
  echo "[init] AGENT_DB_PASSWORD is empty — skipping agent_ro" >&2
  exit 0
fi
# Экранируем одинарные кавычки для SQL-литерала.
PW=$(printf '%s' "$AGENT_DB_PASSWORD" | sed "s/'/''/g")
mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" <<SQL
CREATE USER IF NOT EXISTS 'agent_ro'@'%' IDENTIFIED BY '$PW';
ALTER USER 'agent_ro'@'%' IDENTIFIED BY '$PW' WITH MAX_USER_CONNECTIONS 5;
GRANT SELECT, SHOW VIEW ON \`$MARIADB_DATABASE\`.* TO 'agent_ro'@'%';
FLUSH PRIVILEGES;
SQL

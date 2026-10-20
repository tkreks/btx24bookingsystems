#!/bin/sh
# Повторно создаёт/обновляет пользователя agent_ro в работающем контейнере db
# (нужно, если том БД был создан до появления init-скрипта или сменился AGENT_DB_PASSWORD).
set -eu
cd "$(dirname "$0")/.."
docker compose exec -T db /docker-entrypoint-initdb.d/10-agent-readonly.sh
echo "agent_ro ensured"

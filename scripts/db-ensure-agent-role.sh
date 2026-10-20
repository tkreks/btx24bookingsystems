#!/bin/sh
# Повторно создаёт/обновляет роль agent_ro в уже работающем контейнере db
# (нужно, если том БД был создан до появления init-скрипта или сменился AGENT_DB_PASSWORD).
# Использование: ./scripts/db-ensure-agent-role.sh
set -eu
cd "$(dirname "$0")/.."
docker compose exec -T db /docker-entrypoint-initdb.d/10-agent-readonly.sh
echo "agent_ro role ensured"

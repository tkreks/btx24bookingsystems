#!/bin/sh
# Применяет миграции Prisma перед стартом api. Миграции только «вперёд»: откат — новой миграцией.
# worker запускается с SKIP_MIGRATIONS=1: миграции применяет только api.
set -e
if [ "${SKIP_MIGRATIONS:-0}" != "1" ]; then
  echo "[entrypoint] prisma migrate deploy"
  npx --no-install prisma migrate deploy
fi
exec "$@"

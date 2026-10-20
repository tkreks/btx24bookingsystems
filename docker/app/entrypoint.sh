#!/bin/sh
# Применяет миграции Prisma перед стартом приложения. Миграции только «вперёд»:
# откат делается новой миграцией, а не правкой применённой.
set -e
if [ "${SKIP_MIGRATIONS:-0}" != "1" ]; then
  echo "[entrypoint] prisma migrate deploy"
  npx --no-install prisma migrate deploy
fi
exec "$@"

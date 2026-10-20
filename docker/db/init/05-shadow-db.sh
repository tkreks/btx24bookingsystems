#!/bin/sh
# Теневая БД для `prisma migrate dev` (сверка истории миграций). Пользователь приложения получает
# права только на неё — права CREATE DATABASE на сервер ему не нужны. Идемпотентен.
set -eu
mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS \`${MARIADB_DATABASE}_shadow\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON \`${MARIADB_DATABASE}_shadow\`.* TO '${MARIADB_USER}'@'%';
FLUSH PRIVILEGES;
SQL

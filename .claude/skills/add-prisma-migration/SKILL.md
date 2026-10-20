---
name: add-prisma-migration
description: Step-by-step procedure for changing the MariaDB schema in btx24bookingsystems via a Prisma migration, including raw SQL for constraints Prisma cannot express (CHECK constraints, generated columns, special indexes). Use whenever schema.prisma or the database structure must change.
---

# Изменение схемы БД

1. Прочитай `apps/api/prisma/schema.prisma` и посмотри фактическую схему стенда:
   `db_schema` (без аргументов — список таблиц и последние миграции).
2. Измени `schema.prisma` в блоке своего домена (`// ---------- <Домен> ----------`).
   Правила для доменной таблицы:
   - `portalId` + связь с `Portal` (тенант), индекс, начинающийся с `portalId`;
   - время — `DateTime @db.DateTime(3)` (UTC); интервалы — пара `startsAt`/`endsAt`, `[start, end)`;
   - строки — явная длина (`@db.VarChar(n)`), JSON-настройки — `Json` (в MariaDB это LONGTEXT);
   - имена моделей PascalCase, полей camelCase; `@@map`, только если есть причина.
3. Создай миграцию, не применяя её: `cd apps/api && npx prisma migrate dev --create-only --name <snake_case>`
   (нужен `DATABASE_URL` на стенд/локальную БД).
4. Допиши в `migration.sql` то, что Prisma не выражает, с комментарием «зачем», например:
   ```sql
   -- Ключ идемпотентности уникален в рамках портала (повтор запроса не создаёт вторую операцию).
   CREATE UNIQUE INDEX `BookingOperation_portal_idem_key`
     ON `BookingOperation` (`portalId`, `idempotencyKey`);
   ALTER TABLE `ResourceGroup` ADD CONSTRAINT `ResourceGroup_tech_window_range`
     CHECK (`techWindowMinutes` BETWEEN 0 AND 1440);
   ```
   Брони в нашей БД не храним (ADR 0003) — не добавляй таблицу броней «для надёжности».
5. Примени: `npx prisma migrate dev` (локально) и проверь `db_schema({ table })` — ограничения
   на месте. `npm run prisma:generate`.
6. Нарушение ограничения в сервисе → `ConflictException` (Prisma `P2002` для unique; MariaDB
   `ER_CONSTRAINT_FAILED` 4025 для CHECK). Добавь тест.
7. Деструктивное изменение (drop/rename/смена типа) — только в два шага и с пометкой в PR.
8. Никогда: редактировать применённую миграцию, `prisma migrate reset` или `db push` на общем
   стенде.

-- Базовая миграция: расширения, нужные системе бронирования.
-- btree_gist позволяет строить EXCLUDE-ограничения вида
--   EXCLUDE USING gist (resource_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
-- — именно так на уровне БД запрещаются пересекающиеся брони одного ресурса.
CREATE EXTENSION IF NOT EXISTS btree_gist;

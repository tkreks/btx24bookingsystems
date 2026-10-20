# prototype-import

**Назначение:** перенос настроек прототипа Node-RED (`booking_local_settings_v3.json`,
settings v8) в нашу БД: группы, их ресурсы и настройки, пользователи прямой ссылки, флаг wazzup.

```bash
docker compose cp booking_local_settings_v3.json api:/tmp/proto.json
docker compose exec -T -w /repo/apps/api api node dist/scripts/import-prototype.js /tmp/proto.json --member <member_id>          # отчёт
docker compose exec -T -w /repo/apps/api api node dist/scripts/import-prototype.js /tmp/proto.json --member <member_id> --apply  # запись
docker compose exec -T -u root api rm -f /tmp/proto.json
```

**Инварианты**
- Файл содержит открытые пароли: в `.gitignore`, права `600`, в контейнер — только на время
  запуска. В отчёт пароли не попадают, в БД — только `scrypt`-хеш.
- Идемпотентность: группы — по `(portalId, legacyId)`, пользователи — по `(portalId, login)`.
  Повторный запуск обновляет настройки и ресурсы, но **не трогает участников и функции групп**,
  настроенные вручную после первого импорта.
- Участников импорт не создаёт: в прототипе доступ имели все сотрудники Битрикс24, у нас — только
  участники групп и администраторы приложения.
- Пустой список групп у пользователя прямой ссылки = доступ ко всем группам (`allGroups`), как в прототипе.
- Настройки без колонок (оплаты, поля сделки, каталог, товары по умолчанию, виды) → `WorkGroup.options`
  (`groupOptionsSchema`).

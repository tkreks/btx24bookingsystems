# Интеграция с Битрикс24 — заметки

Справочник для разработки модуля `bitrix24`. Источник истины — официальная документация:
<https://apidocs.bitrix24.ru/> (репозиторий: <https://github.com/bitrix24/b24restdocs>).
Пункты с пометкой **(проверить)** — перепроверить по документации перед реализацией.
Агенты сверяются через MCP `bitrix24-docs` (`https://mcp-dev.bitrix24.com/mcp`, официальный
сервер документации, без авторизации, доступа к порталу не даёт).

## Тип приложения
- Начинаем с **локального приложения** на тестовом портале (Разработчикам → Другое →
  Локальное приложение): задаются URL обработчика и URL установки, выдаются `client_id`
  (`application id`) и `client_secret`. Публикация в Маркет — отдельный этап.
- Оба URL должны быть публичными и HTTPS → стенд публикуется через reverse proxy
  (`APP_BASE_URL`).

## Жизненный цикл
1. **Установка.** Портал открывает URL установки (POST с параметрами авторизации и
   `member_id`, `DOMAIN`). Сохраняем портал и токены, регистрируем встройки (`placement.bind`) и
   обработчики событий (`event.bind`), затем фронтенд вызывает `BX24.installFinish()`.
   Альтернативно/дополнительно — событие `ONAPPINSTALL` с `application_token` **(проверить)**.
2. **Открытие приложения.** Портал загружает URL обработчика в iframe **POST-запросом** с
   `AUTH_ID`, `REFRESH_ID`, `AUTH_EXPIRES`, `member_id`, `DOMAIN`, `PLACEMENT`,
   `PLACEMENT_OPTIONS`. Поэтому обработчик должен принимать POST на `/` (сейчас api отдаёт
   статику только на GET — добавить при реализации модуля).
3. **Удаление.** Событие `ONAPPUNINSTALL` — пометить портал удалённым, не стирать данные
   сразу.

## Авторизация и токены
- `access_token` живёт 1 час, `refresh_token` — **180 дней**. Обновление:
  `GET https://oauth.bitrix.info/oauth/token/?grant_type=refresh_token&client_id=…&client_secret=…&refresh_token=…`
  (в ответе — доверенные `member_id`, `client_endpoint`, `server_endpoint`, `scope`, `user_id`).
  Refresh-токен **меняется** при каждом обмене — старый больше не действует.
- При открытии во фрейме портал присылает POST с `AUTH_ID`, `REFRESH_ID`, `SERVER_ENDPOINT`,
  `APPLICATION_TOKEN`, `APPLICATION_SCOPE`, `member_id`, `PLACEMENT`; в query — `DOMAIN`, `LANG`,
  `APP_SID`. `status` — справочно, доверенный — только через `app.info` на сервере авторизации.
- Каждое входящее событие проверяем по `auth.application_token`, сохранённому при установке.
- Реализация — модуль `apps/api/src/modules/bitrix24` (см. его `MODULE.md`).

## Подключение приложения на портале (локальное приложение)
1. Битрикс24 → Разработчикам → Другое → **Локальное приложение**, тип «Серверное, с интерфейсом».
2. Путь вашего обработчика: `https://testapp.1-app.ru/`
3. Путь для первоначальной установки: `https://testapp.1-app.ru/api/b24/install`
4. Права (scope): `crm`, `booking`, `placement`, `user`, `bizproc`, `im` (уточняется по мере
   появления функций; изменение прав требует переустановки).
5. Сохранить → получить `client_id` и `client_secret` → записать в `.env` сервера
   (`B24_CLIENT_ID`, `B24_CLIENT_SECRET`) → `docker compose up -d api worker`.
6. Открыть приложение из портала под администратором — выполнится установка. Опция «Приложение
   само завершает установку» поддерживается (событие `ONAPPINSTALL`). Если установка прошла мимо
   сервера, портал регистрируется при первом открытии приложения администратором.
   Проверка: `npm run mcp:cli -- db_query '{"sql":"SELECT domain, status, installedAt FROM `Portal`"}'`.

## Вызовы REST
- Лимит запросов на приложение/портал (порядка 2 запросов/с с «ведром» на всплески)
  **(проверить актуальные цифры)** → очередь в клиенте, `batch` (до 50 команд), обработка
  `QUERY_LIMIT_EXCEEDED`.
- `expired_token` → refresh и повтор; `invalid_token`/`NO_AUTH_FOUND` → портал требует
  переустановки.
- Списки постраничные (`start`, шаг 50).

## Фронтенд в iframe
- JS SDK: классический `BX24` (`//api.bitrix24.com/api/v1/`) или npm-пакет
  `@bitrix24/b24jssdk` (выбрать при реализации, зафиксировать ADR).
- `BX24.fitWindow()`/`resizeWindow` — высота iframe; `BX24.placement.info()` — контекст встройки.
- Не выставлять `X-Frame-Options`; cookies в iframe — `SameSite=None; Secure`, лучше вообще
  обходиться без cookie-сессии (токен из параметров запуска).

## Модуль бронирования Битрикс24
Прототип использует `booking.v1.resource.list`, `booking.v1.booking.{list,get,add,update,delete}`,
`booking.v1.booking.externalData.{set,list}` (связь брони со сделкой). Детали и ограничения —
`docs/prototype/node-red-v3.md` §4–6, решение — ADR 0003.

## Открытые вопросы
- Какие встройки нужны: левое меню, вкладка карточки CRM, календарь.
- Синхронизация броней с календарём пользователя (`calendar.event.*`).

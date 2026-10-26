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
  Для российского облака (`*.bitrix24.ru`) сервер авторизации — **`oauth.bitrix24.tech`**: портал
  присылает его в `SERVER_ENDPOINT`.
  Refresh-токен **меняется** при каждом обмене — старый больше не действует.
- При открытии во фрейме портал присылает POST с `AUTH_ID`, `REFRESH_ID`, `SERVER_ENDPOINT`,
  `APPLICATION_TOKEN`, `APPLICATION_SCOPE`, `member_id`, `PLACEMENT`; в query — `DOMAIN`, `LANG`,
  `APP_SID`. `status` — справочно, доверенный — только через `app.info` на сервере авторизации.
- Вход вне портала (OAuth «authorization code»): `https://{портал}/oauth/authorize/?client_id&state&redirect_uri`
  → портал возвращает на `redirect_uri` с `code`, `state`, `domain`, `member_id`, `server_domain` →
  `GET https://{server_domain}/oauth/token/?grant_type=authorization_code&client_id&client_secret&code`.
  **Облако возвращает не на `redirect_uri`, а на адрес обработчика приложения** (`/?code=…&state=…`,
  проверено 2026-10-22) — nginx `web` по формату `state` переводит такой запрос на `/api/auth/callback`.
  Код одноразовый и короткоживущий; токены — сотрудника, его права. Реализация — `WebSessionService`.
  Поиск MCP `bitrix24-docs` по OAuth 2026-10-22 ничего не нашёл — схема проверяется входом на живом портале.
- Каждое входящее событие проверяем по `auth.application_token`, сохранённому при установке.
- Реализация — модуль `apps/api/src/modules/bitrix24` (см. его `MODULE.md`).

## Подключение приложения на портале (локальное приложение)

1. Битрикс24 → Разработчикам → Другое → **Локальное приложение**, тип «Серверное, с интерфейсом».
2. Путь вашего обработчика: `https://testapp.1-app.ru/`
3. Путь для первоначальной установки: `https://testapp.1-app.ru/api/b24/install`
4. Права (scope): `crm`, `booking`, `placement`, `user`, `bizproc`, `imopenlines`, `messageservice`
   (так настроено на `admiral-club` 2026-10-21; `im` добавим, когда понадобятся сообщения в чат.
   Изменение прав требует переустановки). Фактические права приложение запрашивает методом `scope`
   при установке и хранит в `Portal.scope`.
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
  `fitWindow` шлёт `resizeWindow` с `width:'100%'` и высотой содержимого; сам `resizeWindow` берёт
  только числа (`parseInt`, > 0), поэтому «100% ширины» доступно только через `fitWindow`. Высоту
  окна портала из фрейма не узнать — берём `window.outerHeight` (окно браузера) минус шапку и
  задаём её `min-height` странице перед `fitWindow` (`web/src/b24.ts` → `fitFrame`): иначе низкая
  вкладка сделки не растёт — сетка календаря ограничена `100dvh` самого фрейма.
- Не выставлять `X-Frame-Options`; cookies в iframe — `SameSite=None; Secure`, лучше вообще
  обходиться без cookie-сессии (токен из параметров запуска).

## Модуль бронирования Битрикс24

Прототип использует `booking.v1.resource.list`, `booking.v1.booking.{list,get,add,update,delete}`,
`booking.v1.booking.externalData.{set,list}` (связь брони со сделкой). Детали и ограничения —
`docs/prototype/node-red-v3.md` §4–6, решение — ADR 0003.

## Открытые вопросы

- Какие встройки нужны: левое меню, вкладка карточки CRM, календарь.
- Синхронизация броней с календарём пользователя (`calendar.event.*`).

### Справочники экрана настроек групп

Проверено через официальный MCP `bitrix24-docs`:

- [`BX24.selectUsers`](https://apidocs.bitrix24.com/sdk/bx24-js-sdk/system-dialogues/bx24-select-users.html)
  открывает стандартный выбор сотрудников без дополнительного scope; callback получает массив
  `{ id: string, name: string }`. При закрытии без выбора callback может не прийти — форму
  нельзя блокировать ожиданием. Повторный вызов не сохраняет выделение.
- [`crm.category.list`](https://apidocs.bitrix24.com/api-reference/crm/universal/category/crm-category-list.html)
  для сделок принимает `entityTypeId: 2`, список — `result.categories`, основная воронка имеет
  id `0` (это не отсутствие привязки).
- [`booking.v1.resource.list`](https://apidocs.bitrix24.com/api-reference/booking/resource/booking-v1-resource-list.html)
  возвращает `result.resource`, поддерживает `start` (страница 50); `total` всегда `0`,
  ориентируемся на `next`, а не `total`.
- [`department.get`](https://apidocs.bitrix24.com/api-reference/departments/department-get.html)
  требует scope `department`. Экран не запрашивает расширение прав автоматически: без scope
  показывает ограничение и сохраняет имеющиеся назначения отделов.
- [`user.get`](https://apidocs.bitrix24.com/api-reference/user/user-get.html) принимает
  массив id в `FILTER.ID`. Для подписей сохранённых участников запрашиваем только сотрудников
  из групп и списка администраторов текущего портала; в ответ нашего API идут только id и имя.

### Открытая линия контакта и новая сделка (проверено 2026-10-24)
`imopenlines.crm.chat.get` для новой сделки может вернуть пустой список, а для её контакта —
существующие чаты, привязанные к прежним сделкам. Для отправки используем CRM-объект `contact`,
предварительно проверяя CONTACT в `imopenlines.dialog.get.entity_data_2`. Метод
`imopenlines.crm.message.add` официально поддерживает `lead/deal/company/contact`, отправитель
должен быть участником и иметь доступ к объекту.
Документация проверена через bitrix24-docs MCP:
[чаты CRM](https://apidocs.bitrix24.com/api-reference/imopenlines/openlines/chats/imopenlines-crm-chat-get.html),
[отправка сообщения](https://apidocs.bitrix24.com/api-reference/imopenlines/openlines/messages/imopenlines-crm-message-add.html),
[дела CRM для ленты клиента](https://apidocs.bitrix24.com/api-reference/crm/timeline/activities/activity-base/crm-activity-list.html).

### CALL_CARD: контекст, высота и сообщение (2026-10-24)
- `BX24.placement.call('getStatus', {}, callback)` возвращает актуальные CALL_ID, PHONE_NUMBER,
  CRM_ENTITY_TYPE/ID; исходные options могут появиться раньше привязки. Документация через MCP:
  https://apidocs.bitrix24.com/api-reference/widgets/ui-interaction/call-card/get-status.html
- CALL_CARD не монтирует CalendarPage: fitWindow/fitFrame нужно вызывать в самой карточке
  при старте и изменении содержимого, иначе низкий фрейм может показывать белое поле.
- BX24.im.openMessenger принимает только dialogId. Путь к конкретному сообщению —
  `/online/?IM_DIALOG=chat4396&IM_MESSAGE=123456`. MCP для SDK возвращал обзор вместо страницы;
  индивидуальная страница SDK и пример ссылки проверены в официальных источниках:
  https://apidocs.bitrix24.com/sdk/bx24-js-sdk/additional-functions/bx24-im-open-messenger.html
  https://vibecode.bitrix24.tech/docs/chats/service/task-form-message

### Сообщение из окна звонка: обычная страница вместо слайдера (2026-10-24)
На живом интерфейсе владелец подтвердил: BX24.openPath('/online/?IM_DIALOG=...&IM_MESSAGE=...')
открывает позади звонка пустое окно «Чат и звонки», кнопка открытия не помогает. Поэтому
ссылка сообщения теперь открывает https://<домен портала>/online/ с обоими параметрами
в новой вкладке браузера, синхронно по клику. Слайдеры CRM для сделок не изменялись.

### Личные непрочитанные в мессенджере (2026-10-24)
Официальная документация im.recent.list (проверено через bitrix24-docs):
https://apidocs.bitrix24.com/api-reference/chats/im-recent-list.html
ONLY_OPENLINES не поддерживается. Используем UNREAD_ONLY=Y, SKIP_OPENLINES=N, LIMIT=200,
OFFSET и флаги hasMore/hasMorePages; result.items содержит id/chat_id и counter.
Счётчик непрочитанных личный и не равен числу чатов, ожидающих ответа.

### Файлы Диска для шаблонов (2026-10-24)
Через официальный bitrix24-docs проверены disk.storage.getList (список доступных хранилищ),
disk.folder.getChildren (только объекты с правом чтения), disk.file.get (метаданные и
DOWNLOAD_URL). Новые маршруты используют клиент сотрудника, а не токен приложения:
- https://apidocs.bitrix24.com/api-reference/disk/storage/disk-storage-get-list.html
- https://apidocs.bitrix24.com/api-reference/disk/folder/disk-folder-get-children.html
- https://apidocs.bitrix24.com/api-reference/disk/file/disk-file-get.html
Нужен scope disk. Импорт — копия в StoredFile, URL скачивания не возвращается клиенту;
защита/лимит скачивания — общий bitrix24/rest-client.download. В портал ничего не загружается
до явной отправки клиенту. Штатные бизнес-процессы не регистрируются и не меняются.

### Линия и сотрудник звонка (2026-10-24)
Официальный bitrix24-docs: voximplant.statistic.get, scope telephony,
https://apidocs.bitrix24.ru/api-reference/telephony/voximplant/voximplant-statistic-get.html
FILTER CRM_ACTIVITY_ID сопоставляется с делами CRM, которые уже прочитал сотрудник своим
токеном. PORTAL_NUMBER может быть reg133788/внутренним ID — такое не показываем как телефон.
PORTAL_USER_ID — фактический сотрудник. При отсутствии прав остаются данные дела CRM.

### Переходы из звонка на дашборде (2026-10-24)
Проверено через официальный bitrix24-docs MCP: crm.deal.list поддерживает filter/contact,
order DATE_CREATE+ID, select ID/DATE_CREATE и start; CONTACT_IDS в select не поддерживается.
Нужна первая страница, берём первый результат сортировки DESC (включая закрытые сделки).
imopenlines.crm.chat.get принимает CRM_ENTITY_TYPE=contact/deal/lead/company, CRM_ENTITY=id,
ACTIVE_ONLY=N для завершённых и активных диалогов. Доступ к самим диалогам проверяется через
существующий summariesByChat токеном пользователя. crm.duplicate.findbycomm: type=PHONE,
entity_type=CONTACT, values — не более20 вариантов. Связи не ограничиваются периодом звонка.

Аватары звонков (2026-10-24): из доступного диалога берётся уже полученный clientAvatar;
для CRM-контакта дополнительно выбирается PHOTO. crm.contact.get/права чтения проверены через
официальный MCP (PHOTO входит в данные контакта). URL нормализуется через photoUrl, числовой
идентификатор файла не используется как ссылка. Пользовательский токен и прежние проверки
доступа к чатам/контактам сохраняются.

### Активность и смены (2026-10-24)
Read-only диагностика: последние8 VOXIMPLANT_CALL имелиCOMPLETED=N, хотя END_TIME−START_TIME
даёт реальные длительности. Нельзя исключатьN при учёте входящих. Фактический сотрудник —
voximplant.statistic.get.PORTAL_USER_ID по CRM_ACTIVITY_ID уже доступных дел.
Официальный bitrix24-docs подтвердил: im.dialog.messages.get.LAST_ID возвращает более старые
сообщения, LIMIT≤50; для периода читаются страницы до500/чат. timeman.status поддерживает
USER_ID для read-only списка; timeman.open/pause/close для управления остаются без USER_ID,
то есть строго собственный день пользователя. Права портала действуют на оба случая.

### Вложения своего коннектора (2026-10-24)
Официальный MCP method_details `imconnector.send.messages` подтверждает `message.files`:
массив `{url,name}`, обязателен либо text, либо files; `user_id` — менеджер, от имени которого
отправляется сообщение. Ссылка доступна Битрикс24 без Bearer; используем HMAC24ч.
Документация: https://apidocs.bitrix24.com/api-reference/imopenlines/imconnector/imconnector-send-messages.html
Входящий формат `OnImConnectorMessageAdd.message.files` проверить по реальному событию после
создания своей линии владельцем: сейчас обработчик поддерживает link/url/downloadLink/urlDownload.

### Клиент мессенджера и сделки
Официальный MCP проверен: crm.duplicate.findbycomm PHONE принимает ≤20 values; используем варианты
+7/8/7. crm.contact.list и crm.deal.list — user.client в HTTP, все страницы next. CONTACT_IDS не
поддерживается select crm.deal.list; используем CONTACT_ID. imopenlines.dialog.get CHAT_ID
положительно проверяет права на существующий диалог. imopenlines.crm.chat.get возвращает диалоги
contact/deal, каждый результат перепроверяем dialog.get. imconnector.send.messages message.disable_crm=Y
отключает CRM tracker у сопоставленного/ожидающего выбора клиента, исключает создание дубля CRM.
Произвольного метода imopenlines.crm.chat.update нет: локальная связь диалога со сделкой — в приложении;
чужие подключения провайдеров не переиспользуются как собственные каналы доставки.

### Отправка после отключения прежнего провайдера (2026-10-25)
Проверено официальным MCP: `imopenlines.crm.message.add` требует существующий CHAT_ID,
CRM_ENTITY_TYPE/CRM_ENTITY и USER_ID участника с доступом к CRM; возвращает ID сообщения
Битрикс24, что само по себе не подтверждает внешнюю доставку отключённым провайдером.
[Документация](https://apidocs.bitrix24.com/api-reference/imopenlines/openlines/messages/imopenlines-crm-message-add.html).
`imconnector.send.messages` передаёт уже полученное/отправленное внешним транспортом сообщение
в собственную ОЛ; `message.disable_crm=Y` отключает CRM tracker, `user_id` задаёт менеджера.
Это не метод доставки в WhatsApp/Telegram по номеру.
`imopenlines.config.get` принимает CONFIG_ID и WITH_QUEUE/SHOW_OFFLINE=Y; живое чтение
подтвердило ACTIVE=Y и по два оператора в собственных линиях14/16. Подписки Wazzup и MAX
не менялись. План и ограничения — [переход мессенджеров](../features/messenger-transition.md).

### Рабочая ли открытая линия (2026-10-26, проверено на портале чтением)
`imconnector.status {CONNECTOR, LINE}` (контекст приложения) отвечает и для чужих коннекторов: код — из
`entity_id` чата (`wz_telegram_<hash>|8|…`). Живое чтение: Wazzup Telegram (линия 8) и Wazzup WhatsApp
(линия 4) — `CONFIGURED=false, STATUS=false`; свои линии 14/16, Instagram (6), MAX Wazzup (10) — `true`.
`imopenlines.config.list.get` (`PARAMS.select: ID, LINE_NAME, ACTIVE`) — все 9 линий ACTIVE=Y.

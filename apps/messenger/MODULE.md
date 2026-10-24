# apps/messenger

Сервис мессенджеров (ADR 0014): на каждый номер — Xvfb `:N` + x11vnc (`5900+N`, только localhost) +
Chromium с WhatsApp Web (whatsapp-web.js, сессия — `LocalAuth` в `/data/sessions`) или с Telegram Web K
(`telegram.ts`, профиль браузера — `/data/sessions/session-<id>`). Вызывает только api по внутренней
сети стенда.

| Файл | Что |
|---|---|
| `src/spec.ts` | виды, состояния, нормализация номера (копия `normalizeMessengerPhone` из shared — сервис собирается без shared) |
| `src/screen.ts` | виртуальный экран Xvfb и x11vnc (общие для всех мессенджеров) |
| `src/instance.ts` | один номер WhatsApp: браузер, события входа; `MessengerInstance` — общий интерфейс |
| `src/telegram.ts` | один номер Telegram: Chromium с Telegram Web K, вызовы Telegram API через страницу |
| `src/telegram-wire.ts` | объекты Telegram API → `WireMessage`/`WireEvent` (чистые функции, тесты) |
| `src/manager.ts` | реестр `/data/instances.json`, номера экранов, запуск после перезапуска |
| `src/server.ts` | HTTP `/instances…` и WebSocket `/instances/:id/vnc` → x11vnc |

Прокси: `MESSENGER_PROXY` (`http://host:port`) → Chromium `--proxy-server`; WhatsApp и Telegram с
сервера напрямую недоступны (DNS не отвечает), по умолчанию — прокси владельца из `docker-compose.yml`.

Подводные камни: рабочая папка образа — только для чтения, всё записываемое (сессии, кэш версии
WhatsApp Web `wwebjs-cache`) — в `/data`; после перезапуска контейнера снимается блокировка профиля
Chromium (`Singleton*`), иначе браузер не стартует. После входа whatsapp-web.js иногда зависает на
подключении слушателей страницы (`authenticated` без `ready`, экран при этом загружен): сторож
`READY_TIMEOUT_MS` (90 с) перезапускает клиент с той же сессией, после 3 попыток подряд — `failed`.

Файлы для экрана (`screen-files.ts`): `dataDir/screen-files/<экземпляр>/<id>/<имя>` + `<id>.json`,
удаляются через час (таймер раз в 5 минут и при чтении списка). «Прикрепить» (`FileOffers`) — puppeteer
`waitForFileChooser` на странице экземпляра (`filePage()`, только `ready`): следующее окно выбора файла
получает этот файл; одно ожидание на экземпляр, 3 минуты; после — перехват окна выключается
(`Page.setInterceptFileChooserDialog false`), иначе обычный выбор файла на экране не открывался бы.

Проверки: `npm run test -w @btx24/messenger` (без браузера — экземпляры подменяются).
Новый мессенджер (MAX) — новый `kind` в `spec.ts` и свой класс экземпляра (`MessengerInstance`).

## Файлы
`media.ts`: MediaStore, детерминированный SHA1(instanceId:messageId), байты и JSON в томе
`/data/media/<instance>`. Изоляция экземпляров, проверка имени каталога/fileId, до64МБ.
`POST /instances/:id/media {id}` лениво скачивает вложение истории; `GET …/media/:fileId`
отдаёт байты (только внутренняя сеть + токен). POST send принимает `media {mime,name,data base64}`
и caption в `text`, тело до96МБ. Фото/видео/аудио отправляются как медиа, прочее документом.
`message_create` добавляет `media`/`mediaInfo`; meta/read повтор не скачивает заново.

### Совместимость WhatsApp Web (проверено на тестовых вложениях)
Новые MessageKey не содержат `_serialized`: перед downloadMedia/edit/delete дополняем его через
`ensureSerializedId` (тот же widOf). В whatsapp-web.js 1.34.7 DownloadManager вызывается без
`mimetype`, современный WA отвергает image/ptt/video как application/octet-stream. `browser-media.ts`
берёт готовый расшифрованный mediaBlob или вызывает DownloadManager с явным MIME сообщения,
с лимитом64МБ, затем сохраняет в MediaStore. Ключи шифрования/ссылки WA остаются в браузере:
из Puppeteer наружу возвращаются только MIME, имя и base64 файла. Удалённые сообщения в UI
не показывают вложения, чтение обычного media endpoint для них — 404.

## Проверка номера и отправка медиа
`POST /instances/:id/contact {phone}` — getNumberId без sendMessage/создания чата; доступ только
внутренний с токеном. Не подключённый экземпляр — ошибка проверки, не «клиент не найден».
`whatsapp-compat.ts` + scripts/patch-whatsapp.mjs применяются каждой build: удаляется внутренний
`message.__x_id` перед созданием outgoing Msg (WA MediaModel иначе затирает корректный id).
Patch идемпотентный, при изменении upstream маркера сборка останавливается для проверки.
Владелец подтвердил доставку файла из Битрикс24 и приложения; исправление включено в образ.
## Telegram (`kind: telegram`)
Готовой библиотеки вроде whatsapp-web.js для Telegram Web нет, а разбирать разметку страницы хрупко.
Поэтому сервис вызывает **Telegram API (MTProto) клиентом самой страницы**:
`window.rootScope.managers.apiManager.invokeApi(method, params, options)` (Telegram Web K; флаги `true`
— в `pFlags`, long — строками; файлы: `upload.getFile` с `{dcId, fileDownload: true}`,
`upload.save(Big)FilePart` с `{fileUpload: true}`). Зависимость от внутренностей страницы — только эта.
- **Вход** — на экране (QR или номер + код + облачный пароль); сервис раз в 10 с проверяет
  `updates.getState`: `AUTH_KEY_UNREGISTERED` → `qr` (после входа — `logged_out`), успех → `ready`,
  `account` — `<номер>@c.us`. Вошли не тем номером — `ready` с предупреждением в `error`.
- **Изменения** — `updates.getDifference` со своим `pts/date/qts` в `/data/telegram-<id>.json`
  (там же `access_hash` собеседников — без него не написать): после перезапуска пропущенное дочитывается,
  `differenceTooLong` — с текущего места. Сразу — по событиям страницы (обёртка `rootScope.dispatchEvent`
  → `__btxNotify`), иначе раз в 10 с.
- **ID**: сообщение — `tg_<номер>` (в личных чатах и группах номер уникален на аккаунт: правка,
  удаление, вложение — по нему одному); собеседник — `<userId>@lid`, номер — в `phone`, если виден;
  группа — `<chatId>@g.us`. Каналы, супергруппы, боты, «Избранное» и служебная учётка `777000` (коды
  входа!) в приложение не попадают.
- **Отправка** на `<номер>@c.us`: известный собеседник → `contacts.resolvePhone` → (номер скрыт
  приватностью) `contacts.importContacts` — номер **появляется в контактах** аккаунта. Текст — без
  разметки (BBCode линии превращается в простой текст в api). Фото jpeg/png/webp — фото, прочее — файлом.
- Удаление в Telegram приходит без чата — чат берётся из памяти сервиса (сообщения после запуска и
  загруженной истории); неизвестное удаление пропускается. Прочтение собеседником — `ack` 3.
- Отправленное через API не появляется на экране Telegram Web до обновления страницы — только вид.

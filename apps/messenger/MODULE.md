# apps/messenger

Сервис мессенджеров (ADR 0014): на каждый номер — Xvfb `:N` + x11vnc (`5900+N`, только localhost) +
Chromium с WhatsApp Web (whatsapp-web.js, сессия — `LocalAuth` в `/data/sessions`). Вызывает только
api по внутренней сети стенда.

| Файл | Что |
|---|---|
| `src/spec.ts` | виды, состояния, нормализация номера (копия `normalizeMessengerPhone` из shared — сервис собирается без shared) |
| `src/instance.ts` | один номер: экран, VNC, браузер, события входа |
| `src/manager.ts` | реестр `/data/instances.json`, номера экранов, запуск после перезапуска |
| `src/server.ts` | HTTP `/instances…` и WebSocket `/instances/:id/vnc` → x11vnc |

Прокси: `MESSENGER_PROXY` (`http://host:port`) → Chromium `--proxy-server`; WhatsApp и Telegram с
сервера напрямую недоступны (DNS не отвечает), по умолчанию — прокси владельца из `docker-compose.yml`.

Подводные камни: рабочая папка образа — только для чтения, всё записываемое (сессии, кэш версии
WhatsApp Web `wwebjs-cache`) — в `/data`; после перезапуска контейнера снимается блокировка профиля
Chromium (`Singleton*`), иначе браузер не стартует.

Проверки: `npm run test -w @btx24/messenger` (без браузера — экземпляры подменяются).
Новый мессенджер (Telegram, MAX) — новый `kind` в `spec.ts` и свой класс экземпляра.

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
Telegram отложен по указанию владельца до завершения текущего этапа, kind не включён.

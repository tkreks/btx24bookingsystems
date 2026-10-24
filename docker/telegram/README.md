# Контейнер Telegram Web (заготовка)

Тот же браузерный подход, что у WhatsApp в `apps/messenger` (ADR 0014), но пока **без связи с
приложением**: api и web о контейнере не знают, общий `docker-compose.yml` не тронут.

Внутри: Xvfb `:10` → x11vnc (`5910`, только localhost контейнера) → websockify/noVNC `:6080` →
Chromium `--app=https://web.telegram.org/k/` через `MESSENGER_PROXY` (с сервера Telegram напрямую
недоступен). Профиль браузера (сессия входа) — том `telegram-data` (`/data/profile`); после
перезапуска вход не нужен. Упавший Chromium перезапускается сам. DevTools — `127.0.0.1:9222`
внутри контейнера (для будущей автоматизации через Puppeteer `connect`).

```bash
# из корня репозитория
docker compose -f docker-compose.yml -f docker/telegram/compose.yml up -d --build --no-deps telegram
# экран: SSH-туннель на порт 56080 сервера → http://127.0.0.1:56080/vnc.html
ssh -L 56080:127.0.0.1:56080 <сервер>
```

Вход — QR-кодом на экране («Настройки → Устройства → Подключить устройство» в телефоне) или по
номеру и коду прямо в окне через VNC.

| Переменная | По умолчанию | Что |
|---|---|---|
| `MESSENGER_PROXY` | прокси владельца | HTTP-прокси для Chromium |
| `TG_VNC_PASSWORD` | пусто | пароль VNC; пусто — экран защищает только привязка к localhost/сети docker |
| `TG_VNC_HOST_PORT` | `56080` | порт noVNC на хосте |
| `TG_VNC_HOST_BIND` | `127.0.0.1` | адрес хоста для noVNC; IP в локальной сети (`192.168.10.15`) — открыть экран из LAN |
| `TG_URL`, `TG_SCREEN`, `TG_DISPLAY` | `web.telegram.org/k/`, `1280x800`, `10` | в образе |

Дальше, при подключении к приложению: перенести сервис в общий compose (или в `messenger` как
новый `kind`), убрать публикацию порта на хост — экран через мост api (`vnc-proxy.ts`), как у WhatsApp.
Удаление тома `telegram-data` = выход из аккаунта.

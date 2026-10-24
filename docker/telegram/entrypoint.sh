#!/bin/bash
# Экран :N → VNC (localhost:5900+N) → WebSocket :6080 (noVNC) → Chromium с Telegram Web.
# Упавший браузер перезапускается; падение экрана или VNC завершает контейнер (restart: unless-stopped).
set -euo pipefail

DISPLAY_NUM="${TG_DISPLAY:-10}"
SCREEN="${TG_SCREEN:-1280x800}"
VNC_PORT=$((5900 + DISPLAY_NUM))
PROFILE="${TG_DATA_DIR:-/data}/profile"
export DISPLAY=":${DISPLAY_NUM}"

mkdir -p "$PROFILE"
# Блокировка профиля от прежнего процесса (контейнер перезапущен) — иначе Chromium не стартует.
rm -f "$PROFILE"/Singleton{Lock,Socket,Cookie} "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"

Xvfb "$DISPLAY" -screen 0 "${SCREEN}x24" -nolisten tcp &
for _ in $(seq 50); do [ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ] && break; sleep 0.1; done

# Пароль VNC — по желанию (TG_VNC_PASSWORD); без него экран защищает только сеть docker.
VNC_AUTH=(-nopw)
if [ -n "${TG_VNC_PASSWORD:-}" ]; then
  x11vnc -storepasswd "$TG_VNC_PASSWORD" "${TG_DATA_DIR:-/data}/.vncpass" >/dev/null
  VNC_AUTH=(-rfbauth "${TG_DATA_DIR:-/data}/.vncpass")
fi
x11vnc -display "$DISPLAY" -localhost -rfbport "$VNC_PORT" -forever -shared -quiet "${VNC_AUTH[@]}" &
websockify --web /usr/share/novnc 0.0.0.0:6080 "127.0.0.1:${VNC_PORT}" &

# Прокси: с сервера Telegram напрямую недоступен (DNS не отвечает) — имена разрешает прокси.
PROXY_ARGS=()
[ -n "${MESSENGER_PROXY:-}" ] && PROXY_ARGS=(--proxy-server="$MESSENGER_PROXY")

(
  while true; do
    chromium \
      --user-data-dir="$PROFILE" \
      --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check \
      --disable-features=Translate --password-store=basic \
      --window-position=0,0 --window-size="${SCREEN/x/,}" \
      --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
      "${PROXY_ARGS[@]}" \
      --app="${TG_URL:-https://web.telegram.org/k/}" || true
    echo "chromium exited, restarting in 3s" >&2
    rm -f "$PROFILE"/Singleton{Lock,Socket,Cookie}
    sleep 3
  done
) &

# Любой из экрана/VNC/websockify завершился — выходим, docker перезапустит контейнер.
wait -n
exit 1

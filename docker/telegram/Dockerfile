# Контейнер Telegram Web (заготовка к ADR 0014, тот же браузерный подход, что у WhatsApp):
# Xvfb (виртуальный экран) + x11vnc (только localhost контейнера) + websockify/noVNC (экран по
# WebSocket — как мост api → messenger) + Chromium с web.telegram.org. Профиль браузера (сессия
# входа) — в томе /data: после перезапуска вход не нужен. Приложение с контейнером пока не связано.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb x11vnc novnc websockify procps \
      fonts-liberation fonts-noto-color-emoji ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 1000 -s /bin/bash tg \
 && mkdir -p /data /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix && chown tg:tg /data
COPY docker/telegram/entrypoint.sh /usr/local/bin/telegram-entrypoint.sh
RUN chmod +x /usr/local/bin/telegram-entrypoint.sh
ENV TZ=UTC \
    TG_DATA_DIR=/data \
    TG_URL=https://web.telegram.org/k/ \
    TG_DISPLAY=10 \
    TG_SCREEN=1280x800
USER tg
WORKDIR /data
# 6080 — noVNC/WebSocket (RFB), наружу не публикуется (см. compose.yml).
EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/telegram-entrypoint.sh"]

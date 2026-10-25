# Образы проекта: `api` (NestJS; он же запускается как worker), `web` (nginx + собранный фронтенд)
# и `messenger` (браузеры мессенджеров, ADR 0014).
# Контекст сборки — корень репозитория (npm workspaces).
ARG NODE_IMAGE=node:24-slim
ARG NGINX_IMAGE=nginx:1.29-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
# Chromium для мессенджеров ставится в образ messenger из пакетов ОС — puppeteer свой не качает.
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/messenger/package.json apps/messenger/package.json
# package.json инструментов нужен только чтобы lockfile совпал; их код в образ не попадает.
COPY tools/mcp-server/package.json tools/mcp-server/package.json
RUN npm ci

COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
COPY apps/messenger apps/messenger
RUN npm run build -w @btx24/shared \
 && npm run prisma:generate -w @btx24/api \
 && npm run build -w @btx24/api \
 && npm run build -w @btx24/web \
 && npm run build -w @btx24/messenger \
 && npm prune --omit=dev --offline --no-audit --no-fund

# ---------- api / worker ----------
FROM ${NODE_IMAGE} AS api
# OpenSSL нужен движку миграций Prisma (prisma migrate deploy при старте).
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/apps/api/package.json /repo/apps/api/prisma.config.ts ./apps/api/
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY docker/api/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && chown -R node:node /repo
USER node
WORKDIR /repo/apps/api
EXPOSE 3000
# Healthcheck задаётся в docker-compose.yml: у api и worker он разный.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/main.js"]

# ---------- web ----------
FROM ${NGINX_IMAGE} AS web
COPY docker/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080

# ---------- messenger ----------
# Браузер на каждый подключённый мессенджер: Xvfb (виртуальный экран), x11vnc (экран по VNC, только
# localhost контейнера — наружу через мост api), Chromium. Сессии — в томе /data.
FROM ${NODE_IMAGE} AS messenger
RUN apt-get update && apt-get install -y --no-install-recommends chromium chromium-l10n xvfb x11vnc fonts-liberation fonts-noto-color-emoji ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix && chown node:node /data
ENV NODE_ENV=production \
    PORT=3090 \
    CHROMIUM_PATH=/usr/bin/chromium \
    MESSENGER_DATA_DIR=/data
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/apps/messenger/package.json ./apps/messenger/package.json
COPY --from=build /repo/apps/messenger/dist ./apps/messenger/dist
COPY docker/messenger/browser-policy.json /etc/chromium/policies/managed/booking.json
USER node
WORKDIR /repo/apps/messenger
EXPOSE 3090
CMD ["node", "dist/main.js"]

# Production-образ приложения: api (NestJS) + собранный web (Vite), один процесс Node.
# Контекст сборки — корень репозитория (npm workspaces).
ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# package.json инструментов нужен только чтобы lockfile совпал; их код в образ не попадает.
COPY tools/mcp-server/package.json tools/mcp-server/package.json
RUN npm ci

COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build -w @btx24/shared \
 && npm run prisma:generate -w @btx24/api \
 && npm run build -w @btx24/api \
 && npm run build -w @btx24/web \
 && npm prune --omit=dev --workspace @btx24/shared --workspace @btx24/api --include-workspace-root=false

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST_DIR=/repo/apps/web/dist
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/apps/api/package.json /repo/apps/api/prisma.config.ts ./apps/api/
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/web/dist ./apps/web/dist
COPY docker/app/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && chown -R node:node /repo
USER node
WORKDIR /repo/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.status==='ok'?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/main.js"]

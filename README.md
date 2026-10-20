# btx24bookingsystems

Приложение для Битрикс24 со встроенной системой бронирования.

- Правила разработки: [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- Инструкции для AI-агентов и карта проекта: [`AGENTS.md`](./AGENTS.md)
- MCP-сервер для агентов: [`docs/agents/MCP_SERVER.md`](./docs/agents/MCP_SERVER.md)
- Интеграция с Битрикс24: [`docs/bitrix24/README.md`](./docs/bitrix24/README.md)
- Архитектурные решения: [`docs/decisions/`](./docs/decisions/)

## Стек
NestJS 12 + Prisma 7 + MariaDB 11.8 (api, worker), React 19 + Vite 8 (web), npm workspaces, Node 24.
Контейнеры: `db`, `api`, `worker`, `web` — см. ADR 0004.

## Стенд в Docker

```bash
cp .env.example .env        # задать DB_PASSWORD, DB_ROOT_PASSWORD, AGENT_DB_PASSWORD
docker compose up -d --build
curl http://localhost:3080/api/health
```

| Сервис | Что | Порт на хосте |
|---|---|---|
| `db` | MariaDB 11.8 | `127.0.0.1:53306` (`DB_HOST_PORT`) |
| `api` | NestJS API, применяет миграции при старте | только внутри сети compose |
| `worker` | фоновые задачи (тот же образ, `dist/worker.js`) | — |
| `web` | nginx: фронтенд + прокси `/api` → `api` | `3080` (`APP_HOST_PORT`) |

## Локальная разработка

```bash
npm ci
npm run db:up                                   # только БД в Docker
cp apps/api/.env.example apps/api/.env          # DATABASE_URL на 127.0.0.1:53306
npm run build -w @btx24/shared
npm run prisma:generate
npm run prisma:deploy -w @btx24/api             # применить миграции
npm run dev                                     # api :3000 + web :5173 (прокси /api)
```

## Проверки

```bash
npm run check      # build shared → prisma generate → typecheck → lint → test → build
npm run mcp:test   # тесты MCP-сервера
```

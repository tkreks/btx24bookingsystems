---
name: add-api-endpoint
description: Step-by-step procedure for adding an HTTP endpoint to apps/api (NestJS) and wiring it to apps/web — module, zod-validated input, service, tenant/permission checks, shared contract, tests and docs. Use when asked to add or change an API endpoint.
---

# Новый эндпоинт

1. Найди модуль-владельца: `get_module_context` / `search_code({ kind: "endpoint" })` — чтобы
   не задублировать маршрут. Нет модуля → создай `apps/api/src/modules/<domain>/` по образцу
   `health` (module, controller, service, `MODULE.md`, spec) и подключи в `app.module.ts`
   одной строкой (алфавитный порядок).
2. Контракт запроса/ответа — тип в `packages/shared/src/<domain>.ts` + реэкспорт в `index.ts`.
3. Вход валидируй zod-схемой на границе контроллера.
4. Сервис: бизнес-логика; тенант (`portalId`) берётся только из контекста аутентификации;
   права проверяются здесь же, а не в UI.
5. Контроллер тонкий; маршрут — существительное во множественном числе
   (`/api/bookings/:id/cancel` для действий).
6. Тесты `*.spec.ts`: успешный путь, ошибка валидации, чужой портал (изоляция тенанта),
   для бронирования — граничные интервалы.
7. Web: функция в `apps/web/src/api/<domain>.ts` на типах из `@btx24/shared`.
8. Обнови `MODULE.md` и `docs/features/<фича>.md`; проверь `search_code({ kind: "endpoint" })`.
9. Проверки: `npm run check` (или subset через агента `verifier`).

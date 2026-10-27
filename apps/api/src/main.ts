import 'reflect-metadata';
import type { Request, Response, NextFunction } from 'express';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { Bitrix24ErrorFilter } from './modules/bitrix24/http/bitrix24-error.filter.js';
import { invalidate } from './common/swr-cache.js';
import { requestContext, restSummary, startRestMinuteLog, tagsForEvent, tagsForRequest, type RestStats } from './common/cache-invalidation.js';
import { MessengerServiceClient } from './modules/messengers/messenger-service.client.js';
import { attachVncProxy } from './modules/messengers/vnc-proxy.js';

/** Запрос дольше — в журнал (путь без параметров, кроме части дашборда): видно, какой блок тормозит. */
const SLOW_MS = 3000;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.use((_req: Request, res: Response, next: NextFunction) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const http = new Logger('Http');
  startRestMinuteLog((line) => new Logger('Bitrix24Rest').warn(line));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    const rest: RestStats = { calls: 0, waitMs: 0, methods: new Map() };
    res.on('finish', () => {
      // Изменение сбрасывает только свои разделы кэша дашборда своего портала (вне фрейма портал не
      // известен до проверки сессии — сбрасываем разделы у всех порталов).
      if (res.statusCode < 400) {
        const body = (req.body ?? {}) as { event?: unknown; auth?: { member_id?: unknown } };
        const event = req.method === 'POST' && req.path === '/api/b24/events';
        const tags = event ? tagsForEvent(body.event) : tagsForRequest(req.method, req.path);
        const member = event ? body.auth?.member_id : req.header('x-b24-member-id');
        if (tags) invalidate(typeof member === 'string' && member ? member : null, tags);
      }
      const ms = Date.now() - started;
      if (ms >= SLOW_MS) {
        const part = typeof req.query.part === 'string' ? `?part=${req.query.part.slice(0, 20)}` : '';
        http.warn(`slow ${req.method} ${req.path}${part} ${res.statusCode} ${ms}ms${restSummary(rest)}`);
      }
    });
    const ctx: { res: Response; rest: RestStats; closed?: boolean } = { res, rest };
    // Соединение закрылось до ответа — клиент ответа не ждёт (см. clientGone).
    res.on('close', () => {
      if (!res.writableFinished) ctx.closed = true;
    });
    requestContext.run(ctx, next);
  });
  app.enableShutdownHooks();
  app.useGlobalFilters(new Bitrix24ErrorFilter());
  // Приложение открывается в iframe портала Битрикс24 — не включать X-Frame-Options/
  // frame-ancestors 'self' (например, через helmet по умолчанию): это сломает встраивание.
  // За nginx-контейнером web: доверяем X-Forwarded-* для корректных IP и протокола.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  // Экран мессенджера по VNC — WebSocket мимо Nest (по одноразовому билету администратора).
  attachVncProxy(app.getHttpServer(), app.get(MessengerServiceClient));
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
await bootstrap();

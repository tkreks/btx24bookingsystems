import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  // Приложение открывается в iframe портала Битрикс24 — не включать X-Frame-Options/
  // frame-ancestors 'self' (например, через helmet по умолчанию): это сломает встраивание.
  // За nginx-контейнером web: доверяем X-Forwarded-* для корректных IP и протокола.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
await bootstrap();

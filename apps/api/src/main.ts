import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  // Приложение открывается в iframe портала Битрикс24 — не включать X-Frame-Options/
  // frame-ancestors 'self' (например, через helmet по умолчанию): это сломает встраивание.
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
await bootstrap();

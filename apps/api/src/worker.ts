import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { startRestMinuteLog } from './common/cache-invalidation.js';
import { WorkerModule } from './worker/worker.module.js';

// Точка входа контейнера worker: Nest без HTTP-сервера.
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  // Лимит портала общий с api: видно, сколько REST-вызовов в минуту тратят фоновые задачи.
  startRestMinuteLog((line) => new Logger('Bitrix24Rest').warn(line));
}
await bootstrap();

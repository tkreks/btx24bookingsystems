import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../config/env.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { HeartbeatService } from './heartbeat.service.js';

// Фоновые задачи (обновление кэша календаря, контроль оплат по таймауту, рассылки) живут здесь,
// а не в api: api отвечает на запросы, worker выполняет работу по расписанию.
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule],
  providers: [HeartbeatService],
})
export class WorkerModule {}

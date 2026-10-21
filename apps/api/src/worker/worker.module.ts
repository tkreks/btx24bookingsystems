import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../config/env.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { Bitrix24Module } from '../modules/bitrix24/bitrix24.module.js';
import { OpenlineIndexService } from '../modules/openlines/openline-index.service.js';
import { HeartbeatService } from './heartbeat.service.js';
import { OpenlineIndexJob } from './openline-index.job.js';

// Фоновые задачи (обновление кэша календаря, контроль оплат по таймауту, рассылки) живут здесь,
// а не в api: api отвечает на запросы, worker выполняет работу по расписанию.
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule, Bitrix24Module],
  providers: [HeartbeatService, OpenlineIndexService, OpenlineIndexJob],
})
export class WorkerModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { Bitrix24Module } from './modules/bitrix24/bitrix24.module.js';
import { CalendarModule } from './modules/calendar/calendar.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    // Доменные модули — по одному на строку, в алфавитном порядке (снижает merge-конфликты).
    Bitrix24Module,
    CalendarModule,
    HealthModule,
  ],
})
export class AppModule {}

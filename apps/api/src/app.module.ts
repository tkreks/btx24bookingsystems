import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AccessModule } from './modules/access/access.module.js';
import { Bitrix24Module } from './modules/bitrix24/bitrix24.module.js';
import { BookingsModule } from './modules/bookings/bookings.module.js';
import { CalendarModule } from './modules/calendar/calendar.module.js';
import { GroupsModule } from './modules/groups/groups.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { OpenlinesModule } from './modules/openlines/openlines.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    // Доменные модули — по одному на строку, в алфавитном порядке (снижает merge-конфликты).
    AccessModule,
    Bitrix24Module,
    BookingsModule,
    CalendarModule,
    GroupsModule,
    HealthModule,
    OpenlinesModule,
  ],
})
export class AppModule {}

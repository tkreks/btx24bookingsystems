import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AccessModule } from './modules/access/access.module.js';
import { AuditApiModule } from './modules/audit/audit-api.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { Bitrix24Module } from './modules/bitrix24/bitrix24.module.js';
import { BookingsModule } from './modules/bookings/bookings.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { CalendarModule } from './modules/calendar/calendar.module.js';
import { CertificatesModule } from './modules/certificates/certificates.module.js';
import { GroupsModule } from './modules/groups/groups.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { MessengersModule } from './modules/messengers/messengers.module.js';
import { OpenlinesModule } from './modules/openlines/openlines.module.js';
import { WorkdayModule } from './modules/workday/workday.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    // Доменные модули — по одному на строку, в алфавитном порядке (снижает merge-конфликты).
    AccessModule,
    AuditApiModule,
    AuditModule,
    Bitrix24Module,
    BookingsModule,
    PaymentsModule,
    CalendarModule,
    CertificatesModule,
    GroupsModule,
    HealthModule,
    MessengersModule,
    OpenlinesModule,
    WorkdayModule,
  ],
})
export class AppModule {}

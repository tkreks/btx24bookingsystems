import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../config/env.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../modules/audit/audit.module.js';
import { Bitrix24Module } from '../modules/bitrix24/bitrix24.module.js';
import { BookingAlertsService } from '../modules/bookings/booking-alerts.service.js';
import { BookingJournalService } from '../modules/bookings/booking-journal.service.js';
import { BookingSyncService } from '../modules/bookings/booking-sync.service.js';
import { OpenlineIndexService } from '../modules/openlines/openline-index.service.js';
import { BookingSyncJob } from './booking-sync.job.js';
import { HeartbeatService } from './heartbeat.service.js';
import { OpenlineIndexJob } from './openline-index.job.js';
import { PaymentJob } from './payment.job.js';
import { BookingTypeJob } from './booking-type.job.js';
import { BookingTypeFillService } from '../modules/bookings/booking-type-fill.service.js';
import { PaymentFlow } from '../modules/payments/payment-flow.js';
import { PaidAmountService } from '../modules/payments/paid-amount.service.js';
import { PaidAmountJob } from './paid-amount.job.js';
import { DealFieldMapService } from '../modules/bookings/deal-field-map.service.js';
import { MessageContextService } from '../modules/bookings/message-context.service.js';

// Фоновые задачи (обновление кэша календаря, контроль оплат по таймауту, рассылки) живут здесь,
// а не в api: api отвечает на запросы, worker выполняет работу по расписанию.
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule, Bitrix24Module, AuditModule],
  providers: [
    HeartbeatService,
    OpenlineIndexService,
    OpenlineIndexJob,
    BookingJournalService,
    BookingAlertsService,
    BookingSyncService,
    BookingSyncJob,
    DealFieldMapService,
    MessageContextService,
    PaymentFlow,
    PaymentJob,
    PaidAmountService,
    PaidAmountJob,
    BookingTypeFillService,
    BookingTypeJob,
  ],
})
export class WorkerModule {}

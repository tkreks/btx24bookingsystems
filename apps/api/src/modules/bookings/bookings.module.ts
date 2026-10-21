import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { Bitrix24Module } from '../bitrix24/bitrix24.module.js';
import { BookingsController, BookingSyncAdminController } from './bookings.controller.js';
import { BookingAlertsService } from './booking-alerts.service.js';
import { BookingJournalService } from './booking-journal.service.js';
import { BookingSyncService } from './booking-sync.service.js';

@Module({
  imports: [AccessModule, Bitrix24Module],
  controllers: [BookingsController, BookingSyncAdminController],
  providers: [BookingJournalService, BookingAlertsService, BookingSyncService],
  exports: [BookingJournalService, BookingAlertsService, BookingSyncService],
})
export class BookingsModule {}

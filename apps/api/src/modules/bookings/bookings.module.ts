import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { Bitrix24Module } from '../bitrix24/bitrix24.module.js';
import { BookingsController, BookingSyncAdminController } from './bookings.controller.js';
import { ClientMessagesAdminController } from './client-messages.controller.js';
import { BookingAlertsService } from './booking-alerts.service.js';
import { BookingCreateService } from './booking-create.service.js';
import { ClientBookingsService } from './client-bookings.service.js';
import { DealFieldMapService } from './deal-field-map.service.js';
import { BookingJournalService } from './booking-journal.service.js';
import { BookingSyncService } from './booking-sync.service.js';

@Module({
  imports: [AccessModule, Bitrix24Module],
  controllers: [BookingsController, BookingSyncAdminController, ClientMessagesAdminController],
  providers: [
    BookingJournalService,
    BookingAlertsService,
    BookingSyncService,
    BookingCreateService,
    ClientBookingsService,
    DealFieldMapService,
  ],
  exports: [BookingJournalService, BookingAlertsService, BookingSyncService, DealFieldMapService],
})
export class BookingsModule {}

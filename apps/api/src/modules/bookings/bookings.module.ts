import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { Bitrix24Module } from '../bitrix24/bitrix24.module.js';
import { BookingsController, BookingSyncAdminController } from './bookings.controller.js';
import { ClientMessagesAdminController } from './client-messages.controller.js';
import { BookingAlertsService } from './booking-alerts.service.js';
import { BookingCancelService } from './booking-cancel.service.js';
import { BookingDirectoryService } from './booking-directory.service.js';
import { BookingCreateService } from './booking-create.service.js';
import { BookingRestoreService } from './booking-restore.service.js';
import { ClientBookingsService } from './client-bookings.service.js';
import { DealPaymentsService } from './deal-payments.service.js';
import { DealStatusService } from './deal-status.service.js';
import { ResourceStopsService } from './resource-stops.service.js';
import { DealFieldMapService } from './deal-field-map.service.js';
import { DealFormService } from './deal-form.service.js';
import { BookingJournalService } from './booking-journal.service.js';
import { BookingSyncService } from './booking-sync.service.js';
import { MessageContextService } from './message-context.service.js';

@Module({
  imports: [AccessModule, Bitrix24Module],
  controllers: [BookingsController, BookingSyncAdminController, ClientMessagesAdminController],
  providers: [
    BookingJournalService,
    BookingAlertsService,
    BookingSyncService,
    BookingCreateService,
    BookingRestoreService,
    BookingCancelService,
    BookingDirectoryService,
    ClientBookingsService,
    DealFieldMapService,
    DealFormService,
    DealPaymentsService,
    DealStatusService,
    MessageContextService,
    ResourceStopsService,
  ],
  exports: [BookingJournalService, BookingAlertsService, BookingSyncService, DealFieldMapService, DealPaymentsService, DealStatusService, MessageContextService, ResourceStopsService],
})
export class BookingsModule {}

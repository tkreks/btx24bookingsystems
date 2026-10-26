import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { Bitrix24Module } from '../bitrix24/bitrix24.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { MessengersModule } from '../messengers/messengers.module.js';
import { PaymentFlow } from './payment-flow.js';
import { PaymentsAdminController } from './payments-admin.controller.js';
import { PaymentsController } from './payments.controller.js';
import { PaidAmountService } from './paid-amount.service.js';
import { PaymentsService } from './payments.service.js';

@Module({
  imports: [AccessModule, Bitrix24Module, BookingsModule, MessengersModule],
  controllers: [PaymentsController, PaymentsAdminController],
  providers: [PaymentFlow, PaymentsService, PaidAmountService],
  exports: [PaymentFlow, PaidAmountService],
})
export class PaymentsModule {}

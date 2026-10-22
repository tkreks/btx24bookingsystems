import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Query, UseGuards } from '@nestjs/common';
import { PAYMENT_KINDS, type PaymentKind, type PaymentPreviewDto, type PaymentRequestDto } from '@btx24/shared';
import { AccessService } from '../access/access.service.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { PaymentsService } from './payments.service.js';

const int = (v: string | undefined, name: string) => {
  if (!v || !/^\d{1,10}$/.test(v)) throw new BadRequestException({ code: 'INVALID_QUERY', message: `${name}: целое число` });
  return Number(v);
};

/** Счета и ссылки на оплату сделки (ADR 0009). Выставить — `payment.send` (проверяет сервис). */
@Controller('payments')
@UseGuards(B24AuthGuard)
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly access: AccessService,
  ) {}

  @Get('preview')
  preview(
    @B24User() user: B24UserContext,
    @Query('dealId') dealId?: string,
    @Query('kind') kind?: string,
    @Query('groupId') groupId?: string,
    @Query('bookingId') bookingId?: string,
  ): Promise<PaymentPreviewDto> {
    if (!PAYMENT_KINDS.includes(kind as PaymentKind)) throw new BadRequestException({ code: 'INVALID_QUERY', message: 'kind: prepayment | surcharge' });
    return this.payments.preview(user, int(dealId, 'dealId'), kind as PaymentKind, groupId || undefined, bookingId ? int(bookingId, 'bookingId') : undefined);
  }

  @Post()
  create(@B24User() user: B24UserContext, @Body() body: unknown): Promise<PaymentRequestDto> {
    return this.payments.create(user, body);
  }

  /** Счета сделки — видят те, кому доступны данные броней. */
  @Get()
  async list(@B24User() user: B24UserContext, @Query('dealId') dealId?: string): Promise<PaymentRequestDto[]> {
    const a = await this.access.resolve(user);
    if (!a.isAppAdmin && !this.access.pick(a, undefined, 'booking.details'))
      throw new ForbiddenException({ code: 'NO_BOOKING_ACCESS', message: 'Недостаточно прав' });
    return this.payments.list(user, int(dealId, 'dealId'));
  }
}

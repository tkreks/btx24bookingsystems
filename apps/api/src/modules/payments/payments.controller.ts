import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  PAYMENT_REQUEST_KINDS,
  type AwaitingInvoicesDto,
  type ClientInvoicesDto,
  type DealInvoicesDto,
  type InvoiceViewDto,
  type PaymentDealOptionsDto,
  type PaymentPreviewDto,
  type PaymentRequestDto,
  type PaymentRequestKind,
} from '@btx24/shared';
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
    @Query('templateId') templateId?: string,
  ): Promise<PaymentPreviewDto> {
    if (!PAYMENT_REQUEST_KINDS.includes(kind as PaymentRequestKind)) throw new BadRequestException({ code: 'INVALID_QUERY', message: 'kind: custom | prepayment | surcharge' });
    if (templateId && !/^[a-z0-9]{1,40}$/i.test(templateId)) throw new BadRequestException({ code: 'INVALID_QUERY', message: 'templateId: ID шаблона' });
    return this.payments.preview(user, int(dealId, 'dealId'), kind as PaymentRequestKind, groupId || undefined, bookingId ? int(bookingId, 'bookingId') : undefined, templateId || undefined);
  }

  /** Сделки клиента в работе для счёта (новые сверху) — выбор в окне счетов. */
  @Get('deal-options')
  async dealOptions(@B24User() user: B24UserContext, @Query('dealId') dealId?: string): Promise<PaymentDealOptionsDto> {
    await this.requireDetails(user);
    return this.payments.dealOptions(user, int(dealId, 'dealId'));
  }

  @Post()
  create(@B24User() user: B24UserContext, @Body() body: unknown): Promise<PaymentRequestDto> {
    return this.payments.create(user, body);
  }

  /** Заявки на оплату сделки — видят те, кому доступны данные броней. */
  @Get()
  async list(@B24User() user: B24UserContext, @Query('dealId') dealId?: string): Promise<PaymentRequestDto[]> {
    await this.requireDetails(user);
    return this.payments.list(user, int(dealId, 'dealId'));
  }

  /** Все счета сделки со стадиями (и заявками приложения) — «в работе» и «все счета». */
  @Get('invoices')
  async invoices(@B24User() user: B24UserContext, @Query('dealId') dealId?: string): Promise<DealInvoicesDto> {
    await this.requireDetails(user);
    return this.payments.invoices(user, int(dealId, 'dealId'));
  }

  /** Счета клиента сделки (все его сделки) со статусами: активные и архив — блок встройки. */
  @Get('client-invoices')
  async clientInvoices(@B24User() user: B24UserContext, @Query('dealId') dealId?: string): Promise<ClientInvoicesDto> {
    await this.requireDetails(user);
    return this.payments.clientInvoices(user, int(dealId, 'dealId'));
  }

  /** Счёт в режиме просмотра (окно как в шаге выставления) — по нажатию на счёт во встройке. */
  @Get('invoice-view')
  async invoiceView(@B24User() user: B24UserContext, @Query('dealId') dealId?: string, @Query('invoiceId') invoiceId?: string): Promise<InvoiceViewDto> {
    await this.requireDetails(user);
    return this.payments.invoiceView(user, int(dealId, 'dealId'), int(invoiceId, 'invoiceId'));
  }

  /** Счета, ждущие оплату (ссылка у клиента, срок идёт), — блок дашборда. */
  @Get('awaiting')
  async awaiting(@B24User() user: B24UserContext): Promise<AwaitingInvoicesDto> {
    await this.requireDetails(user);
    return this.payments.awaiting(user);
  }

  /** Отправить клиенту выставленный счёт (статус «Выставлен»); право проверяет сервис. */
  @Post('requests/:id/send')
  send(@B24User() user: B24UserContext, @Param('id') id: string): Promise<PaymentRequestDto> {
    if (!/^[a-z0-9-]{1,40}$/i.test(id)) throw new BadRequestException({ code: 'INVALID_QUERY', message: 'id: идентификатор заявки' });
    return this.payments.send(user, id);
  }

  private async requireDetails(user: B24UserContext): Promise<void> {
    const a = await this.access.resolve(user);
    if (!a.isAppAdmin && !this.access.pick(a, undefined, 'booking.details'))
      throw new ForbiddenException({ code: 'NO_BOOKING_ACCESS', message: 'Недостаточно прав' });
  }
}

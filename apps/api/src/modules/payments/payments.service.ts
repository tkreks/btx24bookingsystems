import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  DEFAULT_CLIENT_MESSAGE,
  DEFAULT_SURCHARGE_MESSAGE,
  PAYMENT_KINDS,
  moneyValue,
  paymentAmount,
  renderTemplate,
  type GroupOptionsDto,
  type PaymentKind,
  type PaymentPreviewDto,
  type PaymentRequestDto,
} from '@btx24/shared';
import { z } from 'zod';
import { Prisma, type PaymentRequest } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessService, type GroupAccess } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import { msg, PaymentFlow, type FlowContext } from './payment-flow.js';

const createSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(64),
    dealId: z.number().int().positive(),
    kind: z.enum(PAYMENT_KINDS),
    groupId: z.string().min(1).max(40).optional(),
    amount: z.number().positive().max(10_000_000).nullable().optional(),
    bookingId: z.number().int().positive().nullable().optional(),
  })
  .strict();

/** Сколько ждать ссылку прямо в запросе сотрудника; дальше доводит worker. */
const INLINE_LINK_WAIT_MS = 20_000;
const POLL_MS = 2_000;

/**
 * Счёт и ссылка на оплату по запросу сотрудника (ADR 0009). Право — `payment.send` в группе,
 * чья воронка совпадает с воронкой сделки. Все вызовы — токеном сотрудника.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly fieldMap: DealFieldMapService,
    private readonly flow: PaymentFlow,
  ) {}

  /** Пауза между проверками ссылки (в тестах подменяется). */
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async preview(user: B24UserContext, dealId: number, kind: PaymentKind, groupId?: string, bookingId?: number): Promise<PaymentPreviewDto> {
    const deal = await this.flow.deal(user, dealId);
    if (!deal) throw new BadRequestException({ code: 'DEAL_NOT_FOUND', message: `Сделка #${dealId} не найдена или нет доступа` });
    const g = await this.group(user, Number(deal.CATEGORY_ID ?? 0), groupId, bookingId);
    const problems: string[] = [];
    if (!g) problems.push('Нет права «Отправка ссылок на оплату» в группе с воронкой этой сделки');
    const opts = (g?.group.options ?? null) as GroupOptionsDto | null;
    if (g && !opts?.payments.invoice) problems.push(`Счёт не настроен в группе «${g.group.name}» (⚙ → группа → «Оплаты»)`);
    const map = await this.fieldMap.get(user.portal.id);
    const a = paymentAmount(kind, {
      fixed: opts?.payments.prepaymentAmount ?? null,
      manual: moneyValue(deal[(kind === 'prepayment' ? map.prepayment : map.surcharge) ?? '']),
      opportunity: Number(deal.OPPORTUNITY) || null,
      percent: opts?.payments.prepaymentPercent ?? null,
    });
    if (a.amount === null)
      problems.push(kind === 'surcharge' ? 'Заполните «Ручную сумму доплаты» в сделке или укажите сумму' : 'Нет суммы: заполните сделку или укажите сумму');
    const minutes = kind === 'prepayment' ? (opts?.payments.timeoutMinutes ?? null) : null;
    const ctx: FlowContext = { portal: user.portal, client: user.client, actor: { kind: 'user', userId: user.userId, name: user.userName } };
    const template = kind === 'prepayment' ? opts?.payments.clientMessage || DEFAULT_CLIENT_MESSAGE : opts?.payments.surchargeMessage || DEFAULT_SURCHARGE_MESSAGE;
    const message = renderTemplate(template, {
      ...(await this.flow.vars(ctx, deal, map)),
      prepayment: a.amount !== null ? new Intl.NumberFormat('ru-RU').format(a.amount) : '',
      minutes: minutes ?? '',
    });
    return { dealId, kind, groupId: g?.group.id ?? null, groupName: g?.group.name ?? null, amount: a.amount, source: a.source, timeoutMinutes: minutes, message, problems };
  }

  async create(user: B24UserContext, body: unknown): Promise<PaymentRequestDto> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_PAYMENT', message: parsed.error.issues.map((i) => i.message).join('; ') });
    const b = parsed.data;

    const prev = await this.prisma.paymentRequest.findUnique({ where: { portalId_idempotencyKey: { portalId: user.portal.id, idempotencyKey: b.idempotencyKey } } });
    if (prev) return toDto(prev);

    const p = await this.preview(user, b.dealId, b.kind, b.groupId, b.bookingId ?? undefined);
    const amount = b.amount ?? p.amount;
    const blocking = p.problems.filter((x) => !(b.amount && x.includes('сумм')));
    if (blocking.length || !p.groupId || !amount) throw new BadRequestException({ code: 'PAYMENT_NOT_READY', message: blocking.join('; ') || 'Нет суммы' });
    const active = await this.prisma.paymentRequest.findFirst({
      where: { portalId: user.portal.id, dealId: b.dealId, kind: b.kind, status: { in: ['link_pending', 'sent'] } },
    });
    if (active) throw new ConflictException({ code: 'PAYMENT_ACTIVE', message: 'По этой сделке уже выставлен такой счёт и ждём оплату' });

    const g = (await this.access.resolve(user)).groups.find((x) => x.group.id === p.groupId)!;
    const opts = g.group.options as unknown as GroupOptionsDto;
    const inv = opts.payments.invoice!;
    let req = await this.prisma.paymentRequest.create({
      data: {
        portalId: user.portal.id,
        idempotencyKey: b.idempotencyKey,
        dealId: b.dealId,
        bookingId: b.bookingId ?? null,
        groupId: g.group.id,
        kind: b.kind,
        amount: new Prisma.Decimal(amount),
        createdByUserId: user.userId,
        createdByName: user.userName,
        warnings: [],
      },
    });
    const ctx: FlowContext = { portal: user.portal, client: user.client, actor: { kind: 'user', userId: user.userId, name: user.userName } };
    const deal = await this.flow.deal(user, b.dealId);
    try {
      const contactId = Number(deal?.CONTACT_ID) || 0;
      const res = await user.client.call<{ item?: { id?: number } }>('crm.item.add', {
        entityTypeId: 31,
        fields: {
          title: `Счёт на ${b.kind === 'prepayment' ? 'предоплату' : 'доплату'} по сделке #${b.dealId}`,
          categoryId: inv.categoryId,
          stageId: b.kind === 'prepayment' ? inv.prepaymentStageId : inv.surchargeStageId,
          assignedById: Number(deal?.ASSIGNED_BY_ID) || user.userId,
          ...(contactId ? { contactId, contactIds: [contactId] } : {}),
          currencyId: 'RUB',
          isManualOpportunity: 'Y',
          opportunity: amount,
          comments: `Выставлен из приложения бронирования (${p.source === 'fixed' ? 'фиксированная сумма группы' : p.source === 'manual' ? 'ручная сумма из сделки' : p.source === 'percent' ? 'процент от суммы сделки' : 'сумма указана сотрудником'})`,
          parentId2: b.dealId,
          ...inv.fields,
        },
      });
      const invoiceId = Number(res.result?.item?.id);
      if (!(invoiceId > 0)) throw new Error('Портал не вернул ID счёта');
      req = await this.prisma.paymentRequest.update({ where: { id: req.id }, data: { invoiceId } });
    } catch (e) {
      await this.prisma.paymentRequest.update({ where: { id: req.id }, data: { status: 'failed', error: msg(e), closedAt: new Date() } });
      throw e;
    }

    // ID счёта в сделку (по нему автоматизация портала считает внесённые оплаты), стадия оплаты.
    const warnings: string[] = [];
    const map = await this.fieldMap.get(user.portal.id);
    const idField = b.kind === 'prepayment' ? map.prepaymentInvoiceId : map.surchargeInvoiceId;
    const step = opts.payments[b.kind];
    const fields: Record<string, unknown> = { ...(idField ? { [idField]: req.invoiceId } : {}), ...(step.moveStage && step.stageId ? { STAGE_ID: step.stageId } : {}) };
    if (Object.keys(fields).length) await this.flow.dealUpdate(ctx, b.dealId, fields, warnings, 'ID счёта и стадия');
    if (warnings.length) req = await this.prisma.paymentRequest.update({ where: { id: req.id }, data: { warnings } });

    // Ссылку ставит портал (робот счёта) — обычно за секунды; не дождались — доведёт worker.
    for (let waited = 0; req.status === 'link_pending' && waited < INLINE_LINK_WAIT_MS; waited += POLL_MS) {
      await this.sleep(POLL_MS);
      try {
        req = await this.flow.awaitLink(ctx, req);
      } catch {
        break; // сбой чтения — не повод для ошибки сотруднику: worker повторит
      }
    }
    return toDto(req);
  }

  async list(user: B24UserContext, dealId: number): Promise<PaymentRequestDto[]> {
    const rows = await this.prisma.paymentRequest.findMany({ where: { portalId: user.portal.id, dealId }, orderBy: { createdAt: 'desc' }, take: 20 });
    return rows.map(toDto);
  }

  /** Группа сотрудника с правом `payment.send`: указанная, группа брони или по воронке сделки. */
  private async group(user: B24UserContext, categoryId: number, groupId?: string, bookingId?: number): Promise<GroupAccess | null> {
    const a = await this.access.resolve(user);
    const can = a.groups.filter((g) => g.permissions.includes('payment.send') && (g.group.dealCategoryId ?? 0) === categoryId);
    if (groupId) return can.find((g) => g.group.id === groupId) ?? null;
    if (bookingId) {
      const rec = await this.prisma.bookingRecord.findUnique({ where: { portalId_bookingId: { portalId: user.portal.id, bookingId } } });
      const hit = can.find((g) => g.group.id === rec?.groupId);
      if (hit) return hit;
    }
    return can.find((g) => (g.group.options as GroupOptionsDto | null)?.payments.invoice) ?? can[0] ?? null;
  }
}

export function toDto(r: PaymentRequest): PaymentRequestDto {
  return {
    id: r.id,
    dealId: r.dealId,
    bookingId: r.bookingId,
    kind: r.kind,
    amount: Number(r.amount),
    invoiceId: r.invoiceId,
    link: r.link,
    status: r.status,
    deadline: r.deadlineAt?.toISOString() ?? null,
    messageSent: !!r.messageSentAt,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdByName,
    error: r.error,
    warnings: Array.isArray(r.warnings) ? (r.warnings as string[]) : [],
  };
}

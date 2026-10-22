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
  type DealInvoicesDto,
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

  /**
   * Все смарт-счета сделки из Битрикс24 (правами сотрудника) со стадией и, если счёт выставило
   * приложение, — заявкой (ссылка, срок оплаты). Заявки без счёта (сбой создания) — в конце.
   */
  async invoices(user: B24UserContext, dealId: number): Promise<DealInvoicesDto> {
    const items = await user.client.listAll<{ id: number; title?: string; opportunity?: number; currencyId?: string; stageId?: string; categoryId?: number; createdTime?: string }>(
      'crm.item.list',
      { entityTypeId: 31, filter: { parentId2: dealId }, select: ['id', 'title', 'opportunity', 'currencyId', 'stageId', 'categoryId', 'createdTime'], order: { id: 'desc' } },
      { max: 200, pick: (r) => ((r as { items?: never[] })?.items ?? []) },
    );
    const stages = await this.invoiceStages(user, [...new Set(items.map((i) => Number(i.categoryId ?? 0)))]);
    const reqs = await this.prisma.paymentRequest.findMany({ where: { portalId: user.portal.id, dealId }, orderBy: { createdAt: 'desc' } });
    const byInvoice = new Map(reqs.filter((r) => r.invoiceId).map((r) => [r.invoiceId!, r]));
    const invoices = items.map((i) => {
      const st = stages.get(String(i.stageId ?? ''));
      const sem = st?.semantics ?? (String(i.stageId).endsWith(':P') ? 'S' : String(i.stageId).endsWith(':D') ? 'F' : '');
      const req = byInvoice.get(Number(i.id));
      return {
        invoiceId: Number(i.id),
        title: i.title ?? `Счёт #${i.id}`,
        amount: Number(i.opportunity ?? 0),
        currency: i.currencyId ?? 'RUB',
        stageId: String(i.stageId ?? ''),
        stageName: st?.name ?? String(i.stageId ?? ''),
        state: sem === 'S' ? ('paid' as const) : sem === 'F' ? ('failed' as const) : ('open' as const),
        createdAt: i.createdTime ? new Date(i.createdTime).toISOString() : '',
        request: req ? toDto(req) : null,
      };
    });
    // Заявки, у которых счёт не создался, — видны в «Все счета» как ошибка.
    for (const r of reqs.filter((x) => !x.invoiceId))
      invoices.push({ invoiceId: 0, title: 'Счёт не создан', amount: Number(r.amount), currency: 'RUB', stageId: '', stageName: '', state: 'failed', createdAt: r.createdAt.toISOString(), request: toDto(r) });
    return { dealId, invoices };
  }

  private readonly stageCache = new Map<string, { map: Map<string, { name: string; semantics: string }>; expiresAt: number }>();

  /** Стадии смарт-счетов по воронкам (кэш 10 минут на портал). */
  private async invoiceStages(user: B24UserContext, categories: number[]): Promise<Map<string, { name: string; semantics: string }>> {
    const key = `${user.portal.id}:${categories.sort().join(',')}`;
    const hit = this.stageCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.map;
    const map = new Map<string, { name: string; semantics: string }>();
    for (const c of categories) {
      try {
        const r = await user.client.call<{ STATUS_ID: string; NAME: string; SEMANTICS?: string | null }[]>('crm.status.list', { filter: { ENTITY_ID: `SMART_INVOICE_STAGE_${c}` } });
        for (const s of Array.isArray(r.result) ? r.result : []) map.set(s.STATUS_ID, { name: s.NAME, semantics: s.SEMANTICS ?? '' });
      } catch {
        /* без названий стадий — покажем код */
      }
    }
    this.stageCache.set(key, { map, expiresAt: Date.now() + 10 * 60_000 });
    return map;
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

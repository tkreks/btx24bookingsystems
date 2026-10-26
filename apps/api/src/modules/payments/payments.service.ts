import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  PAYMENT_REQUEST_KINDS,
  PAYMENT_MAX_TIMEOUT_HOURS,
  DEFAULT_PAYMENT_LINK_MESSAGE,
  type PaymentRequestKind,
  moneyValue,
  paymentAmount,
  renderMessage,
  type GroupOptionsDto,
  type PaymentAmountSource,
  BOOKING_REQUIRED_MESSAGE,
  type DealInvoicesDto,
  type ClientInvoicesDto,
  type PaymentBookingOption,
  type PaymentDealOptionsDto,
  type PaymentPreviewDto,
  type PaymentRequestDto,
} from '@btx24/shared';
import { z } from 'zod';
import { Prisma, type PaymentRequest } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessService, type GroupAccess } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import { isCertificatePurchase } from '../bookings/deal-outcome.js';
import { msg, PaymentFlow, type FlowContext } from './payment-flow.js';

const createSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(64),
    dealId: z.number().int().positive(),
    kind: z.enum(PAYMENT_REQUEST_KINDS),
    groupId: z.string().min(1).max(40).optional(),
    amount: z.number().positive().max(10_000_000).nullable().optional(),
    bookingId: z.number().int().positive().nullable().optional(),
    // Встройка сделки: основание, свой срок (часы) и свой текст клиенту (`{{СсылкаНаОплату}}` — ссылка).
    purpose: z.string().trim().min(1).max(200).optional(),
    timeoutHours: z.number().int().min(1).max(PAYMENT_MAX_TIMEOUT_HOURS).nullable().optional(),
    message: z.string().trim().min(1).max(4000).optional(),
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

  async preview(user: B24UserContext, dealId: number, kind: PaymentRequestKind, groupId?: string, bookingId?: number): Promise<PaymentPreviewDto> {
    // Произвольная: сумму, основание и срок задаёт сотрудник; брони не требует, шаблон — свой текст.
    const custom = kind === 'custom';
    const deal = await this.flow.deal(user, dealId);
    if (!deal) throw new BadRequestException({ code: 'DEAL_NOT_FOUND', message: `Сделка #${dealId} не найдена или нет доступа` });
    // Бронь сделки: к ней привязывается счёт (неоплата в срок снимает именно её), её группа — группа счёта.
    const bookings = await this.dealBookings(user, dealId);
    const chosenBooking = bookings.find((x) => x.bookingId === bookingId)?.bookingId ?? bookings[0]?.bookingId ?? null;
    const { group: g, options: groupOptions } = await this.group(user, Number(deal.CATEGORY_ID ?? 0), groupId, chosenBooking ?? undefined);
    const problems: string[] = [];
    if (!g) problems.push('Нет права «Отправка ссылок на оплату» в группе с воронкой этой сделки');
    const opts = (g?.group.options ?? null) as GroupOptionsDto | null;
    if (g && !opts?.payments.invoice) problems.push(`Счёт не настроен в группе «${g.group.name}» (⚙ → группа → «Оплаты»)`);
    const map = await this.fieldMap.get(user.portal.id);
    // Покупка сертификата: платят весь номинал (сумма сделки), брони у такой сделки не бывает.
    const certificate = isCertificatePurchase(deal, await this.fieldMap.outcome(user.portal.id, user.client).catch(() => ({ certificateTypeId: null })));
    const opportunity = Number(deal.OPPORTUNITY) || null;
    const a: { amount: number | null; source: PaymentAmountSource } = custom
      ? { amount: null, source: 'none' }
      : certificate && kind === 'prepayment'
        ? { amount: opportunity, source: opportunity ? 'certificate' : 'none' }
        : paymentAmount(kind, {
            fixed: opts?.payments.prepaymentAmount ?? null,
            manual: moneyValue(deal[(kind === 'prepayment' ? map.prepayment : map.surcharge) ?? '']),
            opportunity,
            percent: opts?.payments.prepaymentPercent ?? null,
          });
    if (a.amount === null && !custom)
      problems.push(kind === 'surcharge' ? 'Заполните «Ручную сумму доплаты» в сделке или укажите сумму' : 'Нет суммы: заполните сделку или укажите сумму');
    if (deal.STAGE_SEMANTIC_ID && deal.STAGE_SEMANTIC_ID !== 'P') problems.push(`Сделка #${dealId} закрыта — выберите сделку в работе`);
    const requireBooking = opts?.payments.requireBooking !== false && !certificate && !custom;
    const bookingMissing = requireBooking && !bookings.length;
    // Бронь у сделки есть, но уже прошла: счёт к ней не привязать (неоплата снимает будущую бронь).
    const pastBooking = bookingMissing ? await this.lastPastBooking(user, dealId) : null;
    if (bookingMissing) problems.push(BOOKING_REQUIRED_MESSAGE);
    const minutes = kind === 'prepayment' ? (opts?.payments.timeoutMinutes ?? null) : null;
    const ctx: FlowContext = { portal: user.portal, client: user.client, actor: { kind: 'user', userId: user.userId, name: user.userName } };
    const tpl = custom ? { name: null, steps: [{ text: DEFAULT_PAYMENT_LINK_MESSAGE, files: [] }] } : await this.flow.paymentTemplate(user.portal.id, kind, opts);
    const mc = await this.flow.messages(ctx, dealId);
    const vars = { ...mc.vars, prepayment: a.amount !== null ? new Intl.NumberFormat('ru-RU').format(a.amount).replace(/[\u00a0\u202f]/g, ' ') : '', minutes: minutes ?? '' };
    const message = tpl.steps
      .map((st) => [renderMessage(st.text, { ...mc, vars }), ...st.files.map(() => '📎 файл из шаблона')].filter((x) => x.trim()).join('\n'))
      .filter(Boolean)
      .join('\n\n');
    return {
      dealId,
      kind,
      groupId: g?.group.id ?? null,
      groupName: g?.group.name ?? null,
      groupOptions,
      templateName: tpl.name,
      amount: a.amount,
      source: a.source,
      timeoutMinutes: minutes,
      message,
      problems,
      requireBooking,
      bookings,
      bookingId: custom ? null : chosenBooking,
      bookingMissing,
      pastBooking,
    };
  }

  private async lastPastBooking(user: B24UserContext, dealId: number): Promise<PaymentBookingOption | null> {
    const r = await this.prisma.bookingRecord.findFirst({ where: { portalId: user.portal.id, dealId, status: 'active', endsAt: { lte: new Date() } }, orderBy: { startsAt: 'desc' } });
    return r ? { bookingId: r.bookingId, start: r.startsAt.toISOString(), end: r.endsAt.toISOString(), resources: [] } : null;
  }

  /** Действующие брони сделки (журнал приложения: свои и найденные сверкой), ближайшие сверху. */
  private async dealBookings(user: B24UserContext, dealId: number): Promise<PaymentBookingOption[]> {
    const rows = await this.prisma.bookingRecord.findMany({
      where: { portalId: user.portal.id, dealId, status: 'active', endsAt: { gt: new Date() } },
      orderBy: { startsAt: 'asc' },
      take: 20,
    });
    if (!rows.length) return [];
    const ids = [...new Set(rows.flatMap((r) => (r.resourceIds as number[]) ?? []))];
    const names = new Map((await this.prisma.resource.findMany({ where: { portalId: user.portal.id, resourceId: { in: ids } } })).map((r) => [r.resourceId, r.name]));
    return rows.map((r) => ({
      bookingId: r.bookingId,
      start: r.startsAt.toISOString(),
      end: r.endsAt.toISOString(),
      resources: ((r.resourceIds as number[]) ?? []).map((id) => names.get(id) ?? `Ресурс ${id}`),
    }));
  }

  /**
   * Сделки клиента в работе для счёта — новые (по дате создания) сверху; по умолчанию самая новая.
   * Клиент — контакт сделки, из которой открыли окно; без контакта — только она сама.
   */
  async dealOptions(user: B24UserContext, dealId: number): Promise<PaymentDealOptionsDto> {
    const deal = await this.flow.deal(user, dealId);
    if (!deal) throw new BadRequestException({ code: 'DEAL_NOT_FOUND', message: `Сделка #${dealId} не найдена или нет доступа` });
    const contactId = Number(deal.CONTACT_ID) || 0;
    type Row = { ID: string; TITLE?: string; DATE_CREATE?: string; CATEGORY_ID?: string | null; STAGE_SEMANTIC_ID?: string };
    const rows: Row[] = contactId
      ? await user.client.listAll<Row>(
          'crm.deal.list',
          { filter: { CONTACT_ID: contactId, STAGE_SEMANTIC_ID: 'P' }, select: ['ID', 'TITLE', 'DATE_CREATE', 'CATEGORY_ID'], order: { DATE_CREATE: 'DESC' } },
          { max: 50 },
        )
      : deal.STAGE_SEMANTIC_ID === 'P'
        ? [deal as unknown as Row]
        : [];
    const deals = rows
      .map((d) => ({ id: Number(d.ID), title: d.TITLE ?? `Сделка #${d.ID}`, createdAt: d.DATE_CREATE ? new Date(d.DATE_CREATE).toISOString() : '', categoryId: d.CATEGORY_ID == null ? null : Number(d.CATEGORY_ID) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { deals, defaultDealId: deals[0]?.id ?? null };
  }

  async create(user: B24UserContext, body: unknown): Promise<PaymentRequestDto> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_PAYMENT', message: parsed.error.issues.map((i) => i.message).join('; ') });
    const b = parsed.data;

    const prev = await this.prisma.paymentRequest.findUnique({ where: { portalId_idempotencyKey: { portalId: user.portal.id, idempotencyKey: b.idempotencyKey } } });
    if (prev) return toDto(prev);

    const p = await this.preview(user, b.dealId, b.kind, b.groupId, b.bookingId ?? undefined);
    const amount = b.amount ?? p.amount;
    const custom = b.kind === 'custom';
    if (custom && (!b.amount || !b.purpose)) throw new BadRequestException({ code: 'INVALID_PAYMENT', message: 'Произвольная оплата: укажите основание и сумму' });
    const blocking = p.problems.filter((x) => !(b.amount && x.includes('сумм')));
    if (blocking.length || !p.groupId || !amount) throw new BadRequestException({ code: 'PAYMENT_NOT_READY', message: blocking.join('; ') || 'Нет суммы' });
    // Произвольных счетов может быть несколько одновременно (разные основания).
    const active = custom ? null : await this.prisma.paymentRequest.findFirst({
      where: { portalId: user.portal.id, dealId: b.dealId, kind: b.kind, status: { in: ['link_pending', 'sent'] } },
    });
    if (active) throw new ConflictException({ code: 'PAYMENT_ACTIVE', message: 'По этой сделке уже выставлен такой счёт и ждём оплату' });
    // Бронь — только действующая бронь этой сделки; при требовании брони без неё счёт не выставить.
    if (b.bookingId && !p.bookings.some((x) => x.bookingId === b.bookingId))
      throw new BadRequestException({ code: 'BOOKING_NOT_OF_DEAL', message: `Бронь #${b.bookingId} не относится к сделке #${b.dealId} или уже закончилась` });
    const bookingId = b.bookingId ?? (custom ? null : p.bookingId);

    const g = (await this.access.resolve(user)).groups.find((x) => x.group.id === p.groupId)!;
    const opts = g.group.options as unknown as GroupOptionsDto;
    const inv = opts.payments.invoice!;
    let req = await this.prisma.paymentRequest.create({
      data: {
        portalId: user.portal.id,
        idempotencyKey: b.idempotencyKey,
        dealId: b.dealId,
        bookingId,
        groupId: g.group.id,
        kind: b.kind,
        amount: new Prisma.Decimal(amount),
        createdByUserId: user.userId,
        createdByName: user.userName,
        warnings: [],
        purpose: b.purpose ?? null,
        timeoutMinutes: b.timeoutHours ? b.timeoutHours * 60 : null,
        message: b.message ?? null,
      },
    });
    const ctx: FlowContext = { portal: user.portal, client: user.client, actor: { kind: 'user', userId: user.userId, name: user.userName } };
    const deal = await this.flow.deal(user, b.dealId);
    try {
      const contactId = Number(deal?.CONTACT_ID) || 0;
      const res = await user.client.call<{ item?: { id?: number } }>('crm.item.add', {
        entityTypeId: 31,
        fields: {
          // Сделка и бронь — в названии: у одного клиента бывает несколько сделок (в разных воронках).
          title: `${b.purpose ? b.purpose : `Счёт на ${b.kind === 'surcharge' ? 'доплату' : 'предоплату'}`} по сделке #${b.dealId}${bookingId ? `, бронь #${bookingId}` : ''}`.slice(0, 255),
          categoryId: inv.categoryId,
          stageId: b.kind === 'surcharge' ? inv.surchargeStageId : inv.prepaymentStageId,
          assignedById: Number(deal?.ASSIGNED_BY_ID) || user.userId,
          ...(contactId ? { contactId, contactIds: [contactId] } : {}),
          currencyId: 'RUB',
          isManualOpportunity: 'Y',
          opportunity: amount,
          comments: `Выставлен из приложения бронирования (${p.source === 'fixed' ? 'фиксированная сумма группы' : p.source === 'manual' ? 'ручная сумма из сделки' : p.source === 'percent' ? 'процент от суммы сделки' : p.source === 'certificate' ? 'номинал сертификата' : 'сумма указана сотрудником'})${b.purpose ? `. Основание: ${b.purpose}` : ''}`,
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
    // Произвольная — без поля счёта в сделке и без смены стадии (это не предоплата и не доплата группы).
    const idField = custom ? null : b.kind === 'prepayment' ? map.prepaymentInvoiceId : map.surchargeInvoiceId;
    const step = b.kind === 'custom' ? { moveStage: false, stageId: '' } : opts.payments[b.kind];
    // Стадия группы из другой воронки (бронь «Бань» по сделке воронки домиков) — сделку не переносим.
    const moveStage = step.moveStage && !!step.stageId;
    const sameFunnel = moveStage && stageCategory(step.stageId) === Number(deal?.CATEGORY_ID ?? 0);
    if (moveStage && !sameFunnel) warnings.push(`Стадия оплаты группы «${g.group.name}» — из другой воронки, стадия сделки не изменена`);
    const fields: Record<string, unknown> = { ...(idField ? { [idField]: req.invoiceId } : {}), ...(sameFunnel ? { STAGE_ID: step.stageId } : {}) };
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

  /**
   * Счета клиента для встройки сделки — по всем сделкам контакта сделки: ждут оплаты (заявка приложения
   * ещё идёт или счёт открыт) или оплачены, пока у брони счёта (без неё — у его сделки) есть незакончившаяся бронь.
   */
  async clientInvoices(user: B24UserContext, dealId: number, now = new Date()): Promise<ClientInvoicesDto> {
    const deal = await this.flow.deal(user, dealId);
    if (!deal) throw new BadRequestException({ code: 'DEAL_NOT_FOUND', message: `Сделка #${dealId} не найдена или нет доступа` });
    const contactId = Number(deal.CONTACT_ID) || 0;
    const rows = contactId
      ? await user.client.listAll<{ ID: string; TITLE?: string }>('crm.deal.list', { filter: { CONTACT_ID: contactId }, select: ['ID', 'TITLE'], order: { ID: 'DESC' } }, { max: 50 })
      : [];
    const titles = new Map(rows.map((d) => [Number(d.ID), d.TITLE || `Сделка #${d.ID}`]));
    if (!titles.has(dealId)) titles.set(dealId, String(deal.TITLE ?? '') || `Сделка #${dealId}`);
    const ids = [...titles.keys()];
    const items = await user.client.listAll<{ id: number; title?: string; opportunity?: number; currencyId?: string; stageId?: string; categoryId?: number; createdTime?: string; parentId2?: number }>(
      'crm.item.list',
      { entityTypeId: 31, filter: { '@parentId2': ids }, select: ['id', 'title', 'opportunity', 'currencyId', 'stageId', 'categoryId', 'createdTime', 'parentId2'], order: { id: 'desc' } },
      { max: 200, pick: (r) => ((r as { items?: never[] })?.items ?? []) },
    );
    if (!items.length) return { dealId, invoices: [] };
    const stages = await this.invoiceStages(user, [...new Set(items.map((i) => Number(i.categoryId ?? 0)))]);
    const [reqs, live] = await Promise.all([
      this.prisma.paymentRequest.findMany({ where: { portalId: user.portal.id, invoiceId: { in: items.map((i) => Number(i.id)) } } }),
      this.prisma.bookingRecord.findMany({ where: { portalId: user.portal.id, dealId: { in: ids }, status: 'active', endsAt: { gt: now } }, select: { bookingId: true, dealId: true } }),
    ]);
    const byInvoice = new Map(reqs.map((r) => [r.invoiceId!, r]));
    const liveBookings = new Set(live.map((b) => b.bookingId));
    const liveDeals = new Set(live.map((b) => b.dealId));
    const invoices: ClientInvoicesDto['invoices'] = [];
    for (const i of items) {
      const sem = stages.get(String(i.stageId ?? ''))?.semantics ?? (String(i.stageId).endsWith(':P') ? 'S' : String(i.stageId).endsWith(':D') ? 'F' : '');
      const req = byInvoice.get(Number(i.id));
      const owner = Number(i.parentId2);
      const state = sem === 'S' ? 'paid' : sem === 'F' ? null : 'open';
      if (!state) continue;
      if (state === 'open' && req && req.status !== 'link_pending' && req.status !== 'sent') continue;
      if (state === 'paid' && !(req?.bookingId ? liveBookings.has(req.bookingId) : liveDeals.has(owner))) continue;
      invoices.push({
        invoiceId: Number(i.id),
        dealId: owner,
        dealTitle: titles.get(owner) ?? `Сделка #${owner}`,
        thisDeal: owner === dealId,
        amount: Number(i.opportunity ?? 0),
        currency: i.currencyId ?? 'RUB',
        state,
        createdAt: i.createdTime ? new Date(i.createdTime).toISOString() : '',
        purpose: req?.purpose || i.title || `Счёт #${i.id}`,
        deadline: state === 'open' ? (req?.deadlineAt?.toISOString() ?? null) : null,
      });
    }
    invoices.sort((a, b) => (a.state === b.state ? b.createdAt.localeCompare(a.createdAt) : a.state === 'open' ? -1 : 1));
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
  /**
   * Группа счёта: выбранная сотрудником → группа брони (её выбрали в мастере, воронка сделки может
   * быть другой) → группа с воронкой сделки (их бывает несколько — тогда выбор в окне). Право —
   * `payment.send` в этой группе.
   */
  private async group(
    user: B24UserContext,
    categoryId: number,
    groupId?: string,
    bookingId?: number,
  ): Promise<{ group: GroupAccess | null; options: { id: string; name: string }[] }> {
    const a = await this.access.resolve(user);
    const pay = a.groups.filter((g) => g.permissions.includes('payment.send'));
    const rec = bookingId ? await this.prisma.bookingRecord.findUnique({ where: { portalId_bookingId: { portalId: user.portal.id, bookingId } } }) : null;
    // Группа брони — по её ресурсу (ресурс состоит ровно в одной группе); запись журнала — запасной путь.
    const recRes = Array.isArray(rec?.resourceIds) ? (rec.resourceIds as unknown[]).map(Number) : [];
    const own = pay.find((g) => recRes.some((id) => g.group.resourceIds.includes(id))) ?? pay.find((g) => g.group.id === rec?.groupId);
    const can = [...(own ? [own] : []), ...pay.filter((g) => g !== own && (g.group.dealCategoryId ?? 0) === categoryId)];
    const options = can.map((g) => ({ id: g.group.id, name: g.group.name }));
    if (groupId) return { group: can.find((g) => g.group.id === groupId) ?? null, options };
    return { group: own ?? can.find((g) => (g.group.options as GroupOptionsDto | null)?.payments.invoice) ?? can[0] ?? null, options };
  }
}

/** Воронка стадии сделки: `C14:NEW` → 14, стадии общей воронки без префикса → 0. */
export const stageCategory = (stageId: string) => Number(/^C(\d+):/.exec(stageId)?.[1] ?? 0);

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

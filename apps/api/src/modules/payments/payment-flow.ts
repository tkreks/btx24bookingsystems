import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  DEFAULT_CLIENT_MESSAGE,
  DEFAULT_FAIL_MESSAGE,
  DEFAULT_SURCHARGE_MESSAGE,
  renderMessage,
  type ClientMessageStep,
  type MessageContext,
  type GroupOptionsDto,
  type PaymentKind,
  type TemplateStepDto,
} from '@btx24/shared';
import type { PaymentRequest, Portal, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { dealOfBindings } from '../bitrix24/portals/portal.service.js';
import { PaidAmountService } from './paid-amount.service.js';
import { ActionLogService } from '../audit/action-log.service.js';
import { BookingJournalService, SYSTEM } from '../bookings/booking-journal.service.js';
import { dateRu, timeRu } from '../bookings/booking-create.service.js';
import { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import { MessageContextService } from '../bookings/message-context.service.js';

/** Сколько ждать ссылку от портала, прежде чем признать счёт неудачным. */
export const LINK_WAIT_MS = 15 * 60_000;
/** Доплату без срока перестаём отслеживать через 60 дней. */
export const WATCH_LIMIT_MS = 60 * 86_400_000;

type Deal = Record<string, unknown> & { ID: string; TITLE?: string; CATEGORY_ID?: string; CONTACT_ID?: string; ASSIGNED_BY_ID?: string; OPPORTUNITY?: string };
type Invoice = { id: number; stageId?: string; categoryId?: number } & Record<string, unknown>;

export const msg = (e: unknown) => (e instanceof Bitrix24Error ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)).slice(0, 500);
const money = (v: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v).replace(/[\u00a0\u202f]/g, ' ');
/** Стадия счёта «оплачен»: семантика успеха у смарт-счёта — суффикс `:P`. */
export const invoicePaid = (stageId: unknown) => String(stageId ?? '').endsWith(':P');
const invoiceFailed = (stageId: unknown) => String(stageId ?? '').endsWith(':D');

/** Шаг сообщения об оплате до загрузки файлов: текст и ID файлов шаблона (`StoredFile`). */
export interface PaymentMessageStep {
  text: string;
  files: { fileId: string; name: string }[];
}
/** Шаг цепочки к отправке: файл — с Диска Битрикс24 (`id`) или уже загруженный (`data`). */
type ChainStep = { text: string; files: (ClientMessageStep['files'][number] | { name: string; data: Buffer })[] };

export interface FlowContext {
  portal: Portal;
  client: Bitrix24RestClient;
  /** Кто действует: сотрудник (из интерфейса) или система (worker). */
  actor: { kind: 'user'; userId: number; name: string } | { kind: 'system'; name: string };
}

/**
 * Шаги счёта и ссылки на оплату после создания счёта (ADR 0009). Используются и запросом
 * сотрудника (сразу, если портал быстро выдал ссылку), и worker'ом (доводит до конца, следит за
 * оплатой и сроком). Каждый шаг безопасен к повтору: состояние — в `PaymentRequest`.
 * Ссылку на оплату не пишем в логи и ошибки.
 */
@Injectable()
export class PaymentFlow {
  private readonly logger = new Logger(PaymentFlow.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: BookingJournalService,
    private readonly fieldMap: DealFieldMapService,
    private readonly messageContext: MessageContextService,
    @Optional() private readonly actions?: ActionLogService,
    @Optional() private readonly paidAmount?: PaidAmountService,
  ) {}

  /** «Сумма внесённых оплат» сделки — заново по всем её счетам (сбой не мешает остальному). */
  private async refreshPaid(ctx: FlowContext, req: PaymentRequest): Promise<void> {
    try {
      await this.paidAmount?.recompute(ctx.portal.id, ctx.client, req.dealId);
    } catch (e) {
      this.logger.warn(`deal ${req.dealId}: paid amount not recomputed: ${msg(e)}`);
    }
  }

  /** Действие автоматизации оплат — в журнал действий (⚙ → «Журнал действий»). */
  private audit(req: PaymentRequest, action: string, summary: string, details: Record<string, unknown> = {}): Promise<void> | undefined {
    const kind = req.kind === 'prepayment' ? 'предоплата' : 'доплата';
    return this.actions?.log(req.portalId, { kind: 'system', name: 'Система: автоматизация оплат' }, {
      action: `payment.${action}`,
      summary: `${summary} — ${kind} ${money(Number(req.amount))} ₽${req.invoiceId ? `, счёт #${req.invoiceId}` : ''}, сделка #${req.dealId}`,
      entityType: 'deal',
      entityId: req.dealId,
      details: { requestId: req.id, bookingId: req.bookingId, ...details },
      via: 'worker',
    });
  }

  /** Пауза между сообщениями цепочки: каналы доставляют асинхронно (порядок). В тестах — 0. */
  sendGapMs = 1500;
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** Данные сделки для шаблонов; не прочитались — пустые (текст уйдёт с переменными как есть). */
  async messages(ctx: Pick<FlowContext, 'portal' | 'client'>, dealId: number): Promise<MessageContext & { deal: Deal | null }> {
    try {
      const mc = await this.messageContext.forDeal(ctx.portal, ctx.client, dealId);
      return { ...mc, deal: mc.deal as Deal | null };
    } catch (e) {
      this.logger.warn(`deal ${dealId}: message context failed: ${msg(e)}`);
      return { vars: {}, dealByTitle: {}, dealByCode: {}, contact: {}, variables: {}, deal: null };
    }
  }

  async options(req: Pick<PaymentRequest, 'groupId'>): Promise<GroupOptionsDto | null> {
    if (!req.groupId) return null;
    const g = await this.prisma.workGroup.findUnique({ where: { id: req.groupId } });
    return (g?.options ?? null) as GroupOptionsDto | null;
  }

  /** Один шаг автомата: ссылка → сообщение; ожидание → оплачено / срок вышел. */
  async advance(ctx: FlowContext, req: PaymentRequest): Promise<PaymentRequest> {
    if (req.status === 'link_pending') return this.awaitLink(ctx, req);
    if (req.status === 'sent') return this.watch(ctx, req);
    return req;
  }

  /** Есть ли ссылка у счёта; есть — записать в сделку и отправить клиенту. */
  async awaitLink(ctx: FlowContext, req: PaymentRequest): Promise<PaymentRequest> {
    const opts = await this.options(req);
    const inv = opts?.payments.invoice;
    if (!req.invoiceId || !inv) return this.fail(req, 'Нет счёта или настроек счёта группы');
    const invoice = await this.invoice(ctx, req.invoiceId);
    const link = typeof invoice?.[inv.linkField] === 'string' ? String(invoice[inv.linkField]).trim() : '';
    if (!link) {
      if (Date.now() - req.createdAt.getTime() > LINK_WAIT_MS)
        return this.fail(req, 'Портал не поставил ссылку на оплату в счёт за 15 минут — проверьте платёжную систему и роботов счёта');
      return req;
    }
    return this.deliver(ctx, { ...req, link }, opts!);
  }

  /** Ссылка в сделку, сообщение клиенту, комментарий в сделке; срок — с момента отправки. */
  private async deliver(ctx: FlowContext, req: PaymentRequest & { link: string }, opts: GroupOptionsDto): Promise<PaymentRequest> {
    const warnings = this.warningsOf(req);
    const map = await this.fieldMap.get(ctx.portal.id);
    const linkField = req.kind === 'prepayment' ? map.prepaymentLink : map.surchargeLink;
    if (linkField) await this.dealUpdate(ctx, req.dealId, { [linkField]: req.link }, warnings, 'ссылка на оплату');

    const mc = await this.messages(ctx, req.dealId);
    const deal = mc.deal;
    const minutes = req.kind === 'prepayment' ? opts.payments.timeoutMinutes : null;
    const deadline = minutes ? new Date(Date.now() + minutes * 60_000) : null;
    const vars = {
      ...mc.vars,
      prepayment: money(Number(req.amount)),
      link: req.link,
      minutes: minutes ?? '',
      deadline: deadline ? `${timeRu(deadline, ctx.portal.timezone)} ${dateRu(deadline, ctx.portal.timezone)}` : '',
    };
    const tpl = await this.paymentTemplate(ctx.portal.id, req.kind, opts, warnings);
    const steps = await this.withFileData(
      ctx.portal.id,
      tpl.steps.map((st) => ({ ...st, text: renderMessage(st.text, { ...mc, vars }) })),
      warnings,
    );
    const text = steps.map((x) => x.text).filter((x) => x.trim()).join('\n\n');
    const sent = await this.sendChain(ctx, req, deal, steps, warnings);
    await this.audit(req, sent ? 'link_sent' : 'link_not_sent', sent ? 'Ссылка на оплату отправлена клиенту' : 'Ссылка на оплату НЕ отправлена клиенту', {
      deadline: sent ? deadline?.toISOString() : null,
      warnings,
    });
    await this.comment(ctx, req.dealId, `Ссылка на оплату (${req.kind === 'prepayment' ? 'предоплата' : 'доплата'} ${money(Number(req.amount))} ₽, счёт #${req.invoiceId}) ${sent ? 'отправлена клиенту' : 'НЕ отправлена — отправьте вручную'}:\n${text}`, warnings);
    // Срок — только если клиент получил ссылку: иначе бронь снялась бы без его вины.
    return this.prisma.paymentRequest.update({
      where: { id: req.id },
      data: {
        link: req.link,
        status: 'sent',
        messageSentAt: sent ? new Date() : null,
        deadlineAt: sent ? deadline : null,
        warnings: warnings as Prisma.InputJsonValue,
        error: null,
      },
    });
  }

  /** Ожидание оплаты: оплачено → стадия успеха; срок вышел → снять бронь, аннулировать ссылку. */
  async watch(ctx: FlowContext, req: PaymentRequest): Promise<PaymentRequest> {
    if (!req.invoiceId) return req;
    const invoice = await this.invoice(ctx, req.invoiceId);
    if (invoice && invoicePaid(invoice.stageId)) return this.paid(ctx, req);
    if (invoice && invoiceFailed(invoice.stageId)) return this.failedInBitrix(ctx, req);
    if (req.deadlineAt && req.deadlineAt.getTime() <= Date.now()) return this.expire(ctx, req, invoice);
    if (!req.deadlineAt && Date.now() - req.createdAt.getTime() > WATCH_LIMIT_MS) return this.close(req, 'cancelled', 'Оплата не поступила за 60 дней — больше не отслеживаем');
    return req;
  }

  private async paid(ctx: FlowContext, req: PaymentRequest): Promise<PaymentRequest> {
    const opts = await this.options(req);
    const warnings = this.warningsOf(req);
    if (req.kind === 'prepayment' && opts?.payments.successStageId)
      await this.dealUpdate(ctx, req.dealId, { STAGE_ID: opts.payments.successStageId }, warnings, 'стадия «оплачено»');
    if (req.bookingId) {
      const rec = await this.journal.find(ctx.portal.id, req.bookingId);
      if (rec) await this.journal.note(rec, 'paid', { kind: 'system', name: 'Система: оплата получена' }, { kind: req.kind, amount: Number(req.amount), invoiceId: req.invoiceId }, 'worker');
    }
    if (req.kind === 'prepayment' && opts?.payments.sendConfirmation) await this.confirm(ctx, req, opts, warnings);
    await this.audit(req, 'paid', 'Оплата получена', { stageId: opts?.payments.successStageId ?? null, warnings });
    await this.refreshPaid(ctx, req);
    return this.prisma.paymentRequest.update({
      where: { id: req.id },
      data: { status: 'paid', paidAt: new Date(), closedAt: new Date(), warnings: warnings as Prisma.InputJsonValue },
    });
  }

  /**
   * Счёт вручную переведён в «Не оплачен» в Битрикс24: ожидание и таймер снимаются сразу, ссылка
   * аннулируется. Бронь не трогаем и клиенту не пишем — это решение сотрудника, а не неоплата в срок.
   */
  private async failedInBitrix(ctx: FlowContext, req: PaymentRequest): Promise<PaymentRequest> {
    const warnings = this.warningsOf(req);
    if (req.invoiceId) await this.annulPayments(ctx, req.invoiceId, warnings);
    if (req.bookingId) {
      const rec = await this.journal.find(ctx.portal.id, req.bookingId);
      if (rec)
        await this.journal.note(rec, 'payment_cancelled', { kind: 'bitrix', name: 'Битрикс24: счёт переведён в «Не оплачен»' }, { invoiceId: req.invoiceId }, 'worker');
    }
    await this.refreshPaid(ctx, req);
    await this.audit(req, 'cancelled_in_bitrix', 'Счёт переведён в «Не оплачен» в Битрикс24 — ожидание оплаты снято, ссылка аннулирована');
    return this.prisma.paymentRequest.update({
      where: { id: req.id },
      data: {
        status: 'cancelled',
        error: `Счёт переведён в «Не оплачен» в Битрикс24 — ожидание оплаты снято${req.bookingId ? ', бронь не снималась' : ''}`,
        closedAt: new Date(),
        warnings: warnings as Prisma.InputJsonValue,
      },
    });
  }

  /** Срок вышел: ещё раз проверить оплату, затем счёт «не оплачен», оплаты счёта удалить, бронь снять. */
  private async expire(ctx: FlowContext, req: PaymentRequest, invoice: Invoice | null): Promise<PaymentRequest> {
    const opts = await this.options(req);
    const warnings = this.warningsOf(req);
    const cat = invoice?.categoryId ?? opts?.payments.invoice?.categoryId;
    if (req.invoiceId && cat !== undefined)
      await this.safe(warnings, 'счёт → «Не оплачен»', () => ctx.client.call('crm.item.update', { entityTypeId: 31, id: req.invoiceId, fields: { stageId: `DT31_${cat}:D` } }));
    if (req.invoiceId) await this.annulPayments(ctx, req.invoiceId, warnings);

    if (req.bookingId) {
      const rec = await this.journal.find(ctx.portal.id, req.bookingId);
      if (rec?.status === 'active') {
        const removed = await this.safe(warnings, `снять бронь #${req.bookingId}`, () => ctx.client.call('booking.v1.booking.delete', { id: req.bookingId }));
        if (removed) await this.journal.recordCancelled(ctx.portal.id, req.bookingId, { reason: 'payment_timeout', actor: SYSTEM.paymentTimeout, via: 'worker' });
      }
    }
    if (opts?.payments.failStageId) await this.dealUpdate(ctx, req.dealId, { STAGE_ID: opts.payments.failStageId }, warnings, 'стадия «не оплачено»');
    const failText = opts?.payments.failMessage ?? DEFAULT_FAIL_MESSAGE;
    if (failText.trim()) {
      const mc = await this.messages(ctx, req.dealId);
      const text = renderMessage(failText, { ...mc, vars: { ...mc.vars, minutes: opts?.payments.timeoutMinutes ?? '' } });
      await this.sendToClient(ctx, req, mc.deal, text, warnings);
    }
    await this.comment(ctx, req.dealId, `Предоплата по счёту #${req.invoiceId} не поступила в срок: ссылка аннулирована${req.bookingId ? `, бронь #${req.bookingId} снята` : ''}.`, warnings);
    await this.refreshPaid(ctx, req);
    await this.audit(req, 'expired', `Срок оплаты вышел: ссылка аннулирована${req.bookingId ? `, бронь #${req.bookingId} снята` : ''}`, {
      failStageId: opts?.payments.failStageId ?? null,
      warnings,
    });
    return this.prisma.paymentRequest.update({
      where: { id: req.id },
      data: { status: 'expired', closedAt: new Date(), warnings: warnings as Prisma.InputJsonValue },
    });
  }

  /** Аннулировать ссылку = удалить неоплаченные оплаты своего счёта (их создал портал под наш счёт). */
  private async annulPayments(ctx: FlowContext, invoiceId: number, warnings: string[]): Promise<void> {
    let pays: { id?: number; paid?: string }[] = [];
    try {
      const r = await ctx.client.call<{ id?: number; paid?: string }[]>('crm.item.payment.list', { entityTypeId: 31, entityId: invoiceId });
      pays = Array.isArray(r.result) ? r.result : [];
    } catch (e) {
      warnings.push(`Оплаты счёта #${invoiceId} не прочитаны: ${msg(e)}`);
      return;
    }
    const own = await this.prisma.appCreatedEntity.findUnique({
      where: { portalId_entityType_entityId: { portalId: ctx.portal.id, entityType: 'invoice', entityId: invoiceId } },
    });
    if (!own) {
      warnings.push(`Счёт #${invoiceId} создан не приложением — ссылку не аннулируем`);
      return;
    }
    for (const p of pays) {
      const id = Number(p.id);
      if (!(id > 0) || p.paid === 'Y') continue;
      await this.prisma.appCreatedEntity.upsert({
        where: { portalId_entityType_entityId: { portalId: ctx.portal.id, entityType: 'payment', entityId: id } },
        create: { portalId: ctx.portal.id, entityType: 'payment', entityId: id },
        update: {},
      });
      await this.safe(warnings, `аннулировать оплату ${id}`, () => ctx.client.call('crm.item.payment.delete', { id }));
    }
  }

  /**
   * Сообщение клиенту в чат открытой линии сделки от сотрудника, выставившего счёт, иначе — от
   * ответственного за сделку. Не вышло — предупреждение (ссылку можно отправить вручную).
   */
  private async sendToClient(ctx: FlowContext, req: PaymentRequest, deal: Deal | null, text: string, warnings: string[]): Promise<boolean> {
    let chats: number[] = [];
    try {
      const r = await ctx.client.call<{ CHAT_ID?: string | number }[]>('imopenlines.crm.chat.get', { CRM_ENTITY_TYPE: 'deal', CRM_ENTITY: req.dealId, ACTIVE_ONLY: 'N' });
      chats = [...new Set((Array.isArray(r.result) ? r.result : []).map((c) => Number(c.CHAT_ID) || 0).filter((x) => x > 0))].sort((a, b) => b - a);
    } catch (e) {
      warnings.push(`Чат сделки не найден: ${msg(e)}`);
      return false;
    }
    if (!chats.length) {
      warnings.push('У сделки нет чата открытой линии — ссылку нужно отправить клиенту вручную');
      return false;
    }
    const senders = [...new Set([req.createdByUserId, Number(deal?.ASSIGNED_BY_ID) || 0].filter((x) => x > 0))];
    let last = '';
    // Чат клиента со временем переходит к его новой сделке: такой (CHAT_NOT_IN_CRM) пропускаем,
    // берём самый новый чат, который сейчас привязан к этой сделке.
    for (const chatId of chats) {
      for (const userId of senders) {
        try {
          const r = await ctx.client.call<unknown>('imopenlines.crm.message.add', { CRM_ENTITY_TYPE: 'deal', CRM_ENTITY: req.dealId, USER_ID: userId, CHAT_ID: chatId, MESSAGE: text });
          await this.markSystem(ctx, chatId, userId, r.result);
          return true;
        } catch (e) {
          last = msg(e);
          if (e instanceof Bitrix24Error && e.code === 'CHAT_NOT_IN_CRM') break;
        }
      }
    }
    // Сессия чата закрыта — `imopenlines.crm.message.add` отвечает CHAT_NOT_IN_CRM. Пишем как
    // оператор (`im.message.add`) в чат, который сейчас привязан к этой сделке.
    for (const chatId of chats) {
      try {
        const d = await ctx.client.call<{ entity_data_2?: string }>('imopenlines.dialog.get', { CHAT_ID: chatId });
        if (dealOfBindings(d.result?.entity_data_2) !== req.dealId) continue;
        const r = await ctx.client.call<unknown>('im.message.add', { DIALOG_ID: `chat${chatId}`, MESSAGE: text });
        await this.markSystem(ctx, chatId, null, r.result);
        return true;
      } catch (e) {
        last = msg(e);
      }
    }
    warnings.push(`Сообщение клиенту не отправлено (${last}) — отправьте ссылку вручную`);
    return false;
  }

  /**
   * Подтверждение после оплаты (замена БП 270/358): тип брони по товарам сделки → его цепочка
   * «текст + файлы Диска» с переменными. Тип не определён — клиенту ничего, комментарий в сделке.
   */
  private async confirm(ctx: FlowContext, req: PaymentRequest, opts: GroupOptionsDto, warnings: string[]): Promise<void> {
    const mc = await this.messages(ctx, req.dealId);
    const rule = (opts.bookingTypes ?? []).find((r) => r.title === mc.variables.dealtype);
    if (!rule || !rule.confirmation.length) {
      const why = rule ? `у типа «${rule.title}» нет сообщений` : 'тип брони не определён по товарам сделки';
      warnings.push(`Подтверждение клиенту не отправлено: ${why}`);
      await this.comment(ctx, req.dealId, `Оплата получена, но подтверждение клиенту не отправлено: ${why}.`, warnings);
      return;
    }
    const steps = rule.confirmation.map((st) => ({ ...st, text: renderMessage(st.text, mc) }));
    const sent = await this.sendChain(ctx, req, mc.deal, steps, warnings);
    await this.comment(
      ctx,
      req.dealId,
      `Подтверждение брони (${rule.title}) ${sent ? 'отправлено клиенту' : 'НЕ отправлено — отправьте вручную'}:\n${steps.map((x) => x.text).filter(Boolean).join('\n\n')}`,
      warnings,
    );
  }

  /** Цепочка по порядку: у шага — текст, затем файлы (Диска или шаблона) отдельными сообщениями; пауза между ними. */
  private async sendChain(ctx: FlowContext, req: PaymentRequest, deal: Deal | null, steps: ChainStep[], warnings: string[]): Promise<boolean> {
    let first = true;
    const gap = async () => {
      if (!first && this.sendGapMs > 0) await this.sleep(this.sendGapMs);
      first = false;
    };
    let chatId: number | null | undefined;
    for (const st of steps) {
      if (st.text.trim()) {
        await gap();
        if (!(await this.sendToClient(ctx, req, deal, st.text, warnings))) return false;
      }
      for (const f of st.files) {
        chatId ??= await this.boundChat(ctx, req.dealId);
        if (!chatId) {
          warnings.push('Файлы не отправлены: у сделки нет чата открытой линии');
          return false;
        }
        await gap();
        const ok = await this.safe(warnings, `файл «${f.name}»`, async () => {
          let name = f.name;
          let data: Buffer;
          if ('data' in f) data = f.data;
          else {
            const file = (await ctx.client.call<{ DOWNLOAD_URL?: string; NAME?: string }>('disk.file.get', { id: f.id })).result;
            data = (await ctx.client.download(String(file?.DOWNLOAD_URL ?? ''))).data;
            name = file?.NAME ?? f.name;
          }
          const r = await ctx.client.call<{ messageId?: number }>('im.v2.File.upload', { dialogId: `chat${chatId}`, fields: { name, content: data.toString('base64') } });
          await this.markSystem(ctx, chatId!, null, r.result?.messageId);
        });
        if (!ok) return false;
      }
    }
    return true;
  }

  /**
   * Автосообщение клиенту (ссылка, подтверждение) — в SystemMessage: в «Активности сотрудников» оно
   * не считается работой того, от чьего имени ушло. Сбой записи не мешает отправке.
   */
  private async markSystem(ctx: FlowContext, chatId: number, userId: number | null, result: unknown): Promise<void> {
    const messageId = Number(result);
    try {
      await this.prisma.systemMessage.create({
        data: { portalId: ctx.portal.id, chatId, userId, messageId: Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null, source: 'payment' },
      });
    } catch (e) {
      this.logger.warn(`system message mark failed: ${msg(e)}`);
    }
  }

  /** Самый новый чат открытой линии, который сейчас привязан к сделке. */
  private async boundChat(ctx: FlowContext, dealId: number): Promise<number | null> {
    try {
      const r = await ctx.client.call<{ CHAT_ID?: string | number }[]>('imopenlines.crm.chat.get', { CRM_ENTITY_TYPE: 'deal', CRM_ENTITY: dealId, ACTIVE_ONLY: 'N' });
      const chats = (Array.isArray(r.result) ? r.result : []).map((c) => Number(c.CHAT_ID) || 0).filter((x) => x > 0).sort((a, b) => b - a);
      for (const chatId of chats) {
        const d = await ctx.client.call<{ entity_data_2?: string }>('imopenlines.dialog.get', { CHAT_ID: chatId });
        if (dealOfBindings(d.result?.entity_data_2) === dealId) return chatId;
      }
    } catch (e) {
      this.logger.warn(`deal ${dealId}: chat lookup failed: ${msg(e)}`);
    }
    return null;
  }

  /**
   * Сообщение со ссылкой на оплату: системный шаблон оплаты, выбранный в группе; не выбран —
   * старый текст группы или стандартный. Шаблон пропал — стандартный текст и предупреждение.
   */
  async paymentTemplate(
    portalId: string,
    kind: PaymentKind,
    opts: GroupOptionsDto | null,
    warnings: string[] = [],
  ): Promise<{ name: string | null; steps: PaymentMessageStep[] }> {
    const p = opts?.payments;
    const id = kind === 'prepayment' ? p?.prepaymentTemplateId : p?.surchargeTemplateId;
    if (id) {
      const row = await this.prisma.messageTemplate.findFirst({ where: { id, portalId, purpose: 'payment', shared: true } });
      if (row) {
        const steps = (row.steps as unknown as TemplateStepDto[]).map((st) => ({ text: st.text, files: st.fileIds.map((fileId) => ({ fileId, name: '' })) }));
        return { name: row.name, steps };
      }
      warnings.push('Шаблон сообщения об оплате не найден — отправлен стандартный текст');
    }
    const text = kind === 'prepayment' ? p?.clientMessage || DEFAULT_CLIENT_MESSAGE : p?.surchargeMessage || DEFAULT_SURCHARGE_MESSAGE;
    return { name: null, steps: [{ text, files: [] }] };
  }

  /** Файлы шаблона оплаты (`StoredFile`) — содержимое для отправки; пропавший файл — предупреждение. */
  private async withFileData(portalId: string, steps: PaymentMessageStep[], warnings: string[]): Promise<ChainStep[]> {
    const ids = [...new Set(steps.flatMap((st) => st.files.map((f) => f.fileId)))];
    const rows = ids.length ? await this.prisma.storedFile.findMany({ where: { portalId, id: { in: ids } }, select: { id: true, name: true, data: true } }) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return steps.map((st) => ({
      text: st.text,
      files: st.files.flatMap((f) => {
        const r = byId.get(f.fileId);
        if (!r) warnings.push('Файл шаблона оплаты удалён — отправлено без него');
        return r ? [{ name: r.name, data: Buffer.from(r.data) }] : [];
      }),
    }));
  }

  async deal(ctx: Pick<FlowContext, 'client'>, dealId: number): Promise<Deal | null> {
    try {
      return (await ctx.client.call<Deal>('crm.deal.get', { id: dealId })).result ?? null;
    } catch {
      return null;
    }
  }

  async invoice(ctx: Pick<FlowContext, 'client'>, id: number): Promise<Invoice | null> {
    const r = await ctx.client.call<{ item?: Invoice }>('crm.item.get', { entityTypeId: 31, id });
    return r.result?.item ?? null;
  }

  async dealUpdate(ctx: FlowContext, dealId: number, fields: Record<string, unknown>, warnings: string[], what: string): Promise<boolean> {
    return this.safe(warnings, `сделка #${dealId}: ${what}`, () => ctx.client.call('crm.deal.update', { id: dealId, fields }));
  }

  private async comment(ctx: FlowContext, dealId: number, text: string, warnings: string[]): Promise<void> {
    await this.safe(warnings, 'комментарий в сделке', () => ctx.client.call('crm.timeline.comment.add', { fields: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal', COMMENT: text } }));
  }

  private async safe(warnings: string[], what: string, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (e) {
      warnings.push(`Не удалось: ${what} (${msg(e)})`);
      this.logger.warn(`${what}: ${msg(e)}`);
      return false;
    }
  }

  private warningsOf(req: PaymentRequest): string[] {
    return Array.isArray(req.warnings) ? (req.warnings as string[]).slice() : [];
  }

  private fail(req: PaymentRequest, error: string): Promise<PaymentRequest> {
    return this.prisma.paymentRequest.update({ where: { id: req.id }, data: { status: 'failed', error, closedAt: new Date() } });
  }

  private close(req: PaymentRequest, status: 'cancelled', error: string): Promise<PaymentRequest> {
    return this.prisma.paymentRequest.update({ where: { id: req.id }, data: { status, error, closedAt: new Date() } });
  }
}

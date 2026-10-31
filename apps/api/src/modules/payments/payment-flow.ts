import { chatLineProblem, NO_WORKING_CHAT } from '../openlines/line-health.js';
import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  DEFAULT_CLIENT_MESSAGE,
  DEFAULT_FAIL_MESSAGE,
  DEFAULT_SURCHARGE_MESSAGE,
  renderMessage,
  hasPaymentLinkToken,
  withPaymentLink,
  PAYMENT_KIND_LABELS,
  DEFAULT_PAYMENT_LINK_MESSAGE,
  PAYMENT_LINK_VAR,
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
import { PaidAmountService } from './paid-amount.service.js';
import { ActionLogService } from '../audit/action-log.service.js';
import { BookingJournalService, SYSTEM } from '../bookings/booking-journal.service.js';
import { dateRu, timeRu } from '../bookings/booking-create.service.js';
import { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import { MessageContextService } from '../bookings/message-context.service.js';
import { appendServiceMessage } from '../openlines/service-chat.service.js';

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

/**
 * Свой текст клиенту со ссылкой: `{{СсылкаНаОплату}}` — ссылкой; `{link}` (и другие формы ссылки
 * шаблонизатора) подставит `renderMessage`; ни того ни другого — ссылка последней строкой. Иначе
 * текст из шаблона оплаты (`{link}`) получил бы ссылку дважды.
 */
export function ownTextWithLink(text: string, link: string): string {
  return hasPaymentLinkToken(text) ? text.trim().split(PAYMENT_LINK_VAR).join(link) : withPaymentLink(text, link);
}

/** ID файлов своего текста из заявки (`PaymentRequest.messageFileIds`). */
export const requestFileIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Шаг сообщения об оплате до загрузки файлов: текст и ID файлов шаблона (`StoredFile`). */
export interface PaymentMessageStep {
  text: string;
  files: { fileId: string; name: string }[];
}
/** Шаг цепочки к отправке: файл — с Диска Битрикс24 (`id`) или уже загруженный (`data`). */
export type ChainStep = { text: string; files: (ClientMessageStep['files'][number] | { name: string; data: Buffer })[] };

/** Кому и от кого: чат открытой линии сделки, отправитель (иначе — ответственный), метка автосообщения. */
export interface SendTarget {
  dealId: number;
  userId: number | null;
  /** `SystemMessage.source`: payment, auto. */
  source: string;
}
const target = (req: Pick<PaymentRequest, 'dealId' | 'createdByUserId'>): SendTarget => ({ dealId: req.dealId, userId: req.createdByUserId, source: 'payment' });

export interface FlowContext {
  portal: Portal;
  client: Bitrix24RestClient;
  /** Кто действует: сотрудник (из интерфейса) или система (worker). */
  actor: { kind: 'user'; userId: number; name: string } | { kind: 'system'; name: string };
  /**
   * Рабочего чата нет, а сотрудник в окне оплаты выбрал мессенджер: открыть новый чат с клиентом сделки
   * этим сообщением (его токеном). Возвращает чат линии; только в запросе сотрудника, у worker'а нет.
   */
  newChat?: (text: string) => Promise<number | null>;
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
    const kind = PAYMENT_KIND_LABELS[req.kind].toLowerCase();
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

  /**
   * Отправить клиенту счёт по запросу сотрудника (просмотр счёта, статус «Выставлен»): ссылка уже
   * есть — сообщение уходит сейчас, срок оплаты идёт с этого момента; ссылки ещё нет — обычный шаг
   * ожидания ссылки (появилась — отправится сразу, нет — статус не изменится).
   */
  async sendLink(ctx: FlowContext, req: PaymentRequest): Promise<PaymentRequest> {
    if (req.status === 'link_pending' || !req.link) return this.awaitLink(ctx, req);
    const opts = await this.options(req);
    if (!opts) return this.fail(req, 'Нет настроек счёта группы');
    return this.deliver(ctx, { ...req, link: req.link }, opts);
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
    const linkField = req.kind === 'custom' ? null : req.kind === 'prepayment' ? map.prepaymentLink : map.surchargeLink;
    if (linkField) await this.dealUpdate(ctx, req.dealId, { [linkField]: req.link }, warnings, 'ссылка на оплату');

    const mc = await this.messages(ctx, req.dealId);
    const deal = mc.deal;
    // Свой срок из встройки сделки — и для доплаты; иначе срок группы (только предоплата).
    const minutes = req.timeoutMinutes ?? (req.kind === 'prepayment' ? opts.payments.timeoutMinutes : null);
    const deadline = minutes ? new Date(Date.now() + minutes * 60_000) : null;
    const vars = {
      ...mc.vars,
      prepayment: money(Number(req.amount)),
      link: req.link,
      minutes: minutes ?? '',
      deadline: deadline ? `${timeRu(deadline, ctx.portal.timezone)} ${dateRu(deadline, ctx.portal.timezone)}` : '',
    };
    // Свой текст (встройка сделки, окно оплаты) — одним сообщением с вложениями заявки; ссылка — без задвоения.
    const own = req.message ?? (req.kind === 'custom' ? DEFAULT_PAYMENT_LINK_MESSAGE : null);
    const tpl = own !== null || req.kind === 'custom'
      ? {
          name: null,
          steps: [{ text: ownTextWithLink(own ?? DEFAULT_PAYMENT_LINK_MESSAGE, req.link), files: requestFileIds(req.messageFileIds).map((fileId) => ({ fileId, name: '' })) }],
        }
      : await this.paymentTemplate(ctx.portal.id, req.kind, opts, warnings);
    const steps = await this.withFileData(
      ctx.portal.id,
      tpl.steps.map((st) => ({ ...st, text: renderMessage(st.text, { ...mc, vars }) })),
      warnings,
    );
    const text = steps.map((x) => x.text).filter((x) => x.trim()).join('\n\n');
    const sent = await this.sendChain(ctx, target(req), deal, steps, warnings);
    await this.audit(req, sent ? 'link_sent' : 'link_not_sent', sent ? 'Ссылка на оплату отправлена клиенту' : 'Ссылка на оплату НЕ отправлена клиенту', {
      deadline: sent ? deadline?.toISOString() : null,
      warnings,
    });
    await this.comment(ctx, req.dealId, `Ссылка на оплату (${req.purpose ?? PAYMENT_KIND_LABELS[req.kind].toLowerCase()} ${money(Number(req.amount))} ₽, счёт #${req.invoiceId}) ${sent ? 'отправлена клиенту' : 'НЕ отправлена — отправьте вручную'}:\n${text}`, warnings);
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

    // Срок доплаты (свой срок из встройки сделки) только аннулирует ссылку: бронь и стадию не трогаем.
    const pre = req.kind === 'prepayment';
    if (pre && req.bookingId) {
      const rec = await this.journal.find(ctx.portal.id, req.bookingId);
      if (rec?.status === 'active') {
        const removed = await this.safe(warnings, `снять бронь #${req.bookingId}`, () => ctx.client.call('booking.v1.booking.delete', { id: req.bookingId }));
        if (removed) await this.journal.recordCancelled(ctx.portal.id, req.bookingId, { reason: 'payment_timeout', actor: SYSTEM.paymentTimeout, via: 'worker' });
      }
    }
    if (pre && opts?.payments.failStageId) await this.dealUpdate(ctx, req.dealId, { STAGE_ID: opts.payments.failStageId }, warnings, 'стадия «не оплачено»');
    const failText = pre ? (opts?.payments.failMessage ?? DEFAULT_FAIL_MESSAGE) : '';
    if (failText.trim()) {
      const mc = await this.messages(ctx, req.dealId);
      const text = renderMessage(failText, { ...mc, vars: { ...mc.vars, minutes: req.timeoutMinutes ?? opts?.payments.timeoutMinutes ?? '' } });
      await this.sendToClient(ctx, target(req), mc.deal, text, warnings);
    }
    const removed = pre && req.bookingId ? `, бронь #${req.bookingId} снята` : '';
    await this.comment(ctx, req.dealId, `${req.purpose ?? PAYMENT_KIND_LABELS[req.kind]} по счёту #${req.invoiceId} не поступила в срок: ссылка аннулирована${removed}.`, warnings);
    await this.refreshPaid(ctx, req);
    await this.audit(req, 'expired', `Срок оплаты вышел: ссылка аннулирована${removed}`, {
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
  private async sendToClient(ctx: FlowContext, req: SendTarget, deal: Deal | null, text: string, warnings: string[]): Promise<boolean> {
    const noChat: string[] = [];
    const targets = await this.workingTargets(ctx, req.dealId, Number(deal?.CONTACT_ID) || null, noChat);
    if (!targets.length) {
      if (!ctx.newChat) {
        // Клиент без мессенджеров (служебный чат сделки) — сообщение туда; клиенту его передаст менеджер.
        if (await this.toServiceChat(ctx, req, text)) return true;
        warnings.push(...noChat);
        return false;
      }
      try {
        const chatId = await ctx.newChat(text);
        if (chatId) await this.markSystem(ctx, chatId, req.userId, null, req.source);
        return true;
      } catch (e) {
        warnings.push(`Новый чат с клиентом не создан (${msg(e)}) — отправьте ссылку вручную`);
        return false;
      }
    }
    const senders = [...new Set([req.userId ?? 0, Number(deal?.ASSIGNED_BY_ID) || 0].filter((x) => x > 0))];
    let last = '';
    // Чат клиента со временем переходит к его новой сделке: такой (CHAT_NOT_IN_CRM) пропускаем,
    // берём самый новый чат, который сейчас привязан к этой сделке.
    for (const { chatId, type, entityId } of targets) {
      for (const userId of senders) {
        try {
          const r = await ctx.client.call<unknown>('imopenlines.crm.message.add', { CRM_ENTITY_TYPE: type, CRM_ENTITY: entityId, USER_ID: userId, CHAT_ID: chatId, MESSAGE: text });
          await this.markSystem(ctx, chatId, userId, r.result, req.source);
          return true;
        } catch (e) {
          last = msg(e);
          if (e instanceof Bitrix24Error && e.code === 'CHAT_NOT_IN_CRM') break;
        }
      }
    }
    // Сессия чата закрыта — `imopenlines.crm.message.add` отвечает CHAT_NOT_IN_CRM. Пишем как
    // оператор (`im.message.add`) в чат, который сейчас привязан к этой сделке.
    for (const { chatId, type, entityId } of targets) {
      try {
        const d = await ctx.client.call<{ entity_data_2?: string }>('imopenlines.dialog.get', { CHAT_ID: chatId });
        if (bindingEntity(d.result?.entity_data_2, type) !== entityId) continue;
        const r = await ctx.client.call<unknown>('im.message.add', { DIALOG_ID: `chat${chatId}`, MESSAGE: text });
        await this.markSystem(ctx, chatId, null, r.result, req.source);
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
    const sent = await this.sendChain(ctx, target(req), mc.deal, steps, warnings);
    await this.comment(
      ctx,
      req.dealId,
      `Подтверждение брони (${rule.title}) ${sent ? 'отправлено клиенту' : 'НЕ отправлено — отправьте вручную'}:\n${steps.map((x) => x.text).filter(Boolean).join('\n\n')}`,
      warnings,
    );
  }

  /**
   * Цепочка по порядку: у шага — текст, затем файлы (Диска или шаблона) отдельными сообщениями; пауза
   * между ними. Общая для оплаты и автоматических рассылок.
   */
  async sendChain(ctx: FlowContext, req: SendTarget, deal: Deal | null, steps: ChainStep[], warnings: string[]): Promise<boolean> {
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
        if (!chatId && (await this.toServiceChat(ctx, req, `Файл для клиента: «${f.name}» (отправьте сами)`))) continue;
        if (!chatId) {
          warnings.push(`Файлы не отправлены: ${NO_WORKING_CHAT}`);
          return false;
        }
        await gap();
        const ok = await this.safe(warnings, `файл «${f.name}»`, async () => {
          let name = f.name;
          let data: Buffer;
          if ('data' in f) data = f.data;
          else if ('storedFileId' in f) {
            const stored = await this.prisma.storedFile.findFirst({ where: { portalId: ctx.portal.id, id: f.storedFileId }, select: { name: true, data: true } });
            if (!stored) throw new Error('Вложение подтверждения не найдено');
            name = stored.name;
            data = Buffer.from(stored.data);
          }
          else {
            const file = (await ctx.client.call<{ DOWNLOAD_URL?: string; NAME?: string }>('disk.file.get', { id: f.id })).result;
            data = (await ctx.client.download(String(file?.DOWNLOAD_URL ?? ''))).data;
            name = file?.NAME ?? f.name;
          }
          const r = await ctx.client.call<{ messageId?: number }>('im.v2.File.upload', { dialogId: `chat${chatId}`, fields: { name, content: data.toString('base64') } });
          await this.markSystem(ctx, chatId!, null, r.result?.messageId, req.source);
        });
        if (!ok) return false;
      }
    }
    return true;
  }

  private async hasServiceChat(ctx: FlowContext, dealId: number): Promise<boolean> {
    try {
      return !!(await this.prisma.serviceChat.findUnique({ where: { portalId_dealId: { portalId: ctx.portal.id, dealId } }, select: { id: true } }));
    } catch {
      return false;
    }
  }

  /** Служебный чат сделки (только в приложении): записать, если он у сделки есть. Сбой — как «чата нет». */
  private async toServiceChat(ctx: FlowContext, req: SendTarget, text: string): Promise<boolean> {
    try {
      return await appendServiceMessage(this.prisma, ctx.portal.id, req.dealId, req.source === 'payment' ? 'payment' : 'automation', text);
    } catch (e) {
      this.logger.warn(`service chat append failed: ${msg(e)}`);
      return false;
    }
  }

  /**
   * Автосообщение клиенту (ссылка, подтверждение) — в SystemMessage: в «Активности сотрудников» оно
   * не считается работой того, от чьего имени ушло. Сбой записи не мешает отправке.
   */
  private async markSystem(ctx: FlowContext, chatId: number, userId: number | null, result: unknown, source: string): Promise<void> {
    const messageId = Number(result);
    try {
      await this.prisma.systemMessage.create({
        data: { portalId: ctx.portal.id, chatId, userId, messageId: Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null, source },
      });
    } catch (e) {
      this.logger.warn(`system message mark failed: ${msg(e)}`);
    }
  }

  /** Кандидаты сделки и её контакта; контакт проверяем по текущим привязкам диалога. */
  private async chatTargets(ctx: FlowContext, dealId: number, contactId: number | null = null): Promise<{ chatId: number; type: 'deal' | 'contact'; entityId: number }[]> {
    const targets: { chatId: number; type: 'deal' | 'contact'; entityId: number }[] = [];
    const lookup = async (type: 'deal' | 'contact', entityId: number) => {
      try {
        const r = await ctx.client.call<{ CHAT_ID?: string | number }[]>('imopenlines.crm.chat.get', { CRM_ENTITY_TYPE: type, CRM_ENTITY: entityId, ACTIVE_ONLY: 'N' });
        const ids = [...new Set((Array.isArray(r.result) ? r.result : []).map((c) => Number(c.CHAT_ID)).filter((n) => Number.isSafeInteger(n) && n > 0))].sort((a, b) => b - a);
        for (const chatId of ids) {
          if (type === 'contact') {
            try {
              const d = await ctx.client.call<{ entity_data_2?: string }>('imopenlines.dialog.get', { CHAT_ID: chatId });
              if (bindingEntity(d.result?.entity_data_2, 'contact') !== entityId) continue;
            } catch { continue; }
          }
          targets.push({ chatId, type, entityId });
        }
      } catch { this.logger.warn(`deal ${dealId}: ${type} chat lookup unavailable`); }
    };
    await lookup('deal', dealId);
    if (!contactId) {
      const d = await ctx.client.call<{ CONTACT_ID?: string }>('crm.deal.get', { id: dealId }).catch(() => null);
      contactId = Number(d?.result?.CONTACT_ID) || null;
    }
    if (contactId) await lookup('contact', contactId);
    return targets;
  }

  /**
   * Чаты сделки и контакта только на рабочих линиях (решение владельца 2026-10-26). Нет ни одного —
   * предупреждение «создайте работающий чат с клиентом» (с причинами по найденным чатам).
   */
  private async workingTargets(ctx: FlowContext, dealId: number, contactId: number | null, warnings: string[]): Promise<{ chatId: number; type: 'deal' | 'contact'; entityId: number }[]> {
    const all = await this.chatTargets(ctx, dealId, contactId);
    const out: typeof all = [];
    const why = new Set<string>();
    for (const t of all) {
      const problem = await chatLineProblem(ctx.client, this.prisma, ctx.portal.id, t.chatId);
      if (problem) why.add(problem);
      else out.push(t);
    }
    if (!out.length) warnings.push(`${NO_WORKING_CHAT}${why.size ? ` (${[...why].join('; ')})` : ''} — сообщение не отправлено`);
    return out;
  }

  /** Есть ли у сделки рабочий чат: null — есть; иначе текст «создайте работающий чат» (для окна оплаты). */
  async chatProblem(ctx: FlowContext, dealId: number): Promise<string | null> {
    const w: string[] = [];
    if ((await this.workingTargets(ctx, dealId, null, w)).length) return null;
    // Служебный чат сделки: ссылка запишется туда — окну оплаты не нужно предлагать мессенджеры.
    if (await this.hasServiceChat(ctx, dealId)) return null;
    return (w[0] ?? NO_WORKING_CHAT).replace(/ — сообщение не отправлено$/, '');
  }

  /** Чат для файлов той же цепочки: сделка или её контакт, только с подтверждённой привязкой и рабочей линией. */
  private async boundChat(ctx: FlowContext, dealId: number): Promise<number | null> {
    for (const { chatId, type, entityId } of await this.workingTargets(ctx, dealId, null, [])) {
      try {
        const d = await ctx.client.call<{ entity_data_2?: string }>('imopenlines.dialog.get', { CHAT_ID: chatId });
        if (bindingEntity(d.result?.entity_data_2, type) === entityId) return chatId;
      } catch { /* Недоступный диалог — пробуем следующий. */ }
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
  ): Promise<{ id: string | null; name: string | null; steps: PaymentMessageStep[] }> {
    const p = opts?.payments;
    const id = kind === 'prepayment' ? p?.prepaymentTemplateId : p?.surchargeTemplateId;
    if (id) {
      const tpl = await this.systemPaymentTemplate(portalId, id);
      if (tpl) return tpl;
      warnings.push('Шаблон сообщения об оплате не найден — отправлен стандартный текст');
    }
    const text = kind === 'prepayment' ? p?.clientMessage || DEFAULT_CLIENT_MESSAGE : p?.surchargeMessage || DEFAULT_SURCHARGE_MESSAGE;
    return { id: null, name: null, steps: [{ text, files: [] }] };
  }

  /** Системный шаблон оплаты портала (общий, назначение `payment`); чужой или пропавший — null. */
  async systemPaymentTemplate(portalId: string, id: string): Promise<{ id: string; name: string; steps: PaymentMessageStep[] } | null> {
    const row = await this.prisma.messageTemplate.findFirst({ where: { id, portalId, purpose: 'payment', shared: true } });
    if (!row) return null;
    const steps = (row.steps as unknown as TemplateStepDto[]).map((st) => ({ text: st.text, files: (st.fileIds ?? []).map((fileId) => ({ fileId, name: '' })) }));
    return { id: row.id, name: row.name, steps };
  }

  /** Файлы шаблона оплаты (`StoredFile`) — содержимое для отправки; пропавший файл — предупреждение. */
  async withFileData(portalId: string, steps: PaymentMessageStep[], warnings: string[]): Promise<ChainStep[]> {
    const ids = [...new Set(steps.flatMap((st) => st.files.map((f) => f.fileId)))];
    const rows = ids.length ? await this.prisma.storedFile.findMany({ where: { portalId, id: { in: ids } }, select: { id: true, name: true, data: true } }) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return steps.map((st) => ({
      text: st.text,
      files: st.files.flatMap((f) => {
        const r = byId.get(f.fileId);
        if (!r) warnings.push('Файл шаблона удалён — отправлено без него');
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

  async comment(ctx: FlowContext, dealId: number, text: string, warnings: string[]): Promise<void> {
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

function bindingEntity(bindings: string | undefined, type: 'deal' | 'contact'): number | null {
  const parts = String(bindings ?? '').split('|');
  const at = parts.indexOf(type.toUpperCase());
  const id = at >= 0 ? Number(parts[at + 1]) : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

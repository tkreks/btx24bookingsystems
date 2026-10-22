import { zonedTimeToUtc } from '@btx24/shared';
import type { Portal } from '../../../generated/prisma/client.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import type { WritePolicy } from '../rest/rest-client.js';

/** Песочница записи (решение владельца 2026-10-21): одна тестовая сделка и брони в заданном периоде. */
export interface SandboxConfig {
  dealIds: number[];
  /** YYYY-MM-DD в часовом поясе портала, [from, to). */
  bookingsFrom: string | null;
  bookingsTo: string | null;
}

type P = Record<string, unknown>;
/**
 * Что приложение создало само (AppCreatedEntity): бронь, сделка, смарт-счёт, оплата счёта
 * (регистрирует worker, прочитав оплаты своего счёта), сделка со счётом приложения.
 */
export type CreatedKind = 'booking' | 'deal' | 'invoice' | 'payment' | 'payment_deal';

/** Связанные с тестовыми сделками объекты (читаются из Битрикс24): только с ними можно работать. */
export interface SandboxRelations {
  contactIds: number[];
  /** Счета (смарт-счета, entityTypeId 31) этих сделок. */
  invoiceIds: number[];
  /** Оплаты сделок и их счетов (crm.item.payment). */
  paymentIds: number[];
  /** Чаты открытых линий, привязанные к сделкам (`imopenlines.crm.chat.get`). */
  chatIds: number[];
}
export type SandboxRelationsResolver = (dealIds: number[]) => Promise<SandboxRelations>;
/** Сделка, к которой сейчас привязан чат открытой линии (`imopenlines.dialog.get`); null — ни к какой. */
export type ChatDealResolver = (chatId: number) => Promise<number | null>;
const lc = (v: unknown) => String(v ?? '').toLowerCase();
/** `chat123` → 123; личный диалог (ID пользователя) — не чат, null. */
const chatOf = (dialogId: unknown) => /^chat(\d+)$/.exec(String(dialogId ?? ''))?.[1] ?? null;

/**
 * Разрешает изменяющий вызов в режиме только чтения, если он целиком внутри песочницы.
 * Всё, что не распознано, — запрещено. Брони меняются/удаляются только созданные песочницей
 * (журнал SandboxBooking), поэтому реальные брони недоступны даже при ошибке в коде выше.
 *
 * Разрешение «создавать новые» (решение владельца 2026-10-22, `PortalSettings.createInBitrix`):
 * новые брони на любые даты, новые сделки и смарт-счета сделок (ADR 0009). Дальше менять можно
 * только созданное приложением (журнал AppCreatedEntity); сообщение клиенту и комментарий —
 * только по сделке, где приложение выставило счёт. Существующие брони только читаются.
 *
 * «Менять поля сделок» (`PortalSettings.updateDealFields`, решение владельца 2026-10-22):
 * `crm.deal.update` любой сделки; удаление и товары существующих сделок — нет.
 */
export class SandboxWritePolicy implements WritePolicy {
  private readonly from: number | null;
  private readonly to: number | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly portal: Portal,
    private readonly cfg: SandboxConfig,
    private readonly relationsOf: SandboxRelationsResolver = async () => ({ contactIds: [], invoiceIds: [], paymentIds: [], chatIds: [] }),
    private readonly chatDeal: ChatDealResolver = async () => null,
  ) {
    this.from = cfg.bookingsFrom ? zonedTimeToUtc(cfg.bookingsFrom, '00:00', portal.timezone).getTime() / 1000 : null;
    this.to = cfg.bookingsTo ? zonedTimeToUtc(cfg.bookingsTo, '00:00', portal.timezone).getTime() / 1000 : null;
  }

  async allows(method: string, params: P): Promise<boolean> {
    const fields = (params.fields ?? {}) as P;
    switch (lc(method)) {
      case 'crm.deal.add':
        return this.createAllowed();
      case 'crm.deal.update':
        return this.deal(params.id) || (await this.created('deal', params.id)) || this.dealFieldsAllowed(params.id);
      case 'crm.deal.productrows.set':
        return this.deal(params.id) || this.created('deal', params.id);
      case 'crm.item.add':
        // Смарт-счёт сделки (ссылку на оплату к нему ставит портал).
        return Number(params.entityTypeId) === 31 && /^\d+$/.test(String(fields.parentId2 ?? '')) && this.createAllowed();
      case 'crm.item.update':
        if (Number(params.entityTypeId) === 3) return this.related('contactIds', params.id);
        if (Number(params.entityTypeId) === 31) return (await this.related('invoiceIds', params.id)) || this.created('invoice', params.id);
        return Number(params.entityTypeId) === 2 && (this.deal(params.id) || (await this.created('deal', params.id)) || this.dealFieldsAllowed(params.id));
      // Правка контакта сделки песочницы (решение владельца): например, очистка e-mail «wazzup».
      case 'crm.contact.update':
        return this.related('contactIds', params.id);
      // Аннулирование ссылки на оплату = удаление неоплаченной оплаты счёта тестовой сделки.
      case 'crm.item.payment.delete':
      case 'crm.item.payment.update':
        return (await this.related('paymentIds', params.id)) || this.created('payment', params.id);
      case 'crm.timeline.comment.add':
        return (
          lc(fields.ENTITY_TYPE) === 'deal' &&
          (this.deal(fields.ENTITY_ID) || (await this.created('deal', fields.ENTITY_ID)) || this.created('payment_deal', fields.ENTITY_ID))
        );
      case 'bizproc.workflow.start': {
        const doc = Array.isArray(params.DOCUMENT_ID) ? params.DOCUMENT_ID : [];
        const m = /^DEAL_(\d+)$/.exec(String(doc[2] ?? ''));
        return lc(doc[1]) === 'ccrmdocumentdeal' && !!m && this.deal(m[1]);
      }
      // Сообщение клиенту в чат сделки: песочница или сделка, где приложение выставило счёт.
      case 'imopenlines.crm.message.add':
        return lc(params.CRM_ENTITY_TYPE) === 'deal' && (this.deal(params.CRM_ENTITY) || this.created('payment_deal', params.CRM_ENTITY));
      // Чат открытой линии сделки песочницы (решение владельца): войти, писать, отправлять файлы.
      case 'imopenlines.session.join':
        return this.related('chatIds', params.CHAT_ID);
      // Чат уведомлений о бронях (решение владельца 2026-10-21: «создай новый чат»): создать один
      // раз, писать и обновлять только сообщения уведомлений.
      case 'im.chat.add':
        return !(await this.alertChatId());
      case 'im.message.add':
        return (
          (await this.isAlertChat(chatOf(params.DIALOG_ID))) || (await this.related('chatIds', chatOf(params.DIALOG_ID))) || this.paymentChat(chatOf(params.DIALOG_ID))
        );
      case 'im.message.update':
        return this.isAlertMessage(params.MESSAGE_ID);
      // Свой рабочий день (запрос владельца 2026-10-21): только без USER_ID — токеном самого
      // сотрудника, чужой день так не изменить.
      case 'timeman.open':
      case 'timeman.pause':
      case 'timeman.close':
        return params.USER_ID === undefined;
      case 'im.v2.file.upload':
        return this.related('chatIds', chatOf(params.dialogId));
      case 'booking.v1.booking.add':
        return this.inRange(fields.datePeriod) || this.createAllowed();
      case 'booking.v1.booking.update':
        return (
          ((await this.owned(params.id)) && (fields.datePeriod === undefined || this.inRange(fields.datePeriod))) ||
          this.created('booking', params.id)
        );
      case 'booking.v1.booking.delete':
        return (await this.owned(params.id)) || this.created('booking', params.id);
      case 'booking.v1.booking.externaldata.set': {
        const items = (Array.isArray(params.externalData) ? params.externalData : []) as P[];
        const toDeals = items.length > 0 && items.every((x) => lc(x.moduleId) === 'crm' && lc(x.entityTypeId) === 'deal' && /^\d+$/.test(String(x.value ?? '')));
        if (!toDeals) return false;
        // Свою новую бронь можно связать с любой сделкой: меняется бронь, а не сделка.
        if (await this.created('booking', params.bookingId)) return true;
        return items.every((x) => this.deal(x.value)) && this.owned(params.bookingId);
      }
      case 'booking.v1.booking.externaldata.unset':
      case 'booking.v1.booking.client.set':
      case 'booking.v1.booking.client.unset':
        return (await this.owned(params.bookingId)) || this.created('booking', params.bookingId);
      default:
        return false;
    }
  }

  async recorded(method: string, params: P, result: unknown): Promise<void> {
    const m = lc(method);
    const id = typeof result === 'object' && result !== null ? Number((result as P).id) : Number(result);
    if (m === 'booking.v1.booking.add') {
      if (!(Number.isInteger(id) && id > 0)) return;
      // Бронь в датах песочницы — в её журнал (уборка удалит), иначе — созданная по разрешению.
      if (this.inRange(((params.fields ?? {}) as P).datePeriod)) await this.prisma.sandboxBooking.create({ data: { portalId: this.portal.id, bookingId: id } });
      else await this.remember('booking', id);
    } else if (m === 'crm.deal.add') {
      if (Number.isInteger(id) && id > 0) await this.remember('deal', id);
    } else if (m === 'crm.item.add' && Number(params.entityTypeId) === 31) {
      const invoiceId = Number(((result ?? {}) as { item?: { id?: unknown } }).item?.id);
      if (Number.isInteger(invoiceId) && invoiceId > 0) await this.remember('invoice', invoiceId);
      await this.remember('payment_deal', Number(((params.fields ?? {}) as P).parentId2));
    } else if (m === 'booking.v1.booking.delete') {
      await this.prisma.sandboxBooking.updateMany({ where: { portalId: this.portal.id, bookingId: Number(params.id) }, data: { deletedAt: new Date() } });
    }
  }

  private async alertChatId(): Promise<number | null> {
    const s = await this.prisma.portalSettings.findUnique({ where: { portalId: this.portal.id } });
    return s?.alertChatId ?? null;
  }

  private async isAlertChat(chatId: string | null): Promise<boolean> {
    const id = await this.alertChatId();
    return chatId !== null && id !== null && Number(chatId) === id;
  }

  private async isAlertMessage(messageId: unknown): Promise<boolean> {
    if (!/^\d+$/.test(String(messageId ?? ''))) return false;
    const row = await this.prisma.bookingAlert.findFirst({ where: { portalId: this.portal.id, messageId: Number(messageId) } });
    return !!row;
  }

  private async createAllowed(): Promise<boolean> {
    const s = await this.prisma.portalSettings.findUnique({ where: { portalId: this.portal.id } });
    return s?.createInBitrix === true;
  }

  /** Чат сейчас привязан к сделке, где приложение выставило счёт (сообщение со ссылкой на оплату). */
  private async paymentChat(chatId: string | null): Promise<boolean> {
    if (chatId === null) return false;
    const dealId = await this.chatDeal(Number(chatId));
    return dealId !== null && this.created('payment_deal', dealId);
  }

  private async dealFieldsAllowed(id: unknown): Promise<boolean> {
    if (!/^\d+$/.test(String(id ?? ''))) return false;
    const s = await this.prisma.portalSettings.findUnique({ where: { portalId: this.portal.id } });
    return s?.updateDealFields === true;
  }

  /** Журнал созданного: повтор (та же сделка — второй счёт) не ошибка. */
  private async remember(entityType: CreatedKind, entityId: number): Promise<void> {
    if (!Number.isInteger(entityId) || entityId <= 0) return;
    await this.prisma.appCreatedEntity.upsert({
      where: { portalId_entityType_entityId: { portalId: this.portal.id, entityType, entityId } },
      create: { portalId: this.portal.id, entityType, entityId },
      update: {},
    });
  }

  /** Создано приложением по разрешению «создавать новые» — и разрешение всё ещё действует. */
  private async created(entityType: CreatedKind, id: unknown): Promise<boolean> {
    if (!/^\d+$/.test(String(id ?? '')) || !(await this.createAllowed())) return false;
    const row = await this.prisma.appCreatedEntity.findUnique({
      where: { portalId_entityType_entityId: { portalId: this.portal.id, entityType, entityId: Number(id) } },
    });
    return !!row;
  }

  private deal(id: unknown): boolean {
    return /^\d+$/.test(String(id ?? '')) && this.cfg.dealIds.includes(Number(id));
  }

  private async related(kind: keyof SandboxRelations, id: unknown): Promise<boolean> {
    if (!/^\d+$/.test(String(id ?? '')) || !this.cfg.dealIds.length) return false;
    return (await this.relationsOf(this.cfg.dealIds))[kind].includes(Number(id));
  }

  private inRange(period: unknown): boolean {
    if (this.from === null || this.to === null) return false;
    const p = (period ?? {}) as { from?: { timestamp?: unknown }; to?: { timestamp?: unknown } };
    const a = Number(p.from?.timestamp);
    const b = Number(p.to?.timestamp);
    return Number.isFinite(a) && Number.isFinite(b) && a < b && a >= this.from && b <= this.to;
  }

  private async owned(id: unknown): Promise<boolean> {
    if (!/^\d+$/.test(String(id ?? ''))) return false;
    const row = await this.prisma.sandboxBooking.findUnique({ where: { portalId_bookingId: { portalId: this.portal.id, bookingId: Number(id) } } });
    return !!row && !row.deletedAt;
  }
}

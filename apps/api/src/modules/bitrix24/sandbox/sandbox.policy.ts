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
const lc = (v: unknown) => String(v ?? '').toLowerCase();
/** `chat123` → 123; личный диалог (ID пользователя) — не чат, null. */
const chatOf = (dialogId: unknown) => /^chat(\d+)$/.exec(String(dialogId ?? ''))?.[1] ?? null;

/**
 * Разрешает изменяющий вызов в режиме только чтения, если он целиком внутри песочницы.
 * Всё, что не распознано, — запрещено. Брони меняются/удаляются только созданные песочницей
 * (журнал SandboxBooking), поэтому реальные брони недоступны даже при ошибке в коде выше.
 */
export class SandboxWritePolicy implements WritePolicy {
  private readonly from: number | null;
  private readonly to: number | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly portal: Portal,
    private readonly cfg: SandboxConfig,
    private readonly relationsOf: SandboxRelationsResolver = async () => ({ contactIds: [], invoiceIds: [], paymentIds: [], chatIds: [] }),
  ) {
    this.from = cfg.bookingsFrom ? zonedTimeToUtc(cfg.bookingsFrom, '00:00', portal.timezone).getTime() / 1000 : null;
    this.to = cfg.bookingsTo ? zonedTimeToUtc(cfg.bookingsTo, '00:00', portal.timezone).getTime() / 1000 : null;
  }

  async allows(method: string, params: P): Promise<boolean> {
    const fields = (params.fields ?? {}) as P;
    switch (lc(method)) {
      case 'crm.deal.update':
      case 'crm.deal.productrows.set':
        return this.deal(params.id);
      case 'crm.item.update':
        if (Number(params.entityTypeId) === 3) return this.related('contactIds', params.id);
        if (Number(params.entityTypeId) === 31) return this.related('invoiceIds', params.id);
        return Number(params.entityTypeId) === 2 && this.deal(params.id);
      // Правка контакта сделки песочницы (решение владельца): например, очистка e-mail «wazzup».
      case 'crm.contact.update':
        return this.related('contactIds', params.id);
      // Аннулирование ссылки на оплату = удаление неоплаченной оплаты счёта тестовой сделки.
      case 'crm.item.payment.delete':
      case 'crm.item.payment.update':
        return this.related('paymentIds', params.id);
      case 'crm.timeline.comment.add':
        return lc(fields.ENTITY_TYPE) === 'deal' && this.deal(fields.ENTITY_ID);
      case 'bizproc.workflow.start': {
        const doc = Array.isArray(params.DOCUMENT_ID) ? params.DOCUMENT_ID : [];
        const m = /^DEAL_(\d+)$/.exec(String(doc[2] ?? ''));
        return lc(doc[1]) === 'ccrmdocumentdeal' && !!m && this.deal(m[1]);
      }
      case 'imopenlines.crm.message.add':
        return lc(params.CRM_ENTITY_TYPE) === 'deal' && this.deal(params.CRM_ENTITY);
      // Чат открытой линии сделки песочницы (решение владельца): войти, писать, отправлять файлы.
      case 'imopenlines.session.join':
        return this.related('chatIds', params.CHAT_ID);
      // Чат уведомлений о бронях (решение владельца 2026-10-21: «создай новый чат»): создать один
      // раз, писать и обновлять только сообщения уведомлений.
      case 'im.chat.add':
        return !(await this.alertChatId());
      case 'im.message.add':
        return (await this.isAlertChat(chatOf(params.DIALOG_ID))) || this.related('chatIds', chatOf(params.DIALOG_ID));
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
        return this.inRange(fields.datePeriod);
      case 'booking.v1.booking.update':
        return (await this.owned(params.id)) && (fields.datePeriod === undefined || this.inRange(fields.datePeriod));
      case 'booking.v1.booking.delete':
        return this.owned(params.id);
      case 'booking.v1.booking.externaldata.set': {
        const items = (Array.isArray(params.externalData) ? params.externalData : []) as P[];
        return items.length > 0 && items.every((x) => lc(x.moduleId) === 'crm' && lc(x.entityTypeId) === 'deal' && this.deal(x.value)) && this.owned(params.bookingId);
      }
      case 'booking.v1.booking.externaldata.unset':
      case 'booking.v1.booking.client.set':
      case 'booking.v1.booking.client.unset':
        return this.owned(params.bookingId);
      default:
        return false;
    }
  }

  async recorded(method: string, params: P, result: unknown): Promise<void> {
    const m = lc(method);
    if (m === 'booking.v1.booking.add') {
      const id = typeof result === 'object' && result !== null ? Number((result as P).id) : Number(result);
      if (Number.isInteger(id) && id > 0) await this.prisma.sandboxBooking.create({ data: { portalId: this.portal.id, bookingId: id } });
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

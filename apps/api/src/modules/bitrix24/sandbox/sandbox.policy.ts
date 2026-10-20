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
const lc = (v: unknown) => String(v ?? '').toLowerCase();

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
        return Number(params.entityTypeId) === 2 && this.deal(params.id);
      case 'crm.timeline.comment.add':
        return lc(fields.ENTITY_TYPE) === 'deal' && this.deal(fields.ENTITY_ID);
      case 'bizproc.workflow.start': {
        const doc = Array.isArray(params.DOCUMENT_ID) ? params.DOCUMENT_ID : [];
        const m = /^DEAL_(\d+)$/.exec(String(doc[2] ?? ''));
        return lc(doc[1]) === 'ccrmdocumentdeal' && !!m && this.deal(m[1]);
      }
      case 'imopenlines.crm.message.add':
        return lc(params.CRM_ENTITY_TYPE) === 'deal' && this.deal(params.CRM_ENTITY);
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

  private deal(id: unknown): boolean {
    return /^\d+$/.test(String(id ?? '')) && this.cfg.dealIds.includes(Number(id));
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

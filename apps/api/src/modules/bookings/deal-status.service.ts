import { Injectable } from '@nestjs/common';
import { dealStatus, type DealStatusDto } from '@btx24/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { BookingJournalService } from './booking-journal.service.js';
import { DealFieldMapService } from './deal-field-map.service.js';

/** Сделка, как её отдаёт `crm.deal.list`: ID, семантика стадии и (если есть) поле конца брони. */
export type DealStageRow = Record<string, string | null | undefined> & { ID: string; STAGE_SEMANTIC_ID?: string | null };

const CHUNK = 200;

/**
 * Статус сделки «В работе / Ожидание клиента / Завершена / Провалена» (`dealStatus` из shared): канбан
 * сделки + её брони в журнале приложения (активные, без удалённых в Битрикс24 и ждущих решения). Журнал
 * о сделке не знает — поле «конец брони» сделки. Сделки — правами того, чей клиент передан.
 */
@Injectable()
export class DealStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: BookingJournalService,
    private readonly fieldMap: DealFieldMapService,
  ) {}

  /** Поле конца брони в сделке — добавить в `select` своего `crm.deal.list` и передать строки в `fromRows`. */
  async selectFields(portalId: string): Promise<string[]> {
    const end = (await this.fieldMap.get(portalId)).bookingEnd;
    return ['STAGE_SEMANTIC_ID', ...(end ? [end] : [])];
  }

  /** Статусы по уже загруженным сделкам (в `select` были `selectFields`). */
  async fromRows(portalId: string, rows: DealStageRow[], now = Date.now()): Promise<Map<number, DealStatusDto>> {
    const out = new Map<number, DealStatusDto>();
    const ids = [...new Set(rows.map((r) => Number(r.ID)).filter((x) => x > 0))];
    if (!ids.length) return out;
    const end = (await this.fieldMap.get(portalId)).bookingEnd;
    const records = await this.prisma.bookingRecord.findMany({
      where: { portalId, dealId: { in: ids } },
      select: { bookingId: true, dealId: true, status: true, startsAt: true, endsAt: true },
    });
    const gone = await this.journal.pendingRemoval(portalId, records.filter((r) => r.status === 'active').map((r) => r.bookingId));
    const known = new Set(records.map((r) => r.dealId));
    for (const r of rows) {
      const id = Number(r.ID);
      const bookings = known.has(id)
        ? records
            .filter((b) => b.dealId === id && b.status === 'active' && !gone.has(b.bookingId))
            .map((b) => ({ start: b.startsAt.toISOString(), end: b.endsAt.toISOString() }))
        : null;
      out.set(id, dealStatus({ stageSemantic: r.STAGE_SEMANTIC_ID, bookings, fieldEnd: end ? r[end] : null }, now));
    }
    return out;
  }

  /** Статусы сделок по ID: сделки — запросом клиента (недоступные пользователю в ответ не попадут). */
  async forDeals(portalId: string, client: Bitrix24RestClient, dealIds: number[]): Promise<Map<number, DealStatusDto>> {
    const ids = [...new Set(dealIds.filter((x) => x > 0))];
    if (!ids.length) return new Map();
    const select = ['ID', ...(await this.selectFields(portalId))];
    const rows: DealStageRow[] = [];
    for (let i = 0; i < ids.length; i += CHUNK)
      rows.push(...(await client.listAll<DealStageRow>('crm.deal.list', { filter: { '@ID': ids.slice(i, i + CHUNK) }, select })));
    return this.fromRows(portalId, rows);
  }
}

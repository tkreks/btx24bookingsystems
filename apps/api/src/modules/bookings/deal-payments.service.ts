import { Injectable, Logger } from '@nestjs/common';
import { todayIn, zonedDayRange } from '@btx24/shared';
import type { Portal } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { paidSum } from './deal-outcome.js';
import { DealFieldMapService } from './deal-field-map.service.js';

/** Строка-курсор (dealId 0): когда был прошлый проход. */
const CURSOR = 0;
const OVERLAP_MS = 10 * 60_000;
const MAX_SEED = 50_000;
const MAX_CHANGED = 5000;

type Row = Record<string, string | null>;

/**
 * Поступления оплат по сделкам (решение владельца 2026-10-23, «сделки с оплатой сегодня»). Оплата на
 * портале — это рост «Сумма внесённых оплат» (вручную, БП или пересчёт по счетам), а когда поле
 * изменилось, Битрикс24 не хранит. Поэтому worker раз в 5 минут смотрит изменённые сделки и сравнивает
 * сумму с последней увиденной (`DealPaidAmount`): выросла — `DealPayment` (на сколько, время изменения
 * сделки). Первый проход запоминает все сделки с оплатами; уже оплаченные сделки, созданные в этот день,
 * — оплата этого дня (время — последнее изменение сделки, приближение).
 */
@Injectable()
export class DealPaymentsService {
  private readonly logger = new Logger(DealPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldMap: DealFieldMapService,
  ) {}

  async scan(portal: Portal, client: Bitrix24RestClient, now = new Date()): Promise<{ payments: number }> {
    const code = (await this.fieldMap.outcome(portal.id, client)).paidAmount;
    if (!code) return { payments: 0 };
    const cursor = await this.prisma.dealPaidAmount.findUnique({ where: { portalId_dealId: { portalId: portal.id, dealId: CURSOR } } });
    const select = ['ID', 'DATE_CREATE', 'DATE_MODIFY', code];
    let payments = 0;
    if (!cursor) {
      const rows = await client.listAll<Row>('crm.deal.list', { filter: { [`>${code}`]: 0 }, select }, { max: MAX_SEED });
      const dayStart = zonedDayRange(todayIn(portal.timezone, now), portal.timezone).start.getTime();
      const seen = rows.map((r) => ({ dealId: Number(r.ID), amount: paidSum(r[code]) })).filter((r) => r.dealId > 0 && r.amount > 0);
      await this.prisma.dealPaidAmount.createMany({ data: seen.map((r) => ({ portalId: portal.id, dealId: r.dealId, amount: r.amount, checkedAt: now })), skipDuplicates: true });
      const today = rows.filter((r) => Date.parse(String(r.DATE_CREATE)) >= dayStart && paidSum(r[code]) > 0);
      if (today.length)
        await this.prisma.dealPayment.createMany({
          data: today.map((r) => ({ portalId: portal.id, dealId: Number(r.ID), amount: paidSum(r[code]), total: paidSum(r[code]), at: at(r, now) })),
        });
      payments = today.length;
    } else {
      const since = new Date(cursor.checkedAt.getTime() - OVERLAP_MS);
      const rows = await client.listAll<Row>('crm.deal.list', { filter: { '>=DATE_MODIFY': since.toISOString() }, select }, { max: MAX_CHANGED });
      const ids = rows.map((r) => Number(r.ID)).filter((x) => x > 0);
      const known = new Map(
        (ids.length ? await this.prisma.dealPaidAmount.findMany({ where: { portalId: portal.id, dealId: { in: ids } } }) : []).map((k) => [k.dealId, Number(k.amount)]),
      );
      for (const r of rows) {
        const dealId = Number(r.ID);
        const amount = paidSum(r[code]);
        const before = known.get(dealId) ?? 0;
        if (Math.abs(amount - before) < 0.005) continue;
        // Сумма выросла — поступила оплата; уменьшилась (возврат, исправление) — только запоминаем.
        if (amount > before) {
          await this.prisma.dealPayment.create({ data: { portalId: portal.id, dealId, amount: amount - before, total: amount, at: at(r, now) } });
          payments++;
        }
        await this.prisma.dealPaidAmount.upsert({
          where: { portalId_dealId: { portalId: portal.id, dealId } },
          create: { portalId: portal.id, dealId, amount, checkedAt: now },
          update: { amount, checkedAt: now },
        });
      }
    }
    await this.prisma.dealPaidAmount.upsert({
      where: { portalId_dealId: { portalId: portal.id, dealId: CURSOR } },
      create: { portalId: portal.id, dealId: CURSOR, amount: 0, checkedAt: now },
      update: { checkedAt: now },
    });
    if (payments) this.logger.log(`portal ${portal.id}: ${payments} deal payment(s)`);
    return { payments };
  }

  /** Сделки с поступившей за `[start, end)` оплатой: когда (последняя) и сколько всего за период. */
  async paidIn(portalId: string, start: Date, end: Date): Promise<Map<number, { at: Date; amount: number }>> {
    const rows = await this.prisma.dealPayment.findMany({ where: { portalId, at: { gte: start, lt: end } }, orderBy: { at: 'asc' } });
    const out = new Map<number, { at: Date; amount: number }>();
    for (const r of rows) out.set(r.dealId, { at: r.at, amount: (out.get(r.dealId)?.amount ?? 0) + Number(r.amount) });
    return out;
  }
}

/** Время оплаты — изменение сделки (не позже «сейчас»). */
function at(r: Row, now: Date): Date {
  const t = Date.parse(String(r.DATE_MODIFY ?? ''));
  return Number.isFinite(t) && t <= now.getTime() ? new Date(t) : now;
}

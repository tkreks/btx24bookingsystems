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

  /**
   * Сделки с поступившей за `[start, end)` оплатой: когда (последняя) и сколько всего за период.
   * Главный источник — смарт-счета, переведённые в «Оплачен» за период (`movedTime` — точное время,
   * и история есть за любой период, а не с первого прохода `scan`). Учёт `DealPayment` (рост «Суммы
   * внесённых оплат») — только для сделок без оплаченных счетов: у оплаченной счётом сделки поле
   * меняется позже (изменение сделки на другой день — не оплата этого дня).
   */
  async paidIn(portalId: string, client: Bitrix24RestClient, start: Date, end: Date): Promise<Map<number, { at: Date; amount: number }>> {
    const out = new Map<number, { at: Date; amount: number }>();
    const add = (dealId: number, at: Date, amount: number) => {
      const prev = out.get(dealId);
      out.set(dealId, { at: prev && prev.at > at ? prev.at : at, amount: (prev?.amount ?? 0) + amount });
    };
    const invoices = await client.listAll<Invoice>(
      'crm.item.list',
      { entityTypeId: 31, filter: { '>=movedTime': start.toISOString(), '<movedTime': end.toISOString() }, select: ['id', 'parentId2', 'opportunity', 'stageId', 'movedTime'] },
      { max: MAX_INVOICES, pick: items },
    );
    for (const i of invoices) {
      const dealId = Number(i.parentId2) || 0;
      const t = Date.parse(String(i.movedTime ?? ''));
      if (dealId > 0 && invoicePaid(i.stageId) && Number.isFinite(t)) add(dealId, new Date(t), Number(i.opportunity) || 0);
    }
    const rows = await this.prisma.dealPayment.findMany({ where: { portalId, at: { gte: start, lt: end } }, orderBy: { at: 'asc' } });
    const manual = [...new Set(rows.map((r) => r.dealId))].filter((id) => !out.has(id));
    if (!manual.length) return out;
    // Есть ли у этих сделок оплаченные счета вообще (за любое время) — тогда поле не в счёт.
    const withInvoices = new Set(
      (
        await client.listAll<Invoice>(
          'crm.item.list',
          { entityTypeId: 31, filter: { '@parentId2': manual }, select: ['id', 'parentId2', 'stageId'] },
          { max: MAX_INVOICES, pick: items },
        )
      )
        .filter((i) => invoicePaid(i.stageId))
        .map((i) => Number(i.parentId2)),
    );
    const counted = new Set(manual.filter((id) => !withInvoices.has(id)));
    for (const r of rows) if (counted.has(r.dealId)) add(r.dealId, r.at, Number(r.amount));
    return out;
  }
}

type Invoice = { id: number; parentId2?: number | null; opportunity?: number | null; stageId?: string | null; movedTime?: string | null };
const MAX_INVOICES = 5000;
const items = (r: unknown) => ((r as { items?: Invoice[] } | null)?.items ?? []);
/** Стадия счёта «Оплачен» (`DT31_<воронка>:P`) — как `invoicePaid` в payments (без цикла импортов). */
const invoicePaid = (stageId: unknown) => String(stageId ?? '').endsWith(':P');

/** Время оплаты — изменение сделки (не позже «сейчас»). */
function at(r: Row, now: Date): Date {
  const t = Date.parse(String(r.DATE_MODIFY ?? ''));
  return Number.isFinite(t) && t <= now.getTime() ? new Date(t) : now;
}

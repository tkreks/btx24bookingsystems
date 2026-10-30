import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PortalService } from '../modules/bitrix24/portals/portal.service.js';
import { crmItems, PaidAmountService } from '../modules/payments/paid-amount.service.js';

/**
 * «Сумма внесённых оплат» — раз в 5 минут: сделки, у которых менялись счета (в т.ч. выставленные
 * вручную в Битрикс24) или заявки на оплату приложения; первый проход — за сутки.
 */
export const PAID_AMOUNT_INTERVAL_MS = 5 * 60_000;
const FIRST_RUN_MS = 24 * 3600_000;
const OVERLAP_MS = 60_000;
/** Сделок за проход — больше аномалия; остальные — в следующий раз. */
const MAX_DEALS = 200;

@Injectable()
export class PaidAmountJob implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PaidAmountJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** Портал → с какого момента смотреть изменённые счета. */
  private readonly since = new Map<string, Date>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly portals: PortalService,
    private readonly paid: PaidAmountService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), PAID_AMOUNT_INTERVAL_MS);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const portals = await this.prisma.portal.findMany({ where: { status: 'ACTIVE' } });
      for (const portal of portals) {
        const started = new Date();
        const since = this.since.get(portal.id) ?? new Date(started.getTime() - FIRST_RUN_MS);
        const client = this.portals.clientFor(portal);
        try {
          const [invoices, requests] = await Promise.all([
            client.listAll<{ parentId2?: number | null }>('crm.item.list', { entityTypeId: 31, filter: { '>=updatedTime': since.toISOString() }, select: ['id', 'parentId2'] }, { max: 1000, pick: crmItems<{ parentId2?: number | null }> }),
            this.prisma.paymentRequest.findMany({ where: { portalId: portal.id, updatedAt: { gte: since } }, select: { dealId: true } }),
          ]);
          const deals = [...new Set([...invoices.map((i) => Number(i.parentId2) || 0), ...requests.map((r) => r.dealId)].filter((x) => x > 0))].slice(0, MAX_DEALS);
          for (const dealId of deals)
            await this.paid.recompute(portal.id, client, dealId).catch((e: unknown) => this.logger.warn(`deal ${dealId}: ${e instanceof Error ? e.message : String(e)}`));
          this.since.set(portal.id, new Date(started.getTime() - OVERLAP_MS));
        } catch (err) {
          this.logger.warn(`portal ${portal.id}: paid amount sweep failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

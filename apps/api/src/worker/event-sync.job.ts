import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { BOOKING_EVENTS, DEAL_EVENTS } from '../modules/bitrix24/install/install.service.js';
import { BookingSyncJob } from './booking-sync.job.js';
import { DealPaymentsJob } from './deal-payments.job.js';

/** Как часто смотреть пришедшие события (они приходят в api и ждут в `Bitrix24Event`). */
export const EVENT_SYNC_INTERVAL_MS = 15_000;

/**
 * События броней и сделок Битрикс24 (решение владельца 2026-10-24): присылают только ID, поэтому по ним
 * сразу запускается та же сверка броней (бронь создана / изменена / удалена) и учёт оплат (сделка
 * изменена) — изменения видны за секунды, а не через 10 минут. Пачка событий — один проход; плановая
 * сверка остаётся страховкой от потерянных событий. Обработанные события — `PROCESSED`.
 */
@Injectable()
export class EventSyncJob implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(EventSyncJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingSyncJob,
    private readonly payments: DealPaymentsJob,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), EVENT_SYNC_INTERVAL_MS);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.prisma.bitrix24Event.findMany({
        where: { status: 'PENDING', event: { in: [...BOOKING_EVENTS, ...DEAL_EVENTS] } },
        select: { id: true, portalId: true, event: true },
        orderBy: { receivedAt: 'asc' },
        take: 500,
      });
      for (const portalId of new Set(pending.map((e) => e.portalId))) {
        const portal = await this.prisma.portal.findFirst({ where: { id: portalId, status: 'ACTIVE' } });
        const mine = pending.filter((e) => e.portalId === portalId);
        const done: string[] = [];
        if (portal) {
          const booking = mine.filter((e) => (BOOKING_EVENTS as readonly string[]).includes(e.event));
          const deal = mine.filter((e) => (DEAL_EVENTS as readonly string[]).includes(e.event));
          if (booking.length && (await this.bookings.runPortal(portal))) done.push(...booking.map((e) => e.id));
          if (deal.length && (await this.payments.runPortal(portal))) done.push(...deal.map((e) => e.id));
        } else done.push(...mine.map((e) => e.id));
        if (done.length) {
          await this.prisma.bitrix24Event.updateMany({ where: { id: { in: done } }, data: { status: 'PROCESSED', processedAt: new Date() } });
          this.logger.log(`portal ${portalId}: ${done.length} booking/deal event(s) → sync`);
        }
      }
    } catch (err) {
      this.logger.warn(`event sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}

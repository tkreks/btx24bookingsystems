import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PortalService } from '../modules/bitrix24/portals/portal.service.js';
import { BookingSyncService } from '../modules/bookings/booking-sync.service.js';

/** Сверка броней и ресурсов с Битрикс24 — раз в 10 минут (первая — через минуту после старта). */
export const BOOKING_SYNC_INTERVAL_MS = 10 * 60_000;
const FIRST_RUN_DELAY_MS = 60_000;

@Injectable()
export class BookingSyncJob implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BookingSyncJob.name);
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly portals: PortalService,
    private readonly sync: BookingSyncService,
  ) {}

  onModuleInit() {
    this.first = setTimeout(() => void this.tick(), FIRST_RUN_DELAY_MS);
    this.timer = setInterval(() => void this.tick(), BOOKING_SYNC_INTERVAL_MS);
  }

  onApplicationShutdown() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** Проходы не накладываются; ошибка одного портала не останавливает остальные. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const portals = await this.prisma.portal.findMany({ where: { status: 'ACTIVE' } });
      for (const portal of portals) {
        let error: string | null = null;
        try {
          const r = await this.sync.reconcile(portal, this.portals.clientFor(portal));
          this.logger.log(
            `portal ${portal.id}: resources ${r.resources.total} (archived ${r.resources.archived}), ` +
              `bookings ${r.bookings.seen}, imported ${r.bookings.imported}, changed ${r.bookings.changed}, ` +
              `removed ${r.bookings.removed}, alerts ${r.bookings.alerts}${r.baseline ? ' (baseline)' : ''}`,
          );
        } catch (err) {
          error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          this.logger.warn(`portal ${portal.id}: booking sync failed: ${error}`);
        }
        await this.prisma.portalSettings.upsert({
          where: { portalId: portal.id },
          create: { portalId: portal.id, bookingSyncAt: new Date(), bookingSyncError: error },
          update: { bookingSyncAt: new Date(), bookingSyncError: error },
        });
      }
    } finally {
      this.running = false;
    }
  }
}

import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PortalService } from '../modules/bitrix24/portals/portal.service.js';
import { BookingTypeFillService } from '../modules/bookings/booking-type-fill.service.js';

/** Тип брони по товарам для сделок без типа — раз в 2 минуты; первый проход — сделки за сутки. */
export const BOOKING_TYPE_INTERVAL_MS = 2 * 60_000;
const FIRST_RUN_MS = 24 * 3600_000;
const OVERLAP_MS = 60_000;

@Injectable()
export class BookingTypeJob implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BookingTypeJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** Портал → с какого момента смотреть изменённые сделки. */
  private readonly since = new Map<string, Date>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly portals: PortalService,
    private readonly fill: BookingTypeFillService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), BOOKING_TYPE_INTERVAL_MS);
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
        try {
          await this.fill.fill(portal, this.portals.clientFor(portal), since);
          this.since.set(portal.id, new Date(started.getTime() - OVERLAP_MS));
        } catch (err) {
          this.logger.warn(`portal ${portal.id}: booking type fill failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Portal } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PortalService } from '../modules/bitrix24/portals/portal.service.js';
import { DealPaymentsService } from '../modules/bookings/deal-payments.service.js';

/** Поступления оплат по сделкам (рост «Сумма внесённых оплат») — раз в 5 минут, первый проход — сразу. */
export const DEAL_PAYMENTS_INTERVAL_MS = 5 * 60_000;

@Injectable()
export class DealPaymentsJob implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DealPaymentsJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly portals: PortalService,
    private readonly payments: DealPaymentsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), DEAL_PAYMENTS_INTERVAL_MS);
    setTimeout(() => void this.tick(), 30_000).unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Учёт оплат одного портала вне расписания — по событиям сделок; идёт плановый проход — false. */
  async runPortal(portal: Portal): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await this.payments.scan(portal, this.portals.clientFor(portal));
      return true;
    } catch (err) {
      this.logger.warn(`portal ${portal.id}: deal payments scan (events) failed: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    } finally {
      this.running = false;
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const portal of await this.prisma.portal.findMany({ where: { status: 'ACTIVE' } })) {
        try {
          await this.payments.scan(portal, this.portals.clientFor(portal));
        } catch (err) {
          this.logger.warn(`portal ${portal.id}: deal payments scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

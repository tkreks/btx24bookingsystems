import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PortalService } from '../modules/bitrix24/portals/portal.service.js';
import { AutoMessagesService } from '../modules/payments/auto-messages.service.js';

/** Автоматические рассылки по броням — раз в 5 минут (окно отправки — с запасом `AUTO_WINDOW_MARGIN_MIN`). */
export const AUTO_MESSAGE_INTERVAL_MS = 5 * 60_000;

@Injectable()
export class AutoMessageJob implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AutoMessageJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly portals: PortalService,
    private readonly auto: AutoMessagesService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), AUTO_MESSAGE_INTERVAL_MS);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const portal of await this.prisma.portal.findMany({ where: { status: 'ACTIVE' } })) {
        try {
          const r = await this.auto.run(portal, this.portals.clientFor(portal));
          if (r.sent || r.failed) this.logger.log(`portal ${portal.id}: auto messages sent ${r.sent}, failed ${r.failed}`);
        } catch (err) {
          this.logger.warn(`portal ${portal.id}: auto messages failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

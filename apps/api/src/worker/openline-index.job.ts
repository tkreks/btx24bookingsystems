import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PortalService } from '../modules/bitrix24/portals/portal.service.js';
import { OpenlineIndexService } from '../modules/openlines/openline-index.service.js';
import { ConversationsService } from '../modules/openlines/conversations.service.js';

/** Раз в минуту: индекс диалогов там, где включён «сбор метаданных», и удаление, где выключен. */
export const OPENLINE_INDEX_INTERVAL_MS = 60_000;

@Injectable()
export class OpenlineIndexJob implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OpenlineIndexJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly portals: PortalService,
    private readonly index: OpenlineIndexService,
    private readonly conversations: ConversationsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), OPENLINE_INDEX_INTERVAL_MS);
    void this.tick();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Проходы не накладываются: следующий начнётся, только когда закончится текущий. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const portals = await this.prisma.portal.findMany({ where: { status: 'ACTIVE' }, include: { settings: true } });
      for (const portal of portals) {
        try {
          if (portal.settings?.dialogMetadataEnabled) {
            if (!portal.settings.dialogTextsEnabled) {
              await this.index.purgeTexts(portal.id);
              await this.conversations.purge(portal.id);
            }
            const client = this.portals.clientFor(portal);
            await this.index.refresh(portal, client);
            // Переписки (ADR 0017): каналы линий и ключи — после индекса (новые чаты уже в нём).
            await this.conversations.refresh(portal, client);
          }
          else {
            await this.conversations.purge(portal.id);
            const removed = await this.index.purge(portal.id);
            if (removed) this.logger.log(`portal ${portal.id}: metadata collection off, ${removed} index rows removed`);
          }
        } catch (err) {
          // Ошибка одного портала (токен, лимиты) не останавливает остальные; повтор — через минуту.
          this.logger.warn(
            `portal ${portal.id}: index refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}

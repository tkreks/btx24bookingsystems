import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { matchesHash } from '../crypto/secret-box.js';
import { PortalService } from '../portals/portal.service.js';

export interface IncomingEvent {
  event?: string;
  data?: unknown;
  ts?: string;
  auth?: { member_id?: string; application_token?: string; domain?: string; [k: string]: unknown };
}

export type EventOutcome = 'stored' | 'processed' | 'rejected';

/**
 * Входящие события Битрикс24. Порядок по документации: проверить application_token → сохранить →
 * ответить 200. Портал не повторяет событие при ошибке, повторная доставка возможна — обработка
 * идемпотентна. Токены из `auth` в журнал не пишем.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly portals: PortalService,
  ) {}

  async receive(body: IncomingEvent): Promise<EventOutcome> {
    const memberId = body.auth?.member_id;
    const token = body.auth?.application_token;
    const event = typeof body.event === 'string' ? body.event.toUpperCase() : '';
    if (!memberId || !token || !event) return 'rejected';
    const portal = await this.portals.findActiveByMemberId(memberId);
    if (!portal || !matchesHash(token, portal.applicationTokenHash)) {
      this.logger.warn(`rejected ${event || 'event'} for member ${memberId}: unknown portal or bad application_token`);
      return 'rejected';
    }

    const payload = { event, data: body.data ?? null, ts: body.ts ?? null, domain: body.auth?.domain ?? null } as Prisma.InputJsonValue;
    const stored = await this.prisma.bitrix24Event.create({ data: { portalId: portal.id, event, payload } });

    if (event === 'ONAPPUNINSTALL') {
      await this.portals.markUninstalled(portal.id);
      await this.prisma.bitrix24Event.update({ where: { id: stored.id }, data: { status: 'PROCESSED', processedAt: new Date() } });
      this.logger.log(`uninstalled from ${portal.domain} (${portal.memberId})`);
      return 'processed';
    }
    // Остальные события обрабатывает worker (появятся вместе с синхронизацией броней).
    return 'stored';
  }
}

import { ContactAlertsService } from '../modules/contacts/contact-alerts.service.js';
import { Injectable, Logger, Optional, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PortalService } from '../modules/bitrix24/portals/portal.service.js';
import { CrmMirrorService } from '../modules/crm-mirror/crm-mirror.service.js';
import { crmEventTarget } from '../modules/crm-mirror/crm-rows.js';

@Injectable()
export class ContactSyncJob implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ContactSyncJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly prisma: PrismaService, private readonly portals: PortalService, private readonly mirror: CrmMirrorService, @Optional() private readonly alerts?: ContactAlertsService) {}
  onModuleInit() { this.timer = setInterval(() => void this.tick(), 15_000); void this.tick(); }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const portals = await this.prisma.portal.findMany({ where: { status: 'ACTIVE' } });
      for (const portal of portals) {
        const client = this.portals.clientFor(portal);
        const base = { portalId: portal.id, event: { in: ['ONCRMCONTACTADD', 'ONCRMCONTACTUPDATE', 'ONCRMCONTACTDELETE'] } };
        const pending = await this.prisma.bitrix24Event.findMany({ where: { ...base, status: 'PENDING' }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: 100 });
        const failed = await this.prisma.bitrix24Event.findMany({ where: { ...base, status: 'FAILED', processedAt: { lt: new Date(Date.now() - 60_000) } }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: 20 });
        const events = [...pending, ...failed];
        for (const event of events) {
          try {
            const target = crmEventTarget(event.event, (event.payload as { data?: unknown } | null)?.data);
            if (target) await this.mirror.refreshContact(portal, client, target.id, target.deleted, event.receivedAt);
            await this.prisma.bitrix24Event.update({ where: { id: event.id }, data: { status: 'PROCESSED', processedAt: new Date(), error: null } });
          } catch {
            await this.prisma.bitrix24Event.update({ where: { id: event.id }, data: { status: 'FAILED', processedAt: new Date(), error: 'Contact sync failed; will retry' } });
          }
        }
        try { await this.mirror.syncContacts(portal, client, false); await this.mirror.syncContacts(portal, client, true); await this.mirror.reconcileContacts(portal, client); }
        catch { this.logger.warn(`portal ${portal.id}: contact sync will retry`); }
        await this.alerts?.deliverPending(portal, client).catch(() => this.logger.warn(`portal ${portal.id}: contact alerts will retry`));
      }
    } catch { this.logger.warn('Contact sync failed; will retry'); }
    finally { this.running = false; }
  }
}

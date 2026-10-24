import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Portal } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CRM_MIRROR_EVENTS, DEAL_EVENTS } from '../modules/bitrix24/install/install.service.js';
import { PortalService } from '../modules/bitrix24/portals/portal.service.js';
import { crmEventTarget } from '../modules/crm-mirror/crm-rows.js';
import { CrmMirrorService } from '../modules/crm-mirror/crm-mirror.service.js';
import { CRM_ACCESS_KEEP_MS } from '../modules/crm-mirror/crm-access.service.js';

/** Как часто смотреть события CRM и продолжать первичную загрузку. */
export const CRM_MIRROR_TICK_MS = 5_000;
/** Изменения по дате — страховка от потерянных событий (и единственный путь без подписок). */
export const CRM_SWEEP_MS = 60_000;
export const EMPLOYEES_MS = 10 * 60_000;
const SWEEP_KINDS = ['deal', 'call', 'entity'] as const;

/**
 * Копия CRM для дашборда (ADR 0013): события CRM (сделки, дела, контакты, лиды, компании) → сразу
 * изменения этого вида; раз в минуту — все изменения по дате; первичная загрузка — частями, пока не
 * закончится; сотрудники — раз в 10 минут. Всё — токеном приложения.
 */
@Injectable()
export class CrmMirrorJob implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(CrmMirrorJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** События после этого момента ещё не разобраны (статус сделок ведёт EventSyncJob — не трогаем). */
  private eventsAfter = new Date(Date.now() - 10 * 60_000);
  private readonly lastSweep = new Map<string, number>();
  private readonly lastEmployees = new Map<string, number>();
  private lastPrune = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly portals: PortalService,
    private readonly mirror: CrmMirrorService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), CRM_MIRROR_TICK_MS);
    void this.tick();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const events = await this.prisma.bitrix24Event.findMany({
        where: { event: { in: [...CRM_MIRROR_EVENTS] }, receivedAt: { gt: this.eventsAfter } },
        select: { id: true, portalId: true, event: true, payload: true, receivedAt: true },
        orderBy: { receivedAt: 'asc' },
        take: 1000,
      });
      if (events.length) this.eventsAfter = events[events.length - 1].receivedAt;
      const portals = await this.prisma.portal.findMany({ where: { status: 'ACTIVE' } });
      for (const portal of portals) {
        try {
          await this.runPortal(portal, events.filter((e) => e.portalId === portal.id), now);
        } catch (err) {
          // Сбой портала (токен, лимиты) не мешает остальным; повтор — в следующий проход.
          this.logger.warn(`portal ${portal.id}: crm mirror failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (now - this.lastPrune >= 3600_000) {
        this.lastPrune = now;
        // Ответы о правах, которых давно не спрашивали, — удаляем (вернувшийся подождёт первую проверку).
        await this.prisma.crmAccessCheck.deleteMany({ where: { checkedAt: { lt: new Date(now - CRM_ACCESS_KEEP_MS) } } });
      }
      const own = events.filter((e) => !(DEAL_EVENTS as readonly string[]).includes(e.event)).map((e) => e.id);
      if (own.length) await this.prisma.bitrix24Event.updateMany({ where: { id: { in: own } }, data: { status: 'PROCESSED', processedAt: new Date() } });
    } finally {
      this.running = false;
    }
  }

  private async runPortal(portal: Portal, events: { event: string; payload: unknown }[], now: number): Promise<void> {
    const client = this.portals.clientFor(portal);
    const kinds = new Set<(typeof SWEEP_KINDS)[number]>();
    for (const e of events) {
      const t = crmEventTarget(e.event, (e.payload as { data?: unknown } | null)?.data);
      if (!t) continue;
      if (t.deleted) await this.mirror.markDeleted(portal.id, t);
      else kinds.add(t.kind);
    }
    const due = now - (this.lastSweep.get(portal.id) ?? 0) >= CRM_SWEEP_MS;
    if (due) this.lastSweep.set(portal.id, now);
    const sweep = due ? SWEEP_KINDS : SWEEP_KINDS.filter((k) => kinds.has(k));
    if (sweep.length) await this.mirror.sweep(portal, client, sweep, new Date(now));
    if (now - (this.lastEmployees.get(portal.id) ?? 0) >= EMPLOYEES_MS) {
      this.lastEmployees.set(portal.id, now);
      await this.mirror.syncEmployees(portal, client).catch((err: unknown) => this.logger.warn(`portal ${portal.id}: employees: ${err instanceof Error ? err.message : String(err)}`));
    }
    const warn = (what: string) => (err: unknown) => this.logger.warn(`portal ${portal.id}: ${what}: ${err instanceof Error ? err.message : String(err)}`);
    await this.mirror.backfillDeals(portal, client).catch(warn('deals backfill'));
    await this.mirror.backfillCalls(portal, client, new Date(now)).catch(warn('calls backfill'));
    if (due) await this.mirror.fillCallStats(portal, client, new Date(now)).catch(() => undefined);
  }
}

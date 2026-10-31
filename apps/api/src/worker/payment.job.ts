import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PortalService } from '../modules/bitrix24/portals/portal.service.js';
import { msg, PaymentFlow } from '../modules/payments/payment-flow.js';

/** Счета и ссылки на оплату (ADR 0009): ссылка → сообщение клиенту, оплата, срок — раз в 30 секунд. */
export const PAYMENT_JOB_INTERVAL_MS = 30_000;

@Injectable()
export class PaymentJob implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly portals: PortalService,
    private readonly flow: PaymentFlow,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), PAYMENT_JOB_INTERVAL_MS);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Проходы не накладываются; сбой одной заявки не останавливает остальные (повтор — в следующий проход). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const open = await this.prisma.paymentRequest.findMany({ where: { status: { in: ['link_pending', 'sent'] } }, orderBy: { createdAt: 'asc' }, take: 200 });
      for (const req of open) {
        const portal = await this.prisma.portal.findUnique({ where: { id: req.portalId } });
        if (!portal || portal.status !== 'ACTIVE') continue;
        try {
          const next = await this.flow.advance({ portal, client: this.portals.clientFor(portal), actor: { kind: 'system', name: 'Система: оплаты' } }, req);
          if (next.status !== req.status) this.logger.log(`payment ${req.id} (deal ${req.dealId}): ${req.status} → ${next.status}`);
        } catch (err) {
          await this.prisma.paymentRequest.update({ where: { id: req.id }, data: { attempts: { increment: 1 } } });
          this.logger.warn(`payment ${req.id} (deal ${req.dealId}): ${msg(err)}`);
        }
      }
      await this.reannulClosed();
    } finally {
      this.running = false;
    }
  }

  /** Закрытые заявки, у которых ссылка осталась рабочей (счёт не считался «своим»): удалить неоплаченные оплаты. */
  private async reannulClosed(): Promise<void> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM PaymentRequest WHERE status IN ('expired','cancelled','failed') AND closedAt > (UTC_TIMESTAMP(3) - INTERVAL 7 DAY) AND warnings LIKE '%ссылку не аннулируем%' LIMIT 20`;
    for (const { id } of rows) {
      const req = await this.prisma.paymentRequest.findUnique({ where: { id } });
      const portal = req && (await this.prisma.portal.findUnique({ where: { id: req.portalId } }));
      if (!req || !portal || portal.status !== 'ACTIVE') continue;
      try {
        await this.flow.reannul({ portal, client: this.portals.clientFor(portal), actor: { kind: 'system', name: 'Система: оплаты' } }, req);
        this.logger.log(`payment ${req.id} (deal ${req.dealId}): payment link annulled after close`);
      } catch (err) {
        this.logger.warn(`payment ${req.id} (deal ${req.dealId}): reannul failed: ${msg(err)}`);
      }
    }
  }
}

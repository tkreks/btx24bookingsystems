import { Injectable, Logger } from '@nestjs/common';
import type { Portal, Prisma } from '../../../generated/prisma/client.js';
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

/** Обработчик событий другого модуля (по префиксу имени): получает портал и `data` события. */
export type BitrixEventHandler = (portal: Portal, event: string, data: unknown) => Promise<void>;
const handlers = new Map<string, BitrixEventHandler>();
/**
 * Подписать модуль на события Битрикс24 по префиксу (например, `ONIMCONNECTOR` — мессенджеры):
 * событие сохраняется как обычно, обработчик выполняется сразу после ответа порталу.
 */
export function onBitrixEvent(prefix: string, handler: BitrixEventHandler): void {
  handlers.set(prefix.toUpperCase(), handler);
}

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
    if (event.startsWith('ONVOXIMPLANTCALL')) {
      await this.telephony(portal.id, event, (body.data ?? {}) as Record<string, unknown>);
      await this.prisma.bitrix24Event.update({ where: { id: stored.id }, data: { status: 'PROCESSED', processedAt: new Date() } });
      return 'processed';
    }
    const handler = [...handlers].find(([prefix]) => event.startsWith(prefix))?.[1];
    if (handler) {
      // Порталу отвечаем сразу; итог — в статусе события (повторная доставка обрабатывается идемпотентно).
      void handler(portal, event, body.data ?? null).then(
        () => this.prisma.bitrix24Event.update({ where: { id: stored.id }, data: { status: 'PROCESSED', processedAt: new Date() } }),
        (err: unknown) => {
          this.logger.warn(`${event}: ${err instanceof Error ? err.message : String(err)}`);
          return this.prisma.bitrix24Event.update({ where: { id: stored.id }, data: { status: 'FAILED', error: String(err instanceof Error ? err.message : err).slice(0, 2000), processedAt: new Date() } });
        },
      );
      return 'stored';
    }
    // Остальные события обрабатывает worker (появятся вместе с синхронизацией броней).
    return 'stored';
  }

  /**
   * Звонок по событиям телефонии (решение владельца 2026-10-23): начало — номер клиента и тип,
   * ответ — сотрудник (ему приложение показывает карточку клиента), конец — итог. Порядок и повторы
   * событий не важны: строка одна на звонок (`portalId + callId`), каждое событие дописывает своё.
   */
  private async telephony(portalId: string, event: string, d: Record<string, unknown>): Promise<void> {
    const callId = String(d.CALL_ID ?? '').slice(0, 100);
    if (!callId) return;
    const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : null);
    const callType = num(d.CALL_TYPE);
    const now = new Date();
    let data: Record<string, unknown> = {};
    if (event === 'ONVOXIMPLANTCALLINIT')
      // Входящий — номер клиента в CALLER_ID; исходящий — набираемый номер в PHONE_NUMBER.
      data = { callType, phone: callType === 1 ? str(d.PHONE_NUMBER) : (str(d.CALLER_ID) ?? str(d.PHONE_NUMBER)) };
    else if (event === 'ONVOXIMPLANTCALLSTART') data = { userId: num(d.USER_ID), answeredAt: now };
    else if (event === 'ONVOXIMPLANTCALLEND')
      data = { callType, phone: str(d.PHONE_NUMBER), userId: num(d.PORTAL_USER_ID), endedAt: now, crmActivityId: num(d.CRM_ACTIVITY_ID) };
    // Пустые значения не затирают известные (конец без номера после начала с номером).
    const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== undefined));
    await this.prisma.telephonyCall.upsert({
      where: { portalId_callId: { portalId, callId } },
      create: { portalId, callId, startedAt: now, ...patch },
      update: patch,
    });
  }
}

import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import {
  ALERT_STATUSES,
  type AlertProblem,
  type AlertResolution,
  type AlertStatus,
  type BookingAlertDto,
  type BookingAlertListDto,
  type BookingStateDto,
} from '@btx24/shared';
import { Prisma, type BookingAlert, type Portal } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { PortalService } from '../bitrix24/portals/portal.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { alertMessage } from './alert-message.js';
import { BookingJournalService } from './booking-journal.service.js';
import type { BookingRestoreService } from './booking-restore.service.js';

export interface RaiseAlertInput {
  kind: 'new_booking' | 'discrepancy';
  problems: AlertProblem[];
  bookingId: number;
  dealId: number | null;
  title?: string | null;
  expected: BookingStateDto | null;
  actual: BookingStateDto | null;
}

/** Неотправленные уведомления старше — не досылаем (неактуальны). */
const RESEND_WINDOW_MS = 3 * 24 * 3600_000;
const LIST_LIMIT = 200;

/**
 * Уведомления о бронях: новая бронь мимо приложения и расхождения. Одинаковое уведомление дважды
 * не создаётся (отпечаток). Сообщения в чат уведомлений пишет приложение (системное действие),
 * статус меняют сотрудники — сообщение в чате обновляется.
 */
@Injectable()
export class BookingAlertsService {
  private readonly logger = new Logger(BookingAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly portals: PortalService,
    private readonly journal: BookingJournalService,
    // Только в api (решения сотрудников); worker уведомления лишь создаёт и отправляет.
    @Optional() private readonly restore?: BookingRestoreService,
  ) {}

  /** null — такое уведомление уже есть. */
  async raise(portalId: string, a: RaiseAlertInput): Promise<BookingAlert | null> {
    try {
      return await this.prisma.bookingAlert.create({
        data: {
          portalId,
          kind: a.kind,
          problem: a.problems.length ? a.problems.join(',') : null,
          bookingId: a.bookingId,
          dealId: a.dealId,
          expected: a.expected ? (a.expected as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          actual: a.actual ? ({ ...a.actual, title: a.title ?? null } as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          fingerprint: fingerprint(a),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  }

  async list(portal: Portal, status: unknown): Promise<BookingAlertListDto> {
    const filter = status === undefined || status === '' ? undefined : (status as AlertStatus);
    if (filter && !ALERT_STATUSES.includes(filter))
      throw new BadRequestException({ code: 'INVALID_STATUS', message: 'status: new, viewed, resolved или ignored' });
    const [rows, grouped, resources, settings] = await Promise.all([
      this.prisma.bookingAlert.findMany({
        where: { portalId: portal.id, ...(filter ? { status: filter } : {}) },
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
      }),
      this.prisma.bookingAlert.groupBy({ by: ['status'], where: { portalId: portal.id }, _count: true }),
      this.prisma.resource.findMany({ where: { portalId: portal.id } }),
      this.prisma.portalSettings.findUnique({ where: { portalId: portal.id } }),
    ]);
    const counts = Object.fromEntries(ALERT_STATUSES.map((s) => [s, 0])) as Record<AlertStatus, number>;
    for (const g of grouped) counts[g.status] = g._count;
    return {
      items: rows.map(toDto),
      counts,
      resources: Object.fromEntries(resources.map((r) => [String(r.resourceId), r.name])),
      chatConfigured: !!settings?.alertChatId,
    };
  }

  async get(portalId: string, id: string): Promise<BookingAlert> {
    const a = await this.prisma.bookingAlert.findFirst({ where: { id, portalId } });
    if (!a) throw new NotFoundException({ code: 'ALERT_NOT_FOUND', message: 'Уведомление не найдено' });
    return a;
  }

  /** Сменить статус (кто и когда — в уведомлении и в сообщении чата). */
  async setStatus(user: B24UserContext, id: string, body: unknown): Promise<BookingAlertDto> {
    const status = (body as { status?: unknown } | null)?.status as AlertStatus;
    if (!ALERT_STATUSES.includes(status))
      throw new BadRequestException({ code: 'INVALID_STATUS', message: 'status: new, viewed, resolved или ignored' });
    const alert = await this.get(user.portal.id, id);
    // Бронь пропала в Битрикс24 и ещё активна у нас: «Решено» — только решением (создать заново или удалить).
    if (status === 'resolved' && alert.kind === 'discrepancy' && toDto(alert).problems.includes('missing')) {
      const record = await this.journal.find(user.portal.id, alert.bookingId);
      if (record?.status === 'active')
        throw new BadRequestException({
          code: 'DECISION_REQUIRED',
          message: 'Выберите решение: «Создать бронирование в Битрикс24» или «Удалить бронирование в приложении»',
        });
    }
    return this.applyStatus(user, id, status);
  }

  private async applyStatus(user: B24UserContext, id: string, status: AlertStatus): Promise<BookingAlertDto> {
    const updated = await this.prisma.bookingAlert.update({
      where: { id },
      data: { status, statusByUserId: user.userId, statusByName: user.userName, statusAt: new Date() },
    });
    await this.refreshMessage(user.portal, updated).catch((err) =>
      this.logger.warn(`alert ${id}: chat message not updated: ${err instanceof Error ? err.message : String(err)}`),
    );
    return toDto(updated);
  }

  /**
   * Решение по уведомлению — от имени сотрудника, с записью в историю брони:
   * - `accept_bitrix` — принять как в Битрикс24 (нет брони — отменить у нас с причиной);
   * - `cancel_booking` — отменить бронь: удалить в Битрикс24 (его токеном) и отменить у нас;
   * - `recreate` — бронь пропала в Битрикс24: создать её там заново по данным приложения.
   * После — статус «Решено».
   */
  async resolve(user: B24UserContext, id: string, body: unknown): Promise<BookingAlertDto> {
    const resolution = (body as { resolution?: unknown } | null)?.resolution;
    if (resolution !== 'accept_bitrix' && resolution !== 'cancel_booking' && resolution !== 'recreate')
      throw new BadRequestException({ code: 'INVALID_RESOLUTION', message: 'resolution: accept_bitrix, cancel_booking или recreate' });
    const alert = await this.get(user.portal.id, id);
    const dto = toDto(alert);
    const actor = { kind: 'user' as const, userId: user.userId, name: user.userName };
    const record = await this.journal.find(user.portal.id, alert.bookingId);
    if (resolution === 'recreate') {
      if (!dto.problems.includes('missing'))
        throw new BadRequestException({ code: 'CANNOT_RECREATE', message: 'Создать заново можно только бронь, которой нет в Битрикс24' });
      if (!this.restore) throw new Error('BookingRestoreService is not available');
      await this.restore.recreate(user, alert.bookingId);
    } else if (resolution === 'accept_bitrix') {
      if (dto.problems.includes('not_cancelled'))
        throw new BadRequestException({
          code: 'CANNOT_ACCEPT',
          message: 'Бронь отменена в приложении — её можно только снять в Битрикс24 («Отменить бронь»)',
        });
      if (record && record.status === 'active') {
        // Пропала в Битрикс24 — «Удалить бронирование в приложении»: проверка, что её там правда нет,
        // и право снимать брони в группе её ресурса.
        if (!dto.actual && this.restore) await this.restore.removeInApp(user, alert.bookingId);
        else if (dto.actual) await this.journal.recordChanged(record, dto.actual, actor, 'accepted_bitrix', 'app');
        else await this.journal.recordCancelled(user.portal.id, alert.bookingId, { reason: 'removed_in_bitrix', actor });
      }
    } else {
      // Удаление в Битрикс24 — токеном сотрудника: действуют его права и режим «только чтение».
      if (dto.actual || alert.kind === 'new_booking') await user.client.call('booking.v1.booking.delete', { id: alert.bookingId });
      if (record?.status === 'active')
        await this.journal.recordCancelled(user.portal.id, alert.bookingId, { reason: 'manual', actor });
      else if (record) await this.journal.note(record, 'deleted_in_bitrix', actor, { alertId: id }, 'app');
    }
    return this.applyStatus(user, id, 'resolved');
  }

  /**
   * Решение по брони, пропавшей в Битрикс24, из календаря: есть открытое уведомление — решаем через
   * него (статус «Решено», сообщение в чате); сверка ещё не успела — действуем напрямую.
   */
  async resolveMissing(user: B24UserContext, bookingId: number, resolution: Extract<AlertResolution, 'recreate' | 'accept_bitrix'>): Promise<void> {
    const alert = await this.prisma.bookingAlert.findFirst({
      where: { portalId: user.portal.id, bookingId, kind: 'discrepancy', problem: { contains: 'missing' }, status: { not: 'resolved' } },
      orderBy: { createdAt: 'desc' },
    });
    if (alert) {
      await this.resolve(user, alert.id, { resolution });
      return;
    }
    if (!this.restore) throw new Error('BookingRestoreService is not available');
    if (resolution === 'recreate') await this.restore.recreate(user, bookingId);
    else await this.restore.removeInApp(user, bookingId);
  }

  /** Отправить в чат уведомления, которые ещё не ушли (новые и недавние). Ошибка — повтор на следующем проходе. */
  async deliverPending(portal: Portal, client: Bitrix24RestClient): Promise<number> {
    const settings = await this.prisma.portalSettings.findUnique({ where: { portalId: portal.id } });
    if (!settings?.alertChatId) return 0;
    const pending = await this.prisma.bookingAlert.findMany({
      where: { portalId: portal.id, messageId: null, createdAt: { gte: new Date(Date.now() - RESEND_WINDOW_MS) } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    if (!pending.length) return 0;
    const ctx = await this.messageContext(portal, client);
    let sent = 0;
    for (const a of pending) {
      try {
        const res = await client.call<number>('im.message.add', {
          DIALOG_ID: `chat${settings.alertChatId}`,
          ...alertMessage({ ...this.messageInput(a, ctx), status: a.status }),
          URL_PREVIEW: 'N',
        });
        await this.prisma.bookingAlert.update({
          where: { id: a.id },
          data: { chatId: settings.alertChatId, messageId: Number(res.result), sendError: null },
        });
        sent++;
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        await this.prisma.bookingAlert.update({ where: { id: a.id }, data: { sendError: message } });
      }
    }
    return sent;
  }

  /** Обновить сообщение в чате (статус). Редактирование запрещено (старое) — ответом на него. */
  private async refreshMessage(portal: Portal, a: BookingAlert): Promise<void> {
    if (!a.messageId || !a.chatId) return;
    const client = this.portals.clientFor(portal);
    const ctx = await this.messageContext(portal, client);
    const msg = alertMessage(this.messageInput(a, ctx));
    try {
      await client.call('im.message.update', { MESSAGE_ID: a.messageId, ...msg, IS_EDITED: 'N' });
    } catch {
      await client.call('im.message.add', {
        DIALOG_ID: `chat${a.chatId}`,
        REPLY_ID: a.messageId,
        MESSAGE: msg.MESSAGE.split('\n').at(-1) ?? '',
      });
    }
  }

  private messageInput(a: BookingAlert, ctx: { resources: Map<number, string>; appPath: string | null; tz: string }) {
    const dto = toDto(a);
    return {
      kind: a.kind,
      problems: dto.problems,
      bookingId: a.bookingId,
      dealId: a.dealId,
      title: dto.actual?.title ?? null,
      expected: dto.expected,
      actual: dto.actual,
      status: a.status,
      statusBy: a.statusByName && a.statusAt ? `${a.statusByName}, ${shortDateTime(a.statusAt, ctx.tz)}` : null,
      resources: ctx.resources,
      timeZone: ctx.tz,
      appPath: ctx.appPath,
      alertId: a.id,
    };
  }

  private async messageContext(portal: Portal, client: Bitrix24RestClient) {
    const resources = await this.prisma.resource.findMany({ where: { portalId: portal.id } });
    return {
      resources: new Map(resources.map((r) => [r.resourceId, r.name])),
      appPath: await this.appPath(portal, client),
      tz: portal.timezone,
    };
  }

  /** Страница приложения в портале (`/marketplace/app/<ID>/`); кэш на процесс. */
  private readonly appPaths = new Map<string, string | null>();
  private async appPath(portal: Portal, client: Bitrix24RestClient): Promise<string | null> {
    if (this.appPaths.has(portal.id)) return this.appPaths.get(portal.id)!;
    let path: string | null = null;
    try {
      const res = await client.call<{ ID?: number | string }>('app.info');
      if (res.result?.ID) path = `/marketplace/app/${res.result.ID}/`;
    } catch {
      path = null;
    }
    this.appPaths.set(portal.id, path);
    return path;
  }
}

export function toDto(a: BookingAlert): BookingAlertDto {
  return {
    id: a.id,
    kind: a.kind,
    problems: (a.problem ? a.problem.split(',') : []) as AlertProblem[],
    bookingId: a.bookingId,
    dealId: a.dealId,
    expected: (a.expected as BookingStateDto | null) ?? null,
    actual: (a.actual as (BookingStateDto & { title?: string | null }) | null) ?? null,
    status: a.status,
    statusBy: a.statusByUserId ? { id: a.statusByUserId, name: a.statusByName ?? `#${a.statusByUserId}` } : null,
    statusAt: a.statusAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    delivered: a.messageId !== null,
    sendError: a.sendError,
  };
}

/** Одно и то же расхождение (тот же вид и то же фактическое состояние) — одно уведомление. */
export function fingerprint(a: RaiseAlertInput): string {
  const s = a.actual;
  const state = s ? `${s.startsAt}|${s.endsAt}|${[...s.resourceIds].sort((x, y) => x - y).join('.')}|${s.dealId ?? ''}` : 'none';
  return `${a.kind}:${a.bookingId}:${a.problems.join('.')}:${state}`.slice(0, 191);
}

function shortDateTime(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
}

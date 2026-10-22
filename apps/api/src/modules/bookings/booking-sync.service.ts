import { Injectable } from '@nestjs/common';
import { todayIn, zonedDayRange, type AlertProblem, type BookingStateDto } from '@btx24/shared';
import type { BookingRecord, Portal } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { diffState } from './alert-message.js';
import { BookingAlertsService } from './booking-alerts.service.js';
import { BookingJournalService, stateOf, SYSTEM } from './booking-journal.service.js';
import { dealLinks, getBooking, listBookings, listResources, type RawBooking } from './bitrix-bookings.js';

export interface SyncReport {
  resources: { total: number; archived: number };
  bookings: { seen: number; imported: number; changed: number; removed: number; alerts: number };
  baseline: boolean;
}

type Actual = BookingStateDto & { title: string | null };
const DAY_MS = 86_400_000;
/**
 * Сколько дней назад сверять брони с Битрикс24 (дашборд показывает новые и удалённые за период до
 * 30 дней): известные — не удалили ли; неизвестные прошедшие — в журнал без уведомления.
 */
export const SYNC_LOOKBACK_DAYS = 31;

/**
 * Сверка с Битрикс24 (ADR 0007), токеном приложения, в worker:
 * ресурсы → зеркало `Resource`; брони на горизонте `[сегодня, +syncHorizonDays)` → журнал; известные
 * брони за `SYNC_LOOKBACK_DAYS` назад — в журнал (без уведомлений) и проверка, не удалили ли их.
 * - бронь не из приложения, новая — записывается (`source = bitrix`) и даёт уведомление
 *   «найдено новое бронирование»; первый проход (`bookingSyncBaselineAt` пуст) принимает всё молча;
 * - бронь приложения не совпала / пропала — уведомление о расхождении; запись не меняется,
 *   пока сотрудник не решит, как поступить;
 * - бронь из Битрикс24 изменили или удалили там — запись следует за Битрикс24 (с историей).
 */
@Injectable()
export class BookingSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: BookingJournalService,
    private readonly alerts: BookingAlertsService,
  ) {}

  async reconcile(portal: Portal, client: Bitrix24RestClient, now = new Date()): Promise<SyncReport> {
    const settings = await this.prisma.portalSettings.upsert({
      where: { portalId: portal.id },
      create: { portalId: portal.id },
      update: {},
    });
    const resources = await this.syncResources(portal.id, client, now);
    const baseline = settings.bookingSyncBaselineAt !== null;
    const from = zonedDayRange(todayIn(portal.timezone, now), portal.timezone).start;
    const to = new Date(from.getTime() + settings.syncHorizonDays * DAY_MS);
    const pastFrom = new Date(from.getTime() - SYNC_LOOKBACK_DAYS * DAY_MS);

    const raw = await listBookings(client, sec(pastFrom), sec(to));
    const links = await dealLinks(client, raw.map((b) => Number(b.id)));
    const actual = new Map(raw.map((b) => [Number(b.id), toActual(b, links.get(Number(b.id)) ?? null)]));
    const records = await this.prisma.bookingRecord.findMany({
      where: {
        portalId: portal.id,
        OR: [{ bookingId: { in: [...actual.keys()] } }, { status: 'active', endsAt: { gt: pastFrom }, startsAt: { lt: to } }],
      },
    });
    const byBooking = new Map(records.map((r) => [r.bookingId, r]));
    const report = { seen: actual.size, imported: 0, changed: 0, removed: 0, alerts: 0 };

    for (const [bookingId, a] of actual) {
      const r = byBooking.get(bookingId);
      if (!r) {
        // Прошедшая бронь, которой нет в журнале (создали задним числом или до приложения): в журнал
        // для истории, но без уведомления и с «созданием» на дату брони — не как новая сегодня.
        if (Date.parse(a.endsAt) <= from.getTime()) {
          const { created } = await this.journal.recordImported(portal.id, { ...importInput(bookingId, a), createdAt: new Date(a.startsAt) });
          if (created) report.imported++;
          continue;
        }
        const { created } = await this.journal.recordImported(portal.id, importInput(bookingId, a));
        if (created) report.imported++;
        if (created && baseline && (await this.alerts.raise(portal.id, newBooking(bookingId, a)))) report.alerts++;
      } else {
        const res = await this.compare(r, a);
        report.changed += res.changed;
        report.alerts += res.alerts;
      }
    }

    // Записи, которых нет среди броней горизонта: могли перенести за горизонт — проверяем точечно.
    for (const r of records) {
      if (r.status !== 'active' || actual.has(r.bookingId)) continue;
      const b = await getBooking(client, r.bookingId);
      if (b) {
        const links1 = await dealLinks(client, [r.bookingId]);
        const res = await this.compare(r, toActual(b, links1.get(r.bookingId) ?? null));
        report.changed += res.changed;
        report.alerts += res.alerts;
      } else if (r.source === 'bitrix') {
        if (await this.journal.recordCancelled(portal.id, r.bookingId, { reason: 'removed_in_bitrix', actor: SYSTEM.bitrix, via: 'reconcile' }))
          report.removed++;
      } else if (await this.discrepancy(r, ['missing'], null)) report.alerts++;
    }

    if (!baseline)
      await this.prisma.portalSettings.update({ where: { portalId: portal.id }, data: { bookingSyncBaselineAt: now } });
    await this.alerts.deliverPending(portal, client);
    return { resources, bookings: report, baseline: !baseline };
  }

  /** Сверить известную бронь с Битрикс24. */
  private async compare(r: BookingRecord, a: Actual): Promise<{ changed: number; alerts: number }> {
    if (r.status === 'cancelled') {
      // Отменена у нас, но жива в Битрикс24: для брони приложения — расхождение.
      if (r.source === 'app' && (await this.discrepancy(r, ['not_cancelled'], a))) return { changed: 0, alerts: 1 };
      return { changed: 0, alerts: 0 };
    }
    const problems = diffState(stateOf(r), a);
    if (!problems.length) {
      await this.prisma.bookingRecord.update({ where: { id: r.id }, data: { syncedAt: new Date() } });
      return { changed: 0, alerts: 0 };
    }
    if (r.source === 'bitrix') {
      await this.journal.recordChanged(r, a, SYSTEM.bitrix, 'changed_in_bitrix', 'reconcile');
      return { changed: 1, alerts: 0 };
    }
    return { changed: 0, alerts: (await this.discrepancy(r, problems, a)) ? 1 : 0 };
  }

  /** Уведомление о расхождении + отметка в истории (только при первом обнаружении). */
  private async discrepancy(r: BookingRecord, problems: AlertProblem[], a: Actual | null): Promise<boolean> {
    const alert = await this.alerts.raise(r.portalId, {
      kind: 'discrepancy',
      problems,
      bookingId: r.bookingId,
      dealId: r.dealId,
      title: a?.title ?? r.title,
      expected: stateOf(r),
      actual: a ? stripTitle(a) : null,
    });
    if (!alert) return false;
    await this.journal.note(r, 'discrepancy_found', SYSTEM.reconcile, { alertId: alert.id, problems, actual: a }, 'reconcile');
    return true;
  }

  /** Зеркало ресурсов: новые и переименованные — обновить, пропавшие — в архив, вернувшиеся — из архива. */
  private async syncResources(portalId: string, client: Bitrix24RestClient, now: Date) {
    const list = await listResources(client);
    for (const r of list)
      await this.prisma.resource.upsert({
        where: { portalId_resourceId: { portalId, resourceId: r.id } },
        create: { portalId, resourceId: r.id, name: r.name.slice(0, 255), syncedAt: now },
        update: { name: r.name.slice(0, 255), archivedAt: null, syncedAt: now },
      });
    const { count } = await this.prisma.resource.updateMany({
      where: { portalId, archivedAt: null, resourceId: { notIn: list.map((r) => r.id) } },
      data: { archivedAt: now },
    });
    return { total: list.length, archived: count };
  }
}

const sec = (d: Date) => Math.floor(d.getTime() / 1000);

export function toActual(b: RawBooking, dealId: number | null): Actual {
  return {
    startsAt: new Date(Number(b.datePeriod?.from?.timestamp ?? 0) * 1000).toISOString(),
    endsAt: new Date(Number(b.datePeriod?.to?.timestamp ?? 0) * 1000).toISOString(),
    resourceIds: (b.resourceIds ?? []).map(Number).sort((x, y) => x - y),
    dealId,
    title: b.name ?? null,
  };
}

const stripTitle = ({ title: _t, ...s }: Actual): BookingStateDto => s;

function importInput(bookingId: number, a: Actual) {
  return {
    bookingId,
    kind: 'client' as const,
    dealId: a.dealId,
    resourceIds: a.resourceIds,
    startsAt: new Date(a.startsAt),
    endsAt: new Date(a.endsAt),
    title: a.title,
  };
}

function newBooking(bookingId: number, a: Actual) {
  return { kind: 'new_booking' as const, problems: [], bookingId, dealId: a.dealId, title: a.title, expected: null, actual: stripTitle(a) };
}

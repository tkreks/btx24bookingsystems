import { Injectable, Optional } from '@nestjs/common';
import {
  type ResourceStopDto,
  techWindowsFor,
  zonedDayRange,
  type CalendarBooking,
  type CalendarDay,
  type CalendarDeal,
  type CalendarRangeDto,
  type CalendarResource,
  type DealFieldConfig,
} from '@btx24/shared';
import type { BookingRecord } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { dealLinks, listBookings, listResources, type RawBooking } from '../bookings/bitrix-bookings.js';
import { toDto as stopDto } from '../bookings/resource-stops.service.js';
import { bookingFields, type DealFieldMeta } from './deal-fields.js';
import { CrmMirrorReader } from '../crm-mirror/crm-mirror.reader.js';


/** Что показывать: ресурсы группы, права и настройки направления. */
export interface DayScope {
  /** Ресурсы группы; null — все ресурсы портала (администратор без групп). */
  resourceIds?: number[] | null;
  /** false — только занятость: без названий, описаний, сделок и полей (роль «технолог»). */
  withDetails?: boolean;
  techWindowMinutes?: number;
  /** Поля сделки группы (`options.dealFields`). */
  dealFields?: DealFieldConfig[];
}

const BASE_DEAL_SELECT = ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID'];

/**
 * День календаря только на чтение (ADR 0003: брони хранит Битрикс24). Все вызовы — токеном
 * пользователя, поэтому сделки, к которым у него нет доступа, приходят как `deal: null`.
 */
@Injectable()
export class CalendarService {
  /** portalId → описание полей сделки (`crm.deal.fields`). Подписи и варианты меняются редко. */

  // Без БД (юнит-тесты дня) — без броней, пропавших в Битрикс24.
  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly mirror?: CrmMirrorReader,
  ) {}

  /**
   * Шкала за период — из базы приложения, без модуля бронирования Битрикс24: брони — журнал (сверка по
   * событиям `onBooking*` и раз в 10 минут), ресурсы — их копия, сделки — копия CRM с проверкой прав
   * сотрудника (нет в копии — `crm.deal.list` его токеном). Пропавшие в Битрикс24 — по уведомлению
   * «брони нет» (как в дашборде), без точечной проверки каждой брони.
   */
  async range(user: B24UserContext, from: string, to: string, scope: DayScope = {}): Promise<CalendarRangeDto> {
    const { resourceIds = null, withDetails = true, techWindowMinutes = 0 } = scope;
    const prisma = this.prisma!;
    const portalId = user.portal.id;
    const timezone = user.portal.timezone;
    const start = zonedDayRange(from, timezone).start;
    const end = zonedDayRange(to, timezone).end;
    const fetchFrom = new Date(start.getTime() - Math.max(0, techWindowMinutes) * 60_000);
    const allowed = resourceIds ? new Set(resourceIds) : null;
    const [resourceRows, records, settings] = await Promise.all([
      prisma.resource.findMany({ where: { portalId, archivedAt: null, ...(allowed ? { resourceId: { in: [...allowed] } } : {}) }, select: { resourceId: true, name: true } }),
      prisma.bookingRecord.findMany({ where: { portalId, status: 'active', startsAt: { lt: end }, endsAt: { gt: fetchFrom } }, orderBy: { startsAt: 'asc' }, take: RANGE_LIMIT }),
      prisma.portalSettings.findUnique({ where: { portalId }, select: { bookingSyncAt: true, syncHorizonDays: true } }),
    ]);
    const resources = resourceRows.map((r) => ({ id: r.resourceId, name: r.name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const mine = records.filter((r) => !allowed || (r.resourceIds as number[]).some((id) => allowed.has(Number(id))));
    const gone = mine.length
      ? await prisma.bookingAlert.findMany({
          where: { portalId, bookingId: { in: mine.map((r) => r.bookingId) }, kind: 'discrepancy', problem: { contains: 'missing' } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, bookingId: true, status: true },
        })
      : [];
    const missing = new Map<number, string | null>();
    for (const a of gone) if (!missing.has(a.bookingId)) missing.set(a.bookingId, a.status === 'resolved' ? null : a.id);
    // Есть в Битрикс24 — обычная бронь (без `missing`), пропавшая — с решением сотрудника.
    const live = mine.filter((r) => !missing.has(r.bookingId)).map((r): CalendarBooking => {
      const { missing: _none, ...b } = this.fromRecord(r, null, null);
      return b;
    });
    // Тех. окна — только по броням, которые есть в Битрикс24 (у пропавшей слот свободен).
    const techWindows = techWindowsFor(live, techWindowMinutes, allowed ?? undefined).filter((t) => overlaps(t, start, end));
    const shown = [...live, ...mine.filter((r) => missing.has(r.bookingId)).map((r) => this.fromRecord(r, missing.get(r.bookingId) ?? null, null))].filter((b) => overlaps(b, start, end));
    let bookings = shown;
    if (!withDetails) bookings = shown.map(occupancyOnly);
    else {
      const deals = await this.rangeDeals(user, [...new Set(shown.flatMap((b) => (b.dealId ? [b.dealId] : [])))]);
      bookings = shown.map((b) => ({ ...b, deal: (b.dealId && deals.get(b.dealId)) || null }));
    }
    const horizon = settings?.syncHorizonDays ? new Date(Date.now() + settings.syncHorizonDays * 86_400_000).toISOString().slice(0, 10) : null;
    return {
      from,
      to,
      timezone,
      resources,
      bookings: bookings.sort(byStart),
      techWindows,
      stops: await this.stops(user, start, end, resources),
      syncedAt: settings?.bookingSyncAt?.toISOString() ?? null,
      horizon,
    };
  }

  /** Сделки броней: копия CRM (права — токеном сотрудника, ≤ 5 минут), чего нет в копии — с портала. */
  private async rangeDeals(user: B24UserContext, ids: number[]): Promise<Map<number, CalendarDeal>> {
    const out = new Map<number, CalendarDeal>();
    if (!ids.length) return out;
    let missing = ids;
    if (this.mirror && (await this.mirror.ready(user.portal.id, 'deal'))) {
      const got = await this.mirror.dealsByIds(user, ids);
      for (const d of got.rows) out.set(Number(d.ID), dealDto(d as Record<string, string | null>));
      missing = got.missing;
    }
    if (missing.length) for (const [id, d] of await this.deals(user.client, missing)) out.set(id, d.dto);
    return out;
  }

  async day(user: B24UserContext, date: string, scope: DayScope = {}): Promise<CalendarDay> {
    const { resourceIds = null, withDetails = true, techWindowMinutes = 0, dealFields = [] } = scope;
    const timezone = user.portal.timezone;
    const { start, end } = zonedDayRange(date, timezone);
    const client = user.client;
    // Тех. окно брони, закончившейся до полуночи, может заходить в этот день — берём с запасом.
    const fetchFrom = toSec(start) - Math.max(0, techWindowMinutes) * 60;

    const allowed = resourceIds ? new Set(resourceIds) : null;
    const [allResources, allBookings] = await Promise.all([
      this.resources(client),
      this.bookings(client, fetchFrom, toSec(end)),
    ]);
    const resources = allowed ? allResources.filter((r) => allowed.has(r.id)) : allResources;
    const raw = allowed
      ? allBookings.filter((b) => (b.resourceIds ?? []).some((id) => allowed.has(Number(id))))
      : allBookings;
    const mapped = raw.map((b) => this.toBooking(b, null, null));
    const techWindows = techWindowsFor(mapped, techWindowMinutes, allowed ?? undefined).filter((t) =>
      overlaps(t, start, end),
    );
    const inDay = new Set(mapped.filter((b) => overlaps(b, start, end)).map((b) => b.id));
    const dayRaw = raw.filter((b) => inDay.has(Number(b.id)));
    // Брони приложения и по сделкам, удалённые в Битрикс24, — на месте до решения (тех. окна у них нет: слот свободен).
    const [gone, stops] = await Promise.all([this.missing(user, start, end, allowed, new Set(allBookings.map((b) => Number(b.id)))), this.stops(user, start, end, resources)]);
    if (!withDetails)
      return {
        date,
        timezone,
        resources,
        bookings: [...mapped.filter((b) => inDay.has(b.id)), ...gone.map((g) => this.fromRecord(g.record, g.alertId, null))]
          .map(occupancyOnly)
          .sort(byStart),
        techWindows,
        stops,
      };

    const shown = dealFields.filter((f) => f.showList || f.showView);
    const dealIds = await this.dealLinks(
      client,
      dayRaw.map((b) => b.id),
    );
    const [deals, meta] = await Promise.all([
      this.deals(
        client,
        [...new Set([...dealIds.values(), ...gone.flatMap((g) => (g.record.dealId ? [g.record.dealId] : []))])],
        shown.map((f) => f.name),
      ),
      shown.length ? this.dealFieldMeta(user) : Promise.resolve({}),
    ]);

    const bookings = dayRaw
      .map((b) => {
        const dealId = dealIds.get(b.id) ?? null;
        const deal = dealId ? deals.get(dealId) : undefined;
        const booking = this.toBooking(b, dealId, deal?.dto ?? null);
        if (deal) booking.fields = bookingFields(deal.raw, shown, meta, timezone);
        return booking;
      })
      .concat(
        gone.map(({ record, alertId }) => {
          const deal = record.dealId ? deals.get(record.dealId) : undefined;
          const booking = this.fromRecord(record, alertId, deal?.dto ?? null);
          if (deal) booking.fields = bookingFields(deal.raw, shown, meta, timezone);
          return booking;
        }),
      )
      .sort(byStart);

    return { date, timezone, resources, bookings, techWindows, stops };
  }

  /** Стопы ресурсов дня (ресурс закрыт для бронирования). */
  private async stops(user: B24UserContext, start: Date, end: Date, resources: CalendarResource[]): Promise<ResourceStopDto[]> {
    if (!this.prisma || !resources.length) return [];
    const rows = await this.prisma.resourceStop.findMany({
      where: { portalId: user.portal.id, liftedAt: null, startsAt: { lt: end }, endsAt: { gt: start }, resourceId: { in: resources.map((r) => r.id) } },
      orderBy: { startsAt: 'asc' },
    });
    return rows.map((r) => stopDto(r, user.portal.timezone));
  }

  private async dealFieldMeta(user: B24UserContext): Promise<Record<string, DealFieldMeta>> {
    const res = await user.client.call<Record<string, DealFieldMeta>>('crm.deal.fields');
    const meta = res.result ?? {};
    return meta;
  }

  /**
   * Активные брони дня — приложения и любые по сделке, — которых нет в Битрикс24 (не в списке дня —
   * проверяем точечно: бронь могли перенести на другой день, тогда она не «пропала»).
   */
  private async missing(
    user: B24UserContext,
    start: Date,
    end: Date,
    allowed: Set<number> | null,
    listed: Set<number>,
  ): Promise<{ record: BookingRecord; alertId: string | null }[]> {
    if (!this.prisma) return [];
    const records = (
      await this.prisma.bookingRecord.findMany({
        where: { portalId: user.portal.id, status: 'active', startsAt: { lt: end }, endsAt: { gt: start }, OR: [{ source: 'app' }, { dealId: { not: null } }] },
        take: 200,
      })
    ).filter((r) => !listed.has(r.bookingId) && (!allowed || (r.resourceIds as number[]).some((id) => allowed.has(Number(id)))));
    if (!records.length) return [];
    const res = await user.client.batch(
      Object.fromEntries(records.map((r) => [`b${r.bookingId}`, { method: 'booking.v1.booking.get', params: { id: r.bookingId } }])),
    );
    // Только достоверно удалённые («Booking not found»); сбой проверки — бронь не показываем как пропавшую.
    const gone = records.filter((r) => {
      const err = res.errors[`b${r.bookingId}`] as { error?: string; error_description?: string } | undefined;
      return !!err && (String(err.error) === '1021' || /not found/i.test(`${err.error_description ?? ''} ${err.error ?? ''}`));
    });
    if (!gone.length) return [];
    const alerts = await this.prisma.bookingAlert.findMany({
      where: { portalId: user.portal.id, bookingId: { in: gone.map((r) => r.bookingId) }, kind: 'discrepancy', problem: { contains: 'missing' }, status: { not: 'resolved' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, bookingId: true },
    });
    return gone.map((record) => ({ record, alertId: alerts.find((a) => a.bookingId === record.bookingId)?.id ?? null }));
  }

  private fromRecord(r: BookingRecord, alertId: string | null, deal: CalendarDeal | null): CalendarBooking {
    return {
      id: r.bookingId,
      name: r.title ?? '',
      description: null,
      resourceIds: (r.resourceIds as number[]).map(Number),
      start: r.startsAt.toISOString(),
      end: r.endsAt.toISOString(),
      dealId: r.dealId,
      deal,
      fields: [],
      missing: { alertId },
    };
  }

  private toBooking(b: RawBooking, dealId: number | null, deal: CalendarDeal | null): CalendarBooking {
    return {
      id: Number(b.id),
      name: b.name ?? '',
      description: b.description ?? null,
      resourceIds: (b.resourceIds ?? []).map(Number),
      start: new Date(Number(b.datePeriod?.from?.timestamp ?? 0) * 1000).toISOString(),
      end: new Date(Number(b.datePeriod?.to?.timestamp ?? 0) * 1000).toISOString(),
      dealId,
      deal,
      fields: [],
    };
  }

  private async resources(client: Bitrix24RestClient): Promise<CalendarResource[]> {
    return (await listResources(client)).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  /** Брони, пересекающие [from, to), — общий читатель модуля бронирования. */
  bookings(client: Bitrix24RestClient, from: number, to: number): Promise<RawBooking[]> {
    return listBookings(client, from, to);
  }

  private dealLinks(client: Bitrix24RestClient, bookingIds: number[]): Promise<Map<number, number>> {
    return dealLinks(client, bookingIds);
  }

  private async deals(
    client: Bitrix24RestClient,
    ids: number[],
    extraFields: string[] = [],
  ): Promise<Map<number, { dto: CalendarDeal; raw: Record<string, unknown> }>> {
    const out = new Map<number, { dto: CalendarDeal; raw: Record<string, unknown> }>();
    if (!ids.length) return out;
    const rows = await client.listAll<Record<string, string | null>>('crm.deal.list', {
      filter: { '@ID': ids },
      select: [...new Set([...BASE_DEAL_SELECT, ...extraFields])],
    });
    for (const d of rows) out.set(Number(d.ID), { raw: d, dto: dealDto(d) });
    return out;
  }
}

/** Шкала: брони периода — не больше (30 месяцев одной группы с запасом). */
const RANGE_LIMIT = 20_000;
const dealDto = (d: Record<string, string | null>): CalendarDeal => ({
  id: Number(d.ID),
  title: d.TITLE ?? '',
  categoryId: d.CATEGORY_ID === null || d.CATEGORY_ID === undefined ? null : Number(d.CATEGORY_ID),
  stageId: d.STAGE_ID ?? null,
  opportunity: d.OPPORTUNITY === null || d.OPPORTUNITY === undefined || d.OPPORTUNITY === '' ? null : Number(d.OPPORTUNITY),
  currency: d.CURRENCY_ID ?? null,
});
const toSec = (d: Date) => Math.floor(d.getTime() / 1000);
const byStart = (a: CalendarBooking, b: CalendarBooking) => a.start.localeCompare(b.start) || a.id - b.id;
/** Без права booking.details: видна только занятость ресурса. */
const overlaps = (x: { start: string; end: string }, start: Date, end: Date) =>
  Date.parse(x.start) < end.getTime() && Date.parse(x.end) > start.getTime();
const occupancyOnly = (b: CalendarBooking): CalendarBooking => ({
  ...b,
  name: 'Занято',
  description: null,
  dealId: null,
  deal: null,
  fields: [],
});

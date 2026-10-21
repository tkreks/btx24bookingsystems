import { Injectable } from '@nestjs/common';
import {
  techWindowsFor,
  zonedDayRange,
  type CalendarBooking,
  type CalendarDay,
  type CalendarDeal,
  type CalendarResource,
  type DealFieldConfig,
} from '@btx24/shared';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { dealLinks, listBookings, listResources, type RawBooking } from '../bookings/bitrix-bookings.js';
import { bookingFields, type DealFieldMeta } from './deal-fields.js';


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

const FIELDS_TTL_MS = 10 * 60_000;
const BASE_DEAL_SELECT = ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID'];

/**
 * День календаря только на чтение (ADR 0003: брони хранит Битрикс24). Все вызовы — токеном
 * пользователя, поэтому сделки, к которым у него нет доступа, приходят как `deal: null`.
 */
@Injectable()
export class CalendarService {
  /** portalId → описание полей сделки (`crm.deal.fields`). Подписи и варианты меняются редко. */
  private readonly fieldMeta = new Map<string, { meta: Record<string, DealFieldMeta>; expiresAt: number }>();

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
    if (!withDetails)
      return {
        date,
        timezone,
        resources,
        bookings: mapped
          .filter((b) => inDay.has(b.id))
          .map(occupancyOnly)
          .sort(byStart),
        techWindows,
      };

    const shown = dealFields.filter((f) => f.showList || f.showView);
    const dealIds = await this.dealLinks(
      client,
      dayRaw.map((b) => b.id),
    );
    const [deals, meta] = await Promise.all([
      this.deals(
        client,
        [...new Set(dealIds.values())],
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
      .sort(byStart);

    return { date, timezone, resources, bookings, techWindows };
  }

  private async dealFieldMeta(user: B24UserContext): Promise<Record<string, DealFieldMeta>> {
    const cached = this.fieldMeta.get(user.portal.id);
    if (cached && cached.expiresAt > Date.now()) return cached.meta;
    const res = await user.client.call<Record<string, DealFieldMeta>>('crm.deal.fields');
    const meta = res.result ?? {};
    this.fieldMeta.set(user.portal.id, { meta, expiresAt: Date.now() + FIELDS_TTL_MS });
    return meta;
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
    for (const d of rows) {
      out.set(Number(d.ID), {
        raw: d,
        dto: {
          id: Number(d.ID),
          title: d.TITLE ?? '',
          categoryId: d.CATEGORY_ID === null || d.CATEGORY_ID === undefined ? null : Number(d.CATEGORY_ID),
          stageId: d.STAGE_ID ?? null,
          opportunity: d.OPPORTUNITY === null || d.OPPORTUNITY === undefined ? null : Number(d.OPPORTUNITY),
          currency: d.CURRENCY_ID ?? null,
        },
      });
    }
    return out;
  }
}

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

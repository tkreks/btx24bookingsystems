import { Injectable } from '@nestjs/common';
import { zonedDayRange, type CalendarBooking, type CalendarDay, type CalendarDeal, type CalendarResource } from '@btx24/shared';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';

/** booking.v1.booking.list отдаёт не больше 50 записей и не умеет страницы. */
const LIST_LIMIT = 50;
/** Мельче не делим: столько броней на одном отрезке — уже аномалия, отдаём что есть. */
const MIN_SPLIT_SECONDS = 15 * 60;

interface RawBooking {
  id: number;
  name?: string | null;
  description?: string | null;
  resourceIds?: number[];
  datePeriod?: { from?: { timestamp?: number }; to?: { timestamp?: number } };
}

/**
 * День календаря только на чтение (ADR 0003: брони хранит Битрикс24). Все вызовы — токеном
 * пользователя, поэтому сделки, к которым у него нет доступа, приходят как `deal: null`.
 */
@Injectable()
export class CalendarService {
  async day(user: B24UserContext, date: string): Promise<CalendarDay> {
    const timezone = user.portal.timezone;
    const { start, end } = zonedDayRange(date, timezone);
    const client = user.client;

    const [resources, raw] = await Promise.all([this.resources(client), this.bookings(client, toSec(start), toSec(end))]);
    const dealIds = await this.dealLinks(client, raw.map((b) => b.id));
    const deals = await this.deals(client, [...new Set(dealIds.values())]);

    const bookings: CalendarBooking[] = raw
      .map((b) => {
        const dealId = dealIds.get(b.id) ?? null;
        return {
          id: Number(b.id),
          name: b.name ?? '',
          description: b.description ?? null,
          resourceIds: (b.resourceIds ?? []).map(Number),
          start: new Date(Number(b.datePeriod?.from?.timestamp ?? 0) * 1000).toISOString(),
          end: new Date(Number(b.datePeriod?.to?.timestamp ?? 0) * 1000).toISOString(),
          dealId,
          deal: dealId ? (deals.get(dealId) ?? null) : null,
        };
      })
      .sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id);

    return { date, timezone, resources, bookings };
  }

  private async resources(client: Bitrix24RestClient): Promise<CalendarResource[]> {
    const list = await client.listAll<{ id: number; name?: string }>('booking.v1.resource.list', {}, {
      pick: (r) => ((r as { resource?: unknown[] })?.resource ?? []) as { id: number; name?: string }[],
    });
    return list.map((r) => ({ id: Number(r.id), name: r.name || `Ресурс ${r.id}` })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  /**
   * Брони, пересекающие [from, to). Если пришло ровно 50 — список мог обрезаться: делим отрезок
   * пополам и собираем заново (вместо 24 почасовых запросов прототипа).
   */
  async bookings(client: Bitrix24RestClient, from: number, to: number): Promise<RawBooking[]> {
    const res = await client.call<{ booking?: RawBooking[] }>('booking.v1.booking.list', { filter: { within: { dateFrom: from, dateTo: to } } });
    const list = res.result?.booking ?? [];
    if (list.length < LIST_LIMIT || to - from <= MIN_SPLIT_SECONDS) return list;
    const mid = from + Math.floor((to - from) / 2);
    const [left, right] = await Promise.all([this.bookings(client, from, mid), this.bookings(client, mid, to)]);
    const byId = new Map<number, RawBooking>();
    for (const b of [...left, ...right]) byId.set(Number(b.id), b);
    return [...byId.values()];
  }

  /** bookingId → dealId по связям externalData (crm / DEAL). */
  private async dealLinks(client: Bitrix24RestClient, bookingIds: number[]): Promise<Map<number, number>> {
    const links = new Map<number, number>();
    if (!bookingIds.length) return links;
    const commands = Object.fromEntries(bookingIds.map((id) => [`b${id}`, { method: 'booking.v1.booking.externalData.list', params: { bookingId: id } }]));
    const res = await client.batch(commands);
    for (const id of bookingIds) {
      const raw = res.result[`b${id}`] as { externalData?: { moduleId?: string; entityTypeId?: string; value?: string }[] } | undefined;
      const deal = (raw?.externalData ?? []).find((x) => x.moduleId === 'crm' && String(x.entityTypeId).toUpperCase() === 'DEAL');
      if (deal?.value && /^\d+$/.test(deal.value)) links.set(id, Number(deal.value));
    }
    return links;
  }

  private async deals(client: Bitrix24RestClient, ids: number[]): Promise<Map<number, CalendarDeal>> {
    const out = new Map<number, CalendarDeal>();
    if (!ids.length) return out;
    const rows = await client.listAll<Record<string, string | null>>('crm.deal.list', {
      filter: { '@ID': ids },
      select: ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID'],
    });
    for (const d of rows) {
      out.set(Number(d.ID), {
        id: Number(d.ID),
        title: d.TITLE ?? '',
        categoryId: d.CATEGORY_ID === null || d.CATEGORY_ID === undefined ? null : Number(d.CATEGORY_ID),
        stageId: d.STAGE_ID ?? null,
        opportunity: d.OPPORTUNITY === null || d.OPPORTUNITY === undefined ? null : Number(d.OPPORTUNITY),
        currency: d.CURRENCY_ID ?? null,
      });
    }
    return out;
  }
}

const toSec = (d: Date) => Math.floor(d.getTime() / 1000);

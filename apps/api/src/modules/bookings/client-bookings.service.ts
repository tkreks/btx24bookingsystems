import { Injectable } from '@nestjs/common';
import type { ClientBookingDto, ClientBookingsDto } from '@btx24/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { dealLinks, type RawBooking } from './bitrix-bookings.js';
import { DealFieldMapService } from './deal-field-map.service.js';
import { happened, outcomeSelect } from './deal-outcome.js';

type Deal = Record<string, string | null>;
const RECENT = 5;
const MAX_DEALS = 200;

/**
 * Брони клиента (контакт чата) или сделки — правами пользователя: модуль бронирования по клиенту
 * (`booking.v1.booking.list`, фильтр `client`) + сделки клиента (поля «ID бронирования» и даты брони
 * из системных полей — так видны и брони, у которых клиент не указан, и уже удалённые).
 */
@Injectable()
export class ClientBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldMap: DealFieldMapService,
  ) {}

  async forContact(user: B24UserContext, contactId: number | null, extraDealIds: number[] = [], now = new Date()): Promise<ClientBookingsDto> {
    const map = await this.fieldMap.get(user.portal.id);
    const outcome = await this.fieldMap.outcome(user.portal.id, user.client);
    const ufSelect = [...new Set([map.bookingId, map.bookingStart, map.bookingEnd, ...outcomeSelect(outcome)].filter((x): x is string => !!x))];
    const select = ['ID', 'TITLE', 'STAGE_SEMANTIC_ID', 'CATEGORY_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'CLOSEDATE', 'DATE_CREATE', ...ufSelect];
    const [byClient, contactDeals, extraDeals, contact] = await Promise.all([
      contactId
        ? user.client
            .call<{ booking?: RawBooking[] }>('booking.v1.booking.list', {
              filter: { client: { entities: [{ code: 'CONTACT', module: 'crm', id: String(contactId) }] } },
              order: { dateFrom: 'DESC' },
            })
            .then((r) => r.result?.booking ?? [])
        : Promise.resolve([] as RawBooking[]),
      contactId
        ? user.client.listAll<Deal>('crm.deal.list', { filter: { CONTACT_ID: contactId }, select, order: { ID: 'DESC' } }, { max: MAX_DEALS })
        : Promise.resolve([] as Deal[]),
      extraDealIds.length
        ? user.client.listAll<Deal>('crm.deal.list', { filter: { '@ID': extraDealIds }, select })
        : Promise.resolve([] as Deal[]),
      contactId
        ? user.client
            .call<{ NAME?: string | null; SECOND_NAME?: string | null; LAST_NAME?: string | null }>('crm.contact.get', { id: contactId })
            .then((r) => [r.result?.NAME, r.result?.SECOND_NAME, r.result?.LAST_NAME].filter((x) => x && x.trim()).join(' ') || null)
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    const deals = new Map<number, Deal>([...contactDeals, ...extraDeals].map((d) => [Number(d.ID), d]));
    const links = await dealLinks(user.client, byClient.map((b) => Number(b.id)));

    // Брони из полей сделок, которых нет среди броней клиента, — подтянуть из модуля (или по датам полей).
    const known = new Set(byClient.map((b) => Number(b.id)));
    const fromDeals = [...deals.values()]
      .map((d) => ({ d, id: map.bookingId ? Number(d[map.bookingId]) : NaN }))
      .filter((x) => Number.isInteger(x.id) && x.id > 0 && !known.has(x.id));
    const fetched = fromDeals.length
      ? await user.client.batch(
          Object.fromEntries(fromDeals.map((x) => [`b${x.id}`, { method: 'booking.v1.booking.get', params: { id: x.id } }])),
        )
      : { result: {} as Record<string, unknown> };

    const resources = new Map(
      (await this.prisma.resource.findMany({ where: { portalId: user.portal.id } })).map((r) => [r.resourceId, r.name]),
    );
    const item = (start: number, end: number, bookingId: number | null, resourceIds: number[], dealId: number | null): ClientBookingDto => {
      const d = dealId ? deals.get(dealId) : undefined;
      return {
        bookingId,
        dealId,
        deal: d
          ? {
              title: d.TITLE ?? `Сделка #${dealId}`,
              stageSemantic: (d.STAGE_SEMANTIC_ID as 'P' | 'S' | 'F' | null) ?? null,
              opportunity: d.OPPORTUNITY === null || d.OPPORTUNITY === undefined ? null : Number(d.OPPORTUNITY),
            }
          : null,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        resources: resourceIds.map((id) => resources.get(id) ?? `Ресурс ${id}`),
        resourceIds,
        when: end <= now.getTime() ? 'past' : start <= now.getTime() ? 'now' : 'future',
      };
    };
    const sec = (b: RawBooking, k: 'from' | 'to') => Number(b.datePeriod?.[k]?.timestamp ?? 0) * 1000;
    const items: ClientBookingDto[] = byClient.map((b) =>
      item(sec(b, 'from'), sec(b, 'to'), Number(b.id), (b.resourceIds ?? []).map(Number), links.get(Number(b.id)) ?? null),
    );
    // Удалённая в модуле бронь: ресурсы — из журнала приложения, если бронь создавали через него
    // (встройка по ним открывает группу ресурса и объясняет, что брони уже нет).
    const missing = fromDeals.filter((x) => !(fetched.result[`b${x.id}`] as { booking?: RawBooking } | undefined)?.booking).map((x) => x.id);
    const journal = new Map(
      missing.length
        ? (
            await this.prisma.bookingRecord.findMany({
              where: { portalId: user.portal.id, bookingId: { in: missing } },
              select: { bookingId: true, resourceIds: true },
            })
          ).map((r) => [r.bookingId, Array.isArray(r.resourceIds) ? r.resourceIds.map(Number) : []])
        : [],
    );
    for (const { d, id } of fromDeals) {
      const b = (fetched.result[`b${id}`] as { booking?: RawBooking } | undefined)?.booking;
      if (b) items.push(item(sec(b, 'from'), sec(b, 'to'), id, (b.resourceIds ?? []).map(Number), Number(d.ID)));
      else {
        const s = map.bookingStart ? Date.parse(String(d[map.bookingStart] ?? '')) : NaN;
        const e = map.bookingEnd ? Date.parse(String(d[map.bookingEnd] ?? '')) : NaN;
        if (Number.isFinite(s) && Number.isFinite(e)) items.push(item(s, e, null, journal.get(id) ?? [], Number(d.ID)));
      }
    }
    // Брони сделок из журнала, которых нет выше, — прежде всего удалённые в Битрикс24 и ждущие решения:
    // встройка и переход из чата открывают календарь на их дне (там — «оставить или удалить»).
    const listed = new Set([...items.map((i) => i.bookingId), ...missing]);
    const pending = deals.size
      ? await this.prisma.bookingRecord.findMany({ where: { portalId: user.portal.id, status: 'active', dealId: { in: [...deals.keys()] } } })
      : [];
    for (const r of pending)
      if (!listed.has(r.bookingId))
        items.push(item(r.startsAt.getTime(), r.endsAt.getTime(), r.bookingId, Array.isArray(r.resourceIds) ? r.resourceIds.map(Number) : [], r.dealId));
    const upcoming = items.filter((i) => i.when !== 'past').sort((a, b) => a.start.localeCompare(b.start));
    const past = items.filter((i) => i.when === 'past').sort((a, b) => b.start.localeCompare(a.start));
    // Состоявшиеся сделки клиента (не проиграны, бронь прошла; без брони — выигранные; оплаченные
    // сертификаты): сколько и средний чек.
    const won = contactDeals.filter((d) => happened(d, outcome, now.getTime()));
    const sums = won.map((d) => Number(d.OPPORTUNITY)).filter((x) => Number.isFinite(x) && x > 0);
    return {
      contactId,
      contact: contactId ? { id: contactId, name: contact } : null,
      won: {
        count: won.length,
        avgCheck: sums.length ? Math.round(sums.reduce((a, b) => a + b, 0) / sums.length) : null,
        currency: won.find((d) => d.CURRENCY_ID)?.CURRENCY_ID ?? null,
      },
      past: past.length,
      upcoming,
      // Последние прошлые + все прошлые брони запрошенных сделок (встройке нужна дата именно её брони).
      recent: past.filter((b, i) => i < RECENT || (b.dealId !== null && extraDealIds.includes(b.dealId))),
      openDeals: [...deals.values()]
        .filter((d) => d.STAGE_SEMANTIC_ID === 'P')
        .map((d) => {
          const b = upcoming.find((x) => x.dealId === Number(d.ID));
          return {
            id: Number(d.ID),
            title: d.TITLE ?? `Сделка #${d.ID}`,
            categoryId: d.CATEGORY_ID === null ? null : Number(d.CATEGORY_ID),
            opportunity: d.OPPORTUNITY === null || d.OPPORTUNITY === undefined ? null : Number(d.OPPORTUNITY),
            createdAt: d.DATE_CREATE ? new Date(d.DATE_CREATE).toISOString() : null,
            booking: b ? { start: b.start, end: b.end, resources: b.resources } : null,
          };
        }),
    };
  }

  /** Брони клиента из чата открытой линии (контакт и сделка чата). */
  async forChat(user: B24UserContext, chatId: number): Promise<ClientBookingsDto> {
    const d = (await user.client.call<{ entity_data_2?: string }>('imopenlines.dialog.get', { CHAT_ID: chatId })).result;
    const parts = String(d?.entity_data_2 ?? '').split('|');
    const get = (t: string) => {
      const i = parts.indexOf(t);
      const n = i >= 0 ? Number(parts[i + 1]) : 0;
      return n > 0 ? n : null;
    };
    const dealId = get('DEAL');
    return this.forContact(user, get('CONTACT'), dealId ? [dealId] : []);
  }

  /** Брони сделки и её клиента (встройка в карточку сделки). */
  async forDeal(user: B24UserContext, dealId: number): Promise<ClientBookingsDto> {
    const d = (await user.client.call<{ CONTACT_ID?: string | null }>('crm.deal.get', { id: dealId })).result;
    const contactId = Number(d?.CONTACT_ID) > 0 ? Number(d!.CONTACT_ID) : null;
    return this.forContact(user, contactId, [dealId]);
  }
}

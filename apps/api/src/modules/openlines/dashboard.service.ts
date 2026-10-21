import { BadRequestException, Injectable } from '@nestjs/common';
import {
  DASHBOARD_MAX_DAYS,
  isIsoDate,
  todayIn,
  zonedDayRange,
  type DashboardBookingRow,
  type DashboardDto,
} from '@btx24/shared';
import type { BookingRecord } from '../../generated/prisma/client.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { BookingJournalService } from '../bookings/booking-journal.service.js';
import { ChatsService } from './chats.service.js';

/** CRM: OWNER_TYPE_ID дела → тип элемента. */
const OWNER_TYPES: Record<string, keyof NonNullable<DashboardDto['contacts']>> = {
  '1': 'leads',
  '2': 'deals',
  '3': 'contacts',
  '4': 'companies',
};
/** Сколько сессий за период разбираем для «с кем общались» (больше — аномалия для одного менеджера). */
const MAX_SESSIONS = 2000;
const DAY_MS = 86_400_000;

type DealInfo = NonNullable<DashboardBookingRow['deal']>;

/** Дашборд менеджера: только его собственные показатели, правами его токена. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly chats: ChatsService,
    private readonly journal: BookingJournalService,
  ) {}

  async get(user: B24UserContext, query: { from?: unknown; to?: unknown }, openlines: boolean): Promise<DashboardDto> {
    const { from, to, start, end } = parsePeriod(user.portal.timezone, query);
    const [bookings, chats] = await Promise.all([
      this.bookings(user, start, end),
      openlines
        ? Promise.all([this.chats.list(user, { scope: 'mine' }), this.unreadMessages(user), this.contacts(user, start, end)])
        : null,
    ]);
    if (!chats) return { from, to, chats: null, contacts: null, bookings };
    const [mine, unread, contacts] = chats;
    return {
      from,
      to,
      chats: { waitingReply: mine.items.filter((c) => c.waitingReply).length, unreadMessages: unread },
      contacts,
      bookings,
    };
  }

  /** Свои брони из журнала: сделки с бронью и отменённые — с названиями сделок и ресурсов (токеном пользователя). */
  private async bookings(user: B24UserContext, start: Date, end: Date): Promise<DashboardDto['bookings']> {
    const j = await this.journal.forManager(user.portal.id, user.userId, start, end);
    const records = [...j.createdClient, ...j.cancelled];
    const [deals, resources] = records.length
      ? await Promise.all([
          this.deals(user, [...new Set(records.flatMap((r) => (r.dealId ? [r.dealId] : [])))]),
          this.resourceNames(user),
        ])
      : [new Map<number, DealInfo>(), new Map<number, string>()];
    const row = (r: BookingRecord): DashboardBookingRow => ({
      bookingId: r.bookingId,
      dealId: r.dealId,
      deal: (r.dealId && deals.get(r.dealId)) || null,
      resources: (r.resourceIds as number[]).map((id) => resources.get(Number(id)) ?? `Ресурс ${id}`),
      start: r.startsAt.toISOString(),
      end: r.endsAt.toISOString(),
      status: r.status,
      cancelReason: r.cancelReason,
      createdAt: r.createdAt.toISOString(),
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
    });
    return {
      created: j.created,
      cancelled: j.cancelled.length,
      deals: j.createdClient.map(row),
      cancelledList: j.cancelled.map(row),
    };
  }

  /** Сделки, видимые пользователю в CRM; недоступные в ответ не попадают. */
  private async deals(user: B24UserContext, ids: number[]): Promise<Map<number, DealInfo>> {
    const out = new Map<number, DealInfo>();
    if (!ids.length) return out;
    const rows = await user.client.listAll<Record<string, string | null>>('crm.deal.list', {
      filter: { '@ID': ids },
      select: ['ID', 'TITLE', 'OPPORTUNITY', 'CURRENCY_ID'],
    });
    for (const d of rows)
      out.set(Number(d.ID), {
        title: d.TITLE ?? '',
        opportunity: d.OPPORTUNITY === null || d.OPPORTUNITY === undefined ? null : Number(d.OPPORTUNITY),
        currency: d.CURRENCY_ID ?? null,
      });
    return out;
  }

  private async resourceNames(user: B24UserContext): Promise<Map<number, string>> {
    const list = await user.client.listAll<{ id: number; name?: string }>(
      'booking.v1.resource.list',
      {},
      { pick: (r) => ((r as { resource?: unknown[] })?.resource ?? []) as { id: number; name?: string }[] },
    );
    return new Map(list.map((r) => [Number(r.id), r.name || `Ресурс ${r.id}`]));
  }

  /** Непрочитанные сообщения в своих диалогах открытых линий (счётчики мессенджера). */
  private async unreadMessages(user: B24UserContext): Promise<number> {
    const res = await user.client.call<{ items?: { counter?: number }[] }>('im.recent.list', {
      ONLY_OPENLINES: 'Y',
      SKIP_DIALOG: 'Y',
      SKIP_CHAT: 'Y',
      LIMIT: 200,
    });
    return (res.result?.items ?? []).reduce((sum, i) => sum + Math.max(0, Number(i.counter ?? 0)), 0);
  }

  /** Уникальные лиды, контакты, сделки и компании из своих сессий открытых линий за период. */
  private async contacts(user: B24UserContext, start: Date, end: Date): Promise<NonNullable<DashboardDto['contacts']>> {
    const rows = await user.client.listAll<{ OWNER_TYPE_ID: string; OWNER_ID: string }>(
      'crm.activity.list',
      {
        filter: {
          PROVIDER_ID: 'IMOPENLINES_SESSION',
          RESPONSIBLE_ID: user.userId,
          '>=LAST_UPDATED': start.toISOString(),
          '<LAST_UPDATED': end.toISOString(),
        },
        select: ['ID', 'OWNER_TYPE_ID', 'OWNER_ID'],
      },
      { max: MAX_SESSIONS },
    );
    const out = { leads: 0, contacts: 0, deals: 0, companies: 0 };
    const seen = new Set<string>();
    for (const r of rows) {
      const key = OWNER_TYPES[r.OWNER_TYPE_ID];
      if (!key || seen.has(`${r.OWNER_TYPE_ID}:${r.OWNER_ID}`)) continue;
      seen.add(`${r.OWNER_TYPE_ID}:${r.OWNER_ID}`);
      out[key]++;
    }
    return out;
  }
}

/**
 * Период дашборда: дни `[from, to]` включительно в поясе портала (по умолчанию — сегодня) →
 * полуоткрытый интервал `[start, end)` в UTC.
 */
export function parsePeriod(
  timeZone: string,
  query: { from?: unknown; to?: unknown },
  now = new Date(),
): { from: string; to: string; start: Date; end: Date } {
  const today = todayIn(timeZone, now);
  const from = query.from ?? today;
  const to = query.to ?? from;
  const bad = (message: string) => new BadRequestException({ code: 'INVALID_PERIOD', message });
  if (typeof from !== 'string' || typeof to !== 'string' || !isIsoDate(from) || !isIsoDate(to))
    throw bad('from, to: даты YYYY-MM-DD');
  if (to < from) throw bad('Начало периода позже конца');
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > DASHBOARD_MAX_DAYS)
    throw bad(`Период — не длиннее ${DASHBOARD_MAX_DAYS} дней`);
  return { from, to, start: zonedDayRange(from, timeZone).start, end: zonedDayRange(to, timeZone).end };
}

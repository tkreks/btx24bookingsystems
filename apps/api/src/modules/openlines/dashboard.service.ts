import { BadRequestException, Injectable } from '@nestjs/common';
import { DASHBOARD_PERIODS, todayIn, zonedDayRange, type DashboardDto, type DashboardPeriod } from '@btx24/shared';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { ChatsService } from './chats.service.js';

/** CRM: OWNER_TYPE_ID дела → тип элемента. */
const OWNER_TYPES: Record<string, keyof NonNullable<DashboardDto['contacts']>> = {
  '1': 'leads',
  '2': 'deals',
  '3': 'contacts',
  '4': 'companies',
};
const PERIOD_DAYS: Record<DashboardPeriod, number> = { today: 1, '7d': 7, '30d': 30 };
/** Сколько сессий за период разбираем для «с кем общались» (больше — аномалия для одного менеджера). */
const MAX_SESSIONS = 2000;

/** Дашборд менеджера: только его собственные показатели, правами его токена. */
@Injectable()
export class DashboardService {
  constructor(private readonly chats: ChatsService) {}

  async get(user: B24UserContext, rawPeriod: unknown, openlines: boolean): Promise<DashboardDto> {
    const period = (rawPeriod ?? 'today') as DashboardPeriod;
    if (!DASHBOARD_PERIODS.includes(period))
      throw new BadRequestException({ code: 'INVALID_PERIOD', message: 'period: today, 7d или 30d' });
    const from = periodStart(user.portal.timezone, PERIOD_DAYS[period]);
    const bookings = { created: null, cancelled: null };
    if (!openlines) return { period, from: from.toISOString(), chats: null, contacts: null, bookings };

    const [mine, unread, contacts] = await Promise.all([
      this.chats.list(user, { scope: 'mine' }),
      this.unreadMessages(user),
      this.contacts(user, from),
    ]);
    return {
      period,
      from: from.toISOString(),
      chats: { waitingReply: mine.items.filter((c) => c.waitingReply).length, unreadMessages: unread },
      contacts,
      bookings,
    };
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
  private async contacts(user: B24UserContext, from: Date): Promise<NonNullable<DashboardDto['contacts']>> {
    const rows = await user.client.listAll<{ OWNER_TYPE_ID: string; OWNER_ID: string }>(
      'crm.activity.list',
      {
        filter: {
          PROVIDER_ID: 'IMOPENLINES_SESSION',
          RESPONSIBLE_ID: user.userId,
          '>=LAST_UPDATED': from.toISOString(),
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

/** Начало периода: полночь (по поясу портала) `days - 1` дней назад. */
export function periodStart(timeZone: string, days: number, now = new Date()): Date {
  const today = todayIn(timeZone, now);
  const [y, m, d] = today.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, d - (days - 1))).toISOString().slice(0, 10);
  return zonedDayRange(first, timeZone).start;
}

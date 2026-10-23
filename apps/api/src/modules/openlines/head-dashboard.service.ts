import { Injectable } from '@nestjs/common';
import { previousPeriod, todayIn, zonedDayRange, type HeadDashboardDto, type HeadDayDto, type HeadTotalsDto } from '@btx24/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { callClients, isMissed, type CallActivity, type CallClient } from './call-stats.js';
import { DashboardService, parsePeriod } from './dashboard.service.js';

const CACHE_MS = 60_000;
const digits10 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10);

/**
 * Дашборд руководителя (решение владельца 2026-10-23): по дням периода и итого — новые сделки (воронки
 * всех групп), брони по ним, повторные клиенты; звонки — все, пропущенные, упущенные (не перезвонили и
 * не написали клиенту в чат после пропущенного). Итоги — и за предыдущий период той же длины (сравнение
 * на плитках). Данные CRM — правами руководителя.
 */
@Injectable()
export class HeadDashboardService {
  private readonly cache = new Map<string, { expiresAt: number; value: Promise<HeadDashboardDto> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly dashboard: DashboardService,
  ) {}

  get(user: B24UserContext, query: { from?: unknown; to?: unknown }): Promise<HeadDashboardDto> {
    const key = JSON.stringify([user.portal.id, user.userId, query.from, query.to]);
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    if (this.cache.size > 200) for (const [k, v] of this.cache) if (v.expiresAt <= now) this.cache.delete(k);
    const value = this.compute(user, query);
    this.cache.set(key, { expiresAt: now + CACHE_MS, value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private async compute(user: B24UserContext, query: { from?: unknown; to?: unknown }): Promise<HeadDashboardDto> {
    const tz = user.portal.timezone;
    const { from, to, start, end } = parsePeriod(tz, query);
    // Сравнение — с предыдущим периодом той же длины (сегодня — со вчера).
    const prev = previousPeriod(from, to);
    const prevStart = zonedDayRange(prev.from, tz).start;
    const notes: string[] = [];
    const groups = await this.prisma.workGroup.findMany({ where: { portalId: user.portal.id, archivedAt: null }, select: { dealCategoryId: true } });
    const funnels = [...new Set(groups.map((g) => g.dealCategoryId).filter((x): x is number => x !== null))];

    const [deals, prevDeals, calls] = await Promise.all([
      this.dashboard.newDeals(user, start, end, 'all', funnels),
      this.dashboard.newDeals(user, prevStart, start, 'all', funnels),
      // Звонки — с начала прошлого периода по сейчас: перезвон мог быть позже.
      this.dashboard.fetchCalls(user, prevStart).then(
        (r) => r,
        (e: unknown) => {
          if (e instanceof Bitrix24Error) return null;
          throw e;
        },
      ),
    ]);
    if (deals?.truncated || prevDeals?.truncated) notes.push('Новых сделок очень много — посчитаны не все.');
    if (calls?.truncated) notes.push('Звонков очень много — посчитаны не все.');

    const allDeals = [...(deals?.items ?? []), ...(prevDeals?.items ?? [])];
    const dealIds = allDeals.map((d) => d.id);
    const records = dealIds.length
      ? await this.prisma.bookingRecord.findMany({ where: { portalId: user.portal.id, dealId: { in: dealIds } }, select: { dealId: true } })
      : [];
    const perDeal = new Map<number, number>();
    for (const r of records) if (r.dealId) perDeal.set(r.dealId, (perDeal.get(r.dealId) ?? 0) + 1);

    const contacted = calls ? await this.chatContacts(user.portal.id, prevStart) : [];
    const daysOf = (a: string, b: string): HeadDayDto[] => {
      const out: HeadDayDto[] = [];
      for (let date = a; date <= b; date = todayIn(tz, new Date(zonedDayRange(date, tz).end.getTime() + 1))) {
        const r = zonedDayRange(date, tz);
        const inDay = (iso: string) => {
          const t = Date.parse(iso);
          return t >= r.start.getTime() && t < r.end.getTime();
        };
        const dayDeals = allDeals.filter((d) => inDay(d.createdAt));
        const dayCalls = (calls?.rows ?? []).filter((c) => inDay(c.START_TIME));
        out.push({
          date,
          newDeals: dayDeals.length,
          bookedDeals: dayDeals.filter((d) => (perDeal.get(d.id) ?? 0) > 0).length,
          bookings: dayDeals.reduce((n, d) => n + (perDeal.get(d.id) ?? 0), 0),
          repeat: dayDeals.filter((d) => d.repeat).length,
          calls: dayCalls.length,
          missed: dayCalls.filter((c) => String(c.DIRECTION) === '1' && isMissed(c)).length,
          lost: calls ? callClients(calls.rows, r.start, r.end, null).filter((cl) => cl.lost && !reachedInChat(cl, contacted)).length : 0,
        });
      }
      return out;
    };
    const totalsOf = (days: HeadDayDto[], s: Date, e: Date): HeadTotalsDto => {
      const sum = (k: keyof Omit<HeadDayDto, 'date'>) => days.reduce((n, d) => n + d[k], 0);
      const periodCalls = (calls?.rows ?? []).filter((c) => Date.parse(c.START_TIME) >= s.getTime() && Date.parse(c.START_TIME) < e.getTime());
      return {
        newDeals: sum('newDeals'),
        bookedDeals: sum('bookedDeals'),
        bookings: sum('bookings'),
        repeat: sum('repeat'),
        calls: sum('calls'),
        missed: sum('missed'),
        lost: sum('lost'),
        incoming: periodCalls.filter((c) => String(c.DIRECTION) === '1').length,
        outgoing: periodCalls.filter((c) => String(c.DIRECTION) !== '1').length,
      };
    };
    const days = daysOf(from, to);
    return {
      from,
      to,
      timezone: tz,
      days,
      totals: totalsOf(days, start, end),
      previous: { ...prev, totals: totalsOf(daysOf(prev.from, prev.to), prevStart, start) },
      deals: deals !== null,
      calls: calls !== null,
      notes,
    };
  }

  /** Чаты, где последним после начала периода писал сотрудник: контакт и номера клиента, когда. */
  private async chatContacts(portalId: string, since: Date): Promise<{ contactId: number | null; phones: string[]; at: number }[]> {
    const rows = await this.prisma.openlineChat.findMany({
      where: { portalId, lastMessageAt: { gte: since }, lastAuthor: { not: 'client' } },
      select: { crm: true, phones: true, lastMessageAt: true },
      take: 5000,
    });
    return rows.map((r) => ({
      contactId: Number((r.crm as { contactId?: unknown } | null)?.contactId) || null,
      phones: (Array.isArray(r.phones) ? (r.phones as unknown[]) : []).map(digits10).filter((x) => x.length === 10),
      at: r.lastMessageAt?.getTime() ?? 0,
    }));
  }
}

/** Клиенту написали в чат после его последнего пропущенного звонка (по контакту или номеру). */
export function reachedInChat(cl: CallClient, chats: { contactId: number | null; phones: string[]; at: number }[]): boolean {
  const missed = cl.incoming.find(isMissed);
  if (!missed) return false;
  const after = Date.parse(missed.START_TIME);
  const phone = digits10(missed.COMMUNICATIONS?.find((x: NonNullable<CallActivity['COMMUNICATIONS']>[number]) => x.VALUE)?.VALUE);
  return chats.some((ch) => ch.at > after && ((cl.contactId !== null && ch.contactId === cl.contactId) || (phone.length === 10 && ch.phones.includes(phone))));
}

import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CALL_KINDS,
  DASHBOARD_MAX_DAYS,
  type CallKind,
  type CallListDto,
  type CallFunnelDto,
  type CallScope,
  isIsoDate,
  todayIn,
  zonedDayRange,
  type DashboardBookingRow,
  type DashboardDto,
} from '@btx24/shared';
import type { BookingRecord } from '../../generated/prisma/client.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { BookingJournalService } from '../bookings/booking-journal.service.js';
import { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import { dealHappened } from '../bookings/deal-outcome.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { callClients, isMissed, type CallActivity, type CallClient } from './call-stats.js';
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
/** Звонков с начала периода по сейчас — больше не разбираем (за 92 дня у комплекса — сотни-тысячи). */
const MAX_CALLS = 5000;
const OWNER_LABELS: Record<number, string> = { 1: 'Лид', 2: 'Сделка', 3: 'Контакт', 4: 'Компания' };

type DealInfo = NonNullable<DashboardBookingRow['deal']>;

/** Дашборд менеджера: только его собственные показатели, правами его токена. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly chats: ChatsService,
    private readonly journal: BookingJournalService,
    private readonly fieldMap?: DealFieldMapService,
  ) {}

  async get(
    user: B24UserContext,
    query: { from?: unknown; to?: unknown; callsScope?: unknown; callsFunnel?: unknown },
    openlines: boolean,
    /** Воронки групп пользователя — для «повторных» клиентов. */
    funnelIds: number[] = [],
  ): Promise<DashboardDto> {
    const { from, to, start, end } = parsePeriod(user.portal.timezone, query);
    const callsScope = parseScope(query.callsScope);
    const callsFunnel = pickFunnel(query.callsFunnel, funnelIds);
    const [bookings, calls, callFunnels, chats] = await Promise.all([
      this.bookings(user, start, end),
      this.callCounts(user, start, end, callsScope, callsFunnel),
      this.funnelNames(user, funnelIds),
      openlines
        ? Promise.all([this.chats.list(user, { scope: 'mine' }), this.unreadMessages(user), this.contacts(user, start, end)])
        : null,
    ]);
    const callInfo = { calls, callsScope, callsFunnel, callFunnels };
    if (!chats) return { from, to, chats: null, contacts: null, ...callInfo, bookings };
    const [mine, unread, contacts] = chats;
    return {
      from,
      to,
      chats: { waitingReply: mine.items.filter((c) => c.waitingReply).length, unreadMessages: unread },
      contacts,
      ...callInfo,
      bookings,
    };
  }

  /** Клиенты выбранного вида звонков за период — для окна со сделками. */
  async callList(
    user: B24UserContext,
    query: { from?: unknown; to?: unknown; kind?: unknown; scope?: unknown; funnel?: unknown },
    funnelIds: number[] = [],
  ): Promise<CallListDto> {
    const { start, end } = parsePeriod(user.portal.timezone, query);
    const kind = query.kind as CallKind;
    if (!CALL_KINDS.includes(kind))
      throw new BadRequestException({ code: 'INVALID_KIND', message: 'kind: incoming, new, repeat, answered, missed или lost' });
    const { rows, truncated } = await this.fetchCalls(user, start);
    const clients = callClients(rows, start, end, parseScope(query.scope) === 'mine' ? user.userId : null);
    const repeat = await this.repeatClients(user, clients, pickFunnel(query.funnel, funnelIds));
    const chosen = clients.filter((c) => matches(c, kind, repeat));
    // Звонок для строки: для пропущенных/упущенных — последний пропущенный, для отвеченных — отвеченный.
    const shown = chosen.map((c) => ({
      c,
      call:
        (kind === 'missed' || kind === 'lost'
          ? c.incoming.find(isMissed)
          : kind === 'answered'
            ? c.incoming.find((x) => !isMissed(x))
            : undefined) ?? c.incoming[0],
    }));
    const [titles, contacts] = await Promise.all([
      this.ownerTitles(user, shown.map((x) => x.call)),
      this.contactNames(user, chosen.map((c) => c.contactId).filter((x): x is number => x !== null)),
    ]);
    return {
      kind,
      truncated,
      items: shown.map(({ c, call }) => ({
        clientKey: c.key,
        activityId: Number(call.ID),
        at: new Date(call.START_TIME).toISOString(),
        missed: isMissed(call),
        phone: call.COMMUNICATIONS?.[0]?.VALUE ?? null,
        incomingCount: c.incoming.length,
        repeat: repeat.has(c.key),
        contact: c.contactId ? { id: c.contactId, name: contacts.get(c.contactId) ?? null } : null,
        owner: {
          typeId: Number(call.OWNER_TYPE_ID),
          id: Number(call.OWNER_ID),
          title: titles.get(`${call.OWNER_TYPE_ID}:${call.OWNER_ID}`) ?? null,
        },
        dealId: Number(call.OWNER_TYPE_ID) === 2 ? Number(call.OWNER_ID) : null,
        responsibleId: Number(call.RESPONSIBLE_ID) || null,
      })),
    };
  }

  /** Клиенты по видам; нет доступа к делам CRM — null (дашборд работает без них). */
  private async callCounts(
    user: B24UserContext,
    start: Date,
    end: Date,
    scope: CallScope,
    funnel: number | null,
  ): Promise<DashboardDto['calls']> {
    try {
      const { rows } = await this.fetchCalls(user, start);
      const clients = callClients(rows, start, end, scope === 'mine' ? user.userId : null);
      const repeat = await this.repeatClients(user, clients, funnel);
      return Object.fromEntries(CALL_KINDS.map((k) => [k, clients.filter((c) => matches(c, k, repeat)).length])) as Record<
        CallKind,
        number
      >;
    } catch (err) {
      if (err instanceof Bitrix24Error) return null;
      throw err;
    }
  }

  /**
   * Повторные клиенты: у контакта есть **состоявшаяся** сделка в выбранной воронке до его первого
   * звонка в периоде — не проиграна и её бронь уже закончилась (без даты брони — выигранная,
   * закрытая раньше). Большинство прошедших броней не переводят в «успешно» — поэтому так.
   */
  private async repeatClients(user: B24UserContext, clients: CallClient[], funnel: number | null): Promise<Set<string>> {
    const out = new Set<string>();
    const contactIds = [...new Set(clients.map((c) => c.contactId).filter((x): x is number => x !== null))];
    if (funnel === null || !contactIds.length) return out;
    const endField = (await this.fieldMap?.get(user.portal.id))?.bookingEnd;
    type Row = { CONTACT_ID: string | null; CLOSEDATE: string | null; STAGE_SEMANTIC_ID: string | null } & Record<string, string | null>;
    const deals: Row[] = [];
    for (let i = 0; i < contactIds.length; i += CONTACT_CHUNK)
      deals.push(
        ...(await user.client.listAll<Row>(
          'crm.deal.list',
          {
            filter: { '@CONTACT_ID': contactIds.slice(i, i + CONTACT_CHUNK), CATEGORY_ID: funnel, '!STAGE_SEMANTIC_ID': 'F' },
            select: ['ID', 'CONTACT_ID', 'CLOSEDATE', 'STAGE_SEMANTIC_ID', ...(endField ? [endField] : [])],
          },
          { max: 5000 },
        )),
      );
    for (const c of clients) {
      if (!c.contactId) continue;
      if (deals.some((d) => Number(d.CONTACT_ID) === c.contactId && dealHappened(d, endField ? d[endField] : null, c.firstIncomingAt)))
        out.add(c.key);
    }
    return out;
  }

  /** Названия воронок групп пользователя (`crm.category.list`, кэш на портал). */
  private readonly funnelCache = new Map<string, { names: Map<number, string>; expiresAt: number }>();
  private async funnelNames(user: B24UserContext, ids: number[]): Promise<CallFunnelDto[]> {
    if (!ids.length) return [];
    let hit = this.funnelCache.get(user.portal.id);
    if (!hit || hit.expiresAt < Date.now()) {
      try {
        const res = await user.client.call<{ categories?: { id: number; name: string }[] }>('crm.category.list', { entityTypeId: 2 });
        hit = { names: new Map((res.result?.categories ?? []).map((c) => [Number(c.id), c.name])), expiresAt: Date.now() + 10 * 60_000 };
        this.funnelCache.set(user.portal.id, hit);
      } catch {
        hit = { names: new Map(), expiresAt: 0 };
      }
    }
    return ids.map((id) => ({ id, name: hit!.names.get(id) ?? `Воронка ${id}` }));
  }

  private async contactNames(user: B24UserContext, ids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const unique = [...new Set(ids)].slice(0, 200);
    if (!unique.length) return out;
    const rows = await user.client.listAll<{ ID: string; NAME?: string | null; LAST_NAME?: string | null }>('crm.contact.list', {
      filter: { '@ID': unique },
      select: ['ID', 'NAME', 'LAST_NAME'],
    });
    for (const r of rows) out.set(Number(r.ID), [r.NAME, r.LAST_NAME].filter(Boolean).join(' ') || `Контакт #${r.ID}`);
    return out;
  }

  /** Звонки телефонии с начала периода по сейчас — токеном пользователя (его права в CRM). */
  private async fetchCalls(user: B24UserContext, start: Date): Promise<{ rows: CallActivity[]; truncated: boolean }> {
    const rows = await user.client.listAll<CallActivity>(
      'crm.activity.list',
      {
        filter: { TYPE_ID: 2, PROVIDER_ID: 'VOXIMPLANT_CALL', '>=START_TIME': start.toISOString() },
        select: ['ID', 'OWNER_ID', 'OWNER_TYPE_ID', 'DIRECTION', 'START_TIME', 'RESPONSIBLE_ID', 'SETTINGS', 'COMMUNICATIONS'],
      },
      { max: MAX_CALLS },
    );
    return { rows, truncated: rows.length >= MAX_CALLS };
  }

  /** Названия сделок, лидов, контактов и компаний звонков — одним пакетом, правами пользователя. */
  private async ownerTitles(user: B24UserContext, calls: CallActivity[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = (type: number) => [...new Set(calls.filter((c) => Number(c.OWNER_TYPE_ID) === type).map((c) => Number(c.OWNER_ID)))];
    const spec: [number, string, string[]][] = [
      [2, 'crm.deal.list', ['ID', 'TITLE']],
      [1, 'crm.lead.list', ['ID', 'TITLE']],
      [3, 'crm.contact.list', ['ID', 'NAME', 'LAST_NAME']],
      [4, 'crm.company.list', ['ID', 'TITLE']],
    ];
    const commands = Object.fromEntries(
      spec
        .filter(([type]) => ids(type).length)
        .map(([type, method, select]) => [`t${type}`, { method, params: { filter: { '@ID': ids(type).slice(0, 50) }, select } }]),
    );
    if (!Object.keys(commands).length) return out;
    const res = await user.client.batch(commands);
    for (const [type] of spec) {
      for (const r of (res.result[`t${type}`] as Record<string, string | null>[] | undefined) ?? []) {
        const title = r.TITLE ?? [r.NAME, r.LAST_NAME].filter(Boolean).join(' ');
        out.set(`${type}:${r.ID}`, title || `${OWNER_LABELS[type]} #${r.ID}`);
      }
    }
    return out;
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

const parseScope = (v: unknown): CallScope => (v === 'mine' ? 'mine' : 'all');
/** Контактов в одном запросе сделок. */
const CONTACT_CHUNK = 50;

/** Выбранная воронка, если она среди воронок групп пользователя; иначе — первая из них. */
function pickFunnel(v: unknown, ids: number[]): number | null {
  const n = Number(v);
  if (v !== undefined && v !== '' && ids.includes(n)) return n;
  return ids[0] ?? null;
}

function matches(c: CallClient, kind: CallKind, repeat: Set<string>): boolean {
  switch (kind) {
    case 'incoming':
      return true;
    case 'repeat':
      return repeat.has(c.key);
    case 'new':
      return !repeat.has(c.key);
    case 'answered':
      return c.answered;
    case 'missed':
      return c.missed;
    case 'lost':
      return c.lost;
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

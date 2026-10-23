import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CALL_KINDS,
  DASHBOARD_PARTS,
  type DashboardPart,
  DASHBOARD_MAX_DAYS,
  type CallKind,
  type CallListDto,
  type CallLogDto,
  type CallLogRowDto,
  type RecentCallsDto,
  type CallFunnelDto,
  type CallScope,
  isIsoDate,
  todayIn,
  zonedDayRange,
  type DashboardBookingRow,
  type DashboardDto,
  type DashboardNewDeal,
} from '@btx24/shared';
import type { BookingRecord } from '../../generated/prisma/client.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { BookingJournalService } from '../bookings/booking-journal.service.js';
import { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import { happened, isCertificatePurchase, outcomeSelect } from '../bookings/deal-outcome.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { callClients, callDurationSec, callStatus, isMissed, type CallActivity, type CallClient } from './call-stats.js';
import { ChatsService } from './chats.service.js';

/** Готовый ответ дашборда живёт столько — снимает нагрузку с лимита запросов портала. */
const CACHE_MS = 30_000;
const DAY_MS = 86_400_000;
/** Звонков с начала периода по сейчас — больше не разбираем (за 92 дня у комплекса — сотни-тысячи). */
const MAX_CALLS = 5000;
/** Новых сделок за период в ответе (плитка считает все, список — первые). */
const MAX_NEW_DEALS = 500;
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

  /** Готовый дашборд сотрудника на 30 секунд: переключение периода и возврат — без новых запросов к порталу. */
  private readonly cache = new Map<string, { expiresAt: number; value: Promise<Partial<DashboardDto>> }>();

  /** `query.part` — только эта часть (см. `DashboardPart`); без него — весь дашборд. */
  async get(
    user: B24UserContext,
    query: { from?: unknown; to?: unknown; callsScope?: unknown; callsFunnel?: unknown; part?: unknown },
    openlines: boolean,
    funnelIds: number[] = [],
    resourceIds: number[] | null = null,
  ): Promise<Partial<DashboardDto>> {
    const key = JSON.stringify([user.portal.id, user.userId, query.from, query.to, query.callsScope, query.callsFunnel, query.part, openlines, funnelIds, resourceIds]);
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    if (this.cache.size > 500) for (const [k, v] of this.cache) if (v.expiresAt <= now) this.cache.delete(k);
    const value = this.compute(user, query, openlines, funnelIds, resourceIds);
    this.cache.set(key, { expiresAt: now + CACHE_MS, value });
    // Ошибку не кэшируем — следующий запрос попробует снова.
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private async compute(
    user: B24UserContext,
    query: { from?: unknown; to?: unknown; callsScope?: unknown; callsFunnel?: unknown; part?: unknown },
    openlines: boolean,
    /** Воронки групп пользователя — для «повторных» клиентов. */
    funnelIds: number[] = [],
    /** Ресурсы групп пользователя — какие брони показывать; null — все (администратор). */
    resourceIds: number[] | null = null,
  ): Promise<Partial<DashboardDto>> {
    const { from, to, start, end } = parsePeriod(user.portal.timezone, query);
    if (query.part !== undefined && !DASHBOARD_PARTS.includes(query.part as DashboardPart))
      throw new BadRequestException({ code: 'INVALID_PART', message: `part: ${DASHBOARD_PARTS.join(', ')}` });
    const want = (p: DashboardPart) => query.part === undefined || query.part === p;
    const callsScope = parseScope(query.callsScope);
    const callsFunnel = pickFunnel(query.callsFunnel, funnelIds);
    // Звонки периода — один запрос на плитки звонков и «все звонки»; нет доступа к делам — null.
    const callRows = (want('calls') ? this.fetchCalls(user, start) : Promise.resolve({ rows: [] as CallActivity[] })).then(
      (r) => r.rows,
      (err: unknown) => {
        if (err instanceof Bitrix24Error) return null;
        throw err;
      },
    );
    const [bookings, bookingDays, calls, callsTotal, newDeals, callFunnels, attention] = await Promise.all([
      want('base') ? this.bookings(user, start, end, callsScope, resourceIds) : undefined,
      want('base') ? this.bookingDays(user, resourceIds) : undefined,
      want('calls') ? callRows.then((rows) => (rows ? this.callCounts(user, rows, start, end, callsScope, callsFunnel) : null)) : undefined,
      want('calls')
        ? callRows.then((rows) =>
            rows ? rows.filter((c) => Date.parse(c.START_TIME) < end.getTime() && (callsScope !== 'mine' || Number(c.RESPONSIBLE_ID) === user.userId)).length : null,
          )
        : undefined,
      want('deals') ? this.newDeals(user, start, end, callsScope, funnelIds) : undefined,
      this.funnelNames(user, funnelIds),
      // Чаты — из кэша (без запросов к порталу).
      want('base') && openlines ? this.chats.attention(user) : null,
    ]);
    const out: Partial<DashboardDto> = { from, to, callsScope, callsFunnel, callFunnels };
    if (want('base')) Object.assign(out, { chats: attention ? { waitingReply: attention.waiting, attention: attention.items } : null, bookings, bookingDays });
    if (want('calls')) Object.assign(out, { calls, callsTotal });
    if (want('deals')) Object.assign(out, { newDeals });
    return out;
  }

  /** Активные брони на сегодня и на завтра (дни портала) — по ресурсам групп пользователя. */
  private async bookingDays(user: B24UserContext, resourceIds: number[] | null): Promise<DashboardDto['bookingDays']> {
    const tz = user.portal.timezone;
    const today = zonedDayRange(todayIn(tz), tz);
    // Завтра — следующий день портала (а не +24 часа: переход на летнее время).
    const tomorrow = zonedDayRange(todayIn(tz, today.end), tz);
    const [a, b] = await Promise.all([
      this.journal.activeListBetween(user.portal.id, today.start, today.end, resourceIds),
      this.journal.activeListBetween(user.portal.id, tomorrow.start, tomorrow.end, resourceIds),
    ]);
    const pending = await this.journal.pendingRemoval(user.portal.id, [...a, ...b].map((r) => r.bookingId));
    const rows = await this.toRows(user, [...a, ...b], pending);
    // В счётчиках — только брони, которые есть в Битрикс24; пропавшие видны в списках с пометкой.
    const live = (list: BookingRecord[]) => list.filter((r) => !pending.has(r.bookingId)).length;
    return { today: live(a), tomorrow: live(b), todayItems: rows.slice(0, a.length), tomorrowItems: rows.slice(a.length) };
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

  /** Журнал звонков дня: дата и время, номер клиента, сотрудник, направление, статус. */
  async callLog(user: B24UserContext, query: { date?: unknown; scope?: unknown }): Promise<CallLogDto> {
    const tz = user.portal.timezone;
    const date = query.date === undefined || query.date === '' ? todayIn(tz) : String(query.date);
    if (!isIsoDate(date)) throw new BadRequestException({ code: 'INVALID_DATE', message: 'date: YYYY-MM-DD' });
    const scope = parseScope(query.scope);
    const { start, end } = zonedDayRange(date, tz);
    const { rows, truncated } = await this.fetchCalls(user, start, end);
    const mine = rows.filter((c) => scope !== 'mine' || Number(c.RESPONSIBLE_ID) === user.userId);
    mine.sort((a, b) => Date.parse(b.START_TIME) - Date.parse(a.START_TIME));
    return { date, scope, truncated, items: await this.logRows(user, mine) };
  }

  /**
   * Последние звонки из журнала (блок «Звонки» на дашборде): новые сверху, до 50 — дашборд
   * показывает по 5. Правами сотрудника: только звонки, которые он видит в CRM.
   */
  async recentCalls(user: B24UserContext, query: { scope?: unknown }): Promise<RecentCallsDto> {
    const scope = parseScope(query.scope);
    const res = await user.client.call<CallActivity[]>('crm.activity.list', {
      filter: { TYPE_ID: 2, PROVIDER_ID: 'VOXIMPLANT_CALL', ...(scope === 'mine' ? { RESPONSIBLE_ID: user.userId } : {}) },
      order: { START_TIME: 'DESC' },
      select: ['ID', 'OWNER_ID', 'OWNER_TYPE_ID', 'DIRECTION', 'START_TIME', 'END_TIME', 'RESPONSIBLE_ID', 'SETTINGS', 'COMMUNICATIONS'],
    });
    return { scope, items: await this.logRows(user, res.result ?? []) };
  }

  private async logRows(user: B24UserContext, mine: CallActivity[]): Promise<CallLogRowDto[]> {
    const contactIds = mine.map((c) => Number(c.COMMUNICATIONS?.find((x) => Number(x.ENTITY_TYPE_ID) === 3)?.ENTITY_ID) || 0).filter((x) => x > 0);
    const [titles, contacts, employees] = await Promise.all([
      this.ownerTitles(user, mine),
      this.contactNames(user, contactIds),
      this.employeeNames(user, mine.map((c) => Number(c.RESPONSIBLE_ID) || 0)),
    ]);
    return mine.map((c) => {
        const contactId = Number(c.COMMUNICATIONS?.find((x) => Number(x.ENTITY_TYPE_ID) === 3)?.ENTITY_ID) || 0;
        const emp = Number(c.RESPONSIBLE_ID) || 0;
        return {
          activityId: Number(c.ID),
          at: new Date(c.START_TIME).toISOString(),
          durationSec: callDurationSec(c),
          direction: String(c.DIRECTION) === '1' ? 'incoming' : 'outgoing',
          status: callStatus(c),
          clientPhone: c.COMMUNICATIONS?.find((x) => x.VALUE)?.VALUE ?? null,
          employee: emp ? { id: emp, name: employees.get(emp) ?? null } : null,
          contact: contactId ? { id: contactId, name: contacts.get(contactId) ?? null } : null,
          owner: { typeId: Number(c.OWNER_TYPE_ID), id: Number(c.OWNER_ID), title: titles.get(`${c.OWNER_TYPE_ID}:${c.OWNER_ID}`) ?? null },
        };
      });
  }

  private async employeeNames(user: B24UserContext, ids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const unique = [...new Set(ids.filter((x) => x > 0))].slice(0, 200);
    if (!unique.length) return out;
    try {
      const rows = await user.client.listAll<{ ID: string; NAME?: string; LAST_NAME?: string }>('user.get', { FILTER: { ID: unique } });
      for (const r of rows) out.set(Number(r.ID), [r.NAME, r.LAST_NAME].filter(Boolean).join(' ') || `#${r.ID}`);
    } catch {
      /* без имён — покажем номер сотрудника */
    }
    return out;
  }

  /** Клиенты по видам; нет доступа к делам CRM — null (дашборд работает без них). */
  private async callCounts(
    user: B24UserContext,
    rows: CallActivity[],
    start: Date,
    end: Date,
    scope: CallScope,
    funnel: number | null,
  ): Promise<DashboardDto['calls']> {
    try {
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
   * Новые сделки — созданные за период в воронках групп пользователя (мои — где я ответственный).
   * Повторный клиент — у контакта есть состоявшаяся сделка той же воронки, созданная раньше этой
   * (то же правило «состоялась», что у звонков: не проиграна и бронь прошла / выиграна).
   */
  async newDeals(user: B24UserContext, start: Date, end: Date, scope: CallScope, funnelIds: number[]): Promise<DashboardDto['newDeals']> {
    type Row = Record<string, string | null>;
    const outcome = (await this.fieldMap?.outcome(user.portal.id, user.client).catch(() => null)) ?? { certificateTypeId: null };
    try {
      const rows = await user.client.listAll<Row>(
        'crm.deal.list',
        {
          filter: {
            '>=DATE_CREATE': start.toISOString(),
            '<DATE_CREATE': end.toISOString(),
            ...(funnelIds.length ? { '@CATEGORY_ID': funnelIds } : {}),
            ...(scope === 'mine' ? { ASSIGNED_BY_ID: user.userId } : {}),
          },
          order: { DATE_CREATE: 'DESC' },
          select: ['ID', 'TITLE', 'CATEGORY_ID', 'CONTACT_ID', 'DATE_CREATE', 'OPPORTUNITY', 'CURRENCY_ID', 'SOURCE_ID', ...outcomeSelect(outcome)],
        },
        { max: MAX_NEW_DEALS },
      );
      const contactIds = [...new Set(rows.map((d) => Number(d.CONTACT_ID) || 0).filter((x) => x > 0))];
      // Сделки клиентов — пачками параллельно (темп держит ограничитель портала), имена — заодно.
      const [earlierChunks, names, bookingState, sources] = await Promise.all([
        Promise.all(
          chunks(contactIds, CONTACT_CHUNK).map((ids) =>
            user.client.listAll<Row>(
              'crm.deal.list',
              {
                filter: { '@CONTACT_ID': ids, '!STAGE_SEMANTIC_ID': 'F', '<DATE_CREATE': end.toISOString() },
                select: ['ID', 'CONTACT_ID', 'CATEGORY_ID', 'DATE_CREATE', 'CLOSEDATE', 'STAGE_SEMANTIC_ID', ...outcomeSelect(outcome)],
              },
              { max: 5000 },
            ),
          ),
        ),
        this.contactNames(user, contactIds),
        this.journal.dealBookingState(user.portal.id, rows.map((d) => Number(d.ID))),
        rows.some((d) => d.SOURCE_ID) ? this.sourceNames(user) : new Map<string, string>(),
      ]);
      const earlier = earlierChunks.flat();
      const items: DashboardNewDeal[] = rows.map((d) => {
        const contactId = Number(d.CONTACT_ID) || 0;
        const created = Date.parse(String(d.DATE_CREATE));
        const repeat =
          contactId > 0 &&
          earlier.some(
            (e) =>
              e.ID !== d.ID &&
              Number(e.CONTACT_ID) === contactId &&
              e.CATEGORY_ID === d.CATEGORY_ID &&
              Date.parse(String(e.DATE_CREATE)) < created &&
              happened(e, outcome, created),
          );
        return {
          id: Number(d.ID),
          title: d.TITLE ?? `Сделка #${d.ID}`,
          createdAt: Number.isFinite(created) ? new Date(created).toISOString() : String(d.DATE_CREATE ?? ''),
          opportunity: d.OPPORTUNITY === null || d.OPPORTUNITY === undefined ? null : Number(d.OPPORTUNITY),
          currency: d.CURRENCY_ID ?? null,
          contact: contactId ? { id: contactId, name: names.get(contactId) ?? null } : null,
          repeat,
          booking: bookingState.get(Number(d.ID)) ?? 'none',
          certificate: isCertificatePurchase(d, outcome),
          source: d.SOURCE_ID ? { id: d.SOURCE_ID, name: sources.get(d.SOURCE_ID) ?? d.SOURCE_ID } : null,
        };
      });
      return { total: items.length, repeat: items.filter((i) => i.repeat).length, items, truncated: rows.length >= MAX_NEW_DEALS };
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
    const outcome = (await this.fieldMap?.outcome(user.portal.id, user.client)) ?? { certificateTypeId: null };
    type Row = { CONTACT_ID: string | null; CLOSEDATE: string | null; STAGE_SEMANTIC_ID: string | null } & Record<string, string | null>;
    const deals = (
      await Promise.all(
        chunks(contactIds, CONTACT_CHUNK).map((ids) =>
          user.client.listAll<Row>(
            'crm.deal.list',
            {
              filter: { '@CONTACT_ID': ids, CATEGORY_ID: funnel, '!STAGE_SEMANTIC_ID': 'F' },
              select: ['ID', 'CONTACT_ID', 'CLOSEDATE', 'STAGE_SEMANTIC_ID', ...outcomeSelect(outcome)],
            },
            { max: 5000 },
          ),
        ),
      )
    ).flat();
    for (const c of clients) {
      if (!c.contactId) continue;
      if (deals.some((d) => Number(d.CONTACT_ID) === c.contactId && happened(d, outcome, c.firstIncomingAt)))
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

  /** Справочник источников сделок CRM (SOURCE): код → название; кэш на портал 10 минут. */
  private readonly sourcesCache = new Map<string, { at: number; names: Promise<Map<string, string>> }>();
  private sourceNames(user: B24UserContext): Promise<Map<string, string>> {
    const hit = this.sourcesCache.get(user.portal.id);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.names;
    // Справочник — для подписи; недоступен — коды источников вместо названий.
    const names = (async () => {
      const r = await user.client.call<{ STATUS_ID: string; NAME: string }[]>('crm.status.list', { filter: { ENTITY_ID: 'SOURCE' } });
      return new Map((r?.result ?? []).map((x) => [x.STATUS_ID, x.NAME]));
    })().catch(() => new Map<string, string>());
    this.sourcesCache.set(user.portal.id, { at: Date.now(), names });
    return names;
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
  async fetchCalls(user: B24UserContext, start: Date, end?: Date): Promise<{ rows: CallActivity[]; truncated: boolean }> {
    const rows = await user.client.listAll<CallActivity>(
      'crm.activity.list',
      {
        filter: {
          TYPE_ID: 2,
          PROVIDER_ID: 'VOXIMPLANT_CALL',
          '>=START_TIME': start.toISOString(),
          ...(end ? { '<START_TIME': end.toISOString() } : {}),
        },
        select: ['ID', 'OWNER_ID', 'OWNER_TYPE_ID', 'DIRECTION', 'START_TIME', 'END_TIME', 'RESPONSIBLE_ID', 'SETTINGS', 'COMMUNICATIONS'],
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

  /**
   * Новые и удалённые брони за период из журнала (приложение и найденные сверкой в Битрикс24), с
   * названиями сделок, ресурсов и сотрудников — токеном пользователя (недоступная сделка → null).
   */
  private async bookings(user: B24UserContext, start: Date, end: Date, scope: CallScope, resourceIds: number[] | null): Promise<DashboardDto['bookings']> {
    const j = await this.journal.forPeriod(user.portal.id, start, end, { resourceIds, userId: scope === 'mine' ? user.userId : null });
    const rows = await this.toRows(user, [...j.created, ...j.removed], j.pending);
    return {
      created: { total: j.created.length, items: rows.slice(0, j.created.length) },
      removed: { total: j.removed.length, items: rows.slice(j.created.length) },
    };
  }

  /** Строки броней для дашборда: сделка (видимая пользователю) с клиентом, ресурсы, кто создал/снял. */
  private async toRows(user: B24UserContext, records: BookingRecord[], pending: Set<number>): Promise<DashboardBookingRow[]> {
    const [deals, resources, people] = records.length
      ? await Promise.all([
          this.deals(user, [...new Set(records.flatMap((r) => (r.dealId ? [r.dealId] : [])))]),
          this.resourceNames(user),
          this.employeeNames(user, records.flatMap((r) => [r.createdByUserId ?? 0, r.cancelledByUserId ?? 0])),
        ])
      : [new Map<number, DealInfo>(), new Map<number, string>(), new Map<number, string>()];
    const who = (id: number | null) => (id ? (people.get(id) ?? `Сотрудник #${id}`) : null);
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
      source: r.source,
      title: r.title,
      createdBy: who(r.createdByUserId),
      cancelledBy: who(r.cancelledByUserId),
      pendingRemoval: pending.has(r.bookingId),
    });
    return records.map(row);
  }

  /** Сделки, видимые пользователю в CRM; недоступные в ответ не попадают. */
  private async deals(user: B24UserContext, ids: number[]): Promise<Map<number, DealInfo>> {
    const out = new Map<number, DealInfo>();
    if (!ids.length) return out;
    const rows = await user.client.listAll<Record<string, string | null>>('crm.deal.list', {
      filter: { '@ID': ids },
      select: ['ID', 'TITLE', 'OPPORTUNITY', 'CURRENCY_ID', 'CONTACT_ID'],
    });
    const names = await this.contactNames(user, rows.map((d) => Number(d.CONTACT_ID) || 0).filter((x) => x > 0)).catch(() => new Map<number, string>());
    for (const d of rows)
      out.set(Number(d.ID), {
        title: d.TITLE ?? '',
        opportunity: d.OPPORTUNITY === null || d.OPPORTUNITY === undefined ? null : Number(d.OPPORTUNITY),
        currency: d.CURRENCY_ID ?? null,
        client: names.get(Number(d.CONTACT_ID)) ?? null,
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
}

const parseScope = (v: unknown): CallScope => (v === 'mine' ? 'mine' : 'all');
/** Контактов в одном запросе сделок. */
const CONTACT_CHUNK = 50;
const chunks = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

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

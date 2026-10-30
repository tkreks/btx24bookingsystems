import { BadRequestException, Injectable } from '@nestjs/common';
import type { ChatMessageDto } from '@btx24/shared';
import { classifyActionLog, todayIn, zonedDayRange, type MyActivityDto, type ClientTimelineEvent, type ActivityDayDto, type ActivityEventDto } from '@btx24/shared';
import { selectedPeriod } from '../../common/period.js';
import { callDurationSec, callStatus, type CallActivity } from './call-stats.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { FROM_HOUR, TO_HOUR, isSystemMessage, shiftOwner, shiftSpan, summarize, type Shift } from './activity.js';
import { photoUrl } from '../bitrix24/rest/photo-url.js';
import { authorKind, phoneOutgoing, preview, withoutPhoneEchoes, type ImMessage, type ImUser } from './chat-parsing.js';
import { CHAIN_ACTION } from './chain-send-guard.js';

/** Чатов дня, переписку которых смотрим (последние 50 сообщений каждого). */
const MAX_CHATS = 150;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Смены, начатые раньше дня, но захватившие его (не закрыли рабочий день): ищем на столько назад. */
const SHIFT_LOOKBACK_MS = 7 * 86_400_000;
const SHARED_NAME = 'Совместное использование';

type Row = Record<string, unknown>;

/** Сотрудники групп портала — для автора сообщений «с телефона»; смены дня — сегодня 5 мин, прошлые 6 ч. */
const PEOPLE_TTL_MS = 10 * 60_000;
const SHIFTS_TODAY_TTL_MS = 5 * 60_000;
const SHIFTS_PAST_TTL_MS = 6 * 60 * 60_000;
type People = Map<number, { name: string; photo: string | null }>;
type Cached<T> = { at: number; value: T | null; loading: Promise<unknown> | null };

/** Кому приписать сообщение с телефона: смена покрывает ровно одного — ему, нескольких — спорно, никого — неизвестно. */
export function phoneAuthorAt(shifts: Shift[], people: People, at: number, now = Date.now()): Pick<ChatMessageDto['author'], 'name' | 'phone' | 'avatar'> & { userId?: number } {
  const covering = [...new Set(shifts.filter((s) => s.start <= at && at <= (s.end ?? now)).map((s) => s.userId))].sort((a, b) => a - b);
  if (covering.length === 1) {
    const p = people.get(covering[0]);
    return { userId: covering[0], name: p?.name ?? `#${covering[0]}`, avatar: p?.photo ?? null, phone: 'shift' };
  }
  if (covering.length > 1) return { name: `Спорно: на смене ${covering.map((id) => people.get(id)?.name ?? `#${id}`).join(', ')}`, phone: 'shared' };
  return { name: 'Телефон', phone: 'unknown' };
}

/**
 * «Активность сотрудников» за день (решение владельца 2026-10-23, только администраторам приложения).
 * Сотрудники — участники групп (сотрудники и отделы). Смена — timeman. Действия — по Битрикс24:
 * звонки (начало, длительность), сообщения в чатах (свои; с телефона через Wazzup — тому, чья смена),
 * новые сделки (кто создал); по приложению — брони и журнал действий. Боты, системные сообщения и
 * автосообщения приложения (`SystemMessage`) работой сотрудника не считаются.
 */
@Injectable()
export class ActivityService {

  constructor(private readonly prisma: PrismaService) {}

  private readonly peopleCache = new Map<string, Cached<People>>();
  private readonly shiftCache = new Map<string, Cached<Shift[]>>();

  /** Из кэша; нет или устарело — загрузка в фоне (ответ чата её не ждёт). `null` — ещё не загружено. */
  private cachedValue<T>(map: Map<string, Cached<T>>, key: string, ttl: number, load: () => Promise<T>): T | null {
    const hit = map.get(key);
    if (hit && (Date.now() - hit.at < ttl || hit.loading)) return hit.value;
    if (map.size > 2000) map.clear();
    const entry: Cached<T> = hit ?? { at: 0, value: null, loading: null };
    entry.loading = load().then(
      (value) => Object.assign(entry, { value, at: Date.now(), loading: null }),
      () => Object.assign(entry, { at: Date.now(), loading: null }),
    );
    map.set(key, entry);
    return entry.value;
  }

  /**
   * Автор сообщений «с телефона» в ленте чата (решение владельца 2026-10-27): по сменам сотрудников
   * групп — на смене один сотрудник, его имя и фото; несколько — «Спорно: на смене …»; смены нет —
   * «Телефон» (веб ставит «?» вместо аватарки). Метка Wazzup с именем («автор: Елена») не трогается.
   * Смены и сотрудники — из кэша; пока грузятся — `pending` (лента перечитается через пару секунд).
   */
  phoneAuthors<T extends ChatMessageDto>(user: B24UserContext, messages: T[]): { messages: T[]; pending: boolean } {
    const phone = messages.filter((m) => m.viaPhone && (m.author.name === 'Телефон' || !m.author.name));
    if (!phone.length) return { messages, pending: false };
    const portalId = user.portal.id;
    const tz = user.portal.timezone;
    const people = this.cachedValue(this.peopleCache, portalId, PEOPLE_TTL_MS, () => this.employees(user));
    if (!people) return { messages, pending: true };
    const ids = [...people.keys()];
    const today = todayIn(tz);
    const dayOf = (at: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    const shiftsByDay = new Map<string, Shift[] | null>();
    for (const m of phone) {
      const day = dayOf(Date.parse(m.date));
      if (shiftsByDay.has(day)) continue;
      const { start, end } = zonedDayRange(day, tz);
      shiftsByDay.set(day, this.cachedValue(this.shiftCache, `${portalId}:${day}`, day === today ? SHIFTS_TODAY_TTL_MS : SHIFTS_PAST_TTL_MS, () => this.shifts(user, ids, start.getTime(), end.getTime())));
    }
    let pending = false;
    const out = messages.map((m) => {
      if (!phone.includes(m)) return m;
      const shifts = shiftsByDay.get(dayOf(Date.parse(m.date)));
      if (!shifts) {
        pending = true;
        return m;
      }
      const a = phoneAuthorAt(shifts, people, Date.parse(m.date));
      return { ...m, author: { ...m.author, ...(a.userId ? { id: a.userId } : {}), name: a.name, phone: a.phone, ...(a.avatar ? { avatar: a.avatar } : {}) } };
    });
    return { messages: out, pending };
  }

  async day(user: B24UserContext, query: { date?: unknown }): Promise<ActivityDayDto> {
    const tz = user.portal.timezone;
    if (query.date !== undefined && (typeof query.date !== 'string' || !DATE_RE.test(query.date)))
      throw new BadRequestException({ code: 'INVALID_DATE', message: 'date: YYYY-MM-DD' });
    const date = (query.date as string | undefined) ?? todayIn(tz);
    const { start, end } = zonedDayRange(date, tz);
    return this.collect(user, date, start, end, false);
  }

  async mine(user: B24UserContext, query: { from?: unknown; to?: unknown }, readChats = false): Promise<MyActivityDto> {
    const day = todayIn(user.portal.timezone);
    const p = selectedPeriod(query, user.portal.timezone) ?? { from: day, to: day, ...zonedDayRange(day, user.portal.timezone) };
    const data = await this.collect(user, p.from, p.start, p.end, true, readChats);
    const kinds = { call: 'call', chat: 'message', phone: 'message', deal: 'deal', booking: 'booking', app: 'activity' } as const;
    const events: ClientTimelineEvent[] = (data.employees.find((e) => e.userId === user.userId)?.events ?? []).map((e, i) => ({
      id: e.id ?? `my:${e.kind}:${e.at}:${i}`, at: e.at, kind: kinds[e.kind],
      title: e.kind === 'chat' || e.kind === 'phone' ? 'Отправлено сообщение' : e.text,
      text: e.text,
      actorId: user.userId, actorName: user.userName,
      ...(e.dealId ? { dealId: e.dealId } : {}), ...(e.chatId ? { chatId: e.chatId } : {}),
      ...(e.messageId ? { messageId: e.messageId } : {}), ...(e.direction ? { direction: e.direction } : {}),
      ...(e.action ? classifyActionLog({ action: e.action, details: e.details }) : { category: e.kind === 'call' || e.kind === 'chat' || e.kind === 'phone' ? 'communications' as const : e.kind === 'deal' ? 'crm' as const : e.kind === 'booking' ? 'bookings' as const : 'other' as const, severity: 'info' as const }),
    })).sort((a,b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
    return { userId: user.userId, from: p.from, to: p.to, events, notes: data.notes };
  }

  private async collect(user: B24UserContext, date: string, start: Date, end: Date, onlyMine: boolean, readChats = true): Promise<ActivityDayDto> {
    const tz = user.portal.timezone;
    const notes: string[] = [];
    const portalId = user.portal.id;

    const people = onlyMine ? new Map([[user.userId, { name: user.userName, photo: null as string | null }]]) : await this.employees(user);
    const ids = [...people.keys()];
    if (!ids.length) return { date, timezone: tz, fromHour: FROM_HOUR, toHour: TO_HOUR, employees: [], unattributedPhone: 0, notes: ['В группах нет сотрудников.'] };

    const [shifts, calls, deals, chats, marks, bookings, actions] = await Promise.all([
      this.shifts(user, ids, start.getTime(), end.getTime(), notes).catch((e) => {
        notes.push(`Смены (учёт рабочего времени) недоступны: ${e instanceof Bitrix24Error ? e.code : 'ошибка'}`);
        return [] as Shift[];
      }),
      this.calls(user, start, end).catch(() => {
        notes.push('Звонки недоступны: нет доступа к делам CRM.');
        return [] as Row[];
      }),
      this.deals(user, start, end).catch(() => {
        notes.push('Новые сделки недоступны: нет доступа к сделкам CRM.');
        return [] as Row[];
      }),
      readChats ? this.prisma.openlineChat.findMany({ where: { portalId, lastMessageAt: { gte: start } }, orderBy: { lastMessageAt: 'desc' }, take: MAX_CHATS, select: { chatId: true, clientName: true, title: true } }) : Promise.resolve([]),
      this.prisma.systemMessage.findMany({ where: { portalId, sentAt: { gte: new Date(start.getTime() - 3600_000), lt: new Date(end.getTime() + 3600_000) } } }),
      this.prisma.bookingRecord.findMany({ where: { portalId, createdAt: { gte: start, lt: end }, createdByUserId: { in: ids } }, select: { bookingId: true, dealId: true, createdAt: true, createdByUserId: true } }),
      this.prisma.actionLog.findMany({
        where: { portalId, at: { gte: start, lt: end }, actorKind: 'user', userId: { in: ids }, ...(onlyMine ? {} : { action: { notIn: ['app.enter', 'app.login', 'app.error', 'bitrix.error'] } }) },
        orderBy: { at: 'desc' },
        take: 2000,
        select: { id: true, at: true, action: true, details: true, userId: true, summary: true, entityType: true, entityId: true },
      }),
    ]);

    const events = new Map<number, ActivityEventDto[]>(ids.map((id) => [id, []]));
    const push = (userId: number | null, e: ActivityEventDto) => userId !== null && events.get(userId)?.push(e);
    const ev = (at: string | Date, kind: ActivityEventDto['kind'], text: string, o: Partial<ActivityEventDto> = {}): ActivityEventDto => ({
      at: new Date(at).toISOString(),
      kind,
      text,
      durationSec: null,
      dealId: null,
      chatId: null,
      ...o,
    });

    for (const c of calls) {
      const dur = callDurationSec(c as unknown as CallActivity);
      const status = callStatus(c as unknown as CallActivity);
      const dealId = Number(c.OWNER_TYPE_ID) === 2 ? Number(c.OWNER_ID) || null : null;
      const incoming = String(c.DIRECTION) === '1';
      const text = status === 'missed' ? 'Пропущенный звонок' : `${incoming ? 'Входящий' : 'Исходящий'} звонок${dur ? `, ${dur} с` : ' — без разговора'}`;
      push(Number(c.RESPONSIBLE_ID), ev(String(c.START_TIME), 'call', text, { id: `call:${c.ID}`, durationSec: dur, dealId, direction: incoming ? 'incoming' : 'outgoing' }));
    }
    for (const d of deals) push(Number(d.CREATED_BY_ID), ev(String(d.DATE_CREATE), 'deal', `Создал сделку «${String(d.TITLE ?? '').slice(0, 80)}»`, { id: `deal:${d.ID}`, dealId: Number(d.ID) }));
    for (const b of bookings) push(b.createdByUserId, ev(b.createdAt, 'booking', `Создал бронь #${b.bookingId}`, { id: `booking:${b.bookingId}`, dealId: b.dealId }));


    let unattributedPhone = 0;
    // Сообщения с телефона, когда смены нескольких сотрудников совпали, — отдельной строкой.
    const shared: ActivityEventDto[] = [];
    const sharedIds = new Set<number>();
    const markList = marks.map((m) => ({ chatId: m.chatId, messageId: m.messageId, userId: m.userId, sentAt: m.sentAt.getTime() }));
    const msgs = await this.messages(user, chats.map((c) => c.chatId), start, notes).catch(() => {
      notes.push('Переписка недоступна: нет доступа к чатам открытых линий.');
      return new Map<number, { messages: ImMessage[]; users: ImUser[] }>();
    });
    const chatName = new Map(chats.map((c) => [c.chatId, c.clientName || c.title || `Чат #${c.chatId}`]));
    for (const [chatId, { messages, users }] of msgs) {
      // Эхо своих сообщений от Wazzup — не сообщение «с телефона».
      for (const m of withoutPhoneEchoes(messages, users)) {
        const at = Date.parse(m.date);
        if (!(at >= start.getTime() && at < end.getTime())) continue;
        const kind = authorKind(m.author_id, users);
        const who = chatName.get(chatId) ?? `Чат #${chatId}`;
        if (kind === 'employee' && events.has(Number(m.author_id))) {
          if (isSystemMessage(markList, chatId, Number(m.id), Number(m.author_id), at)) continue;
          push(Number(m.author_id), ev(m.date, 'chat', `Чат «${who}»: ${preview(m.text, 60)}`, { id: `chat:${chatId}:${m.id}`, messageId: Number(m.id), direction: 'outgoing', chatId }));
        } else if (kind === 'client') {
          if (onlyMine) continue; // Общий телефон не доказывает автора: чужое сообщение не приписываем мне.
          const phone = phoneOutgoing(m.text);
          if (!phone) continue;
          const owner = shiftOwner(shifts, at);
          const text = `С телефона${phone.author ? ` (${phone.author})` : ''} → «${who}»: ${preview(phone.text, 60)}`;
          if (owner === null) unattributedPhone++;
          else if (typeof owner === 'object') {
            owner.shared.forEach((id) => sharedIds.add(id));
            shared.push(ev(m.date, 'phone', `${text} · на смене: ${owner.shared.map((id) => people.get(id)?.name ?? `#${id}`).join(', ')}`, { chatId }));
          } else push(owner, ev(m.date, 'phone', text, { chatId }));
        }
      }
    }
    // Приложение отправляет сообщение и фиксирует запрос; не считаем его вторым сообщением.
    for (const a of actions) {
      const own = events.get(a.userId ?? 0);
      if (!own) continue;
      // Служебный журнал повтора цепочки (`ChainSendGuard`): отправку уже показывает строка запроса.
      if (a.action === CHAIN_ACTION) continue;
      if (a.action === 'booking.created' && own.some((e) => e.id === `booking:${a.entityId}`)) continue;
      const detail = a.details && typeof a.details === 'object' && !Array.isArray(a.details) ? a.details as Record<string, unknown> : {};
      if (!onlyMine && detail.error) continue;
      const sentChat = a.action === 'request' && typeof detail.route === 'string' && /\/chats\/[^/]+\/send$/.test(detail.route) && !detail.error;
      const chatId = a.entityType === 'chat' ? Number(a.entityId) || null : null;
      if (sentChat) {
        const ids = Array.isArray(detail.messageIds) ? detail.messageIds.map(Number).filter((id) => id > 0) : [];
        if (ids.length && ids.every((id) => own.some((e) => e.chatId === chatId && e.messageId === id))) continue;
        if (!ids.length && own.some((e) => e.kind === 'chat' && e.chatId === chatId && Math.abs(Date.parse(e.at) - a.at.getTime()) < 30_000)) continue;
      }
      push(a.userId, ev(a.at, sentChat ? 'chat' : 'app', a.summary, { id: `audit:${a.id}`, action: a.action, details: a.details, chatId, dealId: a.entityType === 'deal' ? Number(a.entityId) || null : null, ...(sentChat ? { direction: 'outgoing' as const } : {}) }));
    }
    if (actions.length >= 2000) notes.push('Показаны последние 2000 действий приложения выбранного периода.');
    if (chats.length >= MAX_CHATS) notes.push(`Переписка — по ${MAX_CHATS} последним чатам дня.`);
    if (unattributedPhone) notes.push(`Сообщений с телефона без смены: ${unattributedPhone} — никто не начал рабочий день в Битрикс24.`);

    const shiftOf = (id: number) => {
      const s = shiftSpan(shifts, id);
      return s ? { start: new Date(s.start).toISOString(), end: s.end === null ? null : new Date(s.end).toISOString() } : null;
    };
    const employees = ids
      .map((id) => summarize({ userId: id, name: people.get(id)?.name ?? `#${id}`, photo: people.get(id)?.photo ?? null, shift: shiftOf(id) }, events.get(id) ?? [], tz))
      // Сначала на смене и самые активные.
      .sort((a, b) => Number(!!b.shift) - Number(!!a.shift) || b.events.length - a.events.length);
    if (shared.length) {
      const names = [...sharedIds].map((id) => people.get(id)?.name ?? `#${id}`);
      employees.push(summarize({ userId: 0, name: SHARED_NAME, photo: null, shift: null, sharedBy: names }, shared, tz));
      notes.push(`Сообщений с телефона при совпавших сменах: ${shared.length} — смены были открыты одновременно (${names.join(', ')}), приписать одному нельзя.`);
    }
    return { date, timezone: tz, fromHour: FROM_HOUR, toHour: TO_HOUR, employees, unattributedPhone, notes };
  }

  /** Участники групп портала: сотрудники и сотрудники отделов → имена и аватарки. */
  private async employees(user: B24UserContext): Promise<Map<number, { name: string; photo: string | null }>> {
    const members = await this.prisma.workGroupMember.findMany({ where: { group: { portalId: user.portal.id } }, select: { kind: true, bitrixId: true } });
    const userIds = new Set(members.filter((m) => m.kind === 'USER').map((m) => m.bitrixId));
    const depts = [...new Set(members.filter((m) => m.kind === 'DEPARTMENT').map((m) => m.bitrixId))];
    type U = { ID: string; NAME?: string; LAST_NAME?: string; PERSONAL_PHOTO?: string | null };
    const out = new Map<number, { name: string; photo: string | null }>();
    const put = (r: U) => out.set(Number(r.ID), { name: [r.NAME, r.LAST_NAME].filter(Boolean).join(' ') || `#${r.ID}`, photo: photoUrl(r.PERSONAL_PHOTO, user.portal.domain) });
    for (const dept of depts.slice(0, 20)) {
      const rows = await user.client.listAll<U>('user.get', { FILTER: { UF_DEPARTMENT: dept, ACTIVE: true } }).catch(() => []);
      rows.forEach(put);
    }
    const missing = [...userIds].filter((id) => !out.has(id));
    if (missing.length) {
      const rows = await user.client.listAll<U>('user.get', { FILTER: { ID: missing } }).catch(() => []);
      rows.forEach(put);
      for (const id of missing) if (!out.has(id)) out.set(id, { name: `#${id}`, photo: null });
    }
    return out;
  }

  /**
   * Рабочие дни, захватившие этот день, — история учёта времени (`timeman.record.list`, REST 3.0: по
   * одному сотруднику за запрос): начатые в этот день и раньше (до недели), если не закончились до
   * его начала, — незакрытый рабочий день продолжается «до сейчас». Каждая запись — отдельно (между
   * ними сотрудник не на смене). REST 3.0 недоступен — `timeman.status` (последний день сотрудника).
   */
  private async shifts(user: B24UserContext, ids: number[], from: number, to: number, notes: string[] = []): Promise<Shift[]> {
    type Rec = { startTime?: string | null; endTime?: string | null; state?: { status?: string | null } | null };
    // REST 3.0 принимает дату со смещением и без миллисекунд («2026-10-14T21:00:00+00:00»).
    const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}+00:00`;
    try {
      const rows = await Promise.all(
        ids.map(async (id) => {
          const r = await user.client.callV3<{ items?: Rec[] }>('timeman.record.list', {
            // Период — одним `between` (оба конца включительно): конец дня минус секунда.
            filter: [
              ['userId', id],
              ['startTime', 'between', [iso(from - SHIFT_LOOKBACK_MS), iso(to - 1000)]],
            ],
            select: ['id', 'startTime', 'endTime', 'state'],
            order: { startTime: 'ASC' },
            pagination: { page: 1, limit: 50 },
          });
          return { id, items: r?.items ?? [] };
        }),
      );
      const out: Shift[] = [];
      for (const { id, items } of rows)
        for (const i of items) {
          const start = Date.parse(String(i.startTime ?? ''));
          if (!Number.isFinite(start)) continue;
          const e = Date.parse(String(i.endTime ?? ''));
          const end = !Number.isFinite(e) || String(i.state?.status ?? '').toLowerCase() === 'opened' ? null : e;
          // Закончилась до начала дня — не его смена.
          if (end !== null && end <= from) continue;
          out.push({ userId: id, start, end });
        }
      return out;
    } catch (e) {
      notes.push(`История смен недоступна (${e instanceof Bitrix24Error ? e.code : 'ошибка'}) — видна только текущая смена.`);
      return this.lastShifts(user, ids, from, to);
    }
  }

  /** Рабочий день (timeman.status — последний день сотрудника): учитываем, если он начался в этот день. */
  private async lastShifts(user: B24UserContext, ids: number[], from: number, to: number): Promise<Shift[]> {
    const res = await user.client.batch(Object.fromEntries(ids.map((id) => [`u${id}`, { method: 'timeman.status', params: { USER_ID: id } }])));
    const out: Shift[] = [];
    for (const id of ids) {
      const r = res.result[`u${id}`] as { TIME_START?: string | null; TIME_FINISH?: string | null; STATUS?: string } | undefined;
      const s = Date.parse(String(r?.TIME_START ?? ''));
      if (!Number.isFinite(s) || s >= to) continue;
      const e = Date.parse(String(r?.TIME_FINISH ?? ''));
      const end = r?.STATUS === 'OPENED' || !Number.isFinite(e) ? null : e;
      if (end !== null && end <= from) continue;
      out.push({ userId: id, start: s, end });
    }
    return out;
  }

  private async calls(user: B24UserContext, start: Date, end: Date): Promise<Row[]> {
    const rows = await user.client.listAll<Row>('crm.activity.list', {
      // Факт VOXIMPLANT_CALL: COMPLETED=N бывает и у уже завершённых входящих звонков.
      filter: { TYPE_ID: 2, PROVIDER_ID: 'VOXIMPLANT_CALL', '>=START_TIME': start.toISOString(), '<START_TIME': end.toISOString() },
      select: ['ID', 'START_TIME', 'END_TIME', 'SETTINGS', 'RESPONSIBLE_ID', 'DIRECTION', 'OWNER_ID', 'OWNER_TYPE_ID'],
    }, { max: 2000 });
    if (!rows.length) return rows;
    try {
      const stats = await user.client.listAll<{ CRM_ACTIVITY_ID?: string; PORTAL_USER_ID?: string }>('voximplant.statistic.get', { FILTER: { CRM_ACTIVITY_ID: rows.map((r) => Number(r.ID)) }, SORT: 'ID', ORDER: 'DESC' }, { max: 2000 });
      const actual = new Map(stats.filter((r) => Number(r.PORTAL_USER_ID) > 0).map((r) => [Number(r.CRM_ACTIVITY_ID), Number(r.PORTAL_USER_ID)]));
      return rows.map((r) => ({ ...r, RESPONSIBLE_ID: actual.get(Number(r.ID)) ?? r.RESPONSIBLE_ID }));
    } catch { return rows; }
  }

  private deals(user: B24UserContext, start: Date, end: Date): Promise<Row[]> {
    return user.client.listAll<Row>(
      'crm.deal.list',
      { filter: { '>=DATE_CREATE': start.toISOString(), '<DATE_CREATE': end.toISOString() }, select: ['ID', 'TITLE', 'CREATED_BY_ID', 'DATE_CREATE'] },
      { max: 1000 },
    );
  }

  /** История выбранного периода: страницы50, максимум500/чат; недоступный чат пропускаем. */
  private async messages(user: B24UserContext, chatIds: number[], since: Date, notes: string[]): Promise<Map<number, { messages: ImMessage[]; users: ImUser[] }>> {
    const out = new Map<number, { messages: ImMessage[]; users: ImUser[] }>();
    let pending = chatIds.map((id) => ({ id, before: 0 }));
    for (let page = 0; pending.length && page < 10; page++) {
      const res = await user.client.batch(Object.fromEntries(pending.map(({ id, before }) => [`c${id}`, { method: 'im.dialog.messages.get', params: { DIALOG_ID: `chat${id}`, LIMIT: 50, ...(before ? { LAST_ID: before } : {}) } }])));
      const next: typeof pending = [];
      for (const { id, before } of pending) {
        const r = res.result[`c${id}`] as { messages?: ImMessage[]; users?: ImUser[] } | undefined;
        if (!r?.messages?.length) continue;
        const old = out.get(id) ?? { messages: [], users: [] };
        out.set(id, { messages: [...new Map([...old.messages, ...r.messages].map((m) => [m.id, m])).values()], users: [...new Map([...old.users, ...(r.users ?? [])].map((u) => [u.id, u])).values()] });
        const first = Math.min(...r.messages.map((m) => Number(m.id)));
        const earliest = Math.min(...r.messages.map((m) => Date.parse(m.date)));
        if (r.messages.length >= 50 && earliest >= since.getTime() && first > 0 && (!before || first < before)) next.push({ id, before: first });
      }
      pending = next;
    }
    if (pending.length) notes.push('Переписка ограничена 500 сообщениями на чат; сузьте период для более полной истории.');
    return out;
  }
}

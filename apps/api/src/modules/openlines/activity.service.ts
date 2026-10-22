import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { todayIn, zonedDayRange, type ActivityDayDto, type ActivityEventDto } from '@btx24/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { FROM_HOUR, TO_HOUR, isSystemMessage, shiftOwner, summarize, type Shift } from './activity.js';
import { authorKind, phoneOutgoing, preview, type ImMessage, type ImUser } from './chat-parsing.js';

/** Чатов дня, переписку которых смотрим (последние 50 сообщений каждого). */
const MAX_CHATS = 150;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Row = Record<string, unknown>;

/**
 * «Активность сотрудников» за день (решение владельца 2026-10-23, только администраторам приложения).
 * Сотрудники — участники групп (сотрудники и отделы). Смена — timeman. Действия — по Битрикс24:
 * звонки (начало, длительность), сообщения в чатах (свои; с телефона через Wazzup — тому, чья смена),
 * новые сделки (кто создал); по приложению — брони и журнал действий. Боты, системные сообщения и
 * автосообщения приложения (`SystemMessage`) работой сотрудника не считаются.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(private readonly prisma: PrismaService) {}

  async day(user: B24UserContext, query: { date?: unknown }): Promise<ActivityDayDto> {
    const tz = user.portal.timezone;
    if (query.date !== undefined && (typeof query.date !== 'string' || !DATE_RE.test(query.date)))
      throw new BadRequestException({ code: 'INVALID_DATE', message: 'date: YYYY-MM-DD' });
    const date = (query.date as string | undefined) ?? todayIn(tz);
    const { start, end } = zonedDayRange(date, tz);
    const notes: string[] = [];
    const portalId = user.portal.id;

    const people = await this.employees(user);
    const ids = [...people.keys()];
    if (!ids.length) return { date, timezone: tz, fromHour: FROM_HOUR, toHour: TO_HOUR, employees: [], unattributedPhone: 0, notes: ['В группах нет сотрудников.'] };

    const [shifts, calls, deals, chats, marks, bookings, actions] = await Promise.all([
      this.shifts(user, ids, start.getTime(), end.getTime()).catch((e) => {
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
      this.prisma.openlineChat.findMany({ where: { portalId, lastMessageAt: { gte: start } }, orderBy: { lastMessageAt: 'desc' }, take: MAX_CHATS, select: { chatId: true, clientName: true, title: true } }),
      this.prisma.systemMessage.findMany({ where: { portalId, sentAt: { gte: new Date(start.getTime() - 3600_000), lt: new Date(end.getTime() + 3600_000) } } }),
      this.prisma.bookingRecord.findMany({ where: { portalId, createdAt: { gte: start, lt: end }, createdByUserId: { in: ids } }, select: { bookingId: true, dealId: true, createdAt: true, createdByUserId: true } }),
      this.prisma.actionLog.findMany({
        where: { portalId, at: { gte: start, lt: end }, actorKind: 'user', userId: { in: ids }, action: { notIn: ['app.enter', 'app.error', 'bitrix.error', 'request'] } },
        orderBy: { at: 'asc' },
        take: 2000,
        select: { at: true, userId: true, summary: true, entityType: true, entityId: true },
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
      const s = Date.parse(String(c.START_TIME));
      const e = Date.parse(String(c.END_TIME ?? c.START_TIME));
      // Длительность — по началу и концу; больше 3 часов — не разговор (дело не закрыли вовремя).
      const dur = Number.isFinite(e - s) && e > s && e - s < 3 * 3600_000 ? Math.round((e - s) / 1000) : 0;
      const dealId = Number(c.OWNER_TYPE_ID) === 2 ? Number(c.OWNER_ID) || null : null;
      const incoming = String(c.DIRECTION) === '1';
      push(Number(c.RESPONSIBLE_ID), ev(String(c.START_TIME), 'call', `${incoming ? 'Входящий' : 'Исходящий'} звонок${dur ? `, ${Math.ceil(dur / 60)} мин` : ' — без разговора'}`, { durationSec: dur, dealId }));
    }
    for (const d of deals) push(Number(d.CREATED_BY_ID), ev(String(d.DATE_CREATE), 'deal', `Создал сделку «${String(d.TITLE ?? '').slice(0, 80)}»`, { dealId: Number(d.ID) }));
    for (const b of bookings) push(b.createdByUserId, ev(b.createdAt, 'booking', `Создал бронь #${b.bookingId}`, { dealId: b.dealId }));
    for (const a of actions) push(a.userId, ev(a.at, 'app', a.summary.slice(0, 160), { dealId: a.entityType === 'deal' ? Number(a.entityId) || null : null }));

    let unattributedPhone = 0;
    const markList = marks.map((m) => ({ chatId: m.chatId, messageId: m.messageId, userId: m.userId, sentAt: m.sentAt.getTime() }));
    const msgs = await this.messages(user, chats.map((c) => c.chatId)).catch(() => {
      notes.push('Переписка недоступна: нет доступа к чатам открытых линий.');
      return new Map<number, { messages: ImMessage[]; users: ImUser[] }>();
    });
    const chatName = new Map(chats.map((c) => [c.chatId, c.clientName || c.title || `Чат #${c.chatId}`]));
    for (const [chatId, { messages, users }] of msgs) {
      for (const m of messages) {
        const at = Date.parse(m.date);
        if (!(at >= start.getTime() && at < end.getTime())) continue;
        const kind = authorKind(m.author_id, users);
        const who = chatName.get(chatId) ?? `Чат #${chatId}`;
        if (kind === 'employee' && events.has(Number(m.author_id))) {
          if (isSystemMessage(markList, chatId, Number(m.id), Number(m.author_id), at)) continue;
          push(Number(m.author_id), ev(m.date, 'chat', `Чат «${who}»: ${preview(m.text, 60)}`, { chatId }));
        } else if (kind === 'client') {
          const phone = phoneOutgoing(m.text);
          if (!phone) continue;
          const owner = shiftOwner(shifts, at);
          if (owner === null) unattributedPhone++;
          else push(owner, ev(m.date, 'phone', `С телефона${phone.author ? ` (${phone.author})` : ''} → «${who}»: ${preview(phone.text, 60)}`, { chatId }));
        }
      }
    }
    if (chats.length >= MAX_CHATS) notes.push(`Переписка — по ${MAX_CHATS} последним чатам дня.`);
    if (unattributedPhone) notes.push(`Сообщений с телефона без смены: ${unattributedPhone} — никто не начал рабочий день в Битрикс24.`);

    const shiftOf = (id: number) => {
      const s = shifts.find((x) => x.userId === id);
      return s ? { start: new Date(s.start).toISOString(), end: s.end === null ? null : new Date(s.end).toISOString() } : null;
    };
    const employees = ids
      .map((id) => summarize({ userId: id, name: people.get(id) ?? `#${id}`, shift: shiftOf(id) }, events.get(id) ?? [], tz))
      // Сначала на смене и самые активные.
      .sort((a, b) => Number(!!b.shift) - Number(!!a.shift) || b.events.length - a.events.length);
    return { date, timezone: tz, fromHour: FROM_HOUR, toHour: TO_HOUR, employees, unattributedPhone, notes };
  }

  /** Участники групп портала: сотрудники и сотрудники отделов → имена. */
  private async employees(user: B24UserContext): Promise<Map<number, string>> {
    const members = await this.prisma.workGroupMember.findMany({ where: { group: { portalId: user.portal.id } }, select: { kind: true, bitrixId: true } });
    const userIds = new Set(members.filter((m) => m.kind === 'USER').map((m) => m.bitrixId));
    const depts = [...new Set(members.filter((m) => m.kind === 'DEPARTMENT').map((m) => m.bitrixId))];
    const out = new Map<number, string>();
    const name = (r: { ID: string; NAME?: string; LAST_NAME?: string }) => [r.NAME, r.LAST_NAME].filter(Boolean).join(' ') || `#${r.ID}`;
    for (const dept of depts.slice(0, 20)) {
      const rows = await user.client.listAll<{ ID: string; NAME?: string; LAST_NAME?: string }>('user.get', { FILTER: { UF_DEPARTMENT: dept, ACTIVE: true } }).catch(() => []);
      for (const r of rows) out.set(Number(r.ID), name(r));
    }
    const missing = [...userIds].filter((id) => !out.has(id));
    if (missing.length) {
      const rows = await user.client.listAll<{ ID: string; NAME?: string; LAST_NAME?: string }>('user.get', { FILTER: { ID: missing } }).catch(() => []);
      for (const r of rows) out.set(Number(r.ID), name(r));
      for (const id of missing) if (!out.has(id)) out.set(id, `#${id}`);
    }
    return out;
  }

  /** Рабочий день (timeman.status — последний день сотрудника): учитываем, если он начался в этот день. */
  private async shifts(user: B24UserContext, ids: number[], from: number, to: number): Promise<Shift[]> {
    const res = await user.client.batch(Object.fromEntries(ids.map((id) => [`u${id}`, { method: 'timeman.status', params: { USER_ID: id } }])));
    const out: Shift[] = [];
    for (const id of ids) {
      const r = res.result[`u${id}`] as { TIME_START?: string | null; TIME_FINISH?: string | null; STATUS?: string } | undefined;
      const s = Date.parse(String(r?.TIME_START ?? ''));
      if (!Number.isFinite(s) || s < from || s >= to) continue;
      const e = Date.parse(String(r?.TIME_FINISH ?? ''));
      out.push({ userId: id, start: s, end: r?.STATUS === 'OPENED' || !Number.isFinite(e) ? null : e });
    }
    return out;
  }

  private calls(user: B24UserContext, start: Date, end: Date): Promise<Row[]> {
    return user.client.listAll<Row>(
      'crm.activity.list',
      {
        // Звонки телефонии (запланированные дела-звонки — не разговор); не сотрудников групп отсеивает day().
        filter: { TYPE_ID: 2, PROVIDER_ID: 'VOXIMPLANT_CALL', '>=START_TIME': start.toISOString(), '<START_TIME': end.toISOString() },
        select: ['ID', 'START_TIME', 'END_TIME', 'RESPONSIBLE_ID', 'DIRECTION', 'OWNER_ID', 'OWNER_TYPE_ID'],
      },
      { max: 2000 },
    );
  }

  private deals(user: B24UserContext, start: Date, end: Date): Promise<Row[]> {
    return user.client.listAll<Row>(
      'crm.deal.list',
      { filter: { '>=DATE_CREATE': start.toISOString(), '<DATE_CREATE': end.toISOString() }, select: ['ID', 'TITLE', 'CREATED_BY_ID', 'DATE_CREATE'] },
      { max: 1000 },
    );
  }

  /** Последние 50 сообщений каждого чата (пакетами); чат без доступа — пропускаем. */
  private async messages(user: B24UserContext, chatIds: number[]): Promise<Map<number, { messages: ImMessage[]; users: ImUser[] }>> {
    const out = new Map<number, { messages: ImMessage[]; users: ImUser[] }>();
    if (!chatIds.length) return out;
    const res = await user.client.batch(Object.fromEntries(chatIds.map((id) => [`c${id}`, { method: 'im.dialog.messages.get', params: { DIALOG_ID: `chat${id}`, LIMIT: 50 } }])));
    for (const id of chatIds) {
      const r = res.result[`c${id}`] as { messages?: ImMessage[]; users?: ImUser[] } | undefined;
      if (r?.messages) out.set(id, { messages: r.messages, users: r.users ?? [] });
    }
    if (Object.keys(res.errors ?? {}).length) this.logger.debug(`activity: ${Object.keys(res.errors).length} chats without access`);
    return out;
  }
}

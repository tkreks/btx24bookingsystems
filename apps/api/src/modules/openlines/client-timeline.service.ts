import { Injectable } from '@nestjs/common';
import type { ChatSummary, ClientBookingsDto, ClientTimelineDto, ClientTimelineEvent } from '@btx24/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { ChatsService, phoneVariants } from './chats.service.js';
import { callDurationSec, callStatus, type CallActivity } from './call-stats.js';

const LIMIT = 200;
type Deal = { ID: string; TITLE?: string; DATE_CREATE?: string; DATE_MODIFY?: string; CLOSEDATE?: string; STAGE_SEMANTIC_ID?: string; CREATED_BY_ID?: string };
type Activity = CallActivity & { TYPE_ID?: string; SUBJECT?: string; CREATED?: string; PROVIDER_ID?: string; DESCRIPTION?: string; AUTHOR_ID?: string };
type Invoice = { id: number; parentId2?: number; title?: string; stageId?: string; opportunity?: number; currencyId?: string; createdTime?: string; movedTime?: string; createdBy?: number; movedBy?: number };

/** Лента только по данным, доступным сотруднику; журнал БД ограничен прочитанными в CRM сделками. */
@Injectable()
export class ClientTimelineService {
  constructor(private readonly prisma: PrismaService, private readonly chats: ChatsService) {}

  async get(user: B24UserContext, contactId: number | null, client: ClientBookingsDto | null, chats: ChatSummary[]): Promise<ClientTimelineDto> {
    const notes: string[] = [];
    const events: ClientTimelineEvent[] = [];
    const read = async <T>(label: string, action: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await action(); } catch { notes.push(`${label}: данные недоступны.`); return fallback; }
    };
    const add = (e: ClientTimelineEvent) => { if (Number.isFinite(Date.parse(e.at))) events.push(e); };
    const deals = contactId
      ? await read('Сделки', () => user.client.listAll<Deal>('crm.deal.list', {
        filter: { CONTACT_ID: contactId }, select: ['ID', 'TITLE', 'DATE_CREATE', 'DATE_MODIFY', 'CLOSEDATE', 'STAGE_SEMANTIC_ID', 'CREATED_BY_ID'], order: { ID: 'DESC' },
      }, { max: LIMIT }), [])
      : [];
    const dealIds = [...new Set([...deals.map((d) => Number(d.ID)), ...(client?.openDeals.map((d) => d.id) ?? [])])].filter((n) => Number.isSafeInteger(n) && n > 0);
    if (deals.length >= LIMIT) notes.push(`Учтены последние ${LIMIT} сделок клиента.`);
    for (const d of deals) {
      add({ id: `deal:${d.ID}:created`, at: d.DATE_CREATE ?? '', kind: 'deal', title: 'Создана сделка', actorId: Number(d.CREATED_BY_ID) || undefined, text: d.TITLE ?? `Сделка #${d.ID}`, dealId: Number(d.ID) });
      if (d.STAGE_SEMANTIC_ID === 'S' || d.STAGE_SEMANTIC_ID === 'F')
        add({ id: `deal:${d.ID}:closed`, at: d.CLOSEDATE ?? '', kind: 'deal', title: d.STAGE_SEMANTIC_ID === 'S' ? 'Сделка завершена' : 'Сделка проиграна', text: d.TITLE ?? `Сделка #${d.ID}`, dealId: Number(d.ID) });
    }
    const activityQuery = (filter: Record<string, unknown>) => read('Звонки и дела CRM', () => user.client.listAll<Activity>('crm.activity.list', {
      filter, select: ['ID', 'TYPE_ID', 'OWNER_ID', 'OWNER_TYPE_ID', 'SUBJECT', 'CREATED', 'START_TIME', 'END_TIME', 'DIRECTION', 'PROVIDER_ID', 'SETTINGS', 'RESPONSIBLE_ID', 'AUTHOR_ID'], order: { ID: 'DESC' },
    }, { max: 100 }), []);
    const [contactActivities, dealActivities, invoices, records, histories, phoneCalls] = await Promise.all([
      contactId ? activityQuery({ OWNER_TYPE_ID: 3, OWNER_ID: contactId }) : [],
      dealIds.length ? activityQuery({ OWNER_TYPE_ID: 2, '@OWNER_ID': dealIds }) : [],
      dealIds.length ? read('Счета и оплаты', () => user.client.listAll<Invoice>('crm.item.list', {
        entityTypeId: 31, filter: { '@parentId2': dealIds }, select: ['id', 'parentId2', 'title', 'stageId', 'opportunity', 'currencyId', 'createdTime', 'movedTime', 'createdBy', 'movedBy'], order: { id: 'desc' },
      }, { max: LIMIT, pick: (r) => (r as { items?: Invoice[] })?.items ?? [] }), []) : [],
      dealIds.length ? read('Журнал броней', () => this.prisma.bookingRecord.findMany({
        where: { portalId: user.portal.id, dealId: { in: dealIds } }, orderBy: { createdAt: 'desc' }, take: LIMIT,
        select: { bookingId: true, dealId: true, title: true, createdAt: true, cancelledAt: true, startsAt: true, endsAt: true, createdByUserId: true, cancelledByUserId: true },
      }), []) : [],
      Promise.all(chats.slice(0, 5).map((c) => read('Переписка', () => this.chats.history(user, c.chatId, {}, false), null))),
      contactId ? read('Звонки телефонии', () => this.phoneCalls(user, contactId), []) : [],
    ]);
    if (contactActivities.length >= 100 || dealActivities.length >= 100) notes.push('Показаны последние 100 дел по контакту и 100 по его сделкам.');
    if (invoices.length >= LIMIT) notes.push(`Показаны последние ${LIMIT} счетов.`);
    const unique = new Map([...contactActivities, ...dealActivities].map((a) => [a.ID, a]));
    for (const a of unique.values()) {
      if (Number(a.OWNER_TYPE_ID) === 2 ? !dealIds.includes(Number(a.OWNER_ID)) : Number(a.OWNER_TYPE_ID) !== 3 || Number(a.OWNER_ID) !== contactId) continue;
      const isCall = a.PROVIDER_ID === 'VOXIMPLANT_CALL' || String(a.TYPE_ID) === '2';
      const direction = String(a.DIRECTION) === '1' ? 'Входящий звонок' : 'Исходящий звонок';
      const status = callStatus(a);
      add({ id: `activity:${a.ID}`, ...(isCall ? { direction: String(a.DIRECTION) === '1' ? 'incoming' as const : 'outgoing' as const } : {}), actorId: Number(a.AUTHOR_ID) || undefined, at: (isCall ? a.START_TIME : a.CREATED) || a.START_TIME || '', kind: isCall ? 'call' : 'activity',
        title: isCall ? `${direction}${status === 'missed' ? ' · пропущен' : status === 'no_answer' ? ' · нет ответа' : ''}` : a.SUBJECT || 'Дело CRM',
        text: isCall ? `${callDurationSec(a)} сек.` : null,
        ...(Number(a.OWNER_TYPE_ID) === 2 ? { dealId: Number(a.OWNER_ID) } : {}),
      });
    }
    for (const inv of invoices) {
      // Даже при ошибке фильтра на стороне API не включаем постороннюю сделку.
      if (!dealIds.includes(Number(inv.parentId2))) continue;
      const data = { kind: 'invoice' as const, dealId: Number(inv.parentId2), text: inv.title ?? `Счёт #${inv.id}`, amount: Number(inv.opportunity ?? 0), currency: inv.currencyId ?? 'RUB' };
      add({ ...data, id: `invoice:${inv.id}`, at: inv.createdTime ?? '', actorId: Number(inv.createdBy) || undefined, title: `Выставлен счёт #${inv.id}` });
      if (String(inv.stageId).endsWith(':P')) add({ ...data, id: `invoice:${inv.id}:paid`, kind: 'payment', at: inv.movedTime ?? '', actorId: Number(inv.movedBy) || undefined, title: `Оплачен счёт #${inv.id}` });
    }
    const seen = new Set<number>();
    for (const b of records) {
      seen.add(b.bookingId);
      add({ id: `booking:${b.bookingId}:created`, at: b.createdAt.toISOString(), actorId: b.createdByUserId ?? undefined, actorName: b.createdByUserId ? undefined : 'Битрикс24', kind: 'booking', title: `Создана бронь #${b.bookingId}`, text: b.title, ...(b.dealId ? { dealId: b.dealId } : {}) });
      if (b.cancelledAt) add({ id: `booking:${b.bookingId}:cancelled`, at: b.cancelledAt.toISOString(), actorId: b.cancelledByUserId ?? undefined, actorName: b.cancelledByUserId ? undefined : 'Система', kind: 'booking', title: `Отменена бронь #${b.bookingId}`, text: b.title, ...(b.dealId ? { dealId: b.dealId } : {}) });
    }
    for (const b of [...(client?.upcoming ?? []), ...(client?.history ?? client?.recent ?? [])]) {
      if (b.bookingId && seen.has(b.bookingId)) continue;
      add({ id: `booking:${b.bookingId ?? b.dealId}:visit:${b.start}`, at: b.start, kind: 'booking', title: b.when === 'past' ? 'Прошедшая бронь' : 'Бронирование', text: b.resources.join(', ') || null, ...(b.dealId ? { dealId: b.dealId } : {}) });
    }
    for (const h of histories) for (const m of h?.messages ?? []) {
      add({ id: `chat:${h!.chatId}:${m.id}`, at: m.date, kind: 'message', title: m.author.kind === 'client' ? 'Сообщение клиента' : `Сообщение · ${m.author.name || 'сотрудник'}`, text: m.text || (m.files.length ? '📎 Вложение' : null), chatId: h!.chatId, messageId: m.id, direction: m.viaPhone || m.author.kind !== 'client' ? 'outgoing' : 'incoming', actorName: m.author.name || (m.author.kind === 'client' ? client?.contact?.name || 'Клиент' : undefined), actorId: m.author.kind === 'employee' && m.author.id > 0 ? m.author.id : undefined });
    }
    if (chats.length) notes.push('Переписка: последние сообщения из пяти последних доступных чатов.');
    phoneCalls.forEach(add);
    const sorted = [...new Map(events.map((e) => [e.id, e])).values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    if (sorted.length > LIMIT) notes.push(`Показаны последние ${LIMIT} событий.`);
    return { events: await this.withAuthors(user, sorted.slice(0, LIMIT)).then((rows) => rows.map((e) => ({ ...e, at: new Date(e.at).toISOString() }))), notes: [...new Set(notes)] };
  }

  private async withAuthors(user: B24UserContext, events: ClientTimelineEvent[]): Promise<ClientTimelineEvent[]> {
    const ids = [...new Set(events.filter((e) => !e.actorName).map((e) => e.actorId).filter((n): n is number => !!n && n > 0))];
    const people = ids.length ? await user.client.listAll<{ ID: string; NAME?: string; LAST_NAME?: string }>('user.get', { FILTER: { ID: ids } }, { max: 200 }).catch(() => []) : [];
    const names = new Map(people.map((p) => [Number(p.ID), [p.NAME, p.LAST_NAME].filter(Boolean).join(' ')]));
    return events.map((e) => ({ ...e, actorName: e.actorName || (e.actorId ? names.get(e.actorId) || `Сотрудник #${e.actorId}` : 'Автор не указан') }));
  }

  /** Телефония бывает привязана к заказу (тип 14), а контакт указан только в коммуникациях.
   * Номер берём из CRM-контакта правами сотрудника. Наличие в локальном журнале не даёт доступа
   * к чужому звонку: завершённые с crmActivityId повторно проверяем crm.activity.list его токеном.
   */
  private async phoneCalls(user: B24UserContext, contactId: number): Promise<ClientTimelineEvent[]> {
    const c = await user.client.call<{ PHONE?: { VALUE?: string }[] }>('crm.contact.get', { id: contactId });
    const phones = [...new Set((c.result?.PHONE ?? []).flatMap((p) => phoneVariants(p.VALUE ?? '')))];
    if (!phones.length) return [];
    const rows = await this.prisma.telephonyCall.findMany({
      where: { portalId: user.portal.id, phone: { in: phones } }, orderBy: { startedAt: 'desc' }, take: 100,
      select: { callId: true, crmActivityId: true, callType: true, userId: true, startedAt: true, answeredAt: true, endedAt: true },
    });
    const ids = rows.map((r) => r.crmActivityId).filter((n): n is number => !!n);
    const visible = new Set(ids.length ? (await user.client.listAll<{ ID: string }>('crm.activity.list', { filter: { '@ID': ids }, select: ['ID'] }, { max: 100 })).map((r) => Number(r.ID)) : []);
    return rows.filter((r) => r.crmActivityId ? visible.has(r.crmActivityId) : r.userId === user.userId).map((r) => ({
      id: r.crmActivityId ? `activity:${r.crmActivityId}` : `phone:${r.callId}`,
      at: r.startedAt.toISOString(), direction: r.callType === 1 ? 'outgoing' : 'incoming', actorId: r.userId ?? undefined, kind: 'call',
      title: `${r.callType === 1 ? 'Исходящий' : 'Входящий'} звонок${!r.endedAt ? ' · сейчас' : !r.answeredAt ? ' · без ответа' : ''}`,
      text: r.endedAt && r.answeredAt ? `${Math.max(0, Math.round((r.endedAt.getTime() - r.answeredAt.getTime()) / 1000))} сек.` : null,
    }));
  }

}

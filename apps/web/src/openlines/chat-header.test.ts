import { describe, expect, it } from 'vitest';
import type { ChatSummary, ClientBookingsDto, MessengerDto } from '@btx24/shared';
import { clipTitle, dealDate } from './ChatDealCard.js';
import { asAttention } from './ChannelSwitch.js';
import { dealBookingStart, deadReason, isDeadChat } from '../deal/DealHome.js';
import { kindsOf } from '../deal/DealChatStart.js';

const tz = 'Europe/Moscow';

describe('сделка в шапке чата', () => {
  it('название — не длиннее 15 символов', () => {
    expect(clipTitle('Баня')).toBe('Баня');
    expect(clipTitle('Аренда домика на выходные')).toBe('Аренда домика н…');
  });
  it('дата брони, без брони — дата создания сделки', () => {
    expect(dealDate({ booking: { start: '2026-10-30T12:00:00Z', end: '2026-10-30T15:00:00Z', resources: [] }, createdAt: '2026-10-01T10:00:00Z' }, tz)).toBe('бронь 30.10.2026');
    expect(dealDate({ booking: null, createdAt: '2026-10-01T10:00:00Z' }, tz)).toBe('от 01.10.2026');
    expect(dealDate({ booking: null, createdAt: null }, tz)).toBeNull();
  });
});

describe('окно «Чаты клиента»', () => {
  it('чат клиента — строкой «Последних сообщений» со сделкой', () => {
    expect(asAttention({ chatId: 5, connector: 'btx24_whatsapp', title: 'Иван', lastMessageAt: '2026-10-26T10:00:00Z', waitingReply: true, preview: 'Здравствуйте', unread: 2, dealId: 9, clientAvatar: 'https://x/a.jpg', clientName: 'Иван Петров' })).toMatchObject({ chatId: 5, unread: 2, preview: 'Здравствуйте', dealId: 9, clientName: 'Иван Петров', clientAvatar: 'https://x/a.jpg' });
    expect(asAttention({ chatId: 6, connector: 'wz_telegram', title: 'Чат', lastMessageAt: null, waitingReply: false })).toMatchObject({ unread: 0, preview: '', dealId: null, lastMessageAt: '' });
  });
});

describe('встройка сделки: ошибка канала Wazzup', () => {
  const chat = (chatId: number, connector: string, preview: string) => ({ chatId, connector, lastMessage: { preview } }) as unknown as ChatSummary;
  it('«канал выключен» от Wazzup — чат неработающий, причина для «Присоединиться к чату»', () => {
    expect(deadReason(chat(2, 'wz_whatsapp', '=== SYSTEM WZ === Ошибка отправки сообщения: канал выключен'))).toBe('канал Wazzup выключен');
    expect(deadReason(chat(1, 'wz_whatsapp', 'Спасибо'))).toBeNull();
    expect(deadReason(undefined)).toBeNull();
  });
  it('чат в неработающей линии (по проверке линии) — причина из проверки', () => {
    const dead = { ...chat(3, 'wz_telegram', 'Спасибо'), lineProblem: 'канал линии «Wazzup» не подключён' } as ChatSummary;
    expect(isDeadChat(dead)).toBe(true);
    expect(isDeadChat(chat(4, 'btx24_telegram', 'Привет'))).toBe(false);
    expect(deadReason(dead)).toBe('канал линии «Wazzup» не подключён');
  });
});

describe('встройка сделки: шкала на брони сделки', () => {
  const b = (dealId: number, start: string) => ({ bookingId: 1, dealId, deal: null, start, end: start, resources: [], resourceIds: [], when: 'future' as const });
  const info = (over: Partial<ClientBookingsDto>) => ({ contactId: 1, contact: null, won: { count: 0, avgCheck: null, currency: null }, past: 0, upcoming: [], recent: [], openDeals: [], ...over }) as ClientBookingsDto;
  it('текущая/будущая бронь сделки, иначе по сделке, иначе последняя прошедшая', () => {
    expect(dealBookingStart(info({ upcoming: [b(5, '2026-11-01T10:00:00Z'), b(7, '2026-11-02T10:00:00Z')] }), 7)).toBe('2026-11-02T10:00:00Z');
    expect(dealBookingStart(info({ openDeals: [{ id: 7, title: 'x', categoryId: null, booking: { start: '2026-11-03T10:00:00Z', end: '2026-11-03T12:00:00Z', resources: [] } }] }), 7)).toBe('2026-11-03T10:00:00Z');
    expect(dealBookingStart(info({ recent: [b(7, '2026-10-01T10:00:00Z')] }), 7)).toBe('2026-10-01T10:00:00Z');
    expect(dealBookingStart(info({ upcoming: [b(5, '2026-11-01T10:00:00Z')] }), 7)).toBeNull();
    expect(dealBookingStart(null, 7)).toBeNull();
  });
});

describe('встройка сделки: поиск клиента в мессенджерах', () => {
  const t = (id: string, kind: 'whatsapp' | 'telegram', status: 'found' | 'not_found' | 'unavailable') => ({ messenger: { id, kind, phone: '7999' } as MessengerDto, status, to: status === 'found' ? 'x@c.us' : null, via: null, openlineChatId: null, note: null });
  it('мессенджер — найден, если хотя бы в одном номере; номера найденного — для выбора', () => {
    const rows = kindsOf([t('a', 'whatsapp', 'found'), t('b', 'whatsapp', 'found'), t('c', 'telegram', 'not_found')]);
    expect(rows.map((r) => [r.kind, r.found.length, r.note])).toEqual([['whatsapp', 2, null], ['telegram', 0, 'Клиент не найден']]);
    expect(kindsOf([t('d', 'telegram', 'unavailable')])[0].note).toBe('Проверка недоступна');
  });
});

describe('встройка сделки: строка чата', () => {
  it('сводка чата — строка «Последних сообщений» с «!» и сделкой', async () => {
    const { chatRow } = await import('../deal/DealHome.js');
    const s = { chatId: 3, unread: 1, title: 'Чат', clientName: 'Анна', clientAvatar: null, connector: 'btx24_telegram', responsibleId: 5, lastMessage: { id: 1, date: '2026-10-26T09:00:00Z', author: 'client', preview: 'Есть баня?', hasFiles: false }, crm: { leadId: null, contactId: 140, companyId: null, dealId: 77 }, flag: { byName: 'Ира', at: '2026-10-26T09:01:00Z' } } as unknown as ChatSummary;
    expect(chatRow(s)).toMatchObject({ chatId: 3, unread: 1, preview: 'Есть баня?', dealId: 77, contactId: 140, flag: { byName: 'Ира' } });
  });
});

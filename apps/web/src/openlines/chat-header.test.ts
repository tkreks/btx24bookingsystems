import { describe, expect, it } from 'vitest';
import type { ChatSummary } from '@btx24/shared';
import { clipTitle, dealDate } from './ChatDealCard.js';
import { asAttention } from './ChannelSwitch.js';
import { brokenChat } from '../deal/DealHome.js';

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
  it('находит чат с «канал выключен», иначе шага нет', () => {
    expect(brokenChat([chat(1, 'btx24_telegram', 'Привет'), chat(2, 'wz_whatsapp', '=== SYSTEM WZ === Ошибка отправки сообщения: канал выключен')])?.chatId).toBe(2);
    expect(brokenChat([chat(1, 'wz_whatsapp', 'Спасибо')])).toBeNull();
  });
});

describe('встройка сделки: строка чата', () => {
  it('сводка чата — строка «Последних сообщений» с «!» и сделкой', async () => {
    const { chatRow } = await import('../deal/DealHome.js');
    const s = { chatId: 3, unread: 1, title: 'Чат', clientName: 'Анна', clientAvatar: null, connector: 'btx24_telegram', responsibleId: 5, lastMessage: { id: 1, date: '2026-10-26T09:00:00Z', author: 'client', preview: 'Есть баня?', hasFiles: false }, crm: { leadId: null, contactId: 140, companyId: null, dealId: 77 }, flag: { byName: 'Ира', at: '2026-10-26T09:01:00Z' } } as unknown as ChatSummary;
    expect(chatRow(s)).toMatchObject({ chatId: 3, unread: 1, preview: 'Есть баня?', dealId: 77, contactId: 140, flag: { byName: 'Ира' } });
  });
});

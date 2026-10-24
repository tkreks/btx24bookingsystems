import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { ClientBookingsService } from '../bookings/client-bookings.service.js';
import type { ClientTimelineService } from './client-timeline.service.js';
import { CallCardService } from './call-card.service.js';
import type { ChatsService } from './chats.service.js';

const user = (client: unknown) => ({ portal: { id: 'p1', timezone: 'Europe/Moscow' }, userId: 236, client }) as unknown as B24UserContext;
const msg = (id: number) => ({ id, date: `2026-10-23T1${id}:00:00Z`, author: { id: 1, name: 'Клиент', kind: 'client' }, text: `т${id}`, files: [] });

function setup(openDeals: { id: number; createdAt: string }[]) {
  const prisma = {
    telephonyCall: {
      findUnique: vi.fn(async () => ({ phone: '+79001234567' })),
      findMany: vi.fn(async () => [{ callId: 'c1', phone: '+79001234567', callType: 2, answeredAt: new Date('2026-10-23T10:00:00Z') }]),
    },
  } as unknown as PrismaService;
  const access = { resolve: vi.fn(async () => ({ isAppAdmin: false, groups: [{ permissions: ['openlines.read'] }] })) } as unknown as AccessService;
  const chats = {
    summariesByChat: vi.fn(async () => [{ chatId: 5, title: 'Чат', clientName: 'Иван', lastMessage: { date: '2026-10-23T09:00:00Z' } }]),
    searchByPhone: vi.fn(async () => ({ items: [{ chatId: 5, title: 'Чат', clientName: 'Иван', lastMessage: { date: '2026-10-23T09:00:00Z' } }] })),
    history: vi.fn(async () => ({ messages: [1, 2, 3, 4, 5, 6, 7, 8].map(msg) })),
  } as unknown as ChatsService;
  const clients = {
    forContact: vi.fn(async (_u: unknown, contactId: number | null) => ({ contactId, contact: { id: contactId, name: 'Иван' }, openDeals, upcoming: [], recent: [], won: { count: 0, avgCheck: null, currency: null }, past: 0 })),
  } as unknown as ClientBookingsService;
  return { svc: new CallCardService(prisma, access, chats, clients, { get: vi.fn(async () => ({ events: [], notes: [] })) } as unknown as ClientTimelineService), clients, chats, access };
}

describe('CallCardService', () => {
  it('по номеру звонка — контакт, самая новая открытая сделка, последние 6 сообщений свежего чата', async () => {
    const t = setup([{ id: 10, createdAt: '2026-09-01T00:00:00Z' }, { id: 12, createdAt: '2026-10-20T00:00:00Z' }]);
    const client = { call: vi.fn(async (m: string) => (m === 'crm.duplicate.findbycomm' ? { result: { CONTACT: [140] } } : { result: {} })) };
    const card = await t.svc.card(user(client), { callId: 'c1' });
    expect(card).toMatchObject({ phone: '+79001234567', contact: { id: 140 }, suggestedDealId: 12, messages: { chatId: 5, title: 'Иван' } });
    expect(card.messages!.items.map((m) => m.id)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('звонок привязан к сделке (новая сделка звонка) — она и предлагается; текущие звонки — по сотруднику', async () => {
    const t = setup([{ id: 12, createdAt: '2026-10-20T00:00:00Z' }, { id: 15, createdAt: '2026-10-01T00:00:00Z' }]);
    const client = { call: vi.fn(async (m: string) => (m === 'crm.deal.get' ? { result: { CONTACT_ID: '140' } } : { result: {} })) };
    const card = await t.svc.card(user(client), { phone: '+79001234567', entityType: 'DEAL', entityId: '15' });
    expect(card.suggestedDealId).toBe(15);
    expect(t.clients.forContact).toHaveBeenCalledWith(expect.anything(), 140, [15], expect.any(Date), true);
    expect(await t.svc.active(user(client))).toEqual([{ callId: 'c1', phone: '+79001234567', callType: 2, answeredAt: '2026-10-23T10:00:00.000Z' }]);
  });
});

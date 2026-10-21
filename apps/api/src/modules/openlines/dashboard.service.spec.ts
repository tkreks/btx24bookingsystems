import { DashboardService, parsePeriod } from './dashboard.service.js';
import type { ChatsService } from './chats.service.js';
import type { BookingJournalService } from '../bookings/booking-journal.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

const emptyJournal = {
  forManager: vi.fn(async () => ({ created: 0, createdClient: [], cancelled: [] })),
} as unknown as BookingJournalService;

describe('DashboardService', () => {
  const now = new Date('2026-10-21T10:00:00Z');
  it('period is whole portal days [from, to], default today', () => {
    const today = parsePeriod('Europe/Moscow', {}, now);
    expect(today).toMatchObject({ from: '2026-10-21', to: '2026-10-21' });
    expect(today.start.toISOString()).toBe('2026-10-20T21:00:00.000Z');
    expect(today.end.toISOString()).toBe('2026-10-21T21:00:00.000Z');
    const week = parsePeriod('Europe/Moscow', { from: '2026-10-15', to: '2026-10-21' }, now);
    expect(week.start.toISOString()).toBe('2026-10-14T21:00:00.000Z');
    expect(week.end.toISOString()).toBe('2026-10-21T21:00:00.000Z');
  });

  it('rejects malformed, reversed and too long periods', () => {
    expect(() => parsePeriod('Europe/Moscow', { from: 'week' })).toThrow();
    expect(() => parsePeriod('Europe/Moscow', { from: '2026-10-21', to: '2026-10-20' })).toThrow();
    expect(() => parsePeriod('Europe/Moscow', { from: '2026-01-01', to: '2026-10-21' })).toThrow();
    expect(() => parsePeriod('Europe/Moscow', { from: '2026-07-22', to: '2026-10-21' })).not.toThrow();
  });

  it('counts waiting chats, unread messages and unique CRM items of own sessions', async () => {
    const chats = {
      list: vi.fn(async () => ({
        items: [{ waitingReply: true }, { waitingReply: false }, { waitingReply: true }],
        nextOffset: null,
      })),
    } as unknown as ChatsService;
    const call = vi.fn(async () => ({ result: { items: [{ counter: 3 }, { counter: 54 }, {}] } }));
    const listAll = vi.fn(async (_method: string, _params?: unknown) => [
      { OWNER_TYPE_ID: '1', OWNER_ID: '5' },
      { OWNER_TYPE_ID: '1', OWNER_ID: '5' },
      { OWNER_TYPE_ID: '3', OWNER_ID: '140' },
      { OWNER_TYPE_ID: '2', OWNER_ID: '678' },
      { OWNER_TYPE_ID: '14', OWNER_ID: '1' },
    ]);
    const user = {
      portal: { id: 'p1', timezone: 'Europe/Moscow' },
      userId: 7,
      client: { call, listAll },
    } as unknown as B24UserContext;
    const d = await new DashboardService(chats, emptyJournal).get(user, { from: '2026-10-15', to: '2026-10-21' }, true);
    expect(d).toMatchObject({
      from: '2026-10-15',
      to: '2026-10-21',
      chats: { waitingReply: 2, unreadMessages: 57 },
      contacts: { leads: 1, contacts: 1, deals: 1, companies: 0 },
      bookings: { created: 0, cancelled: 0, deals: [], cancelledList: [] },
    });
    expect(listAll.mock.calls[0][1]).toMatchObject({
      filter: {
        RESPONSIBLE_ID: 7,
        PROVIDER_ID: 'IMOPENLINES_SESSION',
        '>=LAST_UPDATED': '2026-10-14T21:00:00.000Z',
        '<LAST_UPDATED': '2026-10-21T21:00:00.000Z',
      },
    });
  });

  it('lists own bookings with deal and resource names; inaccessible deal → null', async () => {
    const rec = (over: object) => ({
      bookingId: 1,
      kind: 'client',
      dealId: 678,
      resourceIds: [10, 11],
      startsAt: new Date('2020-05-01T10:00:00Z'),
      endsAt: new Date('2020-05-01T12:00:00Z'),
      status: 'active',
      cancelReason: null,
      createdAt: new Date('2026-10-21T08:00:00Z'),
      cancelledAt: null,
      ...over,
    });
    const journal = {
      forManager: vi.fn(async () => ({
        created: 2,
        createdClient: [rec({})],
        cancelled: [
          rec({
            bookingId: 2,
            dealId: 999,
            status: 'cancelled',
            cancelReason: 'payment_timeout',
            cancelledAt: new Date('2026-10-21T09:00:00Z'),
          }),
        ],
      })),
    } as unknown as BookingJournalService;
    const listAll = vi.fn(async (method: string, _params?: unknown) =>
      method === 'crm.deal.list'
        ? [{ ID: '678', TITLE: 'Баня', OPPORTUNITY: '5000.00', CURRENCY_ID: 'RUB' }]
        : [{ id: 10, name: 'Баня 1' }],
    );
    const user = {
      portal: { id: 'p1', timezone: 'Europe/Moscow' },
      userId: 7,
      client: { call: vi.fn(), listAll },
    } as unknown as B24UserContext;
    const d = await new DashboardService({} as ChatsService, journal).get(user, {}, false);
    expect(journal.forManager).toHaveBeenCalledWith('p1', 7, expect.any(Date), expect.any(Date));
    expect(d.bookings).toMatchObject({
      created: 2,
      cancelled: 1,
      deals: [{ bookingId: 1, deal: { title: 'Баня', opportunity: 5000 }, resources: ['Баня 1', 'Ресурс 11'] }],
      cancelledList: [{ bookingId: 2, deal: null, cancelReason: 'payment_timeout' }],
    });
    expect(listAll.mock.calls.find((c) => c[0] === 'crm.deal.list')?.[1]).toMatchObject({
      filter: { '@ID': [678, 999] },
    });
  });

  it('without open lines rights returns no chat data and makes no REST calls', async () => {
    const call = vi.fn();
    const user = {
      portal: { id: 'p1', timezone: 'Europe/Moscow' },
      userId: 7,
      client: { call, listAll: call },
    } as unknown as B24UserContext;
    const d = await new DashboardService({} as ChatsService, emptyJournal).get(user, {}, false);
    expect(d).toMatchObject({ chats: null, contacts: null, bookings: { created: 0 } });
    expect(call).not.toHaveBeenCalled();
    await expect(new DashboardService({} as ChatsService, emptyJournal).get(user, { from: 'x' }, false)).rejects.toMatchObject({
      status: 400,
    });
  });
});

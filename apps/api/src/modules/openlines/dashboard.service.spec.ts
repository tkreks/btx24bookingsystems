import { DashboardService, periodStart } from './dashboard.service.js';
import type { ChatsService } from './chats.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

describe('DashboardService', () => {
  const now = new Date('2026-10-21T10:00:00Z');
  it('period starts at portal midnight', () => {
    expect(periodStart('Europe/Moscow', 1, now).toISOString()).toBe('2026-10-20T21:00:00.000Z');
    expect(periodStart('Europe/Moscow', 7, now).toISOString()).toBe('2026-10-14T21:00:00.000Z');
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
      portal: { timezone: 'Europe/Moscow' },
      userId: 7,
      client: { call, listAll },
    } as unknown as B24UserContext;
    const d = await new DashboardService(chats).get(user, '7d', true);
    expect(d).toMatchObject({
      period: '7d',
      chats: { waitingReply: 2, unreadMessages: 57 },
      contacts: { leads: 1, contacts: 1, deals: 1, companies: 0 },
      bookings: { created: null, cancelled: null },
    });
    expect(listAll.mock.calls[0][1]).toMatchObject({
      filter: { RESPONSIBLE_ID: 7, PROVIDER_ID: 'IMOPENLINES_SESSION' },
    });
  });

  it('without open lines rights returns no chat data and makes no REST calls', async () => {
    const call = vi.fn();
    const user = {
      portal: { timezone: 'Europe/Moscow' },
      userId: 7,
      client: { call, listAll: call },
    } as unknown as B24UserContext;
    const d = await new DashboardService({} as ChatsService).get(user, undefined, false);
    expect(d).toMatchObject({ period: 'today', chats: null, contacts: null });
    expect(call).not.toHaveBeenCalled();
    await expect(new DashboardService({} as ChatsService).get(user, 'year', false)).rejects.toMatchObject({
      status: 400,
    });
  });
});

import { DashboardService, parsePeriod } from './dashboard.service.js';
import type { ChatsService } from './chats.service.js';
import type { BookingJournalService } from '../bookings/booking-journal.service.js';
import type { DealFieldMapService } from '../bookings/deal-field-map.service.js';
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
    const listAll = vi.fn(async (_method: string, params?: { filter?: { PROVIDER_ID?: string } }) => params?.filter?.PROVIDER_ID !== 'IMOPENLINES_SESSION' ? [] : [
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
    expect(listAll.mock.calls.find((c) => (c[1] as { filter: { PROVIDER_ID: string } }).filter.PROVIDER_ID === 'IMOPENLINES_SESSION')?.[1]).toMatchObject({
      filter: {
        RESPONSIBLE_ID: 7,
        PROVIDER_ID: 'IMOPENLINES_SESSION',
        '>=LAST_UPDATED': '2026-10-14T21:00:00.000Z',
        '<LAST_UPDATED': '2026-10-21T21:00:00.000Z',
      },
    });
  });

  it('calls by client: new vs repeat by won deals in the chosen funnel before the first call', async () => {
    const comm = (phone: string, contact: number) => [{ VALUE: phone, ENTITY_TYPE_ID: '3', ENTITY_ID: String(contact) }];
    const calls = [
      // контакт 140: три входящих (один пропущен) и два исходящих — один клиент, повторный
      { ID: '1', OWNER_TYPE_ID: '2', OWNER_ID: '678', DIRECTION: '1', START_TIME: '2026-10-21T08:00:00Z', RESPONSIBLE_ID: '7', SETTINGS: { MISSED_CALL: true }, COMMUNICATIONS: comm('+79851234567', 140) },
      { ID: '2', OWNER_TYPE_ID: '2', OWNER_ID: '678', DIRECTION: '2', START_TIME: '2026-10-21T08:10:00Z', RESPONSIBLE_ID: '7', SETTINGS: [], COMMUNICATIONS: comm('+79851234567', 140) },
      { ID: '3', OWNER_TYPE_ID: '2', OWNER_ID: '678', DIRECTION: '1', START_TIME: '2026-10-21T09:00:00Z', RESPONSIBLE_ID: '7', SETTINGS: [], COMMUNICATIONS: comm('+79851234567', 140) },
      { ID: '4', OWNER_TYPE_ID: '2', OWNER_ID: '678', DIRECTION: '1', START_TIME: '2026-10-21T09:30:00Z', RESPONSIBLE_ID: '7', SETTINGS: [], COMMUNICATIONS: comm('+79851234567', 140) },
      { ID: '5', OWNER_TYPE_ID: '2', OWNER_ID: '678', DIRECTION: '2', START_TIME: '2026-10-21T10:00:00Z', RESPONSIBLE_ID: '7', SETTINGS: [], COMMUNICATIONS: comm('+79851234567', 140) },
      // контакт 150: пропущенный, не перезвонили — новый, упущенный (выигранная сделка — после звонка)
      { ID: '6', OWNER_TYPE_ID: '3', OWNER_ID: '150', DIRECTION: '1', START_TIME: '2026-10-21T11:00:00Z', RESPONSIBLE_ID: '8', SETTINGS: { MISSED_CALL: true }, COMMUNICATIONS: comm('+79850000000', 150) },
    ];
    const dealFilters: Record<string, unknown>[] = [];
    const listAll = vi.fn(async (method: string, params?: { filter?: Record<string, unknown> }) => {
      if (method === 'crm.activity.list') return calls;
      if (method === 'crm.deal.list' && params?.filter?.['>=DATE_CREATE']) return [];
      if (method === 'crm.deal.list') {
        dealFilters.push(params?.filter ?? {});
        return [
          // промежуточная стадия, бронь прошла до звонка → состоялась
          { CONTACT_ID: '140', CLOSEDATE: null, STAGE_SEMANTIC_ID: 'P', UF_END: '2026-09-01T14:00:00+03:00' },
          // бронь после звонка → ещё не состоялась
          { CONTACT_ID: '150', CLOSEDATE: '2026-10-21T20:00:00+03:00', STAGE_SEMANTIC_ID: 'S', UF_END: '2026-10-21T20:00:00+03:00' },
        ];
      }
      if (method === 'crm.contact.list') return [{ ID: '140', NAME: 'Анна', LAST_NAME: 'И.' }, { ID: '150', NAME: 'Олег', LAST_NAME: null }];
      return [];
    });
    const call = vi.fn(async () => ({ result: { categories: [{ id: 0, name: 'БК Алатырь' }, { id: 14, name: 'Домики и беседки' }] } }));
    const batch = vi.fn(async () => ({ result: { t2: [{ ID: '678', TITLE: 'Баня, Иванов' }], t3: [{ ID: '150', NAME: 'Олег' }] } }));
    const user = { portal: { id: 'p1', timezone: 'Europe/Moscow' }, userId: 7, client: { call, listAll, batch } } as unknown as B24UserContext;
    const fieldMap = { get: vi.fn(async () => ({ bookingEnd: 'UF_END' })) } as unknown as DealFieldMapService;
    const svc = new DashboardService({} as ChatsService, emptyJournal, fieldMap);
    const d = await svc.get(user, { from: '2026-10-21', to: '2026-10-21' }, false, [0, 14]);
    expect(d.calls).toEqual({ incoming: 2, new: 1, repeat: 1, answered: 1, missed: 2, lost: 1 });
    expect(d.callsFunnel).toBe(0);
    expect(dealFilters[0]).toMatchObject({ CATEGORY_ID: 0, '!STAGE_SEMANTIC_ID': 'F' });
    expect([...(dealFilters[0]['@CONTACT_ID'] as number[])].sort()).toEqual([140, 150]);
    expect(d.callFunnels).toEqual([{ id: 0, name: 'БК Алатырь' }, { id: 14, name: 'Домики и беседки' }]);

    const lost = await svc.callList(user, { kind: 'lost', from: '2026-10-21', to: '2026-10-21' }, [0, 14]);
    expect(lost.items.map((i) => [i.clientKey, i.activityId, i.contact?.name, i.repeat, i.incomingCount])).toEqual([['contact:150', 6, 'Олег', false, 1]]);
    const repeat = await svc.callList(user, { kind: 'repeat', from: '2026-10-21', to: '2026-10-21' }, [0, 14]);
    expect(repeat.items.map((i) => [i.clientKey, i.incomingCount, i.owner.title, i.dealId])).toEqual([['contact:140', 3, 'Баня, Иванов', 678]]);
    const mine = await svc.callList(user, { kind: 'incoming', from: '2026-10-21', to: '2026-10-21', scope: 'mine' }, [0, 14]);
    expect(mine.items.map((i) => i.clientKey)).toEqual(['contact:140']);
    await expect(svc.callList(user, { kind: 'all' })).rejects.toMatchObject({ status: 400 });
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
    const listAll = vi.fn(async (method: string, params?: { filter?: Record<string, unknown> }) =>
      method === 'crm.deal.list' && params?.filter?.['@ID']
        ? [{ ID: '678', TITLE: 'Баня', OPPORTUNITY: '5000.00', CURRENCY_ID: 'RUB' }]
        : method === 'crm.deal.list'
          ? []
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
    expect(listAll.mock.calls.find((c) => c[0] === 'crm.deal.list' && c[1]?.filter?.['@ID'])?.[1]).toMatchObject({
      filter: { '@ID': [678, 999] },
    });
  });

  it('without open lines rights returns no chat data and asks Bitrix24 only for calls', async () => {
    const call = vi.fn();
    const listAll = vi.fn(async () => []);
    const user = {
      portal: { id: 'p1', timezone: 'Europe/Moscow' },
      userId: 7,
      client: { call, listAll },
    } as unknown as B24UserContext;
    const d = await new DashboardService({} as ChatsService, emptyJournal).get(user, {}, false);
    expect(d).toMatchObject({ chats: null, contacts: null, calls: { incoming: 0, new: 0, repeat: 0, lost: 0 }, callsScope: 'all', callsFunnel: null, callFunnels: [], bookings: { created: 0 } });
    expect(call).not.toHaveBeenCalled();
    expect(listAll).toHaveBeenCalledWith('crm.activity.list', expect.objectContaining({ filter: expect.objectContaining({ PROVIDER_ID: 'VOXIMPLANT_CALL' }) }), expect.anything());
    await expect(new DashboardService({} as ChatsService, emptyJournal).get(user, { from: 'x' }, false)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('DashboardService.callLog', () => {
  it('lists calls of the day newest first with direction, status, phone and employee; scope mine', async () => {
    const calls = [
      { ID: '1', OWNER_ID: '678', OWNER_TYPE_ID: '2', DIRECTION: '1', START_TIME: '2026-10-22T10:15:36+03:00', END_TIME: '2026-10-22T10:16:39+03:00', RESPONSIBLE_ID: '236', COMMUNICATIONS: [{ VALUE: '79260000051', ENTITY_TYPE_ID: '3', ENTITY_ID: '140' }] },
      { ID: '2', OWNER_ID: '140', OWNER_TYPE_ID: '3', DIRECTION: '2', START_TIME: '2026-10-22T09:16:14+03:00', END_TIME: '2026-10-22T09:16:14+03:00', RESPONSIBLE_ID: '236', COMMUNICATIONS: [{ VALUE: '+79800000044', ENTITY_TYPE_ID: '3', ENTITY_ID: '140' }] },
      { ID: '3', OWNER_ID: '5', OWNER_TYPE_ID: '1', DIRECTION: '1', START_TIME: '2026-10-22T11:00:00+03:00', RESPONSIBLE_ID: '99', SETTINGS: { MISSED_CALL: true }, COMMUNICATIONS: [] },
    ];
    const listAll = vi.fn(async (method: string, params: { filter?: Record<string, unknown> }) => {
      if (method === 'crm.activity.list') {
        expect(params.filter).toMatchObject({ '>=START_TIME': '2026-10-21T21:00:00.000Z', '<START_TIME': '2026-10-22T21:00:00.000Z' });
        return calls;
      }
      if (method === 'crm.contact.list') return [{ ID: '140', NAME: 'Анна' }];
      if (method === 'user.get') return [{ ID: '236', NAME: 'Елена', LAST_NAME: 'Агула' }, { ID: '99', NAME: 'Пётр' }];
      return [];
    });
    const batch = vi.fn(async () => ({ result: { t2: [{ ID: '678', TITLE: 'Баня' }], t3: [{ ID: '140', NAME: 'Анна' }], t1: [{ ID: '5', TITLE: 'Лид' }] } }));
    const user = { portal: { id: 'p1', timezone: 'Europe/Moscow' }, userId: 236, client: { listAll, batch } } as unknown as B24UserContext;
    const svc = new DashboardService({} as ChatsService, emptyJournal);
    const all = await svc.callLog(user, { date: '2026-10-22', scope: 'all' });
    expect(all.items.map((i) => [i.activityId, i.direction, i.status, i.durationSec, i.clientPhone, i.employee?.name])).toEqual([
      [3, 'incoming', 'missed', 0, null, 'Пётр'],
      [1, 'incoming', 'success', 63, '79260000051', 'Елена Агула'],
      [2, 'outgoing', 'no_answer', 0, '+79800000044', 'Елена Агула'],
    ]);
    expect(all.items[1]).toMatchObject({ contact: { id: 140, name: 'Анна' }, owner: { typeId: 2, id: 678, title: 'Баня' } });
    const mine = await svc.callLog(user, { date: '2026-10-22', scope: 'mine' });
    expect(mine.items.map((i) => i.activityId)).toEqual([1, 2]);
    await expect(svc.callLog(user, { date: '22.10.2026' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('DashboardService — новые сделки за период', () => {
  it('сделки, созданные за период, в воронках групп; повторный — была состоявшаяся сделка той же воронки раньше', async () => {
    const listAll = vi.fn(async (method: string, params?: { filter?: Record<string, unknown> }) => {
      if (method === 'crm.deal.list' && params?.filter?.['>=DATE_CREATE'])
        return [
          { ID: '900', TITLE: 'Анна, баня', CATEGORY_ID: '0', CONTACT_ID: '140', DATE_CREATE: '2026-10-21T12:00:00+03:00', OPPORTUNITY: '45000', CURRENCY_ID: 'RUB' },
          { ID: '901', TITLE: 'Олег, баня', CATEGORY_ID: '0', CONTACT_ID: '150', DATE_CREATE: '2026-10-21T13:00:00+03:00', OPPORTUNITY: null, CURRENCY_ID: 'RUB' },
          { ID: '902', TITLE: 'Без контакта', CATEGORY_ID: '0', CONTACT_ID: null, DATE_CREATE: '2026-10-21T14:00:00+03:00', OPPORTUNITY: null, CURRENCY_ID: null },
        ];
      if (method === 'crm.deal.list' && params?.filter?.['@CONTACT_ID'])
        return [
          { ID: '900', CONTACT_ID: '140', CATEGORY_ID: '0', DATE_CREATE: '2026-10-21T12:00:00+03:00', STAGE_SEMANTIC_ID: 'P', CLOSEDATE: null },
          // Анна была в сентябре — бронь прошла
          { ID: '700', CONTACT_ID: '140', CATEGORY_ID: '0', DATE_CREATE: '2026-09-01T10:00:00+03:00', STAGE_SEMANTIC_ID: 'P', CLOSEDATE: null, UF_END: '2026-09-05T14:00:00+03:00' },
          // у Олега — сделка в другой воронке
          { ID: '701', CONTACT_ID: '150', CATEGORY_ID: '14', DATE_CREATE: '2026-08-01T10:00:00+03:00', STAGE_SEMANTIC_ID: 'S', CLOSEDATE: '2026-08-02T10:00:00+03:00' },
        ];
      if (method === 'crm.contact.list') return [{ ID: '140', NAME: 'Анна', LAST_NAME: null }];
      return [];
    });
    const user = { portal: { id: 'p1', timezone: 'Europe/Moscow' }, userId: 7, client: { call: vi.fn(async () => ({ result: {} })), listAll } } as unknown as B24UserContext;
    const fieldMap = { get: vi.fn(async () => ({ bookingEnd: 'UF_END' })) } as unknown as DealFieldMapService;
    const d = await new DashboardService({} as ChatsService, emptyJournal, fieldMap).get(user, { from: '2026-10-21', to: '2026-10-21', callsScope: 'mine' }, false, [0]);
    expect(d.newDeals).toMatchObject({ total: 3, repeat: 1, truncated: false });
    expect(d.newDeals?.items.map((i) => [i.id, i.repeat])).toEqual([[900, true], [901, false], [902, false]]);
    expect(d.newDeals?.items[0].contact).toEqual({ id: 140, name: expect.stringContaining('Анна') });
    expect(listAll.mock.calls.find((c) => c[1]?.filter?.['>=DATE_CREATE'])?.[1]).toMatchObject({
      filter: { '>=DATE_CREATE': '2026-10-20T21:00:00.000Z', '<DATE_CREATE': '2026-10-21T21:00:00.000Z', '@CATEGORY_ID': [0], ASSIGNED_BY_ID: 7 },
    });
  });
});

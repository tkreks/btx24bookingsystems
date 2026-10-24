import type { ClientBookingsDto } from '@btx24/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { ChatsService } from './chats.service.js';
import { ClientTimelineService } from './client-timeline.service.js';

function setup(portalId = 'p1') {
  const prisma = { telephonyCall: { findMany: vi.fn(async () => []) }, bookingRecord: { findMany: vi.fn(async () => [{ bookingId: 6, dealId: 10, title: 'Баня', createdAt: new Date('2026-10-23T09:00:00Z'), cancelledAt: new Date('2026-10-23T11:00:00Z') }]) } } as unknown as PrismaService;
  const chats = { history: vi.fn(async () => ({ chatId: 5, messages: [{ id: 8, date: '2026-10-23T13:00:00+03:00', author: { kind: 'client', id: 140, name: 'Иван' }, text: 'Здравствуйте', files: [] }] })) } as unknown as ChatsService;
  const client = { call: vi.fn(async () => ({ result: { PHONE: [{ VALUE: '+79001234567' }] } })), listAll: vi.fn(async (method: string, args: Record<string, unknown>) => {
    if (method === 'user.get') return [{ ID: '7', NAME: 'Анна', LAST_NAME: 'Иванова' }] as never;
    if (method === 'crm.deal.list') return [{ ID: '10', TITLE: 'Посещение', DATE_CREATE: '2026-10-23T08:00:00Z', STAGE_SEMANTIC_ID: 'P', CREATED_BY_ID: '7' }];
    if (method === 'crm.item.list') return [{ id: 3, parentId2: 10, stageId: 'DT31_2:P', opportunity: 25000, createdTime: '2026-10-23T09:00:00Z', movedTime: '2026-10-23T12:00:00Z' }, { id: 4, parentId2: 999, stageId: 'DT31_2:P', createdTime: '2026-10-23T13:00:00Z' }];
    if (method === 'crm.activity.list' && (args.filter as Record<string, unknown>).OWNER_TYPE_ID === 3) return [{ ID: '11', OWNER_TYPE_ID: '3', OWNER_ID: '140', TYPE_ID: '2', PROVIDER_ID: 'VOXIMPLANT_CALL', DIRECTION: '1', START_TIME: '2026-10-23T09:30:00Z', END_TIME: '2026-10-23T09:31:00Z' }];
    return [];
  }) };
  const user = { portal: { id: portalId }, userId: 7, client } as unknown as B24UserContext;
  return { svc: new ClientTimelineService(prisma, chats), prisma, chats, user, client };
}

describe('ClientTimelineService', () => {
  it('объединяет источники, сортирует по моменту UTC, не включает счёт другой сделки', async () => {
    const t = setup();
    const result = await t.svc.get(t.user, 140, null, [{ chatId: 5 } as never]);
    expect(new Set(result.events.map((e) => e.kind))).toEqual(new Set(['deal', 'booking', 'payment', 'invoice', 'message', 'call']));
    expect(result.events[0]).toMatchObject({ id: 'invoice:3:paid', at: '2026-10-23T12:00:00.000Z', amount: 25000 });
    expect(result.events.some((e) => e.id === 'invoice:4')).toBe(false);
    const times = result.events.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(result.events.find((e) => e.kind === 'call')?.text).toBe('60 сек.');
    expect(result.events.find((e) => e.kind === 'call')?.direction).toBe('incoming');
    expect(result.events.find((e) => e.id === 'deal:10:created')).toMatchObject({ actorId: 7, actorName: 'Анна Иванова' });
    expect(result.events.find((e) => e.kind === 'message')).toMatchObject({ messageId: 8, actorName: 'Иван', direction: 'incoming' });
    expect(t.client.listAll).toHaveBeenCalledWith('crm.deal.list', expect.objectContaining({ filter: { CONTACT_ID: 140 } }), expect.anything());
  });
  it.each(['p1', 'p2'])('журнал ограничен порталом %s и сделками, прочитанными пользователем в CRM', async (portalId) => {
    const t = setup(portalId);
    await t.svc.get(t.user, 140, null, []);
    expect(t.prisma.bookingRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { portalId, dealId: { in: [10] } } }));
  });
  it('при недоступной CRM не читает журнал по произвольным ID; сообщает об ограничении', async () => {
    const t = setup();
    t.client.listAll.mockRejectedValue(new Error('denied'));
    const result = await t.svc.get(t.user, 140, null, []);
    expect(t.prisma.bookingRecord.findMany).not.toHaveBeenCalled();
    expect(result.events).toEqual([]);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(t.chats.history).not.toHaveBeenCalled();
  });
  it('звонок по заказу CRM виден через номер контакта, только после проверки прав на дело', async () => {
    const t = setup();
    vi.mocked(t.prisma.telephonyCall.findMany).mockResolvedValue([
      { callId: 'allowed', crmActivityId: 92, callType: 2, userId: 99, startedAt: new Date('2026-10-24T00:00:00Z'), answeredAt: null, endedAt: new Date('2026-10-24T00:01:00Z') },
      { callId: 'denied', crmActivityId: 93, callType: 2, userId: 99, startedAt: new Date('2026-10-24T00:00:00Z'), answeredAt: null, endedAt: null },
    ] as never);
    const original = t.client.listAll.getMockImplementation()!;
    t.client.listAll.mockImplementation(async (m, p) => {
      if (m === 'crm.activity.list' && '@ID' in (p.filter as object)) return [{ ID: '92' }] as never;
      return original(m, p);
    });
    const result = await t.svc.get(t.user, 140, null, []);
    expect(result.events.some((e) => e.id === 'activity:92')).toBe(true);
    expect(result.events.some((e) => e.id === 'activity:93')).toBe(false);
    expect(t.prisma.telephonyCall.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { portalId: 'p1', phone: { in: expect.arrayContaining(['+79001234567']) } } }));
  });

  it('не теряет прошлые брони за пределами пяти из краткой карточки', async () => {
    const t = setup();
    const booking = { bookingId: 7, dealId: 10, start: '2026-10-22T10:00:00Z', when: 'past', resources: ['Баня'] };
    const data = { upcoming: [], recent: [], history: [booking], openDeals: [] } as unknown as ClientBookingsDto;
    const result = await t.svc.get(t.user, 140, data, []);
    expect(result.events.some((e) => e.id.startsWith('booking:7:visit'))).toBe(true);
  });
});

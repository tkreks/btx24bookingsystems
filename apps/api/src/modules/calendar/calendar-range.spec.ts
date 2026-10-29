import { CalendarService } from './calendar.service.js';

/** Шкала за период — из базы приложения: к модулю бронирования Битрикс24 запросов нет. */
function setup(o: { mirrorReady?: boolean } = {}) {
  const rec = (bookingId: number, startsAt: string, endsAt: string, resourceIds: number[], dealId: number | null = null) => ({ bookingId, title: `Бронь ${bookingId}`, resourceIds, startsAt: new Date(startsAt), endsAt: new Date(endsAt), dealId, status: 'active' });
  const prisma = {
    resource: { findMany: vi.fn(async () => [{ resourceId: 2, name: 'Баня' }, { resourceId: 1, name: 'Апельсин' }]) },
    bookingRecord: {
      findMany: vi.fn(async () => [
        rec(10, '2026-11-01T10:00:00Z', '2026-11-01T12:00:00Z', [1], 500),
        rec(11, '2026-11-02T10:00:00Z', '2026-11-02T12:00:00Z', [1], 501),
        rec(12, '2026-11-03T10:00:00Z', '2026-11-03T12:00:00Z', [99]),
      ]),
    },
    portalSettings: { findUnique: vi.fn(async () => ({ bookingSyncAt: new Date('2026-10-29T18:00:00Z'), syncHorizonDays: 180 })) },
    bookingAlert: { findMany: vi.fn(async () => [{ id: 'a1', bookingId: 11, status: 'new' }]) },
    resourceStop: { findMany: vi.fn(async () => []) },
  };
  const mirror = {
    ready: vi.fn(async () => o.mirrorReady !== false),
    dealsByIds: vi.fn(async () => ({ rows: [{ ID: '500', TITLE: 'Сделка 500', OPPORTUNITY: '9000', CURRENCY_ID: 'RUB' }], missing: [501] })),
  };
  const call = vi.fn();
  const listAll = vi.fn(async () => [{ ID: '501', TITLE: 'Сделка 501', OPPORTUNITY: null }]);
  const user = { portal: { id: 'p1', timezone: 'Europe/Moscow' }, userId: 7, client: { call, listAll, batch: vi.fn() } };
  return { svc: new CalendarService(prisma as never, mirror as never), prisma, mirror, user, call, listAll };
}

describe('Шкала броней за период', () => {
  it('брони, ресурсы и сделки — из базы; пропавшая — с решением; без запросов к модулю бронирования', async () => {
    const t = setup();
    const r = await t.svc.range(t.user as never, '2026-11-01', '2027-04-30', { resourceIds: [1, 2], techWindowMinutes: 60 });
    expect(r.resources.map((x) => x.name)).toEqual(['Апельсин', 'Баня']);
    expect(r.bookings.map((b) => [b.id, b.deal?.title ?? null, b.missing ?? null])).toEqual([
      [10, 'Сделка 500', null],
      [11, 'Сделка 501', { alertId: 'a1' }],
    ]);
    // Тех. окно — только у брони, которая есть в Битрикс24.
    expect(r.techWindows.map((w) => w.bookingId)).toEqual([10]);
    expect(r).toMatchObject({ syncedAt: '2026-10-29T18:00:00.000Z', timezone: 'Europe/Moscow' });
    expect(t.call).not.toHaveBeenCalled();
    expect(t.listAll).toHaveBeenCalledWith('crm.deal.list', expect.objectContaining({ filter: { '@ID': [501] } }));
  });
  it('без права на данные — только занятость', async () => {
    const t = setup();
    const r = await t.svc.range(t.user as never, '2026-11-01', '2026-11-30', { resourceIds: [1], withDetails: false });
    expect(r.bookings.every((b) => b.name === 'Занято' && b.deal === null && b.dealId === null)).toBe(true);
    expect(t.mirror.dealsByIds).not.toHaveBeenCalled();
  });
});

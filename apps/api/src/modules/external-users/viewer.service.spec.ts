import { ViewerService, toNumber, toText } from './viewer.service.js';

const at = (h: number) => new Date(Date.UTC(2026, 9, 31, h - 3));
function setup(o: { visibleFields?: string[] | null; allGroups?: boolean } = {}) {
  const groups = [
    { id: 'g1', name: 'Бани', techWindowMinutes: 30, resources: [{ resourceId: 1 }] },
    { id: 'g2', name: 'Домики', techWindowMinutes: 0, resources: [{ resourceId: 2 }] },
  ];
  const records = [
    { bookingId: 10, title: 'ДР', dealId: 100, resourceIds: [1], startsAt: at(13), endsAt: at(16) },
    { bookingId: 11, title: 'Чужая', dealId: 101, resourceIds: [3], startsAt: at(13), endsAt: at(14) },
  ];
  const db = {
    workGroup: { findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) => groups.filter((g) => !where.id || where.id.in.includes(g.id))) },
    portalSettings: { findUnique: vi.fn(async () => null) },
    resource: { findMany: vi.fn(async ({ where }: { where: { resourceId: { in: number[] } } }) => [{ resourceId: 1, name: 'Баня' }, { resourceId: 2, name: 'Домик' }].filter((r) => where.resourceId.in.includes(r.resourceId))) },
    bookingRecord: { findMany: vi.fn(async () => records), findUnique: vi.fn(async ({ where }: { where: { portalId_bookingId: { bookingId: number } } }) => records.find((r) => r.bookingId === where.portalId_bookingId.bookingId) ?? null) },
    bookingAlert: { findMany: vi.fn(async () => []) },
    crmDeal: { findMany: vi.fn(async () => [{ dealId: 100, contactId: 7, row: { TITLE: 'Сделка', OPPORTUNITY: '15000', CURRENCY_ID: 'RUB', UF_G: '10', UF_P: '5000|RUB', COMMENTS: 'Зал <b>за 30 минут</b>', UF_M: 'Проектор' } }]) },
    crmEntity: { findMany: vi.fn(async () => [{ entityId: 7, title: 'Иван Иванов' }]) },
    dealPayment: { findMany: vi.fn(async () => [{ dealId: 100, amount: 3000, at: at(10) }, { dealId: 100, amount: 2000, at: at(9) }]) },
    dealPaidAmount: { findMany: vi.fn(async () => []) },
  };
  const call = vi.fn(async () => ({ result: [{ PRODUCT_NAME: 'Программа', PRICE: 2000, QUANTITY: 5 }] }));
  const listAll = vi.fn(async (): Promise<unknown[]> => []);
  const fieldMap = { resolved: vi.fn(async () => ({ guests: 'UF_G', paidAmount: 'UF_P', managerComment: 'UF_M' })) };
  const ctx = { portal: { id: 'p1', domain: 'a', timezone: 'Europe/Moscow' }, user: { id: 'u1', login: 'viewer', role: 'VIEWER', allGroups: o.allGroups ?? false, visibleFields: o.visibleFields ?? null, groupIds: ['g1'] } };
  return { db, call, listAll, ctx: ctx as never, svc: new ViewerService(db as never, { clientFor: () => ({ call, listAll }) } as never, fieldMap as never) };
}

describe('Экран «Бронирования» внешнего пользователя', () => {
  it('только ресурсы его групп; поля из копии CRM; тех. окно после брони', async () => {
    const t = setup();
    const day = await t.svc.day(t.ctx, '2026-10-31', '');
    expect(day.resources).toEqual([{ id: 1, name: 'Баня' }]);
    expect(day.bookings.map((b) => b.bookingId)).toEqual([10]);
    expect(day.bookings[0]).toMatchObject({ clientName: 'Иван Иванов', guests: 10, programGuests: null, amount: 15000, paid: 5000, comment: 'Зал за 30 минут', important: 'Проектор', products: true, lastPaymentAt: at(10).toISOString(), lastPaymentAmount: 3000 });
    expect(day.techWindows).toEqual([{ resourceId: 1, startsAt: at(16).toISOString(), endsAt: new Date(at(16).getTime() + 30 * 60_000).toISOString() }]);
    await expect(t.svc.day(t.ctx, '2026-10-31', 'g2')).rejects.toMatchObject({ status: 403 });
  });
  it('скрытые настройками поля не уходят с сервера; товары — только по своей брони', async () => {
    const t = setup({ visibleFields: ['UF_G'] });
    const [b] = (await t.svc.day(t.ctx, '2026-10-31', '')).bookings;
    expect(b).toMatchObject({ guests: 10, amount: null, paid: null, comment: null, important: null, clientName: null, products: false });
    await expect(t.svc.productsOf(t.ctx, 10)).rejects.toMatchObject({ status: 403 });
    const all = setup();
    expect((await all.svc.productsOf(all.ctx, 10)).items).toEqual([{ name: 'Программа', price: 2000, quantity: 5, sum: 10000 }]);
    await expect(all.svc.productsOf(all.ctx, 11)).rejects.toMatchObject({ status: 404 });
    await all.svc.productsOf(all.ctx, 10);
    expect(all.call).toHaveBeenCalledTimes(1);
  });
  it('последняя оплата — оплаченный счёт сделки, даже если рост оплат приложение не видело', async () => {
    const t = setup();
    t.db.dealPayment.findMany.mockResolvedValue([]);
    t.listAll.mockResolvedValue([
      { parentId2: 100, opportunity: 20000, stageId: 'DT31_2:P', movedTime: at(11).toISOString() },
      { parentId2: 100, opportunity: 5000, stageId: 'DT31_2:P', movedTime: at(12).toISOString() },
      { parentId2: 100, opportunity: 9000, stageId: 'DT31_2:N', movedTime: at(13).toISOString() },
    ]);
    const [b] = (await t.svc.day(t.ctx, '2026-10-31', '')).bookings;
    expect(b).toMatchObject({ lastPaymentAmount: 5000, lastPaymentAt: at(12).toISOString() });
    expect(b.payments).toEqual([
      { at: at(12).toISOString(), amount: 5000 },
      { at: at(11).toISOString(), amount: 20000 },
    ]);
  });
  it('значения CRM: пусто — null, а не ноль; разметка убирается', () => {
    expect(toNumber('')).toBeNull();
    expect(toNumber('0')).toBeNull();
    expect(toNumber('0', true)).toBe(0);
    expect(toNumber('5000|RUB')).toBe(5000);
    expect(toText('[b]Важно[/b]<br>проектор')).toBe('Важно\nпроектор');
    expect(toText('  ')).toBeNull();
  });
});

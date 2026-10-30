import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { BookingCancelService } from './booking-cancel.service.js';
import type { BookingJournalService } from './booking-journal.service.js';
import type { DealBookingFieldsService } from './deal-booking-fields.service.js';

function setup(o: { booking?: object | null; can?: boolean; deleteFails?: string; waiting?: { id: string; invoiceId: number | null }[]; record?: { status: string; dealId?: number } | null; importedDealId?: number; refresh?: boolean } = {}) {
  const calls: [string, unknown][] = [];
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    if (method === 'booking.v1.booking.get') {
      if (o.booking === null) throw new Bitrix24Error('1021', 'Booking not found');
      return { result: { booking: o.booking ?? { id: 5, name: 'Иванов', resourceIds: [10], datePeriod: { from: { timestamp: 1_600_000_000 }, to: { timestamp: 1_600_003_600 } } } } };
    }
    if (method === 'booking.v1.booking.delete' && o.deleteFails) throw new Bitrix24Error(o.deleteFails, o.deleteFails === '1021' ? 'Booking not found' : 'blocked');
    return { result: true };
  });
  const user = { portal: { id: 'p1' }, userId: 7, userName: 'Анна', client: { call, batch: vi.fn(async () => ({ result: { b5: { externalData: [{ moduleId: 'crm', entityTypeId: 'DEAL', value: '700' }] } } })) } } as unknown as B24UserContext;
  const access = {
    resolve: vi.fn(async () => ({})),
    pick: vi.fn(() => (o.can === false ? null : { group: { id: 'g1', resourceIds: [10, 11] }, permissions: ['booking.cancel'] })),
  } as unknown as AccessService;
  const journal = {
    find: vi.fn(async () => (o.record === undefined ? { id: 'r1', status: 'active' } : o.record)),
    recordImported: vi.fn(async () => ({ record: o.importedDealId ? { dealId: o.importedDealId } : {}, created: false })),
    recordCancelled: vi.fn(async () => ({})),
  };
  const payments = { findMany: vi.fn(async () => o.waiting ?? []), updateMany: vi.fn(async () => ({ count: 1 })) };
  const prisma = { paymentRequest: payments } as unknown as PrismaService;
  const dealBookings = { refresh: vi.fn(async (_c: unknown, dealId: number) => [`поля #${dealId}`]) };
  const svc = new BookingCancelService(prisma, access, journal as unknown as BookingJournalService, o.refresh ? (dealBookings as unknown as DealBookingFieldsService) : undefined);
  return { svc, user, calls, journal, payments, dealBookings };
}

describe('BookingCancelService', () => {
  it('удаляет бронь в Битрикс24, отменяет в журнале с причиной и снимает ожидание оплаты', async () => {
    const t = setup({ waiting: [{ id: 'pr1', invoiceId: 5152 }] });
    const r = await t.svc.cancel(t.user, 5, { groupId: 'g1', comment: 'Клиент передумал' });
    expect(t.calls.map((c) => c[0])).toContain('booking.v1.booking.delete');
    expect(t.journal.recordCancelled).toHaveBeenCalledWith('p1', 5, expect.objectContaining({ reason: 'manual', comment: 'Клиент передумал' }));
    expect(t.payments.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) }));
    expect(r.warnings).toEqual(['Счёт #5152 остался — при необходимости переведите его в «Не оплачен»']);
  });

  it('без права — 403, бронь не трогается', async () => {
    const t = setup({ can: false });
    await expect(t.svc.cancel(t.user, 5, { groupId: 'g1' })).rejects.toMatchObject({ response: { code: 'NO_BOOKING_CANCEL' } });
    expect(t.calls).toEqual([]);
  });

  it('бронь чужих ресурсов — 403', async () => {
    const t = setup({ booking: { id: 5, resourceIds: [99] } });
    await expect(t.svc.cancel(t.user, 5, { groupId: 'g1' })).rejects.toMatchObject({ response: { code: 'BOOKING_NOT_IN_GROUP' } });
    expect(t.calls.map((c) => c[0])).not.toContain('booking.v1.booking.delete');
  });

  it('режим «только чтение» — понятная 403, журнал не отменяется', async () => {
    const t = setup({ deleteFails: 'READ_ONLY_MODE' });
    await expect(t.svc.cancel(t.user, 5, { groupId: 'g1' })).rejects.toMatchObject({ response: { code: 'BOOKING_READ_ONLY' } });
    expect(t.journal.recordCancelled).not.toHaveBeenCalled();
  });

  it('две одновременные отмены: вторая получила 1021 на delete — успех с тем же результатом, история не задваивается', async () => {
    const t = setup({ deleteFails: '1021', waiting: [{ id: 'pr1', invoiceId: 5152 }] });
    const r = await t.svc.cancel(t.user, 5, { groupId: 'g1', comment: 'Клиент передумал' });
    expect(r).toEqual({ bookingId: 5, warnings: ['Счёт #5152 остался — при необходимости переведите его в «Не оплачен»'] });
    // recordCancelled сам отменяет только активную запись — вызов безопасен, если первая уже отменила.
    expect(t.journal.recordCancelled).toHaveBeenCalledWith('p1', 5, expect.objectContaining({ reason: 'manual' }));
    const late = setup({ deleteFails: '1021' });
    expect(await late.svc.cancel(late.user, 5, { groupId: 'g1' })).toEqual({ bookingId: 5, warnings: [] });
  });

  it('другая ошибка удаления — по-прежнему ошибка, журнал не отменяется', async () => {
    const t = setup({ deleteFails: 'INTERNAL' });
    await expect(t.svc.cancel(t.user, 5, { groupId: 'g1' })).rejects.toBeInstanceOf(Bitrix24Error);
    expect(t.journal.recordCancelled).not.toHaveBeenCalled();
  });

  it('повтор: бронь уже удалена — закрываем у нас без ошибки', async () => {
    const t = setup({ booking: null });
    const r = await t.svc.cancel(t.user, 5, { groupId: 'g1' });
    expect(t.journal.recordCancelled).toHaveBeenCalled();
    expect(r.warnings).toEqual(['Бронь уже была снята в Битрикс24']);
  });

  it('после отмены пересчитывает поля броней сделки (и сделки по журналу, если она другая); предупреждения — в ответ', async () => {
    const t = setup({ refresh: true, importedDealId: 701 });
    const r = await t.svc.cancel(t.user, 5, { groupId: 'g1' });
    expect(t.dealBookings.refresh.mock.calls.map((c) => c[1])).toEqual([700, 701]);
    expect(t.dealBookings.refresh.mock.invocationCallOrder[0]).toBeGreaterThan(t.journal.recordCancelled.mock.invocationCallOrder[0]);
    expect(r.warnings).toEqual(['поля #700', 'поля #701']);
    const same = setup({ refresh: true, importedDealId: 700 });
    await same.svc.cancel(same.user, 5, { groupId: 'g1' });
    expect(same.dealBookings.refresh).toHaveBeenCalledTimes(1);
  });

  it('повтор (бронь уже удалена): пересчёт по сделке из журнала', async () => {
    const t = setup({ booking: null, refresh: true, record: { status: 'active', dealId: 702 } });
    const r = await t.svc.cancel(t.user, 5, { groupId: 'g1' });
    expect(t.dealBookings.refresh).toHaveBeenCalledWith(expect.objectContaining({ portalId: 'p1' }), 702);
    expect(r.warnings).toEqual(['Бронь уже была снята в Битрикс24', 'поля #702']);
  });
});

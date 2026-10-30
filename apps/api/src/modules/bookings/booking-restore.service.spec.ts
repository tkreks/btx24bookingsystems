import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { BookingRestoreService } from './booking-restore.service.js';
import type { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { BookingJournalService } from './booking-journal.service.js';
import type { DealBookingFieldsService } from './deal-booking-fields.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

const record = {
  id: 'r1',
  portalId: 'p1',
  bookingId: 5942,
  source: 'app',
  status: 'active',
  title: 'Тестовая сделка',
  dealId: 18784,
  resourceIds: [14],
  startsAt: new Date('2026-10-23T16:30:00Z'),
  endsAt: new Date('2026-10-23T20:30:00Z'),
};

function setup(o: { exists?: boolean; overlap?: boolean; permissions?: string[]; status?: string; refreshWarnings?: string[] } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push([method, params]);
    if (method === 'booking.v1.booking.get') {
      if (o.exists) return { result: { booking: { id: 5942 } } };
      throw new Bitrix24Error('1021', 'Booking not found');
    }
    if (method === 'booking.v1.booking.add') {
      if (o.overlap) throw new Bitrix24Error('1018', 'overlap');
      return { result: { id: 6001 } };
    }
    if (method === 'crm.deal.get') return { result: { CONTACT_ID: '140' } };
    return { result: true };
  });
  const journal = {
    find: vi.fn(async () => ({ ...record, status: o.status ?? 'active' })),
    recordRecreated: vi.fn(async () => ({})),
    recordCancelled: vi.fn(async () => ({})),
    recordChanged: vi.fn(async () => ({})),
    version: vi.fn(async () => ({ startsAt: '2026-10-23T15:00:00.000Z', endsAt: '2026-10-23T19:00:00.000Z', resourceIds: [14], dealId: 18784 })),
  };
  const prisma = { paymentRequest: { updateMany: vi.fn(async () => ({ count: 1 })) } };
  const access = {
    resolve: vi.fn(async () => ({
      isAppAdmin: false,
      groups: [{ group: { id: 'g1', resourceIds: [2, 14] }, permissions: o.permissions ?? ['booking.create', 'booking.cancel', 'booking.edit'] }],
    })),
  };
  const dealBookings = { refresh: vi.fn(async () => (o.refreshWarnings ?? []) as string[]) };
  const svc = new BookingRestoreService(
    prisma as unknown as PrismaService,
    access as unknown as AccessService,
    journal as unknown as BookingJournalService,
    dealBookings as unknown as DealBookingFieldsService,
  );
  const batch = vi.fn(async () => ({ result: { b5942: { externalData: [{ moduleId: 'crm', entityTypeId: 'DEAL', value: '18784' }] } }, errors: {}, total: {}, next: {} }));
  const user = { portal: { id: 'p1', timezone: 'Europe/Moscow' }, userId: 7, userName: 'Анна', client: { call, batch } } as unknown as B24UserContext;
  return { svc, user, calls, journal, prisma, dealBookings };
}

describe('BookingRestoreService', () => {
  it('recreates a booking deleted in Bitrix24 from the journal: deal link, client, deal field, new ID everywhere', async () => {
    const t = setup();
    const r = await t.svc.recreate(t.user, 5942);
    expect(r).toEqual({ previousBookingId: 5942, bookingId: 6001, warnings: [] });
    const add = t.calls.find((c) => c[0] === 'booking.v1.booking.add')![1] as { fields: Record<string, unknown> };
    expect(add.fields).toMatchObject({ resourceIds: [14], name: 'Тестовая сделка', datePeriod: { from: { timestamp: Date.parse('2026-10-23T16:30:00Z') / 1000 } } });
    expect(t.calls.find((c) => c[0] === 'booking.v1.booking.externalData.set')![1]).toEqual({
      bookingId: 6001,
      externalData: [{ moduleId: 'crm', entityTypeId: 'DEAL', value: '18784' }],
    });
    expect(t.calls.find((c) => c[0] === 'booking.v1.booking.client.set')![1]).toMatchObject({ bookingId: 6001, clients: [{ id: 140 }] });
    // Номер и даты в сделке — пересчётом по журналу после записи нового ID (сам сервис в сделку не пишет).
    expect(t.calls.some((c) => c[0] === 'crm.deal.update')).toBe(false);
    expect(t.dealBookings.refresh).toHaveBeenCalledTimes(1);
    expect(t.dealBookings.refresh).toHaveBeenCalledWith({ portalId: 'p1', timezone: 'Europe/Moscow', client: t.user.client }, 18784);
    expect(t.dealBookings.refresh.mock.invocationCallOrder[0]).toBeGreaterThan(t.journal.recordRecreated.mock.invocationCallOrder[0]);
    expect(t.journal.recordRecreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), 6001, { kind: 'user', userId: 7, name: 'Анна' });
    expect(t.prisma.paymentRequest.updateMany).toHaveBeenCalledWith({ where: { portalId: 'p1', bookingId: 5942 }, data: { bookingId: 6001 } });
  });

  it('refuses when the booking is still in Bitrix24, the slot is taken or there is no right in the resource group', async () => {
    const alive = setup({ exists: true });
    await expect(alive.svc.recreate(alive.user, 5942)).rejects.toMatchObject({ response: { code: 'BOOKING_EXISTS' } });
    const busy = setup({ overlap: true });
    await expect(busy.svc.recreate(busy.user, 5942)).rejects.toMatchObject({ response: { code: 'BOOKING_OVERLAP' } });
    expect(busy.journal.recordRecreated).not.toHaveBeenCalled();
    const noRight = setup({ permissions: ['booking.cancel'] });
    await expect(noRight.svc.recreate(noRight.user, 5942)).rejects.toMatchObject({ response: { code: 'NO_BOOKING_ACCESS' } });
    const done = setup({ status: 'cancelled' });
    await expect(done.svc.removeInApp(done.user, 5942)).rejects.toMatchObject({ response: { code: 'BOOKING_NOT_FOUND' } });
  });

  it('removes in the app: cancelled in the journal as removed in Bitrix24, by the employee', async () => {
    const t = setup();
    await t.svc.removeInApp(t.user, 5942);
    expect(t.journal.recordCancelled).toHaveBeenCalledWith('p1', 5942, { reason: 'removed_in_bitrix', actor: { kind: 'user', userId: 7, name: 'Анна' } });
    expect(t.calls.some((c) => c[0] === 'booking.v1.booking.delete')).toBe(false);
    expect(t.dealBookings.refresh).toHaveBeenCalledWith(expect.objectContaining({ portalId: 'p1' }), 18784);
    expect(t.dealBookings.refresh.mock.invocationCallOrder[0]).toBeGreaterThan(t.journal.recordCancelled.mock.invocationCallOrder[0]);
  });

  it('rollback: the booking in Bitrix24 returns to the chosen version, dates in the deal too', async () => {
    const t = setup({ exists: true });
    await t.svc.rollback(t.user, 5942, 'h1');
    expect(t.journal.version).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), 'h1');
    expect(t.calls.find((c) => c[0] === 'booking.v1.booking.update')![1]).toEqual({
      id: 5942,
      fields: { resourceIds: [14], datePeriod: { from: { timestamp: Date.parse('2026-10-23T15:00:00Z') / 1000, timezone: 'Europe/Moscow' }, to: { timestamp: Date.parse('2026-10-23T19:00:00Z') / 1000, timezone: 'Europe/Moscow' } } },
    });
    // Сделка та же — связь не трогаем.
    expect(t.calls.some((c) => c[0].startsWith('booking.v1.booking.externalData'))).toBe(false);
    expect(t.journal.recordChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ startsAt: '2026-10-23T15:00:00.000Z' }), expect.anything(), 'rolled_back', 'app');
    // Сделка та же — один пересчёт, после записи версии в журнал.
    expect(t.dealBookings.refresh).toHaveBeenCalledTimes(1);
    expect(t.dealBookings.refresh.mock.invocationCallOrder[0]).toBeGreaterThan(t.journal.recordChanged.mock.invocationCallOrder[0]);
  });

  it('предупреждения пересчёта полей сделки возвращаются, а не роняют решение', async () => {
    const t = setup({ exists: true, refreshWarnings: ['Поля броней в сделке #18784 не обновлены'] });
    expect(await t.svc.rollback(t.user, 5942, 'h1')).toEqual(['Поля броней в сделке #18784 не обновлены']);
  });

  it('rollback of a booking deleted in Bitrix24 recreates it by the version', async () => {
    const t = setup();
    const w = await t.svc.rollback(t.user, 5942, 'h1');
    expect(w).toEqual([]);
    const add = t.calls.find((c) => c[0] === 'booking.v1.booking.add')![1] as { fields: { datePeriod: { from: { timestamp: number } } } };
    expect(add.fields.datePeriod.from.timestamp).toBe(Date.parse('2026-10-23T15:00:00Z') / 1000);
    expect(t.journal.recordRecreated).toHaveBeenCalled();
    expect(t.journal.recordChanged).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'rolled_back', 'app');
  });
});

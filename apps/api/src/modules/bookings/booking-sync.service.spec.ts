import { BookingSyncService, DEAL_FIELDS_PER_PASS } from './booking-sync.service.js';
import type { DealBookingFieldsService } from './deal-booking-fields.service.js';
import type { BookingAlertsService } from './booking-alerts.service.js';
import type { BookingJournalService } from './booking-journal.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import type { Portal } from '../../generated/prisma/client.js';

const portal = { id: 'p1', timezone: 'Europe/Moscow' } as Portal;
const now = new Date('2026-10-21T10:00:00Z');
const ts = (iso: string) => Date.parse(iso) / 1000;
const booking = (id: number, from: string, to: string, resourceIds: number[], name = 'Бронь') => ({
  id,
  name,
  resourceIds,
  datePeriod: { from: { timestamp: ts(from) }, to: { timestamp: ts(to) } },
});
const record = (over: Record<string, unknown>) => ({
  id: `r${over.bookingId}`,
  portalId: 'p1',
  source: 'app',
  status: 'active',
  title: null,
  dealId: 678,
  resourceIds: [10],
  startsAt: new Date('2026-10-23T11:00:00.000Z'),
  endsAt: new Date('2026-10-23T13:00:00.000Z'),
  ...over,
});

function setup(o: { bookings: unknown[]; links?: Record<number, number>; records: unknown[]; baseline: boolean; get?: Record<number, unknown>; refresh?: boolean }) {
  const prisma = {
    portalSettings: {
      upsert: vi.fn(async () => ({ syncHorizonDays: 30, bookingSyncBaselineAt: o.baseline ? now : null })),
      update: vi.fn(async () => ({})),
    },
    resource: { upsert: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) },
    bookingRecord: { findMany: vi.fn(async () => o.records), update: vi.fn(async () => ({})) },
  } as unknown as PrismaService;
  const journal = {
    recordImported: vi.fn(async () => ({ record: {}, created: true })),
    recordChanged: vi.fn(async () => ({})),
    recordCancelled: vi.fn(async () => ({})),
    note: vi.fn(async () => undefined),
  };
  const alerts = { raise: vi.fn(async () => ({ id: 'a1' })), deliverPending: vi.fn(async () => 0) };
  const client = {
    call: vi.fn(async (method: string, params: { id?: number }) => {
      if (method === 'booking.v1.booking.list') return { result: { booking: o.bookings } };
      if (method === 'booking.v1.booking.get') {
        const b = o.get?.[params.id!];
        if (!b) throw Object.assign(new (await import('../bitrix24/rest/errors.js')).Bitrix24Error('1021', 'Booking not found'));
        return { result: { booking: b } };
      }
      throw new Error(`unexpected ${method}`);
    }),
    listAll: vi.fn(async () => [{ id: 10, name: 'Баня №1' }]),
    batch: vi.fn(async (cmds: Record<string, unknown>) => ({
      result: Object.fromEntries(
        Object.keys(cmds).map((k) => {
          const deal = o.links?.[Number(k.slice(1))];
          return [k, { externalData: deal ? [{ moduleId: 'crm', entityTypeId: 'DEAL', value: String(deal) }] : [] }];
        }),
      ),
    })),
  } as unknown as Bitrix24RestClient;
  const dealBookings = { refresh: vi.fn(async () => [] as string[]) };
  const svc = new BookingSyncService(
    prisma,
    journal as unknown as BookingJournalService,
    alerts as unknown as BookingAlertsService,
    o.refresh ? (dealBookings as unknown as DealBookingFieldsService) : undefined,
  );
  return { svc, prisma, journal, alerts, client, dealBookings };
}

describe('BookingSyncService', () => {
  it('first pass accepts existing bookings silently and sets the baseline', async () => {
    const t = setup({ bookings: [booking(1, '2026-10-22T10:00:00Z', '2026-10-22T12:00:00Z', [10])], records: [], baseline: false });
    const r = await t.svc.reconcile(portal, t.client, now);
    expect(r).toMatchObject({ baseline: true, bookings: { imported: 1, alerts: 0 } });
    expect(t.alerts.raise).not.toHaveBeenCalled();
    expect(t.prisma.portalSettings.update).toHaveBeenCalled();
    expect(t.prisma.resource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ resourceId: { notIn: [10] } }) }),
    );
  });

  it('after baseline a booking made outside the app raises «new booking»', async () => {
    const t = setup({ bookings: [booking(2, '2026-10-22T10:00:00Z', '2026-10-22T12:00:00Z', [10])], links: { 2: 700 }, records: [], baseline: true });
    await t.svc.reconcile(portal, t.client, now);
    expect(t.journal.recordImported).toHaveBeenCalledWith('p1', expect.objectContaining({ bookingId: 2, dealId: 700 }));
    expect(t.alerts.raise).toHaveBeenCalledWith('p1', expect.objectContaining({ kind: 'new_booking', bookingId: 2, dealId: 700 }));
    expect(t.alerts.deliverPending).toHaveBeenCalled();
  });

  it('app booking changed in Bitrix24 → discrepancy, record stays as expected', async () => {
    const t = setup({
      bookings: [booking(3, '2026-10-23T12:00:00Z', '2026-10-23T13:00:00Z', [10])],
      links: { 3: 678 },
      records: [record({ bookingId: 3 })],
      baseline: true,
    });
    const r = await t.svc.reconcile(portal, t.client, now);
    expect(r.bookings.alerts).toBe(1);
    expect(t.alerts.raise).toHaveBeenCalledWith('p1', expect.objectContaining({ kind: 'discrepancy', problems: ['time'] }));
    expect(t.journal.note).toHaveBeenCalledWith(expect.objectContaining({ id: 'r3' }), 'discrepancy_found', expect.objectContaining({ kind: 'system' }), expect.anything(), 'reconcile');
    expect(t.journal.recordChanged).not.toHaveBeenCalled();
  });

  it('booking from Bitrix24 changed there → record follows, no alert', async () => {
    const t = setup({
      bookings: [booking(4, '2026-10-23T11:00:00Z', '2026-10-23T13:00:00Z', [10, 12])],
      links: { 4: 678 },
      records: [record({ bookingId: 4, source: 'bitrix' })],
      baseline: true,
    });
    await t.svc.reconcile(portal, t.client, now);
    expect(t.journal.recordChanged).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 4 }),
      expect.objectContaining({ resourceIds: [10, 12] }),
      expect.objectContaining({ kind: 'bitrix' }),
      'changed_in_bitrix',
      'reconcile',
    );
    expect(t.alerts.raise).not.toHaveBeenCalled();
  });

  it('missing: app booking and Bitrix booking with a deal → discrepancy «missing» (decision); Bitrix without deal → cancelled; moved → compared', async () => {
    const t = setup({
      bookings: [],
      records: [
        record({ bookingId: 5 }),
        record({ bookingId: 6, source: 'bitrix', dealId: null }),
        record({ bookingId: 7 }),
        record({ bookingId: 9, source: 'bitrix' }),
      ],
      get: { 7: booking(7, '2026-10-23T11:00:00Z', '2026-10-23T13:00:00Z', [10]) },
      links: { 7: 678 },
      baseline: true,
    });
    const r = await t.svc.reconcile(portal, t.client, now);
    expect(t.alerts.raise).toHaveBeenCalledTimes(2);
    expect(t.alerts.raise).toHaveBeenCalledWith('p1', expect.objectContaining({ bookingId: 5, problems: ['missing'], actual: null }));
    expect(t.alerts.raise).toHaveBeenCalledWith('p1', expect.objectContaining({ bookingId: 9, problems: ['missing'], actual: null }));
    expect(t.journal.recordCancelled).toHaveBeenCalledTimes(1);
    expect(t.journal.recordCancelled).toHaveBeenCalledWith('p1', 6, expect.objectContaining({ reason: 'removed_in_bitrix' }));
    expect(r.bookings).toMatchObject({ removed: 1, alerts: 2 });
  });

  it('same discrepancy again (alert exists) → no second note', async () => {
    const t = setup({ bookings: [], records: [record({ bookingId: 8 })], baseline: true });
    t.alerts.raise.mockResolvedValueOnce(null as never);
    const r = await t.svc.reconcile(portal, t.client, now);
    expect(r.bookings.alerts).toBe(0);
    expect(t.journal.note).not.toHaveBeenCalled();
  });
});

describe('BookingSyncService — прошедшие брони (31 день назад)', () => {
  it('сверяет с запасом назад: прошедшую неизвестную бронь пишет в журнал на дату брони без уведомления', async () => {
    const past = booking(7, '2026-10-10T10:00:00Z', '2026-10-10T12:00:00Z', [10]);
    const t = setup({ bookings: [past], records: [], baseline: true });
    await t.svc.reconcile(portal, t.client, now);
    const list = (t.client.call as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'booking.v1.booking.list')![1];
    expect(list.filter.within.dateFrom).toBe(ts('2026-09-19T21:00:00Z')); // начало сегодняшнего дня (МСК) − 31 день
    expect(t.journal.recordImported).toHaveBeenCalledWith('p1', expect.objectContaining({ bookingId: 7, createdAt: new Date('2026-10-10T10:00:00Z') }));
    expect(t.alerts.raise).not.toHaveBeenCalled();
  });

  it('известная прошедшая служебная бронь из Битрикс24, которую там удалили, отмечается удалённой', async () => {
    const t = setup({
      bookings: [],
      records: [record({ bookingId: 8, source: 'bitrix', dealId: null, startsAt: new Date('2026-10-12T10:00:00Z'), endsAt: new Date('2026-10-12T12:00:00Z') })],
      baseline: true,
    });
    const r = await t.svc.reconcile(portal, t.client, now);
    expect(t.journal.recordCancelled).toHaveBeenCalledWith('p1', 8, expect.objectContaining({ reason: 'removed_in_bitrix' }));
    expect(r.bookings.removed).toBe(1);
    expect((t.prisma.bookingRecord.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where.OR[1].endsAt.gt).toEqual(new Date('2026-09-19T21:00:00Z'));
  });
});

describe('BookingSyncService — поля броней сделок', () => {
  const refreshed = (t: ReturnType<typeof setup>) => t.dealBookings.refresh.mock.calls.map((c) => (c as unknown[])[1]);

  it('новая бронь вне приложения и изменение в Битрикс24 — пересчёт затронутых сделок (прежней и новой) токеном приложения', async () => {
    const t = setup({
      bookings: [booking(2, '2026-10-22T10:00:00Z', '2026-10-22T12:00:00Z', [10]), booking(4, '2026-10-23T11:00:00Z', '2026-10-23T13:00:00Z', [10])],
      links: { 2: 700, 4: 701 },
      records: [record({ bookingId: 4, source: 'bitrix', dealId: 678 })],
      baseline: true,
      refresh: true,
    });
    const r = await t.svc.reconcile(portal, t.client, now);
    expect(refreshed(t).sort()).toEqual([678, 700, 701]);
    expect(t.dealBookings.refresh).toHaveBeenCalledWith({ portalId: 'p1', timezone: 'Europe/Moscow', client: t.client }, 700, now);
    expect(r.deals).toEqual({ refreshed: 3, pending: 0 });
  });

  it('без изменений и при расхождении брони приложения (решает сотрудник) — сделки не трогаются', async () => {
    const t = setup({ bookings: [booking(3, '2026-10-23T12:00:00Z', '2026-10-23T13:00:00Z', [10])], links: { 3: 678 }, records: [record({ bookingId: 3 })], baseline: true, refresh: true });
    await t.svc.reconcile(portal, t.client, now);
    expect(t.dealBookings.refresh).not.toHaveBeenCalled();
  });

  it('первый проход (baseline) не пересчитывает сделки', async () => {
    const t = setup({ bookings: [booking(1, '2026-10-22T10:00:00Z', '2026-10-22T12:00:00Z', [10])], links: { 1: 700 }, records: [], baseline: false, refresh: true });
    const r = await t.svc.reconcile(portal, t.client, now);
    expect(t.dealBookings.refresh).not.toHaveBeenCalled();
    expect(r.deals).toBeUndefined();
  });

  it(`не больше ${DEAL_FIELDS_PER_PASS} сделок за проход, остальные — на следующий`, async () => {
    const n = DEAL_FIELDS_PER_PASS + 5;
    const bookings = Array.from({ length: n }, (_, i) => booking(100 + i, '2026-10-22T10:00:00Z', '2026-10-22T12:00:00Z', [10]));
    const links = Object.fromEntries(bookings.map((b) => [b.id, 1000 + b.id]));
    const t = setup({ bookings, links, records: [], baseline: true, refresh: true });
    expect((await t.svc.reconcile(portal, t.client, now)).deals).toEqual({ refreshed: DEAL_FIELDS_PER_PASS, pending: 5 });
    t.journal.recordImported.mockResolvedValue({ record: {}, created: false });
    expect((await t.svc.reconcile(portal, t.client, now)).deals).toEqual({ refreshed: 5, pending: 0 });
    expect(new Set(refreshed(t)).size).toBe(n);
  });
});

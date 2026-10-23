import { BookingJournalService, SYSTEM } from './booking-journal.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

function fakePrisma() {
  const rows: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  const find = (portalId: string, bookingId: number) =>
    rows.find((r) => r.portalId === portalId && r.bookingId === bookingId) ?? null;
  const prisma = {
    bookingRecord: {
      findUnique: vi.fn(async ({ where }: { where: { portalId_bookingId: { portalId: string; bookingId: number } } }) =>
        find(where.portalId_bookingId.portalId, where.portalId_bookingId.bookingId),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `r${rows.length + 1}`, status: 'active', ...data };
        rows.push(row);
        return row;
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { portalId: string; bookingId: number; status: string }; data: Record<string, unknown> }) => {
          const r = find(where.portalId, where.bookingId);
          if (!r || r.status !== where.status) return { count: 0 };
          Object.assign(r, data);
          return { count: 1 };
        },
      ),
    },
    bookingHistory: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => history.push(data)) },
  };
  return { prisma: prisma as unknown as PrismaService, rows, history };
}

const input = {
  bookingId: 55,
  kind: 'client' as const,
  dealId: 678,
  resourceIds: [10],
  startsAt: new Date('2020-05-01T10:00:00Z'),
  endsAt: new Date('2020-05-01T12:00:00Z'),
};
const manager = { kind: 'user' as const, userId: 7, name: 'Анна Менеджер' };

describe('BookingJournalService', () => {
  it('records creation once (repeat is a no-op) with history', async () => {
    const { prisma, rows, history } = fakePrisma();
    const s = new BookingJournalService(prisma);
    await s.recordCreated('p1', input, manager);
    await s.recordCreated('p1', input, manager);
    expect(rows).toHaveLength(1);
    expect(history).toEqual([
      expect.objectContaining({ action: 'created', actorKind: 'user', userId: 7, actorName: 'Анна Менеджер' }),
    ]);
    await s.recordCreated('p2', input, manager);
    expect(rows).toHaveLength(2);
  });

  it('cancels once with reason; repeat, unknown and other portal → null', async () => {
    const { prisma, rows, history } = fakePrisma();
    const s = new BookingJournalService(prisma);
    await s.recordCreated('p1', input, manager);
    expect(await s.recordCancelled('p1', 55, { reason: 'payment_timeout', actor: SYSTEM.paymentTimeout, via: 'worker' })).not.toBeNull();
    expect(rows[0]).toMatchObject({ status: 'cancelled', cancelReason: 'payment_timeout', cancelledByUserId: null });
    expect(await s.recordCancelled('p1', 55, { reason: 'manual', actor: manager })).toBeNull();
    expect(await s.recordCancelled('p2', 55, { reason: 'manual', actor: manager })).toBeNull();
    expect(await s.recordCancelled('p1', 56, { reason: 'manual', actor: manager })).toBeNull();
    expect(rows[0].cancelReason).toBe('payment_timeout');
    expect(history.filter((h) => (h as { action: string }).action === 'cancelled')).toEqual([
      expect.objectContaining({
        actorKind: 'system',
        userId: null,
        actorName: 'Система: автоматизация — удаление брони при неоплате',
        via: 'worker',
      }),
    ]);
  });
});

describe('BookingJournalService.forPeriod — новые и удалённые брони для дашборда', () => {
  const rec = (bookingId: number, resourceIds: number[], over: object = {}) => ({ bookingId, resourceIds, status: 'active', ...over });
  function setup() {
    const findMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
      if (args.where.createdAt) return [rec(1, [10]), rec(2, [99])];
      if (args.where.cancelledAt) return [rec(3, [10], { status: 'cancelled' }), rec(4, [99], { status: 'cancelled' })];
      return [rec(5, [10])]; // активная бронь приложения, пропавшая в Битрикс24
    });
    const prisma = {
      bookingRecord: { findMany },
      bookingAlert: { findMany: vi.fn(async () => [{ bookingId: 5 }]) },
    } as unknown as PrismaService;
    return { svc: new BookingJournalService(prisma), findMany };
  }
  const from = new Date('2026-10-20T21:00:00Z');
  const to = new Date('2026-10-21T21:00:00Z');

  it('только ресурсы групп; пропавшие в Битрикс24 брони приложения — среди удалённых, с отметкой', async () => {
    const { svc } = setup();
    const r = await svc.forPeriod('p1', from, to, { resourceIds: [10], userId: null });
    expect(r.created.map((x) => x.bookingId)).toEqual([1]);
    expect(r.removed.map((x) => x.bookingId)).toEqual([5, 3]);
    expect([...r.pending]).toEqual([5]);
  });

  it('«Мои» — создал или снял сотрудник; администратор (null) видит все ресурсы', async () => {
    const { svc, findMany } = setup();
    const r = await svc.forPeriod('p1', from, to, { resourceIds: null, userId: 7 });
    expect(r.created).toHaveLength(2);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ createdByUserId: 7 });
    expect(findMany.mock.calls[1][0].where).toMatchObject({ OR: [{ createdByUserId: 7 }, { cancelledByUserId: 7 }] });
  });
});

describe('BookingJournalService — bookings gone in Bitrix24', () => {
  it('a deal whose only booking vanished in Bitrix24 is not «booked», whatever the alert status', async () => {
    const alertWhere: unknown[] = [];
    const prisma = {
      bookingRecord: { findMany: vi.fn(async () => [{ dealId: 18784, bookingId: 5942 }, { dealId: 700, bookingId: 5950 }]) },
      paymentRequest: { findMany: vi.fn(async () => [{ dealId: 700 }]) },
      bookingAlert: {
        findMany: vi.fn(async ({ where }: { where: unknown }) => {
          alertWhere.push(where);
          return [{ bookingId: 5942 }];
        }),
      },
    } as unknown as PrismaService;
    const state = await new BookingJournalService(prisma).dealBookingState('p1', [18784, 700]);
    expect([...state]).toEqual([[700, 'paid']]);
    // Отметка «Решено» вручную признак не снимает: статус уведомления не фильтруется.
    expect(alertWhere[0]).not.toHaveProperty('status');
  });
});

describe('BookingJournalService — versions', () => {
  it('snapshots «after» from history, newest first, repeated states collapsed, paged by 3', async () => {
    const st = (h: number) => ({ startsAt: `2026-10-23T${String(h).padStart(2, '0')}:00:00.000Z`, endsAt: '2026-10-23T23:00:00.000Z', resourceIds: [14], dealId: 1 });
    const rows = [
      { id: 'h6', at: new Date('2026-10-23T12:00:00Z'), action: 'rolled_back', actorName: 'Анна', after: st(15) },
      { id: 'h5', at: new Date('2026-10-23T11:00:00Z'), action: 'discrepancy_found', actorName: 'Система', after: null },
      { id: 'h4', at: new Date('2026-10-23T10:00:00Z'), action: 'accepted_bitrix', actorName: 'Анна', after: st(17) },
      { id: 'h3', at: new Date('2026-10-23T09:00:00Z'), action: 'accepted_bitrix', actorName: 'Анна', after: st(17) },
      { id: 'h2', at: new Date('2026-10-23T08:00:00Z'), action: 'changed_in_bitrix', actorName: null, after: st(16) },
      { id: 'h1', at: new Date('2026-10-23T07:00:00Z'), action: 'created', actorName: 'Анна', after: st(15) },
    ];
    const prisma = { bookingHistory: { findMany: vi.fn(async () => rows) } } as unknown as PrismaService;
    const record = { id: 'r1', startsAt: new Date(st(15).startsAt), endsAt: new Date(st(15).endsAt), resourceIds: [14], dealId: 1 } as never;
    const svc = new BookingJournalService(prisma);
    const first = await svc.versions(record, 0, 3);
    expect(first.items.map((v) => [v.id, v.current])).toEqual([
      ['h6', true],
      ['h4', false],
      ['h2', false],
    ]);
    expect(first.hasMore).toBe(true);
    const next = await svc.versions(record, 3, 3);
    expect(next.items.map((v) => v.id)).toEqual(['h1']);
    expect(next.hasMore).toBe(false);
  });
});

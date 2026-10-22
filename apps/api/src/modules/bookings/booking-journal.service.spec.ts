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

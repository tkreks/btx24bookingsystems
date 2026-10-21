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

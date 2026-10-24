import { BookingJournalService, PERIOD_LIMIT } from './booking-journal.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

describe('global closing queue journal', () => {
  it.each(['p1', 'p2'])('scopes every page to tenant %s and respects resources beyond first page', async (portalId) => {
    const now = new Date('2026-10-24T10:00:00Z');
    const findMany = vi.fn().mockResolvedValueOnce(Array.from({ length: PERIOD_LIMIT }, (_, i) => ({ id: String(i), resourceIds: [20] }))).mockResolvedValueOnce([{ id: 'late', resourceIds: [10] }]);
    const svc = new BookingJournalService({ bookingRecord: { findMany } } as unknown as PrismaService);
    expect(await svc.endedForClosing(portalId, now, [10])).toEqual([{ id: 'late', resourceIds: [10] }]);
    for (const [args] of findMany.mock.calls) expect(args.where).toEqual({ portalId, status: 'active', endsAt: { lte: now }, dealId: { not: null } });
    expect(findMany.mock.calls[1][0]).toMatchObject({ cursor: { id: String(PERIOD_LIMIT - 1) }, skip: 1 });
  });
});

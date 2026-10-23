import type { PrismaService } from '../../prisma/prisma.service.js';
import type { BookingJournalService } from './booking-journal.service.js';
import type { DealFieldMapService } from './deal-field-map.service.js';
import { DealStatusService } from './deal-status.service.js';

const now = Date.parse('2026-10-23T12:00:00Z');
const rec = (bookingId: number, dealId: number, start: string, end: string, status = 'active') => ({ bookingId, dealId, status, startsAt: new Date(start), endsAt: new Date(end) });

describe('DealStatusService', () => {
  it('канбан + брони журнала; удалённая в Битрикс24 (ждёт решения) не в счёт; журнал не знает — поле сделки', async () => {
    const prisma = {
      bookingRecord: {
        findMany: vi.fn(async () => [
          rec(1, 10, '2026-10-24T10:00:00Z', '2026-10-24T12:00:00Z'), // впереди
          rec(2, 11, '2026-10-22T10:00:00Z', '2026-10-22T12:00:00Z'), // прошла
          rec(3, 12, '2026-10-25T10:00:00Z', '2026-10-25T12:00:00Z'), // удалена в Битрикс24
          rec(4, 13, '2026-10-25T10:00:00Z', '2026-10-25T12:00:00Z', 'cancelled'),
        ]),
      },
    } as unknown as PrismaService;
    const journal = { pendingRemoval: vi.fn(async () => new Set([3])) } as unknown as BookingJournalService;
    const fieldMap = { get: vi.fn(async () => ({ bookingEnd: 'UF_E' })) } as unknown as DealFieldMapService;
    const svc = new DealStatusService(prisma, journal, fieldMap);
    const r = await svc.fromRows(
      'p1',
      [
        { ID: '10', STAGE_SEMANTIC_ID: 'P' },
        { ID: '11', STAGE_SEMANTIC_ID: 'P' },
        { ID: '12', STAGE_SEMANTIC_ID: 'P' },
        { ID: '13', STAGE_SEMANTIC_ID: 'P', UF_E: '2026-12-01T10:00:00+03:00' },
        { ID: '14', STAGE_SEMANTIC_ID: 'P', UF_E: '2026-10-01T10:00:00+03:00' },
        { ID: '15', STAGE_SEMANTIC_ID: 'F' },
      ],
      now,
    );
    expect(Object.fromEntries([...r].map(([id, s]) => [id, `${s.status}${s.needsClose ? '!' : ''}`]))).toEqual({
      10: 'waiting',
      11: 'done!',
      12: 'in_work',
      13: 'in_work',
      14: 'done!',
      15: 'failed',
    });
    expect(await svc.selectFields('p1')).toEqual(['STAGE_SEMANTIC_ID', 'UF_E']);
  });
});

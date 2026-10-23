import type { PrismaService } from '../prisma/prisma.service.js';
import type { BookingSyncJob } from './booking-sync.job.js';
import type { DealPaymentsJob } from './deal-payments.job.js';
import { EventSyncJob } from './event-sync.job.js';

function setup(busy = false) {
  const events = [
    { id: 'e1', portalId: 'p1', event: 'ONBOOKINGADD' },
    { id: 'e2', portalId: 'p1', event: 'ONBOOKINGDELETE' },
    { id: 'e3', portalId: 'p1', event: 'ONCRMDEALUPDATE' },
  ];
  const updates: string[][] = [];
  const prisma = {
    bitrix24Event: {
      findMany: vi.fn(async () => events),
      updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => updates.push(where.id.in)),
    },
    portal: { findFirst: vi.fn(async () => ({ id: 'p1' })) },
  } as unknown as PrismaService;
  const bookings = { runPortal: vi.fn(async () => !busy) } as unknown as BookingSyncJob;
  const payments = { runPortal: vi.fn(async () => true) } as unknown as DealPaymentsJob;
  return { job: new EventSyncJob(prisma, bookings, payments), bookings, payments, updates };
}

describe('EventSyncJob', () => {
  it('пачка событий броней — одна сверка, событий сделок — один учёт оплат; события отмечаются обработанными', async () => {
    const t = setup();
    await t.job.tick();
    expect(t.bookings.runPortal).toHaveBeenCalledTimes(1);
    expect(t.payments.runPortal).toHaveBeenCalledTimes(1);
    expect(t.updates).toEqual([['e1', 'e2', 'e3']]);
  });

  it('идёт плановая сверка — события броней ждут следующего прохода', async () => {
    const t = setup(true);
    await t.job.tick();
    expect(t.updates).toEqual([['e3']]);
  });
});

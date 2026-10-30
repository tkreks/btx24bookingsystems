import { PaidAmountJob } from './paid-amount.job.js';

describe('PaidAmountJob — сделки с изменёнными счетами', () => {
  it('берёт сделки из ответа crm.item.list ({ items }) и из заявок приложения', async () => {
    const listAll = vi.fn(async (_m: string, _p: unknown, opts: { pick?: (r: unknown) => unknown[] } = {}) => {
      const result = { items: [{ id: 1, parentId2: 40012 }, { id: 2, parentId2: 40012 }, { id: 3, parentId2: null }] };
      return opts.pick ? opts.pick(result) : [];
    });
    const prisma = {
      portal: { findMany: vi.fn(async () => [{ id: 'p1' }]) },
      paymentRequest: { findMany: vi.fn(async () => [{ dealId: 678 }]) },
    };
    const recompute = vi.fn(async () => 0);
    const job = new PaidAmountJob(prisma as never, { clientFor: () => ({ listAll }) } as never, { recompute } as never);
    await job.tick();
    expect(recompute.mock.calls.map((c: unknown[]) => c[2] as number).sort((a, b) => a - b)).toEqual([678, 40012]);
  });
});
